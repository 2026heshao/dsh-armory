// npm 下载量（只读）：插件卡片底栏那个「↓N」的唯一真实来源。
//
// 为什么单独一层：
//   - 社区目录（awesome-dsh-plugins 的 slim.json）每条只带 11 个字段，**没有任何下载量**，
//     也没有插件自身的更新时间。技能卡上的 ↓8.5M 来自 SkillHub 上游，插件这边对应的
//     真实信号只有 npm 的下载统计 —— 所以去 npm 取，绝不为让卡片"看起来丰富"而造数。
//   - 一页 50 张卡片，全量拉取就是 50 次外网请求；因此采集必须**按可见卡片懒加载**，
//     缓存与限流收在这一层（口径照 lib/community-meta.js：命中缓存不联网、失败回落旧数据）。
//
// 边界：
//   - 只读公开接口 https://api.npmjs.org/downloads/point/last-month/<pkg>，不带任何凭据。
//   - 单次最多 12 个包；进程内并发 2 + 每次请求起手间隔 ≥220ms；单请求 8 秒超时。
//     这两个数是**实测出来的**（2026-10-24，本机出口）：12 个请求并发打过去 429 占一半以上，
//     而 3 req/s 连发 15 个全绿 —— 所以宁可慢一点，也不要把公开接口打到限流。
//   - 数字是**近 30 天窗口**，不是累计（SkillHub 那个 ↓ 是累计）—— 所以 UI 必须带
//     tooltip 说明区间，不能让它被读成"总下载量"。
//   - 缓存落在 ~/.dsh/armory/npm-downloads.json，staging + rename 原子写；测试可注入
//     rootDir / fetchImpl / paceMs（paceMs 只是把节奏调快，逻辑与生产同一条路）。
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const NPM_DOWNLOADS_VERSION = 1;
// npm 的下载统计本身按天更新，7 天缓存在"数字够新"和"少打外网"之间取值。
export const NPM_DOWNLOADS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const NPM_DOWNLOADS_MAX_PACKAGES = 12;
// 429 之后冷却 60 秒（不是 10 分钟）：实测这个限流是**速率型**的，一分钟内就回血；
// 冷却太长会让整页卡片在用户来回翻看时一直空着。
export const NPM_DOWNLOADS_COOLDOWN_MS = 60_000;
const NPM_DOWNLOADS_CONCURRENCY = 2;
const NPM_DOWNLOADS_PACE_MS = 220;
const NPM_DOWNLOADS_TIMEOUT_MS = 8_000;
const NPM_DOWNLOADS_RETRY_MS = 900;

const NPM_STATS_API = "https://api.npmjs.org/downloads/point/last-month/";
const USER_AGENT = "@2026heshao/dsh-armory (+https://github.com/2026heshao/dsh-armory)";

/** 存储根目录：显式 rootDir > 环境变量 > 真实 ~/.dsh/armory（与 community-meta 同一解析序）。 */
function armoryRoot(options = {}) {
  return options.rootDir || process.env.DSH_ARMORY_HOME || join(homedir(), ".dsh", "armory");
}

export function npmDownloadsPath(options = {}) {
  return join(armoryRoot(options), "npm-downloads.json");
}

/**
 * npm 包名合法性：unscoped `foo`、scoped `@scope/foo`，可带 . _ - 数字。
 * 返回规范化后的名字，不合法返回 ""（脏数据绝不发进外网请求）。
 */
export function normalizePackageName(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  if (/^@[a-z0-9][a-z0-9._-]{0,39}\/[a-z0-9][a-z0-9._~!()'*-]{0,214}$/i.test(text)) return text;
  if (/^[a-z0-9][a-z0-9._~!()'*-]{0,214}$/i.test(text)) return text;
  return "";
}

/** 入参归一：字符串 / 数组 / {npm|package} 对象都收，去重、去空、最多 12 条。 */
export function normalizePackageList(value) {
  const rows = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const raw = row && typeof row === "object" ? row.npm || row.package || row.name || "" : row;
    const name = normalizePackageName(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= NPM_DOWNLOADS_MAX_PACKAGES) break;
  }
  return out;
}

/** npm 统计响应 → 窄投影（不落全量 JSON，缓存小且字段稳定）。 */
export function projectDownloads(pkg, data) {
  const downloads = typeof data?.downloads === "number" && Number.isFinite(data.downloads) ? data.downloads : null;
  return {
    package: String(data?.package || pkg),
    downloads,
    start: typeof data?.start === "string" ? data.start : "",
    end: typeof data?.end === "string" ? data.end : "",
    period: "last-month",
  };
}

async function readCache(options = {}) {
  try {
    const raw = JSON.parse(await readFile(npmDownloadsPath(options), "utf8"));
    const packages = raw && typeof raw.packages === "object" && raw.packages !== null && !Array.isArray(raw.packages) ? raw.packages : {};
    return {
      version: raw && typeof raw.version === "number" ? raw.version : NPM_DOWNLOADS_VERSION,
      packages,
      unavailableUntil: typeof raw?.unavailableUntil === "number" ? raw.unavailableUntil : 0,
    };
  } catch {
    return { version: NPM_DOWNLOADS_VERSION, packages: {}, unavailableUntil: 0 };
  }
}

function dirnameOf(path) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

async function writeCache(cache, options = {}) {
  const path = npmDownloadsPath(options);
  await mkdir(dirnameOf(path), { recursive: true });
  // 唯一临时名 + rename：固定 `.staging` 在并发写（refresh 与懒加载两条路同时回来）时
  // 会互相踩踏出撕坏的文件。rename 覆盖目标，不再需要先 rm（那一步还会留出空窗）。
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(cache, null, 2));
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

function errorText(error) {
  return String(error?.message || error || "读取失败").slice(0, 200);
}

/** scoped 名要把斜杠转义成 %2F，前导 @ 保留 —— npm 统计接口认这个写法。 */
function statsUrl(pkg) {
  return `${NPM_STATS_API}${pkg.replace("/", "%2F")}`;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** retry-after 可能是秒数，也可能是 HTTP-date；只认秒数，其它一律按 0（回落到默认退避）。 */
function retryAfterMs(res) {
  const raw = Number(res?.headers?.get?.("retry-after"));
  return Number.isFinite(raw) && raw > 0 ? Math.min(raw * 1000, 30_000) : 0;
}

/**
 * 全局节流闸门：所有请求（含 429 重试）都排这一个队，保证**起手间隔 ≥paceMs**。
 * 并发数管不住速率——两个 worker 各自连发照样能冲到 9 req/s，实测那就是 429 的成因。
 * 单次调用内共享一个 gater，调用之间不跨批持有（每批重新起算，缓存命中根本不进这里）。
 */
function createPacer(paceMs) {
  let next = 0;
  let chain = Promise.resolve();
  return () => {
    const run = () => {
      const now = Date.now();
      const at = Math.max(now, next);
      next = at + paceMs;
      return at > now ? wait(at - now) : undefined;
    };
    chain = chain.then(run, run);
    return chain;
  };
}

/** 取一个包的下载量；调用方已保证并发与节流，这里只管单次请求、一次退避重试与失败口径。 */
async function fetchOne(pkg, cache, options, now, fetchImpl, pace) {
  const key = pkg.toLowerCase();
  const entry = cache.packages[key];
  const send = async () => fetchImpl(statsUrl(pkg), {
    headers: { "user-agent": USER_AGENT, accept: "application/json" },
    signal: AbortSignal.timeout(NPM_DOWNLOADS_TIMEOUT_MS),
  });
  try {
    await pace();
    let response = await send();
    // 429 是速率限流、不是「这个包没有」：等一会儿再试一次，很多数字就是这么救回来的。
    if (response.status === 429) {
      const backoff = Math.min(retryAfterMs(response) || NPM_DOWNLOADS_RETRY_MS, 5_000);
      await wait(backoff);
      await pace();
      response = await send();
    }
    if (response.status === 404) {
      // 包下架 / 改名 / 从未被统计：这一条没有下载量，卡片就少这一枚，绝不显示 0 冒充"没人下"。
      cache.packages[key] = { fetchedAt: now, missing: true, data: null };
      return { ok: false, missing: true, package: pkg };
    }
    if (response.status === 429 || response.status === 500 || response.status === 502 || response.status === 503) {
      cache.unavailableUntil = now + NPM_DOWNLOADS_COOLDOWN_MS;
      throw new Error(`npm 统计接口暂时不可用（HTTP ${response.status}）`);
    }
    if (!response.ok) throw new Error(`npm 统计接口返回 HTTP ${response.status}`);
    const data = projectDownloads(pkg, await response.json());
    if (data.downloads === null) {
      cache.packages[key] = { fetchedAt: now, missing: true, data: null };
      return { ok: false, missing: true, package: pkg };
    }
    cache.packages[key] = { fetchedAt: now, missing: false, data };
    return { ok: true, cached: false, ...data };
  } catch (error) {
    const message = errorText(error);
    // 有旧值就继续显示旧值（stale），网络抖动绝不能把卡片上的数字打没。
    if (entry?.data) return { ok: true, cached: true, stale: true, ...entry.data, error: message };
    return { ok: false, error: message, package: pkg };
  }
}

/**
 * 批量读取 npm 包近 30 天下载量。
 *
 * 入参：`{ packages: string[] | {npm}[] | string, refresh?: boolean }`
 * 返回：`{ packages: { "<pkg>": { ok, downloads?, start?, end?, cached?, stale?, missing?, error? } }, fetchedAt }`
 *
 * 单条失败不抛整体错误：UI 要能区分「这个包查不到」和「整个接口挂了」。
 * 失败的包**不写缓存**（下次翻页/重载会再试），确认没有的包才粘住 7 天。
 */
export async function wbNpmDownloads(payload = {}, options = {}) {
  const packages = normalizePackageList(payload?.packages ?? payload?.package ?? payload?.npm);
  const now = Date.now();
  if (!packages.length) return { packages: {}, fetchedAt: now };
  const cache = await readCache(options);
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : fetch;
  const pace = createPacer(Number.isFinite(Number(options.paceMs)) ? Math.max(0, Number(options.paceMs)) : NPM_DOWNLOADS_PACE_MS);
  const results = {};
  const pending = [];

  for (const pkg of packages) {
    const entry = cache.packages[pkg.toLowerCase()];
    const fresh = entry && entry.data && now - Number(entry.fetchedAt || 0) < NPM_DOWNLOADS_TTL_MS;
    if (entry && entry.missing && now - Number(entry.fetchedAt || 0) < NPM_DOWNLOADS_TTL_MS && payload?.refresh !== true) {
      // 7 天内查过且确认没有（下架 / 未统计）：不重复打外网。
      results[pkg] = { ok: false, missing: true, cached: true, package: pkg };
      continue;
    }
    if (fresh && payload?.refresh !== true) {
      results[pkg] = { ok: true, cached: true, ...entry.data };
      continue;
    }
    if (cache.unavailableUntil && now < cache.unavailableUntil) {
      results[pkg] = entry?.data
        ? { ok: true, cached: true, stale: true, ...entry.data, error: "npm 统计接口冷却中，显示的是缓存" }
        : { ok: false, error: "npm 统计接口冷却中，稍后再试", package: pkg };
      continue;
    }
    pending.push(pkg);
  }

  // 并发 2 + 起手节流：并发只是别把连接数堆起来，真正决定 429 的是**速率**。
  const cursor = { i: 0 };
  const workers = Array.from({ length: Math.min(NPM_DOWNLOADS_CONCURRENCY, pending.length) }, async () => {
    for (;;) {
      const index = cursor.i;
      cursor.i += 1;
      if (index >= pending.length) return;
      const pkg = pending[index];
      results[pkg] = await fetchOne(pkg, cache, options, now, fetchImpl, pace);
    }
  });
  await Promise.all(workers);

  try {
    await writeCache(cache, options);
  } catch {
    // 缓存写失败不影响本次结果；下次只是多打一次网络。
  }
  return { packages: results, fetchedAt: now };
}
