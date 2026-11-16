// 配置组合验证：用历史宿主 app-boot 的 applyEntryPatches 转录组合根配置与用户 patch，
// 只确认专家预设行进入组合树，不检查包 exports、插件导入、依赖注入或预设成功挂载。
// applyEntryPatches 是纯函数（_research/app-boot-index.js L61-110 的历史转录）：
// id-targeted override 与 insert 两种指令，未命中 warn 跳过；不是当前宿主端到端执行。
// 入口回归见 expert-preset-entries.mjs；完整可用性仍需真实宿主验收。
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import yaml from "yaml";

// ── 宿主 applyEntryPatches 转录（_research/app-boot-index.js L61-110）──────
function warn() {}
function applyEntryPatches(data, patches) {
  if (!patches?.length) return [...data];
  data = structuredClone(data);
  const entryMap = new Map();
  const buildMap = (entries) => {
    for (const entry of entries) {
      if (entry.id) entryMap.set(entry.id, entry);
      if (entry.group && Array.isArray(entry.config)) buildMap(entry.config);
    }
  };
  buildMap(data);
  for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch;
    if (insert) {
      if (id) {
        const target = entryMap.get(id);
        if (!target) { warn("patch insert: entry %C not found", id); continue; }
        if (!target.group) { warn("patch insert: entry %C is not a group", id); continue; }
        if (!Array.isArray(target.config)) target.config = [];
        target.config.push(...insert);
      } else data.push(...insert);
      buildMap(insert);
      continue;
    }
    if (!id) { warn("patch: id is required for non-insert patches"); continue; }
    const target = entryMap.get(id);
    if (!target) { warn("patch: entry %C not found", id); continue; }
    if (name && name !== target.name) { warn("patch: name mismatch for %C"); continue; }
    for (const [key, value] of Object.entries(overrides)) {
      if (key === "id") continue;
      target[key] = value;
    }
  }
  return data;
}

// ── profile patch 层加载 + 组合 ───────────────────────────────────────────
const profileDir = join(homedir(), ".dsh", "profiles", "desktop");
const patchPath = join(profileDir, "cordis.patch.yml");
const userPatches = yaml.parse(readFileSync(patchPath, "utf8"));
const rootConfig = yaml.parse(readFileSync(join(profileDir, "cordis.yml"), "utf8"));
const composed = applyEntryPatches(rootConfig, userPatches);
const presetRows = composed.filter((row) => row?.name === "@deepseek-ai/dsh-agent-preset");
console.log("agent-preset rows in composed tree: " + JSON.stringify(presetRows.map((row) => ({ id: row.id, presetId: row.config?.id, name: row.config?.name, order: row.config?.order })), null, 1));
const hit = presetRows.find((row) => row.config?.id === "wbexpert-senior-developer");
console.log(hit ? "COMPOSE_PASS: wbexpert-senior-developer 已进入组合树；未验证模块加载或预设挂载" : "COMPOSE_FAIL: 预设未进入组合树");
process.exitCode = hit ? 0 : 1;
