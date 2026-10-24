// npm 下载量（lib/npm-downloads.js）的回归套件 —— 插件卡片底栏那枚「↓N」的唯一真源。
//
// 这个文件守的不是"能不能取到数"，而是**不许造数**与**别把公开接口打爆**这两条：
//   · 取不到（404 / 响应里没有数字）→ `missing: true` 且**没有 downloads 字段**，
//     绝不允许返回 0：0 在卡片上会被读成"没人下载"，那是伪造的负信号；
//   · 网络抖动 / 限流冷却 → 有旧值就继续显示旧值（stale），绝不把卡片上的数字打没；
//   · 缓存纪律（口径照 community-meta）→ 命中 7 天缓存不再联网；429 先退避重试一次，
//     仍失败才记 60 秒冷却（实测这是速率型限流，冷却 10 分钟会让整页一直空着）；
//   · 节流：并发 2 **且**每次请求起手间隔 ≥paceMs（并发数管不住速率，实测并发打 12 个
//     429 占一半以上，3 req/s 连发 15 个才全绿）。
//
// 隔离：mkdtemp 临时目录 + options.rootDir 注入，fetchImpl 全替身，paceMs:0 免等，
// 全程零真实网络、零真实 ~/.dsh。用法：node ./test/npm-downloads.mjs
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const {
  NPM_DOWNLOADS_VERSION,
  NPM_DOWNLOADS_TTL_MS,
  NPM_DOWNLOADS_MAX_PACKAGES,
  NPM_DOWNLOADS_COOLDOWN_MS,
  normalizePackageName,
  normalizePackageList,
  projectDownloads,
  npmDownloadsPath,
  wbNpmDownloads,
} = await import(new URL("../lib/npm-downloads.js", import.meta.url).href);

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const freshRoot = () => mkdtemp(join(tmpdir(), "dsh-armory-npm-"));
const statsBody = (pkg, downloads) => ({ downloads, start: "2026-09-01", end: "2026-09-30", package: pkg, days: 30 });
const FAST = { paceMs: 0 };   // 单测不吃 220ms 节流，只验逻辑；节流本身另有一节单独验

/** fetch 替身：记录 URL、在途峰值与起手时刻，按 url 尾段喂包好的响应。 */
function fakeFetch(byPkg, { latency = 5 } = {}) {
  const seen = [];
  const stamps = [];
  const state = { inflight: 0, peak: 0 };
  const impl = async (url) => {
    seen.push(url);
    stamps.push(Date.now());
    state.inflight += 1;
    if (state.inflight > state.peak) state.peak = state.inflight;
    try {
      await delay(latency);
      const pkg = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      const spec = byPkg[pkg] || { status: 404 };
      if (spec.throw) throw new Error(spec.throw);
      const body = typeof spec.body === "function" ? spec.body(pkg) : spec.body;
      return {
        status: spec.status,
        ok: spec.status >= 200 && spec.status < 300,
        headers: { get: (name) => (String(name).toLowerCase() === "retry-after" && spec.retryAfter != null ? String(spec.retryAfter) : null) },
        json: async () => body,
      };
    } finally {
      state.inflight -= 1;
    }
  };
  return { impl, seen, stamps, state };
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── 1. 包名合法性与入参归一：脏数据绝不发进外网 ────────────────────────────
ok("包名：unscoped / scoped / 首尾空格都规整",
  normalizePackageName("dsh-armory") === "dsh-armory"
  && normalizePackageName("@scope/pkg.name") === "@scope/pkg.name"
  && normalizePackageName("  foo  ") === "foo");
ok("包名：路径注入与畸形名一律拒绝（返回空串）",
  normalizePackageName("") === ""
  && normalizePackageName("../etc/passwd") === ""
  && normalizePackageName("foo/bar") === ""
  && normalizePackageName("@scope") === ""
  && normalizePackageName("@a/b/c") === "");
ok("归一：字符串 / 数组 / {npm|package} 都收且去重",
  JSON.stringify(normalizePackageList("foo")) === '["foo"]'
  && JSON.stringify(normalizePackageList([{ npm: "a" }, { package: "b" }, "a", "", "@x/y"])) === '["a","b","@x/y"]');
const capped = normalizePackageList(Array.from({ length: 40 }, (_, i) => `p${i}`));
ok(`封顶：一次最多 ${NPM_DOWNLOADS_MAX_PACKAGES} 个包`, capped.length === NPM_DOWNLOADS_MAX_PACKAGES, `得到=${capped.length}`);

// ── 2. 投影：只落卡片要用的窄字段 ──────────────────────────────────────────
const projected = projectDownloads("foo", statsBody("foo", 1234));
ok("投影：downloads / 区间 / period 齐全",
  projected.downloads === 1234 && projected.period === "last-month" && projected.package === "foo");
ok("投影：响应里没有数字 → null（不是 0）",
  projectDownloads("foo", { downloads: null }).downloads === null
  && projectDownloads("foo", {}).downloads === null
  && projectDownloads("foo", { downloads: "abc" }).downloads === null);

// ── 3. 冷启动 → 命中缓存不再联网 → refresh 才绕过 ──────────────────────────
{
  const root = await freshRoot();
  const foo = { foo: { status: 200, body: (pkg) => statsBody(pkg, 4200) } };
  const cold = fakeFetch(foo);
  const first = await wbNpmDownloads({ packages: ["foo"] }, { ...FAST, rootDir: root, fetchImpl: cold.impl });
  ok("冷启动：取到真数字且标记未缓存",
    first.packages.foo.ok === true && first.packages.foo.downloads === 4200 && first.packages.foo.cached === false,
    JSON.stringify(first.packages.foo));

  const scoped = fakeFetch({ "@scope/pkg": { status: 200, body: (pkg) => statsBody(pkg, 7) } });
  await wbNpmDownloads({ packages: ["@scope/pkg"] }, { ...FAST, rootDir: root, fetchImpl: scoped.impl });
  ok("URL 口径：scoped 名的斜杠转义成 %2F、前导 @ 保留，端点是 last-month",
    scoped.seen.length === 1 && scoped.seen[0] === "https://api.npmjs.org/downloads/point/last-month/@scope%2Fpkg",
    scoped.seen[0] || "");

  const quiet = fakeFetch({});
  const again = await wbNpmDownloads({ packages: ["foo"] }, { ...FAST, rootDir: root, fetchImpl: quiet.impl });
  ok("7 天缓存：二次调用直接吃缓存，一次外网都不发",
    quiet.seen.length === 0 && again.packages.foo.cached === true && again.packages.foo.downloads === 4200,
    `外网次数=${quiet.seen.length}`);

  const forced = fakeFetch(foo);
  const refreshed = await wbNpmDownloads({ packages: ["foo"], refresh: true }, { ...FAST, rootDir: root, fetchImpl: forced.impl });
  ok("refresh:true 明确绕过缓存（重新联网拿新值）",
    forced.seen.length === 1 && refreshed.packages.foo.cached === false && refreshed.packages.foo.downloads === 4200);

  const cacheFile = JSON.parse(await readFile(npmDownloadsPath({ rootDir: root }), "utf8"));
  const residue = (await readdir(root)).filter((name) => name.endsWith(".staging"));
  ok("落盘：version 正确、staging 无残留（原子写）",
    cacheFile.version === NPM_DOWNLOADS_VERSION && residue.length === 0, `残留=${residue.join(",")}`);
  await rm(root, { recursive: true, force: true });
}

// ── 4. 404 / 无数字：missing，且结果里根本没有 downloads ───────────────────
{
  const root = await freshRoot();
  const f = fakeFetch({ gone: { status: 404 }, quiet: { status: 200, body: { downloads: null } } });
  const out = await wbNpmDownloads({ packages: ["gone", "quiet"] }, { ...FAST, rootDir: root, fetchImpl: f.impl });
  ok("404 → missing:true", out.packages.gone.ok === false && out.packages.gone.missing === true);
  ok("响应无数字 → 同样 missing（当成「没有」，不当成 0）",
    out.packages.quiet.ok === false && out.packages.quiet.missing === true);
  ok("不许伪造：missing 的结果里根本没有 downloads 字段",
    out.packages.gone.downloads === undefined && out.packages.quiet.downloads === undefined);
  const f2 = fakeFetch({});
  const again = await wbNpmDownloads({ packages: ["gone"] }, { ...FAST, rootDir: root, fetchImpl: f2.impl });
  ok("查过没有 → 7 天内不重复打外网（粘住 missing）",
    f2.seen.length === 0 && again.packages.gone.missing === true && again.packages.gone.cached === true);
  await rm(root, { recursive: true, force: true });
}

// ── 5. 失败回落 stale：网络抖动不许把数字打没；失败的包不粘住 ───────────────
{
  const root = await freshRoot();
  await wbNpmDownloads({ packages: ["foo"] }, { ...FAST, rootDir: root, fetchImpl: fakeFetch({ foo: { status: 200, body: (pkg) => statsBody(pkg, 999) } }).impl });
  const broken = fakeFetch({ foo: { throw: "socket hang up" } });
  const out = await wbNpmDownloads({ packages: ["foo"], refresh: true }, { ...FAST, rootDir: root, fetchImpl: broken.impl });
  ok("有旧值 + 请求失败 → 继续给旧数字并标 stale",
    out.packages.foo.ok === true && out.packages.foo.stale === true && out.packages.foo.downloads === 999,
    JSON.stringify(out.packages.foo));
  const cold = fakeFetch({ bar: { throw: "socket hang up" } });
  const none = await wbNpmDownloads({ packages: ["bar"] }, { ...FAST, rootDir: root, fetchImpl: cold.impl });
  ok("没有旧值 + 请求失败 → ok:false 带错误，不编数字",
    none.packages.bar.ok === false && none.packages.bar.downloads === undefined && typeof none.packages.bar.error === "string");
  const retry = fakeFetch({ bar: { status: 200, body: (pkg) => statsBody(pkg, 12) } });
  const second = await wbNpmDownloads({ packages: ["bar"] }, { ...FAST, rootDir: root, fetchImpl: retry.impl });
  ok("失败不落缓存 → 下次调用会真的重试（限流是暂时的，不能一次失败就永久空白）",
    retry.seen.length === 1 && second.packages.bar.ok === true && second.packages.bar.downloads === 12);
  await rm(root, { recursive: true, force: true });
}

// ── 6. 429：先退避重试一次；仍失败才记 60 秒冷却 ───────────────────────────
{
  const root = await freshRoot();
  let hits = 0;
  const recovering = {
    impl: async (url) => {
      hits += 1;
      const body = statsBody("foo", 55);
      return hits === 1
        ? { status: 429, ok: false, headers: { get: () => "0" }, json: async () => ({}) }
        : { status: 200, ok: true, headers: { get: () => null }, json: async () => body };
    },
  };
  const out = await wbNpmDownloads({ packages: ["foo"] }, { ...FAST, rootDir: root, fetchImpl: recovering.impl });
  ok("429 后自动重试一次并救回数字", hits === 2 && out.packages.foo.ok === true && out.packages.foo.downloads === 55, `请求次数=${hits}`);

  // 一直 429：换一根**没有旧值**的缓存目录，才能验「这一条失败」而不是退成 stale 旧数字。
  const dryRoot = await freshRoot();
  const limited = fakeFetch({ foo: { status: 429, retryAfter: 0 } });
  const failed = await wbNpmDownloads({ packages: ["foo"] }, { ...FAST, rootDir: dryRoot, fetchImpl: limited.impl });
  ok("重试仍 429 → 本条失败（不是 0）且重试过",
    failed.packages.foo.ok === false && failed.packages.foo.downloads === undefined && limited.seen.length === 2,
    `ok=${failed.packages.foo.ok} 有数字=${failed.packages.foo.downloads !== undefined} 请求次数=${limited.seen.length}`);
  const cacheFile = JSON.parse(await readFile(npmDownloadsPath({ rootDir: dryRoot }), "utf8"));
  const slack = cacheFile.unavailableUntil - Date.now();
  ok(`冷却时长是 ${NPM_DOWNLOADS_COOLDOWN_MS / 1000} 秒量级（速率型限流，冷却太长整页一直空）`,
    slack > 0 && slack <= NPM_DOWNLOADS_COOLDOWN_MS + 2000, `剩余=${Math.round(slack / 1000)}s`);
  const quiet = fakeFetch({});
  const second = await wbNpmDownloads({ packages: ["foo"] }, { ...FAST, rootDir: dryRoot, fetchImpl: quiet.impl });
  ok("冷却期内不再联网，直接给冷却文案",
    quiet.seen.length === 0 && second.packages.foo.ok === false && /冷却/.test(second.packages.foo.error || ""),
    second.packages.foo.error || "");

  // 冷却 ≠ 空白：冷却只是「别再联网」，有旧值照样出数（缓存命中这条分支排在冷却判断之前）。
  const coolRoot = await freshRoot();
  const coolCache = {
    version: NPM_DOWNLOADS_VERSION,
    unavailableUntil: Date.now() + NPM_DOWNLOADS_COOLDOWN_MS,
    packages: { foo: { fetchedAt: Date.now() - 60_000, missing: false, data: { package: "foo", downloads: 777, start: "2026-09-01", end: "2026-09-30", period: "last-month" } } },
  };
  await writeFile(npmDownloadsPath({ rootDir: coolRoot }), JSON.stringify(coolCache), "utf8");
  const inCool = fakeFetch({ foo: { status: 200, body: (pkg) => statsBody(pkg, 1) } });
  const cooled = await wbNpmDownloads({ packages: ["foo"] }, { ...FAST, rootDir: coolRoot, fetchImpl: inCool.impl });
  ok("冷却期有旧值 → 出旧数字而不是空白，且一次网都不发",
    inCool.seen.length === 0 && cooled.packages.foo.ok === true && cooled.packages.foo.downloads === 777,
    JSON.stringify(cooled.packages.foo));
  await rm(dryRoot, { recursive: true, force: true });
  await rm(coolRoot, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}

// ── 7. 并发封顶 2 + 起手节流（别把公开接口打到限流）─────────────────────────
{
  const root = await freshRoot();
  const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`p${i}`, { status: 200, body: (pkg) => statsBody(pkg, 100 + Number(pkg.slice(1))) }]));
  const f = fakeFetch(many, { latency: 20 });
  const out = await wbNpmDownloads({ packages: Object.keys(many) }, { ...FAST, rootDir: root, fetchImpl: f.impl });
  ok("12 个包全部落结果", Object.keys(out.packages).length === 12 && Object.values(out.packages).every((row) => row.ok));
  ok("进程内并发封顶 2（>1 证明确实并发了）", f.state.peak > 1 && f.state.peak <= 2, `峰值在途=${f.state.peak}`);

  // 起手节流：断言用「总跨度 + 最小间隔」而不是逐对精确值 —— 本机 Date.now() 读数有
  // ~15ms 粒度（同一份实现两次跑出的间隔是 62~67ms），拿 60ms 卡边界必然偶发误红。
  const paced = fakeFetch(many, { latency: 5 });
  await wbNpmDownloads({ packages: Object.keys(many).slice(0, 5) }, { paceMs: 200, rootDir: await freshRoot(), fetchImpl: paced.impl });
  const gaps = paced.stamps.slice(1).map((t, i) => t - paced.stamps[i]);
  const span = paced.stamps[paced.stamps.length - 1] - paced.stamps[0];
  ok("paceMs 生效：5 个请求起手间隔被拉开（总跨度 ≥ 3× 节流值）",
    Math.min(...gaps) >= 100 && span >= 3 * 200 * 0.8, `最小间隔=${Math.min(...gaps)}ms 总跨度=${span}ms`);
  await rm(root, { recursive: true, force: true });
}

// ── 8. 反向自测：把实现改坏，上面的断言必须真的变红 ────────────────────────
{
  const root = await freshRoot();
  const source = await readFile(new URL("../lib/npm-downloads.js", import.meta.url), "utf8");

  // 行为级：取消「响应无数字 ⇒ missing」，卡片就会收到 ok:true + downloads:null，
  // 上层 `downloads > 0` 之外再无保护 —— 第 4 节那两条断言必须为此变红。
  const brokenPath = join(root, "broken-npm-downloads.mjs");
  await writeFile(brokenPath, source.replace("if (data.downloads === null) {", "if (false) {"));
  const broken = await import(pathToFileURL(brokenPath).href);
  const out = await broken.wbNpmDownloads({ packages: ["quiet"] }, { ...FAST, rootDir: join(root, "b1"), fetchImpl: fakeFetch({ quiet: { status: 200, body: { downloads: null } } }).impl });
  ok("反向：坏实现把「无数字」报成成功 → 第 4 节断言确实会失败",
    out.packages.quiet.ok === true && out.packages.quiet.missing !== true && out.packages.quiet.downloads === null,
    JSON.stringify(out.packages.quiet));

  const noCache = source.replace("if (fresh && payload?.refresh !== true) {", "if (false && fresh) {");
  ok("反向：取消缓存命中分支 → 「不再联网」断言的源码依据必须消失",
    source.includes("if (fresh && payload?.refresh !== true) {") && !noCache.includes("if (fresh && payload?.refresh !== true) {"));

  const noGate = source.replace("Math.min(NPM_DOWNLOADS_CONCURRENCY, pending.length)", "pending.length");
  ok("反向：拆掉并发闸门 → 封顶断言的源码依据必须消失",
    source.includes("Math.min(NPM_DOWNLOADS_CONCURRENCY, pending.length)") && !noGate.includes("Math.min(NPM_DOWNLOADS_CONCURRENCY, pending.length)"));

  // 反向（行为级）：把两处起手闸门拆掉，第 7 节那条节流断言必须真的量不出来 ——
  // 只 grep 源码证明不了闸门真的在管事，跑一遍拿跨度数据才算。
  const noPaceSource = source.replace(/\n *await pace\(\);(?=\n)/g, "\n");
  const brokenPacePath = join(root, "broken-pace.mjs");
  await writeFile(brokenPacePath, noPaceSource, "utf8");
  const brokenPace = await import(pathToFileURL(brokenPacePath).href);
  const paceRows = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`q${i}`, { status: 200, body: (pkg) => statsBody(pkg, 10 + Number(pkg.slice(1))) }]));
  const loose = fakeFetch(paceRows, { latency: 5 });
  await brokenPace.wbNpmDownloads({ packages: Object.keys(paceRows) }, { paceMs: 200, rootDir: join(root, "b2"), fetchImpl: loose.impl });
  const looseSpan = loose.stamps[loose.stamps.length - 1] - loose.stamps[0];
  ok("反向：坏实现里两处 await pace() 都拆得掉，且节流断言的数值依据随之消失",
    (source.match(/await pace\(\)/g) || []).length === 2
    && (noPaceSource.match(/await pace\(\)/g) || []).length === 0
    && looseSpan < 3 * 200 * 0.8,
    `跨度=${looseSpan}ms（阈值 ${3 * 200 * 0.8}ms）`);

  ok("反向：TTL 常量必须是 7 天（改成 1 分钟就会把外网打满）",
    NPM_DOWNLOADS_TTL_MS === 7 * 24 * 60 * 60 * 1000 && /7 \* 24 \* 60 \* 60 \* 1000/.test(source));
  await rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "NPM-DOWNLOADS PASS" : `${failures} CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
