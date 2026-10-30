// 会话级专家人设（随时挂/换/摘 + 切换会话/重启自动恢复）回归 —— 用替身宿主验证契约与关键不变量。
//
// 为什么必须有这组用例：这条通道是「会话已开始也能换专家」的唯一实现路径，它依赖两个
// 宿主机制（systemPrompt 的会话作用域 section + cordis 服务方法 this.ctx 重绑）。替身把
// 这两点显式建模出来，任何一处假设被改坏，用例立刻红——而不是等到用户在真会话里发现
// 专家换不掉。
//
// 2026-10 抖音反馈「每个会话中专家容易掉」后补的部分：section 只活在 live agent 的
// scope 里，切会话/重启会重建 agent，人设随旧 scope 销毁。所以现在多了「选择落盘 +
// agent/created 恢复 + reconcile 补装」，这里同样逐条钉住。
//
// 用法：node ./test/session-persona.mjs
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const modUrl = new URL("../lib/session-persona.js", import.meta.url);

// 落盘隔离：必须在第一次调用模块函数前设置（测试不能写用户真实的 ~/.dsh）。
const home = mkdtempSync(join(tmpdir(), "armory-session-persona-"));
process.env.DSH_ARMORY_MARKET_HOME = home;
const storeFile = join(home, "experts", "session-persona.json");

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const {
  attachPersona, detachPersona, installPersonaRuntime, listPersonas, personaOf,
  reconcilePersonas, restorePersonaForAgent,
} = await import(modUrl.href);

/** 替身：一个会话的 scoped ctx（systemPrompt.section 记录注册，disposer 记录撤销）。 */
function fakeAgentCtx() {
  const liveSections = new Map();
  const sections = [];
  const disposed = [];
  const ctx = {
    systemPrompt: {
      getSectionOrder: (name) => (name === "DEPLOYMENT_PERSONA_PREFIX" ? 100 : 0),
      section(section) {
        // 宿主 NamedEntries 同名即抛（见 dsh-scope）：替身必须同样严格，否则
        // 「重复注册/恢复幂等」这类用例会假绿。
        if (liveSections.has(section.name)) throw new Error(`prompt section "${section.name}" is already registered in this scope`);
        sections.push(section);
        liveSections.set(section.name, section);
        let live = true;
        const disposer = () => {
          if (!live) return;
          live = false;
          liveSections.delete(section.name);
          disposed.push(section);
        };
        return disposer;
      },
    },
    sections,
    disposed,
  };
  return ctx;
}

/** 替身：agents 服务（get/list）+ 事件订阅（agent/created）+ effect 生命周期。 */
function fakeHost(sessionIds) {
  const agents = new Map();
  for (const id of sessionIds) agents.set(id, { id, ctx: fakeAgentCtx() });
  const handlers = new Map();
  const effects = new Set();
  const host = {
    ctx: {
      logger: { warn() {}, debug() {}, error() {} },
      get: (name) => (name === "agents" ? {
        get: (id) => agents.get(id),
        list: () => [...agents.values()],
      } : undefined),
      on(event, handler) {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(handler);
        return () => {
          const list = handlers.get(event) || [];
          const index = list.indexOf(handler);
          if (index >= 0) list.splice(index, 1);
        };
      },
      effect(callback) {
        const disposer = callback();
        if (typeof disposer !== "function") return () => {};
        effects.add(disposer);
        return () => {
          if (effects.delete(disposer)) disposer();
        };
      },
    },
    agents,
    handlers,
    async emit(event, payload) {
      for (const handler of [...(handlers.get(event) || [])]) await handler(payload);
    },
    disposeEffects() {
      for (const disposer of [...effects]) {
        effects.delete(disposer);
        disposer();
      }
    },
  };
  return host;
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
  ok("选择已落盘", (() => {
    try {
      const raw = JSON.parse(readFileSync(storeFile, "utf8"));
      return raw.version === 1 && raw.sessions.some((row) => row.sessionId === "s1" && row.plugin === "senior-developer" && row.personaText === "你是吴八哥。");
    } catch { return false; }
  })());
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
  ok("取消后选择也从落盘文件移除", (() => {
    try {
      const raw = JSON.parse(readFileSync(storeFile, "utf8"));
      return !raw.sessions.some((row) => row.sessionId === "s3");
    } catch { return false; }
  })());
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

// ── 6. 会话卸载 / 切走：运行时注入撤销，但选择必须保留（本次修复的核心）──────
{
  const host = fakeHost(["live", "gone"]);
  attachPersona(host.ctx, "live", { plugin: "a", name: "甲", personaText: "甲人设" });
  attachPersona(host.ctx, "gone", { plugin: "b", name: "乙", personaText: "乙人设" });
  const goneCtx = host.agents.get("gone").ctx;
  // 宿主卸载会话 = agent 离开注册表，scope 随之销毁。
  host.agents.delete("gone");
  reconcilePersonas(host.ctx);
  ok("死会话的运行时注入被撤销", goneCtx.disposed.length === 1);
  ok("死会话的选择保留（切回/重启能恢复）", personaOf("gone")?.plugin === "b");
  ok("活会话保留", listPersonas().some((r) => r.sessionId === "live") === true);
  ok("活会话的 section 仍在", host.agents.get("live").ctx.disposed.length === 0);
}

// ── 7. 会话恢复：agent 重建后按选择自动补回人设 ─────────────────────────────
{
  const host = fakeHost(["s7"]);
  attachPersona(host.ctx, "s7", { plugin: "a", name: "甲", personaText: "甲人设" });
  const oldCtx = host.agents.get("s7").ctx;
  // 模拟 resume：同一 sessionId，全新的 agent + 全新 scope（旧 section 随旧 scope 失效）。
  host.agents.set("s7", { id: "s7", ctx: fakeAgentCtx() });
  const resumed = host.agents.get("s7");
  const restored = restorePersonaForAgent(host.ctx, resumed);
  ok("恢复成功并带上原人设", restored.restored === true && resumed.ctx.sections.length === 1 && resumed.ctx.sections[0].text === "甲人设", JSON.stringify(restored));
  ok("旧 scope 的 section 被撤销（不叠加）", oldCtx.disposed.length === 1);
  const again = restorePersonaForAgent(host.ctx, resumed);
  ok("重复恢复幂等（不重复注册）", again.restored === false && resumed.ctx.sections.length === 1);
  // 再来一次「卸载 → 新 agent」，这次不显式调用恢复，靠 expertActive 的 reconcile 自愈。
  host.agents.set("s7", { id: "s7", ctx: fakeAgentCtx() });
  const healed = host.agents.get("s7");
  reconcilePersonas(host.ctx);
  ok("reconcile 自动补装（5s 轮询兜底）", healed.ctx.sections.length === 1 && healed.ctx.sections[0].text === "甲人设");
  // 用户点 × 之后，会话回来绝不能偷偷恢复。
  detachPersona(host.ctx, "s7");
  host.agents.set("s7", { id: "s7", ctx: fakeAgentCtx() });
  const afterDetach = host.agents.get("s7");
  reconcilePersonas(host.ctx);
  ok("显式取消后不再恢复", afterDetach.ctx.sections.length === 0 && personaOf("s7") === null);
}

// ── 8. agent/created 恢复通道 + 安装时补装（插件热重载）─────────────────────
{
  const host = fakeHost(["boot"]);
  attachPersona(host.ctx, "boot", { plugin: "a", name: "甲", personaText: "甲人设" });
  host.agents.delete("boot"); // 安装前会话已被卸载
  installPersonaRuntime(host.ctx);
  const resumed = { id: "boot", ctx: fakeAgentCtx() };
  host.agents.set("boot", resumed);
  await host.emit("agent/created", { agent: resumed, source: "resume" });
  ok("agent/created 自动恢复人设", resumed.ctx.sections.length === 1 && resumed.ctx.sections[0].text === "甲人设");
  ok("恢复不重复写盘（文件里仍只有一条）", (() => {
    try {
      return JSON.parse(readFileSync(storeFile, "utf8")).sessions.filter((row) => row.sessionId === "boot").length === 1;
    } catch { return false; }
  })());
  // 安装时已经活着的会话（插件运行中重载 / 运行中安装）也要补装。
  const host2 = fakeHost(["alive"]);
  attachPersona(host2.ctx, "alive", { plugin: "b", name: "乙", personaText: "乙人设" });
  host2.agents.set("alive", { id: "alive", ctx: fakeAgentCtx() });
  installPersonaRuntime(host2.ctx);
  ok("安装时补装已存活但注入已失效的会话", host2.agents.get("alive").ctx.sections.length === 1);
  // 卸载：监听器必须收回，且不再恢复。
  host2.disposeEffects();
  const resurrected = { id: "alive", ctx: fakeAgentCtx() };
  host2.agents.set("alive", resurrected);
  await host2.emit("agent/created", { agent: resurrected, source: "resume" });
  ok("卸载后监听器已撤销", resurrected.ctx.sections.length === 0);
}

// ── 9. 重启持久化：模块内存全丢，选择仍能从磁盘恢复 ─────────────────────────
{
  const host = fakeHost(["s9"]);
  attachPersona(host.ctx, "s9", { plugin: "senior-developer", name: "吴八哥", personaText: "你是吴八哥。" });
  host.agents.delete("s9");
  // 用带 query 的新模块实例模拟宿主重启：模块级 Map 全部重置。
  const reloaded = await import(`${modUrl.href}?restarted=1`);
  ok("重启后仍记得选择", reloaded.listPersonas().some((row) => row.sessionId === "s9" && row.plugin === "senior-developer"));
  const resumed = { id: "s9", ctx: fakeAgentCtx() };
  host.agents.set("s9", resumed);
  const restored = reloaded.restorePersonaForAgent(host.ctx, resumed);
  ok("重启后自动恢复人设", restored.restored === true && resumed.ctx.sections[0]?.text === "你是吴八哥。", JSON.stringify(restored));
}

// ── 10. 契约三处同步（漏一处恒 404，这是踩过的坑）──────────────────────────
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
  // 恢复通道必须真的装到宿主上（漏了它，落盘的选择永远不会被用上）。
  ok("插件装配安装会话专家运行时", indexSrc.includes("installPersonaRuntime(ctx)"));
}

try { rmSync(home, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exitCode = failures === 0 ? 0 : 1;
