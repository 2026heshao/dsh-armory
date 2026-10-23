// en-US 字典覆盖率与 locale 四级回落的直测（OPT-14 · 1.1 / P1 收口）。
//
// 为什么需要这个套件：`client-i18n.mjs` 只守住「所有中文都包了 t()」，它**不检查字典
// 里到底有没有对应的键**。两者是不同的失败模式：
//   - 漏包 t()  → 界面常年中文，但至少是对的；
//   - 漏了字典键 → 英文用户界面上突然蹦出一句中文（或更糟：蹦出 key 名）。
// 677 个键的字典是手写的，加一条新文案时忘了补 en-US 是必然会犯的错，而且没有任何
// 编译期/运行时信号 —— 只有把「源码里的 t() 字面量集合」与「字典键集合」做双向差集
// 才能守住。
//
// 怎么测的：
//   1. 词法扫描 lib/client.js，收集**全部字符串字面量**（单/双引号、模板静态段），
//      并判定每个中文顶层字面量是否被 t(...) 直接包裹（复用 client-i18n.mjs 的扫描
//      核心，但额外递归进模板插值体 —— 那个文件只扫顶层，插值体里的中文它会漏）。
//   2. 用括号配平抽出 `EN_US_MESSAGES = { ... }` 的**原文**，在 vm 里求值得到真字典。
//      这样字典里 `\n` 之类的转义会和源码侧一样被解码后再比较，不会因写法差异误报。
//   3. 双向差集：漏键（源码有、字典无）+ 孤立键（字典有、源码无）。
//   4. locale 四级优先级：把 `const i18nMessages = {}` 到 `const t = ...` 之间的源码
//      原样抽出来，在 vm 里配不同的 localStorage / 宿主 locale / navigator 组合**真跑**，
//      断言顺序。宿主 locale 是 issue #1 的修复点：中文系统 + DSH 设英文时
//      navigator 仍是 zh-CN，旧实现因此永远不装载英文表。
//
// 反向自测：往源码里注入一条带中文的 t()，覆盖断言必须抓到「漏键」；把 locale 判定
// 的回落顺序改坏，行为断言必须抓到。否则这些断言等于空转。

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
const info = (name, extra = "") => console.log(`INFO  ${name}${extra ? `  ${extra}` : ""}`);

// ── 扫描器（client-i18n.mjs 的核心 + 模板插值体递归）─────────────────────────
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

/**
 * 收集文本里所有字符串字面量。
 *
 * 返回 { start, quote, raw, value, computed }：
 *   raw      —— 引号之间的**原始**源码（含 \n 之类的转义序列，未解码）
 *   value    —— 解码后的真实字符串（模板含 ${} 插值时无法静态求值，给 null）
 *   computed —— 模板里含 ${} 插值，说明它是拼接出来的运行时字符串，不可能是字典键
 *
 * 与 client-i18n.mjs 的差别：这里会递归进模板的 ${...} 插值体。那个文件只扫顶层
 * 静态段，插值体里的中文（`${t('…')}`）它既不算命中也不算遗漏——对「包裹不变式」够用，
 * 对「字典覆盖率」会漏掉真键。
 */
function scanLiterals(text) {
  const n = text.length;
  const out = [];
  const prevSignificant = (at) => {
    let p = at - 1;
    while (p >= 0 && /\s/.test(text[p])) p -= 1;
    return p >= 0 ? text[p] : "";
  };

  function record(start, quote, raw, computed) {
    let value = null;
    if (!computed) {
      try {
        // 用原始引号重建字面量再求值：比手写反斜杠解码可靠（\uXXXX、\xNN、\n 都对）。
        value = vm.runInNewContext((quote + raw + quote).replace(/\r\n/g, "\\n"));
      } catch {
        value = null;
      }
    }
    out.push({ start, quote, raw, value, computed });
  }

  /** 扫描一段表达式；stopOnBrace=true 时在配平的 `}` 处返回（用于 ${...} 内部）。 */
  function scanExpr(from, stopOnBrace) {
    let i = from;
    let braceDepth = 0;
    while (i < n) {
      const c = text[i];
      if (stopOnBrace && c === "}" && braceDepth === 0) return i + 1;
      if (c === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") i += 1; continue; }
      if (c === "/" && text[i + 1] === "*") {
        i += 2;
        while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
        i = Math.min(i + 2, n);
        continue;
      }
      if (c === "/") { // 正则字面量 vs 除号：由前一有效字符判定（与 client-i18n 同口径）。
        const prev = prevSignificant(i);
        if (prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev)) {
          let j = i + 1;
          let inClass = false;
          let closed = false;
          while (j < n) {
            const d = text[j];
            if (d === "\\") { j += 2; continue; }
            if (d === "[") inClass = true;
            else if (d === "]") inClass = false;
            else if (d === "/" && !inClass) { closed = true; break; }
            else if (d === "\n") break;
            j += 1;
          }
          if (closed) {
            i = j + 1;
            while (i < n && /[gimsuyd]/.test(text[i])) i += 1;
            continue;
          }
        }
      }
      if (c === "'" || c === '"') { i = readString(i, c); continue; }
      if (c === "`") { i = readTemplate(i); continue; }
      if (c === "{") { braceDepth += 1; i += 1; continue; }
      if (c === "}") { braceDepth = Math.max(0, braceDepth - 1); i += 1; continue; }
      i += 1;
    }
    return n;
  }

  function readString(i, q) {
    let j = i + 1;
    while (j < n) {
      const d = text[j];
      if (d === "\\") { j += 2; continue; }
      if (d === q || d === "\n") break;
      j += 1;
    }
    record(i, q, text.slice(i + 1, Math.min(j, n)), false);
    return Math.min(j + 1, n);
  }

  function readTemplate(i) {
    let j = i + 1;
    let computed = false;
    const statics = [];
    let segStart = i + 1;
    while (j < n) {
      const d = text[j];
      if (d === "\\") { j += 2; continue; }
      if (d === "`") break;
      if (d === "$" && text[j + 1] === "{") {
        computed = true;
        statics.push([segStart, j]);
        j = scanExpr(j + 2, true);
        segStart = j;
        continue;
      }
      j += 1;
    }
    const close = Math.min(j, n);
    if (!computed) {
      record(i, "`", text.slice(i + 1, close), false);
    } else {
      // 含插值的模板：value 不可静态求值。但仍然记录，因为它的静态段里若有中文，
      // 说明这句文案永远拿不到译文（不是字典能解决的问题，单独报告）。
      const staticText = statics.map(([s, e]) => text.slice(s, e)).join("") + text.slice(segStart, close);
      out.push({ start: i, quote: "`", raw: text.slice(i + 1, close), value: null, computed: true, staticText });
    }
    return Math.min(close + 1, n);
  }

  scanExpr(0, false);
  return out;
}

/** 判定某字面量是否被 `t(` 直接包裹（不是 `cat(`、`fmt(` 之类以 t 结尾的标识符）。 */
function isWrappedByT(text, start) {
  let p = start - 1;
  while (p >= 0 && /\s/.test(text[p])) p -= 1;
  if (p < 0 || text[p] !== "(") return false;
  p -= 1;
  while (p >= 0 && /\s/.test(text[p])) p -= 1;
  if (p < 0 || text[p] !== "t") return false;
  const before = p - 1 < 0 ? "" : text[p - 1];
  return !/[A-Za-z0-9_$.]/.test(before);
}

/** `setI18nMessages(...)` 第一个实参的区间：那里面是查表键，不是展示文案。 */
function callArgRanges(text) {
  const ranges = [];
  let from = 0;
  for (;;) {
    const m = text.indexOf("setI18nMessages", from);
    if (m < 0) break;
    from = m + "setI18nMessages".length;
    let open = from;
    while (open < text.length && /\s/.test(text[open])) open += 1;
    if (text[open] !== "(") continue;
    let depth = 0;
    let i = open;
    let inLine = false;
    let inBlock = false;
    let inSq = false;
    let inDq = false;
    let inTpl = false;
    let tplDepth = 0;
    while (i < text.length) {
      const c = text[i];
      if (inLine) { if (c === "\n") inLine = false; }
      else if (inBlock) { if (c === "*" && text[i + 1] === "/") { inBlock = false; i += 1; } }
      else if (inSq || inDq) {
        if (c === "\\") i += 1;
        else if (inSq && c === "'") inSq = false;
        else if (inDq && c === '"') inDq = false;
      } else if (inTpl) {
        if (c === "\\") i += 1;
        else if (c === "`" && tplDepth === 0) inTpl = false;
        else if (c === "$" && text[i + 1] === "{") { tplDepth += 1; i += 1; }
        else if (c === "}" && tplDepth > 0) tplDepth -= 1;
      } else if (c === "/" && text[i + 1] === "/") inLine = true;
      else if (c === "/" && text[i + 1] === "*") { inBlock = true; i += 1; }
      else if (c === "'") inSq = true;
      else if (c === '"') inDq = true;
      else if (c === "`") inTpl = true;
      else if (c === "(") depth += 1;
      else if (c === ")") { depth -= 1; if (depth === 0) { i += 1; break; } }
      i += 1;
    }
    ranges.push([open, i]);
  }
  return ranges;
}

/** `const EN_US_MESSAGES = { ... }` 的花括号配平区间（跳过字符串里的括号）。 */
function objectBlockRange(text, marker) {
  const at = text.indexOf(marker);
  if (at < 0) return null;
  let i = text.indexOf("{", at);
  if (i < 0) return null;
  const start = i;
  let depth = 0;
  let inS = false;
  let inD = false;
  for (; i < text.length; i += 1) {
    const c = text[i];
    if (inS) { if (c === "\\") i += 1; else if (c === "'") inS = false; continue; }
    if (inD) { if (c === "\\") i += 1; else if (c === '"') inD = false; continue; }
    if (c === "'") { inS = true; continue; }
    if (c === '"') { inD = true; continue; }
    if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) return [start, i + 1]; }
  }
  return null;
}

// ── 0. 读源码 ────────────────────────────────────────────────────────────────
const source = await readFile(CLIENT, "utf8");
const dictRange = objectBlockRange(source, "const EN_US_MESSAGES = {");
ok("能在 lib/client.js 里定位到 EN_US_MESSAGES 对象字面量", !!dictRange, dictRange ? `区间=${dictRange[0]}..${dictRange[1]}` : "");
if (!dictRange) {
  console.log("\nI18N-COVERAGE FAIL（找不到字典，无法继续）");
  process.exit(1);
}
const DICT = vm.runInNewContext("(" + source.slice(dictRange[0], dictRange[1]) + ")");
const DICT_KEYS = Object.keys(DICT);

// ── 已知缺口（基线快照）────────────────────────────────────────────────────
// 本套件的第一要义是**防新增**，不是把历史欠账一次性清零 —— 清零会把 run-all 弄红，
// 而红着的主干测试很快就没人看了。所以下面两组「已知缺口」被显式记录成一个只许收缩的
// 集合：集合内部的条目允许存在，但**任何新条目立刻失败**。
//
// 这两组条目已作为源码侧问题回报给工程师（见本次交付报告）。工程师修掉以后，对应断言
// 依然通过（集合是超集判定），只需把条目从下面删掉即可收紧护栏。
//
// KNOWN_MISSING_KEYS：源码里 t() 包了中文，但 en-US 字典缺这个键 —— 英文界面上会
// 突然蹦出中文。逐条根因见报告。
//
// 注意：下面注释里的行号会随 client.js 演进而漂移（该文件正在被并行改写），所以每条都
// 附了一句可搜索的**锚点文案**——按锚点找，不要信行号。
const KNOWN_MISSING_KEYS = new Set([
  // 锚点 "npx 或 C:" ——源码是 t('…C:\\path\\to\\bin.exe')（解码为单反斜杠），字典键写成了
  // "…C:\\\\path\\\\to\\bin.exe"（解码为双反斜杠）—— 手写转义多了一层，永远查不到。
  "npx 或 C:\\path\\to\\bin.exe",
  // 锚点 "预览截断" ——persona 预览截断后缀，两处详情弹层各一条，字典里根本没有这两条。
  "\n…（预览截断）",
  "\n…（预览截断，召唤时写入完整正文）",
  // 锚点 "安装 = 把该连接器的 mcpServers" ——连接器安装说明（无插值的模板字面量），字典里没有。
  "安装 = 把该连接器的 mcpServers 合并写入当前作用域（与「导入 JSON」同一链路，同名跳过）。",
]);
// KNOWN_ORPHAN_KEYS：字典里有、源码里从来不用的死键（改了文案忘删旧键）。
// 目前只剩一条真的孤立键 —— "正在读取…" 曾经也在这，但工程师后来补上了两处调用点
// （面板空态与刷新态），它已回归正常键，因此从集合里删掉了。往这里加条目必须有根因。
const KNOWN_ORPHAN_KEYS = new Set([
  // 同一个 bug 的另一半：字典里这一条手写转义多了一层反斜杠（解码后是双反斜杠），
  // 而源码的文案是单反斜杠 —— 两者永远匹配不上，于是这句既算「漏键」又算「孤立」。
  // 修的时候两边要一起改（源码的锚点是 "npx 或 C:"），改完两行都可以删。
  "npx 或 C:\\\\path\\\\to\\\\bin.exe",
]);

// ── 1. 字典本体健全性 ────────────────────────────────────────────────────────
ok("字典规模符合预期（≥600 键，防被清空/截断）", DICT_KEYS.length >= 600, `keys=${DICT_KEYS.length}`);
const emptyValueKeys = DICT_KEYS.filter((k) => String(DICT[k]).trim() === "");
info("译文为空串的键（合法：中文量词在英语里没有对应词，故意删空）", `${emptyValueKeys.length} 个：${JSON.stringify(emptyValueKeys.slice(0, 8))}`);

// 「恒等翻译」= 英文表里原样抄了中文原文，等于没翻译。真正恒等的键只应来自
// 非展示文案（协议字段名、HTML 标签名），中文键恒等一律视为未翻译。
const identityCjkKeys = DICT_KEYS.filter((k) => CJK.test(k) && DICT[k] === k);
ok("没有任何中文键的译文原样等于中文原文（恒等翻译 = 没翻译）",
  identityCjkKeys.length === 0,
  identityCjkKeys.length ? `共 ${identityCjkKeys.length} 个，前 5 个=${JSON.stringify(identityCjkKeys.slice(0, 5))}` : "");
const identityAsciiKeys = DICT_KEYS.filter((k) => !CJK.test(k) && DICT[k] === k);
info("非中文键的恒等条目（协议字段名等，本就不该翻译）", `${identityAsciiKeys.length} 个：${JSON.stringify(identityAsciiKeys.slice(0, 10))}`);

// 覆盖面抽查：本轮新增的几处文案必须有译文，否则「新增优化自带 i18n」这条就是空话。
const mustHaveEnglish = ["今日", "近 7 天", "近 30 天", "近 90 天", "收起", "展开全文（{0} 字符）", "复制错误详情", "已复制", "复制失败"];
const missingRequired = mustHaveEnglish.filter((k) => !Object.prototype.hasOwnProperty.call(DICT, k) || DICT[k] === k);
ok("本轮新增文案在字典里都有真译文（不是恒等、不是缺失）",
  missingRequired.length === 0,
  missingRequired.length ? `缺=${JSON.stringify(missingRequired)}` : "");

// ── 2. 双向差集：源码 t() 键 ↔ 字典键 ────────────────────────────────────────
const literals = scanLiterals(source);
const dictRegion = (at) => at >= dictRange[0] && at < dictRange[1];
const argRanges = callArgRanges(source);
const inArgRange = (at) => argRanges.some(([s, e]) => at > s && at < e);

// 2a. 源码侧：所有被 t() 包裹、含中文、且不是字典自身的字面量，都必须在字典里有键。
const wrappedCjk = literals.filter(
  (lit) => lit.value !== null && CJK.test(lit.value) && !dictRegion(lit.start) && !inArgRange(lit.start) && isWrappedByT(source, lit.start),
);
const rawMissingKeys = wrappedCjk.filter((lit) => !Object.prototype.hasOwnProperty.call(DICT, lit.value));
// 已知缺口放行；剩下任何一条都是**新**回归，必须失败。
const missingKeys = rawMissingKeys.filter((lit) => !KNOWN_MISSING_KEYS.has(lit.value));
ok("每个 t('<含中文>') 的键都在 en-US 字典里（逐字节一致）",
  missingKeys.length === 0,
  `包裹中文=${wrappedCjk.length} 漏键=${rawMissingKeys.length}（其中 ${rawMissingKeys.length - missingKeys.length} 条是已登记的历史缺口，不计入失败）${missingKeys.length ? ` 新漏键首个=${JSON.stringify(missingKeys[0].value).slice(0, 80)}` : ""}`);
info("已登记的历史漏键（只许减少，新增即失败）",
  `${rawMissingKeys.length - missingKeys.length} 条：${JSON.stringify([...KNOWN_MISSING_KEYS].map((k) => k.slice(0, 24)))}`);
if (rawMissingKeys.length) {
  for (const lit of rawMissingKeys.slice(0, 20)) {
    const line = source.slice(0, lit.start).split("\n").length;
    const hist = KNOWN_MISSING_KEYS.has(lit.value) ? "【历史】" : "【新增】";
    console.log(`      ${hist}缺键  client.js:${line}  ${JSON.stringify(lit.value).slice(0, 100)}`);
  }
  if (rawMissingKeys.length > 20) console.log(`      …另有 ${rawMissingKeys.length - 20} 条`);
}
ok("扫描器没有退化：确实抽到了大量 t() 中文键（为 0 说明扫描逻辑坏了）", wrappedCjk.length >= 500, `wrapped=${wrappedCjk.length}`);

// 2b. 反向：字典里不应有源码中完全不出现的孤立键（死键）。允许极少量白名单：
//     动态拼接产生的键（源码里只以变量形式出现）无法静态判定，只能显式列出。
// 目前实测为 0 —— 若将来出现，请把**确属动态**的键加到这里，并在注释里写明原因。
const ORPHAN_WHITELIST = new Set([]);
const usedValues = new Set();
for (const lit of literals) {
  if (dictRegion(lit.start)) continue;
  if (lit.value !== null) usedValues.add(lit.value);
  // 含插值的模板：把静态段与「整体」都算作出现过（它不是字典键，但代表源码里这段文案）。
  if (lit.computed && lit.staticText !== undefined) usedValues.add(lit.staticText);
}
const rawOrphans = DICT_KEYS.filter((key) => !usedValues.has(key) && !ORPHAN_WHITELIST.has(key));
// 已知死键放行；剩下任何一条都是**新**回归，必须失败。
const orphans = rawOrphans.filter((key) => !KNOWN_ORPHAN_KEYS.has(key));
ok("字典里没有源码中完全不出现的孤立键（死键 = 改了文案却忘了删旧键）",
  orphans.length === 0,
  `孤立=${rawOrphans.length}${rawOrphans.length ? ` 前 5 个=${JSON.stringify(rawOrphans.slice(0, 5))}` : ""}`);
if (rawOrphans.length) {
  for (const key of rawOrphans.slice(0, 20)) {
    const hist = KNOWN_ORPHAN_KEYS.has(key) ? "【历史】" : "【新增】";
    console.log(`      ${hist}孤立键  ${JSON.stringify(key).slice(0, 100)}`);
  }
}

// 2c. 含 ${} 插值的模板无法查表：静态段里若有中文，那句文案永远拿不到译文。
const computedCjk = literals.filter(
  (lit) => lit.computed && lit.staticText !== undefined && CJK.test(lit.staticText) && !dictRegion(lit.start),
);
info("含插值且静态段有中文的模板（字典机制覆盖不到，属已知边界）", `共 ${computedCjk.length} 条`);
for (const lit of computedCjk.slice(0, 10)) {
  const line = source.slice(0, lit.start).split("\n").length;
  console.log(`      client.js:${line}  ${JSON.stringify(lit.staticText).slice(0, 90)}`);
}

// ── 3. locale 四级回落：抽源码在 vm 里真跑 ──────────────────────────────────
const START_MARKER = "// ── OPT-11：i18n 骨架";
const END_MARKER = "// ── 旧插件名 → 新插件名的 localStorage 键迁移";
const startAt = source.indexOf(START_MARKER);
const endAt = source.indexOf(END_MARKER, startAt + START_MARKER.length);
ok("能定位 i18n 骨架一节的起止标记（用于 vm 真跑 locale 判定）", startAt >= 0 && endAt > startAt, `start=${startAt} end=${endAt}`);
if (startAt < 0 || endAt <= startAt) {
  console.log("\nI18N-COVERAGE FAIL（标记缺失，无法抽取 locale 判定源码）");
  process.exit(1);
}
const skeleton = source.slice(startAt, endAt);

/** 在给定宿主环境下执行 i18n 骨架，返回它导出的内部状态。 */
function runSkeleton({ storage, language } = {}) {
  const context = { console };
  context.globalThis = context;
  if (storage !== undefined) context.localStorage = storage;
  if (language !== undefined) context.navigator = { language };
  vm.createContext(context);
  vm.runInContext(
    // I18N_LOCALE 用 getter：applyI18nLocale 会改它，快照值会读到旧结果。
    skeleton + "\nglobalThis.__probe = { get I18N_LOCALE() { return I18N_LOCALE; }, i18nMessages, t, EN_US_MESSAGES, resolveI18nLocale, applyI18nLocale, subscribeI18nLocale, usesEnglish, isChineseLocale };",
    context,
    { filename: "i18n-skeleton.js" },
  );
  return context.__probe;
}

/** 最小宿主 locale 服务替身：与 DSH LocaleRuntime 的 getSnapshot/subscribe 形状一致。 */
function fakeLocaleService(active) {
  return {
    getSnapshot: () => ({ active }),
    subscribe: () => () => {},
  };
}

/** 可变替身：setActive 模拟设置 → 通用里切语言，通知全部订阅者。 */
function mutableLocaleService(initial) {
  let active = initial;
  const listeners = new Set();
  return {
    getSnapshot: () => ({ active }),
    subscribe: (fn) => {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    setActive(next) {
      active = next;
      for (const fn of [...listeners]) fn();
    },
  };
}

const memoryStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    map,
  };
};
// 源码里用的是 `localStorage['…']` 下标访问，替身必须同时支持下标与 getItem。
const asProxy = (storage) => new Proxy(storage, {
  get: (target, prop) => (typeof prop === "string" && !(prop in target) ? storage.getItem(prop) : target[prop]),
});

// 3a. 第一级：localStorage 偏好优先于宿主 locale 与 navigator.language。
const prefersEn = runSkeleton({ storage: asProxy(memoryStorage({ "dsh-armory.locale": "en-US" })), language: "zh-CN" });
ok("四级优先级 · 第一级：localStorage 偏好压过宿主 locale 与 navigator.language",
  prefersEn.I18N_LOCALE === "en-US", `得到=${prefersEn.I18N_LOCALE}`);

// 3b. 第二级：无显式偏好时用宿主 locale。
const browserEn = runSkeleton({ storage: asProxy(memoryStorage()), language: "en-GB" });
ok("四级优先级 · 第三级：存储无偏好时取 navigator.language", browserEn.I18N_LOCALE === "en-GB", `得到=${browserEn.I18N_LOCALE}`);

// 3c. 第四级：全部缺失 → zh-CN（源语言）。
const noHost = runSkeleton({});
ok("四级优先级 · 第四级：无存储、无宿主、无 navigator 时回落 zh-CN", noHost.I18N_LOCALE === "zh-CN", `得到=${noHost.I18N_LOCALE}`);

// 3d. 存储抛错（Safari 无痕配额为 0）：不崩，继续往下回落。
const throwingStorage = new Proxy({}, { get: () => { throw new Error("denied"); } });
let throwingResult = null;
try {
  throwingResult = runSkeleton({ storage: throwingStorage, language: "en-AU" });
} catch (error) {
  ok("localStorage 抛错时 locale 判定不崩", false, String(error && error.message));
}
if (throwingResult) {
  ok("localStorage 抛错时跳过偏好、回落 navigator.language", throwingResult.I18N_LOCALE === "en-AU", `得到=${throwingResult.I18N_LOCALE}`);
}

// 3e. 第二级：宿主 locale 压过 navigator —— issue #1 的核心回归。
// 中文系统（navigator=zh-CN）+ DSH 设英文（宿主 active=en）时必须是英文。
const hostEn = runSkeleton({ storage: asProxy(memoryStorage()), language: "zh-CN" });
hostEn.applyI18nLocale(hostEn.resolveI18nLocale(fakeLocaleService("en")));
ok("四级优先级 · 第二级：宿主 locale=en 压过中文 navigator", hostEn.I18N_LOCALE === "en", `得到=${hostEn.I18N_LOCALE}`);
ok("宿主 locale=en 时装载 en-US 字典（issue #1：中文系统也能出英文）",
  hostEn.t("今日") === "Today", `得到=${JSON.stringify(hostEn.t("今日"))}`);

// 反向：DSH 设中文 + 英文浏览器 → 必须保持中文（宿主优先，不让浏览器带偏）。
const hostZh = runSkeleton({ storage: asProxy(memoryStorage()), language: "en-US" });
hostZh.applyI18nLocale(hostZh.resolveI18nLocale(fakeLocaleService("zh")));
ok("四级优先级 · 宿主 locale=zh 压过英文 navigator", hostZh.I18N_LOCALE === "zh", `得到=${hostZh.I18N_LOCALE}`);
ok("从 en 切回 zh 时清空旧字典（源语言恒等直出，不残留英文）",
  hostZh.t("今日") === "今日" && Object.keys(hostZh.i18nMessages).length === 0,
  `t=${JSON.stringify(hostZh.t("今日"))} keys=${Object.keys(hostZh.i18nMessages).length}`);

// 显式覆盖仍然最高：测试/高级用户手写的 localStorage 不被宿主语言覆盖。
const overrideHost = runSkeleton({ storage: asProxy(memoryStorage({ "dsh-armory.locale": "en-GB" })), language: "zh-CN" });
overrideHost.applyI18nLocale(overrideHost.resolveI18nLocale(fakeLocaleService("zh")));
ok("显式 localStorage 覆盖压过宿主 locale", overrideHost.I18N_LOCALE === "en-GB", `得到=${overrideHost.I18N_LOCALE}`);

// 宿主快照抛错（服务尚未就绪 / 实现异常）：不崩，回落 navigator。
const brokenHostProbe = runSkeleton({ storage: asProxy(memoryStorage()), language: "en-AU" });
brokenHostProbe.applyI18nLocale(brokenHostProbe.resolveI18nLocale({
  getSnapshot() { throw new Error("not ready"); },
}));
ok("宿主 getSnapshot 抛错时回落 navigator.language", brokenHostProbe.I18N_LOCALE === "en-AU", `得到=${brokenHostProbe.I18N_LOCALE}`);

// 3f. 运行期切语言：subscribe 回调必须让字典与 I18N_LOCALE 同步变化。
const liveHost = mutableLocaleService("en");
const liveProbe = runSkeleton({ storage: asProxy(memoryStorage()), language: "zh-CN" });
liveProbe.applyI18nLocale(liveProbe.resolveI18nLocale(liveHost));
let liveNotifications = 0;
const offLive = liveProbe.subscribeI18nLocale(liveHost, () => {
  liveNotifications += 1;
  liveProbe.applyI18nLocale(liveProbe.resolveI18nLocale(liveHost));
});
ok("订阅前：宿主 en → 英文表已装载", liveProbe.I18N_LOCALE === "en" && liveProbe.t("今日") === "Today", `得到=${liveProbe.I18N_LOCALE}`);
liveHost.setActive("zh");
ok("宿主切到 zh 后订阅回调立即重算（无需重启面板）",
  liveNotifications === 1 && liveProbe.I18N_LOCALE === "zh" && liveProbe.t("今日") === "今日",
  `通知=${liveNotifications} locale=${liveProbe.I18N_LOCALE} t=${JSON.stringify(liveProbe.t("今日"))}`);
offLive();
liveHost.setActive("en");
ok("取消订阅后不再触发，词典保持取消时的中文",
  liveNotifications === 1 && liveProbe.I18N_LOCALE === "zh", `通知=${liveNotifications} locale=${liveProbe.I18N_LOCALE}`);

// 3g. 宿主服务未实现 subscribe：订阅不崩，返回 null（启动时判定的语言仍有效）。
const noSubProbe = runSkeleton({});
let noSubResult;
try {
  noSubResult = noSubProbe.subscribeI18nLocale({ getSnapshot: () => ({ active: "en" }) }, () => {});
} catch (error) {
  ok("宿主 locale 无 subscribe 时订阅不抛错", false, String(error && error.message));
}
if (noSubResult !== undefined) {
  ok("宿主 locale 无 subscribe 时返回 null（调用方据此跳过解绑）", noSubResult === null, `得到=${String(noSubResult)}`);
}

// ── 4. P1 语言选择：zh* → 中文；其余（含未支持语言）→ 英文 ──────────────────
// 源语言只有中文、唯一译文是英文。ja / de / fr 这类没有译文的语言如果保留中文，
// 对用户等于没本地化；宁可回落英文。zh-TW 仍是中文（简体源语言比英文更接近）。
const englishLocales = ["en", "en-US", "en-GB", "EN-us", "en-AU", "ja-JP", "de-DE", "fr", "ko-KR"];
const englishFailed = englishLocales.filter((locale) => {
  const probe = runSkeleton({ storage: asProxy(memoryStorage({ "dsh-armory.locale": locale })) });
  return Object.keys(probe.i18nMessages).length === 0 || probe.t("今日") !== "Today";
});
ok("en* 与无译文的非 zh 语言都装载 en-US 字典（未支持语言回落英文）",
  englishFailed.length === 0, englishFailed.length ? `未装载=${JSON.stringify(englishFailed)}` : "");

const chineseLocales = ["zh-CN", "zh-TW", "ZH-hant", "zh"];
const chineseLoaded = chineseLocales.filter((locale) => {
  const probe = runSkeleton({ storage: asProxy(memoryStorage({ "dsh-armory.locale": locale })) });
  return Object.keys(probe.i18nMessages).length !== 0 || probe.t("今日") !== "今日";
});
ok("zh* 的 locale 不装载英文表（否则中文用户会看到英文）",
  chineseLoaded.length === 0, chineseLoaded.length ? `误装载=${JSON.stringify(chineseLoaded)}` : "");

// usesEnglish 是数据型文案（更新日志 / 内置目录）选择的唯一判据：它必须与字典
// 的实际装载保持一致，否则会出现「UI 英文、目录中文」的半截状态。
const jaProbe = runSkeleton({ storage: asProxy(memoryStorage({ "dsh-armory.locale": "ja-JP" })) });
ok("usesEnglish 对未支持语言为 true，且与字典装载一致",
  jaProbe.usesEnglish() === true && Object.keys(jaProbe.i18nMessages).length > 0,
  `usesEnglish=${jaProbe.usesEnglish()} keys=${Object.keys(jaProbe.i18nMessages).length}`);
const zhTwProbe = runSkeleton({ storage: asProxy(memoryStorage({ "dsh-armory.locale": "zh-TW" })) });
ok("usesEnglish 对 zh* 为 false，且不装载英文表",
  zhTwProbe.usesEnglish() === false && Object.keys(zhTwProbe.i18nMessages).length === 0,
  `usesEnglish=${zhTwProbe.usesEnglish()} keys=${Object.keys(zhTwProbe.i18nMessages).length}`);

// 装载后 t() 真的会翻译，未装载时恒等直出 —— 这条把「装了表」与「表被用到」连起来。
ok("en-US 环境：t('今日') 返回英文", prefersEn.t("今日") === "Today", `得到=${JSON.stringify(prefersEn.t("今日"))}`);
ok("zh-CN 环境：t('今日') 恒等返回中文", noHost.t("今日") === "今日", `得到=${JSON.stringify(noHost.t("今日"))}`);
ok("en-US 环境：带插值的键按 {n} 下标替换后仍是英文",
  /^Expand full text \(\d[\d,]* characters\)$/.test(prefersEn.t("展开全文（{0} 字符）", [4000])),
  `得到=${JSON.stringify(prefersEn.t("展开全文（{0} 字符）", [4000]))}`);

// ── 5. 反向自测：证明第 2 节的差集不是恒真 ──────────────────────────────────
{
  const MUTATION = "\nconst __i18n_coverage_probe = t('这条文案故意不在字典里');\n";
  const mutatedLiterals = scanLiterals(source + MUTATION);
  const mutatedWrapped = mutatedLiterals.filter(
    (lit) => lit.value !== null && CJK.test(lit.value) && !dictRegion(lit.start) && !inArgRange(lit.start) && isWrappedByT(source + MUTATION, lit.start),
  );
  const mutatedMissing = mutatedWrapped
    .filter((lit) => !Object.prototype.hasOwnProperty.call(DICT, lit.value))
    .filter((lit) => !KNOWN_MISSING_KEYS.has(lit.value));
  ok("自测：注入的未翻译 t() 被差集抓到（证明第 2a 节不是恒真）",
    mutatedMissing.length === missingKeys.length + 1 && mutatedMissing.some((lit) => lit.value.includes("这条文案故意不在字典里")),
    `新增漏键=${mutatedMissing.length - missingKeys.length}`);
}
{
  // 自测 2：把 locale 判定改成「忽略 localStorage 偏好」，第一级优先断言必须抓到。
  const broken = skeleton.replace(
    "return localStorage['dsh-armory.locale'] || null;",
    "return null;",
  );
  ok("自测前置：成功改坏了 locale 判定的第一级", broken !== skeleton);
  if (broken !== skeleton) {
    const context = { console, localStorage: asProxy(memoryStorage({ "dsh-armory.locale": "en-US" })), navigator: { language: "zh-CN" } };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(broken + "\nglobalThis.__probe = { I18N_LOCALE };", context, { filename: "i18n-skeleton-broken.js" });
    ok("自测：改坏后第一级断言确实会失败（证明 3a 不是恒真）", context.__probe.I18N_LOCALE !== "en-US", `得到=${context.__probe.I18N_LOCALE}`);
  }
}

console.log(`\n${failures === 0 ? "I18N-COVERAGE PASS" : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
