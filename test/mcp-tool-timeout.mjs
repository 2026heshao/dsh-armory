// issue #19：MCP 工具调用超时填大数值 → 每次调用都立即 REQUEST_TIMEOUT（报告者称「永远超时」）。
//
// 根因链（2026-11-14 实测确认）：
//   表单/导入不封顶 → toolCallTimeoutMs 原样写进宿主配置 → 宿主 mcp-client 原样传给
//   @modelcontextprotocol/client → SDK `_setupTimeout` 直接 `setTimeout(onTimeout, timeout)`
//   → Node 把 > 2^31-1 的延迟钳成 1ms（TimeoutOverflowWarning）→ 每个工具调用 1ms 即超时。
//   实测：`setTimeout(fn, 9999999999)` 在 1ms 后触发；`setTimeout(fn, 0)` 下一拍即触发。
//
// 修法（报告者两条诉求）：
//   1. 上限 = MAX_TIMER_DELAY_MS（2^31-1 ms ≈ 24.8 天，与 reconnect/idle/ready 同一常量），
//      超过在唯一写入边界 normalizeEntry 拒绝；表单同步校验。
//   2. 0 = 永不超时。宿主 SDK 没有「不超时」哨兵（0 会被 setTimeout 当成下一拍立即超时），
//      所以 0 在写入边界映射为上限；表单回显时把上限映射回 0，列表显示「永不超时」。
//
// 本套件：服务端真跑（normalizeMcpImport）+ 客户端源码针 + 反向自测（旧校验必须仍然
// 放行溢出值、源码针在回退旧写法后必须变红），零网络零写盘。
//
// 用法：node ./test/mcp-tool-timeout.mjs
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeMcpImport } from "../lib/mcp-config.js";
import { setWin32LaunchContext } from "../lib/win32-stdio.js";

// 与 mcp-config.mjs 同一口径：纯归一化结果不能随本机 PATH 有没有 node.exe 变化。
setWin32LaunchContext({ applicable: false, platform: "test", node: null, cacheDir: null });

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
const MAX = 2147483647; // 2^31-1，Node 定时器不溢出的最大延迟

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
function throws(name, fn, pattern) {
  try {
    fn();
    ok(name, false, "预期抛错但没有抛");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ok(name, pattern.test(message), pattern.test(message) ? "" : `消息不匹配：${message}`);
  }
}
const one = (servers) => normalizeMcpImport({ mcpServers: servers }).servers[0];
const timeoutOf = (v) => one({ a: { command: "x", toolCallTimeoutMs: v } }).toolCallTimeoutMs;

// ── 1. 写入边界：上限与 0 的映射（真跑） ─────────────────────────────────────
console.log("\n── 1. normalizeEntry：封顶 + 0=永不超时 ──");
ok("上限常量就是 2^31-1（Node 定时器精度）", MAX === 2 ** 31 - 1);
ok("0 映射为上限（永不超时）", timeoutOf(0) === MAX, String(timeoutOf(0)));
ok("上限本身原样通过", timeoutOf(MAX) === MAX);
ok("常规值原样通过", timeoutOf(60000) === 60000);
ok("未设置时不写字段", !("toolCallTimeoutMs" in one({ a: { command: "x" } })));
throws("上限 +1 拒绝（报告者的溢出场景）", () => timeoutOf(MAX + 1), /不能大于 2147483647/);
throws("9999999999 拒绝（截图量级的大数值）", () => timeoutOf(9999999999), /不能大于 2147483647/);
throws("负数拒绝", () => timeoutOf(-1), /必须是非负整数/);
throws("小数拒绝", () => timeoutOf(1.5), /必须是非负整数/);
throws("字符串拒绝", () => timeoutOf("60000"), /必须是非负整数/);
throws("NaN 拒绝", () => timeoutOf(NaN), /必须是非负整数/);

// ── 2. 客户端源码针（lib/client.js 是浏览器 bundle，不能直接 import） ─────────
console.log("\n── 2. 表单与显示：0 可填、上限可校验、回显映射 ──");
const source = await readFile(CLIENT, "utf8");
const pins = [
  ["输入框允许 0 且封顶", /工具调用超时（毫秒）[^\n]*min: 0, max: MAX_TIMER_DELAY_MS/],
  ["输入框下有 0=永不超时 的提示", /dsh-mcp-field-hint[^\n]*0 = 永不超时；最大 2147483647 ms/],
  ["提交校验放行 0 且封顶", /timeout < 0 \|\| timeout > MAX_TIMER_DELAY_MS/],
  ["提交校验拒绝空串（清空不等于 0）", /String\(toolCallTimeoutMs\)\.trim\(\) === '' \|\| !Number\.isSafeInteger\(timeout\)/],
  ["回显把上限映射回 0", /initial\.toolCallTimeoutMs === MAX_TIMER_DELAY_MS \? '0' : String\(initial\.toolCallTimeoutMs \|\| 60000\)/],
  ["列表把上限显示为「永不超时」", /server\.toolCallTimeoutMs === MAX_TIMER_DELAY_MS \? t\('永不超时'\)/],
];
for (const [name, re] of pins) ok(name, re.test(source));
// i18n：新键必须进 en-US 字典，旧合并键必须移除（i18n-coverage 双向差集会再守一遍）。
for (const key of ["工具超时必须是 0 到 2147483647 的整数（0 = 永不超时）", "最大尝试次数必须是正整数", "永不超时", "0 = 永不超时；最大 2147483647 ms（约 24.8 天）"]) {
  ok(`en-US 字典含「${key.slice(0, 18)}…」`, source.includes(`"${key}": "`));
}
ok("旧的合并报错键已移除", !source.includes("工具超时和最大尝试次数必须是正整数"));

// ── 3. 反向自测：旧写法必须仍然「坏」，否则上面的断言是空转 ──────────────────
console.log("\n── 3. 反向自测 ──");
// 旧服务端校验（< 1 拒绝）与旧表单校验（<= 0 拒绝）都放行溢出值——这正是 bug 来源。
const legacyServerAccepts = (v) => Number.isSafeInteger(v) && v >= 1;
const legacyClientAccepts = (v) => Number.isSafeInteger(v) && v > 0;
ok("旧服务端校验放行 9999999999（溢出值直达宿主）", legacyServerAccepts(9999999999));
ok("旧表单校验放行 9999999999", legacyClientAccepts(9999999999));
ok("旧校验把 0 当非法（无法实现永不超时）", !legacyServerAccepts(0) && !legacyClientAccepts(0));
// 源码针不是恒真：把校验回退成旧写法，针必须立刻失配。
const regressed = source.replace("timeout < 0 || timeout > MAX_TIMER_DELAY_MS", "timeout <= 0");
ok("回退旧写法后「放行 0 且封顶」针变红", !/timeout < 0 \|\| timeout > MAX_TIMER_DELAY_MS/.test(regressed));
const regressedInit = source.replace("initial.toolCallTimeoutMs === MAX_TIMER_DELAY_MS ? '0' : String(initial.toolCallTimeoutMs || 60000)", "String(initial.toolCallTimeoutMs || 60000)");
ok("回退旧写法后「回显映射」针变红", !/initial\.toolCallTimeoutMs === MAX_TIMER_DELAY_MS \? '0'/.test(regressedInit));

if (failures > 0) {
  console.log(`\nMCP-TOOL-TIMEOUT FAIL（${failures} 条断言未通过）`);
  process.exit(1);
}
console.log("\nMCP-TOOL-TIMEOUT PASS");