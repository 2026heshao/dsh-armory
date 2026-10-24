/**
 * MCP OAuth 客户端 —— 让「需要 OAuth 的远程 MCP」在 DSH 里也能装上。
 *
 * 背景：`@deepseek-ai/dsh-mcp-client` 的 transport 只认 `requestInit.headers`，
 * 没有 authProvider，也不做交互式授权。所以 OAuth 必须由本插件在「安装前」跑完，
 * 把 `authorization: Bearer <token>` 静态写进 patch 的 headers 里，此后由 mcp-client
 * 原样带出去。token 到期由本模块刷新。
 *
 * 覆盖的规范：
 *   - RFC 9728  受保护资源元数据（`WWW-Authenticate: Bearer resource_metadata="…"`）
 *   - RFC 8414  授权服务器元数据（`/.well-known/oauth-authorization-server`）
 *   - RFC 7591  动态客户端注册（DCR）
 *   - RFC 7636  PKCE（S256）
 *   - RFC 8707  resource 参数
 *
 * 回调通道按服务器能力降级：
 *   1. `loopback`        —— 本地 127.0.0.1:<随机端口>/callback，自动收 code（主流实现）
 *   2. `manual-callback` —— DCR 只接受自定义 scheme（例如 workbuddy://…）时，让用户把
 *                           浏览器里那条打不开的回调地址整条粘回来
 *   3. 手动 token        —— 上面两条都不通时，让用户直接粘一个 Bearer token
 *
 * 本模块只做纯逻辑 + 网络 + 一个临时 http 监听，不接触 Electron/DOM。
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 插件版本：DCR 的 clientInfo 与 UA 共用一处，避免两边各自漂移。 */
const PLUGIN_VERSION = "2.3.1";
const USER_AGENT = `dsh-armory/${PLUGIN_VERSION} (+mcp-oauth)`;
const NET_TIMEOUT_MS = 15_000;
/** 授权流程整体存活时间：超过就判过期，避免会话表无限增长。 */
const FLOW_TIMEOUT_MS = 10 * 60_000;
/** 授权后回调等待时间（用户要开浏览器、登录、点同意）。 */
const CALLBACK_TIMEOUT_MS = 8 * 60_000;

/** sessionId -> session。进程内存储；DSH 重启后需重新授权（token 已落盘，不需要）。 */
const sessions = new Map();

// ── 小工具 ──────────────────────────────────────────────────────────────

function b64url(input) {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function str(value, fallback = "") {
  return typeof value === "string" && value ? value : fallback;
}

function trimText(text, max = 300) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function sha256hex(text) {
  return createHash("sha256").update(String(text)).digest("hex");
}

/** PKCE 授权码流程的 verifier/challenge（S256）。 */
export function createPkce() {
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

export function createState() {
  return b64url(randomBytes(18));
}

/**
 * 解析 `WWW-Authenticate` 头。
 * 只处理一层参数（够用）：`Bearer resource_metadata="…", scope="…"`。
 */
export function parseWwwAuthenticate(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const scheme = String(text.split(/\s+/)[0] || "").toLowerCase();
  const params = Object.create(null);
  const re = /([A-Za-z0-9_.-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g;
  let match;
  while ((match = re.exec(text))) {
    const key = match[1].toLowerCase();
    const value = match[2] !== undefined ? match[2].replace(/\\(.)/g, "$1") : match[3] || "";
    params[key] = value;
  }
  return { scheme, params };
}

async function fetchWithTimeout(url, init = {}) {
  return await fetch(url, { ...init, signal: AbortSignal.timeout(NET_TIMEOUT_MS) });
}

async function fetchJson(url, init = {}) {
  try {
    const response = await fetchWithTimeout(url, {
      ...init,
      headers: { accept: "application/json", "user-agent": USER_AGENT, ...(init.headers || {}) }
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, status: response.status, text, json: null };
    try {
      return { ok: true, status: response.status, text, json: JSON.parse(text) };
    } catch {
      return { ok: false, status: response.status, text, json: null };
    }
  } catch (error) {
    return { ok: false, status: 0, text: String(error?.message || error), json: null };
  }
}

// ── 探测 ────────────────────────────────────────────────────────────────

/**
 * 打一次 MCP initialize，拿回状态码与 `WWW-Authenticate`。
 * 只用于确认「这颗 server 是不是 401 且声明了 OAuth」，不做其它判断。
 */
export async function probeServer(serverUrl, headers = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "dsh-armory", version: PLUGIN_VERSION }
    }
  });
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers || {}).map(([key, value]) => [String(key).toLowerCase(), String(value)])
  );
  try {
    const response = await fetchWithTimeout(serverUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...normalizedHeaders,
        "user-agent": USER_AGENT
      },
      body
    });
    // 读掉 body，避免 socket 悬挂
    await response.text().catch(() => "");
    return {
      ok: true,
      status: response.status,
      wwwAuthenticate: response.headers.get("www-authenticate") || "",
      error: ""
    };
  } catch (error) {
    return { ok: false, status: 0, wwwAuthenticate: "", error: String(error?.message || error) };
  }
}

// ── 元数据发现 ──────────────────────────────────────────────────────────

/**
 * RFC 9728：找到受保护资源元数据。
 * 优先用 `WWW-Authenticate` 里声明的 `resource_metadata`，退回根路径 well-known
 * （很多实现只挂根路径，路径级 well-known 反而 404）。
 */
export async function resolveProtectedResource({ serverUrl, wwwAuthenticate = "" } = {}) {
  let origin = "";
  try {
    origin = new URL(serverUrl).origin;
  } catch {
    return { ok: false, error: `无法解析 server url：${serverUrl}` };
  }
  const challenge = parseWwwAuthenticate(wwwAuthenticate);
  const hinted = str(challenge?.params?.resource_metadata);
  const candidates = [];
  if (hinted) candidates.push(hinted);
  candidates.push(new URL("/.well-known/oauth-protected-resource", origin).href);
  const tried = [];
  for (const candidate of candidates) {
    if (tried.includes(candidate)) continue;
    tried.push(candidate);
    const result = await fetchJson(candidate);
    const servers = Array.isArray(result.json?.authorization_servers)
      ? result.json.authorization_servers.map((item) => String(item)).filter(Boolean)
      : [];
    if (result.ok && servers.length) {
      return {
        ok: true,
        resource: str(result.json?.resource, serverUrl),
        authorizationServers: servers,
        metadataUrl: candidate,
        source: candidate === hinted ? "challenge" : "well-known",
        error: ""
      };
    }
  }
  // 没有元数据也别放弃：按同源授权服务器兜底再试一次。
  return {
    ok: true,
    resource: serverUrl,
    authorizationServers: [origin],
    metadataUrl: "",
    source: "fallback",
    error: ""
  };
}

/**
 * RFC 8414：拿授权服务器元数据。两个 well-known 都试（OIDC 兼容实现只挂后者）。
 */
export async function resolveAuthorizationServer(authorizationServerUrl) {
  const base = String(authorizationServerUrl || "").replace(/\/+$/, "");
  if (!base) return { ok: false, error: "缺少授权服务器地址" };
  const candidates = [
    `${base}/.well-known/oauth-authorization-server`,
    `${base}/.well-known/openid-configuration`
  ];
  const tried = [];
  for (const candidate of candidates) {
    tried.push(candidate);
    const result = await fetchJson(candidate);
    const meta = result.json;
    if (result.ok && meta?.authorization_endpoint && meta?.token_endpoint) {
      return {
        ok: true,
        issuer: str(meta.issuer, base),
        authorizationEndpoint: String(meta.authorization_endpoint),
        tokenEndpoint: String(meta.token_endpoint),
        registrationEndpoint: str(meta.registration_endpoint),
        scopesSupported: Array.isArray(meta.scopes_supported) ? meta.scopes_supported.map(String) : [],
        tokenEndpointAuthMethods: Array.isArray(meta.token_endpoint_auth_methods_supported)
          ? meta.token_endpoint_auth_methods_supported.map(String)
          : ["none"],
        metadataUrl: candidate,
        error: ""
      };
    }
  }
  return { ok: false, error: `未能从 ${base} 取得 authorization_endpoint / token_endpoint（试过 ${tried.join("、")}）` };
}

// ── 动态客户端注册（RFC 7591） ───────────────────────────────────────────

/**
 * @returns {{ok:boolean, clientId:string, error:string}}
 *   失败时 error 里可能带服务器期望的 redirect_uri（例如只认某个自定义 scheme）。
 */
export async function registerClient(as, { redirectUri, clientName, scope } = {}) {
  if (!as?.registrationEndpoint) {
    return { ok: false, clientId: "", error: "授权服务器未提供 registration_endpoint（不支持动态注册）" };
  }
  const payload = {
    redirect_uris: [redirectUri],
    client_name: String(clientName || "DeepSeek Harness"),
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"]
  };
  if (scope) payload.scope = scope;
  const result = await fetchJson(as.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!result.ok) {
    return {
      ok: false,
      clientId: "",
      error: `动态注册失败（HTTP ${result.status || "网络错误"}）：${readableRegistrationError(result.text)}`,
      raw: result.text
    };
  }
  const clientId = str(result.json?.client_id);
  if (!clientId) return { ok: false, clientId: "", error: `动态注册响应缺少 client_id：${trimText(result.text)}`, raw: result.text };
  return { ok: true, clientId, error: "" };
}

/**
 * 有些服务器把错误体里的 `<` `>` 写成 JSON 转义 `\u003c` `\u003e`
 * （Python 的 json.dumps 默认就会这样），必须先还原成字面字符，
 * 否则 `<name>` 占位符识别不出来。
 */
export function unescapeUnicodeEscapes(text) {
  return String(text || "").replace(/\\u([0-9a-fA-F]{4})/g, (_all, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** 从 DCR 报错里抠出服务器期望的 redirect_uri（自定义 scheme 场景）。 */
export function extractExpectedRedirectUri(errorText) {
  const text = unescapeUnicodeEscapes(errorText);
  // 服务器常把地址写成模板：`workbuddy://workbuddy/mcp/connector:<name>/oauth/callback`，
  // 所以 `<` `>` 也要视作地址的一部分，否则会被截断成半截 URL。
  const match = text.match(/\b([a-z][a-z0-9+.-]*:\/\/[^\s"'`)<>]*(?:<[^>\s]+>[^\s"'`)<>]*)*)/i);
  if (!match) return "";
  const candidate = match[1].replace(/[.,;)]+$/, "");
  // 只认「带路径的绝对 URI」，避免把 https:// 的文档链接当回调地址。
  return /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/.+/i.test(candidate) ? candidate : "";
}

/** 把回调地址模板里的占位符换成真实客户端名（`<name>` / `{name}` / `${name}`）。 */
export function substituteRedirectPlaceholder(redirectUri, name) {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "dsh-armory";
  return unescapeUnicodeEscapes(redirectUri).replace(/<([^>\s]*)>|\$\{([^}]*)\}|\{([^}]*)\}/g, (_all, angle, dollar, brace) => {
    const key = String(angle ?? dollar ?? brace ?? "").toLowerCase();
    return /name|client|connector|app|id/.test(key) ? slug : _all;
  });
}

/** 把 DCR 的原始错误体变成一句人话（服务器常回一大坨 JSON）。 */
export function readableRegistrationError(text) {
  const raw = String(text || "").trim();
  if (!raw) return "（空响应）";
  try {
    const parsed = JSON.parse(raw);
    const description =
      str(parsed?.error?.error_description) ||
      str(parsed?.error_description) ||
      str(parsed?.error?.error) ||
      str(parsed?.error) ||
      "";
    if (description) {
      const code = str(parsed?.error?.error);
      return code && code !== description ? `${code}: ${description}` : description;
    }
  } catch {
    /* 不是 JSON，按原文截断 */
  }
  return trimText(raw);
}

// ── 本地回调监听 ────────────────────────────────────────────────────────

/**
 * 起一个只收一次 code 的临时 http 服务，绑 127.0.0.1 随机端口。
 * @returns {Promise<{redirectUri:string, wait:Promise<object>, close:Function}>}
 */
export async function startLoopback({ timeoutMs = CALLBACK_TIMEOUT_MS } = {}) {
  let settle = () => {};
  let settled = false;
  const wait = new Promise((resolve) => {
    settle = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
  });
  const server = createServer((request, response) => {
    let parsed;
    try {
      parsed = new URL(String(request.url || "/"), "http://127.0.0.1");
    } catch {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("bad request");
      return;
    }
    if (parsed.pathname !== "/callback") {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found");
      return;
    }
    const code = parsed.searchParams.get("code") || "";
    const state = parsed.searchParams.get("state") || "";
    const error = parsed.searchParams.get("error") || "";
    const errorDescription = parsed.searchParams.get("error_description") || "";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", connection: "close" });
    response.end(renderCallbackPage(error ? "授权未完成" : "授权完成", error ? errorDescription || error : "可以关闭这个页面，回到 DeepSeek Harness 继续。"));
    settle({ code, state, error, errorDescription });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const timer = setTimeout(() => settle({ code: "", state: "", error: "timeout", errorDescription: "等待授权回调超时" }), Math.max(1_000, timeoutMs));
  timer.unref?.();
  const close = () => {
    clearTimeout(timer);
    try {
      server.close();
    } catch {
      /* 已经关了 */
    }
  };
  return { redirectUri: `http://127.0.0.1:${port}/callback`, wait, close };
}

function renderCallbackPage(title, detail) {
  const escape = (text) => String(text).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${escape(title)}</title></head>
<body style="font:15px/1.7 system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#0f1115;color:#e6e8ee">
<div style="max-width:34rem;padding:2.5rem 2rem;border:1px solid #262b36;border-radius:16px;background:#151922">
<h1 style="margin:0 0 .75rem;font-size:1.25rem">${escape(title)}</h1>
<p style="margin:0;color:#9aa4b8">${escape(detail)}</p></div></body></html>`;
}

// ── token 落盘 ──────────────────────────────────────────────────────────

/** 存储目录：优先 DSH_HOME，其次 ~/.dsh（与其它 armory 状态同源）。 */
export function storeDirectory() {
  const home = str(process.env.DSH_HOME) || join(homedir(), ".dsh");
  return join(home, "armory-oauth");
}

function recordPathFor(serverUrl) {
  return join(storeDirectory(), `${sha256hex(serverUrl).slice(0, 32)}.json`);
}

/** 读一条已存的授权记录；没有或损坏返回 null。 */
export async function readTokenRecord(serverUrl) {
  try {
    const text = await readFile(recordPathFor(serverUrl), "utf8");
    const record = JSON.parse(text);
    if (!record || typeof record !== "object") return null;
    if (str(record.serverUrl) !== String(serverUrl)) return null;
    return record;
  } catch {
    return null;
  }
}

export async function writeTokenRecord(serverUrl, patch) {
  const path = recordPathFor(serverUrl);
  const previous = (await readTokenRecord(serverUrl)) || {};
  const record = { ...previous, ...patch, serverUrl: String(serverUrl), savedAt: new Date().toISOString() };
  await mkdir(storeDirectory(), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return record;
}

export async function clearTokenRecord(serverUrl) {
  try {
    await unlink(recordPathFor(serverUrl));
    return true;
  } catch {
    return false;
  }
}

/** 记录里是否有一个「还没过期」的 access token（留 60s 余量）。 */
export function tokenIsFresh(record) {
  if (!record || !str(record.accessToken)) return false;
  if (!record.expiresAt) return true; // 服务器没给 expires_in：视为长期有效，等 401 再说
  // 落盘时写的是 ISO 串（见 exchangeCode），但令牌库是纯 JSON、可能被人手改或由
  // 旧版本写成数字毫秒，两种都认：数字直接当时间戳，字符串才走 Date.parse。
  const expiresAt = typeof record.expiresAt === "number"
    ? record.expiresAt
    : Date.parse(String(record.expiresAt));
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt - 60_000 > Date.now();
}

/**
 * 拿一个可用 token：本地还有效就直接用，过期但有 refresh_token 就刷。
 * @returns {Promise<{ok:boolean, accessToken:string, refreshed:boolean, error:string}>}
 */
export async function ensureAccessToken(serverUrl, { force = false } = {}) {
  const record = await readTokenRecord(serverUrl);
  if (!record) return { ok: false, accessToken: "", refreshed: false, error: "没有已保存的授权" };
  if (!force && tokenIsFresh(record)) return { ok: true, accessToken: record.accessToken, refreshed: false, error: "" };
  if (!str(record.refreshToken) || !str(record.tokenEndpoint)) {
    return { ok: false, accessToken: "", refreshed: false, error: "授权已过期，且服务器未提供 refresh_token，需要重新授权" };
  }
  const refreshed = await refreshAccessToken(record);
  if (!refreshed.ok) return { ok: false, accessToken: "", refreshed: false, error: refreshed.error };
  return { ok: true, accessToken: refreshed.accessToken, refreshed: true, error: "" };
}

async function refreshAccessToken(record) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: String(record.refreshToken),
    client_id: String(record.clientId || "")
  });
  if (str(record.resource)) body.set("resource", String(record.resource));
  const result = await fetchJson(String(record.tokenEndpoint), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!result.ok || !str(result.json?.access_token)) {
    return { ok: false, accessToken: "", error: `刷新 token 失败（HTTP ${result.status || "网络错误"}）：${trimText(result.text)}` };
  }
  await writeTokenRecord(record.serverUrl, tokenRecordPatch(result.json));
  return { ok: true, accessToken: String(result.json.access_token), error: "" };
}

function tokenRecordPatch(tokenResponse) {
  const expiresIn = Number(tokenResponse?.expires_in);
  return {
    accessToken: String(tokenResponse?.access_token || ""),
    tokenType: str(tokenResponse?.token_type, "Bearer"),
    refreshToken: str(tokenResponse?.refresh_token),
    scope: str(tokenResponse?.scope),
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : ""
  };
}

// ── 完整授权流程 ────────────────────────────────────────────────────────

/**
 * 走完「发现 → 注册 → 授权页」并把 authorizeUrl 交给调用方去开浏览器。
 *
 * @param {object} options
 * @param {string} options.serverName  MCP server 名（仅用于提示文案）
 * @param {string} options.serverUrl   MCP endpoint（streamable-http url）
 * @param {object} [options.headers]   mcp.json 里已有的静态头（探活时带上）
 * @param {string} [options.clientName]
 * @returns {Promise<{ok:boolean, sessionId:string, authorizeUrl:string, mode:string,
 *   redirectUri:string, hint:string, error:string}>}
 */
export async function beginAuthorization({ serverName, serverUrl, headers = {}, clientName = "DeepSeek Harness" } = {}) {
  if (!serverUrl) return fail("", "", "", "缺少 server url");
  const probe = await probeServer(serverUrl, headers);
  if (!probe.ok) return fail("", "", "", `无法连接 ${serverUrl}：${probe.error}`);
  if (probe.status !== 401 && probe.status !== 403) {
    // 有些服务器首次 initialize 回 200，鉴权在 tools/call 才触发；这里仍允许继续试一次。
    if (probe.status >= 400 && probe.status !== 401 && probe.status !== 403) {
      return fail("", "", "", `服务器返回 HTTP ${probe.status}，不是预期的 401/403，无法确认其 OAuth 要求`);
    }
  }

  const resource = await resolveProtectedResource({ serverUrl, wwwAuthenticate: probe.wwwAuthenticate });
  if (!resource.ok) return fail("", "", "", resource.error);
  const as = await resolveAuthorizationServer(resource.authorizationServers[0]);
  if (!as.ok) return fail("", "", "", as.error);
  if (!as.tokenEndpointAuthMethods.includes("none")) {
    return fail("", "", "", `该授权服务器要求客户端认证（${as.tokenEndpointAuthMethods.join("/")}），本插件只支持公共客户端（none）`);
  }

  const scope = as.scopesSupported.length ? as.scopesSupported.join(" ") : "";
  const pkce = createPkce();
  const state = createState();

  // 1) 先按 loopback 注册；2) 被拒且报错里点名了自定义 scheme，就用它再注册一次。
  const loopback = await startLoopback();
  let redirectUri = loopback.redirectUri;
  let mode = "loopback";
  let registration = await registerClient(as, { redirectUri, clientName, scope });
  if (!registration.ok) {
    // 有些服务器（例如只认 workbuddy:// 的那类）拒绝 loopback，并在报错里点名只接受
    // 某个自定义 scheme 的回调地址——有时还是个带 <name> 占位符的模板。
    const template = extractExpectedRedirectUri(registration.raw || registration.error);
    if (!template) {
      loopback.close();
      return fail("", "", "", registration.error);
    }
    const expected = substituteRedirectPlaceholder(template, serverName || clientName);
    const retry = await registerClient(as, { redirectUri: expected, clientName, scope });
    if (!retry.ok) {
      loopback.close();
      return fail("", "", "", `${registration.error}\n改用服务器指定的回调地址 ${expected} 重试仍失败：${retry.error}`);
    }
    registration = retry;
    redirectUri = expected;
    mode = "manual-callback";
    loopback.close();
  }

  const authorizeUrl = buildAuthorizeUrl({
    authorizationEndpoint: as.authorizationEndpoint,
    clientId: registration.clientId,
    redirectUri,
    scope,
    state,
    codeChallenge: pkce.challenge,
    resource: resource.resource
  });

  const sessionId = b64url(randomBytes(12));
  const session = {
    id: sessionId,
    serverName: str(serverName),
    serverUrl,
    resource,
    as,
    clientId: registration.clientId,
    pkce,
    state,
    redirectUri,
    mode,
    loopback: mode === "loopback" ? loopback : null,
    status: "pending",
    error: "",
    token: null,
    createdAt: Date.now()
  };
  sessions.set(sessionId, session);
  pruneSessions();

  if (session.loopback) {
    // 后台等回调，谁先到都行：http 回调 or 超时。
    session.loopback.wait.then((result) => finishSession(session, result)).catch(() => {});
  }

  return {
    ok: true,
    sessionId,
    authorizeUrl,
    mode,
    redirectUri,
    hint: mode === "loopback"
      ? "已在浏览器打开授权页；登录并同意后会自动完成，无需手动操作。"
      : `该服务器只接受自定义回调地址（${redirectUri}）。授权后浏览器会跳到一条打不开的地址，把地址栏里那条完整 URL 复制回来粘贴即可。`,
    error: ""
  };
}

function buildAuthorizeUrl({ authorizationEndpoint, clientId, redirectUri, scope, state, codeChallenge, resource }) {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  if (scope) url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (resource) url.searchParams.set("resource", resource);
  return url.href;
}

function fail(sessionId, authorizeUrl, mode, error) {
  return { ok: false, sessionId, authorizeUrl, mode, redirectUri: "", hint: "", error };
}

function pruneSessions() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > FLOW_TIMEOUT_MS) {
      session.loopback?.close?.();
      sessions.delete(id);
    }
  }
}

async function finishSession(session, result) {
  if (session.status !== "pending") return;
  if (result?.error || !result?.code) {
    session.status = "failed";
    session.error = result?.error === "timeout"
      ? "等待授权回调超时（10 分钟内没有收到）"
      : String(result?.errorDescription || result?.error || "未收到授权码");
    session.loopback?.close?.();
    return;
  }
  if (session.state && result.state && result.state !== session.state) {
    session.status = "failed";
    session.error = "回调 state 校验失败（可能是过期或伪造的回调）";
    session.loopback?.close?.();
    return;
  }
  await exchangeCode(session, result.code);
  session.loopback?.close?.();
}

async function exchangeCode(session, code) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: String(code),
    redirect_uri: session.redirectUri,
    client_id: session.clientId,
    code_verifier: session.pkce.verifier
  });
  if (str(session.resource?.resource)) body.set("resource", String(session.resource.resource));
  const result = await fetchJson(session.as.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
  if (!result.ok || !str(result.json?.access_token)) {
    session.status = "failed";
    session.error = `换取 token 失败（HTTP ${result.status || "网络错误"}）：${trimText(result.text)}`;
    return;
  }
  const patch = tokenRecordPatch(result.json);
  const record = await writeTokenRecord(session.serverUrl, {
    ...patch,
    clientId: session.clientId,
    tokenEndpoint: session.as.tokenEndpoint,
    resource: str(session.resource?.resource),
    redirectUri: session.redirectUri
  });
  session.status = "authorized";
  session.error = "";
  session.token = {
    accessToken: record.accessToken,
    expiresAt: record.expiresAt,
    scope: record.scope
  };
}

/**
 * 查询授权进度。`pending` / `authorized` / `failed`。
 * authorized 时带上 token 概要（不返回完整 token，避免在面板日志里裸露）。
 */
export function authorizationStatus(sessionId) {
  const session = sessions.get(String(sessionId || ""));
  if (!session) return { ok: false, status: "unknown", error: "授权会话不存在或已过期，请重新发起", token: null };
  return {
    ok: true,
    status: session.status,
    error: session.error,
    mode: session.mode,
    redirectUri: session.redirectUri,
    serverName: session.serverName,
    token: session.token
      ? { expiresAt: session.token.expiresAt, scope: session.token.scope, tokenLength: session.token.accessToken.length }
      : null
  };
}

/**
 * 手动回调模式：用户把浏览器地址栏那条 URL 粘回来。
 * 也接受「只粘 code 本身」这种偷懒输入。
 */
export async function submitCallback(sessionId, callbackUrl) {
  const session = sessions.get(String(sessionId || ""));
  if (!session) return { ok: false, status: "unknown", error: "授权会话不存在或已过期，请重新发起" };
  if (session.status === "authorized") return { ok: true, status: "authorized", error: "" };
  if (session.status === "failed") return { ok: false, status: "failed", error: session.error };
  const raw = String(callbackUrl || "").trim();
  if (!raw) return { ok: false, status: "pending", error: "请粘贴回调地址" };

  let code = "";
  let state = "";
  let error = "";
  let errorDescription = "";
  const looksLikeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.startsWith("/");
  if (looksLikeUrl) {
    try {
      const parsed = new URL(raw, session.redirectUri);
      code = parsed.searchParams.get("code") || "";
      state = parsed.searchParams.get("state") || "";
      error = parsed.searchParams.get("error") || "";
      errorDescription = parsed.searchParams.get("error_description") || "";
    } catch {
      return { ok: false, status: "pending", error: "这条地址无法解析，请确认复制完整" };
    }
  } else if (/^[A-Za-z0-9._~-]{8,}$/.test(raw)) {
    code = raw;
  } else {
    return { ok: false, status: "pending", error: "既不是回调地址也不像授权码，请重新复制" };
  }

  if (error) {
    session.status = "failed";
    session.error = `授权服务器返回错误：${errorDescription || error}`;
    return { ok: false, status: "failed", error: session.error };
  }
  if (!code) return { ok: false, status: "pending", error: "这条地址里没有 code 参数" };
  if (session.state && state && state !== session.state) {
    return { ok: false, status: "pending", error: "state 不匹配，请确认粘贴的是本次授权产生的回调地址" };
  }
  session.loopback?.close?.();
  await exchangeCode(session, code);
  return { ok: session.status === "authorized", status: session.status, error: session.error };
}

export function cancelAuthorization(sessionId) {
  const session = sessions.get(String(sessionId || ""));
  if (!session) return { ok: true };
  session.loopback?.close?.();
  if (session.status === "pending") {
    session.status = "failed";
    session.error = "已取消";
  }
  sessions.delete(String(sessionId));
  return { ok: true };
}

/**
 * 手动写入 Bearer token（第三条兜底路）。token 可以带也可以不带 "Bearer " 前缀。
 */
export async function saveManualToken({ serverUrl, serverName = "", token, tokenEndpoint = "" } = {}) {
  const raw = String(token || "").trim();
  if (!serverUrl) return { ok: false, error: "缺少 server url" };
  if (!raw) return { ok: false, error: "token 不能为空" };
  const accessToken = raw.replace(/^Bearer\s+/i, "").trim();
  if (!accessToken) return { ok: false, error: "token 不能为空" };
  await writeTokenRecord(serverUrl, {
    accessToken,
    tokenType: "Bearer",
    refreshToken: "",
    scope: "",
    expiresAt: "",
    tokenEndpoint: str(tokenEndpoint),
    serverName: str(serverName)
  });
  return { ok: true, error: "" };
}

/** 面板用：读回某 server 的授权概况（不含 token 本体）。 */
export async function authorizationOverview(serverUrl) {
  const record = await readTokenRecord(serverUrl);
  if (!record) return { authorized: false, expiresAt: "", scope: "", refreshable: false, savedAt: "" };
  return {
    authorized: Boolean(str(record.accessToken)),
    fresh: tokenIsFresh(record),
    expiresAt: str(record.expiresAt),
    scope: str(record.scope),
    refreshable: Boolean(str(record.refreshToken)),
    savedAt: str(record.savedAt)
  };
}