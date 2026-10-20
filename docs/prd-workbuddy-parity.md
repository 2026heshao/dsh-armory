# PRD：dsh-armory WorkBuddy 市场对标（增量 PRD）

> 档位：简单 PRD ｜ 语言：中文 ｜ 版本：v1.0（2026-10-20，Alice）
> 唯一权威输入：`docs/workbuddy-market-gap-analysis.md`。本 PRD 只写「要在 dsh-armory 上新增/修改什么」，不重复报告论证过程。
> 范围 = 报告第三节差距清单（G1–G11）+ 第五节落地顺序（三批推进）；排除项 X1–X9 全部列为 Non-Goals，禁止进入需求池。

---

## 1. 项目信息

- **Language**: 中文（与用户语言一致）
- **Programming Language**: 纯 JavaScript（无构建步骤、无 TypeScript、无 UI 框架），Node ≥ 22.15，ESM。
  - UI：`lib/client.js` 内手写 Web 面板（注入 DSH Web GUI）
  - 市场数据层：`lib/wb-market.js`（WB 连接器/技能）、`lib/wb-zip.js`（zip 下载解压，零新依赖）、`lib/expert-market.js`（专家）
  - Host Remote 契约三件套：`lib/index.js` + `lib/typert.js` + `lib/client.js`（新增 Remote 方法必须三处同步，漏一处会静默 404）
- **Project Name**: `dsh_armory_workbuddy_parity`
- **原始需求复述**: 对标 WorkBuddy 市场体系（已卸载，数据目录 `C:\Users\LENOVO\.workbuddy`），在 dsh-armory 现有「市场」标签页（连接器/技能/内置 MCP 三类）之上，按差距报告结论补齐**当前技术条件下可实现**的差距：三批推进（正确性补丁 → 市场扩展 → 基础设施），并明确不做的边界（X1–X9）。

---

## 2. 产品定义

### Product Goals

1. **正确性优先**：修复连接器「残缺安装」——解析 `auth_injection_rules`，让 tencent-docs / ima-mcp 等连接器装完即真正可用（G2），同时把已有连接器数据（visible_in 标签、示例问法、版本）利用起来（G3/G5）。
2. **补齐最大内容品类与可用性**：新增「插件」市场子 tab（依托多市场注册表接入 codebuddy-plugins-official，150+ 插件，一次装齐技能+命令+钩子+MCP 组合包），并以「令牌引导安装」解锁 80+ 条需认证连接器（G7/G1/G10/G4）。
3. **建立可管理的基础设施**：本地安装状态与来源锁可查可筛、目录打开时自动保鲜提示、列表排序对齐技能侧体验（G6/G9/G8/G11）。

### User Stories

1. **As a** DSH 用户, **I want** 在 armory 里浏览并安装 codebuddy-plugins-official 的插件（如官方 docx/pptx 技能包、security-scan）, **so that** 一次装齐「技能+命令+钩子+MCP」组合包，而不必逐个装 MCP 或技能。
2. **As a** DSH 用户, **I want** 安装 tencent-docs / ima-mcp 等连接器时自动应用其 token 注入规则, **so that** 装完即可用，而不是残缺安装后手工补 token。
3. **As a** DSH 用户, **I want** 安装 auth_mode=token 的连接器前自行填入令牌, **so that** 80+ 条需认证连接器在 armory 里真正可用。
4. **As a** DSH 用户, **I want** 看到连接器的部署/档位标签、版本与示例问法, **so that** 快速判断哪些连接器适合我，并直接复制示例 prompt 试用。
5. **As a** DSH 用户, **I want** 在列表中看到哪些连接器/插件已安装并按状态全量筛选, **so that** 避免重复安装、便于管理已装内容。

---

## 3. 技术规范

### 3.1 全局技术约束

- **零新依赖**贯穿全程（zip 下载解压继续走 `lib/wb-zip.js`）。
- 新增 Host Remote 方法必须 `lib/index.js` / `lib/typert.js` / `lib/client.js` **三处同步**，漏一处静默 404。
- 注册表与本地状态文件均写入 `~/.dsh`（armory 已有该目录写入能力）。
- 批次顺序与依赖：批次一独立先行；批次二内 G1 依赖 G7（不为插件源硬编码 URL）、G10 内嵌于 G1；批次三内 G6 与 G9 共用同一份本地状态文件设计。

### 3.2 Requirements Pool

> 优先级：P0 = Must have（本迭代必做），P1 = Should have，P2 = Could have。每条映射差距编号与批次。

#### P0 —— 批次一：正确性补丁（1 次小迭代，零新依赖，风险最低）

- **R1｜G2｜批次一｜must：解析并应用 `auth_injection_rules`**
  - 解析 connectors.json 顶层 `auth_injection_rules`（已证实 2 条：tencent-docs、ima-mcp，均双 token）；安装/预览时应用到作用域合并逻辑，或在预览/安装界面明示「该连接器需要 N 个 token」。
  - **验收标准**：must——预览界面能显示注入规则条数与用途；安装 tencent-docs 后 profile 的 mcpServers 配置不再残缺（含 token 占位或注入说明），配合 R7 可完成完整认证配置。
- **R2｜G3｜批次一｜must：`visible_in` 标签展示 + 本地筛选**
  - 每条连接器解析 `visible_in` 数组（internal / iOA / plan:ultimate / plan:exclusive / selfhosted / cloudhosted），卡片与详情展示标签；筛选栏支持按标签本地过滤。
  - **边界**：只做数据标签展示 + 本地筛选，**不做**渠道/档位准入逻辑（X2）；无 `visible_in` 的条目正常默认展示。
  - **验收标准**：must——含 visible_in 的条目显示标签；按标签筛选结果正确；不含标签条目不受影响。
- **R3｜G5｜批次一｜must：连接器元数据增强（examples 优先）**
  - 解析并展示 `examples_zh` / `examples_en`（可一键复制的示例问法）、`version`、`minWorkbuddyVersion`（版本仅作元数据新鲜度提示）。
  - **验收标准**：must——连接器详情可见中英示例问法并可一键复制、可见 version；could——zip 内 `icons/` 图标利用为可选加分项，不阻塞验收。

#### P1 —— 批次二：市场扩展（核心增量）

- **R4｜G7｜批次二｜must：多市场注册表**
  - 借鉴 WB `known_marketplaces.json` schema（每项：manifestName / type（zip/directory）/ source / autoUpdate / isBuiltIn），把连接器源从硬编码单 URL 改为注册表配置（存 `~/.dsh`）；G1 插件源直接接入注册表，不再新增硬编码 URL。
  - **验收标准**：must——连接器源可在注册表中配置并生效；新增一个市场源无需改代码。
- **R5｜G1｜批次二｜must：插件市场子 tab**
  - 新增「插件」子 tab：经 R4 注册表下载 codebuddy-plugins-official zip → 解析 marketplace.json → 列表/详情展示组成（skills / commands / agents / hooks / mcpServers / lspServers 数量或清单）、category / keywords / author → 安装经既有宿主通道 `remote.pluginManager.installBundle(targetSpec, {})`（严格双参调用，注意 `lib/client.js:3577` 已记录的踩坑注释）。
  - **边界与必写提示**：① 安装成功后**必须明确提示「需重启 DSH 宿主才生效」**（宿主 installBundle 机制决定，是与 WB「装完即用」唯一无法抹平的差距，提示须醒目持久）；② `lspServers` 字段仅展示、不承诺安装后生效（X7）；③ oauth/oneid 相关连接器不代登录、仅标注（X3）。
  - **验收标准**：must——150+ 插件可浏览可搜索；至少 1 个插件（如官方 docx 包）安装成功且出现重启提示，重启宿主后生效。
- **R6｜G10｜批次二｜must（随 R5）：插件依赖提示**
  - 解析插件条目的依赖声明，安装前提示依赖清单，用户确认后一并安装（marketplace.json 中 dependencies 的具体表达形式在解析真实 zip 时确认，见 Open Questions）。
  - **验收标准**：must——安装含依赖的插件（如 security-scan 类）时先列出依赖并需确认；无依赖插件不弹确认。
- **R7｜G4｜批次二｜must：令牌引导安装**
  - 针对已证实存在的 73 条 auth_mode=token + 8 条 oauth 连接器（现仅拦截不引导：`lib/wb-market.js:128-129` 拒装、`:166` authMode 仅透传展示）：安装前弹出令牌输入 → 替换 mcpServers 的 env/header 占位符 → 写入 profile mcpServers；并按 auth_mode 区分「可自填 token」与「oauth/oneid 不支持代注入、需自备凭据」的标注。
  - **边界**：只做**用户自填简单 token**（env/header 占位符替换）；WB 的 mcp-oauth / oneid-token 双 token 代注入机制整条链路**不做**（X9）。
  - **验收标准**：must——任选 1 条 auth_mode=token 连接器，输入令牌安装后认证可用；oauth 连接器显示明确的「不支持代注入」标注而非静默拒装。

#### P2 —— 批次三：基础设施

- **R8｜G6+G9｜批次二→批次三｜must：连接器/插件已安装状态 + 来源锁（同一份本地状态文件）**
  - 安装连接器/插件时同步写一份本地状态文件（存 `~/.dsh`）：scope / installPath / version / dependencies / installedAt / lastUpdated + 上游来源锁（来源市场、版本，参考 WB `upstream-skills-lock.json` 机制，字段细节实现前补查）；列表支持「已安装」**全量**筛选（非当前页，对齐技能侧 `skillOnlyInstalled` 但做得更完整）。
  - **验收标准**：must——安装后状态文件可查（含来源版本）；「已安装」筛选在全量范围内正确；could——卸载/更新时同步维护该文件为加分项。
- **R9｜G8｜批次三｜should：懒触发 ETag 更新检查**
  - 打开市场页时后台比对上游 ETag（复用 `lib/wb-market.js:83` 既有 ETag 缓存），有更新则提示，由用户手动确认更新。
  - **边界**：不做静默 autoUpdate、不做常驻定时器（X4）。
  - **验收标准**：should——上游目录变更后再次打开市场页出现更新提示；确认后目录刷新为最新。
- **R10｜G11｜批次三｜could：连接器/内置目录排序**
  - 本地排序（如按名称 / auth_mode / type），对齐技能侧已有排序体验；因 WB 本体 UI 无排序证据，仅作体验补全、不作为对标宣传点。
  - **验收标准**：could——排序切换后列表正确重排。

### 3.3 UI Design Draft

- **市场 tab 顶部**：现有「连接器 / 技能 / 内置 MCP」子 tab 增加「**插件**」（第四个子 tab）。
- **连接器子 tab**：
  - 卡片：名称 + 现有信息之外，新增标签行（`visible_in` 标签以小徽章展示，如 `selfhosted`、`plan:ultimate`）、版本号（v1.0.1）与 auth_mode 标注（如 `token`）。
  - 筛选栏（现有搜索/分页旁）：新增「已安装」开关（全量筛选）+ `visible_in` 标签多选筛选 + 排序下拉（R10）。
  - 详情/预览面板：新增「示例问法」区块（中文/英文并列或切换，每条带一键复制按钮）；新增注入规则提示行（「该连接器需要 N 个 token」及用途说明）。
- **令牌输入弹窗**（R7）：模态弹窗，列出该连接器全部 env/header 占位符（键名 + 用途说明），每行一个输入框（内容遮罩显示）；底部「确认安装 / 取消」。oauth/oneid 条目的弹窗改为说明页：标注「需自备凭据，DSH 不支持代登录」。
- **插件子 tab**（R5/R6）：
  - 列表：插件名 + author + category/keywords 标签 + 组成 chips（如 `skills×3`、`commands×5`、`hooks×2`、`MCP×1`、`LSP（仅展示）`）；支持搜索。
  - 详情面板：完整组成清单、依赖清单、keywords/author；「安装」按钮。
  - **重启提示**：安装成功 toast 之外，页面顶部出现醒目持久提示条「已安装，需重启 DSH 宿主后生效」，直到用户重启前不消失；lspServers 条目旁固定标注「仅展示，DSH 暂不托管 LSP」。
- **更新提示**（R9）：检测到上游更新时，市场页顶部出现轻量提示条「目录有更新」，点击确认后刷新；无更新时无感知。

### 3.4 Open Questions

1. **插件市场源与注册表已实测确认**（2026-10-20 主理人核查）：注册表文件实为 `C:\Users\LENOVO\.workbuddy\plugins\known_marketplaces.json`（7 个市场，schema：manifestName / type(zip|directory) / source{path,url} / installLocation / description / lastUpdated / autoUpdate / isBuiltIn）。`codebuddy-plugins-official` 源 = `https://download.codebuddy.cn/plugin-marketplace/codebuddy-plugins-official-4b9366ac-f7e5-4cef-b60a-99a5229ce2b2.zip`；其 zip 内清单在 `.codebuddy-plugin\marketplace.json`（非根目录），插件条目在 `external_plugins\<plugin>\.codebuddy-plugin\plugin.json`（实测含 name/description/author/repository/homepage/license 字段，未见 dependencies 字段——条目级依赖表达形式以清单文件实测为准）。R4/R5 按此实现。
2. **auth_injection_rules 结构已实测**（同日核查）：connectors.json 顶层键 = ["name","description","owner","auth_injection_rules","connectors"]；规则条目 = {id, when:{active_in:[...]}, applies_to_connectors:[...], requires_connected_connectors:[...], timing:"request", inject:[{from_connector, token_type:"mcp-oauth"|"oneid-token", header, value_template:"Bearer ${access_token}"}]}，实测仅 2 条（tencent-docs-dual-token、ima-mcp-dual-token），均为代注入机制 → 归 X9 Non-Goals。R1 相应收窄为：**解析该数组并在预览/详情展示「存在 N 条 token 注入规则（依赖 WB 账号体系，DSH 不代注入）」提示**，不实现注入逻辑；connector 条目实测键 = id,name,name_en,description,description_zh,description_en,source,auth_mode,type,examples_zh,examples_en,visible_in，与 R2/R3 字段完全吻合。
3. **marketplace.json 条目级 dependencies 的具体表达形式待解析真实 zip 时确认**（插件间依赖已在 WB `installed_plugins.json` v2 中证实存在，影响 R6 的解析实现）。
4. **`upstream-skills-lock.json` 字段级结构未逐项验证**（文件存在于 WB 数据目录、28971 字节），R8 的来源锁字段可在实现前参照该文件对齐。

### 3.5 Non-Goals（排除项 X1–X9，禁止进入需求池）

| # | 排除项 | 一句话理由 |
|---|---|---|
| X1 | 多账号隔离（WB 的 5 个 user-uuid 目录） | DSH 宿主无多账号概念，armory 是单用户本地工具，`~/.dsh` 单命名空间与宿主会话模型冲突 |
| X2 | `visible_in` 的渠道/档位准入逻辑（iOA 渠道、付费档位控制） | armory 不是分发渠道方；G3 只做数据标签展示与本地筛选 |
| X3 | server-side / oauth / oneid-token 连接器的服务端代登录 | 依赖 WB 闭源客户端与账号服务，DSH 侧无对应服务端；极限是安装时按 auth_mode 标注 |
| X4 | WB 式静默自动更新（autoUpdate） | 静默改写用户环境风险高；G8 只做「检查 + 提示」 |
| X5 | WB 内置市场内容搬运 | 内容嵌在闭源本体运行时内；armory 专家市场已独立实现同类能力 |
| X6 | tabbit-browser 第三方浏览器技能市场 | 强绑定 tabbit 生态运行时，DSH 侧有独立浏览器技能体系 |
| X7 | `lspServers` 的 DSH 原生 LSP 托管 | DSH 宿主无 LSP 托管运行时；G1 中仅展示该字段、不承诺生效 |
| X8 | 企微技能包（wecom-unified）市场 | 强绑定企业微信场景；仅其「技能锁」工程机制纳入 G9 |
| X9 | WB 的 mcp-oauth / oneid-token 双 token 代注入机制 | 依赖 WB 账号体系与闭源服务端；G4 只做用户自填简单 token |
