# WorkBuddy 市场体系 vs dsh-armory 市场标签页：功能差距分析报告

> 生成时间：2026-10-20 ｜ 分析人：Alice（PM）｜ 定位：对标分析，不含实现
>
> **对象**：WorkBuddy（腾讯 AI Agent 桌面产品，本体已卸载，数据目录 `C:\Users\LENOVO\.workbuddy` 完整保留）的市场体系 × dsh-armory（DSH 插件，`D:\桌面\AI Port\DSH plugins\dsh-armory`）的「市场」标签页。
> **问题**：WorkBuddy 已有的市场能力中，armory 还有哪些**在当前技术条件下可以实现**的差距。
> **事实来源**：主理人已核实的磁盘证据（第一手，直接采信）+ 本次对 `C:\Users\LENOVO\.workbuddy\connectors-marketplace\` 的补充只读侦察。凡未亲自读到的一律标注「未验证」。

---

## 一、执行摘要

1. **最大的可实现差距是「插件市场」本体（P0）**。WorkBuddy 有 7 个注册市场，其中 `codebuddy-plugins-official`（zip 形态、公开 URL）含 150+ 插件，条目可捆绑 skills/commands/agents/hooks/mcpServers/lspServers；armory 只有连接器/技能/专家三类，完全没有「插件」概念。关键前置条件**已验证打通**：armory 已在 `lib/client.js:7080-7081` 定义 `UPGRADE_NAMESPACE = 'pluginManager'`、`UPGRADE_METHOD = 'installBundle'`，并在 `lib/client.js:3577` 以双参调用 `pluginManager[UPGRADE_METHOD](targetSpec, {})` 完成自身升级——复用同一通道即可安装第三方插件包。数据源（公开 zip）+ 解析能力（`lib/wb-zip.js` 零新依赖）+ 安装通道（remote.pluginManager）三者齐备，属于**有条件可实现且条件已满足**。
2. **与 WorkBuddy 的核心体验差距是「装完即用 vs 装完需重启」**。WB 插件装入即生效；DSH 宿主侧 `pluginManager/installBundle` 装完后需重启宿主才生效。这是插件市场落地后必须如实告知用户的体验差异，也是与 WB 对标时唯一无法抹平的差距（宿主机制决定，非 armory 能解决）。
3. **认证链路已从「只拦截不引导」升级为「双通道引导」（P1，已实现）**：316 条连接器里 auth_mode=token 的 73 条 + oauth 8 条，旧版 armory 对这两类要么直接拒装、要么装上后无法认证。现在补上两条通道：**token 自填**（`wbConnectorPreview` 投影出 env/header 占位符 → 用户粘贴 → `applyTokens` 替换 → 写 profile mcpServers）与 **OAuth 浏览器授权**（`lib/mcp-oauth.js` 自实现 RFC 9728 资源元数据发现 → RFC 8414 AS 元数据 → RFC 7591 动态注册 → RFC 7636 PKCE S256 → loopback 收码换 token，token 落 `(DSH_HOME||~/.dsh)/armory-oauth/<sha256(url)[:32]>.json`，装前注入 `headers.authorization`）。后者不依赖 WorkBuddy 任何服务端，是本次实际落地的能力。
4. **连接器数据被 armory 浪费了约三成**：connectors.json（316 条）中 `visible_in`（部署/档位标签）、`auth_injection_rules`（顶层 2 条双 token 注入规则）、`version`、`minWorkbuddyVersion`、`examples_zh/examples_en`（示例问法）这些字段 armory 全部未解析。其中 `auth_injection_rules` 不只是展示问题——不解析则对应连接器（tencent-docs、ima-mcp）安装后 token 配置不完整，属于**功能正确性缺口**，应最先补（工作量小、无新依赖）。
5. **市场基础设施差距可实现但优先级中等**：多市场注册表（WB 用 `known_marketplaces.json` 注册 7 个市场，armory 连接器源硬编码单 URL）、周期更新检查（WB 有 `.periodic-marketplace-check` + `autoUpdate`，armory 只在手动刷新时走 ETag）、连接器已安装状态标识（WB 有 `installed_plugins.json` 全量状态，armory 仅技能有当前页筛选）。
6. **明确不该做的差距也很多**：多账号隔离（WB 5 个 user-uuid 目录）、server-side 连接器的服务端代登录（需闭源代理）、oneid-token 的 WB 账号体系绑定、WB 内置闭源市场、iOA 企业分发——详见第四节排除清单。**注意**：通用 OAuth（8 条 auth_mode=oauth）已由插件侧自主实现，不再属于排除项。

---

## 二、能力对标矩阵

| # | 能力 | WorkBuddy（证据） | armory 现状（证据） | 差距类型 | 可实现性 |
|---|---|---|---|---|---|
| 1 | 连接器目录分发 | connectors-config.zip（26MB/316 条，公开 URL） | ✅ 同一 zip + ETag 缓存（`lib/wb-market.js:66`） | 无 | — |
| 2 | 连接器安装（mcpServers 合并） | ✅ | ✅ `wbConnectorInstall` | 无 | — |
| 3 | 连接器可装性判定 | ✅（含 transport/token/本机依赖） | ✅ `lib/wb-market.js:118` | 无 | — |
| 4 | 安装前 JSON 预览 | ✅ | ✅ `wbConnectorPreview` | 无 | — |
| 5 | **令牌引导安装（auth_mode=token 连接器自填凭据）** | ✅ WB 内置 token 注入流程 | ❌ 只拦截不引导：`lib/wb-market.js:128-129` 拒装，`:166` authMode 仅展示 | **品类可用性** | **可实现** |
| 6 | **`visible_in` 部署/档位标签** | ✅ 每条连接器含 `visible_in`：internal/iOA/plan:ultimate/plan:exclusive/selfhosted/cloudhosted（本次实测 sesunfox-gateway 条目含 `visible_in`） | ❌ 完全不解析（主理人 grep lib\*.js 确认 NONE） | 数据利用不足 | **可实现**（纯解析+展示） |
| 7 | **`auth_injection_rules` token 注入规则** | ✅ connectors.json 顶层 2 条（tencent-docs、ima-mcp 双 token） | ❌ 完全不解析 | **功能正确性** | **可实现** |
| 8 | 连接器版本/兼容性字段（`version`、`minWorkbuddyVersion`） | ✅ 实测大量条目含（如 EZR CRM 1.0.1 / minWorkbuddyVersion 4.24.0） | ❌ 不解析不展示 | 数据利用不足 | **可实现** |
| 9 | 示例问法（`examples_zh/examples_en`） | ✅ 每条连接器多语言示例 prompt | ❌ 不展示 | 体验差距 | **可实现** |
| 10 | 连接器图标资源 | ✅ zip 内 `icons/` 目录（316 条配套） | ❌ 未利用（armory UI 是否用首字母头像：未验证） | 体验差距 | **可实现** |
| 11 | 技能市场（SkillHub API、分页、排序、安全报告） | ✅ | ✅ `wbSkillCatalog`/`WB_SKILLHUB_SORTS`/`lib/wb-market.js:271` | 无（排序仅技能有） | — |
| 12 | 技能安装校验 | ✅ | ✅ 逐文件 sha256 → `~/.agents/skills`（`wbSkillInstall`） | 无 | — |
| 13 | 专家市场 | ✅（独立分类） | ✅ `ExpertMarket`（不在市场 tab 内） | 布局差异 | — |
| 14 | 内置 MCP 目录 | ✅ | ✅ 独立子 tab（`wbConnectorCatalog` 分支） | 无 | — |
| 15 | 搜索 | ✅ | ✅ 本地过滤+服务端搜索（`WbSearchBox`） | 无 | — |
| 16 | 分页 | ✅ | ✅ 60/页、20/页（`WB_PAGE_SIZE`） | 无 | — |
| 17 | 连接器/内置目录排序 | （WB 本体 UI：未验证，本体已卸载） | ⚠️ 仅技能有 | 不确定 | 可实现（低成本跟随项） |
| 18 | 已安装状态/筛选（连接器侧） | ✅ `installed_plugins.json` v2：67 条，含 scope/installPath/version/dependencies/installedAt/lastUpdated | ⚠️ 仅技能有，且只能筛当前页（`skillOnlyInstalled`） | 状态管理差距 | **可实现** |
| 19 | **插件市场本体** | ✅ `codebuddy-plugins-official`：150+ 插件，条目含 skills/commands/agents/hooks/mcpServers/lspServers/keywords/category/author | ❌ 无「插件」概念（NONE） | **品类缺失** | **有条件可实现（条件已验证）** |
| 20 | 插件依赖管理 | ✅ 插件间 `dependencies[]` | ❌ 无 | 随 #19 | 有条件可实现（随 #19） |
| 21 | 多市场注册表 | ✅ `known_marketplaces.json`：7 市场，每项 manifestName/type/source/autoUpdate/isBuiltIn | ❌ 连接器源硬编码单 URL | 架构差距 | **可实现** |
| 22 | 周期更新检查 | ✅ `.periodic-marketplace-check` + `autoUpdate` + 每市场版本文件 | ❌ 仅手动刷新走 ETag | 基础设施差距 | **可实现** |
| 23 | 上游技能锁（可复现安装） | ✅ `wecom-unified` 内 `upstream-skills-lock.json`（28971 字节） | ❌ 无锁文件（有 sha256 校验但无来源版本记录） | 工程化差距 | **可实现** |
| 24 | 多账号隔离（user-uuid ×5、plugin-account-state） | ✅ | ❌ 单用户 | 定位差异 | **不建议做**（见第四节） |
| 25 | server-side/oauth/oneid-token 连接器的鉴权 | ✅ auth_mode 分布：server-side 12 / oauth 8 / oneid-token 1 | ✅ oauth 已自主实现（RFC 9728/8414/7591/7636 + PKCE S256，token 本地加密落盘） | — / 服务端代登录仍缺 | **oauth 可实现且已实现**；server-side 与 oneid 不可实现（见第四节 X3/X9） |
| 26 | WB 内置市场（app.asar.unpacked、experts 自动生成） | ✅ | ❌ | 依赖闭源运行时 | **不可实现** |
| 27 | 连接器本地详情目录（connectors-marketplace\connectors\<id>\） | ✅ 每连接器独立目录 | ⚠️ 未验证 armory 是否用 | 不确定 | 待查 |

---

## 三、差距清单（核心）

### G1. 插件市场本体（P0，有条件可实现——条件已验证）

- **差距**：WB 的 `codebuddy-plugins-official` 市场含 150+ 插件（docx/pptx/xlsx/pdf 官方技能包、security-scan、superpowers、*-lsp 系列、serena、context7、firebase、supabase、github/gitlab、commands-*/hooks-* 命令与钩子集）。插件条目 schema 支持 `skills[]`/`commands[]`/`agents[]`/`hooks[]`/`mcpServers`/`lspServers`（lspServers 含 command/args/extensionToLanguage）——即一个插件可以一次装进「技能+命令+钩子+MCP」的组合。armory 市场只有连接器/技能/专家三类，用户在 armory 里看不到、装不了这 150+ 插件。
- **用户价值**：这是 WB 市场体系里内容量最大的品类；armory 补上后，DSH 用户可直接获得官方 LSP、安全扫描、命令/钩子集等高价值组合包，而不是只能逐个装 MCP 或技能。
- **实现条件（全部已验证）**：
  1. 数据源：市场 zip 为公开分发物 `https://download.codebuddy.cn/plugin-marketplace/codebuddy-plugins-official-<uuid>.zip`（`.workbuddy\plugin-marketplace-state-new\` 有版本状态文件佐证此机制在用）；
  2. 解析：`lib/wb-zip.js` 已有 zip 下载/解压能力，marketplace.json 结构已知；
  3. 安装通道：**armory 已在用宿主 pluginManager 安装管线**——`lib/client.js:7080-7081`（`UPGRADE_NAMESPACE='pluginManager'`、`UPGRADE_METHOD='installBundle'`）、`lib/client.js:3577`（双参调用先例，注释记录了「expected 2 argument(s), got 1」的踩坑）、`lib/client.js:7526`（`ctx.get('remote.pluginManager')`，取不到则降级手动命令）。
- **工作量**：中-大（新子 tab + 目录解析 + 分类/keywords 展示 + 安装流 + 错误回滚提示）。
- **建议**：**实现**。这是对标 WB 市场的最大单项增益。
- **必须写明的体验差距**：WB 插件装完即用；DSH 侧 `installBundle` 装完需**重启宿主**才生效。UI 必须在安装成功后明确提示重启，这是与 WB 对标时无法抹平的差异。

### G2. `auth_injection_rules` 解析（P1，可实现，功能正确性）

- **差距**：connectors.json 顶层有 2 条 token 注入规则（tencent-docs 双 token、ima-mcp 双 token）。armory 安装连接器只合并 `mcpServers`，不解析注入规则——安装这两个连接器时 token 配置不完整，用户需手工补。
- **用户价值**：功能正确性。装了 tencent-docs/ima-mcp 的用户在 armory 里是残缺安装。
- **实现条件**：字段结构已知（主理人已核实存在）；安装时解析规则并应用到作用域合并逻辑，或在预览/安装界面明示「该连接器需要 N 个 token」。
- **工作量**：小。
- **建议**：**实现，优先级最高的小项**（正确性 > 新功能）。

### G3. `visible_in` 解析与标签筛选（P1，可实现）

- **差距**：每条连接器带 `visible_in` 数组（internal/iOA/plan:ultimate/plan:exclusive/selfhosted/cloudhosted）。armory 全部不解析。
- **用户价值**：armory 作为 DSH 本地工具，等价于 selfhosted 形态；解析后可 (a) 展示部署/档位标签，(b) 默认隐藏明显不适用条目（如强绑定 iOA 渠道的），(c) 提供筛选。
- **实现条件**：纯字段解析 + 前端标签/筛选，无新依赖。
- **工作量**：小。
- **建议**：**实现**。注意：只做数据展示与本地筛选，不模仿 WB 的渠道分发语义（见排除项 X2）。

### G4. 认证引导安装：token 自填 + OAuth 浏览器授权（P1，已实现）

- **差距（旧状态）**：316 条连接器中 auth_mode=token 的 73 条 + oauth 8 条，旧版 armory 对前者只做拒装拦截、对后者整类判不可装——**只拦截、不引导**，用户没有任何自填令牌或授权登录的入口。
- **现状（已实现）**：`serverInstallability` 不再对 `oauth`/`oneid-token` 无条件拒装，改为回传 `needsOAuth: true`；`probeServerAuthorization` 遇 401/403 不再 `throw`，改为结构化回传 `{ authorized:false, needsAuth:true, status, wwwAuthenticate, resourceMetadata }`，由 UI 决定引导路径。
- **两条通道**：
  1. **token 自填**（覆盖 auth_mode=token 的 73 条）：`wbConnectorPreview` 投影出 env/header 占位符槽位 → 用户在令牌弹窗粘贴 → `applyTokens` 替换 `${...}` → 写 profile mcpServers。
  2. **OAuth 浏览器授权**（覆盖 auth_mode=oauth 的 8 条）：`lib/mcp-oauth.js` 全链路自实现，不依赖 WB 任何服务端：
     - RFC 9728 资源元数据发现（解析 `WWW-Authenticate: Bearer resource_metadata="..."`，回落根路径 `/.well-known/oauth-protected-resource`）；
     - RFC 8414 AS 元数据（`/.well-known/oauth-authorization-server`，取 authorize/token/register 端点与 scopes）；
     - RFC 7591 动态客户端注册（公共客户端，`token_endpoint_auth_method=none`）；服务端若要求非 loopback 回调模板（如 `workbuddy://workbuddy/mcp/connector:<name>/oauth/callback`）则按其模板替换 `<name>` 降级为手动回传模式；
     - RFC 7636 PKCE（S256）；loopback 监听 127.0.0.1 随机端口收授权码；
     - token 落盘 `(DSH_HOME || ~/.dsh)/armory-oauth/<sha256(serverUrl)[:32]>.json`，装前由 `injectStoredOAuthTokens` 注入 `headers.authorization: Bearer <token>`，过期自动 refresh。
- **用户价值**：8 条 oauth 连接器从「完全装不上」变为「浏览器点一下即可安装」；73 条 token 连接器保留自填通道。整体解锁 80+ 条需认证连接器。
- **边界划分**（重要，已收窄）：
  - **通用 OAuth**：已实现（插件侧自主，见上）；
  - **simple token 自填**：已实现；
  - **WB 的 oneid-token 双 token 注入**：仍不可实现（依赖 WB 账号体系与闭源服务端）→ 保留在排除项 X9；
  - **server-side 代登录**：仍不可实现（无服务端代理）→ 保留在排除项 X3。
- **工作量**：中大（已完成）。
- **建议**：**已落地**。后续只需在新增连接器时验证其 AS 元数据是否标准。

### G5. 连接器元数据增强：version / minWorkbuddyVersion / examples / icons（P2，可实现）

- **差距**：实测 connectors.json 大量条目含 `version`、`minWorkbuddyVersion`（如 4.24.0）、中英双语 `examples_zh/examples_en`；zip 内有 `icons/` 目录。armory 均不展示。
- **用户价值**：示例问法是直接可复制的 prompt 素材，是连接器页面的实用内容；版本字段可作为「元数据新鲜度」提示；图标提升辨识度。
- **实现条件**：同一 zip 内字段/资源，纯展示改造。
- **工作量**：小。
- **建议**：**实现**（examples 优先，icons 可选）。

### G6. 连接器已安装状态与筛选（P1，可实现）

- **差距**：WB 用 `installed_plugins.json`（v2，67 条）维护全量安装状态（scope/installPath/version/dependencies/installedAt/lastUpdated）。armory 只有技能的「已安装」筛选且仅限当前页；连接器/内置目录无已安装标识。
- **用户价值**：316 条连接器里用户装过哪些、版本何时更新——避免重复安装、便于管理。
- **实现条件**：armory 安装时本来就要写当前作用域，只需同步记录本地清单文件（写 `~/.dsh` 已有能力）；对照逻辑与技能侧 `skillOnlyInstalled` 同构，但应做成**全量筛选**而非当前页。
- **工作量**：小-中。
- **建议**：**实现**。

### G7. 多市场注册表（P1，可实现）

- **差距**：WB 用 `known_marketplaces.json` 注册 7 个市场，每项含 manifestName/type（zip/directory）/source/autoUpdate/isBuiltIn——同一套注册表机制承载连接器、插件、企微技能包、内置目录、第三方浏览器技能。armory 的连接器源是硬编码单 URL，加一个新源要改代码。
- **用户价值**：可配置市场源（含未来自建源/第三方源），是 armory 从「搬运 WB 内容」演进为「通用市场宿主」的地基；也是 G1 插件市场能以多个源接入的前提。
- **实现条件**：注册表 schema 可直接借鉴 WB 已实测结构（7 项字段全部已知）；存储走 `~/.dsh`。
- **工作量**：中。
- **建议**：**实现**，且建议排在 G1 之前或与 G1 同批（G1 直接建在注册表上，避免再硬编码一个插件源 URL）。

### G8. 周期更新检查（P2，可实现）

- **差距**：WB 有 `.periodic-marketplace-check` 周期检查标记 + 每市场 `.marketplace-version-<name>` 版本文件 + `autoUpdate` 开关。armory 只在用户手动刷新时走 ETag（命中才更新）。
- **用户价值**：目录内容（尤其连接器 zip 会持续加新条目）自动保鲜，无需用户记得手动刷新。
- **实现条件**：armory 已有 ETag 缓存（`lib/wb-market.js:83`），只差「打开市场页时后台比对 ETag」的触发时机；不建议做 WB 式静默 autoUpdate（见 X4）。
- **工作量**：小。
- **建议**：**实现**（打开市场 tab 时懒触发即可，不必常驻定时器）。

### G9. 上游技能锁（P2，可实现）

- **差距**：WB 的 `workbuddy-wecom-unified` 包内含 `upstream-skills-lock.json`（28971 字节），记录上游技能来源与版本锁，保证安装可复现。armory 技能安装有逐文件 sha256 校验，但没有「这次装的是哪个上游哪个版本」的锁记录。
- **用户价值**：可复现、可审计：换机器重装、排查「技能为什么变了」时有据可查。
- **实现条件**：锁文件格式可参考该文件（结构已知存在，字段细节未逐项验证——如需精确对齐可读 `C:\Users\LENOVO\.workbuddy\` 下该文件）。
- **工作量**：小-中。
- **建议**：**实现**（可与 G6 的本地安装清单合并成一套 armory 自己的状态文件）。

### G10. 插件依赖管理（P1，随 G1）

- **差距**：WB `installed_plugins.json` 每条含 `dependencies[]`（插件间依赖）；marketplace.json 条目体系支持依赖声明。armory 无插件概念，自然无依赖处理。
- **用户价值**：装 security-scan 类插件若依赖基础包，无依赖提示会装出残缺环境。
- **实现条件**：依赖 G1 落地；marketplace.json 中依赖字段的具体表达形式需在解析真实 zip 时确认（条目级 dependencies 已在 installed 状态中证实存在）。
- **工作量**：中（随 G1 增量小）。
- **建议**：**随 G1 实现**，至少做到「提示依赖清单，让用户确认后一起装」。

### G11. 连接器/内置目录排序（P2，可实现，低成本跟随项）

- **差距**：技能侧已有排序（downloads/installs/stars/score）；连接器/内置目录无排序。WB 本体 UI 是否有连接器排序：**未验证**（本体已卸载，无 UI 证据）。
- **用户价值**：316 条连接器按 auth_mode/type/名称排序便于浏览。
- **工作量**：小。
- **建议**：**实现**（本地排序，成本极低）；因 WB 侧无证据，不作为「对标差距」宣传，仅作体验补全。

---

## 四、明确排除项（诱人但不该做）

| # | 排除项 | 理由 |
|---|---|---|
| X1 | **多账号隔离**（WB 的 5 个 `user-<uuid>-personal` 目录 + `plugin-account-state\<uuid>.json`） | DSH 宿主无多账号概念，armory 是单用户本地工具；做账号体系超出「军械库」定位，且 `~/.dsh` 单命名空间下强行分账号会与宿主会话模型冲突。**不做**。 |
| X2 | **模仿 `visible_in` 的渠道分发语义**（iOA 企业渠道、plan:ultimate/exclusive 付费档位控制） | armory 不是分发渠道方，无法也不应执行「该用户是否有 ultimate 权限」的判断；G3 只把 visible_in 当**数据标签**展示与本地筛选，不实现渠道/档位准入逻辑。**不做**（数据展示除外）。 |
| X3 | **server-side / oneid-token 连接器的服务端代登录**（12+1=13 条连接器依赖；oauth 8 条已排除在此项之外） | server-side 代理与 oneid 回调依赖 WB 闭源客户端与其账号服务，本体已卸载且不可调用；DSH 侧无对应服务端。**不可实现**（服务端部分），安装时按 `auth_mode` 标注「需自备凭据」即可。**注意**：`auth_mode=oauth` 的 8 条**不再属于本项**——其通用 OAuth 授权已由 `lib/mcp-oauth.js` 在插件侧自主实现（RFC 9728/8414/7591/7636），不依赖任何 WB 服务端，详见 G4。 |
| X4 | **WB 式静默自动更新（autoUpdate=true 的市场与插件）** | 静默改写用户环境（尤其第三方插件代码）风险高，与 DSH 的可控性原则相悖；G8 只做「检查+提示」，让用户手动确认更新。**不做**。 |
| X5 | **WB 内置市场内容搬运**（`workbuddy-builtin` 来自 app.asar.unpacked、`experts` 由本体自动生成） | 内容嵌在闭源本体运行时内，本体已卸载无源可取；且 armory 的专家市场已从 COS `expert_center.json` 独立实现了同类能力。**不可实现/已覆盖**。 |
| X6 | **`tabbit-browser` 第三方浏览器技能市场** | 依赖 WB 的浏览器集成运行时（tabbit 生态绑定），DSH 侧有独立的浏览器技能体系，搬运无意义。**不做**。 |
| X7 | **`lspServers` 的 DSH 原生 LSP 托管** | marketplace.json 条目支持 `lspServers`（command/args/extensionToLanguage），但 DSH 宿主没有 WB 那样的 LSP 托管运行时。G1 落地时 lspServers 字段只做**展示**，不承诺安装后生效。**不做**（展示除外）。 |
| X8 | **企微技能包（wecom-unified）市场** | 内容强绑定企业微信场景与腾讯企业服务，与 DSH/armory 的通用开发工具定位不符；其可复用的只有「技能锁」工程机制（已纳入 G9）。**不做**。 |
| X9 | **WorkBuddy 的 oneid-token 注入机制**（以及 WB 自有 mcp-oauth 服务端代注入流程） | 依赖 WB 账号体系（oneid 登录态）与闭源服务端的代注入流程，本体已卸载不可调用；armory 侧没有也不应有对应账号体系。与 G4 的边界：G4 的 **token 自填**（env/header 占位符替换）与 **通用 OAuth 授权**（插件侧自主实现的 RFC 9728/8414/7591/7636 链路，只用连接器自己声明的 AS）**都已实现**；本项只排除「借用 WB 账号登录态代注入」这一条，不排除标准 OAuth。 |

---

## 五、建议落地顺序

| 批次 | 内容 | 预期收益 |
|---|---|---|
| **第一批（正确性补丁，1 次小迭代）** | G2 auth_injection_rules 解析与应用/提示；G3 visible_in 解析+标签+本地筛选；G5 连接器元数据展示（examples 优先） | 修复 tencent-docs/ima-mcp 残缺安装；316 条连接器的数据利用率显著提升；零新依赖、风险最低 |
| **第二批（市场扩展，核心增量）** | G7 多市场注册表（先把连接器源配置化）→ G1 插件市场子 tab（下载 codebuddy-plugins-official zip → 解析 marketplace.json → 分类/keywords/author 展示 → 经 `remote.pluginManager.installBundle(targetSpec, {})` 安装 → 依赖提示（G10）→ **安装成功后明确提示需重启宿主**）；G4 认证引导安装（**✅ 已完成**：安装前令牌输入 → env/header 占位符替换 → 写 profile mcpServers；auth_mode=oauth 走浏览器授权：RFC 9728 资源元数据 → 8414 AS 元数据 → 7591 动态注册 → 7636 PKCE S256 → loopback 收码 → token 落盘 → 装前注入 `headers.authorization`；仅 oneid-token 标注「需自备凭据」） | 补齐 WB 市场体系最大的内容品类（150+ 插件）；解锁 80+ 条需认证连接器；armory 从「搬运三类内容」升级为「插件+连接器+技能+专家四类市场宿主」 |
| **第三批（基础设施）** | G6 连接器已安装状态与全量筛选（与 G9 锁文件合并为 armory 本地状态文件）；G8 打开市场页时懒触发的 ETag 检查+更新提示；G11 目录排序 | 安装状态可管理、目录自动保鲜、浏览体验对齐技能侧 |
| **不做** | X1–X9（见第四节） | 避免超定位与闭源依赖陷阱 |

**关键依赖关系**：G1 依赖 G7（不要为插件源再硬编码一个 URL）；G10 内嵌于 G1；G2 与 G4 同属认证链路补全建议同批；G6 与 G9 共享同一份本地状态文件设计。

---

## 附：事实核对说明

- 本文引用的 armory 侧行号（`lib/client.js:3577/7080-7081/7526/7578`、`lib/wb-market.js:66/83/118/128-129/166/271`、`lib/client.js:5831/5806`）均来自主理人已核实的源码结论，直接采信。
- connectors.json 字段（visible_in、auth_mode、version、minWorkbuddyVersion、examples_*）与 zip 目录结构（connectors/、icons/）经本次对 `C:\Users\LENOVO\.workbuddy\connectors-marketplace\.codebuddy-connector\connectors.json` 的实测确认。
- **未验证项**（如需精确实现可补查）：① connectors.json 顶层 `auth_injection_rules` 的字段级结构（已证实存在 2 条，字段细节未展开）；② `upstream-skills-lock.json` 的字段级结构；③ WB 本体 UI 的连接器排序与图标用法（本体已卸载，无 UI 证据）；④ codebuddy-plugins-official zip 内 marketplace.json 条目中 dependencies 的具体表达形式（插件间依赖已在 installed_plugins.json 中证实存在）。
