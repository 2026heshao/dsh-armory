// 端到端验证：用宿主 app-boot 的 applyEntryPatches 组合「根配置 + 全部 patch 层」，
// 确认迁移后的专家预设行真的进入有效条目列表（即宿主 boot 时会注册该预设）。
// applyEntryPatches 是纯函数（_research/app-boot-index.js L61-110 的逐行转录，语义
// 一致性由源码行号锚定）：id-targeted override 与 insert 两种指令，未命中 warn 跳过。
// 这是「Unknown agent preset」问题的最终判据——宿主 boot 就是跑这个算法。
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
console.log(hit ? "E2E_PASS: wbexpert-senior-developer 会被宿主注册（agentPresets.resolve 可命中）" : "E2E_FAIL: 预设未进入组合树");
process.exitCode = hit ? 0 : 1;
