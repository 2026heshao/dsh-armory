// 系统打开器护栏（issue #7）：headless 主机点「安装」授权连接器，进程直接退出。
//
// 根因：lib/index.js 旧写法 `spawn("xdg-open", …).unref()` 没挂 'error' 监听。
// headless 主机（NAS / 容器）没有 xdg-open，spawn 的 ENOENT 是**异步 error 事件**，
// 无人监听就升级成 uncaughtException，宿主进程退出 → 面板所有 API 502。
//
// 本套件分三层，缺一层都可能是空转：
//   ① 静态：index.js 不得再出现 spawn / unref / child_process，两处打开动作必须走 lib/system-open.js；
//   ② 行为：真跑 launchDetached——命令缺失时 resolve {ok:false} 且进程存活，命令存在时 {ok:true}；
//   ③ 反向自测：把旧写法放进子进程，必须以非零码崩掉；新写法放进子进程，必须正常退出。
//      没有 ③，② 只能证明「新代码能跑」，不能证明它挡住的正是 issue #7 那个形态。
//
// 零真实网络、不开浏览器：只探测命令是否存在，缺失命令名可稳定复现。
// 用法：node ./test/system-open-spawn-guard.mjs
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  launchDetached,
  openSystemUrl,
  pathRevealCommand,
  revealSystemPath,
  urlOpenCommand,
} from '../lib/system-open.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MISSING = 'dsh-armory-no-such-opener-xyz';

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

// ═══ ① 静态：业务代码不再自己 spawn ═══════════════════════════════════════
section('① 静态契约：打开动作只走 lib/system-open.js');
const indexSource = await readFile(join(HERE, '..', 'lib', 'index.js'), 'utf8');
const helperSource = await readFile(join(HERE, '..', 'lib', 'system-open.js'), 'utf8');

ok('index.js 不再直接 import node:child_process', !indexSource.includes('node:child_process'));
ok('index.js 不再出现裸 spawn(', !/\bspawn\s*\(/.test(indexSource));
ok('index.js 不再出现 .unref()', !indexSource.includes('.unref()'));
ok('openExternalUrl 走 openSystemUrl', /await openSystemUrl\(target/.test(indexSource));
ok('openExternalUrl 失败时如实回 opened:false', /return \{ opened: false, reason: opened\.reason/.test(indexSource));
ok('revealSkill 走 revealSystemPath', /await revealSystemPath\(path/.test(indexSource));
ok('revealSkill 失败时不再谎报「已打开」', /return \{ note: `没有可用的系统打开器/.test(indexSource));

ok("helper 挂了常驻 'error' 监听", helperSource.includes("child.on('error'"));
ok("helper 等 'spawn' 落地才 unref", helperSource.includes("child.once('spawn'"));
ok('helper 只有成功才 unref', /if \(outcome\.ok\) child\.unref\(\)/.test(helperSource));

// ═══ ② 平台命令映射（纯函数，不启动任何进程）═══════════════════════════════
section('② 平台命令映射');
const winUrl = urlOpenCommand('https://example.com/a?b=1&c=2', 'win32');
ok(
  'win32 用 rundll32（不经 cmd 解析 &）',
  winUrl.command === 'rundll32' && winUrl.args[0] === 'url.dll,FileProtocolHandler',
);
ok('win32 的 URL 原样直传', winUrl.args[1] === 'https://example.com/a?b=1&c=2');
ok('darwin 用 open', urlOpenCommand('https://x', 'darwin').command === 'open');
ok('linux 用 xdg-open', urlOpenCommand('https://x', 'linux').command === 'xdg-open');
const winPath = pathRevealCommand('C:\\tmp\\a b', 'win32');
ok('win32 定位用 explorer /select,', winPath.command === 'explorer' && winPath.args[0] === '/select,');
ok('darwin 定位用 open', pathRevealCommand('/tmp/x', 'darwin').command === 'open');
const linuxPathCmd = pathRevealCommand('/tmp/x', 'linux');
ok('linux 定位用 xdg-open', linuxPathCmd.command === 'xdg-open' && linuxPathCmd.args[0] === '/tmp/x');

// ═══ ③ 行为：命令缺失不再拖走进程 ═════════════════════════════════════════
section('③ 真跑 launchDetached');
const warnings = [];
const logger = { warn: (message) => warnings.push(String(message)) };
const missing = await launchDetached(MISSING, ['u'], { logger });
ok('命令缺失 → resolve 而不是 throw', missing && missing.ok === false, JSON.stringify(missing));
ok('命令缺失 → ENOENT 落到 reason', missing?.code === 'ENOENT' && missing.reason.includes('找不到系统命令'));
ok(
  '命令缺失 → 日志留痕（不静默吞掉）',
  warnings.length === 1 && warnings[0].includes(MISSING),
  warnings[0] || '无日志',
);
ok('命令缺失后本进程仍存活（能继续执行断言）', true);

const started = await launchDetached(process.execPath, ['-e', '0']);
ok('命令存在 → ok:true', started.ok === true, JSON.stringify(started));

const noLogger = await launchDetached(MISSING, []);
ok('没有 logger 也不炸', noLogger.ok === false);

// 包装层也真跑一遍，但先把 PATH 清空：保证 xdg-open / open 都找不到，
// 既覆盖 headless 形态，也绝不在这台机器上真的弹出浏览器。
const savedPath = process.env.PATH;
process.env.PATH = '';
try {
  const linuxUrl = await openSystemUrl('https://example.com', { platform: 'linux', logger: { warn() {} } });
  ok('openSystemUrl 返回可判定结果（不 reject）', linuxUrl.ok === false && Boolean(linuxUrl.reason));
  const linuxPath = await revealSystemPath('/tmp/nope', { platform: 'linux', logger: { warn() {} } });
  ok('revealSystemPath 返回可判定结果（不 reject）', linuxPath.ok === false && Boolean(linuxPath.reason));
} finally {
  process.env.PATH = savedPath;
}

// ═══ ④ 反向自测：旧写法必须崩，新写法必须不崩 ══════════════════════════════
section('④ 反向自测（子进程隔离）');
const legacy = spawnSync(
  process.execPath,
  [
    '-e',
    `const { spawn } = require('node:child_process');\n` +
      `spawn(${JSON.stringify(MISSING)}, ['u'], { detached: true, stdio: 'ignore' }).unref();\n` +
      `console.log('legacy-alive');`,
  ],
  { encoding: 'utf8', timeout: 15000 },
);
ok('旧写法（无 error 监听）在命令缺失时进程崩掉', legacy.status !== 0, `status=${legacy.status}`);
ok(
  "旧写法的死因正是 Unhandled 'error' event",
  String(legacy.stderr || '').includes("Unhandled 'error' event"),
  String(legacy.stderr || '').split('\n')[2] || '',
);

const helperUrl = pathToFileURL(join(HERE, '..', 'lib', 'system-open.js')).href;
const guarded = spawnSync(
  process.execPath,
  [
    '--input-type=module',
    '-e',
    `import { launchDetached } from ${JSON.stringify(helperUrl)};\n` +
      `const result = await launchDetached(${JSON.stringify(MISSING)}, [], {});\n` +
      `console.log('GUARDED ' + JSON.stringify(result));`,
  ],
  { encoding: 'utf8', timeout: 15000 },
);
ok('新写法在命令缺失时进程正常退出', guarded.status === 0, `status=${guarded.status} stderr=${guarded.stderr || ''}`);
ok(
  '新写法把失败变成结果而不是异常',
  String(guarded.stdout || '').includes('GUARDED {"ok":false') && String(guarded.stdout || '').includes('ENOENT'),
  String(guarded.stdout || '').trim(),
);

console.log(
  `\n${failures ? `SYSTEM-OPEN FAIL（${failures} / ${checks} 条不通过）` : `SYSTEM-OPEN PASS（${checks} 条）`}`,
);
process.exit(failures ? 1 : 0);
