// app root 读取口径回归（PR #29 / cordis rc.12 破坏性变更）。
//
// 背景：cordis 4.0.0-rc.12（npm 载体 @deepseek-ai/cordis 4.2.0-alpha.1）移除了 `ctx.root`，
// 根上下文改为 `ctx[Context.root]`（=== `Symbol.for('cordis.root')`）。在插件 fiber 内读
// 一个未注入的 `ctx.root` 会抛 `cannot get property "root" without inject`，而 armory 的
// 两处读取都在 apply 阶段 —— 于是整个插件「启用成功、fiber 立刻 failed」，面板与 MCP 服务
// 都不出现，且降级到 2.5.7/2.5.8 同样无效。
//
// 本次把读取收进 lib/app-root.js 的 rootOf()：新符号优先，旧版 ctx.root 兜底，任何读取
// 失败都退回本层 ctx（宁可统计口径粗，也不能让 apply 被带走）。
//
// 本套件锁四件事：
//   1. rootOf 对五种输入形态的行为（新/旧/符号缺失+读取抛错/空值/全抛代理）
//   2. 反向自测：旧写法在新版形态上必须抛 —— 证明修复不是恒真
//   3. 源码针：两处调用点已接线，且业务代码不再裸读 ctx.root
//   4. 真 cordis 上 rootOf 能把子上下文归并到同一个 app root（本机未装则 SKIP）
//
// 隔离纪律：零网络、零写盘、零临时目录；真 cordis 用已安装的版本，不可用即 SKIP。
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { rootOf } = await import(new URL("../lib/app-root.js", import.meta.url).href);

let failures = 0;
const ok = (name, condition, extra = "") => {
	if (!condition) failures += 1;
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};
const skip = (name, why) => console.log(`SKIP  ${name}  ${why}`);

const APP_ROOT = Symbol.for("cordis.root");
const INJECT_ERR = 'cannot get property "root" without inject';

// ── 1. rootOf 的五种输入形态 ────────────────────────────────────────────────
{
	// 新版形态：symbol 可读为 root，读 ctx.root 抛错（rc.12 的真实行为）
	const fakeRoot = { id: "app" };
	const modern = new Proxy(
		{ [APP_ROOT]: fakeRoot },
		{
			get(target, prop, receiver) {
				if (prop === "root") throw new Error(INJECT_ERR);
				return Reflect.get(target, prop, receiver);
			},
		},
	);
	ok("新版形态：rootOf 返回 app root", rootOf(modern) === fakeRoot);

	// 旧版形态：没有 symbol，ctx.root 是普通属性（≤4.1.0 的真实行为）
	const legacyRoot = { id: "app-legacy" };
	const legacy = { root: legacyRoot };
	ok("旧版形态：rootOf 走 ctx.root 兜底", rootOf(legacy) === legacyRoot);

	// 符号缺失且读 ctx.root 抛错：必须退回 ctx 本身，不得把 apply 带走
	const degraded = new Proxy(
		{},
		{
			get(target, prop) {
				if (prop === APP_ROOT) return undefined;
				throw new Error(INJECT_ERR);
			},
		},
	);
	let degradedThrew = null;
	try {
		ok("符号缺失 + 读取抛错：退回本层 ctx", rootOf(degraded) === degraded);
	} catch (e) {
		degradedThrew = e;
	}
	ok("符号缺失 + 读取抛错：rootOf 本身不外抛", degradedThrew === null, degradedThrew ? degradedThrew.message : "");

	// 空值与标量：原样返回（调用方自己判类型）
	ok("null 原样返回", rootOf(null) === null);
	ok("undefined 原样返回", rootOf(undefined) === undefined);
	ok("字符串原样返回（不抛）", rootOf("not-a-context") === "not-a-context");

	// 任意属性都抛的代理：最坏情况也不能外抛
	const hostile = new Proxy(
		{},
		{
			get() {
				throw new Error("hostile proxy");
			},
		},
	);
	let hostileThrew = null;
	let hostileResult;
	try {
		hostileResult = rootOf(hostile);
	} catch (e) {
		hostileThrew = e;
	}
	ok("全抛代理：不外抛且退回 ctx", hostileThrew === null && hostileResult === hostile, hostileThrew ? hostileThrew.message : "");
}

// ── 2. 反向自测：旧写法必须仍然坏（否则本修复毫无意义）─────────────────────
{
	const fakeRoot = { id: "app" };
	const modern = new Proxy(
		{ [APP_ROOT]: fakeRoot },
		{
			get(target, prop, receiver) {
				if (prop === "root") throw new Error(INJECT_ERR);
				return Reflect.get(target, prop, receiver);
			},
		},
	);
	// 改造前的写法（2.5.9 的 logScope / appRoot 内核）
	const oldLogScope = (ctx) => ctx?.root || ctx;
	let oldThrew = null;
	try {
		oldLogScope(modern);
	} catch (e) {
		oldThrew = e.message;
	}
	ok("反向自测：旧写法 ctx?.root 在新版上抛 inject 错", oldThrew === INJECT_ERR, oldThrew ?? "未抛（用例失效）");
}

// ── 3. 源码针：两处调用点已接线，业务代码不再裸读 ctx.root ─────────────────
{
	const hostSource = await readFile(join(ROOT, "lib", "index.js"), "utf8");
	const wsSource = await readFile(join(ROOT, "lib", "workspace-runtime.js"), "utf8");
	const rootSource = await readFile(join(ROOT, "lib", "app-root.js"), "utf8");

	ok("app-root.js 用全局 symbol 取根上下文", rootSource.includes("Symbol.for('cordis.root')"));
	ok("app-root.js 导出 rootOf", /export\s+function\s+rootOf/.test(rootSource));

	ok("index.js 已引入 rootOf", /import\s*\{\s*rootOf\s*\}\s*from\s*"\.\/app-root\.js"/.test(hostSource));
	ok("index.js 的 logScope 指向 rootOf", /const\s+logScope\s*=\s*rootOf;/.test(hostSource));
	ok("index.js 不再有裸 ctx?.root 业务读取", !/ctx\?\.root\s*\|\|/.test(hostSource));

	ok("workspace-runtime.js 已引入 rootOf", /import\s*\{\s*rootOf\s*\}\s*from\s*"\.\/app-root\.js"/.test(wsSource));
	ok("workspace-runtime.js 的 appRoot 用 rootOf", /const\s+root\s*=\s*rootOf\(ctx\);/.test(wsSource));
	// 反向自测：旧写法一旦复活就报红（注释里提到 ctx.root 是允许的）
	ok("workspace-runtime.js 不再有裸 ctx.root 读取", !/\(ctx\s*&&\s*typeof\s+ctx\s*===\s*"object"\s*&&\s*ctx\.root\)/.test(wsSource));
}

// ── 4. 真 cordis：子上下文必须归并到同一个 app root ────────────────────────
let cordis = null;
try {
	cordis = await import("@deepseek-ai/cordis");
} catch {
	cordis = null;
}

if (cordis?.Context) {
	const app = new cordis.Context();
	const child = typeof app.extend === "function" ? app.extend({ name: "child" }) : app;
	ok("真 cordis：rootOf(app) === app", rootOf(app) === app);
	ok("真 cordis：rootOf(child) 归并到 app", rootOf(child) === app);

	// 插件内读（apply 阶段）不抛，且拿到的就是 app root
	let inPlugin = null;
	let pluginThrew = null;
	try {
		app.plugin({
			name: "app-root-probe",
			apply(ctx) {
				try {
					inPlugin = rootOf(ctx) === app;
				} catch (e) {
					pluginThrew = e.message;
				}
			},
		});
	} catch (e) {
		pluginThrew = e.message;
	}
	await new Promise((r) => setTimeout(r, 50));
	ok("真 cordis：插件 apply 内 rootOf 不外抛", pluginThrew === null, pluginThrew ?? "");
	ok("真 cordis：插件 apply 内 rootOf 拿到 app root", inPlugin === true, String(inPlugin));

	// 顺带记录本机 cordis 的形态：Context.root 是 symbol 说明已是 rc.12 之后的符号形态
	const shape = typeof cordis.Context.root === "symbol" ? "符号形态（rc.12+，ctx.root 已移除）" : "旧属性形态（ctx.root 仍可用）";
	console.log(`     本机 cordis 形态：${shape}`);
} else {
	skip("真 cordis 场景", "本机未安装 @deepseek-ai/cordis，源码针与形态用例仍生效");
}

console.log(`\n${failures === 0 ? "APP-ROOT PASS" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
