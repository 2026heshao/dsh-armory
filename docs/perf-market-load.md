# dsh-armory 市场加载性能优化 · 执行文档

| 项 | 内容 |
|---|---|
| 版本 | v1.0（2026-10-30）· 实施记录 v1.1（2026-10-30） |
| 状态 | 已实施并部署（P0-1…P2-3 全量；P2-4 按文档排除）。实测修正：冷导入 101.6→96.6ms（7 轮交错中位数，差 ~5%），**未达 ≤85ms 目标**；其余条目按开关可单独回退。回归：`npm test` ALL SUITES PASS（新增 `test/perf-market-load.mjs` 77 条）、eslint 0 |
| 范围 | 仅 `dsh-armory`（宿主模块 + 客户端）；不改 dsh 启动主链、不加依赖、不动构建、不改 Remote 契约、不动安全闸门 |
| 依据 | 全文/关键段阅读 `lib/client.js`、`lib/index.js`、`lib/wb-market.js`、`lib/wb-awesome-market.js`、`lib/expert-market.js`、`lib/tool-ledger.js`；本机实测（Node v24.19，2026-10-30） |
| 目标 | ① 市场内容不拖慢 dsh 开屏；② 进市场后缩短选中页首屏可见与可交互时间；③ 不破坏既有功能 |

---

## 1. 结论摘要

1. **市场内容当前不参与开屏网络**：启动链上没有市场 RPC。开屏成本主要是宿主模块冷导入 **112ms**（其中市场/专家数据层约 35–42ms）与客户端 938KB 产物解析（vm 代理 5.6ms 编译 + 9.7ms 材料化）。
2. **真正的首屏浪费在"默认页不需要的东西"**：市场默认停在连接器页，却在挂载 400ms 后预取 **2.98MB** 插件目录与 **539KB** 专家目录，并在渲染期同步解析最多 4MB 的插件快照、每次加载再重写 ~3MB 快照。
3. **看板打开背了一块与本页无关的重活**：`toolTailor(30d)` 实测 **1,708ms**，且无缓存；`wbConnectorCachedCount` 每次读 **48.8MB** ZIP（≈27ms）。
4. 因此分三层治理：**P0 宿主懒加载**（保开屏）、**P1 首屏只服务当前页签**（预取门控 + 快照时机）、**P2 选中页缓存与预取**（裁缝报告缓存、分类复用、hover 预取）。
5. 客户端 bundle 拆分**明确不做**：收益仅 10–20ms，却要动构建与手工部署链，风险不成立（决策 #3）。

---

## 2. 现状诊断

### 2.1 加载链路（读码 + 实测）

```
【dsh 进程启动】
  bundle patch 加载 dsh-armory/lib/index.js（147,398 B）
    ├─ 顶层静态 import 17 个数据层模块        ← 实测冷导入 112.3 / 113.0 / 119.2 ms
    └─ 注册 McpManagerGateway ≈105 个 @Remote 描述符
【页面启动（渲染进程）】
  组合脚本下发 lib/client.js（938,544 B / gzip 280,795 B）→ ModuleLoader.load 注册工厂
    ├─ 插件 bootstrap → 模块顶层：i18n 表 82,250 B / 1,074 键、CSS 字符串 159,702 B
    └─ apply(ctx)：$mount(105 描述符)、注入 160KB CSS、注册 6 个 slot
  常驻件：SummonQuickMenu（仅展开时取数，0 启动 RPC）
          SessionExpertBadge（挂载即 expertActive + 5s 可见轮询）
          FAB / 侧栏图标 / 浮层（0 RPC）
【点击「军械库」→ 宿主 layout 只渲染当前 main 面板】
  McpBoardPage 挂载（默认分类 = mcp）
    ├─ 4 连本地 RPC：listSkills / list / wbExpertInstalled / wbConnectorCachedCount
    │                          └─ wbConnectorCachedCount 读 48.8MB ZIP + 解析（≈27ms）
    └─ toolTailor(30d) 账本扫描        ← 实测 1,708 ms，无缓存
【点击「市场」→ WorkBuddyMarket 挂载（默认子页签 = connector）】
  ├─ 渲染期同步 readAwesomeSnapshot()   ← 默认页也付 ≤4MB JSON.parse
  ├─ 4 连：loadConnectors / loadInstalled / loadInstallState / loadMcpServerRows
  ├─ loadSkills() 网络                  ← 实测 229 / 187 ms，27KB，无缓存
  ├─ 400ms 后预取插件目录（2.98MB）+ 专家目录（539KB） ← 默认页根本不看这两块
  └─ 每次目录加载 writeAwesomeSnapshot() ← ~3MB stringify + setItem（同步）
```

### 2.2 瓶颈清单

| # | 位置 | 现象 | 证据 | 影响 |
|---|---|---|---|---|
| B1 | `lib/index.js:27`、`:56` 及顶层 import | 进程启动即装载市场/专家数据层 | 冷导入 112–119ms；剔除两模块 77ms | 开屏（宿主主份额） |
| B2 | `client.js:11003-11008`、`:1296-1306` | 市场挂载渲染期同步读插件快照 | 目录 2.98MB / 7,962 条；Node parse 5.4ms | 市场首屏（连接器页白付） |
| B3 | `client.js:11039`、`:1307-1319` | 每次加载都重写 ~3MB 快照 | stringify 8.2ms + 同步 setItem | 主线程阻塞 |
| B4 | `client.js:11104-11113` | 挂载 400ms 后无条件预取 2.98MB 插件目录 | 实测 RPC 载荷 2.98MB；host 命中 21.7ms | 与连接器首屏争带宽/IPC |
| B5 | `client.js:11123-11131` | 预取 539KB 专家目录只为徽标条数 | 实测 235ms / 429 条 | 同上 |
| B6 | `client.js:10431-10439` | 挂载即并行 5 个请求（含技能网络） | 4 本地 + 1 网络 229ms | 首屏请求竞争 |
| B7 | `client.js:12827-12835` | 打开看板即扫 30 天账本 | 实测 1,708ms / 6,542 事件 | 看板挂载 CPU/IO；切回重扫 |
| B8 | `wb-market.js:349-410`、`:99-150` | 连接器目录每次挂载重走 RPC 769KB | 实测 353ms 暖盘、531 条、769.5KB | 市场首屏 |
| B9 | `wb-market.js:564-574` | 条数读 48.8MB ZIP | readFile 16.9–18.1ms + 索引解析 9.6ms | 看板挂载 |
| B10 | `wb-market.js:631-681` | 技能目录无缓存，翻页/搜索全走网络 | 229 / 187ms、27KB | 技能页 |
| B11 | `client.js:12908-12916` | 切分类卸载重建，切回重拉 | 渲染分支 + `OPT-07` 注释 | 回访体验 |
| B12 | 市场卡片 | 无 hover 预取，点详情才发请求 | `grep onMouseEnter` 无卡片预取 | 详情等待 |
| B13 | `client.js` 938KB 进 boot 组合 | 每次开页面都解析 | vm：编译 5.6ms / 材料化 9.7ms | 开屏（次要，不为此动构建） |

### 2.3 基线数据

| 指标 | 值 | 数据来源 |
|---|---|---|
| 宿主 armory 冷导入 | 112.3 / 113.0 / 119.2 ms | Node fresh process ×3 |
| 其中市场+专家数据层 | ≈35–42 ms | 剔除两模块对照 77.0ms |
| `wb-market` / `expert-market` 单模块冷导入 | 23.9ms / 43.8ms | 分模块实测 |
| client.js | 938,544 B / 280,795 B gz | `wc -c` / `gzip -c` |
| index.js | 147,398 B / 44,488 B gz | 同上 |
| client 编译 + 材料化 | 5.6ms + 9.7ms（暖 0.3ms） | node:vm 代理 |
| 插件目录 RPC | 2.98MB、7,962 条、host 命中 21.7ms | 真实缓存 |
| 插件目录 JSON.parse / stringify | 5.4ms / 8.2ms | Node 实测 |
| 连接器目录 RPC | 769.5KB、531 条、353ms | 真实 48.8MB ZIP |
| 连接器 ZIP 打开+索引 / 逐条投影 | 9.6ms / 7.1ms（localDeps 1.2ms） | 同上 |
| 专家目录 RPC | 539KB、429 条、235ms | 真实缓存 |
| SkillHub 列表 | 229 / 187ms、27KB | 真实网络 |
| `toolTailor(30d)` | 1,708ms、6,542 事件、8.6KB | 直接调用 `scanSessionLedger` |
| 48.8MB ZIP readFile | 16.9 / 17.7 / 18.1ms | 暖页缓存 |

### 2.4 测量方法与限制

- 宿主耗时用 **Node 24 代理**（仓库 node_modules 解析 peer 依赖）；profile 目录缺 peer 依赖无法直接 import。
- 浏览器侧为 **node:vm 代理**，不是 Chromium 实测。
- **端到端开屏时间尚未测**：尚未给 Electron 启动加打点，只能给出 armory 在启动链上的份额。
- 3MB 经 Typert 传输/反序列化耗时**未单独测**（推测 30–100ms）。
- Electron localStorage 实际占用未直读（leveldb），按目录体积与 4MB 上限推断。
- 160KB CSS 的样式解析成本未测。

### 2.5 已确认 / 推测

**已确认（读码 + 实测）**

- 启动链无市场 RPC；市场请求全部发生在看板/市场挂载之后。
- 宿主 module 冷导入 112ms，市场/专家数据层占 35–42ms。
- 插件目录 2.98MB、连接器 769.5KB、专家 539KB、技能 27KB；各目录的 host 侧耗时。
- 看板挂载必跑 `toolTailor(30d)`（1.7s）与 48.8MB ZIP 读取。
- 市场默认子页签是 connector；插件/专家预取与快照解析与该页签无关。
- 卡片无 hover 预取。

**推测（不作为执行依据，Stage 0 补测）**

- 3MB IPC + 反序列化 30–100ms；Chromium setItem 3MB 数十毫秒；CSS 注入 5–10ms。
- 真实 Electron 首屏数值与 Node 代理的比例关系。

---

## 3. 目标与验收口径

| 目标 | 口径 |
|---|---|
| G1 开屏不背市场 | 启动链上不发任何市场网络/RPC；宿主冷导入从 112ms 降到 ≤85ms |
| G2 市场首屏 | 连接器列表首行可见 ≤350ms（有快照）/ ≤600ms（无快照）；插件页有快照 ≤300ms |
| G3 选中页 | 看板二次打开不再重扫 1.7s；市场二次进入 ≤150ms |
| G4 不误伤 | 第 7 节清单逐项通过；错误态/空态/旧宿主/离线行为不变 |
| G5 可回退 | 每项有开关或常量回退；清 localStorage 键即恢复默认 |

---

## 4. 优化策略

```
启动层   只保留「注册」与「轻量常驻件」；市场数据层按需 import
         客户端不拆 bundle（构建链不动），但保证启动不触发任何市场请求
看板层   计数与账本解耦：角标用缓存值；账本 5 分钟缓存 + 手动重扫
市场首屏 首屏只服务「当前子页签」：连接器先落地，其余目录 idle 再预取
         快照：读只在真正需要的页签，写只在内容变化时（idle）
选中页  SWR 快照 + 模块级缓存 + hover 预取；详情/安装仍走实时
```

原则：**首屏只做当前页签必需的事；缓存只用于"看得见的内容"，状态与动作永远实时。**

### 4.1 关于 P0-2 的修正

初版设想的「160KB CSS 懒注入」**取消**：`MCP_CSS` 覆盖 `.dsh-mcp-fab`（`client.js:2169`）等启动即挂载的常驻件，懒注入会让 FAB/浮层/快捷菜单裸奔，属于功能误伤。改为用 P0-2 打点测量 CSS 注入成本，若 >10ms 再单独立项（需拆 shell/board 两份 CSS）。

---

## 5. 变更清单

### P0 · 保开屏

#### P0-1 宿主市场/专家数据层懒加载

- 位置：`lib/index.js:27`（wb-market）、`:56`（expert-market）导入；调用点 `:191`、`:1918-1968`、`:2143-2320`、`:2268-2340`、`:2361-2431`
- 改法：

```js
let marketMod, expertMod;
const market = () => (marketMod ??= import("./wb-market.js"));
const expert = () => (expertMod ??= import("./expert-market.js"));

// 调用点示例
async wbConnectorCatalog() {
	const { wbConnectorCatalog } = await market();
	return wbConnectorCatalog();
}
```

- 复用 **Promise**（而非模块对象）避免并发首调重复加载。
- 预期：冷启动 **-35–42ms**（实测 112→77）；首个市场请求 **+20–45ms**（藏在 loading 后）。
- 风险：漏改调用点导致运行期 `undefined`。缓解：对 11 个导出名全量 grep，逐个替换。
- 回退：恢复静态 import（单提交可回滚）。
- 验证：冷导入 ×3 ≤85ms；5 个分类冒烟。

#### P0-2 启动打点（可开关，默认关）

- 位置：`lib/client.js` `apply` 出口（`13576-13714`）
- 内容：`localStorage['dsh-armory.perf.instrument']==='1'` 时记录 `module.materialize`、`apply.start/end`、`firstRpc:<name>`，写入 `window.__ARMORY_PERF__`；开关关闭时零开销。
- 用途：为第 11 节提供真实数据（CSS 注入、材料化、首个 RPC）。
- 回退：删键即静默。

#### P0-3 会话专家徽标启动降噪（低优先）

- 位置：`client.js:9036` 起（Badge 挂载即 `expertActive` + 5s 轮询）
- 改法：首次取数延到 idle；轮询降为 15s 或由 `agent/created` 事件驱动。
- 预期：启动后 5s 内少 1 次本地 RPC；**不作为收益主项**。
- 回退：恢复 5s。

> 客户端 bundle 拆分**不做**：938KB 的启动解析约 10–20ms，拆分需动构建与发布链（决策 #3 已否）。

### P1 · 市场首屏

#### P1-1 插件目录预取门控（2.98MB）

- 位置：`client.js:11104-11113`（挂载 400ms 无条件预取）
- 改法：等连接器首屏落地（`connectors.length>0 || error`）后，`requestIdleCallback`（回退 `setTimeout`）延迟 1200ms 预取；用户切到插件页时走 `:11115-11119` 即时路径不变。
- 预期：首屏不再与 2.98MB 争带宽/IPC；插件页仍有快照 + idle 预取兜底。
- 风险：插件页首次切换若快照为空且 idle 未完成 → 走原 loading（不劣于改造前）。
- 回退：`marketPrefetch=legacy` 恢复 400ms。
- 验证：连接器首屏；插件页首次切换（有/无快照两态）。

#### P1-2 专家目录预取移出首屏

- 位置：`client.js:11123-11131`
- 改法：仅在 `tab==='expert'` 或连接器落地后 idle 2500ms 才取。
- 预期：首屏少 235ms 主机读 + 539KB。
- 回退：恢复 400ms。

#### P1-3 快照读写时机 + 签名比较

- 位置：`client.js:11003-11008`（渲染期读）、`11039`（每次写）、`1293-1319`（实现）
- 改法：

```js
// 读：只在用户切到插件页时 hydrate（点击处理器内，避免首帧闪空）
const switchTab = (next) => {
	if (next === 'plugin') hydrateAwesomeFromSnapshot();
	setTab(next);
};

// 写：签名相同就跳过；写入放 idle
const sig = `${catalog.length}|${res.fetchedAt}`;
if (sig !== lastSnapshotSig) {
	lastSnapshotSig = sig;
	idle(() => writeAwesomeSnapshot({ plugins: catalog, marketplace, fetchedAt: res.fetchedAt }));
}
```

- 预期：默认页省 ~3MB parse；每次目录加载省 ~3MB stringify + setItem。
- 风险：插件页首帧闪空 → 点击处理器内同步 hydrate 规避。
- 回退：恢复渲染期读 / 无条件写。

#### P1-4 连接器目录客户端快照

- 位置：`client.js:10431-10439` + `loadConnectors`（约 `10340-10400` 段）
- 改法：键 `dsh-armory.connectorCatalog.v1`，存 `{savedAt, total, connectors}`（≈770KB，上限 1.5MB，TTL 24h）；挂载先铺快照，RPC 到达后替换；写入 idle + 签名比较；与插件快照合计 >4.5MB 时放弃写入（防配额）。
- 预期：回访市场首屏 0 RPC；无快照保持现状。
- 风险：快照里的 `installable/auth` 可能过期 → 安装动作仍由宿主实时判定；界面不据此做不可逆操作。
- 回退：`connectorSnapshot=0` / 删键。

#### P1-5 技能列表 SWR

- 位置：`client.js:10437-10439`、`loadSkills`（约 `10396-10429`）
- 改法：模块级 `Map`，键 `page|sort|keyword`，TTL 60s；命中先渲染、后台刷新；失败保留旧列表并出错误条。
- 预期：翻页/回搜不再空屏；重复网络 -1 次。
- 回退：`skillSwr=0`。

#### P1-6 连接器条数缓存（宿主）

- 位置：`lib/wb-market.js:564-574`
- 改法：进程内缓存 `{at, total}`，TTL 10 分钟；`wbConnectorCatalog` 成功后顺手更新。
- 预期：每次看板打开省 ~27ms 与一次 48.8MB 读。
- 回退：常量设 0。

### P2 · 选中页 / 切页

#### P2-1 `toolTailor` 报告缓存（宿主，最大单项）

- 位置：`lib/index.js:986-1012`；`client.js:12827-12835`；重扫按钮 `5977`
- 改法：宿主按 `days` 缓存报告，TTL 300s；payload 增加可选 `refresh:true` 绕过（客户端"重扫"按钮传 true；切 7/90 天按 days 独立键）。
- 预期：看板二次打开 **-1.7s**；首次不变。
- 风险：5 分钟内数据不新；有手动重扫兜底。
- 回退：`TAILOR_CACHE_TTL=0`。
- 契约：payload 加字段，**不新增 Remote 方法**，向后兼容。

#### P2-2 分类切换数据复用

- 位置：`client.js:12908-12916`
- 改法：连接器/技能/插件数据落模块级缓存（P1-4/P1-5 已覆盖），切回直接命中。
- 预期：切分类回访 ≤150ms。
- 回退：清缓存模块。

#### P2-3 卡片 hover 预取详情

- 位置：连接器/技能/插件卡片行组件（Stage 3 定位具体行号后补）
- 改法：`onMouseEnter` 200ms 防抖，只预取最近 1 个（连接器 `wbConnectorPreview` / 技能 `wbSkillDetail` / 插件 `wbAwesomeReadme`）；离场取消；单条缓存。
- 预期：点开详情 -100–400ms。
- 风险：多余请求 → 防抖 + 单条覆盖 + 不预取已缓存项。
- 回退：删监听。

#### P2-4 明确不做

列表虚拟化（60 条/页已够）、连接器 ZIP 增量解析、详情接口合并。

---

## 6. 缓存规范

| 键 | 内容 | 上限/TTL | 失效 | 清理 |
|---|---|---|---|---|
| `dsh-armory.awesomeCatalog.v1`（已有） | 插件目录 | 4MB / 7d | 版本键 + 时间 | 删键 |
| `dsh-armory.connectorCatalog.v1`（新） | 连接器目录 | 1.5MB / 24h | 同上 | 删键 |
| `dsh-armory.perf.instrument`（新） | 打点开关 | 布尔 | 手动 | 删键 |
| `dsh-armory.perf.*`（新） | 功能开关 | 布尔/枚举 | 手动 | 删键 |
| 宿主内存：连接器条数 | count | 10min | 超时 | 重启 |
| 宿主内存：裁缝报告 | days → report | 5min | 超时 / refresh | 重启 |
| 客户端内存：技能列表 | page/sort/keyword | 60s | 超时 | 刷新 |

规则：

1. 写失败一律静默；
2. 超配额不写、保留旧值；
3. 快照只做"铺屏"，安装/授权/卸载等写操作**不信任快照**；
4. 所有键带版本后缀，升级可整代丢弃。

---

## 7. 开关矩阵

| 开关 | 默认 | 语义 | 回退 |
|---|---|---|---|
| `dsh-armory.perf.instrument` | `0` | 打点 | 删键 |
| `dsh-armory.perf.marketPrefetch` | `idle` | `legacy` 恢复 400ms 全预取 | 改值 |
| `dsh-armory.perf.connectorSnapshot` | `1` | 连接器快照 | `0` / 删键 |
| `dsh-armory.perf.awesomeSnapshotLazy` | `1` | 快照懒读/条件写 | `0` |
| `dsh-armory.perf.skillSwr` | `1` | 技能 SWR | `0` |
| 宿主常量 `TAILOR_CACHE_TTL` / `COUNT_CACHE_TTL` | 300s / 600s | 缓存时长 | 改 0 |
| 宿主懒加载 | 开 | 动态 import | 代码回滚 |

> 宿主侧不引入运行时配置面；回退 = 改常量或回滚版本。

---

## 8. 功能不误伤清单

| # | 功能 | 是否触及 | 保障 | 回归点 |
|---|---|---|---|---|
| 1 | 连接器目录/筛选/排序/分页 | 快照 + 条数缓存 | 快照仅铺屏，RPC 到达即替换；筛选逻辑不动 | 首屏、筛选、翻页、无缓存冷启动 |
| 2 | 连接器详情/图标 | hover 预取 | 预取失败静默，点击仍走原请求 | 点开详情、图标加载 |
| 3 | 连接器安装/OAuth | 否 | 全程实时，不进缓存 | 安装、授权、失败提示 |
| 4 | 社区 MCP（游标分页） | 否 | 不动 | 翻页/空态/错误 |
| 5 | 技能目录/搜索/排序 | SWR | 命中先旧后新；失败保留旧列表 | 搜索防抖、翻页、断网 |
| 6 | 技能详情/安装/卸载 | 否 | 实时 | 装/卸/已装态 |
| 7 | 插件目录/搜索/分页/只看已装 | 快照时机 | 点击处理器内 hydrate，无闪空 | 首次/二次进入、快照过期 |
| 8 | 插件 README/更新探测 | 预取门控 | 探测仍在插件页触发 | 更新提示、README 打开 |
| 9 | 专家目录/召唤/卸载 | 预取门控 | 目录请求不变，仅时机变 | 徽标延迟、召唤流程 |
| 10 | 市场脉冲"最近动静" | 否 | 写入节奏可能变化，签名逻辑不变 | 新增/移除提示 |
| 11 | 看板计数 chips | 条数缓存 | 缓存值兜底，失败保留旧值 | 首次/装后刷新 |
| 12 | 裁缝报告/角标/重扫 | 缓存 | 重扫按钮 `refresh:true` 绕过 | 首次 1.7s、二次秒开、重扫 |
| 13 | 分类切换/错误边界 | 缓存 | 边界 key 不变 | 切回、异常注入 |
| 14 | hash 记忆/返回 | 否 | 不动 | 刷新回原页 |
| 15 | 语言切换 | 否 | 全量 i18n 不动 | 中/英切换 |
| 16 | 旧宿主（缺 Remote） | 否 | 现有 404 文案不变 | 旧版宿主模拟 |
| 17 | 离线/超时 | 快照 | 有快照铺屏 + 错误条；无快照走原错误态 | 断网进市场 |
| 18 | 卸载技能安全闸门 | 否 | 不动 `skill-remove/skill-disable` | 卸载流程 |

---

## 9. 影响面

| 文件 | 改动 | 契约 |
|---|---|---|
| `lib/index.js` | 懒加载、裁缝缓存、条数缓存 | 无新 Remote；`toolTailor` payload 加可选 `refresh` |
| `lib/wb-market.js` | 条数缓存 | 返回值形状不变 |
| `lib/client.js` | 快照时机、预取门控、SWR、开关、打点、hover | 无 |
| `lib/typert.js` / `MCP_CONTRIBUTION` | **不动** | — |
| 部署 | 客户端热更新（Ctrl+R）；宿主需完全退出 DSH 重启 | 沿用 `.deploy-record.json` 流程 |

---

## 10. 回归测试计划

自动：

```bash
npm test                 # node ./test/run-all.mjs
npx eslint lib test
```

手工（每阶段必跑，真实入口驱动）：

1. 启动 dsh → 会话页正常、FAB/快捷菜单样式正常、专家徽标正常；
2. 打开军械库 → 5 个分类 chips 数字出现；裁缝首次加载后二次打开秒开；
3. 市场 → 连接器列表首屏 → 搜索/筛选/排序/翻页 → 点详情 → 安装（或到授权步）；
4. 切技能页 → 搜索/翻页 → 详情；
5. 切插件页 → 列表/搜索/分页 → README；
6. 切专家页 → 目录/召唤入口；
7. 断网进市场 → 有快照/无快照两态；
8. 切走再回看板/市场 → 回访耗时；
9. 中英切换后重复 2–6；
10. 清空 `dsh-armory.*` 快照键后重复 3–6（冷启动路径）。

---

## 11. 分阶段实施

| Stage | 内容 | 验收门禁 | 提交粒度 |
|---|---|---|---|
| 0 | 打点开关 + 基线复测（真实 Electron） | 采到 materialize/apply/首个 RPC/CSS 数据；无行为变化 | 1 commit |
| 1 | P0-1 懒加载 + P0-3 徽标降噪 | 冷导入 ≤85ms；全分类冒烟 | 1 commit |
| 2 | P1-1 ~ P1-6 | G2 达标；断网/冷启动两态通过 | 2 commits（预取门控 / 快照与 SWR） |
| 3 | P2-1 ~ P2-3 | 二次打开 -1.7s；hover 预取无多余重复请求 | 2 commits |
| 4 | 收尾：文档、部署记录、验收报告、记忆写入 | 全项复测 + 未验证项披露 | 1 commit |

每阶段：改 → lint/test → 部署 → 真实 UI 验证 → 汇报（变更/证据/风险），失败即回滚该阶段。

---

## 12. 验收指标

| 指标 | 现状 | 目标 | 测法 |
|---|---|---|---|
| 宿主冷导入 | 112ms | ≤85ms | fresh process ×3 中位数 |
| 启动市场请求数 | 0（已达标） | 恒为 0 | 打点 + 网络面板 |
| 连接器首屏（有快照） | 353ms+ | ≤350ms | `performance.mark` 到列表首行 |
| 连接器首屏（无快照） | 353ms+ | ≤600ms | 同上 |
| 插件页首屏（有快照） | ~100–300ms | ≤300ms | 同上 |
| 市场二次进入 | 353ms+ | ≤150ms | 切走 10s 再回 |
| 看板二次打开 | 1.7s 扫描 | 不重扫（≤50ms） | 打点 |
| 主线程同步大 JSON | 3MB parse+stringify | 无 >50ms 同步任务 | Performance 面板 |
| 误伤 | — | 第 8 节全过 | 手工清单 |

---

## 13. 风险登记

| 风险 | 概率/影响 | 缓解 | 触发回退 |
|---|---|---|---|
| 懒加载漏改调用点 | 中/高 | 11 个导出名全量 grep + 冒烟 | 运行期报错即回滚 |
| localStorage 配额（3MB + 0.77MB） | 中/中 | 合计上限守卫，失败静默 | 关快照开关 |
| 快照陈旧导致误点安装 | 低/中 | 安装实时判定 + 错误提示 | 降 TTL / 关开关 |
| 预取门控后插件页变慢 | 中/低 | 快照兜底 + idle 预取 | `marketPrefetch=legacy` |
| 裁缝缓存显示旧数据 | 中/低 | 5min TTL + 重扫按钮 | TTL=0 |
| 客户端 hydrate 造成闪空 | 低/低 | 点击处理器内同步 hydrate | 恢复渲染期读 |
| 部署漏文件 | 低/高 | 备份 + `.deploy-record.json` + 重启验证 | 还原 `.bak-deploy-*` |

---

## 14. 未验证项

1. 真实 Electron 进程内的启动/首屏耗时（当前为 Node 代理）——Stage 0 补测。
2. 3MB 经 Typert 传输 + 反序列化的实际耗时（推测 30–100ms）。
3. Chromium 下 3MB localStorage `setItem` 的实际阻塞时长。
4. 浏览器 localStorage 真实占用（Electron leveldb 未直读）。
5. 160KB CSS 的样式解析成本。
6. 不同网络/机器下的收益区间（本机暖缓存数据不能外推）。

---

## 15. 附录

### 15.1 代码位置索引

| 主题 | 位置 |
|---|---|
| 宿主导入 / 懒加载目标 | `lib/index.js:27`、`:56`、`:191`、`:1918-1968`、`:2143-2320`、`:2268-2340` |
| 裁缝报告 | `lib/index.js:986-1012`；`client.js:12827-12835`、`:5977` |
| 连接器条数 | `lib/wb-market.js:564-574` |
| 连接器目录 | `lib/wb-market.js:99-150`、`:349-410` |
| 技能目录 | `lib/wb-market.js:631-681` |
| 插件目录 SWR | `lib/wb-awesome-market.js:714-748` |
| 快照读写 | `client.js:1293-1319`、`:11003-11008`、`:11039` |
| 预取 | `client.js:11104-11113`、`:11115-11119`、`:11123-11131` |
| 市场挂载 | `client.js:10431-10439`、`:10235` |
| 看板计数 / 账本 | `client.js:12795-12812`、`:12827-12835` |
| 分类渲染 | `client.js:12908-12916` |
| 启动 / apply | `client.js:13576-13714` |

### 15.2 测量脚本

- `%TEMP%/measure-client.mjs`：client.js vm 编译/材料化耗时。
- `%TEMP%/measure-market-host2.mjs`：插件目录命中、连接器 ZIP 投影、专家目录读。
- 单命令：`node -e "..."` 见会话记录（冷导入、JSON parse/stringify、SkillHub 延迟）。

### 15.3 变更记录

| 版本 | 日期 | 内容 |
|---|---|---|
| v1.0 | 2026-10-30 | 初版：现状诊断 + P0/P1/P2 执行清单 + 不误伤清单 |
| v1.1 | 2026-10-30 | 取消 P0-2（CSS 懒注入会误伤 FAB/浮层），改为打点测量 |
