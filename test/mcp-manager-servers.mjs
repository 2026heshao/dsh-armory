// issue #23 回归：DSH 0.2.2-rc.2 起官方 @deepseek-ai/dsh-mcp-manager 把 servers 映射里的
// 每个条目挂成**自己的子实例**，不是 loader 条目 —— `allMcpEntries` 只能看到那一个 manager
// 条目，面板因此显示「还没有 MCP 服务器」，工具账本还把它们的调用记成内置工具。
//
// 本套件钉三件事：
//   ① 只读投影 managedServers：读 config.servers、状态读 list()，服务缺席/读取失败一律空表；
//   ② 状态与错误映射进面板同一取值域（deriveMcpPhase 的输入），不把在线服务器说成已停止；
//   ③ 接线：面板列表、status RPC、工具账本、工具归属、导入冲突、写动作报错都要认得托管名。
// 全程离线：替身 ctx，不读真实 profile、不联网；index/client/workspace 侧用源码针
// （它们绑宿主类与 React 组件，node 里跑不起来，参照 test/expert-display-name.mjs 的手法）。
//
// 运行：node ./test/mcp-manager-servers.mjs（也经 test/run-all.mjs 白名单随全量跑）
// 退出码：0 全过；1 有失败。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "lib");
const registry = await import(pathToFileURL(join(LIB, "mcp-registry.js")).href);
const { managedServers, managerStatusError, managerStatusPhase, toolInventory } = registry;

let failures = 0;
let checks = 0;
const ok = (name, condition, extra = "") => {
	checks += 1;
	if (!condition) failures += 1;
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};
const section = (title) => console.log(`\n── ${title} ─────────────────────────────────────────────`);

const indexSrc = await readFile(join(LIB, "index.js"), "utf8");
const clientSrc = await readFile(join(LIB, "client.js"), "utf8");
const workspaceSrc = await readFile(join(LIB, "workspace-runtime.js"), "utf8");

const managerFor = (servers, { views = [], listThrows = false, plain = false } = {}) => ({
	config: { servers: plain ? servers : { get: () => servers } },
	list: () => {
		if (listThrows) throw new Error("manager not ready");
		return views;
	},
});
const ctxWith = (manager) => ({ get: () => manager });
const SERVERS = {
	playwright: { transport: "stdio", command: "playwright-mcp", args: ["--headless"], enabled: true },
	legacy: { transport: "streamable-http", url: "https://example.test/mcp", enabled: false },
};

// ═══════════════════════════════════════════════════════════════════════════
section("1. managedServers：只读投影与降级");
// ═══════════════════════════════════════════════════════════════════════════
ok("没有 ctx.get（旧宿主）：返回空表，面板行为不变", managedServers({}).length === 0);
ok("get 抛错：吞掉异常并返回空表", managedServers({ get: () => { throw new Error("no service"); } }).length === 0);
ok("服务未注册：返回空表", managedServers(ctxWith(undefined)).length === 0);
const rows = managedServers(ctxWith(managerFor(SERVERS, { views: [
	{ name: "playwright", configured: true, status: { state: "connected", toolCount: 7, connectedAt: 1 } },
	{ name: "legacy", configured: true, status: { state: "disabled" } },
] })));
ok("按 servers 键逐条展开", rows.length === 2, `实际=${rows.length}`);
ok("名字即 tool 命名空间", rows.map((row) => row.serverName).join(",") === "playwright,legacy");
ok("enabled 跟随条目配置", rows[0]?.enabled === true && rows[1]?.enabled === false);
ok("status 来自 manager.list（不是猜的）", rows[0]?.status?.state === "connected" && rows[1]?.status?.state === "disabled");
ok("configured 透传", rows.every((row) => row.configured === true));
ok("config 是快照副本，改它不会回写 manager", (() => {
	const live = { ...SERVERS };
	const row = managedServers(ctxWith(managerFor(live)))[0];
	row.config.command = "changed";
	return live.playwright.command === "playwright-mcp";
})());
ok("servers 是普通对象（无 .get）也能读", managedServers(ctxWith(managerFor(SERVERS, { plain: true }))).length === 2);
ok("list 抛错：条目仍在，只是没有状态", (() => {
	const list = managedServers(ctxWith(managerFor(SERVERS, { listThrows: true })));
	return list.length === 2 && list.every((row) => row.status === null);
})());
ok("非对象条目被忽略（不制造空壳行）", managedServers(ctxWith(managerFor({ broken: null, ok: { transport: "stdio" } }))).length === 1);

// ═══════════════════════════════════════════════════════════════════════════
section("2. 状态映射：manager 取值域 → 面板 phase");
// ═══════════════════════════════════════════════════════════════════════════
const PHASES = [
	["connected", "connected"],
	["connecting", "loading"],
	["reconnecting", "loading"],
	["waiting-credentials", "failed"],
	["failed", "failed"],
	["closed", "stopped"],
	["disabled", "stopped"],
	["something-new", "unknown"],
];
for (const [state, phase] of PHASES) {
	ok(`${state} → ${phase}`, managerStatusPhase({ state }) === phase, `实际=${managerStatusPhase({ state })}`);
}
ok("没有状态时不冒充已连接", managerStatusPhase(null) === "unknown" && managerStatusPhase({}) === "unknown");
ok("停用条目不编造错误", managerStatusError({ state: "failed", lastError: "spawn ENOENT" }, false) === null);
ok("等待凭据给出可行动的原因", String(managerStatusError({ state: "waiting-credentials" }) || "").includes("凭据"));
ok("连接失败优先用 manager 的 lastError", managerStatusError({ state: "failed", reason: "gave-up", lastError: "ECONNREFUSED" }) === "ECONNREFUSED");
ok("没有 lastError 也不编造（give-up 除外）", managerStatusError({ state: "failed", reason: "reconnect-disabled" }) === null);
ok("重连等待中的原因可展示", managerStatusError({ state: "reconnecting", lastError: "timeout" }) === "timeout");
ok("已关闭不算失败原因", managerStatusError({ state: "closed" }) === null);

// ═══════════════════════════════════════════════════════════════════════════
section("3. 工具归属：托管名进入 toolInventory");
// ═══════════════════════════════════════════════════════════════════════════
const toolCtx = {
	loader: { entries: () => [{ options: { id: "mcp-windows", name: "@deepseek-ai/dsh-mcp-client", config: { serverName: "windows" } } }] },
	get: () => managerFor({ playwright: { transport: "stdio" } }, { views: [{ name: "playwright", configured: true, status: { state: "connected", toolCount: 2, connectedAt: 1 } }] }),
	tools: {
		schemas: () => [
			{ name: "mcp__playwright__browser_navigate", description: "", parameters: {} },
			{ name: "mcp__playwright__browser_snapshot", description: "", parameters: {} },
			{ name: "mcp__windows__Screenshot", description: "", parameters: {} },
			{ name: "read_file", description: "", parameters: {} },
		],
	},
};
const inventory = toolInventory(toolCtx);
ok("托管服务器的工具记到它名下", inventory.counts.playwright === 2, `实际=${inventory.counts.playwright}`);
ok("loader 条目照旧统计", inventory.counts.windows === 1, `实际=${inventory.counts.windows}`);
ok("托管名不产生歧义（只属于一个 owner）", inventory.ambiguous.size === 0, `实际=${[...inventory.ambiguous].join(",")}`);
ok("内置工具不会凭空多出一个 server 计数", Object.keys(inventory.counts).join(",") === "windows,playwright", `实际=${Object.keys(inventory.counts).join(",")}`);

// ═══════════════════════════════════════════════════════════════════════════
section("4. 接线：列表 / status / 工具裁缝 / 导入冲突 / 写动作");
// ═══════════════════════════════════════════════════════════════════════════
const hasListMerge = (src) => src.includes("for (const server of managedServers(ctx)) {\n\t\tconst existing = servers.find")
	&& src.includes("existing.conflict = true;")
	&& src.includes("servers.push(summarizeManaged(server, inventory));");
ok("面板列表把托管行并入（同名标冲突）", hasListMerge(indexSrc));
ok("summarize 支持来源覆盖 phase（不再一律 stopped）", indexSrc.includes("const phase = view?.phase ??"));
ok("托管行的状态来自 managerStatusPhase", indexSrc.includes("phase: managerStatusPhase(server.status), host: \"mcp-manager\""));
ok("托管行强制只读（managed 保持 false）", indexSrc.includes("summarize(pseudo, inventory, null, false, null, view)"));
ok("status RPC 对托管名兜底，不再 no such MCP", indexSrc.includes("return { server: summarizeManaged(hosted, toolInventory(this.ctx)) };"));
ok("工具裁缝把托管名算进 MCP 命名空间", indexSrc.includes("if (!mcpServerNames.includes(server.serverName)) mcpServerNames.push(server.serverName);"));
ok("工具裁缝把停用的托管条目标为 disabled", indexSrc.includes("if (server.enabled === false) disabledServers.add(server.serverName);"));
ok("新增同名条目会被拦下并指出去哪改", indexSrc.includes("该名称已由 DSH 官方 mcp-manager 托管"));
ok("导入预览把托管名算作冲突占位", indexSrc.includes("id: `mcp-manager:${hosted.serverName}`"));
ok("启停/重连/编辑/移除/查看都给出托管专属报错", (indexSrc.match(/managerWriteBlocked\(/g) || []).length >= 6);
ok("报错文案指向「设置 → MCP 服务器」", indexSrc.includes("请到「设置 → MCP 服务器」中修改（军械库当前只读展示）"));
ok("项目层同名判定也算托管实例", workspaceSrc.includes("managedServers(ctx).some((server) => server.serverName === name)")
	&& workspaceSrc.includes("...managedServers(ctx).map((server) => server.serverName)"));

const hasClientHost = (src) => src.includes("server.host === 'mcp-manager'")
	&& src.includes("s.host === 'mcp-manager'")
	&& src.includes("t('托管')");
ok("客户端：来源文案 / 托管徽标 / 只读提示都在场", hasClientHost(clientSrc));
ok("客户端：托管行的英文译文齐全（非恒等）", [
	'"托管": "Managed"',
	'"由 DSH 官方 mcp-manager 托管，只读": "Managed by the official DSH mcp-manager (read-only)"',
	'"否（mcp-manager 条目已停用）": "No (the mcp-manager entry is disabled)"',
].every((needle) => clientSrc.includes(needle)));

// 反向自测：把接线删掉，上面的谓词必须变红，证明它们不是恒真。
const regressedList = indexSrc.replace(
	"for (const server of managedServers(ctx)) {\n\t\tconst existing = servers.find",
	"for (const server of []) {\n\t\tconst existing = servers.find",
);
ok("反向自测：去掉列表并入，断言确实变红", regressedList !== indexSrc && !hasListMerge(regressedList));
const regressedClient = clientSrc.split("t('托管')").join("t('hosted')");
ok("反向自测：去掉客户端徽标，断言确实变红", !hasClientHost(regressedClient));
// 旧实现（只认 loader 条目）在同一份工具表上统计不到托管服务器。
const legacyInventory = (ctx) => {
	const names = [...new Set(registry.allMcpEntries(ctx).map((entry) => entry.options.config.serverName))];
	const counts = Object.fromEntries(names.map((name) => [name, 0]));
	for (const schema of ctx.tools.schemas()) for (const name of names) if (schema.name.startsWith(`mcp__${name}__`)) counts[name] += 1;
	return { counts };
};
ok("反向自测：旧写法确实统计不到托管工具", legacyInventory(toolCtx).counts.playwright === undefined);

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${failures ? "FAIL" : "PASS"}  mcp-manager-servers：${checks} 项断言，${failures} 项失败`);
process.exit(failures ? 1 : 0);
