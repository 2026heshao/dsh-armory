import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { interpolate } from "@deepseek-ai/cordis-plugin-loader";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeMcpImport, readManagedMcpServers, setManagedMcpDisabled, updateManagedMcpPatch } from "./mcp-config.js";
import { describeLaunchRewrite } from "./win32-stdio.js";
import { admitImportedServers } from "./import-admission.js";
import { collectImportLocations, missingEnvNames, resolveImportLocation } from "./mcp-import-sources.js";
import { deriveMcpPhase, formatMcpLog, sanitizeMcpLog } from "./mcp-observability.js";
import { allMcpEntries, entriesForName, projectToolSchema, revisionOf, toolInventory } from "./mcp-registry.js";
// Skill 看板的卸载落盘点：来源白名单 + 根目录包含性 + 符号链接/根目录校验（lib/skill-remove.js）。
import { removeSkillFromDisk } from "./skill-remove.js";
// 工具裁缝技能账本的禁用/释放落盘点：写 SKILL.md frontmatter 的 disable-model-invocation
// 标志（宿主 dsh-skill-filesystem 官方键），安全闸门与 skill-remove 同一套（lib/skill-disable.js）。
import { setSkillModelInvocationOnDisk } from "./skill-disable.js";
// Skill 看板的安装时间 + 市场原名投影（名字自建映射，lib/skill-dir-times.js）。
import { skillInstallInfo } from "./skill-dir-times.js";
// 系统级打开（issue #7）：headless 主机没有 xdg-open，spawn 的 ENOENT 必须有监听者，
// 否则异步 error 事件会带走整个宿主进程（lib/system-open.js）。
import { isAllowedExternalUrl, openSystemUrl, revealSystemPath } from "./system-open.js";
import { WHATS_NEW } from "./whats-new.js";
import { attachWhatsNewEnglish } from "./whats-new-en.js";
// T03/R4：多市场注册表（连接器源）的宿主侧数据层。
import { readRegistry, upsertMarketplace } from "./wb-registry.js";
// T06/Awesome：DSH 社区插件市场（awesome-dsh-plugins）的宿主侧数据层。
import { wbAwesomeCatalog, wbAwesomeDetail, wbAwesomeReadme, wbAwesomeUpdateCheck } from "./wb-awesome-market.js";
// 社区 MCP：官方 MCP Registry（registry.modelcontextprotocol.io）只读取数，数据层在 lib/mcp-community.js。
import { wbMcpCommunityList, wbMcpCommunityCount } from "./mcp-community.js";
// 社区元信息（维护者 / 最近提交 / issue / star）：打开详情时按需查，6 小时缓存。
import { wbRepoMeta } from "./community-meta.js";
// npm 近 30 天下载量：插件卡片底栏的「↓N」，目录里没有这个字段，只能去 npm 统计接口取。
import { wbNpmDownloads } from "./npm-downloads.js";
// 装备清单：只读汇总本机已装条目，校验与差异计算保持纯函数（lib/loadout.js）。
import { buildLoadout, diffLoadout } from "./loadout.js";
import { readState as readInstallState, record as recordInstallState, forget as forgetInstallState } from "./wb-install-state.js";
// 自定义套件（Skill 看板）：读 / 整集合覆盖保存，数据层 lib/suites-registry.js。
import { readSuites as readSkillSuites, saveSuites as writeSkillSuites } from "./suites-registry.js";
import { applyTokens } from "./wb-auth-rules.js";
import {
	authorizationOverview as oauthOverview,
	authorizationStatus as oauthStatus,
	beginAuthorization as oauthBegin,
	cancelAuthorization as oauthCancel,
	clearTokenRecord as oauthClearToken,
	ensureAccessToken as oauthEnsureToken,
	isSerializedGarbageCredential as oauthIsGarbageCredential,
	isUsableBearerToken as oauthIsUsableToken,
	saveManualToken as oauthSaveManualToken,
	submitCallback as oauthSubmitCallback,
} from "./mcp-oauth.js";
import { attachPersona, detachPersona, installPersonaRuntime, listPersonas, reconcilePersonas } from "./session-persona.js";
// clearTextCache 的 import 已随 toolTailor 的「清空缓存」动作一起删掉（见下方 toolTailor 注释）。
import { scanSessionLedger } from "./tool-ledger.js";
import { evaluateEnvExpression, jsExpressionToTemplate } from "./workspace-config.js";
import { canonicalWorkspacePath, installAgentRuntime, listWorkspaceRecords, liveWorkspaceAgentCount, projectConnectionsView, readWorkspaceConfigCached, reconcileWorkspaceConnections, reconcileWorkspaceRestricts, reconnectWorkspaceServer, resolveSessionWorkspace, withWorkspaceWrite, workspaceConnectionStatus, workspaceMountErrorsView, workspaceRestrictErrorView, workspaceScopeErrorsView, workspaceToolSchemas, writeWorkspaceConfigFile } from "./workspace-runtime.js";

// ── P0-1：市场数据模块按需加载 ──────────────────────────────────────────
// wb-market（连接器 ZIP + SkillHub）与 expert-market（专家目录）合计约 68ms 的冷导入，
// 面板一次都没打开时纯属宿主启动成本。两者只被市场 / 专家相关 RPC 用到，因此改为
// 首次调用时才 import。缓存的是 Promise 本身：并发首次调用共享同一次解析，不会重复加载；
// 解析失败时清掉缓存，下次调用可重试（不会永久卡在 rejected Promise 上）。
let marketModule = null;
let expertModule = null;
const loadMarket = () => {
	marketModule ??= import("./wb-market.js").catch((error) => {
		marketModule = null;
		throw error;
	});
	return marketModule;
};
const loadExpert = () => {
	expertModule ??= import("./expert-market.js").catch((error) => {
		expertModule = null;
		throw error;
	});
	return expertModule;
};

var __runInitializers = function(thisArg, initializers, value) {
	var useValue = arguments.length > 2;
	for (var i = 0; i < initializers.length; i++) value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
	return useValue ? value : void 0;
};
var __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
	function accept(f) {
		if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
		return f;
	}
	var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
	var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
	var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
	var _, done = false;
	for (var i = decorators.length - 1; i >= 0; i--) {
		var context = {};
		for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
		for (var p in contextIn.access) context.access[p] = contextIn.access[p];
		context.addInitializer = function(f) {
			if (done) throw new TypeError("Cannot add initializers after decoration has completed");
			extraInitializers.push(accept(f || null));
		};
		var result = (0, decorators[i])(kind === "accessor" ? {
			get: descriptor.get,
			set: descriptor.set
		} : descriptor[key], context);
		if (kind === "accessor") {
			if (result === void 0) continue;
			if (result === null || typeof result !== "object") throw new TypeError("Object expected");
			if (_ = accept(result.get)) descriptor.get = _;
			if (_ = accept(result.set)) descriptor.set = _;
			if (_ = accept(result.init)) initializers.unshift(_);
		} else if (_ = accept(result)) if (kind === "field") initializers.unshift(_);
		else descriptor[key] = _;
	}
	if (target) Object.defineProperty(target, contextIn.name, descriptor);
	done = true;
};

const ROOT_INCLUDE_ID = "include";
const REDACTED_VALUE = "__DSH_MCP_REDACTED__";
const REVEAL_REVISION_KEY = randomBytes(32);
const patchWriteQueues = new WeakMap();
// ── R8：连接器 MCP 的 OAuth 授权接线 ─────────────────────────────────────
// 所有网络与落盘动作都在 lib/mcp-oauth.js；本文件只做三件事：
// ① 从 mcpServers 里取出某个 server 的 url / headers（授权的靶点）；
// ② 安装前把已授权 server 的 Bearer token 注进 headers（否则探测永远 401）；
// ③ 把授权会话包装成 RPC 结果给面板轮询。
const OAUTH_HTTP_TRANSPORT = new Set(["streamable-http", "streamablehttp", "http"]);

/** 归一化一个 mcp.json server 条目：transport 可能是对象（nested）也可能是裸字段。 */
function nestedServerSpec(rawServer) {
	const nested = rawServer && typeof rawServer.transport === "object" ? rawServer.transport : rawServer || {};
	const transport = String(nested?.type ?? rawServer?.type ?? "").toLowerCase();
	const url = String(nested?.url ?? rawServer?.url ?? "").trim();
	const headers = {};
	for (const [key, value] of Object.entries(nested?.headers || {})) headers[String(key).toLowerCase()] = String(value);
	return { nested, transport, url, headers };
}

/** 只有带 url 的 HTTP 族 server 才可能要走 OAuth；stdio 型永远不需要。 */
function isOAuthCandidate(spec) {
	return Boolean(spec.url) && OAUTH_HTTP_TRANSPORT.has(spec.transport || "streamable-http");
}

/** 保留原 headers，覆盖 authorization —— 这是 mcp-client 唯一能带出去的凭据通道。 */
function withBearerHeader(rawServer, token) {
	const spec = nestedServerSpec(rawServer);
	const headers = { ...spec.headers, authorization: `Bearer ${token}` };
	if (rawServer && typeof rawServer.transport === "object") return { ...rawServer, transport: { ...rawServer.transport, headers } };
	return { ...rawServer, headers };
}

/**
 * 摘掉一个已经坏掉的 authorization 头（保留其它头、保留原键名大小写）。
 * 只给「确认是序列化残骸」的配置用：历史版本把 `Bearer [object Object]` 写进了
 * 用户的 patch，那条头不删掉，服务器就从「你没带凭据」(401) 变成「你凭据是坏的」(400)，
 * 装前探测因此再也认不出这是鉴权问题，用户既装不上也看不到授权入口。
 */
function stripBearerHeader(rawServer) {
	const container = rawServer && typeof rawServer.transport === "object" ? rawServer.transport : rawServer;
	const headers = container?.headers;
	if (!headers || typeof headers !== "object" || Array.isArray(headers)) return rawServer;
	const next = {};
	for (const [key, value] of Object.entries(headers)) {
		if (String(key).toLowerCase() !== "authorization") next[key] = value;
	}
	const patched = { ...container, headers: next };
	return rawServer && typeof rawServer.transport === "object" ? { ...rawServer, transport: patched } : patched;
}

/**
 * 安装前把已落盘的 access_token 注进对应 server 的 headers。
 * 读不到 / 过期且刷不动就原样返回，交给 probe 去判定「需要授权」——
 * 绝不因为令牌库有问题而阻断一次本来能成功的安装。
 */
async function injectStoredOAuthTokens(mcpServers) {
	if (!mcpServers || typeof mcpServers !== "object") return mcpServers;
	const out = {};
	for (const [serverName, rawServer] of Object.entries(mcpServers)) {
		const spec = nestedServerSpec(rawServer);
		// 配置里已有的 authorization 一律优先：可能是用户手填的真令牌，也可能是 R7
		// 的 ${...} 占位符（那种要原样保留、由 missingSlots 回报面板补填）。
		const declared = spec.headers.authorization;
		const poisoned = Boolean(declared) && oauthIsGarbageCredential(declared);
		if (!isOAuthCandidate(spec) || (declared && !poisoned)) {
			out[serverName] = rawServer;
			continue;
		}
		let token = "";
		try {
			// ensureAccessToken 回的是 {ok, accessToken, refreshed, error} 对象，不是字符串。
			// 这里曾经直接对那个对象取字符串：得到 "[object Object]"，真值、非空，
			// 于是每个 HTTP 连接器都被注进 `authorization: Bearer [object Object]`
			// —— 装上必挂，还把服务器的 401 伪装成 400（见 test/auth-gate-regression.mjs 第 7 节）。
			const result = await oauthEnsureToken(spec.url);
			if (result?.ok && oauthIsUsableToken(result.accessToken)) token = String(result.accessToken).replace(/^Bearer\s+/i, "").trim();
		} catch {
			token = "";
		}
		if (token) out[serverName] = withBearerHeader(rawServer, token);
		else out[serverName] = poisoned ? stripBearerHeader(rawServer) : rawServer;
	}
	return out;
}

/** 解析某连接器里某 server 的授权靶点（url + 现有 headers）。 */
async function resolveOAuthTarget(connectorId, serverName) {
	const marketApi = await loadMarket();
	const preview = await marketApi.wbConnectorPreview(connectorId);
	const servers = preview?.mcpServers && typeof preview.mcpServers === "object" ? preview.mcpServers : {};
	const name = String(serverName || "").trim() || Object.keys(servers)[0] || "";
	const rawServer = servers[name];
	if (!rawServer) throw new Error(`连接器 ${connectorId} 里没有 server「${name || "（空）"}」`);
	const spec = nestedServerSpec(rawServer);
	if (!spec.url) throw new Error(`server「${name}」没有可授权的 URL（stdio 型不需要 OAuth 授权）`);
	// 坏掉的 authorization 不能跟着去探测：带着 `Bearer [object Object]` 打过去，服务器
	// 回的是 400「token parse failed」而不是 401「empty access token」，授权发现
	// 那条路就在第一步被判定成「非鉴权错误」而中止。
	const headers = { ...spec.headers };
	if (headers.authorization && oauthIsGarbageCredential(headers.authorization)) delete headers.authorization;
	return { serverName: name, url: spec.url, headers, transport: spec.transport };
}

/** 宿主 shell 服务的几种可能落点，逐个试；拿不到就返回 undefined 走系统兜底。 */
function resolveShellService(ctx) {
	if (typeof ctx?.get !== "function") return undefined;
	for (const id of ["shell", "electron", "appShell", "desktop"]) {
		try {
			const value = ctx.get(id);
			if (!value) continue;
			if (typeof value.openExternal === "function") return value;
			if (typeof value?.shell?.openExternal === "function") return value.shell;
		} catch {
			/* 该服务不存在，继续试下一个 */
		}
	}
	return undefined;
}

/** 用宿主能力打开授权页；没有 shell 就退回系统默认浏览器。 */
async function openExternalUrl(ctx, url) {
	const target = String(url || "").trim();
	if (!target) return { opened: false, reason: "empty-url" };
	// 协议白名单在交给宿主 shell 之前先过一遍：Electron 的 openExternal 同样能打开
	// file: / 本地可执行文件，不能因为「宿主有 shell」就跳过校验。
	if (!isAllowedExternalUrl(target)) return { opened: false, reason: "blocked-url" };
	const shell = resolveShellService(ctx);
	if (shell && typeof shell.openExternal === "function") {
		try {
			await shell.openExternal(target);
			return { opened: true, via: "shell" };
		} catch {
			/* 落到系统兜底 */
		}
	}
	try {
		const opened = await openSystemUrl(target, { logger: ctx?.logger });
		if (opened.ok) return { opened: true, via: "spawn" };
		// headless 主机没有桌面打开器：如实告诉面板，让它把授权链接交给用户手动打开。
		return { opened: false, reason: opened.reason || "system-opener-unavailable" };
	} catch (error) {
		return { opened: false, reason: String(error?.message || error) };
	}
}
const PHASE_TEXT = { 0: "waiting", 1: "loading", 2: "connected", 3: "failed", 4: "stopped", 5: "unloading" };

// mcp-client 至今不暴露任何可订阅的状态面（只导出 name/inject/Config/apply，无事件、无服务），
// 连接状态只存在于日志。
// 我们通过 ctx.logger.exporter 订阅全部日志，按 scope 过滤出 mcp-client(<serverName>) 的记录。
const recentMcpLogs = new WeakMap();
const recentFiberLogs = new WeakMap();
const MAX_LOG_RECORDS = 12;
const logScope = (ctx) => ctx?.root || ctx;
function appendRecent(store, key, record) {
  const list = store.get(key) || [];
  list.push(record);
  if (list.length > MAX_LOG_RECORDS) list.splice(0, list.length - MAX_LOG_RECORDS);
  store.set(key, list);
}
const MCP_LOG_LABEL = /mcp-client\(([^)]+)\)/;
function mcpLogLabelSource(message) {
  // 便宜匹配先行：进程里绝大多数日志与 mcp-client 无关，不能为了判断这件事先去格式化+脱敏
  // （实测前者 0.3µs/行、后者 9.1µs/行，且 info/debug 占了绝大多数日志）。
  const named = String(message.name || "");
  if (named.includes("mcp-client(")) return named;
  const args = Array.isArray(message.args) ? message.args : [];
  return args.find((value) => typeof value === "string" && value.includes("mcp-client(")) || "";
}
function recordMcpLog(ctx, message) {
  const diagnostic = message.type === "error" || message.type === "warn";
  const fiber = diagnostic ? message.fiber?.deref?.() : undefined;
  const labelSource = mcpLogLabelSource(message);
  // 只有「确实是 mcp-client 的日志」或「error/warn 级纤维诊断」才需要真实内容。
  if (!labelSource && !fiber) return;
  const text = sanitizeMcpLog(formatMcpLog(message));
  const record = { type: message.type, text, ts: message.ts };
  if (fiber) appendRecent(recentFiberLogs, fiber, record);
  if (!labelSource) return;
  const match = MCP_LOG_LABEL.exec(labelSource);
  if (!match) return;
  const scope = logScope(ctx);
  const entry = recentMcpLogs.get(scope) || new Map();
  const serverName = match[1];
  appendRecent(entry, serverName, record);
  recentMcpLogs.set(scope, entry);
}
function lastLogFor(ctx, serverName, fiber) {
  const named = recentMcpLogs.get(logScope(ctx))?.get(serverName) || [];
  const scoped = fiber ? recentFiberLogs.get(fiber) || [] : [];
  const logs = [...named, ...scoped].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const diagnostic = logs.filter((record) => /attempt failed|tool .*failed|McpError|ECONNREFUSED|giving up|did not close/i.test(record.text)).at(-1);
  return diagnostic || logs.at(-1) || null;
}
// 每个 ctx 只挂一次 exporter；构造与首次 list/status 都会触发，保证幂等。
const logCaptureState = new WeakMap();
function ensureLogCapture(ctx) {
  const scope = logScope(ctx);
  if (logCaptureState.has(scope)) return logCaptureState.get(scope).dispose;
  const logger = scope?.logger || ctx?.logger;
  const exporter = { colors: 0, levels: { default: 3 }, export: (message) => recordMcpLog(ctx, message) };
  let dispose = () => {};
  // Cordis 4.0.1 LoggerService.exporter() 的 disposer 删除的是“当前最大 ID”而非
  // 注册时 ID。固定 peer 版本下直接捕获 ID，避免热重载泄漏或误删其他 exporter。
  if (logger?.exporters instanceof Map && Number.isInteger(logger._snExporter)) {
    const exporterId = ++logger._snExporter;
    logger.exporters.set(exporterId, exporter);
    dispose = () => logger.exporters.delete(exporterId);
  } else if (logger?.exporter) {
    // 降级通道：cordis 4.0.1 的 exporter() disposer 删的是“当时最大 ID”而不是注册时 ID，
    // 热重载时可能误删其他插件的 exporter。私有字段不在就说明 peer 已偏离验证过的形状：
    // 明确告警，不静默降级。
    logger.warn?.("mcp-manager: cordis LoggerService 的 exporters/_snExporter 形状已变化，MCP 日志诊断退回 exporter() 通道；热重载时可能误删其他插件的 exporter，请核对 cordis peer 版本");
    dispose = logger.exporter(exporter);
  }
  // 回放 exporter 注册前 buffer 中已有的 mcp-client 日志。
  for (const message of logger?.buffer || []) recordMcpLog(ctx, message);
  logCaptureState.set(scope, { dispose });
  // 诊断通路也要有生命周期归属：没有 effect() 就没人卸 exporter，HMR 一次泄一个。
  // 不静默跳过：诊断本身不能以“你看不见的泄漏”为代价。
  if (typeof ctx?.effect !== "function") {
    logger?.warn?.("mcp-manager: 当前 context 没有 effect()，MCP 日志 exporter 没有生命周期归属，插件热重载后会残留一个订阅者");
    return dispose;
  }
  ctx.effect(() => () => {
    dispose();
    logCaptureState.delete(scope);
    recentMcpLogs.delete(scope);
  }, "mcpManager.logCapture");
  return dispose;
}

function hasExternalMcpName(ctx, state, name) {
	return externalMcpEntries(ctx, state).some((entry) => entry.options.config.serverName === name);
}
function resolveManagedEntry(state, name, matches) {
	const id = state.entryIds.get(name);
	if (!id || matches.length !== 1 || matches[0].options.id !== id) return null;
	return matches[0];
}
function managedLiveEntry(ctx, state, name) {
	return resolveManagedEntry(state, name, entriesForName(ctx, name));
}
function patchPath(ctx) {
	const entry = [...ctx.loader.entries()].find((candidate) => candidate.options.id === ROOT_INCLUDE_ID && candidate.options.name === "cordis:include");
	const path = entry?.options.config?.path;
	if (typeof path !== "string") return null;
	const filename = path.startsWith("file:") ? fileURLToPath(path) : path;
	return join(dirname(filename), "cordis.patch.yml");
}
// profile 目录：与 patchPath 同一条受信发现路径（根 include 的 path 所在目录），
// 不是从 ctx.fs 或 cwd 猜出来的——installInfo 只读它下面的 package.json。
function profileDirOf(ctx) {
	const path = patchPath(ctx);
	return path ? dirname(path) : null;
}
/**
 * 安装来源分类：客户端据此决定「一键升级」能不能做。
 * 本仓库历史上踩过的坑：listBundles() 的返回行里**没有 source 字段**，客户端拿它判
 * 来源会恒判「npm 装的」，于是本地 file: 安装的用户一点升级就被 `pnpm add` 换成 npm 包。
 * 这里只按 profile manifest 里的 spec 前缀分类，分类结果直接决定按钮出不出现。
 * @returns {"registry"|"file"|"link"|"git"|"remote"|"path"|"unknown"}
 */
function classifyInstallSpec(spec) {
	const text = typeof spec === "string" ? spec.trim() : "";
	if (text === "") return "unknown";
	if (/^(file:|portal:|workspace:)/i.test(text)) return "file";
	if (/^link:/i.test(text)) return "link";
	if (/^(github:|git\+|git:|https?:\/\/.*\.git)/i.test(text)) return "git";
	if (/^https?:/i.test(text)) return "remote";
	if (/^(\.{1,2}[\\/]|[A-Za-z]:[\\/]|\/)/.test(text)) return "path";
	// registry spec：版本范围（^1.9.0 / ~1.9.0 / 1.9.0 / latest / * / 空=latest）
	if (/^[\^~]?\d/.test(text) || /^(latest|\*)$/i.test(text)) return "registry";
	if (/^[a-z@]/i.test(text)) return "registry";
	return "unknown";
}
// Profile persistence is a Host-owned configuration capability, not a session workspace mutation.
// `ctx.fs` is intentionally fenced by the active workspace-write policy, so this target is
// derived only from the trusted root include and committed through the Host atomic writer.
function patchVersion(content) {
	return createHash("sha256").update(content).digest("hex");
}
async function readProfilePatchFile(path) {
	const [content, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
	if (!info.isFile()) throw new Error("profile patch is not a regular file");
	return { content, target: path, version: patchVersion(content), mode: info.mode & 0o777 || 0o600 };
}
function withPatchWrite(ctx, operation) {
	const previous = patchWriteQueues.get(ctx) || Promise.resolve();
	const run = async () => {
		const path = patchPath(ctx);
		if (!path) throw new Error("root include unavailable; cannot locate profile patch");
		return withFileLock(path, operation);
	};
	const current = previous.then(run, run);
	patchWriteQueues.set(ctx, current.catch(() => {}));
	return current;
}
async function readPatch(ctx) {
	const path = patchPath(ctx);
	if (!path) throw new Error("root include unavailable; cannot locate profile patch");
	return readProfilePatchFile(path);
}
async function writePatch(state, content, version = state.version) {
	const current = await readProfilePatchFile(state.target);
	if (current.version !== version) throw new Error(`FS_STALE_VERSION: profile patch changed since it was read: ${state.target}`);
	await writeFileAtomic(state.target, content, { mode: current.mode });
	return { operation: "update", version: patchVersion(content), before: current.content, after: content };
}
async function managedState(ctx) {
	const patch = await readPatch(ctx);
	const parsed = readManagedMcpServers(patch.content);
	return { ...patch, servers: parsed.servers, byName: new Map(parsed.servers.map((server) => [server.name, server])), entryIds: new Map(Object.entries(parsed.entryIds)) };
}
function profileMcpEntries(ctx) {
	const include = [...ctx.loader.entries()].find((entry) => entry.options.id === ROOT_INCLUDE_ID && entry.options.name === "cordis:include");
	const entries = include?.subtree?.entries?.();
	return entries ? new Set(entries) : null;
}
function externalMcpEntries(ctx, state) {
	const profileEntries = profileMcpEntries(ctx);
	const managedIds = new Set(state.entryIds.values());
	const managedNames = new Set(state.servers.map((server) => server.name));
	return allMcpEntries(ctx).filter((entry) => {
		if (profileEntries) return !profileEntries.has(entry) && !managedIds.has(entry.options.id);
		return !managedIds.has(entry.options.id) && !(!entry.options.group && managedNames.has(entry.options.config.serverName));
	});
}
function revealRevision(state, groups) {
	const values = [];
	for (const current of state.servers) {
		const entry = resolveManagedEntry(state, current.name, groups.get(current.name) || []);
		if (!entry) continue;
		const live = entry.options.config;
		values.push({
			name: current.name,
			url: live.url ?? current.url,
			args: live.args ?? current.args,
			env: live.env ?? current.env,
			headers: live.headers ?? current.headers,
		});
	}
	return createHmac("sha256", REVEAL_REVISION_KEY).update(JSON.stringify(values)).digest("base64url");
}
function setOwn(target, key, value) {
	Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}
// env/headers 的值默认一律掩码：不显示任何实际内容，明文与 `!!js` 引用一视同仁。
// 旧实现把 `!!js process.env.X` 当作「安全引用」保留下来，结果同一份配置会因为写法不同
// 而一个掩盖码、一个把内部 `!!js` 表达式原文摆到界面上（用户看到的正是后者）。
// 需要看真实值时走 reveal（眼睛）——那条通路给的是「有效运行值」。
// key 名保留：用户需要知道配了哪些字段。
function redactMap(value) {
	const result = {};
	for (const key of Object.keys(value || {})) setOwn(result, key, REDACTED_VALUE);
	return result;
}
function redactUrl(value) {
	// `!!js` 表达式可能内嵌密钥，且内部语法不该出现在界面上：一律掩码（不管简单还是复杂）。
	if (typeof value === "string" && value.startsWith("!!js ")) return REDACTED_VALUE;
	try {
		const parsed = new URL(value);
		return parsed.username || parsed.password || parsed.search || parsed.hash ? REDACTED_VALUE : value;
	} catch {
		return REDACTED_VALUE;
	}
}
function redactArgs(value) {
	return value.length ? [REDACTED_VALUE] : [];
}
function restoreRedactedMap(incoming, current, field) {
	if (incoming === undefined) return undefined;
	const result = {};
	for (const [key, value] of Object.entries(incoming)) {
		if (value !== REDACTED_VALUE) setOwn(result, key, value);
		else if (current?.[field] && Object.hasOwn(current[field], key)) setOwn(result, key, current[field][key]);
		else throw new Error(`${field}.${key} 没有可保留的现有值`);
	}
	return result;
}
function restoreRedactedSpec(spec, current) {
	const restored = structuredClone(spec);
	if (restored.url === REDACTED_VALUE) {
		if (current.url === undefined) throw new Error("url 没有可保留的现有值");
		restored.url = current.url;
	}
	if (Array.isArray(restored.args)) {
		const redactedCount = restored.args.filter((value) => value === REDACTED_VALUE).length;
		if (redactedCount > 0) {
			if (restored.args.length !== 1 || redactedCount !== 1) throw new Error("敏感参数的保留原值标记不能与新参数混合；请完整重填参数");
			if (!Array.isArray(current.args)) throw new Error("args 没有可保留的现有值");
			restored.args = structuredClone(current.args);
		}
	}
	if (restored.headers !== undefined) restored.headers = restoreRedactedMap(restored.headers, current, "headers");
	if (restored.env !== undefined) restored.env = restoreRedactedMap(restored.env, current, "env");
	return restored;
}
function containsRedactedValue(value) {
	if (value === REDACTED_VALUE) return true;
	if (Array.isArray(value)) return value.some(containsRedactedValue);
	if (value && typeof value === "object") return Object.values(value).some(containsRedactedValue);
	return false;
}
// ---------- 更新提示（被动、可关闭、绝不自动更新） ----------
// 面板打开时客户端会调一次 updateHint：Host 每天最多向 GitHub Releases 发一次查询
// （进程内缓存），有新版时返回供面板显示可关闭的提示条。查询失败、超时、限流或
// 被 DSH_ARMORY_DISABLE_UPDATE_CHECK 禁用时静默无提示——这是有意设计：
// 更新提示是纯增值信息，不允许影响面板可用性；除这一条 GET 外不发送任何数据。
// 仓库指向本插件的上游 2026heshao/dsh-armory（fork 前是 Imzl-zl/dsh-mcp-manager-ui，
// 那条 URL 是上游的发布流，查它永远看不到本插件的版本，提示条会一直停在 1.6.0）。
const UPDATE_CHECK_URL = "https://api.github.com/repos/2026heshao/dsh-armory/releases/latest";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 5000;
const UPDATE_CHECK_DISABLED_ENV = "DSH_ARMORY_DISABLE_UPDATE_CHECK";
// 本插件的两个 profile 依赖名：1.9.0 改名后新名是 dsh-armory，旧名 dsh-skill-mcp-board
// 是「从旧版升级但还没删掉旧条目」的过渡态——installInfo 两行都查，命中哪行就报哪行。
const UPGRADE_PACKAGE_NAME = "dsh-armory";
const LEGACY_PACKAGE_NAME = "dsh-skill-mcp-board";
let updateCheckState = { checkedAt: 0, result: null };

function pluginVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "";
  } catch {
    return "";
  }
}

function compareVersions(left, right) {
  const a = String(left).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right).split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const delta = (a[i] || 0) - (b[i] || 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

// ── skill 查询：cwd + scope ──────────────────────────────────────────
// cwd 来自看板当前选中的作用域标签（全局 = undefined，项目 = wsPath）。
// scope 必须一并解析，否则看板会漏掉一半 skill：web-app 层把 host 平面的
// skill-filesystem 行禁用了（本地发现归 Agent 预设所有），每个预设各自挂一份
// skill-filesystem，它注册进**该预设自己的层**而不是全局层。只读全局层就只剩
// 自带的分发 skill，~/.agents/skills、~/.dsh/skills 这类用户级 skill 全部不可见。
//
// 走法与官方 SessionSkillCatalog.list 一致：看板没有会话，就退回预设注册表的
// 默认预设（新会话会用的那个），用 acquireScope(预设) 拿一份作用域租约，读完立刻
// 释放——仍是「会话视角」的读法，只是由默认预设代言。
async function withSkillScope(ctx, payload, run) {
	const registry = typeof ctx.get === "function" ? ctx.get("skills") : undefined;
	if (registry === undefined) return undefined;
	const rawPath = payload?.cwd === undefined ? payload?.wsPath : payload.cwd;
	const cwd = rawPath === undefined || rawPath === null || rawPath === "" ? undefined : canonicalWorkspacePath(String(rawPath));
	let lease;
	let scope = payload?.scope ?? undefined;
	if (scope === undefined) {
		// 有活 Agent 时首选它的预设；看板没有会话，退回默认预设。
		try {
			const presets = typeof ctx.get === "function" ? ctx.get("agentPresets") : undefined;
			const wanted = payload?.agentPreset ?? presets?.defaultId;
			if (wanted !== undefined && typeof presets?.acquireScope === "function") {
				lease = await presets.acquireScope(wanted);
				scope = lease?.key;
			}
		} catch {
			// 预设损坏 / 注册表缺席：退回全局层读法，看板照常可用，只是条目少一些。
			lease = undefined;
			scope = undefined;
		}
	}
	const options = { ...cwd === undefined ? {} : { cwd }, ...scope === undefined ? {} : { scope } };
	try {
		return await run(registry, options);
	} finally {
		const dispose = lease === undefined ? undefined : lease[Symbol.asyncDispose] ?? lease[Symbol.dispose];
		if (typeof dispose === "function") { try { await dispose.call(lease); } catch { /* 释放失败不影响本次读取结果 */ } }
	}
}

async function checkForUpdate(now = Date.now(), force = false) {
  const current = pluginVersion();
  if (process.env[UPDATE_CHECK_DISABLED_ENV]) return { current, updateAvailable: false, disabled: true };
  const cached = updateCheckState.result;
  if (!force && cached && now - updateCheckState.checkedAt < UPDATE_CHECK_INTERVAL_MS && cached.current === current) return cached;
  let latest = null;
  let url = null;
  try {
    const response = await fetch(UPDATE_CHECK_URL, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
    });
    if (response.ok) {
      const body = await response.json();
      if (typeof body?.tag_name === "string") latest = body.tag_name.replace(/^v/, "");
      if (typeof body?.html_url === "string") url = body.html_url;
    }
  } catch {
    // 离线/超时/限流：视作无新版，提示缺失比面板报错更可接受。
  }
  const result = { current, latest, url, updateAvailable: !!latest && compareVersions(latest, current) > 0 };
  updateCheckState = { checkedAt: now, result };
  return result;
}

// 凭据类失败（401/403 / 令牌解析失败 / OAuth 报错）与「进程起不来、网络不通」要分开说：
// 前者重连多少次都不会恢复，面板应显示「需授权」并把用户送去授权的入口。这条正则只用于
// 展示态的细分，不参与任何控制流；匹配不到就保持原本的「连接失败」。
const AUTH_FAILURE_RE = /(401|403|unauthori[sz]ed|forbidden|invalid[ _-]?token|access token|token parse|oauth|bearer|鉴权|认证|授权)/i;

function summarize(entry, inventory, managed, conflict = false, lastLog = null) {
	const live = entry.options.config;
	const raw = managed || live;
	const phase = entry.fiber == null ? "stopped" : PHASE_TEXT[entry.fiber.state] ?? "unknown";
	const transport = live.transport === "streamable-http" || live.transport === "http" ? "http" : live.transport === "stdio" ? "stdio" : "?";
	const toolCountAmbiguous = inventory.ambiguous.has(live.serverName);
	const row = { serverName: live.serverName, enabled: !entry.disabled, managed: !!managed, conflict, transport, phase, toolCount: inventory.counts[live.serverName] || 0, toolCountAmbiguous, toolRevision: inventory.revisions[live.serverName] || "", scope: "global" };
	for (const field of ["command", "cwd", "toolCallTimeoutMs", "failOnStartupError"]) if (raw[field] !== undefined) row[field] = raw[field];
	if (raw.url !== undefined) row.url = redactUrl(raw.url);
	if (raw.args !== undefined) row.args = redactArgs(raw.args);
	if (raw.env !== undefined) row.env = redactMap(raw.env);
	if (raw.headers !== undefined) row.headers = redactMap(raw.headers);
	if (raw.reconnect !== undefined) row.reconnect = structuredClone(raw.reconnect);
	row.status = deriveMcpPhase(row, lastLog);
	row.lastError = row.status !== "failed" ? null : lastLog && (lastLog.type === "error" || lastLog.type === "warn")
		? sanitizeMcpLog(lastLog.text)
		: "MCP 未注册任何工具：连接失败或 tools/list 同步失败";
	// 401/403 这类失败重连不会恢复：面板据此把「连接失败」细分成「需授权」。
	row.authRequired = row.status === "failed" && AUTH_FAILURE_RE.test(`${row.lastError || ""} ${lastLog?.text || ""}`);
	return row;
}
// 项目 MCP 的行状态：与全局 summarize() 走**同一套规则、同一个判定函数**（deriveMcpPhase），
// 不再另写一套。「已连接」的唯一证据是工具数；连接态本身取自 cordis fiber 的状态代号
// （mcp-client 的 apply 要等首次连接与 tools/list 结束才让 fiber ACTIVE，所以 ACTIVE + 0 工具
// 已经是不可用的终态证据），而不是去猜 mcp-client 的日志文案；日志只用来填 lastError 的
// 具体原因。挂载失败（我们自己 setup 阶段就挂不上：配置求值为空、工具注册被拒）与连接
// 失败（mcp-client 那边的事）分开标记，不混为一谈。
function summarizeWorkspaceRow(ctx, wsPath, server, mountError) {
	// 诊断通路就在这里被依赖，就在这里确保开着（按 root 幂等，与全局 list/status 同一份）。
	ensureLogCapture(ctx);
	const row = workspaceServerView(server);
	if (server.disabled) { row.status = "disabled"; row.phase = "stopped"; return row; }
	const conn = workspaceConnectionStatus(ctx, wsPath, server);
	row.refs = conn.refs;
	row.toolCount = conn.schemas.length;
	// 与全局行同一个含义：工具清单的指纹，客户端据此刷新详情里的工具列表。
	row.toolRevision = conn.schemas.length ? revisionOf(conn.schemas.map(projectToolSchema)) : "";
	// 没有共享连接在跑 = 没有 fiber，与全局「条目未加载」同义。
	row.phase = conn.fiberState === undefined ? "stopped" : PHASE_TEXT[conn.fiberState] ?? "unknown";
	const lastLog = lastLogFor(ctx, server.name);
	if (mountError !== undefined) {
		row.status = "failed";
		row.phase = "failed";
		row.mountFailed = true;
		row.lastError = mountError;
	} else if (conn.scopeError) {
		// 作用域故障：连接可能完全正常，只是工具不在共享作用域层。必须比「0 工具 → 连接失败」
		// 更具体，否则用户会去查 MCP 配置，而根因在 DSH 依赖树。
		row.status = "failed";
		row.phase = "failed";
		row.scopeFailed = true;
		row.lastError = conn.scopeError;
	} else {
		row.status = deriveMcpPhase(row, lastLog);
		row.lastError = row.status !== "failed" ? null : lastLog && (lastLog.type === "error" || lastLog.type === "warn")
			? sanitizeMcpLog(lastLog.text)
			: "MCP 未注册任何工具：连接失败或 tools/list 同步失败";
	}
	// 同名不再等于冲突：DSH 0.1.5 起 mcp-client 按注册作用域判 serverName 唯一性
	// （`scopeOf(ctx) ?? ctx.root`），而本插件给每个 (项目, serverName) 一个独立作用域，
	// 所以全局与项目之间、项目与项目之间同名都是合法的（实测：同一作用域内仍会被拒绝）。
	// 这里如实带上「还有谁同名」作为诊断事实，但只有这份连接本身失败时才把它写成原因，
	// 否则在 0.1.5 上就是拿一条健康的连接报假错。
	if (conn.duplicateOwners.length) {
		row.duplicateOwners = conn.duplicateOwners;
		if (row.mountFailed || row.status === "failed") {
			const notice = `serverName "${server.name}" 也被以下项目使用：${conn.duplicateOwners.join("、")}。DSH 0.1.5 起各注册作用域可独立使用同名；更早的版本按全进程唯一判定，同名会启动失败。`;
			row.lastError = row.lastError ? `${notice}；${row.lastError}` : notice;
		}
	}
	row.authRequired = row.status === "failed" && !row.mountFailed && !row.scopeFailed
		&& AUTH_FAILURE_RE.test(`${row.lastError || ""} ${lastLog?.text || ""}`);
	return row;
}
// Fingerprint the exact redacted wire projection. Keeping a manual field list here
// would create a second source of truth and let newly projected fields go stale.
function listRevision(servers) {
	return revisionOf(servers);
}
function normalizeOne(spec) {
	return normalizeMcpImport({ mcpServers: { [spec.name]: spec } }).servers[0];
}
function reservedEntryIds(ctx, releasedIds = new Set()) {
	const ids = [];
	for (const entry of ctx.loader.entries()) {
		const id = entry.options.id;
		if (typeof id === "string" && !releasedIds.has(id)) ids.push(id);
	}
	return ids;
}
// 原始导入 payload → 可落盘的 spec 集合。粘贴入口只从这里过，准入规则（唯一性、总值表达式）
// 只写在 import-admission.js 里，不在调用点重复。
function admittedImport(input) {
	return admitImportedServers(normalizeMcpImport(input));
}
// 预览的唯一实现：全局与项目只差「冲突从哪来」这一项输入。`removed` 一律按「现有 − 导入」算，
// 所以两个作用域不可能再给出不一致的"移除"清单（项目替换曾恒报"移除：无"、却在真删条目）。
function mergePreview(existingServers, normalized, conflicts = []) {
	const existingNames = new Set(existingServers.map((server) => server.name));
	const incomingNames = new Set(normalized.servers.map((server) => server.name));
	return {
		warnings: normalized.warnings,
		added: normalized.servers.filter((server) => !existingNames.has(server.name)).map((server) => server.name),
		updated: normalized.servers.filter((server) => existingNames.has(server.name)).map((server) => server.name),
		removed: existingServers.filter((server) => !incomingNames.has(server.name)).map((server) => server.name),
		conflicts,
	};
}
// 「同名，但占位的不是我管理的那个 entry」= 来自其他 bundle / Agent preset。它们的条目不在本
// patch 文件里，所以"跳过"既不会覆盖也不会删掉它们；反过来硬写下去就是同作用域重名，宿主加载
// 时会直接抛。取舍因此与批内重名一致：跳过这一条、导入其余，并把原因带进预览与结果提示。
function externalConflictNames(ctx, state, normalized) {
	const liveByName = new Map();
	for (const entry of externalMcpEntries(ctx, state)) {
		const name = entry.options.config.serverName;
		if (!liveByName.has(name)) liveByName.set(name, []);
		liveByName.get(name).push(entry);
	}
	return normalized.servers.filter((server) => {
		const live = liveByName.get(server.name) || [];
		const managedId = state.entryIds.get(server.name);
		return live.length > 0 && (!managedId || live.some((entry) => entry.options.id !== managedId));
	}).map((server) => server.name);
}
function resolveManagedImport(ctx, state, normalized) {
	const conflicts = externalConflictNames(ctx, state, normalized);
	if (!conflicts.length) return { importable: normalized, conflicts };
	const blocked = new Set(conflicts);
	return {
		importable: {
			...normalized,
			servers: normalized.servers.filter((server) => !blocked.has(server.name)),
			warnings: [...normalized.warnings, `已跳过被其他配置层占用的同名 MCP：${conflicts.join('、')}`],
		},
		conflicts,
	};
}
function importPreview(ctx, normalized, state) {
	const { importable, conflicts } = resolveManagedImport(ctx, state, normalized);
	return mergePreview(state.servers, importable, conflicts);
}
// 「跳过」必须在结果里说出来：否则用户只会觉得"我明明选了它"。
function withSkipped(note, names) {
	const unique = [...new Set(names)];
	return unique.length ? `${note}（跳过 ${unique.length} 条同名条目：${unique.join('、')}）` : note;
}

// ---------- 本机客户端来源导入 ----------
// Host 侧唯一的「读本机文件」通路：路径只在来源表里拼，这里只负责大小拦截与读取。
// 浏览器永远不传路径进来，所以接口面不会退化成「读任意文件」。
async function readSourceText(path, maxBytes) {
	const info = await stat(path);
	if (info.size > maxBytes) throw Object.assign(new Error(`来源文件超过上限：${path}`), { code: "CODE_TOO_LARGE" });
	return readFile(path, "utf8");
}
// wsPath 同时是「扫描上下文」与「写入目标」：全局标签没有 cwd，项目标签带着它，
// 与 previewImport / previewWorkspaceImport 的既有分工保持一致。
// `layer` 也在这里一次推出：它对「扫哪些来源」与「能不能导」必须是同一个值，两处各自推导就会漂移。
function sourceContext(wsPath) {
	return { home: homedir(), platform: process.platform, env: process.env, cwd: wsPath || undefined, layer: wsPath ? "project" : "global" };
}
// 与列表投影共用同一套掩码规则，这里只报字段名：用户在导入前需要知道来源带凭据，
// 但具体值一律不出 Host（要看真实值得走 reveal）。
function maskedSourceFields(spec) {
	const fields = [];
	if (spec.url !== undefined && redactUrl(spec.url) === REDACTED_VALUE) fields.push("url");
	if (Array.isArray(spec.args) && spec.args.length) fields.push("args");
	if (spec.env && Object.keys(spec.env).length) fields.push("env");
	if (spec.headers && Object.keys(spec.headers).length) fields.push("headers");
	return fields;
}
function selectSourceServers(row, names) {
	let wanted = null;
	if (names !== undefined) {
		if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) throw new Error("导入条目名必须是字符串数组");
		wanted = new Set(names);
		const unknown = [...wanted].filter((name) => !row.entries.some((entry) => entry.name === name && !entry.error));
		if (unknown.length) {
			// OPT-17：这个名字可能真在这份配置里，只是 `${input:}` 落在 url/command 上、
			// 位置剔不掉而整条降级。此时再说「来源中没有」会把用户送去改一个没写错的地方，
			// 所以按 `unsupportedEntries` 把两边分开报（两个集合互斥：一个条目只会进其中一边）。
			const blocked = new Set((row.unsupportedEntries ?? []).map((entry) => entry.name));
			const interactive = unknown.filter((name) => blocked.has(name));
			if (interactive.length) {
				const absent = unknown.filter((name) => !blocked.has(name));
				throw new Error(`以下 MCP 需要交互取值，DSH 无法导入：${interactive.join(", ")}${
					absent.length ? `；另有不存在的条目：${absent.join(", ")}` : ""}`);
			}
			throw new Error(`来源中没有可导入的 MCP：${unknown.join(", ")}`);
		}
	}
	const served = row.entries.filter((entry) => !entry.error && (wanted === null || wanted.has(entry.name)));
	if (!served.length) throw new Error("没有选中任何可导入的 MCP");
	// 提示只跟选中的条目走：没勾的条目（例如 Codex 的 enabled_tools）不该出现在这次预览里。
	const warnings = [...row.warnings, ...served.flatMap((entry) => entry.warnings || [])];
	// 选中的条目就是这次要落盘的那一份，先过准入，缺值提示才算在"真要写下去"的值上。
	const admitted = admitImportedServers({ servers: served.map((entry) => entry.spec), warnings });
	const missing = [...new Set(admitted.servers.flatMap((spec) => missingEnvNames(spec, process.env)))];
	return {
		servers: admitted.servers,
		// 用 admitted.warnings（= 来源级 + 选中条目级 + 准入产生的同名跳过说明），不要再拼一遍
		// 上面的局部数组，否则刚加进去的跳过说明会被这里丢掉。
		warnings: [...admitted.warnings, ...missing.map((name) => `环境变量 ${name} 当前未设置或为空，导入后该处会得到空值`)],
		skipped: admitted.skipped,
	};
}
// 扫描结果回浏览器的唯一边界。这里刻意只发界面真会渲染的字段（键集由
// `test/host-import-sources.test.mjs` 钉死）：多带一个字段就多一个泄密面，
// 而条目本体（含 `!!js` 表达式与字面密钥）永远不出 Host。
function projectSourceRow(row) {
	return {
		key: row.key,
		sourceId: row.sourceId,
		label: row.label,
		scope: row.scope,
		displayPath: row.displayPath,
		error: row.error,
		// 界面上的「N 条提示」是来源级 + 条目级的合计；条目级提示另挂在条目上，
		// 供预览只汇总选中条目的提示。
		warnings: [...row.warnings, ...row.entries.flatMap((entry) => entry.warnings || [])],
		entries: row.entries.map((entry) => ({
			name: entry.name,
			error: entry.error,
			maskedFields: entry.spec ? maskedSourceFields(entry.spec) : [],
			missingEnv: entry.spec ? missingEnvNames(entry.spec, process.env) : [],
		})),
		// OPT-17：`${input:}` 的位置不可剔时，那条会整条降级、不进 `entries`，只在
		// `unsupportedEntries` 里留一份可展示信息。不透出来的话，界面只能笼统说「这里
		// 没有可导入的 MCP」，用户看不出是「有 N 条需要交互取值」。仍只发最小的四个键：
		// name/transport 是标签，reason 是已经写好、可直接渲染的说明，names 是占位符名
		// （名字不是密钥）；条目本体 `spec` 不出去，泄漏面不扩大。
		// `?? []` 是给没挂这个字段的 row 兜底，避免投影本身抛错。
		unsupportedEntries: (row.unsupportedEntries ?? []).map((entry) => ({
			name: entry.name,
			transport: entry.transport,
			reason: entry.reason,
			names: entry.names ?? [],
		})),
	};
}
// 来源层与导入目标必须同一层，否则报错。「看到的来源 == 会写进去的那一层」这条不变量
// 在这里强制：客户端只是跟着显示（全局标签只列全局来源），不靠 UI 拦截。
function assertSourceLayer(layer, scope) {
	if (scope === layer) return;
	throw new Error(layer === "project"
		? "来源层级与导入目标不一致：项目标签只能导入该项目的项目级来源"
		: "来源层级与导入目标不一致：全局标签只能导入全局来源");
}
// 全局导入的写盘路径：粘贴 JSON 与本机客户端来源共用它，准入、同名跳过与 entry id 预留只写一份。
async function applyManagedImport(ctx, normalized, mode) {
	// 写盘口自己再准入一次（幂等）：不依赖调用方记得做，以后新增的入口也过不去。
	const admitted = admitImportedServers(normalized);
	return withPatchWrite(ctx, async () => {
		const state = await managedState(ctx);
		// 与预览走同一条解析：同名冲突在这里只影响"写哪几条"，不再让整批失败。
		const { importable, conflicts } = resolveManagedImport(ctx, state, admitted);
		const preview = mergePreview(state.servers, importable, conflicts);
		const releasedNames = mode === "replace" ? state.servers.map((server) => server.name) : preview.updated;
		const releasedIds = new Set(releasedNames.map((name) => state.entryIds.get(name)).filter(Boolean));
		await writePatch(state, updateManagedMcpPatch(state.content, importable.servers, { replace: mode === "replace", reservedIds: reservedEntryIds(ctx, releasedIds) }));
		return {
			added: preview.added,
			updated: preview.updated,
			removed: mode === "replace" ? preview.removed : [],
			warnings: preview.warnings,
			note: withSkipped(mode === "replace" ? "已替换当前 profile 管理的 MCP 配置" : "已合并 MCP 配置", [...admitted.skipped, ...conflicts]),
		};
	});
}
function workspaceImportPreview(config, normalized) {
	// 项目导入没有「跨配置层同名冲突」这一说：官方按注册作用域判重，不同作用域同名合法；
	// 只有全局导入路径（importPreview）要处理外部 bundle/preset 占用的同名（跳过并提示）。
	return mergePreview(config.servers, normalized);
}
// 项目导入的写盘路径，同样是粘贴 JSON 与来源导入共用。
// 写盘之后、**锁外**对齐连接。两件事必须这样安排：
//   1. reconcile 会 await 整条 teardown（dsh-scope 释放 + mcp-client 子进程关闭），放进写锁里会让
//      「移除一个卡住的 server」把该项目之后的每一次保存都一起卡住；
//   2. 它的失败不该把一个**已经落盘**的写报成失败 —— 写是既成事实，对齐失败只意味着"没立刻生效"。
//      所以吞成日志，不吞事实（面板按真实连接态显示）。
// **注意这里没有"下次挂载会重试"这条兜底**：挂载路径只遍历配置里**现存**的 server，所以
// 「新增/改配置」在下一次会话挂载时确实会被重新对齐，但**被删除**的 server 不在任何后续挂载里，
// 而 reconcile 是唯一会回收"配置里已不存在"的连接的路径 —— 对齐失败时它会留到空闲超时或卸载。
// 这是有意的取舍（写已经成功，不该因为一次 teardown 失败就报错），所以日志要如实说清后果。
async function alignWorkspaceConnections(ctx, wsPath) {
	try { await reconcileWorkspaceConnections(ctx, wsPath); }
	catch (error) { ctx.logger?.error?.(`mcp-manager: 项目 MCP 配置已写入，但对齐连接失败（下次会话挂载会重新对齐现存条目；若本次是删除，该连接要等空闲超时或插件卸载才回收）: ${error?.message ?? error}`); }
}
async function applyWorkspaceImport(ctx, wsPath, normalized, mode) {
	// 同 applyManagedImport：写盘口自己准入，唯一的写盘路径因此不可能写出重名集合。
	const admitted = admitImportedServers(normalized);
	const result = await withWorkspaceWrite(wsPath, async () => {
		const config = await readWorkspaceConfigCached(ctx, wsPath);
		if (config.error) throw new Error(config.error);
		const preview = workspaceImportPreview(config, admitted);
		let servers;
		if (mode === "replace") {
			servers = admitted.servers.slice();
		} else {
			const byName = new Map(config.servers.map((server) => [server.name, server]));
			for (const server of admitted.servers) byName.set(server.name, server);
			servers = [...byName.values()];
		}
		await writeWorkspaceConfigFile(wsPath, servers, config.exclude);
		return {
			added: preview.added,
			updated: preview.updated,
			removed: preview.removed,
			warnings: preview.warnings,
			note: withSkipped(mode === "replace" ? "已替换项目 MCP 配置" : "已合并项目 MCP 配置", admitted.skipped),
		};
	});
	// 导入同样是写盘：就地对齐存活会话（新增即挂、删除即撤、改动即重载）——但在锁外做。
	await alignWorkspaceConnections(ctx, wsPath);
	return result;
}

// ---------- workspace 项目层展示与校验 ----------
// 内部 spec 的 `!!js` 表达式 → 文件中的 `${VAR}` 模板形式；还原失败时原样返回（只影响展示，不落盘）。
function restoreTemplate(value) {
	if (typeof value !== "string" || !value.startsWith("!!js ")) return value;
	try { return jsExpressionToTemplate(value); } catch { return value; }
}
// ---------- 读「有效运行值」（详情页的眼睛）----------
// loader 把 `!!js` 表达式以 raw 形式留在 `entry.options.config`（官方为了写回保留 `!!js`
// 形式），到 apply 之前才用 loader 自己的 interpolate 求值。所以要把「解析后的值」显示出来
// 必须求值一次，而且必须用 entry 自己的 ctx——表达式可以引用该行 inject 的服务（官方用例：
// `!!js ctx.phaseOne.value`）。直接把 raw 当解析结果返回，对象就会序列化成 "[object Object]"。
const resolveLiveConfigValue = (entry, value) => interpolate(entry.ctx, value);
// 项目 spec 的字段值（内部 `!!js` 表达式）→ 有效运行值；与 `toMcpClientConfig` 用同一个求值器。
function resolveSpecValue(value, env) {
	if (typeof value === "string") return evaluateEnvExpression(value, env);
	if (Array.isArray(value)) return value.map((item) => resolveSpecValue(item, env));
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveSpecValue(item, env)]));
	return value;
}

function workspaceServerView(server) {
	const row = {
		serverName: server.name,
		enabled: !server.disabled,
		managed: true,
		conflict: false,
		transport: server.transport === "stdio" ? "stdio" : "http",
		phase: "stopped",
		toolCount: 0,
		toolCountAmbiguous: false,
		toolRevision: "",
		status: "stopped",
		lastError: null,
		scope: "workspace",
	};
	// 展示层把内部 `!!js` 表达式还原为文件中的 `${VAR}` 模板，避免向用户泄漏内部表示；
	// 提交时 normalizeEntry 会再转回内部形式，roundtrip 可逆。
	// 这份投影必须覆盖"编辑表单不渲染但必须原样带回"的字段（idleTimeoutMs/readyTimeoutMs），
	// 否则用户编辑一次就把它们抹掉 —— 表单是重建 spec，不是增量改 spec。
	for (const field of ["command", "cwd", "toolCallTimeoutMs", "failOnStartupError", "idleTimeoutMs", "readyTimeoutMs"]) if (server[field] !== undefined) row[field] = restoreTemplate(server[field]);
	if (server.url !== undefined) row.url = restoreTemplate(redactUrl(server.url));
	if (server.args !== undefined) row.args = redactArgs(server.args);
	if (server.env !== undefined) row.env = redactMap(server.env);
	if (server.headers !== undefined) row.headers = redactMap(server.headers);
	if (server.reconnect !== undefined) row.reconnect = structuredClone(server.reconnect);
	return row;
}
// 这里不再有「serverName 全进程唯一」的校验函数：那是 DSH 0.1.0-rc.7 时期 mcp-client 的行为
// （它把注册表挂在 ctx.root 上）。0.1.5 起官方按注册作用域判重，而本插件给每个
// (项目, serverName) 一个独立作用域，所以跨项目、全局与项目之间同名都是合法配置。
// 仍然成立的唯一约束是同一作用域内不得重名：项目内同名会静默覆盖 mcpServers 的对象键，
// 由各写入路径自己校验；全局重名由 profile patch 的条目 id 承担。


// ── 工具裁缝（Tool Tailor）：工具使用账本 ─────────────────────────────
// 数据源与合并口径见 tool-ledger.js 头注。这里只负责从宿主运行态取三路输入：
//   1) 全局 MCP 服务器名与禁用状态（loader 条目）；
//   2) 项目 MCP 服务器名与禁用状态（各工作区 .dsh/mcp.json，只读）；
//   3) 当前注册表里的全部工具 Schema（ctx.tools.schemas()，全局 + 项目 + 内置）。
// 只读操作：不写任何配置、不碰会话目录。禁用/启用动作复用下方既有的 disable/enable。
// P2-1：账本缓存。30 天口径在本机实测 1.7s（6542 条事件），而看板每次挂载、每次切
// 天数都会重扫一遍；5 分钟内同 days 直接回上次结果。并发首次调用共享同一条扫描
// （看板与 toolTailor 页可能同时挂载），避免同一份日志被解两遍。
// days 在这里收敛到 [1,365]：缓存键就是 days，不能让 0 / 负数 / 超大值各自成键。
const TAILOR_CACHE_TTL = 5 * 60 * 1000;
const tailorCache = new Map(); // days -> { at, report }
const tailorInFlight = new Map(); // days -> Promise<report>
async function buildToolTailorReport(ctx, payload) {
	const days = Math.min(365, Math.max(1, Math.trunc(Number(payload?.days) || 30)));
	const refresh = payload?.refresh === true;
	if (!refresh) {
		const hit = tailorCache.get(days);
		if (hit && Date.now() - hit.at < TAILOR_CACHE_TTL) return hit.report;
		const pending = tailorInFlight.get(days);
		if (pending) return pending;
	}
	const task = scanToolTailor(ctx, days)
		.then((report) => {
			tailorCache.set(days, { at: Date.now(), report });
			return report;
		})
		.finally(() => {
			if (tailorInFlight.get(days) === task) tailorInFlight.delete(days);
		});
	tailorInFlight.set(days, task);
	return task;
}

/** 真正干活的那次扫描（缓存旁路 / 未命中时调用）。 */
async function scanToolTailor(ctx, days) {
	const mcpServerNames = [];
	const disabledServers = new Set();
	for (const entry of allMcpEntries(ctx)) {
		const name = entry.options.config.serverName;
		if (!mcpServerNames.includes(name)) mcpServerNames.push(name);
		if (entry.disabled === true) disabledServers.add(name);
	}
	// 项目级服务器不在 loader 里（挂在共享作用域层），但工具名同样是 mcp__<server>__<tool>，
	// 归属判定必须把它们也算进去，否则项目工具会被误判成内置工具。
	for (const record of await listWorkspaceRecords(ctx)) {
		try {
			const config = await readWorkspaceConfigCached(ctx, record.path);
			if (config.error || config.missing) continue;
			for (const server of config.servers) {
				if (!mcpServerNames.includes(server.name)) mcpServerNames.push(server.name);
				if (server.disabled === true) disabledServers.add(server.name);
			}
		} catch {
			// 单个工作区配置读不了不挡全局账本。
		}
	}
	const schemas = [...ctx.tools.schemas()].map(projectToolSchema);
	const report = await scanSessionLedger({ days, mcpServerNames, schemas, disabledServers });
	return attachRegisteredSkills(ctx, report);
}

/**
 * §6.4 技能账本的第二半：把「注册表里存在」与「日志里真的被调用过」合起来。
 *
 * 只看日志能回答「谁被用了」，但回答不了最要紧的那一问——**注册了却一次没被用过的是哪些**。
 * 那一问的答案正是「该不该留」的依据（本机实测 32 个技能里 21 个一次没调用过），而这批名字
 * 只能来自 `ctx.skills` 注册表。scope 解析复用看板那条 `withSkillScope`（默认预设代言），
 * 免得这里另写一套、漏掉预设层的发现范围。
 *
 * 注册表缺席时（老宿主 / 预设层没挂 skill-filesystem）**不伪造 0**：把
 * `skillsRegistryAvailable` 置 false、`skillNeverUsedCount` 置 null，界面据此只说
 * 「日志里出现过的技能」，而不是暗示「其余技能都没被用过」——后者会是一句假话。
 */
async function attachRegisteredSkills(ctx, report) {
	const observed = Array.isArray(report?.skills) ? report.skills : [];
	let registered = [];
	try {
		const listed = await withSkillScope(ctx, {}, async (registry, options) => {
			if (typeof registry.list !== "function") return undefined;
			return registry.list(options);
		});
		if (Array.isArray(listed)) {
			registered = listed.filter((skill) => typeof skill?.name === "string" && skill.name !== "");
		}
	} catch {
		// 注册表读不了不挡工具账本：技能那一节退化为「只有日志里出现过的」。
	}
	const available = registered.length > 0;
	const registeredNames = new Set(registered.map((skill) => skill.name));
	const observedNames = new Set(observed.map((skill) => skill.name));
	// 禁用/释放按钮需要的三个判定字段跟着注册表行走：path/source 决定「能不能写」
	// （白名单口径见 lib/skill-disable.js），disabled 直接读宿主解析出的 invocation 位。
	// 未注册的行（注册表缺席 / 已卸载技能的历史调用）不带这些字段——客户端不给它出按钮。
	const control = (skill) => {
		if (!skill) return {};
		return {
			disabled: skill.invocation?.modelInvocable === false,
			...(typeof skill.path === "string" && skill.path ? { path: skill.path } : {}),
			...(typeof skill.source === "string" && skill.source ? { source: skill.source } : {}),
		};
	};
	const registeredByName = new Map(registered.map((skill) => [skill.name, skill]));
	const merged = available
		? [
				...observed.map((skill) => ({ ...skill, registered: registeredNames.has(skill.name), ...control(registeredByName.get(skill.name)) })),
				...registered
					.filter((skill) => !observedNames.has(skill.name))
					.map((skill) => ({
						name: skill.name,
						calls: 0,
						errors: 0,
						errorRate: 0,
						firstUsedMs: null,
						lastUsedMs: null,
						registered: true,
						...control(skill),
					})),
			].sort((a, b) => (b.calls - a.calls) || String(a.name).localeCompare(String(b.name)))
		: observed.map((skill) => ({ ...skill, registered: null }));
	return {
		...report,
		skills: merged,
		skillsRegistryAvailable: available,
		skillRegisteredCount: available ? registered.length : null,
		// 「一次没被调用」只在注册表可用时才有意义（否则分母本身是未知的）。
		skillNeverUsedCount: available ? merged.filter((skill) => skill.calls === 0).length : null,
		skillCount: merged.length,
	};
}

// 全局 MCP 列表核心（list / getWorkspaceView 共用）。
async function listMcpServers(ctx) {
	ensureLogCapture(ctx);
	const state = await managedState(ctx);
	const inventory = toolInventory(ctx);
	const groups = new Map();
	for (const entry of allMcpEntries(ctx)) {
		const name = entry.options.config.serverName;
		if (!groups.has(name)) groups.set(name, []);
		groups.get(name).push(entry);
	}
	const servers = [];
	for (const [name, entries] of groups) {
		const profileId = state.entryIds.get(name);
		const entry = entries.find((candidate) => candidate.options.id === profileId) || entries[0];
		const conflict = entries.length > 1;
		const managed = !conflict && entry.options.id === profileId ? state.byName.get(name) : null;
		servers.push(summarize(entry, inventory, managed, conflict, lastLogFor(ctx, name, entry.fiber)));
	}
	return {
		servers,
		revision: listRevision(servers),
		revealRevision: revealRevision(state, groups),
	};
}

// ── 装备清单：本机条目收集（只读，只投影身份字段）────────────────────────
// 导出与导入对比共用这一份收集逻辑，避免两个入口对「本机装了什么」给出不同答案。
// 绝不把 env / headers 的值带出去：MCP 只保留键名，技能只保留名称与来源，
// 专家从 profile 补丁的召唤预设读 plugin、从目录缓存补展示名，插件读安装账本。
function endpointHostOf(value) {
	if (typeof value !== "string" || !value) return "";
	try {
		return new URL(value).host || "";
	} catch {
		return "";
	}
}

async function collectLoadoutItems(ctx) {
	const items = [];
	let records = [];
	try {
		const state = await readInstallState();
		records = Array.isArray(state?.items) ? state.items : [];
	} catch {
		// 账本读不到仍然可以导出 MCP / 技能 / 专家；插件条目会缺，但不该整单失败。
	}

	// 1) MCP：以真实注册表为准；连接器账本用于补来源，名称对不上时保留账本条目。
	try {
		const { servers } = await listMcpServers(ctx);
		const connectorByName = new Map();
		for (const record of records) {
			if (record?.kind !== "connector") continue;
			const key = String(record.key || "").trim();
			if (key) connectorByName.set(key, record);
			const rowName = String(record.name || "").trim();
			if (rowName) connectorByName.set(rowName, record);
		}
		const seen = new Set();
		for (const server of servers) {
			const name = String(server?.serverName || "").trim();
			if (!name) continue;
			seen.add(name);
			const connector = connectorByName.get(name);
			const configKeys = [
				...Object.keys(server.env || {}),
				...Object.keys(server.headers || {}),
			].filter(Boolean);
			const endpointHost = endpointHostOf(server.url);
			items.push({
				kind: "mcp",
				name,
				...(server.transport ? { transport: server.transport } : {}),
				source: connector ? `connector:${connector.key}` : "manual",
				...(endpointHost ? { endpointHost } : {}),
				...(configKeys.length ? { configKeys: [...new Set(configKeys)] } : {}),
				...(typeof server.enabled === "boolean" ? { enabled: server.enabled } : {}),
			});
		}
		for (const record of records) {
			if (record?.kind !== "connector") continue;
			const key = String(record.key || "").trim();
			const name = String(record.name || key).trim();
			if (!name || seen.has(name) || (key && seen.has(key))) continue;
			seen.add(name);
			items.push({ kind: "mcp", name, source: `connector:${key || name}` });
		}
	} catch {
		// MCP 注册表不可用时跳过这一组，其余组照常导出。
	}

	// 2) 技能：宿主 skill 注册表的全局视图；账本用于补市场来源与版本。
	try {
		const ledger = new Map();
		for (const record of records) {
			if (record?.kind === "skill") ledger.set(String(record.key || ""), record);
		}
		await withSkillScope(ctx, { scope: "global" }, async (registry, options) => {
			if (typeof registry.list !== "function") return;
			const rows = await registry.list(options);
			for (const skill of rows) {
				const name = String(skill?.name || "").trim();
				if (!name) continue;
				const record = ledger.get(name);
				items.push({
					kind: "skill",
					name,
					source: String(record?.source?.marketplace || skill.source || "local"),
					...(record?.version ? { version: String(record.version) } : {}),
				});
			}
		});
	} catch {
		// 宿主没挂 skill 注册表时跳过技能组。
	}

	// 3) 专家：profile 补丁里的召唤预设 + 目录缓存补展示名 / 更新时间。
	try {
		const patch = await readPatch(ctx);
		const expertApi = await loadExpert();
		const presets = expertApi.readExpertPresets(patch.content);
		let experts = [];
		try {
			const catalog = await expertApi.wbExpertCatalog();
			experts = Array.isArray(catalog?.experts) ? catalog.experts : [];
		} catch {
			// 目录拉不到就退回 plugin id 作名称。
		}
		const byPlugin = new Map(experts.map((expert) => [String(expert.plugin || ""), expert]));
		for (const preset of presets) {
			const plugin = String(preset?.plugin || "").trim();
			if (!plugin) continue;
			const expert = byPlugin.get(plugin);
			items.push({
				kind: "expert",
				name: String(expert?.name || plugin),
				plugin,
				source: "workbuddy-expert",
				...(expert?.updatedAt ? { updatedAt: String(expert.updatedAt) } : {}),
			});
		}
	} catch {
		// 没有 profile 补丁（或读不到）时跳过专家组。
	}

	// 4) 插件：只有客户端在安装成功后回写的账本知道装了什么。
	for (const record of records) {
		if (record?.kind !== "plugin") continue;
		const key = String(record.key || "").trim();
		const name = String(record.name || key).trim();
		if (!name) continue;
		items.push({
			kind: "plugin",
			name,
			...(key ? { key } : {}),
			source: String(record.source?.marketplace || ""),
			...(record.version ? { version: String(record.version) } : {}),
		});
	}

	return items;
}

let McpManagerGateway = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _list_decorators, _status_decorators, _enable_decorators, _disable_decorators, _reconnect_decorators, _tools_decorators, _add_decorators, _update_decorators, _remove_decorators, _reveal_decorators, _previewImport_decorators, _importJson_decorators, _listWorkspaces_decorators, _getWorkspaceView_decorators, _wbSessionWorkspace_decorators, _addWorkspaceServer_decorators, _updateWorkspaceServer_decorators, _removeWorkspaceServer_decorators, _setWorkspaceExclude_decorators, _previewWorkspaceImport_decorators, _importWorkspaceJson_decorators, _revealWorkspaceServer_decorators, _projectConnections_decorators, _reconnectWorkspaceServer_decorators, _updateHint_decorators, _whatsNew_decorators, _scanImportSources_decorators, _previewImportSource_decorators, _importSource_decorators, _toolTailor_decorators, _wbConnectorCatalog_decorators, _wbConnectorCachedCount_decorators, _wbConnectorIcon_decorators, _wbConnectorPreview_decorators, _wbConnectorInstall_decorators, _wbOAuthBegin_decorators, _wbOAuthPoll_decorators, _wbOAuthCancel_decorators, _wbOAuthToken_decorators, _wbOAuthOverview_decorators, _wbOAuthRefresh_decorators, _wbOAuthOpen_decorators, _wbSkillCatalog_decorators, _wbSkillDetail_decorators, _wbSkillInstall_decorators, _wbSkillUninstall_decorators, _wbSkillInstalled_decorators, _wbMarketRegistry_decorators, _wbMarketRegistryUpsert_decorators, _wbInstallState_decorators, _wbInstallStateRecord_decorators, _wbInstallStateForget_decorators, _wbAwesomeCatalog_decorators, _wbAwesomeDetail_decorators, _wbAwesomeReadme_decorators, _wbAwesomeUpdateCheck_decorators, _wbRepoMeta_decorators, _wbNpmDownloads_decorators, _wbLoadoutExport_decorators, _wbLoadoutDiff_decorators;
	return class McpManagerGateway extends _classSuper {
		static {
			const _metadata = typeof Symbol === "function" && Symbol.metadata ? Object.create(_classSuper[Symbol.metadata] ?? null) : void 0;
			_list_decorators = [Remote("list")];
			__esDecorate(this, null, _list_decorators, { kind: "method", name: "list", static: false, private: false, access: { has: (obj) => "list" in obj, get: (obj) => obj.list }, metadata: _metadata }, null, _instanceExtraInitializers);
			_status_decorators = [Remote("status")];
			__esDecorate(this, null, _status_decorators, { kind: "method", name: "status", static: false, private: false, access: { has: (obj) => "status" in obj, get: (obj) => obj.status }, metadata: _metadata }, null, _instanceExtraInitializers);
			_enable_decorators = [Remote("enable")];
			__esDecorate(this, null, _enable_decorators, { kind: "method", name: "enable", static: false, private: false, access: { has: (obj) => "enable" in obj, get: (obj) => obj.enable }, metadata: _metadata }, null, _instanceExtraInitializers);
			_disable_decorators = [Remote("disable")];
			__esDecorate(this, null, _disable_decorators, { kind: "method", name: "disable", static: false, private: false, access: { has: (obj) => "disable" in obj, get: (obj) => obj.disable }, metadata: _metadata }, null, _instanceExtraInitializers);
			_reconnect_decorators = [Remote("reconnect")];
			__esDecorate(this, null, _reconnect_decorators, { kind: "method", name: "reconnect", static: false, private: false, access: { has: (obj) => "reconnect" in obj, get: (obj) => obj.reconnect }, metadata: _metadata }, null, _instanceExtraInitializers);
			_tools_decorators = [Remote("tools")];
			__esDecorate(this, null, _tools_decorators, { kind: "method", name: "tools", static: false, private: false, access: { has: (obj) => "tools" in obj, get: (obj) => obj.tools }, metadata: _metadata }, null, _instanceExtraInitializers);
			_add_decorators = [Remote("add")];
			__esDecorate(this, null, _add_decorators, { kind: "method", name: "add", static: false, private: false, access: { has: (obj) => "add" in obj, get: (obj) => obj.add }, metadata: _metadata }, null, _instanceExtraInitializers);
			_update_decorators = [Remote("update")];
			__esDecorate(this, null, _update_decorators, { kind: "method", name: "update", static: false, private: false, access: { has: (obj) => "update" in obj, get: (obj) => obj.update }, metadata: _metadata }, null, _instanceExtraInitializers);
			_remove_decorators = [Remote("removeServer")];
			__esDecorate(this, null, _remove_decorators, { kind: "method", name: "removeServer", static: false, private: false, access: { has: (obj) => "removeServer" in obj, get: (obj) => obj.removeServer }, metadata: _metadata }, null, _instanceExtraInitializers);
			_reveal_decorators = [Remote("reveal")];
			__esDecorate(this, null, _reveal_decorators, { kind: "method", name: "reveal", static: false, private: false, access: { has: (obj) => "reveal" in obj, get: (obj) => obj.reveal }, metadata: _metadata }, null, _instanceExtraInitializers);
			_previewImport_decorators = [Remote("previewImport")];
			__esDecorate(this, null, _previewImport_decorators, { kind: "method", name: "previewImport", static: false, private: false, access: { has: (obj) => "previewImport" in obj, get: (obj) => obj.previewImport }, metadata: _metadata }, null, _instanceExtraInitializers);
			_importJson_decorators = [Remote("importJson")];
			__esDecorate(this, null, _importJson_decorators, { kind: "method", name: "importJson", static: false, private: false, access: { has: (obj) => "importJson" in obj, get: (obj) => obj.importJson }, metadata: _metadata }, null, _instanceExtraInitializers);
			_listWorkspaces_decorators = [Remote("listWorkspaces")];
			__esDecorate(this, null, _listWorkspaces_decorators, { kind: "method", name: "listWorkspaces", static: false, private: false, access: { has: (obj) => "listWorkspaces" in obj, get: (obj) => obj.listWorkspaces }, metadata: _metadata }, null, _instanceExtraInitializers);
			_getWorkspaceView_decorators = [Remote("getWorkspaceView")];
			__esDecorate(this, null, _getWorkspaceView_decorators, { kind: "method", name: "getWorkspaceView", static: false, private: false, access: { has: (obj) => "getWorkspaceView" in obj, get: (obj) => obj.getWorkspaceView }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbSessionWorkspace_decorators = [Remote("wbSessionWorkspace")];
			__esDecorate(this, null, _wbSessionWorkspace_decorators, { kind: "method", name: "wbSessionWorkspace", static: false, private: false, access: { has: (obj) => "wbSessionWorkspace" in obj, get: (obj) => obj.wbSessionWorkspace }, metadata: _metadata }, null, _instanceExtraInitializers);
			_addWorkspaceServer_decorators = [Remote("addWorkspaceServer")];
			__esDecorate(this, null, _addWorkspaceServer_decorators, { kind: "method", name: "addWorkspaceServer", static: false, private: false, access: { has: (obj) => "addWorkspaceServer" in obj, get: (obj) => obj.addWorkspaceServer }, metadata: _metadata }, null, _instanceExtraInitializers);
			_updateWorkspaceServer_decorators = [Remote("updateWorkspaceServer")];
			__esDecorate(this, null, _updateWorkspaceServer_decorators, { kind: "method", name: "updateWorkspaceServer", static: false, private: false, access: { has: (obj) => "updateWorkspaceServer" in obj, get: (obj) => obj.updateWorkspaceServer }, metadata: _metadata }, null, _instanceExtraInitializers);
			_removeWorkspaceServer_decorators = [Remote("removeWorkspaceServer")];
			__esDecorate(this, null, _removeWorkspaceServer_decorators, { kind: "method", name: "removeWorkspaceServer", static: false, private: false, access: { has: (obj) => "removeWorkspaceServer" in obj, get: (obj) => obj.removeWorkspaceServer }, metadata: _metadata }, null, _instanceExtraInitializers);
			_setWorkspaceExclude_decorators = [Remote("setWorkspaceExclude")];
			__esDecorate(this, null, _setWorkspaceExclude_decorators, { kind: "method", name: "setWorkspaceExclude", static: false, private: false, access: { has: (obj) => "setWorkspaceExclude" in obj, get: (obj) => obj.setWorkspaceExclude }, metadata: _metadata }, null, _instanceExtraInitializers);
			_previewWorkspaceImport_decorators = [Remote("previewWorkspaceImport")];
			__esDecorate(this, null, _previewWorkspaceImport_decorators, { kind: "method", name: "previewWorkspaceImport", static: false, private: false, access: { has: (obj) => "previewWorkspaceImport" in obj, get: (obj) => obj.previewWorkspaceImport }, metadata: _metadata }, null, _instanceExtraInitializers);
			_importWorkspaceJson_decorators = [Remote("importWorkspaceJson")];
			__esDecorate(this, null, _importWorkspaceJson_decorators, { kind: "method", name: "importWorkspaceJson", static: false, private: false, access: { has: (obj) => "importWorkspaceJson" in obj, get: (obj) => obj.importWorkspaceJson }, metadata: _metadata }, null, _instanceExtraInitializers);
			_revealWorkspaceServer_decorators = [Remote("revealWorkspaceServer")];
			__esDecorate(this, null, _revealWorkspaceServer_decorators, { kind: "method", name: "revealWorkspaceServer", static: false, private: false, access: { has: (obj) => "revealWorkspaceServer" in obj, get: (obj) => obj.revealWorkspaceServer }, metadata: _metadata }, null, _instanceExtraInitializers);
			_projectConnections_decorators = [Remote("projectConnections")];
			__esDecorate(this, null, _projectConnections_decorators, { kind: "method", name: "projectConnections", static: false, private: false, access: { has: (obj) => "projectConnections" in obj, get: (obj) => obj.projectConnections }, metadata: _metadata }, null, _instanceExtraInitializers);
			_reconnectWorkspaceServer_decorators = [Remote("reconnectWorkspaceServer")];
			__esDecorate(this, null, _reconnectWorkspaceServer_decorators, { kind: "method", name: "reconnectWorkspaceServer", static: false, private: false, access: { has: (obj) => "reconnectWorkspaceServer" in obj, get: (obj) => obj.reconnectWorkspaceServer }, metadata: _metadata }, null, _instanceExtraInitializers);
			_updateHint_decorators = [Remote("updateHint")];
			__esDecorate(this, null, _updateHint_decorators, { kind: "method", name: "updateHint", static: false, private: false, access: { has: (obj) => "updateHint" in obj, get: (obj) => obj.updateHint }, metadata: _metadata }, null, _instanceExtraInitializers);
			_whatsNew_decorators = [Remote("whatsNew")];
			__esDecorate(this, null, _whatsNew_decorators, { kind: "method", name: "whatsNew", static: false, private: false, access: { has: (obj) => "whatsNew" in obj, get: (obj) => obj.whatsNew }, metadata: _metadata }, null, _instanceExtraInitializers);
			_scanImportSources_decorators = [Remote("scanImportSources")];
			__esDecorate(this, null, _scanImportSources_decorators, { kind: "method", name: "scanImportSources", static: false, private: false, access: { has: (obj) => "scanImportSources" in obj, get: (obj) => obj.scanImportSources }, metadata: _metadata }, null, _instanceExtraInitializers);
			_previewImportSource_decorators = [Remote("previewImportSource")];
			__esDecorate(this, null, _previewImportSource_decorators, { kind: "method", name: "previewImportSource", static: false, private: false, access: { has: (obj) => "previewImportSource" in obj, get: (obj) => obj.previewImportSource }, metadata: _metadata }, null, _instanceExtraInitializers);
			_importSource_decorators = [Remote("importSource")];
			__esDecorate(this, null, _importSource_decorators, { kind: "method", name: "importSource", static: false, private: false, access: { has: (obj) => "importSource" in obj, get: (obj) => obj.importSource }, metadata: _metadata }, null, _instanceExtraInitializers);
			_toolTailor_decorators = [Remote("toolTailor")];
			__esDecorate(this, null, _toolTailor_decorators, { kind: "method", name: "toolTailor", static: false, private: false, access: { has: (obj) => "toolTailor" in obj, get: (obj) => obj.toolTailor }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbConnectorCatalog_decorators = [Remote("wbConnectorCatalog")];
			__esDecorate(this, null, _wbConnectorCatalog_decorators, { kind: "method", name: "wbConnectorCatalog", static: false, private: false, access: { has: (obj) => "wbConnectorCatalog" in obj, get: (obj) => obj.wbConnectorCatalog }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbConnectorCachedCount_decorators = [Remote("wbConnectorCachedCount")];
			__esDecorate(this, null, _wbConnectorCachedCount_decorators, { kind: "method", name: "wbConnectorCachedCount", static: false, private: false, access: { has: (obj) => "wbConnectorCachedCount" in obj, get: (obj) => obj.wbConnectorCachedCount }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbConnectorIcon_decorators = [Remote("wbConnectorIcon")];
			__esDecorate(this, null, _wbConnectorIcon_decorators, { kind: "method", name: "wbConnectorIcon", static: false, private: false, access: { has: (obj) => "wbConnectorIcon" in obj, get: (obj) => obj.wbConnectorIcon }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbConnectorPreview_decorators = [Remote("wbConnectorPreview")];
			__esDecorate(this, null, _wbConnectorPreview_decorators, { kind: "method", name: "wbConnectorPreview", static: false, private: false, access: { has: (obj) => "wbConnectorPreview" in obj, get: (obj) => obj.wbConnectorPreview }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbConnectorInstall_decorators = [Remote("wbConnectorInstall")];
			__esDecorate(this, null, _wbConnectorInstall_decorators, { kind: "method", name: "wbConnectorInstall", static: false, private: false, access: { has: (obj) => "wbConnectorInstall" in obj, get: (obj) => obj.wbConnectorInstall }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbOAuthBegin_decorators = [Remote("wbOAuthBegin")];
			__esDecorate(this, null, _wbOAuthBegin_decorators, { kind: "method", name: "wbOAuthBegin", static: false, private: false, access: { has: (obj) => "wbOAuthBegin" in obj, get: (obj) => obj.wbOAuthBegin }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbOAuthPoll_decorators = [Remote("wbOAuthPoll")];
			__esDecorate(this, null, _wbOAuthPoll_decorators, { kind: "method", name: "wbOAuthPoll", static: false, private: false, access: { has: (obj) => "wbOAuthPoll" in obj, get: (obj) => obj.wbOAuthPoll }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbOAuthCancel_decorators = [Remote("wbOAuthCancel")];
			__esDecorate(this, null, _wbOAuthCancel_decorators, { kind: "method", name: "wbOAuthCancel", static: false, private: false, access: { has: (obj) => "wbOAuthCancel" in obj, get: (obj) => obj.wbOAuthCancel }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbOAuthToken_decorators = [Remote("wbOAuthToken")];
			__esDecorate(this, null, _wbOAuthToken_decorators, { kind: "method", name: "wbOAuthToken", static: false, private: false, access: { has: (obj) => "wbOAuthToken" in obj, get: (obj) => obj.wbOAuthToken }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbOAuthOverview_decorators = [Remote("wbOAuthOverview")];
			__esDecorate(this, null, _wbOAuthOverview_decorators, { kind: "method", name: "wbOAuthOverview", static: false, private: false, access: { has: (obj) => "wbOAuthOverview" in obj, get: (obj) => obj.wbOAuthOverview }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbOAuthRefresh_decorators = [Remote("wbOAuthRefresh")];
			__esDecorate(this, null, _wbOAuthRefresh_decorators, { kind: "method", name: "wbOAuthRefresh", static: false, private: false, access: { has: (obj) => "wbOAuthRefresh" in obj, get: (obj) => obj.wbOAuthRefresh }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbOAuthOpen_decorators = [Remote("wbOAuthOpen")];
			__esDecorate(this, null, _wbOAuthOpen_decorators, { kind: "method", name: "wbOAuthOpen", static: false, private: false, access: { has: (obj) => "wbOAuthOpen" in obj, get: (obj) => obj.wbOAuthOpen }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbSkillCatalog_decorators = [Remote("wbSkillCatalog")];
			__esDecorate(this, null, _wbSkillCatalog_decorators, { kind: "method", name: "wbSkillCatalog", static: false, private: false, access: { has: (obj) => "wbSkillCatalog" in obj, get: (obj) => obj.wbSkillCatalog }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbSkillDetail_decorators = [Remote("wbSkillDetail")];
			__esDecorate(this, null, _wbSkillDetail_decorators, { kind: "method", name: "wbSkillDetail", static: false, private: false, access: { has: (obj) => "wbSkillDetail" in obj, get: (obj) => obj.wbSkillDetail }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbSkillInstall_decorators = [Remote("wbSkillInstall")];
			__esDecorate(this, null, _wbSkillInstall_decorators, { kind: "method", name: "wbSkillInstall", static: false, private: false, access: { has: (obj) => "wbSkillInstall" in obj, get: (obj) => obj.wbSkillInstall }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbSkillUninstall_decorators = [Remote("wbSkillUninstall")];
			__esDecorate(this, null, _wbSkillUninstall_decorators, { kind: "method", name: "wbSkillUninstall", static: false, private: false, access: { has: (obj) => "wbSkillUninstall" in obj, get: (obj) => obj.wbSkillUninstall }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbSkillInstalled_decorators = [Remote("wbSkillInstalled")];
			__esDecorate(this, null, _wbSkillInstalled_decorators, { kind: "method", name: "wbSkillInstalled", static: false, private: false, access: { has: (obj) => "wbSkillInstalled" in obj, get: (obj) => obj.wbSkillInstalled }, metadata: _metadata }, null, _instanceExtraInitializers);
			// T03/R4：多市场注册表（读 / 增改）。
			_wbMarketRegistry_decorators = [Remote("wbMarketRegistry")];
			__esDecorate(this, null, _wbMarketRegistry_decorators, { kind: "method", name: "wbMarketRegistry", static: false, private: false, access: { has: (obj) => "wbMarketRegistry" in obj, get: (obj) => obj.wbMarketRegistry }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbMarketRegistryUpsert_decorators = [Remote("wbMarketRegistryUpsert")];
			__esDecorate(this, null, _wbMarketRegistryUpsert_decorators, { kind: "method", name: "wbMarketRegistryUpsert", static: false, private: false, access: { has: (obj) => "wbMarketRegistryUpsert" in obj, get: (obj) => obj.wbMarketRegistryUpsert }, metadata: _metadata }, null, _instanceExtraInitializers);
			// T04/R8：安装状态登记（connector/skill/plugin 三类安装的统一账本）。
			_wbInstallState_decorators = [Remote("wbInstallState")];
			__esDecorate(this, null, _wbInstallState_decorators, { kind: "method", name: "wbInstallState", static: false, private: false, access: { has: (obj) => "wbInstallState" in obj, get: (obj) => obj.wbInstallState }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbInstallStateRecord_decorators = [Remote("wbInstallStateRecord")];
			__esDecorate(this, null, _wbInstallStateRecord_decorators, { kind: "method", name: "wbInstallStateRecord", static: false, private: false, access: { has: (obj) => "wbInstallStateRecord" in obj, get: (obj) => obj.wbInstallStateRecord }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbInstallStateForget_decorators = [Remote("wbInstallStateForget")];
			__esDecorate(this, null, _wbInstallStateForget_decorators, { kind: "method", name: "wbInstallStateForget", static: false, private: false, access: { has: (obj) => "wbInstallStateForget" in obj, get: (obj) => obj.wbInstallStateForget }, metadata: _metadata }, null, _instanceExtraInitializers);
			// T06/Awesome：DSH 社区插件市场（awesome-dsh-plugins）。
			_wbAwesomeCatalog_decorators = [Remote("wbAwesomeCatalog")];
			__esDecorate(this, null, _wbAwesomeCatalog_decorators, { kind: "method", name: "wbAwesomeCatalog", static: false, private: false, access: { has: (obj) => "wbAwesomeCatalog" in obj, get: (obj) => obj.wbAwesomeCatalog }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbAwesomeDetail_decorators = [Remote("wbAwesomeDetail")];
			__esDecorate(this, null, _wbAwesomeDetail_decorators, { kind: "method", name: "wbAwesomeDetail", static: false, private: false, access: { has: (obj) => "wbAwesomeDetail" in obj, get: (obj) => obj.wbAwesomeDetail }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbAwesomeReadme_decorators = [Remote("wbAwesomeReadme")];
			__esDecorate(this, null, _wbAwesomeReadme_decorators, { kind: "method", name: "wbAwesomeReadme", static: false, private: false, access: { has: (obj) => "wbAwesomeReadme" in obj, get: (obj) => obj.wbAwesomeReadme }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbAwesomeUpdateCheck_decorators = [Remote("wbAwesomeUpdateCheck")];
			__esDecorate(this, null, _wbAwesomeUpdateCheck_decorators, { kind: "method", name: "wbAwesomeUpdateCheck", static: false, private: false, access: { has: (obj) => "wbAwesomeUpdateCheck" in obj, get: (obj) => obj.wbAwesomeUpdateCheck }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbRepoMeta_decorators = [Remote("wbRepoMeta")];
			__esDecorate(this, null, _wbRepoMeta_decorators, { kind: "method", name: "wbRepoMeta", static: false, private: false, access: { has: (obj) => "wbRepoMeta" in obj, get: (obj) => obj.wbRepoMeta }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbNpmDownloads_decorators = [Remote("wbNpmDownloads")];
			__esDecorate(this, null, _wbNpmDownloads_decorators, { kind: "method", name: "wbNpmDownloads", static: false, private: false, access: { has: (obj) => "wbNpmDownloads" in obj, get: (obj) => obj.wbNpmDownloads }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbLoadoutExport_decorators = [Remote("wbLoadoutExport")];
			__esDecorate(this, null, _wbLoadoutExport_decorators, { kind: "method", name: "wbLoadoutExport", static: false, private: false, access: { has: (obj) => "wbLoadoutExport" in obj, get: (obj) => obj.wbLoadoutExport }, metadata: _metadata }, null, _instanceExtraInitializers);
			_wbLoadoutDiff_decorators = [Remote("wbLoadoutDiff")];
			__esDecorate(this, null, _wbLoadoutDiff_decorators, { kind: "method", name: "wbLoadoutDiff", static: false, private: false, access: { has: (obj) => "wbLoadoutDiff" in obj, get: (obj) => obj.wbLoadoutDiff }, metadata: _metadata }, null, _instanceExtraInitializers);
			if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
		}
		static inject = ["loader", "tools"];
		constructor(ctx) {
			super(ctx, "mcpManager");
			ensureLogCapture(ctx);
			installAgentRuntime(ctx);
			// 会话级专家「记住选择」：agent 重建（切会话/重启/压缩）后自动补回人设。
			// 与项目 MCP 的安装完全独立；失败只能降级（不会自动恢复），不能拖垮插件装配。
			try {
				installPersonaRuntime(ctx);
			} catch (error) {
				ctx.logger?.warn?.(`armory: 会话专家运行时安装失败：${error?.message || error}`);
			}
			__runInitializers(this, _instanceExtraInitializers);
		}
		async list() {
			return listMcpServers(this.ctx);
		}
		async status(name) {
			ensureLogCapture(this.ctx);
			const value = String(name);
			const state = await managedState(this.ctx);
			const matches = entriesForName(this.ctx, value);
			if (!matches.length) throw new Error("no such MCP: " + name);
			const profileId = state.entryIds.get(value);
			const entry = matches.find((candidate) => candidate.options.id === profileId) || matches[0];
			const conflict = matches.length > 1;
			const inventory = toolInventory(this.ctx);
			return { server: summarize(entry, inventory, !conflict && entry.options.id === profileId ? state.byName.get(value) : null, conflict, lastLogFor(this.ctx, value, entry.fiber)) };
		}
		async enable(name) {
			return this.setDisabled(String(name), false);
		}
		async disable(name) {
			return this.setDisabled(String(name), true);
		}
		async setDisabled(name, disabled) {
			return withPatchWrite(this.ctx, async () => {
				const state = await managedState(this.ctx);
				const entry = managedLiveEntry(this.ctx, state, name);
				if (!entry) throw new Error("此 MCP 来自其他 bundle、存在同名冲突，或不属于当前 Web profile，不能修改");
				const persistedDisabled = state.byName.get(name)?.disabled === true;
				if (entry.disabled === disabled && persistedDisabled === disabled) return { note: disabled ? "already disabled" : "already enabled" };
				const outcome = await writePatch(state, setManagedMcpDisabled(state.content, name, disabled));
				if (entry.disabled === disabled) return { note: disabled ? "已校准 profile patch 为禁用" : "已校准 profile patch 为启用" };
				try {
					await entry.update({ disabled });
				} catch (error) {
					try {
						await writePatch(state, state.content, outcome.version);
					} catch (rollbackError) {
						throw new AggregateError([error, rollbackError], "MCP 状态更新失败，且 profile patch 回滚失败");
					}
					throw error;
				}
				return { note: disabled ? "已禁用并写入 profile patch" : "已启用并写入 profile patch" };
			});
		}
		async reconnect(name) {
			const value = String(name);
			const state = await managedState(this.ctx);
			const entry = managedLiveEntry(this.ctx, state, value);
			if (!entry) throw new Error("此 MCP 来自其他 bundle、存在同名冲突，或不属于当前 Web profile，不能重连");
			if (entry.disabled) throw new Error("MCP 已禁用，请先启用");
			if (entry.fiber) await entry.fiber.restart();
			else await entry.refresh();
			return { note: "restart requested" };
		}
		async tools(payload) {
			// 契约声明的是一个 payload 对象：全局 MCP 只需 name，项目 MCP 还要 wsPath。跳作用域
			// 同名是合法配置（官方按注册作用域隔离），所以光按名字扫描会把 A 项目的工具列到
			// B 项目的详情里；有 wsPath 时必须按 (wsPath, serverName) 精确定位。
			const value = String(payload?.name ?? "");
			const inventory = toolInventory(this.ctx);
			const global = inventory.schemas.get(value);
			if (global !== undefined) return { tools: global.map(projectToolSchema), ambiguous: inventory.ambiguous.has(value) };
			// 项目 MCP 不是 loader 条目，它的工具注册在共享作用域层里，toolInventory 走的全局视图
			// 根本看不到（这是之前面板列表报“N 工具”、详情却永远空白的原因）。按 scopeKey 枚举。
			const rawPath = payload?.wsPath;
			const wsPath = typeof rawPath === "string" && rawPath ? canonicalWorkspacePath(rawPath) : undefined;
			return { tools: workspaceToolSchemas(this.ctx, value, wsPath).map(projectToolSchema), ambiguous: false };
		}
		async add(spec) {
			if (containsRedactedValue(spec)) throw new Error("新增 MCP 不能包含保留原值标记");
			const normalized = normalizeOne(spec);
			return withPatchWrite(this.ctx, async () => {
				const state = await managedState(this.ctx);
				if (hasExternalMcpName(this.ctx, state, normalized.name) || state.byName.has(normalized.name)) throw new Error("MCP already exists: " + normalized.name);
				await writePatch(state, updateManagedMcpPatch(state.content, [normalized], { replace: false, reservedIds: reservedEntryIds(this.ctx) }));
				return { note: "已添加到 profile patch，正在热加载" + describeLaunchRewrite(spec?.command, normalized.command) };
			});
		}
		async update(spec) {
			const requestedName = String(spec?.name || "").trim();
			return withPatchWrite(this.ctx, async () => {
				const state = await managedState(this.ctx);
				const current = state.byName.get(requestedName);
				if (!current || !managedLiveEntry(this.ctx, state, requestedName)) throw new Error("此 MCP 存在同名冲突或不属于当前 Web profile，不能编辑");
				const normalized = normalizeOne(restoreRedactedSpec(spec, current));
				if (!Object.hasOwn(normalized, "disabled") && current.disabled) normalized.disabled = true;
				await writePatch(state, updateManagedMcpPatch(state.content, [normalized], { replace: false, reservedIds: reservedEntryIds(this.ctx, new Set([state.entryIds.get(normalized.name)].filter(Boolean))) }));
				return { note: "已更新 profile patch，正在热加载" + describeLaunchRewrite(spec?.command, normalized.command) };
			});
		}
		async removeServer(name) {
			const value = String(name);
			return withPatchWrite(this.ctx, async () => {
				const state = await managedState(this.ctx);
				if (!state.byName.has(value) || !managedLiveEntry(this.ctx, state, value)) throw new Error("此 MCP 存在同名冲突或不属于当前 Web profile，不能移除");
				await writePatch(state, updateManagedMcpPatch(state.content, [], { removeNames: [value] }));
				return { note: "已从 profile patch 移除；完全卸载以 DSH 热加载结果为准" };
			});
		}
		async reveal(payload) {
			const name = String(payload?.name || "");
			const field = String(payload?.field || "");
			const key = payload?.key === undefined ? undefined : String(payload.key);
			const state = await managedState(this.ctx);
			const current = state.byName.get(name);
			const entry = current ? managedLiveEntry(this.ctx, state, name) : null;
			if (!current || !entry) throw new Error("此 MCP 不属于当前 Web profile，不能读取配置");
			if (!["url", "args", "env", "headers"].includes(field)) throw new Error("不支持读取该配置字段");
			// 编辑表单仅把有效运行值用于显示；未实际修改输入时仍提交保留原值标记，
			// 不会把密钥写回 profile。options.config 里是 raw 的 `!!js` 表达式，必须求值一次。
			const value = resolveLiveConfigValue(entry, entry.options.config[field] ?? current[field]);
			if (key !== undefined) {
				if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error("没有该配置项");
				return { value: value[key] };
			}
			return { value: structuredClone(value) };
		}
		async previewImport(payload) {
			const json = typeof payload?.json === "string" ? JSON.parse(payload.json) : payload?.json;
			const state = await managedState(this.ctx);
			return importPreview(this.ctx, admittedImport(json), state);
		}
		async importJson(payload) {
			const mode = payload?.mode === "replace" ? "replace" : "merge";
			const json = typeof payload?.json === "string" ? JSON.parse(payload.json) : payload?.json;
			return applyManagedImport(this.ctx, admittedImport(json), mode);
		}
		async scanImportSources(payload) {
			const context = sourceContext(payload?.wsPath ? canonicalWorkspacePath(String(payload.wsPath)) : "");
			const rows = await collectImportLocations(context, readSourceText, context.layer);
			return { sources: rows.map(projectSourceRow) };
		}
		async previewImportSource(payload) {
			const context = sourceContext(payload?.wsPath ? canonicalWorkspacePath(String(payload.wsPath)) : "");
			assertSourceLayer(context.layer, payload?.scope);
			const row = await resolveImportLocation(context, payload || {}, readSourceText);
			if (!row.exists) throw new Error(`来源文件不存在：${row.displayPath}`);
			if (row.error) throw new Error(row.error);
			const selected = selectSourceServers(row, payload?.names);
			let preview;
			if (context.cwd) {
				const config = await readWorkspaceConfigCached(this.ctx, context.cwd);
				if (config.error) throw new Error(config.error);
				preview = workspaceImportPreview(config, selected);
			} else {
				preview = importPreview(this.ctx, selected, await managedState(this.ctx));
			}
			// 指纹跟随预览返回：导入时用它拦住「预览之后文件被改」的情况。
			return { preview, contentHash: row.contentHash, source: { label: row.label, scope: row.scope, displayPath: row.displayPath } };
		}
		async importSource(payload) {
			const context = sourceContext(payload?.wsPath ? canonicalWorkspacePath(String(payload.wsPath)) : "");
			const mode = payload?.mode === "replace" ? "replace" : "merge";
			assertSourceLayer(context.layer, payload?.scope);
			const row = await resolveImportLocation(context, payload || {}, readSourceText);
			if (!row.exists) throw new Error(`来源文件不存在：${row.displayPath}`);
			if (row.error) throw new Error(row.error);
			// 指纹必须回传：没有它，"预览的是 A、导入的是 B"只差一次文件改动。
			if (typeof payload?.contentHash !== "string" || !payload.contentHash) throw new Error("缺少来源内容指纹：请先预览、再导入");
			if (payload.contentHash !== row.contentHash) throw new Error("来源配置在预览之后发生了变化，请重新预览");
			const selected = selectSourceServers(row, payload?.names);
			return context.cwd ? applyWorkspaceImport(this.ctx, context.cwd, selected, mode) : applyManagedImport(this.ctx, selected, mode);
		}
		async toolTailor(payload) {
			// 只读账本：扫描本机会话日志 + 当前注册表 Schema，见 tool-ledger.js。
			// days 由调用方传（7/30/90），缺省 30，服务端钳到 [1,365]。
			// 5 分钟缓存命中直接回上次报告；用户点「重扫」时传 refresh:true 强制重算。
			// 「清空解压文本缓存」这个可选动作已删（2026-10-23）：它曾声称「先清后扫，面板立即
			// 看到占用归零」，实测恰好相反 —— 快照取在扫描之后，同一发调用里日志被重新解压回填，
			// 前后都是 32 条 / 65.8 MB；而 clearTextCache() 的返回值（clearedBytes）压根没进报告
			// （textCacheStats() 没这个键），面板只能恒显示「正在清空缓存…」。既然既不回收也不修
			// 任何事，就不再留这条 RPC 分支。tool-ledger.js 仍导出 clearTextCache 原语：它是将来
			// 真要改缓存策略（槽位按文件数自适应、或只缓存最近若干会话）时的落点，只是现在无人调用。
			return buildToolTailorReport(this.ctx, payload || {});
		}
		async listWorkspaces() {
			const records = await listWorkspaceRecords(this.ctx);
			const workspaces = [];
			for (const record of records) {
				const config = await readWorkspaceConfigCached(this.ctx, record.path);
				workspaces.push({
					path: record.path,
					name: record.title || basename(record.path),
					serverCount: config.servers.length,
					excluded: config.exclude,
					error: config.error || "",
				});
			}
			return { workspaces, revision: revisionOf(workspaces) };
		}
		async getWorkspaceView(payload) {
			const rawPath = String(payload?.wsPath ?? (payload?.path || ""));
			if (!rawPath) throw new Error("缺少 workspace path");
			const wsPath = canonicalWorkspacePath(rawPath);
			const config = await readWorkspaceConfigCached(this.ctx, wsPath);
			// 项目 MCP 的连接诊断与全局走同一条日志通路（按 mcp-client(<serverName>) 过滤）。
			const mountErrors = workspaceMountErrorsView(wsPath);
			const mountErrorByName = new Map(mountErrors.map((m) => [m.serverName, m.error]));
			const servers = config.servers.map((server) => summarizeWorkspaceRow(this.ctx, wsPath, server, mountErrorByName.get(server.name)));
			const globalResult = await listMcpServers(this.ctx);
			const global = globalResult.servers.map((server) => ({ ...server, excluded: config.exclude.includes(server.serverName) }));
			const restrictError = workspaceRestrictErrorView(wsPath);
			const scopeErrors = workspaceScopeErrorsView(wsPath);
			const liveAgents = liveWorkspaceAgentCount(wsPath);
			return {
				path: wsPath,
				name: basename(wsPath),
				error: config.error || "",
				mountErrors,
				scopeErrors,
				restrictError,
				liveAgents,
				revision: revisionOf({ servers, exclude: config.exclude, global: globalResult.revision, mountErrors, scopeErrors, restrictError, liveAgents }),
				servers,
				exclude: config.exclude,
				global,
			};
		}
		// 召唤菜单「本项目」：slot 只给 sessionId，这里换算出会话所属项目根。
		// 只读，不建连、不写盘；老宿主未重启时该 RPC 不存在，客户端按不可用降级。
		async wbSessionWorkspace(payload) {
			return resolveSessionWorkspace(this.ctx, payload?.sessionId);
		}
		async addWorkspaceServer(payload) {
			const wsPath = canonicalWorkspacePath(String(payload?.wsPath || ""));
			const spec = payload?.spec;
			if (!wsPath) throw new Error("缺少 workspace 路径");
			if (containsRedactedValue(spec)) throw new Error("新增 MCP 不能包含保留原值标记");
			const normalized = normalizeOne(spec);
			const result = await withWorkspaceWrite(wsPath, async () => {
				const config = await readWorkspaceConfigCached(this.ctx, wsPath);
				if (config.error) throw new Error(config.error);
				// 只拦同一作用域内的重名：项目内同名会静默覆盖 mcpServers 的对象键。跨作用域同名
				// 由官方按注册作用域隔离，是合法配置。
				if (config.servers.some((server) => server.name === normalized.name)) throw new Error("该项目已存在：" + normalized.name);
				await writeWorkspaceConfigFile(wsPath, [...config.servers, normalized], config.exclude);
				return { note: `已添加到项目配置：${normalized.name}` };
			});
			// 写盘即对齐：存活会话立刻拿到这条新连接，不需要等它重开（在写锁外做，见 alignWorkspaceConnections）。
			await alignWorkspaceConnections(this.ctx, wsPath);
			return result;
		}
		async updateWorkspaceServer(payload) {
			const wsPath = canonicalWorkspacePath(String(payload?.wsPath || ""));
			const spec = payload?.spec;
			const requestedName = String(spec?.name || "").trim();
			if (!wsPath) throw new Error("缺少 workspace 路径");
			const result = await withWorkspaceWrite(wsPath, async () => {
				const config = await readWorkspaceConfigCached(this.ctx, wsPath);
				if (config.error) throw new Error(config.error);
				const current = config.servers.find((server) => server.name === requestedName);
				if (!current) throw new Error("该项目中没有此 MCP：" + requestedName);
				const normalized = normalizeOne(restoreRedactedSpec(spec, current));
				if (normalized.name !== requestedName) {
					// 改名同样需要拦截同项目内的名称冲突，否则写盘时 mcpServers 对象键会静默覆盖。
					if (config.servers.some((server) => server.name === normalized.name)) throw new Error("该项目已存在：" + normalized.name);
				}
				const servers = config.servers.map((server) => (server.name === requestedName ? normalized : server));
				await writeWorkspaceConfigFile(wsPath, servers, config.exclude);
				return { note: `已更新项目配置：${normalized.name}` };
			});
			// 配置变更就地重载共享连接（工具名不变，会话历史安全）。
			await alignWorkspaceConnections(this.ctx, wsPath);
			return result;
		}
		async removeWorkspaceServer(payload) {
			const wsPath = canonicalWorkspacePath(String(payload?.wsPath || ""));
			const name = String(payload?.name || "");
			const result = await withWorkspaceWrite(wsPath, async () => {
				const config = await readWorkspaceConfigCached(this.ctx, wsPath);
				if (config.error) throw new Error(config.error);
				const servers = config.servers.filter((server) => server.name !== name);
				if (servers.length === config.servers.length) throw new Error("该项目中没有此 MCP：" + name);
				await writeWorkspaceConfigFile(wsPath, servers, config.exclude);
				return { note: `已从项目配置移除：${name}` };
			});
			// 移除同样就地生效：连接立刻销毁，工具从存活会话里撤掉（不必重开会话）。
			await alignWorkspaceConnections(this.ctx, wsPath);
			return result;
		}
		// 面板的「重连」：拆掉并按当前配置重建这条项目连接，再对齐存活会话。
		// 存在的理由：mcp-client 重连预算耗尽后会注销工具并停止，只能靠重载配置/重启宿主恢复
		//（README 明写）；项目 MCP 又不是常驻服务，所以这个终态几乎必然出现，必须有出口。
		async reconnectWorkspaceServer(payload) {
			const wsPath = canonicalWorkspacePath(String(payload?.wsPath || ""));
			const name = String(payload?.name || "");
			if (!wsPath) throw new Error("缺少 workspace 路径");
			if (!name) throw new Error("缺少 serverName");
			const result = await reconnectWorkspaceServer(this.ctx, wsPath, name);
			return { note: result.hadLiveConnection ? `已重连项目 MCP：${name}` : `该项目 MCP 原本没有活动连接，已按配置新建：${name}` };
		}
		async setWorkspaceExclude(payload) {
			const wsPath = canonicalWorkspacePath(String(payload?.wsPath ?? (payload?.path || "")));
			const serverName = String(payload?.serverName || "");
			const hidden = payload?.hidden === true;
			if (!serverName) throw new Error("缺少 serverName");
			const result = await withWorkspaceWrite(wsPath, async () => {
				const config = await readWorkspaceConfigCached(this.ctx, wsPath);
				if (config.error) throw new Error(config.error);
				const exclude = config.exclude.filter((name) => name !== serverName);
				if (hidden) exclude.push(serverName);
				await writeWorkspaceConfigFile(wsPath, config.servers, exclude);
				return { note: hidden ? `已屏蔽 ${serverName}，对运行中的会话立即生效` : `已取消屏蔽 ${serverName}，对运行中的会话立即生效`, exclude };
			});
			// 立刻写入运行中会话：工具清单是每步重新组装的，所以新的 deny 在下一轮请求就生效
			//（不是"只对新会话生效"——那种说法把"请求 header 稳定"误当成了"模型看不见新工具"）。
			// 与连接对齐同样放在锁外：写已经落盘，副作用不该按住写锁（restrict 也会动作用域层）。
			try { await reconcileWorkspaceRestricts(this.ctx, wsPath); }
			catch (error) { this.ctx.logger?.error?.(`mcp-manager: 屏蔽已写入，但对齐会话作用域失败（下次挂载会重试）: ${error?.message ?? error}`); }
			return result;
		}
		async previewWorkspaceImport(payload) {
			const wsPath = canonicalWorkspacePath(String(payload?.wsPath || ""));
			const json = typeof payload?.json === "string" ? JSON.parse(payload.json) : payload?.json;
			const config = await readWorkspaceConfigCached(this.ctx, wsPath);
			if (config.error) throw new Error(config.error);
			return workspaceImportPreview(config, admittedImport(json));
		}
		async importWorkspaceJson(payload) {
			const wsPath = canonicalWorkspacePath(String(payload?.wsPath || ""));
			const mode = payload?.mode === "replace" ? "replace" : "merge";
			const json = typeof payload?.json === "string" ? JSON.parse(payload.json) : payload?.json;
			return applyWorkspaceImport(this.ctx, wsPath, admittedImport(json), mode);
		}
		async revealWorkspaceServer(payload) {
			const wsPath = canonicalWorkspacePath(String(payload?.wsPath || ""));
			const name = String(payload?.name || "");
			const field = String(payload?.field || "");
			const key = payload?.key === undefined ? undefined : String(payload.key);
			const config = await readWorkspaceConfigCached(this.ctx, wsPath);
			if (config.error) throw new Error(config.error);
			const current = config.servers.find((server) => server.name === name);
			if (!current) throw new Error("该项目中没有此 MCP：" + name);
			if (!["url", "args", "env", "headers"].includes(field)) throw new Error("不支持读取该配置字段");
			// 列表与详情的默认显示走 workspaceServerView 的模板形式（`${VAR}`，与文件一致、
			// 不泄露）；这里是被眼睛点开的通路，要的是「有效运行值」，所以按建连同一个求值器解析。
			const value = resolveSpecValue(current[field], process.env);
			if (key !== undefined) {
				if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) throw new Error("没有该配置项");
				return { value: value[key] };
			}
			return { value: structuredClone(value) };
		}
	async projectConnections() {
		// 只读排障接口：本进程内每一条项目 MCP 共享连接的真实状态。面板暂未接线；
		// 它回答的是单行视图回答不了的问题——refs 是不是卡住不归零（refs > sessions）。
		return { connections: await projectConnectionsView(this.ctx) };
	}
	async updateHint() {
		return checkForUpdate();
	}
	/**
	 * 本插件的安装形态与来源 spec —— 客户端「一键升级」的安全判据。
	 *
	 * 为什么必须由宿主读：客户端问得到的 listBundles() 行里**没有 source 字段**
	 * （只有 name/version/description/meta/enabled/installed/optional/removable/
	 * readOnlyReason/rows/overrides），客户端据此判断会恒判「可以一键升级」，而
	 * installBundle 执行的是 `pnpm add <npm spec>`——本地 file:/link: 安装的用户一点
	 * 就会把开发副本换成 npm 包。真源只有 profile manifest 的 dependencies。
	 *
	 * 只读、只回本插件自己的两行（新名 + 兼容旧名），失败一律降级为 unknown 而不是抛错：
	 * 升级按钮不该因为读不到 manifest 就让面板报错。
	 */
	async installInfo() {
		const names = [UPGRADE_PACKAGE_NAME, LEGACY_PACKAGE_NAME];
		const info = {
			packageName: UPGRADE_PACKAGE_NAME,
			version: pluginVersion(),
			spec: null,
			source: "unknown",
			profileDir: null,
		};
		try {
			const dir = profileDirOf(this.ctx);
			if (dir) {
				info.profileDir = dir;
				const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
				const deps = manifest && typeof manifest.dependencies === "object" && manifest.dependencies ? manifest.dependencies : {};
				const hit = names.find((name) => typeof deps[name] === "string");
				if (hit) {
					info.spec = String(deps[hit]);
					info.installedAs = hit;
					info.source = classifyInstallSpec(info.spec);
				}
			}
		} catch {
			// 读不到就维持 unknown：客户端据此退回「查看更新方式」链接，不做写操作。
		}
		return info;
	}
	async whatsNew() {
		// 只回数据，不在宿主判定「该不该弹」：「上次看到的版本」是每台浏览器自己的事实
		// （localStorage），宿主没有这个视角；判定在客户端（whatsNewFor）。
		// P1：中英字段一起送（text + textEn / where + whereEn），客户端按 locale 选择。
		// 宿主不读 locale，因为它也可能是老版本、没有 locale 服务；选择只发生在浏览器侧。
		return { current: pluginVersion(), entries: attachWhatsNewEnglish(WHATS_NEW) };
	}
	// ── Skill 看板 ────────────────────────────────────────────────────
	// 数据真源是 @deepseek-ai/dsh-skill 的 ctx.skills 注册表，本插件只做投影与只读定位，
	// 不发现、不缓存、不写盘——发现与去重仍归注册表。注册表缺席时返回 available:false，
	// 看板如实说「不可用」，而不是 500。
	async listSkills(payload) {
		const result = await withSkillScope(this.ctx, payload, async (registry, options) => {
			if (typeof registry.list !== "function") return undefined;
			const rows = await registry.list(options);
			return rows.map((skill) => ({
				name: skill.name,
				description: skill.description,
				...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
				...skill.path === undefined ? {} : { path: skill.path },
				source: skill.source,
				provider: skill.provider,
				modelInvocable: !!skill.invocation?.modelInvocable,
				userInvocable: !!skill.invocation?.userInvocable,
			}));
		});
		if (result === undefined) return { available: false, skills: [] };
		return { available: true, skills: result };
	}
	async skillDetail(payload) {
		const name = String(payload?.name || "");
		if (!name) throw new Error("缺少 skill 名称");
		const result = await withSkillScope(this.ctx, payload, async (registry, options) => {
			if (typeof registry.get !== "function") throw new Error("宿主没有挂载 skill 注册表（@deepseek-ai/dsh-skill），读不了 skill 内容");
			const skill = await registry.get(name, options);
			if (!skill) throw new Error("没有找到这个 skill（可能刚被移动或删除）：" + name);
			return {
				name: skill.name,
				description: skill.description,
				...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
				...skill.path === undefined ? {} : { path: skill.path },
				source: skill.source,
				provider: skill.provider,
				modelInvocable: !!skill.invocation?.modelInvocable,
				userInvocable: !!skill.invocation?.userInvocable,
				content: skill.content,
			};
		});
		if (result === undefined) throw new Error("宿主没有挂载 skill 注册表（@deepseek-ai/dsh-skill），读不了 skill 内容");
		return { skill: result };
	}
	async revealSkill(payload) {
		// 路径只信宿主 skill 注册表的解析结果，不信客户端传来的 payload.path：
		// 否则面板能借「打开目录」把任意路径交给 explorer / open 定位。
		const name = String(payload?.name || "").trim();
		if (!name) throw new Error("缺少 skill 名称");
		const resolved = await withSkillScope(this.ctx, payload, async (registry, options) => {
			if (typeof registry.get !== "function") throw new Error("宿主没有挂载 skill 注册表（@deepseek-ai/dsh-skill），无法定位 skill");
			const skill = await registry.get(name, options);
			if (!skill) throw new Error("没有找到这个 skill（可能刚被移动或删除）：" + name);
			return String(skill.path || "");
		});
		if (resolved === undefined) throw new Error("宿主没有挂载 skill 注册表（@deepseek-ai/dsh-skill），无法定位 skill");
		const path = String(resolved);
		if (!path || path.includes("\0") || !isAbsolute(path)) throw new Error("该 skill 没有可打开的文件路径（运行时注册的 skill 不在磁盘上）");
		const shell = typeof this.ctx.get === "function" ? this.ctx.get("shell") : undefined;
		if (shell && typeof shell.showItemInFolder === "function") {
			try {
				await shell.showItemInFolder(path);
				return { note: "已在资源管理器中定位" };
			} catch {
				/* 宿主定位失败时落到系统兜底 */
			}
		}
		if (shell && typeof shell.openExternal === "function") {
			try {
				await shell.openExternal(path);
				return { note: "已交给宿主打开" };
			} catch {
				/* 宿主打开失败时落到系统兜底 */
			}
		}
		const opened = await revealSystemPath(path, { logger: this.ctx?.logger });
		if (opened.ok) return { note: "已交给系统打开" };
		// headless 主机没有桌面文件管理器：不能谎报「已打开」，把真实路径交回去。
		return { note: `没有可用的系统打开器（${opened.reason}），路径：${path}`, path, opened: false };
	}
	// 卸载一条已安装 skill：永久删除用户级/项目级 skills 根目录内的条目。
	// 只信注册表给的 source/path（客户端传的路径不参与判断）；bundled / runtime / custom
	// 由数据层拒绝并给出原因。删除后宿主注册表可能缓存了目录扫描结果——调用方
	// （SkillBoard）先本地收敛列表再 listSkills 刷新，不把「没立刻消失」当成失败。
	async removeSkill(payload) {
		const name = String(payload?.name || "").trim();
		if (!name) throw new Error("缺少 skill 名称");
		const result = await withSkillScope(this.ctx, payload, async (registry, options) => {
			if (typeof registry.get !== "function") throw new Error("宿主没有挂载 skill 注册表（@deepseek-ai/dsh-skill），无法卸载");
			const skill = await registry.get(name, options);
			if (!skill) throw new Error("没有找到这个 skill（可能刚被移动或删除）：" + name);
			return removeSkillFromDisk(skill, { cwd: options.cwd, home: homedir() });
		});
		if (result === undefined) throw new Error("宿主没有挂载 skill 注册表（@deepseek-ai/dsh-skill），无法卸载");
		return { note: `已卸载 ${name}（${result.kind === "symlink" ? "符号链接" : "目录"}：${result.path}）` };
	}
	// 禁用 / 释放一条 skill（工具裁缝技能账本的行内按钮）：写 SKILL.md frontmatter 的
	// disable-model-invocation 标志——宿主 skill-filesystem 官方支持的「模型侧禁用」键，
	// 根目录监听器会自动刷新模型目录（无需重启）。禁用后技能不再进模型目录、不再缴
	// 上下文税；输入框手动 /引用 不受影响。写盘规则与安全闸门全在 lib/skill-disable.js
	// （来源白名单 / 根目录包含性 / realpath 防链接出根），与 removeSkill 同一套纪律。
	async disableSkill(payload) {
		return this.setSkillDisabled(payload, true);
	}
	async enableSkill(payload) {
		return this.setSkillDisabled(payload, false);
	}
	async setSkillDisabled(payload, disabled) {
		const name = String(payload?.name || "").trim();
		if (!name) throw new Error("缺少 skill 名称");
		const result = await withSkillScope(this.ctx, payload, async (registry, options) => {
			if (typeof registry.get !== "function") throw new Error("宿主没有挂载 skill 注册表（@deepseek-ai/dsh-skill），无法修改");
			const skill = await registry.get(name, options);
			if (!skill) throw new Error("没有找到这个 skill（可能刚被移动或删除）：" + name);
			return setSkillModelInvocationOnDisk(skill, { disabled, cwd: options.cwd, home: homedir() });
		});
		if (result === undefined) throw new Error("宿主没有挂载 skill 注册表（@deepseek-ai/dsh-skill），无法修改");
		// 幂等重放（changed=false）也照常报成功：按钮态以注册表实况为准，重放只是补一次确认。
		return {
			note: disabled
				? `已禁用 ${name}（模型不再加载，手动引用不受影响）`
				: `已释放 ${name}（模型可重新调用）`,
			path: result.path,
			changed: result.changed,
		};
	}
	// 安装时间 + 市场原名（按 skill 名字索引）：宿主自扫标准技能根目录、读 SKILL.md
	// 头部 name 建立映射——不依赖 listSkills 行里的 path（注册表可能整列不给）。
	// 永不抛错——时间与原名是辅助信息，单个目录读失败只是没有该条目，不该拖垮看板。
	async skillInstallInfo(payload) {
		return skillInstallInfo(payload || {});
	}
	// ── 自定义套件（Skill 看板）─────────────────────────────────────────
	// 数据层在 lib/suites-registry.js（~/.dsh/armory/suites.json）；这里只做 RPC 转发。
	//   listSkillSuites —— 永不抛错：文件缺失 / JSON 损坏 / 结构不对都回落空集合，
	//     坏文件不该让整个 Skill 看板打不开。
	//   saveSkillSuites —— 整集合覆盖（UI 的「保存」一次提交右侧全部套件）。
	//     payload 形状不合格一律**抛错**，绝不回落成空数组：那等于把用户攒的套件全删了。
	//     脏数据（无名 / 空成员 / id 重复 / 超上限）由数据层拒绝且不写盘，错误原样冒到面板。
	// 不加 Remote 装饰器：与 listSkills / expertAttach 同一形态——strict 声明即可达，
	// 装饰器只是 SRC fallback 的 marker（方向说明见 test/contract-consistency.mjs 顶部）。
	async listSkillSuites() {
		return readSkillSuites();
	}
	async saveSkillSuites(payload) {
		const suites = Array.isArray(payload)
			? payload
			: (payload && typeof payload === "object" && Array.isArray(payload.suites) ? payload.suites : null);
		if (suites === null) throw new Error("缺少套件集合：payload.suites 必须是数组");
		return writeSkillSuites(suites);
	}
	// ── WorkBuddy 市场直连（连接器 MCP + SkillHub 技能）─────────────────
	// 数据与安装逻辑都在 lib/wb-market.js；这里只做 RPC 转发与作用域相关的写盘收尾。
	// 连接器安装复用 applyManagedImport / applyWorkspaceImport：准入、同名跳过、entry id
	// 预留、项目对齐全部与粘贴导入同一条链路，市场只是多了一个「JSON 从哪来」的来源。
	async wbConnectorCatalog() {
		const marketApi = await loadMarket();
		return marketApi.wbConnectorCatalog();
	}
	// 顶栏「市场」chip 的常驻计数：只读磁盘缓存，绝不联网（无缓存返回 null）。
	async wbConnectorCachedCount() {
		const marketApi = await loadMarket();
		return marketApi.wbConnectorCachedCount();
	}
	async wbConnectorPreview(payload) {
		const marketApi = await loadMarket();
		return marketApi.wbConnectorPreview(payload?.connectorId);
	}
	// 某条连接器的图标（data URL）。市场卡片进视口才调，payload 形状同 wbConnectorPreview。
	async wbConnectorIcon(payload) {
		const marketApi = await loadMarket();
		return marketApi.wbConnectorIcon(payload?.connectorId);
	}
	async wbConnectorInstall(payload) {
		const connectorId = String(payload?.connectorId || "").trim();
		if (!connectorId) throw new Error("缺少 connectorId");
		const mode = payload?.mode === "replace" ? "replace" : "merge";
		const wsPath = payload?.wsPath ? canonicalWorkspacePath(String(payload.wsPath)) : "";
		const tokens = payload?.tokens && typeof payload.tokens === "object" ? payload.tokens : {};
		const marketApi = await loadMarket();
		const preview = await marketApi.wbConnectorPreview(connectorId);
		// T04/R7：把面板收集到的 token 填进 ${...} 占位符。只填用户明确提供的槽位，
		// 未填的保持原样并把槽位名回传面板（missingSlots）——绝不代填、绝不猜值。
		const { mcpServers, missingSlots } = applyTokens(preview.mcpServers, tokens);
		// R8：先把已授权的 OAuth token 注进 headers 再探测——否则授权过的连接器每次重装
		// 都会被判成「需要授权」，用户得反复点授权。
		const authorized = await injectStoredOAuthTokens(mcpServers);
		// 本机固定依赖预检：本地客户端型连接器（如 nvapp-windows-local）写死一个本机可执行文件。
		// 缺这个文件时写进配置只会让宿主重连 10 次后注销工具（issue #3），所以安装前直接拦住，
		// 并把「缺哪个路径 / 平台是否支持」作为结构化字段回传面板做本地化提示。
		const localDeps = await marketApi.connectorLocalDeps(authorized);
		const localMissing = localDeps.filter((dep) => dep.status === "missing").map((dep) => dep.path);
		const localUnsupported = localDeps.filter((dep) => dep.status === "platform").map((dep) => dep.path);
		if (localMissing.length || localUnsupported.length) {
			return {
				ok: false,
				connectorId,
				missingSlots,
				localDeps,
				localMissing,
				localUnsupported,
				error: `本机缺少连接器依赖：${[...localMissing, ...localUnsupported].join("、")}`,
			};
		}
		// 装前 401 探测：索引 auth_mode 会漏标鉴权（tec-do 裸 URL 装完必 401）。断言从
		// 「任一不就整体中止」改为「回传需授权清单」：面板据此弹浏览器授权页，授权完成
		// 后重装即可，绝不再抛「DSH 无法自动注入」把用户挡在门外。
		const probe = await marketApi.probeMcpServersAuthorization(authorized);
		if (probe?.needsAuth?.length) {
			return {
				ok: false,
				connectorId,
				missingSlots,
				needsAuth: probe.needsAuth,
				error: `连接器需要授权：${probe.needsAuth.map((item) => item.serverName).join("、")}`,
			};
		}
		const json = { mcpServers: authorized };
		const result = wsPath
			? await applyWorkspaceImport(this.ctx, wsPath, admittedImport(json), mode)
			: await applyManagedImport(this.ctx, admittedImport(json), mode);
		// T04/R8：只有**真的写进了 server** 才登记「已安装」。同名条目被其他配置层占用时，
		// applyManagedImport 会跳过它并返回空 added/updated——早前这里无条件登记，于是一条
		// 根本没落盘的连接器也带着「已安装」徽标（用户报的「显示装好了却用不了」就是这个
		// 徽标在说谎）。跳过 ≠ 装好：这里如实回失败，并把跳过原因带回面板。
		const wrote = (Array.isArray(result?.added) ? result.added.length : 0)
			+ (Array.isArray(result?.updated) ? result.updated.length : 0);
		if (!wrote) {
			const skipped = Array.isArray(result?.warnings) ? result.warnings.filter(Boolean) : [];
			return {
				ok: false,
				connectorId,
				missingSlots,
				localDeps,
				wrote: 0,
				skipped,
				error: skipped.length
					? `没有写入任何 MCP 配置：${skipped.join("；")}`
					: "没有写入任何 MCP 配置：目标作用域里没有可写入的 server",
			};
		}
		// 登记失败只记日志、绝不影响安装结果——状态文件坏了不该让用户白装一次。
		try {
			await recordInstallState({
				kind: "connector",
				key: connectorId,
				name: connectorId,
				scope: wsPath ? "workspace" : "managed",
				installPath: wsPath || "",
				source: { kind: "marketplace", marketplace: "workbuddy-connectors" },
			});
		} catch (error) {
			this.ctx.logger?.warn?.(`wb-market: 连接器 ${connectorId} 安装状态登记失败（不影响安装结果）：${error?.message || error}`);
		}
		return { ...result, missingSlots, localDeps, wrote };
	}
	// ── R8：连接器 MCP 的浏览器授权（RFC 9728 / 8414 / 7591 / 7636）──────────
	// 面板只负责展示与点击：安装前探测到 401 → 这里拿到 authorizeUrl 交给系统浏览器，
	// 浏览器回来后面板轮询 wbOAuthPoll，token 落在 ~/.dsh/armory-oauth/。
	async wbOAuthBegin(payload) {
		const connectorId = String(payload?.connectorId || "").trim();
		if (!connectorId) throw new Error("缺少 connectorId");
		const target = await resolveOAuthTarget(connectorId, payload?.serverName);
		const started = await oauthBegin({
			serverName: target.serverName,
			serverUrl: target.url,
			headers: target.headers,
			clientName: "DSH Armory",
		});
		if (!started?.ok) {
			return {
				ok: false,
				connectorId,
				serverName: target.serverName,
				error: started?.error || "授权流程启动失败",
				mode: started?.mode || "",
				redirectUri: started?.redirectUri || "",
				// 授权页这条路走不通（服务器不提供 OAuth 发现、动态注册被拒…）时，
				// 手填令牌仍然是可用通道：把它交给面板，别只留一行红字。
				manualTokenOnly: started?.manualTokenOnly === true,
				serverUrl: started?.serverUrl || target.url,
			};
		}
		// 默认由宿主直接把授权页推给系统浏览器；open:false 留给面板自己渲染链接。
		const opened = payload?.open === false ? { opened: false } : await openExternalUrl(this.ctx, started.authorizeUrl);
		return {
			ok: true,
			connectorId,
			serverName: target.serverName,
			sessionId: started.sessionId,
			authorizeUrl: started.authorizeUrl,
			mode: started.mode,
			redirectUri: started.redirectUri,
			hint: started.hint || "",
			opened: opened.opened === true,
			openVia: opened.via || (opened.opened ? "" : String(opened.reason || "")),
		};
	}
	async wbOAuthPoll(payload) {
		const sessionId = String(payload?.sessionId || "").trim();
		if (!sessionId) throw new Error("缺少 sessionId");
		const callbackUrl = String(payload?.callbackUrl || "").trim();
		// 自定义 scheme 回调（如 workbuddy://…）浏览器打不开，面板让用户把整条回调
		// URL 粘回来，这里顺手换成 code 再去换 token。
		if (callbackUrl) {
			const submitted = await oauthSubmitCallback(sessionId, callbackUrl);
			if (submitted && submitted.ok === false && submitted.status !== "authorized") return submitted;
		}
		return oauthStatus(sessionId);
	}
	async wbOAuthCancel(payload) {
		const sessionId = String(payload?.sessionId || "").trim();
		if (sessionId) oauthCancel(sessionId);
		return { ok: true };
	}
	async wbOAuthToken(payload) {
		const connectorId = String(payload?.connectorId || "").trim();
		if (!connectorId) throw new Error("缺少 connectorId");
		const target = await resolveOAuthTarget(connectorId, payload?.serverName);
		const token = String(payload?.token || "").trim();
		if (!token) {
			// 空 token = 撤销授权（清掉本地记录），面板的「撤销授权」按钮走这条路。
			await oauthClearToken(target.url);
			return { ok: true, cleared: true, connectorId, serverName: target.serverName };
		}
		const saved = await oauthSaveManualToken({ serverUrl: target.url, serverName: target.serverName, token });
		return { ok: saved?.ok !== false, connectorId, serverName: target.serverName, ...(saved || {}) };
	}
	async wbOAuthOverview(payload) {
		const connectorId = String(payload?.connectorId || "").trim();
		if (!connectorId) throw new Error("缺少 connectorId");
		const target = await resolveOAuthTarget(connectorId, payload?.serverName).catch(() => null);
		if (!target) return { ok: true, authorized: false, connectorId, serverName: "" };
		const overview = await oauthOverview(target.url).catch(() => null);
		return { ok: true, connectorId, serverName: target.serverName, ...(overview || {}) };
	}
	// R8/P0：强制刷新已存的 OAuth token（有 refresh_token 才刷得动）。面板的「刷新授权」
	// 走这里，再调用一次 wbConnectorInstall 把新凭据写回 headers——mcp-client 只在建立连接时
	// 快照 headers，光刷令牌库不改配置等于没刷。
	// 刷不动（没有 refresh_token / 已被服务端撤销）时回 needsAuth:true，让面板回到浏览器授权，
	// 而不是给一条「刷新失败」的死胡同。
	async wbOAuthRefresh(payload) {
		const connectorId = String(payload?.connectorId || "").trim();
		if (!connectorId) throw new Error("缺少 connectorId");
		const target = await resolveOAuthTarget(connectorId, payload?.serverName);
		const before = await oauthOverview(target.url).catch(() => null);
		if (!before?.authorized) {
			return {
				ok: false,
				connectorId,
				serverName: target.serverName,
				authorized: false,
				needsAuth: true,
				error: "该连接器还没有授权记录，请先完成授权",
			};
		}
		const ensured = await oauthEnsureToken(target.url, { force: true })
			.catch((error) => ({ ok: false, error: error?.message || String(error) }));
		const after = await oauthOverview(target.url).catch(() => null);
		if (!ensured?.ok) {
			return {
				ok: false,
				connectorId,
				serverName: target.serverName,
				authorized: Boolean(after?.authorized),
				needsAuth: true,
				refreshable: Boolean(after?.refreshable),
				expiresAt: after?.expiresAt || "",
				error: ensured?.error || "刷新授权失败",
			};
		}
		return {
			ok: true,
			connectorId,
			serverName: target.serverName,
			authorized: true,
			refreshed: ensured.refreshed === true,
			expiresAt: after?.expiresAt || "",
			refreshable: Boolean(after?.refreshable),
		};
	}
	async wbOAuthOpen(payload) {
		const opened = await openExternalUrl(this.ctx, payload?.url);
		return { ok: opened.opened === true, ...opened };
	}
	async wbSkillCatalog(payload) {
		const marketApi = await loadMarket();
		return marketApi.wbSkillCatalog(payload || {});
	}
	async wbSkillDetail(payload) {
		const marketApi = await loadMarket();
		return marketApi.wbSkillDetail(payload || {});
	}
	async wbSkillInstall(payload) {
		const marketApi = await loadMarket();
		// 安装进度经 ctx.logger 落到宿主日志（Remote 单次调用没有流式回传通道，面板按
		// 阶段提示「正在下载与校验」，完成后一次拿到结果与 note）。
		const result = await marketApi.wbSkillInstall(payload || {}, {
			onProgress: (progress) => this.ctx.logger?.debug?.(`wb-market: ${progress.phase} ${progress.index}/${progress.total}`),
		});
		// T04/R8：装成功后登记本地状态。key 取不到就跳过（record 对空 key 会抛错）。
		const key = result?.name || payload?.slug || payload?.name || "";
		if (key) {
			try {
				await recordInstallState({
					kind: "skill",
					key,
					name: result?.name || payload?.name || key,
					version: result?.version || "",
					installPath: result?.dir || "",
					source: { kind: "marketplace", marketplace: "workbuddy-skills" },
				});
			} catch (error) {
				this.ctx.logger?.warn?.(`wb-market: 技能 ${key} 安装状态登记失败（不影响安装结果）：${error?.message || error}`);
			}
		}
		return result;
	}
	async wbSkillUninstall(payload) {
		const marketApi = await loadMarket();
		return marketApi.wbSkillUninstall(payload || {});
	}
	async wbSkillInstalled() {
		const marketApi = await loadMarket();
		return marketApi.wbSkillInstalled();
	}
	// ── T03/R4：多市场注册表 ────────────────────────────────────────────
	// 数据层在 lib/wb-registry.js（T01）；这里只做 RPC 转发。读 = 合并投影（内置默认
	// 永远在场）；增改 = upsert 一条后返回新的合并投影。缺 id 时 wb-registry 抛错。
	async wbMarketRegistry() {
		return readRegistry();
	}
	async wbMarketRegistryUpsert(payload) {
		return upsertMarketplace(payload || {});
	}
	// ── T04/R8：安装状态账本（connector / skill / plugin 三类安装的统一登记） ──
	async wbInstallState() {
		return readInstallState();
	}

	async wbInstallStateRecord(payload) {
		if (!payload || typeof payload !== "object") throw new Error("缺少安装状态条目");
		await recordInstallState(payload);
		return { note: `已登记安装状态：${payload.kind || "connector"}/${payload.key}` };
	}

	async wbInstallStateForget(payload) {
		const kind = String(payload?.kind || "").trim();
		const key = String(payload?.key || "").trim();
		if (!kind || !key) throw new Error("缺少 kind 或 key");
		await forgetInstallState(kind, key);
		return { note: `已移除安装状态：${kind}/${key}` };
	}

	// ── T06/Awesome：DSH 社区插件市场（awesome-dsh-plugins）──────────────
	// 数据层在 lib/wb-awesome-market.js；这里只做 RPC 转发。
	async wbAwesomeCatalog(payload) {
		return wbAwesomeCatalog(payload || {});
	}
	async wbAwesomeDetail(payload) {
		return wbAwesomeDetail(payload?.name);
	}
	async wbAwesomeReadme(payload) {
		return wbAwesomeReadme(payload || {});
	}
	async wbAwesomeUpdateCheck() {
		return wbAwesomeUpdateCheck();
	}
	// ── 社区 MCP（官方 MCP Registry v0，只读）──────────────────────────
	// 数据层在 lib/mcp-community.js；这里只做 RPC 转发。只 GET：不写盘、不执行命令、
	// 不落任何凭据。payload {search, cursor, limit, takenNames}，形状由数据层校验。
	async wbMcpCommunityList(payload) {
		return wbMcpCommunityList(payload || {});
	}
	// 社区目录全库总数的有界统计：payload {cursor, pages}，返回 {ok, counted, nextCursor, done, pages}。
	// 官方 Registry 不给总数，只能顺游标数，所以这里一次最多 12 页；进度由面板侧存 localStorage、
	// 跨会话续爬。同样只 GET：不写盘、不执行命令、不落凭据、不进任何缓存。
	async wbMcpCommunityCount(payload) {
		return wbMcpCommunityCount(payload || {});
	}
	// ── 社区元信息：仓库「人味」信号（维护者 / 最近提交 / issue / star）────────
	// 详情弹层按需调用，只读公开接口，6 小时缓存；不接收也不保存任何凭据。
	async wbRepoMeta(payload) {
		return wbRepoMeta(payload || {});
	}
	// ── npm 近 30 天下载量（只读）───────────────────────────────────────
	// 卡片进视口才按需批量取，7 天缓存；只读公开统计接口，不接收也不保存任何凭据。
	async wbNpmDownloads(payload) {
		return wbNpmDownloads(payload || {});
	}
	// ── 装备清单（只读）────────────────────────────────────────────────
	// 导出：收集本机全局 MCP / 技能 / 已召唤专家 / 已装插件，只留身份字段。
	// 对比：校验用户贴入的清单并与本机做差异，返回逐条状态；不安装、不写盘。
	async wbLoadoutExport(payload) {
		const items = await collectLoadoutItems(this.ctx);
		return {
			ok: true,
			loadout: buildLoadout({
				name: payload?.name,
				items,
				appVersion: pluginVersion(),
			}),
		};
	}
	async wbLoadoutDiff(payload) {
		const raw = payload?.loadout ?? payload?.text ?? payload;
		const items = await collectLoadoutItems(this.ctx);
		return { ok: true, ...diffLoadout(raw, items) };
	}
	// ── WorkBuddy 专家直连（召唤预设 + 捆绑技能）────────────────────────
	// 数据与安装逻辑都在 lib/expert-market.js；这里只做 RPC 转发与 patch 写盘收尾。
	// 召唤 = 往 profile patch 插入一条独立 @deepseek-ai/dsh-agent-preset 行（persona.prefix
	// = 专家人设），DSH 热加载后新会话即可在预设选择器里选它——多专家共存，卸载即摘除。
	// ── 会话级专家人设（随时挂 / 换 / 摘，不受 agent-preset/locked 限制）──────
	// 机制与边界见 lib/session-persona.js 顶部注释：走 systemPrompt 的会话作用域
	// section，遮蔽该会话的部署人设前缀；不动工具目录、不写任何持久化配置。
	async expertAttach(payload) {
		const sessionId = String(payload?.sessionId || "").trim();
		const plugin = String(payload?.plugin || "").trim();
		if (!sessionId) throw new Error("缺少 sessionId");
		if (!plugin) throw new Error("缺少 plugin");
		const expertApi = await loadExpert();
		const detail = await expertApi.wbExpertDetail({ plugin });
		// 团队型：成员人设先落盘，主理人人设末尾追加 DSH 桥接段（与召唤预设同一套）。
		const prepared = await expertApi.prepareExpertPersona(detail, {
			onLog: (message) => this.ctx.logger?.debug?.(`wb-expert: ${message}`),
		});
		const result = attachPersona(this.ctx, sessionId, {
			plugin,
			name: detail.name,
			personaText: prepared.personaText,
		}, {
			// 替身人设不写进 session-persona 的粘性选择：它只是原文缺失时的占位，
			// 落盘后即使上游补回原文也会一直沿用。重启后重新召唤即可拿到最新正文。
			persist: detail.personaSource !== "generated",
		});
		await expertApi.recordExpertRecent("expert", { plugin, name: detail.name, profession: detail.profession, presetId: `session-${plugin}` }).catch(() => {});
		return {
			...result,
			personaSource: detail.personaSource,
			personaNotice: detail.personaNotice,
			profession: detail.profession,
			expertType: detail.expertType,
			members: detail.members || [],
			memberNotes: prepared.memberResult?.notes || [],
		};
	}
	async expertDetach(payload) {
		const sessionId = String(payload?.sessionId || "").trim();
		if (!sessionId) throw new Error("缺少 sessionId");
		return detachPersona(this.ctx, sessionId);
	}
	async expertActive() {
		reconcilePersonas(this.ctx);
		return { sessions: listPersonas() };
	}
	async wbExpertCatalog() {
		const expertApi = await loadExpert();
		return expertApi.wbExpertCatalog();
	}
	async wbExpertDetail(payload) {
		const expertApi = await loadExpert();
		return expertApi.wbExpertDetail(payload || {});
	}
	async wbExpertSummon(payload) {
		const plugin = String(payload?.plugin || "").trim();
		if (!plugin) throw new Error("缺少 plugin");
		const expertApi = await loadExpert();
		// 详情即预览：召唤写盘前拉一次真实人设与技能清单，失败则整体不动。
		const detail = await expertApi.wbExpertDetail({ plugin });
		const withSkills = payload?.withSkills !== false && detail.skills.length > 0;
		// 团队型：成员人设先落盘（人设不进 preset，避免每轮白付），主理人人设追加桥接段。
		const prepared = await expertApi.prepareExpertPersona(detail, {
			onLog: (message) => this.ctx.logger?.debug?.(`wb-expert: ${message}`),
		});
		// 技能先落盘（失败只影响技能，不阻断召唤），预设行再走唯一写链（文件锁 + 版本校验 + 原子写）。
		let skillResult = { installed: [], notes: [] };
		if (withSkills) {
			skillResult = await expertApi.installExpertSkills(plugin, detail.skills.map((skill) => skill.name), {
				onLog: (message) => this.ctx.logger?.debug?.(`wb-expert: ${message}`),
			});
		}
		const result = await withPatchWrite(this.ctx, async () => {
			const state = await managedState(this.ctx);
			const written = expertApi.writeExpertPreset(state.content, {
				plugin,
				displayName: detail.name,
				profession: detail.profession,
				description: detail.description,
				personaText: prepared.personaText,
			});
			if (written.content === state.content) return { mode: "unchanged", presetId: written.presetId };
			await writePatch(state, written.content);
			return { mode: written.mode, presetId: written.presetId };
		});
		// 召唤成功即记入最近使用（送还由 listExpertRecent 对账剔除）。记录失败不阻断召唤。
		await expertApi.recordExpertRecent("expert", { plugin, name: detail.name, profession: detail.profession, presetId: result.presetId }).catch(() => {});
		const teamMembers = prepared.memberResult?.installed || [];
		// upsert 后核对人设正文是否真带桥接段（团队型）；不带则提示更新结果不完整。
		// 正常路径 prepared.personaText 已拼桥接段，这个分支只在异常数据时触发。
		const staleBridge = detail.expertType === "team" && !expertApi.hasTeamBridge(prepared.personaText);
		return {
			presetId: result.presetId,
			presetMode: result.mode,
			expertType: detail.expertType,
			members: detail.members || [],
			summonedSkills: skillResult.installed,
			skillNotes: skillResult.notes,
			summonedMembers: teamMembers,
			memberNotes: prepared.memberResult?.notes || [],
			staleBridge,
			note: `已召唤「${detail.name}」：新会话选择预设「WorkBuddy 专家 · ${detail.name}」即专家人设接管`
				+ (result.mode === "unchanged" ? "（预设已是最新，未改动）" : "")
				+ (result.mode === "updated" ? "（旧预设行已刷新为人设最新版）" : "")
				+ (teamMembers.length ? `；团队成员人设 ${teamMembers.length} 份已落盘，主理人按编制用 subagent 调度` : "")
				+ (skillResult.installed.length ? `；捆绑技能 ${skillResult.installed.length} 个已装进 ~/.agents/skills/` : "")
				+ ([...(prepared.memberResult?.notes || []), ...skillResult.notes].length ? `；注意：${[...(prepared.memberResult?.notes || []), ...skillResult.notes].join("；")}` : ""),
		};
	}
	async wbExpertDismiss(payload) {
		const plugin = String(payload?.plugin || "").trim();
		if (!plugin) throw new Error("缺少 plugin");
		const expertApi = await loadExpert();
		const result = await withPatchWrite(this.ctx, async () => {
			const state = await managedState(this.ctx);
			const content = expertApi.removeExpertPreset(state.content, plugin);
			if (content === null) return { mode: "absent" };
			await writePatch(state, content);
			return { mode: "removed" };
		});
		// 捆绑技能一并清掉（该 plugin 前缀下的全部目录；失败不回滚预设摘除——写是既成事实）。
		let removedSkills = [];
		try {
			removedSkills = await expertApi.uninstallExpertSkills(plugin);
		} catch (error) {
			this.ctx.logger?.warn?.(`wb-expert: 预设已摘除，但技能清理失败：${error?.message ?? error}`);
		}
		// 团队型：成员人设目录同样按 plugin 隔离，一并清除。
		let removedTeam = null;
		try {
			removedTeam = await expertApi.uninstallTeamMemberPersonas(plugin);
		} catch (error) {
			this.ctx.logger?.warn?.(`wb-expert: 预设已摘除，但成员人设清理失败：${error?.message ?? error}`);
		}
		if (result.mode === "absent" && !removedSkills.length && !removedTeam) throw new Error("本机没有召唤过这个专家（profile patch 里没有对应预设行）");
		return {
			removedSkills,
			removedTeam,
			note: `已送还「${plugin}」`
				+ (result.mode === "removed" ? "：召唤预设已从 profile patch 摘除（热加载，无需重启）" : "：本没有召唤预设")
				+ (removedSkills.length ? `；捆绑技能已清理 ${removedSkills.length} 个目录` : "")
				+ (removedTeam ? "；团队成员人设已清理" : ""),
		};
	}
	async wbExpertInstalled() {
		// 已召唤 = profile patch 里的召唤预设行；已装技能 = ~/.agents/skills 的 wbexpert__ 目录。
		// patch 读走与 managedState 同一条解析（readPatch），但不持写锁——只读快照。
		// 团队行做 stale 体检：人设正文缺桥接段 = 旧版本召唤写入的行，新会话选它会调
		// 不存在的 TeamCreate/Agent（成员开不出来）。标记桥接判定放前端（需要市场目录的
		// expertType），这里只把 personaText 原样带出去。
		const patch = await readPatch(this.ctx);
		const expertApi = await loadExpert();
		const presets = expertApi.readExpertPresets(patch.content);
		// patch 只记 plugin / presetId，中英显示名在专家目录缓存里。这里补上两个字段，
		// 客户端按宿主语言挑：中文名给中文界面，英文名给英文界面。读缓存失败只回落
		// plugin 名，不影响「已召唤 / 已装技能」本身的状态判断。
		// 回落有三层（目录缓存 → 预设行自带的名字 → 英文标识名）：召唤那一刻
		// `WorkBuddy 专家 · <显示名>` 就写进了 patch 行，readExpertPresets 剥前缀即得，
		// 所以目录没落盘 / 专家已下架时菜单仍能出「吴八哥」，而不是 senior-developer。
		let displayNames = new Map();
		try {
			displayNames = await expertApi.readExpertDisplayNames();
		} catch (error) {
			this.ctx.logger?.warn?.(`wb-expert: 读取专家显示名失败：${error?.message ?? error}`);
		}
		return {
			presets: presets.map((row) => {
				const info = displayNames.get(row.plugin) || {};
				return {
					...row,
					...info,
					nameZh: info.nameZh || row.displayName || "",
					nameEn: info.nameEn || row.displayName || "",
				};
			}),
			skills: await expertApi.listExpertSkills(),
		};
	}
	// 最近使用记录（输入框召唤菜单的数据源）：召唤/送还时自动记录专家；技能与 MCP 由
	// 客户端在用户从菜单里显式选用时上报（recordUse）。只存展示所需最小字段。
	async wbExpertRecent() {
		const expertApi = await loadExpert();
		return expertApi.listExpertRecent();
	}
	async wbExpertRecordUse(payload) {
		const kind = String(payload?.kind || "").trim();
		const row = payload?.row && typeof payload.row === "object" ? payload.row : null;
		const expertApi = await loadExpert();
		return expertApi.recordExpertRecent(kind, row);
	}
	};
})();

export { McpManagerGateway, McpManagerGateway as default };
