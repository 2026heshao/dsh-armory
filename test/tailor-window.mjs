// test/tailor-window.mjs
//
// 护栏对象：清单 4.1「工具裁缝时间窗新增『今日』档」。
//
// 背景：本轮在 TAILOR_WINDOWS 里加了一档 `days: 1`（今日），回答「刚配置完它到底被调了
// 几次」。这条改动有两个容易踩的坑，本套件就钉这两点：
//   1. 加档必须真的加进数组且有对应译文 —— 只改 UI 文案不改 days 会让「今日」查出 30 天数据；
//   2. 默认窗口必须**仍是 30 天** —— 顺手改成今日会让报告数字突然变得很难看，
//      用户会以为工具坏了。这条是本次优化最危险的副作用。
//
// 策略：真跑。TAILOR_WINDOWS 只依赖 `t()`，而 `t` 与 `I18N_LOCALE` 都在 i18n 骨架一节里。
// 于是「i18n 骨架切片 + TAILOR_WINDOWS 切片」拼起来丢进 vm 就能拿到真实数组，
// 比正则匹配数组字面量稳得多（能真验证 label 是 t() 的输出、days 是数字类型）。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 仓库路径含中文，必须走 fileURLToPath —— URL.pathname 会把中文百分号编码。
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "..", "lib", "client.js");

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
const lineOf = (text, at) => text.slice(0, at).split("\n").length;

const source = readFileSync(CLIENT, "utf8");

// ── 0. 抽两段源码：i18n 骨架（提供 t / I18N_LOCALE）+ TAILOR_WINDOWS 定义 ────
const SKELETON_START = "// ── OPT-11：i18n 骨架";
const SKELETON_END = "// ── 旧插件名 → 新插件名的 localStorage 键迁移";
const skelAt = source.indexOf(SKELETON_START);
const skelEnd = source.indexOf(SKELETON_END, skelAt + SKELETON_START.length);
ok("能定位 i18n 骨架一节（为 TAILOR_WINDOWS 的 t() 提供宿主）",
  skelAt >= 0 && skelEnd > skelAt, `start=${skelAt} end=${skelEnd}`);

const ARRAY_START = "const TAILOR_WINDOWS = [";
const arrAt = source.indexOf(ARRAY_START);
ok("lib/client.js 里定义了 TAILOR_WINDOWS 数组", arrAt >= 0,
  arrAt >= 0 ? `client.js:${lineOf(source, arrAt)}` : "未找到");

if (skelAt < 0 || skelEnd <= skelAt || arrAt < 0) {
  console.log("\nTAILOR-WINDOW FAIL（源码切片定位失败，无法继续）");
  process.exit(1);
}

// 从 `[` 开始配平，取到数组结束的 `];`（跳过字符串里的括号）。
function arrayBlockRange(text, at) {
  let i = text.indexOf("[", at);
  if (i < 0) return null;
  const start = i;
  let depth = 0;
  let inS = false;
  let inD = false;
  let inT = false;
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (inS) { if (c === "\\") i += 1; else if (c === "'") inS = false; continue; }
    if (inD) { if (c === "\\") i += 1; else if (c === '"') inD = false; continue; }
    if (inT) { if (c === "\\") i += 1; else if (c === "`") inT = false; continue; }
    if (c === "'") { inS = true; continue; }
    if (c === '"') { inD = true; continue; }
    if (c === "`") { inT = true; continue; }
    if (c === "[") depth += 1;
    else if (c === "]") { depth -= 1; if (depth === 0) return [start, i + 1]; }
  }
  return null;
}

const arrRange = arrayBlockRange(source, arrAt);
ok("能配平取到 TAILOR_WINDOWS 的数组字面量区间", !!arrRange,
  arrRange ? `区间=${arrRange[0]}..${arrRange[1]}` : "");
if (!arrRange) {
  console.log("\nTAILOR-WINDOW FAIL（数组区间配平失败）");
  process.exit(1);
}

const skeletonSource = source.slice(skelAt, skelEnd);
const arraySource = source.slice(arrRange[0], arrRange[1]);

/** 在指定 locale 下真跑，返回 TAILOR_WINDOWS 的真实数组。 */
function runWindows(locale) {
  const storage = new Proxy(
    { getItem: (k) => (k === "dsh-armory.locale" ? locale : null) },
    { get: (target, prop) => (typeof prop === "string" && !(prop in target) ? (prop === "dsh-armory.locale" ? locale : null) : target[prop]) },
  );
  const context = { console, localStorage: storage };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    skeletonSource + `\nconst TAILOR_WINDOWS = ${arraySource};\nglobalThis.__probe = { TAILOR_WINDOWS, I18N_LOCALE, t };`,
    context,
    { filename: "tailor-window.js" },
  );
  return context.__probe;
}

let probeZh;
try {
  probeZh = runWindows("zh-CN");
  ok("能在 vm 里真跑出 TAILOR_WINDOWS（不是静态文本匹配）", Array.isArray(probeZh.TAILOR_WINDOWS));
} catch (error) {
  ok("能在 vm 里真跑出 TAILOR_WINDOWS", false, String(error && error.message));
  console.log("\nTAILOR-WINDOW FAIL（vm 执行失败）");
  process.exit(1);
}

const WINDOWS = probeZh.TAILOR_WINDOWS;

// ── 1. 四档齐全，且「今日」排首位 ───────────────────────────────────────────
ok("TAILOR_WINDOWS 恰好 4 档（今日 / 近 7 天 / 近 30 天 / 近 90 天）",
  WINDOWS.length === 4, `实际=${WINDOWS.length}`);
ok("四档的 key 依次是 '1' / '7' / '30' / '90'",
  JSON.stringify(WINDOWS.map((w) => w.key)) === JSON.stringify(["1", "7", "30", "90"]),
  `实际=${JSON.stringify(WINDOWS.map((w) => w.key))}`);
ok("四档的 days 依次是 1 / 7 / 30 / 90（数字类型，不是字符串）",
  JSON.stringify(WINDOWS.map((w) => w.days)) === JSON.stringify([1, 7, 30, 90]) &&
    WINDOWS.every((w) => typeof w.days === "number"),
  `实际=${JSON.stringify(WINDOWS.map((w) => w.days))} 类型=${JSON.stringify(WINDOWS.map((w) => typeof w.days))}`);

// 本轮新增的那一档：首位、key='1'、days=1、label=t('今日')。
ok("本轮新增的「今日」档排在数组首位（最短窗口放最前，符合递增顺序）",
  WINDOWS[0] && WINDOWS[0].key === "1" && WINDOWS[0].days === 1,
  `首档=${JSON.stringify(WINDOWS[0] && { key: WINDOWS[0].key, days: WINDOWS[0].days })}`);

// days 必须严格递增：顺序错了 UI 上的档位排列就会反直觉。
const ascending = WINDOWS.every((w, i) => i === 0 || w.days > WINDOWS[i - 1].days);
ok("days 严格递增（1 < 7 < 30 < 90，档位排序不乱）", ascending,
  `实际=${JSON.stringify(WINDOWS.map((w) => w.days))}`);

// key 必须等于 days 的字符串形式 —— 否则 `Number(windowKey)` 会算出错的天数。
const keyMatchesDays = WINDOWS.every((w) => String(w.days) === String(w.key));
ok("每档的 key 与 days 一致（key 就是天数，Number(windowKey) 才能直接用）", keyMatchesDays,
  `实际=${JSON.stringify(WINDOWS.map((w) => `${w.key}/${w.days}`))}`);

// ── 2. 每档 label 都是 t() 的输出，且中文环境下非空 ──────────────────────────
ok("每档 label 都是非空字符串（t() 真的返回了文案，不是 undefined）",
  WINDOWS.every((w) => typeof w.label === "string" && w.label.length > 0),
  `实际=${JSON.stringify(WINDOWS.map((w) => w.label))}`);
ok("中文环境下「今日」档的 label 是「今日」",
  WINDOWS[0].label === "今日", `实际=${JSON.stringify(WINDOWS[0] && WINDOWS[0].label)}`);

// 英文环境下同一份源必须出英文 —— 证明 label 真的走了 t()，不是硬编码中文串。
const probeEn = runWindows("en-US");
ok("英文环境下「今日」档的 label 被翻译成 Today（label 确实走 t()）",
  probeEn.TAILOR_WINDOWS[0].label === "Today",
  `实际=${JSON.stringify(probeEn.TAILOR_WINDOWS[0].label)}`);
ok("英文环境下四档 label 全变英文（没有一档漏译）",
  probeEn.TAILOR_WINDOWS.every((w) => !/[\u4e00-\u9fff]/.test(w.label)),
  `实际=${JSON.stringify(probeEn.TAILOR_WINDOWS.map((w) => w.label))}`);

// ── 3. 默认窗口必须仍是 '30'（本优化最危险的副作用）────────────────────────
// 加「今日」档时若顺手把默认改成 '1'，用户打开面板看到的调用次数会从三位数掉到个位数，
// 第一反应是「数据丢了」。这条断言就是拦这个。
const DEFAULT_RE = /const\s+\[\s*windowKey\s*,\s*setWindowKey\s*\]\s*=\s*useState\(\s*'(\d+)'\s*\)/;
const defaultMatch = DEFAULT_RE.exec(source);
ok("能找到 windowKey 的 useState 初值", !!defaultMatch,
  defaultMatch ? `client.js:${lineOf(source, defaultMatch.index)}` : "未找到");
ok("默认选中窗口仍是 '30'（加今日档不能顺手把默认改成今日）",
  defaultMatch ? defaultMatch[1] === "30" : false,
  defaultMatch ? `得到='${defaultMatch[1]}'` : "");
ok("默认窗口 '30' 确实在 TAILOR_WINDOWS 里（否则选中态高亮不到任何档位）",
  WINDOWS.some((w) => w.key === "30"), `keys=${JSON.stringify(WINDOWS.map((w) => w.key))}`);

// 请求天数由 windowKey 推导，兜底也必须是 30 —— 空/脏值时不能突然变成「全部历史」。
const DAYS_RE = /const\s+days\s*=\s*Number\(\s*windowKey\s*\)\s*\|\|\s*(\d+)\s*;/;
const daysMatch = DAYS_RE.exec(source);
ok("请求天数由 Number(windowKey) 推导，兜底值仍是 30",
  !!daysMatch && daysMatch[1] === "30",
  daysMatch ? `client.js:${lineOf(source, daysMatch.index)} 兜底=${daysMatch[1]}` : "未找到");

// 选中态比较两侧都必须是 key（字符串），不能拿 days 数字去比 key 字符串。
ok("档位高亮用 windowKey === w.key 比较（key 对 key，不是 key 对 days）",
  /windowKey\s*===\s*w\.key/.test(source), "");

// ── 4. 反向自测：证明上面的断言不是恒真 ────────────────────────────────────
{
  // 把「今日」档的 days 改成 30（加档加错数据的典型 bug），第 1 节必须抓到。
  const brokenArray = arraySource.replace(/\{\s*key:\s*'1',\s*label:\s*t\('今日'\),\s*days:\s*1\s*\}/, "{ key: '1', label: t('今日'), days: 30 }");
  ok("自测前置：成功改坏了「今日」档的 days", brokenArray !== arraySource);
  if (brokenArray !== arraySource) {
    const context = { console, localStorage: { "dsh-armory.locale": "zh-CN" } };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(skeletonSource + `\nconst TAILOR_WINDOWS = ${brokenArray};\nglobalThis.__probe = { TAILOR_WINDOWS };`, context, { filename: "tailor-window-broken.js" });
    const broken = context.__probe.TAILOR_WINDOWS;
    const stillAscending = broken.every((w, i) => i === 0 || w.days > broken[i - 1].days);
    ok("自测：今日档 days 改成 30 后，「严格递增」断言确实会失败", !stillAscending,
      `实际 days=${JSON.stringify(broken.map((w) => w.days))}`);
  }
}
{
  // 把默认值改成 '1'，第 3 节必须抓到。
  const brokenDefault = source.replace(
    /const\s+\[\s*windowKey\s*,\s*setWindowKey\s*\]\s*=\s*useState\(\s*'30'\s*\)/,
    "const [windowKey, setWindowKey] = useState('1')",
  );
  const brokenMatch = DEFAULT_RE.exec(brokenDefault);
  ok("自测：默认值改成 '1' 后，「默认仍是 30」断言确实会失败",
    brokenDefault !== source && !!brokenMatch && brokenMatch[1] !== "30",
    brokenMatch ? `得到='${brokenMatch[1]}'` : "");
}

info("TAILOR_WINDOWS 实测", JSON.stringify(WINDOWS));
console.log(`\n${failures === 0 ? "TAILOR-WINDOW PASS" : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
