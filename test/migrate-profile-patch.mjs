// 一次性迁移：把 profile patch 里 1.9.0-1.9.1 缺陷格式写出的顶层裸预设行
// （宿主按 id-targeted override 解释 → warn 跳过 → 预设不注册 → 「Unknown agent preset」）
// 原位迁移为合法的 insert 指令。复用修复后的 writeExpertPreset（legacy 分支）。
// 用法：node --(runner) migrate-profile-patch.mjs [--write]
import { readFile, writeFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readExpertPresets, writeExpertPreset } from "../lib/expert-market.js";
import { parseDocument, isMap } from "yaml";

const patchPath = join(homedir(), ".dsh", "profiles", "desktop", "cordis.patch.yml");
const original = await readFile(patchPath, "utf8");

// 从旧裸行里提取召唤 spec（人设正文 / 展示名 / 描述），迁移后内容与旧行等价。
const doc = parseDocument(original);
let spec = null;
for (const item of doc.contents.items) {
  if (!isMap(item) || String(item.get?.("id") ?? "") !== "preset-wbexpert-senior-developer") continue;
  const config = item.get("config", true);
  const displayName = String(config.get?.("name") ?? "").replace(/^WorkBuddy 专家 · /, "") || "专家";
  const description = String(config.get?.("description") ?? "");
  const plugins = config.get?.("plugins", true);
  let personaText = "";
  for (const row of plugins?.items ?? []) {
    if (isMap(row) && row.get?.("id") === "persona") personaText = String(row.get?.("config", true).get?.("prefix") ?? "");
  }
  spec = { plugin: "senior-developer", displayName, profession: "", description, personaText };
  break;
}
if (!spec) {
  console.log("NO_LEGACY_ROW: patch 里没有顶层裸预设行，无需迁移");
  process.exit(0);
}
const written = writeExpertPreset(original, spec);
const rows = readExpertPresets(written.content);
console.log(`mode=${written.mode} readback=${JSON.stringify(rows)}`);
console.log("--- migrated head ---");
console.log(written.content.split("\n").slice(0, 14).join("\n"));

if (process.argv.includes("--write")) {
  if (rows.length !== 1 || !readExpertPresets(written.content).length) throw new Error("readback sanity failed; aborting write");
  // 同目录临时文件 + rename 原子替换（与宿主 writeFileAtomic 同款语义）。
  const temp = patchPath + "." + Math.random().toString(16).slice(2, 8) + ".tmp";
  await writeFile(temp, written.content, "utf8");
  await rename(temp, patchPath);
  const verify = await readFile(patchPath, "utf8");
  console.log("WROTE_OK: " + (verify === written.content));
} else {
  console.log("DRY_RUN: patch 未修改");
}
