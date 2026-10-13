// 升级判定回归（纯函数，无网无宿主）：
//   1. classifyInstallSpec —— 宿主侧 spec 分类（真源是 profile manifest 的 dependencies）
//   2. upgradePlan —— 客户端「一键升级」安全判据
//
// 为什么必须有这组用例：宿主 listBundles() 的行里**没有 source 字段**，旧实现拿
// bundle.source 判来源恒判「npm 装的」；而 installBundle 执行 `pnpm add <spec>`，
// 本地 file:/link: 安装的用户一点就把开发副本换成了 npm 包（不可逆的用户环境破坏）。
// 这里把「本地安装一律不可一键升」钉成断言。
//
// 用例在 node 里直接跑：node ./test/upgrade-plan.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const clientSource = readFileSync(join(here, "..", "lib", "client.js"), "utf8");
const hostSource = readFileSync(join(here, "..", "lib", "index.js"), "utf8");

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

/** 从源码里摘出某个函数的定义并求值（两处都是纯函数，无闭包依赖）。
 *  括号配平必须从**参数表之后**的 `{` 开始：参数是解构（`{ service, hint }`）时，
 *  直接找第一个 `{` 会停在解构括号上，摘出的片段缺函数体（摘到 `);` 就断了）。 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  // 先配平参数表，找到它的结束 `)`，之后的第一个 `{` 才是函数体。
  let i = source.indexOf("(", start);
  let paren = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === "(") paren += 1;
    else if (source[i] === ")") {
      paren -= 1;
      if (paren === 0) break;
    }
  }
  i = source.indexOf("{", i);
  const bodyStart = i;
  let depth = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${name} (body from ${bodyStart})`);
}

// client.js 里的 upgradePlan 依赖模块级常量，一并求值。
const UPGRADE_METHOD = "installBundle";
const UPGRADE_PACKAGE = "dsh-armory";
const upgradePlan = new Function(
  "UPGRADE_METHOD", "UPGRADE_PACKAGE",
  `${extractFunction(clientSource, "upgradePlan")}; return upgradePlan;`,
)(UPGRADE_METHOD, UPGRADE_PACKAGE);
const classifyInstallSpec = new Function(
  `${extractFunction(hostSource, "classifyInstallSpec")}; return classifyInstallSpec;`,
)();

const service = { installBundle: async () => ({ ok: true }) };
const hintNew = { current: "1.9.0", latest: "1.9.1", updateAvailable: true };

// ── 1. 宿主侧 spec 分类 ──────────────────────────────────────────────
ok("classify file:", classifyInstallSpec("file:D:/x/y") === "file");
ok("classify link:", classifyInstallSpec("link:../y") === "link");
ok("classify portal:", classifyInstallSpec("portal:../y") === "file");
ok("classify caret range", classifyInstallSpec("^1.9.0") === "registry");
ok("classify tilde range", classifyInstallSpec("~1.9.0") === "registry");
ok("classify exact", classifyInstallSpec("1.9.0") === "registry");
ok("classify latest", classifyInstallSpec("latest") === "registry");
ok("classify star", classifyInstallSpec("*") === "registry");
ok("classify github", classifyInstallSpec("github:u/r#v1") === "git");
ok("classify git+https", classifyInstallSpec("git+https://x/y.git") === "git");
ok("classify https tarball", classifyInstallSpec("https://x/y.tgz") === "remote");
ok("classify win path", classifyInstallSpec("D:\\x\\y") === "path");
ok("classify posix path", classifyInstallSpec("/x/y") === "path");
ok("classify relative path", classifyInstallSpec("./x") === "path");
ok("classify empty = unknown", classifyInstallSpec("") === "unknown");
ok("classify garbage = unknown", classifyInstallSpec("!!!") === "unknown");

// ── 2. upgradePlan：本地安装必须一律不可一键升 ────────────────────────
const localSources = ["file", "link", "git", "remote", "path"];
for (const source of localSources) {
  const plan = upgradePlan({ service, hint: hintNew, bundle: { name: UPGRADE_PACKAGE }, spec: "file:D:/x", source });
  ok(`local source blocked: ${source}`, plan.supported === false && plan.reason === "not-npm", JSON.stringify(plan));
}
// spec 像本地但宿主分类说 registry：两处独立判据取更保守一侧（spec 前缀必须也像 registry）。
ok("mismatched spec blocked", upgradePlan({ service, hint: hintNew, bundle: null, spec: "file:D:/x", source: "registry" }).supported === false);

// ── 3. upgradePlan：registry 安装可一键升，spec 形态正确 ───────────────
for (const spec of ["^1.9.0", "~1.9.0", "1.9.0", "latest", "*", ""]) {
  const plan = upgradePlan({ service, hint: hintNew, bundle: { name: UPGRADE_PACKAGE }, spec, source: "registry" });
  ok(`registry spec allowed: ${JSON.stringify(spec)}`, plan.supported === true && plan.spec === "dsh-armory@^1.9.1", JSON.stringify(plan));
}

// ── 4. upgradePlan：其余分支 ─────────────────────────────────────────
ok("no service blocked", upgradePlan({ service: null, hint: hintNew, bundle: null, spec: "^1.9.0", source: "registry" }).reason === "no-service");
ok("up-to-date blocked", upgradePlan({ service, hint: { current: "1.9.1", latest: "1.9.1", updateAvailable: false }, bundle: null, spec: "^1.9.0", source: "registry" }).reason === "up-to-date");
ok("missing hint blocked", upgradePlan({ service, hint: null, bundle: null, spec: "^1.9.0", source: "registry" }).reason === "up-to-date");
ok("target version carried", upgradePlan({ service, hint: hintNew, bundle: null, spec: "^1.9.0", source: "registry" }).version === "1.9.1");

// ── 5. 未知来源一律不做写操作（P0 安全边界）───────────────────────────
// 新客户端 + 旧宿主（installInfo 尚未上线）时 source 缺失；宁可少一个按钮，
// 也不能让 `pnpm add` 覆盖掉用户的本地安装。
ok("missing source blocked", upgradePlan({ service, hint: hintNew, bundle: null, spec: "^1.9.0", source: null }).supported === false);
ok("unknown source blocked", upgradePlan({ service, hint: hintNew, bundle: null, spec: "^1.9.0", source: "unknown" }).reason === "unknown-source");
ok("null spec + unknown source blocked", upgradePlan({ service, hint: hintNew, bundle: null, spec: null, source: null }).supported === false);

// ── 6. 死代码回归：bundle.source 缺失时不能误判为可升级 ────────────────
// 宿主 listBundles() 的真实行形状（无 source 字段）+ 本地 spec → 必须 blocked。
const realBundleShape = { name: UPGRADE_PACKAGE, version: "1.9.0", enabled: true, installed: true, optional: false, removable: true };
ok("real bundle shape + local spec blocked",
  upgradePlan({ service, hint: hintNew, bundle: realBundleShape, spec: "file:D:/x", source: "file" }).supported === false);
ok("real bundle shape + registry spec allowed",
  upgradePlan({ service, hint: hintNew, bundle: realBundleShape, spec: "^1.9.0", source: "registry" }).supported === true);
// 旧实现只看 bundle.source（该字段不存在）→ 恒 true；这条断言证明该缺陷不会再回来。
ok("no longer trusts bundle.source alone",
  upgradePlan({ service, hint: hintNew, bundle: realBundleShape, spec: null, source: null }).supported === false);
// 宿主将来若补上 bundle.source 且它像本地来源 → 即便 installInfo 说 registry 也否决。
ok("future bundle.source still conservatively honored",
  upgradePlan({ service, hint: hintNew, bundle: { ...realBundleShape, source: "file:../x" }, spec: "^1.9.0", source: "registry" }).supported === false);

// ── 7. 契约三处同步（Host method / typert / client descriptor）────────
ok("host installInfo method exists", /async installInfo\s*\(/.test(hostSource));
ok("typert installInfo invocation exists", /mv\('installInfo'/.test(readFileSync(join(here, "..", "lib", "typert.js"), "utf8")));
ok("client installInfo descriptor exists", /method:\s*'installInfo'/.test(clientSource));

// ── 8. 发版契约（lib/whats-new.js 的维护约定，钉成断言）────────────────
// whats-new.js 的注释写着「package.json 的版本必须是这里的最后一条」，但原来说是靠
// test/whats-new.test.mjs 钉住，而那个文件并不存在——约定形同虚设。这里补上：
// bump 了版本却没写「这次改了什么」，本地与 CI 都会红（发版前就拦下）。
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const whatsNewSource = readFileSync(join(here, "..", "lib", "whats-new.js"), "utf8");
const versions = [...whatsNewSource.matchAll(/version:\s*'([^']+)'/g)].map((m) => m[1]);
ok("whats-new 非空", versions.length > 0, `${versions.length} 条`);
ok("package.json 版本 = whats-new 最后一条", versions[versions.length - 1] === pkg.version, `pkg=${pkg.version} last=${versions[versions.length - 1]}`);
// release notes 稿子必须存在（release.yml 会校验，本地同一条门槛先拦一次）。
const notesPath = join(here, "..", ".github", "release-notes", `v${pkg.version}.md`);
let notesOk = true;
try { readFileSync(notesPath, "utf8"); } catch { notesOk = false; }
ok(`release notes 稿存在（v${pkg.version}.md）`, notesOk, notesPath);

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exitCode = failures === 0 ? 0 : 1;
