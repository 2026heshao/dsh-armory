// 专家卡片/详情弹层的按钮判定直测（`lib/client.js` 的 expertCardActions 一节）。
//
// 为什么需要这个套件：1.9.4 真机报「点『需更新』没反应，无法更新」。根因不是后端写链
// （那条链一直通：presetId 稳定，upsert 能原地重写旧行），而是**按钮该不该出现**的判定
// 原先内联在 JSX 三元里：
//     summoned
//       ? h('button', ..., t('送还'))
//       : h('button', ..., staleTeam ? t('更新预设') : t('召唤'))
// 而 staleTeam 的定义要求 summoned===true —— 于是「更新预设」被写进了一个恒假分支，
// 永远不可能渲染。界面上只剩「详情 / 送还」，用户点黄色徽章（那时只是个 span）自然毫无反应。
//
// 编译器和任何既有测试都发现不了这类错误：JSX 三元在 node 里跑不起来，界面照常渲染。
// 本套件把判定抽成模块作用域纯函数后（同 client.js 里 CONTROLS_THRESHOLD 那一带的做法），
// 在 vm 里**真正执行**它并断言：update 与 dismiss 必须并列、四种状态组合全对。
//
// 反向自测：断言源文件里不再出现「把 update 塞进 summoned 否定分支」的写法，
// 并往源码里注入旧写法验证该检查确实会失败（证明检查不是恒真）。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 必须走 fileURLToPath：本仓库路径含中文，`URL.pathname` 是百分号编码的。
const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");

const START_MARKER = "// 团队型 stale 体检的判定标记";
const END_MARKER = "const QUICK_MENU_KINDS = [";

let failures = 0;
const ok = (name, condition, extra = "") => {
	if (!condition) failures += 1;
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};

// ── 0. 抽出判定一节的源码 ───────────────────────────────────────────────────
const source = await readFile(CLIENT, "utf8");
const startAt = source.indexOf(START_MARKER);
const endAt = source.indexOf(END_MARKER, startAt + START_MARKER.length);
ok("能在 lib/client.js 里定位到专家按钮判定一节的起止标记", startAt >= 0 && endAt > startAt, `start=${startAt} end=${endAt}`);
if (startAt < 0 || endAt <= startAt) {
	console.log("\nEXPERT-CARD-ACTIONS FAIL（标记缺失，无法抽取待测源码）");
	process.exit(1);
}
const slice = source.slice(startAt, endAt);
ok(
	"抽出的片段包含 TEAM_BRIDGE_MARKER / expertCardActions / personaTextOf",
	slice.includes("const TEAM_BRIDGE_MARKER") && slice.includes("const expertCardActions") && slice.includes("const personaTextOf"),
);

// ── 1. 在隔开的 vm 里执行，对行为断言 ───────────────────────────────────────
const context = vm.createContext({ console });
const epilogue = "\nglobalThis.__probe = { TEAM_BRIDGE_MARKER, expertCardActions, personaTextOf };";
vm.runInContext(slice + epilogue, context, { filename: "client-expert-card-slice.js" });
const { TEAM_BRIDGE_MARKER, expertCardActions, personaTextOf } = context.__probe;
ok("判定能在 vm 里独立执行（不依赖 React 运行时）", typeof expertCardActions === "function" && typeof personaTextOf === "function");

// 1a. 四种状态组合的完整真值表。这是本套件的核心：**update 必须在 summoned 为真时成立**。
const bridged = `${"人设正文"}\n${TEAM_BRIDGE_MARKER}\n桥接说明`;
const cases = [
	{
		name: "未召唤 + 团队型 → 只有召唤",
		input: { summoned: false, expertType: "team", personaText: "" },
		want: { update: false, dismiss: false, summon: true },
	},
	{
		name: "未召唤 + 单体 → 只有召唤（单体没有桥接段概念，不能被判成 stale）",
		input: { summoned: false, expertType: "single", personaText: "" },
		want: { update: false, dismiss: false, summon: true },
	},
	{
		name: "已召唤 + 团队型 + 人设缺桥接段 → 更新与送还并列（1.9.4 就是这里退回成只有送还）",
		input: { summoned: true, expertType: "team", personaText: "旧版人设，只有 WorkBuddy 的 TeamCreate/Agent 指令" },
		want: { update: true, dismiss: true, summon: false },
	},
	{
		name: "已召唤 + 团队型 + 人设已带桥接段 → 只有送还",
		input: { summoned: true, expertType: "team", personaText: bridged },
		want: { update: false, dismiss: true, summon: false },
	},
	{
		name: "已召唤 + 单体 → 只有送还（单体永不需要更新）",
		input: { summoned: true, expertType: "single", personaText: "" },
		want: { update: false, dismiss: true, summon: false },
	},
	{
		name: "已召唤 + 团队型 + personaText 为 null → 当作缺桥接段（宁可多提示一次更新）",
		input: { summoned: true, expertType: "team", personaText: null },
		want: { update: true, dismiss: true, summon: false },
	},
];
for (const item of cases) {
	const got = expertCardActions(item.input);
	const same = got.update === item.want.update && got.dismiss === item.want.dismiss && got.summon === item.want.summon;
	ok(item.name, same, `got=${JSON.stringify(got)}`);
}

// 1b. 反退化核心断言：update 为真时 dismiss 必须同时为真（并列，不是二选一）。
const stale = expertCardActions({ summoned: true, expertType: "team", personaText: "" });
ok("stale 时 update 与 dismiss 并列（不是二选一）", stale.update === true && stale.dismiss === true);
ok("stale 时不会再出现 summon（三个按钮里召唤与更新互斥）", stale.summon === false);

// 1c. 三态互斥不变式：任何输入下 summon 与 dismiss 恰好一个为真。
for (const item of cases) {
	const got = expertCardActions(item.input);
	ok(`三态互斥：summon XOR dismiss（${item.name}）`, got.summon !== got.dismiss);
}

// ── 2. personaTextOf：找不到/异常输入一律退化成 '' ──────────────────────────
ok("personaTextOf 命中返回人设正文", personaTextOf([{ plugin: "a", personaText: "X" }], "a") === "X");
ok("personaTextOf 未命中返回空串", personaTextOf([{ plugin: "a", personaText: "X" }], "b") === "");
ok("personaTextOf 对非数组退化成空串（不抛）", personaTextOf(null, "a") === "" && personaTextOf(undefined, "a") === "");
ok("personaTextOf 对 null 行/无 personaText 行退化成空串", personaTextOf([null, { plugin: "a" }], "a") === "");

// 2a. 与判定联动：读不出人设正文的已召唤团队行 → 判成 stale（提示用户更新，而不是悄悄用坏人设）。
ok(
	"读不出人设正文的已召唤团队行被判成 stale",
	expertCardActions({ summoned: true, expertType: "team", personaText: personaTextOf([], "x") }).update === true,
);

// ── 3. 源码不变式：判定只有一处实现，别再退回内联三元 ──────────────────────
// 3a. expertCardActions 必须被三个消费点共用（卡片、详情弹层、summon）。
const callSites = source.split("expertCardActions({").length - 1;
ok("expertCardActions 至少被 3 处消费（卡片 / 详情弹层 / summon）", callSites >= 3, `calls=${callSites}`);

// 3b. 旧的恒假写法：`summoned ? 送还 : (... staleTeam ? 更新 ...)`。这个形态绝不能再出现。
const BACKWARD_PATTERN = /summoned\s*\n?\s*\?\s*h\('button'[\s\S]{0,400}?staleTeam\s*\?/;
const isBackward = (text) => BACKWARD_PATTERN.test(text);
ok("源文件里没有「更新预设」被塞进 summoned 否定分支的旧写法", !isBackward(source));

// 3c. 反向自测：把旧写法拼进源码，断言检查确实会失败（证明 3b 不是恒真）。
const injected = `${source}\nconst __backward = () => summoned\n  ? h('button', {}, t('送还'))\n  : h('button', {}, staleTeam ? t('更新预设') : t('召唤'));\n`;
ok("反向自测：注入旧写法后 3b 的检查会失败（证明它真的在检查）", isBackward(injected));

// 3d. 「需更新」徽章必须可点击（1.9.4 它只是个 span，用户点它毫无反应）。
ok("「需更新」徽章带 onClick（点徽章也能触发更新）", /需更新[^']*'[\s\S]{0,600}?onClick:\s*\(\)\s*=>/.test(source) || /onClick:\s*\(\)\s*=>\s*\{[^}]*summon\(item\)[^}]*\}[\s\S]{0,400}?需更新/.test(source));
ok("徽章带 clickable 样式类", source.includes("clickable") && source.includes(".dsh-mcp-badge.clickable"));

// 3e. 详情弹层必须也给出更新入口（只在卡片上修，弹层里仍只有送还 = 半个 bug）。
ok("详情弹层的动作区消费 detailActions.update", source.includes("detailActions.update"));

// 3f. 徽章声明了 role=button + tabIndex=0，就必须能键盘触发——否则是个「假按钮」：
// 鼠标能点、Tab 能聚焦，但按 Enter 什么都不发生。这类无障碍缺口编译器同样看不见。
ok("「需更新」徽章声明了 role=button 与 tabIndex", /role:\s*'button'/.test(source) && /tabIndex:\s*0/.test(source));
ok(
	"「需更新」徽章带 onKeyDown（Enter/Space 也能触发更新，不只是鼠标）",
	/onKeyDown:\s*\(e\)\s*=>\s*\{[^}]*'Enter'[^}]*\}/.test(source) && /onKeyDown:[\s\S]{0,300}?summon\(item\)/.test(source),
);

console.log(`\n${failures === 0 ? "EXPERT-CARD-ACTIONS PASS" : "EXPERT-CARD-ACTIONS FAIL"}`);
process.exit(failures === 0 ? 0 : 1);
