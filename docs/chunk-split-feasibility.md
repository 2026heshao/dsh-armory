# 6.5 客户端拆包（chunk）可行性核实报告

> 结论先行：**技术上可行，已由上游源码验证；但按当前体积测算，收益应重新定义为"降低并行开发冲突面"，而不是"减小首屏体积"。**
> 核实人：主理人 Qi ｜ 时间：2026-10-19 ｜ 对应清单项：§6.5（OPT-23）

## 1. 上游协议核实（源码级，非推测）

核实对象：`@deepseek-ai/dsh-client-modules` 的浏览器半侧实现
路径：`D:\桌面\AI Port\DSH plugins\_research\asar-extract\out\dsh\node_modules\@deepseek-ai\dsh-client-modules\lib\client.js`（40247 B）

### 1.1 chunk 文件名的硬约束

```js
const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/;
```

注册时校验（源码原文）：

```js
if (registration.chunk !== void 0 && !CLIENT_CHUNK.test(registration.chunk))
  throw new Error(`client-modules: invalid package-local chunk ${JSON.stringify(registration.chunk)}`);
const id = registration.chunk === void 0 ? ownerId : chunkId(ownerId, registration.chunk);
```

**含义**：文件名必须形如 `client.<name>.js`，`<name>` 首字符须为字母或数字，其后可含 `[A-Za-z0-9._-]`。
→ 本插件可用：`client.tailor.js`、`client.expert.js`、`client.market.js`、`client.skill-board.js`、`client.mcp-manager.js`、`client.whats-new.js`、`client.i18n-en.js`、`client.styles.js`。

### 1.2 chunk URL 的派生规则

```js
function chunkUrl(row, fileName, rev) {
  const url = atRevision(row.url, rev);
  const resourceStart = url.indexOf("/??");
  const revisionStart = url.indexOf("&rev=", resourceStart + 3);
  if ((resourceStart < 0 || revisionStart < 0 ? void 0
       : url.slice(resourceStart + 3, revisionStart)) !== `${row.id}/client.js`)
    throw new Error(`client-modules: cannot resolve chunk ${JSON.stringify(fileName)} from bundle URL ${url}`);
  return `${url.slice(0, resourceStart)}/${row.id}/${fileName}?${url.slice(revisionStart + 1)}`;
}
```

**含义**：chunk 从 owner bundle 的 URL 派生，路径为 `<base>/<pluginId>/<chunkFile>?rev=<rev>`。
chunk 必须与 owner **同目录、同 revision**，没有独立的版本协商。这是"同一次发布"的硬约束。

### 1.3 加载与注册流程

```js
async importChunk(ownerId, fileName) {
  const id = chunkId(ownerId, fileName);
  const existing = this.loadCache.get(id);
  if (existing !== void 0) return existing.exports;
  if (!this.factories.has(id)) {
    const generation = this.generations.get(ownerId) ?? 0;
    const row = this.graphRows.get(ownerId);
    if (row === void 0) throw new Error(`client-modules: chunk owner "${ownerId}" is not a boot graph entry`);
    const url = chunkUrl(row, fileName, ...);
    let transport = this.pendingArrival.get(url);
    if (transport === void 0) {
      transport = this.loadBundle(url).finally(() => { this.pendingArrival.delete(url); });
      this.pendingArrival.set(url, transport);
    }
    await transport;
    // generation 变了 = 期间发生过 HMR，丢弃这次结果重来
    if ((this.generations.get(ownerId) ?? 0) !== generation) {
      this.factories.delete(id);
      this.loadCache.delete(id);
      return await this.importChunk(ownerId, fileName);
    }
    if (!this.factories.has(id))
      throw new Error(`client-modules: bundle ${url} loaded without registering "${id}" via __ModuleLoader__.load`);
  }
  return this.materialize(id, ownerId).exports;
}
```

**要点**：
- 同一个 chunk 的并发请求共享一次传输（`pendingArrival`）。
- HMR 期间（generation 变化）会丢弃结果并自动重试——**对开发友好**。
- chunk 必须自己调用 `window.__ModuleLoader__.load({ id: '<ownerId>', chunk: '<fileName>', factory })` 完成注册，否则抛错。

### 1.4 是否能在 chunk 里 require 别的相对文件

**不能。** 上游 README（中文版）原文：

> 经 tsdown 拆分的源码 `import()` 会编译为 `require.async("./client.<name>.js")`；只有执行该表达式时，对应的带版本同级脚本才会到达。

且 chunk 只能从 owner 派生 URL，`require.async` 的目标必须是**同级 chunk**，不能是任意相对路径的 ESM 模块。
→ 这印证了 `lib/client.js:43` 原注释的判断"不能相对 import"对 ES import 成立；但 chunk 通道本身是可行的。

### 1.5 同级 chunk 之间能否互相 require

从 `importChunk(ownerId, fileName)` 的实现看，`require.async` 由 owner 的 factory 闭包提供（ownerId 固定），因此 **chunk 之间可以互相 `require.async`**，只要都注册在同一 ownerId 下。
但为避免"chunk 依赖 chunk"的加载顺序地狱，建议仍遵循架构师的不变式：**共享代码只由基座注入**（通过 `mount(surface)` 的参数传递）。

## 2. 本插件当前体积实测

文件：`lib/client.js`，**506177 B / 7229 行**

| 分区 | 字节 | 占比 |
|---|---|---|
| `EN_US_MESSAGES` 字典（行 58 起） | 34901 | 6.9% |
| `MCP_CSS` 样式表 | 94956 | 18.8% |
| 服务器详情 | 12968 | 2.6% |
| 新增/编辑弹窗 | 14686 | 2.9% |
| JSON 导入弹窗 | 11465 | 2.3% |
| MCP 主面板（McpTab） | 27304 | 5.4% |
| 工具裁缝（Tool Tailor） | 18818 | 3.7% |
| Skill 看板 | 11510 | 2.3% |
| 专家 | 33316 | 6.6% |
| 输入框召唤菜单 | 22112 | 4.4% |
| 市场面板 | 32073 | 6.3% |
| 命令面板（Ctrl+K） | 18193 | 3.6% |
| RPC 契约表 | 14845 | 2.9% |

**七个面板合计约 163326 B（32.3%）**；CSS + 字典合计 129857 B（25.7%）。

### 2.1 「100KB 基座」目标的重算

若拆出七个面板 chunk（163326 B）+ CSS（94956 B）+ 字典（34901 B），基座剩余约 **213KB**（含契约表、i18n 骨架、共享原子件、入口装配）。距离「100KB」仍差一倍。

**这不是拆分方式的问题，而是本插件确实有这么多必要的装配与契约代码。** 强行压到 100KB 只能靠再拆契约表与共享原子件，收益递减且会破坏 chunk 的独立性。

### 2.2 拆分真正带来的收益

1. **首屏只加载基座**：面板 chunk 按需拉取。用户打开看板时通常只看一个 tab，其余六个面板的 163KB 不必传输与解析。
2. **CSS 随面板走**：面板私有样式跟着 chunk 加载，基座只留主题令牌与共用原子件。当前 94956 B 的 CSS 大部分是面板私有规则。
3. **并行开发冲突面**（这是本次实施的真正动机）：拆开后，不同面板的改动落在不同文件，不再排队等同一个 500KB 文件的写锁。

### 2.3 拆分的主要风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| chunk 顶层不能有副作用 | 上游明确"模块副作用在物化时运行"；CSS 注入若放 chunk 顶层，注册时不会执行 | 每个 chunk 导出 `{ mount, css }`，由基座统一注入 css |
| 基座必须提供全部共享符号 | chunk 无法 require 别处，只能从 `mount(surface)` 拿 | 在 `docs/chunks.md` 里钉死 surface 契约 |
| 无 git，回退成本高 | 一次拆错要手工还原 | 每个面板搬迁前建 `_archive` 快照 + 跑一次 run-all |
| 测试锚点会失效 | `client-i18n.mjs` 词法扫描假定单文件 | 先把扫描器改成多文件聚合，再动拆分 |
| HMR 期间反复加载 | generation 变化会重试 | 上游已处理，无需额外逻辑 |

## 3. 建议的实施顺序（若决定动手）

1. **先扩测试**：`test/client-i18n.mjs` 改成多文件扫描（glob `lib/client*.js`），`test/client-chunks.mjs` 新建用于校验 chunk 协议（文件名正则、注册形状、顶层无副作用）。
2. **提取基座 surface**：把 `React2`/`h`/`t`/`call`/`injectCss`/UI 原子件/常量/hooks 收进一个显式的 surface 对象，主 bundle 先按"自己用自己"跑通（不改任何面板，只改装配方式）。
3. **先搬一个低风险面板验证通道**：建议 `client.whats-new.js`（约 5KB，依赖最少）。跑通后 run-all 全绿，再继续。
4. **逐面板搬迁**，每搬一个建快照 + 跑测试。
5. **最后搬 CSS**：面板私有样式随各自 chunk 走，基座只留令牌与共用件。

## 4. 结论与建议

- **可行性**：确认可行，协议已由上游源码验证，无未知风险。
- **是否本次做**：这是一次**纯结构性重构**，不改任何用户可见行为。当前 18 项功能优化已全部落地且测试全绿，此时动拆包会把已验证的稳定状态重新置于风险中。
- **建议**：作为**独立的 v1.11.0 版本**推进，不与本次 v1.10.0 混在一起发。本次发版在清单里把 6.5 标注为「已核实可行，排入 v1.11.0」。

若决定本次就做，最小可行路径是第 3 节的第 1–3 步（测试改造 + surface 提取 + 搬一个面板），可在不动其余面板的前提下验证通道，风险可控。
