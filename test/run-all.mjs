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
  { name: "i18n-coverage（en-US 字典覆盖率与 locale 三级回落）", file: "i18n-coverage.mjs" },
  // persona 4000 预览阈值（清单 3.2）：两处详情弹层都走常量、无散落硬编码、展开/收起双向。
  { name: "persona-truncate（persona 预览截断阈值）", file: "persona-truncate.mjs" },
  // 工具裁缝时间窗（清单 4.1）：新增「今日」档不得改变默认 30 天 —— 改了会让报告数字骤降。
  { name: "tailor-window（工具裁缝时间窗四档与默认值）", file: "tailor-window.mjs" },
  // 崩溃详情可复制（清单 6.1）：真跑边界组件，钉住 componentStack 入剪贴板与 retry 清 info。
  { name: "error-boundary-copy（崩溃详情可复制）", file: "error-boundary-copy.mjs" },
  // teardown 残留诊断（清单 2.4）：live/final 两种读法 + 超龄不送 + 记录表裁剪，真跑函数。
  { name: "teardown-residue（teardown 残留诊断）", file: "teardown-residue.mjs" },
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
  // ── T01 共享数据层（多市场注册表 / 安装状态 / 认证注入规则）───────────────
  // 三个模块只用本机内置模块、零网络、零真实 ~/.dsh（隔离靠 mkdtemp + rootDir 注入），
  // 注册表还把「内置 connectors 源 URL 与 lib/wb-market.js 现值一致」钉进了用例。
  { name: "wb-registry（多市场注册表：默认回落/合并投影/原子写）", file: "wb-registry.mjs" },
  { name: "wb-install-state（安装状态与来源锁）", file: "wb-install-state.mjs" },
  { name: "wb-auth-rules（认证注入规则与令牌槽扫描）", file: "wb-auth-rules.mjs" },
  // ── T02 连接器元数据投影 / T03 插件市场投影 ──────────────────────────────
  // 两者都是纯解析层守护：零网络（T03 的 zip 用手工字节内存构造）、零真实 ~/.dsh。
  // T02 钉 R1 注入规则标注 / R2 visible_in 标签筛选 / R3 examples 优先；
  // T03 钉 marketplace.json 嵌套解析、plugin.json 提取、dependencies 防御。
  { name: "wb-connector-meta（连接器 R1/R2/R3 投影：注入规则/标签筛选/examples）", file: "wb-connector-meta.mjs" },
  { name: "wb-plugin-market（插件市场 R5/R6：嵌套清单解析/依赖防御/投影）", file: "wb-plugin-market.mjs" },
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
  // R9 更新探测五枚举（no-source/probe-failed/no-cache/up-to-date/update-available）
  // + 「只探测不落盘」安全边界 + UI 侧 reason 映射与状态名不冲突。
  { name: "wb-update-hint（T05：R9 ETag 更新探测五枚举 + UI reason 契约 + 无定时器）", file: "wb-update-hint.mjs" },
  // ── T01 awesome 市场数据层（纯新增零网络真实依赖：mock fetch 替换 + mkdtemp 隔离）──
  // 钉 R11 过滤口径（verified∧npm 交集）、瘦身字段形状、畸形行防御、原子写、
  // 304 复用不重写、双源切换、全源失败 stale 回落与体积 ≤3MB 断言。
  { name: "wb-awesome-market（T01：awesome 数据层过滤/瘦身/缓存/304/双源切换）", file: "wb-awesome-market.mjs" },
  // ── 安装浮层（顶部轻提示）──
  // 守两件事：(1) 浮层节点挂在 document.body 的模块级单例上，面板卸载/切标签页后
  // 进度仍然可见（挂回组件子树就退化成「切窗口就没了」）；(2) 结果态 4.2s 后自己
  // 收起、行数封顶 3、同一插件不许并发重复装（isInstallRunning 供按钮禁用）。
  // 做法是从 lib/client.js 抽浮层一节的源码放进 node:vm 真跑，配最小 DOM 替身，
  // 起止标记找不到直接失败，避免悄悄测个空。
  { name: "install-toast（顶部安装浮层：跨卸载可见 + 自动淡出 + 防重复安装）", file: "install-toast.mjs" },
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
