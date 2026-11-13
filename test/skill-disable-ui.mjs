// Skill 看板启停开关（issue #14）的静态 + 纯函数回归：
//   ① 三处入口：网格卡片右下、列表行右侧、详情正文顶部的接线都在；
//   ② 可写来源闸门：四类来源 + 必须有磁盘 path；只读来源 / 无 path 一律不出开关；
//   ③ 失败回滚：乐观更新后必须能回滚，并走看板根级提示；
//   ④ 「已禁用」筛选与清除全部筛选；
//   ⑤ 后端 listSkills / skillDetail 带上 linked 链接位，警告行只在 linked 时渲染；
//   ⑥ Toggle 支持 className（三处定位靠它），旧的「没有启用/禁用开关」注释不得复活。
// 附反向自测：去掉 path 闸门 / 去掉 actionable 闸门都会放行坏数据，证明本用例能变红。
//
// 运行：node ./test/skill-disable-ui.mjs

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(ROOT, 'lib', 'client.js');
const HOST = join(ROOT, 'lib', 'index.js');
const RUN_ALL = join(ROOT, 'test', 'run-all.mjs');

let failures = 0;
let checks = 0;
const ok = (name, condition, extra = '') => {
  checks += 1;
  const pass = !!condition;
  if (!pass) failures += 1;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
  return pass;
};
const section = (title) => console.log(`\n── ${title} ─────────────────────────────────────────────`);

const source = await readFile(CLIENT, 'utf8');
const hostSource = await readFile(HOST, 'utf8');
const runAllSource = await readFile(RUN_ALL, 'utf8');

const grab = (text, startMark, endMark) => {
  const start = text.indexOf(startMark);
  if (start < 0) return '';
  const end = text.indexOf(endMark, start + startMark.length);
  return end > start ? text.slice(start, end) : '';
};
const count = (text, needle) => text.split(needle).length - 1;

section('0. 源码切片');
const DISABLE_HELPERS = grab(
  source,
  "const SKILL_DISABLE_SOURCES = new Set",
  "// ── Skill 分类升级",
);
ok('能定位启停来源白名单与 actionable 判定一节', DISABLE_HELPERS.length > 200, `len=${DISABLE_HELPERS.length}`);
ok('Toggle 已支持 className', source.includes(
  "const Toggle = ({ on, disabled, busy, onChange, title, label, className }) =>",
) && source.includes("'dsh-mcp-toggle' + (className ? ' ' + className : '')"));

section('1. 三处入口接线');
ok('网格卡片右下开关', source.includes("className: 'dsh-mcp-skill-card-toggle'"));
ok('列表行右侧开关', source.includes("className: 'dsh-mcp-skill-row-toggle'"));
ok('列表主按钮让出开关留白', source.includes("(disableReady ? ' disable-ready' : '')"));
ok('详情正文控制行', source.includes("className: 'dsh-mcp-skill-ctrl'"));
ok('卡片与列表都走同一个 toggleSkillDisabled', count(source, "onChange: (next) => toggleSkillDisabled(s, !next)") === 2,
  `x${count(source, "onChange: (next) => toggleSkillDisabled(s, !next)")}`);
ok('详情也走同一个 toggleSkillDisabled', count(source, "onChange: (next) => toggleSkillDisabled(summary, !next)") === 1);
ok('三处开关只锁正在写的那一条', count(source, 'busy: disableBusy.has(') === 3,
  `x${count(source, 'busy: disableBusy.has(')}`);
ok('busy 是 Set 而不是单个字符串', source.includes('const [disableBusy, setDisableBusy] = useState(() => new Set());'));
ok('同一技能用 ref 做同步锁', source.includes('if (!name || disableBusyRef.current.has(name)) return;'));
ok('Toggle 支持 busy 且写 aria-busy', source.includes('{ on, disabled, busy, onChange, title, label, className }')
  && source.includes("'aria-busy': busy ? 'true' : undefined"));
ok('忙碌态只改光标、不改透明度', source.includes(".dsh-mcp-toggle[aria-busy='true']{cursor:progress}"));
ok('不再有「一个写入锁住全页开关」的旧写法', !source.includes('disabled: !!disableBusy'));
ok('不再用 disabled 表达单个开关的忙碌态', !source.includes('disabled: disableBusy.has('));

section('2. 可写来源闸门');
const context = vm.createContext({});
vm.runInContext(
  `${DISABLE_HELPERS}\nglobalThis.__disable = { skillDisableActionableBoard, SKILL_DISABLE_SOURCES_SCOPED, SKILL_DISABLE_SOURCES };`,
  context,
  { filename: 'client-disable-helpers.js' },
);
const { skillDisableActionableBoard, SKILL_DISABLE_SOURCES_SCOPED, SKILL_DISABLE_SOURCES } = context.__disable;
const row = (sourceName, pathValue = '/tmp/skills/demo/SKILL.md') => ({ source: sourceName, path: pathValue });
ok('用户级 .agents 可开关', skillDisableActionableBoard(row('user-agents')) === true);
ok('用户级 .dsh 可开关', skillDisableActionableBoard(row('user-dsh')) === true);
ok('项目级 .agents 可开关', skillDisableActionableBoard(row('project-agents')) === true);
ok('项目级 .dsh 可开关', skillDisableActionableBoard(row('project-dsh')) === true);
ok('随包分发不可开关', skillDisableActionableBoard(row('bundled')) === false);
ok('自定义目录不可开关', skillDisableActionableBoard(row('custom')) === false);
ok('运行时注册不可开关', skillDisableActionableBoard(row('runtime')) === false);
ok('没有磁盘 path 的可写来源也不出开关', skillDisableActionableBoard({ source: 'user-agents' }) === false);
ok('空 path 不出开关', skillDisableActionableBoard(row('user-agents', '')) === false);
ok('空行不抛错', skillDisableActionableBoard(null) === false);
ok('工具裁缝的用户级白名单仍然只含两类来源',
  SKILL_DISABLE_SOURCES.size === 2 && SKILL_DISABLE_SOURCES.has('user-agents') && SKILL_DISABLE_SOURCES.has('user-dsh'));
ok('看板白名单含四类来源', SKILL_DISABLE_SOURCES_SCOPED.size === 4);

section('3. 乐观更新与回滚');
ok('切换前记录原值', source.includes("const before = skill.modelInvocable !== false;"));
ok('先乐观改本地列表', source.includes("setModelInvocable(name, !nextDisabled);"));
ok('失败回滚到原值', source.includes("setModelInvocable(name, before);"));
ok('失败走看板根级提示', source.includes("showNotice(nextDisabled ? t('禁用失败：{0}', [reason]) : t('启用失败：{0}', [reason]), false);"));
ok('RPC 名与作用域一起传', source.includes("call(nextDisabled ? 'disableSkill' : 'enableSkill', {")
  && source.includes("...skillScopeArg(scope), name,"));

section('4. 已禁用筛选');
ok('筛选按可写来源 + 模型位', source.includes(
  "if (onlyDisabled && !(skillDisableActionableBoard(s) && s.modelInvocable === false)) return false;",
));
ok('筛选计数同口径', source.includes(
  "skills.filter((s) => skillDisableActionableBoard(s) && s.modelInvocable === false).length",
));
ok('清除全部筛选包含已禁用', source.includes("setOnlyModel(false); setOnlyUser(false); setOnlyDisabled(false);"));
ok('已禁用空态文案', source.includes("当前没有已禁用的 skill；把开关关掉后会出现在这里。"));

section('5. 链接警告与后端字段');
ok('后端导入 describeSkillLink', hostSource.includes('import { describeSkillLink } from "./skill-links.js";'));
ok('后端只对四类来源探测链接', hostSource.includes('const SKILL_LINK_SOURCES = new Set(["user-agents", "user-dsh", "project-agents", "project-dsh"]);'));
ok('listSkills 与 skillDetail 都带链接位', count(hostSource, '...(await skillLinkFields(skill, options))') === 2,
  `x${count(hostSource, '...(await skillLinkFields(skill, options))')}`);
ok('详情只在 linked 时渲染共享源警告', source.includes('summaryDisableReady && summary.linked'));
ok('警告文案带真实目标', source.includes('共用同一来源的其他 agent 也会受影响。'));
ok('旧的「没有启用/禁用开关」注释不得复活', !source.includes('没有启用/禁用开关'));

section('6. i18n 与测试登记');
// 措辞按 issue #17 从「模型调用」改为「调用方式：自动 / 仅手动」：开关本身没变，
// 但要保证详情控制行的标签、状态字与英文表三处同时到位（只改一处会中英混杂）。
ok('英文表有调用方式', source.includes('"调用方式": "Invocation"'));
ok('英文表有仅手动 / 自动调用', source.includes('"仅手动": "Manual only"') && source.includes('"自动调用": "Automatic"'));
ok('详情控制行标签为「调用方式」', source.includes("h('span', { className: 'dsh-mcp-skill-ctrl-label' }, t('调用方式'))"));
ok('详情状态字为「仅手动 / 自动调用」', source.includes("summaryOff ? t('仅手动') : t('自动调用')"));
ok('英文表有禁用失败', source.includes('"禁用失败：{0}": "Failed to disable: {0}"'));
ok('英文表有共享链接警告', source.includes('"该技能目录是指向共享位置的链接；开关会改写源文件（{0}），共用同一来源的其他 agent 也会受影响。"'));
ok('skill-links 已登记到 run-all', runAllSource.includes('file: "skill-links.mjs"'));
ok('本套件已登记到 run-all', runAllSource.includes('file: "skill-disable-ui.mjs"'));

section('7. 反向自测');
const naiveSourceOnly = (r) => SKILL_DISABLE_SOURCES_SCOPED.has(String(r?.source || ''));
ok('去掉 path 闸门会放行无路径行（证明第 2 节不是恒真）',
  naiveSourceOnly({ source: 'user-agents' }) === true
  && skillDisableActionableBoard({ source: 'user-agents' }) === false);
const naiveModelOnly = (s) => s.modelInvocable === false;
const readOnlyOff = { source: 'bundled', path: '/tmp/x/SKILL.md', modelInvocable: false };
ok('只按模型位筛选会混入只读技能（证明 actionable 闸门有用）',
  naiveModelOnly(readOnlyOff) === true
  && (skillDisableActionableBoard(readOnlyOff) && readOnlyOff.modelInvocable === false) === false);

console.log(`\n${failures === 0 ? 'ALL PASS' : 'FAILED'}  ${checks - failures}/${checks}`);
process.exitCode = failures === 0 ? 0 : 1;
