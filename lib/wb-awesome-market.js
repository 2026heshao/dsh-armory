// awesome-dsh-plugins 市场数据层（T01）。
//
// 与连接器市场（lib/wb-market.js 的 zip 管线）完全解耦：
// awesome 源是单文件裸 JSON（~13.4MB，全量 5 千余条，其中 unverified/broken 占
// 绝大多数），本模块只做「拉取链 → 瘦身过滤 → 原子缓存」三件事，纯数据层，
// 不做安装、不做 UI 投影。纪律（与 wb-registry.js 同款）：
//   - 源 URL 只活在本文件常量 AWESOME_SOURCES 里（裁定 1：registry 不感知 awesome，
//     禁止出现第二处硬编码真相）。
//   - 缓存目录 <root>/awesome-market/：slim.json（瘦身影射数组）+ meta.json
//     （{etag, fetchedAt, updated, counts, source, resolvedSha}），落盘一律
//     staging + rm + rename 原子写。
//   - 测试可通过 options.rootDir 或 DSH_ARMORY_HOME 把根目录指到临时目录，
//     绝不碰真实 ~/.dsh。
//
// 新鲜度（为什么要有 resolvedSha）：jsdelivr 对 @main 分支文件有 12h CDN 边缘缓存
// （s-maxage=43200），旧口径「@main + ETag 条件请求」会被陈旧边缘 304 骗过——上游
// 仓库已更新，但边缘还握着旧副本且其 ETag 恰与本地一致，市场数据最长滞后 12 小时
// （2026-10 实测复现）。现在首选经 api.github.com 把 main 解析到最新提交 SHA，再从
// 各镜像的 @<sha> 不可变地址取数：不可变地址 CDN 永不陈旧，SHA 相同即内容相同、
// 连下载都省掉；API 不可达时回落旧口径（陈旧窗口回归 12h 上限），可用性不降。
//
// 第二社区源（聚合）：dsh-market 插件展示的 6.7k 目录来自另一个独立注册表
// awesome-dsh-plugin.com（CC0），其 npm 可装子集与本源并不重合（实测 npm 并集
// ~7.2k）。这里把它的 npm 包 dsh-plugin-catalog 作为第二源接入：只取 npm 非空
// 条目（git-only 不进面板），适配成同一瘦身影射后独立落盘 second.json，服务时
// 按 npm 名与主源去重合并（主源优先）。取数走「registry 解析 latest 版本号 →
// jsDelivr @<版本> 不可变地址」双镜像链，机制与主源 SHA 同构。
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 市场标识：client 接收 catalog 响应后按 res.marketplace 给条目统一贴标。 */
export const AWESOME_MARKETPLACE_ID = 'awesome-dsh-plugins';

// 双 CDN 拉取链（jsdelivr 主源 → fastly 备源，按序尝试，单源失败切下一源）。
const AWESOME_SOURCES = [
  'https://cdn.jsdelivr.net/gh/dshworks/awesome-dsh-plugins@main/data/plugins.json',
  'https://fastly.jsdelivr.net/gh/dshworks/awesome-dsh-plugins@main/data/plugins.json',
];

/**
 * slim.json 体积验收上限（3MB）。真实 13.4MB 源过滤+瘦身后的产物约 1.5-2MB；
 * 若未来源膨胀超限，降级旋钮是把 slimEntries 的 description 截断从 120 收到 80
 * （本文件 truncateText 调用点），预估可再省 ~15%。不在此做动态降级逻辑，
 * 体积断言由 test/wb-awesome-market.mjs 钉住。
 */
export const SLIM_MAX_BYTES = 3 * 1024 * 1024;

const USER_AGENT = '@2026heshao/dsh-armory (+https://github.com/2026heshao/dsh-armory)';
const DOWNLOAD_TIMEOUT_MS = 120_000; // 13.4MB 全量下载的超时余量
const PROBE_TIMEOUT_MS = 30_000; // HEAD 条件探测轻量快速
const GITHUB_API_TIMEOUT_MS = 20_000; // 提交解析是小 JSON，短超时快速失败回落
/** 提交 SHA 的防御性形态校验（7-40 位十六进制），杜绝把垃圾拼进 URL。 */
const SHA_PATTERN = /^[0-9a-f]{7,40}$/i;
/** SHA 解析备忘 TTL：60s 内同根的 catalog/探测共享一次解析结果，对 GitHub API 客气。 */
const SHA_MEMO_TTL_MS = 60_000;

// ── 第二社区源（awesome-dsh-plugin.com 聚合目录，CC0）──────────────────────
// 另一个独立注册表（github.com/awesome-dsh-plugin/awesome-dsh-plugin，6.7k+ 条，
// npm 与 git 安装混收）。这里只取其 **npm 非空** 子集与主源并集（面板口径始终是
// 「可 npm 安装」；服务时按 npm 名去重、主源优先，git-only 条目不进面板）。
// 数据发布为 npm 包 dsh-plugin-catalog，随构建逐日出版本号。取数与主源 SHA 机制
// 同构：先向 npm registry 解析 latest 版本号（小 JSON），再从 jsDelivr 双镜像按
// @<版本> 取文件——版本锁定地址 CDN 标记 immutable（s-maxage=1 年），永不陈旧；
// 解析失败回落无版本地址 + If-None-Match（CDN 对 npm latest 同样最长缓存 12h，
// 可用性不降）。
const SECOND_CATALOG_PKG = 'dsh-plugin-catalog';
const SECOND_CATALOG_FILE = 'plugins.json';
const SECOND_VERSION_TIMEOUT_MS = 20_000;
const SECOND_MIRRORS = ['https://cdn.jsdelivr.net', 'https://fastly.jsdelivr.net'];
/** npm 版本号防御性形态校验（semver 字符集），杜绝把垃圾拼进 URL。 */
const SECOND_VERSION_PATTERN = /^[0-9A-Za-z.+-]+$/;

/**
 * 首屏提速（stale-while-revalidate）：磁盘/内存有货就立刻返回，网络再验证挪到后台。
 * 缓存龄期超过该值才触发一次后台再验证，期间调用方秒回旧数据、UI 不转圈。
 */
const REVALIDATE_AFTER_MS = 5 * 60_000;
/** 后台再验证失败后的退避窗口，避免每次进面板都重试两个 CDN（各 120s 超时）。 */
const REVALIDATE_BACKOFF_MS = 60_000;

/** 存储根目录：显式 rootDir > 环境变量 > 真实 ~/.dsh/armory（与 wb-registry.js 同款）。 */
function awesomeRootDir(options = {}) {
  return options.rootDir || process.env.DSH_ARMORY_HOME || join(homedir(), '.dsh', 'armory');
}

/** 缓存子目录：<root>/awesome-market。 */
function awesomeMarketDir(options = {}) {
  return join(awesomeRootDir(options), 'awesome-market');
}

function slimPathOf(options = {}) {
  return join(awesomeMarketDir(options), 'slim.json');
}

function metaPathOf(options = {}) {
  return join(awesomeMarketDir(options), 'meta.json');
}

/** 读 JSON 文件；不存在/损坏一律返回 null（调用方决定回落语义），永不抛错。 */
async function readJsonAt(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** 唯一临时名 + rename 原子写（wb-registry.js writeAtomic 同款）：Windows 的 rename
 *  覆盖已存在文件，无需先 rm——固定 `<file>.staging` 在并发写（后台 revalidate 与
 *  refresh 强刷并行）时会互相消费对方的 staging，甚至把刚提交的正本删掉。文本一律 UTF-8。 */
async function writeAtomic(path, text) {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dir = cut > 0 ? path.slice(0, cut) : path;
  await mkdir(dir, { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

// ── 瘦身（纯函数）──────────────────────────────────────────────────────────

/** npm 字段防御提取：非空字符串直取；{name} 形态取 npm.name；其余出局（返回 ""）。 */
function extractNpm(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || '';
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (typeof value.name === 'string') {
      const trimmed = value.name.trim();
      return trimmed || '';
    }
  }
  return '';
}

/** description 防御截断：非字符串回落 ""；字符串截断 ≤120 字符（降级旋钮见 SLIM_MAX_BYTES）。 */
function truncateText(value, maxChars = 120) {
  return typeof value === 'string' ? value.slice(0, maxChars) : '';
}

/** tags 防御归一：非数组 → []；数组只留字符串且最多 2 个。 */
function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((tag) => typeof tag === 'string').slice(0, 2);
}

/**
 * 源数据 plugins 数组 → 瘦身影射数组（R11 口径）。
 *
 * 过滤：只保留 status === "verified" 且 npm 非空（对象形态取 npm.name）的条目；
 * unverified/broken 在这一步出局，永不进缓存。单条畸形（name 非非空字符串等致命
 * 字段缺失）直接丢弃该条，不抛错、不拖垮整目录。
 *
 * 映射：瘦身后 12 个字段全部必填有默认（见下）。名称排序不在此做（UI 层排序），
 * 保持源顺序输出。畸形输入（非数组）返回 []。
 */
export function slimEntries(rawArray) {
  if (!Array.isArray(rawArray)) return [];
  const slim = [];
  for (const raw of rawArray) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    if (raw.status !== 'verified') continue;
    const npm = extractNpm(raw.npm);
    if (!npm) continue;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) continue;
    const category = typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'plugin';
    slim.push({
      name,
      repo: typeof raw.repo === 'string' ? raw.repo : '',
      npm,
      description: truncateText(raw.description, 120),
      category,
      status: 'verified',
      tags: normalizeTags(raw.tags),
      stars: typeof raw.stars === 'number' && Number.isFinite(raw.stars) ? raw.stars : 0,
      official: Boolean(raw.official),
      verifiedAgainst: typeof raw.verifiedAgainst === 'string' ? raw.verifiedAgainst : '',
      lastVerified: typeof raw.lastVerified === 'string' ? raw.lastVerified : '',
    });
  }
  return slim;
}

/** 瘦身结果 → counts 统计：{ total, byCategory }。 */
function countsOf(entries) {
  const byCategory = {};
  for (const entry of entries) {
    byCategory[entry.category] = (byCategory[entry.category] || 0) + 1;
  }
  return { total: entries.length, byCategory };
}

/**
 * 第二源目录条目 → 瘦身影射形态（纯函数）。只保留 **npm 非空** 条目——合并口径
 * 是「可 npm 安装」，git-only 条目不进面板。字段映射：description 中英双语取
 * zh 优先（该源面向中文社区）；repo 由 url 归一成 owner/repo；category 用该源
 * 自有的功能分类 id（面板分类筛选自然出现两套体系）；该源不携带 dsh 版本验证
 * 元数据，verifiedAgainst/lastVerified 置空、status 恒为 verified（其 curated 口径）。
 */
export function adaptSecondEntries(rawArray) {
  if (!Array.isArray(rawArray)) return [];
  const slim = [];
  for (const raw of rawArray) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const npm = extractNpm(raw.npm);
    if (!npm) continue;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) continue;
    const desc = raw.description;
    const text =
      typeof desc === 'string'
        ? desc
        : desc && typeof desc === 'object'
          ? typeof desc.zh === 'string' && desc.zh
            ? desc.zh
            : typeof desc.en === 'string'
              ? desc.en
              : ''
          : '';
    slim.push({
      name,
      repo: parseGithubRepo(raw.url),
      npm,
      description: truncateText(text, 120),
      category: typeof raw.category === 'string' && raw.category.trim() ? raw.category.trim() : 'plugin',
      status: 'verified',
      tags: [],
      stars: typeof raw.stars === 'number' && Number.isFinite(raw.stars) ? raw.stars : 0,
      official: false,
      verifiedAgainst: '',
      lastVerified: '',
    });
  }
  return slim;
}

/**
 * 服务时合并（纯函数）：主源瘦身条目 + 第二源中主源没有的 npm 名。主源优先——
 * 同一 npm 包在面板只出现一次，且主源后续补录的条目会自然顶掉第二源副本，
 * 无需重拉第二源。secondEntries 为空/损坏时原样返回主源。
 */
export function mergeSecondEntries(primaryEntries, secondEntries) {
  const primary = Array.isArray(primaryEntries) ? primaryEntries : [];
  if (!Array.isArray(secondEntries) || secondEntries.length === 0) return primary;
  const seen = new Set(primary.map((entry) => entry.npm));
  const extra = secondEntries.filter((entry) => entry && entry.npm && !seen.has(entry.npm));
  return [...primary, ...extra];
}

// ── 拉取链与缓存落盘 ────────────────────────────────────────────────────────

/**
 * 从 gh 源 URL 解析 <owner>/<repo>@<branch>/<path> 形态；不符合返回 null。
 * 形态：https://<镜像域名>/gh/<owner>/<repo>@<branch>/<path>。
 */
function parseGhSource(sourceUrl) {
  const match = /^https?:\/\/[^/\s]+\/gh\/([^/\s@]+)\/([^/\s@]+)@([^/\s]+)\/(.+)$/.exec(String(sourceUrl || ''));
  return match ? { owner: match[1], repo: match[2], branch: match[3], filePath: match[4] } : null;
}

/**
 * 把 gh 源 URL 的分支段替换成提交 SHA（保留各自镜像域名）。替换没发生（形态
 * 不符 / SHA 非法）返回空串，调用方跳过该源——绝不把未校验的字符串拼进 URL。
 */
function pinSourceToSha(sourceUrl, sha) {
  if (!SHA_PATTERN.test(String(sha || ''))) return '';
  const gh = parseGhSource(sourceUrl);
  if (!gh) return '';
  const pinned = String(sourceUrl).replace(`/${gh.owner}/${gh.repo}@${gh.branch}/`, `/${gh.owner}/${gh.repo}@${sha}/`);
  return pinned !== sourceUrl ? pinned : '';
}

/**
 * 解析默认分支最新提交 SHA（GitHub commits API，小 JSON）。失败（网络/限流/畸形）
 * 返回 ""，调用方回落 @main 链——绝不让解析失败拖垮目录加载。
 * 备忘按缓存根分键（与 memSlim 同款）：60s 内同根调用共享一次解析，测试各用
 * 各的临时目录互不串味。
 */
let memSha = null; // { rootKey, sha, at }
async function resolveBranchSha(options = {}) {
  const rootKey = memKeyOf(options);
  if (memSha && memSha.rootKey === rootKey && Date.now() - memSha.at < SHA_MEMO_TTL_MS) {
    return memSha.sha;
  }
  const gh = parseGhSource(AWESOME_SOURCES[0]);
  let sha = '';
  if (gh) {
    try {
      const response = await fetch(`https://api.github.com/repos/${gh.owner}/${gh.repo}/commits/${gh.branch}`, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
      });
      if (response.ok) {
        const doc = await response.json();
        if (doc && typeof doc.sha === 'string' && SHA_PATTERN.test(doc.sha)) sha = doc.sha;
      }
    } catch {
      /* API 不可达：sha 保持 ""，走 @main 回落链 */
    }
  }
  memSha = { rootKey, sha, at: Date.now() };
  return sha;
}

/** 拉到的响应体 → 校验过形状的源数据；缺 plugins 数组抛错（由调用方折进 lastError）。 */
function parsePluginsPayload(buffer) {
  const data = JSON.parse(Buffer.from(buffer).toString('utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.plugins)) {
    throw new Error('响应缺少 plugins 数组');
  }
  return data;
}

/**
 * 拉取链（两级）：
 *   ① 首选 SHA 口径：解析分支最新提交 → 与 meta.resolvedSha 相同即内容未变
 *      （不可变地址的性质），直接 notModified，连 CDN 都不用碰；不同则按
 *      AWESOME_SOURCES 顺序拉 @<sha> 不可变地址（CDN 永不陈旧，根因修复点）。
 *   ② 回落 @main 口径（API 不可达 / pinned 链全挂时）：条件 GET 行为原样保留，
 *      单源失败（网络异常 / 非 2xx / 响应体畸形）→ 试下一源；304 且有 etag →
 *      { ok, notModified }。
 * 返回 { ok, notModified } | { ok, data, etag, source, sha } | { ok: false, error }。
 * 下载全程带 120s 超时。注意：② 成功时不含 sha 字段（@main 无法知道对应哪个提交，
 * 落盘 resolvedSha 置空，下轮再验证重新解析）。
 */
async function fetchChain(localMeta = {}, options = {}) {
  const etag = localMeta && typeof localMeta.etag === 'string' ? localMeta.etag : '';
  const localSha = localMeta && typeof localMeta.resolvedSha === 'string' ? localMeta.resolvedSha : '';
  let lastError = '';

  // ① SHA 口径：不可变地址，新鲜且可缓存终身
  const sha = await resolveBranchSha(options);
  if (sha) {
    if (sha === localSha) return { ok: true, notModified: true };
    const pinnedErrors = [];
    for (const sourceUrl of AWESOME_SOURCES) {
      const pinnedUrl = pinSourceToSha(sourceUrl, sha);
      if (!pinnedUrl) continue;
      let response;
      try {
        response = await fetch(pinnedUrl, {
          headers: { 'user-agent': USER_AGENT },
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
      } catch (error) {
        pinnedErrors.push(`${pinnedUrl} → ${error.message}`);
        continue;
      }
      if (!response.ok) {
        pinnedErrors.push(`${pinnedUrl} → HTTP ${response.status}`);
        continue;
      }
      try {
        const data = parsePluginsPayload(await response.arrayBuffer());
        return { ok: true, data, etag: response.headers.get('etag') || '', source: pinnedUrl, sha };
      } catch (error) {
        pinnedErrors.push(`${pinnedUrl} → ${error.message}`);
      }
    }
    lastError = pinnedErrors.join('; ');
  }

  // ② @main 回落口径：条件 GET（现状行为）
  const headers = { 'user-agent': USER_AGENT };
  if (etag) headers['if-none-match'] = etag;
  for (const sourceUrl of AWESOME_SOURCES) {
    let response;
    try {
      response = await fetch(sourceUrl, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (error) {
      lastError = `${sourceUrl} → ${error.message}`;
      continue;
    }
    if (response.status === 304 && etag) return { ok: true, notModified: true };
    if (!response.ok) {
      lastError = `${sourceUrl} → HTTP ${response.status}`;
      continue;
    }
    try {
      const data = parsePluginsPayload(await response.arrayBuffer());
      return { ok: true, data, etag: response.headers.get('etag') || '', source: sourceUrl };
    } catch (error) {
      lastError = `${sourceUrl} → ${error.message}`;
      continue;
    }
  }
  return { ok: false, error: `全部 awesome 源拉取失败：${lastError}` };
}

// ── 第二源拉取链（npm 版本轮，与主源 SHA 机制同构）─────────────────────────

let memSecondVersion = null; // { rootKey, version, at }
/** 版本锁定地址（双镜像）；版本形态非法返回空数组，调用方跳过 pinned 链。 */
function secondUrlsOf(version) {
  if (!SECOND_VERSION_PATTERN.test(String(version || ''))) return [];
  return SECOND_MIRRORS.map((host) => `${host}/npm/${SECOND_CATALOG_PKG}@${version}/${SECOND_CATALOG_FILE}`);
}
/** 无版本回落地址（CDN 对 npm latest 的缓存最长 12h，仅解析失败时使用）。 */
const SECOND_FALLBACK_URLS = SECOND_MIRRORS.map((host) => `${host}/npm/${SECOND_CATALOG_PKG}/${SECOND_CATALOG_FILE}`);

/**
 * 解析第二源 npm 包 latest 版本号（registry 小 JSON）。失败（网络/限流/畸形）
 * 返回 ""，调用方回落无版本链——绝不让解析失败拖垮目录加载。备忘按缓存根分键，
 * TTL 与 SHA 备忘一致。
 */
async function resolveSecondVersion(options = {}) {
  const rootKey = memKeyOf(options);
  if (memSecondVersion && memSecondVersion.rootKey === rootKey && Date.now() - memSecondVersion.at < SHA_MEMO_TTL_MS) {
    return memSecondVersion.version;
  }
  let version = '';
  try {
    const response = await fetch(`https://registry.npmjs.org/${SECOND_CATALOG_PKG}/latest`, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: AbortSignal.timeout(SECOND_VERSION_TIMEOUT_MS),
    });
    if (response.ok) {
      const doc = await response.json();
      if (doc && typeof doc.version === 'string' && SECOND_VERSION_PATTERN.test(doc.version)) version = doc.version;
    }
  } catch {
    /* registry 不可达：version 保持 ""，走无版本回落链 */
  }
  memSecondVersion = { rootKey, version, at: Date.now() };
  return version;
}

/**
 * 第二源拉取链（两级）：
 *   ① 首选版本口径：解析 npm latest 版本 → 与 meta.second.version 相同即内容
 *      未变（不可变地址性质），直接 notModified；不同则按镜像序取 @<版本> 地址
 *      （CDN immutable，永不陈旧）。
 *   ② 回落无版本口径（registry 不可达 / pinned 链全挂时）：条件 GET，304 且有
 *      etag → { ok, notModified }。
 * 返回 { ok, notModified } | { ok, data, etag, source, version } | { ok: false, error }。
 * 注意：② 成功时不含 version 字段（无版本地址不知道对应哪个构建，落盘 version
 * 置空，下轮再验证重新解析）。
 */
async function fetchSecondChain(localSecond = {}, options = {}) {
  const etag = localSecond && typeof localSecond.etag === 'string' ? localSecond.etag : '';
  const localVersion = localSecond && typeof localSecond.version === 'string' ? localSecond.version : '';
  let lastError = '';

  // ① 版本口径：不可变地址
  const version = await resolveSecondVersion(options);
  if (version) {
    if (version === localVersion) return { ok: true, notModified: true };
    const pinnedErrors = [];
    for (const sourceUrl of secondUrlsOf(version)) {
      let response;
      try {
        response = await fetch(sourceUrl, {
          headers: { 'user-agent': USER_AGENT },
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
      } catch (error) {
        pinnedErrors.push(`${sourceUrl} → ${error.message}`);
        continue;
      }
      if (!response.ok) {
        pinnedErrors.push(`${sourceUrl} → HTTP ${response.status}`);
        continue;
      }
      try {
        const data = parsePluginsPayload(await response.arrayBuffer());
        return { ok: true, data, etag: response.headers.get('etag') || '', source: sourceUrl, version };
      } catch (error) {
        pinnedErrors.push(`${sourceUrl} → ${error.message}`);
      }
    }
    lastError = pinnedErrors.join('; ');
  }

  // ② 无版本回落口径：条件 GET
  const headers = { 'user-agent': USER_AGENT };
  if (etag) headers['if-none-match'] = etag;
  for (const sourceUrl of SECOND_FALLBACK_URLS) {
    let response;
    try {
      response = await fetch(sourceUrl, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (error) {
      lastError = `${sourceUrl} → ${error.message}`;
      continue;
    }
    if (response.status === 304 && etag) return { ok: true, notModified: true };
    if (!response.ok) {
      lastError = `${sourceUrl} → HTTP ${response.status}`;
      continue;
    }
    try {
      const data = parsePluginsPayload(await response.arrayBuffer());
      return { ok: true, data, etag: response.headers.get('etag') || '', source: sourceUrl };
    } catch (error) {
      lastError = `${sourceUrl} → ${error.message}`;
      continue;
    }
  }
  return { ok: false, error: `第二社区源拉取失败：${lastError}` };
}

// ── 进程内缓存 + 单航班后台再验证 ─────────────────────────────────────────
// slim.json 约 1.5-2MB，每次 catalog 都 readFile + JSON.parse 纯属浪费；更要命的是
// 过去「有缓存也先等一次条件 GET」（两个源串行，最坏 2 × 120s）才肯返回，这是
// 「市场初次加载慢」的服务端一半。现在内存层命中即返回，过期后只后台再验证。
let memSlim = null; // { rootKey, entries, meta }
let revalidating = null; // Promise | null（单航班，避免并发重复拉取）
let revalidateFailedAt = 0;

/** 内存层分键：不同 rootDir（测试/多实例）不得串味。 */
function memKeyOf(options = {}) {
  return awesomeMarketDir(options);
}

function getMemSlim(options = {}) {
  const key = memKeyOf(options);
  return memSlim && memSlim.rootKey === key ? memSlim : null;
}

function setMemSlim(options = {}, entries, meta) {
  memSlim = { rootKey: memKeyOf(options), entries, meta: meta || {} };
}

/** 缓存龄期（ms）；meta 无有效 fetchedAt 视为无限陈旧。 */
function ageOfMeta(meta) {
  const at = Number(meta && meta.fetchedAt);
  return Number.isFinite(at) && at > 0 ? Date.now() - at : Number.POSITIVE_INFINITY;
}

/**
 * 读瘦身缓存：slim.json 可解析为数组即视为有缓存；meta.json 缺失/损坏回落 {}。
 * 两个文件任一损坏都不抛错。`useMem: false` 用于强制走磁盘（refresh 路径要看到
 * 外部刚写入的缓存，不能被进程内旧值遮住）。
 */
async function readSlimCache(options = {}, { useMem = true } = {}) {
  if (useMem) {
    const mem = getMemSlim(options);
    if (mem) return { entries: mem.entries, meta: mem.meta };
  }
  const entries = await readJsonAt(slimPathOf(options));
  if (!Array.isArray(entries)) return null;
  const meta = (await readJsonAt(metaPathOf(options))) || {};
  setMemSlim(options, entries, meta);
  return { entries, meta };
}

// ── 第二源缓存层（second.json = 适配后的第二源 npm 条目数组）────────────────
// 与 slim.json 分开落盘：合并去重在服务时做（主源补录条目会自然顶掉第二源
// 副本，无需重拉第二源）；两源的元信息统一存 meta.json 的 second 键。

function secondPathOf(options = {}) {
  return join(awesomeMarketDir(options), 'second.json');
}

let memSecond = null; // { rootKey, entries }

function getMemSecond(options = {}) {
  const key = memKeyOf(options);
  return memSecond && memSecond.rootKey === key ? memSecond : null;
}

function setMemSecond(options = {}, entries) {
  memSecond = { rootKey: memKeyOf(options), entries };
}

/** 读第二源适配缓存；不存在/损坏返回 null，永不抛错。useMem 语义与 readSlimCache 同。 */
async function readSecondCache(options = {}, { useMem = true } = {}) {
  if (useMem) {
    const mem = getMemSecond(options);
    if (mem) return mem.entries;
  }
  const entries = await readJsonAt(secondPathOf(options));
  if (!Array.isArray(entries)) return null;
  setMemSecond(options, entries);
  return entries;
}

/**
 * 双源同步（refresh 同步路径与后台再验证共用）：源1（fetchChain）与源2
 * （fetchSecondChain）并行拉取、各自独立容错——任一源失败只保留自己的旧缓存，
 * 绝不拖垮另一源。返回各源的新数据/缓存与判定标记。
 */
async function syncSources(slimCache, secondEntries, options = {}) {
  const [chain1, chain2] = await Promise.all([
    fetchChain(slimCache ? slimCache.meta : {}, options),
    fetchSecondChain(slimCache && slimCache.meta && slimCache.meta.second ? slimCache.meta.second : {}, options),
  ]);
  let entries1 = slimCache ? slimCache.entries : null;
  if (chain1.ok && !chain1.notModified) entries1 = slimEntries(chain1.data.plugins);
  let entries2 = Array.isArray(secondEntries) ? secondEntries : null;
  if (chain2.ok && !chain2.notModified) entries2 = adaptSecondEntries(chain2.data.plugins);
  const meta2Next =
    chain2.ok && !chain2.notModified
      ? {
          version: chain2.version || '',
          etag: chain2.etag || '',
          source: chain2.source || '',
          fetchedAt: Date.now(),
          updated: typeof chain2.data.updated === 'string' ? chain2.data.updated : '',
          counts: countsOf(entries2),
        }
      : null;
  return { chain1, chain2, entries1, entries2, meta2Next };
}

/**
 * 同步结果落盘：slim.json=源1瘦身条目（仅在源1有新数据时重写）、second.json=源2
 * 适配条目（仅在源2有新数据时重写）、meta.json=源1元信息 + second 键（源2元信息；
 * 以 base 展开重建，旧 meta 里的 second 在源2无新数据时原样保留）。
 * fetchedAt 语义：源1「未变更」（SHA 相同 / 304）或「更新」都推到当前时刻以重置
 * 陈旧计时；源1失败时保留原值（下轮尽快重试）。两源全部失败且无缓存时不动盘。
 */
async function persistSync({ chain1, chain2, slimCache, entries1, entries2, meta2Next }, options = {}) {
  const meta1Changed = Boolean(chain1.ok && !chain1.notModified);
  const meta2Changed = Boolean(chain2.ok && !chain2.notModified);
  const base = slimCache && slimCache.meta ? slimCache.meta : {};
  let finalMeta1;
  if (meta1Changed) {
    finalMeta1 = {
      etag: chain1.etag || '',
      fetchedAt: Date.now(),
      updated: typeof chain1.data.updated === 'string' ? chain1.data.updated : '',
      counts: countsOf(entries1),
      source: chain1.source || '',
      resolvedSha: typeof chain1.sha === 'string' ? chain1.sha : '',
    };
  } else {
    finalMeta1 = { ...base, fetchedAt: chain1.ok ? Date.now() : Number(base.fetchedAt) || 0 };
  }
  finalMeta1.second = meta2Next || (base.second && typeof base.second === 'object' ? base.second : null);
  if (meta1Changed) await writeAtomic(slimPathOf(options), JSON.stringify(entries1));
  if (meta1Changed || chain1.ok || meta2Changed) {
    await writeAtomic(metaPathOf(options), JSON.stringify(finalMeta1));
    // 源1冷启动失败（entries1 为 null）时不污染内存层：slim 缓存仍视为不存在。
    if (Array.isArray(entries1)) setMemSlim(options, entries1, finalMeta1);
  }
  if (meta2Next) {
    await writeAtomic(secondPathOf(options), JSON.stringify(entries2));
    setMemSecond(options, entries2);
  }
  return { finalMeta1, meta1Changed, meta2Changed };
}

/**
 * 后台再验证：不阻塞调用方；单航班 + 失败退避。
 * 双源同步（syncSources + persistSync）：任一源成功即落盘相应部分，下次请求即拿
 * 新结果；源1失败记退避（源2不受退避影响，但单航班内的本轮已并行试过）；失败只
 * 静默保留旧缓存（陈旧但可用，绝不把错误抛给 UI）。
 */
function revalidateInBackground(options = {}) {
  if (revalidating) return revalidating;
  if (revalidateFailedAt > 0 && Date.now() - revalidateFailedAt < REVALIDATE_BACKOFF_MS) return null;
  revalidating = (async () => {
    try {
      const slimCache = await readSlimCache(options);
      const secondEntries = await readSecondCache(options);
      const sync = await syncSources(slimCache, secondEntries, options);
      // 源1失败也照常落盘：persistSync 会保留源1旧缓存、只写源2的新数据——
      // 两源独立推进，任一源成功都不白跑。
      await persistSync(sync, options);
      revalidateFailedAt = sync.chain1.ok ? 0 : Date.now();
    } catch {
      revalidateFailedAt = Date.now();
    } finally {
      revalidating = null;
    }
  })();
  return revalidating;
}

/** 统一组装 catalog 响应体（cache/disk 复用）：entries 一律是合并后的面板条目，
 *  counts 服务时现算（第二源并入后 meta.counts 只记源1，作诊断不进响应）。 */
function catalogResult(entries, meta, loadedFrom, extra = {}) {
  const counts = countsOf(entries);
  const fetchedAt = Number(meta && meta.fetchedAt);
  return {
    ok: true,
    loadedFrom,
    updated: typeof meta.updated === 'string' ? meta.updated : '',
    fetchedAt: Number.isFinite(fetchedAt) && fetchedAt > 0 ? fetchedAt : 0,
    counts,
    plugins: entries,
    marketplace: AWESOME_MARKETPLACE_ID,
    ...extra,
  };
}

// ── 四个对外 API ───────────────────────────────────────────────────────────

/**
 * 读 awesome 目录（缓存优先 + 后台再验证 → 首屏秒出；双源合并）：
 *   1. refresh: true（UI「重新加载」按钮）→ 同步强刷：两源并行（syncSources），
 *      各源未变更复用缓存 / 有新数据重新落盘（任一源有更新 → loadedFrom
 *      "network"）；源1全源失败且有缓存回落 "disk" + stale: true；无缓存且源1
 *      失败 { ok: false }（源2失败只静默少并一块，不拖垮面板）。
 *   2. 缓存新鲜（龄期 < REVALIDATE_AFTER_MS）→ 直接返合并缓存（"cache"），完全不
 *      碰网络。
 *   3. 缓存陈旧 → 仍立刻返回旧合并缓存（"cache" + refreshing: true），网络验证
 *      丢给后台单航班；下次进面板即拿到新数据，失败静默保留旧缓存。
 *   4. 无缓存（真正的首次）→ 双源并行全量拉取 → 瘦身/适配落盘（"network"）。
 * 面板条目 = 源1瘦身条目 + 第二源 npm 条目中主源没有的（mergeSecondEntries，
 * 服务时现算）；counts 按合并结果统计。
 * 响应统一带 fetchedAt（缓存抓取时刻）与（陈旧分支的）refreshing 标记，
 * 供 UI 直接显示「后台更新中」而无需二次请求。
 * 永不抛错（拉取/解析/写盘异常都折进返回体）。
 */
export async function wbAwesomeCatalog(options = {}) {
  const wantRefresh = Boolean(options) && options.refresh === true;
  try {
    const slimCache = await readSlimCache(options, { useMem: !wantRefresh });
    const secondEntries = await readSecondCache(options, { useMem: !wantRefresh });
    if (slimCache && !wantRefresh && ageOfMeta(slimCache.meta) < REVALIDATE_AFTER_MS) {
      return catalogResult(mergeSecondEntries(slimCache.entries, secondEntries), slimCache.meta, 'cache');
    }
    if (slimCache && !wantRefresh) {
      // 陈旧缓存：先秒回旧数据，网络验证交给后台（单航班 + 失败退避）。
      revalidateInBackground(options);
      return catalogResult(mergeSecondEntries(slimCache.entries, secondEntries), slimCache.meta, 'cache', {
        refreshing: true,
      });
    }
    // UI 强刷或冷启动：两源并行同步，各自独立容错。
    const { chain1, chain2, entries1, entries2, meta2Next } = await syncSources(slimCache, secondEntries, options);
    // persistSync 先于成败判定：它只在 meta2Next 存在时写 second.json，源1失败不动 slim 层——
    // 「两源独立推进，任一源成功都不白跑」与后台单航班同规。放在 !entries1 早退之后的话，
    // 冷启动遇源1全链失败时，源2刚拉到的整包会被原样丢掉，下次进面板还得重拉一遍。
    const { finalMeta1, meta1Changed, meta2Changed } = await persistSync(
      { chain1, chain2, slimCache, entries1, entries2, meta2Next },
      options,
    );
    if (!entries1) {
      // 源1无货且无缓存：面板主体缺失，维持 ok:false 语义（第二源单飞不成板）。
      return { ok: false, error: chain1.ok ? 'awesome 目录加载异常' : chain1.error };
    }
    const merged = mergeSecondEntries(entries1, entries2);
    const loadedFrom = chain1.ok ? (meta1Changed || meta2Changed ? 'network' : 'cache') : 'disk';
    return catalogResult(merged, finalMeta1, loadedFrom, chain1.ok ? {} : { stale: true });
  } catch (error) {
    return { ok: false, error: `awesome 目录加载异常：${error.message}` };
  }
}

/** 按名字查合并后的面板条目；无缓存先走 wbAwesomeCatalog 全量链；
 *  名字不存在 / 加载失败返回 null。 */
export async function wbAwesomeDetail(name, options = {}) {
  const wanted = typeof name === 'string' ? name.trim() : '';
  if (!wanted) return null;
  try {
    let cache = await readSlimCache(options);
    if (!cache) {
      const fresh = await wbAwesomeCatalog(options);
      if (!fresh.ok) return null;
      return fresh.plugins.find((entry) => entry.name === wanted) ?? null;
    }
    const secondEntries = await readSecondCache(options);
    const merged = mergeSecondEntries(cache.entries, secondEntries);
    return merged.find((entry) => entry.name === wanted) ?? null;
  } catch {
    return null;
  }
}

/**
 * 单源 ETag 条件探测：HEAD（被 405/501 拒绝则降级 GET 并立刻 cancel 响应体）。
 * 绝不落盘，只取 headers。返回 { ok: true, remoteEtag } 或 { ok: false, error }。
 */
async function probeEtagAt(sourceUrl, localEtag) {
  const headers = { 'user-agent': USER_AGENT, 'if-none-match': localEtag };
  let response;
  try {
    response = await fetch(sourceUrl, { method: 'HEAD', headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (response.status === 405 || response.status === 501) {
      // HEAD 不被支持 → 降级 GET，立刻 cancel() 丢弃响应体，不读进内存。
      response.body?.cancel?.();
      response = await fetch(sourceUrl, { method: 'GET', headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      response.body?.cancel?.();
    }
  } catch (error) {
    return { ok: false, error: `${sourceUrl} → ${error.message}` };
  }
  if (response.status === 304) return { ok: true, remoteEtag: localEtag };
  if (response.ok) {
    const remoteEtag = response.headers.get('etag') || '';
    // 探测只信 ETag：响应没有 ETag 就无法判定，宁可报探测失败也不误报「有更新」。
    if (!remoteEtag) return { ok: false, error: `${sourceUrl} → 响应缺少 ETag` };
    return { ok: true, remoteEtag };
  }
  return { ok: false, error: `${sourceUrl} → HTTP ${response.status}` };
}

/**
 * 更新探测：**绝不落盘**，只做判定。
 * reason 五枚举：no-source / probe-failed / no-cache / up-to-date / update-available。
 * 无缓存（meta 无 etag、无 resolvedSha、second 无 version）→ hasUpdate: false +
 * no-cache（awesome 首次由 catalog 链兜底加载，探测层不引导更新）。
 *
 * 双源两级口径：
 *   ① 首选不可变口径：并行解析源1提交 SHA 与源2 npm 版本号，与缓存记录直接比对
 *      ——不可变地址的性质保证「同 SHA/同版本即同内容」，判定不受 CDN 陈旧窗口
 *      影响（这正是旧口径「@main + ETag」被陈旧边缘 304 骗过、报出虚假
 *      up-to-date 的根因）。任一源有更新即报 update-available；旧缓存缺记录而
 *      解析成功时按 update-available 报（大概率确实落后，且引导一次刷新后自愈：
 *      落盘记录后判定恢复精确）。
 *   ② 回落 ETag 口径（两级解析都失败时）：按「缓存实际来源 → 全部源」顺序 HEAD
 *      条件探测（HEAD 被拒降级 GET 并 cancel 响应体），首个拿到 ETag 的源胜出；
 *      全部失败才报 probe-failed。
 */
export async function wbAwesomeUpdateCheck(options = {}) {
  try {
    const meta = (await readJsonAt(metaPathOf(options))) || {};
    const localEtag = typeof meta.etag === 'string' ? meta.etag : '';
    const localSha = typeof meta.resolvedSha === 'string' ? meta.resolvedSha : '';
    const second = meta.second && typeof meta.second === 'object' ? meta.second : {};
    const localVersion2 = typeof second.version === 'string' ? second.version : '';
    if (!localEtag && !localSha && !localVersion2) {
      return { ok: true, hasUpdate: false, reason: 'no-cache', localEtag: '', remoteEtag: '', checkedAt: Date.now() };
    }
    // ① 不可变口径：源1比对提交 SHA，源2比对 npm 版本号，任一前进即有更新
    const [sha, version2] = await Promise.all([resolveBranchSha(options), resolveSecondVersion(options)]);
    if (sha || version2) {
      const hasUpdate = (Boolean(sha) && sha !== localSha) || (Boolean(version2) && version2 !== localVersion2);
      return {
        ok: true,
        hasUpdate,
        reason: hasUpdate ? 'update-available' : 'up-to-date',
        localEtag,
        remoteEtag: hasUpdate ? '' : localEtag,
        checkedAt: Date.now(),
      };
    }
    // ② ETag 回落口径：先问拿到这份缓存的源（ETag 同源可比），再兜底其余源。
    const cachedSource = typeof meta.source === 'string' ? meta.source : '';
    const candidates = [...new Set([cachedSource, ...AWESOME_SOURCES].filter(Boolean))];
    let lastError = '';
    for (const sourceUrl of candidates) {
      const probe = await probeEtagAt(sourceUrl, localEtag);
      if (!probe.ok) {
        lastError = probe.error;
        continue;
      }
      const hasUpdate = probe.remoteEtag !== localEtag;
      return {
        ok: true,
        hasUpdate,
        reason: hasUpdate ? 'update-available' : 'up-to-date',
        localEtag,
        remoteEtag: probe.remoteEtag,
        checkedAt: Date.now(),
      };
    }
    return {
      ok: false,
      hasUpdate: false,
      reason: 'probe-failed',
      localEtag,
      remoteEtag: '',
      checkedAt: Date.now(),
      error: `awesome 市场更新探测失败：${lastError}`,
    };
  } catch (error) {
    return {
      ok: false,
      hasUpdate: false,
      reason: 'probe-failed',
      localEtag: '',
      remoteEtag: '',
      checkedAt: Date.now(),
      error: `更新探测异常：${error.message}`,
    };
  }
}

/** 缓存元信息（只读，不联网）：{ hasCache, etag, fetchedAt, updated }。 */
export async function wbAwesomeCachedInfo(options = {}) {
  const cache = await readSlimCache(options);
  if (!cache) return { hasCache: false, etag: '', fetchedAt: 0, updated: '' };
  const meta = cache.meta;
  return {
    hasCache: true,
    etag: typeof meta.etag === 'string' ? meta.etag : '',
    fetchedAt: typeof meta.fetchedAt === 'number' ? meta.fetchedAt : 0,
    updated: typeof meta.updated === 'string' ? meta.updated : '',
  };
}

// ── README 预览（按需拉取 + 落盘缓存，纯只读）────────────────────────────────
//
// 为什么单独一条 RPC：目录 slim 里不放 README（13MB 全量本身就只留 13 个字段，
// 塞进 README 会把瘦身缓存撑爆）。README 只在用户点开某张卡片时按需取一次，
// 取到后按「npm 包名或仓库」落盘缓存，同一插件再点就秒开、也不怕断网。

/** 预览是用户点击触发的一次短请求，不能像目录那样等 120s。 */
const README_TIMEOUT_MS = 20_000;
/** 正文上限：超长的 CHANGELOG 类 README 截断，别把几 MB 文本塞进浏览器。 */
const README_MAX_CHARS = 160_000;
/** 磁盘缓存 TTL：README 变动不频繁，7 天足够，过期再取一次。 */
const README_CACHE_TTL_MS = 7 * 24 * 3600_000;
/** GitHub raw 里按顺序尝试的文件名（大小写在不同仓库里真的不一样）。 */
const README_FILES = ['README.md', 'readme.md', 'Readme.md', 'README.MD', 'README.markdown', 'README_EN.md'];
const NPM_REGISTRY = 'https://registry.npmjs.org';

function readmeCacheDir(options = {}) {
  return join(awesomeMarketDir(options), 'readme');
}

/** 缓存文件名：来源标识压成安全短名（不用 crypto，避免多一个依赖）。 */
function readmeCachePath(key, options = {}) {
  const safe =
    String(key || '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '_')
      .slice(0, 96) || 'item';
  return join(readmeCacheDir(options), `${safe}.json`);
}

/**
 * 从各种形态的仓库字段里提取 `owner/repo`；不是 GitHub 或提取不到返回 ""。
 * 吃到过的形态：`owner/repo`、`https://github.com/o/r`、`git+https://github.com/o/r.git`、
 * `git@github.com:o/r.git`、带 `#readme` / `/tree/main` 尾巴的。
 */
export function parseGithubRepo(value) {
  if (typeof value !== 'string') return '';
  let text = value.trim();
  if (!text) return '';
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s#]+?)(?:\.git)?$/i.exec(text);
  if (ssh) return `${ssh[1]}/${ssh[2].replace(/\.git$/i, '')}`;
  text = text.replace(/^git\+/i, '');
  const http = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(text);
  if (http) return `${http[1]}/${http[2].replace(/\.git$/i, '')}`;
  const bare = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+)$/.exec(text);
  if (bare) return `${bare[1]}/${bare[2].replace(/\.git$/i, '')}`;
  return '';
}

/** 正文规整：去 BOM、统一换行、按字符上限截断。 */
function normalizeReadme(text) {
  let out = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  if (out.length > README_MAX_CHARS) {
    return { markdown: out.slice(0, README_MAX_CHARS), truncated: true };
  }
  return { markdown: out, truncated: false };
}

/** 单次文本 GET（带超时）；非 2xx 也把 body 读掉，避免连接悬挂。 */
async function fetchReadmeText(url, accept) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), README_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!response.ok) {
      try {
        await response.text();
      } catch {
        // 忽略：只为释放连接
      }
      return { ok: false, reachable: true, status: response.status, error: `HTTP ${response.status}` };
    }
    return {
      ok: true,
      reachable: true,
      status: response.status,
      text: await response.text(),
      url: response.url || url,
    };
  } catch (error) {
    const reason =
      error && error.name === 'AbortError'
        ? `超时（${README_TIMEOUT_MS}ms）`
        : String((error && error.message) || error);
    return { ok: false, reachable: false, status: 0, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/** npm 侧取 README：先打 `/<pkg>/latest`（小），没有再退全量 packument。 */
async function readmeFromNpm(npmName) {
  const encoded = String(npmName).replace(/\//g, '%2F');
  const latest = await fetchReadmeText(`${NPM_REGISTRY}/${encoded}/latest`, 'application/json');
  if (latest.ok) {
    let doc = null;
    try {
      doc = JSON.parse(latest.text);
    } catch {
      doc = null;
    }
    if (doc && typeof doc.readme === 'string' && doc.readme.trim()) {
      return {
        ok: true,
        markdown: doc.readme,
        repo: parseGithubRepo(doc.repository),
        file: doc.readmeFilename || 'README.md',
      };
    }
  }
  const full = await fetchReadmeText(`${NPM_REGISTRY}/${encoded}`, 'application/json');
  if (!full.ok) {
    return { ok: false, error: full.error };
  }
  let packument = null;
  try {
    packument = JSON.parse(full.text);
  } catch {
    return { ok: false, error: 'npm 返回的不是合法 JSON' };
  }
  const markdown = packument && typeof packument.readme === 'string' ? packument.readme : '';
  if (!markdown.trim()) {
    return { ok: false, error: latest.ok ? 'npm 包没有 README' : `${latest.error}；npm 包没有 README` };
  }
  return {
    ok: true,
    markdown,
    repo: parseGithubRepo(packument.repository),
    file: packument.readmeFilename || 'README.md',
  };
}

/**
 * GitHub 侧 README 的候选基底，按「先直连、后被墙可用」排序。
 * raw.githubusercontent.com 在部分网络（含国内常见环境）会直接 DNS 失败，
 * 因此补 jsDelivr 的 GitHub 镜像（@main / @master 两个默认分支都试）。
 * 每个基底各自独立：谁先拿到正文，就用谁的目录当相对图片的解析基准。
 */
function readmeGithubBases(repo) {
  return [
    `https://raw.githubusercontent.com/${repo}/HEAD/`,
    `https://cdn.jsdelivr.net/gh/${repo}@main/`,
    `https://cdn.jsdelivr.net/gh/${repo}@master/`,
    `https://fastly.jsdelivr.net/gh/${repo}@main/`,
    `https://fastly.jsdelivr.net/gh/${repo}@master/`,
  ];
}

/**
 * GitHub 侧取 README：按 README_FILES 顺序在候选基底上试。
 * 一旦某个基底返回过任何 HTTP 响应，就认定网络可达：此时把该基底的
 * 文件名全试完即可收工（不再换基底，避免对一个没 README 的仓库打 30 次请求）。
 */
async function readmeFromGithub(repo) {
  let lastError = '';
  let sawReachable = false;
  for (const base of readmeGithubBases(repo)) {
    for (const file of README_FILES) {
      const attempt = await fetchReadmeText(`${base}${file}`, 'text/plain');
      if (attempt.ok && attempt.text.trim()) {
        return { ok: true, markdown: attempt.text, base, file };
      }
      if (attempt.ok) {
        lastError = '文件为空';
        sawReachable = true;
        continue;
      }
      if (attempt.reachable) {
        lastError = attempt.error;
        sawReachable = true;
        continue;
      }
      lastError = attempt.error;
      break; // 该基底整体不可达（DNS/超时），换下一个
    }
    if (sawReachable) break;
  }
  return { ok: false, error: lastError || '未找到 README' };
}

/**
 * 读取某个市场条目的 README，供客户端详情弹窗预览。
 *
 * 入参：`{ name, npm, repo, refresh }`（`npm` 可传字符串或 `{name}`）。
 * 返回：`{ ok, reason: "cache" | "network" | "no-source" | "readme-unavailable",
 *          markdown, truncated, source: "npm" | "github", base, repo, npm, fetchedAt }`。
 *
 * `base` 是相对图片/链接的解析基准（GitHub raw 目录），客户端据此把 README 里的
 * 相对路径 `assets/a.png` 还原成可加载的绝对 URL —— 不还原的话插图全是坏图。
 *
 * 第二参 `options` 只承载存储位置（`rootDir`，测试隔离用）；RPC 层不传、走真实 `~/.dsh`。
 */
export async function wbAwesomeReadme(payload = {}, options = {}) {
  const name = typeof payload.name === 'string' ? payload.name.trim() : '';
  const npmName =
    typeof payload.npm === 'string'
      ? payload.npm.trim()
      : payload.npm && typeof payload.npm === 'object' && typeof payload.npm.name === 'string'
        ? payload.npm.name.trim()
        : '';
  let repo = parseGithubRepo(payload.repo);
  const wantRefresh = payload.refresh === true;
  if (!npmName && !repo) {
    return {
      ok: false,
      reason: 'no-source',
      name,
      npm: '',
      repo: '',
      markdown: '',
      truncated: false,
      source: '',
      base: '',
      fetchedAt: 0,
      error: '该条目没有 npm 包名或 GitHub 仓库地址，无法读取 README',
    };
  }
  const cacheKey = npmName || repo;
  // 缓存路径只认 options（rootDir 测试隔离契约，与 wbAwesomeCatalog 同规）；
  // payload 是 RPC 入参，把它当 options 传会让显式 rootDir 失效、测试打到真实 ~/.dsh。
  const cachePath = readmeCachePath(cacheKey, options);
  if (!wantRefresh) {
    const cached = await readJsonAt(cachePath);
    if (
      cached &&
      typeof cached.markdown === 'string' &&
      cached.markdown &&
      Date.now() - Number(cached.fetchedAt || 0) < README_CACHE_TTL_MS
    ) {
      return {
        ok: true,
        reason: 'cache',
        name,
        npm: npmName,
        repo: typeof cached.repo === 'string' ? cached.repo : repo,
        markdown: cached.markdown,
        truncated: Boolean(cached.truncated),
        source: typeof cached.source === 'string' ? cached.source : '',
        base: typeof cached.base === 'string' ? cached.base : '',
        fetchedAt: Number(cached.fetchedAt || 0),
      };
    }
  }
  let markdown = '';
  let source = '';
  let base = '';
  const errors = [];
  if (npmName) {
    const fromNpm = await readmeFromNpm(npmName);
    if (fromNpm.ok) {
      markdown = fromNpm.markdown;
      source = 'npm';
      repo = repo || parseGithubRepo(fromNpm.repo);
      base = repo ? `https://raw.githubusercontent.com/${repo}/HEAD/` : '';
    } else {
      errors.push(`npm：${fromNpm.error}`);
    }
  }
  if (!markdown && repo) {
    const fromGithub = await readmeFromGithub(repo);
    if (fromGithub.ok) {
      markdown = fromGithub.markdown;
      source = 'github';
      base = fromGithub.base;
    } else {
      errors.push(`github：${fromGithub.error}`);
    }
  }
  if (!markdown.trim()) {
    return {
      ok: false,
      reason: 'readme-unavailable',
      name,
      npm: npmName,
      repo,
      markdown: '',
      truncated: false,
      source: '',
      base: '',
      fetchedAt: 0,
      error: `读取 README 失败：${errors.join('；') || '没有可用来源'}`,
    };
  }
  const normalized = normalizeReadme(markdown);
  const fetchedAt = Date.now();
  try {
    await writeAtomic(
      cachePath,
      JSON.stringify({
        name,
        npm: npmName,
        repo,
        markdown: normalized.markdown,
        truncated: normalized.truncated,
        source,
        base,
        fetchedAt,
      }),
    );
  } catch {
    // 缓存写不进去不影响这次预览
  }
  return {
    ok: true,
    reason: 'network',
    name,
    npm: npmName,
    repo,
    markdown: normalized.markdown,
    truncated: normalized.truncated,
    source,
    base,
    fetchedAt,
  };
}
