# 设计与限制

这份文档回答「它为什么这么设计、边界在哪」。日常使用请看 [README](../README.md)、[安装与升级](installation.md) 与 [JSON 导入](json-import.md)。

- [项目 MCP 的共享连接模型](#项目-mcp-的共享连接模型)
- [连接状态语义](#连接状态语义)
- [入口显示偏好](#入口显示偏好为什么不能两个都关)
- [更新提示](#更新提示这次变了什么为什么要本地写一份)
- [已知限制](#已知限制)
- [兼容性与依赖细节](#兼容性与依赖细节)
- [设计约束](#设计约束)
- [包结构](#包结构)

## 项目 MCP 的共享连接模型

同一项目的多个会话**共用一份**项目 MCP 连接：

- 每个 `(项目目录, serverName)` 在整个 `dsh web` 进程内只启动**一份** `mcp-client` 实例，因此 `serverName` 只登记一次，**并发会话不会撞名**（并发建连与释放/重建均做了串行化：建连 promise 先入表、释放保留占位直到连接完全销毁）。
- 该连接注册出的工具会投射进**每个属于该项目的会话**自己的工具层，所以每个会话都能看到并调用；其他项目的会话看不到（隔离保留，默认不可见、显式投射，不依赖“事后屏蔽”）。
- 引用计数管理生命周期：该项目第一个会话建立连接，最后一个会话结束后释放；会话销毁与插件卸载都会等到连接真正关闭。
- **引用所有权完全交给 cordis**：每一份引用由一个 `agentCtx.effect()` 唯一持有。因此两个边界情形都不需要本插件另建一套存活性判定：会话在建连期间被销毁时（`dsh-agent-loop` 的 `raceAbort` 会抛弃 setup 但不取消它），`effect()` 的 `assertActive()` 当场抛出，引用当场归还；会话正常结束时由 cordis 跑 disposer，并因为它是异步 disposer 而被 `Fiber._unload` 等待。插件 HMR 卸载是另一个纤度的事实（插件代次），由它自己的令牌判定，不与会话存活性共用同一张表。
- **为什么必须共享**：`serverName` 同时是进程内唯一的注册名和模型可见工具名 `mcp__<serverName>__*` 的前缀。「每会话各起一份」既会撞名，也不能靠“每会话换个名字”绕过——换名等于换工具名，会话恢复时的历史工具调用和 prompt 缓存都会失效。

### 与 MCP 规范的关系（按版本说清楚）

- 规范 **2026-07-28** 修订版新增了 Statelessness 一节：服务器 **MUST NOT** 依赖同一连接上的先前请求建立上下文，**SHOULD** 准备好处理来自多个任务/线程/会话的请求，客户端 **SHOULD NOT** 把单个任务/会话当作 stdio 进程的生命周期边界。按这一版，共享连接 + 并发多路复用正是被鼓励的形态，而“每会话一个子进程”反倒是被劝阻的。
- 但随 DSH 分发的 `@modelcontextprotocol/sdk` 目前协商的是 **2025-11-25**，那一版**没有** Statelessness 一节，取而代之的是 Lifecycle Management（含 session control）。也就是说：**按 2025-11-25 实现的服务器完全可以合理地维护连接级会话状态**，这不算它的缺陷。
- 传输层的并发安全是有保障的：一个 `Client` 实例的请求 id 单调唯一（SDK 的 `_requestMessageId++`）、响应按 id 路由，stdio 一次 `write` 写整帧，所以多个会话在同一连接上交织调用不会串线。DSH 是单进程多会话，因此不需要生态里那些代理方案的 shim/broker/socket 和请求 id 重映射。

### 不适合共享的服务器（重要：本插件只提供 shared 一档）

把会话身份隐式绑在连接/进程上的服务器（浏览器自动化、SSH 会话、编辑器缓冲区、按连接建索引等）在多会话共享时会串状态。

生态里的代理方案通常提供 `shared / isolated / session-aware` 三档开关（如 [mcp-mux](https://github.com/thebtf/mcp-mux)、[jasonwarta/mcp-mux](https://github.com/jasonwarta/mcp-mux)、[punt-labs/mcp-proxy](https://github.com/punt-labs/mcp-proxy)）。**本插件目前只提供 `shared` 这一档**（每个 `(项目, serverName)` 一份共享连接）。

关于 `isolated`：在 DSH `0.1.0-rc.7`/`rc.8` 上它确实做不到——那时 `serverName` 全进程唯一，per-session 隔离必须 per-session 换名，而换名会连带换掉模型可见的工具名。但 **DSH 0.1.5 起底层已经支持**：`mcp-client` 按注册作用域判重，同一个 `serverName` 可以在不同会话作用域里各挂一份而互不冲突（本插件的项目级共享作用域吃的就是这个能力）。所以要补 `isolated` 档，缺的只是插件的档位开关与 UI，不再是宿主限制。在那之前，请把这类服务器当作**不支持**，改用下面的做法：

- 这类服务器**在项目作用域下不被支持**。把它挪到全局作用域也没用（那只是从“本项目所有会话共享”变成“所有项目所有会话共享”，隔离更差）；在项目里另起一个 `serverName` 同样无效（`serverName` 区分的是服务器，不是会话）。
- 可行的做法：让该服务器改用 `streamable-http` 并自己按请求参数分区状态，或者用一个外部代理（上面那几个项目）在 DSH 之外做隔离。
- 规范给出的正解是 `session-aware`：状态跨请求时用请求里显式传的标识符引用（2026-07-28 的 “State that needs to span multiple requests MUST be referenced by an explicit identifier the client passes on each request”，实践上就是 `_meta` 里带会话 id，mcp-mux 的 `_meta.muxSessionId` 就是这么做的）。当前 `dsh-mcp-client` 不注入任何 per-request `_meta`，所以共享连接对服务端是**匿名**的；等上游支持按调用注入会话标识后，这一档才能补上。

生态里的同类问题与同方向实践：Claude Code 每会话各起进程导致的内存压力（[claude-code#28860](https://github.com/anthropics/claude-code/issues/28860)，Anthropic 侧的 shared-daemon 提案，已关为 duplicate）、Serena 在多客户端打开同一项目时的重复实例与并发写问题（[serena#1235](https://github.com/oraios/serena/issues/1235)，Serena 自己给多 agent 场景的建议是改用 HTTP/SSE）。DSH 是单进程多会话，能直接在进程内共享，不需要 daemon 或代理。

## 连接状态语义

`@deepseek-ai/dsh-mcp-client` 不对外暴露连接成功/失败事件。面板因此用两条官方事实拼出状态：**已注册的工具数** 与 **cordis fiber 的状态代号**。日志只用来填失败原因的文案，不参与判定。

- **已连接（connected）**：只有该 server 的工具已注册（`mcp__<server>__*` 数量 > 0）才判定为已连接。插件 fiber 处于 ACTIVE 只说明 mcp-client 在跑，不能证明握手成功——`failOnStartupError: false`（默认）时连接失败也会让 fiber 保持 ACTIVE。
- **连接失败（failed）**：fiber 已 ACTIVE（mcp-client 的 `apply` 要等首次连接与 `tools/list` 结束才让 fiber ACTIVE）却没有任何工具，或者 fiber 本身处于失败态。具体原因取自 mcp-client 最近的日志（通过 `ctx.logger.exporter` 订阅并按 `mcp-client(<serverName>)` 过滤），例如 `connection attempt failed: ECONNREFUSED`、`giving up after 10 consecutive failed reconnect attempts`；拿不到日志时就如实写“未注册任何工具”。
- **连接中（loading）**：fiber 尚未 ACTIVE（还在跑 apply）。不猜测成功也不猜测失败。
- **已停止（stopped）**：没有 fiber。全局意为条目未加载；项目语境里意为「这条共享连接还没建立」（新会话挂载时才建），面板显示为「尚未建立连接（新会话自动挂载）」。

全局与项目行走的是**同一个判定函数**（`mcp-observability.deriveMcpPhase`）与同一个取值域，只有文案不同。**项目行刻意把两件独立的事分开说**，不合成一个状态：

- **连接在不在** —— 由上面那套判定给出：`已连接` / `连接中…` / `连接失败` / `尚未建立连接（新会话自动挂载）`。连接按空闲策略保留（见「生效时机语义表」），所以"当前没有会话在用"不会显示成"没连上"。
- **几个会话在用** —— `refs`：`已连接 · N 个会话在用 · M 工具` / `已连接 · 当前无会话使用（连接保留，下次直接用）`。

早先的文案把两者压成一句「待会话挂载」，用户读成"还没连上/排队中"，而事实常常是"连接在、只是当前没会话用"——这正是它被改掉的原因（文案推导现在是模块作用域的纯函数 `wsSub`，由 `test/client-behavior.test.mjs` 直接断言）。**三类**失败分开告知，不混为一谈：

- **挂载失败**（`mountFailed`）：本插件在**会话挂载阶段**（`agent/created` 串行监听器）就挂不上（配置里的 `${VAR}` 求值为空、`failOnStartupError: true` 下启动失败、工具注册被拒等）。
- **连接失败**（`status === 'failed'`）：mcp-client 那边的事。两者由 Host 分开标记，客户端不再用「lastError 存在」反推挂载失败。
- **作用域故障**（`scopeFailed`）：连接是好的，但工具不在共享作用域层——工具落到了全局层，说明 `@deepseek-ai/dsh-scope` 在宿主与插件之间解析成了两份模块实例（作用域标签是模块内的 Symbol）。这是最隐蔽的故障形态：`tools.schemas(scopeKey)` 认不出标签时会**退回全局层**，面板因此显示「已连接 N 工具」，而工具其实对所有会话、所有项目都可见。所以判定直接对比全局视图（同名前缀的工具出现在全局视图 ⇒ 它们不属于本作用域），并把原因写在 `scopeFailed` 行与 `mcpManager/projectConnections` 的 `scopeError` 上。判定刻意保守：只有「没有同名全局条目、也没有其他项目用同名」时才断言，否则无法与「别人的同名实例的工具」区分；同一连接只判定一次（结论缓存在连接上，不在轮询里重复开销）。

项目 MCP 的工具注册在它自己的共享作用域层里，全局工具视图看不到，所以面板按该作用域枚举（不是走全局 `tools.schemas()`）。

## 生效时机语义表

项目配置的每一种改动各自在什么时候生效，只有一条规则：**写盘即对齐**（`reconcileWorkspaceConnections` 是「配置 → 连接集 → 会话投射」的唯一同步点）。

| 改动 | 生效时机 | 机制 |
|---|---|---|
| 新增 server | **立刻**（含正在运行的会话） | 写盘后 reconcile → 为存活会话 acquire 连接并投射工具 |
| 删除 server | **立刻**（含正在运行的会话） | 连接立刻 retire，指向它的会话投射整批撤掉（不留僵尸工具） |
| 改已有 server 的配置 | **立刻**，就地重载 | 指纹变了就销毁旧连接、按新配置重建，并把所有会话的槽位改指新连接 |
| 屏蔽 / 取消屏蔽（`exclude`） | 立刻 | 重算 `restrict` 写入会话作用域 |
| 手工编辑 `.dsh/mcp.json` | 下一次会话挂载时 | 挂载路径自己会做同一套对齐（没有文件监听器，所以不是"立刻"） |

「改配置就地重载」不是自创的取舍，而是宿主对配置条目的既有语义（`dsh-mcp-client` README：*"Editing the configuration entry reloads the server connection in place, and unchanged names stay unchanged"*），而且它安全：**工具名是 `(serverName, rawName)` 的纯函数**，重载后名字不变，所以会话历史与权限规则不受影响。旧实现选择"复用旧连接 + 面板标 `配置待生效` + 等所有会话结束"，代价是用户改了配置却看不到变化——那条路已删除。

**连接的生命周期跟配置走，不跟会话走**：最后一个会话结束只归还引用并起一个空闲计时器（`idleTimeoutMs`，默认 5 分钟，`0` = 永不回收），连接与 stdio 子进程都留着，下次会话直接复用。这既符合 MCP 规范对 session 的关闭时机（"不再需要（例如用户要离开客户端应用）"），也避免反复起停进程（社区里"重连一次泄漏一个进程"的那类问题）。真正销毁只在：配置删除/改动、面板「重连」、插件卸载、或空闲超时。

### 项目级专有字段（`.dsh/mcp.json` 里每个 server 可写）

这两个键是**本插件的策略**，不属于 mcp-client 的配置 schema（`toMcpClientConfig` 不把它们下发；下发了会被未知字段拒绝）。它们是数字，单位毫秒，`0` 都是有意义的值而不是"未设置"：

| 字段 | 默认 | 语义 | 边界 |
|---|---|---|---|
| `idleTimeoutMs` | `300000`（5 分钟） | 最后一个会话结束后，连接还保留多久；到点才真的销毁 | `0` = 永不自动回收（常驻）。上限 `2147483647`（与宿主其他计时器同口径） |
| `readyTimeoutMs` | `5000` | 挂载时等待这条连接就绪的**共享总预算**；预算内就绪则工具赶在首轮之前进声明 | `0` = 不等就绪（回到纯异步，工具由 `tools/change` 补）。同一次挂载只取各 server 上限的最大值，不逐个相加 |

两者都会被面板的编辑表单原样带回（表单是重建 spec，不渲染的字段必须显式保留），也都在 `normalizeEntry` 里做同一套校验（非负安全整数、不超上限）。`idleTimeoutMs` 尤其**不得**进入 `MANAGED_CONFIG_FIELDS`——那个集合决定哪些字段会被写进全局 profile 补丁，而它是项目级策略。

### 只读诊断接口（排障用）

面板每行只回答得了「这个项目的这个 server 怎么了」。进程级的问题（一共有几条共享连接、有没有引用卡住不归零）由一个只读 RPC 回答：

```
mcpManager/projectConnections → { connections: [{ wsPath, serverName, state, refs, sessions, toolCount, fiberState, configStale, configError, duplicateOwners, scopeError }] }
```

- `state`：`ready`（已就绪）/ `connecting`（建连中，还没有连接态可读）/ `disposing`（释放中，占位未清）。卡在后两种状态不走才是最需要排障的形态，所以它们也如实出现在列表里。
- `refs` 与 `sessions` 是**两个独立事实**：前者是引用计数，后者是真实持有它的存活会话数。健康时二者相等；`refs > sessions` 就是漏了引用（会话已销毁但引用没归还），后果是连接永不释放、配置永远刷不新。接口不把两者合成一个“健康”布尔，判读留给使用者。
- `configStale` 为 `null` 表示无从判定（还没建连，或配置里已经没有这个 server），不伪造 `false`；读配置失败时原因在 `configError`。
- `scopeError` 非空表示作用域视图不可用（工具落到了全局层，见上文的作用域故障）：这是「工具对所有会话可见、而面板看着一切正常」的唯一可见证据。
- 全程只读：不改引用计数、不碰 fiber、不触发建连或释放。面板目前不接线，它是给排障留的接口。

## 入口显示偏好（为什么不能两个都关）

面板只有两个入口：右下角悬浮按钮（`shell.overlay`）与左侧栏底部「MCP」（`sidebar.footer.action`，0.1.5 起声明）。两个都能单独关掉，但**不能同时关**——真关了两者，面板就再也打不开（只能手改 localStorage 才能回来）。

这条不靠 UI 的禁用逻辑保证，而靠**数据模型**：偏好存的是一个三值枚举（`both` / `fab` / `sidebar`），不是一个入口一个 boolean。「两个都关」这个组合在类型里不存在，所以不需要守卫、灰置的按钮或「至少留一个」的提示文案；`test/client-entry.test.mjs` 直接对那张可见性表断言「每一项至少一个入口可见」，将来新增入口时先在那里红，而不是等用户把自己锁在门外。

两个实现要点值得写下来，因为都是踩过的坑：

- **面板的挂载点与悬浮按钮是同一个 slot 注册**（`shell.overlay`），所以「关掉悬浮按钮」只能是不渲染那个按钮，注册必须留着——侧栏入口只改 `panelVisibility`，真正渲染面板的是这个组件。把整个组件也用偏好门住 = 侧栏入口点了没反应，用户直接锁死。渲染决策抽成纯函数 `overlaySeats()`，就为了把这条能脱离 React 测出来（组件在 node 里渲染不起来，测试替身的 hooks 是空实现）。
- **侧栏入口隐藏用「渲染 null」，不注销注册**：宿主 list 型 slot 把每个条目的组件直接渲染进侧栏的 `.footerActions`（`display:flex`、无 gap/padding），外层 outlet 锚点又是 `display:contents`，所以空子树不占布局、也不留空行（对着 0.1.5-rc.2 的 `dsh-client-ui-renderer` 确认过）。注销注册要多管一份生命周期，换不来任何可观测差别。

偏好存 localStorage（`dsh-mcp-manager-ui/entry`），与悬浮按钮位置（`dsh-mcp-manager-ui/fab-pos`）同一条路。不进 profile 配置：本插件没有 Config 面，客户端半也拿不到插件配置，为一个显示偏好加一条 host→client 投递不划算，而且改配置还要等宿主热加载。localStorage 是外部输入（旧版本写的、手改的、原型链上的键），一律归一化回默认；存储被禁用时本次会话内仍然生效，只是不跨会话记忆。

## 更新提示：「这次变了什么」为什么要本地写一份

升级后第一次打开面板时会弹一张卡片，列出这次的变化并指路（例如「入口」开关在面板右上角）。它存在的理由很直接：新能力如果只写在 README 和 release note 里，用户不会去找——上一个版本的「入口」开关就是这么被忽略掉的。

**触发点是「打开面板」而不是「页面加载」**：提示的本来就是面板里多出来的东西，用户在面板里才用得上；挂在面板里也意味着它随面板挂载，加载时不会用一个弹框把应用挡住（曾经是页面加载触发，实测那样会挡启动，而收益并不更大）。

四个取舍，改它之前先读：

1. **内容真源是 `lib/whats-new.js`，不是 GitHub Releases**。抓远端会让网络、限流、离线决定这条提示出不出得来；而现有的 `updateHint`（「有新版本可用」提示条）已经确立了「纯增值信息、失败静默」的设计，不该再把一条用户点名要的提示压在同一链路上。本地常量还顺带保证同一版本在任何机器上提示的内容完全一致。
2. **`package.json` 的版本必须是这里的最后一条**（`test/whats-new.test.mjs` 钉住）。这是对根因的治理：bump 了版本却没写「变了什么、在哪找」，本地就红，发不出去。
3. **「上次确认过的版本」存客户端**（localStorage，与 `updateHint.dismissed` 同一个惯用法）。它是每台浏览器自己的事实，宿主没有这个视角；所以宿主只给真源与当前版本，判定放客户端的纯函数 `whatsNewFor`。
4. **分不清「新装」和「从还没有这个提示的版本升上来」时，偏向说一次**。两者在 localStorage 里都没记录，而后者正是要覆盖的人；所以没记录时只报当前这一条（不满屏倒历史，也不漏掉这次的变化），代价只是新装用户看到一条本次更新。反过来，认得出上次那版就报它之后的全部，跨版本升级不漏。

落盘时机是**确认关闭**而不是显示：显示即落盘会把用户没看到的提示直接吞掉，确认才代表看过。而「知道了」、点遮罩、Esc 都算确认，而且提示挡住面板时**唯一能出来的路都会确认它**（想不确认只能直接关掉标签页），所以实际观感就是「每个版本弹一次」。

它是**阻塞式**弹框（遮罩盖住面板），这是有意的：要「不会被忽略」就得有分量，代价是升级后首次打开面板会挡一下。另外，因为它不是用户主动打开的，键盘可达性由它自己负责——打开时聚焦「知道了」、Esc 关闭、并用一个 `focusin` 守卫把焦点拦在弹框内。这里不能用「延迟一点再 focus」：宿主应用会把焦点抢到自己的输入框（实测在弹框出现后约 300ms），延迟等于在赌对方的时序；同一个原因，关闭时只能**尽力**把焦点还给应用原本想聚焦的那个节点（节点已被应用重建就算了，不猜选择器）。

## 已知限制

- **首轮就绪**：挂载时会在**共享就绪预算**内等待连接就绪（`readyTimeoutMs`，默认 5s，`0` = 不等），所以首轮请求里就有工具——这是宿主自己的契约（`dsh-mcp-client` README：*"The server's tools appear before the harness starts its first turn"*）。超时**不算失败、也不阻断会话**：预算用尽就先开起来，就绪后由 `tools/change` 补投射；连接状态由 fiber 状态与工具数如实呈现。预算是"这次会话创建"的总预算（取各 server 上限的最大值），不是每个 server 各发一份——否则 5 个连不上的服务器会给每次会话创建加上 5 倍等待。若某个服务器配置了 `failOnStartupError: true`，则按官方语义等它出结论（这条是用户显式选择的等待，不受预算约束）。
- **屏蔽不释放全局实例**：「屏蔽」全局 MCP 只隐藏它的工具，该 serverName 的全局实例仍在运行（占用它自己那个作用域）。DSH 0.1.5 起项目可以直接用同名服务器独立连接，不需要先把全局那份禁用；更早的宿主按全进程唯一判定，那时同名会启动失败。
- **同名按注册作用域隔离（0.1.5 起）**：`mcp-client` 按**注册作用域**判定 `serverName` 唯一性（`scopeOf(ctx) ?? ctx.root`），而本插件给每个 `(项目, serverName)` 一个独立作用域，所以项目之间、全局与项目之间同名都是合法配置，各自独立连接、各自注册工具（实测：同一作用域内同名仍被拒绝）。
- **共享连接按配置就地重载**：见上文「生效时机语义表」——改配置立刻重载连接并改指会话槽位；连接不再随会话结束而销毁（空闲保留）。
- **连接进入终态后要有人拉一把**：mcp-client 的重连有次数上限，耗尽后它注销工具并停止，只能靠重载配置或重启宿主恢复（它的 README 明写）。项目 MCP 不是常驻服务（VS 重启、脚本结束都会让它消失），所以这个终态几乎必然出现：挂载路径会在下次有人用时把已死的连接拆掉重建，面板的「重连」按钮提供立即出口。
- **不支持 per-session 隔离**：见上文「不适合共享的服务器」。
- **会话结束后不再需要"等旧连接销毁"**：连接不随会话结束而销毁（空闲保留），所以"关掉最后一个会话后立刻重开"不会撞上释放窗口——直接复用同一条连接。只有真正重建（改配置、点重连、空闲回收后重建）时才需要等旧连接 teardown，这段等待取决于 MCP 服务端退出的快慢。**上界约 9 秒**：MCP SDK 的 stdio 关闭本身最多等 2s（stdin 关掉）+ 2s（SIGTERM）再 SIGKILL，mcp-client 对关闭确认又有 5 秒上限。同一会话的多个 server 是并行释放的，不累加。实测正常服务器远低于这个上界（Windows、SDK 1.30.0）：`transport.close()` 对 `@modelcontextprotocol/server-memory` 35ms、`mcp-deepwiki` 43ms、`fast-context-mcp` 34ms、`serena` 167ms；整个 `dsh web` 进程的优雅退出（同时拆 4 个 stdio + 2 个 HTTP 连接）约 0.5s。慢的前提是服务器不理 stdin EOF，见下一条。
- **Windows：忽略 stdin EOF 的 stdio 服务器会漏孙进程**。stdio 服务器在 Windows 上通常是一条进程链（`npx` 解析成 `npx.cmd`，于是 `dsh → cmd.exe → node`），而 MCP SDK 的 `StdioClientTransport.close()` 只对**直接子进程**发 SIGTERM/SIGKILL（`sdk/dist/esm/client/stdio.js` 的 `close()`），没有 job object，孙进程不在射程内。实测常见服务器（memory、deepwiki、fast-context、serena、chrome-devtools）都在 stdin EOF 时自行退出，因此 DSH 正常退出与被强杀都**不残留进程**；但这份干净来自服务器行为，不是 transport 的保证——故意忽略 stdin EOF 的服务器会让 `close()` 吃满 4 秒（2s + 2s）并留下一个孤儿孙进程。遇到这类服务器请让它自己处理退出，或改用 `streamable-http`。
- **DSH 的退出宽限是 5 秒**：官方启动器在 SIGINT/SIGTERM 后只给整棵插件树 5 秒（`dsh/lib/profile-boot-*.js` 的 `PROCESS_SHUTDOWN_TIMEOUT_MS`），超时就 `process.exit()`。正常情形绰绰有余（实测 ~0.5s），但若同时有多个“退得慢”的服务器，退出可能在 teardown 完成前被强行截止。
- **来源导入只取用户级 `mcpServers`**：`~/.claude.json` 里的 `projects[*].mcpServers` 不展开（那会把每个历史项目都铺出来）；项目级配置请从项目标签导入 `.mcp.json`。单文件超过 8 MB 的来源会被跳过。
- **插件热重载会清空运行中会话的项目工具**：HMR/卸载时会撤回所有投射并释放连接（否则会留下指向已销毁连接的僵尸工具）。已在运行的会话要重新拿到项目 MCP 工具需新开会话。

## 兼容性与依赖细节

DSH 宿主 API 通过 `peerDependencies` 以 `>=0.1.5-rc.1 <0.2.0` 声明。

**为什么只支持 0.1.5 起**：插件依赖两个 0.1.5 才具备的官方能力——

1. **`mcp-client` 按注册作用域判 `serverName` 唯一性**（`scopeOf(ctx) ?? ctx.root`；更早的版本把注册表挂在 `ctx.root`，全进程唯一）。项目级 MCP 的「跨项目/全局与项目同名」就建立在这条上。
2. **`setup` 把 agent 作为第二个参数交给插件**（`setup?.(prepared.agent.ctx, prepared.agent)`；更早的版本只传 ctx）。项目 MCP 的挂载需要 agent 的 `session.header.cwd`；从 ctx 上读 agent 会被 cordis 服务守卫拒绝（`cannot get property "agent" without inject`），而 setup 抛错会让会话的创建与恢复直接失败。

旧版本不再兼容，也不再为它们保留降级分支。

### 版本范围怎么定（以及它管不到什么）

三条取舍规则，改动范围前先读这里：

1. **下限是硬要求，上限是宿主执行的硬闸门**。`0.1.5` 之前没有上面那两个能力，装上必坏，所以下限不能松。上限 `0.2.0` 只在宿主确实会向后破坏时才有意义——DSH 自称「开发者预览…未来将出现破坏兼容性的变更」，而插件面对宿主升级必然慢一步，所以留一个**粗**上限：它的作用是把「你正跑在一个我们没验证过的大版本上」变成宿主明确的拒绝，而不是静默装上再出怪问题。

   **这道闸门由 DSH 自己执行，不是 pnpm/npm**——安装器的 peer 警告（如 pnpm 的 `[WARN] Issues with peer dependencies found`）既不是判定依据，也不与它一致。`dsh-app-boot` 的 `evaluatePluginCompatibility` 拿 `dsh --version` 的实际版本比对本插件的 `peerDependencies`：不兼容的 bundle 会被跳过并打印 `skipping profile bundle …`，插件根本不加载（走 profile 清单的 `preflight` 路径时则是 `disabling profile plugin …`）。用户不想升级时可以授予**精确版本**豁免继续用：`dsh plugin --profile <profile> allow-version <name>@<version> --dsh-version <exact> --accept-risk`（豁免按 `name@version` × 精确宿主版本记账，落在 profile 目录的 `compatibility.json`）。**下限不会挡住任何新版本，只有上限可能「限死」，所以上限宁粗不细。**
2. **预发布不需要特殊照顾**。按 npm 的 semver 规则，`0.1.6-alpha.1` 会落在 `>=0.1.5-rc.1 <0.2.0` 之外（预发布只在同名 `major.minor.patch` 元组内被承认）。但**上面那道闸门不套用这条规则**：`evaluatePluginCompatibility` 调 `semver.satisfies` 时带的是 `{ includePrerelease: true }`，预发布因此按数值参与比较——`0.1.6-alpha.1`、`0.1.7-rc.2` 乃至 `0.2.0-rc.1` 都落在范围内，只有 `0.2.0` 及以后的正式版（以及 `0.3.0-rc.1` 这种更高元组的预发布）才越界。所以这个范围既不会挡住 0.1.x 的预发布，也不会挡住 0.1.x 的正式版——不必为「覆盖未来预发布」去改范围。

   注意这条**只对宿主自己的闸门成立**：拿不带 `includePrerelease` 的严格 semver 去判，`0.1.7-rc.2` 会被判为不满足 `>=0.1.5-rc.1 <0.2.0`（下限元组是 `0.1.5`，认不了 `0.1.7-rc.x`）。谁要复核这个范围，必须用宿主自己的 `evaluatePluginCompatibility`，而不是 `semver.satisfies(range)` 或 pnpm 的 peer 检查——那两者会给出相反的结论。实测（用宿主导出的函数跑本插件的真实 `package.json`）：`0.1.5-rc.1` / `0.1.5-rc.3` / `0.1.6` / `0.1.7-rc.1` / `0.1.7-rc.2` / `0.1.7` / `0.1.8-rc.1` / `0.1.8` / `0.2.0-rc.1` 全部无 issue，仅 `0.2.0` 与 `0.3.0-rc.1` 被拒。
3. **范围回答不了「装上还对不对」，而 CI 也只能盖住一半**。`0.1.6-alpha.2` 把 typert strict codec 从 `schema:`（zod v4 实例）换成 `create()`（进程内 realm 的懒工厂，registry 用 `record.value ??= record.create()` 物化）就是这么一次：它落在 `>=0.1.5-rc.1 <0.2.0` 之内，插件的兼容性声明天生拦不住，2026-09-21 的漂移任务因此变红（那一次 130 项里唯一失败的就是加载期契约那条）。真正的保护分两层：**(a) 运行时契约**由 [`.github/workflows/upstream-drift.yml`](../.github/workflows/upstream-drift.yml) 每周把宿主整套换到 `latest` / `next` / `alpha` 三个渠道跑契约用例（`test/*.test.mjs` 去掉 `package-contract`，因为那份断言的是 pin 本身）；**(b) 宿主侧的加载期契约**（`lib/typert.js` 的形状由宿主 loader 校验，不由我们校验）由 `test/typert-manifest.test.mjs` 覆盖：它直接调宿主自己的 `validateTypertManifest` 验这份产物，形状一变就红；同一文件里还有一条**不依赖 loader 版本**的形状断言，钉住「strict codec 同时带 `schema` 与 `create()`」（下一条理由）——本地 devDependency 的 loader 是开发基线，看不见 alpha 的要求，只靠前者要等一周才知道。这一层原本是缺口——既有用例只保证 `lib/typert.js` 与 `lib/client.js` 两份产物彼此一致（`client-lifecycle.test.mjs`），宿主改了要求也不会变红，而后果是用户升级 DSH 后面板整个不可用。它也是 `@deepseek-ai/dsh-typert-loader` 只进 `devDependencies`、不进 peer 的原因：校验发生在宿主进程里，插件运行时不 import 它。

**为什么 strict codec 两个键都写**（`lib/typert.js` 与 `lib/client.js` 各一份，`client-lifecycle.test.mjs` 钉住两者一致）：宿主在两个渠道上查**不同的键**，且都忽略对方的键——`0.1.5-rc.x`（= 当时的 `latest` / `next`，也就是 `npx` 默认装到的那条）查 `codec.schema.parse` 必须是 zod v4 实例；`0.1.6-alpha.2` 起查 `typeof codec.create === 'function'`。少写 `schema` 会在最新 RC 上加载即拒，少写 `create` 会在 alpha 上加载即拒；`mode: 'src-json'` 不是出路（loader 强制 invocation 的 codec 必须是 strict）。拿三个版本的 loader 直接跑自己的产物：

| codec 形状 | loader `0.1.5-rc.2` | loader `0.1.6-alpha.1` | loader `0.1.6-alpha.2` |
|---|---|---|---|
| 只有 `schema` | PASS | PASS | 拒：`has no create() factory` |
| 只有 `create()` | 拒：`is not backed by a zod v4 schema` | 拒 | PASS |
| **双写** | PASS | PASS | PASS |
| `mode: 'src-json'` | 拒 | 拒 | 拒 |

`0.2.0-rc.2`（当前开发基线）的 loader 实测与 `0.1.6-alpha.2` 同列：只有 `create()` 通过、只有 `schema` 被拒。也就是说**基线已经落在「只查 `create()`」那一侧**，而只查 `schema` 的 `0.1.5-rc.x` 是更早的渠道——`latest`/`next` 在 2026-09-24 就一起推进到了 `0.1.7-rc.2`、2026-09-29 又一起推进到 `0.2.0-rc.2`，所以它不再是「npx 默认装到的版本」，但仍有用户停在那一批（peer 范围为 `>=0.1.5-rc.1 <0.2.0` 允许，`COMPAT_WINDOW` 不动的原因见上一条）。两个键都不能删，且本地测试已看不到 `schema` 那半边（由 `test/typert-manifest.test.mjs` 里那条不依赖 loader 版本的形状断言钉住）。

浏览器半（`@deepseek-ai/dsh-typert-registry` 的 `lib/client.js`）做同一份校验，所以 `lib/client.js` 里的 codec 必须同步改——只改 host 那份会变成「面板能加载，一调用就炸」。

漂移任务红了怎么读：

- **契约用例（含真机集成）失败** → 上游契约真的变了，按失败点修插件并发补丁（2026-09-21 那次就是这样红的）。
- **本地 `npm test` 里 `package-contract.test.mjs` 的 pin / lockfile 断言失败** → 宿主可用，去同步 pin：`package.json` 的 devDeps、`DEV_BASELINE`、README / README.en / installation 的「已验证至」，然后 `pnpm install && npm test` 确认全绿。

  这一条**不会**由漂移任务报出来：它的 `files` 是 `grep -v 'package-contract'`，pin 断言按定义就不参与漂移判定。所以「漂移任务绿」不等于 pin 没过期——2026-09-10 到 09-24 之间 pin 停在 `0.1.5-rc.2`，而 `latest` 已经是 `0.1.5-rc.3`、`next` 是 `0.1.7-rc.1`，两周无人发现，就是这条缺口。同步 pin 只有两个触发源：人注意到新 RC，或本地跑完整套件。

  改的时候**别动 `COMPAT_WINDOW`**：它是 peer 窗口（`>=0.1.5-rc.1 <0.2.0`），下限是硬要求、上限是宿主的硬闸门；把它收窄到新版本会挡住仍在 `0.1.5-rc.x` 上的用户（宿主闸门带 `includePrerelease`，所以老版本确实装得上，见上文第 2 条）。要改的常量只有 `package-contract.test.mjs` 的 `DEV_BASELINE`，锁文件里那个具体版本从它推导（原来那里硬编码了一份，是两个真源）。

已实测（2026-09-24，漂移任务 [run 35943153431](https://github.com/Imzl-zl/dsh-mcp-manager-ui/actions/runs/35943153431)，三个渠道各 190 项全绿、0 跳过）：

| 渠道 | 宿主 | 结果 |
|---|---|---|
| `latest` | `0.1.5-rc.3` | 190/190 |
| `next` | `0.1.7-rc.1` | 190/190 |
| `alpha` | `0.1.7-alpha.2` | 190/190 |

2026-09-29 推进基线到 `0.2.0-rc.2`（本地实跑，234 项）：232/234 通过，失败的 2 项都是 pin 断言本身（`DEV_BASELINE` 与锁文件版本仍写着旧基线），同步后 233/234，最后 1 项是文档的「已验证至」——它按 `DEV_BASELINE_VERSION` 推导，同样属于 pin，改文档后全绿。也就是说 **0.2.0-rc.2 上没有任何一条契约用例失败**，含真机集成那组（真 cordis + 真 dsh-tools + 真 dsh-scope + 真 dsh-mcp-client + 真 stdio 子进程）。`0.2.0-rc.2` 落在 peer 窗口内也是必然的：`includePrerelease` 让预发布按数值比较，只有 `0.2.0` 正式版才越界（见上文第 2 条）。

更早：`0.1.6-alpha.1` 上契约用例全绿；`0.1.6-alpha.2` 上修复前唯一失败的是 `typert-manifest` 那条，双写后按漂移任务的文件清单 137/137 全绿（复现方式：把宿主整套换到 alpha.2 再跑那份清单）。

**alpha 全绿不等于它进了「已验证」**：这次它绿是因为我们的改动恰好是追加式（codec 双写 + 结构探测 cordis 私有字段），不是因为它稳定。所以兼容性表只写 `0.2.0-rc.2`——那是承诺；alpha 交给漂移任务每周探测，不承诺。这与上文第 2 条（预发布不需要特殊照顾）是同一个取舍。

**这份证据盖不到的地方**：客户端侧是替身测试（组件在 node 里渲染不起来），所以上表证明的是 **slot 注册契约**成立，不是 slot 在 0.2.0-rc.2 宿主上**渲染**正常。而 `0.1.6-alpha.2` 的发布说明里有「客户端 Session 会话支持多实例共存，相关 API 及 slot 有变化」。这类失败的表现是面板白屏、不会让任何用例变红，所以它属于发布前的人工检查（触发条件见 [安装与升级](installation.md#每次发布) 的「每次发布」），不进 CI。推进基线到 `0.2.0-rc.2` 这一次已按该检查单做过真机复核：面板打开、7 个作用域标签、16 条全局 MCP 正常渲染。

开发基线（`devDependencies`）跟随已验证的最新 RC，并按官方约定**镜像每一个 peer 依赖**（含 `@deepseek-ai/cordis`）；唯一的例外是 `@deepseek-ai/dsh-typert-loader`，它只供测试用（见上文第 3 条），不是运行期宿主契约。这条镜像不是冗余：`dsh plugin ... add <本地目录>` 是 `link:` 安装，Node 会从插件自己的路径向上解析，插件若只声明 peer 而没有本地副本，连它自己那份宿主依赖都找不到；反过来本地副本的传递依赖缺一个（例如旧配置遗漏 `@deepseek-ai/cordis`），整个插件树会在启动时直接加载失败。升级 DSH 后用 `pnpm install && npm test` 验证。

两个不在 `@deepseek-ai/dsh-*` 契约面里、但在真实安装中位于宿主模块层的依赖，值得点名：

- `@deepseek-ai/cordis-plugin-loader`（版本线 `1.0.3`）：`reveal` 用它的 `interpolate` 求值 `!!js` 配置节点。它是 vendor 包，靠 profile 的模块回退解析得到（与 `@deepseek-ai/cordis` 同一条路径）。
- `@deepseek-ai/cordis` 的私有字段：`LoggerService.exporter()` 的 disposer 删的是「当时的最大 ID」而不是注册时的 ID（`lib/index.js` 的 `return () => this.exporters.delete(this._snExporter)`），热重载会误删其他插件的 exporter。本插件因此直接读写 `logger.exporters` / `logger._snExporter` 这对私有字段，并把 peer 锁到 `~4.0.2`；字段形状一变就退回 `exporter()` 通道并明确告警。

peer 怎么被解析到也很关键：官方 profile 的 `pnpm-workspace.yaml` 带 `nodeLinker: hoisted` + **`autoInstallPeers: false`**（`initProfile` 写入，注释写明理由：让缺失的 peer 走 `profiles/node_modules` 安装回退层，「so every plugin shares the installation's single cordis instance instead of a duplicate」）。因此本插件的 9 个 peer **不会**被 pnpm 装进 profile 的 `node_modules`，而是与宿主共用同一份包实例——这一点对 `@deepseek-ai/dsh-scope` 是硬要求：作用域标签是模块内的 `Symbol`，两份实例会让工具投射静默失效（见「连接状态语义」的作用域故障）。如果面板报「作用域隔离失败」，先确认这个配置没被改掉。

## 从本机客户端导入的读边界
来源导入是 Host 唯一一处去读「用户没有通过本插件指定过的路径」（其他客户端自己的配置文件）。边界钉在三处，改动前先读这里：

1. **文件名由来源表固定，目录只来自既有作用域参数**：全局位置从 `HOME` 与各客户端自己的环境变量（`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`XDG_CONFIG_HOME`…）推出，项目位置只往 `wsPath` 后面接固定文件名。浏览器送的是 `sourceId` + `scope`（项目作用域再带既有的 `wsPath`），没有「读哪个文件」这个参数，所以接口面不会变成通用文件读取器。
2. **值不出 Host**：扫描回给浏览器的是名称、传输、掩码字段名三类投影；`maskedSourceFields` 复用列表投影的掩码规则，只报字段名不报值。导入时由 Host 重读文件取真值，不然用户主目录里的密钥就进了浏览器会话。
3. **内容指纹**：预览返回文件内容的 sha256，导入必须回传且一致——没有它，「预览的是 A、导入的是 B」只差一次文件改动。

写盘路径没有新增：全局来源导入复用 `applyManagedImport`，项目来源导入复用 `applyWorkspaceImport`，与粘贴 JSON 是同一个函数。

导入进来的环境变量引用必须是个**总值表达式**（`!!js (process.env.X ?? "")`）：裸引用在变量缺失时求值为 `undefined`，而 mcp-client 的 Config 只接受字符串，会让宿主在启动时整棵树加载失败。这条边界适用于任何新增的导入路径。

同一个地方还要保证**同一作用域内 `serverName` 唯一**：官方 mcp-client 按注册作用域预留 `serverName`，同作用域重名会让插件加载直接抛（`mcp-client: serverName "x" is already in use`，整棵树起不来），项目层则会被 `mcpServers` 的对象键静默覆盖、丢条目。处理方式是**保留先出现的那条、跳过其余**，并把跳过的名字写进预览与导入结果：同批里一条重名不该让其余条目一条也导不进来。名字被 bundle / Agent preset 占用（外部层）是同一类问题，走同一取舍——跳过并提示，而不是整批失败。**读一份项目配置文件时相反**：文件自相矛盾就整份拒绝，静默少一条更糟。

这条规则收在 `lib/import-admission.js` 的 `admitImportedServers` 里，并由两个写盘入口（`applyManagedImport` / `applyWorkspaceImport`）各自调用一次（幂等）：写盘口不依赖调用方记得做，以后新增的导入器也不会漏。`normalizeMcpImport` 只负责归一化与**检测**同名（`duplicateServerNames`），不做策略——策略属于知道赌注的那个边界。

`!!js` 语法只在 `lib/env-expression.js` 里实现（生成 / 校验 / 抽取变量名 / 反转模板 / 求值）。**不要在其他文件里另写解析**：接受面比产出面宽一格，就足以让裸引用直通、把宿主拖下水。

## 设计约束

`dsh-mcp-manager-ui` 是 Web Host 单实例插件。固定的 Remote namespace 和 UI slot id 是有意设计；重复加载属于配置错误，插件会明确失败，而不是静默忽略。多个 MCP server 则由 `@deepseek-ai/dsh-mcp-client` 的不同 `serverName` 实例管理。

## 面板样式：为什么没有任何自选配色

DSH 的 `ui-theme` 拥有全部颜色、几何与字体，插件只消费语义令牌。这不是风格偏好而是硬契约，规范正文在 `docs/web-styling.md`：

> Use `--dsw-alias-*` semantic tokens in feature components. **Do not copy static palette values or write literal colors there.**
> Keep theme selectors out of feature component CSS. **Light/dark overrides belong to the theme owner.**

所以面板里没有 `@media (prefers-color-scheme: dark)`，也没有一处 hex。

> 引用边界：`packages/extensions/cordis-client-runner` 的 `CLIENT_NOTES` 里有同一句话，但那个包服务的是**动态包**（用户在面板里即时求值的代码，走 `styles.insert`），不是预构建插件。预构建插件的契约是 `docs/web-styling.md` 加 `docs/ui-radius.md`，别把动态包沙箱的说明当成通用规范引用。

落地方式是在 `MCP_CSS` 顶部一层别名：把要用的令牌一次性收成 `--mcp-*`，之后一千多行规则只引用别名。换主题、调刻度都只改这一处。

### CSS 怎么进页面：跟官方构建器保持一致

预构建插件的样式由官方构建器 `packages/client/tsdown.client.ts` 的 `styleInjectionModule()` 生成注入代码，形如：

```js
const tag = document.createElement('style')
tag.dataset.plugin = id          // 模块加载器认领/清理的凭据
tag.dataset.pluginCss = tagId    // 插件自己的去重键
tag.textContent = css
document.head.appendChild(tag)
```

本插件是手写 bundle（没有走 tsdown 预设），所以 `__injectCss` 自己实现同一件事，**两个属性都要盖**：

- `data-plugin` 是加载器认领样式的依据。`entry-lifecycle.ts` 的 `removeOwnedStyles()` **只删 `data-plugin === 插件 id` 的标签**；`system.ts` 的 `claimStyles()` 只有一条兜底——认领「materialize 期间新出现的未打标 style」。
- 因此只盖 `data-plugin-css` 时，正常路径靠兜底也能被清掉（所以它长期没暴露），但**在认领窗口之外插入的标签会变成孤儿**，HMR 反复替换时累积泄漏。

`test/client-lifecycle.test.mjs` 钉住了这两个属性，且经变异验证（去掉 `data-plugin` 该测试立刻变红）。

### 别名层为什么挂在 `body`

两个约束同时成立才安全，而且**两个方向都踩过一次**：

1. **必须是三个 slot 子树的公共祖先。** 插件同时往 `shell.overlay`（悬浮按钮）、`sidebar.footer.action`（侧栏入口）和面板自己渲染，它们没有公共祖先。最初别名挂在 `.dsh-mcp-wrap` 上——把圆角改走 `--mcp-r-*` 之后，悬浮按钮的圆角与阴影当场解析失败。
2. **必须与主题令牌同层。** `ui-theme` 把 `--dsw-alias-*` 定义在 **`body`** 上（`design-platform.css` 的 `body{}` 与 `body[data-ds-dark-theme]{}`；`ui-layout` 也是 `body.setAttribute('data-ds-dark-theme','')`）。自定义属性在声明处就完成替换、不参与"向上查找"，所以挂在 `:root`（`body` 的祖先）会取到空值——整片颜色别名失效，卡片与面板背景全部变透明。

`test/theme-contract.test.mjs` 钉住了这条：`aliasHost()` 要求别名宿主是 `body`（真实样式表上断言 `=== 'body'`，违规样本上断言 `:root` 会被照实报出来），`subtreesMissingLabelColor()` 另外要求三个 slot 子树各自都能取到 `--dsw-alias-label-primary`。

### 四条对齐官方 spec 的规则

判据直接对齐 DSH 自己的 spec（`packages/client/ui-theme/tests/`），语义逐条对应，上游收紧时可直接比对：

| 规则 | 判据 | 违反后果 |
|---|---|---|
| 全圆角配对 | `50%`/`100%`/`≥99px` 必须同规则配 `corner-shape: round` | `corner-shape.css` 在 `@supports` 里用通用选择器 `*` 给整个文档套 `superellipse(1.5)`，没配对的圆点被压方、药丸被削平两端 |
| 圆角走刻度 | 不得写字面值，只引用 `--dsw-radius-*` | 官方 spec 把「>4px 且 <99px 的字面圆角」判为违规（≤4px 算绘图细节）；刻度是 `xs:4 / sm:8 / md:12 / lg:16 / xl:20 / panel:28` |
| 抬升表面用阴影不用边框 | `border: 0` + `--dsw-elevation-prominent` | 中性边框与 elevation 阴影并用会画两遍轮廓，且边框宽度撑动布局 |
| 等宽走 `--ds-font-family-code` | 带 fallback，不写字面栈 | 这个是 `ui-theme` 真正定义过的（`base.css` 的 `:root`，官方 51 处用它）。名字很像的 `--dsw-font-mono` 全仓无定义（`dsh-market` 误用了它的 alias 形态 `--dsw-alias-font-mono`），引用它等于永远命中 fallback，等宽字形跟宿主代码块对不上 |

`corner-shape` 那条只在支持该特性的引擎上显形（Chromium 实测 `CSS.supports('corner-shape','superellipse(1.5)') === true`），jsdom 渲染不出来，所以只能扫样式表文本——这也是上游 ui-theme 的做法。

`scripts/theme-spec.mjs` 是这套判据的唯一实现，`test/theme-contract.test.mjs` 用它断言。测试刻意分两侧写，缺一不可：

- **「抓得到错」**——每个扫描器都有一组必须命中的违规样本。否则扫描器退化成"永远通过"时，另一侧全是空的。
- **「不误报」**——在真实样式表上必须全零。否则一个满屏误报的扫描器会被当成噪声关掉。

写这套判据时用变异测试核过一遍：人为在真实 CSS 上制造八类错误（去掉一处 `corner-shape`、圆角换成 `14px`、抬升表面加中性边框、别名层写死颜色、硬编码等宽栈、别名指向不存在的令牌、宿主改回 `:root`、删掉某子树的 label 色），最初只抓到 6/8——漏掉的两条都是**本仓库最常见形态**：规则里写的是别名 `var(--mcp-line)` 而非 `--dsw-alias-border-*`，以及别名层被整体排除后写死颜色无人管。两条都补进了判据。

### 令牌存在性：为什么需要一份快照

「别名指向的令牌真的存在吗」是这套判据里最容易做成空的一条——第一版就是：只对 `--dsw-radius-*` 查清单，其余 `--dsw-*` **只查前缀**。于是 `--mcp-accent:var(--dsw-alias-brand-typo)` 这种名字被静默放行，而上面的八类变异里恰好有一类是"别名指向不存在的令牌"，它在当时其实**没有**被真正抓到（那轮变异把它误记为已捕获）。前缀合法的错名字正是最危险的形态：`--dsw-alias-font-mono` 看着完全像真的，`var()` 却取到空值，面板当场丢色，而 jsdom 渲染不出来。

存在性必须查清单，所以仓库里带一份生成物：

- `scripts/sync-theme-tokens.mjs` 从**宿主源码树**的 ui-theme 样式表抽出全部 `--dsw-*` / `--ds-*` 定义，写出 `scripts/dsh-theme-tokens.mjs`（408 个令牌）。宿主更新时手工重放一次，diff 里能直接看出上游增删了哪些令牌。
- 快照口径是所有**定义**处，不论在哪个选择器下——真机全局扫描只能看到 407 个，少的那个是 `--dsw-focus-ring-color`（定义在 `:focus-visible` 上，只在聚焦元素可见）。存在性检查关心"这个名字有没有人定义"，宽一点才对；收窄会开始误报。
- 不覆盖 `--dsh-*`：那是各包自己的运行时变量，全仓分散、没有单一所有者，不属于主题契约。将来真要用，先扩生成器的采集范围，**不要退回去放行前缀**。

`test/theme-contract.test.mjs` 两头都钉：违规样本必须被抓到，且快照本身要有规模与关键成员（否则清单退化成空表时，存在性检查会反过来变成"任何令牌都不存在"而让另一侧的断言失去意义）。

## 包结构

- `package.json`：声明 `dsh.bundle` 和 Web `dsh.client`
- `cordis.patch.yml`：插入唯一的 Host 插件实例
- `lib/index.js`：`mcpManager` Host Remote
- `lib/mcp-registry.js`：loader 中 MCP 条目的枚举与工具归属推断
- `lib/workspace-runtime.js`：项目配置读写状态、按 `(项目, serverName)` 引用计数的共享 mcp-client 连接，以及把其工具投射进每个会话作用域
- `lib/workspace-config.js`：项目级 `.dsh/mcp.json` 的读写与转换
- `lib/mcp-config.js`：JSON 规范化与 YAML patch 结构化读写
- `lib/mcp-import-sources.js`：本机其他客户端的来源表（位置 + 格式转换）与按条目容错的归一化
- `lib/env-expression.js`：受限 `!!js` 表达式的唯一实现（生成 / 校验 / 抽取 / 反转 / 求值）
- `lib/import-admission.js`：导入结果的写盘前准入（同作用域 `serverName` 唯一、环境变量引用归一为总值形式）
- `lib/mcp-observability.js`：连接状态判定与 mcp-client 日志格式化
- `lib/client.js`：响应式 Web UI、Remote 客户端和生命周期清理
- `lib/typert.js`：Remote 契约描述
- `scripts/theme-spec.mjs`：面板样式对 DSH 主题契约的判据（全圆角配对、圆角刻度、抬升表面、字面色值、等宽字体、别名宿主、别名令牌存在性），由 `test/theme-contract.test.mjs` 断言
- `scripts/dsh-theme-tokens.mjs`：DSH 主题令牌清单（生成物），存在性判据的数据源
- `scripts/sync-theme-tokens.mjs`：从宿主源码树重放上面那份清单

`scripts/` 与 `test/` 都不进发布包（`package.json` 的 `files` 只收 `lib`、`docs/*.md` 与几个根文件），它们是开发期的契约闸门。

`lib/` 是预构建产物，GitHub、tarball 和 npm 安装均不需要执行构建脚本。
