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
//   L 授权页打不开时必须把宿主的内部代码翻成人话，且按钮不能再丢掉回包。
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
ok("M5 挂载成功先判 adopted（优先于替身提示）",
  /res\.needsRestart === true \|\| res\.applied === false/.test(attach)
  && /新专家已记录，但当前会话仍沿用旧注册的人设，需重启 DSH 后生效。/.test(attach));
ok("M5 取消也判 needsRestart，不谎报「已取消」",
  /if \(res\?\.needsRestart\) \{[\s\S]{0,240}?取消已记录；当前会话残留的旧人设需重启 DSH 后才能彻底取消。/.test(detach));
ok("M6 挂载成功时提示替身不是原文", /res\.personaSource === 'generated' \? t\('人设正文是按专家介绍生成的替身，不是原作者设定；原文不可用。'\)/.test(attach));
const noRestartNote = attach.replace("const adopted = res.needsRestart === true || res.applied === false;", "const adopted = false;");
ok("M5 反向：去掉 adopted 分支后断言必须判红",
  /const adopted = res\.needsRestart === true \|\| res\.applied === false;[\s\S]{0,500}?新专家已记录/.test(attach)
  && !/const adopted = res\.needsRestart === true[\s\S]{0,500}?新专家已记录/.test(noRestartNote));
ok("M7 取消失败时保留 chip，不乱报「本会话没有挂着专家」",
  /else if \(res && res\.ok\)/.test(detach)
  && /setAttachNote\(t\('取消失败：'\)/.test(detach));

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

// ═══ K 存量裸 npx 必须有可执行的出口；「需授权」不能标在没有授权入口的行上 ═══
// 归一只在写入边界做，所以升级插件之前加下的裸 npx 条目一直保持坏形态。以前面板对它们
// 只会说「连接失败」+（连接器卡上）「点重连再试」，而重连不改变命令 —— 用户就在
// 「重连—还是失败」里循环，这正是「装上要先修但没人说修什么」的现场。
// 另一半：AUTH_FAILURE_RE 不看 transport，stdio 只要 stderr 里出现过 token/OAuth 就被标
// 「需授权」，而本插件的授权通路是 HTTP 专属的（resolveOAuthTarget 需要 url），
// 等于把「进程起不来」重新解释成一个不存在的修复动作。
{
  const client = await readFile(join(here, "..", "lib", "client.js"), "utf8");
  const indexSrc = await readFile(join(here, "..", "lib", "index.js"), "utf8");
  const stdioSrc = await readFile(join(here, "..", "lib", "win32-stdio.js"), "utf8");

  ok("K 判据是纯函数、平台可注入（POSIX 上永不标）",
    /export function isBlockedLaunchShape\(row, options = \{\}\)/.test(stdioSrc)
    && /options\.platform \?\? process\.platform/.test(stdioSrc)
    && /!== 'win32'\) return false/.test(stdioSrc));
  ok("K 全局行与项目行都打 launchBlocked（同一函数，不各写一套）",
    (indexSrc.match(/row\.launchBlocked = isBlockedLaunchShape\(row\);/g) || []).length === 2
    && /import \{ isBlockedLaunchShape \} from "\.\/win32-stdio\.js"/.test(indexSrc));
  ok("K 徽标优先级：命令形态 > 需授权 > 连接失败",
    /s\.launchBlocked \? t\('命令形态需修复'\) : s\.authRequired \? t\('需授权'\) : t\('连接失败'\)/.test(client));
  ok("K 文案给的是真出口（重连没用、要重新保存本条）",
    /重连不会改变命令/.test(client) && /点保存（或删除后重新添加）/.test(client));
  ok("K 项目行副文案同源优先（wsSub 在 status 分支之前判 launchBlocked）",
    (() => {
      const start = client.indexOf("const wsSub = (s) => {");
      const body = client.slice(start, start + 700);
      return body.includes("if (s.status === 'failed' && s.launchBlocked === true) return t('命令形态需修复');")
        && body.indexOf("s.launchBlocked") < body.indexOf("s.status === 'disabled'");
    })());
  ok("K authRequired 只对 HTTP 传输（两条行投影都限定）",
    (indexSrc.match(/transport === "http"[\s\S]{0,60}AUTH_FAILURE_RE/g) || []).length === 2);
  ok("K 新增中文串都有 en-US 词条（英文界面不说中文）",
    // 长 tooltip 的键整句很长，这里按「键名前缀 + 紧跟引号」判，避免把整句抄第二遍。
    ["命令形态需修复", "这条命令是 npm 的 .cmd 壳", "只能按名字尾段判定", "已有同名条目，确认后会自动换个名字再加一条"]
      .every((key) => client.includes(`"${key}`)));

  // 反向自测：把徽标退回旧写法（只看 authRequired），上面两条 K 断言必须变红。
  const legacyBadge = client.replace(
    "s.launchBlocked ? t('命令形态需修复') : s.authRequired ? t('需授权') : t('连接失败')",
    "s.authRequired ? t('需授权') : t('连接失败')",
  );
  ok("K 反向：旧徽标写法确实会被优先级断言抓住",
    legacyBadge !== client
    && !/s\.launchBlocked \? t\('命令形态需修复'\) : s\.authRequired/.test(legacyBadge));
  // 反向自测：撤掉 transport 限定，K 的 authRequired 断言必须变红。
  const legacyAuth = indexSrc.replace('row.status === "failed" && transport === "http"', 'row.status === "failed" && true');
  ok("K 反向：撤掉传输限定会被 authRequired 断言抓住",
    legacyAuth !== indexSrc
    && (legacyAuth.match(/transport === "http"[\s\S]{0,60}AUTH_FAILURE_RE/g) || []).length === 1);
}

// ═══ L 授权页「打不开」必须说清为什么、下一步怎么办 ══════════════════════════
// 宿主 openExternalUrl 回的是内部代码（blocked-url / system-opener-unavailable /
// empty-url），旧写法要么把整段结果丢掉（点「重新打开浏览器」界面毫无变化），要么
// 只会重复那句通用提示。用户在弹层里等一个永远不会出现的浏览器窗口，正是「装上要先修
// 但没人说修什么」的另一现场。
{
  const tStub = (text, vars) => String(text).replace(/\{(\d+)\}/g, (m, i) => (vars && i < vars.length ? vars[i] : m));
  const note = vm.runInNewContext(`(() => {\n${between(client, "function openFailureNote(reason) {", "\n}", "openFailureNote")}\n}\nreturn openFailureNote;\n})()`, { t: tStub });
  ok("L blocked-url 翻成「协议不被允许 + 手动打开」",
    note("blocked-url").includes("只支持 https") && note("blocked-url").includes("手动打开"));
  ok("L 本机无打开器时说「没有可用的浏览器打开器」", note("system-opener-unavailable").includes("浏览器打开器"));
  ok("L 空链接让人重新发起授权", note("empty-url").includes("重新发起授权"));
  ok("L 未知原因原样带出（至少是真话），并保留手动打开指引",
    note("ECONNREFUSED").includes("ECONNREFUSED") && note("ECONNREFUSED").includes("复制下方链接"));
  ok("L 没有原因时回落到通用提示（不出现「（）」空括号）",
    note("") === "没能自动唤起浏览器，请复制下方链接手动打开。" && note(undefined) === note(""));
  // 反向自测：全部退化成那一句通用提示时，前三条必须变红。
  const generic = () => "没能自动唤起浏览器，请复制下方链接手动打开。";
  ok("L 反向：通用提示写法区分不了三种失败（上面的断言确实会红）",
    generic("blocked-url") === generic("empty-url") && generic("blocked-url") !== note("blocked-url"));
  // 接线：按钮必须消费回包（旧 onClick 直接丢弃），且首次自动失败也要带上原因。
  ok("L 按钮点击后按回包给反馈", /call\('wbOAuthOpen', \{ url: authDialog\.authorizeUrl \}\)\s*\n\s*\.then\(\(openRes\) => setAuthDialog/.test(client));
  ok("L 首次自动打开失败也带上原因（不是无脑通用句）", /error: res\.opened \? '' : openFailureNote\(res\.openVia\)/.test(client));
  // 反向自测：把按钮退回旧的「回包整个丢掉」写法，上一条接线针必须变红。
  const legacyButton = client.replace(
    /call\('wbOAuthOpen', \{ url: authDialog\.authorizeUrl \}\)[\s\S]{0,700}?: current\)\)\);/,
    "call('wbOAuthOpen', { url: authDialog.authorizeUrl });",
  );
  ok("L 反向：旧「结果丢掉」的按钮写法会被接线针抓住",
    legacyButton !== client
    && !/call\('wbOAuthOpen', \{ url: authDialog\.authorizeUrl \}\)\s*\n\s*\.then\(\(openRes\) => setAuthDialog/.test(legacyButton));
}

console.log(`\n${failed === 0 ? "CLIENT-GUARDS PASS" : `CLIENT-GUARDS FAIL（${failed} 项）`}`);
process.exitCode = failed === 0 ? 0 : 1;
