// README 配图守护（护栏）：防止「README 配图被旧副本覆盖」再次发生。
//
// 背景（v1.10.0 真实事故）：那次提交改 README 时以 1.8 时代的旧副本为准，把「界面预览」
// 整段覆盖回四张旧图（mcp-manager-*），1.9.4 新增的五页实拍从仓库树里一并消失。编译器、
// 既有测试、CI 全绿 —— 因为**没有一条断言关心 README 引用的是哪几张图**。
//
// 这里钉三条彼此独立的契约：
//   ① 引用可解析：中英 README 里每个 `docs/images/xxx` 都必须在仓库里真实存在；
//   ② 单一事实源：screenshots.json 必须与中文 README 的图片引用逐条一致（顺序也一致，
//      它按「界面预览」的展示顺序排列）；
//   ③ 不许死灰复燃：`mcp-manager-*` 这组 1.8 时代旧图名不得再被任何 README 引用。
//
// 只读仓库内文件，不联网、不写盘。用法：node ./test/readme-images.mjs
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

/** 读出某个文本里所有 `docs/images/<name>` 引用（去重前保序，用于顺序比对）。 */
function imageRefs(text) {
  const re = /docs\/images\/([A-Za-z0-9._-]+)/g;
  const out = [];
  for (const m of text.matchAll(re)) out.push(m[1]);
  return out;
}

function readOrFail(rel) {
  const abs = join(ROOT, rel);
  try {
    return readFileSync(abs, "utf8");
  } catch (cause) {
    ok(`${rel} 可读`, false, String(cause?.message ?? cause));
    return null;
  }
}

const zh = readOrFail("README.md");
const en = readOrFail("README.en.md");
const shotsRaw = readOrFail("screenshots.json");

// ── ① 引用可解析 ───────────────────────────────────────────────────────────
for (const [label, text] of [
  ["README.md", zh],
  ["README.en.md", en],
]) {
  if (text === null) continue;
  const refs = imageRefs(text);
  ok(`${label}：至少引用一张配图`, refs.length > 0, `实际 ${refs.length} 条`);
  const missing = refs.filter((n) => !existsSync(join(ROOT, "docs", "images", n)));
  ok(`${label}：每张引用的配图都真实存在`, missing.length === 0, missing.join(", "));
}

// ── ② screenshots.json 与中文 README 一致 ─────────────────────────────────
if (zh !== null && shotsRaw !== null) {
  let shots = null;
  try {
    shots = JSON.parse(shotsRaw);
  } catch (cause) {
    ok("screenshots.json 可解析为 JSON", false, String(cause?.message ?? cause));
  }
  if (Array.isArray(shots)) {
    const listed = shots.map((p) => String(p).replace(/^docs\/images\//, ""));
    const referenced = imageRefs(zh).filter((n, i, all) => all.indexOf(n) === i);
    ok(
      "screenshots.json 条目与 README.md 引用的配图集合一致",
      listed.length === referenced.length && listed.every((n) => referenced.includes(n)),
      `json=[${listed.join(", ")}] readme=[${referenced.join(", ")}]`,
    );
    ok(
      "screenshots.json 顺序与 README.md 首次出现顺序一致",
      listed.every((n, i) => n === referenced[i]),
    );
  } else if (shotsRaw !== null) {
    ok("screenshots.json 是数组", false);
  }
}

// ── ③ 1.8 时代旧图名不得复活 ──────────────────────────────────────────────
for (const [label, text] of [
  ["README.md", zh],
  ["README.en.md", en],
]) {
  if (text === null) continue;
  const stale = imageRefs(text).filter((n) => n.startsWith("mcp-manager-"));
  ok(`${label}：未回退到 1.8 时代旧图（mcp-manager-*）`, stale.length === 0, stale.join(", "));
}

console.log(failures === 0 ? "\nREADME IMAGES PASS" : `\n${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
