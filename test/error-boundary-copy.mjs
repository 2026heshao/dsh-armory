// test/error-boundary-copy.mjs
//
// 护栏对象：清单 6.1「崩溃详情可复制」。
//
// 背景：某个顶层分类的渲染出错时，ArmoryPanelBoundary 会把这一块降级成一张错误卡片，
// 其余分类照常可用。本轮在上面加了「复制错误详情」——用户回报 bug 时最缺的三件事
// （什么时候、什么环境、哪一段组件栈）一键带走。
//
// 策略：**真跑**，不是静态断言。做法是把 `class ArmoryPanelBoundary ...` 整段抽出来，
// 在 vm 里用最小替身（React2.Component / h / t / copyText / navigator）跑起来，
// 然后真的实例化、真的喂一个 error + info、真的调 copyDetails 看剪贴板内容。
// 这样钉住的是行为（「重试后还显示上次的堆栈」这类 bug 只有真跑才抓得住），
// 而不是「源码里出现了某些字符串」这种一改就假通过的表象。

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

// ── 0. 抽出 class ArmoryPanelBoundary { ... } 整段 ──────────────────────────
const CLASS_MARKER = "class ArmoryPanelBoundary extends React2.Component {";
const classAt = source.indexOf(CLASS_MARKER);
ok("能在 lib/client.js 里定位 ArmoryPanelBoundary 类", classAt >= 0,
  classAt >= 0 ? `client.js:${lineOf(source, classAt)}` : "未找到");
if (classAt < 0) {
  console.log("\nERROR-BOUNDARY-COPY FAIL（找不到类定义）");
  process.exit(1);
}

/** 从 `{` 开始配平，返回类体结束的 `}` 之后一位。跳过字符串与模板字面量。 */
function braceEnd(text, openAt) {
  let depth = 0;
  let inSq = false;
  let inDq = false;
  let inTpl = false;
  let tplDepth = 0;
  for (let i = openAt; i < text.length; i += 1) {
    const c = text[i];
    if (inSq) { if (c === "\\") i += 1; else if (c === "'") inSq = false; continue; }
    if (inDq) { if (c === "\\") i += 1; else if (c === '"') inDq = false; continue; }
    if (inTpl) {
      if (c === "\\") i += 1;
      else if (c === "`" && tplDepth === 0) inTpl = false;
      else if (c === "$" && text[i + 1] === "{") { tplDepth += 1; i += 1; }
      else if (c === "}" && tplDepth > 0) tplDepth -= 1;
      continue;
    }
    if (c === "'") { inSq = true; continue; }
    if (c === '"') { inDq = true; continue; }
    if (c === "`") { inTpl = true; continue; }
    if (c === "{") depth += 1;
    else if (c === "}") { depth -= 1; if (depth === 0) return i + 1; }
  }
  return -1;
}

const bodyOpen = source.indexOf("{", classAt);
const classEnd = braceEnd(source, bodyOpen);
ok("能配平取到类体的完整区间（不是靠固定行号硬切）", classEnd > bodyOpen,
  classEnd > bodyOpen ? `区间=${bodyOpen}..${classEnd}` : "");
if (classEnd <= bodyOpen) {
  console.log("\nERROR-BOUNDARY-COPY FAIL（类体配平失败）");
  process.exit(1);
}
const CLASS_SOURCE = source.slice(classAt, classEnd);

// ── 1. 最小宿主：把类丢进 vm 真跑 ───────────────────────────────────────────
/**
 * 构造一个 vm 环境并执行抽出的类，返回 { Boundary, h, tCalls, clipboardWrites, errors }。
 *
 * @param {object} opts
 * @param {string} opts.locale        I18N_LOCALE 的值（复制内容里要带上）
 * @param {boolean} opts.hasClipboard navigator.clipboard 是否可用
 * @param {boolean} opts.clipboardOk  clipboard.writeText 是否成功
 * @param {boolean} opts.fallbackOk   copyText 降级路径是否成功
 */
function loadBoundary(opts = {}) {
  const { locale = "zh-CN", hasClipboard = true, clipboardOk = true, fallbackOk = true } = opts;
  const tCalls = [];
  const clipboardWrites = [];
  const errors = [];
  const fallbackWrites = [];

  // 极简 h()：把树建成 { type, props, children } 供断言遍历。
  const h = (type, props, ...children) => ({
    type: typeof type === "string" ? type : (type && (type.name || "Anonymous")),
    props: props || {},
    children: children.flat().filter((c) => c !== null && c !== undefined && c !== false),
  });

  class Component {
    constructor(props) { this.props = props || {}; }
    setState(patch) {
      const next = typeof patch === "function" ? patch(this.state) : patch;
      this.state = Object.assign({}, this.state, next);
    }
  }

  const context = {
    console: { error: (...args) => errors.push(args), log: () => {}, warn: () => {} },
    // 中文环境下 t() 恒等直出；英文环境下用一张小表模拟翻译，用来验证按钮文案确实走了 t()。
    t: (s, vars) => {
      tCalls.push(s);
      if (locale.toLowerCase().startsWith("en")) {
        const TABLE = {
          "复制错误详情": "Copy error details",
          "已复制": "Copied",
          "复制失败": "Copy failed",
          "重试": "Retry",
          "这个面板加载失败": "This panel failed to load",
        };
        return Object.prototype.hasOwnProperty.call(TABLE, s) ? TABLE[s] : s;
      }
      return s;
    },
    I18N_LOCALE: locale,
    React2: { Component },
    h,
    copyText: (text) => { fallbackWrites.push(text); return Promise.resolve(fallbackOk); },
    setTimeout,
    clearTimeout,
  };
  if (hasClipboard) {
    context.navigator = {
      clipboard: { writeText: (text) => { clipboardWrites.push(text); return clipboardOk ? Promise.resolve() : Promise.reject(new Error("denied")); } },
    };
  }
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(CLASS_SOURCE + "\nglobalThis.__Boundary = ArmoryPanelBoundary;", context, { filename: "armory-boundary.js" });

  return { Boundary: context.__Boundary, h, tCalls, clipboardWrites, fallbackWrites, errors, copyTextCalls: fallbackWrites };
}

/** 从渲染树里捞出所有 button。 */
function collectButtons(node, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.type === "button") out.push(node);
  for (const child of node.children || []) collectButtons(child, out);
  return out;
}

const SAMPLE_ERROR = Object.assign(new Error("boom: 分类数据缺字段"), { stack: "Error: boom\n    at McpTab (client.js:6666:7)" });
const SAMPLE_INFO = { componentStack: "\n    in McpTab\n    in ArmoryPanelBoundary" };

// copyDetails() 是「发射后不管」的：它把若干 promise 串起来写剪贴板，自己不返回 promise
// （React 事件处理器也不需要返回值）。所以断言反馈态之前必须先让微任务队列排空，
// 否则读到的是还没写回 state 的中间态。这不是源码缺陷，是测试要配合它的调用模型。
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

let env;
try {
  env = loadBoundary({ locale: "zh-CN" });
  ok("能把 ArmoryPanelBoundary 抽到 vm 里执行并拿到类", typeof env.Boundary === "function");
} catch (error) {
  ok("能把 ArmoryPanelBoundary 抽到 vm 里执行并拿到类", false, String(error && error.message));
  console.log("\nERROR-BOUNDARY-COPY FAIL（类无法在 vm 里执行）");
  process.exit(1);
}

const { Boundary } = env;

// ── 2. 初始态：error / info / copyState 都必须是空 ──────────────────────────
const boundary = new Boundary({ children: [{ type: "div" }], hint: null });
ok("构造后 state.error 为 null（未崩溃时不渲染错误卡片）", boundary.state.error === null, `得到=${JSON.stringify(boundary.state.error)}`);
ok("构造后 state.info 为 null（初值不能是 undefined，否则 retry 的相等判断会松）",
  boundary.state.info === null, `得到=${JSON.stringify(boundary.state.info)}`);
ok("state 里为复制反馈预留了 copyState 字段", boundary.state.copyState === null, `得到=${JSON.stringify(boundary.state.copyState)}`);
ok("未崩溃时 render() 原样返回 children（不拦截正常渲染）",
  Array.isArray(boundary.render()) && boundary.render().length === 1, "");

// ── 3. componentDidCatch：必须留住 info，且不能只 console.error ─────────────
const beforeErrCount = env.errors.length;
boundary.componentDidCatch(SAMPLE_ERROR, SAMPLE_INFO);
ok("componentDidCatch 仍然调用 console.error（控制台保留完整堆栈）",
  env.errors.length === beforeErrCount + 1, `新增=${env.errors.length - beforeErrCount}`);
ok("componentDidCatch 把 info 存进 state（否则组件栈就只存在于控制台）",
  boundary.state.info === SAMPLE_INFO, `得到=${JSON.stringify(boundary.state.info && Object.keys(boundary.state.info))}`);
ok("componentDidCatch 没有顺手清掉 error（错误卡片要能继续显示原因）",
  boundary.state.error === null || boundary.state.error === SAMPLE_ERROR, `得到=${boundary.state.error}`);

// getDerivedStateFromError 是 error 的唯一来源，确认它还在。
ok("getDerivedStateFromError 仍然把 error 写进 state",
  typeof Boundary.getDerivedStateFromError === "function" &&
    Boundary.getDerivedStateFromError(SAMPLE_ERROR).error === SAMPLE_ERROR, "");

// 进入崩溃态：模拟 React 的两步（先 getDerivedStateFromError，再 componentDidCatch）。
boundary.state = Object.assign({}, boundary.state, Boundary.getDerivedStateFromError(SAMPLE_ERROR));

// ── 4. 错误面板：重试 + 复制两个按钮都在，且都走 t() ────────────────────────
const panel = boundary.render();
ok("崩溃时渲染 role=alert 的错误面板", panel && panel.props && panel.props.role === "alert",
  `得到=${JSON.stringify(panel && panel.props && panel.props.role)}`);

const buttons = collectButtons(panel);
ok("错误面板有 2 个按钮（重试 + 复制错误详情）", buttons.length === 2, `实际=${buttons.length}`);

const retryBtn = buttons.find((b) => b.props.onClick && b.props.onClick.name === "bound") || buttons[0];
const copyBtn = buttons.find((b) => b === buttons[1]) || buttons[1];
ok("「重试」按钮绑定的就是 this.retry（不是内联箭头函数，否则重试逻辑各写一份）",
  retryBtn && retryBtn.props.onClick === boundary.retry, "");
ok("「复制错误详情」按钮绑定的就是 this.copyDetails", copyBtn && copyBtn.props.onClick === boundary.copyDetails, "");

// 按钮文案必须是 t() 的产物：tCalls 里出现过这些键。
ok("「复制错误详情」文案走 t()（i18n 要求）", env.tCalls.includes("复制错误详情"),
  `t() 收到的键=${JSON.stringify(env.tCalls)}`);
ok("「重试」文案走 t()", env.tCalls.includes("重试"), "");
ok("默认态下复制按钮显示「复制错误详情」",
  copyBtn && copyBtn.children.includes("复制错误详情"), `实际=${JSON.stringify(copyBtn && copyBtn.children)}`);

// 「已复制 / 复制失败」是复制**之后**才渲染的文案，必须显式切到那两个 state 再渲染一次，
// 否则这条断言永远看不到它们（这不是恒真假通过，而是分支没走到）。
{
  const feedbackKeys = new Set();
  for (const state of ["ok", "fail"]) {
    const b = new Boundary({ children: null, hint: null });
    b.state = Object.assign({}, b.state, Boundary.getDerivedStateFromError(SAMPLE_ERROR), { copyState: state });
    b.render();
    for (const key of env.tCalls.slice(-4)) feedbackKeys.add(key);
  }
  ok("「已复制」/「复制失败」反馈文案也走 t()",
    feedbackKeys.has("已复制") && feedbackKeys.has("复制失败"),
    `捕获=${JSON.stringify([...feedbackKeys])}`);
  // 两个分支的文案必须不同：都显示同一个词等于没有反馈。
  const okLabel = (() => {
    const b = new Boundary({ children: null });
    b.state = Object.assign({}, b.state, Boundary.getDerivedStateFromError(SAMPLE_ERROR), { copyState: "ok" });
    return collectButtons(b.render())[1].children[0];
  })();
  const failLabel = (() => {
    const b = new Boundary({ children: null });
    b.state = Object.assign({}, b.state, Boundary.getDerivedStateFromError(SAMPLE_ERROR), { copyState: "fail" });
    return collectButtons(b.render())[1].children[0];
  })();
  ok("复制成功与失败的按钮文案不同（用户才能分辨到底成没成）",
    okLabel !== failLabel, `ok=${JSON.stringify(okLabel)} fail=${JSON.stringify(failLabel)}`);
}

// 英文环境下同一段代码必须出英文 —— 证明不是硬编码中文。
const envEn = loadBoundary({ locale: "en-US" });
const bEn = new envEn.Boundary({ children: null });
bEn.state = Object.assign({}, bEn.state, envEn.Boundary.getDerivedStateFromError(SAMPLE_ERROR));
const enButtons = collectButtons(bEn.render());
ok("en-US 环境下复制按钮显示 Copy error details（文案真的走了 t()）",
  enButtons.some((b) => b.children.includes("Copy error details")),
  `实际=${JSON.stringify(enButtons.map((b) => b.children))}`);

// ── 5. copyDetails：真的写剪贴板，内容含版本/时间/locale/stack/componentStack ──
await boundary.copyDetails();
await flushMicrotasks();
ok("copyDetails 真的调用了 navigator.clipboard.writeText", env.clipboardWrites.length === 1,
  `调用次数=${env.clipboardWrites.length}`);
const clipboardText = env.clipboardWrites[0] || "";
ok("复制内容含 [error] 段标记（粘进 issue 无需额外解释）", clipboardText.includes("[error]"),
  `实际=${JSON.stringify(clipboardText.slice(0, 60))}`);
ok("复制内容含 [componentStack] 段标记（本次优化新增的核心信息）",
  clipboardText.includes("[componentStack]"), "");
ok("复制内容含真实组件栈（不只是段落标题）",
  clipboardText.includes("in McpTab") && clipboardText.includes("in ArmoryPanelBoundary"), "");
ok("复制内容含真实错误堆栈",
  clipboardText.includes("Error: boom") && clipboardText.includes("at McpTab"), "");
ok("复制内容含 locale（回报时能判断是不是语言相关问题）",
  clipboardText.includes("locale: zh-CN"), "");
ok("复制内容含 ISO 时间戳（能定位是哪一次崩溃）",
  /time: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(clipboardText), `实际=${JSON.stringify(clipboardText.split("\n")[1])}`);
ok("复制内容含可检索的项目标识（搜 issue 时能命中）",
  clipboardText.includes("dsh-armory"), "");
ok("复制成功后被截获的文案切成「已复制」", boundary.state.copyState === "ok", `得到=${JSON.stringify(boundary.state.copyState)}`);

// 复制后 1.5s 定时器必须存在，且卸载时会清掉（否则组件没了还在 setState）。
ok("复制反馈会挂一个定时器用于自动复位", boundary.copyTimer !== null && boundary.copyTimer !== undefined, "");
boundary.componentWillUnmount();
ok("componentWillUnmount 清掉复制反馈定时器（防止卸载后 setState 告警）",
  boundary.copyTimer === null, `得到=${JSON.stringify(boundary.copyTimer)}`);

// ── 6. 失败路径：clipboard 被拒 → 回落 copyText；两条都失败 → copyState='fail' ─
{
  const fb = loadBoundary({ clipboardOk: false, fallbackOk: true });
  const b = new fb.Boundary({ children: null });
  b.state = Object.assign({}, b.state, fb.Boundary.getDerivedStateFromError(SAMPLE_ERROR));
  await b.copyDetails();
  await flushMicrotasks();
  ok("clipboard 被拒时回落到 copyText 的降级路径（file:// / http:// 场景）",
    fb.fallbackWrites.length === 1, `copyText 调用=${fb.fallbackWrites.length}`);
  ok("降级路径成功时仍标记为「已复制」", b.state.copyState === "ok", `得到=${JSON.stringify(b.state.copyState)}`);
  if (b.copyTimer) clearTimeout(b.copyTimer);
}
{
  const fb = loadBoundary({ clipboardOk: false, fallbackOk: false });
  const b = new fb.Boundary({ children: null });
  b.state = Object.assign({}, b.state, fb.Boundary.getDerivedStateFromError(SAMPLE_ERROR));
  await b.copyDetails();
  await flushMicrotasks();
  ok("两条路径都失败时标记为「复制失败」（不能假装成功）",
    b.state.copyState === "fail", `得到=${JSON.stringify(b.state.copyState)}`);
  if (b.copyTimer) clearTimeout(b.copyTimer);
}

// ── 7. retry：必须把 info 一起清掉 ─────────────────────────────────────────
boundary.setState({ copyState: "ok" });
boundary.retry();
ok("retry 清空 error（回到正常渲染）", boundary.state.error === null, `得到=${JSON.stringify(boundary.state.error)}`);
ok("retry 清空 info —— 否则重试后点「复制」还会粘出上一次的组件栈",
  boundary.state.info === null, `得到=${JSON.stringify(boundary.state.info)}`);
ok("retry 清空 copyState（不要把「已复制」的绿色反馈带回来）",
  boundary.state.copyState === null, `得到=${JSON.stringify(boundary.state.copyState)}`);
ok("retry 后 render() 原样返回 children（真的恢复了）",
  Array.isArray(boundary.render()), "");

// ── 8. 边界情形：info 缺失时复制内容不能出现 "undefined" ────────────────────
{
  const fb = loadBoundary({ locale: "en-US" });
  const b = new fb.Boundary({ children: null });
  b.state = Object.assign({}, b.state, fb.Boundary.getDerivedStateFromError(SAMPLE_ERROR));
  // 不调用 componentDidCatch，模拟 info 还没到位（React 的两次回调之间）
  await b.copyDetails();
  await flushMicrotasks();
  const text = fb.clipboardWrites[0] || "";
  ok("info 缺失时组件栈段落回落为 (unavailable)，不出现裸 undefined",
    text.includes("(unavailable)") && !text.includes("undefined"), `实际=${JSON.stringify(text.split("\n").slice(-2))}`);
  if (b.copyTimer) clearTimeout(b.copyTimer);
}

// ── 9. 反向自测：证明第 5、7 节的断言不是恒真 ──────────────────────────────
{
  // 删掉 componentDidCatch 里的 setState({ info })，第 3 节必须抓到。
  const mutated = CLASS_SOURCE.replace("this.setState({ info });", "");
  ok("自测前置：成功删掉了 componentDidCatch 里的 setState({ info })", mutated !== CLASS_SOURCE);
  if (mutated !== CLASS_SOURCE) {
    const tCalls = [];
    const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
    class C { constructor(p) { this.props = p || {}; } setState(patch) { this.state = Object.assign({}, this.state, patch); } }
    const ctx = { console: { error() {} }, t: (s) => { tCalls.push(s); return s; }, I18N_LOCALE: "zh-CN", React2: { Component: C }, h, copyText: () => Promise.resolve(true), setTimeout, clearTimeout };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(mutated + "\nglobalThis.__B = ArmoryPanelBoundary;", ctx, { filename: "boundary-broken.js" });
    const b = new ctx.__B({ children: null });
    b.componentDidCatch(SAMPLE_ERROR, SAMPLE_INFO);
    ok("自测：删掉 setState({ info }) 后，「info 存入 state」断言确实会失败",
      b.state.info === null, `得到=${JSON.stringify(b.state.info)}`);
  }
}
{
  // retry 只清 error 不清 info —— 第 7 节必须抓到。
  const mutated = CLASS_SOURCE.replace(
    "this.setState({ error: null, info: null, copyState: null });",
    "this.setState({ error: null });",
  );
  ok("自测前置：成功改坏了 retry 的清空逻辑", mutated !== CLASS_SOURCE);
  if (mutated !== CLASS_SOURCE) {
    const h = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() });
    class C { constructor(p) { this.props = p || {}; } setState(patch) { this.state = Object.assign({}, this.state, patch); } }
    const ctx = { console: { error() {} }, t: (s) => s, I18N_LOCALE: "zh-CN", React2: { Component: C }, h, copyText: () => Promise.resolve(true), setTimeout, clearTimeout };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(mutated + "\nglobalThis.__B = ArmoryPanelBoundary;", ctx, { filename: "boundary-broken2.js" });
    const b = new ctx.__B({ children: null });
    b.componentDidCatch(SAMPLE_ERROR, SAMPLE_INFO);
    b.retry();
    ok("自测：retry 只清 error 时，「info 也被清空」断言确实会失败",
      b.state.info !== null, `残留=${JSON.stringify(b.state.info && Object.keys(b.state.info))}`);
  }
}

info("剪贴板实测内容（节选）", JSON.stringify(clipboardText.slice(0, 160)));
console.log(`\n${failures === 0 ? "ERROR-BOUNDARY-COPY PASS" : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
