/**
 * Windows 下 stdio MCP 的「可执行化」——把裸 `npx` 换成真正能 spawn 的形式。
 *
 * ⚠️ 因果口径在 2026-11-06 被实测修正过，请把下面这段读完再动这一层。
 *
 * 原先写的前提是「宿主 `@deepseek-ai/dsh-mcp-client` 用 `child_process.spawn(command, args,
 * {shell:false})`，win32 Node 不做 PATHEXT 解析，所以裸 `npx`（其实是 `npx.cmd`）必然 ENOENT」。
 * 这句话的**前半不成立**：本机 `D:\Deepseek Harness\resources\app.asar`（DSH 桌面端）里
 * `StdioClientTransport.start()` 的两份构建都不是原生 spawn——
 *   · @127351635 `(0, cross_spawn.default)(this._serverParams.command, …, { shell:false, windowsHide: win32, … })`
 *   · @127357945 `spawn(this._serverParams.command, …, { shell:false, … })`，该 `spawn` 来自 `import spawn from "cross-spawn"`
 * 而 cross-spawn 的 `parse.js:29-59` 对非 `.exe/.com` 的命中会包成 `cmd.exe /d /s /c "…"`，
 * SDK 的子进程 env 白名单 `DEFAULT_INHERITED_ENV_VARS` 在 win32 下又**保留了 PATH/PATHEXT/COMSPEC**。
 *
 * 同一条命令面在 24.19.0 上的实测结果（`node -e` 逐条跑，可复现）：
 *   · `require('node:child_process').spawnSync('npx', ['--version'], {shell:false})`
 *       → **ENOENT**，与 PATHEXT 有无、`.CMD` 排在第几、PATHEXT 空串全部无关（5 种组合都 ENOENT）
 *   · `require('cross-spawn')('npx', ['--version'], {shell:false})`
 *       → **exit 0**，输出 npm 版本号
 *   · `spawnSync('npx', …, {shell:false, cwd:'<不存在的目录>'})` → **ENOENT**（← 与命令形态无关的那一类）
 *   · `spawnSync('npx', …, {shell:false, env:{PATH:'C:\\Windows\\system32'}})` → 找不到命令（← PATH 被剥的那一类）
 *   · 原生 spawn `npx.cmd`（显式带扩展名）→ **EINVAL**（Node 的 .bat/.cmd 门槛）
 *
 * 所以：**这一层改的是「命令形态」，但它治的不是「`.cmd` 一定 spawn 不了」**。当年本机那次
 * 「6ms 就 ENOENT、面板只剩 SdkError: Connection closed」的现场，用上面第二组实验复现不出；
 * 能复现出 ENOENT 的是另外两条路径——`cwd` 指向不存在的目录，以及父进程 PATH 里根本没有
 * node 目录（volta / scoop / pnpm 托管、服务模式启动不继承登录 PATH、装完 Node 没重启宿主）。
 * 归一成「绝对 node.exe + 入口 JS」对这两条**同样有效**（绝对 exe 不依赖 which 解析，
 * `node.exe x-cli.js` 也不依赖 PATHEXT），所以这一层保留；但请把它当成「提高鲁棒性」的处理，
 * 不要当成根因结论——尤其不要据此向用户承诺「Windows 上裸 npx 一定连不上」。
 * 要在真宿主上定案，做的是这件事：在 DSH 里加一条 `command: npx` 的连接器，观察宿主日志里
 * 该次的 ENOENT 是否随 `cwd` 有效性与宿主进程 PATH 变化，而不是再看这段注释。
 *
 * 本层职责（只改命令形态，不改语义）：`npx -y pkg` → `node.exe npx-cli.js -y pkg`，
 * 参数顺序、包名、附加参数一律原样保留；非 win32、绝对路径、`${VAR}` / `!!js` 表达式全部放行不改。
 * 改写是幂等的：改写后的绝对 node.exe 再进这里不会被二次包装，读回配置也不会漂移——
 * 但「形态像归一产物」不等于「本机可用」，路径不在这台机器上时走 repointNormalized 重指/还原。
 *
 * 顺带处理第二道独立的拦路石（这条是真实测到的）：本机全局 npm 缓存目录不可写时，
 * `npx -y <pkg>` 会在下载阶段 `EPERM` 失败——spawn 已经成功，但包拿不下来。所以为改写过的
 * 条目注入一个属于军械库的可写缓存目录；用户自己配过缓存键时绝不覆盖。
 *
 * 边界：`uvx` / `uv` 在 Windows 上是真 `.exe`（astral 直接发二进制），不属于 `.cmd` 壳问题，
 * 本机又未安装 uv，无法实测 → 本层不动它，避免把没验证过的路径写成规则。
 */
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
 * 「这条 stdio 条目在本机的命令形态起不来」判定——给行状态用，纯函数、可注入平台。
 *
 * 为什么需要它：归一只发生在**写入边界**，所以升级插件之前加下的裸 `npx` 条目会一直保持
 * 那个形态；面板过去对它只能说「连接失败（点重连再试）」，而重连改变的只是连接，不是命令，
 * 用户就在「重连—还是失败」里循环——这正是「装上之后要先修，但没人说修什么」的现场。
 * 表达式形态（`!!js` / `${VAR}`）由宿主在挂载时求值，静态判不了，一律不标。
 *
 * @param {{command?:unknown, transport?:string}} row 行数据（只读）
 * @param {{platform?:string}} [options]
 * @returns {boolean}
 */
export function isBlockedLaunchShape(row, options = {}) {
  if (!isObject(row)) return false;
  if ((options.platform ?? process.platform) !== 'win32') return false;
  if (row.transport !== undefined && row.transport !== 'stdio') return false;
  const command = typeof row.command === 'string' ? row.command.trim() : '';
  if (!command) return false;
  if (EXPRESSION_RE.test(command) || command.startsWith('!!js')) return false;
  return isCmdShellCommand(command);
}

/** 归一层产物里的入口脚本形态：`npx-cli.js` / `npm-cli.js`。 */
const CLI_ARG_RE = /(?:npx|npm)-cli\.js$/i;

/** 形态上就是本层写出去的样子（绝对或裸 node + 某个 *-cli.js）。 */
function looksNormalized(command, args) {
  return (commandBase(command) === 'node' || ABSOLUTE_RE.test(command))
    && args.some((arg) => typeof arg === 'string' && CLI_ARG_RE.test(arg));
}

/**
 * 归一形态是不是「本机真能起来」的形态。
 * `fileExists` 缺省视为成立（保持纯函数默认行为与既有单测口径）；只有真实探测上下文会传入。
 * 裸 `node`（非绝对路径）不参与判定——那是 PATH 上的正常形态，没有过期一说。
 */
function normalizedPathsExist(command, args, fileExists) {
  if (typeof fileExists !== 'function') return true;
  if (!ABSOLUTE_RE.test(command)) return true;
  if (!fileExists(command)) return false;
  const cli = args.find((arg) => typeof arg === 'string' && CLI_ARG_RE.test(arg));
  return !cli || fileExists(cli);
}

/** 按上下文注入军械库可写 npm 缓存（用户自己配过同名键时任意大小写都不覆盖）。 */
function withCacheEnv(target, context) {
  if (!context.cacheDir) return target;
  const env = isObject(target.env) ? { ...target.env } : {};
  const hasCacheKey = Object.keys(env).some((key) => key.toLowerCase() === 'npm_config_cache');
  if (hasCacheKey) return target;
  return { ...target, env: { ...env, npm_config_cache: context.cacheDir } };
}

/**
 * 形态是本层写出去的，但路径不在这台机器上（跨机导入、Node 换位安装、或换到非 win32）
 * 时的修复方向。
 *
 * 2026-11-06 复核出的缺口：旧实现只看形态、不看存在性，于是别的机器写进来的
 * `C:\Users\A\...\node.exe + npx-cli.js` 在 B 机被判「已归一、无需处理」——既不改写也不提示，
 * 用户拿到的是一条注定 spawn 不了的条目；同一份文件挪到 mac/Linux 时，Windows 绝对路径
 * 也永远不会被还原。而 whats-new 承诺的补救「重新加入 MCP」在代码里走不通（同名直接
 * `MCP already exists`，必须先删再增，界面没这么说）。
 * 现在两种情况都有明确去向：win32 重指到本机探测到的启动器，其余平台还原成裸 `npx`/`npm`
 * 交给 PATH——那是可移植形态，也是宿主 cross-spawn 能正确包装的形态。
 */
function repointNormalized(spec, inArgs, context) {
  const cliIndex = inArgs.findIndex((arg) => typeof arg === 'string' && CLI_ARG_RE.test(arg));
  const cliArg = String(inArgs[cliIndex] ?? '');
  const isNpm = /npm-cli\.js$/i.test(cliArg);
  const rest = inArgs.filter((arg, index) => index !== cliIndex && typeof arg === 'string');
  if (context.applicable !== true) {
    return {
      spec: withCacheEnv({ ...spec, command: isNpm ? 'npm' : 'npx', args: rest }, context),
      rewritten: true,
      reason: 'denormalized',
    };
  }
  const node = isObject(context.node) ? context.node : null;
  const cli = node ? (isNpm ? node.npmCli : node.npxCli) : '';
  // 本机也探不到可用启动器：宁可不改，也不能拼一个没验证过的路径出去写盘。
  if (!node || !node.exe || !cli) return { spec, rewritten: false, reason: 'node-not-found' };
  return {
    spec: withCacheEnv({ ...spec, command: node.exe, args: [cli, ...rest] }, context),
    rewritten: true,
    reason: 'repointed',
  };
}

/**
 * 纯函数：按注入的上下文决定这条 stdio spec 该怎么写。
 * 不做任何 fs / process 访问，便于零成本单测与跨平台运行（存在性判定由 context 注入）。
 *
 * @param {{command:string,args?:string[],env?:object}} spec 已归一化的 stdio spec（就地不改，返回新对象）
 * @param {{applicable?:boolean,node?:{exe:string,npxCli:string,npmCli:string}|null,cacheDir?:string|null,fileExists?:(path:string)=>boolean}} context
 * @returns {{spec:object, rewritten:boolean, reason:string}}
 *   reason: 'not-win32' | 'not-stdio-command' | 'expression' | 'already-normalized'
 *         | 'already-absolute' | 'unsupported-command' | 'node-not-found'
 *         | 'rewritten' | 'repointed' | 'denormalized'
 */
export function planStdioLaunch(spec, context = {}) {
  if (!isObject(spec) || typeof spec.command !== 'string' || !spec.command.trim()) {
    return { spec, rewritten: false, reason: 'not-stdio-command' };
  }
  // 表达式（`${NODE_BIN}`、`!!js …`）由宿主在挂载时求值，形态我们无法静态判定 → 放行。
  if (EXPRESSION_RE.test(spec.command)) return { spec, rewritten: false, reason: 'expression' };
  const inArgs = Array.isArray(spec.args) ? spec.args : [];
  // 幂等护栏：已经是「本机 node.exe + 本机 npx-cli.js」形态的不再包第二层（读回配置、
  // 反复保存、项目 MCP 重挂都会重新走这里）。形态像但路径不在本机 = 过期，不是已归一。
  if (looksNormalized(spec.command, inArgs)) {
    if (context.applicable === true && normalizedPathsExist(spec.command, inArgs, context.fileExists)) {
      return { spec, rewritten: false, reason: 'already-normalized' };
    }
    return repointNormalized(spec, inArgs, context);
  }
  // 非 win32 一律不介入（上面那条只处理「本层自己留下的形态」的还原）。
  // 裸 npx / npm 在 POSIX 上本来就是可 spawn 的正确形态，不该被改成任何本机路径。
  if (context.applicable !== true) return { spec, rewritten: false, reason: 'not-win32' };
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
  canWrite = defaultCanWrite,
} = {}) {
  if (platform !== 'win32') return { applicable: false, platform, node: null, cacheDir: null };
  // 存在性判定交给 planStdioLaunch：归一形态里那两个路径必须真的在这台机器上存在，
  // 否则那是别的机器留下的形态（跨机导入 / Node 换位），得重指而不是当成已归一。
  const probe = (value) => (typeof value === 'string' && value ? isFile(value) : false);
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
      return { applicable: true, platform, node: { exe, npxCli, npmCli }, cacheDir: armoryNpmCacheDir(home, mkDir, canWrite), fileExists: probe };
    }
    if (!fallback) fallback = { exe, npxCli: isFile(npxCli) ? npxCli : '', npmCli: isFile(npmCli) ? npmCli : '' };
  }
  return { applicable: true, platform, node: fallback, cacheDir: armoryNpmCacheDir(home, mkDir, canWrite), fileExists: probe };
}

/**
 * 军械库专用 npm 缓存目录；建不出来**或建出来写不进去**都返回 null
 * （不注入，保持原样而不是指向一个坏路径）。
 *
 * 为什么要单独探一次可写：`mkdir(recursive)` 对「目录已存在」一律成功，哪怕它是只读的
 * （上一版就在这里把一条写不进去的路径注入成了 `npm_config_cache`）——npx 下载阶段照旧
 * EPERM，而且比不注入更难排查：用户看到的是"这个包装不上"，不是"缓存目录不可写"。
 * 探法用真写一个探针文件再删掉，不用 `access(W_OK)`：Windows 上后者只看只读属性，
 * 对 ACL 拒绝写的目录会给出乐观答案。
 */
function armoryNpmCacheDir(home, mkDir, canWrite) {
  if (typeof home !== 'string' || !home) return null;
  const dir = winpath.join(home, '.dsh', 'armory', 'mcp-npm-cache');
  try {
    mkDir(dir, { recursive: true });
  } catch {
    return null;
  }
  if (!canWrite(dir)) return null;
  return dir;
}

/** 默认可写探针：真写一个点文件再删掉；任何一步失败都算不可写。 */
function defaultCanWrite(dir) {
  const probe = winpath.join(dir, '.armory-write-probe');
  try {
    writeFileSync(probe, 'probe');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

let cachedContext;
let cachedAt = 0;
let cachedIsInjected = false;
/** 降级结果只保留这么久：装完 Node / 修好 PATH 后不必重启 DSH 也能自愈。 */
const DEGRADED_RETRY_MS = 60 * 1000;

/** 探测结果是否不可用（抛异常降级，或 win32 上压根没探到 node.exe）。 */
function isDegradedContext(context) {
  if (!context) return true;
  if (context.probeError) return true;
  if (context.applicable === true && (!context.node || !context.node.exe)) return true;
  return false;
}

/**
 * 进程内缓存的启动器上下文（首次用到才探测；探测失败不重试到写盘热路径上）。
 *
 * 这里的 try/catch 是**窄闸门**，不是兜底吞异常：本函数站在「加入 MCP」的唯一写入路径上，
 * 探测层任何未预见的异常都不该让用户的添加动作整体失败。降级方向是回到修复前的行为
 * （不改写、原样写入），并把降级原因如实带在 `probeError` 上交给调用方上报，
 * 而不是静默成「这条不需要归一」。
 *
 * 健康结果长期缓存（探测要扫 PATH，不该压在写盘热路径上）；**降级结果过窗重探**：
 * 以前一次失败就钉死到进程结束——用户中途装好 Node、或宿主以不同 PATH 起过，
 * 之后每一条新条目都继续按第一次的失败结论处理，连报出来的原因都是过期的。
 */
export function win32LaunchContext(force = false, detect = detectWin32LaunchContext) {
  const degradedStale = cachedContext !== undefined && !cachedIsInjected
    && isDegradedContext(cachedContext) && Date.now() - cachedAt > DEGRADED_RETRY_MS;
  if (cachedContext === undefined || force === true || degradedStale) {
    cachedAt = Date.now();
    cachedIsInjected = false;
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
  // 注入即钉住：测试里「把归一层显式关掉/打开」的语义不能被过期重探顶掉，
  // 否则同一份用例会在长跑或跨窗时飘红（本仓库踩过「纯解析套件变环境敏感」这一类坑）。
  cachedIsInjected = true;
  cachedAt = Date.now();
}

export function resetWin32LaunchContext() {
  cachedContext = undefined;
  cachedAt = 0;
  cachedIsInjected = false;
}

/**
 * 给用户看的改写说明：只比较「进」与「出」的命令，不往 spec 上挂任何多余字段
 * （多余字段会被 workspace 配置序列化进 .dsh/mcp.json，污染用户文件）。
 *
 * 2026-11-06 起生产路径不再调用它：写入边界已把真实判定（`planStdioLaunch` 的 reason）
 * 放进 warnings，字符串猜测反而会误报——用户在编辑框里自己填 `C:\tools\wsl\node` 时
 * 「提交值 ≠ 归一值 + 末段是 node」同样成立，note 会把插件没做的事说成做了，还否定
 * 用户刚填的命令。现在判据先问「进来那条是不是 npm 的 `.cmd` 壳」。
 * 保留导出仅为兼容既有单测与外部调用方。
 */
export function describeLaunchRewrite(originalCommand, finalCommand) {
  if (typeof originalCommand !== 'string' || typeof finalCommand !== 'string') return '';
  const original = originalCommand.trim();
  const final = finalCommand.trim();
  if (!original || !final || original === final) return '';
  // 表达式命令（${VAR} / !!js）由宿主求值，本层不会改写；normalizeEntry 会把
  // `${VAR}` 转成内部 `!!js ...`，字符串比较因此会误报「已改用本机 Node」并把
  // 内部表示露给用户。
  if (EXPRESSION_RE.test(original) || /^\s*!!js\b/.test(final)) return '';
  // 只有「进来是 .cmd 壳、出去是本机 node 启动器」才是本层干的活。
  if (!isCmdShellCommand(original)) return '';
  if (!/(?:^|[\\/])node(?:\.exe)?$/i.test(final)) return '';
  return `；Windows 启动器已改用本机 Node（${final}），裸 ${original} 在 win32 无法 spawn`;
}
