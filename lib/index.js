import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { interpolate } from "@deepseek-ai/cordis-plugin-loader";
import { withFileLock, writeFileAtomic } from "@deepseek-ai/dsh-atomic-write";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendSelectedBuiltinMcpServers, BUILTIN_MCP_SERVERS, builtinMcpCatalog, normalizeMcpImport, readManagedMcpServers, setManagedMcpDisabled, updateManagedMcpPatch } from "./mcp-config.js";
import { admitImportedServers } from "./import-admission.js";
import { collectImportLocations, missingEnvNames, resolveImportLocation } from "./mcp-import-sources.js";
import { deriveMcpPhase, formatMcpLog, sanitizeMcpLog } from "./mcp-observability.js";
import { allMcpEntries, entriesForName, projectToolSchema, revisionOf, toolInventory } from "./mcp-registry.js";
import { WHATS_NEW } from "./whats-new.js";
import { wbConnectorCatalog, wbConnectorPreview, wbSkillCatalog, wbSkillDetail, wbSkillFiles, wbSkillInstall, wbSkillInstalled, wbSkillUninstall } from "./wb-market.js";
import { evaluateEnvExpression, jsExpressionToTemplate } from "./workspace-config.js";
import { canonicalWorkspacePath, installAgentRuntime, listWorkspaceRecords, liveWorkspaceAgentCount, projectConnectionsView, readWorkspaceConfigCached, reconcileWorkspaceConnections, reconcileWorkspaceRestricts, reconnectWorkspaceServer, withWorkspaceWrite, workspaceConnectionStatus, workspaceMountErrorsView, workspaceRestrictErrorView, workspaceScopeErrorsView, workspaceToolSchemas, writeWorkspaceConfigFile } from "./workspace-runtime.js";

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
function effectiveMcpServers(ctx, state) {
	return [
		...state.servers,
		...externalMcpEntries(ctx, state).map((entry) => ({ ...entry.options.config, name: entry.options.config.serverName })),
	];
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
// 被 DSH_MCP_MANAGER_DISABLE_UPDATE_CHECK 禁用时静默无提示——这是有意设计：
// 更新提示是纯增值信息，不允许影响面板可用性；除这一条 GET 外不发送任何数据。
const UPDATE_CHECK_URL = "https://api.github.com/repos/2026heshao/dsh-skill-mcp-board/releases/latest";
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 5000;
const UPDATE_CHECK_DISABLED_ENV = "DSH_MCP_MANAGER_DISABLE_UPDATE_CHECK";
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

// skill 查询的 scope 参数：cwd 来自看板当前选中的作用域标签（全局 = undefined，项目 = wsPath）。
// scope 刻意不透传：Agent 预设作用域链是会话视角，看板只看全局层。
function skillScopeOptions(payload) {
  const wsPath = payload?.cwd === undefined ? payload?.wsPath : payload.cwd;
  return wsPath ? { cwd: canonicalWorkspacePath(String(wsPath)) } : {};
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
	return row;
}
// 项目 MCP 的行状态：与全局 summarize() 走**同一套规则、同一个判定函数**（deriveMcpPhase），
// 不再另写一套。「已连接」的唯一证据是工具数；连接态本身取自 cordis fiber 的状态代号
// （mcp-client 的 apply 要等首次连接与 tools/list 结束才让 fiber ACTIVE，所以 ACTIVE + 0 工具
// 已经是不可用的终态证据），而不是去猜 mcp-client 的日志文案；日志只用来填 lastError 的
// 具体原因。挂载失败（我们自己 setup 阶段就挂不上：配置求值为空、工具注册被拒）与连接
// 失败（mcp-client 那边的事）分开标记，不混为一谈。
// 已导出作为测试接缝（同 checkForUpdate）。
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
		if (unknown.length) throw new Error(`来源中没有可导入的 MCP：${unknown.join(", ")}`);
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

let McpManagerGateway = (() => {
	let _classSuper = TypertRemoteService;
	let _instanceExtraInitializers = [];
	let _list_decorators, _status_decorators, _enable_decorators, _disable_decorators, _reconnect_decorators, _tools_decorators, _builtins_decorators, _installBuiltins_decorators, _add_decorators, _update_decorators, _remove_decorators, _reveal_decorators, _previewImport_decorators, _importJson_decorators, _listWorkspaces_decorators, _getWorkspaceView_decorators, _addWorkspaceServer_decorators, _updateWorkspaceServer_decorators, _removeWorkspaceServer_decorators, _setWorkspaceExclude_decorators, _installWorkspaceBuiltins_decorators, _previewWorkspaceImport_decorators, _importWorkspaceJson_decorators, _revealWorkspaceServer_decorators, _projectConnections_decorators, _reconnectWorkspaceServer_decorators, _updateHint_decorators, _whatsNew_decorators, _scanImportSources_decorators, _previewImportSource_decorators, _importSource_decorators;
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
			_builtins_decorators = [Remote("builtins")];
			__esDecorate(this, null, _builtins_decorators, { kind: "method", name: "builtins", static: false, private: false, access: { has: (obj) => "builtins" in obj, get: (obj) => obj.builtins }, metadata: _metadata }, null, _instanceExtraInitializers);
			_installBuiltins_decorators = [Remote("installBuiltins")];
			__esDecorate(this, null, _installBuiltins_decorators, { kind: "method", name: "installBuiltins", static: false, private: false, access: { has: (obj) => "installBuiltins" in obj, get: (obj) => obj.installBuiltins }, metadata: _metadata }, null, _instanceExtraInitializers);
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
			_addWorkspaceServer_decorators = [Remote("addWorkspaceServer")];
			__esDecorate(this, null, _addWorkspaceServer_decorators, { kind: "method", name: "addWorkspaceServer", static: false, private: false, access: { has: (obj) => "addWorkspaceServer" in obj, get: (obj) => obj.addWorkspaceServer }, metadata: _metadata }, null, _instanceExtraInitializers);
			_updateWorkspaceServer_decorators = [Remote("updateWorkspaceServer")];
			__esDecorate(this, null, _updateWorkspaceServer_decorators, { kind: "method", name: "updateWorkspaceServer", static: false, private: false, access: { has: (obj) => "updateWorkspaceServer" in obj, get: (obj) => obj.updateWorkspaceServer }, metadata: _metadata }, null, _instanceExtraInitializers);
			_removeWorkspaceServer_decorators = [Remote("removeWorkspaceServer")];
			__esDecorate(this, null, _removeWorkspaceServer_decorators, { kind: "method", name: "removeWorkspaceServer", static: false, private: false, access: { has: (obj) => "removeWorkspaceServer" in obj, get: (obj) => obj.removeWorkspaceServer }, metadata: _metadata }, null, _instanceExtraInitializers);
			_setWorkspaceExclude_decorators = [Remote("setWorkspaceExclude")];
			__esDecorate(this, null, _setWorkspaceExclude_decorators, { kind: "method", name: "setWorkspaceExclude", static: false, private: false, access: { has: (obj) => "setWorkspaceExclude" in obj, get: (obj) => obj.setWorkspaceExclude }, metadata: _metadata }, null, _instanceExtraInitializers);
			_installWorkspaceBuiltins_decorators = [Remote("installWorkspaceBuiltins")];
			__esDecorate(this, null, _installWorkspaceBuiltins_decorators, { kind: "method", name: "installWorkspaceBuiltins", static: false, private: false, access: { has: (obj) => "installWorkspaceBuiltins" in obj, get: (obj) => obj.installWorkspaceBuiltins }, metadata: _metadata }, null, _instanceExtraInitializers);
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
			if (_metadata) Object.defineProperty(this, Symbol.metadata, { enumerable: true, configurable: true, writable: true, value: _metadata });
		}
		static inject = ["loader", "tools"];
		constructor(ctx) {
			super(ctx, "mcpManager");
			ensureLogCapture(ctx);
			installAgentRuntime(ctx);
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
		async builtins() {
			const state = await managedState(this.ctx);
			return { builtins: builtinMcpCatalog(effectiveMcpServers(this.ctx, state)) };
		}
		async installBuiltins(payload) {
			return withPatchWrite(this.ctx, async () => {
				const state = await managedState(this.ctx);
				const result = appendSelectedBuiltinMcpServers(
					state.content,
					effectiveMcpServers(this.ctx, state),
					payload?.ids,
					{ reservedIds: reservedEntryIds(this.ctx) },
				);
				if (result.content !== state.content) await writePatch(state, result.content);
				const notes = [];
				if (result.added.length) notes.push(`已追加：${result.added.join(", ")}`);
				if (result.skipped.length) notes.push(`已存在并跳过：${result.skipped.join(", ")}`);
				const { content: _content, ...summary } = result;
				return { ...summary, note: notes.join("；") || "未修改配置" };
			});
		}
		async add(spec) {
			if (containsRedactedValue(spec)) throw new Error("新增 MCP 不能包含保留原值标记");
			const normalized = normalizeOne(spec);
			return withPatchWrite(this.ctx, async () => {
				const state = await managedState(this.ctx);
				if (hasExternalMcpName(this.ctx, state, normalized.name) || state.byName.has(normalized.name)) throw new Error("MCP already exists: " + normalized.name);
				await writePatch(state, updateManagedMcpPatch(state.content, [normalized], { replace: false, reservedIds: reservedEntryIds(this.ctx) }));
				return { note: "已添加到 profile patch，正在热加载" };
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
				return { note: "已更新 profile patch，正在热加载" };
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
		async installWorkspaceBuiltins(payload) {
			const wsPath = canonicalWorkspacePath(String(payload?.wsPath || ""));
			const ids = payload?.ids;
			if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === "string")) throw new Error("内置 MCP ids 必须是非空字符串数组");
			const result = await withWorkspaceWrite(wsPath, async () => {
				const config = await readWorkspaceConfigCached(this.ctx, wsPath);
				if (config.error) throw new Error(config.error);
				const known = new Map(BUILTIN_MCP_SERVERS.map((builtin) => [builtin.id, builtin]));
				const unknown = ids.filter((id) => !known.has(id));
				if (unknown.length) throw new Error(`未知的内置 MCP：${unknown.join(", ")}`);
				const existing = new Set(config.servers.map((server) => server.name));
				const added = [];
				const skipped = [];
				for (const id of ids) {
					const builtin = known.get(id);
					if (existing.has(builtin.name)) { skipped.push(id); continue; }
					const spec = { name: builtin.name };
					for (const field of ["transport", "command", "args", "env", "cwd", "url", "headers", "toolCallTimeoutMs", "failOnStartupError", "reconnect"]) {
						if (builtin[field] !== undefined) spec[field] = structuredClone(builtin[field]);
					}
					added.push(spec);
				}
				if (!added.length) return { note: skipped.length ? `已存在并跳过：${skipped.join(", ")}` : "未修改配置", unchanged: true };
				await writeWorkspaceConfigFile(wsPath, [...config.servers, ...added], config.exclude);
				return { note: `已追加：${added.map((server) => server.name).join(", ")}${skipped.length ? `；已存在并跳过：${skipped.join(", ")}` : ""}` };
			});
			// 没写盘就不用对齐（否则每次点"安装内置"都会白跑一遍挂载）。
			if (!result.unchanged) await alignWorkspaceConnections(this.ctx, wsPath);
			return { note: result.note };
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
	async whatsNew() {
		// 只回数据，不在宿主判定「该不该弹」：「上次看到的版本」是每台浏览器自己的事实
		// （localStorage），宿主没有这个视角；判定在客户端（whatsNewFor）。
		return { current: pluginVersion(), entries: WHATS_NEW };
	}
	// ── Skill 看板 ────────────────────────────────────────────────────
	// 数据真源是 @deepseek-ai/dsh-skill 的 ctx.skills 注册表，本插件只做投影与只读定位，
	// 不发现、不缓存、不写盘——发现与去重仍归注册表。注册表缺席时返回 available:false，
	// 看板如实说「不可用」，而不是 500。
	async listSkills(payload) {
		const registry = typeof this.ctx.get === "function" ? this.ctx.get("skills") : undefined;
		if (!registry || typeof registry.list !== "function") return { available: false, skills: [] };
		const options = skillScopeOptions(payload);
		const rows = await registry.list(options);
		return {
			available: true,
			skills: rows.map((skill) => ({
				name: skill.name,
				description: skill.description,
				...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
				...skill.path === undefined ? {} : { path: skill.path },
				source: skill.source,
				provider: skill.provider,
				modelInvocable: !!skill.invocation?.modelInvocable,
				userInvocable: !!skill.invocation?.userInvocable,
			})),
		};
	}
	async skillDetail(payload) {
		const registry = typeof this.ctx.get === "function" ? this.ctx.get("skills") : undefined;
		if (!registry || typeof registry.get !== "function") throw new Error("宿主没有挂载 skill 注册表（@deepseek-ai/dsh-skill），读不了 skill 内容");
		const name = String(payload?.name || "");
		if (!name) throw new Error("缺少 skill 名称");
		const skill = await registry.get(name, skillScopeOptions(payload));
		if (!skill) throw new Error("没有找到这个 skill（可能刚被移动或删除）：" + name);
		return {
			skill: {
				name: skill.name,
				description: skill.description,
				...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
				...skill.path === undefined ? {} : { path: skill.path },
				source: skill.source,
				provider: skill.provider,
				modelInvocable: !!skill.invocation?.modelInvocable,
				userInvocable: !!skill.invocation?.userInvocable,
				content: skill.content,
			},
		};
	}
	async revealSkill(payload) {
		const path = String(payload?.path || "");
		if (!path) throw new Error("该 skill 没有可打开的文件路径（运行时注册的 skill 不在磁盘上）");
		const shell = typeof this.ctx.get === "function" ? this.ctx.get("shell") : undefined;
		if (shell && typeof shell.showItemInFolder === "function") { shell.showItemInFolder(path); return { note: "已在资源管理器中定位" }; }
		if (shell && typeof shell.openExternal === "function") { shell.openExternal(path); return { note: "已交给宿主打开" }; }
		const { spawn } = await import("node:child_process");
		if (process.platform === "win32") spawn("explorer", ["/select,", path], { detached: true, stdio: "ignore" }).unref();
		else spawn(process.platform === "darwin" ? "open" : "xdg-open", [path], { detached: true, stdio: "ignore" }).unref();
		return { note: "已交给系统打开" };
	}
	// ── WorkBuddy 市场直连（连接器 MCP + SkillHub 技能）─────────────────
	// 数据与安装逻辑都在 lib/wb-market.js；这里只做 RPC 转发与作用域相关的写盘收尾。
	// 连接器安装复用 applyManagedImport / applyWorkspaceImport：准入、同名跳过、entry id
	// 预留、项目对齐全部与粘贴导入同一条链路，市场只是多了一个「JSON 从哪来」的来源。
	async wbConnectorCatalog() {
		return wbConnectorCatalog();
	}
	async wbConnectorPreview(payload) {
		return wbConnectorPreview(payload?.connectorId);
	}
	async wbConnectorInstall(payload) {
		const connectorId = String(payload?.connectorId || "").trim();
		if (!connectorId) throw new Error("缺少 connectorId");
		const mode = payload?.mode === "replace" ? "replace" : "merge";
		const wsPath = payload?.wsPath ? canonicalWorkspacePath(String(payload.wsPath)) : "";
		const preview = await wbConnectorPreview(connectorId);
		const json = { mcpServers: preview.mcpServers };
		return wsPath
			? applyWorkspaceImport(this.ctx, wsPath, admittedImport(json), mode)
			: applyManagedImport(this.ctx, admittedImport(json), mode);
	}
	async wbSkillCatalog(payload) {
		return wbSkillCatalog(payload || {});
	}
	async wbSkillDetail(payload) {
		return wbSkillDetail(payload || {});
	}
	async wbSkillInstall(payload) {
		// 安装进度经 ctx.logger 落到宿主日志（Remote 单次调用没有流式回传通道，面板按
		// 阶段提示「正在下载与校验」，完成后一次拿到结果与 note）。
		const result = await wbSkillInstall(payload || {}, {
			onProgress: (progress) => this.ctx.logger?.debug?.(`wb-market: ${progress.phase} ${progress.index}/${progress.total}`),
		});
		return result;
	}
	async wbSkillUninstall(payload) {
		return wbSkillUninstall(payload || {});
	}
	async wbSkillInstalled() {
		return wbSkillInstalled();
	}
	};
})();

export { checkForUpdate, McpManagerGateway, McpManagerGateway as default, summarizeWorkspaceRow };