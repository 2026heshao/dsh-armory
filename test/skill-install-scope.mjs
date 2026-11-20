// 技能市场安装作用域（issue #27）：市场安装此前只能落 ~/.agents/skills，项目隔离只能
// 靠手动拷目录。修复后 payload.cwd（已注册工作区，RPC 层白名单校验）把安装/卸载/已装
// 扫描都按作用域走。钉住三件事：
//   1. 服务端：install / uninstall / installed 三口都认 cwd，installed 行自带 scope 且
//      同一根去重；
//   2. 宿主：cwd 白名单（非注册工作区拒绝写入/删除），项目作用域安装跳过全局注册表
//      核对（list({}) 不扫项目根，硬核对必然假报「未收录」）；
//   3. 客户端：点「安装」先弹「选择安装位置」（全局 / 项目）→ 安装带所选 cwd、卸载带
//      实际安装作用域 cwd、已装键带作用域前缀；市场页无作用域标签行（skillws 只归看板）。
// 静态针零网络；服务端行为针真跑（fetch 全替身 + mkdtemp 隔离，绝不碰真实 ~/.agents）。
// 用法：node ./test/skill-install-scope.mjs
import { mkdir, mkdtemp, readFile, rm as rmDir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const wbMarket = await readFile(join(here, "..", "lib", "wb-market.js"), "utf8");
const indexSrc = await readFile(join(here, "..", "lib", "index.js"), "utf8");
const typert = await readFile(join(here, "..", "lib", "typert.js"), "utf8");
const client = await readFile(join(here, "..", "lib", "client.js"), "utf8");

let failed = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failed += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

// ── 1. 服务端：三口都认 cwd ──────────────────────────────────────────────
ok("服务端：wbSkillInstall cwd 分支（<cwd>/.agents/skills）",
  /const root = skillsRoot \|\| \(cwd \? join\(cwd, "\.agents", "skills"\) : join\(homedir\(\), "\.agents", "skills"\)\);/.test(wbMarket));
ok("服务端：wbSkillUninstall 同套作用域语义（只删该作用域的安装）",
  /const root = cwd \? join\(cwd, "\.agents", "skills"\) : join\(homedir\(\), "\.agents", "skills"\);/.test(wbMarket));
ok("服务端：wbSkillInstalled 接受 cwds 并按根去重",
  /Array\.isArray\(payload\?\.cwds\)/.test(wbMarket) && /roots\.some\(\(entry\) => entry\.root === root\)/.test(wbMarket));
ok("服务端：installed 行自带 scope（'global' 或工作区路径）",
  /const roots = \[\{ scope: "global", root: join\(homedir\(\), "\.agents", "skills"\) \}\];/.test(wbMarket)
  && /rows\.push\(\{[\s\S]{0,200}scope,\n/.test(wbMarket));
// 卸载报错文案要如实说出「可能装在另一个作用域」：项目装的技能在全局口径下卸载，
// 旧文案「可能已卸载或由其它工具安装」会让人白找。
ok("服务端：卸载未命中提示包含另一作用域的可能",
  /本机没有这个市场技能的安装记录（可能已卸载、装在另一个作用域，或由其它工具安装）/.test(wbMarket));

// ── 2. 宿主：cwd 白名单 + 项目作用域跳过注册表核对 ────────────────────────
ok("宿主：wbSkillInstall 校验 cwd 必须是已注册工作区",
  /cwd 不是已注册的工作区，拒绝安装到该路径/.test(indexSrc) && /listWorkspaceRecords\(this\.ctx\)/.test(indexSrc));
ok("宿主：wbSkillUninstall 同套白名单（拒绝任意目录删除）",
  /cwd 不是已注册的工作区，拒绝删除该路径下的技能/.test(indexSrc));
ok("宿主：wbSkillInstalled 对 cwds 再过滤一遍注册表（不外泄目录枚举）",
  /request\.cwds = request\.cwds\.map\(\(value\) => String\(value \|\| ""\)\.trim\(\)\)\.filter\(\(value\) => registered\.has\(value\)\)/.test(indexSrc));
ok("宿主：项目作用域安装跳过全局注册表核对（list({}) 不扫项目根，硬核对必然假报）",
  /registry\.list === "function" && result\?\.name && !cwd/.test(indexSrc));

// ── 3. 客户端：作用域状态与接线 ──────────────────────────────────────────
ok("客户端：市场技能页不再有作用域标签行（安装走弹层，skillws 只归看板）",
  !/tab === 'skill' && skillScopeTabs\.length > 1/.test(client)
  && !client.includes("switchSkillScope")
  && !client.includes("setSkillScope"));
ok("客户端：工作区列表失败保持未知，不回退、不动 hash（与看板同一口径）",
  /if \(res && res\.ok && Array\.isArray\(res\.workspaces\)\) \{[\s\S]{0,120}setWorkspacesLoaded\(true\);/.test(client));
ok("客户端：已装行键带作用域前缀（同技能可同时存在于两个作用域）",
  /const skillInstalledKey = \(row\) => \(row\.scope && row\.scope !== 'global' \? row\.scope \+ '\|' : ''\) \+ row\.namespace \+ '\/' \+ row\.slug;/.test(client));
ok("客户端：Skill 看板的作用域回退保留（skillws 失效 → 全局，hash + skillpick 一起清）",
  /if \(workspaces\.some\(\(ws\) => ws\.path === scope\)\) return;[\s\S]{0,120}writeHashParams\(\{ skillws: null, skillpick: '' \}\);[\s\S]{0,60}setScope\('global'\);/.test(client));
ok("客户端：看板切作用域先清旧列表 + 空态给读取占位（防误读「不同项目 skill 一样」）",
  /setSkills\(\[\]\);[\s\S]{0,80}setSelected\(''\);[\s\S]{0,200}load\(false\);/.test(client)
  && /t\('正在读取 \{0\} 的 skill…', \[scopeName\]\)/.test(client)
  && /"正在读取 \{0\} 的 skill…": "/.test(client));
ok("客户端：切作用域 load 防抖 + effect 重跑清定时器（连点标签不叠加宿主扫描）",
  /const debounce = setTimeout\(\(\) => load\(false\), 220\);/.test(client)
  && /return \(\) => clearTimeout\(debounce\);/.test(client));
ok("客户端：套件 / 收藏读取与作用域解耦（只首挂读一次，不随切标签重发）",
  /useEffect\(\(\) => \{\s*loadSuites\(\);\s*loadFavorites\(\);\s*\}, \[loadSuites, loadFavorites\]\);/.test(client));
ok("客户端：skillInstallInfo 防抖 250ms + 依赖与 skills 解耦（重扫描不随连点/列表更新叠加）",
  /const debounce = setTimeout\(\(\) => \{\s*call\('skillInstallInfo', skillScopeArg\(scope\)\)/.test(client)
  && /return \(\) => \{ alive = false; clearTimeout\(debounce\); \};/.test(client)
  && /\}, \[scope, installInfoTick, call\]\);/.test(client)
  && !/\}, \[skills, scope, call\]\);/.test(client));
ok("客户端：市场卡片 / 详情 / 本页筛选按 installedEntryFor 判已装（任意作用域，多份并存优先全局份）",
  /const installedEntryFor = \(skill\) => \{/.test(client)
  && client.includes("installedEntryFor(skill)")
  && client.includes("detailInstalledEntry"));
ok("客户端：卸载跟着实际安装作用域走（installedEntryFor 的 scope 作 cwd）",
  /const entry = installedEntryFor\(skill\);/.test(client)
  && /\.\.\.\(entry\.scope === 'global' \? \{\} : \{ cwd: entry\.scope \}\)/.test(client));
ok("客户端：已装扫描把工作区交给宿主（cwds），列表未到先只扫全局",
  /const cwds = workspacesRef\.current\.map\(\(ws\) => ws\.path\)\.filter\(Boolean\);/.test(client)
  && /call\('wbSkillInstalled', cwds\.length \? \{ cwds \} : \{\}\)/.test(client));
ok("客户端：宿主拒收 1 参（老 typert/未重启）时退回全局口径，不糊红错误",
  /if \(!cwds\.length\) throw e;[\s\S]{0,60}res = await call\('wbSkillInstalled'\);/.test(client));
ok("客户端：scope 字段缺失时按 dir 前缀反推（防结果编码器剥新字段）",
  /const scope = row\.scope \|\| cwds\.find\(\(p\) => dir\.startsWith\(p \+ '\\\\'\) \|\| dir\.startsWith\(p \+ '\/'\)\) \|\| 'global';/.test(client));
ok("客户端：工作区就绪后补读一次已装集合",
  /if \(workspacesLoaded\) loadInstalled\(\);/.test(client));
ok("客户端：安装带所选作用域 cwd、卸载带实际安装作用域 cwd（全局都不带）",
  (client.match(/\.\.\.\(scope === 'global' \? \{\} : \{ cwd: scope \}\)/g) || []).length === 1
  && (client.match(/\.\.\.\(entry\.scope === 'global' \? \{\} : \{ cwd: entry\.scope \}\)/g) || []).length === 1);
ok("typert：wbSkillInstalled 声明收 payload（0 参声明会让宿主拒收）",
  /mv\('wbSkillInstalled', \[payloadParam\], 'WbInstalledResult'\)/.test(typert));
ok("client 契约数组：wbSkillInstalled 带 payload 参数",
  /method: 'wbSkillInstalled', invocation: \{ kind: 'direct' \}, parameters: \[mcpParam\('payload', 'ImportPayload'\)\]/.test(client));
ok("客户端：点「安装」先弹位置选择弹层（requestSkillInstall，卡片与详情两处入口）",
  /const requestSkillInstall = \(skill\) => setSkillInstallChooser\(skill\);/.test(client)
  && (client.match(/onClick: \(\) => requestSkillInstall\(/g) || []).length === 2);
ok("客户端：选择弹层列出全局与全部工作区（skillScopeTabs），选中即按该作用域安装",
  /skillScopeTabs\.map\(\(option\) => h\('button'/.test(client)
  && /installSkill\(target, option\.key\)/.test(client));
ok("客户端：详情弹层说明「点安装后选位置」（双语词条在场）",
  /t\('点「安装」后选择安装位置：全局写入 ~\/\.agents\/skills\/（所有项目可用），项目写入该项目 \.agents\/skills\/（只对该项目生效）。即刻被 DSH 发现，无需重启。'\)/.test(client)
  && /"点「安装」后选择安装位置：全局写入 ~\/\.agents\/skills\/（所有项目可用），项目写入该项目 \.agents\/skills\/（只对该项目生效）。即刻被 DSH 发现，无需重启。": "/.test(client));
ok("客户端：旧「作用域下拉框」已移除（不再有 detailScope / scope-pick 残留）",
  !client.includes("detailScope") && !client.includes("dsh-mcp-scope-pick"));
// 反向自测：installedEntryFor 的前缀匹配一旦去掉，「装在项目里」的行就查不到了——
// 证明上面的断言真的在钉前缀匹配，不是匹配任何函数。
{
  const withoutSuffix = client.replace(
    "if (key === base || key.endsWith('|' + base)) {",
    "if (key === base) {",
  );
  ok("自测：installedEntryFor 去掉作用域前缀匹配会被断言抓到",
    withoutSuffix !== client
      && !/key\.endsWith\('\|' \+ base\)/.test(withoutSuffix));
}

// ── 4. 服务端真跑：fetch 替身 + mkdtemp，cwd 安装/卸载/已装扫描全链路 ────────
const home = await mkdtemp(join(tmpdir(), "armory-scope-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.DSH_ARMORY_HOME = join(home, "armory-home");
await mkdir(process.env.DSH_ARMORY_HOME, { recursive: true });
const { wbSkillInstall, wbSkillInstalled, wbSkillUninstall } = await import(new URL("../lib/wb-market.js", import.meta.url).href);

const wsRoot = join(home, "workspace-a");
const realFetch = globalThis.fetch;
const skillBody = Buffer.from("---\nname: proj-demo\ndescription: issue #27 scope test skill\n---\nbody");
globalThis.fetch = async (url) => {
  const u = String(url);
  const response = (body) => ({
    ok: true, status: 200,
    arrayBuffer: async () => (typeof body === "string" ? Buffer.from(body) : body),
    json: async () => JSON.parse(body),
  });
  if (u.includes("/files?")) {
    return response(JSON.stringify({
      version: "1.0.0",
      files: [{ path: "SKILL.md", size: skillBody.length, sha256: createHash("sha256").update(skillBody).digest("hex") }],
    }));
  }
  if (u.includes("/file?")) return response(skillBody);
  throw new Error("替身 fetch 收到意外 URL：" + u);
};

try {
  // 安装带 cwd：必须落在 <wsRoot>/.agents/skills，而不是用户全局根。
  const result = await wbSkillInstall({ namespace: "acme", slug: "proj-demo", name: "proj-demo", cwd: wsRoot });
  ok("真跑：cwd 安装落盘到 <cwd>/.agents/skills",
    result.dir === join(wsRoot, ".agents", "skills", "acme__proj-demo"),
    `dir=${result.dir}`);
  ok("真跑：note 写明真实落盘路径", result.note.includes(join(wsRoot, ".agents", "skills")));
  const manifest = await readFile(join(result.dir, "SKILL.md"), "utf8");
  ok("真跑：落盘文件内容完整（sha256 通过才会写）", manifest.includes("name: proj-demo"));

  // 已装扫描：全局 + 工作区各归各组，行带 scope；重复 cwd 去重；不存在的 cwd 不炸。
  const globalDir = join(home, ".agents", "skills", "acme__global-demo");
  await mkdir(globalDir, { recursive: true });
  await writeFile(join(globalDir, "SKILL.md"), "---\nname: global-demo\n---\nbody");
  const scan = await wbSkillInstalled({ cwds: [wsRoot, wsRoot, join(home, "no-such-ws")] });
  const projRow = scan.installed.find((row) => row.dirName === "acme__proj-demo");
  const globalRow = scan.installed.find((row) => row.dirName === "acme__global-demo");
  ok("真跑：项目行 scope = 工作区路径", !!projRow && projRow.scope === wsRoot, `scope=${projRow?.scope}`);
  ok("真跑：全局行 scope = 'global'", !!globalRow && globalRow.scope === "global");
  ok("真跑：重复 cwd 去重（同名目录只出一行）",
    scan.installed.filter((row) => row.dirName === "acme__proj-demo").length === 1);
  ok("真跑：不存在的 cwd 静默跳过不报错", scan.installed.every((row) => row.scope !== join(home, "no-such-ws")));

  // 卸载按作用域走：cwd 口径删项目目录；全局口径删不到项目里的安装（不能越界）。
  await wbSkillUninstall({ namespace: "acme", slug: "proj-demo", cwd: wsRoot });
  let projGone = false;
  try { await readFile(join(result.dir, "SKILL.md")); } catch { projGone = true; }
  ok("真跑：cwd 卸载删掉项目目录", projGone);
  await mkdir(join(wsRoot, ".agents", "skills", "acme__proj-demo"), { recursive: true });
  await writeFile(join(wsRoot, ".agents", "skills", "acme__proj-demo", "SKILL.md"), "---\nname: proj-demo\n---\nbody");
  let globalMiss = false;
  try { await wbSkillUninstall({ namespace: "acme", slug: "proj-demo" }); } catch { globalMiss = true; }
  ok("真跑：全局口径卸载删不到项目里的安装（提示另一作用域）", globalMiss);
  let projStill = false;
  try { await readFile(join(wsRoot, ".agents", "skills", "acme__proj-demo", "SKILL.md"), "utf8"); projStill = true; } catch { /* 已删 */ }
  ok("真跑：误报「没有安装记录」后项目目录原样保留", projStill);
} finally {
  globalThis.fetch = realFetch;
  await rmDir(home, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nskill-install-scope: ALL PASS" : `\nskill-install-scope: ${failed} FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
