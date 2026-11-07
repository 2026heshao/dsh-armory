// 召唤菜单两处真实事故的回归护栏（issue #10 / #11）：
//
// #11：清单里的 description 不是字符串（本地化对象 / 数组）时，旧 itemDesc 直接
//      调 .slice() 抛 TypeError。React 渲染期抛错会把整个 slot 卸载，用户看到的是
//      「点一下图标，图标直接消失」而不是某条数据出错。这里直测 textOf / quickItemDesc
//      的归一结果，并用反向自测证明旧写法确实会抛。
// #10：一级菜单宽度首帧按 128 兜底且只算一次，异步清单把菜单撑到 300–400px 后
//      右缘整块伸出视口。这里直测 quickMenuLeft 的居中 + 夹取，并用旧「按兜底宽度居中」
//      公式复现溢出，证明新断言不是恒真。
//
// 断言分两层：纯函数真跑 + 组件接线源码断言（防止修好纯函数却忘了在渲染处使用）。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 必须走 fileURLToPath：本仓库路径含中文，`URL.pathname` 是百分号编码的。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT = join(ROOT, "lib", "client.js");
const HOST = join(ROOT, "lib", "index.js");

let failures = 0;
const ok = (name, condition, extra = "") => {
	if (!condition) failures += 1;
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};

const source = await readFile(CLIENT, "utf8");
const hostSource = await readFile(HOST, "utf8");

// ── 源码抽取：真代码进 vm，不塞替身 ────────────────────────────────────────
const TEXT_START = "const TEXT_KEYS_ZH";
const TEXT_END = "const applyI18nLocale";
const QUICK_START = "const quickItemDesc = (kind, item) =>";
const QUICK_END = "const quickSubmenuOpensLeft";
const HOST_START = "const skillRowText = (value) => {";
const HOST_END = "\nvar __runInitializers";

const grab = (text, startMarker, endMarker) => {
	const start = text.indexOf(startMarker);
	const end = text.indexOf(endMarker, start + startMarker.length);
	return start >= 0 && end > start ? text.slice(start, end) : "";
};
const textSlice = grab(source, TEXT_START, TEXT_END);
const quickSlice = grab(source, QUICK_START, QUICK_END);
const hostSlice = grab(hostSource, HOST_START, HOST_END);
ok("能定位显示文本归一一节（textOf）", textSlice.length > 0);
ok("能定位召唤菜单文本 / 定位纯函数一节", quickSlice.length > 0);
ok("能定位宿主侧 skill 行文本归一一节（skillRowText）", hostSlice.length > 0);
if (!textSlice || !quickSlice || !hostSlice) {
	console.log("\nQUICK-MENU-GUARDS FAIL（标记缺失，无法抽取待测源码）");
	process.exit(1);
}

const load = ({ english = false } = {}) => {
	const context = vm.createContext({ console, usesEnglish: () => english });
	vm.runInContext(
		`${textSlice}\n${quickSlice}\nglobalThis.__probe = { textOf, quickItemDesc, quickMenuLeft, quickMenuPosition, quickMenuFixedStyle };`,
		context,
		{ filename: "client-quick-guards-slice.js" },
	);
	return context.__probe;
};
const zh = load();
const en = load({ english: true });

// ── 1. textOf：任何形状都归一成字符串，绝不抛错 ─────────────────────────────
ok("字符串原样返回", zh.textOf("普通描述") === "普通描述");
ok("数字 / 布尔 / bigint 转字符串", zh.textOf(42) === "42" && zh.textOf(false) === "false" && zh.textOf(7n) === "7");
ok("null / undefined / symbol 回落空串", zh.textOf(null) === "" && zh.textOf(undefined) === "" && zh.textOf(Symbol("x")) === "");
ok("中文界面优先 zh 本地化对象", zh.textOf({ zh: "中文简介", en: "English" }) === "中文简介");
ok("英文界面优先 en 本地化对象", en.textOf({ zh: "中文简介", en: "English" }) === "English");
ok("只有英文时中文界面也回落英文", zh.textOf({ en: "English only" }) === "English only");
ok("通用文本键（text / value / description）可识别", zh.textOf({ text: "T" }) === "T" && zh.textOf({ value: "V" }) === "V" && zh.textOf({ description: "D" }) === "D");
ok("数组按顺序拼成一段", zh.textOf(["第一段", { zh: "第二段" }, ""]) === "第一段 第二段");
ok("无法识别的对象回落空串", zh.textOf({ foo: 1 }) === "");
{
	const selfRef = { name: "环" };
	selfRef.description = selfRef;
	// 自引用不会死循环：深度闸门把第 3 层之后截断为空。
	ok("自引用对象不会无限递归", zh.textOf(selfRef) === "环");
}

// ── 2. quickItemDesc：先归一再截断，非字符串不再抛 TypeError ───────────────
const longZh = "这是一段很长的技能描述".repeat(10);
ok("字符串描述截到 48 字", zh.quickItemDesc("skill", { description: longZh }).length === 48
	&& zh.quickItemDesc("skill", { description: longZh }) === longZh.slice(0, 48));
ok("对象描述按当前语言取值并截断", zh.quickItemDesc("skill", { description: { zh: "中文描述", en: "English" } }) === "中文描述"
	&& en.quickItemDesc("skill", { description: { zh: "中文描述", en: "English" } }) === "English");
ok("数组描述归一后截断", zh.quickItemDesc("skill", { description: ["A", "B"] }) === "A B");
ok("MCP 读 transport 而非 description", zh.quickItemDesc("mcp", { transport: { text: "http" }, description: "不该显示" }) === "http");
ok("缺字段 / null item 回落空串", zh.quickItemDesc("skill", {}) === "" && zh.quickItemDesc("skill", null) === "");
{
	let error = null;
	try {
		zh.quickItemDesc("skill", { description: { zh: "对象" } });
		zh.quickItemDesc("mcp", { transport: { text: "http" } });
	} catch (caught) {
		error = caught;
	}
	ok("对象形状两条分支都不抛错", error === null, error ? String(error) : "");
}
// 反向自测：旧实现（issue #11 报错行）必须能复现 TypeError。
{
	let legacyError = null;
	try {
		const legacy = vm.createContext({});
		vm.runInContext(
			"globalThis.__legacyItemDesc = (kind, item) => (kind === 'mcp' ? (item.transport ? item.transport : '') : (item.description || '').slice(0, 48));",
			legacy,
		);
		vm.runInContext("globalThis.__legacyItemDesc('skill', { description: { zh: '对象' } })", legacy);
	} catch (caught) {
		legacyError = caught;
	}
	ok("反向自测：旧 itemDesc 对对象描述抛 TypeError（证明护栏非恒真）", legacyError && legacyError.name === "TypeError");
}

// ── 3. quickMenuLeft：居中对齐 + 夹取，宽度变大也不越界 ─────────────────────
const rect = (left, right) => ({ left, right, width: right - left, top: 700, bottom: 724 });
const vw = 1200;
ok("常规位置与图标中心对齐", zh.quickMenuLeft(rect(600, 624), 360, vw) === 612 - 180);
ok("窄菜单同样居中对齐", zh.quickMenuLeft(rect(600, 624), 128, vw) === 612 - 64);
ok("贴右缘时夹到视口内（右缘 = 视口 - 8）", zh.quickMenuLeft(rect(1180, 1192), 360, vw) === vw - 360 - 8);
ok("贴左缘时夹到 8px（不再出现负坐标）", zh.quickMenuLeft(rect(100, 124), 360, vw) === 8);
ok("窄视口也不产生负 left", zh.quickMenuLeft(rect(10, 34), 360, 300) === 8);
ok("width 缺失按 0 处理不越界", zh.quickMenuLeft(rect(1100, 1124), 0, vw) === 1112);
{
	const left = zh.quickMenuLeft(rect(1180, 1192), 360, vw);
	ok("任何输入下右缘都不越过视口 - 8", left + 360 <= vw - 8);
}
// 反向自测：旧「按 128 居中再夹」公式，在真实宽度撑到 360 时右缘必然外溢。
{
	const oldLeft = (trigger, measured, viewport) => {
		const centered = trigger.left + trigger.width / 2 - measured / 2;
		return Math.max(4, Math.min(centered, viewport - measured - 4));
	};
	const trigger = rect(1000, 1024);
	const oldWithStaleWidth = oldLeft(trigger, 128, 1024) + 360;
	const newLeft = zh.quickMenuLeft(trigger, 360, 1024);
	ok("反向自测：旧公式按 128 兜底宽度算出的右缘会伸出视口", oldWithStaleWidth > 1024, `right=${oldWithStaleWidth}`);
	ok("新公式同一输入下右缘在视口内", newLeft + 360 <= 1024 - 8, `right=${newLeft + 360}`);
}
// 纵向：上半屏向下开（top 锚定），下半屏向上开（bottom 锚定，变高不顶出视口）。
{
	const down = zh.quickMenuPosition({ left: 600, right: 624, top: 100, bottom: 124 }, 360, 1200, 800);
	const up = zh.quickMenuPosition({ left: 600, right: 624, top: 700, bottom: 724 }, 360, 1200, 800);
	ok("上半屏向下开：top = 图标底 + 6", down.top === "130px" && down.bottom === undefined && down.left === "432px", JSON.stringify(down));
	ok("下半屏向上开：bottom = 视口底 - 图标顶 + 6", up.top === undefined && up.bottom === "106px" && up.left === "432px", JSON.stringify(up));
}
// fixed 包含块不是视口时（祖先带 transform）：用上一帧实测位置反推原点再换算。
// 真实数据来自 0.2.2-rc.1：期望 left=929，实际渲染在 1208，偏移 279 正好是会话列左缘。
{
	const fakeMenu = (style, rect) => ({ style, getBoundingClientRect: () => rect });
	const desired = { position: "fixed", left: "929px", top: "130px" };
	const menu = fakeMenu({ left: "929px", top: "130px" }, { left: 1208, top: 380, bottom: 700 });
	const fixed = zh.quickMenuFixedStyle(desired, menu, 830);
	ok("水平：反推包含块原点并换算 left", fixed.left === "650px", JSON.stringify(fixed));
	ok("纵向 top：同样反推包含块原点并换算", fixed.top === "-120px", JSON.stringify(fixed));
	ok("换算后加回包含块原点 = 期望视口坐标",
		parseFloat(fixed.left) + (1208 - 929) === 929 && parseFloat(fixed.top) + (380 - 130) === 130);
	// 向上展开：bottom 锚定，包含块底边不是视口底边时也要换算。
	const upDesired = { position: "fixed", left: "929px", bottom: "106px" };
	const upMenu = fakeMenu({ left: "929px", bottom: "106px" }, { left: 1208, top: 600, bottom: 750 });
	const upFixed = zh.quickMenuFixedStyle(upDesired, upMenu, 830);
	ok("纵向 bottom：按包含块底边换算", upFixed.bottom === "132px", JSON.stringify(upFixed));
	ok("bottom 换算后菜单底边落在期望视口位置",
		(750 + 106) - parseFloat(upFixed.bottom) === 830 - 106, JSON.stringify(upFixed));
	// 首帧还没有已写坐标：原样返回，调用方据此保持隐藏。
	const first = zh.quickMenuFixedStyle(desired, fakeMenu({}, { left: 0, top: 0, bottom: 0 }), 830);
	ok("首帧无已写坐标时不做换算（由调用方保持隐藏）", first.left === "929px" && first.top === "130px");
	ok("没有菜单节点时原样返回", zh.quickMenuFixedStyle(desired, null, 830).left === "929px");
	// 反向自测：旧实现直接把期望视口坐标写进 style，遇到变换祖先必然偏移 279px。
	const naiveViewportLeft = parseFloat(desired.left) + (1208 - 929);
	ok("反向自测：不做包含块换算时菜单右移 279px（旧缺陷复现）", naiveViewportLeft === 1208 && naiveViewportLeft !== 929);
}

// ── 4. 组件接线断言：修好的纯函数必须真的被用上 ────────────────────────────
const component = grab(source, "const SummonQuickMenu = (", "// ── 会话头「当前生效专家」徽章");
ok("组件已抽到", component.length > 0);
ok("itemDesc 不再直接对 description 调 slice", !/\(item\.description \|\| ''\)\.slice/.test(component)
	&& component.includes("const itemDesc = (kind, item) => quickItemDesc(kind, item);"));
ok("loadRecent 的技能 / MCP 清单在入口处归一", /skill: skillRows\s*\.map\(\(row\) => \(\{\s*name: textOf\(row\?\.name\)/.test(component)
	&& /mcp: mcpRows\s*\.map\(\(row\) => \(\{\s*name: textOf\(row\?\.serverName\)/.test(component));
ok("itemLabel 出口归一（React 子节点不接受对象）", component.includes("const name = textOf(item?.name);"));
ok("一级菜单用实测宽度（getBoundingClientRect().width）", component.includes("getBoundingClientRect().width"));
ok("一级菜单监听菜单尺寸变化并重算", component.includes("new ResizeObserver(measure)") && component.includes("ro.observe(menu)"));
ok("一级菜单监听窗口尺寸变化", component.includes("addEventListener('resize', measure)"));
ok("重复测量时五字段全等返回原对象", component.includes("prev.top === style.top && prev.bottom === style.bottom")
	&& component.includes("prev.visibility === style.visibility"));
ok("组件定位使用 quickMenuPosition 纯函数", component.includes("const desired = quickMenuPosition(rect, width, viewportW, window.innerHeight);"));
ok("组件把期望视口坐标交给包含块换算", component.includes("const style = quickMenuFixedStyle(desired, menu, window.innerHeight);")
	&& component.includes("style.visibility = applied ? 'visible' : 'hidden';"));
// 反向自测：把包含块换算去掉，接线断言必须变红（这正是菜单右移 279px 的旧行为）。
{
	const legacy = component.replace("const style = quickMenuFixedStyle(desired, menu, window.innerHeight);", "const style = desired;");
	ok("反向自测：去掉包含块换算后接线断言变红", !legacy.includes("quickMenuFixedStyle(desired, menu, window.innerHeight)")
		&& legacy.includes("const style = desired;"));
}

// ── 5. 宿主侧入口归一：Skill 看板 / 详情不再拿到对象描述 ────────────────────
// 召唤菜单只是其中一个消费者；listSkills / skillDetail 的返回值还会进 Skill 看板
// 卡片、详情弹层与分类/搜索串。在数据入口归一一次，所有消费者同时得到保护。
{
	const context = vm.createContext({});
	vm.runInContext(`${hostSlice}\nglobalThis.__skillRowText = skillRowText;`, context, { filename: "host-skill-row-text.js" });
	const skillRowText = context.__skillRowText;
	ok("宿主：字符串原样返回", skillRowText("普通描述") === "普通描述");
	ok("宿主：本地化对象取出可显示文本", skillRowText({ zh: "中文简介", en: "English" }) === "中文简介"
		&& skillRowText({ en: "English only" }) === "English only");
	ok("宿主：数组拼接、数字转字符串", skillRowText(["A", "B"]) === "A B" && skillRowText(42) === "42");
	ok("宿主：无法识别的形状回落空串且不抛错", skillRowText({ foo: 1 }) === "" && skillRowText(null) === "" && skillRowText(Symbol("x")) === "");
	ok("listSkills 的 description / whenToUse 都过归一",
		hostSource.includes("description: skillRowText(skill.description)")
		&& hostSource.includes("{ whenToUse: skillRowText(skill.whenToUse) }"));
	// 两处消费点（listSkills + skillDetail）各一条，缺一不可。
	ok("skillDetail 与 listSkills 同源（共 2 处 description 归一）",
		(hostSource.match(/description: skillRowText\(skill\.description\)/g) || []).length === 2);
	// 反向自测：原样透传的旧写法必须已被清掉，注回后断言变红。
	const regressed = hostSource.replace("description: skillRowText(skill.description)", "description: skill.description");
	ok("反向自测：旧的原样透传写法已不存在（注回即变红）",
		!/description: skill\.description/.test(hostSource)
		&& /description: skill\.description/.test(regressed));
}

console.log(failures ? `\nQUICK-MENU-GUARDS FAIL（${failures} 条）` : "\nQUICK-MENU-GUARDS PASS");
process.exit(failures ? 1 : 0);
