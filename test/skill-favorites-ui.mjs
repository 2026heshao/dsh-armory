// 技能收藏 UI 侧的静态 + 纯函数回归：
//   ① 搜索过滤：空 query 原样返回（保序）；非空 name+description 不区分大小写；不改排序；
//   ② 三级定位：默认右开、贴右缘左开、两侧不足贴 8px、纵向 8px 夹取、390 窄窗宽度收窄；
//   ③ orderSubItems：最近优先排序保留，但不再注入 __badge / __recentRank；
//   ④ 看板三处星标结构（外层容器 + 主按钮 + 星标按钮）与菜单搜索/收藏入口接线；
//   ⑤ RPC 三处契约都在，且没有残留的「最近」徽章文案。
// 附反向自测：注回 __badge / 只按名称过滤 / 永远右开，断言必须变红。
//
// 运行：node ./test/skill-favorites-ui.mjs

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLIENT = join(ROOT, "lib", "client.js");
const TYPERT = join(ROOT, "lib", "typert.js");
const HOST = join(ROOT, "lib", "index.js");

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
const typertSource = await readFile(TYPERT, "utf8");
const hostSource = await readFile(HOST, "utf8");

const grab = (text, startMark, endMark) => {
	const start = text.indexOf(startMark);
	if (start < 0) return "";
	const end = text.indexOf(endMark, start + startMark.length);
	return end > start ? text.slice(start, end) : "";
};

section("0. 源码切片");
const TEXT_HELPERS = grab(source, "const TEXT_KEYS_ZH", "const applyI18nLocale");
const FAV_HELPERS = grab(source, "const SKILL_FAVORITE_MENU_WIDTH = 196;", "const SummonQuickMenu = (");
const ORDER_HELPERS = grab(source, "  const recentListFor = (kind) =>", "  const subItems = (kind) =>");
ok("能定位文本归一一节", TEXT_HELPERS.length > 0);
ok("能定位搜索/定位/收藏清单纯函数一节", FAV_HELPERS.length > 0, `len=${FAV_HELPERS.length}`);
ok("能定位 orderSubItems 一节", ORDER_HELPERS.length > 0, `len=${ORDER_HELPERS.length}`);

const loadFavHelpers = () => {
	const context = vm.createContext({ console, usesEnglish: () => false });
	vm.runInContext(
		`${TEXT_HELPERS}\nconst SKILL_FAVORITES_MAX = 20;\nconst SKILL_FAVORITE_DESC_MAX = 200;\n${FAV_HELPERS}\n`
		+ "globalThis.__fav = { filterSkillRows, favoriteMenuPlacement, favoriteMenuRows, textOf };",
		context,
		{ filename: "client-fav-helpers.js" },
	);
	return context.__fav;
};
const fav = loadFavHelpers();
const order = (() => {
	const context = vm.createContext({ console });
	vm.runInContext(
		"const recent = { recentSkill: [{ name: 'b', usedAt: 9 }, { name: 'a', usedAt: 5 }], recentMcp: [], recentExpert: [] };\n"
		+ `${ORDER_HELPERS}\n`
		+ "globalThis.__order = { orderSubItems };",
		context,
		{ filename: "client-order-subitems.js" },
	);
	return context.__order;
})();

section("1. filterSkillRows：不区分大小写、匹配 name + description、保序");
{
	const rows = [
		{ name: "Git Helper", description: "常用 Git 操作" },
		{ name: "pdf", description: "PDF 表格与表单" },
		{ name: "image-to-ui", description: "把截图还原成 UI" },
	];
	const byName = fav.filterSkillRows(rows, "gIt");
	ok("名称匹配且不区分大小写", byName.length === 1 && byName[0].name === "Git Helper");
	const byDesc = fav.filterSkillRows(rows, "表格");
	ok("描述匹配", byDesc.length === 1 && byDesc[0].name === "pdf");
	const all = fav.filterSkillRows(rows, "   ");
	ok("空白 query 原样返回同一个数组（保序、不复制）", all === rows);
	const none = fav.filterSkillRows(rows, "zzz");
	ok("无匹配返回空数组", Array.isArray(none) && none.length === 0);
	ok("不修改原数组顺序", rows.map((row) => row.name).join(",") === "Git Helper,pdf,image-to-ui");
	ok("反向自测：只按名称过滤会漏掉描述命中", rows.filter((row) => String(row.name).toLowerCase().includes("表格")).length === 0);
}

section("2. favoriteMenuPlacement：右 / 左 / 贴边 / 纵向夹取");
{
	const row = { left: 100, right: 300, top: 100, bottom: 128 };
	const right = fav.favoriteMenuPlacement({ rowRect: row, panelHeight: 120, viewportW: 1000, viewportH: 700 });
	ok("右侧有空间 → 右开，左缘 = 行右缘 + 4", right.side === "right" && right.left === 304 && right.arrow === "right");
	ok("三级面板相对收藏行上提 8px", right.top === 92, `top=${right.top}`);

	const rightEdgeRow = { left: 700, right: 900, top: 100, bottom: 128 };
	const left = fav.favoriteMenuPlacement({ rowRect: rightEdgeRow, panelHeight: 120, viewportW: 1000, viewportH: 700 });
	ok("贴右缘且左侧够 → 左开", left.side === "left" && left.left === 500 && left.arrow === "left");
	ok("反向自测：永远右开会把面板推到视口外（904 + 196 > 1000）", rightEdgeRow.right + 4 === 904 && rightEdgeRow.right + 4 + 196 > 1000 && left.left < 900);

	const narrowRow = { left: 110, right: 326, top: 100, bottom: 128 };
	const edge = fav.favoriteMenuPlacement({ rowRect: narrowRow, panelHeight: 120, viewportW: 390, viewportH: 700 });
	ok("390 窄窗两侧都不足 → 贴边", edge.side === "edge" && edge.width === 196, `side=${edge.side} left=${edge.left}`);
	ok("贴边后右缘仍留 8px", edge.left + edge.width === 390 - 8, `left=${edge.left}`);
	ok("贴边时箭头朝左（面板在行左侧）", edge.arrow === "left");

	const bottom = fav.favoriteMenuPlacement({ rowRect: { left: 100, right: 300, top: 250, bottom: 278 }, panelHeight: 120, viewportW: 1000, viewportH: 300 });
	ok("纵向下缘夹到 8px", bottom.top === 300 - 120 - 8, `top=${bottom.top}`);
	const top = fav.favoriteMenuPlacement({ rowRect: { left: 100, right: 300, top: 2, bottom: 30 }, panelHeight: 120, viewportW: 1000, viewportH: 700 });
	ok("纵向上缘夹到 8px", top.top === 8, `top=${top.top}`);

	const tiny = fav.favoriteMenuPlacement({ rowRect: { left: 20, right: 120, top: 10, bottom: 38 }, panelHeight: 120, viewportW: 200, viewportH: 700 });
	ok("极窄视口：宽度收到 vw - 16", tiny.width === 184, `width=${tiny.width}`);
}

section("3. favoriteMenuRows：null = 不可用；数组 = 归一后的可用清单");
{
	ok("ok:false → null", fav.favoriteMenuRows({ ok: false }) === null);
	ok("缺 skills → null", fav.favoriteMenuRows({ ok: true }) === null);
	const rows = fav.favoriteMenuRows({
		ok: true,
		skills: [
			{ name: "old", description: { zh: "旧" }, favoritedAt: 10 },
			{ name: "new", description: "新", favoritedAt: 30 },
			{ name: "old", description: "重复", favoritedAt: 20 },
			{ name: "", description: "无名", favoritedAt: 40 },
		],
	});
	ok("按 favoritedAt 倒序", rows.map((row) => row.name).join(",") === "new,old");
	ok("对象 description 被归一成字符串", typeof rows.find((row) => row.name === "old").description === "string");
	ok("无名条目被丢弃", rows.every((row) => row.name));

	const many = fav.favoriteMenuRows({ ok: true, skills: Array.from({ length: 25 }, (_, index) => ({ name: `s${index}`, favoritedAt: index })) });
	ok("最多保留 20 条", many.length === 20 && many[0].name === "s24");
}

section("4. orderSubItems：最近优先排序保留，徽章字段消失");
{
	const items = [{ name: "a" }, { name: "b" }, { name: "c" }];
	const sorted = order.orderSubItems("skill", items);
	ok("最近使用 b → a → 原序 c", sorted.map((row) => row.name).join(",") === "b,a,c");
	ok("返回原对象引用（不复制、不注入字段）", sorted[0] === items[1] && sorted[1] === items[0] && sorted[2] === items[2]);
	ok("没有 __badge", sorted.every((row) => !("__badge" in row)));
	ok("没有 __recentRank", sorted.every((row) => !("__recentRank" in row)));
	const untouched = order.orderSubItems("mcp", items);
	ok("该 kind 没有最近记录时原样返回（同一数组）", untouched === items);
	ok("反向自测：注回 __badge 会出现在结果里",
		(() => {
			const mutated = ORDER_HELPERS.replace(
				".map((entry) => entry.item);",
				".map((entry) => ({ ...entry.item, __badge: entry.rank < 6 }));",
			);
			const context = vm.createContext({ console });
			vm.runInContext(
				"const recent = { recentSkill: [{ name: 'b', usedAt: 9 }], recentMcp: [], recentExpert: [] };\n"
				+ `${mutated}\n`
				+ "globalThis.__x = orderSubItems('skill', [{ name: 'a' }, { name: 'b' }]);",
				context,
			);
			return context.__x.some((row) => "__badge" in row);
		})());
}

section("5. 源码接线：看板三处星标 + 菜单搜索/收藏三级");
{
	ok("网格卡片有 card-hit 主按钮", source.includes("className: 'dsh-mcp-skill-card-hit'"));
	ok("列表行有独立 row 容器", source.includes("className: 'dsh-mcp-skill-row'"));
	ok("网格与列表都调用 favoriteButton(s)", (source.match(/favoriteButton\(s\)/g) || []).length >= 2);
	ok("详情头调用 favoriteButton(summary, 'dsh-mcp-skill-d-fav')", source.includes("favoriteButton(summary, 'dsh-mcp-skill-d-fav')"));
	ok("星标按钮 CSS 存在", source.includes(".dsh-mcp-skill-star{"));
	ok("星标触屏常显", source.includes("@media (hover:none){.dsh-mcp-skill-star{opacity:1}}"));
	ok("看板读收藏有独立 catch", /call\('wbSkillFavorites'\)[\s\S]{0,120}?\.catch/.test(source) || /const loadFavorites = useCallback[\s\S]{0,300}?catch/.test(source));
	ok("写收藏调用 wbSkillFavoriteSet", source.includes("call('wbSkillFavoriteSet'"));

	ok("菜单有搜索框", source.includes("dsh-mcp-quick-search"));
	ok("菜单有收藏固定行", source.includes("dsh-mcp-quick-fav-row"));
	ok("菜单有 196px 三级面板", source.includes("dsh-mcp-quick-sub3"));
	ok("三级定位用纯函数", source.includes("favoriteMenuPlacement({"));
	ok("空态文案齐全", source.includes("t('还没有收藏：')") && source.includes("t('到 Skill 看板点 ☆ 收藏')"));
	ok("无结果文案", source.includes("t('没有匹配「{0}」的技能'"));
	ok("收藏行在搜索之后、列表之前（源码顺序）",
		source.indexOf("dsh-mcp-quick-search") < source.indexOf("dsh-mcp-quick-fav-row")
		&& source.indexOf("dsh-mcp-quick-fav-row") < source.indexOf("className: 'dsh-mcp-quick-list'", source.indexOf("dsh-mcp-quick-fav-row")));
	ok("搜索框聚焦时 scheduleClose 直接返回", /const scheduleClose = \(\) => \{[\s\S]{0,300}?if \(searchFocused\.current\) return;/.test(source));
	ok("搜索框 onFocus 取消关闭计时", /onFocus: \(\) => \{ searchFocused\.current = true; cancelClose\(\); \}/.test(source));
	ok("搜索框 blur 只在焦点离开 root 时排关闭（Tab 到菜单内不误关）", source.includes("rootRef.current.contains(next)"));
	ok("Escape 有词时只清词并阻止冒泡", /if \(e\.key === 'Escape' && skillQuery\) \{\s*e\.stopPropagation\(\);\s*setSkillQuery\(''\);/.test(source));
	ok("组合输入有 isComposing 保护", source.includes("e.nativeEvent && e.nativeEvent.isComposing"));
	ok("收藏三级点击复用 pick + quickMentionText", /pick\('skill', row, quickMentionText\('skill', row\)\)/.test(source));

	ok("「最近」徽章字段已清除", !source.includes("__badge") && !source.includes("__recentRank"));
	ok("不再渲染 t('最近') / t('最近使用')", !/\bt\('最近'\)/.test(source) && !/\bt\('最近使用'\)/.test(source));
	ok("排序注释与标记仍在", source.includes("// 子菜单排序：最近使用"));
}

section("5b. 尺寸账：216 / 196 / 26 / 28 / 168 / 20×2 = 280");
{
	const ruleOf = (selector) => {
		const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const match = source.match(new RegExp(`^${escaped}\\{([^}]*)\\}`, "m"));
		return match ? match[1] : "";
	};
	const px = (rule, prop) => {
		const match = rule.match(new RegExp(`${prop}:([0-9.]+)px`));
		return match ? Number(match[1]) : NaN;
	};
	const sub = ruleOf(".dsh-mcp-quick-sub");
	const search = ruleOf(".dsh-mcp-quick-search");
	const fav = ruleOf(".dsh-mcp-quick-fav");
	const list = ruleOf(".dsh-mcp-quick-list");
	const manage = ruleOf(".dsh-mcp-quick-manage");
	const sub3 = ruleOf(".dsh-mcp-quick-sub3");
	ok("二级宽 216 + border-box + max-height 280/56vh",
		px(sub, "width") === 216 && sub.includes("box-sizing:border-box") && sub.includes("max-height:min(280px,56vh)"));
	ok("搜索 26 + 下间距 2", px(search, "height") === 26 && px(search, "margin-bottom") === 2);
	ok("收藏行 28 + 下间距 2", px(fav, "height") === 28 && px(fav, "margin-bottom") === 2);
	ok("列表视口 168", px(list, "max-height") === 168);
	ok("管理按钮 20 + 上间距 2", px(manage, "height") === 20 && px(manage, "margin-top") === 2);
	const content = 26 + 2 + 28 + 2 + 168 + 2 + 20 + 20;
	const outer = content + px(sub, "padding") * 2 + 1 * 2;
	ok("内容账 268", content === 268, `content=${content}`);
	ok("外高 = 268 + padding 10 + 边框 2 = 280", outer === 280, `outer=${outer}`);
	ok("三级 196 宽", px(sub3, "width") === 196);
	ok("三级列表 168", source.includes(".dsh-mcp-quick-sub3 .dsh-mcp-quick-list{max-height:168px}"));
	ok("三级行显式 border-box + 28px 外高（6 行不会变 5 行）",
		source.includes(".dsh-mcp-quick-sub3 .dsh-mcp-quick-item{box-sizing:border-box;height:28px"));
}

section("6. RPC 三处契约");
{
	ok("client 有 wbSkillFavorites 描述符", /id: 'dsh-armory#mcpManager\/wbSkillFavorites'[\s\S]{0,160}?method: 'wbSkillFavorites'/.test(source));
	ok("client 有 wbSkillFavoriteSet 描述符", /id: 'dsh-armory#mcpManager\/wbSkillFavoriteSet'[\s\S]{0,160}?method: 'wbSkillFavoriteSet'/.test(source));
	ok("typert 声明两个方法", typertSource.includes("mv('wbSkillFavorites'") && typertSource.includes("mv('wbSkillFavoriteSet'"));
	ok("host 有两个 async 方法", hostSource.includes("async wbSkillFavorites(") && hostSource.includes("async wbSkillFavoriteSet("));
	ok("host 校验 favorite 布尔", /typeof \(payload && payload\.favorite\) !== \"boolean\"/.test(hostSource));
}

section("7. 反向自测：源码检查不是恒真");
{
	const withBadge = source.replace("// 「最近」徽章已移除；排序仍在 orderSubItems 里保留。", "item.__badge ? h('span', null, t('最近')) : null;");
	ok("注回徽章后 __badge 检查会变红", !withBadge.includes("__badge") === false);
	const withBadgeWord = source.replace("// 「最近」徽章已移除；排序仍在 orderSubItems 里保留。", "t('最近')");
	ok("注回 t('最近') 后文案检查会变红", /\bt\('最近'\)/.test(withBadgeWord));
}

console.log(`\n${checks - failures}/${checks} passed`);
console.log(failures === 0 ? "SKILL FAVORITES UI PASS" : `${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
