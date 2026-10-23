// test/tailor-cache-line.mjs
//
// 护栏对象：工具裁缝「清空缓存」按钮**被删掉**这件事本身（2026-10-23）。
//
// 为什么要钉一个「不存在」：那条动作链不是坏在某处，而是**每一环都各自静默失效**——
//   · 宿主 lib/index.js 的 toolTailor 分支把 `clearTextCache()` 的返回值丢了，报告里的
//     `textCache` 来自 `textCacheStats()`，根本没有 `clearedBytes` 这个键；于是面板的成功分支
//     只能落到兜底文案，点完永远显示「正在清空缓存…」，看着像还在忙；
//   · 「先清后扫」的快照取在扫描**之后**，同一发调用里 92 个日志被重新解压回填，实测按下前后
//     都是 32 条 / 65.8 MB —— 占用一位都不降；
//   · 而在这台机器上缓存本来就没生效：槽位 32、日志 92 个、按插入序淘汰，命中率 0%
//     （冷扫 1797ms / 热扫 1881ms）。
// 结论是它既不回收内存也不修任何东西，整条链删掉。但「删掉」只留一段注释是不够的：下一个
// 人「顺手补个清空按钮回来」就会原样重新引入上面三个 bug。所以这里分两层守——
//   1. 界面层：把 cacheLine 切片抽进 vm **真跑**，断言产出的节点树里没有 button、没有 onClick、
//      没有合成分 utilization；同时读数本身还得在（别把只读那行一起删过头）；
//   2. 接线层：client.js 不再向 toolTailor 发 action、不再有 clearing 状态、不再有那三把 i18n
//      键；lib/index.js 不再从 tool-ledger.js 引入 clearTextCache —— 没 import 就结构上不可能调用。
// 判定口径注意：**注释里合法地留着删除理由**（含 `clearTextCache()`、「正在清空缓存…」这些字），
// 所以第 3 节只钉可执行的写法（调用形态 / 钩子名 / 类名 / 字典键 / import 规格符），
// 不去搜裸函数名 —— 搜裸名会让这条护栏因为「有人把为什么删讲清楚了」而变红，那是反激励。
// 另：tool-ledger.js 仍导出 `clearTextCache` 原语（真要改缓存策略时它是落点），本套件**不**钉
// 它的存在，也不钉它的不存在。
//
// 只用 node: 内置模块。用法：node ./test/tailor-cache-line.mjs

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 仓库路径含中文，必须走 fileURLToPath —— URL.pathname 会把中文百分号编码。
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "..", "lib", "client.js");
const INDEX = join(HERE, "..", "lib", "index.js");

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};
const info = (name, extra = "") => console.log(`INFO  ${name}${extra ? `  ${extra}` : ""}`);

const client = await readFile(CLIENT, "utf8");
const host = await readFile(INDEX, "utf8");

/** 按起止标记抽一段源码；标记缺失或不唯一直接失败（有人改名/搬走却没同步本测试会立刻暴露）。 */
function slice(label, startMarker, endMarker, text = client) {
  const first = text.indexOf(startMarker);
  if (first < 0 || text.indexOf(startMarker, first + 1) >= 0) {
    ok(`定位标记唯一：${label}`, false, `start="${startMarker}" first=${first}`);
    return null;
  }
  const end = text.indexOf(endMarker, first + startMarker.length);
  if (end < 0) {
    ok(`定位标记存在：${label} 的结束标记`, false, `end="${endMarker}"`);
    return null;
  }
  ok(`定位标记唯一：${label}`, true);
  return text.slice(first, end);
}

// 两个换算函数都**取原文**而不是在测试里重述：读数「65.8 MB / 100%」是它们算出来的，
// 测试端另写一套换算，界面改了换算护栏就抓不到。
const FMT_BYTES = slice("fmtBytes 定义（读数字节的换算真身）", "const fmtBytes = (n) => {", "const fmtPct =");
const FMT_PCT = slice("fmtPct 定义（合成分 utilization 的换算真身）", "const fmtPct = (n) =>", "const fmtTax =");
const CACHE_LINE = slice("cacheLine（账本缓存读数行）", "const cacheLine = report && report.textCache", "  const tools = report && Array.isArray(report.tools)");
if (!FMT_BYTES || !FMT_PCT || !CACHE_LINE) {
  console.log("\nTAILOR-CACHE-LINE FAIL（标记缺失，无法抽取待测源码）");
  process.exit(1);
}

// ── 替身：只替外部依赖，渲染逻辑与模板一律用 lib/client.js 原文 ────────────────
const h = (type, props, ...children) => ({
  type,
  props: props || {},
  children: children.flat(2).filter((c) => c !== null && c !== undefined && c !== false),
});
const flatText = (node) => {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatText).join("");
  return flatText(node.children);
};
const walk = (node, out = []) => {
  if (node && typeof node === "object" && "type" in node) {
    out.push(node);
    for (const child of node.children || []) walk(child, out);
  }
  return out;
};
// t 的中文分支就是「键即文案」——正好用来证明这行出现的每段中文都真的走了 t()。
const t = (key, args) => (Array.isArray(args) ? key.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)])) : key);

/** 在 vm 里真跑切片，返回界面实际算出来的 cacheLine。`patch` 只用于反向自测。 */
function render(textCache, patch = null) {
  const ctx = vm.createContext({ h, t, I18N_LOCALE: "zh-CN", report: { textCache } });
  // 末行那个表达式：脚本顶层的 `const` 不会挂到 context 对象上（ctx.cacheLine 恒 undefined
  // 的那种坑），只能靠 completion value 把作用域里的绑定取回来。
  const code = `${FMT_BYTES}\n${FMT_PCT}\n${patch || CACHE_LINE}\n({ cacheLine });`;
  return vm.runInContext(code, ctx, { filename: patch ? "mutated.js" : "client-cache-line.js" });
}

// 这台机器一次真实扫描的快照（32 条 / 68,948,647 B / utilization 恒 1），不是编出来的。
const REAL_CACHE = { entries: 32, bytes: 68_948_647, maxEntries: 32, maxBytes: 134_217_728, utilization: 1, oldestStamp: null, newestStamp: null };

// ── 1. 只读读数行还活着，而且真的只剩读数 ───────────────────────────────────
const { cacheLine } = render(REAL_CACHE);
ok("有 textCache 快照时读数行仍然渲染（删按钮不能把读数一起删掉）", !!cacheLine && cacheLine.type === "div",
  `实际=${JSON.stringify(cacheLine && { type: cacheLine.type, className: cacheLine.props.className })}`);
ok("该行仍是 .dsh-mcp-tailor-cache（样式挂钩没变）", cacheLine && cacheLine.props.className === "dsh-mcp-tailor-cache",
  `实际=${JSON.stringify(cacheLine && cacheLine.props.className)}`);
const nodes = walk(cacheLine);
ok("整棵子树里没有 button —— 「清空缓存」按钮不得复活",
  !nodes.some((n) => n.type === "button"), `节点=${JSON.stringify(nodes.map((n) => n.type))}`);
ok("整棵子树里没有 onClick —— 这一行不再有任何动作",
  !nodes.some((n) => n.props && n.props.onClick),
  `带 onClick 的节点=${JSON.stringify(nodes.filter((n) => n.props && n.props.onClick).map((n) => n.type))}`);
ok("子节点恰好 2 个（标签 + 读数），没有第三种东西混进来",
  cacheLine && cacheLine.children.length === 2, `实际=${cacheLine && cacheLine.children.length}`);

const lineText = flatText(cacheLine);
ok("读数原文正确：65.8 MB · 32/32 条（换算取的是 lib 里的 fmtBytes 原文）",
  lineText === "账本缓存65.8 MB · 32/32 条", `实际=${JSON.stringify(lineText)}`);
ok("标签来自 t('账本缓存')（中文键仍在字典里，没被顺手删掉）",
  /账本缓存/.test(lineText) && /t\('账本缓存'\)/.test(CACHE_LINE));
// 合成分 utilization = max(字节占比, 条数占比)，本机恒 1 → 上屏永远 100%；它原本唯一的用处
// 就是把用户推向这个已经不存在的按钮，所以一并删。
ok("整行不出现百分号（合成分 utilization 已从界面去掉）", !/%/.test(lineText), `实际=${JSON.stringify(lineText)}`);
ok("界面不再读 cache.utilization（只留 bytes / entries / maxEntries）",
  !/utilization/.test(CACHE_LINE) && !/fmtPct/.test(CACHE_LINE), "");

// ── 2. 快照缺省或脏值时整行不渲染（旧宿主的报告根本没有 textCache）────────────
ok("report 没有 textCache → 整行 null（旧宿主不能出现空读数）", render(undefined).cacheLine === null);
ok("textCache 为 null → 整行 null", render(null).cacheLine === null);
ok("entries 不是数字（脏值/字段改名）→ 整行 null，而不是渲染出「—/— 条」这种假读数",
  render({ ...REAL_CACHE, entries: "32" }).cacheLine === null &&
    render({ ...REAL_CACHE, entries: undefined }).cacheLine === null);

// ── 3. 接线层：动作链的每一环都必须是空的 ───────────────────────────────────
const forbidden = [
  ["面板不再向 toolTailor 发任何 action（动作只能走这条 RPC）", /action\s*:\s*['"]clearTextCache|call\(\s*'toolTailor'\s*,\s*\{\s*action/],
  ["不再有 clearing 状态", /const\s*\[\s*clearing\s*,|setClearing\s*\(/],
  ["不再有 clearCache 处理函数", /const\s+clearCache\s*=/],
  ["清空按钮的类名彻底消失（样式与 JS 都不留）", /dsh-mcp-tailor-cache-clear/],
  ["不再引用那三把文案键", /t\(\s*'清空缓存|t\(\s*'正在清空缓存|t\(\s*'已清空缓存/],
];
for (const [label, re] of forbidden) {
  const hit = re.exec(client);
  ok(`client.js：${label}`, !hit, hit ? `命中 ${JSON.stringify(hit[0])}` : "无匹配");
}
for (const key of ['"清空缓存":', '"正在清空缓存…":', '"已清空缓存，释放 {0}":']) {
  ok(`client.js：EN_US_MESSAGES 里那把键已删 ${key}`, !client.includes(key));
}
// 反向保险：只读那行不该被删过头 —— CSS 规则与字典键都还得在。
ok("client.js：.dsh-mcp-tailor-cache 与 -label 两条样式规则仍在（读数行还要有皮）",
  /\.dsh-mcp-tailor-cache\{/.test(client) && /\.dsh-mcp-tailor-cache-label\{/.test(client));
ok('client.js：字典里 "账本缓存" 与 " 条" 两把键仍在', client.includes('"账本缓存":') && client.includes('" 条":'));

// 宿主侧：没有 import 就不可能被调用，所以钉 import 规格符比搜函数名可靠（注释里会合法出现函数名）。
const LEDGER_IMPORT = /import\s*\{([^}]*)\}\s*from\s*"\.\/tool-ledger\.js"/;
const importMatch = LEDGER_IMPORT.exec(host);
ok("index.js：能从 ./tool-ledger.js 解析出 import 规格符", !!importMatch,
  importMatch ? `规格符=${importMatch[1].trim().replace(/\s+/g, " ")}` : "未找到");
const specifiers = importMatch ? importMatch[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean) : [];
ok("index.js：clearTextCache 不在 tool-ledger 的 import 列表里（没引入 = 结构上不可能调用）",
  !specifiers.includes("clearTextCache"), `实际=${JSON.stringify(specifiers)}`);
ok("index.js：scanSessionLedger 仍然引入（toolTailor 方法本体离不开它）",
  specifiers.includes("scanSessionLedger"), `实际=${JSON.stringify(specifiers)}`);

// toolTailor 方法体：从签名到收尾，中间必须只剩一次只读扫描。
const METHOD_RE = /async toolTailor\(payload\) \{([\s\S]*?)\n\t\t\}/;
const methodMatch = METHOD_RE.exec(host);
ok("index.js：能定位 toolTailor 方法体", !!methodMatch,
  methodMatch ? `体长=${methodMatch[1].length}` : "未找到（方法改名/搬家了，本护栏需要跟进）");
if (methodMatch) {
  const body = methodMatch[1].replace(/\/\/[^\n]*/g, ""); // 去掉注释行，只看语句
  ok("index.js：toolTailor 不再按 payload.action 分支，方法体只剩一句 buildToolTailorReport",
    !/action/i.test(body) && /return buildToolTailorReport\(this\.ctx, payload \|\| \{\}\);/.test(body),
    `体=${JSON.stringify(body.trim())}`);
}

// ── 4. 反向自测：护栏必须真的能变红 ─────────────────────────────────────────
{
  // ① 把旧的按钮写法注回切片。用「第二个 span 那一行行尾」定位插入点：正则匹配整行要跨
  //    多层括号，改一处写法就匹配不上，那种「自测前置失败」等于护栏自己静默失效。
  const anchor = "h('span', null, fmtBytes(cache.bytes)";
  const at = CACHE_LINE.indexOf(anchor);
  const eol = at < 0 ? -1 : CACHE_LINE.indexOf("\n", at);
  ok("自测前置：读数 span 那一行确实找得到", at >= 0 && eol > at);
  const revived = at < 0 || eol < 0 ? null
    : `${CACHE_LINE.slice(0, eol)}\n          h('button', { type: 'button', className: 'dsh-mcp-tailor-cache-clear', onClick: () => {}, disabled: false }, t('清空缓存'))${CACHE_LINE.slice(eol)}`;
  if (revived) {
    const back = render(REAL_CACHE, revived).cacheLine;
    const backNodes = walk(back);
    ok("自测：按钮复活 → 「没有 button」断言确实会失败", backNodes.some((n) => n.type === "button"));
    ok("自测：按钮复活 → 「没有 onClick」断言确实会失败", backNodes.some((n) => n.props && n.props.onClick));
    ok("自测：按钮复活 → 「子节点恰好 2 个」确实会失败", back.children.length === 3, `实际=${back.children.length}`);
    // 再把合成分加回去：% 断言与 utilization 断言必须同时变红。
    const withPct = revived.replace("+ t(' 条')", "+ t(' 条') + ' · ' + fmtPct(cache.utilization)");
    const pctLine = flatText(render(REAL_CACHE, withPct).cacheLine);
    ok("自测：合成分加回去 → 「不出现百分号」确实会失败", /%/.test(pctLine), `实际=${JSON.stringify(pctLine)}`);
    ok("自测：合成分加回去 → 切片里出现 utilization/fmtPct，静态那条确实会失败",
      /utilization/.test(withPct) && /fmtPct/.test(withPct));
  }
}
{
  // ② 把脏值守卫写松：`typeof entries === 'number'` → 只判真值。第 2 节必须抓到。
  const loose = CACHE_LINE.replace("typeof report.textCache.entries === 'number'", "report.textCache");
  ok("自测前置：脏值守卫确实被改松了", loose !== CACHE_LINE);
  ok("自测：守卫改松后脏值（entries 是字符串）也会渲染出一行 → 第 2 节确实会失败",
    loose !== CACHE_LINE && render({ entries: "32", bytes: 68_948_647, maxEntries: 32 }, loose).cacheLine !== null);
}
{
  // ③ 接线层：把 action 调用注回 client.js 副本、把 import 注回 index.js 副本，静态断言必须抓到。
  const wired = client.replace("const cacheLine =", "const clearCache = async () => {\n    await call('toolTailor', { action: 'clearTextCache', days });\n  };\n  const cacheLine =");
  ok("自测：面板重新发 action → forbidden[0] 确实会命中",
    wired !== client && /action\s*:\s*['"]clearTextCache/.test(wired));
  ok("自测：重新出现 clearCache 处理函数 → forbidden[2] 确实会命中",
    /const\s+clearCache\s*=/.test(wired));
  const hostWired = host.replace(LEDGER_IMPORT, (m, spec) =>
    m.replace(spec, spec.replace("scanSessionLedger", "clearTextCache, scanSessionLedger")));
  const rematch = LEDGER_IMPORT.exec(hostWired);
  const respec = rematch ? rematch[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean) : [];
  ok("自测：宿主重新 import clearTextCache → 「不在 import 列表里」确实会失败",
    hostWired !== host && respec.includes("clearTextCache"), `实际=${JSON.stringify(respec)}`);
}

info("读数行实测", JSON.stringify(lineText));
console.log(`\n${failures === 0 ? "TAILOR-CACHE-LINE PASS" : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
