window.__ModuleLoader__.load({
	id: 'dsh-skill-mcp-board',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
// MCP 市场 UI browser bundle：右下角浮动按钮打开响应式管理面板。
var React = require('react');
var __injectCss = function(text) {
  if (typeof document === 'undefined') return () => {};
  var id = 'dsh-skill-mcp-board/mcp.css';
  var tag = document.querySelector('style[data-plugin-css="' + id + '"]');
  var created = false;
  if (!tag) {
    tag = document.createElement('style');
    // 两个属性都要盖，与官方构建器 styleInjectionModule 生成的一致
    // （packages/client/tsdown.client.ts）：
    //   data-plugin     模块加载器认领与清理样式的凭据（entry-lifecycle.ts 的
    //                   removeOwnedStyles 只删 data-plugin === 插件 id 的标签）
    //   data-plugin-css 本插件自己的去重键
    // 只盖 pluginCss 时，加载器只能靠「materialize 期间新出现的未打标 style」兜底认领；
    // 若标签在认领窗口之外插入，HMR 卸载就会留下孤儿 style。
    tag.dataset.plugin = 'dsh-skill-mcp-board';
    tag.dataset.pluginCss = id;
    document.head.appendChild(tag);
    created = true;
  }
  try {
    tag.textContent = text;
  } catch (error) {
    if (created) tag.remove();
    throw error;
  }
  return () => tag.remove();
};
const React2 = React;
const { useState, useEffect, useCallback, useMemo, useRef } = React2;

/* 主题令牌别名层。DSH 的 ui-theme 拥有全部颜色、几何与字体：插件只消费语义令牌，
   不写死色值、不写局部圆角数值（docs/web-styling.md：「Use --dsw-alias-* semantic
   tokens in feature components. Do not copy static palette values or write literal
   colors there.」）。要用的令牌在这里一次性收成 --mcp-* 别名，后面的规则只引用别名——
   换主题、调刻度都只改这一处。

   挂在 body 而不是 .dsh-mcp-wrap 上：本插件有三个互不相邻的 slot 子树
   （shell.overlay 的悬浮按钮、sidebar.footer.action 的侧栏入口、面板自己），它们
   没有公共祖先，别名必须定义在共同祖先上。

   也不能挂在 :root：ui-theme 把全部 --dsw-alias-* 定义在 **body** 上
   （design-platform.css 的 `body{}` 与 `body[data-ds-dark-theme]{}`），而 :root 是 body
   的祖先——自定义属性在声明处就完成替换，在 :root 上写 `var(--dsw-alias-*)` 会取到空值，
   整片别名失效（实测卡片与面板背景变透明）。

   两点容易踩：
   - 几何走 --dsw-radius-*（docs/ui-radius.md 的分级），不写字面数值。官方 spec 把
     「>4px 且 <99px 的字面圆角」判为违规，≤4px 才算绘图细节。
   - 等宽字体是 --ds-font-family-code（ui-theme/src/styles/base.css 的 :root 里定义的就是
     它，官方 51 处用它）。别用 --dsw-font-mono：那个名字全仓没有定义，只是个约定俗成的
     引用目标，用上它等于永远命中 fallback，等宽字形跟宿主代码块对不上。 */
const MCP_CSS = `body{--mcp-accent:var(--dsw-alias-brand-primary);--mcp-ok:var(--dsw-alias-state-success-primary);--mcp-err:var(--dsw-alias-state-error-primary);--mcp-warn:var(--dsw-alias-state-warn-primary);--mcp-mut:var(--dsw-alias-label-secondary);--mcp-bg-1:var(--dsw-alias-bg-layer-1);--mcp-bg-2:var(--dsw-alias-bg-layer-2);--mcp-bg-3:var(--dsw-alias-bg-layer-3);--mcp-line:var(--dsw-alias-border-l2);--mcp-mono:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);--mcp-r-xs:var(--dsw-radius-xs);--mcp-r-sm:var(--dsw-radius-sm);--mcp-r-md:var(--dsw-radius-md);--mcp-r-lg:var(--dsw-radius-lg);--mcp-r-xl:var(--dsw-radius-xl);--mcp-r-panel:var(--dsw-radius-panel)}
.dsh-mcp-wrap,.dsh-mcp-panel-overlay,.dsh-mcp-overlay,.dsh-mcp-fab,.dsh-mcp-footer-action,.dsh-mcp-toast{color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family,inherit)}
.dsh-mcp-wrap{box-sizing:border-box;display:flex;flex-direction:column;height:100%;min-height:0;gap:14px;padding:4px 2px;font-size:13px;-webkit-font-smoothing:antialiased}
.dsh-mcp-wrap ::-webkit-scrollbar{width:8px;height:8px}
.dsh-mcp-wrap ::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:999px;corner-shape:round;border:2px solid transparent;background-clip:padding-box}
.dsh-mcp-wrap ::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2);border:2px solid transparent;background-clip:padding-box}
.dsh-mcp-wrap ::-webkit-scrollbar-track{background:transparent}
.dsh-mcp-head{display:flex;align-items:center;justify-content:space-between;gap:10px}
.dsh-mcp-title{flex:none;white-space:nowrap;font-size:15px;font-weight:650;letter-spacing:.2px;display:flex;align-items:center;gap:8px}
.dsh-mcp-title::before{content:"";width:4px;height:16px;border-radius:2px;background:var(--mcp-accent)}
.dsh-mcp-head-actions{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
.dsh-mcp-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-sm);padding:6px 12px;background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500;white-space:nowrap;cursor:pointer;transition:background .15s,border-color .15s}
.dsh-mcp-btn:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.dsh-mcp-btn:active{background:var(--dsw-alias-interactive-bg-active)}
.dsh-mcp-btn:disabled{opacity:.4;cursor:not-allowed;transform:none;box-shadow:none}
.dsh-mcp-btn.primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}
.dsh-mcp-btn.primary:hover{background:var(--dsw-alias-button-primary-hover)}
.dsh-mcp-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}
.dsh-mcp-btn.danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger);border-color:var(--dsw-alias-state-error-primary)}
.dsh-mcp-body{display:flex;gap:12px;flex:1;min-height:0}
.dsh-mcp-side{width:288px;min-width:248px;min-height:0;display:flex;flex-direction:column;gap:8px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-2);padding:10px;overflow:hidden}
.dsh-mcp-side.embedded{width:auto;min-width:0;flex:1 1 auto;border:0;border-radius:0;background:transparent;padding:0;overflow:visible}
.dsh-mcp-search{position:relative}
.dsh-mcp-search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);opacity:.5}
.dsh-mcp-search input{width:100%;box-sizing:border-box;padding:8px 10px 8px 30px;border-radius:var(--mcp-r-md);border:1px solid var(--mcp-line);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font-size:12px;outline:none;transition:border-color .15s,box-shadow .15s}
.dsh-mcp-search input::placeholder{color:var(--mcp-mut)}
.dsh-mcp-search input:focus{border-color:var(--mcp-accent);box-shadow:none}
.dsh-mcp-list{flex:1 1 auto;min-height:52px;overflow-y:auto;display:flex;flex-direction:column;gap:3px;margin:0 -4px;padding:0 4px}
.dsh-mcp-item{position:relative;display:flex;align-items:center;gap:9px;padding:8px 9px;border-radius:var(--mcp-r-md);cursor:pointer;border:1px solid transparent;transition:background .13s,border-color .13s}
.dsh-mcp-item:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l2)}
.dsh-mcp-item.sel{background:var(--dsw-alias-interactive-bg-hover-accent);border-color:var(--mcp-accent)}
.dsh-mcp-item.sel::before{content:"";position:absolute;left:-1px;top:20%;bottom:20%;width:3px;border-radius:3px;background:var(--mcp-accent)}
.dsh-mcp-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--mcp-mut);box-shadow:none;corner-shape:round}
.dsh-mcp-dot.connected{background:var(--mcp-ok);box-shadow:0 0 4px color-mix(in srgb,var(--mcp-ok) 55%,transparent)}
.dsh-mcp-dot.failed{background:var(--mcp-err);box-shadow:0 0 6px color-mix(in srgb,var(--mcp-err) 55%,transparent)}
.dsh-mcp-dot.loading{background:var(--mcp-warn);animation:mcpBlink 1.1s infinite}
@keyframes mcpBlink{50%{opacity:.35}}
.dsh-mcp-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsh-mcp-item-name{font-size:12.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.1px}
.dsh-mcp-item-sub{font-size:10.5px;color:var(--mcp-mut);display:flex;gap:6px;align-items:center}
.dsh-mcp-badge{display:inline-flex;align-items:center;padding:1.5px 7px;border-radius:999px;font-size:10.5px;font-weight:500;line-height:16px;border:1px solid var(--mcp-line);color:var(--mcp-mut);background:var(--mcp-bg-1);corner-shape:round}
.dsh-mcp-badge.dot::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;margin-right:5px;opacity:.85;corner-shape:round}
.dsh-mcp-badge.t-http{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary)}
.dsh-mcp-badge.t-stdio{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary)}
.dsh-mcp-badge.s-on{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}
.dsh-mcp-badge.s-on.dot::before{background:var(--dsw-alias-state-success-primary)}
.dsh-mcp-badge.s-err.dot::before{background:var(--dsw-alias-state-error-primary)}
.dsh-mcp-badge.s-off{color:var(--mcp-mut);border-color:var(--mcp-line)}
.dsh-mcp-badge.s-err{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsh-mcp-badge.scope-ws{color:var(--mcp-accent);border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dsh-mcp-detail{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-2);padding:16px;overflow-y:auto}
.dsh-mcp-d-empty{display:flex;flex:1;align-items:center;justify-content:center;color:var(--mcp-mut);font-size:13px;gap:8px}
.dsh-mcp-d-empty::before{content:"";width:34px;height:34px;border-radius:var(--mcp-r-md);background:var(--dsw-alias-interactive-bg-hover-accent);border:1px solid var(--mcp-accent)}
.dsh-mcp-d-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.dsh-mcp-d-name{font-size:17px;font-weight:700;letter-spacing:.2px;display:flex;align-items:center;gap:8px;min-width:0;overflow-wrap:anywhere}
.dsh-mcp-d-meta{display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap}
.dsh-mcp-d-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.dsh-mcp-d-scope-hint{font-size:11.5px;color:var(--mcp-mut)}
.dsh-mcp-card{border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);padding:12px 14px;background:var(--mcp-bg-1)}
.dsh-mcp-card h4{margin:0 0 9px;font-size:10.5px;font-weight:650;color:var(--mcp-mut);text-transform:uppercase;letter-spacing:.8px;display:flex;align-items:center;gap:6px}
.dsh-mcp-card h4::after{content:"";flex:1;height:1px;background:var(--mcp-line);margin-left:2px}
.dsh-mcp-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:5px 14px;font-size:12px;word-break:break-all}
.dsh-mcp-kv>*{min-width:0}
.dsh-mcp-kv b{color:var(--mcp-mut);font-weight:500;white-space:normal;overflow-wrap:anywhere}
.dsh-mcp-tools{display:flex;flex-direction:column;gap:5px}
.dsh-mcp-tool{display:flex;gap:9px;padding:7px 9px;border-radius:var(--mcp-r-sm);background:var(--mcp-bg-1);border:1px solid transparent;transition:background .12s,border-color .12s}
.dsh-mcp-tool:hover{border-color:var(--mcp-line);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-tool-name{font-family:var(--mcp-mono);font-size:11.5px;color:var(--dsw-alias-brand-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:46%}
.dsh-mcp-tool-desc{font-size:11.5px;color:var(--mcp-mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mcp-empty-list{padding:20px;text-align:center;color:var(--mcp-mut);font-size:12px}
.dsh-mcp-overlay{position:fixed;inset:0;background:var(--dsw-alias-bg-overlay);display:flex;align-items:center;justify-content:center;z-index:200;padding:12px;animation:mcpFade .14s ease-out}
.dsh-mcp-whatsnew{box-sizing:border-box;width:min(460px,92vw);background:var(--mcp-bg-2);border:0;border-radius:var(--mcp-r-panel);padding:18px;box-shadow:var(--dsw-elevation-prominent);animation:mcpPop .18s cubic-bezier(.2,.9,.3,1.15)}
.dsh-mcp-whatsnew-head{display:flex;flex-direction:column;gap:2px;margin-bottom:12px}
.dsh-mcp-whatsnew-head b{font-size:15px;font-weight:650}
.dsh-mcp-whatsnew-head span{font-size:12px;color:var(--mcp-mut)}
.dsh-mcp-whatsnew-body{display:flex;flex-direction:column;gap:12px;max-height:52vh;overflow-y:auto}
.dsh-mcp-whatsnew-entry{display:flex;flex-direction:column;gap:6px}
.dsh-mcp-whatsnew-ver{font-size:11px;font-weight:650;color:var(--mcp-accent)}
.dsh-mcp-whatsnew-item{display:flex;gap:8px;font-size:12.5px;line-height:1.6}
.dsh-mcp-whatsnew-dot{flex:none;color:var(--mcp-accent)}
.dsh-mcp-whatsnew-where{display:block;margin-top:3px;width:fit-content;padding:0 6px;border-radius:999px;background:var(--mcp-line);color:var(--mcp-mut);font-size:11px;line-height:17px;white-space:nowrap;corner-shape:round}
.dsh-mcp-whatsnew-foot{display:flex;justify-content:flex-end;margin-top:14px}
.dsh-mcp-modal{box-sizing:border-box;width:560px;max-width:92vw;max-height:84vh;overflow-y:auto;background:var(--mcp-bg-2);border:0;border-radius:var(--mcp-r-panel);padding:20px;box-shadow:var(--dsw-elevation-prominent);animation:mcpPop .16s ease-out}
.dsh-mcp-modal h3{margin:0 0 16px;font-size:15px;font-weight:650;display:flex;align-items:center;gap:8px}
.dsh-mcp-modal h3::before{content:"";width:4px;height:14px;border-radius:2px;background:var(--mcp-accent)}
.dsh-mcp-field{margin-bottom:14px}
.dsh-mcp-field label{display:block;font-size:11.5px;color:var(--mcp-mut);margin-bottom:6px;font-weight:500}
.dsh-mcp-field input,.dsh-mcp-field select,.dsh-mcp-field textarea{width:100%;box-sizing:border-box;padding:8px 11px;border-radius:var(--mcp-r-md);border:1px solid var(--mcp-line);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;outline:none;transition:border-color .15s,box-shadow .15s}
.dsh-mcp-field input::placeholder{color:var(--mcp-mut)}
.dsh-mcp-field input:focus,.dsh-mcp-field select:focus,.dsh-mcp-field textarea:focus{border-color:var(--mcp-accent);box-shadow:none}
.dsh-mcp-radio-row{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dsh-mcp-radio-row label{display:flex;align-items:center;gap:8px;margin:0;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);padding:9px 12px;background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);cursor:pointer;font-size:12.5px;transition:border-color .12s,background .12s}
.dsh-mcp-radio-row label:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-radio-row label.sel{border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dsh-mcp-radio-row input[type='radio']{width:15px;height:15px;flex:none;margin:0;padding:0;appearance:none;-webkit-appearance:none;border:1.5px solid var(--dsw-alias-border-l3);border-radius:50%;background:transparent;position:relative;cursor:pointer;transition:border-color .12s,background .12s;corner-shape:round}
.dsh-mcp-radio-row input[type='radio']:checked{border-color:var(--mcp-accent);background:radial-gradient(circle,var(--dsw-alias-label-primary-inverted) 0 4px,var(--mcp-accent) 4.5px)}
.dsh-mcp-radio-row input[type='radio']:hover{border-color:var(--mcp-accent)}
.dsh-mcp-kv-edit{display:grid;grid-template-columns:38% 1fr auto;gap:8px;margin-bottom:8px;align-items:center}
.dsh-mcp-kv-edit input{width:100%;min-width:0;box-sizing:border-box}
.dsh-mcp-input-action{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:start}.dsh-mcp-input-action textarea{min-width:0}.dsh-mcp-kv-row-actions{display:flex;gap:5px;align-items:center;height:34px}.dsh-mcp-inline-icon{box-sizing:border-box;width:34px!important;height:34px!important;padding:0!important;flex:none}
.dsh-mcp-kv-del{box-sizing:border-box;width:34px;height:34px;padding:0!important;display:inline-flex;align-items:center;justify-content:center;flex:none}
.dsh-mcp-secret{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:100%}.dsh-mcp-secret-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:pre-wrap;word-break:break-all}.dsh-mcp-secret-btn{width:24px;height:24px;flex:none;padding:0;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-sm);background:var(--dsw-alias-button-elevated-fill);color:var(--mcp-mut);cursor:pointer}.dsh-mcp-secret-btn:hover{color:var(--dsw-alias-label-primary);border-color:var(--mcp-accent)}.dsh-mcp-secret-list{display:flex;flex-direction:column;gap:5px;min-width:0}.dsh-mcp-secret-row{display:grid;grid-template-columns:minmax(0,40%) minmax(0,1fr);gap:8px;align-items:center;min-width:0}.dsh-mcp-secret-row b{min-width:0;overflow-wrap:anywhere}.dsh-mcp-log{margin-top:10px;padding:9px 11px;border-left:3px solid var(--mcp-err);background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--mcp-err);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-word}.dsh-mcp-log.warn{border-left-color:var(--mcp-warn);color:var(--mcp-warn);background:var(--dsw-alias-state-warn-tertiary)}
.dsh-mcp-kv-add{display:flex;justify-content:flex-end;margin-top:2px}
.dsh-mcp-kv-del{border:1px solid var(--mcp-line);background:var(--dsw-alias-button-elevated-fill);color:var(--mcp-mut);cursor:pointer;font-size:14px;padding:3px 9px;border-radius:var(--mcp-r-sm);line-height:18px;transition:color .12s,background .12s,border-color .12s}
.dsh-mcp-kv-del:hover{color:var(--mcp-err);background:var(--dsw-alias-interactive-bg-hover-danger);border-color:var(--dsw-alias-state-error-primary)}
/* ── WorkBuddy 市场（WB 市场）────────────────────────────────────── */
.dsh-mcp-wb{display:flex;flex-direction:column;gap:10px;min-height:0}
.dsh-mcp-wb-tabs{display:flex;gap:8px;flex-wrap:wrap}
.dsh-mcp-wb-tab{border:1px solid var(--mcp-line);border-radius:var(--mcp-r-sm);background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:20px;padding:5px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:7px;transition:border-color .12s,color .12s}
.dsh-mcp-wb-tab:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.dsh-mcp-wb-tab.sel{border-color:var(--mcp-accent);color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-mcp-wb-disclaim{font-size:11px;line-height:1.55;color:var(--mcp-mut)}
.dsh-mcp-wb-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsh-mcp-wb-toolbar .dsh-mcp-check{margin:0!important;font-size:12px}
.dsh-mcp-wb-toolbar input[type='search']{flex:1 1 220px;min-width:160px;box-sizing:border-box}
.dsh-mcp-wb-search-row{display:flex;gap:8px;flex:1 1 260px;min-width:200px}
.dsh-mcp-wb-search-row input[type='search']{flex:1;min-width:120px;box-sizing:border-box}
.dsh-mcp-wb-sort{width:auto;flex:none}
.dsh-mcp-wb-note{font-size:12px;color:var(--mcp-ok);background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--mcp-line);border-radius:var(--mcp-r-sm);padding:7px 10px}
.dsh-mcp-wb-note.busy{color:var(--dsw-alias-label-secondary);border-style:dashed}
.dsh-mcp-wb-error{font-size:12px;color:var(--mcp-err);line-height:1.5}
.dsh-mcp-wb-empty{font-size:12.5px;color:var(--mcp-mut);padding:22px 0;text-align:center}
.dsh-mcp-wb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:10px;align-content:start}
.dsh-mcp-card.wb{display:flex;flex-direction:column;gap:7px;padding:11px 12px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1);min-width:0}
.dsh-mcp-card.wb.off{opacity:.82}
.dsh-mcp-card.wb .dsh-mcp-card-summary{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font-size:11.5px;color:var(--mcp-mut);line-height:1.5;min-height:2.9em}
.dsh-mcp-wb-card-actions{display:flex;align-items:center;gap:8px;margin-top:auto;flex-wrap:wrap}
.dsh-mcp-wb-blocked{font-size:10.5px;color:var(--mcp-warn);line-height:1.4;min-width:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dsh-mcp-wb-pager{display:flex;align-items:center;justify-content:center;gap:12px;padding:6px 0 2px}
.dsh-mcp-wb-modal{width:640px;max-width:92vw}
.dsh-mcp-wb-modal-desc{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-mcp-wb-modal-note{font-size:11.5px;line-height:1.6;color:var(--mcp-mut)}
.dsh-mcp-wb-examples{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);background:var(--mcp-bg-2);border-radius:var(--mcp-r-sm);padding:8px 12px;margin:10px 0}
.dsh-mcp-wb-examples ul{margin:4px 0 0;padding-left:18px}
.dsh-mcp-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px;flex-wrap:wrap}
.dsh-mcp-advanced{margin-top:14px}.dsh-mcp-check{display:flex!important;align-items:center;gap:8px;margin:9px 0!important;color:var(--dsw-alias-label-primary)!important}.dsh-mcp-check input{width:auto!important}.dsh-mcp-number-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.dsh-mcp-number-grid .dsh-mcp-field{margin-bottom:0}.dsh-mcp-import-preview{font-size:12px;line-height:1.6;color:var(--mcp-mut);white-space:pre-wrap}.dsh-mcp-import-json{min-height:220px;resize:vertical;font-family:var(--mcp-mono)!important}
.dsh-mcp-builtin-modal{box-sizing:border-box;width:700px;height:min(760px,84vh);display:flex;flex-direction:column;overflow:hidden}.dsh-mcp-builtin-toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 10px;flex:none}.dsh-mcp-builtin-toolbar .dsh-mcp-check{margin:0!important;font-size:12px}.dsh-mcp-builtin-count{font-size:11.5px;color:var(--mcp-mut)}.dsh-mcp-builtin-list{display:flex;flex-direction:column;gap:8px;min-height:0;overflow-y:auto;padding-right:2px}.dsh-mcp-builtin-modal>.dsh-mcp-modal-actions{flex:none}.dsh-mcp-builtin-row{display:grid;grid-template-columns:18px minmax(0,1fr) minmax(74px,auto);gap:11px;align-items:start;padding:11px 12px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1);cursor:pointer;transition:border-color .12s,background .12s;flex:none}.dsh-mcp-builtin-row:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}.dsh-mcp-builtin-row.installed{cursor:default;background:var(--mcp-bg-2)}.dsh-mcp-builtin-row.installed:hover{border-color:var(--mcp-line);background:var(--mcp-bg-2)}.dsh-mcp-builtin-select{box-sizing:border-box;width:16px!important;height:16px!important;margin:2px 0 0!important;accent-color:var(--mcp-accent);cursor:pointer}.dsh-mcp-builtin-select:disabled{cursor:default}.dsh-mcp-builtin-main{min-width:0;display:flex;flex-direction:column;gap:5px}.dsh-mcp-builtin-name{font-size:13px;font-weight:650;overflow-wrap:anywhere}.dsh-mcp-builtin-summary{font-size:11.5px;color:var(--mcp-mut);line-height:1.45}.dsh-mcp-builtin-meta{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.dsh-mcp-builtin-access{font-size:10.5px;color:var(--mcp-mut)}.dsh-mcp-builtin-config{font-family:var(--mcp-mono);font-size:10.5px;line-height:1.45;color:var(--dsw-alias-brand-text);overflow-wrap:anywhere;white-space:normal}.dsh-mcp-builtin-status{min-width:0;text-align:right;font-size:11px;color:var(--mcp-mut);line-height:1.45;overflow-wrap:anywhere}.dsh-mcp-builtin-status.ready{color:var(--dsw-alias-state-success-primary)}.dsh-mcp-builtin-loading{padding:30px 12px;text-align:center;color:var(--mcp-mut);font-size:12px}
.dsh-mcp-source-box{margin:0 0 14px;flex:none}.dsh-mcp-source-list{display:flex;flex-direction:column;gap:6px;max-height:186px;overflow-y:auto;margin-top:7px}.dsh-mcp-source-row{box-sizing:border-box;display:flex;flex-direction:column;gap:3px;width:100%;padding:8px 10px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:1.45;text-align:left;cursor:pointer;transition:border-color .12s,background .12s}.dsh-mcp-source-row:hover:not(:disabled){border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}.dsh-mcp-source-row.sel{border-color:var(--mcp-accent);background:var(--mcp-bg-2)}.dsh-mcp-source-row:disabled{cursor:default;opacity:.7}.dsh-mcp-source-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.dsh-mcp-source-name{font-weight:600}.dsh-mcp-source-path{font-family:var(--mcp-mono);font-size:10.5px;color:var(--dsw-alias-brand-text);overflow-wrap:anywhere}.dsh-mcp-source-detail{font-size:11px;color:var(--mcp-mut);overflow-wrap:anywhere}.dsh-mcp-source-note{font-size:10.5px;color:var(--mcp-mut)}.dsh-mcp-source-warn{font-size:10.5px;color:var(--mcp-warn)}
.dsh-mcp-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--dsw-alias-toast-bg);backdrop-filter:blur(10px);border:0;color:var(--dsw-alias-label-primary);padding:10px 18px;border-radius:var(--mcp-r-lg);font-size:12.5px;z-index:300;box-shadow:var(--dsw-shadow-lv3);max-width:70vw;animation:mcpPop .16s ease-out}
.dsh-mcp-toast.err{border:1px solid var(--dsw-alias-state-error-primary)}
.dsh-mcp-toast.ok{border:1px solid var(--dsw-alias-state-success-primary)}
.dsh-mcp-toggle{position:relative;width:34px;height:19px;box-sizing:border-box;border-radius:999px;border:0;cursor:pointer;background:var(--dsw-alias-border-l3);transition:background .18s,border-color .18s;flex:none;box-shadow:none;corner-shape:round}
.dsh-mcp-toggle[aria-checked='true']{background:var(--mcp-accent);border-color:transparent}
.dsh-mcp-toggle:disabled{opacity:.65;cursor:not-allowed}
.dsh-mcp-toggle::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-switch-thumb);transition:left .18s,background .18s;box-shadow:none;corner-shape:round}
.dsh-mcp-toggle[aria-checked='true']::after{left:17px;background:var(--dsw-alias-label-primary-foreground)}
.dsh-mcp-d-err{font-size:12.5px;color:var(--mcp-err);margin-top:8px;white-space:pre-wrap}
/* 悬浮按钮：外框尺寸必须恰好是 JS 里 FAB_SIZE 的值（拖拽边界与默认位置按它算，
   client.js 的 clampFabPos/defaultFabPos）。border-box 让这个等式不受边框影响——
   之前是 1px 边框 + content-box，渲染出 52px 而 JS 按 50px 夹取，右/下边缘会差 2px；
   现在去掉边框（抬升表面改成 elevation 阴影）+ border-box，两边一致且不会再漂。 */
.dsh-mcp-fab{position:fixed;right:22px;bottom:22px;box-sizing:border-box;width:50px;height:50px;border-radius:50%;border:0;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);cursor:grab;user-select:none;display:flex;align-items:center;justify-content:center;box-shadow:var(--dsw-elevation-panel);z-index:190;touch-action:none;transition:transform .16s,background .16s;pointer-events:auto;corner-shape:round}
.dsh-mcp-fab:hover{transform:scale(1.05);background:var(--dsw-alias-button-primary-hover)}
.dsh-mcp-fab:active{transform:scale(.97)}
.dsh-mcp-fab svg{width:22px;height:22px}
.dsh-mcp-panel-overlay{position:fixed;inset:0;background:var(--dsw-alias-bg-overlay);display:flex;align-items:center;justify-content:center;z-index:180;padding:26px;pointer-events:auto;animation:mcpFade .14s ease-out}
.dsh-mcp-panel{box-sizing:border-box;width:1000px;max-width:95vw;height:88vh;background:var(--mcp-bg-2);border:0;border-radius:var(--mcp-r-panel);box-shadow:var(--dsw-elevation-prominent);display:flex;flex-direction:column;overflow:hidden;animation:mcpPop .18s cubic-bezier(.2,.9,.3,1.15)}
.dsh-mcp-panel .dsh-mcp-wrap{height:100%;min-height:0;padding:18px}
.dsh-mcp-filters{display:grid;grid-template-columns:1fr 1fr;gap:6px}
.dsh-mcp-filters select{width:100%;box-sizing:border-box;padding:6px 24px 6px 8px;border-radius:var(--mcp-r-sm);border:1px solid var(--mcp-line);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;outline:none;transition:border-color .15s;appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--mcp-mut) 50%),linear-gradient(135deg,var(--mcp-mut) 50%,transparent 50%);background-position:calc(100% - 13px) 50%,calc(100% - 9px) 50%;background-size:4px 4px,4px 4px;background-repeat:no-repeat}
.dsh-mcp-filters select:focus{border-color:var(--mcp-accent)}
.dsh-mcp-tool{flex-direction:column;padding:0;gap:0}
.dsh-mcp-tool-head{display:flex;align-items:center;gap:9px;padding:7px 9px;border-radius:var(--mcp-r-sm)}
.dsh-mcp-tool-head.interactive{cursor:pointer}
.dsh-mcp-tool-head.interactive:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-tool-head.interactive:focus-visible{outline:1px solid var(--mcp-accent);outline-offset:-1px}
.dsh-mcp-tool-caret{flex:none;color:var(--mcp-mut);font-size:10px;width:14px;text-align:center}
.dsh-mcp-tool-body{padding:2px 9px 10px;display:flex;flex-direction:column;gap:8px}
.dsh-mcp-params{display:flex;flex-direction:column;gap:6px}
.dsh-mcp-param{border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);padding:7px 9px;background:var(--mcp-bg-1)}
.dsh-mcp-param-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.dsh-mcp-param-name{font-family:var(--mcp-mono);font-size:11.5px;color:var(--dsw-alias-brand-text);font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%}
.dsh-mcp-param-type{font-size:10px;color:var(--mcp-mut);border:1px solid var(--mcp-line);border-radius:var(--mcp-r-xs);padding:1px 5px;font-family:var(--mcp-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:60%}
.dsh-mcp-req{font-size:10px;color:var(--dsw-alias-state-warn-primary);border:1px solid var(--dsw-alias-state-warn-primary);border-radius:var(--mcp-r-xs);padding:1px 5px}
.dsh-mcp-opt{font-size:10px;color:var(--mcp-mut);border:1px solid var(--mcp-line);border-radius:var(--mcp-r-xs);padding:1px 5px}
.dsh-mcp-param-desc{font-size:11px;color:var(--mcp-mut);margin-top:4px;line-height:1.5;white-space:normal;word-break:break-word}
.dsh-mcp-param-enum{font-size:10.5px;color:var(--mcp-mut);margin-top:3px;font-family:var(--mcp-mono);word-break:break-all}
.dsh-mcp-tool-rawbtn{align-self:flex-start;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-sm);background:var(--dsw-alias-button-elevated-fill);color:var(--mcp-mut);font-size:11px;padding:4px 9px;cursor:pointer;transition:color .12s,border-color .12s}
.dsh-mcp-tool-rawbtn:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3)}
.dsh-mcp-json{font-family:var(--mcp-mono);font-size:11px;line-height:1.5;background:var(--mcp-bg-1);border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);padding:9px;overflow:auto;white-space:pre;max-height:260px;color:var(--dsw-alias-label-primary);margin:0}
.dsh-mcp-market{box-sizing:border-box;width:min(1080px,94vw);height:min(820px,88vh);display:flex;flex-direction:column;overflow:hidden}.dsh-mcp-market-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;flex:none;margin:0 0 12px}.dsh-mcp-market-head h3{margin:0}.dsh-mcp-market-stat{font-size:11.5px;color:var(--mcp-mut)}.dsh-mcp-market-search{position:relative;flex:none;margin-bottom:10px}.dsh-mcp-market-search svg{position:absolute;left:11px;top:50%;transform:translateY(-50%);opacity:.5}.dsh-mcp-market-search input{width:100%;box-sizing:border-box;padding:10px 12px 10px 34px;border-radius:var(--mcp-r-md);border:1px solid var(--mcp-line);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none;transition:border-color .15s}.dsh-mcp-market-search input::placeholder{color:var(--mcp-mut)}.dsh-mcp-market-search input:focus{border-color:var(--mcp-accent)}.dsh-mcp-market-chips{display:flex;gap:6px;align-items:center;overflow-x:auto;scrollbar-width:none;flex:none;padding:1px 0;margin-bottom:10px}.dsh-mcp-market-chips::-webkit-scrollbar{display:none}.dsh-mcp-chip{display:inline-flex;align-items:center;gap:5px;flex:none;padding:5px 11px;border-radius:999px;corner-shape:round;border:1px solid var(--mcp-line);background:var(--mcp-bg-1);color:var(--mcp-mut);font:inherit;font-size:12px;line-height:1.5;white-space:nowrap;cursor:pointer;transition:background .13s,border-color .13s,color .13s}.dsh-mcp-chip:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}.dsh-mcp-chip.sel{color:var(--dsw-alias-label-primary);border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent);font-weight:600}.dsh-mcp-chip-count{font-size:10px;padding:0 5px;border-radius:999px;corner-shape:round;background:var(--mcp-line);color:var(--mcp-mut);line-height:15px}.dsh-mcp-chip.sel .dsh-mcp-chip-count{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--mcp-accent)}.dsh-mcp-market-filters{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none;margin-bottom:10px;font-size:12px;color:var(--mcp-mut)}.dsh-mcp-market-filters select{padding:5px 22px 5px 9px;border-radius:var(--mcp-r-sm);border:1px solid var(--mcp-line);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none;appearance:none;-webkit-appearance:none;background-image:linear-gradient(45deg,transparent 50%,var(--mcp-mut) 50%),linear-gradient(135deg,var(--mcp-mut) 50%,transparent 50%);background-position:calc(100% - 12px) 50%,calc(100% - 8px) 50%;background-size:4px 4px,4px 4px;background-repeat:no-repeat;cursor:pointer}.dsh-mcp-market-filters select:focus{border-color:var(--mcp-accent)}.dsh-mcp-market-filters label{display:inline-flex;align-items:center;gap:6px;cursor:pointer}.dsh-mcp-market-filters input[type='checkbox']{width:14px;height:14px;margin:0;accent-color:var(--mcp-accent);cursor:pointer}.dsh-mcp-market-grid{flex:1 1 auto;min-height:0;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:10px;align-content:start;padding-right:2px}.dsh-mcp-card{box-sizing:border-box;display:flex;flex-direction:column;gap:9px;padding:13px 14px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-1);transition:border-color .13s,background .13s}.dsh-mcp-card:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}.dsh-mcp-card.installed{border-color:var(--dsw-alias-state-success-primary)}.dsh-mcp-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}.dsh-mcp-card-name{font-size:14px;font-weight:650;line-height:1.35;overflow-wrap:anywhere}.dsh-mcp-card-vendor{font-size:10.5px;color:var(--mcp-mut);margin-top:2px}.dsh-mcp-card-summary{font-size:12px;line-height:1.55;color:var(--mcp-mut);flex:1 1 auto}.dsh-mcp-card-tags{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.dsh-mcp-card-access{font-size:10.5px;color:var(--mcp-mut);line-height:1.45;overflow-wrap:anywhere}.dsh-mcp-card-actions{display:flex;gap:7px;align-items:center;flex:none}.dsh-mcp-card-actions .dsh-mcp-btn{flex:1 1 auto;justify-content:center}.dsh-mcp-market-empty{grid-column:1 / -1;padding:40px 20px;text-align:center;color:var(--mcp-mut);font-size:13px}.dsh-mcp-market-selectall{margin-left:auto;white-space:nowrap}.dsh-mcp-card-note{font-size:10.5px;line-height:1.45;color:var(--mcp-warn);overflow-wrap:anywhere}.dsh-mcp-card-vars{display:flex;flex-direction:column;gap:2px;font-size:10.5px;line-height:1.45;color:var(--dsw-alias-brand-text);overflow-wrap:anywhere}@keyframes mcpPop{from{opacity:0;transform:scale(.965) translateY(6px)}to{opacity:1;transform:scale(1) translateY(0)}}
@keyframes mcpFade{from{opacity:0}to{opacity:1}}
.dsh-mcp-tabs-wrap{position:relative;flex:none;min-width:0}.dsh-mcp-tabs{display:flex;gap:6px;align-items:center;overflow-x:auto;scrollbar-width:none;padding:2px 0}.dsh-mcp-tabs::-webkit-scrollbar{display:none}.dsh-mcp-tab{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:var(--mcp-r-sm);border:1px solid var(--mcp-line);background:var(--mcp-bg-1);color:var(--mcp-mut);font-size:12px;cursor:pointer;flex:none;white-space:nowrap;transition:background .13s,border-color .13s,color .13s;line-height:1.4}.dsh-mcp-tab:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}.dsh-mcp-tab.sel{color:var(--dsw-alias-label-primary);border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent);font-weight:600}.dsh-mcp-tab-count{font-size:10px;font-weight:500;padding:0 6px;border-radius:999px;background:var(--mcp-line);color:var(--mcp-mut);line-height:15px;corner-shape:round}.dsh-mcp-tab.more.open{color:var(--dsw-alias-label-primary);border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent)}.dsh-mcp-tab-pop{position:absolute;top:calc(100% + 5px);right:0;z-index:60;background:var(--mcp-bg-2);border:0;border-radius:var(--mcp-r-lg);box-shadow:var(--dsw-elevation-panel);padding:6px;display:flex;flex-direction:column;gap:2px;min-width:170px}
/* 弹层里的行复用 .dsh-mcp-tab，但它自带 padding+border 且是 content-box：width:100%
   会把内边距和边框再加一遍，整行比弹层宽出一圈而溢出（与下面 .dsh-mcp-entry-item 同一个坑）。 */
.dsh-mcp-tab-pop .dsh-mcp-tab{box-sizing:border-box;width:100%}.dsh-mcp-entry{position:relative;display:inline-flex}.dsh-mcp-entry-pop{left:auto;right:0;min-width:196px}
/* 菜单行不复用 .dsh-mcp-tab：那是标签 chip（content-box + 自带 padding/border），配上 width:100%
   会把内边距和边框再加一遍，整行比弹层宽出一圈而溢出。行自己的盒模型必须 border-box。 */
.dsh-mcp-entry-item{box-sizing:border-box;display:flex;align-items:center;width:100%;padding:7px 10px;border:1px solid transparent;border-radius:var(--mcp-r-sm);background:transparent;color:var(--mcp-mut);font-family:inherit;font-size:12px;line-height:1.4;text-align:left;white-space:nowrap;cursor:pointer;transition:background .13s,border-color .13s,color .13s}
.dsh-mcp-entry-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-entry-item.sel{border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-label-primary);font-weight:600}.dsh-mcp-ws-body{width:288px;min-width:248px;min-height:0;display:flex;flex-direction:column;gap:10px;overflow-y:auto;overflow-x:hidden}.dsh-mcp-section{display:flex;flex-direction:column;gap:8px;min-height:0;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-2);padding:10px;overflow:hidden}.dsh-mcp-section.local{flex:0 1 auto;min-height:124px;max-height:62%;border-color:var(--mcp-accent)}.dsh-mcp-section.global{flex:1 1 0;min-height:124px}.dsh-mcp-section-title{font-size:10.5px;font-weight:650;color:var(--mcp-mut);text-transform:uppercase;letter-spacing:.6px;display:flex;align-items:center;gap:6px;flex:none}.dsh-mcp-section.local .dsh-mcp-section-title{color:var(--dsw-alias-label-primary)}.dsh-mcp-section-title::after{content:"";flex:1;height:1px;background:var(--mcp-line)}.dsh-mcp-section-count{flex:none;font-size:10px;font-weight:600;letter-spacing:0;padding:0 6px;border-radius:999px;background:var(--mcp-line);color:var(--mcp-mut);line-height:15px;corner-shape:round}.dsh-mcp-section.local .dsh-mcp-section-count{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--mcp-accent)}.dsh-mcp-global-list{display:flex;flex-direction:column;gap:3px;overflow-y:auto;min-height:52px;margin:0 -4px;padding:0 4px}
.dsh-mcp-item.muted{opacity:.52}
.dsh-mcp-item.muted:hover{opacity:.85}
.dsh-mcp-global-search{position:relative;flex:none}
.dsh-mcp-global-search svg{position:absolute;left:10px;top:50%;transform:translateY(-50%);opacity:.5}
.dsh-mcp-global-search input{width:100%;box-sizing:border-box;padding:7px 10px 7px 30px;border-radius:var(--mcp-r-sm);border:1px solid var(--mcp-line);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font-size:11.5px;outline:none;transition:border-color .15s}
.dsh-mcp-global-search input::placeholder{color:var(--mcp-mut)}
.dsh-mcp-section.global.collapsed{flex:none;min-height:0;border-color:transparent;background:transparent;padding:0;overflow:visible}
.dsh-mcp-section-toggle{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;flex:none;padding:7px 9px;border:1px solid transparent;border-radius:var(--mcp-r-sm);background:transparent;color:var(--mcp-mut);font:inherit;font-size:10.5px;font-weight:650;text-transform:uppercase;letter-spacing:.6px;text-align:left;cursor:pointer;transition:background .13s,color .13s,border-color .13s}
.dsh-mcp-section-toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-mcp-section-toggle:focus{outline:none}
.dsh-mcp-section-toggle:focus-visible{outline:1px solid var(--mcp-accent);outline-offset:-1px}
.dsh-mcp-section.collapsed .dsh-mcp-section-toggle{border-color:var(--mcp-line);background:var(--mcp-bg-2)}
.dsh-mcp-caret{flex:none;width:10px;font-size:9px}
.dsh-mcp-section-toggle-label{flex:none}
.dsh-mcp-section-summary{margin-left:auto;flex:none;font-size:10.5px;font-weight:500;text-transform:none;letter-spacing:0;color:var(--mcp-mut)}
.dsh-mcp-eye{box-sizing:border-box;width:30px;height:26px;flex:none;padding:0;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-sm);background:var(--dsw-alias-button-elevated-fill);color:var(--mcp-mut);cursor:pointer;transition:color .12s,border-color .12s,background .12s}
.dsh-mcp-eye:hover{color:var(--dsw-alias-label-primary);border-color:var(--mcp-accent)}
.dsh-mcp-eye.off{color:var(--mcp-err);border-color:var(--mcp-err);background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsh-mcp-eye:disabled{opacity:.5;cursor:not-allowed}
.dsh-mcp-upd{flex:none;display:flex;align-items:center;gap:10px;padding:7px 11px;border:1px solid var(--mcp-accent);border-radius:var(--mcp-r-md);background:var(--dsw-alias-interactive-bg-hover-accent);font-size:12px}
.dsh-mcp-upd a{color:var(--mcp-accent);font-weight:600;text-decoration:none}
.dsh-mcp-upd a:hover{text-decoration:underline}
/* 一键升级按钮：与 .dsh-mcp-btn.primary 同令牌，但更小——它长在提示条里，不该抢面板主操作的视觉权重。 */
.dsh-mcp-upd-go{box-sizing:border-box;display:inline-flex;align-items:center;padding:4px 12px;border:1px solid transparent;border-radius:var(--mcp-r-sm);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);font-size:12px;font-weight:600;cursor:pointer}
.dsh-mcp-upd-go:hover{background:var(--dsw-alias-button-primary-hover)}
.dsh-mcp-upd-close{margin-left:auto;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:1px solid transparent;border-radius:var(--mcp-r-sm);background:transparent;color:var(--mcp-mut);cursor:pointer}
.dsh-mcp-upd-close:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
/* 左侧栏底部入口（sidebar.footer.action）：与 DSH 侧栏底部其它控件同规格——
   展开态是 42px 行（图标 + 文字），收起轨道是 36px 圆钮（仅图标）。 */
.dsh-mcp-footer-action{display:inline-flex;align-items:center;gap:8px;width:100%;height:42px;box-sizing:border-box;margin:0 -2px;padding:0 10px 0 8px;border:none;border-radius:var(--mcp-r-md);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:14px;cursor:pointer;transition:background .15s}
.dsh-mcp-footer-action:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-footer-action:active{background:var(--dsw-alias-interactive-bg-active)}
.dsh-mcp-footer-action.rail{justify-content:center;gap:0;width:36px;height:36px;margin:0;padding:0;border-radius:50%;corner-shape:round}
.dsh-mcp-footer-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mcp-footer-meta{flex:none;margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}
/* ── 主面板页（main slot，和「插件」同级的入口页）────────────────────────
   入口型页面要用 --dsh-frame-top-clearance 让出窗口顶带（官方 ui-layout 的约定：
   "entry pages in the main panel pad their top by it"），对话面板除外。 */
.dsh-mcp-page{box-sizing:border-box;height:100%;min-height:0;overflow:auto;padding:calc(var(--dsh-frame-top-clearance,0px) + 16px) 20px 24px;background:var(--dsw-alias-bg-base)}
.dsh-mcp-page>.dsh-mcp-wrap{height:calc(100dvh - var(--dsh-frame-top-clearance,0px) - 40px);min-height:520px;max-width:1180px;margin:0 auto}
.dsh-mcp-page .dsh-mcp-body{flex:1 1 auto;min-height:0}
/* 主面板页里没有「关闭」按钮（返回对话由侧栏入口/会话列表承担），顶栏右侧留白更自然。 */
.dsh-mcp-page .dsh-mcp-head{padding-right:2px}

/* ── 看板顶层分类（MCP / Skill）──────────────────────────────────── */
.dsh-mcp-cats{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-mcp-cat{border:0;border-radius:var(--mcp-r-sm);corner-shape:round;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;line-height:20px;padding:6px 12px;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
.dsh-mcp-cat:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-mcp-cat[aria-pressed="true"]{background:var(--mcp-bg-3);color:var(--dsw-alias-label-primary);font-weight:500}
.dsh-mcp-cat:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsh-mcp-cat-count{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsh-mcp-cat[aria-pressed="true"] .dsh-mcp-cat-count{color:var(--dsw-alias-label-secondary)}

/* ── Skill 看板 ─────────────────────────────────────────────────── */
.dsh-mcp-skill-view{display:flex;flex-direction:column;gap:12px;min-height:0}
.dsh-mcp-skill-body{display:flex;gap:14px;min-height:0;align-items:stretch}
.dsh-mcp-skill-side{width:340px;flex:none;display:flex;flex-direction:column;gap:10px;min-height:0}
.dsh-mcp-skill-list{overflow-y:auto;min-height:0;display:flex;flex-direction:column;gap:4px;padding-right:2px}
.dsh-mcp-skill{display:flex;align-items:flex-start;gap:9px;padding:9px 10px;border-radius:var(--mcp-r-md);corner-shape:round;cursor:pointer;border:0;background:0 0;color:inherit;font:inherit;text-align:left}
.dsh-mcp-skill:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-skill[aria-selected="true"]{background:var(--mcp-bg-3)}
.dsh-mcp-skill:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsh-mcp-skill-main{min-width:0;flex:1 1 auto}
.dsh-mcp-skill-name{font-weight:500;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;word-break:break-word}
.dsh-mcp-skill-sub{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:3px}
.dsh-mcp-skill-src{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-family:var(--mcp-mono)}
.dsh-mcp-skill-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dsh-mcp-skill-detail{flex:1 1 auto;min-width:0;min-height:0;border:.5px solid var(--mcp-line);border-radius:var(--mcp-r-lg);corner-shape:round;background:var(--mcp-bg-1);display:flex;flex-direction:column;overflow:hidden}
.dsh-mcp-skill-d-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:14px 16px 10px}
.dsh-mcp-skill-d-title{margin:0;font-size:15px;font-weight:500;color:var(--dsw-alias-label-primary);line-height:20px;word-break:break-word}
.dsh-mcp-skill-d-sub{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;font-family:var(--mcp-mono);word-break:break-all}
.dsh-mcp-skill-d-body{padding:4px 16px 16px;overflow-y:auto;min-height:0;display:flex;flex-direction:column;gap:12px}
.dsh-mcp-skill-d-sec{margin:0}
.dsh-mcp-skill-d-sec>b{display:block;font-size:11px;font-weight:500;letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin-bottom:5px}
.dsh-mcp-skill-d-desc{margin:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;white-space:pre-wrap}
.dsh-mcp-skill-d-md{margin:0;border:.5px solid var(--mcp-line);border-radius:var(--mcp-r-md);corner-shape:round;background:var(--mcp-bg-2);color:var(--dsw-alias-label-primary);font-family:var(--mcp-mono);font-size:12px;line-height:18px;padding:12px;white-space:pre-wrap;word-break:break-word;overflow-x:auto;max-height:52vh}
.dsh-mcp-skill-d-path{display:inline-flex;align-items:center;gap:6px;border:0;border-radius:var(--mcp-r-sm);corner-shape:round;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:17px;font-family:var(--mcp-mono);padding:0;cursor:pointer;text-align:left;word-break:break-all}
.dsh-mcp-skill-d-path:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}
.dsh-mcp-skill-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:10px 2px}

/* 工具裁缝（Tool Tailor）：账本表格 + 税单卡 + 死工具清单。 */
.dsh-mcp-tailor{display:flex;flex-direction:column;gap:12px;min-height:0}
.dsh-mcp-tailor-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;flex:none}
.dsh-mcp-tailor-card{box-sizing:border-box;border:0.5px solid var(--mcp-line);border-radius:var(--mcp-r-md);corner-shape:round;background:var(--mcp-bg-2);padding:12px 14px;display:flex;flex-direction:column;gap:4px}
.dsh-mcp-tailor-card>b{font-size:22px;font-weight:600;line-height:26px;font-variant-numeric:tabular-nums}
.dsh-mcp-tailor-card>span{font-size:12px;color:var(--mcp-mut);line-height:17px}
.dsh-mcp-tailor-card.dead>b{color:var(--mcp-warn)}
.dsh-mcp-tailor-card.err>b{color:var(--mcp-err)}
.dsh-mcp-tailor-toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:none}
.dsh-mcp-tailor-toolbar .dsh-mcp-select{width:auto;min-width:96px}
.dsh-mcp-tailor-meta{color:var(--mcp-mut);font-size:12px;line-height:17px;margin-left:auto}
.dsh-mcp-tailor-table{border:0.5px solid var(--mcp-line);border-radius:var(--mcp-r-md);corner-shape:round;overflow-y:auto;min-height:0;flex:1 1 auto;background:var(--mcp-bg-1)}
.dsh-mcp-tailor-row{display:grid;grid-template-columns:minmax(200px,1.4fr) 74px 74px 84px 84px minmax(120px,1fr);gap:10px;align-items:center;padding:8px 14px;border-top:0.5px solid var(--mcp-line);font-size:13px;line-height:18px}
.dsh-mcp-tailor-row:first-child{border-top:0}
.dsh-mcp-tailor-row.head{position:sticky;top:0;z-index:1;background:var(--mcp-bg-2);color:var(--mcp-mut);font-size:12px;padding:9px 14px}
.dsh-mcp-tailor-row.dead{background:color-mix(in srgb,var(--mcp-warn) 7%,transparent)}
.t-name{font-family:var(--mcp-mono);font-size:12.5px;word-break:break-all}
.t-badge{display:inline-block;font-size:11px;line-height:16px;border:0.5px solid var(--mcp-line);border-radius:999px;padding:0 8px;color:var(--mcp-mut);margin-right:6px;vertical-align:1px}
.t-badge.warn{color:var(--mcp-warn);border-color:var(--mcp-warn)}
.t-badge.err{color:var(--mcp-err);border-color:var(--mcp-err)}
.t-num{font-variant-numeric:tabular-nums;text-align:right}
.t-tax{font-variant-numeric:tabular-nums}
.t-last{color:var(--mcp-mut);font-size:12px}
.t-act{justify-self:end}
.dsh-mcp-tailor-empty{color:var(--mcp-mut);font-size:13px;padding:18px 14px}
.dsh-mcp-tailor-note{border:0.5px solid var(--mcp-line);border-radius:var(--mcp-r-md);corner-shape:round;background:var(--mcp-bg-2);padding:10px 14px;font-size:12.5px;line-height:19px;color:var(--mcp-mut);flex:none}
.dsh-mcp-tailor-note b{color:var(--dsw-alias-label-primary)}

/* 响应式覆盖必须位于全部基础规则之后：同特异性下后出现者胜出。 */
@media (max-width:760px){.dsh-mcp-panel-overlay{padding:10px}.dsh-mcp-panel{max-width:none;width:100%;height:calc(100dvh - 20px);border-radius:var(--mcp-r-panel)}.dsh-mcp-panel .dsh-mcp-wrap{padding:12px}.dsh-mcp-head{align-items:flex-start}.dsh-mcp-body{flex-direction:column;overflow-y:auto;overflow-x:hidden}.dsh-mcp-side,.dsh-mcp-ws-body{width:auto;min-width:0;max-height:none;flex:none}.dsh-mcp-side:not(.embedded) .dsh-mcp-list{max-height:38vh}.dsh-mcp-section.local,.dsh-mcp-section.global{flex:none;min-height:0;max-height:none}.dsh-mcp-section.local .dsh-mcp-list{max-height:30vh}.dsh-mcp-global-list{max-height:30vh}.dsh-mcp-detail{padding:12px;flex:none}.dsh-mcp-d-head{flex-direction:column}.dsh-mcp-kv-edit{grid-template-columns:minmax(90px,35%) minmax(0,1fr) auto}.dsh-mcp-page{padding:calc(var(--dsh-frame-top-clearance,0px) + 10px) 12px 20px}.dsh-mcp-page>.dsh-mcp-wrap{min-height:0;height:auto}.dsh-mcp-skill-body{flex-direction:column;overflow:visible}.dsh-mcp-skill-side{width:auto;flex:none}.dsh-mcp-skill-list{max-height:34vh}.dsh-mcp-skill-detail{flex:none;max-height:none}.dsh-mcp-skill-d-md{max-height:38vh}}
@media (max-width:480px){.dsh-mcp-head{flex-direction:column}.dsh-mcp-head-actions{width:100%;justify-content:flex-start}.dsh-mcp-btn{padding:7px 9px}.dsh-mcp-radio-row,.dsh-mcp-number-grid{grid-template-columns:1fr}.dsh-mcp-modal{max-width:none;width:100%;padding:14px}.dsh-mcp-kv{grid-template-columns:1fr;gap:4px}.dsh-mcp-kv>b{margin-top:4px}.dsh-mcp-secret-row{grid-template-columns:1fr;gap:4px}.dsh-mcp-secret{width:100%}.dsh-mcp-kv-edit{grid-template-columns:1fr auto}.dsh-mcp-kv-edit input:first-child{grid-column:1 / -1}.dsh-mcp-tool{flex-direction:column}.dsh-mcp-tool-name{max-width:100%}.dsh-mcp-tool-desc{white-space:normal}.dsh-mcp-builtin-toolbar{align-items:flex-start;flex-direction:column}.dsh-mcp-builtin-row{grid-template-columns:18px minmax(0,1fr)}.dsh-mcp-builtin-status{grid-column:2;text-align:left}}
`;

const h = React2.createElement;
const MAX_TIMER_DELAY_MS = 2147483647;
const REDACTED_VALUE = '__DSH_MCP_REDACTED__';
const PRESERVED_VALUE_LABEL = '••••••（保留原值）';
const MASKED_VALUE = '••••••';
const toFormValue = (value) => value === REDACTED_VALUE ? PRESERVED_VALUE_LABEL : String(value || '');
const fromFormValue = (value) => value === PRESERVED_VALUE_LABEL ? REDACTED_VALUE : value;
const displayValue = (value) => value === REDACTED_VALUE ? MASKED_VALUE : value;
function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

const Toggle = ({ on, disabled, onChange, title, label }) =>
  h('button', {
    type: 'button',
    role: 'switch',
    className: 'dsh-mcp-toggle',
    disabled,
    title,
    // 状态只走 aria-checked，不另设 class —— 与官方 ui-primitives/Switch 同一形状
    // （Switch.module.css 开头的注释：外观键于 aria-checked 而非并行 class，视觉状态
    // 就不会与辅助技术读到的状态不一致）。CSS 侧读 [aria-checked='true']。
    'aria-checked': on,
    'aria-label': label,
    onClick: (e) => { e.stopPropagation(); if (onChange) onChange(!on); },
  });

const Dot = ({ phase }) => {
  const cls = phase === 'connected' ? 'connected' : phase === 'failed' ? 'failed' : phase === 'loading' || phase === 'waiting' ? 'loading' : '';
  return h('span', { className: 'dsh-mcp-dot ' + cls });
};

const Badge = ({ cls, children }) => h('span', { className: 'dsh-mcp-badge ' + (cls || '') }, children);

const Icon = ({ d, size, className }) =>
  h('svg', { className, width: size || 13, height: size || 13, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }, h('path', { d }));

const ICONS = {
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM13.5 13.5L11 11',
  plus: 'M8 3v10M3 8h10',
  refresh: 'M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3',
  trash: 'M3 4h10M6.5 4V2.8a.8.8 0 0 1 .8-.8h1.4a.8.8 0 0 1 .8.8V4M4.5 4l.6 9a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-9M6.7 7v4.5M9.3 7v4.5',
  plug: 'M6 2v4M10 2v4M4.5 6h7V8a3.5 3.5 0 0 1-7 0zM8 11.5V14',
  x: 'M4 4l8 8M12 4l-8 8',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  eye: 'M1.5 8s2.3-4 6.5-4 6.5 4 6.5 4-2.3 4-6.5 4S1.5 8 1.5 8zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  eyeOff: 'M2 2l12 12M6.1 4.3A7 7 0 0 1 8 4c4.2 0 6.5 4 6.5 4a8.7 8.7 0 0 1-2 2.5M9.9 11.7A7 7 0 0 1 8 12c-4.2 0-6.5-4-6.5-4a9 9 0 0 1 2-2.5',
  copy: 'M6 5.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1zM3.5 3.5h6.5v6.5',
  entry: 'M2.5 3.5h11v9h-11zM2.5 6.5h11M6.5 6.5v6',
  // Skill：菱形挂坠；folder：打开目录；board：侧栏面板行的看板图形
  skill: 'M8 1.5L13 6.5 8 14.5 3 6.5zM8 4.6L5 6.9 8 11.6 11 6.9z',
  folder: 'M2 4.5h4l1.2 1.6h6.3v6.4H2zM2 4.5V4a.9.9 0 0 1 .9-.9H6l1 1.4',
  board: 'M2.5 3.5h11v9h-11zM6 3.5v9M10 3.5v9M2.5 7h3.5M10 7h3.5',
  // 裁缝：交叉剪刀（双圆环手柄 + 交叉刀刃）
  scissors: 'M11.5 2.5l-7 11M4.5 2.5l7 11M4 13.4a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8zM12 13.4a1.9 1.9 0 1 0 0-3.8 1.9 1.9 0 0 0 0 3.8z',
  // store：市场（橱窗棚顶 + 门面），WorkBuddy 市场分类用
  store: 'M2.5 6.5L4 2.5h8l1.5 4M2.5 6.5h11M2.5 6.5V13.5h11V6.5M6 13.5v-4h4v4',
};

// ── 常用 MCP 预设模板（主流管理器常见的“浏览即添加”能力）────────────
// 预设只填充表单，不直接写入；命令依赖本机 npx / uvx，保存前请确认可用。
const MCP_PRESETS = [
  { id: 'filesystem', serverName: 'filesystem', label: 'Filesystem · 本地文件读写', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/dir'] },
  { id: 'memory', serverName: 'memory', label: 'Memory · 知识图谱记忆', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  { id: 'sequential-thinking', serverName: 'sequential-thinking', label: 'Sequential Thinking · 分步推理', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
  { id: 'time', serverName: 'time', label: 'Time · 时区时间工具（需 uvx）', transport: 'stdio', command: 'uvx', args: ['mcp-server-time'] },
  { id: 'git', serverName: 'git', label: 'Git · 版本控制（需 uvx）', transport: 'stdio', command: 'uvx', args: ['mcp-server-git'] },
];

// ── 工具参数 JSON Schema 的可读化渲染辅助 ────────────────────────────
function clearRevealState(generation, setValues, setBusy) {
  generation.current += 1;
  setValues({});
  setBusy?.('');
}
function consumeRevision(ref, next) {
  if (typeof next !== 'string') return false;
  const changed = ref.current !== '' && next !== ref.current;
  ref.current = next;
  return changed;
}
async function copyText(text) {
  let area;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof window !== 'undefined' && window.isSecureContext) {
      await navigator.clipboard.writeText(String(text));
      return true;
    }
    area = document.createElement('textarea');
    area.value = String(text);
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    return document.execCommand('copy') === true;
  } catch {
    return false;
  } finally {
    area?.remove();
  }
}
function describeType(node) {
  if (!node || typeof node !== 'object') return 'any';
  if (Array.isArray(node.type)) return node.type.join(' | ');
  if (node.anyOf || node.oneOf) {
    const branches = node.anyOf || node.oneOf || [];
    return branches.map(describeType).filter((value, index, list) => list.indexOf(value) === index).join(' | ');
  }
  if (node.type === 'array') return node.items ? 'array<' + describeType(node.items) + '>' : 'array';
  return typeof node.type === 'string' ? node.type : 'any';
}
function enumText(node) {
  return node && Array.isArray(node.enum) ? node.enum.map((value) => JSON.stringify(value)).join(', ') : '';
}

// 标签页估算宽度：用于溢出折叠（中文按 15px、ASCII 按 8px 粗估，含 padding）。
function estimateTabWidth(label, hasCount) {
  let width = 0;
  for (const ch of label) width += ch.charCodeAt(0) > 255 ? 15 : 8;
  return width + 26 + (hasCount ? 26 : 0);
}
// 与 `.dsh-mcp-tab-pop{min-width:170px}` 同源：锚点夹取要用它算「弹层还能放多左」。
const POPOVER_MIN_WIDTH = 170;

// 作用域标签页：全局固定首位；项目超出宽度时折叠为「…N」弹出层。
const ScopeTabs = ({ tabs, active, onSelect }) => {
  const rootRef = useRef(null);
  const barRef = useRef(null);
  const moreRef = useRef(null);
  const [barWidth, setBarWidth] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  // 弹层要贴着「…N」按钮，而不是贴标签条右边缘：标签条右侧常留有大段空白
  // （估算宽度偏保守，可见标签提前截断），贴右边缘会让弹层离点击处很远。
  const [moreRight, setMoreRight] = useState(0);
  const syncMoreAnchor = useCallback(() => {
    const wrap = rootRef.current;
    const btn = moreRef.current;
    if (!wrap || !btn) return;
    // 对齐到按钮右边缘；但窄屏上按钮可能很靠左，若右对齐会让 170px 的弹层从左边溢出，
    // 因此夹取到「弹层仍能完整落在标签条内」的范围（170 与 CSS 的 min-width 一致）。
    const gap = Math.round(wrap.getBoundingClientRect().right - btn.getBoundingClientRect().right);
    const maxRight = Math.max(0, Math.round(wrap.clientWidth) - POPOVER_MIN_WIDTH);
    setMoreRight(Math.min(Math.max(0, gap), maxRight));
  }, []);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') { setBarWidth(el.clientWidth); return; }
    const update = () => setBarWidth(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => { setMoreOpen(false); }, [active]);
  useEffect(() => {
    if (moreOpen) syncMoreAnchor();
  }, [moreOpen, barWidth, tabs, syncMoreAnchor]);
  useEffect(() => {
    if (!moreOpen) return;
    const close = (e) => { if (!rootRef.current || !rootRef.current.contains(e.target)) setMoreOpen(false); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [moreOpen]);
  const visibleCount = useMemo(() => {
    if (!barWidth || tabs.length === 0) return tabs.length;
    let acc = 0;
    let count = 0;
    for (let i = 0; i < tabs.length; i += 1) {
      const w = estimateTabWidth(tabs[i].label, tabs[i].count !== undefined) + 8;
      if (acc + w > barWidth) break;
      acc += w;
      count += 1;
    }
    if (count >= tabs.length) return tabs.length;
    // 有溢出时至少保留一个 tab，并为「…N」预留宽度。
    const moreWidth = 58;
    while (count > 1 && acc + moreWidth > barWidth) {
      count -= 1;
      acc -= estimateTabWidth(tabs[count].label, tabs[count].count !== undefined) + 8;
    }
    return count;
  }, [tabs, barWidth]);
  const hidden = visibleCount < tabs.length ? tabs.slice(visibleCount) : [];
  const visible = visibleCount < tabs.length ? tabs.slice(0, visibleCount) : tabs;
  // 弹层必须挂在滚动容器之外：.dsh-mcp-tabs 是 overflow-x:auto 的裁剪盒，
  // 放在里面（哪怕 position:absolute）会被整块裁掉，标签一多就再也点不到隐藏项目。
  // `right` 由 moreRight 给到「…N」按钮的右边缘，弹层因此贴住触发它的按钮。
  const popover = moreOpen && hidden.length
    ? h('div', { className: 'dsh-mcp-tab-pop', style: { right: moreRight + 'px' }, onClick: (e) => e.stopPropagation() },
        hidden.map((tab) =>
          h('div', { key: tab.key, role: 'tab', 'aria-selected': active === tab.key, className: 'dsh-mcp-tab' + (active === tab.key ? ' sel' : ''), onClick: () => { setMoreOpen(false); onSelect(tab.key); }, title: tab.title || tab.label },
            tab.label,
            tab.count !== undefined ? h('span', { className: 'dsh-mcp-tab-count' }, tab.count) : null,
          ),
        ),
      )
    : null;
  return h('div', { className: 'dsh-mcp-tabs-wrap', ref: rootRef },
    h('div', { className: 'dsh-mcp-tabs', ref: barRef },
      visible.map((tab) =>
        h('div', { key: tab.key, role: 'tab', 'aria-selected': active === tab.key, className: 'dsh-mcp-tab' + (active === tab.key ? ' sel' : ''), onClick: () => onSelect(tab.key), title: tab.title || tab.label },
          tab.label,
          tab.count !== undefined ? h('span', { className: 'dsh-mcp-tab-count' }, tab.count) : null,
        ),
      ),
      hidden.length ? h('div', { key: '__more__', ref: moreRef, role: 'tab', 'aria-expanded': moreOpen, className: 'dsh-mcp-tab more' + (moreOpen ? ' open' : ''), onClick: (e) => { e.stopPropagation(); syncMoreAnchor(); setMoreOpen((value) => !value); } }, h('b', null, '…'), hidden.length) : null,
    ),
    popover,
  );
};
function flattenParameters(schema) {
  if (!schema || typeof schema !== 'object') return { required: [], properties: [] };
  const required = Array.isArray(schema.required) ? schema.required : [];
  const props = schema.properties;
  if (!props || typeof props !== 'object') return { required, properties: [] };
  const requiredSet = new Set(required);
  const properties = Object.keys(props).map((name) => {
    const node = props[name] && typeof props[name] === 'object' ? props[name] : {};
    return {
      name,
      type: describeType(node),
      description: node.description || '',
      required: requiredSet.has(name),
      hasDefault: Object.prototype.hasOwnProperty.call(node, 'default'),
      default: node.default,
      enumText: enumText(node),
    };
  });
  return { required, properties };
}
const ToolRow = ({ tool }) => {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const hasSchema = !!tool.parameters && typeof tool.parameters === 'object';
  const { properties } = hasSchema ? flattenParameters(tool.parameters) : { properties: [] };
  const toggle = () => setOpen((value) => !value);
  const headProps = hasSchema ? {
    className: 'dsh-mcp-tool-head interactive',
    role: 'button',
    tabIndex: 0,
    'aria-expanded': open,
    title: open ? '收起参数' : '查看参数',
    onClick: toggle,
    onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } },
  } : { className: 'dsh-mcp-tool-head' };
  return h('div', { className: 'dsh-mcp-tool' },
    h('div', headProps,
      h('span', { className: 'dsh-mcp-tool-name', title: tool.name }, tool.name),
      h('span', { className: 'dsh-mcp-tool-desc', title: tool.description }, tool.description || ''),
      hasSchema ? h('span', { className: 'dsh-mcp-tool-caret', 'aria-hidden': true }, open ? '▾' : '▸') : null,
    ),
    open && hasSchema ? h('div', { className: 'dsh-mcp-tool-body' },
      properties.length ? h('div', { className: 'dsh-mcp-params' },
        properties.map((p) => h('div', { key: p.name, className: 'dsh-mcp-param' },
          h('div', { className: 'dsh-mcp-param-head' },
            h('code', { className: 'dsh-mcp-param-name' }, p.name),
            p.required ? h('span', { className: 'dsh-mcp-req' }, '必填') : h('span', { className: 'dsh-mcp-opt' }, '可选'),
            h('span', { className: 'dsh-mcp-param-type' }, p.type),
          ),
          p.description ? h('div', { className: 'dsh-mcp-param-desc' }, p.description) : null,
          p.enumText ? h('div', { className: 'dsh-mcp-param-enum' }, '可选值：' + p.enumText) : null,
          p.hasDefault ? h('div', { className: 'dsh-mcp-param-enum' }, '默认值：' + JSON.stringify(p.default)) : null,
        )),
      ) : null,
      h('button', { type: 'button', className: 'dsh-mcp-tool-rawbtn', onClick: () => setRaw((value) => !value) }, raw ? '收起原始 JSON' : '查看原始 JSON'),
      raw ? h('pre', { className: 'dsh-mcp-json' }, JSON.stringify(tool.parameters, null, 2)) : null,
    ) : null,
  );
};

const Btn = ({ cls, icon, onClick, disabled, title, children }) =>
  h('button', { type: 'button', className: 'dsh-mcp-btn' + (cls ? ' ' + cls : ''), onClick, disabled, title }, icon ? h(Icon, { d: ICONS[icon] }) : null, children);

// 服务器列表。embedded=true 时作为项目 tab 的分区内容渲染：去掉自身卡片外框，
// 并在条目较少时隐藏搜索/过滤（否则控件会挤占本就有限的列表高度）。
const CONTROLS_THRESHOLD = 6;
// 项目行的两个事实判定与文案：**放在模块作用域**，因为它是纯函数 —— 抽出来才能被真正测到
// （组件内部的闭包在 node 里跑不起来，只能靠钉源码文本，那种测试证明不了文案对不对）。
//   link  —— 这条连接在不在（"没人用"不等于"没连上"：连接按空闲策略保留）；
//   scope —— 投射范围（几个会话正在用它）。
// 旧文案把两者压成一句「待会话挂载」，读起来像"还没连上/排队中"，而事实是"连接在、只是当前没会话用"。
const mountFailed = (s) => s.mountFailed === true;
// 作用域故障是第三类失败：连接可能完全正常，但工具不在共享作用域层（两个 dsh-scope 模块实例）。
// Host 已在行上标好 scopeFailed 与具体原因，这里只负责不要把它显示成「连接失败」。
const scopeFailed = (s) => s.scopeFailed === true;
const wsSub = (s) => {
  if (mountFailed(s)) return '挂载失败';
  if (scopeFailed(s)) return '作用域隔离失败';
  if (s.status === 'disabled') return '已禁用';
  if (s.status === 'unknown') return '状态未知';
  if (s.status === 'loading') return '连接中…';
  if (s.status === 'failed') return '连接失败';
  if (s.status !== 'connected') return '尚未建立连接（新会话自动挂载）';
  const refs = typeof s.refs === 'number' ? s.refs : 0;
  const tools = typeof s.toolCount === 'number' ? ' · ' + s.toolCount + ' 工具' : '';
  return refs > 0
    ? '已连接 · ' + refs + ' 个会话在用' + tools
    : '已连接 · 当前无会话使用（连接保留，下次直接用）' + tools;
};

const ServerList = ({ servers, total, selected, query, onQuery, onSelect, onToggle, busy, transportFilter, statusFilter, onTransportFilter, onStatusFilter, embedded, workspace, emptyHint }) => {
  const count = total === undefined ? servers.length : total;
  const showControls = !embedded || count > CONTROLS_THRESHOLD;
  // mountFailed / scopeFailed / wsSub 现在在模块作用域（纯函数，可被测试直接调用）。
  // 项目 MCP 的 status 与全局同一个取值域（deriveMcpPhase）：connected / failed / loading /
  // stopped / disabled / unknown。状态点因此直接复用，不再需要为项目行特例。
  const dotPhase = (s) => (mountFailed(s) || scopeFailed(s) ? 'failed' : s.status || s.phase);
  const toggleLocked = (s) => busy || !s.managed || (s.scope !== 'workspace' && !s.enabled && s.phase !== 'stopped');
  return h('div', { className: 'dsh-mcp-side' + (embedded ? ' embedded' : '') },
    showControls ? h('div', { className: 'dsh-mcp-search' }, h(Icon, { d: ICONS.search }), h('input', { placeholder: '搜索 MCP…', value: query, onChange: (e) => onQuery(e.target.value) })) : null,
    showControls ? h('div', { className: 'dsh-mcp-filters' },
      h('select', { value: transportFilter, onChange: (e) => onTransportFilter(e.target.value), 'aria-label': '按传输过滤' },
        h('option', { value: 'all' }, '全部传输'),
        h('option', { value: 'http' }, 'HTTP'),
        h('option', { value: 'stdio' }, 'stdio'),
      ),
      h('select', { value: statusFilter, onChange: (e) => onStatusFilter(e.target.value), 'aria-label': '按状态过滤' },
        h('option', { value: 'all' }, '全部状态'),
        workspace ? null : h('option', { value: 'connected' }, '已连接'),
        workspace ? null : h('option', { value: 'failed' }, '失败'),
        h('option', { value: 'disabled' }, '已禁用'),
      ),
    ) : null,
    h('div', { className: 'dsh-mcp-list' },
      servers.length === 0
        ? h('div', { className: 'dsh-mcp-empty-list' }, count === 0 && emptyHint ? emptyHint : '没有匹配的 MCP')
        : servers.map((s) =>
            h('div', { key: s.serverName, role: 'button', tabIndex: 0, 'aria-selected': selected === s.serverName, className: 'dsh-mcp-item' + (selected === s.serverName ? ' sel' : ''), onClick: () => onSelect(s.serverName), onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(s.serverName); } } },
              h(Dot, { phase: dotPhase(s) }),
              h('div', { className: 'dsh-mcp-item-main' },
                h('div', { className: 'dsh-mcp-item-name' }, s.serverName),
                h('div', { className: 'dsh-mcp-item-sub' },
                  h(Badge, { cls: s.transport === 'http' ? 't-http' : 't-stdio' }, s.transport === 'http' ? 'HTTP' : 'stdio'),
                  h('span', null, s.scope === 'workspace' ? wsSub(s) : s.toolCount + ' 工具'),
                  mountFailed(s) ? h(Badge, { cls: 's-err' }, '挂载失败') : null,
                  scopeFailed(s) ? h(Badge, { cls: 's-err' }, '作用域故障') : null,
                ),
              ),
              h(Toggle, { on: s.enabled, disabled: toggleLocked(s), label: s.serverName + (s.enabled ? '：已启用' : '：已禁用'), title: s.managed ? (s.enabled ? '禁用' : '启用') : '来自其他配置层，只读', onChange: () => onToggle(s) }),
            ),
          ),
    ),
  );
};

// 可见性按钮：与「启用」滑块刻意用不同控件——滑块表示启用状态，眼睛表示在本项目是否可见。
const EyeToggle = ({ hidden, disabled, onChange, label }) =>
  h('button', {
    type: 'button',
    className: 'dsh-mcp-eye' + (hidden ? ' off' : ''),
    disabled,
    'aria-pressed': !hidden,
    'aria-label': (hidden ? '已屏蔽：' : '可见：') + label,
    title: hidden ? '已在此项目屏蔽，点击恢复可见' : '在此项目可见，点击屏蔽',
    onClick: (e) => { e.stopPropagation(); onChange(!hidden); },
  }, h(Icon, { d: ICONS[hidden ? 'eyeOff' : 'eye'], size: 15 }));

// 项目 tab 中的「全局 MCP（可屏蔽）」列表：配置只读，可点选查看详情，可切换本项目可见性。
// 搜索框置于滚动列表之外，避免随列表滚走。
const GlobalServerList = ({ servers, exclude, onToggleExclude, onSelect, selected, busy }) => {
  const [q, setQ] = useState('');
  const hidden = new Set(exclude || []);
  const query = (q || '').toLowerCase();
  const list = query ? servers.filter((s) => s.serverName.toLowerCase().includes(query)) : servers;
  return h(React2.Fragment, null,
    servers.length > CONTROLS_THRESHOLD ? h('div', { className: 'dsh-mcp-global-search' }, h(Icon, { d: ICONS.search }), h('input', { placeholder: '搜索全局 MCP…', value: q, onChange: (e) => setQ(e.target.value) })) : null,
    h('div', { className: 'dsh-mcp-global-list' },
      servers.length === 0
        ? h('div', { className: 'dsh-mcp-empty-list' }, '没有全局 MCP')
        : list.length === 0
          ? h('div', { className: 'dsh-mcp-empty-list' }, '没有匹配的全局 MCP')
          : list.map((s) => {
              const isHidden = hidden.has(s.serverName);
              return h('div', {
                key: s.serverName,
                role: 'button',
                tabIndex: 0,
                'aria-selected': selected === s.serverName,
                className: 'dsh-mcp-item' + (selected === s.serverName ? ' sel' : '') + (isHidden ? ' muted' : ''),
                onClick: () => onSelect(s.serverName),
                onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(s.serverName); } },
              },
                h(Dot, { phase: s.status || s.phase }),
                h('div', { className: 'dsh-mcp-item-main' },
                  h('div', { className: 'dsh-mcp-item-name' }, s.serverName),
                  h('div', { className: 'dsh-mcp-item-sub' },
                    h(Badge, { cls: s.transport === 'http' ? 't-http' : 't-stdio' }, s.transport === 'http' ? 'HTTP' : 'stdio'),
                    h('span', null, s.toolCount + ' 工具'),
                    isHidden ? h(Badge, { cls: 's-off' }, '已屏蔽') : null,
                  ),
                ),
                // 眼睛 = 可见性，与项目 MCP 的启用滑块在语义与外观上都区分开。
                h(EyeToggle, { hidden: isHidden, disabled: busy, label: s.serverName, onChange: (next) => onToggleExclude(s.serverName, next) }),
              );
            }),
    ),
  );
};

const ServerDetail = ({ server, tools, onToggle, onReconnect, onEdit, onRemove, busy, onReveal, revealed, onCopy, excluded, onToggleExclude }) => {
  if (!server)
    return h('div', { className: 'dsh-mcp-detail' }, h('div', { className: 'dsh-mcp-d-empty' }, '选择一个 MCP 查看详情'));
  const env = server.env || {};
  const headers = server.headers || {};
  const envKeys = Object.keys(env);
  const headerKeys = Object.keys(headers);
  const revealId = (field, key) => server.serverName + ':' + field + (key !== undefined ? ':' + key : '');
  const revealedValue = (field, key) => {
    const r = revealed[revealId(field, key)];
    if (!r || r.value === undefined) return undefined;
    return Array.isArray(r.value) ? r.value.join(' ') : String(r.value);
  };
  // 项目 MCP 由会话挂载，管理面板不持有其连接：状态保持中性，除非它确实挂载失败过
  // （workspaceServerView 不产生 lastError，此处的 lastError 只会来自挂载失败）。
  const isWorkspace = server.scope === 'workspace';
  // 项目行的两类失败是两回事，由 Host 分开标记，不再用“lastError 存在”去反推：
  //   mountFailed  = 我们自己 setup 阶段挂不上（serverName 冲突/启动失败）
  //   status=failed = 连接已建但 mcp-client 报错/重连耗尽（工具被注销）
  //   scopeFailed  = 工具注册到了全局层而不是共享作用域层（dsh-scope 两份模块实例）
  const mountFailed = isWorkspace && server.mountFailed === true;
  const scopeFailed = isWorkspace && server.scopeFailed === true;
  // 在项目 tab 里查看的全局 MCP：配置属于全局作用域，此处只读，仅能切换本项目可见性。
  const isForeign = server.foreign === 'global';
  const status = mountFailed ? 'failed' : server.status || server.phase || 'stopped';
  const statusCls = server.enabled ? (status === 'connected' ? 's-on' : status === 'failed' ? 's-err' : '') : 's-off';
  const statusText = !server.enabled
    ? '已禁用'
    : mountFailed
      ? '挂载失败'
      : scopeFailed
        ? '作用域隔离失败'
        : isWorkspace
          // 项目行的 status 与全局同一个取值域（deriveMcpPhase），只是文案不同。
          // 这里只说**连接**那一半事实（"在不在"）；"几个会话在用"由详情页的连接信息与列表行的
          // 副文案给出——两者刻意不合并，见 wsSub 的注释。
          // stopped 在项目语境里意为「这条共享连接尚未建立」（新会话挂载时才建）。
        ? (status === 'connected' ? '已连接' : status === 'failed' ? '连接失败' : status === 'unknown' ? '状态未知' : status === 'loading' ? '连接中…' : '尚未建立连接（新会话自动挂载）')
        : status === 'connected' ? '已连接' : status === 'failed' ? '连接失败' : status === 'unknown' ? '状态未知' : status === 'loading' || status === 'waiting' ? '连接中…' : '已停止';
  const mut = (v) => {
    const visible = displayValue(v);
    return typeof visible === 'string' && visible.length > 90 ? visible.slice(0, 88) + '…' : visible;
  };
  const RevealBtn = ({ field, keyName, label, fallback }) => {
    // 眼睛（以及点开后的复制）只属于**被掩码的值**。明文值（如无凭据的 URL）本来就摆在眼前，
    // 给它配一个只会让人以为还藏了东西，而点下去其实什么也不变。
    const masked = fallback === REDACTED_VALUE;
    const state = revealed[revealId(field, keyName)];
    const shown = revealedValue(field, keyName) !== undefined ? revealedValue(field, keyName) : mut(fallback);
    const revealedNow = state?.value !== undefined;
    return h('span', { className: 'dsh-mcp-secret' },
      h('span', { className: 'dsh-mcp-secret-value', title: shown }, shown),
      revealedNow ? h('button', { type: 'button', className: 'dsh-mcp-secret-btn', title: '复制 ' + label, 'aria-label': '复制 ' + label, onClick: () => onCopy(shown) }, h(Icon, { d: ICONS.copy })) : null,
      masked ? h('button', { type: 'button', className: 'dsh-mcp-secret-btn', disabled: state?.pending, title: revealedNow ? '隐藏 ' + label : '显示 ' + label, 'aria-label': '显示/隐藏 ' + label, onClick: () => onReveal(server, field, keyName) }, state?.pending ? '…' : h(Icon, { d: ICONS[revealedNow ? 'eyeOff' : 'eye'] })) : null,
    );
  };
  const RevealRow = ({ field, keyName, label }) =>
    h('div', { className: 'dsh-mcp-secret-row' },
      h('b', null, keyName),
      h(RevealBtn, { field, keyName, label, fallback: String(env[keyName] ?? headers[keyName] ?? '') }),
    );
  return h('div', { className: 'dsh-mcp-detail' },
    h('div', { className: 'dsh-mcp-d-head' },
      h('div', null,
        h('div', { className: 'dsh-mcp-d-name' }, server.serverName),
        h('div', { className: 'dsh-mcp-d-meta' },
          h(Dot, { phase: status }),
          h(Badge, { cls: statusCls + ' dot' }, statusText),
          h(Badge, { cls: server.transport === 'http' ? 't-http' : 't-stdio' }, server.transport === 'http' ? 'HTTP' : 'stdio'),
          h(Badge, { cls: isWorkspace ? 'scope-ws' : '' }, isWorkspace ? '项目配置' : '全局配置'),
          isWorkspace ? null : h(Badge, null, server.toolCount + ' 个工具'),
          isWorkspace && server.refs > 0 ? h(Badge, null, server.refs + ' 个会话共用') : null,
          isWorkspace && server.duplicateOwners?.length && status === 'failed' ? h(Badge, { cls: 's-err' }, 'serverName 同名冲突') : null,
        ),
      ),
      h('div', { className: 'dsh-mcp-d-actions' },
        isForeign
          ? h(React2.Fragment, null,
              h('span', { className: 'dsh-mcp-d-scope-hint' }, excluded ? '已在此项目屏蔽' : '在此项目可见'),
              h(EyeToggle, { hidden: excluded, disabled: busy, label: server.serverName, onChange: (next) => onToggleExclude(server.serverName, next) }),
            )
          : h(React2.Fragment, null,
              h(Toggle, { on: server.enabled, disabled: busy || !server.managed, label: server.serverName + (server.enabled ? '：已启用' : '：已禁用'), onChange: () => onToggle(server), title: server.managed ? (server.enabled ? '禁用' : '启用') : '来自其他配置层，只读' }),
              h(Btn, { icon: 'edit', onClick: () => onEdit(server), disabled: busy || !server.managed, children: '编辑' }),
              h(Btn, { icon: 'refresh', onClick: () => onReconnect(server), disabled: busy || !server.enabled || !server.managed, title: isWorkspace ? '重连本项目共享连接（拆掉旧连接并按当前配置重建，不影响其他会话）' : '重连', children: '重连' }),
              h(Btn, { cls: 'danger', icon: 'trash', onClick: () => onRemove(server), disabled: busy || !server.managed, children: '移除' }),
            ),
      ),
    ),
    isForeign ? h('div', { className: 'dsh-mcp-log warn' }, '此 MCP 由全局配置提供。要改它的连接配置，请切到「全局」标签页；在这里只能决定它对本项目是否可见。') : null,
    // 同名在 DSH 0.1.5 起是合法配置（官方按注册作用域隔离），所以只有这份连接真的失败时才
    // 把它摆成原因；成功时不刷屏，更不把一条好连接说成冲突。
    isWorkspace && server.duplicateOwners?.length && status === 'failed' ? h('div', { className: 'dsh-mcp-log warn' }, '以下项目也定义了同名 serverName：' + server.duplicateOwners.join('、') + '。DSH 0.1.5 起各注册作用域可独立使用同名；更早的版本按全进程唯一判定，同名会导致其中一份启动失败。') : null,
    server.lastError ? h('div', { className: 'dsh-mcp-log', title: '来自 mcp-client 最近日志' }, server.lastError) : null,
    server.toolCountAmbiguous ? h('div', { className: 'dsh-mcp-log warn' }, '工具命名与其他 serverName 前缀重叠，无法可靠判断归属；请避免在 serverName 中使用双下划线。') : null,
    h('div', { className: 'dsh-mcp-card' },
      h('h4', null, '连接信息'),
      h('div', { className: 'dsh-mcp-kv' },
        h('b', null, '传输'), h('span', null, server.transport === 'http' ? 'Streamable HTTP' : 'stdio'),
        server.url ? h('b', null, 'URL') : null, server.url ? h(RevealBtn, { field: 'url', label: 'URL', fallback: server.url }) : null,
        server.command ? h('b', null, '命令') : null, server.command ? h('span', null, mut(server.command)) : null,
        server.args && server.args.length ? h('b', null, '参数') : null, server.args && server.args.length ? h(RevealBtn, { field: 'args', label: '参数', fallback: server.args.map(mut).join(' ') }) : null,
        server.cwd ? h('b', null, '工作目录') : null, server.cwd ? h('span', null, mut(server.cwd)) : null,
        h('b', null, '启用'), h('span', null, server.enabled ? '是' : '否（补丁中 disabled: true）'),
        h('b', null, '配置来源'), h('span', null, server.conflict ? '存在重复 serverName（冲突，只读）' : isForeign ? '全局配置（在「全局」标签页可编辑）' : isWorkspace ? '项目配置 .dsh/mcp.json（可编辑，本项目会话共享一份连接）' : server.managed ? '当前 Web profile（可编辑）' : '其他 bundle / Agent（只读）'),
        server.toolCallTimeoutMs ? h('b', null, '调用超时') : null, server.toolCallTimeoutMs ? h('span', null, server.toolCallTimeoutMs + ' ms') : null,
        h('b', null, '启动失败策略'), h('span', null, server.failOnStartupError ? '阻止插件启动' : '记录错误并继续'),
        server.reconnect ? h('b', null, '自动重连') : null, server.reconnect ? h('span', null, server.reconnect.enabled === false ? '关闭' : `${server.reconnect.initialDelayMs || 500}–${server.reconnect.maxDelayMs || 30000} ms，最多 ${server.reconnect.maxAttempts || 10} 次`) : null,
        headerKeys.length ? h('b', null, 'Headers') : null, headerKeys.length ? h('div', { className: 'dsh-mcp-secret-list' }, headerKeys.map((k) => h(RevealRow, { key: k, field: 'headers', keyName: k, label: 'Header ' + k }))) : null,
        envKeys.length ? h('b', null, '环境变量') : null, envKeys.length ? h('div', { className: 'dsh-mcp-secret-list' }, envKeys.map((k) => h(RevealRow, { key: k, field: 'env', keyName: k, label: '环境变量 ' + k }))) : null,
      ),
    ),
    h('div', { className: 'dsh-mcp-card' },
      h('h4', null, '工具（' + tools.length + '）'),
      h('div', { className: 'dsh-mcp-tools' },
        tools.length === 0
          ? h('div', { className: 'dsh-mcp-empty-list' }, server.toolCountAmbiguous ? '工具归属存在命名歧义' : server.scope === 'workspace' ? '尚无会话持有该项目连接，或连接尚未就绪' : '暂无工具')
          : tools.map((t) => h(ToolRow, { key: t.name, tool: t })),
      ),
    ),
  );
};

const AddEditModal = ({ open, onClose, onSubmit, busy, initial, onRevealValue, revealEpoch, scopeName }) => {
  const dialogRef = useRef(null);
  const [name, setName] = useState('');
  const [transport, setTransport] = useState('http');
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [cwd, setCwd] = useState('');
  const [toolCallTimeoutMs, setToolCallTimeoutMs] = useState('60000');
  const [failOnStartupError, setFailOnStartupError] = useState(false);
  const [reconnectEnabled, setReconnectEnabled] = useState(true);
  const [initialDelayMs, setInitialDelayMs] = useState('500');
  const [maxDelayMs, setMaxDelayMs] = useState('30000');
  const [maxAttempts, setMaxAttempts] = useState('10');
  const [headers, setHeaders] = useState([{ k: '', v: '' }]);
  const [envs, setEnvs] = useState([{ k: '', v: '' }]);
  const [error, setError] = useState('');
  const [revealBusy, setRevealBusy] = useState('');
  const [editRevealed, setEditRevealed] = useState({});
  const editRevealGeneration = useRef(0);
  const editing = !!initial;
  const applyPreset = (id) => {
    const preset = MCP_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setName(preset.serverName);
    setTransport(preset.transport);
    setUrl('');
    setCommand(preset.command || '');
    setArgs((preset.args || []).join('\n'));
    setCwd('');
    setHeaders([{ k: '', v: '' }]);
    setEnvs([{ k: '', v: '' }]);
    setError('');
  };
  useEffect(() => {
    clearRevealState(editRevealGeneration, setEditRevealed, setRevealBusy);
  }, [revealEpoch]);
  useEffect(() => {
    editRevealGeneration.current += 1;
    if (!open) return;
    if (initial) {
      setName(initial.serverName);
      setTransport(initial.transport === 'http' ? 'http' : 'stdio');
      setUrl(toFormValue(initial.url || ''));
      setCommand(initial.command || '');
      setArgs(Array.isArray(initial.args) ? initial.args.map(toFormValue).join('\n') : '');
      setCwd(initial.cwd || '');
      setToolCallTimeoutMs(String(initial.toolCallTimeoutMs || 60000));
      setFailOnStartupError(initial.failOnStartupError === true);
      setReconnectEnabled(initial.reconnect?.enabled !== false);
      setInitialDelayMs(String(initial.reconnect?.initialDelayMs || 500));
      setMaxDelayMs(String(initial.reconnect?.maxDelayMs || 30000));
      setMaxAttempts(String(initial.reconnect?.maxAttempts || 10));
      const hd = Object.keys(initial.headers || {}).map((k) => ({ k, originalKey: k, v: toFormValue(initial.headers[k]) }));
      setHeaders(hd.length ? hd : [{ k: '', v: '' }]);
      const ev = Object.keys(initial.env || {}).map((k) => ({ k, originalKey: k, v: toFormValue(initial.env[k]) }));
      setEnvs(ev.length ? ev : [{ k: '', v: '' }]);
    } else {
      setName(''); setTransport('http'); setUrl(''); setCommand(''); setArgs(''); setCwd('');
      setToolCallTimeoutMs('60000'); setFailOnStartupError(false); setReconnectEnabled(true);
      setInitialDelayMs('500'); setMaxDelayMs('30000'); setMaxAttempts('10');
      setHeaders([{ k: '', v: '' }]); setEnvs([{ k: '', v: '' }]);
    }
    setError('');
    setRevealBusy('');
    setEditRevealed({});
  }, [open, initial]);
  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);
  if (!open) return null;
  const kv = (rows, setRows, i, field, v) => {
    const next = rows.slice();
    const row = { ...next[i], [field]: v };
    if (field === 'k' && row.v === PRESERVED_VALUE_LABEL && v !== row.originalKey) row.v = '';
    next[i] = row;
    setRows(next);
  };
  const addRow = (rows, setRows) => setRows([...rows, { k: '', v: '' }]);
  const delRow = (rows, setRows, i) => setRows(rows.filter((_, x) => x !== i));
  const editRevealId = (field, key) => (initial?.serverName || 'new') + ':' + field + (key !== undefined ? ':' + key : '');
  const formatRevealedValue = (value) => Array.isArray(value)
    ? value.join('\n')
    : value && typeof value === 'object'
      ? Object.entries(value).map(([key, item]) => `${key}=${typeof item === 'object' ? JSON.stringify(item) : String(item)}`).join('\n')
      : String(value ?? '');
  const visibleEditValue = (field, key, fallback) => Object.hasOwn(editRevealed, editRevealId(field, key)) ? editRevealed[editRevealId(field, key)] : fallback;
  const hideEditReveal = (field, key) => setEditRevealed((prev) => {
    const next = { ...prev };
    delete next[editRevealId(field, key)];
    return next;
  });
  const toggleEditReveal = async (field, key) => {
    if (!editing || !initial) return;
    const id = editRevealId(field, key);
    if (Object.hasOwn(editRevealed, id)) { hideEditReveal(field, key); return; }
    const generation = editRevealGeneration.current;
    setRevealBusy(id); setError('');
    try {
      const value = await onRevealValue(initial, field, key);
      if (generation !== editRevealGeneration.current) return;
      setEditRevealed((prev) => ({ ...prev, [id]: formatRevealedValue(value) }));
    } catch (e) {
      if (generation !== editRevealGeneration.current) return;
      setError(String(e?.message || e));
    } finally {
      if (generation === editRevealGeneration.current) setRevealBusy('');
    }
  };
  const submit = () => {
    const n = (name || '').trim();
    if (!n) return setError('请填写 MCP 名称');
    const spec = { name: n, transport };
    if (transport === 'http') {
      spec.url = fromFormValue(url.trim());
      const hd = {};
      headers.forEach((r) => { if (r.k.trim()) setOwn(hd, r.k.trim(), fromFormValue(r.v)); });
      if (Object.keys(hd).length) spec.headers = hd;
    } else {
      spec.command = command.trim();
      const parts = args.split(/\r?\n/).map((s) => fromFormValue(s.trim())).filter(Boolean);
      if (parts.length) spec.args = parts;
      if (cwd.trim()) spec.cwd = cwd.trim();
      const ev = {};
      envs.forEach((r) => { if (r.k.trim()) setOwn(ev, r.k.trim(), fromFormValue(r.v)); });
      if (Object.keys(ev).length) spec.env = ev;
    }
    const timeout = Number(toolCallTimeoutMs);
    const initialDelay = Number(initialDelayMs);
    const maxDelay = Number(maxDelayMs);
    const attempts = Number(maxAttempts);
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || !Number.isSafeInteger(attempts) || attempts <= 0) return setError('工具超时和最大尝试次数必须是正整数');
    if (!Number.isFinite(initialDelay) || initialDelay <= 0 || initialDelay > MAX_TIMER_DELAY_MS || !Number.isFinite(maxDelay) || maxDelay <= 0 || maxDelay > MAX_TIMER_DELAY_MS) return setError('重连延迟必须是有效正数且不超过 2147483647 ms');
    if (initialDelay > maxDelay) return setError('首次延迟不能大于最大延迟');
    spec.toolCallTimeoutMs = timeout;
    spec.failOnStartupError = failOnStartupError;
    spec.reconnect = { enabled: reconnectEnabled, initialDelayMs: initialDelay, maxDelayMs: maxDelay, maxAttempts: attempts };
    // 表单只拥有它显式渲染的字段，而提交是**重建** spec 而不是增量修改 —— 所以其余字段必须原样
    // 带回去，否则"编辑一次"就把它们抹掉：`disabled`（会让一个被禁用的 server 被悄悄启用）以及
    // 项目级的两个预算旋钮（表单不渲染它们，但配置文件里可能有）。
    if (initial) {
      if (initial.enabled === false) spec.disabled = true;
      for (const key of ['idleTimeoutMs', 'readyTimeoutMs']) if (initial[key] !== undefined) spec[key] = initial[key];
    }
    onSubmit(spec, setError);
  };
  const kvRows = transport === 'http' ? headers : envs;
  const setKvRows = transport === 'http' ? setHeaders : setEnvs;
  const revealIcon = (id, label, onClick) => {
    const shown = Object.hasOwn(editRevealed, id);
    return h('button', { type: 'button', className: 'dsh-mcp-btn dsh-mcp-inline-icon', disabled: revealBusy === id, title: (shown ? '隐藏原值：' : '显示原值：') + label, 'aria-label': (shown ? '隐藏原值：' : '显示原值：') + label, onClick }, revealBusy === id ? '…' : h(Icon, { d: ICONS[shown ? 'eyeOff' : 'eye'] }));
  };
  return h('div', { className: 'dsh-mcp-overlay', onClick: (e) => e.target === e.currentTarget && onClose() },
    h('div', { ref: dialogRef, className: 'dsh-mcp-modal', role: 'dialog', 'aria-modal': true, 'aria-label': editing ? '编辑 MCP' : '添加 MCP', tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } } },
      h('h3', null, (editing ? '编辑 MCP' : '添加 MCP') + (scopeName && scopeName !== '全局' ? '（' + scopeName + '）' : '')),
      !editing ? h('div', { className: 'dsh-mcp-field' },
        h('label', null, '从预设模板快速填充（可选，命令需本机 npx/uvx）'),
        h('select', { value: '', onChange: (e) => applyPreset(e.target.value), 'aria-label': '选择预设模板' },
          h('option', { value: '' }, '— 选择预设 —'),
          MCP_PRESETS.map((p) => h('option', { key: p.id, value: p.id }, p.label)),
        ),
      ) : null,
      h('div', { className: 'dsh-mcp-field' },
        h('label', null, 'MCP 名称（唯一标识，不可改）'),
        h('input', { value: name, disabled: editing, onChange: (e) => setName(e.target.value), placeholder: 'my-server' }),
      ),
      h('div', { className: 'dsh-mcp-field' },
        h('label', null, '传输类型'),
        h('div', { className: 'dsh-mcp-radio-row' },
          h('label', { className: transport === 'http' ? 'sel' : '' }, h('input', { type: 'radio', checked: transport === 'http', onChange: () => setTransport('http') }), 'HTTP（远程）'),
          h('label', { className: transport === 'stdio' ? 'sel' : '' }, h('input', { type: 'radio', checked: transport === 'stdio', onChange: () => setTransport('stdio') }), 'stdio（本地进程）'),
        ),
      ),
      transport === 'http'
        ? h('div', { className: 'dsh-mcp-field' },
            h('label', null, 'URL'),
            h('div', { className: 'dsh-mcp-input-action' },
              h('input', { value: visibleEditValue('url', undefined, url), onChange: (e) => { hideEditReveal('url'); setUrl(e.target.value); }, placeholder: 'https://example.com/mcp' }),
              editing && url === PRESERVED_VALUE_LABEL ? revealIcon('url', 'URL', () => toggleEditReveal('url')) : null,
            ),
          )
        : h('div', null,
            h('div', { className: 'dsh-mcp-field' }, h('label', null, '命令'), h('input', { value: command, onChange: (e) => setCommand(e.target.value), placeholder: 'npx 或 C:\\path\\to\\bin.exe' })),
            h('div', { className: 'dsh-mcp-field' },
              h('label', null, '参数（每行一个，原样传给进程）'),
              h('div', { className: 'dsh-mcp-input-action' },
                h('textarea', { rows: 4, value: visibleEditValue('args', undefined, args), onChange: (e) => { hideEditReveal('args'); setArgs(e.target.value); }, placeholder: '-y\nmcp-server@latest' }),
                editing && args === PRESERVED_VALUE_LABEL ? revealIcon('args', '参数', () => toggleEditReveal('args')) : null,
              ),
            ),
            h('div', { className: 'dsh-mcp-field' }, h('label', null, '工作目录 cwd（可选）'), h('input', { value: cwd, onChange: (e) => setCwd(e.target.value), placeholder: 'C:\\path\\to\\workspace' })),
          ),
      h('div', { className: 'dsh-mcp-field' },
        h('label', null, transport === 'http' ? 'Headers（可选）' : '环境变量（可选，值写 !!js process.env.KEY 引用密钥）'),
        kvRows.map((row, i) => {
          const field = transport === 'http' ? 'headers' : 'env';
          const originalKey = row.originalKey || row.k;
          const id = editRevealId(field, originalKey);
          return h('div', { key: i, className: 'dsh-mcp-kv-edit' },
            h('input', { placeholder: transport === 'http' ? 'Authorization' : 'API_KEY', value: row.k, onChange: (e) => { hideEditReveal(field, originalKey); kv(kvRows, setKvRows, i, 'k', e.target.value); } }),
            h('input', { placeholder: transport === 'http' ? 'Bearer … 或 !!js process.env.KEY' : 'value', value: visibleEditValue(field, originalKey, row.v), onChange: (e) => { hideEditReveal(field, originalKey); kv(kvRows, setKvRows, i, 'v', e.target.value); } }),
            h('div', { className: 'dsh-mcp-kv-row-actions' },
              editing && row.v === PRESERVED_VALUE_LABEL ? revealIcon(id, row.k, () => toggleEditReveal(field, originalKey)) : null,
              h('button', { type: 'button', className: 'dsh-mcp-kv-del', onClick: () => delRow(kvRows, setKvRows, i), title: '删除此项', 'aria-label': '删除 ' + (row.k || '配置项') }, '✕'),
            ),
          );
        }),
        h('div', { className: 'dsh-mcp-kv-add' }, h(Btn, { onClick: () => addRow(kvRows, setKvRows), children: '+ 添加' })),
      ),
      h('div', { className: 'dsh-mcp-card dsh-mcp-advanced' },
        h('h4', null, '运行策略'),
        h('div', { className: 'dsh-mcp-field' }, h('label', null, '工具调用超时（毫秒）'), h('input', { type: 'number', min: 1, value: toolCallTimeoutMs, onChange: (e) => setToolCallTimeoutMs(e.target.value) })),
        h('label', { className: 'dsh-mcp-check' }, h('input', { type: 'checkbox', checked: failOnStartupError, onChange: (e) => setFailOnStartupError(e.target.checked) }), '首次连接失败时阻止插件启动'),
        h('label', { className: 'dsh-mcp-check' }, h('input', { type: 'checkbox', checked: reconnectEnabled, onChange: (e) => setReconnectEnabled(e.target.checked) }), '断开后自动重连'),
        h('div', { className: 'dsh-mcp-number-grid' },
          h('div', { className: 'dsh-mcp-field' }, h('label', null, '首次延迟 ms'), h('input', { type: 'number', min: 1, step: 'any', value: initialDelayMs, onChange: (e) => setInitialDelayMs(e.target.value) })),
          h('div', { className: 'dsh-mcp-field' }, h('label', null, '最大延迟 ms'), h('input', { type: 'number', min: 1, step: 'any', value: maxDelayMs, onChange: (e) => setMaxDelayMs(e.target.value) })),
          h('div', { className: 'dsh-mcp-field' }, h('label', null, '最大尝试次数'), h('input', { type: 'number', min: 1, value: maxAttempts, onChange: (e) => setMaxAttempts(e.target.value) })),
        ),
      ),
      error ? h('div', { className: 'dsh-mcp-d-err' }, error) : null,
      h('div', { className: 'dsh-mcp-modal-actions' },
        h(Btn, { onClick: onClose, children: '取消' }),
        h(Btn, { cls: 'primary', onClick: submit, disabled: busy, children: busy ? '保存中…' : (editing ? '保存' : '添加') }),
      ),
    ),
  );
};

function builtinConfigurationText(item) {
  const config = item?.configuration || {};
  if (config.url) {
    const headers = Object.entries(config.headers || {}).map(([key, value]) => `${key}: ${value}`);
    return [config.url, ...headers].join(' · ');
  }
  return [config.command, ...(config.args || [])].filter(Boolean).join(' ');
}

// 「MCP 市场」：目录的浏览与安装入口。
//
// 与旧的「内置 MCP」对话框的区别是它成了**主要入口**：搜索框是主操作，分类 chips 让用户
// 按用途找而不是按名字找，卡片直接可装，不再需要先勾选再确认。多选保留着——批量装同一类
// （比如把搜索类一次装齐）仍然比一个个点快。
//
// 数据来自 Host 的 builtins RPC，**分类标签也在那里**：这个文件是预构建 bundle，不 import
// Host 模块，所以 lib/mcp-catalog.js 的常量在这里读不到——Host 已把 categoryLabel 带在每条
// 目上。分类的**顺序**取目录里的首次出现序，而生成器已按 CATEGORY_ORDER 重排了目录，所以这里
// 取到的就是产品定的顺序；客户端不再维护一份顺序表：否则加一个分类要记得改两个文件。
const MarketPanel = ({ call, timer }) => {
  // 自持作用域的整页市场：全局装入，或装入某个项目（写该项目的 .dsh/mcp.json）。
  // 项目清单来自 listWorkspaces；每条目录项的「已配置」状态在 loadCatalog 里按所选
  // 项目的 getWorkspaceView 现查——市场是独立分类页，不再依赖 MCP 页传进来的列表。
  const [scope, setScope] = useState('global');
  const [workspaces, setWorkspaces] = useState([]);
  const isWorkspace = scope !== 'global';
  const loadGeneration = useRef(0);
  const knownNamesRef = useRef([]);
  const [catalog, setCatalog] = useState([]);
  const [selected, setSelected] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [sort, setSort] = useState('default');
  const [onlyKeyless, setOnlyKeyless] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState('');
  const noteCancel = useRef(null);
  const flash = (text, kind) => {
    setNote(kind === 'err' ? '' : text);
    setNoteError(kind === 'err' ? text : '');
    if (noteCancel.current) noteCancel.current();
    noteCancel.current = timer.timeout(() => { setNote(''); setNoteError(''); }, 4000);
  };
  useEffect(() => () => { if (noteCancel.current) noteCancel.current(); }, []);
  const loadCatalog = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true); setError('');
    try {
      // 项目作用域：先取该项目已配置的 serverName（host 目录基于全局 effective），
      // 再按它判定每条目录项的「已配置」状态。
      let known = [];
      if (isWorkspace) {
        const view = await call('getWorkspaceView', { wsPath: scope });
        if (!view?.ok) throw new Error(view?.error || '读取项目配置失败');
        if (generation !== loadGeneration.current) return;
        known = view.servers || [];
      }
      const res = await call('builtins');
      if (!res?.ok) throw new Error(res?.error || '读取 MCP 目录失败');
      if (generation !== loadGeneration.current) return;
      const list = (res.builtins || []).map((item) => {
        if (!isWorkspace) return item;
        const configured = known.some((s) => s.serverName === item.name);
        return configured ? { ...item, installed: true, installedAs: [item.name] } : item;
      });
      knownNamesRef.current = known;
      setCatalog(list);
    } catch (e) {
      if (generation === loadGeneration.current) setError(String(e?.message || e));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [call, isWorkspace, scope]);
  useEffect(() => { loadCatalog(); }, [loadCatalog]);
  useEffect(() => {
    let alive = true;
    call('listWorkspaces').then((res) => { if (alive && res?.ok) setWorkspaces(res.workspaces || []); }).catch(() => {});
    return () => { alive = false; };
  }, [call]);
  // 换作用域：选择与筛选归零（目录数据由 loadCatalog 按 isWorkspace/scope 变化自动重取）。
  useEffect(() => {
    setSelected([]); setQuery(''); setCategory('all'); setSort('default'); setOnlyKeyless(false);
  }, [scope]);
  const scopeTabs = useMemo(
    () => [{ key: 'global', label: '全局' }, ...workspaces.map((w) => ({ key: w.path, label: w.name }))],
    [workspaces],
  );

  // 分类按目录里的首次出现顺序排列；标签取条目自带的 categoryLabel。
  const categoryCounts = new Map();
  for (const item of catalog) {
    const key = item.category || 'other';
    const entry = categoryCounts.get(key) || { label: item.categoryLabel || key, count: 0 };
    entry.count += 1;
    categoryCounts.set(key, entry);
  }
  const categories = [...categoryCounts.keys()];

  // 「需不需要密钥」是用户最先要判断的事之一：免密的可以立刻装来试，要 Key 的得先申请。
  const needsKey = (item) => Array.isArray(item.envKeys) && item.envKeys.length > 0;
  // 连接参数（Redis 的 HOST/PORT、ClickHouse 的 HOST/USER）不是密钥，但同样要用户先准备，
  // 所以「只要免密钥」这个筛选项把它们也排除掉——否则 Redis 会被当成装上就能用。
  const needsConfig = (item) => Array.isArray(item.configKeys) && item.configKeys.length > 0;
  // 参数里含 <占位符>：装完要去编辑里替换，否则拿占位符当真实路径启动。
  const needsArgs = (item) => Array.isArray(item.placeholders) && item.placeholders.length > 0;
  const readyToRun = (item) => !needsKey(item) && !needsConfig(item) && !needsArgs(item);

  const filtered = catalog.filter((item) => {
    if (category !== 'all' && (item.category || 'other') !== category) return false;
    if (onlyKeyless && !readyToRun(item)) return false;
    if (!query.trim()) return true;
    const haystack = [item.label, item.id, item.name, item.summary, item.vendor, item.access]
      .filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });
  const visible = sort === 'installed'
    ? [...filtered].sort((a, b) => Number(a.installed || false) - Number(b.installed || false))
    : sort === 'name'
      ? [...filtered].sort((a, b) => String(a.label).localeCompare(String(b.label), 'zh-Hans-CN'))
      : filtered;

  const availableIds = filtered.filter((item) => !item.installed).map((item) => item.id);
  const allSelected = availableIds.length > 0 && availableIds.every((id) => selected.includes(id));
  const toggleSelected = (id, checked) => setSelected((current) => checked
    ? (current.includes(id) ? current : [...current, id])
    : current.filter((value) => value !== id));
  const remove = async (item, ev) => {
    ev?.stopPropagation();
    setBusy(true); setError('');
    try {
      // Host 的移除是单数 RPC、按 serverName 定位。一条目录项可能以多个名字装过（用户改过名），
      // 所以逐个移除；任一失败都如实报出来——静默跳过会让「移除」看着成功、实际留下半条配置。
      const names = item.installedAs && item.installedAs.length ? item.installedAs : [item.name];
      for (const name of names) {
        const res = isWorkspace
          ? await call('removeWorkspaceServer', { wsPath: scope, name })
          : await call('removeServer', { name });
        if (!res?.ok) throw new Error(res?.error || ('移除失败：' + name));
      }
      onInstalled({ note: '已移除 ' + names.join('、') });
      await loadCatalog();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };
  const install = async (ids) => {
    const target = ids || selected;
    if (!target.length) return;
    setBusy(true); setError('');
    try {
      const res = isWorkspace
        ? await call('installWorkspaceBuiltins', { wsPath: scope, ids: target })
        : await call('installBuiltins', { ids: target });
      if (!res?.ok) throw new Error(res?.error || '安装 MCP 失败');
      onInstalled(res);
      setSelected([]);
      await loadCatalog();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  const installedCount = catalog.filter((item) => item.installed).length;
  const cardOf = (item) => {
    const http = item.transport === 'streamable-http';
    const selectedHere = selected.includes(item.id);
    return h('div', {
      key: item.id,
      className: 'dsh-mcp-card' + (item.installed ? ' installed' : ''),
    },
      h('div', { className: 'dsh-mcp-card-top' },
        h('div', null,
          h('div', { className: 'dsh-mcp-card-name' }, item.label),
          item.vendor ? h('div', { className: 'dsh-mcp-card-vendor' }, item.vendor) : null,
        ),
        !item.installed
          ? h('input', {
            type: 'checkbox',
            className: 'dsh-mcp-builtin-select',
            checked: selectedHere,
            disabled: busy,
            onChange: (e) => toggleSelected(item.id, e.target.checked),
            'aria-label': '选择 ' + item.label,
          })
          : null,
      ),
      h('div', { className: 'dsh-mcp-card-summary' }, item.summary),
      h('div', { className: 'dsh-mcp-card-tags' },
        h(Badge, { cls: http ? 't-http' : 't-stdio' }, http ? 'HTTP' : 'stdio'),
        item.categoryLabel ? h(Badge, null, item.categoryLabel) : null,
        item.installed
          ? h(Badge, { cls: 's-on' }, '已配置')
          : (needsKey(item)
            ? h(Badge, null, '需密钥')
            : needsConfig(item)
              // 连接参数与密钥分开说：Redis / ClickHouse 是本机服务，标成「需密钥」会让人
              // 以为要去申请账号。
              ? h(Badge, null, '需连接信息')
              : h(Badge, { cls: 's-off' }, '免密钥')),
        // 含 <占位符> 的条目（如 filesystem 的「允许访问的目录」）装完**不能直接用**：
        // 拿占位符当真实参数启动一定失败。这里如实标出来，别让用户以为装完就好了。
        needsArgs(item) ? h(Badge, { cls: 's-err' }, '需填参数') : null,
      ),
      h('div', { className: 'dsh-mcp-card-access' }, item.access),
      needsArgs(item)
        ? h('div', { className: 'dsh-mcp-card-note' }, '安装后需编辑，替换 ' + item.placeholders.join('、'))
        : null,
      // 把要填的变量名直接写出来。只说「需密钥」等于没说——用户知道要申请，却不知道
      // 填进哪个名字（ClickHouse 要 4 个变量，Redis 要 HOST/PORT）。
      needsKey(item) || needsConfig(item)
        ? h('div', { className: 'dsh-mcp-card-vars' },
            needsKey(item) ? h('span', null, '密钥：' + item.envKeys.join('、')) : null,
            needsConfig(item) ? h('span', null, '连接：' + item.configKeys.join('、')) : null,
          )
        : null,
      h('div', { className: 'dsh-mcp-card-actions' },
        item.installed
          ? h(Btn, { cls: 'danger', disabled: busy, onClick: (e) => remove(item, e), children: '移除' })
          : h(Btn, { cls: 'primary', disabled: busy, onClick: () => install([item.id]), children: '安装' }),
        item.homepage
          ? h('a', {
            className: 'dsh-mcp-btn',
            href: item.homepage,
            target: '_blank',
            rel: 'noreferrer',
            title: '打开官方文档',
            children: '文档',
          })
          : null,
      ),
    );
  };

  return h('div', { className: 'dsh-mcp-overlay', onClick: (e) => !busy && e.target === e.currentTarget && onClose() },
    h('div', { ref: dialogRef, className: 'dsh-mcp-modal dsh-mcp-market', role: 'dialog', 'aria-modal': true, 'aria-label': 'MCP 市场', tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose(); } } },
      h('div', { className: 'dsh-mcp-market-head' },
        h('h3', null, 'MCP 市场' + (isWorkspace ? '（装入本项目）' : '')),
        h('span', { className: 'dsh-mcp-market-stat' }, loading
          ? '正在读取目录…'
          : catalog.length + ' 个服务 · 已配置 ' + installedCount + ' 个'),
      ),
      h('div', { className: 'dsh-mcp-market-search' },
        h(Icon, { d: ICONS.search }),
        h('input', {
          type: 'search',
          placeholder: '搜索服务、用途或提供方…',
          value: query,
          'aria-label': '搜索 MCP 服务',
          onChange: (e) => setQuery(e.target.value),
        }),
      ),
      h('div', { className: 'dsh-mcp-market-chips', role: 'tablist', 'aria-label': '按分类浏览' },
        h('button', {
          type: 'button', role: 'tab', 'aria-selected': category === 'all',
          className: 'dsh-mcp-chip' + (category === 'all' ? ' sel' : ''),
          onClick: () => setCategory('all'),
        }, '全部', h('span', { className: 'dsh-mcp-chip-count' }, catalog.length)),
        categories.map((key) => h('button', {
          key, type: 'button', role: 'tab', 'aria-selected': category === key,
          className: 'dsh-mcp-chip' + (category === key ? ' sel' : ''),
          onClick: () => setCategory(key),
        }, categoryCounts.get(key).label, h('span', { className: 'dsh-mcp-chip-count' }, categoryCounts.get(key).count))),
      ),
      h('div', { className: 'dsh-mcp-market-filters' },
        h('label', null, '排序',
          h('select', { value: sort, onChange: (e) => setSort(e.target.value), 'aria-label': '排序方式' },
            h('option', { value: 'default' }, '默认'),
            h('option', { value: 'installed' }, '未配置优先'),
            h('option', { value: 'name' }, '名称'),
          ),
        ),
        h('label', null,
          h('input', { type: 'checkbox', checked: onlyKeyless, onChange: (e) => setOnlyKeyless(e.target.checked) }),
          '只要免密钥',
        ),
        h('span', null, '显示 ' + visible.length + ' / ' + catalog.length),
        availableIds.length
          ? h('label', { className: 'dsh-mcp-market-selectall' },
              h('input', {
                type: 'checkbox',
                checked: allSelected,
                disabled: busy,
                onChange: (e) => setSelected(e.target.checked ? availableIds : []),
              }),
              '全选当前 ' + availableIds.length + ' 个',
            )
          : null,
      ),
      h('div', { className: 'dsh-mcp-market-grid' },
        error ? h('div', { className: 'dsh-mcp-market-empty' }, error) : null,
        !error && !loading && !visible.length
          ? h('div', { className: 'dsh-mcp-market-empty' }, catalog.length ? '没有匹配的服务，换个关键词或分类试试' : '目录是空的')
          : null,
        visible.map(cardOf),
      ),
      h('div', { className: 'dsh-mcp-modal-actions' },
        error && !catalog.length ? h(Btn, { onClick: loadCatalog, disabled: loading || busy, children: loading ? '重试中…' : '重试' }) : null,
        h(Btn, { onClick: onClose, disabled: busy, children: '关闭' }),
        h(Btn, {
          cls: 'primary',
          onClick: () => install(),
          disabled: busy || loading || !selected.length,
          children: busy ? '安装中…' : '安装选中（' + selected.length + '）',
        }),
      ),
    ),
  );
};

const sourceImportNames = (row) => (row.entries || []).filter((entry) => !entry.error).map((entry) => entry.name);
// 只在界面上提示「这条来源带了会被掩码的字段」。具体值一律留在 Host：Host 只给字段名。
const sourceMaskedFields = (row) => [...new Set((row.entries || []).flatMap((entry) => entry.maskedFields || []))];
// 环境变量名不算秘密（值才是），但缺值会让导入后的那个位置变成空字符串，得先说。
const sourceMissingEnv = (row) => [...new Set((row.entries || []).flatMap((entry) => entry.missingEnv || []))];

const JsonImportModal = ({ open, onClose, call, busy, setBusy, onImported, scope, scopeName }) => {
  const isWorkspace = scope !== 'global' && scope !== undefined;
  const dialogRef = useRef(null);
  const [text, setText] = useState('');
  const [mode, setMode] = useState('merge');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [sources, setSources] = useState([]);
  const [sourcesLoading, setSourcesLoading] = useState(false);
  const [sourcesError, setSourcesError] = useState('');
  const [source, setSource] = useState(null);
  const [sourcePreview, setSourcePreview] = useState(null);
  const clearSource = () => { setSource(null); setSourcePreview(null); };
  // 项目标签同时决定「扫哪些项目级来源」与「写到哪个项目」，与粘贴路径的分工一致。
  // 注意：这个对象每次渲染都是新的，**不能**进 useCallback 的依赖——那会让 loadSources
  // 每渲染换一次身份、扫描无限重跑。loadSources 里按 isWorkspace/scope 原值重建一份。
  const scopePayload = isWorkspace ? { wsPath: scope } : {};
  const loadSources = useCallback(async () => {
    setSourcesLoading(true); setSourcesError('');
    try {
      const res = await call('scanImportSources', isWorkspace ? { wsPath: scope } : {});
      if (!res?.ok) throw new Error(res?.error || '读取本机客户端配置失败');
      setSources(res.sources || []);
    } catch (e) { setSourcesError(String(e?.message || e)); }
    finally { setSourcesLoading(false); }
  }, [call, isWorkspace, scope]);
  useEffect(() => { if (open) { setPreview(null); setError(''); } }, [open]);
  useEffect(() => {
    if (!open) { setSources([]); setSourcesError(''); clearSource(); return; }
    loadSources();
  }, [open, loadSources]);
  useEffect(() => {
    if (open) dialogRef.current?.focus();
  }, [open]);
  if (!open) return null;
  // 选中来源后，来源导入优先于粘贴内容：两者不会同时在生效状态。
  const pickSource = async (row) => {
    const names = sourceImportNames(row);
    if (row.error || !names.length) { setError(row.error || '这条配置里没有可导入的 MCP'); return; }
    setBusy(true); setError(''); setPreview(null); clearSource();
    try {
      const res = await call('previewImportSource', { sourceId: row.sourceId, scope: row.scope, names, ...scopePayload });
      if (!res?.ok) throw new Error(res?.error || '预览失败');
      setSource(row); setSourcePreview(res);
    } catch (e) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  };
  const runPreview = async () => {
    setBusy(true); setError(''); clearSource();
    try {
      const res = isWorkspace
        ? await call('previewWorkspaceImport', { wsPath: scope, json: text, mode })
        : await call('previewImport', { json: text, mode });
      if (!res?.ok) throw new Error(res?.error || 'JSON 解析失败');
      setPreview(res);
    } catch (e) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  };
  // 两条导入流程（粘贴 / 本机来源）只有「确认文案」与「调哪个 RPC」不同：把
  // 确认 → busy → RPC → 报错或收尾的骨架收在一处，避免两处各写一遍、改一处漏一处。
  const submitImport = async (confirmMessage, run) => {
    if (confirmMessage && !confirm(confirmMessage)) return;
    setBusy(true); setError('');
    try {
      const res = await run();
      if (!res?.ok) throw new Error(res?.error || '导入失败');
      onImported(res);
      onClose();
    } catch (e) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  };
  const replaceWarning = '替换会删除' + (isWorkspace ? '该项目' : '当前 Web profile');
  const applyImport = async () => {
    if (!preview) return runPreview();
    // 同名冲突不再让整批失败：Host 会跳过那几条并在预览的提示里写明，用户按需处理。
    return submitImport(
      mode === 'replace' ? replaceWarning + '中未出现在 JSON 里的 MCP。确认继续？' : '',
      () => (isWorkspace
        ? call('importWorkspaceJson', { wsPath: scope, json: text, mode })
        : call('importJson', { json: text, mode })),
    );
  };
  const applySourceImport = async () => {
    if (!source || !sourcePreview) return;
    return submitImport(
      mode === 'replace' ? replaceWarning + '中未出现在这份来源里的 MCP。确认继续？' : '',
      // 送出的是来源标识 + 条目名 + 预览时的内容指纹；路径与凭据都留在 Host 重算。
      () => call('importSource', {
        sourceId: source.sourceId,
        scope: source.scope,
        names: sourceImportNames(source),
        mode,
        contentHash: sourcePreview.contentHash,
        ...scopePayload,
      }),
    );
  };
  const activePreview = sourcePreview?.preview || preview;
  const summary = activePreview ? [
    '新增：' + (activePreview.added?.join(', ') || '无'),
    '更新：' + (activePreview.updated?.join(', ') || '无'),
    mode === 'replace' ? '移除：' + (activePreview.removed?.join(', ') || '无') : null,
    // 被跳过的同名条目（其他配置层占用、或来源里重名）由 Host 放进 warnings，这里只渲染一处，
    // 免得同一件事既显示"冲突"又显示"提示"。
    ...(activePreview.warnings || []).map((warning) => '提示：' + warning),
  ].filter(Boolean).join('\n') : '';
  // 来源列表已按当前层过滤（Host 侧保证）：全局标签只有全局来源，项目标签只有该项目的来源，
  // 所以行上不需要「（项目）」后缀，也不再需要用户自己判断「这一行会导到哪儿去」。
  const layerLabel = isWorkspace ? '项目级' : '全局';
  const layerHint = isWorkspace
    ? '没检测到这个项目的项目级 MCP 配置（.mcp.json / .codex/config.toml / .pi/mcp.json / opencode.json 等），可在下面手动粘贴'
    : '没检测到本机客户端的全局 MCP 配置（~/.claude.json / ~/.codex/config.toml / ~/.config/opencode/opencode.json 等），可在下面手动粘贴';
  return h('div', { className: 'dsh-mcp-overlay', onClick: (e) => e.target === e.currentTarget && onClose() },
    h('div', { ref: dialogRef, className: 'dsh-mcp-modal', role: 'dialog', 'aria-modal': true, 'aria-label': '导入 MCP', tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } } },
      h('h3', null, '导入 MCP' + (isWorkspace && scopeName && scopeName !== '全局' ? '（' + scopeName + '）' : '')),
      h('div', { className: 'dsh-mcp-field dsh-mcp-source-box' },
        h('label', null, '从本机客户端导入' + layerLabel + '配置（只读，不修改它们的文件）'),
        sourcesLoading ? h('div', { className: 'dsh-mcp-source-detail' }, '正在扫描本机客户端配置…') : null,
        sourcesError ? h('div', { className: 'dsh-mcp-d-err' }, sourcesError) : null,
        !sourcesLoading && !sourcesError && !sources.length
          ? h('div', { className: 'dsh-mcp-source-detail' }, layerHint)
          : null,
        sources.length ? h('div', { className: 'dsh-mcp-source-list' }, sources.map((row) => {
          const names = sourceImportNames(row);
          const masked = sourceMaskedFields(row);
          const missingEnv = sourceMissingEnv(row);
          const detail = row.error || (names.length ? names.length + ' 个 MCP：' + names.join(', ') : '没有可导入的 MCP');
          return h('button', {
            key: row.key,
            type: 'button',
            className: 'dsh-mcp-source-row' + (source?.key === row.key ? ' sel' : ''),
            disabled: busy || !!row.error || !names.length,
            title: row.displayPath,
            onClick: () => pickSource(row),
          },
            h('span', { className: 'dsh-mcp-source-head' },
              h('span', { className: 'dsh-mcp-source-name' }, row.label),
              h('code', { className: 'dsh-mcp-source-path' }, row.displayPath),
            ),
            h('span', { className: 'dsh-mcp-source-detail' }, detail),
            masked.length ? h('span', { className: 'dsh-mcp-source-note' }, '含需掩码字段：' + masked.join('、') + '（导入后在详情页可用眼睛查看）') : null,
            missingEnv.length ? h('span', { className: 'dsh-mcp-source-warn' }, '环境变量未设置：' + missingEnv.join('、') + '（导入后该处会得到空值）') : null,
            row.warnings?.length ? h('span', { className: 'dsh-mcp-source-warn' }, row.warnings.length + ' 条提示，导入时逐条列出') : null,
          );
        })) : null,
      ),
      h('div', { className: 'dsh-mcp-field' },
        h('label', null, '或粘贴 JSON：支持 Claude/Cursor/Cline/Roo 的 mcpServers、VS Code 的 servers，以及单个 MCP 对象'),
        h('textarea', { className: 'dsh-mcp-import-json', value: text, onChange: (e) => { setText(e.target.value); setPreview(null); clearSource(); }, placeholder: '{\n  "mcpServers": {\n    "example": { "command": "npx", "args": ["-y", "example-mcp"] }\n  }\n}' }),
      ),
      h('div', { className: 'dsh-mcp-radio-row' },
        h('label', { className: mode === 'merge' ? 'sel' : '' }, h('input', { type: 'radio', checked: mode === 'merge', onChange: () => { setMode('merge'); setPreview(null); } }), '合并（同名更新）'),
        h('label', { className: mode === 'replace' ? 'sel' : '' }, h('input', { type: 'radio', checked: mode === 'replace', onChange: () => { setMode('replace'); setPreview(null); } }), isWorkspace ? '替换该项目' : '替换当前 Profile'),
      ),
      summary ? h('div', { className: 'dsh-mcp-card dsh-mcp-import-preview' }, summary) : null,
      error ? h('div', { className: 'dsh-mcp-d-err' }, error) : null,
      h('div', { className: 'dsh-mcp-modal-actions' },
        h(Btn, { onClick: onClose, children: '取消' }),
        source ? h(Btn, { onClick: () => { clearSource(); setError(''); }, disabled: busy, children: '取消选择来源' }) : null,
        source
          ? h(Btn, { cls: 'primary', onClick: applySourceImport, disabled: busy || !sourcePreview, children: busy ? '导入中…' : '确认从来源导入' })
          : h(Btn, { onClick: runPreview, disabled: busy || !text.trim(), children: busy ? '解析中…' : '预览' }),
        source ? null : h(Btn, { cls: 'primary', onClick: applyImport, disabled: busy || !text.trim(), children: preview ? '确认导入' : '解析并预览' }),
      ),
    ),
  );
};

const POLL_INTERVAL_MS = 5000;

// 面板靠轮询反映 MCP 连接状态。标签页不可见时没人看这份数据，却照样每 5s 打两个 RPC，
// 因此隐藏期间跳过拉取，并在重新可见时立刻补一次，避免用户回来先看到一屏陈旧状态。
function startVisibilityAwarePolling(doc, timer, intervalMs, run) {
  const visible = () => !doc || doc.visibilityState !== 'hidden';
  const disposeInterval = timer.interval(() => { if (visible()) run(); }, intervalMs);
  if (!doc || typeof doc.addEventListener !== 'function') return disposeInterval;
  const onVisibilityChange = () => { if (visible()) run(); };
  doc.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    disposeInterval();
    doc.removeEventListener('visibilitychange', onVisibilityChange);
  };
}

const McpTab = (props) => {
  const { call, onClose, floating, timer, pluginManager } = props;
  const panelRef = useRef(null);
  const [servers, setServers] = useState([]);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [tools, setTools] = useState([]);
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [builtinOpen, setBuiltinOpen] = useState(false);
  const [editTarget, setEditTarget] = useState(null);
  const [toast, setToast] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [transportFilter, setTransportFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  // ---- workspace 项目层 ----
  const [scope, setScope] = useState('global');
  const [workspaces, setWorkspaces] = useState([]);
  const [globalServers, setGlobalServers] = useState([]);
  const [exclude, setExclude] = useState([]);
  const [mountErrors, setMountErrors] = useState([]);
  const [scopeErrors, setScopeErrors] = useState([]);
  const [restrictError, setRestrictError] = useState(null);
  const [liveAgents, setLiveAgents] = useState(0);
  const [globalOpen, setGlobalOpen] = useState(false);
  const [updateHint, setUpdateHint] = useState(null);
  const loadSeq = useRef(0);
  const manualRefreshSeq = useRef(0);
  const revisionRef = useRef('');
  const revealRevisionRef = useRef('');
  const [revealed, setRevealed] = useState({});
  const revealGeneration = useRef(0);
  const clearRevealed = useCallback(() => {
    clearRevealState(revealGeneration, setRevealed);
  }, []);

  useEffect(() => {
    if (floating) panelRef.current?.focus();
  }, [floating]);

  const flash = useCallback(
    (msg, kind) => {
      setToast({ msg, kind: kind || 'ok' });
      timer.timeout(() => setToast(''), 3200);
    },
    [timer],
  );

  const load = useCallback(async (notify = false) => {
    const seq = ++loadSeq.current;
    if (notify) { manualRefreshSeq.current = seq; setRefreshing(true); }
    try {
      const isWorkspace = scope !== 'global';
      const viewPromise = isWorkspace ? call('getWorkspaceView', { wsPath: scope }) : call('list');
      const [res, wsRes] = await Promise.all([viewPromise, call('listWorkspaces')]);
      if (seq !== loadSeq.current) return;
      if (wsRes && wsRes.ok) setWorkspaces(wsRes.workspaces || []);
      if (res && res.ok) {
        if (isWorkspace) {
          const next = res.servers || [];
          setGlobalServers(res.global || []);
          setExclude(res.exclude || []);
          setMountErrors(res.mountErrors || []);
          setScopeErrors(res.scopeErrors || []);
          setRestrictError(res.restrictError || null);
          setLiveAgents(res.liveAgents || 0);
          setError(res.error || '');
          if (!Object.hasOwn(res, 'revision') || res.revision !== revisionRef.current) {
            revisionRef.current = res.revision || '';
            setServers(next);
          }
          if (notify) flash('已刷新项目 MCP，共 ' + next.length + ' 个');
        } else {
          const next = res.servers || [];
          if (consumeRevision(revealRevisionRef, res.revealRevision)) clearRevealed();
          const hasRevision = Object.hasOwn(res, 'revision');
          if (!hasRevision || res.revision !== revisionRef.current) {
            revisionRef.current = res.revision || '';
            setServers(next);
          }
          setError('');
          if (notify) flash('已刷新，共 ' + next.length + ' 个 MCP');
        }
      } else {
        const message = (res && res.error) || '加载失败';
        setError(message);
        if (notify) flash(message, 'err');
      }
    } catch (e) {
      if (seq !== loadSeq.current) return;
      const message = String((e && e.message) || e);
      setError(message);
      if (notify) flash(message, 'err');
    } finally {
      if (notify && manualRefreshSeq.current === seq) setRefreshing(false);
    }
  }, [call, clearRevealed, flash, scope]);

  useEffect(() => {
    load(false);
    return startVisibilityAwarePolling(typeof document === 'undefined' ? null : document, timer, POLL_INTERVAL_MS, () => load(false));
  }, [load, timer]);

  // 更新提示：Host 每天最多查一次 GitHub Releases；纯增值信息，任何失败都静默，不打扰面板。
  useEffect(() => {
    let cancelled = false;
    call('updateHint').then((res) => {
      if (cancelled || !res?.ok || !res.updateAvailable) return;
      let dismissed = null;
      try { dismissed = localStorage.getItem('dsh-skill-mcp-board.updateHint.dismissed'); } catch { /* 存储不可用时视为未关闭 */ }
      if (dismissed !== res.latest) setUpdateHint(res);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [call]);

  // 探测一键升级的可用性：官方 pluginManager 在不在 + 本插件是不是 npm 装的。
  // 与 updateHint 同一条纪律：任何失败都静默（按钮不出现即可），绝不因它让面板报错。
  // 只在确实有新版时才探测——没有新版时按钮本来就不显示，省一次 remote 调用。
  useEffect(() => {
    if (!updateHint?.latest || !pluginManager || typeof pluginManager[UPGRADE_METHOD] !== 'function') return undefined;
    let cancelled = false;
    (async () => {
      try {
        const res = await pluginManager.listBundles();
        if (cancelled || !res || res.ok !== true || !Array.isArray(res.value)) return;
        const bundle = res.value.find((b) => b && b.name === UPGRADE_PACKAGE) || null;
        // 只有判定为「可升级」才记 state；不可升级时保持 idle，按钮走旧的链接形态。
        const plan = upgradePlan({ service: pluginManager, hint: updateHint, bundle });
        if (!cancelled && plan.supported) setUpgradeState({ phase: 'idle', bundle, spec: plan.spec });
      } catch { /* 探测失败 = 没有一键升级，退回链接；不报错 */ }
    })();
    return () => { cancelled = true; };
  }, [pluginManager, updateHint]);

  // 挂载失败按 serverName 索引：既标到列表行上，也注入详情的错误区，避免「顶部报错但那一行看着正常」。
  // 挂载失败的汇总横幅用的就是这个列表；行与详情都读 Host 标在行上的 mountFailed。

  // 选中项可能来自项目列表或（项目 tab 下的）全局列表；后者标记为 foreign，详情区据此只读。
  const selectedServer = useMemo(() => {
    const local = servers.find((s) => s.serverName === selected);
    // 挂载失败与连接失败已由 Host 在行上标好（mountFailed / status），这里不再二次合并，
    // 避免同一事实在两处各算一遍。
    if (local) return local;
    if (scope === 'global') return null;
    const global = globalServers.find((s) => s.serverName === selected);
    return global ? { ...global, managed: false, foreign: 'global' } : null;
  }, [servers, globalServers, selected, scope]);

  useEffect(() => {
    let cancelled = false;
    setTools([]);
    if (!selected) return () => { cancelled = true; };
    (async () => {
      try {
        // 项目 MCP 要带 wsPath 才能精确定位：serverName 的全 app 唯一性只在保存路径被校验，
        // 手工编辑 .dsh/mcp.json 能造出两个项目同名，光按名字问会拿到另一个项目的工具。
        const res = selectedServer?.scope === 'workspace' && scope !== 'global'
          ? await call('tools', { name: selected, wsPath: scope })
          : await call('tools', { name: selected });
        if (!cancelled && res?.ok) setTools(res.tools || []);
      } catch {
        if (!cancelled) setTools([]);
      }
    })();
    return () => { cancelled = true; };
  }, [selected, selectedServer?.scope, selectedServer?.toolRevision, scope, call]);

  const act = useCallback(
    async (method, args, successMsg) => {
      setBusy(true);
      try {
        const res = await call(method, args);
        if (res && res.ok) {
          flash(successMsg || (res.note || method + ' 成功'));
        } else {
          flash((res && res.error) || method + ' 失败', 'err');
        }
      } catch (e) {
        flash(String((e && e.message) || e), 'err');
      } finally {
        setBusy(false);
        timer.timeout(load, 250);
      }
    },
    [call, flash, load, timer],
  );

  const onToggle = (s) => {
    if (busy || !s.managed) return;
    const next = !s.enabled;
    // 乐观更新：本地先翻转，操作完成后由 load 校准。
    revisionRef.current = '';
    setServers((prev) => prev.map((x) => (x.serverName === s.serverName ? { ...x, enabled: next } : x)));
    if (scope === 'global') {
      return act(next ? 'enable' : 'disable', s.serverName, (next ? '已启用 ' : '已禁用 ') + s.serverName);
    }
    // 项目层：写 disabled 字段到项目配置。
    const spec = { ...s, name: s.serverName, transport: s.transport === 'stdio' ? 'stdio' : 'streamable-http', disabled: !next };
    return act('updateWorkspaceServer', { wsPath: scope, spec }, (next ? '已启用 ' : '已禁用 ') + s.serverName);
  };
  const onReconnect = (s) => {
    // 项目连接也要有出口：mcp-client 的重连预算耗尽后会注销工具并停止，只能靠重载配置/重启宿主
    // 恢复（它的 README 明写），而项目 MCP 不是常驻服务 —— 所以「重连」在这里是必需的能力，
    // 不是可选装饰。这条路径 = 拆掉旧连接 + 按当前配置重建 + 对齐存活会话。
    if (s.scope === 'workspace') {
      return act('reconnectWorkspaceServer', { wsPath: scope, name: s.serverName }, '已重连 ' + s.serverName);
    }
    act('reconnect', s.serverName, '已请求重连 ' + s.serverName);
  };
  const onRemove = (s) => {
    const isWorkspace = s.scope === 'workspace';
    if (confirm('确认移除 MCP「' + s.serverName + '」？将从' + (isWorkspace ? '项目配置' : '当前 Web profile 配置') + '中删除。')) {
      clearRevealed();
      if (isWorkspace) act('removeWorkspaceServer', { wsPath: scope, name: s.serverName }, '已移除 ' + s.serverName);
      else act('removeServer', s.serverName, '已移除 ' + s.serverName);
    }
  };
  const onToggleExclude = (serverName, hidden) => {
    if (busy || scope === 'global') return;
    revisionRef.current = '';
    setGlobalServers((prev) => prev.map((s) => (s.serverName === serverName ? { ...s, excluded: hidden } : s)));
    setExclude((prev) => (hidden ? (prev.includes(serverName) ? prev : [...prev, serverName]) : prev.filter((name) => name !== serverName)));
    // 屏蔽同样是"写盘即对齐"：Host 会立刻把新的 restrict 写进会话作用域，运行中的会话在**下一次
    // 模型请求**就不再见得到这些工具（工具清单是每步重新组装的，不是首轮定型）。
    act('setWorkspaceExclude', { wsPath: scope, serverName, hidden }, hidden ? ('已屏蔽 ' + serverName + '，对运行中的会话立即生效') : ('已取消屏蔽 ' + serverName + '，对运行中的会话立即生效'));
  };
  useEffect(() => { clearRevealed(); }, [selected, clearRevealed]);
  const revealValue = useCallback(async (server, field, key) => {
    if (!server.managed) throw new Error('该 MCP 来自其他配置层，配置只读，无法查看具体值');
    const res = server.scope === 'workspace'
      ? await call('revealWorkspaceServer', { wsPath: scope, name: server.serverName, field, key })
      : await call('reveal', { name: server.serverName, field, key });
    if (!res?.ok) throw new Error(res?.error || '读取配置失败');
    return res.value;
  }, [call, scope]);
  const onCopy = useCallback((text) => {
    copyText(text).then((ok) => flash(ok ? '已复制到剪贴板' : '复制失败', ok ? 'ok' : 'err'));
  }, [flash]);
  const onReveal = useCallback(async (server, field, key) => {
    const id = server.serverName + ':' + field + (key !== undefined ? ':' + key : '');
    if (revealed[id]?.value !== undefined) { setRevealed((prev) => ({ ...prev, [id]: false })); return; }
    if (revealed[id]?.pending) return;
    const generation = revealGeneration.current;
    setRevealed((prev) => ({ ...prev, [id]: { pending: true } }));
    try {
      const value = await revealValue(server, field, key);
      if (generation !== revealGeneration.current) return;
      setRevealed((prev) => ({ ...prev, [id]: { value, field, key } }));
    } catch (e) {
      if (generation !== revealGeneration.current) return;
      setRevealed((prev) => ({ ...prev, [id]: false }));
      flash(String(e?.message || e), 'err');
    }
  }, [flash, revealValue, revealed]);
  const onSubmit = async (spec, setFormError) => {
    setBusy(true);
    const isWorkspace = scope !== 'global';
    try {
      const res = isWorkspace
        ? (editTarget
            ? await call('updateWorkspaceServer', { wsPath: scope, spec })
            : await call('addWorkspaceServer', { wsPath: scope, spec }))
        : (editTarget ? await call('update', spec) : await call('add', spec));
      if (res && res.ok) {
        clearRevealed();
        flash(editTarget ? '已保存 ' + spec.name : '已添加 ' + spec.name);
        setAddOpen(false);
        setEditTarget(null);
        timer.timeout(load, 1500);
      } else {
        setFormError((res && res.error) || (editTarget ? '保存失败' : '添加失败'));
      }
    } catch (e) {
      setFormError(String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  };
  const openAdd = () => { setEditTarget(null); setAddOpen(true); };
  const openEdit = (s) => { setEditTarget(s); setAddOpen(true); };
  const onImported = (res) => {
    clearRevealed();
    flash(res.note || '已导入 MCP');
    timer.timeout(load, 1200);
  };
  const onBuiltinsInstalled = (res) => {
    clearRevealed();
    flash(res.note || '已安装所选 MCP');
    timer.timeout(load, 1200);
  };

  const dismissUpdateHint = () => {
    if (updateHint?.latest) { try { localStorage.setItem('dsh-skill-mcp-board.updateHint.dismissed', updateHint.latest); } catch { /* 忽略：下次打开会再提示 */ } }
    setUpdateHint(null);
    // 升级完成的横幅不挂在 updateHint 上（那时它已经是 null），所以要把 state 也收掉，
    // 否则「关闭」按钮按下去横幅还在。
    setUpgradeState((current) => (current.phase === 'done' ? { phase: 'idle' } : current));
  };

  // 一键升级：探测官方 pluginManager → 读本插件那一行 → 判定 → 执行 → 按 application 分流。
  // 探测失败一律静默退回「查看更新方式」链接：老宿主 / 没这个 namespace 时按钮不该出现，
  // 更不该报错（这一整块是纯增值信息，与 updateHint 同一条纪律）。
  const [upgradeState, setUpgradeState] = useState({ phase: 'idle' });
  const runUpgrade = async () => {
    const svc = pluginManager;
    const plan = upgradePlan({ service: svc, hint: updateHint, bundle: upgradeState.bundle || null });
    if (!plan.supported) {
      // 只有「本地链接安装」值得明说：其余情况（宿主没提供、已是最新）按钮本来就不显示。
      setUpgradeState({ phase: 'blocked', reason: plan.reason });
      return;
    }
    setUpgradeState({ phase: 'running', version: plan.version });
    try {
      // 两个参数：installBundle(spec, options)。少传第二个会被 wire 直接拒绝
      // （client api: pluginManager/installBundle expected 2 argument(s), got 1）。
      const res = await svc[UPGRADE_METHOD](plan.spec, {});
      if (!res || res.ok !== true) {
        setUpgradeState({ phase: 'failed', text: (res && res.error && (res.error.message || res.error.code)) || '调用失败' });
        return;
      }
      const r = res.value || {};
      if (r.application === 'failed' || r.application === 'cancelled') {
        setUpgradeState({ phase: 'failed', text: upgradeFailureText(r.error, r.packageResult && r.packageResult.exitCode) });
        return;
      }
      // applied / restart-required / overridden 都算装上了。宿主代码在进程内执行，升级已存在的包
      // 时官方**无条件**返回 restart-required（installBundle 里 `if (Object.hasOwn(before, name))
      // return 'restart-required'`，与 HMR 开不开无关），所以这里必须告诉用户去重启。
      setUpgradeState({ phase: 'done', version: plan.version || updateHint?.latest || '' });
    } catch (e) {
      setUpgradeState({ phase: 'failed', text: String(e?.message || e) });
    }
  };
  const filtered = useMemo(() => {
    const q = (query || '').toLowerCase();
    return servers.filter((s) => {
      if (transportFilter !== 'all' && s.transport !== transportFilter) return false;
      if (statusFilter !== 'all') {
        const status = s.status || s.phase || 'waiting';
        if (statusFilter === 'connected' && status !== 'connected') return false;
        if (statusFilter === 'failed' && status !== 'failed') return false;
        if (statusFilter === 'disabled' && s.enabled) return false;
      }
      if (!q) return true;
      return s.serverName.toLowerCase().includes(q) || (s.url || s.command || '').toLowerCase().includes(q);
    });
  }, [servers, query, transportFilter, statusFilter]);

  const visibleGlobalCount = useMemo(() => {
    const hidden = new Set(exclude || []);
    return globalServers.reduce((count, s) => (hidden.has(s.serverName) ? count : count + 1), 0);
  }, [globalServers, exclude]);

  const scopeTabs = useMemo(() => {
    const tabs = [{ key: 'global', label: '全局' }];
    for (const ws of workspaces) {
      tabs.push({ key: ws.path, label: ws.name, count: ws.serverCount, title: ws.path + (ws.error ? '（配置无效：' + ws.error + '）' : '') });
    }
    return tabs;
  }, [workspaces]);
  const scopeName = scope === 'global' ? '全局' : (workspaces.find((ws) => ws.path === scope)?.name || scope);
  const switchScope = useCallback((next) => {
    if (next === scope) return;
    setScope(next);
    setSelected('');
    setQuery('');
    // 状态过滤在两种作用域下语义不同（项目 MCP 无连接态），切换时归零避免「空列表且控件已隐藏」。
    setTransportFilter('all');
    setStatusFilter('all');
    setGlobalOpen(false);
    setAddOpen(false);
    setImportOpen(false);
    setBuiltinOpen(false);
    setEditTarget(null);
    setError('');
    revisionRef.current = '';
    clearRevealed();
  }, [scope, clearRevealed]);

  const inner = h(
    'div',
    { className: 'dsh-mcp-wrap' },
    h(
      'div',
      { className: 'dsh-mcp-head' },
      h('div', { className: 'dsh-mcp-title' }, 'MCP 市场'),
      h(
        'div',
        // 作用域由下方的 tab 高亮承载，按钮文案不再重复项目名：项目名长度不可控，
        // 塞进三个按钮会把工具栏挤到换行；完整作用域放在 title 里，宽度保持恒定。
        { className: 'dsh-mcp-head-actions' },
        h(Btn, { icon: 'refresh', onClick: () => load(true), disabled: refreshing, children: refreshing ? '刷新中…' : '刷新' }),
        h(Btn, { onClick: () => setImportOpen(true), title: '导入 MCP（' + scopeName + '）', children: '导入 MCP' }),
        h(Btn, { icon: 'plug', onClick: () => setBuiltinOpen(true), title: 'MCP 市场（' + scopeName + '）', children: '市场' }),
        h(Btn, { cls: 'primary', icon: 'plus', onClick: openAdd, title: (scope === 'global' ? '添加 MCP' : '添加项目 MCP') + '（' + scopeName + '）', children: scope === 'global' ? '添加 MCP' : '添加项目 MCP' }),
        h(EntryMenu, null),
        onClose ? h(Btn, { icon: 'x', onClick: onClose, children: '关闭' }) : null,
      ),
    ),
    h(ScopeTabs, { tabs: scopeTabs, active: scope, onSelect: switchScope }),
    // 横幅的存活条件：有新版本，**或者**刚升完（要告诉用户重启，否则「点完就消失」
    // 等于没说——实测就是这样：升级成功后 updateHint 立刻变成「已是最新」，横幅随之消失）。
    (updateHint || upgradeState.phase === 'done') ? h('div', { className: 'dsh-mcp-upd' },
      // 文案随升级阶段走：升级中/已装完待重启/失败，都比「有新版本」更该让用户看到。
      // 注意 updateHint 在 done 分支已经是 null（宿主已认不出旧版），所以这里不读它的字段。
      h('span', null,
        upgradeState.phase === 'running' ? '正在升级到 v' + upgradeState.version + '…'
          : upgradeState.phase === 'done' ? '已升级到 v' + upgradeState.version + '，重启宿主后生效'
            : upgradeState.phase === 'failed' ? '升级失败：' + upgradeState.text
              : upgradeState.phase === 'blocked' && upgradeState.reason === 'not-npm'
                ? '本地链接安装，无法一键升级' + (updateHint?.current ? '（当前 v' + updateHint.current + '）' : '')
                : '新版本 v' + updateHint.latest + ' 可用'),
      // 可升级时给按钮，否则退回链接。按钮只在探测确认过 service + npm 来源后出现——
      // 探测失败时这一整条与改动前完全一致，不会出现点了没反应的按钮。
      upgradeState.phase === 'idle' && upgradeState.spec
        ? h('button', {
          type: 'button', className: 'dsh-mcp-upd-go',
          title: '升级由官方 pluginManager 执行，装完需要重启宿主',
          onClick: runUpgrade,
        }, '升级')
        : h('a', {
          href: (updateHint && updateHint.url) || 'https://github.com/Imzl-zl/dsh-mcp-manager-ui/releases',
          target: '_blank', rel: 'noreferrer',
        }, upgradeState.phase === 'done' ? '看这次改了什么' : '查看更新方式'),
      h('button', { type: 'button', className: 'dsh-mcp-upd-close', 'aria-label': '关闭更新提示', title: '本版本内不再提示', onClick: dismissUpdateHint }, h(Icon, { d: ICONS.x })),
    ) : null,
    error ? h('div', { className: 'dsh-mcp-d-err' }, error) : null,
    scope !== 'global' && mountErrors.length ? h('div', { className: 'dsh-mcp-log' }, mountErrors.length + ' 个项目 MCP 未能挂载到会话：' + mountErrors.map((m) => m.serverName).join('、') + '。点开对应条目查看具体错误。'
      // 项目 MCP 是「该项目所有会话共享一份连接」，同一项目内不会因并发会话而撞名；这里只
      // 如实给出并发会话数作为上下文（挂载失败的常见外部原因），不再把它说成 serverName 占用。
      + (liveAgents > 1 ? '　本项目当前有 ' + liveAgents + ' 个会话在运行。' : '')) : null,
    scope !== 'global' && scopeErrors.length ? h('div', { className: 'dsh-mcp-log' }, scopeErrors.length + ' 个项目 MCP 的工具不在共享作用域层：' + scopeErrors.map((m) => m.serverName).join('、') + '。点开对应条目查看具体错误。') : null,
    scope !== 'global' && restrictError ? h('div', { className: 'dsh-mcp-log' }, '屏蔽未能写入会话作用域：' + restrictError.error) : null,
    scope === 'global'
      ? h(
          'div',
          { className: 'dsh-mcp-body' },
          h(ServerList, { servers: filtered, total: servers.length, selected, query, onQuery: setQuery, onSelect: setSelected, onToggle, busy, transportFilter, statusFilter, onTransportFilter: setTransportFilter, onStatusFilter: setStatusFilter }),
          h(ServerDetail, {
            server: selectedServer,
            tools,
            onToggle,
            onReconnect,
            onEdit: openEdit,
            onRemove,
            busy,
            onReveal,
            revealed,
            onCopy,
          }),
        )
      : h(
          'div',
          { className: 'dsh-mcp-body' },
          h('div', { className: 'dsh-mcp-ws-body', 'data-ws-path': scope },
            h('div', { className: 'dsh-mcp-section local' },
              h('div', { className: 'dsh-mcp-section-title' },
                '此项目的 MCP',
                h('span', { className: 'dsh-mcp-section-count' }, servers.length),
              ),
              h(ServerList, {
                servers: filtered,
                total: servers.length,
                selected,
                query,
                onQuery: setQuery,
                onSelect: setSelected,
                onToggle,
                busy,
                transportFilter,
                statusFilter,
                onTransportFilter: setTransportFilter,
                onStatusFilter: setStatusFilter,
                embedded: true,
                workspace: true,
                emptyHint: '此项目还没有 MCP。用右上角「添加项目 MCP」或「市场」写入 .dsh/mcp.json',
              }),
            ),
            h('div', { className: 'dsh-mcp-section global' + (globalOpen ? '' : ' collapsed') },
              // 全局可见性是低频操作，默认收成一行摘要，把高度让给本 tab 的主角——项目 MCP。
              h('button', {
                type: 'button',
                className: 'dsh-mcp-section-toggle',
                'aria-expanded': globalOpen,
                onClick: () => setGlobalOpen((value) => !value),
              },
                h('span', { className: 'dsh-mcp-caret', 'aria-hidden': true }, globalOpen ? '▾' : '▸'),
                h('span', { className: 'dsh-mcp-section-toggle-label' }, '全局 MCP'),
                h('span', { className: 'dsh-mcp-section-summary' },
                  globalServers.length === 0
                    ? '无'
                    : visibleGlobalCount + '/' + globalServers.length + ' 对本项目可见'
                      // 工具清单是**每一步**重新组装的，所以改动（新增/删除/改配置/屏蔽）对运行中的
                      // 会话在下一轮请求就生效；只有手工改 .dsh/mcp.json 才要等下一次会话挂载。
                      + '　·　改动即刻生效'),
              ),
              globalOpen ? h(GlobalServerList, { servers: globalServers, exclude, onToggleExclude, onSelect: setSelected, selected, busy }) : null,
            ),
          ),
          h(ServerDetail, {
            server: selectedServer,
            tools,
            onToggle,
            onReconnect,
            onEdit: openEdit,
            onRemove,
            busy,
            onReveal,
            revealed,
            onCopy,
            excluded: exclude.includes(selected),
            onToggleExclude,
          }),
        ),
    h(BuiltinInstallModal, { open: builtinOpen, onClose: () => setBuiltinOpen(false), call, busy, setBusy, onInstalled: onBuiltinsInstalled, scope, knownNames: servers }),
    h(AddEditModal, { open: addOpen, onClose: () => { setAddOpen(false); setEditTarget(null); }, onSubmit, busy, initial: editTarget, onRevealValue: revealValue, revealEpoch: revealGeneration.current, scopeName }),
    h(JsonImportModal, { open: importOpen, onClose: () => setImportOpen(false), call, busy, setBusy, onImported, scope, scopeName }),
    // 更新提示也挂在面板的弹层列表里：面板一开它就挂载，向宿主问一次「这次变了什么」。
    h(WhatsNewModal, { call }),
    toast
      ? h('div', { className: 'dsh-mcp-toast ' + toast.kind }, toast.msg)
      : null,
  );

  if (floating)
    return h(
      'div',
      { className: 'dsh-mcp-panel-overlay', onClick: (e) => e.target === e.currentTarget && onClose && onClose() },
      h('div', { ref: panelRef, className: 'dsh-mcp-panel', role: 'dialog', 'aria-modal': true, 'aria-label': 'MCP 市场面板', tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape' && onClose) onClose(); } }, inner),
    );
  return inner;
};

// ── 右下角浮动按钮（shell.overlay 常驻，可拖拽 + 记忆位置）──────────────
// shell.overlay 是「叠加式」挂载层，DSH 不做多插件避让，所以按钮定位由本插件
// 自己负责：默认右下角，用户可拖动到任意位置，位置存 localStorage 跨会话还原。
//
// 跟手性要点（参考 dnd-kit / react-draggable / 社区 FAB 拖拽惯例）：
// - 拖拽期间直接写 DOM，不走 setState：pointermove 高频，每个事件都让 React 重渲染
//   会掉帧、不跟手；最终位置只在松手时提交一次。
// - Pointer Events + setPointerCapture 统一鼠标/触摸/笔，快速拖动不丢事件。
// - touch-action:none 是触摸下唯一可靠的滚动抑制手段（iOS Safari 尤其如此）。
//   本按钮是 position:fixed 的 50px 圆钮，脱离文档流，left/top 重绘成本可忽略，
//   故保留 left/top 定位以复用现有 :hover/:active 的 transform 缩放反馈。
const FAB_POS_KEY = 'dsh-skill-mcp-board/fab-pos';
const FAB_SIZE = 50;
const FAB_EDGE = 22;
const DRAG_THRESHOLD = 5;

function fabViewport() {
  const w = typeof window !== 'undefined' ? window.innerWidth : 0;
  const h = typeof window !== 'undefined' ? window.innerHeight : 0;
  return { w, h };
}
function clampFabPos(x, y) {
  const { w, h } = fabViewport();
  return {
    x: Math.min(Math.max(x, 0), Math.max(0, w - FAB_SIZE)),
    y: Math.min(Math.max(y, 0), Math.max(0, h - FAB_SIZE)),
  };
}
function defaultFabPos() {
  const { w, h } = fabViewport();
  return { x: w - FAB_SIZE - FAB_EDGE, y: h - FAB_SIZE - FAB_EDGE };
}
function readFabPos() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(FAB_POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // Number.isFinite 兜底：JSON 里 1e999 会解析成 Infinity，typeof number 挡不住，
    // 混进 clamp 会产出 NaNpx 让按钮凭空消失。
    if (!parsed || typeof parsed.x !== 'number' || typeof parsed.y !== 'number' || !Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
    return clampFabPos(parsed.x, parsed.y);
  } catch {
    return null;
  }
}
function saveFabPos(pos) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(FAB_POS_KEY, JSON.stringify({ x: pos.x, y: pos.y }));
  } catch {
    // 存储不可用（无痕/禁用）：拖拽仍可用，只是不跨会话记忆。
  }
}

// ── 面板开合状态：悬浮按钮与左侧栏入口共享同一份 ──────────────────────────────
// 两个入口分属不同的 slot 子树（shell.overlay / sidebar.footer.action），没有公共
// React 祖先，因此用模块级订阅而不是 context。单一数据源：两个入口看到的开关状态
// 永远一致，不会出现「一个说开着、一个说关着」。
function createPanelVisibility() {
  let open = false;
  const listeners = new Set();
  return {
    isOpen: () => open,
    set(next) {
      if (open === next) return;
      open = next;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
const panelVisibility = createPanelVisibility();

const usePanelOpen = () => {
  const [open, setOpen] = useState(panelVisibility.isOpen());
  useEffect(() => panelVisibility.subscribe(() => setOpen(panelVisibility.isOpen())), []);
  return open;
};

// ── 入口显示偏好：两个入口都可关，但不能都关 ─────────────────────────────────
// 面板只能从这两个入口打开（右下角悬浮按钮 / 左侧栏底部「MCP」）。所以「两个都关」是一
// 个必须**无法表达**的状态：真出现了，用户就再也打不开面板，只能手改 localStorage 回来。
// 这里因此不存两个 boolean，而是存一张「模式 → 入口可见性」表：非法组合在表里根本不存在，
// 不需要额外的守卫、禁用逻辑或「至少留一个」的提示文案。新增入口时，这张表的不变式
// （每一项至少一个入口可见）由 test/client-entry.test.mjs 直接对表断言。
const ENTRY_KEY = 'dsh-skill-mcp-board/entry';
const ENTRY_VISIBILITY = {
  both: { panel: true, fab: true, sidebar: false },
  panel: { panel: true, fab: false, sidebar: false },
  fab: { panel: false, fab: true, sidebar: false },
  sidebar: { panel: false, fab: false, sidebar: true },
  all: { panel: true, fab: true, sidebar: true },
};
const ENTRY_LABELS = {
  both: '全局面板 + 悬浮按钮（推荐）',
  panel: '仅全局面板（左上角，"插件"旁）',
  fab: '仅悬浮按钮',
  sidebar: '仅侧栏底部入口',
  all: '三个入口全开',
};
const ENTRY_DEFAULT = 'both';
const ENTRY_MODES = Object.keys(ENTRY_VISIBILITY);

// localStorage 是外部输入（旧版本写的、用户手改的）：不认识的值一律退回默认，
// 不半信半疑地拿去查表（查不到会得到一个 undefined 的可见性，等于悄悄关掉所有入口）。
function normalizeEntryMode(value) {
  return Object.prototype.hasOwnProperty.call(ENTRY_VISIBILITY, value) ? value : ENTRY_DEFAULT;
}
function readEntryMode() {
  try {
    if (typeof localStorage === 'undefined') return ENTRY_DEFAULT;
    return normalizeEntryMode(localStorage.getItem(ENTRY_KEY));
  } catch {
    return ENTRY_DEFAULT;
  }
}
function saveEntryMode(mode) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(ENTRY_KEY, mode);
  } catch {
    // 存储不可用（无痕 / 被禁用）：本次会话内仍然生效，只是不跨会话记忆。
  }
}
function createEntryMode() {
  let mode = readEntryMode();
  const listeners = new Set();
  return {
    get: () => mode,
    set(next) {
      const normalized = normalizeEntryMode(next);
      if (normalized === mode) return;
      mode = normalized;
      saveEntryMode(mode);
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
const entryMode = createEntryMode();

const useEntryMode = () => {
  const [mode, setMode] = useState(entryMode.get());
  useEffect(() => entryMode.subscribe(() => setMode(entryMode.get())), []);
  return mode;
};

// shell.overlay 那个注册里到底渲染什么：面板挂载点与悬浮按钮是两件事——
//   面板：只要 open 就渲染。侧栏入口只改 panelVisibility，真正渲染面板的是这里，
//         所以把面板也用入口偏好门住 = 关掉悬浮按钮后侧栏入口点了没反应（把自己锁死）。
//   按钮：才看入口偏好，且只在面板没开着时占位。
// 抽成纯函数也是为了让这条不变式能脱离 React 被测：测试替身的 hooks 是空实现，组件本身
// 在 node 里渲染不起来（见 test/client-entry.test.mjs）。
function overlaySeats(mode, open) {
  return { panel: false, fab: ENTRY_VISIBILITY[mode].fab };
}

// ── 全局面板入口（sidebar.panellist + main，与「插件」同一套官方机制）──────
// 为什么换挂载点：原来的侧栏入口挂在 sidebar.footer.action（侧栏底部），点开的是
// shell.overlay 里的浮层面板——一个 role="dialog" 的独立弹层。现在改成官方「全局面板」
// 机制：侧栏顶部（"插件"旁边）注册一个面板行，点击走 ctx.layout.selectPanel()，
// 中栏以 entryKey 切换到本插件的页面——与切换对话完全同构，不再新开/独立弹出。
// 两个 id 必须是同一个字符串：侧栏行点击后宿主会先校验 main slot 里存在同 key 的
// 条目（layout.selectPanel → hasMainPanel），不存在会直接抛错，侧栏就点不动了。
const PANEL_ID = 'mcp-manager';
// 入口排序：插件管理器用 0，定时任务用 10；取 5 让本入口正好落在「插件」旁边。
const PANEL_ORDER = 5;
const PANEL_LABEL = '技能 · MCP';

// skill 的 source 取值域来自官方 dsh-skill-filesystem 的 roots()（rank 顺序即优先级），
// 与 skill-registry 的 runtime。这里只做展示文案，不参与判定。
const SKILL_SOURCE_LABELS = {
  'project-dsh': '项目 .dsh/skills',
  'project-agents': '项目 .agents/skills',
  custom: '自定义目录',
  'user-dsh': '用户 ~/.dsh/skills',
  'user-agents': '用户 ~/.agents/skills',
  bundled: '随 DSH 分发',
  runtime: '运行时注册',
};
const skillSourceLabel = (source) => SKILL_SOURCE_LABELS[source] || (source || '未知来源');

// 「项目」语境下 cwd 决定项目根（.dsh/skills / .agents/skills 都从它往下找），
// 全局语境传 undefined，让提供方只扫用户级与自定义目录——与官方 list() 语义一致。
const skillScopeArg = (scope) => (scope === 'global' ? {} : { cwd: scope });

// 看板顶层分类：MCP（原面板全部能力）与 Skill（新看板）。
// ── 工具裁缝（Tool Tailor）：工具使用账本 + 上下文税单 + 死工具清单 ──
// 数据来自宿主的 toolTailor Remote（只读扫描 ~/.dsh/sessions），禁用/启用直接复用
// 既有的 disable/enable 写链 —— 因此只有「当前已注册的 MCP 工具」才有操作按钮，
// 历史出现过的未注册工具（例如已卸载的 MCP）只展示统计。
// 延迟统计暂缺（见 tool-ledger.js 尾注），健康度以错误率 + 调用次数呈现。
const TAILOR_WINDOWS = [
  { key: '7', label: '近 7 天', days: 7 },
  { key: '30', label: '近 30 天', days: 30 },
  { key: '90', label: '近 90 天', days: 90 },
];
const fmtInt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
const fmtPct = (n) => (typeof n === 'number' && n > 0 ? (n * 100).toFixed(1) + '%' : '0%');
const fmtTax = (n) => (typeof n === 'number' && n > 0 ? '~' + n.toLocaleString('en-US') + ' tok' : '—');
const fmtLast = (ms, now) => {
  if (typeof ms !== 'number') return '从未';
  const diff = Math.max(0, (typeof now === 'number' ? now : Date.now()) - ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return min + ' 分钟前';
  const h = Math.floor(min / 60);
  if (h < 24) return h + ' 小时前';
  const d = Math.floor(h / 24);
  return d + ' 天前';
};
const kindLabel = (tool) => (tool.kind === 'mcp' ? 'MCP' : tool.kind === 'mcp-ambiguous' ? 'MCP?' : '内置');
const fmtScanError = (message) =>
  /404|transport failure/i.test(String(message))
    ? String(message) + '　——宿主还没注册 toolTailor 接口：重启 DeepSeek Harness 让宿主侧生效后即可'
    : String(message);

const ToolTailor = ({ call, timer }) => {
  const [windowKey, setWindowKey] = useState('30');
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [flashMsg, setFlashMsg] = useState('');
  const [onlyDead, setOnlyDead] = useState(true);
  const flashCancel = useRef(null);
  const days = Number(windowKey) || 30;

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await call('toolTailor', { days });
      if (res && res.ok) {
        setReport(res);
        setActionError('');
      } else {
        setError((res && res.error) || 'toolTailor 调用失败');
      }
    } catch (e) {
      setError(String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  }, [call, days]);

  useEffect(() => {
    load();
  }, [load]);

  // 完成动作后账本要重扫（禁用会让工具从注册表里消失），但扫描要几百毫秒，
  // 先给行内反馈再刷新。
  const flash = (text, kind) => {
    setFlashMsg(kind === 'err' ? '' : text);
    setActionError(kind === 'err' ? text : '');
    // timer.timeout 的返回值是「取消函数」而不是 id（见 createTimer），直接持有它。
    if (flashCancel.current) flashCancel.current();
    flashCancel.current = timer.timeout(() => { setFlashMsg(''); setActionError(''); }, 4000);
  };
  useEffect(() => () => { if (flashCancel.current) flashCancel.current(); }, []);

  const tailorAct = async (method, args, msg) => {
    setBusy(true);
    try {
      const res = await call(method, args);
      if (res && res.ok) flash(msg);
      else flash((res && res.error) || method + ' 失败', 'err');
    } catch (e) {
      flash(String((e && e.message) || e), 'err');
    } finally {
      setBusy(false);
      timer.timeout(load, 300);
    }
  };

  const tools = report && Array.isArray(report.tools) ? report.tools : [];
  const shown = tools
    .filter((tool) => (onlyDead ? tool.calls === 0 : true))
    .sort((a, b) => (b.calls - a.calls) || ((b.schemaTokens || 0) - (a.schemaTokens || 0)) || String(a.name).localeCompare(String(b.name)));
  const deadMcp = tools.filter((tool) => tool.kind === 'mcp' && tool.calls === 0);
  const deadMcpActionable = deadMcp.filter((tool) => !tool.serverDisabled);

  return h('div', { className: 'dsh-mcp-tailor' },
    h('div', { className: 'dsh-mcp-tailor-cards' },
      h('div', { className: 'dsh-mcp-tailor-card' }, h('b', null, fmtInt(report ? report.totalCalls : null)), h('span', null, `窗口内工具调用总次数（${days} 天）`)),
      h('div', { className: 'dsh-mcp-tailor-card' }, h('b', null, fmtInt(report ? report.toolCount : null)), h('span', null, '出现过的工具（含已卸载 MCP 的历史调用）')),
      h('div', { className: 'dsh-mcp-tailor-card dead' }, h('b', null, fmtInt(report ? report.deadMcpCount : null)), h('span', null, `零调用的 MCP 工具（每轮白缴 ${report ? fmtTax(report.deadMcpTaxTokens) : '—'} 上下文税）`)),
      h('div', { className: 'dsh-mcp-tailor-card err' }, h('b', null, fmtPct(report && report.totalCalls > 0 ? report.totalErrors / report.totalCalls : 0)), h('span', null, `总体错误率（${fmtInt(report ? report.totalErrors : null)} 次失败）`)),
    ),
    h('div', { className: 'dsh-mcp-tailor-toolbar' },
      TAILOR_WINDOWS.map((w) =>
        h('button', { key: w.key, type: 'button', className: 'dsh-mcp-btn' + (windowKey === w.key ? ' primary' : ''), onClick: () => setWindowKey(w.key) }, w.label),
      ),
      h('button', { type: 'button', className: 'dsh-mcp-btn' + (onlyDead ? ' primary' : ''), onClick: () => setOnlyDead((v) => !v), title: '只看窗口内零调用的工具' }, '只看死工具'),
      h('button', { type: 'button', className: 'dsh-mcp-btn', onClick: load, disabled: busy }, '重扫'),
      h('span', { className: 'dsh-mcp-tailor-meta' },
        report
          ? `扫描 ${report.sessionsScanned} 个会话 · 读 ${report.filesRead} 个日志${report.failedFiles ? ` · ${report.failedFiles} 个失败` : ''} · 全部工具 Schema 合计 ~${fmtInt(report.taxTotalTokens)} tok/请求`
          : (busy ? '扫描中…' : ''),
      ),
    ),
    error ? h('div', { className: 'dsh-mcp-tailor-note' }, '账本加载失败：', fmtScanError(error)) : null,
    actionError ? h('div', { className: 'dsh-mcp-tailor-note' }, actionError) : null,
    flashMsg ? h('div', { className: 'dsh-mcp-tailor-note' }, flashMsg) : null,
    h('div', { className: 'dsh-mcp-tailor-table' },
      h('div', { className: 'dsh-mcp-tailor-row head' },
        h('span', null, '工具'), h('span', { className: 't-num' }, '调用'), h('span', { className: 't-num' }, '错误'),
        h('span', { className: 't-num' }, '错误率'), h('span', { className: 't-tax' }, 'Schema 税'), h('span', null, '最后使用 / 操作'),
      ),
      shown.length === 0
        ? h('div', { className: 'dsh-mcp-tailor-empty' }, onlyDead && report ? `窗口内没有零调用的工具（共 ${fmtInt(report.toolCount)} 个工具都有调用）` : '暂无数据')
        : shown.map((tool) => {
            const actionable = tool.kind === 'mcp' && tool.server;
            const isDead = tool.calls === 0;
            const errRate = tool.errorRate || 0;
            return h('div', { key: tool.name, className: 'dsh-mcp-tailor-row' + (isDead ? ' dead' : '') },
              h('span', { className: 't-name' },
                tool.server ? h('span', { className: 't-badge' }, tool.server) : null,
                tool.server ? tool.leaf : tool.name,
                tool.serverDisabled ? h('span', { className: 't-badge warn' }, '已禁用') : null,
                errRate >= 0.5 ? h('span', { className: 't-badge err' }, '高错误率') : null,
              ),
              h('span', { className: 't-num' }, fmtInt(tool.calls)),
              h('span', { className: 't-num' }, fmtInt(tool.errors)),
              h('span', { className: 't-num' }, fmtPct(errRate)),
              h('span', { className: 't-tax' }, fmtTax(tool.schemaTokens)),
              h('span', { className: 't-last' },
                fmtLast(tool.lastUsedMs, report ? report.generatedAt : undefined),
                actionable && !tool.serverDisabled
                  ? h('span', { className: 't-act' },
                      h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: busy, onClick: () => tailorAct('disable', tool.server, `已禁用 ${tool.server}`) }, '禁用服务器'),
                      ' ',
                      h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: busy, onClick: () => tailorAct('enable', tool.server, `已启用 ${tool.server}`) }, '启用'),
                    )
                  : null,
              ),
            );
          }),
    ),
    deadMcpActionable.length
      ? h('div', { className: 'dsh-mcp-tailor-note' },
          h('b', null, '裁缝建议：'),
          `${deadMcpActionable.length} 个 MCP 工具在 ${days} 天内零调用，合计每轮请求白缴 ~${fmtInt(report ? report.deadMcpTaxTokens : 0)} tok 上下文税。可到「MCP」页或在上方行内禁用对应服务器（随时可启用，禁用只作用于新请求）。`,
        )
      : null,
  );
};

const BOARD_CATEGORIES = [
  { key: 'mcp', label: 'MCP', icon: 'plug' },
  { key: 'skill', label: 'Skill', icon: 'skill' },
  { key: 'tailor', label: '工具裁缝', icon: 'scissors' },
  { key: 'wb', label: 'WB 市场', icon: 'store' },
];

// 宿主侧接口不存在（HTTP 404 / transport failure）几乎总是「宿主还没重启」：
// 客户端 bundle 从磁盘现读、改完刷新即生效，而宿主的 Remote 方法在启动时才注册。
// 这里把生硬的传输错误翻译成可操作的提示，而不是让用户对着 404 猜。
const skillTransportHint = (message) =>
  /404|transport failure/i.test(String(message))
    ? String(message) + '　——宿主还没注册 skill 接口：重启 DeepSeek Harness 让宿主侧生效后即可'
    : String(message);

// ── Skill 看板：列表 + 详情 ──────────────────────────────────────────
// 数据来自宿主新增的 listSkills / skillDetail（走同一个 mcpManager Remote 命名空间，
// 复用既有的 call 信封 {ok, ...}），不引入第二条 Remote 通道。
const SkillBoard = ({ call, scope, timer }) => {
  const [skills, setSkills] = useState([]);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const loadSeq = useRef(0);
  const detailSeq = useRef(0);

  const load = useCallback(async (notify = false) => {
    const seq = ++loadSeq.current;
    if (notify) setRefreshing(true);
    setLoading(true);
    try {
      const res = await call('listSkills', skillScopeArg(scope));
      if (seq !== loadSeq.current) return;
      if (res && res.ok) {
        setSkills(res.skills || []);
        setAvailable(res.available !== false);
        setError(res.available === false ? '宿主没有挂载 skill 注册表（@deepseek-ai/dsh-skill），本看板不可用' : '');
      } else {
        setAvailable(false);
        setError(skillTransportHint((res && res.error) || '读取 skill 列表失败'));
      }
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setAvailable(false);
      setError(skillTransportHint(String((e && e.message) || e)));
    } finally {
      if (seq === loadSeq.current) { setLoading(false); setRefreshing(false); }
    }
  }, [call, scope]);

  useEffect(() => {
    setSelected('');
    setDetail(null);
    setDetailError('');
    setQuery('');
    load(false);
  }, [load]);

  const queryKey = (query || '').toLowerCase();
  const filtered = queryKey
    ? skills.filter((s) => (s.name + ' ' + (s.description || '')).toLowerCase().includes(queryKey))
    : skills;
  // 按来源分组展示（与官方 skill 子系统的发现优先级同序），组内保持注册表返回的名字排序。
  const groups = useMemo(() => {
    const bySource = new Map();
    for (const s of filtered) {
      const key = s.source || 'unknown';
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key).push(s);
    }
    return [...bySource.entries()].map(([source, rows]) => ({ source, rows }));
  }, [filtered]);

  const openDetail = useCallback(async (name) => {
    setSelected(name);
    const seq = ++detailSeq.current;
    setDetail(null);
    setDetailError('');
    setDetailLoading(true);
    try {
      const res = await call('skillDetail', { ...skillScopeArg(scope), name });
      if (seq !== detailSeq.current) return;
      if (res && res.ok && res.skill) setDetail(res.skill);
      else setDetailError((res && res.error) || '读取 skill 内容失败');
    } catch (e) {
      if (seq !== detailSeq.current) return;
      setDetailError(String((e && e.message) || e));
    } finally {
      if (seq === detailSeq.current) setDetailLoading(false);
    }
  }, [call, scope]);

  const summary = selected ? skills.find((s) => s.name === selected) : null;

  return h('div', { className: 'dsh-mcp-skill-view' },
    error ? h('div', { className: 'dsh-mcp-d-err' }, error) : null,
    available && !error ? h('div', { className: 'dsh-mcp-skill-body' },
      h('div', { className: 'dsh-mcp-skill-side' },
        h('div', { className: 'dsh-mcp-search' },
          h(Icon, { d: ICONS.search }),
          h('input', { placeholder: '搜索 skill…', value: query, onChange: (e) => setQuery(e.target.value), 'aria-label': '搜索 skill' }),
        ),
        h('div', { className: 'dsh-mcp-item-sub' },
          h('span', null, (loading && !refreshing) ? '读取中…' : (skills.length + ' 个 skill')),
          refreshing ? h('span', null, ' · 刷新中…') : null,
        ),
        h('div', { className: 'dsh-mcp-skill-list', role: 'listbox', 'aria-label': 'skill 列表' },
          groups.length === 0 && !loading
            ? h('div', { className: 'dsh-mcp-skill-empty' }, '这个作用域下没有发现 skill。skill 由 skill-filesystem 从项目 .dsh/skills、用户 ~/.dsh/skills 等目录发现。')
            : groups.map((g) => h(React2.Fragment, { key: g.source },
                h('div', { className: 'dsh-mcp-item-sub', style: { marginTop: '6px' } },
                  h(Badge, { cls: 't-stdio' }, skillSourceLabel(g.source)),
                  h('span', null, g.rows.length + ' 个'),
                ),
                g.rows.map((s) => h('button', {
                  key: s.name,
                  type: 'button',
                  role: 'option',
                  'aria-selected': selected === s.name,
                  className: 'dsh-mcp-skill',
                  onClick: () => openDetail(s.name),
                },
                  h('div', { className: 'dsh-mcp-skill-main' },
                    h('div', { className: 'dsh-mcp-skill-name' }, s.name),
                    h('div', { className: 'dsh-mcp-skill-sub' },
                      s.modelInvocable ? h(Badge, { cls: 't-http' }, '模型可调用') : null,
                      s.userInvocable ? h(Badge, { cls: 't-stdio' }, '用户可调用') : null,
                      h('span', { className: 'dsh-mcp-skill-src' }, s.provider || ''),
                    ),
                    s.description ? h('div', { className: 'dsh-mcp-skill-desc' }, s.description) : null,
                  ),
                )),
              )),
        ),
      ),
      h('div', { className: 'dsh-mcp-skill-detail' },
        !summary && !detailLoading
          ? h('div', { className: 'dsh-mcp-skill-empty' }, '从左侧选择一个 skill 查看详情')
          : null,
        summary ? h('div', { className: 'dsh-mcp-skill-d-head' },
          h('div', null,
            h('h3', { className: 'dsh-mcp-skill-d-title' }, summary.name),
            h('p', { className: 'dsh-mcp-skill-d-sub' },
              skillSourceLabel(summary.source) + (summary.provider ? ' · ' + summary.provider : '')
                + (summary.path ? ' · ' + summary.path : '')),
          ),
          summary.path ? h('button', {
            type: 'button',
            className: 'dsh-mcp-skill-d-path',
            title: '把 skill 所在目录交给宿主在资源管理器中打开（只读定位）',
            onClick: () => { call('revealSkill', { path: summary.path }); },
          }, h(Icon, { d: ICONS.folder }), '打开目录') : null,
        ) : null,
        summary ? h('div', { className: 'dsh-mcp-skill-d-body' },
          h('div', { className: 'dsh-mcp-skill-d-sec' },
            h('b', null, '描述'),
            h('p', { className: 'dsh-mcp-skill-d-desc' }, summary.description || '（无描述）'),
          ),
          summary.whenToUse ? h('div', { className: 'dsh-mcp-skill-d-sec' },
            h('b', null, '何时使用'),
            h('p', { className: 'dsh-mcp-skill-d-desc' }, summary.whenToUse),
          ) : null,
          h('div', { className: 'dsh-mcp-skill-d-sec' },
            h('b', null, '调用策略'),
            h('p', { className: 'dsh-mcp-skill-d-desc' },
              '模型可调用：' + (summary.modelInvocable ? '是' : '否')
              + '　用户可调用：' + (summary.userInvocable ? '是' : '否')),
          ),
          detailLoading ? h('div', { className: 'dsh-mcp-skill-empty' }, '读取 skill 内容…') : null,
          detailError ? h('div', { className: 'dsh-mcp-d-err' }, detailError) : null,
          detail && detail.content !== undefined ? h('div', { className: 'dsh-mcp-skill-d-sec' },
            h('b', null, '指令内容（' + detail.content.length + ' 字符）'),
            h('pre', { className: 'dsh-mcp-skill-d-md' }, detail.content),
          ) : null,
        ) : null,
      ),
    ) : null,
  );
};

// ── WorkBuddy 市场直连（看板分类之一）────────────────────────────────
// 两个市场一个面板：上半「连接器」（WorkBuddy 官方 ZIP，MCP 配置直接可装），下半「技能」
// （SkillHub 公开 API，逐文件 sha256 校验后装进 ~/.agents/skills）。数据与安装都走 Host 的
// wb* RPC（浏览器不直连腾讯/SkillHub），失败文案保留 Host 给出的原因。
// 已安装标记：技能按 wbSkillInstalled 的目录记录——只在进入面板时取一次，装/卸后局部刷新。
const WB_MARKET_CONNECTOR_PAGE_SIZE = 60;
const WB_SKILLHUB_SORTS = [
  { key: 'downloads', label: '最多下载' },
  { key: 'installs', label: '最多安装' },
  { key: 'stars', label: '最多星标' },
  { key: 'score', label: '综合评分' },
];
const wbFormatCount = (value) => {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'k';
  return String(n);
};
const wbFormatDate = (ms) => {
  if (!ms) return '';
  try { return new Date(Number(ms)).toISOString().slice(0, 10); } catch { return ''; }
};
const WorkBuddyMarket = ({ call }) => {
  // ── 共享状态 ──
  const [tab, setTab] = useState('connector');       // connector | skill
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [note, setNote] = useState('');
  // ── 连接器 ──
  const [connectorSource, setConnectorSource] = useState('');
  const [connectors, setConnectors] = useState([]);
  const [connectorQuery, setConnectorQuery] = useState('');
  const [connectorOnlyReady, setConnectorOnlyReady] = useState(false);
  const [connectorPage, setConnectorPage] = useState(1);
  const [connectorDetail, setConnectorDetail] = useState(null);
  // ── 技能 ──
  const [skillPage, setSkillPage] = useState(1);
  const [skillSort, setSkillSort] = useState('downloads');
  const [skillKeyword, setSkillKeyword] = useState('');
  const [skillKeywordInput, setSkillKeywordInput] = useState('');
  const [skills, setSkills] = useState([]);
  const [skillTotal, setSkillTotal] = useState(0);
  const [skillDetail, setSkillDetail] = useState(null);
  const [installedSkills, setInstalledSkills] = useState(new Set());
  const WB_PAGE_SIZE = 20;

  const loadInstalled = useCallback(async () => {
    const res = await call('wbSkillInstalled');
    if (res?.ok) setInstalledSkills(new Set((res.installed || []).map((row) => row.slug)));
  }, [call]);

  const loadConnectors = useCallback(async () => {
    setLoading(true); setError(''); setNote('');
    try {
      const res = await call('wbConnectorCatalog');
      if (!res?.ok) throw new Error(res?.error || '读取连接器目录失败');
      setConnectors(res.connectors || []);
      setConnectorSource(res.loadedFrom || '');
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [call]);

  const loadSkills = useCallback(async (page, sort, keyword) => {
    setLoading(true); setError(''); setNote('');
    try {
      const res = await call('wbSkillCatalog', { page, sort, keyword, pageSize: WB_PAGE_SIZE });
      if (!res?.ok) throw new Error(res?.error || '读取技能目录失败');
      setSkills(res.skills || []);
      setSkillTotal(res.total || 0);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => {
    loadConnectors();
    loadInstalled();
  }, [loadConnectors, loadInstalled]);
  useEffect(() => {
    loadSkills(skillPage, skillSort, skillKeyword);
  }, [loadSkills, skillPage, skillSort, skillKeyword]);

  // ── 连接器：过滤 / 分页 ──
  const connectorQueryKey = connectorQuery.trim().toLowerCase();
  const filteredConnectors = connectors.filter((item) => {
    if (connectorOnlyReady && !item.installable) return false;
    if (!connectorQueryKey) return true;
    return [item.name, item.nameEn, item.id, item.description].filter(Boolean).join(' ').toLowerCase().includes(connectorQueryKey);
  });
  const connectorPageCount = Math.max(1, Math.ceil(filteredConnectors.length / WB_MARKET_CONNECTOR_PAGE_SIZE));
  const safeConnectorPage = Math.min(connectorPage, connectorPageCount);
  const visibleConnectors = filteredConnectors.slice((safeConnectorPage - 1) * WB_MARKET_CONNECTOR_PAGE_SIZE, safeConnectorPage * WB_MARKET_CONNECTOR_PAGE_SIZE);

  const openConnectorDetail = async (item) => {
    setConnectorDetail(item);
    setNote('');
  };
  const installConnector = async (item) => {
    setBusy(true); setBusyLabel(`正在安装 ${item.name}…`); setError('');
    try {
      const res = await call('wbConnectorInstall', { connectorId: item.id, mode: 'merge' });
      if (!res?.ok) throw new Error(res?.error || '安装失败');
      setNote(`${item.name}：${res.note || '已写入 MCP 配置'}`);
      setConnectorDetail(null);
      await loadConnectors();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false); setBusyLabel('');
    }
  };
  const installSkill = async (skill) => {
    setBusy(true); setBusyLabel(`正在下载并校验 ${skill.name}…`); setError('');
    try {
      const res = await call('wbSkillInstall', { slug: skill.slug, namespace: skill.namespace, name: skill.name });
      if (!res?.ok) throw new Error(res?.error || '安装失败');
      setNote(`${skill.name}：${res.note || '已安装'}`);
      setSkillDetail(null);
      await loadInstalled();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false); setBusyLabel('');
    }
  };
  const uninstallSkill = async (skill) => {
    setBusy(true); setBusyLabel(`正在卸载 ${skill.name}…`); setError('');
    try {
      const res = await call('wbSkillUninstall', { slug: skill.slug, namespace: skill.namespace });
      if (!res?.ok) throw new Error(res?.error || '卸载失败');
      setNote(`${skill.name}：${res.note || '已卸载'}`);
      setSkillDetail(null);
      await loadInstalled();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false); setBusyLabel('');
    }
  };
  const openSkillDetail = async (skill) => {
    setSkillDetail({ ...skill, loading: true });
    setNote('');
    try {
      const res = await call('wbSkillDetail', { slug: skill.slug, namespace: skill.namespace });
      if (!res?.ok) throw new Error(res?.error || '读取详情失败');
      setSkillDetail({ ...skill, ...res, loading: false });
    } catch (e) {
      setSkillDetail({ ...skill, loading: false, detailError: String(e?.message || e) });
    }
  };

  const connectorSearch = h('input', {
    type: 'search', className: 'dsh-mcp-input', placeholder: '搜索连接器（名称 / 说明 / ID）',
    value: connectorQuery, disabled: loading,
    onChange: (e) => { setConnectorQuery(e.target.value); setConnectorPage(1); },
  });
  const skillSearch = h('form', {
    className: 'dsh-mcp-wb-search-row', onSubmit: (e) => { e.preventDefault(); setSkillPage(1); setSkillKeyword(skillKeywordInput); },
  },
    h('input', {
      type: 'search', className: 'dsh-mcp-input', placeholder: '搜索 SkillHub 技能（19 万+）',
      value: skillKeywordInput, disabled: loading,
      onChange: (e) => setSkillKeywordInput(e.target.value),
    }),
    h(Btn, { type: 'submit', icon: 'search', disabled: loading, children: '搜索' }),
  );

  const skillPageCount = Math.max(1, Math.ceil(skillTotal / WB_PAGE_SIZE));
  const skillMeta = skillTotal
    ? `第 ${skillPage} / ${skillPageCount} 页 · 共 ${wbFormatCount(skillTotal)} 个技能`
    : '';

  return h('div', { className: 'dsh-mcp-wb' },
    h('div', { className: 'dsh-mcp-wb-tabs', role: 'tablist', 'aria-label': 'WorkBuddy 市场' },
      h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'connector', className: 'dsh-mcp-wb-tab' + (tab === 'connector' ? ' sel' : ''), onClick: () => setTab('connector') },
        '连接器（MCP）', h('span', { className: 'dsh-mcp-cat-count' }, connectors.length)),
      h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'skill', className: 'dsh-mcp-wb-tab' + (tab === 'skill' ? ' sel' : ''), onClick: () => setTab('skill') },
        '技能（SkillHub）'),
    ),
    h('div', { className: 'dsh-mcp-wb-disclaim' },
      '直连读取：连接器来自 WorkBuddy 官方分发（static.workbuddy.cn），技能来自 SkillHub 公开 API。本面板只是浏览与安装入口，' +
      '技能版权归原作者所有；第三方接口的字段可能随上游改版变化。'),
    tab === 'connector'
      ? h('div', { className: 'dsh-mcp-wb-toolbar' },
          connectorSearch,
          h('label', { className: 'dsh-mcp-check' },
            h('input', { type: 'checkbox', checked: connectorOnlyReady, disabled: loading, onChange: (e) => { setConnectorOnlyReady(e.target.checked); setConnectorPage(1); } }),
            '只看可直接安装'),
          h('span', { className: 'dsh-mcp-builtin-count' },
            `显示 ${visibleConnectors.length} / ${filteredConnectors.length}${connectorSource === 'network' ? ' · 已更新' : connectorSource === 'disk' ? ' · 缓存' : ''}`),
        )
      : h('div', { className: 'dsh-mcp-wb-toolbar' },
          skillSearch,
          h('select', {
            className: 'dsh-mcp-input dsh-mcp-wb-sort', value: skillSort, disabled: loading,
            onChange: (e) => { setSkillSort(e.target.value); setSkillPage(1); },
          }, WB_SKILLHUB_SORTS.map((option) => h('option', { key: option.key, value: option.key }, option.label))),
          h('span', { className: 'dsh-mcp-builtin-count' }, skillMeta),
        ),
    note ? h('div', { className: 'dsh-mcp-wb-note', role: 'status' }, note) : null,
    busyLabel ? h('div', { className: 'dsh-mcp-wb-note busy', 'aria-live': 'polite' }, busyLabel) : null,
    error ? h('div', { className: 'dsh-mcp-wb-error', role: 'alert' }, error) : null,
    loading && !connectors.length && tab === 'connector' ? h('div', { className: 'dsh-mcp-wb-empty' }, '正在读取连接器目录…') : null,
    loading && !skills.length && tab === 'skill' ? h('div', { className: 'dsh-mcp-wb-empty' }, '正在读取技能目录…') : null,
    !loading && tab === 'connector' && !visibleConnectors.length ? h('div', { className: 'dsh-mcp-wb-empty' }, '没有匹配的连接器，换个关键词试试') : null,
    !loading && tab === 'skill' && !skills.length ? h('div', { className: 'dsh-mcp-wb-empty' }, '没有匹配的技能') : null,
    tab === 'connector' && visibleConnectors.length
      ? h('div', { className: 'dsh-mcp-wb-grid' },
          visibleConnectors.map((item) => h('div', { key: item.id, className: 'dsh-mcp-card wb' + (item.installable ? '' : ' off') },
            h('div', { className: 'dsh-mcp-card-top' },
              h('div', null, h('div', { className: 'dsh-mcp-card-name' }, item.name)),
              h(Badge, { cls: item.installable ? 's-on' : '' }, item.installable ? '可安装' : '仅展示'),
            ),
            h('div', { className: 'dsh-mcp-card-summary' }, item.description || item.nameEn || item.id),
            h('div', { className: 'dsh-mcp-card-tags' },
              item.skillCount ? h(Badge, null, `含 ${item.skillCount} 技能`) : null,
              item.transport ? h(Badge, { cls: item.transport === 'streamable-http' ? 't-http' : 't-stdio' }, item.transport === 'streamable-http' ? 'HTTP' : 'stdio') : null,
              item.authMode ? h(Badge, null, item.authMode) : null,
            ),
            h('div', { className: 'dsh-mcp-wb-card-actions' },
              h('button', { type: 'button', className: 'dsh-mcp-btn', onClick: () => openConnectorDetail(item) }, '详情'),
              item.installable
                ? h('button', { type: 'button', className: 'dsh-mcp-btn primary', disabled: busy, onClick: () => installConnector(item) }, '安装')
                : h('span', { className: 'dsh-mcp-wb-blocked', title: item.blockedReason }, item.blockedReason ? '不兼容：' + item.blockedReason : ''),
            ),
          )),
        )
      : null,
    tab === 'connector' && connectorPageCount > 1
      ? h('div', { className: 'dsh-mcp-wb-pager' },
          h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: safeConnectorPage <= 1, onClick: () => setConnectorPage(safeConnectorPage - 1) }, '上一页'),
          h('span', { className: 'dsh-mcp-builtin-count' }, `${safeConnectorPage} / ${connectorPageCount}`),
          h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: safeConnectorPage >= connectorPageCount, onClick: () => setConnectorPage(safeConnectorPage + 1) }, '下一页'),
        )
      : null,
    tab === 'skill' && skills.length
      ? h('div', { className: 'dsh-mcp-wb-grid' },
          skills.map((skill) => {
            const installed = installedSkills.has(skill.slug);
            return h('div', { key: skill.namespace + '/' + skill.slug, className: 'dsh-mcp-card wb' },
              h('div', { className: 'dsh-mcp-card-top' },
                h('div', null,
                  h('div', { className: 'dsh-mcp-card-name' }, skill.name),
                  h('div', { className: 'dsh-mcp-card-vendor' }, skill.canonical || skill.namespace),
                ),
                installed ? h(Badge, { cls: 's-on' }, '已安装') : null,
              ),
              h('div', { className: 'dsh-mcp-card-summary' }, skill.description || skill.name),
              h('div', { className: 'dsh-mcp-card-tags' },
                h(Badge, null, `↓${wbFormatCount(skill.downloads)}`),
                skill.installs ? h(Badge, null, `装 ${wbFormatCount(skill.installs)}`) : null,
                skill.stars ? h(Badge, null, `★${wbFormatCount(skill.stars)}`) : null,
                skill.verified ? h(Badge, { cls: 's-on' }, '认证') : null,
                skill.version ? h(Badge, null, 'v' + skill.version) : null,
                wbFormatDate(skill.updatedAt) ? h(Badge, null, wbFormatDate(skill.updatedAt)) : null,
              ),
              h('div', { className: 'dsh-mcp-wb-card-actions' },
                h('button', { type: 'button', className: 'dsh-mcp-btn', onClick: () => openSkillDetail(skill) }, '详情'),
                installed
                  ? h('button', { type: 'button', className: 'dsh-mcp-btn danger', disabled: busy, onClick: () => uninstallSkill(skill) }, '卸载')
                  : h('button', { type: 'button', className: 'dsh-mcp-btn primary', disabled: busy, onClick: () => installSkill(skill) }, '安装'),
              ),
            );
          }),
        )
      : null,
    tab === 'skill' && skillPageCount > 1
      ? h('div', { className: 'dsh-mcp-wb-pager' },
          h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: skillPage <= 1 || loading, onClick: () => setSkillPage(skillPage - 1) }, '上一页'),
          h('span', { className: 'dsh-mcp-builtin-count' }, `${skillPage} / ${skillPageCount}`),
          h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: skillPage >= skillPageCount || loading, onClick: () => setSkillPage(skillPage + 1) }, '下一页'),
        )
      : null,
    // ── 连接器详情弹层：安装前看真实 mcp.json ──
    connectorDetail
      ? h('div', { className: 'dsh-mcp-overlay', onClick: (e) => !busy && e.target === e.currentTarget && setConnectorDetail(null) },
          h('div', { className: 'dsh-mcp-modal dsh-mcp-wb-modal', role: 'dialog', 'aria-modal': true, 'aria-label': '连接器详情', tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); setConnectorDetail(null); } } },
            h('h3', null, connectorDetail.name),
            connectorDetail.description ? h('p', { className: 'dsh-mcp-wb-modal-desc' }, connectorDetail.description) : null,
            connectorDetail.examples && connectorDetail.examples.length
              ? h('div', { className: 'dsh-mcp-wb-examples' },
                  h('b', null, '用法示例'),
                  h('ul', null, connectorDetail.examples.slice(0, 4).map((example, index) => h('li', { key: index }, example))),
                )
              : null,
            h('p', { className: 'dsh-mcp-wb-modal-note' },
              `安装 = 把该连接器的 mcpServers 合并写入当前作用域（与「导入 JSON」同一链路，同名跳过）。` +
              (connectorDetail.skillCount ? `另含 ${connectorDetail.skillCount} 个连接器技能，如需请从技能市场或手动安装。` : '')),
            h('div', { className: 'dsh-mcp-modal-actions' },
              h(Btn, { onClick: () => setConnectorDetail(null), disabled: busy, children: '取消' }),
              connectorDetail.installable
                ? h(Btn, { primary: true, icon: 'plus', disabled: busy, onClick: () => installConnector(connectorDetail), children: busy ? '安装中…' : '安装到全局' })
                : h('span', { className: 'dsh-mcp-wb-blocked' }, connectorDetail.blockedReason || '不可安装'),
            ),
          ),
        )
      : null,
    // ── 技能详情弹层：安全报告 + 发布方 + 安装/卸载 ──
    skillDetail
      ? h('div', { className: 'dsh-mcp-overlay', onClick: (e) => !busy && e.target === e.currentTarget && setSkillDetail(null) },
          h('div', { className: 'dsh-mcp-modal dsh-mcp-wb-modal', role: 'dialog', 'aria-modal': true, 'aria-label': '技能详情', tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); setSkillDetail(null); } } },
            h('h3', null, skillDetail.name),
            h('div', { className: 'dsh-mcp-card-vendor' }, skillDetail.canonical || skillDetail.namespace || ''),
            skillDetail.loading
              ? h('p', { className: 'dsh-mcp-wb-modal-note' }, '正在读取详情…')
              : h('div', null,
                  skillDetail.detailError ? h('p', { className: 'dsh-mcp-wb-error' }, skillDetail.detailError) : null,
                  skillDetail.description ? h('p', { className: 'dsh-mcp-wb-modal-desc' }, skillDetail.description) : null,
                  h('div', { className: 'dsh-mcp-card-tags' },
                    skillDetail.version ? h(Badge, null, 'v' + skillDetail.version) : null,
                    skillDetail.publisher ? h(Badge, null, skillDetail.publisher + (skillDetail.verifiedPublisher ? '（已认证）' : '')) : null,
                    skillDetail.certifiedName ? h(Badge, { cls: 's-on' }, skillDetail.certifiedName) : null,
                    Array.isArray(skillDetail.security) ? skillDetail.security.map((status, index) => h(Badge, { key: index, cls: status === 'benign' ? 's-on' : '' }, '安全: ' + status)) : null,
                  ),
                  skillDetail.changelog ? h('p', { className: 'dsh-mcp-wb-modal-note' }, '最新版本说明：' + skillDetail.changelog) : null,
                  h('p', { className: 'dsh-mcp-wb-modal-note' },
                    '安装 = 逐文件下载并 sha256 校验后写入 ~/.agents/skills/，即刻被 DSH 发现（无需重启）。已装版本重装即更新。'),
                ),
            h('div', { className: 'dsh-mcp-modal-actions' },
              h(Btn, { onClick: () => setSkillDetail(null), disabled: busy, children: '关闭' }),
              installedSkills.has(skillDetail.slug)
                ? h(Btn, { danger: true, icon: 'trash', disabled: busy, onClick: () => uninstallSkill(skillDetail), children: '卸载' })
                : h(Btn, { primary: true, icon: 'plus', disabled: busy || skillDetail.loading, onClick: () => installSkill(skillDetail), children: busy ? '安装中…' : '安装' }),
            ),
          ),
        )
      : null,
  );
};


// 入口偏好的开关就放在面板头部：它必须能从面板里改回来（关掉一个入口后用户还在面板里），
// 而面板本身只有这两个入口能打开——所以这个控件不能藏得更深。低频操作，用图标按钮 + 弹层，
// 不占 Tab（作用域 tab 讲的是「管哪一份配置」，与显示偏好无关）。
const EntryMenu = () => {
  const mode = useEntryMode();
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!boxRef.current || !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);
  return h(
    'div',
    { className: 'dsh-mcp-entry', ref: boxRef },
    h(Btn, {
      icon: 'entry',
      title: '入口显示：' + ENTRY_LABELS[mode],
      onClick: (e) => { e.stopPropagation(); setOpen((value) => !value); },
      children: '入口',
    }),
    // 行用原生 <button> 而不是 div[role=menuitemradio]：menu 语义要求方向键 / Home / Esc /
    // roving tabindex 一整套键盘行为，不实现就等于这个设置对键盘用户不存在，还多了一句假声明。
    // 原生按钮免费给到 Tab 与 Enter/Space，状态用 aria-pressed 表达（与面板里那个眼睛开关同一个惯用法）。
    open ? h('div', { className: 'dsh-mcp-tab-pop dsh-mcp-entry-pop' },
      ENTRY_MODES.map((value) =>
        h('button', {
          key: value,
          type: 'button',
          'aria-pressed': mode === value,
          className: 'dsh-mcp-entry-item' + (mode === value ? ' sel' : ''),
          onClick: () => { entryMode.set(value); setOpen(false); },
        }, ENTRY_LABELS[value]),
      ),
    ) : null,
  );
};

// 左侧栏底部入口（sidebar.footer.action，DSH 0.1.5 起提供）：官方标准的发现入口。
// 点击打开的是同一个浮层面板——不切换主面板、不打断正在进行的会话。
const McpFooterAction = ({ wide }) => {
  const mode = useEntryMode();
  // 「仅悬浮按钮」模式：返回 null 就够了，不需要注销注册。list 型 slot 的每个条目直接渲染
  // 进侧栏的 .footerActions（display:flex、无 gap/padding），外层 outlet 锚点又是
  // display:contents，所以空子树不占任何布局、也不留空行。
  if (!ENTRY_VISIBILITY[mode].sidebar) return null;
  return h(
    'button',
    {
      type: 'button',
      className: 'dsh-mcp-footer-action' + (wide ? '' : ' rail'),
      title: '技能与 MCP 看板',
      'aria-label': '打开技能与 MCP 看板',
      onClick: () => openBoardPanel(),
    },
    h(Icon, { d: ICONS.plug, size: wide ? 16 : 18 }),
    wide ? h('span', { className: 'dsh-mcp-footer-name' }, 'MCP') : null,
  );
};

// 全局面板行（sidebar.panellist）：宿主把每个注册项渲染成侧栏顶部「全局面板」里的一行
// （"插件"就是同一条机制，order 0；定时任务 order 10）。本组件只画行内的图形，
// 行的选中态与点击行为（ctx.layout.selectPanel(PANEL_ID) → 中栏切换）由宿主承担，
// 这正是「点击即可直接切换页面」的来源——与切换对话完全同构。
// 注意不能渲染 null：面板行的 label 来自注册 options 而不是本组件，渲染 null 只会
// 留下一个空白可点的行；不需要这个入口时由 apply() 注销注册。
const McpPanelIcon = ({ size, active }) =>
  h(Icon, { d: ICONS.board, size: size || 18, className: active ? 'dsh-mcp-panel-icon active' : 'dsh-mcp-panel-icon' });

// apply() 存放共享对象的地方：openBoardPanel 要从这里拿 ctx → layout。
// 组件拿不到 ctx（props 只来自 slot 的 inject），而 layout 又可能晚于本插件可用，
// 所以存 ctx 引用、用时再取。
const MODULE_CTX = { ctx: null };

// 打开看板页：切主面板，而不是弹层。当前已在本页时再点一次回到对话（与「切换」语义一致，
// 也给「关掉所有侧栏入口、只留悬浮按钮」的用户一个回到对话的路）。
// 取不到 layout 时静默放弃：入口没响应比抛错好——通常意味着宿主还没把 ui-layout 装好。
function openBoardPanel() {
  const ctx = MODULE_CTX.ctx;
  const layout = ctx && typeof ctx.get === 'function' ? ctx.get('layout') : null;
  if (!layout || typeof layout.selectPanel !== 'function') return;
  const active = layout.panelInfo && layout.panelInfo.getSnapshot ? layout.panelInfo.getSnapshot().activePanelId : undefined;
  layout.selectPanel(active === PANEL_ID ? null : PANEL_ID);
}

// 看板页（main slot，key = PANEL_ID）：宿主中栏按 entryKey 渲染同 key 的条目。
// 组件复用既有的 McpTab——它本来就支持非浮层渲染（floating=false 时直接返回 inner），
// 全部 MCP 能力（列表/详情/编辑/导入/市场/升级/更新提示）因此原样保留，只是换了宿主位置。
const McpBoardPage = (props) => {
  const { call, timer, pluginManager } = props;
  const [category, setCategory] = useState('mcp');
  // 顶层分类计数：Skill 条数单独取，避免两条加载互相等待。
  const [skillCount, setSkillCount] = useState(null);
  // 工具裁缝计数：只在用户切到该分类时拉一次，避免打开页面就扫日志。
  const [tailorCount, setTailorCount] = useState(null);
  useEffect(() => {
    if (category !== 'mcp') return;
    let alive = true;
    call('listSkills', skillScopeArg('global')).then((res) => {
      if (alive && res && res.ok) setSkillCount(Array.isArray(res.skills) ? res.skills.length : null);
    }).catch(() => {});
    return () => { alive = false; };
  }, [call, category]);
  useEffect(() => {
    if (category !== 'tailor' || tailorCount !== null) return;
    let alive = true;
    call('toolTailor', { days: 30 }).then((res) => {
      if (alive && res && res.ok && typeof res.deadMcpCount === 'number') setTailorCount(res.deadMcpCount);
    }).catch(() => {});
    return () => { alive = false; };
  }, [call, category, tailorCount]);

  return h('div', { className: 'dsh-mcp-page' },
    h('div', { className: 'dsh-mcp-wrap' },
      h('div', { className: 'dsh-mcp-cats', role: 'tablist', 'aria-label': '看板分类' },
        BOARD_CATEGORIES.map((cat) =>
          h('button', {
            key: cat.key,
            type: 'button',
            role: 'tab',
            'aria-pressed': category === cat.key,
            'aria-selected': category === cat.key,
            className: 'dsh-mcp-cat',
            title: cat.key === 'mcp' ? 'MCP 服务器（原有全部能力）' : cat.key === 'skill' ? 'Skill 看板（新增）' : cat.key === 'tailor' ? '工具裁缝：工具使用账本 + 上下文税单 + 死工具清单' : 'WorkBuddy 市场直连：连接器 MCP + SkillHub 技能，浏览搜索一键安装',
            onClick: () => setCategory(cat.key),
          },
            h(Icon, { d: ICONS[cat.icon], size: 14 }),
            cat.label,
            cat.key === 'skill' && skillCount !== null ? h('span', { className: 'dsh-mcp-cat-count' }, skillCount) : null,
            cat.key === 'tailor' && tailorCount !== null ? h('span', { className: 'dsh-mcp-cat-count' }, tailorCount) : null,
          )),
      ),
      category === 'mcp'
        ? h(McpTab, { call, timer, pluginManager })
        : category === 'tailor'
          ? h(ToolTailor, { call, timer })
          : category === 'wb'
            ? h(WorkBuddyMarket, { call })
            : h(SkillBoard, { call, timer }),
    ),
  );
};

// ── 更新提示：升级后说一次「这次变了什么」────────────────────────────
// 为什么要有它：新能力只写在 README / release note 里，用户根本不会去找——面板头部的
// 「入口」开关就是这么被忽略掉的。所以升级后主动说一次，并指出它在哪。
// 内容真源在 lib/whats-new.js（宿主侧），这里只管「这次该不该说」：
//   - 记的是「上次确认过的版本」（与 updateHint 的 dismissed 同一个惯用法，确认才落盘）；
//   - 认得出上次那版 → 报它之后的全部（跨版本升级不漏）；
//   - 认不出（新装，或从还没有这个功能的版本升上来）→ 只报当前这一条。这两者从
//     localStorage 里分不辨，而后者正是要覆盖的人，所以偏向「说一次」，代价只是新装
//     用户看到一条本次更新。
const WHATS_NEW_SEEN_KEY = 'dsh-skill-mcp-board.whatsNew.seen';

// ── 一键升级：借官方 pluginManager，不自己 spawn 包管理器 ──────────────
// 为什么能这么做：`@deepseek-ai/dsh-plugin-manager` 随 dsh-base / dsh-web-app 提供
// （人人都有，不依赖任何第三方市场插件），它把 installBundle 挂进共享的 ctx.remote。
// 官方 UI 自己不做升级（它的安装对话框会先拦「该插件已安装。如需升级，请卸载后重新安装」），
// 但那个拦截发生在 inspect()（仅按包名判重），而 installBundle 自己**不调 inspect**——
// 所以覆盖安装是它的既定能力，官方只是没在 UI 上开放。
//
// 为什么值得做：升级 = 改用户机器上的安装，而覆盖安装由官方完成版本校验与失败还原
// （executePluginCommand 失败时 restoreFiles 会回滚 manifest/lockfile）。自己 spawn pnpm
// 就要把 Windows 的 .cmd 外壳、pnpm 9/10/11 差异、跨平台 PATH 全部重做一遍。
const UPGRADE_NAMESPACE = 'pluginManager';
const UPGRADE_METHOD = 'installBundle';
const UPGRADE_PACKAGE = 'dsh-skill-mcp-board';

/**
 * 这次升级能不能做、为什么不能——纯判定，便于单测。
 *
 * 三种「不能升」的来源各不相同，报给用户的话也必须不同：
 *   - 宿主没提供 pluginManager（老宿主 / 非 web 形态）→ 退回手动命令；
 *   - 插件不是 npm 装的（link:/file:/github:）→ 覆盖安装会把它换成 npm 包，不能做；
 *   - 当前版本不低于最新 → 无需升级。
 *
 * @param {object} input - 判定输入。
 * @param {object|null} input.service - 探测到的 pluginManager 命名空间（null = 宿主没提供）。
 * @param {object|null} input.hint - updateHint 的结果（current / latest / updateAvailable）。
 * @param {object|null} input.bundle - listBundles 里本插件那一行（source / installed / version）。
 * @returns {{supported: boolean, reason: string, spec: string|null, canRestart: boolean}} 判定结果。
 */
function upgradePlan({ service, hint, bundle }) {
  const hasMethod = !!service && typeof service[UPGRADE_METHOD] === 'function';
  if (!hasMethod) return { supported: false, reason: 'no-service', spec: null };
  if (!hint?.updateAvailable || !hint?.latest) return { supported: false, reason: 'up-to-date', spec: null };
  // 本地安装形态（link:/file:/github:/tarball）不归 installBundle 管：拿 npm spec 覆盖会把
  // 用户的本地开发链接换成 npm 包，那是破坏而不是升级。只认 registry 来源。
  const source = typeof bundle?.source === 'string' ? bundle.source : '';
  const isRegistry = source === '' || /^\d|^\^|^~|^latest$/.test(source);
  if (!isRegistry) return { supported: false, reason: 'not-npm', spec: null };
  return {
    supported: true,
    reason: 'ok',
    // 带 ^：与 profile 里已有的前缀风格一致（实测 pnpm 沿用原 spec 前缀，不会因这次调用
    // 把 `^1.4.2` 改成精确的 `1.4.2`，所以用户不会因此失去 `dsh plugin update` 的自动升级）。
    spec: `${UPGRADE_PACKAGE}@^${hint.latest}`,
    // 目标版本随判定一起带出来：升级完成后 updateHint 会被宿主刷成「已是最新」，
    // 那时就没有版本可显示了，必须在这里记住。
    version: hint.latest,
  };
}

/**
 * 升级失败时给用户看的话。
 *
 * 为什么不能只写「升级失败」：desktop 直接改当前 profile 且**没有自动回滚**（见
 * deepseek-harness 的 desktop-in-place-profile 决策），用户必须知道发生了什么、下一步做什么。
 * 这些码来自 plugin-manager 的 ManagementError.code，逐个给出可操作的解释。
 * @param {object|null} error - ChangeResult.error（{code, diagnostic?}）。
 * @param {number|null} exitCode - pnpm 退出码。
 * @returns {string} 中文说明。
 */
function upgradeFailureText(error, exitCode) {
  const code = error?.code;
  const known = {
    'incompatible-version': '新版本与当前 DSH 不兼容，未升级。',
    'not-bundle': '该包没有声明组合包，不能作为插件安装。',
    'invalid-spec': '版本号不合法，未升级。',
    'ambiguous-install': '无法确定要升级哪个包，未升级。',
    'unknown-plugin': '在 profile 里找不到这个插件，未升级。',
    'stop-profile': '宿主正在停止，未升级；请重启后再试。',
    'bundle-in-use': '该包正在被使用，未升级。',
    'stale-approval': '构建授权已过期，未升级；请重试。',
    'management-required': '当前 profile 由应用托管，不允许在这里改动。',
    'unaddressable': '这一项无法被单独改动（随 DSH 提供）。',
  };
  if (known[code]) return known[code];
  // 未知码不吞掉：把码和 pnpm 的退出码如实带出来，否则用户和我们都无从查起。
  const bits = [];
  if (code) bits.push('错误码 ' + code);
  if (typeof exitCode === 'number' && exitCode !== 0) bits.push('pnpm 退出码 ' + exitCode);
  return bits.length ? '升级失败（' + bits.join('，') + '）。' : '升级失败。';
}

function whatsNewFor(current, lastSeen, entries) {
  if (!current || !Array.isArray(entries) || entries.length === 0) return [];
  if (lastSeen === current) return [];
  const index = entries.findIndex((entry) => entry.version === lastSeen);
  return index >= 0 ? entries.slice(index + 1) : entries.filter((entry) => entry.version === current);
}

// 自带 RPC 与状态：面板只管「在这儿渲染一个」。它挂在面板里，就自然随面板挂载/卸载——
// 这正是「升级后第一次打开面板时弹一次」的触发点，不需要另外判开合。
const WhatsNewModal = ({ call }) => {
  const [notice, setNotice] = useState(null);
  const boxRef = useRef(null);
  const confirmRef = useRef(null);
  const bouncedRef = useRef(null);

  // 打开面板时问一次有没有「这次更新」要讲。RPC 失败 / 服务未连接时静默：与 updateHint
  // 同一条理由（纯增值信息，不允许影响面板可用性，也不该在控制台报错吓人）。
  useEffect(() => {
    let alive = true;
    call('whatsNew')
      .then((res) => {
        if (!alive || !res || !res.ok || !Array.isArray(res.entries)) return;
        let seen = null;
        try { seen = localStorage.getItem(WHATS_NEW_SEEN_KEY); } catch { /* 存储不可用：这次仍提示，只是下次还会提示 */ }
        const unseen = whatsNewFor(res.current, seen, res.entries);
        if (unseen.length) setNotice({ current: res.current, entries: unseen });
      })
      .catch(() => { /* 见上：提示失败不影响面板 */ });
    return () => { alive = false; };
  }, []);

  const dismiss = () => {
    try { if (notice?.current) localStorage.setItem(WHATS_NEW_SEEN_KEY, notice.current); } catch { /* 存储不可用：本次关闭有效，下次打开面板会再提示一次 */ }
    setNotice(null);
  };

  // 自己弹出来的东西，键盘可达性就是它自己的责任，而它比面板里那几个多一个坑：
  // 宿主应用会把焦点抢到自己的输入框，所以不能“延迟一点再 focus”——那是在赌对方的时序。
  // 这里用“焦点守卫”：任何落在弹框外的 focusin 都拉回来，同时记下对方本来想聚焦谁，
  // 关闭时还给它（不猜选择器，也不改应用的 DOM）。Esc 关闭；点击遮罩关闭已支持。
  // 依赖跟 notice 而不是空数组：没提示时不该装监听；也不跟 onClose，否则父组件每次重渲染
  // 都会把焦点反复抢回按钮。
  useEffect(() => {
    if (!notice) return undefined;
    confirmRef.current?.focus();
    const onFocusIn = (event) => {
      if (boxRef.current && !boxRef.current.contains(event.target)) {
        bouncedRef.current = event.target;
        confirmRef.current?.focus();
      }
    };
    // 捕获阶段 + stopPropagation：提示渲染在面板内部，而面板自己也有 Esc 处理器（关面板），
    // 不拦住的话按一次 Esc 会把面板和提示一起关掉。这样 Esc 只关最内一层，再按一次才关面板。
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      dismiss();
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKeyDown, true);
      const target = bouncedRef.current;
      // 尽力而为：对方可能在弹框期间重建了那个节点（实测过），那就让它留在插件自己的界面上，
      // 而不是去猜一个选择器把焦点塞回应用内部。
      if (target && document.contains(target) && typeof target.focus === 'function') target.focus();
    };
  }, [notice]);

  if (!notice) return null;
  return h(
    'div',
    { className: 'dsh-mcp-overlay', onClick: (e) => e.target === e.currentTarget && dismiss() },
    h(
      'div',
      { ref: boxRef, className: 'dsh-mcp-whatsnew', role: 'dialog', 'aria-modal': 'true', 'aria-label': '本次更新内容' },
      h('div', { className: 'dsh-mcp-whatsnew-head' },
        // 版本中性：首次打开（没有任何记录）与从旧版本升上来走的是同一个分支，
        // 写「更新到」会把前者的文案说错。
        h('b', null, 'v' + notice.current + ' 的更新'),
        h('span', null, '这些变化你可能想知道'),
      ),
      h('div', { className: 'dsh-mcp-whatsnew-body' },
        notice.entries.map((entry) =>
          h('div', { key: entry.version, className: 'dsh-mcp-whatsnew-entry' },
            // 一次跳多个版本时每条自带版本号；只报一条时标题里的版本号就够了。
            notice.entries.length > 1 ? h('div', { className: 'dsh-mcp-whatsnew-ver' }, 'v' + entry.version) : null,
            entry.items.map((item, position) =>
              h('div', { key: position, className: 'dsh-mcp-whatsnew-item' },
                h('span', { className: 'dsh-mcp-whatsnew-dot', 'aria-hidden': true }, '·'),
                h('span', null,
                  item.text,
                  item.where ? h('span', { className: 'dsh-mcp-whatsnew-where' }, item.where) : null,
                ),
              ),
            ),
          ),
        ),
      ),
      h('div', { className: 'dsh-mcp-whatsnew-foot' },
        h('button', { ref: confirmRef, type: 'button', className: 'dsh-mcp-btn primary', onClick: dismiss }, '知道了'),
      ),
    ),
  );
};

const McpOverlay = ({ call, timer, pluginManager }) => {
  const open = usePanelOpen();
  const mode = useEntryMode();
  const seats = overlaySeats(mode, open);
  const [pos, setPos] = useState(() => readFabPos() || defaultFabPos());
  const fabRef = useRef(null);
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);

  // 窗口尺寸变化时把按钮拉回可视区，避免记忆的位置因分辨率变化而出界。
  // 悬浮按钮被偏好关掉时不订阅：给一个看不见的按钮算位置只是白渲染。
  useEffect(() => {
    if (!ENTRY_VISIBILITY[mode].fab) return;
    const onResize = () => setPos((current) => clampFabPos(current.x, current.y));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [mode]);

  const handlePointerDown = (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    const el = fabRef.current;
    if (!el) return;
    // 起始位置取 state 的 left/top（而非 getBoundingClientRect），避免 :hover 的 scale
    // 微移左上角带来的几像素误差。
    dragRef.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: pos.x,
      startY: pos.y,
      live: { x: pos.x, y: pos.y },
      moved: false,
    };
    try { el.setPointerCapture(event.pointerId); } catch { /* 忽略不支持捕获的环境 */ }
  };
  const handlePointerMove = (event) => {
    const drag = dragRef.current;
    const el = fabRef.current;
    if (!drag || !el) return;
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    drag.live = clampFabPos(drag.startX + dx, drag.startY + dy);
    // 跟手：直接写 DOM，不触发 React 渲染；松手时才 setPos 提交。
    el.style.left = drag.live.x + 'px';
    el.style.top = drag.live.y + 'px';
    el.style.cursor = 'grabbing';
  };
  const handlePointerEnd = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (fabRef.current) fabRef.current.style.cursor = '';
    if (!drag) return;
    if (drag.moved) {
      // 拖动收尾：吞掉紧随其后的 click，避免「拖动后误打开面板」；提交位置 + 落盘。
      suppressClickRef.current = true;
      setTimeout(() => { suppressClickRef.current = false; }, 0);
      setPos(drag.live);
      saveFabPos(drag.live);
    }
  };
  const handleClick = () => {
    if (suppressClickRef.current) { suppressClickRef.current = false; return; }
    openBoardPanel();
  };

  const style = { left: pos.x + 'px', top: pos.y + 'px', right: 'auto', bottom: 'auto' };

  return h(
    React2.Fragment,
    null,
    seats.fab ? h(
      'button',
      {
        ref: fabRef,
        type: 'button',
        className: 'dsh-mcp-fab',
        title: '技能与 MCP 看板（可拖拽移动）',
        'aria-label': '打开技能与 MCP 看板',
        style,
        onClick: handleClick,
        onPointerDown: handlePointerDown,
        onPointerMove: handlePointerMove,
        onPointerUp: handlePointerEnd,
        onPointerCancel: handlePointerEnd,
      },
      h(Icon, { d: ICONS.board, size: 22 }),
    ) : null,
  );
};

function createTimer() {
  const timeouts = new Set();
  const intervals = new Set();
  return {
    timeout(fn, ms) {
      const id = setTimeout(() => {
        timeouts.delete(id);
        fn();
      }, ms);
      timeouts.add(id);
      return () => {
        clearTimeout(id);
        timeouts.delete(id);
      };
    },
    interval(fn, ms) {
      const id = setInterval(fn, ms);
      intervals.add(id);
      return () => {
        clearInterval(id);
        intervals.delete(id);
      };
    },
    dispose() {
      for (const id of timeouts) clearTimeout(id);
      for (const id of intervals) clearInterval(id);
      timeouts.clear();
      intervals.clear();
    },
  };
}

// strict codec 与 lib/typert.js 是同一份契约的两份产物：宿主 loader 校验 host 那份，
// typert-registry 的**浏览器半**校验这份，两边规则一致而两个渠道查不同的键——
//   0.1.5-rc.x（= 当时 latest/next，npx 默认装到的那条）查 `codec.schema.parse`；
//   0.1.6-alpha.2 起查 `typeof codec.create === 'function'` 并用它物化 schema。
// 所以两个键都写（少写一半就是「面板能加载、一调用就炸」或「加载即拒」）。
// 浏览器侧不需要 zod：宿主只要求 create() 返回带 parse 的 schema。两处必须一起改。
const ANY_VALUE_SCHEMA = { parse: (v) => v };
const STRING_SCHEMA = { parse: (v) => { if (typeof v !== 'string') throw new TypeError('Expected string'); return v; } };
function strictCodec(symbol, schema) {
  return { mode: 'strict', typeSymbol: 'dsh-skill-mcp-board/typert#' + symbol, schema: schema, create: () => schema };
}
function mcpCodec(m) { return strictCodec(m, ANY_VALUE_SCHEMA); }
function mcpParam(name, sym) { return { name: name, wire: name, source: 'json', codec: strictCodec(sym, sym === 'String' ? STRING_SCHEMA : ANY_VALUE_SCHEMA) }; }
const MCP_CONTRIBUTION = {
  package: 'dsh-skill-mcp-board',
  descriptors: [
    { id: 'dsh-skill-mcp-board#mcpManager/list', service: 'mcpManager', namespace: 'mcpManager', method: 'list', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('ListResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/status', service: 'mcpManager', namespace: 'mcpManager', method: 'status', invocation: { kind: 'direct' }, parameters: [mcpParam('name', 'String')], result: mcpCodec('StatusResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/enable', service: 'mcpManager', namespace: 'mcpManager', method: 'enable', invocation: { kind: 'direct' }, parameters: [mcpParam('name', 'String')], result: mcpCodec('NoteResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/disable', service: 'mcpManager', namespace: 'mcpManager', method: 'disable', invocation: { kind: 'direct' }, parameters: [mcpParam('name', 'String')], result: mcpCodec('NoteResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/reconnect', service: 'mcpManager', namespace: 'mcpManager', method: 'reconnect', invocation: { kind: 'direct' }, parameters: [mcpParam('name', 'String')], result: mcpCodec('NoteResult') },
    // tools 收 payload 而不是裸 name：项目 MCP 必须带 wsPath 才能精确定位（两个项目可能同名）。
    // 声明成标量 name 时，网关会把传入对象当成 args 映射展开并报 unexpected "wsPath"。
    { id: 'dsh-skill-mcp-board#mcpManager/tools', service: 'mcpManager', namespace: 'mcpManager', method: 'tools', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ToolsResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/builtins', service: 'mcpManager', namespace: 'mcpManager', method: 'builtins', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('BuiltinCatalogResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/installBuiltins', service: 'mcpManager', namespace: 'mcpManager', method: 'installBuiltins', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'BuiltinInstallPayload')], result: mcpCodec('BuiltinInstallResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/add', service: 'mcpManager', namespace: 'mcpManager', method: 'add', invocation: { kind: 'direct' }, parameters: [mcpParam('spec', 'Spec')], result: mcpCodec('NoteResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/update', service: 'mcpManager', namespace: 'mcpManager', method: 'update', invocation: { kind: 'direct' }, parameters: [mcpParam('spec', 'Spec')], result: mcpCodec('NoteResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/removeServer', service: 'mcpManager', namespace: 'mcpManager', method: 'removeServer', invocation: { kind: 'direct' }, parameters: [mcpParam('name', 'String')], result: mcpCodec('NoteResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/reveal', service: 'mcpManager', namespace: 'mcpManager', method: 'reveal', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('RevealResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/previewImport', service: 'mcpManager', namespace: 'mcpManager', method: 'previewImport', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportPreview') },
    { id: 'dsh-skill-mcp-board#mcpManager/importJson', service: 'mcpManager', namespace: 'mcpManager', method: 'importJson', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/scanImportSources', service: 'mcpManager', namespace: 'mcpManager', method: 'scanImportSources', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportSourcesResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/previewImportSource', service: 'mcpManager', namespace: 'mcpManager', method: 'previewImportSource', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportPreview') },
    { id: 'dsh-skill-mcp-board#mcpManager/importSource', service: 'mcpManager', namespace: 'mcpManager', method: 'importSource', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/listWorkspaces', service: 'mcpManager', namespace: 'mcpManager', method: 'listWorkspaces', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('WorkspaceListResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/getWorkspaceView', service: 'mcpManager', namespace: 'mcpManager', method: 'getWorkspaceView', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WorkspaceViewResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/addWorkspaceServer', service: 'mcpManager', namespace: 'mcpManager', method: 'addWorkspaceServer', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/updateWorkspaceServer', service: 'mcpManager', namespace: 'mcpManager', method: 'updateWorkspaceServer', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/removeWorkspaceServer', service: 'mcpManager', namespace: 'mcpManager', method: 'removeWorkspaceServer', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/setWorkspaceExclude', service: 'mcpManager', namespace: 'mcpManager', method: 'setWorkspaceExclude', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/installWorkspaceBuiltins', service: 'mcpManager', namespace: 'mcpManager', method: 'installWorkspaceBuiltins', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'BuiltinInstallPayload')], result: mcpCodec('BuiltinInstallResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/previewWorkspaceImport', service: 'mcpManager', namespace: 'mcpManager', method: 'previewWorkspaceImport', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportPreview') },
    { id: 'dsh-skill-mcp-board#mcpManager/importWorkspaceJson', service: 'mcpManager', namespace: 'mcpManager', method: 'importWorkspaceJson', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/revealWorkspaceServer', service: 'mcpManager', namespace: 'mcpManager', method: 'revealWorkspaceServer', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('RevealResult') },
    // 只读排障接口：面板暂未接线，契约先声明齐（Host 有、契约没有 = 客户端永远调不到）。
    { id: 'dsh-skill-mcp-board#mcpManager/projectConnections', service: 'mcpManager', namespace: 'mcpManager', method: 'projectConnections', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('ProjectConnectionsResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/reconnectWorkspaceServer', service: 'mcpManager', namespace: 'mcpManager', method: 'reconnectWorkspaceServer', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/updateHint', service: 'mcpManager', namespace: 'mcpManager', method: 'updateHint', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('UpdateHintResult') },
    // 「这次更新了什么」：数据在 lib/whats-new.js，宿主只转发，判定“该不该弹”在客户端。
    { id: 'dsh-skill-mcp-board#mcpManager/whatsNew', service: 'mcpManager', namespace: 'mcpManager', method: 'whatsNew', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('WhatsNewResult') },
    // ── Skill 看板：与 MCP 同一命名空间、同一信封（payload 进、{ok} 出）──
    { id: 'dsh-skill-mcp-board#mcpManager/listSkills', service: 'mcpManager', namespace: 'mcpManager', method: 'listSkills', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('SkillListResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/skillDetail', service: 'mcpManager', namespace: 'mcpManager', method: 'skillDetail', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('SkillDetailResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/revealSkill', service: 'mcpManager', namespace: 'mcpManager', method: 'revealSkill', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    // ── WorkBuddy 市场直连：连接器 MCP + SkillHub 技能（同一命名空间同一信封）──
    { id: 'dsh-skill-mcp-board#mcpManager/wbConnectorCatalog', service: 'mcpManager', namespace: 'mcpManager', method: 'wbConnectorCatalog', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('WbCatalogResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/wbConnectorPreview', service: 'mcpManager', namespace: 'mcpManager', method: 'wbConnectorPreview', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WbPreviewResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/wbConnectorInstall', service: 'mcpManager', namespace: 'mcpManager', method: 'wbConnectorInstall', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/wbSkillCatalog', service: 'mcpManager', namespace: 'mcpManager', method: 'wbSkillCatalog', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WbSkillListResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/wbSkillDetail', service: 'mcpManager', namespace: 'mcpManager', method: 'wbSkillDetail', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WbSkillDetailResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/wbSkillInstall', service: 'mcpManager', namespace: 'mcpManager', method: 'wbSkillInstall', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/wbSkillUninstall', service: 'mcpManager', namespace: 'mcpManager', method: 'wbSkillUninstall', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-skill-mcp-board#mcpManager/wbSkillInstalled', service: 'mcpManager', namespace: 'mcpManager', method: 'wbSkillInstalled', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('WbInstalledResult') }
  ].map((descriptor) => ({ ...descriptor, sourceLocation: { file: 'dsh-skill-mcp-board/lib/typert.js', line: 7, column: 1 } }))
};
async function apply(ctx) {
  const disposeMount = await ctx.remote.$mount(MCP_CONTRIBUTION);
  let disposeCss;
  let timer;
  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      try {
        timer?.dispose();
      } finally {
        try {
          disposeCss?.();
        } finally {
          await disposeMount();
        }
      }
    })();
    return cleanupPromise;
  };

  try {
    disposeCss = __injectCss(MCP_CSS);
    timer = createTimer();
    MODULE_CTX.ctx = ctx;
    const call = async (method, args) => {
      const svc = (typeof ctx.get === 'function' ? ctx.get('remote.mcpManager') : null) || null;
      if (!svc || typeof svc[method] !== 'function') return { ok: false, error: 'MCP 市场服务未连接（面板仍可用）' };
      const r = args === undefined || args === null ? await svc[method]() : await svc[method](args);
      if (r && r.ok) return { ok: true, ...((r.value && typeof r.value === 'object') ? r.value : {}) };
      if (r && !r.ok) return { ok: false, error: (r.error && (r.error.message || r.error.code)) || '调用失败' };
      return r;
    };
    // 一键升级要用官方 pluginManager，而它只在 apply 的 ctx 上取得到（面板组件拿不到 ctx——
    // 它的 props 来自 slot 的 inject）。所以在这里取好、随 inject 传进面板，与 call 同一手法；
    // 取不到就给 null，面板据此不显示按钮。
    const pluginManager = (typeof ctx.get === 'function' ? ctx.get('remote.' + UPGRADE_NAMESPACE) : null)
      || (ctx.remote && ctx.remote[UPGRADE_NAMESPACE])
      || null;
    // 看板页（main slot，key = PANEL_ID）：宿主中栏按 entryKey 渲染。用 inject 而不是
    // 直接 register：它声明感知，会等 ui-layout 把 main slot 声明出来（插件加载顺序不保证
    // 晚于布局）。
    ctx.slots.inject('main', () =>
      ctx.slots.register({ name: 'main', key: PANEL_ID, label: PANEL_LABEL, inject: () => ({ call, timer, pluginManager }) }, McpBoardPage),
    );
    // 左上角全局面板行（sidebar.panellist）：「插件」旁边，主入口。行点击由宿主承担——
    // layout.selectPanel(PANEL_ID) 要求 main slot 里存在同 key 条目，上面的注册保证了这点。
    // 面板行不能用「渲染 null」隐藏（label 来自注册 options，不来自组件），所以按偏好
    // 在这里注册/注销，偏好运行期变化时走同一个同步函数。
    let disposePanelEntry = null;
    const syncPanelEntry = () => {
      const want = ENTRY_VISIBILITY[entryMode.get()].panel;
      if (want && !disposePanelEntry) disposePanelEntry = ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: PANEL_LABEL }, McpPanelIcon,
      );
      if (!want && disposePanelEntry) { disposePanelEntry(); disposePanelEntry = null; }
    };
    ctx.slots.inject('sidebar.panellist', () => { syncPanelEntry(); });
    entryMode.subscribe(syncPanelEntry);
    // 右下角悬浮按钮：保留既有能力，点击同样切到看板页。
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({ name: 'shell.overlay', id: 'mcp-fab', order: 1000, label: PANEL_LABEL, inject: () => ({ call, timer, pluginManager }) }, McpOverlay),
    );
    // 左侧栏底部入口（sidebar.footer.action，0.1.5 起声明）：兼容入口，行为与面板行一致。
    // 用 inject 而不是直接 register：它声明感知，会等侧边栏把 slot 声明出来。
    ctx.slots.inject('sidebar.footer.action', () =>
      ctx.slots.register({ name: 'sidebar.footer.action', id: 'mcp-manager', order: 100, label: PANEL_LABEL }, McpFooterAction),
    );
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
const inject = ['slots', 'remote', 'typert', 'remote.pluginManager'];
exports.apply = apply;
exports.inject = inject;

		return module.exports;
	}
});
