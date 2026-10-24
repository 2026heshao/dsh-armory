// Skill 看板与已召唤专家页的头像位回归（2026-10-24 用户报：让 skill 页和专家页显示出
// 「和市场类似」的头像，别再是一枚 10px 分类色块 / 纯文字）。
//
// 两类头像、两条数据路径，缺一路页面就退回灰卡：
//   ① 本地 skill 没有任何图标字段（宿主注册表只给能力位与来源），头像只能**生成**——
//      SkillAvatar 按 skill 名哈希出色相画「渐变圆 + 首字母」。必须钉住：
//      纯本地计算（无 img / 无 fetch / 不进 avatarRegistry）、同一名同色、
//      网格卡 / 列表行 / 详情头三个位置都真的用上。
//   ② 已召唤专家预设行自带 avatarUrl —— wbExpertInstalled 里 `...info` 展开的
//      readExpertDisplayNames 结果，avatarUrl 必须在 names 表里（与 projectExpert 同一拼法：
//      EXPERT_ORIGIN + entry.avatar），否则卡片头像位永远回落字母。预设卡 / 推荐位 /
//      在场行 / 详情弹层四处都要挂 Avatar。
//
// 手法沿用 install-toast.mjs：SkillAvatar 一节自足（只依赖 h），抽源码进 vm 真渲染，
// 对产出元素树断言；渲染点位与 expert-market 侧用源码针。零网络、零真实 ~/.dsh。
//
// 运行：node ./test/skill-expert-avatar.mjs（经 test/run-all.mjs 白名单随全量跑）
// 退出码：0 全过；1 有失败。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "..", "lib", "client.js");
const MARKET = join(HERE, "..", "lib", "expert-market.js");

let failures = 0;
let checks = 0;
const ok = (name, condition, extra = "") => {
	checks += 1;
	const pass = !!condition;
	if (!pass) failures += 1;
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};
const section = (title) => console.log(`\n── ${title} ─────────────────────────────────────────────`);

const clientSrc = await readFile(CLIENT, "utf8");
const marketSrc = await readFile(MARKET, "utf8");

// ═══════════════════════════════════════════════════════════════════════════
// 第 1 节 · SkillAvatar：抽源码进 vm 真渲染
// ═══════════════════════════════════════════════════════════════════════════
section("1. SkillAvatar 生成头像（vm 真渲染）");
const AVA_START = "const skillAvatarHue = (name) => {";
const AVA_END = "// ── Skill 看板：列表 + 详情 ──────────────────────────────────────────";
const avaStart = clientSrc.indexOf(AVA_START);
const avaEnd = clientSrc.indexOf(AVA_END, avaStart + AVA_START.length);
ok("能在 lib/client.js 里定位到 SkillAvatar 一节的起止标记", avaStart >= 0 && avaEnd > avaStart, `start=${avaStart} end=${avaEnd}`);
if (avaStart < 0 || avaEnd <= avaStart) {
	console.log("\nSKILL-EXPERT-AVATAR FAIL（锚点缺失，无法抽取待测源码）");
	process.exit(1);
}
const AVA_SLICE = clientSrc.slice(avaStart, avaEnd);
ok("抽出的片段含 skillAvatarHue 与 SkillAvatar", AVA_SLICE.includes("const skillAvatarHue = (name) => {") && AVA_SLICE.includes("const SkillAvatar = ({ name, size, title }) => {"));

// h 替身：产出普通对象树（type/props/children），够断言类名、内联样式与文本。
const h = (type, props, ...children) => ({
	type,
	props: props || {},
	children: children.flat().filter((child) => child !== null && child !== undefined),
});

let vmFail = "";
const sandbox = {
	h,
	// hook 垫片：useSkillIcons 的 effect 只做订阅/入队登记，测试里不需要真跑。
	useState: (init) => [typeof init === "function" ? init() : init, () => {}],
	useEffect: () => {},
	// 图标/头像层不得触网：塞进会抛错的替身，一旦被引用立刻暴露。
	Image: function () { throw new Error("头像层不该用 Image"); },
	fetch: () => { throw new Error("头像层不该 fetch"); },
};
try {
	vm.runInNewContext(`${AVA_SLICE}\nglobalThis.__exports = { skillAvatarHue, SkillAvatar, skillIconFromDir, skillIconFor, skillIconCache, skillIconEnqueue, skillIconWaiters, SKILL_ICON_INFLIGHT_MAX };`, sandbox, { timeout: 2000 });
} catch (error) {
	vmFail = String(error && error.message || error);
}
ok("片段能在 vm 里执行（只依赖 h 与 hook 垫片）", vmFail === "", vmFail);
const { skillAvatarHue, SkillAvatar, skillIconFromDir, skillIconFor, skillIconCache, skillIconEnqueue, skillIconWaiters, SKILL_ICON_INFLIGHT_MAX } = sandbox.__exports || {};

if (skillAvatarHue && SkillAvatar) {
	const hueA = skillAvatarHue("dev-expert");
	const hueB = skillAvatarHue("dev-expert");
	ok("同一名永远同一色相（确定性）", hueA === hueB && Number.isInteger(hueA));
	const hueOther = skillAvatarHue("ui-designer");
	ok("不同名色相不同（可辨识）", hueOther !== hueA);
	ok("色相落在 0..359", [...Array(200).keys()].every((i) => Number.isInteger(skillAvatarHue(`skill-${i}`)) && skillAvatarHue(`skill-${i}`) >= 0 && skillAvatarHue(`skill-${i}`) < 360));
	const hues = new Set([...Array(64).keys()].map((i) => skillAvatarHue(`wbexpert__senior-developer__skill-${i}`)));
	ok("64 个不同名的色相可辨（不挤在同一档）", hues.size >= 32, `distinct=${hues.size}`);

	const node = SkillAvatar({ name: "dev-expert", title: "编程开发" });
	ok("渲染为 span.dsh-mcp-skill-avatar", node.type === "span" && String(node.props.className).includes("dsh-mcp-skill-avatar"));
	ok("内联渐变底色（linear-gradient + hsl）", String(node.props.style.background).includes("linear-gradient") && String(node.props.style.background).includes("hsl("));
	ok("同一名渲染出同一底色", SkillAvatar({ name: "dev-expert" }).props.style.background === node.props.style.background);
	ok("children 是首字母（大写）", node.children.join("") === "D");
	ok("title 透传（分类语义保留在头像上）", node.props.title === "编程开发");
	ok("sm / lg 尺寸类生效", String(SkillAvatar({ name: "x", size: "sm" }).props.className).includes("sm") && String(SkillAvatar({ name: "x", size: "lg" }).props.className).includes("lg"));
	ok("空名回落 ?，不抛错", SkillAvatar({ name: "" }).children.join("") === "?");
} else {
	ok("vm 里取到 skillAvatarHue 与 SkillAvatar", false);
}

// ── 1b. 真图标推导（vm 内同源函数）─────────────────────────────────────────
if (skillIconFromDir && skillIconFor && skillIconCache) {
	const experts = new Map([["senior-developer", "https://cos.example/avatars/SeniorDeveloper.png"]]);
	ok("wbexpert 目录名反推专家头像", skillIconFromDir("C:/Users/x/.agents/skills/wbexpert__senior-developer__browser-use", experts) === "https://cos.example/avatars/SeniorDeveloper.png");
	ok("反斜杠路径同样可解析（Windows 分隔符）", skillIconFromDir("C:\\Users\\x\\.agents\\skills\\wbexpert__senior-developer__frontend-dev", experts).includes("SeniorDeveloper"));
	ok("非 wbexpert 目录返回空（交给 SkillHub 层）", skillIconFromDir("C:/x/.agents/skills/clawhub_steipete__github", experts) === "");
	ok("目录里查不到的 plugin 返回空", skillIconFromDir("C:/x/skills/wbexpert__nobody__skill", experts) === "");
	ok("空 path 安全返回空", skillIconFromDir("", experts) === "" && skillIconFromDir(undefined, experts) === "");
	// skillIconFor 的三层优先级：目录反推 → 补全缓存 → ''。
	const s = { name: "browser-use", path: "C:/x/skills/wbexpert__senior-developer__browser-use" };
	ok("skillIconFor 优先目录反推", skillIconFor(s, experts) === "https://cos.example/avatars/SeniorDeveloper.png");
	const s2 = { name: "brandkit", path: "" };
	skillIconCache.set("brandkit", "https://icon.example/brandkit.png");
	ok("skillIconFor 回落补全缓存", skillIconFor(s2, experts) === "https://icon.example/brandkit.png");
	ok("skillIconFor 都没有时返回空串", skillIconFor({ name: "nope", path: "" }, experts) === "");
	skillIconCache.delete("brandkit");
	ok("并发闸门 ≤3（与头像探活同一纪律）", SKILL_ICON_INFLIGHT_MAX === 3);
	ok("waiters 是订阅集合（结果落地通知重绘）", typeof skillIconWaiters.add === "function" && typeof skillIconWaiters.delete === "function");
	// 入队去重：同名第二次入队被跳过，缓存命中的不入队。
	skillIconCache.set("cached-skill", "https://icon.example/x.png");
	const calls = [];
	const callStub = () => { calls.push(1); return Promise.resolve({ ok: true, skills: [] }); };
	skillIconEnqueue(callStub, "cached-skill");
	skillIconEnqueue(callStub, "brandkit2");
	skillIconEnqueue(callStub, "brandkit2");
	await new Promise((resolve) => setTimeout(resolve, 10));
	ok("入队去重：缓存命中不查、同名只查一次", calls.length === 1, `实际请求 ${calls.length} 次`);
} else {
	ok("vm 里取到图标子系统导出", false);
}

// ═══════════════════════════════════════════════════════════════════════════
// 第 2 节 · Skill 看板三个头像位（源码针）
// ═══════════════════════════════════════════════════════════════════════════
section("2. Skill 看板：网格卡 / 列表行 / 详情头");
const boardStart = clientSrc.indexOf("const SkillBoard = ({ call, scope, timer }) => {");
const boardEnd = clientSrc.indexOf("// 预设状态、捆绑技能、送还、打开看板入口说明", boardStart);
ok("能定位到 SkillBoard 组件源码段", boardStart >= 0 && boardEnd > boardStart);
const BOARD = boardEnd > boardStart ? clientSrc.slice(boardStart, boardEnd) : "";
ok("网格卡 card-top：真图优先、生成头像兜底（分类色块不再出现在卡上）",
	BOARD.includes("skillIconFor(s, expertByPlugin)")
	&& BOARD.includes("h(Avatar, { url: skillIconFor(s, expertByPlugin), name: s.name, className: 'dsh-mcp-skill-avatar-img', title: sCat.name })")
	&& BOARD.includes("h(SkillAvatar, { name: s.name, title: sCat.name })")
	&& !BOARD.includes("dsh-mcp-skill-card-top' },\n                              h('span', { className: 'dsh-mcp-skill-cat-tile'"));
ok("列表行行首有头像（真图/生成双分支）", BOARD.includes("h(SkillAvatar, { name: s.name, size: 'sm' })") && BOARD.includes("className: 'dsh-mcp-skill-avatar-img sm'"));
ok("详情头有 lg 头像（真图/生成双分支）", BOARD.includes("h(SkillAvatar, { name: summary.name, size: 'lg' })") && BOARD.includes("dsh-mcp-skill-d-id") && BOARD.includes("className: 'dsh-mcp-skill-avatar-img lg'"));
// 分类色块仍保留在非头像位（分组头 / 分割线），不是被全删。
ok("分类色块仍保留在分组头上（分类语义没被顺手删掉）", (BOARD.match(/dsh-mcp-skill-cat-tile/g) || []).length >= 2);
// 图标子系统接线：看板挂载即拉共享目录（wbexpert 反查数据源）+ 订阅补全结果。
ok("看板接了专家目录反查（expertByPlugin）", BOARD.includes("loadExpertCatalogShared(call)") && BOARD.includes("setExpertByPlugin"));
ok("看板接了 SkillHub 补全（useSkillIcons）", BOARD.includes("useSkillIcons(call, filtered, expertByPlugin)"));

// ═══════════════════════════════════════════════════════════════════════════
// 第 3 节 · 已召唤专家页：avatarUrl 数据链 + 四个头像位（源码针）
// ═══════════════════════════════════════════════════════════════════════════
section("3. 已召唤专家页：数据链与头像位");
ok("readExpertDisplayNames 输出 avatarUrl（与 projectExpert 同拼法）",
	marketSrc.includes("avatarUrl: entry.avatar ? EXPERT_ORIGIN + String(entry.avatar) : \"\","));
// wbExpertInstalled 以 `...info` 展开 displayNames 表 → avatarUrl 自动随行；钉住展开顺序没被倒置。
const installedStart = clientSrc.indexOf("const ExpertInstalledBoard = ({ call }) => {");
const installedEnd = clientSrc.indexOf("// 装备清单「去市场」需要把专家搜索词带进专家页", installedStart);
const INSTALLED = installedEnd > installedStart ? clientSrc.slice(installedStart, installedEnd) : "";
ok("能定位到 ExpertInstalledBoard 组件源码段", INSTALLED.length > 0);
ok("预设卡是市场同款 card-person + Avatar（目录优先，回落行字段）",
	INSTALLED.includes("h('div', { className: 'dsh-mcp-card-person' },") && INSTALLED.includes("h(Avatar, { url: presetAvatar(row.plugin) || row.avatarUrl, name: presetLabel"));
ok("预设卡显示名跟宿主语言（nameZh/nameEn 投影，plugin 兜底）",
	INSTALLED.includes("row.nameEn || row.nameZh || row.plugin") && INSTALLED.includes("row.nameZh || row.nameEn || row.plugin"));
// 宿主侧 expert-market.js 未重启加载时 wbExpertInstalled 不带 avatarUrl——已召唤页
// 必须无条件合并共享目录（稳定旧 RPC）才能出真图，这是「只有字母」那次回归的修复点。
ok("共享目录无条件合并（不因架上有预设而跳过）",
	INSTALLED.includes("if (loading) return undefined;") && INSTALLED.includes("loadExpertCatalogShared(call)"));
ok("目录 → avatarUrl 映射在场（catalogAvatar / presetAvatar）",
	INSTALLED.includes("catalogAvatar.set(item.plugin, item.avatarUrl") && INSTALLED.includes("const presetAvatar = (plugin) => catalogAvatar.get(plugin) || ''"));
ok("推荐位卡片有头像（item.avatarUrl）", INSTALLED.includes("h(Avatar, { url: item.avatarUrl, name: item.name || item.plugin"));
ok("在场行有小头像（目录优先，回落行字段）", INSTALLED.includes("className: 'dsh-mcp-onsite-avatar'") && INSTALLED.includes("presetAvatar(plugin) || preset.avatarUrl"));
ok("详情弹层头有头像（dsh-mcp-wb-modal-head + detail.avatarUrl）",
	INSTALLED.includes("dsh-mcp-wb-modal-head") && INSTALLED.includes("h(Avatar, { url: detail.avatarUrl, name: detail.name || detail.plugin"));

// ═══════════════════════════════════════════════════════════════════════════
// 第 4 节 · CSS 配套
// ═══════════════════════════════════════════════════════════════════════════
section("4. CSS 配套");
for (const needle of [
	".dsh-mcp-skill-avatar{",
	".dsh-mcp-skill-avatar.sm{",
	".dsh-mcp-skill-avatar.lg{",
	".dsh-mcp-skill-avatar-img{",
	".dsh-mcp-skill-avatar-img.sm{",
	".dsh-mcp-skill-avatar-img.lg{",
	".dsh-mcp-skill-avatar-img.fallback{",
	".dsh-mcp-skill-d-id{",
	".dsh-mcp-onsite-avatar{",
	".dsh-mcp-onsite-avatar.fallback{",
	".dsh-mcp-wb-modal-head{",
]) ok(`样式在场：${needle}`, clientSrc.includes(needle));

// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n${failures ? "FAIL" : "PASS"}  skill-expert-avatar：${checks} 项断言，${failures} 项失败`);
process.exit(failures ? 1 : 0);
