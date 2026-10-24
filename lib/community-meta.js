// 社区元信息（只读）：仓库的「人味」信号——维护者、最近提交、issue 数、Star。
//
// 为什么单独一层：
//   - 市场目录里的条目只带「上次核验」「发布方」这类静态字段，看不出这个项目
//     **现在还活着吗**。GitHub 的 pushed_at / open_issues / archived 是最直接的证据。
//   - 这些请求只应在用户真正打开某条详情时按需发生（每页 12 张卡片全量拉取会迅速
//     耗尽未认证 GitHub 的 60 次/小时配额），所以缓存与限流处理必须在这里收口。
//
// 边界：
//   - 只读公开接口，不接受 token，不写任何用户数据。
//   - 单次最多 8 个仓库；命中 6 小时缓存不联网；有旧缓存时网络失败回落旧数据并标记 stale。
//   - 缓存落在 ~/.dsh/armory/github-meta.json，staging + rename 原子写；测试可注入 rootDir/fetch。
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const COMMUNITY_META_VERSION = 1;
export const COMMUNITY_META_TTL_MS = 6 * 60 * 60 * 1000;
export const COMMUNITY_META_MAX_REPOS = 8;

const GITHUB_API = "https://api.github.com/repos/";
const USER_AGENT = "@2026heshao/dsh-armory (+https://github.com/2026heshao/dsh-armory)";

/** 存储根目录：显式 rootDir > 环境变量 > 真实 ~/.dsh/armory（与 install-state 同一解析序）。 */
function armoryRoot(options = {}) {
  return options.rootDir || process.env.DSH_ARMORY_HOME || join(homedir(), ".dsh", "armory");
}

export function repoMetaPath(options = {}) {
  return join(armoryRoot(options), "github-meta.json");
}

/**
 * 从各种仓库写法里提取 `owner/repo`：
 *   owner/repo、https://github.com/o/r、git+https://github.com/o/r.git、
 *   git@github.com:o/r.git、带 #readme / /tree/main 尾巴的。
 * 不是 GitHub 或提取不到返回 ""。
 */
export function parseGithubRepo(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s#]+?)(?:\.git)?$/i.exec(text);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const http = /^(?:git\+)?https?:\/\/(?:www\.)?github\.com\/([^/\s#?]+)\/([^/\s#?]+)/i.exec(text);
  if (http) return `${http[1]}/${http[2].replace(/\.git$/i, "")}`;
  const bare = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(text);
  if (bare) return `${bare[1]}/${bare[2].replace(/\.git$/i, "")}`;
  return "";
}

/** 入参归一：字符串 / 数组 / {repo} 对象都收，去重、去空、最多 8 条。 */
export function normalizeRepoList(value) {
  const rows = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const raw = row && typeof row === "object" ? row.repo || row.repository || "" : row;
    const repo = parseGithubRepo(raw);
    if (!repo) continue;
    const key = repo.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(repo);
    if (out.length >= COMMUNITY_META_MAX_REPOS) break;
  }
  return out;
}

function stringOf(value) {
  return typeof value === "string" ? value : "";
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** GitHub 原始响应 → 面板需要的窄投影（不落全量 JSON，缓存小且字段稳定）。 */
export function projectRepoMeta(repo, data) {
  const owner = stringOf(data?.owner?.login) || String(repo).split("/")[0] || "";
  const full = stringOf(data?.full_name) || repo;
  const license = data?.license && typeof data.license === "object" ? stringOf(data.license.spdx_id) : "";
  return {
    repo: full,
    owner,
    ownerAvatar: stringOf(data?.owner?.avatar_url) || (owner ? `https://github.com/${owner}.png?size=64` : ""),
    ownerUrl: stringOf(data?.owner?.html_url) || (owner ? `https://github.com/${owner}` : ""),
    htmlUrl: stringOf(data?.html_url) || `https://github.com/${full}`,
    description: stringOf(data?.description),
    stars: numberOrZero(data?.stargazers_count),
    forks: numberOrZero(data?.forks_count),
    openIssues: numberOrZero(data?.open_issues_count),
    watchers: numberOrZero(data?.subscribers_count),
    pushedAt: stringOf(data?.pushed_at),
    updatedAt: stringOf(data?.updated_at),
    archived: data?.archived === true,
    disabled: data?.disabled === true,
    license,
    language: stringOf(data?.language),
    homepage: stringOf(data?.homepage),
    defaultBranch: stringOf(data?.default_branch),
  };
}

async function readCache(options = {}) {
  try {
    const raw = JSON.parse(await readFile(repoMetaPath(options), "utf8"));
    const repos = raw && typeof raw.repos === "object" && raw.repos !== null && !Array.isArray(raw.repos) ? raw.repos : {};
    return {
      version: raw && typeof raw.version === "number" ? raw.version : COMMUNITY_META_VERSION,
      repos,
      rateLimitedUntil: typeof raw?.rateLimitedUntil === "number" ? raw.rateLimitedUntil : 0,
    };
  } catch {
    return { version: COMMUNITY_META_VERSION, repos: {}, rateLimitedUntil: 0 };
  }
}

function dirnameOf(path) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

async function writeCache(cache, options = {}) {
  const path = repoMetaPath(options);
  await mkdir(dirnameOf(path), { recursive: true });
  // 唯一临时名 + rename：详情卡是逐张 fire-and-forget 调进来的，固定 `.staging` 会让
  // 两个并发写互相踩踏（交错 fd 写出撕坏的文件再被 rename 进正位）。
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

function rateLimitError(resetSeconds) {
  const minutes = Math.max(1, Math.ceil((Number(resetSeconds) * 1000 - Date.now()) / 60_000));
  return new Error(`GitHub 接口已限流，约 ${minutes} 分钟后恢复`);
}

/**
 * 批量读取仓库元信息。
 *
 * 入参：`{ repos: string[] | {repo}[] | string, refresh?: boolean }`
 * 返回：`{ repos: { "owner/repo": { ok, ...projectRepoMeta, cached?, stale?, error? } }, fetchedAt }`
 *
 * 单条失败不抛整体错误：UI 需要把「这一条查不到」与「整个接口挂了」分开显示。
 * 有旧缓存时网络失败回落到旧数据（`stale: true`），永不因为刷新失败把界面打空。
 */
export async function wbRepoMeta(payload = {}, options = {}) {
  const repos = normalizeRepoList(payload?.repos ?? payload?.repo);
  const now = Date.now();
  if (!repos.length) return { repos: {}, fetchedAt: now };
  const cache = await readCache(options);
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : fetch;
  const results = {};

  for (const repo of repos) {
    const key = repo.toLowerCase();
    const entry = cache.repos[key];
    const fresh = entry && entry.data && now - Number(entry.fetchedAt || 0) < COMMUNITY_META_TTL_MS;
    if (fresh && payload?.refresh !== true) {
      results[repo] = { ok: true, cached: true, ...entry.data };
      continue;
    }
    if (cache.rateLimitedUntil && now < cache.rateLimitedUntil) {
      results[repo] = entry?.data
        ? { ok: true, cached: true, stale: true, ...entry.data, error: "GitHub 接口已限流，显示的是缓存" }
        : { ok: false, error: "GitHub 接口已限流，稍后再试" };
      continue;
    }
    const headers = { "user-agent": USER_AGENT, accept: "application/vnd.github+json" };
    if (entry?.etag) headers["if-none-match"] = entry.etag;
    try {
      const response = await fetchImpl(`${GITHUB_API}${repo}`, {
        headers,
        signal: AbortSignal.timeout(12_000),
      });
      const remaining = response.headers?.get?.("x-ratelimit-remaining");
      if (response.status === 304 && entry?.data) {
        cache.repos[key] = { ...entry, fetchedAt: now };
        results[repo] = { ok: true, cached: true, ...entry.data };
        continue;
      }
      if (response.status === 403 && remaining === "0") {
        const reset = Number(response.headers?.get?.("x-ratelimit-reset") || 0);
        cache.rateLimitedUntil = reset ? reset * 1000 : now + 10 * 60_000;
        throw rateLimitError(reset);
      }
      if (response.status === 404) {
        results[repo] = { ok: false, error: "仓库不存在或已删除" };
        continue;
      }
      if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}`);
      const data = projectRepoMeta(repo, await response.json());
      cache.repos[key] = {
        fetchedAt: now,
        etag: response.headers?.get?.("etag") || "",
        data,
      };
      results[repo] = { ok: true, cached: false, ...data };
    } catch (error) {
      const message = errorText(error);
      results[repo] = entry?.data
        ? { ok: true, cached: true, stale: true, ...entry.data, error: message }
        : { ok: false, error: message };
    }
  }

  try {
    await writeCache(cache, options);
  } catch {
    // 缓存写失败不影响本次结果；下次只是多打一次网络。
  }
  return { repos: results, fetchedAt: now };
}
