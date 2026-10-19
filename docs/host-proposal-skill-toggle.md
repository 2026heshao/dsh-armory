# 上游提案：Skill 的启用 / 禁用开关

这份文档回答一个问题：**为什么「Skill 看板加启停开关」这件事本插件做不到，该由谁做、做成什么样。**

它是给宿主（`@deepseek-ai/dsh-skill` 与面板侧 Remote 契约）的上游提案，不是本插件的使用说明。日常使用请看 [README](../README.md) 与 [设计与限制](design.md)。

- [需求来源](#需求来源)
- [本插件现状](#本插件现状纯只读投影)
- [为什么不能在本插件内做](#为什么不能在本插件内做)
- [建议的上游接口形态](#建议的上游接口形态)
- [插件侧可先做的](#插件侧可先做的待-ui-车道恢复后落地)
- [验收标准](#验收标准上游采纳方案-a-或-b-之后)

## 需求来源

用户在 Skill 看板里能看到本机全部 skill，但想**临时关掉某个用不上的 skill** 时无处下手：面板上没有任何开关，唯一的「操作」按钮是「打开目录」。用户只能去改配置文件、或者直接把 skill 目录删掉/改名，然后重启宿主。删目录是破坏性的（想再启用就得重新装），改配置文件则需要用户知道宿主把开关存在哪——而这件事连本插件也不知道（见下一节）。

期望的行为很朴素：**看板里每一行有个开关，关掉 = 这个 skill 不再进入模型/用户的可用清单，打开 = 恢复。** 不删文件、不改目录。

## 本插件现状：纯只读投影

结论先行：**本插件对 skill 的能力是纯只读的，「打开目录」不是启停。** 逐条给证据。

### 1. 宿主侧只有三个 skill 方法，全部只读

`lib/typert.js:78-80` 是本插件向宿主注册的**全部** skill 相关 Remote 方法：

```js
mv('listSkills', [payloadParam], 'SkillListResult'),
mv('skillDetail', [payloadParam], 'SkillDetailResult'),
mv('revealSkill', [payloadParam], 'NoteResult'),
```

没有第四个。仓库里对 `skillEnable` / `enableSkill` / `disableSkill` / `toggleSkill` / `skillDisable` 全部零命中。

> 容易看错的一处：`lib/typert.js:45-46` 确实有 `mv('enable', ...)` 与 `mv('disable', ...)`，但那两条属于 **MCP**，不是 skill——它们的宿主实现是 `lib/index.js:946-951` 的 `enable` / `disable`，落到 `setDisabled()` 去写 profile patch（`setManagedMcpDisabled` + `writePatch`）。skill 侧没有对应的写路径。

### 2. `revealSkill` 是「在文件夹中显示」，不是启停

`lib/index.js:1408` 的 `async revealSkill(payload)`，做的事按顺序是：

```js
if (shell && typeof shell.showItemInFolder === "function") { shell.showItemInFolder(path); return { note: "已在资源管理器中定位" }; }
if (shell && typeof shell.openExternal === "function") { shell.openExternal(path); return { note: "已交给宿主打开" }; }
const { spawn } = await import("node:child_process");
if (process.platform === "win32") spawn("explorer", ["/select,", path], { detached: true, stdio: "ignore" }).unref();
```

它需要的是一个**磁盘路径**（`payload.path`），路径为空就直接抛「该 skill 没有可打开的文件路径（运行时注册的 skill 不在磁盘上）」。这正是 reveal in folder 的语义——把用户带到文件所在位置，**不改任何状态**。面板上那个按钮的 title 也写着「把 skill 所在目录交给宿主在资源管理器中打开（**只读定位**）」（`lib/client.js:3307`）。

### 3. 列表投影里没有 `enabled` 字段

`lib/index.js:1368` 的 `listSkills` 把宿主行逐字段投影出来，只有这些：

```js
name, description, whenToUse?, path?, source, provider, modelInvocable, userInvocable
```

注意 `modelInvocable` / `userInvocable` 是**能力位**（这个 skill 能不能被模型主动调用、能不能被用户 `/名字` 触发），是 skill 自身声明的静态属性，与「用户此刻是否启用它」是两件事。宿主返回的行里没有 `enabled`，本插件也就投影不出来。

### 4. 本插件对 skill 注册表只用了两个读方法

作用域探针 `lib/index.js:376` 的 `withSkillScope(ctx, payload, run)` 拿的是 `ctx.get("skills")`，整个仓库对它的调用面只有两处：

- `lib/index.js:1370` `typeof registry.list !== "function"`
- `lib/index.js:1390` `typeof registry.get !== "function"`

即 `list()` 与 `get()`。注册表缺席时不报 500，而是返回 `{ available: false, skills: [] }`（`lib/index.js:1383`），看板如实说「不可用」。**这是刻意的设计**：`lib/index.js:1364` 的段注释写得很明白——「数据真源是 `@deepseek-ai/dsh-skill` 的 `ctx.skills` 注册表，本插件只做投影与只读定位，**不发现、不缓存、不写盘**」。

### 5. 面板侧同样是纯展示，而且刻意没有伪造开关

看板组件 `lib/client.js:3101` 的 `SkillBoard` 里，唯一会改变宿主状态的动作不存在；只有「打开目录」（`lib/client.js:3304-3309`）。过滤条那段注释（`lib/client.js:3152-3155`）已经把这件事钉死了：

> 宿主 skill 注册表**没有**启用/禁用开关（`listSkills` 只给 `modelInvocable` / `userInvocable` 这类能力位，没有 enable/disable 写入接口），所以这里**不伪造**一个「启用开关」——那会是个点了不生效的假控件。

也就是说：看板现在没有开关，不是漏做，是当时就知道做不了而选择不骗人。

## 为什么不能在本插件内做

分三层，每层是下一层的前提。

### 第一层：启停状态**归谁所有**，没有答案

一个 skill 的「关掉」是一种**持久状态**，它必须有唯一真源。当前有三种可能的归属，各自都有硬问题：

| 候选归属 | 问题 |
|---|---|
| 宿主 skill 注册表（推荐） | 注册表是进程内的投影结果，它的输入是磁盘扫描 + 预设作用域。持久状态得存在某份配置里，由注册表读入后过滤——这条链目前**没有公开写入接口**。 |
| 本插件自己存（如 `~/.dsh/skills.disabled.json`） | 插件是「投影者」，不是「所有者」。写一份宿主不读的文件等于自娱自乐；若宿主另有一套状态，两份必然打架。 |
| 用户手改 skill 目录（现状） | 破坏性，且不可撤销而不重装。 |

注意第一层还牵出一个**作用域**问题：`withSkillScope`（`lib/index.js:376`）读 skill 时是**带作用域**的——看板没有会话，就借默认预设的 `acquireScope` 拿一份租约，看完释放（`lib/index.js:386-396`）。所以「禁用」是**全局禁用**还是**仅该预设禁用**，是需要宿主回答的语义问题，插件单方面决定必然错一个。

### 第二层：就算归宿主，插件也必须调到一个**未经核实存在**的 API

本插件能拿到的 `ctx.get("skills")`，在实测环境里能确认存在的只有 `list()` 与 `get()`（见上）。

宿主内部的契约文档读不到：本机 `C:\Users\LENOVO\.dsh\profiles\desktop\node_modules\@deepseek-ai` 下只落盘了 `cosmokit` 与 `schemastery` 两个包，`dsh-agent`、`dsh-skill` 等宿主内部包不在这条路径上，无法读到注册表的方法签名。

所以「调 `registry.disable(name)`」这件事，**目前既没有文档依据，也没有运行时依据**。以本插件现有的失败哲学（注册表缺席就 `available:false`，绝不 500）来看，直接假设一个方法存在并调用，只会在用户点击时抛一个没人预料到的 TypeError。

### 第三层：即便 API 存在，暴露它要新增 RPC 契约，而这条契约**两侧必须同步**

这是最硬的一条，也是本次**不实现**的直接原因。

本插件的 Remote 契约由**三个必须同步的文件**共同定义：

1. `lib/typert.js` —— 宿主侧契约声明。文件头是 `/* Generated for dsh-armory — do not edit. */`，**它是生成物**，手改会在下次生成时被覆盖。
2. `lib/client.js:5468` 起的 `MCP_CONTRIBUTION` 描述符表 —— 浏览器半的 codec 与描述符（skill 的三条在 `lib/client.js:5524-5526`）。
3. `lib/index.js` 里带 `@Remote` 的方法 —— 宿主半的实现。

这三处维持一个不变式：**契约两侧的方法集合与顺序必须一致**。少一处，客户端调用就是稳定的 404（`lib/client.js:5527` 那段注释记的就是这个坑：工具裁缝「两端契约此前双双缺失，客户端永远 404」）。

新增一个 `setSkillEnabled` 意味着：改一个**生成物**、改一张**浏览器半描述符表**、再改宿主半实现——三处任意一处遗漏，面板上就会出现一个点了没反应的按钮。这不是「多加一行」的改动量，而是一次跨契约变更，**不适合被塞进一次以 UI 整理为目标的迭代里**（本次并行车道还在改 `lib/client.js`）。

## 建议的上游接口形态

三个候选，按推荐度排序。

### 方案 A（推荐）：宿主提供启停三件套，插件只做 UI

宿主侧在 skill 注册表上补齐写入面：

```ts
ctx.skills.list(options?)   // 每行新增 enabled: boolean
ctx.skills.enable(name, options?)
ctx.skills.disable(name, options?)
```

- **代价**：宿主改动（持久化位置、作用域语义都要宿主自己定）。
- **收益**：插件侧**零契约新增**——`enabled` 顺着现有 `listSkills` 投影直接带出来，开关按钮可以复用 MCP 侧已有的 `enable` / `disable` 交互范式（`lib/index.js:946-951` 已经有一套写完 patch 再 reconcile 的成熟写法可参照）。
- **附带好处**：`enabled` 一旦进了投影，「只显示已启用」这类过滤条也顺带可做。

### 方案 B（最小）：只在清单投影里加只读 `enabled` 字段

宿主 `list()` 的每行直接带 `enabled: boolean`，启停仍由用户在宿主的设置页操作。

- **代价**：宿主改动**极小**（一个只读字段）。
- **收益**：插件立刻能画出「已禁用」的灰显态与对应的指路文案，用户至少知道**为什么这个 skill 不响应**，不会再把它当 bug 报。
- **不足**：用户仍要跳转到设置页，不能在看板里就地操作。作为过渡形态是合适的。

### 方案 C（不推荐）：插件写一份宿主约定的忽略清单

插件写 `~/.dsh/skills.disabled.json`，宿主读 skill 时跳过清单里的名字。

- **代价**：表面最小——插件自己写文件，宿主加三行读取。
- **问题**：这是**跨进程的隐式约定**。两份独立演进的代码靠一个没人强制校验的文件格式对齐，任何一侧改字段名、改路径、改语义（全局 vs 作用域），另一侧都会**静默失效**——症状是「关了又开着」，用户无法自查。而且它天然与宿主自己将来实现的启停状态冲突。
- **结论：不推荐。** 状态必须由拥有 skill 的那一方持有。

## 插件侧可先做的（待 UI 车道恢复后落地）

以下是**本次没有做**的部分，记在这里以免变成口头承诺。写清楚原因：本次并行工作中 `lib/client.js` 由另一条车道整文件接管，本车道不碰它。

1. **把「只读」明确标出来**：Skill 看板的标题区或详情页顶部加一行说明，让用户第一眼就知道这个看板不管理启停，而不是点遍按钮才发现。
2. **给一条指路**：文案指向宿主的 skill 设置入口（具体入口待上游确认后写死，现在不确定就不要编一个假路径）。
3. **详情页「调用策略」区**补一句：`modelInvocable` / `userInvocable` 是 skill 声明的**能力**，不是用户的**开关**——这两个词在中文里太容易混。

这三条都是纯文案/展示改动，不碰契约，等 `lib/client.js` 车道释放后即可落地。

## 验收标准（上游采纳方案 A 或 B 之后）

1. **字段可达**：`listSkills` 返回的每一行都带布尔 `enabled`，且与宿主设置页显示的状态一致（同一 skill 在两边不得出现矛盾）。
2. **往返一致**：调用禁用后再 `listSkills`，该行 `enabled === false`；重新启用后回到 `true`。中间不要求重启宿主。
3. **作用域语义明确**：文档写明禁用是全局还是按预设。若按预设，`withSkillScope` 走的默认预设租约（`lib/index.js:386-396`）必须能读到正确的那一份。
4. **契约三处同步**：`lib/typert.js`、`lib/client.js` 的 `MCP_CONTRIBUTION`、`lib/index.js` 的 `@Remote` 三处方法集合一致——建议加一条测试断言两侧方法名集合相等，这类 404 才不会再次溜过去。
5. **降级不崩**：宿主未实现写入接口时，看板必须如实显示为只读（沿用现有的 `available:false` 形态），**不得**渲染出点击无效的开关。
