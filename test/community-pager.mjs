// 社区 MCP 列表「翻页 + 已读取总数」的行为直测（2026-10-30 用户要求）：
//   · 数量显示的是**本次查询已读取的总数**（跨页累计去重），不是当前页条数；
//   · 翻页是「用户点下一页才加载下一页」，页内容互斥（第 2 页替换第 1 页），
//     不是旧的「加载更多」无限追加 + 300 条封顶。
//
// 为什么不能只做文本断言：页语义（替换/累计/游标栈/换词归零）全在 loadCommunity 的
// 闭包里，正则改一改就能骗过；这里把该函数源码原文抽进 node:vm，配最小 hook 垫片
// **真正执行**，用替身 fetch 喂三页数据，按真实产生的 state 断言。
// 第 4 节把旧「追加」语义注回同一份切片做反向自测——正向断言若空转，这里必须变红。
//
// 只用 node: 内置模块，零网络、零磁盘写。用法：node ./test/community-pager.mjs
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");

const START_MARKER = "const loadCommunity = useCallback(async ({ cursor = '', page = 1, query } = {}) => {";
// 收口用「换行 + 两格缩进 + 依赖数组」整行匹配：只在 `}, [call]);` 里找会撞上
// 闭包内其它同形回调，切片悄悄截短后断言仍可能全绿（2026-10-30 评审）。
const END_MARKER = "\n  }, [call]);\n";

let failures = 0;
const ok = (name, condition, extra = "") => {
	if (!condition) failures += 1;
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};

// ── 0. 抽源码 ────────────────────────────────────────────────────────────────
const source = await readFile(CLIENT, "utf8");
const startAt = source.indexOf(START_MARKER);
const endAt = startAt >= 0 ? source.indexOf(END_MARKER, startAt + START_MARKER.length) : -1;
ok("能定位 loadCommunity 的起止标记", startAt >= 0 && endAt > startAt, `start=${startAt} end=${endAt}`);
if (startAt < 0 || endAt <= startAt) {
	console.log("\nCOMMUNITY-PAGER FAIL（标记缺失，无法抽取待测源码）");
	process.exit(1);
}
const slice = source.slice(startAt, endAt + END_MARKER.length);
ok("切片以 loadCommunity 自己的依赖数组收口（不是闭包内部同形行）", slice.endsWith(END_MARKER) && slice.includes("setCommunityLoading(false)"), `len=${slice.length}`);
ok("切片包含翻页三要素（游标栈 / 页码 / 已读集合）",
	slice.includes("communityCursorsRef.current[page - 1]") && slice.includes("setCommunityPage(page)") && slice.includes("communityReadKeysRef.current.add"));

// ── 1. 源码层：旧的「加载更多」语义必须消失 ─────────────────────────────────
ok("不再有 COMMUNITY_MAX_ROWS 累计上限", !/COMMUNITY_MAX_ROWS/.test(source));
ok("不再有 append 追加参数", !/append\s*=\s*false/.test(slice) && !/append:\s*true/.test(source));
ok("不再有「加载更多 / 已到上限」文案", !source.includes("'加载更多'") && !source.includes("'已到上限，请用搜索缩小范围'"));
ok("翻页控件是「上一页 / 第 N 页 / 下一页」",
	source.includes("t('上一页')") && source.includes("t('下一页')") && source.includes("t('第 {0} 页'"));
ok("工具栏与角标都显示「已读取」累计数",
	source.includes("t('已读取 {0} 条', [communityReadTotal])") && /communityReadTotal \? h\('span'/ .test(source));
ok("en-US 侧有对应词条", /"已读取 \{0\} 条": "/.test(source) && /"第 \{0\} 页": "/.test(source));

// ── 2. vm 垫片：最小 hook / setter / call ────────────────────────────────────
function makeHarness(sourceText, respond) {
	const state = { rows: [], page: 1, next: null, total: 0, loading: false, error: "", stale: false };
	const ctx = {
		COMMUNITY_BATCH_LIMIT: 100,
		communitySeq: { current: 0 },
		communityRowsRef: { current: [] },
		communityQueryRef: { current: "" },
		communityLoadedQueryRef: { current: null },
		communityNamesRef: { current: ["filesystem"] },
		communityCursorsRef: { current: [] },
		communityReadKeysRef: { current: new Set() },
		communityReadQueryRef: { current: null },
		useCallback: (fn) => fn,
		t: (text, vars = []) => String(text).replace(/\{(\d+)\}/g, (raw, i) => (i in vars ? vars[i] : raw)),
		call: async (_method, payload) => respond(payload),
		setCommunityRows: (value) => {
			state.rows = typeof value === "function" ? value(state.rows) : value;
			ctx.communityRowsRef.current = state.rows;
		},
		setCommunityPage: (value) => { state.page = value; },
		setCommunityNextCursor: (value) => { state.next = value; },
		setCommunityLoading: (value) => { state.loading = value; },
		setCommunityError: (value) => { state.error = value; },
		setCommunityStale: (value) => { state.stale = value; },
		setCommunityReadTotal: (value) => { state.total = value; },
	};
	const fn = new Function(...Object.keys(ctx), `${sourceText}\nreturn loadCommunity;`)(...Object.values(ctx));
	return { loadCommunity: fn, state, ctx };
}

const row = (key) => ({ key, title: key.toUpperCase() });

// ── 3. 真跑：三页数据 + 回退 + 换词 ─────────────────────────────────────────
{
	const pages = {
		"": { ok: true, rows: [row("a"), row("b")], nextCursor: "c1" },
		c1: { ok: true, rows: [row("c"), row("d")], nextCursor: "c2" },
		c2: { ok: true, rows: [row("e")], nextCursor: null },
	};
	const h = makeHarness(slice, (payload) => pages[payload.cursor] ?? { ok: true, rows: [], nextCursor: null });

	await h.loadCommunity({ cursor: "", page: 1 });
	ok("第 1 页：只渲染本页 2 条", h.state.rows.map((r) => r.key).join("") === "ab", h.state.rows.map((r) => r.key).join(""));
	ok("第 1 页：页码=1、下一页游标=c1、已读取=2",
		h.state.page === 1 && h.state.next === "c1" && h.state.total === 2, `page=${h.state.page} next=${h.state.next} total=${h.state.total}`);
	ok("游标栈：cursors[0]='' 且 cursors[1]='c1'",
		h.ctx.communityCursorsRef.current[0] === "" && h.ctx.communityCursorsRef.current[1] === "c1");

	await h.loadCommunity({ cursor: "c1", page: 2 });
	ok("第 2 页：内容替换而非追加（仍是 2 条，不是 4 条）", h.state.rows.map((r) => r.key).join("") === "cd", h.state.rows.map((r) => r.key).join(""));
	ok("第 2 页：已读取累计为 4（不是本页 2）", h.state.total === 4, `total=${h.state.total}`);
	ok("第 2 页：下一页游标=c2", h.state.next === "c2");

	await h.loadCommunity({ cursor: "", page: 1 }); // 返回上一页：游标栈第 1 项
	ok("回第 1 页：内容回到 ab", h.state.rows.map((r) => r.key).join("") === "ab");
	ok("回第 1 页：已读取不倒退（仍是 4）", h.state.total === 4, `total=${h.state.total}`);

	// 同一页里重复 key 去重
	h.ctx.communityCursorsRef.current = [];
	h.ctx.communityReadQueryRef.current = null;
	const h2 = makeHarness(slice, () => ({ ok: true, rows: [row("x"), row("x"), row("y")], nextCursor: null }));
	await h2.loadCommunity({ cursor: "", page: 1 });
	ok("同页重复 key 去重（3 行 → 2 条）", h2.state.rows.length === 2, `len=${h2.state.rows.length}`);

	// 换搜索词：已读集合与游标栈归零
	const h3 = makeHarness(slice, (payload) => (payload.search === "new" ? { ok: true, rows: [row("n1")], nextCursor: "n2" } : pages[payload.cursor] ?? { ok: true, rows: [], nextCursor: null }));
	await h3.loadCommunity({ cursor: "", page: 1 });
	await h3.loadCommunity({ cursor: "c1", page: 2 });
	await h3.loadCommunity({ cursor: "", page: 1, query: "new" });
	ok("换搜索词：已读取重新计数（4 → 1）", h3.state.total === 1, `total=${h3.state.total}`);
	ok("换搜索词：游标栈从第一页重建", h3.ctx.communityCursorsRef.current[0] === "" && h3.ctx.communityCursorsRef.current[1] === "n2");

	// 失败：保留上次结果、清掉「已加载过」标记、暴露错误
	const h4 = makeHarness(slice, () => { throw new Error("boom"); });
	await h4.loadCommunity({ cursor: "", page: 1 });
	ok("失败：错误可见且不算已加载", h4.state.error === "boom" && h4.ctx.communityLoadedQueryRef.current === null);
}

// ── 4. 反向自测：把旧「追加」语义注回去，正向断言必须能发现 ─────────────────
{
	const mutated = slice.replace("setCommunityRows(unique);", "setCommunityRows((prev) => prev.concat(unique));");
	ok("反向自测：旧写法注回成功（切片确实被改动）", mutated !== slice);
	const pages = {
		"": { ok: true, rows: [row("a"), row("b")], nextCursor: "c1" },
		c1: { ok: true, rows: [row("c"), row("d")], nextCursor: "c2" },
	};
	const h = makeHarness(mutated, (payload) => pages[payload.cursor]);
	await h.loadCommunity({ cursor: "", page: 1 });
	await h.loadCommunity({ cursor: "c1", page: 2 });
	ok("反向自测：追加语义下第 2 页变 4 条（正向断言会失败）", h.state.rows.length === 4, `len=${h.state.rows.length}`);
}

console.log(failures === 0 ? "\nCOMMUNITY-PAGER PASS" : `\nCOMMUNITY-PAGER FAIL（${failures} 条失败）`);
process.exitCode = failures === 0 ? 0 : 1;
