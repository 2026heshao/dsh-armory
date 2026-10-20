# PRD：dsh-armory 接入 awesome-dsh-plugins 插件市场（增量 PRD）

> 档位：简单 PRD ｜ 语言：中文 ｜ 版本：v1.1（2026-10-20，Alice；v1.1 并入用户三项拍板：unverified 不进缓存 / 默认序 stars 降序 / skill 类插件市场承接）
> 上游源：`dshworks/awesome-dsh-plugins` 仓库 `data/plugins.json`（13,400,935 字节）+ `data/schema.json`（6,370 字节），updated=2026-10-19。
> 本 PRD 只写需求与验收口径，不写实现方案（架构决策归架构师）。

---

## 1. 项目信息

- **Language**: 中文 ｜ **Programming Language**: 纯 JavaScript（Node ≥ 22.15，ESM，零新依赖）｜ **Project Name**: `dsh_armory_awesome_dsh_plugins`
- **原始需求复述**（用户原话 m03157）: 「你看能不能把这个插件市场链接到github上的awesome-dsh-plugins列表，让其全部变为dsh的插件」
- **合理解读**: awesome-dsh-plugins 是 DSH（DeepSeek Harness）宿主生态的插件目录（20,769 条），与现有 codebuddy 源（WorkBuddy/Cordis 生态，zip 包 206 条插件）**不是同一运行时**。「全部变为 dsh 的插件」= 在 dsh-armory 面板新增「DSH 社区插件」市场视图，让用户可浏览并一键安装这些条目到 DSH 宿主。
- **与 prd-workbuddy-parity.md 的关系**: 全新增量功能，不改动既有 P0 范围（R1–R3）与 Non-Goals（X1–X9 继续有效）；需求编号自 R11 续编，可复用该 PRD 已建立的机制（R10 排序范式、ETag 更新探测思路、restartNotice）。
- **网络实测基线**（本机 2026-10-20）: jsdelivr ✅ / fastly.jsdelivr ✅ / api.github.com ✅；raw.githubusercontent.com ❌、github.com 直连 ❌ 超时——**安装与拉取主路径必须避开 github.com 直连**。
- **并行事项**: 现有「目录投影漏 repository」「installPlugin 假成功」两处 bug 由其他工程师修复中，本 PRD 不以其为前置依赖，验收按修复后的正常行为口径。

---

## 2. 产品定义

### Product Goals（3 个正交目标）

1. **内容接入**: 将 awesome-dsh-plugins 作为第二个插件市场源接入 dsh-armory；P0 收录口径 = status=verified ∧ 带 npm 字段（两集合分别 20,264 / 6,404 条，交集落地时实测，量级 ≈ 6 千条），实现浏览/搜索/一键安装到 DSH 宿主。
2. **大数据可用性**: 13.4MB 全量目录经「一次全量拉取 → 运行时瘦身过滤 → 本地瘦身影射缓存」后压缩到 ≈ 1.5–2MB，面板分页/搜索/筛选全部本地即时响应，永不渲染全量。
3. **弱网可靠性**: CDN 多源容错（jsdelivr → fastly → api.github.com 兜底）+ 本地缓存降级；在 github.com 直连不可达的实测网络下，浏览与安装主路径（npm spec）不受阻。

### User Stories（5 个）

1. As a DSH 用户, I want 在 armory 插件面板里浏览并搜索 awesome-dsh-plugins 的 verified 插件, so that 不必自己去翻 13.4MB 的原始列表找插件。
2. As a DSH 用户, I want 一键安装 npm 可装的插件（`npm:<name>`）, so that 不用手敲命令行安装。
3. As a DSH 用户, I want 看到分类/标签/stars/官方标识/「验证于 dsh x.y.z」徽章, so that 快速判断插件质量与 DSH 版本适配。
4. As a DSH 用户, I want 断网或全源不可达时仍能浏览上次缓存的目录, so that 弱网只限制安装、不阻塞浏览。
5. As a DSH 用户, I want broken 条目不可见不可装、unverified 有明确标注, so that 不误装坏插件。

---

## 3. 技术规范

### 3.1 全局约束（继承 parity PRD）

- 零新依赖；新增 Host Remote 方法必须 `lib/index.js` / `lib/typert.js` / `lib/client.js` 三处同步；缓存与状态写 `~/.dsh`。
- X 约束继承：**无常驻定时器**（X4，联网仅懒触发一次性探测）；**不代填凭据**（X9 不涉，awesome 数据无凭据字段）；**安装成功必须出现「需重启 DSH 宿主」提示**（沿用现有 restartNotice）。
- 架构决策点（仅陈述需求）：awesome 源为**裸 JSON**（非 zip、无 `.codebuddy-plugin/marketplace.json` 结构），现有 `wb-plugin-market.js` zip 管线不适用，**需新增 JSON 读取器**；源注册（`~/.dsh/armory/marketplaces.json` + `wb-registry.js`）的 kind 语义如何扩展由架构师定。

### 3.2 Requirements Pool

> 优先级：P0 = 本迭代必做，P1 = Should，P2 = Could。编号 R11 起续编，与 parity PRD 的 R1–R10 不冲突。

#### P0

- **R11｜must：DSH 插件源接入 + 数据瘦身口径（数据规模策略，本 PRD 最重要决策）**
  - 口径：**一次全量拉取 `data/plugins.json`（13.4MB，CDN 单文件）→ 运行时过滤 status=verified ∧ npm 存在 → 瘦身影射落盘本地缓存**；瘦身影射字段 = name / repo / npm / description（截断）/ category / status / tags / stars / official / verifiedAgainst / lastVerified；预估 ≈ 6 千条 × ~200–300B ≈ **1.5–2MB**（验收上限 3MB）。面板只读瘦身缓存，本地分页（≤50 条/页）+ 搜索。不做 category 限制（category 仅作筛选维度；skill 类去向已拍板，见 R20）。
  - 落选备选及理由：分类聚合 + 懒加载（交互复杂、全局搜索体验差）；每次拉全量直渲染（13.4MB 内存与渲染不可接受）。
  - **源关系（与现有 codebuddy 源）**: **并列视图、不合并混排**——两者运行时（DSH 宿主 vs Cordis）、数据格式（裸 JSON vs zip+plugin.json）、安装链路均不同，合并列表加来源徽章会让用户无法判断装的是哪边的东西。
  - 验收：must——面板可浏览/搜索/分页该瘦身子集；断网重开后缓存仍可浏览；缓存文件 ≤ 3MB。
- **R12｜must：安装 spec 推导（npm 主路径）**
  - npm 字段存在 → `npm:<name>`（优先级最高，实测网络下唯一高成功率路径）；走现有宿主 `pluginManager.installBundle(spec, {})` 双参通道；安装成功后出现醒目持久的「需重启 DSH 宿主后生效」提示。
  - 验收：must——任选 1 条 npm 插件安装成功且出现重启提示，重启宿主后生效。
- **R13｜must：分类与筛选**
  - category 5 类（plugin 19,968 / skill 694 / bundle 102 / tool 3 / theme 2）chips 单选筛选；tags 17 枚举（ui/terminal/agents/memory/models/vision/capabilities/channels/notifications/usage/observability/marketplace/devtools/safety/knowledge/interop/fun）多选下拉；搜索框与「只看已安装」复用现有面板控件。
  - 验收：must——筛选与搜索结果正确、本地即时响应；skill/theme/tool 类条目正常展示。
- **R14｜must：CDN 多源容错与降级**
  - 拉取顺序：jsdelivr → fastly.jsdelivr → api.github.com（兜底；其能否承载 13.4MB 单文件由架构师验证，见 OQ2）。失败原因复用现有五枚举 reason 思路扩展（如 no-source / all-sources-failed / stale-cache）。
  - 降级表现：全源失败且无缓存 → 空态「源不可达，稍后重试」；全源失败但有缓存 → 正常列表 + 顶部「目录已过期（上次更新 YYYY-MM-DD）」提示。
  - 验收：must——屏蔽首源后自动切换次源成功；全源失败时两种降级表现均正确。
- **R15｜must：懒触发更新探测（X4 继承）**
  - 仅在打开 DSH 插件视图或手动刷新时执行一次性条件探测（复用 `wbPluginUpdateCheck` 的 ETag 五枚举思路）；上游更新 → 顶部更新提示，用户确认后拉取并重瘦身。无常驻定时器、不静默更新。
  - 验收：must——上游更新后再次打开面板出现更新提示，确认后目录刷新为最新。

#### P1

- **R16｜should：github 直装路径扩展（依赖 OQ1/OQ6）**
  - 无 npm 的 verified 条目 → `github:owner/repo#ref`；monorepo path 条目（`github:owner/repo#ref:path` 形态）在宿主支持度实测确认前**一律不可装**，卡片标注「暂不支持安装」。
  - 边界：实测网络 github.com 直连不可达，该路径安装可能失败，必须给出明确失败原因（不得复用假成功行为）。
  - 验收：should——网络允许时至少 1 条无 npm 插件安装成功；path 条目不可装但有标注；安装失败有明确错误。
- **R17｜should：质量信号透出与状态策略**
  - broken（102 条）**永不进瘦身缓存，任何视图不可见不可装**；unverified（403 条）**不进缓存**（✅ 用户已拍板 2026-10-20，安全优先，不再考虑展示标注方案）；official=true → 「官方」徽章、featured → 「精选」徽章；卡片显示 stars 与「✓ verified（dsh <verifiedAgainst>）」小徽章，详情页补 lastVerified。
  - 验收：should——徽章与验证信息正确展示；broken 在任何筛选/搜索组合下不出现。
- **R18｜should：排序（复用 parity R10 范式）**
  - 按 stars / added（最新收录）/ 名称本地排序；**默认序 = stars 降序**（✅ 用户已拍板 2026-10-20；featured/official 只做徽章展示，不参与默认序）。
  - 验收：should——排序切换后列表正确重排。

#### P2

- **R19｜could：详情增强** —— evidence 链接、pushedAt / added / starsUpdated / repo 链接全量展示。验收：could——详情字段完整、链接可一键复制。
- **R20｜已拍板（✅ 2026-10-20）：skill 类由插件市场承接** —— 694 条 skill 类条目保留在 DSH 社区插件视图，不引流技能市场；用 category=skill chips 筛选区分。验收：skill 条目在插件视图可浏览可筛选，技能市场不重复收录。

### 3.3 UI Design Draft（文字描述）

- **入口**: 市场「插件」子 tab 顶部新增来源切换——「CodeBuddy 官方（206）｜DSH 社区（awesome）」，并列视图、默认 CodeBuddy，用户选择本地记忆。
- **工具行**（DSH 视图）: 搜索框（复用）+ category chips（5 类）+ tags 多选下拉（17 枚举）+ 「只看已安装」开关（复用）+ 排序下拉（R18）。
- **卡片**: 名称 + description 一行截断 + category 徽章 + tags（≤2）+ stars + 「✓ verified (dsh 0.2.x)」徽章（示意）+ 官方/精选徽章 + 右下「安装」按钮；path 条目按钮替换为灰置「暂不支持安装」。
- **详情弹层**: 完整 description、repo、npm 包名、category/tags、stars、pushedAt/added/lastVerified/verifiedAgainst、「安装」按钮。
- **安装按钮状态机**: 未安装[安装] → 安装中[disabled+转圈] → 成功[已安装 ✓ + 顶部持久「需重启 DSH 宿主」提示条] / 失败[红色错误 + 可重试]。
- **容错表现**: 首载骨架屏；全源失败且有缓存 → 列表 + 「目录已过期（上次更新 YYYY-MM-DD）」提示条；无缓存 → 空态引导重试。

### 3.4 Open Questions（需架构师/用户拍板）

1. **monorepo path 条目**: `github:owner/repo#ref:path` 形态的宿主 installBundle 支持度未验证——需架构师选 1 个真实条目实测后解锁 R16。
2. **13MB 源缓存策略**: 复用 ETag 条件请求（推荐，避免每次重拉 13.4MB）vs 每次全量拉取后瘦身覆盖；上游 CDN 是否输出稳定 ETag 需实测。api.github.com 兜底对 13.4MB 单文件的可行性（Contents API 有体积上限）也需验证。
3. **unverified 403 条**: ✅ 已拍板（2026-10-20）——**不进缓存**（安全优先）；broken 102 条按「直接不进缓存」写入本 PRD。
4. **默认排序**: ✅ 已拍板（2026-10-20）——**stars 降序**为默认序；featured/official 仅作徽章展示，不参与默认序。
5. **skill 类 694 条去向**: ✅ 已拍板（2026-10-20）——**插件市场承接**，category=skill 筛选区分，不引流技能市场。
6. **无 npm 条目的 ref 取值**: 默认分支、固定 tag，还是与 verifiedAgainst 版本映射——影响 R16 spec 的正确性。
