// awesome 市场数据层（lib/wb-awesome-market.js）的回归套件（T01）。
//
// 覆盖：slimEntries 过滤口径（verified∧npm 交集、broken/unverified 出局、npm 对象
// 形态提取）、映射字段防御（description 截断 / tags / stars / official / 畸形条目）、
// 原子写（staging 无残留）、catalog 三条主链（无缓存 200 全量 / 有缓存 304 复用 /
// 双源切换 / 全源失败 stale 回落）、updateCheck 五枚举（HEAD 条件探测 + 绝不落盘）、
// wbAwesomeDetail 命中与未命中、SHA 新鲜度口径（api.github.com 解析 → @<sha> 不可变
// 拉取 → 未变零下载 / 变更镜像接管 / API 挂回落 @main 与 ETag 探测）、第二社区源
// 聚合（npm latest 版本解析 → @<版本> 不可变拉取 → 适配 → 服务时按 npm 名去重合并 /
// 独立容错 / 双源探测与后台零下载）。
//
// 隔离纪律：mkdtemp 临时目录 + options.rootDir 注入，绝不碰真实 ~/.dsh；联网走
// globalThis.fetch 替换，finally 必还原，零真实外网。SHA 与第二源版本解析备忘均按
// 缓存根分键，每个用例独立 freshRoot 天然隔离；需要不同结果的子场景各自开新根。
// mockFetch 默认把第二源请求一律挂掉（既有用例只钉主源行为，不受并行请求干扰）；
// 第二源用例传 { second: true } 显式接管。
// 用法：node ./test/wb-awesome-market.mjs
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
  wbAwesomeCatalog,
  wbAwesomeDetail,
  wbAwesomeUpdateCheck,
  wbAwesomeCachedInfo,
  slimEntries,
  adaptSecondEntries,
  mergeSecondEntries,
  AWESOME_MARKETPLACE_ID,
  SLIM_MAX_BYTES,
} = await import(new URL('../lib/wb-awesome-market.js', import.meta.url).href);

let failures = 0;
const ok = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
};

function freshRoot() {
  return mkdtemp(join(tmpdir(), 'awesome-'));
}

/** 替换 globalThis.fetch 并返回还原函数（finally 必还原）。
 *  默认屏蔽第二源（registry 元数据与 jsDelivr npm 路径）请求：catalog 现在两源
 *  并行拉取，不屏蔽会让第二源请求吃掉旧用例的 round 计数/断言变量；
 *  { second: true } 时全部放行交给 handler 显式分支。 */
function mockFetch(handler, { second = false } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (!second && (url === SECOND_API_URL || String(url).includes('/npm/dsh-plugin-catalog'))) {
      throw new Error('second source disabled in this case');
    }
    return handler(url, init);
  };
  return () => {
    globalThis.fetch = original;
  };
}

/** 200 全量响应替身：body = 源 JSON 文本，headers 带 ETag。 */
function jsonResponse(payload, etag = '"v1"') {
  const text = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (String(name).toLowerCase() === 'etag' ? etag : null) },
    arrayBuffer: async () => Buffer.from(text, 'utf8'),
    json: async () => payload, // GitHub commits API 的解析替身走 json()
    body: { cancel: () => {} },
  };
}

/** 条件 304 响应替身（必须携带 etag 请求才会被 fetchChain 认作命中）。 */
function notModifiedResponse() {
  return {
    ok: false,
    status: 304,
    headers: { get: () => null },
    arrayBuffer: async () => Buffer.alloc(0),
    body: { cancel: () => {} },
  };
}

/** 一条合法的源数据条目（覆盖字段可覆盖）。 */
function rawEntry(overrides = {}) {
  return {
    name: 'demo-plugin',
    repo: 'dshworks/demo-plugin',
    npm: '@demo/plugin',
    description: 'A demo plugin',
    category: 'productivity',
    official: true,
    added: '2026-01-01',
    lastVerified: '2026-10-01',
    verifiedAgainst: 'dsh 1.10',
    status: 'verified',
    stars: 42,
    tags: ['tools', 'docs'],
    pushedAt: '2026-09-30',
    ...overrides,
  };
}

const SOURCE_URL = 'https://cdn.jsdelivr.net/gh/dshworks/awesome-dsh-plugins@main/data/plugins.json';
const MIRROR_URL = 'https://fastly.jsdelivr.net/gh/dshworks/awesome-dsh-plugins@main/data/plugins.json';
// SHA 口径的锚点：API 端点与不可变地址必须与 lib/wb-awesome-market.js 的推导一致
// （由 SOURCE_URL 解析 <owner>/<repo>@<branch>/<path> 拼出）。
const API_URL = 'https://api.github.com/repos/dshworks/awesome-dsh-plugins/commits/main';
const SHA_A = '0123abcd0123abcd0123abcd0123abcd0123abcd';
const SHA_B = '9876fedc9876fedc9876fedc9876fedc9876fedc';
const pinnedUrlOf = (sha, host = 'https://cdn.jsdelivr.net') =>
  `${host}/gh/dshworks/awesome-dsh-plugins@${sha}/data/plugins.json`;
const mirrorPinnedUrlOf = (sha) => pinnedUrlOf(sha, 'https://fastly.jsdelivr.net');

// 第二社区源（awesome-dsh-plugin.com 聚合目录，npm 包 dsh-plugin-catalog）锚点：
// registry 元数据端点与 jsDelivr @<版本> 不可变地址，与 lib 推导一致。
const SECOND_API_URL = 'https://registry.npmjs.org/dsh-plugin-catalog/latest';
const SECOND_V_A = '2026.1024.0';
const SECOND_V_B = '2026.1025.0';
const secondPinnedUrlOf = (version, host = 'https://cdn.jsdelivr.net') =>
  `${host}/npm/dsh-plugin-catalog@${version}/plugins.json`;
const secondMirrorPinnedUrlOf = (version) => secondPinnedUrlOf(version, 'https://fastly.jsdelivr.net');

/** 第二源目录条目（实测形态：中英双语 description、GitHub url、自有 category 体系、
 *  install 字符串、npm 字符串）。 */
function secondRawEntry(overrides = {}) {
  return {
    name: 'second-demo',
    owner: 'second-owner',
    url: 'https://github.com/second-owner/second-demo',
    page: 'https://awesome-dsh-plugin.com/p/second-owner/second-demo/',
    category: 'model',
    description: { en: 'Second source demo plugin', zh: '第二源演示插件' },
    stars: 7,
    version: '1.0.0',
    npm: 'second-demo-pkg',
    install: 'npm:second-demo-pkg',
    ...overrides,
  };
}

/** 预置一份磁盘缓存（绕过网络）：slim 一条 + meta 按需覆盖。省 resolvedSha 键即旧版缓存。 */
async function seedCache(root, metaOverrides = {}) {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(root, 'awesome-market'), { recursive: true });
  await writeFile(
    join(root, 'awesome-market', 'slim.json'),
    JSON.stringify(slimEntries([rawEntry({ name: 'seeded-one' })])),
    'utf8',
  );
  await writeFile(
    join(root, 'awesome-market', 'meta.json'),
    JSON.stringify({
      etag: '"seed-etag"',
      fetchedAt: 1,
      updated: '2026-10-23',
      counts: { total: 1, byCategory: { productivity: 1 } },
      source: SOURCE_URL,
      ...metaOverrides,
    }),
    'utf8',
  );
}

// ── 1. slimEntries 过滤口径 ─────────────────────────────────────────────────
{
  const out = slimEntries([
    rawEntry({ name: 'keep-a', npm: 'a', status: 'verified' }), // verified ∧ npm → 保留
    rawEntry({ name: 'drop-unverified', npm: 'b', status: 'unverified' }), // unverified 出局
    rawEntry({ name: 'drop-broken', npm: 'c', status: 'broken' }), // broken 出局
    rawEntry({ name: 'keep-obj', npm: { name: 'scoped-pkg', version: '1.0' }, status: 'verified' }), // npm 对象形态
    rawEntry({ name: 'drop-empty-npm', npm: '', status: 'verified' }), // npm 空串出局
    rawEntry({ name: 'drop-null-npm', npm: null, status: 'verified' }), // npm null 出局
    rawEntry({ name: 'keep-whitespace-npm', npm: '  trimmed-pkg  ', status: 'verified' }), // npm trim 后保留
  ]);
  const names = out.map((entry) => entry.name);
  ok('slimEntries 过滤：verified∧npm 保留', names.includes('keep-a'));
  ok('slimEntries 过滤：unverified/broken 出局', !names.includes('drop-unverified') && !names.includes('drop-broken'));
  ok(
    'slimEntries 过滤：npm 对象 {name} 能提取',
    names.includes('keep-obj') && out.find((e) => e.name === 'keep-obj').npm === 'scoped-pkg',
  );
  ok('slimEntries 过滤：npm 空串/null 出局', !names.includes('drop-empty-npm') && !names.includes('drop-null-npm'));
  ok(
    'slimEntries 过滤：npm 空白串 trim 后保留',
    out.find((e) => e.name === 'keep-whitespace-npm').npm === 'trimmed-pkg',
  );
  ok('slimEntries 保持源顺序输出', names[0] === 'keep-a' && names[names.length - 1] === 'keep-whitespace-npm');
}

// ── 2. slimEntries 映射与防御 ───────────────────────────────────────────────
{
  const out = slimEntries([
    rawEntry({ name: 'long-desc', description: 'x'.repeat(300) }),
    rawEntry({ name: 'no-tags', tags: 'not-an-array' }),
    rawEntry({ name: 'over-tags', tags: ['a', 'b', 'c', 42, null] }),
    rawEntry({ name: 'bad-stars', stars: '42' }),
    rawEntry({ name: 'neg-official', official: 0 }),
    { repo: 'no-name-here', npm: 'x', status: 'verified' }, // 无 name → 丢弃
    rawEntry({ name: 'no-category', category: '' }),
    42,
    null,
  ]);
  const byName = new Map(out.map((entry) => [entry.name, entry]));
  ok('slimEntries 映射：description >120 截断', byName.get('long-desc').description.length === 120);
  ok(
    'slimEntries 映射：tags 非数组→[]、超 2 个截断',
    byName.get('no-tags').tags.length === 0 &&
      JSON.stringify(byName.get('over-tags').tags) === JSON.stringify(['a', 'b']),
  );
  ok('slimEntries 映射：stars 非数字→0', byName.get('bad-stars').stars === 0);
  ok(
    'slimEntries 映射：official truthy→true / 0→false',
    byName.get('long-desc').official === true && byName.get('neg-official').official === false,
  );
  ok(
    'slimEntries 防御：无 name 的致命畸形条目丢弃',
    !byName.has(undefined) && out.every((entry) => typeof entry.name === 'string' && entry.name),
  );
  ok('slimEntries 防御：category 空 → 回落 plugin', byName.get('no-category').category === 'plugin');
  ok(
    'slimEntries 防御：status 恒为 verified',
    out.every((entry) => entry.status === 'verified'),
  );
  ok('slimEntries 防御：非数组输入返回 []', slimEntries(null).length === 0 && slimEntries('nope').length === 0);
}

// ── 3. catalog 无缓存 + mock 200 全量：网络加载 + 落盘 + counts ──────────────
{
  const root = await freshRoot();
  const restore = mockFetch(async (url) => {
    if (url !== SOURCE_URL) throw new Error('unexpected url ' + url);
    return jsonResponse(
      {
        updated: '2026-10-20',
        plugins: [
          rawEntry({ name: 'cat-a', category: 'productivity' }),
          rawEntry({ name: 'cat-b', category: 'productivity' }),
          rawEntry({ name: 'cat-c', category: 'dev' }),
          rawEntry({ name: 'cat-d', status: 'unverified' }), // 应被过滤
        ],
      },
      '"tag-1"',
    );
  });
  try {
    const result = await wbAwesomeCatalog({ rootDir: root });
    ok('catalog 无缓存 200：loadedFrom=network + ok', result.ok === true && result.loadedFrom === 'network');
    ok(
      'catalog 无缓存 200：marketplace 标记',
      result.marketplace === AWESOME_MARKETPLACE_ID && AWESOME_MARKETPLACE_ID === 'awesome-dsh-plugins',
    );
    ok(
      'catalog 无缓存 200：counts 按瘦身结果统计',
      result.counts.total === 3 && result.counts.byCategory.productivity === 2 && result.counts.byCategory.dev === 1,
      JSON.stringify(result.counts),
    );
    const slimOnDisk = JSON.parse(await readFile(join(root, 'awesome-market', 'slim.json'), 'utf8'));
    ok(
      'catalog 无缓存 200：slim.json 落盘可解析且无 unverified',
      Array.isArray(slimOnDisk) && slimOnDisk.length === 3 && slimOnDisk.every((e) => e.status === 'verified'),
    );
    const metaOnDisk = JSON.parse(await readFile(join(root, 'awesome-market', 'meta.json'), 'utf8'));
    ok(
      'catalog 无缓存 200：meta.json 记录 etag/updated/counts',
      metaOnDisk.etag === '"tag-1"' && metaOnDisk.updated === '2026-10-20' && metaOnDisk.counts.total === 3,
    );
    ok('catalog 无缓存 200：updated 字段回传', result.updated === '2026-10-20');
    const entries = await readdir(join(root, 'awesome-market'));
    ok('原子写：目录里没有 .staging 残留', !entries.some((name) => name.endsWith('.staging')), entries.join(','));
    const info = await wbAwesomeCachedInfo({ rootDir: root });
    ok(
      'cachedInfo：有缓存时回传 etag/fetchedAt/updated',
      info.hasCache === true && info.etag === '"tag-1"' && info.fetchedAt > 0 && info.updated === '2026-10-20',
    );
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

// ── 4. catalog 有缓存 + 304：复用磁盘，不重写 ────────────────────────────────
{
  const root = await freshRoot();
  let round = 0;
  let sawConditionalHeader = '';
  const restore = mockFetch(async (url, init) => {
    if (url === API_URL) throw new Error('api unavailable（本用例钉的是 @main+ETag 回落口径）');
    round += 1;
    if (round === 1)
      return jsonResponse({ updated: '2026-10-20', plugins: [rawEntry({ name: 'cached-one' })] }, '"etag-keep"');
    sawConditionalHeader = init?.headers?.['if-none-match'] || '';
    if (url !== SOURCE_URL) throw new Error('unexpected url ' + url);
    return notModifiedResponse(); // 第二轮：条件命中 304
  });
  try {
    await wbAwesomeCatalog({ rootDir: root });
    const slimPath = join(root, 'awesome-market', 'slim.json');
    const before = await readFile(slimPath, 'utf8');
    const beforeStat = await stat(slimPath);
    const second = await wbAwesomeCatalog({ rootDir: root, refresh: true });
    ok('catalog 304：请求带 If-None-Match 条件头', sawConditionalHeader === '"etag-keep"', sawConditionalHeader);
    ok('catalog 304：loadedFrom=cache', second.ok === true && second.loadedFrom === 'cache');
    const after = await readFile(slimPath, 'utf8');
    const afterStat = await stat(slimPath);
    ok('catalog 304：slim.json 内容与 mtime 均未重写', after === before && afterStat.mtimeMs === beforeStat.mtimeMs);
    ok(
      'catalog 304：响应仍带 plugins/marketplace/counts',
      Array.isArray(second.plugins) &&
        second.plugins.length === 1 &&
        second.marketplace === AWESOME_MARKETPLACE_ID &&
        second.counts.total === 1,
    );
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

// ── 5. 双源切换：首源抛错 → 备源成功 ─────────────────────────────────────────
{
  const root = await freshRoot();
  const restore = mockFetch(async (url) => {
    if (url === SOURCE_URL) throw new Error('simulated network failure');
    if (url !== MIRROR_URL) throw new Error('unexpected url ' + url);
    return jsonResponse({ updated: '2026-10-21', plugins: [rawEntry({ name: 'from-mirror' })] }, '"tag-mirror"');
  });
  try {
    const result = await wbAwesomeCatalog({ rootDir: root });
    ok(
      '双源切换：首源失败备源成功 loadedFrom=network',
      result.ok === true && result.loadedFrom === 'network' && result.plugins[0].name === 'from-mirror',
    );
    ok('双源切换：记备源响应的 ETag', (await wbAwesomeCachedInfo({ rootDir: root })).etag === '"tag-mirror"');
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

// ── 6. 全源失败：有缓存 → stale 回落磁盘；无缓存 → ok:false ──────────────────
{
  const root = await freshRoot();
  const restore = mockFetch(async () => {
    throw new Error('all sources down');
  });
  try {
    // 6a. 无缓存：ok:false + 错误信息。
    const cold = await wbAwesomeCatalog({ rootDir: root });
    ok('全源失败无缓存：ok:false', cold.ok === false && typeof cold.error === 'string' && cold.error.length > 0);
    // 6b. 预置缓存（绕过网络直接落盘一份），再全源失败 → stale 回落。
    const entries = slimEntries([rawEntry({ name: 'stale-one' })]);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'awesome-market'), { recursive: true });
    await writeFile(join(root, 'awesome-market', 'slim.json'), JSON.stringify(entries), 'utf8');
    await writeFile(
      join(root, 'awesome-market', 'meta.json'),
      JSON.stringify({
        etag: '"old"',
        fetchedAt: 1,
        updated: '2026-10-19',
        counts: { total: 1, byCategory: { productivity: 1 } },
      }),
      'utf8',
    );
    // refresh: true 走同步强刷路径（默认路径现在是缓存优先，见 §8）。
    const warm = await wbAwesomeCatalog({ rootDir: root, refresh: true });
    ok(
      '全源失败有缓存：ok:true + stale:true + loadedFrom=disk',
      warm.ok === true && warm.stale === true && warm.loadedFrom === 'disk',
    );
    ok(
      '全源失败有缓存：回传缓存内容与 counts',
      warm.plugins.length === 1 && warm.plugins[0].name === 'stale-one' && warm.counts.total === 1,
    );
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

// ── 8. 缓存优先（stale-while-revalidate）：新鲜零网络 / 陈旧先秒回再后台刷新 ──
{
  const root = await freshRoot();
  let netHits = 0;
  const restore = mockFetch(async (url, init) => {
    netHits += 1;
    if (url !== SOURCE_URL) throw new Error('unexpected url ' + url);
    if (init?.headers?.['if-none-match']) return notModifiedResponse();
    return jsonResponse({ updated: '2026-10-20', plugins: [rawEntry({ name: 'swr-live' })] }, '"tag-swr"');
  });
  try {
    // 8a. 冷启动：无缓存 → 联网，回传 fetchedAt。
    const cold = await wbAwesomeCatalog({ rootDir: root });
    ok(
      'swr 冷启动：loadedFrom=network + fetchedAt 回传',
      cold.ok === true && cold.loadedFrom === 'network' && cold.fetchedAt > 0,
    );
    // 8b. 再取一次：缓存新鲜 → 直接返回，一个请求都不发。
    const hitsAfterCold = netHits;
    const warm = await wbAwesomeCatalog({ rootDir: root });
    ok(
      'swr 新鲜缓存：零网络 + loadedFrom=cache + 内容一致',
      netHits === hitsAfterCold &&
        warm.ok === true &&
        warm.loadedFrom === 'cache' &&
        warm.plugins[0].name === 'swr-live',
    );
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}
// 8c. 陈旧缓存（fetchedAt 远古、内存层为空）：先秒回旧数据并标 refreshing，
//     后台按存量 ETag 再验证成功 → 下一次调用即拿新数据。
{
  const { mkdir } = await import('node:fs/promises');
  const root = await freshRoot();
  await mkdir(join(root, 'awesome-market'), { recursive: true });
  await writeFile(
    join(root, 'awesome-market', 'slim.json'),
    JSON.stringify(slimEntries([rawEntry({ name: 'swr-stale' })])),
    'utf8',
  );
  await writeFile(
    join(root, 'awesome-market', 'meta.json'),
    JSON.stringify({
      etag: '"tag-old"',
      fetchedAt: 1,
      updated: '2026-10-18',
      counts: { total: 1, byCategory: { productivity: 1 } },
    }),
    'utf8',
  );
  let sawStoredEtag = '';
  const restore = mockFetch(async (url, init) => {
    if (url !== SOURCE_URL) throw new Error('unexpected url ' + url);
    if (init?.headers?.['if-none-match'] !== '"tag-old"') throw new Error('后台再验证必须带上存量 ETag');
    sawStoredEtag = init.headers['if-none-match'];
    return jsonResponse({ updated: '2026-10-22', plugins: [rawEntry({ name: 'swr-fresh' })] }, '"tag-new"');
  });
  try {
    const first = await wbAwesomeCatalog({ rootDir: root });
    ok(
      'swr 陈旧缓存：立刻返回旧数据 + refreshing:true',
      first.ok === true &&
        first.loadedFrom === 'cache' &&
        first.refreshing === true &&
        first.plugins[0].name === 'swr-stale',
    );
    for (let i = 0; i < 100 && sawStoredEtag === ''; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    ok('swr 陈旧缓存：后台带存量 ETag 再验证', sawStoredEtag === '"tag-old"');
    let next = null;
    for (let i = 0; i < 100; i += 1) {
      next = await wbAwesomeCatalog({ rootDir: root });
      if (next.plugins?.[0]?.name === 'swr-fresh') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    ok('swr 陈旧缓存：后台完成后下次即拿新数据', next.ok === true && next.plugins[0].name === 'swr-fresh');
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

// ── 7. wbAwesomeUpdateCheck：五枚举 + 只探测不落盘 ───────────────────────────
{
  // 7a. 无缓存 → no-cache。
  {
    const root = await freshRoot();
    const restore = mockFetch(async () => {
      throw new Error('probe should not fire without cache');
    });
    try {
      const result = await wbAwesomeUpdateCheck({ rootDir: root });
      ok(
        'updateCheck 无缓存：no-cache 且不联网',
        result.ok === true && result.hasUpdate === false && result.reason === 'no-cache',
      );
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }
  // 7b/7c/7d：有缓存 + HEAD 探测（304 / 200 新 ETag / 抛错）+ 全程无落盘。
  {
    const root = await freshRoot();
    let probeMethod = '';
    let probeConditional = '';
    let probeUrl = '';
    const restore = mockFetch(async (url, init) => {
      if (url !== SOURCE_URL) throw new Error('unexpected url ' + url);
      // 目录加载用 200；探测轮（HEAD 或降级 GET）按场景分支。
      if (!init?.method || (init.method === 'GET' && !init?.headers?.['if-none-match'])) {
        return jsonResponse({ updated: '2026-10-20', plugins: [rawEntry({ name: 'probe-base' })] }, '"local-etag"');
      }
      probeMethod = init.method;
      probeConditional = init.headers['if-none-match'] || '';
      probeUrl = url;
      if (probeScenario === 304) return notModifiedResponse();
      if (probeScenario === 200) return jsonResponse({}, '"new-etag"');
      throw new Error('simulated probe failure');
    });
    let probeScenario = 304;
    try {
      await wbAwesomeCatalog({ rootDir: root });
      const slimPath = join(root, 'awesome-market', 'slim.json');
      const before = await readFile(slimPath, 'utf8');
      const beforeStat = await stat(slimPath);

      probeScenario = 304;
      const upToDate = await wbAwesomeUpdateCheck({ rootDir: root });
      ok(
        'updateCheck 304：HEAD 条件探测（method + if-none-match）',
        probeMethod === 'HEAD' && probeConditional === '"local-etag"' && probeUrl === SOURCE_URL,
      );
      ok(
        'updateCheck 304：up-to-date',
        upToDate.ok === true && upToDate.hasUpdate === false && upToDate.reason === 'up-to-date',
      );

      probeScenario = 200;
      const hasUpdate = await wbAwesomeUpdateCheck({ rootDir: root });
      ok(
        'updateCheck 200 新 ETag：update-available',
        hasUpdate.ok === true &&
          hasUpdate.hasUpdate === true &&
          hasUpdate.reason === 'update-available' &&
          hasUpdate.remoteEtag === '"new-etag"',
      );

      probeScenario = 500;
      const failed = await wbAwesomeUpdateCheck({ rootDir: root });
      ok(
        'updateCheck 非 ok：probe-failed 且 ok:false',
        failed.ok === false && failed.hasUpdate === false && failed.reason === 'probe-failed',
      );

      probeScenario = 'throw';
      const thrown = await wbAwesomeUpdateCheck({ rootDir: root });
      ok('updateCheck fetch 抛错：probe-failed', thrown.ok === false && thrown.reason === 'probe-failed');

      const after = await readFile(slimPath, 'utf8');
      const afterStat = await stat(slimPath);
      ok(
        'updateCheck 全程：slim.json 内容/mtime 未被探测改写',
        after === before && afterStat.mtimeMs === beforeStat.mtimeMs,
      );
      ok(
        'updateCheck 全程：目录无 .staging 残留',
        !(await readdir(join(root, 'awesome-market'))).some((name) => name.endsWith('.staging')),
      );
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }
}

// ── 8. wbAwesomeDetail：按名命中 / 未命中 null ───────────────────────────────
{
  const root = await freshRoot();
  const restore = mockFetch(async (url) => {
    if (url !== SOURCE_URL) throw new Error('unexpected url ' + url);
    return jsonResponse(
      { updated: '2026-10-20', plugins: [rawEntry({ name: 'detail-hit', npm: '@demo/hit' })] },
      '"tag-d"',
    );
  });
  try {
    await wbAwesomeCatalog({ rootDir: root });
    const hit = await wbAwesomeDetail('detail-hit', { rootDir: root });
    ok('detail：按名命中返回瘦身影射', hit !== null && hit.npm === '@demo/hit' && hit.status === 'verified');
    const miss = await wbAwesomeDetail('no-such-plugin', { rootDir: root });
    ok('detail：不存在的名字返回 null', miss === null);
    ok(
      'detail：空名字/非字符串返回 null',
      (await wbAwesomeDetail('', { rootDir: root })) === null &&
        (await wbAwesomeDetail(42, { rootDir: root })) === null,
    );
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

// ── 9. slim.json 体积验收：合成满载目录 < SLIM_MAX_BYTES ─────────────────────
{
  // 模拟真实量级（约 6 千条 verified∧npm 条目，字段长度贴近真实目录分布，
  // 全量瘦身后约 1.5-2MB），断言瘦身 JSON 文本字节数 < 3MB 上限常量。
  const bigCatalog = [];
  for (let i = 0; i < 6000; i += 1) {
    bigCatalog.push(
      rawEntry({
        name: `community-plugin-${i}`,
        repo: `dshworks/community-plugin-${i}`,
        npm: `@community/plugin-${i}`,
        description: "A realistic community plugin description kept at the directory's typical length limit.",
        tags: ['tools', 'docs'],
      }),
    );
  }
  const slim = slimEntries(bigCatalog);
  const bytes = Buffer.byteLength(JSON.stringify(slim), 'utf8');
  ok(
    '体积验收：6000 条满载瘦身产物 < 3MB 上限',
    bytes < SLIM_MAX_BYTES && SLIM_MAX_BYTES === 3 * 1024 * 1024,
    `${bytes} bytes`,
  );
}

// ── 10. SHA 主链（冷缓存）：API 解析 → @<sha> 不可变地址 → resolvedSha 落盘 ──
{
  const root = await freshRoot();
  const restore = mockFetch(async (url) => {
    if (url === API_URL) return jsonResponse({ sha: SHA_A }, '"sha-api"');
    if (url !== pinnedUrlOf(SHA_A)) throw new Error('unexpected url ' + url);
    return jsonResponse({ updated: '2026-10-24', plugins: [rawEntry({ name: 'sha-live' })] }, '"etag-sha"');
  });
  try {
    const result = await wbAwesomeCatalog({ rootDir: root });
    ok(
      'sha 主链：loadedFrom=network + 数据回传',
      result.ok === true && result.loadedFrom === 'network' && result.plugins[0].name === 'sha-live',
    );
    const metaOnDisk = JSON.parse(await readFile(join(root, 'awesome-market', 'meta.json'), 'utf8'));
    ok(
      'sha 主链：meta 落盘 resolvedSha/etag/source 指向不可变地址',
      metaOnDisk.resolvedSha === SHA_A && metaOnDisk.etag === '"etag-sha"' && metaOnDisk.source === pinnedUrlOf(SHA_A),
      JSON.stringify(metaOnDisk),
    );
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

// ── 11. SHA 未变：notModified 零 CDN 下载，后台推新 fetchedAt 重置陈旧计时 ──
{
  const root = await freshRoot();
  await seedCache(root, { source: pinnedUrlOf(SHA_A), resolvedSha: SHA_A, etag: '"etag-a"' });
  let cdnHits = 0;
  const restore = mockFetch(async (url) => {
    if (url === API_URL) return jsonResponse({ sha: SHA_A }, '"sha-api"');
    cdnHits += 1;
    throw new Error('SHA 未变时不应发起任何 CDN 请求: ' + url);
  });
  try {
    const first = await wbAwesomeCatalog({ rootDir: root });
    ok(
      'sha 未变：陈旧缓存秒回 + refreshing:true',
      first.ok === true && first.loadedFrom === 'cache' && first.refreshing === true,
    );
    let metaOnDisk = null;
    for (let i = 0; i < 100; i += 1) {
      metaOnDisk = JSON.parse(await readFile(join(root, 'awesome-market', 'meta.json'), 'utf8'));
      if (Number(metaOnDisk.fetchedAt) > 1) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    ok(
      'sha 未变：后台判 notModified 推新 fetchedAt，全程零 CDN 下载',
      Number(metaOnDisk.fetchedAt) > 1 && cdnHits === 0,
      `cdnHits=${cdnHits}`,
    );
    const second = await wbAwesomeCatalog({ rootDir: root });
    ok(
      'sha 未变：下次调用缓存已新鲜，不再 refreshing',
      second.ok === true && second.loadedFrom === 'cache' && second.refreshing !== true,
    );
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

// ── 12. SHA 变更：pinned 主源挂 → 镜像不可变地址接管，resolvedSha 全线推进 ──
{
  const root = await freshRoot();
  await seedCache(root, { source: pinnedUrlOf(SHA_A), resolvedSha: SHA_A, etag: '"etag-a"' });
  const restore = mockFetch(async (url) => {
    if (url === API_URL) return jsonResponse({ sha: SHA_B }, '"sha-api"');
    if (url === pinnedUrlOf(SHA_B)) throw new Error('simulated primary pinned failure');
    if (url !== mirrorPinnedUrlOf(SHA_B)) throw new Error('unexpected url ' + url);
    return jsonResponse({ updated: '2026-10-24', plugins: [rawEntry({ name: 'sha-fresh' })] }, '"etag-b"');
  });
  try {
    const result = await wbAwesomeCatalog({ rootDir: root, refresh: true });
    ok(
      'sha 变更：pinned 主源挂 → 镜像不可变地址接管（network）',
      result.ok === true && result.loadedFrom === 'network' && result.plugins[0].name === 'sha-fresh',
    );
    const metaOnDisk = JSON.parse(await readFile(join(root, 'awesome-market', 'meta.json'), 'utf8'));
    ok(
      'sha 变更：resolvedSha/etag/source 全部推进到新提交',
      metaOnDisk.resolvedSha === SHA_B &&
        metaOnDisk.etag === '"etag-b"' &&
        metaOnDisk.source === mirrorPinnedUrlOf(SHA_B),
    );
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

// ── 13. pinned 全挂 → 回落 @main 条件链（旧行为保留，可用性不降）────────────
{
  const root = await freshRoot();
  await seedCache(root, { resolvedSha: SHA_A, etag: '"etag-main"' });
  let sawConditional = '';
  const restore = mockFetch(async (url, init) => {
    if (url === API_URL) return jsonResponse({ sha: SHA_B }, '"sha-api"');
    if (url === pinnedUrlOf(SHA_B) || url === mirrorPinnedUrlOf(SHA_B)) throw new Error('simulated pinned outage');
    if (url !== SOURCE_URL) throw new Error('unexpected url ' + url);
    sawConditional = init?.headers?.['if-none-match'] || '';
    return notModifiedResponse(); // @main 陈旧边缘对旧 ETag 回 304
  });
  try {
    const result = await wbAwesomeCatalog({ rootDir: root, refresh: true });
    ok(
      'pinned 全挂回落 @main：条件 GET 保留（304 复用缓存）',
      result.ok === true && result.loadedFrom === 'cache' && sawConditional === '"etag-main"',
      sawConditional,
    );
    const metaOnDisk = JSON.parse(await readFile(join(root, 'awesome-market', 'meta.json'), 'utf8'));
    ok('pinned 全挂回落 @main：未重拉数据，resolvedSha 原样保留', metaOnDisk.resolvedSha === SHA_A);
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

// ── 14. updateCheck SHA 口径：同 SHA 零探测 / SHA 前进即报更新 / API 挂回落 HEAD ─
{
  // 14a. 同 SHA：不碰 CDN 直接 up-to-date。
  {
    const root = await freshRoot();
    await seedCache(root, { resolvedSha: SHA_A, etag: '"etag-x"' });
    let probeSaw = '';
    const restore = mockFetch(async (url) => {
      if (url === API_URL) return jsonResponse({ sha: SHA_A }, '"sha-api"');
      probeSaw = url;
      throw new Error('同 SHA 不应发起任何 CDN 探测: ' + url);
    });
    try {
      const result = await wbAwesomeUpdateCheck({ rootDir: root });
      ok(
        'updateCheck SHA：同 SHA → up-to-date 且零 CDN 探测',
        result.ok === true && result.hasUpdate === false && result.reason === 'up-to-date' && probeSaw === '',
      );
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }
  // 14b. SHA 前进：update-available，同样零 CDN 探测（独立根，绕开解析备忘）。
  {
    const root = await freshRoot();
    await seedCache(root, { resolvedSha: SHA_A, etag: '"etag-x"' });
    let probeSaw = '';
    const restore = mockFetch(async (url) => {
      if (url === API_URL) return jsonResponse({ sha: SHA_B }, '"sha-api"');
      probeSaw = url;
      throw new Error('SHA 前进不应发起任何 CDN 探测: ' + url);
    });
    try {
      const result = await wbAwesomeUpdateCheck({ rootDir: root });
      ok(
        'updateCheck SHA：SHA 前进 → update-available 且零 CDN 探测',
        result.ok === true && result.hasUpdate === true && result.reason === 'update-available' && probeSaw === '',
      );
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }
  // 14c. API 挂：回落既有 HEAD ETag 探测（304 → up-to-date）。
  {
    const root = await freshRoot();
    await seedCache(root, { resolvedSha: SHA_A, etag: '"etag-x"' });
    let probeMethod = '';
    let probeUrl = '';
    const restore = mockFetch(async (url, init) => {
      if (url === API_URL) throw new Error('simulated api outage');
      if (url !== SOURCE_URL) throw new Error('unexpected url ' + url);
      probeMethod = init?.method || 'GET';
      probeUrl = url;
      return notModifiedResponse();
    });
    try {
      const result = await wbAwesomeUpdateCheck({ rootDir: root });
      ok(
        'updateCheck API 挂：回落 HEAD ETag 探测 304 → up-to-date',
        result.ok === true &&
          result.hasUpdate === false &&
          result.reason === 'up-to-date' &&
          probeMethod === 'HEAD' &&
          probeUrl === SOURCE_URL,
        `${probeMethod} ${probeUrl}`,
      );
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }
}

// ── 15. 旧版缓存（有 etag 无 resolvedSha）+ API 可用：报 update-available 引导自愈 ─
{
  const root = await freshRoot();
  await seedCache(root); // 不带 resolvedSha 键 = 旧版缓存形态
  const restore = mockFetch(async (url) => {
    if (url === API_URL) return jsonResponse({ sha: SHA_A }, '"sha-api"');
    throw new Error('unexpected url ' + url);
  });
  try {
    const result = await wbAwesomeUpdateCheck({ rootDir: root });
    ok(
      'updateCheck 旧缓存：解析成功即 update-available（刷新落盘 resolvedSha 后自愈）',
      result.ok === true && result.hasUpdate === true && result.reason === 'update-available',
    );
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

// ── 16. 第二源纯函数：adapt（zh 优先/英文回落/git-only 出局/repo 归一）+ merge 去重 ─
{
  const adapted = adaptSecondEntries([
    secondRawEntry({ name: 'zh-entry', npm: 'pkg-zh' }),
    secondRawEntry({ name: 'en-entry', npm: 'pkg-en', description: { en: 'EN only text' } }),
    secondRawEntry({ name: 'plain-entry', npm: 'pkg-plain', description: 'plain string desc' }),
    secondRawEntry({ name: 'git-only', npm: '' }), // 无 npm → 出局（面板口径 = 可 npm 安装）
    secondRawEntry({ npm: 'pkg-noname', name: '' }), // 无 name → 出局
    null,
    42,
  ]);
  const byName = new Map(adapted.map((entry) => [entry.name, entry]));
  ok('adapt 第二源：zh 描述优先', byName.get('zh-entry').description === '第二源演示插件');
  ok('adapt 第二源：无 zh 回落 en', byName.get('en-entry').description === 'EN only text');
  ok('adapt 第二源：纯字符串描述直取', byName.get('plain-entry').description === 'plain string desc');
  ok('adapt 第二源：repo 由 url 归一为 owner/repo', byName.get('zh-entry').repo === 'second-owner/second-demo');
  ok('adapt 第二源：category 透传 / 缺省 plugin', byName.get('zh-entry').category === 'model');
  ok('adapt 第二源：git-only 与无 name 出局', !byName.has('git-only') && !byName.has('no-name') && !byName.has(''));
  ok(
    'adapt 第二源：验证元数据置空 + status 恒 verified + tags 空数组',
    adapted.every(
      (e) =>
        e.status === 'verified' &&
        e.verifiedAgainst === '' &&
        e.lastVerified === '' &&
        Array.isArray(e.tags) &&
        e.tags.length === 0,
    ),
  );
  const primary = [
    { name: 'p1', npm: 'pkg-dup', category: 'plugin' },
    { name: 'p2', npm: 'pkg-2', category: 'plugin' },
  ];
  const second = [
    { name: 's-dup', npm: 'pkg-dup', category: 'model' },
    { name: 's-new', npm: 'pkg-new', category: 'ui' },
  ];
  const merged = mergeSecondEntries(primary, second);
  ok(
    'merge 第二源：按 npm 名去重、主源优先、顺序主源在前',
    merged.length === 3 && merged[0].name === 'p1' && merged[1].name === 'p2' && merged[2].name === 's-new',
  );
  ok(
    'merge 第二源：第二源为空/畸形时原样返回主源',
    mergeSecondEntries(primary, null).length === 2 && mergeSecondEntries(primary, []).length === 2,
  );
}

// ── 17. 双源聚合主链（冷启动）：两源并行成功 → 合并目录 + second.json/meta.second 落盘 ──
{
  const root = await freshRoot();
  const restore = mockFetch(
    async (url) => {
      if (url === API_URL) return jsonResponse({ sha: SHA_A }, '"sha-api"');
      if (url === pinnedUrlOf(SHA_A)) {
        return jsonResponse(
          {
            updated: '2026-10-24',
            plugins: [
              rawEntry({ name: 'primary-one', npm: 'pkg-primary' }),
              rawEntry({ name: 'primary-dup', npm: 'pkg-dup' }),
            ],
          },
          '"etag-p1"',
        );
      }
      if (url === SECOND_API_URL) return jsonResponse({ version: SECOND_V_A }, '"v-api"');
      if (url === secondPinnedUrlOf(SECOND_V_A)) {
        return jsonResponse(
          {
            updated: '2026-10-23',
            plugins: [
              secondRawEntry({ name: 'second-dup', npm: 'pkg-dup' }), // 与主源重复 → 合并时出局
              secondRawEntry({ name: 'second-only', npm: 'pkg-second' }),
              secondRawEntry({ name: 'git-only', npm: '' }), // git-only → 适配时出局
            ],
          },
          '"etag-s1"',
        );
      }
      throw new Error('unexpected url ' + url);
    },
    { second: true },
  );
  try {
    const result = await wbAwesomeCatalog({ rootDir: root });
    const names = result.plugins.map((entry) => entry.name);
    ok(
      '双源聚合：主源+第二源独有条目合并出目录（network）',
      result.ok === true &&
        result.loadedFrom === 'network' &&
        names.includes('primary-one') &&
        names.includes('second-only'),
      names.join(','),
    );
    ok(
      '双源聚合：npm 重复条目去重（主源副本胜出）+ git-only 不进面板',
      !names.includes('second-dup') && !names.includes('git-only') && result.counts.total === 3,
      JSON.stringify(result.counts),
    );
    const metaOnDisk = JSON.parse(await readFile(join(root, 'awesome-market', 'meta.json'), 'utf8'));
    ok(
      '双源聚合：meta.second 落盘 version/etag/source 指向不可变地址',
      metaOnDisk.second &&
        metaOnDisk.second.version === SECOND_V_A &&
        metaOnDisk.second.etag === '"etag-s1"' &&
        metaOnDisk.second.source === secondPinnedUrlOf(SECOND_V_A),
      JSON.stringify(metaOnDisk.second),
    );
    const secondOnDisk = JSON.parse(await readFile(join(root, 'awesome-market', 'second.json'), 'utf8'));
    ok(
      '双源聚合：second.json 落盘适配条目（含重复条目，去重只在服务时）',
      Array.isArray(secondOnDisk) && secondOnDisk.length === 2 && secondOnDisk.every((e) => e.status === 'verified'),
    );
    const detailSecond = await wbAwesomeDetail('second-only', { rootDir: root });
    ok('双源聚合：detail 能命中第二源条目', detailSecond !== null && detailSecond.npm === 'pkg-second');
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

// ── 18. 双源独立容错：源2挂 → 主源目录照常；源1挂有缓存 → 合并缓存 stale 回落 ──
{
  // 18a. 源2整体失败（默认屏蔽）：目录 = 主源独有，second.json 不落盘，meta.second 为 null。
  {
    const root = await freshRoot();
    const restore = mockFetch(async (url) => {
      if (url === API_URL) return jsonResponse({ sha: SHA_A }, '"sha-api"');
      if (url !== pinnedUrlOf(SHA_A)) throw new Error('unexpected url ' + url);
      return jsonResponse({ updated: '2026-10-24', plugins: [rawEntry({ name: 'primary-solo' })] }, '"etag-solo"');
    });
    try {
      const result = await wbAwesomeCatalog({ rootDir: root });
      ok(
        '源2挂：主源目录照常加载（network）',
        result.ok === true && result.loadedFrom === 'network' && result.counts.total === 1,
      );
      const metaOnDisk = JSON.parse(await readFile(join(root, 'awesome-market', 'meta.json'), 'utf8'));
      ok('源2挂：meta.second 为 null', metaOnDisk.second === null);
      ok('源2挂：second.json 不落盘', !(await readdir(join(root, 'awesome-market'))).includes('second.json'));
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }
  // 18b. 源1挂但两缓存都在：refresh 全挂 → disk stale，返回的仍是合并目录。
  {
    const root = await freshRoot();
    await seedCache(root, { resolvedSha: SHA_A });
    await writeFile(
      join(root, 'awesome-market', 'second.json'),
      JSON.stringify(adaptSecondEntries([secondRawEntry({ name: 'second-seeded', npm: 'pkg-seeded-2' })])),
      'utf8',
    );
    const restore = mockFetch(async () => {
      throw new Error('all sources down');
    });
    try {
      const result = await wbAwesomeCatalog({ rootDir: root, refresh: true });
      const names = result.plugins.map((entry) => entry.name);
      ok(
        '源1挂有缓存：disk stale 回落仍是合并目录',
        result.ok === true &&
          result.stale === true &&
          result.loadedFrom === 'disk' &&
          names.includes('seeded-one') &&
          names.includes('second-seeded'),
        names.join(','),
      );
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }
}

// ── 19. updateCheck 双源口径：任一版本前进即报更新 / 双双一致才 up-to-date ──────
{
  // 19a. 源1同 SHA、源2版本前进 → update-available。
  {
    const root = await freshRoot();
    await seedCache(root, {
      resolvedSha: SHA_A,
      etag: '"etag-x"',
      second: { version: SECOND_V_A, etag: '"etag-s2"', source: secondPinnedUrlOf(SECOND_V_A) },
    });
    const restore = mockFetch(
      async (url) => {
        if (url === API_URL) return jsonResponse({ sha: SHA_A }, '"sha-api"');
        if (url === SECOND_API_URL) return jsonResponse({ version: SECOND_V_B }, '"v-api"');
        throw new Error('unexpected url ' + url);
      },
      { second: true },
    );
    try {
      const result = await wbAwesomeUpdateCheck({ rootDir: root });
      ok(
        'updateCheck 双源：源2版本前进 → update-available',
        result.ok === true && result.hasUpdate === true && result.reason === 'update-available',
      );
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }
  // 19b. 源1 SHA 前进、源2同版本 → update-available（独立根避开双备忘）。
  {
    const root = await freshRoot();
    await seedCache(root, {
      resolvedSha: SHA_A,
      etag: '"etag-x"',
      second: { version: SECOND_V_A, etag: '"etag-s2"', source: secondPinnedUrlOf(SECOND_V_A) },
    });
    const restore = mockFetch(
      async (url) => {
        if (url === API_URL) return jsonResponse({ sha: SHA_B }, '"sha-api"');
        if (url === SECOND_API_URL) return jsonResponse({ version: SECOND_V_A }, '"v-api"');
        throw new Error('unexpected url ' + url);
      },
      { second: true },
    );
    try {
      const result = await wbAwesomeUpdateCheck({ rootDir: root });
      ok(
        'updateCheck 双源：源1 SHA 前进 → update-available',
        result.ok === true && result.hasUpdate === true && result.reason === 'update-available',
      );
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }
  // 19c. 双双一致 → up-to-date，零 CDN 探测。
  {
    const root = await freshRoot();
    await seedCache(root, {
      resolvedSha: SHA_A,
      etag: '"etag-x"',
      second: { version: SECOND_V_A, etag: '"etag-s2"', source: secondPinnedUrlOf(SECOND_V_A) },
    });
    let cdnSaw = '';
    const restore = mockFetch(
      async (url) => {
        if (url === API_URL) return jsonResponse({ sha: SHA_A }, '"sha-api"');
        if (url === SECOND_API_URL) return jsonResponse({ version: SECOND_V_A }, '"v-api"');
        cdnSaw = url;
        throw new Error('双双一致不应发起任何 CDN 探测: ' + url);
      },
      { second: true },
    );
    try {
      const result = await wbAwesomeUpdateCheck({ rootDir: root });
      ok(
        'updateCheck 双源：双双一致 → up-to-date 且零 CDN 探测',
        result.ok === true && result.hasUpdate === false && result.reason === 'up-to-date' && cdnSaw === '',
      );
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }
}

// ── 20. 后台再验证双源未变：零 CDN 下载，fetchedAt 推新 ───────────────────────
{
  const root = await freshRoot();
  await seedCache(root, {
    resolvedSha: SHA_A,
    second: { version: SECOND_V_A, etag: '"etag-s2"', source: secondPinnedUrlOf(SECOND_V_A) },
  });
  await writeFile(
    join(root, 'awesome-market', 'second.json'),
    JSON.stringify(adaptSecondEntries([secondRawEntry({ name: 'second-live', npm: 'pkg-live-2' })])),
    'utf8',
  );
  let cdnHits = 0;
  const restore = mockFetch(
    async (url) => {
      if (url === API_URL) return jsonResponse({ sha: SHA_A }, '"sha-api"');
      if (url === SECOND_API_URL) return jsonResponse({ version: SECOND_V_A }, '"v-api"');
      cdnHits += 1;
      throw new Error('双源未变不应发起任何 CDN 下载: ' + url);
    },
    { second: true },
  );
  try {
    const first = await wbAwesomeCatalog({ rootDir: root });
    ok(
      '双源未变：陈旧合并缓存秒回 + refreshing:true（含第二源条目）',
      first.ok === true &&
        first.loadedFrom === 'cache' &&
        first.refreshing === true &&
        first.plugins.some((e) => e.name === 'second-live'),
    );
    let metaOnDisk = null;
    for (let i = 0; i < 100; i += 1) {
      metaOnDisk = JSON.parse(await readFile(join(root, 'awesome-market', 'meta.json'), 'utf8'));
      if (Number(metaOnDisk.fetchedAt) > 1) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    ok(
      '双源未变：后台推新 fetchedAt 且全程零 CDN 下载',
      Number(metaOnDisk.fetchedAt) > 1 && cdnHits === 0,
      `cdnHits=${cdnHits}`,
    );
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

// ── 21. 源2版本变更：强刷拉新第二源数据，second.json/meta.second 推进 ─────────
{
  const root = await freshRoot();
  await seedCache(root, {
    resolvedSha: SHA_A,
    second: { version: SECOND_V_A, etag: '"etag-s2-old"', source: secondPinnedUrlOf(SECOND_V_A) },
  });
  await writeFile(
    join(root, 'awesome-market', 'second.json'),
    JSON.stringify(adaptSecondEntries([secondRawEntry({ name: 'second-old', npm: 'pkg-old-2' })])),
    'utf8',
  );
  const restore = mockFetch(
    async (url) => {
      if (url === API_URL) return jsonResponse({ sha: SHA_A }, '"sha-api"');
      if (url === SECOND_API_URL) return jsonResponse({ version: SECOND_V_B }, '"v-api"');
      if (url === secondPinnedUrlOf(SECOND_V_B)) throw new Error('simulated primary second-source failure');
      if (url === secondMirrorPinnedUrlOf(SECOND_V_B)) {
        return jsonResponse(
          {
            updated: '2026-10-24',
            plugins: [secondRawEntry({ name: 'second-fresh', npm: 'pkg-fresh-2' })],
          },
          '"etag-s2-new"',
        );
      }
      throw new Error('unexpected url ' + url);
    },
    { second: true },
  );
  try {
    const result = await wbAwesomeCatalog({ rootDir: root, refresh: true });
    ok(
      '源2版本变更：pinned 主镜像挂 → 备镜像接管，合并目录出现新条目（network）',
      result.ok === true && result.loadedFrom === 'network' && result.plugins.some((e) => e.name === 'second-fresh'),
    );
    const metaOnDisk = JSON.parse(await readFile(join(root, 'awesome-market', 'meta.json'), 'utf8'));
    ok(
      '源2版本变更：meta.second 推进到新版本/新 etag/备镜像地址',
      metaOnDisk.second &&
        metaOnDisk.second.version === SECOND_V_B &&
        metaOnDisk.second.etag === '"etag-s2-new"' &&
        metaOnDisk.second.source === secondMirrorPinnedUrlOf(SECOND_V_B),
    );
    const secondOnDisk = JSON.parse(await readFile(join(root, 'awesome-market', 'second.json'), 'utf8'));
    ok(
      '源2版本变更：second.json 换成新数据',
      Array.isArray(secondOnDisk) && secondOnDisk.length === 1 && secondOnDisk[0].name === 'second-fresh',
    );
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
}

console.log(`
${failures === 0 ? 'WB-AWESOME-MARKET PASS' : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
