// app root 读取口径（Cordis 4.0.0-rc.12 起 ctx.root 被移除）。
//
// DSH v0.2.2-rc.2 起内置的 @deepseek-ai/cordis 换成上游 rc.12：根上下文不再挂在
// ctx.root 上，只能读 ctx[Context.root]（= Symbol.for('cordis.root')）。旧写法在
// 新版里直接抛 `cannot get property "root" without inject`，插件 apply 阶段就会挂掉，
// 面板表现为"启用失败"且 bundle 被记为 failed。
// 见 DSH docs/upgrade-guide/v0.2.2-rc.2/cordis-root-and-intercept-metadata。
//
// 面板里有几处状态以 app root 为键归并（MCP 日志按 app 隔离、项目层配置缓存按 app
// 隔离），所以读取口径统一收在这里；旧版 cordis 没有这个 symbol，仍旧走 ctx.root 兜底。
const APP_ROOT = Symbol.for('cordis.root');

/**
 * 取 cordis app 根上下文；拿不到就退回传入的 context。
 * @param {any} ctx cordis context
 * @returns {any} 根 context（或原 ctx）
 */
export function rootOf(ctx) {
  if (!ctx || typeof ctx !== 'object') return ctx;
  try {
    const root = ctx[APP_ROOT];
    if (root) return root;
    return ctx.root || ctx;
  } catch {
    // 新版 cordis 读一个未注入的 ctx.root 会抛错：此时本层就是能拿到的最外层作用域。
    // 整段同包 try，保证任何一次读取失败都不会把插件的 apply 带走。
    return ctx;
  }
}
