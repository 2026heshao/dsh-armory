// WorkBuddy 专家市场直连 —— 专家目录、召唤预设与捆绑技能的安装器。
//
// 数据源（2026-10-12 全部一手实测，均免登录）：
//   1. 专家目录：https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace/expert_center.json
//      这是 WorkBuddy 桌面端专家中心自己的分发地址（本机 WorkBuddy 的
//      ~/.workbuddy/app/cache/experts/metadata.json 的 sourceSignature 记录的就是它）。
//      448 个专家（agent 型 / team 型）+ 15 个行业分类，每条含 displayName / profession /
//      描述 / tags×3 / quickPrompts×3 / promptFile（人设 MD 在 CDN 的路径）/ avatar。
//   2. 专家文件（同一前缀按需拉取）：
//      plugins/<plugin>/.codebuddy-plugin/plugin.json —— 打包规范（WorkBuddy 内置
//      expert-manager 技能的 plugin-json-spec.md 定义）
//      plugins/<plugin>/agents/<agent>.md —— 人设正文（角色定义 / 工作流 / 输出规范）
//      plugins/<plugin>/skills/<skill>/SKILL.md —— 捆绑技能（无服务端清单，COS 禁止枚举，
//        只有本机 WorkBuddy 缓存 ~/.workbuddy/plugins/cache/experts/<plugin>/<ver>/skills/
//        才有完整技能树）
//
// 「召唤专家」= 体验对齐 WorkBuddy：往 profile 的 cordis.patch.yml 插入一条独立的
// @deepseek-ai/dsh-agent-preset 行（官方文档明示的扩展方式：preset 声明就是普通插件行），
// plugins 复刻内置 standard 预设的行清单、仅把 persona 的 prefix 换成专家人设正文——
// 新建会话时在预设选择器里选它 = 专家人设全程接管该会话；多个专家互不影响，可共存。
// 卸载（送还）= 删除该行（热加载，不重启）。preset 行 id 统一 `preset-wbexpert-<plugin>`，
// 这是识别「哪些专家已召唤」的唯一凭据，不引入任何新的持久化状态。
//
// 设计约束（与 wb-market.js 同一纪律）：
//   - 网络只发生在 Host 侧；8/16MB 响应上限；UA 必带（对端策略）。
//   - 目录 JSON 走 ETag 增量缓存（~/.dsh/wb-market/experts/），网络挂了继续用旧缓存。
//   - 技能落盘目标与 SkillHub 技能同一发现范围 ~/.agents/skills/，目录名带 wbexpert__ 前缀
//     防与其它来源撞名；本地缓存复制整树，CDN 兜底只写 SKILL.md 并如实标注。
//   - patch 写入用 yaml 文档 API（与 mcp-config.js 同款 !!js 标量约定），保留其余条目与注释。
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { parseDocument, Scalar, YAMLMap, YAMLSeq, isMap, isSeq } from "yaml";

const EXPERT_ORIGIN = "https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace";
const EXPERT_MANIFEST_PATH = "/expert_center.json";
const USER_AGENT = "@2026heshao/dsh-armory (+https://github.com/2026heshao/dsh-armory)";
// expert_center.json ≈ 1.1MB、人设 MD 最大几十 KB；16MB 已是十倍冗余。
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
// 召唤预设里复刻的 standard 行清单所允许的插件包名白名单——只复刻官方内置行，写死在这里。
const PRESET_PLUGIN = "@deepseek-ai/dsh-agent-preset";
const PERSONA_PLUGIN = "@deepseek-ai/dsh-persona";
const EXPERT_ROW_PREFIX = "preset-wbexpert-";
const EXPERT_PRESET_PREFIX = "wbexpert-";
const EXPERT_SKILL_PREFIX = "wbexpert__";
const JS_TAG = "tag:yaml.org,2002:js";

function cacheDir() {
  return join(homedir(), ".dsh", "wb-market", "experts");
}
function manifestPath() {
  return join(cacheDir(), "expert_center.json");
}
function manifestMetaPath() {
  return join(cacheDir(), "meta.json");
}
function skillsRoot() {
  return join(homedir(), ".agents", "skills");
}
function workbuddyExpertCache() {
  return join(homedir(), ".workbuddy", "plugins", "cache", "experts");
}
function safeSegment(value) {
  // 目录名防穿越：只留安全字符，与 wb-market.js 的 skillTargetName 同一纪律。
  const safe = String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return safe || "x";
}
function expertSkillDirName(plugin, skill) {
  return `${EXPERT_SKILL_PREFIX}${safeSegment(plugin)}__${safeSegment(skill)}`;
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Host 侧统一的 fetch + 上限 + UA（wb-market.js 同款）。 */
async function fetchWithLimits(url, { timeoutMs = 30_000 } = {}) {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json, text/markdown, text/plain, */*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}（${url}）`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_RESPONSE_BYTES) throw new Error(`响应超过上限 ${Math.round(MAX_RESPONSE_BYTES / 1024 / 1024)}MB（${url}）`);
  return buffer;
}
async function fetchText(url) {
  return (await fetchWithLimits(url)).toString("utf8");
}

// ── 专家目录：下载 + ETag 缓存 ─────────────────────────────────────────
// 与连接器 ZIP 同一模式：meta.json 记 ETag，命中即用磁盘缓存；网络挂了继续用旧的。
let cachedManifest = null; // { manifest, loadedFrom: "memory" | "disk" | "network" }
async function loadManifest() {
  if (cachedManifest) return cachedManifest;
  await mkdir(cacheDir(), { recursive: true });
  const meta = (await readJson(manifestMetaPath())) || {};
  const download = async (etag) => {
    const response = await fetch(EXPERT_ORIGIN + EXPERT_MANIFEST_PATH, {
      headers: { "user-agent": USER_AGENT, ...(etag ? { "if-none-match": etag } : {}) },
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 304 && etag) return null;
    if (!response.ok) throw new Error(`专家目录下载失败：HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_RESPONSE_BYTES) throw new Error("专家目录清单超过 16MB 上限，疑似异常响应");
    return { buffer, etag: response.headers.get("etag") || "" };
  };
  const useDisk = async () => {
    const raw = await readFile(manifestPath(), "utf8");
    const manifest = JSON.parse(raw);
    if (!manifest || !Array.isArray(manifest.experts)) throw new Error("磁盘缓存的专家清单结构无效");
    cachedManifest = { manifest, loadedFrom: "disk" };
    return cachedManifest;
  };
  if (meta.etag) {
    try {
      const manifest = await useDisk();
      const fresh = await download(meta.etag);
      if (fresh === null) return manifest;
      cachedManifest = { manifest: JSON.parse(fresh.buffer.toString("utf8")), loadedFrom: "network" };
      await writeFile(manifestPath(), fresh.buffer);
      await writeFile(manifestMetaPath(), JSON.stringify({ etag: fresh.etag, fetchedAt: Date.now() }));
      return cachedManifest;
    } catch {
      // 磁盘缓存损坏或探测失败：落到下面的全量下载；再失败就把错误抛给面板。
    }
  }
  const fresh = await download(meta.etag || "");
  const manifest = JSON.parse(fresh.buffer.toString("utf8"));
  if (!manifest || !Array.isArray(manifest.experts)) throw new Error("专家清单结构无效（缺 experts 数组）");
  cachedManifest = { manifest, loadedFrom: "network" };
  await writeFile(manifestPath(), fresh.buffer);
  await writeFile(manifestMetaPath(), JSON.stringify({ etag: fresh.etag, fetchedAt: Date.now() }));
  return cachedManifest;
}

// ── 目录投影 ───────────────────────────────────────────────────────────
function bi(value) {
  return value && typeof value === "object" ? String(value.zh || value.en || "") : String(value || "");
}
function projectExpert(entry, categoryById) {
  const plugin = String(entry.plugin || "").trim();
  if (!plugin) return null;
  const category = categoryById.get(entry.categoryId);
  return {
    id: String(entry.id || plugin),
    plugin,
    agentName: String(entry.agentName || ""),
    expertType: entry.expertType === "team" ? "team" : "agent",
    name: bi(entry.displayName) || plugin,
    profession: bi(entry.profession),
    description: bi(entry.description),
    categoryId: String(entry.categoryId || ""),
    categoryName: category ? bi(category.name) : String(entry.categoryId || ""),
    tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 3).map(bi).filter(Boolean) : [],
    quickPrompts: Array.isArray(entry.quickPrompts) ? entry.quickPrompts.slice(0, 3).map(bi).filter(Boolean) : [],
    defaultInitPrompt: bi(entry.defaultInitPrompt),
    updatedAt: String(entry.updatedAt || ""),
    isOPC: !!entry.isOPC,
    avatarUrl: entry.avatar ? EXPERT_ORIGIN + String(entry.avatar) : "",
  };
}

/** 专家目录 + 15 个行业分类。UI 列表唯一数据源。 */
export async function wbExpertCatalog() {
  const { manifest, loadedFrom } = await loadManifest();
  const categoryById = new Map((manifest.categories || []).map((category) => [String(category.id || ""), category]));
  const experts = (manifest.experts || [])
    .map((entry) => projectExpert(entry, categoryById))
    .filter(Boolean);
  const categories = (manifest.categories || []).map((category) => ({
    id: String(category.id || ""),
    name: bi(category.name),
    description: bi(category.description),
  })).filter((category) => category.id);
  return { loadedFrom, total: experts.length, experts, categories };
}

// ── 本机 WorkBuddy 缓存：完整技能树的优先来源 ───────────────────────────
// ~/.workbuddy/plugins/cache/experts/<plugin>/<version>/skills/<skill>/
async function localExpertVersions(plugin) {
  const root = join(workbuddyExpertCache(), safeSegment(plugin));
  let names = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const versions = [];
  for (const name of names) {
    if (!/^\d+\.\d+\.\d+/.test(name)) continue;
    const dir = join(root, name);
    try {
      const info = await stat(dir);
      if (info.isDirectory()) versions.push({ name, dir, mtime: info.mtimeMs });
    } catch { /* 竞态删除：跳过 */ }
  }
  versions.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }) || b.mtime - a.mtime);
  return versions;
}
async function findLocalSkillDir(plugin, skill) {
  for (const version of await localExpertVersions(plugin)) {
    const candidate = join(version.dir, "skills", skill);
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) return candidate;
    } catch { /* 该版本没有这个技能 */ }
  }
  return null;
}
async function localExpertPluginJson(plugin) {
  for (const version of await localExpertVersions(plugin)) {
    const candidate = join(version.dir, ".codebuddy-plugin", "plugin.json");
    try {
      return JSON.parse(await readFile(candidate, "utf8"));
    } catch { /* 退回 CDN */ }
  }
  return null;
}

// ── 专家详情：人设正文 + 捆绑技能清单 ──────────────────────────────────
// 召唤前给用户看的全部真实内容：人设 MD 原文、plugin.json 的技能声明、quickPrompts。
export async function wbExpertDetail(payload) {
  const plugin = String(payload?.plugin || "").trim();
  if (!plugin) throw new Error("缺少 plugin");
  const { manifest } = await loadManifest();
  const categoryById = new Map((manifest.categories || []).map((category) => [String(category.id || ""), category]));
  const row = (manifest.experts || []).map((entry) => projectExpert(entry, categoryById)).find((expert) => expert?.plugin === plugin);
  if (!row) throw new Error(`专家目录里没有 plugin=${plugin}（清单可能已更新）`);
  // plugin.json：本地缓存优先（内容与 CDN 同源），缺失再拉 CDN。
  let pluginJson = await localExpertPluginJson(plugin);
  if (!pluginJson) {
    try {
      pluginJson = JSON.parse(await fetchText(`${EXPERT_ORIGIN}/plugins/${encodeURIComponent(plugin)}/.codebuddy-plugin/plugin.json`));
    } catch {
      pluginJson = null;
    }
  }
  if (!row.agentName && pluginJson?.agentName) row.agentName = String(pluginJson.agentName);
  const promptFile = String(row.promptFile || (pluginJson ? `/plugins/${plugin}/agents/${pluginJson.agentName || plugin}.md` : "")).trim();
  if (!promptFile) throw new Error(`专家 ${plugin} 没有人设文件路径（promptFile 缺失）`);
  let persona = "";
  try {
    persona = await fetchText(EXPERT_ORIGIN + promptFile);
  } catch (error) {
    throw new Error(`拉取人设失败：${error.message}`);
  }
  if (!persona.trim()) throw new Error("人设文件为空");
  const skillNames = Array.isArray(pluginJson?.skills)
    ? pluginJson.skills.map((entry) => basename(String(entry).replace(/\/+$/, ""))).filter(Boolean)
    : [];
  const localFull = [];
  for (const name of skillNames) localFull.push(!!(await findLocalSkillDir(plugin, name)));
  const skills = skillNames.map((name, index) => ({ name, local: localFull[index] }));
  return {
    ...row,
    promptFile,
    persona,
    personaChars: persona.length,
    version: String(pluginJson?.version || ""),
    skills,
    avatarPluginUrl: pluginJson?.avatar ? `${EXPERT_ORIGIN}/plugins/${encodeURIComponent(plugin)}/${String(pluginJson.avatar).replace(/^\//, "")}` : row.avatarUrl,
  };
}

// ── 捆绑技能安装：本地缓存整树优先，CDN SKILL.md 兜底 ───────────────────
export async function installExpertSkills(plugin, skillNames, { onLog } = {}) {
  const installed = [];
  const notes = [];
  for (const name of skillNames) {
    const dirName = expertSkillDirName(plugin, name);
    const target = join(skillsRoot(), dirName);
    const local = await findLocalSkillDir(plugin, name);
    try {
      if (local) {
        await rm(target, { recursive: true, force: true });
        await mkdir(skillsRoot(), { recursive: true });
        await cp(local, target, { recursive: true });
        installed.push({ name, dirName, source: "workbuddy-cache" });
        onLog?.(`技能 ${name}：已从本机 WorkBuddy 缓存完整复制`);
        continue;
      }
      const md = await fetchText(`${EXPERT_ORIGIN}/plugins/${encodeURIComponent(plugin)}/skills/${encodeURIComponent(name)}/SKILL.md`);
      if (!md.trim()) throw new Error("SKILL.md 为空");
      await rm(target, { recursive: true, force: true });
      await mkdir(target, { recursive: true });
      await writeFile(join(target, "SKILL.md"), md);
      installed.push({ name, dirName, source: "cdn-skill-md" });
      onLog?.(`技能 ${name}：CDN 只有 SKILL.md，已按单文件安装（完整内容请用 WorkBuddy 缓存）`);
    } catch (error) {
      notes.push(`技能 ${name} 安装失败：${error.message}`);
    }
  }
  return { installed, notes };
}
export async function uninstallExpertSkills(plugin) {
  const root = skillsRoot();
  let names = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const prefix = `${EXPERT_SKILL_PREFIX}${safeSegment(plugin)}__`;
  const removed = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    await rm(join(root, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}
/** 已安装的专家捆绑技能（含来源与所属 plugin，供面板「已召唤/已装技能」标记）。 */
export async function listExpertSkills() {
  const root = skillsRoot();
  let names = [];
  try {
    names = await readdir(root);
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    if (!name.startsWith(EXPERT_SKILL_PREFIX)) continue;
    const rest = name.slice(EXPERT_SKILL_PREFIX.length);
    const split = rest.indexOf("__");
    if (split <= 0) continue;
    const dir = join(root, name);
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) continue;
      rows.push({ dirName: name, plugin: rest.slice(0, split), skill: rest.slice(split + 2), dir });
    } catch { /* 竞态删除：跳过 */ }
  }
  return rows;
}

// ── profile patch：召唤预设行的写入与摘除（纯函数，yaml 文档 API）────────
// 为什么是「插入独立 preset 行」而不是覆盖 standard 的 persona：patch 对 preset 行的
// config.plugins 是**整体替换**（web 编辑器同款语义），只写 persona 会把 standard 的
// 全部工具行打掉；独立行 = 多专家共存 + 官方文档明示的扩展方式，也最贴近 WorkBuddy
// 「专家 = 一种会话身份」的模型。
function parsePatchDoc(content) {
  const doc = parseDocument(content || "");
  if (doc.errors.length) throw new Error(`profile patch YAML 无法解析：${doc.errors[0].message}`);
  if (!isSeq(doc.contents)) throw new Error("profile patch 必须是 YAML 列表");
  return doc;
}
function mapValue(map, key) {
  if (!isMap(map)) return undefined;
  const value = map.get(key, true);
  return value && typeof value === "object" && "value" in value ? value.value : value;
}
function isExpertPresetItem(item, plugin) {
  if (!isMap(item)) return false;
  if (mapValue(item, "name") !== PRESET_PLUGIN) return false;
  const id = mapValue(item, "id");
  if (typeof id !== "string" || !id.startsWith(EXPERT_ROW_PREFIX)) return false;
  if (plugin === undefined) return true;
  return id === EXPERT_ROW_PREFIX + safeSegment(plugin);
}
/**
 * 插件条目在 patch 里可能出现的两种位置：
 *   ① 顶层 insert 指令 `- insert: [- id: preset-wbexpert-…, …]`（唯一合法写法）
 *   ② 顶层裸条目 `- id: preset-wbexpert-…`（1.9.0-1.9.1 的缺陷写法，宿主按
 *     「id-targeted override」解释——目标行不存在 → warn `patch: entry … not found`
 *     后整条跳过，预设永远不注册。）
 * 读法同时兼容两者（旧文件仍可识别、可迁移）；写法只产出 ①。
 */
function expertPresetItemOf(item) {
  if (!isMap(item)) return null;
  if (mapValue(item, "name") === PRESET_PLUGIN) return item;
  const insert = mapValue(item, "insert");
  if (!isSeq(insert) || insert.items.length !== 1) return null;
  const entry = insert.items[0];
  return isMap(entry) && mapValue(entry, "name") === PRESET_PLUGIN ? entry : null;
}
/** 当前 patch 里已有的召唤预设行。 */
export function readExpertPresets(content) {
  const doc = parsePatchDoc(content);
  const rows = [];
  for (const item of doc.contents.items) {
    const entry = expertPresetItemOf(item);
    if (!entry || !isExpertPresetItem(entry)) continue;
    const config = entry.get("config", true);
    const presetId = String(mapValue(config, "id") || "");
    if (!presetId.startsWith(EXPERT_PRESET_PREFIX)) continue;
    rows.push({ presetId: String(mapValue(entry, "id")), plugin: presetId.slice(EXPERT_PRESET_PREFIX.length) });
  }
  return rows;
}
function taggedScalar(value, type) {
  if (typeof value === "string" && value.startsWith("!!js ")) {
    const scalar = new Scalar(value.slice(5));
    scalar.tag = JS_TAG;
    return scalar;
  }
  const scalar = new Scalar(value);
  if (type) scalar.type = type;
  return scalar;
}
function toNode(value, key) {
  if (Array.isArray(value)) {
    const seq = new YAMLSeq();
    for (const item of value) seq.items.push(toNode(item));
    return seq;
  }
  if (value && typeof value === "object") {
    const map = new YAMLMap();
    for (const [itemKey, item] of Object.entries(value)) map.set(itemKey, toNode(item, itemKey));
    return map;
  }
  // 长文本（人设正文 / plan-mode 规则）用块字面量，patch 里保持可读、diff 友好。
  const block = typeof value === "string" && value.includes("\n");
  return taggedScalar(value, block ? "BLOCK_LITERAL" : undefined);
}
// 复刻 standard 预设的行清单（dsh-web-app/presets/standard.patch.yml，0.1.5-0.2.0 一致），
// 仅 persona 的 prefix 换成专家人设。工具行、分组与 plan-mode 文本原样保留。
const PLAN_MODE_SECTION = [
  "You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode. Imperative language to implement changes means plan the implementation, not execute it. A user's conversational agreement — including an answer confirming something you asked — approves nothing and does not end plan mode; fold the confirmed decision into the plan and submit it through exit_plan_mode.",
  "",
  "Explore first. Use non-mutating reads, searches, static analysis, and checks to ground the plan in the actual repository. Do not edit or write files, change configuration, run formatters or code generation that rewrites tracked files, commit, or otherwise carry out the plan. Prefer existing functions and patterns over new machinery.",
  "",
  "The tool catalog stays the same across modes for request-cache stability. These plan-mode rules override any later tool description or guidance that suggests using mutation tools; those tools remain listed to keep the tool catalog unchanged. Do not use todo_write to track this planning phase: it tracks implementation after an approved plan, while the plan itself belongs in exit_plan_mode.",
  "",
  "Resolve discoverable facts by inspection. Use ask_user_question only for user-owned choices or material ambiguity that inspection cannot answer. Do not ask the user where code lives or how current behavior works when you can find out.",
  "",
  "Make the plan decision-complete: state the goal and success criteria; group implementation changes by subsystem; identify public API, schema, and data-flow changes; cover edge cases, failure modes, tests, acceptance criteria, and explicit assumptions. Keep it concise enough to review but detailed enough that another engineer can implement it without making design decisions.",
  "",
  "When ready, call exit_plan_mode with the complete plan markdown, starting with a # title. Make exit_plan_mode the only and final tool call in that assistant response: it presents the plan for approval, and implementation begins only in a later step after approval. Do not paste the final plan as a plain reply or ask \"should I proceed?\" through prose or ask_user_question. If review rejects it, incorporate the feedback and present again. If the review channel is unavailable or aborted, stay in plan mode and ask the user to switch modes manually; do not proceed with implementation.",
].join("\n");
function expertPresetPlugins(spec) {
  return [
    { id: "persona", name: PERSONA_PLUGIN, config: { suffix: "Your working directory is {{cwd}}.", prefix: spec.personaText } },
    { id: "agent-instructions", name: "@deepseek-ai/dsh-agent-instructions", config: { maxBytes: 65536 } },
    { id: "tool-bash", name: "@deepseek-ai/dsh-tool-bash", disabled: "!!js process.platform === 'win32'" },
    { id: "tool-pwsh", name: "@deepseek-ai/dsh-tool-pwsh", disabled: "!!js process.platform !== 'win32'" },
    { id: "tool-fs", name: "@deepseek-ai/dsh-tool-fs" },
    { id: "tool-fs-search", name: "@deepseek-ai/dsh-tool-fs-search", config: { sampleOverCapGlobResults: false } },
    { id: "tool-jobs", name: "@deepseek-ai/dsh-tool-jobs" },
    { id: "command-goal", name: "@deepseek-ai/dsh-command-goal" },
    { id: "tool-goal", name: "@deepseek-ai/dsh-tool-goal" },
    {
      id: "planning", name: "cordis:group", group: true, isolate: { planMode: true },
      config: [{ id: "plan-mode", name: "@deepseek-ai/dsh-plan-mode", config: { section: PLAN_MODE_SECTION } }],
    },
    {
      id: "compaction", name: "cordis:group", group: true, isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
        { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
        { id: "tool-result-pruner", name: "@deepseek-ai/dsh-compaction-tool-result-pruner", config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
      ],
    },
    {
      id: "delegation", name: "cordis:group", group: true, isolate: { workflowEngine: true },
      config: [
        { id: "tool-subagent-control", name: "@deepseek-ai/dsh-tool-subagent-control" },
        { id: "tool-subagent-list-agents", name: "@deepseek-ai/dsh-tool-subagent-control/list-agents" },
        { id: "tool-subagent", name: "@deepseek-ai/dsh-tool-subagent", config: { provider: "spawn", toolName: "subagent", modelSelectionSettings: true, backgroundMode: "continuable" } },
        { id: "tool-subagent-fork", name: "@deepseek-ai/dsh-tool-subagent", config: { provider: "fork", toolName: "subagent_fork", backgroundMode: "continuable" } },
        { id: "tool-subagent-codex", name: "@deepseek-ai/dsh-tool-subagent", disabled: true, config: { provider: "codex", toolName: "subagent_codex", backgroundMode: "one-shot", maxDepth: "provider-managed" } },
        { id: "tool-subagent-claude-code", name: "@deepseek-ai/dsh-tool-subagent", disabled: true, config: { provider: "claude-code", toolName: "subagent_claude_code", backgroundMode: "one-shot", maxDepth: "provider-managed" } },
        { id: "workflow-ptc", name: "@deepseek-ai/dsh-workflow-ptc", config: { provider: "spawn" } },
        { id: "tool-workflow", name: "@deepseek-ai/dsh-tool-workflow" },
        { id: "tool-ralph", name: "@deepseek-ai/dsh-tool-ralph", disabled: true, config: { subagentProvider: "spawn", maxRounds: 64 } },
      ],
    },
    { id: "tool-ask-user", name: "@deepseek-ai/dsh-tool-ask-user" },
    { id: "tool-todo", name: "@deepseek-ai/dsh-tool-todo", config: { allowParallelInProgress: true } },
    { id: "tool-web", name: "@deepseek-ai/dsh-tool-web", config: { fetch: true, searchTimeoutMs: 60000 } },
    { id: "present", name: "@deepseek-ai/dsh-tool-present" },
  ];
}
/**
 * 召唤预设行的合法形态：顶层 insert 指令（与 mcp-config.js 的 MCP 行同一写法）。
 * 宿主 applyEntryPatches 的语义：顶层条目要么是「针对已有行的 id-targeted override」，
 * 要么是 `insert` 列表——裸插件条目不注册（warn 后跳过）。这就是 1.9.0-1.9.1
 * 「挂载失败：Unknown agent preset」的根因。
 * @returns {{item: YAMLMap, entry: YAMLMap, index: number}|null}
 */
function findExpertPresetRow(doc, presetId) {
  const items = doc.contents.items;
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!isMap(item)) continue;
    // 新格式：顶层 `- insert: [- id: preset-… ]`
    const insert = mapValue(item, "insert");
    if (isSeq(insert)) {
      const hit = insert.items.findIndex((entry) => isExpertPresetItem(entry, undefined) && mapValue(entry, "id") === presetId);
      if (hit >= 0) return { item, entry: insert.items[hit], index, insertSeq: insert, entryIndex: hit };
    }
    // 旧缺陷格式：顶层裸条目（读兼容，写时迁移成新格式）
    if (isExpertPresetItem(item, undefined) && mapValue(item, "id") === presetId) return { item, entry: item, index, legacy: true };
  }
  return null;
}
function buildExpertPresetRow(doc, spec, presetId, presetConfigId) {
  const entry = new YAMLMap();
  entry.commentBefore = ` WorkBuddy 专家召唤（${spec.displayName}）：新会话选预设「${presetConfigId}」即专家人设接管；送还请在 技能·MCP 看板 → 市场 → 专家`;
  entry.set("id", presetId);
  entry.set("name", PRESET_PLUGIN);
  const config = new YAMLMap();
  config.set("id", presetConfigId);
  config.set("name", `WorkBuddy 专家 · ${spec.displayName}`);
  config.set("description", `${spec.displayName} · ${spec.profession} —— 来自 WorkBuddy 专家市场${spec.description ? `：${spec.description}` : ""}`);
  config.set("order", 30);
  config.set("plugins", toNode(expertPresetPlugins(spec)));
  entry.set("config", config);
  const patch = new YAMLMap();
  const insert = new YAMLSeq();
  insert.items.push(entry);
  patch.set("insert", insert);
  return { patch, entry };
}
/**
 * 写入（插入或更新）一个专家召唤预设行。顶层形态始终是 insert 指令；
 * 命中旧缺陷格式（顶层裸条目）时原位迁移为 insert 指令。
 * @returns {{content: string|null, mode: "inserted"|"updated", presetId: string}} content 为 null 表示无需改动。
 */
export function writeExpertPreset(content, spec) {
  const plugin = safeSegment(spec.plugin);
  const presetId = EXPERT_ROW_PREFIX + plugin;
  const presetConfigId = EXPERT_PRESET_PREFIX + plugin;
  const doc = parsePatchDoc(content);
  const existing = findExpertPresetRow(doc, presetId);
  if (existing) {
    // 旧缺陷格式迁移：把顶层裸条目原位替换为 insert 指令（comment 随行保留）。
    if (existing.legacy) {
      const { patch } = buildExpertPresetRow(doc, spec, presetId, presetConfigId);
      patch.commentBefore = existing.entry.commentBefore;
      doc.contents.items[existing.index] = patch;
      return { content: String(doc), mode: "updated", presetId };
    }
    const config = existing.entry.get("config", true);
    if (!isMap(config)) throw new Error(`profile patch 里 id=${presetId} 的行 config 结构异常`);
    config.set("plugins", toNode(expertPresetPlugins(spec)));
    return { content: String(doc), mode: "updated", presetId };
  }
  const { patch } = buildExpertPresetRow(doc, spec, presetId, presetConfigId);
  doc.contents.items.push(patch);
  return { content: String(doc), mode: "inserted", presetId };
}
/** 摘除一个专家召唤预设行。@returns {string|null} null = 本来就不在。 */
export function removeExpertPreset(content, plugin) {
  const doc = parsePatchDoc(content);
  const pluginSafe = safeSegment(plugin);
  const items = doc.contents.items;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!isMap(item)) continue;
    // 新格式：从顶层 insert 指令里摘除该条目；摘空后整个指令一并移除（与 mcp-config.js 同款）。
    const insert = mapValue(item, "insert");
    if (isSeq(insert)) {
      const hit = insert.items.findIndex((entry) => isExpertPresetItem(entry, pluginSafe));
      if (hit >= 0) {
        insert.items.splice(hit, 1);
        if (insert.items.length === 0 && item.items.length === 1) items.splice(index, 1);
        return String(doc);
      }
      continue;
    }
    // 旧缺陷格式：顶层裸条目直接移除。
    if (isExpertPresetItem(item, pluginSafe)) {
      items.splice(index, 1);
      return String(doc);
    }
  }
  return null;
}

// ── 最近使用 / 新安装记录（输入框召唤菜单的数据源）──────────────────────
// 持久化在 ~/.dsh/wb-market/experts/recent.json：三类各存一份轻量记录
// （skill: 技能名+来源目录名；mcp: serverName+作用域；expert: plugin+召唤预设名）。
// 只在「可观察的使用动作」发生时写入：召唤/送还专家、召唤菜单里选中一项（由客户端
// 显式上报）。上限各 40 条（召唤菜单每屏 6 行 + 滚动，排序需要较深的最近记录池），
// 新的顶到最前，去重按主键。文件损坏静默重置（纯增值数据）。
const RECENT_LIMIT = 40;
function recentPath() {
  return join(cacheDir(), "recent.json");
}
function kindKey(kind, row) {
  if (kind === "skill") return String(row?.name || "");
  if (kind === "mcp") return String(row?.serverName || "");
  return String(row?.plugin || "");
}
async function readRecentRaw() {
  const raw = await readJson(recentPath());
  return raw && typeof raw === "object" && raw.version === 1 && raw.kinds && typeof raw.kinds === "object"
    ? raw
    : { version: 1, kinds: { skill: [], mcp: [], expert: [] } };
}
async function writeRecentRaw(data) {
  await mkdir(cacheDir(), { recursive: true });
  await writeFile(recentPath(), JSON.stringify(data, null, 1));
}
/** 记录一次使用。row 携带菜单展示所需的最小字段；kind ∈ skill|mcp|expert。 */
export async function recordExpertRecent(kind, row) {
  const key = kind === "skill" || kind === "mcp" || kind === "expert" ? kind : null;
  if (!key || !row || typeof row !== "object") throw new Error("recordExpertRecent: kind 或 row 无效");
  const data = await readRecentRaw();
  const list = Array.isArray(data.kinds[key]) ? data.kinds[key] : [];
  const primaryKey = kindKey(key, row);
  if (!primaryKey) throw new Error("recordExpertRecent: row 缺少主键");
  const entry = { ...row, usedAt: Date.now() };
  data.kinds[key] = [entry, ...list.filter((item) => kindKey(key, item) !== primaryKey)].slice(0, RECENT_LIMIT);
  await writeRecentRaw(data);
  return { ok: true };
}
/** 读取最近使用（三类各 ≤8 条，按 usedAt 新→旧）。移除已不存在的专家预设（送还后不再出现在菜单）。 */
export async function listExpertRecent() {
  const data = await readRecentRaw();
  const kinds = {};
  for (const key of ["skill", "mcp", "expert"]) {
    const list = Array.isArray(data.kinds[key]) ? data.kinds[key] : [];
    if (key === "expert") {
      // expert 记录与召唤预设对账：预设已摘除（送还）的记录不再展示，也顺手清掉。
      let patch = null;
      try {
        patch = (await import("node:fs/promises")).readFile(join(homedir(), ".dsh", "profiles", "desktop", "cordis.patch.yml"), "utf8");
      } catch {
        patch = null;
      }
      const live = patch ? new Set(readExpertPresets(patch).map((row) => row.plugin)) : null;
      kinds[key] = live ? list.filter((item) => live.has(String(item?.plugin || ""))) : list;
      if (live && kinds[key].length !== list.length) {
        data.kinds[key] = kinds[key];
        await writeRecentRaw(data).catch(() => {});
      }
      continue;
    }
    kinds[key] = list;
  }
  return { kinds };
}
