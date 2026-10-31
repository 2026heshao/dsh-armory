// 自定义套件 · 客户端行为直测（vm 抽源码真跑）。
//
// 为什么需要这个套件：`test/suites-registry.mjs` 已经把数据层（~/.dsh/armory/suites.json）
// 的整集合覆盖、幂等、两态失败钉死了，但「保存后同一套件分裂成两条」这类 bug 不在数据层——
// 它长在客户端的 **id 归属契约**上：UI 新建的套件先用本地临时 id（local-N）占位，提交时必须
// 把临时 id 置空交给数据层分配，保存成功后必须以**宿主返回值**刷新本地副本。任何一环写错，
// 数据层都会老老实实按「新套件」再存一份，测试还全绿。
//
// 另一条同理：「引用一个套件 = 同时引用它的全部成员」是纯客户端展开（宿主不认识套件），
// 展开出来的文本、以及最近使用按**成员**上报（而不是按套件名）——这两件事也只有真跑才知道。
//
// 怎么测的：与 install-toast.mjs / bugfix-armory.mjs 同一套路——`lib/client.js` 是浏览器
// bundle（window.__ModuleLoader__.load({ factory })），不能直接 import；把待测那几节的**源码
// 原文**抽出来放进 vm 真执行，只给它的自由变量注入替身，然后对真实返回值做断言。
// 抽源码靠起止标记，标记找不到直接失败：有人把这几节改名/搬走而没同步本测试，会立刻暴露，
// 而不是悄悄退化成「测了个空」。
//
// 边界（诚实声明）：这里跑的是纯函数与闭包，**没有** React 渲染、没有 DOM、没有宿主。
// SuiteManager 的 JSX 结构、拖拽（HTML5 DnD 无法在无头环境合成）、以及宿主里的真实点击，
// 需要部署后人工验证——见 Step 5 的「未验证项」。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 必须走 fileURLToPath：本仓库路径含中文，`URL.pathname` 是百分号编码的。
const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");

let failures = 0;
let total = 0;
const ok = (name, condition, extra = "") => {
	total += 1;
	if (!condition) failures += 1;
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};
const section = (title) => console.log(`\n[${title}]`);

const source = await readFile(CLIENT, "utf8");

/** 取 [startMark, endMark) 的源码原文；标记缺失即抛（不静默返回空串）。 */
const sliceBetween = (startMark, endMark) => {
	const a = source.indexOf(startMark);
	if (a < 0) throw new Error(`找不到起始标记：${startMark}`);
	const b = source.indexOf(endMark, a + startMark.length);
	if (b < 0) throw new Error(`找不到结束标记：${endMark}`);
	return source.slice(a, b);
};

// ── 0. 抽出待测源码 ───────────────────────────────────────────────────────────
// 第 1 段：套件工具层（常量 + 两段式打开总线 + 两个纯函数），全部模块级、零 React。
const SUITE_HELPERS = sliceBetween("const SUITE_LOCAL_ID_PREFIX = 'local-';", "const SuiteManager = ({");
// 第 2 段：召唤菜单的插入链（insertRef / pick / pickSuite），是组件内的闭包，
// 自由变量由 sandbox 注入。
const QUICK_INSERT = sliceBetween("  const insertRef = async (text) => {", "  // 子菜单排序：");
// 第 3 段：引用文本格式化器（单技能与套件成员**共用同一个**，这是「格式不会漂移」的前提）。
const QUICK_MENTION = sliceBetween("const quickMentionText = (kind, item) => {", "const SummonQuickMenu = (");

section("0. 源码抽取");
ok("能定位套件工具层的起止标记", SUITE_HELPERS.length > 200, `len=${SUITE_HELPERS.length}`);
ok("套件工具层含 5 个核心符号",
	["SUITE_LOCAL_ID_PREFIX", "function openSuiteManager", "const onSuiteOpenRequest", "const suitePayloadOf", "const cloneSuiteRow"]
		.every((n) => SUITE_HELPERS.includes(n)));
ok("能定位插入链的起止标记（insertRef / pick / pickSuite 三者在同一切片里）",
	["const insertRef = async", "const pick = async", "const pickSuite = async"].every((n) => QUICK_INSERT.includes(n)));
ok("能定位 quickMentionText", QUICK_MENTION.includes("const quickMentionText"));

// ── 1. 跑起来：套件工具层 ─────────────────────────────────────────────────────
const runHelpers = () => {
	const boardCalls = [];
	const sandbox = {
		// openSuiteManager 的尾行要切到 skill 看板；这里只记录，不真跳。
		openBoardCategory: (key) => { boardCalls.push(key); },
		console,
	};
	vm.createContext(sandbox);
	vm.runInContext(
		SUITE_HELPERS
		+ "\n;globalThis.__X = {"
		+ "  suitePayloadOf, cloneSuiteRow, openSuiteManager, onSuiteOpenRequest,"
		+ "  isPending: () => pendingSuiteOpen,"
		+ "  resetPending: () => { pendingSuiteOpen = false; },"
		+ "};",
		sandbox,
	);
	return { api: sandbox.__X, boardCalls };
};

section("1. suitePayloadOf · id 归属契约（防「同一套件分裂成两条」）");
{
	const { api } = runHelpers();
	const rows = [
		{ id: "local-1", name: "演示流水线", desc: "", members: ["demo-video-storyboard", "demo-video-production"], createdAt: 0, updatedAt: 0 },
		{ id: "suite-m3x9-k2ab12", name: "已有套件", desc: "d", members: ["dev-expert"], createdAt: 1700000000000, updatedAt: 1700000009999 },
	];
	const payload = api.suitePayloadOf(rows);
	ok("本地临时 id（local-N）提交时被置空 → 由数据层分配真 id", payload[0].id === "", `id=${JSON.stringify(payload[0].id)}`);
	ok("已落盘的真 id 原样保留（不会被当成新套件再存一份）", payload[1].id === "suite-m3x9-k2ab12", payload[1].id);
	ok("成员数组保序且不共享引用（改副本不会动原件）",
		JSON.stringify(payload[0].members) === JSON.stringify(["demo-video-storyboard", "demo-video-production"])
		&& payload[0].members !== rows[0].members);
	ok("新套件（createdAt=0）不落 createdAt/updatedAt 键 → 数据层才能补 now，不会把 0 写进盘",
		!("createdAt" in payload[0]) && !("updatedAt" in payload[0]), JSON.stringify(Object.keys(payload[0])));
	ok("已有套件的时间戳原样带上（updatedAt 由调用方决定 → 写侧幂等）",
		payload[1].createdAt === 1700000000000 && payload[1].updatedAt === 1700000009999);
	ok("入参不是数组 → 空数组（绝不抛，也绝不把 undefined 交给数据层）",
		JSON.stringify(api.suitePayloadOf(undefined)) === "[]" && JSON.stringify(api.suitePayloadOf("x")) === "[]");
	ok("畸形条目降级成确定形状：members 非数组 → []，缺失的 name/desc → ''", (() => {
		const one = api.suitePayloadOf([{ id: 7, members: "abc" }])[0];
		return one.id === "7" && one.name === "" && one.desc === "" && JSON.stringify(one.members) === "[]";
	})());
	// 真值型非字符串（desc: {}）会被 String() 拉成 "[object Object]"，不是空串——
	// 这是有意的：payload 只承诺「一定是字符串」，不做语义清洗。实际链路上 desc 永远
	// 先过 cloneSuiteRow（已 String 归一），所以这条形状只在手改文件时才可能出现。
	ok("真值型非字符串字段被 String() 拉成字符串（承诺形状，不做语义清洗）",
		api.suitePayloadOf([{ id: "x", name: 0, desc: {}, members: ["a"] }])[0].desc === "[object Object]");
	ok("id 字段缺失时不会抛（String(undefined||'') 兜住）", api.suitePayloadOf([{ name: "n", members: ["a"] }])[0].id === "");
}

section("2. cloneSuiteRow · 工作副本归一");
{
	const { api } = runHelpers();
	const origin = { id: "s1", name: "n", desc: "d", members: ["a", "b"], createdAt: 5, updatedAt: 6 };
	const copy = api.cloneSuiteRow(origin);
	ok("字段逐项拷贝且形状确定", JSON.stringify(copy) === JSON.stringify({ id: "s1", name: "n", desc: "d", members: ["a", "b"], createdAt: 5, updatedAt: 6 }));
	ok("members 是新数组（弹窗里增删成员不会污染看板持有的那份）", copy.members !== origin.members);
	copy.members.push("c");
	ok("改副本不影响原件", origin.members.length === 2);
	ok("畸形输入不抛：undefined → 全零值行", JSON.stringify(api.cloneSuiteRow(undefined))
		=== JSON.stringify({ id: "", name: "", desc: "", members: [], createdAt: 0, updatedAt: 0 }));
	ok("非字符串成员被拉成字符串（手改文件写进数字也不炸渲染）",
		JSON.stringify(api.cloneSuiteRow({ id: "x", name: 1, members: [2, null] }).members) === '["2","null"]');
	ok("时间戳非数字 → 0（不会把 NaN 带进 payload）",
		api.cloneSuiteRow({ id: "x", createdAt: "昨天", updatedAt: NaN }).createdAt === 0);
}

section("3. 两段式打开总线（召唤菜单 → SkillBoard 弹窗）");
{
	const { api, boardCalls } = runHelpers();
	const seen = [];
	const off = api.onSuiteOpenRequest(() => { seen.push("a"); });
	api.onSuiteOpenRequest(() => { throw new Error("订阅者自己炸了"); });
	api.onSuiteOpenRequest(() => { seen.push("c"); });
	api.resetPending();
	api.openSuiteManager();
	ok("看板已挂载：广播即时送达订阅者", seen.includes("a") && seen.includes("c"), JSON.stringify(seen));
	ok("单个订阅者抛错不影响其它订阅者，也不影响弹窗", seen.length === 2);
	ok("广播后仍切到 skill 看板（弹窗活在 SkillBoard 里，不切过去用户看不到）",
		JSON.stringify(boardCalls) === '["skill"]', JSON.stringify(boardCalls));
	off();
	api.resetPending();
	api.openSuiteManager();
	ok("退订后不再触发（不会在卸载的组件上 setState）", seen.filter((x) => x === "a").length === 1, JSON.stringify(seen));
	ok("无订阅者时意图留在 pending 里，等 SkillBoard 挂载自领", api.isPending() === true);
	api.resetPending();
	ok("自领后 pending 复位（否则下次进看板会自己弹一次）", api.isPending() === false);
}

// ── 4. 跑起来：插入链 ─────────────────────────────────────────────────────────
/** 与真 t() 同口径的插值替身（zh-CN 恒等 + {n} 按下标替换）。 */
const fakeT = (text, args) => (Array.isArray(args)
	? String(text).replace(/\{(\d+)\}/g, (_, i) => (args[Number(i)] === undefined ? `{${i}}` : String(args[Number(i)])))
	: String(text));

const runInsert = ({ actions = {}, draftText = "", clipboardFails = false } = {}) => {
	const rpc = [];
	const clipboard = [];
	const copied = [];
	const inserted = [];
	const drafts = [];
	const inputActions = actions === null ? undefined : {
		...(actions.capture !== false ? { captureInsertion: () => ({ start: 0, end: 0 }) } : {}),
		...(actions.insert !== false ? { insertText: (text) => { if (actions.insertThrows) throw new Error("insertText blew up"); inserted.push(text); return actions.insertReturn === undefined ? true : actions.insertReturn; } } : {}),
		...(actions.draft !== false ? { setDraft: (text) => { if (actions.draftThrows) throw new Error("setDraft blew up"); drafts.push(text); } } : {}),
		snapshot: { draft: draftText },
	};
	const sandbox = {
		t: fakeT,
		inputActions,
		navigator: { clipboard: { writeText: async (text) => { if (clipboardFails) throw new Error("clipboard denied"); clipboard.push(text); } } },
		setCopied: (text) => { copied.push(text); },
		// insertRef 的第三级用 setTimeout 清「已复制」提示；替身直接吞掉，避免测试挂住。
		setTimeout: () => 0,
		setOpen: () => {},
		setHoverKind: () => {},
		call: async (method, args) => { rpc.push({ method, args }); return { ok: true }; },
		console,
		Promise,
	};
	vm.createContext(sandbox);
	vm.runInContext(QUICK_MENTION + "\n" + QUICK_INSERT + "\n;globalThis.__P = { pickSuite, insertRef, pick };", sandbox);
	return { run: sandbox.__P, rpc, clipboard, copied, inserted, drafts };
};

section("4. pickSuite · 引用一个套件 = 同时引用全部成员");
{
	const suite = { id: "s1", name: "演示流水线", desc: "", members: ["demo-video-storyboard", "demo-video-production", "dev-expert"] };
	const box = runInsert();
	await box.run.pickSuite(suite);
	ok("展开成一串 /name 插进草稿（宿主看到的只是普通文本，零改动）",
		JSON.stringify(box.inserted) === JSON.stringify(["/demo-video-storyboard /demo-video-production /dev-expert "]),
		JSON.stringify(box.inserted));
	ok("文本以空格收尾（接着打字不会黏在最后一个 /name 上）", box.inserted[0].endsWith(" "));
	ok("最近使用按**成员**逐个上报（3 次，kind=skill）",
		box.rpc.length === 3 && box.rpc.every((r) => r.method === "wbExpertRecordUse" && r.args.kind === "skill"),
		JSON.stringify(box.rpc.map((r) => r.args)));
	ok("上报的是真实 skill 名，不是套件名（否则最近池被污染，「最近」徽章永远匹配不上）",
		JSON.stringify(box.rpc.map((r) => r.args.row.name)) === JSON.stringify(suite.members),
		JSON.stringify(box.rpc.map((r) => r.args.row.name)));
	ok("上报里没有出现过套件名", !box.rpc.some((r) => r.args.row.name === "演示流水线"));
}
{
	const box = runInsert();
	await box.run.pickSuite({ id: "s2", name: "空套件", members: [] });
	ok("空成员套件：不插入、不上报（点了没反应的死条目不该有副作用）",
		box.inserted.length === 0 && box.rpc.length === 0);
	await box.run.pickSuite(undefined);
	ok("入参缺失不抛（菜单重渲染途中点到半截数据也不会白屏）", box.inserted.length === 0);
	const box2 = runInsert();
	await box2.run.pickSuite({ id: "s3", name: "n", members: ["  dev-expert  ", "", "  ", "dev-expert"] });
	ok("成员先 trim 再滤空，但**不去重**（去重是数据层的职责，客户端不二次加工）",
		JSON.stringify(box2.inserted) === JSON.stringify(["/dev-expert /dev-expert "]),
		JSON.stringify(box2.inserted));
	ok("被滤掉的空成员不会上报", box2.rpc.length === 2, JSON.stringify(box2.rpc.map((r) => r.args.row)));
}
{
	// 中文技能名不是合法 /token：必须与单技能引用走同一套降级（`名字：`），不能各写一套正则。
	const box = runInsert();
	await box.run.pickSuite({ id: "s4", name: "n", members: ["编程专家", "dev-expert"] });
	ok("非 [\\w-] 成员降级成「名字：」，与 quickMentionText 单技能形态同源",
		JSON.stringify(box.inserted) === JSON.stringify(["编程专家： /dev-expert "]),
		JSON.stringify(box.inserted));
}
{
	// 与单个技能引用的格式对账：套件展开出来的文本，必须等于「逐个单技能引用文本按序拼接」。
	// 两处各写一套格式化逻辑必然漂移，所以这里直接对账，而不是各测各的。
	const members = ["a-skill", "b-skill"];
	const box = runInsert();
	await box.run.pickSuite({ id: "s5", name: "n", members });
	const expected = members.map((name) => `/${name}`).join(" ") + " ";
	ok("套件展开 = 逐个单技能引用文本按序拼接（格式契约对账）",
		box.inserted[0] === expected, `${JSON.stringify(box.inserted[0])} vs ${JSON.stringify(expected)}`);
}

section("5. insertRef · 三级写通道降级");
{
	const box = runInsert();
	await box.run.insertRef("/a ");
	ok("① captureInsertion + insertText 可用时优先走光标插入", box.inserted.length === 1 && box.drafts.length === 0 && box.clipboard.length === 0);
	ok("不以空格收尾的文本会被补一个空格（避免与后续输入黏连）", box.inserted[0] === "/a ");
}
{
	const box = runInsert({ actions: { insertReturn: false }, draftText: "已有草稿" });
	await box.run.insertRef("/b ");
	ok("① insertText 返回 false（宿主没接住）→ 落到 ② setDraft 整草稿兜底",
		box.inserted.length === 1 && box.drafts.length === 1 && box.clipboard.length === 0, JSON.stringify(box.drafts));
	ok("② 在原草稿后追加，且中间补空格", box.drafts[0] === "已有草稿 /b", JSON.stringify(box.drafts[0]));
}
{
	// ① 抛错与 ① 返回 false 是两种不同的「没接住」，都必须落到 ②，不能把异常抛给用户。
	const box = runInsert({ actions: { insertThrows: true }, draftText: "已有草稿" });
	let threw = null;
	try { await box.run.insertRef("/c "); } catch (e) { threw = e; }
	ok("① insertText 抛错 → 静默落到 ② setDraft（不把宿主异常抛给用户）",
		threw === null && box.drafts.length === 1, threw ? String(threw) : JSON.stringify(box.drafts));
}
{
	// 宿主压根没提供 captureInsertion/insertText（老版本 InputBar）：直接走 ②。
	const box = runInsert({ actions: { capture: false, insert: false }, draftText: "" });
	await box.run.insertRef("/d ");
	ok("① 不可用 → ② setDraft；原草稿为空时不补前导空格",
		box.inserted.length === 0 && JSON.stringify(box.drafts) === JSON.stringify(["/d"]), JSON.stringify(box.drafts));
}
{
	// ② 抛错也要能落到 ③：三级链的每一级都必须自带 try。
	const box = runInsert({ actions: { capture: false, insert: false, draftThrows: true } });
	await box.run.insertRef("/e ");
	ok("② setDraft 抛错 → 落到 ③ 剪贴板", box.drafts.length === 0 && JSON.stringify(box.clipboard) === JSON.stringify(["/e"]));
	ok("③ 剪贴板写入的是 trim 后的文本，并点亮「已复制」提示", box.copied[0] === "/e", JSON.stringify(box.copied));
}
{
	// inputActions 整个不存在（会话页没挂 composer 的极端情况）：只剩剪贴板。
	const box = runInsert({ actions: null });
	await box.run.insertRef("/f ");
	ok("inputActions 缺失 → 直接走剪贴板（绝不跳页，跳页是上一版的缺陷）",
		box.inserted.length === 0 && box.drafts.length === 0 && JSON.stringify(box.clipboard) === JSON.stringify(["/f"]));
}
{
	// 三条通道全断（宿主没提供 inputActions，剪贴板也被浏览器拒绝）：
	// 唯一正确的行为是静默——引用没插进去，但不该给用户抛一个看不懂的异常。
	const box = runInsert({ actions: { capture: false, insert: false, draft: false }, clipboardFails: true });
	let threw = null;
	try {
		await box.run.insertRef("/e ");
	} catch (e) {
		threw = e;
	}
	ok("剪贴板也不可用时静默（不抛给用户一个看不懂的异常）", threw === null, threw ? String(threw) : "");
	ok("三条通道全断时不产生任何写入", box.inserted.length === 0 && box.drafts.length === 0 && box.clipboard.length === 0);
}
{
	// pick 与 pickSuite 共用同一条插入链：验证 pick 的既有行为没被抽取重构改掉。
	const box = runInsert({ draftText: "草稿" });
	await box.run.pick("skill", { name: "dev-expert" }, "/dev-expert ");
	ok("pick 仍走同一条链（重构没改行为）", JSON.stringify(box.inserted) === JSON.stringify(["/dev-expert "]));
	ok("pick 仍按条目本身上报最近使用（1 次，kind=skill，row={name}）",
		box.rpc.length === 1 && box.rpc[0].method === "wbExpertRecordUse" && box.rpc[0].args.kind === "skill"
		&& box.rpc[0].args.row.name === "dev-expert", JSON.stringify(box.rpc));
	const boxMcp = runInsert();
	await boxMcp.run.pick("mcp", { name: "browser-use" }, "请使用 browser-use 的 MCP 工具（mcp__browser-use__*）处理接下来的任务 ");
	ok("mcp 分支仍上报 serverName（不是 name）",
		boxMcp.rpc[0].args.row.serverName === "browser-use" && !("name" in boxMcp.rpc[0].args.row),
		JSON.stringify(boxMcp.rpc[0].args));
}

section("6. 静态契约（结构性不变式，防「改了实现忘了改契约」）");
{
	ok("保存走 call('saveSkillSuites', { suites: suitePayloadOf(draft) })——本地副本必须先过 id 归一",
		/call\('saveSkillSuites', \{ suites: suitePayloadOf\(draft\) \}\)/.test(source));
	ok("保存成功后以**宿主返回值**刷新（onSaved(saved)），不是回填本地 draft",
		/const saved = Array\.isArray\(res\.suites\) \? res\.suites : \[\];[\s\S]{0,240}?onSaved\(saved\)/.test(source));
	ok("保存成功后关窗（避免拿着旧副本再存一次 → 同一套件分裂）",
		/onSaved\(saved\);[\s\S]{0,240}?onClose\(\);/.test(source));
	ok("客户端契约里两个 descriptor 都在（typert / index 侧由 contract-consistency 把关）",
		source.includes("mcpManager/listSkillSuites") && source.includes("mcpManager/saveSkillSuites"));
	ok("SkillBoard 挂载 SuiteManager，并把 onSaved 接到 setSuites、notify 接到看板根级提示",
		/h\(SuiteManager, \{[\s\S]{0,400}?onSaved: setSuites,[\s\S]{0,200}?notify: showNotice,/.test(source));
	ok("SkillBoard 订阅了打开总线（否则召唤菜单的「管理套件…」点了没反应）",
		/onSuiteOpenRequest\(open\)/.test(source) && /if \(pendingSuiteOpen\) open\(\);/.test(source));
	ok("套件分组只出现在技能子菜单（kind.key === 'skill'）",
		/const suites = kind\.key === 'skill' && recent && Array\.isArray\(recent\.suite\) \? recent\.suite : \[\];/.test(source));
	ok("召唤菜单读套件失败不拖垮整个菜单（Promise.all 是一败全败，必须单独兜）",
		/call\('listSkillSuites'\)\.catch\(\(\) => \(\{ ok: false \}\)\)/.test(source));
	ok("弹窗空态判据把套件算进来（只有套件、没有技能时不能被 .empty 压掉）",
		/const hasAny = isProject \? skillRows\.length \+ mcpRows\.length > 0 : skillRows\.length > 0 \|\| suites\.length > 0;/.test(source));
	ok("分隔线只在两段都有内容时画",
		/suites\.length && skillRows\.length \? h\('div', \{ className: 'dsh-mcp-quick-sep'/.test(source));
	ok("SuiteManager 里所有 hook 都在顶层（no-conditional-hooks 另有专测，这里只钉数量不为 0）",
		(SUITE_HELPERS + source.slice(source.indexOf("const SuiteManager = ({"), source.indexOf("const skillTransportHint"))).match(/use(State|Effect|Memo|Callback|Ref)\(/g).length > 10);
}

section("7. 类名与图标：JSX 用到的每个 class / ICONS 键都必须真实存在");
{
	// 这一节是「静态但真解析」：把 MCP_CSS 的选择器全抽出来建成集合，再把 JSX 里出现的
	// className 逐个 token 去查。类名写错一个字母，弹窗就静默变成一块无样式的裸 DOM，
	// 而 node --check / eslint / i18n-coverage 三条门禁全都不会报——只能在这里堵。
	const cssStart = source.indexOf("const MCP_CSS = `");
	const cssEnd = source.indexOf("\n`;", cssStart);
	ok("能定位 MCP_CSS 模板字面量", cssStart >= 0 && cssEnd > cssStart, `len=${cssEnd - cssStart}`);
	const styled = new Set();
	for (const m of source.slice(cssStart, cssEnd).matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) styled.add(m[1]);
	ok("MCP_CSS 确实解析出了大量选择器（为 0 说明抽取逻辑坏了，本节会恒真）", styled.size > 300, `selectors=${styled.size}`);

	const iconsStart = source.indexOf("const ICONS = {");
	const iconsEnd = source.indexOf("\n};", iconsStart);
	ok("能定位 ICONS 图标表", iconsStart >= 0 && iconsEnd > iconsStart, `len=${iconsEnd - iconsStart}`);
	const iconKeys = new Set();
	for (const m of source.slice(iconsStart, iconsEnd).matchAll(/^\s{2}(\w+):/gm)) iconKeys.add(m[1]);
	ok("ICONS 里有本次新增的 layers / grip", iconKeys.has("layers") && iconKeys.has("grip"), `icons=${iconKeys.size}`);

	const suiteManagerSrc = sliceBetween("const SuiteManager = ({", "// 宿主侧接口不存在（HTTP 404");
	// 弹窗外的触点用的是共享短类名；修饰类（dragging/on/arm/over/gone…）是字符串拼接出来的，
	// `className: '...'` 扫不到，所以显式列出——新增触点或修饰类时请一并补进来。
	const used = new Set([
		"dsh-mcp-btn", "suite-entry", "cnt",
		"dsh-mcp-quick-group", "dsh-mcp-quick-sep", "dsh-mcp-quick-item", "suite", "ic", "dsh-mcp-quick-manage",
		"dragging", "in-suite", "on", "arm", "over", "gone", "ok", "err",
	]);
	const addTokens = (text) => {
		for (const m of text.matchAll(/className: '([^']*)'/g)) {
			for (const tok of m[1].split(/\s+/)) if (tok) used.add(tok);
		}
	};
	addTokens(suiteManagerSrc);
	// 全文再扫一遍含 suite 的 className：看板工具条按钮、召唤菜单套件条目都在这里。
	for (const m of source.matchAll(/className: '([^']*suite[^']*)'/g)) {
		for (const tok of m[1].split(/\s+/)) if (tok) used.add(tok);
	}
	const unstyled = [...used].filter((tok) => !styled.has(tok));
	ok(`${used.size} 个 class 在 MCP_CSS 里都有规则（漏一个 = 一块无样式裸 DOM）`,
		unstyled.length === 0, unstyled.length ? `缺=${JSON.stringify(unstyled)}` : "");

	// 图标：d 取自 ICONS[key]，key 写错不报错，只渲染出一条空 path（图标凭空消失）。
	const iconRefs = new Set();
	for (const m of suiteManagerSrc.matchAll(/ICONS\.(\w+)/g)) iconRefs.add(m[1]);
	for (const m of source.matchAll(/d: ICONS\.(layers|grip)/g)) iconRefs.add(m[1]);
	const missingIcons = [...iconRefs].filter((k) => !iconKeys.has(k));
	ok(`${iconRefs.size} 个被引用的 ICONS 键都存在（写错只会让图标静默消失）`,
		missingIcons.length === 0, missingIcons.length ? `缺=${JSON.stringify(missingIcons)}` : "");
	// 反向对账：新加的两个图标确实接上了线，不是躺在表里的死图标。
	ok("layers / grip 都真的被引用了（防「加了图标忘了接线」）",
		iconRefs.has("layers") && iconRefs.has("grip"), JSON.stringify([...iconRefs]));
}

console.log(`\n共 ${total} 条断言：PASS ${total - failures} / FAIL ${failures}`);
if (failures) {
	console.log(`SUITES-CLIENT FAIL（${failures} 条失败）`);
	process.exit(1);
}
console.log("SUITES-CLIENT PASS");
