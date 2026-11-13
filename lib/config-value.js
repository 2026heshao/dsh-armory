// 「配置值 → 可展示文本」的唯一归一入口（issue #16）。
//
// 背景：loader 为了写回，会把 `!!js` 表达式以**未求值对象** `{ __jsExpr: "..." }`
// 留在 `entry.options.config` 里（官方 loader 行为，见 lib/index.js 里
// resolveLiveConfigValue 的注释）。这份 raw 只在 apply 之前才被插值。
//
// 项目层（workspace）拿到的是字符串（`.dsh/mcp.json` 里就是 `!!js …` 文本），
// 所以那条通路一直是安全的；而**其它插件 bundle 用 cordis.patch.yml 注入的行**，
// `command: !!js process.env.HOME` 解析后是对象。旧代码在 summarize() 里原样透传，
// 对象一路经 RPC 到浏览器，变成 React 子节点 → React #31，整块 MCP 面板被
// ErrorBoundary 吞掉（用户看到「这个面板加载失败」）。
//
// 归一分两步，顺序不能反：
//   1. printable —— 对象表达式先还原成 `!!js …` 文本（不还原就永远匹配不到字符串分支）；
//   2. present   —— 再走 toTemplate 还原成文件里的 `${VAR}` 模板形式，避免向用户
//                  泄漏内部表示。还原失败原样返回：只影响展示，不影响落盘。
//
// 非字符串（数字 / 布尔 / null）原样返回：这两个字段里 `toolCallTimeoutMs` 与
// `failOnStartupError` 本来就可能是数字/布尔，不能被字符串化后写回配置。
import { jsExpressionToTemplate as toTemplate } from './workspace-config.js';

/** loader 保留未求值表达式时用的键名（官方为写回保留的 raw 形态）。 */
export const JS_EXPR_KEY = '__jsExpr';

/**
 * `{ __jsExpr: "…" }` → `"!!js …"`；其它值原样返回。
 *
 * 只认「纯对象 + 字符串 __jsExpr」这一种形态：数组、双层嵌套、__jsExpr 非字符串
 * 都按普通值处理，避免把用户配置里恰好叫这个名字的字段误当表达式。
 *
 * @param {unknown} value 配置字段的 raw 值
 * @returns {unknown} 可展示的值（字符串，或原值）
 */
export function printableConfigValue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const expr = value[JS_EXPR_KEY];
  return typeof expr === 'string' ? `!!js ${expr}` : value;
}

/**
 * 配置字段的展示归一：对象表达式 → `!!js …` → 文件模板 `${VAR}`。
 *
 * @param {unknown} value 配置字段的 raw 值
 * @returns {unknown} 展示值；字符串一定不以内部 `!!js` 前缀出现（除还原失败时）
 */
export function presentConfigValue(value) {
  const text = printableConfigValue(value);
  if (typeof text !== 'string' || !text.startsWith('!!js ')) return text;
  try {
    return toTemplate(text);
  } catch {
    // 还原失败（含复杂的 `!!js` 表达式）：保留 `!!js …` 原文比空串可读，
    // 但序列化到界面上的永远是字符串，不会再出现 React #31。
    return text;
  }
}
