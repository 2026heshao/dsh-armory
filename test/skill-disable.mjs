// 技能禁用数据层（lib/skill-disable.js）的回归套件。
//
// 这个模块是工具裁缝「禁用 / 释放」的唯一落盘点，写入面是用户的 SKILL.md，所以测试
// 目标同样不是 happy path，而是**不能写什么、写完必须长什么样**：
//   - 纯函数 editInvocationFlag：插入/收敛/移除标志行、CRLF 保留、无 frontmatter 拒绝、
//     块内重复键收敛、正文与嵌套键不受牵连、幂等；
//   - 落盘闸门：来源白名单（bundled / runtime / custom / 缺 cwd 一律拒绝）、路径边界
//     （根自身、`..` 穿越、根外绝对路径）、形态（目录缺 SKILL.md、非 .md、BOM、
//     缺 frontmatter）、符号链接（根外拒绝；根内允许且链接本体不被改写）；
//   - 写入结果用 yaml 包按宿主同一解析器语义复核：disable-model-invocation 恒为
//     布尔 true，其余键原样保留。
//
// 隔离纪律：全部落在 mkdtemp 下，home / cwd 显式注入，绝不碰真实 ~/.agents 或 ~/.dsh。
// 符号链接在 Windows 用 junction（无需管理员权限），语义与目录 symlink 相同。
// 用法：node ./test/skill-disable.mjs
import { rmSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

const { DISABLED_INVOCATION_KEY, editInvocationFlag, setSkillModelInvocationOnDisk } = await import(
  new URL('../lib/skill-disable.js', import.meta.url).href
);

let failures = 0;
const ok = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

async function expectThrow(name, run, fragment = '') {
  try {
    await run();
    ok(name, false, '预期抛错但没有');
    return '';
  } catch (error) {
    const message = String(error?.message || error);
    ok(name, !fragment || message.includes(fragment), message);
    return message;
  }
}

const DEMO_FRONTMATTER = [
  '---',
  'name: demo',
  'description: a demo skill',
  'whenToUse: whenever',
  '---',
  '',
  '# demo body',
  '',
].join('\n');

/** 按宿主 parseFrontmatter 的语义切出 frontmatter 块并解析（测试侧复核用）。 */
function parseFrontmatter(text) {
  const firstBreak = text.indexOf('\n');
  if (text.slice(0, firstBreak).replace(/\r$/, '') !== '---') return null;
  const rest = text.slice(firstBreak + 1);
  const close = rest.split('\n').findIndex((line) => line.replace(/\r$/, '') === '---');
  if (close < 0) return null;
  return parse(rest.split('\n').slice(0, close).join('\n'));
}

// ── 1. 纯函数 editInvocationFlag ─────────────────────────────────────────────
{
  const disabled = editInvocationFlag(DEMO_FRONTMATTER, true);
  ok('disable：写入 canonical 键且值为 true', disabled?.includes('\ndisable-model-invocation: true\n') === true);
  ok(
    'disable：其余字节原样保留',
    disabled === DEMO_FRONTMATTER.replace('\n---\n', '\ndisable-model-invocation: true\n---\n'),
  );

  const twice = editInvocationFlag(disabled, true);
  ok('disable：幂等（二次写入结果不变）', twice === disabled);

  const fromFalse = editInvocationFlag(
    DEMO_FRONTMATTER.replace('whenToUse: whenever', 'disable-model-invocation: false\nwhenToUse: whenever'),
    true,
  );
  ok(
    'disable：已有的 false 值被收敛为单行 true',
    (fromFalse.match(/disable-model-invocation/g) || []).length === 1 &&
      fromFalse.includes('disable-model-invocation: true'),
  );

  const dup = editInvocationFlag(
    DEMO_FRONTMATTER.replace('whenToUse: whenever', 'disable-model-invocation: yes\ndisable-model-invocation: 0'),
    true,
  );
  ok(
    'disable：重复键收敛为单行 true',
    (dup.match(/disable-model-invocation/g) || []).length === 1 && dup.includes('disable-model-invocation: true'),
  );

  const reEnabled = editInvocationFlag(disabled, false);
  ok('enable：标志行被移除，其余原样', reEnabled === DEMO_FRONTMATTER);
  ok('enable：无标志时原文返回（幂等）', editInvocationFlag(DEMO_FRONTMATTER, false) === DEMO_FRONTMATTER);

  const nested = DEMO_FRONTMATTER.replace(
    'whenToUse: whenever',
    'metadata:\n  disable-model-invocation: false\nwhenToUse: whenever',
  );
  ok('enable：嵌套在 metadata 下的同名键不受牵连', editInvocationFlag(nested, false) === nested);

  const bodyFlag = DEMO_FRONTMATTER + 'disable-model-invocation: true\n';
  ok('enable：正文里的同名文本不被误删', editInvocationFlag(bodyFlag, false) === bodyFlag);

  const crlf = DEMO_FRONTMATTER.replace(/\n/g, '\r\n');
  const crlfOut = editInvocationFlag(crlf, true);
  ok(
    'disable：CRLF 行尾整体保留',
    crlfOut?.includes('\r\ndisable-model-invocation: true\r\n') === true &&
      !crlfOut.slice(0, crlfOut.indexOf('---', 4)).includes('\n--'),
  );
  ok('disable：CRLF 下 enable 复原', editInvocationFlag(crlfOut, false) === crlf);

  ok('无 frontmatter（纯正文）→ null', editInvocationFlag('# just a doc\n', true) === null);
  ok('frontmatter 未闭合 → null', editInvocationFlag('---\nname: x\n', true) === null);
  ok('空串 → null', editInvocationFlag('', true) === null);
  ok(
    '空 frontmatter（开闭紧邻）禁用后仍合法',
    editInvocationFlag('---\n---\nbody\n', true) === '---\ndisable-model-invocation: true\n---\nbody\n',
  );
  const emptyReEnabled = editInvocationFlag('---\ndisable-model-invocation: true\n---\nbody\n', false);
  ok('唯一 frontmatter 行是标志时 enable 得到空 frontmatter', emptyReEnabled === '---\n---\nbody\n');
}

// ── 2. 落盘：四类白名单来源成功写入 + 幂等 + 复原 ─────────────────────────────
const base = await mkdtemp(join(tmpdir(), 'dsh-armory-skill-disable-'));
// 断言中途抛错时也必须删掉临时目录（不能只靠最后一行清理）。
process.once('exit', () => { try { rmSync(base, { recursive: true, force: true }); } catch { /* 忽略 */ } });
const home = join(base, 'home');
const cwd = join(base, 'project');

{
  const cases = [
    ['user-agents', join(home, '.agents', 'skills')],
    ['user-dsh', join(home, '.dsh', 'skills')],
    ['project-agents', join(cwd, '.agents', 'skills')],
    ['project-dsh', join(cwd, '.dsh', 'skills')],
  ];
  for (const [source, root] of cases) {
    const dir = join(root, 'alpha-' + source);
    await mkdir(dir, { recursive: true });
    const manifest = join(dir, 'SKILL.md');
    await writeFile(manifest, DEMO_FRONTMATTER);

    const off = await setSkillModelInvocationOnDisk(
      { name: 'alpha', source, path: dir },
      { disabled: true, home, cwd },
    );
    ok(`${source}：禁用写盘 changed=true`, off.changed === true && off.path === manifest);
    const offText = await readFile(manifest, 'utf8');
    ok(
      `${source}：禁用后宿主解析语义为 modelInvocable=false`,
      parseFrontmatter(offText)?.[DISABLED_INVOCATION_KEY] === true,
    );
    ok(
      `${source}：其余 frontmatter 键原样保留`,
      parseFrontmatter(offText)?.name === 'demo' && parseFrontmatter(offText)?.description === 'a demo skill',
    );

    const again = await setSkillModelInvocationOnDisk(
      { name: 'alpha', source, path: manifest },
      { disabled: true, home, cwd },
    );
    ok(`${source}：重复禁用幂等 changed=false`, again.changed === false);

    const on = await setSkillModelInvocationOnDisk(
      { name: 'alpha', source, path: manifest },
      { disabled: false, home, cwd },
    );
    ok(
      `${source}：释放复原 changed=true`,
      on.changed === true && (await readFile(manifest, 'utf8')) === DEMO_FRONTMATTER,
    );
  }
}

// ── 3. 扁平 <name>.md 形态 ───────────────────────────────────────────────────
{
  const flat = join(home, '.dsh', 'skills', 'flat-demo.md');
  await mkdir(join(home, '.dsh', 'skills'), { recursive: true });
  await writeFile(flat, DEMO_FRONTMATTER);
  await setSkillModelInvocationOnDisk(
    { name: 'flat-demo', source: 'user-dsh', path: flat },
    { disabled: true, home, cwd },
  );
  ok('扁平 .md：标志写入文件本身', parseFrontmatter(await readFile(flat, 'utf8'))?.[DISABLED_INVOCATION_KEY] === true);
}

// ── 4. 来源白名单：不可写来源拒绝且磁盘不变 ──────────────────────────────────
{
  const root = join(home, '.agents', 'skills');
  for (const source of ['bundled', 'runtime', 'custom', 'unknown', '']) {
    const target = join(root, 'keep-' + (source || 'blank'));
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'SKILL.md'), DEMO_FRONTMATTER);
    await expectThrow(
      `来源 ${source || '(空)'}：拒绝禁用`,
      () => setSkillModelInvocationOnDisk({ source, path: target }, { disabled: true, home, cwd }),
      '不在可禁用范围内',
    );
    ok(
      `来源 ${source || '(空)'}：文件未被改动`,
      (await readFile(join(target, 'SKILL.md'), 'utf8')) === DEMO_FRONTMATTER,
    );
  }
  // 项目级缺 cwd：拒绝且给出可读原因。
  const proj = join(cwd, '.dsh', 'skills', 'needs-cwd');
  await mkdir(proj, { recursive: true });
  await writeFile(join(proj, 'SKILL.md'), DEMO_FRONTMATTER);
  await expectThrow(
    '项目级缺 cwd：拒绝禁用',
    () => setSkillModelInvocationOnDisk({ source: 'project-dsh', path: proj }, { disabled: true, home }),
    '需要当前项目路径',
  );
}

// ── 5. 路径边界与形态 ────────────────────────────────────────────────────────
{
  const outside = join(base, 'outside');
  await mkdir(join(outside, 'evil'), { recursive: true });
  await writeFile(join(outside, 'evil', 'SKILL.md'), DEMO_FRONTMATTER);
  await expectThrow(
    '根外绝对路径：拒绝',
    () =>
      setSkillModelInvocationOnDisk({ source: 'user-dsh', path: join(outside, 'evil') }, { disabled: true, home, cwd }),
    '不在预期的 skills 根目录内',
  );
  await expectThrow(
    '相对路径：拒绝',
    () => setSkillModelInvocationOnDisk({ source: 'user-dsh', path: '.dsh/skills/x' }, { disabled: true, home, cwd }),
    '不是绝对路径',
  );
  await expectThrow(
    '缺 path（运行时注册）：拒绝',
    () => setSkillModelInvocationOnDisk({ source: 'user-dsh', path: '' }, { disabled: true, home, cwd }),
    '不落盘',
  );

  const root = join(home, '.dsh', 'skills');
  const noManifest = join(root, 'no-manifest');
  await mkdir(noManifest, { recursive: true });
  await expectThrow(
    '目录缺 SKILL.md：拒绝',
    () => setSkillModelInvocationOnDisk({ source: 'user-dsh', path: noManifest }, { disabled: true, home, cwd }),
    '没有 SKILL.md',
  );
  const notMd = join(root, 'plain.txt');
  await writeFile(notMd, DEMO_FRONTMATTER);
  await expectThrow(
    '非 .md 文件：拒绝',
    () => setSkillModelInvocationOnDisk({ source: 'user-dsh', path: notMd }, { disabled: true, home, cwd }),
    '不是 .md 清单文件',
  );
  const noFm = join(root, 'no-frontmatter');
  await mkdir(noFm, { recursive: true });
  await writeFile(join(noFm, 'SKILL.md'), '# no frontmatter\n');
  await expectThrow(
    '缺 frontmatter：拒绝',
    () => setSkillModelInvocationOnDisk({ source: 'user-dsh', path: noFm }, { disabled: true, home, cwd }),
    '没有合法的 YAML frontmatter',
  );
  const bom = join(root, 'bom');
  await mkdir(bom, { recursive: true });
  await writeFile(join(bom, 'SKILL.md'), '\uFEFF' + DEMO_FRONTMATTER);
  await expectThrow(
    'BOM：拒绝',
    () => setSkillModelInvocationOnDisk({ source: 'user-dsh', path: bom }, { disabled: true, home, cwd }),
    'BOM',
  );
  await expectThrow(
    '已消失的 skill：可读错误',
    () =>
      setSkillModelInvocationOnDisk(
        { source: 'user-dsh', path: join(root, 'vanished') },
        { disabled: true, home, cwd },
      ),
    '已经不在磁盘上',
  );

  // `..` 穿越：字符串形式在根内表达，resolve 后落在根外。
  const escape = join(root, '..', '.agents', 'skills', 'keep-bundled');
  await expectThrow(
    '`..` 穿越：拒绝',
    () => setSkillModelInvocationOnDisk({ source: 'user-dsh', path: escape }, { disabled: true, home, cwd }),
    '不在预期的 skills 根目录内',
  );
}

// ── 6. 符号链接 ──────────────────────────────────────────────────────────────
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
{
  // 指向根外的链接目录：realpath 闸门拒绝，真实内容不被触碰。
  const realDir = join(base, 'real-skill');
  await mkdir(realDir, { recursive: true });
  await writeFile(join(realDir, 'SKILL.md'), DEMO_FRONTMATTER);
  const linked = join(home, '.dsh', 'skills', 'linked-out');
  await mkdir(join(home, '.dsh', 'skills'), { recursive: true });
  await symlink(realDir, linked, linkType);
  await expectThrow(
    '链接目录指向根外：拒绝',
    () => setSkillModelInvocationOnDisk({ source: 'user-dsh', path: linked }, { disabled: true, home, cwd }),
    '指向了 skills 根目录之外',
  );
  ok('链接目录指向根外：真实文件未被改动', (await readFile(join(realDir, 'SKILL.md'), 'utf8')) === DEMO_FRONTMATTER);

  // 指向根内的链接目录：允许，且写的是真实文件、链接本体保持链接。
  const innerTarget = join(home, '.dsh', 'skills', 'inner-target');
  await mkdir(innerTarget, { recursive: true });
  await writeFile(join(innerTarget, 'SKILL.md'), DEMO_FRONTMATTER);
  const linkedIn = join(home, '.dsh', 'skills', 'linked-in');
  await symlink(innerTarget, linkedIn, linkType);
  await setSkillModelInvocationOnDisk(
    { name: 'linked-in', source: 'user-dsh', path: linkedIn },
    { disabled: true, home, cwd },
  );
  const linkInfo = await lstat(linkedIn);
  ok('链接目录指向根内：禁用成功且链接本体未被替换', linkInfo.isSymbolicLink());
  ok(
    '链接目录指向根内：标志落在真实文件上',
    parseFrontmatter(await readFile(join(innerTarget, 'SKILL.md'), 'utf8'))?.[DISABLED_INVOCATION_KEY] === true,
  );

  // SKILL.md 文件本身是链接（指向根内）：写 realpath，链接不变成普通文件。
  // Windows 无管理员权限建不了文件符号链接（junction 只支持目录），该形态只在
  // POSIX 下验证——实现走的是同一条 realpath 写入路径，不分支。
  if (process.platform !== 'win32') {
    const manifestLink = join(home, '.dsh', 'skills', 'plain-skill');
    await mkdir(manifestLink, { recursive: true });
    const realManifest = join(innerTarget, 'SHARED.md');
    await writeFile(realManifest, DEMO_FRONTMATTER);
    await symlink(realManifest, join(manifestLink, 'SKILL.md'), 'file');
    await setSkillModelInvocationOnDisk({ source: 'user-dsh', path: manifestLink }, { disabled: true, home, cwd });
    ok('SKILL.md 是根内链接：链接仍是链接', (await lstat(join(manifestLink, 'SKILL.md'))).isSymbolicLink());
    ok(
      'SKILL.md 是根内链接：标志写入真实目标',
      parseFrontmatter(await readFile(realManifest, 'utf8'))?.[DISABLED_INVOCATION_KEY] === true,
    );
  }
}

await rm(base, { recursive: true, force: true });
console.log(failures === 0 ? '\nSKILL-DISABLE PASS' : `\nSKILL-DISABLE FAIL（${failures} 处）`);
process.exit(failures === 0 ? 0 : 1);
