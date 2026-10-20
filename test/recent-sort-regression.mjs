// QA 独立回归：dsh-armory「最近使用」排序修复（listExpertRecent 漏 await）。
//
// 背景：召唤二级菜单（输入框右侧图标 → 技能/MCP/专家）应把「最近使用」的项排最上面并带
// 徽标，但此前从未生效。根因：lib/expert-market.js 的 listExpertRecent()（expert 分支里）
// `patch = (await import("node:fs/promises")).readFile(...)` 漏了 await——readFile 未等待，
// patch 恒为 Promise 对象 → 下游 readExpertPresets(Promise) 抛 TypeError: source is not a
// string → listExpertRecent 恒抛 → Host 侧 wbExpertRecent RPC 恒失败 → 客户端 kinds={}
// → 菜单永远按字母序渲染。而 recordExpertRecent（记录）不读 patch，所以使用记录一直正常。
//
// 工程师修复要点（本套件逐条钉住，防止回退）：
//   ① :793 改为 `patch = await readFile(join(homedir(), ".dsh", "profiles", "desktop",
//      "cordis.patch.yml"), "utf8");`（改用文件头 :30 已有的静态导入 readFile，删掉 dynamic
//      import 组合）；
//   ② readExpertPresets(patch) 的调用加独立 try/catch 兜底：patch 被改坏时回落 live=null
//      （全部展示），不炸整条链。
//
// 本文件是**只读验证**套件：静态源码针断言用 MARK 源码针 + sliceBetween 切片手法（参照
// test/bugfix-armory.mjs），动态项直接 import lib/expert-market.js 的 listExpertRecent 真
// 调用（只读，不写盘、不联网）。本机真实 ~/.dsh 环境存在 recent.json 与 cordis.patch.yml，
// 故动态项直接执行；若换环境跑不动，run-all.mjs 里该套件作为独立进程失败会被看见。
//
// 运行：node ./test/recent-sort-regression.mjs（同时也经 test/run-all.mjs 白名单随全量跑）
// 退出码：0 全过；1 有失败。

import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

// 必须走 fileURLToPath：本仓库路径含中文，URL.pathname 是百分号编码的。
const HERE = dirname(fileURLToPath(import.meta.url));
const EXPERT_MARKET = join(HERE, "..", "lib", "expert-market.js");

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

const source = await readFile(EXPERT_MARKET, "utf8");

// ═══════════════════════════════════════════════════════════════════════════
// 第 0 节 · 源码定位（标记缺失即整体失败，避免「测了个空」）
// ═══════════════════════════════════════════════════════════════════════════
section("0. 源码定位");
const MARK = {
	// listExpertRecent 整个函数体（从声明起到 return { kinds } 止）。
	fnStart: "export async function listExpertRecent() {",
	fnEnd: "  return { kinds };\n}",
	// 修复后的 patch 读取行（源码针，逐字符核对）。
	awaitReadFile: 'patch = await readFile(join(homedir(), ".dsh", "profiles", "desktop", "cordis.patch.yml"), "utf8");',
	// 兜底片段的起止（live 对账块）。
	liveStart: "      let live = null;",
	liveEnd: "      } catch {\n        live = null;\n      }",
};
const missing = Object.entries(MARK).filter(([, needle]) => !source.includes(needle)).map(([k]) => k);
ok("所有源码针都能在 lib/expert-market.js 里定位到", missing.length === 0, missing.length ? `缺失=${missing.join(",")}` : "");

// 抽取 helper：从起止标记之间取**源码原文**（含首尾标记），找不到就抛，绝不静默返回空串。
const sliceBetween = (startMark, endMark) => {
	const startAt = source.indexOf(startMark);
	if (startAt < 0) throw new Error(`找不到起始标记：${startMark}`);
	const endAt = source.indexOf(endMark, startAt + startMark.length);
	if (endAt <= startAt) throw new Error(`找不到结束标记：${endMark}`);
	return source.slice(startAt, endAt + endMark.length);
};

// listExpertRecent 的完整函数体切片（含修复的 await 行与 live 兜底块）。
const FN_SRC = sliceBetween(MARK.fnStart, MARK.fnEnd);

// ═══════════════════════════════════════════════════════════════════════════
// 第 1 节 · 修复不变式 a：await 已补 + dynamic import 组合已清除
// ═══════════════════════════════════════════════════════════════════════════
//
// 漏 await 的根因写法是 `patch = (await import("node:fs/promises")).readFile(...)`。
// 两条断言分别钉住「新写法在」与「旧写法不在」：只断言前者，旧写法回来时仍可能同时
// 保留新行（第二个赋值覆盖），所以必须双向钉。
section("1. 修复不变式：patch 读取必须 await，且旧 dynamic import 写法不得复活");
ok("1a 修复后写法在场：patch = await readFile(join(homedir(), ...", source.includes(MARK.awaitReadFile), `行内容="${MARK.awaitReadFile.slice(0, 40)}..."`);
ok("1b 旧 dynamic import 组合已清除：不再出现 await import(\"node:fs/promises\")", !source.includes('await import("node:fs/promises")'));
ok("1c await readFile 行位于 listExpertRecent 函数体内（不是别处误配）", FN_SRC.includes(MARK.awaitReadFile));
// 防「赋值有两处、后面那次又漏 await」：函数体内 patch = 开头的赋值行必须全部带 await。
const patchAssigns = FN_SRC.split("\n").filter((line) => line.includes("patch =") && !line.includes("patch ==="));
ok("1d 函数体内所有 `patch =` 赋值行都带 await（防止第二处赋值回退成漏 await）", patchAssigns.length >= 2 && patchAssigns.every((line) => /patch\s*=\s*await\b/.test(line) || /patch\s*=\s*null/.test(line) || /patch\s*=\s*$/.test(line)), `赋值行=${patchAssigns.length}`);

// ═══════════════════════════════════════════════════════════════════════════
// 第 2 节 · 兜底不变式 b：readExpertPresets(patch) 有独立 try/catch 保护
// ═══════════════════════════════════════════════════════════════════════════
//
// patch 被用户改坏（YAML 解析抛 TypeError）时必须回落 live=null（全部展示、不清记录），
// 而不是把异常抛出 listExpertRecent 炸掉整条「最近使用」链。用 sliceBetween 定位
// `let live = null;` 起、到该 try/catch 结束的片段，断言调用出现在 try { 与 } catch { 之间。
section("2. 兜底不变式：readExpertPresets(patch) 的 try/catch 保护");
const LIVE_SRC = sliceBetween(MARK.liveStart, MARK.liveEnd);
// 片段形如：
//   let live = null;
//   try {
//     live = patch ? new Set(readExpertPresets(patch).map(...)) : null;
//   } catch {
//     live = null;
//   }
const tryAt = LIVE_SRC.indexOf("try {");
const catchAt = LIVE_SRC.indexOf("} catch {");
const callAt = LIVE_SRC.indexOf("live = patch ? new Set(readExpertPresets(patch)");
ok("2a 兜底片段内 try { 与 } catch { 齐全且顺序正确", tryAt >= 0 && catchAt > tryAt, `try@${tryAt} catch@${catchAt}`);
ok("2b `live = patch ? new Set(readExpertPresets(patch)` 出现在 try { 与 } catch { 之间", callAt > tryAt && callAt < catchAt, `call@${callAt}`);
ok("2c catch 分支回落 live = null（不炸整条链）", LIVE_SRC.indexOf("live = null;", catchAt) >= 0);
ok("2d 函数体内 readExpertPresets 的所有调用都在 try 保护内", FN_SRC.split("\n").filter((line) => line.includes("readExpertPresets(patch)")).every((line) => LIVE_SRC.includes(line.trim())));

// ═══════════════════════════════════════════════════════════════════════════
// 第 3 节 · 排序语义不变式 d：预设摘除后的清理语义未被修复顺手改掉
// ═══════════════════════════════════════════════════════════════════════════
section("3. 排序语义不变式：live 对账后仍按 kinds[key] 过滤写回");
ok("3a 源码针在场：if (live && kinds[key].length !== list.length)", source.includes("if (live && kinds[key].length !== list.length)"));
ok("3b 过滤写回位于 listExpertRecent 函数体内（live 对账后才写）", FN_SRC.includes("if (live && kinds[key].length !== list.length)"));
ok("3c 过滤写回仍写 kinds[key]（而非清空 list）", FN_SRC.includes("data.kinds[key] = kinds[key];"));

// ═══════════════════════════════════════════════════════════════════════════
// 第 4 节 · 回归健壮性 c（动态）：真调 listExpertRecent，不炸、结构完整
// ═════════════════════════════════════════════════════不断言条数（环境相关会脆）。
// ═══════════════════════════════════════════════════════════════════════════
//
// 只读两项：~/.dsh/wb-market/experts/recent.json（使用记录）与
// ~/.dsh/profiles/desktop/cordis.patch.yml（召唤预设对账源）。两处都只读不写；
// recordExpertRecent 不在本套件调用（recordExpertRecent 会写盘）。
// 断言面：不抛异常 + 返回 { kinds: { skill: [], mcp: [], expert: [] } } 结构。
// 不断言条数：环境相关（其他机器可能没有 recent.json），断了会脆。
section("4. 动态回归：listExpertRecent 真调用不炸");
let recentExists = true;
try {
	await stat(join(process.env.USERPROFILE || "", ".dsh", "wb-market", "experts", "recent.json"));
} catch {
	recentExists = false;
}
if (!recentExists) {
	// 环境缺 recent.json 时跳过动态项：别的机器可能从未用过专家市场，动态项不适合
	// 硬断言；静态源码针（1-3 节）已足够钉住修复不变式。
	console.log("SKIP  4.x  环境缺 ~/.dsh/wb-market/experts/recent.json，动态项跳过（静态断言已覆盖修复不变式）");
} else {
	// Windows 陷阱：import() 只认 file:// URL。本仓库路径含中文 + 盘符（d:\...），
	// 直接传绝对路径会抛 ERR_UNSUPPORTED_ESM_URL_SCHEME，必须经 pathToFileURL 转换。
	const { listExpertRecent } = await import(pathToFileURL(EXPERT_MARKET).href);
	try {
		const result = await listExpertRecent();
		ok("4a listExpertRecent() 不抛异常（修复前恒抛 TypeError: source is not a string）", true);
		ok("4b 返回值含 kinds 且为对象", result && typeof result === "object" && result.kinds && typeof result.kinds === "object", `kinds=${Object.keys(result?.kinds || {}).join(",")}`);
		for (const key of ["skill", "mcp", "expert"]) {
			ok(`4c kinds.${key} 是数组`, Array.isArray(result?.kinds?.[key]), `len=${result?.kinds?.[key]?.length}`);
		}
	} catch (error) {
		// 走到这里说明真炸了：listExpertRecent 仍然抛——直接 FAIL，把异常摘要带出来。
		ok("4a listExpertRecent() 不抛异常（修复前恒抛 TypeError: source is not a string）", false, `${error && error.message}`);
		for (const key of ["skill", "mcp", "expert"]) {
			ok(`4c kinds.${key} 是数组`, false, "前置 4a 已失败，未拿到返回值");
		}
	}
}

console.log(`\n共 ${checks} 条断言：PASS ${checks - failures} / FAIL ${failures}`);
if (failures > 0) process.exitCode = 1;
