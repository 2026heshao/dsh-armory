// 顶栏「点 Star」的守护套件。
//
// 为什么值得单独一套：这个按钮的全部风险都不在「能不能点」，而在三条容易被后来一次
// 顺手改动踩穿的线上——
//   1. 诚实性：GitHub 不支持匿名 star。一旦有人「为了体验」加一个本地「已 star」态，
//      界面就开始说谎。本套件把「不许写本地 starred 状态」钉成断言。
//   2. 数字只能来自上游：读不到就整段不显示。伪造一个 ★ 0、或把缓存旧值当实时值，
//      等于把社区信号变成布景。
//   3. ARIA：star 必须是 role=tablist 的**兄弟**，不是它的子节点——tablist 里只该有 tab。
//
// 手法与 client-i18n.mjs 一致：lib/client.js 是浏览器 bundle，不能 import，
// 于是把「社区信号」一节抽进 vm，配一个最小 hook 垫片**真正渲染**它，
// 对产出的元素树断言行为；结构不变式（DOM 层级、CSS）则用源码正则。
// 零真实网络：call 是替身。
//
// 关于 rerender：垫片把状态存在数组里，所以「点一下之后 class 变不变」「数字到手后
// 出现不出现」都必须**再渲染一次**才看得到——首帧建好的树是快照，不会自己变。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
const source = await readFile(CLIENT, "utf8");

let failed = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failed += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};

// ── 0. 抽出被测片段并真渲染 ─────────────────────────────────────────────────
// 起点取 wbFormatCount（数字缩写是被测行为的一部分，不作桩），
// 终点取「装备清单」一节之前——star chip 正落在这两条线之间。
const START_MARKER = "const wbFormatCount = (value) => {";
const END_MARKER = "// ── 装备清单：把本机配置导出成可分享的 JSON";
const startAt = source.indexOf(START_MARKER);
const endAt = source.indexOf(END_MARKER, startAt + START_MARKER.length);
ok("能在 lib/client.js 里定位到 star chip 所在的起止锚点", startAt >= 0 && endAt > startAt, `start=${startAt} end=${endAt}`);
if (startAt < 0 || endAt <= startAt) {
  console.log("\nREPO-STAR-CHIP FAIL（锚点缺失，无法抽取待测源码）");
  process.exit(1);
}
const slice = source.slice(startAt, endAt);
ok("抽出的片段含 RepoStarChip 与 ARMORY_REPO_KEY", slice.includes("const RepoStarChip =") && slice.includes("const ARMORY_REPO_KEY ="));

// 最小 hook 垫片：useState 按下标存状态；useEffect 收集起来由测试手动 flush。
// 不做依赖比较——本组件的两个 effect 依赖是 [call] / [burstKey]，测试里每次重渲染
// 都按「重跑」处理，比跳过更符合要验证的行为（数字与动画都靠重跑生效）。
const context = vm.createContext({ console, setTimeout, clearTimeout });
vm.runInContext(
  `
  let __state = [];
  let __cursor = 0;
  let __effects = [];
  const useState = (init) => {
    const i = __cursor++;
    if (!(i in __state)) __state[i] = typeof init === 'function' ? init() : init;
    const set = (v) => { __state[i] = typeof v === 'function' ? v(__state[i]) : v; };
    return [__state[i], set];
  };
  const useEffect = (fn) => { __effects.push(fn); };
  const h = (type, props, ...kids) => ({ type, props: props || {}, children: kids.flat(Infinity).filter(Boolean) });
  const t = (s) => s;
  const Badge = () => null;
  const copyText = async () => true;
  ${slice}
  globalThis.__probe = {
    RepoStarChip, ARMORY_REPO_KEY, ARMORY_REPO_URL, wbFormatCount,
    reset: () => { __state = []; __cursor = 0; __effects = []; },
    rewind: () => { __cursor = 0; __effects = []; },
    flushEffects: () => __effects.map((fn) => fn()),
  };
  `,
  context,
  { filename: "repo-star-chip-slice.js" },
);
const { RepoStarChip, ARMORY_REPO_KEY, ARMORY_REPO_URL, wbFormatCount } = context.__probe;

const render = (props) => {
  context.__probe.reset();
  return RepoStarChip(props);
};
// 保留状态、只把渲染游标与 effect 列表归零：等价于 React 的一次重渲染。
const rerender = (props) => {
  context.__probe.rewind();
  return RepoStarChip(props);
};
const flushEffects = () => context.__probe.flushEffects();
const tick = () => new Promise((r) => setTimeout(r, 0));
const flatten = (node) => [node, ...(node.children || []).flatMap(flatten)];
const findByClass = (tree, cls) =>
  flatten(tree).find((n) => String(n.props?.className || "").split(" ").includes(cls));
const textOf = (node) => (node ? flatten(node).map((n) => (typeof n === "string" ? n : "")).join("") : "");

// 1a. 仓库键必须是宿主 wbRepoMeta 认得的 `owner/repo`：它既是缓存键，也是响应里的取值键。
ok("ARMORY_REPO_KEY 解析成 owner/repo（不是 URL、不带 .git）", ARMORY_REPO_KEY === "2026heshao/dsh-armory", `key=${ARMORY_REPO_KEY}`);
ok("ARMORY_REPO_URL 是 https 的仓库主页", ARMORY_REPO_URL === "https://github.com/2026heshao/dsh-armory", ARMORY_REPO_URL);

// 1b. 首帧：数字没到手前整段不出现（宁缺勿假）。
const first = render({ call: async () => ({ repos: {} }) });
ok("渲染的是一个 <a>（可中键开、可复制链接、不被弹窗拦截）", first.type === "a", `type=${first.type}`);
ok("href 指向仓库主页", first.props.href === ARMORY_REPO_URL);
ok("新标签页打开且带上 noreferrer", first.props.target === "_blank" && first.props.rel === "noreferrer");
ok("title 说清「要点的是 GitHub 上的 Star」", /Star/.test(String(first.props.title || "")), String(first.props.title || ""));
ok("aria-label 说明了会发生什么（不是光一个「Star」）", /GitHub/.test(String(first.props["aria-label"] || "")));
ok("数字未到手时不渲染计数节点（不出现 ★ 0 这类假占位）", findByClass(first, "dsh-mcp-star-count") === undefined);
ok("图案本体在：星形 svg + 两颗星屑", flatten(first).filter((n) => n.type === "svg").length === 1
  && flatten(first).filter((n) => String(n.props?.className || "").includes("dsh-mcp-star-spark")).length === 2);
ok("星形与星屑对读屏器隐藏（避免念成一串噪音）", flatten(first).filter((n) => n.props?.["aria-hidden"] === true).length >= 3);

// 2. 真实上游数字：只走 wbRepoMeta，入参用解析后的 owner/repo。
const seen = [];
render({
  call: (method, payload) => {
    seen.push([method, payload]);
    return Promise.resolve({ repos: { "2026heshao/dsh-armory": { ok: true, stars: 1234 } } });
  },
});
flushEffects();
await tick();
ok("只调 wbRepoMeta 这一个既有 RPC（没为 star 新增契约方法）", seen.length === 1 && seen[0][0] === "wbRepoMeta", JSON.stringify(seen.map((s) => s[0])));
ok("入参 repos 用的是解析后的 owner/repo", JSON.stringify(seen[0][1]?.repos) === '["2026heshao/dsh-armory"]', JSON.stringify(seen[0][1]));
ok("数字到手后重渲染即出现计数，并按 wbFormatCount 缩写", (() => {
  const node = findByClass(rerender({ call: async () => ({}) }), "dsh-mcp-star-count");
  return node && textOf(node) === "1.2k";
})(), textOf(findByClass(rerender({ call: async () => ({}) }), "dsh-mcp-star-count")));

// 3. 降级路径：报错 / ok:false / 缺字段 / 非数字，一律「不显示数字」，绝不显示 0。
const degraded = async (callImpl) => {
  render({ call: callImpl });
  flushEffects();
  await tick();
  return findByClass(rerender({ call: callImpl }), "dsh-mcp-star-count");
};
ok("上游抛错时不显示计数", (await degraded(async () => { throw new Error("net down"); })) === undefined);
ok("单条 ok:false 时不显示计数", (await degraded(async () => ({ repos: { "2026heshao/dsh-armory": { ok: false, error: "限流" } } }))) === undefined);
ok("响应里没有这个仓库时不显示计数", (await degraded(async () => ({ repos: {} }))) === undefined);
ok("stars 不是数字时不显示计数（不把 undefined 洗成 0）", (await degraded(async () => ({ repos: { "2026heshao/dsh-armory": { ok: true, stars: "12" } } }))) === undefined);
ok("call 缺失时不发请求也不炸", (() => {
  render({});
  flushEffects();
  return findByClass(rerender({}), "dsh-mcp-star-count") === undefined;
})());

// 4. 点击反馈：burst class 在**重渲染后**出现（动画靠它驱动），且不拦默认行为。
{
  const tree4 = render({ call: async () => ({ repos: {} }) });
  let prevented = false;
  tree4.props.onClick({ preventDefault: () => { prevented = true; } });
  ok("点击不 preventDefault（新标签页由 href 自己完成）", prevented === false);
  const burst = findByClass(rerender({ call: async () => ({ repos: {} }) }), "dsh-mcp-star");
  ok("点击后重渲染，chip 带上 burst 类", String(burst.props.className).split(" ").includes("burst"), burst.props.className);
}

// 5. 诚实性红线：不许出现本地「已 star」状态。
const chipRegion = slice.slice(slice.indexOf("const ARMORY_REPO_KEY"));
ok("组件不碰 localStorage（不伪造 starred 态）", !/localStorage/.test(chipRegion));
ok("没有「已 Star / 已收藏」这类假状态文案", !/已 ?Star|已收藏/.test(source));
ok("没有 isStarred / starred 本地状态（注释里的 API 路径不算）", !/starred/i.test(source.replace(/\/user\/starred/g, "")));

// ── 6. 结构不变式：star 是 tablist 的兄弟，不是子节点 ───────────────────────
{
  const rowAnchor = "h('div', { className: 'dsh-mcp-cats-row' },";
  const rowAt = source.indexOf(rowAnchor);
  const tablistAt = source.indexOf("h('div', { className: 'dsh-mcp-cats', role: 'tablist'", rowAt);
  const chipAt = source.indexOf("h(RepoStarChip, { call }),", rowAt);
  ok("顶栏外面套了 cats-row 容器", rowAt > 0);
  ok("tablist 在 cats-row 之内", tablistAt > rowAt, `row=${rowAt} tablist=${tablistAt}`);
  ok("star chip 排在 tablist **之后**（同级兄弟，不混进 tab 列表）", chipAt > tablistAt, `tablist=${tablistAt} chip=${chipAt}`);
  ok("chip 只挂一处（顶栏常驻，不在市场子页里重复出现）", (source.match(/h\(RepoStarChip, \{ call \}\)/g) || []).length === 1);
  // 闭合顺序：tablist 先关，再轮到 chip——用「chip 前一个右括号」粗验层级没写反。
  ok("chip 与 tablist 同缩进（真的在同一层）", (() => {
    const chipLine = source.slice(0, chipAt).split("\n").pop();
    const tablistLine = source.slice(0, tablistAt).split("\n").pop();
    return chipLine.match(/^\s*/)[0].length === tablistLine.match(/^\s*/)[0].length;
  })());
}

// ── 7. CSS：可点、可聚焦、动效可关 ──────────────────────────────────────────
ok("CSS：chip 有 pointer 且去掉链接下划线", /\.dsh-mcp-star\{(?=[^}]*cursor:pointer)(?=[^}]*text-decoration:none)/.test(source));
ok("CSS：键盘聚焦有可见轮廓", /\.dsh-mcp-star:focus-visible\{[^}]*outline:/.test(source));
ok("CSS：hover 时星形变色变形（图案会「活」）", /\.dsh-mcp-star:hover \.dsh-mcp-star-svg\{/.test(source));
ok("CSS：星屑与点击爆裂各有一套 keyframes", /@keyframes dshMcpStarTwinkle\{/.test(source) && /@keyframes dshMcpStarPop\{/.test(source));
ok("CSS：reduced-motion 下动效全停，但静态反馈保留", /\.dsh-mcp-star\.burst \.dsh-mcp-star-svg\{animation:none/.test(source)
  && /\.dsh-mcp-star:hover \.dsh-mcp-star-spark,\.dsh-mcp-star\.burst \.dsh-mcp-star-spark\{animation:none;opacity:\.9\}/.test(source));
ok("CSS：cats-row 让分类栏自由换行、chip 不抢宽度", /\.dsh-mcp-cats-row>\.dsh-mcp-cats\{flex:1 1 auto;min-width:0\}/.test(source));
ok("CSS：窄屏收起文字标签，只留图案与数字", /@media \(max-width:760px\)\{\.dsh-mcp-star\{[^}]*\}\.dsh-mcp-star-label\{display:none\}/.test(source));
ok("CSS：星形用主题感知的琥珀色（暗色套自动换档）", /\.dsh-mcp-star:hover \.dsh-mcp-star-svg\{color:var\(--mcp-cat-auto\)/.test(source));

// ── 8. 反向自测：证明上面的正则不是恒真 ─────────────────────────────────────
{
  const mutated = source.replace(/\.dsh-mcp-star:focus-visible\{[^}]*\}/, ".dsh-mcp-star:focus-visible{color:red}");
  ok("自测：抹掉 focus-visible 的 outline 后断言确实会失败", !/\.dsh-mcp-star:focus-visible\{[^}]*outline:/.test(mutated));
  const mutated2 = source.replace(/h\(RepoStarChip, \{ call \}\),/, "h('span', null),");
  ok("自测：把 chip 从兄弟位移走后结构断言确实会失败", (mutated2.match(/h\(RepoStarChip, \{ call \}\)/g) || []).length === 0);
  const mutated3 = chipRegion.replace("stars === null ? null :", "");
  ok("自测：去掉「读不到就不显示」的三元后诚实性断言确实会失败", mutated3 !== chipRegion);
}

// ── 9. 计数格式与市场侧同一套 ───────────────────────────────────────────────
ok("wbFormatCount 沿用市场缩写口径（1234 → 1.2k）", wbFormatCount(1234) === "1.2k", wbFormatCount(1234));

console.log(failed === 0 ? "REPO-STAR-CHIP PASS" : `${failed} CHECK(S) FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
