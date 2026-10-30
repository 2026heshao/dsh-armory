// 召唤菜单「专家显示名」回归（2026-10-24 用户报：输入框召唤菜单 → 专家二级菜单整列英文
// 标识名 senior-developer / software-company / ui-designer…，要中文、直接显示专家名）。
//
// 根因链（两层，缺一不可）：
//   ① 运行时副本的 lib/index.js 落后于仓库 —— wbExpertInstalled 里还是
//      `presets.map((row) => ({ ...row, ...(displayNames.get(row.plugin) || {}) }))`，
//      没有 readExpertDisplayNames 合并，nameZh/nameEn 恒缺 → 客户端按
//      `nameZh || nameEn || plugin` 回落到 patch 里的英文标识名。
//   ② 即便 ① 修好，显示名也只有一条来源：1.1MB 的专家目录缓存
//      （~/.dsh/wb-market/experts/expert_center.json）。没开过市场面板 = 缓存没落盘、
//      专家已下架 = 缓存里查不到，两种情况下菜单照样蹦英文标识名。
//
// 本套件钉的是 ② 的修法：召唤那一刻 `WorkBuddy 专家 · <显示名>` 就随预设行写进了
// profile patch，读侧（readExpertPresets）剥掉前缀即得专家名，于是回落变成三层
// ——目录缓存（中英两套、随目录刷新）→ 预设行自带名 → 英文标识名。
// 断言全部离线：writeExpertPreset / readExpertPresets 只吃字符串、不碰真实 ~/.dsh、
// 不联网；index.js 与 client.js 侧用源码针（那两处一个绑宿主类、一个绑 React 组件，
// node 里跑不了，参照 test/recent-sort-regression.mjs 的 MARK + sliceBetween 手法）。
//
// 运行：node ./test/expert-display-name.mjs（同时也经 test/run-all.mjs 白名单随全量跑）
// 退出码：0 全过；1 有失败。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 必须走 fileURLToPath：本仓库路径含中文，URL.pathname 是百分号编码的。
const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "lib");
const market = await import(pathToFileURL(join(LIB, "expert-market.js")).href);

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

const marketSrc = await readFile(join(LIB, "expert-market.js"), "utf8");
const indexSrc = await readFile(join(LIB, "index.js"), "utf8");
const clientSrc = await readFile(join(LIB, "client.js"), "utf8");

// ═══════════════════════════════════════════════════════════════════════════
// 第 0 节 · 源码定位（标记缺失即整体失败，避免「测了个空」）
// ═══════════════════════════════════════════════════════════════════════════
section("0. 源码定位");
const MARK = {
	prefixConst: 'const EXPERT_PRESET_NAME_PREFIX = "WorkBuddy 专家 · ";',
	readFnStart: "export function readExpertPresets(content) {",
	readFnEnd: "  return rows;\n}",
	writeNameLine: "config.set(\"name\", `${EXPERT_PRESET_NAME_PREFIX}${spec.displayName}`);",
	installedStart: "	async wbExpertInstalled() {",
	installedEnd: "		skills: await expertApi.listExpertSkills(),\n\t\t};",
	clientPrefix: "const EXPERT_PRESET_LABEL_PREFIX = 'WorkBuddy 专家 · ';",
};
const SOURCES = { "lib/expert-market.js": marketSrc, "lib/index.js": indexSrc, "lib/client.js": clientSrc };
const missing = Object.entries(MARK)
	.filter(([, needle]) => !Object.values(SOURCES).some((src) => src.includes(needle)))
	.map(([key]) => key);
ok("所有源码针都能在 lib/ 里定位到", missing.length === 0, missing.length ? `缺失=${missing.join(",")}` : "");

const sliceBetween = (source, startMark, endMark, label) => {
	const startAt = source.indexOf(startMark);
	if (startAt < 0) throw new Error(`找不到起始标记（${label}）：${startMark}`);
	const endAt = source.indexOf(endMark, startAt + startMark.length);
	if (endAt <= startAt) throw new Error(`找不到结束标记（${label}）：${endMark}`);
	return source.slice(startAt, endAt + endMark.length);
};
const READ_FN = sliceBetween(marketSrc, MARK.readFnStart, MARK.readFnEnd, "readExpertPresets");
const INSTALLED = sliceBetween(indexSrc, MARK.installedStart, MARK.installedEnd, "wbExpertInstalled");

// ═══════════════════════════════════════════════════════════════════════════
// 第 1 节 · 写读往返：预设行自带显示名，读侧剥得出来
// ═══════════════════════════════════════════════════════════════════════════
section("1. writeExpertPreset → readExpertPresets 往返");
const BASE_PATCH = "- id: ui-theme\n  name: \"@deepseek-ai/dsh-client-ui-theme\"\n  config:\n    preference: light\n";
const written = market.writeExpertPreset(BASE_PATCH, {
	plugin: "senior-developer",
	displayName: "吴八哥",
	profession: "高级开发工程师",
	description: "10年以上全栈经验",
	personaText: "# 角色\n吴八哥人设正文",
});
const roundTrip = market.readExpertPresets(written.content);
ok("往返读回 1 行", roundTrip.length === 1, `实际=${roundTrip.length}`);
ok("读侧剥前缀用的是常量（前缀字面量不在函数里再抄一遍）", READ_FN.includes("EXPERT_PRESET_NAME_PREFIX"));
ok("读侧把 displayName 写进行对象（漏了这个字段，第 1 节的断言全都会空转）", /rows\.push\(\{[\s\S]*?\bdisplayName,[\s\S]*?\}\)/.test(READ_FN));
ok("plugin 仍从预设行 id 剥出（英文标识名，主键不变）", roundTrip[0]?.plugin === "senior-developer", `实际=${roundTrip[0]?.plugin}`);
ok("presetId 未被改名动作挤掉", roundTrip[0]?.presetId === "preset-wbexpert-senior-developer", `实际=${roundTrip[0]?.presetId}`);
ok("personaText 仍带出（stale 体检要用）", String(roundTrip[0]?.personaText || "").includes("吴八哥人设正文"));
ok("displayName = 剥掉前缀的专家名（本套件的修复点）", roundTrip[0]?.displayName === "吴八哥", `实际=${roundTrip[0]?.displayName}`);
ok("displayName 不残留 `WorkBuddy 专家 · ` 前缀", !String(roundTrip[0]?.displayName || "").includes("WorkBuddy"));
ok("写侧预设名仍是整串（宿主会话头标签不变）", written.content.includes("name: WorkBuddy 专家 · 吴八哥"));
ok("写侧只有一处前缀字面量（拼名走常量，不再散落）", (marketSrc.match(/WorkBuddy 专家 · \$\{/g) || []).length === 0);

// 团队型 / 名字本身含空格的，剥前缀后不得吃掉首尾字符
const team = market.writeExpertPreset(BASE_PATCH, {
	plugin: "software-company",
	displayName: "软件开发团队",
	profession: "软件开发团队",
	description: "",
	personaText: "## DSH 运行时适配（团队协作桥接）\n正文",
});
ok("团队型同样取回中文名", market.readExpertPresets(team.content)[0]?.displayName === "软件开发团队");

// ═══════════════════════════════════════════════════════════════════════════
// 第 2 节 · 三种异常形态
// ═══════════════════════════════════════════════════════════════════════════
section("2. 手改预设名 / 缺 name / 旧行");
const fixture = (nameLine) => market.readExpertPresets(
	`- insert:\n    - id: preset-wbexpert-ui-designer\n      name: "@deepseek-ai/dsh-agent-preset"\n      config:\n        id: wbexpert-ui-designer\n${nameLine}        plugins:\n          - id: persona\n            name: "@deepseek-ai/dsh-persona"\n            config:\n              prefix: 人设正文\n`,
);
ok("用户在宿主里手改过预设名：原样尊重，不退回标识名", fixture("        name: 我的前端搭子\n")[0]?.displayName === "我的前端搭子", `实际=${fixture("        name: 我的前端搭子\n")[0]?.displayName}`);
ok("预设行没有 name（异常数据）：displayName 空串，交给下一层回落", fixture("")[0]?.displayName === "");
ok("旧版本写的行仍能被读出 plugin（读侧向后兼容）", fixture("        name: WorkBuddy 专家 · 像素君\n")[0]?.plugin === "ui-designer");

// ═══════════════════════════════════════════════════════════════════════════
// 第 3 节 · index.js 三层回落
// ═══════════════════════════════════════════════════════════════════════════
section("3. wbExpertInstalled 的回落链");
const hasThreeLayer = (src) => src.includes("const info = displayNames.get(row.plugin) || {};")
	&& src.includes("nameZh: info.nameZh || row.displayName || \"\"")
	&& src.includes("nameEn: info.nameEn || row.displayName || \"\"");
ok("目录缓存 → 预设行名 → 标识名 三层回落在场", hasThreeLayer(INSTALLED));
ok("目录缓存仍是第一优先（专家改名后不必重新召唤）", INSTALLED.indexOf("...info") > INSTALLED.indexOf("...row"));
ok("旧的单层写法不得复活（只合并 info）", !INSTALLED.includes("...row, ...(displayNames.get(row.plugin) || {})"));
ok("缓存读取失败仍只 warn，不炸整条 RPC", INSTALLED.includes("读取专家显示名失败"));
// 反向自测：把修复前的单层实现注回去，护栏必须变红。
const REGRESSED = INSTALLED.replace(
	"presets: presets.map((row) => {\n\t\t\t\tconst info = displayNames.get(row.plugin) || {};",
	"presets: presets.map((row) => {\n\t\t\t\tconst info = {};",
);
ok("反向自测：去掉预设行兜底后，三层回落断言确实变红", !hasThreeLayer(REGRESSED));

// ═══════════════════════════════════════════════════════════════════════════
// 第 4 节 · 前缀常量的单一来源与跨文件一致
// ═══════════════════════════════════════════════════════════════════════════
section("4. 前缀常量：写读同源 + 与客户端匹配串一致");
const marketPrefix = marketSrc.match(/const EXPERT_PRESET_NAME_PREFIX = "([^"]*)";/)?.[1];
const clientPrefix = clientSrc.match(/const EXPERT_PRESET_LABEL_PREFIX = '([^']*)';/)?.[1];
ok("expert-market.js 前缀常量可解析", typeof marketPrefix === "string" && marketPrefix.length > 0, `实际=${JSON.stringify(marketPrefix)}`);
ok("client.js 匹配用前缀可解析", typeof clientPrefix === "string" && clientPrefix.length > 0, `实际=${JSON.stringify(clientPrefix)}`);
ok("两处前缀逐字相同（拼名 / 匹配宿主标签不会漂移）", marketPrefix === clientPrefix);
// 反向自测：客户端那份被改一个空格，断言必须变红。
ok("反向自测：客户端前缀多一个空格时一致性断言确实变红", marketPrefix !== `${clientPrefix} `);
ok("客户端仍按宿主语言挑名，标识名只是最后兜底", clientSrc.includes("name: row.nameZh || row.nameEn || row.plugin"));

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${failures ? "FAIL" : "PASS"}  expert-display-name：${checks} 项断言，${failures} 项失败`);
process.exit(failures ? 1 : 0);
