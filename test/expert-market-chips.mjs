// 2026-10-31 用户反馈：专家市场的分类栏「显示到界面外、滑动不了，后面的分类点不到」。
// 诊断不是定位/层级问题：16 个分类 chip 塞在单行 overflow-x:auto 里，滚动条被样式隐藏，
// 鼠标滚轮只滚页面纵向，尾部（法务安全 / 行业顾问 / 全球发展 / 腾讯专区）无法到达。
// 采用方案（用户选定）：保留单行，补两侧箭头 + 竖向滚轮转横向 + 选中项自动滚入。
//
// 这里钉三件事，全部零网络、零写盘：
//   ① 几何判定纯函数真跑：箭头显隐 / 滚轮换算 / 步长；
//   ② 组件真的接上三条通道，且单行结构没有被顺手改成换行；
//   ③ 每条关键断言配反向自测（旧/坏实现注回去必须变红），防止断言空转。
//
// 用法：node ./test/expert-market-chips.mjs
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const source = await readFile(join(here, "..", "lib", "client.js"), "utf8");

let failed = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failed += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const section = (title) => console.log(`\n── ${title} ─────────────────────────────────────────────`);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sliceBetween = (startMarker, endMarker, label) => {
  const start = source.indexOf(startMarker);
  const end = start < 0 ? -1 : source.indexOf(endMarker, start + startMarker.length);
  ok(`能定位「${label}」片段`, start >= 0 && end > start, `start=${start} end=${end}`);
  return start >= 0 && end > start ? source.slice(start, end) : "";
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. 几何判定：从组件上方抽出纯函数，在 vm 里真跑
// ═══════════════════════════════════════════════════════════════════════════
section("1. 纯函数可在 vm 里独立执行");
const GEO = sliceBetween("// ── 专家分类栏滚动几何", "// 专家市场（市场页子标签）", "分类栏滚动几何");
const probe = (() => {
  const context = vm.createContext({});
  vm.runInContext(`${GEO}
    globalThis.__p = { chipEdgeState, chipWheelTarget, chipScrollStep };`, context, { filename: "expert-market-chips-geometry.js" });
  return context.__p;
})();
ok("三个纯函数都取到了", !!probe && typeof probe.chipEdgeState === "function"
  && typeof probe.chipWheelTarget === "function" && typeof probe.chipScrollStep === "function");
if (!probe || typeof probe.chipEdgeState !== "function") {
  console.log("\n几何片段不可用，后续断言无法执行。");
  process.exit(1);
}
const { chipEdgeState, chipWheelTarget, chipScrollStep } = probe;

// 实测口径：1000px 面板内容区约 904px，16 个 chip 约 1500px。
const CLIENT = 904;
const SCROLL = 1500;
const MAX = SCROLL - CLIENT; // 596

section("2. 箭头显隐（chipEdgeState）");
ok("初始位置：右侧有剩余 → 右箭头亮、左箭头灭",
  eq(chipEdgeState(0, CLIENT, SCROLL), { left: false, right: true }));
ok("中部：左右都有剩余 → 两侧都亮",
  eq(chipEdgeState(300, CLIENT, SCROLL), { left: true, right: true }));
ok("滚到末尾：左亮右灭",
  eq(chipEdgeState(MAX, CLIENT, SCROLL), { left: true, right: false }));
ok("内容不溢出：两侧都灭",
  eq(chipEdgeState(0, 900, 900), { left: false, right: false }));
ok("亚像素抖动：1px 内不当作可滚",
  eq(chipEdgeState(1, CLIENT, SCROLL), { left: false, right: true }));
ok("异常入参不抛错（null / NaN）",
  eq(chipEdgeState(null, NaN, undefined), { left: false, right: false }));
const brokenEdges = () => ({ left: false, right: false });
ok("反向：永久返回「两边都不可滚」→ 初始位置断言必须失败",
  !eq(brokenEdges(0, CLIENT, SCROLL), { left: false, right: true }));

section("3. 滚轮转横向（chipWheelTarget）");
ok("中部向下滚：前进 delta", chipWheelTarget(100, MAX, 120) === 220);
ok("中部向上滚：后退 delta", chipWheelTarget(300, MAX, -120) === 180);
ok("超过右端：夹到 max", chipWheelTarget(560, MAX, 120) === MAX);
ok("右端继续向下：返回 null（放行页面纵向滚动）", chipWheelTarget(MAX, MAX, 120) === null);
ok("左端继续向上：返回 null", chipWheelTarget(0, MAX, -120) === null);
ok("deltaY 为 0：不处理", chipWheelTarget(100, MAX, 0) === null);
ok("内容不溢出：不处理", chipWheelTarget(0, 0, 120) === null);
const brokenWheel = () => null;
ok("反向：滚轮永远不处理 → 中部滚动断言必须失败", brokenWheel(100, MAX, 120) !== 220);

section("4. 箭头步长（chipScrollStep）");
ok("1000px 面板一次滚 70%", chipScrollStep(1000) === 700);
ok("窄面板保底 160px", chipScrollStep(200) === 160);
ok("异常入参也保底", chipScrollStep(0) === 160 && chipScrollStep(NaN) === 160);
const brokenStep = () => 40;
ok("反向：步长退化成 40px → 70% 断言必须失败", brokenStep(1000) !== 700);

// ═══════════════════════════════════════════════════════════════════════════
// 5. 组件与 CSS 接线
// ═══════════════════════════════════════════════════════════════════════════
section("5. 组件接线（源码针）");
ok("单行保留：chips 没有被顺手改成 flex-wrap:wrap",
  !/\.dsh-mcp-market-chips\{[^}]*flex-wrap:wrap/.test(source));
ok("两侧箭头各渲染一次（左右各一）",
  (source.match(/className: 'dsh-mcp-strip-arrow'/g) || []).length === 2);
ok("箭头按需渲染：没有可滚空间就不占位",
  /chipEdges\.left\s*\?\s*h\('button'/.test(source)
  && /chipEdges\.right\s*\?\s*h\('button'/.test(source)
  && !/\.dsh-mcp-strip-arrow\[aria-hidden/.test(source));
ok("箭头点击走 scrollChips(±1)",
  /onClick: \(\) => scrollChips\(-1\)/.test(source)
  && /onClick: \(\) => scrollChips\(1\)/.test(source));
ok("滚轮监听是 non-passive（否则 preventDefault 无效）",
  /addEventListener\('wheel', onWheel, \{ passive: false \}\)/.test(source));
ok("到边先返回、再改 scrollLeft、最后 preventDefault（不能先拦截）",
  /if \(next === null\) return;\s*el\.scrollLeft = next;\s*event\.preventDefault\(\)/.test(source));
ok("滚轮只在纵向手势时接管，横向手势放行给浏览器",
  /Math\.abs\(event\.deltaX\) >= Math\.abs\(event\.deltaY\)\) return;/.test(source));
ok("选中项自动滚入：查 .sel 并用矩形差计算",
  /querySelector\('\.dsh-mcp-chip\.sel'\)/.test(source)
  && /const row = el\.getBoundingClientRect\(\)/.test(source)
  && /const chip = node\.getBoundingClientRect\(\)/.test(source));
ok("自动滚入不用 scrollIntoView（避免连带滚动宿主页面）",
  !/scrollIntoView\(\{\s*inline: 'nearest'/.test(source));
ok("每次渲染后补测一次，且同值 bail-out（不形成渲染循环）",
  /useLayoutEffect\(\(\) => \{ syncChipEdges\(\); \}\);/.test(source)
  && /prev\.left === next\.left && prev\.right === next\.right \? prev : next/.test(source));
ok("CSS：strip 包裹层 + chips 吃满剩余宽度",
  /\.dsh-mcp-market-strip\{[^}]*display:flex[^}]*gap:6px[^}]*min-width:0/.test(source)
  && /\.dsh-mcp-market-strip>\.dsh-mcp-market-chips\{[^}]*flex:1 1 auto[^}]*min-width:0[^}]*margin-bottom:0/.test(source));
ok("CSS：单行滚动条仍隐藏（本方案靠箭头/滚轮，不靠滚动条）",
  /\.dsh-mcp-market-chips\{[^}]*overflow-x:auto[^}]*scrollbar-width:none/.test(source));

// ── 反向自测：把坏实现注回去，对应断言必须变红 ─────────────────────────────
const singleLineCheck = (text) => !/\.dsh-mcp-market-chips\{[^}]*flex-wrap:wrap/.test(text);
const wrapped = source.replace(
  ".dsh-mcp-market-chips{display:flex;gap:6px;align-items:center;overflow-x:auto;scrollbar-width:none;flex:none;padding:1px 0;margin-bottom:10px}",
  ".dsh-mcp-market-chips{display:flex;gap:6px;align-items:center;overflow-x:auto;scrollbar-width:none;flex:none;padding:1px 0;margin-bottom:10px;flex-wrap:wrap}");
ok("反向：改成换行后，单行判定必须为 false",
  singleLineCheck(wrapped) === false && wrapped !== source);

const orderCheck = (text) => /if \(next === null\) return;\s*el\.scrollLeft = next;\s*event\.preventDefault\(\)/.test(text);
const badOrder = source.replace(
  "if (next === null) return;\n      el.scrollLeft = next;\n      event.preventDefault();",
  "el.scrollLeft = next;\n      event.preventDefault();\n      if (next === null) return;");
ok("反向：先拦截再判边后，「先判边再拦截」断言必须为 false",
  orderCheck(badOrder) === false && badOrder !== source);

const arrowCheck = (text) => (text.match(/className: 'dsh-mcp-strip-arrow'/g) || []).length === 2;
const arrowNeedle = "className: 'dsh-mcp-strip-arrow'";
const arrowAt = source.lastIndexOf(arrowNeedle);
const oneArrow = arrowAt < 0 ? source
  : source.slice(0, arrowAt) + "className: 'dsh-mcp-strip-arrow is-right'" + source.slice(arrowAt + arrowNeedle.length);
ok("反向：右侧箭头 class 被改名后，两侧箭头断言必须为 false",
  arrowCheck(oneArrow) === false && oneArrow !== source);

console.log(failed === 0 ? "\nEXPERT-MARKET-CHIPS PASS" : `\n${failed} CHECK(S) FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
