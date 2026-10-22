// awesome-dsh-plugins 市场数据层（T01）。
//
// 与既有 codebuddy 插件市场（lib/wb-plugin-market.js 的 zip 管线）完全解耦：
// awesome 源是单文件裸 JSON（~13.4MB，全量 5 千余条，其中 unverified/broken 占
// 绝大多数），本模块只做「拉取链 → 瘦身过滤 → 原子缓存」三件事，纯数据层，
// 不做安装、不做 UI 投影。纪律（与 wb-registry.js 同款）：
//   - 源 URL 只活在本文件常量 AWESOME_SOURCES 里（裁定 1：registry 不感知 awesome，
//     禁止出现第二处硬编码真相）。
//   - 缓存目录 <root>/awesome-market/：slim.json（瘦身影射数组）+ meta.json
//     （{etag, fetchedAt, updated, counts}），落盘一律 staging + rm + rename 原子写。
//   - 测试可通过 options.rootDir 或 DSH_ARMORY_HOME 把根目录指到临时目录，
//     绝不碰真实 ~/.dsh。
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 市场标识：client 接收 catalog 响应后按 res.marketplace 给条目统一贴标。 */
export const AWESOME_MARKETPLACE_ID = "awesome-dsh-plugins";

// 双 CDN 拉取链（jsdelivr 主源 → fastly 备源，按序尝试，单源失败切下一源）。
const AWESOME_SOURCES = [
  "https://cdn.jsdelivr.net/gh/dshworks/awesome-dsh-plugins@main/data/plugins.json",
  "https://fastly.jsdelivr.net/gh/dshworks/awesome-dsh-plugins@main/data/plugins.json",
];

/**
 * slim.json 体积验收上限（3MB）。真实 13.4MB 源过滤+瘦身后的产物约 1.5-2MB；
 * 若未来源膨胀超限，降级旋钮是把 slimEntries 的 description 截断从 120 收到 80
 * （本文件 truncateText 调用点），预估可再省 ~15%。不在此做动态降级逻辑，
 * 体积断言由 test/wb-awesome-market.mjs 钉住。
 */
export const SLIM_MAX_BYTES = 3 * 1024 * 1024;

const USER_AGENT = "@2026heshao/dsh-armory (+https://github.com/2026heshao/dsh-armory)";
const DOWNLOAD_TIMEOUT_MS = 120_000; // 13.4MB 全量下载的超时余量
const PROBE_TIMEOUT_MS = 30_000; // HEAD 条件探测轻量快速

/**
 * 首屏提速（stale-while-revalidate）：磁盘/内存有货就立刻返回，网络再验证挪到后台。
 * 缓存龄期超过该值才触发一次后台再验证，期间调用方秒回旧数据、UI 不转圈。
 */
const REVALIDATE_AFTER_MS = 5 * 60_000;
/** 后台再验证失败后的退避窗口，避免每次进面板都重试两个 CDN（各 120s 超时）。 */
const REVALIDATE_BACKOFF_MS = 60_000;

/** 存储根目录：显式 rootDir > 环境变量 > 真实 ~/.dsh/armory（与 wb-registry.js 同款）。 */
function awesomeRootDir(options = {}) {
  return options.rootDir || process.env.DSH_ARMORY_HOME || join(homedir(), ".dsh", "armory");
}

/** 缓存子目录：<root>/awesome-market。 */
function awesomeMarketDir(options = {}) {
  return join(awesomeRootDir(options), "awesome-market");
}

function slimPathOf(options = {}) {
  return join(awesomeMarketDir(options), "slim.json");
}

function metaPathOf(options = {}) {
  return join(awesomeMarketDir(options), "meta.json");
}

/** 读 JSON 文件；不存在/损坏一律返回 null（调用方决定回落语义），永不抛错。 */
async function readJsonAt(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** staging + rename 原子写（wb-registry.js writeAtomic 同款）：先写 <file>.staging，
 *  Windows rename 不覆盖所以先 rm 旧文件再 rename。文本一律 UTF-8。 */
async function writeAtomic(path, text) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const dir = cut > 0 ? path.slice(0, cut) : path;
  await mkdir(dir, { recursive: true });
  await writeFile(`${path}.staging`, text, "utf8");
  await rm(path, { force: true });
  await rename(`${path}.staging`, path);
}

// ── 瘦身（纯函数）──────────────────────────────────────────────────────────

/** npm 字段防御提取：非空字符串直取；{name} 形态取 npm.name；其余出局（返回 ""）。 */
function extractNpm(value) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || "";
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    if (typeof value.name === "string") {
      const trimmed = value.name.trim();
      return trimmed || "";
    }
  }
  return "";
}

/** description 防御截断：非字符串回落 ""；字符串截断 ≤120 字符（降级旋钮见 SLIM_MAX_BYTES）。 */
function truncateText(value, maxChars = 120) {
  return typeof value === "string" ? value.slice(0, maxChars) : "";
}

/** tags 防御归一：非数组 → []；数组只留字符串且最多 2 个。 */
function normalizeTags(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((tag) => typeof tag === "string").slice(0, 2);
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
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    if (raw.status !== "verified") continue;
    const npm = extractNpm(raw.npm);
    if (!npm) continue;
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!name) continue;
    const category = typeof raw.category === "string" && raw.category.trim() ? raw.category.trim() : "plugin";
    slim.push({
      name,
      repo: typeof raw.repo === "string" ? raw.repo : "",
      npm,
      description: truncateText(raw.description, 120),
      category,
      status: "verified",
      tags: normalizeTags(raw.tags),
      stars: typeof raw.stars === "number" && Number.isFinite(raw.stars) ? raw.stars : 0,
      official: Boolean(raw.official),
      verifiedAgainst: typeof raw.verifiedAgainst === "string" ? raw.verifiedAgainst : "",
      lastVerified: typeof raw.lastVerified === "string" ? raw.lastVerified : "",
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

// ── 拉取链与缓存落盘 ────────────────────────────────────────────────────────

/**
 * 按 AWESOME_SOURCES 顺序拉取：单源失败（网络异常 / 非 2xx / 响应体畸形）→ 试下一源。
 * 带 If-None-Match 条件头（仅当 etag 非空）；304 且有 etag → { ok, notModified }。
 * 全源失败 → { ok: false, error }。下载全程带 120s 超时。
 */
async function fetchChain(etag) {
  const headers = { "user-agent": USER_AGENT };
  if (etag) headers["if-none-match"] = etag;
  let lastError = "";
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
      const text = Buffer.from(await response.arrayBuffer()).toString("utf8");
      const data = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.plugins)) {
        throw new Error("响应缺少 plugins 数组");
      }
      return { ok: true, data, etag: response.headers.get("etag") || "", source: sourceUrl };
    } catch (error) {
      lastError = `${sourceUrl} → ${error.message}`;
      continue;
    }
  }
  return { ok: false, error: `全部 awesome 源拉取失败：${lastError}` };
}

/** 瘦身结果 + 元信息原子落盘（slim.json + meta.json），返回 counts。
 *  同时刷新进程内缓存层，后续调用免掉 readFile + JSON.parse。
 *  source 记录「这份缓存是从哪个源拿到的」：探测时优先回同一源比对 ETag，
 *  避免主源挂掉走备用源取到缓存后、探测却只问主源而误报失败。 */
async function persistSlim(entries, etag, updated, options = {}, source = "") {
  const counts = countsOf(entries);
  const fetchedAt = Date.now();
  await writeAtomic(slimPathOf(options), JSON.stringify(entries));
  await writeAtomic(metaPathOf(options), JSON.stringify({ etag, fetchedAt, updated, counts, source }));
  setMemSlim(options, entries, { etag, fetchedAt, updated, counts, source });
  return counts;
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

/**
 * 后台再验证：不阻塞调用方；单航班 + 失败退避。
 * 成功时 refreshFromNetwork 已把新数据原子落盘并刷新内存层，下次请求即拿新结果；
 * 失败只静默保留旧缓存（陈旧但可用，绝不把错误抛给 UI）。
 */
function revalidateInBackground(options = {}) {
  if (revalidating) return revalidating;
  if (revalidateFailedAt > 0 && Date.now() - revalidateFailedAt < REVALIDATE_BACKOFF_MS) return null;
  revalidating = (async () => {
    try {
      const cache = await readSlimCache(options);
      const etag = cache && typeof cache.meta.etag === "string" ? cache.meta.etag : "";
      const chain = await fetchChain(etag);
      if (!chain.ok) {
        revalidateFailedAt = Date.now();
        return;
      }
      if (!chain.notModified) await refreshFromNetwork(chain, options);
      revalidateFailedAt = 0;
    } catch {
      revalidateFailedAt = Date.now();
    } finally {
      revalidating = null;
    }
  })();
  return revalidating;
}

/**
 * 304 命中：内容未变，只把 meta.fetchedAt 推到当前时刻以重置 stale 计时
 * （否则缓存会永远被判为「陈旧」，每次进面板都白跑一次网络验证）。
 * 写盘失败不影响返回值：内存层已更新。
 */
async function touchSlimMeta(options = {}, cache) {
  const meta = { ...(cache.meta || {}), fetchedAt: Date.now() };
  setMemSlim(options, cache.entries, meta);
  try {
    await writeAtomic(metaPathOf(options), JSON.stringify(meta));
  } catch {
    /* 元信息落盘失败可接受：下次仍会再验证一次 */
  }
  return meta;
}

/** 统一组装 catalog 响应体（cache/disk 复用）：counts 优先用 meta 里落盘的统计。 */
function catalogResult(entries, meta, loadedFrom, extra = {}) {
  const counts =
    meta && typeof meta.counts === "object" && meta.counts !== null && Number.isFinite(meta.counts.total)
      ? meta.counts
      : countsOf(entries);
  const fetchedAt = Number(meta && meta.fetchedAt);
  return {
    ok: true,
    loadedFrom,
    updated: typeof meta.updated === "string" ? meta.updated : "",
    fetchedAt: Number.isFinite(fetchedAt) && fetchedAt > 0 ? fetchedAt : 0,
    counts,
    plugins: entries,
    marketplace: AWESOME_MARKETPLACE_ID,
    ...extra,
  };
}

/** 拉取链成功后的统一走线：瘦身 → 原子落盘 → 组装 network 响应。 */
async function refreshFromNetwork(chain, options = {}) {
  const entries = slimEntries(chain.data.plugins);
  const counts = await persistSlim(entries, chain.etag, typeof chain.data.updated === "string" ? chain.data.updated : "", options, typeof chain.source === "string" ? chain.source : "");
  return {
    ok: true,
    loadedFrom: "network",
    updated: typeof chain.data.updated === "string" ? chain.data.updated : "",
    fetchedAt: Date.now(),
    counts,
    plugins: entries,
    marketplace: AWESOME_MARKETPLACE_ID,
  };
}

// ── 四个对外 API ───────────────────────────────────────────────────────────

/**
 * 读 awesome 目录（缓存优先 + 后台再验证 → 首屏秒出）：
 *   1. refresh: true（UI「重新加载」按钮）→ 同步强刷：条件 GET，304 复用缓存
 *      （loadedFrom: "cache"）；200 重新瘦身落盘（"network"）；全源失败且有缓存
 *      回落 "disk" + stale: true；无缓存 { ok: false }。
 *   2. 缓存新鲜（龄期 < REVALIDATE_AFTER_MS）→ 直接返内存/磁盘缓存（"cache"），
 *      完全不碰网络。
 *   3. 缓存陈旧 → 仍立刻返回旧缓存（"cache" + refreshing: true），网络验证丢给
 *      后台单航班；下次进面板即拿到新数据，失败静默保留旧缓存。
 *   4. 无缓存（真正的首次）→ 全量拉取 → 瘦身落盘（"network"）。
 * 响应统一带 fetchedAt（缓存抓取时刻）与（陈旧分支的）refreshing 标记，
 * 供 UI 直接显示「后台更新中」而无需二次请求。
 * 永不抛错（拉取/解析/写盘异常都折进返回体）。
 */
export async function wbAwesomeCatalog(options = {}) {
  const wantRefresh = Boolean(options) && options.refresh === true;
  try {
    const cache = await readSlimCache(options, { useMem: !wantRefresh });
    if (cache) {
      const etag = typeof cache.meta.etag === "string" ? cache.meta.etag : "";
      if (!wantRefresh && ageOfMeta(cache.meta) < REVALIDATE_AFTER_MS) {
        return catalogResult(cache.entries, cache.meta, "cache");
      }
      if (!wantRefresh) {
        // 陈旧缓存：先秒回旧数据，网络验证交给后台（单航班 + 失败退避）。
        revalidateInBackground(options);
        return catalogResult(cache.entries, cache.meta, "cache", { refreshing: true });
      }
      const chain = await fetchChain(etag);
      if (chain.ok && chain.notModified) return catalogResult(cache.entries, await touchSlimMeta(options, cache), "cache");
      if (chain.ok) return await refreshFromNetwork(chain, options);
      // 全源失败但磁盘有货：返回陈旧缓存，stale 标记交给 UI 出提示条。
      return catalogResult(cache.entries, cache.meta, "disk", { stale: true });
    }
    const chain = await fetchChain("");
    if (!chain.ok) return { ok: false, error: chain.error };
    return await refreshFromNetwork(chain, options);
  } catch (error) {
    return { ok: false, error: `awesome 目录加载异常：${error.message}` };
  }
}

/** 按名字查瘦身缓存单条；无缓存先 ensureSlim（走 wbAwesomeCatalog 全量链）；
 *  名字不存在 / 加载失败返回 null。 */
export async function wbAwesomeDetail(name, options = {}) {
  const wanted = typeof name === "string" ? name.trim() : "";
  if (!wanted) return null;
  try {
    let cache = await readSlimCache(options);
    if (!cache) {
      const fresh = await wbAwesomeCatalog(options);
      if (!fresh.ok) return null;
      return fresh.plugins.find((entry) => entry.name === wanted) ?? null;
    }
    return cache.entries.find((entry) => entry.name === wanted) ?? null;
  } catch {
    return null;
  }
}

/**
 * 单源 ETag 条件探测：HEAD（被 405/501 拒绝则降级 GET 并立刻 cancel 响应体）。
 * 绝不落盘，只取 headers。返回 { ok: true, remoteEtag } 或 { ok: false, error }。
 */
async function probeEtagAt(sourceUrl, localEtag) {
  const headers = { "user-agent": USER_AGENT, "if-none-match": localEtag };
  let response;
  try {
    response = await fetch(sourceUrl, { method: "HEAD", headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (response.status === 405 || response.status === 501) {
      // HEAD 不被支持 → 降级 GET，立刻 cancel() 丢弃响应体，不读进内存。
      response.body?.cancel?.();
      response = await fetch(sourceUrl, { method: "GET", headers, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      response.body?.cancel?.();
    }
  } catch (error) {
    return { ok: false, error: `${sourceUrl} → ${error.message}` };
  }
  if (response.status === 304) return { ok: true, remoteEtag: localEtag };
  if (response.ok) {
    const remoteEtag = response.headers.get("etag") || "";
    // 探测只信 ETag：响应没有 ETag 就无法判定，宁可报探测失败也不误报「有更新」。
    if (!remoteEtag) return { ok: false, error: `${sourceUrl} → 响应缺少 ETag` };
    return { ok: true, remoteEtag };
  }
  return { ok: false, error: `${sourceUrl} → HTTP ${response.status}` };
}

/**
 * ETag 条件探测（wbPluginUpdateCheck 同款语义）：**绝不落盘**，只取 headers。
 * reason 五枚举：no-source / probe-failed / no-cache / up-to-date / update-available。
 * 无缓存（meta 无 etag）→ hasUpdate: false + no-cache（与插件市场不同：awesome 首次
 * 由 catalog 链兜底加载，探测层不引导更新）。
 *
 * 探测与目录拉取必须走同一条源链：过去只问 AWESOME_SOURCES[0]，于是「主源不通、
 * 目录靠备用源成功」的机器上目录能正常加载、探测却每次 probe-failed —— 这正是
 * 「DSH 社区目录更新探测失败」的来源。现在按「缓存实际来源 → 全部源」顺序逐个试，
 * 首个拿到 ETag 的源胜出；全部失败才报 probe-failed。
 */
export async function wbAwesomeUpdateCheck(options = {}) {
  try {
    const meta = (await readJsonAt(metaPathOf(options))) || {};
    const localEtag = typeof meta.etag === "string" ? meta.etag : "";
    if (!localEtag) {
      return { ok: true, hasUpdate: false, reason: "no-cache", localEtag: "", remoteEtag: "", checkedAt: Date.now() };
    }
    // 先问拿到这份缓存的源（ETag 同源可比），再兜底其余源。
    const cachedSource = typeof meta.source === "string" ? meta.source : "";
    const candidates = [...new Set([cachedSource, ...AWESOME_SOURCES].filter(Boolean))];
    let lastError = "";
    for (const sourceUrl of candidates) {
      const probe = await probeEtagAt(sourceUrl, localEtag);
      if (!probe.ok) {
        lastError = probe.error;
        continue;
      }
      const hasUpdate = probe.remoteEtag !== localEtag;
      return { ok: true, hasUpdate, reason: hasUpdate ? "update-available" : "up-to-date", localEtag, remoteEtag: probe.remoteEtag, checkedAt: Date.now() };
    }
    return { ok: false, hasUpdate: false, reason: "probe-failed", localEtag, remoteEtag: "", checkedAt: Date.now(), error: `awesome 市场更新探测失败：${lastError}` };
  } catch (error) {
    return { ok: false, hasUpdate: false, reason: "probe-failed", localEtag: "", remoteEtag: "", checkedAt: Date.now(), error: `更新探测异常：${error.message}` };
  }
}

/** 缓存元信息（只读，不联网）：{ hasCache, etag, fetchedAt, updated }。 */
export async function wbAwesomeCachedInfo(options = {}) {
  const cache = await readSlimCache(options);
  if (!cache) return { hasCache: false, etag: "", fetchedAt: 0, updated: "" };
  const meta = cache.meta;
  return {
    hasCache: true,
    etag: typeof meta.etag === "string" ? meta.etag : "",
    fetchedAt: typeof meta.fetchedAt === "number" ? meta.fetchedAt : 0,
    updated: typeof meta.updated === "string" ? meta.updated : "",
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
const README_FILES = ["README.md", "readme.md", "Readme.md", "README.MD", "README.markdown", "README_EN.md"];
const NPM_REGISTRY = "https://registry.npmjs.org";

function readmeCacheDir(options = {}) {
  return join(awesomeMarketDir(options), "readme");
}

/** 缓存文件名：来源标识压成安全短名（不用 crypto，避免多一个依赖）。 */
function readmeCachePath(key, options = {}) {
  const safe = String(key || "").toLowerCase().replace(/[^a-z0-9._-]+/g, "_").slice(0, 96) || "item";
  return join(readmeCacheDir(options), `${safe}.json`);
}

/**
 * 从各种形态的仓库字段里提取 `owner/repo`；不是 GitHub 或提取不到返回 ""。
 * 吃到过的形态：`owner/repo`、`https://github.com/o/r`、`git+https://github.com/o/r.git`、
 * `git@github.com:o/r.git`、带 `#readme` / `/tree/main` 尾巴的。
 */
export function parseGithubRepo(value) {
  if (typeof value !== "string") return "";
  let text = value.trim();
  if (!text) return "";
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s#]+?)(?:\.git)?$/i.exec(text);
  if (ssh) return `${ssh[1]}/${ssh[2].replace(/\.git$/i, "")}`;
  text = text.replace(/^git\+/i, "");
  const http = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(text);
  if (http) return `${http[1]}/${http[2].replace(/\.git$/i, "")}`;
  const bare = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9._-]+)$/.exec(text);
  if (bare) return `${bare[1]}/${bare[2].replace(/\.git$/i, "")}`;
  return "";
}

/** 正文规整：去 BOM、统一换行、按字符上限截断。 */
function normalizeReadme(text) {
  let out = String(text || "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
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
      headers: { "user-agent": USER_AGENT, accept },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!response.ok) {
      try {
        await response.text();
      } catch {
        // 忽略：只为释放连接
      }
      return { ok: false, reachable: true, status: response.status, error: `HTTP ${response.status}` };
    }
    return { ok: true, reachable: true, status: response.status, text: await response.text(), url: response.url || url };
  } catch (error) {
    const reason = error && error.name === "AbortError" ? `超时（${README_TIMEOUT_MS}ms）` : String((error && error.message) || error);
    return { ok: false, reachable: false, status: 0, error: reason };
  } finally {
    clearTimeout(timer);
  }
}

/** npm 侧取 README：先打 `/<pkg>/latest`（小），没有再退全量 packument。 */
async function readmeFromNpm(npmName) {
  const encoded = String(npmName).replace(/\//g, "%2F");
  const latest = await fetchReadmeText(`${NPM_REGISTRY}/${encoded}/latest`, "application/json");
  if (latest.ok) {
    let doc = null;
    try {
      doc = JSON.parse(latest.text);
    } catch {
      doc = null;
    }
    if (doc && typeof doc.readme === "string" && doc.readme.trim()) {
      return { ok: true, markdown: doc.readme, repo: parseGithubRepo(doc.repository), file: doc.readmeFilename || "README.md" };
    }
  }
  const full = await fetchReadmeText(`${NPM_REGISTRY}/${encoded}`, "application/json");
  if (!full.ok) {
    return { ok: false, error: full.error };
  }
  let packument = null;
  try {
    packument = JSON.parse(full.text);
  } catch {
    return { ok: false, error: "npm 返回的不是合法 JSON" };
  }
  const markdown = packument && typeof packument.readme === "string" ? packument.readme : "";
  if (!markdown.trim()) {
    return { ok: false, error: latest.ok ? "npm 包没有 README" : `${latest.error}；npm 包没有 README` };
  }
  return { ok: true, markdown, repo: parseGithubRepo(packument.repository), file: packument.readmeFilename || "README.md" };
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
  let lastError = "";
  let sawReachable = false;
  for (const base of readmeGithubBases(repo)) {
    for (const file of README_FILES) {
      const attempt = await fetchReadmeText(`${base}${file}`, "text/plain");
      if (attempt.ok && attempt.text.trim()) {
        return { ok: true, markdown: attempt.text, base, file };
      }
      if (attempt.ok) {
        lastError = "文件为空";
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
  return { ok: false, error: lastError || "未找到 README" };
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
 */
export async function wbAwesomeReadme(payload = {}) {
  const name = typeof payload.name === "string" ? payload.name.trim() : "";
  const npmName =
    typeof payload.npm === "string"
      ? payload.npm.trim()
      : payload.npm && typeof payload.npm === "object" && typeof payload.npm.name === "string"
        ? payload.npm.name.trim()
        : "";
  let repo = parseGithubRepo(payload.repo);
  const wantRefresh = payload.refresh === true;
  if (!npmName && !repo) {
    return { ok: false, reason: "no-source", name, npm: "", repo: "", markdown: "", truncated: false, source: "", base: "", fetchedAt: 0, error: "该条目没有 npm 包名或 GitHub 仓库地址，无法读取 README" };
  }
  const cacheKey = npmName || repo;
  const cachePath = readmeCachePath(cacheKey, payload);
  if (!wantRefresh) {
    const cached = await readJsonAt(cachePath);
    if (
      cached &&
      typeof cached.markdown === "string" &&
      cached.markdown &&
      Date.now() - Number(cached.fetchedAt || 0) < README_CACHE_TTL_MS
    ) {
      return {
        ok: true,
        reason: "cache",
        name,
        npm: npmName,
        repo: typeof cached.repo === "string" ? cached.repo : repo,
        markdown: cached.markdown,
        truncated: Boolean(cached.truncated),
        source: typeof cached.source === "string" ? cached.source : "",
        base: typeof cached.base === "string" ? cached.base : "",
        fetchedAt: Number(cached.fetchedAt || 0),
      };
    }
  }
  let markdown = "";
  let source = "";
  let base = "";
  const errors = [];
  if (npmName) {
    const fromNpm = await readmeFromNpm(npmName);
    if (fromNpm.ok) {
      markdown = fromNpm.markdown;
      source = "npm";
      repo = repo || parseGithubRepo(fromNpm.repo);
      base = repo ? `https://raw.githubusercontent.com/${repo}/HEAD/` : "";
    } else {
      errors.push(`npm：${fromNpm.error}`);
    }
  }
  if (!markdown && repo) {
    const fromGithub = await readmeFromGithub(repo);
    if (fromGithub.ok) {
      markdown = fromGithub.markdown;
      source = "github";
      base = fromGithub.base;
    } else {
      errors.push(`github：${fromGithub.error}`);
    }
  }
  if (!markdown.trim()) {
    return { ok: false, reason: "readme-unavailable", name, npm: npmName, repo, markdown: "", truncated: false, source: "", base: "", fetchedAt: 0, error: `读取 README 失败：${errors.join("；") || "没有可用来源"}` };
  }
  const normalized = normalizeReadme(markdown);
  const fetchedAt = Date.now();
  try {
    await writeAtomic(
      cachePath,
      JSON.stringify({ name, npm: npmName, repo, markdown: normalized.markdown, truncated: normalized.truncated, source, base, fetchedAt }),
    );
  } catch {
    // 缓存写不进去不影响这次预览
  }
  return { ok: true, reason: "network", name, npm: npmName, repo, markdown: normalized.markdown, truncated: normalized.truncated, source, base, fetchedAt };
}
