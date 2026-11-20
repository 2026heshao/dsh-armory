// 市场四项操作护栏（2026-11-17）：
//   ① 技能卸载必须先确认，卡片与详情两个入口都不得一点即删；
//   ② 翻页 / 换搜索词失败时，页码和输入词可以变，但上一批卡片不得冒充新结果；
//   ③ 详情弹层里的安装 / 卸载 / 召唤 / 送还失败，原因必须写在弹层内（外层会被遮罩挡住）；
//   ④ 专家详情串行读取期间，其它「详情」按钮必须禁用，不能看起来能点却没反应。
//
// 手法沿用仓库既有护栏：纯函数进 node:vm 真跑，组件接线做源码针；每条断言都配
// 反向自测，把旧写法在内存里还原后必须失败，否则说明断言是空转。
// 零网络、零写盘、不碰真实 ~/.dsh。
//
// 用法：node ./test/market-action-guards.mjs

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, '..', 'lib', 'client.js');

let failures = 0;
let checks = 0;
const ok = (name, condition, extra = '') => {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
};
const section = (title) => console.log(`\n── ${title} ─────────────────────────────────────────────`);

const source = await readFile(CLIENT, 'utf8');

const sliceBetween = (startMarker, endMarker, label) => {
  const start = source.indexOf(startMarker);
  const end = start < 0 ? -1 : source.indexOf(endMarker, start + startMarker.length);
  ok(`能定位「${label}」片段`, start >= 0 && end > start, `start=${start} end=${end}`);
  return start >= 0 && end > start ? source.slice(start, end) : '';
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. 查询身份：页码 / 排序 / 关键词任一变化都必须是新身份
// ═══════════════════════════════════════════════════════════════════════════
section('1. skillQueryKey');
const KEY_SLICE = sliceBetween(
  'const skillQueryKey = (page, sort, keyword) =>',
  'const WorkBuddyMarket = ({ call, pluginManager }) => {',
  '技能查询身份纯函数',
);
const keyProbe = (() => {
  const context = vm.createContext({});
  vm.runInContext(`${KEY_SLICE}\nglobalThis.__key = skillQueryKey;`, context, { filename: 'skill-query-key.js' });
  return context.__key;
})();
ok('片段能在 vm 里独立执行', typeof keyProbe === 'function');
ok('同一查询生成同一身份', keyProbe(2, 'downloads', '视频') === '2|downloads|视频');
ok('换页码会换身份', keyProbe(2, 'downloads', '视频') !== keyProbe(1, 'downloads', '视频'));
ok('换排序会换身份', keyProbe(1, 'stars', '视频') !== keyProbe(1, 'downloads', '视频'));
ok('换关键词会换身份', keyProbe(1, 'downloads', '视频') !== keyProbe(1, 'downloads', '音频'));
ok('空关键词与 undefined 同口径', keyProbe(1, 'downloads', undefined) === keyProbe(1, 'downloads', ''));
{
  // 反向自测：旧实现漏掉关键词时，两个不同搜索会撞成同一份缓存/身份。
  const broken = KEY_SLICE.replace(" + '|' + String(keyword || '')", '');
  const context = vm.createContext({});
  vm.runInContext(`${broken}\nglobalThis.__key = skillQueryKey;`, context);
  ok(
    '反向自测：漏掉关键词会让两个搜索撞身份',
    context.__key(1, 'downloads', '视频') === context.__key(1, 'downloads', '音频'),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. 加载：只有成功落地/命中缓存才更新 loadedKey；失败不冒充
// ═══════════════════════════════════════════════════════════════════════════
section('2. loadSkills 落地身份');
const LOAD_SLICE = sliceBetween(
  '  const loadSkills = useCallback(async (page, sort, keyword) => {',
  '  useEffect(() => {\n    loadConnectors();',
  '技能列表加载函数',
);
ok('缓存键复用同一身份函数', LOAD_SLICE.includes('const cacheKey = skillQueryKey(page, sort, keyword);'));
ok('缓存命中标记为已落地', /setSkillTotal\(cached\.total\);\s*setSkillLoadedKey\(cacheKey\);/.test(LOAD_SLICE));
ok('成功回包标记为已落地', /setSkillTotal\(res\.total \|\| 0\);\s*setSkillLoadedKey\(cacheKey\);/.test(LOAD_SLICE));
{
  const start = LOAD_SLICE.indexOf('} catch (e) {');
  const end = LOAD_SLICE.indexOf('} finally {', start);
  const catchBlock = start >= 0 && end > start ? LOAD_SLICE.slice(start, end) : '';
  ok('能定位失败分支', !!catchBlock);
  const marksLoaded = (block) => block.includes('setSkillLoadedKey');
  ok('失败分支不标记为已落地', !marksLoaded(catchBlock));
  ok(
    '反向自测：失败分支若标记落地会被抓到',
    marksLoaded(catchBlock.replace('setSkillError', 'setSkillLoadedKey(cacheKey); setSkillError')),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. 渲染：旧批次不渲染卡片 / 空态 / 总数；失败后仍可返回
// ═══════════════════════════════════════════════════════════════════════════
section('3. 旧批次不冒充当前结果');
const cardsGuarded = (s) => s.includes("tab === 'skill' && skillReady && shownSkills.length");
ok('卡片绘制以落地身份为门槛', cardsGuarded(source));
ok(
  '反向自测：去掉门槛会让旧卡片继续显示',
  !cardsGuarded(
    source.replace("tab === 'skill' && skillReady && shownSkills.length", "tab === 'skill' && shownSkills.length"),
  ),
);
ok(
  '普通空态只在落地后判断',
  source.includes("!skillLoading && !skillError && skillReady && tab === 'skill' && !skills.length"),
);
ok(
  '已安装筛空空态只在落地后判断',
  source.includes(
    "!skillLoading && !skillError && skillReady && tab === 'skill' && skills.length && !shownSkills.length",
  ),
);
ok('读取中状态覆盖换页与换词', source.includes("skillLoading && !skillReady && tab === 'skill'"));
ok('工具栏总数只在落地后显示', source.includes('const skillMeta = skillReady && skillTotal'));
ok('本页已安装计数不拿旧页数据', source.includes('skillOnlyInstalled && skillReady'));
{
  const pagerStart = source.indexOf("tab === 'skill' && skillPageCount > 1 && (skillReady || skillPage > 1)");
  ok('失败时翻页条仍可返回上一页', pagerStart >= 0);
  const pagerLine = pagerStart >= 0 ? source.slice(pagerStart, source.indexOf(': null,', pagerStart)) : '';
  ok('翻页条总数不冒充新查询', pagerLine.includes('total: skillReady ? skillTotal : undefined'));
  ok(
    '反向自测：无条件显示翻页条会给第 1 页失败造出假第 2 页',
    !source.includes(
      "tab === 'skill' && skillPageCount > 1\n      ? h(Pager, { page: skillPage, pageCount: skillPageCount, total: skillTotal",
    ),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. 卸载确认：卡片与详情都必须先确认
// ═══════════════════════════════════════════════════════════════════════════
section('4. 卸载二次确认');
const CARD_SLICE = sliceBetween(
  "tab === 'skill' && skillReady && shownSkills.length",
  '// 失败时仍保留翻页条',
  '技能卡片操作区',
);
const cardConfirmGuarded = (s) =>
  /confirmSkillUninstall === installedKey/.test(s) &&
  /onClick: \(\) => setConfirmSkillUninstall\(installedKey\)/.test(s) &&
  /onConfirm: \(\) => uninstallSkill\(skill\)/.test(s) &&
  !/className: 'dsh-mcp-btn danger',\s*disabled: busy,\s*onClick: \(\) => uninstallSkill\(skill\)/.test(s);
ok('卡片卸载先进入确认，且确认后才调用卸载', cardConfirmGuarded(CARD_SLICE));
ok(
  '反向自测：卡片恢复一点即删会被抓到',
  !cardConfirmGuarded(
    CARD_SLICE.replace('onClick: () => setConfirmSkillUninstall(installedKey)', 'onClick: () => uninstallSkill(skill)'),
  ),
);

const MODAL_SLICE = sliceBetween(
  "h('div', { className: 'dsh-mcp-modal-actions' },\n              h(Btn, { onClick: () => closeSkillDetail()",
  '// ── 社区 MCP 详情弹层',
  '技能详情操作区',
);
const modalConfirmGuarded = (s) =>
  s.includes('confirmSkillDetailUninstall') &&
  s.includes('onClick: () => setConfirmSkillDetailUninstall(true)') &&
  /onConfirm: \(\) => uninstallSkill\(skillDetail\)/.test(s) &&
  !/disabled: busy, onClick: \(\) => uninstallSkill\(skillDetail\)/.test(s);
ok('详情卸载先进入确认，且确认后才调用卸载', modalConfirmGuarded(MODAL_SLICE));
ok(
  '反向自测：详情恢复一点即删会被抓到',
  !modalConfirmGuarded(
    MODAL_SLICE.replace(
      'onClick: () => setConfirmSkillDetailUninstall(true)',
      'onClick: () => uninstallSkill(skillDetail)',
    ),
  ),
);
ok(
  '卡片确认与详情确认是两套状态（不会同时展开）',
  source.includes('const [confirmSkillDetailUninstall, setConfirmSkillDetailUninstall] = useState(false);'),
);

// ═══════════════════════════════════════════════════════════════════════════
// 5. 弹层内错误：技能安装/卸载、专家召唤/送还
// ═══════════════════════════════════════════════════════════════════════════
section('5. 弹层内显示操作失败原因');
const INSTALL_SLICE = sliceBetween(
  // issue #27 交互三改：scope 必填（由「选择安装位置」弹层传入），锚点跟着改。
  '  const installSkill = async (skill, scope) => {',
  '  const uninstallSkill = async (skill) => {',
  '技能安装函数',
);
const UNINSTALL_SLICE = sliceBetween(
  '  const uninstallSkill = async (skill) => {',
  '  // P2-3：hover 预取技能详情。',
  '技能卸载函数',
);
const skillErrorGuarded = (s) =>
  s.includes('const message = String(e?.message || e);') &&
  s.includes('setSkillActionError(message);') &&
  s.includes('if (!skillDetail) setError(message);');
ok('安装失败写进弹层，卡片安装仍保留外层错误', skillErrorGuarded(INSTALL_SLICE));
ok(
  '反向自测：安装失败只写外层会被抓到',
  !skillErrorGuarded(
    INSTALL_SLICE.replace(
      'setSkillActionError(message);\n      if (!skillDetail) setError(message);',
      'setError(message);',
    ),
  ),
);
ok('卸载失败写进弹层，卡片卸载仍保留外层错误', skillErrorGuarded(UNINSTALL_SLICE));
ok(
  '反向自测：卸载失败只写外层会被抓到',
  !skillErrorGuarded(
    UNINSTALL_SLICE.replace(
      'setSkillActionError(message);\n      if (!skillDetail) setError(message);',
      'setError(message);',
    ),
  ),
);
ok(
  '技能弹层渲染操作失败原因',
  source.includes("skillActionError ? h('p', { className: 'dsh-mcp-wb-error', role: 'alert' }"),
);

const EXPERT_SLICE = sliceBetween(
  '  const summon = async (expert) => {',
  '  const queryKey = query.trim().toLowerCase();',
  '专家召唤与送还函数',
);
const expertErrorGuarded = (s) =>
  (s.match(/setExpertActionError\(message\);/g) || []).length === 2 &&
  (s.match(/if \(!detail\) setError\(message\);/g) || []).length === 2;
ok('召唤失败与送还失败都写进弹层，卡片入口保留外层错误', expertErrorGuarded(EXPERT_SLICE));
ok(
  '反向自测：只把召唤失败写进弹层会被抓到',
  !expertErrorGuarded(
    EXPERT_SLICE.replace(
      "setExpertActionError(message);\n      if (!detail) setError(message);\n    } finally {\n      setBusy(false); setBusyLabel('');\n    }\n  };\n  const dismiss",
      "setError(message);\n    } finally {\n      setBusy(false); setBusyLabel('');\n    }\n  };\n  const dismiss",
    ),
  ),
);
ok(
  '专家弹层渲染操作失败原因',
  source.includes("expertActionError ? h('p', { className: 'dsh-mcp-wb-error', role: 'alert' }"),
);

// ═══════════════════════════════════════════════════════════════════════════
// 6. 专家详情串行读取：其它按钮必须禁用
// ═══════════════════════════════════════════════════════════════════════════
section('6. 专家详情按钮');
const expertButtonGuarded = (s) =>
  s.includes('disabled: !!openingPlugin,') && s.includes("openingPlugin === item.plugin ? t('读取中…') : t('详情')");
ok('读取期间其它详情按钮禁用，当前按钮显示读取中', expertButtonGuarded(source));
ok(
  '反向自测：只禁用当前按钮会让其它按钮假可点',
  !expertButtonGuarded(source.replace('disabled: !!openingPlugin,', 'disabled: openingPlugin === item.plugin,')),
);

console.log(`\n${failures ? 'MARKET-ACTION-GUARDS FAIL' : 'MARKET-ACTION-GUARDS PASS'} ${checks - failures}/${checks}`);
if (failures) process.exitCode = 1;
