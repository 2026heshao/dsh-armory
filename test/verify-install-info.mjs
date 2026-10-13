// 真机验证：用**真实 profile manifest** 跑安装来源分类，证明判定链路对真数据成立。
// 这是「一键升级会不会毁掉用户本地副本」的最终判据——不是替身输入，是真文件。
// 用法：node ./test/verify-install-info.mjs
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hostSource = readFileSync(join(here, "..", "lib", "index.js"), "utf8");
const clientSource = readFileSync(join(here, "..", "lib", "client.js"), "utf8");

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

/** 括号配平摘函数（从参数表之后找函数体，兼容解构参数）。 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  let i = source.indexOf("(", start);
  let paren = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === "(") paren += 1;
    else if (source[i] === ")") { paren -= 1; if (paren === 0) break; }
  }
  i = source.indexOf("{", i);
  let depth = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") { depth -= 1; if (depth === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

const classifyInstallSpec = new Function(`${extractFunction(hostSource, "classifyInstallSpec")}; return classifyInstallSpec;`)();
const UPGRADE_METHOD = "installBundle";
const UPGRADE_PACKAGE = "dsh-armory";
const upgradePlan = new Function("UPGRADE_METHOD", "UPGRADE_PACKAGE",
  `${extractFunction(clientSource, "upgradePlan")}; return upgradePlan;`)(UPGRADE_METHOD, UPGRADE_PACKAGE);

// ── 真实 profile manifest ────────────────────────────────────────────
// 别的机器 / CI 上没有 desktop profile：记 SKIP 退出 0（跑不出结论 ≠ 失败）。
const manifestPath = join(homedir(), ".dsh", "profiles", "desktop", "package.json");
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch {
  console.log(`SKIP  真 profile 不存在（${manifestPath}）——本文件只在开发机上有结论`);
  process.exit(0);
}
const deps = manifest.dependencies || {};
const names = ["dsh-armory", "dsh-skill-mcp-board"];
const hit = names.find((name) => typeof deps[name] === "string");
console.log(`profile: ${manifestPath}`);
console.log(`本插件依赖行: ${hit ? hit + ' = ' + deps[hit] : "（两行都没有）"}`);

const spec = hit ? deps[hit] : null;
const source = classifyInstallSpec(spec ?? "");
console.log(`宿主分类结果: spec=${JSON.stringify(spec)} source=${source}`);

// 这台机器是 file: 安装（本地开发副本）——判定必须是「不可一键升级」，
// 否则 installBundle 的 `pnpm add dsh-armory@^x` 会把开发副本换成 npm 包。
ok("本机真实 spec 被识别为本地安装", source === "file" || source === "link" || source === "path", `source=${source}`);
const plan = upgradePlan({
  service: { installBundle: async () => ({ ok: true }) },
  hint: { current: "1.9.0", latest: "1.9.1", updateAvailable: true },
  bundle: { name: UPGRADE_PACKAGE, version: "1.9.0", enabled: true, installed: true, optional: false, removable: true },
  spec,
  source,
});
ok("真实数据下一键升级被拒（保护本地副本）", plan.supported === false && plan.reason === "not-npm", JSON.stringify(plan));

// ── 反例：同一套逻辑对 registry 安装必须放行（证明不是「恒拒绝」）────────
const regPlan = upgradePlan({
  service: { installBundle: async () => ({ ok: true }) },
  hint: { current: "1.9.0", latest: "1.9.1", updateAvailable: true },
  bundle: { name: UPGRADE_PACKAGE, version: "1.9.0", enabled: true, installed: true, optional: false, removable: true },
  spec: "^1.9.0",
  source: "registry",
});
ok("对照：registry 安装放行", regPlan.supported === true && regPlan.spec === "dsh-armory@^1.9.1", JSON.stringify(regPlan));

console.log(`\n${failures === 0 ? "REAL-PATH PASS" : failures + " FAILED"}`);
process.exitCode = failures === 0 ? 0 : 1;
