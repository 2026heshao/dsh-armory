// app root（cordis 根上下文）的统一读取口径。
//
// Cordis 4.0.0-rc.12 起（npm 上的载体是 @deepseek-ai/cordis 4.2.0-alpha.1）`ctx.root` 被移除，
// 根上下文改为 `ctx[Context.root]`，而 `Context.root` 就是 `Symbol.for('cordis.root')`。
// 在插件 fiber 内读一个未注入的 `ctx.root` 会抛 `cannot get property "root" without inject`；
// armory 这两处读取都在 apply 阶段，抛出去整条 fiber 直接 failed，面板与 MCP 服务都不出现。
// 见 DSH docs/upgrade-guide/v0.2.2-rc.2/cordis-root-and-intercept-metadata。
//
// 面板里有几处状态以 app root 为键归并（MCP 日志按 app 隔离、项目层配置缓存按 app 隔离），
// 所以口径收在这一个文件，后续再有第三处要 root 也不必重踩。
const APP_ROOT = Symbol.for('cordis.root');

/**
 * 取 cordis app 根上下文；拿不到就退回传入的 ctx。
 *
 * 旧版 cordis（≤4.1.0）没有这个 symbol，`ctx[APP_ROOT]` 为 undefined，继续走 `ctx.root`
 * 兜底，行为与改造前完全一致。
 *
 * @param {any} ctx cordis context
 * @returns {any} 根上下文（或原 ctx）
 */
export function rootOf(ctx) {
  if (!ctx || typeof ctx !== 'object') return ctx;
  try {
    // 新版：symbol 属性由子上下文原型继承，任意层级读到的都是同一个 app root。
    const root = ctx[APP_ROOT];
    if (root) return root;
    return ctx.root || ctx;
  } catch {
    // 新版读未注入的 ctx.root 会抛错。此时宁可按本层作用域归并（统计口径粗一点），
    // 也不能让一次读取失败把插件的 apply 带走。
    return ctx;
  }
}
