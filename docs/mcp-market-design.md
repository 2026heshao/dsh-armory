# MCP 市场：机制拆解与设计

这份文档回答三件事：`awesome-dsh-plugin` 到底怎么上架和更新的、MCP 为什么不能用同一套照搬、以及我们要做成什么样。

## 一、先拆 `awesome-dsh-plugin`：它不是网站，是一个数据管线

你「没看明白怎么上架」是正常的——因为**上架和更新是两条完全分开的路径**，而页面上只讲了前一条。

### 上架 = 一个文件，就一个

PR 只新增 `data/plugins/<owner>__<repo>.yml`，内容是全部：

```yaml
url: https://github.com/owner/repo        # 必须与仓库完全一致
name: owner/repo                          # 列表里显示的链接文字
category: ui                              # 22 个固定取值之一
description:
  en: One-line description ending with a period.   # 唯一必填
  zh: 一句话描述。                                   # 可选，维护者会补
```

`README.md` / `README.zh.md` 是**生成物**，贡献指南明写「不要手工编辑」。它给出的理由是核心设计动机：

> 以前所有人都往同一分类的同一位置追加，合并一个 PR 就会撞掉下一个。独立文件永不冲突。

这一条解决了 awesome-list 类项目最大的运维痛点——**README 作为数据库时的合并冲突级联**。4414 条条目的规模下，这个选择是它能活下去的原因。

### 更新 = 不需要 PR，机器全包

这是你没看明白的另一半。作者永远不用管这些字段，它们全是 nightly CI 探测出来的：

| 数据 | 来源 | 产出 |
|---|---|---|
| star 数 | GitHub API | `data/stars.json` |
| npm 下载量 | npm downloads API | `data/downloads.json` |
| 当前版本 / npm 包映射 | npm registry | `data/npm-map.json` |
| 能力披露（shell/network/fs…） | `dsh-trust-check` 静态扫描 | `data/capabilities.json` |
| 截图 | 作者自己仓库的 `screenshots.json` | `data/screenshots.json` |
| 更新说明 | GitHub GraphQL 批量查 release + commit tail | `data/updates.json` |

所以「更新咋搞」的答案是：**作者的 PR 只在描述变了或换了 npm 包时才需要；版本、star、下载量、能力、截图全是自动的。** 引用它的 `probe-updates.mjs` 注释——设计意图说得非常清楚：

> 消费者是终端用户的 market，成千上万个，每个都持有一个只存在于那台机器上的 installed commit sha。目录不可能知道任何用户的已安装版本在哪，所以它一天一次为所有人发布**原材料**，而不是让每个消费者自己去问 GitHub、烧掉匿名 60 次/小时的配额。

### 数据流

```
data/plugins/*.yml          ← 人写（唯一真相源）
        │
        ├─ nightly probe ──→ data/{stars,downloads,npm-map,capabilities,updates}.json
        │                    （机器补全，永不入 PR）
        │
        └─ build-site.mjs ─→ README.md / README.zh.md     （给人看）
                          → docs/plugins.json              ← 唯一公共契约
                          → docs/readmes.json
                          → 静态站 + 详情页
```

**真正的资产是 `plugins.json`，不是网站。** 下游的 `dsh-market`、`dsh-find-plugin`、以及几十个第三方市场全都消费这个 JSON。网站只是它的一个渲染。

### 两个值得直接抄的工程决策

1. **catalog 发布成 npm 包**（`dsh-plugin-catalog`）。理由写在 `publish-catalog.mjs` 里：Pages 就是 GitHub，从中国大陆访问慢，而公共 GitHub 代理拒绝非 github.com 的域名；发到 npm 就搭上了所有插件本来就在走的镜像。同时**它有了版本号，坏数据可以回滚而不是只能向前修**。
2. **CI 闸门分层**：`pr-check`（形式校验：YAML 合法、README 能重新生成）、`pr-gate`（真读仓库：`dsh.bundle` 是否存在、仓库满 1 天、非归档、非 DSH 本身）、`pr-guard`（列出 PR 动了哪些无关条目）。一个 PR 最多 3 条，理由是实测数据：最近 100 个已合并 PR 里 88 个只加 1 条。

## 二、MCP 不能用同一套：差异在哪

这是整个设计里最关键的一段。插件是**代码**，MCP 是**配置**。

| | DSH 插件 | MCP Server |
|---|---|---|
| 条目本质 | 一个可安装的包 | 一段连接配置 |
| 唯一键 | `owner/repo` | `serverName`（**本机范围内唯一**） |
| 安装动作 | `dsh plugin --profile web add X` | 写 `cordis.patch.yml` 或 `.dsh/mcp.json` |
| 版本归属 | npm version，与 DSH 有兼容性约束 | 服务器自己的版本，与 DSH 无关 |
| 冲突面 | 几乎只有依赖冲突 | **serverName 撞名、环境变量撞名、端口撞名** |
| 风险 | 安装期跑构建脚本 | **远程连接 + 工具描述会注入模型上下文** |

三条直接推论：

**推论 1：条目不是链接，是可执行的配置模板。**
用户点「安装」要的不是跳 GitHub，是**拿到那段 YAML**。所以卡片上的主操作应该是「复制配置」，不是「查看仓库」。

**推论 2：`serverName` 必须由目录固定，不能开放给用户改。**
DSH 里 `serverName` 同时决定工具名 `mcp__<serverName>__<tool>`。如果同一条目在不同机器上叫不同名字，社区教程、截图、issue 复现全部对不上。目录必须钦定 `serverName`，并且 CI 要校验**全局唯一**。

**推论 3：密钥永远不进目录，只进变量名。**
目录里存 `${EXA_API_KEY}`，写进用户配置时转成 DSH 的**总值**表达式 `!!js (process.env.EXA_API_KEY ?? "")`。你项目的 `lib/env-expression.js` 已经在做这件事了（`makeEnvExpression` 是唯一产出形）。

注意必须是总值形态：裸引用 `!!js process.env.EXA_API_KEY` 的 `isTotalExpression()` 为 `false`，变量缺失时求值是 `undefined`，而 mcp-client 的 Config 只接受字符串，会让宿主在启动时整棵树加载失败（`docs/design.md` 把这条记为"本地实测过"，且明写适用于任何新增导入路径）。

**推论 4（最重要）：CI 能查的东西反而更硬核。**
插件市场查的是「`dsh.bundle` 声明了吗」这种形式事实。MCP 没有 manifest 可查，但它有一样插件没有的东西——**你真的能连上去试试**。这是 MCP 市场唯一无法伪造的质量信号，也是我们相对所有现有竞品的差异化。

## 三、竞品现状：生态位没被占住

`awesome-dsh-plugin` 站点的「Plugin Markets & Managers」分类有 **80 个**条目，其中两个直接叫 `dsh-mcp-market`：

| 项目 | stars | 状态 | 做法 |
|---|---|---|---|
| `LKMeng2001/dsh-mcp-market` | 1 | 8/16 后停更 | `data/registry-snapshot.json` → `docs/servers.json`，有 `mcp-probe.mjs` 做 initialize + tools/list |
| `Mrxieyong/dsh-mcp-market` | 1 | 8/26 后停更 | 纯手工模板，5 个厂商预设 |

`LKMeng2001` 那个的 schema 方向是对的：

```json
{
  "name": "everything", "category": "dev",
  "description": { "en": "...", "zh": "..." },
  "transport": "stdio", "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-everything"],
  "npmPackage": "@modelcontextprotocol/server-everything",
  "env": {}, "envHint": [], "tags": ["test","reference"],
  "added": "2026-08-14"
}
```

它的缺口正是机会所在：**没有 npm 校验、没有能力/安全扫描、没有依赖声明、没有健康巡检、没有工具哈希**。而且它已经停更了。

同时，上游事实是：npm 上 `keywords:mcp` 有 **78,020** 个包（实测）。这个数字既是市场的存在理由，也说明**「主流的那些」是有限且稳定的**——filesystem、memory、github、playwright、chrome-devtools、exa、tavily、firecrawl、serena、deepwiki……数得出来。人工精选 + 机器验证，在这个规模下完全够用，不需要自动爬全量。

## 四、架构：把它做成"数据源"，不是"又一个市场"

核心判断：**不要做第三个 `dsh-mcp-market` 插件，要做 MCP 服务目录的权威数据源。** 面板和站点都只是它的消费方。理由和 `awesome-dsh-plugin` 一样——它的护城河是 `plugins.json`，不是那个页面。

### 你已经有最强的落地载体

`dsh-mcp-manager-ui` 里 `lib/mcp-config.js` 的 `BUILTIN_MCP_SERVERS` 是**硬编码的 5 条**（Exa / Tavily / Firecrawl / Chrome DevTools / Playwright）。这个市场的本质就是：

> 把那 5 条硬编码，换成一个可远程更新、可社区提交的数据源。

而面板侧需要的东西**已经全都有了**：

- `BuiltinInstallModal` —— 现成的目录浏览 + 多选安装 UI
- `serverName` 校验（`SERVER_NAME_PATTERN`）与作用域判重
- `${VAR}` → `!!js process.env.X` 表达式生成（`env-expression.js`）
- 全局 profile patch / 项目 `.dsh/mcp.json` 双作用域写入
- 工具清单展示（详情页已经在渲染真实 `tools/list` 的输入 Schema）

**这是你相对任何从零开始的竞品最大的杠杆。**

### 数据流

```
data/servers/<slug>.yml        ← 人写：投稿 / 维护者精选
        │
        ├─ nightly probe ────→ data/probe.json    （连得上吗 / 多少工具 / 工具哈希 / 延迟）
        │                      data/npm.json      （版本 / 下载量 / 最后发布）
        │                      data/reach.json    （健康巡检：连续失败 N 次 → 标记）
        │
        └─ build-catalog ────→ dist/servers.json  ← 唯一公共契约
                               dist/index.html    （静态站）
                               dist/<slug>/       （详情页）
```

### `servers.json`：直接对齐官方 schema

建议条目结构**以官方 MCP registry 的 `ServerDetail` 为内核**（schema：`https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json`，已实测可匿名读），自有增强字段塞进反向 DNS 命名空间的 `_meta`——这是 PulseMCP 验证过的做法。

好处很实在：

1. 剥掉 `_meta` 后仍是**合法 registry 文档**，随时可与官方/第三方互转
2. 将来可以一键 `mcp-publisher publish` 推到官方 registry
3. Docker MCP Gateway 能直接消费（`--from-community-registry`）

```jsonc
{
  "name": "io.github.dsh-mcp/firecrawl",   // 官方命名空间规则
  "title": "Firecrawl",
  "description": "网页搜索、抓取与文档解析",  // 官方限 100 字符
  "version": "2.0.0",
  "websiteUrl": "https://firecrawl.dev",
  "remotes": [{ "type": "streamable-http", "url": "https://mcp.firecrawl.dev/v2/mcp" }],

  "_meta": {
    "com.dsh-mcp/server": {                // ← 我们的全部增强
      "slug": "firecrawl",
      "serverName": "firecrawl",           // 钦定，工具名前缀
      "category": "browser",
      "description": { "zh": "…" },        // 官方字段只有单语
      "secrets": [{ "name": "FIRECRAWL_API_KEY", "required": false,
                    "hint": "免密有限额", "url": "https://firecrawl.dev/app" }],
      "requires": { "node": ">=20" },
      "install": { "global": "…yaml…", "project": "…json…" },
      "probe": {
        "ok": true, "toolCount": 26,
        "protocolVersion": "2025-11-25", "latencyMs": 312,
        "toolHash": "a3f9…", "toolHashChangedAt": "2026-09-27T…",
        "checkedAt": "2026-09-29T…"
      },
      "trust": { "localCode": false, "egress": ["api.firecrawl.dev"], "credentialCount": 1 }
    }
  }
}
```

### 条目 YAML：作者只写这些

```yaml
slug: firecrawl                    # 文件名即 slug，CI 校验一致
serverName: firecrawl              # 钦定；CI 校验全局唯一、符合 ^[A-Za-z0-9_-]{1,32}$
category: browser
homepage: https://firecrawl.dev
description:
  en: Web search, scraping and document parsing.
  zh: 网页搜索、抓取与文档解析。

transport: streamable-http
url: https://mcp.firecrawl.dev/v2/mcp
headers:
  Authorization: Bearer ${FIRECRAWL_API_KEY}

secrets:
  - name: FIRECRAWL_API_KEY
    required: false
    hint: 免密有限额，填 key 提升额度
    url: https://firecrawl.dev/app
```

stdio 型：

```yaml
slug: playwright
serverName: playwright
category: browser
homepage: https://github.com/microsoft/playwright-mcp
description:
  en: Browser automation driven by accessibility snapshots.
  zh: 基于可访问性快照的浏览器自动化。

transport: stdio
command: npx
args: ['-y', '@playwright/mcp@latest']
npmPackage: '@playwright/mcp'      # 供 nightly 探测版本与下载量
requires:
  node: '>=20'
```

字段规则的硬约束：

- **`serverName` 由目录钦定**，作者不能自选（避免同一服务器在不同机器上名字不同）
- **`secrets` 只写变量名和获取地址，绝不写值**
- **`args`/`env` 里的密钥位置一律用 `${VAR}` 占位**，CI 扫描明文密钥特征并拒绝
- **`env` 是"默认值"而非"用户值"**——例如 `PUPPETEER_HEADLESS: 'true'` 这种非密钥常量可以写死

## 五、探测：这是唯一无法伪造的质量信号

nightly CI 对每条 stdio 型跑一次真实握手（HTTP 型直接请求 `initialize`），产出：

| 字段 | 含义 | 用途 |
|---|---|---|
| `ok` | 能否完成 initialize | 可用性 |
| `toolCount` / `toolNames` | 工具清单 | 详情页展示，**已提前验证过** |
| `protocolVersion` | 协商到的协议版本 | 兼容性预警 |
| `latencyMs` | 握手耗时 | 远程服务健康度 |
| `toolHash` | **工具描述的哈希** | **防 rug pull** |
| `checkedAt` | 探测时间 | 新鲜度 |

`toolHash` 是这一整套里性价比最高的一条：**批准时记录工具描述哈希，之后变更就告警**。这正是 `mcp-scan`（Invariant Labs）验证过的对抗 rug pull 的手段——MCP 的经典攻击就是「你批准时工具是只读的，之后服务器静默改成能删文件」。

同时把这条数据用在面板上：用户装之前就能看到「已验证 26 工具 · 2 天前探测」，而不是装完才发现连不上。

**探测的工程注意**（`LKMeng2001` 的 `mcp-probe.mjs` 踩过）：Windows 上 `npx` 是 `.cmd` shim，必须用 `spawn(process.execPath, [npxCli, ...])` 走 npm 的 `npx-cli.js`，别用 shell。

## 六、上架：PR 为主，表单为辅

### 主路径：PR（照抄独立文件思路）

`data/servers/<slug>.yml` 一个文件一条，永不冲突。这解决了合并冲突级联，已被 4414 条规模验证过。

### 辅助路径：网页表单生成 YAML

这才是「留口子」的正确形态——**不是让人手写 YAML 提 PR，而是表单填完直接生成文件内容 + 一键开 PR**：

```
GitHub 的深链格式：
https://github.com/<org>/<repo>/new/main/data/servers
  ?filename=<slug>.yml
  &value=<URL 编码后的 YAML>
```

用户点一下就到 PR 页面，内容已填好。懂的人仍然可以手写。

### CI 闸门（分层，学参考仓库）

| 闸门 | 查什么 |
|---|---|
| **形式** | YAML 合法、`slug` 与文件名一致、`serverName` 合规、分类合法、`servers.json` 能重新生成 |
| **唯一性** | `serverName` 全局唯一（这个是 MCP 特有的硬约束），`slug` 不重复 |
| **密钥** | 扫描明文密钥特征（`sk-`、`ghp_`、长 base64…），命中即拒 |
| **连通性** | 跑一次真实握手；**stdio 型必须成功**，HTTP 型允许失败但标记不可用 |
| **归属** | `homepage` 可达；若声明 `npmPackage`，校验该包的 `repository` 字段指回 `homepage` |
| **无关改动** | 列出 PR 改动的其他条目，供审查追问 |

**注意一条与插件市场的关键差异**：不要设「仓库满 1 天」这类门槛。MCP 条目**不一定有仓库**（远程 HTTP 服务可能只有个官网），门槛应该是「能连上 + 有可验证的归属」。

## 七、安全模型：比插件市场更需要说清楚

MCP 的风险面和插件不同，必须在目录里**如实披露**，而不是打一个「已审核」的章：

- **Tool poisoning** —— 工具描述里藏指令，会直接进模型上下文
- **Rug pull** —— 批准后静默改工具定义 → 用 `toolHash` 检测
- **URL 归属** —— 官方 registry **不验证 `remotes` 里的 URL 归属**，这是托管型 server 最大的信任缺口，我们必须自己验
- **凭据外泄** —— 服务器能读到给它的所有 header/env

所以每个条目公开一张「信任面」卡片：

```
本地代码   否
出站域名   api.firecrawl.dev
凭据       1 个（可选 FIRECRAWL_API_KEY）
工具哈希   a3f9… ✓ 3 天内无变更
```

并且目录页顶部要有一句和参考仓库一样诚实的话——**「收录不等于安全审查」**。

## 八、界面设计

### 铁律：跟随 DSH 主题，没有自选配色这回事

这一节纠正一个容易走偏的方向。插件 UI **不是**自由设计，DSH 官方规范写死了约束，而且和本站点（静态站）的视觉是两套东西——站点可以用暖纸朱砂，**插件里一个 hex 都不许写**。

预构建插件的契约正文在 `docs/web-styling.md`：

> - Use `--dsw-alias-*` semantic tokens in feature components. **Do not copy static palette values or write literal colors there.**
> - Keep theme selectors out of feature component CSS. **Light/dark overrides belong to the theme owner.**

同一句话也出现在 `packages/extensions/cordis-client-runner` 的 `CLIENT_NOTES` 里，但**那个包服务的是动态包**（用户在面板里即时求值的代码，走 `styles.insert`），不是预构建插件。别把动态包沙箱的说明当成通用规范引用。

所以：**不要写 `:root[data-theme="dark"]`，不要定义自己的强调色，不要写 `@media (prefers-color-scheme: dark)`。** 深色/浅色由 ui-theme 负责，插件只消费语义令牌，两套配色自动都对。任何「冷调深色 + 自定义蓝色强调」的方案都是错的——它在浅色模式下会直接坏掉。

### 你现在的做法是对的

`lib/client.js` 的 `MCP_CSS` 顶部就是标准做法，把主题令牌映射成本地别名，后面一千多行 CSS 全部只用别名（16 个 `--mcp-*`，覆盖颜色、圆角刻度与等宽字体）：

```css
body {
  --mcp-accent: var(--dsw-alias-brand-primary);
  --mcp-ok:     var(--dsw-alias-state-success-primary);
  --mcp-err:    var(--dsw-alias-state-error-primary);
  --mcp-warn:   var(--dsw-alias-state-warn-primary);
  --mcp-mut:    var(--dsw-alias-label-secondary);
  --mcp-bg-1:   var(--dsw-alias-bg-layer-1);
  --mcp-bg-2:   var(--dsw-alias-bg-layer-2);
  --mcp-bg-3:   var(--dsw-alias-bg-layer-3);
  --mcp-line:   var(--dsw-alias-border-l2);
  /* …圆角走 --dsw-radius-*、等宽走 --ds-font-family-code，同在这里收口 */
}
```

⚠️ 宿主选择器是 **`body`**，不是某个组件根。理由与两个反例（挂 `.dsh-mcp-wrap` 会让悬浮按钮取不到圆角、挂 `:root` 取到空值）见 `docs/design.md` 的「面板样式」一节——**那里是这条规则的唯一出处**，本节不重复论证。

实测：面板消费 **31 个 `--dsw-alias-*` 令牌、0 个硬编码 hex**，且全部在官方 101 个令牌清单内、无一失效。这套别名层要继续沿用，市场 UI 直接复用同一批 `--mcp-*`，不要另起一套。

### 官方令牌清单（101 个，权威）

定义在 `packages/client/ui-theme/src/styles/design-platform.css`。机器可读的子集（含 `description` / `requiresLightAndDark`）在 `ui-theme/src/client/index.ts`。分组：

| 组 | 代表令牌 | 用途 |
|---|---|---|
| 背景 | `bg-base` `bg-layer-1/2/3` `bg-overlay` `bg-skeleton` `bg-module-platform` | 分层表面 |
| 边框 | `border-l1` … `border-l4` `border-inverted` | 层级越深越重 |
| 文字 | `label-primary` `label-secondary` `label-tertiary` `label-dimmed` `label-caption` `label-primary-foreground` | 文字层级 |
| 品牌 | `brand-primary` `brand-primary-invert` `brand-text` `link` | 强调色 |
| 状态 | `state-success/warn/error/business/idle-primary` 及 `-secondary/-tertiary` | 语义状态 |
| 交互 | `interactive-bg-hover` `-hover-accent` `-hover-danger` `-active` | 悬停/按下 |
| 按钮 | `button-primary-fill/hover` `button-elevated-fill` `button-ghost-active-fill` `button-contrast-fill` | 按钮材质 |
| 滚动条 | `scrollbar-bg-l1/l2` `scrollbar-hover-l1/l2` | 滚动条 |
| 其他 | `toast-bg` `toast-label` `tooltip-bg` `menu-icon` `switch-thumb` | 组件专用 |

### 几何令牌：别自己编圆角

`docs/ui-radius.md` 是官方圆角标准，**明确禁止**写 10px/14px/18px/24px 这类局部值：

| 角色 | 尺寸 | 半径 | 令牌 |
|---|---|---|---|
| 小细节 | < H20 | R4 | `--dsw-radius-xs` |
| 紧凑控件 | H20–28 | R8 | `--dsw-radius-sm` |
| 标准控件/单行 | H32–40 | R12 | `--dsw-radius-md` |
| 大控件/成组内容 | — | R16 | `--dsw-radius-lg` |
| 独立内容卡 | — | R20 | `--dsw-radius-xl` |
| 主容器/对话框 | — | R28 | `--dsw-radius-panel` |

实测值：`xs:4px sm:8px md:12px lg:16px xl:20px panel:28px`。

官方 spec 的判据是：**落在 `>4px` 且 `<99px` 区间的字面圆角一律违规**（≤4px 算绘图细节，≥99px 算全圆角）。

> ✅ **已落地**（本次改造）：面板原本有 53 处 `border-radius`、15 种取值（8/9/7/10/5/11/6/3/2/14px…），现已全部映射到 `--mcp-r-*` 刻度别名，37 处规则改写完毕、零字面值。

另有两条官方硬规则，做市场 UI 时必须守：

- **全圆角必须配对 `corner-shape: round`**（`50%`、`999px` 药丸形都算）。原因是 `corner-shape.css` 在 `@supports` 里用**通用选择器 `*`** 给整个文档的圆角套 `superellipse(1.5)`；插件渲染在同一文档里，所以这不是理论风险——Chromium 实测 `CSS.supports('corner-shape','superellipse(1.5)')` 为 `true`，没配对的圆点会被压成方圆、药丸两端会被削平。
- **抬升表面用阴影不用边框**：菜单/弹层/模态/面板设 `border: 0` + `box-shadow: var(--dsw-elevation-panel)`。**`--dsw-alias-border-*` 边框和 elevation 阴影不许同时出现**，官方规范明确拒绝这个配对——轮廓会画两遍，且边框宽度撑动布局。状态色边框（`.err` 之类）例外，保持真边框。

> ✅ **已落地**（本次改造）：12 处全圆角补齐 `corner-shape: round`；6 处抬升表面改 `border: 0` + elevation 令牌。
>
> ⚠️ **一个只有真实浏览器才能发现的坑**：别名层不能挂在 `:root`。`ui-theme` 把全部 `--dsw-alias-*` 定义在 **`body`** 上（`design-platform.css` 的 `body{}` / `body[data-ds-dark-theme]{}`），而自定义属性在声明处就完成替换、不参与「向上查找」，所以在 `:root` 上写 `var(--dsw-alias-*)` 会取到空值——整片别名失效、卡片与面板背景全变透明。同理它也不能挂在某个 slot 子树根上（悬浮按钮和侧栏入口没有公共祖先）。**正确宿主是 `body`**，这两条由 `test/theme-contract.test.mjs` 钉住。

### 等宽字体：用 `--ds-font-family-code`，不是 `--dsw-font-mono`

`serverName`、URL、命令、args、工具名应该走等宽——这是信息层级，不是装饰。

这里有一个**名字很像、但全仓没有定义**的坑：`--dsw-font-mono`。它在 `ui-theme` 里没有定义，只是官方若干包约定俗成地**引用**它（`ui-agent-preset`、`ui-jobs`、`ui-plugin-manager` 等 7 处），一律带 fallback 所以看不出问题：

```css
font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
```

`ui-theme` 真正定义过的是 `--ds-font-family-code`（`base.css` 的 `:root`，官方 51 处用它）。两者解析结果**并不相同**：真机上前者得到 `ui-monospace, SFMono-Regular, Menlo, monospace`，后者是 `"SF Mono", "JetBrains Mono", …`。用前者等于永远命中 fallback，等宽字形跟宿主自己的代码块对不上。

而 `--dsw-alias-font-mono` 这个名字**根本不存在**（全仓搜索无定义；`dsh-market` 用了它，那是个 bug，永远命中 fallback）。

> ✅ **已落地**（本次改造）：面板 8 处硬编码 `ui-monospace,Consolas,monospace` 已改走 `--mcp-mono`，指向 `--ds-font-family-code`。
>
> 这类"名字看着对、实际不存在"的错误现在由 `scripts/dsh-theme-tokens.mjs`（408 个主题令牌的清单）+ `aliasContract()` 的存在性校验兜住——**查清单，不查前缀**。带 fallback 不豁免：fallback 恰恰是让错名字长期潜伏的原因。

### 三条可以保留的设计主张

配色和圆角交给主题之后，真正能做出差异的是**信息层级**，这三条仍然成立：

1. **传输徽章是第一视觉元素**。HTTP / stdio 是用户最先要判断的事（远程服务 vs 本地进程），比分类标签重要。你现在的 `.dsh-mcp-badge.t-http` 用 `state-business-primary`、`.t-stdio` 用 `state-warn-primary`——这个映射是对的，市场卡片直接沿用。
2. **探测状态要显眼**。「✓ 26 工具 · 2 天前」是相对所有竞品的差异化，用 `state-success-primary` 做一个实心徽章，别做成一行小灰字。
3. **卡片主操作是「复制配置」**，不是「查看仓库」（见第二节推论 1）。

### 首页布局

```
┌────────────────────────────────────────────────────────────────┐
│  mcp-market            Browse  Categories  Submit ↗  GitHub ↗  │ sticky
├────────────────────────────────────────────────────────────────┤
│                                                                │
│   DeepSeek Harness 的 MCP 服务目录                              │
│   312 个服务 · 本周 41 个通过验证 · 2 小时前更新                  │
│                                                                │
│   ┌──────────────────────────────────────────┐                 │
│   │ 🔍 搜索服务、工具或能力…                    │                 │
│   └──────────────────────────────────────────┘                 │
│                                                                │
│   [全部 312] [搜索 48] [开发 61] [数据 33] [浏览器 27] …          │  chips
│                                                                │
│   排序 [已验证 ▾]   ☑已验证  ☐免密钥  ☐本地 stdio               │  filters
├────────────────────────────────────────────────────────────────┤
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐     │
│  │ HTTP           │ │ stdio          │ │ HTTP           │     │
│  │ firecrawl      │ │ playwright     │ │ exa            │     │
│  │                │ │                │ │                │     │
│  │ 网页搜索、抓取   │ │ 基于可访问性快照 │ │ 网页与代码搜索   │     │
│  │ 与文档解析       │ │ 的浏览器自动化   │ │                │     │
│  │                │ │                │ │                │     │
│  │ ✓ 26 工具       │ │ ✓ 21 工具       │ │ ✓ 2 工具        │     │
│  │   2 天前探测     │ │   1 天前探测     │ │   3 小时前       │     │
│  │ 🔑 可选密钥      │ │ ⚙ 需 Node 20+   │ │ 🔑 可选密钥      │     │
│  │                │ │                │ │                │     │
│  │ [复制配置] [→]  │ │ [复制配置] [→]  │ │ [复制配置] [→]  │     │
│  └────────────────┘ └────────────────┘ └────────────────┘     │
└────────────────────────────────────────────────────────────────┘
```

**卡片主操作是「复制配置」而不是「查看仓库」**——这是第二节推论 1 的直接落地。

### 详情页布局

```
┌────────────────────────────────────────────────────────────────┐
│  全部服务 / 浏览器与 Web / firecrawl                            │ breadcrumb
│                                                                │
│  Firecrawl                        [HTTP]  [✓ 已验证]            │
│  网页搜索、抓取与文档解析                                        │
│                                                                │
│  ┌─ 连接参数 ───────────────────────────────────────────────┐   │
│  │ transport   streamable-http                             │   │
│  │ url         https://mcp.firecrawl.dev/v2/mcp            │   │
│  │ headers     Authorization: Bearer ${FIRECRAWL_API_KEY}  │   │
│  │ 探测        26 工具 · 协议 2025-11-25 · 312ms · 2 天前    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                │
│  ┌─ 安装 ───────────────────────────────────────────────────┐   │
│  │ [ DSH 全局 ] [ DSH 项目 ] [ Claude/Cursor ] [ VS Code ]  │   │
│  │                                                          │   │
│  │  - insert:                                               │   │
│  │      - id: mcp-firecrawl                                 │   │
│  │        name: '@deepseek-ai/dsh-mcp-client'               │   │
│  │        config:                                           │   │
│  │          transport: streamable-http                      │   │
│  │          serverName: firecrawl                           │   │
│  │          url: https://mcp.firecrawl.dev/v2/mcp           │   │
│  │          headers:                                        │   │
│  │            Authorization: !!js "Bearer " + (process.env.FIRECRAWL_API_KEY ?? "") │
│  │                                            [ 复制 ]      │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                │
│  🔑 需要凭据   FIRECRAWL_API_KEY（可选）        获取 →          │
│                                                                │
│  ┌─ 工具（26）──────────────────────────────────────────────┐   │
│  │ firecrawl_scrape    Scrape a single URL and return…      │   │
│  │ firecrawl_search    Search the web and return results…   │   │
│  │ firecrawl_map       Discover URLs on a site…             │   │
│  │ …                                                        │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                │
│  ┌─ 信任面 ────────────────────────────────────────────────┐   │
│  │ 本地代码   否                                            │   │
│  │ 出站域名   api.firecrawl.dev                             │   │
│  │ 凭据       1 个（可选）                                   │   │
│  │ 工具哈希   a3f9… ✓ 3 天内无变更                           │   │
│  └─────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

**安装区的四个 tab 是核心**：DSH 全局 / DSH 项目 / Claude-Cursor / VS Code。第三、四个 tab 的价值是——用户配过一次，别的客户端也能用同一份目录。

### 其他客户端的深链（实测格式，编码不同会静默失败）

| 客户端 | 格式 | 编码 |
|---|---|---|
| Cursor | `cursor://anysphere.cursor-deeplink/mcp/install?name=$NAME&config=$CONFIG` | **base64**（config 内不含 name） |
| VS Code | `vscode:mcp/install?name=$NAME&config=$CONFIG` | **URL-encode** |
| VS Code 网页版 | `https://vscode.dev/redirect/mcp/install?name=…&config=…` | URL-encode |

另注：VS Code 已从 `.vscode/mcp.json`（顶层 `servers`）**迁移到可移植的 `.mcp.json`（顶层 `mcpServers`）**，与 Claude/Cursor 收敛为同一格式。这是个常见的 bug 源——两个文件顶层 key 不同。

## 九、落地路径

复用 `dsh-mcp-manager-ui` 的现有能力，分四步：

| 阶段 | 做什么 | 产出 |
|---|---|---|
| **1. 数据源** | `BUILTIN_MCP_SERVERS` 抽成 `data/servers/*.yml`；写 `build-catalog.mjs` 生成 `servers.json`；面板改为远程拉取 + 本地兜底。手工收录 30–50 个主流 | 面板能装 50 个而不是 5 个 |
| **2. 探测** | nightly probe：initialize + tools/list + `toolHash`；结果写回目录；面板显示「已验证 N 工具」 | 相对所有竞品的差异化 |
| **3. 提交** | 网页表单 → 生成 YAML → GitHub 深链一键开 PR；CI 分层闸门 | 「留口子」落地 |
| **4. 站点** | 静态站（GitHub Pages），复用同一份 `servers.json`；catalog 发布成 npm 包（学参考仓库，解决大陆访问 + 可回滚） | 独立的发现入口 |

阶段 1 和 2 就能形成完整闭环，3 和 4 是放大器。

**关键的架构纪律**：`servers.json` 是唯一契约。面板、站点、第三方消费者都只读它，没有任何一方直接从 `data/servers/*.yml` 读。这条守住了，站点和插件就永远不会漂移。

## 十、待决问题

1. **独立仓库还是并入 `dsh-mcp-manager-ui`？**
   并入的优势：现成的安装 UI、双作用域写入、`!!js` 表达式生成、工具清单渲染，阶段 1 的工作量能砍掉大半；且 `dsh-mcp-manager-ui` 已发 npm、有 CI 和测试基线（248 tests）。
   独立的优势：目录是公共资产，不该绑在一个插件上；贡献者不必懂面板代码。
   **倾向：目录独立成仓（`dsh-mcp-catalog`），面板作为它的第一个消费者。** 这样目录能独立演进和被第三方消费，而面板继续吃它的现成能力——两边的好处都拿到。

2. **catalog 要不要发布成 npm 包？**
   如果主要受众在大陆，答案是**要**。理由和 `publish-catalog.mjs` 里写的一模一样：Pages 就是 GitHub，慢；npm 有全部镜像；而且带了版本号可以回滚。

3. **`serverName` 钦定后与用户已有配置冲突怎么办？**
   例如用户已经把 Exa 配成了 `my-exa`。面板侧的策略应该是**识别并跳过**（现有 `BUILTIN_MCP_IDENTITIES` 已经在按 hosts/packages 做身份识别，扩展它即可），而不是覆盖。

## 十一、已定结论（不需要再讨论）

- **圆角与配色按官方标准对齐** —— ✅ 已落地。37 处圆角映射到 `--mcp-r-*` 刻度、12 处全圆角补齐 `corner-shape: round`、6 处抬升表面改 `border: 0` + elevation 令牌、8 处等宽字体改走 `--ds-font-family-code`、别名层从 `.dsh-mcp-wrap` 移到 `body`。判据落在 `scripts/theme-spec.mjs`，断言落在 `test/theme-contract.test.mjs`（含自检）。真机验证：Chromium 下 `corner-shape` 生效，明暗两套配色下背景/文字/圆角全部正确解析。完整理由与两个反例见 `docs/design.md` 的「面板样式」一节。
- **别名层用 `--mcp-*` 收口**，市场 UI 复用同一批，不另起一套。

> 📌 本节与第八节只是**结论摘要**。规则正文（为什么挂 `body`、四条官方 spec 的判据从哪来、令牌存在性怎么查）以 `docs/design.md` 为准，避免两处各自演化。
