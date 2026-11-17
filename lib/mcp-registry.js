import { createHash } from "node:crypto";

// loader 中的 MCP 条目视图与工具归属推断。这一层只认 loader/tools 两个宿主服务，
// 不涉及 profile patch 与 workspace 概念，因此可以被全局层与项目层同时依赖而不成环。
const MCP_NAME = "@deepseek-ai/dsh-mcp-client";

// 官方 mcp-manager（DSH 0.2.2-rc.2 起随 dsh-web-app 的 bundle patch 分发）把每个
// server 挂成自己的子实例，**不是 loader 条目**——`ctx.loader.entries()` 里只有那一个
// `dsh-mcp-manager` 条目，所以下面的 allMcpEntries 永远看不见被它托管的服务器（issue #23）。
// 这里补一条只读投影：配置读 manager 的公开 Volatile（`config.servers.get()`），状态读
// `list()`。服务缺席（旧宿主）或读取失败时返回空数组，面板退回原行为。

// All valid MCP entries include read-only entries from bundles, presets, and
// nested loader trees. Mutation checks in callers still require the profile entry id.
function allMcpEntries(ctx) {
	return [...ctx.loader.entries()].filter((entry) => entry.options.name === MCP_NAME && typeof entry.options.config?.serverName === "string");
}

function managerService(ctx) {
	try {
		return typeof ctx?.get === "function" ? ctx.get("mcpManager") : undefined;
	} catch {
		return undefined;
	}
}

function managerViews(manager) {
	try {
		const views = typeof manager?.list === "function" ? manager.list() : [];
		return Array.isArray(views) ? views : [];
	} catch {
		return [];
	}
}

/**
 * 官方 mcp-manager 托管的服务器（只读投影）。名字即 tool 命名空间。
 * 不把 manager 的条目塞进 allMcpEntries：那个列表同时供写路径（enable/remove/reveal）
 * 使用，合成条目没有 profile 条目 id，混进去只会让写路径拿到不存在的目标。
 * @returns {{serverName: string, config: object, enabled: boolean, configured: boolean, status: object|null}[]}
 */
function managedServers(ctx) {
	const manager = managerService(ctx);
	if (!manager) return [];
	let servers = {};
	try {
		const ref = manager.config?.servers;
		const value = typeof ref?.get === "function" ? ref.get() : ref;
		if (value && typeof value === "object") servers = value;
	} catch {
		servers = {};
	}
	const views = new Map(managerViews(manager).map((view) => [view?.name, view]));
	const rows = [];
	for (const [name, config] of Object.entries(servers)) {
		if (typeof name !== "string" || !name || !config || typeof config !== "object") continue;
		const view = views.get(name);
		rows.push({
			serverName: name,
			config: { ...config },
			enabled: config.enabled !== false,
			configured: view ? view.configured !== false : true,
			status: view?.status ?? null,
		});
	}
	return rows;
}

const MANAGER_STATUS_PHASE = {
	disabled: "stopped",
	connected: "connected",
	connecting: "loading",
	reconnecting: "loading",
	"waiting-credentials": "failed",
	failed: "failed",
	closed: "stopped",
	unknown: "unknown",
};

/** manager 的运行状态 → 面板 phase 取值域（deriveMcpPhase 的输入）。 */
function managerStatusPhase(status) {
	const state = typeof status?.state === "string" ? status.state : "unknown";
	return MANAGER_STATUS_PHASE[state] ?? "unknown";
}

/** manager 状态里可直接展示的失败原因；没有就返回 null（面板不编造错误）。 */
function managerStatusError(status, enabled = true) {
	if (!enabled) return null;
	const state = typeof status?.state === "string" ? status.state : "";
	if (state === "waiting-credentials") return "DSH 凭据尚未就绪：该条目引用的 credential 模板没有解析出值";
	if (state === "reconnecting" || state === "failed") {
		if (typeof status.lastError === "string" && status.lastError) return status.lastError;
		return state === "failed" && status.reason === "gave-up" ? "自动重连次数已用尽，管理器不再重试" : null;
	}
	return null;
}

function entriesForName(ctx, name) {
	return allMcpEntries(ctx).filter((entry) => entry.options.config.serverName === name);
}
function projectToolSchema(schema) {
	return {
		name: schema.name,
		description: schema.description || "",
		parameters: schema.parameters ?? null,
	};
}
function revisionOf(value) {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) throw new TypeError("revision input must be JSON-serializable");
	return createHash("sha256").update(serialized).digest("hex");
}
function toolInventory(ctx) {
	// 工具归属必须把 manager 托管的服务器也算进来，否则它们的 mcp__<name>__ 工具没有 owner，
	// 面板工具数恒 0、工具裁缝还会把调用记成「内置工具」（issue #23 的第三点）。
	const serverNames = [...new Set([...allMcpEntries(ctx).map((entry) => entry.options.config.serverName), ...managedServers(ctx).map((row) => row.serverName)])];
	const schemas = new Map(serverNames.map((name) => [name, []]));
	const ambiguous = new Set();
	for (const schema of ctx.tools.schemas()) {
		const owners = serverNames.filter((name) => schema.name.startsWith(`mcp__${name}__`));
		if (owners.length === 1) schemas.get(owners[0]).push(schema);
		else if (owners.length > 1) owners.forEach((name) => ambiguous.add(name));
	}
	const counts = {};
	const revisions = {};
	for (const [name, owned] of schemas) {
		counts[name] = owned.length;
		revisions[name] = revisionOf(owned.map(projectToolSchema));
	}
	return { ambiguous, counts, revisions, schemas };
}

export { allMcpEntries, entriesForName, managedServers, managerStatusError, managerStatusPhase, MCP_NAME, projectToolSchema, revisionOf, toolInventory };
