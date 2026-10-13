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
  { name: "expert-manual（专家市场写链）", file: "run-expert-manual.mjs" },
  { name: "upgrade-plan（一键升级判据）", file: "upgrade-plan.mjs" },
  { name: "session-persona（会话级专家随时挂/换/摘）", file: "session-persona.mjs" },
  // 真机验证：读真实 profile manifest，证明判定对真数据成立。profile 不存在时
  // 该文件会自行 SKIP（其它机器 / CI 上跑不出结论，但不会误报失败）。
  { name: "verify-install-info（真 profile 数据）", file: "verify-install-info.mjs" },
  { name: "verify-host-installinfo（宿主读取路径）", file: "verify-host-installinfo.mjs" },
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
