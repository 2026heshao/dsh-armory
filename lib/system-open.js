// 系统级「打开链接 / 定位文件」的唯一出口。
//
// 为什么单独成模块（issue #7）：headless 主机（NAS / 容器里的 `dsh web`）没有 xdg-open。
// spawn 的 ENOENT 不是同步 throw，而是异步 'error' 事件；没人监听就升级成
// uncaughtException，直接把宿主进程带走——用户看到的是「点一下安装，所有 API 502」。
// 这里等到 spawn / error 任意一个落地再返回：调用方拿到可判定的结果，也不会再有
// 「spawn 完立刻 unref、错误没人接」的写法漏进业务代码。
import { spawn } from 'node:child_process';

// 极少数平台既不回 spawn 也不回 error。不能为了一次「打开链接」卡住 RPC，按成功放行。
const LAUNCH_TIMEOUT_MS = 5000;

// 允许交给系统浏览器打开的 URL。rundll32 / open / xdg-open 收到本地路径时会直接用
// 关联程序执行（.exe / .command / .app），所以这里必须先做协议白名单：只放 https，
// http 仅限本机回环（本地开发服务）。javascript: / file: / data: 一律拒绝。
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** 是否是允许交给系统浏览器的 URL（协议白名单）。 */
export function isAllowedExternalUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return false;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
}

/** 打开 URL 的平台命令。 */
export function urlOpenCommand(target, platform = process.platform) {
  if (platform === 'win32') {
    // 绝不能用 `cmd /c start "$url"`：Node 只在参数含空格时才给参数加引号，而 URL 不含空格，
    // cmd 于是把 URL 里的 & 当成命令分隔符，授权地址被截断成 `?response_type=code`，
    // 服务器随后回 `invalid_request: client_id is required`。
    // rundll32 走 ShellExecute 且参数直传，不经 cmd 解析。
    return { command: 'rundll32', args: ['url.dll,FileProtocolHandler', target] };
  }
  return { command: platform === 'darwin' ? 'open' : 'xdg-open', args: [target] };
}

/** 在系统文件管理器中定位路径的平台命令。 */
export function pathRevealCommand(target, platform = process.platform) {
  if (platform === 'win32') return { command: 'explorer', args: ['/select,', target] };
  return { command: platform === 'darwin' ? 'open' : 'xdg-open', args: [target] };
}

function failedOutcome(command, error, logger) {
  const reason =
    error?.code === 'ENOENT'
      ? `找不到系统命令 ${command}（headless 主机通常没有桌面打开器）`
      : String(error?.message || error);
  try {
    logger?.warn?.(`[dsh-armory] 系统打开器不可用：${reason}`);
  } catch {
    /* 日志本身不该再制造一次失败 */
  }
  return { ok: false, reason, code: error?.code || '' };
}

/**
 * 启动一个分离进程，并等「确实起来了」或「确实失败了」再返回。永不 reject。
 * 成功才 unref；失败时进程根本没起来，unref 无意义。
 */
export async function launchDetached(command, args, { logger } = {}) {
  let child;
  try {
    child = spawn(command, args, { detached: true, stdio: 'ignore' });
  } catch (error) {
    return failedOutcome(command, error, logger);
  }
  const outcome = await new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    // 监听器常驻：成功之后才冒出来的 error 同样必须被吃掉，不能再回到 uncaughtException。
    child.on('error', (error) => finish(failedOutcome(command, error, logger)));
    child.once('spawn', () => finish({ ok: true }));
    timer = setTimeout(() => finish({ ok: true, timedOut: true }), LAUNCH_TIMEOUT_MS);
    timer.unref?.();
  });
  if (outcome.ok) child.unref();
  return outcome;
}

/** 用系统默认浏览器打开 URL。非白名单协议直接拒绝，不启动任何进程。 */
export function openSystemUrl(url, { logger, platform = process.platform } = {}) {
  if (!isAllowedExternalUrl(url)) {
    const reason = '只允许用系统浏览器打开 https 链接（http 仅限本机回环）';
    try {
      logger?.warn?.('[dsh-armory] 已拦截非白名单协议的打开请求');
    } catch {
      /* 日志本身不该再制造一次失败 */
    }
    return Promise.resolve({ ok: false, reason, code: 'EBADURL' });
  }
  const target = String(url).trim();
  const { command, args } = urlOpenCommand(target, platform);
  return launchDetached(command, args, { logger });
}

/** 用系统文件管理器定位路径。 */
export function revealSystemPath(path, { logger, platform = process.platform } = {}) {
  const { command, args } = pathRevealCommand(path, platform);
  return launchDetached(command, args, { logger });
}
