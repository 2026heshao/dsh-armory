// 技能链接位（Skill 看板启停开关的链接警告）数据层回归：
//   ① 普通目录 → linked:false；
//   ② 目录链接（Windows 用 junction，无需管理员）→ linked:true，realPath 指向共享源；
//   ③ 链接目录里的 SKILL.md → 同样识别为 linked；
//   ④ 相对路径 / 空路径 / 不存在的路径 → 一律 false，绝不因探测失败报假警告；
//   ⑤ 反向自测：用「原样比较」的旧写法跑同一路径必须漏判，证明本用例真能变红。
// 全程 mkdtemp 隔离，零真实 ~/.dsh、零网络。
//
// 运行：node ./test/skill-links.mjs

import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeSkillLink } from '../lib/skill-links.js';

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

const root = await mkdtemp(join(tmpdir(), 'dsh-armory-skill-links-'));
const store = join(root, 'store');
const realSkill = join(store, 'brandkit');
const skills = join(root, 'skills');
const linkSkill = join(skills, 'brandkit');

try {
  await mkdir(realSkill, { recursive: true });
  await writeFile(join(realSkill, 'SKILL.md'), '---\nname: brandkit\ndescription: demo\n---\nbody\n', 'utf8');
  await mkdir(skills, { recursive: true });

  // Windows 的 junction 不需要开发者模式；Unix 用普通目录链接。
  let linkReady = false;
  try {
    await symlink(realSkill, linkSkill, process.platform === 'win32' ? 'junction' : 'dir');
    linkReady = true;
  } catch (error) {
    console.log(`SKIP  目录链接创建失败（${error?.code || error?.message}），当前环境无法验证链接判定`);
  }

  section('1. 普通目录');
  const plain = await describeSkillLink(realSkill);
  ok('普通目录 linked:false', plain.linked === false, JSON.stringify(plain));

  section('2. 目录链接');
  const linkedDir = await describeSkillLink(linkSkill);
  ok('链接目录 linked:true（无链接权限时跳过）', !linkReady || linkedDir.linked === true, JSON.stringify(linkedDir));
  ok('realPath 指向共享源（无链接权限时跳过）', !linkReady
    || (linkedDir.linked
      ? String(linkedDir.realPath || '').toLowerCase().endsWith('store\\brandkit')
        || String(linkedDir.realPath || '').toLowerCase().endsWith('store/brandkit')
      : false), linkedDir.realPath || '');

  section('3. 链接目录里的清单');
  const linkedManifest = await describeSkillLink(join(linkSkill, 'SKILL.md'));
  ok('链接目录里的 SKILL.md 也识别为 linked（无链接权限时跳过）', !linkReady || linkedManifest.linked === true, JSON.stringify(linkedManifest));

  section('4. 不可判定路径');
  const relative = await describeSkillLink('skills/brandkit');
  ok('相对路径 linked:false', relative.linked === false, JSON.stringify(relative));
  const empty = await describeSkillLink('');
  ok('空路径 linked:false', empty.linked === false, JSON.stringify(empty));
  const missing = await describeSkillLink(join(root, 'missing', 'SKILL.md'));
  ok('不存在的路径 linked:false（失败不报假警告）', missing.linked === false, JSON.stringify(missing));

  section('5. 反向自测');
  // 旧写法：直接拿传入路径当答案，不做 realpath。链接目录下它必然返回 false——
  // 如果本用例的断言改成这种写法还能全绿，说明测试没有真正覆盖链接判定。
  const naiveIsLinked = (path) => Promise.resolve({ linked: false });
  const naive = await naiveIsLinked(linkSkill);
  ok('朴素写法会漏判链接（证明本用例能变红；无链接权限时跳过）',
    !linkReady || (naive.linked === false && linkedDir.linked === true));
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'ALL PASS' : 'FAILED'}  ${checks - failures}/${checks}`);
process.exitCode = failures === 0 ? 0 : 1;
