// 社区 MCP 数据层：官方 MCP Registry（registry.modelcontextprotocol.io）只读取数。
//
// 边界（与 lib/wb-awesome-market.js 同一纪律）：
//   - 纯数据层：取数、映射、过滤、内存缓存；**不写配置、不执行任何命令、不知道浏览器存在**。
//   - 源 URL 只活在本文件的 MCP_REGISTRY_SOURCES 里，禁止第二处硬编码。
//   - 测试通过 options.fetchImpl / options.now 注入，零真实网络。
//
// 为什么不做全量快照：实测 60 页 × 100 = 6000 条仍未翻完、逐页约 2.4s。社区列表按
// 「首屏 + 搜索 + 游标翻页」按需取，与 SkillHub 的远程分页同构；数据层只负责一次
// 游标请求的映射，累计条数上限由面板侧控制。
//
// 安全底线：只 GET；不探测 npm 包、不跑 npx/uvx；env 的 default 原样展示、绝不落盘。

export const MCP_REGISTRY_SOURCES = [
  'https://registry.modelcontextprotocol.io/v0/servers',
];

/** Registry 单页上限（实测 1000 → 422，100 是服务端接受的最大值）。 */
export const COMMUNITY_PAGE_LIMIT = 100;
/** 单次请求超时；失败只重试 1 次，且仅限网络错误与 5xx（4xx 直接放弃）。 */
const FETCH_TIMEOUT_MS = 15_000;
/** 内存缓存：key = search|cursor|limit，TTL 5 分钟，最多 50 条（先进先出）。 */
const CACHE_TTL_MS = 5 * 60_000;
const CACHE_MAX_ENTRIES = 50;
/** description 截断长度（卡片里只做一行摘要，完整说明留给上游仓库）。 */
const DESCRIPTION_MAX = 200;
/** registry 官方元信息键：status 非 active 的条目一律丢弃（下架 / 弃用）。 */
const REGISTRY_META_KEY = 'io.modelcontextprotocol.registry/official';
/** 视为「社区提交」的命名空间前缀；其余（ac.*、com.*、无斜杠）按厂商/官方处理。 */
const COMMUNITY_NAMESPACES = ['io.github.', 'io.gitlab.', 'io.bitbucket.'];
/** serverName 净化：尾段只保留小写字母、数字、连字符与下划线。 */
const SERVER_NAME_SAFE = /[^a-z0-9\-_]+/g;
const SERVER_NAME_MAX = 60;

const cache = new Map();

const asString = (value) => (typeof value === 'string' ? value : '');
const asArray = (value) => (Array.isArray(value) ? value : []);

function truncate(text, max = DESCRIPTION_MAX) {
  const value = String(text || '');
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

/**
 * 仓库地址只放行 https。Registry 条目由社区提交，`javascript:` / `file:` 进 href
 * 会在点击时执行或打开本地文件；不合法时归空串，卡片上就不渲染「仓库」按钮。
 */
export function safeRepoUrl(value) {
  const text = asString(value).trim();
  if (!text) return '';
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

/**
 * 从仓库地址解析 GitHub owner（头像 / 卡片副标题用）。
 * 只认 github.com 的公开路径；解析不出返回空串，绝不猜。
 */
export function parseGithubOwner(url) {
  const match = /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)/i.exec(String(url || ''));
  return match && match[1] ? match[1] : '';
}

/**
 * serverName 净化与冲突后缀：name 尾段 → [a-z0-9-_]，与已装条目冲突时追加 -2、-3。
 * 数据层只做净化与后缀，不读宿主状态（takenNames 由调用方传入）。
 */
export function sanitizeServerName(raw, takenNames = []) {
  // 尾部斜杠（真实条目里出现过）不能让尾段变成空串：先剥掉分隔符再取最后一段。
  const segments = String(raw || '').split('/').filter(Boolean);
  const tail = segments.length ? segments[segments.length - 1] : '';
  let base = tail.toLowerCase().replace(SERVER_NAME_SAFE, '-').replace(/^-+|-+$/g, '').slice(0, SERVER_NAME_MAX);
  if (!base) base = 'mcp-server';
  const taken = new Set(asArray(takenNames).map((name) => String(name || '').toLowerCase()).filter(Boolean));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** runtimeArguments / packageArguments 的取值顺序：value 数组按原顺序（`-y` 必须在包名前）。 */
function argumentValues(list) {
  return asArray(list)
    .filter((item) => item && typeof item === 'object' && typeof item.value === 'string' && item.value)
    .map((item) => item.value);
}

/** 运行命令：优先 runtimeHint，其次按 registryType 推断；无法确定返回空串。 */
function commandForPackage(pkg) {
  const hint = asString(pkg?.runtimeHint).toLowerCase();
  // 只收能直接执行的 npx / uvx。docker 需要 `run -i --rm` 等一整套参数，注册表条目
  // 的 runtimeArguments 并不保证带全；按 v1 口径（oci 也不支持）宁可丢弃，也不生成
  // 「看着可装、点下去跑不起来」的卡片。
  if (hint === 'npx' || hint === 'uvx') return hint;
  const registryType = asString(pkg?.registryType).toLowerCase();
  if (registryType === 'npm') return 'npx';
  if (registryType === 'pypi') return 'uvx';
  return '';
}

/** 环境变量逐项映射：isRequired / isSecret / default 原样带出，值永不落盘。 */
function envForPackage(pkg) {
  return asArray(pkg?.environmentVariables)
    .filter((row) => row && typeof row === 'object' && typeof row.name === 'string' && row.name)
    .map((row) => ({
      name: row.name,
      required: row.isRequired === true,
      secret: row.isSecret === true,
      description: asString(row.description),
      default: row.default === undefined || row.default === null ? '' : String(row.default),
      hasDefault: row.default !== undefined && row.default !== null,
    }));
}

/**
 * 官方 Registry 条目 → 面板行。
 *
 * 入参兼容两种形态：`{ server, _meta }`（真实响应）或 server 本体。
 * 返回 null = 该条不可用（缺 name / 非 active / oci 包 / 既无 stdio 包也无远程地址）。
 *
 * 参数顺序钉死为 runtimeArguments → identifier → packageArguments：
 * 真实条目里 `-y` 是 runtimeArgument，必须排在包名之前，反了就变成 `pkg -y`。
 */
export function mapRegistryServer(entry, options = {}) {
  const server = entry && typeof entry === 'object' && entry.server && typeof entry.server === 'object'
    ? entry.server
    : entry;
  if (!server || typeof server !== 'object') return null;
  const name = asString(server.name).trim();
  if (!name) return null;
  const meta = entry?._meta?.[REGISTRY_META_KEY];
  const status = meta && typeof meta.status === 'string' ? meta.status : 'active';
  if (status !== 'active') return null;

  const packages = asArray(server.packages).filter((pkg) => pkg && typeof pkg === 'object');
  const remotes = asArray(server.remotes).filter((remote) => remote && typeof remote === 'object');
  const pkg = packages[0];
  // v1 不支持 docker 映射：oci 包生成出来的配置跑不起来，直接丢弃。
  if (pkg && asString(pkg.registryType).toLowerCase() === 'oci') return null;

  const command = pkg ? commandForPackage(pkg) : '';
  const transportType = asString(pkg?.transport?.type).toLowerCase();
  const runnable = Boolean(pkg && command && transportType === 'stdio');
  // 只收 DSH 真正支持的远程传输（streamable-http；缺 type 按 streamable-http 处理，
  // 与 lib/wb-market.js 的安装判定同口径）。sse / ws 会被宿主 add 直接拒绝，
  // 不能为了「有链接」把它标成 http 塞进列表。
  const remote = remotes.find((entry) => {
    const type = asString(entry?.type).toLowerCase();
    return (type === '' || type === 'http' || type === 'streamable-http' || type === 'streamablehttp')
      && Boolean(asString(entry?.url));
  });
  const remoteUrl = remote ? asString(remote.url) : '';
  // 既跑不起来也连不上：卡片上没有可执行的下一步，不进列表。
  if (!runnable && !remoteUrl) return null;

  const env = pkg ? envForPackage(pkg) : [];
  const identifier = asString(pkg?.identifier);
  const args = pkg
    ? [...argumentValues(pkg.runtimeArguments), identifier, ...argumentValues(pkg.packageArguments)].filter(Boolean)
    : [];
  const repoUrl = safeRepoUrl(server.repository?.url);
  const takenNames = asArray(options.takenNames);

  return {
    key: name,
    name,
    title: asString(server.title).trim() || name.split('/').pop() || name,
    description: truncate(server.description),
    version: asString(server.version),
    owner: parseGithubOwner(repoUrl),
    repoUrl,
    runnable,
    transport: runnable ? 'stdio' : 'http',
    serverName: sanitizeServerName(name, takenNames),
    command: runnable ? command : '',
    args: runnable ? args : [],
    env,
    remoteUrl,
    requiresToken: env.some((row) => row.required) || (!runnable && Boolean(remoteUrl)),
    official: !COMMUNITY_NAMESPACES.some((prefix) => name.toLowerCase().startsWith(prefix)),
  };
}

/** 本地过滤：只保留可直接运行（npx / uvx）的条目。纯函数，不发请求。 */
export function filterCommunityRows(rows, options = {}) {
  const list = asArray(rows).filter(Boolean);
  if (options.onlyRunnable === false) return list;
  return list.filter((row) => row.runnable);
}

/**
 * 响应防御式归一：`servers` 非数组归空、`nextCursor` 非字符串归 null。
 * 未知字段一律忽略（Registry 仍是 v0，字段可能升级）。
 */
export function normalizeRegistryResponse(raw) {
  const servers = raw && Array.isArray(raw.servers) ? raw.servers : [];
  const cursor = raw && raw.metadata && typeof raw.metadata.nextCursor === 'string' && raw.metadata.nextCursor
    ? raw.metadata.nextCursor
    : null;
  return { servers, nextCursor: cursor };
}

/** limit 钳制：非法 / < 1 → 1，> 100 → 100。 */
function clampLimit(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return COMMUNITY_PAGE_LIMIT;
  return Math.min(COMMUNITY_PAGE_LIMIT, Math.max(1, Math.floor(number)));
}

/** 拼请求地址：cursor 必须经 URLSearchParams 编码（游标里含 `:` 与 `/`）。 */
export function buildRegistryUrl(payload = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(clampLimit(payload.limit)));
  // version=latest：服务端只回最新版，省掉本地按版本去重。
  params.set('version', 'latest');
  const search = asString(payload.search).trim();
  if (search) params.set('search', search);
  const cursor = asString(payload.cursor).trim();
  if (cursor) params.set('cursor', cursor);
  return `${MCP_REGISTRY_SOURCES[0]}?${params.toString()}`;
}

/** 单次 GET JSON：超时 + 仅网络错误/5xx 重试 1 次；4xx 与解析失败直接放弃。 */
async function fetchJson(url, options = {}) {
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前宿主没有 fetch，无法读取社区目录');
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : FETCH_TIMEOUT_MS;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: controller ? controller.signal : undefined,
      });
      const status = Number(response?.status) || 0;
      // ok 是权威判定，不能只信 status：代理 / 矿化响应可能 ok=false 却没有状态码。
      // status 0 视为网关层异常（可重试一次），4xx 明确不重试，5xx 重试一次。
      if (!response || response.ok === false) {
        const error = new Error(`HTTP ${status || '未知'}`);
        error.retryable = status === 0 || status >= 500;
        throw error;
      }
      const body = typeof response.json === 'function' ? await response.json() : response;
      return body;
    } catch (cause) {
      // 非 HTTP 错误（网络 / 超时 / 解析）与 5xx 才重试；4xx 明确不重试。
      if (attempt === 0 && cause?.retryable !== false) continue;
      throw cause;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw new Error('读取社区目录失败');
}

function cacheKeyOf(payload) {
  return [
    asString(payload.search).trim(),
    asString(payload.cursor).trim(),
    String(clampLimit(payload.limit)),
  ].join('|');
}

function readCache(key, now, ttlMs) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.fetchedAt > ttlMs) {
    cache.delete(key);
    return null;
  }
  return hit;
}

function writeCache(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
}

/** 测试隔离口：清空内存缓存（生产代码不调用）。 */
export function resetCommunityCache() {
  cache.clear();
}

/**
 * 社区 MCP 列表（一次游标请求）。
 *
 * @param {{search?: string, cursor?: string, limit?: number, takenNames?: string[]}} payload
 * @param {{fetchImpl?: Function, now?: Function, timeoutMs?: number, cacheTtlMs?: number}} options
 * @returns {Promise<{ok:true, rows:object[], nextCursor:string|null, fetchedAt:number, cached:boolean}
 *                   | {ok:false, error:string}>}
 *
 * 永不抛错：所有失败都收敛成 `{ok:false, error}`，面板只负责把错误落在列表内。
 * `takenNames` 来自调用方的 MCP 列表，用于 serverName 冲突后缀；本函数内已分配的
 * 名字也会累加进去，保证同批两条同尾段条目不会撞名。
 */
export async function wbMcpCommunityList(payload = {}, options = {}) {
  const input = payload && typeof payload === 'object' ? payload : {};
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const ttlMs = Number(options.cacheTtlMs) > 0 ? Number(options.cacheTtlMs) : CACHE_TTL_MS;
  const key = cacheKeyOf(input);
  const hit = readCache(key, now(), ttlMs);
  if (hit) {
    // serverName 取决于「当前已装了哪些 MCP」：缓存只存上游映射，命中时按本次
    // takenNames 重新分配冲突后缀，否则用户装完一条再回列表仍看到旧名字。
    const taken = [...asArray(input.takenNames)];
    const seen = new Set();
    const rows = hit.rows.map((row) => {
      let serverName = sanitizeServerName(row.name, taken);
      if (seen.has(serverName)) serverName = sanitizeServerName(row.name, taken);
      seen.add(serverName);
      taken.push(serverName);
      return serverName === row.serverName ? row : { ...row, serverName };
    });
    return { ok: true, rows, nextCursor: hit.nextCursor, fetchedAt: hit.fetchedAt, cached: true };
  }

  let raw;
  try {
    raw = await fetchJson(buildRegistryUrl(input), options);
  } catch (cause) {
    return { ok: false, error: String(cause?.message || cause) };
  }

  const { servers, nextCursor } = normalizeRegistryResponse(raw);
  const taken = [...asArray(input.takenNames)];
  const rows = [];
  const seen = new Set();
  for (const entry of servers) {
    const row = mapRegistryServer(entry, { takenNames: taken });
    if (!row) continue;
    // 同一页里可能同时出现同一 serverName（同名不同版本已被 version=latest 挡掉，
    // 这里只防尾段撞名的不同条目）：后出现的自动后缀。
    if (seen.has(row.serverName)) row.serverName = sanitizeServerName(row.name, taken);
    seen.add(row.serverName);
    taken.push(row.serverName);
    rows.push(row);
  }

  const value = { rows, nextCursor, fetchedAt: now() };
  writeCache(key, value);
  return { ok: true, rows, nextCursor, fetchedAt: value.fetchedAt, cached: false };
}
