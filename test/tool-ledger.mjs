// 工具裁缝账本（lib/tool-ledger.js）的回归套件（OPT-09）。
//
// 为什么必须有它：OPT-01（zstd 缺失时静默全 0）与 OPT-06（日志无尺寸上限）在引入本套件
// 之前**没有任何测试能发现**。两个缺陷的表现都是「数字变成 0」，而 0 同时也是合法结果——
// 除非把「0 的原因」变成可断言的事实，否则这两处再退化一次也没人知道。
//
// 只用 node: 内置模块：不需要 test/loader.mjs 的裸导入重定向，可直接 import 真实文件。
// 用法：node ./test/tool-ledger.mjs
import zlib from "node:zlib";
import { mkdir, mkdtemp, open, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LEDGER_URL = new URL("../lib/tool-ledger.js", import.meta.url).href;
const { scanSessionLedger } = await import(LEDGER_URL);

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const skip = (name, why) => console.log(`SKIP  ${name}  ${why}`);

// ── 隔离：账本只认 DSH_SKILL_MCP_BOARD_HOME，绝不碰真实 ~/.dsh ──────────────
const HOME = await mkdtemp(join(tmpdir(), "dsh-ledger-"));
process.env.DSH_SKILL_MCP_BOARD_HOME = HOME;
const SESSIONS = join(HOME, ".dsh", "sessions");

/**
 * 重建一份干净的会话目录树，返回唯一那个会话目录。
 *
 * 每次调用都换一个**全新的路径名**：账本有按绝对路径建键的解压缓存（OPT-03），若各节
 * 复用同一路径，前一节的缓存条目就会渗进本节，让「首次扫描」不再是首次。
 */
let sessionSeq = 0;
async function freshSessions() {
  await rm(SESSIONS, { recursive: true, force: true });
  sessionSeq += 1;
  const dir = join(SESSIONS, `proj-${sessionSeq}`, `session-${sessionSeq}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

const scan = (over = {}) =>
  scanSessionLedger({ days: 30, mcpServerNames: [], schemas: [], disabledServers: new Set(), ...over });

const countOf = (report, name) => report.tools.find((tool) => tool.name === name)?.calls ?? 0;
const toolOf = (report, name) => report.tools.find((tool) => tool.name === name) ?? null;

// ── 夹具：会话日志的一行就是一条事件 ─────────────────────────────────────────
const callLine = (name, callId, time) =>
  `${JSON.stringify({ type: "tool/call", time, data: { callId, name, turn: 1, step: 1 } })}\n`;
const resultLine = (callId, time, isError = false) =>
  `${JSON.stringify({ type: "tool/result", time, data: { message: { toolCallId: callId, isError } } })}\n`;
/** 一帧 = 一次落盘追加。真实日志按追加时机拆成多个独立 zstd 帧。 */
const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, "utf8"));
const DAY = 86_400_000;
const now = Date.now();

/** 把 mtime 固定成整秒，保证 stat().mtimeMs 能被 Date 精确还原（缓存用例的前提）。 */
const pinMtime = (path, ms) => utimes(path, new Date(ms), new Date(ms));

// ── 1. 多帧解码：zstdDecompressSync 只解第一帧，必须按 magic 切帧 ────────────
{
  const dir = await freshSessions();
  const text = callLine("alpha", "c1", now) + callLine("beta", "c2", now) + callLine("gamma", "c3", now);
  // 三个独立帧，模拟「三次追加落盘」。
  const buf = Buffer.concat([
    frame(callLine("alpha", "c1", now)),
    frame(callLine("beta", "c2", now)),
    frame(callLine("gamma", "c3", now)),
  ]);
  await writeFile(join(dir, "session.1.zstd"), buf);
  const report = await scan();
  ok("多帧 zstd 全部解码：3 帧 3 次调用都不丢", report.totalCalls === 3, `totalCalls=${report.totalCalls}`);
  ok("多帧：三个工具各自记到 1 次", countOf(report, "alpha") === 1 && countOf(report, "beta") === 1 && countOf(report, "gamma") === 1);
  ok("多帧：failedFrames 为 0", report.failedFrames === 0, `failedFrames=${report.failedFrames}`);
  ok("多帧：filesRead=1、failedFiles=0", report.filesRead === 1 && report.failedFiles === 0);
  ok("正常环境 zstdSupported=true（OPT-01 的对照面）", report.zstdSupported === true);
  // 界面在 zstd 降级时会说「升级到 22.15 以上」，得能报出用户当前版本；缺了这个字段
  // 提示就退化成「（未知版本）」，等于没说（OPT-02 的自测点）。
  ok("返回 nodeVersion，供降级提示指出当前版本", report.nodeVersion === process.versions.node, `nodeVersion=${report.nodeVersion}`);
  void text;
}

// ── 2. 单帧损坏：跳过坏帧继续算，且坏帧数如实上报 ────────────────────────────
// 坑：只有 magic 的帧、被截断的帧都**不会**抛错（zstd 对空/截断输入宽容），
// 所以构造坏帧必须用「magic + 垃圾字节」。
{
  const dir = await freshSessions();
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const corrupt = Buffer.concat([MAGIC, Buffer.from("this-is-not-a-zstd-frame-at-all", "utf8")]);
  await writeFile(join(dir, "session.1.zstd"), Buffer.concat([
    frame(callLine("alpha", "c1", now)),
    corrupt,
    frame(callLine("beta", "c2", now)),
  ]));
  const report = await scan();
  ok("损坏帧：好帧照样计入（2 次调用）", report.totalCalls === 2, `totalCalls=${report.totalCalls}`);
  ok("损坏帧：failedFrames 如实计 1", report.failedFrames === 1, `failedFrames=${report.failedFrames}`);
  ok("损坏帧：整文件不算失败（filesRead=1、failedFiles=0）", report.filesRead === 1 && report.failedFiles === 0);
}

// ── 3. OPT-01 降级守卫：zstd 不可用时必须**报错**，而不是静默全 0 ─────────────
// 手法：删掉 zlib.zstdDecompressSync，再用带 query 的 URL 取一份全新模块实例
// （模块在导入时就把 ZSTD_SUPPORTED 定死了，旧实例不受影响）。
{
  const dir = await freshSessions();
  await writeFile(join(dir, "session.1.zstd"), frame(callLine("alpha", "c1", now)));
  let degraded = null;
  if (typeof zlib.zstdDecompressSync === "function") {
    const saved = zlib.zstdDecompressSync;
    const removed = delete zlib.zstdDecompressSync;
    try {
      if (removed && typeof zlib.zstdDecompressSync === "undefined") {
        const fresh = await import(`${LEDGER_URL}?no-zstd`);
        degraded = await fresh.scanSessionLedger({ days: 30, mcpServerNames: [], schemas: [], disabledServers: new Set() });
      }
    } finally {
      zlib.zstdDecompressSync = saved;
    }
  }
  if (degraded === null) {
    skip("OPT-01 zstd 缺失降级守卫", "本环境无法移除 zlib.zstdDecompressSync");
  } else {
    ok("OPT-01 zstd 缺失：zstdSupported=false 被上报", degraded.zstdSupported === false);
    ok("OPT-01 zstd 缺失：调用计数为 0（与真实「零调用」可区分）", degraded.totalCalls === 0);
    // 这是核心：同样是 0，这里的 0 必须带着原因。
    ok("OPT-01 zstd 缺失：failedFiles>0，不是静默", degraded.failedFiles > 0, `failedFiles=${degraded.failedFiles}`);
    ok("OPT-01 zstd 缺失：失败样本点名 zstd 解压不可用", degraded.failedFileSamples.some((s) => s.includes("zstd 解压不可用")));
    ok("OPT-01 zstd 缺失：失败样本给出 Node 版本要求", degraded.failedFileSamples.some((s) => s.includes("22.15")));
  }
}

// ── 4. OPT-06 尺寸上限：超限日志降级跳过，不读进内存 ─────────────────────────
{
  const dir = await freshSessions();
  const big = join(dir, "session.big.zstd");
  // 稀疏文件：65 MB 只需毫秒级创建，不会真的写盘。
  const handle = await open(big, "w");
  try {
    await handle.truncate(65 * 1024 * 1024);
  } finally {
    await handle.close();
  }
  const report = await scan();
  ok("OPT-06 超限日志：filesSkippedOversize=1", report.filesSkippedOversize === 1, `=${report.filesSkippedOversize}`);
  ok("OPT-06 超限日志：计入 failedFiles 且带原因", report.failedFiles === 1
    && report.failedFileSamples.some((s) => s.includes("上限") && s.includes("已跳过")));
  ok("OPT-06 超限日志：未被读入（filesRead=0、计数为 0）", report.filesRead === 0 && report.totalCalls === 0);
}

// ── 5. days 窗口：事件时间过滤 与 mtime 预筛是两道独立的闸门 ─────────────────
{
  const dir = await freshSessions();
  // 事件在窗口外（40 天前），但文件 mtime 是新的 → 文件要读，事件要被时间闸门滤掉。
  const old = now - 40 * DAY;
  await writeFile(join(dir, "session.1.jsonl"), callLine("alpha", "c1", old) + callLine("beta", "c2", now));
  const r7 = await scan({ days: 7 });
  ok("days 窗口：窗口外的调用被过滤，窗口内的保留", r7.totalCalls === 1 && countOf(r7, "beta") === 1);
  ok("days 窗口：被过滤的事件不产生该工具条目", toolOf(r7, "alpha") === null);
  ok("days 窗口：fileRead 仍为 1（时间过滤发生在解析后）", r7.filesRead === 1);

  // 文件 mtime 早于窗口 → 整文件跳过，连读都不读（mtime 预筛）。
  const dir2 = await freshSessions();
  const stale = join(dir2, "session.1.jsonl");
  await writeFile(stale, callLine("alpha", "c1", now));
  await pinMtime(stale, now - 40 * DAY);
  const r7b = await scan({ days: 7 });
  ok("mtime 预筛：窗口外的日志整文件跳过", r7b.filesSkippedStale === 1 && r7b.filesRead === 0, `stale=${r7b.filesSkippedStale}`);
  const r90 = await scan({ days: 90 });
  ok("mtime 预筛：同一文件在 90 天窗口内被读取", r90.filesRead === 1 && r90.totalCalls === 1);
  // 夹取的真实契约：负值 / 超大值被夹到 1..365；**0 与 null/undefined 一样落回默认 30**
  // （`Number(days) || 30`：0 是 falsy，被当成「没指定」）。界面只会传 7/30/90，所以这条
  // 只保证「传了怪值也不会炸」，不承诺 0 表示「不设窗口」。
  const win = async (days) => (await scan({ days })).windowDays;
  ok("days 夹取：负值夹到 1、超大夹到 365", (await win(-5)) === 1 && (await win(9999)) === 365);
  ok("days 缺省：undefined/null/0 一律落回默认 30", (await win(undefined)) === 30 && (await win(null)) === 30 && (await win(0)) === 30);
  ok("days 取整：小数截断、数字字符串按数值解析", (await win(1.9)) === 1 && (await win("90")) === 90);
}

// ── 6. call / result 配对：错误率、孤儿结果 ─────────────────────────────────
{
  const dir = await freshSessions();
  await writeFile(join(dir, "session.1.jsonl"), [
    callLine("alpha", "c1", now),
    resultLine("c1", now + 10, true), // 有 call 的失败结果
    callLine("alpha", "c2", now),
    resultLine("c2", now + 10, false), // 成功
    resultLine("c2", now + 20, false), // 重试/续写：同一 callId 不重复计
    resultLine("ghost", now + 10, false), // 没有 call 的孤儿结果
  ].join(""));
  const report = await scan();
  const alpha = toolOf(report, "alpha");
  ok("配对：2 次调用、2 条结果（重复的 result 不重复计）", alpha.calls === 2 && report.totalResults === 2, `results=${report.totalResults}`);
  ok("配对：错误数 1、错误率 0.5", alpha.errors === 1 && alpha.errorRate === 0.5);
  ok("配对：孤儿结果单独计数、不污染工具", report.orphanResults === 1 && report.totalErrors === 1);
}

// ── 7. 归属解析：mcp__<server>__<tool>，server 名自身可含下划线 ─────────────
{
  const dir = await freshSessions();
  const names = ["exa_mcp", "fs"];
  await writeFile(join(dir, "session.1.jsonl"), [
    callLine("mcp__exa_mcp__search", "c1", now),
    callLine("mcp__fs__read_file", "c2", now),
    callLine("read_file", "c3", now), // 内置工具，同叶子名不同归属
    callLine("mcp__ghost__anything", "c4", now), // 未注册的 server
  ].join(""));
  const report = await scan({ mcpServerNames: names });
  const exa = toolOf(report, "mcp__exa_mcp__search");
  const fs = toolOf(report, "mcp__fs__read_file");
  ok("归属：server 名含下划线时按完整前缀切分", exa.kind === "mcp" && exa.server === "exa_mcp" && exa.leaf === "search");
  ok("归属：短名 server 正常切分", fs.kind === "mcp" && fs.server === "fs" && fs.leaf === "read_file");
  ok("归属：非 mcp__ 前缀一律算内置", toolOf(report, "read_file").kind === "builtin");
  ok("归属：未注册的 mcp__ 当成内置（没有可认领的 server）", toolOf(report, "mcp__ghost__anything").kind === "builtin");
  ok("归属：mcpToolCount 只数归属明确的", report.mcpToolCount === 2, `=${report.mcpToolCount}`);

  // 多个 server 前缀同时命中 → ambiguous，不提供操作（宁可显示「归属不明」也不猜）。
  const dir2 = await freshSessions();
  await writeFile(join(dir2, "session.1.jsonl"), callLine("mcp__a__b__x", "c1", now));
  const amb = await scan({ mcpServerNames: ["a", "a__b"] });
  ok("归属：前缀歧义时标 mcp-ambiguous 且不给 server", toolOf(amb, "mcp__a__b__x").kind === "mcp-ambiguous");
}

// ── 8. Schema 税：零调用工具靠注册表才能被看见 ──────────────────────────────
{
  const dir = await freshSessions();
  await writeFile(join(dir, "session.1.jsonl"), callLine("mcp__fs__read_file", "c1", now));
  const schemas = [
    { name: "mcp__fs__read_file", description: "read", parameters: { type: "object" } },
    { name: "mcp__fs__delete_file", description: "delete", parameters: { type: "object" } }, // 零调用
    { name: "mcp__exa_mcp__search", description: "search", parameters: { type: "object" } }, // 零调用
  ];
  const report = await scan({ mcpServerNames: ["fs", "exa_mcp"], schemas, disabledServers: new Set(["exa_mcp"]) });
  ok("Schema 税：注册表里的零调用工具也进清单", toolOf(report, "mcp__fs__delete_file")?.calls === 0);
  ok("Schema 税：deadMcpCount 只数零调用的 MCP 工具", report.deadMcpCount === 2, `=${report.deadMcpCount}`);
  ok("Schema 税：零调用工具也算进上下文税", report.deadMcpTaxTokens > 0, `=${report.deadMcpTaxTokens}`);
  ok("Schema 税：有调用的工具也补上 schemaTokens", toolOf(report, "mcp__fs__read_file").schemaTokens > 0);
  ok("禁用态：serverDisabled 按禁用集合标记", toolOf(report, "mcp__exa_mcp__search").serverDisabled === true
    && toolOf(report, "mcp__fs__delete_file").serverDisabled === false);
  void dir;
}

// ── 9. OPT-03 文本缓存：必须命中、且戳一变就失效 ────────────────────────────
// 黑箱证明手法：改写文件内容但**保持 size 与 mtime 完全不变**。若第二次扫描仍拿到旧
// 结果，说明走的是缓存；若拿到新结果，说明缓存没生效（或键里漏了 size/mtime）。
{
  const dir = await freshSessions();
  const logPath = join(dir, "session.1.jsonl");
  const pinned = Math.floor(now / 1000) * 1000; // 整秒：Date <-> stat.mtimeMs 可精确往返
  const textA = callLine("alpha", "c1", now);
  const textB = callLine("beta", "c1", now);
  const width = Math.max(textA.length, textB.length);
  const pad = (text) => text + " ".repeat(width - text.length); // 行尾空格是合法 JSON 空白
  await writeFile(logPath, pad(textA));
  await pinMtime(logPath, pinned);
  const first = await scan();
  ok("缓存基线：首次扫描读到 alpha", countOf(first, "alpha") === 1 && first.filesRead === 1);
  const stamp = await stat(logPath);

  // 换成完全不同的内容，但字节数与 mtime 都还原成首扫时的值。
  await writeFile(logPath, pad(textB));
  await pinMtime(logPath, pinned);
  const afterSame = await stat(logPath);
  ok("缓存夹具成立：改写后 size 与 mtimeMs 未变", afterSame.size === stamp.size && afterSame.mtimeMs === stamp.mtimeMs,
    `size ${afterSame.size}/${stamp.size} mtime ${afterSame.mtimeMs}/${stamp.mtimeMs}`);
  const second = await scan();
  ok("OPT-03 缓存命中：内容变了但戳没变 → 仍拿到旧结果", countOf(second, "alpha") === 1 && toolOf(second, "beta") === null,
    `alpha=${countOf(second, "alpha")} beta=${countOf(second, "beta")}`);

  // 新增一个日志文件不得让已有条目失效（按文件粒度，不是整库一把清）。
  await writeFile(join(dir, "session.2.jsonl"), callLine("gamma", "c9", now));
  const third = await scan();
  ok("OPT-03 新增日志只影响自己：旧文件仍走缓存（alpha 在、beta 不在）",
    countOf(third, "alpha") === 1 && toolOf(third, "beta") === null);
  ok("OPT-03 新增日志被真实读取（gamma 出现）", countOf(third, "gamma") === 1 && third.filesRead === 2);

  // 戳一变（mtime 变化）必须失效，否则用户永远看不到新调用。
  await pinMtime(logPath, pinned + 1000);
  const fourth = await scan();
  ok("OPT-03 mtime 变化即失效：读到新内容 beta", countOf(fourth, "beta") === 1 && toolOf(fourth, "alpha") === null);
  await pinMtime(logPath, pinned);
  const fifth = await scan();
  ok("OPT-03 mtime 改回旧值：按新戳重新读取（不会命中已被替换的旧条目）", countOf(fifth, "beta") === 1);
}

// ── 10. 明文 jsonl 与空目录：不崩、账本为空 ─────────────────────────────────
{
  const dir = await freshSessions();
  await writeFile(join(dir, "session.1.jsonl"), callLine("alpha", "c1", now));
  const report = await scan();
  ok("明文 .jsonl 也能直接读（非 zstd 分支）", report.totalCalls === 1 && report.failedFrames === 0);

  await rm(SESSIONS, { recursive: true, force: true });
  const empty = await scan();
  ok("没有会话目录时返回空账本而不是抛错", empty.sessionsScanned === 0 && empty.totalCalls === 0 && empty.failedFiles === 0);
  ok("空账本也带 zstdSupported（界面据此判断能否解释 0）", empty.zstdSupported === true);
}

await rm(HOME, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "TOOL-LEDGER PASS" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
