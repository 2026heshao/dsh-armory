// test/workspace-runtime.test.mjs
//
// 护栏对象：issue #6「项目级 MCP 后面加上去，必须新开会话才生效」。
//
// 根因（修复前）：mountProjectMcpForAgent 只在项目**已经有** `.dsh/mcp.json` 时才
// ensureAgentWorkspaceState。第一次添加项目 MCP 的项目恰好还没有这个文件，于是这条
// 会话从未进入 agentWorkspaceStates；而写盘对齐 reconcileWorkspaceConnections 只遍历
// 这张表 —— 新增的 server 只能等下一次 agent/created（新开会话）。
//
// 这里钉三条不变式（不建真实 MCP 连接、不联网）：
//   1. 项目没有 `.dsh/mcp.json` 时，会话也必须被登记（否则写盘对齐找不到它）；
//   2. 项目配置写坏了（error）也不丢登记 —— 改好配置后同一会话要能立刻吃到；
//   3. 写盘对齐会把「本代没登记、但确实活在这个项目里」的会话并进来（热加载换代兜底），
//      且不会误抓其他项目的会话。
//
// 断言口径用导出的 liveWorkspaceAgentCount：它就是 agentWorkspaceStates 的投影，
// 也是面板「N 个会话在用」的数据源。修复前 1/2 两条都会得到 0。

import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CI 只装 yaml：把宿主内部的 @deepseek-ai/dsh-atomic-write 换成本地替身，
// 之后再动态导入被测模块（静态 import 会先于 register 求值）。
register(new URL("./host-stubs-loader.mjs", import.meta.url).href);
const {
  canonicalWorkspacePath,
  installAgentRuntime,
  liveWorkspaceAgentCount,
  reconcileWorkspaceConnections,
} = await import("../lib/workspace-runtime.js");

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (condition) console.log(`PASS  ${name}${extra ? `  ${extra}` : ""}`);
  else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? `  ${extra}` : ""}`);
  }
};

const dirs = [];
// 断言中途抛错时也必须删掉临时目录。
process.once("exit", () => { for (const dir of dirs) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 忽略 */ } } });
async function makeProject() {
  const dir = await mkdtemp(join(tmpdir(), "armory-ws-"));
  dirs.push(dir);
  return canonicalWorkspacePath(dir);
}
async function writeConfig(dir, text) {
  await mkdir(join(dir, ".dsh"), { recursive: true });
  await writeFile(join(dir, ".dsh", "mcp.json"), text, "utf8");
}

// 最小宿主替身：只实现 workspace-runtime 真正用到的面（on/effect/get/tools/loader）。
// agents 服务用于第 3 条（存活会话兜底）；effect 立刻执行工厂并记住 disposer，
// 与 cordis 对「已激活作用域」的语义一致。
function fakeHost({ agents = [] } = {}) {
  const handlers = new Map();
  const tools = { schemas: () => [], register: () => () => {} };
  const root = {
    logger: { warn() {}, error() {}, debug() {} },
  };
  const ctx = {
    root,
    logger: root.logger,
    tools,
    loader: { entries: () => [] },
    get(name) {
      if (name === "tools") return tools;
      if (name === "agents") return { list: () => agents.slice() };
      return undefined;
    },
    on(event, callback) {
      const list = handlers.get(event) || [];
      list.push(callback);
      handlers.set(event, list);
      return () => {
        const current = handlers.get(event) || [];
        handlers.set(event, current.filter((item) => item !== callback));
      };
    },
    effect() {
      return () => {};
    },
  };
  return { ctx, handlers };
}

function fakeAgent(cwd) {
  return {
    id: `session-${Math.random().toString(36).slice(2)}`,
    session: { header: { cwd } },
    ctx: {
      effect() {
        return () => {};
      },
      tools: { register: () => () => {} },
    },
  };
}

async function announce(host, agent) {
  installAgentRuntime(host.ctx);
  const listeners = host.handlers.get("agent/created") || [];
  if (!listeners.length) throw new Error("installAgentRuntime 没有订阅 agent/created");
  for (const listener of listeners) await listener({ agent });
}

// ---- 1. 没有项目配置文件时也必须登记 ---------------------------------------
{
  const project = await makeProject();
  const host = fakeHost();
  const agent = fakeAgent(project);
  const before = liveWorkspaceAgentCount(project);
  await announce(host, agent);
  const after = liveWorkspaceAgentCount(project);
  ok("无 .dsh/mcp.json：会话仍登记（修复前 = 0）", before === 0 && after === 1, `before=${before} after=${after}`);
}

// ---- 2. 配置写坏（error）也不丢登记 ----------------------------------------
{
  const project = await makeProject();
  await writeConfig(project, "{ 这不是 JSON");
  const host = fakeHost();
  const agent = fakeAgent(project);
  await announce(host, agent);
  ok("配置无效：会话仍登记，改好配置后可立刻对齐", liveWorkspaceAgentCount(project) === 1);
}

// ---- 3. 写盘对齐并入未登记的存活会话，且不跨项目 ---------------------------
{
  const project = await makeProject();
  const other = await makeProject();
  const live = fakeAgent(project);
  const outsider = fakeAgent(other);
  const host = fakeHost({ agents: [live, outsider] });
  installAgentRuntime(host.ctx);
  // 不触发 agent/created，模拟「本代上线前就在跑」的会话。
  const result = await reconcileWorkspaceConnections(host.ctx, project);
  ok("写盘对齐：并入本代未登记的存活会话", liveWorkspaceAgentCount(project) === 1, `remounted=${result.remounted}`);
  ok("写盘对齐：其他项目的会话不被误抓", liveWorkspaceAgentCount(other) === 0);
}

for (const dir of dirs) await rm(dir, { recursive: true, force: true });

console.log(failures ? `\n${failures} 条断言失败` : "\n全部通过");
process.exitCode = failures ? 1 : 0;
