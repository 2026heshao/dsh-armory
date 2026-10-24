// test/market-pulse.mjs
//
// 护栏对象：市场「最近动静」的快照对比（2026-10-24 用户报：切换页面重新进入市场，
// 最近动静就重复刷出成对的「SkillHub 新增 20 条 / 移除 20 条」，且每次进市场都再来一对）。
//
// 根因（实测，不是推测）：技能侧的记录条件挑错了基线。v1 只在「第 1 页 + 无搜索词 +
// sort=downloads」时记快照，而 `downloads` 这一档**根本不给上游发 sortBy**（见
// lib/wb-market.js 的 SKILLHUB_REMOTE_SORTS：2026-10 实测 sortBy=downloads 会挂到超时）。
// 于是 SkillHub 收到的是无 ORDER BY 的 `LIMIT 20 OFFSET 0` —— 19 万库里每次返回随机 20 条。
// 2026-10-24 直连 api.skillhub.cn 复测：
//   · 同一请求（无 sortBy）隔 2.5 秒两次：重合 0/20；
//   · sortBy=installs 重复请求：重合 20/20；page=1 与 page=2：重合 0/20（说明是稳定全局序）。
// 拿随机切片当基线，每次进市场必然算出「新增 20 / 移除 20」——**恰好等于页大小**，
// 这正是截图里成对出现、且样本名每次全换的原因。被 v1 当成「稳定默认排序」记下来的，
// 是唯一不稳定的那一档；真正稳定的 installs/stars/score 反而被排除在外。
//
// 修复分三层，本套件逐层钉：
//   ① basis（清单身份）：只有同一份清单的两次读取才互相比对。技能侧按排序分档
//      （'skill:installs' …），且默认那档随机序**不再记录**；
//   ② 重合度闸门：同 basis 但两份清单几乎不相交（<10%）时判为「读到的不是同一份清单」，
//      静默换基线、不产事件。这条是通用兜底——上游哪天改了默认排序，或某次响应被截断
//      （443 条只回 3 条），都不该再报出「全增全删」；
//   ③ 存储升 v2：v1 攒下的事件全是假的，读到即整份丢弃。
//
// 手法与 install-toast / tailor-cache-line 同套：把 lib/client.js 的「最近动静」一节
// **源码原文**抽进 node:vm 真跑（配替身 localStorage），对行为断言；接线层用源码针。
// 反向自测在第 4 节：把 v1 语义（忽略 basis、去掉重合度闸门）注回切片，同样的两次读取
// 必须刷出假动静——证明拦住噪音的是那两道闸门，不是测试写空了。
//
// 零网络、零写盘、不碰真实 ~/.dsh。用法：node ./test/market-pulse.mjs

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 仓库路径含中文，必须走 fileURLToPath —— URL.pathname 是百分号编码的。
const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "..", "lib", "client.js");

let failures = 0;
let checks = 0;
const ok = (name, condition, extra = "") => {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};
const section = (title) => console.log(`\n── ${title} ─────────────────────────────────────────────`);

const client = await readFile(CLIENT, "utf8");

/** 按起止标记抽一段源码原文；标记缺失直接失败，避免「测了个空」。 */
function slice(label, startMarker, endMarker) {
  const first = client.indexOf(startMarker);
  if (first < 0) {
    ok(`定位标记：${label}`, false, `start="${startMarker}"`);
    return null;
  }
  const end = client.indexOf(endMarker, first + startMarker.length);
  if (end <= first) {
    ok(`定位标记：${label} 的结束标记`, false, `end="${endMarker}"`);
    return null;
  }
  ok(`定位标记：${label}`, true);
  return client.slice(first, end);
}

const PULSE_SRC = slice(
  "「最近动静」整节（MARKET_PULSE_KEY → clearMarketPulse）",
  "const MARKET_PULSE_KEY = KEY_PREFIX",
  "// 子组件（专家市场）写完备忘录后",
);
// 技能侧的接线：loadSkills 函数体，直到它下面那个挂载 effect 的开头。
const SKILL_SRC = slice(
  "loadSkills（技能目录读取与快照记录接线）",
  "const loadSkills = useCallback(async (page, sort, keyword) => {",
  "  useEffect(() => {",
);
if (!PULSE_SRC || !SKILL_SRC) {
  console.log("\nMARKET-PULSE FAIL（标记缺失，无法抽取待测源码）");
  process.exit(1);
}

// ── 替身与装载 ───────────────────────────────────────────────────────────────
/** 最小 localStorage 替身：Map 后端，另留 throwOn 开关模拟无痕模式。 */
function makeStorage(initial = {}, throwOn = null) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem(key) {
      if (throwOn === key) throw new Error("SecurityError");
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      if (throwOn === key) throw new Error("QuotaExceededError");
      map.set(key, String(value));
    },
    removeItem(key) {
      if (throwOn === key) throw new Error("SecurityError");
      map.delete(key);
    },
  };
}

/**
 * 在 vm 里真跑「最近动静」一节。`patch` 只用于反向自测（把旧语义注回去）。
 * 末行表达式：脚本顶层 const 不挂到 context 上，只能靠 completion value 取回作用域绑定。
 */
function loadPulse(storage, patch = null) {
  const ctx = vm.createContext({ KEY_PREFIX: "dsh-armory", t: (s) => s, localStorage: storage, console });
  const code = `${patch || PULSE_SRC}\n({ readMarketPulse, writeMarketPulse, recordMarketSnapshot, clearMarketPulse, MARKET_PULSE_KEY, LEGACY_MARKET_PULSE_KEY, MARKET_PULSE_MIN_OVERLAP, MARKET_PULSE_MAX_EVENTS });`;
  return vm.runInContext(code, ctx, { filename: patch ? "market-pulse-mutated.js" : "market-pulse.js" });
}

const rows = (keys, sig = "1.0.0") => keys.map((key) => ({ key, name: key + " 名", sig }));
const eventsOf = (api) => api.readMarketPulse().events;
const kindsOf = (api) => eventsOf(api).map((e) => `${e.source}:${e.kind}:${e.count}`).join(" ");

// ═══════════════════════════════════════════════════════════════════════════
// 第 1 节 · 行为主体：可比才比，不可比就闭嘴
// ═══════════════════════════════════════════════════════════════════════════
section("1. 快照对比：首次起底 / 重复读取 / 真实变化");

{
  const api = loadPulse(makeStorage());
  ok("1a 首次记录不产事件（没有基线就没有「动静」，也不报「全部新增」）",
    api.recordMarketSnapshot("connector", rows(["a", "b", "c"])) === false && eventsOf(api).length === 0);
  const snap = api.readMarketPulse().snapshots.connector;
  ok("1b 首次记录写入了基线，且带 basis（默认 full）",
    !!snap && !!snap.items && Object.keys(snap.items).length === 3 && snap.basis === "full",
    `basis=${snap && snap.basis}`);

  // 这就是用户报的那一条：切走再回来，同一份清单被重新读一遍。
  const again = api.recordMarketSnapshot("connector", rows(["a", "b", "c"]));
  ok("1c 同一份清单重复读取 → 不产事件（「重新进入不重复」的直接断言）",
    again === false && eventsOf(api).length === 0);

  // 第三次：真变了 1 增 1 删。
  const changed = api.recordMarketSnapshot("connector", rows(["a", "b", "d"]));
  ok("1d 真实变化仍然报得出：1 增 1 删 → 恰好 2 条事件",
    changed === true && eventsOf(api).length === 2, kindsOf(api));
  const added = eventsOf(api).find((e) => e.kind === "added");
  const removed = eventsOf(api).find((e) => e.kind === "removed");
  ok("1e 事件计数与样本名取自真实差异（新增 d / 移除 d 名）",
    added?.count === 1 && added?.names?.join() === "d 名" && removed?.count === 1 && removed?.names?.join() === "c 名",
    `added=${JSON.stringify(added && added.names)} removed=${JSON.stringify(removed && removed.names)}`);

  // 签名变化（版本 / 核验状态）单独算一种动静，热门度不进签名。
  api.recordMarketSnapshot("connector", rows(["a", "b", "d"]));
  ok("1f 同一条目改签名 → 记 updated，且不误报增删",
    eventsOf(api).filter((e) => e.kind === "updated").length === 0);
  api.recordMarketSnapshot("connector", rows(["a", "b"], "2.0.0").concat([{ key: "d", name: "d 名", sig: "9.9.9" }]));
  ok("1g 版本签名变化 → 新增 updated 事件（累计 3 条）",
    eventsOf(api).filter((e) => e.kind === "updated").length === 1 && eventsOf(api).length === 3, kindsOf(api));
}

section("2. 不可比读取：换 basis / 切片全不相交 / 响应被截断");

{
  const api = loadPulse(makeStorage());
  // 2a —— 修复的核心：installs 的 Top20 与 stars 的 Top20 是两个集合，互比等于造假。
  const pageA = ["s1", "s2", "s3", "s4", "s5"];
  const pageB = ["t1", "t2", "t3", "t4", "t5"];
  api.recordMarketSnapshot("skill", rows(pageA), { basis: "skill:installs" });
  const switched = api.recordMarketSnapshot("skill", rows(pageB), { basis: "skill:stars" });
  ok("2a 换排序（basis 不同）→ 静默换基线，不产任何事件",
    switched === false && eventsOf(api).length === 0, kindsOf(api));
  ok("2b 换基线后确实写入了新 basis（不是把记录整个跳过）",
    api.readMarketPulse().snapshots.skill.basis === "skill:stars");
  const backToA = api.recordMarketSnapshot("skill", rows(pageA), { basis: "skill:installs" });
  ok("2c 再换回去同样不比（每个 basis 各自起底）",
    backToA === false && eventsOf(api).length === 0);

  // 2d —— 同 basis 但整批不相交：判为「读到的不是同一份清单」。
  const rand = loadPulse(makeStorage());
  rand.recordMarketSnapshot("skill", rows(pageA), { basis: "skill:installs" });
  const rolled = rand.recordMarketSnapshot("skill", rows(pageB), { basis: "skill:installs" });
  ok("2d 同 basis 但键全不相交（随机序 / 上游换默认排序）→ 不产事件",
    rolled === false && eventsOf(rand).length === 0, kindsOf(rand));
  ok("2e 不可比读取仍把基线换新（否则该源会永久对着老基线比）",
    Object.keys(rand.readMarketPulse().snapshots.skill.items).join() === pageB.join());
  const afterRoll = rand.recordMarketSnapshot("skill", rows(pageB.concat("t6")), { basis: "skill:installs" });
  ok("2f 换新基线后，下一次真实变化照常报得出来（闸门没把整条链焊死）",
    afterRoll === true && eventsOf(rand).length === 1 && eventsOf(rand)[0].kind === "added", kindsOf(rand));

  // 2g —— 截断的部分响应：443 条只回 3 条，绝不能报「移除 440 条」。
  const big = Array.from({ length: 443 }, (_, i) => "c" + i);
  const trunc = loadPulse(makeStorage());
  trunc.recordMarketSnapshot("connector", rows(big));
  const partial = trunc.recordMarketSnapshot("connector", rows(big.slice(0, 3)));
  ok("2g 目录被截断（443 → 3）→ 重合度闸门拦住「移除 440 条」",
    partial === false && eventsOf(trunc).length === 0, kindsOf(trunc));
  ok("2g2 代价说清楚：截断那次已经把基线换成 3 条，所以紧接着的全量读同样不可比（宁少报不假报）",
    Object.keys(trunc.readMarketPulse().snapshots.connector.items).length === 3 &&
    trunc.recordMarketSnapshot("connector", rows(big.concat("newcomer"))) === false &&
    eventsOf(trunc).length === 0);

  // 2h —— 闸门不能误伤正常规模的变化：大目录 +1 是真动静（干净基线，另起一份存储）。
  const grew = loadPulse(makeStorage());
  grew.recordMarketSnapshot("connector", rows(big));
  const addedOne = grew.recordMarketSnapshot("connector", rows(big.concat("newcomer")));
  ok("2h 443 → 444 的真实新增照样报出 1 条 added",
    addedOne === true && eventsOf(grew).length === 1 && eventsOf(grew)[0].count === 1, kindsOf(grew));
}

// ═══════════════════════════════════════════════════════════════════════════
// 第 3 节 · 存储语义：v1 丢弃、TTL、条数上限、存储不可用降级
// ═══════════════════════════════════════════════════════════════════════════
section("3. 存储：v2 键 / 丢弃 v1 脏数据 / TTL / 上限 / 无痕降级");

{
  const api = loadPulse(makeStorage());
  ok("3a 键已升到 v2", api.MARKET_PULSE_KEY === "dsh-armory.marketPulse.v2", `实际=${api.MARKET_PULSE_KEY}`);

  // v1 里全是假动静：读一次就得把它清掉，且不能把旧事件并进列表。
  const polluted = makeStorage({
    "dsh-armory.marketPulse.v1": JSON.stringify({
      version: 1,
      snapshots: { skill: { at: Date.now(), items: { x: { s: "1", n: "x" } } } },
      events: Array.from({ length: 8 }, (_, i) => ({ id: "e" + i, source: "skill", kind: i % 2 ? "added" : "removed", count: 20, names: ["x"], at: Date.now() })),
    }),
  });
  const v2 = loadPulse(polluted);
  const afterRead = v2.readMarketPulse();
  ok("3b 读到即丢弃 v1 键（用户不必手点「清除」也不会再看到那 8 条假动静）",
    polluted.map.has("dsh-armory.marketPulse.v1") === false);
  ok("3c v1 的事件与基线不会被带进 v2",
    afterRead.events.length === 0 && Object.keys(afterRead.snapshots).length === 0);
  ok("3d 版本校验按 v2 走（v1 结构的 JSON 落在新键上也不认）",
    (() => {
      const s = makeStorage({ "dsh-armory.marketPulse.v2": JSON.stringify({ version: 1, snapshots: {}, events: [{ id: "z", source: "skill", kind: "added", count: 20, names: [], at: Date.now() }] }) });
      return loadPulse(s).readMarketPulse().events.length === 0;
    })());

  // CodeBuddy 插件源已移除：旧快照与历史事件读出即丢，其它来源不受影响。
  const legacySource = makeStorage({
    "dsh-armory.marketPulse.v2": JSON.stringify({
      version: 2,
      snapshots: {
        plugin: { at: Date.now(), basis: "full", items: { p1: { s: "1", n: "p1" } } },
        connector: { at: Date.now(), basis: "full", items: { c1: { s: "1", n: "c1" } } },
      },
      events: [
        { id: "p", source: "plugin", kind: "added", count: 3, names: ["p"], at: Date.now() },
        { id: "a", source: "awesome", kind: "added", count: 2, names: ["a"], at: Date.now() },
      ],
    }),
  });
  const pruned = loadPulse(legacySource).readMarketPulse();
  ok("3d2 旧 source='plugin' 的快照与事件读出即丢，其余来源保留",
    !pruned.snapshots.plugin && !!pruned.snapshots.connector && pruned.events.map((e) => e.id).join() === "a",
    `events=${pruned.events.map((e) => e.id).join()}`);
  ok("3d3 旧快照键不会出现在任何后续投影里（点不进去的历史条目彻底清掉）",
    !Object.prototype.hasOwnProperty.call(pruned.snapshots, "plugin"));

  // TTL：7 天前的条目不显示（写回去时一并淘汰）。
  const aged = makeStorage({
    "dsh-armory.marketPulse.v2": JSON.stringify({
      version: 2, snapshots: {},
      events: [
        { id: "old", source: "skill", kind: "added", count: 3, names: [], at: Date.now() - 8 * 24 * 3600 * 1000 },
        { id: "new", source: "skill", kind: "added", count: 3, names: [], at: Date.now() - 60 * 1000 },
      ],
    }),
  });
  const ttl = loadPulse(aged);
  ok("3e 超过 7 天的事件不再出现（读出来就只剩 1 条）",
    ttl.readMarketPulse().events.map((e) => e.id).join() === "new",
    `实际=${ttl.readMarketPulse().events.map((e) => e.id).join()}`);

  // 上限：反复变化 5 次 = 10 条事件，只留最近 8 条。
  const capped = loadPulse(makeStorage());
  const halfSwap = ["k0", "k1", "k2", "k3", "k4"];
  const otherHalf = ["k3", "k4", "k5", "k6", "k7"]; // 与上一份重合 2/7 ≥ 10%，闸门放行
  capped.recordMarketSnapshot("expert", rows(halfSwap));
  for (let i = 0; i < 5; i += 1) capped.recordMarketSnapshot("expert", rows(i % 2 ? halfSwap : otherHalf));
  ok("3f 事件数封顶 8 条（列表不会无限增长）",
    eventsOf(capped).length === api.MARKET_PULSE_MAX_EVENTS && api.MARKET_PULSE_MAX_EVENTS === 8,
    `实际=${eventsOf(capped).length}`);

  // 无痕 / 配额：读写全抛，只要求「不炸且不产事件」。
  const denied = loadPulse(makeStorage({}, "dsh-armory.marketPulse.v2"));
  ok("3g localStorage 抛错时静默降级：记录返回 false，不产事件、不抛异常",
    denied.recordMarketSnapshot("expert", rows(["a", "b"])) === false && eventsOf(denied).length === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// 第 4 节 · 接线层：技能侧不再拿随机切片当基线
// ═══════════════════════════════════════════════════════════════════════════
section("4. 接线：loadSkills 的快照记录条件");

{
  ok("4a 随机序那一档（downloads）被排除在记录之外：源码含 sort !== 'downloads'",
    SKILL_SRC.includes("sort !== 'downloads'"));
  ok("4b 旧写法（把 downloads 当成唯一可记的默认排序）不得复活",
    !SKILL_SRC.includes("sort === 'downloads'"));
  ok("4c 仍然只记第 1 页、且无搜索词（翻页与搜索切片一律不比）",
    SKILL_SRC.includes("page === 1") && SKILL_SRC.includes("!String(keyword || '').trim()"));
  ok("4d basis 按排序分档传入（'skill:' + sort），并作为第三个参数交给 recordMarketSnapshot",
    /'skill:'\s*\+\s*sort/.test(SKILL_SRC) && SKILL_SRC.includes("{ basis: skillPulseBasis }"));
  ok("4e 空 basis（不可记的那一档）直接短路，不调用记录",
    SKILL_SRC.includes("if (skillPulseBasis && recordMarketSnapshot("));
  // 其它三个来源都是整份目录，必须继续走默认 basis —— 别把修复做成「只有技能有基线」。
  ok("4f 连接器 / awesome / 专家仍按整份目录记录（默认 basis=full）",
    client.includes("recordMarketSnapshot('connector', rows.map") &&
    client.includes("recordMarketSnapshot('awesome', catalog.map") &&
    client.includes("recordMarketSnapshot('expert', data.experts.map"));
  ok("4g CodeBuddy 插件源已移除：不再记录 source='plugin' 的快照",
    !client.includes("recordMarketSnapshot('plugin'"));
}

// ═══════════════════════════════════════════════════════════════════════════
// 第 5 节 · 反向自测：注回 v1 语义，同样的读取必须刷出假动静
// ═══════════════════════════════════════════════════════════════════════════
//
// 第 2 节那几条「不产事件」的断言有个共同的空转风险：闸门要是被写成恒不比较（比如
// basis 判断写反、或 recordMarketSnapshot 早早 return false），它们照样全绿。这里把
// v1 语义（忽略 basis、去掉重合度闸门）注回**同一份切片**，喂同样的两次读取，必须
// 刷出成对的「新增 5 / 移除 5」——证明拦住噪音的确实是那两道闸门。
section("5. 反向自测：去掉 basis 与重合度闸门（= v1 语义）必须重新造出假动静");

{
  const GATE_BASIS = "if (!previous || last.basis !== basis) {";
  const GATE_OVERLAP = "if (shared / Math.max(currentKeys.length, previousKeys.length) < MARKET_PULSE_MIN_OVERLAP) {";
  ok("5a 两道闸门的源码针在场（有人改写闸门时本套件会先在这里变红，而不是静默空转）",
    PULSE_SRC.includes(GATE_BASIS) && PULSE_SRC.includes(GATE_OVERLAP));

  const mutated = PULSE_SRC
    .replace(GATE_BASIS, "if (!previous) {")
    .replace(GATE_OVERLAP, "if (false) {");
  ok("5b 变异确实改到了两处（replace 没命中就等于反向自测在空转）",
    mutated !== PULSE_SRC && mutated.includes("if (!previous) {") && mutated.includes("if (false) {"));

  const legacy = loadPulse(makeStorage(), mutated);
  legacy.recordMarketSnapshot("skill", rows(["s1", "s2", "s3", "s4", "s5"]), { basis: "skill:installs" });
  const noisy = legacy.recordMarketSnapshot("skill", rows(["t1", "t2", "t3", "t4", "t5"]), { basis: "skill:installs" });
  // 事件是 unshift 进列表的：先推 added 再推 removed，所以最新的 removed 排在最前。
  ok("5c v1 语义下两次读取刷出成对假动静（移除 5 + 新增 5）",
    noisy === true && kindsOf(legacy) === "skill:removed:5 skill:added:5", kindsOf(legacy));

  // 再证一次「正向」：同一份数据喂给真身切片必须一条都不产。
  const real = loadPulse(makeStorage());
  real.recordMarketSnapshot("skill", rows(["s1", "s2", "s3", "s4", "s5"]), { basis: "skill:installs" });
  real.recordMarketSnapshot("skill", rows(["t1", "t2", "t3", "t4", "t5"]), { basis: "skill:installs" });
  ok("5d 同样两次读取交给修复后的真身 → 0 条事件（与 5c 构成对照组）",
    eventsOf(real).length === 0, kindsOf(real));
}

console.log(`\n共 ${checks} 条断言：PASS ${checks - failures} / FAIL ${failures}`);
if (failures > 0) process.exitCode = 1;
