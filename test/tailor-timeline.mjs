// test/tailor-timeline.mjs
//
// 护栏对象：清单 6.1 / 6.2 / 6.3 / 6.4「工具裁缝的税要有时间维度与归因」。
//
// 背景（这是一次真实排查的产物，不是假想需求）：用户反馈「消耗 token 的数字这几天没变」，
// 而 `taxTotalTokens` / `deadMcpTaxTokens` 是**当前注册表 Schema 长度的纯函数**，与时间完全
// 无关 —— 于是「真没改过注册表」和「界面读不出变化」在屏幕上长得一模一样，谁也无法自证。
// 本套件钉四件事：
//   1. 真实下发税（request/header）能算出来、能按天采样、能挑出「窗口内清单变过几次」；
//   2. 注册表快照与真实下发的差额（改了没生效）能算对，且没有下发记录时必须是 null 而不是 0
//      ——「不知道」和「差 0」混在一起就会变成一条永不失效的假告警；
//   3. 窗口超出本机日志覆盖时输出必然不变（归因提示的前提），且这个跨度**按窗口**统计；
//   4. 无 time 的事件必须显形（undatedCalls），不许再退化成静默计入任何窗口。
//
// 只用 node: 内置模块，可直接 import 真实文件。
// 用法：node ./test/tailor-timeline.mjs
import zlib from "node:zlib";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { scanSessionLedger } = await import(new URL("../lib/tool-ledger.js", import.meta.url).href);

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (condition) {
    console.log(`PASS  ${name}${extra ? `  ${extra}` : ""}`);
  } else {
    failures += 1;
    console.log(`FAIL  ${name}${extra ? `  ${extra}` : ""}`);
  }
};
const info = (name, extra = "") => console.log(`INFO  ${name}${extra ? `  ${extra}` : ""}`);

// ── 隔离：账本只认 DSH_SKILL_MCP_BOARD_HOME，绝不碰真实 ~/.dsh ──────────────
const HOME = await mkdtemp(join(tmpdir(), "dsh-tailor-timeline-"));
process.env.DSH_SKILL_MCP_BOARD_HOME = HOME;
const SESSIONS = join(HOME, ".dsh", "sessions");

let sessionSeq = 0;
/** 每节换一个全新路径：账本按日志绝对路径建解压缓存，复用路径会让「首次扫描」不再是首次。 */
async function freshSessions() {
  await rm(SESSIONS, { recursive: true, force: true });
  sessionSeq += 1;
  const dir = join(SESSIONS, `proj-${sessionSeq}`, `session-${sessionSeq}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

const DAY = 86_400_000;
const now = Date.now();
const scan = (over = {}) =>
  scanSessionLedger({ days: 30, mcpServerNames: [], schemas: [], disabledServers: new Set(), ...over });

const callLine = (name, callId, time) =>
  `${JSON.stringify({ type: "tool/call", time, data: { callId, name, turn: 1, step: 1 } })}\n`;
/** 一次请求真实下发的整份工具清单 —— 税的时间维度就来自这里。 */
const headerLine = (tools, time) =>
  `${JSON.stringify({ type: "request/header", time, data: { header: { tools } } })}\n`;
const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, "utf8"));
const writeLog = async (dir, text) => writeFile(join(dir, "session.1.zstd"), Buffer.concat([frame(text)]));

const tool = (name, desc) => ({ name, description: desc, parameters: { type: "object" } });
/**
 * 独立复算一份税，作为「投影口径」的规格说明：键集合必须是 {name, description, parameters}，
 * description 缺省补空串、parameters 缺省补 null。任何一侧改口径都必须同时改这里，
 * 否则「注册表快照 vs 真实下发」的差额里就混进了口径差。
 */
const taxOf = (t) => Math.ceil(JSON.stringify({ name: t.name, description: t.description || "", parameters: t.parameters ?? null }).length / 4);

// ── 1. 单一清单、多次请求：变化 0 次，今天那一格有数 ─────────────────────────
{
  const dir = await freshSessions();
  const list = [tool("alpha", "甲"), tool("mcp__srv__beta", "乙")];
  const expected = taxOf(list[0]) + taxOf(list[1]);
  await writeLog(dir, headerLine(list, now) + headerLine(list, now - 1000) + callLine("alpha", "c1", now));
  const r = await scan({ days: 1 });
  ok("单一清单：wireTaxChangeCount = 1（同一份清单重复请求不换指纹）", r.wireTaxChangeCount === 1, `实际=${r.wireTaxChangeCount}`);
  ok("单一清单：未截断", r.wireTaxTruncated === false);
  ok("单一清单：逐日税今天那一格等于两份 Schema 之和", r.wireTaxDaily[0] === expected, `实际=${r.wireTaxDaily[0]} 期望=${expected}`);
  ok("单一清单：wireTaxDaily 长度随窗口", r.wireTaxDaily.length === 1, `长度=${r.wireTaxDaily.length}`);
  ok("单一清单：latest 报出工具数与税", r.wireTaxLatest && r.wireTaxLatest.toolCount === 2 && r.wireTaxLatest.tokens === expected, JSON.stringify(r.wireTaxLatest));
  ok("单一清单：快照只有一条", r.wireTaxSnapshots.length === 1);
  // 主数字口径必须仍然是注册表快照 —— 这次改动不能把 taxTotalTokens 换成日志值。
  const r2 = await scan({ days: 1, schemas: list });
  ok("taxTotalTokens 仍来自注册表快照（不是日志真实下发）", r2.taxTotalTokens === expected, `实际=${r2.taxTotalTokens}`);
  ok("快照与线上一致时差额为 0（不是 null）", r2.wireTaxDivergenceTokens === 0, `实际=${r2.wireTaxDivergenceTokens}`);
}

// ── 2. 清单跨天变化：按首次出现排序，latest 取时间最晚那份 ───────────────────
{
  const dir = await freshSessions();
  const small = [tool("alpha", "甲")];
  const big = [tool("alpha", "甲"), tool("beta", "乙"), tool("gamma", "丙")];
  const smallTax = taxOf(small[0]);
  const bigTax = taxOf(big[0]) + taxOf(big[1]) + taxOf(big[2]);
  // 先大后小（故意不按「由小到大」写）：latest/排序不能靠写入顺序凑对。
  await writeLog(dir, headerLine(big, now - 3 * DAY) + headerLine(small, now - DAY) + headerLine(small, now));
  const r = await scan({ days: 7 });
  ok("清单换过：wireTaxChangeCount = 2", r.wireTaxChangeCount === 2, `实际=${r.wireTaxChangeCount}`);
  ok("快照按首次出现时间升序（与写入顺序无关）", r.wireTaxSnapshots.length === 2 && r.wireTaxSnapshots[0].tokens === bigTax && r.wireTaxSnapshots[1].tokens === smallTax,
    JSON.stringify(r.wireTaxSnapshots.map((s) => s.tokens)));
  ok("latest = 时间最晚那份（小清单），不是最大那份", r.wireTaxLatest && r.wireTaxLatest.tokens === smallTax, JSON.stringify(r.wireTaxLatest));
  ok("逐日税只落在有请求的那三天", r.wireTaxDaily.filter((v) => v > 0).length === 3, `非零 ${r.wireTaxDaily.filter((v) => v > 0).length} 格`);
  ok("逐日税：3 天前那格是大清单", r.wireTaxDaily[7 - 1 - 3] === bigTax, `idx=${7 - 1 - 3} 实际=${r.wireTaxDaily[7 - 1 - 3]}`);
  info("两次请求落在不同日桶时的税序列", JSON.stringify(r.wireTaxDaily));
  // 注册表里多了一个没下发的工具 → 差额为正，且数值可核对。
  const r2 = await scan({ days: 7, schemas: [...big, tool("delta", "丁")] });
  ok("注册表比线上大时差额为正、且等于多出来那几份 Schema 的税", r2.wireTaxDivergenceTokens === taxOf(big[1]) + taxOf(big[2]) + taxOf(tool("delta", "丁")), `实际=${r2.wireTaxDivergenceTokens}`);
}

// ── 2b. 反方向：线上清单比注册表快照大（差额必须为负）─────────────────────
// 面板对正负两侧说的话完全不同（「改了没重启」vs「工具挂在别的作用域」），所以两个方向
// 都得有可断言的数：只测一个方向的差额，符号反了也不会被发现。
{
  const dir = await freshSessions();
  const small = [tool("alpha", "甲")];
  const big = [tool("alpha", "甲"), tool("beta", "乙"), tool("gamma", "丙")];
  await writeLog(dir, headerLine(small, now - 3 * DAY) + headerLine(big, now));
  const r = await scan({ days: 7, schemas: small });
  ok("线上比注册表大时 wireTaxLatest 取的是最新那份大清单", r.wireTaxLatest.tokens === taxOf(big[0]) + taxOf(big[1]) + taxOf(big[2]), `实际=${r.wireTaxLatest.tokens}`);
  ok("注册表比线上小时差额为负（改了没生效的反方向）", r.wireTaxDivergenceTokens < 0, `实际=${r.wireTaxDivergenceTokens}`);
}


// ── 3. 没有注册表 Schema 时，差额必须是 null 而不是 0 ───────────────────────
// 「不知道」与「一致」混成 0，界面那条归因提示就会变成一条永不失效的假告警。
{
  const dir = await freshSessions();
  await writeLog(dir, callLine("alpha", "c1", now));
  const r = await scan({ days: 7, schemas: [] });
  ok("没有真实下发记录时 wireTaxLatest 为 null", r.wireTaxLatest === null, `实际=${JSON.stringify(r.wireTaxLatest)}`);
  ok("没有真实下发记录时差额为 null（不是 0）", r.wireTaxDivergenceTokens === null, `实际=${r.wireTaxDivergenceTokens}`);
  ok("没有 request/header 时逐日税整列 0", r.wireTaxDaily.every((v) => v === 0) && r.wireTaxChangeCount === 0);
}

// ── 4. 畸形 request/header 不能把扫描打挂，也不能记进快照 ───────────────────
{
  const dir = await freshSessions();
  const bad = [
    JSON.stringify({ type: "request/header", time: now, data: {} }) + "\n",
    JSON.stringify({ type: "request/header", time: now, data: { header: {} } }) + "\n",
    JSON.stringify({ type: "request/header", time: now, data: { header: { tools: [] } } }) + "\n",
    // 缺 time：无法归入日桶 → 丢弃（存在性由 undatedCalls 那一路负责显形）。
    JSON.stringify({ type: "request/header", data: { header: { tools: [tool("alpha", "甲")] } } }) + "\n",
  ].join("");
  await writeLog(dir, bad + headerLine([tool("beta", "乙")], now));
  const r = await scan({ days: 7 });
  ok("畸形 header 事件不炸扫描", r.failedFiles === 0 && r.filesRead === 1, `failedFiles=${r.failedFiles}`);
  ok("缺 time 的清单快照不进快照表", r.wireTaxChangeCount === 1, `实际=${r.wireTaxChangeCount}`);
  ok("只有合法清单被记账（工具名是 beta）", r.wireTaxLatest && r.wireTaxLatest.toolCount === 1 && r.wireTaxLatest.tokens === taxOf(tool("beta", "乙")));
}

// ── 5. 无 time 的调用：计入但必须显形（§6.2）───────────────────────────────
{
  const dir = await freshSessions();
  const undated = `${JSON.stringify({ type: "tool/call", data: { callId: "c9", name: "alpha" } })}\n`;
  await writeLog(dir, undated + callLine("beta", "c1", now));
  const r = await scan({ days: 1 });
  ok("无 time 的调用被计入 totalCalls（口径：不能凭空丢数据）", r.totalCalls === 2, `实际=${r.totalCalls}`);
  ok("无 time 的调用进了工具账", r.tools.find((t) => t.name === "alpha")?.calls === 1);
  ok("无 time 的调用记进 undatedCalls（可归因，不再静默）", r.undatedCalls === 1, `实际=${r.undatedCalls}`);
  ok("无 time 的调用不占日桶（它无法定位日期）", r.dailyCalls.length === 1 && r.dailyCalls[0] === 1, `dailyCalls=${JSON.stringify(r.dailyCalls)}`);
  ok("无 time 的调用不进时间跨度", r.scannedEventsOldestMs !== null && r.scannedEventsNewestMs !== null && r.scannedEventsOldestMs === r.scannedEventsNewestMs, `span=${r.scannedEventsOldestMs}..${r.scannedEventsNewestMs}`);
}

// ── 6. 时间跨度按窗口统计，并解释「加长窗口为什么没变化」（§6.3）────────────
{
  const dir = await freshSessions();
  // 「今天」那条刻意留 5 分钟余量：夹具里的 now 早于扫描时的 now（相差几毫秒），刚好压在
  // 1 天窗口的刀口上会让这条断言测到的是取整误差，而不是它想测的「窗口丢掉更早的调用」。
  const today = now - DAY + 5 * 60_000;
  await writeLog(dir, callLine("alpha", "c1", now - 2 * DAY) + callLine("beta", "c2", today) + headerLine([tool("alpha", "甲")], now - 2 * DAY));
  const r30 = await scan({ days: 30 });
  ok("跨度 = 本次读到的最早调用距今约 2 天（round 不是 ceil：2 天前的记录不能印成 3 天）", r30.scannedSpanDays === 2, `实际=${r30.scannedSpanDays}`);
  ok("跨度短于窗口 → 界面归因条件成立（30 天窗口只有 2 天数据）", r30.windowDays > r30.scannedSpanDays);
  const r90 = await scan({ days: 90 });
  // 这是本次排查的核心事实：机器上只有几天日志时，30/90 天窗口必然给出同一张账单。
  // 用户看到「数字没变」时，界面必须能说「因为没有更早的日志」，而不是让人怀疑裁缝坏了。
  ok("窗口加长不改变调用数（数据只有 2 天时 30 与 90 天等价）", r90.totalCalls === r30.totalCalls && r90.scannedSpanDays === r30.scannedSpanDays,
    `calls ${r30.totalCalls}/${r90.totalCalls}，span ${r30.scannedSpanDays}/${r90.scannedSpanDays}`);
  const r1 = await scan({ days: 1 });
  ok("1 天窗口丢掉 2 天前的调用，但跨度仍按读到的最早事件算（=2 > 1，归因不触发）", r1.totalCalls === 1 && r1.scannedSpanDays === 2,
    `calls=${r1.totalCalls} span=${r1.scannedSpanDays}`);
  // §6.1 主口径：税与窗口**必须**无关。这条断言就是用户那句「数字几天没变」的技术答案。
  const withSchemas = [tool("alpha", "甲"), tool("beta", "乙")];
  const t1 = await scan({ days: 1, mcpServerNames: [], schemas: withSchemas });
  const t90 = await scan({ days: 90, mcpServerNames: [], schemas: withSchemas });
  ok("taxTotalTokens 与窗口无关（同一注册表在 1 天与 90 天窗口下必须一字不差）", t1.taxTotalTokens === t90.taxTotalTokens, `${t1.taxTotalTokens} vs ${t90.taxTotalTokens}`);
  // 反向自测：改长描述后税必须变。否则上面那条「与窗口无关」可能只是税被写死成常量的假象。
  const t90b = await scan({ days: 90, mcpServerNames: [], schemas: [tool("alpha", "甲".padEnd(120, "字")), tool("beta", "乙")] });
  ok("自测前置：改长一个工具的描述后 taxTotalTokens 确实变大", t90b.taxTotalTokens > t90.taxTotalTokens, `${t90.taxTotalTokens} → ${t90b.taxTotalTokens}`);
  ok("自测前置：清单变化次数随下发内容改变而增加", t90.wireTaxChangeCount >= 1);
}

// ── 7. 指纹种类超过上限时截断而不是无界增长 ────────────────────────────────
{
  const dir = await freshSessions();
  // 65 份各不相同的清单（每种只 1 个工具），超过 WIRE_TAX_MAX_KEYS = 64。
  let text = "";
  for (let i = 0; i < 65; i++) text += headerLine([tool(`t${i}`, `描述 ${i}`), tool("shared", "共有")], now - i * 1000);
  await writeLog(dir, text);
  const r = await scan({ days: 7 });
  ok("超过 64 种清单时置 wireTaxTruncated", r.wireTaxTruncated === true);
  ok("快照表被钉在上限 64 种（不外溢）", r.wireTaxChangeCount === 64, `实际=${r.wireTaxChangeCount}`);
  ok("截断时 latest 仍是已记录的某种清单（面板不至于整行空）", r.wireTaxLatest !== null && r.wireTaxLatest.tokens > 0);
}

await rm(HOME, { recursive: true, force: true });

if (failures) {
  console.log(`\nTAILOR-TIMELINE FAIL（${failures} 项）`);
  process.exit(1);
}
console.log("\nTAILOR-TIMELINE PASS");
