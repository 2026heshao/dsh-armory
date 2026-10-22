// test/teardown-residue.mjs
//
// 护栏对象：清单 2.4「teardown 残留诊断」。
//
// 背景：本模块从不 spawn MCP 子进程，拿不到 pid，因此无法主动回收卡住的 teardown
// （详见 lib/workspace-runtime.js:307-313 的注释）。
// 能做的是把「已经等了多久、有没有超阈、上次花了多久」变成可见事实。这套记录表就是
// 面板那块读数的唯一出处，它的三档语义必须被钉死：
//   live  —— 还在跑，elapsedMs 必须**现算**（存盘值一落地就过期）；
//   final —— 已落定，用存盘终值，且超龄整条不送；
//   表    —— 按 app root 分桶、桶内按 connKey 只留最近一条、上限 TEARDOWN_RECORD_MAX。
//
// 策略：**真跑**。这些函数虽然没 export（见下方「可测性缺口」），但它们是纯函数或
// 只依赖 Date.now / Map / WeakMap，把对应源码片段抽出来丢进 vm 即可原样执行。
// 比静态断言强的地方在于：能真的喂 70 条记录看裁剪、能真的把时钟拨过 600s 看超龄。
//
// ⚠ 可测性缺口（已写进交付报告，本套件**不修改源码**）：
//   lib/workspace-runtime.js:1319 的 export 白名单里没有 teardownLiveView / teardownFinalView /
//   beginTeardownRecord / settleTeardownRecord / pruneTeardownRecords / TEARDOWN_* 常量。
//   因此本套件只能靠 vm 抽片段。如果哪天这些函数被导出，这里可以退化成直接 import —— 
//   断言内容不用改。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 仓库路径含中文，必须走 fileURLToPath —— URL.pathname 会把中文百分号编码。
const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME = join(HERE, "..", "lib", "workspace-runtime.js");

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (condition) {
    console.log(`PASS  ${name}${extra ? `  ${extra}` : ""}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? `  ${extra}` : ""}`);
  }
};
const info = (name, extra = "") => console.log(`INFO  ${name}${extra ? `  ${extra}` : ""}`);

const source = readFileSync(RUNTIME, "utf8");

/**
 * 按「起止标记」取源码片段，而不是按行号。
 *
 * 为什么不用行号：lib/workspace-runtime.js 仍在演进，任何人在文件上半部分插几行，行号切片
 * 就会**静默**抽到错的片段（抽到空段或半个函数），断言随即以「函数未定义」这种看不懂的形式
 * 失败。而这两个段落的标题注释本身就是该文件的结构约定（`// ---------- xxx ----------`），
 * 它们被删改时也理应让测试报错。所以按标记切，并在切不到时明确报出来。
 */
const sliceBetween = (startMarker, endMarker, label) => {
  const at = source.indexOf(startMarker);
  if (at === -1) return { text: "", line: 0, reason: `找不到起始标记：${label}` };
  const end = source.indexOf(endMarker, at + startMarker.length);
  if (end === -1) return { text: "", line: 0, reason: `找不到结束标记：${label}` };
  const line = source.slice(0, at).split("\n").length;
  return { text: source.slice(at, end), line, reason: "" };
};

// ── 0. 抽两段源码：appRoot / bucketOf 与整段 teardown 记录表 ────────────────
const HELPERS_MARK = "// ---------- 模块级状态的键约定";
const HELPERS_END = "// 配置缓存按 app root 隔离";
const RECORDS_MARK = "// ---------- OPT-15：teardown 上界可观测化 ----------";
const RECORDS_END = "// 立刻销毁一份连接";

const helpersSlice = sliceBetween(HELPERS_MARK, HELPERS_END, "appRoot / bucketOf");
const recordsSlice = sliceBetween(RECORDS_MARK, RECORDS_END, "teardown 记录表");
const helpers = helpersSlice.text;
const records = recordsSlice.text;
for (const s of [helpersSlice, recordsSlice]) {
  ok(`能按段落标记切出源码片段（${s.reason || "OK"}）`, !s.reason, s.reason || `起始于第 ${s.line} 行`);
}

// TEARDOWN_STUCK_MS 定义在 178 行（与 DEAD_CONNECTION_AGE_MS 同一段，注释里写明取 5s
// 是为了「已死」与「回收卡住」共用同一条时间尺度），不在上面那段记录表里。单独抽出来。
const STUCK_CONST_RE = /^const TEARDOWN_STUCK_MS = [^;]+;$/m;
const stuckConst = (source.match(STUCK_CONST_RE) || [])[0];
ok("能定位 TEARDOWN_STUCK_MS 常量声明", !!stuckConst, stuckConst || "未找到（常量可能被改了名或改了写法）");
if (!stuckConst) {
  console.log("\nTEARDOWN-RESIDUE FAIL（卡住阈值常量缺失）");
  process.exit(1);
}

ok("抽到了 appRoot / bucketOf 两个助手函数",
  /function appRoot\(ctx\)/.test(helpers) && /function bucketOf\(store, ctx\)/.test(helpers),
  `起始于第 ${helpersSlice.line} 行`);
ok("抽到了 teardown 记录表的完整实现（含三个常量与五个函数）",
  ["TEARDOWN_STUCK_MS", "TEARDOWN_RECORD_MAX", "TEARDOWN_RECORD_STALE_MS",
    "function beginTeardownRecord", "function settleTeardownRecord", "function teardownRecordFor",
    "function pruneTeardownRecords", "function observeTeardown",
    "function teardownLiveView", "function teardownFinalView"].every((needle) => records.includes(needle)),
  `起始于第 ${recordsSlice.line} 行`);

// ── 1. 装载：把片段丢进 vm，用可控时钟跑 ────────────────────────────────────
/** 建一个沙箱；返回 { api, bucketOf，TeardownRecords, setNow } 。 */
function loadModule() {
  let fakeNow = 1_000_000;
  // 覆写 Date.now 以便把时钟拨到任意位置 —— 这些函数是时间的纯函数，时钟必须可控，
  // 否则「超龄 600s」这种断言只能靠 sleep，测试会慢且不稳。
  class FakeDate extends Date {
    static now() { return fakeNow; }
  }
  const context = { console, Date: FakeDate };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    helpers + "\n" + stuckConst + "\n" + records + `
    globalThis.__api = {
      appRoot, bucketOf, teardownRecords,
      TEARDOWN_STUCK_MS, TEARDOWN_RECORD_MAX, TEARDOWN_RECORD_STALE_MS,
      beginTeardownRecord, settleTeardownRecord, teardownRecordFor,
      pruneTeardownRecords, observeTeardown,
      teardownLiveView, teardownFinalView,
    };`,
    context,
    { filename: "teardown-records.js" },
  );
  return {
    api: context.__api,
    setNow: (value) => { fakeNow = value; },
    getNow: () => fakeNow,
  };
}

let mod;
try {
  mod = loadModule();
  ok("能把 teardown 记录表的源码片段抽到 vm 里原样执行", !!mod.api && typeof mod.api.teardownLiveView === "function");
} catch (error) {
  ok("能把 teardown 记录表的源码片段抽到 vm 里原样执行", false, String(error && error.message));
  console.log("\nTEARDOWN-RESIDUE FAIL（片段无法执行，源码结构可能已变化）");
  process.exit(1);
}

const {
  TEARDOWN_STUCK_MS, TEARDOWN_RECORD_MAX, TEARDOWN_RECORD_STALE_MS,
  appRoot, teardownRecords,
  beginTeardownRecord, settleTeardownRecord, teardownRecordFor,
  teardownLiveView, teardownFinalView, observeTeardown,
} = mod.api;

// ── 2. 常量契约 ─────────────────────────────────────────────────────────────
ok("TEARDOWN_STUCK_MS = 5000（卡住判定阈值 5 秒）", TEARDOWN_STUCK_MS === 5000, `得到=${TEARDOWN_STUCK_MS}`);
ok("TEARDOWN_RECORD_MAX = 64（记录表上限，兜底内存泄漏）", TEARDOWN_RECORD_MAX === 64, `得到=${TEARDOWN_RECORD_MAX}`);
ok("TEARDOWN_RECORD_STALE_MS = 600000（10 分钟前的读数不再送）",
  TEARDOWN_RECORD_STALE_MS === 600_000, `得到=${TEARDOWN_RECORD_STALE_MS}`);
ok("上限严格小于超龄阈值之外还满足「上限远小于阈值」的量级关系：64 条 × 10 分钟",
  TEARDOWN_RECORD_MAX > 0 && TEARDOWN_RECORD_STALE_MS > TEARDOWN_STUCK_MS, "");

// ── 3. teardownLiveView：elapsed 现算 + stuck 跨 5000 翻转 ──────────────────
const t0 = 2_000_000;
mod.setNow(t0);
const liveRecord = { wsPath: "/ws/a", serverName: "srv", startedAt: t0, settledAt: null, elapsedMs: 0, settled: false, stuck: false, error: "" };

const atZero = teardownLiveView(liveRecord, t0);
ok("live · 刚开始（elapsed=0）→ stuck: false", atZero && atZero.stuck === false, `得到=${JSON.stringify(atZero)}`);
ok("live · 刚开始 → settled: false（仍在跑）", atZero && atZero.settled === false, "");
ok("live · 刚开始 → elapsedMs 是现算的 0", atZero && atZero.elapsedMs === 0, `得到=${atZero && atZero.elapsedMs}`);
ok("live · 透出 startedAt（面板要显示开始时刻）", atZero && atZero.startedAt === t0, `得到=${atZero && atZero.startedAt}`);

const at4999 = teardownLiveView(liveRecord, t0 + 4999);
ok("live · elapsed=4999（阈值前 1ms）→ stuck: false",
  at4999 && at4999.stuck === false && at4999.elapsedMs === 4999, `得到=${JSON.stringify(at4999)}`);

const at5000 = teardownLiveView(liveRecord, t0 + 5000);
ok("live · elapsed=5000（恰好等于阈值）→ stuck: true（边界含等号）",
  at5000 && at5000.stuck === true && at5000.elapsedMs === 5000, `得到=${JSON.stringify(at5000)}`);

const at12500 = teardownLiveView(liveRecord, t0 + 12500);
ok("live · elapsed=12500 → stuck: true 且 elapsedMs 如实上报",
  at12500 && at12500.stuck === true && at12500.elapsedMs === 12500, `得到=${JSON.stringify(at12500)}`);

// 现算而非读存盘值：记录里 elapsedMs 被写成垃圾也必须无视。
const dirtyRecord = Object.assign({}, liveRecord, { elapsedMs: 999_999, stuck: true });
const dirtyView = teardownLiveView(dirtyRecord, t0 + 100);
ok("live · 无视记录里过期的存盘 elapsedMs（必须现算，存盘值一落地就过期）",
  dirtyView && dirtyView.elapsedMs === 100 && dirtyView.stuck === false,
  `得到=${JSON.stringify(dirtyView)}`);

// 时钟回退（系统时间被改）：不能出现负的 elapsedMs。
const backwards = teardownLiveView(liveRecord, t0 - 5000);
ok("live · 时钟回退时不产生负的 elapsedMs（夹到 0）",
  backwards && backwards.elapsedMs === 0 && backwards.stuck === false, `得到=${JSON.stringify(backwards)}`);

// 已落定的记录不走 live 视图（否则同一件事两套说法）。
const settledRecord = { wsPath: "/ws/a", serverName: "srv", startedAt: t0, settledAt: t0 + 8000, elapsedMs: 8000, settled: true, stuck: true, error: "" };
ok("live · 已落定的记录返回 null（落定了就不再是 live）",
  teardownLiveView(settledRecord, t0 + 9000) === null, `得到=${JSON.stringify(teardownLiveView(settledRecord, t0 + 9000))}`);
ok("live · null / undefined 记录返回 null", teardownLiveView(null, t0) === null && teardownLiveView(undefined, t0) === null, "");

// ── 4. teardownFinalView：settled 终值 + 超龄不送 ─────────────────────────
const freshFinal = teardownFinalView(settledRecord, t0 + 9000);
ok("final · 未超龄 → 返回非 null", !!freshFinal, "");
ok("final · 未超龄 → settled: true", freshFinal && freshFinal.settled === true, `得到=${JSON.stringify(freshFinal)}`);
ok("final · 用存盘的终值 elapsedMs（不是现算）",
  freshFinal && freshFinal.elapsedMs === 8000, `得到=${freshFinal && freshFinal.elapsedMs}`);
ok("final · 透出 stuck 终值（这一趟有没有卡过）",
  freshFinal && freshFinal.stuck === true, `得到=${freshFinal && freshFinal.stuck}`);

// 超龄边界：以 settledAt 为基准，恰好 600000 仍送，600001 不送。
const settledAtBase = t0 + 8000;
const atStaleEdge = teardownFinalView(settledRecord, settledAtBase + TEARDOWN_RECORD_STALE_MS);
ok("final · 恰好在超龄阈值上（600000ms）→ 仍然送（边界不含大于）",
  atStaleEdge !== null, `得到=${JSON.stringify(atStaleEdge)}`);
const pastStaleEdge = teardownFinalView(settledRecord, settledAtBase + TEARDOWN_RECORD_STALE_MS + 1);
ok("final · 超过超龄阈值 1ms → 返回 null（10 分钟前的读数不再误导人）",
  pastStaleEdge === null, `得到=${JSON.stringify(pastStaleEdge)}`);

// settledAt 缺失时用 startedAt 兜底，而不是让比较变成 NaN（NaN 比较永远 false → 永不过期）。
const noSettledAt = Object.assign({}, settledRecord, { settledAt: undefined });
const fallbackStale = teardownFinalView(noSettledAt, t0 + TEARDOWN_RECORD_STALE_MS + 1);
ok("final · settledAt 缺失时用 startedAt 兜底判断超龄（NaN 会让记录永不过期）",
  fallbackStale === null, `得到=${JSON.stringify(fallbackStale)}`);

// 未落定的记录不走 final 视图。
ok("final · 未落定的记录返回 null（不知道会不会结束的旧 teardown 不能挂在 ready 行上）",
  teardownFinalView(liveRecord, t0 + 100) === null, `得到=${JSON.stringify(teardownFinalView(liveRecord, t0 + 100))}`);
ok("final · null 记录返回 null", teardownFinalView(null, t0) === null, "");

// ── 5. error 字段：有错透出、无错为空 ─────────────────────────────────────
const errLive = teardownLiveView({ startedAt: t0, settled: false, error: "spawn ENOENT" }, t0 + 10);
ok("live · 有错误时把 error 透出", errLive && errLive.error === "spawn ENOENT", `得到=${JSON.stringify(errLive && errLive.error)}`);
const noErrLive = teardownLiveView({ startedAt: t0, settled: false, error: "" }, t0 + 10);
ok("live · 无错误时 error 是空串（不是 null/undefined，面板拼串不会出 'undefined'）",
  noErrLive && noErrLive.error === "", `得到=${JSON.stringify(noErrLive && noErrLive.error)}`);

const errFinal = teardownFinalView({ startedAt: t0, settledAt: t0 + 1, elapsedMs: 1, settled: true, stuck: false, error: "ECONNRESET" }, t0 + 10);
ok("final · 有错误时把 error 透出", errFinal && errFinal.error === "ECONNRESET", `得到=${JSON.stringify(errFinal && errFinal.error)}`);
const noErrFinal = teardownFinalView({ startedAt: t0, settledAt: t0 + 1, elapsedMs: 1, settled: true, stuck: false, error: "" }, t0 + 10);
ok("final · 无错误时 error 是空串", noErrFinal && noErrFinal.error === "", `得到=${JSON.stringify(noErrFinal && noErrFinal.error)}`);

// error 字段在 record 上不存在时（老记录 / 畸形记录）不能炸，也不能污染成字符串 "undefined"。
const noErrorField = teardownLiveView({ startedAt: t0, settled: false }, t0 + 10);
ok("live · record 上没有 error 字段时取到 undefined（不抛错、不变成 'undefined' 字符串）",
  noErrorField && (noErrorField.error === undefined || noErrorField.error === null || noErrorField.error === ""),
  `得到=${JSON.stringify(noErrorField && noErrorField.error)}`);

// ── 6. begin / settle / 分桶 / 裁剪 ───────────────────────────────────────
const ctx = {};
const mkEntry = (key) => ({ key, wsPath: "/ws/" + key, serverName: "srv-" + key });

mod.setNow(3_000_000);
const rec1 = beginTeardownRecord(ctx, mkEntry("c1"), 3_000_000);
ok("begin · 返回的 record 形状符合面板契约（8 个字段齐全）",
  ["wsPath", "serverName", "startedAt", "settledAt", "elapsedMs", "settled", "stuck", "error"]
    .every((k) => Object.prototype.hasOwnProperty.call(rec1, k)),
  `字段=${JSON.stringify(Object.keys(rec1))}`);
ok("begin · 新记录是未落定态（settled:false, elapsedMs:0, stuck:false, error:''）",
  rec1.settled === false && rec1.elapsedMs === 0 && rec1.stuck === false && rec1.error === "",
  `得到=${JSON.stringify(rec1)}`);
ok("begin · 记录进入后能被 teardownRecordFor 读到（按 connKey）",
  teardownRecordFor(ctx, "c1") === rec1, "");

// 同一 connKey 再来一轮 → 覆盖，只留最近一条。
const rec1b = beginTeardownRecord(ctx, mkEntry("c1"), 3_100_000);
ok("begin · 同一 connKey 的新一轮覆盖旧记录（桶内只留最近一条）",
  teardownRecordFor(ctx, "c1") === rec1b && teardownRecordFor(ctx, "c1") !== rec1, "");
mod.setNow(3_108_000);
settleTeardownRecord(ctx, mkEntry("c1"), rec1b, "");
ok("settle · 落定后 elapsedMs = settledAt - startedAt（8000ms）",
  rec1b.settled === true && rec1b.elapsedMs === 8000, `得到=${JSON.stringify({ settled: rec1b.settled, elapsedMs: rec1b.elapsedMs })}`);
ok("settle · 耗时 >= 5000 时 stuck 记为 true（记的是「这一趟有没有卡过」）",
  rec1b.stuck === true, `得到=${rec1b.stuck}`);

// 同步失败先记错，随后空消息不能把它改写成「干净释放」。
const recErr = beginTeardownRecord(ctx, mkEntry("cErr"), 3_200_000);
mod.setNow(3_200_000);
settleTeardownRecord(ctx, mkEntry("cErr"), recErr, "spawn ENOENT");
const errorAfterFirst = recErr.error;
settleTeardownRecord(ctx, mkEntry("cErr"), recErr, "");
ok("settle · 先落定者为准：随后的空消息不会把真实错误洗掉",
  errorAfterFirst === "spawn ENOENT" && recErr.error === "spawn ENOENT",
  `得到=${JSON.stringify(recErr.error)}`);

// 迟到的旧记录落定不能改写新一轮。
const oldRec = beginTeardownRecord(ctx, mkEntry("late"), 3_300_000);
const newRec = beginTeardownRecord(ctx, mkEntry("late"), 3_400_000);
mod.setNow(3_400_000);
settleTeardownRecord(ctx, mkEntry("late"), oldRec, "late failure");
ok("settle · 迟到的旧记录落定不改写新一轮（否则「正在卡住」会被显示成「已释放」）",
  newRec.settled === false && teardownRecordFor(ctx, "late") === newRec,
  `新一轮 settled=${newRec.settled}`);

// 分桶：不同 app root 的记录互不可见。
const ctxA = {};
const ctxB = {};
beginTeardownRecord(ctxA, mkEntry("iso"), 3_500_000);
ok("分桶 · app root A 的记录在 app root B 里读不到",
  teardownRecordFor(ctxA, "iso") !== null && teardownRecordFor(ctxB, "iso") === null, "");
ok("分桶 · ctx.root 存在时用 root 作桶键（cordis context 的常见形态）",
  (() => {
    const root = {};
    const wrapper = { root };
    beginTeardownRecord(wrapper, mkEntry("viaroot"), 3_600_000);
    return teardownRecordFor(root, "viaroot") !== null;
  })(), "");

// 上限裁剪：灌 TEARDOWN_RECORD_MAX + 6 条，桶必须停在 64，且淘汰的是最旧的。
const ctxMax = {};
const total = TEARDOWN_RECORD_MAX + 6;
for (let i = 0; i < total; i += 1) {
  beginTeardownRecord(ctxMax, mkEntry("k" + i), 4_000_000 + i);
}
const bucket = teardownRecords.get(appRoot(ctxMax));
ok("裁剪 · 记录数超过上限后被裁剪到 TEARDOWN_RECORD_MAX",
  bucket.size === TEARDOWN_RECORD_MAX, `灌入=${total} 裁剪后=${bucket.size}`);
ok("裁剪 · 淘汰的是 startedAt 最旧的一条（k0..k5 应已不在）",
  ["k0", "k1", "k2", "k3", "k4", "k5"].every((k) => !bucket.has(k)),
  `残留最旧=${JSON.stringify([...bucket.keys()].slice(0, 3))}`);
ok("裁剪 · 最新的记录必须还在（k69 仍在）",
  bucket.has("k" + (total - 1)), `期望=k${total - 1}`);
ok("裁剪 · 留下的记录数正好等于上限，不多不少", bucket.size === TEARDOWN_RECORD_MAX, `得到=${bucket.size}`);

// 裁剪后每个留下的记录仍能被正确读成 final 视图。
{
  const survivor = bucket.get("k" + (total - 1));
  mod.setNow(survivor.startedAt + 100);
  settleTeardownRecord(ctxMax, mkEntry("k" + (total - 1)), survivor, "");
  const view = teardownFinalView(survivor, survivor.settledAt + 1);
  ok("裁剪后幸存的记录仍能正常落定并读出 final 视图",
    view && view.settled === true && view.elapsedMs === 100, `得到=${JSON.stringify(view)}`);
}

// observeTeardown：旁路观察者，自己出错绝不能影响 teardown 的返回值。
ok("observeTeardown · 正常时返回写入结果",
  observeTeardown(() => 42) === 42, "");
ok("observeTeardown · 写入抛错时吞掉并返回 null（面板少一行读数，不能把释放搞失败）",
  observeTeardown(() => { throw new Error("boom"); }) === null, "");
ok("observeTeardown · 畸形 ctx 导致的 TypeError 也被吞掉",
  (() => {
    try {
      // appRoot(42) 会抛 TypeError，observeTeardown 必须拦住。
      return observeTeardown(() => beginTeardownRecord(42, mkEntry("bad"), 0)) === null;
    } catch {
      return false;
    }
  })(), "");

// ── 7. 反向自测：证明上面的断言不是恒真 ────────────────────────────────────
{
  // 把 stuck 判定改成 `>`（去掉等号），边界断言必须失败。
  const broken = records.replace(
    "stuck: elapsedMs >= TEARDOWN_STUCK_MS",
    "stuck: elapsedMs > TEARDOWN_STUCK_MS",
  );
  ok("自测前置：成功把 stuck 判定从 >= 改成 >", broken !== records);
  if (broken !== records) {
    let fakeNow = t0 + 5000;
    class D extends Date { static now() { return fakeNow; } }
    const c = { console, Date: D };
    c.globalThis = c;
    vm.createContext(c);
    vm.runInContext(helpers + "\n" + stuckConst + "\n" + broken + "\nglobalThis.__t = teardownLiveView;", c, { filename: "teardown-broken.js" });
    const view = c.__t({ startedAt: t0, settled: false, error: "" }, fakeNow);
    ok("自测：改成 > 之后，elapsed 恰好 5000 的边界断言确实会失败",
      view.stuck === false, `stuck=${view.stuck}`);
  }
}
{
  // 删掉超龄判断，超龄断言必须失败。
  const broken = records.replace(
    "if (now - (record.settledAt ?? record.startedAt) > TEARDOWN_RECORD_STALE_MS) return null;",
    "",
  );
  ok("自测前置：成功删掉超龄判断", broken !== records);
  if (broken !== records) {
    class D extends Date { static now() { return 0; } }
    const c = { console, Date: D };
    c.globalThis = c;
    vm.createContext(c);
    vm.runInContext(helpers + "\n" + stuckConst + "\n" + broken + "\nglobalThis.__t = teardownFinalView;", c, { filename: "teardown-broken2.js" });
    const stale = c.__t({ startedAt: 0, settledAt: 0, elapsedMs: 0, settled: true, stuck: false, error: "" }, TEARDOWN_RECORD_STALE_MS + 1);
    ok("自测：删掉超龄判断后，超龄返回 null 的断言确实会失败", stale !== null, `得到=${JSON.stringify(stale)}`);
  }
}
{
  // 把裁剪从 > 改成 >=，上限断言必须失败（会少留一条）。
  const broken = records.replace("while (bucket.size > TEARDOWN_RECORD_MAX)", "while (bucket.size >= TEARDOWN_RECORD_MAX)");
  ok("自测前置：成功把裁剪条件从 > 改成 >=", broken !== records);
  if (broken !== records) {
    class D extends Date { static now() { return 0; } }
    const c = { console, Date: D };
    c.globalThis = c;
    vm.createContext(c);
    vm.runInContext(helpers + "\n" + stuckConst + "\n" + broken + "\nglobalThis.__b = beginTeardownRecord; globalThis.__r = teardownRecords; globalThis.__ar = appRoot;", c, { filename: "teardown-broken3.js" });
    const cc = {};
    for (let i = 0; i < TEARDOWN_RECORD_MAX + 2; i += 1) c.__b(cc, { key: "x" + i, wsPath: "/w", serverName: "s" }, i);
    const size = c.__r.get(c.__ar(cc)).size;
    ok("自测：改成 >= 后，裁剪到 64 的断言确实会失败（会只剩 63）", size !== TEARDOWN_RECORD_MAX, `得到=${size}`);
  }
}
{
  // 切片器自身的自测：标记不存在时必须「明确报错」，而不是静默返回一个看起来合法的空串。
  // 这条防的是「将来有人改了段落标题 → 切片变空 → 真跑断言以看不懂的方式连锁失败」。
  const missStart = sliceBetween("// ---------- 这个标题根本不存在 ----------", RECORDS_END, "x");
  const missEnd = sliceBetween(RECORDS_MARK, "// ---------- 这个结束标记也不存在 ----------", "x");
  ok("自测：起始标记不存在时切片器明确报错（不静默返回空串）",
    missStart.text === "" && /找不到起始标记/.test(missStart.reason), missStart.reason || "（没报错！）");
  ok("自测：结束标记不存在时切片器明确报错",
    missEnd.text === "" && /找不到结束标记/.test(missEnd.reason), missEnd.reason || "（没报错！）");
}

info("记录表实测", `上限=${TEARDOWN_RECORD_MAX} 超龄=${TEARDOWN_RECORD_STALE_MS}ms 卡住阈值=${TEARDOWN_STUCK_MS}ms`);
console.log(`\n${failures === 0 ? "TEARDOWN-RESIDUE PASS" : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
