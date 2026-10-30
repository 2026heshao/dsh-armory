// 评审修复（2026-10-30）的客户端 / 接线护栏：这批改动防的是「用户点了才知道」的
// 交互与安全问题，只靠 happy path 用例拦不住回退，所以每条都配把旧写法注回去的
// 反向自测——断言若空转，反向用例必须变红。
//
// 覆盖：
//   H1 revealSkill 只信宿主注册表解析出的路径（客户端 payload.path 不参与定位）；
//   H2 社区仓库链接只渲染 https（client 侧 externalHref 与数据层 safeRepoUrl 双保险）；
//   M3 技能详情迟到回包不得覆盖已关闭 / 已切走的弹层（序号守卫 + 统一 closeSkillDetail）；
//   M4 重连必须看宿主 ok，不能把全失败显示成「已请求重连」；
//   M5 adopted（拿不到撤销句柄）要在挂 / 摘两条路上都提示「取消需重启」；
//   M6 替身人设（generated）不落粘性选择，并在详情 / 挂载提示里标注非原文；
//   Low 社区列表懒加载守卫必须比较「查询词」而不是真值。
//   J 「已加入」判定必须用不带冲突后缀的 baseServerName（用 serverName 恒为 false）。
//
// 零网络、零写盘，只读 lib/client.js 与 lib/index.js。
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const client = await readFile(join(here, "..", "lib", "client.js"), "utf8");
const index = await readFile(join(here, "..", "lib", "index.js"), "utf8");

let failed = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failed += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

function between(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = start >= 0 ? source.indexOf(endMarker, start + startMarker.length) : -1;
  const body = start >= 0 && end > start ? source.slice(start, end) : "";
  ok(`切片可定位：${label}`, body.length > 0, `len=${body.length}`);
  return body;
}

// ═══ H1 revealSkill：路径只来自宿主注册表 ═══════════════════════════════════
const reveal = between(index, "async revealSkill(payload) {", "// 卸载一条已安装 skill", "revealSkill");
ok("H1 revealSkill 要求 name", reveal.includes("const name = String(payload?.name || \"\").trim();") && reveal.includes("缺少 skill 名称"));
ok("H1 revealSkill 经 registry.get(name, options) 解析", /registry\.get\(name,\s*options\)/.test(reveal));
ok("H1 revealSkill 不再用 payload.path 作为定位结果",
  !/const path = String\(payload\?\.path/.test(reveal) && !/payload\?\.path \|\|/.test(reveal));
ok("H1 revealSkill 拒绝空路径 / NUL / 非绝对路径", /path\.includes\("\\0"\)/.test(reveal) && /isAbsolute\(path\)/.test(reveal));
const legacyReveal = reveal.replace(
  "const name = String(payload?.name || \"\").trim();",
  "const path = String(payload?.path || \"\").trim();",
);
ok("H1 反向：注回 payload.path 旧写法后「不再用 payload.path 定位」必须判红",
  !/const path = String\(payload\?\.path/.test(reveal) && /const path = String\(payload\?\.path/.test(legacyReveal));
const clientReveal = between(client, "onClick: () => { call('revealSkill'", "},\n", "技能「打开目录」调用");
ok("H1 客户端同时传 name 与 scope（宿主才能按注册表定位）",
  /name: summary\.name/.test(clientReveal) && /skillScopeArg\(scope\)/.test(clientReveal));

// ═══ H2 externalHref：只放 https，且 URL 可解析 ═════════════════════════════
const externalSrc = between(client, "const externalHref = (value) => {", "// 详情回包只覆盖", "externalHref")
  .trim()
  .replace(/^const externalHref = /, "")
  .replace(/;$/, "");
const externalHref = new Function("URL", `return (${externalSrc})`)(URL);
ok("H2 https 链接保留（并规范化）", externalHref("https://github.com/o/r") === "https://github.com/o/r");
ok("H2 http 丢弃", externalHref("http://github.com/o/r") === "");
ok("H2 javascript: 丢弃", externalHref("javascript:alert(1)") === "");
ok("H2 file: 丢弃", externalHref("file:///C:/Windows/System32/calc.exe") === "");
ok("H2 data: 丢弃", externalHref("data:text/html,x") === "");
ok("H2 空值 / 畸形丢弃", externalHref("") === "" && externalHref("https://") === "");
const unsafeHref = (value) => String(value || "").trim();
ok("H2 反向：不做校验的旧写法会放行 javascript:", unsafeHref("javascript:alert(1)") !== "" && externalHref("javascript:alert(1)") === "");
ok("H2 列表与详情都经 externalHref 渲染仓库链接",
  /const repoHref = externalHref\(row\.repoUrl\)/.test(client)
  && /externalHref\(communityDetail\.repoUrl\)/.test(client));
const legacyRepo = client.replace("const repoHref = externalHref(row.repoUrl);", "const repoHref = row.repoUrl;");
ok("H2 反向：绕过 externalHref 后列表断言必须判红",
  /const repoHref = externalHref\(row\.repoUrl\)/.test(client) && !/const repoHref = externalHref\(row\.repoUrl\)/.test(legacyRepo));

// ═══ M3 技能详情：迟到回包不覆盖新状态 ══════════════════════════════════════
const openDetail = between(client, "const openSkillDetail = async (skill) => {", "// 插件安装走宿主的", "openSkillDetail");
const closeDetail = between(client, "const closeSkillDetail = () => {", "};", "closeSkillDetail");
ok("M3 openSkillDetail 在 await 前取序号", /const seq = \+\+skillDetailSeq\.current;/.test(openDetail));
ok("M3 成功与失败回包都先比序号", (openDetail.match(/if \(seq !== skillDetailSeq\.current\) return;/g) || []).length === 2);
ok("M3 closeSkillDetail 递增序号", /skillDetailSeq\.current \+= 1;/.test(closeDetail));
ok("M3 所有关闭路径统一走 closeSkillDetail（唯一的 setSkillDetail(null) 就在它内部）",
  (client.match(/setSkillDetail\(null\)/g) || []).length === 1
  && /const closeSkillDetail = \(\) => \{[\s\S]{0,120}setSkillDetail\(null\);/.test(client)
  && (client.match(/closeSkillDetail\(\)/g) || []).length >= 4);
const noGuard = openDetail.replace(/if \(seq !== skillDetailSeq\.current\) return;/g, "");
ok("M3 反向：删掉序号守卫后断言必须判红",
  (noGuard.match(/if \(seq !== skillDetailSeq\.current\) return;/g) || []).length === 0);

// ═══ M4 重连：宿主失败不能显示成功 ══════════════════════════════════════════
const reconnect = between(client, "const reconnectConnector = async (item) => {", "// ── R8：连接器 OAuth 授权", "reconnectConnector");
ok("M4 逐条检查 res.ok === false", /if \(res && res\.ok === false\) \{/.test(reconnect)
  && /failed\.push\(name \+ ': ' \+ \(res\.error \|\| t\('调用失败'\)\)\);/.test(reconnect));
ok("M4 有失败时走 setError，不再落到成功提示",
  /if \(failed\.length\) setError\(t\('\{0\}：\{1\}', \[item\.name, failed\.join\('; '\)\]\)\);/.test(reconnect)
  && /else setNote\(/.test(reconnect));
const noOkCheck = reconnect.replace("if (res && res.ok === false) {", "if (false) {");
ok("M4 反向：去掉 ok 判定后断言必须判红",
  /if \(res && res\.ok === false\) \{/.test(reconnect) && !/if \(res && res\.ok === false\) \{/.test(noOkCheck));

// ═══ M5 / M6 专家挂载提示：adopted 与替身都要如实说明 ═══════════════════════
const attach = between(client, "const attachExpert = async (item, { quiet = false } = {}) => {", "const detachExpert = async () => {", "attachExpert");
const detach = between(client, "const detachExpert = async () => {", "// 会话切换 / 组件重挂时对齐真实状态", "detachExpert");
ok("M5 挂载成功先判 needsRestart（优先于替身提示）",
  /res\.needsRestart\s*\n?\s*\? t\('人设已生效，但该会话残留旧注册，取消需重启 DSH 后生效。'\)/.test(attach));
ok("M5 取消也判 needsRestart，不谎报「已取消」",
  /res\?\.needsRestart\s*\n?\s*\? t\('人设已生效，但该会话残留旧注册，取消需重启 DSH 后生效。'\)/.test(detach));
ok("M6 挂载成功时提示替身不是原文", /res\.personaSource === 'generated' \? t\('人设正文是按专家介绍生成的替身，不是原作者设定；原文不可用。'\)/.test(attach));
const noRestartNote = attach.replace(/res\.needsRestart\s*\n?\s*\?/, "false ?");
ok("M5 反向：去掉 needsRestart 分支后断言必须判红",
  /res\.needsRestart\s*\n?\s*\? t\('人设已生效/.test(attach) && !/res\.needsRestart\s*\n?\s*\? t\('人设已生效/.test(noRestartNote));

ok("M6 宿主：替身人设不写粘性选择", /persist:\s*detail\.personaSource !== "generated"/.test(index));
ok("M6 宿主：把 personaSource 交回客户端", /personaSource:\s*detail\.personaSource/.test(index));
ok("M6 详情页两处都标注替身来源", (client.match(/detail\.personaSource === 'generated'/g) || []).length >= 2);
const persistAlways = index.replace(/persist:\s*detail\.personaSource !== "generated"/, "persist: true");
ok("M6 反向：改回无条件落盘后断言必须判红",
  /persist:\s*detail\.personaSource !== "generated"/.test(index) && !/persist:\s*detail\.personaSource !== "generated"/.test(persistAlways));

// ═══ Low 社区懒加载：守卫必须比较查询词 ═════════════════════════════════════
ok("Low 懒加载守卫比较 communityQuery（不是恒真）",
  /if \(communityLoadedQueryRef\.current === communityQuery\) return;/.test(client));
const truthyGuard = client.replace(
  "if (communityLoadedQueryRef.current === communityQuery) return;",
  "if (communityLoadedQueryRef.current) return;",
);
ok("Low 反向：改回真值守卫后断言必须判红",
  !/if \(communityLoadedQueryRef\.current === communityQuery\) return;/.test(truthyGuard));

// ═══ J communityJoined：拿带后缀的预填名比已装名 = 「已加入」永远点不亮 ═══════
// 真跑判定函数本体（不只是搜字符串）：把 client.js 里的 arrow 取出来 new Function 执行，
// 装上 adeu 之后列表里这条会预填成 adeu-2，旧写法拿 adeu-2 去比已装名恒为 false。
{
  const raw = between(client, "const communityJoined = (row) => {", "\n  };\n", "communityJoined");
  const arrow = `(row) => {${raw.slice(raw.indexOf("{") + 1)}}`;
  const make = (rows) => vm.runInNewContext(`(${arrow})`, { mcpServerRows: rows });
  const joined = make([{ serverName: "adeu" }, { serverName: "windows" }]);
  ok("J 已装过 adeu → 已加入（后缀名不影响判定）",
    joined({ serverName: "adeu-2", baseServerName: "adeu" }) === true);
  ok("J 没装过 → 未加入", joined({ serverName: "figma", baseServerName: "figma" }) === false);
  ok("J 空已装列表 → 未加入", make([])({ serverName: "adeu", baseServerName: "adeu" }) === false);
  ok("J 行缺 baseServerName（旧缓存形状）时回落预填名，不抛错",
    joined({ serverName: "windows" }) === true && joined({}) === false);
  ok("J 已装行缺 serverName 不抛错", make([{}])({ serverName: "adeu", baseServerName: "adeu" }) === false);
  // 反向自测：旧的一行判定（只比 serverName），第一条必须判红。
  const legacy = vm.runInNewContext(
    "(row) => mcpServerRows.some((server) => String(server?.serverName || '') === row.serverName)",
    { mcpServerRows: [{ serverName: "adeu" }] },
  );
  ok("J 反向：旧写法在「已装 adeu + 预填 adeu-2」下判成未加入（这正是 bug）",
    legacy({ serverName: "adeu-2", baseServerName: "adeu" }) === false);
  // 判据字段必须由数据层给出，客户端不能自己再净化一遍（两处规则会漂移）。
  ok("J baseServerName 来自数据层 mapRegistryServer", /baseServerName: sanitizeServerName\(name, \[\]\)/.test(
    await readFile(join(here, "..", "lib", "mcp-community.js"), "utf8")));
}

console.log(`\n${failed === 0 ? "CLIENT-GUARDS PASS" : `CLIENT-GUARDS FAIL（${failed} 项）`}`);
process.exitCode = failed === 0 ? 0 : 1;
