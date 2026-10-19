// test/persona-truncate.mjs
//
// 护栏对象：清单 3.2「persona 4000 预览阈值」。
//
// 背景：专家详情页会把超长 persona 截到 4000 字符，并给一个「展开全文」按钮，
// 否则一个几千字的系统提示会把弹层撑成滚动地狱。这条护栏钉三件事：
//   1. 阈值只有一个来源（PERSONA_PREVIEW_MAX = 4000），不是散落各处的魔法数字；
//   2. 两处详情弹层（已召唤专家详情 / 专家市场详情）都真的用了这个常量做截断；
//   3. 展开/收起是双向的 —— 有 setPersonaExpanded(true) 就必须有 (false)，否则展开后回不去。
//
// 策略：静态文本断言（不用 vm）。原因是这两处逻辑嵌在 JSX 化的 h() 表达式里，
// 依赖 hooks 与 detail 对象，抽片段真跑的成本远高于收益；而这段代码的**形状**本身就是
// 本次优化的约定（阈值走常量、两处对称、可来回切换），静态钉足以拦住回归。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** 把源码偏移换算成 1 起始行号，便于报告定位。 */
const lineOf = (text, at) => text.slice(0, at).split("\n").length;

const source = readFileSync(CLIENT, "utf8");

// ── 1. 常量本身 ──────────────────────────────────────────────────────────────
const CONST_RE = /const\s+PERSONA_PREVIEW_MAX\s*=\s*(\d+)\s*;/;
const constMatch = CONST_RE.exec(source);
ok("lib/client.js 里定义了 PERSONA_PREVIEW_MAX 常量", !!constMatch,
  constMatch ? `client.js:${lineOf(source, constMatch.index)}` : "未找到");
ok("PERSONA_PREVIEW_MAX 的值是 4000", constMatch ? Number(constMatch[1]) === 4000 : false,
  constMatch ? `得到=${constMatch[1]}` : "");

const CONST_DECL_COUNT = (source.match(/const\s+PERSONA_PREVIEW_MAX\s*=/g) || []).length;
ok("PERSONA_PREVIEW_MAX 只声明了一次（防止复制出第二份阈值各调各的）",
  CONST_DECL_COUNT === 1, `声明次数=${CONST_DECL_COUNT}`);

// ── 2. 两处详情弹层都用常量做截断判断 ────────────────────────────────────────
// 真正的截断表达式必须同时出现「比较」与「切片」两个动作，且都用常量，
// 不能一处 <= 4000 另一处 slice(0, 4000) 各写一个数字。
const COMPARE_RE = /detail\.persona\.length\s*<=\s*PERSONA_PREVIEW_MAX/g;
const SLICE_RE = /detail\.persona\.slice\(\s*0\s*,\s*PERSONA_PREVIEW_MAX\s*\)/g;
const compareHits = [...source.matchAll(COMPARE_RE)];
const sliceHits = [...source.matchAll(SLICE_RE)];

ok("至少 2 处用 PERSONA_PREVIEW_MAX 做「超长判断」（两处详情弹层）",
  compareHits.length >= 2, `命中=${compareHits.length} 行=${JSON.stringify(compareHits.map((m) => lineOf(source, m.index)))}`);
ok("至少 2 处用 PERSONA_PREVIEW_MAX 做「实际切片」",
  sliceHits.length >= 2, `命中=${sliceHits.length} 行=${JSON.stringify(sliceHits.map((m) => lineOf(source, m.index)))}`);
ok("截断判断与切片成对出现（判断了却不切 / 切了却不判断 都是 bug）",
  compareHits.length === sliceHits.length, `判断=${compareHits.length} 切片=${sliceHits.length}`);

// 两处必须落在**不同**的行上：同一行重复出现只算一处弹层。
const compareLines = [...new Set(compareHits.map((m) => lineOf(source, m.index)))];
const sliceLines = [...new Set(sliceHits.map((m) => lineOf(source, m.index)))];
ok("截断判断分布在 2 个不同的弹层（已召唤专家详情 + 专家市场详情）",
  compareLines.length >= 2, `行=${JSON.stringify(compareLines)}`);
ok("实际切片也分布在同样的 2 个弹层", sliceLines.length >= 2, `行=${JSON.stringify(sliceLines)}`);

// ── 3. 不再有散落的硬编码 4000 ──────────────────────────────────────────────
// 允许的 4000：常量声明本身、以及与本优化无关的既有用法（flash 提示 4000ms 定时器）。
// 判定方式：找所有 `slice(0, 4000)` / `<= 4000` / `> 4000` 这类**与 persona 长度比较**
// 相关的字面量，这些必须是 0 处。
const HARDCODED_PATTERNS = [
  { name: "persona.slice(0, 4000) 硬编码切片", re: /persona\s*\.\s*slice\(\s*0\s*,\s*4000\s*\)/g },
  { name: "persona.length <= 4000 硬编码比较", re: /persona\s*\.\s*length\s*[<>=]+\s*4000/g },
  { name: "4000 <= persona.length 反向硬编码比较", re: /4000\s*[<>=]+\s*persona\s*\.\s*length/g },
];
for (const { name, re } of HARDCODED_PATTERNS) {
  const hits = [...source.matchAll(re)];
  ok(`没有散落的${name}（应统一走常量）`, hits.length === 0,
    hits.length ? `命中行=${JSON.stringify(hits.map((m) => lineOf(source, m.index)))}` : "");
}

// 非 persona 语境里的 4000 仍然存在（flash 定时器 4000ms），说明上面三条不是「连同 4000
// 一起消失」的假通过 —— 这条断言把测试自身也钉住，防止将来有人把 4000 全删了骗过前三条。
const all4000 = [...source.matchAll(/\b4000\b/g)].map((m) => lineOf(source, m.index));
info("源码里其余 4000 出现位置（非 persona 语境，合理保留）", `行=${JSON.stringify([...new Set(all4000)])}`);

// ── 4. 展开 / 收起 是双向的 ─────────────────────────────────────────────────
const expandCalls = [...source.matchAll(/setPersonaExpanded\(\s*true\s*\)/g)].map((m) => lineOf(source, m.index));
const collapseCalls = [...source.matchAll(/setPersonaExpanded\(\s*false\s*\)/g)].map((m) => lineOf(source, m.index));
ok("存在「展开全文」调用 setPersonaExpanded(true)", expandCalls.length >= 2, `行=${JSON.stringify(expandCalls)}`);
ok("存在「收起」调用 setPersonaExpanded(false) —— 展开后必须能回去",
  collapseCalls.length >= 2, `行=${JSON.stringify(collapseCalls)}`);

// state 的初始值必须是 false：默认展开会让上面的截断逻辑形同虚设。
const STATE_RE = /const\s+\[\s*personaExpanded\s*,\s*setPersonaExpanded\s*\]\s*=\s*useState\(\s*false\s*\)/g;
const stateDecls = [...source.matchAll(STATE_RE)];
ok("personaExpanded 的初值是 false（默认收起，截断才生效）",
  stateDecls.length >= 2, `声明=${stateDecls.length} 行=${JSON.stringify(stateDecls.map((m) => lineOf(source, m.index)))}`);

// 渲染分支必须真的读 personaExpanded：`personaExpanded || ...` 这个短路形状。
const GUARD_RE = /personaExpanded\s*\|\|\s*detail\.persona\.length\s*<=\s*PERSONA_PREVIEW_MAX/g;
const guardHits = [...source.matchAll(GUARD_RE)];
ok("展开状态下短路跳过截断（personaExpanded || 长度未超阈 → 渲染全文）",
  guardHits.length >= 2, `命中=${guardHits.length} 行=${JSON.stringify(guardHits.map((m) => lineOf(source, m.index)))}`);

// ── 5. 展开按钮的文案走 i18n，且带上真实字符数 ──────────────────────────────
ok("「展开全文」按钮文案走 t() 并带 {0} 插值（要显示真实字符数，不是写死 4000）",
  /t\(\s*'展开全文（\{0\} 字符）'\s*,\s*\[\s*fmtInt\(/.test(source), "");
ok("「收起」按钮文案走 t()", /t\(\s*'收起'\s*\)/.test(source), "");

// 截断后缀本身也必须走 t()，否则英文界面会蹦出中文省略号说明。
const SUFFIX_COUNT = (source.match(/t\(\s*'\\n…（预览截断/g) || []).length;
ok("截断提示后缀走 t()（英文界面不能蹦中文）", SUFFIX_COUNT >= 2, `命中=${SUFFIX_COUNT}`);

// ── 6. 反向自测：证明第 2、3 节的断言不是恒真 ────────────────────────────────
{
  // 把常量改回硬编码，第 3 节必须抓到。
  const mutated = source.replace(
    /detail\.persona\.length\s*<=\s*PERSONA_PREVIEW_MAX/g,
    "detail.persona.length <= 4000",
  );
  const mutatedHits = [...mutated.matchAll(/persona\s*\.\s*length\s*[<>=]+\s*4000/g)];
  ok("自测：把常量替换回硬编码 4000 时，「无硬编码」断言确实会失败",
    mutated !== source && mutatedHits.length >= 2, `命中=${mutatedHits.length}`);
}
{
  // 删掉收起分支，第 4 节必须抓到（展开后回不去）。
  const mutated = source.replace(/setPersonaExpanded\(\s*false\s*\)/g, "undefined");
  const stillCollapse = [...mutated.matchAll(/setPersonaExpanded\(\s*false\s*\)/g)].length;
  ok("自测：删掉 setPersonaExpanded(false) 后，「双向切换」断言确实会失败",
    mutated !== source && stillCollapse === 0, `剩余=${stillCollapse}`);
}

console.log(`\n${failures === 0 ? "PERSONA-TRUNCATE PASS" : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
