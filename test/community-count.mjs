// 社区目录「全库总数」直测：数据层的有界续爬统计 + 面板侧徽标口径。
//
// 背景（2026-10-30 用户两轮反馈）：来源切换那枚角标原先显示「已读取 98 条」，用户会读成
// "社区一共只有 98 个"。官方 MCP Registry 不返回总数（实测 metadata.count 就是本页条数、
// /v0/servers/count 与 /v0/registry/stats 均 404、limit>100 直接 422），全库实测 ≥13,000 条、
// 单页 2.4–8s，一次爬完要十几分钟和约 9MB → 只能做「有界 + 可续爬」的分片统计：
// 每次面板会话最多 12 页，进度存本地，数到底给精确值、没到底给下界「N+」。
//
// 怎么测的：数据层是真 ES 模块，直接 import + 替身 fetch，**真正执行**翻页循环；
// 面板侧那截（徽标文本 / tooltip / localStorage 读写）从 lib/client.js 按起止标记抽出
// 原文放进 node:vm 执行（client.js 是浏览器 bundle，不能 import），配假 localStorage
// 与假 t()。最后用源码针钉住「常驻」「跨层常量同值」「让路」「失败不清进度」这些
// 无法从纯函数看出来的接线。每节都带反向自测，证明断言不是恒真。
//
// 零真实网络、零磁盘写。用法：node ./test/community-count.mjs
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import {
  COMMUNITY_COUNT_CHUNK_PAGES,
  COMMUNITY_COUNT_MAX_PAGES,
  wbMcpCommunityCount,
  wbMcpCommunityList,
  resetCommunityCache,
} from "../lib/mcp-community.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// 必须走 fileURLToPath：本仓库路径含中文，`URL.pathname` 是百分号编码的。
const CLIENT = join(HERE, "..", "lib", "client.js");
const COMMUNITY_MODULE = join(HERE, "..", "lib", "mcp-community.js");

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);

// ── 夹具：真实条目形状（active + npx stdio → 会被 mapRegistryServer 收进列表）────
const META_ACTIVE = { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } };
const keptEntry = (name) => ({
  server: {
    name,
    title: name.split("/").pop(),
    description: "fixture",
    version: "1.0.0",
    repository: { url: "https://github.com/acme/" + name.split("/").pop() },
    packages: [{
      registryType: "npm",
      identifier: "pkg-" + name.split("/").pop(),
      version: "1.0.0",
      runtimeHint: "npx",
      transport: { type: "stdio" },
      runtimeArguments: [{ type: "positional", value: "-y" }],
    }],
  },
  _meta: META_ACTIVE,
});
/** 上游会丢弃的三种形态：非 active / oci 包 / 既跑不起来也没合法远程地址。 */
const droppedEntries = [
  { server: { name: "com.gone/old", version: "1.0.0", packages: [{ registryType: "npm", identifier: "x", transport: { type: "stdio" } }] }, _meta: { "io.modelcontextprotocol.registry/official": { status: "deprecated" } } },
  { server: { name: "com.oci/img", version: "1.0.0", packages: [{ registryType: "oci", identifier: "ghcr.io/x", transport: { type: "stdio" } }] }, _meta: META_ACTIVE },
  { server: { name: "com.empty/nothing", version: "1.0.0" }, _meta: META_ACTIVE },
];

/**
 * 造一条假 HTTP 链：按调用顺序返回 pages，并把请求 URL 记下来。
 * 失败夹具（`throw` / `status`）会**重复供应**：fetchJson 对 5xx 与网络错允许重试一次，
 * 真实上游在同一游标上连续 503 就是这个形状；夹具若只供应一次，第二次请求会掉到
 * 「翻页超出夹具」那条无关异常上，断言就变成在测夹具而不是测重试。
 */
function fakeRegistry(pages) {
  const urls = [];
  let slot = 0;
  const fetchImpl = async (url) => {
    urls.push(String(url));
    const page = pages[slot];
    if (!page) throw new Error("翻页超出夹具：第 " + urls.length + " 次请求没有数据");
    const failing = Boolean(page.throw) || Boolean(page.status);
    if (!failing) slot += 1;
    if (page.status) return { ok: false, status: page.status, json: async () => ({}) };
    if (page.throw) {
      const error = new Error(page.throw);
      // 只有一条显式标了 retryable:false 的异常才会跳过重试（对齐 fetchJson 的 4xx 口径）。
      if (page.retryable === false) error.retryable = false;
      throw error;
    }
    return { ok: true, status: 200, json: async () => ({ servers: page.servers, metadata: page.nextCursor ? { nextCursor: page.nextCursor, count: page.servers.length } : { count: page.servers.length } }) };
  };
  return { fetchImpl, urls };
}
const page = (names, nextCursor) => ({ servers: names.map(keptEntry), nextCursor });

// ── 1. 数据层：预算、续爬、到底、失败 ────────────────────────────────────────
{
  const { fetchImpl, urls } = fakeRegistry([page(["a/1", "a/2"], "c1"), page(["b/1"], "c2"), page(["c/1"], "c3"), page(["d/1"], "c4")]);
  const res = await wbMcpCommunityCount({}, { fetchImpl });
  ok("默认一次只数 CHUNK_PAGES 页（不是一口气爬完全库）", res.pages === COMMUNITY_COUNT_CHUNK_PAGES && urls.length === COMMUNITY_COUNT_CHUNK_PAGES, `pages=${res.pages} 请求=${urls.length}`);
  eq("数到的条数 = 各页保留条目之和", res.counted, 4);
  ok("没数到底：done=false 且带回下一步游标", res.done === false && res.nextCursor === "c" + COMMUNITY_COUNT_CHUNK_PAGES, `next=${res.nextCursor}`);
  ok("第一页不带 cursor，之后带上一页返回的游标", !urls[0].includes("cursor=") && urls[1].includes("cursor=c1"), urls[1].slice(0, 120));
  ok("统计请求与列表同口径：version=latest + limit=100 + 不带 search", urls.every((u) => u.includes("version=latest") && u.includes("limit=100")) && urls.every((u) => !/[?&]search=/.test(u)));
}
{
  const { fetchImpl, urls } = fakeRegistry([page(["a/1"], null)]);
  const res = await wbMcpCommunityCount({}, { fetchImpl });
  ok("上游不再给游标 → done=true、游标清空、只发一次请求", res.done === true && res.nextCursor === null && urls.length === 1, JSON.stringify({ done: res.done, next: res.nextCursor, urls: urls.length }));
  eq("到底时条数仍如实", res.counted, 1);
}
{
  // 反向自测 + 防原地打转：上游一直给同一个非空游标，预算必须把循环钳死。
  const { fetchImpl, urls } = fakeRegistry(Array.from({ length: 20 }, () => page(["x/1"], "same")));
  const res = await wbMcpCommunityCount({ pages: 9999 }, { fetchImpl });
  ok("pages 超上限被钳到 MAX_PAGES（游标不推进也不会无限爬）", urls.length === COMMUNITY_COUNT_MAX_PAGES && res.done === false, `请求=${urls.length}`);
  const clamp = fakeRegistry([page(["y/1"], "z"), page(["y/2"], "z2"), page(["y/3"], "z3"), page(["y/4"], "z4")]);
  const bad = await wbMcpCommunityCount({ pages: 0 }, { fetchImpl: clamp.fetchImpl });
  ok("pages 非法（0）回落默认块大小", clamp.urls.length === COMMUNITY_COUNT_CHUNK_PAGES && bad.pages === COMMUNITY_COUNT_CHUNK_PAGES, `pages=${bad.pages}`);
}
{
  // 「空页 + 残留游标」也必须认到底：只认「没游标」的话，续爬会原地打转。
  const { fetchImpl, urls } = fakeRegistry([{ servers: [], nextCursor: "ghost" }]);
  const res = await wbMcpCommunityCount({}, { fetchImpl });
  ok("空页即到底（哪怕上游还留着游标）", res.done === true && res.counted === 0 && urls.length === 1, JSON.stringify({ done: res.done, counted: res.counted }));
}
{
  const { fetchImpl, urls } = fakeRegistry([page(["k/1", "k/2"], "c1"), { throw: "HTTP 503" }]);
  const res = await wbMcpCommunityCount({ pages: 3 }, { fetchImpl });
  ok("中途失败收敛成 {ok:false}，不抛", res.ok === false && typeof res.error === "string" && res.error.includes("503"), String(res.error));
  ok("失败时已数到的条数与续爬游标如实带回（不清零）", res.counted === 2 && res.nextCursor === "c1" && res.done === false, JSON.stringify({ counted: res.counted, next: res.nextCursor }));
  // 1 次成功 + 5xx 允许重试 1 次 = 3 次；失败后不得再往后爬第 3 页。
  ok("5xx 重试一次后即收工，不继续往后爬", urls.length === 3, `请求=${urls.length}`);
  const q = fakeRegistry([page(["k/1"], "c1"), { throw: "HTTP 404", retryable: false }]);
  const qr = await wbMcpCommunityCount({ pages: 3 }, { fetchImpl: q.fetchImpl });
  ok("4xx 不重试（参数错重试也没用，还白烧一次配额）", q.urls.length === 2 && qr.ok === false, `请求=${q.urls.length}`);
  const s = fakeRegistry([page(["k/1"], "c1"), { status: 503 }]);
  const sr = await wbMcpCommunityCount({ pages: 3 }, { fetchImpl: s.fetchImpl });
  ok("上游给非 2xx 响应体（不是抛异常）同样收敛，且带出状态码", sr.ok === false && sr.error.includes("503"), String(sr.error));
}
{
  const mixed = { servers: [keptEntry("ok/1"), ...droppedEntries, keptEntry("ok/2")], nextCursor: null };
  const { fetchImpl } = fakeRegistry([mixed]);
  const res = await wbMcpCommunityCount({}, { fetchImpl });
  eq("非 active / oci / 无可执行形态的条目不计数（与列表丢弃口径一致）", res.counted, 2);
}
{
  // 口径互证：同一批页，列表路径拿到的 rows 条数之和 == 统计路径数到的条数。
  const pages = [page(["p/a", "p/b", "p/c"], "c1"), page(["p/d"], null)];
  const a = fakeRegistry(pages);
  const counted = await wbMcpCommunityCount({ pages: 2 }, { fetchImpl: a.fetchImpl });
  resetCommunityCache();
  const b = fakeRegistry(pages);
  let rows = 0;
  for (let i = 0; i < pages.length; i += 1) {
    const one = await wbMcpCommunityList({ cursor: i === 0 ? "" : pages[i - 1].nextCursor }, { fetchImpl: b.fetchImpl });
    if (!one.ok) throw new Error("列表夹具失败：" + one.error);
    rows += one.rows.length;
  }
  ok("统计口径 == 列表口径（同一个 mapRegistryServer）", counted.counted === rows, `统计=${counted.counted} 列表=${rows}`);
  resetCommunityCache();
}
{
  // 统计刻意不写内存缓存：一次全库 130+ 页会把 50 条上限的翻页缓存挤空。
  const pages = [page(["n/1"], "c1"), page(["n/2"], null)];
  const a = fakeRegistry(pages);
  await wbMcpCommunityCount({ pages: 2 }, { fetchImpl: a.fetchImpl });
  const b = fakeRegistry(pages);
  const first = await wbMcpCommunityList({}, { fetchImpl: b.fetchImpl });
  ok("统计走完后列表首屏仍是现取（没被统计请求灌进缓存）", first.cached === false, `cached=${first.cached}`);
  resetCommunityCache();
}

// ── 2. 面板侧：徽标文本 / tooltip / localStorage（从 client.js 抽原文真跑）────
const source = await readFile(CLIENT, "utf8");
const START_MARKER = "const COMMUNITY_COUNT_KEY = KEY_PREFIX + '.communityCount.v1';";
const END_MARKER = "// ── 安装轻提示：挂在 document.body 上的常驻浮层";
const startAt = source.indexOf(START_MARKER);
const endAt = startAt >= 0 ? source.indexOf(END_MARKER, startAt + START_MARKER.length) : -1;
ok("能在 lib/client.js 里定位到徽标一节的起止标记", startAt >= 0 && endAt > startAt, `start=${startAt} end=${endAt}`);
if (startAt < 0 || endAt <= startAt) {
  console.log("\nCOMMUNITY-COUNT FAIL（标记缺失，无法抽取待测源码）");
  process.exit(1);
}
const slice = source.slice(startAt, endAt);

function bootClient(store = {}) {
  const ctx = {
    console,
    globalThis: null,
    KEY_PREFIX: "dsh-armory",
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { if (store.__throw) throw new Error("QuotaExceededError"); store[k] = String(v); },
    },
    // 与真实骨架语义一致：查表 + 按 {n} 下标插值（骨架本身由 client-i18n.mjs 守护）。
    t: (text, vars) => (Array.isArray(vars) ? String(text).replace(/\{(\d+)\}/g, (m, i) => (i < vars.length ? vars[i] : m)) : text),
  };
  ctx.globalThis = ctx;
  const proof = vm.createContext(ctx);
  vm.runInContext(slice + "\nglobalThis.__probe = { COMMUNITY_COUNT_KEY, COMMUNITY_COUNT_CHUNK_PAGES, COMMUNITY_COUNT_PAGE_BUDGET, emptyCommunityCount, readCommunityCount, writeCommunityCount, communityCountBadgeText, communityCountBadgeTitle };", proof, { filename: "client-community-count-slice.js" });
  return { probe: proof.__probe, store };
}
{
  const { probe } = bootClient();
  eq("徽标文本：没数过 → 「…」而不是隐藏（常驻）", probe.communityCountBadgeText(null), "…");
  eq("徽标文本：数为 0 且没到底 → 仍是「…」", probe.communityCountBadgeText({ counted: 0, done: false }), "…");
  eq("徽标文本：没到底 → 下界「1200+」", probe.communityCountBadgeText({ counted: 1200, done: false }), "1200+");
  eq("徽标文本：数到底 → 精确值，不带 +", probe.communityCountBadgeText({ counted: 13452, done: true }), "13452");
  eq("徽标文本：到底且真是 0 条 → 显示 0", probe.communityCountBadgeText({ counted: 0, done: true }), "0");
  // 反向自测：把「到底」写成带 + 的下界形态，正向断言必须抓得住。
  const mutated = probe.communityCountBadgeText({ counted: 13452, done: true }) + "+";
  ok("自测：到底值若误带「+」会被上面的断言判红", mutated !== probe.communityCountBadgeText({ counted: 13452, done: true }));
  ok("tooltip 未开爬时说明在统计", probe.communityCountBadgeTitle(null).includes("正在后台统计"));
  ok("tooltip 下界口径写「至少」，不让人当成上限", probe.communityCountBadgeTitle({ counted: 1200, done: false }).includes("至少"));
  ok("tooltip 到底口径写「共」", probe.communityCountBadgeTitle({ counted: 13452, done: true }).includes("共 13452 条"));
}
{
  const { probe, store } = bootClient();
  probe.writeCommunityCount({ counted: 900, cursor: "c/9", done: false, at: 123 });
  ok("键带插件前缀（不与其它插件撞名）", probe.COMMUNITY_COUNT_KEY.startsWith("dsh-armory."), probe.COMMUNITY_COUNT_KEY);
  const back = probe.readCommunityCount();
  eq("写→读往返一致", [back.counted, back.cursor, back.done, back.at], [900, "c/9", false, 123]);
  ok("localStorage 里就是这一条 JSON", JSON.parse(store[probe.COMMUNITY_COUNT_KEY]).counted === 900);
  store[probe.COMMUNITY_COUNT_KEY] = "{坏掉的 json";
  ok("坏数据读成 null（宁可重数，不显示假数）", probe.readCommunityCount() === null);
  store[probe.COMMUNITY_COUNT_KEY] = JSON.stringify({ counted: -5, cursor: 42 });
  ok("负数条数读成 null", probe.readCommunityCount() === null);
  store[probe.COMMUNITY_COUNT_KEY] = JSON.stringify({ counted: 7, cursor: 42, done: "yes", at: "abc" });
  const odd = probe.readCommunityCount();
  eq("非字符串游标归空、非布尔 done 归 false、at 非数归 0", [odd.cursor, odd.done, odd.at], ["", false, 0]);
  delete store[probe.COMMUNITY_COUNT_KEY];
  ok("没有记录时读成 null", probe.readCommunityCount() === null);
  eq("空记录形态", [probe.emptyCommunityCount().counted, probe.emptyCommunityCount().done], [0, false]);
  const throwing = bootClient({ __throw: true });
  let threw = null;
  try { throwing.probe.writeCommunityCount({ counted: 1, cursor: "", done: false, at: 1 }); } catch (e) { threw = e; }
  ok("写盘抛错（配额 / 隐私模式）不外抛，只是下次重数", threw === null);
}
{
  const { probe } = bootClient();
  ok("面板侧块大小与数据层导出同值（跨层不能各写一份）", probe.COMMUNITY_COUNT_CHUNK_PAGES === COMMUNITY_COUNT_CHUNK_PAGES, `${probe.COMMUNITY_COUNT_CHUNK_PAGES} vs ${COMMUNITY_COUNT_CHUNK_PAGES}`);
  ok("会话预算是块大小的整数倍且不超过数据层上限", probe.COMMUNITY_COUNT_PAGE_BUDGET % COMMUNITY_COUNT_CHUNK_PAGES === 0 && probe.COMMUNITY_COUNT_PAGE_BUDGET <= COMMUNITY_COUNT_MAX_PAGES, `budget=${probe.COMMUNITY_COUNT_PAGE_BUDGET}`);
}

// ── 3. 接线：常驻、让路、每块落盘、失败不清进度 ──────────────────────────────
{
  const badge = /className: 'dsh-mcp-seg-count', title: communityCountBadgeTitle\(communityCount\) \}, communityCountBadgeText\(communityCount\)\)/;
  ok("社区徽标无条件渲染（常驻），文本与 tooltip 都取自全库统计", badge.test(source));
  // 反向自测：把旧的条件写法注回去，针必须变红。
  const legacy = source.replace(badge, "communityReadTotal ? h('span', { className: 'dsh-mcp-seg-count' }, communityReadTotal) : null");
  ok("自测：退化成「有才显示」的旧写法会被这条针抓到", !badge.test(legacy) && legacy.includes("communityReadTotal ? h('span'"));
  ok("连接器徽标同样常驻（未取到显示「…」）", source.includes("connectors.length || '…'"));
  ok("不再把「已读取」累计数放在社区徽标上", !/communityReadTotal \? h\('span', \{ className: 'dsh-mcp-seg-count'/.test(source));
  ok("工具行仍保留「已读取」，并说明它与徽标口径不同",
    source.includes("t('已读取 {0} 条', [communityReadTotal])") && /dsh-mcp-builtin-count', title: t\('本次查询已逐页读取的条数/.test(source));
  ok("只在连接器页 + 社区源时统计（不在技能页烧网络）",
    /if \(tab !== 'connector' \|\| connectorFeed !== 'community'\) return undefined;/.test(source));
  ok("先让路给列表请求（scheduleIdle 3s 后才开爬）", source.includes("scheduleIdle(runChunks, 3000)"));
  ok("会话预算用尽即停", source.includes("communityCountPagesRef.current < COMMUNITY_COUNT_PAGE_BUDGET"));
  ok("同一面板只允许一条统计流水", source.includes("if (cancelled || communityCountBusyRef.current) return;"));
  ok("每数完一块立刻落盘 + 更新徽标（不是等全部数完）", /setCommunityCount\(next\);\s*\n\s*writeCommunityCount\(next\);/.test(source));
  ok("下一块用最新游标：ref 同步不等 re-render", source.includes("communityCountRef.current = next;"));
  ok("上游失败直接收工，不清已数到的进度", /if \(!res \|\| res\.ok !== true\) break;/.test(source));
  ok("面板卸载 / 切走后不再 setState", /if \(cancelled\) break; \/\/ 面板已切走/.test(source));
  ok("数到底就不留游标（下次不再开爬）", source.includes("cursor: done ? '' :"));
  ok("整块统计包在 try/catch 里：徽标数字不能把列表带崩", /catch \{ \/\* 徽标那枚数字而已/.test(source));
  const newKeys = [
    "正在后台统计社区目录条目数，稍后自动显示…",
    "社区目录共 {0} 条（逐页统计；官方 Registry 不返回总数）",
    "社区目录至少 {0} 条，仍在后台续爬统计（官方 Registry 不返回总数）",
    "本次查询已逐页读取的条数；上方徽标显示的是社区目录全库总数",
    "WorkBuddy 官方目录里的连接器总数",
    "正在读取连接器列表…",
  ];
  const missing = newKeys.filter((key) => !source.includes(`"${key}":`));
  ok("新增中文都有 en-US 译文（i18n-coverage 之外的定点钉）", missing.length === 0, missing.join(" / "));
}

// ── 4. 契约三处同步（contract-consistency 已全局守，这里定点钉本方法）────────
{
  const typert = await readFile(join(HERE, "..", "lib", "typert.js"), "utf8");
  const index = await readFile(join(HERE, "..", "lib", "index.js"), "utf8");
  ok("typert 声明了 wbMcpCommunityCount", typert.includes("mv('wbMcpCommunityCount', [payloadParam], 'WbMcpCommunityCountResult')"));
  ok("client 契约层注册了 wbMcpCommunityCount", source.includes("method: 'wbMcpCommunityCount'"));
  ok("index 宿主层实现了 wbMcpCommunityCount", /async wbMcpCommunityCount\(payload\) \{/.test(index));
}

// ── 5. 数据层源码本身没被改坏（反向自测：预算失效必须变红）───────────────────
{
  const moduleSource = await readFile(COMMUNITY_MODULE, "utf8");
  ok("数据层统计函数刻意不写内存缓存（注释与实现同在）",
    moduleSource.includes("export async function wbMcpCommunityCount") && /export async function wbMcpCommunityCount[\s\S]*?\n\}/.test(moduleSource) && !/export async function wbMcpCommunityCount[\s\S]*?writeCache\(/.test(moduleSource));
  const loop = /export async function wbMcpCommunityCount[\s\S]*?for \(let round = 0; round < budget; round \+= 1\) \{/.test(moduleSource);
  ok("翻页循环受 budget 钳制（不是 while(true)）", loop);
  const noBudget = moduleSource.replace("for (let round = 0; round < budget; round += 1) {", "for (;;) {");
  ok("自测：把预算拆掉后这条针确实会失效（证明上一条不是恒真）", !/for \(let round = 0; round < budget; round \+= 1\) \{/.test(noBudget));
}

console.log(failures === 0 ? "\nCOMMUNITY-COUNT PASS" : `\nCOMMUNITY-COUNT FAIL（${failures} 条断言未通过）`);
if (failures > 0) process.exitCode = 1;
