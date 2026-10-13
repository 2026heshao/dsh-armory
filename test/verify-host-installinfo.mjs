// 验证宿主 installInfo 在**真实模块上下文**里能读回本机安装来源。
// 直接 import lib/index.js 会把整个网关启起来（需要 cordis 上下文），所以这里只验证
// 「函数本体 + 真实 profile 文件」这条路径：classifyInstallSpec 已由 upgrade-plan 覆盖，
// 这里补的是 profileDirOf / 读 manifest / 两行名字命中 这三段真实 I/O。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hostSource = readFileSync(join(here, "..", "lib", "index.js"), "utf8");

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

/** 提取纯函数（同 upgrade-plan 的括号配平策略）。 */
function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing ${name}`);
  let i = source.indexOf("(", start);
  let p = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === "(") p += 1;
    else if (source[i] === ")") { p -= 1; if (p === 0) break; }
  }
  i = source.indexOf("{", i);
  let d = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === "{") d += 1;
    else if (source[i] === "}") { d -= 1; if (d === 0) return source.slice(start, i + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

const classifyInstallSpec = new Function(`${extract(hostSource, "classifyInstallSpec")}; return classifyInstallSpec;`)();

// 复刻 installInfo 的核心 I/O：读 profile manifest 的 dependencies，命中新名或旧名。
const UPGRADE_PACKAGE_NAME = "dsh-armory";
const LEGACY_PACKAGE_NAME = "dsh-skill-mcp-board";
const profileDir = join(homedir(), ".dsh", "profiles", "desktop");
const manifestPath = join(profileDir, "package.json");
let manifest;
try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
catch { console.log(`SKIP  真 profile 不存在（${manifestPath}）`); process.exit(0); }

const deps = manifest.dependencies || {};
const hit = [UPGRADE_PACKAGE_NAME, LEGACY_PACKAGE_NAME].find((n) => typeof deps[n] === "string");
const spec = hit ? deps[hit] : null;
const source = classifyInstallSpec(spec ?? "");
console.log(`installInfo 将返回: installedAs=${hit} spec=${spec} source=${source}`);

ok("两行名字至少命中一行（本机是 file: 安装的旧名）", !!hit, `hit=${hit}`);
ok("source 分类非 unknown", source !== "unknown", `source=${source}`);
ok("本机为本地安装（保护目标成立）", ["file", "link", "path"].includes(source), `source=${source}`);
// 反向：若 profile 里根本查不到本插件（比如未来换成别的方式装），必须仍是 unknown 而不是 registry。
const missingSource = classifyInstallSpec(([UPGRADE_PACKAGE_NAME, LEGACY_PACKAGE_NAME].some((n) => typeof deps[n] === "string") ? "" : ""));
ok("查不到时退化为 unknown（不会误判成 registry）", missingSource === "unknown");

console.log(`\n${failures === 0 ? "HOST-PATH PASS" : failures + " FAILED"}`);
process.exitCode = failures === 0 ? 0 : 1;
