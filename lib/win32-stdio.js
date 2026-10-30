/**
 * Windows 下 stdio MCP 的「可执行化」——把裸 `npx` 换成真正能 spawn 的形式。
 *
 * 为什么需要这一层（2026-10-30 本机实测，不是推测）：
 *   宿主 `@deepseek-ai/dsh-mcp-client` 用 `child_process.spawn(command, args, { shell: false })`
 *   拉起 stdio 子进程。win32 上 Node 不做 PATHEXT 解析，而 npm 的 `npx` 实际是 `npx.cmd`
 *   （批处理壳，必须经 cmd.exe 才有解释器）：
 *     - spawn('npx', …, {shell:false})   → ENOENT，实测 6ms 内子进程根本没起来
 *     - spawn('npx.cmd', …, {shell:false}) → EINVAL（Node ≥ 24 明确拒绝直接 spawn .cmd）
 *   子进程起不来 → stdin/stdout 管道立刻关闭 → SDK 侧只剩一句
 *   `SdkError: Connection closed`，再按 `reconnect.maxAttempts: 10` 重试到耗尽，面板永久「连接失败」。
 *   官方 MCP Registry 的 npm 条目给出的命令恰恰就是裸 `npx`，所以 Windows 上「社区 MCP 选哪一条都连不上」
 *   与条目本身无关，是命令形态问题。同机唯一两条能连上的（mcp-windows / mcp-rea）都是绝对 `.exe`——
 *   CreateProcess 对无扩展名的命令只补 `.exe`，所以裸 `node` / `python` 反而没事，出事的是 `.cmd` 壳。
 *
 * 这一层只改**命令形态**，不改语义：`npx -y pkg` → `node.exe npx-cli.js -y pkg`，
 * 参数顺序、包名、附加参数一律原样保留；非 win32、绝对路径、`${VAR}` / `!!js` 表达式全部放行不改。
 * 改写是幂等的：改写后的绝对 node.exe 再进这里不会被二次包装，读回配置也不会漂移。
 *
 * 顺带处理第二层拦路石（同样实测）：本机全局 npm 缓存目录不可写时，`npx -y <pkg>` 会在
 * 下载阶段 `EPERM` 失败——spawn 已经成功，但包拿不下来。所以为改写过的条目注入一个
 * 属于军械库的可写缓存目录；用户自己配过缓存键时绝不覆盖。
 *
 * 边界：`uvx` / `uv` 在 Windows 上是真 `.exe`（astral 直接发二进制），不属于 `.cmd` 壳问题，
 * 本机又未安装 uv，无法实测 → 本层不动它，避免把没验证过的路径写成规则。
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { win32 as winpath } from 'node:path';
import { homedir } from 'node:os';

/** 会被 npm 装成 `.cmd` 壳、因而 spawn 不了的命令名。 */
const CMD_SHELL_COMMANDS = new Set(['npx', 'npm']);
/** `.cmd` 壳 → 同目录 npm 包里的真正入口 JS。 */
const LAUNCHER_ENTRY = { npx: 'npx-cli.js', npm: 'npm-cli.js' };
/** 交给宿主求值的表达式命令：形态不是我们能静态决定的，禁止改写。 */
const EXPRESSION_RE = /^\s*(?:!!js\b|\$\{)/;
/** 绝对路径 / UNC / 带引号的路径：本来就可 spawn。 */
const ABSOLUTE_RE = /^\s*"?\s*(?:[A-Za-z]:[\\/]|\\\\|\/)/;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 取命令尾段并小写：`C:\a\b\npx.cmd` 与 `npx` 都归到 `npx`。 */
export function commandBase(command) {
  if (typeof command !== 'string') return '';
  const text = command.trim().replace(/^"|"$/g, '');
  const segments = text.split(/[\\/]/).filter(Boolean);
  const tail = (segments.length ? segments[segments.length - 1] : text).toLowerCase();
  return tail.replace(/\.exe$/, '').replace(/\.cmd$/, '');
}

/** 这条命令是不是 npm 装出来的 `.cmd` 壳（探测失败时要不要提醒，就按这个判）。 */
export function isCmdShellCommand(command) {
  return CMD_SHELL_COMMANDS.has(commandBase(command));
}

/**
 * 纯函数：按注入的上下文决定这条 stdio spec 该怎么写。
 * 不做任何 fs / process 访问，便于零成本单测与跨平台运行。
 *
 * @param {{command:string,args?:string[],env?:object}} spec 已归一化的 stdio spec（就地不改，返回新对象）
 * @param {{applicable?:boolean,node?:{exe:string,npxCli:string}|null,cacheDir?:string|null}} context
 * @returns {{spec:object, rewritten:boolean, reason:string}}
 *   reason: 'not-win32' | 'not-stdio-command' | 'expression' | 'already-normalized'
 *         | 'already-absolute' | 'unsupported-command' | 'node-not-found' | 'rewritten'
 */
export function planStdioLaunch(spec, context = {}) {
  if (!isObject(spec) || typeof spec.command !== 'string' || !spec.command.trim()) {
    return { spec, rewritten: false, reason: 'not-stdio-command' };
  }
  if (context.applicable !== true) return { spec, rewritten: false, reason: 'not-win32' };
  // 表达式（`${NODE_BIN}`、`!!js …`）由宿主在挂载时求值，形态我们无法静态判定 → 放行。
  if (EXPRESSION_RE.test(spec.command)) return { spec, rewritten: false, reason: 'expression' };
  const inArgs = Array.isArray(spec.args) ? spec.args : [];
  // 幂等护栏：已经是「node.exe + …/npx-cli.js」或「裸 node + …/npx-cli.js」形态的，不再包第二层
  // （读回配置、反复保存、项目 MCP 重挂都会重新走一遍这里）。
  if ((commandBase(spec.command) === 'node' || ABSOLUTE_RE.test(spec.command))
    && inArgs.some((arg) => typeof arg === 'string' && /(?:npx|npm)-cli\.js$/i.test(arg))) {
    return { spec, rewritten: false, reason: 'already-normalized' };
  }
  const base = commandBase(spec.command);
  if (!CMD_SHELL_COMMANDS.has(base)) {
    // 绝对路径本来就是我们要的样子；其余（node / python / 自定义 exe）走 CreateProcess 的 .exe 补齐。
    if (ABSOLUTE_RE.test(spec.command)) return { spec, rewritten: false, reason: 'already-absolute' };
    return { spec, rewritten: false, reason: 'unsupported-command' };
  }
  const node = isObject(context.node) ? context.node : null;
  const entry = LAUNCHER_ENTRY[base];
  if (!node || !node.exe || (entry === 'npx-cli.js' && !node.npxCli)) {
    // 找不到本机 Node：宁可不改。改写成一个不存在的路径会把「连不上」换成更难的「找不到文件」。
    return { spec, rewritten: false, reason: 'node-not-found' };
  }
  // 入口 JS 必须是探测到的真实路径；缺了就当找不到，绝不拼一个没验证过的路径出去写盘。
  const cli = entry === 'npx-cli.js' ? node.npxCli : node.npmCli;
  if (!cli) return { spec, rewritten: false, reason: 'node-not-found' };
  const args = inArgs.filter((item) => typeof item === 'string');
  const next = { ...spec, command: node.exe, args: [cli, ...args] };
  if (context.cacheDir) {
    const env = isObject(spec.env) ? { ...spec.env } : {};
    // 用户显式配过缓存（任意大小写）时以用户为准，不覆盖。
    const hasCacheKey = Object.keys(env).some((key) => key.toLowerCase() === 'npm_config_cache');
    if (!hasCacheKey) env.npm_config_cache = context.cacheDir;
    if (Object.keys(env).length) next.env = env;
  }
  return { spec: next, rewritten: true, reason: 'rewritten' };
}

/**
 * 探测本机 Node 启动器。所有输入均可注入，便于在任意平台上跑同一份逻辑。
 * 只在 win32 返回 applicable:true；其余平台一律 applicable:false（本层完全不介入）。
 */
export function detectWin32LaunchContext({
  platform = process.platform,
  env = process.env,
  home = homedir(),
  exists = existsSync,
  isFile = (value) => {
    try {
      return statSync(value).isFile();
    } catch {
      return false;
    }
  },
  mkDir = mkdirSync,
} = {}) {
  if (platform !== 'win32') return { applicable: false, platform, node: null, cacheDir: null };
  const rawPath = env.PATH || env.Path || env.path || '';
  const dirs = rawPath.split(';').map((dir) => dir.trim()).filter(Boolean);
  let fallback = null;
  for (const dir of dirs) {
    const exe = winpath.join(dir, 'node.exe');
    if (!isFile(exe)) continue;
    const npmBin = winpath.join(dir, 'node_modules', 'npm', 'bin');
    const npxCli = winpath.join(npmBin, 'npx-cli.js');
    const npmCli = winpath.join(npmBin, 'npm-cli.js');
    if (isFile(npxCli) && isFile(npmCli)) {
      // 同目录成对命中：这是官方安装包的标准布局，优先采用。
      return { applicable: true, platform, node: { exe, npxCli, npmCli }, cacheDir: armoryNpmCacheDir(home, mkDir) };
    }
    if (!fallback) fallback = { exe, npxCli: isFile(npxCli) ? npxCli : '', npmCli: isFile(npmCli) ? npmCli : '' };
  }
  return { applicable: true, platform, node: fallback, cacheDir: armoryNpmCacheDir(home, mkDir) };
}

/** 军械库专用 npm 缓存目录；建不出来就返回 null（不注入，保持原样而不是指向一个坏路径）。 */
function armoryNpmCacheDir(home, mkDir) {
  if (typeof home !== 'string' || !home) return null;
  const dir = winpath.join(home, '.dsh', 'armory', 'mcp-npm-cache');
  try {
    mkDir(dir, { recursive: true });
  } catch {
    return null;
  }
  return dir;
}

let cachedContext;

/**
 * 进程内缓存的启动器上下文（首次用到才探测；探测失败不重试到写盘热路径上）。
 *
 * 这里的 try/catch 是**窄闸门**，不是兜底吞异常：本函数站在「加入 MCP」的唯一写入路径上，
 * 探测层任何未预见的异常都不该让用户的添加动作整体失败。降级方向是回到修复前的行为
 * （不改写、原样写入），并把降级原因如实带在 `probeError` 上交给调用方上报，
 * 而不是静默成「这条不需要归一」。
 */
export function win32LaunchContext(force = false, detect = detectWin32LaunchContext) {
  if (cachedContext === undefined || force === true) {
    try {
      cachedContext = detect();
    } catch (error) {
      cachedContext = { applicable: false, platform: process.platform, node: null, cacheDir: null, probeError: String(error?.message || error) };
    }
  }
  return cachedContext;
}

/** 测试与热修入口：注入假上下文 / 清空缓存。 */
export function setWin32LaunchContext(value) {
  cachedContext = value;
}

export function resetWin32LaunchContext() {
  cachedContext = undefined;
}

/**
 * 给用户看的改写完说明：只比较「进」与「出」的命令，不往 spec 上挂任何多余字段
 * （多余字段会被 workspace 配置序列化进 .dsh/mcp.json，污染用户文件）。
 */
export function describeLaunchRewrite(originalCommand, finalCommand) {
  if (typeof originalCommand !== 'string' || typeof finalCommand !== 'string') return '';
  if (originalCommand.trim() === finalCommand.trim()) return '';
  return `；Windows 启动器已改用本机 Node（${finalCommand}），裸 ${originalCommand.trim()} 在 win32 无法 spawn`;
}
