// i18n 骨架与中文包裹不变式的直测（`lib/client.js` 的 OPT-11 一节）。
//
// 为什么需要这个套件：OPT-11 把全文件 660 处中文展示文案包进了 t()。这一步没有运行时
// 行为变化（字典为空时 t() 恒等返回原文），因此**编译器和现有测试都守不住它**——一次
// 无心的重构（比如把 `t('已召唤')` 手滑写回 `'已召唤'`）不会有任何测试失败，界面照常
// 是中文，但将来补 en-US 表时这个词就成了漏网之鱼。本套件把「全部中文皆已包裹」从
// 口头约定变成可断言的不变量。
//
// 怎么测的（与 client-entry.mjs 同手法）：`lib/client.js` 是浏览器 bundle，不能直接
// import。i18n 骨架一节是自足的纯函数（不依赖 React），抽出来放进 vm 里**真正执行**，
// 对行为断言；包裹不变式则用一段独立实现的词法扫描器对全文件断言。
//
// 反向自测：往全文件末尾注入一条故意未包裹的中文，断言扫描器能抓到——证明检查不是恒真。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 必须走 fileURLToPath：本仓库路径含中文，`URL.pathname` 是百分号编码的。
const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");

const START_MARKER = "// ── OPT-11：i18n 骨架";
const END_MARKER = "// ── 旧插件名 → 新插件名的 localStorage 键迁移";

let failures = 0;
const ok = (name, condition, extra = "") => {
	if (!condition) failures += 1;
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};

// ── 0. 抽出 i18n 骨架源码 ─────────────────────────────────────────────────────
const source = await readFile(CLIENT, "utf8");
const startAt = source.indexOf(START_MARKER);
const endAt = source.indexOf(END_MARKER, startAt + START_MARKER.length);
ok("能在 lib/client.js 里定位到 i18n 骨架一节的起止标记", startAt >= 0 && endAt > startAt, `start=${startAt} end=${endAt}`);
if (startAt < 0 || endAt <= startAt) {
	console.log("\nCLIENT-I18N FAIL（标记缺失，无法抽取待测源码）");
	process.exit(1);
}
const slice = source.slice(startAt, endAt);
ok("抽出的片段包含 i18nMessages / setI18nMessages / t", slice.includes("const i18nMessages") && slice.includes("const setI18nMessages") && slice.includes("const t = (s, vars)"));

// ── 1. 在隔开的 vm 里执行骨架，对行为断言 ────────────────────────────────────
const context = vm.createContext({ console });
const probeEpilogue = "\nglobalThis.__probe = { i18nMessages, setI18nMessages, t };";
vm.runInContext(slice + probeEpilogue, context, { filename: "client-i18n-slice.js" });
const { i18nMessages, setI18nMessages, t } = context.__probe;
ok("骨架能在 vm 里独立执行（不依赖 React 运行时）", typeof t === "function" && typeof setI18nMessages === "function");

// 1a. 空字典恒等：zh-CN 是源语言，缺键永远原样返回（不会让界面出现 key 名）。
ok("空字典时 t() 恒等返回原文", t("已召唤") === "已召唤");
ok("空字典时不做任何占位替换（无 vars 路径不碰 {n}）", t("{0} 个会话") === "{0} 个会话");

// 1b. 查表：命中即翻译。
setI18nMessages({ "已召唤": "Summoned" });
ok("命中字典返回译文", t("已召唤") === "Summoned");

// 1c. 插值：{n} 按 vars 下标替换，目标语可重排顺序。
setI18nMessages({
	"第 {0} / {1} 页 · 共 {2} 个技能": "Page {1} of {0} · {2} skills",
});
ok("插值按 vars 下标替换", t("第 {0} / {1} 页 · 共 {2} 个技能", [3, 7, 42]) === "Page 7 of 3 · 42 skills");
ok("无字典键 + 有 vars 也能插值（源语言直出带占位）", t("捆绑技能：{0}", ["a、b"]) === "捆绑技能：a、b");

// 1d. 边界：vars 缺位时占位符原样保留（`index in vars ? vars[+index] : raw`）。
ok("vars 缺位的占位符原样保留", t("{0}–{1} ms，最多 {2} 次", [500, 30000]) === "500–30000 ms，最多 {2} 次");
ok("vars 传空数组不替换", t("{0} 个", []) === "{0} 个");
ok("vars 传 undefined 不抛错", t("{0} 个") === "{0} 个");

// 1e. 健壮性：传 null 表不崩（防手滑）。这里直接读 i18nMessages 而不只是看 t()——
// 注释说「不清空已有表」，只有读真表才真的验证了「没被清空」而不是「碰巧还查得到」。
const keysBeforeNull = Object.keys(i18nMessages).length;
setI18nMessages(null);
ok("setI18nMessages(null) 不崩、不清空已有表", t("已召唤") === "Summoned");
ok("setI18nMessages(null) 后表条目数不变", keysBeforeNull > 0 && Object.keys(i18nMessages).length === keysBeforeNull);

// ── 2. 全文件包裹不变式：所有顶层含中文字面量都已包 t() ─────────────────────
// 独立实现的词法扫描器（与迁移脚本互为印证）：跳过注释/正则/模板插值体，抓顶层
// sq 字符串与模板静态段；MCP_CSS（以 body{ 开头的样式表）不在迁移范围。
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
// 匹配标记豁免：与后端人设正文逐字比对的常量不是展示文案，绝不能包 t()——
// en-US 表一旦翻译它们就永远匹配不上。显式列出（加新标记时同步）。
const MATCH_MARKERS = new Set(["## DSH 运行时适配（团队协作桥接）"]);
function scanWraps(text) {
	let i = 0;
	const n = text.length;
	let top = 0, wrapped = 0;
	const misses = [];
	const prevSignificant = (at) => {
		let p = at - 1;
		while (p >= 0 && /\s/.test(text[p])) p -= 1;
		return p >= 0 ? text[p] : "";
	};
	const isWrapped = (at) => {
		const prev = prevSignificant(at);
		return prev === "(" && at >= 2 && text[at - 2] === "t";
	};
	const miss = (at, inner) => misses.push({ line: text.slice(0, at).split("\n").length, text: String(inner).slice(0, 60) });
	while (i < n) {
		const c = text[i];
		if (c === "/" && text[i + 1] === "/") { while (i < n && text[i] !== "\n") i += 1; continue; }
		if (c === "/" && text[i + 1] === "*") {
			i += 2;
			while (i < n && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
			i = Math.min(i + 2, n);
			continue;
		}
		if (c === "/") { // 正则字面量 vs 除号的判定：前一有效字符决定。
			const prev = prevSignificant(i);
			if (prev === "" || "(,=:[!&|?{};+-*%~^<>".includes(prev)) {
				let j = i + 1, inClass = false, closed = false;
				while (j < n) {
					const d = text[j];
					if (d === "\\") { j += 2; continue; }
					if (d === "[") inClass = true;
					else if (d === "]") inClass = false;
					else if (d === "/" && !inClass) { closed = true; break; }
					else if (d === "\n") break;
					j += 1;
				}
				if (closed) { i = j + 1; while (i < n && /[gimsuyd]/.test(text[i])) i += 1; continue; }
			}
		}
		if (c === "'" || c === '"') {
			const q = c;
			let j = i + 1;
			while (j < n) {
				const d = text[j];
				if (d === "\\") { j += 2; continue; }
				if (d === q || d === "\n") break;
				j += 1;
			}
			const inner = text.slice(i + 1, Math.min(j, n - 1));
			if (q === "'" && CJK.test(inner) && !MATCH_MARKERS.has(inner)) {
				top += 1;
				if (isWrapped(i)) wrapped += 1; else miss(i, inner);
			}
			i = Math.min(j + 1, n);
			continue;
		}
		if (c === "`") { // 模板：只看静态段（跳过 ${...} 插值体，其中的表达式由 sq 分支覆盖）。
			let j = i + 1, depth = 0;
			while (j < n) {
				const d = text[j];
				if (d === "\\") { j += 2; continue; }
				if (depth === 0 && d === "`") break;
				if (d === "$" && text[j + 1] === "{") { depth += 1; j += 2; continue; }
				if (depth > 0 && d === "}") { depth -= 1; j += 1; continue; }
				j += 1;
			}
			const inner = text.slice(i + 1, Math.min(j, n - 1));
			if (CJK.test(inner) && !/^body\{/.test(inner)) {
				top += 1;
				if (isWrapped(i)) wrapped += 1; else miss(i, inner);
			}
			i = Math.min(j + 1, n);
			continue;
		}
		i += 1;
	}
	return { top, wrapped, misses };
}

const scan = scanWraps(source);
ok("全文件中文包裹不变式：所有顶层含中文字面量（除 CSS）都包了 t()",
	scan.misses.length === 0,
	`顶层=${scan.top} 已包裹=${scan.wrapped}${scan.misses.length ? ` 遗漏=${scan.misses.length} 首个=:${scan.misses[0].line}「${scan.misses[0].text.replace(/\n/g, "\\n")}」` : ""}`);
ok("不变式不是恒真：确实扫到了大量中文（若为 0 说明扫描器退化）", scan.top >= 500, `top=${scan.top}`);

// ── 3. 反向自测：注入一条故意未包裹的中文，扫描器必须抓到 ────────────────────
const MUTATION = "\nconst __i18n_mutation_probe = '注入未包裹中文';\n";
const mutated = scanWraps(source + MUTATION);
ok("自测：注入的未包裹中文被扫描器抓到（证明第 2 节不是恒真）",
	mutated.misses.length === scan.misses.length + 1 && mutated.misses.some((m) => m.text.includes("注入未包裹中文")),
	`遗漏=${mutated.misses.length - scan.misses.length}`);

// ── 4. 匹配标记一致性：client.js 内联常量必须与后端 expert-market.js 逐字相同 ──
// team 体检的分界线在两端各有一份（client 不能 import 相对路径模块），靠这条断言
// 在改名/改文案时两端同步，防止 stale 判定静默失配。
{
	const backend = await import(new URL("../lib/expert-market.js", import.meta.url).href);
	ok("client 侧 TEAM_BRIDGE_MARKER 与后端常量逐字一致",
		source.includes(`const TEAM_BRIDGE_MARKER = '${backend.TEAM_BRIDGE_MARKER}';`),
		`backend=${backend.TEAM_BRIDGE_MARKER}`);
	ok("后端 hasTeamBridge 语义可用（对自身 marker 判真）", backend.hasTeamBridge(backend.TEAM_BRIDGE_MARKER));
}

console.log(`\n${failures === 0 ? "CLIENT-I18N PASS" : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
