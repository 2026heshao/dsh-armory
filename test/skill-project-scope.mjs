// Skill 看板项目作用域回归（issue #8）。
//
// 背景：宿主 listSkills 的语义是「payload 里有 cwd 才扫项目级技能根目录
// （<cwd>/.agents/skills、<cwd>/.dsh/skills）；没有 cwd 只扫用户级与内置目录」。
// 看板长期把 scope 当组件 prop 用，但挂载处从未传值，于是 skillScopeArg(undefined)
// 恒得到 { cwd: undefined }，项目级 skill 一条都进不来，界面上也没有任何作用域切换。
//
// 修复选的是 issue 里给的方案 B：SkillBoard 自取 listWorkspaces、自管 scope（hash 键
// skillws），不把 MCP 页的 scope 状态提到面板层。这条护栏要钉住三件事：
//   1. 四条技能 RPC 全走 skillScopeArg(scope)，不许有调用点漏掉作用域；
//   2. 作用域切换确实存在（listWorkspaces → ScopeTabs → switchScope → hash）；
//   3. 失效工作区能回退全局，不会让看板停在一条不存在的 tab 上。
// 另含反向自测：把任一调用点的 scope 改回 undefined，检测器必须变红。
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js');
const source = await readFile(CLIENT, 'utf8');

let failures = 0;
const ok = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
};

const SIGNATURE = 'const SkillBoard = ({ call, timer }) => {';
const START = source.indexOf(SIGNATURE);
const END = source.indexOf('const WB_MARKET_CONNECTOR_PAGE_SIZE =', START);
ok('能定位到 SkillBoard 源码段（签名不再接收 scope prop）', START >= 0 && END > START,
  `start=${START} end=${END}`);
const BOARD = END > START ? source.slice(START, END) : '';

// ── 1. 作用域状态与工作区来源 ────────────────────────────────────────────────
ok('scope 是组件内状态，初始值取 hash skillws 并回落 global',
  /const \[scope, setScope\] = useState\(\(\) => readHashParam\('skillws'\) \|\| 'global'\)/.test(BOARD));
ok('看板自己取工作区列表（listWorkspaces）',
  /call\('listWorkspaces'\)/.test(BOARD) && /setWorkspaces\(res\.workspaces\)/.test(BOARD));
ok('工作区列表区分「未取到」与「为空」（workspacesLoaded）',
  /const \[workspacesLoaded, setWorkspacesLoaded\] = useState\(false\)/.test(BOARD)
  && /setWorkspacesLoaded\(true\)/.test(BOARD));
ok('作用域 tab = 全局 + 各工作区，并接上 ScopeTabs',
  /const scopeTabs = useMemo\(\(\) => \{[\s\S]{0,220}?label: t\('全局'\)/.test(BOARD)
  && /h\(ScopeTabs, \{ tabs: scopeTabs, active: scope, onSelect: switchScope \}\)/.test(BOARD));
ok('切换作用域写 hash（skillws），并把选中项与来源筛选归零',
  /const switchScope = useCallback\(\(next\) => \{[\s\S]{0,320}?writeHashParams\(\{ skillws: next === 'global' \? null : next, skillpick: '' \}\)/.test(BOARD)
  && /setSourceFilter\('all'\)/.test(BOARD));
ok('失效工作区回退全局（清 hash + setScope）',
  /workspaces\.some\(\(ws\) => ws\.path === scope\)/.test(BOARD)
  && /writeHashParams\(\{ skillws: null, skillpick: '' \}\)/.test(BOARD)
  && /setScope\('global'\)/.test(BOARD));
ok('作用域行只在有多个作用域时渲染（老宿主不多占一行）',
  /scopeTabs\.length > 1 \? h\('div', \{ className: 'dsh-mcp-skill-scope' \}/.test(BOARD));
ok('作用域行有配套样式',
  /\.dsh-mcp-skill-scope\{display:flex/.test(source));
// 实机回归（2026-10-31）：作用域行是横向 flex，若 ScopeTabs 的 wrap 保持 flex:none，
// 它的宽度就等于内容宽度——估算宽度一旦让 tab 折叠成「全局 …N」，内容变窄，RO 再测
// 到的仍是窄宽，折叠状态锁死（1000px 面板里工作区一个都看不到）。wrap 必须吃满这一行。
ok('作用域行里的 ScopeTabs wrap 撑满可用宽度（折叠态可随面板变宽恢复）',
  /\.dsh-mcp-skill-scope>\.dsh-mcp-tabs-wrap\{flex:1 1 auto;min-width:0\}/.test(source));

// ── 1.5 项目作用域只显示项目本地技能 ─────────────────────────────────────────
// 宿主 list({cwd}) 返回「用户级 + 随包 + 项目本地」的并集，项目目录为空时与全局完全一样。
// 看板按来源收窄，项目里没有 skill 就显示空态——否则用户会以为作用域切换没生效。
ok('项目作用域按来源收窄（project-agents / project-dsh）',
  /const PROJECT_SKILL_SOURCES = new Set\(\['project-agents', 'project-dsh'\]\)/.test(source)
  && /setSkills\(scope === 'global' \? rows : rows\.filter\(isProjectSkillRow\)\)/.test(BOARD));
ok('套件管理器拿未收窄的全集（allSkills），避免项目作用域把用户级成员误标失效',
  /const \[allSkills, setAllSkills\] = useState\(\[\]\)/.test(BOARD)
  && /setAllSkills\(rows\)/.test(BOARD)
  && /skills: allSkills/.test(BOARD)
  && /setAllSkills\(\(rows\) => rows\.filter/.test(BOARD));
ok('项目作用域空态说明只看项目本地技能',
  /这个工作区没有本地 skill/.test(BOARD)
  && /项目作用域只显示工作区里 \.agents\/skills 与 \.dsh\/skills 的技能/.test(BOARD));

// 真跑过滤器：来源白名单必须精确，别把 user-* / bundled 混进项目作用域。
{
  const start = source.indexOf('const PROJECT_SKILL_SOURCES =');
  const end = source.indexOf('\n', source.indexOf(';', source.indexOf('isProjectSkillRow', start)));
  ok('能定位到项目技能来源过滤器', start >= 0 && end > start);
  if (start >= 0 && end > start) {
    const run = (code) => {
      const sandbox = { console };
      vm.createContext(sandbox);
      vm.runInContext(code + '\n;globalThis.__f = isProjectSkillRow;', sandbox, { filename: 'project-skill-row.js' });
      return sandbox.__f;
    };
    const probe = run(source.slice(start, end));
    const cases = [
      ['project-agents', true], ['project-dsh', true],
      ['user-agents', false], ['user-dsh', false], ['bundled', false], ['runtime', false], ['custom', false],
      [undefined, false], [null, false],
    ];
    const bad = cases.filter(([src, want]) => probe({ source: src }) !== want);
    ok('项目技能过滤器只认 project-* 来源', bad.length === 0,
      bad.length ? `不符=${JSON.stringify(bad)}` : `用例=${cases.length}`);
    // 反向自测：白名单一旦收窄或写错，上面必须变红。
    const broken = run(source.slice(start, end).replace("'project-dsh'", "'project-other'"));
    ok('自测：来源白名单写错会被过滤器断言抓到', broken({ source: 'project-dsh' }) === false);
  }
}

// ── 2. 四条技能 RPC 必须带作用域 ─────────────────────────────────────────────
// 从源码里抽出所有「call('<method>', ...skillScopeArg(scope)... )」的方法名，做成集合。
const callsWithScope = (slice) => {
  const out = new Set();
  const re = /call\('([A-Za-z]+)',\s*(\{[^}]*\}|\S[^)]*)\)/g;
  let m;
  while ((m = re.exec(slice))) {
    if (m[2].includes('skillScopeArg(scope')) out.add(m[1]);
  }
  return out;
};
const scoped = callsWithScope(BOARD);
const required = ['listSkills', 'skillDetail', 'skillInstallInfo', 'removeSkill', 'revealSkill'];
const missing = required.filter((method) => !scoped.has(method));
ok('技能读写 RPC 全部带当前作用域（skillScopeArg(scope)）', missing.length === 0,
  missing.length ? `缺=${JSON.stringify(missing)} 实际=${JSON.stringify([...scoped])}` : `命中=${JSON.stringify([...scoped])}`);

// ── 3. skillScopeArg 语义（真跑纯函数）──────────────────────────────────────
const argStart = source.indexOf('const skillScopeArg =');
const argEnd = source.indexOf('\n', source.indexOf(';', argStart));
ok('能定位到 skillScopeArg 定义', argStart >= 0 && argEnd > argStart);
if (argStart >= 0 && argEnd > argStart) {
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(source.slice(argStart, argEnd) + '\n;globalThis.__arg = skillScopeArg;', sandbox, { filename: 'skill-scope-arg.js' });
  ok('全局作用域不传 cwd（只扫用户级与内置）', JSON.stringify(sandbox.__arg('global')) === '{}');
  ok('项目作用域把工作区路径作为 cwd 传下去',
    JSON.stringify(sandbox.__arg('D:/work/project')) === JSON.stringify({ cwd: 'D:/work/project' }));
}

// ── 4. 挂载处不再依赖父层传 scope ──────────────────────────────────────────
ok('面板挂载 SkillBoard 时不传 scope（作用域由看板自管）',
  /h\(SkillBoard, \{ call, timer \}\)/.test(source)
  && !/h\(SkillBoard, \{[^}]*scope/.test(source));

// ── 5. 反向自测：漏掉作用域必须被第 2 节抓到 ────────────────────────────────
{
  const mutated = BOARD.replace("call('listSkills', skillScopeArg(scope))", "call('listSkills', skillScopeArg(undefined))");
  ok('自测前置：成功把 listSkills 的 scope 改回 undefined', mutated !== BOARD);
  const mutatedMissing = required.filter((method) => !callsWithScope(mutated).has(method));
  ok('自测：漏传作用域会被检测器抓到（证明第 2 节不是恒真）',
    mutatedMissing.length === missing.length + 1 && mutatedMissing.includes('listSkills'),
    `新增缺失=${JSON.stringify(mutatedMissing.filter((m) => !missing.includes(m)))}`);
}

console.log(`\n${failures === 0 ? 'SKILL-PROJECT-SCOPE PASS' : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
