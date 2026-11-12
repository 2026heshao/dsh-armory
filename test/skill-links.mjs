// 技能链接位（Skill 看板启停开关的共享源警告）数据层回归：
//   ① 宿主给的是 realpath（链接目标在根外）→ 仍能回查到根里的直接入口，linked:true；
//   ② 直接给链接路径 / 链接目录里的 SKILL.md → linked:true；
//   ③ 普通目录、相对 / 空 / 不存在的路径 → linked:false，不报假警告；
//   ④ skills 根目录自身是链接 → linked:true（整棵库共享）；
//   ⑤ 反向自测：朴素的「path === realpath(path)」会漏判 realpath 输入，证明本用例能变红。
// 全程 mkdtemp 隔离，零真实 ~/.dsh、零网络。
//
// 运行：node ./test/skill-links.mjs

import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
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

const linkType = process.platform === 'win32' ? 'junction' : 'dir';

const root = await mkdtemp(join(tmpdir(), 'dsh-armory-skill-links-'));
const home = join(root, 'home');
const skillsRoot = join(home, '.dsh', 'skills');
const store = join(root, 'store');
const realSkill = join(store, 'brandkit');
const linkSkill = join(skillsRoot, 'brandkit');
const plainSkill = join(skillsRoot, 'plain-skill');

try {
  await mkdir(realSkill, { recursive: true });
  await writeFile(join(realSkill, 'SKILL.md'), '---\nname: brandkit\ndescription: demo\n---\nbody\n', 'utf8');
  await mkdir(skillsRoot, { recursive: true });
  await mkdir(plainSkill, { recursive: true });
  await writeFile(join(plainSkill, 'SKILL.md'), '---\nname: plain-skill\ndescription: demo\n---\nbody\n', 'utf8');

  let linkReady = false;
  try {
    await symlink(realSkill, linkSkill, linkType);
    linkReady = true;
  } catch (error) {
    console.log(`SKIP  目录链接创建失败（${error?.code || error?.message}），当前环境无法验证链接判定`);
  }

  section('1. 宿主给的是 realpath（链接目标在根外）');
  // 宿主 parseSkillFile 返回 readSkillText 的 realpath，这是真实注册表形态。
  const fromRealPath = await describeSkillLink(
    { name: 'brandkit', source: 'user-dsh', path: realSkill },
    { home },
  );
  ok('realpath 输入 linked:true（无链接权限时跳过）', !linkReady || fromRealPath.linked === true, JSON.stringify(fromRealPath));
  ok('realPath 指向共享源（无链接权限时跳过）', !linkReady
    || (fromRealPath.linked
      ? String(fromRealPath.realPath || '').toLowerCase().includes('store\\brandkit')
        || String(fromRealPath.realPath || '').toLowerCase().includes('store/brandkit')
      : false), fromRealPath.realPath || '');

  section('2. 链接路径与清单路径');
  const fromLink = await describeSkillLink(
    { name: 'brandkit', source: 'user-dsh', path: linkSkill },
    { home },
  );
  ok('链接路径输入 linked:true（无链接权限时跳过）', !linkReady || fromLink.linked === true, JSON.stringify(fromLink));
  const fromManifest = await describeSkillLink(
    { name: 'brandkit', source: 'user-dsh', path: join(linkSkill, 'SKILL.md') },
    { home },
  );
  ok('链接目录里的 SKILL.md 也识别为 linked（无链接权限时跳过）', !linkReady || fromManifest.linked === true, JSON.stringify(fromManifest));

  section('3. 普通目录与不可判定路径');
  const plain = await describeSkillLink(
    { name: 'plain-skill', source: 'user-dsh', path: plainSkill },
    { home },
  );
  ok('普通目录 linked:false', plain.linked === false, JSON.stringify(plain));
  const relative = await describeSkillLink({ source: 'user-dsh', path: 'skills/brandkit' }, { home });
  ok('相对路径 linked:false', relative.linked === false, JSON.stringify(relative));
  const empty = await describeSkillLink({ source: 'user-dsh', path: '' }, { home });
  ok('空路径 linked:false', empty.linked === false, JSON.stringify(empty));
  const missing = await describeSkillLink({ source: 'user-dsh', path: join(skillsRoot, 'missing') }, { home });
  ok('不存在的路径 linked:false（失败不报假警告）', missing.linked === false, JSON.stringify(missing));

  section('4. skills 根目录自身是链接');
  {
    const home2 = join(root, 'home-linked');
    const realRoot = join(root, 'real-dsh-skills');
    await mkdir(join(realRoot, 'via-root-link'), { recursive: true });
    await writeFile(join(realRoot, 'via-root-link', 'SKILL.md'), '---\nname: via-root-link\ndescription: demo\n---\nbody\n', 'utf8');
    await mkdir(join(home2, '.dsh'), { recursive: true });
    let rootLinkReady = false;
    try {
      await symlink(realRoot, join(home2, '.dsh', 'skills'), linkType);
      rootLinkReady = true;
    } catch { /* 无权限时跳过 */ }
    const viaRoot = await describeSkillLink(
      { name: 'via-root-link', source: 'user-dsh', path: join(realRoot, 'via-root-link') },
      { home: home2 },
    );
    ok('根目录是链接 linked:true（无链接权限时跳过）', !rootLinkReady || viaRoot.linked === true, JSON.stringify(viaRoot));
  }

  section('5. 反向自测');
  // 2.5.2 的真实缺陷：宿主已经给了 realpath，再拿 path 和 realpath(path) 比会恒等。
  // 如果这里朴素写法也能判成 linked，说明测试没有覆盖「realpath 输入」这条真实路径。
  const naiveIsLinked = async (path) => {
    const real = await realpath(path).catch(() => null);
    return { linked: !!real && real !== path };
  };
  const naive = await naiveIsLinked(realSkill);
  ok('朴素 path-vs-realpath 写法会漏判 realpath 输入（证明本用例能变红）',
    naive.linked === false && (!linkReady || fromRealPath.linked === true));
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? 'ALL PASS' : 'FAILED'}  ${checks - failures}/${checks}`);
process.exitCode = failures === 0 ? 0 : 1;
