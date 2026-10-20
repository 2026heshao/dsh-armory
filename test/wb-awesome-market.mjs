// awesome 市场数据层（lib/wb-awesome-market.js）的回归套件（T01）。
//
// 覆盖：slimEntries 过滤口径（verified∧npm 交集、broken/unverified 出局、npm 对象
// 形态提取）、映射字段防御（description 截断 / tags / stars / official / 畸形条目）、
// 原子写（staging 无残留）、catalog 三条主链（无缓存 200 全量 / 有缓存 304 复用 /
// 双源切换 / 全源失败 stale 回落）、updateCheck 五枚举（HEAD 条件探测 + 绝不落盘）、
// wbAwesomeDetail 命中与未命中。
//
// 隔离纪律：mkdtemp 临时目录 + options.rootDir 注入，绝不碰真实 ~/.dsh；联网走
// globalThis.fetch 替换，finally 必还原，零真实外网。
// 用法：node ./test/wb-awesome-market.mjs
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  wbAwesomeCatalog,
  wbAwesomeDetail,
  wbAwesomeUpdateCheck,
  wbAwesomeCachedInfo,
  slimEntries,
  AWESOME_MARKETPLACE_ID,
  SLIM_MAX_BYTES,
} = await import(new URL("../lib/wb-awesome-market.js", import.meta.url).href);

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

function freshRoot() {
  return mkdtemp(join(tmpdir(), "awesome-"));
}

/** 替换 globalThis.fetch 并返回还原函数（finally 必还原）。 */
function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => {
    globalThis.fetch = original;
  };
}

/** 200 全量响应替身：body = 源 JSON 文本，headers 带 ETag。 */
function jsonResponse(payload, etag = '"v1"') {
  const text = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === "etag" ? etag : null) },
    arrayBuffer: async () => Buffer.from(text, "utf8"),
    body: { cancel: () => {} },
  };
}

/** 条件 304 响应替身（必须携带 etag 请求才会被 fetchChain 认作命中）。 */
function notModifiedResponse() {
  return {
    ok: false,
    status: 304,
    headers: { get: () => null },
    arrayBuffer: async () => Buffer.alloc(0),
    body: { cancel: () => {} },
  };
}

/** 一条合法的源数据条目（覆盖字段可覆盖）。 */
function rawEntry(overrides = {}) {
  return {
    name: "demo-plugin",
    repo: "dshworks/demo-plugin",
    npm: "@demo/plugin",
    description: "A demo plugin",
    category: "productivity",
    official: true,
    added: "2026-01-01",
    lastVerified: "2026-10-01",
    verifiedAgainst: "dsh 1.10",
    status: "verified",
    stars: 42,
    tags: ["tools", "docs"],
    pushedAt: "2026-09-30",
    ...overrides,
  };
}

const SOURCE_URL = "https://cdn.jsdelivr.net/gh/dshworks/awesome-dsh-plugins@main/data/plugins.json";
const MIRROR_URL = "https://fastly.jsdelivr.net/gh/dshworks/awesome-dsh-plugins@main/data/plugins.json";

// ── 1. slimEntries 过滤口径 ─────────────────────────────────────────────────
{
  const out = slimEntries([
    rawEntry({ name: "keep-a", npm: "a", status: "verified" }), // verified ∧ npm → 保留
    rawEntry({ name: "drop-unverified", npm: "b", status: "unverified" }), // unverified 出局
    rawEntry({ name: "drop-broken", npm: "c", status: "broken" }), // broken 出局
    rawEntry({ name: "keep-obj", npm: { name: "scoped-pkg", version: "1.0" }, status: "verified" }), // npm 对象形态
    rawEntry({ name: "drop-empty-npm", npm: "", status: "verified" }), // npm 空串出局
    rawEntry({ name: "drop-null-npm", npm: null, status: "verified" }), // npm null 出局
    rawEntry({ name: "keep-whitespace-npm", npm: "  trimmed-pkg  ", status: "verified" }), // npm trim 后保留
  ]);
  const names = out.map((entry) => entry.name);
  ok("slimEntries 过滤：verified∧npm 保留", names.includes("keep-a"));
  ok("slimEntries 过滤：unverified/broken 出局", !names.includes("drop-unverified") && !names.includes("drop-broken"));
  ok("slimEntries 过滤：npm 对象 {name} 能提取", names.includes("keep-obj") && out.find((e) => e.name === "keep-obj").npm === "scoped-pkg");
  ok("slimEntries 过滤：npm 空串/null 出局", !names.includes("drop-empty-npm") && !names.includes("drop-null-npm"));
  ok("slimEntries 过滤：npm 空白串 trim 后保留", out.find((e) => e.name === "keep-whitespace-npm").npm === "trimmed-pkg");
  ok("slimEntries 保持源顺序输出", names[0] === "keep-a" && names[names.length - 1] === "keep-whitespace-npm");
}

// ── 2. slimEntries 映射与防御 ───────────────────────────────────────────────
{
  const out = slimEntries([
    rawEntry({ name: "long-desc", description: "x".repeat(300) }),
    rawEntry({ name: "no-tags", tags: "not-an-array" }),
    rawEntry({ name: "over-tags", tags: ["a", "b", "c", 42, null] }),
    rawEntry({ name: "bad-stars", stars: "42" }),
    rawEntry({ name: "neg-official", official: 0 }),
    { repo: "no-name-here", npm: "x", status: "verified" }, // 无 name → 丢弃
    rawEntry({ name: "no-category", category: "" }),
    42,
    null,
  ]);
  const byName = new Map(out.map((entry) => [entry.name, entry]));
  ok("slimEntries 映射：description >120 截断", byName.get("long-desc").description.length === 120);
  ok("slimEntries 映射：tags 非数组→[]、超 2 个截断", byName.get("no-tags").tags.length === 0 && JSON.stringify(byName.get("over-tags").tags) === JSON.stringify(["a", "b"]));
  ok("slimEntries 映射：stars 非数字→0", byName.get("bad-stars").stars === 0);
  ok("slimEntries 映射：official truthy→true / 0→false", byName.get("long-desc").official === true && byName.get("neg-official").official === false);
  ok("slimEntries 防御：无 name 的致命畸形条目丢弃", !byName.has(undefined) && out.every((entry) => typeof entry.name === "string" && entry.name));
  ok("slimEntries 防御：category 空 → 回落 plugin", byName.get("no-category").category === "plugin");
  ok("slimEntries 防御：status 恒为 verified", out.every((entry) => entry.status === "verified"));
  ok("slimEntries 防御：非数组输入返回 []", slimEntries(null).length === 0 && slimEntries("nope").length === 0);
}

// ── 3. catalog 无缓存 + mock 200 全量：网络加载 + 落盘 + counts ──────────────
{
  const root = await freshRoot();
  const restore = mockFetch(async (url) => {
    if (url !== SOURCE_URL) throw new Error("unexpected url " + url);
    return jsonResponse({
      updated: "2026-10-20",
      plugins: [
        rawEntry({ name: "cat-a", category: "productivity" }),
        rawEntry({ name: "cat-b", category: "productivity" }),
        rawEntry({ name: "cat-c", category: "dev" }),
        rawEntry({ name: "cat-d", status: "unverified" }), // 应被过滤
      ],
    }, '"tag-1"');
  });
  try {
    const result = await wbAwesomeCatalog({ rootDir: root });
    ok("catalog 无缓存 200：loadedFrom=network + ok", result.ok === true && result.loadedFrom === "network");
    ok("catalog 无缓存 200：marketplace 标记", result.marketplace === AWESOME_MARKETPLACE_ID && AWESOME_MARKETPLACE_ID === "awesome-dsh-plugins");
    ok("catalog 无缓存 200：counts 按瘦身结果统计", result.counts.total === 3 && result.counts.byCategory.productivity === 2 && result.counts.byCategory.dev === 1, JSON.stringify(result.counts));
    const slimOnDisk = JSON.parse(await readFile(join(root, "awesome-market", "slim.json"), "utf8"));
    ok("catalog 无缓存 200：slim.json 落盘可解析且无 unverified", Array.isArray(slimOnDisk) && slimOnDisk.length === 3 && slimOnDisk.every((e) => e.status === "verified"));
    const metaOnDisk = JSON.parse(await readFile(join(root, "awesome-market", "meta.json"), "utf8"));
    ok("catalog 无缓存 200：meta.json 记录 etag/updated/counts", metaOnDisk.etag === '"tag-1"' && metaOnDisk.updated === "2026-10-20" && metaOnDisk.counts.total === 3);
    ok("catalog 无缓存 200：updated 字段回传", result.updated === "2026-10-20");
    const entries = await readdir(join(root, "awesome-market"));
    ok("原子写：目录里没有 .staging 残留", !entries.some((name) => name.endsWith(".staging")), entries.join(","));
    const info = await wbAwesomeCachedInfo({ rootDir: root });
    ok("cachedInfo：有缓存时回传 etag/fetchedAt/updated", info.hasCache === true && info.etag === '"tag-1"' && info.fetchedAt > 0 && info.updated === "2026-10-20");
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

// ── 4. catalog 有缓存 + 304：复用磁盘，不重写 ────────────────────────────────
{
  const root = await freshRoot();
  let round = 0;
  let sawConditionalHeader = "";
  const restore = mockFetch(async (url, init) => {
    round += 1;
    if (round === 1) return jsonResponse({ updated: "2026-10-20", plugins: [rawEntry({ name: "cached-one" })] }, '"etag-keep"');
    sawConditionalHeader = init?.headers?.["if-none-match"] || "";
    if (url !== SOURCE_URL) throw new Error("unexpected url " + url);
    return notModifiedResponse(); // 第二轮：条件命中 304
  });
  try {
    await wbAwesomeCatalog({ rootDir: root });
    const slimPath = join(root, "awesome-market", "slim.json");
    const before = await readFile(slimPath, "utf8");
    const beforeStat = await stat(slimPath);
    const second = await wbAwesomeCatalog({ rootDir: root, refresh: true });
    ok("catalog 304：请求带 If-None-Match 条件头", sawConditionalHeader === '"etag-keep"', sawConditionalHeader);
    ok("catalog 304：loadedFrom=cache", second.ok === true && second.loadedFrom === "cache");
    const after = await readFile(slimPath, "utf8");
    const afterStat = await stat(slimPath);
    ok("catalog 304：slim.json 内容与 mtime 均未重写", after === before && afterStat.mtimeMs === beforeStat.mtimeMs);
    ok("catalog 304：响应仍带 plugins/marketplace/counts", Array.isArray(second.plugins) && second.plugins.length === 1 && second.marketplace === AWESOME_MARKETPLACE_ID && second.counts.total === 1);
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

// ── 5. 双源切换：首源抛错 → 备源成功 ─────────────────────────────────────────
{
  const root = await freshRoot();
  const restore = mockFetch(async (url) => {
    if (url === SOURCE_URL) throw new Error("simulated network failure");
    if (url !== MIRROR_URL) throw new Error("unexpected url " + url);
    return jsonResponse({ updated: "2026-10-21", plugins: [rawEntry({ name: "from-mirror" })] }, '"tag-mirror"');
  });
  try {
    const result = await wbAwesomeCatalog({ rootDir: root });
    ok("双源切换：首源失败备源成功 loadedFrom=network", result.ok === true && result.loadedFrom === "network" && result.plugins[0].name === "from-mirror");
    ok("双源切换：记备源响应的 ETag", (await wbAwesomeCachedInfo({ rootDir: root })).etag === '"tag-mirror"');
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

// ── 6. 全源失败：有缓存 → stale 回落磁盘；无缓存 → ok:false ──────────────────
{
  const root = await freshRoot();
  const restore = mockFetch(async () => {
    throw new Error("all sources down");
  });
  try {
    // 6a. 无缓存：ok:false + 错误信息。
    const cold = await wbAwesomeCatalog({ rootDir: root });
    ok("全源失败无缓存：ok:false", cold.ok === false && typeof cold.error === "string" && cold.error.length > 0);
    // 6b. 预置缓存（绕过网络直接落盘一份），再全源失败 → stale 回落。
    const entries = slimEntries([rawEntry({ name: "stale-one" })]);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "awesome-market"), { recursive: true });
    await writeFile(join(root, "awesome-market", "slim.json"), JSON.stringify(entries), "utf8");
    await writeFile(join(root, "awesome-market", "meta.json"), JSON.stringify({ etag: '"old"', fetchedAt: 1, updated: "2026-10-19", counts: { total: 1, byCategory: { productivity: 1 } } }), "utf8");
    // refresh: true 走同步强刷路径（默认路径现在是缓存优先，见 §8）。
    const warm = await wbAwesomeCatalog({ rootDir: root, refresh: true });
    ok("全源失败有缓存：ok:true + stale:true + loadedFrom=disk", warm.ok === true && warm.stale === true && warm.loadedFrom === "disk");
    ok("全源失败有缓存：回传缓存内容与 counts", warm.plugins.length === 1 && warm.plugins[0].name === "stale-one" && warm.counts.total === 1);
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

// ── 8. 缓存优先（stale-while-revalidate）：新鲜零网络 / 陈旧先秒回再后台刷新 ──
{
  const root = await freshRoot();
  let netHits = 0;
  const restore = mockFetch(async (url, init) => {
    netHits += 1;
    if (url !== SOURCE_URL) throw new Error("unexpected url " + url);
    if (init?.headers?.["if-none-match"]) return notModifiedResponse();
    return jsonResponse({ updated: "2026-10-20", plugins: [rawEntry({ name: "swr-live" })] }, '"tag-swr"');
  });
  try {
    // 8a. 冷启动：无缓存 → 联网，回传 fetchedAt。
    const cold = await wbAwesomeCatalog({ rootDir: root });
    ok("swr 冷启动：loadedFrom=network + fetchedAt 回传", cold.ok === true && cold.loadedFrom === "network" && cold.fetchedAt > 0);
    // 8b. 再取一次：缓存新鲜 → 直接返回，一个请求都不发。
    const hitsAfterCold = netHits;
    const warm = await wbAwesomeCatalog({ rootDir: root });
    ok("swr 新鲜缓存：零网络 + loadedFrom=cache + 内容一致", netHits === hitsAfterCold && warm.ok === true && warm.loadedFrom === "cache" && warm.plugins[0].name === "swr-live");
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}
// 8c. 陈旧缓存（fetchedAt 远古、内存层为空）：先秒回旧数据并标 refreshing，
//     后台按存量 ETag 再验证成功 → 下一次调用即拿新数据。
{
  const { mkdir } = await import("node:fs/promises");
  const root = await freshRoot();
  await mkdir(join(root, "awesome-market"), { recursive: true });
  await writeFile(join(root, "awesome-market", "slim.json"), JSON.stringify(slimEntries([rawEntry({ name: "swr-stale" })])), "utf8");
  await writeFile(join(root, "awesome-market", "meta.json"), JSON.stringify({ etag: '"tag-old"', fetchedAt: 1, updated: "2026-10-18", counts: { total: 1, byCategory: { productivity: 1 } } }), "utf8");
  let sawStoredEtag = "";
  const restore = mockFetch(async (url, init) => {
    if (url !== SOURCE_URL) throw new Error("unexpected url " + url);
    if (init?.headers?.["if-none-match"] !== '"tag-old"') throw new Error("后台再验证必须带上存量 ETag");
    sawStoredEtag = init.headers["if-none-match"];
    return jsonResponse({ updated: "2026-10-22", plugins: [rawEntry({ name: "swr-fresh" })] }, '"tag-new"');
  });
  try {
    const first = await wbAwesomeCatalog({ rootDir: root });
    ok("swr 陈旧缓存：立刻返回旧数据 + refreshing:true", first.ok === true && first.loadedFrom === "cache" && first.refreshing === true && first.plugins[0].name === "swr-stale");
    for (let i = 0; i < 100 && sawStoredEtag === ""; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    ok("swr 陈旧缓存：后台带存量 ETag 再验证", sawStoredEtag === '"tag-old"');
    let next = null;
    for (let i = 0; i < 100; i += 1) {
      next = await wbAwesomeCatalog({ rootDir: root });
      if (next.plugins?.[0]?.name === "swr-fresh") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    ok("swr 陈旧缓存：后台完成后下次即拿新数据", next.ok === true && next.plugins[0].name === "swr-fresh");
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

// ── 7. wbAwesomeUpdateCheck：五枚举 + 只探测不落盘 ───────────────────────────
{
  // 7a. 无缓存 → no-cache。
  {
    const root = await freshRoot();
    const restore = mockFetch(async () => {
      throw new Error("probe should not fire without cache");
    });
    try {
      const result = await wbAwesomeUpdateCheck({ rootDir: root });
      ok("updateCheck 无缓存：no-cache 且不联网", result.ok === true && result.hasUpdate === false && result.reason === "no-cache");
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }
  // 7b/7c/7d：有缓存 + HEAD 探测（304 / 200 新 ETag / 抛错）+ 全程无落盘。
  {
    const root = await freshRoot();
    let probeMethod = "";
    let probeConditional = "";
    let probeUrl = "";
    const restore = mockFetch(async (url, init) => {
      if (url !== SOURCE_URL) throw new Error("unexpected url " + url);
      // 目录加载用 200；探测轮（HEAD 或降级 GET）按场景分支。
      if (!init?.method || init.method === "GET" && !init?.headers?.["if-none-match"]) {
        return jsonResponse({ updated: "2026-10-20", plugins: [rawEntry({ name: "probe-base" })] }, '"local-etag"');
      }
      probeMethod = init.method;
      probeConditional = init.headers["if-none-match"] || "";
      probeUrl = url;
      if (probeScenario === 304) return notModifiedResponse();
      if (probeScenario === 200) return jsonResponse({}, '"new-etag"');
      throw new Error("simulated probe failure");
    });
    let probeScenario = 304;
    try {
      await wbAwesomeCatalog({ rootDir: root });
      const slimPath = join(root, "awesome-market", "slim.json");
      const before = await readFile(slimPath, "utf8");
      const beforeStat = await stat(slimPath);

      probeScenario = 304;
      const upToDate = await wbAwesomeUpdateCheck({ rootDir: root });
      ok("updateCheck 304：HEAD 条件探测（method + if-none-match）", probeMethod === "HEAD" && probeConditional === '"local-etag"' && probeUrl === SOURCE_URL);
      ok("updateCheck 304：up-to-date", upToDate.ok === true && upToDate.hasUpdate === false && upToDate.reason === "up-to-date");

      probeScenario = 200;
      const hasUpdate = await wbAwesomeUpdateCheck({ rootDir: root });
      ok("updateCheck 200 新 ETag：update-available", hasUpdate.ok === true && hasUpdate.hasUpdate === true && hasUpdate.reason === "update-available" && hasUpdate.remoteEtag === '"new-etag"');

      probeScenario = 500;
      const failed = await wbAwesomeUpdateCheck({ rootDir: root });
      ok("updateCheck 非 ok：probe-failed 且 ok:false", failed.ok === false && failed.hasUpdate === false && failed.reason === "probe-failed");

      probeScenario = "throw";
      const thrown = await wbAwesomeUpdateCheck({ rootDir: root });
      ok("updateCheck fetch 抛错：probe-failed", thrown.ok === false && thrown.reason === "probe-failed");

      const after = await readFile(slimPath, "utf8");
      const afterStat = await stat(slimPath);
      ok("updateCheck 全程：slim.json 内容/mtime 未被探测改写", after === before && afterStat.mtimeMs === beforeStat.mtimeMs);
      ok("updateCheck 全程：目录无 .staging 残留", !(await readdir(join(root, "awesome-market"))).some((name) => name.endsWith(".staging")));
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }
}

// ── 8. wbAwesomeDetail：按名命中 / 未命中 null ───────────────────────────────
{
  const root = await freshRoot();
  const restore = mockFetch(async (url) => {
    if (url !== SOURCE_URL) throw new Error("unexpected url " + url);
    return jsonResponse({ updated: "2026-10-20", plugins: [rawEntry({ name: "detail-hit", npm: "@demo/hit" })] }, '"tag-d"');
  });
  try {
    await wbAwesomeCatalog({ rootDir: root });
    const hit = await wbAwesomeDetail("detail-hit", { rootDir: root });
    ok("detail：按名命中返回瘦身影射", hit !== null && hit.npm === "@demo/hit" && hit.status === "verified");
    const miss = await wbAwesomeDetail("no-such-plugin", { rootDir: root });
    ok("detail：不存在的名字返回 null", miss === null);
    ok("detail：空名字/非字符串返回 null", (await wbAwesomeDetail("", { rootDir: root })) === null && (await wbAwesomeDetail(42, { rootDir: root })) === null);
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

// ── 9. slim.json 体积验收：合成满载目录 < SLIM_MAX_BYTES ─────────────────────
{
  // 模拟真实量级（约 6 千条 verified∧npm 条目，字段长度贴近真实目录分布，
  // 全量瘦身后约 1.5-2MB），断言瘦身 JSON 文本字节数 < 3MB 上限常量。
  const bigCatalog = [];
  for (let i = 0; i < 6000; i += 1) {
    bigCatalog.push(rawEntry({
      name: `community-plugin-${i}`,
      repo: `dshworks/community-plugin-${i}`,
      npm: `@community/plugin-${i}`,
      description: "A realistic community plugin description kept at the directory's typical length limit.",
      tags: ["tools", "docs"],
    }));
  }
  const slim = slimEntries(bigCatalog);
  const bytes = Buffer.byteLength(JSON.stringify(slim), "utf8");
  ok("体积验收：6000 条满载瘦身产物 < 3MB 上限", bytes < SLIM_MAX_BYTES && SLIM_MAX_BYTES === 3 * 1024 * 1024, `${bytes} bytes`);
}

console.log(`\n${failures === 0 ? "WB-AWESOME-MARKET PASS" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
