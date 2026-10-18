// 入口可见性不变式的直测（`lib/client.js` 的「入口显示偏好」一节）。
//
// 为什么需要这个套件：面板只能从三个入口打开（左上角全局面板行 / 右下角悬浮按钮 / 侧栏底部
// 入口）。「三个都关」是必须**无法表达**的状态——真出现了，用户就再也打不开面板，只能手改
// localStorage 才救得回来。这条不变式原本只写在代码注释里，没有任何测试守着。
//
// 怎么测的：`lib/client.js` 是浏览器 bundle（`window.__ModuleLoader__.load({ factory })`），
// 不能直接 import。但它这一段是自足的：只依赖 localStorage，React hooks 出现在 `useEntryMode`
// 里且只在调用时才解析标识符。所以把 `ENTRY_KEY` 到「全局面板入口」一节之间的源码原文抽出来，
// 放进 vm 里**真正执行**，然后对导出的表与函数做断言——不是对文本做匹配。
//
// 附带一个副作用好处：抽出源码时若标记找不到，本套件直接失败。也就是说，一旦有人把这节改名
// 或搬走而没同步本测试，会立刻暴露（而不是悄悄退化成「测了个空」）。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 必须走 fileURLToPath：本仓库路径含中文，`URL.pathname` 是百分号编码的（会解析成 %E6%A1%8C…）。
const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");

const START_MARKER = "const ENTRY_KEY = 'dsh-armory/entry';";
const END_MARKER = "// ── 全局面板入口";

let failures = 0;
const ok = (name, condition, extra = "") => {
	if (!condition) failures += 1;
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};

// ── 0. 抽出待测源码 ───────────────────────────────────────────────────────────
const source = await readFile(CLIENT, "utf8");
const startAt = source.indexOf(START_MARKER);
const endAt = source.indexOf(END_MARKER, startAt + START_MARKER.length);
ok("能在 lib/client.js 里定位到入口偏好一节的起止标记", startAt >= 0 && endAt > startAt, `start=${startAt} end=${endAt}`);
if (startAt < 0 || endAt <= startAt) {
	console.log("\nCLIENT-ENTRY FAIL（标记缺失，无法抽取待测源码）");
	process.exit(1);
}
const slice = source.slice(startAt, endAt);
ok("抽出的片段包含 overlaySeats 与 ENTRY_VISIBILITY", slice.includes("function overlaySeats") && slice.includes("const ENTRY_VISIBILITY"));

// ── 1. 在隔开的 vm 里执行这段源码 ─────────────────────────────────────────────
// localStorage 用可控替身：读出侧要能注入「被污染的值」，写入侧要能记录落盘。
const createContext = (storage) => {
	const context = {
		console,
		globalThis: null,
		// OPT-11 后这段源码里的展示文案都包了 t()。本段只用它做展示，恒等 stub
		// 即可（i18n 骨架本身的行为由 client-i18n.mjs 守护，这里不重复测）。
		t: (s) => s,
	};
	context.globalThis = context;
	if (storage !== undefined) context.localStorage = storage;
	return context;
};

const runSlice = (storage) => {
	const context = vm.createContext(createContext(storage));
	const epilogue = `
		globalThis.__probe = {
			ENTRY_KEY, ENTRY_VISIBILITY, ENTRY_LABELS, ENTRY_DEFAULT, ENTRY_MODES,
			normalizeEntryMode, readEntryMode, saveEntryMode, createEntryMode, overlaySeats,
		};`;
	vm.runInContext(slice + epilogue, context, { filename: "client-entry-slice.js" });
	return context.__probe;
};

const memoryStorage = (initial = {}) => {
	const map = new Map(Object.entries(initial));
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => { map.set(key, String(value)); },
		map,
	};
};

const probe = runSlice(memoryStorage());
ok("片段能在 vm 里独立执行（不依赖 React 运行时）", !!probe && typeof probe.overlaySeats === "function");

const { ENTRY_VISIBILITY, ENTRY_LABELS, ENTRY_DEFAULT, ENTRY_MODES, normalizeEntryMode, overlaySeats, ENTRY_KEY } = probe;

// ── 2. 核心不变式：没有任何一个模式把三个入口全关掉 ───────────────────────────
const SEATS = ["panel", "fab", "sidebar"];
const lockoutModes = ENTRY_MODES.filter((mode) => SEATS.every((seat) => ENTRY_VISIBILITY[mode][seat] !== true));
ok("核心不变式：没有任何模式把三个入口全部关掉（否则用户把自己锁在外面）", lockoutModes.length === 0, lockoutModes.length ? `违反者=${lockoutModes.join(",")}` : "");

// 反向核对：这条断言不是恒真——确实存在「只留一个入口」的模式，说明表覆盖了边界。
const singleEntryModes = ENTRY_MODES.filter((mode) => SEATS.filter((seat) => ENTRY_VISIBILITY[mode][seat] === true).length === 1);
ok("表确实含「只留一个入口」的模式（证明上一条断言不是恒真）", singleEntryModes.length >= 2, `单入口模式=${singleEntryModes.join(",")}`);

// ── 3. 表自身的完整性 ─────────────────────────────────────────────────────────
ok("每个模式恰好声明 panel/fab/sidebar 三个席位，无多余字段",
	ENTRY_MODES.every((mode) => {
		const keys = Object.keys(ENTRY_VISIBILITY[mode]).sort();
		return keys.length === 3 && keys.join(",") === ["fab", "panel", "sidebar"].join(",");
	}));
ok("每个模式的席位值都是布尔（没有 undefined/truthy 混淆）",
	ENTRY_MODES.every((mode) => SEATS.every((seat) => typeof ENTRY_VISIBILITY[mode][seat] === "boolean")));
ok("每个模式都有非空中文标签（菜单渲染不会出现空白项）",
	ENTRY_MODES.every((mode) => typeof ENTRY_LABELS[mode] === "string" && ENTRY_LABELS[mode].trim().length > 0));
ok("标签表与可见性表一一对应（不多不少）",
	Object.keys(ENTRY_LABELS).sort().join(",") === ENTRY_MODES.slice().sort().join(","));
ok("ENTRY_MODES 正是 ENTRY_VISIBILITY 的键（派生而非手写，不会漂移）",
	ENTRY_MODES.slice().sort().join(",") === Object.keys(ENTRY_VISIBILITY).sort().join(","));
ok("默认模式是表里的合法模式", Object.prototype.hasOwnProperty.call(ENTRY_VISIBILITY, ENTRY_DEFAULT), `default=${ENTRY_DEFAULT}`);
ok("默认模式至少有一个入口可见", SEATS.some((seat) => ENTRY_VISIBILITY[ENTRY_DEFAULT][seat] === true));

// ── 4. overlaySeats：只回答悬浮按钮，且与表一致 ───────────────────────────────
ok("overlaySeats 对每个模式都只返回 { fab }，不含已废弃的 panel 席位",
	ENTRY_MODES.every((mode) => {
		const seats = overlaySeats(mode);
		return Object.keys(seats).join(",") === "fab" && seats.fab === ENTRY_VISIBILITY[mode].fab;
	}));
ok("overlaySeats 的结果与表逐项一致", ENTRY_MODES.every((mode) => overlaySeats(mode).fab === ENTRY_VISIBILITY[mode].fab));

// ── 5. normalizeEntryMode：外部输入一律不半信半疑 ──────────────────────────────
const validPassThrough = ENTRY_MODES.every((mode) => normalizeEntryMode(mode) === mode);
ok("合法模式原样透传", validPassThrough);
const garbage = ["", "  ", "nope", "BOTH", "true", "0", "__proto__", "constructor", "toString", null, undefined, 42, {}, [], () => {}];
const garbageAccepted = garbage.filter((value) => normalizeEntryMode(value) !== ENTRY_DEFAULT);
ok("非法值（含 __proto__/constructor 这类原型键）一律退回默认", garbageAccepted.length === 0, garbageAccepted.length ? `被接受=${String(garbageAccepted[0])}` : "");
ok("查不到的模式不会得到 undefined 可见性（否则等于悄悄关掉所有入口）",
	garbage.every((value) => {
		const visibility = ENTRY_VISIBILITY[normalizeEntryMode(value)];
		return visibility && SEATS.some((seat) => visibility[seat] === true);
	}));

// ── 6. readEntryMode：localStorage 是外部输入 ─────────────────────────────────
// 落盘键名取自源码本身（ENTRY_KEY），不在这里重写一遍字面量：否则有人改了键名，
// 测试仍在测旧键名，会假装通过。
ok("抽取标记里的键名与源码 ENTRY_KEY 一致", START_MARKER.includes(`'${ENTRY_KEY}'`), `ENTRY_KEY=${ENTRY_KEY}`);
ok("读回合法值", probe.readEntryMode() === ENTRY_DEFAULT); // 空 storage → 默认
const poisoned = runSlice(memoryStorage({ [ENTRY_KEY]: "__proto__" }));
ok("localStorage 被写成 __proto__ 时退回默认（不污染、不锁死）", poisoned.readEntryMode() === ENTRY_DEFAULT, `读到=${poisoned.normalizeEntryMode("__proto__")}`);
const stored = runSlice(memoryStorage({ [ENTRY_KEY]: "sidebar" }));
ok("读回已落盘的合法模式", stored.readEntryMode() === "sidebar");

// 没有 localStorage 的运行环境（SSR / 测试替身）：不能抛，退回默认。
const noStorage = runSlice(undefined);
ok("localStorage 不存在时 readEntryMode 不抛错、退回默认", noStorage.readEntryMode() === ENTRY_DEFAULT);
ok("localStorage 不存在时 saveEntryMode 不抛错", (() => {
	try { noStorage.saveEntryMode("panel"); return true; } catch { return false; }
})());

// localStorage 抛错（Safari 无痕模式配额为 0 时会抛）：读要退回默认，写要静默吞掉。
const throwingStorage = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
const throwing = runSlice(throwingStorage);
ok("localStorage 抛错时 readEntryMode 退回默认", throwing.readEntryMode() === ENTRY_DEFAULT);
ok("localStorage 抛错时 saveEntryMode 静默吞掉（不打断本次会话）", (() => {
	try { throwing.saveEntryMode("fab"); return true; } catch { return false; }
})());

// ── 7. createEntryMode：订阅与落盘 ───────────────────────────────────────────
const store = memoryStorage();
const live = runSlice(store);
const modeStore = live.createEntryMode();
const seen = [];
const off = modeStore.subscribe(() => seen.push(modeStore.get()));
ok("初始值是默认模式", modeStore.get() === ENTRY_DEFAULT);
modeStore.set("sidebar");
ok("set 合法值：状态更新", modeStore.get() === "sidebar");
ok("set 合法值：订阅者被通知一次", seen.length === 1, `seen=${seen.join(",")}`);
ok("set 合法值：已落盘到 localStorage", store.map.get("dsh-armory/entry") === "sidebar", `落盘=${store.map.get("dsh-armory/entry")}`);
modeStore.set("sidebar");
ok("set 同一值：不重复通知", seen.length === 1);
modeStore.set("完全不是模式");
ok("set 非法值：归一化为默认而不是写进去", modeStore.get() === ENTRY_DEFAULT, `得到=${modeStore.get()}`);
ok("set 非法值：落盘的也是归一化后的默认值", store.map.get("dsh-armory/entry") === ENTRY_DEFAULT);
off();
modeStore.set("fab");
ok("退订后不再收到通知", seen.length === 2, `seen=${seen.join(",")}`);

// ── 8. 存量偏好兼容：凡历史值都要落在表里 ─────────────────────────────────────
// 早先版本有过 panel/fab/sidebar/both 这些模式；旧用户 localStorage 里可能是任意一个。
const legacy = ["both", "panel", "fab", "sidebar", "all"];
const legacyBroken = legacy.filter((mode) => normalizeEntryMode(mode) !== mode);
ok("历史模式值全部仍然有效（升级后不会被打回默认）", legacyBroken.length === 0, legacyBroken.length ? `失效=${legacyBroken.join(",")}` : "");
ok("历史模式值全部至少留一个入口可见", legacy.every((mode) => SEATS.some((seat) => ENTRY_VISIBILITY[mode][seat] === true)));

// ── 9. 测试自测：证明第 2 节那条核心断言不是恒真 ─────────────────────────────
// 只写「没有任何模式全关」是不够的——如果检测逻辑本身写错了（比如字段名拼错、用 || 而不是
// every），它会永远通过，等于没测。这里把源码里的表**故意改出**一个全关模式，再跑一次同样的
// 检测，必须报错。这条不通过，就说明第 2 节是空转。
const MUTATION_MARK = "const ENTRY_VISIBILITY = {";
const mutated = slice.replace(
	MUTATION_MARK,
	`${MUTATION_MARK}\n  injected_lockout: { panel: false, fab: false, sidebar: false },`,
);
ok("自测前置：成功往表里注入了全关模式", mutated !== slice && mutated.includes("injected_lockout"));
if (mutated !== slice) {
	const mutatedProbe = (() => {
		const context = vm.createContext(createContext(memoryStorage()));
		vm.runInContext(`${mutated}
			globalThis.__probe = { ENTRY_VISIBILITY, ENTRY_MODES };`, context, { filename: "client-entry-mutated.js" });
		return context.__probe;
	})();
	const caught = mutatedProbe.ENTRY_MODES.filter((mode) =>
		SEATS.every((seat) => mutatedProbe.ENTRY_VISIBILITY[mode][seat] !== true),
	);
	ok("自测：注入的全关模式被核心断言抓到（证明第 2 节不是恒真）",
		caught.length === 1 && caught[0] === "injected_lockout",
		`抓到=${caught.join(",") || "无"}`);
} else {
	ok("自测：注入失败，无法验证核心断言的有效性", false);
}

console.log(`\n${failures === 0 ? "CLIENT-ENTRY PASS" : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
