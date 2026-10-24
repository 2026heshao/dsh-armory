# 安装与升级

本文区分正式安装和本地开发安装。正式使用推荐 GitHub、npm 或 tarball，不要长期依赖开发目录的 `link:`。

## 环境要求

- DeepSeek Harness `0.1.5-rc.1` 及以上（已验证至 `0.2.0-rc.2`）
- 已初始化的 `web` profile
- Node.js 和 pnpm 可由 DSH 的插件命令正常调用

插件把 DSH 宿主 API 声明为 `>=0.1.5-rc.1 <0.2.0` 的 peer 依赖。只支持 0.1.5 起，因为插件用了两个 0.1.5 才有的官方能力：`mcp-client` 按注册作用域判 `serverName` 唯一性（项目级 MCP 的同名能力建立在此），以及 `setup` 把 agent 作为第二个参数传给插件（项目 MCP 挂载需要 agent 的 cwd）。开发基线跟随已验证的最新 RC，并镜像每一个 peer 依赖（另有一个仅供测试的 `@deepseek-ai/dsh-typert-loader`，见[设计与限制](design.md#版本范围怎么定以及它管不到什么)）；升级 DSH 后运行 `pnpm install && npm test` 验证。

## 安装

推荐用 npm 安装：包里的 `^1.x` 范围让后续 `dsh plugin update` 能自动升级小版本。

```sh
dsh plugin --profile web add dsh-armory@^1.9.0
```

也可以固定 GitHub release tag（适合需要锁定某个具体版本时）：

```sh
# 固定 release tag
dsh plugin --profile web add github:2026heshao/dsh-armory#v1.9.0

# 或固定某个 commit
dsh plugin --profile web add github:2026heshao/dsh-armory#<commit>
```

两种方式的**代码与运行行为完全相同**（包里带预构建的 `lib/`，不需要运行 `prepare`，也不需要配置 `allowBuilds`）；区别只在升级：`^1.x` 范围能被 `dsh plugin update` 自动推进，而 tag/commit 是不可变规格、`update` 只会重新解析同一个规格。

如果之前安装的是本地开发目录或另一种规格，先移除旧依赖：

```sh
dsh plugin --profile web remove dsh-armory
```

安装完成后重启 Web Host：

```sh
dsh web
```

## 验证安装

检查 profile 的有效配置：

```sh
dsh --profile web --dump-config
```

输出中应出现：

```yaml
id: dsh-armory
name: dsh-armory
```

打开 DSH Web 后，右下角应出现面板按钮。面板能够读取当前 profile 中的 MCP，并对可管理条目执行启停、编辑、重连和删除。

## 升级

```sh
dsh plugin --profile web update dsh-armory
```

升级后重启 `dsh web`。

按安装时的规格，行为不同：

| 安装规格 | `update` 的效果 | 怎么跨版本 |
|---|---|---|
| `dsh-armory@^1.9.0`（npm，推荐） | 在 `^1.x` 内自动升到最新小版本，不会跨到 2.0.0 | 已是自动；跨大版本显式安装 `@^2` |
| `github:...#v1.9.0`（tag） | 重新解析同一个 tag，**不会动** | 换成新 tag 重新 `add`：`... #<新 tag>` |
| `github:...#<commit>` | 同上，固定在 commit | 用新 commit/tag 重新 `add` |
| `github:...#main`（分支） | 拉取最新 main | 已是自动；但不推荐生产（无 release 门槛） |
| `link:<本地目录>`（开发） | 不适用 | 在 checkout 里 `git pull` 后重启 `dsh web` |

为什么 tag 不会自动跨版本：`dsh plugin` 是 `pnpm` 的薄转发器，`update` 就是「按 package.json 里的 spec 再解析一次」，而 git tag 是不可变规格、没有范围语义（`pnpm update --help`："Updates packages to their latest version **based on the specified range**"）。

面板自带更新提示与一键升级（查 GitHub Releases，每天最多一次、可关闭、不会自己动；点「升级」才装）。npm 安装的用户也可以用命令行 `update` 升级，两者等价。每个 release 都会同时发布到 npm 与 GitHub Releases，两者版本一致。

### 从 dsh-skill-mcp-board 升级

1.9.0 起本插件由 `dsh-skill-mcp-board` 更名为 `dsh-armory`（npm 包名、GitHub 仓库名、bundle id 一并改）。这不是同一个包的版本升级，而是**换了一个包名**，所以：

```sh
dsh plugin --profile web add dsh-armory@^1.9.0
dsh plugin --profile web remove dsh-skill-mcp-board
```

顺序无所谓，但**两个都要做**——只装新的会留下旧条目，只删旧的会丢掉面板。profile 里的 MCP 配置、项目的 `.dsh/mcp.json`、召唤出的专家预设都不受影响（它们由 `@deepseek-ai/dsh-mcp-client` 和 Agent preset 持有，不属于本插件）。

浏览器侧的入口偏好、悬浮按钮位置、「本版本内不再提示」的更新提示和 whatsNew 已读版本会在第一次打开面板时自动从旧键迁移到新键（`dsh-skill-mcp-board/*` → `dsh-armory/*`），用户无需重新设置。

## 发布流程（维护者）

npm 与 GitHub Releases 必须**同一次发布里都更新**：用户从 npm 升级，面板的更新提示查 GitHub Releases（`https://api.github.com/repos/2026heshao/dsh-armory/releases/latest`）。两者版本不一致就会出现「提示说有新版、`update` 却拿不到」。这两件事由 `.github/workflows/release.yml` 在推 tag 时自动完成，并且会先校验「tag 与 package.json 版本一致」再跑测试。

### 一次性准备（只需做一次）

1. **首次发布必须本地交互式完成**：npm 要求发布带 2FA 挑战，而包必须先存在才能在包设置里配置 trusted publisher。

   ```sh
   npm login    # 会话 token 有效期 2 小时，发布时会弹 2FA 挑战
   npm publish
   ```

2. 在 npmjs.com 该包的 Settings → **Trusted Publisher** → GitHub Actions，填：organization/user `2026heshao`、repository `dsh-armory`、workflow filename `release.yml`（可另填 environment）。
3. 之后可选但推荐：把包的 Publishing access 设为 **Require two-factor authentication and disallow tokens** —— trusted publishing 不受该限制影响（它用 OIDC，不是 token），而长期写凭据因此彻底用不上。

### 每次发布

```sh
# 1) 改版本：package.json + README/docs 里的版本与 tag 引用 + lib/whats-new.js 的更新条目
#    + .github/release-notes/v<新版本>.md（后两项缺一项，release.yml 的校验步骤就会红）
npm install --no-save yaml@2   # 测试唯一的裸依赖；干净 checkout 必须先装
npm test                       # 专家市场写链 33 断言（与 CI / 发版门槛同一条命令）

# 2) 真机过一遍（触发条件见下），**必须在打 tag 之前**
dsh web    # 打开面板点一遍

# 3) 提交并推 tag（release.yml 会校验 tag 与 version 一致，不一致就拒绝发布）
git add -A && git commit -m "..."
git push origin main
git tag -a v1.9.1 -m "v1.9.1 ..." && git push origin v1.9.1
```

推 tag 后 `.github/workflows/release.yml` 依次做：校验 tag 与版本一致 → 校验 whats-new 有当前版本条目 → 校验 release notes 稿存在 → 装 `yaml@2` → `node ./test/run-expert-manual.mjs` → `npm publish`（trusted publishing，无需 token）→ `gh release create`。

CI 分工（两条工作流，门槛命令**逐字相同**，改一处必须改另一处）：

| 工作流 | 触发 | 跑什么 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | push 到 main、PR、手动 | 装 `yaml@2` → `node ./test/run-expert-manual.mjs`（只验证，不发布） |
| `.github/workflows/release.yml` | 推 `v*.*.*` tag、手动 | 同上门槛 + 版本 / whats-new / release-notes 三项校验 → `npm publish` → GitHub Release |

> **本仓库没有 `pnpm-lock.yaml`**（运行依赖全是宿主提供的 peer，不装进包），而 devDependencies 里的 `@deepseek-ai/*` 是宿主内部包、npm registry 上不存在。所以两条工作流都**不能用** `pnpm install --frozen-lockfile`——改回它会立刻红（历史上失败过一次）。测试只需 `yaml`，用 `npm install --no-save` 装。

**第 2 步的真机检查什么时候必须做**：客户端那一半是替身测试——组件在 node 里渲染不起来（见[设计与限制](design.md#版本范围怎么定以及它管不到什么)），所以 CI 全绿也证明不了面板能显示。因此**只要本次改动碰了 `lib/client.js`、或推进了 DSH 基线，就必须做**：起 `dsh web`，确认侧栏入口能打开面板、悬浮按钮在位，然后导入 / 预览 / 启停各点一次。

为什么不能交给 CI：这类失败的表现是**面板白屏**，不会让任何用例变红（注册契约是好的，渲染不出来而已）。宿主改 slot 就是这种改动的典型——`0.1.6-alpha.2` 的发布说明里有「客户端 Session 会话支持多实例共存，相关 API 及 slot 有变化」，2026-09-24 推进基线到 `0.1.7-rc.1`、09-28 推进到 `0.1.7-rc.2` 时也属于这一类，所以它固定成检查单而不是靠记得。纯 Host 侧改动（`lib/index.js`、`lib/workspace-*.js` 等）可以跳过这一步。

**Release notes 是必写的**，稿子放 `.github/release-notes/vX.Y.Z.md`（**不要**放 `docs/`，docs 会随包发布到 npm）；`release.yml` 的「校验 release notes 稿子存在」步骤会拦下漏写，`gh release create --notes-file` 用它作为 Release 页面正文。为什么必写：本仓库全部直接提交到 main、没有 PR，自动生成几乎生成不出内容（v1.3.0 及之前每个 Release 页面都只有一行 compare 链接），而面板的更新提示正是把用户指到那一页。

**应用内的「更新到 vX」提示是另一件事**：它的内容真源是 `lib/whats-new.js`（随包发布，宿主的 `whatsNew` RPC 直接转发它），发布前必须给它写上当前版本那一条——`test/whats-new.test.mjs` 会拦下「bump 了版本却没写更新内容」。只写一条就够，不必和 GitHub Release notes 逐字一致。

### 不用 CI 的手动路径（备选）

`npm publish` 不会跑构建（包内已含 `lib/`，也没有 `prepare`/`prepublishOnly`），发布的就是提交里的文件；因此**先提交、再发布**，否则 npm 上的包会与 tag 内容不一致。发布前用 `npm pack --dry-run` 核对内容与体积。

```sh
npm publish          # 会弹 2FA 挑战；若用 bypass-2FA 的 granular token 则非交互
gh release create v1.9.0 --title "dsh-armory v1.9.0" --notes-file <notes>
```

`npm login` 的会话 token 只有 2 小时，超时需要重新登录；classic token 已被 npm 永久吊销，能非交互发布的只剩勾了 **Bypass 2FA** 的 granular access token——但它正在被 npm 收窄（已不能做账号/包管理类操作，且 2027-01 起将失去直接发布能力），所以长期方案是上面的 trusted publishing。

## 卸载

```sh
dsh plugin --profile web remove dsh-armory
```

卸载插件不会自动删除当前 profile 中已有的 `@deepseek-ai/dsh-mcp-client` 条目。

## 本地开发安装

本地开发才使用目录安装：

```sh
cd C:\sudy\github\dsh-armory
pnpm install
dsh plugin --profile web add C:\sudy\github\dsh-armory
```

修改 Host 代码后需要重启 `dsh web`；浏览器 bundle 是否热更新取决于当前 DSH 的 client HMR 状态。

## 常见问题

### `Remote package ... is already registered`

插件被重复装配。确认 bundle、profile patch、Agent preset 和额外 `--patch` 中只有一个 `dsh-armory` 条目。

### `file access denied under workspace-write mode`

旧版本错误地通过会话文件系统写 profile。当前版本使用固定目标的 Host 原子写入，不需要切换到 `danger-full-access`。升级插件并重启 Web Host。

### 面板能看见但修改后立即恢复

先查看页面上的错误提示，再确认 profile 文件没有被其他进程同时编辑。插件使用内容版本检查，检测到外部修改时会拒绝覆盖。

### 项目 MCP 显示「挂载失败」或「作用域故障」

两者不是同一类故障，面板顶部的横幅和行上的标记会告诉你是哪一类：

- **挂载失败**：本插件在**会话挂载阶段**（`agent/created` 串行监听器）就没挂上（`${VAR}` 求值为空、`failOnStartupError: true` 下启动失败、工具注册被拒等）。点开那一行的详情看具体原因。
- **作用域故障**：连接本身是好的，但工具不在共享作用域层（落到了全局层）。原因是 `@deepseek-ai/dsh-scope` 在宿主与插件之间解析成了两份模块实例（作用域标签是模块内的 Symbol）。先核对两点：
  1. profile 的 `pnpm-workspace.yaml` 是否仍是官方写入的形状——它必须带 **`autoInstallPeers: false`**，否则 pnpm 会把 9 个 `@deepseek-ai/dsh-*` peer 装进 profile 自己的 `node_modules`，插件就会解析到第二份宿主包（这正是官方注释写明要避免的事）。
  2. 安装的依赖树里是否只有一份 `@deepseek-ai/dsh-scope`。
  修好后重启 `dsh web` 即可恢复。

同一项目的多个会话不会因并发而撞 `serverName`：项目 MCP 按 `(项目, serverName)` 共用一份连接（0.1.5 起 `mcp-client` 按注册作用域判重），所以这个错误不会因「同项目开了两个会话」而出现。
