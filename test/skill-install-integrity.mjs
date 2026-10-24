// 技能「假安装」与搜索框失焦的守护套件（2026-10-24 用户报障）：
//   报障一：安装显示成功，但 Skill 看板里没有、磁盘上也没有（或装成残包）。
//     根因：同一技能两个安装任务并发时，rm(staging)/rm(finalDir)/rename 在同一路径上
//     交错——轻则残包缺 SKILL.md（注册表发现不了），重则成功报文发出后目录被另一个
//     任务删掉。守护：宿主按目标目录互斥串行 + 落盘后逐文件复核 + 客户端在飞挡回。
//   报障一的另一半：「已安装」徽标按 slug 单键匹配，同 slug 不同 namespace 的卡片假显示
//     已安装，点卸载必报「本机没有这个市场技能的安装记录」。守护：namespace/slug 双键。
//   报障二：技能搜索框按 Delete（或任何键）停顿 550ms 防抖生效后，skillLoading 把
//     input disabled 掉，浏览器收走焦点，得重点一次才能继续输入。守护：busy 只做视觉，
//     输入框永不 disabled。
// 静态针零网络；并发落盘针真跑 SkillHub（断网时 SKIP 不判_fail）。
// 用法：node ./test/skill-install-integrity.mjs
import { mkdir, mkdtemp, readFile, readdir, rm as rmDir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const wbMarket = await readFile(join(here, "..", "lib", "wb-market.js"), "utf8");
const client = await readFile(join(here, "..", "lib", "client.js"), "utf8");

let failed = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failed += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

// ── 宿主：并发安装串行化 + 落盘复核 ─────────────────────────────────────
ok("宿主：按目标目录的安装互斥锁存在", /const skillInstallLocks = new Map\(\)/.test(wbMarket));
ok("宿主：后序任务排队且不被前序失败连坐", /previous\s*\?\s*previous\.catch\(\(\) => \{\}\)/.test(wbMarket));
ok("宿主：锁在任务结束后按同一 run 引用释放", /if \(skillInstallLocks\.get\(finalDir\) === run\) skillInstallLocks\.delete\(finalDir\)/.test(wbMarket));
ok("宿主：落盘后逐文件复核，缺失即清理并报失败", /安装后校验失败：\$\{file\.path\} 未落盘/.test(wbMarket));
const verifyAt = wbMarket.indexOf("安装后校验失败");
const successAt = wbMarket.indexOf("已安装到 ${finalDir}");
ok("宿主：复核发生在报成功的 note 之前", verifyAt !== -1 && successAt !== -1 && verifyAt < successAt);

// ── 客户端：在飞挡回 + 已装双键 ──────────────────────────────────────────
ok("客户端：同技能在飞安装挡回（不制造两次成功）", /skillInstallInFlight\.current\.has\(flightKey\)/.test(client));
ok("客户端：挡回提示有 en-US 词条", /"该技能正在安装中，请等当前任务结束": "/.test(client));
ok("客户端：已装集合按 namespace/slug 双键建（键 → 安装时间）",
  /setInstalledSkills\(new Map\(\(res\.installed \|\| \[\]\)\.map\(\(row\) => \[skillInstalledKey\(row\), /.test(client));
ok("客户端：卡片 / 详情 / 本页筛选都走双键",
  client.includes("installedSkills.has(skillInstalledKey(skill))")
  && client.includes("installedSkills.has(skillInstalledKey(skillDetail))"));
ok("客户端：slug 单键匹配不得复活",
  !client.includes("installedSkills.has(skill.slug)") && !client.includes("installedSkills.has(skillDetail.slug)"));

// ── 客户端：安装时间展示（2026-10-24 用户需求）───────────────────────────
ok("宿主：wbSkillInstalled 行带 installedAt", /installedAt: ledgerAt\.get\(dir\) \|\| bornAt \|\|/.test(wbMarket));
ok("客户端：市场卡片标签行有「安装于」徽标", /t\('安装于 \{0\}', \[wbFormatDate\(installedAt\)\]\)/.test(client));
ok("客户端：市场详情弹层有「安装于」徽标", client.includes("t('安装于 {0}', [wbFormatDate(installedSkills.get(skillInstalledKey(skillDetail)))]))"));
ok("客户端：看板详情有「安装时间」行", client.includes("t('安装时间')"));
ok("客户端：「安装于 / 安装时间」有 en-US 词条",
  /"安装于 \{0\}": "/.test(client) && /"安装时间": "/.test(client));

// ── 看板：卡片时间徽标 / 最近安装 / 市场原名对应（2026-10-24 用户需求第二轮）──
ok("看板：按 skill 名字查 skillInstallInfo（不依赖 listSkills 行的 path）",
  client.includes("call('skillInstallInfo', skillScopeArg(scope))")
  && !client.includes("skillPathTimes"));
ok("看板：卡片有「装于」时间徽标（近期相对时间）", /t\('装于 \{0\}', \[fmtLast\(at\)\]\)/.test(client));
ok("看板：「最近安装」筛选存在且按时间倒序",
  client.includes("t('最近安装')") && /skillTimeOf\(b\) - skillTimeOf\(a\)/.test(client));
ok("看板：市场原名对应（卡片徽标 + 详情行）",
  /t\('来自市场 \{0\}', \[info\.marketName\]\)/.test(client) && client.includes("t('市场原名')"));
ok("看板：「装于 / 最近安装 / 来自市场 / 市场原名」有 en-US 词条",
  /"装于 \{0\}": "/.test(client) && /"最近安装": "/.test(client)
  && /"来自市场 \{0\}": "/.test(client) && /"市场原名": "/.test(client));
ok("看板：skillInstallInfo 失败不静默——提示重启",
  client.includes("安装时间与市场原名不可用：{0}。宿主侧接口在重启 DeepSeek Harness 后才会注册，重启后即可显示。"));
ok("看板：失败提示有 en-US 词条", /"安装时间与市场原名不可用：\{0\}。/.test(client));

// ── 客户端：搜索框加载态不禁用（焦点守护）────────────────────────────────
const boxSource = client.slice(client.indexOf("const WbSearchBox"), client.indexOf("const WorkBuddyMarket"));
ok("搜索框：input 元素不再带 disabled（disabled 会收走焦点）", !/h\('input', \{[^}]*disabled/.test(boxSource));
ok("搜索框：加载态走 aria-busy + busy 类", /'aria-busy': busy \|\| undefined/.test(boxSource) && /className: 'dsh-mcp-wb-search' \+ \(busy \? ' busy' : ''\)/.test(boxSource));
ok("搜索框：busy 有配套 CSS（放大镜呼吸）", /\.dsh-mcp-wb-search\.busy \.dsh-mcp-wb-search-ico\{[^}]*animation:/.test(client));
const boxCallSites = client.match(/h\(WbSearchBox, \{[\s\S]{0,320}?\}\)/g) || [];
ok("搜索框：四个调用点都在且无一传 disabled",
  boxCallSites.length === 4 && boxCallSites.every((site) => !/disabled:/.test(site)), `count=${boxCallSites.length}`);
ok("技能工具条：排序 select 与「只看已安装」不再 disabled（改排序不被收焦点）",
  !/value: skillSort, disabled: skillLoading/.test(client) && !/checked: skillOnlyInstalled, disabled: skillLoading/.test(client));

// ── 真跑：并发安装同一技能，落盘必须完整 ─────────────────────────────────
const home = await mkdtemp(join(tmpdir(), "armory-integrity-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const { wbSkillFiles, wbSkillInstall, wbSkillInstalled, wbSkillUninstall } = await import(new URL("../lib/wb-market.js", import.meta.url).href);
const { skillInstallInfo, frontmatterName } = await import(new URL("../lib/skill-dir-times.js", import.meta.url).href);

// ── installedAt：账本按 installPath 对齐优先，无账本回落目录创建时间（离线可测）──
{
  const skillsRoot = join(home, ".agents", "skills");
  await mkdir(join(skillsRoot, "acme__ledgered"), { recursive: true });
  await writeFile(join(skillsRoot, "acme__ledgered", "SKILL.md"), "---\nname: ledgered-skill\n---\nbody");
  await mkdir(join(skillsRoot, "acme__bare"), { recursive: true });
  await writeFile(join(skillsRoot, "acme__bare", "SKILL.md"), "---\nname: bare-skill\n---\nbody");
  const armoryHome = join(home, "armory-home");
  await mkdir(armoryHome, { recursive: true });
  process.env.DSH_ARMORY_HOME = armoryHome;
  const ledgerAt = 1700000000000; // 目录创建时间是「现在」，账本值是过去——相等即证明走了账本
  await writeFile(join(armoryHome, "install-state.json"), JSON.stringify({ version: 1, items: [
    { kind: "skill", key: "ledgered", name: "ledgered", installPath: join(skillsRoot, "acme__ledgered"), installedAt: ledgerAt, lastUpdated: ledgerAt },
  ] }, null, 2));
  let rows = (await wbSkillInstalled()).installed;
  ok("installedAt：账本条目按 installPath 对齐优先", rows.find((r) => r.dirName === "acme__ledgered")?.installedAt === ledgerAt);
  ok("installedAt：无账本条目回落目录创建时间（>0）", (rows.find((r) => r.dirName === "acme__bare")?.installedAt || 0) > 0);
  await rmDir(join(armoryHome, "install-state.json"), { force: true });
  rows = (await wbSkillInstalled()).installed;
  ok("installedAt：账本缺失后回落目录时间，列表本身不受影响",
    rows.some((r) => r.dirName === "acme__ledgered" && r.installedAt > 0));

  // ── skillInstallInfo：按 SKILL.md 的 name 自建映射（看板 join 键，不依赖行 path）──
  ok("frontmatterName：解析 name 字段", frontmatterName("---\nname: ledgered-skill\n---\n") === "ledgered-skill");
  ok("frontmatterName：无 frontmatter 返回空串", frontmatterName("no frontmatter") === "");
  await writeFile(join(armoryHome, "install-state.json"), JSON.stringify({ version: 1, items: [
    { kind: "skill", key: "ledgered", name: "ledgered", installPath: join(skillsRoot, "acme__ledgered"), installedAt: ledgerAt, lastUpdated: ledgerAt },
  ] }, null, 2));
  let info = (await skillInstallInfo({}, { home })).info;
  ok("skillInstallInfo：账本路径命中 installedAt（按名字索引）", info["ledgered-skill"]?.installedAt === ledgerAt);
  ok("skillInstallInfo：账本命中附带市场原名", info["ledgered-skill"]?.marketName === "ledgered");
  ok("skillInstallInfo：无账本目录回落创建时间且有 dir", info["bare-skill"]?.installedAt > 0 && !!info["bare-skill"]?.dir);
  // 项目作用域：cwd 下的 .agents/skills 也进映射
  const projectRoot = join(home, "project");
  const projSkill = join(projectRoot, ".agents", "skills", "proj__thing");
  await mkdir(projSkill, { recursive: true });
  await writeFile(join(projSkill, "SKILL.md"), "---\nname: proj-skill\n---\nbody");
  info = (await skillInstallInfo({ cwd: projectRoot }, { home })).info;
  ok("skillInstallInfo：项目作用域目录进映射", info["proj-skill"]?.installedAt > 0);
  delete process.env.DSH_ARMORY_HOME;
}

const payload = { namespace: "indiv-guipi", slug: "find-skills", name: "find-skills" };
let listing = null;
try {
  listing = await wbSkillFiles(payload);
} catch (e) {
  console.log(`SKIP  并发落盘真跑（SkillHub 不可达：${e.message}）`);
}
if (listing) {
  const results = await Promise.allSettled([wbSkillInstall(payload), wbSkillInstall(payload)]);
  ok("真跑：并发两次安装都报成功（串行化后不再互毁）", results.every((r) => r.status === "fulfilled"),
    results.map((r) => r.status).join(","));
  const dir = join(home, ".agents", "skills", "indiv-guipi__find-skills");
  let inner = [];
  try { inner = await readdir(dir); } catch { /* 下面判空即失败 */ }
  ok("真跑：落盘目录含 SKILL.md（残包即假安装）", inner.includes("SKILL.md"), `inner=${inner.join("|")}`);
  const missing = listing.files.map((f) => f.path).filter((p) => !inner.includes(p.split("/")[0]));
  ok("真跑：清单顶层条目全部落盘", missing.length === 0, `missing=${missing.join("|")}`);
  const installed = (await wbSkillInstalled()).installed;
  ok("真跑：已装记录能读到该目录", installed.some((row) => row.dirName === "indiv-guipi__find-skills"));
  let uninstallOk = true;
  try { await wbSkillUninstall(payload); } catch { uninstallOk = false; }
  ok("真跑：卸载成功（目录真实存在过）", uninstallOk);
}
await rmDir(home, { recursive: true, force: true });

console.log(failed === 0 ? "\nskill-install-integrity: ALL PASS" : `\nskill-install-integrity: ${failed} FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
