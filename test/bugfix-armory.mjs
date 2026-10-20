// QA 独立回归：dsh-armory 双 Bug 修复（Bug 1「去市场找现成的」跳错页 / Bug 2 首次进入看板页整体偏下 40px）。
//
// 本文件是**只读验证**套件：不 import lib/ 的任何运行时依赖（宿主模块一律不可用），
// 而是沿用仓库既有风格（见 client-entry.mjs / error-boundary-copy.mjs）：
//   1) 静态契约断言：对 lib/client.js 原文做规则级检查（CSS 规则是否存在、是否唯一）；
//   2) vm 真跑：把源码切片抽出来在隔离上下文里执行，对**行为**断言而不是对文本断言。
//
// 为什么不能只测文本：Bug 1 的根因是「调用了会 toggle 的 openBoardPanel」，Bug 2 的根因是
// 「用 100dvh 反算高度」。这两个都是**行为**缺陷，正则改一改就能骗过文本断言，只有真跑
// 函数 / 真算高度账才能证明修好了。因此本套件同时给出「正向证明」与「反向自测（mutation
// test）」——把旧写法注回去，断言必须失败，否则说明正向断言是空转。
//
// 运行：node ./test/bugfix-armory.mjs（同时也经 test/run-all.mjs 白名单随全量跑）
// 退出码：0 全过；1 有失败。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 必须走 fileURLToPath：本仓库路径含中文，URL.pathname 是百分号编码的。
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "..", "lib", "client.js");

// ── 断言脚手架（与仓库其它套件同风格：一行一条 PASS/FAIL，失败累计而非立即中止）──────
let failures = 0;
let checks = 0;
const ok = (name, condition, extra = "") => {
	checks += 1;
	const pass = !!condition;
	if (!pass) failures += 1;
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
	return pass;
};
const section = (title) => console.log(`\n── ${title} ─────────────────────────────────────────────`);

const source = await readFile(CLIENT, "utf8");

// ═══════════════════════════════════════════════════════════════════════════
// 第 0 节 · 源码定位（标记缺失即整体失败，避免「测了个空」）
// ═══════════════════════════════════════════════════════════════════════════
section("0. 源码定位");
const MARK = {
	panelId: "const PANEL_ID = 'mcp-manager';",
	cats: "const BOARD_CATEGORIES = [",
	hashStart: "const readHashParam = (name) => {",
	hashEnd: "\nconst CONTROLS_THRESHOLD = 6;",
	moduleCtx: "const MODULE_CTX = { ctx: null };",
	moduleCtxEnd: "\n// ── 面板错误边界",
	listeners: "const boardCategoryListeners = new Set();",
	pending: "let pendingBoardCategory = '';",
	mountStart: "  const [category, setCategoryState] = useState(() => {",
	mountEnd: "  }, [setCategory]);",
	css: "const MCP_CSS = `",
};
const missing = Object.entries(MARK).filter(([, needle]) => !source.includes(needle)).map(([k]) => k);
ok("所有抽取标记都能在 lib/client.js 里定位到（含新增的 pendingBoardCategory）", missing.length === 0, missing.length ? `缺失=${missing.join(",")}` : "");

// 抽取 helper：从起止标记之间取**源码原文**（含首尾标记），找不到就抛，绝不静默返回空串。
const sliceBetween = (startMark, endMark) => {
	const startAt = source.indexOf(startMark);
	if (startAt < 0) throw new Error(`找不到起始标记：${startMark}`);
	const endAt = source.indexOf(endMark, startAt + startMark.length);
	if (endAt <= startAt) throw new Error(`找不到结束标记：${endMark}`);
	return source.slice(startAt, endAt + endMark.length);
};
// 从 `const NAME = ` 起，到行首 `];` 止（对象/数组字面量的通用取法）。
const sliceLiteral = (decl) => {
	const startAt = source.indexOf(decl);
	if (startAt < 0) throw new Error(`找不到声明：${decl}`);
	const endAt = source.indexOf("\n];", startAt);
	if (endAt < 0) throw new Error(`字面量未闭合：${decl}`);
	return source.slice(startAt, endAt + 3);
};

const PANEL_ID_SRC = MARK.panelId.match(/'([^']+)'/)[1];
ok("PANEL_ID 的取值是 mcp-manager（看板页在 main slot 的 key）", PANEL_ID_SRC === "mcp-manager", `PANEL_ID=${PANEL_ID_SRC}`);

// ═══════════════════════════════════════════════════════════════════════════
// 第 1 节 · Bug 1 核心：把「跳转」这条链在 vm 里真跑
// ═══════════════════════════════════════════════════════════════════════════
//
// 抽三段源码拼成一份**最小可执行模块**：
//   A. readHashParam / writeHashParams  —— 真的读写真 location/history
//   B. PANEL_ID + BOARD_CATEGORIES       —— 白名单的真实来源
//   C. MODULE_CTX + openBoardPanel + boardCategoryListeners + selectBoardPanel + openBoardCategory
//      （从 MODULE_CTX 到 McpBoardPage 之前，中间只有错误边界那一节）
// 拼装时保留原注释与顺序，只裁掉与本链无关的组件定义。

const SLICE_HASH = sliceBetween(MARK.hashStart, MARK.hashEnd);
const SLICE_PANELID = MARK.panelId;
const SLICE_CATEGORIES = sliceLiteral(MARK.cats);
const SLICE_TRANSITION = (() => {
	// 从 MODULE_CTX 到「面板错误边界」之前：正好是 openBoardPanel。
	const a = source.indexOf(MARK.moduleCtx);
	const b = source.indexOf(MARK.moduleCtxEnd, a);
	const head = source.slice(a, b);
	// boardCategoryListeners 声明在文件更后面（McpBoardPage 注释前），单独补一行。
	const listeners = MARK.listeners;
	if (!source.includes(listeners)) throw new Error("找不到 boardCategoryListeners 声明");
	// pendingBoardCategory / selectBoardPanel / openBoardCategory 在文件更后面（McpBoardPage 之前）。
	const c = source.indexOf(MARK.pending);
	const d = source.indexOf(MARK.mountStart, c);
	// 从 pending 那一行往前找到它前面的注释块起点，再截到 McpBoardPage 定义之前。
	const commentStart = source.lastIndexOf("\n// 跨分类跳转的 pending", c);
	const fromC = commentStart >= 0 ? commentStart : c;
	const tail = source.slice(fromC, source.lastIndexOf("\nconst McpBoardPage", d));
	return [head, listeners, tail].join("\n");
})();

ok("拼装出的跳转链片段同时包含 openBoardPanel 与 openBoardCategory", SLICE_TRANSITION.includes("function openBoardPanel()") && SLICE_TRANSITION.includes("function openBoardCategory(key)"));
// openMcpQuery 及其依赖的 pendingMcpQuery / mcpQueryListeners / onMcpQuery / emitMcpRefresh。
// 单独抽一段：它不在 openBoardPanel→openBoardCategory 那条链上，而在命令面板那一节里，
// 且**依赖 openBoardCategory**（尾行 openBoardCategory('mcp')），所以必须与 SLICE_TRANSITION
// 拼进同一个 vm 作用域才能跑。
const SLICE_MCPQUERY = (() => {
	const a = source.indexOf("let pendingMcpQuery = '';");
	if (a < 0) throw new Error("找不到 pendingMcpQuery 声明");
	// 从它的注释块起点算起，截到 openMcpQuery 定义结束（onMcpQuery 之前的那行 `};`）。
	const commentStart = source.lastIndexOf("\n// 跨组件通道", a);
	const from = commentStart >= 0 ? commentStart : a;
	const fnStart = source.indexOf("function openMcpQuery(name) {", from);
	if (fnStart < 0) throw new Error("找不到 openMcpQuery 定义");
	const fnEnd = source.indexOf("\n}", fnStart);
	return source.slice(from, fnEnd + 2);
})();
ok("抽到了 openMcpQuery 片段（含 pendingMcpQuery 与 mcpQueryListeners）",
	SLICE_MCPQUERY.includes("function openMcpQuery(name)") && SLICE_MCPQUERY.includes("let pendingMcpQuery = '';") && SLICE_MCPQUERY.includes("const mcpQueryListeners = new Set();"));

// 替身宿主：layout 记录每一次 selectPanel 调用，panelInfo 可设当前面板。
const createHarness = ({ hash = "", activePanelId = undefined, selectPanelThrows = false, hasLayout = true } = {}) => {
	const calls = [];
	const state = { hash, pathname: "/", search: "", replaced: [] };
	const location = {
		get hash() { return state.hash; },
		set hash(v) { state.hash = v; },
		get pathname() { return state.pathname; },
		get search() { return state.search; },
	};
	const history = {
		replaceState(_a, _b, url) {
			state.replaced.push(url);
			const at = String(url).indexOf("#");
			state.hash = at < 0 ? "" : String(url).slice(at);
		},
	};
	const layout = hasLayout
		? {
			panelInfo: { getSnapshot: () => ({ activePanelId }) },
			selectPanel(id) {
				calls.push(id);
				if (selectPanelThrows) throw new Error("main slot entry not registered");
			},
		}
		: null;
	const ctx = { get: (name) => (name === "layout" ? layout : null) };
	const context = vm.createContext({
		console, location, history, ctx,
		t: (s) => s,
		MODULE_CTX: undefined, // 由片段自己声明
	});
	const epilogue = `
		MODULE_CTX.ctx = ctx;
		globalThis.__probe = {
			PANEL_ID, BOARD_CATEGORIES, boardCategoryListeners, openBoardCategory, openBoardPanel, selectBoardPanel,
			openMcpQuery, mcpQueryListeners,
			getPending: () => pendingBoardCategory,
			getPendingMcpQuery: () => pendingMcpQuery,
		};`;
	vm.runInContext([SLICE_HASH, SLICE_PANELID, SLICE_CATEGORIES, SLICE_TRANSITION, SLICE_MCPQUERY, epilogue].join("\n"), context, {
		filename: "qa-bug1-transition.js",
	});
	return { probe: context.__probe, calls, state, ctx, layout, context };
};

// 正常装载一次，确认片段在这套替身宿主下真的能跑（不是所有断言都建立在异常上）。
const smoke = createHarness({ hash: "", activePanelId: undefined });
ok("跳转链片段能在替身宿主里独立执行起来", typeof smoke.probe.openBoardCategory === "function", `calls=${smoke.calls.length}`);

const KEYS = smoke.probe.BOARD_CATEGORIES.map((c) => c.key);
ok("BOARD_CATEGORIES 恰好是 mcp/skill/expert/tailor/wb 五个分类", KEYS.join(",") === "mcp,skill,expert,tailor,wb", `keys=${KEYS.join(",")}`);
ok("PANEL_ID 与源码字面量一致", smoke.probe.PANEL_ID === PANEL_ID_SRC, `probe=${smoke.probe.PANEL_ID}`);

section("1. Bug 1 · openBoardCategory 的行为（未挂载 / 已挂载 / 幂等 / 非法值）");

// 1.1 未挂载（activePanelId 不是 PANEL_ID）：必须强制选中 PANEL_ID，且**只**选一次。
{
	const h = createHarness({ hash: "", activePanelId: undefined });
	h.probe.openBoardCategory("wb");
	ok("1.1a openBoardCategory('wb') 后 pendingBoardCategory === 'wb'", h.probe.getPending() === "wb", `pending=${JSON.stringify(h.probe.getPending())}`);
	ok("1.1b 未挂载时强制选中看板面板（selectPanel(PANEL_ID) 恰好一次）", h.calls.length === 1 && h.calls[0] === smoke.probe.PANEL_ID, `calls=${JSON.stringify(h.calls)}`);
	ok("1.1c 未挂载时**不**会把面板关掉（绝不调用 selectPanel(null)）", h.calls.every((id) => id !== null), `calls=${JSON.stringify(h.calls)}`);
}

// 1.2 已挂载（activePanelId === PANEL_ID）：修复前这里会被 toggle 成 null 踢回会话。
{
	const h = createHarness({ hash: "#armory=mcp", activePanelId: smoke.probe.PANEL_ID });
	h.probe.openBoardCategory("wb");
	ok("1.2a 已挂载看板页时点「去市场」仍是选中看板（不被 toggle 回会话）", h.calls.length === 1 && h.calls[0] === smoke.probe.PANEL_ID, `calls=${JSON.stringify(h.calls)}`);
	ok("1.2b 已挂载时也不产生 selectPanel(null)", !h.calls.includes(null), `calls=${JSON.stringify(h.calls)}`);
	ok("1.2c 已挂载时 pending 仍被写入（供广播不可达时兜底）", h.probe.getPending() === "wb");
}

// 1.3 对比：openBoardPanel 的 toggle 语义**必须保留**（入口按钮靠它回对话）。
{
	const h = createHarness({ hash: "", activePanelId: smoke.probe.PANEL_ID });
	h.probe.openBoardPanel();
	ok("1.3a openBoardPanel 在已挂载时仍 toggle 成 null（再点一次回对话，语义未变）", h.calls.length === 1 && h.calls[0] === null, `calls=${JSON.stringify(h.calls)}`);
	const h2 = createHarness({ hash: "", activePanelId: undefined });
	h2.probe.openBoardPanel();
	ok("1.3b openBoardPanel 在未挂载时仍选中 PANEL_ID", h2.calls.length === 1 && h2.calls[0] === smoke.probe.PANEL_ID, `calls=${JSON.stringify(h2.calls)}`);
}

// 1.4 白名单：非法 key 直接 return，pending 与 layout 都不得被动。
{
	const h = createHarness({ hash: "#armory=skill", activePanelId: undefined });
	h.probe.openBoardCategory("nonexistent");
	ok("1.4a openBoardCategory('nonexistent') 不写 pending", h.probe.getPending() === "", `pending=${JSON.stringify(h.probe.getPending())}`);
	ok("1.4b 非法 key 不触发任何 selectPanel（不劫持用户当前页面）", h.calls.length === 0, `calls=${JSON.stringify(h.calls)}`);
	for (const bad of ["", null, undefined, "__proto__", "constructor", "MCP", "wb ", 42, {}, []]) {
		const hh = createHarness({ hash: "", activePanelId: undefined });
		hh.probe.openBoardCategory(bad);
		ok(`1.4c 非法 key ${JSON.stringify(bad)} 被忽略（pending 空、无 selectPanel）`,
			hh.probe.getPending() === "" && hh.calls.length === 0,
			`pending=${JSON.stringify(hh.probe.getPending())} calls=${JSON.stringify(hh.calls)}`);
	}
}

// 1.5 广播：已挂载的订阅者要收到 key；单个订阅者抛错不得拖累其它订阅者与后续选中。
{
	const h = createHarness({ hash: "", activePanelId: undefined });
	const seen = [];
	let threw = 0;
	h.probe.boardCategoryListeners.add(() => { threw += 1; throw new Error("subscriber boom"); });
	h.probe.boardCategoryListeners.add((key) => seen.push(key));
	let escaped = null;
	try { h.probe.openBoardCategory("expert"); } catch (error) { escaped = error; }
	ok("1.5a 单个订阅者抛错不会让 openBoardCategory 抛出", escaped === null, escaped ? String(escaped.message) : "");
	ok("1.5b 抛错的订阅者之后的订阅者仍然收到广播", seen.length === 1 && seen[0] === "expert", `seen=${JSON.stringify(seen)}`);
	ok("1.5c 订阅者抛错不影响后续的 selectBoardPanel", h.calls.length === 1 && h.calls[0] === smoke.probe.PANEL_ID, `calls=${JSON.stringify(h.calls)}`);
	ok("1.5d 抛错的订阅者确实被执行过（证明上一条不是没进循环）", threw === 1);
}

// 1.6 宿主不可用 / 宿主抛错：入口没响应也不能炸掉调用方。
{
	const noLayout = createHarness({ hasLayout: false });
	let escaped = null;
	try { noLayout.probe.openBoardCategory("mcp"); } catch (error) { escaped = error; }
	ok("1.6a layout 不可用时 openBoardCategory 不抛错", escaped === null, escaped ? String(escaped.message) : "");
	ok("1.6b layout 不可用时 pending 仍写入（等宿主就绪后兜底）", noLayout.probe.getPending() === "mcp");

	const throwing = createHarness({ selectPanelThrows: true });
	escaped = null;
	try { throwing.probe.openBoardCategory("tailor"); } catch (error) { escaped = error; }
	ok("1.6c selectPanel 抛错（main slot 未注册）时被吞掉，不冒泡到调用方", escaped === null, escaped ? String(escaped.message) : "");
	ok("1.6d selectPanel 抛错时 pending 已落定（跳转意图不丢）", throwing.probe.getPending() === "tailor");
}

// ── 1.7 Bug 1 第 5 条：openMcpQuery 必须走同一套修复路径 ──────────────────────────
// openMcpQuery 原本尾行就是 openBoardCategory('mcp')。它的风险与 Bug 1 同源：
// 如果哪天有人为了「打开面板」把它改写成 openBoardPanel()，命令面板选中一台 MCP 后
// 就会把已在看板页的用户 toggle 回会话。这里把两条性质都钉住。
{
	// 1.7a 未挂载：搜索一台 MCP → 强制选中看板面板 + 分类 pending = mcp + 查询 pending 落定。
	const h = createHarness({ hash: "", activePanelId: undefined });
	h.probe.openMcpQuery("some-server");
	ok("1.7a 未挂载时 openMcpQuery 强制选中看板面板（selectPanel(PANEL_ID) 恰好一次）",
		h.calls.length === 1 && h.calls[0] === smoke.probe.PANEL_ID, `calls=${JSON.stringify(h.calls)}`);
	ok("1.7b 未挂载时 openMcpQuery 把分类 pending 置为 'mcp'", h.probe.getPending() === "mcp",
		`pending=${JSON.stringify(h.probe.getPending())}`);
	ok("1.7c openMcpQuery 落定 pendingMcpQuery（供 McpTab 挂载后自领）",
		h.probe.getPendingMcpQuery() === "some-server", `pendingMcpQuery=${JSON.stringify(h.probe.getPendingMcpQuery())}`);

	// 1.7d 已挂载：再搜一台，绝不能被 toggle 回会话（这正是 Bug 1 的形态）。
	const h2 = createHarness({ hash: "#armory=skill", activePanelId: smoke.probe.PANEL_ID });
	h2.probe.openMcpQuery("another-server");
	ok("1.7d 已挂载看板页时 openMcpQuery 仍选中看板（不产生 selectPanel(null)）",
		h2.calls.length === 1 && h2.calls[0] === smoke.probe.PANEL_ID && !h2.calls.includes(null),
		`calls=${JSON.stringify(h2.calls)}`);

	// 1.7e 空 / 空白名字：直接 return，不得劫持页面（命令面板可能在防抖窗口里传空串）。
	for (const blank of ["", "   ", null, undefined]) {
		const hb = createHarness({ hash: "", activePanelId: undefined });
		hb.probe.openMcpQuery(blank);
		ok(`1.7e openMcpQuery(${JSON.stringify(blank)}) 不触发任何 selectPanel、不写 pending`,
			hb.calls.length === 0 && hb.probe.getPending() === "" && hb.probe.getPendingMcpQuery() === "",
			`calls=${JSON.stringify(hb.calls)} pending=${JSON.stringify(hb.probe.getPending())}`);
	}

	// 1.7f 名字两端空白会被 trim（命令面板粘贴带空格的名字要能匹配上）。
	const h3 = createHarness({ hash: "", activePanelId: undefined });
	h3.probe.openMcpQuery("  padded  ");
	ok("1.7f openMcpQuery 对名字做 trim 后落定", h3.probe.getPendingMcpQuery() === "padded",
		`pendingMcpQuery=${JSON.stringify(h3.probe.getPendingMcpQuery())}`);

	// 1.7g 订阅者抛错不得阻断跳转（与 1.5 同一契约，但走的是 mcpQueryListeners 这条）。
	const h4 = createHarness({ hash: "", activePanelId: undefined });
	let seenQuery = null;
	h4.probe.mcpQueryListeners.add(() => { throw new Error("query subscriber boom"); });
	h4.probe.mcpQueryListeners.add((name) => { seenQuery = name; });
	let escaped = null;
	try { h4.probe.openMcpQuery("target"); } catch (error) { escaped = error; }
	ok("1.7g mcpQuery 订阅者抛错时不冒泡，且不影响后续 selectPanel",
		escaped === null && h4.calls.length === 1 && h4.calls[0] === smoke.probe.PANEL_ID,
		escaped ? String(escaped.message) : `calls=${JSON.stringify(h4.calls)}`);
	ok("1.7h 抛错的订阅者之后的订阅者仍收到查询名", seenQuery === "target", `seen=${JSON.stringify(seenQuery)}`);
}

section("2. Bug 1 · McpBoardPage 的分类状态机（挂载自领 / 广播领取 / 回落）");
//
// 真跑组件里的 hooks 太依赖 React 运行时，这里把「与分类有关的三个 hook」原文抽出来，
// 用极简 hooks 替身驱动：useState 惰性初值只跑一次、useEffect 在 mount 时跑一次并返回
// cleanup、useCallback 直接透传。这样断言的是**源码逻辑本身**，不是重写过的等价物。

const MOUNT_SLICE = sliceBetween(MARK.mountStart, MARK.mountEnd);
ok("2.0 抽到了分类状态机片段（useState 惰性初值 + useEffect + cleanup）",
	MOUNT_SLICE.includes("useState(() => {") && MOUNT_SLICE.includes("useEffect(() => {") && MOUNT_SLICE.includes("boardCategoryListeners.delete(listener)"),
	`len=${MOUNT_SLICE.length}`);

// 极简 React hooks 替身：每个组件的实例各自持有一份 state 数组。
const mountComponent = ({ pending = "", hash = "", listeners: externalListeners = null, mountSlice = MOUNT_SLICE } = {}) => {
	const state = { hash: hash ? (hash.startsWith("#") ? hash : `#${hash}`) : "", writes: [] };
	const location = { get hash() { return state.hash; }, pathname: "/", search: "" };
	const history = {
		replaceState(_a, _b, url) {
			state.writes.push(url);
			const at = String(url).indexOf("#");
			state.hash = at < 0 ? "" : String(url).slice(at);
		},
	};
	const listeners = externalListeners || new Set();
	let slots = [];
	let inits = []; // 记录每个 useState 惰性初值的**求值结果**（首帧真值，早于 effect）
	let cursor = 0;
	const context = vm.createContext({
		console, location, history, listeners,
		t: (s) => s,
		pendingBoardCategory: pending,
		boardCategoryListeners: listeners,
		useState(init) { const i = cursor++; if (!(i in slots)) { inits[i] = init(); slots[i] = { value: inits[i] }; } return [slots[i].value, (v) => { slots[i].value = v; }]; },
		useCallback(fn) { cursor++; return fn; },
		useEffect(fn) { cursor++; const cleanup = fn(); slots.__cleanups = slots.__cleanups || []; if (typeof cleanup === "function") slots.__cleanups.push(cleanup); },
	});
	// 片段依赖 readHashParam / writeHashParams / BOARD_CATEGORIES：把源码原文一并注入，
	// 声明在同一个函数作用域里（不能用 sandbox 全局，否则 `return focus` 之类的逻辑会串）。
	const body = `(function () {\n${SLICE_HASH}\n${SLICE_PANELID}\n${SLICE_CATEGORIES}\n${mountSlice}\nreturn { get: () => category, getPending: () => pendingBoardCategory, listeners: boardCategoryListeners };\n})()`;
	const run = () => {
		cursor = 0;
		slots = [];
		inits = [];
		const api = vm.runInContext(body, context, { filename: "qa-bug1-mount.js" });
		return api;
	};
	const api = run();
	return {
		api,
		context,
		// 注意：不能返回 `api.get()`。片段里的 `category` 是 useState 解构出来的**当帧绑定**，
		// 永远等于初值，读它会让「广播后切换」这一类断言恒假。真正的状态在 hooks 替身的
		// slots[0]（MOUNT_SLICE 的第一个 hook 就是分类 useState），所以这里直接读 cells。
		getCategory: () => (slots[0] ? slots[0].value : undefined),
		// 首帧惰性初值：这是唯一能在 effect 之前观测「初值优先级」的口子。
		getFirstInit: () => inits[0],
		listen: () => [...listeners],
		unmount: () => { (slots.__cleanups || []).forEach((fn) => fn()); },
		getPending: () => vm.runInContext("pendingBoardCategory", context),
		setPending: (v) => vm.runInContext(`pendingBoardCategory = ${JSON.stringify(v)};`, context),
		hash: () => state.hash,
		writes: () => state.writes,
	};
};

// 2.1 首帧：pending 压过 hash（这正是「未挂载时跳转」的救命路径）。
{
	const c = mountComponent({ pending: "wb", hash: "armory=mcp" });
	ok("2.1a 首帧分类 = pending('wb')，压过 hash 里的 mcp", c.getCategory() === "wb", `category=${c.getCategory()}`);
	ok("2.1b useEffect 挂载后 pending 被清空（不会劫持下一次挂载）", c.getPending() === "", `pending=${JSON.stringify(c.getPending())}`);
	ok("2.1c 领到 pending 后把分类写进 hash（URL 可刷新/可分享）", c.hash().includes("armory=wb"), `hash=${c.hash()}`);
}

// 2.2 无 pending 有 hash：沿用 hash 记忆。
{
	const c = mountComponent({ pending: "", hash: "armory=expert" });
	ok("2.2a 无 pending 时回落 hash 记忆（expert）", c.getCategory() === "expert", `category=${c.getCategory()}`);
}

// 2.3 无 pending 无 hash：回落 mcp，且**不得写 hash**（不污染 URL）。
{
	const c = mountComponent({ pending: "", hash: "" });
	ok("2.3a 无 pending 无 hash → 回落 mcp", c.getCategory() === "mcp", `category=${c.getCategory()}`);
	ok("2.3b 回落默认分类时不写 hash（URL 不被污染）", c.writes().length === 0, `writes=${JSON.stringify(c.writes())}`);
}

// 2.4 pending 为非法值：不得劫持，回落 hash。
{
	const c = mountComponent({ pending: "not-a-category", hash: "armory=skill" });
	ok("2.4a pending 非法时不被劫持，回落 hash 的 skill", c.getCategory() === "skill", `category=${c.getCategory()}`);
	ok("2.4b pending 非法时在挂载阶段被丢弃（清空）", c.getPending() === "", `pending=${JSON.stringify(c.getPending())}`);
}

// 2.5 已挂载后的广播：领到就切、并清 pending；同分类幂等；非法 key 忽略。
{
	const c = mountComponent({ pending: "", hash: "armory=mcp" });
	c.setPending("wb");
	const listener = c.listen()[0];
	ok("2.5a 已挂载后恰好注册了 1 个分类订阅者", c.listen().length === 1, `listeners=${c.listen().length}`);

	listener("wb");
	ok("2.5b 广播 wb：分类由 mcp 切到 wb", c.getCategory() === "wb", `category=${c.getCategory()}`);
	ok("2.5c 广播领取后 pending 被清空", c.getPending() === "", `pending=${JSON.stringify(c.getPending())}`);
	ok("2.5d 广播领取后写 hash armory=wb", c.hash().includes("armory=wb"), `hash=${c.hash()}`);

	const writesBefore = c.writes().length;
	let escaped = null;
	try { listener("wb"); } catch (error) { escaped = error; }
	ok("2.5e 同分类重复广播：仍为 wb 且不抛错（幂等）", c.getCategory() === "wb" && escaped === null, escaped ? String(escaped.message) : "");
	// 源码的 listener 不做「同值短路」：它无条件 setCategory(key)，而 setCategory 内部总会
	// writeHashParams。replaceState 到同一个 URL 是无副作用的（不会新增历史条目），所以契约是
	// 「URL 的**值**幂等」，不是「一次都不写」。这里按真实契约断言。
	ok("2.5f 同分类重复广播后 URL 的值仍幂等为 armory=wb（replaceState 到同值不再抖动）",
		c.hash() === "#armory=wb", `hash=${c.hash()} extraWrites=${c.writes().length - writesBefore}`);

	const writesBefore2 = c.writes().length;
	listener("bogus");
	ok("2.5g 广播非法 key 被忽略：分类不变", c.getCategory() === "wb", `category=${c.getCategory()}`);
	ok("2.5h 广播非法 key 不写 hash", c.writes().length === writesBefore2, `writes=${c.writes().length} before=${writesBefore2}`);

	listener(undefined);
	listener(null);
	ok("2.5i 广播 undefined/null 不炸、分类不变", c.getCategory() === "wb", `category=${c.getCategory()}`);
}

// 2.6 卸载后的广播：不得影响状态（cleanup 真的注销了订阅者）。
{
	const c = mountComponent({ pending: "", hash: "armory=skill" });
	const listener = c.listen()[0];
	c.unmount();
	ok("2.6a 卸载后订阅者被注销（listener set 为空）", c.listen().length === 0, `listeners=${c.listen().length}`);
	ok("2.6b 卸载后仍持有 listener 引用也不会改变已卸载实例的状态", c.getCategory() === "skill", `category=${c.getCategory()}`);
	let escaped = null;
	try { listener("wb"); } catch (error) { escaped = error; }
	ok("2.6c 卸载后调用陈旧 listener 不抛错", escaped === null, escaped ? String(escaped.message) : "");
}

// 2.7 完整链路：openBoardCategory 广播 → 已挂载组件真实切换。
// 关键：真源码里这些符号共享**同一个模块作用域**（同一个 pendingBoardCategory / 同一个
// boardCategoryListeners）。若把跳转链和组件放进两个 vm 上下文，就人为制造了「组件清的是
// 自己的 pending、跳转链读的是另一个」的假象，断言必然失真。所以这里把两段拼进同一上下文：
// SLICE_TRANSITION 已声明 pendingBoardCategory 与 boardCategoryListeners，组件片段直接复用。
{
	const calls = [];
	const state = { hash: "#armory=mcp" };
	// 共享的 hook 槽：组件的分类 state 落在 slots[0]，测试从外部读它拿真实状态。
	const slots = [];
	let cursor = 0;
	const context = vm.createContext({
		console, t: (s) => s, __slots: slots,
		location: { get hash() { return state.hash; }, pathname: "/", search: "" },
		history: {
			replaceState(_a, _b, url) {
				const at = String(url).indexOf("#");
				state.hash = at < 0 ? "" : String(url).slice(at);
			},
		},
		useState(init) { const i = cursor++; if (!(i in slots)) slots[i] = { value: init() }; return [slots[i].value, (v) => { slots[i].value = v; }]; },
		useCallback(fn) { cursor += 1; return fn; },
		useEffect(fn) { cursor += 1; const cleanup = fn(); if (typeof cleanup === "function") (slots.__cleanups = slots.__cleanups || []).push(cleanup); },
	});
	context.ctx = { get: () => ({ panelInfo: { getSnapshot: () => ({ activePanelId: PANEL_ID_SRC }) }, selectPanel(id) { calls.push(id); } }) };
	vm.runInContext(
		[SLICE_HASH, SLICE_PANELID, SLICE_CATEGORIES, SLICE_TRANSITION, "MODULE_CTX.ctx = ctx;",
			`(function () {\n${MOUNT_SLICE}\n})();`].join("\n"),
		context, { filename: "qa-bug1-e2e.js" },
	);
	const categoryOf = () => (slots[0] ? slots[0].value : undefined);
	ok("2.7a 端到端环境：组件挂载后与跳转链共享同一个 boardCategoryListeners（恰好 1 个订阅者）",
		vm.runInContext("boardCategoryListeners.size", context) === 1,
		`size=${vm.runInContext("boardCategoryListeners.size", context)}`);
	ok("2.7b 端到端前置：挂载时首帧分类 = hash 的 mcp（此时无 pending）", categoryOf() === "mcp", `category=${categoryOf()}`);

	const beforeCalls = calls.length;
	vm.runInContext("openBoardCategory('wb');", context, { filename: "qa-bug1-e2e-call.js" });
	ok("2.7c 端到端：openBoardCategory('wb') 广播到已挂载组件，分类由 mcp 切到 wb",
		categoryOf() === "wb", `category=${categoryOf()}`);
	ok("2.7d 端到端：广播领取后模块级 pending 被清空（同一个作用域，不会各清各的）",
		vm.runInContext("pendingBoardCategory", context) === "",
		`pending=${JSON.stringify(vm.runInContext("pendingBoardCategory", context))}`);
	ok("2.7e 端到端：全程没有 selectPanel(null)（用户没被踢回会话）",
		!calls.includes(null) && calls.length === beforeCalls + 1 && calls[beforeCalls] === PANEL_ID_SRC,
		`calls=${JSON.stringify(calls)}`);
	ok("2.7f 端到端：hash 被写成 armory=wb（刷新后仍停在市场）", state.hash === "#armory=wb", `hash=${state.hash}`);

	// 2.7g 连续两次不同分类：第一次广播已把 pending 清空，第二次必须**重新**写入并再次生效。
	// 这是 pending「一次性」语义最容易翻车的地方：若 listener 忘记清 pending，第二次跳转看
	// 不出问题；若 listener 清得太狠或写入顺序颠倒，第二次就会丢目标。
	const callsBefore2 = calls.length;
	vm.runInContext("openBoardCategory('expert');", context, { filename: "qa-bug1-e2e-call2.js" });
	ok("2.7g 连续跳转第二次（wb → expert）：分类真的切到 expert",
		categoryOf() === "expert", `category=${categoryOf()}`);
	ok("2.7h 连续跳转第二次后 pending 仍被清空（一次性语义成立）",
		vm.runInContext("pendingBoardCategory", context) === "",
		`pending=${JSON.stringify(vm.runInContext("pendingBoardCategory", context))}`);
	ok("2.7i 连续跳转第二次：只多一次 selectPanel(PANEL_ID)，仍然没有 null",
		calls.length === callsBefore2 + 1 && calls[callsBefore2] === PANEL_ID_SRC && !calls.includes(null),
		`calls=${JSON.stringify(calls)}`);
	ok("2.7j 连续跳转后 hash 跟着变成 armory=expert", state.hash === "#armory=expert", `hash=${state.hash}`);

	// 2.7k 同分类再点一次：不得把分类弄丢，也不得写坏 hash。
	vm.runInContext("openBoardCategory('expert');", context, { filename: "qa-bug1-e2e-call3.js" });
	ok("2.7k 同分类再点一次仍停在 expert（幂等，不被回退）",
		categoryOf() === "expert" && state.hash === "#armory=expert", `category=${categoryOf()} hash=${state.hash}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 第 3 节 · Bug 1 旁路：不能改坏既有入口
// ═══════════════════════════════════════════════════════════════════════════
section("3. Bug 1 旁路 · openBoardPanel 与调用点");

const openBoardPanelBody = (() => {
	const a = source.indexOf("function openBoardPanel() {");
	if (a < 0) throw new Error("找不到 openBoardPanel");
	const b = source.indexOf("\n}", a);
	return source.slice(a, b + 2);
})();
ok("3.1 openBoardPanel 仍按 panelInfo 判定并 toggle（active === PANEL_ID ? null : PANEL_ID）",
	/active\s*===\s*PANEL_ID\s*\?\s*null\s*:\s*PANEL_ID/.test(openBoardPanelBody),
	`len=${openBoardPanelBody.length}`);
ok("3.2 openBoardPanel 内部不调用 openBoardCategory / selectBoardPanel（两个通道互不串味）",
	!openBoardPanelBody.includes("openBoardCategory(") && !openBoardPanelBody.includes("selectBoardPanel("));

// 存活调用点：这三处必须仍是 toggle（用户再点一次要能回对话）。
// 按**源码内容**定位而不是行号：行号会随任何无关改动漂移（本轮删掉死代码 Sev 与它的
// 8 条 CSS 后整份文件前移 15 行），钉死行号的断言会假红，钉内容才对得上「哪个入口」。
const TOGGLE_CALLSITES = [
	{ why: "侧栏页脚入口", anchor: /onClick:\s*\(\)\s*=>\s*openBoardPanel\(\),/ },
	{ why: "命令面板「打开悬浮管理面板」", anchor: /run:\s*\(\)\s*=>\s*\{\s*openBoardPanel\(\);\s*onClose\(\);\s*\}/ },
	{ why: "悬浮按钮 FAB", anchor: /^\s*openBoardPanel\(\);\s*$/m },
];
for (const site of TOGGLE_CALLSITES) {
	const hit = site.anchor.exec(source);
	ok(`3.3 openBoardPanel 调用点仍存在（${site.why}）`, Boolean(hit), hit ? `第 ${source.slice(0, hit.index).split("\n").length} 行` : "未找到该形态的调用点");
}
// 统计调用点时要排除注释：pending/selectBoardPanel 的说明性注释里也写了 `openBoardPanel()`，
// 直接全文 match 会把它们算进去（实测 6 次 = 3 个真调用 + 3 处注释）。
const openBoardPanelCalls = source
	.split("\n")
	.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
	.filter((line) => /\bopenBoardPanel\(\s*\)/.test(line) && !/function openBoardPanel/.test(line));
ok("3.4 openBoardPanel() 的调用点恰好 3 处（不新增、不误删；已排除注释）", openBoardPanelCalls.length === 3,
	`count=${openBoardPanelCalls.length} lines=${JSON.stringify(openBoardPanelCalls.map((l) => l.trim().slice(0, 60)))}`);

// openBoardCategory 的全部调用点，传入 key 必须都在白名单里。
// 同样按内容扫描（排除注释行）而不是钉行号：行号会随无关改动漂移，见上面 3.3 的说明。
const CATEGORY_CALLSITES = (() => {
	const out = [];
	for (const [i, line] of source.split("\n").entries()) {
		if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
		if (/function openBoardCategory/.test(line)) continue;
		for (const m of line.matchAll(/openBoardCategory\(([^)]*)\)/g)) {
			out.push({ line: i + 1, text: line.trim(), arg: m[1].trim() });
		}
	}
	return out;
})();
const literalKeys = [];
for (const site of CATEGORY_CALLSITES) {
	const arg = site.arg;
	// 字面量或 'x' ? 'y' : 'z' 形态：把其中所有引号字符串都抽出来。
	const quoted = [...arg.matchAll(/'([^']*)'/g)].map((m) => m[1]);
	if (/^'[^']*'$/.test(arg)) literalKeys.push({ line: site.line, keys: [arg.slice(1, -1)] });
	else if (quoted.length === 2 && /\?/.test(arg)) literalKeys.push({ line: site.line, keys: quoted });
	else literalKeys.push({ line: site.line, keys: [], raw: arg });
}
ok("3.5 openBoardCategory 调用点恰好 6 处（不新增、不误删；已排除注释与定义）", CATEGORY_CALLSITES.length === 6,
	`count=${CATEGORY_CALLSITES.length} lines=${JSON.stringify(CATEGORY_CALLSITES.map((s) => s.line))}`);
const WHITELIST = ["mcp", "skill", "expert", "tailor", "wb"];
const allKeys = literalKeys.flatMap((e) => e.keys);
ok("3.6 6 个 openBoardCategory 调用点的参数都能解析成字面量 key", allKeys.length >= 6 && literalKeys.every((e) => e.keys.length > 0), `解析到=${JSON.stringify(literalKeys.map((e) => ({ line: e.line, keys: e.keys })))}`);
ok("3.7 全部调用点传入的 key 都在 BOARD_CATEGORIES 白名单内（否则会被新白名单静默吞掉）",
	allKeys.every((k) => WHITELIST.includes(k)),
	`越界=${JSON.stringify(allKeys.filter((k) => !WHITELIST.includes(k)))}`);

// Bug 1 的触发点：「去市场找现成的」按钮。按文案锚定，不按行号。
const bug1Site = CATEGORY_CALLSITES.find((s) => s.text.includes("去市场找现成的"));
ok("3.8 调用点覆盖到 Bug 1 的触发点（『去市场找现成的』按钮传 'wb'）",
	Boolean(bug1Site) && /openBoardCategory\('wb'\)/.test(bug1Site.text),
	bug1Site ? `第 ${bug1Site.line} 行` : "未找到该按钮");

// 「去市场找现成的」按钮仍然指向 openBoardCategory('wb')，没被换成 openBoardPanel。
ok("3.9 『去市场找现成的』按钮仍走 openBoardCategory('wb')（未被改成 toggle）",
	Boolean(bug1Site) && !bug1Site.text.includes("openBoardPanel"),
	bug1Site ? JSON.stringify(bug1Site.text.slice(0, 100)) : "未找到该按钮");

// 命令面板的分类跳转**不是**走 openBoardCategory，而是走 onJump（挂载处直接接 setCategory）。
// 原断言写成了 openBoardCategory(cat.key)，属测试自身的错误假设，已按源码事实改写：
//   6697 `run: () => { onJump(cat.key); onClose(); }`  /  7051 `onJump: setCategory`
// 注意「未被改成 toggle」只能针对分类条目判定，不能全文否定 openBoardPanel()——
// 面板条目 6702 本来就有 `run: () => { openBoardPanel(); onClose(); }`，那是正确用法。
const paletteJumpRun = /run:\s*\(\)\s*=>\s*\{\s*onJump\(cat\.key\);\s*onClose\(\);\s*\}/.test(source);
const paletteJumpMcp = /run:\s*\(\)\s*=>\s*\{\s*emitMcpRefresh\(\);\s*onJump\('mcp'\);\s*onClose\(\);\s*\}/.test(source);
const paletteJumpExpert = /run:\s*\(\)\s*=>\s*\{\s*onJump\('expert'\);\s*onClose\(\);\s*\}/.test(source);
const paletteWired = /onJump:\s*setCategory/.test(source);
ok("3.10 命令面板三条分类跳转仍走 onJump（cat.key / 'mcp' / 'expert'），挂载处 onJump: setCategory，未被改成 toggle",
	paletteJumpRun && paletteJumpMcp && paletteJumpExpert && paletteWired,
	`cat=${paletteJumpRun} mcp=${paletteJumpMcp} expert=${paletteJumpExpert} wired=${paletteWired}`);

// ═══════════════════════════════════════════════════════════════════════════
// 第 4 节 · Bug 2：CSS 规则级契约（从真实 MCP_CSS 里解析）
// ═══════════════════════════════════════════════════════════════════════════
section("4. Bug 2 · 桌面端布局规则");

const CSS_RAW = (() => {
	const a = source.indexOf(MARK.css);
	if (a < 0) throw new Error("找不到 MCP_CSS");
	const b = source.indexOf("`;", a + MARK.css.length);
	if (b < 0) throw new Error("MCP_CSS 未闭合");
	return source.slice(a + MARK.css.length, b);
})();
// 插值只有 FAB_SIZE / FAB_EDGE 两个常量（已在源里），换成数值后才是合法的 CSS 文本。
const FAB = { FAB_SIZE: 50, FAB_EDGE: 22 };
const CSS = CSS_RAW.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (_, name) => {
	if (!(name in FAB)) throw new Error(`未知插值：${name}`);
	return String(FAB[name]);
});
ok("4.0 MCP_CSS 只有一个插值常量（FAB_SIZE/FAB_EDGE），替换后可用于解析",
	!/\$\{/.test(CSS) && CSS.includes("width:50px"), `len=${CSS.length}`);

// CSS 解析：按花括号配对递归展开 @media 嵌套，得到扁平的 { selector, body, media } 列表。
// 注意必须做成栈式/递归——一个 @media 里有多条规则，逐条配对才能把媒体归属带对；
// @keyframes 的 0%/100% 帧块不是样式规则，整块跳过，否则会污染 media 归属与规则计数。
// 必须先剥注释：MCP_CSS 在本仓库里习惯把 `/* … */` 夹在**规则之间**。若直接用
// `css.slice(i, open)` 当选择器，注释文本会被粘到选择器前面（变成 "/* … */\n.dsh-mcp-page"），
// 既让 rulesFor() 全部落空，也会让 `@media (max-width:760px){` 前面的注释把
// startsWith("@media") 判假 —— 整块移动端规则永远不会被递归到，测出来是 0 条。
// 已核对：MCP_CSS 的注释体内不含花括号，因此剥离不改变块结构。
const stripCssComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "");
const parseCss = (css, media = null, out = []) => {
	const clean = stripCssComments(css);
	let i = 0;
	while (i < clean.length) {
		const open = clean.indexOf("{", i);
		if (open < 0) break;
		const selector = clean.slice(i, open).trim();
		let depth = 1;
		let j = open + 1;
		for (; j < clean.length; j += 1) {
			if (clean[j] === "{") depth += 1;
			else if (clean[j] === "}") { depth -= 1; if (depth === 0) break; }
		}
		if (depth !== 0) throw new Error(`CSS 未闭合：${selector}`);
		const body = clean.slice(open + 1, j);
		if (selector.startsWith("@media")) parseCss(body, selector, out);
		else if (!/@(-\w+-)?keyframes/.test(selector)) out.push({ selector, body, media });
		i = j + 1;
	}
	return out;
};
const RULES = parseCss(CSS);
const rulesFor = (selector, media = null) => RULES.filter((r) => r.selector === selector && r.media === media);
const decl = (rule, prop) => {
	const m = new RegExp(`(?:^|;)\\s*${prop.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")}\\s*:\\s*([^;]+)`).exec(rule.body);
	return m ? m[1].trim() : null;
};

// 4.1 基础规则唯一且是新写法。
const basePageRules = rulesFor(".dsh-mcp-page");
ok("4.1 桌面端 .dsh-mcp-page 基础规则恰好 1 条（无重复定义）", basePageRules.length === 1, `count=${basePageRules.length}`);
const basePage = basePageRules[0] || { body: "" };
ok("4.2 .dsh-mcp-page 含 height:100%（改为 flex 填充父容器）", decl(basePage, "height") === "100%", `height=${decl(basePage, "height")}`);
ok("4.3 .dsh-mcp-page 含 min-height:0", decl(basePage, "min-height") === "0");
ok("4.4 .dsh-mcp-page 含 box-sizing:border-box（padding 不再撑破高度）", decl(basePage, "box-sizing") === "border-box");
ok("4.5 .dsh-mcp-page 含 display:flex + flex-direction:column", decl(basePage, "display") === "flex" && decl(basePage, "flex-direction") === "column");
ok("4.6 .dsh-mcp-page 含 overflow:auto（窗口过矮时整页可滚动，内容不被裁切）", decl(basePage, "overflow") === "auto", `overflow=${decl(basePage, "overflow")}`);
ok("4.7 .dsh-mcp-page 的 padding 是不含 var() 的纯数值（Windows 不再重复让位）",
	decl(basePage, "padding") === "16px 20px 24px", `padding=${decl(basePage, "padding")}`);
ok("4.8 .dsh-mcp-page 基础规则里**没有** 100dvh 反算", !basePage.body.includes("100dvh"));

// 4.9 darwin 覆盖存在且只叠在 padding-top。
const darwinRules = RULES.filter((r) => r.selector === "[data-platform=darwin] .dsh-mcp-page");
ok("4.9 存在 [data-platform=darwin] .dsh-mcp-page 覆盖规则", darwinRules.length >= 1, `count=${darwinRules.length}`);
const darwinTop = darwinRules.find((r) => !r.media);
ok("4.10 darwin 覆盖在桌面端（非 media 内）存在且只覆盖 padding-top", !!darwinTop && decl(darwinTop, "padding-top") !== null && Object.keys(decl(darwinTop, "padding") === null ? {} : { p: 1 }).length === 0 && decl(darwinTop, "padding") === null,
	darwinTop ? `padding-top=${decl(darwinTop, "padding-top")}` : "");
ok("4.11 darwin 的 padding-top = calc(clearance + 16px)，与官方插件页同构",
	!!darwinTop && /calc\(\s*var\(--dsh-frame-top-clearance\s*,\s*0px\)\s*\+\s*16px\s*\)/.test(decl(darwinTop, "padding-top") || ""),
	darwinTop ? `实际=${decl(darwinTop, "padding-top")}` : "");

// 4.12 无条件 padding 里的 clearance 必须消失（这是 Windows 多让一倍的直接来源）。
const unconditionalClearance = RULES.filter((r) => r.selector === ".dsh-mcp-page" && !r.selector.includes("darwin") && /calc\(\s*var\(--dsh-frame-top-clearance/.test(r.body));
ok("4.12 没有任何「无条件」的 .dsh-mcp-page 规则仍然使用 --dsh-frame-top-clearance", unconditionalClearance.length === 0,
	unconditionalClearance.length ? `违规规则=${unconditionalClearance.map((r) => r.selector).join(",")}` : "");

// 4.13 高度反算彻底消失（100dvh 只允许出现在浮层面板，不允许出现在主面板页）。
const pageDvh = RULES.filter((r) => r.selector.includes(".dsh-mcp-page") && /100dvh/.test(r.body));
ok("4.13 .dsh-mcp-page 相关规则全部不再使用 100dvh", pageDvh.length === 0, pageDvh.length ? `违规=${pageDvh.map((r) => r.selector).join(",")}` : "");
ok("4.14 .dsh-mcp-wrap 的高度规则里不再有 calc(... 100dvh ...)",
	!RULES.filter((r) => r.selector === ".dsh-mcp-page>.dsh-mcp-wrap").some((r) => /100dvh/.test(r.body)));

// 4.15 子元素 wrap 的 flex 契约。
const wrapRules = rulesFor(".dsh-mcp-page>.dsh-mcp-wrap");
ok("4.15 桌面端 .dsh-mcp-page>.dsh-mcp-wrap 规则恰好 1 条", wrapRules.length === 1, `count=${wrapRules.length}`);
const wrapRule = wrapRules[0] || { body: "" };
ok("4.16 wrap 含 flex:1 1 auto（吃满剩余高度）", (decl(wrapRule, "flex") || "").replace(/\s+/g, " ") === "1 1 auto", `flex=${decl(wrapRule, "flex")}`);
ok("4.17 wrap 含 width:100%（flex 交叉轴不再回落到 fit-content）", decl(wrapRule, "width") === "100%", `width=${decl(wrapRule, "width")}`);
ok("4.18 wrap 含 min-height:520px（窗口过矮时兜底，不压扁内部列表）", decl(wrapRule, "min-height") === "520px", `min-height=${decl(wrapRule, "min-height")}`);
ok("4.19 wrap 含 max-width:1180px + margin:0 auto（居中宽度未被改掉）", decl(wrapRule, "max-width") === "1180px" && decl(wrapRule, "margin") === "0 auto");
ok("4.20 wrap 不再声明固定 height（改由 flex 分配）", decl(wrapRule, "height") === null, `height=${decl(wrapRule, "height")}`);

// 4.21 内部 body 的既有 flex 契约未被顺手改坏。
const bodyRules = rulesFor(".dsh-mcp-page .dsh-mcp-body");
ok("4.21 .dsh-mcp-page .dsh-mcp-body 仍是 flex:1 1 auto + min-height:0（本轮未改动）",
	bodyRules.length === 1 && (decl(bodyRules[0], "flex") || "").replace(/\s+/g, " ") === "1 1 auto" && decl(bodyRules[0], "min-height") === "0");

section("5. Bug 2 · 移动端 media 块");

const MOBILE_MEDIA = "@media (max-width:760px)";
const mobileRules = RULES.filter((r) => r.media === MOBILE_MEDIA);
ok("5.1 能找到 max-width:760px 的移动端块", mobileRules.length > 20, `rules=${mobileRules.length}`);

const mobilePage = mobileRules.filter((r) => r.selector === ".dsh-mcp-page");
ok("5.2 移动端 .dsh-mcp-page 规则恰好 1 条", mobilePage.length === 1, `count=${mobilePage.length}`);
ok("5.3 移动端 .dsh-mcp-page padding = 10px 12px 20px（不含 var/calc）",
	mobilePage.length === 1 && decl(mobilePage[0], "padding") === "10px 12px 20px",
	mobilePage.length === 1 ? `padding=${decl(mobilePage[0], "padding")}` : "");
ok("5.4 移动端不存在无条件的 clearance 让位", mobilePage.length === 1 && !/--dsh-frame-top-clearance/.test(mobilePage[0].body));

const mobileDarwin = mobileRules.filter((r) => r.selector === "[data-platform=darwin] .dsh-mcp-page");
ok("5.5 移动端存在 darwin 覆盖规则", mobileDarwin.length === 1, `count=${mobileDarwin.length}`);
ok("5.6 移动端 darwin padding-top = calc(clearance + 10px)",
	mobileDarwin.length === 1 && /calc\(\s*var\(--dsh-frame-top-clearance\s*,\s*0px\)\s*\+\s*10px\s*\)/.test(decl(mobileDarwin[0], "padding-top") || ""),
	mobileDarwin.length === 1 ? `实际=${decl(mobileDarwin[0], "padding-top")}` : "");

const mobileWrap = mobileRules.filter((r) => r.selector === ".dsh-mcp-page>.dsh-mcp-wrap");
ok("5.7 移动端 .dsh-mcp-page>.dsh-mcp-wrap 规则恰好 1 条", mobileWrap.length === 1, `count=${mobileWrap.length}`);
ok("5.8 移动端 wrap 含 flex:0 0 auto（窄屏不被拉伸出纵向溢出）",
	mobileWrap.length === 1 && (decl(mobileWrap[0], "flex") || "").replace(/\s+/g, " ") === "0 0 auto",
	mobileWrap.length === 1 ? `flex=${decl(mobileWrap[0], "flex")}` : "");
ok("5.9 移动端 wrap 含 width:100% + min-height:0 + height:auto",
	mobileWrap.length === 1 && decl(mobileWrap[0], "width") === "100%" && decl(mobileWrap[0], "min-height") === "0" && decl(mobileWrap[0], "height") === "auto",
	mobileWrap.length === 1 ? `width=${decl(mobileWrap[0], "width")} min-height=${decl(mobileWrap[0], "min-height")} height=${decl(mobileWrap[0], "height")}` : "");

section("6. 浮层面板规则未被连带改动（回归红线）");

const floatWrap = rulesFor(".dsh-mcp-panel .dsh-mcp-wrap");
ok("6.1 .dsh-mcp-panel .dsh-mcp-wrap 规则仍存在且唯一", floatWrap.length === 1, `count=${floatWrap.length}`);
ok("6.2 浮层 wrap 仍是 height:100% + min-height:0 + padding:18px（一字未改）",
	floatWrap.length === 1 && decl(floatWrap[0], "height") === "100%" && decl(floatWrap[0], "min-height") === "0" && decl(floatWrap[0], "padding") === "18px",
	floatWrap.length === 1 ? `height=${decl(floatWrap[0], "height")} padding=${decl(floatWrap[0], "padding")}` : "");
const floatPanel = rulesFor(".dsh-mcp-panel");
ok("6.3 浮层面板 .dsh-mcp-panel 仍是 height:88vh（未被换成 flex 填充）",
	floatPanel.length === 1 && decl(floatPanel[0], "height") === "88vh", floatPanel.length === 1 ? `height=${decl(floatPanel[0], "height")}` : "");
ok("6.4 浮层面板规则里没有混入主面板页的 flex 填充写法",
	floatPanel.length === 1 && decl(floatPanel[0], "flex") === null);

section("7. CSS 结构正确性");

// 花括号配平：depth 终值 0，全程不下溢（下溢说明有孤立的 }）。
const braceStats = (() => {
	let depth = 0;
	let minDepth = 0;
	for (const ch of CSS) {
		if (ch === "{") depth += 1;
		else if (ch === "}") { depth -= 1; if (depth < minDepth) minDepth = depth; }
	}
	return { depth, minDepth };
})();
ok("7.1 MCP_CSS 花括号配平：终值 0 且全程无下溢", braceStats.depth === 0 && braceStats.minDepth === 0, `depth=${braceStats.depth} min=${braceStats.minDepth}`);
ok("7.2 MCP_CSS 里没有残留的模板插值（替换后应已清零）", !/\$\{/.test(CSS));
ok("7.3 解析出的规则数 > 400（证明解析器真的读到了整份样式表）", RULES.length > 400, `rules=${RULES.length}`);

// 重复定义检查：同一 media 层内不应有完全相同的选择器块出现两次（装饰性重复可以有，但主面板页不行）。
const dupKeys = new Map();
for (const r of RULES) {
	const key = `${r.media || ""}||${r.selector}`;
	dupKeys.set(key, (dupKeys.get(key) || 0) + 1);
}
ok("7.4 .dsh-mcp-page 在桌面层与移动层各只有 1 条（无重复定义）",
	(dupKeys.get("||.dsh-mcp-page") || 0) <= 1 && (dupKeys.get(`${MOBILE_MEDIA}||.dsh-mcp-page`) || 0) <= 1,
	`desktop=${dupKeys.get("||.dsh-mcp-page") || 0} mobile=${dupKeys.get(`${MOBILE_MEDIA}||.dsh-mcp-page`) || 0}`);

// ═══════════════════════════════════════════════════════════════════════════
// 第 8 节 · 高度账：把 Bug 2 的算术显式算出来（含改前反证）
// ═══════════════════════════════════════════════════════════════════════════
section("8. Bug 2 · 高度账（含改前旧写法的反证）");

// 可用高 = 中栏高度 - 框架已扣掉的标题栏。页面自己**额外**让出的顶带 clearance
// 只有在 Windows 上才是重复计算：框架已经 padding-top 过一次。
// 下面按「页面自身声明的盒模型」算出纵向总占高，再与可用高比较。
// frameChrome：宿主框架已经从视口里扣掉的固定占高（Windows 标题栏 / macOS 由页面自让）。
// clearance：宿主导出的 --dsh-frame-top-clearance。
//   · macOS：宿主 CSS 是字面量 html[data-platform=darwin]{--dsh-frame-top-clearance:48px} → 48；
//   · Windows：宿主 CSS 是**间接引用** html[data-windows-titlebar]{--dsh-frame-top-clearance:
//     var(--dsh-windows-titlebar-height)}，而 preload 把 --dsh-windows-titlebar-height 设成 40px
//     （root.style.setProperty("--dsh-windows-titlebar-height", `40px`)）→ 代入即 40。
//   两者不是同一个量：48 只属于 macOS。Windows 下 frameChrome 与 clearance 同为 40，
//   因为框架已经用 [data-windows-titlebar] .frame{padding-top:var(--dsh-windows-titlebar-height)}
//   把同一段 40px 让过一次 —— 这正是「插件再让一次就重复」的前提。
// 旧写法：padding-top = clearance + 16（两平台都让），wrap 高度 = 100dvh - clearance - 40。
const measureLegacy = ({ platform, viewportH = 900, frameChrome = 0, clearance = 0 }) => {
	const available = viewportH - frameChrome;
	const padTop = clearance + 16;
	const padBottom = 24;
	// 旧 wrap 高度直接按**视口**反算，未考虑框架已扣的标题栏：
	const wrapH = viewportH - clearance - 40;
	return { available, padTop, padBottom, content: wrapH, total: padTop + wrapH + padBottom, overflow: padTop + wrapH + padBottom - available };
};

// 新写法：wrap 是 flex:1 1 auto，内容高度 = 可用高 - padding（但受 min-height:520px 托底）。
const newLayout = ({ platform, viewportH, frameChrome, clearance }) => {
	const available = viewportH - frameChrome;
	const padTop = (platform === "darwin" ? clearance : 0) + 16;
	const padBottom = 24;
	const wrapIdeal = Math.max(0, available - padTop - padBottom);
	const wrapH = Math.max(wrapIdeal, 520); // min-height:520px
	return { available, padTop, padBottom, wrapH, total: padTop + wrapH + padBottom, overflow: padTop + wrapH + padBottom - available };
};

const WIN = { platform: "win32", viewportH: 900, frameChrome: 40, clearance: 40 };
const MAC = { platform: "darwin", viewportH: 900, frameChrome: 0, clearance: 48 };

const winNew = newLayout(WIN);
ok("8.1 Windows 新写法：纵向溢出 = 0（内容 flex 填充，正好铺满可用高）", winNew.overflow === 0, `total=${winNew.total} available=${winNew.available} overflow=${winNew.overflow}`);
const winLegacy = measureLegacy(WIN);
// 旧写法在 Windows 上多让了一次 clearance：框架已用 padding 把标题栏（40px）让出去，
// 页面又无条件 padding-top:calc(clearance + 16px)，于是纵向总占高比可用高多出整整
// 一个 clearance = 40px —— 这就是「必须往下滑一小段」的那一小段。
// 40 不是估量值：宿主 preload 把 --dsh-windows-titlebar-height 设为 40px，Windows 的
// --dsh-frame-top-clearance 又间接引用它，所以精确值就是 40（48 是 macOS 的字面量）。
ok("8.2 反证 · Windows 旧写法溢出 = +40px（= 标题栏高 / clearance，正是用户要下滚的那一小段）",
	winLegacy.overflow === 40, `overflow=${winLegacy.overflow} total=${winLegacy.total} available=${winLegacy.available} clearance=${WIN.clearance}`);
ok("8.3 反证有效：旧写法多出的溢出量恰好等于一次 clearance（重复让位的量化证据）",
	winLegacy.overflow - winNew.overflow === WIN.clearance, `delta=${winLegacy.overflow - winNew.overflow} clearance=${WIN.clearance}`);

const macNew = newLayout(MAC);
ok("8.4 macOS 新写法：溢出 = 0（框架不扣顶带，页面自让 clearance 后仍等高）", macNew.overflow === 0, `overflow=${macNew.overflow} total=${macNew.total} available=${macNew.available}`);
ok("8.5 macOS 新写法顶带 = clearance + 16（与官方插件页同高，未被削平）", macNew.padTop === 64, `padTop=${macNew.padTop}`);
ok("8.6 Windows 新写法顶带 = 16px（不再叠加 clearance）", winNew.padTop === 16, `padTop=${winNew.padTop}`);
ok("8.7 两平台新写法下 wrap 的顶部起点（相对可用区）一致 = 16px",
	winNew.padTop === 16 && macNew.padTop - MAC.clearance === 16,
	`win=${winNew.padTop} mac-visual=${macNew.padTop - MAC.clearance}`);

// 窗口很高时不得出现「内容被拉得过高」以外的副作用：wrap 应等于理想高度。
// 注意：不再显式传 frameChrome —— 它已由 ...WIN 携带为 40，再写一次旧值 48 会把常量覆盖回去。
{
	const tall = newLayout({ ...WIN, viewportH: 1600 });
	ok("8.8 高窗口下 wrap 恰好等于剩余可用高（flex 填充，无额外留白）", tall.wrapH === tall.available - tall.padTop - tall.padBottom,
		`wrapH=${tall.wrapH} ideal=${tall.available - tall.padTop - tall.padBottom}`);
}

// 窗口很矮：min-height:520px 托底，允许溢出，但必须由外层 overflow:auto 接管（可滚动而不是裁切）。
{
	const short = newLayout({ ...WIN, viewportH: 560 });
	ok("8.9 矮窗口下 wrap 触发 min-height:520px 托底", short.wrapH === 520, `wrapH=${short.wrapH}`);
	ok("8.10 矮窗口下确实溢出（内容不被压缩），且外层已声明 overflow:auto 可滚动",
		short.overflow > 0 && decl(basePage, "overflow") === "auto",
		`overflow=${short.overflow}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 第 9 节 · 反向自测（mutation）：证明上面的正向断言不是空转
// ═══════════════════════════════════════════════════════════════════════════
section("9. 反向自测（mutation）");

// 9.1 把 openBoardCategory 的 selectBoardPanel() 换回 openBoardPanel()，行为断言必须变红。
{
	const mutated = SLICE_TRANSITION.replace("  selectBoardPanel();\n}", "  openBoardPanel();\n}");
	ok("9.1 自测前置：成功把 selectBoardPanel() 改回 openBoardPanel()", mutated !== SLICE_TRANSITION && mutated.includes("openBoardPanel();\n}"));
	const h = (() => {
		const calls = [];
		const context = vm.createContext({
			console, location: { hash: "", pathname: "/", search: "" },
			history: { replaceState() {} },
			ctx: { get: () => ({ panelInfo: { getSnapshot: () => ({ activePanelId: PANEL_ID_SRC }) }, selectPanel(id) { calls.push(id); } }) },
			t: (s) => s,
		});
		vm.runInContext([SLICE_HASH, SLICE_PANELID, SLICE_CATEGORIES, mutated, "MODULE_CTX.ctx = ctx; globalThis.__p = { openBoardCategory };"]
			.join("\n"), context, { filename: "qa-mutated-toggle.js" });
		return { p: context.__p, calls };
	})();
	h.p.openBoardCategory("wb");
	ok("9.2 自测：改回 toggle 后，已挂载时点『去市场』会被踢回会话（selectPanel(null)）——证明 1.2 不是恒真",
		h.calls.includes(null), `calls=${JSON.stringify(h.calls)}`);
}

// 9.3 把「无条件 padding 用 clearance」写回去，第 4.12 条检测必须抓到。
{
	const mutatedCss = CSS.replace(
		".dsh-mcp-page{box-sizing:border-box;",
		".dsh-mcp-page{padding:calc(var(--dsh-frame-top-clearance,0px) + 16px) 20px 24px;box-sizing:border-box;",
	);
	const mutatedRules = parseCss(mutatedCss);
	const caught = mutatedRules.filter((r) => r.selector === ".dsh-mcp-page" && !r.selector.includes("darwin") && /calc\(\s*var\(--dsh-frame-top-clearance/.test(r.body));
	ok("9.3 自测：把无条件 clearance padding 注回去，第 4.12 条的检测能抓到（证明该断言有效）",
		mutatedCss !== CSS && caught.length === 1, `caught=${caught.length}`);
}

// 9.4 把 100dvh 反算注回 wrap，第 4.14 条必须抓到。
{
	const mutatedCss = CSS.replace(
		".dsh-mcp-page>.dsh-mcp-wrap{flex:1 1 auto;",
		".dsh-mcp-page>.dsh-mcp-wrap{height:calc(100dvh - 40px);flex:1 1 auto;",
	);
	const caught = parseCss(mutatedCss).filter((r) => r.selector === ".dsh-mcp-page>.dsh-mcp-wrap" && /100dvh/.test(r.body));
	ok("9.4 自测：把 100dvh 反算注回 wrap，第 4.14 条的检测能抓到", mutatedCss !== CSS && caught.length === 1, `caught=${caught.length}`);
}

// 9.5 把 pending 优先级反过来（hash 优先于 pending），第 2.1 条必须变红。
// 关键：不能读 mountComponent 的「挂载后状态」——源码的 useEffect 会把 pending 再领一次，
// 于是两种实现挂载后都变成 wb，区分不出来。必须读 **useState 惰性初值**（effect 之前）。
{
	const mutatedMount = MOUNT_SLICE.replace(
		"const focus = pendingBoardCategory;\n    if (BOARD_CATEGORIES.some((cat) => cat.key === focus)) return focus;",
		"const focus = pendingBoardCategory;",
	);
	ok("9.5a 自测前置：成功改写出『hash 优先、pending 不参与初值』的变异体",
		mutatedMount !== MOUNT_SLICE, `len ${MOUNT_SLICE.length} → ${mutatedMount.length}`);

	// 对照组：真源码首帧初值必须是 wb（pending 压过 hash 的 mcp）。
	const real = mountComponent({ pending: "wb", hash: "armory=mcp" });
	ok("9.5b 对照：未变异时首帧初值 = wb（pending 压过 hash）", real.getFirstInit() === "wb", `init=${real.getFirstInit()}`);

	// 变异体：同样的输入，首帧初值应回落成 hash 的 mcp —— 说明 2.1a 测的是优先级本身。
	const mutated = mountComponent({ pending: "wb", hash: "armory=mcp", mountSlice: mutatedMount });
	ok("9.5c 自测：变异体首帧初值回落成 mcp（证明 2.1a 断言的是『pending 优先』这个优先级本身）",
		mutated.getFirstInit() === "mcp", `init=${mutated.getFirstInit()}`);
}

// 9.6 把白名单校验删掉，非法 key 应污染 pending —— 证明 1.4 不是空转。
{
	const mutated = SLICE_TRANSITION.replace(
		"  if (!BOARD_CATEGORIES.some((cat) => cat.key === key)) return;\n",
		"",
	);
	ok("9.6 自测前置：成功删掉白名单校验", mutated !== SLICE_TRANSITION);
	const context = vm.createContext({
		console, location: { hash: "", pathname: "/", search: "" }, history: { replaceState() {} },
		ctx: { get: () => null }, t: (s) => s,
	});
	vm.runInContext([SLICE_HASH, SLICE_PANELID, SLICE_CATEGORIES, mutated, "MODULE_CTX.ctx = ctx; globalThis.__p = { openBoardCategory, getPending: () => pendingBoardCategory };"]
		.join("\n"), context, { filename: "qa-mutated-whitelist.js" });
	context.__p.openBoardCategory("nonexistent");
	ok("9.7 自测：去掉白名单后非法 key 会写进 pending（证明 1.4a 真的在测白名单）",
		context.__p.getPending() === "nonexistent", `pending=${JSON.stringify(context.__p.getPending())}`);
}

// 9.8 把 openMcpQuery 尾行的 openBoardCategory('mcp') 换回 openBoardPanel()，1.7 必须变红。
// 这是 Bug 1 第 5 条的变异体：证明 1.7a/1.7d 钉的是「走强制选中通道」而不是恒真。
{
	const mutatedQuery = SLICE_MCPQUERY.replace("openBoardCategory('mcp');", "openBoardPanel();");
	ok("9.8a 自测前置：成功把 openMcpQuery 改回 openBoardPanel()",
		mutatedQuery !== SLICE_MCPQUERY, `len ${SLICE_MCPQUERY.length} → ${mutatedQuery.length}`);

	// 用同一个替身宿主跑变异体：已挂载看板页时调 openMcpQuery，应被 toggle 成 null。
	const buildMutant = () => {
		const calls = [];
		const state = { hash: "#armory=skill" };
		const context = vm.createContext({
			console, t: (s) => s,
			location: { get hash() { return state.hash; }, pathname: "/", search: "" },
			history: { replaceState() {} },
		});
		context.ctx = {
			get: () => ({
				panelInfo: { getSnapshot: () => ({ activePanelId: PANEL_ID_SRC }) },
				selectPanel(id) { calls.push(id); },
			}),
		};
		vm.runInContext(
			[SLICE_HASH, SLICE_PANELID, SLICE_CATEGORIES, SLICE_TRANSITION, mutatedQuery,
				"MODULE_CTX.ctx = ctx; globalThis.__m = { openMcpQuery, getPending: () => pendingBoardCategory };"].join("\n"),
			context, { filename: "qa-mutated-mcpquery.js" },
		);
		return { context, calls, run: () => context.__m.openMcpQuery("target") };
	};

	const mutant = buildMutant();
	mutant.run();
	ok("9.8b 自测：改回 openBoardPanel 后，已挂载时 openMcpQuery 会被踢回会话（selectPanel(null)）——证明 1.7d 不是恒真",
		mutant.calls.includes(null), `calls=${JSON.stringify(mutant.calls)}`);

	// 对照组：真源码同样的输入下绝不产生 null。
	const real = createHarness({ hash: "#armory=skill", activePanelId: smoke.probe.PANEL_ID });
	real.probe.openMcpQuery("target");
	ok("9.8c 对照：未变异时同样的输入不产生 selectPanel(null)", !real.calls.includes(null), `calls=${JSON.stringify(real.calls)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 汇总
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n共 ${checks} 条断言：PASS ${checks - failures} / FAIL ${failures}`);
console.log(failures === 0 ? "BUGFIX-ARMORY PASS" : `BUGFIX-ARMORY FAIL（${failures} 条失败）`);
process.exitCode = failures === 0 ? 0 : 1;
