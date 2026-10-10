# 项目级 MCP 的生命周期：为什么是现在这样

这份记录回答三件事：**我们承诺什么**、**依据是什么**（宿主与 MCP 规范的原文，不是我们的偏好）、**否决过什么**（含证据，避免以后重新论证）。

## 一句话不变式

> 配置是唯一真相源：`<项目>/.dsh/mcp.json` 写成什么样，**该项目的下一个模型请求**就必须看到对应的工具集；连接的生命周期跟配置走，不跟会话走。

## 依据（宿主自己的契约，逐条可核）

| 契约 | 原文位置 | 对本插件的要求 |
|---|---|---|
| 工具必须在首轮之前出现 | `packages/mcp/mcp-client/README.md:91` | 挂载时要等就绪（有预算），不能把"还没连上"留给首轮 |
| 掉线期间工具保持列出、调用失败 | 同上 `:93` | 不要在会话结束或短暂断连时把工具撤掉 |
| 重连预算耗尽 → 注销工具并停止，需重载配置/重启 | 同上 `:93` | 必须有"按需重建"的出口，不能等用户重启宿主 |
| 编辑配置条目 = 就地重载连接、名字不变 | 同上 `:93` | 配置改动要立刻重载，而不是"等所有会话结束" |
| 工具名是 `(serverName, rawName)` 的纯函数 | 同上 `:107` | 就地重载对会话历史/权限规则安全 |
| 条目按**预期作用域**配置；同名可在不同 Agent scope 复用 | `docs/subsystems/mcp.md:24,45` | 项目作用域持有一份连接、多会话复用 |
| 给单个会话注册 → 用 `agent.ctx` | `docs/architecture.md:164` | 逐会话投射是**官方指定**做法 |
| 创建事务 await `agent/created` 串行监听器后才释放输入 | `packages/core/agent-loop/README.md:111`、`src/index.ts:624` | 挂载点选在 `agent/created` 上，首轮之前就位由契约保证 |
| 监听器抛错否决创建 | `packages/core/agent/src/index.ts:532-559` | 挂载路径必须自吞错误、只记账，绝不阻断会话 |
| scope 父链单槽位、绑定一次性、多归属不受支持 | `packages/core/scope/README.md:73,102` | 不要试图把项目作用域插进会话链 |

MCP 规范补充了连接语义：session 在客户端"不再需要（例如用户要离开客户端应用）"时才关闭；HTTP 会话失效时服务器回 404、客户端 MUST 重新初始化；工具集靠 `tools/list` + `notifications/tools/list_changed` 维持。主流客户端（Claude Code 空闲 30 分钟、失败可手动 retry；VS Code 工作区级 `mcp.json`）与之一致。

## 现在怎么做

- **挂载点**：一个 `agent/created` 串行监听器（`mountProjectMcpForAgent`）。删掉了对 `agents.create/resume` 的 monkey-patch 及其 generation/restore/双重防线记账——旧注释断言该事件是 fire-and-forget，那是把同步的 `sessions.announce()` 认成了 `agents.announce()`；后者是 `await ctx.serial(...)`。
- **连接生命周期**：配置驱动。`releaseSharedConnection`（会话结束）只归还引用并起空闲计时器；`retireSharedConnection`（不再有效）才立刻销毁。空闲回收 `idleTimeoutMs` 默认 5 分钟，`0` = 永不；插件卸载一律立刻销毁。
- **配置对齐**：`reconcileWorkspaceConnections(ctx, wsPath)` 是唯一同步点，面板每次写盘后调用；挂载路径另做一次 `retireStaleConnection`，于是手工编辑配置文件也会在下一次会话挂载时被采纳。改配置走 `repointConnectionSlots`（所有会话槽位改指新连接、引用随所有权转移），删除走 `dropConnectionSlots`（整批撤投射，不留僵尸工具）。
- **首轮就绪**：共享就绪预算 `readyTimeoutMs`（默认 5s，`0` = 不等），超时不阻断会话。
- **终态恢复**：`isDeadConnection`（fiber ACTIVE 且 0 工具且已存在 > 5s）在下次挂载时重建；面板「重连」= `reconnectWorkspaceServer` RPC 立即拆旧建新并对齐存活会话。
- **面板**：`wsSub` 把"连接在不在"与"几个会话在用"分开说；`待会话挂载` 与 `配置待生效` 两个合成/过期状态被删除。

## 否决过的方案（不要再重新论证）

### 1. 项目作用域 + 会话绑定 + 作用域链继承

**想过**：把项目工具注册在一个常驻项目作用域里，让会话通过 `bindScopeParent` 挂上去继承——这样配置变更不需要逐会话同步，代码能少一大截。

**否决理由（有测试证据）**：`agent/created` 载荷里的 agent scope **父链槽位是单槽位**，而它在真实会话里被 **agent preset 注册表**占用（`packages/preset/agent-preset-registry/src/index.ts:241-250` 的 `join()`）；preset 的 standing key 又按 revision 共享，绑它会跨项目泄漏。`test/scope-chain-inheritance.test.mjs` 用真官方包固化了三个成立的事实（链继承本身没问题、后建作用域会被先开会话继承、真 mcp-client 挂项目作用域可用）与一个不成立的事实（第三方插不进已被 preset 占用的槽位）——**将来若宿主支持多父链或提供官方的 per-agent 附着口，第 4 个用例会失败，那才是重新评估的信号**。

### 2. 连接池

MCP server 是有状态的（HTTP 有 `Mcp-Session-Id`，stdio 是单进程双工），池化必然串状态。减少连接数的正当手段是"让单条连接活得更久"，不是开多条备用。

### 3. 默认缓存工具清单（先声明、后校准）

它确实能让冷启动"零等待"，但会引入新的失败态：模型可能调用一个已不存在的工具（声明与真实不一致）。只有"就绪等待不可接受"时才值得。VS Code 走这条路（"Clear cached MCP tools"），可以作为将来遇到慢服务器时的参考形态，本项目默认不做。

## 验证锚点

| 性质 | 证据 |
|---|---|
| 挂载在创建事务内完成、抛错不阻断 | `test/real-host-integration.test.mjs`（含"抛错否决创建"的夹具保真度对照） |
| 会话开着时写配置 → 活会话立刻可用；移除 → 工具撤回、子进程退出 | 同上 |
| 首轮之前就绪（无 `waitFor` 断言） | 同上 |
| 会话结束不拆连接；空闲超时才拆；`idleTimeoutMs: 0` 永不拆 | `test/workspace-runtime.test.mjs` + 同上 |
| 改配置就地重载、工具名不变、旧会话无需重开 | `test/workspace-runtime.test.mjs` |
| 终态连接按需重建、重建后真的可调用 | 同上（真宿主） |
| 项目行文案区分两个事实 | `test/client-behavior.test.mjs`（纯函数 `wsSub`） |
| README 承诺与面板实现一致 | `test/package-contract.test.mjs` |
