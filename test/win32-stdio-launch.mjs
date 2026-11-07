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
  isBlockedLaunchShape,
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
  // 表达式命令由宿主求值、本层不改写；normalizeEntry 会把 ${VAR} 转成 !!js，
  // 不能仅凭字符串不同就报告「已改用本机 Node」。
  eq('${VAR} 转成内部 !!js 不是一次改写',
    describeLaunchRewrite('${NPX_BIN}', '!!js (process.env.NPX_BIN ?? "")'), '');
  eq('最终形态不是 node 启动器时不声称改写',
    describeLaunchRewrite('npx', 'C:\\bin\\npx.cmd'), '');
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
    canWrite: () => true,
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
    canWrite: () => true,
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
  // 建得出来 ≠ 写得进去：目录已存在时 mkdir(recursive) 一律成功，只读/ACL 拒绝要靠真探针。
  // 旧实现就在这里把写不进去的路径注入成 npm_config_cache，npx 下载阶段照旧 EPERM。
  const readOnlyCache = detectWin32LaunchContext({
    platform: 'win32',
    env: { PATH: 'D:\\nodejs' },
    exists,
    isFile: exists,
    mkDir: () => undefined,
    canWrite: () => false,
    home: 'C:\\Users\\me',
  });
  eq('缓存目录写不进去时不注入（探针不可写=宁缺勿指向坏路径）', readOnlyCache.cacheDir, null);
  const writableCache = detectWin32LaunchContext({
    platform: 'win32',
    env: { PATH: 'D:\\nodejs' },
    exists,
    isFile: exists,
    mkDir: () => undefined,
    canWrite: () => true,
    home: 'C:\\Users\\me',
  });
  eq('反向自测：同一份输入只是探针变可写，缓存目录才出现（证明上一条不是恒真）',
    writableCache.cacheDir, 'C:\\Users\\me\\.dsh\\armory\\mcp-npm-cache');
  const noCacheInject = planStdioLaunch({ command: 'npx', args: ['-y', 'pkg'] },
    { applicable: true, node: detected.node, cacheDir: readOnlyCache.cacheDir, fileExists: exists });
  ok('反向自测：写不进去时 planStdioLaunch 不注入 npm_config_cache',
    noCacheInject.rewritten === true && !('env' in noCacheInject.spec), JSON.stringify(noCacheInject.spec));
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

// ── 13. 跨机 / 跨平台的过期归一形态：不能免检 ─────────────────────────────
// 2026-11-06 复核出的缺口：`already-normalized` 过去只看形态（绝对 node.exe + *-cli.js），
// 不校验这两个路径在本机是否存在。于是从别的机器导入、Node 换位安装（fnm/volta/scoop），
// 或把 Windows 写的配置拿到 mac/Linux 上时，条目会被判「已经归一、不用管」，既不改写也不
// 提示，用户拿到一条注定 spawn 不了的命令；而 whats-new 承诺的补救「重新加入 MCP」在代码里
// 也走不通（同名直接 MCP already exists）。现在三种情况都有明确去向。
{
  const FOREIGN = {
    applicable: true, platform: 'win32', node: NODE, cacheDir: WIN.cacheDir,
    // 只有本机这两个路径存在才算「本机形态」
    fileExists: (p) => p === NODE.exe || p === NODE.npxCli || p === NODE.npmCli,
  };
  const foreignSpec = { command: 'C:\\Users\\other\\nodejs\\node.exe', args: ['C:\\Users\\other\\nodejs\\node_modules\\npm\\bin\\npx-cli.js', '-y', '@x/mcp'] };

  const repointed = planStdioLaunch(foreignSpec, FOREIGN);
  ok('外机路径：不再免检', repointed.reason === 'repointed', repointed.reason);
  eq('外机路径：重指到本机 node.exe', repointed.spec.command, NODE.exe);
  eq('外机路径：本机入口 JS 顶到 args[0]，包名与参数顺序不动',
    repointed.spec.args, [NODE.npxCli, '-y', '@x/mcp']);

  const same = planStdioLaunch({ command: NODE.exe, args: [NODE.npxCli, '-y', '@x/mcp'] }, FOREIGN);
  eq('本机路径确实存在：仍然免检（幂等不重复包一层）', same.reason, 'already-normalized');
  ok('本机路径免检时不动字节', same.spec.command === NODE.exe && !same.rewritten);

  // npm-cli.js 形态要指到 npm 的入口，不能被错指成 npx
  const npmShape = planStdioLaunch({ command: 'E:\\gone\\node.exe', args: ['E:\\gone\\node_modules\\npm\\bin\\npm-cli.js', 'i'] }, FOREIGN);
  eq('npm 入口形态重指到 npm-cli.js', npmShape.spec.args[0], NODE.npmCli);

  // 非 win32：本层留下的 Windows 绝对路径必须还原成裸命令，交给 PATH
  const denorm = planStdioLaunch(foreignSpec, POSIX);
  ok('非 win32：还原成裸 npx', denorm.reason === 'denormalized' && denorm.spec.command === 'npx', JSON.stringify(denorm.spec));
  eq('非 win32：还原时把本机入口 JS 摘掉，其余参数原样', denorm.spec.args, ['-y', '@x/mcp']);
  ok('非 win32：还原形态不再带别机的 npm 缓存路径',
    !JSON.stringify(denorm.spec.env || {}).includes('gone'), JSON.stringify(denorm.spec.env));

  // win32 但本机探不到 node：既不能免检，也不能凭空造路径
  const NO_LOCAL = { applicable: true, platform: 'win32', node: null, cacheDir: null, fileExists: () => false };
  const stuck = planStdioLaunch(foreignSpec, NO_LOCAL);
  eq('win32 本机无 node：不改写并给出可上报的原因', stuck.reason, 'node-not-found');
  ok('win32 本机无 node：命令原样保留（不拼没验证过的路径）', stuck.spec.command === foreignSpec.command && !stuck.rewritten);

  // 反向自测：把免检判据退回「只看形态」，外机路径必须重新被判成 already-normalized（即缺陷复现）
  const legacySkip = planStdioLaunch(foreignSpec, { applicable: true, platform: 'win32', node: NODE, cacheDir: WIN.cacheDir });
  ok('反向自测：不传 fileExists 时退回旧行为（说明存在性判定确实起作用）',
    legacySkip.reason === 'already-normalized' && repointed.reason === 'repointed', legacySkip.reason);
}

// ── 14. 提示文案只在真做过归一时出现 ──────────────────────────────────────
// describeLaunchRewrite 过去拿「提交值 ≠ 归一值 + 末段是 node」判改写是否发生过。
// 用户在编辑框里自己填 `C:\tools\wsl\node` 时（本层走 unsupported-command，压根没动它），
// note 会说成「Windows 启动器已改用本机 Node，裸 C:\tools\wsl\node 在 win32 无法 spawn」——
// 把插件没做的事说成做了，还否定了用户刚填的命令。现在判据是命令形态。
{
  ok('用户自填的 node 路径不被说成插件改写',
    describeLaunchRewrite('C:\\tools\\wsl\\node', 'D:\\nodejs\\node.exe') === '');
  ok('裸 npx 被归一才出说明', describeLaunchRewrite('npx', NODE.exe).includes('本机 Node'));
  // 反向自测：把旧判据（只看「提交值 ≠ 归一值 + 末段是 node」）照着复写一遍，
  // 它在用户自填 node 路径时必须误报——新实现同输入返回空串，两者确有差别。
  const legacyRule = (original, final) => (original && final && original !== final
    && /(?:^|[\\/])node(?:\.exe)?$/i.test(final) ? '误报' : '');
  ok('反向自测：旧判据会在用户自填 node 路径时误报（新实现不出说明）',
    legacyRule('C:\\tools\\wsl\\node', 'D:\\nodejs\\node.exe') === '误报'
    && describeLaunchRewrite('C:\\tools\\wsl\\node', 'D:\\nodejs\\node.exe') === '');
  ok('反向自测：旧判据同样会在表达式命令上误报（!!js 内部形态被露给用户）',
    legacyRule('${NODE_BIN}', '!!js (process.env.NODE_BIN ?? "")') === ''
    && describeLaunchRewrite('${NODE_BIN}', '!!js (process.env.NODE_BIN ?? "")') === '');
}

// ── 15. 降级结果不被钉死到进程结束 ────────────────────────────────────────
// 旧缓存一旦落定就再也不探：用户在会话中途装好 Node、或宿主以不同 PATH 起过，之后每一条
// 新条目都继续按第一次的失败结论处理，连报出来的原因都是过期的。
// 现在：健康结果长期缓存（探测要扫 PATH，不该压在写盘热路径上），降级结果过窗重探，
// 而 `setWin32LaunchContext` 注入的上下文视为钉住（否则前面各节「钉住上下文」的用例会
// 随运行时间飘红——本仓库踩过环境敏感这一类坑）。
// 时间靠 Date.now 偏移驱动；偏移只在本段内生效，结束时必定还原。
{
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    // 15a 健康结果：跨窗也只探一次
    resetWin32LaunchContext();
    let healthyProbes = 0;
    const healthy = () => { healthyProbes += 1; return POSIX; };
    win32LaunchContext(false, healthy);
    win32LaunchContext(false, healthy);
    offset += 10 * 60 * 1000;
    win32LaunchContext(false, healthy);
    eq('健康结果只探一次（探测不压写盘热路径）', healthyProbes, 1);

    // 15b 降级结果：窗口内不重复，过窗必须重探
    resetWin32LaunchContext();
    offset = 0;
    let degradedProbes = 0;
    const degrade = () => { degradedProbes += 1; return { applicable: true, platform: 'win32', node: null, cacheDir: null }; };
    const firstDegraded = win32LaunchContext(false, degrade);
    win32LaunchContext(false, degrade);
    eq('降级结果在窗口内不重复探测', degradedProbes, 1);
    ok('降级上下文形态如实（applicable 为真但探不到 node）',
      firstDegraded.applicable === true && !firstDegraded.node);
    offset += 61 * 1000;
    win32LaunchContext(false, degrade);
    eq('降级结果过窗后重探（中途装好 Node 能自愈，不必重启 DSH）', degradedProbes, 2);

    // 15c 抛异常降级同样要过窗重探
    resetWin32LaunchContext();
    offset = 0;
    let boomProbes = 0;
    const boom = () => { boomProbes += 1; throw new Error('EPERM: stat unavailable'); };
    win32LaunchContext(false, boom);
    offset += 61 * 1000;
    win32LaunchContext(false, boom);
    eq('抛异常降级也会过窗重探', boomProbes, 2);
    ok('重探后仍然不外抛', typeof win32LaunchContext(false, boom) === 'object');

    // 15d 注入 = 钉住：跨窗也不能被真探测顶掉
    offset = 0;
    setWin32LaunchContext(WIN);
    offset += 30 * 60 * 1000;
    const pinned = win32LaunchContext(false, () => { throw new Error('不该再探'); });
    ok('注入的上下文跨窗也不会被顶掉', pinned === WIN);
    // 降级形态的注入同样钉住（旧写法会在这里重新真探测）
    setWin32LaunchContext({ applicable: true, platform: 'win32', node: null, cacheDir: null });
    const pinnedDegraded = win32LaunchContext(false, () => { throw new Error('注入的降级不该再探'); });
    ok('注入的降级上下文也被钉住（测试口不被 TTL 顶掉）', !pinnedDegraded.node && pinnedDegraded.applicable === true);

    resetWin32LaunchContext();
    ok('reset 后回到本机真实探测且不抛', typeof win32LaunchContext().applicable === 'boolean');
  } finally {
    Date.now = realNow;
  }
  setWin32LaunchContext(POSIX);
}

// ── 16. isBlockedLaunchShape：存量裸 npx 要能被行状态看出来 ────────────────
// 归一只发生在写入边界，所以升级插件之前加下的裸 npx 条目会一直保持坏形态。
// 没有这个判据时，面板对它只剩「连接失败 + 点重连再试」，而重连不改变命令——
// 用户就在循环里打转，这正是「装上要先修但没人说修什么」的现场。
{
  const W = { platform: 'win32' };
  ok('裸 npx + stdio 在 win32 判为需修复', isBlockedLaunchShape({ command: 'npx', transport: 'stdio' }, W) === true);
  ok('裸 npm 同样判为需修复', isBlockedLaunchShape({ command: 'npm', transport: 'stdio' }, W) === true);
  ok('npx.cmd 形态同样判为需修复（大小写与路径尾段归一）',
    isBlockedLaunchShape({ command: 'C:\\Tools\\npx.CMD', transport: 'stdio' }, W) === true);
  ok('归一后的本机 node.exe 不判（那是修好的形态）',
    isBlockedLaunchShape({ command: NODE.exe, transport: 'stdio' }, W) === false);
  ok('第三方 exe 不判（不是 .cmd 壳问题）',
    isBlockedLaunchShape({ command: 'C:\\tools\\windows-mcp.exe', transport: 'stdio' }, W) === false);
  ok('node / python 等真 exe 命令不判', isBlockedLaunchShape({ command: 'node', transport: 'stdio' }, W) === false
    && isBlockedLaunchShape({ command: 'uvx', transport: 'stdio' }, W) === false);
  ok('http 传输一律不判', isBlockedLaunchShape({ command: 'npx', transport: 'http' }, W) === false);
  ok('${VAR} 表达式不判（宿主挂载时才求值，静态判不了）',
    isBlockedLaunchShape({ command: '${NODE_BIN}', transport: 'stdio' }, W) === false
    && isBlockedLaunchShape({ command: '!!js (process.env.NPX_BIN ?? "")', transport: 'stdio' }, W) === false);
  ok('非 win32 一律不判（POSIX 上裸 npx 本来就是好形态）',
    isBlockedLaunchShape({ command: 'npx', transport: 'stdio' }, { platform: 'linux' }) === false);
  ok('空行数据不抛错', isBlockedLaunchShape(null, W) === false
    && isBlockedLaunchShape({}, W) === false
    && isBlockedLaunchShape({ command: 42, transport: 'stdio' }, W) === false);
  // 反向自测：判据退回「只看命令名、不看平台」，Linux 上的裸 npx 也会被误标。
  ok('反向自测：平台这一维漏掉就会在 POSIX 上误报',
    isBlockedLaunchShape({ command: 'npx', transport: 'stdio' }, { platform: 'darwin' }) === false);
}

console.log(`\n${failures === 0 ? 'win32-stdio-launch: ALL PASS' : `win32-stdio-launch: ${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
