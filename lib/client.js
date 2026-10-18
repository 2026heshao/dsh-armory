window.__ModuleLoader__.load({
	id: 'dsh-armory',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
// MCP 市场 UI browser bundle：右下角浮动按钮打开响应式管理面板。
var React = require('react');
var __injectCss = function(text) {
  if (typeof document === 'undefined') return () => {};
  var id = 'dsh-armory/mcp.css';
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
    tag.dataset.plugin = 'dsh-armory';
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

// ── OPT-11：i18n 骨架（gettext 模型，键 = 中文原文） ────────────────────────
// zh-CN 是源语言：字典为空时 t() 恒等返回原文，缺键永远不会让界面出现 key 名。
// 将来补 en-US：往 i18nMessages 合并 { '中文原文': 'English' } 即可，无需改调用点。
// 带插值的文案：t('{0} 个会话', [n]) —— {n} 占位符按 vars 数组下标替换；
// 翻译表里的目标语可自由重排占位符顺序。
// 约束（与 OPT-12 同源）：ModuleLoader 只注入宿主模块，client.js 不能相对导入
// 字典文件，所以消息表必须内联在本文件里。
const i18nMessages = {};
const setI18nMessages = (table) => { Object.assign(i18nMessages, table || {}); };
// 补 en-US 时把字典表直接写进下面这次调用的实参：{ '设置': 'Settings', ... }。
// 留一个空调用不是占位符——它是唯一的写入入口，也提醒后来者「新语言要改这里」。
setI18nMessages({
  // 例：'设置': 'Settings',
});
const t = (s, vars) => {
  let text = i18nMessages[s] || s;
  if (vars && vars.length) {
    text = text.replace(/\{(\d+)\}/g, (raw, index) => (index in vars ? vars[+index] : raw));
  }
  return text;
};

// ── 旧插件名 → 新插件名的 localStorage 键迁移 ──────────────────────────────
// 1.9.0 起本插件由 dsh-skill-mcp-board 更名为 dsh-armory（package.json 与
// cordis.patch.yml 的 id/name 同步改）。浏览器侧这几个键**不能跟着直接改名**：
// 老用户的入口偏好、悬浮按钮位置、「本版本内不再提示」的更新提示、以及
// whatsNew 的已读版本都会静默重置——表现成「我明明选过仅侧栏入口，怎么又变回
// 右下角按钮了」「这个更新提示我关过了怎么又弹」。所以键名换新，同时把旧键的值
// 搬过来、再删掉旧键。
//
// 每个键独立搬移，规则：
//   - 新键已有值 → 不动（用户已在新键上，别覆盖）；
//   - 新键没有、旧键有 → 搬到新键，删旧键；
//   - 两者都没有 → 什么都不做。
// 全程 try/catch：localStorage 在无痕 / 隐私模式 / 被策略禁用时 getItem 就会抛
// SecurityError，removeItem 也可能抛。迁移失败不致命——只是退回默认值，与
// 「存储不可用」的既有行为一致（readEntryMode / readFabPos 的 catch 同源）。
const KEY_PREFIX = 'dsh-armory';
const LEGACY_KEY_PREFIX = 'dsh-skill-mcp-board';
const LEGACY_KEY_SUFFIXES = ['/entry', '/fab-pos', '.updateHint.dismissed', '.whatsNew.seen'];
function migrateLegacyKeys(storage) {
  if (!storage) return;
  for (const suffix of LEGACY_KEY_SUFFIXES) {
    const legacy = LEGACY_KEY_PREFIX + suffix;
    const current = KEY_PREFIX + suffix;
    try {
      if (storage.getItem(current) !== null) continue;
      const value = storage.getItem(legacy);
      if (value === null) continue;
      storage.setItem(current, value);
      storage.removeItem(legacy);
    } catch { /* 单个键失败不影响其余键，也不影响面板可用性 */ }
  }
}
migrateLegacyKeys(typeof localStorage === 'undefined' ? null : localStorage);

// ── 样式表 MCP_CSS：主题令牌别名 + 全部面板规则（一次性注入 <style>）──────────────
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
.dsh-mcp-badge.s-warn{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-tertiary)}
.dsh-mcp-badge.clickable{cursor:pointer;user-select:none}
.dsh-mcp-badge.clickable:hover{border-color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dsh-mcp-badge.clickable:focus-visible{outline:2px solid var(--dsw-alias-state-warn-primary);outline-offset:1px}
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
/* ── 市场搜索框（WbSearchBox）：胶囊造型 + 内嵌放大镜 + 一键清空 ── */
.dsh-mcp-wb-search{position:relative;display:flex;align-items:center;flex:1 1 260px;min-width:200px;max-width:520px}
.dsh-mcp-wb-search-ico{position:absolute;left:11px;display:inline-flex;color:var(--mcp-mut);pointer-events:none;transition:color .15s}
.dsh-mcp-wb-search:focus-within .dsh-mcp-wb-search-ico{color:var(--mcp-accent)}
.dsh-mcp-wb-search-input{box-sizing:border-box;width:100%;min-width:0;padding:7px 32px 7px 33px!important;border:1px solid var(--mcp-line);border-radius:999px;background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:1.4;outline:none;transition:border-color .15s,box-shadow .15s,background .15s}
.dsh-mcp-wb-search-input::placeholder{color:var(--mcp-mut)}
.dsh-mcp-wb-search-input:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}
.dsh-mcp-wb-search-input:focus{border-color:var(--mcp-accent);background:var(--mcp-bg-2);box-shadow:0 0 0 3px color-mix(in srgb,var(--mcp-accent) 16%,transparent)}
.dsh-mcp-wb-search-input:disabled{opacity:.5;cursor:not-allowed}
.dsh-mcp-wb-search-input::-webkit-search-cancel-button{display:none}
.dsh-mcp-wb-search-clear{position:absolute;right:7px;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:0;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--mcp-mut);cursor:pointer;padding:0;transition:color .12s,background .12s}
.dsh-mcp-wb-search-clear:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-active)}
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
.dsh-mcp-wb-roster{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:5px}
.dsh-mcp-wb-roster li{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:12px;line-height:1.5;padding:5px 9px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-sm);background:var(--mcp-bg-2)}
.dsh-mcp-wb-roster b{font-weight:650;min-width:0;overflow-wrap:anywhere}
.dsh-mcp-wb-roster-role{font-size:11px;color:var(--dsw-alias-brand-text);flex:none}
.dsh-mcp-wb-roster-prof{font-size:11px;color:var(--mcp-mut);flex:none}
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
/* ── 输入框召唤菜单（conversation.input.right）────────────────────────
   工具行内的小图标按钮 + 三分类菜单 + 悬停子菜单。跟随宿主主题 token，
   浮层 z-index 走宿主层级（输入区自带 stacking context，950 与 overlay 系一致）。 */
.dsh-mcp-quick{position:relative;display:inline-flex;align-items:center;gap:5px}
.dsh-mcp-quick-chip{display:inline-flex;align-items:center;gap:5px;max-width:170px;padding:3px 8px;border:1px solid color-mix(in srgb,var(--mcp-accent) 30%,transparent);border-radius:999px;background:color-mix(in srgb,var(--mcp-accent) 10%,transparent);color:var(--dsw-alias-label-primary);font-size:11px;line-height:16px;animation:dshMcpMenuIn .12s ease-out}
.dsh-mcp-quick-chip-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--mcp-accent)}
.dsh-mcp-quick-chip-x{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;transition:background .12s,color .12s}
.dsh-mcp-quick-chip-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--mcp-err)}
.dsh-mcp-quick-chip-x:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:0}
.dsh-mcp-quick-trigger{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:none;border-radius:var(--mcp-r-sm);background:color-mix(in srgb,var(--mcp-accent) 12%,transparent);color:var(--mcp-accent);cursor:pointer;transition:background .15s,color .15s}
.dsh-mcp-quick-trigger:hover,.dsh-mcp-quick-trigger.sel{background:color-mix(in srgb,var(--mcp-accent) 20%,transparent);color:var(--mcp-accent)}
.dsh-mcp-quick-trigger:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:1px}
/* 主菜单：同样只做 opacity/transform 出场（6px 上浮），消除点击图标瞬间的
   「整块突现→重绘」残影。定位 position:fixed（由 JS 实测 trigger 视口坐标后
   内联写入）：absolute 锚定会让菜单变高时伸展祖先滚动容器，整个会话页跟着
   跳动；fixed 脱离滚动容器，菜单再高页面也零位移。left/top/bottom 全部内联。 */
.dsh-mcp-quick-menu{position:fixed;z-index:950;min-width:148px;padding:5px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-1);box-shadow:var(--dsw-elevation-overlay,0 8px 28px rgba(0,0,0,.14));transform-origin:left bottom;animation:dshMcpMenuIn .12s ease-out}
@keyframes dshMcpMenuIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
@media (prefers-reduced-motion: reduce){.dsh-mcp-quick-menu{animation:none}.dsh-mcp-quick-sub{animation:none}}
.dsh-mcp-quick-row{position:relative}
.dsh-mcp-quick-kind{display:flex;align-items:center;gap:7px;width:100%;height:30px;padding:0 9px;border:none;border-radius:var(--mcp-r-sm);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;cursor:pointer;transition:background .12s}
.dsh-mcp-quick-kind:hover,.dsh-mcp-quick-kind.sel{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-quick-kind:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:-1px}
.dsh-mcp-quick-count{margin-left:auto;color:var(--mcp-accent);font-size:11px;font-variant-numeric:tabular-nums}
.dsh-mcp-quick-arrow{margin-left:5px;color:var(--mcp-mut);font-size:11px}
/* 子菜单：与锚点行垂直居中（top:50% + translateY(-50%)），比顶对齐更贴近 WorkBuddy；
   出场动画只动 opacity/transform（动效克制），替代上一版「整块突现」的残影来源。
   面板本体 max-height 由「6 行列表 + 底部固定管理按钮」精确算出（6×28 + 5×2 padding
   + 30 按钮 + 4 间距 + 边框），列表自身滚动，管理按钮永远贴底可见。 */
.dsh-mcp-quick-sub{position:absolute;top:50%;left:calc(100% + 6px);z-index:951;display:flex;flex-direction:column;width:232px;max-height:min(216px,40vh);padding:5px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-1);box-shadow:var(--dsw-elevation-overlay,0 8px 28px rgba(0,0,0,.14));transform:translateY(-50%);transform-origin:left center;animation:dshMcpQuickIn .13s ease-out}
/* 可滚动列表：最多 6 行（6 × 28px），溢出即滚动；隐藏水平溢出防止拖宽面板 */
.dsh-mcp-quick-list{min-height:0;max-height:168px;overflow-y:auto;overflow-x:hidden;border-radius:var(--mcp-r-sm)}
/* 细滚动条（跟随主题 token，悬停加深；hover 之外 6px 宽半透明，几乎不占视觉） */
.dsh-mcp-quick-list{scrollbar-width:thin;scrollbar-color:color-mix(in srgb,var(--mcp-line) 90%,transparent) transparent}
.dsh-mcp-quick-list::-webkit-scrollbar{width:6px}
.dsh-mcp-quick-list::-webkit-scrollbar-track{background:transparent}
.dsh-mcp-quick-list::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--mcp-line) 90%,transparent);border-radius:3px}
.dsh-mcp-quick-list:hover::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 45%,transparent)}
.dsh-mcp-quick-list:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:-1px}
/* 视口下缘不够时 JS 加 flip：子菜单改为向锚点行上方展开 */
.dsh-mcp-quick-row.flip .dsh-mcp-quick-sub{top:auto;bottom:50%;transform:translateY(50%)}
.dsh-mcp-quick-row.flip .dsh-mcp-quick-sub{animation-name:dshMcpQuickInFlip}
@keyframes dshMcpQuickIn{from{opacity:0;transform:translateY(-50%) translateX(-4px)}to{opacity:1;transform:translateY(-50%)}}
@keyframes dshMcpQuickInFlip{from{opacity:0;transform:translateY(50%) translateX(-4px)}to{opacity:1;transform:translateY(50%)}}
@media (prefers-reduced-motion: reduce){.dsh-mcp-quick-sub{animation:none}}
.dsh-mcp-quick-sub.empty{display:block;padding:9px 11px;color:var(--mcp-mut);font-size:12px}
.dsh-mcp-quick-sub-note{padding:6px 9px;color:var(--mcp-mut);font-size:11px;white-space:normal}
.dsh-mcp-quick-manage{display:flex;align-items:center;flex:none;width:100%;margin-top:4px;padding:6px 9px;border:none;border-top:1px solid var(--mcp-line);border-radius:0 0 var(--mcp-r-sm) var(--mcp-r-sm);background:transparent;color:var(--mcp-accent);font-family:inherit;font-size:11px;text-align:left;cursor:pointer;transition:background .12s}
.dsh-mcp-quick-manage:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-quick-manage:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:-1px}
.dsh-mcp-quick-item{display:flex;align-items:baseline;gap:7px;flex:none;width:100%;height:28px;padding:6px 9px;border:none;border-radius:var(--mcp-r-sm);background:transparent;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:16px;text-align:left;cursor:pointer;transition:background .12s}
.dsh-mcp-quick-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-quick-item:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:-1px}
.dsh-mcp-quick-item-name{flex:none;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mcp-quick-item-badge{flex:none;padding:1px 5px;border-radius:var(--mcp-r-xs);background:color-mix(in srgb,var(--mcp-accent) 14%,transparent);color:var(--mcp-accent);font-size:10px;line-height:12px}
.dsh-mcp-quick-item-desc{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mcp-mut);font-size:11px}
.dsh-mcp-quick-loading,.dsh-mcp-quick-err{padding:9px 11px;color:var(--mcp-mut);font-size:12px}
/* ── 会话头「当前生效专家」徽章（SessionExpertBadge）─────────────────────
   尺寸/配色对齐宿主 AgentPresetLabel（.b06baG_label：22px 高、12px 字号、
   tertiary 色、180px 上限），并排显示不突兀；窄窗（≤540px 容器）跟随宿主隐藏。
   宿主用 container query，这里没有对应容器名，用媒体查询近似同一断点。 */
.dsh-mcp-head-expert{display:inline-flex;align-items:center;gap:4px;max-width:180px;height:22px;padding:0 2px 0 0;border-radius:var(--dsw-radius-xs,var(--mcp-r-sm));background:var(--dsw-alias-fill-tsp-secondary,transparent);color:var(--dsw-alias-label-tertiary,var(--mcp-mut));font-size:12px;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-mcp-head-expert-icon{flex:none;opacity:.7}
.dsh-mcp-head-expert-name{min-width:0;overflow:hidden;text-overflow:ellipsis}
/* 陈旧预设标签：挂上专家后由 SessionExpertBadge 动态加此 class（只命中带
   WorkBuddy 专家 前缀的那条宿主标签）。不删节点、不改 DOM 结构，只视觉隐身——
   摘掉专家时 class 被移除，标签原样回来（React 始终是这些节点的所有者）。 */
.dsh-mcp-hide-stale-preset{display:none!important}
@media (max-width:560px){.dsh-mcp-head-expert{display:none}}
.dsh-mcp-quick-note{padding:7px 11px;margin-bottom:4px;border-radius:var(--mcp-r-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-size:11px;line-height:15px;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;white-space:normal;word-break:break-word}
.dsh-mcp-quick-note.err{color:var(--mcp-err)}
.dsh-mcp-quick-note.ok{color:var(--mcp-ok)}
.dsh-mcp-quick-err{color:var(--mcp-err)}
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
/* 解码告警（OPT-02）：正常运行时整块不渲染，所以这里可以给足视觉权重。 */
.dsh-mcp-tailor-warn{border:0.5px solid var(--mcp-warn);border-radius:var(--mcp-r-md);corner-shape:round;background:color-mix(in srgb,var(--mcp-warn) 8%,transparent);padding:10px 14px;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-primary);flex:none;display:flex;flex-direction:column;gap:4px}
.dsh-mcp-tailor-warn b{color:var(--mcp-warn)}
.dsh-mcp-tailor-details{margin-top:2px}
.dsh-mcp-tailor-details summary{cursor:pointer;color:var(--mcp-mut);font-size:12px;line-height:18px}
.dsh-mcp-tailor-details ul{margin:6px 0 0;padding-left:18px;color:var(--mcp-mut);font-size:11.5px;line-height:17px;max-height:160px;overflow-y:auto}
.dsh-mcp-tailor-details li{font-family:var(--mcp-mono);word-break:break-all}
/* 面板错误边界（OPT-07）：只在某块渲染期抛错时出现，占满该分类的正文区。 */
.dsh-mcp-panel-error{border:0.5px solid var(--mcp-err);border-radius:var(--mcp-r-md);corner-shape:round;background:color-mix(in srgb,var(--mcp-err) 7%,transparent);padding:16px 18px;display:flex;flex-direction:column;gap:8px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dsh-mcp-panel-error b{color:var(--mcp-err);font-size:14px}
.dsh-mcp-panel-error p{margin:0;font-family:var(--mcp-mono);font-size:12px;line-height:18px;color:var(--mcp-mut);word-break:break-word}
.dsh-mcp-panel-error-act{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsh-mcp-panel-error-act span{color:var(--mcp-mut);font-size:12px;line-height:18px}

/* 响应式覆盖必须位于全部基础规则之后：同特异性下后出现者胜出。 */
@media (max-width:760px){.dsh-mcp-panel-overlay{padding:10px}.dsh-mcp-panel{max-width:none;width:100%;height:calc(100dvh - 20px);border-radius:var(--mcp-r-panel)}.dsh-mcp-panel .dsh-mcp-wrap{padding:12px}.dsh-mcp-head{align-items:flex-start}.dsh-mcp-body{flex-direction:column;overflow-y:auto;overflow-x:hidden}.dsh-mcp-side,.dsh-mcp-ws-body{width:auto;min-width:0;max-height:none;flex:none}.dsh-mcp-side:not(.embedded) .dsh-mcp-list{max-height:38vh}.dsh-mcp-section.local,.dsh-mcp-section.global{flex:none;min-height:0;max-height:none}.dsh-mcp-section.local .dsh-mcp-list{max-height:30vh}.dsh-mcp-global-list{max-height:30vh}.dsh-mcp-detail{padding:12px;flex:none}.dsh-mcp-d-head{flex-direction:column}.dsh-mcp-kv-edit{grid-template-columns:minmax(90px,35%) minmax(0,1fr) auto}.dsh-mcp-page{padding:calc(var(--dsh-frame-top-clearance,0px) + 10px) 12px 20px}.dsh-mcp-page>.dsh-mcp-wrap{min-height:0;height:auto}.dsh-mcp-skill-body{flex-direction:column;overflow:visible}.dsh-mcp-skill-side{width:auto;flex:none}.dsh-mcp-skill-list{max-height:34vh}.dsh-mcp-skill-detail{flex:none;max-height:none}.dsh-mcp-skill-d-md{max-height:38vh}}
@media (max-width:480px){.dsh-mcp-head{flex-direction:column}.dsh-mcp-head-actions{width:100%;justify-content:flex-start}.dsh-mcp-btn{padding:7px 9px}.dsh-mcp-radio-row,.dsh-mcp-number-grid{grid-template-columns:1fr}.dsh-mcp-modal{max-width:none;width:100%;padding:14px}.dsh-mcp-kv{grid-template-columns:1fr;gap:4px}.dsh-mcp-kv>b{margin-top:4px}.dsh-mcp-secret-row{grid-template-columns:1fr;gap:4px}.dsh-mcp-secret{width:100%}.dsh-mcp-kv-edit{grid-template-columns:1fr auto}.dsh-mcp-kv-edit input:first-child{grid-column:1 / -1}.dsh-mcp-tool{flex-direction:column}.dsh-mcp-tool-name{max-width:100%}.dsh-mcp-tool-desc{white-space:normal}.dsh-mcp-builtin-toolbar{align-items:flex-start;flex-direction:column}.dsh-mcp-builtin-row{grid-template-columns:18px minmax(0,1fr)}.dsh-mcp-builtin-status{grid-column:2;text-align:left}}
`;

// ── DOM 基础件：createElement 绑定、值遮蔽、通用小控件与图标表 ──────────────────────
// 这一层必须排在所有组件之前 —— 下面 23 个返回元素的 React 组件全靠这里的 `h` 构造。
const h = React2.createElement;
const MAX_TIMER_DELAY_MS = 2147483647;
const REDACTED_VALUE = '__DSH_MCP_REDACTED__';
const PRESERVED_VALUE_LABEL = t('••••••（保留原值）');
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

// 徽章默认是纯展示 span；传 onClick 时可当按钮用（如「需更新」点一下直接重跑召唤）。
const Badge = ({ cls, children, ...rest }) => h('span', { ...rest, className: 'dsh-mcp-badge ' + (cls || '') }, children);

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
  // expert：专家（人物半身像：圆头 + 双肩），看板「专家」分类用
  expert: 'M8 2.5a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4zM3.2 13.5c.4-2.7 2.3-4.2 4.8-4.2s4.4 1.5 4.8 4.2',
};

// ── 常用 MCP 预设模板（主流管理器常见的“浏览即添加”能力）────────────
// 预设只填充表单，不直接写入；命令依赖本机 npx / uvx，保存前请确认可用。
const MCP_PRESETS = [
  { id: 'filesystem', serverName: 'filesystem', label: t('Filesystem · 本地文件读写'), transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/path/to/allowed/dir'] },
  { id: 'memory', serverName: 'memory', label: t('Memory · 知识图谱记忆'), transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
  { id: 'sequential-thinking', serverName: 'sequential-thinking', label: t('Sequential Thinking · 分步推理'), transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'] },
  { id: 'time', serverName: 'time', label: t('Time · 时区时间工具（需 uvx）'), transport: 'stdio', command: 'uvx', args: ['mcp-server-time'] },
  { id: 'git', serverName: 'git', label: t('Git · 版本控制（需 uvx）'), transport: 'stdio', command: 'uvx', args: ['mcp-server-git'] },
];

// ── 表单与剪贴板基础件：遮蔽值的显隐状态、修订号去重、复制 ──────────────────────────
// （此前这一节的标注写成「工具参数 JSON Schema 的可读化渲染辅助」，但那三个函数在下面
//  describeType 处。标注错位会让人以为 reveal 逻辑属于 schema 渲染，实际两者无关。）
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

// ── 工具参数 Schema 的可读化渲染：类型名与枚举文本 ─────────────────────────────
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

// ── 作用域标签页：全局固定首位，超宽时折叠成「…N」弹出层 ──────────────────────────
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

// ── 工具行：Schema 摊平成字段清单，可展开看原始 JSON ────────────────────────────
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
    title: open ? t('收起参数') : t('查看参数'),
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
            p.required ? h('span', { className: 'dsh-mcp-req' }, t('必填')) : h('span', { className: 'dsh-mcp-opt' }, t('可选')),
            h('span', { className: 'dsh-mcp-param-type' }, p.type),
          ),
          p.description ? h('div', { className: 'dsh-mcp-param-desc' }, p.description) : null,
          p.enumText ? h('div', { className: 'dsh-mcp-param-enum' }, t('可选值：') + p.enumText) : null,
          p.hasDefault ? h('div', { className: 'dsh-mcp-param-enum' }, t('默认值：') + JSON.stringify(p.default)) : null,
        )),
      ) : null,
      h('button', { type: 'button', className: 'dsh-mcp-tool-rawbtn', onClick: () => setRaw((value) => !value) }, raw ? t('收起原始 JSON') : t('查看原始 JSON')),
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
  if (mountFailed(s)) return t('挂载失败');
  if (scopeFailed(s)) return t('作用域隔离失败');
  if (s.status === 'disabled') return t('已禁用');
  if (s.status === 'unknown') return t('状态未知');
  if (s.status === 'loading') return t('连接中…');
  if (s.status === 'failed') return t('连接失败');
  if (s.status !== 'connected') return t('尚未建立连接（新会话自动挂载）');
  const refs = typeof s.refs === 'number' ? s.refs : 0;
  const tools = typeof s.toolCount === 'number' ? ' · ' + s.toolCount + t(' 工具') : '';
  return refs > 0
    ? t('已连接 · ') + refs + t(' 个会话在用') + tools
    : t('已连接 · 当前无会话使用（连接保留，下次直接用）') + tools;
};

// ── 服务器列表：按传输 / 状态筛选，选中与启停 ──────────────────────────────────
const ServerList = ({ servers, total, selected, query, onQuery, onSelect, onToggle, busy, transportFilter, statusFilter, onTransportFilter, onStatusFilter, embedded, workspace, emptyHint }) => {
  const count = total === undefined ? servers.length : total;
  const showControls = !embedded || count > CONTROLS_THRESHOLD;
  // mountFailed / scopeFailed / wsSub 现在在模块作用域（纯函数，可被测试直接调用）。
  // 项目 MCP 的 status 与全局同一个取值域（deriveMcpPhase）：connected / failed / loading /
  // stopped / disabled / unknown。状态点因此直接复用，不再需要为项目行特例。
  const dotPhase = (s) => (mountFailed(s) || scopeFailed(s) ? 'failed' : s.status || s.phase);
  const toggleLocked = (s) => busy || !s.managed || (s.scope !== 'workspace' && !s.enabled && s.phase !== 'stopped');
  return h('div', { className: 'dsh-mcp-side' + (embedded ? ' embedded' : '') },
    showControls ? h('div', { className: 'dsh-mcp-search' }, h(Icon, { d: ICONS.search }), h('input', { placeholder: t('搜索 MCP…'), value: query, onChange: (e) => onQuery(e.target.value) })) : null,
    showControls ? h('div', { className: 'dsh-mcp-filters' },
      h('select', { value: transportFilter, onChange: (e) => onTransportFilter(e.target.value), 'aria-label': t('按传输过滤') },
        h('option', { value: 'all' }, t('全部传输')),
        h('option', { value: 'http' }, 'HTTP'),
        h('option', { value: 'stdio' }, 'stdio'),
      ),
      h('select', { value: statusFilter, onChange: (e) => onStatusFilter(e.target.value), 'aria-label': t('按状态过滤') },
        h('option', { value: 'all' }, t('全部状态')),
        workspace ? null : h('option', { value: 'connected' }, t('已连接')),
        workspace ? null : h('option', { value: 'failed' }, t('失败')),
        h('option', { value: 'disabled' }, t('已禁用')),
      ),
    ) : null,
    h('div', { className: 'dsh-mcp-list' },
      servers.length === 0
        ? h('div', { className: 'dsh-mcp-empty-list' }, count === 0 && emptyHint ? emptyHint : t('没有匹配的 MCP'))
        : servers.map((s) =>
            h('div', { key: s.serverName, role: 'button', tabIndex: 0, 'aria-selected': selected === s.serverName, className: 'dsh-mcp-item' + (selected === s.serverName ? ' sel' : ''), onClick: () => onSelect(s.serverName), onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(s.serverName); } } },
              h(Dot, { phase: dotPhase(s) }),
              h('div', { className: 'dsh-mcp-item-main' },
                h('div', { className: 'dsh-mcp-item-name' }, s.serverName),
                h('div', { className: 'dsh-mcp-item-sub' },
                  h(Badge, { cls: s.transport === 'http' ? 't-http' : 't-stdio' }, s.transport === 'http' ? 'HTTP' : 'stdio'),
                  h('span', null, s.scope === 'workspace' ? wsSub(s) : s.toolCount + t(' 工具')),
                  mountFailed(s) ? h(Badge, { cls: 's-err' }, t('挂载失败')) : null,
                  scopeFailed(s) ? h(Badge, { cls: 's-err' }, t('作用域故障')) : null,
                ),
              ),
              h(Toggle, { on: s.enabled, disabled: toggleLocked(s), label: s.serverName + (s.enabled ? t('：已启用') : t('：已禁用')), title: s.managed ? (s.enabled ? t('禁用') : t('启用')) : t('来自其他配置层，只读'), onChange: () => onToggle(s) }),
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
    'aria-label': (hidden ? t('已屏蔽：') : t('可见：')) + label,
    title: hidden ? t('已在此项目屏蔽，点击恢复可见') : t('在此项目可见，点击屏蔽'),
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
    servers.length > CONTROLS_THRESHOLD ? h('div', { className: 'dsh-mcp-global-search' }, h(Icon, { d: ICONS.search }), h('input', { placeholder: t('搜索全局 MCP…'), value: q, onChange: (e) => setQ(e.target.value) })) : null,
    h('div', { className: 'dsh-mcp-global-list' },
      servers.length === 0
        ? h('div', { className: 'dsh-mcp-empty-list' }, t('没有全局 MCP'))
        : list.length === 0
          ? h('div', { className: 'dsh-mcp-empty-list' }, t('没有匹配的全局 MCP'))
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
                    h('span', null, s.toolCount + t(' 工具')),
                    isHidden ? h(Badge, { cls: 's-off' }, t('已屏蔽')) : null,
                  ),
                ),
                // 眼睛 = 可见性，与项目 MCP 的启用滑块在语义与外观上都区分开。
                h(EyeToggle, { hidden: isHidden, disabled: busy, label: s.serverName, onChange: (next) => onToggleExclude(s.serverName, next) }),
              );
            }),
    ),
  );
};

// ── 服务器详情：工具清单、重连、编辑、移除、掩码值显隐 ────────────────────────────
const ServerDetail = ({ server, tools, onToggle, onReconnect, onEdit, onRemove, busy, onReveal, revealed, onCopy, excluded, onToggleExclude }) => {
  if (!server)
    return h('div', { className: 'dsh-mcp-detail' }, h('div', { className: 'dsh-mcp-d-empty' }, t('选择一个 MCP 查看详情')));
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
    ? t('已禁用')
    : mountFailed
      ? t('挂载失败')
      : scopeFailed
        ? t('作用域隔离失败')
        : isWorkspace
          // 项目行的 status 与全局同一个取值域（deriveMcpPhase），只是文案不同。
          // 这里只说**连接**那一半事实（"在不在"）；"几个会话在用"由详情页的连接信息与列表行的
          // 副文案给出——两者刻意不合并，见 wsSub 的注释。
          // stopped 在项目语境里意为「这条共享连接尚未建立」（新会话挂载时才建）。
        ? (status === 'connected' ? t('已连接') : status === 'failed' ? t('连接失败') : status === 'unknown' ? t('状态未知') : status === 'loading' ? t('连接中…') : t('尚未建立连接（新会话自动挂载）'))
        : status === 'connected' ? t('已连接') : status === 'failed' ? t('连接失败') : status === 'unknown' ? t('状态未知') : status === 'loading' || status === 'waiting' ? t('连接中…') : t('已停止');
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
      revealedNow ? h('button', { type: 'button', className: 'dsh-mcp-secret-btn', title: t('复制 ') + label, 'aria-label': t('复制 ') + label, onClick: () => onCopy(shown) }, h(Icon, { d: ICONS.copy })) : null,
      masked ? h('button', { type: 'button', className: 'dsh-mcp-secret-btn', disabled: state?.pending, title: revealedNow ? t('隐藏 ') + label : t('显示 ') + label, 'aria-label': t('显示/隐藏 ') + label, onClick: () => onReveal(server, field, keyName) }, state?.pending ? '…' : h(Icon, { d: ICONS[revealedNow ? 'eyeOff' : 'eye'] })) : null,
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
          h(Badge, { cls: isWorkspace ? 'scope-ws' : '' }, isWorkspace ? t('项目配置') : t('全局配置')),
          isWorkspace ? null : h(Badge, null, server.toolCount + t(' 个工具')),
          isWorkspace && server.refs > 0 ? h(Badge, null, server.refs + t(' 个会话共用')) : null,
          isWorkspace && server.duplicateOwners?.length && status === 'failed' ? h(Badge, { cls: 's-err' }, t('serverName 同名冲突')) : null,
        ),
      ),
      h('div', { className: 'dsh-mcp-d-actions' },
        isForeign
          ? h(React2.Fragment, null,
              h('span', { className: 'dsh-mcp-d-scope-hint' }, excluded ? t('已在此项目屏蔽') : t('在此项目可见')),
              h(EyeToggle, { hidden: excluded, disabled: busy, label: server.serverName, onChange: (next) => onToggleExclude(server.serverName, next) }),
            )
          : h(React2.Fragment, null,
              h(Toggle, { on: server.enabled, disabled: busy || !server.managed, label: server.serverName + (server.enabled ? t('：已启用') : t('：已禁用')), onChange: () => onToggle(server), title: server.managed ? (server.enabled ? t('禁用') : t('启用')) : t('来自其他配置层，只读') }),
              h(Btn, { icon: 'edit', onClick: () => onEdit(server), disabled: busy || !server.managed, children: t('编辑') }),
              h(Btn, { icon: 'refresh', onClick: () => onReconnect(server), disabled: busy || !server.enabled || !server.managed, title: isWorkspace ? t('重连本项目共享连接（拆掉旧连接并按当前配置重建，不影响其他会话）') : t('重连'), children: t('重连') }),
              h(Btn, { cls: 'danger', icon: 'trash', onClick: () => onRemove(server), disabled: busy || !server.managed, children: t('移除') }),
            ),
      ),
    ),
    isForeign ? h('div', { className: 'dsh-mcp-log warn' }, t('此 MCP 由全局配置提供。要改它的连接配置，请切到「全局」标签页；在这里只能决定它对本项目是否可见。')) : null,
    // 同名在 DSH 0.1.5 起是合法配置（官方按注册作用域隔离），所以只有这份连接真的失败时才
    // 把它摆成原因；成功时不刷屏，更不把一条好连接说成冲突。
    isWorkspace && server.duplicateOwners?.length && status === 'failed' ? h('div', { className: 'dsh-mcp-log warn' }, t('以下项目也定义了同名 serverName：') + server.duplicateOwners.join(t('、')) + t('。DSH 0.1.5 起各注册作用域可独立使用同名；更早的版本按全进程唯一判定，同名会导致其中一份启动失败。')) : null,
    server.lastError ? h('div', { className: 'dsh-mcp-log', title: t('来自 mcp-client 最近日志') }, server.lastError) : null,
    server.toolCountAmbiguous ? h('div', { className: 'dsh-mcp-log warn' }, t('工具命名与其他 serverName 前缀重叠，无法可靠判断归属；请避免在 serverName 中使用双下划线。')) : null,
    h('div', { className: 'dsh-mcp-card' },
      h('h4', null, t('连接信息')),
      h('div', { className: 'dsh-mcp-kv' },
        h('b', null, t('传输')), h('span', null, server.transport === 'http' ? 'Streamable HTTP' : 'stdio'),
        server.url ? h('b', null, 'URL') : null, server.url ? h(RevealBtn, { field: 'url', label: 'URL', fallback: server.url }) : null,
        server.command ? h('b', null, t('命令')) : null, server.command ? h('span', null, mut(server.command)) : null,
        server.args && server.args.length ? h('b', null, t('参数')) : null, server.args && server.args.length ? h(RevealBtn, { field: 'args', label: t('参数'), fallback: server.args.map(mut).join(' ') }) : null,
        server.cwd ? h('b', null, t('工作目录')) : null, server.cwd ? h('span', null, mut(server.cwd)) : null,
        h('b', null, t('启用')), h('span', null, server.enabled ? t('是') : t('否（补丁中 disabled: true）')),
        h('b', null, t('配置来源')), h('span', null, server.conflict ? t('存在重复 serverName（冲突，只读）') : isForeign ? t('全局配置（在「全局」标签页可编辑）') : isWorkspace ? t('项目配置 .dsh/mcp.json（可编辑，本项目会话共享一份连接）') : server.managed ? t('当前 Web profile（可编辑）') : t('其他 bundle / Agent（只读）')),
        server.toolCallTimeoutMs ? h('b', null, t('调用超时')) : null, server.toolCallTimeoutMs ? h('span', null, server.toolCallTimeoutMs + ' ms') : null,
        h('b', null, t('启动失败策略')), h('span', null, server.failOnStartupError ? t('阻止插件启动') : t('记录错误并继续')),
        server.reconnect ? h('b', null, t('自动重连')) : null, server.reconnect ? h('span', null, server.reconnect.enabled === false ? t('关闭') : t('{0}–{1} ms，最多 {2} 次', [server.reconnect.initialDelayMs || 500, server.reconnect.maxDelayMs || 30000, server.reconnect.maxAttempts || 10])) : null,
        headerKeys.length ? h('b', null, 'Headers') : null, headerKeys.length ? h('div', { className: 'dsh-mcp-secret-list' }, headerKeys.map((k) => h(RevealRow, { key: k, field: 'headers', keyName: k, label: 'Header ' + k }))) : null,
        envKeys.length ? h('b', null, t('环境变量')) : null, envKeys.length ? h('div', { className: 'dsh-mcp-secret-list' }, envKeys.map((k) => h(RevealRow, { key: k, field: 'env', keyName: k, label: t('环境变量 ') + k }))) : null,
      ),
    ),
    h('div', { className: 'dsh-mcp-card' },
      h('h4', null, t('工具（') + tools.length + t('）')),
      h('div', { className: 'dsh-mcp-tools' },
        tools.length === 0
          ? h('div', { className: 'dsh-mcp-empty-list' }, server.toolCountAmbiguous ? t('工具归属存在命名歧义') : server.scope === 'workspace' ? t('尚无会话持有该项目连接，或连接尚未就绪') : t('暂无工具'))
          : tools.map((t) => h(ToolRow, { key: t.name, tool: t })),
      ),
    ),
  );
};

// ── 新增 / 编辑服务器弹窗：表单校验与 secret 字段遮蔽 ────────────────────────────
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
    if (!n) return setError(t('请填写 MCP 名称'));
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
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || !Number.isSafeInteger(attempts) || attempts <= 0) return setError(t('工具超时和最大尝试次数必须是正整数'));
    if (!Number.isFinite(initialDelay) || initialDelay <= 0 || initialDelay > MAX_TIMER_DELAY_MS || !Number.isFinite(maxDelay) || maxDelay <= 0 || maxDelay > MAX_TIMER_DELAY_MS) return setError(t('重连延迟必须是有效正数且不超过 2147483647 ms'));
    if (initialDelay > maxDelay) return setError(t('首次延迟不能大于最大延迟'));
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
    return h('button', { type: 'button', className: 'dsh-mcp-btn dsh-mcp-inline-icon', disabled: revealBusy === id, title: (shown ? t('隐藏原值：') : t('显示原值：')) + label, 'aria-label': (shown ? t('隐藏原值：') : t('显示原值：')) + label, onClick }, revealBusy === id ? '…' : h(Icon, { d: ICONS[shown ? 'eyeOff' : 'eye'] }));
  };
  return h('div', { className: 'dsh-mcp-overlay', onClick: (e) => e.target === e.currentTarget && onClose() },
    h('div', { ref: dialogRef, className: 'dsh-mcp-modal', role: 'dialog', 'aria-modal': true, 'aria-label': editing ? t('编辑 MCP') : t('添加 MCP'), tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } } },
      h('h3', null, (editing ? t('编辑 MCP') : t('添加 MCP')) + (scopeName && scopeName !== t('全局') ? t('（') + scopeName + t('）') : '')),
      !editing ? h('div', { className: 'dsh-mcp-field' },
        h('label', null, t('从预设模板快速填充（可选，命令需本机 npx/uvx）')),
        h('select', { value: '', onChange: (e) => applyPreset(e.target.value), 'aria-label': t('选择预设模板') },
          h('option', { value: '' }, t('— 选择预设 —')),
          MCP_PRESETS.map((p) => h('option', { key: p.id, value: p.id }, p.label)),
        ),
      ) : null,
      h('div', { className: 'dsh-mcp-field' },
        h('label', null, t('MCP 名称（唯一标识，不可改）')),
        h('input', { value: name, disabled: editing, onChange: (e) => setName(e.target.value), placeholder: 'my-server' }),
      ),
      h('div', { className: 'dsh-mcp-field' },
        h('label', null, t('传输类型')),
        h('div', { className: 'dsh-mcp-radio-row' },
          h('label', { className: transport === 'http' ? 'sel' : '' }, h('input', { type: 'radio', checked: transport === 'http', onChange: () => setTransport('http') }), t('HTTP（远程）')),
          h('label', { className: transport === 'stdio' ? 'sel' : '' }, h('input', { type: 'radio', checked: transport === 'stdio', onChange: () => setTransport('stdio') }), t('stdio（本地进程）')),
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
            h('div', { className: 'dsh-mcp-field' }, h('label', null, t('命令')), h('input', { value: command, onChange: (e) => setCommand(e.target.value), placeholder: t('npx 或 C:\\path\\to\\bin.exe') })),
            h('div', { className: 'dsh-mcp-field' },
              h('label', null, t('参数（每行一个，原样传给进程）')),
              h('div', { className: 'dsh-mcp-input-action' },
                h('textarea', { rows: 4, value: visibleEditValue('args', undefined, args), onChange: (e) => { hideEditReveal('args'); setArgs(e.target.value); }, placeholder: '-y\nmcp-server@latest' }),
                editing && args === PRESERVED_VALUE_LABEL ? revealIcon('args', t('参数'), () => toggleEditReveal('args')) : null,
              ),
            ),
            h('div', { className: 'dsh-mcp-field' }, h('label', null, t('工作目录 cwd（可选）')), h('input', { value: cwd, onChange: (e) => setCwd(e.target.value), placeholder: 'C:\\path\\to\\workspace' })),
          ),
      h('div', { className: 'dsh-mcp-field' },
        h('label', null, transport === 'http' ? t('Headers（可选）') : t('环境变量（可选，值写 !!js process.env.KEY 引用密钥）')),
        kvRows.map((row, i) => {
          const field = transport === 'http' ? 'headers' : 'env';
          const originalKey = row.originalKey || row.k;
          const id = editRevealId(field, originalKey);
          return h('div', { key: i, className: 'dsh-mcp-kv-edit' },
            h('input', { placeholder: transport === 'http' ? 'Authorization' : 'API_KEY', value: row.k, onChange: (e) => { hideEditReveal(field, originalKey); kv(kvRows, setKvRows, i, 'k', e.target.value); } }),
            h('input', { placeholder: transport === 'http' ? t('Bearer … 或 !!js process.env.KEY') : 'value', value: visibleEditValue(field, originalKey, row.v), onChange: (e) => { hideEditReveal(field, originalKey); kv(kvRows, setKvRows, i, 'v', e.target.value); } }),
            h('div', { className: 'dsh-mcp-kv-row-actions' },
              editing && row.v === PRESERVED_VALUE_LABEL ? revealIcon(id, row.k, () => toggleEditReveal(field, originalKey)) : null,
              h('button', { type: 'button', className: 'dsh-mcp-kv-del', onClick: () => delRow(kvRows, setKvRows, i), title: t('删除此项'), 'aria-label': t('删除 ') + (row.k || t('配置项')) }, '✕'),
            ),
          );
        }),
        h('div', { className: 'dsh-mcp-kv-add' }, h(Btn, { onClick: () => addRow(kvRows, setKvRows), children: t('+ 添加') })),
      ),
      h('div', { className: 'dsh-mcp-card dsh-mcp-advanced' },
        h('h4', null, t('运行策略')),
        h('div', { className: 'dsh-mcp-field' }, h('label', null, t('工具调用超时（毫秒）')), h('input', { type: 'number', min: 1, value: toolCallTimeoutMs, onChange: (e) => setToolCallTimeoutMs(e.target.value) })),
        h('label', { className: 'dsh-mcp-check' }, h('input', { type: 'checkbox', checked: failOnStartupError, onChange: (e) => setFailOnStartupError(e.target.checked) }), t('首次连接失败时阻止插件启动')),
        h('label', { className: 'dsh-mcp-check' }, h('input', { type: 'checkbox', checked: reconnectEnabled, onChange: (e) => setReconnectEnabled(e.target.checked) }), t('断开后自动重连')),
        h('div', { className: 'dsh-mcp-number-grid' },
          h('div', { className: 'dsh-mcp-field' }, h('label', null, t('首次延迟 ms')), h('input', { type: 'number', min: 1, step: 'any', value: initialDelayMs, onChange: (e) => setInitialDelayMs(e.target.value) })),
          h('div', { className: 'dsh-mcp-field' }, h('label', null, t('最大延迟 ms')), h('input', { type: 'number', min: 1, step: 'any', value: maxDelayMs, onChange: (e) => setMaxDelayMs(e.target.value) })),
          h('div', { className: 'dsh-mcp-field' }, h('label', null, t('最大尝试次数')), h('input', { type: 'number', min: 1, value: maxAttempts, onChange: (e) => setMaxAttempts(e.target.value) })),
        ),
      ),
      error ? h('div', { className: 'dsh-mcp-d-err' }, error) : null,
      h('div', { className: 'dsh-mcp-modal-actions' },
        h(Btn, { onClick: onClose, children: t('取消') }),
        h(Btn, { cls: 'primary', onClick: submit, disabled: busy, children: busy ? t('保存中…') : (editing ? t('保存') : t('添加')) }),
      ),
    ),
  );
};

const sourceImportNames = (row) => (row.entries || []).filter((entry) => !entry.error).map((entry) => entry.name);
// 只在界面上提示「这条来源带了会被掩码的字段」。具体值一律留在 Host：Host 只给字段名。
const sourceMaskedFields = (row) => [...new Set((row.entries || []).flatMap((entry) => entry.maskedFields || []))];
// 环境变量名不算秘密（值才是），但缺值会让导入后的那个位置变成空字符串，得先说。
const sourceMissingEnv = (row) => [...new Set((row.entries || []).flatMap((entry) => entry.missingEnv || []))];

// ── JSON 导入弹窗：多来源选择、错误分组、掩码字段提示 ────────────────────────────
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
      if (!res?.ok) throw new Error(res?.error || t('读取本机客户端配置失败'));
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
    if (row.error || !names.length) { setError(row.error || t('这条配置里没有可导入的 MCP')); return; }
    setBusy(true); setError(''); setPreview(null); clearSource();
    try {
      const res = await call('previewImportSource', { sourceId: row.sourceId, scope: row.scope, names, ...scopePayload });
      if (!res?.ok) throw new Error(res?.error || t('预览失败'));
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
      if (!res?.ok) throw new Error(res?.error || t('JSON 解析失败'));
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
      if (!res?.ok) throw new Error(res?.error || t('导入失败'));
      onImported(res);
      onClose();
    } catch (e) { setError(String(e?.message || e)); }
    finally { setBusy(false); }
  };
  const replaceWarning = t('替换会删除') + (isWorkspace ? t('该项目') : t('当前 Web profile'));
  const applyImport = async () => {
    if (!preview) return runPreview();
    // 同名冲突不再让整批失败：Host 会跳过那几条并在预览的提示里写明，用户按需处理。
    return submitImport(
      mode === 'replace' ? replaceWarning + t('中未出现在 JSON 里的 MCP。确认继续？') : '',
      () => (isWorkspace
        ? call('importWorkspaceJson', { wsPath: scope, json: text, mode })
        : call('importJson', { json: text, mode })),
    );
  };
  const applySourceImport = async () => {
    if (!source || !sourcePreview) return;
    return submitImport(
      mode === 'replace' ? replaceWarning + t('中未出现在这份来源里的 MCP。确认继续？') : '',
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
    t('新增：') + (activePreview.added?.join(', ') || t('无')),
    t('更新：') + (activePreview.updated?.join(', ') || t('无')),
    mode === 'replace' ? t('移除：') + (activePreview.removed?.join(', ') || t('无')) : null,
    // 被跳过的同名条目（其他配置层占用、或来源里重名）由 Host 放进 warnings，这里只渲染一处，
    // 免得同一件事既显示"冲突"又显示"提示"。
    ...(activePreview.warnings || []).map((warning) => t('提示：') + warning),
  ].filter(Boolean).join('\n') : '';
  // 来源列表已按当前层过滤（Host 侧保证）：全局标签只有全局来源，项目标签只有该项目的来源，
  // 所以行上不需要「（项目）」后缀，也不再需要用户自己判断「这一行会导到哪儿去」。
  const layerLabel = isWorkspace ? t('项目级') : t('全局');
  const layerHint = isWorkspace
    ? t('没检测到这个项目的项目级 MCP 配置（.mcp.json / .codex/config.toml / .pi/mcp.json / opencode.json 等），可在下面手动粘贴')
    : t('没检测到本机客户端的全局 MCP 配置（~/.claude.json / ~/.codex/config.toml / ~/.config/opencode/opencode.json 等），可在下面手动粘贴');
  return h('div', { className: 'dsh-mcp-overlay', onClick: (e) => e.target === e.currentTarget && onClose() },
    h('div', { ref: dialogRef, className: 'dsh-mcp-modal', role: 'dialog', 'aria-modal': true, 'aria-label': t('导入 MCP'), tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } } },
      h('h3', null, t('导入 MCP') + (isWorkspace && scopeName && scopeName !== t('全局') ? t('（') + scopeName + t('）') : '')),
      h('div', { className: 'dsh-mcp-field dsh-mcp-source-box' },
        h('label', null, t('从本机客户端导入') + layerLabel + t('配置（只读，不修改它们的文件）')),
        sourcesLoading ? h('div', { className: 'dsh-mcp-source-detail' }, t('正在扫描本机客户端配置…')) : null,
        sourcesError ? h('div', { className: 'dsh-mcp-d-err' }, sourcesError) : null,
        !sourcesLoading && !sourcesError && !sources.length
          ? h('div', { className: 'dsh-mcp-source-detail' }, layerHint)
          : null,
        sources.length ? h('div', { className: 'dsh-mcp-source-list' }, sources.map((row) => {
          const names = sourceImportNames(row);
          const masked = sourceMaskedFields(row);
          const missingEnv = sourceMissingEnv(row);
          const detail = row.error || (names.length ? names.length + t(' 个 MCP：') + names.join(', ') : t('没有可导入的 MCP'));
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
            masked.length ? h('span', { className: 'dsh-mcp-source-note' }, t('含需掩码字段：') + masked.join(t('、')) + t('（导入后在详情页可用眼睛查看）')) : null,
            missingEnv.length ? h('span', { className: 'dsh-mcp-source-warn' }, t('环境变量未设置：') + missingEnv.join(t('、')) + t('（导入后该处会得到空值）')) : null,
            row.warnings?.length ? h('span', { className: 'dsh-mcp-source-warn' }, row.warnings.length + t(' 条提示，导入时逐条列出')) : null,
          );
        })) : null,
      ),
      h('div', { className: 'dsh-mcp-field' },
        h('label', null, t('或粘贴 JSON：支持 Claude/Cursor/Cline/Roo 的 mcpServers、VS Code 的 servers，以及单个 MCP 对象')),
        h('textarea', { className: 'dsh-mcp-import-json', value: text, onChange: (e) => { setText(e.target.value); setPreview(null); clearSource(); }, placeholder: '{\n  "mcpServers": {\n    "example": { "command": "npx", "args": ["-y", "example-mcp"] }\n  }\n}' }),
      ),
      h('div', { className: 'dsh-mcp-radio-row' },
        h('label', { className: mode === 'merge' ? 'sel' : '' }, h('input', { type: 'radio', checked: mode === 'merge', onChange: () => { setMode('merge'); setPreview(null); } }), t('合并（同名更新）')),
        h('label', { className: mode === 'replace' ? 'sel' : '' }, h('input', { type: 'radio', checked: mode === 'replace', onChange: () => { setMode('replace'); setPreview(null); } }), isWorkspace ? t('替换该项目') : t('替换当前 Profile')),
      ),
      summary ? h('div', { className: 'dsh-mcp-card dsh-mcp-import-preview' }, summary) : null,
      error ? h('div', { className: 'dsh-mcp-d-err' }, error) : null,
      h('div', { className: 'dsh-mcp-modal-actions' },
        h(Btn, { onClick: onClose, children: t('取消') }),
        source ? h(Btn, { onClick: () => { clearSource(); setError(''); }, disabled: busy, children: t('取消选择来源') }) : null,
        source
          ? h(Btn, { cls: 'primary', onClick: applySourceImport, disabled: busy || !sourcePreview, children: busy ? t('导入中…') : t('确认从来源导入') })
          : h(Btn, { onClick: runPreview, disabled: busy || !text.trim(), children: busy ? t('解析中…') : t('预览') }),
        source ? null : h(Btn, { cls: 'primary', onClick: applyImport, disabled: busy || !text.trim(), children: preview ? t('确认导入') : t('解析并预览') }),
      ),
    ),
  );
};

const POLL_INTERVAL_MS = 5000;

// 面板靠轮询反映 MCP 连接状态。标签页不可见时没人看这份数据，却照样每 5s 打两个 RPC，
// 因此隐藏期间跳过拉取，并在重新可见时立刻补一次，避免用户回来先看到一屏陈旧状态。
//
// `timer` 可缺省：有些调用点（输入框菜单、会话头徽章）拿不到面板的 timer 对象。缺省时退回
// 裸 setInterval/clearInterval——生命周期仍由调用方的 effect cleanup（返回的 stop 函数）
// 独占管理，所以只是少了一层「面板卸载时统一清理」的保护，不会泄漏。
const fallbackTimer = {
  interval(fn, ms) {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  },
};
function startVisibilityAwarePolling(doc, timer, intervalMs, run) {
  const visible = () => !doc || doc.visibilityState !== 'hidden';
  const host = timer && typeof timer.interval === 'function' ? timer : fallbackTimer;
  const disposeInterval = host.interval(() => { if (visible()) run(); }, intervalMs);
  if (!doc || typeof doc.addEventListener !== 'function') return disposeInterval;
  const onVisibilityChange = () => { if (visible()) run(); };
  doc.addEventListener('visibilitychange', onVisibilityChange);
  return () => {
    disposeInterval();
    doc.removeEventListener('visibilitychange', onVisibilityChange);
  };
}

// ── MCP 主面板（McpTab）：服务器 + 工具 + 可见性感知轮询 ──────────────────────────
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
          if (notify) flash(t('已刷新项目 MCP，共 ') + next.length + t(' 个'));
        } else {
          const next = res.servers || [];
          if (consumeRevision(revealRevisionRef, res.revealRevision)) clearRevealed();
          const hasRevision = Object.hasOwn(res, 'revision');
          if (!hasRevision || res.revision !== revisionRef.current) {
            revisionRef.current = res.revision || '';
            setServers(next);
          }
          setError('');
          if (notify) flash(t('已刷新，共 ') + next.length + t(' 个 MCP'));
        }
      } else {
        const message = (res && res.error) || t('加载失败');
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
      try { dismissed = localStorage.getItem('dsh-armory.updateHint.dismissed'); } catch { /* 存储不可用时视为未关闭 */ }
      if (dismissed !== res.latest) setUpdateHint(res);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [call]);

  // 探测一键升级的可用性：官方 pluginManager 在不在 + 本插件是不是 npm 装的。
  // 与 updateHint 同一条纪律：任何失败都静默（按钮不出现即可），绝不因它让面板报错。
  // 只在确实有新版时才探测——没有新版时按钮本来就不显示，省一次 remote 调用。
  //
  // 安装来源必须问宿主（call('installInfo')）：宿主 listBundles() 的行里没有 source
  // 字段，客户端拿它判来源会恒判「npm 装的」；而 installBundle 执行 `pnpm add <spec>`，
  // 本地 file:/link: 安装的用户一点就把开发副本换成 npm 包。installInfo 读的是 profile
  // manifest 里本插件那一行的真实 spec，是唯一可信判据。
  useEffect(() => {
    if (!updateHint?.latest || !pluginManager || typeof pluginManager[UPGRADE_METHOD] !== 'function') return undefined;
    let cancelled = false;
    (async () => {
      try {
        const [bundleRes, installRes] = await Promise.all([
          pluginManager.listBundles(),
          call('installInfo').catch(() => null),
        ]);
        if (cancelled) return;
        const bundle = bundleRes && bundleRes.ok === true && Array.isArray(bundleRes.value)
          ? bundleRes.value.find((b) => b && b.name === UPGRADE_PACKAGE) || null
          : null;
        const install = installRes && installRes.ok ? installRes : null;
        // 只有判定为「可升级」才记 spec；不可升级时也记下 source/reason，
        // 供横幅按真实来源说清「为什么不能一键升」（本地安装 vs 来源未知）。
        const plan = upgradePlan({ service: pluginManager, hint: updateHint, bundle, spec: install?.spec ?? null, source: install?.source ?? null });
        if (cancelled) return;
        if (plan.supported) setUpgradeState({ phase: 'idle', bundle, spec: plan.spec, source: install?.source ?? null });
        else setUpgradeState({ phase: 'idle', bundle, source: install?.source ?? null, reason: plan.reason });
      } catch { /* 探测失败 = 没有一键升级，退回链接；不报错 */ }
    })();
    return () => { cancelled = true; };
  }, [pluginManager, updateHint, call]);

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
          flash(successMsg || (res.note || method + t(' 成功')));
        } else {
          flash((res && res.error) || method + t(' 失败'), 'err');
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
      return act(next ? 'enable' : 'disable', s.serverName, (next ? t('已启用 ') : t('已禁用 ')) + s.serverName);
    }
    // 项目层：写 disabled 字段到项目配置。
    const spec = { ...s, name: s.serverName, transport: s.transport === 'stdio' ? 'stdio' : 'streamable-http', disabled: !next };
    return act('updateWorkspaceServer', { wsPath: scope, spec }, (next ? t('已启用 ') : t('已禁用 ')) + s.serverName);
  };
  const onReconnect = (s) => {
    // 项目连接也要有出口：mcp-client 的重连预算耗尽后会注销工具并停止，只能靠重载配置/重启宿主
    // 恢复（它的 README 明写），而项目 MCP 不是常驻服务 —— 所以「重连」在这里是必需的能力，
    // 不是可选装饰。这条路径 = 拆掉旧连接 + 按当前配置重建 + 对齐存活会话。
    if (s.scope === 'workspace') {
      return act('reconnectWorkspaceServer', { wsPath: scope, name: s.serverName }, t('已重连 ') + s.serverName);
    }
    act('reconnect', s.serverName, t('已请求重连 ') + s.serverName);
  };
  const onRemove = (s) => {
    const isWorkspace = s.scope === 'workspace';
    if (confirm(t('确认移除 MCP「') + s.serverName + t('」？将从') + (isWorkspace ? t('项目配置') : t('当前 Web profile 配置')) + t('中删除。'))) {
      clearRevealed();
      if (isWorkspace) act('removeWorkspaceServer', { wsPath: scope, name: s.serverName }, t('已移除 ') + s.serverName);
      else act('removeServer', s.serverName, t('已移除 ') + s.serverName);
    }
  };
  const onToggleExclude = (serverName, hidden) => {
    if (busy || scope === 'global') return;
    revisionRef.current = '';
    setGlobalServers((prev) => prev.map((s) => (s.serverName === serverName ? { ...s, excluded: hidden } : s)));
    setExclude((prev) => (hidden ? (prev.includes(serverName) ? prev : [...prev, serverName]) : prev.filter((name) => name !== serverName)));
    // 屏蔽同样是"写盘即对齐"：Host 会立刻把新的 restrict 写进会话作用域，运行中的会话在**下一次
    // 模型请求**就不再见得到这些工具（工具清单是每步重新组装的，不是首轮定型）。
    act('setWorkspaceExclude', { wsPath: scope, serverName, hidden }, hidden ? (t('已屏蔽 ') + serverName + t('，对运行中的会话立即生效')) : (t('已取消屏蔽 ') + serverName + t('，对运行中的会话立即生效')));
  };
  useEffect(() => { clearRevealed(); }, [selected, clearRevealed]);
  const revealValue = useCallback(async (server, field, key) => {
    if (!server.managed) throw new Error(t('该 MCP 来自其他配置层，配置只读，无法查看具体值'));
    const res = server.scope === 'workspace'
      ? await call('revealWorkspaceServer', { wsPath: scope, name: server.serverName, field, key })
      : await call('reveal', { name: server.serverName, field, key });
    if (!res?.ok) throw new Error(res?.error || t('读取配置失败'));
    return res.value;
  }, [call, scope]);
  const onCopy = useCallback((text) => {
    copyText(text).then((ok) => flash(ok ? t('已复制到剪贴板') : t('复制失败'), ok ? 'ok' : 'err'));
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
        flash(editTarget ? t('已保存 ') + spec.name : t('已添加 ') + spec.name);
        setAddOpen(false);
        setEditTarget(null);
        timer.timeout(load, 1500);
      } else {
        setFormError((res && res.error) || (editTarget ? t('保存失败') : t('添加失败')));
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
    flash(res.note || t('已导入 MCP'));
    timer.timeout(load, 1200);
  };

  const dismissUpdateHint = () => {
    if (updateHint?.latest) { try { localStorage.setItem('dsh-armory.updateHint.dismissed', updateHint.latest); } catch { /* 忽略：下次打开会再提示 */ } }
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
    // 判定在探测 effect 里已用真实 spec（宿主 installInfo）做完；按钮只在 supported 时
    // 才渲染，所以这里拿到 spec 就能执行。状态过期（spec 被清掉）时只提示、不动安装。
    const targetSpec = upgradeState.spec;
    if (!targetSpec) { setUpgradeState({ phase: 'blocked', reason: upgradeState.reason || 'not-ready' }); return; }
    const targetVersion = targetSpec.split('@^')[1] || updateHint?.latest || '';
    setUpgradeState((current) => ({ ...current, phase: 'running', version: targetVersion }));
    try {
      // 两个参数：installBundle(spec, options)。少传第二个会被 wire 直接拒绝
      // （client api: pluginManager/installBundle expected 2 argument(s), got 1）。
      const res = await pluginManager[UPGRADE_METHOD](targetSpec, {});
      if (!res || res.ok !== true) {
        setUpgradeState((current) => ({ ...current, phase: 'failed', text: (res && res.error && (res.error.message || res.error.code)) || t('调用失败') }));
        return;
      }
      const r = res.value || {};
      if (r.application === 'failed' || r.application === 'cancelled') {
        setUpgradeState((current) => ({ ...current, phase: 'failed', text: upgradeFailureText(r.error, r.packageResult && r.packageResult.exitCode) }));
        return;
      }
      // applied / restart-required / overridden 都算装上了。宿主代码在进程内执行，升级已存在的包
      // 时官方**无条件**返回 restart-required（installBundle 里 `if (Object.hasOwn(before, name))
      // return 'restart-required'`，与 HMR 开不开无关），所以这里必须告诉用户去重启。
      setUpgradeState({ phase: 'done', version: targetVersion });
    } catch (e) {
      setUpgradeState((current) => ({ ...current, phase: 'failed', text: String(e?.message || e) }));
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
    const tabs = [{ key: 'global', label: t('全局') }];
    for (const ws of workspaces) {
      tabs.push({ key: ws.path, label: ws.name, count: ws.serverCount, title: ws.path + (ws.error ? t('（配置无效：') + ws.error + t('）') : '') });
    }
    return tabs;
  }, [workspaces]);
  const scopeName = scope === 'global' ? t('全局') : (workspaces.find((ws) => ws.path === scope)?.name || scope);
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
      h('div', { className: 'dsh-mcp-title' }, 'MCP'),
      h(
        'div',
        // 作用域由下方的 tab 高亮承载，按钮文案不再重复项目名：项目名长度不可控，
        // 塞进三个按钮会把工具栏挤到换行；完整作用域放在 title 里，宽度保持恒定。
        { className: 'dsh-mcp-head-actions' },
        h(Btn, { icon: 'refresh', onClick: () => load(true), disabled: refreshing, children: refreshing ? t('刷新中…') : t('刷新') }),
        h(Btn, { onClick: () => setImportOpen(true), title: t('导入 MCP（') + scopeName + t('）'), children: t('导入 MCP') }),
        h(Btn, { cls: 'primary', icon: 'plus', onClick: openAdd, title: (scope === 'global' ? t('添加 MCP') : t('添加项目 MCP')) + t('（') + scopeName + t('）'), children: scope === 'global' ? t('添加 MCP') : t('添加项目 MCP') }),
        h(EntryMenu, null),
        onClose ? h(Btn, { icon: 'x', onClick: onClose, children: t('关闭') }) : null,
      ),
    ),
    h(ScopeTabs, { tabs: scopeTabs, active: scope, onSelect: switchScope }),
    // 横幅的存活条件：有新版本，**或者**刚升完（要告诉用户重启，否则「点完就消失」
    // 等于没说——实测就是这样：升级成功后 updateHint 立刻变成「已是最新」，横幅随之消失）。
    (updateHint || upgradeState.phase === 'done') ? h('div', { className: 'dsh-mcp-upd' },
      // 文案随升级阶段走：升级中/已装完待重启/失败，都比「有新版本」更该让用户看到。
      // 注意 updateHint 在 done 分支已经是 null（宿主已认不出旧版），所以这里不读它的字段。
      h('span', null,
        upgradeState.phase === 'running' ? t('正在升级到 v') + upgradeState.version + '…'
          : upgradeState.phase === 'done' ? t('已升级到 v') + upgradeState.version + t('，重启宿主后生效')
            : upgradeState.phase === 'failed' ? t('升级失败：') + upgradeState.text
              : upgradeState.phase === 'blocked' && upgradeState.reason === 'not-npm'
                ? t('本地安装（') + (upgradeState.source || 'file') + t('），一键升级会把本地副本换成 npm 包，故只提示') + (updateHint?.current ? t('（当前 v') + updateHint.current + t('）') : '')
                : upgradeState.phase === 'idle' && upgradeState.reason === 'not-npm'
                  // 探测阶段就判定不可一键升：这是本地开发安装的常态（file:/link:），
                  // 说清原因，免得用户以为按钮坏了。
                  ? t('新版本 v') + updateHint.latest + t(' 可用；本地安装（') + (upgradeState.source || 'file') + t('）请手动更新后重启')
                  : t('新版本 v') + updateHint.latest + t(' 可用')),
      // 可升级时给按钮，否则退回链接。按钮只在探测确认过 service + npm 来源后出现——
      // 探测失败时这一整条与改动前完全一致，不会出现点了没反应的按钮。
      upgradeState.phase === 'idle' && upgradeState.spec
        ? h('button', {
          type: 'button', className: 'dsh-mcp-upd-go',
          title: t('升级由官方 pluginManager 执行，装完需要重启宿主'),
          onClick: runUpgrade,
        }, t('升级'))
        : h('a', {
          href: (updateHint && updateHint.url) || 'https://github.com/2026heshao/dsh-armory/releases',
          target: '_blank', rel: 'noreferrer',
        }, upgradeState.phase === 'done' ? t('看这次改了什么') : t('查看更新方式')),
      h('button', { type: 'button', className: 'dsh-mcp-upd-close', 'aria-label': t('关闭更新提示'), title: t('本版本内不再提示'), onClick: dismissUpdateHint }, h(Icon, { d: ICONS.x })),
    ) : null,
    error ? h('div', { className: 'dsh-mcp-d-err' }, error) : null,
    scope !== 'global' && mountErrors.length ? h('div', { className: 'dsh-mcp-log' }, mountErrors.length + t(' 个项目 MCP 未能挂载到会话：') + mountErrors.map((m) => m.serverName).join(t('、')) + t('。点开对应条目查看具体错误。')
      // 项目 MCP 是「该项目所有会话共享一份连接」，同一项目内不会因并发会话而撞名；这里只
      // 如实给出并发会话数作为上下文（挂载失败的常见外部原因），不再把它说成 serverName 占用。
      + (liveAgents > 1 ? t('　本项目当前有 ') + liveAgents + t(' 个会话在运行。') : '')) : null,
    scope !== 'global' && scopeErrors.length ? h('div', { className: 'dsh-mcp-log' }, scopeErrors.length + t(' 个项目 MCP 的工具不在共享作用域层：') + scopeErrors.map((m) => m.serverName).join(t('、')) + t('。点开对应条目查看具体错误。')) : null,
    scope !== 'global' && restrictError ? h('div', { className: 'dsh-mcp-log' }, t('屏蔽未能写入会话作用域：') + restrictError.error) : null,
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
                t('此项目的 MCP'),
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
                emptyHint: t('此项目还没有 MCP。用右上角「添加项目 MCP」或「市场」写入 .dsh/mcp.json'),
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
                h('span', { className: 'dsh-mcp-section-toggle-label' }, t('全局 MCP')),
                h('span', { className: 'dsh-mcp-section-summary' },
                  globalServers.length === 0
                    ? t('无')
                    : visibleGlobalCount + '/' + globalServers.length + t(' 对本项目可见')
                      // 工具清单是**每一步**重新组装的，所以改动（新增/删除/改配置/屏蔽）对运行中的
                      // 会话在下一轮请求就生效；只有手工改 .dsh/mcp.json 才要等下一次会话挂载。
                      + t('　·　改动即刻生效')),
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
      h('div', { ref: panelRef, className: 'dsh-mcp-panel', role: 'dialog', 'aria-modal': true, 'aria-label': t('MCP 市场面板'), tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape' && onClose) onClose(); } }, inner),
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
const FAB_POS_KEY = 'dsh-armory/fab-pos';
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

// ── 入口显示偏好：三个入口都可关，但不能都关 ─────────────────────────────────
// 面板只能从这三个入口打开（左上角全局面板行 / 右下角悬浮按钮 / 左侧栏底部「MCP」）。所以
// 「三个都关」是一个必须**无法表达**的状态：真出现了，用户就再也打不开面板，只能手改
// localStorage 回来。这里因此不存三个 boolean，而是存一张「模式 → 入口可见性」表：非法组合
// 在表里根本不存在，不需要额外的守卫、禁用逻辑或「至少留一个」的提示文案。新增入口时，这张
// 表的不变式（每一项至少一个入口可见）由 test/client-entry.mjs 直接对表断言。
const ENTRY_KEY = 'dsh-armory/entry';
const ENTRY_VISIBILITY = {
  both: { panel: true, fab: true, sidebar: false },
  panel: { panel: true, fab: false, sidebar: false },
  fab: { panel: false, fab: true, sidebar: false },
  sidebar: { panel: false, fab: false, sidebar: true },
  all: { panel: true, fab: true, sidebar: true },
};
const ENTRY_LABELS = {
  both: t('全局面板 + 悬浮按钮（推荐）'),
  panel: t('仅全局面板（左上角，"插件"旁）'),
  fab: t('仅悬浮按钮'),
  sidebar: t('仅侧栏底部入口'),
  all: t('三个入口全开'),
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

// shell.overlay 那个注册里现在只剩悬浮按钮一个席位：面板早已改由 sidebar.panellist + main
// 渲染（见下面「全局面板入口」一节），从不由这里挂载。所以这里没有「面板席位」这个维度，
// 只回答「按当前入口偏好，悬浮按钮要不要占位」。
// 抽成纯函数是为了让入口可见性不变式能脱离 React 被测：测试替身的 hooks 是空实现，组件本身
// 在 node 里渲染不起来（见 test/client-entry.mjs）。
function overlaySeats(mode) {
  return { fab: ENTRY_VISIBILITY[mode].fab };
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
// 看板五分类（MCP / Skill / 专家 / 工具裁缝 / 市场）随名称一并示人。
const PANEL_LABEL = t('技能 · MCP · 专家');

// skill 的 source 取值域来自官方 dsh-skill-filesystem 的 roots()（rank 顺序即优先级），
// 与 skill-registry 的 runtime。这里只做展示文案，不参与判定。
const SKILL_SOURCE_LABELS = {
  'project-dsh': t('项目 .dsh/skills'),
  'project-agents': t('项目 .agents/skills'),
  custom: t('自定义目录'),
  'user-dsh': t('用户 ~/.dsh/skills'),
  'user-agents': t('用户 ~/.agents/skills'),
  bundled: t('随 DSH 分发'),
  runtime: t('运行时注册'),
};
const skillSourceLabel = (source) => SKILL_SOURCE_LABELS[source] || (source || t('未知来源'));

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
  { key: '7', label: t('近 7 天'), days: 7 },
  { key: '30', label: t('近 30 天'), days: 30 },
  { key: '90', label: t('近 90 天'), days: 90 },
];
const fmtInt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '—');
const fmtPct = (n) => (typeof n === 'number' && n > 0 ? (n * 100).toFixed(1) + '%' : '0%');
const fmtTax = (n) => (typeof n === 'number' && n > 0 ? '~' + n.toLocaleString('en-US') + ' tok' : '—');
const fmtLast = (ms, now) => {
  if (typeof ms !== 'number') return t('从未');
  const diff = Math.max(0, (typeof now === 'number' ? now : Date.now()) - ms);
  const min = Math.floor(diff / 60000);
  if (min < 1) return t('刚刚');
  if (min < 60) return min + t(' 分钟前');
  const h = Math.floor(min / 60);
  if (h < 24) return h + t(' 小时前');
  const d = Math.floor(h / 24);
  return d + t(' 天前');
};
const fmtScanError = (message) =>
  /404|transport failure/i.test(String(message))
    ? String(message) + t('　——宿主还没注册 toolTailor 接口：重启 DeepSeek Harness 让宿主侧生效后即可')
    : String(message);

const ToolTailor = ({ call, timer, report: reportProp, onReport, seedPending }) => {
  const [windowKey, setWindowKey] = useState('30');
  // 报告可以由父层上提（OPT-04）：分类角标和页面卡片读同一份，进入该分类只扫一次。
  // 没有上提时（直接挂载组件）退化为组件自己持有。
  const [localReport, setLocalReport] = useState(null);
  const report = reportProp !== undefined ? reportProp : localReport;
  const commitReport = onReport || setLocalReport;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const [flashMsg, setFlashMsg] = useState('');
  // 默认展示全部工具。账本里同时存在两类行：窗口内有真实调用次数的，和注册表里
  // 零调用的候选项。旧版默认打开「只看零调用」，屏幕上必然整列 0，看上去像「检测
  // 全坏」——那是筛选口径而不是数据问题。默认关掉，筛选交给用户显式开启。
  const [onlyDead, setOnlyDead] = useState(false);
  const flashCancel = useRef(null);
  const days = Number(windowKey) || 30;
  // 父层先把 30 天窗口扫好了（角标要用）。窗口一致且已有报告时，首次挂载**不必**再扫；
  // 只有用户切窗口（7/90 天）或点「重扫」时才真的重拉。
  const firstResolveRef = useRef(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await call('toolTailor', { days });
      if (res && res.ok) {
        commitReport(res);
        setActionError('');
      } else {
        setError((res && res.error) || t('toolTailor 调用失败'));
      }
    } catch (e) {
      setError(String((e && e.message) || e));
    } finally {
      setBusy(false);
    }
  }, [call, days, commitReport]);

  useEffect(() => {
    if (!firstResolveRef.current) {
      // 父层正在替我们扫同一窗口（角标要用）→ 等它的报告，绝不重复发一发。
      // 父层失败时 seedPending 会翻成 false 并重跑本 effect，这里再自己兜底扫一次。
      if (seedPending && days === 30) return;
      firstResolveRef.current = true;
      const seededDays = report && typeof report.windowDays === 'number' ? report.windowDays : null;
      if (seededDays !== null && seededDays === days) return;
    }
    load();
    // report 刻意不入依赖：它每次拉取都会变，入依赖会变成自激循环。
    // 注：本仓库不装 eslint-plugin-react-hooks（没有 React 侧的 lint 链路），所以这里不挂
    // disable 指令——挂了也是引用一条不存在的规则，ESLint 9 会直接判 error。将来若接入
    // react-hooks，需要在这行补 disable 并写成已注册的规则名。
  }, [load, seedPending]);

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
      else flash((res && res.error) || method + t(' 失败'), 'err');
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
  // 口径回显：任何时刻都能看出「当前显示几条 / 账本共几条 / 被筛掉几条」，
  // 避免筛选态再次被读成「所有计数都是 0」。
  const deadToolCount = tools.filter((tool) => tool.calls === 0).length;
  const calledToolCount = tools.length - deadToolCount;
  const metaText = report
    ? t('扫描 {0} 个会话 · 读 {1} 个日志', [report.sessionsScanned, report.filesRead]) + (report.failedFiles ? t(' · {0} 个失败', [report.failedFiles]) : '') + t(' · 显示 {0}/{1} 个工具 · Schema 合计 ~{2} tok/请求', [fmtInt(shown.length), fmtInt(tools.length), fmtInt(report.taxTotalTokens)]) + (onlyDead && calledToolCount ? t(' · 已隐藏 {0} 个有调用的工具', [fmtInt(calledToolCount)]) : '')
    : (busy ? t('扫描中…') : '');

  // OPT-02：把「解码失败」摆到脸上。此前 failedFrames / failedFileSamples 一路被算出来
  // 却从不显示，于是 zstd 不可用时的表现（扫到了会话、读到了日志、调用数整列 0）与
  // 「只看零调用」筛选完全无法区分。现在两者各有各的一句话。
  const decodeWarning = !report
    ? ''
    : report.zstdSupported === false
      ? t('zstd 解压不可用：当前 Node 不支持 zlib.zstdDecompressSync（需 >= 22.15），所有调用计数都会是 0')
      : report.failedFrames > 0
        ? t('{0} 个日志帧解码失败，调用计数可能偏低', [fmtInt(report.failedFrames)])
        : '';
  const scanFailures = report && Array.isArray(report.failedFileSamples) ? report.failedFileSamples : [];
  // 正常运行时这一段**完全不渲染**（无噪音），只有真出问题才占位。
  const decodeIssue = decodeWarning || scanFailures.length
    ? h('div', { className: 'dsh-mcp-tailor-warn' },
        decodeWarning ? h('div', null, h('b', null, t('⚠ 数据可能不完整：')), decodeWarning) : null,
        report && report.zstdSupported === false
          ? h('div', null, t('当前运行在 Node {0}，请升级到 22.15 以上后重启宿主。', [report.nodeVersion || t('（未知版本）')]))
          : null,
        scanFailures.length
          ? h('details', { className: 'dsh-mcp-tailor-details' },
              h('summary', null, t('{0} 个日志文件未能读取（含超限跳过），展开看原因', [fmtInt(report.failedFiles)])),
              h('ul', null, scanFailures.map((sample, i) => h('li', { key: i }, sample))),
            )
          : null,
      )
    : null;

  return h('div', { className: 'dsh-mcp-tailor' },
    h('div', { className: 'dsh-mcp-tailor-cards' },
      h('div', { className: 'dsh-mcp-tailor-card' }, h('b', null, fmtInt(report ? report.totalCalls : null)), h('span', null, t('窗口内工具调用总次数（{0} 天）', [days]))),
      h('div', { className: 'dsh-mcp-tailor-card' }, h('b', null, fmtInt(report ? report.toolCount : null)), h('span', null, t('出现过的工具（含已卸载 MCP 的历史调用）'))),
      h('div', { className: 'dsh-mcp-tailor-card dead' }, h('b', null, fmtInt(report ? report.deadMcpCount : null)), h('span', null, t('零调用的 MCP 工具（每轮白缴 {0} 上下文税）', [report ? fmtTax(report.deadMcpTaxTokens) : '—']))),
      h('div', { className: 'dsh-mcp-tailor-card err' }, h('b', null, fmtPct(report && report.totalCalls > 0 ? report.totalErrors / report.totalCalls : 0)), h('span', null, t('总体错误率（{0} 次失败）', [fmtInt(report ? report.totalErrors : null)]))),
    ),
    h('div', { className: 'dsh-mcp-tailor-toolbar' },
      TAILOR_WINDOWS.map((w) =>
        h('button', { key: w.key, type: 'button', className: 'dsh-mcp-btn' + (windowKey === w.key ? ' primary' : ''), onClick: () => setWindowKey(w.key) }, w.label),
      ),
      h('button', { type: 'button', className: 'dsh-mcp-btn' + (onlyDead ? ' primary' : ''), onClick: () => setOnlyDead((v) => !v), title: t('只看窗口内零调用的工具（默认关闭：默认显示全部工具与真实调用次数）') }, report ? t('只看零调用（{0}）', [fmtInt(deadToolCount)]) : t('只看零调用')),
      h('button', { type: 'button', className: 'dsh-mcp-btn', onClick: load, disabled: busy }, t('重扫')),
      h('span', { className: 'dsh-mcp-tailor-meta' }, metaText),
    ),
    error ? h('div', { className: 'dsh-mcp-tailor-note' }, t('账本加载失败：'), fmtScanError(error)) : null,
    // 解码告警放在数据和表格**上方**：调用数整列 0 时，用户第一眼要能看到「为什么」。
    decodeIssue,
    actionError ? h('div', { className: 'dsh-mcp-tailor-note' }, actionError) : null,
    flashMsg ? h('div', { className: 'dsh-mcp-tailor-note' }, flashMsg) : null,
    h('div', { className: 'dsh-mcp-tailor-table' },
      h('div', { className: 'dsh-mcp-tailor-row head' },
        h('span', null, t('工具')), h('span', { className: 't-num' }, t('调用')), h('span', { className: 't-num' }, t('错误')),
        h('span', { className: 't-num' }, t('错误率')), h('span', { className: 't-tax' }, t('Schema 税')), h('span', null, t('最后使用 / 操作')),
      ),
      shown.length === 0
        ? h('div', { className: 'dsh-mcp-tailor-empty' }, onlyDead && report ? t('窗口内没有零调用的工具（共 {0} 个工具都有调用，关掉「只看零调用」即可看全部）', [fmtInt(report.toolCount)]) : (busy ? t('扫描中…') : t('暂无数据')))
        : shown.map((tool) => {
            const actionable = tool.kind === 'mcp' && tool.server;
            const isDead = tool.calls === 0;
            const errRate = tool.errorRate || 0;
            return h('div', { key: tool.name, className: 'dsh-mcp-tailor-row' + (isDead ? ' dead' : '') },
              h('span', { className: 't-name' },
                tool.server ? h('span', { className: 't-badge' }, tool.server) : null,
                tool.server ? tool.leaf : tool.name,
                tool.serverDisabled ? h('span', { className: 't-badge warn' }, t('已禁用')) : null,
                errRate >= 0.5 ? h('span', { className: 't-badge err' }, t('高错误率')) : null,
              ),
              h('span', { className: 't-num' }, fmtInt(tool.calls)),
              h('span', { className: 't-num' }, fmtInt(tool.errors)),
              h('span', { className: 't-num' }, fmtPct(errRate)),
              h('span', { className: 't-tax' }, fmtTax(tool.schemaTokens)),
              h('span', { className: 't-last' },
                fmtLast(tool.lastUsedMs, report ? report.generatedAt : undefined),
                actionable && !tool.serverDisabled
                  ? h('span', { className: 't-act' },
                      h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: busy, onClick: () => tailorAct('disable', tool.server, t('已禁用 {0}', [tool.server])) }, t('禁用服务器')),
                      ' ',
                      h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: busy, onClick: () => tailorAct('enable', tool.server, t('已启用 {0}', [tool.server])) }, t('启用')),
                    )
                  : null,
              ),
            );
          }),
    ),
    deadMcpActionable.length
      ? h('div', { className: 'dsh-mcp-tailor-note' },
          h('b', null, t('裁缝建议：')),
          t('{0} 个 MCP 工具在 {1} 天内零调用，合计每轮请求白缴 ~{2} tok 上下文税。可到「MCP」页或在上方行内禁用对应服务器（随时可启用，禁用只作用于新请求）。', [deadMcpActionable.length, days, fmtInt(report ? report.deadMcpTaxTokens : 0)]),
        )
      : null,
  );
};

const BOARD_CATEGORIES = [
  { key: 'mcp', label: 'MCP', icon: 'plug' },
  { key: 'skill', label: 'Skill', icon: 'skill' },
  { key: 'expert', label: t('专家'), icon: 'expert' },
  { key: 'tailor', label: t('工具裁缝'), icon: 'scissors' },
  { key: 'wb', label: t('市场'), icon: 'store' },
];
// 宿主侧接口不存在（HTTP 404 / transport failure）几乎总是「宿主还没重启」：
// 客户端 bundle 从磁盘现读、改完刷新即生效，而宿主的 Remote 方法在启动时才注册。
// 这里把生硬的传输错误翻译成可操作的提示，而不是让用户对着 404 猜。
const skillTransportHint = (message) =>
  /404|transport failure/i.test(String(message))
    ? String(message) + t('　——宿主还没注册 skill 接口：重启 DeepSeek Harness 让宿主侧生效后即可')
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
        setError(res.available === false ? t('宿主没有挂载 skill 注册表（@deepseek-ai/dsh-skill），本看板不可用') : '');
      } else {
        setAvailable(false);
        setError(skillTransportHint((res && res.error) || t('读取 skill 列表失败')));
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
      else setDetailError((res && res.error) || t('读取 skill 内容失败'));
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
          h('input', { placeholder: t('搜索 skill…'), value: query, onChange: (e) => setQuery(e.target.value), 'aria-label': t('搜索 skill') }),
        ),
        h('div', { className: 'dsh-mcp-item-sub' },
          h('span', null, (loading && !refreshing) ? t('读取中…') : (skills.length + t(' 个 skill'))),
          refreshing ? h('span', null, t(' · 刷新中…')) : null,
        ),
        h('div', { className: 'dsh-mcp-skill-list', role: 'listbox', 'aria-label': t('skill 列表') },
          groups.length === 0 && !loading
            ? h('div', { className: 'dsh-mcp-skill-empty' }, t('这个作用域下没有发现 skill。skill 由 skill-filesystem 从项目 .dsh/skills、用户 ~/.dsh/skills 等目录发现。'))
            : groups.map((g) => h(React2.Fragment, { key: g.source },
                h('div', { className: 'dsh-mcp-item-sub', style: { marginTop: '6px' } },
                  h(Badge, { cls: 't-stdio' }, skillSourceLabel(g.source)),
                  h('span', null, g.rows.length + t(' 个')),
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
                      s.modelInvocable ? h(Badge, { cls: 't-http' }, t('模型可调用')) : null,
                      s.userInvocable ? h(Badge, { cls: 't-stdio' }, t('用户可调用')) : null,
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
          ? h('div', { className: 'dsh-mcp-skill-empty' }, t('从左侧选择一个 skill 查看详情'))
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
            title: t('把 skill 所在目录交给宿主在资源管理器中打开（只读定位）'),
            onClick: () => { call('revealSkill', { path: summary.path }); },
          }, h(Icon, { d: ICONS.folder }), t('打开目录')) : null,
        ) : null,
        summary ? h('div', { className: 'dsh-mcp-skill-d-body' },
          h('div', { className: 'dsh-mcp-skill-d-sec' },
            h('b', null, t('描述')),
            h('p', { className: 'dsh-mcp-skill-d-desc' }, summary.description || t('（无描述）')),
          ),
          summary.whenToUse ? h('div', { className: 'dsh-mcp-skill-d-sec' },
            h('b', null, t('何时使用')),
            h('p', { className: 'dsh-mcp-skill-d-desc' }, summary.whenToUse),
          ) : null,
          h('div', { className: 'dsh-mcp-skill-d-sec' },
            h('b', null, t('调用策略')),
            h('p', { className: 'dsh-mcp-skill-d-desc' },
              t('模型可调用：') + (summary.modelInvocable ? t('是') : t('否'))
              + t('　用户可调用：') + (summary.userInvocable ? t('是') : t('否'))),
          ),
          detailLoading ? h('div', { className: 'dsh-mcp-skill-empty' }, t('读取 skill 内容…')) : null,
          detailError ? h('div', { className: 'dsh-mcp-d-err' }, detailError) : null,
          detail && detail.content !== undefined ? h('div', { className: 'dsh-mcp-skill-d-sec' },
            h('b', null, t('指令内容（') + detail.content.length + t(' 字符）')),
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
  { key: 'downloads', label: t('最多下载') },
  { key: 'installs', label: t('最多安装') },
  { key: 'stars', label: t('最多星标') },
  { key: 'score', label: t('综合评分') },
];

// ── 专家（WorkBuddy 专家中心直连）────────────────────────────────────
// 两个页面一个数据源：ExpertInstalledBoard = 看板「专家」分类（管理**已召唤**的专家：
// 预设状态、捆绑技能、送还、打开看板入口说明）；ExpertMarket = 市场「专家」子标签
// （浏览 429 位专家目录、召唤/送还）。召唤 = 往 profile patch 插入独立 agent-preset 行
// （persona.prefix = 专家人设）；新会话选该预设即专家接管。列表一次全量，本地过滤。
// catalog 载入器共享：两个页面都可能先打开，模块级缓存避免重复拉 1.1MB 清单。
const EXPERT_CATALOG_TTL_MS = 10 * 60 * 1000;
let expertCatalogCache = { at: 0, data: null };
const loadExpertCatalogShared = async (call, force = false) => {
  if (!force && expertCatalogCache.data && Date.now() - expertCatalogCache.at < EXPERT_CATALOG_TTL_MS) return expertCatalogCache.data;
  const res = await call('wbExpertCatalog');
  if (!res?.ok) throw new Error(res?.error || t('读取专家目录失败'));
  expertCatalogCache = { at: Date.now(), data: { experts: res.experts || [], categories: res.categories || [], loadedFrom: res.loadedFrom || '' } };
  return expertCatalogCache.data;
};
// 已装专家行（看板「专家」分类）：按 wbExpertInstalled 投影——预设行 + 捆绑技能。
// 点击卡片 = 打开该专家的详情（从共享 catalog 补全展示字段）；操作 = 送还 / 重新召唤。
const ExpertInstalledBoard = ({ call }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [note, setNote] = useState('');
  const [presets, setPresets] = useState([]);
  const [skills, setSkills] = useState([]);
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(''); setNote('');
    try {
      const res = await call('wbExpertInstalled');
      if (!res?.ok) throw new Error(res?.error || t('读取已召唤专家失败'));
      setPresets(res.presets || []);
      setSkills(res.skills || []);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [call]);
  useEffect(() => { load(); }, [load]);

  // 送还：与市场页同一写链；送还后刷新本页。
  const dismiss = async (plugin, name) => {
    setBusy(true); setBusyLabel(t('正在送还 {0}…', [name || plugin])); setError('');
    try {
      const res = await call('wbExpertDismiss', { plugin });
      if (!res?.ok) throw new Error(res?.error || t('送还失败'));
      setNote(res.note || t('{0} 已送还', [name || plugin]));
      setDetail(null);
      await load();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false); setBusyLabel('');
    }
  };
  const openDetail = async (plugin) => {
    setDetail({ plugin, loading: true });
    setNote('');
    try {
      const res = await call('wbExpertDetail', { plugin });
      if (!res?.ok) throw new Error(res?.error || t('读取详情失败'));
      setDetail({ ...res, loading: false });
    } catch (e) {
      setDetail({ plugin, loading: false, detailError: String(e?.message || e) });
    }
  };

  // 技能按 plugin 分组：预设行是主行，捆绑技能是它的附件清单。
  const skillsByPlugin = {};
  for (const row of skills) (skillsByPlugin[row.plugin] ??= []).push(row.skill);
  return h('div', null,
    note ? h('div', { className: 'dsh-mcp-wb-note', role: 'status' }, note) : null,
    busyLabel ? h('div', { className: 'dsh-mcp-wb-note busy', 'aria-live': 'polite' }, busyLabel) : null,
    error ? h('div', { className: 'dsh-mcp-wb-error', role: 'alert' }, error) : null,
    loading ? h('div', { className: 'dsh-mcp-wb-empty' }, t('正在读取已召唤专家…')) : null,
    !loading && !presets.length && !skills.length
      ? h('div', { className: 'dsh-mcp-wb-empty' },
          t('还没有召唤任何专家。到 '),
          h('a', { href: '#', onClick: (e) => { e.preventDefault(); openBoardCategory('wb'); } }, t('市场 → 专家')),
          t(' 挑选一位召唤；召唤后它会出现在这里，并作为独立 Agent 预设出现在新会话的预设选择器里。'))
      : null,
    !loading && presets.length
      ? h('div', { className: 'dsh-mcp-wb-grid' },
          presets.map((row) => {
            const boundSkills = skillsByPlugin[row.plugin] || [];
            return h('div', { key: row.presetId, className: 'dsh-mcp-card wb installed' },
              h('div', { className: 'dsh-mcp-card-top' },
                h('div', null,
                  h('div', { className: 'dsh-mcp-card-name' }, row.plugin),
                  h('div', { className: 'dsh-mcp-card-vendor' }, row.presetId),
                ),
                h(Badge, { cls: 's-on' }, t('已召唤')),
              ),
              h('div', { className: 'dsh-mcp-card-summary' },
                boundSkills.length ? t('捆绑技能：{0}', [boundSkills.join(t('、'))]) : t('无捆绑技能（预设本体在 profile 补丁）')),
              h('div', { className: 'dsh-mcp-wb-card-actions' },
                h('button', { type: 'button', className: 'dsh-mcp-btn', onClick: () => openDetail(row.plugin) }, t('详情')),
                h('button', { type: 'button', className: 'dsh-mcp-btn danger', disabled: busy, onClick: () => dismiss(row.plugin, row.plugin) }, t('送还')),
              ),
            );
          }),
        )
      : null,
    // 详情弹层：与市场页共用结构（只读 + 送还）。
    detail
      ? h('div', { className: 'dsh-mcp-overlay', onClick: (e) => !busy && e.target === e.currentTarget && setDetail(null) },
          h('div', { className: 'dsh-mcp-modal dsh-mcp-wb-modal', role: 'dialog', 'aria-modal': true, 'aria-label': t('已召唤专家详情'), tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); setDetail(null); } } },
            h('h3', null, detail.name ? t('{0}（{1}）', [detail.name, detail.profession || '']) : detail.plugin),
            detail.loading
              ? h('p', { className: 'dsh-mcp-wb-modal-note' }, t('正在拉取详情…'))
              : h('div', null,
                  detail.detailError ? h('p', { className: 'dsh-mcp-wb-error' }, detail.detailError) : null,
                  detail.description ? h('p', { className: 'dsh-mcp-wb-modal-desc' }, detail.description) : null,
                  Array.isArray(detail.skills) && detail.skills.length
                    ? h('div', { className: 'dsh-mcp-card-tags' },
                        detail.skills.map((skill) => h(Badge, { key: skill.name, cls: skill.local ? 's-on' : '' }, skill.name)))
                    : null,
                  detail.persona
                    ? h('div', { className: 'dsh-mcp-skill-d-sec' },
                        h('b', null, t('人设正文（{0} 字符）', [detail.personaChars || detail.persona.length])),
                        h('pre', { className: 'dsh-mcp-skill-d-md' }, detail.persona.length > 4000 ? detail.persona.slice(0, 4000) + t('\n…（预览截断）') : detail.persona),
                      )
                    : null,
                  h('p', { className: 'dsh-mcp-wb-modal-note' },
                    t('该专家以独立 Agent 预设生效：新建会话时在预设选择器选择「WorkBuddy 专家 · …」即专家接管。送还会同时清掉它的捆绑技能。')),
                ),
            h('div', { className: 'dsh-mcp-modal-actions' },
              h(Btn, { onClick: () => setDetail(null), disabled: busy, children: t('关闭') }),
              h(Btn, { danger: true, icon: 'trash', disabled: busy || detail.loading, onClick: () => dismiss(detail.plugin, detail.name), children: t('送还') }),
            ),
          ),
        )
      : null,
  );
};
// 专家市场（市场页子标签）：浏览全量目录 + 召唤/送还。
const ExpertMarket = ({ call }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [note, setNote] = useState('');
  const [experts, setExperts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [source, setSource] = useState('');
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState(null);
  // 已召唤预设行（含 personaText）：团队行需要人设正文做 stale 体检——
  // 旧版本召唤写入的团队预设没有桥接段，新会话选它会调不存在的 TeamCreate/Agent。
  const [presetRows, setPresetRows] = useState([]);
  const presets = useMemo(() => new Set(presetRows.map((row) => row.plugin)), [presetRows]);
  const [withSkills, setWithSkills] = useState(true);
  const [installedSkillPlugins, setInstalledSkillPlugins] = useState(new Set());

  const loadInstalled = useCallback(async () => {
    const res = await call('wbExpertInstalled');
    if (res?.ok) {
      setPresetRows(res.presets || []);
      setInstalledSkillPlugins(new Set((res.skills || []).map((row) => row.plugin)));
    }
  }, [call]);

  const load = useCallback(async (force = false) => {
    setLoading(true); setError(''); setNote('');
    try {
      const data = await loadExpertCatalogShared(call, force);
      setExperts(data.experts);
      setCategories(data.categories);
      setSource(data.loadedFrom);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => { load(); loadInstalled(); }, [load, loadInstalled]);

  const openDetail = async (expert) => {
    setDetail({ ...expert, loading: true });
    setNote('');
    try {
      const res = await call('wbExpertDetail', { plugin: expert.plugin });
      if (!res?.ok) throw new Error(res?.error || t('读取详情失败'));
      setDetail({ ...expert, ...res, loading: false });
    } catch (e) {
      setDetail({ ...expert, loading: false, detailError: String(e?.message || e) });
    }
  };
  const summon = async (expert) => {
    const isTeam = expert.expertType === 'team';
    // 更新预设（stale 团队行）：走同一条召唤链，后端 upsert 整行重写（人设刷新为最新版）。
    // 判定与卡片按钮同源（expertCardActions），避免两处各写一套再走偏。
    const updating = expertCardActions({
      summoned: presets.has(expert.plugin),
      expertType: expert.expertType,
      personaText: personaTextOf(presetRows, expert.plugin),
    }).update;
    const suffix = updating
      ? t('（刷新旧版预设行的人设）')
      : isTeam
        ? t('（写入召唤预设 + 落盘成员人设）')
        : (withSkills ? t(' + 捆绑技能') : '');
    setBusy(true); setBusyLabel(t('正在召唤 {0}{1}…', [expert.name, suffix])); setError('');
    try {
      const res = await call('wbExpertSummon', { plugin: expert.plugin, withSkills: updating ? true : withSkills });
      if (!res?.ok) throw new Error(res?.error || t('召唤失败'));
      setNote(res.note || t('{0} 已召唤', [expert.name]));
      setDetail(null);
      await loadInstalled();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false); setBusyLabel('');
    }
  };
  const dismiss = async (expert) => {
    setBusy(true); setBusyLabel(t('正在送还 {0}…', [expert.name])); setError('');
    try {
      const res = await call('wbExpertDismiss', { plugin: expert.plugin });
      if (!res?.ok) throw new Error(res?.error || t('送还失败'));
      setNote(res.note || t('{0} 已送还', [expert.name]));
      setDetail(null);
      await loadInstalled();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false); setBusyLabel('');
    }
  };

  const queryKey = query.trim().toLowerCase();
  // 有搜索词时忽略分类限定：搜索是全库意图（用户在分类下搜不到别类的条目会误以为
  // 「专家不全」——真实上游命中 42 条而分类叠加后只剩 1 条的实测教训）。
  const searching = queryKey !== '';
  const filtered = experts.filter((item) => {
    if (!searching && category !== 'all' && item.categoryId !== category) return false;
    if (!queryKey) return true;
    return [item.name, item.profession, item.description, item.id, item.plugin, ...item.tags].filter(Boolean).join(' ').toLowerCase().includes(queryKey);
  });
  // 分页（与连接器同款 60/页）：429 条全量渲染既慢又「看不见底」，pager 让总量可见可翻。
  const pageCount = Math.max(1, Math.ceil(filtered.length / WB_MARKET_CONNECTOR_PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const visible = filtered.slice((safePage - 1) * WB_MARKET_CONNECTOR_PAGE_SIZE, safePage * WB_MARKET_CONNECTOR_PAGE_SIZE);
  return h('div', null,
    h('div', { className: 'dsh-mcp-wb-toolbar' },
      h(WbSearchBox, {
        value: query, placeholder: t('搜索专家（花名 / 职业 / 描述 / 标签）'), disabled: loading,
        onChange: (value) => { setQuery(value); setPage(1); },
      }),
      h('select', {
        className: 'dsh-mcp-input dsh-mcp-wb-sort', value: searching ? 'all' : category, disabled: loading || searching,
        title: searching ? t('搜索时自动在全库匹配（忽略分类）') : undefined,
        onChange: (e) => { setCategory(e.target.value); setPage(1); },
      }, h('option', { key: 'all', value: 'all' }, t('全部专家（') + experts.length + t('）')),
        categories.map((cat) => h('option', { key: cat.id, value: cat.id }, t('{0}（{1}）', [cat.name, experts.filter((item) => item.categoryId === cat.id).length])))),
      h('span', { className: 'dsh-mcp-builtin-count' },
        t('显示 {0} / {1}', [filtered.length, experts.length]) + (searching ? t(' · 全库搜索') : '') + (source === 'network' ? t(' · 已更新') : source === 'disk' ? t(' · 缓存') : '')),
    ),
    note ? h('div', { className: 'dsh-mcp-wb-note', role: 'status' }, note) : null,
    busyLabel ? h('div', { className: 'dsh-mcp-wb-note busy', 'aria-live': 'polite' }, busyLabel) : null,
    error ? h('div', { className: 'dsh-mcp-wb-error', role: 'alert' }, error) : null,
    loading && !experts.length ? h('div', { className: 'dsh-mcp-wb-empty' }, t('正在读取专家目录…')) : null,
    !loading && !filtered.length ? h('div', { className: 'dsh-mcp-wb-empty' }, t('没有匹配的专家，换个关键词或分类试试')) : null,
    visible.length
      ? h('div', { className: 'dsh-mcp-wb-grid' },
          visible.map((item) => {
            const summoned = presets.has(item.plugin);
            // 按钮判定走模块作用域纯函数（可被 node 测到，见 expertCardActions 注释）。
            const actions = expertCardActions({
              summoned,
              expertType: item.expertType,
              personaText: personaTextOf(presetRows, item.plugin),
            });
            const staleTeam = actions.update;
            return h('div', { key: item.plugin, className: 'dsh-mcp-card wb' + (summoned ? ' installed' : '') },
              h('div', { className: 'dsh-mcp-card-top' },
                h('div', null,
                  h('div', { className: 'dsh-mcp-card-name' }, t('{0}（{1}）', [item.name, item.profession])),
                  h('div', { className: 'dsh-mcp-card-vendor' }, item.categoryName || item.categoryId),
                ),
                staleTeam
                  ? h(Badge, {
                      cls: 's-warn dot clickable',
                      role: 'button',
                      tabIndex: 0,
                      title: t('这条预设是旧版本召唤写入的，人设缺 DSH 桥接段——用它的新会话开不出成员子智能体。点此直接更新。'),
                      onClick: () => { if (!busy) summon(item); },
                      // role=button + tabIndex=0 就必须能键盘触发，否则是「假按钮」。
                      onKeyDown: (e) => { if (!busy && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); summon(item); } },
                    }, t('需更新 · 点击更新'))
                  : summoned ? h(Badge, { cls: 's-on' }, t('已召唤')) : null,
              ),
              h('div', { className: 'dsh-mcp-card-summary' }, item.description || item.profession),
              h('div', { className: 'dsh-mcp-card-tags' },
                h(Badge, null, item.expertType === 'team' ? t('专家团') : t('专家')),
                item.tags.map((tag) => h(Badge, { key: tag }, tag)),
                installedSkillPlugins.has(item.plugin) ? h(Badge, null, t('含技能')) : null,
              ),
              h('div', { className: 'dsh-mcp-wb-card-actions' },
                h('button', { type: 'button', className: 'dsh-mcp-btn', onClick: () => openDetail(item) }, t('详情')),
                // 团队型已走桥接：主理人接管会话，成员人设落盘后由主理人用 subagent 调度。
                // stale 团队行：「更新预设」与「送还」**并列**（后端 upsert 原地重写该行，
                // 用户也可能只想删掉旧行）。1.9.4 这里曾写成三元，导致更新按钮永不渲染。
                actions.update
                  ? h('button', { type: 'button', className: 'dsh-mcp-btn primary', disabled: busy, onClick: () => summon(item) }, t('更新预设'))
                  : null,
                actions.dismiss
                  ? h('button', { type: 'button', className: 'dsh-mcp-btn danger', disabled: busy, onClick: () => dismiss(item) }, t('送还'))
                  : null,
                actions.summon
                  ? h('button', { type: 'button', className: 'dsh-mcp-btn primary', disabled: busy, onClick: () => summon(item) }, t('召唤'))
                  : null,
              ),
            );
          }),
        )
      : null,
    pageCount > 1
      ? h('div', { className: 'dsh-mcp-wb-pager' },
          h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: safePage <= 1, onClick: () => setPage(safePage - 1) }, t('上一页')),
          h('span', { className: 'dsh-mcp-builtin-count' }, `${safePage} / ${pageCount}`),
          h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: safePage >= pageCount, onClick: () => setPage(safePage + 1) }, t('下一页')),
        )
      : null,
    // ── 专家详情弹层：召唤前看人设原文 + 捆绑技能 ──
    detail
      ? (() => {
        // 弹层里该给哪些按钮：与卡片按钮同源（expertCardActions），只是换到详情对象上算。
        const detailActions = expertCardActions({
          summoned: presets.has(detail.plugin),
          expertType: detail.expertType,
          personaText: personaTextOf(presetRows, detail.plugin),
        });
        return h('div', { className: 'dsh-mcp-overlay', onClick: (e) => !busy && e.target === e.currentTarget && setDetail(null) },
          h('div', { className: 'dsh-mcp-modal dsh-mcp-wb-modal', role: 'dialog', 'aria-modal': true, 'aria-label': t('专家详情'), tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); setDetail(null); } } },
            h('h3', null, t('{0}（{1}）', [detail.name, detail.profession])),
            h('div', { className: 'dsh-mcp-card-vendor' }, detail.categoryName || detail.categoryId || ''),
            detail.loading
              ? h('p', { className: 'dsh-mcp-wb-modal-note' }, t('正在拉取人设与技能清单…'))
              : h('div', null,
                  detail.detailError ? h('p', { className: 'dsh-mcp-wb-error' }, detail.detailError) : null,
                  detail.description ? h('p', { className: 'dsh-mcp-wb-modal-desc' }, detail.description) : null,
                  detail.quickPrompts && detail.quickPrompts.length
                    ? h('div', { className: 'dsh-mcp-wb-examples' },
                        h('b', null, t('试试这样问')),
                        h('ul', null, detail.quickPrompts.slice(0, 3).map((prompt, index) => h('li', { key: index }, prompt))),
                      )
                    : null,
                  Array.isArray(detail.skills)
                    ? h('div', { className: 'dsh-mcp-card-tags' },
                        detail.skills.length
                          ? detail.skills.map((skill) => h(Badge, { key: skill.name, cls: skill.local ? 's-on' : '' }, t('{0}{1}', [skill.name, skill.local ? t('（本机可完整安装）') : t('（仅 SKILL.md）')])))
                          : h(Badge, null, t('无捆绑技能')),
                      )
                    : null,
                  detail.persona
                    ? h('div', { className: 'dsh-mcp-skill-d-sec' },
                        h('b', null, t('人设正文（{0} 字符，召唤后成为会话系统提示）', [detail.personaChars || detail.persona.length])),
                        h('pre', { className: 'dsh-mcp-skill-d-md' }, detail.persona.length > 4000 ? detail.persona.slice(0, 4000) + t('\n…（预览截断，召唤时写入完整正文）') : detail.persona),
                      )
                    : null,
                  // 团队型：先给人看编制（成员是谁、负责什么），再决定召唤。
                  detail.expertType === 'team' && Array.isArray(detail.members) && detail.members.length
                    ? h('div', { className: 'dsh-mcp-skill-d-sec' },
                        h('b', null, t('团队编制（{0} 人 · 召唤后成员人设落盘，由主理人调度）', [detail.members.length])),
                        h('ul', { className: 'dsh-mcp-wb-roster' },
                          detail.members.map((member) => h('li', { key: member.id },
                            h('b', null, member.name || member.id),
                            h('span', { className: 'dsh-mcp-wb-roster-role' }, member.role === 'lead' ? t('主理人') : member.profession || t('成员')),
                            member.profession && member.role === 'lead' ? h('span', { className: 'dsh-mcp-wb-roster-prof' }, t('（{0}）', [member.profession])) : null,
                          )),
                        ),
                      )
                    : null,
                  detail.expertType === 'team'
                    ? h('p', { className: 'dsh-mcp-wb-modal-note' },
                        t('团队型走 DSH 桥接：主理人人设接管会话，') +
                        t('每位成员的人设落盘到 ~/.dsh/wb-market/experts/teams/ 下，主理人按 SOP 依次用 subagent 调度（人设正文注入 prompt），') +
                        t('成员产出回传主理人汇总。WorkBuddy 的 TeamCreate 无需调用 —— 团队编制在召唤时已固定。'))
                    : null,
                  detail.expertType !== 'team'
                    ? h('label', { className: 'dsh-mcp-check' },
                        h('input', { type: 'checkbox', checked: withSkills, disabled: busy, onChange: (e) => setWithSkills(e.target.checked) }),
                        t('一并安装捆绑技能（本机 WorkBuddy 缓存完整安装；无缓存时仅装 SKILL.md）'))
                    : null,
                  h('p', { className: 'dsh-mcp-wb-modal-note' },
                    t('召唤 = 往 profile 补丁写入一条独立 Agent 预设（人设全程接管该预设的会话，标准工具原样保留）；') +
                    t('新建会话时选择「WorkBuddy 专家 · ') + detail.name + t('」即专家接管。送还 = 摘除该预设与已装捆绑技能（热加载，无需重启）。')),
                  // stale 团队行：详情弹层里给出直白解释 + 更新入口（同一条召唤链，upsert 整行重写）。
                  // 判定与卡片按钮同源（detailActions 在上方按 expertCardActions 算出）。
                  detailActions.update
                    ? h('p', { className: 'dsh-mcp-wb-modal-note', style: 'color:var(--dsw-alias-state-warn-primary)' },
                        t('⚠ 这条预设是旧版本召唤写入的：人设缺「DSH 运行时适配」桥接段，用它的新会话主理人只会调不存在的 TeamCreate/Agent，成员子智能体开不出来。点下方「更新预设」重跑召唤即可刷新。'))
                    : null,
                ),
            h('div', { className: 'dsh-mcp-modal-actions' },
              h(Btn, { onClick: () => setDetail(null), disabled: busy, children: t('关闭') }),
              detailActions.update
                ? h(Btn, { primary: true, icon: 'refresh', disabled: busy || detail.loading, onClick: () => summon(detail), children: busy ? t('更新中…') : t('更新预设') })
                : null,
              detailActions.dismiss
                ? h(Btn, { danger: true, icon: 'trash', disabled: busy || detail.loading, onClick: () => dismiss(detail), children: t('送还') })
                : null,
              detailActions.summon
                ? h(Btn, { primary: true, icon: 'plus', disabled: busy || detail.loading, onClick: () => summon(detail), children: busy ? t('召唤中…') : detail.expertType === 'team' ? t('召唤专家团') : t('召唤') })
                : null,
            ),
          ),
        );
      })()
      : null,
  );
};

// ── 输入框召唤菜单（WorkBuddy 式快速调用）────────────────────────────
// 会话输入框工具行右侧（conversation.input.right）的一个小图标：点击弹三分类菜单
// （技能 / MCP / 专家），悬停分类展开「最近使用 / 新装」子菜单，点击条目 =
// 把一条引用写进输入框草稿（技能 /name slash、MCP 点名工具前缀），并上报最近使用。
// 专家条目特殊：点击 = 调本插件 expertAttach 把专家人设**挂到当前会话**（随时挂/换/
// 摘，不走 agentPresets.select 预设通道——那条路会把预设写进会话投影且开过口锁死），
// 输入框下方出现专家 chip（可移除）。数据源：本插件既有 Remote + 官方 agentPresets Remote。
// 团队型 stale 体检的判定标记：与后端 lib/expert-market.js 的 TEAM_BRIDGE_MARKER 保持一致。
const TEAM_BRIDGE_MARKER = '## DSH 运行时适配（团队协作桥接）';
// 专家卡片该给哪些按钮：**纯函数放模块作用域**（同 CONTROLS_THRESHOLD 那一带的理由）——
// 这段判定原先内联在 JSX 三元里，node 测不到，于是"已召唤 + stale"时「更新预设」被写进了
// summoned===false 的恒假分支，按钮根本不渲染、点了当然没反应（1.9.4 真机 bug）。
//   update —— 已召唤、团队型、人设缺桥接段：给「更新预设」（后端 upsert 原地重写该行）；
//   dismiss —— 已召唤：给「送还」；
//   summon —— 未召唤：给「召唤」。
// update 与 dismiss **并列**（不是二选一）：用户可能只想删掉这条旧行，而不是更新它。
const expertCardActions = ({ summoned, expertType, personaText }) => ({
  update: Boolean(summoned) && expertType === 'team' && !String(personaText || '').includes(TEAM_BRIDGE_MARKER),
  dismiss: Boolean(summoned),
  summon: !summoned,
});
// 面板里给某条预设行找人设正文；找不到返回 ''（当作"没有桥接段"——宁可多提示一次更新，
// 也不要让一条读不出来的旧行悄悄用坏人设开新会话）。
const personaTextOf = (rows, plugin) => (Array.isArray(rows) ? rows.find((row) => row?.plugin === plugin)?.personaText : '') || '';
const QUICK_MENU_KINDS = [
  { key: 'skill', label: t('技能'), icon: 'skill', hint: t('技能按需触发：选择后以 /技能名 插入输入框') },
  { key: 'mcp', label: 'MCP', icon: 'plug', hint: t('MCP 工具按 server 生效：选择后点名 mcp__服务__* 工具') },
  { key: 'expert', label: t('专家'), icon: 'expert', hint: t('专家随时挂/换/摘：点一个即接管本会话，再点别的直接换，点 chip 的 × 取消') },
];
// 子菜单列表每屏固定 6 行（6 × 28px），更多条目在 .dsh-mcp-quick-list 里纵向滚动；
// 「最近」徽章只标最近池里的前 6 名（首屏可见的那批），避免整列都是徽章。
// 专家预设显示名前缀：召唤时写死的 `WorkBuddy 专家 · <显示名>`（见 expert-market.js
// buildExpertPresetRow），宿主的会话头预设标签原样显示它——用来识别「那条会过期的标签」。
const EXPERT_PRESET_LABEL_PREFIX = t('WorkBuddy 专家 · ');
// 专家挂载状态的最小事件总线：快速菜单挂/换/摘专家后立刻通知会话头徽章与菜单 chip，
// 三处显示同一帧内对齐（不再各自等重挂载）。低频轮询只作兜底，覆盖「别的入口挂的专家」。
const expertChangeListeners = new Set();
const emitExpertChange = () => {
  for (const listener of [...expertChangeListeners]) {
    try { listener(); } catch { /* 单个订阅者失败不影响其它订阅者 */ }
  }
};
const onExpertChange = (listener) => {
  expertChangeListeners.add(listener);
  return () => { expertChangeListeners.delete(listener); };
};
// 引用文本格式（对齐宿主真实语义，避免「同名空文档」）：
//   skill → /name：slash token 命中技能源 lexicon（dsh-client-ui-skill 的 skill source，
//     trigger "/"），发送后走官方 skill gesture，模型真正调起技能——@name 会落进
//     「@文件/会话」引用语义，技能名不是文件，模型读不到就报「文件不存在」。
//   mcp → 明确点名 mcp__<server>__ 工具前缀：MCP 工具没有 slash 语义，直接给模型
//     可执行的指令比插一个会被当文件解析的 @token 更实在。
//   expert → 不在这里出文本：专家条目点击 = expertAttach 直接挂到当前会话（onClick
//     分支不走 pick），历史上那句「请以预设处理」是死代码——删除并留此说明。
const quickMentionText = (kind, item) => {
  if (kind === 'mcp') {
    const server = String(item.name || '');
    return /^[\w-]+$/.test(server) ? t('请使用 {0} 的 MCP 工具（mcp__{1}__*）处理接下来的任务', [server, server]) : t('{0}：', [server]);
  }
  const token = String(item.name || '');
  return /^[\w-]+$/.test(token) ? `/${token} ` : t('{0}：', [token]);
};
const SummonQuickMenu = ({ call, inputActions, sessionId: sessionIdProp }) => {
  const [open, setOpen] = useState(false);
  const [hoverKind, setHoverKind] = useState(null);
  const [recent, setRecent] = useState(null); // { skill: [], mcp: [], expert: [] }
  const [listError, setListError] = useState('');
  const [copied, setCopied] = useState('');
  // 子菜单翻转：展开后实测子菜单底边是否越过视口下缘，越界则给该行加 flip（向上展开）。
  // 只在展开/hoverKind 变化时测一次（临时浮层，不监听滚动缩放）。
  const [flipKinds, setFlipKinds] = useState(() => new Set());
  const rowRefs = useRef(new Map());
  const rootRef = useRef(null);
  const closeTimer = useRef(null);
  const cancelClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } };
  // scheduleClose 在 JSX 前定义（rootHoverProps 用它）；此处不重复声明。

  // 菜单打开时拉一次各类清单。清单取全量（不做 6 条截断），交给子菜单自己
  // 「最近使用置顶 + 每屏 6 行滚动」展示；三类并行取，任何一类失败不影响其它类。
  // MCP 行字段是 serverName（gateway list() 的行形状，与面板列表同一来源）；禁用的不进菜单。
  const loadRecent = useCallback(async () => {
    setListError('');
    const [recentRes, skillsRes, mcpRes, expertRes] = await Promise.all([
      call('wbExpertRecent'),
      call('listSkills', skillScopeArg('global')),
      call('list'),
      call('wbExpertInstalled'),
    ]);
    const kinds = recentRes?.ok && recentRes.kinds ? recentRes.kinds : {};
    const skillRows = skillsRes?.ok && Array.isArray(skillsRes.skills) ? skillsRes.skills : [];
    const mcpRows = mcpRes?.ok && Array.isArray(mcpRes.servers) ? mcpRes.servers.filter((server) => !server.disabled && server.serverName) : [];
    const expertRows = expertRes?.ok && Array.isArray(expertRes.presets) ? expertRes.presets : [];
    setRecent({
      skill: skillRows.map((row) => ({ name: row.name, description: row.description || row.whenToUse || '' })),
      mcp: mcpRows.map((row) => ({ name: row.serverName, description: row.url || row.command || row.transport || '' })),
      expert: expertRows.map((row) => ({ plugin: row.plugin, name: row.plugin, presetId: row.presetId })),
      recentSkill: Array.isArray(kinds.skill) ? kinds.skill : [],
      recentMcp: Array.isArray(kinds.mcp) ? kinds.mcp : [],
      recentExpert: Array.isArray(kinds.expert) ? kinds.expert : [],
    });
  }, [call]);
  useEffect(() => {
    if (open && recent === null) loadRecent().catch((e) => setListError(String(e?.message || e)));
    if (!open) setRecent(null);
  }, [open, recent, loadRecent]);

  // ── 主菜单 fixed 定位（页面不动的根修）────────────────────────────────
  // 菜单原来 position:absolute 锚在图标上：attachNote/新建按钮让菜单变高时，
  // 向上伸展改变祖先滚动容器的可滚动区，会话页滚动位置跟着跳一下。改为
  // position:fixed（脱离滚动容器）+ 打开时实测 trigger 的视口坐标定位：
  // 菜单再高也只是视口内的浮层，页面滚动零位移。翻转/关闭判定不受影响。
  const menuRef = useRef(null);
  const [menuPos, setMenuPos] = useState(null);
  useEffect(() => {
    if (!open) { setMenuPos(null); return; }
    const measure = () => {
      const trigger = rootRef.current?.querySelector('.dsh-mcp-quick-trigger');
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = menuRef.current?.offsetWidth || 148;
      // 默认贴 trigger 左缘、向上弹出；右缘越界时右对齐，顶部空间不足时向下弹出。
      const left = Math.min(rect.left, Math.max(4, window.innerWidth - width - 4));
      const style = { position: 'fixed', left: Math.round(left) + 'px' };
      const needsUp = rect.top > window.innerHeight / 2;
      if (needsUp) style.bottom = Math.round(window.innerHeight - rect.top + 6) + 'px';
      else style.top = Math.round(rect.bottom + 6) + 'px';
      setMenuPos(style);
    };
    measure();
    // 首帧菜单宽度未知（offsetWidth=0）时，挂载后再量一次补正。
    const raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // 子菜单翻转测量：hoverKind 变化且子菜单已挂载后，实测几何再决定 flip。
  // 布局在一帧内即可稳定（子菜单定位纯 CSS），rAF 双保险避免读到中间态。
  useEffect(() => {
    if (!open || !hoverKind) return;
    let alive = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!alive) return;
      const row = rowRefs.current.get(hoverKind);
      const sub = row ? row.querySelector('.dsh-mcp-quick-sub') : null;
      if (!row || !sub) return;
      const rect = sub.getBoundingClientRect();
      const overflowBottom = rect.bottom - (window.innerHeight || document.documentElement.clientHeight);
      setFlipKinds((prev) => {
        const shouldFlip = overflowBottom > 8;
        if (prev.has(hoverKind) === shouldFlip) return prev;
        const next = new Set(prev);
        if (shouldFlip) next.add(hoverKind); else next.delete(hoverKind);
        return next;
      });
    }));
    return () => { alive = false; };
  }, [open, hoverKind, recent]);

  // 点击外部关闭 + Esc 关闭（与面板其它弹层同一惯用法）。
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => { if (rootRef.current && !rootRef.current.contains(e.target)) { setOpen(false); setHoverKind(null); } };
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); setHoverKind(null); } };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('click', onDocClick); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // 选用动作：把引用插进输入框光标处 + 上报最近使用。
  // 写通道（按优先级）：
  //   ① inputActions.insertText(text, captureInsertion()) —— composer 的 standard provide channel
  //     （InputBar 同款 useInput/inputActions），在光标处插入并保留现有草稿，最贴近 WorkBuddy；
  //   ② inputActions.setDraft(现草稿 + 引用) —— insertText 不可用时的整草稿兜底；
  //   ③ 复制进剪贴板 + 按钮上闪现「已复制」（绝不跳走：跳页是上一版的行为缺陷）。
  const pick = async (kind, item, text) => {
    setOpen(false); setHoverKind(null);
    // 上报最近使用（失败静默：纯增值数据）。expert 不经 pick（点击分支直接 attachExpert）。
    const row = kind === 'mcp' ? { serverName: item.name } : { name: item.name };
    call('wbExpertRecordUse', { kind, row }).catch(() => {});
    const insertion = typeof text === 'string' ? (text.endsWith(' ') ? text : text + ' ') : String(text);
    if (inputActions && typeof inputActions.captureInsertion === 'function' && typeof inputActions.insertText === 'function') {
      try {
        const span = inputActions.captureInsertion();
        if (span && inputActions.insertText(insertion, span)) return;
      } catch { /* 光标插入失败走 setDraft 兜底 */ }
    }
    if (inputActions && typeof inputActions.setDraft === 'function') {
      try {
        const current = typeof inputActions.snapshot?.draft === 'string' ? inputActions.snapshot.draft : '';
        const needsSpace = current !== '' && !/\s$/.test(current);
        inputActions.setDraft(current + (needsSpace ? ' ' : '') + insertion.trim());
        return;
      } catch { /* 整草稿失败走剪贴板 */ }
    }
    try {
      await navigator.clipboard.writeText(insertion.trim());
      setCopied(insertion.trim());
      setTimeout(() => setCopied(''), 1600);
    } catch { /* 剪贴板不可用：静默 */ }
  };

  // 子菜单排序：最近使用的条目按 usedAt 新→旧置顶（带「最近」标记，只标首屏 6 个），
  // 未命中最近记录的排在后面保持注册表原序。主键 per kind：skill/mcp=条目名，expert=plugin。
  const recentListFor = (kind) => (kind === 'skill' ? recent.recentSkill : kind === 'mcp' ? recent.recentMcp : recent.recentExpert);
  const itemKeyOf = (kind, item) => String(kind === 'expert' ? (item.plugin || item.name || '') : (item.name || ''));
  const orderSubItems = (kind, items) => {
    const recentRows = recentListFor(kind);
    if (!Array.isArray(recentRows) || !recentRows.length || !Array.isArray(items) || items.length < 2) return items;
    const rankBy = new Map();
    recentRows.forEach((row, index) => rankBy.set(String(row?.name || row?.plugin || row?.serverName || ''), index));
    return items
      .map((item, index) => {
        const rank = rankBy.get(itemKeyOf(kind, item));
        return { item, index, rank: rank === undefined ? Number.MAX_SAFE_INTEGER : rank, usedAt: rank === undefined ? 0 : recentRows[rank].usedAt || 0 };
      })
      .sort((a, b) => a.rank - b.rank || (b.usedAt - a.usedAt) || a.index - b.index)
      .map((entry) => ({ ...entry.item, __recentRank: entry.rank, __badge: entry.rank < 6 }));
  };

  const subItems = (kind) => {
    if (!recent) return null;
    if (kind === 'skill') return orderSubItems(kind, recent.skill);
    if (kind === 'mcp') return orderSubItems(kind, recent.mcp);
    return orderSubItems(kind, recent.expert);
  };
  const itemLabel = (kind, item) => (kind === 'expert' ? item.name || item.plugin : item.name);
  const itemDesc = (kind, item) => (kind === 'mcp' ? (item.transport ? item.transport : '') : (item.description || '').slice(0, 48));

  // ── 挂专家（WorkBuddy 式：随时挂 / 换 / 摘）──────────────────────────────
  // 主通道是宿主新的会话级人设 RPC expertAttach/expertDetach：它把专家人设作为
  // systemPrompt 的「本会话作用域 section」注入（与 dsh-persona / dsh-subagent 同款
  // deployment:persona-prefix 遮蔽机制），因此：
  //   - 不受 agent-preset/locked 限制 —— 会话已开过口也能挂、能换、能摘；
  //   - 只影响这一个会话，不动工具目录、不写任何持久化配置；
  //   - 反复点不同专家 = 直接替换（Host 先摘旧的再装新的），不再是一次性。
  // 挂载只走人设通道（预设通道 agentPresets.select 会在会话投影里留下永不更新的
  // 专家名，造成「顶栏显示 A、实际生效 B」的分叉——见 SessionExpertBadge 注释）。
  // sessionId 来源：conversation.input.right 是 session 座位，slot 渲染时把 sessionId
  // 作为 prop 显式传入（apply() 注册处 inject: (sessionId) => ({ call, sessionId })）；
  // 会话 summary 行本身不带 id 字段（id 只走 props），所以不能从 useSession 投影里取。
  const [attached, setAttached] = useState(null); // { plugin, name, mode: 'persona' }
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachNote, setAttachNote] = useState('');
  const sessionId = typeof sessionIdProp === 'string' && sessionIdProp !== '' ? sessionIdProp : null;
  const attachExpert = async (item, { quiet = false } = {}) => {
    setHoverKind(null);
    if (!sessionId) { setAttachNote(t('没有活动会话：请先进入一个会话再挂专家')); return; }
    setAttachBusy(true); setAttachNote('');
    try {
      // 只走会话级人设通道（expertAttach）：随时挂 / 换 / 摘，会话开过口也不锁。
      // 不再先试 agentPresets.select 预设通道——它成功时会把专家预设写进会话投影，
      // 会话顶栏从此固定显示那个专家，且会话一旦开过口 select 永久锁死，换专家
      // 只换人设不动投影 → 「顶栏显示 A、实际生效 B」的假象。人设通道两边一致。
      const res = await call('expertAttach', { sessionId, plugin: item.plugin });
      if (res && res.ok) {
        setAttached({ plugin: item.plugin, name: res.name || item.name || item.plugin, mode: 'persona' });
        // 团队型追加提示：人设通道不动工具目录，成员要靠 subagent 调度。若当前会话
        // 没有 subagent 工具（预设没带 delegation 组），告诉用户去召唤预设的新会话。
        const teamHint = res.expertType === 'team'
          ? t('；成员由主理人用 subagent 调度——若本会话没有 subagent 工具，请新建会话并选择「WorkBuddy 专家 · {0}」预设', [res.name || item.name || item.plugin])
          : '';
        setAttachNote(t('✓ 已挂到当前会话：') + (res.name || item.name || item.plugin) + (res.replaced ? t('（已替换原专家）') : '') + teamHint);
        call('wbExpertRecordUse', { kind: 'expert', row: { plugin: item.plugin, name: item.name || item.plugin } }).catch(() => {});
        // 立即广播：会话头徽章 + 陈旧预设标签的隐藏同步生效，三处显示同帧对齐。
        emitExpertChange();
      } else {
        setAttachNote(t('挂载失败：') + ((res && res.error) || t('未知错误')));
      }
    } catch (e) {
      if (!quiet) setAttachNote(t('挂载异常：') + String((e && e.message) || e));
    } finally {
      setAttachBusy(false);
    }
  };
  const detachExpert = async () => {
    if (!sessionId) return;
    setAttachBusy(true); setAttachNote('');
    try {
      // 只清会话级人设。挂载只走人设通道（见 attachExpert），不存在「当初走了预设」
      // 的分支，也就无需回退默认预设——预设选择器保持用户自己的选择，不被插件触碰。
      const res = await call('expertDetach', { sessionId }).catch(() => null);
      setAttached(null);
      setAttachNote(res && res.ok && res.removed ? t('✓ 已取消本会话的专家') : t('本会话没有挂着专家'));
      // 摘掉也要广播：会话头徽章退场、被隐身的预设标签复原。
      emitExpertChange();
    } catch (e) {
      setAttachNote(t('取消失败：') + String((e && e.message) || e));
    } finally {
      setAttachBusy(false);
    }
  };
  // 会话切换 / 组件重挂时对齐真实状态：宿主是唯一真源（专家可能由别的入口挂上，
  // 或会话被重启），不能只信组件自己的 state。挂/换/摘后由总线立即触发；
  // 5s 低频轮询兜底外部入口的变更（代价极小：expertActive 只读内存表）。
  useEffect(() => {
    if (!sessionId) return undefined;
    let cancelled = false;
    const sync = () => {
      call('expertActive').then((res) => {
        if (cancelled || !res || !res.ok || !Array.isArray(res.sessions)) return;
        const mine = res.sessions.find((row) => row.sessionId === sessionId);
        setAttached(mine ? { plugin: mine.plugin, name: mine.name, mode: 'persona' } : null);
      }).catch(() => { /* 对齐失败保持现状：不影响使用 */ });
    };
    sync();
    const off = onExpertChange(sync);
    // OPT-05：走可见性感知轮询。标签页隐藏时没人看这份数据，却照样每 5s 打一个
    // expertActive；这里拿不到面板的 timer，startVisibilityAwarePolling 会退回裸
    // setInterval，生命周期仍由下面的 cleanup 独占。
    const stopPoll = startVisibilityAwarePolling(typeof document === 'undefined' ? null : document, null, 5000, sync);
    return () => { cancelled = true; off(); stopPoll(); };
  }, [sessionId, call]);

  // ── 悬停开合（整树统一管理）───────────────────────────────────────────
  // enter/leave 挂组件根，而不是每行：菜单顶部还有提示条/错误行/新建会话按钮，
  // 它们不属于任何 kind 行——行级 mouseleave 在鼠标移进提示区时也会触发，把整个
  // 菜单关掉（「鼠标一过技能菜单就没了」的根因）。根级 leave 才是真正离开菜单。
  // 防抖 180ms 给「行 → 行」的空隙留缓冲；进入任何部分都取消关闭。
  const scheduleClose = () => { cancelClose(); closeTimer.current = setTimeout(() => { setOpen(false); setHoverKind(null); }, 180); };
  const rootHoverProps = {
    onMouseEnter: cancelClose,
    onMouseLeave: scheduleClose,
  };

  return h('div', { className: 'dsh-mcp-quick', ref: rootRef, ...rootHoverProps },
    // 挂载的专家：图标左侧的内联小 chip（与 trigger 同一行，不撑宽不换行）。
    // attachNote 不再渲染独立气泡——错误/提示走 trigger 的 title（悬停可见）。
    attached
      ? h('span', { className: 'dsh-mcp-quick-chip', title: t('本会话由该专家人设接管；点 × 摘掉（不动预设选择器）') },
          h(Icon, { d: ICONS.expert, size: 11 }),
          h('span', { className: 'dsh-mcp-quick-chip-name' }, attached.name),
          h('button', {
            type: 'button',
            className: 'dsh-mcp-quick-chip-x',
            title: t('摘掉专家（切回默认预设）'),
            'aria-label': t('摘掉专家'),
            disabled: attachBusy,
            onClick: (e) => { e.stopPropagation(); detachExpert(); },
          }, h(Icon, { d: ICONS.x, size: 10 })),
        )
      : null,
    h('button', {
      type: 'button',
      className: 'dsh-mcp-quick-trigger' + (open ? ' sel' : ''),
      title: (attachNote ? attachNote + (attached ? t('　') : '') : '') + (attached ? t('已挂专家：') + attached.name + t('（本会话全局生效）　') : '') + t('技能 / MCP / 专家 快速调用'),
      'aria-label': t('打开技能、MCP、专家快速调用菜单'),
      'aria-expanded': open,
      onClick: (e) => { e.stopPropagation(); setOpen((value) => !value); setHoverKind(null); },
    }, h(Icon, { d: ICONS.board, size: 15 })),
    open
      ? h('div', { className: 'dsh-mcp-quick-menu', role: 'menu', 'aria-label': t('快速调用'), ref: menuRef, style: menuPos },
          copied ? h('div', { className: 'dsh-mcp-quick-note' }, t('已复制，粘贴到输入框：') + copied) : null,
          attachBusy ? h('div', { className: 'dsh-mcp-quick-note' }, t('正在挂载专家…')) : null,
          attachNote ? h('div', { className: 'dsh-mcp-quick-note' + (/^✓/.test(attachNote) ? ' ok' : ' err'), role: 'alert' }, attachNote) : null,
          listError ? h('div', { className: 'dsh-mcp-quick-err' }, listError) : null,
          !recent && !listError ? h('div', { className: 'dsh-mcp-quick-loading' }, t('正在读取…')) : null,
          QUICK_MENU_KINDS.map((kind) => {
            const items = subItems(kind.key);
            const expanded = hoverKind === kind.key;
            return h('div', {
              key: kind.key,
              className: 'dsh-mcp-quick-row' + (expanded && flipKinds.has(kind.key) ? ' flip' : ''),
              ref: (el) => { if (el && expanded) rowRefs.current.set(kind.key, el); else rowRefs.current.delete(kind.key); },
              // 悬停开合由根节点统一管理（见 rootHoverProps）：行内只负责展开子菜单。
              onMouseEnter: () => { cancelClose(); setHoverKind(kind.key); },
            },
              h('button', {
                type: 'button',
                role: 'menuitem',
                className: 'dsh-mcp-quick-kind' + (hoverKind === kind.key ? ' sel' : ''),
                'aria-haspopup': 'true',
                'aria-expanded': hoverKind === kind.key,
                // 分类行点击 = 只切换子菜单（绝不跳板）。跳页是上一版缺陷的根因：
                // WorkBuddy 式交互里悬停已展开子菜单，点击再跳管理页属意外导航。
                // 键盘/触屏路径：Enter/点按切换子菜单；管理入口在子菜单底部明确按钮。
                onClick: (e) => { e.stopPropagation(); cancelClose(); setHoverKind((value) => (value === kind.key ? null : kind.key)); },
                title: kind.hint,
              },
                h(Icon, { d: ICONS[kind.icon], size: 13 }),
                h('span', null, kind.label),
                Array.isArray(items) && items.length ? h('span', { className: 'dsh-mcp-quick-count' }, items.length) : null,
                h('span', { className: 'dsh-mcp-quick-arrow', 'aria-hidden': true }, '›'),
              ),
              hoverKind === kind.key
                ? h('div', { className: 'dsh-mcp-quick-sub' + (Array.isArray(items) && items.length ? '' : ' empty'), role: 'menu', 'aria-label': kind.label + t('可选项') },
                    Array.isArray(items) && items.length
                      ? h('div', { className: 'dsh-mcp-quick-list', role: 'group', 'aria-label': kind.label + t('列表（最多显示 6 行，滚动查看更多）') },
                          items.map((item, index) => h('button', {
                            key: item.name || item.plugin || index,
                            type: 'button',
                            role: 'menuitem',
                            className: 'dsh-mcp-quick-item',
                            title: kind.key === 'expert' ? t('挂到当前会话（可随时换或取消）；再点别的专家 = 直接替换') : (itemDesc(kind.key, item) || itemLabel(kind.key, item)),
                            onClick: (e) => { e.stopPropagation(); if (kind.key === 'expert') attachExpert(item); else pick(kind.key, item, quickMentionText(kind.key, item)); },
                          },
                            kind.key === 'expert' && attached && attached.plugin === item.plugin
                              ? h(Badge, { cls: 's-on' }, t('已挂'))
                              : item.__badge
                                ? h('span', { className: 'dsh-mcp-quick-item-badge', 'aria-label': t('最近使用') }, t('最近'))
                                : null,
                            h('span', { className: 'dsh-mcp-quick-item-name' }, itemLabel(kind.key, item)),
                            itemDesc(kind.key, item) ? h('span', { className: 'dsh-mcp-quick-item-desc' }, itemDesc(kind.key, item)) : null,
                          )),
                        )
                      : h('div', { className: 'dsh-mcp-quick-sub-note' }, t('暂无可选项')),
                    h('button', {
                      type: 'button',
                      role: 'menuitem',
                      className: 'dsh-mcp-quick-manage',
                      title: t('打开看板的「') + kind.label + t('」分类管理'),
                      onClick: (e) => { e.stopPropagation(); openBoardCategory(kind.key === 'expert' ? 'expert' : kind.key); },
                    },
                      h('span', { className: 'dsh-mcp-quick-item-name' }, t('管理') + kind.label + '…'),
                    ),
                  )
                : null,
            );
          }),
        )
      : null,
  );
};

// ── 会话头「当前生效专家」徽章（conversation.session.header.actions）──────
// 宿主的 AgentPresetLabel 只读会话的 agentPreset 投影（会话开过口后不再变化），
// 与本插件「随时换专家」的人设通道天然脱节：换专家后顶栏仍显示第一次的预设名。
// 这个 slot 条目显示的是真正生效中的专家（expertActive 对账），与输入框 chip 同源
// 同步——哪个专家在管这个会话，顶栏一眼可见；没挂专家时不渲染任何东西。
// 样式对齐宿主 AgentPresetLabel（同高 22px、同 token），与预设标签并排不突兀；
// 宿主标签在 540px 以下隐藏，本徽章跟随同一断点（container query 无法跨包复用，
// 用媒体查询近似窄窗行为）。
const SessionExpertBadge = ({ call, sessionId }) => {
  const [attached, setAttached] = useState(null);
  const [ready, setReady] = useState(false);
  const badgeRef = useRef(null);
  // 同步真源：宿主 expertActive 是唯一真源（别的入口挂的专家也要认）。挂/换/摘之后
  // 由总线立即触发一次，5s 低频轮询只兜底外部变化；组件重挂载也走同一条路径。
  useEffect(() => {
    if (!sessionId) { setAttached(null); setReady(true); return undefined; }
    let cancelled = false;
    const sync = () => {
      call('expertActive').then((res) => {
        if (cancelled) return;
        const mine = res && res.ok && Array.isArray(res.sessions)
          ? res.sessions.find((row) => row.sessionId === sessionId)
          : null;
        setAttached(mine ? { plugin: mine.plugin, name: mine.name } : null);
        setReady(true);
      }).catch(() => { if (!cancelled) setReady(true); });
    };
    setReady(false);
    sync();
    const off = onExpertChange(sync);
    // OPT-05：同上，徽章这一处也改走可见性感知轮询。
    const stopPoll = startVisibilityAwarePolling(typeof document === 'undefined' ? null : document, null, 5000, sync);
    return () => { cancelled = true; off(); stopPoll(); };
  }, [sessionId, call]);
  // 挂上专家时，把同容器里那条**陈旧的预设标签**藏掉：它读的是会话创建时的
  // agentPreset 投影（宿主只读、换专家不动它），所以换到第二个专家后它仍显示第一个，
  // 与真正生效的人设相反——三处显示里唯一会「说谎」的一处。只藏带本插件专家预设
  // 前缀（WorkBuddy 专家）的那条，默认预设标签与其他插件条目一律不碰；摘掉专家后
  // 立即恢复（原生 <span> 一直被 React 管着，我们只临时加 class，不移动/不删除节点）。
  // 对账幂等：每轮把「现在不该藏」的还原回显；观察 class 变化是为了宿主重渲染覆盖
  // className 后能补回（React 只在 props 变化时才写，稳态不会抖）。
  useEffect(() => {
    if (!attached || typeof document === 'undefined') return undefined;
    let stop = null;
    const isStalePreset = (node) => String(node.textContent || '').trim().startsWith(EXPERT_PRESET_LABEL_PREFIX);
    // 作用域 = 能同时容纳「本徽章」与「宿主播条目」的最近祖先（正常就是 headerActions
    // 容器）；若父层只是个包装且里面没有目标条目，再上探一层（最多 3 层，防止飘到整页
    // 把看板/菜单里同名前缀的文本一起误藏）。
    // 体量保险丝：正常 headerActions 容器只有几个 span；候选容器一旦大到此量级，
    // 说明作用域已经飘到会话体（几百条 tool card），必须直接放弃对账——否则
    // subtree 监听会把整个会话纳入观察，流式输出时每帧都要跑一遍全量对账。
    const tooBig = (node) => !node || node.querySelectorAll('span').length > 80;
    const resolveScope = () => {
      const own = badgeRef.current;
      if (!own) return null;
      let node = own.parentElement;
      for (let i = 0; i < 3 && node; i++) {
        if (tooBig(node)) return null;
        const others = [...node.querySelectorAll('span')].filter((s) => s !== own && !s.contains(own));
        if (others.some(isStalePreset)) return node;
        node = node.parentElement;
      }
      const fallback = own.parentElement;
      return tooBig(fallback) ? null : fallback;
    };
    const reconcile = () => {
      const scope = resolveScope();
      const own = badgeRef.current;
      if (!scope || !own) return;
      for (const node of scope.querySelectorAll('span')) {
        const keep = node === own || node.contains(own) || !isStalePreset(node);
        if (keep) node.classList.remove('dsh-mcp-hide-stale-preset');
        else node.classList.add('dsh-mcp-hide-stale-preset');
      }
    };
    // 回调改为排队执行：绝不与 React 的提交同步拉锯。
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => { scheduled = false; reconcile(); });
    };
    const raf = requestAnimationFrame(() => {
      reconcile();
      const scope = resolveScope();
      if (!scope) return;
      // ★ 关键修复：必须只观察结构变化。
      //   characterData:true → 流式输出每吐一个 token 都触发一轮全量对账；
      //   attributes/class → 我们写进去的 class 会被自己的观察器听见（自喂回路）。
      //   两者叠加 = 主线程被占死（整窗点不动）。宿主重建 span 的情况仍由 childList 覆盖。
      stop = new MutationObserver(schedule);
      stop.observe(scope, { childList: true, subtree: true });
    });
    return () => {
      cancelAnimationFrame(raf);
      stop?.disconnect();
      // 摘掉专家 / 组件卸载：全部复原（只摘我们加的那个 class）。
      for (const node of document.querySelectorAll('.dsh-mcp-hide-stale-preset')) {
        node.classList.remove('dsh-mcp-hide-stale-preset');
      }
    };
  }, [attached]);
  if (!ready || !attached) return null;
  return h('span', {
    className: 'dsh-mcp-head-expert',
    ref: badgeRef,
    title: t('当前生效专家（人设接管本会话；可在输入框工具行的专家菜单随时换/摘）'),
  },
    h(Icon, { d: ICONS.expert, size: 13, className: 'dsh-mcp-head-expert-icon' }),
    h('span', { className: 'dsh-mcp-head-expert-name' }, attached.name),
  );
};
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
// ── 市场面板：WorkBuddy 连接器 / 内置 MCP / SkillHub 技能三个子标签 ──────────────
// 市场搜索框：左内置放大镜、圆角胶囊、聚焦高亮、右一键清空。
// 三处复用（连接器 / 内置 MCP / 技能）：连接器与内置是纯本地过滤，输入即过滤；
// 技能走服务端搜索，onCommit 由防抖或回车触发（见 WorkBuddyMarket 内注释）。
const WbSearchBox = ({ value, onChange, placeholder, disabled, onCommit }) =>
  h('div', { className: 'dsh-mcp-wb-search' },
    h('span', { className: 'dsh-mcp-wb-search-ico', 'aria-hidden': true }, h(Icon, { d: ICONS.search, size: 14 })),
    h('input', {
      type: 'search', className: 'dsh-mcp-wb-search-input', placeholder,
      value, disabled, spellCheck: false,
      onChange: (e) => onChange(e.target.value),
      onKeyDown: onCommit
        ? (e) => { if (e.key === 'Enter') { e.preventDefault(); onCommit(); } }
        : undefined,
    }),
    value && !disabled
      ? h('button', {
          type: 'button', className: 'dsh-mcp-wb-search-clear', title: t('清空'),
          'aria-label': t('清空搜索'),
          onClick: () => { onChange(''); if (onCommit) onCommit(); },
        }, h(Icon, { d: ICONS.x, size: 12 }))
      : null,
  );
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
      if (!res?.ok) throw new Error(res?.error || t('读取连接器目录失败'));
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
      if (!res?.ok) throw new Error(res?.error || t('读取技能目录失败'));
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

  // 技能搜索：输入即搜（服务端 keyword），550ms 防抖合并连击；回车立即搜。
  // 之前是「输入存草稿、提交才生效」的两段式——那要求按钮真的能提交（而 Btn 写死
  // type=button，点击永不触发 onSubmit），结果只剩回车一条路。现在删掉表单，
  // 输入与生效同一状态，防抖只是省 API 配额。
  useEffect(() => {
    const timer = setTimeout(() => {
      setSkillPage(1);
      setSkillKeyword(skillKeywordInput);
    }, 550);
    return () => clearTimeout(timer);
  }, [skillKeywordInput]);

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
    setBusy(true); setBusyLabel(t('正在安装 {0}…', [item.name])); setError('');
    try {
      const res = await call('wbConnectorInstall', { connectorId: item.id, mode: 'merge' });
      if (!res?.ok) throw new Error(res?.error || t('安装失败'));
      setNote(t('{0}：{1}', [item.name, res.note || t('已写入 MCP 配置')]));
      setConnectorDetail(null);
      await loadConnectors();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false); setBusyLabel('');
    }
  };
  const installSkill = async (skill) => {
    setBusy(true); setBusyLabel(t('正在下载并校验 {0}…', [skill.name])); setError('');
    try {
      const res = await call('wbSkillInstall', { slug: skill.slug, namespace: skill.namespace, name: skill.name });
      if (!res?.ok) throw new Error(res?.error || t('安装失败'));
      setNote(t('{0}：{1}', [skill.name, res.note || t('已安装')]));
      setSkillDetail(null);
      await loadInstalled();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false); setBusyLabel('');
    }
  };
  const uninstallSkill = async (skill) => {
    setBusy(true); setBusyLabel(t('正在卸载 {0}…', [skill.name])); setError('');
    try {
      const res = await call('wbSkillUninstall', { slug: skill.slug, namespace: skill.namespace });
      if (!res?.ok) throw new Error(res?.error || t('卸载失败'));
      setNote(t('{0}：{1}', [skill.name, res.note || t('已卸载')]));
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
      if (!res?.ok) throw new Error(res?.error || t('读取详情失败'));
      setSkillDetail({ ...skill, ...res, loading: false });
    } catch (e) {
      setSkillDetail({ ...skill, loading: false, detailError: String(e?.message || e) });
    }
  };

  // ── 内置 MCP 目录（第三 tab）：与全局 MCP 市场同一份目录，直接可装 ──
  const [builtins, setBuiltins] = useState([]);
  const [builtinQuery, setBuiltinQuery] = useState('');
  const [builtinCategory, setBuiltinCategory] = useState('all');
  const [builtinOnlyReady, setBuiltinOnlyReady] = useState(false);
  const [builtinsLoading, setBuiltinsLoading] = useState(false);
  const [builtinError, setBuiltinError] = useState('');
  const loadBuiltins = useCallback(async () => {
    setBuiltinsLoading(true); setBuiltinError('');
    try {
      const res = await call('builtins');
      if (!res?.ok) throw new Error(res?.error || t('读取 MCP 目录失败'));
      setBuiltins(res.builtins || []);
    } catch (e) {
      setBuiltinError(String(e?.message || e));
    } finally {
      setBuiltinsLoading(false);
    }
  }, [call]);
  useEffect(() => {
    if (tab === 'builtin' && !builtins.length && !builtinsLoading) loadBuiltins();
  }, [tab, builtins.length, builtinsLoading, loadBuiltins]);
  const builtinNeedsKey = (item) => Array.isArray(item.envKeys) && item.envKeys.length > 0;
  const builtinNeedsConfig = (item) => Array.isArray(item.configKeys) && item.configKeys.length > 0;
  const builtinNeedsArgs = (item) => Array.isArray(item.placeholders) && item.placeholders.length > 0;
  const builtinReady = (item) => !builtinNeedsKey(item) && !builtinNeedsConfig(item) && !builtinNeedsArgs(item);
  const builtinCategories = useMemo(() => {
    const counts = new Map();
    for (const item of builtins) {
      const key = item.category || 'other';
      const entry = counts.get(key) || { label: item.categoryLabel || key, count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
    return [...counts.entries()].map(([key, entry]) => ({ key, ...entry }));
  }, [builtins]);
  const builtinQueryKey = builtinQuery.trim().toLowerCase();
  const filteredBuiltins = builtins.filter((item) => {
    if (builtinCategory !== 'all' && (item.category || 'other') !== builtinCategory) return false;
    if (builtinOnlyReady && !builtinReady(item)) return false;
    if (!builtinQueryKey) return true;
    return [item.label, item.id, item.name, item.summary, item.vendor, item.access].filter(Boolean).join(' ').toLowerCase().includes(builtinQueryKey);
  });
  const installBuiltin = async (item) => {
    setBusy(true); setBusyLabel(t('正在安装 {0}…', [item.label])); setError('');
    try {
      const res = await call('installBuiltins', { ids: [item.id] });
      if (!res?.ok) throw new Error(res?.error || t('安装失败'));
      setNote(t('{0}：{1}', [item.label, res.note || t('已安装')]));
      await loadBuiltins();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false); setBusyLabel('');
    }
  };

  const connectorSearch = h(WbSearchBox, {
    value: connectorQuery, placeholder: t('搜索连接器（名称 / 说明 / ID）'), disabled: loading,
    onChange: (value) => { setConnectorQuery(value); setConnectorPage(1); },
  });
  const skillSearch = h(WbSearchBox, {
    value: skillKeywordInput, placeholder: t('搜索 SkillHub 技能（19 万+）'), disabled: loading,
    onChange: (value) => setSkillKeywordInput(value),
    // 回车跳过防抖立即生效（防抖本身也会触发，双保险但幂等）。
    onCommit: () => { setSkillPage(1); setSkillKeyword(skillKeywordInput); },
  });

  const skillPageCount = Math.max(1, Math.ceil(skillTotal / WB_PAGE_SIZE));
  const skillMeta = skillTotal
    ? t('第 {0} / {1} 页 · 共 {2} 个技能', [skillPage, skillPageCount, wbFormatCount(skillTotal)])
    : '';

  return h('div', { className: 'dsh-mcp-wb' },
    h('div', { className: 'dsh-mcp-wb-tabs', role: 'tablist', 'aria-label': t('WorkBuddy 市场') },
      h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'connector', className: 'dsh-mcp-wb-tab' + (tab === 'connector' ? ' sel' : ''), onClick: () => setTab('connector') },
        t('连接器（MCP）'), h('span', { className: 'dsh-mcp-cat-count' }, connectors.length)),
      h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'builtin', className: 'dsh-mcp-wb-tab' + (tab === 'builtin' ? ' sel' : ''), onClick: () => setTab('builtin') },
        t('内置 MCP'), h('span', { className: 'dsh-mcp-cat-count' }, builtins.length)),
      h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'skill', className: 'dsh-mcp-wb-tab' + (tab === 'skill' ? ' sel' : ''), onClick: () => setTab('skill') },
        t('技能（SkillHub）')),
      h('button', { type: 'button', role: 'tab', 'aria-selected': tab === 'expert', className: 'dsh-mcp-wb-tab' + (tab === 'expert' ? ' sel' : ''), onClick: () => setTab('expert') },
        t('专家（召唤）')),
    ),
    h('div', { className: 'dsh-mcp-wb-disclaim' },
      t('直连读取：连接器来自 WorkBuddy 官方分发（static.workbuddy.cn），技能来自 SkillHub 公开 API，专家来自 WorkBuddy 专家中心分发。本面板只是浏览与召唤入口，') +
      t('内容版权归原作者所有；第三方接口的字段可能随上游改版变化。')),
    tab === 'connector'
      ? h('div', { className: 'dsh-mcp-wb-toolbar' },
          connectorSearch,
          h('label', { className: 'dsh-mcp-check' },
            h('input', { type: 'checkbox', checked: connectorOnlyReady, disabled: loading, onChange: (e) => { setConnectorOnlyReady(e.target.checked); setConnectorPage(1); } }),
            t('只看可直接安装')),
          h('span', { className: 'dsh-mcp-builtin-count' },
            t('显示 {0} / {1}', [visibleConnectors.length, filteredConnectors.length]) + (connectorSource === 'network' ? t(' · 已更新') : connectorSource === 'disk' ? t(' · 缓存') : '')),
        )
      : tab === 'builtin'
        ? h('div', { className: 'dsh-mcp-wb-toolbar' },
            h(WbSearchBox, {
              value: builtinQuery, placeholder: t('搜索服务、用途或提供方…'),
              onChange: (value) => setBuiltinQuery(value),
            }),
            h('label', { className: 'dsh-mcp-check' },
              h('input', { type: 'checkbox', checked: builtinOnlyReady, onChange: (e) => setBuiltinOnlyReady(e.target.checked) }),
              t('只要免密钥')),
            h('select', {
              className: 'dsh-mcp-input dsh-mcp-wb-sort', value: builtinCategory,
              onChange: (e) => setBuiltinCategory(e.target.value),
            }, h('option', { key: 'all', value: 'all' }, t('全部分类')),
              builtinCategories.map((cat) => h('option', { key: cat.key, value: cat.key }, cat.label + t('（') + cat.count + t('）')))),
            h('span', { className: 'dsh-mcp-builtin-count' }, t('显示 {0} / {1}', [filteredBuiltins.length, builtins.length])),
          )
        : tab === 'expert'
          ? null
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
    loading && !connectors.length && tab === 'connector' ? h('div', { className: 'dsh-mcp-wb-empty' }, t('正在读取连接器目录…')) : null,
    loading && !skills.length && tab === 'skill' ? h('div', { className: 'dsh-mcp-wb-empty' }, t('正在读取技能目录…')) : null,
    !loading && tab === 'connector' && !visibleConnectors.length ? h('div', { className: 'dsh-mcp-wb-empty' }, t('没有匹配的连接器，换个关键词试试')) : null,
    !loading && tab === 'skill' && !skills.length ? h('div', { className: 'dsh-mcp-wb-empty' }, t('没有匹配的技能')) : null,
    tab === 'connector' && visibleConnectors.length
      ? h('div', { className: 'dsh-mcp-wb-grid' },
          visibleConnectors.map((item) => h('div', { key: item.id, className: 'dsh-mcp-card wb' + (item.installable ? '' : ' off') },
            h('div', { className: 'dsh-mcp-card-top' },
              h('div', null, h('div', { className: 'dsh-mcp-card-name' }, item.name)),
              h(Badge, { cls: item.installable ? 's-on' : '' }, item.installable ? t('可安装') : t('仅展示')),
            ),
            h('div', { className: 'dsh-mcp-card-summary' }, item.description || item.nameEn || item.id),
            h('div', { className: 'dsh-mcp-card-tags' },
              item.skillCount ? h(Badge, null, t('含 {0} 技能', [item.skillCount])) : null,
              item.transport ? h(Badge, { cls: item.transport === 'streamable-http' ? 't-http' : 't-stdio' }, item.transport === 'streamable-http' ? 'HTTP' : 'stdio') : null,
              item.authMode ? h(Badge, null, item.authMode) : null,
            ),
            h('div', { className: 'dsh-mcp-wb-card-actions' },
              h('button', { type: 'button', className: 'dsh-mcp-btn', onClick: () => openConnectorDetail(item) }, t('详情')),
              item.installable
                ? h('button', { type: 'button', className: 'dsh-mcp-btn primary', disabled: busy, onClick: () => installConnector(item) }, t('安装'))
                : h('span', { className: 'dsh-mcp-wb-blocked', title: item.blockedReason }, item.blockedReason ? t('不兼容：') + item.blockedReason : ''),
            ),
          )),
        )
      : null,
    tab === 'connector' && connectorPageCount > 1
      ? h('div', { className: 'dsh-mcp-wb-pager' },
          h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: safeConnectorPage <= 1, onClick: () => setConnectorPage(safeConnectorPage - 1) }, t('上一页')),
          h('span', { className: 'dsh-mcp-builtin-count' }, `${safeConnectorPage} / ${connectorPageCount}`),
          h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: safeConnectorPage >= connectorPageCount, onClick: () => setConnectorPage(safeConnectorPage + 1) }, t('下一页')),
        )
      : null,
    tab === 'builtin' && builtinError
      ? h('div', { className: 'dsh-mcp-wb-error', role: 'alert' }, builtinError, ' ',
          h('button', { type: 'button', className: 'dsh-mcp-btn', onClick: loadBuiltins, disabled: builtinsLoading }, t('重试')))
      : null,
    tab === 'builtin' && !builtinError && !filteredBuiltins.length
      ? h('div', { className: 'dsh-mcp-wb-empty' }, builtinsLoading ? t('正在读取 MCP 目录…') : t('没有匹配的服务，换个关键词或分类试试'))
      : null,
    tab === 'builtin' && filteredBuiltins.length
      ? h('div', { className: 'dsh-mcp-wb-grid' },
          filteredBuiltins.map((item) => {
            const http = item.transport === 'streamable-http';
            return h('div', { key: item.id, className: 'dsh-mcp-card wb' + (item.installed ? ' installed' : '') },
              h('div', { className: 'dsh-mcp-card-top' },
                h('div', null,
                  h('div', { className: 'dsh-mcp-card-name' }, item.label),
                  item.vendor ? h('div', { className: 'dsh-mcp-card-vendor' }, item.vendor) : null,
                ),
                item.installed ? h(Badge, { cls: 's-on' }, t('已配置')) : null,
              ),
              h('div', { className: 'dsh-mcp-card-summary' }, item.summary),
              h('div', { className: 'dsh-mcp-card-tags' },
                h(Badge, { cls: http ? 't-http' : 't-stdio' }, http ? 'HTTP' : 'stdio'),
                item.categoryLabel ? h(Badge, null, item.categoryLabel) : null,
                item.installed
                  ? null
                  : builtinNeedsKey(item)
                    ? h(Badge, null, t('需密钥'))
                    : builtinNeedsConfig(item)
                      ? h(Badge, null, t('需连接信息'))
                      : h(Badge, { cls: 's-off' }, t('免密钥')),
                builtinNeedsArgs(item) ? h(Badge, { cls: 's-err' }, t('需填参数')) : null,
              ),
              h('div', { className: 'dsh-mcp-card-access' }, item.access),
              builtinNeedsKey(item) || builtinNeedsConfig(item)
                ? h('div', { className: 'dsh-mcp-card-vars' },
                    builtinNeedsKey(item) ? h('span', null, t('密钥：') + item.envKeys.join(t('、'))) : null,
                    builtinNeedsConfig(item) ? h('span', null, t('连接：') + item.configKeys.join(t('、'))) : null,
                  )
                : null,
              h('div', { className: 'dsh-mcp-wb-card-actions' },
                item.installed
                  ? null
                  : h('button', { type: 'button', className: 'dsh-mcp-btn primary', disabled: busy, onClick: () => installBuiltin(item) }, t('安装')),
                item.homepage
                  ? h('a', { className: 'dsh-mcp-btn', href: item.homepage, target: '_blank', rel: 'noreferrer', title: t('打开官方文档') }, t('文档'))
                  : null,
              ),
            );
          }),
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
                installed ? h(Badge, { cls: 's-on' }, t('已安装')) : null,
              ),
              h('div', { className: 'dsh-mcp-card-summary' }, skill.description || skill.name),
              h('div', { className: 'dsh-mcp-card-tags' },
                h(Badge, null, `↓${wbFormatCount(skill.downloads)}`),
                skill.installs ? h(Badge, null, t('装 {0}', [wbFormatCount(skill.installs)])) : null,
                skill.stars ? h(Badge, null, `★${wbFormatCount(skill.stars)}`) : null,
                skill.verified ? h(Badge, { cls: 's-on' }, t('认证')) : null,
                skill.version ? h(Badge, null, 'v' + skill.version) : null,
                wbFormatDate(skill.updatedAt) ? h(Badge, null, wbFormatDate(skill.updatedAt)) : null,
              ),
              h('div', { className: 'dsh-mcp-wb-card-actions' },
                h('button', { type: 'button', className: 'dsh-mcp-btn', onClick: () => openSkillDetail(skill) }, t('详情')),
                installed
                  ? h('button', { type: 'button', className: 'dsh-mcp-btn danger', disabled: busy, onClick: () => uninstallSkill(skill) }, t('卸载'))
                  : h('button', { type: 'button', className: 'dsh-mcp-btn primary', disabled: busy, onClick: () => installSkill(skill) }, t('安装')),
              ),
            );
          }),
        )
      : null,
    tab === 'skill' && skillPageCount > 1
      ? h('div', { className: 'dsh-mcp-wb-pager' },
          h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: skillPage <= 1 || loading, onClick: () => setSkillPage(skillPage - 1) }, t('上一页')),
          h('span', { className: 'dsh-mcp-builtin-count' }, `${skillPage} / ${skillPageCount}`),
          h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: skillPage >= skillPageCount || loading, onClick: () => setSkillPage(skillPage + 1) }, t('下一页')),
        )
      : null,
    tab === 'expert' ? h(ExpertMarket, { call }) : null,
    // ── 连接器详情弹层：安装前看真实 mcp.json ──
    connectorDetail
      ? h('div', { className: 'dsh-mcp-overlay', onClick: (e) => !busy && e.target === e.currentTarget && setConnectorDetail(null) },
          h('div', { className: 'dsh-mcp-modal dsh-mcp-wb-modal', role: 'dialog', 'aria-modal': true, 'aria-label': t('连接器详情'), tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); setConnectorDetail(null); } } },
            h('h3', null, connectorDetail.name),
            connectorDetail.description ? h('p', { className: 'dsh-mcp-wb-modal-desc' }, connectorDetail.description) : null,
            connectorDetail.examples && connectorDetail.examples.length
              ? h('div', { className: 'dsh-mcp-wb-examples' },
                  h('b', null, t('用法示例')),
                  h('ul', null, connectorDetail.examples.slice(0, 4).map((example, index) => h('li', { key: index }, example))),
                )
              : null,
            h('p', { className: 'dsh-mcp-wb-modal-note' },
              t(`安装 = 把该连接器的 mcpServers 合并写入当前作用域（与「导入 JSON」同一链路，同名跳过）。`) +
              (connectorDetail.skillCount ? t('另含 {0} 个连接器技能，如需请从技能市场或手动安装。', [connectorDetail.skillCount]) : '')),
            h('div', { className: 'dsh-mcp-modal-actions' },
              h(Btn, { onClick: () => setConnectorDetail(null), disabled: busy, children: t('取消') }),
              connectorDetail.installable
                ? h(Btn, { primary: true, icon: 'plus', disabled: busy, onClick: () => installConnector(connectorDetail), children: busy ? t('安装中…') : t('安装到全局') })
                : h('span', { className: 'dsh-mcp-wb-blocked' }, connectorDetail.blockedReason || t('不可安装')),
            ),
          ),
        )
      : null,
    // ── 技能详情弹层：安全报告 + 发布方 + 安装/卸载 ──
    skillDetail
      ? h('div', { className: 'dsh-mcp-overlay', onClick: (e) => !busy && e.target === e.currentTarget && setSkillDetail(null) },
          h('div', { className: 'dsh-mcp-modal dsh-mcp-wb-modal', role: 'dialog', 'aria-modal': true, 'aria-label': t('技能详情'), tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); setSkillDetail(null); } } },
            h('h3', null, skillDetail.name),
            h('div', { className: 'dsh-mcp-card-vendor' }, skillDetail.canonical || skillDetail.namespace || ''),
            skillDetail.loading
              ? h('p', { className: 'dsh-mcp-wb-modal-note' }, t('正在读取详情…'))
              : h('div', null,
                  skillDetail.detailError ? h('p', { className: 'dsh-mcp-wb-error' }, skillDetail.detailError) : null,
                  skillDetail.description ? h('p', { className: 'dsh-mcp-wb-modal-desc' }, skillDetail.description) : null,
                  h('div', { className: 'dsh-mcp-card-tags' },
                    skillDetail.version ? h(Badge, null, 'v' + skillDetail.version) : null,
                    skillDetail.publisher ? h(Badge, null, skillDetail.publisher + (skillDetail.verifiedPublisher ? t('（已认证）') : '')) : null,
                    skillDetail.certifiedName ? h(Badge, { cls: 's-on' }, skillDetail.certifiedName) : null,
                    Array.isArray(skillDetail.security) ? skillDetail.security.map((status, index) => h(Badge, { key: index, cls: status === 'benign' ? 's-on' : '' }, t('安全: ') + status)) : null,
                  ),
                  skillDetail.changelog ? h('p', { className: 'dsh-mcp-wb-modal-note' }, t('最新版本说明：') + skillDetail.changelog) : null,
                  h('p', { className: 'dsh-mcp-wb-modal-note' },
                    t('安装 = 逐文件下载并 sha256 校验后写入 ~/.agents/skills/，即刻被 DSH 发现（无需重启）。已装版本重装即更新。')),
                ),
            h('div', { className: 'dsh-mcp-modal-actions' },
              h(Btn, { onClick: () => setSkillDetail(null), disabled: busy, children: t('关闭') }),
              installedSkills.has(skillDetail.slug)
                ? h(Btn, { danger: true, icon: 'trash', disabled: busy, onClick: () => uninstallSkill(skillDetail), children: t('卸载') })
                : h(Btn, { primary: true, icon: 'plus', disabled: busy || skillDetail.loading, onClick: () => installSkill(skillDetail), children: busy ? t('安装中…') : t('安装') }),
            ),
          ),
        )
      : null,
  );
};


// ── 面板头部入口菜单：切「悬浮按钮 / 侧栏入口」的显示偏好 ────────────────────────
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
      title: t('入口显示：') + ENTRY_LABELS[mode],
      onClick: (e) => { e.stopPropagation(); setOpen((value) => !value); },
      children: t('入口'),
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

// ── 侧栏入口与面板图标：跨 slot 共享的打开/切分类通道 ────────────────────────────
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
      title: t('技能 · MCP · 专家看板'),
      'aria-label': t('打开技能 · MCP · 专家看板'),
      onClick: () => openBoardPanel(),
    },
    h(Icon, { d: ICONS.plug, size: wide ? 16 : 18 }),
    wide ? h('span', { className: 'dsh-mcp-footer-name' }, t('技能·专家')) : null,
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

// ── 面板错误边界（OPT-07）────────────────────────────────────────────
// 面板里 23 个 React 组件此前全部裸挂在同一棵树上：任何一个在渲染期抛错，整块面板
// 直接白屏，连分类标签都不剩，用户唯一能做的是刷新页面。可能触发抛错的输入面很宽，
// 而且都不是本地代码能提前穷举的 —— MCP 市场返回的远程 JSON 结构异常、用户粘贴的
// 导入内容（mcp-import-sources.js）、被手工改坏的 cordis.patch.yml 往返、专家市场
// 439 条数据里的字段缺失。
// 因此每个顶层分类各包一层：把「一块坏掉」限制成「这一块显示错误卡片，其余照常可用」。
class ArmoryPanelBoundary extends React2.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.retry = this.retry.bind(this);
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // 只记录、不吞掉：控制台保留完整堆栈，用户回报时才有东西可看。
    console.error('[dsh-armory] panel crashed:', error, info);
  }
  retry() {
    this.setState({ error: null });
  }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return h('div', { className: 'dsh-mcp-panel-error', role: 'alert' },
      h('b', null, t('这个面板加载失败')),
      h('p', null, String((error && error.message) || error)),
      h('div', { className: 'dsh-mcp-panel-error-act' },
        h('button', { type: 'button', className: 'dsh-mcp-btn primary', onClick: this.retry }, t('重试')),
        h('span', null, this.props.hint || t('其余分类仍可正常使用；完整堆栈已打印到控制台。')),
      ),
    );
  }
}

// 看板页（main slot，key = PANEL_ID）：宿主中栏按 entryKey 渲染同 key 的条目。
// 组件复用既有的 McpTab——它本来就支持非浮层渲染（floating=false 时直接返回 inner），
// 全部 MCP 能力（列表/详情/编辑/导入/市场/升级/更新提示）因此原样保留，只是换了宿主位置。
// 跨分类跳转（openBoardCategory）：分类选择器收在 MODULE_CTX 的订阅列表里——
// ExpertInstalledBoard 空状态的「市场 → 专家」链接与输入框召唤菜单的「管理已装」都走它。
const boardCategoryListeners = new Set();
function openBoardCategory(key) {
  boardCategoryListeners.forEach((listener) => { try { listener(key); } catch { /* 单个订阅者失败不拖累其它 */ } });
  openBoardPanel();
}
const McpBoardPage = (props) => {
  const { call, timer, pluginManager } = props;
  const [category, setCategory] = useState('mcp');
  useEffect(() => {
    const listener = (key) => { if (BOARD_CATEGORIES.some((cat) => cat.key === key)) setCategory(key); };
    boardCategoryListeners.add(listener);
    return () => { boardCategoryListeners.delete(listener); };
  }, []);
  // 顶层分类计数：Skill 条数单独取，避免两条加载互相等待。
  const [skillCount, setSkillCount] = useState(null);
  // MCP 计数：与其他分类标签保持一致（此前只有 skill/tailor/expert 有数量，MCP 没有是遗漏）。
  const [mcpCount, setMcpCount] = useState(null);
  useEffect(() => {
    if (category !== 'mcp') return;
    let alive = true;
    call('listSkills', skillScopeArg('global')).then((res) => {
      if (alive && res && res.ok) setSkillCount(Array.isArray(res.skills) ? res.skills.length : null);
    }).catch(() => {});
    // MCP 计数与 Skill 同批取（都在打开页面时取一次；global 层与 McpTab 的默认视图一致）。
    call('list').then((res) => {
      if (alive && res && res.ok && Array.isArray(res.servers)) setMcpCount(res.servers.length);
    }).catch(() => {});
    return () => { alive = false; };
  }, [call, category]);
  // OPT-04：报告上提到这里，分类角标与 ToolTailor 页面本体共用同一份，进入该分类只扫一次。
  // 用「已发起」标记而不是判断报告是否非空，是为了区分「还没开始」与「发起了但失败了」：
  // 后者不该被角标当成「0 个死工具」，也不该让组件误以为自己该再扫一遍。
  const [tailorReport, setTailorReport] = useState(null);
  // 这个 ref 只在 effect 里读写；渲染期要用到「父层是否已认领本次加载」，
  // 所以另存一个 settled 状态。注意不能用「请求中」的瞬时布尔态来表达：
  // 子组件的 effect 先于父组件运行，首帧它看到的必然是 setState 之前的值，
  // 于是父层还没开始就被判定为「不管了」，两边同时发请求——正是要避免的那次重复扫描。
  const [tailorSettled, setTailorSettled] = useState(false);
  const tailorRequested = useRef(false);
  useEffect(() => {
    if (category !== 'tailor' || tailorRequested.current) return;
    tailorRequested.current = true;
    let alive = true;
    call('toolTailor', { days: 30 }).then((res) => {
      if (alive && res && res.ok) setTailorReport(res);
    }).catch(() => {}).finally(() => { if (alive) setTailorSettled(true); });
    return () => { alive = false; };
  }, [call, category]);
  // 首次进入该分类时父层必定会发这一发请求，因此首帧就告诉子组件「等我的」。
  const tailorSeedPending = category === 'tailor' && !tailorSettled;
  // 专家分类计数：已召唤数（打在分类上的是「已召唤」，与 Skill 条数语义一致——都是「在手」而非「总量」）。
  const [expertCount, setExpertCount] = useState(null);
  useEffect(() => {
    if (category !== 'expert' || expertCount !== null) return;
    let alive = true;
    call('wbExpertInstalled').then((res) => {
      if (alive && res && res.ok && Array.isArray(res.presets)) setExpertCount(res.presets.length);
    }).catch(() => {});
    return () => { alive = false; };
  }, [call, category, expertCount]);

  return h('div', { className: 'dsh-mcp-page' },
    h('div', { className: 'dsh-mcp-wrap' },
      h('div', { className: 'dsh-mcp-cats', role: 'tablist', 'aria-label': t('看板分类') },
        BOARD_CATEGORIES.map((cat) =>
          h('button', {
            key: cat.key,
            type: 'button',
            role: 'tab',
            'aria-pressed': category === cat.key,
            'aria-selected': category === cat.key,
            className: 'dsh-mcp-cat',
            title: cat.key === 'mcp' ? t('MCP 服务器（原有全部能力）') : cat.key === 'skill' ? t('Skill 看板（新增）') : cat.key === 'expert' ? t('已召唤的专家：预设状态 / 捆绑技能 / 送还（召唤新专家去「市场」）') : cat.key === 'tailor' ? t('工具裁缝：工具使用账本 + 上下文税单 + 死工具清单') : t('市场：WorkBuddy 连接器 + 内置 MCP 目录 + SkillHub 技能 + 专家召唤'),
            onClick: () => setCategory(cat.key),
          },
            h(Icon, { d: ICONS[cat.icon], size: 14 }),
            cat.label,
            cat.key === 'mcp' && mcpCount !== null ? h('span', { className: 'dsh-mcp-cat-count' }, mcpCount) : null,
            cat.key === 'skill' && skillCount !== null ? h('span', { className: 'dsh-mcp-cat-count' }, skillCount) : null,
            cat.key === 'tailor' && tailorReport && typeof tailorReport.deadMcpCount === 'number' ? h('span', { className: 'dsh-mcp-cat-count' }, tailorReport.deadMcpCount) : null,
            cat.key === 'expert' && expertCount !== null ? h('span', { className: 'dsh-mcp-cat-count' }, expertCount) : null,
          )),
      ),
      // OPT-07：每个分类各自包一层错误边界。key 用分类名，切走再切回会重建边界，
      // 顺带让「重试」之外还有一条自然恢复路径。
      category === 'mcp'
        ? h(ArmoryPanelBoundary, { key: 'mcp', hint: t('MCP 列表加载失败；Skill、专家、裁缝、市场仍可正常使用。') }, h(McpTab, { call, timer, pluginManager }))
        : category === 'tailor'
          ? h(ArmoryPanelBoundary, { key: 'tailor', hint: t('工具账本加载失败；其余分类仍可正常使用。') }, h(ToolTailor, { call, timer, report: tailorReport, onReport: setTailorReport, seedPending: tailorSeedPending }))
          : category === 'expert'
            ? h(ArmoryPanelBoundary, { key: 'expert', hint: t('已召唤专家列表加载失败；其余分类仍可正常使用。') }, h(ExpertInstalledBoard, { call }))
            : category === 'wb'
              ? h(ArmoryPanelBoundary, { key: 'wb', hint: t('市场数据加载失败；其余分类仍可正常使用。') }, h(WorkBuddyMarket, { call }))
              : h(ArmoryPanelBoundary, { key: 'skill', hint: t('Skill 看板加载失败；其余分类仍可正常使用。') }, h(SkillBoard, { call, timer })),
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
const WHATS_NEW_SEEN_KEY = 'dsh-armory.whatsNew.seen';

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
const UPGRADE_PACKAGE = 'dsh-armory';

/**
 * 这次升级能不能做、为什么不能——纯判定，便于单测。
 *
 * 四种「不能升」的来源各不相同，报给用户的话也必须不同：
 *   - 宿主没提供 pluginManager（老宿主 / 非 web 形态）→ 退回手动命令；
 *   - 插件不是 npm 装的（link:/file:/github:）→ 覆盖安装会把它换成 npm 包，不能做；
 *   - 安装来源未知（宿主没回 installInfo / 读不到 profile manifest）→ 同样不做：
 *     宁可少一个按钮，也不做可能毁掉用户本地副本的写操作；
 *   - 当前版本不低于最新 → 无需升级。
 *
 * @param {object} input - 判定输入。
 * @param {object|null} input.service - 探测到的 pluginManager 命名空间（null = 宿主没提供）。
 * @param {object|null} input.hint - updateHint 的结果（current / latest / updateAvailable）。
 * @param {object|null} input.bundle - listBundles 里本插件那一行（version / installed / …）。
 * @param {string|null} input.spec - 宿主 installInfo 报回的 profile manifest spec。
 * @param {string|null} input.source - 宿主 installInfo 报回的来源分类（registry/file/link/…）。
 * @returns {{supported: boolean, reason: string, spec: string|null, version?: string}} 判定结果。
 */
function upgradePlan({ service, hint, bundle, spec = null, source = null }) {
  const hasMethod = !!service && typeof service[UPGRADE_METHOD] === 'function';
  if (!hasMethod) return { supported: false, reason: 'no-service', spec: null };
  if (!hint?.updateAvailable || !hint?.latest) return { supported: false, reason: 'up-to-date', spec: null };
  // 本地安装形态不归 installBundle 管：它执行的是 `pnpm add <npm spec>`，会把用户的本地开发
  // 链接/文件依赖换成 npm 包——那是破坏而不是升级。只认 registry 来源。
  //
  // 判据必须来自宿主 installInfo（读 profile manifest 的真实 spec），**不能用
  // bundle.source**：宿主 listBundles() 的行里没有该字段（只有 name/version/description/
  // meta/enabled/installed/optional/removable/readOnlyReason/rows/overrides），旧实现据此
  // 恒判「可以升」，本地 file: 安装的用户一点就把开发副本换成了 npm 包。
  const sourceText = typeof source === 'string' ? source.trim() : '';
  const specText = typeof spec === 'string' ? spec.trim() : '';
  // 来源未知（新客户端配旧宿主，installInfo 还没上线 / manifest 读不到）→ 不做写操作。
  if (sourceText === '' || sourceText === 'unknown') return { supported: false, reason: 'unknown-source', spec: null };
  if (sourceText !== 'registry') return { supported: false, reason: 'not-npm', spec: null };
  // 双保险：spec 前缀也必须像 registry spec（宿主分类与客户端判据两处独立成立才算数）。
  const looksRegistry = specText === '' || /^[\^~]?\d/.test(specText) || /^(latest|\*|next|\*)$/i.test(specText);
  if (!looksRegistry) return { supported: false, reason: 'not-npm', spec: null };
  // 宿主将来若补上 bundle.source，两种信号取更保守的一侧（任一像本地就否决）。
  const legacySource = typeof bundle?.source === 'string' ? bundle.source.trim() : '';
  if (legacySource !== '' && !/^\d|^\^|^~|^latest$/.test(legacySource)) return { supported: false, reason: 'not-npm', spec: null };
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
    'incompatible-version': t('新版本与当前 DSH 不兼容，未升级。'),
    'not-bundle': t('该包没有声明组合包，不能作为插件安装。'),
    'invalid-spec': t('版本号不合法，未升级。'),
    'ambiguous-install': t('无法确定要升级哪个包，未升级。'),
    'unknown-plugin': t('在 profile 里找不到这个插件，未升级。'),
    'stop-profile': t('宿主正在停止，未升级；请重启后再试。'),
    'bundle-in-use': t('该包正在被使用，未升级。'),
    'stale-approval': t('构建授权已过期，未升级；请重试。'),
    'management-required': t('当前 profile 由应用托管，不允许在这里改动。'),
    'unaddressable': t('这一项无法被单独改动（随 DSH 提供）。'),
  };
  if (known[code]) return known[code];
  // 未知码不吞掉：把码和 pnpm 的退出码如实带出来，否则用户和我们都无从查起。
  const bits = [];
  if (code) bits.push(t('错误码 ') + code);
  if (typeof exitCode === 'number' && exitCode !== 0) bits.push(t('pnpm 退出码 ') + exitCode);
  return bits.length ? t('升级失败（') + bits.join(t('，')) + t('）。') : t('升级失败。');
}

// ── 「这次变了什么」弹窗：把 lib/whats-new.js 的内容说一次 ──────────────────────
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
      { ref: boxRef, className: 'dsh-mcp-whatsnew', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('本次更新内容') },
      h('div', { className: 'dsh-mcp-whatsnew-head' },
        // 版本中性：首次打开（没有任何记录）与从旧版本升上来走的是同一个分支，
        // 写「更新到」会把前者的文案说错。
        h('b', null, 'v' + notice.current + t(' 的更新')),
        h('span', null, t('这些变化你可能想知道')),
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
        h('button', { ref: confirmRef, type: 'button', className: 'dsh-mcp-btn primary', onClick: dismiss }, t('知道了')),
      ),
    ),
  );
};

// ── 悬浮按钮宿主（shell.overlay）：只剩这一个席位 ────────────────────────────────
const McpOverlay = () => {
  const mode = useEntryMode();
  const seats = overlaySeats(mode);
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
        title: t('技能 · MCP · 专家看板（可拖拽移动）'),
        'aria-label': t('打开技能 · MCP · 专家看板'),
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

// ── 定时器宿主：卸载时统一清空，避免组件残留 setInterval ────────────────────────
// 宿主的 client 上下文提供 `timer` 时优先用宿主；这里只是 apply() 里给自身用的兜底实现。
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

// ── RPC 契约的浏览器半：strict codec 与描述符表 MCP_CONTRIBUTION ──────────────────
// strict codec 与 lib/typert.js 是同一份契约的两份产物：宿主 loader 校验 host 那份，
// typert-registry 的**浏览器半**校验这份，两边规则一致而两个渠道查不同的键——
//   0.1.5-rc.x（= 当时 latest/next，npx 默认装到的那条）查 `codec.schema.parse`；
//   0.1.6-alpha.2 起查 `typeof codec.create === 'function'` 并用它物化 schema。
// 所以两个键都写（少写一半就是「面板能加载、一调用就炸」或「加载即拒」）。
// 浏览器侧不需要 zod：宿主只要求 create() 返回带 parse 的 schema。两处必须一起改。
const ANY_VALUE_SCHEMA = { parse: (v) => v };
const STRING_SCHEMA = { parse: (v) => { if (typeof v !== 'string') throw new TypeError('Expected string'); return v; } };
function strictCodec(symbol, schema) {
  return { mode: 'strict', typeSymbol: 'dsh-armory/typert#' + symbol, schema: schema, create: () => schema };
}
function mcpCodec(m) { return strictCodec(m, ANY_VALUE_SCHEMA); }
function mcpParam(name, sym) { return { name: name, wire: name, source: 'json', codec: strictCodec(sym, sym === 'String' ? STRING_SCHEMA : ANY_VALUE_SCHEMA) }; }
const MCP_CONTRIBUTION = {
  package: 'dsh-armory',
  descriptors: [
    { id: 'dsh-armory#mcpManager/list', service: 'mcpManager', namespace: 'mcpManager', method: 'list', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('ListResult') },
    { id: 'dsh-armory#mcpManager/status', service: 'mcpManager', namespace: 'mcpManager', method: 'status', invocation: { kind: 'direct' }, parameters: [mcpParam('name', 'String')], result: mcpCodec('StatusResult') },
    { id: 'dsh-armory#mcpManager/enable', service: 'mcpManager', namespace: 'mcpManager', method: 'enable', invocation: { kind: 'direct' }, parameters: [mcpParam('name', 'String')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/disable', service: 'mcpManager', namespace: 'mcpManager', method: 'disable', invocation: { kind: 'direct' }, parameters: [mcpParam('name', 'String')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/reconnect', service: 'mcpManager', namespace: 'mcpManager', method: 'reconnect', invocation: { kind: 'direct' }, parameters: [mcpParam('name', 'String')], result: mcpCodec('NoteResult') },
    // tools 收 payload 而不是裸 name：项目 MCP 必须带 wsPath 才能精确定位（两个项目可能同名）。
    // 声明成标量 name 时，网关会把传入对象当成 args 映射展开并报 unexpected "wsPath"。
    { id: 'dsh-armory#mcpManager/tools', service: 'mcpManager', namespace: 'mcpManager', method: 'tools', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ToolsResult') },
    { id: 'dsh-armory#mcpManager/builtins', service: 'mcpManager', namespace: 'mcpManager', method: 'builtins', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('BuiltinCatalogResult') },
    { id: 'dsh-armory#mcpManager/installBuiltins', service: 'mcpManager', namespace: 'mcpManager', method: 'installBuiltins', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'BuiltinInstallPayload')], result: mcpCodec('BuiltinInstallResult') },
    { id: 'dsh-armory#mcpManager/add', service: 'mcpManager', namespace: 'mcpManager', method: 'add', invocation: { kind: 'direct' }, parameters: [mcpParam('spec', 'Spec')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/update', service: 'mcpManager', namespace: 'mcpManager', method: 'update', invocation: { kind: 'direct' }, parameters: [mcpParam('spec', 'Spec')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/removeServer', service: 'mcpManager', namespace: 'mcpManager', method: 'removeServer', invocation: { kind: 'direct' }, parameters: [mcpParam('name', 'String')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/reveal', service: 'mcpManager', namespace: 'mcpManager', method: 'reveal', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('RevealResult') },
    { id: 'dsh-armory#mcpManager/previewImport', service: 'mcpManager', namespace: 'mcpManager', method: 'previewImport', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportPreview') },
    { id: 'dsh-armory#mcpManager/importJson', service: 'mcpManager', namespace: 'mcpManager', method: 'importJson', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportResult') },
    { id: 'dsh-armory#mcpManager/scanImportSources', service: 'mcpManager', namespace: 'mcpManager', method: 'scanImportSources', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportSourcesResult') },
    { id: 'dsh-armory#mcpManager/previewImportSource', service: 'mcpManager', namespace: 'mcpManager', method: 'previewImportSource', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportPreview') },
    { id: 'dsh-armory#mcpManager/importSource', service: 'mcpManager', namespace: 'mcpManager', method: 'importSource', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportResult') },
    { id: 'dsh-armory#mcpManager/listWorkspaces', service: 'mcpManager', namespace: 'mcpManager', method: 'listWorkspaces', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('WorkspaceListResult') },
    { id: 'dsh-armory#mcpManager/getWorkspaceView', service: 'mcpManager', namespace: 'mcpManager', method: 'getWorkspaceView', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WorkspaceViewResult') },
    { id: 'dsh-armory#mcpManager/addWorkspaceServer', service: 'mcpManager', namespace: 'mcpManager', method: 'addWorkspaceServer', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/updateWorkspaceServer', service: 'mcpManager', namespace: 'mcpManager', method: 'updateWorkspaceServer', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/removeWorkspaceServer', service: 'mcpManager', namespace: 'mcpManager', method: 'removeWorkspaceServer', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/setWorkspaceExclude', service: 'mcpManager', namespace: 'mcpManager', method: 'setWorkspaceExclude', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/installWorkspaceBuiltins', service: 'mcpManager', namespace: 'mcpManager', method: 'installWorkspaceBuiltins', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'BuiltinInstallPayload')], result: mcpCodec('BuiltinInstallResult') },
    { id: 'dsh-armory#mcpManager/previewWorkspaceImport', service: 'mcpManager', namespace: 'mcpManager', method: 'previewWorkspaceImport', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportPreview') },
    { id: 'dsh-armory#mcpManager/importWorkspaceJson', service: 'mcpManager', namespace: 'mcpManager', method: 'importWorkspaceJson', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('ImportResult') },
    { id: 'dsh-armory#mcpManager/revealWorkspaceServer', service: 'mcpManager', namespace: 'mcpManager', method: 'revealWorkspaceServer', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('RevealResult') },
    // 只读排障接口：面板暂未接线，契约先声明齐（Host 有、契约没有 = 客户端永远调不到）。
    { id: 'dsh-armory#mcpManager/projectConnections', service: 'mcpManager', namespace: 'mcpManager', method: 'projectConnections', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('ProjectConnectionsResult') },
    { id: 'dsh-armory#mcpManager/reconnectWorkspaceServer', service: 'mcpManager', namespace: 'mcpManager', method: 'reconnectWorkspaceServer', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/updateHint', service: 'mcpManager', namespace: 'mcpManager', method: 'updateHint', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('UpdateHintResult') },
    // 安装形态（spec / source）：一键升级的安全判据。与宿主 method、typert.js 三处必须同步，
    // 漏一处就是恒 404（toolTailor 踩过）。
    { id: 'dsh-armory#mcpManager/installInfo', service: 'mcpManager', namespace: 'mcpManager', method: 'installInfo', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('InstallInfoResult') },
    // 「这次更新了什么」：数据在 lib/whats-new.js，宿主只转发，判定“该不该弹”在客户端。
    { id: 'dsh-armory#mcpManager/whatsNew', service: 'mcpManager', namespace: 'mcpManager', method: 'whatsNew', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('WhatsNewResult') },
    // ── Skill 看板：与 MCP 同一命名空间、同一信封（payload 进、{ok} 出）──
    { id: 'dsh-armory#mcpManager/listSkills', service: 'mcpManager', namespace: 'mcpManager', method: 'listSkills', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('SkillListResult') },
    { id: 'dsh-armory#mcpManager/skillDetail', service: 'mcpManager', namespace: 'mcpManager', method: 'skillDetail', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('SkillDetailResult') },
    { id: 'dsh-armory#mcpManager/revealSkill', service: 'mcpManager', namespace: 'mcpManager', method: 'revealSkill', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    // ── 工具裁缝：与 revealSkill 同批加入看板，但两端契约此前双双缺失（客户端永远 404）──
    { id: 'dsh-armory#mcpManager/toolTailor', service: 'mcpManager', namespace: 'mcpManager', method: 'toolTailor', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('TailorReport') },
    // ── WorkBuddy 市场直连：连接器 MCP + SkillHub 技能（同一命名空间同一信封）──
    { id: 'dsh-armory#mcpManager/wbConnectorCatalog', service: 'mcpManager', namespace: 'mcpManager', method: 'wbConnectorCatalog', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('WbCatalogResult') },
    { id: 'dsh-armory#mcpManager/wbConnectorPreview', service: 'mcpManager', namespace: 'mcpManager', method: 'wbConnectorPreview', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WbPreviewResult') },
    { id: 'dsh-armory#mcpManager/wbConnectorInstall', service: 'mcpManager', namespace: 'mcpManager', method: 'wbConnectorInstall', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/wbSkillCatalog', service: 'mcpManager', namespace: 'mcpManager', method: 'wbSkillCatalog', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WbSkillListResult') },
    { id: 'dsh-armory#mcpManager/wbSkillDetail', service: 'mcpManager', namespace: 'mcpManager', method: 'wbSkillDetail', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WbSkillDetailResult') },
    { id: 'dsh-armory#mcpManager/wbSkillInstall', service: 'mcpManager', namespace: 'mcpManager', method: 'wbSkillInstall', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/wbSkillUninstall', service: 'mcpManager', namespace: 'mcpManager', method: 'wbSkillUninstall', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/wbSkillInstalled', service: 'mcpManager', namespace: 'mcpManager', method: 'wbSkillInstalled', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('WbInstalledResult') },
    // ── WorkBuddy 专家直连：召唤预设 + 捆绑技能（同一命名空间同一信封）──
    { id: 'dsh-armory#mcpManager/wbExpertCatalog', service: 'mcpManager', namespace: 'mcpManager', method: 'wbExpertCatalog', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('WbExpertCatalogResult') },
    { id: 'dsh-armory#mcpManager/wbExpertDetail', service: 'mcpManager', namespace: 'mcpManager', method: 'wbExpertDetail', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WbExpertDetailResult') },
    { id: 'dsh-armory#mcpManager/wbExpertSummon', service: 'mcpManager', namespace: 'mcpManager', method: 'wbExpertSummon', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/wbExpertDismiss', service: 'mcpManager', namespace: 'mcpManager', method: 'wbExpertDismiss', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/wbExpertInstalled', service: 'mcpManager', namespace: 'mcpManager', method: 'wbExpertInstalled', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('WbExpertInstalledResult') },
    { id: 'dsh-armory#mcpManager/wbExpertRecent', service: 'mcpManager', namespace: 'mcpManager', method: 'wbExpertRecent', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('WbExpertRecentResult') },
    { id: 'dsh-armory#mcpManager/wbExpertRecordUse', service: 'mcpManager', namespace: 'mcpManager', method: 'wbExpertRecordUse', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    // 会话级专家人设（随时挂 / 换 / 摘）：不受 agent-preset/locked 限制。
    // 与宿主 method、typert.js 三处必须同步，漏一处这条通道就恒 404。
    { id: 'dsh-armory#mcpManager/expertAttach', service: 'mcpManager', namespace: 'mcpManager', method: 'expertAttach', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/expertDetach', service: 'mcpManager', namespace: 'mcpManager', method: 'expertDetach', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/expertActive', service: 'mcpManager', namespace: 'mcpManager', method: 'expertActive', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('ExpertActiveResult') }
  ].map((descriptor) => ({ ...descriptor, sourceLocation: { file: 'dsh-armory/lib/typert.js', line: 7, column: 1 } }))
};
// ── 插件入口：挂 RPC、注入样式、注册六个界面槽位 ──────────────────────────────
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
      if (!svc || typeof svc[method] !== 'function') return { ok: false, error: t('MCP 市场服务未连接（面板仍可用）') };
      const r = args === undefined || args === null ? await svc[method]() : await svc[method](args);
      if (r && r.ok) return { ok: true, ...((r.value && typeof r.value === 'object') ? r.value : {}) };
      if (r && !r.ok) return { ok: false, error: (r.error && (r.error.message || r.error.code)) || t('调用失败') };
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
    // 输入框召唤菜单（conversation.input.right，list 型 slot）：权限/模型座位右侧的小图标，
    // 点开 = 技能/MCP/专家三分类 + 悬停最近使用子菜单。声明感知注入（会话 slot 由 conversation
    // 包声明，加载顺序不保证）；菜单组件自管开关与外部点击关闭。
    // sessionId 由 slot 渲染作为 prop 显式传入（session 座位约定：id 只走 props，不走 summary 投影），
    // 「挂专家」的人设通道 RPC 用它寻址当前会话。
    ctx.slots.inject('conversation.input.right', () =>
      ctx.slots.register({ name: 'conversation.input.right', id: PANEL_ID + '-quick', order: 40, label: PANEL_LABEL, inject: (sessionId) => ({ call, sessionId }) }, SummonQuickMenu),
    );
    // 会话头「当前生效专家」徽章（conversation.session.header.actions，list 型 slot）：
    // 与宿主 AgentPresetLabel 同列——但显示的是人设通道真正生效的专家（expertActive），
    // 修复「换专家后顶栏仍显示第一次预设名」的显示/实效分叉。
    ctx.slots.inject('conversation.session.header.actions', () =>
      ctx.slots.register({ name: 'conversation.session.header.actions', id: PANEL_ID + '-head-expert', order: -5, label: PANEL_LABEL, inject: (sessionId) => ({ call, sessionId }) }, SessionExpertBadge),
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
