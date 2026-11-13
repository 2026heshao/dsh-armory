// 服务键冲突回归（issue #18）：
// DSH 0.2.2-rc.2 起官方 @deepseek-ai/dsh-mcp-manager 在 dsh-web-app 的 bundle patch 里
// 被自动挂载，并注册 cordis 服务 "mcpManager"。cordis 的重复注册是硬抛，两边都不做探测，
// 于是 armory 与官方必有一方整条 fiber 失败（谁后装配谁失败，可能是 armory 自己）。
//
// 本插件的修法是「服务键改名、wire 契约不动」：
//   cordis 服务键 = armoryMcp（自己的命名空间）
//   Typert namespace = mcpManager（端点前缀，客户端 remote.mcpManager 与 84 条 RPC 不变）
//
// 这里锁三件事，并配反向自测：
//   1. 三处源码的 service 字段都必须是 armoryMcp（构造器 + typert + client 契约）
//   2. 真 cordis 上「已有 mcpManager 再注册 armoryMcp」不抛，且 namespace 仍是 mcpManager
//   3. 同名注册必须仍然抛（证明第 2 条不是恒真）；顺便钉住与官方的端点不重叠

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 必须走 fileURLToPath：本仓库路径含中文，`URL.pathname` 是百分号编码的。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT = join(ROOT, "lib", "client.js");
const HOST = join(ROOT, "lib", "index.js");
const TYPERT = join(ROOT, "lib", "typert.js");

let failures = 0;
const ok = (name, condition, extra = "") => {
	if (!condition) failures += 1;
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};

const clientSource = await readFile(CLIENT, "utf8");
const hostSource = await readFile(HOST, "utf8");
const typertSource = await readFile(TYPERT, "utf8");

// ── 1. 三处契约：service 必须是 armoryMcp，namespace 必须留在 mcpManager ──────
{
	ok("宿主构造器用独立服务键、namespace 不变",
		hostSource.includes('super(ctx, "armoryMcp", { namespace: "mcpManager" })'));

	const mv = typertSource.match(/const mv =[\s\S]*?\n\}\)/)?.[0] ?? "";
	ok("typert 声明的 service 是 armoryMcp",
		/service: 'armoryMcp'/.test(mv) && !/service: 'mcpManager'/.test(typertSource));
	ok("typert 的 namespace 仍是 mcpManager", /namespace: 'mcpManager'/.test(mv));

	const contribution = clientSource.match(/const MCP_CONTRIBUTION = \{[\s\S]*?\n\};/)?.[0] ?? "";
	const descriptors = contribution.match(/service: '[^']+'/g) ?? [];
	ok("client 契约每条 descriptor 的 service 都是 armoryMcp",
		descriptors.length > 0 && descriptors.every((row) => row === "service: 'armoryMcp'"),
		`共 ${descriptors.length} 条`);
	ok("client 契约的 namespace 未改动（端点名与 remote.mcpManager 不变）",
		(contribution.match(/namespace: 'mcpManager'/g) ?? []).length === descriptors.length);
	ok("客户端仍按旧 namespace 取远端句柄",
		clientSource.includes("ctx.get('remote.mcpManager')"));
}

// ── 2/3. 真 cordis：共存注册成功，同名注册仍然硬抛 ───────────────────────────
// 宿主内部包不在 npm registry 上（CI 只装 yaml），拿不到时如实 SKIP，而不是把
// `npm test` 打成红的；本机 / 有宿主依赖的环境会真跑这两组断言。
let cordis = null;
let protocol = null;
try {
	cordis = await import("@deepseek-ai/cordis");
	protocol = await import("@deepseek-ai/dsh-typert-protocol");
} catch {
	cordis = null;
	protocol = null;
}

if (cordis && protocol) {
	const { Context, Service } = cordis;
	const { TypertRemoteService } = protocol;

	{
		const ctx = new Context();
		new Service(ctx, "mcpManager"); // 模拟官方 dsh-mcp-manager
		await ctx.fiber.await();

		const armory = new TypertRemoteService(ctx, "armoryMcp", { namespace: "mcpManager" });
		await ctx.fiber.await();

		// ctx.get 返回的是宿主侧的服务代理，不保证与实例同一引用；能取到即为注册成功。
		ok("官方 mcpManager 已占用时，armoryMcp 仍能注册",
			Boolean(ctx.get("armoryMcp")) && ctx.get("mcpManager") !== armory);
		ok("注册后 wire namespace 仍是 mcpManager",
			armory.typertRemote?.namespace === "mcpManager" && armory.typertRemote?.serviceKey === "armoryMcp");
	}

	{
		const ctx = new Context();
		new Service(ctx, "mcpManager");
		await ctx.fiber.await();
		let message = "";
		try {
			new TypertRemoteService(ctx, "mcpManager");
		} catch (error) {
			message = String(error?.message || error);
		}
		ok("反向自测：裸用 mcpManager 会硬抛（旧写法确实会炸）",
			message.includes('service "mcpManager" has been registered'), message || "(未抛错)");
	}
} else {
	console.log("SKIP  真 cordis 场景（本机未安装 @deepseek-ai/cordis 或 dsh-typert-protocol，源码针仍生效）");
}

// ── 4. 共享 namespace 的前提：两个包的方法名不得重叠 ─────────────────────────
// 官方 @deepseek-ai/dsh-mcp-manager 的 Remote 方法只有 probe / restart / watch
// （0.2.2-rc.2 与 rc.3 已核对）。端点按 <namespace>/<method> 唯一，撞名会在
// typert 注册阶段直接失败，所以这条必须钉住；官方以后如果把这些方法改名或新增
// 同名方法，这里会先红。
{
	const methods = new Set([...typertSource.matchAll(/mv\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]));
	const official = ["probe", "restart", "watch"];
	const overlap = official.filter((name) => methods.has(name));
	ok("与官方 Remote 方法不重名（共享 mcpManager namespace 的前提）",
		methods.size > 0 && overlap.length === 0, overlap.length ? overlap.join(",") : `${methods.size} 个方法`);
}

if (failures) {
	console.log(`\nSERVICE-KEY-CONFLICT FAIL（${failures} 条）`);
	process.exit(1);
}
console.log("\nSERVICE-KEY-CONFLICT PASS");
