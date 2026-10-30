// win32 stdio 启动器归一层（lib/win32-stdio.js）直测 + 写入边界接线测。
//
// 钉的是真实故障本身，不是 happy path。2026-10-30 本机实测：
//   spawn('npx', […], {shell:false})    → ENOENT，6ms 内子进程没起来
//   spawn('npx.cmd', […], {shell:false}) → EINVAL（Node ≥ 24 拒绝直接 spawn .cmd）
// 宿主 @deepseek-ai/dsh-mcp-client 正是 shell:false，所以官方 Registry 的裸 npx 条目在 Windows 上
// 100% 连不上，面板只剩「SdkError: Connection closed」。修复后同一条命令走绝对 node.exe +
// npx-cli.js，MCP initialize 与 tools/list 实测通过（adeu-redlining-service 3.0.7，6 个工具）。
//
// 零真实网络、零真实 ~/.dsh、零真实 PATH：fs 与 platform 全部注入。
// 每段都配「把旧写法注回去」的反向自测，防止断言空转。
//
// 用法：node ./test/win32-stdio-launch.mjs
import {
  commandBase,
  detectWin32LaunchContext,
  describeLaunchRewrite,
  isCmdShellCommand,
  planStdioLaunch,
  resetWin32LaunchContext,
  setWin32LaunchContext,
  win32LaunchContext,
} from '../lib/win32-stdio.js';
import { normalizeMcpImport } from '../lib/mcp-config.js';

let failures = 0;
const ok = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);

const NODE = { exe: 'D:\\nodejs\\node.exe', npxCli: 'D:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js', npmCli: 'D:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js' };
const WIN = { applicable: true, platform: 'win32', node: NODE, cacheDir: 'C:\\Users\\me\\.dsh\\armory\\mcp-npm-cache' };
const POSIX = { applicable: false, platform: 'linux', node: null, cacheDir: null };

// ── commandBase：形态判定 ────────────────────────────────────────────────
eq('commandBase 裸 npx', commandBase('npx'), 'npx');
eq('commandBase 大写 NPX.CMD', commandBase('NPX.CMD'), 'npx');
eq('commandBase 带引号绝对路径', commandBase('"C:\\Program Files\\nodejs\\npx.cmd"'), 'npx');
eq('commandBase 正斜杠', commandBase('/usr/local/bin/npx'), 'npx');
eq('commandBase node.exe 归一到 node', commandBase('C:\\a\\node.exe'), 'node');
eq('commandBase 空值', commandBase(undefined), '');

// ── planStdioLaunch：核心改写 ────────────────────────────────────────────
const npxSpec = { name: 'adeu', transport: 'stdio', command: 'npx', args: ['-y', '@adeu/mcp-server'] };

{
  const out = planStdioLaunch(npxSpec, WIN);
  ok('win32 裸 npx 被改写', out.rewritten === true && out.reason === 'rewritten');
  eq('改写后 command 是绝对 node.exe', out.spec.command, NODE.exe);
  eq('入口 JS 顶到 args[0]，-y 与包名顺序不动', out.spec.args, [NODE.npxCli, '-y', '@adeu/mcp-server']);
  eq('注入军械库 npm 缓存', out.spec.env.npm_config_cache, WIN.cacheDir);
  eq('不污染原对象（写入侧共享同一份 spec）', npxSpec.command, 'npx');
  // 反向自测：旧写法＝完全不改写，正是 ENOENT 的那条路径。
  const legacy = planStdioLaunch(npxSpec, POSIX);
  eq('反向自测：非 win32 一律不动（旧行为）', [legacy.rewritten, legacy.spec.command], [false, 'npx']);
}

// 幂等：改写结果再进一次不得二次包装（读回配置 / 反复保存都会走到这里）。
{
  const once = planStdioLaunch(npxSpec, WIN).spec;
  const twice = planStdioLaunch(once, WIN);
  ok('幂等：已归一的 node.exe+npx-cli.js 不二次包装', twice.rewritten === false);
  ok('幂等：走的是「已是归一形态」分支', twice.reason === 'already-normalized');
  eq('幂等后 command 不变', twice.spec.command, once.command);
  eq('幂等后 args 不变', twice.spec.args, once.args);
  ok('幂等：不追加缓存键', Object.keys(twice.spec.env || {}).join() === 'npm_config_cache');
  // 裸 `node` + 入口 JS 这种手写法也要认出「已经是可执行形态」，不再包一层。
  eq('裸 node + npx-cli.js → already-normalized', planStdioLaunch({ command: 'node', args: [NODE.npxCli, '-y', 'p'] }, WIN).reason, 'already-normalized');
}

// 不该动的情形，逐条钉住（动错了比不动更糟：会把「连不上」换成「找不到文件」）。
{
  const cases = [
    ['表达式 ${VAR} 放行', { command: '${NODE_BIN}', args: [] }, 'expression'],
    ['!!js 表达式放行', { command: '!!js require("x")', args: [] }, 'expression'],
    ['绝对 exe 放行', { command: 'C:\\Users\\me\\.workbuddy\\Scripts\\windows-mcp.exe', args: ['serve'] }, 'already-absolute'],
    ['UNC 放行', { command: '\\\\srv\\share\\bin\\server.exe', args: [] }, 'already-absolute'],
    ['裸 node 放行（CreateProcess 自己补 .exe）', { command: 'node', args: ['server.js'] }, 'unsupported-command'],
    ['裸 uvx 放行（本机未装 uv，未实测就不写规则）', { command: 'uvx', args: ['mcp-server-time'] }, 'unsupported-command'],
    ['node-not-found 时宁可不改', { command: 'npx', args: ['-y', 'p'] }, 'node-not-found'],
  ];
  for (const [name, spec, reason] of cases) {
    const context = reason === 'node-not-found' ? { ...WIN, node: null } : WIN;
    const out = planStdioLaunch(spec, context);
    eq(`${name} → reason`, out.reason, reason);
    eq(`${name} → command 不变`, out.spec.command, spec.command);
    ok(`${name} → 不写 env`, out.spec.env === undefined);
  }
}

// 用户自己配过的东西不得覆盖。
{
  const out = planStdioLaunch({ command: 'npx', args: ['-y', 'p'], env: { NPM_CONFIG_CACHE: 'D:\\mine' } }, WIN);
  eq('大小写任一命中都算用户已配缓存', Object.keys(out.spec.env), ['NPM_CONFIG_CACHE']);
  eq('用户缓存值不动', out.spec.env.NPM_CONFIG_CACHE, 'D:\\mine');
  const cwd = planStdioLaunch({ command: 'npx', args: [], cwd: 'C:\\Work' }, WIN);
  eq('cwd 随改写保留', cwd.spec.cwd, 'C:\\Work');
  const noCache = planStdioLaunch({ command: 'npx', args: [] }, { ...WIN, cacheDir: null });
  ok('探测不到可写缓存时不注入空 env 键', noCache.spec.env === undefined);
  const dirty = planStdioLaunch({ command: 'npx', args: ['-y', 42, null, 'pkg'] }, WIN);
  eq('非法参数被剔除，包名顺序仍对', dirty.spec.args, [NODE.npxCli, '-y', 'pkg']);
}

// ── 接线：写入边界 normalizeMcpImport 才是真发生的地方 ────────────────────
{
  setWin32LaunchContext(WIN);
  const res = normalizeMcpImport({ mcpServers: { adeu: { command: 'npx', args: ['-y', '@adeu/mcp-server'] } } });
  eq('接线生效：落盘 command 是可 spawn 的绝对路径', res.servers[0].command, NODE.exe);
  eq('接线生效：args 前插入口 JS', res.servers[0].args, [NODE.npxCli, '-y', '@adeu/mcp-server']);
  eq('接线生效：注入军械库缓存', res.servers[0].env.npm_config_cache, WIN.cacheDir);
  ok('改写会进 warnings（静默改用户输入更糟）', res.warnings.some((line) => line.includes('adeu') && line.includes('Windows')));

  // 反向自测：把上下文退回「非 win32」，写入边界必须回到旧行为（裸 npx）。
  setWin32LaunchContext(POSIX);
  const legacy = normalizeMcpImport({ mcpServers: { adeu: { command: 'npx', args: ['-y', '@adeu/mcp-server'] } } });
  eq('反向自测：非 win32 原样写裸 npx', legacy.servers[0].command, 'npx');
  ok('反向自测：非 win32 不产生 warnings', legacy.warnings.length === 0, JSON.stringify(legacy.warnings));

  // HTTP 条目绝不该被牵连。
  setWin32LaunchContext(WIN);
  const http = normalizeMcpImport({ mcpServers: { remote: { url: 'https://mcp.example.com/mcp' } } });
  eq('HTTP 条目不参与归一', [http.servers[0].transport, http.servers[0].url], ['streamable-http', 'https://mcp.example.com/mcp']);
  resetWin32LaunchContext();
}

// ── describeLaunchRewrite：给用户看的说明只在真改过时出现 ─────────────────
{
  const note = describeLaunchRewrite('npx', NODE.exe);
  ok('改写说明带上新旧命令', note.includes('npx') && note.includes(NODE.exe));
  eq('未改写没有说明', describeLaunchRewrite('npx', 'npx'), '');
  eq('undefined 不炸', describeLaunchRewrite(undefined, undefined), '');
}

// ── detectWin32LaunchContext：探测层用假 fs，覆盖降级分支 ─────────────────
{
  // 假文件系统：Windows 路径大小写不敏感，夹具统一按小写存。
  const files = new Set([
    'c:\\bad\\node.exe',
    'd:\\nodejs\\node.exe',
    'd:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js',
    'd:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
  ]);
  const exists = (v) => files.has(v.toLowerCase());
  const detected = detectWin32LaunchContext({
    platform: 'win32',
    env: { PATH: 'C:\\bad;D:\\nodejs' },
    exists,
    isFile: exists,
    mkDir: () => undefined,
    home: 'C:\\Users\\me',
  });
  eq('跳过没有 npm 的 node.exe，选中标准安装包目录', detected.node.exe, 'D:\\nodejs\\node.exe');
  eq('npx-cli.js 与 node.exe 同目录推导', detected.node.npxCli, 'D:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js');
  eq('缓存目录落在 ~/.dsh/armory 下', detected.cacheDir, 'C:\\Users\\me\\.dsh\\armory\\mcp-npm-cache');
  eq('win32 才 applicable', detected.applicable, true);
  eq('非 win32 直接不介入', detectWin32LaunchContext({ platform: 'darwin' }).applicable, false);
  const onlyNode = detectWin32LaunchContext({
    platform: 'win32',
    env: { PATH: 'C:\\bad' },
    exists: (v) => v.toLowerCase() === 'c:\\bad\\node.exe',
    isFile: (v) => v.toLowerCase() === 'c:\\bad\\node.exe',
    mkDir: () => undefined,
    home: 'C:\\Users\\me',
  });
  ok('只有 node.exe 没有 npx-cli.js 时留作候选但不宣称可改写', onlyNode.node.npxCli === '');
  eq('此时 planStdioLaunch 选择不改', planStdioLaunch({ command: 'npx', args: [] }, { applicable: true, node: onlyNode.node, cacheDir: null }).rewritten, false);
  const noMkdir = detectWin32LaunchContext({
    platform: 'win32',
    env: { PATH: 'D:\\nodejs' },
    exists,
    isFile: exists,
    mkDir: () => { throw new Error('EPERM'); },
    home: 'C:\\Users\\me',
  });
  eq('缓存目录建不出来就不注入（宁缺勿指向坏路径）', noMkdir.cacheDir, null);
  eq('PATH 缺失时不抛错', detectWin32LaunchContext({ platform: 'win32', env: {}, exists: () => false, isFile: () => false, home: '' }).node, null);
}

// ── 探测层降级：写入热路径绝不因探测异常让「加入 MCP」整体失败 ───────────
{
  eq('isCmdShellCommand：裸 npx / npm / .cmd 路径都算', [isCmdShellCommand('npx'), isCmdShellCommand('NPM'), isCmdShellCommand('C:\\a\\npx.cmd')], [true, true, true]);
  eq('isCmdShellCommand：node / uvx / 非字符串不算', [isCmdShellCommand('node'), isCmdShellCommand('uvx'), isCmdShellCommand(undefined)], [false, false, false]);

  const boom = () => { throw new Error('EPERM: stat unavailable'); };
  let guardThrew = false;
  let degraded;
  try {
    degraded = win32LaunchContext(true, boom);
  } catch {
    guardThrew = true;
  }
  eq('探测抛异常时 win32LaunchContext 不外抛', guardThrew, false);
  eq('降级上下文：不介入', degraded.applicable, false);
  eq('降级上下文：如实带 probeError（不是静默「不需要归一」）', degraded.probeError, 'EPERM: stat unavailable');
  eq('降级上下文：node 置空', degraded.node, null);
  eq('降级后 planStdioLaunch 选择不改', planStdioLaunch({ command: 'npx', args: ['p'] }, degraded).reason, 'not-win32');

  let calls = 0;
  win32LaunchContext(true, () => { calls += 1; return WIN; });
  win32LaunchContext();
  eq('上下文进程内只探测一次', calls, 1);

  setWin32LaunchContext({ applicable: false, platform: 'win32', node: null, cacheDir: null, probeError: 'EPERM: stat unavailable' });
  const degradedImport = normalizeMcpImport({ mcpServers: { 'demo-boom': { command: 'npx', args: ['pkg'] } } });
  eq('接线降级：命令原样写入', degradedImport.servers[0].command, 'npx');
  ok('接线降级：warnings 如实上报探测失败', degradedImport.warnings.some((w) => w.includes('探测失败')), JSON.stringify(degradedImport.warnings));
  const safeImport = normalizeMcpImport({ mcpServers: { 'demo-node': { command: 'node', args: ['server.js'] } } });
  ok('非 .cmd 壳命令不刷探测提示', !safeImport.warnings.some((w) => w.includes('探测失败')), JSON.stringify(safeImport.warnings));

  resetWin32LaunchContext();
  ok('reset 后回到本机真实探测且不抛', typeof win32LaunchContext().applicable === 'boolean');
  setWin32LaunchContext(POSIX);
}

console.log(`\n${failures === 0 ? 'win32-stdio-launch: ALL PASS' : `win32-stdio-launch: ${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
