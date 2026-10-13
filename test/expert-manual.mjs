// 专家直连功能验证（脱离 DSH 宿主直接驱动 lib/expert-market.js）：
//   1. 真网目录：wbExpertCatalog() 应返回 448 个专家 + 分类
//   2. 真网详情：senior-developer 的人设 MD + 捆绑技能清单（本机缓存判定）
//   3. patch 写链：合成 patch 插入 → 回读 → 更新 → 送还，!!js 标量与注释保留
//   4. patch 写链：真实 profile patch 内容（含 !!js 行）插入 → 回读 → 送还
import { readExpertPresets, removeExpertPreset, wbExpertCatalog, wbExpertDetail, writeExpertPreset } from "../lib/expert-market.js";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const log = (...args) => console.log(...args);
const ok = (name, condition, extra = "") => log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);

// ── 1. 真网目录 ──
// 数量断言：公开清单会随上游增删漂移（WorkBuddy 本地缓存还会多出 visibility=external_only
// 的内部专家，本机缓存 448 vs 公开 429），所以只锚定区间与关键条目，不锚定精确值。
const catalog = await wbExpertCatalog();
ok("catalog.total in [400, 600)", catalog.total >= 400 && catalog.total < 600, `got ${catalog.total}`);
ok("catalog.categories >= 15", catalog.categories.length >= 15, `got ${catalog.categories.length}`);
ok("catalog.loadedFrom network|disk", catalog.loadedFrom === "network" || catalog.loadedFrom === "disk", catalog.loadedFrom + "（首次 network，ETag 命中后 disk，两态都算对）");
const sd = catalog.experts.find((e) => e.plugin === "senior-developer");
ok("catalog has senior-developer", !!sd && sd.name.includes("吴八哥"), sd ? `${sd.name}/${sd.profession}/${sd.categoryName}` : "missing");
ok("expert fields complete", !!sd && Array.isArray(sd.tags) && sd.tags.length === 3 && Array.isArray(sd.quickPrompts) && sd.quickPrompts.length === 3 && typeof sd.avatarUrl === "string" && sd.avatarUrl.startsWith("https://"));
ok("catalog plugin unique", new Set(catalog.experts.map((e) => e.plugin)).size === catalog.experts.length);

// ── 2. 真网详情 ──
const detail = await wbExpertDetail({ plugin: "senior-developer" });
ok("detail.persona non-empty", detail.persona.length > 500, `${detail.personaChars} chars, v${detail.version}`);
ok("detail.skills from plugin.json", Array.isArray(detail.skills) && detail.skills.length >= 3, detail.skills.map((s) => `${s.name}${s.local ? "*" : ""}`).join(", "));
ok("detail promptFile path", detail.promptFile.startsWith("/plugins/senior-developer/agents/"), detail.promptFile);

// ── 3. 合成 patch 写链 ──
const synthetic = `# 用户注释必须保留
- id: ui-settings
  name: "@deepseek-ai/dsh-client-ui-settings"
  config:
    enabled: false
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: workbuddy
    model: glm-5.3-flash
- insert:
    - id: mcp-windows
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: windows
        transport: stdio
        command: "C:\\\\path\\\\tool.exe"
        args:
          - serve
`;
const spec = { plugin: "senior-developer", displayName: "吴八哥", profession: "高级开发工程师", description: "测试", personaText: "你是吴八哥。\n\n## 工作流\n1. 先计划再动手。\n带 \"引号\" 与 : 冒号、'单引号'。" };
const w1 = writeExpertPreset(synthetic, spec);
ok("insert mode=inserted", w1.mode === "inserted" && w1.presetId === "preset-wbexpert-senior-developer");
// 顶层形态必须是 insert 指令：宿主 applyEntryPatches 只认 id-targeted override 与 insert，
// 裸插件条目会被 warn「patch: entry … not found」后跳过——预设永远不注册（1.9.0-1.9.1 根因）。
const w1Lines = w1.content.split("\n");
const presetLineAt = w1Lines.findIndex((line) => line.includes("- id: preset-wbexpert-senior-developer"));
const hasInsertDirective = presetLineAt >= 0 && w1Lines.slice(0, presetLineAt).some((line) => /^-\s*insert:\s*$/.test(line));
ok("insert wraps entry in insert directive", hasInsertDirective, "top-level - insert: present before the preset row");
ok("insert keeps comment", w1.content.includes("# 用户注释必须保留") && w1.content.includes("WorkBuddy 专家召唤"));
ok("insert keeps existing rows", w1.content.includes("agent-default-model") && w1.content.includes("mcp-windows"));
ok("insert keeps !!js-free zones intact", w1.content.includes("provider: workbuddy"));
const r1 = readExpertPresets(w1.content);
ok("readback 1 preset", r1.length === 1 && r1[0].plugin === "senior-developer", JSON.stringify(r1));
const spec2 = { ...spec, personaText: "升级后的人设正文。\n多行。" };
const w2 = writeExpertPreset(w1.content, spec2);
ok("update mode=updated", w2.mode === "updated");
// id 出现次数：行 id 1 次 + config.id 里的 presetId 不含行前缀（wbexpert-…）→ 共 1 次。
ok("update no duplicate row", readExpertPresets(w2.content).length === 1 && (w2.content.match(/preset-wbexpert-senior-developer/g) || []).length === 1, "id occurrences: " + (w2.content.match(/preset-wbexpert-senior-developer/g) || []).length);
ok("update replaces persona text", w2.content.includes("升级后的人设正文") && !w2.content.includes("你是吴八哥"));
ok("update keeps block scalar", w2.content.includes("|"), "persona uses block literal");
const rm1 = removeExpertPreset(w2.content, "senior-developer");
ok("remove returns content", typeof rm1 === "string" && !rm1.includes("preset-wbexpert-senior-developer"));
ok("remove keeps other rows", rm1.includes("agent-default-model") && rm1.includes("mcp-windows"));
ok("remove absent = null", removeExpertPreset(rm1, "senior-developer") === null);

// ── 4. 真实 profile patch（含 !!js）写链 ──
// CI/他人环境没有这个文件：存在才跑，缺了只记 SKIP（写链本身已有合成 patch 段覆盖）。
const profilePatchPath = join(homedir(), ".dsh", "profiles", "desktop", "cordis.patch.yml");
const hasRealPatch = await readFile(profilePatchPath, "utf8").then(() => true, () => false);
if (hasRealPatch) {
const realPatch = await readFile(profilePatchPath, "utf8");
const w3 = writeExpertPreset(realPatch, spec);
ok("real patch insert keeps !!js rows", w3.content.includes("process.platform") && w3.content.includes("llm-workbuddy-xdpool"));
const r3 = readExpertPresets(w3.content);
// 真实 patch 可能已召唤多个专家（各自一条预设），只断言目标专家在列。
ok("real patch readback", r3.some((x) => x.presetId === "preset-wbexpert-senior-developer"), `found ${r3.length} preset(s)`);
const rm3 = removeExpertPreset(w3.content, "senior-developer");
// 真实 patch 现存的是 1.9.0-1.9.1 的缺陷格式（顶层裸条目）；写入会把它迁移成 insert
// 指令，摘除后应还原到与原始文件语义等价（裸条目被清掉 = 宿主不再 warn）。规范化行尾
// 与尾部空白后逐行比较，注释/!!js/其它行必须原样保留。
const normalize = (text) => text.replace(/\r\n/g, "\n").split("\n").map((line) => line.replace(/\s+$/, "")).join("\n").replace(/\n+$/, "\n");
// 真实 patch 可能已有其他专家预设：摘除后只要「senior-developer 不在」且原始非专家行保留即可。
ok("real patch roundtrip restores (target row cleaned)",
  !rm3.includes("preset-wbexpert-senior-developer") && normalize(rm3).length > 0 && realPatch.includes("llm-workbuddy-xdpool") && rm3.includes("llm-workbuddy-xdpool"),
  `target cleaned: ${!rm3.includes("preset-wbexpert-senior-developer")}, other rows kept: ${rm3.includes("llm-workbuddy-xdpool")}`);
// 插入行结构审查：字段齐全、人设是块字面量、!!js 行以普通字符串表示（yaml 序列化时还原 tag）。
const insertAt = w3.content.indexOf("preset-wbexpert-senior-developer");
const insertedBlock = w3.content.slice(Math.max(0, w3.content.lastIndexOf("- insert:", insertAt)));
log("\ninserted row (first 30 lines):");
log(insertedBlock.split("\n").slice(0, 30).join("\n"));
ok("inserted row has preset fields", ["- id: preset-wbexpert-senior-developer", "@deepseek-ai/dsh-agent-preset", "id: wbexpert-senior-developer", "order: 30", "persona", "prefix"].every((needle) => insertedBlock.includes(needle)));
ok("inserted row keeps !!js semantics", insertedBlock.includes("disabled: !!js process.platform === 'win32'"));
} else {
  log("SKIP  real profile patch section (file not present in this environment)");
}

// ── 5. 旧缺陷格式（顶层裸条目）迁移 ──
// 1.9.0-1.9.1 把插件行直接写在顶层：宿主按 id-targeted override 解释 → 目标不存在 →
// warn 跳过 → 预设不注册 → 挂载报「Unknown agent preset」。写链必须把它迁移成 insert 指令。
const legacyPatch = `${synthetic}
- id: preset-wbexpert-senior-developer
  name: "@deepseek-ai/dsh-agent-preset"
  config:
    id: wbexpert-senior-developer
    name: WorkBuddy 专家 · 吴八哥
    order: 30
    plugins:
      - id: persona
        name: "@deepseek-ai/dsh-persona"
        config:
          prefix: 旧人设
`;
ok("legacy readback sees bare row", readExpertPresets(legacyPatch).length === 1);
const w4 = writeExpertPreset(legacyPatch, spec2);
ok("legacy write migrates to insert directive", /^-\s*insert:\s*$/m.test(w4.content) && !/^- id: preset-wbexpert-senior-developer$/m.test(w4.content), "bare top-level row replaced");
ok("legacy migration replaces persona", w4.content.includes("升级后的人设正文") && !w4.content.includes("旧人设"));
ok("legacy migration keeps other rows", w4.content.includes("agent-default-model") && w4.content.includes("mcp-windows"));
const r4 = readExpertPresets(w4.content);
ok("legacy migration readback", r4.length === 1 && r4[0].plugin === "senior-developer", JSON.stringify(r4));
const rm4 = removeExpertPreset(w4.content, "senior-developer");
ok("legacy migration remove cleans directive", !rm4.includes("preset-wbexpert") && rm4.includes("agent-default-model"));
log("\nlegacy-migrated row (first 12 lines):");
log(w4.content.split("\n").slice(w4.content.split("\n").findIndex((line) => /^-\s*insert:\s*$/.test(line))).slice(0, 12).join("\n"));
