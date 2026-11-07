// resolveSessionWorkspace 直测：召唤菜单「本项目」如何把 sessionId 换成项目根。
//
// 为什么需要这个套件：slot 只传 sessionId，项目路径只能从宿主会话 header.cwd 取。
// 三条路径必须都成立——sessions.get 命中、热加载换代后 agents.list() 兜底、两边都没有
// 时如实返回 ok:false（不能拿空字符串冒充项目根，否则菜单会把「查不到会话」显示成
// 「项目里没有配置」）。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { resolveSessionWorkspace } from "../lib/workspace-runtime.js";

const here = dirname(fileURLToPath(import.meta.url));

let failures = 0;
const ok = (name, condition, extra = "") => {
	if (!condition) failures += 1;
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};

// 不存在的路径让 canonicalWorkspacePath 的 realpath 失败、原样返回，便于断言。
const PROJECT = join(tmpdir(), "dsh-armory-session-workspace-test");
const OTHER = join(tmpdir(), "dsh-armory-session-workspace-other");

const ctxOf = ({ sessions, agents, throwSessions = false } = {}) => ({
	get(name) {
		if (name === "sessions") {
			if (throwSessions) throw new Error("store unavailable");
			return sessions;
		}
		if (name === "agents") return agents;
		return undefined;
	},
});

// ── 1. sessions.get 命中 ───────────────────────────────────────────────────
const sessions = {
	get(sessionId) {
		return sessionId === "s1" ? { id: "s1", header: { id: "s1", cwd: PROJECT } } : undefined;
	},
};
let result = resolveSessionWorkspace(ctxOf({ sessions }), "s1");
ok("sessions 命中：返回项目根", result.ok === true && result.cwd === PROJECT, JSON.stringify(result));

// 前后空白按 id 归一（slot 传来的 id 可能带空白）。
result = resolveSessionWorkspace(ctxOf({ sessions }), "  s1  ");
ok("sessionId 前后空白被归一", result.ok === true && result.cwd === PROJECT);

// ── 2. agents.list 兜底（sessions 里没有 / 不可用）──────────────────────────
const agents = {
	list() {
		return [
			{ session: { id: "s2", header: { cwd: OTHER } } },
			{ session: { id: "s3", header: { cwd: PROJECT } } },
		];
	},
};
result = resolveSessionWorkspace(ctxOf({ agents }), "s3");
ok("sessions 未命中时走 agents.list 兜底", result.ok === true && result.cwd === PROJECT, JSON.stringify(result));
result = resolveSessionWorkspace(ctxOf({ sessions: { get() { return undefined; } }, agents }), "s2");
ok("两边都有时优先 agents.list 中 id 精确匹配", result.ok === true && result.cwd === OTHER);

result = resolveSessionWorkspace(ctxOf({ agents, throwSessions: true }), "s3");
ok("sessions.get 抛错时仍能靠 agents 兜底", result.ok === true && result.cwd === PROJECT);

// ── 3. 失败态：不能把查不到会话伪装成项目根 ─────────────────────────────────
result = resolveSessionWorkspace(ctxOf({}), "missing");
ok("两边都没有：ok:false 且带原因", result.ok === false && typeof result.error === "string" && result.error.length > 0, JSON.stringify(result));
result = resolveSessionWorkspace(ctxOf({ sessions }), "");
ok("空 sessionId：ok:false", result.ok === false);
result = resolveSessionWorkspace(ctxOf({ sessions }), "   ");
ok("纯空白 sessionId：ok:false", result.ok === false);
result = resolveSessionWorkspace({}, "s1");
ok("没有 ctx.get 时也不抛异常", result.ok === false);

// cwd 为空串 / 非字符串同样按失败处理。
result = resolveSessionWorkspace(ctxOf({ sessions: { get() { return { header: { cwd: "" } }; } } }), "s1");
ok("cwd 为空串：ok:false", result.ok === false);
result = resolveSessionWorkspace(ctxOf({ sessions: { get() { return { header: {} }; } } }), "s1");
ok("header 没有 cwd：ok:false", result.ok === false);

// ── 4. 反向自测：把三处判定分别改坏，上面的正向断言必须变红 ──────────────────
// run-all.mjs 的注册注释一直写着「含反向自测」，而这份文件从前没有——等于一条空话。
// 这里不写桩函数比桩函数（那种恒真），而是把 lib/workspace-runtime.js 里真实的函数体
// 抽进 vm，逐条替换成一个"看起来也能跑"的坏形态，要求坏形态跑不出上面的结果。
{
	const runtimeSrc = readFileSync(join(here, "..", "lib", "workspace-runtime.js"), "utf8");
	const fnStart = runtimeSrc.indexOf("function resolveSessionWorkspace(ctx, sessionId) {");
	const fnEnd = fnStart < 0 ? -1 : runtimeSrc.indexOf("\n}\n", fnStart);
	ok("能从 workspace-runtime.js 定位 resolveSessionWorkspace 函数体", fnStart >= 0 && fnEnd > fnStart);
	const FN = fnEnd > fnStart ? runtimeSrc.slice(fnStart, fnEnd + 3) : "";
	// 与真实现同语义的两个依赖：liveAgentsOf 只取 agents.list()，canonical 这里用恒等
	// （正向断言比对的是 tmp 路径字面量，realpath 在临时目录上会带 8.3 短名差异）。
	const DEPS = `const canonicalWorkspacePath = (p) => p;
const liveAgentsOf = (ctx) => { const a = typeof ctx.get === "function" ? ctx.get("agents") : null; return a && typeof a.list === "function" ? a.list() || [] : []; };
`;
	const run = (label, from, to) => {
		if (!FN.includes(from)) {
			ok(`反向自测「${label}」：改动点命中真实源码`, false, `未找到 "${from}"`);
			return null;
		}
		const context = vm.createContext({});
		vm.runInContext(`${DEPS}${FN.replace(from, to)}\nglobalThis.__f = resolveSessionWorkspace;`, context, { filename: "session-workspace-mutant.js" });
		return context.__f;
	};
	const ctxFor = (c) => ctxOf(c);
	const m1 = run("id 不 trim", 'sessionId.trim() : ""', "sessionId : \"\"");
	if (m1) ok("反向自测：去掉 sessionId.trim() 后「前后空白被归一」确实变红", m1(ctxFor({ sessions }), "  s1  ").ok === false);
	const m2 = run("丢掉 agents 兜底", "for (const agent of liveAgentsOf(ctx)) {", "for (const agent of []) {");
	if (m2) ok("反向自测：丢掉 agents.list 兜底后「sessions 未命中仍能解析」确实变红", m2(ctxFor({ agents }), "s3").ok === false);
	const m3 = run("空 cwd 当成功", 'if (typeof cwd !== "string" || cwd.length === 0) {\n\t\treturn { ok: false, error: "会话不在运行中，无法确定项目路径" };', "if (cwd === null) {\n\t\treturn { ok: false, error: \"x\" };");
	if (m3) ok("反向自测：把「空 cwd」放过后对应断言确实变红", m3(ctxFor({ sessions: { get() { return { header: { cwd: "" } }; } } }), "s1").ok === true);
	// 对照组：未经改动的同一份函数体必须与模块导出版本给出同样的结果，
	// 否则上面三条比的是「另一份实现」，红绿都不作数。
	const context = vm.createContext({});
	vm.runInContext(`${DEPS}${FN}\nglobalThis.__f = resolveSessionWorkspace;`, context, { filename: "session-workspace-copy.js" });
	const copy = context.__f;
	ok("对照组：vm 里这份函数体与模块导出行为一致", JSON.stringify(copy(ctxFor({ sessions }), "s1")) === JSON.stringify(resolveSessionWorkspace(ctxFor({ sessions }), "s1"))
		&& JSON.stringify(copy(ctxFor({}), "missing")) === JSON.stringify({ ok: false, error: "会话不在运行中，无法确定项目路径" }));
}

console.log(failures ? `\nSESSION-WORKSPACE FAIL（${failures} 条）` : "\nSESSION-WORKSPACE PASS");
process.exit(failures ? 1 : 0);
