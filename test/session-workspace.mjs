// resolveSessionWorkspace 直测：召唤菜单「本项目」如何把 sessionId 换成项目根。
//
// 为什么需要这个套件：slot 只传 sessionId，项目路径只能从宿主会话 header.cwd 取。
// 三条路径必须都成立——sessions.get 命中、热加载换代后 agents.list() 兜底、两边都没有
// 时如实返回 ok:false（不能拿空字符串冒充项目根，否则菜单会把「查不到会话」显示成
// 「项目里没有配置」）。

import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveSessionWorkspace } from "../lib/workspace-runtime.js";

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

console.log(failures ? `\nSESSION-WORKSPACE FAIL（${failures} 条）` : "\nSESSION-WORKSPACE PASS");
process.exit(failures ? 1 : 0);
