// 社区元信息（lib/community-meta.js）的回归套件（活人感 T01）。
//
// 覆盖：仓库写法解析口径、入参归一（对象/去重/最多 8 条）、GitHub 响应窄投影、
// 6 小时缓存命中不再联网、refresh + If-None-Match 的 304 复用、404 文案、
// 网络失败的 stale 回落、403 限流跨调用生效、原子写无 .staging 残留。
//
// 隔离纪律：mkdtemp 临时目录 + options.rootDir 注入，fetchImpl 全替身，零网络。
// 用法：node ./test/community-meta.mjs
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  COMMUNITY_META_VERSION,
  COMMUNITY_META_MAX_REPOS,
  normalizeRepoList,
  parseGithubRepo,
  projectRepoMeta,
  repoMetaPath,
  wbRepoMeta,
} = await import(new URL("../lib/community-meta.js", import.meta.url).href);

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

function freshRoot() {
  return mkdtemp(join(tmpdir(), "dsh-armory-meta-"));
}

function headers(map = {}) {
  return { get: (name) => map[String(name).toLowerCase()] ?? null };
}

function githubFixture(repo, overrides = {}) {
  const [owner, name] = String(repo).split("/");
  return {
    full_name: `${owner}/${name}`,
    owner: {
      login: owner,
      avatar_url: `https://avatars.githubusercontent.com/u/1?v=4`,
      html_url: `https://github.com/${owner}`,
    },
    html_url: `https://github.com/${owner}/${name}`,
    description: "一个真实的项目",
    stargazers_count: 1234,
    forks_count: 56,
    open_issues_count: 7,
    subscribers_count: 89,
    pushed_at: "2026-10-20T08:00:00Z",
    updated_at: "2026-10-21T08:00:00Z",
    archived: false,
    disabled: false,
    license: { spdx_id: "MIT" },
    language: "TypeScript",
    homepage: `https://example.com/${name}`,
    default_branch: "main",
    ...overrides,
  };
}

function jsonResponse(data, { status = 200, etag = "etag-1", extraHeaders = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: headers({ etag, ...extraHeaders }),
    json: async () => data,
  };
}

// ── 1. parseGithubRepo 口径 ─────────────────────────────────────────────────
{
  const cases = [
    ["owner/repo", "owner/repo"],
    ["  owner/repo  ", "owner/repo"],
    ["https://github.com/foo/bar", "foo/bar"],
    ["http://www.github.com/foo/bar", "foo/bar"],
    ["https://github.com/foo/bar.git", "foo/bar"],
    ["https://github.com/foo/bar/tree/main", "foo/bar"],
    ["https://github.com/foo/bar#readme", "foo/bar"],
    ["https://github.com/foo/bar?tab=readme", "foo/bar"],
    ["git+https://github.com/foo/bar.git", "foo/bar"],
    ["git@github.com:foo/bar.git", "foo/bar"],
    ["foo/bar.git", "foo/bar"],
    ["https://gitlab.com/foo/bar", ""],
    ["https://github.com/only-owner", ""],
    ["", ""],
    [null, ""],
  ];
  for (const [input, expected] of cases) {
    const got = parseGithubRepo(input);
    ok(`parseGithubRepo(${JSON.stringify(input)}) → ${JSON.stringify(expected)}`, got === expected, got !== expected ? `实际 ${JSON.stringify(got)}` : "");
  }
}

// ── 2. normalizeRepoList：字符串/对象/去重/上限 ────────────────────────────
{
  ok("normalize：字符串入参", JSON.stringify(normalizeRepoList("a/b")) === JSON.stringify(["a/b"]));
  ok("normalize：对象与无效行混入", JSON.stringify(normalizeRepoList([
    { repo: "https://github.com/A/B" },
    { repository: "git@github.com:c/d.git" },
    { repo: "not a repo" },
    null,
    "  ",
  ])) === JSON.stringify(["A/B", "c/d"]));
  ok("normalize：大小写去重保留首个写法", JSON.stringify(normalizeRepoList(["A/B", "a/b", "a/b"])) === JSON.stringify(["A/B"]));
  const many = Array.from({ length: 12 }, (_, i) => `owner/repo-${i}`);
  const capped = normalizeRepoList(many);
  ok(`normalize：最多 ${COMMUNITY_META_MAX_REPOS} 条`, capped.length === COMMUNITY_META_MAX_REPOS, String(capped.length));
  ok("normalize：null 入参 → 空数组", normalizeRepoList(null).length === 0);
}

// ── 3. projectRepoMeta：原始响应 → 窄投影 ──────────────────────────────────
{
  const projected = projectRepoMeta("foo/bar", githubFixture("foo/bar"));
  ok("project：repo/owner/url 三个身份字段", projected.repo === "foo/bar" && projected.owner === "foo" && projected.htmlUrl === "https://github.com/foo/bar");
  ok("project：计数与活跃信号", projected.stars === 1234 && projected.forks === 56 && projected.openIssues === 7
    && projected.pushedAt === "2026-10-20T08:00:00Z" && projected.archived === false);
  ok("project：license 取 spdx_id、language/homepage/defaultBranch", projected.license === "MIT"
    && projected.language === "TypeScript" && projected.homepage === "https://example.com/bar" && projected.defaultBranch === "main");
  ok("project：ownerAvatar 回落 GitHub 头像地址", projectRepoMeta("x/y", {}).ownerAvatar === "https://github.com/x.png?size=64");
  ok("project：缺失字段防御（计数 0 / 布尔 false）", projectRepoMeta("x/y", {}).stars === 0 && projectRepoMeta("x/y", {}).archived === false);
}

// ── 4. 首次联网 + 6 小时缓存：第二次不再请求 ───────────────────────────────
{
  const root = await freshRoot();
  let calls = 0;
  const fetchOnce = async (url, init) => {
    calls += 1;
    ok("fetch：URL 指向 api.github.com/repos/foo/bar", url === "https://api.github.com/repos/foo/bar", url);
    ok("fetch：带 User-Agent 与 GitHub accept 头", init.headers["user-agent"].includes("dsh-armory") && init.headers.accept.includes("github"));
    return jsonResponse(githubFixture("foo/bar"));
  };
  const first = await wbRepoMeta({ repos: ["foo/bar"] }, { rootDir: root, fetchImpl: fetchOnce });
  ok("首次请求：ok=true、cached=false", first.repos["foo/bar"]?.ok === true && first.repos["foo/bar"]?.cached === false);
  ok("首次请求：星标/issue 投影进结果", first.repos["foo/bar"]?.stars === 1234 && first.repos["foo/bar"]?.openIssues === 7);
  ok("首次请求：fetch 只打一次", calls === 1, String(calls));

  const second = await wbRepoMeta({ repos: ["foo/bar"] }, {
    rootDir: root,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("缓存命中的请求不应到达网络");
    },
  });
  ok("缓存命中：结果仍 ok 且 cached=true", second.repos["foo/bar"]?.ok === true && second.repos["foo/bar"]?.cached === true);
  ok("缓存命中：没有再打网络", calls === 1, String(calls));

  const onDisk = JSON.parse(await readFile(repoMetaPath({ rootDir: root }), "utf8"));
  const entries = await readdir(root);
  ok("缓存落盘：version 与条目字段", onDisk.version === COMMUNITY_META_VERSION
    && onDisk.repos["foo/bar"]?.data?.stars === 1234 && onDisk.repos["foo/bar"]?.etag === "etag-1");
  ok("原子写：目录里没有 .staging 残留", !entries.some((name) => name.endsWith(".staging")), entries.join(","));
  await rm(root, { recursive: true, force: true });
}

// ── 5. refresh + If-None-Match：304 复用缓存、刷新 fetchedAt ────────────────
{
  const root = await freshRoot();
  await wbRepoMeta({ repos: ["foo/bar"] }, { rootDir: root, fetchImpl: async () => jsonResponse(githubFixture("foo/bar")) });
  const before = JSON.parse(await readFile(repoMetaPath({ rootDir: root }), "utf8")).repos["foo/bar"].fetchedAt;

  let sentEtag = "";
  const refreshed = await wbRepoMeta({ repos: ["foo/bar"], refresh: true }, {
    rootDir: root,
    fetchImpl: async (url, init) => {
      sentEtag = init.headers["if-none-match"] || "";
      return jsonResponse(null, { status: 304, etag: "etag-1" });
    },
  });
  ok("refresh：带着上次的 ETag 发 If-None-Match", sentEtag === "etag-1", sentEtag);
  ok("304：结果复用旧数据且标记 cached", refreshed.repos["foo/bar"]?.ok === true
    && refreshed.repos["foo/bar"]?.cached === true && refreshed.repos["foo/bar"]?.stars === 1234);

  const after = JSON.parse(await readFile(repoMetaPath({ rootDir: root }), "utf8")).repos["foo/bar"].fetchedAt;
  ok("304：缓存 fetchedAt 被刷新", after >= before, `${after} vs ${before}`);
  await rm(root, { recursive: true, force: true });
}

// ── 6. 404 / 无缓存网络失败：单条失败不炸整体 ──────────────────────────────
{
  const root = await freshRoot();
  const result = await wbRepoMeta({ repos: ["ghost/repo", "foo/bar"] }, {
    rootDir: root,
    fetchImpl: async (url) => {
      if (url.endsWith("/ghost/repo")) return jsonResponse(null, { status: 404 });
      return jsonResponse(githubFixture("foo/bar"));
    },
  });
  ok("404：该条 ok=false 且文案明确", result.repos["ghost/repo"]?.ok === false && result.repos["ghost/repo"]?.error.includes("仓库不存在"));
  ok("单条 404：不影响其它仓库", result.repos["foo/bar"]?.ok === true && result.repos["foo/bar"]?.stars === 1234);
  await rm(root, { recursive: true, force: true });

  const root2 = await freshRoot();
  const failed = await wbRepoMeta({ repos: ["foo/bar"] }, {
    rootDir: root2,
    fetchImpl: async () => {
      throw new Error("network down");
    },
  });
  ok("无缓存网络失败：ok=false 且带错误", failed.repos["foo/bar"]?.ok === false && failed.repos["foo/bar"]?.error.includes("network down"));
  await rm(root2, { recursive: true, force: true });
}

// ── 7. 有旧缓存时网络失败：stale 回落，永不把界面打空 ──────────────────────
{
  const root = await freshRoot();
  await wbRepoMeta({ repos: ["foo/bar"] }, { rootDir: root, fetchImpl: async () => jsonResponse(githubFixture("foo/bar")) });
  // 把缓存时间改到 6 小时前之外，逼出「过期后重新联网」的分支。
  const path = repoMetaPath({ rootDir: root });
  const cache = JSON.parse(await readFile(path, "utf8"));
  cache.repos["foo/bar"].fetchedAt = Date.now() - 7 * 60 * 60 * 1000;
  await writeFile(path, JSON.stringify(cache));

  const stale = await wbRepoMeta({ repos: ["foo/bar"] }, {
    rootDir: root,
    fetchImpl: async () => {
      throw new Error("timeout");
    },
  });
  ok("stale：保留旧数据并标记 stale", stale.repos["foo/bar"]?.ok === true
    && stale.repos["foo/bar"]?.stale === true && stale.repos["foo/bar"]?.stars === 1234);
  ok("stale：同时告知本次失败原因", String(stale.repos["foo/bar"]?.error).includes("timeout"));
  await rm(root, { recursive: true, force: true });
}

// ── 8. 403 限流：记录恢复时间，后续调用不再打网络 ──────────────────────────
{
  const root = await freshRoot();
  const resetAt = Math.floor(Date.now() / 1000) + 600;
  let calls = 0;
  const limited = await wbRepoMeta({ repos: ["foo/bar"] }, {
    rootDir: root,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(null, {
        status: 403,
        extraHeaders: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) },
      });
    },
  });
  ok("403：该条 ok=false 且提示限流恢复时间", limited.repos["foo/bar"]?.ok === false
    && limited.repos["foo/bar"]?.error.includes("限流") && limited.repos["foo/bar"]?.error.includes("分钟"));

  const cache = JSON.parse(await readFile(repoMetaPath({ rootDir: root }), "utf8"));
  ok("403：rateLimitedUntil 落盘", cache.rateLimitedUntil === resetAt * 1000, String(cache.rateLimitedUntil));

  const later = await wbRepoMeta({ repos: ["other/repo"] }, {
    rootDir: root,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("限流期间不应联网");
    },
  });
  ok("限流期内：直接返回错误、不联网", later.repos["other/repo"]?.ok === false && calls === 1, String(calls));
  ok("限流期内：错误提示稍后再试", later.repos["other/repo"]?.error.includes("限流"));
  await rm(root, { recursive: true, force: true });
}

// ── 9. 批量上限：12 条入参只请求 8 个仓库 ──────────────────────────────────
{
  const root = await freshRoot();
  let calls = 0;
  const repos = Array.from({ length: 12 }, (_, i) => `owner/repo-${i}`);
  const result = await wbRepoMeta({ repos }, {
    rootDir: root,
    fetchImpl: async (url) => {
      calls += 1;
      return jsonResponse(githubFixture(url.split("/repos/")[1]));
    },
  });
  ok("批量：fetch 次数等于上限 8", calls === COMMUNITY_META_MAX_REPOS, String(calls));
  ok("批量：结果只含前 8 条", Object.keys(result.repos).length === COMMUNITY_META_MAX_REPOS, String(Object.keys(result.repos).length));
  ok("批量：第 9 条之后完全没请求", !result.repos["owner/repo-8"]);
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "COMMUNITY-META PASS" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
