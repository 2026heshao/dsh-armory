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
//     与 server-side 鉴权只展示不装——宁可少，不可错（与 mcp-catalog.js 同一纪律）。
//   - 技能安装逐文件校验 sha256（清单自带哈希）后再落盘，目标目录按 SkillHub 的
//     canonicalName 命名（`@tencent-adm/tencent-docs` → `tencent-adm__tencent-docs`），
//     与 dsh-skill-market 的命名并存不冲突（本插件不带 @ 前缀保留字）。
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { ZipReader } from "./wb-zip.js";

const CONNECTOR_ZIP_URL = "https://static.workbuddy.cn/connectors-config-v2/connectors-config.zip";
const SKILLHUB_ORIGIN = "https://api.skillhub.cn";
const USER_AGENT = "@2026heshao/dsh-skill-mcp-board (+https://github.com/2026heshao/dsh-skill-mcp-board)";
// 单文件/单响应上限：connectors.json ≈ 550KB、SKILL.md 最大几十 KB，8MB 已是十倍冗余。
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
// ZIP 落盘缓存目录（~/.dsh 由 DSH 自己管理，这里只在它下面开一个子目录）。
function cacheDir() {
  return join(homedir(), ".dsh", "wb-market");
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
async function loadConnectorZip() {
  if (cachedZip) return cachedZip;
  await mkdir(cacheDir(), { recursive: true });
  const meta = (await readJson(metaPath())) || {};
  const download = async (etag) => {
    const response = await fetch(CONNECTOR_ZIP_URL, {
      headers: { "user-agent": USER_AGENT, ...(etag ? { "if-none-match": etag } : {}) },
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status === 304 && etag) return null;
    if (!response.ok) throw new Error(`连接器市场下载失败：HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 64 * 1024 * 1024) throw new Error("连接器市场包超过 64MB 上限，疑似异常响应");
    return { buffer, etag: response.headers.get("etag") || "" };
  };
  let zip = null;
  if (meta.etag) {
    // 有缓存：先验证磁盘上的 ZIP 还能用，能用就 304 探测上游；网络挂了就继续用旧缓存。
    try {
      const local = await readFile(zipPath());
      zip = new ZipReader(local);
      const fresh = await download(meta.etag);
      if (fresh === null) {
        cachedZip = { zip, loadedFrom: "disk" };
        return cachedZip;
      }
      zip = new ZipReader(fresh.buffer);
      await writeFile(zipPath(), fresh.buffer);
      await writeFile(metaPath(), JSON.stringify({ etag: fresh.etag, fetchedAt: Date.now() }));
      cachedZip = { zip, loadedFrom: "network" };
      return cachedZip;
    } catch {
      zip = null;
    }
  }
  const fresh = await download(meta.etag || "");
  zip = new ZipReader(fresh.buffer);
  await writeFile(zipPath(), fresh.buffer);
  await writeFile(metaPath(), JSON.stringify({ etag: fresh.etag, fetchedAt: Date.now() }));
  cachedZip = { zip, loadedFrom: "network" };
  return cachedZip;
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
function serverInstallability(serverName, rawServer) {
  const reasons = [];
  const nested = rawServer && typeof rawServer.transport === "object" ? rawServer.transport : rawServer;
  const transport = String(nested?.type ?? "").toLowerCase();
  if (transport === "streamablehttp" || transport === "streamable-http" || transport === "http") return { ok: true, transport: "streamable-http" };
  if (transport === "sse" || transport === "ws") reasons.push(`传输 ${transport} 不受 DSH 支持`);
  if (rawServer?.preAuth) reasons.push("需要 WorkBuddy 的 preAuth 鉴权链路");
  if (typeof nested?.command === "string" && isWorkbuddyOnlyCommand(nested.command)) reasons.push("command 依赖 WorkBuddy 本机连接器目录");
  const envKeys = Object.keys(nested?.env || {});
  const headerKeys = Object.keys(nested?.headers || {});
  if (envKeys.some((key) => /token|secret|key/i.test(key)) || headerKeys.some((key) => /authorization|token/i.test(key))) {
    reasons.push("需要 WorkBuddy 的 token 注入，DSH 无法代填");
  }
  if (!reasons.length && transport !== "stdio") reasons.push(`未知传输类型 ${transport || "（缺失）"}`);
  return { ok: reasons.length === 0, transport: transport || "stdio", reasons };
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
    const checks = servers.map(([serverName, rawServer]) => ({ serverName, rawServer, ...serverInstallability(serverName, rawServer) }));
    const blocked = checks.filter((check) => !check.ok);
    rows.push({
      id,
      name: entry.name || id,
      nameEn: entry.name_en || "",
      description: entry.description_zh || entry.description || entry.description_en || "",
      descriptionEn: entry.description_en || "",
      authMode: entry.auth_mode || "",
      type: entry.type || "",
      examples: entry.examples_zh || entry.examples_en || [],
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

// ── SkillHub 技能市场 ─────────────────────────────────────────────────
// 列表：/api/skills?sortBy=downloads|installs|stars|score&page=N&pageSize=60&keyword=..&category=..
// 详情：/api/v1/skills/:slug?namespace=<handle>（带 latestVersion、publisher、securityReports）
// 文件：/api/v1/skills/:slug/files?namespace=<handle>[&version=]；/file 同形 + &path=
// namespace 用 namespace.handle（列表项里是对象）， 不是 canonicalName。
const SKILLHUB_SORTS = new Set(["downloads", "installs", "stars", "score"]);
async function skillhubJson(path) {
  const buffer = await fetchWithLimits(`${SKILLHUB_ORIGIN}${path}`);
  const body = JSON.parse(buffer.toString("utf8"));
  // SkillHub 的业务错误也在 200 里（code !== 0）。
  if (body && typeof body.code === "number" && body.code !== 0) throw new Error(`SkillHub 返回错误：${body.message || body.code}`);
  return body;
}
export async function wbSkillCatalog(payload = {}) {
  const page = Math.max(1, Math.min(200, Number(payload.page) || 1));
  const pageSize = Math.max(1, Math.min(60, Number(payload.pageSize) || 20));
  const sort = SKILLHUB_SORTS.has(payload.sort) ? payload.sort : "downloads";
  const params = new URLSearchParams({ sortBy: sort, page: String(page), pageSize: String(pageSize) });
  const keyword = String(payload.keyword || "").trim();
  if (keyword) params.set("keyword", keyword.slice(0, 64));
  const category = String(payload.category || "").trim();
  if (category) params.set("category", category.slice(0, 64));
  const body = await skillhubJson(`/api/skills?${params.toString()}`);
  const skills = Array.isArray(body?.data?.skills) ? body.data.skills : [];
  return {
    page,
    pageSize,
    sort,
    keyword,
    category,
    total: Number(body?.data?.total) || 0,
    skills: skills.map((skill) => ({
      slug: String(skill.slug || ""),
      name: String(skill.name || skill.slug || ""),
      namespace: String(skill.namespace?.handle || ""),
      canonical: String(skill.namespace?.canonicalName || ""),
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
      upstreamUrl: String(skill.upstream_url || skill.homepage || ""),
    })).filter((skill) => skill.slug && skill.namespace),
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
  const reports = data.securityReports && typeof data.securityReports === "object" ? data.securityReports : {};
  const reportStatus = Object.values(reports).map((report) => String(report?.status || "")).filter(Boolean);
  return {
    slug,
    namespace,
    name: String(data.name || slug),
    version: String(data.latestVersion?.version || ""),
    changelog: String(data.latestVersion?.changelog || ""),
    description: String(data.description_zh || data.description || ""),
    publisher: String(data.publisher?.name || data.owner?.displayName || ""),
    verifiedPublisher: !!data.publisher?.verified,
    certifiedName: String(data.publisher?.certifiedName || ""),
    security: reportStatus.length ? reportStatus : ["unknown"],
    homepage: String(data.homepage || ""),
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
export async function wbSkillInstall(payload = {}, { onProgress } = {}) {
  const slug = String(payload?.slug || "").trim();
  const namespace = String(payload?.namespace || "").trim();
  const requestedName = String(payload?.name || "").trim();
  if (!slug || !namespace) throw new Error("缺少 slug 或 namespace");
  const listing = await wbSkillFiles(payload);
  if (!listing.files.length) throw new Error("该技能没有可下载的文件");
  if (listing.files.length > 400) throw new Error(`文件数超出上限（${listing.files.length} > 400）`);
  const root = join(homedir(), ".agents", "skills");
  const targetName = skillTargetName(namespace, slug);
  const finalDir = join(root, targetName);
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
/** 已装的市场技能（安装记录即目录本身），用于卡片上的「已安装」标记与卸载。 */
export async function wbSkillInstalled() {
  const root = join(homedir(), ".agents", "skills");
  const rows = [];
  let names = [];
  try {
    names = await readdir(root);
  } catch {
    return { installed: [] };
  }
  for (const name of names) {
    if (!name.includes("__")) continue;
    const [namespace, ...slugParts] = name.split("__");
    const dir = join(root, name);
    try {
      const info = await stat(dir);
      if (!info.isDirectory()) continue;
      rows.push({ dirName: name, namespace, slug: slugParts.join("__"), dir });
    } catch {
      // 竞态删除：跳过
    }
  }
  return { installed: rows };
}
