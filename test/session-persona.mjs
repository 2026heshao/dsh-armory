// 会话级专家人设（随时挂/换/摘）回归 —— 用替身宿主验证契约与关键不变量。
//
// 为什么必须有这组用例：这条通道是「会话已开始也能换专家」的唯一实现路径，它依赖两个
// 宿主机制（systemPrompt 的会话作用域 section + cordis 服务方法 this.ctx 重绑）。替身把
// 这两点显式建模出来，任何一处假设被改坏，用例立刻红——而不是等到用户在真会话里发现
// 专家换不掉。
//
// 用法：node ./test/session-persona.mjs
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const modUrl = new URL("../lib/session-persona.js", import.meta.url);

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const {
  attachPersona, detachPersona, listPersonas, personaOf, reconcilePersonas,
} = await import(modUrl.href);

/** 替身：一个会话的 scoped ctx（systemPrompt.section 记录注册，disposer 记录撤销）。 */
function fakeAgentCtx() {
  const sections = [];
  const disposed = [];
  const ctx = {
    systemPrompt: {
      getSectionOrder: (name) => (name === "DEPLOYMENT_PERSONA_PREFIX" ? 100 : 0),
      section(section) {
        sections.push(section);
        let live = true;
        const disposer = () => { if (live) { live = false; disposed.push(section); } };
        return disposer;
      },
    },
    sections,
    disposed,
  };
  return ctx;
}

/** 替身：agents 服务（get/list）。 */
function fakeHost(sessionIds) {
  const agents = new Map();
  for (const id of sessionIds) agents.set(id, { id, ctx: fakeAgentCtx() });
  return {
    ctx: { get: (name) => (name === "agents" ? {
      get: (id) => agents.get(id),
      list: () => [...agents.values()],
    } : undefined) },
    agents,
  };
}

// ── 1. 基本挂载：section 名/order 必须与 dsh-persona 同款（同名才遮蔽）────────
{
  const host = fakeHost(["s1"]);
  const res = attachPersona(host.ctx, "s1", { plugin: "senior-developer", name: "吴八哥", personaText: "你是吴八哥。" });
  const agent = host.agents.get("s1");
  const section = agent.ctx.sections[0];
  ok("挂载返回 ok 与名字", res.ok === true && res.name === "吴八哥", JSON.stringify(res));
  ok("section 名为 deployment:persona-prefix", section?.name === "deployment:persona-prefix", String(section?.name));
  ok("order 取自 DEPLOYMENT_PERSONA_PREFIX", section?.order === 100, String(section?.order));
  ok("text 是人设正文", section?.text === "你是吴八哥。");
  ok("personaOf 反映当前专家", personaOf("s1")?.plugin === "senior-developer");
}

// ── 2. 替换（核心诉求）：同一会话可反复换，旧的先撤销 ────────────────────────
{
  const host = fakeHost(["s2"]);
  attachPersona(host.ctx, "s2", { plugin: "a", name: "甲", personaText: "甲人设" });
  const res2 = attachPersona(host.ctx, "s2", { plugin: "b", name: "乙", personaText: "乙人设" });
  const agent = host.agents.get("s2");
  ok("第二次挂载标记 replaced", res2.replaced === true, JSON.stringify(res2));
  ok("旧 section 已被撤销", agent.ctx.disposed.length === 1 && agent.ctx.disposed[0].text === "甲人设");
  ok("同时只有一条 section 生效", agent.ctx.sections.length === 2 && agent.ctx.disposed.length === 1);
  ok("当前专家是乙", personaOf("s2")?.plugin === "b");
  const res3 = attachPersona(host.ctx, "s2", { plugin: "c", name: "丙", personaText: "丙人设" });
  ok("可换第三次（没有一次性限制）", res3.ok === true && res3.replaced === true && personaOf("s2")?.plugin === "c");
}

// ── 3. 取消（WorkBuddy 的「取消专家」）──────────────────────────────────────
{
  const host = fakeHost(["s3"]);
  attachPersona(host.ctx, "s3", { plugin: "a", name: "甲", personaText: "甲人设" });
  const det = detachPersona(host.ctx, "s3");
  ok("取消返回 removed=true", det.ok === true && det.removed === true, JSON.stringify(det));
  ok("取消后 section 被撤销", host.agents.get("s3").ctx.disposed.length === 1);
  ok("取消后 personaOf 为空", personaOf("s3") === null);
  ok("重复取消返回 removed=false（幂等）", detachPersona(host.ctx, "s3").removed === false);
  // 取消后还能再挂（来回切）
  const again = attachPersona(host.ctx, "s3", { plugin: "b", name: "乙", personaText: "乙人设" });
  ok("取消后可再次挂载", again.ok === true && again.replaced === false);
}

// ── 4. 会话隔离：挂一个会话不影响另一个 ─────────────────────────────────────
{
  const host = fakeHost(["x", "y"]);
  attachPersona(host.ctx, "x", { plugin: "a", name: "甲", personaText: "甲人设" });
  ok("只影响目标会话", host.agents.get("x").ctx.sections.length === 1 && host.agents.get("y").ctx.sections.length === 0);
  ok("listPersonas 只列一个", listPersonas().filter((r) => r.sessionId === "x").length === 1);
}

// ── 5. 错误路径：都能给出可读原因，不静默 ───────────────────────────────────
{
  const host = fakeHost(["s5"]);
  const cases = [
    [() => attachPersona(host.ctx, "nope", { plugin: "a", personaText: "x" }), "会话不在运行中"],
    [() => attachPersona(host.ctx, "s5", { plugin: "a", personaText: "   " }), "人设内容为空"],
    [() => attachPersona(host.ctx, "", { plugin: "a", personaText: "x" }), "缺少会话 id"],
    [() => attachPersona({ get: () => undefined }, "s5", { plugin: "a", personaText: "x" }), "agents 服务"],
    [() => detachPersona(host.ctx, ""), "缺少会话 id"],
  ];
  for (const [fn, needle] of cases) {
    let message = "";
    try { fn(); } catch (e) { message = String(e.message || e); }
    ok(`错误可读：${needle}`, message.includes(needle), message || "(未抛错)");
  }
}

// ── 6. 回收：会话消失后不残留记录 ──────────────────────────────────────────
{
  const host = fakeHost(["live", "gone"]);
  attachPersona(host.ctx, "live", { plugin: "a", name: "甲", personaText: "甲" });
  attachPersona(host.ctx, "gone", { plugin: "b", name: "乙", personaText: "乙" });
  host.agents.delete("gone");
  reconcilePersonas(host.ctx);
  ok("死会话被回收", listPersonas().some((r) => r.sessionId === "gone") === false);
  ok("活会话保留", listPersonas().some((r) => r.sessionId === "live") === true);
}

// ── 7. 契约三处同步（漏一处恒 404，这是踩过的坑）──────────────────────────
{
  const indexSrc = readFileSync(join(here, "..", "lib", "index.js"), "utf8");
  const typertSrc = readFileSync(join(here, "..", "lib", "typert.js"), "utf8");
  const clientSrc = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
  for (const m of ["expertAttach", "expertDetach", "expertActive"]) {
    const host = (indexSrc.match(new RegExp(`async ${m}\\(`, "g")) || []).length;
    const typert = (typertSrc.match(new RegExp(`mv\\('${m}'`, "g")) || []).length;
    const client = (clientSrc.match(new RegExp(`method: '${m}'`, "g")) || []).length;
    ok(`契约三处同步：${m}`, host === 1 && typert === 1 && client === 1, `host=${host} typert=${typert} client=${client}`);
  }
  // 客户端必须优先走「会话级人设」通道（否则又回到 locked 死路）
  ok("客户端调用 expertAttach", clientSrc.includes("call('expertAttach'"));
  ok("客户端取消走 expertDetach", clientSrc.includes("call('expertDetach'"));
  ok("客户端会同步真实状态", clientSrc.includes("call('expertActive'"));
  ok("旧的一次性路径已移除", !clientSrc.includes("createWithExpert") && !clientSrc.includes("pendingExpert"));
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exitCode = failures === 0 ? 0 : 1;
