// WorkBuddy 市场直连 —— 连接器（MCP）与技能（SkillHub）两个市场的数据源与安装器。
//
// 数据源（2026-10-11 全部一手实测，均免登录）：
//   1. 连接器：https://static.workbuddy.cn/connectors-config-v2/connectors-config.zip
//      这是 WorkBuddy 桌面端连接器市场自己的分发地址（本机 WorkBuddy 的
//      connectors-marketplace/.meta.json 记录的就是它），ZIP 里 .codebuddy-connector/connectors.json
//      是索引（316 条），connectors/<id>/mcp.json 是每条的 MCP 配置，connectors/<id>/skills/**/SKILL.md
//      是该连接器附带的技能。ETag 变了才重新下载，ZIP 缓存在 ~/.dsh/wb-market/。
//   2. 技能：https://api.skillhub.cn —— SkillHub 的公开 JSON API（列表 /api/skills、
//      详情 /api/v1/skills/:slug、文件清单 /files、单文件 /file）。WorkBuddy 技能市场里
//      marketplaceSource 标 marketplace/skillhub 的技能都来自这里。
//
// 设计约束：
//   - 网络只发生在 Host 侧（浏览器不直连腾讯/SkillHub 域名）：面板经由 mcpManager Remote
//     命名空间调用本文件提供的方法，与既有预览/导入同一信封。
//   - 「能装」的标准从严：MCP 只收 streamable-http 与无 preAuth 的 stdio；CLI 型（cli.json）
//     与 server-side 鉴权只展示不装——宁可少，不可错。
//   - 技能安装逐文件校验 sha256（清单自带哈希）后再落盘，目标目录按 SkillHub 的
//     canonicalName 命名（`@tencent-adm/tencent-docs` → `tencent-adm__tencent-docs`），
//     与 dsh-skill-market 的命名并存不冲突（本插件不带 @ 前缀保留字）。
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ZipReader } from "./wb-zip.js";
// T02/R1：auth_injection_rules 只解析、只展示（X9 边界）——DSH 不做任何代注入，
// 这里只借用 T01 纯函数库的解析与按连接器命中能力。
import { parseInjectionRules, rulesFor, scanTokenSlots } from "./wb-auth-rules.js";
// T03/R4：连接器源不再硬编码单 URL——从多市场注册表取 sourceFor("connectors")，
// 读不到/损坏时回落内置默认（wb-registry.builtinMarketplaces 保证）。
import { sourceFor } from "./wb-registry.js";
// R8：鉴权失败的判定与 OAuth 客户端共用同一份实现（见 mcp-oauth.js 的 mcpAuthFailure）。
// 两家各写一套「什么算 401」迟早分叉，而分叉的代价是用户看不到授权入口。
import { mcpAuthFailure } from "./mcp-oauth.js";
// R8：安装状态账本读侧——wbSkillInstalled 用它给每条已装技能补 installedAt。
import { listInstalled } from "./wb-install-state.js";

const CONNECTOR_ZIP_URL = "https://static.workbuddy.cn/connectors-config-v2/connectors-config.zip";

/** R4：连接器市场源 URL。注册表第一条 connectors 源优先，缺失/读失败回落内置默认。 */
export async function connectorSourceUrl(options = {}) {
  const row = await sourceFor("connectors", options);
  const url = row && row.source && typeof row.source.url === "string" ? row.source.url : "";
  return url || CONNECTOR_ZIP_URL;
}
const SKILLHUB_ORIGIN = "https://api.skillhub.cn";
const USER_AGENT = "@2026heshao/dsh-armory (+https://github.com/2026heshao/dsh-armory)";
// 单文件/单响应上限：connectors.json ≈ 550KB、SKILL.md 最大几十 KB，8MB 已是十倍冗余。
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// ZIP 落盘缓存目录（~/.dsh 由 DSH 自己管理，这里只在它下面开一个子目录）。
function cacheDir() {
  // 测试隔离口（惯例同 wb-registry 的 DSH_ARMORY_HOME）：设置时缓存根指到临时目录。
  return process.env.DSH_ARMORY_MARKET_HOME || join(homedir(), ".dsh", "wb-market");
}
function zipPath() {
  return join(cacheDir(), "connectors-config.zip");
}
function metaPath() {
  return join(cacheDir(), "meta.json");
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Host 侧统一的 fetch + 上限 + UA。skillhub 对无 UA 的请求会 400。 */
async function fetchWithLimits(url, { timeoutMs = 30_000 } = {}) {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "application/json, application/zip, */*" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}（${url}）`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_RESPONSE_BYTES) throw new Error(`响应超过上限 ${Math.round(MAX_RESPONSE_BYTES / 1024 / 1024)}MB（${url}）`);
  return buffer;
}

// ── 连接器 ZIP：下载 + 缓存 ─────────────────────────────────────────────
// meta.json 记录远端 ETag；命中就不重复下 24MB。ZIP 本体损坏时丢弃缓存重新拉一次。
let cachedZip = null; // { zip: ZipReader, loadedFrom: "memory"|"disk"|"network" }
// 连接器图标的进程内缓存（id → data URL，null = 探过且没有）。换新 ZIP 时整体作废，
// 清空点在 loadConnectorZip 安装新包的两处。
const connectorIconCache = new Map();
/** 缓存正文用临时文件 + rename 落盘：写一半被杀只会留下无人读的 .tmp，不会留下截断的 ZIP。 */
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
async function loadConnectorZip() {
  if (cachedZip) return cachedZip;
  await mkdir(cacheDir(), { recursive: true });
  const meta = (await readJson(metaPath())) || {};
  // R4：注册表取源（缺失回落内置默认），ZIP 路径/缓存键不变——
  // 注册表只是改了「从哪下」，没有改「下到哪」。
  const sourceUrl = await connectorSourceUrl();
  const download = async (etag) => {
    const response = await fetch(sourceUrl, {
      headers: { "user-agent": USER_AGENT, ...(etag ? { "if-none-match": etag } : {}) },
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status === 304 && etag) return null;
    if (!response.ok) throw new Error(`连接器市场下载失败：HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 64 * 1024 * 1024) throw new Error("连接器市场包超过 64MB 上限，疑似异常响应");
    return { buffer, etag: response.headers.get("etag") || "" };
  };
  const persistNetwork = async (fresh) => {
    // ZipReader 构造即校验 central directory：坏包在这里抛，不会污染缓存。
    const zip = new ZipReader(fresh.buffer);
    await writeCacheFile(zipPath(), fresh.buffer);
    await writeCacheFile(metaPath(), JSON.stringify({ etag: fresh.etag, fetchedAt: Date.now() }));
    connectorIconCache.clear();
    cachedZip = { zip, loadedFrom: "network" };
    return cachedZip;
  };
  // 磁盘 ZIP 先验证好备用：它是 304（内容未变）与断网两条路的共同回落——
  // 「网络挂了就继续用旧缓存」靠它兑现。验证失败只回落到全量下载，不抛出去。
  let diskZip = null;
  try {
    diskZip = new ZipReader(await readFile(zipPath()));
  } catch {
    diskZip = null;
  }
  try {
    // 只在磁盘 ZIP 有效时才带 etag：本地包损坏/缺失而 etag 命中 304 的话，
    // 手上没有任何正文可用（旧实现此时会拿 null 去取 buffer，崩成 TypeError 且无自愈路径）。
    const fresh = await download(diskZip && meta.etag ? meta.etag : "");
    if (fresh) return await persistNetwork(fresh);
    // 304 = 服务器内容与 etag 一致 = 磁盘缓存就是权威副本。
    cachedZip = { zip: diskZip, loadedFrom: "disk" };
    return cachedZip;
  } catch {
    // 网络失败 / 上游包异常：有磁盘缓存就回落到它，绝不因为刷新失败把市场打空。
  }
  if (diskZip) {
    cachedZip = { zip: diskZip, loadedFrom: "disk" };
    return cachedZip;
  }
  throw new Error("连接器市场不可用：下载失败且本地没有有效的缓存副本");
}

// ── 连接器目录投影 ─────────────────────────────────────────────────────
// connectors.json 一条 → 面板卡片一条。installable 判定从严：
//   - 没有 mcp.json → 不可装（cli.json 型 / 纯技能包）
//   - mcp.json 带 preAuth（cli 鉴权、OAuth 注入）→ 不可装
//   - stdio 且 command 引用 WorkBuddy 专属连接器目录 → 不可装（那份 client.cjs 只有 WorkBuddy 有）
//   - env/header 引用 WorkBuddy 专有 token 注入 → 不可装
function isWorkbuddyOnlyCommand(command) {
  return typeof command === "string" && (command.includes("connectors-marketplace") || command.includes(".workbuddy"));
}

// ── T02 投影函数（R1/R2/R3）───────────────────────────────────────────
// 三个都是纯函数：输入 connectors.json 的原始形状，输出面板行需要的展示字段。
// 放在这里而不是 client.js，是因为它们处理的是「远端数据的形状防御」，与
// serverInstallability 同层；UI 只消费结果，不重复判形状。

/** R1：某条连接器的 token 注入规则标注。只数条数、不给注入物（X9：只展示不注入）。 */
export function injectionRuleNote(indexJson, connectorId) {
  const rules = rulesFor(parseInjectionRules(indexJson), connectorId);
  if (!rules.length) return { count: 0, note: "" };
  return {
    count: rules.length,
    note: `存在 ${rules.length} 条 token 注入规则（依赖 WB 账号体系，DSH 不代注入）`,
  };
}

/**
 * R2：visible_in 透传 + 标签筛选。实测为 key 数组（如 ["workbuddy","cline"]）；
 * 畸形（缺失/非数组/元素非字符串）一律归一成 []，调用方不需要再判形状。
 * 空数组 ≠ 「不可见」：上游没标就当作全部可见，筛选函数里不拦截。
 */
export function visibleInOf(entry) {
  const raw = entry?.visible_in;
  if (!Array.isArray(raw)) return [];
  return raw.map((tag) => (typeof tag === "string" ? tag.trim() : "")).filter(Boolean);
}

/** R2：本地筛选。visibleTags 为空（上游未标）= 不受该维度过滤；非空才要求包含。 */
export function matchesVisibleIn(rowVisibleTags, selectedTags) {
  if (!Array.isArray(selectedTags) || !selectedTags.length) return true;
  if (!Array.isArray(rowVisibleTags) || !rowVisibleTags.length) return true;
  const owned = new Set(rowVisibleTags.map((tag) => String(tag).toLowerCase()));
  return selectedTags.every((tag) => owned.has(String(tag).toLowerCase()));
}

/**
 * R3：examples 优先的展示文案。规则（设计文档 R3）：
 *   有 examples 且非空 → 正文用 examples（按语言 zh/en 选取）；
 *   否则回落 description；两者都无 → 空串（UI 自行回落到 name）。
 * 入参都是 connectors.json 条目的原样字段，畸形一律防御性回落。
 */
export function displayCopyOf(entry) {
  const pick = (list) => (Array.isArray(list) ? list.filter((item) => typeof item === "string" && item.trim()).filter(Boolean) : []);
  const zhExamples = pick(entry?.examples_zh);
  const enExamples = pick(entry?.examples_en);
  const examples = zhExamples.length ? zhExamples : enExamples;
  if (examples.length) {
    return { body: examples.join("\n"), from: "examples", examples };
  }
  const zh = typeof entry?.description_zh === "string" ? entry.description_zh : "";
  const fallbackZh = typeof entry?.description === "string" ? entry.description : "";
  const en = typeof entry?.description_en === "string" ? entry.description_en : "";
  const body = zh || fallbackZh || en;
  return { body, from: body ? "description" : "", examples: [] };
}

export function serverInstallability(serverName, rawServer, authMode = "") {
  const reasons = [];
  // R8：oauth / oneid-token 类不再拒装，而是标记「需走浏览器授权」，
  // 由 lib/mcp-oauth.js 在安装时驱动 RFC 9728/8414/7591/7636 全链路。
  let needsOAuth = false;
  const nested = rawServer && typeof rawServer.transport === "object" ? rawServer.transport : rawServer;
  // mcp.json 里的 stdio 条目本来就只有 command、不写 type（官方示例与各家 README 皆如此）。
  // 早前这里只认 nested.type：command 型条目 transport 落成空串，被文件末尾的
  // 「未知传输类型」判为拒装——凡是标准 stdio 连接器都装不上。缺 type 但有 command
  // 时按 stdio 处理，与下面返回处的 `transport || "stdio"` 兜底保持同一判断。
  // 同一条兜底也适用于远程条目：实测索引里有 11 条只写 url 不写 type
  // （qq-mail、lexiang、tencent-docs、tencent-docs-oa、tapd、github、notion…），
  // 一律撞「未知传输类型（缺失）」被判定装不上。有 url 就按 streamable-http 处理，
  // 与 lib/index.js 的 isOAuthCandidate（`spec.transport || "streamable-http"`）同口径。
  const declaredType = String(nested?.type ?? "").toLowerCase();
  const hasUrl = typeof nested?.url === "string" && nested.url.trim();
  const transport =
    declaredType ||
    (typeof nested?.command === "string" && nested.command.trim() ? "stdio" : "") ||
    (hasUrl ? "streamable-http" : "");
  // R7：先扫占位符槽位（env/headers 里的 ${...}）。这一扫描必须发生在 transport 的
  // 提前 return 之前——否则 streamable-http 型连接器的 header 占位符会被整段跳过，
  // 而 80+ 条 auth_mode=token 的连接器正是这个传输形态，正是「装不了」的成因之一。
  const tokenSlots = scanTokenSlots({ [serverName]: rawServer });
  const hasReplaceableSlots = tokenSlots.length > 0;
  // 索引 auth_mode 是比 mcp.json 更权威的鉴权声明：mcp.json 可能漏标（如 tec-do 裸 URL），
  // 但索引里标了鉴权的连接器 DSH 无法自动注入凭据，装上必 401，必须在列表层就拦下。
  const mode = String(authMode || "").trim().toLowerCase();
  if (mode === "token") {
    // R7：token 型由「一律拒装」改为「可装但需引导填 token」。
    // 有可替换占位符 → 放行（UI 弹令牌框）；无占位符 → 用户无从填起，仍然拒装。
    if (!hasReplaceableSlots) {
      reasons.push("该连接器需要 token 凭据，但 mcp.json 未声明可替换的 ${...} 槽位，DSH 无法代填");
    }
  } else if (mode === "oauth" || mode === "oneid-token") {
    // R8：凭据改由插件侧 OAuth 授权流程获取（浏览器授权 → token 落盘 → 注入
    // authorization header），所以这里放行并打上需授权标记。
    needsOAuth = true;
  } else if (mode === "server-side" || mode === "mcp") {
    reasons.push(`该连接器需要 ${mode} 凭据，DSH 无法自动注入`);
  } else if (mode) {
    // 未知 auth_mode 值保守处理：宁可少装不错装（与本文件「能装的标准从严」同一纪律）。
    reasons.push(`该连接器需要未知类型的鉴权（auth_mode=${mode}），DSH 无法自动注入`);
  }
  const needsTokens = hasReplaceableSlots;
  if (transport === "streamablehttp" || transport === "streamable-http" || transport === "http") {
    return { ok: reasons.length === 0, transport: "streamable-http", reasons, tokenSlots, needsTokens, needsOAuth };
  }
  if (transport === "sse" || transport === "ws") reasons.push(`传输 ${transport} 不受 DSH 支持`);
  if (rawServer?.preAuth) reasons.push("需要 WorkBuddy 的 preAuth 鉴权链路");
  if (typeof nested?.command === "string" && isWorkbuddyOnlyCommand(nested.command)) reasons.push("command 依赖 WorkBuddy 本机连接器目录");
  const envKeys = Object.keys(nested?.env || {});
  const headerKeys = Object.keys(nested?.headers || {});
  // R7：已有可替换占位符的，交给 needsTokens 引导用户填，不再重复算作拒装理由；
  // 反之（键名像凭据但值里没有 ${...} 槽位）无从填起，仍然拒装。
  if (!hasReplaceableSlots
    && (envKeys.some((key) => /token|secret|key/i.test(key)) || headerKeys.some((key) => /authorization|token/i.test(key)))) {
    reasons.push("需要 WorkBuddy 的 token 注入，DSH 无法代填");
  }
  if (!reasons.length && transport !== "stdio") reasons.push(`未知传输类型 ${transport || "（缺失）"}`);
  return { ok: reasons.length === 0, transport: transport || "stdio", reasons, tokenSlots, needsTokens, needsOAuth };
}

/** connectors.json 索引 + 每条的可装性标注。UI 列表唯一数据源。 */
export async function wbConnectorCatalog() {
  const { zip, loadedFrom } = await loadConnectorZip();
  const index = JSON.parse(zip.extract(".codebuddy-connector/connectors.json").toString("utf8"));
  const rows = [];
  for (const entry of index.connectors || []) {
    const id = String(entry.id || entry.source || "").trim();
    if (!id) continue;
    let mcpJson = null;
    let skillCount = 0;
    try {
      const raw = JSON.parse(zip.extract(`connectors/${id}/mcp.json`).toString("utf8"));
      mcpJson = raw;
    } catch {
      mcpJson = null;
    }
    if (zip.has(`connectors/${id}/skills/`)) {
      for (const name of zip.entries.keys()) {
        if (name.startsWith(`connectors/${id}/skills/`) && name.endsWith("skill.md")) skillCount += 1;
      }
    }
    // mcp.json 可能一条目录带多个 mcpServers；逐个判可装性，全部可装才算可装（安装时逐条写入）。
    const servers = mcpJson?.mcpServers && typeof mcpJson.mcpServers === "object" ? Object.entries(mcpJson.mcpServers) : [];
    const checks = servers.map(([serverName, rawServer]) => ({ serverName, rawServer, ...serverInstallability(serverName, rawServer, entry.auth_mode) }));
    const blocked = checks.filter((check) => !check.ok);
    // R3：examples 优先（zh → en 回落），description 只作兜底正文。
    const copy = displayCopyOf(entry);
    rows.push({
      id,
      name: entry.name || id,
      nameEn: entry.name_en || "",
      description: entry.description_zh || entry.description || entry.description_en || "",
      descriptionEn: entry.description_en || "",
      // R3 投影：UI 优先用 displayBody（examples 语义），from 让 UI 知道在展示什么。
      displayBody: copy.body,
      displayFrom: copy.from,
      examples: copy.examples,
      // R2：visible_in 标签（上游未标 = 空数组 = 不受筛选）。
      visibleIn: visibleInOf(entry),
      // R1：token 注入规则条数标注（只展示；DSH 不代注入）。
      injectionRuleCount: injectionRuleNote(index, id).count,
      // R7：可装性拆分投影——needsTokens 为 true 时 UI 应弹令牌引导框。
      needsTokens: checks.some((check) => check.needsTokens),
      // R8：needsOAuth 为 true 时 UI 应走「浏览器授权」引导（而不是拒装/令牌框）。
      needsOAuth: checks.some((check) => check.needsOAuth),
      tokenSlots: checks.flatMap((check) => check.tokenSlots || []),
      authMode: entry.auth_mode || "",
      version: entry.version || "",
      type: entry.type || "",
      skillCount,
      serverNames: checks.map((check) => check.serverName),
      transport: checks[0]?.transport || "",
      installable: mcpJson !== null && servers.length > 0 && blocked.length === 0,
      blockedReason: mcpJson === null
        ? "非 MCP 型连接器（CLI 型或纯技能包）"
        : servers.length === 0
          ? "mcp.json 里没有可导入的 server"
          : blocked[0]?.reasons.join("；") || "",
    });
  }
  return { loadedFrom, total: rows.length, connectors: rows };
}

/** 预览某条连接器的 MCP 配置（安装前给用户看的真实 JSON）。 */
export async function wbConnectorPreview(connectorId) {
  const id = String(connectorId || "").trim();
  const { zip } = await loadConnectorZip();
  const raw = JSON.parse(zip.extract(`connectors/${id}/mcp.json`).toString("utf8"));
  const servers = raw?.mcpServers && typeof raw.mcpServers === "object" ? raw.mcpServers : null;
  if (!servers || !Object.keys(servers).length) throw new Error(`连接器 ${id} 没有 mcpServers 可导入`);
  return { connectorId: id, mcpServers: servers };
}

// ── 连接器图标 ─────────────────────────────────────────────────────────
// 索引 connectors.json 里没有 icon 字段，但 ZIP 顶层有 icons/ 目录，文件名就是
// 连接器 id（2026-10-24 实测 443/443 全覆盖），所以按 id 猜扩展名，svg 优先于位图
// （矢量在 30px 头像位最清晰）。图标只在卡片进视口时被调到这里，单条平均 27KB；
// 走 data URL 内联而不是宿主文件路径——面板是 webview，读不到本机文件。
const CONNECTOR_ICON_EXTS = [".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif"];
const CONNECTOR_ICON_MIME = {
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** 某条连接器的图标（data URL 形式）。没有/包没就绪都返回 ok:false，UI 回落首字母。 */
export async function wbConnectorIcon(connectorId) {
  const id = String(connectorId || "").trim();
  const missing = { ok: false, connectorId: id, dataUrl: "" };
  // id 来自我们自己的目录投影，仍防一层路径注入（query 由 RPC 进来，不信任输入）。
  if (!id || /[\\/\s]/.test(id) || id.includes("..")) return missing;
  if (connectorIconCache.has(id)) {
    const dataUrl = connectorIconCache.get(id);
    return dataUrl ? { ok: true, connectorId: id, dataUrl } : missing;
  }
  let zip;
  try {
    ({ zip } = await loadConnectorZip());
  } catch {
    // 包没就绪（如首次下载失败）：不缓存这条「没有」，卡片下次进视口还能再试。
    return missing;
  }
  const ext = CONNECTOR_ICON_EXTS.find((candidate) => zip.has(`icons/${id}${candidate}`));
  if (!ext) {
    connectorIconCache.set(id, null);
    return missing;
  }
  const dataUrl = `data:${CONNECTOR_ICON_MIME[ext]};base64,${zip.extract(`icons/${id}${ext}`).toString("base64")}`;
  connectorIconCache.set(id, dataUrl);
  return { ok: true, connectorId: id, dataUrl };
}

/**
 * 装前 401 探测：对 streamable-http 型 server 发一次 MCP initialize JSON-RPC，
 * 服务器明确要凭据就回报 needsAuth。索引 auth_mode 会漏标（tec-do 的 mcp.json 是裸 URL、
 * 索引 auth_mode 也为空，装完连接必 401 "Version negotiation failed"）——这是漏标鉴权的
 * 最后防线。判定刻意保守：只有「401/403」或「其它 4xx 且响应体点名是 token/鉴权问题」
 * 才拦，超时/5xx/网络错误/其它状态一律放行——探测挂了不能误伤正常连接器，宁可让个别
 * 服务器在连接时报错。响应体这一路不能省：腾讯 ima 在凭据是坏的时候回的是 HTTP 400 +
 * `msg:token parse failed`（且不带 WWW-Authenticate），只看状态码就会把它判成
 * 「匿名可用」直接写配置，用户既装不上也等不到授权页。
 * 返回 { authorized: true }（放行）或 { authorized:false, needsAuth:true, ... }。
 */
export async function probeServerAuthorization(serverName, rawServer) {
  const nested = rawServer && typeof rawServer.transport === "object" ? rawServer.transport : rawServer;
  const url = String(nested?.url || "").trim();
  // transport 缺省判定与 serverInstallability 必须同口径：只写 url 不写 type 的条目
  // （索引里实有 11 条）在那边按 streamable-http 放行，这里若按「非 HTTP 型」跳过，
  // 漏标鉴权的最后防线对它们就正好失效。
  const transport = String(nested?.type ?? "").toLowerCase() || (url ? "streamable-http" : "");
  // 只探测 HTTP 型：stdio 没有可探测的 URL，sse/ws 本来就被准入闸拦下。
  if (transport !== "streamablehttp" && transport !== "streamable-http" && transport !== "http") return { authorized: true, skipped: true };
  if (!url) return { authorized: true, skipped: true };
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "dsh-armory", version: "1.0.0" },
    },
  });
  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        // 透传 mcp.json 里该 server 已声明的 headers（例如部分连接器带公共 UA/token 模板）。
        ...Object.fromEntries(Object.entries(nested?.headers || {}).map(([key, value]) => [String(key).toLowerCase(), String(value)])),
        "user-agent": USER_AGENT,
      },
      body,
      signal: AbortSignal.timeout(8_000),
    });
  } catch {
    // 超时 / DNS 失败 / 连接拒绝：探测不了就放行，安装后由用户实测。
    return { authorized: true, error: "probe-unreachable" };
  }
  // 正文既用于「非 401 的鉴权失败」判定，也是面板里最有信息量的一行提示。
  const bodyText = await response.text().catch(() => "");
  if (mcpAuthFailure(response.status, bodyText)) {
    // R8：不再把鉴权失败当致命错误。改回传结构化「需授权」，由上层触发浏览器授权流程：
    // 解析 WWW-Authenticate 里的 resource_metadata，交给 lib/mcp-oauth.js 继续走
    // RFC 9728（资源元数据）→ RFC 8414（AS 元数据）→ RFC 7591（动态注册）→ RFC 7636（PKCE）。
    const wwwAuthenticate = String(response.headers.get("www-authenticate") || "");
    return {
      authorized: false,
      needsAuth: true,
      status: response.status,
      url,
      serverName,
      wwwAuthenticate,
      resourceMetadata: extractResourceMetadata(wwwAuthenticate),
      bodyHint: String(bodyText || "").replace(/\s+/g, " ").trim().slice(0, 300),
    };
  }
  // 200/202/其它 4xx/5xx：都视为「没有明确拒绝匿名握手」，放行。
  return { authorized: true, status: response.status };
}

/** 从 WWW-Authenticate 里取 resource_metadata="..."（RFC 9728 的入口指针）。 */
function extractResourceMetadata(header) {
  const match = String(header || "").match(/resource_metadata\s*=\s*"([^"]+)"/i)
    || String(header || "").match(/resource_metadata\s*=\s*([^\s,]+)/i);
  return match ? match[1].trim() : "";
}

/** 安装前对整份 mcpServers 逐个探测；把「需授权」的 server 聚合成清单回报，绝不中止安装。 */
export async function probeMcpServersAuthorization(mcpServers) {
  const servers = mcpServers && typeof mcpServers === "object" ? Object.entries(mcpServers) : [];
  const needsAuth = [];
  for (const [serverName, rawServer] of servers) {
    const probe = await probeServerAuthorization(serverName, rawServer);
    if (probe?.needsAuth) needsAuth.push(probe);
  }
  return { ok: true, checked: servers.length, needsAuth };
}

/**
 * 只读磁盘缓存的市场条目计数（供顶栏 chip 常驻显示，绝不联网）。
 * 磁盘上有 connectors-config.zip 就直接解索引计数；没有就返回 total:null，
 * 等「市场页真实打开过一次」（那会走完整下载并落缓存）之后再查就有数字了。
 * 单独存在的意义：wbConnectorCatalog 即使热缓存也会做一次 304 网络探测，
 * 冷缓存更是 24MB 下载——为顶栏一个数字触发这两者都不值得。
 */
export async function wbConnectorCachedCount() {
  try {
    const local = await readFile(zipPath());
    const zip = new ZipReader(local);
    const index = JSON.parse(zip.extract(".codebuddy-connector/connectors.json").toString("utf8"));
    const connectors = Array.isArray(index.connectors) ? index.connectors : [];
    return { total: connectors.filter((entry) => String(entry.id || entry.source || "").trim()).length };
  } catch {
    return { total: null };
  }
}

// ── SkillHub 技能市场 ─────────────────────────────────────────────────
// 列表：/api/skills?sortBy=downloads|installs|stars|score&page=N&pageSize=60&keyword=..&category=..
// 详情：/api/v1/skills/:slug?namespace=<handle>（带 latestVersion、publisher、securityReports）
// 文件：/api/v1/skills/:slug/files?namespace=<handle>[&version=]；/file 同形 + &path=
// namespace 用 namespace.handle（列表项里是对象）， 不是 canonicalName。
const SKILLHUB_PUBLIC_ORIGIN = "https://skillhub.cn";
/**
 * 把 SkillHub 的 homepage 归一成「浏览器能打开」的地址（issue #4）。
 * 上游列表/详情的 homepage 实际是 `https://api.skillhub.cn/<namespace>/<slug>`——那是
 * JSON 接口，浏览器直接打开只得到 405。人可读页面在 `https://skillhub.cn/<namespace>/<slug>`
 * （2026-10 实测 200 text/html）。优先用 namespace + slug 自己拼公开页，这样即使上游
 * 换成别的内部域名也不会把接口地址交给浏览器；GitHub 等其它可浏览地址原样保留。
 */
export function skillhubHomepage(rawHomepage, namespace, slug) {
  const handle = String(namespace || "").trim();
  const skillSlug = String(slug || "").trim();
  const publicPage = handle && skillSlug
    ? `${SKILLHUB_PUBLIC_ORIGIN}/${encodeURIComponent(handle)}/${encodeURIComponent(skillSlug)}`
    : "";
  const raw = String(rawHomepage || "").trim();
  if (!raw) return publicPage;
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return raw;
  }
  if (parsed.hostname.toLowerCase() === "api.skillhub.cn") {
    return publicPage || `${SKILLHUB_PUBLIC_ORIGIN}${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  return raw;
}
const SKILLHUB_SORTS = new Set(["downloads", "installs", "stars", "score"]);
// 2026-10 实测（api.skillhub.cn）：`sortBy=downloads` 已不再是可用值——TCP 能连上、
// 但服务端不回任何字节，一直挂到客户端 AbortSignal 超时；installs / stars / score /
// updated 仍正常，非法值（download、hot、new…）会立刻 400 而不是挂起。
// 所以下载量排序不再发给上游，改成本地按当前页排序（见 wbSkillCatalog 尾部）。
const SKILLHUB_REMOTE_SORTS = new Set(["installs", "stars", "score"]);
async function skillhubJson(path, { timeoutMs = 15_000 } = {}) {
  let buffer;
  try {
    buffer = await fetchWithLimits(`${SKILLHUB_ORIGIN}${path}`, { timeoutMs });
  } catch (e) {
    // 超时是上游最常见的一种失败（挂起而非 4xx），把 Node 的英文原文换成能看懂的中文。
    const name = e && e.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`SkillHub 在 ${Math.round(timeoutMs / 1000)} 秒内没有响应，已放弃本次请求；稍后重试即可。`);
    }
    throw e;
  }
  const body = JSON.parse(buffer.toString("utf8"));
  // SkillHub 的业务错误也在 200 里（code !== 0）。
  if (body && typeof body.code === "number" && body.code !== 0) throw new Error(`SkillHub 返回错误：${body.message || body.code}`);
  return body;
}
export async function wbSkillCatalog(payload = {}) {
  const page = Math.max(1, Math.min(200, Number(payload.page) || 1));
  const pageSize = Math.max(1, Math.min(60, Number(payload.pageSize) || 20));
  const sort = SKILLHUB_SORTS.has(payload.sort) ? payload.sort : "downloads";
  const remoteSort = SKILLHUB_REMOTE_SORTS.has(sort) ? sort : "";
  // 只把上游确认可用的排序发出去：`sortBy=downloads` 会挂起（见 SKILLHUB_REMOTE_SORTS）。
  // 不带 sortBy 时上游按自己的默认序返回，参数缺失不会 400（已实测）。
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (remoteSort) params.set("sortBy", remoteSort);
  const keyword = String(payload.keyword || "").trim();
  if (keyword) params.set("keyword", keyword.slice(0, 64));
  const category = String(payload.category || "").trim();
  if (category) params.set("category", category.slice(0, 64));
  const body = await skillhubJson(`/api/skills?${params.toString()}`);
  const skills = Array.isArray(body?.data?.skills) ? body.data.skills : [];
  const rows = skills.map((skill) => {
    const slug = String(skill.slug || "");
    const namespace = String(skill.namespace?.handle || "");
    const homepage = skillhubHomepage(skill.homepage, namespace, slug);
    return {
      slug,
      name: String(skill.name || skill.slug || ""),
      namespace,
      canonical: String(skill.namespace?.canonicalName || ""),
      // 「人」的字段：发布方显示名、作品图标、公开详情页、上架时间与认领状态。
      // 这些字段列表接口本来就有，不额外发请求——卡片上的人味信号零成本。
      ownerName: String(skill.ownerName || skill.namespace?.displayName || skill.namespace?.handle || ""),
      iconUrl: String(skill.iconUrl || ""),
      // 上游把 homepage 填成了 api.skillhub.cn 的 JSON 地址（405），换成公开页。
      homepage,
      createdAt: Number(skill.created_at) || 0,
      claimState: String(skill.claim_state || ""),
      source: String(skill.source || ""),
      description: String(skill.description_zh || skill.description || ""),
      descriptionEn: String(skill.description_en || ""),
      downloads: Number(skill.downloads) || 0,
      installs: Number(skill.installs) || 0,
      stars: Number(skill.stars) || 0,
      score: Number(skill.score) || 0,
      version: String(skill.version || ""),
      verified: !!skill.verified,
      updatedAt: Number(skill.updated_at) || 0,
      category: String(skill.category || ""),
      tags: Array.isArray(skill.tags) ? skill.tags.slice(0, 6).map(String) : [],
      // upstream_url 是真正的外部来源（GitHub / ClawHub）：能打开就保留，缺失回落公开页。
      upstreamUrl: skillhubHomepage(skill.upstream_url, namespace, slug) || homepage,
    };
  }).filter((skill) => skill.slug && skill.namespace);
  // 下载量排序上游已不可用，退化为「当前页内按下载量降序」：跨页顺序仍是上游默认序，
  // 所以这是页内排序而不是全库排序（UI 侧「最多下载」的含义随之收窄，见下）。
  if (!remoteSort) rows.sort((a, b) => b.downloads - a.downloads);
  return {
    page,
    pageSize,
    sort,
    keyword,
    category,
    total: Number(body?.data?.total) || 0,
    skills: rows,
  };
}
export async function wbSkillDetail(payload = {}) {
  const slug = String(payload?.slug || "").trim();
  const namespace = String(payload?.namespace || "").trim();
  if (!slug || !namespace) throw new Error("缺少 slug 或 namespace");
  const body = await skillhubJson(`/api/v1/skills/${encodeURIComponent(slug)}?namespace=${encodeURIComponent(namespace)}`);
  // 详情端点**没有** {code,data,message} 包装：latestVersion 等字段直接在根上
  // （列表端点才有 data 包装）。两种形状都兼容，避免上游改包装方式时把面板打空。
  const data = body?.latestVersion ? body : (body?.data || {});
  // 技能本体挂在 data.skill 下，字段名与列表不同（displayName / summary_zh / summary /
  // iconUrl），根层没有 name、description、homepage。只读根层会得到「标题退化成 slug、
  // 介绍空白」（issue #4 实测）。下面逐字段回退到列表的旧字段名，两种形状都兼容。
  const skill = data.skill && typeof data.skill === "object" ? data.skill : {};
  const handle = String(data.namespace?.handle || namespace);
  const reports = data.securityReports && typeof data.securityReports === "object" ? data.securityReports : {};
  const reportStatus = Object.values(reports).map((report) => String(report?.status || "")).filter(Boolean);
  return {
    slug,
    namespace: handle,
    name: String(skill.displayName || data.name || slug),
    version: String(data.latestVersion?.version || ""),
    changelog: String(data.latestVersion?.changelog || ""),
    description: String(skill.summary_zh || skill.summary || data.description_zh || data.description || ""),
    iconUrl: String(skill.iconUrl || data.iconUrl || ""),
    ownerName: String(data.owner?.displayName || data.namespace?.displayName || ""),
    publisher: String(data.publisher?.name || data.owner?.displayName || ""),
    verifiedPublisher: !!data.publisher?.verified,
    certifiedName: String(data.publisher?.certifiedName || ""),
    security: reportStatus.length ? reportStatus : ["unknown"],
    // 详情根层没有 homepage；公开页由 namespace + slug 拼，绝不把 api.skillhub.cn 交出去。
    homepage: skillhubHomepage(data.homepage || skill.homepage, handle, slug),
    // 详情缺 createdAt 时不回 0：列表项自带的上架时间会被 0 覆盖掉。
    ...(Number(skill.createdAt) ? { createdAt: Number(skill.createdAt) } : {}),
    category: String(skill.category || ""),
    source: String(skill.source || ""),
  };
}
export async function wbSkillFiles(payload = {}) {
  const slug = String(payload?.slug || "").trim();
  const namespace = String(payload?.namespace || "").trim();
  if (!slug || !namespace) throw new Error("缺少 slug 或 namespace");
  const params = new URLSearchParams({ namespace });
  if (payload?.version) params.set("version", String(payload.version));
  const body = await skillhubJson(`/api/v1/skills/${encodeURIComponent(slug)}/files?${params.toString()}`);
  const files = Array.isArray(body?.files) ? body.files : [];
  return {
    version: String(body?.version || payload?.version || ""),
    files: files.map((file) => ({ path: String(file.path || ""), size: Number(file.size) || 0, sha256: String(file.sha256 || "") })),
  };
}

// ── 技能安装：落盘到用户技能目录 ────────────────────────────────────────
// 目标根目录与官方 skill 子系统的发现范围对齐：~/.agents/skills（SKILL_SOURCE_LABELS 里的
// user-agents，优先级高于 ~/.dsh/skills）。装完即被注册表发现，无需重启。
function skillTargetName(namespace, slug) {
  // 单段防路径穿越：handle / slug 都可能被恶意构造，只留安全字符。
  const safe = (value) => String(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "x";
  return `${safe(namespace)}__${safe(slug)}`;
}
// 并发安装互斥（按目标目录加锁）。双击、卡片+详情同时点、面板重挂载后再点，都会让
// 同一技能有两个安装任务在飞：两者交错执行同一路径上的 rm(staging)/rm(finalDir)/rename，
// 轻则留下残包（缺 SKILL.md → 注册表永远发现不了，即「显示安装成功但 Skill 看板里没有」），
// 重则一个任务删掉另一个刚装好的目录、自己的 rename 又失败 → 「报成功但磁盘上什么都没有」，
// 之后卸载还会撞「本机没有安装记录」。UI 的 busy 禁用挡不住所有入口（重挂载即重置），
// 宿主侧串行化才是根修：RPC 可从任意处调用，落盘顺序必须由这里保证。
const skillInstallLocks = new Map();
export async function wbSkillInstall(payload = {}, { onProgress } = {}) {
  const slug = String(payload?.slug || "").trim();
  const namespace = String(payload?.namespace || "").trim();
  if (!slug || !namespace) throw new Error("缺少 slug 或 namespace");
  const finalDir = join(homedir(), ".agents", "skills", skillTargetName(namespace, slug));
  const previous = skillInstallLocks.get(finalDir);
  let run;
  // 前序任务失败不该连坐后序：catch 吞掉前序拒绝后再排自己的。
  const queued = previous ? previous.catch(() => {}) : Promise.resolve();
  run = queued
    .then(() => installSkillLocked(payload, { onProgress }, finalDir))
    .finally(() => {
      if (skillInstallLocks.get(finalDir) === run) skillInstallLocks.delete(finalDir);
    });
  skillInstallLocks.set(finalDir, run);
  return run;
}
async function installSkillLocked(payload = {}, { onProgress } = {}, finalDir) {
  const slug = String(payload?.slug || "").trim();
  const namespace = String(payload?.namespace || "").trim();
  const requestedName = String(payload?.name || "").trim();
  const listing = await wbSkillFiles(payload);
  if (!listing.files.length) throw new Error("该技能没有可下载的文件");
  if (listing.files.length > 400) throw new Error(`文件数超出上限（${listing.files.length} > 400）`);
  const stagingDir = `${finalDir}.installing`;
  const totalBytes = listing.files.reduce((sum, file) => sum + file.size, 0);
  if (totalBytes > 32 * 1024 * 1024) throw new Error(`技能总体积超过 32MB 上限（${Math.round(totalBytes / 1024 / 1024)}MB）`);
  // 必须有 SKILL.md，否则装了也不会被注册表发现——直接拒绝而不是装个哑包。
  const hasSkillMd = listing.files.some((file) => file.path === "SKILL.md");
  if (!hasSkillMd) throw new Error("清单里没有 SKILL.md，不是标准技能包，拒绝安装");
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  let doneBytes = 0;
  try {
    for (const [index, file] of listing.files.entries()) {
      const relative = file.path;
      // 路径安全：解析后必须落在 staging 内（拒绝 ../、绝对路径、盘符）。
      const target = resolve(stagingDir, relative);
      if (target !== stagingDir && !target.startsWith(stagingDir + sep)) throw new Error(`清单里的非法路径：${relative}`);
      const params = new URLSearchParams({ namespace, path: relative });
      if (listing.version) params.set("version", listing.version);
      const buffer = await fetchWithLimits(`${SKILLHUB_ORIGIN}/api/v1/skills/${encodeURIComponent(slug)}/file?${params.toString()}`);
      if (file.sha256 && buffer.length) {
        const digest = createHash("sha256").update(buffer).digest("hex");
        if (digest !== file.sha256) throw new Error(`文件校验失败（${relative}）：sha256 不匹配`);
      }
      await mkdir(resolve(stagingDir, relative, ".."), { recursive: true });
      await writeFile(target, buffer);
      doneBytes += buffer.length;
      onProgress?.({ phase: "downloading", index: index + 1, total: listing.files.length, bytes: doneBytes, totalBytes });
    }
    // 最终位置已被占用（同名/换版本重装）：先挪开旧的，再原子换入。
    await rm(finalDir, { recursive: true, force: true });
    await rename(stagingDir, finalDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  // 落盘后逐文件复核：清单里的每个路径都必须真实存在才许报成功。缺 SKILL.md 的残包
  // 不会被注册表发现（「显示成功但看板里没有」的假安装），宁可清掉现场报失败，
  // 也不留一个挂着「已安装」却永远不生效的哑目录。
  for (const file of listing.files) {
    try {
      await stat(resolve(finalDir, file.path));
    } catch {
      await rm(finalDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`安装后校验失败：${file.path} 未落盘（${finalDir}），已清理现场，请重试`);
    }
  }
  return {
    note: `已安装到 ${finalDir}（${listing.files.length} 个文件${listing.version ? `，v${listing.version}` : ""}），即刻生效`,
    dir: finalDir,
    name: requestedName || slug,
    version: listing.version,
  };
}
export async function wbSkillUninstall(payload = {}) {
  const slug = String(payload?.slug || "").trim();
  const namespace = String(payload?.namespace || "").trim();
  if (!slug || !namespace) throw new Error("缺少 slug 或 namespace");
  const targetName = skillTargetName(namespace, slug);
  const finalDir = join(homedir(), ".agents", "skills", targetName);
  try {
    await stat(finalDir);
  } catch {
    throw new Error("本机没有这个市场技能的安装记录（可能已卸载或由其它工具安装）");
  }
  await rm(finalDir, { recursive: true, force: true });
  return { note: `已卸载 ${targetName}` };
}
/** 已装的市场技能（安装记录即目录本身），用于卡片上的「已安装」标记与卸载。
 *  installedAt：安装时间（毫秒时间戳，0 = 完全取不到）。取值优先级：
 *    ① 安装状态账本（kind=skill 按 installPath 对齐）登记的首次安装时间；
 *    ② 目录创建时间——重装是 rm 后 rename 换入新目录，创建时间即最近一次安装；
 *    ③ 目录修改时间兜底（个别文件系统不吐 birthtime）。
 *  账本读失败只降级到 ②③，不影响已装列表本身。 */
export async function wbSkillInstalled() {
  const root = join(homedir(), ".agents", "skills");
  const rows = [];
  let names = [];
  try {
    names = await readdir(root);
  } catch {
    return { installed: [] };
  }
  const ledger = await listInstalled("skill").catch(() => []);
  const ledgerAt = new Map(
    ledger.filter((row) => row && row.installPath).map((row) => [row.installPath, row.installedAt || 0]),
  );
  for (const name of names) {
    if (!name.includes("__")) continue;
    const [namespace, ...slugParts] = name.split("__");
    const dir = join(root, name);
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) continue;
      const bornAt = Math.round(Number(info.birthtimeMs) || 0);
      rows.push({
        dirName: name,
        namespace,
        slug: slugParts.join("__"),
        dir,
        installedAt: ledgerAt.get(dir) || bornAt || Math.round(Number(info.mtimeMs) || 0),
      });
    } catch {
      // 竞态删除：跳过
    }
  }
  return { installed: rows };
}
