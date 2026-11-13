// 召唤菜单首帧快照（issue #17）的回归护栏。
//
// 现象：每个会话第一次点开召唤菜单，顶部先画三条骨架条，清单回来后才换成真实条目。
// 修法：把上一次的清单投影成轻量快照存 localStorage，下次首帧直接用它当初始值。
//
// 这里直测三件纯逻辑 + 一个闭环：
//   1. quickRecentSnapshot 的裁剪（条数上限、描述截断）——快照不是数据源，不能无界增长；
//   2. validQuickRecentSnapshot 的结构校验（老版本 / 手改坏 / 全空都要当成「没有」）；
//   3. 读写闭环：写进去能原样读回来，损坏值读成 null 而不抛错；
//   4. 反向自测：不裁剪时体积/条数确实超限，证明断言的裁剪真的起作用。
//
// 源码从 client.js 抽出来在 vm 里真跑（textOf 段一并抽入），零浏览器依赖。

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(ROOT, 'lib', 'client.js');

let failures = 0;
const ok = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
};

const source = await readFile(CLIENT, 'utf8');
const grab = (startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  if (start < 0) return '';
  const end = source.indexOf(endMarker, start + startMarker.length);
  return end > start ? source.slice(start, end) : '';
};

const textSlice = grab('const TEXT_KEYS_ZH', 'const applyI18nLocale');
const snapshotSlice = grab("const QUICK_RECENT_KEY = 'dsh-armory:quick-recent:v1'", 'const SummonQuickMenu = (');
ok('能定位 textOf 段', textSlice.length > 0);
ok('能定位快照段', snapshotSlice.length > 0);
if (!textSlice || !snapshotSlice) {
  console.log('\nQUICK-MENU-SNAPSHOT FAIL（标记缺失，无法抽取待测源码）');
  process.exit(1);
}

// localStorage 替身：可控、可注入坏值。
const store = new Map();
const localStorageStub = {
  getItem: (key) => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: (key) => store.delete(key),
};

const context = vm.createContext({ console, window: { localStorage: localStorageStub }, usesEnglish: () => false });
vm.runInContext(
  `${textSlice}\n${snapshotSlice}\nglobalThis.__probe = { quickRecentSnapshot, validQuickRecentSnapshot, readQuickRecentSnapshot, writeQuickRecentSnapshot, slimQuickRow, QUICK_RECENT_KEY };`,
  context,
);
const probe = context.__probe;

// ── 1. 裁剪 ───────────────────────────────────────────────────────────────
const many = Array.from({ length: 120 }, (_, i) => ({ name: `skill-${i}`, description: 'x'.repeat(200) }));
const snap = probe.quickRecentSnapshot({ skill: many, mcp: many, expert: many, suite: [], recentSkill: many, recentMcp: [], recentExpert: [] });
ok('技能条数被裁到上限', snap.skill.length === 80, `got ${snap.skill.length}`);
ok('描述被截断', snap.skill[0].description.length === 60, `len=${snap.skill[0].description.length}`);
ok('最近使用只留 20 条', snap.recentSkill.length === 20, `got ${snap.recentSkill.length}`);
ok('缺少的分类写空数组', Array.isArray(snap.recentMcp) && snap.recentMcp.length === 0);

// 专家行要保留 plugin（菜单用它做唯一键），suite 行要保留 members。
const expertSnap = probe.quickRecentSnapshot({ skill: [], mcp: [], expert: [{ plugin: 'p1', name: '甲', nameEn: 'A', presetId: 'preset-wbexpert-p1' }], suite: [{ id: 's1', name: '套件', desc: 'd', members: ['a', 'b'] }], recentSkill: [], recentMcp: [], recentExpert: [] });
ok('专家行保留 plugin / presetId', expertSnap.expert[0].plugin === 'p1' && expertSnap.expert[0].presetId === 'preset-wbexpert-p1');
ok('套件行保留 members', Array.isArray(expertSnap.suite[0].members) && expertSnap.suite[0].members.length === 2);

// ── 2. 结构校验 ───────────────────────────────────────────────────────────
ok('v 不匹配视为没有', probe.validQuickRecentSnapshot({ v: 2, skill: [], mcp: [], expert: [], suite: [], recentSkill: [], recentMcp: [], recentExpert: [] }) === null);
ok('缺数组字段视为没有', probe.validQuickRecentSnapshot({ v: 1, skill: [], mcp: [] }) === null);
ok('全空视为没有（避免先画空态再翻成有内容）', probe.validQuickRecentSnapshot({ v: 1, skill: [], mcp: [], expert: [], suite: [], recentSkill: [], recentMcp: [], recentExpert: [] }) === null);
ok('非对象视为没有', probe.validQuickRecentSnapshot(null) === null && probe.validQuickRecentSnapshot('oops') === null);

// ── 3. 读写闭环 ───────────────────────────────────────────────────────────
probe.writeQuickRecentSnapshot(expertSnap);
const readBack = probe.readQuickRecentSnapshot();
ok('写进去能读回来（专家行仍在）', !!readBack && readBack.expert.length === 1 && readBack.expert[0].plugin === 'p1');
ok('读回来是归一后的新对象（不是同一引用）', readBack.expert !== expertSnap.expert);

store.set(probe.QUICK_RECENT_KEY, '{ 这不是 JSON');
ok('损坏的 JSON 读成 null 不抛错', probe.readQuickRecentSnapshot() === null);

store.set(probe.QUICK_RECENT_KEY, JSON.stringify({ v: 1, skill: 'nope' }));
ok('结构不对的 JSON 读成 null', probe.readQuickRecentSnapshot() === null);

// localStorage 抛错（隐私模式 / 配额满）时读写都要安静失败。
const throwContext = vm.createContext({
  console,
  window: { localStorage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } } },
  usesEnglish: () => false,
});
vm.runInContext(
  `${textSlice}\n${snapshotSlice}\nglobalThis.__probe = { readQuickRecentSnapshot, writeQuickRecentSnapshot };`,
  throwContext,
);
let threwOutside = false;
try {
  throwContext.__probe.writeQuickRecentSnapshot(expertSnap);
  throwContext.__probe.readQuickRecentSnapshot();
} catch {
  threwOutside = true;
}
ok('localStorage 不可用时不向外抛错', threwOutside === false);

// ── 4. 反向自测：不裁剪就会超限 ───────────────────────────────────────────
const naive = { skill: many, recentSkill: many };
ok('反向自测：不裁剪时条数确实超限', naive.skill.length > 80 && naive.recentSkill.length > 20);
ok('反向自测：不截断时描述确实超长', many[0].description.length > 60);

if (failures > 0) {
  console.log(`\nQUICK-MENU-SNAPSHOT FAIL（${failures} 条断言未通过）`);
  process.exit(1);
}
console.log('\nQUICK-MENU-SNAPSHOT PASS');
