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
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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
// 召唤预设行 config.name 的固定前缀：宿主的会话头预设标签显示的就是整串
// 「WorkBuddy 专家 · 吴八哥」。写侧用它拼，读侧（readExpertPresets）剥它取名，
// 两处共用一个常量才不会拼/剥漂移。与 client.js 的 EXPERT_PRESET_LABEL_PREFIX
// 必须逐字相同（那份是匹配宿主标签用的，同样不参与翻译）。
const EXPERT_PRESET_NAME_PREFIX = "WorkBuddy 专家 · ";

function cacheDir() {
  // 测试隔离口（惯例同 wb-registry 的 DSH_ARMORY_HOME）：设置时整个 wb-market 缓存根
  // 指到临时目录，本目录 = <根>/experts；不设置走真实 ~/.dsh。
  const root = process.env.DSH_ARMORY_MARKET_HOME || join(homedir(), ".dsh", "wb-market");
  return join(root, "experts");
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
  // 测试隔离口（同 DSH_ARMORY_MARKET_HOME 的纪律）：设置时本机 WorkBuddy 缓存根指到临时目录。
  const override = process.env.DSH_ARMORY_WORKBUDDY_CACHE;
  if (override) return override;
  return join(homedir(), ".workbuddy", "plugins", "cache", "experts");
}
// 团队专家：主理人 + N 个成员，每人一份人设。成员人设不塞进 preset（会白白撑大每轮
// 系统提示），而是落盘成独立 md，由主理人调度时按需 read 进 subagent 的 prompt。
function teamMemberDir(plugin) {
  return join(cacheDir(), "teams", safeSegment(plugin));
}
function teamMemberPersonaPath(plugin, memberId) {
  return join(teamMemberDir(plugin), `${safeSegment(memberId)}.md`);
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
/** 缓存正文用临时文件 + rename 落盘：写一半被杀只会留下无人读的 .tmp，不会留下截断的清单。 */
async function writeCacheFile(path, data) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}
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
    return manifest;
  };
  const persistNetwork = async (fresh) => {
    // 结构校验先于一切赋值/写盘：CDN 或中间代理返回"可解析但不是清单"的 JSON 时，
    // 不能让它覆盖掉磁盘上那份好的（校验失败按下载失败处理，走下面的回落）。
    const manifest = JSON.parse(fresh.buffer.toString("utf8"));
    if (!manifest || !Array.isArray(manifest.experts)) throw new Error("专家清单结构无效（缺 experts 数组）");
    await writeCacheFile(manifestPath(), fresh.buffer);
    await writeCacheFile(manifestMetaPath(), JSON.stringify({ etag: fresh.etag, fetchedAt: Date.now() }));
    cachedManifest = { manifest, loadedFrom: "network" };
    return cachedManifest;
  };
  // 磁盘缓存先读好备用：它是 304（内容未变）与断网两条路的共同回落——头注承诺的
  // 「网络挂了继续用旧的」靠它兑现。读失败（损坏/缺失）只回落到全量下载，不抛出去。
  let diskManifest = null;
  try {
    diskManifest = await useDisk();
  } catch {
    diskManifest = null;
  }
  try {
    // 只在磁盘缓存有效时才带上 etag：磁盘副本损坏/缺失而 etag 命中 304 的话，
    // 我们手上没有任何正文可用（旧实现此时会拿着 null 去取 buffer，崩成 TypeError）。
    const fresh = await download(diskManifest && meta.etag ? meta.etag : "");
    if (fresh) return await persistNetwork(fresh);
    // 304 = 服务器内容与 etag 一致 = 磁盘缓存就是权威副本。
    cachedManifest = { manifest: diskManifest, loadedFrom: "disk" };
    return cachedManifest;
  } catch {
    // 网络失败 / 响应结构无效：有磁盘缓存就回落到它，绝不因为刷新失败把面板打空。
  }
  if (diskManifest) {
    cachedManifest = { manifest: diskManifest, loadedFrom: "disk" };
    return cachedManifest;
  }
  throw new Error("专家目录不可用：下载失败且本地没有有效的缓存副本");
}

// ── 目录投影 ───────────────────────────────────────────────────────────
function bi(value) {
  return value && typeof value === "object" ? String(value.zh || value.en || "") : String(value || "");
}
function biEn(value) {
  return value && typeof value === "object" ? String(value.en || value.zh || "") : String(value || "");
}
function biMember(value) {
  return value && typeof value === "object" ? String(value.zh || value.en || "") : String(value || "");
}
/** 团队编制里的一行：成员 ID / 花名 / 职业 / 角色 / 人设文件名。 */
function projectMember(member) {
  const id = String(member?.id || "").trim();
  if (!id) return null;
  return {
    id,
    name: biMember(member.displayName || member.name),
    profession: biMember(member.profession),
    role: String(member.role || "member"),
    promptFile: String(member.promptFile || ""),
    avatar: String(member.avatar || ""),
  };
}
function projectExpert(entry, categoryById) {
  const plugin = String(entry.plugin || "").trim();
  if (!plugin) return null;
  const category = categoryById.get(entry.categoryId);
  const members = Array.isArray(entry.members) ? entry.members.map(projectMember).filter(Boolean) : [];
  return {
    id: String(entry.id || plugin),
    plugin,
    agentName: String(entry.agentName || ""),
    expertType: entry.expertType === "team" ? "team" : "agent",
    members,
    name: bi(entry.displayName) || plugin,
    profession: bi(entry.profession),
    description: bi(entry.description),
    // 清单给的人设路径是权威来源：wbExpertDetail 拿它当首选（plugin.json 拉不到时是唯一来源）。
    promptFile: String(entry.promptFile || ""),
    categoryId: String(entry.categoryId || ""),
    categoryName: category ? bi(category.name) : String(entry.categoryId || ""),
    tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 3).map(bi).filter(Boolean) : [],
    quickPrompts: Array.isArray(entry.quickPrompts) ? entry.quickPrompts.slice(0, 3).map(bi).filter(Boolean) : [],
    defaultInitPrompt: bi(entry.defaultInitPrompt),
    createdAt: String(entry.createdAt || ""),
    updatedAt: String(entry.updatedAt || ""),
    isOPC: !!entry.isOPC,
    avatarUrl: entry.avatar ? EXPERT_ORIGIN + String(entry.avatar) : "",
  };
}

/**
 * plugin → 专家显示名（中英两套）+ 头像地址。只读本机目录缓存，不发网络请求：
 * 输入框快捷菜单每次打开都要用，不能为了一次取名去拉 1.1MB 目录；而能召唤专家
 * 的前提就是目录已经落过盘，缓存缺失只可能是手工清目录，返回空表由前端回落 plugin。
 * avatarUrl 与 projectExpert 同一拼法（EXPERT_ORIGIN + entry.avatar），已召唤页的
 * 卡片头像不用再等整份目录——只有名字缓存在场也能出图。
 * 按 mtime+size 记忆：同一份目录只解析一次（wbExpertInstalled 会被面板多处并发调用）；
 * 目录刷新写盘后戳变化，下一次调用自动重读。
 */
let displayNamesCache = null; // { stamp, names }
export async function readExpertDisplayNames() {
  const path = manifestPath();
  let stamp = "";
  try {
    const info = await stat(path);
    stamp = `${info.mtimeMs}:${info.size}`;
  } catch {
    return new Map();
  }
  if (displayNamesCache && displayNamesCache.stamp === stamp) return displayNamesCache.names;
  const manifest = await readJson(path);
  const names = new Map();
  if (!manifest || !Array.isArray(manifest.experts)) return names;
  for (const entry of manifest.experts) {
    const plugin = String(entry?.plugin || "").trim();
    if (!plugin) continue;
    names.set(plugin, {
      nameZh: bi(entry.displayName),
      nameEn: biEn(entry.displayName),
      professionZh: bi(entry.profession),
      professionEn: biEn(entry.profession),
      avatarUrl: entry.avatar ? EXPERT_ORIGIN + String(entry.avatar) : "",
    });
  }
  displayNamesCache = { stamp, names };
  return names;
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
  // 目录本身的来源信息：面板上用来说明「这些专家是谁维护的、多久更新一次」。
  // 缺字段就给空串，不编造。
  const author = manifest.author && typeof manifest.author === "object" ? manifest.author : {};
  const meta = {
    authorName: String(author.name || ""),
    authorSource: String(author.source || ""),
    license: String(author.license || ""),
    version: String(manifest.version || ""),
    lastUpdated: String(manifest.lastUpdated || ""),
  };
  return { loadedFrom, total: experts.length, experts, categories, meta };
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

// 主理人人设的本机来源：WorkBuddy 自己下载过的专家包里就有 agents/<name>.md。
// 上游只把一部分专家放在公开分发地址上（2026-10-27 实测 428 个里 185 个 404），
// 所以本机缓存不是「优化」，而是这些专家唯一能拿到正文的途径。
// 人设文件名只做「取最后一段 + 拒绝穿越」，不做 ASCII 化：WorkBuddy 里真实存在
// 中文 agentName（如「腾讯健康-觅影-眼底彩照疾病分析专家」），safeSegment 会把它压成
// 一串连字符，永远找不到本机缓存里的 agents/<agentName>.md。
function agentFileStem(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const base = basename(raw.replace(/\\/g, "/")).replace(/\.md$/i, "").trim();
  if (!base || base === "." || base === ".." || base.includes("\0")) return "";
  return base;
}

async function localExpertPersona(plugin, agentName) {
  const names = [agentName, plugin].map(agentFileStem).filter(Boolean);
  for (const version of await localExpertVersions(plugin)) {
    const dir = join(version.dir, "agents");
    for (const name of new Set(names)) {
      try {
        const text = await readFile(join(dir, `${name}.md`), "utf8");
        if (text.trim()) return text;
      } catch { /* 换个名字或换下一个版本 */ }
    }
    // 人设文件名与 plugin / agentName 都不一致时，接受 agents/ 下唯一那份 md。
    try {
      const files = (await readdir(dir)).filter((file) => /\.md$/i.test(file));
      if (files.length === 1) {
        const text = await readFile(join(dir, files[0]), "utf8");
        if (text.trim()) return text;
      }
    } catch { /* 该版本没有 agents/ */ }
  }
  return null;
}

// 本机覆盖：用户自备的人设正文，优先级高于缓存与 CDN。上游 185/429 没有公开分发、
// 本机也没有缓存时，这是唯一能拿到「原文」的途径。文件名走 safeSegment，不能借 plugin 穿越目录。
function overridePersonaPath(plugin) {
  return join(cacheDir(), "overrides", `${safeSegment(plugin)}.md`);
}
async function overridePersona(plugin) {
  try {
    const text = await readFile(overridePersonaPath(plugin), "utf8");
    if (text.trim()) return text;
  } catch { /* 绝大多数专家没有覆盖文件 */ }
  return null;
}

/** 原文取不到的原因：上游缺包与网络故障说法不同，用户据此决定换专家还是重试。 */
function describePersonaFailure(error) {
  const detail = String(error?.message || error);
  if (/HTTP 404/.test(detail)) return "上游 404：专家中心目录里挂着它，但公开分发地址上没有这个包";
  return `拉取原文失败：${detail}`;
}

/**
 * 兜底人设：三条正路都拿不到原文时，用专家中心公开的介绍 / 专业 / 标签 / 示例问题拼一份替身。
 * 必须显式标注非原文——召唤出来的会话会照这份文字行事，用户有权知道它不是原作者设定；
 * 拿到原文后放进本机覆盖目录即自动改用原文（覆盖优先级最高）。
 */
function generatedPersona(row, reason) {
  const name = row.name || row.plugin;
  const profession = row.profession || "该领域的专家";
  const description = row.description || "（专家中心没有为它提供介绍文字）";
  const category = row.categoryName || row.categoryId || "";
  const tags = Array.isArray(row.tags) ? row.tags.filter(Boolean) : [];
  const prompts = Array.isArray(row.quickPrompts) ? row.quickPrompts.filter(Boolean) : [];
  const overridePath = overridePersonaPath(row.plugin).replace(/\\/g, "/");
  const lines = [
    `# ${name}（${profession}）`,
    "",
    `> **这份人设不是原文。**${reason}；本机 WorkBuddy 缓存里也没有它。`,
    "> 下面的内容由 WorkBuddy 专家中心公开的介绍、标签与示例问题整理而成，",
    "> 只能还原「大致是谁、负责什么」，不等同于原作者写的工作方法与铁律。",
    `> 拿到原始人设后，放到 \`${overridePath}\` 即可自动改用原文。`,
    "",
    "## 身份",
    `你是「${name}」，身份是「${profession}」${category ? `，属于「${category}」` : ""}。`,
    "",
    "## 你负责什么",
    description,
    "",
    "## 工作原则",
    "- 只做上面这段职责范围内的事；被问到范围外的内容时说明边界并给出替代方向，不冒充全才。",
    "- 这不是原作者人设：不要声称掌握原作者未公开的资料、模板或内部流程，拿不准就直说。",
    "- 先确认目标、已有输入与验收标准，再动手；信息不足时先问最关键的那一个。",
    "- 给结论时附上依据与可执行的下一步，不写空泛的鼓励语。",
  ];
  if (tags.length) lines.push(`- 额外关注：${tags.join("、")}。`);
  if (prompts.length) lines.push("", "## 用户常这样开始", ...prompts.map((prompt) => `- ${prompt}`));
  lines.push(
    "",
    "## 开场",
    "第一次对话先用一句话说明自己是谁、能做什么，然后按上面的原则推进；不要主动展开与任务无关的话题。",
  );
  return `${lines.join("\n")}\n`;
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
  // 取数顺序：本机覆盖 → 本机 WorkBuddy 缓存 → 公开分发地址 → 兜底生成。
  // 上游 185/429 没有公开分发人设（issue #5），所以「三条路都空」是常态而非异常：
  // 这时给一份明确标注非原文的替身，保证专家至少能看详情、能召唤，不再抛 404。
  let persona = (await overridePersona(plugin)) || "";
  let personaSource = persona ? "override" : "";
  let personaNotice = "";
  if (!persona) {
    persona = (await localExpertPersona(plugin, row.agentName || pluginJson?.agentName)) || "";
    if (persona) personaSource = "workbuddy-cache";
  }
  if (!persona) {
    try {
      const fetched = await fetchText(EXPERT_ORIGIN + promptFile);
      if (fetched.trim()) {
        persona = fetched;
        personaSource = "cdn";
      } else {
        personaNotice = "公开分发地址上的人设文件是空的";
      }
    } catch (error) {
      personaNotice = describePersonaFailure(error);
      // 只有「上游确实没有这份文件」（404 / 410）才生成替身。断网 / 超时 / 5xx 是暂时故障，
      // 静默换成替身会让用户以为专家原文就长这样——如实报错，让用户重试或放本机覆盖。
      if (!/HTTP (404|410)\b/.test(String(error?.message || error))) {
        throw new Error(`拉取专家人设失败：${String(error?.message || error)}。请检查网络后重试，或把原文放到本机覆盖目录后再打开。`);
      }
    }
  }
  if (!persona) {
    persona = generatedPersona(row, personaNotice);
    personaSource = "generated";
    personaNotice = personaNotice || "原文不可用";
  }
  if (!persona.trim()) throw new Error("人设正文为空");
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
    personaSource,
    personaNotice,
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
// ── 团队专家：成员人设落盘（召唤时执行，送还时整体清除）─────────────────
async function localMemberPersona(plugin, memberId) {
  for (const version of await localExpertVersions(plugin)) {
    const candidate = join(version.dir, "agents", `${memberId}.md`);
    try {
      const text = await readFile(candidate, "utf8");
      if (text.trim()) return text;
    } catch { /* 该版本没有这个成员 */ }
  }
  return null;
}
async function readMemberPersona(plugin, member) {
  const local = await localMemberPersona(plugin, member.id);
  if (local) return { text: local, source: "workbuddy-cache" };
  const promptFile = String(member.promptFile || `/plugins/${plugin}/agents/${member.id}.md`).trim();
  const text = await fetchText(EXPERT_ORIGIN + promptFile);
  if (!text.trim()) throw new Error("人设文件为空");
  return { text, source: "cdn" };
}
/**
 * 把团队成员的独立人设写成本机 md（不进 preset：5 份人设塞进系统提示会按轮计费）。
 * 主理人调度时先 read 出来再拼进 subagent 的 prompt，语义等同 WorkBuddy 的独立协作方。
 * @returns {Promise<{installed: Array, notes: string[], dir: string}>}
 */
export async function installTeamMemberPersonas(plugin, members, { onLog } = {}) {
  const installed = [];
  const notes = [];
  const dir = teamMemberDir(plugin);
  for (const member of Array.isArray(members) ? members : []) {
    // 主理人人设本身就是召唤预设的 persona，不需要再落一份。
    if (member.role === "lead") continue;
    try {
      const { text, source } = await readMemberPersona(plugin, member);
      await mkdir(dir, { recursive: true });
      const path = teamMemberPersonaPath(plugin, member.id);
      await writeFile(path, text);
      installed.push({ id: member.id, name: member.name, profession: member.profession, path, source });
      onLog?.(`团队成员 ${member.name || member.id}：人设已落盘（${source}）`);
    } catch (error) {
      notes.push(`团队成员 ${member.name || member.id} 人设获取失败：${error.message}`);
    }
  }
  return { installed, notes, dir };
}
export async function uninstallTeamMemberPersonas(plugin) {
  const dir = teamMemberDir(plugin);
  try {
    await rm(dir, { recursive: true, force: true });
    return dir;
  } catch {
    return null;
  }
}
/**
 * DSH 运行时桥接段：WorkBuddy 团队人设里的 TeamCreate / Agent(name, subagent_type)
 * 在 DSH 里不存在，这里给出等价映射。追加在主理人人设末尾，只在召唤时拼一次。
 * @param {object} detail wbExpertDetail 的返回值
 * @param {Map<string,string>} personaFiles 成员 ID → 已落盘的人设路径（未落盘则不传）
 */
// 桥接段的唯一识别标记：readExpertPresets 靠它在召唤预设的人设正文里判断
// 「这条团队预设带没带桥接段」。旧版本召唤写入的团队预设没有这段——那种预设下的
// 会话主理人会去调不存在的 TeamCreate / Agent，成员永远开不出来（用户实测症状）。
export const TEAM_BRIDGE_MARKER = "## DSH 运行时适配（团队协作桥接）";
/** 团队人设正文是否已带桥接段（用于现存召唤预设行的 stale 体检）。 */
export function hasTeamBridge(personaText) {
  return typeof personaText === "string" && personaText.includes(TEAM_BRIDGE_MARKER);
}
export function buildTeamBridge(detail, personaFiles) {
  const members = Array.isArray(detail?.members) ? detail.members : [];
  const others = members.filter((member) => member.role !== "lead");
  if (!others.length) return "";
  const rows = others.map((member) => {
    const file = personaFiles?.get(member.id);
    return `| \`${member.id}\` | ${member.name || "-"} | ${member.profession || "-"} | ${file ? `\`${file}\`` : "（人设未落盘，按职责执行）"} |`;
  });
  return [
    "",
    "---",
    "",
    "## DSH 运行时适配（团队协作桥接）",
    "",
    "本会话运行在 DSH 上，**没有 WorkBuddy 的 `TeamCreate` 与 `Agent` 工具**。团队编制已在召唤时固定，因此上文里「建立团队」「Agent 工具 name/subagent_type」两类指令按下面的等价方式执行；其余铁律（不得代写成员产出、成员之间不直连、一切经你中转）保持不变。",
    "",
    "1. **建团队 → 无需调用**：本会话即本团队，成员固定如下表，不需要创建、也不需要命名。",
    "2. **调度成员 → `subagent` 工具**：",
    "   - `description`：`<成员ID>：<阶段产出名>`，例如 `software-architect：系统设计与任务分解`。",
    "   - `prompt`：先用 `read` 读出该成员的人设文件（下表最后一列），把**人设正文原文**放在 prompt 最前面，接一行 `---`，再往下写本次任务、上游产出、期望交付物与验收标准。",
    "   - 顺序 SOP（PRD → 架构 → 实现 → QA）**必须**传 `run_in_background: false`，当场等它返回再往下走；只有互不依赖的并行任务才留默认后台模式。",
    "3. **成员产出**：子代理的最终回复就是该成员的专业产出，原文转交下一阶段，不要改写、不要替它编。",
    "4. **续聊追问**：需要同一成员接着干活时，用 `send_message` 继续它的会话 id，不要重新 spawn 一个同名成员。",
    "5. **上下文继承**：`subagent` 是干净上下文（更接近 WorkBuddy 的独立协作方）；只有确实需要它继承你当前会话上下文时才用 `subagent_fork`。",
    "",
    "### 团队编制",
    "",
    "| 成员 ID | 花名 | 职责 | 人设文件 |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
/**
 * 把「详情」变成真正可用的会话人设：单人专家原样返回，团队专家先落成员人设、
 * 再在末尾追加 DSH 桥接段。召唤预设与会话级挂载走同一条路径，保证两个入口一致。
 * @returns {Promise<{personaText: string, memberResult: object|null}>}
 */
export async function prepareExpertPersona(detail, { onLog, withMembers = true } = {}) {
  if (detail?.expertType !== "team") return { personaText: detail?.persona || "", memberResult: null };
  let memberResult = { installed: [], notes: [], dir: teamMemberDir(detail.plugin) };
  if (withMembers) {
    memberResult = await installTeamMemberPersonas(detail.plugin, detail.members, { onLog });
  }
  const files = new Map((memberResult.installed || []).map((row) => [row.id, row.path]));
  return { personaText: `${detail.persona}${buildTeamBridge(detail, files)}`, memberResult };
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
    // 带出人设正文（plugins[0] 的人设插件的 config.prefix），供 stale 体检：
    // 旧版本召唤写入的团队预设没有桥接段，读出来后前端能标「需更新」。
    let personaText = null;
    const plugins = config.get("plugins", true);
    if (isSeq(plugins) && plugins.items.length > 0 && isMap(plugins.items[0])) {
      const personaConfig = plugins.items[0].get("config", true);
      const prefix = personaConfig ? personaConfig.get("prefix", true) : null;
      if (prefix && typeof prefix.value === "string") personaText = prefix.value;
    }
    // 召唤那一刻就随预设行落盘的专家显示名：剥掉 `WorkBuddy 专家 · ` 前缀即得。
    // 目录缓存（readExpertDisplayNames）是首选来源——它有中英两套、且随目录刷新；
    // 但缓存没落盘、或该专家已从市场下架时只剩这一份可用。没有它，输入框召唤菜单
    // 只能回落到英文标识名（senior-developer 这种），对中文界面就是「没翻译」。
    // 用户在宿主里手改过预设名的，原样尊重（剥不到前缀就不剥）。
    const presetName = String(mapValue(config, "name") || "").trim();
    const displayName = presetName.startsWith(EXPERT_PRESET_NAME_PREFIX)
      ? presetName.slice(EXPERT_PRESET_NAME_PREFIX.length).trim()
      : presetName;
    rows.push({
      presetId: String(mapValue(entry, "id")),
      plugin: presetId.slice(EXPERT_PRESET_PREFIX.length),
      displayName,
      personaText,
    });
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
  config.set("name", `${EXPERT_PRESET_NAME_PREFIX}${spec.displayName}`);
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
  // OPT-08：原子写。直接覆盖写若中途断电/被杀，会留下截断的 JSON——readRecentRaw
  // 虽然会静默重置（只丢「最近使用」排序、不至于崩），但没必要留着这个窗口。
  //
  // 这里刻意用「临时文件 + rename」而不引 @deepseek-ai/dsh-atomic-write：那是宿主提供的
  // peer 依赖，本包 node_modules 里没有它，而 expert-market.js 会被 test/expert-manual.mjs
  // 直接 import —— 加静态导入会让本地测试当场 ERR_MODULE_NOT_FOUND。
  // 同目录 rename 在同一文件系统内是原子操作，足够。
  const target = recentPath();
  const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(data, null, 1));
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
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
        // 注意必须 await：漏 await 会拿到 Promise（truthy 且非字符串），后续
        // parsePatchDoc 直接抛 TypeError，导致整条 listExpertRecent 恒失败。
        patch = await readFile(join(homedir(), ".dsh", "profiles", "desktop", "cordis.patch.yml"), "utf8");
      } catch {
        patch = null;
      }
      // 对账用的 YAML 解析要单独兜底：patch 文件被用户改坏（yaml 抛 TypeError）只影响
      // 「预设还活着吗」这一个判断，回落 live=null 即可（= 不清记录、全部展示）；
      // 若让它抛出去，整个 listExpertRecent → wbExpertRecent RPC 会恒失败，
      // 客户端拿不到任何 kinds，「最近使用」排序整条链路失效——得不偿失。
      let live = null;
      try {
        live = patch ? new Set(readExpertPresets(patch).map((row) => row.plugin)) : null;
      } catch {
        live = null;
      }
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
