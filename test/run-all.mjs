// 全部测试的总入口（`npm test` 与 CI 跑的就是它）：
//   1. expert-manual —— 专家市场写链（真网目录 + 人设 + patch 往返，含 1.9.1 回归）
//   2. upgrade-plan  —— 一键升级安全判据（本地安装/来源未知一律不写）
// 每个子文件是独立 node 进程：互不污染，任一非零退出即整体失败。
//
// 为什么不用 `node --test`：它会按文件名把 test/ 下每个 .mjs 都当测试文件执行，而
// test/migrate-profile-patch.mjs 是**有副作用的迁移脚本**（带 --write 会改用户的
// profile patch）、verify-e2e-compose.mjs 需要宿主模块——自动发现会把它们误跑。
// 显式列白名单是唯一安全的做法。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SUITES = [
  // 账本与 MCP 配置层（OPT-09）：这两个模块以前**零测试引用**，OPT-01（zstd 缺失时
  // 静默全 0）与 OPT-06（日志无尺寸上限）当时没有任何用例能发现。都只用本机模块、
  // 不碰真实 profile、不联网，放最前面让基础层先过。
  { name: "tool-ledger（工具账本：zstd/缓存/尺寸闸门）", file: "tool-ledger.mjs" },
  { name: "mcp-config（MCP 配置归一化与 patch 往返）", file: "mcp-config.mjs" },
  // 契约三处一致性（护栏）：面板可调方法必须同时出现在 typert.js 声明、client.js 契约数组、
  // index.js 宿主方法集。历史上 toolTailor、installInfo 各漏一处就是恒 404；运行时解析三份
  // 源码做差集，不硬编码方法名（client.js 在持续演进）。
  { name: "contract-consistency（契约三处一致性）", file: "contract-consistency.mjs" },
  // 导入源降级结构（OPT-17）：VS Code 的 ${input:xxx} 逐条降级（unsupportedEntries 四键）、
  // projectSourceRow 投影键集钉死（lib/index.js:635 注释指名由本文件守护）。
  { name: "host-import-sources（导入源降级结构）", file: "host-import-sources.test.mjs" },
  // 入口可见性不变式：面板只能从 panel/fab/sidebar 三个入口打开，「三个都关」是必须
  // 无法表达的状态（真出现了用户只能手改 localStorage）。以前这条只写在注释里，注释还
  // 引用了一个并不存在的测试文件名——现在把那段源码原样抽出来在 vm 里真跑，并对表断言。
  { name: "client-entry（入口可见性不变式）", file: "client-entry.mjs" },
  // i18n 守护（OPT-11）：「全部中文皆已包 t()」+ 骨架行为。这两条没有运行时行为变化，
  // 编译器和其它测试都守不住，只能靠这里的词法/行为断言。
  { name: "client-i18n（i18n 骨架与中文包裹不变式）", file: "client-i18n.mjs" },
  // 专家卡片按钮判定守护：1.9.4「点『需更新』没反应」的直接回归用例。判定原先内联在 JSX
  // 三元里（node 测不到），「更新预设」被塞进 summoned 的恒假分支 → 按钮永不渲染。抽成纯
  // 函数后在这里跑真值表，并用反向自测钉住旧写法不得复活。
  { name: "expert-card-actions（专家卡片按钮判定 / stale 更新入口）", file: "expert-card-actions.mjs" },
  { name: "expert-manual（专家市场写链）", file: "run-expert-manual.mjs" },
  { name: "upgrade-plan（一键升级判据）", file: "upgrade-plan.mjs" },
  { name: "session-persona（会话级专家随时挂/换/摘）", file: "session-persona.mjs" },
  // 团队型专家桥接：成员人设落盘 + 桥接段注入 + 送还清理。用替身宿主跑，
  // 全程禁止联网（globalThis.fetch 被替换成必抛函数），不碰真实 profile。
  { name: "team-bridge（团队专家召唤桥接）", file: "team-bridge.mjs" },
  // 专家人设取数链（issue #5）：上游 43% 的专家没有公开分发人设文件（404）。
  // 覆盖优先 → 本机缓存 → CDN → 标注过的兜底人设，任何情况下都不静默产出空人设。
  { name: "expert-persona-source（人设取数链：覆盖 / 本机缓存 / CDN / 兜底）", file: "expert-persona-source.mjs" },
  // 真机验证：读真实 profile manifest，证明判定对真数据成立。profile 不存在时
  // 该文件会自行 SKIP（其它机器 / CI 上跑不出结论，但不会误报失败）。
  { name: "verify-install-info（真 profile 数据）", file: "verify-install-info.mjs" },
  { name: "verify-host-installinfo（宿主读取路径）", file: "verify-host-installinfo.mjs" },
  // ── v1.10.0 优化的回归护栏 ─────────────────────────────────────────────────
  // 以下五条钉的是本轮 18 项优化里「编译器与既有测试都守不住」的行为契约。
  // 它们不改动任何源码，只读取/执行 lib/ 下的现有实现。
  //
  // i18n 覆盖率：双向差集（源码 t() 键 ↔ en-US 字典键）。client-i18n 只保证「中文都包了
  // t()」，不保证「包了就有译文」—— 英文界面上蹦中文正是这个缺口。历史缺口用只许收缩的
  // 基线集合登记，任何**新增**漏键/死键立刻失败。
  { name: "i18n-coverage（en-US 字典覆盖率与 locale 四级回落）", file: "i18n-coverage.mjs" },
  // P1 数据型英文覆盖：更新日志不是 client.js 的 t() 字面量，字典覆盖率看不到它。
  // 这个套件钉「版本/条目逐条对齐 + 客户端选择 + 缺译文回落」，含反向自测。
  { name: "whats-new-i18n（更新日志 en-US 覆盖与客户端选择）", file: "whats-new-i18n.mjs" },
  // persona 4000 预览阈值（清单 3.2）：两处详情弹层都走常量、无散落硬编码、展开/收起双向。
  { name: "persona-truncate（persona 预览截断阈值）", file: "persona-truncate.mjs" },
  // 工具裁缝时间窗（清单 4.1）：新增「今日」档不得改变默认 30 天 —— 改了会让报告数字骤降。
  { name: "tailor-window（工具裁缝时间窗四档与默认值）", file: "tailor-window.mjs" },
  // 工具裁缝的税时间维度（清单 6.1–6.4）：源自一次真实排查 —— 用户看到「消耗 token 几天没变」
  // 但界面无法自证是裁缝坏了还是注册表真没改。合成 request/header 夹具真跑账本，钉住逐日真实下
  // 发税、清单变化次数、注册表↔线上差额（无线上数据必须 null 不是 0）、跨度取整、undated 显形、
  // 指纹表 64 上限。
  { name: "tailor-timeline（工具裁缝：真实下发税与归因跨度）", file: "tailor-timeline.mjs" },
  // 上面那套的**面板侧**：账本新字段（wireTaxDaily / wireTaxLatest / scannedSpanDays /
  // undatedCalls / wireTaxTruncated / wireTaxDivergenceTokens）经 `$any` 信封传递，界面读错
  // 字段名不会报错、只会静默不渲染。照 install-toast 的办法把 client.js 的三段源码抽进 vm
  // 真跑，对真实节点树断言，并含两条反向自测（改错字段名 / 放开阈值都必须让护栏变红）。
  { name: "tailor-tax-ui（工具裁缝：税时间维度的界面接线）", file: "tailor-tax-ui.mjs" },
  // 工具裁缝「清空缓存」按钮的**删除**护栏（2026-10-23 实测：宿主丢掉 clearTextCache() 返回值 →
  // 面板恒显示「正在清空缓存…」；先清后扫 → 占用一位不降；本机 92 日志 / 32 槽命中率 0%）。
  // 钉的是「不许复活」：真跑 cacheLine 切片断言子树里没有 button/onClick/合成分，读数仍在；
  // 再钉接线层（面板不再发 action、index.js 不再 import clearTextCache）。含 6 条反向自测。
  { name: "tailor-cache-line（工具裁缝：账本缓存只读行，清空动作已删）", file: "tailor-cache-line.mjs" },
  // 崩溃详情可复制（清单 6.1）：真跑边界组件，钉住 componentStack 入剪贴板与 retry 清 info。
  { name: "error-boundary-copy（崩溃详情可复制）", file: "error-boundary-copy.mjs" },
  // 条件分支里的 hook（React #310 定式）：市场 → 专家点「详情」整块面板白屏的直接售后。
  // 根因是详情弹层写成 `detail ? (() => { … })()`，而 hook 声明在弹层内部 —— 首帧 detail
  // 为 null 时一次都不调，点开后同一组件突然多调两个 → Rendered more hooks than during
  // the previous render。这类错误 node --check、ESLint（仓库未开 react-hooks 规则）、
  // 以及全部行为断言都看不见，只能静态守形状：遮罩掉字符串/注释后配平花括号，断言任何
  // 三元 / && / || 的 IIFE 体内零 use[A-Z] 调用，并把原始 bug 注回去反向自测必须变红。
  { name: "no-conditional-hooks（条件分支内不得出现 hook / React #310）", file: "no-conditional-hooks.mjs" },
  // teardown 残留诊断（清单 2.4）：live/final 两种读法 + 超龄不送 + 记录表裁剪，真跑函数。
  { name: "teardown-residue（teardown 残留诊断）", file: "teardown-residue.mjs" },
  // issue #6：项目 MCP 第一次添加时项目还没有 .dsh/mcp.json，旧写法因此不登记会话，
  // 写盘对齐找不到它 → 必须新开会话。真跑 mount 路径，只断言登记与兜底扫描。
  { name: "workspace-runtime（项目 MCP 中途添加：会话登记与存活会话兜底）", file: "workspace-runtime.test.mjs" },
  // README 配图守护：v1.10.0 那次提交把「界面预览」整段覆盖回 1.8 时代的四张旧图，
  // 1.9.4 新增的五页实拍从仓库树里一并消失，而编译器/测试/CI 全绿 —— 因为没有一条断言
  // 关心 README 引用的是哪几张图。这里钉「引用可解析 + screenshots.json 与 README 一致 +
  // mcp-manager-* 旧图名不得复活」三条。
  { name: "readme-images（README 配图不回退守护）", file: "readme-images.mjs" },
  // ── 双 Bug 回归护栏（v1.10.x）──────────────────────────────────────────────
  // 用户报的两条都是**行为缺陷**，正则改一改就能骗过文本断言，编译器更是一句话都不会说：
  //   1. 「去市场找现成的」跳到会话界面 —— 根因是 openBoardCategory 借用了开关语义的
  //      openBoardPanel，已在看板页时反手 selectPanel(null)。改成强制选中即可，但
  //      openBoardPanel 的 toggle 语义是 4 个入口按钮共用的，**不能被顺手改掉**；
  //   2. 首次进看板页内容整体偏下 40px —— 根因是 Windows 上框架已让过标题栏，插件又用
  //      --dsh-frame-top-clearance 让一次，再用 100dvh 反算，三段相加多出一整个标题栏。
  // 本套件把源码片段抽出来在 vm 里真跑（跳转链、分类状态机），并对 CSS 做高度账，
  // 另配 mutation 反向自测：把旧写法注回去断言必须变红，否则说明正向断言是空转。
  // 不联网、不写盘、不碰真实 profile，可安全纳入 CI。
  { name: "bugfix-armory（市场入口强制选中 + 看板页重复让位）", file: "bugfix-armory.mjs" },
  // 「最近使用」排序修复回归（QA）：listExpertRecent 的 expert 分支曾漏 await ——
  // patch 恒为 Promise → readExpertPresets(Promise) 抛 TypeError → wbExpertRecent RPC
  // 恒失败 → 菜单永远按字母序。钉住三件事：① 修复后写法 `patch = await readFile(...)`
  // 在场且旧 dynamic import 组合不得复活；② readExpertPresets(patch) 有独立 try/catch
  // 兜底（patch 被改坏回落 live=null，不炸整条链）；③ live 对账后过滤写回的原有语义
  // 未被顺手改掉。动态项真调 listExpertRecent（只读不断言条数）。
  { name: "recent-sort-regression（最近使用排序修复回归）", file: "recent-sort-regression.mjs" },
  // 召唤菜单专家显示名回归（2026-10-24 用户报「专家二级菜单整列英文标识名」）：钉住
  // readExpertPresets 从预设行剥出 `WorkBuddy 专家 · <名>` 的名字，以及 wbExpertInstalled
  // 的三层回落（目录缓存 → 预设行自带名 → 标识名）。含前缀常量写读同源 + 与 client.js
  // 匹配串逐字一致，另配 2 条反向自测。全程离线，不碰真实 ~/.dsh。
  { name: "expert-display-name（召唤菜单专家显示名三层回落）", file: "expert-display-name.mjs" },
  // ── T01 共享数据层（多市场注册表 / 安装状态 / 认证注入规则）───────────────
  // 三个模块只用本机内置模块、零网络、零真实 ~/.dsh（隔离靠 mkdtemp + rootDir 注入），
  // 注册表还把「内置 connectors 源 URL 与 lib/wb-market.js 现值一致」钉进了用例。
  { name: "wb-registry（多市场注册表：默认回落/合并投影/原子写）", file: "wb-registry.mjs" },
  { name: "wb-install-state（安装状态与来源锁）", file: "wb-install-state.mjs" },
  { name: "wb-auth-rules（认证注入规则与令牌槽扫描）", file: "wb-auth-rules.mjs" },
  // 自定义套件数据层（Skill 看板「套件」功能的持久化）：整集合覆盖保存、id 由数据层
  // 分配、成员保序去重。同样是零网络 + mkdtemp 隔离，并把失败模式两态（拒绝脏数据 /
  // 放行 + 截断）与「拒绝后原文件逐字节未变」钉进用例——保存链一旦半写就是脏数据。
  { name: "suites-registry（自定义套件：整集合覆盖/幂等/拒绝与截断两态）", file: "suites-registry.mjs" },
  // 套件的客户端侧：数据层测不到「保存后同一套件分裂成两条」——那长在 id 归属契约上
  // （本地临时 id 提交时置空 → 数据层分配真 id → UI 以返回值刷新副本）。这里把 client.js
  // 里套件工具层与召唤菜单插入链的**源码原文**抽进 vm 真跑（与 install-toast.mjs 同套路），
  // 顺带钉住「引用套件 = 展开成逐个 /name」与「最近使用按成员而非套件名上报」。
  { name: "suites-client（自定义套件：id 归属契约/展开引用/三级写通道降级）", file: "suites-client.mjs" },
  // 已安装 skill 的卸载数据层（lib/skill-remove.js）：全仓唯一会永久删文件的函数，
  // 用例重点不是 happy path，而是「不能删什么」——来源白名单（bundled/runtime/custom）、
  // 根目录自身与 `..` 穿越、跨来源根、缺 SKILL.md、符号链接只删链接 / 祖先链接逃逸。
  // 全部落在 mkdtemp 下（home / cwd 注入），零网络、绝不碰真实 ~/.agents 或 ~/.dsh。
  { name: "skill-remove（已安装 skill 卸载：来源白名单与路径边界）", file: "skill-remove.mjs" },
  // 技能禁用数据层（lib/skill-disable.js）：工具裁缝「禁用 / 释放」的落盘点，写的是用户
  // 的 SKILL.md。用例重点同样是「不能写什么」——来源白名单、根目录边界、形态校验
  // （缺 frontmatter / BOM / 非 .md）、符号链接（根外拒绝、根内写 realpath 不动链接），
  // 外加纯函数的 frontmatter 手术（插入/收敛/移除、CRLF、幂等）与写入结果的 yaml 复核。
  { name: "skill-disable（技能禁用/释放：frontmatter 标志与写盘闸门）", file: "skill-disable.mjs" },
  // Skill 集合变更的跨组件实时刷新（QA）：市场装/卸后顶部角标与看板列表必须立刻对齐。
  // 缺口来自「角标只在 McpBoardPage 首次挂载读一次」，普通静态断言看不见——这里把变更
  // 总线与角标重取函数抽进 vm 真跑（reason 透传 / 抛错隔离 / 退订 / 乱序守卫），并钉住
  // 三个变更入口（看板卸载、市场安装、市场卸载）都广播、两个消费方都订阅。
  { name: "skill-refresh（技能集合实时刷新：总线/角标重取/三入口广播）", file: "skill-refresh.mjs" },
  { name: "skill-install-integrity（技能假安装：并发串行/落盘复核/已装双键/搜索框焦点）", file: "skill-install-integrity.mjs" },
  // ── T02 连接器元数据投影 ─────────────────────────────────────────────────
  // 纯解析层守护：零网络、零真实 ~/.dsh。钉 R1 注入规则标注 / R2 visible_in 标签筛选 /
  // R3 examples 优先。（T03 的 CodeBuddy 插件市场已于 2026-10-24 整体移除，对应套件一并下线。）
  { name: "wb-connector-meta（连接器 R1/R2/R3 投影：注入规则/标签筛选/examples）", file: "wb-connector-meta.mjs" },
  // issue #3（NVIDIA App 本地助手连不上）回归：本地客户端型连接器把固定本机程序写死在
  // `cmd /c <path>` 里，旧实现不做预检、装完才由宿主重连 10 次失败。这里钉路径识别
  // （不误判 npx 包名/数据路径）、found/missing/platform 三态与按路径去重。零网络、不 spawn。
  { name: "wb-connector-local（本地客户端型连接器的本机依赖预检）", file: "wb-connector-local.mjs" },
  // 卡片可点击性：pointer 指针 / 键盘可达 / 操作按钮不冒泡（DSH 社区插件卡片）。
  { name: "market-card-affordance（插件卡片：指针/键盘/冒泡守卫）", file: "market-card-affordance.mjs" },
  // DSH 社区插件卡片的五段式排版（2026-10-24）：固定 176px、标题单行、作者只出现一次、
  // 验证态只留图标、标签最多三个、按钮落同一水平线。只读源码，含反向自测。
  { name: "plugin-card-layout（社区插件卡片：五段固定行高与信息去重）", file: "plugin-card-layout.mjs" },
  // 市场安装鉴权闸 + 装前 401 探测回归（BugFix 第四单 QA）：被测对象是运行时副本
  // （~/.dsh/profiles/desktop/node_modules/dsh-armory/lib/，DSH 重启后实际加载的版本），
  // 开工先做 SHA256 哈希预检（不符即中止，防并行会话中间态）。钉住三件事：
  // ① probeServerAuthorization 状态码判定（401/403 throw 且错误含 server 名与 URL，
  //   200/500 放行，stdio/无 url skipped 放行，mcp.json headers 透传，本地 node:http 零外网）；
  // ② probeMcpServersAuthorization 任一 401 整体中止 / 全放行返回 {ok:true,checked:n}；
  // ③ wbConnectorCatalog 在真实 316 条索引上：95 条 auth_mode 非空全不可装且 blockedReason
  //   非空，tec-do（漏标鉴权裸 URL）仍 installable=true；运行时 lib/index.js 装链里探测
  //   位于 wbConnectorPreview 之后、json 组装之前（静态针）。8 秒真实超时按规约 SKIP。
  { name: "auth-gate-regression（市场安装鉴权闸 + 装前 401 探测）", file: "auth-gate-regression.mjs" },
  // T05 收尾：把现有两道护栏的盲区补上——(1) 装饰器声明了但方法体没写、
  // (2) import 了却从未调用、(3) 上一个函数少闭合 } 导致下一个声明被嵌进它体内。
  // 这三类 node --check 与 contract-consistency 都抓不到，本期各出过一次真事故。
  { name: "wb-install-flow（T04：令牌替换写链 + 安装状态账本 + 三盲区静态守卫）", file: "wb-install-flow.mjs" },
  // P0「装好了却用不了」（2026-10-29，用户报 ima / 腾讯自选股）：两条互相独立的说谎——
  // ① 安装账本无条件登记，同名被跳过、一个 server 都没写进去也带「已安装」徽标；
  // ② 401/403 被并进「连接失败」，用户反复重连也救不回来。
  // 本套件从 client.js 抽出 connectorHealth/connectorBadge 真跑真值表（含「没搜到同名行
  // 不得冒充未连接」这条反例），并钉宿主安装闸顺序（wrote → 0 判定 → 登记）、卡片重连/
  // 重新授权出口、详情授权状态与刷新链路、账号授权型降级「仅展示」+ 手填令牌逃生口。
  // 零网络零写盘；安装闸检查器配「旧写法必须变红」的反向自测。
  { name: "connector-auth-health（P0：连接器真实连接态 / 安装闸 / 授权状态）", file: "connector-auth-health.mjs" },
  // ── T01 awesome 市场数据层（纯新增零网络真实依赖：mock fetch 替换 + mkdtemp 隔离）──
  // 钉 R11 过滤口径（verified∧npm 交集）、瘦身字段形状、畸形行防御、原子写、
  // 304 复用不重写、双源切换、全源失败 stale 回落与体积 ≤3MB 断言。
  { name: "wb-awesome-market（T01：awesome 数据层过滤/瘦身/缓存/304/双源切换）", file: "wb-awesome-market.mjs" },
  // ── 社区 MCP（官方 MCP Registry v0，2026-10-30）──
  // 连接器页新增的第二个来源。钉的是照真实条目映射：参数顺序（-y 必须在包名前）、
  // oci 丢弃、只有 remotes → http/需令牌、env 的 isRequired/isSecret/default、
  // serverName 净化与冲突后缀、URL 编码与 limit 钳制、失败只收敛成 {ok:false}、
  // 4xx 不重试 / 网络错误重试一次、内存缓存命中与 TTL。零真实网络（fetchImpl 替身）。
  { name: "mcp-community（社区 MCP 数据层：映射/过滤/游标/缓存/失败收敛）", file: "mcp-community.mjs" },
  // 社区列表的翻页语义（2026-10-30 用户要求由「加载更多」改为点下一页才加载）：
  // 数量显示本次查询已读取的总数（跨页累计去重）、页内容互斥、游标栈回退、换词归零。
  // 抽 loadCommunity 源码进 vm 真跑三页数据，第 4 节把旧「追加」语义注回做反向自测。
  { name: "community-pager（社区 MCP：已读取总数 / 下一页才加载 / 游标栈）", file: "community-pager.mjs" },
  // 社区徽标显示的全库总数（2026-10-30 用户要求：徽标改成列表总数并常驻，免得被当成一共只有这么多）：
  // 官方 Registry 不返回总数，只能逐页爬 → 数据层有界统计（块 3 页 / 会话预算 12 页）+ 客户端
  // localStorage 续爬 + 常驻徽标（未开爬「…」/ 没到底「N+」/ 到底精确值）。
  // 第 1 节真跑数据层翻页与失败收敛，第 2 节把 client.js 徽标一节抽进 vm 执行，第 5 节反向自测。
  { name: "community-count（社区 MCP 全库总数：有界续爬 / 常驻徽标 / 口径一致）", file: "community-count.mjs" },
  // 社区卡片点开的详情弹层（2026-10-30 用户要求仿插件页）：
  // 整卡 role=button + Enter/Space、操作区阻止冒泡、遮罩/Esc/焦点陷阱、command+args 与
  // env 明细只读展示、先关详情再开「加入 MCP」草稿。纯静态断言 + 4 条反向自测。
  { name: "community-detail（社区 MCP 卡片详情弹层：可点 / 焦点 / 字段 / 动作）", file: "community-detail.mjs" },
  // ── T01 社区元信息（GitHub 公开接口：仓库活跃度/维护者）──
  // 详情页「这个人还在维护吗」的唯一数据源。钉仓库写法解析、最多 8 条、6 小时缓存
  // 命中不联网、refresh+ETag 的 304 复用、404 文案、网络失败 stale 回落、403 限流
  // 跨调用生效、原子写。fetchImpl 全替身 + mkdtemp 隔离，零真实网络与真实 ~/.dsh。
  { name: "community-meta（GitHub 仓库元信息：缓存/304/限流/stale 回落）", file: "community-meta.mjs" },
  // ── 插件卡底栏「↓N」的数据层（npm 公开统计，唯一真源）──
  // 钉的是诚实性而不是取数：404 / 响应无数字 → missing 且结果里根本没有 downloads
  // （绝不用 0 冒充「没人下载」）；失败回落 stale 不许把数字打没；429 写冷却、冷却期内
  // 零外网；7 天缓存命中不联网；并发封顶 4；原子写无 .staging 残留。含行为级反向自测。
  { name: "npm-downloads（npm 近 30 天下载量：missing 不造 0/stale/冷却/并发封顶）", file: "npm-downloads.mjs" },
  // ── 顶栏「点 Star」（community-meta 的客户端消费方）──
  // 三条容易被顺手改坏的线：(1) 诚实性——GitHub 不支持匿名 star，界面里不许出现本地
  // 「已 star」态，也不许在数字读不到时显示一个 ★ 0；(2) 数字只走既有 wbRepoMeta，
  // 不为 star 新增契约方法、不在浏览器绕过宿主缓存直连 api.github.com；(3) ARIA——
  // chip 必须是 role=tablist 的兄弟而不是子节点。做法同 client-i18n：抽 lib/client.js
  // 的社区信号一节进 node:vm，配最小 hook 垫片**真渲染**，对元素树断言；锚点找不到即失败。
  { name: "repo-star-chip（顶栏点 Star：诚实性/上游取数/tablist 兄弟位）", file: "repo-star-chip.mjs" },
  // ── 装备清单（导出 / 导入对比）──
  // 纯数据层，零网络零磁盘。核心不是 happy path，而是「什么**不能**进清单」：
  // env / header / token / url 值与技能正文、专家人设必须被投影层丢掉；导入只算
  // installed / update / missing 三态，不做任何写操作。另钉同名不同 kind 不得误匹配、
  // 版本缺失不得误判 update、200 条上限与 Windows 文件名净化。
  { name: "loadout（装备清单：字段白名单/差异三态/体积与条数上限）", file: "loadout.mjs" },
  // ── 安装浮层（顶部轻提示）──
  // 守两件事：(1) 浮层节点挂在 document.body 的模块级单例上，面板卸载/切标签页后
  // 进度仍然可见（挂回组件子树就退化成「切窗口就没了」）；(2) 结果态 4.2s 后自己
  // 收起、行数封顶 3、同一插件不许并发重复装（isInstallRunning 供按钮禁用）。
  // 做法是从 lib/client.js 抽浮层一节的源码放进 node:vm 真跑，配最小 DOM 替身，
  // 起止标记找不到直接失败，避免悄悄测个空。
  { name: "install-toast（顶部安装浮层：跨卸载可见 + 自动淡出 + 防重复安装）", file: "install-toast.mjs" },
  // ── 市场插件 README 预览 ──
  // 守三件事：(1) parseGithubRepo 十种仓库写法口径；(2) wbAwesomeReadme 无来源时零请求快速失败；
  // (3) 客户端 Markdown 渲染器结构 + 安全边界——javascript: 伪链接必须降级成纯文本
  // （new URL('javascript:x', base) 会解析成功，只校验 base 拼接就会放行），且全程不碰
  // dangerouslySetInnerHTML。渲染器同样从 lib/client.js 整节抽源码进 node:vm 真跑。
  { name: "awesome-readme（README 预览：仓库解析 + 渲染器结构 + 伪链接拦截）", file: "awesome-readme.mjs" },
  // ── 市场「最近动静」快照对比 ──
  // 用户报「切换页面重新进入时重复读取」：每次进市场，最近动静就多一对「SkillHub 新增 20 /
  // 移除 20」。根因是技能侧把 SkillHub「下载量（本页排序）」首页当成了稳定目录——那一档不给
  // 上游发 sortBy，无 ORDER BY 的 LIMIT 20 每次返回随机 20 条（实测重合 0/20）。修复分三层：
  // basis（同一份清单才互比）+ 重合度闸门（全增全删一律静默换基线）+ 存储升 v2（丢弃 v1 脏数据）。
  // 切片抽进 vm 真跑，第 5 节把 v1 语义注回同一份切片做反向自测。零网络零写盘。
  { name: "market-pulse（最近动静：basis 可比性 / 重合度闸门 / v1 脏数据丢弃）", file: "market-pulse.mjs" },
  // ── SkillHub 技能链路（issue #4，2026-10-26）──
  // 数据层：详情接口把本体放在 skill 子对象（displayName / summary_zh），根层没有 name /
  // description / homepage；列表 homepage 又是 api.skillhub.cn 的 JSON 地址（浏览器 405）。
  // 这个套件真调 wbSkillCatalog / wbSkillDetail（fetch 替身），钉住映射、回退链与公开页归一。
  { name: "skillhub-detail-fix（技能详情映射：skill 子对象 / 公开页 / 回退链）", file: "skillhub-detail-fix.mjs" },
  // 面板侧：空字符串回包不得覆盖列表里已有的中文名与介绍；api.skillhub.cn 不得作为
  // 「来源主页」直出；悬浮按钮可右键/长按隐藏（保留其它入口）且看板页打开时自动收起。
  // 纯函数抽进 vm 真跑，另配接线源码针与反向自测。零网络零写盘。
  { name: "skillhub-ux-fix（详情空值合并 / 主页过滤 / 悬浮按钮隐藏与自动收起）", file: "skillhub-ux-fix.mjs" },
  // ── 市场页头像加载 ──
  // 全部卡片头像的唯一来源是 github.com/<login>.png，本机整段不通（跟完整重定向链实测 14.7 秒、
  // 单发 10.7 秒抛 fetch failed）；旧写法把 src 直接交给 <img>，于是首页 50 张卡发 100 个请求
  // （41 个不同 owner，重复一半），而「报错之前一直算加载中」—— Chromium 单 host 约 6 条连接
  // 被 10 秒级挂起占满，用户看到的是 CSS 给 <img> 画的空灰圈，onError 的 visibility:hidden 根本
  // 没机会触发。修法四层：① 请求与显示拆开（首帧字母、后台 new Image() 探、同 URL 本次会话至多
  // 一次且失败粘住、迟到的成功仍采纳）；② 取图走 wsrv.nl 代理 + images.weserv.nl 备胎的**有序
  // 路由**，4 秒超时从真正发出那刻起算，主域挂了换备胎并重新起表；③ 在途闸门只放 3 条（README
  // 插图走同一个域名，不能挤死），其余按挂载顺序排队；④ 视口门：离视口 200px 以外根本不进队列
  // （照 dshmarket 的 useNearViewport / CardShot 的口径，比闸门更根本——闸门只是排队）。
  // 手法同 repo-star-chip：抽 lib/client.js 社区信号一节进 node:vm，配**带依赖比较**的 hook
  // 垫片真渲染；Image 与 IntersectionObserver 都是替身、时钟手动推进（超时这条路径要能确定性
  // 复现，不能让测试睡 4 秒）。第 12 节把 21 条旧语义分别注回同一份切片做反向自测。零真实网络。
  { name: "market-avatar（头像：首帧字母 / 代理有序路由 / 4s 超时从发出起算 / 在途闸门 / 视口门 / 封顶）", file: "market-avatar.mjs" },
  // ── Skill 看板与已召唤专家页的头像位 ──
  // 本地 skill 无图标字段：头像只能按名字哈希**生成**（SkillAvatar，零网络零登记）；
  // 已召唤专家预设行自带 avatarUrl（readExpertDisplayNames 随 `...info` 展开）。
  // 钉住：SkillAvatar 确定性 / 不触网 / 三处头像位；专家页四处头像位与数据链；
  // CSS 配套。手法同 install-toast：SkillAvatar 抽源码进 vm 真渲染，其余源码针。零真实网络。
  { name: "skill-expert-avatar（Skill/专家页头像位：生成头像与 avatarUrl 数据链）", file: "skill-expert-avatar.mjs" },
  // ── 市场缓存回落路径（2026-10-24 修复组）──
  // 专家目录（expert-market.loadManifest）与连接器 ZIP（wb-market.loadConnectorZip）：
  // 旧实现在「磁盘缓存损坏 + 上游 304」时对 null 取 buffer 崩成死循环、断网时把已验证
  // 可用的磁盘缓存一并丢弃（与头注承诺相反）、ETag 路径的 200 响应不做结构校验就覆盖
  // 好缓存。修复后：只有磁盘缓存有效才带 If-None-Match；304 / 断网 / 坏结构都回落磁盘；
  // 网络数据先校验再原子落盘；projectExpert 透出清单的 promptFile。隔离：
  // DSH_ARMORY_MARKET_HOME + DSH_ARMORY_HOME 两个临时目录 + fetch 全替身，零真实网络。
  { name: "market-cache-fallback（市场缓存回落：304 死路 / 断网回落 / 结构校验 / 原子写）", file: "market-cache-fallback.mjs" },
  // style 字符串 = Minified React error #62（渲染期炸整面板）：授权弹窗警示行在
  // 「安装需 OAuth 的连接器 + 浏览器没自动打开」这条路上必崩（2026-10-24 实测）。
  // 词法守卫 client.js 无字符串 style + 修复点对象形态 + opened=false 补发 wbOAuthOpen。
  { name: "no-string-style（style 不得传字符串 / React #62）", file: "no-string-style.mjs" },
  // 系统打开器（issue #7）：headless 主机没有 xdg-open，`spawn(...).unref()` 无 error 监听
  // 会把 ENOENT 升级成 uncaughtException，点「安装」授权连接器即带走宿主进程（全 API 502）。
  // 静态钉「index.js 不再裸 spawn」+ 真跑 launchDetached + 子进程反向自测（旧写法必须崩）。
  { name: "system-open-spawn-guard（系统打开器：headless 缺 xdg-open 不得拖走进程）", file: "system-open-spawn-guard.mjs" },
  // 市场加载性能（docs/perf-market-load.md）：这批改动「变快但功能不变」，原有功能用例
  // 一条也拦不住回退——缓存被删、200ms 防抖被抹成直发、快照被当成永久有效，功能断言照样全绿。
  // 五段行为用 vm 抽源码真跑（hover 防抖/单条/取消/TTL、技能 SWR、连接器快照时效与体积预算、
  // 计数缓存不负缓存、账本缓存的 days 收敛/并发去重/refresh 旁路/失败不缓存），每段配把旧写法
  // 注回去的反向自测；接线层用源码针钉懒加载、首屏门控、空闲帧写盘与三类卡片挂载点。零网络零写盘。
  { name: "perf-market-load（P0-P2：懒加载/快照/SWR/账本缓存/hover 预取）", file: "perf-market-load.mjs" },
  // 2026-10-30 评审修复的客户端 / 接线护栏：revealSkill 只信宿主路径、社区链接只渲染
  // https、详情迟到回包作废、重连看 ok、adopted / 替身提示、社区懒加载守卫。每条都配
  // 反向自测（把旧写法注回去），防止断言空转。
  { name: "client-guards（评审修复：路径信任 / 链接协议 / 竞态 / 重连 / 人设提示）", file: "client-guards.mjs" },
  // Windows 上裸 npx 是 .cmd 壳，宿主 spawn(shell:false) 直接 ENOENT → 社区 MCP 全数「连接失败」。
  // 钉住归一层与其在唯一写入边界（normalizeEntry）上的接线：平台闸门、幂等、表达式/绝对路径放行、
  // 不覆盖用户缓存键、探测不到 Node 时宁可不改，全部配反向自测。
  { name: "win32-stdio-launch（win32 stdio 启动器归一 + 写入边界接线）", file: "win32-stdio-launch.mjs" },
];

let failed = 0;
for (const suite of SUITES) {
  console.log(`\n=== ${suite.name} ===`);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, suite.file)], { stdio: "inherit", cwd: join(here, "..") });
    child.on("close", resolve);
    child.on("error", () => resolve(1));
  });
  if (code !== 0) failed += 1;
}

console.log(`\n${failed === 0 ? "ALL SUITES PASS" : failed + " SUITE(S) FAILED"}`);
process.exitCode = failed === 0 ? 0 : 1;
