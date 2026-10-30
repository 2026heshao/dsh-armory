// test/perf-market-load.mjs
//
// 护栏对象：docs/perf-market-load.md 那批「市场加载性能」改动（P0-1 … P2-3）。
// 这批改动的共同点是**变快了但功能不变**——没有新按钮、没有新 Remote 方法，测试套件里
// 原有的功能用例（市场安装、详情、README）当然是绿的，可它们**一条也发现不了**性能回退：
// 谁把缓存删掉、把 200ms 防抖抹成直发、把快照当成永久有效，功能断言照样全过。
// 所以本套件按三层钉：
//   ① 行为层（vm 把源码原文抽出来真跑）：
//      · P2-3 hover 预取：200ms 防抖、连扫 5 张卡只发 1 条、离场取消、单条覆盖、
//        60 秒 TTL、开关关闭时一次都不发；
//      · P1-5 技能 SWR：命中/过期/30 条淘汰/关闭开关后永不命中；
//      · P1-4 连接器快照：24 小时过期、1.5MB 单条上限、4.5MB 与 awesome 快照的合计预算、
//        关闭开关后不读不写；
//      · P1-6 连接器计数缓存：10 分钟内只扫一次、失败**不**负缓存、过期后重扫；
//      · P2-1 工具裁缝账本缓存：days 收敛到 [1,365]、命中不扫、并发同 days 只扫一次、
//        refresh:true 旁路、TTL 过期重扫、扫描失败不缓存失败结果。
//   ② 接线层（源码针）：懒加载 import 形态、连接器首屏门控、快照懒读与签名比对、
//      空闲帧写盘、徽章 15s 轮询 + 空闲首拉、三类卡片挂载点、en-US 字典条目。
//   ③ 反向自测：每个行为节都把「改回旧写法」的变体注回同一份切片，断言它会红——
//      证明测试拦的是那行守卫，不是恰好写空的断言。
//
// 零网络、零写盘、不碰真实 ~/.dsh；只有 node: 内置模块。
// 用法：node ./test/perf-market-load.mjs

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "lib");

const [clientSrc, indexSrc, marketSrc] = await Promise.all([
  readFile(join(LIB, "client.js"), "utf8"),
  readFile(join(LIB, "index.js"), "utf8"),
  readFile(join(LIB, "wb-market.js"), "utf8"),
]);

let failures = 0;
let checks = 0;
const ok = (name, condition, extra = "") => {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};
const section = (title) => console.log(`\n── ${title} ─────────────────────────────────────────────`);

const has = (src, needle) => src.includes(needle);

/** 按起止标记抽一段源码原文；标记缺失直接失败，避免「测了个空」。 */
function slice(source, label, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) { ok(`切片定位：${label}`, false, `缺 start=${startMarker}`); return ""; }
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end <= start) { ok(`切片定位：${label}`, false, `缺 end=${endMarker}`); return ""; }
  return source.slice(start, end);
}

const makeTimers = () => {
  const pending = new Map();
  let nextId = 1;
  const setTimeoutFn = (fn, ms) => { const id = nextId++; pending.set(id, { fn, ms }); return id; };
  const clearTimeoutFn = (id) => { pending.delete(id); };
  const flush = () => { const list = [...pending.values()]; pending.clear(); list.forEach((t) => t.fn()); };
  return { pending, setTimeoutFn, clearTimeoutFn, flush };
};

// ═══════════════════════════════════════════════════════════════════════════
// 0. 源码定位（关键标记缺失即整体失败）
// ═══════════════════════════════════════════════════════════════════════════
section("0. 源码定位");
const MARKS = {
  lazyMarket: 'marketModule ??= import("./wb-market.js")',
  lazyExpert: 'expertModule ??= import("./expert-market.js")',
  tailorCache: "const TAILOR_CACHE_TTL = 5 * 60 * 1000;",
  countCache: "const COUNT_CACHE_TTL = 10 * 60 * 1000;",
  snapshot: "const CONNECTOR_SNAPSHOT_KEY = KEY_PREFIX + '.connectorCatalog.v1';",
  skillSwr: "const SKILL_SWR_TTL_MS = 60 * 1000;",
  hover: "const HOVER_PREFETCH_DELAY_MS = 200;",
  perfMark: "if (PERF_ON) perfMark('module', 'materialize'",
};
const missing = Object.entries(MARKS)
  .filter(([, needle]) => !has(clientSrc, needle) && !has(indexSrc, needle) && !has(marketSrc, needle))
  .map(([key]) => key);
ok("全部性能机制在 lib/ 里仍能定位", missing.length === 0, missing.length ? `缺失=${missing.join(",")}` : "");

// 静态 import 必须消失（否则懒加载只是摆设）
ok("index.js 不再静态 import wb-market.js",
  !/import\s+[^;]*from\s+["']\.\/wb-market\.js["']/.test(indexSrc));
ok("index.js 不再静态 import expert-market.js",
  !/import\s+[^;]*from\s+["']\.\/expert-market\.js["']/.test(indexSrc));

// ═══════════════════════════════════════════════════════════════════════════
// 1. P2-3 hover 预取：防抖 / 单条 / 取消 / TTL / 开关
// ═══════════════════════════════════════════════════════════════════════════
section("1. P2-3 hover 预取");
const HOVER_SRC = slice(clientSrc, "hover", "const HOVER_PREFETCH_DELAY_MS = 200;", "const WorkBuddyMarket = ({ call, pluginManager }) => {");

function hoverSandbox(src = HOVER_SRC) {
  const timers = makeTimers();
  const perf = { hoverPrefetch: true };
  const ctx = vm.createContext({ MARKET_PERF: perf, setTimeout: timers.setTimeoutFn, clearTimeout: timers.clearTimeoutFn, Date });
  vm.runInContext(src, ctx, { filename: "client.hover-slice.js" });
  const api = vm.runInContext(
    "({ scheduleHoverPrefetch, cancelHoverPrefetch, readDetailMemo, writeDetailMemo, hoverMemo, HOVER_PREFETCH_DELAY_MS, DETAIL_MEMO_TTL_MS })",
    ctx,
  );
  return { ...api, ...timers, perf };
}

if (HOVER_SRC) {
  {
    const s = hoverSandbox();
    ok("防抖窗口是 200ms（文档 P2-3 口径）", s.HOVER_PREFETCH_DELAY_MS === 200, `delay=${s.HOVER_PREFETCH_DELAY_MS}`);

    let fired = 0;
    s.scheduleHoverPrefetch(() => { fired += 1; });
    ok("进入卡片后不立即请求", fired === 0 && s.pending.size === 1);
    s.flush();
    ok("停住 200ms 后才请求一次", fired === 1);

    // 连扫 5 张卡：只有最后一张该发；旧写法（直发）会发 5 次。
    fired = 0;
    for (let i = 0; i < 5; i += 1) s.scheduleHoverPrefetch(() => { fired += 1; });
    s.flush();
    ok("连续扫过 5 张卡只发 1 条（单条覆盖）", fired === 1, `fired=${fired}`);
    // 反向自测：把 setTimeout 去掉（进入即发），同一组调用必须变成 5 条。
    const naiveStart = HOVER_SRC.indexOf("hoverPrefetchTimer = setTimeout(");
    const naiveEnd = HOVER_SRC.indexOf("}, HOVER_PREFETCH_DELAY_MS);", naiveStart);
    const naiveSrc = naiveStart >= 0 && naiveEnd > naiveStart
      ? HOVER_SRC.slice(0, naiveStart) + "try { run(); } catch { /* 旧写法：进入即发 */ }" + HOVER_SRC.slice(naiveEnd + "}, HOVER_PREFETCH_DELAY_MS);".length)
      : "";
    const naiveSandbox = naiveSrc ? hoverSandbox(naiveSrc) : null;
    let naiveFired = 0;
    if (naiveSandbox) for (let i = 0; i < 5; i += 1) naiveSandbox.scheduleHoverPrefetch(() => { naiveFired += 1; });
    ok("反向自测：去掉防抖（进入即发）后同一组调用会发 5 条", naiveFired === 5, `fired=${naiveFired}`);

    // 离场取消：进入后立刻离开，flush 后不应有任何请求。
    fired = 0;
    s.scheduleHoverPrefetch(() => { fired += 1; });
    s.cancelHoverPrefetch();
    s.flush();
    ok("onMouseLeave 取消挂起请求", fired === 0 && s.pending.size === 0);

    // 单条缓存 + TTL
    s.writeDetailMemo(s.hoverMemo.skillDetail, "owner/slug", { ok: true, name: "x" });
    ok("写入后同 key 命中", s.readDetailMemo(s.hoverMemo.skillDetail, "owner/slug")?.name === "x");
    ok("不同 key 不命中", s.readDetailMemo(s.hoverMemo.skillDetail, "owner/other") === null);
    s.hoverMemo.skillDetail.at -= s.DETAIL_MEMO_TTL_MS + 1000;
    ok("超过 60 秒 TTL 不命中", s.readDetailMemo(s.hoverMemo.skillDetail, "owner/slug") === null);
    s.writeDetailMemo(s.hoverMemo.readme, "a|b|", { ok: true });
    s.writeDetailMemo(s.hoverMemo.readme, "c|d|", { ok: true });
    ok("单条缓存：新条目覆盖旧条目", s.hoverMemo.readme.key === "c|d|" && s.hoverMemo.readme.value !== null);

    // 开关关闭：不发、不读、不写
    s.perf.hoverPrefetch = false;
    fired = 0;
    s.scheduleHoverPrefetch(() => { fired += 1; });
    s.flush();
    ok("开关关闭后不再预取", fired === 0 && s.pending.size === 0);
    s.writeDetailMemo(s.hoverMemo.skillDetail, "k", { ok: true });
    ok("开关关闭后不写缓存", s.hoverMemo.skillDetail.key !== "k");
    ok("开关关闭后不读缓存", s.readDetailMemo(s.hoverMemo.skillDetail, "k") === null);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. P1-5 技能列表 SWR
// ═══════════════════════════════════════════════════════════════════════════
section("2. P1-5 技能列表 SWR");
const SKILL_SRC = slice(clientSrc, "skill-swr", "const SKILL_SWR_TTL_MS = 60 * 1000;", "const WorkBuddyMarket = ({ call, pluginManager }) => {");

function skillSandbox(src = SKILL_SRC) {
  const perf = { skillSwr: true };
  const ctx = vm.createContext({ MARKET_PERF: perf, Date });
  vm.runInContext(src, ctx, { filename: "client.skill-swr-slice.js" });
  const api = vm.runInContext("({ readSkillCache, writeSkillCache, skillListCache, SKILL_SWR_TTL_MS, SKILL_SWR_MAX_ENTRIES })", ctx);
  return { ...api, perf };
}

if (SKILL_SRC) {
  const s = skillSandbox();
  ok("SWR 窗口 60 秒、条数封顶 30", s.SKILL_SWR_TTL_MS === 60000 && s.SKILL_SWR_MAX_ENTRIES === 30);
  s.writeSkillCache("1|installs|", { skills: [{ slug: "a" }], total: 1 });
  const hit = s.readSkillCache("1|installs|");
  ok("同参查询命中缓存", hit && hit.skills.length === 1 && hit.total === 1);
  ok("不同页/排序/关键词互不串味", s.readSkillCache("2|installs|") === null && s.readSkillCache("1|stars|") === null);
  hit.at -= s.SKILL_SWR_TTL_MS + 1;
  ok("过期后不再命中（且条目被清掉）", s.readSkillCache("1|installs|") === null && s.skillListCache.size === 0);

  for (let i = 0; i < 31; i += 1) s.writeSkillCache(`k${i}`, { skills: [], total: 0 });
  ok("超过 30 条按插入序淘汰最旧", s.skillListCache.size === 30 && s.readSkillCache("k0") === null && s.readSkillCache("k30") !== null,
    `size=${s.skillListCache.size}`);

  // 反向自测：抽掉 TTL 判定，刚过期的那条必须又能读回来（证明过期断言不是恒真）。
  const off = skillSandbox(SKILL_SRC.replace(
    "if (Date.now() - hit.at > SKILL_SWR_TTL_MS) { skillListCache.delete(key); return null; }",
    "",
  ));
  off.writeSkillCache("k", { skills: [], total: 0 });
  const revived = off.readSkillCache("k");
  if (revived) revived.at -= off.SKILL_SWR_TTL_MS + 1;
  ok("反向自测：去掉 TTL 判定后过期条目仍会命中", off.readSkillCache("k") !== null);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. P1-4 连接器目录客户端快照
// ═══════════════════════════════════════════════════════════════════════════
section("3. P1-4 连接器目录快照");
const SNAPSHOT_SRC = slice(clientSrc, "connector-snapshot", "const CONNECTOR_SNAPSHOT_KEY", "function readAwesomeProbeAt()");
const HOUR = 60 * 60 * 1000;

function snapshotSandbox(src = SNAPSHOT_SRC) {
  const store = new Map();
  const perf = { connectorSnapshot: true };
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  const ctx = vm.createContext({
    MARKET_PERF: perf,
    KEY_PREFIX: "dsh-armory",
    AWESOME_SNAPSHOT_KEY: "dsh-armory.awesomeCatalog.v1",
    localStorage,
    Date,
  });
  vm.runInContext(src, ctx, { filename: "client.snapshot-slice.js" });
  const api = vm.runInContext(
    "({ readConnectorSnapshot, writeConnectorSnapshot, CONNECTOR_SNAPSHOT_KEY, CONNECTOR_SNAPSHOT_MAX_AGE, CONNECTOR_SNAPSHOT_MAX_BYTES, SNAPSHOT_BUDGET_BYTES })",
    ctx,
  );
  return { ...api, store, perf };
}

if (SNAPSHOT_SRC) {
  const s = snapshotSandbox();
  ok("快照 24 小时过期、单条 1.5MB、合计 4.5MB",
    s.CONNECTOR_SNAPSHOT_MAX_AGE === 24 * HOUR
    && s.CONNECTOR_SNAPSHOT_MAX_BYTES === 1.5 * 1024 * 1024
    && s.SNAPSHOT_BUDGET_BYTES === 4.5 * 1024 * 1024);

  // 预算必须对称：插件快照写之前也要看连接器快照的现存字节数，否则谁后写谁把合计顶爆。
  const awesomeAt = clientSrc.indexOf("function writeAwesomeSnapshot(payload) {");
  const awesomeBody = awesomeAt >= 0 ? clientSrc.slice(awesomeAt, clientSrc.indexOf("// ── P1-4：连接器目录快照", awesomeAt)) : "";
  ok("插件快照写入也检查连接器快照字节（4.5MB 预算对称）",
    awesomeBody.includes("localStorage.getItem(CONNECTOR_SNAPSHOT_KEY)") && awesomeBody.includes("SNAPSHOT_BUDGET_BYTES"));
  const awesomeWithoutBudget = awesomeBody.replace("localStorage.getItem(CONNECTOR_SNAPSHOT_KEY)", "localStorage.getItem('other')");
  ok("反向自测：去掉插件侧的预算检查后断言必须判红",
    awesomeBody.includes("localStorage.getItem(CONNECTOR_SNAPSHOT_KEY)")
    && !awesomeWithoutBudget.includes("localStorage.getItem(CONNECTOR_SNAPSHOT_KEY)"));

  s.writeConnectorSnapshot({ connectors: [{ id: "a" }], source: "zip:local" });
  const back = s.readConnectorSnapshot();
  ok("写入后可读回（含 source）", back && back.connectors[0].id === "a" && back.source === "zip:local");
  ok("空目录不落盘", (s.store.clear(), s.writeConnectorSnapshot({ connectors: [] }), !s.store.has(s.CONNECTOR_SNAPSHOT_KEY)));

  const stale = { savedAt: Date.now() - 25 * HOUR, source: "x", connectors: [{ id: "old" }] };
  s.store.set(s.CONNECTOR_SNAPSHOT_KEY, JSON.stringify(stale));
  ok("超过 24 小时视为无效", s.readConnectorSnapshot() === null);

  const fresh = { savedAt: Date.now() - 23 * HOUR, source: "x", connectors: [{ id: "old" }] };
  s.store.set(s.CONNECTOR_SNAPSHOT_KEY, JSON.stringify(fresh));
  ok("23 小时内仍可用", s.readConnectorSnapshot()?.connectors[0].id === "old");
  const longer = snapshotSandbox(SNAPSHOT_SRC.replace("24 * 60 * 60 * 1000", "48 * 60 * 60 * 1000"));
  longer.store.set(longer.CONNECTOR_SNAPSHOT_KEY, JSON.stringify(stale));
  ok("反向自测：放宽过期窗口后同一条快照就能读回（拒绝确由时效守卫）", longer.readConnectorSnapshot() !== null);

  s.store.clear();
  s.writeConnectorSnapshot({ connectors: [{ id: "big", text: "x".repeat(1.55 * 1024 * 1024) }] });
  ok("单条超过 1.5MB 不落盘", !s.store.has(s.CONNECTOR_SNAPSHOT_KEY));

  s.store.clear();
  s.store.set("dsh-armory.awesomeCatalog.v1", "y".repeat(3.3 * 1024 * 1024));
  s.writeConnectorSnapshot({ connectors: [{ id: "b", text: "z".repeat(1.35 * 1024 * 1024) }] });
  ok("与 awesome 快照合计超过 4.5MB 时不落盘", !s.store.has(s.CONNECTOR_SNAPSHOT_KEY));

  s.perf.connectorSnapshot = false;
  s.writeConnectorSnapshot({ connectors: [{ id: "c" }] });
  ok("开关关闭后不写", !s.store.has(s.CONNECTOR_SNAPSHOT_KEY));
  s.store.set(s.CONNECTOR_SNAPSHOT_KEY, JSON.stringify({ savedAt: Date.now(), connectors: [{ id: "c" }] }));
  ok("开关关闭后不读", s.readConnectorSnapshot() === null);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. P1-6 宿主连接器计数缓存
// ═══════════════════════════════════════════════════════════════════════════
section("4. P1-6 连接器计数缓存");
const COUNT_START = "export async function wbConnectorCachedCount() {";
const COUNT_END = "  } catch {\n    return { total: null };\n  }\n}";
const countStartAt = marketSrc.indexOf(COUNT_START);
const countEndAt = marketSrc.indexOf(COUNT_END, countStartAt);
const COUNT_BODY = countStartAt < 0 || countEndAt < 0
  ? ""
  : marketSrc.slice(countStartAt, countEndAt + COUNT_END.length).replace("export ", "");
ok("能定位 wbConnectorCachedCount 原文", Boolean(COUNT_BODY));

if (COUNT_BODY) {
  let reads = 0;
  let mode = "ok";
  const readFileFn = async () => {
    reads += 1;
    if (mode === "fail") throw new Error("ENOENT");
    return Buffer.from("zip");
  };
  class ZipReader {
    extract() {
      return Buffer.from(JSON.stringify({ connectors: [{ id: "a" }, { source: "b" }, { id: "   " }, { name: "no-id" }] }));
    }
  }
  const ctx = vm.createContext({ readFile: readFileFn, ZipReader, zipPath: () => "connectors.zip", Date });
  vm.runInContext(`const COUNT_CACHE_TTL = 10 * 60 * 1000;\nlet countCache = null;\n${COUNT_BODY}`, ctx, { filename: "wb-market.count-slice.js" });
  const api = vm.runInContext("({ wbConnectorCachedCount, reset: () => { countCache = null; } })", ctx);

  const first = await api.wbConnectorCachedCount();
  ok("首次调用真扫 ZIP，空 id 被过滤", first.total === 2 && reads === 1, `total=${first.total} reads=${reads}`);
  const second = await api.wbConnectorCachedCount();
  ok("10 分钟内复用缓存，不再扫 ZIP", second.total === 2 && reads === 1);
  vm.runInContext("countCache.at -= COUNT_CACHE_TTL", ctx);
  const third = await api.wbConnectorCachedCount();
  ok("超过 10 分钟重新扫描", third.total === 2 && reads === 2);

  api.reset();
  mode = "fail";
  const failed = await api.wbConnectorCachedCount();
  ok("读盘失败返回 total:null", failed.total === null && reads === 3);
  mode = "ok";
  const recovered = await api.wbConnectorCachedCount();
  ok("失败结果不进缓存，下一次立即重试", recovered.total === 2 && reads === 4);
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. P2-1 工具裁缝账本缓存
// ═══════════════════════════════════════════════════════════════════════════
section("5. P2-1 工具裁缝账本缓存");
const TAILOR_SRC = slice(indexSrc, "tailor-cache", "const TAILOR_CACHE_TTL = 5 * 60 * 1000;", "async function scanToolTailor(ctx, days) {");

function tailorSandbox(src = TAILOR_SRC) {
  const calls = [];
  let impl = async (ctxArg, days) => { calls.push(days); return { days, n: calls.length }; };
  const ctx = vm.createContext({
    Date,
    scanToolTailor: (ctxArg, days) => impl(ctxArg, days),
  });
  vm.runInContext(src, ctx, { filename: "index.tailor-cache-slice.js" });
  const api = vm.runInContext(
    "({ buildToolTailorReport, reset: () => { tailorCache.clear(); tailorInFlight.clear(); }, cache: tailorCache, inflight: tailorInFlight, TAILOR_CACHE_TTL })",
    ctx,
  );
  return { ...api, calls, setImpl: (next) => { impl = next; } };
}

if (TAILOR_SRC) {
  const s = tailorSandbox();
  ok("账本缓存 TTL 是 5 分钟", s.TAILOR_CACHE_TTL === 5 * 60 * 1000);

  await s.buildToolTailorReport({}, { days: -5 });
  await s.buildToolTailorReport({}, { days: "7" });
  await s.buildToolTailorReport({}, { days: 9999 });
  await s.buildToolTailorReport({}, {});
  ok("days 收敛到 [1,365]，缺省 30（0 / 缺失都按 30）", JSON.stringify(s.calls) === JSON.stringify([1, 7, 365, 30]), `calls=${s.calls}`);

  const before = s.calls.length;
  await s.buildToolTailorReport({}, { days: 7 });
  ok("同 days 在 TTL 内命中缓存，不再扫日志", s.calls.length === before);

  s.reset();
  const beforeConcurrent = s.calls.length;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  s.setImpl(async (ctxArg, days) => { s.calls.push(days); await gate; return { days, shared: true }; });
  const a = s.buildToolTailorReport({}, { days: 30 });
  const b = s.buildToolTailorReport({}, { days: 30 });
  release();
  const [ra, rb] = await Promise.all([a, b]);
  const concurrentCalls = s.calls.length - beforeConcurrent;
  ok("并发同 days 只扫一次（共享同一条扫描）", concurrentCalls === 1 && ra.shared && rb.shared, `扫描=${concurrentCalls}`);
  ok("并发结束后挂起表清空", s.inflight.size === 0);
  s.setImpl(async (ctxArg, days) => { s.calls.push(days); return { days, n: s.calls.length }; });

  const cachedCalls = s.calls.length;
  await s.buildToolTailorReport({}, { days: 30, refresh: true });
  ok("refresh:true 绕过缓存强制重扫", s.calls.length === cachedCalls + 1);
  await s.buildToolTailorReport({}, { days: 30 });
  ok("重扫结果回填缓存（紧接着的普通请求不再扫）", s.calls.length === cachedCalls + 1);

  // 真正的过期断言：直接改缓存条目的写入时间（同一沙箱里的 tailorCache）。
  const cam = s.cache.get(30);
  cam.at -= s.TAILOR_CACHE_TTL + 1;
  await s.buildToolTailorReport({}, { days: 30 });
  ok("超过 5 分钟后重新扫描", s.calls.length === cachedCalls + 2);

  const failCalls = s.calls.length;
  s.setImpl(async (ctxArg, days) => { s.calls.push(days); throw new Error("boom"); });
  let rejected = false;
  try { await s.buildToolTailorReport({}, { days: 9 }); } catch { rejected = true; }
  ok("扫描失败向上抛错且不写缓存", rejected && !s.cache.has(9) && s.inflight.size === 0);
  s.setImpl(async (ctxArg, days) => { s.calls.push(days); return { days, ok: true }; });
  const retry = await s.buildToolTailorReport({}, { days: 9 });
  ok("失败后的下一次请求会重扫", retry.ok === true && s.calls.length === failCalls + 2);

  // 反向自测：把缓存分支关掉，同一请求必须扫两次。
  const noCache = tailorSandbox(TAILOR_SRC.replace("if (!refresh) {", "if (false) {"));
  await noCache.buildToolTailorReport({}, { days: 30 });
  await noCache.buildToolTailorReport({}, { days: 30 });
  ok("反向自测：去掉缓存分支后同请求扫两次", noCache.calls.length === 2, `calls=${noCache.calls.length}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. 接线层源码针
// ═══════════════════════════════════════════════════════════════════════════
section("6. 接线层");
const PINS = [
  ["懒加载：市场 API 走缓存 Promise", indexSrc, MARKS.lazyMarket],
  ["懒加载：专家 API 走缓存 Promise", indexSrc, MARKS.lazyExpert],
  ["P0-2：模块物化耗时打点", clientSrc, "if (PERF_ON) perfMark('module', 'materialize'"],
  ["P0-2：首个业务 RPC 往返打点", clientSrc, "perfMark('firstRpc', 'ms', performance.now() - rpcStartedAt);"],
  ["P0-3：徽章首拉推迟到空闲帧", clientSrc, "scheduleIdle(() => { if (!cancelled) sync(); })"],
  ["P0-3：徽章轮询 15 秒", clientSrc, "null, 15000, sync)"],
  ["P0-2：apply 起止打点", clientSrc, "perfMark('apply', 'end', performance.now() - PERF_T0);"],
  ["P1-4：连接器先铺快照再刷新", clientSrc, "const cached = connectorCatalogMemo || readConnectorSnapshot();"],
  ["P1-4：成功后回写快照", clientSrc, "scheduleIdle(() => writeConnectorSnapshot({ connectors: rows, source: res.loadedFrom }), 5000)"],
  ["P1-4：快照签名没变不重写", clientSrc, "if (snapshotSig !== connectorSnapshotSigRef.current)"],
  ["P1-4：刷新失败降级为提示（有快照时）", clientSrc, "t('刷新连接器目录失败，当前显示的是本机快照：{0}'"],
  ["P1-5：技能缓存键含 page|sort|keyword", clientSrc, "const cacheKey = page + '|' + sort + '|' + String(keyword || '');"],
  ["P1-5：命中即渲染", clientSrc, "const cached = readSkillCache(cacheKey);"],
  ["P1-3：快照只在插件页 hydrate", clientSrc, "if (next === 'plugin') hydrateAwesomeFromSnapshot();"],
  ["P1-3：懒读开关", clientSrc, "if (awesomeSnapshotRef.current === undefined && !MARKET_PERF.awesomeSnapshotLazy)"],
  ["P1-3：签名没变不重写", clientSrc, "if (snapshotSig !== awesomeSnapshotSigRef.current)"],
  ["P1-3：写盘推到空闲帧", clientSrc, "scheduleIdle(() => writeAwesomeSnapshot({ plugins: catalog, marketplace, fetchedAt: res.fetchedAt }), 5000)"],
  ["P1-1：插件目录等连接器首屏落地", clientSrc, "if (awesomeAutoLoaded.current || !connectorSettled) return undefined;"],
  ["P2-2：连接器列表会话内复用", clientSrc, "connectorCatalogMemo = { connectors: rows, source: res.loadedFrom || '', at: Date.now() };"],
  ["P2-3：连接器卡片挂预取", clientSrc, "onMouseEnter: () => prefetchConnectorDetail(item)"],
  ["P2-3：技能卡片挂预取", clientSrc, "onMouseEnter: () => prefetchSkillDetail(skill)"],
  ["P2-3：插件卡片挂预取", clientSrc, "onMouseEnter: () => prefetchReadme(item)"],
  ["P2-3：离场取消", clientSrc, "onMouseLeave: cancelHoverPrefetch"],
  ["P2-3：点开详情先吃预取结果", clientSrc, "const precached = readDetailMemo(hoverMemo.skillDetail, memoKey);"],
  ["P1-6：目录成功即回填计数缓存", marketSrc, "countCache = { at: Date.now(), total: rows.length };"],
  ["P1-6：计数命中直接返回", marketSrc, "if (countCache && Date.now() - countCache.at < COUNT_CACHE_TTL) return { total: countCache.total };"],
  ["P2-1：refresh 透传宿主", clientSrc, "...(force ? { refresh: true } : {})"],
];
for (const [label, src, needle] of PINS) ok(label, has(src, needle), has(src, needle) ? "" : `缺="${needle}"`);

ok("新提示键有 en-US 译文",
  has(clientSrc, '"刷新连接器目录失败，当前显示的是本机快照：{0}": "Failed to refresh the connector catalog; showing the local snapshot: {0}"'));

const flags = ["dsh-armory.connectorSnapshot", "dsh-armory.awesomeSnapshotLazy", "dsh-armory.skillSwr", "dsh-armory.hoverPrefetch"];
ok("四个客户端开关默认开启（可用 localStorage 逐项回退）", flags.every((key) => has(clientSrc, `perfFlag('${key}', true)`)));

// ═══════════════════════════════════════════════════════════════════════════
console.log(failures === 0 ? `\nPERF-MARKET-LOAD PASS（${checks} 条）` : `\nPERF-MARKET-LOAD FAIL（${failures}/${checks} 项）`);
process.exit(failures === 0 ? 0 : 1);