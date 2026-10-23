// Skill 集合变更的跨组件实时刷新（市场装/卸 → 顶部角标 + 看板列表）。
//
// 为什么要这个套件：市场装完 skill 后顶部 Skill 数量不刷新，必须离开看板再回来——
// 根因不是「读不到新数据」，而是**没有任何人再去读**：角标在 McpBoardPage 里被
// countsLoaded 守卫成「整个挂载期只读一次」，市场安装成功后也只刷新市场自己的列表。
// 这条缺口在浏览器里点一遍能复现，但任何静态断言、编译器、既有用例都不会变红，
// 所以在这里钉住三件事：
//   1. 模块级变更总线的行为（reason 透传 / 单订阅者抛错隔离 / 退订 / 快照遍历）；
//   2. 角标重取函数真跑（成功更新、失败保留旧值、乱序回包不覆盖新结果）；
//   3. 三个真实变更入口（看板卸载 / 市场安装 / 市场卸载）都广播，且角标与看板都订阅。
//
// 与 install-toast.mjs 同一套路：client.js 是浏览器 bundle，不能直接 import；
// 把待测源码原文抽进 node:vm 真执行，配最小替身，对真实返回值/调用记录做断言。
// 抽源码靠起止标记，标记找不到直接失败——改名/搬家而没同步本测试会立刻暴露。
//
// 边界（诚实声明）：这里没有 React 渲染与真实 DOM，订阅后的「同一帧重渲染」由
// 部署后的 GUI L0 验证覆盖；本套件只保证「事件会发、订阅者在、重取逻辑对」。

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

/** 取 [startMark, endMark) 的源码原文；标记缺失即 throw（不静默返回空串）。 */
const sliceBetween = (startMark, endMark) => {
	const a = source.indexOf(startMark);
	if (a < 0) throw new Error(`找不到起始标记：${startMark}`);
	const b = source.indexOf(endMark, a + startMark.length);
	if (b < 0) throw new Error(`找不到结束标记：${endMark}`);
	return source.slice(a, b);
};

// 注释 / 字符串 / 模板 → 等长空格（换行保留）。用于「代码里不许再直接 load」这类
// 反向断言：注释里出现同样的文字不算数。简版即可，本套件只扫描很小的切片。
const maskLiterals = (text) => {
	const out = text.split("");
	const blank = (from, to) => {
		for (let k = from; k < to && k < out.length; k += 1) if (text[k] !== "\n") out[k] = " ";
	};
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === "/" && text[i + 1] === "/") {
			let end = text.indexOf("\n", i);
			if (end === -1) end = text.length;
			blank(i, end);
			i = end;
			continue;
		}
		if (ch === "/" && text[i + 1] === "*") {
			let end = text.indexOf("*/", i + 2);
			end = end === -1 ? text.length : end + 2;
			blank(i, end);
			i = end;
			continue;
		}
		if (ch === "'" || ch === '"' || ch === "`") {
			const quote = ch;
			let cursor = i + 1;
			while (cursor < text.length) {
				if (text[cursor] === "\\") { cursor += 2; continue; }
				if (text[cursor] === quote) { cursor += 1; break; }
				cursor += 1;
			}
			blank(i, cursor);
			i = cursor;
			continue;
		}
		i += 1;
	}
	return out.join("");
};

// ── 0. 抽取待测源码 ───────────────────────────────────────────────────────────
let BUS;
let COUNT_REFRESH;
let INSTALL;
let UNINSTALL;
let REMOVE;
let SKILLBOARD;
let BOARD_PAGE;
try {
	BUS = sliceBetween("// Skill 集合变更总线", "// ── Skill 看板：列表 + 详情");
	COUNT_REFRESH = sliceBetween("  const skillCountSeq = useRef(0);", "  useEffect(() => {\n    if (countsLoaded.current) return;");
	INSTALL = sliceBetween("  const installSkill = async (skill) => {", "  const uninstallSkill = async (skill) => {");
	UNINSTALL = sliceBetween("  const uninstallSkill = async (skill) => {", "  const openSkillDetail = async (skill) => {");
	REMOVE = sliceBetween("  const removeSelected = useCallback(async () => {", "  // §1.4 空状态四件套");
	SKILLBOARD = sliceBetween("const SkillBoard = ({ call, scope, timer }) => {", "const WB_MARKET_CONNECTOR_PAGE_SIZE =");
	BOARD_PAGE = sliceBetween("const McpBoardPage = (props) => {", "const WHATS_NEW_SEEN_KEY =");
} catch (error) {
	console.log(`FAIL  源码抽取：${error.message}`);
	console.log("\nSKILL-REFRESH FAIL（标记缺失，无法抽取待测源码）");
	process.exit(1);
}
ok("能定位变更总线 / 角标重取函数 / 三个变更入口 / 两个消费组件的源码切片",
	[["总线", BUS], ["角标重取", COUNT_REFRESH], ["市场安装", INSTALL], ["市场卸载", UNINSTALL],
		["看板卸载", REMOVE], ["SkillBoard", SKILLBOARD], ["McpBoardPage", BOARD_PAGE]]
		.every(([, text]) => text && text.length > 100));
ok("总线是模块级单例且先于两个消费组件定义",
	source.indexOf("const skillChangeListeners = new Set();") > 0
	&& source.indexOf("const skillChangeListeners = new Set();") < source.indexOf("const SkillBoard = ({ call, scope, timer }) => {")
	&& source.indexOf("const skillChangeListeners = new Set();") < source.indexOf("const McpBoardPage = (props) => {")
	&& (source.match(/const skillChangeListeners = new Set\(\);/g) || []).length === 1);

// ── 1. 变更总线：真跑 ─────────────────────────────────────────────────────────
const bootBus = () => {
	const sandbox = { console };
	vm.createContext(sandbox);
	vm.runInContext(BUS + "\n;globalThis.__bus = { emitSkillChange, onSkillChange, skillChangeListeners };", sandbox, { filename: "client-skill-bus.js" });
	return sandbox.__bus;
};

{
	const bus = bootBus();
	const seen = [];
	const offA = bus.onSkillChange((reason) => seen.push(["a", reason]));
	bus.onSkillChange((reason) => seen.push(["b", reason]));
	ok("订阅者登记在同一个模块级 Set 里", bus.skillChangeListeners.size === 2, `size=${bus.skillChangeListeners.size}`);

	bus.emitSkillChange("market-install");
	ok("一次广播所有订阅者都收到，且按注册顺序", JSON.stringify(seen) === JSON.stringify([["a", "market-install"], ["b", "market-install"]]), JSON.stringify(seen));
	ok("reason 原样透传（区分入口靠它）", seen[0][1] === "market-install");

	seen.length = 0;
	bus.emitSkillChange();
	ok("不传 reason 时默认空串", seen.length === 2 && seen[0][1] === "");

	seen.length = 0;
	offA();
	bus.emitSkillChange("market-uninstall");
	ok("退订后不再收到事件", JSON.stringify(seen) === JSON.stringify([["b", "market-uninstall"]]), JSON.stringify(seen));

	// 单订阅者抛错不能让其余订阅者与调用方一起遭殃：市场安装的主流程不能被角标刷新拖死。
	seen.length = 0;
	const originalError = console.error;
	console.error = () => {};
	const offThrow = bus.onSkillChange(() => { throw new Error("listener boom"); });
	let emitThrew = null;
	try { bus.emitSkillChange("x"); } catch (error) { emitThrew = error; } finally {
		console.error = originalError;
		offThrow();
	}
	ok("单个订阅者抛错被隔离（emit 本身不抛，其它订阅者照收）", emitThrew === null && seen.length === 1, emitThrew ? String(emitThrew) : `seen=${seen.length}`);

	// 遍历快照：A 在收到事件时退订 B，B 这一轮仍应收到（避免「遍历中改集合」的漏发）；
	// 下一轮 B 才真正缺席。Subscribe 时新增的订阅者同理本轮收不到。
	// 用全新总线隔离，避免前面为测退订/抛错留下的订阅者污染顺序断言。
	const snapshotBus = bootBus();
	const order = [];
	const offB = snapshotBus.onSkillChange(() => order.push("b"));
	const offSubA = snapshotBus.onSkillChange(() => {
		order.push("a");
		offB();
		snapshotBus.onSkillChange(() => order.push("late"));
	});
	snapshotBus.emitSkillChange("snapshot");
	ok("广播按快照遍历：本轮退订/新增不影响本轮名单", JSON.stringify(order) === JSON.stringify(["b", "a"]), JSON.stringify(order));
	order.length = 0;
	snapshotBus.emitSkillChange("snapshot-2");
	ok("下一轮按新名单：退订者缺席、期间新增者入场", JSON.stringify(order) === JSON.stringify(["a", "late"]), JSON.stringify(order));
	offSubA();
}

// ── 2. 角标重取：真跑（成功 / 失败 / 乱序） ─────────────────────────────────
const deferred = () => {
	let resolve;
	let reject;
	const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
};

const bootCounter = () => {
	const ref = { current: 0 };
	const sets = [];
	const calls = [];
	const sandbox = {
		console,
		useRef: () => ref,
		useCallback: (fn) => fn,
		skillScopeArg: (scope) => ({ scope }),
		setSkillCount: (value) => sets.push(value),
		call: (method, payload) => {
			const d = deferred();
			calls.push({ method, payload, resolve: d.resolve, reject: d.reject });
			return d.promise;
		},
	};
	vm.createContext(sandbox);
	vm.runInContext(COUNT_REFRESH + "\n;globalThis.__counter = { refreshSkillCount };", sandbox, { filename: "client-skill-count.js" });
	return { refreshSkillCount: sandbox.__counter.refreshSkillCount, ref, sets, calls };
};

{
	const counter = bootCounter();
	let pending = counter.refreshSkillCount();
	ok("重取走宿主 listSkills，且只查全局作用域（与角标口径一致）",
		counter.calls.length === 1 && counter.calls[0].method === "listSkills" && counter.calls[0].payload.scope === "global",
		JSON.stringify(counter.calls[0] && { method: counter.calls[0].method, payload: counter.calls[0].payload }));
	counter.calls[0].resolve({ ok: true, skills: [{}, {}, {}] });
	await pending;
	ok("成功回包按数组长度更新角标", counter.sets.length === 1 && counter.sets[0] === 3, JSON.stringify(counter.sets));

	pending = counter.refreshSkillCount();
	counter.calls[1].resolve({ ok: false, error: "boom" });
	await pending;
	ok("宿主回 ok:false 时保留旧值（不把角标打成 0）", counter.sets.length === 1, JSON.stringify(counter.sets));

	pending = counter.refreshSkillCount();
	counter.calls[2].reject(new Error("network down"));
	let rejected = null;
	try { await pending; } catch (error) { rejected = error; }
	ok("请求抛错被吞掉、保留旧值（角标失败不拖垮看板）", rejected === null && counter.sets.length === 1, rejected ? String(rejected) : JSON.stringify(counter.sets));

	// 乱序：A 先发、B 后发，B 先回 2 个，A 再回 5 个。旧实现会被 A 覆盖成 5（假数量）。
	const a = counter.refreshSkillCount();
	const callA = counter.calls[3];
	const b = counter.refreshSkillCount();
	const callB = counter.calls[4];
	callB.resolve({ ok: true, skills: [{}, {}] });
	await b;
	const afterB = counter.sets.length;
	callA.resolve({ ok: true, skills: [{}, {}, {}, {}, {}] });
	await a;
	ok("乱序回包：先发的慢回包不会覆盖后发的新结果（序号守卫）",
		counter.sets.length === afterB && counter.sets[counter.sets.length - 1] === 2,
		`sets=${JSON.stringify(counter.sets)}`);
	ok("每次重取都递增序号", counter.ref.current === 5, `seq=${counter.ref.current}`);
}

// ── 3. 接线：三个变更入口必须广播 ─────────────────────────────────────────────
{
	const installEmitAt = INSTALL.indexOf("emitSkillChange('market-install')");
	const installGuardAt = INSTALL.indexOf("if (!res?.ok) throw");
	const installRefreshAt = INSTALL.indexOf("await loadInstalled();");
	ok("市场安装成功后广播（在 ok 守卫之后、刷新市场自身列表之前）",
		installEmitAt > 0 && installEmitAt > installGuardAt && installEmitAt < installRefreshAt,
		`emit=${installEmitAt} guard=${installGuardAt} refresh=${installRefreshAt}`);
	ok("市场安装失败路径不广播（throw 后直接进 catch，emit 不会执行）",
		INSTALL.indexOf("catch (e)") > installEmitAt);

	const uninstallEmitAt = UNINSTALL.indexOf("emitSkillChange('market-uninstall')");
	const uninstallGuardAt = UNINSTALL.indexOf("if (!res?.ok) throw");
	const uninstallRefreshAt = UNINSTALL.indexOf("await loadInstalled();");
	ok("市场卸载成功后广播（在 ok 守卫之后、刷新市场自身列表之前）",
		uninstallEmitAt > 0 && uninstallEmitAt > uninstallGuardAt && uninstallEmitAt < uninstallRefreshAt,
		`emit=${uninstallEmitAt} guard=${uninstallGuardAt} refresh=${uninstallRefreshAt}`);

	const removeEmitAt = REMOVE.indexOf("emitSkillChange('skill-board-remove')");
	ok("看板内卸载成功后广播", removeEmitAt > 0);
	ok("看板卸载不再直接 load(true)（统一交给总线，避免同一事件读两遍）",
		!/\bload\(true\);/.test(maskLiterals(REMOVE)));
}

// ── 4. 接线：两个消费方都订阅，角标不受 countsLoaded 拦截 ───────────────────
{
	const boardSubscribe = "useEffect(() => onSkillChange(() => { load(true); }), [load]);";
	ok("SkillBoard 订阅变更并重读真值（load(true) 带刷新指示）", SKILLBOARD.includes(boardSubscribe));

	const parentSubscribe = "useEffect(() => onSkillChange(() => { refreshSkillCount(); }), [refreshSkillCount]);";
	ok("McpBoardPage 订阅变更并重取角标", BOARD_PAGE.includes(parentSubscribe));

	const fnAt = BOARD_PAGE.indexOf("const refreshSkillCount = useCallback");
	const firstUseAt = BOARD_PAGE.indexOf("refreshSkillCount();");
	ok("refreshSkillCount 先声明后使用（hook 依赖不在渲染期 TDZ）", fnAt > 0 && fnAt < firstUseAt, `fn=${fnAt} use=${firstUseAt}`);

	const effectStart = BOARD_PAGE.indexOf("useEffect(() => {\n    if (countsLoaded.current) return;");
	const effectEnd = BOARD_PAGE.indexOf("}, [call, refreshSkillCount]);", effectStart);
	const effectBody = effectStart >= 0 && effectEnd > effectStart ? BOARD_PAGE.slice(effectStart, effectEnd) : "";
	ok("首次计数 effect 复用同一个 refreshSkillCount（不出现第二份读法）", /refreshSkillCount\(\);/.test(effectBody));
	ok("订阅 effect 在首次计数 effect 之外（countsLoaded 只拦其它三个一次性计数）",
		BOARD_PAGE.indexOf(parentSubscribe) > effectEnd && effectEnd > 0);
	ok("重取函数用序号守卫乱序回包", COUNT_REFRESH.includes("++skillCountSeq.current") && COUNT_REFRESH.includes("seq !== skillCountSeq.current"));
}

// ── 5. 反向自测：拆掉关键接线，上面的检测器必须变红 ─────────────────────────
{
	const installWired = (text) => {
		const emitAt = text.indexOf("emitSkillChange('market-install')");
		return emitAt > 0 && emitAt < text.indexOf("await loadInstalled();");
	};
	ok("自测：删掉市场安装广播后检测器必须报红",
		installWired(INSTALL) && !installWired(INSTALL.replace("emitSkillChange('market-install');", "")));

	const parentWired = (text) => text.includes("useEffect(() => onSkillChange(() => { refreshSkillCount(); }), [refreshSkillCount]);");
	ok("自测：删掉父层订阅后检测器必须报红",
		parentWired(BOARD_PAGE)
		&& !parentWired(BOARD_PAGE.replace("useEffect(() => onSkillChange(() => { refreshSkillCount(); }), [refreshSkillCount]);", "")));

	const boardWired = (text) => text.includes("useEffect(() => onSkillChange(() => { load(true); }), [load]);");
	ok("自测：删掉 SkillBoard 订阅后检测器必须报红",
		boardWired(SKILLBOARD)
		&& !boardWired(SKILLBOARD.replace("useEffect(() => onSkillChange(() => { load(true); }), [load]);", "")));
}

console.log(failures === 0 ? "\nSKILL-REFRESH PASS" : `\nSKILL-REFRESH FAIL（${failures} 条断言未通过）`);
if (failures > 0) process.exitCode = 1;
