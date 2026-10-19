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
