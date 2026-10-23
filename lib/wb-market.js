// WorkBuddy 市场直连 —— 连接器（MCP）与技能（SkillHub）两个市场的数据源与安装器。
//
// 数据源（2026-10-11 全部一手实测，均免登录）：
//   1. 连接器：https://static.workbuddy.cn/connectors-config-v2/connectors-config.zip
//      这是 WorkBuddy 桌面端连接器市场自己的分发地址（本机 WorkBuddy 的
//      connectors-marketplace/.meta.json 记录的就是它），ZIP 里 .codebuddy-connector/connectors.json
//      是索引（316 条），connectors/<id>/mcp.json 是每条的 MCP 配置，connectors/<id>/skills/**/SKILL.md
//      是该连接器附带的技能。ETag 变了才重新下载，ZIP 缓存在 ~/.dsh/wb-market/。
//   2. 技能：https://api.skillhub.cn —— SkillHub 的公开 JSON API（列表 /api/skills、
//      详情 /api/v1/skills/:slug、文件清单 /files、单文件 /file）。WorkBuddy 技能市场里
//      marketplaceSource 标 marketplace/skillhub 的技能都来自这里。
//
// 设计约束：
//   - 网络只发生在 Host 侧（浏览器不直连腾讯/SkillHub 域名）：面板经由 mcpManager Remote
//     命名空间调用本文件提供的方法，与既有预览/导入同一信封。
//   - 「能装」的标准从严：MCP 只收 streamable-http 与无 preAuth 的 stdio；CLI 型（cli.json）
//     与 server-side 鉴权只展示不装——宁可少，不可错（与 mcp-catalog.js 同一纪律）。
//   - 技能安装逐文件校验 sha256（清单自带哈希）后再落盘，目标目录按 SkillHub 的
//     canonicalName 命名（`@tencent-adm/tencent-docs` → `tencent-adm__tencent-docs`），
//     与 dsh-skill-market 的命名并存不冲突（本插件不带 @ 前缀保留字）。
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ZipReader } from "./wb-zip.js";
// T02/R1：auth_injection_rules 只解析、只展示（X9 边界）——DSH 不做任何代注入，
// 这里只借用 T01 纯函数库的解析与按连接器命中能力。
import { parseInjectionRules, rulesFor, scanTokenSlots } from "./wb-auth-rules.js";
// T03/R4：连接器源不再硬编码单 URL——从多市场注册表取 sourceFor("connectors")，
// 读不到/损坏时回落内置默认（wb-registry.builtinMarketplaces 保证）。
import { sourceFor } from "./wb-registry.js";

const CONNECTOR_ZIP_URL = "https://static.workbuddy.cn/connectors-config-v2/connectors-config.zip";

/** R4：连接器市场源 URL。注册表第一条 connectors 源优先，缺失/读失败回落内置默认。 */
export async function connectorSourceUrl(options = {}) {
  const row = await sourceFor("connectors", options);
  const url = row && row.source && typeof row.source.url === "string" ? row.source.url : "";
  return url || CONNECTOR_ZIP_URL;
}
const SKILLHUB_ORIGIN = "https://api.skillhub.cn";
const USER_AGENT = "@2026heshao/dsh-armory (+https://github.com/2026heshao/dsh-armory)";
// 单文件/单响应上限：connectors.json ≈ 550KB、SKILL.md 最大几十 KB，8MB 已是十倍冗余。
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// ZIP 落盘缓存目录（~/.dsh 由 DSH 自己管理，这里只在它下面开一个子目录）。
function cacheDir() {
  return join(homedir(), ".dsh", "wb-market");
}
function zipPath() {
  return join(cacheDir(), "connectors-config.zip");
}
function metaPath() {
  return join(cacheDir(), "meta.json");
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Host 侧统一的 fetch + 上限 + UA。skillhub 对无 UA 的请求会 400。 */
async function fetchWithLimits(url, { timeoutMs = 30_000 } = {}) {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json, application/zip, */*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}（${url}）`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_RESPONSE_BYTES) throw new Error(`响应超过上限 ${Math.round(MAX_RESPONSE_BYTES / 1024 / 1024)}MB（${url}）`);
  return buffer;
}

// ── 连接器 ZIP：下载 + 缓存 ─────────────────────────────────────────────
// meta.json 记录远端 ETag；命中就不重复下 24MB。ZIP 本体损坏时丢弃缓存重新拉一次。
let cachedZip = null; // { zip: ZipReader, loadedFrom: "memory"|"disk"|"network" }
async function loadConnectorZip() {
  if (cachedZip) return cachedZip;
  await mkdir(cacheDir(), { recursive: true });
  const meta = (await readJson(metaPath())) || {};
  // R4：注册表取源（缺失回落内置默认），ZIP 路径/缓存键不变——
  // 注册表只是改了「从哪下」，没有改「下到哪」。
  const sourceUrl = await connectorSourceUrl();
  const download = async (etag) => {
    const response = await fetch(sourceUrl, {
      headers: { "user-agent": USER_AGENT, ...(etag ? { "if-none-match": etag } : {}) },
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status === 304 && etag) return null;
    if (!response.ok) throw new Error(`连接器市场下载失败：HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 64 * 1024 * 1024) throw new Error("连接器市场包超过 64MB 上限，疑似异常响应");
    return { buffer, etag: response.headers.get("etag") || "" };
  };
  let zip = null;
  if (meta.etag) {
    // 有缓存：先验证磁盘上的 ZIP 还能用，能用就 304 探测上游；网络挂了就继续用旧缓存。
    try {
      const local = await readFile(zipPath());
      zip = new ZipReader(local);
      const fresh = await download(meta.etag);
      if (fresh === null) {
        cachedZip = { zip, loadedFrom: "disk" };
        return cachedZip;
      }
      zip = new ZipReader(fresh.buffer);
      await writeFile(zipPath(), fresh.buffer);
      await writeFile(metaPath(), JSON.stringify({ etag: fresh.etag, fetchedAt: Date.now() }));
      cachedZip = { zip, loadedFrom: "network" };
      return cachedZip;
    } catch {
      zip = null;
    }
  }
  const fresh = await download(meta.etag || "");
  zip = new ZipReader(fresh.buffer);
  await writeFile(zipPath(), fresh.buffer);
  await writeFile(metaPath(), JSON.stringify({ etag: fresh.etag, fetchedAt: Date.now() }));
  cachedZip = { zip, loadedFrom: "network" };
  return cachedZip;
}

// ── 连接器目录投影 ─────────────────────────────────────────────────────
// connectors.json 一条 → 面板卡片一条。installable 判定从严：
//   - 没有 mcp.json → 不可装（cli.json 型 / 纯技能包）
//   - mcp.json 带 preAuth（cli 鉴权、OAuth 注入）→ 不可装
//   - stdio 且 command 引用 WorkBuddy 专属连接器目录 → 不可装（那份 client.cjs 只有 WorkBuddy 有）
//   - env/header 引用 WorkBuddy 专有 token 注入 → 不可装
function isWorkbuddyOnlyCommand(command) {
  return typeof command === "string" && (command.includes("connectors-marketplace") || command.includes(".workbuddy"));
}

// ── T02 投影函数（R1/R2/R3）───────────────────────────────────────────
// 三个都是纯函数：输入 connectors.json 的原始形状，输出面板行需要的展示字段。
// 放在这里而不是 client.js，是因为它们处理的是「远端数据的形状防御」，与
// serverInstallability 同层；UI 只消费结果，不重复判形状。

/** R1：某条连接器的 token 注入规则标注。只数条数、不给注入物（X9：只展示不注入）。 */
export function injectionRuleNote(indexJson, connectorId) {
  const rules = rulesFor(parseInjectionRules(indexJson), connectorId);
  if (!rules.length) return { count: 0, note: "" };
  return {
    count: rules.length,
    note: `存在 ${rules.length} 条 token 注入规则（依赖 WB 账号体系，DSH 不代注入）`,
  };
}

/**
 * R2：visible_in 透传 + 标签筛选。实测为 key 数组（如 ["workbuddy","cline"]）；
 * 畸形（缺失/非数组/元素非字符串）一律归一成 []，调用方不需要再判形状。
 * 空数组 ≠ 「不可见」：上游没标就当作全部可见，筛选函数里不拦截。
 */
export function visibleInOf(entry) {
  const raw = entry?.visible_in;
  if (!Array.isArray(raw)) return [];
  return raw.map((tag) => (typeof tag === "string" ? tag.trim() : "")).filter(Boolean);
}

/** R2：本地筛选。visibleTags 为空（上游未标）= 不受该维度过滤；非空才要求包含。 */
export function matchesVisibleIn(rowVisibleTags, selectedTags) {
  if (!Array.isArray(selectedTags) || !selectedTags.length) return true;
  if (!Array.isArray(rowVisibleTags) || !rowVisibleTags.length) return true;
  const owned = new Set(rowVisibleTags.map((tag) => String(tag).toLowerCase()));
  return selectedTags.every((tag) => owned.has(String(tag).toLowerCase()));
}

/**
 * R3：examples 优先的展示文案。规则（设计文档 R3）：
 *   有 examples 且非空 → 正文用 examples（按语言 zh/en 选取）；
 *   否则回落 description；两者都无 → 空串（UI 自行回落到 name）。
 * 入参都是 connectors.json 条目的原样字段，畸形一律防御性回落。
 */
export function displayCopyOf(entry) {
  const pick = (list) => (Array.isArray(list) ? list.filter((item) => typeof item === "string" && item.trim()).filter(Boolean) : []);
  const zhExamples = pick(entry?.examples_zh);
  const enExamples = pick(entry?.examples_en);
  const examples = zhExamples.length ? zhExamples : enExamples;
  if (examples.length) {
    return { body: examples.join("\n"), from: "examples", examples };
  }
  const zh = typeof entry?.description_zh === "string" ? entry.description_zh : "";
  const fallbackZh = typeof entry?.description === "string" ? entry.description : "";
  const en = typeof entry?.description_en === "string" ? entry.description_en : "";
  const body = zh || fallbackZh || en;
  return { body, from: body ? "description" : "", examples: [] };
}

export function serverInstallability(serverName, rawServer, authMode = "") {
  const reasons = [];
  // R8：oauth / oneid-token 类不再拒装，而是标记「需走浏览器授权」，
  // 由 lib/mcp-oauth.js 在安装时驱动 RFC 9728/8414/7591/7636 全链路。
  let needsOAuth = false;
  const nested = rawServer && typeof rawServer.transport === "object" ? rawServer.transport : rawServer;
  // mcp.json 里的 stdio 条目本来就只有 command、不写 type（官方示例与各家 README 皆如此）。
  // 早前这里只认 nested.type：command 型条目 transport 落成空串，被文件末尾的
  // 「未知传输类型」判为拒装——凡是标准 stdio 连接器都装不上。缺 type 但有 command
  // 时按 stdio 处理，与下面返回处的 `transport || "stdio"` 兜底保持同一判断。
  const declaredType = String(nested?.type ?? "").toLowerCase();
  const transport = declaredType || (typeof nested?.command === "string" && nested.command.trim() ? "stdio" : "");
  // R7：先扫占位符槽位（env/headers 里的 ${...}）。这一扫描必须发生在 transport 的
  // 提前 return 之前——否则 streamable-http 型连接器的 header 占位符会被整段跳过，
  // 而 80+ 条 auth_mode=token 的连接器正是这个传输形态，正是「装不了」的成因之一。
  const tokenSlots = scanTokenSlots({ [serverName]: rawServer });
  const hasReplaceableSlots = tokenSlots.length > 0;
  // 索引 auth_mode 是比 mcp.json 更权威的鉴权声明：mcp.json 可能漏标（如 tec-do 裸 URL），
  // 但索引里标了鉴权的连接器 DSH 无法自动注入凭据，装上必 401，必须在列表层就拦下。
  const mode = String(authMode || "").trim().toLowerCase();
  if (mode === "token") {
    // R7：token 型由「一律拒装」改为「可装但需引导填 token」。
    // 有可替换占位符 → 放行（UI 弹令牌框）；无占位符 → 用户无从填起，仍然拒装。
    if (!hasReplaceableSlots) {
      reasons.push("该连接器需要 token 凭据，但 mcp.json 未声明可替换的 ${...} 槽位，DSH 无法代填");
    }
  } else if (mode === "oauth" || mode === "oneid-token") {
    // R8：凭据改由插件侧 OAuth 授权流程获取（浏览器授权 → token 落盘 → 注入
    // authorization header），所以这里放行并打上需授权标记。
    needsOAuth = true;
  } else if (mode === "server-side" || mode === "mcp") {
    reasons.push(`该连接器需要 ${mode} 凭据，DSH 无法自动注入`);
  } else if (mode) {
    // 未知 auth_mode 值保守处理：宁可少装不错装（与本文件「能装的标准从严」同一纪律）。
    reasons.push(`该连接器需要未知类型的鉴权（auth_mode=${mode}），DSH 无法自动注入`);
  }
  const needsTokens = hasReplaceableSlots;
  if (transport === "streamablehttp" || transport === "streamable-http" || transport === "http") {
    return { ok: reasons.length === 0, transport: "streamable-http", reasons, tokenSlots, needsTokens, needsOAuth };
  }
  if (transport === "sse" || transport === "ws") reasons.push(`传输 ${transport} 不受 DSH 支持`);
  if (rawServer?.preAuth) reasons.push("需要 WorkBuddy 的 preAuth 鉴权链路");
  if (typeof nested?.command === "string" && isWorkbuddyOnlyCommand(nested.command)) reasons.push("command 依赖 WorkBuddy 本机连接器目录");
  const envKeys = Object.keys(nested?.env || {});
  const headerKeys = Object.keys(nested?.headers || {});
  // R7：已有可替换占位符的，交给 needsTokens 引导用户填，不再重复算作拒装理由；
  // 反之（键名像凭据但值里没有 ${...} 槽位）无从填起，仍然拒装。
  if (!hasReplaceableSlots
    && (envKeys.some((key) => /token|secret|key/i.test(key)) || headerKeys.some((key) => /authorization|token/i.test(key)))) {
    reasons.push("需要 WorkBuddy 的 token 注入，DSH 无法代填");
  }
  if (!reasons.length && transport !== "stdio") reasons.push(`未知传输类型 ${transport || "（缺失）"}`);
  return { ok: reasons.length === 0, transport: transport || "stdio", reasons, tokenSlots, needsTokens, needsOAuth };
}

/** connectors.json 索引 + 每条的可装性标注。UI 列表唯一数据源。 */
export async function wbConnectorCatalog() {
  const { zip, loadedFrom } = await loadConnectorZip();
  const index = JSON.parse(zip.extract(".codebuddy-connector/connectors.json").toString("utf8"));
  const rows = [];
  for (const entry of index.connectors || []) {
    const id = String(entry.id || entry.source || "").trim();
    if (!id) continue;
    let mcpJson = null;
    let skillCount = 0;
    try {
      const raw = JSON.parse(zip.extract(`connectors/${id}/mcp.json`).toString("utf8"));
      mcpJson = raw;
    } catch {
      mcpJson = null;
    }
    if (zip.has(`connectors/${id}/skills/`)) {
      for (const name of zip.entries.keys()) {
        if (name.startsWith(`connectors/${id}/skills/`) && name.endsWith("skill.md")) skillCount += 1;
      }
    }
    // mcp.json 可能一条目录带多个 mcpServers；逐个判可装性，全部可装才算可装（安装时逐条写入）。
    const servers = mcpJson?.mcpServers && typeof mcpJson.mcpServers === "object" ? Object.entries(mcpJson.mcpServers) : [];
    const checks = servers.map(([serverName, rawServer]) => ({ serverName, rawServer, ...serverInstallability(serverName, rawServer, entry.auth_mode) }));
    const blocked = checks.filter((check) => !check.ok);
    // R3：examples 优先（zh → en 回落），description 只作兜底正文。
    const copy = displayCopyOf(entry);
    rows.push({
      id,
      name: entry.name || id,
      nameEn: entry.name_en || "",
      description: entry.description_zh || entry.description || entry.description_en || "",
      descriptionEn: entry.description_en || "",
      // R3 投影：UI 优先用 displayBody（examples 语义），from 让 UI 知道在展示什么。
      displayBody: copy.body,
      displayFrom: copy.from,
      examples: copy.examples,
      // R2：visible_in 标签（上游未标 = 空数组 = 不受筛选）。
      visibleIn: visibleInOf(entry),
      // R1：token 注入规则条数标注（只展示；DSH 不代注入）。
      injectionRuleCount: injectionRuleNote(index, id).count,
      // R7：可装性拆分投影——needsTokens 为 true 时 UI 应弹令牌引导框。
      needsTokens: checks.some((check) => check.needsTokens),
      // R8：needsOAuth 为 true 时 UI 应走「浏览器授权」引导（而不是拒装/令牌框）。
      needsOAuth: checks.some((check) => check.needsOAuth),
      tokenSlots: checks.flatMap((check) => check.tokenSlots || []),
      authMode: entry.auth_mode || "",
      version: entry.version || "",
      type: entry.type || "",
      skillCount,
      serverNames: checks.map((check) => check.serverName),
      transport: checks[0]?.transport || "",
      installable: mcpJson !== null && servers.length > 0 && blocked.length === 0,
      blockedReason: mcpJson === null
        ? "非 MCP 型连接器（CLI 型或纯技能包）"
        : servers.length === 0
          ? "mcp.json 里没有可导入的 server"
          : blocked[0]?.reasons.join("；") || "",
    });
  }
  return { loadedFrom, total: rows.length, connectors: rows };
}

/** 预览某条连接器的 MCP 配置（安装前给用户看的真实 JSON）。 */
export async function wbConnectorPreview(connectorId) {
  const id = String(connectorId || "").trim();
  const { zip } = await loadConnectorZip();
  const raw = JSON.parse(zip.extract(`connectors/${id}/mcp.json`).toString("utf8"));
  const servers = raw?.mcpServers && typeof raw.mcpServers === "object" ? raw.mcpServers : null;
  if (!servers || !Object.keys(servers).length) throw new Error(`连接器 ${id} 没有 mcpServers 可导入`);
  return { connectorId: id, mcpServers: servers };
}

/**
 * 装前 401 探测：对 streamable-http 型 server 发一次 MCP initialize JSON-RPC，
 * 服务器明确回 401/403 就中止安装。索引 auth_mode 会漏标（tec-do 的 mcp.json 是裸 URL、
 * 索引 auth_mode 也为空，装完连接必 401 "Version negotiation failed"）——这是漏标鉴权的
 * 最后防线。判定刻意保守：只有 401/403 拦，超时/5xx/网络错误/其他状态一律放行——
 * 探测挂了不能误伤正常连接器，宁可让个别服务器在连接时报错。
 * 返回 { authorized: true }（放行）或 throw（要求授权，中止整个安装）。
 */
export async function probeServerAuthorization(serverName, rawServer) {
  const nested = rawServer && typeof rawServer.transport === "object" ? rawServer.transport : rawServer;
  const transport = String(nested?.type ?? "").toLowerCase();
  // 只探测 HTTP 型：stdio 没有可探测的 URL，sse/ws 本来就被准入闸拦下。
  if (transport !== "streamablehttp" && transport !== "streamable-http" && transport !== "http") return { authorized: true, skipped: true };
  const url = String(nested?.url || "").trim();
  if (!url) return { authorized: true, skipped: true };
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "dsh-armory", version: "1.0.0" },
    },
  });
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        // 透传 mcp.json 里该 server 已声明的 headers（例如部分连接器带公共 UA/token 模板）。
        ...Object.fromEntries(Object.entries(nested?.headers || {}).map(([key, value]) => [String(key).toLowerCase(), String(value)])),
        "user-agent": USER_AGENT,
      },
      body,
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    // 超时 / DNS 失败 / 连接拒绝：探测不了就放行，安装后由用户实测。
    return { authorized: true, error: "probe-unreachable" };
  }
  if (response.status === 401 || response.status === 403) {
    // R8：不再把 401 当致命错误。改回传结构化「需授权」，由上层触发浏览器授权流程：
    // 解析 WWW-Authenticate 里的 resource_metadata，交给 lib/mcp-oauth.js 继续走
    // RFC 9728（资源元数据）→ RFC 8414（AS 元数据）→ RFC 7591（动态注册）→ RFC 7636（PKCE）。
    const wwwAuthenticate = String(response.headers.get("www-authenticate") || "");
    return {
      authorized: false,
      needsAuth: true,
      status: response.status,
      url,
      serverName,
      wwwAuthenticate,
      resourceMetadata: extractResourceMetadata(wwwAuthenticate),
    };
  }
  // 200/202/4xx 其他/5xx：都视为「没有明确拒绝匿名握手」，放行。
  return { authorized: true, status: response.status };
}

/** 从 WWW-Authenticate 里取 resource_metadata="..."（RFC 9728 的入口指针）。 */
function extractResourceMetadata(header) {
  const match = String(header || "").match(/resource_metadata\s*=\s*"([^"]+)"/i)
    || String(header || "").match(/resource_metadata\s*=\s*([^\s,]+)/i);
  return match ? match[1].trim() : "";
}

/** 安装前对整份 mcpServers 逐个探测；把「需授权」的 server 聚合成清单回报，绝不中止安装。 */
export async function probeMcpServersAuthorization(mcpServers) {
  const servers = mcpServers && typeof mcpServers === "object" ? Object.entries(mcpServers) : [];
  const needsAuth = [];
  for (const [serverName, rawServer] of servers) {
    const probe = await probeServerAuthorization(serverName, rawServer);
    if (probe?.needsAuth) needsAuth.push(probe);
  }
  return { ok: true, checked: servers.length, needsAuth };
}

/**
 * 只读磁盘缓存的市场条目计数（供顶栏 chip 常驻显示，绝不联网）。
 * 磁盘上有 connectors-config.zip 就直接解索引计数；没有就返回 total:null，
 * 等「市场页真实打开过一次」（那会走完整下载并落缓存）之后再查就有数字了。
 * 单独存在的意义：wbConnectorCatalog 即使热缓存也会做一次 304 网络探测，
 * 冷缓存更是 24MB 下载——为顶栏一个数字触发这两者都不值得。
 */
export async function wbConnectorCachedCount() {
  try {
    const local = await readFile(zipPath());
    const zip = new ZipReader(local);
    const index = JSON.parse(zip.extract(".codebuddy-connector/connectors.json").toString("utf8"));
    const connectors = Array.isArray(index.connectors) ? index.connectors : [];
    return { total: connectors.filter((entry) => String(entry.id || entry.source || "").trim()).length };
  } catch {
    return { total: null };
  }
}

// ── SkillHub 技能市场 ─────────────────────────────────────────────────
// 列表：/api/skills?sortBy=downloads|installs|stars|score&page=N&pageSize=60&keyword=..&category=..
// 详情：/api/v1/skills/:slug?namespace=<handle>（带 latestVersion、publisher、securityReports）
// 文件：/api/v1/skills/:slug/files?namespace=<handle>[&version=]；/file 同形 + &path=
// namespace 用 namespace.handle（列表项里是对象）， 不是 canonicalName。
const SKILLHUB_SORTS = new Set(["downloads", "installs", "stars", "score"]);
// 2026-10 实测（api.skillhub.cn）：`sortBy=downloads` 已不再是可用值——TCP 能连上、
// 但服务端不回任何字节，一直挂到客户端 AbortSignal 超时；installs / stars / score /
// updated 仍正常，非法值（download、hot、new…）会立刻 400 而不是挂起。
// 所以下载量排序不再发给上游，改成本地按当前页排序（见 wbSkillCatalog 尾部）。
const SKILLHUB_REMOTE_SORTS = new Set(["installs", "stars", "score"]);
async function skillhubJson(path, { timeoutMs = 15_000 } = {}) {
  let buffer;
  try {
    buffer = await fetchWithLimits(`${SKILLHUB_ORIGIN}${path}`, { timeoutMs });
  } catch (e) {
    // 超时是上游最常见的一种失败（挂起而非 4xx），把 Node 的英文原文换成能看懂的中文。
    const name = e && e.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`SkillHub 在 ${Math.round(timeoutMs / 1000)} 秒内没有响应，已放弃本次请求；稍后重试即可。`);
    }
    throw e;
  }
  const body = JSON.parse(buffer.toString("utf8"));
  // SkillHub 的业务错误也在 200 里（code !== 0）。
  if (body && typeof body.code === "number" && body.code !== 0) throw new Error(`SkillHub 返回错误：${body.message || body.code}`);
  return body;
}
export async function wbSkillCatalog(payload = {}) {
  const page = Math.max(1, Math.min(200, Number(payload.page) || 1));
  const pageSize = Math.max(1, Math.min(60, Number(payload.pageSize) || 20));
  const sort = SKILLHUB_SORTS.has(payload.sort) ? payload.sort : "downloads";
  const remoteSort = SKILLHUB_REMOTE_SORTS.has(sort) ? sort : "";
  // 只把上游确认可用的排序发出去：`sortBy=downloads` 会挂起（见 SKILLHUB_REMOTE_SORTS）。
  // 不带 sortBy 时上游按自己的默认序返回，参数缺失不会 400（已实测）。
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (remoteSort) params.set("sortBy", remoteSort);
  const keyword = String(payload.keyword || "").trim();
  if (keyword) params.set("keyword", keyword.slice(0, 64));
  const category = String(payload.category || "").trim();
  if (category) params.set("category", category.slice(0, 64));
  const body = await skillhubJson(`/api/skills?${params.toString()}`);
  const skills = Array.isArray(body?.data?.skills) ? body.data.skills : [];
  const rows = skills.map((skill) => ({
    slug: String(skill.slug || ""),
    name: String(skill.name || skill.slug || ""),
    namespace: String(skill.namespace?.handle || ""),
    canonical: String(skill.namespace?.canonicalName || ""),
    description: String(skill.description_zh || skill.description || ""),
    descriptionEn: String(skill.description_en || ""),
    downloads: Number(skill.downloads) || 0,
    installs: Number(skill.installs) || 0,
    stars: Number(skill.stars) || 0,
    score: Number(skill.score) || 0,
    version: String(skill.version || ""),
    verified: !!skill.verified,
    updatedAt: Number(skill.updated_at) || 0,
    category: String(skill.category || ""),
    tags: Array.isArray(skill.tags) ? skill.tags.slice(0, 6).map(String) : [],
    upstreamUrl: String(skill.upstream_url || skill.homepage || ""),
  })).filter((skill) => skill.slug && skill.namespace);
  // 下载量排序上游已不可用，退化为「当前页内按下载量降序」：跨页顺序仍是上游默认序，
  // 所以这是页内排序而不是全库排序（UI 侧「最多下载」的含义随之收窄，见下）。
  if (!remoteSort) rows.sort((a, b) => b.downloads - a.downloads);
  return {
    page,
    pageSize,
    sort,
    keyword,
    category,
    total: Number(body?.data?.total) || 0,
    skills: rows,
  };
}
export async function wbSkillDetail(payload = {}) {
  const slug = String(payload?.slug || "").trim();
  const namespace = String(payload?.namespace || "").trim();
  if (!slug || !namespace) throw new Error("缺少 slug 或 namespace");
  const body = await skillhubJson(`/api/v1/skills/${encodeURIComponent(slug)}?namespace=${encodeURIComponent(namespace)}`);
  // 详情端点**没有** {code,data,message} 包装：latestVersion 等字段直接在根上
  // （列表端点才有 data 包装）。两种形状都兼容，避免上游改包装方式时把面板打空。
  const data = body?.latestVersion ? body : (body?.data || {});
  const reports = data.securityReports && typeof data.securityReports === "object" ? data.securityReports : {};
  const reportStatus = Object.values(reports).map((report) => String(report?.status || "")).filter(Boolean);
  return {
    slug,
    namespace,
    name: String(data.name || slug),
    version: String(data.latestVersion?.version || ""),
    changelog: String(data.latestVersion?.changelog || ""),
    description: String(data.description_zh || data.description || ""),
    publisher: String(data.publisher?.name || data.owner?.displayName || ""),
    verifiedPublisher: !!data.publisher?.verified,
    certifiedName: String(data.publisher?.certifiedName || ""),
    security: reportStatus.length ? reportStatus : ["unknown"],
    homepage: String(data.homepage || ""),
  };
}
export async function wbSkillFiles(payload = {}) {
  const slug = String(payload?.slug || "").trim();
  const namespace = String(payload?.namespace || "").trim();
  if (!slug || !namespace) throw new Error("缺少 slug 或 namespace");
  const params = new URLSearchParams({ namespace });
  if (payload?.version) params.set("version", String(payload.version));
  const body = await skillhubJson(`/api/v1/skills/${encodeURIComponent(slug)}/files?${params.toString()}`);
  const files = Array.isArray(body?.files) ? body.files : [];
  return {
    version: String(body?.version || payload?.version || ""),
    files: files.map((file) => ({ path: String(file.path || ""), size: Number(file.size) || 0, sha256: String(file.sha256 || "") })),
  };
}

// ── 技能安装：落盘到用户技能目录 ────────────────────────────────────────
// 目标根目录与官方 skill 子系统的发现范围对齐：~/.agents/skills（SKILL_SOURCE_LABELS 里的
// user-agents，优先级高于 ~/.dsh/skills）。装完即被注册表发现，无需重启。
function skillTargetName(namespace, slug) {
  // 单段防路径穿越：handle / slug 都可能被恶意构造，只留安全字符。
  const safe = (value) => String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "x";
  return `${safe(namespace)}__${safe(slug)}`;
}
export async function wbSkillInstall(payload = {}, { onProgress } = {}) {
  const slug = String(payload?.slug || "").trim();
  const namespace = String(payload?.namespace || "").trim();
  const requestedName = String(payload?.name || "").trim();
  if (!slug || !namespace) throw new Error("缺少 slug 或 namespace");
  const listing = await wbSkillFiles(payload);
  if (!listing.files.length) throw new Error("该技能没有可下载的文件");
  if (listing.files.length > 400) throw new Error(`文件数超出上限（${listing.files.length} > 400）`);
  const root = join(homedir(), ".agents", "skills");
  const targetName = skillTargetName(namespace, slug);
  const finalDir = join(root, targetName);
  const stagingDir = `${finalDir}.installing`;
  const totalBytes = listing.files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > 32 * 1024 * 1024) throw new Error(`技能总体积超过 32MB 上限（${Math.round(totalBytes / 1024 / 1024)}MB）`);
  // 必须有 SKILL.md，否则装了也不会被注册表发现——直接拒绝而不是装个哑包。
  const hasSkillMd = listing.files.some((file) => file.path === "SKILL.md");
  if (!hasSkillMd) throw new Error("清单里没有 SKILL.md，不是标准技能包，拒绝安装");
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  let doneBytes = 0;
  try {
    for (const [index, file] of listing.files.entries()) {
      const relative = file.path;
      // 路径安全：解析后必须落在 staging 内（拒绝 ../、绝对路径、盘符）。
      const target = resolve(stagingDir, relative);
      if (target !== stagingDir && !target.startsWith(stagingDir + sep)) throw new Error(`清单里的非法路径：${relative}`);
      const params = new URLSearchParams({ namespace, path: relative });
      if (listing.version) params.set("version", listing.version);
      const buffer = await fetchWithLimits(`${SKILLHUB_ORIGIN}/api/v1/skills/${encodeURIComponent(slug)}/file?${params.toString()}`);
      if (file.sha256 && buffer.length) {
        const digest = createHash("sha256").update(buffer).digest("hex");
        if (digest !== file.sha256) throw new Error(`文件校验失败（${relative}）：sha256 不匹配`);
      }
      await mkdir(resolve(stagingDir, relative, ".."), { recursive: true });
      await writeFile(target, buffer);
      doneBytes += buffer.length;
      onProgress?.({ phase: "downloading", index: index + 1, total: listing.files.length, bytes: doneBytes, totalBytes });
    }
    // 最终位置已被占用（同名/换版本重装）：先挪开旧的，再原子换入。
    await rm(finalDir, { recursive: true, force: true });
    await rename(stagingDir, finalDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return {
    note: `已安装到 ${finalDir}（${listing.files.length} 个文件${listing.version ? `，v${listing.version}` : ""}），即刻生效`,
    dir: finalDir,
    name: requestedName || slug,
    version: listing.version,
  };
}
export async function wbSkillUninstall(payload = {}) {
  const slug = String(payload?.slug || "").trim();
  const namespace = String(payload?.namespace || "").trim();
  if (!slug || !namespace) throw new Error("缺少 slug 或 namespace");
  const targetName = skillTargetName(namespace, slug);
  const finalDir = join(homedir(), ".agents", "skills", targetName);
  try {
    await stat(finalDir);
  } catch {
    throw new Error("本机没有这个市场技能的安装记录（可能已卸载或由其它工具安装）");
  }
  await rm(finalDir, { recursive: true, force: true });
  return { note: `已卸载 ${targetName}` };
}
/** 已装的市场技能（安装记录即目录本身），用于卡片上的「已安装」标记与卸载。 */
export async function wbSkillInstalled() {
  const root = join(homedir(), ".agents", "skills");
  const rows = [];
  let names = [];
  try {
    names = await readdir(root);
  } catch {
    return { installed: [] };
  }
  for (const name of names) {
    if (!name.includes("__")) continue;
    const [namespace, ...slugParts] = name.split("__");
    const dir = join(root, name);
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) continue;
      rows.push({ dirName: name, namespace, slug: slugParts.join("__"), dir });
    } catch {
      // 竞态删除：跳过
    }
  }
  return { installed: rows };
}
