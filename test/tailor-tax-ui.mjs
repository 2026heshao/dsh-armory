// test/tailor-tax-ui.mjs
//
// 护栏对象：清单 6.1–6.4 的**面板侧** —— 账本新字段真的进了界面，且只在有事可说时才占位。
//
// 为什么还要这一套：lib/tool-ledger.js 新增的 wireTaxDaily / wireTaxLatest /
// wireTaxChangeCount / scannedSpanDays / undatedCalls / wireTaxTruncated /
// wireTaxDivergenceTokens 只有一条路能出错 —— 界面把字段名读错一个字母。RPC 信封的
// result 是 `$any`（typert.js 的 codec(sym, $any)），读错**不会报错**，只会静默地永远
// 渲染不出那一行；而「这次排查的起因就是屏幕上看不出来」正是本功能存在的理由。所以这里
// 不是匹配文本，而是照 install-toast.mjs 的办法把源码抽进 vm **真跑**，对真实产生的
// 节点树断言。
//
// 三件事必须成立：
//   1. 正常报告（跨度=窗口、差额 0、undated 0）→ 归因块与告警块**整块不渲染**。常驻告警会
//      把真告警教成背景噪音，这一条是假告警防线；
//   2. 异常报告 → 该行出现，且模板与参数顺序对得上（数字来自真实日志的那次扫描）；
//   3. 反向自测：把字段名改错 / 把阈值改成 0，上面的断言必须立刻变红 —— 否则这套护栏
//      自己就是那条「静默失效」的守卫。
//
// 只用 node: 内置模块。用法：node ./test/tailor-tax-ui.mjs

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 必须走 fileURLToPath：本仓库路径含中文，`URL.pathname` 是百分号编码的。
const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};

const source = await readFile(CLIENT, "utf8");

/** 按起止标记抽一段源码；标记缺失或不唯一直接失败（有人改名/搬走却没同步本测试会立刻暴露）。 */
function slice(label, startMarker, endMarker, { asExpression = false } = {}) {
  const first = source.indexOf(startMarker);
  if (first < 0 || source.indexOf(startMarker, first + 1) >= 0) {
    ok(`定位标记唯一：${label}`, false, `start="${startMarker}" first=${first}`);
    return null;
  }
  const end = source.indexOf(endMarker, first + startMarker.length);
  if (end < 0) {
    ok(`定位标记存在：${label} 的结束标记`, false, `end="${endMarker}"`);
    return null;
  }
  ok(`定位标记唯一：${label}`, true);
  // 表达式切片**必须**连结束标记一起吃掉：`) : null,` 里那个右括号收的是外层 h('div', …)，
  // 少了它整段括号不配平，vm 只会抛 SyntaxError，而不是告诉我们界面变了形状。
  const stop = asExpression ? end + endMarker.length : end;
  const text = source.slice(first, stop);
  return asExpression ? `const row = ${text.replace(/,\s*$/, "")};` : text;
}

const SLICE_A = slice(
  "告警块 + 归因块（decodeWarning → §5.2 之前）",
  "const decodeWarning = !report",
  "  // §5.2 头部指标分层",
);
const SLICE_B = slice(
  "真实下发税的取值（daily → errRate 之前）",
  "const daily = report && Array.isArray(report.dailyCalls)",
  "  const errRate =",
);
// 第二行趋势整块是 hero 里的一个三元表达式（以 `) : null,` 收尾）；去掉尾逗号即可独立求值。
const SLICE_ROW = slice(
  "第二行趋势（hasWireTax 三元）",
  "hasWireTax ? h('div', { className: 'dsh-mcp-tailor-trend' },",
  "      ) : null,",
  { asExpression: true },
);
if (!SLICE_A || !SLICE_B || !SLICE_ROW) {
  console.log("\nTAILOR-TAX-UI FAIL（标记缺失，无法抽取待测源码）");
  process.exit(1);
}

// ── 替身：只替外部依赖，渲染逻辑与模板一律用 lib/client.js 原文 ────────────────
// 记录型 h：产出可断言的节点树（真实组件里 h 就是 React.createElement，形状一致）。
const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(2).filter((c) => c !== null && c !== undefined && c !== false) });
const flat = (node) => {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flat).join("");
  return flat(node.children);
};
const classes = (node) => (node && node.props ? String(node.props.className || "") : "");
// t 的中文分支就是「键即文案」；{0}/{1} 按真实实现回填，用来核对模板与**参数顺序**。
const t = (key, args) => (Array.isArray(args) ? key.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)])) : key);
// 三个格式化函数在 lib/client.js 的 5037–5060，不在抽取范围内；这里按同一语义重述，
// 并把调用参数记录下来 —— 第二个参数（report.generatedAt）传错也能抓到。
const fmtLastCalls = [];
const ctxBase = () => ({
  t,
  h,
  Spark: (props) => ({ type: "Spark", props }),
  fmtInt: (n) => (typeof n === "number" ? n.toLocaleString("en-US") : "—"),
  fmtTax: (n) => (typeof n === "number" && n > 0 ? "~" + n.toLocaleString("en-US") + " tok" : "—"),
  tailorNum: (n, rep) => (rep && rep.zstdSupported === false ? "—" : typeof n === "number" ? n.toLocaleString("en-US") : "—"),
  fmtLast: (ms, now) => {
    fmtLastCalls.push({ ms, now });
    return typeof ms === "number" ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "—";
  },
  days: 30,
});

/** 在 vm 里真跑三段源码，返回界面实际算出来的节点。 */
// 注意末行那个表达式：脚本顶层的 `const` 不会挂到 context 对象上（ctx.decodeIssue 恒
// undefined 的那种坑），只能靠 completion value 把作用域里的绑定取回来。
function render(report, { patchA, patchB } = {}) {
  const ctx = vm.createContext({ ...ctxBase(), report });
  const code = [patchA || SLICE_A, patchB || SLICE_B, SLICE_ROW].join("\n") +
    "\n({ decodeIssue, attribution, hasWireTax, row, wireDaily, wireChanges, wireLatest });";
  return vm.runInContext(code, ctx, { filename: patchA || patchB ? "mutated.js" : "client-tailor-slice.js" });
}

// ── 数据：一次真实扫描的字段（这台机器 30 天窗口实测值），不是编出来的 ─────────
const DAY = 86_400_000;
const now = Date.now();
const realReport = () => ({
  days: 30,
  windowDays: 30,
  generatedAt: now,
  zstdSupported: true,
  nodeVersion: "24.21.0",
  failedFrames: 0,
  failedFiles: 0,
  failedFileSamples: [],
  undatedCalls: 0,
  scannedSpanDays: 13,
  scannedEventsOldestMs: now - 13 * DAY,
  wireTaxDaily: [0, 0, 12501, 0, 123126, 123554, 0, 0, 126151, 0, 0, 0, 125800, 125800],
  wireTaxChangeCount: 5,
  wireTaxTruncated: false,
  wireTaxLatest: { atMs: now - 2 * 3_600_000, tokens: 125800, toolCount: 234 },
  wireTaxSnapshots: [],
  taxTotalTokens: 125800,
  deadMcpTaxTokens: 108921,
  deadMcpCount: 0,
  totalCalls: 6542,
  totalErrors: 0,
  toolCount: 234,
  dailyCalls: [220, 6018, 304],
  tools: [],
});

// ── 1. 正常态：跨度覆盖不足窗口 → 归因**必须**出声；其余两块保持静默 ───────────
{
  const r = render(realReport());
  ok("正常报告不渲染告警块（无解码失败、无 undated、未截断）", r.decodeIssue === null, `实际=${r.decodeIssue === null ? "null" : flat(r.decodeIssue).slice(0, 40)}`);
  ok("真实下发税行出现了（字段名读对了才有这行）", r.hasWireTax === true);
  ok("wireDaily 就是账本给的逐日数组（不是空数组兜底出来的假静默）", r.wireDaily.length === 14 && r.wireDaily[12] === 125800, `len=${r.wireDaily.length}`);
  const rowText = flat(r.row);
  ok("第二行报出「清单变化 5 次」", rowText.includes("每轮下发清单变化 5 次"), rowText);
  ok("第二行报出最近一次下发的规模与时间", rowText.includes("最近一次 234 个工具 ~125,800 tok"), rowText);
  ok("趋势线拿到的是真实下发序列", (() => {
    // 注意：这里的 h 只记录、不调用组件（Spark 是函数，不是字符串 'Spark'），
    // 所以认 props.series 而不是认 type 名字。
    const spark = r.row.children.find((c) => c && c.props && Array.isArray(c.props.series));
    return Boolean(spark) && spark.props.series === r.wireDaily;
  })(), JSON.stringify(r.row.children.map((c) => Object.keys(c.props || {}))));
  const note = flat(r.attribution);
  ok("窗口 30 天 / 数据只跨 13 天 → 归因出声（本次排查的核心症状）", note.includes("窗口 30 天，但读到的调用记录只跨 13 天"), note);
  ok("归因把「最早一条」的具体时间印了出来，不是只说一句空话", /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(note) && note.includes("加长窗口不会改变任何数字"), note);
  ok("归因块用的是 note 样式而不是 warn（不是故障，是解释）", classes(r.attribution) === "dsh-mcp-tailor-note", classes(r.attribution));
  ok("时间换算取的是报告生成时刻，不是浏览器时钟", fmtLastCalls.length > 0 && fmtLastCalls.every((c) => c.now === now), JSON.stringify(fmtLastCalls[0] || {}));
}

// ── 2. 差额：改了没生效 / 作用域不一致，两个方向各说一句话 ───────────────────
// 阈值是「>500 tok 且 >5%」的**较大者**，所以这里的差额必须按 taxTotalTokens 的量级放大到
// 6,500 以上才会出声（13 万 tok 的 5% 就是 6,500）——第一次写这份夹具时给了 4,200，断言
// 当场没渲染，正是这条阈值在起作用，不是渲染逻辑坏了。
{
  const big = realReport();
  big.scannedSpanDays = 30; // 关掉跨度那条，单独看差额分支
  big.taxTotalTokens = 130000;
  big.wireTaxDivergenceTokens = 9000; // 注册表比线上大 → 改了没生效
  const up = flat(render(big).attribution);
  ok("注册表 > 线上时说的是「改了没生效」这一句", up.includes("注册表快照比最近一次真实下发多 ~9,000 tok"), up);
  const down = realReport();
  down.scannedSpanDays = 30;
  down.taxTotalTokens = 121000;
  down.wireTaxDivergenceTokens = -9000;
  const dn = flat(render(down).attribution);
  ok("线上 > 注册表时改口说「作用域不一致」，且数字取绝对值", dn.includes("最近一次真实下发比注册表快照多 ~9,000 tok"), dn);
  ok("负差额不会印成「-9,000 tok」这种看不出方向的串", !dn.includes("-9,000"), dn);
  // 6,000 tok 落在 13 万的 5%（6,500）以内：绝对值够大但相对占比小，仍属正常口径噪声。
  const mid = realReport();
  mid.scannedSpanDays = 30;
  mid.taxTotalTokens = 130000;
  mid.wireTaxDivergenceTokens = 6000;
  ok("差额 6,000 tok（>500 但 <5%）→ 仍不渲染，证明取的是两者较大者", render(mid).attribution === null);
  // 阈值：几十 tok 的口径噪声必须被吞掉，否则这条归因常驻，真告警就教不成东西了。
  const noise = realReport();
  noise.scannedSpanDays = 30;
  noise.taxTotalTokens = 125800;
  noise.wireTaxDivergenceTokens = 400;
  ok("差额 400 tok（<500 且 <5%）→ 归因整块不渲染", render(noise).attribution === null, flat(render(noise).attribution));
  const nullDiv = realReport();
  nullDiv.scannedSpanDays = 30;
  nullDiv.wireTaxDivergenceTokens = null; // 没有真实下发记录：null ≠ 0
  ok("差额为 null 时不渲染（「不知道」不当成「差 0」报警）", render(nullDiv).attribution === null);
  const noReg = realReport();
  noReg.scannedSpanDays = 30;
  noReg.taxTotalTokens = 0;
  noReg.wireTaxDivergenceTokens = -125800;
  ok("注册表税为 0（离线/未取到 Schema）时不拿线上数字吓人", render(noReg).attribution === null);
}

// ── 3. 两条「显形」告警：undated 与截断，都必须进同一个 warn 块 ───────────────
{
  const undated = realReport();
  undated.undatedCalls = 7;
  const uw = flat(render(undated).decodeIssue);
  ok("undatedCalls 非 0 → 告警块出现并说清「切窗口对这部分不生效」", uw.includes("7 条调用事件没有可用的 time 字段"), uw.slice(0, 60));
  ok("undated 归因与跨度归因同时存在（两条都出声）", classes(render(undated).attribution) === "dsh-mcp-tailor-note");
  const trunc = realReport();
  trunc.wireTaxTruncated = true;
  const tw = flat(render(trunc).decodeIssue);
  ok("指纹表截断 → 明说趋势线只覆盖前若干种", tw.includes("真实下发清单的种类数超过上限"), tw.slice(0, 60));
}

// ── 4. 没有真实下发数据时整行让位（新日志/新机器不能画一条假趋势线） ──────────
{
  const empty = realReport();
  empty.wireTaxDaily = [];
  const e = render(empty);
  ok("wireTaxDaily 缺失/空 → 第二行不渲染", e.hasWireTax === false && e.row === null);
  const zeros = realReport();
  zeros.wireTaxDaily = [0, 0, 0];
  const z = render(zeros);
  ok("全 0 序列同样不渲染（画一排等高灰条比不画更误导）", z.hasWireTax === false);
}

// ── 5. 反向自测：护栏必须真的能变红 ──────────────────────────────────────────
{
  // ① 把界面读的字段名改错一个字母：真实宿主里 $any 信封不会报错，只会静默不渲染。
  const typo = SLICE_B.replace("report.wireTaxDaily", "report.wireTaxDailyX");
  ok("反向自测前提：这一行确实被改掉了", typo !== SLICE_B);
  ok("字段名改错 → hasWireTax 变 false（本套件的字段接线断言因此有牙齿）", render(realReport(), { patchB: typo }).hasWireTax === false);
  // ② 把差额阈值改成 0：噪声级差额也会常驻报警，第 2 节那条静默断言必须变红。
  const loose = SLICE_A.replace("Math.max(500, report.taxTotalTokens * 0.05)", "0");
  ok("反向自测前提：阈值确实被替换掉了", loose !== SLICE_A);
  const noisy = { ...realReport(), scannedSpanDays: 30, wireTaxDivergenceTokens: 400 };
  ok("阈值未被改动时同一份报告是静默的（对照）", render(noisy).attribution === null);
  ok("阈值退化为 0 → 400 tok 噪声也报警（说明「不渲染」那条断言不是空跑）", render(noisy, { patchA: loose }).attribution !== null);
}

console.log(`\n${failures === 0 ? "TAILOR-TAX-UI PASS" : `TAILOR-TAX-UI FAIL（${failures} 项）`}`);
if (failures) process.exit(1);
