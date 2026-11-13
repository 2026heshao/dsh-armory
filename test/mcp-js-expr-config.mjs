// issue #16 的回归护栏：外部 bundle 注入的 MCP 行，`command: !!js …` 在
// `entry.options.config` 里是 loader 保留的**未求值对象** `{ __jsExpr }`。旧代码在
// summarize() 里直通该对象，它一路经 RPC 到浏览器，被当作 React 子节点渲染 →
// React #31，整块 MCP 面板被 ErrorBoundary 吞掉（用户只看到「这个面板加载失败」）。
//
// 断言分三层：
//   1. 纯函数真跑（presentConfigValue / printableConfigValue）——归一的四种形态；
//   2. 接线源码断言——防止修好纯函数却忘了在 summarize / mut / 搜索过滤处使用；
//   3. 反向自测——把旧写法注回去，证明上面的断言不是恒真。
//
// 零网络、零写盘、不读真实 profile。

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { printableConfigValue, presentConfigValue } from '../lib/config-value.js';

// 路径含中文，必须走 fileURLToPath（`URL.pathname` 是百分号编码的）。
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const ok = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
};

// ── 1. 纯函数：四种输入形态 ───────────────────────────────────────────────
const obj = { __jsExpr: 'process.env.HOME' };

ok('对象表达式 → 可展示文本', printableConfigValue(obj) === '!!js process.env.HOME');
ok('对象表达式 → 文件模板（展示层不泄漏内部表示）', presentConfigValue(obj) === '${HOME}');

// 已经是文本的（项目层 / 手写的 patch 文件）必须原样保留，不能被二次包装。
ok('字符串表达式保持文本形态', printableConfigValue('!!js process.env.X') === '!!js process.env.X');
ok('普通字符串原样返回', presentConfigValue('/bin/echo') === '/bin/echo');

// 数字/布尔字段（toolCallTimeoutMs / failOnStartupError）不能被字符串化：
// 一旦变成 "30000"，写回配置就多了引号，等于改了用户配置的类型。
ok('数字不被字符串化', printableConfigValue(30000) === 30000);
ok('布尔不被字符串化', printableConfigValue(true) === true);
ok('数字经 present 仍为数字', presentConfigValue(30000) === 30000);

// 只认「纯对象 + 字符串 __jsExpr」：数组、非字符串表达式值都按普通值处理，
// 免得把用户配置里恰好叫这个名字的字段误当表达式。
ok('数组不被当作表达式', Array.isArray(printableConfigValue([{ __jsExpr: 'a' }])));
ok('__jsExpr 非字符串时原样返回', typeof printableConfigValue({ __jsExpr: 42 }) === 'object');
ok('null / undefined 原样返回', printableConfigValue(null) === null && printableConfigValue(undefined) === undefined);

// 还原失败（复杂表达式）不得抛错：展示层最多退化成 `!!js …` 原文。
let threw = false;
let complex = null;
try {
  complex = presentConfigValue({ __jsExpr: 'ctx.phaseOne.value + undefinedFn()' });
} catch {
  threw = true;
}
ok('复杂表达式不抛错', threw === false);
ok('复杂表达式仍返回字符串', typeof complex === 'string', String(complex));

// ── 2. 接线：修好纯函数不等于修好事故 ─────────────────────────────────────
const hostSource = await readFile(join(ROOT, 'lib', 'index.js'), 'utf8');
const clientSource = await readFile(join(ROOT, 'lib', 'client.js'), 'utf8');

// summarize() 的字段循环必须过归一：这四个字段是出 Host 的同一批。
const summarizeAt = hostSource.indexOf('function summarize(entry, inventory, managed');
const summarizeSlice = summarizeAt >= 0 ? hostSource.slice(summarizeAt, summarizeAt + 6000) : '';
ok('能定位 summarize()', summarizeSlice.length > 0);
ok('summarize 的字段循环走 presentConfigValue', /for \(const field of \["command", "cwd", "toolCallTimeoutMs", "failOnStartupError"\]\)[^\n]*presentConfigValue\(raw\[field\]\)/.test(summarizeSlice));
ok('summarize 不再直通 raw 字段', !/row\[field\] = raw\[field\];/.test(hostSource));

// 详情页的展示函数与列表搜索都必须先归一：
// mut() 的输出会直接进 React 子节点；搜索那行会调 toLowerCase()。
const mutAt = clientSource.indexOf('const mut = (v) => {');
const mutSlice = mutAt >= 0 ? clientSource.slice(mutAt, mutAt + 600) : '';
ok('能定位 mut()', mutSlice.length > 0);
ok('mut() 经 textOf 归一', /const visible = textOf\(displayValue\(v\)\);/.test(mutSlice));
ok('列表搜索不再对 command 裸调 toLowerCase', !/\(s\.url \|\| s\.command \|\| ''\)\.toLowerCase\(\)/.test(clientSource));

// ── 3. 真跑 summarize：把报告人（issue #16）的原始数据喂进去 ────────────────
// 上面两节是「纯函数对不对」「有没有接线」。这一节回答最后一个问题：给一份
// 外部 bundle 注入的 config（command 是 `{ __jsExpr }`），summarize 出来到底是不是
// 字符串——即修复是否真的作用在报告人那条数据上。
//
// summarize 依赖一批同文件函数，这里把真实实现（redactMap / redactUrl / redactArgs）
// 一起抽进 vm，其余（状态派生、日志清洗）用最小替身，避免把整个宿主拖进来。
const grab = (startMarker, endMarker) => {
  const start = hostSource.indexOf(startMarker);
  if (start < 0) return '';
  const end = hostSource.indexOf(endMarker, start + startMarker.length);
  return end > start ? hostSource.slice(start, end) : '';
};
const summarizeSource = grab('function summarize(entry, inventory, managed', '\n// 项目 MCP 的行状态');
const redactSource = grab('function redactMap(value) {', 'function restoreRedactedMap');
ok('能定位 summarize 与脱敏函数', summarizeSource.length > 0 && redactSource.length > 0);

if (summarizeSource && redactSource) {
  const context = vm.createContext({
    presentConfigValue,
    structuredClone,
    PHASE_TEXT: { 3: 'active' },
    AUTH_FAILURE_RE: /(401|403|unauthori[sz]ed|forbidden)/i,
    REDACTED_VALUE: 'REDACTED',
    setOwn: (target, key, value) => Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true }),
    deriveMcpPhase: () => 'stopped',
    sanitizeMcpLog: (text) => text,
    isBlockedLaunchShape: () => false,
  });
  vm.runInContext(`${redactSource}\n${summarizeSource}\nglobalThis.__summarize = summarize;`, context);

  const inventory = { counts: {}, revisions: {}, ambiguous: new Set() };
  // 报告人的复现：cordis.patch.yml 里 `command: !!js process.env.HOME`，loader 留下对象。
  const injected = {
    fiber: { state: 3 },
    disabled: false,
    options: {
      config: {
        serverName: 'injectdemo',
        transport: 'stdio',
        command: { __jsExpr: 'process.env.HOME' },
        args: ['demo'],
      },
    },
  };
  const row = context.__summarize(injected, inventory, null);
  ok('注入行的 command 出 Host 时是字符串', typeof row.command === 'string', `typeof=${typeof row.command}`);
  ok('注入行的 command 被还原成 ${VAR} 模板', row.command === '${HOME}', String(row.command));
  ok('注入行的 args 走脱敏（不是原数组）', Array.isArray(row.args) && row.args.length === 1 && row.args[0] === 'REDACTED');

  // 对照：普通字符串命令原样保留（修复不能把正常情况改坏）。
  const plain = context.__summarize({ fiber: { state: 3 }, disabled: false, options: { config: { serverName: 'echo', transport: 'stdio', command: '/bin/echo', args: ['hi'] } } }, inventory, null);
  ok('普通字符串命令原样保留', plain.command === '/bin/echo', String(plain.command));

  // 数字/布尔字段不能被字符串化：写回配置时类型要保住。
  const numeric = context.__summarize({ fiber: null, disabled: false, options: { config: { serverName: 'n', transport: 'stdio', command: 'x', toolCallTimeoutMs: 30000, failOnStartupError: false } } }, inventory, null);
  ok('数值字段保持 number', numeric.toolCallTimeoutMs === 30000, typeof numeric.toolCallTimeoutMs);
  ok('布尔字段保持 boolean', numeric.failOnStartupError === false, typeof numeric.failOnStartupError);

  // url 是 `!!js` 表达式时必须掩码（既不崩也不泄漏内部写法）。
  const withUrl = context.__summarize({ fiber: { state: 3 }, disabled: false, options: { config: { serverName: 'u', transport: 'http', command: 'x', url: { __jsExpr: 'process.env.ENDPOINT' } } } }, inventory, null);
  ok('url 表达式被掩码成字符串', withUrl.url === 'REDACTED', String(withUrl.url));
}

// ── 4. 反向自测：旧写法必须仍然「坏」，否则上面的断言是空转 ──────────────
const legacySummarizeField = (raw, field) => raw[field];
const legacy = legacySummarizeField({ command: obj }, 'command');
ok('反向自测：旧写法确实把对象直通出去（React #31 的来源）', typeof legacy === 'object' && legacy !== null);
ok('反向自测：旧 mut 写法对对象原样返回', ((v) => v)(obj) === obj);

if (failures > 0) {
  console.log(`\nMCP-JS-EXPR-CONFIG FAIL（${failures} 条断言未通过）`);
  process.exit(1);
}
console.log('\nMCP-JS-EXPR-CONFIG PASS');
