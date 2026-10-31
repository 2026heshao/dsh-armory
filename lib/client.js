window.__ModuleLoader__.load({
	id: 'dsh-armory',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
// ── P0-2：启动计时（默认关闭，零开销）────────────────────────────────────
// 排查「打开面板慢 / 市场首屏慢」时不用再翻 DevTools 手工打点。在 DevTools 里执行
//   localStorage.setItem('dsh-armory.perf.instrument', '1')
// 然后 Ctrl+R，模块会把四段耗时写进 window.__ARMORY_PERF__：
//   module.materialize  —— 本 bundle 从解析到 materialize（含各组件定义）
//   apply.start / apply.end —— 插件 apply 的起止（相对 materialize 起点）
//   firstRpc.method / firstRpc.ms —— 第一个 business RPC 的方法名与往返耗时
// 关闭时只读一次 localStorage，之后所有分支短路：不建对象、不打点、不额外闭包。
const PERF_ON = (() => {
  try { const v = localStorage.getItem('dsh-armory.perf.instrument'); return v === '1' || v === 'true'; } catch { return false; }
})();
const PERF_T0 = PERF_ON && typeof performance !== 'undefined' && typeof performance.now === 'function'
  ? performance.now()
  : 0;
const perfBucket = PERF_ON && typeof window !== 'undefined'
  ? (window.__ARMORY_PERF__ = window.__ARMORY_PERF__ || {})
  : null;
const perfMark = (group, key, value) => {
  if (!perfBucket) return;
  if (!perfBucket[group]) perfBucket[group] = {};
  perfBucket[group][key] = Math.round(value * 10) / 10;
};
// ── 性能开关（docs/perf-market-load.md §7）────────────────────────────────
// 每一项都默认开启；在 DevTools 里写 '0'（或 'false'）即可单独回落到改造前行为，
// 写 'legacy' 则整体回到「挂载即预取」的旧节奏。读失败一律按默认值处理。
const perfFlag = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return !(raw === '0' || raw === 'false');
  } catch { return fallback; }
};
const MARKET_PERF = {
  // P1-1：'legacy' = 恢复「市场挂载后 400ms 就预取插件目录」的旧节奏。
  prefetchMode: (() => {
    try { return localStorage.getItem('dsh-armory.marketPrefetch') === 'legacy' ? 'legacy' : 'idle'; } catch { return 'idle'; }
  })(),
  connectorSnapshot: perfFlag('dsh-armory.connectorSnapshot', true),   // P1-4
  awesomeSnapshotLazy: perfFlag('dsh-armory.awesomeSnapshotLazy', true), // P1-3
  skillSwr: perfFlag('dsh-armory.skillSwr', true),                     // P1-5
  hoverPrefetch: perfFlag('dsh-armory.hoverPrefetch', true),           // P2-3
};
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
const { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } = React2;

// ── OPT-11：i18n 骨架（gettext 模型，键 = 中文原文） ────────────────────────
// zh-CN 是源语言：字典为空时 t() 恒等返回原文，缺键永远不会让界面出现 key 名。
// 将来补 en-US：往 i18nMessages 合并 { '中文原文': 'English' } 即可，无需改调用点。
// 带插值的文案：t('{0} 个会话', [n]) —— {n} 占位符按 vars 数组下标替换；
// 翻译表里的目标语可自由重排占位符顺序。
// 曾经的约束（与 OPT-12 同源）：ModuleLoader 只注入宿主模块，判定 client.js 不能
// 相对导入字典文件。OPT-14 实测可行：chunk 产物 + require.async 能拿到宿主模块
// （dsh-cost-meter 先例）。本次 en-US 表仍内联在本文件里（677 键，避免构建期拼接），
// 将来加新语言可改走 require.async 外部字典文件。
const i18nMessages = {};
const setI18nMessages = (table) => { Object.assign(i18nMessages, table || {}); };
const resetI18nMessages = () => { for (const key of Object.keys(i18nMessages)) delete i18nMessages[key]; };
// OPT-14 · 1.1 / OPT-25 locale 判定（首个命中即返回）：
//   ① localStorage['dsh-armory.locale'] —— 显式覆盖（测试与高级用户）
//   ② DSH 宿主 locale.active —— 设置 → 通用里的语言，用户真正看到的 UI 语言
//   ③ navigator.language —— 宿主 locale 不可用时的浏览器回落
//   ④ zh-CN —— 源语言兜底
// 只读 navigator 是 2.2.0 及以前的做法：中文系统 + DSH 设英文时 navigator 仍是
// zh-CN，英文表永远不装载（issue #1 的根因）。宿主服务用 ctx.get('locale') 取，
// **不写进 inject**——老版本 DSH 没有该服务时仍能照常加载。
// 所有失败路径（存储不可用、无 navigator、宿主快照抛错）都静默回落，绝不抛错。
const readStoredI18nLocale = () => {
  try {
    return localStorage['dsh-armory.locale'] || null;
  } catch { return null; }
};
const hostActiveLocale = (localeService) => {
  try {
    const snapshot = localeService && typeof localeService.getSnapshot === 'function' ? localeService.getSnapshot() : null;
    return snapshot && typeof snapshot.active === 'string' && snapshot.active ? snapshot.active : null;
  } catch { return null; }
};
const initialI18nLocale = readStoredI18nLocale()
  || (typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'zh-CN');
let I18N_LOCALE = initialI18nLocale;
const resolveI18nLocale = (localeService) => readStoredI18nLocale()
  || hostActiveLocale(localeService)
  || initialI18nLocale
  || 'zh-CN';
// 切换语言时必须先清空旧字典：中文（源语言）要求空表才能恒等直出，
// 否则从 en 切回 zh 会残留英文译文。
// P1：源语言是中文、唯一译文是英文，所以按「zh* → 中文，其余 → 英文」判定。
// 非 zh 的非英文语言（ja / de / fr…）宁可给英文，也不把中文丢给看不懂的用户；
// en* 之外的显式覆盖同理。新增第三种语言时才需要把这里改成精确查表。
const isChineseLocale = (locale = I18N_LOCALE) => String(locale || '').toLowerCase().startsWith('zh');
const usesEnglish = (locale = I18N_LOCALE) => !isChineseLocale(locale);
const applyI18nLocale = (locale) => {
  I18N_LOCALE = locale || initialI18nLocale || 'zh-CN';
  resetI18nMessages();
  if (usesEnglish()) setI18nMessages(EN_US_MESSAGES);
  return I18N_LOCALE;
};
// 宿主 locale 订阅：包一层 try/catch，服务没实现 subscribe 或抛错都不影响面板。
const subscribeI18nLocale = (localeService, listener) => {
  try {
    if (localeService && typeof localeService.subscribe === 'function') return localeService.subscribe(listener);
  } catch { /* 订阅失败：保留启动时判定的语言 */ }
  return null;
};
const EN_US_MESSAGES = {
 " + 捆绑技能": " + bundled skills",
 " · {0} 个失败": " · {0} failed",
 " · 全库搜索（忽略分类）": " · searching all libraries (ignores category)",
 " · 刷新中…": " · refreshing…",
 " · 已更新": " · updated",
 " · 已隐藏 {0} 个有调用的工具": " · {0} called tools hidden",
 " · 显示 {0}/{1} 个工具 · Schema 合计 ~{2} tok/请求": " · showing {0}/{1} tools · total schema ~{2} tok/request",
 " · 缓存": " · cache",
 " 个": "",
 " 个 MCP": " MCPs",
 " 个 MCP：": " MCPs:",
 " 个会话共用": " sessions share it",
 " 个会话在用": " sessions in use",
 " 个会话在运行。": " sessions running.",
 " 个工具": " tools",
 " 个项目 MCP 未能挂载到会话：": " project MCPs failed to attach to the session:",
 " 个项目 MCP 的工具不在共享作用域层：": " project MCPs have tools outside the shared scope layer:",
 " 分钟前": " min ago",
 " 可用": " available",
 " 可用；本地安装（": " available; local install (",
 " 天": " days",
 " 天前": " days ago",
 " 失败": " failed",
 " 字符）": " chars)",
 " 对本项目可见": " visible to this project",
 " 小时前": " h ago",
 " 工具": " tools",
 " 成功": " succeeded",
 " 条提示，导入时逐条列出": " prompts, listed one by one on import",
 " 的更新": " update",
 "+ 添加": "+ Add",
 "Bearer … 或 !!js process.env.KEY": "Bearer … or !!js process.env.KEY",
 "Filesystem · 本地文件读写": "Filesystem · local file read/write",
 "Git · 版本控制（需 uvx）": "Git · version control (needs uvx)",
 "HTTP（远程）": "HTTP (remote)",
 "Headers（可选）": "Headers (optional)",
 "JSON 解析失败": "JSON parse failed",
 "MCP 列表加载失败；Skill、专家、裁缝、市场仍可正常使用。": "Failed to load the MCP list; Skills, Experts, Tailor and Market keep working.",
 "MCP 名称（唯一标识，不可改）": "MCP name (unique identifier, immutable)",
 "MCP 工具按 server 生效：选择后点名 mcp__服务__* 工具": "MCP tools apply per server: picking this names mcp__server__* tools",
 "MCP 市场服务未连接（面板仍可用）": "MCP market service not connected (panel still usable)",
 "MCP 市场面板": "MCP Market panel",
 "Memory · 知识图谱记忆": "Memory · knowledge-graph memory",
 "Schema 税": "Schema tax",
 "Sequential Thinking · 分步推理": "Sequential Thinking · step-by-step reasoning",
 "Skill 看板加载失败；其余分类仍可正常使用。": "Failed to load the Skill board; other categories keep working.",
 "SkillHub 是远程分页，只能在当前 {0} 条里筛。翻页找找，或取消「只看已安装」。": "SkillHub pages remotely; you can only filter within the current {0} entries. Try another page, or turn off 'Installed only'.",
 "SkillHub 的搜索按名称与描述匹配；换一个更短的词通常更容易命中。": "SkillHub search matches name and description; a shorter query usually hits.",
 "Time · 时区时间工具（需 uvx）": "Time · timezone clock tool (needs uvx)",
 "WorkBuddy 专家 · ": "WorkBuddy Expert · ",
 "WorkBuddy 市场": "WorkBuddy Market",
 "npx 或 C:\\path\\to\\bin.exe": "npx or C:\\path\\to\\bin.exe",
 "pnpm 退出码 ": "pnpm exit code ",
 "serverName 同名冲突": "serverName duplicate conflict",
 "skill 列表": "skill list",
 "skill 由 skill-filesystem 从项目 .agents/skills、.dsh/skills 与用户目录发现；放一个 SKILL.md 进去就会出现在这里。": "Skills are discovered by skill-filesystem from project .agents/skills, .dsh/skills and user dirs; drop a SKILL.md in and it shows up here.",
 "stdio（本地进程）": "stdio (local process)",
 "toolTailor 调用失败": "toolTailor call failed",
 "zstd 解压不可用：当前 Node 不支持 zlib.zstdDecompressSync（需 >= 22.15），所有调用计数都会是 0": "zstd decompression unavailable: this Node lacks zlib.zstdDecompressSync (needs >= 22.15); all call counts will read 0",
 "{0} 个 MCP 工具在 {1} 天内零调用，合计每轮请求白缴 ~{2} tok 上下文税。可到「MCP」页或在上方行内禁用对应服务器（随时可启用，禁用只作用于新请求）。": "{0} MCP tools had zero calls in {1} days, wasting ~{2} tok of context tax per request. Disable the servers on the 'MCP' page or inline above (re-enable anytime; disabling only affects new requests).",
 // §6.1 / §6.2 / §6.4 工具裁缝「税的时间维度与归因」。
 "近 {0} 天每轮真实下发的工具税（左旧右新）": "Real per-request tool tax over the last {0} days (older left, newer right)",
 "每轮下发清单在 {0} 天内一次没变": "The per-request tool list did not change once in {0} days",
 "每轮下发清单变化 {0} 次": "The per-request tool list changed {0} times",
 "最近一次 {0} 个工具 ~{1} tok（{2}）": "Latest request: {0} tools, ~{1} tok ({2})",
 "{0} 条调用事件没有可用的 time 字段，无法判定落在哪个窗口，已全部计入当前窗口（切换时间窗对这部分不生效）。": "{0} call events had no usable time field and could not be placed in any window; all were counted into the current one (switching the window does not affect them).",
 "窗口内真实下发清单的种类数超过上限，税趋势线只覆盖前若干种。": "The window held more distinct tool lists than the cap allows; the tax trend covers only the first few.",
 "窗口 {0} 天，但读到的调用记录只跨 {1} 天（最早一条是 {2}）；更早的部分本机没有日志，加长窗口不会改变任何数字。": "The window is {0} days, but the call records read span only {1} days (earliest {2}). There are no local logs before that, so widening the window cannot change any number.",
 "注册表快照比最近一次真实下发多 ~{0} tok：多半是改完配置还没重启宿主，或项目级工具还没在当前会话注册。": "The registry snapshot is ~{0} tok larger than the latest real request: you likely edited the config without restarting the host, or project-level tools are not registered in this session yet.",
 "最近一次真实下发比注册表快照多 ~{0} tok：当前会话的工具集与面板读到的全局注册表不一致（可能来自项目级或子 Agent 作用域）。": "The latest real request carries ~{0} tok more than the registry snapshot: this session's tool set differs from the global registry the panel reads (likely project-level or sub-agent scope).",

 "{0} 个专家正挂在 {1} 个会话上": "{0} experts are attached to {1} sessions",
 "{0} 个会话": "{0} sessions",
 "{0} 个共用": "{0} shared",
 "{0} 个参数": "{0} parameters",
 "{0} 个工具，默认收起以免遮蔽上方连接信息": "{0} tools, collapsed by default to keep connection info visible above",
 "{0} 个日志帧解码失败，调用计数可能偏低": "{0} log frames failed to decode; call counts may be low",
 "{0} 个日志文件未能读取（含超限跳过），展开看原因": "{0} log files could not be read (oversize ones skipped); expand to see why",
 "{0} 个零调用 MCP 工具的 Schema，占全部工具税 {1} 的 {2}": "{0} zero-call MCP tools' schema — {2} of the {1} total tool tax",
 "{0} 工具": "{0} tools",
 "{0} 已召唤": "{0} summoned",
 "{0} 已召唤，新建会话时可在预设选择器里选它": "{0} summoned; pick it in the preset selector when creating a new session",
 "{0} 已送还": "{0} returned",
 "{0}/{1} 个匹配": "{0}/{1} matches",
 "{0}–{1} ms，最多 {2} 次": "{0}–{1} ms, max {2} attempts",
 "{0}（{1}）": "{0} ({1})",
 "{0}：": "{0}: ",
 "{0}：{1}": "{0}: {1}",
 "— 选择预设 —": "— Pick a preset —",
 "••••••（保留原值）": "•••••• (keep current value)",
 "⚠ 数据可能不完整：": "⚠ Data may be incomplete:",
 "⚠ 这条预设是旧版本召唤写入的：人设缺「DSH 运行时适配」桥接段，用它的新会话主理人只会调不存在的 TeamCreate/Agent，成员子智能体开不出来。点下方「更新预设」重跑召唤即可刷新。": "⚠ This preset was written by an older summon: its persona lacks the 'DSH runtime adaptation' bridge section, so new sessions using it will call the nonexistent TeamCreate/Agent and member subagents won't spawn. Click 'Update preset' below to re-run the summon and refresh.",
 "✓ 已取消本会话的专家": "✓ Expert detached from this session",
 "　": " ",
 "　·　改动即刻生效": " · Changes take effect immediately",
 "　——宿主还没注册 skill 接口：重启 DeepSeek Harness 让宿主侧生效后即可": " — the host hasn't registered the skill interface yet; restart DeepSeek Harness to activate it",
 "　——宿主还没注册 toolTailor 接口：重启 DeepSeek Harness 让宿主侧生效后即可": " — the host hasn't registered the toolTailor interface yet; restart DeepSeek Harness to activate it",
 "　本项目当前有 ": " This project currently has ",
 "、": ", ",
 "。DSH 0.1.5 起各注册作用域可独立使用同名；更早的版本按全进程唯一判定，同名会导致其中一份启动失败。": ". Since DSH 0.1.5, registered scopes can reuse the same name independently; earlier versions treat names as process-wide unique, and duplicates make one of them fail to start.",
 "。点开对应条目查看具体错误。": ". Open the matching entry to see the exact error.",
 "」分类管理": "\" category manager",
 "」即专家接管。送还 = 摘除该预设与已装捆绑技能（热加载，无需重启）。": "\"; that preset takes over the session. Unsummon = remove the preset and its bundled skills (hot reload, no restart).",
 "」？将从": "\"? This will remove it from ",
 "一并安装捆绑技能（本机 WorkBuddy 缓存完整安装；无缓存时仅装 SKILL.md）": "Also install bundled skills (full install from local WorkBuddy cache; without cache, SKILL.md only)",
 "三个入口全开": "All three entries",
 "上一页": "Previous page",
 "下一页": "Next page",
 "不兼容": "Incompatible",
 "不兼容：": "Incompatible: ",
 "不可安装": "Not installable",
 "专家": "Experts",
 "专家团": "Expert team",
 "专家详情": "Expert details",
 "专家随时挂/换/摘：点一个即接管本会话，再点别的直接换，点 chip 的 × 取消": "Attach/switch/detach experts anytime: click one to take over this session, click another to switch, click a chip's × to detach",
 "中删除。": ".",
 "中未出现在 JSON 里的 MCP。确认继续？": " that are absent from the JSON. Confirm to continue?",
 "中未出现在这份来源里的 MCP。确认继续？": " that are absent from this source. Confirm to continue?",
 "主理人": "Lead",
 "人设正文（{0} 字符）": "Persona body ({0} chars)",
 "人设正文（{0} 字符，召唤后成为会话系统提示）": "Persona body ({0} chars; becomes the session system prompt after summoning)",
 "仅侧栏底部入口": "Sidebar bottom entry only",
 "仅全局面板（左上角，\"插件\"旁）": "Global panel only (top-left, next to \"Plugins\")",
 "仅在本页 {0} 条里筛出已安装的（SkillHub 是远程分页，无法跨页筛选）": "Filters installed ones within this page's {0} entries only (SkillHub pages remotely; cross-page filtering isn't possible)",
 "仅展示": "Display only",
 "仅悬浮按钮": "Floating button only",
 "悬浮按钮设置": "Floating button settings",
 "从左侧列表点选一台服务器，可以查看它的连接信息、参数与工具清单。": "Pick a server from the list on the left to view its connection info, parameters and tool list.",
 "从左侧选择一个 skill 查看详情": "Pick a skill on the left to see details",
 "从未": "Never",
 "从本机客户端导入": "Import from local clients",
 "从预设模板快速填充（可选，命令需本机 npx/uvx）": "Quick-fill from preset template (optional; commands need local npx/uvx)",
 "以下项目也定义了同名 serverName：": "These projects also define a serverName with the same name:",
 "会话": "Sessions",
 "会话 {0}": "Session {0}",
 "传输": "Transport",
 "传输类型": "Transport type",
 "何时使用": "When to use",
 "作用域": "Scope",
 "作用域故障": "Scope failure",
 "作用域隔离失败": "Scope isolation failed",
 "保存": "Save",
 "保存中…": "Saving…",
 "保存失败": "Save failed",
 "入口": "Entries",
 "入口显示：": "Entry display:",
 "全局": "Global",
 "全局 MCP": "Global MCPs",
 "全局共享": "Globally shared",
 "全局配置": "Global config",
 "全局配置（在「全局」标签页可编辑）": "Global config (editable on the 'Global' tab)",
 "全局面板 + 悬浮按钮（推荐）": "Global panel + floating button (recommended)",
 "全局面板 + 侧栏底部入口（无悬浮按钮）": "Global panel + sidebar bottom entry (no floating button)",
 "全部": "All",
 "全部传输": "All transports",
 "全部状态": "All states",
 "共 {0} 个": "Total {0}",
 "关闭": "Close",
 "关闭更新提示": "Dismiss update notice",
 "其他 bundle / Agent（只读）": "Other bundles / agents (read-only)",
 "其余分类仍可正常使用；完整堆栈已打印到控制台。": "Other categories keep working; the full stack trace is printed to the console.",
 "再看看这些（目录前 {0} 位未召唤）": "Also consider these (first {0} in catalog, not yet summoned)",
 "出现过的工具（含已卸载 MCP 的历史调用）": "Tools ever seen (including historical calls of uninstalled MCPs)",
 "列表（最多显示 6 行，滚动查看更多）": "List (shows up to 6 rows; scroll for more)",
 "刚刚": "just now",
 "删除 ": "Delete ",
 "删除此项": "Delete this entry",
 "刷新": "Refresh",
 "刷新 MCP 状态": "Refresh MCP status",
 "刷新中…": "Refreshing…",
 "刷新连接器目录失败，当前显示的是本机快照：{0}": "Failed to refresh the connector catalog; showing the local snapshot: {0}",
 "加载失败": "Load failed",
 "动作": "Actions",
 "升级": "Upgrade",
 "升级失败。": "Upgrade failed.",
 "升级失败（": "Upgrade failed (",
 "升级失败：": "Upgrade failed: ",
 "升级由官方 pluginManager 执行，装完需要重启宿主": "Upgrades run through the official pluginManager; restart the host after installing",
 "卸载": "Uninstall",
 "卸载失败": "Uninstall failed",
 "去市场找现成的": "Find ready-made ones in the Market",
 "去市场挑专家": "Pick experts in the Market",
 "去市场看全部": "See all in the Market",
 "参数": "Parameters",
 "参数（每行一个，原样传给进程）": "Arguments (one per line, passed to the process verbatim)",
 "取消": "Cancel",
 "取消「只看已安装」": "Turn off 'Installed only'",
 "取消「只看零调用」": "Turn off 'Zero-call only'",
 "取消失败：": "Cancel failed: ",
 "取消选择来源": "Clear source selection",
 "另含 {0} 个连接器技能，如需请从技能市场或手动安装。": "Also includes {0} connector skills; install from the skill market or manually if needed.",
 "只显示模型可以主动调用的 skill": "Show only skills the model can invoke on its own",
 "只显示用户可以用 /名字 触发的 skill": "Show only skills the user can trigger with /name",
 "只看可直接安装": "Directly installable only",
 "只看已安装": "Installed only",
 "只看来自该来源的 skill": "Show only skills from this source",
 "只看窗口内零调用的工具": "Show only zero-call tools in the window",
 "只看窗口内零调用的工具（默认关闭：默认显示全部工具与真实调用次数）": "Show only zero-call tools in the window (off by default: all tools with real call counts are shown)",
 "只看零调用": "Zero-call only",
 "只看零调用（{0}）": "Zero-call only ({0})",
 "召唤": "Summon",
 "召唤 = 往 profile 补丁写入一条独立 Agent 预设（人设全程接管该预设的会话，标准工具原样保留）；": "Summon = write an independent agent preset into the profile patch (the persona takes over that preset's sessions; standard tools are kept); ",
 "召唤专家团": "Summon expert team",
 "召唤中…": "Summoning…",
 "召唤后它会作为独立 Agent 预设出现在新会话的预设选择器里；也可以直接从下面的推荐位挑一位。": "After summoning it appears as an independent agent preset in new sessions' preset selector; you can also pick one from the recommendations below.",
 "召唤失败": "Summon failed",
 "召唤的专家是「预设」：新建会话时在预设选择器里选它才真正接管。想立刻让某个专家接管当前会话，用输入框左侧的召唤菜单。": "Summoned experts are presets: they take over only when you pick them in the preset selector of a new session. To have an expert take over the current session right away, use the summon menu at the left of the input box.",
 "可以从这几位开始（目录前 {0} 位）": "Start with these (first {0} in the catalog)",
 "可安装": "Installable",
 "可见：": "Visible: ",
 "可选": "Optional",
 "可选值：": "Allowed values: ",
 "可选项": "Options",
 "合并（同名更新）": "Merge (update same names)",
 "否（补丁中 disabled: true）": "No (disabled: true in patch)",
 "含 {0} 技能": "{0} skills included",
 "注入规则 ×{0}": "injection rules ×{0}",
 "适用环境：": "Works with: ",
 "{0} 个连接器适用": "{0} connectors",
 "清除标签筛选": "Clear tag filter",
 " +{0}": " +{0}",
 "存在 {0} 条 token 注入规则（依赖 WB 账号体系，DSH 不代注入）。": "{0} token injection rules exist (relies on the WB account system; DSH does not inject on your behalf).",
 "存在 token 注入规则（依赖 WB 账号体系，DSH 不代注入）": "Token injection rules exist (relies on the WB account system; DSH does not inject on your behalf)",
 "凭据: ": "Credential: ",
 "插件": "Plugins",
 "搜索插件（名称 / 描述 / 作者）": "Search plugins (name / description / author)",
 "读取插件目录失败": "Failed to load the plugin catalog",
 "目录缓存已过期（更新源暂时不可达，显示的是本地缓存）。": "The cached catalog is stale (update sources unreachable; showing the local cache).",
 "DSH 社区目录有新版本（本地缓存 {0}）。点「重新加载」可拉取最新目录。": "The DSH community catalog has a newer version (local cache {0}). Click \"Reload\" to fetch the latest catalog.",
 "本地还没有 DSH 社区目录缓存，点「重新加载」可首次拉取目录。": "No local DSH community catalog cache yet. Click \"Reload\" to fetch it for the first time.",
 
 "正在加载 DSH 社区目录…": "Loading the DSH community catalog…",
 "DSH 社区目录暂时是空的": "The DSH community catalog is temporarily empty",
 "目录来自 awesome-dsh-plugins 社区清单（jsdelivr CDN 分发），拉取失败可重试。": "The catalog comes from the awesome-dsh-plugins community registry (jsdelivr CDN); retry if fetching failed.",
 "没有匹配的社区插件": "No matching community plugins",
 "换个关键词，或清空分类与标签筛选。": "Try another keyword, or clear the category and tag filters.",
 "清空筛选": "Clear filters",
 "该条目未提供 npm 包名，暂不支持安装": "This entry has no npm package name and cannot be installed yet",
 "暂不支持安装": "Not installable yet",
 "宿主组件": "Host component",
 "DSH 宿主官方组件随宿主本体分发，无法也不需要从市场安装": "Official DSH host component — it ships with the DSH host itself and cannot (and need not) be installed from the market",
 "官方": "Official",
 "CodeBuddy 官方": "CodeBuddy Official",
 "DSH 社区": "DSH Community",
 "套件": "Bundles",
 "最新收录": "Recently added",
 "正在安装插件 {0}…": "Installing plugin {0}…",
 "正在安装 {0} 个插件…": "Installing {0} plugin(s)…",
 "宿主未提供插件管理器（pluginManager），无法安装插件": "The host does not expose a plugin manager (pluginManager); cannot install plugins",
 "插件 {0} 安装成功，需重启 DSH 宿主后生效。": "Plugin {0} installed. Restart the DSH host for it to take effect.",
 "知道了": "Got it",
 "调用失败": "Call failed",
 "（{0}）": " ({0})",
 "含技能": "With skills",
 "含需掩码字段：": "Contains fields needing masking: ",
 "启动失败策略": "Start-failure policy",
 "启用": "Enable",
 "启用服务器 {0}": "Enable server {0}",
 "命令": "Command",
 "命令面板": "Command palette",
 "团队型走 DSH 桥接：主理人人设接管会话，": "Team-type experts bridge through DSH: the lead's persona takes over the session, ",
 "团队编制（{0} 人 · 召唤后成员人设落盘，由主理人调度）": "Team roster ({0} members · personas land on disk after summoning; dispatched by the lead)",
 "在 GitHub 打开 dsh-armory 仓库，点右上角的 Star": "Open the dsh-armory repo on GitHub and click Star in its top-right corner",
 "在 Skill 页查看 {0}": "View {0} on the Skill page",
 "在 profile 里找不到这个插件，未升级。": "Plugin not found in the profile; not upgraded.",
 "在不离开会话的情况下查看 MCP": "Inspect MCPs without leaving the session",
 "在场 · {0} 会话": "Present · {0} sessions",
 "在此项目可见": "Visible in this project",
 "在此项目可见，点击屏蔽": "Visible in this project; click to block",
 "复制 ": "Copy ",
 "复制失败": "Copy failed",
 "复制工具名": "Copy tool name",
 "复制错误详情": "Copy error details",
 "大体量": "Heavyweight",
 "失败": "Failed",
 "存在重复 serverName（冲突，只读）": "Duplicate serverName exists (conflict, read-only)",
 "安全: ": "Security: ",
 "安装": "Install",
 "安装 = 逐文件下载并 sha256 校验后写入 ~/.agents/skills/，即刻被 DSH 发现（无需重启）。已装版本重装即更新。": "Install = download file by file with sha256 verification into ~/.agents/skills/; DSH picks it up immediately (no restart). Reinstalling an installed version updates it.",
 "安装中…": "Installing…",
 "该技能正在安装中，请等当前任务结束": "This skill is already installing; wait for the current task to finish.",
 "安装到全局": "Install globally",
 "安装失败": "Install failed",
 "安装于 {0}": "Installed {0}",
 "安装时间": "Install time",
 "安装时间与市场原名不可用：{0}。宿主侧接口在重启 DeepSeek Harness 后才会注册，重启后即可显示。": "Install times and market names unavailable: {0}. The host-side API registers only after restarting DeepSeek Harness; they will appear after a restart.",
 "按安装时间倒序平铺；随 DSH 分发、运行时注册的技能没有安装时间，不在此列": "Flat list sorted by install time, newest first; skills shipped with DSH or registered at runtime have no install time and are not listed",
 "它在市场里叫「{0}」，安装后看板显示的是 SKILL.md 的 name 字段。": "It is called \"{0}\" in the market; the board shows the name field from SKILL.md after install.",
 "安装任务已结束": "Install finished",
 "大肥鱼军械库": "Big Fish Armory",
 "宿主正在停止，未升级；请重启后再试。": "Host is shutting down; not upgraded. Restart and try again.",
 "宿主没有挂载 skill 注册表（@deepseek-ai/dsh-skill），本看板不可用": "Host has no skill registry mounted (@deepseek-ai/dsh-skill); this board is unavailable",
 "导入 MCP": "Import MCPs",
 "导入 MCP（": "Import MCPs (",
 "导入中…": "Importing…",
 "导入失败": "Import failed",
 "尚无会话持有该项目连接，或连接尚未就绪": "No session holds the project connection yet, or it isn't ready",
 "尚未建立": "Not established yet",
 "尚未建立连接（新会话自动挂载）": "No connection yet (new sessions attach automatically)",
 "屏蔽未能写入会话作用域：": "Failed to write block into the session scope: ",
 "展开工具清单": "Expand tool list",
 "工作目录": "Working directory",
 "工作目录 cwd（可选）": "Working directory cwd (optional)",
 "工具": "Tools",
 "工具使用账本：谁在被调用、谁在白缴上下文税。": "Tool usage ledger: who gets called, who pays dead context tax.",
 "工具命名与其他 serverName 前缀重叠，无法可靠判断归属；请避免在 serverName 中使用双下划线。": "Tool names overlap other serverName prefixes; ownership can't be determined reliably. Avoid double underscores in serverName.",
 "工具归属存在命名歧义": "Tool ownership is ambiguous",
 "工具数 ≥ {0}：进详情默认折叠工具清单": "Tools ≥ {0}: tool list starts collapsed in details",
 "工具裁缝": "Tool Tailor",
 "工具调用超时（毫秒）": "Tool call timeout (ms)",
 "工具账本加载失败；其余分类仍可正常使用。": "Failed to load the tool ledger; other categories keep working.",
 "工具超时和最大尝试次数必须是正整数": "Tool timeout and max attempts must be positive integers",
 "工具（": "Tools (",
 "已保存 ": "Saved ",
 "已停止": "Stopped",
 "已写入 MCP 配置": "MCP config written",
 "已刷新项目 MCP，共 ": "Refreshed project MCPs: ",
 "已刷新，共 ": "Refreshed: ",
 "已升级到 v": "Upgraded to v",
 "已卸载": "Uninstalled",
 "已取消屏蔽 ": "Unblocked ",
 "已召唤": "Summoned",
 "已召唤 · 未接管": "Summoned · not attached",
 "已召唤专家列表加载失败；其余分类仍可正常使用。": "Failed to load summoned experts; other categories keep working.",
 "已召唤专家详情": "Summoned expert details",
 "已召唤的专家：人设、捆绑技能、当前在场状态，可送还。": "Summoned experts: persona, bundled skills, current presence; can be returned.",
 "已启用 ": "Enabled ",
 "已启用 {0}": "Enabled {0}",
 "已在此项目屏蔽": "Blocked in this project",
 "已在此项目屏蔽，点击恢复可见": "Blocked in this project; click to unblock",
 "已复制": "Copied",
 "已复制「{0}」": "Copied \"{0}\"",
 "已复制到剪贴板": "Copied to clipboard",
 "已复制，粘贴到输入框": "Copied; paste into the input box",
 "已安装": "Installed",
 "目录默认顺序": "Catalog order",
 "技能数由多到少": "Most skills first",
 "名称 A→Z": "Name A→Z",
 "重新加载": "Reload",
 "已导入 MCP": "MCPs imported",
 "已屏蔽": "Blocked",
 "已屏蔽 ": "Blocked ",
 "已屏蔽：": "Blocked: ",
 "已挂": "Attached",
 "已挂专家：": "Attached expert: ",
 "已添加 ": "Added ",
 "已禁用": "Disabled",
 "已禁用 ": "Disabled ",
 "已禁用 {0}": "Disabled {0}",
 "已禁用技能 {0}": "Skill {0} disabled",
 "已释放技能 {0}": "Skill {0} re-enabled",
 "已移除 ": "Removed ",
 "已脱敏": "Masked",
 "已请求重连 ": "Reconnect requested ",
 "已连接": "Connected",
 "已连接 · ": "Connected · ",
 "已连接 · 当前无会话使用（连接保留，下次直接用）": "Connected · no session using it right now (connection kept for next time)",
 "已重连 ": "Reconnected ",
 "已隐藏 {0} 个不兼容条目": "Hidden {0} incompatible entries",
 "市场": "Market",
 "市场原名": "Market name",
 "市场原名：{0}": "Market name: {0}",
 "安装目录：{0}": "Install directory: {0}",
 "这个 skill 的安装目录名，namespace__slug 形态即它在市场里的标识。": "This skill's install directory name; the namespace__slug form is its identity in the market.",
 "市场数据加载失败；其余分类仍可正常使用。": "Failed to load market data; other categories keep working.",
 "市场：连接器、SkillHub 技能与专家召唤。": "Market: connectors, SkillHub skills and expert summoning.",
 "归属存疑": "Ownership uncertain",
 "当前": "Current",
 "当前 Web profile": "Current web profile",
 "当前 Web profile 配置": "Current web profile config",
 "当前 Web profile（可编辑）": "Current web profile (editable)",
 "当前 profile 由应用托管，不允许在这里改动。": "The current profile is app-managed and can't be edited here.",
 "当前在场": "Currently present",
 "当前搜索或过滤条件下没有结果；清空关键词或把状态切回「全部状态」试试。": "No results under the current search/filter; clear the query or set the state filter back to 'All'.",
 "当前有 {0} 个 skill，但都被筛选条挡住了。": "{0} skills exist, but all are filtered out.",
 "当前生效专家（人设接管本会话；可在输入框工具行的专家菜单随时换/摘）": "Active expert (persona runs this session; swap/detach anytime from the expert menu on the input toolbar)",
 "当前筛选下没有可安装的连接器": "No installable connectors under the current filter",
 "当前运行在 Node {0}，请升级到 22.15 以上后重启宿主。": "Running Node {0}; upgrade to 22.15+ and restart the host.",
 "必填": "Required",
 "快速调用": "Quick invoke",
 "总体错误率（{0} 次失败）": "Overall error rate ({0} failures)",
 "成员": "Members",
 "成员产出回传主理人汇总。WorkBuddy 的 TeamCreate 无需调用 —— 团队编制在召唤时已固定。": "member output flows back to the lead for aggregation. WorkBuddy's TeamCreate needs no call — the roster is fixed at summon time.",
 "或粘贴 JSON：支持 Claude/Cursor/Cline/Roo 的 mcpServers、VS Code 的 servers，以及单个 MCP 对象": "or paste JSON: supports mcpServers from Claude/Cursor/Cline/Roo, servers from VS Code, and a single MCP object",
 "手动添加": "Add manually",
 "打开": "Open",
 "打开悬浮管理面板": "Open the floating panel",
 "打开技能 · MCP · 专家看板": "Open the Skills · MCPs · Experts board",
 "打开技能、MCP、专家快速调用菜单": "Open the skills/MCPs/experts quick-invoke menu",
 "打开目录": "Open directory",
 "打开看板的「": "Open the board's \"",
 "执行": "Execute",
 "扫描 {0} 个会话 · 读 {1} 个日志": "Scanned {0} sessions · read {1} logs",
 "扫描中…": "Scanning…",
 "扫描后给出": "After the scan: ",
 "技能": "Skills",
 "技能（skill 工具）": "Skills (skill tool)",
 "技能账本：窗口内共 {0} 次 skill 调用；注册表 {1} 个技能中 {2} 个一次没被调用": "Skill ledger: {0} skill calls in the window; {2} of the {1} registered skills were never called",
 "技能账本：窗口内共 {0} 次 skill 调用；注册表不可用，只列出日志里出现过的 {1} 个": "Skill ledger: {0} skill calls in the window; the registry is unavailable, so only the {1} seen in logs are listed",
 "一次没被调用": "never called",
 "有 {0} 次 skill 调用的参数里没有技能名，未计入上表": "{0} skill calls carried no skill name in their arguments and are not counted above",
 "暂无技能调用": "No skill calls yet",
 "技能 / MCP / 专家 快速调用": "Skills / MCPs / Experts quick invoke",
 "技能 · MCP · 专家": "Skills · MCPs · Experts",
 "技能 · MCP · 专家看板": "Skills · MCPs · Experts board",
 "技能 · MCP · 专家看板（拖拽移动，右键或长按隐藏）": "Skills · MCPs · Experts board (drag to move; right-click or long-press to hide)",
 "技能·专家": "Skills·Experts",
 "技能按需触发：选择后以 /技能名 插入输入框": "Skills trigger on demand: picking inserts /skill-name into the input box",
 "技能来自 SkillHub 公开 API，可能还没同步下来。": "Skills come from the public SkillHub API and may not have synced yet.",
 "技能目录暂时是空的": "The skill catalog is empty for now",
 "技能详情": "Skill details",
 "把 skill 所在目录交给宿主在资源管理器中打开（只读定位）": "Ask the host to open the skill's directory in the file explorer (read-only locate)",
 "挂到当前会话（可随时换或取消）；再点别的专家 = 直接替换": "Attach to the current session (swap or detach anytime); clicking another expert replaces it",
 "挂载失败": "Attach failed",
 "挂载失败：": "Attach failed: ",
 "人设已生效，但该会话残留旧注册，取消需重启 DSH 后生效。": "The persona is active, but a stale registration remains in this session; restart DSH before it can be detached.",
 "人设正文是按专家介绍生成的替身，不是原作者设定；原文不可用。": "The persona text is a stand-in generated from the expert profile, not the author's original; the original is unavailable.",
 "挂载异常：": "Attach error: ",
 "指令内容（": "Instruction body (",
 "按传输过滤": "Filter by transport",
 "按服务器看工具清单、连接状态与参数；可增删、重连、导入。": "Per-server tool list, connection status and parameters; add, remove, reconnect, import.",
 "按状态过滤": "Filter by status",
 "换个关键词试试，或清空搜索回到完整目录。": "Try another keyword, or clear the search to see the full catalog.",
 "描述": "Description",
 "提示：": "Tip: ",
 "搜索": "Search",
 "搜索 MCP…": "Search MCPs…",
 "搜索 MCP、技能、专家，或跳转分类…": "Search MCPs, skills, experts, or jump to a category…",
 "搜索 SkillHub 技能（19 万+）": "Search SkillHub skills (190k+)",
 "搜索 skill": "Search skills",
 "搜索 skill…": "Search skills…",
 "搜索专家（花名 / 职业 / 描述 / 标签）": "Search experts (alias / role / description / tags)",
 "搜索全局 MCP…": "Search global MCPs…",
 "搜索工具名或描述…": "Search tool name or description…",
 "搜索时自动在全库匹配（忽略分类）": "Search matches across all libraries (ignores category)",
 "搜索连接器（名称 / 说明 / ID）": "Search connectors (name / description / ID)",
 "摘掉专家": "Detach expert",
 "摘掉专家（切回默认预设）": "Detach expert (back to default preset)",
 "操作": "Operations",
 "收起原始 JSON": "Collapse raw JSON",
 "收起参数": "Collapse parameters",
 "收起工具清单": "Collapse tool list",
 "断开后自动重连": "Auto-reconnect after disconnect",
 "新增：": "New: ",
 "新建会话时选择「WorkBuddy 专家 · ": "When creating a session, pick \"WorkBuddy Expert · ",
 "新版本 v": "New version v",
 "新版本与当前 DSH 不兼容，未升级。": "New version is incompatible with the current DSH; not upgraded.",
 "无": "None",
 "无捆绑技能": "No bundled skills",
 "无捆绑技能（预设本体在 profile 补丁）": "No bundled skills (preset body lives in the profile patch)",
 "无法确定要升级哪个包，未升级。": "Can't determine which package to upgrade; not upgraded.",
 "是": "Yes",
 "显示 ": "Show ",
 "显示 {0} / {1}": "Show {0} / {1}",
 "显示/隐藏 ": "Show/hide ",
 "显示全部条目": "Show all entries",
 "显示原值：": "Reveal value: ",
 "暂无可选项": "No options yet",
 "暂无工具": "No tools yet",
 "暂无数据": "No data yet",
 "更多操作": "More actions",
 "更新中…": "Updating…",
 "更新预设": "Update preset",
 "更新：": "Update: ",
 "替换会删除": "Replacing will remove",
 "替换当前 Profile": "Replace current profile",
 "替换该项目": "Replace this project",
 "最后使用": "Last used",
 "下载量（本页排序）": "Downloads (this page)",
  "SkillHub 已不再提供全站下载量排序；这一项只在当前页内按下载量排序。": "SkillHub no longer offers a global download ranking; this option sorts by downloads within the current page only.",
 "最多安装": "Most installs",
 "最多星标": "Most stars",
 "最大尝试次数": "Max attempts",
 "最大延迟 ms": "Max delay ms",
 "最新版本说明：": "Latest release notes: ",
 "最近": "Recent",
 "最近使用": "Recently used",
 "最近安装": "Recently installed",
 "服务器": "Servers",
 "未知来源": "Unknown source",
 "未知错误": "Unknown error",
 "本会话没有挂着专家": "No expert attached to this session",
 "本会话由该专家人设接管；点 × 摘掉（不动预设选择器）": "This session is run by that expert's persona; click × to detach (preset selector untouched)",
 "本地 Skill 清单：来源、是否启用、是否可被模型调用。": "Local skill inventory: source, enabled state, model-invocable.",
 "本地安装（": "Local install (",
 "本次更新内容": "What's new in this release",
 "本版本内不再提示": "Don't show again in this version",
 "本页已安装 {0} / {1}": "Installed on this page {0} / {1}",
 "本页没有已安装的技能": "No installed skills on this page",
 "来自 mcp-client 最近日志": "From recent mcp-client logs",
 "来自其他配置层，只读": "From another config layer, read-only",
 "构建授权已过期，未升级；请重试。": "Build authorization expired; not upgraded. Please retry.",
 "查看": "View",
 "查看原始 JSON": "View raw JSON",
 "查看参数": "View parameters",
 "查看更新方式": "See how to update",
 "模型可调用": "Model-invocable",
 "正在下载并校验 {0}…": "Downloading and verifying {0}…",
 "正在升级到 v": "Upgrading to v",
 "正在卸载 {0}…": "Uninstalling {0}…",
 "正在召唤 {0}{1}…": "Summoning {0}{1}…",
 "正在召唤 {0}…": "Summoning {0}…",
 "正在安装 {0}…": "Installing {0}…",
 "正在扫描本机客户端配置…": "Scanning local client configs…",
 "正在挂载专家…": "Attaching expert…",
 "正在读取…": "Reading…",
 "正在读取专家目录…": "Reading expert catalog…",
 "正在读取已召唤专家…": "Reading summoned experts…",
 "正在读取技能目录…": "Reading skill catalog…",
 "正在读取清单…": "Reading inventory…",
 "正在读取详情…": "Reading details…",
 "正在读取连接器目录…": "Reading connector catalog…",
 "正在送还 {0}…": "Returning {0}…",
 "此 MCP 由全局配置提供。要改它的连接配置，请切到「全局」标签页；在这里只能决定它对本项目是否可见。": "This MCP comes from the global config. To edit its connection, switch to the 'Global' tab; here you can only toggle its visibility to this project.",
 "此参数含密钥，已脱敏；需要时可在「编辑」里显式查看": "This parameter holds a key and is masked; reveal it explicitly in 'Edit' if needed",
 "此项目的 MCP": "This project's MCPs",
 "此项目还没有 MCP。用右上角「添加项目 MCP」或「市场」写入 .dsh/mcp.json": "No MCPs in this project yet. Use 'Add project MCP' (top right) or the 'Market' to write .dsh/mcp.json",
 "每位成员的人设落盘到 ~/.dsh/wb-market/experts/teams/ 下，主理人按 SOP 依次用 subagent 调度（人设正文注入 prompt），": "Each member's persona lands under ~/.dsh/wb-market/experts/teams/; the lead dispatches members in SOP order via subagent (persona body injected into the prompt), ",
 "每轮请求白缴的上下文税": "Context tax paid per request",
 "没有专家正在接管会话": "No expert is running the session",
 "没有全局 MCP": "No global MCPs",
 "没有匹配「{0}」的工具": "No tools matching \"{0}\"",
 "没有匹配的 MCP": "No matching MCPs",
 "没有匹配的专家，换个关键词或分类试试": "No matching experts; try another keyword or category",
 "没有匹配的全局 MCP": "No matching global MCPs",
 "没有匹配项": "No matches",
 "没有可导入的 MCP": "No importable MCPs",
 "没有搜到「{0}」相关的技能": "No skills found for \"{0}\"",
 "没有活动会话：请先进入一个会话再挂专家": "No active session: enter a session before attaching an expert",
 "没有符合筛选条件的 skill": "No skills match the filters",
 "没检测到本机客户端的全局 MCP 配置（~/.claude.json / ~/.codex/config.toml / ~/.config/opencode/opencode.json 等），可在下面手动粘贴": "No global MCP config detected from local clients (~/.claude.json / ~/.codex/config.toml / ~/.config/opencode/opencode.json etc.); paste it manually below",
 "没检测到这个项目的项目级 MCP 配置（.mcp.json / .codex/config.toml / .pi/mcp.json / opencode.json 等），可在下面手动粘贴": "No project-level MCP config detected for this project (.mcp.json / .codex/config.toml / .pi/mcp.json / opencode.json etc.); paste it manually below",
 "添加": "Add",
 "添加 MCP": "Add MCP",
 "添加一个 HTTP 或 stdio 服务器，或在「市场」里挑选现成的连接器。": "Add an HTTP or stdio server, or pick a ready-made connector in the 'Market'.",
 "添加失败": "Add failed",
 "添加项目 MCP": "Add project MCP",
 "清空": "Clear",
 "清空搜索": "Clear search",
 "清除全部筛选": "Clear all filters",
 "清除来源筛选": "Clear source filter",
 "点 Star": "Star it",
 "点击切换到此分类": "Click to switch to this category",
 "版本号不合法，未升级。": "Invalid version; not upgraded.",
 "状态未知": "State unknown",
 "环境变量": "Environment variables",
 "环境变量 ": "Environment variable ",
 "环境变量未设置：": "Environment variable not set: ",
 "环境变量（可选，值写 !!js process.env.KEY 引用密钥）": "Environment variables (optional; use !!js process.env.KEY for secrets)",
 "用户 ~/.agents/skills": "User ~/.agents/skills",
 "用户 ~/.dsh/skills": "User ~/.dsh/skills",
 "用户可调用": "User-invocable",
 "用法示例": "Usage example",
 "目录来自 WorkBuddy 官方分发，可能还没同步下来；重读一次通常就好。": "The catalog comes from official WorkBuddy distribution and may not have synced; re-reading usually fixes it.",
 "目录里有 {0} 个条目，「只看可直接安装」把不具备传输类型的挡掉了。": "The catalog has {0} entries; 'Directly installable only' hides the ones without a transport type.",
 "看板分类": "Board categories",
 "看这次改了什么": "See what changed",
 "确认从来源导入": "Confirm import from source",
 "确认导入": "Confirm import",
 "确认移除 MCP「": "Confirm removal of MCP \"",
 "确认送还": "Confirm return",
 "恢复模型调用该技能": "Let the model invoke this skill again",
 "禁用": "Disable",
 "禁用后模型不再加载该技能，不再缴它的上下文税；手动 /引用 不受影响": "Disabling keeps the model from loading this skill, so its schema stops costing context tax; manual /references are unaffected",
 "禁用服务器 {0}": "Disable server {0}",
 "移除": "Remove",
 "移除：": "Remove: ",
 "窗口内没有零调用的工具（共 {0} 个工具都有调用，关掉「只看零调用」即可看全部）": "No zero-call tools in the window (all {0} tools have calls; turn off 'Zero-call only' to see everything)",
 "窗口内调用": "Calls in window",
 "第 {0} / {1} 页 · 共 {2} 个技能": "Page {0} / {1} · {2} skills",
 "第三方接口的字段可能随上游改版变化，安装前请在详情里核对传输类型与凭据要求。": "Third-party API fields may change upstream; verify transport type and credential requirements in details before installing.",
 "筛选": "Filters",
 "管理{0}…": "Manage {0}…",
 "给 dsh-armory 点 Star（新标签页打开 GitHub 仓库）": "Star dsh-armory on GitHub (opens the repo in a new tab)",
 "综合评分": "Overall score",
 "编辑": "Edit",
 "编辑 MCP": "Edit MCP",
 "自动重连": "Auto-reconnect",
 "自定义目录": "Custom directory",
 "裁缝建议：": "Tailor suggestions: ",
 "装 {0}": "Install {0}",
 "装于 {0}": "Added {0}",
 "解析中…": "Parsing…",
 "解析并预览": "Parse and preview",
 "认证": "Authentication",
 "记录错误并继续": "Log the error and continue",
 "试试这样问": "Try asking like this",
 "该 MCP 来自其他配置层，配置只读，无法查看具体值": "This MCP comes from another config layer and is read-only; exact values can't be shown",
 "该专家以独立 Agent 预设生效：新建会话时在预设选择器选择「WorkBuddy 专家 · …」即专家接管。送还会同时清掉它的捆绑技能。": "This expert works as an independent agent preset: pick \"WorkBuddy Expert · …\" in a new session's preset selector to hand over. Returning also clears its bundled skills.",
 "该包正在被使用，未升级。": "The package is in use; not upgraded.",
 "该包没有声明组合包，不能作为插件安装。": "The package declares no bundle; it can't be installed as a plugin.",
 "该项目": "This project",
 "详情": "Details",
 "请使用 {0} 的 MCP 工具（mcp__{1}__*）处理接下来的任务": "Use {0}'s MCP tools (mcp__{1}__*) for the tasks ahead",
 "请填写 MCP 名称": "Please fill in the MCP name",
 "读取 skill 内容…": "Reading skill content…",
 "读取 skill 内容失败": "Failed to read skill content",
 "读取 skill 列表失败": "Failed to read the skill list",
 "读取专家目录失败": "Failed to read the expert catalog",
 "读取中…": "Reading…",
 "读取失败": "Read failed",
 "读取已召唤专家失败": "Failed to read summoned experts",
 "读取技能目录失败": "Failed to read the skill catalog",
 "读取本机客户端配置失败": "Failed to read local client configs",
 "读取详情失败": "Failed to read details",
 "读取连接器目录失败": "Failed to read the connector catalog",
 "读取配置失败": "Failed to read config",
 "调用": "Calls",
 "调用 {0}": "Call {0}",
 "调用 {0} · 错误 {1}": "Calls {0} · errors {1}",
 "调用 {0} 次": "Called {0} times",
 "调用超时": "Call timeout",
 "账本加载失败：": "Ledger load failed: ",
 "跳转": "Go",
 "运行时注册": "Runtime-registered",
 "运行策略": "Run policy",
 "近 30 天": "Last 30 days",
 "近 30 天调用 {0} 次": "Called {0} times in the last 30 days",
 "近 30 天：调用 {0} 次，失败 {1} 次": "Last 30 days: {0} calls, {1} failures",
 "近 7 天": "Last 7 days",
 "近 90 天": "Last 90 days",
 "近 {0} 天每日调用": "Daily calls over the last {0} days",
 "近 {0} 天每日调用量（左旧右新）": "Daily call volume over the last {0} days (older on the left)",
 "还有 {0} 个作用域": "{0} more scopes",
 "还没有 MCP 服务器": "No MCP servers yet",
 "还没有召唤任何专家": "No experts summoned yet",
 "这一项无法被单独改动（随 DSH 提供）。": "This entry can't be changed on its own (ships with DSH).",
 "这个作用域下没有发现 skill": "No skills found in this scope",
 "这个工作区没有本地 skill": "No local skills in this workspace",
 "项目作用域只显示工作区里 .agents/skills 与 .dsh/skills 的技能；用户级与随包分发的技能请切到「全局」查看。": "Project scope only shows skills under the workspace's .agents/skills and .dsh/skills; switch to Global to see user-level and bundled skills.",
 "这个面板加载失败": "This panel failed to load",
 "这些变化你可能想知道": "Changes you may want to know about",
 "这些条目缺少传输类型等必要信息，本面板无法生成配置": "These entries lack required info like transport type; this panel can't generate config for them",
 "这条配置里没有可导入的 MCP": "This config has no importable MCPs",
 "这条预设是旧版本召唤写入的，人设缺 DSH 桥接段——用它的新会话开不出成员子智能体。点此直接更新。": "This preset was written by an older summon and its persona lacks the DSH bridge section — new sessions using it can't spawn member subagents. Click to update now.",
 "连接中…": "Connecting…",
 "连接信息": "Connection info",
 "连接器": "Connectors",
 "连接器 / 技能 / 专家均为第三方分发，本面板只做浏览与安装入口；内容版权归原作者所有。": "Connectors / skills / experts are third-party distributions; this panel only browses and installs. Content belongs to its authors.",
 "连接器来自 WorkBuddy 官方分发（static.workbuddy.cn）；技能来自 SkillHub 公开 API；专家来自 WorkBuddy 专家中心分发。": "Connectors come from official WorkBuddy distribution (static.workbuddy.cn); skills from the public SkillHub API; experts from the WorkBuddy expert center.",
 "连接器目录暂时是空的": "The connector catalog is empty for now",
 "连接器详情": "Connector details",
 "连接失败": "Connection failed",
 "连接状态": "Connection status",
 "送还": "Return",
 "送还后此人设从所有会话移除，确认送还？": "Returning removes this persona from all sessions. Confirm return?",
 "送还失败": "Return failed",
 "选择": "Select",
 "选择一个 MCP 查看详情": "Pick an MCP to see details",
 "选择预设模板": "Pick a preset template",
 "配置来源": "Config source",
 "配置项": "Config entries",
 "配置（只读，不修改它们的文件）": "Config (read-only; their files are not modified)",
 "重扫": "Rescan",
 "重新扫描": "Rescan",
 "重新读取服务器与工具清单": "Re-read servers and tool list",
 "重新读取目录": "Re-read the catalog",
 "重试": "Retry",
 "重连": "Reconnect",
 "重连延迟必须是有效正数且不超过 2147483647 ms": "Reconnect delay must be a positive number, at most 2147483647 ms",
 "重连本项目共享连接（拆掉旧连接并按当前配置重建，不影响其他会话）": "Reconnect this project's shared connection (tears down the old one and rebuilds from current config; other sessions unaffected)",
 "错误 (率)": "Errors (rate)",
 "错误码 ": "Error code ",
 "阻止插件启动": "Block plugin startup",
 "随 DSH 分发": "Ships with DSH",
 "隐藏 ": "Hide ",
 "隐藏原值：": "Hide value: ",
 "隐藏悬浮按钮": "Hide floating button",
 "这是当前唯一入口；先到面板「入口」菜单切换模式。": "This is the only entry right now; switch modes in the panel's \"Entries\" menu first.",
 "悬浮按钮已隐藏，可从左上角「大肥鱼军械库」或面板「入口」菜单重新打开。": "Floating button hidden. Reopen it from \"Big Fish Armory\" (top-left) or the panel's \"Entries\" menu.",
 "零调用": "Zero-call",
 "零调用工具": "Zero-call tools",
 "零调用的 MCP 工具 · 点击下钻": "Zero-call MCP tools · click to drill down",
 "零调用的 MCP 工具（已筛选）": "Zero-call MCP tools (filtered)",
 "需上游提供传输类型": "Needs upstream transport type",
 "需更新 · 点击更新": "Update available · click to update",
 "项目 .agents/skills": "Project .agents/skills",
 "项目 .dsh/skills": "Project .dsh/skills",
 "项目级": "Project-level",
 "项目配置": "Project config",
 "项目配置 .dsh/mcp.json（可编辑，本项目会话共享一份连接）": "Project config .dsh/mcp.json (editable; this project's sessions share one connection set)",
 "预览": "Preview",
 "预览失败": "Preview failed",
 "首次延迟 ms": "First delay ms",
 "首次延迟不能大于最大延迟": "First delay can't exceed max delay",
 "首次连接失败时阻止插件启动": "Block plugin startup on first-connect failure",
 "高错误率": "High error rate",
 "默认值：": "Default: ",
 "默认只显示可直接安装的条目；取消勾选可看到「仅展示」的不兼容条目": "By default only directly installable entries show; uncheck to see the incompatible 'display only' ones",
 "（": " (",
 "（仅 SKILL.md）": " (SKILL.md only)",
 "（共 {0}，已筛选）": " ({0} total, filtered)",
 "（写入召唤预设 + 落盘成员人设）": " (writes the summon preset + lands member personas)",
 "（刷新旧版预设行的人设）": " (refreshes the persona of an outdated preset row)",
 "（导入后在详情页可用眼睛查看）": " (view with the eye icon on the details page after import)",
 "（导入后该处会得到空值）": " (that field will be empty after import)",
 "（已认证）": " (authenticated)",
 "（当前 v": " (current v",
 "（无描述）": " (no description)",
 "（未知版本）": " (unknown version)",
 "（本会话全局生效）": " (applies globally in this session)",
 "（本机可完整安装）": " (fully installable locally)",
 "（配置无效：": " (invalid config: ",
 "）": ")",
 "）。": ").",
 "）请手动更新后重启": ") update manually and restart",
 "），一键升级会把本地副本换成 npm 包，故只提示": "); one-click upgrade would replace the local copy with the npm package, so notice only",
 "，": ", ",
 "，对运行中的会话立即生效": ", effective immediately for running sessions",
 "，重启宿主后生效": ", effective after restarting the host",
 "：已启用": ": enabled",
 "：已禁用": ": disabled",
 "成员由主理人用 subagent 调度；若本会话没有 subagent 工具，请新建会话并选择「WorkBuddy 专家 · {0}」预设": "Members are dispatched by the lead via subagent; if this session has no subagent tool, create a new session and pick the \"WorkBuddy Expert · {0}\" preset",
 "今日": "Today",
 "账本缓存": "Ledger cache",
  " 条": " items",
 "": "",
 "&": "&",
 "@^": "@^",
 "Skill": "Skill",
 "conversation.input.right": "conversation.input.right",
 "conversation.session.header.actions": "conversation.session.header.actions",
 "disable": "disable",
 "enable": "enable",
 "http": "http",
 "layout": "layout",
 "main": "main",
 "reconnect": "reconnect",
 "reconnectWorkspaceServer": "reconnectWorkspaceServer",
 "remote.mcpManager": "remote.mcpManager",
 "removeServer": "removeServer",
 "removeWorkspaceServer": "removeWorkspaceServer",
 "setWorkspaceExclude": "setWorkspaceExclude",
 "shell.overlay": "shell.overlay",
 "sidebar.footer.action": "sidebar.footer.action",
 "sidebar.panellist": "sidebar.panellist",
 "stdio": "stdio",
 "style": "style",
 "textarea": "textarea",
 "updateWorkspaceServer": "updateWorkspaceServer",
  "{0}{1}": "{0}{1}",
  "收起": "Collapse",
  "展开全文（{0} 字符）": "Expand full text ({0} characters)",
  "显示全部 {0} 条": "Show all {0}",
  "连接诊断": "Connection diagnostics",
  "重新读取宿主的连接表": "Re-read the host connection table",
  "宿主连接表里没有这台服务器的记录：它当前没有被任何会话建立连接，也没有最近的回收记录。": "No record of this server in the host connection table: no session currently holds a connection to it, and there is no recent teardown.",
  "（会话槽 {0}）": " (slot {0})",
  "会话槽": "Session slot",
  "{0} 个会话共用这条连接": "{0} sessions share this connection",
  "{0} 个引用": "{0} references",
  "空闲回收": "Idle reclaim",
  "已空闲超过 {0} 秒，正在等待回收": "Idle for over {0}s, waiting to be reclaimed",
  "空闲 {0} 秒后回收": "Reclaimed after {0}s idle",
  "上次回收": "Last teardown",
  "配置": "Config",
  "配置文件已改动，下次建连才生效": "Config file changed; takes effect on next connect",
  "同名项目": "Same-name projects",
  "拆掉这条连接并按当前配置重建，不影响其他会话": "Tear down this connection and rebuild it from the current config; other sessions are unaffected",
  "重连这台服务器": "Reconnect this server",
  "已就绪": "Ready",
  "建连中": "Connecting",
  "释放中": "Disposing",
  "释放": "Enable",
  "上次回收 {0} ms": "Last teardown {0} ms",
  "上次回收 {0} ms（超时）": "Last teardown {0} ms (timed out)",
  "回收中 {0} ms": "Tearing down {0} ms",
  "\n…（预览截断）": "\n…(preview truncated)",
  "\n…（预览截断，召唤时写入完整正文）": "\n…(preview truncated; the full text is written when you summon)",
  "安装 = 把该连接器的 mcpServers 合并写入当前作用域（与「导入 JSON」同一链路，同名跳过）。": "Install merges that connector's mcpServers into the current scope (same pipeline as Import JSON; names that already exist are skipped).",
  "第 {0} / {1} 页": "Page {0} / {1}",
  "跳到": "Go to",
  "页": "page",
  "跳转到指定页": "Jump to a specific page",
  "共 {0} 条": "{0} total",
  "宿主只提供 skill 的读取接口；这里可以卸载用户级/项目级目录里的 skill（永久删除，不可撤销）。随 DSH 分发、运行时注册、自定义目录的 skill 不可卸载——要改内容请直接编辑 SKILL.md。": "The host only exposes read endpoints for skills. Skills in user-level/project-level directories can be uninstalled here (permanent deletion, no undo). Skills shipped with DSH, registered at runtime, or living in custom directories cannot be uninstalled — edit SKILL.md directly to change them.",
  "将从磁盘永久删除 {0}（不可撤销），确认卸载？": "This permanently deletes {0} from disk (no undo). Uninstall?",
  "确认卸载": "Uninstall",
  "卸载中…": "Uninstalling…",
  "永久删除这个 skill 所在目录（不可撤销）": "Permanently delete this skill's directory (no undo)",
  "已卸载 {0}": "Uninstalled {0}",
  "这个 skill 来自「{0}」，不在可卸载范围内：随 DSH 分发、运行时注册与自定义目录的 skill 只能查看。要停用它，请编辑所属预设或 SKILL.md。": "This skill comes from \"{0}\" and cannot be uninstalled: skills shipped with DSH, registered at runtime, or living in custom directories are read-only. To disable it, edit its preset or SKILL.md instead.",

  // 自定义套件（Skill 看板的套件管理弹窗 + 召唤菜单技能子菜单里的套件分组）。
  // 「套件」本身、保存中…、取消、关闭、搜索 skill… 等复用既有键，不在此重复登记。
  "套件管理": "Suite manager",
  "把多个相关 skill 打包成套件；在输入框的引用菜单里点一次套件，等于同时引用全部成员。": "Bundle related skills into a suite; one click in the composer's reference menu inserts every member at once.",
  "管理自定义套件": "Manage custom suites",
  "管理自定义套件：把多个相关 skill 打包，引用一次全部生效": "Manage custom suites: bundle related skills so one reference applies them all",
  "管理套件…": "Manage suites…",
  "新建或修改套件（把多个相关 skill 打包，引用一次全部生效）": "Create or edit suites (bundle related skills so one reference applies them all)",
  "引用套件：展开为 {0} 个 /name": "Reference this suite: expands into {0} /name tokens",
  "{0} 技能": "{0} skills",
  "我的套件": "My suites",
  "新建套件": "New suite",
  "新建一个空套件": "Create an empty suite",
  "还没有套件：点右上「新建套件」开始": "No suites yet: click \"New suite\" at the top right to start",
  "未命名套件": "Untitled suite",
  "套件名称": "Suite name",
  "例如：演示视频流水线": "e.g. Demo video pipeline",
  "说明（可选，显示在引用菜单条目右侧）": "Description (optional, shown beside the entry in the reference menu)",
  "一句话说明这套技能干什么": "One line on what this bundle of skills does",
  "成员技能": "Member skills",
  "{0} 个 · 拖拽可排序": "{0} · drag to reorder",
  "把左侧卡片拖到这里": "Drag a card from the left in here",
  "拖不动时，悬停卡片点 + 也能加进来": "If dragging is awkward, hover a card and click + to add it",
  "选择右上列表里的一个套件，或点「新建套件」": "Select a suite from the list at the top right, or click \"New suite\"",
  "先在右侧选择一个套件，或点「新建套件」": "Select a suite on the right first, or click \"New suite\"",
  "套件 = 一组相关 skill 的引用打包": "A suite = one reference that bundles related skills",
  "拖左侧卡片到成员区即可添加；成员可上下拖拽排序，+ / × 是无拖拽的替代路径。": "Drag a card from the left into the member area to add it; drag members up or down to reorder. + / × are the no-drag alternatives.",
  "看板没有读到 skill 列表": "The board did not return a skill list",
  "宿主未挂载 skill 注册表（@deepseek-ai/dsh-skill）时这里就是空的；套件仍能保存，但成员名要自己保证正确。": "This is empty when the host mounts no skill registry (@deepseek-ai/dsh-skill). Suites can still be saved, but you have to get the member names right yourself.",
  "没有符合筛选的 skill": "No skill matches the filter",
  "已在当前套件中": "Already in the current suite",
  "已在套件中": "In suite",
  "拖到右侧成员区，或点 + 添加": "Drag to the member area on the right, or click + to add",
  "添加到当前套件": "Add to the current suite",
  "已加入「{0}」": "Added \"{0}\"",
  "「{0}」已在这个套件里": "\"{0}\" is already in this suite",
  "成员已达上限 {0} 个": "Member limit reached ({0})",
  "套件数量已达上限 {0} 个": "Suite limit reached ({0})",
  "宿主当前找不到这个 skill（可能已移动或删除），引用时会失效": "The host can no longer find this skill (it may have been moved or deleted); referencing it will fail",
  "已失效": "Missing",
  "移除 {0}": "Remove {0}",
  "删除套件": "Delete suite",
  "再点一次确认删除": "Click again to confirm deletion",
  "确认?": "Sure?",
  "删除": "Delete",
  "未保存": "Unsaved",
  "整集合覆盖保存：右侧列表就是全部套件": "Saving overwrites the whole set: the list on the right is all your suites",
  "保存套件": "Save suites",
  "套件已保存（{0} 个）": "Suites saved ({0})",
  "保存失败：宿主没有回包": "Save failed: no response from the host",
  "有套件还没起名": "A suite still has no name",
  "套件「{0}」还没有成员": "Suite \"{0}\" has no members yet",
  "已删除套件（保存后生效）": "Suite deleted (takes effect on save)",
  "已放弃未保存的修改": "Unsaved changes discarded",

  "这 {0} 个 MCP 都需要交互取值，无法直接导入": "These {0} MCP servers all require interactive input and cannot be imported directly",
  "（另有 {0} 个需要交互取值）": " ({0} more require interactive input)",
  "不支持：": "Unsupported: ",
  "可导入：": "Importable: ",
  "需要在这里填写的交互输入：": "Interactive inputs to fill in: ",
  "这些条目引用了编辑器交互输入（${input:…}），值在导入时拿不到": "These entries reference editor interactive inputs (${input:…}); the values are unavailable at import time",

  // T04/R8：安装状态账本（插件装完回写登记失败时的提示）。占位回退用的「未知错误」上表已有。
  "插件已安装，但安装状态登记失败：{0}": "Plugin installed, but recording its install state failed: {0}",
  "插件安装失败（宿主安装器返回失败）": "Plugin installation failed (host installer reported failure)",
  "在全量 {0} 条目录里筛出已安装的连接器（跨页生效，与技能侧「仅本页」不同）": "Filter the full {0}-entry catalog to installed connectors (across pages, unlike the skills tab)",
  "在全量 {0} 条插件里筛出已安装的（跨页生效）": "Filter the full {0} plugins to installed ones (across pages)",
  "已安装 {0} / {1}": "Installed {0} / {1}",

  // T04/R7：连接器令牌弹窗（占位符凭据引导）。「环境变量 」上表已有，这里只补新增的条目。
  "请求头 ": "Header ",
  // url 占位符（https://…?token=${X}）：凭据写在连接地址里，标签不能写成「环境变量 url」。
  "URL 参数": "URL parameter",
  "填写连接器凭据": "Enter connector credentials",
  "填写 {0} 的凭据": "Enter credentials for {0}",
  "该连接器的配置里有 {0} 个占位符，需要你提供对应凭据才能生效。没填的会保持原样，安装后仍可在 MCP 配置里手动补全。": "This connector's config contains {0} placeholder(s) that need your credentials to take effect. Anything left blank keeps its original value and can be filled in later from the MCP config.",
  "留空表示稍后自行补全": "Leave blank to fill in later",
  "该连接器没有可填写的占位符，可直接安装。": "This connector has no placeholders to fill in; it can be installed directly.",
  "带凭据安装": "Install with credentials",
  "另有 {0} 个占位符未填写，配置里保留原样，可用前请补全。": "{0} placeholder(s) were left blank and kept as-is in the config; fill them in before use.",

  // R8：连接器 OAuth 授权（401 → 浏览器授权页，成功后自动完成安装）。
  "授权 {0}": "Authorize {0}",
  "该连接器要求在浏览器里完成一次登录授权。授权页会尝试自动打开；授权完成后这里会自动继续，无需手动刷新。": "This connector needs a one-time sign-in in your browser. The authorization page is opened automatically, and this dialog continues on its own once you finish — no need to refresh.",
  "正在启动授权…": "Starting authorization…",
  "无法启动授权流程": "Unable to start the authorization flow",
  "没能自动唤起浏览器，请复制下方链接手动打开。": "The browser could not be opened automatically — copy the link below and open it manually.",
  // 服务器不做 OAuth 发现（如腾讯 ima）时授权页根本开不出来，这里把手填令牌那条
  // 兜底路的弹层文案补齐——只报一句「启动失败」等于把用户堵死在门外。
  "该服务器无法自动打开授权页。": "This server can't have an authorization page opened automatically.",
  "该服务器没有提供标准 OAuth 授权发现，无法自动打开授权页。如果你已经从服务方拿到访问令牌，粘贴在下面即可安装。": "This server publishes no standard OAuth authorization-server metadata, so an authorization page can't be opened automatically. If you already have an access token from the provider, paste it below to install.",
  "授权链接": "Authorization link",
  "重新打开浏览器": "Reopen browser",
  "该服务器只接受自定义协议回调，浏览器跳转后页面会打不开。请把地址栏里的完整地址复制到下面。": "This server only accepts a custom-scheme callback, so the redirect page will not load. Copy the full address from the browser's address bar into the field below.",
  "粘贴完整回调地址": "Paste the complete callback address",
  "提交回调": "Submit callback",
  "正在校验回调…": "Verifying callback…",
  "回调地址无效，请重新授权。": "That callback address is not valid. Please authorize again.",
  "授权失败": "Authorization failed",
  "该连接器需要通过浏览器完成一次授权；如果你已经从服务方拿到访问令牌，也可以在这里直接填写。": "This connector needs a one-time browser authorization; if you already have an access token from the provider, you can enter it here instead.",
  "也可以直接粘贴访问令牌": "You can also paste an access token directly",
  "粘贴访问令牌": "Paste an access token",
  "用令牌安装": "Install with token",
  "正在保存令牌…": "Saving token…",
  "{0}：授权成功，正在完成安装…": "{0}: authorized, finishing installation…",

  // Skill 看板分类升级（skillcat/skillview/skillpick）：分类名与新增操作文案的英译。
  "编程开发": "Programming & Dev",
  "设计与创作": "Design & Creation",
  "文档办公": "Documents & Office",
  "效率与自动化": "Productivity & Automation",
  "开发运维": "DevOps",
  "未分类": "Uncategorized",
  "网格视图": "Grid view",
  "列表视图": "List view",
  "视图切换": "Switch view",
  "按分类过滤 skill": "Filter skills by category",
  "显示 {0} / {1} 个 skill": "Showing {0} of {1} skills",
  "所属分类": "Category",
  "来源目录": "Source directory",
  "文件位置": "File location",
  "复制 SKILL.md 路径": "Copy SKILL.md path",
  "复制 @会话引用": "Copy @session reference",

  // DSH 社区插件 README 预览弹层（点卡片打开）。
  "查看 README 介绍与插图": "View README intro & images",
  "{0} README 预览": "{0} · README preview",
  "正在读取 README…": "Loading README…",
  "README 过长，已截断显示。": "README is long; showing a truncated version.",
  "跳到末尾": "Jump to end",
  "滑动到 README 末尾": "Scroll to the end of README",
  "重新读取": "Reload",
  "读取 README 失败：未知错误": "Failed to read README: unknown error",
  "预览服务尚未加载，请完全退出 DSH 后重新打开再试": "The preview service is not loaded yet. Fully quit DSH, reopen it, then try again.",

  "目录维护方：{0}": "Catalog maintained by: {0}",
  "目录更新于 {0}": "Catalog updated {0}",
  "查看来源": "View source",
  "更新于 {0}": "Updated {0}",
  "专家人设": "Expert persona",
  "加入时间 {0}": "Added {0}",
  "人设更新于 {0}": "Persona updated {0}",
  "已归档": "Archived",
  "近 30 天有提交": "Committed in the last 30 days",
  "最近更新 {0}": "Last updated {0}",
  "超过半年未更新": "No updates for over 6 months",
  "打开维护者主页": "Open maintainer profile",
  "来源未标注": "Source not listed",
  "读取维护动态…": "Loading maintenance activity…",
  "最近提交 {0}": "Last commit {0}",
  "{0} 个开放 issue": "{0} open issues",
  "维护动态读取失败：{0}": "Couldn't load maintenance activity: {0}",
  "维护动态读取中…": "Loading maintenance activity…",
  "这个条目没有公开仓库": "This entry has no public repository",
  "条目": "Item",
  "未命名条目": "Unnamed item",
  "条目：{0}": "Item: {0}",
  "类型：{0}": "Type: {0}",
  "来源：{0}": "Source: {0}",
  "版本：{0}": "Version: {0}",
  "发生了什么": "What happened",
  "环境": "Environment",
  "系统：{0}": "System: {0}",
  "{0} · {1} 的反馈": "{0} · feedback on {1}",
  "找到真实的人": "Reach the real people",
  "去仓库": "Repository",
  "看讨论 / 提 Issue": "Discussions / Issues",
  "来源主页": "Source page",
  "向军械库反馈": "Report to Armory",
  "已复制模板": "Template copied",
  "复制反馈模板": "Copy feedback template",
  "反馈会打开 GitHub 新标签页；内容先由你过目，确认后才提交。": "Feedback opens a new GitHub tab; you review the text before submitting it.",
  "专家中心": "Expert Center",
  "连接器市场": "Connector market",
  "最近动静": "Recent activity",
  "暂无新变化 · 上次对比 {0} · 只在本机对比快照": "No new changes · last compared {0} · local snapshot comparison only",
  "已开始记录市场动态；下次打开时这里会列出真实变化": "Started tracking market activity; real changes will appear here next time",
  "自上次打开市场以来，目录里真实发生的变化（本机快照对比）": "Real catalog changes since you last opened the market (local snapshot comparison)",
  "清除": "Clear",
  "{0} 新增 {1} 条": "{0}: {1} added",
  "{0} 移除 {1} 条": "{0}: {1} removed",
  "{0} 更新 {1} 条": "{0}: {1} updated",
  " 等": " and more",
  "跳到对应市场": "Jump to the matching market",
  "核验 {0}": "Verified {0}",
  "已验证 · dsh {0}": "Verified · dsh {0}",
  // 底栏两枚 tooltip：口径是要命的信息，不能省。「↓」是近 30 天（技能卡那枚是累计），
  // 「核验」是目录批次核验时间（不是插件自己的更新时间），英文必须把这两点讲全。
  "npm 近 30 天下载量": "npm downloads in the last 30 days",
  "核验日期来自目录批次核验，不是插件自身的更新时间": "The verification date is when the catalog batch was checked, not when this plugin was updated",
  "查看 {0} 的 README": "View the README for {0}",
  "来源：WorkBuddy 官方分发": "Source: official WorkBuddy distribution",
  "说明：{0}": "About: {0}",
  "本机依赖": "Local dependency",
  "已找到：{0}": "Found: {0}",
  "未找到：{0}": "Not found: {0}",
  "当前系统不支持：{0}": "Not supported on this platform: {0}",
  "本地客户端缺失时安装会失败；请先安装对应客户端，并开启它的 MCP / 集成访问后再重试。": "Installation will fail while the local client is missing. Install the client first and enable its MCP / integration access, then retry.",
  "本机没有找到该连接器依赖的程序：{0}。请先安装对应客户端并开启它的 MCP / 集成访问后重试。": "The program this connector depends on is not installed: {0}. Install the client and enable its MCP / integration access, then retry.",
  "该连接器依赖本机程序，但当前系统不支持：{0}": "This connector depends on a local program that this platform doesn't support: {0}",
  "本机依赖已找到；若连接失败，请确认对应客户端正在运行并已开启 MCP / 集成访问。": "Local dependency found. If the connection still fails, make sure the client is running and its MCP / integration access is enabled.",

  "装备清单": "Loadout",
  "导出": "Export",
  "导入对比": "Compare import",
  "把本机的 MCP、技能、专家与插件导出成一份可分享的清单；导入只做对比，不会自动安装。": "Export your local MCP servers, skills, experts, and plugins as a shareable list. Import only compares — nothing is installed automatically.",
  "清单名称": "Loadout name",
  "我的 DSH 装备清单": "My DSH loadout",
  "读取本机配置…": "Reading local setup…",
  "重新生成": "Regenerate",
  "超过 200 条，只导出前 200 条。": "More than 200 items; only the first 200 are exported.",
  "复制 JSON": "Copy JSON",
  "已复制 JSON": "JSON copied",
  "下载 .json": "Download .json",
  "已开始下载": "Download started",
  "浏览器不允许下载，请改用复制 JSON": "The browser blocked the download; use Copy JSON instead",
  "还没有生成清单。": "No loadout generated yet.",
  "这份清单只含名称、类型、来源与版本；不会写入密钥、header 或环境变量的值。": "This loadout only includes names, types, sources, and versions; it never contains keys, headers, or environment variable values.",
  "把朋友发来的清单贴在这里，或选择文件。导入只做对比，不会自动安装。": "Paste a loadout a friend sent you, or choose a file. Import only compares — nothing is installed automatically.",
  "粘贴清单 JSON…": "Paste loadout JSON…",
  "选择 .json 文件": "Choose a .json file",
  "文件过大（上限 256KB）": "File too large (256KB max)",
  "文件读取失败：{0}": "Couldn't read the file: {0}",
  "先粘贴一份清单，或选择 .json 文件。": "Paste a loadout or choose a .json file first.",
  "不是有效的 JSON：{0}": "Not valid JSON: {0}",
  "对比失败": "Comparison failed",
  "对比中…": "Comparing…",
  "对比本机": "Compare with this device",
  "清单为空。": "The loadout is empty.",
  "共 {0} 项 · 已安装 {1} · 可更新 {2} · 本机没有 {3}": "{0} items · {1} installed · {2} updates · {3} missing",
  "清单来自 {0}": "Loadout from {0}",
  "本机：{0}": "Local: {0}",
  "可更新": "Update available",
  "本机没有": "Not installed",
  "去市场": "Find in market",
  "复制名称": "Copy name",
  "已复制名称": "Name copied",
  "导入只做对比；点「去市场」逐项安装，不会自动写入任何配置。": "Import only compares; use Find in market to install each item. Nothing is written automatically.",
  "内置 · {0}": "Built-in · {0}",
  "连接器 · {0}": "Connector · {0}",
  "手动配置": "Manual config",
  "WorkBuddy 专家中心": "WorkBuddy Expert Center",
  "本机 / 自带": "Local / bundled",
  "导出失败": "Export failed",
  "生成失败：{0}": "Couldn't generate: {0}",
  "已定位到连接器市场：{0}": "Opened the connector market: {0}",
  "这是手动配置的 MCP，名称已复制；可到 MCP 页自行添加。": "This MCP was configured manually; its name is copied. Add it on the MCP page.",
  "已定位到技能市场：{0}": "Opened the skill market: {0}",
  "已定位到专家市场：{0}": "Opened the expert market: {0}",
  "已定位到插件市场：{0}": "Opened the plugin market: {0}",
  "导出本机配置，或导入朋友的清单做差异对比": "Export your local setup, or import a friend's loadout to see the differences",

  // ── P0：连接器真实连接态 / 授权状态（2026-10-29）────────────────────────
  "服务器已连接并注册了工具": "Server is connected and has registered tools",
  "已安装 · 已连接": "Installed · connected",
  "服务器返回 401/403 类鉴权失败，重连不会恢复，需要重新授权": "The server rejected the credentials (401/403). Reconnecting won't help; re-authorize instead",
  "已安装 · 需授权": "Installed · needs authorization",
  "配置已写入，但服务器当前没有连上（点「重连」再试）": "Config was written, but the server isn't connected right now (try Reconnect)",
  "已安装 · 未连接": "Installed · not connected",
  "重新授权": "Re-authorize",
  "读取授权状态失败": "Couldn't read authorization status",
  "正在重连…": "Reconnecting…",
  "已请求重连": "Reconnect requested",
  "重连失败": "Reconnect failed",
  // 顶部进度浮层（安装 / 加入 MCP / 重连共用一枚浮层，分组只换措辞）。
  "正在处理 {0} 个 MCP 任务…": "Handling {0} MCP task(s)…",
  "MCP 任务已结束": "MCP tasks finished",
  "写入配置中…": "Writing config…",
  "已加入 · 宿主自动连接中": "Added · the host is connecting",
  "加入失败": "Add failed",
  "正在刷新授权…": "Refreshing authorization…",
  "{0}：授权已刷新，正在把新凭据写回配置…": "{0}: authorization refreshed, writing the new credential back to the config…",
  "刷新授权失败": "Couldn't refresh authorization",
  "服务器拒绝当前凭据：重新走一次授权": "The server rejected the credential; run authorization again",
  "拆掉这条连接并按当前配置重建": "Tear down this connection and rebuild it from the current config",
  "授权状态": "Authorization status",
  "正在读取授权状态…": "Reading authorization status…",
  "授权已过期（{0}），点「刷新授权」重新获取；刷不动会自动回到浏览器授权。": "Authorization expired ({0}). Use Refresh authorization; if that fails you'll be taken back to browser authorization.",
  "无有效期记录": "no expiry recorded",
  "已授权{0}": "Authorized{0}",
  "，有效期至 {0}": ", valid until {0}",
  "尚未授权：安装时会引导你完成浏览器授权。": "Not authorized yet: installing will walk you through browser authorization.",
  "没有可用的授权记录。": "No usable authorization record.",
  "服务器提供了 refresh_token：过期后可以在这里直接刷新，无需重走浏览器。": "The server issued a refresh_token: once it expires you can refresh here without repeating browser authorization.",
  "刷新授权": "Refresh authorization",
  "去授权": "Authorize",
  "凭据来源": "Where the credential comes from",
  "我已有令牌": "I already have a token",
  "服务器拒绝当前凭据（401/403 类）：重连不会恢复，需要重新授权": "The server rejected the credential (401/403): reconnecting won't help, re-authorize instead",
  "需授权": "Needs authorization",
  "这台服务器拒绝当前凭据（401/403 类），重连不会恢复：请到「市场 → 连接器」打开对应连接器点「重新授权」。由 WorkBuddy 账号代注入凭据的连接器（如 ima）DSH 无法代办。": "This server rejected the credential (401/403); reconnecting won't help. Open the matching connector under Market → Connectors and use Re-authorize. Connectors whose credential is injected by your WorkBuddy account (ima, for example) can't be set up by DSH.",

  "：": ": ",

  // ── 社区 MCP（连接器页第二个来源：官方 MCP Registry）──────────────────────
  // 新增文案统一放这一节，方便与常量 / 面板代码就近对照；键仍进双向差集护栏。
  "连接器来源": "Connector source",
  "WorkBuddy 连接器": "WorkBuddy connectors",
  "WorkBuddy 官方分发的连接器；多数需要 WorkBuddy 账号授权": "Connectors distributed by WorkBuddy; most need WorkBuddy account authorization",
  "社区 MCP": "Community MCP",
  "官方 MCP Registry 的社区条目，不依赖 WorkBuddy 账号": "Community entries from the official MCP Registry; no WorkBuddy account needed",
  "社区 MCP 来自官方 MCP Registry，由社区提交；军械库未审核其代码，加入前请自行确认命令与环境变量。": "Community MCPs come from the official MCP Registry and are submitted by the community. The armory has not reviewed their code; please verify the command and environment variables before adding one.",
  "搜索社区 MCP（名称 / 说明）": "Search community MCPs (name / description)",
  "只看可直接运行（npx / uvx）": "Only directly runnable (npx / uvx)",
  "只显示带 npx / uvx 启动包的条目；远程 HTTP 条目需要自备令牌": "Only show entries with an npx / uvx launch package; remote HTTP entries need your own token",
  "已读取 {0} 条": "Read {0} entries",
  " · 缓存结果": " · cached result",
  "这些条目只有远程地址，需要自备令牌": "These entries only have a remote URL and need your own token",
  "已隐藏 {0} 个远程条目": "Hidden {0} remote entries",
  "正在读取社区 MCP…": "Loading community MCPs…",
  "读取社区 MCP 失败": "Failed to read community MCPs",
  "社区列表加载失败：{0}": "Failed to load the community list: {0}",
  "没有匹配的社区条目": "No matching community entries",
  "有 {0} 条只有远程地址的条目被「只看可直接运行」挡住了。": "{0} entries with only a remote URL are hidden by \"Only directly runnable\".",
  "换一个更短的关键词，或取消「只看可直接运行」。": "Try a shorter keyword, or turn off \"Only directly runnable\".",
  "正在加载…": "Loading…",
  "已经到底了": "No more results",
  "第 {0} 页": "Page {0}",
  // 社区目录全库总数（徽标常驻）：官方 Registry 不返回总数，只能逐页统计，所以分「共 N 条」
  // 与「至少 N 条」两种口径，别让下界被读成上限。
  "正在后台统计社区目录条目数，稍后自动显示…": "Counting the community catalog in the background — it shows up shortly…",
  "社区目录共 {0} 条（逐页统计；官方 Registry 不返回总数）": "The community catalog holds {0} entries (counted page by page; the official Registry returns no total)",
  "社区目录至少 {0} 条，仍在后台续爬统计（官方 Registry 不返回总数）": "The community catalog holds at least {0} entries - still counting in the background (the official Registry returns no total)",
  "本次查询已逐页读取的条数；上方徽标显示的是社区目录全库总数": "Entries read page by page for this query; the badge above shows the whole community catalog",
  "WorkBuddy 官方目录里的连接器总数": "Total connectors in the official WorkBuddy catalog",
  "正在读取连接器列表…": "Loading the connector list…",
  "加入 MCP": "Add MCP",
  "已加入": "Added",
  "已加入 ": "Added ",
  "预填一条 MCP 配置，确认后写入全局配置": "Prefill an MCP config and write it to the global config after you confirm",
  "当前 MCP 列表里已有同名服务器": "A server with the same name already exists in your MCP list",
  "远程（需自备令牌）": "Remote (bring your own token)",
  "需 {0} 个环境变量": "Needs {0} env vars",
  "含密钥字段": "Has secret fields",
  "有 {0} 个必填环境变量为空，服务器可能启动失败：{1}": "{0} required env vars are empty; the server may fail to start: {1}",
  "查看 {0} 的详情": "View details for {0}",
  "社区 MCP 详情": "Community MCP details",
  "启动命令": "Launch command",
  "远程地址": "Remote URL",
  "密钥": "Secret",
  "仓库": "Repository",
};
// 模块加载时先用 ①/③ 判定的 locale 装载一次；apply() 拿到宿主 locale 后会再按
// ② 重算（见 applyI18nLocale）。zh-CN（源语言）保持空字典恒等直出，其他语言
// 缺键也原样回落，不出现 key 名。
applyI18nLocale(I18N_LOCALE);
const t = (s, vars) => {
  let text = i18nMessages[s] || s;
  if (vars && vars.length) {
    text = text.replace(/\{(\d+)\}/g, (raw, index) => (index in vars ? vars[+index] : raw));
  }
  return text;
};
// OPT-25：宿主切换语言后通知已挂载的界面重渲染。模块级文案表已改为 getter /
// 函数（见 ENTRY_LABELS / SKILL_CATS 等），重渲染时就会读到新字典，不需要重载页面。
// 订阅者失败隔离：一个组件抛错不影响其它组件更新。
const i18nChangeListeners = new Set();
const emitI18nChange = () => {
  for (const listener of [...i18nChangeListeners]) {
    try { listener(); } catch { /* 单个订阅者失败不影响其它订阅者 */ }
  }
};
const onI18nChange = (listener) => {
  i18nChangeListeners.add(listener);
  return () => { i18nChangeListeners.delete(listener); };
};
// 顶层槽位组件调用一次即可：locale 变化时强制自身重渲染。
const useI18nRevision = () => {
  const [, setRevision] = useState(0);
  useEffect(() => onI18nChange(() => setRevision((value) => value + 1)), []);
};

// ── P1：数据型英文覆盖（更新日志）───────────────────────────────────────────
// 这类文案不是 UI 字面量，而是宿主随 RPC 送来的数据：更新日志在 whats-new.js。
// 它不能走 t() 字典（键集合由那个文件决定，硬抄进字典会让 i18n-coverage 的「死键」
// 断言永久变红），所以由宿主同时送中文与英文字段，客户端按当前 locale 选择。
// 英文缺失时逐条回落中文，绝不渲染 undefined。
//
// helper 的 `english` 参数只用于测试时显式指定；运行时用当前 locale 判定。
const localizeWhatsNewEntries = (entries, english = usesEnglish()) => {
  if (!english || !Array.isArray(entries)) return entries;
  return entries.map((entry) => ({
    ...entry,
    items: Array.isArray(entry.items)
      ? entry.items.map((item) => ({
          ...item,
          text: item.textEn || item.text,
          ...(item.whereEn ? { where: item.whereEn } : {}),
        }))
      : [],
  }));
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

// ── 秒开快照：DSH 社区目录的浏览器侧镜像 ───────────────────────────────────
// 服务端已改成 stale-while-revalidate（命中缓存即返回），但「第一次进插件页」仍要
// 走一次 IPC + 反序列化 1.5-2MB 目录，首屏还是一段空白。这里把上一次成功渲染过的
// 目录在浏览器侧留一份镜像：下次进插件页先用它铺满首屏（0 网络、0 IPC），随后被
// 真实结果静默替换。快照只是加速手段——读写失败一律静默退回原来的空白→加载路径。
const AWESOME_SNAPSHOT_KEY = KEY_PREFIX + '.awesomeCatalog.v1';
const AWESOME_SNAPSHOT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const AWESOME_SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
function readAwesomeSnapshot() {
  try {
    const raw = localStorage.getItem(AWESOME_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.plugins) || !parsed.plugins.length) return null;
    const savedAt = Number(parsed.savedAt || 0);
    if (!savedAt || Date.now() - savedAt > AWESOME_SNAPSHOT_MAX_AGE) return null;
    return parsed;
  } catch { return null; }
}
function writeAwesomeSnapshot(payload) {
  try {
    if (!payload || !Array.isArray(payload.plugins) || !payload.plugins.length) return;
    const text = JSON.stringify({
      savedAt: Date.now(),
      marketplace: payload.marketplace || 'awesome-dsh-plugins',
      fetchedAt: payload.fetchedAt || 0,
      plugins: payload.plugins,
    });
    // 超出配额安全线就不写：留着旧快照比写坏一次更划算。
    if (text.length > AWESOME_SNAPSHOT_MAX_BYTES) return;
    // 与连接器快照共用 4.5MB 预算（对称）：两边都看对方的现存字节数，谁后写都不会
    // 把合计顶过线，否则先写的那份会被下一次写入挤爆 localStorage。
    let otherBytes = 0;
    try { otherBytes = (localStorage.getItem(CONNECTOR_SNAPSHOT_KEY) || '').length; } catch { otherBytes = 0; }
    if (otherBytes + text.length > SNAPSHOT_BUDGET_BYTES) return;
    localStorage.setItem(AWESOME_SNAPSHOT_KEY, text);
  } catch { /* 配额溢出 / 隐私模式：快照只是加速，失败不致命 */ }
}
// ── P1-4：连接器目录快照（浏览器侧镜像）─────────────────────────────────
// 连接器目录要读 48MB 的 ZIP 再解出 769KB 索引，宿主侧约 350ms，再加 IPC 与 JSON
// 反序列化；而用户重开市场的第一眼永远是这一屏。这里把上次成功渲染的目录留一份
// （≤1.5MB / 24h），重开时先铺快照、再静默刷新。
// 与插件快照共用 4.5MB 预算：两份合起来超线就不写这一份——宁可少一层加速，也不要把
// localStorage 写满（写满会让本插件和同源其它插件一起失效）。
const CONNECTOR_SNAPSHOT_KEY = KEY_PREFIX + '.connectorCatalog.v1';
const CONNECTOR_SNAPSHOT_MAX_AGE = 24 * 60 * 60 * 1000;
const CONNECTOR_SNAPSHOT_MAX_BYTES = 1.5 * 1024 * 1024;
const SNAPSHOT_BUDGET_BYTES = 4.5 * 1024 * 1024;
// 本次会话内的内存镜像：面板关掉再打开不必重新 parse localStorage（也躲开 24h 过期判定）。
let connectorCatalogMemo = null;
function readConnectorSnapshot() {
  if (!MARKET_PERF.connectorSnapshot) return null;
  try {
    const raw = localStorage.getItem(CONNECTOR_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.connectors) || !parsed.connectors.length) return null;
    const savedAt = Number(parsed.savedAt || 0);
    if (!savedAt || Date.now() - savedAt > CONNECTOR_SNAPSHOT_MAX_AGE) return null;
    return parsed;
  } catch { return null; }
}
function writeConnectorSnapshot(payload) {
  if (!MARKET_PERF.connectorSnapshot) return;
  try {
    if (!payload || !Array.isArray(payload.connectors) || !payload.connectors.length) return;
    const text = JSON.stringify({
      savedAt: Date.now(),
      source: payload.source || '',
      connectors: payload.connectors,
    });
    if (text.length > CONNECTOR_SNAPSHOT_MAX_BYTES) return;
    let otherBytes = 0;
    try { otherBytes = (localStorage.getItem(AWESOME_SNAPSHOT_KEY) || '').length; } catch { otherBytes = 0; }
    if (otherBytes + text.length > SNAPSHOT_BUDGET_BYTES) return;
    localStorage.setItem(CONNECTOR_SNAPSHOT_KEY, text);
  } catch { /* 配额溢出 / 隐私模式：快照只是加速，失败不致命 */ }
}
// ── 更新探测节流：把「每次进面板都 HEAD 一发」压到 6 小时一次 ────────────────
// 目录本身已有服务端 stale-while-revalidate 在后台自动换新，这个 ETag 探测只是
// 锦上添花；没必要每开一次面板就多打一次网络、多一次误报机会。
const AWESOME_PROBE_AT_KEY = KEY_PREFIX + '.awesomeProbeAt.v1';
const AWESOME_PROBE_INTERVAL_MS = 6 * 60 * 60 * 1000;
function readAwesomeProbeAt() {
  try { return Number(localStorage.getItem(AWESOME_PROBE_AT_KEY)) || 0; } catch { return 0; }
}
function writeAwesomeProbeAt(value) {
  try { localStorage.setItem(AWESOME_PROBE_AT_KEY, String(value)); } catch { /* 隐私模式：退化为不节流 */ }
}

// ── 社区目录「全库总数」：连接器页那枚常驻徽标上的数 ─────────────────────────
// 为什么不是直接问上游要：官方 Registry 不给总数——实测 `metadata.count` 就是本页条数
// （limit=1 时 1、limit=100 时 100），`/v0/servers/count` 与 `/v0/registry/stats` 都是
// 404，`limit>100` 直接 422。要数出来只能顺游标一页页爬，而全库实测 ≥13,000 条
// （130 页仍未到底）、单页 2.4–8s，一次爬完要十几分钟和约 9MB，绝不能挡在用户面前。
// 所以做成「有界 + 可续爬」：每次打开面板最多数 COMMUNITY_COUNT_PAGE_BUDGET 页，进度落
// 在这里，下次接着数；数到底显示精确值，没到底显示下界「N+」。
// 为什么值得为它写持久化：徽标原先显示的是「已读取 98 条」，用户会读成"社区一共只有 98 个"
// （2026-10-30 用户反馈）。一个会慢慢长对的「1200+」比一个看起来像总数的「98」诚实得多。
const COMMUNITY_COUNT_KEY = KEY_PREFIX + '.communityCount.v1';
/** 数据层单块页数（lib/mcp-community.js 的 COMMUNITY_COUNT_CHUNK_PAGES 同值，靠测试钉住）。 */
const COMMUNITY_COUNT_CHUNK_PAGES = 3;
/** 一次面板会话的页数预算：4 块 × 3 页 = 12 页 = 1200 条，约 0.9MB。 */
const COMMUNITY_COUNT_PAGE_BUDGET = 12;
/** 空记录：还没数过。徽标显示「…」而不是消失——数字常驻才不会被当成"这一页就是全部"。 */
const emptyCommunityCount = () => ({ counted: 0, cursor: '', done: false, at: 0 });

function readCommunityCount() {
  try {
    const raw = localStorage.getItem(COMMUNITY_COUNT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const counted = Number(parsed?.counted);
    if (!Number.isFinite(counted) || counted < 0) return null;
    return {
      counted: Math.floor(counted),
      cursor: typeof parsed.cursor === 'string' ? parsed.cursor : '',
      done: parsed.done === true,
      at: Number(parsed.at) || 0,
    };
  } catch { return null; }
}

function writeCommunityCount(record) {
  // 只存四个标量（约 120 字节），不进快照那套 4.5MB 预算。
  try { localStorage.setItem(COMMUNITY_COUNT_KEY, JSON.stringify(record)); } catch { /* 隐私模式：下次进面板重数 */ }
}

/** 徽标文本：没数过 / 数为 0 且没到底 → 「…」；数到底 → 精确值；否则 → 下界「N+」。 */
function communityCountBadgeText(record) {
  if (!record) return '…';
  if (record.done) return String(record.counted);
  return record.counted > 0 ? `${record.counted}+` : '…';
}

/** 徽标 tooltip：把「这个数是什么口径」写清楚，别让 1200+ 被读成"只能看到 1200 个"。 */
function communityCountBadgeTitle(record) {
  if (!record || !record.counted) return t('正在后台统计社区目录条目数，稍后自动显示…');
  if (record.done) return t('社区目录共 {0} 条（逐页统计；官方 Registry 不返回总数）', [String(record.counted)]);
  return t('社区目录至少 {0} 条，仍在后台续爬统计（官方 Registry 不返回总数）', [String(record.counted)]);
}

// ── 安装轻提示：挂在 document.body 上的常驻浮层 ─────────────────────────────
// 安装进度此前只存在组件本地 state（busy / busyLabel）：用户一切到别的面板或窗口，
// 组件卸载 → 进度消失 → 看起来像「安装被取消了」。这个浮层直接挂 document.body，
// 不随面板卸载，切走再切回、甚至切到别的标签页都还看得见。
// 约束：纯 DOM 实现（本文件没有 react-dom，拿不到 createPortal）；只用 textContent
// 写插件名，不拼 innerHTML。
const INSTALL_TOAST_ID = KEY_PREFIX + '-install-toast';
const INSTALL_TOAST_CSS_ID = KEY_PREFIX + '-install-toast-css';
// key → { name, phase: 'running' | 'ok' | 'fail', at, group, labels }
//   plugin 组的 key 就是插件名：isInstallRunning(名字) 靠它禁用「安装」按钮，这个约定不能改；
//   MCP 组的 key 带 'mcp:<动作>:<名称>' 前缀，既不会被同名插件顶掉一行，也不参与按钮禁用。
const installTasks = new Map();
const installTimers = new Map();
let installToastNode = null;
/** 浮层分组：决定标题措辞。 */
const PROGRESS_GROUP_PLUGIN = 'plugin';
const PROGRESS_GROUP_MCP = 'mcp';
// 状态文案一律写成「渲染时才调 t()」的函数：语言在模块加载之后还可能切换，
// 提前求值会把首次加载那一刻的 locale 钉进常量里（顺带也满足全文件中文包裹不变式）。
const PLUGIN_TASK_LABELS = {
  running: () => t('安装中…'),
  ok: () => t('已安装'),
  fail: () => t('安装失败'),
};
const MCP_ADD_TASK_LABELS = {
  running: () => t('写入配置中…'),
  ok: () => t('已加入 · 宿主自动连接中'),
  fail: () => t('加入失败'),
};
const MCP_RECONNECT_TASK_LABELS = {
  running: () => t('正在重连…'),
  ok: () => t('已请求重连'),
  fail: () => t('重连失败'),
};
const PROGRESS_TITLES = {
  [PROGRESS_GROUP_PLUGIN]: {
    running: (count) => t('正在安装 {0} 个插件…', [count]),
    done: () => t('安装任务已结束'),
  },
  [PROGRESS_GROUP_MCP]: {
    running: (count) => t('正在处理 {0} 个 MCP 任务…', [count]),
    done: () => t('MCP 任务已结束'),
  },
};
function installToastCss() {
  if (typeof document === 'undefined' || document.getElementById(INSTALL_TOAST_CSS_ID)) return;
  const style = document.createElement('style');
  style.id = INSTALL_TOAST_CSS_ID;
  style.textContent = [
    '.dsh-mcp-install-toast{position:fixed;top:64px;left:50%;transform:translate(-50%,-14px);z-index:2147483000;',
    'display:none;flex-direction:column;gap:6px;min-width:220px;max-width:min(420px,calc(100vw - 32px));',
    'padding:10px 14px 11px;border-radius:12px;pointer-events:none;text-align:start;',
    // 与底部 .dsh-mcp-toast 同一对自持色（--mcp-tip-*）：宿主 token 里
    // --dsw-alias-bg-elevated / --dsw-alias-text-primary 本皮根本没定义，全靠这里的 fallback
    // 撑着；一旦宿主基础样式给其中一个赋值，就会重演「深蓝字压深蓝底」。fallback 值与
    // --mcp-tip-bg/--mcp-tip-fg 同色，两处浮层从此共用一套对比度已实测的色面。
    'background:var(--mcp-tip-bg,rgba(23,38,63,.93));color:var(--mcp-tip-fg,#f4f7fd);',
    'border:1px solid var(--mcp-tip-line,rgba(255,255,255,.18));',
    'box-shadow:var(--mcp-tip-shadow,0 10px 30px rgba(0,0,0,.30));backdrop-filter:blur(14px) saturate(160%);',
    'font-size:12px;line-height:1.45;opacity:0;transition:opacity .18s ease,transform .18s ease}',
    '.dsh-mcp-install-toast.on{display:flex;opacity:1;transform:translate(-50%,0)}',
    '.dsh-mcp-install-toast-title{font-weight:600;font-size:12px;letter-spacing:.01em}',
    '.dsh-mcp-install-toast-row{display:flex;align-items:center;gap:8px;min-width:0}',
    // 状态圆点同样走自持色：宿主 --dsw-alias-accent-primary / -status-success / -status-danger
    // 三个键在本皮都不存在（皮肤用的是 state-*-primary 命名），旧写法一直吃 fallback。
    // 7px 的点属非文本信息，但它是「进行中/成功/失败」的唯一视觉差异，必须在深色面上站得住
    // （#7fb2ff / --mcp-tip-ok / --mcp-tip-err 对 #17263f 实测 6.7:1 以上）。
    '.dsh-mcp-install-toast-dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:#7fb2ff;animation:dsh-mcp-install-pulse 1.1s ease-in-out infinite}',
    '.dsh-mcp-install-toast-row[data-phase="ok"] .dsh-mcp-install-toast-dot{animation:none;background:var(--mcp-tip-ok,#7ee0a1)}',
    '.dsh-mcp-install-toast-row[data-phase="fail"] .dsh-mcp-install-toast-dot{animation:none;background:var(--mcp-tip-err,#ff8a8a)}',
    '.dsh-mcp-install-toast-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.dsh-mcp-install-toast-status{flex:0 0 auto;opacity:.72;font-variant-numeric:tabular-nums}',
    '@keyframes dsh-mcp-install-pulse{0%,100%{opacity:.35;transform:scale(.85)}50%{opacity:1;transform:scale(1)}}',
    '@media (prefers-reduced-motion:reduce){.dsh-mcp-install-toast,.dsh-mcp-install-toast-dot{transition:none;animation:none}}',
  ].join('');
  document.head.appendChild(style);
}
function ensureInstallToast() {
  if (typeof document === 'undefined' || !document.body) return null;
  if (installToastNode && installToastNode.isConnected) return installToastNode;
  installToastCss();
  const node = document.getElementById(INSTALL_TOAST_ID) || document.createElement('div');
  if (!node.id) {
    node.id = INSTALL_TOAST_ID;
    node.className = 'dsh-mcp-install-toast';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
  }
  if (!node.isConnected) document.body.appendChild(node);
  installToastNode = node;
  return node;
}
/** 行内状态文案：取该任务所属组的 labels，按当前 phase 调对应的 t() 函数。 */
function taskStatusLabel(task) {
  const label = (task.labels || PLUGIN_TASK_LABELS)[task.phase];
  return typeof label === 'function' ? label() : '';
}
function renderInstallToast() {
  const node = ensureInstallToast();
  if (!node) return;
  const tasks = [...installTasks.values()];
  node.replaceChildren();
  if (!tasks.length) { node.classList.remove('on'); return; }
  const runningTasks = tasks.filter((task) => task.phase === 'running');
  // 标题按「正在跑的那一组」措辞；两组同时在跑（装插件的同时点 MCP 重连）很罕见，
  // 取第一条进行中的分组就够，不为它另设一套文案。
  const group = (runningTasks[0] || tasks[0]).group || PROGRESS_GROUP_PLUGIN;
  const titles = PROGRESS_TITLES[group] || PROGRESS_TITLES[PROGRESS_GROUP_PLUGIN];
  // 计数只数「标题所指的这一组」：两组同时在跑时说「正在安装 2 个插件」而其中一个是 MCP
  // 就是假计数。另一组的任务不消失，仍在下面的行里逐条列出。
  const groupRunning = runningTasks.filter((task) => (task.group || PROGRESS_GROUP_PLUGIN) === group).length;
  const title = document.createElement('div');
  title.className = 'dsh-mcp-install-toast-title';
  title.textContent = groupRunning ? titles.running(String(groupRunning)) : titles.done();
  node.appendChild(title);
  for (const task of tasks.slice(0, 3)) {
    const row = document.createElement('div');
    row.className = 'dsh-mcp-install-toast-row';
    row.setAttribute('data-phase', task.phase);
    const dot = document.createElement('span');
    dot.className = 'dsh-mcp-install-toast-dot';
    const name = document.createElement('span');
    name.className = 'dsh-mcp-install-toast-name';
    name.textContent = task.name;
    const status = document.createElement('span');
    status.className = 'dsh-mcp-install-toast-status';
    status.textContent = t(taskStatusLabel(task));
    row.appendChild(dot); row.appendChild(name); row.appendChild(status);
    node.appendChild(row);
  }
  node.classList.add('on');
}
/**
 * 通用进度浮层入口：key 唯一标识一个在跑的任务（重复开装顶掉同一行，不叠两行）。
 * 挂的是 document.body，面板卸载、切标签页、切窗口都还在——这正是它存在的全部理由。
 */
function progressToastStart(key, name, group, labels) {
  const taskKey = String(key || '');
  if (!taskKey) return;
  const pending = installTimers.get(taskKey);
  if (pending) { clearTimeout(pending); installTimers.delete(taskKey); }
  installTasks.set(taskKey, {
    name: String(name || taskKey),
    phase: 'running',
    at: Date.now(),
    group: group || PROGRESS_GROUP_PLUGIN,
    labels: labels || PLUGIN_TASK_LABELS,
  });
  renderInstallToast();
}
function progressToastFinish(key, phase) {
  const taskKey = String(key || '');
  const task = installTasks.get(taskKey);
  if (!task) return;
  task.phase = phase;
  task.at = Date.now();
  renderInstallToast();
  // 结果态留 4.2s 让用户看清「装完了 / 失败了」，再淡出；期间同一任务重新开跑会取消这个定时器。
  const timer = setTimeout(() => {
    installTimers.delete(taskKey);
    const current = installTasks.get(taskKey);
    if (current && current.phase !== 'running' && Date.now() - current.at >= 4000) {
      installTasks.delete(taskKey);
      renderInstallToast();
    }
  }, 4200);
  installTimers.set(taskKey, timer);
}
function installToastStart(name) {
  progressToastStart(name, name, PROGRESS_GROUP_PLUGIN, PLUGIN_TASK_LABELS);
}
function installToastFinish(name, phase) {
  progressToastFinish(name, phase);
}

// 面板卸载后组件的 busy 会归零，但模块级的 installTasks 还在跑：按钮禁用要同时看它，
// 否则切个面板回来还能再点一次「安装」，同一插件被并发装两遍。
function isInstallRunning(name) {
  const task = installTasks.get(String(name || ''));
  return Boolean(task && task.phase === 'running');
}

// ── README 预览：极简 markdown 渲染 + 插图还原 ────────────────────────────────
//
// 为什么自己写：本文件没有 react-dom，也没有任何 markdown 依赖；README 又是公网
// 数据（不可信）。于是这里只做一件事——把 markdown 扫成块，逐块构造 React 元素，
// 全程不拼字符串、不用 innerHTML，链接一律过 URL 白名单。
//
// 覆盖 README 真正会用到的那部分语法：标题 / 段落 / 行内代码 / 围栏代码 / 无序与
// 有序列表 / 引用 / 分隔线 / 表格 / 粗体 / 斜体 / 删除线 / 链接 / 图片，外加裸 HTML
// 里的 <img>、<a>、<br>（插件展示页几乎都用 <p align="center"><img …> 摆横幅）。

const README_STYLE_ID = KEY_PREFIX + '.readme-style';
let readmeStyleInjected = false;

function ensureReadmeStyle() {
  if (readmeStyleInjected || typeof document === 'undefined') return;
  readmeStyleInjected = true;
  if (document.getElementById(README_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = README_STYLE_ID;
  style.textContent = [
    '.dsh-mcp-readme-modal{width:min(880px,94vw);max-width:94vw;max-height:86vh}',
    '.dsh-mcp-readme-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;font-size:12px;opacity:.75}',
    '.dsh-mcp-readme-body{margin-top:12px;overflow-wrap:anywhere}',
    // 长 README 的右下角「跳到末尾」：sticky 让它不随正文滚走，又留在弹层内部，
    // 焦点陷阱、Esc 关闭与「点遮罩关闭」都不受影响。外层不拦鼠标，只有按钮可点。
    '.dsh-mcp-readme-jump-wrap{position:sticky;bottom:12px;z-index:2;display:flex;justify-content:flex-end;margin-top:12px;pointer-events:none}',
    '.dsh-mcp-readme-jump{display:inline-flex;align-items:center;gap:6px;padding:7px 13px;border-radius:999px;border:1px solid var(--mcp-line);background:var(--mcp-bg-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:600;line-height:1.2;cursor:pointer;pointer-events:auto;box-shadow:var(--dsw-elevation-prominent);transition:border-color .12s,background .12s}',
    '.dsh-mcp-readme-jump:hover{border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover)}',
    '.dsh-mcp-readme-jump:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:2px}',
    '.dsh-mcp-md-h{margin:20px 0 8px;font-weight:600;line-height:1.35;letter-spacing:0}',
    '.dsh-mcp-md-h:first-child{margin-top:0}',
    '.dsh-mcp-md-p{margin:8px 0;line-height:1.72}',
    '.dsh-mcp-md-ul,.dsh-mcp-md-ol{margin:8px 0;padding-inline-start:22px}',
    '.dsh-mcp-md-li{margin:3px 0;line-height:1.7}',
    '.dsh-mcp-md-quote{margin:10px 0;padding:4px 12px;border-inline-start:3px solid var(--dsw-alias-border-strong,rgba(127,127,127,.4));opacity:.9}',
    '.dsh-mcp-md-code{padding:1px 5px;border-radius:4px;background:var(--dsw-alias-bg-subtle,rgba(127,127,127,.14));font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}',
    '.dsh-mcp-md-pre{margin:10px 0;padding:10px 12px;border-radius:8px;overflow:auto;background:var(--dsw-alias-bg-subtle,rgba(127,127,127,.12));font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em;line-height:1.6}',
    // 插图尺寸：README 里的截图常是 1600~3000px 的巨图，只限宽会把弹层撑成一根滚动条。
    // 这里同时限宽与限高（40vh：小窗口自动更小，一屏必能看到整张），等比缩放不裁切；
    // width:auto 保证小徽章不被放大糊成一片。真正的硬约束写在 img 的 inline style 上，
    // 这两条只是同值的样式兜底，避免「样式没注入成功就失控」。
    '.dsh-mcp-md-img{display:block;box-sizing:border-box;width:auto;max-width:100%;max-height:min(40vh,420px);height:auto;margin:10px 0;border-radius:8px;object-fit:contain;background:var(--dsw-alias-bg-subtle,rgba(127,127,127,.08))}',
    '.dsh-mcp-md-img-inline{display:inline-block;max-height:22px;max-width:min(100%,320px);width:auto;height:auto;margin:0 2px;vertical-align:middle;border-radius:4px;object-fit:contain}',
    // 兜底：任何来源塞进正文的 img（含裸 HTML 块里未被抽出的）都不许超出弹层宽度。
    '.dsh-mcp-readme-body img{max-width:100%}',
    '.dsh-mcp-readme-body table img{max-height:min(24vh,220px)}',
    '.dsh-mcp-md-table{width:100%;margin:10px 0;border-collapse:collapse;font-size:.92em}',
    '.dsh-mcp-md-table th,.dsh-mcp-md-table td{padding:6px 10px;border:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.25));text-align:start;vertical-align:top}',
    '.dsh-mcp-md-table th{background:var(--dsw-alias-bg-subtle,rgba(127,127,127,.10));font-weight:600}',
    '.dsh-mcp-md-a{color:var(--dsw-alias-accent,#3b82f6);text-decoration:none}',
    '.dsh-mcp-md-a:hover{text-decoration:underline}',
    '.dsh-mcp-md-hr{margin:16px 0;border:0;border-top:1px solid var(--dsw-alias-border-subtle,rgba(127,127,127,.25))}',
  ].join('\n');
  document.head.appendChild(style);
}

/** 链接/图片地址白名单：只放行 http(s) 与 data:image，其余（javascript: 等）一律丢弃。 */
function readmeSafeUrl(raw, base) {
  const text = String(raw == null ? '' : raw).trim().replace(/^<|>$/g, '');
  if (!text) return '';
  if (/^data:image\//i.test(text)) return text;
  if (/^mailto:/i.test(text)) return text;
  if (/^\/\//.test(text)) return 'https:' + text;
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('#')) return text;
  if (!base) return '';
  const rel = text.replace(/^\.\//, '');
  if (rel.startsWith('/')) {
    // 站内绝对路径：GitHub raw 的 base 形如 .../<owner>/<repo>/HEAD/，回到仓库根。
    const root = /^(https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+)\//.exec(base);
    return root ? root[1] + '/' + rel.slice(1) : '';
  }
  try {
    const resolved = new URL(rel, base);
    // 关键：new URL('javascript:alert(1)', base) 解析成功且协议是 javascript:，
    // 只靠 base 拼相对路径会把伪协议放行成可点击 href，这里必须再校验一次协议。
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return '';
    return resolved.toString();
  } catch {
    return '';
  }
}

/** 解析 `![alt](url "title")` / `[text](url "title")`（url 里允许成对括号）。 */
function readmeSplitLink(token) {
  const match = /^(!?)\[([^\]\n]*)\]\(\s*([^()\s]*(?:\([^()]*\)[^()\s]*)*)(?:\s+"([^"\n]*)")?\s*\)$/.exec(String(token || ''));
  if (!match) return null;
  return { image: match[1] === '!', label: match[2], url: match[3], title: match[4] || '' };
}

/* README 插图缩图代理。
 * 直连 GitHub 原图有两个硬伤：①README 截图常见 1600~3000px、单张几百 KB 到几 MB，
 * 跨国拉取常只有几十 KB/s，浏览器自上而下逐行解码，看起来就是「图只显示了一部分」；
 * ②原图字节多，弹层一打开就并发十几张，把带宽抢光，整个弹层都卡。
 * 所以 GitHub 系图片先走 wsrv.nl 缩到 880 宽（webp q72，体积通常降到 1/20），
 * 代理不可用时 onError 回退原图一次，再失败才隐藏——不牺牲可用性。 */
const README_IMG_PROXY = 'https://wsrv.nl/?output=webp&q=72&w=880&url=';
const README_IMG_PROXY_HOSTS = [
  'raw.githubusercontent.com',
  'user-images.githubusercontent.com',
  'private-user-images.githubusercontent.com',
  'objects.githubusercontent.com',
  'camo.githubusercontent.com',
  'github.com',
];

/** 只给 GitHub 系图源生成代理地址；其他源（如 npm registry、shields.io）原样返回 ''。 */
function readmeProxiedSrc(src) {
  try {
    const host = new URL(src).hostname.toLowerCase();
    if (README_IMG_PROXY_HOSTS.indexOf(host) < 0) return '';
    return README_IMG_PROXY + encodeURIComponent(src);
  } catch {
    return '';
  }
}

/** `![alt](url)` → img；相对路径按 base 还原成绝对 URL，还原不了就跳过（不产生坏图）。
 * 尺寸硬约束写在 inline style 上：不依赖 <style> 是否注入成功，也不怕被别处的 img 规则盖掉。 */
function readmeImageNode(src, alt, makeKey, base, opts) {
  const resolved = readmeSafeUrl(src, base);
  if (!resolved) return null;
  const inline = Boolean(opts && opts.inline);
  const proxied = inline ? '' : readmeProxiedSrc(resolved);
  const props = {
    key: makeKey('img'),
    className: inline ? 'dsh-mcp-md-img-inline' : 'dsh-mcp-md-img',
    src: proxied || resolved,
    alt: String(alt || ''),
    loading: 'lazy',
    decoding: 'async',
    referrerPolicy: 'no-referrer',
    style: inline
      // 行内小图标：压到行高附近，最多占 320px 宽，不把整段文字顶开。
      ? { display: 'inline-block', width: 'auto', height: 'auto', maxWidth: 'min(100%,320px)', maxHeight: '22px', objectFit: 'contain', verticalAlign: 'middle', margin: '0 2px' }
      // 块级插图：同时限宽限高，等比缩放不裁切；40vh 保证小窗口也能整张看到。
      : { display: 'block', boxSizing: 'border-box', width: 'auto', height: 'auto', maxWidth: '100%', maxHeight: 'min(40vh,420px)', objectFit: 'contain', margin: '10px 0', borderRadius: '8px', background: 'var(--dsw-alias-bg-subtle, rgba(127,127,127,.06))' },
    onError: (event) => {
      const node = event && event.currentTarget;
      if (!node) return;
      // 代理挂了退回原图一次；原图也挂了才隐藏（徽章 404 很常见，别留一排破图标）。
      const origin = proxied ? node.getAttribute('data-readme-origin') : '';
      if (origin) {
        node.setAttribute('src', origin);
        node.removeAttribute('data-readme-origin');
        return;
      }
      if (node.style) node.style.display = 'none';
    },
  };
  if (proxied) props['data-readme-origin'] = resolved;
  return h('img', props);
}

const README_INLINE_RE = /(`[^`\n]+`)|(!\[[^\]\n]*\]\([^()\s]*(?:\([^()]*\)[^()\s]*)*(?:\s+"[^"\n]*")?\s*\))|(\[[^\]\n]+\]\([^()\s]*(?:\([^()]*\)[^()\s]*)*(?:\s+"[^"\n]*")?\s*\))|(\*\*[^*\n]+\*\*)|(__[^_\n]+__)|(~~[^~\n]+~~)|(\*[^*\n]+\*)|(_[^_\n]+_)|(<https?:\/\/[^>\s]+>)|(<img\b[^>]*>)|(<br\s*\/?>)/i;

/** 行内语法 → React 节点数组。纯扫描，不做任何 HTML 解析。 */
function renderReadmeInline(text, makeKey, base) {
  const out = [];
  const source = String(text || '');
  // 每次调用都用独立的正则实例：renderReadmeInline 会递归（粗体/斜体/链接文字），
  // 共享 /g 实例的 lastIndex 会被递归内层归零，外层游标因此回退到起点 → 死循环（曾整页 OOM）。
  const re = new RegExp(README_INLINE_RE.source, 'gi');
  let cursor = 0;
  let match = re.exec(source);
  const pushText = (value) => {
    if (!value) return;
    out.push(value);
  };
  while (match) {
    pushText(source.slice(cursor, match.index));
    const token = match[0];
    if (token.startsWith('`')) {
      out.push(h('code', { key: makeKey('code'), className: 'dsh-mcp-md-code' }, token.slice(1, -1)));
    } else if (token.startsWith('![') || token.startsWith('[')) {
      const link = readmeSplitLink(token);
      if (!link) {
        pushText(token);
      } else if (link.image) {
        const node = readmeImageNode(link.url, link.label, makeKey, base, { inline: out.length > 0 });
        if (node) out.push(node);
      } else {
        const href = readmeSafeUrl(link.url, base);
        out.push(
          href
            ? h('a', { key: makeKey('a'), className: 'dsh-mcp-md-a', href, title: link.title || undefined, target: '_blank', rel: 'noreferrer noopener' }, renderReadmeInline(link.label, makeKey, base))
            : h('span', { key: makeKey('span') }, renderReadmeInline(link.label, makeKey, base)),
        );
      }
    } else if (token.startsWith('**') || token.startsWith('__')) {
      out.push(h('strong', { key: makeKey('strong') }, renderReadmeInline(token.slice(2, -2), makeKey, base)));
    } else if (token.startsWith('~~')) {
      out.push(h('del', { key: makeKey('del') }, renderReadmeInline(token.slice(2, -2), makeKey, base)));
    } else if (token.startsWith('*') || token.startsWith('_')) {
      out.push(h('em', { key: makeKey('em') }, renderReadmeInline(token.slice(1, -1), makeKey, base)));
    } else if (token.startsWith('<http')) {
      const href = readmeSafeUrl(token.slice(1, -1), base);
      out.push(
        href
          ? h('a', { key: makeKey('a'), className: 'dsh-mcp-md-a', href, target: '_blank', rel: 'noreferrer noopener' }, token.slice(1, -1))
          : token,
      );
    } else if (/^<img/i.test(token)) {
      const srcMatch = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(token);
      const altMatch = /\balt\s*=\s*["']([^"']*)["']/i.exec(token);
      const node = srcMatch ? readmeImageNode(srcMatch[1], altMatch ? altMatch[1] : '', makeKey, base, { inline: true }) : null;
      if (node) out.push(node);
    } else if (/^<br/i.test(token)) {
      out.push(h('br', { key: makeKey('br') }));
    }
    cursor = match.index + token.length;
    if (!token) break;
    match = re.exec(source);
  }
  pushText(source.slice(cursor));
  return out;
}

/** 从一段裸 HTML 里薅出 <img src>：README 的横幅几乎都藏在这种块里。 */
function readmeHtmlImages(text) {
  const out = [];
  const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match = re.exec(String(text || ''));
  while (match) {
    out.push(match[1]);
    match = re.exec(String(text || ''));
  }
  return out;
}

/** 裸 HTML 块 → 文本（去标签、留文字），用于既没图也没链接的说明性 HTML。 */
function readmeHtmlText(text) {
  return String(text || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/**
 * markdown → React 节点数组。`base` 用来还原相对图片/链接。
 * 解析器只认行首块级语法，行内交给 renderReadmeInline；认不出的行按段落处理，
 * 所以畸形 README 最差也只是排版朴素，不会崩、不会吞内容。
 */
function renderReadmeBlocks(markdown, base) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let seq = 0;
  const makeKey = (tag) => `md-${tag}-${seq++}`;
  let index = 0;
  let paragraph = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join(' ').replace(/\s+/g, ' ').trim();
    paragraph = [];
    if (text) blocks.push(h('p', { key: makeKey('p'), className: 'dsh-mcp-md-p' }, renderReadmeInline(text, makeKey, base)));
  };

  while (index < lines.length) {
    const line = lines[index];

    // 围栏代码块：整段原样保留，不再做行内解析。
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1][0];
      const body = [];
      index += 1;
      while (index < lines.length && !new RegExp('^\\s*' + marker + '{3,}\\s*$').test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push(h('pre', { key: makeKey('pre'), className: 'dsh-mcp-md-pre' }, h('code', null, body.join('\n'))));
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      index += 1;
      continue;
    }

    // 分隔线（--- / *** / ___，允许 3 个以上）
    if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
      flushParagraph();
      blocks.push(h('hr', { key: makeKey('hr'), className: 'dsh-mcp-md-hr' }));
      index += 1;
      continue;
    }

    // 标题：h1~h6 统一渲染成带 aria-level 的 div，别和弹窗自己的 h3 打架。
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1].length;
      blocks.push(
        h(
          'div',
          {
            key: makeKey('h'),
            className: 'dsh-mcp-md-h',
            role: 'heading',
            'aria-level': String(Math.min(6, level + 2)),
            style: { fontSize: level <= 1 ? '18px' : level === 2 ? '16px' : level === 3 ? '15px' : '14px' },
          },
          renderReadmeInline(heading[2], makeKey, base),
        ),
      );
      index += 1;
      continue;
    }

    // 表格：当前行含 | 且下一行是 |---|---| 分隔行
    if (line.includes('|') && index + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[index + 1]) && lines[index + 1].includes('-')) {
      flushParagraph();
      const splitRow = (row) =>
        String(row)
          .replace(/^\s*\|/, '')
          .replace(/\|\s*$/, '')
          .split('|')
          .map((cell) => cell.trim());
      const header = splitRow(line);
      index += 2;
      const rows = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitRow(lines[index]));
        index += 1;
      }
      blocks.push(
        h(
          'table',
          { key: makeKey('table'), className: 'dsh-mcp-md-table' },
          h('thead', null, h('tr', null, header.map((cell, cellIndex) => h('th', { key: cellIndex }, renderReadmeInline(cell, makeKey, base))))),
          h(
            'tbody',
            null,
            rows.map((row, rowIndex) =>
              h('tr', { key: rowIndex }, header.map((_, cellIndex) => h('td', { key: cellIndex }, renderReadmeInline(row[cellIndex] || '', makeKey, base)))),
            ),
          ),
        ),
      );
      continue;
    }

    // 引用：连续 > 行合成一段
    if (/^\s*>/.test(line)) {
      flushParagraph();
      const quote = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(h('blockquote', { key: makeKey('quote'), className: 'dsh-mcp-md-quote' }, h('p', { className: 'dsh-mcp-md-p' }, renderReadmeInline(quote.join(' '), makeKey, base))));
      continue;
    }

    // 裸 HTML 块：先薅图片，再留文字。
    if (/^\s*</.test(line) && !/^\s*<https?:/i.test(line)) {
      flushParagraph();
      const chunk = [];
      while (index < lines.length && /^\s*</.test(lines[index]) && !/^\s*<https?:/i.test(lines[index])) {
        chunk.push(lines[index]);
        index += 1;
      }
      const rawHtml = chunk.join('\n');
      const srcs = readmeHtmlImages(rawHtml);
      const nodes = [];
      srcs.forEach((src) => {
        const node = readmeImageNode(src, '', makeKey, base, { inline: false });
        if (node) nodes.push(node);
      });
      const leftover = readmeHtmlText(rawHtml);
      if (leftover) {
        nodes.push(h('p', { key: makeKey('htmltext'), className: 'dsh-mcp-md-p' }, renderReadmeInline(leftover.replace(/\n+/g, ' '), makeKey, base)));
      }
      if (nodes.length) blocks.push(h('div', { key: makeKey('html'), className: 'dsh-mcp-md-htmlblock' }, nodes));
      continue;
    }

    // 列表项：按缩进算层级，深度用 padding 表达（README 的嵌套一般不超过 3 层）
    const listItem = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listItem) {
      flushParagraph();
      const ordered = /\d/.test(listItem[2]);
      const items = [];
      while (index < lines.length) {
        const current = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[index]);
        if (!current) break;
        const depth = Math.min(3, Math.floor(current[1].replace(/\t/g, '  ').length / 2));
        items.push({ depth, text: current[3] });
        index += 1;
      }
      blocks.push(
        h(
          ordered ? 'ol' : 'ul',
          { key: makeKey('list'), className: ordered ? 'dsh-mcp-md-ol' : 'dsh-mcp-md-ul' },
          items.map((item, itemIndex) =>
            h('li', { key: itemIndex, className: 'dsh-mcp-md-li', style: item.depth ? { marginInlineStart: item.depth * 16 + 'px' } : undefined }, renderReadmeInline(item.text, makeKey, base)),
          ),
        ),
      );
      continue;
    }

    paragraph.push(line.trim());
    index += 1;
  }
  flushParagraph();
  return blocks;
}

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
// OPT-22（6.4 FAB 尺寸单源）：FAB 尺寸常量提升到 MCP_CSS 之前——CSS 里 .dsh-mcp-fab
// 的外框尺寸/右下边距由这两个常量模板插值生成，拖拽 clamp/defaultFabPos 也按它们计算。
// 单一定义点，CSS 与 JS 不可能漂移（历史教训：CSS 写死 50px + content-box 渲染出 52px，
// JS 按 50px 夹取，右/下边缘差 2px；border-box + 插值后两侧恒等）。
const FAB_SIZE = 50;
const FAB_EDGE = 22;

const MCP_CSS = `body{--mcp-cat-all:var(--dsw-alias-label-primary);--mcp-cat-uncat:var(--dsw-alias-label-primary);--mcp-cat-dev:var(--dsw-static-deepseek-500);--mcp-cat-design:var(--dsw-static-blue-400);--mcp-cat-office:var(--dsw-static-green-500);--mcp-cat-auto:var(--dsw-static-amber-500);--mcp-cat-ops:var(--dsw-static-neutral-bluish-500);--mcp-accent:var(--dsw-alias-brand-primary);--mcp-ok:var(--dsw-alias-state-success-primary);--mcp-err:var(--dsw-alias-state-error-primary);--mcp-warn:var(--dsw-alias-state-warn-primary);--mcp-mut:var(--dsw-alias-label-secondary);--mcp-bg-1:var(--dsw-alias-bg-layer-1);--mcp-bg-2:var(--dsw-alias-bg-layer-2);--mcp-bg-3:var(--dsw-alias-bg-layer-3);--mcp-line:var(--dsw-alias-border-l2);--mcp-mono:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);--mcp-r-xs:var(--dsw-radius-xs);--mcp-r-sm:var(--dsw-radius-sm);--mcp-r-md:var(--dsw-radius-md);--mcp-r-lg:var(--dsw-radius-lg);--mcp-r-xl:var(--dsw-radius-xl);--mcp-r-panel:var(--dsw-radius-panel);--mcp-tip-bg:#17263fec;--mcp-tip-fg:#f4f7fd;--mcp-tip-line:#ffffff2e;--mcp-tip-err:#ff8a8a;--mcp-tip-ok:#7ee0a1;--mcp-tip-shadow:0 10px 28px rgba(0,0,0,.30)}
/* Skill 看板升级 · 分类色（决策 10：只从宿主既有色相取，只用于色点与徽标）。
   暗色套与宿主 ui-theme 同构（body[data-ds-dark-theme]，取证见进度文档 §七）；
   分类色永远与文字标签成对出现，不单独用颜色传达信息。 */
body[data-ds-dark-theme]{--mcp-cat-dev:var(--dsw-static-deepseek-400);--mcp-cat-design:var(--dsw-static-blue-300);--mcp-cat-office:var(--dsw-static-green-400);--mcp-cat-auto:var(--dsw-static-amber-400);--mcp-cat-ops:var(--dsw-static-neutral-bluish-400);--mcp-tip-bg:#0c1a34e6}
/* 浮层提示（底部 toast / 顶部进度 pill）不跟页面主文字色：它们的底是插件自持的深色面
   （--mcp-tip-bg）。皮肤把 --dsw-alias-toast-bg 定成深蓝、把 --dsw-alias-label-primary 定成
   近黑 Navy（whale-song 浅色皮 #1a3a7a / #0a1e4a，实测 1.49:1），两者一组就是「深蓝字压深蓝底」，
   用户读不清。所以这里把浮层从 label-primary 的分组选择器里摘出来，只留字体族。 */
.dsh-mcp-wrap,.dsh-mcp-panel-overlay,.dsh-mcp-overlay,.dsh-mcp-fab,.dsh-mcp-footer-action,.dsh-mcp-toast{font-family:var(--dsw-font-family,inherit)}
.dsh-mcp-wrap,.dsh-mcp-panel-overlay,.dsh-mcp-overlay,.dsh-mcp-fab,.dsh-mcp-footer-action{color:var(--dsw-alias-label-primary)}
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
.dsh-mcp-badge{display:inline-flex;align-items:center;padding:1.5px 7px;border-radius:999px;font-size:10.5px;font-weight:500;line-height:16px;border:1px solid var(--mcp-line);color:var(--mcp-mut);background:var(--mcp-bg-1);corner-shape:round;white-space:nowrap}
.dsh-mcp-badge.dot::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor;margin-right:5px;opacity:.85;corner-shape:round}
/* §1.3 色语：橙色的名额只留给「需注意」（不兼容 / 缺参数 / 有死工具）。
   传输类型是描述值、不是状态，此前 stdio 独占橙底会让人误读成「这台有问题」。
   改成中性底 + 等宽字体：等宽本身就是「这是技术标识」的信号，与状态胶囊区分开，
   也把橙/绿/红三色彻底还给状态语义。 */
.dsh-mcp-badge.t-http,.dsh-mcp-badge.t-stdio{color:var(--mcp-mut);border-color:var(--mcp-line);background:var(--mcp-bg-3);font-family:var(--mcp-mono);font-size:10px;letter-spacing:.2px}
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
/* 令牌 / 授权弹层可能从详情弹层里打开：DOM 上排在详情之后仍会被同 z-index 的兄弟盖住，
   单独抬到 210，保证用户点「我已有令牌」后弹窗真的在最前面（命令面板 320、toast 300 不动）。 */
.dsh-mcp-overlay.dsh-mcp-front{z-index:210}
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
/* 连接器来源切换行：左边分段控件，右侧留白（社区未审核声明另起一行常驻） */
.dsh-mcp-wb-feedbar{justify-content:space-between;gap:8px}
/* 社区未审核声明：warn 配色，常驻不可折叠 */
.dsh-mcp-wb-note.warn{color:var(--mcp-warn);border-color:var(--mcp-warn);background:var(--dsw-alias-state-warn-tertiary)}
/* 社区游标翻页：居中一行「上一页 / 第 N 页 / 下一页」，列表不被按钮撑开 */
.dsh-mcp-wb-more{display:flex;justify-content:center;align-items:center;padding:12px 0 4px;flex:none}
.dsh-mcp-wb-card-actions a.dsh-mcp-btn{text-decoration:none}
.dsh-mcp-wb-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsh-mcp-wb-toolbar .dsh-mcp-check{margin:0!important;font-size:12px}
.dsh-mcp-wb-toolbar input[type='search']{flex:1 1 220px;min-width:160px;box-sizing:border-box}
/* T02/R2：visible_in 标签筛选 chips。选中态用 accent 边框 + 主色文字，与 wb-tab.sel 同语；clear 是弱化动作 */
.dsh-mcp-tag-chip{border:1px solid var(--mcp-line);border-radius:999px;background:var(--mcp-bg-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:18px;padding:3px 10px;cursor:pointer;transition:border-color .12s,color .12s}
.dsh-mcp-tag-chip:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.dsh-mcp-tag-chip.on{border-color:var(--mcp-accent);color:var(--mcp-accent);font-weight:600}
.dsh-mcp-tag-chip.clear{border-style:dashed;color:var(--mcp-mut)}
.dsh-mcp-tag-chip.clear:hover{color:var(--dsw-alias-label-primary)}
/* T03/R5：重启提示条——与普通 note 同框但带 accent 左边条，右侧「知道了」弱化动作 */
.dsh-mcp-wb-note.restart{border-left:3px solid var(--mcp-accent);display:flex;align-items:center;gap:10px}
/* ── 市场搜索框（WbSearchBox）：胶囊造型 + 内嵌放大镜 + 一键清空 ── */
.dsh-mcp-wb-search{position:relative;display:flex;align-items:center;flex:1 1 260px;min-width:200px;max-width:520px}
.dsh-mcp-wb-search-ico{position:absolute;left:11px;display:inline-flex;color:var(--mcp-mut);pointer-events:none;transition:color .15s}
.dsh-mcp-wb-search:focus-within .dsh-mcp-wb-search-ico{color:var(--mcp-accent)}
.dsh-mcp-wb-search-input{box-sizing:border-box;width:100%;min-width:0;padding:7px 32px 7px 33px!important;border:1px solid var(--mcp-line);border-radius:999px;background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:1.4;outline:none;transition:border-color .15s,box-shadow .15s,background .15s}
.dsh-mcp-wb-search-input::placeholder{color:var(--mcp-mut)}
.dsh-mcp-wb-search-input:hover:not(:disabled){border-color:var(--dsw-alias-border-l3)}
.dsh-mcp-wb-search-input:focus{border-color:var(--mcp-accent);background:var(--mcp-bg-2);box-shadow:0 0 0 3px color-mix(in srgb,var(--mcp-accent) 16%,transparent)}
.dsh-mcp-wb-search-input:disabled{opacity:.5;cursor:not-allowed}
/* busy＝服务端搜索在飞：输入框保持可用（disabled 会收走焦点，见 WbSearchBox 注释），
   只让放大镜呼吸提示「在加载」，光标与选区都不受影响。 */
.dsh-mcp-wb-search.busy .dsh-mcp-wb-search-ico{color:var(--mcp-accent);animation:dsh-wb-search-busy 1.1s ease-in-out infinite}
@keyframes dsh-wb-search-busy{0%,100%{opacity:1}50%{opacity:.3}}
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
/* 社区卡片整卡可点开详情：只有带 .clickable 的卡获得手型与焦点环，WB / 技能卡保持原样。 */
.dsh-mcp-card.wb.clickable{cursor:pointer;transition:border-color .15s,box-shadow .15s,background .15s}
.dsh-mcp-card.wb.clickable:hover{border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-card.wb.clickable:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:2px}
.dsh-mcp-wb-card-actions{display:flex;align-items:center;gap:8px;margin-top:auto;flex-wrap:wrap}
/* ── DSH 社区插件卡片：五条固定水平线（头部 34 / 摘要 38 / 标签 18 / 页脚 38）──
   只作用于 .dsh-mcp-pcard，连接器 / 技能 / 专家卡片不受影响。
   卡片固定 176px：标题永远一行，标签最多三个，按钮落在同一水平线。 */
.dsh-mcp-pcard{display:flex;flex-direction:column;gap:7px;min-width:0;min-height:176px;padding:12px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1);cursor:pointer;transition:border-color .15s,box-shadow .15s,background .15s}
.dsh-mcp-pcard:hover{border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover);box-shadow:0 10px 28px color-mix(in srgb,var(--mcp-accent) 12%,transparent)}
.dsh-mcp-pcard:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:2px}
.dsh-mcp-pcard.off{opacity:.82}
.dsh-mcp-phead{display:grid;grid-template-columns:32px minmax(0,1fr) auto;align-items:center;gap:10px;min-height:34px}
.dsh-mcp-pavatar{position:relative;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;flex:none;overflow:hidden;border:1px solid var(--mcp-line);border-radius:50%;corner-shape:round;background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--mcp-accent);font-size:12px;font-weight:650}
.dsh-mcp-pavatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
.dsh-mcp-piden{display:flex;flex-direction:column;gap:1px;min-width:0}
.dsh-mcp-pname{margin:0;font-size:14px;line-height:1.3;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-mcp-pmeta{display:flex;align-items:center;gap:5px;min-width:0;overflow:hidden;font-size:10.5px;line-height:1.4;color:var(--mcp-mut);white-space:nowrap}
.dsh-mcp-pmeta .official{display:inline-flex;align-items:center;gap:4px;flex:none;color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-mcp-pmeta .odot{width:5px;height:5px;flex:none;border-radius:50%;background:var(--mcp-accent)}
.dsh-mcp-pmeta .pdot{flex:none;opacity:.55}
.dsh-mcp-prepo{min-width:0;overflow:hidden;text-overflow:ellipsis}
.dsh-mcp-pverified{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;justify-self:end;color:var(--dsw-alias-state-success-primary)}
.dsh-mcp-pdesc{margin:0;height:38px;overflow:hidden;font-size:12px;line-height:1.55;color:var(--mcp-mut);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dsh-mcp-pchips{display:flex;align-items:center;gap:5px;height:18px;min-width:0;overflow:hidden;white-space:nowrap}
.dsh-mcp-pchip{display:inline-flex;align-items:center;flex:none;padding:0 7px;border:1px solid var(--mcp-line);border-radius:999px;background:var(--mcp-bg-2);font-size:10.5px;line-height:16px;color:var(--mcp-mut)}
.dsh-mcp-pchip.more{border-style:dashed}
/* 包名芯片是标签行里唯一允许收缩的一枚（其余 flex:none）：放不下时它自己省略号截断，
   分类/标签不会被挤成半截。行高仍由 .dsh-mcp-pchip 的 line-height:16px 决定 → 18px 不漂。*/
.dsh-mcp-pchip.mono{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;font-family:var(--mcp-mono);font-size:10px;letter-spacing:.2px;background:var(--mcp-bg-3)}
.dsh-mcp-pfoot{display:flex;align-items:center;justify-content:space-between;gap:8px;min-width:0;min-height:38px;margin-top:auto;padding-top:8px;border-top:1px solid var(--mcp-line)}
/* 底栏事实行（2.3.x 起 3 枚：↓近30天下载 / ★星数 / 核验日期）：
   · 字号 10.5→11.5px。实测卡高由 .dsh-mcp-pfoot 的 min-height:38 决定（footH 恒 47），
     这行字变大不动卡片一 px——用户明确要求「信息更丰富但卡不再变大」。
   · 去掉两枚「·」分隔点（每枚连 gap ≈12.7px），改成纯 gap:7px 间距，把省下的宽度
     付给新出现的「↓」，而不是让它去挤日期。
   · flex:1 1 0 + position:relative：这一行的盒子宽度**恒等于可用宽**（不随内容伸缩），
     JS 量到的 clientWidth 就是真可用宽；同时它独吞全部收缩，右侧按钮（.dsh-mcp-pbtn
     flex:none）永不被挤到换行——换行会把卡撑高。
   · .probe 是离流探针（width:max-content 才不会被可用宽夹住，否则永远量不出溢出），
     与真行同构，用来判断「三枚全画要多宽」；放不下时整枚收起日期，不裁半截字。 */
.dsh-mcp-pfacts{position:relative;flex:1 1 0;display:flex;align-items:center;gap:7px;min-width:0;overflow:hidden;font-size:11.5px;line-height:1.4;color:var(--mcp-mut);white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-mcp-pfacts .dl{display:inline-flex;align-items:center;flex:none;color:var(--dsw-alias-label-primary);opacity:.72}
.dsh-mcp-pfacts .star{display:inline-flex;align-items:center;gap:3px;flex:none;color:var(--dsw-alias-label-primary);opacity:.72}
.dsh-mcp-pfacts .when{flex:none;opacity:.85}
.dsh-mcp-pfacts-probe{position:absolute;left:0;top:0;width:max-content;display:flex;align-items:center;gap:7px;white-space:nowrap;visibility:hidden;pointer-events:none}
.dsh-mcp-pbtn{display:inline-flex;align-items:center;justify-content:center;height:28px;padding:0 12px;flex:none;border:1px solid var(--mcp-accent);border-radius:8px;background:var(--mcp-accent);color:#fff;font:inherit;font-size:12px;font-weight:600;line-height:1;cursor:pointer;transition:background .12s,border-color .12s,opacity .12s}
.dsh-mcp-pbtn:hover:not(:disabled){border-color:var(--mcp-accent);background:color-mix(in srgb,var(--mcp-accent) 86%,#000)}
.dsh-mcp-pbtn:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:2px}
.dsh-mcp-pbtn:disabled{opacity:.55;cursor:not-allowed}
.dsh-mcp-pbtn.installed{border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-label-primary)}
.dsh-mcp-pbtn.installed:hover:not(:disabled){border-color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}
.dsh-mcp-phost{display:inline-flex;align-items:center;gap:4px;flex:none;min-width:0;font-size:10.5px;line-height:1.4;color:var(--mcp-mut);white-space:nowrap}
.dsh-mcp-phost .ico{flex:none;color:var(--mcp-warn)}
.dsh-mcp-wb-blocked{font-size:10.5px;color:var(--mcp-warn);line-height:1.4;min-width:0;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.dsh-mcp-wb-pager{display:flex;align-items:center;justify-content:center;gap:12px;padding:6px 0 2px}
.dsh-mcp-page-jump{display:flex;align-items:center;gap:4px;font-size:11.5px;color:var(--mcp-mut)}
.dsh-mcp-page-jump>input{width:48px;box-sizing:border-box;padding:2px 4px;font:inherit;text-align:center;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-sm);background:var(--mcp-bg-3);color:inherit}
.dsh-mcp-page-jump>input:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:1px}
.dsh-mcp-readonly-note{display:flex;align-items:flex-start;gap:5px;font-size:10.5px;line-height:1.5;color:var(--mcp-mut);padding:5px 7px;border-radius:var(--mcp-r-sm);background:var(--mcp-bg-3)}
.dsh-mcp-readonly-note>svg{flex:none;margin-top:1px;opacity:.75}
.dsh-mcp-wb-modal{width:640px;max-width:92vw}
.dsh-mcp-wb-modal-head{display:flex;align-items:center;gap:10px;min-width:0}
.dsh-mcp-wb-modal-head h3{margin:0;min-width:0;overflow-wrap:anywhere}
.dsh-mcp-wb-modal-desc{font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-mcp-wb-modal-note{font-size:11.5px;line-height:1.6;color:var(--mcp-mut)}
.dsh-mcp-wb-examples{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);background:var(--mcp-bg-2);border-radius:var(--mcp-r-sm);padding:8px 12px;margin:10px 0}
.dsh-mcp-wb-tokenform{display:flex;flex-direction:column;gap:10px;margin:12px 0 4px}
.dsh-mcp-wb-tokenfield{display:flex;flex-direction:column;gap:5px;min-width:0}
.dsh-mcp-wb-tokenlabel{font-size:11.5px;line-height:1.45;color:var(--mcp-mut);overflow-wrap:anywhere}
.dsh-mcp-wb-tokenfield input{box-sizing:border-box;width:100%;padding:7px 10px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-sm);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;outline:none;transition:border-color .15s}
.dsh-mcp-wb-tokenfield input:focus{border-color:var(--mcp-accent)}
.dsh-mcp-wb-tokenfield input::placeholder{color:var(--mcp-mut)}
.dsh-mcp-wb-examples ul{margin:4px 0 0;padding-left:18px}
/* 详情里的 command / args / 远程地址：等宽、可断行，绝不横向撑破弹层。 */
.dsh-mcp-cmdline{margin:5px 0 0;font-family:var(--mcp-mono);font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-primary);white-space:pre-wrap;overflow-wrap:anywhere}
.dsh-mcp-wb-roster{list-style:none;margin:6px 0 0;padding:0;display:flex;flex-direction:column;gap:5px}
.dsh-mcp-wb-roster li{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;font-size:12px;line-height:1.5;padding:5px 9px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-sm);background:var(--mcp-bg-2)}
.dsh-mcp-wb-roster b{font-weight:650;min-width:0;overflow-wrap:anywhere}
.dsh-mcp-wb-roster-role{font-size:11px;color:var(--dsw-alias-brand-text);flex:none}
.dsh-mcp-wb-roster-prof{font-size:11px;color:var(--mcp-mut);flex:none}
.dsh-mcp-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px;flex-wrap:wrap}
.dsh-mcp-modal-actions a.dsh-mcp-btn{text-decoration:none}
.dsh-mcp-advanced{margin-top:14px}.dsh-mcp-check{display:flex!important;align-items:center;gap:8px;margin:9px 0!important;color:var(--dsw-alias-label-primary)!important}.dsh-mcp-check input{width:auto!important}.dsh-mcp-number-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.dsh-mcp-number-grid .dsh-mcp-field{margin-bottom:0}.dsh-mcp-import-preview{font-size:12px;line-height:1.6;color:var(--mcp-mut);white-space:pre-wrap}.dsh-mcp-import-json{min-height:220px;resize:vertical;font-family:var(--mcp-mono)!important}
.dsh-mcp-builtin-count{font-size:11.5px;color:var(--mcp-mut)}
.dsh-mcp-source-box{margin:0 0 14px;flex:none}.dsh-mcp-source-list{display:flex;flex-direction:column;gap:6px;max-height:186px;overflow-y:auto;margin-top:7px}.dsh-mcp-source-row{box-sizing:border-box;display:flex;flex-direction:column;gap:3px;width:100%;padding:8px 10px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;line-height:1.45;text-align:left;cursor:pointer;transition:border-color .12s,background .12s}.dsh-mcp-source-row:hover:not(:disabled){border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}.dsh-mcp-source-row.sel{border-color:var(--mcp-accent);background:var(--mcp-bg-2)}.dsh-mcp-source-row:disabled{cursor:default;opacity:.7}.dsh-mcp-source-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.dsh-mcp-source-name{font-weight:600}.dsh-mcp-source-path{font-family:var(--mcp-mono);font-size:10.5px;color:var(--dsw-alias-brand-text);overflow-wrap:anywhere}.dsh-mcp-source-detail{font-size:11px;color:var(--mcp-mut);overflow-wrap:anywhere}.dsh-mcp-source-note{font-size:10.5px;color:var(--mcp-mut)}.dsh-mcp-source-warn{font-size:10.5px;color:var(--mcp-warn)}
/* OPT-17 · 2.5：不支持分组的呈现（复用 source-row 的排版，只补两处色语与分组间距） */
.dsh-mcp-source-unsupported{font-size:11px;line-height:1.5;color:var(--mcp-warn);overflow-wrap:anywhere}
.dsh-mcp-import-group{display:flex;gap:6px;align-items:baseline;font-size:12px;line-height:1.6}
.dsh-mcp-import-group>b{flex:0 0 auto;color:var(--mcp-mut)}
.dsh-mcp-import-group>b.warn{color:var(--mcp-warn)}
.dsh-mcp-import-group-note{font-size:11px;line-height:1.5;color:var(--mcp-mut);overflow-wrap:anywhere;margin-top:2px}
.dsh-mcp-toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--mcp-tip-bg);backdrop-filter:blur(10px);border:1px solid var(--mcp-tip-line);color:var(--mcp-tip-fg);padding:9px 16px;border-radius:var(--mcp-r-lg);font-size:12.5px;line-height:1.5;text-align:center;z-index:300;box-shadow:var(--mcp-tip-shadow);max-width:min(560px,calc(100vw - 32px));overflow-wrap:anywhere;animation:mcpPop .16s ease-out}
.dsh-mcp-toast.err{border-color:var(--mcp-tip-err)}
.dsh-mcp-toast.ok{border-color:var(--mcp-tip-ok)}
.dsh-mcp-toggle{position:relative;width:34px;height:19px;box-sizing:border-box;border-radius:999px;border:0;cursor:pointer;background:var(--dsw-alias-border-l3);transition:background .18s,border-color .18s;flex:none;box-shadow:none;corner-shape:round}
.dsh-mcp-toggle[aria-checked='true']{background:var(--mcp-accent);border-color:transparent}
.dsh-mcp-toggle:disabled{opacity:.65;cursor:not-allowed}
.dsh-mcp-toggle::after{content:"";position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--dsw-alias-switch-thumb);transition:left .18s,background .18s;box-shadow:none;corner-shape:round}
.dsh-mcp-toggle[aria-checked='true']::after{left:17px;background:var(--dsw-alias-label-primary-foreground)}
.dsh-mcp-d-err{font-size:12.5px;color:var(--mcp-err);margin-top:8px;white-space:pre-wrap}
/* 悬浮按钮：外框尺寸由 JS 常量 FAB_SIZE/FAB_EDGE 模板插值生成（单源无漂移，
   拖拽 clampFabPos/defaultFabPos 按同一常量计算，两侧恒等）。border-box 保留：
   历史教训——1px 边框 + content-box 曾把 50px 渲染成 52px，与 JS 按 50px 夹取差 2px。 */
.dsh-mcp-fab{position:fixed;right:${FAB_EDGE}px;bottom:${FAB_EDGE}px;box-sizing:border-box;width:${FAB_SIZE}px;height:${FAB_SIZE}px;border-radius:50%;border:0;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);cursor:grab;user-select:none;display:flex;align-items:center;justify-content:center;box-shadow:var(--dsw-elevation-panel);z-index:190;touch-action:none;transition:transform .16s,background .16s;pointer-events:auto;corner-shape:round}
.dsh-mcp-fab:hover{transform:scale(1.05);background:var(--dsw-alias-button-primary-hover)}
.dsh-mcp-fab:active{transform:scale(.97)}
.dsh-mcp-fab svg{width:22px;height:22px}
.dsh-mcp-tab-pop.dsh-mcp-fab-menu{position:fixed;right:auto;min-width:196px;max-width:240px;z-index:191}
.dsh-mcp-fab-menu-item:disabled{opacity:.55;cursor:not-allowed}
.dsh-mcp-fab-menu-item:disabled:hover{background:transparent}
.dsh-mcp-fab-menu-note{margin:4px 6px 2px;color:var(--mcp-mut);font-size:11px;line-height:1.5}
.dsh-mcp-fab-hint{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:191;max-width:min(440px,82vw);padding:9px 14px;border-radius:999px;background:var(--mcp-bg-2);color:var(--dsw-alias-label-primary);box-shadow:var(--dsw-elevation-panel);font-size:12px;line-height:1.5;text-align:center;pointer-events:none}
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
/* max-width：窄窗下菜单本身也不许顶出视口（width 是内容盒，+10 padding +2 border 仍留 8px 余量）。 */
.dsh-mcp-quick-menu{position:fixed;z-index:950;min-width:128px;max-width:calc(100vw - 20px);padding:5px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-1);box-shadow:var(--dsw-elevation-overlay,0 8px 28px rgba(0,0,0,.14));transform-origin:left bottom;animation:dshMcpMenuIn .12s ease-out}
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
/* 232px 是常用的展开宽度；max-width 保证极窄窗下也不横出视口。 */
.dsh-mcp-quick-sub{position:absolute;top:50%;left:calc(100% + 4px);z-index:951;display:flex;flex-direction:column;width:232px;max-width:calc(100vw - 28px);max-height:min(216px,40vh);padding:5px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-1);box-shadow:var(--dsw-elevation-overlay,0 8px 28px rgba(0,0,0,.14));transform:translateY(-50%);transform-origin:left center;animation:dshMcpQuickIn .13s ease-out}
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
/* 向上展开 = 子菜单底边贴锚点行底边、向上生长。旧写法 bottom:50% + translateY(50%)
   与默认的 top:50% + translateY(-50%) 数学上等价，等于没翻，子菜单照样越过视口下缘。 */
.dsh-mcp-quick-row.flip .dsh-mcp-quick-sub{top:auto;bottom:0;transform:none}
.dsh-mcp-quick-row.flip .dsh-mcp-quick-sub{animation-name:dshMcpQuickInFlip}
/* 视口右缘不够时 JS 加 hflip：子菜单改到锚点行左侧展开，出场动画镜像。
   菜单本体贴屏幕右边时，这一侧才是「向内开」，否则 232px 的第二级会整块伸出视口。 */
.dsh-mcp-quick-row.hflip .dsh-mcp-quick-sub{left:auto;right:calc(100% + 4px);transform-origin:right center;animation-name:dshMcpQuickInLeft}
.dsh-mcp-quick-row.hflip.flip .dsh-mcp-quick-sub{animation-name:dshMcpQuickInFlipLeft}
@keyframes dshMcpQuickIn{from{opacity:0;transform:translateY(-50%) translateX(-4px)}to{opacity:1;transform:translateY(-50%)}}
@keyframes dshMcpQuickInFlip{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
@keyframes dshMcpQuickInLeft{from{opacity:0;transform:translateY(-50%) translateX(4px)}to{opacity:1;transform:translateY(-50%)}}
@keyframes dshMcpQuickInFlipLeft{from{opacity:0;transform:translateX(4px)}to{opacity:1;transform:none}}
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
   顶带让位必须**按平台分开**，这是 Windows 上「首次进入整体偏下、要下滚 40px」的根因：
     · macOS：框架不补顶带，页面自己让（--dsh-frame-top-clearance 由宿主设为 48px）；
     · Windows：框架的 [data-windows-titlebar] .BynINW_frame 已经 padding-top 过一次
       标题栏高度，页面再让自己的 clearance 就是把同一段留白算两遍。
   官方 ui-plugin-manager 的 PluginManagerPage 就是这个写法（基础 padding-top 28px，
   仅 [data-platform=darwin] 叠加 clearance），照抄可保证与官方页面在同一窗口下等高。
   高度不走 100dvh 反算：视口高≠中栏可用高（框架已扣过标题栏），一旦反算必然多出
   一段正好等于标题栏高度的溢出。改成 flex 填充父容器可用高度，从结构上消除这道算术。 */
.dsh-mcp-page{box-sizing:border-box;height:100%;min-height:0;overflow:auto;display:flex;flex-direction:column;padding:16px 20px 24px;background:var(--dsw-alias-bg-base)}
[data-platform=darwin] .dsh-mcp-page{padding-top:calc(var(--dsh-frame-top-clearance,0px) + 16px)}
/* flex:1 1 auto 让内容吃满剩余高度（no scrollbar）；min-height:520px 是窗口过矮时的
   兜底——撑破容器后由外层 overflow:auto 接管整体滚动，而不是把内部列表压扁。
   width:100% 必须显式给：改成 flex 容器后，auto 外边距（居中）会让交叉轴尺寸回落到
   fit-content，去掉它会比原来的块级铺满莫名其妙地窄一圈。 */
.dsh-mcp-page>.dsh-mcp-wrap{flex:1 1 auto;width:100%;min-height:520px;max-width:1180px;margin:0 auto}
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

/* ── 顶栏右端「点 Star」──────────────────────────────────────────────
   分类栏本身是 flex-wrap 的（窄屏换行），所以外面套一行：chip 们占剩余宽度自由换行，
   star 贴右上不参与换行。它挂在 role=tablist 容器**之外**——tablist 里只该有 tab。 */
.dsh-mcp-cats-row{display:flex;align-items:flex-start;gap:10px}
.dsh-mcp-cats-row>.dsh-mcp-cats{flex:1 1 auto;min-width:0}
.dsh-mcp-star{position:relative;display:inline-flex;align-items:center;gap:6px;flex:none;box-sizing:border-box;padding:5px 11px 5px 9px;border:1px solid var(--mcp-line);border-radius:999px;corner-shape:round;background:var(--mcp-bg-1);color:var(--mcp-mut);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;text-decoration:none;cursor:pointer;transition:border-color .14s,color .14s,background .14s}
.dsh-mcp-star:hover{border-color:var(--mcp-cat-auto);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-mcp-star:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--mcp-accent));outline-offset:1px}
.dsh-mcp-star-label{font-weight:600}
.dsh-mcp-star-count{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-star:hover .dsh-mcp-star-count{color:var(--mcp-cat-auto)}
/* 星形：平时淡灰描边感（低不透明度实心），hover 转实心琥珀并轻转——「这里可以点」的线索 */
.dsh-mcp-star-svg{width:15px;height:15px;flex:none;color:var(--dsw-alias-label-tertiary);transition:color .14s,transform .2s}
.dsh-mcp-star:hover .dsh-mcp-star-svg{color:var(--mcp-cat-auto);transform:rotate(18deg) scale(1.12)}
.dsh-mcp-star-svg path{fill:currentColor;stroke:none;opacity:.3;transition:opacity .14s}
.dsh-mcp-star:hover .dsh-mcp-star-svg path{opacity:1}
/* 小交互图案：两颗四角星屑，平时不显示，hover / 点下去才闪出来（不占布局） */
.dsh-mcp-star-spark{position:absolute;width:5px;height:5px;border-radius:1px;background:var(--mcp-cat-auto);opacity:0;pointer-events:none;transform:scale(.3)}
.dsh-mcp-star-spark.a{left:3px;top:3px}
.dsh-mcp-star-spark.b{right:4px;bottom:4px;width:4px;height:4px}
.dsh-mcp-star:hover .dsh-mcp-star-spark{animation:dshMcpStarTwinkle .9s ease-out}
.dsh-mcp-star:hover .dsh-mcp-star-spark.b{animation-delay:.16s}
/* 点下去：星形放大回弹 + 星屑迸一下，明确「已经跳去 GitHub 了」 */
.dsh-mcp-star.burst{border-color:var(--mcp-cat-auto)}
.dsh-mcp-star.burst .dsh-mcp-star-svg{animation:dshMcpStarPop .55s cubic-bezier(.22,1.4,.36,1)}
.dsh-mcp-star.burst .dsh-mcp-star-spark{animation:dshMcpStarTwinkle .55s ease-out}
@keyframes dshMcpStarTwinkle{0%{opacity:0;transform:scale(.3) rotate(0)}45%{opacity:1;transform:scale(1) rotate(35deg)}100%{opacity:0;transform:scale(.5) rotate(70deg)}}
@keyframes dshMcpStarPop{0%{transform:scale(1) rotate(0)}35%{transform:scale(1.5) rotate(24deg)}70%{transform:scale(.92) rotate(-6deg)}100%{transform:scale(1.12) rotate(18deg)}}
/* 窄屏只留图案与数字，文字标签让位给分类 chip 的换行 */
@media (max-width:760px){.dsh-mcp-star{padding:5px 9px}.dsh-mcp-star-label{display:none}}
/* 减弱动效：星形不再转、不再迸，但 hover 的配色反馈与静态星屑都留着——信息量不打折 */
@media (prefers-reduced-motion: reduce){.dsh-mcp-star,.dsh-mcp-star-svg,.dsh-mcp-star-svg path{transition:none}.dsh-mcp-star:hover .dsh-mcp-star-svg{transform:none}.dsh-mcp-star.burst .dsh-mcp-star-svg{animation:none;transform:none}.dsh-mcp-star:hover .dsh-mcp-star-spark,.dsh-mcp-star.burst .dsh-mcp-star-spark{animation:none;opacity:.9}}

/* ── Skill 看板 ─────────────────────────────────────────────────── */
.dsh-mcp-skill-view{display:flex;flex-direction:column;gap:12px;min-height:0}
.dsh-mcp-skill-body{display:flex;gap:14px;min-height:0;align-items:stretch}
.dsh-mcp-skill-side{width:340px;flex:none;display:flex;flex-direction:column;gap:10px;min-height:0}
.dsh-mcp-skill-list{overflow-y:auto;scrollbar-gutter:stable;min-height:0;display:flex;flex-direction:column;gap:4px;padding-right:2px}
.dsh-mcp-skill{display:flex;align-items:flex-start;gap:9px;padding:9px 10px;border-radius:var(--mcp-r-md);corner-shape:round;cursor:pointer;border:0;background:0 0;color:inherit;font:inherit;text-align:left}
.dsh-mcp-skill:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-skill[aria-selected="true"]{background:var(--mcp-bg-3)}
.dsh-mcp-skill:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsh-mcp-skill-main{min-width:0;flex:1 1 auto}
.dsh-mcp-skill-name{font-weight:500;color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px;word-break:break-word}
.dsh-mcp-skill-sub{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:3px}
.dsh-mcp-skill-src{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-family:var(--mcp-mono)}
.dsh-mcp-skill-desc{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;margin-top:4px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.dsh-mcp-skill-note{color:var(--mcp-mut);font-size:11px;line-height:15px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dsh-mcp-skill-detail{flex:1 1 auto;min-width:0;min-height:0;border:.5px solid var(--mcp-line);border-radius:var(--mcp-r-lg);corner-shape:round;background:var(--mcp-bg-1);display:flex;flex-direction:column;overflow:hidden}
.dsh-mcp-skill-d-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:14px 16px 10px}
.dsh-mcp-skill-d-title{margin:0;font-size:15px;font-weight:500;color:var(--dsw-alias-label-primary);line-height:20px;word-break:break-word}
.dsh-mcp-skill-d-sub{margin:4px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;font-family:var(--mcp-mono);word-break:break-all}
.dsh-mcp-skill-d-body{padding:4px 16px 16px;overflow-y:auto;scrollbar-gutter:stable;min-height:0;display:flex;flex-direction:column;gap:12px}
.dsh-mcp-skill-d-sec{margin:0}
.dsh-mcp-skill-d-sec>b{display:block;font-size:11px;font-weight:500;letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);margin-bottom:5px}
.dsh-mcp-skill-d-desc{margin:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;white-space:pre-wrap}
.dsh-mcp-skill-d-md{margin:0;border:.5px solid var(--mcp-line);border-radius:var(--mcp-r-md);corner-shape:round;background:var(--mcp-bg-2);color:var(--dsw-alias-label-primary);font-family:var(--mcp-mono);font-size:12px;line-height:18px;padding:12px;white-space:pre-wrap;word-break:break-word;overflow-x:auto;max-height:52vh}
.dsh-mcp-skill-d-path{display:inline-flex;align-items:center;gap:6px;border:0;border-radius:var(--mcp-r-sm);corner-shape:round;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:17px;font-family:var(--mcp-mono);padding:0;cursor:pointer;text-align:left;word-break:break-all}
.dsh-mcp-skill-d-path:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}
/* OPT-16/26 · 3.2/3.3：链接式按钮（展开全文/收起/显示全部），无底无边框、主题色小字 */
.dsh-mcp-link-btn{border:0;background:0 0;color:var(--mcp-accent);font:inherit;font-size:12px;line-height:17px;padding:0;cursor:pointer}
.dsh-mcp-skill-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:10px 2px}

/* Skill 看板升级：分类轨道 + 网格/列表双视图 + 详情操作区。
   全部走宿主主题令牌（决策 2/10），分类色只出现在色点与徽标，且永远伴随文字标签。 */
.dsh-mcp-skill-toolbar{display:flex;align-items:center;gap:10px;flex:none}
/* 作用域行（issue #8）：全局 / 各工作区。与 MCP 页同一套分段控件，只是一行独占；
   工作区多时由 ScopeTabs 自己折叠成「…N」，这里只保证不撑破内容区的宽度。 */
.dsh-mcp-skill-scope{display:flex;align-items:center;gap:8px;flex:none;min-width:0}
/* ScopeTabs 的可用宽度取的是它外层 .dsh-mcp-tabs-wrap 的 clientWidth。MCP 页里这个
   wrap 是列向 flex 的直接子项，宽度由容器决定；放到「作用域行」这种横向 flex 里时，
   flex:none 会让它按内容收缩——估算宽度一旦让它折叠成「全局 …N」，内容变窄，
   ResizeObserver 之后测到的还是那个窄宽，永远回不到展开态。1000px 的面板里实测固定
   显示「全局 … 4」，工作区一个都点不到。让 wrap 吃满这一行：宽度只由容器决定，
   折叠才是一次性的、能随面板变宽恢复。 */
.dsh-mcp-skill-scope>.dsh-mcp-tabs-wrap{flex:1 1 auto;min-width:0}
/* 看板搜索框自带完整样式（此前只有 flex 尺寸，放大镜裸排在输入框外、输入框吃浏览器默认态）。
   观感对齐 .suite-search：图标内嵌居中、统一 30px 高。聚焦圈只能用 inset 内描边：
   搜索框贴着 .dsh-mcp-skill-content（overflow 滚动容器）的边缘，向外的 shadow 光环
   会被裁出残缺口（.dsh-mcp-search 聚焦因此直接 box-shadow:none，同理）。
   输入非空时容器挂 querying 类，input 的右 padding 给「清空」按钮让位。 */
.dsh-mcp-skill-search{position:relative;display:flex;align-items:center;flex:1 1 auto;min-width:0;height:30px}
.dsh-mcp-skill-search>svg{position:absolute;top:50%;left:9px;transform:translateY(-50%);pointer-events:none;color:var(--mcp-mut)}
.dsh-mcp-skill-search input{box-sizing:border-box;width:100%;height:30px;padding:0 10px 0 28px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);corner-shape:round;background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;outline:0;transition:border-color .15s,box-shadow .15s}
.dsh-mcp-skill-search input:hover{border-color:var(--dsw-alias-border-l3)}
.dsh-mcp-skill-search input::placeholder{color:var(--mcp-mut)}
.dsh-mcp-skill-search input:focus{border-color:var(--mcp-accent);box-shadow:inset 0 0 0 1px var(--mcp-accent)}
.dsh-mcp-skill-search.querying input{padding-right:28px}
.dsh-mcp-skill-search .clear{position:absolute;top:50%;right:5px;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;padding:0;border:0;border-radius:var(--mcp-r-xs);corner-shape:round;background:0 0;color:var(--mcp-mut);cursor:pointer;transition:background .12s,color .12s}
.dsh-mcp-skill-search .clear:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-mcp-skill-search .clear:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:1px}
.dsh-mcp-skill-seg{display:inline-flex;flex:none;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);corner-shape:round;background:var(--mcp-bg-2);padding:2px;gap:2px}
.dsh-mcp-skill-seg-btn{display:inline-flex;align-items:center;gap:5px;border:0;border-radius:var(--mcp-r-sm);corner-shape:round;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:20px;padding:2px 9px;cursor:pointer;transition:background .12s,color .12s}
.dsh-mcp-skill-seg-btn:hover{color:var(--dsw-alias-label-primary)}
.dsh-mcp-skill-seg-btn[aria-pressed="true"]{background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.dsh-mcp-skill-seg-btn:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:1px}
.dsh-mcp-skill-rail{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:none}
.dsh-mcp-skill-cat{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border:1px solid var(--mcp-line);border-radius:999px;corner-shape:round;background:var(--mcp-bg-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:18px;white-space:nowrap;cursor:pointer;transition:background .12s,border-color .12s,color .12s}
.dsh-mcp-skill-cat:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.dsh-mcp-skill-cat.on{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-mcp-skill-cat:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:1px}
.dsh-mcp-skill-cat-count{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-skill-cat.on .dsh-mcp-skill-cat-count{color:var(--dsw-alias-label-primary)}
.dsh-mcp-skill-cat-dot{display:inline-block;width:7px;height:7px;border-radius:50%;flex:none}
.dsh-mcp-skill-result{flex:none}
.dsh-mcp-skill-content{flex:1 1 auto;min-width:0;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:10px;padding-right:2px}
.dsh-mcp-skill-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(258px,1fr));gap:10px;align-content:start}
.dsh-mcp-skill-cluster{margin-top:4px}
.dsh-mcp-skill-card{position:relative;display:flex;flex-direction:column;text-align:left;border:0;padding:0;background:0 0;color:inherit;font:inherit;cursor:pointer;border-radius:var(--mcp-r-lg);corner-shape:round}
.dsh-mcp-skill-card-inner{display:flex;flex-direction:column;gap:8px;box-sizing:border-box;height:100%;padding:12px 13px;border:0.5px solid var(--mcp-line);border-radius:var(--mcp-r-lg);corner-shape:round;background:var(--mcp-bg-1);transition:background .12s,border-color .12s}
.dsh-mcp-skill-card:hover .dsh-mcp-skill-card-inner{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}
.dsh-mcp-skill-card.on .dsh-mcp-skill-card-inner{border-color:var(--mcp-accent)}
.dsh-mcp-skill-card:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:2px}
.dsh-mcp-skill-card-top{display:flex;align-items:center;gap:8px;min-width:0}
.dsh-mcp-skill-cat-tile{display:inline-block;width:10px;height:10px;border-radius:3px;flex:none}
/* Skill 头像：真图与生成头像同一几何，直径对齐市场（网格 30 / 列表 22 / 详情 42）。
   生成版渐变底色由组件按名字哈希内联，颜色这里只管字形与描边——白字在深浅两主题的
   饱和底上都可读；真图版与 .dsh-mcp-card-avatar 同规格，探活失败同样回落字母。 */
.dsh-mcp-skill-avatar{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;corner-shape:round;flex:none;font-size:13px;font-weight:650;line-height:1;color:#fff;text-shadow:0 1px 2px rgb(0 0 0 / 22%);border:1px solid var(--mcp-line);box-shadow:inset 0 0 0 1px rgb(255 255 255 / 18%)}
.dsh-mcp-skill-avatar.sm{width:22px;height:22px;font-size:11px}
.dsh-mcp-skill-avatar.lg{width:42px;height:42px;font-size:17px}
.dsh-mcp-skill-avatar-img{width:30px;height:30px;border-radius:50%;corner-shape:round;object-fit:cover;flex:none;border:1px solid var(--mcp-line);background:var(--mcp-bg-1)}
.dsh-mcp-skill-avatar-img.sm{width:22px;height:22px}
.dsh-mcp-skill-avatar-img.lg{width:42px;height:42px}
.dsh-mcp-skill-avatar-img.fallback{display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:650;color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dsh-mcp-skill-d-id{display:flex;align-items:flex-start;gap:10px;min-width:0}
.dsh-mcp-skill-d-id .dsh-mcp-skill-avatar.lg,.dsh-mcp-skill-d-id .dsh-mcp-skill-avatar-img.lg{margin-top:2px}
.dsh-mcp-onsite-avatar{width:24px;height:24px;border-radius:50%;corner-shape:round;object-fit:cover;flex:none;border:1px solid var(--mcp-line);font-size:11px}
.dsh-mcp-onsite-avatar.fallback{display:inline-flex;align-items:center;justify-content:center;font-weight:650;color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dsh-mcp-skill-card-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;font-size:13px;line-height:18px;color:var(--dsw-alias-label-primary)}
.dsh-mcp-skill-desc-none{color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-skill-cat-tag{color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:16px;white-space:nowrap}
.dsh-mcp-skill.on{box-shadow:inset 3px 0 0 var(--mcp-accent)}
.dsh-mcp-skill-d-badges{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:4px 0 0}
.dsh-mcp-skill-d-src{margin:3px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px;font-family:var(--mcp-mono);word-break:break-all}
.dsh-mcp-skill-d-meta{display:grid;grid-template-columns:auto minmax(0,1fr);gap:5px 14px;font-size:12px;word-break:break-all}
.dsh-mcp-skill-d-meta>span{color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-skill-d-meta>b{font-weight:400;color:var(--dsw-alias-label-primary);min-width:0}
.dsh-mcp-skill-d-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:2px}
.dsh-mcp-skill-d-flash{align-self:flex-start;padding:5px 12px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-state-success-bg,var(--mcp-bg-2));color:var(--dsw-alias-state-success-fg,var(--mcp-ok));font-size:12px;line-height:17px}
.dsh-mcp-skill-d-flash.err{background:var(--dsw-alias-state-danger-bg,var(--mcp-bg-2));color:var(--dsw-alias-state-danger-fg,var(--mcp-err))}
/* 主列画布：替代旧 340px 侧栏（旧 .dsh-mcp-skill-side 仍被 760px 媒体查询引用，保留无害）。 */
.dsh-mcp-skill-canvas{flex:1 1 auto;min-width:0;min-height:0;display:flex;flex-direction:column;gap:10px}
.dsh-mcp-skill-card-foot{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;min-width:0}.dsh-mcp-skill-card-foot .dsh-mcp-skill-sub{margin-left:auto}
.dsh-mcp-skill-card-foot .dsh-mcp-skill-src{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 详情栏 sticky（决策 3）：宿主页面是滚动容器，sticky 生效；被 760px 以下布局覆盖时自动失效。 */
.dsh-mcp-skill-detail{align-self:flex-start;position:sticky;top:16px;max-height:calc(100vh - 48px)}
/* 列表视图：整块只渲染一个列表面板，分类之间用分割线隔开（不再按来源拆成多个列表）。 */
.dsh-mcp-skill-divider{display:flex;align-items:center;gap:8px;padding:12px 2px 4px;font-size:11px;line-height:16px;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dsh-mcp-skill-divider:first-child{padding-top:2px}
.dsh-mcp-skill-divider-line{flex:1 1 auto;height:1px;min-width:12px;background:var(--mcp-line)}
.dsh-mcp-skill-divider-count{font-variant-numeric:tabular-nums}
/* 列表视图下详情栏加宽，并做成「选中前后尺寸不变」的固定框。
   抖动有三个来源，全部在这里掐掉：
   ① 原来写成 392→452 的二段宽度，选中瞬间整块横向重排一次；
   ② 高度由内容撑开（描述/元信息/指令正文字数各不相同），每次切换都收缩再展开；
   ③ position:sticky + top 在高度变化时反复重算吸附状态。
   现在宽度一次到位 452px，高度跟随左侧列表所在的 flex 行（align-self:stretch），
   内容只在自己内部滚动，外框不再参与重排。 */
@media (min-width:761px){
  .dsh-mcp-skill-body.list-mode .dsh-mcp-skill-detail{flex:0 0 452px;align-self:stretch;position:static;height:auto;max-height:calc(100vh - 48px)}
}
/* 网格视图不再占右侧详情栏：详情形内容整体浮成居中弹窗（与市场卡片详情同一套观感）。
   网格模式下未选中时那份「从左侧选择一个 skill」空态栏直接不占位，避免右侧留一条死白。 */
.dsh-mcp-skill-body:not(.list-mode) .dsh-mcp-skill-detail:not(.is-modal){display:none}
.dsh-mcp-skill-modal-hit{position:fixed;inset:0;background:var(--dsw-alias-bg-overlay);z-index:200;animation:mcpFade .14s ease-out}
.dsh-mcp-skill-detail.is-modal{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:min(760px,92vw);max-height:min(84vh,860px);overflow-y:auto;z-index:201;box-sizing:border-box;background:var(--mcp-bg-2);border:.5px solid var(--mcp-line);border-radius:var(--mcp-r-panel);box-shadow:var(--dsw-elevation-prominent);padding:20px;align-self:auto;animation:skillModalIn .16s ease-out}
/* 不能用现成的 mcpPop：它的关键帧自带 scale/translateY，会把居中的 translate(-50%,-50%) 覆盖掉，
   动画期间弹窗会先跑到右下再跳回来。这里把居中的位移写进关键帧，缩放入场才不会破位。 */
@keyframes skillModalIn{from{opacity:0;transform:translate(-50%,-50%) scale(.965)}to{opacity:1;transform:translate(-50%,-50%) scale(1)}}
.dsh-mcp-skill-detail.is-modal .dsh-mcp-skill-d-title{overflow-wrap:anywhere}
.dsh-mcp-skill-detail.dsh-mcp-skill-detail.is-modal .dsh-mcp-skill-d-head{position:static;top:auto}
.dsh-mcp-skill-d-close{position:absolute;top:12px;right:12px;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-sm);background:var(--dsw-alias-button-elevated-fill);color:var(--mcp-mut);cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.dsh-mcp-skill-d-close:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
@media (max-width:760px){.dsh-mcp-skill-content{overflow:visible;max-height:none}.dsh-mcp-skill-toolbar{flex-wrap:wrap}.dsh-mcp-skill-search{flex:1 1 160px}.dsh-mcp-skill-detail{position:static;max-height:none;align-self:stretch}}

/* ══ 自定义套件（看板工具条入口 + 召唤菜单套件分组 + 套件管理弹窗）═══════════════════
   度量取自 docs/design-suites-mockup.html（局部 A/B/C），类名沿用 mockup 的 suite-* 命名，
   只有两处刻意改名：mockup 的 .pick-card → .suite-pick-card（看板里 pick 另有含义），
   mockup 的 header/.x/.sub → .suite-head/.suite-x/.suite-head-text（弹窗里要能定位到类，
   元素选择器太宽，会把宿主注入的任何 header/h3 一起带走）。
   只用宿主 --dsw-* 与本插件已有的 --mcp-* 令牌，不新增自定义属性；阴影一律带回落值
   （--dsw-elevation-card 在本仓库从未用过，不能假定宿主一定提供）。
   短类名（.nm/.cat/.tile/.grip/.idx/.rm…）一律带父级前缀，避免日后与别的组件撞名。 */
.dsh-mcp-btn.suite-entry{flex:none}
.dsh-mcp-btn.suite-entry .cnt{padding:0 5px;border-radius:var(--mcp-r-xs);background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-brand-text);font-size:10.5px;line-height:15px;font-variant-numeric:tabular-nums}
.dsh-mcp-btn.suite-entry:hover .cnt{background:var(--mcp-accent);color:var(--dsw-alias-label-primary-inverted)}
/* 召唤菜单：套件分组头 + 分隔线 + 条目前的 accent 图标（只有套件条目带图标——
   技能/MCP/专家条目保持原样，避免一次改动三个子菜单的既有观感）。 */
.dsh-mcp-quick-group{display:flex;align-items:center;gap:6px;flex:none;padding:5px 9px 3px;color:var(--dsw-alias-label-tertiary);font-size:10.5px;line-height:14px;letter-spacing:.05em}
.dsh-mcp-quick-group svg{flex:none;color:var(--mcp-accent)}
.dsh-mcp-quick-sep{height:1px;flex:none;margin:4px 6px;background:var(--mcp-line)}
/* 条目行是 align-items:baseline（文字与徽章按基线对齐），图标不参与基线：
    alignSelf:center 让它在 28px 固定行高里正中，不会被 svg 的下沿顶偏。 */
.dsh-mcp-quick-item .ic{flex:none;align-self:center;display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-quick-item.suite .ic{color:var(--mcp-accent)}
.dsh-mcp-quick-sub .dsh-mcp-quick-manage{gap:6px}
.dsh-mcp-quick-manage .ic{flex:none;display:inline-flex;align-items:center}
/* 两条页脚按钮叠着时（管理技能… / 管理套件…），第二条不再自带 4px 上边距：
   否则分割线会浮在空隙中间，看着像渲染错位。 */
.dsh-mcp-quick-manage+.dsh-mcp-quick-manage{margin-top:0}
/* 弹窗本体：把基类 .dsh-mcp-modal 的 560px/20px 内边距/纵向滚动整体换掉——
   套件弹窗是「左右两栏各自滚动」，外层必须 overflow:hidden 才不会出现双滚动条。 */
.dsh-mcp-modal.suites{display:flex;flex-direction:column;width:min(980px,94vw);max-width:94vw;height:min(640px,88vh);max-height:88vh;padding:0;overflow:hidden}
.suite-head{display:flex;align-items:flex-start;gap:10px;flex:none;padding:16px 18px 12px;border-bottom:1px solid var(--mcp-line);background:var(--mcp-bg-1)}
.suite-head-text{min-width:0}
.suite-head h3{display:flex;align-items:center;gap:8px;margin:0;font-size:15px;font-weight:650;line-height:20px;color:var(--dsw-alias-label-primary)}
.suite-head h3::before{content:"";flex:none;width:4px;height:14px;border-radius:2px;background:var(--mcp-accent)}
.suite-head .sub{margin:5px 0 0 12px;font-size:11.5px;line-height:17px;color:var(--mcp-mut)}
/* 关闭按钮不用 .dsh-mcp-skill-d-close：那个是 position:absolute（贴详情面板的角），
   放进 flex 头部会脱离文档流、盖住副标题。 */
.suite-x{display:inline-flex;align-items:center;justify-content:center;flex:none;width:26px;height:26px;margin-left:auto;padding:0;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-sm);background:var(--dsw-alias-button-elevated-fill);color:var(--mcp-mut);cursor:pointer;transition:background .15s,border-color .15s,color .15s}
.suite-x:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.suite-x:disabled{opacity:.5;cursor:default}
.suite-x:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:1px}
.suite-body{flex:1;min-height:0;display:grid;grid-template-columns:minmax(320px,44%) 1fr}
/* ── 左：技能库选择器 ──────────────────────────────────────────────── */
.suite-left{display:flex;flex-direction:column;gap:9px;min-height:0;padding:13px 14px;border-right:1px solid var(--mcp-line);background:var(--mcp-bg-2)}
/* 搜索框不复用 .dsh-mcp-skill-search：看板那条已补齐自己的完整样式（图标内嵌 + 清空按钮），
   但它是工具条场景的尺寸与交互；弹窗这边保留独立一份，两处后续调整互不牵连。 */
.suite-search{position:relative;display:flex;align-items:center;flex:none;height:30px}
.suite-search svg{position:absolute;top:50%;left:9px;transform:translateY(-50%);pointer-events:none;color:var(--mcp-mut)}
.suite-search input{box-sizing:border-box;width:100%;height:30px;padding:0 10px 0 28px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;outline:0;transition:border-color .15s,box-shadow .15s}
.suite-search input::placeholder{color:var(--mcp-mut)}
.suite-search input:focus{border-color:var(--mcp-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--mcp-accent) 14%,transparent)}
/* 分类轨道在弹窗里更窄，chips 收一号才放得下 6 个。 */
.suite-left .dsh-mcp-skill-rail{gap:5px}
.suite-left .dsh-mcp-skill-cat{padding:2px 9px;font-size:11px;line-height:17px}
.suite-pick-list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:7px;padding:2px 2px 6px;scrollbar-width:thin}
.suite-pick-card{position:relative;display:flex;align-items:flex-start;gap:9px;padding:9px 26px 9px 10px;border:.5px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1);cursor:grab;transition:border-color .12s,background .12s,box-shadow .14s,opacity .12s}
.suite-pick-card:hover{border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover);box-shadow:var(--dsw-elevation-overlay,0 1px 3px rgba(0,0,0,.1))}
.suite-pick-card:active{cursor:grabbing}
.suite-pick-card.dragging{opacity:.45;border-style:dashed}
.suite-pick-card.in-suite{border-color:color-mix(in srgb,var(--mcp-accent) 45%,var(--mcp-line));background:var(--dsw-alias-interactive-bg-hover-accent)}
.suite-pick-card .tile{flex:none;width:10px;height:10px;margin-top:3px;border-radius:3px}
.suite-pick-card .body{min-width:0;flex:1}
.suite-pick-card .nm{display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:550;line-height:18px;color:var(--dsw-alias-label-primary)}
.suite-pick-card .nm .cat{font-size:10.5px;font-weight:400;color:var(--dsw-alias-label-tertiary)}
.suite-pick-card .ds{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;margin:2px 0 0;font-size:11px;line-height:1.5;color:var(--mcp-mut)}
.suite-pick-card .grip{flex:none;margin-top:2px;color:var(--dsw-alias-label-tertiary);opacity:.55}
.suite-pick-card:hover .grip{opacity:1}
/* + 是无拖拽的替代路径：平时藏着（hover / 键盘聚焦才现形），已在套件里则常亮成 ✓。 */
.suite-pick-card .add{position:absolute;top:7px;right:7px;display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:1px solid var(--mcp-line);border-radius:7px;background:var(--mcp-bg-1);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;cursor:pointer;opacity:0;transition:opacity .12s,background .12s,border-color .12s,color .12s}
.suite-pick-card:hover .add,.suite-pick-card:focus-within .add{opacity:1}
.suite-pick-card .add:hover{background:var(--mcp-accent);border-color:var(--mcp-accent);color:var(--dsw-alias-label-primary-inverted)}
.suite-pick-card .add:disabled{cursor:default}
.suite-pick-card.in-suite .add{opacity:1;border-color:color-mix(in srgb,var(--mcp-accent) 40%,var(--mcp-line));color:var(--mcp-accent)}
/* ── 右：套件列表 + 编辑器 ─────────────────────────────────────────── */
.suite-right{display:flex;flex-direction:column;min-height:0;background:var(--mcp-bg-1)}
.suite-list-bar{display:flex;align-items:center;gap:8px;flex:none;padding:11px 14px 9px;border-bottom:1px solid var(--mcp-line)}
.suite-list-bar .t{font-size:12px;font-weight:650;color:var(--dsw-alias-label-secondary)}
.suite-list-bar .sp{flex:1}
.dsh-mcp-btn.suite-new{padding:4px 10px;font-size:11.5px}
.suite-list{display:flex;flex-direction:column;gap:4px;flex:none;max-height:132px;overflow-y:auto;padding:8px 10px;border-bottom:1px solid var(--mcp-line);background:var(--mcp-bg-2);scrollbar-width:thin}
/* div[role=button] 而不是 <button>：行内还要放「删除」按钮，button 套 button 是无效 HTML。
   所以这里得把 button 的默认外观一条条抹平（font/border/background/text-align）。 */
.suite-row{display:flex;align-items:center;gap:8px;width:100%;padding:7px 9px;border:1px solid transparent;border-radius:var(--mcp-r-md);background:transparent;font-family:inherit;font-size:12.5px;text-align:left;cursor:pointer;transition:background .12s,border-color .12s}
.suite-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.suite-row.on{border-color:color-mix(in srgb,var(--mcp-accent) 40%,transparent);background:var(--dsw-alias-interactive-bg-hover-accent)}
.suite-row:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:1px}
.suite-row .ic{flex:none;display:inline-flex;align-items:center;color:var(--mcp-accent)}
.suite-row .nm{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px;font-weight:550;color:var(--dsw-alias-label-primary)}
/* 成员色点叠成一摞：一眼看出这套件里都是哪几类技能（最多 4 个，见 slice(0,4)）。 */
.suite-row .stack{display:inline-flex;flex:none}
.suite-row .stack i{width:9px;height:9px;margin-left:-3px;border:1.5px solid var(--mcp-bg-2);border-radius:3px}
.suite-row .stack i:first-child{margin-left:0}
.suite-row .ct{flex:none;font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
/* 删除是两步确认（点一次变红写「确认?」，2.6s 内再点才真删）：平时藏起来，
   hover 或已武装时常显；武装态用实底红，让「再点一次就没了」这件事不可能被忽略。 */
.suite-row .del{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:10.5px;cursor:pointer;opacity:0;transition:opacity .12s,background .12s,color .12s}
.suite-row:hover .del,.suite-row .del:focus-visible,.suite-row .del.arm{opacity:1}
.suite-row .del:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--mcp-err)}
.suite-row .del.arm{width:auto;padding:0 7px;background:var(--mcp-err);color:var(--dsw-alias-label-primary-inverted);font-weight:600}
.suite-editor{display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;padding:12px 14px 14px}
.suite-editor .fields{display:grid;grid-template-columns:1fr;gap:8px;flex:none}
.field label{display:block;margin-bottom:4px;font-size:10.5px;letter-spacing:.03em;color:var(--dsw-alias-label-tertiary)}
.field input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-sm);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12.5px;outline:0;transition:border-color .15s,box-shadow .15s}
.field input::placeholder{color:var(--mcp-mut)}
.field input:focus{border-color:var(--mcp-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--mcp-accent) 14%,transparent)}
/* 成员区：虚线框表达「往这里放东西」，拖拽悬停时整块变 accent 底。 */
.member-zone{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;border:1.5px dashed var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-2);transition:border-color .14s,background .14s}
.member-zone.over{border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent)}
.member-zone .zh{display:flex;align-items:center;gap:7px;flex:none;padding:8px 11px;border-bottom:1px dashed var(--mcp-line);font-size:11px;color:var(--dsw-alias-label-tertiary)}
.member-zone .zh svg{flex:none;color:var(--mcp-accent)}
.member-zone .zh b{font-weight:600;color:var(--dsw-alias-label-secondary)}
.member-list{display:flex;flex-direction:column;gap:5px;flex:1;min-height:0;overflow-y:auto;padding:7px;scrollbar-width:thin}
.member-row{display:flex;align-items:center;gap:8px;padding:7px 9px;border:.5px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1);cursor:grab;transition:border-color .12s,box-shadow .12s,opacity .12s}
.member-row:hover{border-color:var(--dsw-alias-border-l3);box-shadow:var(--dsw-elevation-overlay,0 1px 3px rgba(0,0,0,.1))}
.member-row.dragging{opacity:.4}
.member-row .idx{flex:none;width:16px;text-align:center;font-size:10px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.member-row .grip{flex:none;display:inline-flex;align-items:center;color:var(--dsw-alias-label-tertiary);opacity:.6}
.member-row .tile{flex:none;width:9px;height:9px;border-radius:3px}
.member-row .nm{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;font-weight:550;color:var(--dsw-alias-label-primary)}
.member-row .cat{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary)}
/* 宿主注册表里查不到的成员：不删（用户可能只是切了作用域），但如实标成警示色。 */
.member-row .cat.gone{color:var(--mcp-warn)}
.member-row .rm{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;transition:background .12s,color .12s}
.member-row .rm:hover{background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--mcp-err)}
/* 拖拽插入指示线：普通行元素而不是独立浮层，成员区因此始终只有一个滚动容器。 */
.drop-line{flex:none;height:2px;margin:1px 4px;border-radius:1px;background:var(--mcp-accent)}
.member-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;flex:1;padding:22px;color:var(--dsw-alias-label-tertiary);font-size:11.5px;line-height:17px;text-align:center}
.member-empty .big{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:14px;background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--mcp-accent)}
/* ── 弹窗底栏 ─────────────────────────────────────────────────────── */
.suite-foot{display:flex;align-items:center;gap:10px;flex:none;padding:11px 16px;border-top:1px solid var(--mcp-line);background:var(--mcp-bg-1)}
.suite-foot .hint{display:flex;align-items:center;gap:6px;min-width:0;flex:1;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.suite-foot .hint svg{flex:none}
/* 保存失败与「未保存」互斥显示：失败是阻断信息（红），未保存只是状态提示（橙）。 */
.suite-foot .err{flex:none;max-width:44%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--mcp-err)}
.suite-foot .dirty{display:inline-flex;align-items:center;gap:5px;flex:none;font-size:11px;color:var(--mcp-warn)}
.suite-foot .dirty i{width:6px;height:6px;border-radius:50%;background:var(--mcp-warn)}
@media (max-width:900px){.suite-body{grid-template-columns:1fr}.suite-left{max-height:260px;border-right:0;border-bottom:1px solid var(--mcp-line)}.suite-foot .hint{display:none}}

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
/* 账本缓存占用行（只读读数，贴在工具条下方）。行内清空按钮已于 2026-10-23 删除，见
   lib/client.js 里 cacheLine 的注释；这条只剩文本，所以配套的 .cache-clear 规则一并删掉。 */
.dsh-mcp-tailor-cache{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11.5px;line-height:16px;color:var(--mcp-mut);padding:2px 2px 0;flex:none}
.dsh-mcp-tailor-cache-label{color:var(--dsw-alias-label-tertiary)}
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

/* ══ 优化项落地（armory-优化项.md 全量）═════════════════════════════════════
   本节只做「信息层级 + 交互反馈 + 状态语义」三件事，视觉全部走宿主语义令牌：
   实底 surface、1px 描边、--mcp-r-* 圆角、--dsw-elevation-* 阴影，不自造颜色与渐变。
   四色状态语义（§1.3，全局唯一口径）：
     蓝 --mcp-accent = 交互/可选（不是"正常"）  绿 --mcp-ok   = 健康/已连接
     橙 --mcp-warn   = 注意/降级（含"不兼容"）   红 --mcp-err  = 破坏性/失败
   ─────────────────────────────────────────────────────────────────────────── */

/* ── §1.1 顶栏分类 chip：hover 摘要浮层 + 异常红点 ───────────────────────── */
.dsh-mcp-cats{position:relative}
.dsh-mcp-cat{position:relative;min-width:0;flex:none;white-space:nowrap}
.dsh-mcp-cat:disabled{cursor:default;opacity:.6}
/* 红点只给"需要注意"的分类，用绝对定位贴 chip 右上角，不参与布局、不影响宽度 */
.dsh-mcp-cat-alert{position:absolute;top:3px;right:3px;box-sizing:border-box;width:6px;height:6px;border-radius:50%;background:var(--mcp-err);box-shadow:0 0 0 2px var(--dsw-alias-bg-base);corner-shape:round;pointer-events:none}
.dsh-mcp-cat-alert.warn{background:var(--mcp-warn)}
/* hover 摘要：贴住 chip 下方的实底白卡，标题+两三行事实清单，不抢正文焦点 */
.dsh-mcp-cat-pop{position:absolute;top:calc(100% + 6px);left:0;z-index:70;box-sizing:border-box;min-width:216px;max-width:300px;padding:9px 11px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-1);box-shadow:var(--dsw-elevation-panel);display:flex;flex-direction:column;gap:6px;pointer-events:none;animation:mcpFade .1s ease-out}
.dsh-mcp-cat-pop> b{font-size:12px;font-weight:650;color:var(--dsw-alias-label-primary)}
.dsh-mcp-cat-pop> span{font-size:11.5px;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.dsh-mcp-cat-pop-facts{display:flex;flex-direction:column;gap:3px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dsh-mcp-cat-pop-facts i{font-style:normal;color:var(--dsw-alias-label-tertiary);margin-right:5px}
.dsh-mcp-cat-pop-facts b{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-weight:600}
.dsh-mcp-cat-pop-foot{font-size:10.5px;color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--mcp-line);padding-top:5px}

/* §1.2 作用域分段控件的样式只在下方声明一次（勿在此重复插入）。 */

/* ── §1.4 空状态四件套：图标 + 一句结论 + 一句原因 + 一个主操作 ───────────────── */
.dsh-mcp-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;padding:34px 20px;text-align:center;color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-empty-ico{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;width:40px;height:40px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-2);color:var(--dsw-alias-label-tertiary);margin-bottom:2px}
.dsh-mcp-empty-ico.warn{color:var(--mcp-warn);border-color:color-mix(in srgb,var(--mcp-warn) 40%,transparent);background:var(--dsw-alias-state-warn-tertiary)}
.dsh-mcp-empty-ico.err{color:var(--mcp-err);border-color:color-mix(in srgb,var(--mcp-err) 40%,transparent);background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsh-mcp-empty>b{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);line-height:1.5}
.dsh-mcp-empty>span{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);max-width:min(440px,100%)}
.dsh-mcp-empty-act{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center;margin-top:5px}
.dsh-mcp-empty.tight{padding:18px 12px}
.dsh-mcp-empty.tight .dsh-mcp-empty-ico{width:32px;height:32px}

/* ── §1.5 Ctrl+K 命令面板：一个输入框 + 分组结果 + ↑↓↵ 操作 ───────────────── */
.dsh-mcp-cmdk-overlay{position:fixed;inset:0;z-index:320;background:var(--dsw-alias-bg-overlay);display:flex;align-items:flex-start;justify-content:center;padding:min(14vh,120px) 16px 16px;animation:mcpFade .12s ease-out}
.dsh-mcp-cmdk{box-sizing:border-box;width:min(620px,96vw);max-height:min(60vh,520px);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-panel);background:var(--mcp-bg-1);box-shadow:var(--dsw-elevation-prominent);animation:mcpPop .14s cubic-bezier(.2,.9,.3,1.1)}
.dsh-mcp-cmdk-head{display:flex;align-items:center;gap:9px;flex:none;padding:11px 14px;border-bottom:1px solid var(--mcp-line)}
.dsh-mcp-cmdk-head svg{flex:none;opacity:.55}
.dsh-mcp-cmdk-input{flex:1;min-width:0;box-sizing:border-box;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13.5px;outline:none;padding:0}
.dsh-mcp-cmdk-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-cmdk-kbd{flex:none;font-family:var(--mcp-mono);font-size:10.5px;color:var(--dsw-alias-label-tertiary);border:1px solid var(--mcp-line);border-radius:var(--mcp-r-xs);padding:1px 5px;line-height:15px}
.dsh-mcp-cmdk-list{flex:1 1 auto;min-height:0;overflow-y:auto;padding:5px}
.dsh-mcp-cmdk-group{font-size:10.5px;font-weight:650;text-transform:uppercase;letter-spacing:.6px;color:var(--dsw-alias-label-tertiary);padding:7px 9px 4px}
.dsh-mcp-cmdk-item{box-sizing:border-box;display:flex;align-items:center;gap:9px;width:100%;padding:7px 10px;border:1px solid transparent;border-radius:var(--mcp-r-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:18px;text-align:left;cursor:pointer;transition:background .1s}
.dsh-mcp-cmdk-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-cmdk-item.on{border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dsh-mcp-cmdk-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.dsh-mcp-cmdk-item-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mcp-cmdk-item-desc{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-mcp-cmdk-item-hint{flex:none;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-cmdk-foot{flex:none;display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:7px 14px;border-top:1px solid var(--mcp-line);background:var(--mcp-bg-2);font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-cmdk-foot b{font-family:var(--mcp-mono);font-weight:500;color:var(--dsw-alias-label-secondary)}

/* ── §2.1 列表行体量标记：让「170 个工具」和「20 个工具」不再视觉等重 ─────────── */
/* 刻意做得比 Badge 更轻（无边框、灰底、小一号）：它是量级注脚，不该和状态徽章抢注意力。 */
.dsh-mcp-tag-heavy{flex:none;display:inline-flex;align-items:center;padding:0 5px;border-radius:var(--mcp-r-xs);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:9.5px;font-weight:600;line-height:14px;letter-spacing:.2px;white-space:nowrap}

/* ── §2.3 参数 chips：先看「几个」，再看「哪个被脱敏」 ──────────────────────── */
.dsh-mcp-args{display:flex;flex-wrap:wrap;align-items:center;gap:4px}
.dsh-mcp-args-count{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsh-mcp-args-note{font-size:10px;padding:0 5px;border-radius:var(--mcp-r-xs);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);line-height:15px}
.dsh-mcp-arg-chip{font-family:var(--mcp-mono);font-size:11px;padding:1px 6px;border-radius:var(--mcp-r-xs);background:var(--mcp-bg-3);color:var(--dsw-alias-label-primary);max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* 脱敏 chip 用虚线描边而不是换色：颜色已经归状态语义用，不再兼职表达「保密」。 */
.dsh-mcp-arg-chip.masked{border:1px dashed var(--mcp-line);background:transparent;color:var(--dsw-alias-label-secondary);letter-spacing:1px}

/* ── §2.4 连接健康条：把四个最常被问到的结论提到最上层 ──────────────────────── */
.dsh-mcp-health{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:10px}
.dsh-mcp-health-cell{display:flex;flex-direction:column;gap:2px;padding:8px 10px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1)}
.dsh-mcp-health-cell>span{font-size:10.5px;color:var(--dsw-alias-label-secondary);letter-spacing:.2px}
.dsh-mcp-health-cell>b{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsh-mcp-health-cell>b.ok{color:var(--mcp-ok)}
.dsh-mcp-health-cell>b.warn{color:var(--mcp-warn)}
.dsh-mcp-health-cell>b.err{color:var(--mcp-err)}
.dsh-mcp-health-cell>b.mute{color:var(--dsw-alias-label-secondary);font-weight:500}

/* ── §2.2 工具区：搜索条 / 折叠摘要 / 热度数字 ──────────────────────────────── */
.dsh-mcp-tools-bar{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.dsh-mcp-tools-bar .dsh-mcp-search{flex:1;margin:0}
.dsh-mcp-tools-count{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-mcp-tools-collapsed{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 12px;border:1px dashed var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-2);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsh-mcp-tools-collapse-back{margin-top:8px}
.dsh-mcp-tool-usage{flex:none;font-size:10.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsh-mcp-tool-usage.mute{opacity:.72}
.dsh-mcp-tool-usage.bad{color:var(--mcp-err)}

/* ── §1.1 分类摘要浮层：白底描边，与宿主浮层同一套语言 ──────────────────────── */
.dsh-mcp-cat-pop{position:absolute;top:calc(100% + 6px);z-index:60;width:250px;padding:10px 12px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-1);box-shadow:var(--dsw-shadow-popover,0 8px 24px rgba(16,32,48,.12));pointer-events:none;display:flex;flex-direction:column;gap:4px}
.dsh-mcp-cat-pop>b{font-size:12.5px;color:var(--dsw-alias-label-primary)}
.dsh-mcp-cat-pop>span{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary)}
.dsh-mcp-cat-pop-facts{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:2px}
.dsh-mcp-cat-pop-facts>div{display:flex;align-items:baseline;gap:4px}
.dsh-mcp-cat-pop-facts i{font-style:normal;font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.dsh-mcp-cat-pop-facts b{font-size:12.5px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.dsh-mcp-cat-pop-foot{margin-top:2px;padding-top:6px;border-top:1px solid var(--mcp-line);font-size:10.5px;color:var(--dsw-alias-label-secondary)}
/* 分类条需要成为浮层的定位参照，否则浮层会贴到最近的定位祖先上去。 */
.dsh-mcp-cats{position:relative}
/* 异常红点：绝对定位在 chip 右上角，不占据 flex 布局空间（否则切换有无异常时 chip 会抖动）。 */
.dsh-mcp-cat{position:relative}
.dsh-mcp-cat-alert{position:absolute;top:2px;right:2px;width:6px;height:6px;border-radius:999px;background:var(--mcp-err)}
.dsh-mcp-cat-alert.warn{background:var(--mcp-warn)}

/* ── §1.2 作用域分段控件：连体分段，当前项实底反白 ──────────────────────────── */
.dsh-mcp-seg{display:inline-flex;align-items:stretch;gap:2px;padding:2px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-2);overflow-x:auto;max-width:100%;scrollbar-width:none}
.dsh-mcp-seg::-webkit-scrollbar{display:none}
.dsh-mcp-seg-item{flex:none;white-space:nowrap;display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border:0;border-radius:var(--mcp-r-md);background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;font-family:inherit;cursor:pointer;transition:background 120ms ease,color 120ms ease}
.dsh-mcp-seg-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-mcp-seg-item[aria-selected="true"]{background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(16,32,48,.08)}
.dsh-mcp-seg-count{font-size:10px;padding:0 4px;border-radius:var(--mcp-r-xs);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);line-height:14px;font-variant-numeric:tabular-nums;white-space:nowrap;flex:0 0 auto}
.dsh-mcp-seg-item[aria-selected="true"] .dsh-mcp-seg-count{background:var(--mcp-accent);color:var(--dsw-alias-label-on-brand,#fff)}
.dsh-mcp-seg-item:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:-1px}
@media (prefers-reduced-motion:reduce){.dsh-mcp-seg-item{transition:none}}

/* ── §2.2 工具清单：搜索 + 滚动容器 + 热度色条 ─────────────────────────────── */
.dsh-mcp-tools-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin-bottom:9px}
.dsh-mcp-tools-head h4{margin:0!important;flex:0 0 auto}
.dsh-mcp-tools-head h4::after{display:none!important}
.dsh-mcp-tools-search{position:relative;flex:1 1 160px;min-width:130px;max-width:260px;margin-left:auto}
.dsh-mcp-tools-search svg{position:absolute;left:8px;top:50%;transform:translateY(-50%);opacity:.45;pointer-events:none}
.dsh-mcp-tools-search input{width:100%;box-sizing:border-box;padding:5px 9px 5px 26px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-sm);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;outline:none;transition:border-color .13s}
.dsh-mcp-tools-search input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-tools-search input:focus{border-color:var(--mcp-accent)}
.dsh-mcp-tools-count{flex:none;font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dsh-mcp-tools-scroll{max-height:min(52vh,460px);overflow-y:auto;overscroll-behavior:contain}
/* 热度色条：调用次数分四档（0/低/中/高），宽度按占比，0 档只留一条灰线 */
.dsh-mcp-heat{flex:none;position:relative;width:34px;height:4px;border-radius:999px;background:var(--mcp-line);overflow:hidden;corner-shape:round}
.dsh-mcp-heat>i{position:absolute;inset:0 auto 0 0;border-radius:999px;background:var(--dsw-alias-label-tertiary)}
.dsh-mcp-heat.lv1>i{background:color-mix(in srgb,var(--mcp-accent) 45%,transparent)}
.dsh-mcp-heat.lv2>i{background:var(--mcp-accent)}
.dsh-mcp-heat.lv3>i{background:var(--mcp-accent)}
.dsh-mcp-heat-num{flex:none;font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;min-width:26px;text-align:right}

/* ── §2.4 连接健康条：对/错一眼分明，不靠日志去猜 ───────────────────────────── */
.dsh-mcp-health{display:flex;align-items:stretch;gap:0;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1);overflow:hidden}
.dsh-mcp-health-cell{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:2px;padding:8px 11px;border-left:1px solid var(--mcp-line)}
.dsh-mcp-health-cell:first-child{border-left:0}
.dsh-mcp-health-cell>span{font-size:10.5px;color:var(--dsw-alias-label-tertiary);line-height:15px}
.dsh-mcp-health-cell>b{font-size:12.5px;font-weight:600;line-height:17px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-mcp-health-cell>b.ok{color:var(--dsw-alias-state-success-primary)}
.dsh-mcp-health-cell>b.err{color:var(--mcp-err)}
.dsh-mcp-health-cell>b.warn{color:var(--dsw-alias-state-warn-primary)}
.dsh-mcp-health-cell>b.mute{color:var(--dsw-alias-label-tertiary)}
/* §2.1 连接诊断（OPT-28）：诊断卡的标题行、读数着色与动作行。 */
.dsh-mcp-diag-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}
.dsh-mcp-diag-head>h4{margin:0}
.dsh-mcp-diag-refresh{font-size:11.5px;line-height:1;padding:4px 8px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.dsh-mcp-diag-refresh:hover:not(:disabled){color:var(--dsw-alias-label-primary)}
.dsh-mcp-diag-refresh:disabled{opacity:.55;cursor:default}
.dsh-mcp-diag-note{font-size:11.5px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-diag-bad{color:var(--mcp-err)}
.dsh-mcp-diag-ok{color:var(--dsw-alias-state-success-primary)}
.dsh-mcp-diag-acts{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}
.dsh-mcp-diag-act{font-size:12px;padding:4px 10px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);cursor:pointer}
.dsh-mcp-diag-act:hover:not(:disabled){border-color:var(--dsw-alias-label-secondary)}
.dsh-mcp-diag-act:disabled{opacity:.55;cursor:default}

/* ── §5 工具裁缝：主指标 hero + 列重排 + sticky 首列 + 行尾 ⋯ 菜单 + sparkline ── */
.dsh-mcp-tailor-hero{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:10px;flex:none;align-items:stretch}
.dsh-mcp-tailor-main{display:flex;flex-direction:column;gap:2px;justify-content:center;padding:13px 16px;border:1px solid color-mix(in srgb,var(--mcp-accent) 30%,transparent);border-radius:var(--mcp-r-lg);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dsh-mcp-tailor-main>b{font-size:31px;font-weight:650;line-height:36px;letter-spacing:-.6px;color:var(--dsw-alias-brand-text);font-variant-numeric:tabular-nums;word-break:break-word}
.dsh-mcp-tailor-main>b em{font-size:13px;font-weight:500;font-style:normal;letter-spacing:0;color:var(--dsw-alias-label-secondary);margin-left:5px}
.dsh-mcp-tailor-main>span{font-size:11px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;color:var(--dsw-alias-brand-text)}
.dsh-mcp-tailor-main>span.dsh-mcp-tailor-main-sub{font-size:11.5px;font-weight:400;letter-spacing:0;text-transform:none;line-height:1.55;color:var(--dsw-alias-label-secondary)}
.dsh-mcp-tailor-trend{display:flex;align-items:center;gap:7px;margin-top:6px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-tailor-trend .dsh-mcp-spark{height:16px}
.dsh-mcp-tailor-kpis{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
.dsh-mcp-tailor-kpi{box-sizing:border-box;display:flex;flex-direction:column;gap:2px;justify-content:center;padding:9px 12px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-2);font:inherit;text-align:left}
.dsh-mcp-tailor-kpi>b{font-size:17px;font-weight:600;line-height:21px;font-variant-numeric:tabular-nums}
.dsh-mcp-tailor-kpi>span{font-size:10.5px;line-height:1.45;color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-tailor-kpi.dead>b{color:var(--dsw-alias-state-warn-primary)}
.dsh-mcp-tailor-kpi.err>b{color:var(--mcp-err)}
.dsh-mcp-tailor-kpi.ok>b{color:var(--dsw-alias-state-success-primary)}
.dsh-mcp-tailor-kpi.clickable{cursor:pointer;transition:background .12s,border-color .12s}
.dsh-mcp-tailor-kpi.clickable:hover{border-color:color-mix(in srgb,var(--mcp-warn) 55%,transparent);background:color-mix(in srgb,var(--mcp-warn) 8%,var(--mcp-bg-2))}
.dsh-mcp-tailor-kpi.clickable[aria-pressed="true"]{border-color:var(--mcp-warn);background:color-mix(in srgb,var(--mcp-warn) 13%,var(--mcp-bg-2))}
.dsh-mcp-tailor-kpi.clickable:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:1px}
@media (max-width:900px){.dsh-mcp-tailor-hero{grid-template-columns:minmax(0,1fr)}}
/* 账本表格：首列 sticky 不随横向滚动跑掉；行尾 ⋯ 打开操作菜单 */
.dsh-mcp-tailor-table{overflow-x:auto}
.dsh-mcp-tailor-row{grid-template-columns:minmax(180px,1.6fr) 88px 118px 96px minmax(96px,.8fr) 30px;gap:9px;padding:7px 12px;align-items:center}
.dsh-mcp-tailor-row.head{padding:8px 12px}
.dsh-mcp-tailor-row .t-num{text-align:right;justify-self:end;font-variant-numeric:tabular-nums}
.dsh-mcp-tailor-row .t-num.bad{color:var(--mcp-err)}
.dsh-mcp-tailor-row .t-tax{text-align:right;justify-self:end;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dsh-mcp-tailor-row .t-op{justify-self:end;display:flex;justify-content:flex-end}
.dsh-mcp-tailor-row .t-name{position:sticky;left:0;z-index:1;background:inherit;padding-right:6px}
.dsh-mcp-tailor-row.head .t-name{background:var(--mcp-bg-2)}
.dsh-mcp-tailor-row:not(.head):hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-tailor-row.dead:not(.head):hover{background:color-mix(in srgb,var(--mcp-warn) 12%,transparent)}
/* ── §7.1 技能行行内禁用/释放按钮 ─────────────────────────────────────────── */
/* 技能行尾列放的是文字按钮（禁用/释放），比工具行的 24px ⋯ 菜单宽：只对技能表放宽
   尾列（.skills 修饰类），工具表保持 30px 不动。 */
.dsh-mcp-tailor-table.skills .dsh-mcp-tailor-row{grid-template-columns:minmax(180px,1.6fr) 88px 118px 96px minmax(96px,.8fr) 52px}
.dsh-mcp-tailor-op{box-sizing:border-box;white-space:nowrap;padding:3px 9px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-sm);background:var(--mcp-bg-2);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:16px;cursor:pointer;transition:color .12s,border-color .12s,background .12s}
.dsh-mcp-tailor-op:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-tailor-op:disabled{opacity:.55;cursor:default}
.dsh-mcp-tailor-op.release{color:var(--dsw-alias-state-success-primary)}
.dsh-mcp-tailor-op.release:hover:not(:disabled){border-color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-tailor-op:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:-1px}
/* 禁用行：名字弱化，与 .dead 的「零调用」底色语义分开（禁用是主动态，不是数据缺失）。 */
.dsh-mcp-tailor-row.off:not(.head) .t-name{color:var(--dsw-alias-label-tertiary)}
/* sparkline：7 段柱状，高度按窗口内分布归一，纯装饰不可交互 */
.dsh-mcp-spark{display:inline-flex;align-items:flex-end;gap:1.5px;height:14px;flex:none;vertical-align:-2px}
.dsh-mcp-spark>i{display:block;width:2.5px;min-height:1.5px;border-radius:.5px;background:var(--dsw-alias-label-tertiary);opacity:.55}
.dsh-mcp-spark>i.hot{background:var(--mcp-accent);opacity:1}
/* 行尾 ⋯ 菜单：与 ScopeTabs 的 more 弹层同构，实底 + elevation */
.dsh-mcp-rowmenu{position:relative;justify-self:end}
.dsh-mcp-rowmenu-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:1px solid transparent;border-radius:var(--mcp-r-sm);background:transparent;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1;cursor:pointer;transition:background .12s,color .12s,border-color .12s}
.dsh-mcp-rowmenu-btn:hover,.dsh-mcp-rowmenu-btn[aria-expanded="true"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border-color:var(--mcp-line)}
.dsh-mcp-rowmenu-btn:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:-1px}
.dsh-mcp-rowmenu-pop{position:absolute;top:calc(100% + 4px);right:0;z-index:60;box-sizing:border-box;min-width:150px;padding:4px;display:flex;flex-direction:column;gap:1px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-1);box-shadow:var(--dsw-elevation-panel);animation:mcpFade .1s ease-out}
.dsh-mcp-rowmenu-item{box-sizing:border-box;display:flex;align-items:center;gap:7px;width:100%;padding:6px 9px;border:0;border-radius:var(--mcp-r-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:17px;text-align:left;white-space:nowrap;cursor:pointer;transition:background .1s}
.dsh-mcp-rowmenu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-rowmenu-item.danger{color:var(--mcp-err)}
.dsh-mcp-rowmenu-item.danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}
.dsh-mcp-rowmenu-item:disabled{opacity:.45;cursor:not-allowed}
.dsh-mcp-rowmenu-sep{height:1px;background:var(--mcp-line);margin:3px 2px}

/* ── §4.1 专家「当前在场」区：绿顶条 + 更大的卡，与普通罗列拉开权重 ───────────── */
/* margin-bottom：与下方专家卡网格留一口气（两者原本紧贴，卡片像从提示框里溢出来）。 */
.dsh-mcp-onsite{display:flex;flex-direction:column;gap:9px;flex:none;margin-bottom:12px;border:1px solid color-mix(in srgb,var(--mcp-ok) 34%,transparent);border-radius:var(--mcp-r-lg);background:var(--mcp-bg-2);padding:12px 14px}
.dsh-mcp-onsite-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-mcp-onsite-head>b{font-size:11px;font-weight:650;letter-spacing:.5px;text-transform:uppercase;color:var(--dsw-alias-state-success-primary);display:inline-flex;align-items:center;gap:6px}
.dsh-mcp-onsite-head>b::before{content:"";width:6px;height:6px;border-radius:50%;background:var(--mcp-ok);box-shadow:0 0 0 3px color-mix(in srgb,var(--mcp-ok) 22%,transparent);corner-shape:round}
.dsh-mcp-onsite-head>span{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-onsite-body{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dsh-mcp-onsite-name{font-size:15px;font-weight:650;line-height:20px;min-width:0;overflow-wrap:anywhere}
.dsh-mcp-onsite-role{font-size:11.5px;color:var(--dsw-alias-brand-text)}
.dsh-mcp-onsite-chips{display:flex;gap:5px;flex-wrap:wrap;min-width:0}
.dsh-mcp-onsite-act{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsh-mcp-onsite-empty{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary)}
/* 卡内技能 chips：标签密度比独立徽章更小，且要明确「可点」（hover 抬边 + accent 文字）。 */
.dsh-mcp-card-tags>button.dsh-mcp-chip-s{font-size:10px;line-height:15px;padding:0 6px}
.dsh-mcp-card-tags>button.dsh-mcp-chip-s:hover{border-color:var(--mcp-accent);color:var(--dsw-alias-brand-text)}
.dsh-mcp-onsite-chips>button.dsh-mcp-chip-s:hover{border-color:var(--mcp-accent);color:var(--dsw-alias-brand-text)}
/* 推荐位与在场区之间留一口气，否则两块卡片网格会连成一片。 */
.dsh-mcp-wb-grid+.dsh-mcp-item-sub{margin-top:14px}
/* 推荐位整块（提示行 + 推荐卡网格）：上方与已召唤网格隔 18px，提示行与推荐卡之间
   隔 10px——此前提示行与推荐卡之间是 0 间距，小字提示直接贴在卡片圆角上。 */
.dsh-mcp-wb-reco{margin-top:18px}
.dsh-mcp-wb-reco>.dsh-mcp-item-sub{margin-bottom:10px}
/* 送还内联二次确认：把「点一下就没了」改成「点一下先问一句」 */
.dsh-mcp-confirm{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;padding:4px 8px;border:1px solid color-mix(in srgb,var(--mcp-err) 40%,transparent);border-radius:var(--mcp-r-sm);background:var(--dsw-alias-interactive-bg-hover-danger);font-size:11.5px;color:var(--dsw-alias-label-primary)}
.dsh-mcp-confirm>span{color:var(--mcp-err);font-weight:600}
.dsh-mcp-chips{display:inline-flex;align-items:center;gap:4px;flex-wrap:wrap;min-width:0}
.dsh-mcp-chip-s{display:inline-flex;align-items:center;gap:4px;padding:1px 7px;border:1px solid var(--mcp-line);border-radius:999px;background:var(--mcp-bg-1);color:var(--dsw-alias-label-secondary);font-size:10.5px;line-height:16px;white-space:nowrap;corner-shape:round}
/* §3.1 过滤 chip：作为按钮要 cursor / hover / 选中态；未选中时保持弱化，选中才吃 accent。 */
button.dsh-mcp-chip-s{font:inherit;font-size:10.5px;cursor:pointer;transition:background .12s,border-color .12s,color .12s}
button.dsh-mcp-chip-s:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
button.dsh-mcp-chip-s.on{border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-label-primary);font-weight:600}
button.dsh-mcp-chip-s:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:1px}
.dsh-mcp-chip-s-count{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
button.dsh-mcp-chip-s.on .dsh-mcp-chip-s-count{color:var(--mcp-accent)}
.dsh-mcp-chip-s.more{color:var(--dsw-alias-label-tertiary);border-style:dashed}

/* ── §3.1 Skill 看板：来源徽记 + 过滤条（只看已启用 / 只看模型可调用）─────────── */
.dsh-mcp-skill-filters{display:flex;align-items:center;gap:7px;flex-wrap:wrap;flex:none}
.dsh-mcp-skill-toggle{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border:1px solid var(--mcp-line);border-radius:999px;background:var(--mcp-bg-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:17px;white-space:nowrap;cursor:pointer;corner-shape:round;transition:background .12s,border-color .12s,color .12s}
.dsh-mcp-skill-toggle:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.dsh-mcp-skill-toggle[aria-pressed="true"]{border-color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-mcp-skill-toggle:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:1px}
.dsh-mcp-skill-toggle>i{font-style:normal;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-skill-toggle[aria-pressed="true"]>i{color:var(--mcp-accent)}
.dsh-mcp-skill-src-badge{display:inline-flex;align-items:center;padding:0 6px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-xs);background:var(--mcp-bg-2);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px;font-family:var(--mcp-mono);white-space:nowrap}

/* ── §6 市场：面包屑 + 子页签（下划线式）+ 兼容性前置 + 密度 + 分类条 + 免责折叠 ── */
/* 面包屑不再独占一行：作为子页签行的最后一个元素靠右贴齐（margin-left:auto），
   与页签同一基线、正好坐在分割线上方。 */
.dsh-mcp-mk-crumb{display:flex;align-items:center;gap:6px;flex:none;margin-left:auto;padding-left:12px;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);min-height:17px;white-space:nowrap}
.dsh-mcp-mk-crumb-root{color:var(--dsw-alias-label-secondary)}
.dsh-mcp-mk-crumb-sep{opacity:.55}
.dsh-mcp-mk-crumb>b{font-weight:600;color:var(--dsw-alias-label-primary);font-size:11.5px}
.dsh-mcp-mk-topright{display:flex;align-items:center;gap:10px;flex:0 1 auto;min-width:0;margin-left:auto}
.dsh-mcp-mk-topright .dsh-mcp-mk-crumb{margin-left:0;padding-left:0}
/* 子页签行右侧的免责声明：单行、可截断（完整口径在 title 里），窄屏先让位给页签与入口 */
.dsh-mcp-mk-note{flex:0 1 auto;min-width:0;max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:17px;color:var(--dsw-alias-label-tertiary);cursor:help}
.dsh-mcp-loadout-open{border:1px solid var(--mcp-line);background:transparent;color:var(--mcp-mut);border-radius:999px;padding:4px 10px;font-size:11px;line-height:17px;cursor:pointer;white-space:nowrap}
.dsh-mcp-loadout-open:hover{border-color:var(--mcp-accent);color:var(--dsw-alias-label-primary)}
.dsh-mcp-loadout-modal{width:min(780px,94vw);height:min(720px,88vh);max-height:88vh;display:flex;flex-direction:column;padding:18px 20px;overflow:hidden}
.dsh-mcp-loadout-tabs{display:flex;gap:2px;flex:none;border-bottom:1px solid var(--mcp-line);margin:-4px 0 12px}
.dsh-mcp-loadout-tab{border:0;background:transparent;color:var(--mcp-mut);font:inherit;font-size:12px;padding:7px 11px;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.dsh-mcp-loadout-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--mcp-accent);font-weight:600}
.dsh-mcp-loadout-pane{flex:1;min-height:0;display:flex;flex-direction:column;gap:10px;overflow-y:auto;padding-right:2px}
.dsh-mcp-loadout-hint,.dsh-mcp-loadout-note{margin:0;font-size:11.5px;line-height:1.55;color:var(--mcp-mut)}
.dsh-mcp-loadout-note{flex:none;border-top:1px dashed var(--mcp-line);padding-top:8px}
.dsh-mcp-loadout-name{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;color:var(--mcp-mut);flex:none}
.dsh-mcp-loadout-name input{flex:1;min-width:180px;box-sizing:border-box;padding:7px 9px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font:inherit}
.dsh-mcp-loadout-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:none}
.dsh-mcp-loadout-result{display:flex;flex-direction:column;gap:8px;min-height:0}
.dsh-mcp-loadout-summary{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;font-size:11.5px;color:var(--mcp-mut);flex:none}
.dsh-mcp-loadout-warn{color:var(--dsw-alias-state-warning-primary)}
.dsh-mcp-loadout-from{color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-loadout-json{margin:0;min-height:160px;max-height:320px;overflow:auto;padding:10px 12px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1);font-family:var(--mcp-mono);font-size:11px;line-height:1.5;white-space:pre;color:var(--dsw-alias-label-secondary)}
.dsh-mcp-loadout-input{width:100%;box-sizing:border-box;resize:vertical;min-height:150px;padding:10px 12px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1);color:var(--dsw-alias-label-primary);font-family:var(--mcp-mono);font-size:11.5px;line-height:1.5}
.dsh-mcp-loadout-file{cursor:pointer}
.dsh-mcp-loadout-rows{display:flex;flex-direction:column;gap:6px;overflow-y:auto;min-height:0;padding-right:2px}
.dsh-mcp-loadout-row{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-1)}
.dsh-mcp-loadout-row-main{min-width:0;display:flex;flex-direction:column;gap:3px}
.dsh-mcp-loadout-row-title{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;overflow-wrap:anywhere}
.dsh-mcp-loadout-kind{font-size:10px;color:var(--mcp-mut);border:1px solid var(--mcp-line);border-radius:999px;padding:0 6px}
.dsh-mcp-loadout-row-meta{display:flex;gap:4px 10px;flex-wrap:wrap;font-size:10.5px;color:var(--mcp-mut)}
.dsh-mcp-loadout-row-actions{display:flex;gap:6px;flex:none;flex-wrap:wrap;justify-content:flex-end}
@media (max-width:480px){.dsh-mcp-loadout-modal{width:100%;height:calc(100vh - 24px);max-height:none;padding:14px}.dsh-mcp-loadout-row{flex-direction:column}.dsh-mcp-loadout-row-actions{width:100%;justify-content:flex-start}}
/* 窄屏页签行放不下 5 个页签 + 面包屑：页签优先，面包屑让位（页签本身已标明当前位置）。 */
@media (max-width:480px){.dsh-mcp-mk-crumb{display:none}}
/* 免责声明在窄屏让位：先缩到一句被截断也读不出信息，再窄干脆收起（要点已在 title 里）。 */
@media (max-width:900px){.dsh-mcp-mk-note{max-width:220px}}
@media (max-width:760px){.dsh-mcp-mk-note{display:none}}
.dsh-mcp-mk-subtabs-idle{flex:none;padding:7px 10px 8px;border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:19px;white-space:nowrap;cursor:pointer;opacity:.8;transition:color .13s,opacity .13s}
.dsh-mcp-mk-subtabs-idle:hover{opacity:1;color:var(--dsw-alias-label-secondary);text-decoration:underline;text-underline-offset:2px}
.dsh-mcp-mk-subtabs-idle:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:-2px}
.dsh-mcp-mk-subtabs{display:flex;align-items:center;gap:2px;flex:none;overflow-x:auto;scrollbar-width:none;border-bottom:1px solid var(--mcp-line);margin-bottom:2px}
.dsh-mcp-mk-subtabs::-webkit-scrollbar{display:none}
.dsh-mcp-mk-subtab{box-sizing:border-box;display:inline-flex;align-items:center;gap:7px;flex:none;padding:7px 12px 8px;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;line-height:19px;white-space:nowrap;cursor:pointer;transition:color .13s,border-color .13s}
.dsh-mcp-mk-subtab:hover{color:var(--dsw-alias-label-primary)}
.dsh-mcp-mk-subtab[aria-selected="true"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--mcp-accent);font-weight:600}
.dsh-mcp-mk-subtab:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:-2px}
.dsh-mcp-mk-subtab>i{font-style:normal;font-size:10px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);padding:0 5px;border-radius:999px;background:var(--mcp-line);line-height:15px;corner-shape:round}
.dsh-mcp-mk-subtab[aria-selected="true"]>i{background:var(--dsw-alias-interactive-bg-hover-accent);color:var(--mcp-accent)}
/* 「只看可直接安装」默认勾选——把它做成显眼的开关条而不是埋在工具栏里 */
.dsh-mcp-mk-quickbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;flex:none}
/* 搜索态的分类 chips：置灰但保留位置，用户知道分类还在、只是本次搜索没按它筛。 */
.dsh-mcp-market-chips.muted{opacity:.5}
.dsh-mcp-market-chips.muted .dsh-mcp-chip{cursor:not-allowed}
.dsh-mcp-mk-quick{box-sizing:border-box;display:inline-flex;align-items:center;gap:7px;padding:4px 11px;border:1px solid var(--mcp-line);border-radius:999px;background:var(--mcp-bg-1);color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;line-height:17px;cursor:pointer;corner-shape:round;transition:background .12s,border-color .12s,color .12s}
.dsh-mcp-mk-quick:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}
.dsh-mcp-mk-quick[aria-pressed="true"]{border-color:var(--mcp-ok);background:var(--dsw-alias-state-success-tertiary);color:var(--dsw-alias-label-primary);font-weight:600}
.dsh-mcp-mk-quick:focus-visible{outline:2px solid var(--mcp-accent);outline-offset:1px}
.dsh-mcp-mk-quick>i{font-style:normal;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.dsh-mcp-mk-quick[aria-pressed="true"]>i{color:var(--dsw-alias-state-success-primary)}
/* 不兼容卡：虚线灰显（不是红——它只是暂时装不上，不是错误状态）+ 橙角标 */
.dsh-mcp-card.wb.blocked{border-style:dashed;border-color:color-mix(in srgb,var(--mcp-warn) 45%,var(--mcp-line));background:var(--mcp-bg-2);opacity:.9}
.dsh-mcp-card.wb.blocked:hover{opacity:1}
.dsh-mcp-mk-corner{position:absolute;top:-1px;right:-1px;z-index:2;padding:1px 7px;border-radius:0 var(--mcp-r-md) 0 var(--mcp-r-md);background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-primary);font-size:10px;font-weight:600;line-height:16px;white-space:nowrap}
.dsh-mcp-card.wb{position:relative}

/* ── 骨架屏（OPT-25 · 6.6 三处并行初始加载的占位）──────────────────────
   容器与条只用既有主题令牌 + 中性 rgba，暗/亮主题都不需要额外分支。
   shimmer 是「扫过高光」式：一条半透明白从左到右扫过灰条，opacity/位移双重缓动。
   prefers-reduced-motion 时整个停掉，只留静态灰条（信息量不打折，动效不打扰）。 */
.dsh-mcp-skeleton{display:flex;flex-direction:column;gap:9px;padding:10px 11px}
.dsh-mcp-skeleton-bar{height:13px;border-radius:var(--mcp-r-sm);background:color-mix(in srgb,var(--mcp-mut) 16%,transparent);position:relative;overflow:hidden}
.dsh-mcp-skeleton-bar::after{content:"";position:absolute;inset:0;transform:translateX(-100%);background:linear-gradient(90deg,transparent,rgba(255,255,255,.28),transparent);animation:mcpSkeletonShimmer 1.4s ease-in-out infinite}
@keyframes mcpSkeletonShimmer{100%{transform:translateX(100%)}}
@media (prefers-reduced-motion: reduce){.dsh-mcp-skeleton-bar::after{animation:none;opacity:0}}

/* ── 社区「人味」：作者头像 / 维护状态 / 最近动静 / 真实反馈出口 ────────
   全部使用既有主题令牌；头像只是 <img>，加载失败就隐藏，不留破图占位。 */
.dsh-mcp-card-person{display:flex;align-items:flex-start;gap:8px;min-width:0}
.dsh-mcp-card-person>div{min-width:0}
.dsh-mcp-card-avatar{width:30px;height:30px;border-radius:50%;corner-shape:round;object-fit:cover;flex:none;border:1px solid var(--mcp-line);background:var(--mcp-bg-1)}
.dsh-mcp-card-avatar.fallback{display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:650;color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dsh-mcp-detail-person{display:flex;align-items:flex-start;gap:10px;margin-bottom:8px}
.dsh-mcp-detail-person>div{min-width:0}
.dsh-mcp-detail-person h3{margin:0}
.dsh-mcp-detail-avatar{width:42px;height:42px;border-radius:50%;corner-shape:round;object-fit:cover;flex:none;border:1px solid var(--mcp-line);background:var(--mcp-bg-1)}
.dsh-mcp-detail-avatar.fallback{display:inline-flex;align-items:center;justify-content:center;font-size:18px;font-weight:650;color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dsh-mcp-presence{display:flex;align-items:flex-start;gap:9px;padding:8px 10px;margin:7px 0 10px;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-2)}
.dsh-mcp-presence.compact{padding:6px 8px;margin:6px 0 8px}
.dsh-mcp-presence-avatar{width:32px;height:32px;border-radius:50%;corner-shape:round;object-fit:cover;flex:none;border:1px solid var(--mcp-line)}
.dsh-mcp-presence-avatar.fallback{display:inline-flex;align-items:center;justify-content:center;font-size:13px;font-weight:650;color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dsh-mcp-presence-body{min-width:0;flex:1 1 auto;display:flex;flex-direction:column;gap:3px}
.dsh-mcp-presence-line{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12px;min-width:0}
.dsh-mcp-presence-owner{font-weight:650;color:var(--dsw-alias-label-primary);text-decoration:none;overflow-wrap:anywhere}
a.dsh-mcp-presence-owner:hover{color:var(--mcp-accent);text-decoration:underline}
.dsh-mcp-presence-loading{font-size:10.5px;color:var(--mcp-mut)}
.dsh-mcp-presence-meta{display:flex;align-items:center;gap:5px 10px;flex-wrap:wrap;font-size:10.5px;line-height:1.45;color:var(--mcp-mut)}
.dsh-mcp-presence-inline{display:flex;align-items:center;gap:6px;font-size:10.5px;line-height:1.4;color:var(--mcp-mut);min-width:0;flex-wrap:wrap}
.dsh-mcp-presence-inline-avatar{width:18px;height:18px;border-radius:50%;corner-shape:round;object-fit:cover;flex:none;border:1px solid var(--mcp-line)}
.dsh-mcp-presence-inline-avatar.fallback{display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:650;color:var(--mcp-accent);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dsh-mcp-presence-inline-owner{color:var(--dsw-alias-label-secondary);font-weight:600;overflow-wrap:anywhere}
.dsh-mcp-presence-inline-owner a{color:inherit;text-decoration:none}
.dsh-mcp-presence-inline-owner a:hover{color:var(--mcp-accent);text-decoration:underline}
.dsh-mcp-presence-inline-note{color:var(--mcp-mut);font-variant-numeric:tabular-nums}
.dsh-mcp-presence-card{margin-top:-3px}
.dsh-mcp-presence-detail{background:transparent;border:0;padding:0;margin:0 0 8px}
.dsh-mcp-catalog-meta{display:flex;align-items:center;gap:6px 12px;flex-wrap:wrap;font-size:11px;color:var(--mcp-mut);padding:0 1px;margin:-4px 0 9px}
.dsh-mcp-catalog-meta a{color:var(--mcp-accent);text-decoration:none}
.dsh-mcp-catalog-meta a:hover{text-decoration:underline}
.dsh-mcp-feedback{margin:10px 0 4px;padding:9px 10px;border:1px dashed var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-2)}
.dsh-mcp-feedback-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:7px;font-size:11.5px;color:var(--dsw-alias-label-primary)}
.dsh-mcp-feedback-source{font-size:10.5px;color:var(--mcp-mut);font-weight:400}
.dsh-mcp-feedback-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dsh-mcp-feedback-actions .dsh-mcp-btn{font-size:11px;padding:5px 9px;text-decoration:none}
.dsh-mcp-feedback-note{margin:7px 0 0;font-size:10.5px;line-height:1.5;color:var(--mcp-mut)}
/* 与下方工具的间距交给 .dsh-mcp-wb 的 gap：再加 margin 会叠成 20px，显得空 */
.dsh-mcp-pulse{flex:none;margin:0;border:1px solid var(--mcp-line);border-radius:var(--mcp-r-md);background:var(--mcp-bg-2);padding:8px 10px}
/* 首个内容块再上提 4px：上侧留白才与下侧（工具条贴分类条）接近 */
.dsh-mcp-pulse + *{margin-top:-4px}
.dsh-mcp-pulse.quiet{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 10px;border-style:dashed;background:transparent}
.dsh-mcp-pulse-title{font-size:11.5px;font-weight:700;color:var(--dsw-alias-label-primary);letter-spacing:.01em}
.dsh-mcp-pulse-quiet{font-size:10.5px;color:var(--mcp-mut)}
.dsh-mcp-pulse-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-bottom:5px}
.dsh-mcp-pulse-note{font-size:10.5px;color:var(--mcp-mut);flex:1 1 auto}
.dsh-mcp-pulse-clear{border:0;background:transparent;color:var(--mcp-mut);font:inherit;font-size:10.5px;cursor:pointer;padding:2px 4px;border-radius:var(--mcp-r-sm)}
.dsh-mcp-pulse-clear:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dsh-mcp-pulse-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.dsh-mcp-pulse-list>li{display:flex;align-items:center;gap:8px;min-width:0}
.dsh-mcp-pulse-item{display:flex;align-items:center;gap:6px;min-width:0;flex:1 1 auto;border:0;background:transparent;font:inherit;font-size:11px;color:var(--dsw-alias-label-secondary);text-align:left;padding:3px 4px;border-radius:var(--mcp-r-sm);cursor:pointer}
.dsh-mcp-pulse-item:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsh-mcp-pulse-kind{font-weight:600;white-space:nowrap}
.dsh-mcp-pulse-kind.added{color:var(--dsw-alias-state-success-primary)}
.dsh-mcp-pulse-kind.removed{color:var(--dsw-alias-state-warn-primary)}
.dsh-mcp-pulse-kind.updated{color:var(--mcp-accent)}
.dsh-mcp-pulse-sample{color:var(--mcp-mut);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dsh-mcp-pulse-time{flex:none;font-size:10px;color:var(--mcp-mut);font-variant-numeric:tabular-nums}

/* 响应式覆盖必须位于全部基础规则之后：同特异性下后出现者胜出。 */
@media (max-width:760px){.dsh-mcp-panel-overlay{padding:10px}.dsh-mcp-panel{max-width:none;width:100%;height:calc(100dvh - 20px);border-radius:var(--mcp-r-panel)}.dsh-mcp-panel .dsh-mcp-wrap{padding:12px}.dsh-mcp-head{align-items:flex-start}.dsh-mcp-body{flex-direction:column;overflow-y:auto;overflow-x:hidden}.dsh-mcp-side,.dsh-mcp-ws-body{width:auto;min-width:0;max-height:none;flex:none}.dsh-mcp-side:not(.embedded) .dsh-mcp-list{max-height:38vh}.dsh-mcp-section.local,.dsh-mcp-section.global{flex:none;min-height:0;max-height:none}.dsh-mcp-section.local .dsh-mcp-list{max-height:30vh}.dsh-mcp-global-list{max-height:30vh}.dsh-mcp-detail{padding:12px;flex:none}.dsh-mcp-d-head{flex-direction:column}.dsh-mcp-kv-edit{grid-template-columns:minmax(90px,35%) minmax(0,1fr) auto}.dsh-mcp-page{padding:10px 12px 20px}[data-platform=darwin] .dsh-mcp-page{padding-top:calc(var(--dsh-frame-top-clearance,0px) + 10px)}.dsh-mcp-page>.dsh-mcp-wrap{flex:0 0 auto;width:100%;min-height:0;height:auto}.dsh-mcp-skill-body{flex-direction:column;overflow:visible}.dsh-mcp-skill-side{width:auto;flex:none}.dsh-mcp-skill-list{max-height:34vh}.dsh-mcp-skill-detail{flex:none;max-height:none}.dsh-mcp-skill-d-md{max-height:38vh}}
@media (max-width:480px){.dsh-mcp-head{flex-direction:column}.dsh-mcp-head-actions{width:100%;justify-content:flex-start}.dsh-mcp-btn{padding:7px 9px}.dsh-mcp-radio-row,.dsh-mcp-number-grid{grid-template-columns:1fr}.dsh-mcp-modal{max-width:none;width:100%;padding:14px}.dsh-mcp-kv{grid-template-columns:1fr;gap:4px}.dsh-mcp-kv>b{margin-top:4px}.dsh-mcp-secret-row{grid-template-columns:1fr;gap:4px}.dsh-mcp-secret{width:100%}.dsh-mcp-kv-edit{grid-template-columns:1fr auto}.dsh-mcp-kv-edit input:first-child{grid-column:1 / -1}.dsh-mcp-tool{flex-direction:column}.dsh-mcp-tool-name{max-width:100%}.dsh-mcp-tool-desc{white-space:normal}}
`;

// ── DOM 基础件：createElement 绑定、值遮蔽、通用小控件与图标表 ──────────────────────
// 这一层必须排在所有组件之前 —— 下面 23 个返回元素的 React 组件全靠这里的 `h` 构造。
const h = React2.createElement;

// ── 对话框焦点陷阱（OPT-21 · 6.2）────────────────────────────────────────────
// 全文件 9 处 role="dialog" 此前只有 Escape 关闭：键盘用户按 Tab 会一路走到对话框
// **后面**的页面元素上，焦点跑出弹层后既看不见高亮、也没法用 Esc 回来；关闭弹层后
// 焦点还停在已被卸载的节点上（等于丢给 body）。这里用一个 hook 兜住可访问性下限：
// 进弹层把焦点推进去、Tab/Shift+Tab 在弹层内循环、退出时还给原来的元素。
// 刻意不接管 Escape —— 每个 dialog 自己的 onKeyDown 负责关闭，语义保持不变。
const FOCUSABLE_SELECTOR = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
const useFocusTrap = (ref, active) => {
  useEffect(() => {
    if (!active) return undefined;
    const el = ref && ref.current;
    // 容器尚未挂载（或调用方给的是空 ref）：什么都不做，既不猜选择器也不抛错。
    if (!el) return undefined;
    // 还原目标：进弹层那一刻的焦点。可能随弹层一起被卸载，所以清理时要 isConnected 兜底。
    const restoreTarget = document.activeElement;
    const focusables = () => {
      const nodes = el.querySelectorAll(FOCUSABLE_SELECTOR);
      const out = [];
      for (const node of nodes) if (node && typeof node.focus === 'function' && !node.disabled) out.push(node);
      return out;
    };
    // 初焦点：容器里第一个可聚焦元素；一个都没有就聚焦容器本身（role="dialog" 均带
    // tabIndex: -1）。若调用方自己的 effect 已经把焦点放进了容器（各 dialog 原有的
    // `dialogRef.current?.focus()`），这里就不抢——避免两处 effect 互相顶。
    if (!el.contains(document.activeElement)) {
      const head = focusables()[0];
      try { (head || el).focus(); } catch { /* 元素不可聚焦：留给用户点，不因此抛错 */ }
    }
    const onKeyDown = (event) => {
      if (event.key !== 'Tab') return;
      // 内层弹层优先：不让外层陷阱再处理同一按键（嵌套弹层时两边都会算一次 first/last）。
      event.stopPropagation();
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!items.length) {
        event.preventDefault();
        try { el.focus(); } catch { /* 同上 */ }
        return;
      }
      if (!el.contains(document.activeElement)) {
        event.preventDefault();
        try { (event.shiftKey ? last : first).focus(); } catch { /* 同上 */ }
        return;
      }
      // 焦点落在容器自身上（tabIndex: -1 的 dialog 常被各组件自己的 effect 聚焦）时，
      // 浏览器的默认行为是**往容器外**走一步——Tab 会跳到对话框后面的页面元素上。
      // 这正是陷阱最容易漏的一格，所以容器也要当作「边界」处理。
      const onBoundary = document.activeElement === el;
      if (!event.shiftKey) {
        if (onBoundary || document.activeElement === last) {
          event.preventDefault();
          try { first.focus(); } catch { /* 同上 */ }
        }
      } else if (onBoundary || document.activeElement === first) {
        event.preventDefault();
        try { last.focus(); } catch { /* 同上 */ }
      }
    };
    el.addEventListener('keydown', onKeyDown);
    return () => {
      el.removeEventListener('keydown', onKeyDown);
      // 还原焦点：目标可能已随对话框一同卸载，只能尽力而为。
      try {
        if (restoreTarget && restoreTarget.isConnected && typeof restoreTarget.focus === 'function') restoreTarget.focus();
      } catch { /* 目标不可聚焦：放弃还原，不因此抛错 */ }
    };
    // ref 是稳定对象；active 决定陷阱开关。
  }, [active, ref]);
};

const MAX_TIMER_DELAY_MS = 2147483647;
const REDACTED_VALUE = '__DSH_MCP_REDACTED__';
// 屏蔽值在表单里需要**稳定哨兵**：locale 切换后译文会变，但已填进 state 的旧
// 字符串不能随译文一起变，否则 toFormValue/fromFormValue 的相等判定会失配。
// 因此内部只存 ASCII 哨兵，展示层再映射成当前语言的文案。
const PRESERVED_VALUE_TOKEN = '__DSH_MCP_PRESERVED__';
const preservedValueLabel = () => t('••••••（保留原值）');
const MASKED_VALUE = '••••••';
const toFormValue = (value) => value === REDACTED_VALUE ? PRESERVED_VALUE_TOKEN : String(value || '');
const fromFormValue = (value) => value === PRESERVED_VALUE_TOKEN ? REDACTED_VALUE : value;
// args 是「每行一个」的多行串，哨兵可能夹在中间，所以按 token 全量替换而不是只比整串。
const displayFormValue = (value) => String(value ?? '').split(PRESERVED_VALUE_TOKEN).join(preservedValueLabel());
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

// 星标用实心小星；验证用「印章 + 白色对勾」。两者都不吃主题文字色，只在卡片里当状态图标。
const StarIcon = ({ size }) =>
  h('svg', { width: size || 10, height: size || 10, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' }, h('path', { fill: 'currentColor', d: 'M8 1.7l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.5l-3.8 2 .7-4.3-3.1-3 4.3-.6z' }));
const VerifiedSeal = ({ size }) =>
  h('svg', { width: size || 15, height: size || 15, viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' },
    h('path', { fill: 'currentColor', d: 'M8 .9l1.8 1.4 2.3-.3 1 2.1 2 1.2-.5 2.3.5 2.3-2 1.2-1 2.1-2.3-.3L8 15.1l-1.8-1.4-2.3.3-1-2.1-2-1.2.5-2.3-.5-2.3 2-1.2 1-2.1 2.3.3z' }),
    h('path', { fill: 'none', stroke: '#fff', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', d: 'M5.1 8.2l1.9 1.9 3.9-4' }));

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
  // grid：网格视图（2×2 方块）；list：列表视图（三行点线），Skill 看板视图切换用
  grid: 'M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z',
  list: 'M2 3.5h2M6.5 3.5h7.5M2 8h2M6.5 8h7.5M2 12.5h2M6.5 12.5h7.5',
  // layers：三层堆叠 = 自定义套件（看板入口按钮、召唤菜单套件分组、弹窗空态共用）；
  // grip：六点拖拽手柄，套件弹窗里「这张卡 / 这一行可以拖」的可见线索（16×16 网格，
  // 用 .2 长的短线段而不是零长路径——零长路径在部分渲染器里画不出圆点）。
  layers: 'M8 2l6 3.3-6 3.4-6-3.4zM2.4 8.4L8 11.5l5.6-3.1M2.4 11.1L8 14.2l5.6-3.1',
  grip: 'M6 3.4v.2M10 3.4v.2M6 7.9v.2M10 7.9v.2M6 12.4v.2M10 12.4v.2',
  // down：向下箭头，README 弹层「跳到末尾」用
  down: 'M8 3v9.4M4 8.6l4 4 4-4',
  // info：信息圆圈，宿主组件 / 不可安装的说明图标
  info: 'M8 7.2v4.3M8 4.7v.2M8 14.2A6.2 6.2 0 1 0 8 1.8a6.2 6.2 0 0 0 0 12.4z',
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
    // RO 必须观察外层 wrap 而不是 seg 本身：seg 是 inline-flex 收缩包裹，
    // 一旦折叠成「…N」其内容宽就锁死在窄态，观察它自己永远等不到「变宽」事件，
    // 初始测量若赶上宿主布局未完成（clientWidth 偏小），就会卡在全折叠死锁。
    // wrap 由外层 flex 决定宽度，与内容无关，是唯一稳定的基准。
    const wrap = rootRef.current;
    const el = wrap || barRef.current;
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
    // barWidth 异常偏小（宿主布局中途测量）也不能一个都不显示，
    // 否则「…N」独占一排、列表头无任何可点作用域。
    return Math.max(1, count);
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
  // §1.2 分段控件：全局 / 各工作区是「同一维度的互斥取值」，用一排等长 chip 会让人
  // 以为是多个独立开关。改成连体分段：底板统一着色，当前项实底反白，一眼是"选中之一"。
  // 溢出折叠逻辑完全保留（工作区可能十几个），只是外观与语义标签换成 radio 组。
  return h('div', { className: 'dsh-mcp-tabs-wrap', ref: rootRef },
    h('div', { className: 'dsh-mcp-seg', ref: barRef, role: 'tablist', 'aria-label': t('作用域') },
      visible.map((tab) =>
        h('button', {
          key: tab.key,
          type: 'button',
          role: 'tab',
          'aria-selected': active === tab.key,
          className: 'dsh-mcp-seg-item',
          onClick: () => onSelect(tab.key),
          title: tab.title || tab.label,
        },
          tab.label,
          tab.count !== undefined ? h('span', { className: 'dsh-mcp-seg-count' }, tab.count) : null,
        ),
      ),
      hidden.length
        ? h('button', {
            key: '__more__',
            ref: moreRef,
            type: 'button',
            'aria-expanded': moreOpen,
            className: 'dsh-mcp-seg-item',
            title: t('还有 {0} 个作用域', [hidden.length]),
            onClick: (e) => { e.stopPropagation(); syncMoreAnchor(); setMoreOpen((value) => !value); },
          }, '…', h('span', { className: 'dsh-mcp-seg-count' }, hidden.length))
        : null,
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
// §2.2 工具行：加「调用 12 · 错误 0」与热度色条。
// usage 是可选入参（来自工具账本的同名工具记录）：账本可能还没扫完、也可能没开过裁缝页，
// 此时整块不渲染，而不是显示「调用 0」——0 是「确认没被调用」，未知不是 0。
const ToolRow = ({ tool, usage, maxCalls }) => {
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
  const calls = usage && typeof usage.calls === 'number' ? usage.calls : null;
  const errors = usage && typeof usage.errors === 'number' ? usage.errors : 0;
  return h('div', { className: 'dsh-mcp-tool' },
    h('div', headProps,
      // 色条贴在工具名左侧：视线沿行首竖扫就能看出「哪些工具在被用」，
      // 不必逐行去读右侧数字。
      calls === null ? null : h(HeatBar, { calls, max: maxCalls, label: t('近 30 天调用 {0} 次', [fmtInt(calls)]) }),
      h('span', { className: 'dsh-mcp-tool-name', title: tool.name }, tool.name),
      h('span', { className: 'dsh-mcp-tool-desc', title: tool.description }, tool.description || ''),
      calls === null ? null : h('span', {
        className: 'dsh-mcp-tool-usage' + (errors > 0 ? ' bad' : calls === 0 ? ' mute' : ''),
        title: t('近 30 天：调用 {0} 次，失败 {1} 次', [fmtInt(calls), fmtInt(errors)]),
      }, errors > 0 ? t('调用 {0} · 错误 {1}', [fmtInt(calls), fmtInt(errors)]) : calls === 0 ? t('零调用') : t('调用 {0}', [fmtInt(calls)])),
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

// §2.2 体量阈值：≥100 个工具就算「大体量」。
// 为什么是 100：本机 rea 是 170 个、windows 约 50 个，100 正好把真正需要概览的挑出来，
// 而不至于让二十来个工具的普通服务器也被折叠（折叠本身也有成本）。
const HEAVY_TOOL_COUNT = 100;

// §2.2 工具清单：本地搜索 + 热度排序无关的稳定列表。
// 不做虚拟滚动：详情面板本身是滚动容器，工具行高度固定但总数上限在数百量级，
// 直接渲染的代价远小于引入虚拟列表所带来的一堆边界（展开行、滚动锚点、键盘导航）。
// 真正的问题是「找不到某个工具」，那用搜索解决比用虚拟滚动解决更直接。
const ToolList = ({ tools, usageByName, searchable, query, onQuery }) => {
  const usageOf = (name) => (usageByName ? usageByName.get(name) : undefined);
  // 调用数峰值用于热度色条分档：没有账本数据时 max 为 0，HeatBar 会自行退化为无色。
  let maxCalls = 0;
  if (usageByName) for (const tool of tools) { const u = usageOf(tool.name); if (u && u.calls > maxCalls) maxCalls = u.calls; }
  const q = (query || '').trim().toLowerCase();
  const shown = q
    ? tools.filter((tool) => (tool.name + ' ' + (tool.description || '')).toLowerCase().includes(q))
    : tools;
  return h('div', { className: 'dsh-mcp-tools' },
    searchable
      ? h('div', { className: 'dsh-mcp-tools-bar' },
          h('div', { className: 'dsh-mcp-search' }, h(Icon, { d: ICONS.search }), h('input', { placeholder: t('搜索工具名或描述…'), value: query, onChange: (e) => onQuery(e.target.value) })),
          h('span', { className: 'dsh-mcp-tools-count' }, q ? t('{0}/{1} 个匹配', [fmtInt(shown.length), fmtInt(tools.length)]) : t('共 {0} 个', [fmtInt(tools.length)])),
        )
      : null,
    shown.length === 0
      ? h('div', { className: 'dsh-mcp-empty-list' }, t('没有匹配「{0}」的工具', [query]))
      : shown.map((tool) => h(ToolRow, { key: tool.name, tool, usage: usageOf(tool.name), maxCalls })),
  );
};

// ══ 原子组件层（优化项共用件）═════════════════════════════════════════════
// 放在这里而不是各页签内部：§1.4 空状态、§2.2 热度、§5 行尾菜单
// 在四个页签里都要用；复制四份必然走形，一处定义才能保证「同一种状态长得一样」。

// ── §1.4 空状态四件套：图标 + 结论 + 原因 + 主操作 ───────────────────────────
// 一个空列表如果不解释「为什么空」和「下一步点哪」，用户只会反复刷新。
// 四个槽位刻意分开：结论用 <b>，原因用 <span>，操作在最下——扫读顺序与决策顺序一致。
// actions 两种写法都收：现成的 React 元素，或 { label, icon, onClick, danger } 描述对象
// （描述对象交给这里统一渲染成按钮，避免每个调用点各写一份按钮样式）。
const EmptyState = ({ icon, tone, title, hint, actions, tight }) =>
  h('div', { className: 'dsh-mcp-empty' + (tight ? ' tight' : '') },
    icon ? h('span', { className: 'dsh-mcp-empty-ico' + (tone ? ' ' + tone : '') }, h(Icon, { d: ICONS[icon], size: 20 })) : null,
    title ? h('b', null, title) : null,
    hint ? h('span', null, hint) : null,
    actions
      ? h('div', { className: 'dsh-mcp-empty-act' },
          (Array.isArray(actions) ? actions : [actions]).map((item, index) =>
            item && typeof item === 'object' && item.label !== undefined
              ? h('button', {
                  key: index,
                  type: 'button',
                  className: 'dsh-mcp-btn' + (item.danger ? ' danger' : '') + (index === 0 ? ' primary' : ''),
                  onClick: item.onClick,
                  disabled: item.disabled,
                  title: item.title,
                }, item.icon ? h(Icon, { d: ICONS[item.icon], size: 12 }) : null, item.label)
              : item))
      : null,
  );

// ── 内联二次确认：把「点一下就执行」改成「点一下先问一句」 ─────────────────────
// 只用于不可撤销或代价高的动作（送还专家、移除服务器）。破坏性动作用 err 色，
// 确认与取消并排且「取消」在左——默读顺序先看到的是退出路径，降低误触代价。
const InlineConfirm = ({ question, confirmLabel, onConfirm, onCancel, busy }) =>
  h('span', { className: 'dsh-mcp-confirm' },
    h('span', null, question),
    h('button', { type: 'button', className: 'dsh-mcp-btn danger', disabled: busy, onClick: onConfirm }, confirmLabel),
    h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: busy, onClick: onCancel }, t('取消')),
  );

// ── §2.2 热度色条：把「调用次数」这种绝对量转成可扫读的相对量 ───────────────────
// 分档而不是线性：实际分布极端长尾（少数工具几千次、多数几次），线性宽度全挤成一条线。
const heatLevel = (calls, max) => {
  if (!calls || calls <= 0) return 0;
  if (!max || max <= 0) return 1;
  const ratio = calls / max;
  if (ratio >= 0.5) return 3;
  if (ratio >= 0.12) return 2;
  return 1;
};
const HeatBar = ({ calls, max, label }) => {
  const lv = heatLevel(calls, max);
  const pct = lv === 0 ? 0 : lv === 1 ? 34 : lv === 2 ? 66 : 100;
  return h('span', { className: 'dsh-mcp-heat lv' + lv, title: label || '', 'aria-hidden': true }, h('i', { style: { width: pct + '%' } }));
};

// ── §5.4 sparkline：7 段柱状，把「最近有没有在用」压成 22px 宽 ──────────────────
// 数据缺失时整块不渲染（不画一排等高灰条去假装有数据）。
const Spark = ({ series, title }) => {
  if (!Array.isArray(series) || !series.length) return null;
  const max = Math.max.apply(null, series.concat([1]));
  return h('span', { className: 'dsh-mcp-spark', title, 'aria-hidden': true },
    series.map((v, i) => h('i', { key: i, className: v > 0 && v >= max * 0.55 ? 'hot' : '', style: { height: Math.max(1.5, Math.round((v / max) * 14)) + 'px' } })),
  );
};

// ── §5.3 行尾 ⋯ 菜单：把「禁用 / 启用」这类低频动作收进菜单，别直铺占满一行 ──────
// 点击外部关闭 + Esc 关闭；菜单项用 onMouseDown 提前于 blur，避免点不到。
const RowMenu = ({ items, label }) => {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const close = (e) => { if (!rootRef.current || !rootRef.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const list = (items || []).filter(Boolean);
  if (!list.length) return null;
  return h('span', { className: 'dsh-mcp-rowmenu', ref: rootRef },
    h('button', {
      type: 'button',
      className: 'dsh-mcp-rowmenu-btn',
      'aria-expanded': open,
      'aria-label': label || t('更多操作'),
      title: label || t('更多操作'),
      onClick: (e) => { e.stopPropagation(); setOpen((v) => !v); },
    }, '⋯'),
    open
      ? h('span', { className: 'dsh-mcp-rowmenu-pop', onClick: (e) => e.stopPropagation() },
          list.map((item, i) => (item.sep
            ? h('span', { key: 'sep' + i, className: 'dsh-mcp-rowmenu-sep' })
            : h('button', {
                key: item.label,
                type: 'button',
                className: 'dsh-mcp-rowmenu-item' + (item.danger ? ' danger' : ''),
                disabled: item.disabled,
                title: item.title,
                onMouseDown: (e) => e.preventDefault(),
                onClick: () => { setOpen(false); item.onClick && item.onClick(); },
              }, item.icon ? h(Icon, { d: ICONS[item.icon], size: 13 }) : null, item.label))),
        )
      : null,
  );
};

// ── §1.2 URL 记忆：把作用域/分类写进 location.hash，刷新与分享都能回到原处 ─────────
// 只在 http(s) 或已有的 file:// 下生效；宿主可能把面板挂在任何路径上，所以只改 hash，
// 不动 path/search。写入用 replaceState 避免每次切换都堆一条历史记录。
const readHashParam = (name) => {
  try {
    if (typeof location === 'undefined') return '';
    const raw = String(location.hash || '').replace(/^#/, '');
    if (!raw) return '';
    const parts = raw.split('&');
    for (const part of parts) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      if (decodeURIComponent(part.slice(0, eq)) === name) return decodeURIComponent(part.slice(eq + 1));
    }
    return '';
  } catch { return ''; }
};
const writeHashParams = (patch) => {
  try {
    if (typeof location === 'undefined' || typeof history === 'undefined') return;
    const raw = String(location.hash || '').replace(/^#/, '');
    const map = {};
    if (raw) {
      for (const part of raw.split('&')) {
        const eq = part.indexOf('=');
        if (eq < 0) { if (part) map[decodeURIComponent(part)] = ''; continue; }
        map[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
      }
    }
    Object.keys(patch).forEach((k) => {
      const v = patch[k];
      if (v === '' || v === null || v === undefined) delete map[k];
      else map[k] = String(v);
    });
    const next = Object.keys(map).map((k) => encodeURIComponent(k) + (map[k] === '' ? '' : '=' + encodeURIComponent(map[k]))).join('&');
    const url = location.pathname + location.search + (next ? '#' + next : '');
    history.replaceState(null, '', url);
  } catch { /* hash 只是便利设施，任何失败都不影响面板功能 */ }
};

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

// ── 骨架屏组件（OPT-25 · 6.6）：初次并行加载的占位条，aria-hidden 避免读屏噪音 ──
const Skeleton = ({ rows = 3 }) => h('div', { className: 'dsh-mcp-skeleton', 'aria-hidden': 'true' }, Array.from({ length: rows }, (_, i) => h('div', { key: i, className: 'dsh-mcp-skeleton-bar', style: { width: i === rows - 1 ? '60%' : '100%' } })));

// ── 分页条（OPT-30 · 3.1）：上一页 / 跳页 / 下一页 + 总数 ────────────────────────
// 原来三处 pager 都只有「上一页 12 / 34 下一页」：翻到第 28 页要点 27 次，而且
// **看不出总共有多少条**（12/34 是页码不是条数）。这里补三件事：
//   ① 跳页输入框——失焦或回车才提交，绝不逐字符提交：市场技能页的 setPage 会打
//      wbSkillCatalog 远程请求，边敲边跳等于连发请求。
//   ② 总数——走 fmtInt，跟其他数字一样受 locale 影响。
//   ③ 越界钳制——输入 999 落到最后一页、输入 0 落到第一页，非数字回退当前页。
const Pager = ({ page, pageCount, total, onPage, disabled }) => {
  const [draft, setDraft] = useState(String(page));
  // page 被外部改（上一页/下一页/筛选变化把页码夹回）时同步输入框，否则会显示旧值。
  useEffect(() => { setDraft(String(page)); }, [page]);
  const commit = () => {
    const n = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(n)) { setDraft(String(page)); return; }
    const next = Math.min(pageCount, Math.max(1, Math.trunc(n)));
    if (next !== page) onPage(next);
    setDraft(String(next));
  };
  return h('div', { className: 'dsh-mcp-wb-pager' },
    h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: disabled || page <= 1, onClick: () => onPage(page - 1) }, t('上一页')),
    h('span', { className: 'dsh-mcp-builtin-count' }, t('第 {0} / {1} 页', [page, pageCount])),
    h('label', { className: 'dsh-mcp-page-jump' },
      h('span', null, t('跳到')),
      h('input', {
        type: 'number', min: 1, max: pageCount, value: draft, disabled,
        'aria-label': t('跳转到指定页'),
        onChange: (e) => setDraft(e.target.value),
        onBlur: commit,
        onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } },
      }),
      h('span', null, t('页')),
    ),
    h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: disabled || page >= pageCount, onClick: () => onPage(page + 1) }, t('下一页')),
    total === undefined ? null : h('span', { className: 'dsh-mcp-builtin-count' }, t('共 {0} 条', [fmtInt(total)])),
  );
};

// ── 服务器列表：按传输 / 状态筛选，选中与启停 ──────────────────────────────────
const ServerList = ({ servers, total, selected, query, onQuery, onSelect, onToggle, busy, transportFilter, statusFilter, onTransportFilter, onStatusFilter, embedded, workspace, emptyHint, loading }) => {
  const count = total === undefined ? servers.length : total;
  const showControls = !embedded || count > CONTROLS_THRESHOLD;
  // mountFailed / scopeFailed / wsSub 现在在模块作用域（纯函数，可被测试直接调用）。
  // 项目 MCP 的 status 与全局同一个取值域（deriveMcpPhase）：connected / failed / loading /
  // stopped / disabled / unknown。状态点因此直接复用，不再需要为项目行特例。
  const dotPhase = (s) => (mountFailed(s) || scopeFailed(s) ? 'failed' : s.status || s.phase);
  const toggleLocked = (s) => busy || !s.managed || (s.scope !== 'workspace' && !s.enabled && s.phase !== 'stopped');
  // §2.1 体量阈值：170 个工具和 20 个工具在“20 工具”这个字符串里视觉等重，
  // 但进详情页后一个是滚两屏、一个是滚十几屏。100 是「要不要默认折叠」的分界：
  // 低于 100 摊开看反而快，高于 100 必须先给概览。
  const HEAVY_TOOL_COUNT = 100;
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
      // OPT-25：初次并行加载（servers 还是起步空数组）时用骨架条占位；空态 EmptyState
      // 只在真正加载完成后出现，避免「骨架 → 空态」闪烁出「没有 MCP」的误导。
      loading && count === 0
        ? h(Skeleton, { rows: 6 })
        : servers.length === 0
        // §1.4 空状态：列表为空时分两种情况——一个都没有（该去添加）vs 过滤后没有（该改条件）。
        // 原文案把两者合并成「没有匹配的 MCP」，用户不知道该清搜索还是该加服务器。
        ? (count === 0
            ? (emptyHint || h(EmptyState, { icon: 'plug', title: t('还没有 MCP 服务器'), hint: t('添加一个 HTTP 或 stdio 服务器，或在「市场」里挑选现成的连接器。'), tight: true }))
            : h(EmptyState, { icon: 'search', title: t('没有匹配的 MCP'), hint: t('当前搜索或过滤条件下没有结果；清空关键词或把状态切回「全部状态」试试。'), tight: true }))
        : servers.map((s) => {
            const heavy = typeof s.toolCount === 'number' && s.toolCount >= HEAVY_TOOL_COUNT;
            const failed = mountFailed(s) || scopeFailed(s) || s.status === 'failed';
            return h('div', { key: s.serverName, role: 'button', tabIndex: 0, 'aria-selected': selected === s.serverName, className: 'dsh-mcp-item' + (selected === s.serverName ? ' sel' : ''), onClick: () => onSelect(s.serverName), onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(s.serverName); } } },
              h(Dot, { phase: dotPhase(s) }),
              // 三段式：第一段（名称）给出「是谁」，第二段（事实行）给出「什么状况、多大体量」，
              // 第三段（右侧开关）给出「能立刻做什么」。三段各自负责一个问题，扫读时不必来回跳。
              h('div', { className: 'dsh-mcp-item-main' },
                h('div', { className: 'dsh-mcp-item-name' }, s.serverName),
                h('div', { className: 'dsh-mcp-item-sub' },
                  h(Badge, { cls: s.transport === 'http' ? 't-http' : 't-stdio' }, s.transport === 'http' ? 'HTTP' : 'stdio'),
                  h('span', null, s.scope === 'workspace' ? wsSub(s) : s.toolCount + t(' 工具')),
                  heavy ? h('span', { className: 'dsh-mcp-tag-heavy', title: t('工具数 ≥ {0}：进详情默认折叠工具清单', [HEAVY_TOOL_COUNT]) }, t('大体量')) : null,
                  // 失败原因就地给一个词，不逼用户点进去看日志才知道哪里坏了。
                  // 401/403 类失败（host 侧 authRequired）单独说「需授权」：重连连不回来，
                  // 该做的是重新授权，这条区别以前被并进「连接失败」里了。
                  failed && !mountFailed(s) && !scopeFailed(s)
                    ? h(Badge, { cls: 's-err', title: s.authRequired ? t('服务器拒绝当前凭据（401/403 类）：重连不会恢复，需要重新授权') : undefined }, s.authRequired ? t('需授权') : t('连接失败'))
                    : null,
                  mountFailed(s) ? h(Badge, { cls: 's-err' }, t('挂载失败')) : null,
                  scopeFailed(s) ? h(Badge, { cls: 's-err' }, t('作用域故障')) : null,
                ),
              ),
              h(Toggle, { on: s.enabled, disabled: toggleLocked(s), label: s.serverName + (s.enabled ? t('：已启用') : t('：已禁用')), title: s.managed ? (s.enabled ? t('禁用') : t('启用')) : t('来自其他配置层，只读'), onChange: () => onToggle(s) }),
            );
          }),
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

// ── §2.1 连接诊断（OPT-28）的纯函数部分 ────────────────────────────────────────
// 从 projectConnections 的行集合里挑出「当前这条服务器」对应的那一行。
// 为什么不能只按 serverName 匹配：serverName 的全 app 唯一性只在保存路径被校验，
// 手工编辑 .dsh/mcp.json 完全能造出两个项目同名（见 :3126 的同一段注释），所以有
// wsPath 时必须先按 wsPath 收窄，收窄不了（老宿主不回 wsPath）才退回「按名取第一条
// 非 ready 的」——非 ready 的那条才是用户此刻真正想看的异常连接。
const pickProjectConnection = (rows, serverName, wsPath) => {
  const list = Array.isArray(rows) ? rows.filter((row) => row && row.serverName === serverName) : [];
  if (list.length === 0) return null;
  const want = wsPath ? String(wsPath) : '';
  if (want) {
    const exact = list.filter((row) => String(row.wsPath || '') === want);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return exact.find((row) => row.state !== 'ready') || exact[0];
  }
  if (list.length === 1) return list[0];
  return list.find((row) => row.state !== 'ready') || list[0];
};

// 状态值域来自宿主 projectConnectionsView：ready / connecting / disposing。
const connectionStateText = (state) => (state === 'ready'
  ? t('已就绪')
  : state === 'connecting'
    ? t('建连中')
    : state === 'disposing'
      ? t('释放中')
      : (state ? String(state) : '—'));

// teardown 读数：落定的只回答「上次回收花了多久」，未落定的才说「回收中」。
// 宿主已保证 settled 记录只保留 10 分钟内（TEARDOWN_RECORD_STALE_MS），这里不再判时限。
const connectionTeardownText = (teardown) => {
  if (!teardown) return '';
  const ms = Math.max(0, Math.round(Number(teardown.elapsedMs) || 0));
  if (teardown.settled) return teardown.stuck ? t('上次回收 {0} ms（超时）', [ms]) : t('上次回收 {0} ms', [ms]);
  return t('回收中 {0} ms', [ms]);
};

// ── 服务器详情：工具清单、重连、编辑、移除、掩码值显隐 ────────────────────────────
const ServerDetail = ({ server, tools, onToggle, onReconnect, onEdit, onRemove, busy, onReveal, revealed, onCopy, excluded, onToggleExclude, usageByName, onAdd, call, wsPath }) => {
  // §2.2 工具区状态：搜索词 + 「大体量默认折叠」。
  // 这两条 state 必须放在早退之前——hooks 数量不能因 server 有无而变，
  // 否则从「空态」切到「有详情」时 React 会报 hook 顺序错误。
  const [toolQuery, setToolQuery] = useState('');
  const [toolsExpanded, setToolsExpanded] = useState(false);
  // 切换服务器时重置工具区视图：上一条的搜索词对下一条无意义，
  // 而「已展开」状态若保留，用户会以为新服务器也默认展开了。
  const toolScopeKey = server ? server.serverName + ':' + (server.toolRevision || '') : '';
  useEffect(() => { setToolQuery(''); setToolsExpanded(false); }, [toolScopeKey]);
  // §2.1 连接诊断（OPT-28）：契约 dsh-armory#mcpManager/projectConnections 很早就注册了，
  // 但面板从未调过它——项目作用域的连接健康度（会话槽 / 空闲回收 / 配置是否过期 /
  // 上一次 teardown 卡住多久）因此完全不可见。这里按需拉一次，不轮询：诊断是「想看才看」
  // 的排障信息，定时轮询只会在后台白白唤醒宿主读一遍连接表。
  const [connDiag, setConnDiag] = useState(null);
  const [connBusy, setConnBusy] = useState(false);
  // 只对项目作用域有意义：全局连接不经过 projectConnections（那张表按 wsPath 索引）。
  const diagEnabled = !!(server && (server.scope === 'workspace' || server.wsPath));
  const diagWsPath = wsPath || (server && server.wsPath) || '';
  const diagServerName = server ? server.serverName : '';
  const loadConnDiag = useCallback(async () => {
    if (!call || !diagEnabled) return;
    setConnBusy(true);
    try {
      const res = await call('projectConnections');
      if (res && res.ok) setConnDiag(Array.isArray(res.connections) ? res.connections : []);
      else setConnDiag([]);
    } catch {
      setConnDiag([]);
    } finally {
      setConnBusy(false);
    }
  }, [call, diagEnabled]);
  useEffect(() => {
    // 切换服务器时先清空：上一条的连接读数挂在新服务器名下，比「暂无数据」更误导。
    setConnDiag(null);
    if (diagEnabled) loadConnDiag();
  }, [diagEnabled, diagServerName, diagWsPath, loadConnDiag]);
  if (!server)
    return h('div', { className: 'dsh-mcp-detail' },
      h(EmptyState, {
        icon: 'plug',
        title: t('选择一个 MCP 查看详情'),
        // §1.4 空状态要「可操作」，不能只是一句说明。这里给的三个动作覆盖了
        // 用户看到空白右栏时最可能的意图：不知道怎么配（去市场找现成的）、
        // 想自己写（填表）、手上已有 JSON（导入）。
        hint: t('从左侧列表点选一台服务器，可以查看它的连接信息、参数与工具清单。'),
        actions: [
          { label: t('去市场找现成的'), icon: 'store', onClick: () => openBoardCategory('wb') },
          { label: t('手动添加'), icon: 'plug', onClick: onAdd },
        ],
      }),
    );
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
        ? (status === 'connected' ? t('已连接') : status === 'failed' ? (server.authRequired ? t('需授权') : t('连接失败')) : status === 'unknown' ? t('状态未知') : status === 'loading' ? t('连接中…') : t('尚未建立连接（新会话自动挂载）'))
        : status === 'connected' ? t('已连接') : status === 'failed' ? (server.authRequired ? t('需授权') : t('连接失败')) : status === 'unknown' ? t('状态未知') : status === 'loading' || status === 'waiting' ? t('连接中…') : t('已停止');
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
  // §2.1 连接诊断（OPT-28）的渲染层。三种状态要分开说，否则「没数据」会被误读成「一切正常」：
  //   diagEnabled=false  → 整块不渲染（全局连接没有这条记录，说「无诊断」是噪音）；
  //   拉过且没找到这一行 → 说明这条服务器当前没有活连接（也没回收记录），这本身是结论；
  //   拿到行               → 列出会话槽/空闲回收/配置是否过期/上次 teardown。
  const diagRow = connDiag ? pickProjectConnection(connDiag, server.serverName, diagWsPath) : null;
  const connDiagCard = !diagEnabled
    ? null
    : h('div', { className: 'dsh-mcp-card' },
        h('div', { className: 'dsh-mcp-diag-head' },
          h('h4', null, t('连接诊断')),
          // 诊断是「想看才看」的信息，不轮询；给一个手动的重新读取入口就够。
          h('button', {
            type: 'button',
            className: 'dsh-mcp-diag-refresh',
            disabled: connBusy,
            title: t('重新读取宿主的连接表'),
            onClick: loadConnDiag,
          }, connBusy ? t('正在读取…') : t('刷新')),
        ),
        connDiag === null
          ? h('div', { className: 'dsh-mcp-diag-note' }, t('正在读取…'))
          : !diagRow
            ? h('div', { className: 'dsh-mcp-diag-note' },
                t('宿主连接表里没有这台服务器的记录：它当前没有被任何会话建立连接，也没有最近的回收记录。'))
            : h('div', { className: 'dsh-mcp-kv' },
                h('b', null, t('连接状态')),
                h('span', { className: diagRow.state === 'ready' ? 'dsh-mcp-diag-ok' : 'dsh-mcp-diag-bad' },
                  connectionStateText(diagRow.state)
                    + (diagRow.fiberState ? t('（会话槽 {0}）', [String(diagRow.fiberState)]) : '')),
                h('b', null, t('会话槽')),
                h('span', null, Number.isFinite(diagRow.sessions)
                  ? t('{0} 个会话共用这条连接', [fmtInt(diagRow.sessions)])
                  : (Number.isFinite(diagRow.refs) ? t('{0} 个引用', [fmtInt(diagRow.refs)]) : '—')),
                Number.isFinite(diagRow.idleTimeoutMs) && diagRow.idleTimeoutMs > 0
                  ? h('b', null, t('空闲回收'))
                  : null,
                Number.isFinite(diagRow.idleTimeoutMs) && diagRow.idleTimeoutMs > 0
                  ? h('span', { className: diagRow.idle ? 'dsh-mcp-diag-bad' : '' },
                      diagRow.idle
                        ? t('已空闲超过 {0} 秒，正在等待回收', [fmtInt(Math.round(diagRow.idleTimeoutMs / 1000))])
                        : t('空闲 {0} 秒后回收', [fmtInt(Math.round(diagRow.idleTimeoutMs / 1000))]))
                  : null,
                connectionTeardownText(diagRow.teardown) ? h('b', null, t('上次回收')) : null,
                connectionTeardownText(diagRow.teardown)
                  ? h('span', { className: diagRow.teardown && diagRow.teardown.stuck ? 'dsh-mcp-diag-bad' : '' },
                      connectionTeardownText(diagRow.teardown))
                  : null,
                diagRow.configStale || diagRow.configError || diagRow.scopeError ? h('b', null, t('配置')) : null,
                diagRow.configStale || diagRow.configError || diagRow.scopeError
                  ? h('span', { className: 'dsh-mcp-diag-bad' },
                      diagRow.configError
                        ? diagRow.configError
                        : diagRow.scopeError
                          ? diagRow.scopeError
                          : t('配置文件已改动，下次建连才生效'))
                  : null,
                Array.isArray(diagRow.duplicateOwners) && diagRow.duplicateOwners.length
                  ? h('b', null, t('同名项目'))
                  : null,
                Array.isArray(diagRow.duplicateOwners) && diagRow.duplicateOwners.length
                  ? h('span', null, diagRow.duplicateOwners.join(t('、')))
                  : null,
              ),
        // 连不上的时候，用户下一步几乎一定要重连；别让他滚回顶部去找那个按钮。
        diagRow && diagRow.state !== 'ready'
          ? h('div', { className: 'dsh-mcp-diag-acts' },
              h('button', {
                type: 'button',
                className: 'dsh-mcp-diag-act',
                disabled: busy || !server.enabled || !server.managed,
                title: t('拆掉这条连接并按当前配置重建，不影响其他会话'),
                onClick: () => onReconnect(server),
              }, t('重连这台服务器')),
            )
          : null,
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
    // 401/403 类的失败重连多少次都没用：直接把用户指到授权入口，别让他反复点「重连」。
    server.authRequired
      ? h('div', { className: 'dsh-mcp-log warn' }, t('这台服务器拒绝当前凭据（401/403 类），重连不会恢复：请到「市场 → 连接器」打开对应连接器点「重新授权」。由 WorkBuddy 账号代注入凭据的连接器（如 ima）DSH 无法代办。'))
      : null,
    server.toolCountAmbiguous ? h('div', { className: 'dsh-mcp-log warn' }, t('工具命名与其他 serverName 前缀重叠，无法可靠判断归属；请避免在 serverName 中使用双下划线。')) : null,
    // §2.4 连接健康条：原来「连没连上、几个工具、几个会话」埋在两行徽章里，
    // 而且要滚到「连接信息」才知道传输方式。这里把四个最常被问到的结论提到最上层：
    // 状态 / 工具数 / 会话数 / 传输。失败时补一格「原因」——不让人为了一个红点去翻日志。
    h('div', { className: 'dsh-mcp-health' },
      h('div', { className: 'dsh-mcp-health-cell' }, h('span', null, t('连接状态')), h('b', { className: status === 'connected' ? 'ok' : status === 'failed' || mountFailed || scopeFailed ? 'err' : status === 'loading' || status === 'waiting' ? 'warn' : 'mute' }, statusText)),
      h('div', { className: 'dsh-mcp-health-cell' }, h('span', null, t('工具')), h('b', { className: server.toolCount > 0 ? 'ok' : 'mute' }, server.toolCountAmbiguous ? t('归属存疑') : server.toolCount + t(' 个'))),
      h('div', { className: 'dsh-mcp-health-cell' }, h('span', null, t('会话')), h('b', { className: 'mute' }, isWorkspace ? (server.refs > 0 ? t('{0} 个共用', [server.refs]) : t('尚未建立')) : t('全局共享'))),
      h('div', { className: 'dsh-mcp-health-cell' }, h('span', null, t('传输')), h('b', { className: 'mute' }, server.transport === 'http' ? 'HTTP' : 'stdio')),
    ),
    // §2.1 连接诊断（OPT-28）：上面的健康条只说「连接现在是什么状态」，而排障还要知道
    // 「谁占着这条连接、什么时候会被回收、配置是不是已经改脏了、上一次回收卡了多久」。
    // 这些读数宿主一直有（projectConnectionsView），但面板从没调过那条契约。
    // 只有项目作用域渲染：全局连接不进 projectConnections（那张表按 wsPath 索引）。
    connDiagCard,
    h('div', { className: 'dsh-mcp-card' },
      h('h4', null, t('连接信息')),
      h('div', { className: 'dsh-mcp-kv' },
        h('b', null, t('传输')), h('span', null, server.transport === 'http' ? 'Streamable HTTP' : 'stdio'),
        server.url ? h('b', null, 'URL') : null, server.url ? h(RevealBtn, { field: 'url', label: 'URL', fallback: server.url }) : null,
        server.command ? h('b', null, t('命令')) : null, server.command ? h('span', null, mut(server.command)) : null,
        server.args && server.args.length ? h('b', null, t('参数')) : null,
        // §2.3 参数行：原来的做法是把 args 用空格拼起来再截断 88 字符，结果是
        // 「npx -y rea-mcp --root /Users/……」，既看不出几个参数、也分不清哪段是被脱敏的。
        // 现在先说清「有几个」，再用可展开的 chips 展示结构；仍不泄露原值（显示的是脱敏后的）。
        server.args && server.args.length
          ? h('span', { className: 'dsh-mcp-args' },
              h('span', { className: 'dsh-mcp-args-count' }, t('{0} 个参数', [server.args.length])),
              h('span', { className: 'dsh-mcp-args-note' }, t('已脱敏')),
              server.args.map((arg, i) => {
                const text = displayValue(arg);
                const masked = arg === REDACTED_VALUE || text === REDACTED_VALUE;
                return h('code', {
                  key: i,
                  className: 'dsh-mcp-arg-chip' + (masked ? ' masked' : ''),
                  title: masked ? t('此参数含密钥，已脱敏；需要时可在「编辑」里显式查看') : String(text),
                }, masked ? '••••••' : mut(text));
              }),
            )
          : null,
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
      // §2.2 大体量默认折叠：170 条平铺会把「连接信息」和「工具」之外的上下文全推出屏幕，
      // 而用户进详情页十次里有九次是想确认连接是否健康。因此 ≥100 工具时先只给一行摘要，
      // 想看再展开——默认状态服务最常见的目的，而不是服务最长的清单。
      tools.length >= HEAVY_TOOL_COUNT && !toolsExpanded
        ? h('div', { className: 'dsh-mcp-tools-collapsed' },
            h('span', null, t('{0} 个工具，默认收起以免遮蔽上方连接信息', [fmtInt(tools.length)])),
            h('button', { type: 'button', className: 'dsh-mcp-btn', onClick: () => setToolsExpanded(true) }, t('展开工具清单')),
          )
        : h(React2.Fragment, null,
            tools.length === 0
              ? h('div', { className: 'dsh-mcp-empty-list' }, server.toolCountAmbiguous ? t('工具归属存在命名歧义') : server.scope === 'workspace' ? t('尚无会话持有该项目连接，或连接尚未就绪') : t('暂无工具'))
              : h(ToolList, {
                  tools,
                  usageByName,
                  // 大清单才给搜索框：七八个工具时搜索框比清单本身还高，纯属负担。
                  searchable: tools.length > 12,
                  query: toolQuery,
                  onQuery: setToolQuery,
                }),
            tools.length >= HEAVY_TOOL_COUNT ? h('button', { type: 'button', className: 'dsh-mcp-btn dsh-mcp-tools-collapse-back', onClick: () => setToolsExpanded(false) }, t('收起工具清单')) : null,
          ),
    ),
  );
};

// ── 新增 / 编辑服务器弹窗：表单校验与 secret 字段遮蔽 ────────────────────────────
const AddEditModal = ({ open, onClose, onSubmit, busy, initial, draft, onRevealValue, revealEpoch, scopeName }) => {
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
  // draft：预填草稿（市场社区条目）。表单吃 initial 的预填，但提交必须走「新增」，
  // 名称也可改——否则 AddEditModal 会把它当成一次 update，去改一条并不存在的服务器。
  const editing = !!initial && !draft;
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
  useFocusTrap(dialogRef, open); // OPT-21：Tab 循环 + 关闭后焦点还原
  if (!open) return null;
  const kv = (rows, setRows, i, field, v) => {
    const next = rows.slice();
    const row = { ...next[i], [field]: v };
    if (field === 'k' && row.v === PRESERVED_VALUE_TOKEN && v !== row.originalKey) row.v = '';
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
  const visibleEditValue = (field, key, fallback) => Object.hasOwn(editRevealed, editRevealId(field, key)) ? editRevealed[editRevealId(field, key)] : displayFormValue(fallback);
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
              editing && url === PRESERVED_VALUE_TOKEN ? revealIcon('url', 'URL', () => toggleEditReveal('url')) : null,
            ),
          )
        : h('div', null,
            h('div', { className: 'dsh-mcp-field' }, h('label', null, t('命令')), h('input', { value: command, onChange: (e) => setCommand(e.target.value), placeholder: t('npx 或 C:\\path\\to\\bin.exe') })),
            h('div', { className: 'dsh-mcp-field' },
              h('label', null, t('参数（每行一个，原样传给进程）')),
              h('div', { className: 'dsh-mcp-input-action' },
                h('textarea', { rows: 4, value: visibleEditValue('args', undefined, args), onChange: (e) => { hideEditReveal('args'); setArgs(e.target.value); }, placeholder: '-y\nmcp-server@latest' }),
                editing && args === PRESERVED_VALUE_TOKEN ? revealIcon('args', t('参数'), () => toggleEditReveal('args')) : null,
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
              editing && row.v === PRESERVED_VALUE_TOKEN ? revealIcon(id, row.k, () => toggleEditReveal(field, originalKey)) : null,
              h('button', { type: 'button', className: 'dsh-mcp-kv-del', onClick: () => delRow(kvRows, setKvRows, i), title: t('删除此项'), 'aria-label': t('删除 ') + (row.k || t('配置项')) }, '✕'),
            ),
          );
        }),
        h('div', { className: 'dsh-mcp-kv-add' }, h(Btn, { onClick: () => addRow(kvRows, setKvRows), children: t('+ 添加') })),
      ),
      // 草稿里的必填环境变量为空：只提示、不阻塞——有些值允许运行时兜底，删不删由用户决定。
      draft && initial && Array.isArray(initial.requiredEnv) && initial.requiredEnv.length
        ? (() => {
            const missing = initial.requiredEnv.filter((key) => !envs.some((row) => row.k === key && String(row.v || '').trim()));
            return missing.length
              ? h('div', { className: 'dsh-mcp-wb-note warn', role: 'note' },
                  t('有 {0} 个必填环境变量为空，服务器可能启动失败：{1}', [missing.length, missing.join(' / ')]))
              : null;
          })()
        : null,
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
// OPT-17 · 2.5：核心字段含 ${input:xxx} 的条目会被整条降级（去掉等于发明一个猜的值），
// 它们不进 entries，只在 unsupportedEntries 里留 { name, transport, reason, names }。
// 界面必须把这两类分开说，否则用户只看到「没有可导入的 MCP」，看不出是「有几条需要交互取值」。
const sourceUnsupported = (row) => (row && row.unsupportedEntries) || [];
const sourceUnsupportedNames = (row) =>
  [...new Set(sourceUnsupported(row).flatMap((entry) => entry.names || []))];

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
  useFocusTrap(dialogRef, open); // OPT-21：Tab 循环 + 关闭后焦点还原
  if (!open) return null;
  // 选中来源后，来源导入优先于粘贴内容：两者不会同时在生效状态。
  const pickSource = async (row) => {
    const names = sourceImportNames(row);
    if (row.error || !names.length) {
      // 「一条都没有」有两种截然不同的原因，混成一句话会让用户以为文件里真的没东西。
      const blocked = sourceUnsupported(row).length;
      setError(row.error || (blocked
        ? t('这 {0} 个 MCP 都需要交互取值，无法直接导入', [String(blocked)])
        : t('这条配置里没有可导入的 MCP')));
      return;
    }
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
          const unsupported = sourceUnsupported(row);
          // 两类同时存在时，摘要必须同时给出两个数——只说「N 个 MCP」会让用户以为少算了。
          const detail = row.error || (names.length
            ? names.length + t(' 个 MCP：') + names.join(', ')
              + (unsupported.length ? t('（另有 {0} 个需要交互取值）', [String(unsupported.length)]) : '')
            : (unsupported.length
              ? t('这 {0} 个 MCP 都需要交互取值，无法直接导入', [String(unsupported.length)])
              : t('没有可导入的 MCP')));
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
            // 逐条列出「哪一条、为什么进不来、缺哪些交互输入」，而不是只给一个总数。
            unsupported.length
              ? h('span', { className: 'dsh-mcp-source-unsupported' },
                  t('不支持：') + unsupported.map((entry) => entry.name).join(t('、')))
              : null,
            unsupported.length
              ? h('span', { className: 'dsh-mcp-source-note' },
                  sourceUnsupportedNames(row).length
                    ? t('需要在这里填写的交互输入：') + sourceUnsupportedNames(row).join(t('、'))
                    : t('这些条目引用了编辑器交互输入（${input:…}），值在导入时拿不到'))
              : null,
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
      // OPT-17 · 2.5：来源导入预览按「可导入 / 不支持」两组分开列。
      // 混在一张成功列表里，用户会以为「不支持的也导进去了」。
      source && sourceUnsupported(source).length
        ? h('div', { className: 'dsh-mcp-card dsh-mcp-import-preview' },
            h('div', { className: 'dsh-mcp-import-group' },
              h('b', null, t('可导入：')),
              h('span', null, sourceImportNames(source).length ? sourceImportNames(source).join(t('、')) : t('无'))),
            h('div', { className: 'dsh-mcp-import-group' },
              h('b', { className: 'warn' }, t('不支持：')),
              h('span', null, sourceUnsupported(source).map((entry) => entry.name).join(t('、')))),
            ...sourceUnsupported(source).map((entry, index) => h('div', { key: 'unsup-' + index, className: 'dsh-mcp-import-group-note' },
              entry.name + t('：') + entry.reason)))
        : null,
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
// P0-3 / P1-1：把「不着急的后台工作」挪到浏览器空闲帧。会话头 / 首屏渲染期间主线程
// 本来就在忙，空闲回调能把这类 RPC 与其后的 setState 推到渲染之后。
// requestIdleCallback 不可用时退回 setTimeout(0)；两者都返回取消函数，调用方统一在
// effect 清理时调用（组件卸载后不再发请求）。
function scheduleIdle(fn, timeoutMs = 2000) {
  const win = typeof window !== 'undefined' ? window : null;
  if (win && typeof win.requestIdleCallback === 'function') {
    const id = win.requestIdleCallback(() => fn(), { timeout: timeoutMs });
    return () => { try { win.cancelIdleCallback(id); } catch { /* 宿主已卸载 */ } };
  }
  const id = setTimeout(fn, 0);
  return () => clearTimeout(id);
}
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

// 6.3 updateHint 状态化：已忽略版本改存 JSON 状态键 dsh-armory.updateHint.state
// （{"dismissed":"<版本>"}）。这是格式迁移不是键改名——旧裸键只做读回落，弹窗
// 判定语义不变（dismissed !== latest 才提示），故不进 LEGACY_KEY_SUFFIXES（那是要
// 改名的迁移表）。读写失败一律静默，不打扰面板。
const UPDATE_HINT_STATE_KEY = 'dsh-armory.updateHint.state';
const readUpdateHintDismissed = () => {
  try {
    const raw = localStorage.getItem(UPDATE_HINT_STATE_KEY);
    if (raw) {
      const state = JSON.parse(raw);
      if (state && typeof state.dismissed === 'string' && state.dismissed) return state.dismissed;
    }
  } catch { /* 新键缺失或 JSON 损坏：回落旧裸键（旧版格式迁移） */ }
  try { return localStorage.getItem('dsh-armory.updateHint.dismissed'); } catch { return null; /* 存储不可用时视为未关闭 */ }
};
const writeUpdateHintDismissed = (version) => {
  try { localStorage.setItem(UPDATE_HINT_STATE_KEY, JSON.stringify({ dismissed: version })); } catch { return; /* 忽略：下次打开会再提示 */ }
  try { localStorage.removeItem('dsh-armory.updateHint.dismissed'); } catch { /* 旧裸键清理失败不报错，读回落仍兼容 */ }
};

// ── MCP 主面板（McpTab）：服务器 + 工具 + 可见性感知轮询 ──────────────────────────
const McpTab = (props) => {
  const { call, onClose, floating, timer, pluginManager, tailorReport } = props;
  // §2.2 工具调用热度来自裁缝页的账本。这里只在"账本已经就绪"时用它——
  // 不为了给工具行配一列调用数就在 MCP 页再扫一遍日志：那要读几十上百个会话文件，
  // 而用户打开 MCP 页最常做的事只是确认连接是否正常。
  // 账本没有时传 undefined，ToolRow 会整块不渲染，而不是显示虚假的「调用 0」。
  const usageByName = useMemo(() => {
    const rows = tailorReport && Array.isArray(tailorReport.tools) ? tailorReport.tools : null;
    if (!rows) return undefined;
    const map = new Map();
    for (const row of rows) if (row && typeof row.name === 'string') map.set(row.name, row);
    return map;
  }, [tailorReport]);
  const panelRef = useRef(null);
  const [servers, setServers] = useState([]);
  // OPT-25（6.6 骨架屏）：首次 load 返回前保持 true，三个面板的 ServerList 用它渲染骨架；
  // 只有第一次完成才落 false，后续轮询/刷新不再触发骨架，避免列表闪动。
  const [initialLoad, setInitialLoad] = useState(true);
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
  // ---- §1.2 作用域 URL hash 记忆 ----
  // 刷新或切走再回来时，作用域选择应当还在。没有这条路，用户每次都要重新点一遍，
  // 而「我正在看某个项目的 MCP」是一件会持续好几分钟的状态。
  // 存 hash 而不是 storage：hash 天然跟当前页签绑定，不会把上一个页签的选择带到新页签，
  // 也天然可分享、可书签。键名 `mcp` 由 writeHashParams 统一序列化（#mcp=<path>）。
  const [scope, setScope] = useState(() => readHashParam('mcp') || 'global');
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
  // ---- §1.5 命令面板联动 ----
  // 面板里选中某台 MCP：直接把它的名字灌进列表搜索框。这比「选中并滚动到它」
  // 更简单也更准确——搜索框本来就是这台服务器的过滤器，一次请求就把列表缩到一行，
  // 同时清掉作用域/传输/状态过滤器，否则被过滤掉的服务器会「搜不到」。
  // 同样的两段式通道：从面板跳过来时 McpTab 可能刚挂载，广播还没发完。
  useEffect(() => {
    const focus = (name) => {
      const target = String(name || '').trim();
      if (!target) return;
      pendingMcpQuery = '';
      setQuery(target);
      setTransportFilter('all');
      setStatusFilter('all');
    };
    const off = onMcpQuery(focus);
    if (pendingMcpQuery) focus(pendingMcpQuery);
    return off;
  }, []);

  useEffect(() => {
    if (floating) panelRef.current?.focus();
  }, [floating]);
  // OPT-21：只有浮层形态才有 role="dialog" 的 panel 节点；嵌入 tab 形态下 panelRef 为空，
  // 陷阱本就该关掉，故 active 精确取 floating 而不是「面板已挂载」。
  useFocusTrap(panelRef, !!floating);

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
      setInitialLoad(false);
    }
  }, [call, clearRevealed, flash, scope]);

  useEffect(() => {
    load(false);
    return startVisibilityAwarePolling(typeof document === 'undefined' ? null : document, timer, POLL_INTERVAL_MS, () => load(false));
  }, [load, timer]);

  // §1.5 命令面板的「刷新 MCP 状态」走这里：带 notify 才走手动刷新分支（转圈 + toast），
  // 与头部刷新按钮完全同一条链路，避免面板刷新与按钮刷新出现两套行为。
  useEffect(() => onMcpRefresh(() => { load(true); }), [load]);

  // 更新提示：Host 每天最多查一次 GitHub Releases；纯增值信息，任何失败都静默，不打扰面板。
  useEffect(() => {
    let cancelled = false;
    call('updateHint').then((res) => {
      if (cancelled || !res?.ok || !res.updateAvailable) return;
      let dismissed = null;
      try { dismissed = readUpdateHintDismissed(); } catch { /* 存储不可用时视为未关闭 */ }
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
    if (updateHint?.latest) { try { writeUpdateHintDismissed(updateHint.latest); } catch { /* 忽略：下次打开会再提示 */ } }
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
    // 写入 hash：next 是 'global' 时清掉参数，不留一个无意义的 #mcp/global。
    writeHashParams({ mcp: next === 'global' ? null : next });
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
          h(ServerList, { servers: filtered, total: servers.length, selected, query, onQuery: setQuery, onSelect: setSelected, onToggle, busy, transportFilter, statusFilter, onTransportFilter: setTransportFilter, onStatusFilter: setStatusFilter, loading: initialLoad }),
          h(ServerDetail, {
            server: selectedServer,
            tools,
            usageByName,
            onToggle,
            onReconnect,
            onEdit: openEdit,
            onRemove,
            onAdd: openAdd,
            busy,
            onReveal,
            revealed,
            onCopy,
            // §2.1 连接诊断（OPT-28）：诊断卡要自己拉 projectConnections，因此把调用通道
            // 与作用域一并传入。全局分支下 scope 恒为 'global'，诊断卡自身会因
            // diagEnabled=false 整块不渲染，这里传值不会多打一次宿主。
            call,
            wsPath: scope,
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
                loading: initialLoad,
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
            usageByName,
            onToggle,
            onReconnect,
            onEdit: openEdit,
            onRemove,
            onAdd: openAdd,
            busy,
            onReveal,
            revealed,
            onCopy,
            excluded: exclude.includes(selected),
            onToggleExclude,
            // §2.1 连接诊断（OPT-28）：项目分支才是诊断真正生效的地方。
            call,
            wsPath: scope,
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
//   本按钮是 position:fixed 的圆钮（外框 ${FAB_SIZE}px 由 JS 单源常量插值），脱离文档流，
//   left/top 重绘成本可忽略，故保留 left/top 定位以复用现有 :hover/:active 的 transform 缩放反馈。
const FAB_POS_KEY = 'dsh-armory/fab-pos';
const DRAG_THRESHOLD = 5;
// 触屏 / 手写笔长按多久叫出隐藏菜单：与常见长按菜单同一量级，短于拖动判定的误触窗口。
const FAB_MENU_PRESS_MS = 520;

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
  // 「隐藏悬浮按钮」要保留另外两个入口：两种「面板 + 侧栏」组合各有一档，
  // 否则从 all 隐藏后会连带丢掉侧栏底部入口（issue #4）。
  panelSidebar: { panel: true, fab: false, sidebar: true },
  fab: { panel: false, fab: true, sidebar: false },
  sidebar: { panel: false, fab: false, sidebar: true },
  all: { panel: true, fab: true, sidebar: true },
};
// getter 而不是模块加载时求值：apply() 拿到宿主 locale 后文案才正确，
// 且切语言后重渲染能直接读到新译文。
const ENTRY_LABELS = {
  get both() { return t('全局面板 + 悬浮按钮（推荐）'); },
  get panel() { return t('仅全局面板（左上角，"插件"旁）'); },
  get panelSidebar() { return t('全局面板 + 侧栏底部入口（无悬浮按钮）'); },
  get fab() { return t('仅悬浮按钮'); },
  get sidebar() { return t('仅侧栏底部入口'); },
  get all() { return t('三个入口全开'); },
};
const ENTRY_DEFAULT = 'both';
const ENTRY_MODES = Object.keys(ENTRY_VISIBILITY);

// localStorage 是外部输入（旧版本写的、用户手改的）：不认识的值一律退回默认，
// 不半信半疑地拿去查表（查不到会得到一个 undefined 的可见性，等于悄悄关掉所有入口）。
function normalizeEntryMode(value) {
  return Object.prototype.hasOwnProperty.call(ENTRY_VISIBILITY, value) ? value : ENTRY_DEFAULT;
}
// 「隐藏悬浮按钮」= 换成同一组其它席位不变的档位，而不是直接写 fab:false。
// 表里没有对应档位（仅悬浮按钮是唯一入口）时原样返回，调用方据此禁用隐藏项，
// 「三个入口全关」因此仍然无法表达。
function entryModeWithoutFab(mode) {
  const current = normalizeEntryMode(mode);
  if (!ENTRY_VISIBILITY[current].fab) return current;
  const target = ENTRY_MODES.find((value) => {
    const visibility = ENTRY_VISIBILITY[value];
    return !visibility.fab && visibility.panel === ENTRY_VISIBILITY[current].panel && visibility.sidebar === ENTRY_VISIBILITY[current].sidebar;
  });
  return target || current;
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
// 悬浮按钮这一帧该不该出现：入口偏好允许 + 当前不在看板页。
// 看板本身占据中栏时按钮只会盖住列表/详情（issue #4），所以自动收起；
// 回到会话后 panelInfo 变回别的 id，按钮自然复现。纯函数便于直接断言。
function fabVisibleFor(mode, activePanelId) {
  return overlaySeats(mode).fab === true && activePanelId !== PANEL_ID;
}
// 入口排序：插件管理器用 0，定时任务用 10；取 5 让本入口正好落在「插件」旁边。
const PANEL_ORDER = 5;
// 看板五分类（MCP / Skill / 专家 / 工具裁缝 / 市场）随名称一并示人。
// 函数而非常量：槽位注册发生在 apply() 里，那时才拿到宿主 locale。
const panelLabel = () => t('技能 · MCP · 专家');
// 左上角侧栏入口（sidebar.panellist）单独命名，与 panelLabel() 解耦：
// 该行的 label 同时是可见文字、无障碍名称和折叠提示，改动不牵动输入框快捷菜单、
// 会话头专家徽章、悬浮按钮和侧栏底部入口的文案。
const sidebarEntryLabel = () => t('大肥鱼军械库');

// skill 的 source 取值域来自官方 dsh-skill-filesystem 的 roots()（rank 顺序即优先级），
// 与 skill-registry 的 runtime。这里只做展示文案，不参与判定。
// getter 保证每次读取都按当前 locale 翻译（切语言后重渲染即生效）。
const SKILL_SOURCE_LABELS = {
  get 'project-dsh'() { return t('项目 .dsh/skills'); },
  get 'project-agents'() { return t('项目 .agents/skills'); },
  get custom() { return t('自定义目录'); },
  get 'user-dsh'() { return t('用户 ~/.dsh/skills'); },
  get 'user-agents'() { return t('用户 ~/.agents/skills'); },
  get bundled() { return t('随 DSH 分发'); },
  get runtime() { return t('运行时注册'); },
};
const skillSourceLabel = (source) => SKILL_SOURCE_LABELS[source] || (source || t('未知来源'));

// 项目作用域只显示项目本地发现的技能。宿主 list({cwd}) 返回的是「用户级 + 随包 + 项目本地」
// 的并集——cwd 只负责把项目根目录的结果追加进来，不会剔除全局结果；项目目录为空时并集与
// 全局完全一样，看板看起来就像「切了跟没切一样」。这里按来源收窄到宿主的两个项目根标记，
// 项目里没有 skill 时如实显示空态。
const PROJECT_SKILL_SOURCES = new Set(['project-agents', 'project-dsh']);
const isProjectSkillRow = (row) => PROJECT_SKILL_SOURCES.has(String((row && row.source) || ''));

// 可卸载来源白名单：与宿主 lib/skill-remove.js 的 REMOVABLE_SKILL_SOURCES 一一对应，
// 改一处必须改两处。bundled / runtime / custom 不在这里——前三者的去处不可信或不该由
// 面板删（宿主侧仍会二次校验，客户端判定只决定「按不按钮」）。
const SKILL_REMOVABLE_SOURCES = new Set(['user-agents', 'user-dsh', 'project-agents', 'project-dsh']);
const skillRemovable = (source) => SKILL_REMOVABLE_SOURCES.has(String(source || ''));

// 可禁用来源白名单：与宿主 lib/skill-disable.js 同集（两边的安全闸门同一套理由——
// 没有可信根目录做包含性校验的来源不给写入口）。工具裁缝技能行的「禁用 / 释放」按钮
// 只对这里的来源出现；宿主侧 setSkillDisabled 会拿着注册表解析出的真实路径二次校验。
const SKILL_DISABLE_SOURCES = SKILL_REMOVABLE_SOURCES;
const skillDisableActionable = (row) =>
  row.registered === true && SKILL_DISABLE_SOURCES.has(String(row.source || ''));

// ── Skill 分类升级（决策 6/10）：6 类 + 未分类兜底，两段式强/弱特征词匹配 ─────────
// 为什么两段式：中英混排描述里 code/image/frontend 这类词跨类污染严重，单层表会把
// imagegen-frontend-* 误判成「编程开发」。先按 SKILL_CAT_MATCH_ORDER 整体扫强特征词
// （跨类污染最小者优先），未命中再扫弱特征词，仍未命中落「未分类」——保证不丢条目。
// 匹配对象 = name + ' ' + description 的小写串；首个命中即定类。关键词表允许实现方微调。
const SKILL_CATS = [
  { key: 'all', get name() { return t('全部'); }, color: 'var(--mcp-cat-all)' },
  { key: 'dev', get name() { return t('编程开发'); }, color: 'var(--mcp-cat-dev)',
    strong: ['skill p8', 'arkts', 'arkui', '微信小程序', '小程序', '后端', '数据库', 'mysql', 'mariadb', 'api 设计', 'api设计', 'bug 诊断', 'bug诊断', '代码审查', '代码生成', '代码可读', '重构', '测试用例', '全栈', 'karpathy', 'spec 驱动', 'image-to-code', 'mcp server', 'sdk', 'monorepo', '源码'],
    weak: ['code', 'coding', 'developer', 'typescript', 'javascript', 'python', 'rust', 'sql', '编程', '开发'] },
  { key: 'design', get name() { return t('设计与创作'); }, color: 'var(--mcp-cat-design)',
    strong: ['imagegen', '品牌', 'brandkit', 'logo', '海报', 'stitch', 'mockup', '图标', '插画', '视频生成', '视频编辑', '视频翻译', '素材分析', '内容生产', '内容合成', '设计稿', '设计系统', 'landing page', '配图', '设计'],
    weak: ['design', '创作', 'image', 'video', '视觉', '前端', 'frontend', '页面'] },
  { key: 'office', get name() { return t('文档办公'); }, color: 'var(--mcp-cat-office)',
    strong: ['docx', 'xlsx', 'pptx', 'pdf', 'word 文档', 'excel', 'powerpoint', '文档', '公文', '报告', '表格', '幻灯', '公式缓存', 'libreoffice'],
    weak: ['office', '写作', 'markdown', '笔记'] },
  { key: 'auto', get name() { return t('效率与自动化'); }, color: 'var(--mcp-cat-auto)',
    strong: ['browser', '浏览器', '定时', 'schedule', 'workflow', '工作流', '自动化', '批量', '表单填写', '数据提取', '提醒'],
    weak: ['自动', '效率', '抓取', '搜索'] },
  { key: 'ops', get name() { return t('开发运维'); }, color: 'var(--mcp-cat-ops)',
    strong: ['sandbox', '沙箱', 'acl', '运维', '部署', 'deploy', 'release', '发布', '排查', '诊断', '环境', '崩溃', '代理下载', '签名', '供应链'],
    weak: ['debug', 'windows', '安装', '升级', '更新'] },
];
const SKILL_UNCAT = { key: 'uncat', get name() { return t('未分类'); }, color: 'var(--mcp-cat-uncat)' };
// 「最近安装」视图的簇头：不是真分类——不进 SKILL_CATS 轨道、不参与 skillcat hash 校验，
// 只在 recentOnly 开启时当单簇标题（时间线）用。
const SKILL_RECENT_CAT = { key: 'recent', get name() { return t('最近安装'); }, color: 'var(--mcp-cat-all)' };
// skillcat hash 值合法性校验用。
const SKILL_CAT_KEYS = new Set(SKILL_CATS.map((c) => c.key));
const skillCatByKey = (key) => SKILL_CATS.find((c) => c.key === key) || null;
// 匹配顺序（强/弱两轮共用）：设计与创作 → 文档办公 → 开发运维 → 效率与自动化 → 编程开发。
const SKILL_CAT_MATCH_ORDER = ['design', 'office', 'ops', 'auto', 'dev'];
const skillCategoryOf = (s) => {
  const hay = ((s.name || '') + ' ' + (s.description || '')).toLowerCase();
  for (const key of SKILL_CAT_MATCH_ORDER) {
    const cat = skillCatByKey(key);
    if (cat.strong.some((w) => hay.includes(w))) return cat;
  }
  for (const key of SKILL_CAT_MATCH_ORDER) {
    const cat = skillCatByKey(key);
    if (cat.weak.some((w) => hay.includes(w))) return cat;
  }
  return SKILL_UNCAT;
};

// 「项目」语境下 cwd 决定项目根（.dsh/skills / .agents/skills 都从它往下找），
// 全局语境传 undefined，让提供方只扫用户级与自定义目录——与官方 list() 语义一致。
const skillScopeArg = (scope) => (scope === 'global' ? {} : { cwd: scope });

// 看板顶层分类：MCP（原面板全部能力）与 Skill（新看板）。
// ── 工具裁缝（Tool Tailor）：工具使用账本 + 上下文税单 + 死工具清单 ──
// 数据来自宿主的 toolTailor Remote（只读扫描 ~/.dsh/sessions），禁用/启用直接复用
// 既有的 disable/enable 写链 —— 因此只有「当前已注册的 MCP 工具」才有操作按钮，
// 历史出现过的未注册工具（例如已卸载的 MCP）只展示统计。
// 延迟统计暂缺（见 tool-ledger.js 尾注），健康度以错误率 + 调用次数呈现。
// OPT-16 · 3.2：专家详情弹层 persona 预览截断阈值（展开全文后渲染完整原文）。
const PERSONA_PREVIEW_MAX = 4000;
const TAILOR_WINDOWS = [
  { key: '1', get label() { return t('今日'); }, days: 1 }, // OPT-24b · 4.1：今日档，回答「刚配置完它到底被调了几次」
  { key: '7', get label() { return t('近 7 天'); }, days: 7 },
  { key: '30', get label() { return t('近 30 天'); }, days: 30 },
  { key: '90', get label() { return t('近 90 天'); }, days: 90 },
];
const fmtInt = (n) => (typeof n === 'number' ? n.toLocaleString(I18N_LOCALE || 'zh-CN') : '—'); // OPT-14 · 1.2：跟随 locale 回落
// OPT-18 · 4.2 零值显性化：zstd 不可用时所有调用计数恒为 0（解不出帧），这个 0 是「测不到」
// 而不是「没人用」，直接上 0 会误导排查方向。核心计数统一改显示 '—'，原因由 decodeWarning 区解释。
const tailorNum = (n, rep) => (rep && rep.zstdSupported === false ? '—' : fmtInt(n));
// OPT-19 · 4.3：字节数格式化（1024 进制，ASCII 单位 B/KB/MB/GB，一位小数；<1KB 不出小数）。
const fmtBytes = (n) => {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return Math.round(n) + ' B';
  let v = n;
  for (const unit of ['KB', 'MB', 'GB']) {
    v /= 1024;
    if (v < 1024 || unit === 'GB') return v.toFixed(1) + ' ' + unit;
  }
  return n + ' B';
};
const fmtPct = (n) => (typeof n === 'number' && n > 0 ? (n * 100).toFixed(1) + '%' : '0%');
const fmtTax = (n) => (typeof n === 'number' && n > 0 ? '~' + n.toLocaleString(I18N_LOCALE || 'zh-CN') + ' tok' : '—'); // OPT-14 · 1.2
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

  const load = useCallback(async (force = false) => {
    setBusy(true);
    setError('');
    try {
      // P2-1：宿主侧 5 分钟缓存。普通挂载 / 切窗口吃缓存；「重扫」与动作后的刷新
      // 必须带 refresh:true —— 禁用/启用会改变注册表，吃缓存等于看旧账。
      const res = await call('toolTailor', { days, ...(force ? { refresh: true } : {}) });
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
      timer.timeout(() => load(true), 300);
    }
  };

  // 解压文本缓存只留读数，「清空缓存」按钮与它的整条动作链已删除（2026-10-23 实测）：
  //   · 反馈永远错：宿主 toolTailor 分支把 clearTextCache() 的返回值丢了，报告里的
  //     textCache 来自 textCacheStats()，根本没有 clearedBytes 这个键 → 面板成功分支只能落到
  //     兜底文案，点完之后浮层恒显示「正在清空缓存…」，看着像还在忙；
  //   · 占用不会降：那是「先清后扫」，快照取在扫描**之后**，同一发调用里 92 个日志重新解压
  //     回填，实测按下去前后都是 32 条 / 65.8 MB；
  //   · 而且这台机器上缓存本来就没在起作用：槽位 32、日志 92 个，淘汰按插入序而每轮按同序
  //     遍历全量，命中率 = max(0, 2×槽位 − 文件数) ÷ 文件数 = 0%（冷扫 1797ms / 热扫 1881ms）。
  // 结论是这个动作既不回收内存也不修任何东西，删掉。合成分 utilization（取字节与条数占比的
  // 较大者，本机恒 100%）一并从这行去掉 —— 它原本就是用来把用户推向这个已经不存在的按钮。
  const cacheLine = report && report.textCache && typeof report.textCache.entries === 'number'
    ? (() => {
        const cache = report.textCache;
        const fmtI = (n) => (typeof n === 'number' ? n.toLocaleString(I18N_LOCALE || 'zh-CN') : '—');
        return h('div', { className: 'dsh-mcp-tailor-cache' },
          h('span', { className: 'dsh-mcp-tailor-cache-label' }, t('账本缓存')),
          h('span', null, fmtBytes(cache.bytes) + ' · ' + fmtI(cache.entries) + '/' + fmtI(cache.maxEntries) + t(' 条')),
        );
      })()
    : null;

  const tools = report && Array.isArray(report.tools) ? report.tools : [];
  // §6.4 技能维度：与工具表同一份账本、同一次扫描，只是把 skill 的参数里的名字拆出来。
  // 这一节回答的是工具表回答不了的问题——「注册了却一次没被调用」的是哪些技能。
  const skillRows = report && Array.isArray(report.skills) ? report.skills : [];
  const skillSection = (() => {
    // 没有报告时不留空壳；有报告但一条技能调用都没有、也没有解不出的调用时同样不占版面。
    if (!report) return null;
    const unparsed = typeof report.skillCallsUnparsed === 'number' ? report.skillCallsUnparsed : 0;
    if (skillRows.length === 0 && unparsed === 0) return null;
    const counted = typeof report.skillCalls === 'number' ? report.skillCalls : skillRows.reduce((sum, row) => sum + (row.calls || 0), 0);
    const summary = report.skillsRegistryAvailable === true
      ? t('技能账本：窗口内共 {0} 次 skill 调用；注册表 {1} 个技能中 {2} 个一次没被调用', [fmtInt(counted), fmtInt(report.skillRegisteredCount), fmtInt(report.skillNeverUsedCount)])
      : t('技能账本：窗口内共 {0} 次 skill 调用；注册表不可用，只列出日志里出现过的 {1} 个', [fmtInt(counted), fmtInt(skillRows.length)]);
    return h('div', null,
      h('div', { className: 'dsh-mcp-tailor-note' }, h('b', null, t('技能（skill 工具）')), summary),
      h('div', { className: 'dsh-mcp-tailor-table skills' },
        h('div', { className: 'dsh-mcp-tailor-row head' },
          h('span', { className: 't-name' }, t('技能')),
          h('span', { className: 't-num' }, t('调用')),
          h('span', { className: 't-num' }, t('错误 (率)')),
          h('span', { className: 't-tax' }),
          h('span', null, t('最后使用')),
          h('span', { className: 't-op', 'aria-label': t('操作') }),
        ),
        skillRows.length === 0
          ? h('div', { className: 'dsh-mcp-tailor-empty' }, t('暂无技能调用'))
          : skillRows.map((skill) => {
              const isDead = skill.calls === 0;
              const errRate = skill.errorRate || 0;
              // §7.1 行内禁用/释放：写 SKILL.md frontmatter 的 disable-model-invocation
              // 标志（宿主官方键，监听器自动生效，无需重启）。禁用 = 模型不再加载该技能，
              // 不再缴它的 Schema 税；手动 /引用 不受影响。按钮只给「注册表在、来源在
              // 白名单」的行——bundled / runtime / custom 与已卸载技能的历史调用没有
              // 可信写入口，按「不伪造控件」的口径不出按钮。
              const actionable = skillDisableActionable(skill);
              const isOff = skill.disabled === true;
              return h('div', { key: skill.name, className: 'dsh-mcp-tailor-row' + (isDead ? ' dead' : '') + (isOff ? ' off' : '') },
                h('span', { className: 't-name', title: skill.name },
                  skill.name,
                  isOff ? h('span', { className: 't-badge warn' }, t('已禁用')) : null,
                  isDead ? h('span', { className: 't-badge' }, t('一次没被调用')) : null,
                  errRate >= 0.5 ? h('span', { className: 't-badge err' }, t('高错误率')) : null,
                ),
                h('span', { className: 't-num' }, tailorNum(skill.calls, report)),
                h('span', { className: 't-num' + (errRate >= 0.5 ? ' bad' : '') },
                  skill.errors > 0 ? fmtInt(skill.errors) + ' (' + fmtPct(errRate) + ')' : fmtInt(skill.errors)),
                h('span', { className: 't-tax' }),
                h('span', { className: 't-last' }, fmtLast(skill.lastUsedMs, report.generatedAt)),
                h('span', { className: 't-op' },
                  actionable
                    ? h('button', {
                        type: 'button',
                        className: 'dsh-mcp-tailor-op' + (isOff ? ' release' : ''),
                        disabled: busy,
                        title: isOff ? t('恢复模型调用该技能') : t('禁用后模型不再加载该技能，不再缴它的上下文税；手动 /引用 不受影响'),
                        onClick: () => tailorAct(isOff ? 'enableSkill' : 'disableSkill', { name: skill.name }, isOff ? t('已释放技能 {0}', [skill.name]) : t('已禁用技能 {0}', [skill.name])),
                      }, isOff ? t('释放') : t('禁用'))
                    : null,
                ),
              );
            }),
      ),
      unparsed > 0
        ? h('div', { className: 'dsh-mcp-tailor-note' }, t('有 {0} 次 skill 调用的参数里没有技能名，未计入上表', [fmtInt(unparsed)]))
        : null,
    );
  })();
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
        ? t('{0} 个日志帧解码失败，调用计数可能偏低', [tailorNum(report.failedFrames, report)])
        : '';
  const scanFailures = report && Array.isArray(report.failedFileSamples) ? report.failedFileSamples : [];
  // §6.2 无 time 的调用事件：账本对这类事件的口径是「计进当前窗口」（见 tool-ledger.js 头注）。
  // 现在恒为 0，所以这行**不渲染**；等宿主日志格式一改、它变成非 0，界面必须当场说清楚
  // 「切窗口对这部分不生效」，否则症状又会退化成这次这种「数字看着不动但没人知道为什么」。
  const undatedWarning = report && report.undatedCalls > 0
    ? t('{0} 条调用事件没有可用的 time 字段，无法判定落在哪个窗口，已全部计入当前窗口（切换时间窗对这部分不生效）。', [fmtInt(report.undatedCalls)])
    : '';
  const truncatedWarning = report && report.wireTaxTruncated === true
    ? t('窗口内真实下发清单的种类数超过上限，税趋势线只覆盖前若干种。')
    : '';
  // 正常运行时这一段**完全不渲染**（无噪音），只有真出问题才占位。
  const decodeIssue = decodeWarning || scanFailures.length || undatedWarning || truncatedWarning
    ? h('div', { className: 'dsh-mcp-tailor-warn' },
        decodeWarning ? h('div', null, h('b', null, t('⚠ 数据可能不完整：')), decodeWarning) : null,
        report && report.zstdSupported === false
          ? h('div', null, t('当前运行在 Node {0}，请升级到 22.15 以上后重启宿主。', [report.nodeVersion || t('（未知版本）')]))
          : null,
        undatedWarning ? h('div', null, undatedWarning) : null,
        truncatedWarning ? h('div', null, truncatedWarning) : null,
        scanFailures.length
          ? h('details', { className: 'dsh-mcp-tailor-details' },
              h('summary', null, t('{0} 个日志文件未能读取（含超限跳过），展开看原因', [tailorNum(report.failedFiles, report)])),
              h('ul', null, scanFailures.map((sample, i) => h('li', { key: i }, sample))),
            )
          : null,
      )
    : null;

  // §6.4 两条「为什么这个数字不动」的归因，合成一条 note（无话可说时整块不渲染）：
  //   ① 窗口比本机日志还长 → 加长窗口必然无变化（实测这台机器只有 14 天日志，30 天与 90 天
  //      输出一字不差，而界面此前对此毫无提示）；
  //   ② 注册表快照与最近一次真实下发差得多 → 改了配置没生效 / 工具挂在别的作用域里读不到。
  // 阈值取「>500 tok 且 >5%」：Schema 长度的口径差有几十 tok 的正常噪声，压在阈值里就不会
  // 变成一条常驻假告警（假告警会把真告警教成背景噪音）。
  const attribution = (() => {
    if (!report) return null;
    const lines = [];
    if (typeof report.scannedSpanDays === 'number' && report.scannedSpanDays > 0 && report.windowDays > report.scannedSpanDays) {
      lines.push(t('窗口 {0} 天，但读到的调用记录只跨 {1} 天（最早一条是 {2}）；更早的部分本机没有日志，加长窗口不会改变任何数字。', [
        fmtInt(report.windowDays), fmtInt(report.scannedSpanDays), fmtLast(report.scannedEventsOldestMs, report.generatedAt),
      ]));
    }
    const divergence = report.wireTaxDivergenceTokens;
    if (typeof divergence === 'number' && report.taxTotalTokens > 0 && Math.abs(divergence) > Math.max(500, report.taxTotalTokens * 0.05)) {
      lines.push(divergence > 0
        ? t('注册表快照比最近一次真实下发多 ~{0} tok：多半是改完配置还没重启宿主，或项目级工具还没在当前会话注册。', [fmtInt(divergence)])
        : t('最近一次真实下发比注册表快照多 ~{0} tok：当前会话的工具集与面板读到的全局注册表不一致（可能来自项目级或子 Agent 作用域）。', [fmtInt(-divergence)]));
    }
    if (!lines.length) return null;
    return h('div', { className: 'dsh-mcp-tailor-note' }, lines.map((line, i) => h('div', { key: i }, line)));
  })();


  // §5.2 头部指标分层：原来四张同权重卡把「上下文税」和「调用总数」摆成一样大，
  // 于是用户读完四个数字仍然不知道最该动什么。真正需要行动的是「每轮白缴多少税」，
  // 它才是本页存在的理由；调用数只是背景。因此税单独放大居首，其余三个降为次级 KPI 行。
  // §5.4 趋势：dailyCalls 来自账本逐日分桶。全 0 或字段缺失时整块不渲染——
  // 画一排等高灰条假装有数据，比不画更误导。
  const daily = report && Array.isArray(report.dailyCalls) ? report.dailyCalls : [];
  const hasTrend = daily.length > 0 && daily.some((v) => v > 0);
  // §6.1 真实下发税。上面那个主数字（上下文税）是「当前注册表 Schema 长度」的纯函数，与时间
  // 无关 —— 于是「连着几天一模一样」既可能是真的没改过，也可能是界面读不出变化，两者在屏幕上
  // 长得完全一样（这正是本次排查的起因）。日志里每次请求都落了一份真实下发的工具清单，按天
  // 采样后税值第一次有了时间形状：变化 0 次 = 数字不动是事实，不是裁缝坏了。
  const wireDaily = report && Array.isArray(report.wireTaxDaily) ? report.wireTaxDaily : [];
  const hasWireTax = wireDaily.length > 0 && wireDaily.some((v) => v > 0);
  const wireLatest = report ? report.wireTaxLatest : null;
  const wireChanges = report && typeof report.wireTaxChangeCount === 'number' ? report.wireTaxChangeCount : null;

  const errRate = report && report.totalCalls > 0 ? report.totalErrors / report.totalCalls : 0;
  // 错误率阈值按文档口径：<5% 是常态（绿），≥5% 才值得红着显示。
  const errTone = errRate >= 0.05 ? 'err' : 'ok';
  const hero = h('div', { className: 'dsh-mcp-tailor-hero' },
    h('div', { className: 'dsh-mcp-tailor-main' },
      h('b', null, report ? fmtTax(report.deadMcpTaxTokens).replace(/^~/, '') : '—'),
      h('span', null, t('每轮请求白缴的上下文税')),
      h('span', { className: 'dsh-mcp-tailor-main-sub' },
        report
          ? t('{0} 个零调用 MCP 工具的 Schema，占全部工具税 {1} 的 {2}', [
              tailorNum(report.deadMcpCount, report), // OPT-18：zstd 不可用时 0 改 —
              fmtTax(report.taxTotalTokens),
              report.taxTotalTokens > 0 ? Math.round((report.deadMcpTaxTokens / report.taxTotalTokens) * 100) + '%' : '—',
            ])
          : t('扫描后给出'),
      ),
      hasTrend ? h('div', { className: 'dsh-mcp-tailor-trend' }, h(Spark, { series: daily, title: t('近 {0} 天每日调用量（左旧右新）', [days]) }), h('span', null, t('近 {0} 天每日调用', [days]))) : null,
      // §6.1 第二行趋势：真实下发税 + 清单变化次数 + 最近一次下发的规模。三件事合成一行，
      // 免得「每日调用」和「每轮税」两张 sparkline 各自带一句标签，把 hero 卡撑散。
      hasWireTax ? h('div', { className: 'dsh-mcp-tailor-trend' },
        h(Spark, { series: wireDaily, title: t('近 {0} 天每轮真实下发的工具税（左旧右新）', [days]) }),
        h('span', null, wireChanges === 1 ? t('每轮下发清单在 {0} 天内一次没变', [days]) : t('每轮下发清单变化 {0} 次', [wireChanges])),
        wireLatest ? h('span', null, t('最近一次 {0} 个工具 ~{1} tok（{2}）', [fmtInt(wireLatest.toolCount), fmtInt(wireLatest.tokens), fmtLast(wireLatest.atMs, report.generatedAt)])) : null,
      ) : null,

    ),
    h('div', { className: 'dsh-mcp-tailor-kpis' },
      // OPT-18：四张 KPI 的数字都随报告来，zstd 不可用时 0 是「测不到」→ 统一 tailorNum。
      h('div', { className: 'dsh-mcp-tailor-kpi' }, h('b', null, tailorNum(report ? report.totalCalls : null, report)), h('span', null, t('调用 {0} 次', [days + t(' 天')]))),
      h('div', { className: 'dsh-mcp-tailor-kpi' }, h('b', null, tailorNum(report ? report.toolCount : null, report)), h('span', null, t('出现过的工具（含已卸载 MCP 的历史调用）'))),
      // 零调用卡可点：点击即切「只看零调用」。原来这个筛选按钮在下行工具栏，
      // 用户看到「183 零调用」后得自己去别处找入口，关联断了。
      h('button', {
        type: 'button',
        className: 'dsh-mcp-tailor-kpi dead clickable',
        'aria-pressed': onlyDead,
        title: onlyDead ? t('取消「只看零调用」') : t('只看窗口内零调用的工具'),
        onClick: () => setOnlyDead((v) => !v),
      }, h('b', null, tailorNum(report ? report.deadMcpCount : null, report)), h('span', null, onlyDead ? t('零调用的 MCP 工具（已筛选）') : t('零调用的 MCP 工具 · 点击下钻'))),
      h('div', { className: 'dsh-mcp-tailor-kpi ' + errTone }, h('b', null, fmtPct(errRate)), h('span', null, t('总体错误率（{0} 次失败）', [tailorNum(report ? report.totalErrors : null, report)]))),
    ),
  );

  return h('div', { className: 'dsh-mcp-tailor' },
    hero,
    h('div', { className: 'dsh-mcp-tailor-toolbar' },
      TAILOR_WINDOWS.map((w) =>
        h('button', { key: w.key, type: 'button', className: 'dsh-mcp-btn' + (windowKey === w.key ? ' primary' : ''), onClick: () => setWindowKey(w.key) }, w.label),
      ),
      h('button', { type: 'button', className: 'dsh-mcp-btn' + (onlyDead ? ' primary' : ''), onClick: () => setOnlyDead((v) => !v), title: t('只看窗口内零调用的工具（默认关闭：默认显示全部工具与真实调用次数）') }, report ? t('只看零调用（{0}）', [tailorNum(deadToolCount, report)]) : t('只看零调用')),
      h('button', { type: 'button', className: 'dsh-mcp-btn', onClick: () => load(true), disabled: busy }, t('重扫')),
      h('span', { className: 'dsh-mcp-tailor-meta' }, metaText),
    ),
    // 账本缓存读数（只读，动作已删；见 cacheLine 上方注释）。
    cacheLine,
    error ? h('div', { className: 'dsh-mcp-tailor-note' }, t('账本加载失败：'), fmtScanError(error)) : null,
    // 解码告警放在数据和表格**上方**：调用数整列 0 时，用户第一眼要能看到「为什么」。
    decodeIssue,
    attribution,

    actionError ? h('div', { className: 'dsh-mcp-tailor-note' }, actionError) : null,
    flashMsg ? h('div', { className: 'dsh-mcp-tailor-note' }, flashMsg) : null,
    h('div', { className: 'dsh-mcp-tailor-table' },
      h('div', { className: 'dsh-mcp-tailor-row head' },
        h('span', { className: 't-name' }, t('工具')),
        h('span', { className: 't-num' }, t('调用')),
        // §5.1 合并「错误 / 错误率」两列：这两列永远同源（率 = 错误/调用），
        // 分开列只会让同一份信息占两格宽度，还逼出了横向挤压。合并成「7 (0.7%)」。
        h('span', { className: 't-num' }, t('错误 (率)')),
        h('span', { className: 't-tax' }, t('Schema 税')),
        h('span', null, t('最后使用')),
        h('span', { className: 't-op', 'aria-label': t('操作') }),
      ),
      shown.length === 0
        ? h('div', { className: 'dsh-mcp-tailor-empty' }, onlyDead && report ? t('窗口内没有零调用的工具（共 {0} 个工具都有调用，关掉「只看零调用」即可看全部）', [fmtInt(report.toolCount)]) : (busy ? t('扫描中…') : t('暂无数据')))
        : shown.map((tool) => {
            const actionable = tool.kind === 'mcp' && tool.server;
            const isDead = tool.calls === 0;
            const errRate = tool.errorRate || 0;
            // §5.3 行尾 ⋯ 菜单：原来「禁用服务器 / 启用」两个按钮直铺在行尾，
            // 对非 MCP 行完全没有意义，却每行都占掉一截宽度。收进菜单后，
            // 默认行尾只剩一个 24px 图标，且能把「复制工具名」这类零散动作一并收进去。
            const menuItems = [
              ...(actionable
                ? [
                    tool.serverDisabled
                      ? { label: t('启用服务器 {0}', [tool.server]), onClick: () => tailorAct('enable', tool.server, t('已启用 {0}', [tool.server])), disabled: busy }
                      : { label: t('禁用服务器 {0}', [tool.server]), onClick: () => tailorAct('disable', tool.server, t('已禁用 {0}', [tool.server])), disabled: busy, danger: true },
                  ]
                : []),
              { label: t('复制工具名'), onClick: () => { try { navigator.clipboard?.writeText?.(tool.name); flash(t('已复制「{0}」', [tool.name])); } catch { flash(t('复制失败'), 'err'); } } },
            ];
            return h('div', { key: tool.name, className: 'dsh-mcp-tailor-row' + (isDead ? ' dead' : '') },
              h('span', { className: 't-name', title: tool.name },
                tool.server ? h('span', { className: 't-badge' }, tool.server) : null,
                tool.server ? tool.leaf : tool.name,
                tool.serverDisabled ? h('span', { className: 't-badge warn' }, t('已禁用')) : null,
                errRate >= 0.5 ? h('span', { className: 't-badge err' }, t('高错误率')) : null,
              ),
              h('span', { className: 't-num' }, fmtInt(tool.calls)),
              // 合并列：错误数为 0 时只显示 0，不补一个没信息量的 (0%)。
              h('span', { className: 't-num' + (errRate >= 0.5 ? ' bad' : '') },
                tool.errors > 0 ? fmtInt(tool.errors) + ' (' + fmtPct(errRate) + ')' : fmtInt(tool.errors)),
              // §5.1 Schema 税为「—」时不留占位符，直接空着：一串横杠只会让列看起来像坏了。
              h('span', { className: 't-tax' }, tool.schemaTokens ? fmtTax(tool.schemaTokens) : ''),
              h('span', { className: 't-last' }, fmtLast(tool.lastUsedMs, report ? report.generatedAt : undefined)),
              h('span', { className: 't-op' }, h(RowMenu, { label: t('操作'), items: menuItems })),
            );
          }),
    ),
    // §6.4 技能账本。放在工具表**下方**而不是另一页：读者是同一个问题——「谁在干活、谁在占位」
    // 的第二个切面。零调用的技能行沿用工具表 `.dead` 的底色约定，读法不必重新学一遍。
    skillSection,
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
  { key: 'expert', get label() { return t('专家'); }, icon: 'expert' },
  { key: 'tailor', get label() { return t('工具裁缝'); }, icon: 'scissors' },
  { key: 'wb', get label() { return t('市场'); }, icon: 'store' },
];
// 分类摘要文案表：把「这一页到底有什么」压成一句话 + 两三行事实。
// 拆成纯数据而不是写在渲染里，是因为它同时被 hover 浮层和键盘焦点复用，
// 且后面加分类时只要补一条，不必改渲染逻辑。
const CATEGORY_BLURB = {
  get mcp() { return t('按服务器看工具清单、连接状态与参数；可增删、重连、导入。'); },
  get skill() { return t('本地 Skill 清单：来源、是否启用、是否可被模型调用。'); },
  get expert() { return t('已召唤的专家：人设、捆绑技能、当前在场状态，可送还。'); },
  get tailor() { return t('工具使用账本：谁在被调用、谁在白缴上下文税。'); },
  get wb() { return t('市场：连接器、SkillHub 技能与专家召唤。'); },
};
// §1.1 分类 hover 摘要。定位由父层算好（left），这里只负责内容与外观。
// 只用 pointer-events:none 的只读浮层：不承载交互，因此不需要焦点陷阱，
// 也不会在鼠标移向浮层时闪烁（移向浮层必然先离开 chip，浮层直接收起）。
const CatHintPopover = ({ hint, category, counts }) => {
  const cat = BOARD_CATEGORIES.find((c) => c.key === hint.key);
  if (!cat) return null;
  const facts = [];
  if (hint.key === 'mcp' && counts.mcp !== null) facts.push([t('服务器'), counts.mcp]);
  if (hint.key === 'skill' && counts.skill !== null) facts.push([t('Skill'), counts.skill]);
  if (hint.key === 'expert' && counts.expert !== null) facts.push([t('已召唤'), counts.expert]);
  // 市场计数是「本地缓存的连接器条数」：进过市场才有数（null 时不显示这行）。
  if (hint.key === 'wb' && Number.isFinite(counts.wb)) facts.push([t('连接器'), counts.wb]);
  const tailor = counts.tailor;
  if (hint.key === 'tailor' && tailor) {
    if (typeof tailor.deadMcpCount === 'number') facts.push([t('零调用工具'), tailor.deadMcpCount]);
    if (typeof tailor.totalCalls === 'number') facts.push([t('窗口内调用'), tailor.totalCalls]);
  }
  return h('div', { className: 'dsh-mcp-cat-pop', style: { left: hint.left + 'px' }, role: 'presentation' },
    h('b', null, cat.label),
    h('span', null, CATEGORY_BLURB[cat.key] || ''),
    facts.length ? h('div', { className: 'dsh-mcp-cat-pop-facts' }, facts.map(([label, value]) => h('div', { key: label }, h('i', null, label), h('b', null, fmtInt(value))))) : null,
    // 页脚只在「不是当前页」时提示点击——已选中的页再提示"点击打开"是噪音。
    category !== hint.key ? h('div', { className: 'dsh-mcp-cat-pop-foot' }, t('点击切换到此分类')) : null,
  );
};
// ── 自定义套件（Skill 看板）：管理弹窗 + 跨组件打开总线 ─────────────────────
// 一个套件 = 一组相关 skill 的**有序**命名组合；在输入框的引用菜单里点一次套件，等于把
// 成员的 /name 逐个插进草稿（纯插件侧展开，宿主零改动）。数据层 lib/suites-registry.js
// （~/.dsh/armory/suites.json），通道 listSkillSuites / saveSkillSuites。
// 两条必须遵守的分工：
//   ① 保存是**整集合覆盖**：右侧列表就是全部真相，删除 = 从列表里拿掉再保存；
//   ② id 由**数据层**分配：新建条目在本地只有 `local-N` 临时 id（只为 React key 与选中态
//      服务），提交前置空，保存成功后以返回值刷新看板副本——拿旧副本再存一次，同一套件
//      会分裂成两条。
// save 的传输错误翻译复用紧随其后的 skillTransportHint（404 = 宿主还没重启）。
const SUITE_LOCAL_ID_PREFIX = 'local-';
// 与 lib/suites-registry.js 的同名常量同值：写侧对超长是「放行 + 截断」，这里在输入时就
// 限住，免得用户写满两百字、保存后才发现被截断。改一处请同时改另一处。
const SUITE_NAME_MAX = 40;
const SUITE_DESC_MAX = 120;
const SUITE_MEMBERS_MAX = 40;
const SUITES_MAX = 100;

// 打开弹窗的两段式总线（与 pendingSkillFocus / pendingBoardCategory 完全同一套语义）：
// 召唤菜单的「管理套件…」也要能开这个弹窗，而弹窗挂在 SkillBoard 里。看板已挂载 → 直接
// 广播；没挂载（用户在会话界面点的）→ 意图先记在模块里，SkillBoard 挂载后自领，随后
// openBoardCategory('skill') 把看板切到 Skill 分类（它自己会 selectPanel，不必再开一次）。
let pendingSuiteOpen = false;
const suiteOpenListeners = new Set();
function openSuiteManager() {
  pendingSuiteOpen = true;
  for (const listener of [...suiteOpenListeners]) {
    try { listener(); } catch { /* 单个订阅者失败不影响弹窗本身 */ }
  }
  openBoardCategory('skill');
}
const onSuiteOpenRequest = (listener) => {
  suiteOpenListeners.add(listener);
  return () => { suiteOpenListeners.delete(listener); };
};

// 提交给数据层的形状：本地临时 id 置空（写侧分配真 id），已有的 id / 时间戳原样带上
// （updatedAt 由调用方决定 → 同一 payload 重放得到同一结果，写侧幂等）。
const suitePayloadOf = (rows) => (Array.isArray(rows) ? rows : []).map((suite) => ({
  id: String(suite.id || '').startsWith(SUITE_LOCAL_ID_PREFIX) ? '' : String(suite.id || ''),
  name: String(suite.name || ''),
  desc: String(suite.desc || ''),
  members: Array.isArray(suite.members) ? [...suite.members] : [],
  ...(suite.createdAt ? { createdAt: suite.createdAt } : {}),
  ...(suite.updatedAt ? { updatedAt: suite.updatedAt } : {}),
}));
// 工作副本的一条：字段全部拉成确定形状，编辑时不必再逐处判空。
const cloneSuiteRow = (suite) => ({
  id: String(suite?.id || ''),
  name: String(suite?.name || ''),
  desc: String(suite?.desc || ''),
  members: Array.isArray(suite?.members) ? suite.members.map((name) => String(name)) : [],
  createdAt: Number(suite?.createdAt) || 0,
  updatedAt: Number(suite?.updatedAt) || 0,
});

const SuiteManager = ({ call, skills, catOf, suites, onClose, onSaved, notify }) => {
  const skillRows = Array.isArray(skills) ? skills : [];
  // 弹窗内所有编辑都落在 draft 上，「保存」才整集合提交；取消 = 直接丢弃 draft。
  // 只在挂载时从 props 拷一次：弹窗打开期间唯一的写入者就是它自己，不需要反向同步。
  const [draft, setDraft] = useState(() => (Array.isArray(suites) ? suites.map(cloneSuiteRow) : []));
  const [selId, setSelId] = useState(() => (Array.isArray(suites) && suites.length ? String(suites[0].id || '') : ''));
  const [pickCat, setPickCat] = useState('all');
  const [pickQuery, setPickQuery] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [flashMsg, setFlashMsg] = useState(null);   // { msg, ok }：弹窗内的小反馈
  const [armDel, setArmDel] = useState('');         // 两段式删除：已 arm 的套件 id
  const [dropIndex, setDropIndex] = useState(null); // 拖拽插入位（null = 不画指示线）
  const [zoneOver, setZoneOver] = useState(false);
  const [dragging, setDragging] = useState('');     // 拖动中的来源标记（半透明视觉）
  const dragRef = useRef(null);        // { kind: 'skill', name } | { kind: 'member', index }
  const localSeq = useRef(0);
  const flashTimer = useRef(null);
  const armTimer = useRef(null);
  const nameRef = useRef(null);
  const modalRef = useRef(null);
  useFocusTrap(modalRef, true);
  useEffect(() => () => {
    if (flashTimer.current) clearTimeout(flashTimer.current);
    if (armTimer.current) clearTimeout(armTimer.current);
  }, []);

  const flash = (msg, ok = true) => {
    setFlashMsg({ msg, ok });
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashMsg(null), 2400);
  };

  // 分类：优先用看板已经算好的 catOf（同一份映射，两处判定不会漂移），缺席时现算。
  const skillByName = useMemo(() => {
    const map = new Map();
    for (const s of skillRows) map.set(s.name, s);
    return map;
  }, [skills]);
  const catFor = (skill) => (skill ? ((catOf && catOf.get(skill.name)) || skillCategoryOf(skill)) : SKILL_UNCAT);
  const catOfName = (name) => catFor(skillByName.get(name));

  // 左栏：分类轨道计数固定全量（与看板决策 9 同口径，不随搜索联动），列表随搜索/分类筛。
  const pickCounts = useMemo(() => {
    const list = Array.isArray(skills) ? skills : [];
    const map = new Map([['all', list.length]]);
    for (const s of list) {
      const cat = (catOf && catOf.get(s.name)) || skillCategoryOf(s);
      map.set(cat.key, (map.get(cat.key) || 0) + 1);
    }
    return map;
  }, [skills, catOf]);
  const pickList = useMemo(() => {
    const list = Array.isArray(skills) ? skills : [];
    const q = pickQuery.trim().toLowerCase();
    return list.filter((s) => {
      if (pickCat !== 'all') {
        const cat = (catOf && catOf.get(s.name)) || skillCategoryOf(s);
        if (cat.key !== pickCat) return false;
      }
      if (q && !(String(s.name || '') + ' ' + String(s.description || '')).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [skills, catOf, pickCat, pickQuery]);

  const cur = draft.find((s) => s.id === selId) || null;
  const curMembers = cur && Array.isArray(cur.members) ? cur.members : [];

  const patchCur = (patch) => {
    if (!cur) return;
    setDraft((prev) => prev.map((s) => (s.id === cur.id ? { ...s, ...patch } : s)));
    setDirty(true);
  };

  // 无拖拽替代路径（也是唯一的键盘路径）：点卡片上的 + 把 skill 加进当前套件。
  const addMember = (name, at) => {
    if (!cur) { flash(t('先在右侧选择一个套件，或点「新建套件」'), false); return; }
    if (curMembers.includes(name)) { flash(t('「{0}」已在这个套件里', [name]), false); return; }
    if (curMembers.length >= SUITE_MEMBERS_MAX) { flash(t('成员已达上限 {0} 个', [SUITE_MEMBERS_MAX]), false); return; }
    const members = [...curMembers];
    members.splice(typeof at === 'number' && at >= 0 && at <= members.length ? at : members.length, 0, name);
    patchCur({ members });
    flash(t('已加入「{0}」', [name]));
  };
  const removeMember = (index) => {
    if (!cur) return;
    patchCur({ members: curMembers.filter((_, i) => i !== index) });
  };
  const moveMember = (from, to) => {
    if (!cur || from < 0 || from >= curMembers.length) return;
    const members = [...curMembers];
    const [moved] = members.splice(from, 1);
    // 指示线下标是按**移动前**的数组算的：来源在目标之前时，抽出来源后目标整体前移一位。
    const target = Math.max(0, Math.min(from < to ? to - 1 : to, members.length));
    members.splice(target, 0, moved);
    patchCur({ members });
  };

  // ── 拖拽（HTML5 DnD）：载荷真源是 dragRef，dataTransfer 只作跨容器兜底 ─────────
  const startSkillDrag = (e, name) => {
    dragRef.current = { kind: 'skill', name };
    setDragging('skill:' + name);
    try {
      if (e.dataTransfer) { e.dataTransfer.setData('text/plain', name); e.dataTransfer.effectAllowed = 'copy'; }
    } catch { /* 个别浏览器限制 setData 时机；本组件不依赖它 */ }
  };
  const startMemberDrag = (e, index) => {
    dragRef.current = { kind: 'member', index };
    setDragging('member:' + index);
    try {
      if (e.dataTransfer) { e.dataTransfer.setData('text/plain', String(index)); e.dataTransfer.effectAllowed = 'move'; }
    } catch { /* 同上：dragRef 是真源 */ }
  };
  const endDrag = () => { dragRef.current = null; setDragging(''); setDropIndex(null); setZoneOver(false); };
  const onRowDragOver = (e, index) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    setZoneOver(true);
    setDropIndex(e.clientY < rect.top + rect.height / 2 ? index : index + 1);
  };
  const onZoneDrop = (e) => {
    e.preventDefault();
    const payload = dragRef.current;
    const at = dropIndex === null ? curMembers.length : dropIndex;
    endDrag();
    if (!payload || !cur) return;
    if (payload.kind === 'skill') addMember(payload.name, at);
    else moveMember(payload.index, at);
  };

  const newSuite = () => {
    if (draft.length >= SUITES_MAX) { flash(t('套件数量已达上限 {0} 个', [SUITES_MAX]), false); return; }
    localSeq.current += 1;
    const id = SUITE_LOCAL_ID_PREFIX + localSeq.current;
    setDraft((prev) => [...prev, { id, name: '', desc: '', members: [], createdAt: 0, updatedAt: 0 }]);
    setSelId(id);
    setDirty(true);
    setArmDel('');
    setSaveError('');
    // 名称框要等这一帧渲染完才存在（编辑器随 selId 重渲染），聚焦放到下一帧。
    requestAnimationFrame(() => { if (nameRef.current) nameRef.current.focus(); });
  };
  // 两段式删除：第一次点变「确认?」（2.6s 后自动收回），第二次点才真删。删除只改 draft，
  // 落盘要等「保存」——所以文案是「保存后生效」，误删可以在关窗前反悔（取消即回滚）。
  const armDelete = (id) => {
    if (armDel !== id) {
      setArmDel(id);
      if (armTimer.current) clearTimeout(armTimer.current);
      armTimer.current = setTimeout(() => setArmDel(''), 2600);
      return;
    }
    if (armTimer.current) clearTimeout(armTimer.current);
    setArmDel('');
    const next = draft.filter((s) => s.id !== id);
    setDraft(next);
    if (selId === id) setSelId(next.length ? next[0].id : '');
    setDirty(true);
    flash(t('已删除套件（保存后生效）'), false);
  };

  const attemptClose = () => {
    if (saving) return;
    // 「已放弃未保存的修改」必须由看板来说：弹窗一关自己就卸载了，反馈留在弹窗里等于没有。
    if (dirty && typeof notify === 'function') notify(t('已放弃未保存的修改'), false);
    onClose();
  };

  const save = async () => {
    // 前置校验与写侧同口径（无名 / 空成员都属「拒绝」档），先在界面上挡住并跳到那一条：
    // 写侧的错误消息里只有序号，用户还得自己数是第几条。
    const unnamed = draft.find((s) => !String(s.name || '').trim());
    if (unnamed) {
      setSelId(unnamed.id);
      flash(t('有套件还没起名'), false);
      requestAnimationFrame(() => { if (nameRef.current) nameRef.current.focus(); });
      return;
    }
    const hollow = draft.find((s) => !Array.isArray(s.members) || !s.members.length);
    if (hollow) {
      setSelId(hollow.id);
      flash(t('套件「{0}」还没有成员', [hollow.name]), false);
      return;
    }
    setSaving(true);
    setSaveError('');
    let res = null;
    try {
      res = await call('saveSkillSuites', { suites: suitePayloadOf(draft) });
    } catch (e) {
      setSaving(false);
      setSaveError(skillTransportHint(String((e && e.message) || e)));
      return;
    }
    if (res && res.ok) {
      const saved = Array.isArray(res.suites) ? res.suites : [];
      setSaving(false);
      setDirty(false);
      // 先把返回值交出去再关窗：新分配的 id 只在这里出现，看板用它刷新副本与计数徽标。
      if (typeof onSaved === 'function') onSaved(saved);
      if (typeof notify === 'function') notify(t('套件已保存（{0} 个）', [saved.length]), true);
      onClose();
      return;
    }
    setSaving(false);
    setSaveError(skillTransportHint((res && res.error) || t('保存失败：宿主没有回包')));
  };

  // 成员行 + 拖拽插入指示线：指示线是普通行元素（不是独立容器），成员区始终只有一个滚动区。
  const memberCells = [];
  curMembers.forEach((name, index) => {
    if (dropIndex === index) memberCells.push(h('div', { key: '__dl__' + index, className: 'drop-line' }));
    const cat = catOfName(name);
    // 注册表里查不到 = 该 skill 已被移动 / 删除 / 不在当前作用域。成员保留（用户可能只是
    // 暂时切了作用域），但如实标「已失效」——引用时宿主插进去的 /name 命中不了任何技能。
    const missing = !skillByName.has(name);
    memberCells.push(h('div', {
      key: name,
      className: 'member-row' + (dragging === 'member:' + index ? ' dragging' : ''),
      draggable: true,
      title: missing ? t('宿主当前找不到这个 skill（可能已移动或删除），引用时会失效') : name,
      onDragStart: (e) => startMemberDrag(e, index),
      onDragEnd: endDrag,
      onDragOver: (e) => onRowDragOver(e, index),
    },
      h('span', { className: 'idx' }, index + 1),
      h('span', { className: 'grip', 'aria-hidden': true }, h(Icon, { d: ICONS.grip, size: 11 })),
      h('span', { className: 'tile', style: { background: cat.color } }),
      h('span', { className: 'nm' }, name),
      h('span', { className: 'cat' + (missing ? ' gone' : '') }, missing ? t('已失效') : cat.name),
      h('button', {
        type: 'button', className: 'rm', title: t('移除'), 'aria-label': t('移除 {0}', [name]),
        onClick: () => removeMember(index),
      }, h(Icon, { d: ICONS.x, size: 10 })),
    ));
  });
  if (cur && dropIndex === curMembers.length) memberCells.push(h('div', { key: '__dl__end', className: 'drop-line' }));

  return h('div', {
    className: 'dsh-mcp-overlay',
    onMouseDown: (e) => { if (e.target === e.currentTarget) attemptClose(); },
  },
    h('div', {
      ref: modalRef,
      className: 'dsh-mcp-modal suites',
      role: 'dialog',
      'aria-modal': true,
      'aria-label': t('套件管理'),
      tabIndex: -1,
      onKeyDown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); attemptClose(); } },
    },
      h('header', { className: 'suite-head' },
        h('div', { className: 'suite-head-text' },
          h('h3', null, t('套件管理')),
          h('p', { className: 'sub' }, t('把多个相关 skill 打包成套件；在输入框的引用菜单里点一次套件，等于同时引用全部成员。')),
        ),
        h('button', {
          type: 'button', className: 'suite-x', title: t('关闭'), 'aria-label': t('关闭'),
          disabled: saving, onClick: attemptClose,
        }, h(Icon, { d: ICONS.x, size: 14 })),
      ),
      h('div', { className: 'suite-body' },
        // ── 左：技能库选择器（分类轨道 + 搜索 + 可拖卡片）──
        h('div', { className: 'suite-left' },
          h('label', { className: 'suite-search' },
            h(Icon, { d: ICONS.search, size: 13 }),
            h('input', {
              value: pickQuery,
              placeholder: t('搜索 skill…'),
              'aria-label': t('搜索 skill'),
              onChange: (e) => setPickQuery(e.target.value),
            }),
          ),
          h('div', { className: 'dsh-mcp-skill-rail', role: 'tablist', 'aria-label': t('按分类过滤 skill') },
            SKILL_CATS.map((c) => h('button', {
              key: c.key,
              type: 'button',
              role: 'tab',
              'aria-selected': pickCat === c.key,
              className: 'dsh-mcp-skill-cat' + (pickCat === c.key ? ' on' : ''),
              onClick: () => setPickCat(c.key),
            },
              h('span', { className: 'dsh-mcp-skill-cat-dot', style: { background: c.color } }),
              c.name,
              h('span', { className: 'dsh-mcp-skill-cat-count' }, pickCounts.get(c.key) || 0),
            ))),
          skillRows.length === 0
            ? h('div', { className: 'member-empty' },
                h('span', { className: 'big' }, h(Icon, { d: ICONS.skill, size: 20 })),
                t('看板没有读到 skill 列表'),
                t('宿主未挂载 skill 注册表（@deepseek-ai/dsh-skill）时这里就是空的；套件仍能保存，但成员名要自己保证正确。'))
            : h('div', { className: 'suite-pick-list' },
                pickList.length === 0
                  ? h('div', { className: 'member-empty' }, t('没有符合筛选的 skill'))
                  : pickList.map((s) => {
                      const cat = catFor(s);
                      const inSuite = curMembers.includes(s.name);
                      return h('div', {
                        key: s.name,
                        className: 'suite-pick-card' + (inSuite ? ' in-suite' : '') + (dragging === 'skill:' + s.name ? ' dragging' : ''),
                        draggable: !!cur,
                        title: inSuite ? t('已在当前套件中') : t('拖到右侧成员区，或点 + 添加'),
                        onDragStart: (e) => startSkillDrag(e, s.name),
                        onDragEnd: endDrag,
                      },
                        h('span', { className: 'tile', style: { background: cat.color } }),
                        h('span', { className: 'body' },
                          h('span', { className: 'nm' }, s.name, h('span', { className: 'cat' }, cat.name)),
                          h('span', { className: 'ds' }, s.description || t('（无描述）')),
                        ),
                        h('span', { className: 'grip', 'aria-hidden': true }, h(Icon, { d: ICONS.grip, size: 12 })),
                        h('button', {
                          type: 'button',
                          className: 'add',
                          disabled: !cur,
                          title: inSuite ? t('已在套件中') : t('添加到当前套件'),
                          'aria-label': t('添加到当前套件'),
                          onClick: (e) => { e.stopPropagation(); addMember(s.name); },
                        }, inSuite ? '✓' : h(Icon, { d: ICONS.plus, size: 11 })),
                      );
                    })),
        ),
        // ── 右：套件列表 + 编辑器 ──
        h('div', { className: 'suite-right' },
          h('div', { className: 'suite-list-bar' },
            h('span', { className: 't' }, t('我的套件')),
            h('span', { className: 'sp' }),
            h(Btn, {
              cls: 'suite-new', icon: 'plus', disabled: saving, onClick: newSuite,
              title: t('新建一个空套件'), children: t('新建套件'),
            }),
          ),
          h('div', { className: 'suite-list' },
            draft.length === 0
              ? h('div', { className: 'member-empty' }, t('还没有套件：点右上「新建套件」开始'))
              : draft.map((s) => h('div', {
                  key: s.id,
                  className: 'suite-row' + (s.id === selId ? ' on' : ''),
                  // 行本身是 div[role=button] 而不是 <button>：里面还要放「删除」按钮，
                  // button 套 button 是无效 HTML（浏览器会拆节点，React 的树跟着错位）。
                  role: 'button',
                  tabIndex: 0,
                  'aria-pressed': s.id === selId,
                  onClick: () => { setSelId(s.id); setArmDel(''); },
                  onKeyDown: (e) => {
                    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelId(s.id); setArmDel(''); }
                  },
                },
                  h('span', { className: 'ic' }, h(Icon, { d: ICONS.layers, size: 13 })),
                  h('span', { className: 'nm' }, s.name || t('未命名套件')),
                  h('span', { className: 'stack', 'aria-hidden': true },
                    s.members.slice(0, 4).map((name) => h('i', { key: name, style: { background: catOfName(name).color } }))),
                  h('span', { className: 'ct' }, s.members.length),
                  h('button', {
                    type: 'button',
                    className: 'del' + (armDel === s.id ? ' arm' : ''),
                    disabled: saving,
                    title: armDel === s.id ? t('再点一次确认删除') : t('删除套件'),
                    onClick: (e) => { e.stopPropagation(); armDelete(s.id); },
                  }, armDel === s.id ? t('确认?') : t('删除')),
                ))),
          cur
            ? h('div', { className: 'suite-editor' },
                h('div', { className: 'fields' },
                  h('div', { className: 'field' },
                    h('label', { htmlFor: 'dsh-suite-name' }, t('套件名称')),
                    h('input', {
                      id: 'dsh-suite-name',
                      ref: nameRef,
                      value: cur.name,
                      maxLength: SUITE_NAME_MAX,
                      placeholder: t('例如：演示视频流水线'),
                      onChange: (e) => patchCur({ name: e.target.value }),
                    }),
                  ),
                  h('div', { className: 'field' },
                    h('label', { htmlFor: 'dsh-suite-desc' }, t('说明（可选，显示在引用菜单条目右侧）')),
                    h('input', {
                      id: 'dsh-suite-desc',
                      value: cur.desc,
                      maxLength: SUITE_DESC_MAX,
                      placeholder: t('一句话说明这套技能干什么'),
                      onChange: (e) => patchCur({ desc: e.target.value }),
                    }),
                  ),
                ),
                h('div', {
                  className: 'member-zone' + (zoneOver ? ' over' : ''),
                  onDragOver: (e) => {
                    e.preventDefault();
                    setZoneOver(true);
                    // 空成员区没有行可测几何：整个区域就是一个放置点（追加到末尾）。
                    if (!curMembers.length) setDropIndex(0);
                  },
                  onDragLeave: (e) => {
                    if (!e.currentTarget.contains(e.relatedTarget)) { setZoneOver(false); setDropIndex(null); }
                  },
                  onDrop: onZoneDrop,
                },
                  h('div', { className: 'zh' },
                    h(Icon, { d: ICONS.layers, size: 12 }),
                    h('b', null, t('成员技能')),
                    h('span', null, t('{0} 个 · 拖拽可排序', [curMembers.length])),
                  ),
                  h('div', { className: 'member-list' },
                    curMembers.length === 0
                      ? h('div', { className: 'member-empty' },
                          h('span', { className: 'big' }, h(Icon, { d: ICONS.grip, size: 20 })),
                          t('把左侧卡片拖到这里'),
                          t('拖不动时，悬停卡片点 + 也能加进来'))
                      : memberCells),
                ),
              )
            : h('div', { className: 'suite-editor' },
                h('div', { className: 'member-empty' },
                  h('span', { className: 'big' }, h(Icon, { d: ICONS.layers, size: 20 })),
                  t('选择右上列表里的一个套件，或点「新建套件」'),
                  t('套件 = 一组相关 skill 的引用打包')),
              ),
        ),
      ),
      h('div', { className: 'suite-foot' },
        h('span', { className: 'hint' },
          h(Icon, { d: ICONS.grip, size: 12 }),
          h('span', null, t('拖左侧卡片到成员区即可添加；成员可上下拖拽排序，+ / × 是无拖拽的替代路径。')),
        ),
        saveError
          ? h('span', { className: 'err', role: 'alert', title: saveError }, saveError)
          : (dirty ? h('span', { className: 'dirty' }, h('i', null), t('未保存')) : null),
        h(Btn, { onClick: attemptClose, disabled: saving, children: t('取消') }),
        h(Btn, {
          cls: 'primary', onClick: save, disabled: saving,
          title: t('整集合覆盖保存：右侧列表就是全部套件'),
          children: saving ? t('保存中…') : t('保存套件'),
        }),
      ),
      flashMsg ? h('div', { className: 'dsh-mcp-toast ' + (flashMsg.ok ? 'ok' : 'err') }, flashMsg.msg) : null,
    ),
  );
};

// 宿主侧接口不存在（HTTP 404 / transport failure）几乎总是「宿主还没重启」：
// 客户端 bundle 从磁盘现读、改完刷新即生效，而宿主的 Remote 方法在启动时才注册。
// 这里把生硬的传输错误翻译成可操作的提示，而不是让用户对着 404 猜。
const skillTransportHint = (message) =>
  /404|transport failure/i.test(String(message))
    ? String(message) + t('　——宿主还没注册 skill 接口：重启 DeepSeek Harness 让宿主侧生效后即可')
    : String(message);

// Skill 集合变更总线：市场安装/卸载、看板卸载都会改磁盘上的 skill 集合，但这些入口
// 与消费方不在一棵子树里——顶部数量角标在 McpBoardPage，列表在 SkillBoard，二者还
// 不同时挂载（分类是单选渲染）。没有总线时角标只在 McpBoardPage 首次挂载读一次，
// 装完必须离开整个看板再回来才更新。与 expertChangeListeners 同构：模块级 Set、
// 逐个 try（单个订阅者失败不影响其它）、返回退订函数；reason 只用于排查日志/测试。
const skillChangeListeners = new Set();
const emitSkillChange = (reason = '') => {
  for (const listener of [...skillChangeListeners]) {
    try { listener(reason); } catch { /* 单个订阅者失败不影响其它订阅者 */ }
  }
};
const onSkillChange = (listener) => {
  skillChangeListeners.add(listener);
  return () => { skillChangeListeners.delete(listener); };
};

// ── Skill 头像：确定性生成 ───────────────────────────────────────────
// 本地 skill 的数据里没有任何图标字段（宿主注册表只给能力位与来源目录），而市场页
// 每张卡都有一个圆形头像位。为了同一观感，这里从 skill 名哈希出固定色相，画
// 「渐变圆 + 首字母」的生成头像：零网络、同一名永远同色、不同 skill 之间色相可辨。
// 只做渲染期纯计算，不发请求也不登记 avatarRegistry —— 那条链是给真图片探活用的。
const skillAvatarHue = (name) => {
  const text = String(name || '');
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  return hash % 360;
};
const SkillAvatar = ({ name, size, title }) => {
  const hue = skillAvatarHue(name);
  const letter = String(name || '?').slice(0, 1).toUpperCase() || '?';
  return h('span', {
    className: `dsh-mcp-skill-avatar${size ? ` ${size}` : ''}`,
    style: {
      background: `linear-gradient(135deg, hsl(${hue} 64% 56%), hsl(${(hue + 38) % 360} 64% 42%))`,
    },
    title,
    'aria-hidden': true,
  }, letter);
};

// ── Skill 真图标：目录名反推 + SkillHub 精确补全 ────────────────────────────
// 市场卡有真图标，本地 skill 的行数据里没有。真图标的来源有两层，按可信度取用：
//   ① wbexpert 捆绑技能：安装目录名 `wbexpert__<plugin>__<skill>` 里的 plugin 能在
//      专家目录里查到头像（与已召唤页同源）。listSkills 行带 path，这里从 path 尾段解析。
//   ② 其余技能（SkillHub / clawhub 装的）：真图标只在 SkillHub 目录里有——按名字做一次
//      keyword 查询，**slug 精确相等**才采纳（绝不按模糊命中张冠李戴）。纪律与头像探活
//      同一套：模块级缓存（同一名本次会话只查一次）、失败粘住（''）、同时在途 ≤3、
//      按登记顺序排队。查询是宿主侧 keyword GET（自带 15s 超时），47 个技能 ≈ 市场翻两页。
// 两层都没有 → SkillAvatar 生成头像兜底，永不空圈。
const SKILL_DIR_EXPERT_RE = /^wbexpert__([a-z0-9_-]+?)__/i;
/** path 尾段目录名解析出真图标；解析不出或目录里查不到该 plugin → ''（交给下一层）。 */
const skillIconFromDir = (path, expertByPlugin) => {
  const base = String(path || '').trim().replace(/[\\/]+$/, '');
  const dir = base.split(/[\\/]/).pop() || '';
  const match = dir.match(SKILL_DIR_EXPERT_RE);
  return (match && expertByPlugin.get(match[1])) || '';
};

const skillIconCache = new Map();          // name → url（'' = 查过、没有）
const skillIconQueued = new Set();         // 已入队（含在途）
const skillIconQueue = [];                 // FIFO，与头像闸门同一口径
let skillIconInflight = 0;
const skillIconWaiters = new Set();        // (name) => void：结果落地后通知组件重绘
const SKILL_ICON_INFLIGHT_MAX = 3;

const skillIconFinish = (name, url) => {
  skillIconCache.set(name, String(url || ''));
  skillIconQueued.delete(name);
  for (const notify of [...skillIconWaiters]) {
    try { notify(name); } catch { /* 单个订阅者失败不影响其它 */ }
  }
};

const skillIconDrain = (call) => {
  while (skillIconInflight < SKILL_ICON_INFLIGHT_MAX && skillIconQueue.length) {
    const name = skillIconQueue.shift();
    skillIconInflight += 1;
    call('wbSkillCatalog', { keyword: name, pageSize: 5 })
      .then((res) => {
        const rows = res && res.ok && Array.isArray(res.skills) ? res.skills : [];
        const hit = rows.find((row) => row && (row.slug === name || row.canonical === name) && row.iconUrl);
        skillIconFinish(name, hit ? hit.iconUrl : '');
      })
      .catch(() => skillIconFinish(name, ''))
      .finally(() => {
        skillIconInflight -= 1;
        skillIconDrain(call);
      });
  }
};

const skillIconEnqueue = (call, name) => {
  const key = String(name || '').trim();
  if (!key || skillIconCache.has(key) || skillIconQueued.has(key)) return;
  skillIconQueued.add(key);
  skillIconQueue.push(key);
  skillIconDrain(call);
};

/** 渲染期取真图标：目录反推优先（分组可辨），回落 SkillHub 补全缓存，都没有 → ''。 */
const skillIconFor = (s, expertByPlugin) =>
  skillIconFromDir(s && s.path, expertByPlugin) || skillIconCache.get(String((s && s.name) || '').trim()) || '';

// 组件侧接线：订阅结果 + 把还没有真图的技能名入队。version 只是重绘信号，
// 渲染一律以 skillIconCache 的现值为准（迟到的成功也会被下一帧采纳）。
// items = [{ name, path }]：path 在这里就地判定，不经模块级中转（同名技能可能来自
// 不同专家，按名字反查 path 会张冠李戴）。
const useSkillIcons = (call, items, expertByPlugin) => {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const notify = () => setVersion((v) => v + 1);
    skillIconWaiters.add(notify);
    return () => { skillIconWaiters.delete(notify); };
  }, []);
  const list = (Array.isArray(items) ? items : [])
    .map((it) => `${(it && it.name) || ''}\u0001${(it && it.path) || ''}`)
    .join('\u0000');
  useEffect(() => {
    for (const entry of list.split('\u0000')) {
      if (!entry) continue;
      const sep = entry.indexOf('\u0001');
      const name = entry.slice(0, sep);
      const path = entry.slice(sep + 1);
      // 目录反推已经拿到的不再查询（wbexpert 捆绑技能不该为它多花一次请求）。
      if (skillIconFromDir(path, expertByPlugin)) continue;
      skillIconEnqueue(call, name);
    }
    // list 由 items 逐项拼接而来，items 在渲染期重建，这里只关心集合内容变化。
  }, [call, list, expertByPlugin]);
};

// ── 插件卡片下载量：npm 近 30 天统计，按当前页批量懒取 ──────────────────────
// 技能卡的 ↓ 是 SkillHub 目录自带的；社区插件目录（slim.json 的 11 个字段）里没有下载量，
// 只能在卡片渲染时按 npm 包名去公开统计接口补。取数在宿主侧（lib/npm-downloads.js：7 天
// 落盘缓存、单请求 ≤12 包、429/5xx 冷却 10 分钟），这一层只管「渲染期不联网 + 结果落地后
// 重绘」，纪律与 skillIcon* 同一套：
//   · 模块级缓存，同一个包整个会话只问一次；值为 null = 问过了但没有（下架 / 未被统计 /
//     接口挂了）→ 卡片上那枚「↓」干脆不出现。宁缺不假：绝不显示 0 冒充「没人下载」。
//   · 当前页 50 张卡按卡片顺序入队，同一提交内的入队合并成批（≤12 包/请求）、**在途只 1 批**，
//     所以翻一页最多 5 个请求，首屏靠前的先出数；翻页或换筛选只补新出现的包。
//   · 口径与技能卡不同（那是累计、这是近 30 天），所以 title 里写明窗口。
const npmDownloadsCache = new Map();      // pkg → number | null（null = 问过、没有）
const npmDownloadsQueued = new Set();     // 已入队（含在途与已定值）
const npmDownloadsWaiters = new Set();    // () => void：结果落地后通知组件重绘
let npmDownloadsBuffer = [];              // 待发送包名，FIFO（= 卡片顺序）
let npmDownloadsTimer = null;
let npmDownloadsInflight = 0;
const NPM_DOWNLOADS_BATCH = 12;           // 与宿主侧 MAX_PACKAGES 同口径
// 在途必须 ≤1：宿主侧那道节流（并发 2 + 起手间隔 220ms，实测出来的数）是**全局**的，
// 面板同时压两个批次就等于把速率翻倍 —— 实测 12 个请求并发打过去 429 占一半以上。
const NPM_DOWNLOADS_INFLIGHT_MAX = 1;

const npmDownloadsSettle = (values, retryable = []) => {
  for (const pkg of Object.keys(values || {})) {
    npmDownloadsCache.set(pkg, values[pkg]);
    npmDownloadsQueued.add(pkg);
  }
  // 限流 / 网络抖动 ≠「这个包没有下载量」：把它从已入队集合放出来，下次翻页、换筛选或
  // 重载面板会再试一次（真确认没有的 missing 才粘住，不反复白打公开接口）。
  for (const pkg of retryable) npmDownloadsQueued.delete(pkg);
  for (const notify of [...npmDownloadsWaiters]) {
    try { notify(); } catch { /* 单个订阅者失败不影响其它 */ }
  }
};

const npmDownloadsFlush = (call) => {
  while (npmDownloadsInflight < NPM_DOWNLOADS_INFLIGHT_MAX && npmDownloadsBuffer.length) {
    const batch = npmDownloadsBuffer.splice(0, NPM_DOWNLOADS_BATCH);
    npmDownloadsInflight += 1;
    call('wbNpmDownloads', { packages: batch })
      .then((res) => {
        const rows = res && res.packages ? res.packages : {};
        const values = {};
        const retryable = [];
        for (const pkg of batch) {
          const row = rows[pkg];
          const n = row && row.ok ? Number(row.downloads) : Number.NaN;
          if (Number.isFinite(n)) { values[pkg] = n; continue; }
          // 分两种「没有」：missing = 上游确认这个包没有统计（下架/未收录），粘住不再问；
          // 其它（限流、超时、接口挂了）本轮画不出来，但允许下次翻页/重载再试一次。
          values[pkg] = null;
          if (!(row && row.missing)) retryable.push(pkg);
        }
        npmDownloadsSettle(values, retryable);
      })
      .catch(() => npmDownloadsSettle(Object.fromEntries(batch.map((pkg) => [pkg, null])), batch))
      .finally(() => {
        npmDownloadsInflight -= 1;
        npmDownloadsFlush(call);
      });
  }
};

const npmDownloadsEnqueue = (call, packages) => {
  let added = 0;
  for (const raw of Array.isArray(packages) ? packages : []) {
    const pkg = String(raw || '').trim();
    if (!pkg || npmDownloadsQueued.has(pkg)) continue;
    npmDownloadsQueued.add(pkg);
    npmDownloadsBuffer.push(pkg);
    added += 1;
  }
  if (!added || npmDownloadsTimer !== null) return;
  // 宏任务合并：一页 50 个 effect 各自入队，到这儿并成批再发，50 个请求就成 5 个。
  npmDownloadsTimer = setTimeout(() => { npmDownloadsTimer = null; npmDownloadsFlush(call); }, 0);
};

/** 渲染期取下载量：还没问到 / 问过但没有 → null（这一枚不画）。 */
const npmDownloadsFor = (pkg) => {
  const value = npmDownloadsCache.get(String(pkg || '').trim());
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};

// 组件侧接线：订阅结果 + 把当前页还没有值的包入队。与 useSkillIcons 一样，返回值只是重绘
// 信号，渲染一律以 npmDownloadsCache 现值为准（迟到的成功会被下一帧采纳）。
const useNpmDownloads = (call, items) => {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const notify = () => setVersion((v) => v + 1);
    npmDownloadsWaiters.add(notify);
    return () => { npmDownloadsWaiters.delete(notify); };
  }, []);
  const list = (Array.isArray(items) ? items : [])
    .map((it) => String((it && it.npm) || '').trim())
    .join('\u0000');
  useEffect(() => {
    npmDownloadsEnqueue(call, list.split('\u0000'));
    // list 是当前页包名拼出来的字符串：只有集合内容变了才重新入队，
    // 同一页反复重绘（滚动/装完一个）不会多打一次请求。
  }, [call, list]);
};

// ── 插件卡片底栏那一行事实 ────────────────────────────────────────────────
// 三枚（↓近 30 天下载 / ★星数 / 核验日期）在 250px 列下可用宽只有 153–174px，英文又比
// 中文长，装不下时以前靠 overflow:hidden 裁掉尾字，读起来像界面坏了。这里改成「整枚收起」：
// 离流探针 .dsh-mcp-pfacts-probe 与真行同构、量的是「三枚全画要多宽」，真行（flex:1 1 0）
// 的宽度恒等于可用宽，两者一比就知道放不放得下——放不下收起日期那枚（信息量最低、字最长），
// 列变宽了再放回来。结论只由「探针宽 vs 行宽」两个几何量决定，不依赖上一次的结论，所以
// 不会「收起→行变窄→又放下→又溢出」地抖；面板切走（宽度 0）时直接不下结论。
const PluginCardFacts = ({ downloadsText, downloadsTitle, starText, starTitle, dateText, dateTitle }) => {
  const rowRef = useRef(null);
  const probeRef = useRef(null);
  const [dropDate, setDropDate] = useState(false);
  const chips = (withDate) => {
    const out = [];
    if (downloadsText) out.push(h('span', { key: 'dl', className: 'dl', title: downloadsTitle }, '↓' + downloadsText));
    if (starText) out.push(h('span', { key: 'star', className: 'star', title: starTitle }, h(StarIcon, { size: 10 }), starText));
    if (withDate && dateText) out.push(h('span', { key: 'when', className: 'when', title: dateTitle }, dateText));
    return out;
  };
  useEffect(() => {
    const measure = () => {
      const row = rowRef.current;
      const probe = probeRef.current;
      if (!row || !probe) return;
      const have = row.getBoundingClientRect().width;
      if (have < 8) return;
      setDropDate(probe.getBoundingClientRect().width > have + 1);
    };
    measure();
    if (typeof ResizeObserver !== 'function') return undefined;
    let observer = null;
    try {
      observer = new ResizeObserver(measure);
      if (rowRef.current) observer.observe(rowRef.current);
    } catch {
      return undefined;
    }
    return () => { if (observer) observer.disconnect(); };
  }, [downloadsText, starText, dateText]);
  return h('div', { ref: rowRef, className: 'dsh-mcp-pfacts' },
    chips(!dropDate),
    dateText ? h('div', { ref: probeRef, className: 'dsh-mcp-pfacts-probe', 'aria-hidden': true }, chips(true)) : null);
};

// ── Skill 看板：列表 + 详情 ──────────────────────────────────────────
// 数据来自宿主新增的 listSkills / skillDetail（走同一个 mcpManager Remote 命名空间，
// 复用既有的 call 信封 {ok, ...}），不引入第二条 Remote 通道。
const SkillBoard = ({ call, timer }) => {
  const [skills, setSkills] = useState([]);
  // 套件成员可以来自用户级/内置技能（套件本身是跨作用域的全局数据）。单独留一份未按
  // 作用域收窄的全集，只给套件管理器判「成员是否失效」——否则在项目作用域里打开套件，
  // 用户级成员会被误标成「已失效」。
  const [allSkills, setAllSkills] = useState([]);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState('');
  // 作用域（issue #8）：此前挂载处没传 scope，`skillScopeArg(undefined)` 让宿主只扫
  // 用户级与内置目录，项目级 skill（<cwd>/.agents/skills、<cwd>/.dsh/skills）永远看不到。
  // 面板层没有「当前工作区」这个概念（MCP 页也是在自己的组件里取工作区列表），所以这里
  // 按同样方式自取：作用域 = 全局 / 各工作区，选择写进 hash（skillws），刷新与分享可回到原处。
  const [scope, setScope] = useState(() => readHashParam('skillws') || 'global');
  const [workspaces, setWorkspaces] = useState([]);
  // 区分「还没取到」与「取到但为空」：只有后者才允许把失效的 skillws 回退到全局，
  // 否则首帧工作区列表为空时会把用户选好的项目作用域误清掉。
  const [workspacesLoaded, setWorkspacesLoaded] = useState(false);
  // §3.1 过滤条状态（能力位 + 来源），与搜索可叠加。
  const [onlyModel, setOnlyModel] = useState(false);
  const [onlyUser, setOnlyUser] = useState(false);
  const [sourceFilter, setSourceFilter] = useState('all');
  // 「最近安装」：按安装时间倒序平铺。分类是关键词猜的不一定准，时间线正好补导航缺口——
  // 刚装的永远排最前，用户一眼认出哪个是自己刚装的。
  const [recentOnly, setRecentOnly] = useState(false);
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  // 卸载三态：confirmRemove = 详情里已展开二次确认；removing = 请求在途；
  // removeError = 宿主拒绝或网络失败的原因（成功即关详情，不在详情里留错误）。
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState('');
  // 分类升级（决策 3/4/7）：分类单选 + 网格/列表双视图，全部记忆到 URL hash
  // （skillcat/skillview/skillpick），刷新与分享都能回到原处；'' = 默认态不写键。
  const [cat, setCat] = useState('');
  const [view, setView] = useState('');
  const [toast, setToast] = useState(null); // { msg, ok }
  // 自定义套件三态：suites = 宿主 ~/.dsh/armory/suites.json 的本地镜像，suiteOpen = 管理弹窗开关，
  // notice = 看板根级浮层提示。notice 必须与 toast 分开——toast 渲染在详情体内（dsh-mcp-skill-d-flash），
  // 而「套件已保存 / 已放弃未保存的修改」恰恰发生在弹窗关闭的一刻，挂在详情里根本看不见。
  const [suites, setSuites] = useState([]);
  const [suiteOpen, setSuiteOpen] = useState(false);
  const [notice, setNotice] = useState(null); // { msg, ok }
  const loadSeq = useRef(0);
  const detailSeq = useRef(0);
  const toastCancel = useRef(null);
  const noticeCancel = useRef(null);
  // 工具条搜索框：清空按钮点下去自己随即卸载，焦点会掉到 body——clear 后把焦点送回 input。
  const searchRef = useRef(null);
  // 作用域切换检测（skillpick 只在真换作用域时清）+ skillpick 恢复只做一次的哨兵。
  const mountedScope = useRef(null);
  const seededPick = useRef(false);

  const load = useCallback(async (notify = false) => {
    const seq = ++loadSeq.current;
    if (notify) setRefreshing(true);
    setLoading(true);
    try {
      const res = await call('listSkills', skillScopeArg(scope));
      if (seq !== loadSeq.current) return;
      if (res && res.ok) {
        const rows = Array.isArray(res.skills) ? res.skills : [];
        // 全集留给套件管理器；看板按当前作用域收窄：全局 = 用户级 + 随包，项目 = 只留
        // 该项目根目录发现的 skill（宿主返回的是并集，不滤就会「每个工作区都一样」）。
        setAllSkills(rows);
        setSkills(scope === 'global' ? rows : rows.filter(isProjectSkillRow));
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

  // 套件集合读取。与 listSkills 不同：它读的是本插件自己的数据层（不依赖宿主 skill 注册表），
  // 失败也不该把整个看板拖进错误态——读不到就当「还没有套件」，与 wb-registry 读侧同一口径。
  const loadSuites = useCallback(async () => {
    try {
      const res = await call('listSkillSuites');
      if (res && res.ok && Array.isArray(res.suites)) setSuites(res.suites);
    } catch {
      // 宿主未重启 / 接口缺失：静默降级为空集合，看板与召唤菜单都还能用。
    }
  }, [call]);

  // 工作区列表只用来给作用域 tab 提供选项。取不到（老宿主没有 workspaceRegistry）
  // 就只留「全局」一档，看板行为与修复前完全一致，不因此报错。
  useEffect(() => {
    let alive = true;
    call('listWorkspaces').then((res) => {
      if (!alive) return;
      if (res && res.ok && Array.isArray(res.workspaces)) setWorkspaces(res.workspaces);
      setWorkspacesLoaded(true);
    }).catch(() => { if (alive) setWorkspacesLoaded(true); });
    return () => { alive = false; };
  }, [call]);

  // skillws 指向的工作区已被移除 / 改名：静默回退全局，别让看板停在一个不存在的 tab 上。
  // 工作区列表已取到时才判定；清 hash 与切状态都走同一处，避免两套回退路径。
  useEffect(() => {
    if (!workspacesLoaded || scope === 'global') return;
    if (workspaces.some((ws) => ws.path === scope)) return;
    writeHashParams({ skillws: null, skillpick: '' });
    setScope('global');
  }, [workspacesLoaded, workspaces, scope]);

  const scopeTabs = useMemo(() => {
    const tabs = [{ key: 'global', label: t('全局') }];
    for (const ws of workspaces) tabs.push({ key: ws.path, label: ws.name, title: ws.path });
    return tabs;
  }, [workspaces]);
  const scopeName = scope === 'global' ? t('全局') : (workspaces.find((ws) => ws.path === scope)?.name || scope);
  // 与 MCP 页的切作用域同一口径：换作用域 = 换一套注册表结果，选中项、详情与只对旧
  // 作用域有意义的筛选（来源）一起归零；分类与视图是跨作用域的浏览偏好，保留。
  const switchScope = useCallback((next) => {
    if (next === scope) return;
    writeHashParams({ skillws: next === 'global' ? null : next, skillpick: '' });
    setScope(next);
    setSelected('');
    setDetail(null);
    setDetailError('');
    setConfirmRemove(false);
    setRemoveError('');
    setQuery('');
    setSourceFilter('all');
  }, [scope]);

  useEffect(() => {
    // cat/view 从 hash 恢复（作用域切换时 hash 仍是唯一真值源，直接重读）。
    const seededCat = readHashParam('skillcat');
    setCat(SKILL_CAT_KEYS.has(seededCat) && seededCat !== 'all' ? seededCat : '');
    setView(readHashParam('skillview') === 'list' ? 'list' : '');
    // skillpick 只在真正换作用域时清（首次挂载不清——否则会把待恢复的选中态擦掉，
    // 挂载后的 seed 副作用就读不到了）。
    if (mountedScope.current !== null && mountedScope.current !== scope) writeHashParams({ skillpick: '' });
    mountedScope.current = scope;
    seededPick.current = false;
    setSelected('');
    setDetail(null);
    setDetailError('');
    setQuery('');
    load(false);
    loadSuites();
  }, [load, loadSuites]);

  // 本看板挂着时收到变更（目前主要是自己卸载成功，以及将来其它入口）立即重读真值。
  // 不挂着时不用补——上面的挂载 effect 每次都会 load(false)，切回本页天然是新数据。
  useEffect(() => onSkillChange(() => { load(true); }), [load]);

  // 真图标数据源①：专家目录（模块级缓存，与市场/已召唤页同一条）——wbexpert 捆绑技能
  // 用安装目录名里的 plugin 反查专家头像。拉不到静默降级：这部分技能走生成头像。
  const [expertByPlugin, setExpertByPlugin] = useState(() => new Map());
  useEffect(() => {
    let alive = true;
    loadExpertCatalogShared(call).then((data) => {
      if (!alive) return;
      const map = new Map();
      for (const item of (data.experts || [])) {
        if (item && item.plugin) map.set(item.plugin, item.avatarUrl || '');
      }
      setExpertByPlugin(map);
    }).catch(() => {});
    return () => { alive = false; };
  }, [call]);

  // 安装信息（skill 名字 → { installedAt, marketName?, marketplace? }）：宿主自扫标准
  // 技能根目录、读 SKILL.md 头部 name 建映射后按名字返回——**不依赖 listSkills 行的
  // path**（注册表行可能整列缺 path，按 path 查会静默落空，实测踩过）。账本命中的
  // 附带市场原名：SKILL.md 的 name 可以和市场名不同，供卡片对应显示。
  // 失败不静默：新接口在旧宿主进程上不存在（404 / 未连接 ≈ 没重启），提示用户重启。
  const [installInfo, setInstallInfo] = useState(() => new Map());
  const [installInfoNote, setInstallInfoNote] = useState('');
  useEffect(() => {
    let alive = true;
    call('skillInstallInfo', skillScopeArg(scope)).then((res) => {
      if (!alive) return;
      if (res?.ok && res.info) {
        const map = new Map();
        for (const [name, row] of Object.entries(res.info)) {
          if (row && Number(row.installedAt) > 0) map.set(name, row);
        }
        setInstallInfo(map);
        setInstallInfoNote('');
        return;
      }
      setInstallInfo(new Map());
      setInstallInfoNote(t('安装时间与市场原名不可用：{0}。宿主侧接口在重启 DeepSeek Harness 后才会注册，重启后即可显示。', [String((res && res.error) || t('读取失败'))]));
    }).catch((e) => {
      if (!alive) return;
      setInstallInfo(new Map());
      setInstallInfoNote(t('安装时间与市场原名不可用：{0}。宿主侧接口在重启 DeepSeek Harness 后才会注册，重启后即可显示。', [String((e && e.message) || e)]));
    });
    return () => { alive = false; };
  }, [skills, scope, call]);

  const queryKey = (query || '').toLowerCase();
  // 分类判定只依赖 name+description、与筛选无关 → 一次 memo 全量映射；
  // 分类轨道计数固定全量（决策 9），不随来源/权限/搜索联动。
  const catOf = useMemo(() => {
    const map = new Map();
    for (const s of skills) map.set(s.name, skillCategoryOf(s));
    return map;
  }, [skills]);
  const catCounts = useMemo(() => {
    const map = new Map([['all', skills.length]]);
    for (const s of skills) {
      const key = skillCategoryOf(s).key;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  }, [skills]);
  // §3.1 过滤条。注意：宿主 skill 注册表**没有**启用/禁用开关（listSkills 只给
  // modelInvocable / userInvocable 这类能力位，没有 enable/disable 写入接口），
  // 所以这里不伪造一个「启用开关」——那会是个点了不生效的假控件。
  // 真正可筛的是「谁能调用它」，以及来源；禁用态灰显同理不做（没有禁用概念）。
  const filtered = skills.filter((s) => {
    if (onlyModel && !s.modelInvocable) return false;
    if (onlyUser && !s.userInvocable) return false;
    if (sourceFilter !== 'all' && (s.source || 'unknown') !== sourceFilter) return false;
    if (cat && (catOf.get(s.name) || SKILL_UNCAT).key !== cat) return false;
    if (queryKey && !(s.name + ' ' + (s.description || '')).toLowerCase().includes(queryKey)) return false;
    return true;
  });
  const activeCat = cat ? skillCatByKey(cat) : null;
  // 卡片的安装时间徽标：30 天内相对时间（「3 天前装」，7 天内高亮），更早用绝对日期；
  // title 悬浮给完整日期。拿不到时间（bundled / runtime 等非磁盘来源）不渲染。
  const skillTimeOf = (s) => (installInfo.get(s.name)?.installedAt || 0);
  const skillTimeBadge = (s) => {
    const at = skillTimeOf(s);
    if (!at) return null;
    const days = Math.floor((Date.now() - at) / 86_400_000);
    const label = days <= 30 ? t('装于 {0}', [fmtLast(at)]) : t('装于 {0}', [wbFormatDate(at)]);
    return h(Badge, { cls: days <= 7 ? 's-on' : '', title: t('安装于 {0}', [wbFormatDate(at)]) }, label);
  };
  // 卡片备注行（描述下方小字，不改动 skill 实际名称）：市场装的显示「市场原名」，
  // 其余磁盘技能显示安装目录名（namespace__slug 形态即它在市场里的标识）——
  // 目录名/原名与看板名一致时是冗余，不显示。原徽标方案挤在 foot 行且对无账本
  // 记录的技能（clawhub 等外部工具装的）没有数据，改为目录名兜底后覆盖所有技能。
  const skillNote = (s) => {
    const info = installInfo.get(s.name);
    if (!info) return null;
    if (info.marketName && info.marketName !== s.name) {
      const label = info.marketplace === 'workbuddy-skills' ? t('SkillHub') : (info.marketplace || '');
      return {
        text: t('市场原名：{0}', [info.marketName]) + (label ? ' · ' + label : ''),
        title: t('它在市场里叫「{0}」，安装后看板显示的是 SKILL.md 的 name 字段。', [info.marketName])
          + (label ? ' ' + t('来源：{0}', [label]) : ''),
      };
    }
    const dirName = String(info.dir || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
    if (dirName && dirName !== s.name) {
      return {
        text: t('安装目录：{0}', [dirName]),
        title: t('这个 skill 的安装目录名，namespace__slug 形态即它在市场里的标识。'),
      };
    }
    return null;
  };
  // 「最近安装」视图行：只留拿得到安装时间的（bundled / runtime 没有落盘时间，不在此列），
  // 按时间倒序。其余筛选（搜索 / 来源 / 权限 / 分类）照常叠加。
  const visibleRows = useMemo(() => {
    if (!recentOnly) return filtered;
    return filtered.filter((s) => skillTimeOf(s) > 0).sort((a, b) => skillTimeOf(b) - skillTimeOf(a));
    // eslint 不识别 skillTimeOf 的闭包稳定性；installInfo 变化即重算。
  }, [filtered, installInfo, recentOnly]);
  // 分类聚簇：网格与列表共用同一套簇序（决策 7：不按来源分组，改按分类聚簇，
  // 簇序 = SKILL_CATS 声明序，未分类垫底，簇内保持注册表顺序）。网格渲染成卡片簇，
  // 列表渲染成一个列表面板 + 分类分割线。选中具体分类时退化为单簇（无聚簇意义）。
  const clustered = useMemo(() => {
    // 「最近安装」：单簇平铺，簇头当时间线标题用。
    if (recentOnly) return [{ key: 'recent', cat: SKILL_RECENT_CAT, rows: visibleRows }];
    // 选中具体分类时退化为单簇（网格无聚簇意义，列表也无需一条分割线）。
    if (activeCat) return [{ key: activeCat.key, cat: activeCat, rows: visibleRows }];
    const order = [...SKILL_CATS.filter((c) => c.key !== 'all').map((c) => c.key), SKILL_UNCAT.key];
    const buckets = new Map(order.map((k) => [k, []]));
    for (const s of visibleRows) {
      const key = (catOf.get(s.name) || SKILL_UNCAT).key;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(s);
    }
    return order
      .filter((k) => buckets.get(k).length)
      .map((k) => ({ key: k, cat: k === SKILL_UNCAT.key ? SKILL_UNCAT : skillCatByKey(k), rows: buckets.get(k) }));
  }, [visibleRows, catOf, view, activeCat, recentOnly]);
  // 来源统计一次算完（不要在每个 chip 里各 filter 一遍）。
  const sourceCounts = useMemo(() => {
    const map = new Map();
    for (const s of skills) {
      const key = s.source || 'unknown';
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  }, [skills]);

  // 真图标补全（数据源②）：把还没有①目录反推的技能名交给 SkillHub 精确匹配。
  // 必须无条件调用（hook 规矩）；入队侧自行跳过已有真图与已缓存/在途的名字。
  useSkillIcons(call, filtered, expertByPlugin);
  

  const openDetail = useCallback(async (name) => {
    if (removing) return; // 卸载在途时不切换选中，避免成功回调关掉另一条详情
    setSelected(name);
    setConfirmRemove(false);
    setRemoveError('');
    // 选中态记忆到 hash（决策 4），刷新/分享可回到同一技能详情。
    writeHashParams({ skillpick: name });
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
  }, [call, scope, removing]);

  // 关掉网格视图的详情弹窗：选中态、正文、报错、toast 一起清，并把 hash 里的 skillpick 撤回。
  // 只清 UI 不清 hash 的话，刷新/分享链接会把弹窗又弹回来，看起来像「关不掉」。
  const closeDetail = useCallback(() => {
    detailSeq.current += 1; // 作废在途的 skillDetail 回包，避免关掉后又被填回内容
    setSelected('');
    setDetail(null);
    setDetailError('');
    setDetailLoading(false);
    setConfirmRemove(false);
    setRemoveError('');
    setToast(null);
    writeHashParams({ skillpick: '' });
  }, []);

  // 卸载在途时拒绝关闭详情：请求不可取消，关掉后失败原因就无处可显示。
  // 所有「用户主动关」的入口都走这里；removeSelected 成功后用 closeDetail 强关。
  const requestCloseDetail = useCallback(() => {
    if (removing) return;
    closeDetail();
  }, [removing, closeDetail]);

  // 弹窗要能被 Escape 关掉，前提是焦点在它里面。ref 回调在节点挂载时触发，
  // 比再挂一个 useEffect 更贴近「出现即聚焦」，也省掉一轮渲染。
  const focusModal = useCallback((el) => {
    if (el) el.focus();
  }, []);

  // §4.2 接受跨分类定位：专家页的技能 chip 跳过来时，直接打开该技能的详情。
  // 两个来源都要接——订阅（已挂载时即时生效）与挂载时自领（从别的页签跳过来时，
  // 广播早已发完，只能靠模块里留下的 pending 目标）。
  useEffect(() => {
    const focus = (name) => {
      const target = String(name || '').trim();
      if (!target) return;
      pendingSkillFocus = '';
      openDetail(target);
    };
    const off = onSkillFocus(focus);
    if (pendingSkillFocus) focus(pendingSkillFocus);
    return off;
  }, [openDetail]);

  // 套件弹窗的跨组件入口：召唤菜单底部「管理套件…」发广播 → 这里领走并打开弹窗。
  // 与 pendingSkillFocus 同构：订阅覆盖「看板已挂载」，自领 pending 覆盖「从别的页签跳过来时
  // 广播早已发完」；领走即清标志，否则下次再进看板会莫名其妙自己弹一次。
  useEffect(() => {
    const open = () => {
      pendingSuiteOpen = false;
      setSuiteOpen(true);
    };
    const off = onSuiteOpenRequest(open);
    if (pendingSuiteOpen) open();
    return off;
  }, []);

  // skillpick 恢复（决策 4）：列表就绪后按 hash 打开详情，只做一次；scope 切换时哨兵复位。
  useEffect(() => {
    if (seededPick.current || loading || !skills.length) return;
    seededPick.current = true;
    const pick = readHashParam('skillpick');
    if (pick && skills.some((s) => s.name === pick)) openDetail(pick);
  }, [loading, skills, openDetail]);

  const summary = selected ? skills.find((s) => s.name === selected) : null;
  const summaryCat = summary ? (catOf.get(summary.name) || SKILL_UNCAT) : null;
  // 详情的安装时间 + 市场原名：按 skill 名字从 skillInstallInfo 映射取。
  const summaryInstall = summary ? installInfo.get(summary.name) : null;
  const installTime = summaryInstall?.installedAt || 0;

  // 网格视图不再占右侧详情栏：有选中就浮成居中弹窗；列表视图仍走右侧栏（决策见 §12）。
  // 注意 view 的取值是 'list' | ''（网格是空串，见 setView(readHashParam('skillview') === 'list' ...)），
  // 所以判据必须是 !== 'list'，写成 === 'grid' 会让弹窗永远不出现（卡片点了像没反应）。
  const isModal = view !== 'list' && !!summary;

  // ── 状态记忆（决策 4）：分类/视图/选中三态写 URL hash（skillcat/skillview/skillpick）──
  // 复用 readHashParam / writeHashParams，只改 hash，不动 path/search。
  const setCatHash = (key) => {
    const next = !key || key === 'all' ? '' : key;
    setCat(next);
    writeHashParams({ skillcat: next });
  };
  const setViewHash = (v) => {
    const next = v === 'list' ? 'list' : '';
    setView(next);
    writeHashParams({ skillview: next });
  };

  // ── 详情操作（决策 4/11）：复制走 copyText，反馈走局部 toast（约 2.6s 自动消失）────
  const showToast = useCallback((msg, ok) => {
    setToast({ msg, ok });
    if (toastCancel.current) toastCancel.current();
    // timer.timeout 的返回值是「取消函数」而不是 id（见 createTimer），直接持有它。
    toastCancel.current = timer.timeout(() => setToast(null), 2600);
  }, [timer]);
  useEffect(() => () => { if (toastCancel.current) toastCancel.current(); }, []);
  // 看板根级提示（约 2.6s 自动消失）：套件弹窗一关就卸载，自己的 toast 活不过那一帧，
  // 所以「已保存 / 已放弃修改」这类消息一律交给这里，挂在看板根节点上。
  const showNotice = useCallback((msg, ok) => {
    setNotice({ msg, ok });
    if (noticeCancel.current) noticeCancel.current();
    noticeCancel.current = timer.timeout(() => setNotice(null), 2600);
  }, [timer]);
  useEffect(() => () => { if (noticeCancel.current) noticeCancel.current(); }, []);
  const copySkillMdPath = () => {
    const dir = String((summary && summary.path) || '').replace(/[\\/]+$/, '');
    if (!dir) return;
    copyText(dir + '/SKILL.md').then((ok) => showToast(ok ? t('已复制到剪贴板') : t('复制失败'), ok));
  };
  const copySessionRef = () => {
    if (!summary) return;
    copyText('@' + summary.name).then((ok) => showToast(ok ? t('已复制到剪贴板') : t('复制失败'), ok));
  };

  // 卸载：宿主按注册表记录的真路径永久删除。成功后先本地收敛列表（注册表可能有扫描缓存，
  // 等 listSkills 回来才消失会让用户以为没删掉），再广播变更——本看板的订阅者会 load(true)
  // 让真值覆盖，顶部数量角标也同帧重算；刷新失败也不回滚——文件已经没了，回滚只会制造假象。
  // 注意定义位置：必须排在 showNotice 之后（依赖数组在渲染期求值，放前面会 TDZ）。
  const removeSelected = useCallback(async () => {
    if (!summary || !summary.path || removing) return;
    const name = summary.name;
    setConfirmRemove(false);
    setRemoving(true);
    setRemoveError('');
    try {
      const res = await call('removeSkill', { ...skillScopeArg(scope), name });
      if (!res || !res.ok) throw new Error((res && res.error) || t('卸载失败'));
      // 显示列表与套件用的全集一起收窄，否则关掉再打开套件会把刚卸载的成员当仍存在。
      setAllSkills((rows) => rows.filter((s) => s.name !== name));
      setSkills((rows) => rows.filter((s) => s.name !== name));
      closeDetail();
      showNotice(t('已卸载 {0}', [name]), true);
      emitSkillChange('skill-board-remove');
    } catch (e) {
      setRemoveError(skillTransportHint(String((e && e.message) || e)));
    } finally {
      setRemoving(false);
    }
  }, [summary, removing, call, scope, closeDetail, showNotice]);

  // §1.4 空状态四件套：两种空况共用一份 JSX；「清除全部筛选」现在连同分类轨道一起清。
  // 项目作用域的空态要说清「这里只看项目本地技能」：用户级与随包分发的技能还在，只是
  // 不在这个作用域里显示。否则 0 条会被当成「技能丢了」。
  const projectScopeEmpty = scope !== 'global' && skills.length === 0;
  const emptyBoard = skills.length === 0
    ? h(EmptyState, {
        icon: 'skill',
        title: projectScopeEmpty ? t('这个工作区没有本地 skill') : t('这个作用域下没有发现 skill'),
        hint: projectScopeEmpty
          ? t('项目作用域只显示工作区里 .agents/skills 与 .dsh/skills 的技能；用户级与随包分发的技能请切到「全局」查看。')
          : t('skill 由 skill-filesystem 从项目 .agents/skills、.dsh/skills 与用户目录发现；放一个 SKILL.md 进去就会出现在这里。'),
        actions: [{ label: t('重新扫描'), icon: 'refresh', onClick: () => { load(true); loadSuites(); } }],
        tight: true,
      })
    : h(EmptyState, {
        icon: 'search', title: t('没有符合筛选条件的 skill'),
        hint: t('当前有 {0} 个 skill，但都被筛选条挡住了。', [skills.length]),
        actions: [{
          label: t('清除全部筛选'),
          icon: 'x',
          onClick: () => { setOnlyModel(false); setOnlyUser(false); setSourceFilter('all'); setCatHash(''); setQuery(''); },
        }],
        tight: true,
      });

  return h('div', { className: 'dsh-mcp-skill-view' },
    error ? h('div', { className: 'dsh-mcp-d-err' }, error) : null,
    // list-mode / has-detail 只用于详情栏宽度分层：列表视图更宽，选中后最宽。
    available && !error ? h('div', {
      className: 'dsh-mcp-skill-body' + (view === 'list' ? ' list-mode' : '') + (summary ? ' has-detail' : ''),
    },
      h('div', { className: 'dsh-mcp-skill-content' },
        // 作用域（issue #8）：全局 / 各工作区。与 MCP 页同一套分段控件与 hash 记忆；
        // 只有一个作用域（宿主没有 workspaceRegistry）时整行不渲染，不占位置。
        scopeTabs.length > 1 ? h('div', { className: 'dsh-mcp-skill-scope' },
          h(ScopeTabs, { tabs: scopeTabs, active: scope, onSelect: switchScope }),
        ) : null,
        // 顶部工具条：搜索 + 网格/列表分段控件（决策 5：不加 Hero，直奔工作区）。
        h('div', { className: 'dsh-mcp-skill-toolbar' },
          h('div', { className: 'dsh-mcp-skill-search' + (query ? ' querying' : '') },
            h(Icon, { d: ICONS.search }),
            h('input', {
              ref: searchRef,
              placeholder: t('搜索 skill…'), value: query,
              onChange: (e) => setQuery(e.target.value), 'aria-label': t('搜索 skill'),
              // Escape 清词时吃掉事件（别让上层把弹窗/浮层一起关了）；没有词时放行。
              onKeyDown: (e) => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } },
            }),
            query ? h('button', {
              type: 'button', className: 'clear',
              title: t('清空搜索'), 'aria-label': t('清空搜索'),
              onClick: () => { setQuery(''); searchRef.current?.focus(); },
            }, h(Icon, { d: ICONS.x, size: 10 })) : null,
          ),
          h('div', { className: 'dsh-mcp-skill-seg', role: 'group', 'aria-label': t('视图切换') },
            h('button', {
              type: 'button', className: 'dsh-mcp-skill-seg-btn', 'aria-pressed': view !== 'list',
              title: t('网格视图'), onClick: () => setViewHash('grid'),
            }, h(Icon, { d: ICONS.grid, size: 13 }), t('网格视图')),
            h('button', {
              type: 'button', className: 'dsh-mcp-skill-seg-btn', 'aria-pressed': view === 'list',
              title: t('列表视图'), onClick: () => setViewHash('list'),
            }, h(Icon, { d: ICONS.list, size: 13 }), t('列表视图')),
          ),
          // 自定义套件入口（决策：按钮放在 skill 看板工具条上，与视图分段控件同一行）。
          // 徽章显示已保存的套件数——0 时不渲染，避免空看板挂一个「0」误导成有东西可点。
          h('button', {
            type: 'button', className: 'dsh-mcp-btn suite-entry',
            title: t('管理自定义套件：把多个相关 skill 打包，引用一次全部生效'),
            onClick: () => setSuiteOpen(true),
            'aria-label': t('管理自定义套件'),
          },
            h(Icon, { d: ICONS.layers, size: 13 }),
            t('套件'),
            suites.length ? h('span', { className: 'cnt' }, suites.length) : null,
          ),
        ),
        // 分类轨道（决策 5：轨道在搜索下、chips 上；计数固定全量，决策 9）。
        // 分类与来源/权限是正交维度——分类筛「它是什么」，来源/权限筛「它从哪来/谁能调用」。
        h('div', { className: 'dsh-mcp-skill-rail', role: 'tablist', 'aria-label': t('按分类过滤 skill') },
          SKILL_CATS.map((c) => h('button', {
            key: c.key,
            type: 'button',
            role: 'tab',
            'aria-selected': (cat || 'all') === c.key,
            className: 'dsh-mcp-skill-cat' + ((cat || 'all') === c.key ? ' on' : ''),
            onClick: () => setCatHash(c.key),
          },
            h('span', { className: 'dsh-mcp-skill-cat-dot', style: { background: c.color } }),
            c.name,
            h('span', { className: 'dsh-mcp-skill-cat-count' }, catCounts.get(c.key) || 0),
          ))),
        // 结果行 + 权限/来源 chips + 只读提示：位置保持原样（决策 8）。
        h('div', { className: 'dsh-mcp-skill-result dsh-mcp-item-sub' },
          h('span', null, (loading && !refreshing) ? t('读取中…') : (scopeTabs.length > 1 ? scopeName + ' · ' : '') + t('显示 {0} / {1} 个 skill', [visibleRows.length, skills.length])
            + (visibleRows.length !== skills.length ? t('（共 {0}，已筛选）', [skills.length]) : '')),
          refreshing ? h('span', null, t(' · 刷新中…')) : null,
          // 安装时间数据源不可用（旧宿主 / 服务未连接）：不静默，一行说明 + 悬浮全文。
          installInfoNote ? h('span', { title: installInfoNote }, ' · ' + installInfoNote) : null,
          // OPT-31 · 5.1：把「能做什么、不能做什么」从代码注释提到界面上。
          // 宿主注册表本身只有 listSkills / skillDetail 两个读接口；卸载是本插件补的
          // removeSkill（仅限用户级/项目级目录）。这层边界不写明，用户会把「随包分发 /
          // 运行时注册不可卸载」当成缺陷反复找开关。
          // 位置：筛选条之后、列表之前——读列表前先知道能力边界，比滚到底才发现划算。
          h('div', { className: 'dsh-mcp-readonly-note' },
            h(Icon, { d: ICONS.eye, size: 12 }),
            h('span', null, t('宿主只提供 skill 的读取接口；这里可以卸载用户级/项目级目录里的 skill（永久删除，不可撤销）。随 DSH 分发、运行时注册、自定义目录的 skill 不可卸载——要改内容请直接编辑 SKILL.md。')),
          ),
        ),
        h('div', { className: 'dsh-mcp-skill-filters' },
          h('button', {
            type: 'button', className: 'dsh-mcp-chip-s' + (onlyModel ? ' on' : ''), 'aria-pressed': onlyModel,
            title: t('只显示模型可以主动调用的 skill'),
            onClick: () => setOnlyModel((v) => !v),
          }, t('模型可调用')),
          h('button', {
            type: 'button', className: 'dsh-mcp-chip-s' + (onlyUser ? ' on' : ''), 'aria-pressed': onlyUser,
            title: t('只显示用户可以用 /名字 触发的 skill'),
            onClick: () => setOnlyUser((v) => !v),
          }, t('用户可调用')),
          h('button', {
            type: 'button', className: 'dsh-mcp-chip-s' + (recentOnly ? ' on' : ''), 'aria-pressed': recentOnly,
            title: t('按安装时间倒序平铺；随 DSH 分发、运行时注册的技能没有安装时间，不在此列'),
            onClick: () => setRecentOnly((v) => !v),
          }, t('最近安装')),
          [...sourceCounts.entries()].map(([source, count]) => h('button', {
            key: source,
            type: 'button',
            className: 'dsh-mcp-chip-s' + (sourceFilter === source ? ' on' : ''),
            'aria-pressed': sourceFilter === source,
            title: t('只看来自该来源的 skill'),
            onClick: () => setSourceFilter((prev) => (prev === source ? 'all' : source)),
          }, skillSourceLabel(source), h('span', { className: 'dsh-mcp-chip-s-count' }, count))),
          sourceFilter !== 'all'
            ? h('button', {
                type: 'button', className: 'dsh-mcp-chip-s more',
                onClick: () => setSourceFilter('all'),
              }, t('清除来源筛选'))
            : null,
        ),
        // 主区画布：网格 = 分类聚簇双壳卡片；列表 = 一个列表面板 + 分类分割线。
        h('div', { className: 'dsh-mcp-skill-canvas' },
          visibleRows.length === 0 && !loading
            ? emptyBoard
            : (view === 'list'
                ? h('div', { className: 'dsh-mcp-skill-list', role: 'listbox', 'aria-label': t('skill 列表') },
                    clustered.flatMap((cluster) => [
                      // 分割线是普通行元素，不是独立列表容器：整块始终只有一个 listbox。
                      !activeCat ? h('div', { key: cluster.key + ':head', className: 'dsh-mcp-skill-divider' },
                        h('span', { className: 'dsh-mcp-skill-cat-tile', style: { background: cluster.cat.color } }),
                        cluster.cat.name,
                        h('span', { className: 'dsh-mcp-skill-divider-line' }),
                        h('span', { className: 'dsh-mcp-skill-divider-count' }, cluster.rows.length),
                      ) : null,
                      ...cluster.rows.map((s) => h('button', {
                        key: s.name,
                        type: 'button',
                        role: 'option',
                        'aria-selected': selected === s.name,
                        className: 'dsh-mcp-skill' + (selected === s.name ? ' on' : ''),
                        onClick: () => openDetail(s.name),
                      },
                        // 列表行行首也给头像：有真图用真图（与市场同源），没有用生成头像，
                        // 两种视图观感一致。
                        skillIconFor(s, expertByPlugin)
                          ? h(Avatar, { url: skillIconFor(s, expertByPlugin), name: s.name, className: 'dsh-mcp-skill-avatar-img sm' })
                          : h(SkillAvatar, { name: s.name, size: 'sm' }),
                        h('div', { className: 'dsh-mcp-skill-main' },
                          h('div', { className: 'dsh-mcp-skill-name' }, s.name),
                          h('div', { className: 'dsh-mcp-skill-sub' },
                            s.modelInvocable ? h(Badge, { cls: 't-http' }, t('模型可调用')) : null,
                            s.userInvocable ? h(Badge, { cls: 't-stdio' }, t('用户可调用')) : null,
                            // §3.1 来源固定在行内：不再有来源分组头，滚动到中途也要知道这条来自哪里。
                            s.source ? h('span', { className: 'dsh-mcp-skill-src-badge', title: skillSourceLabel(s.source) }, skillSourceLabel(s.source)) : null,
                            s.provider ? h('span', { className: 'dsh-mcp-skill-src' }, s.provider) : null,
                            skillTimeBadge(s),
                          ),
                          s.description ? h('div', { className: 'dsh-mcp-skill-desc' }, s.description) : null,
                        ),
                      )),
                    ].filter(Boolean)),
                  )
                : clustered.map((cluster) => h('div', { key: cluster.key, className: 'dsh-mcp-skill-cluster' },
                    !activeCat ? h('div', { className: 'dsh-mcp-item-sub' },
                      h('span', { className: 'dsh-mcp-skill-cat-tile', style: { background: cluster.cat.color } }),
                      cluster.cat.name,
                      h('span', null, cluster.rows.length + t(' 个')),
                    ) : null,
                    h('div', { className: 'dsh-mcp-skill-grid' },
                      cluster.rows.map((s) => {
                        const sCat = catOf.get(s.name) || SKILL_UNCAT;
                        const note = skillNote(s);
                        return h('button', {
                          key: s.name,
                          type: 'button',
                          'aria-pressed': selected === s.name,
                          className: 'dsh-mcp-skill-card' + (selected === s.name ? ' on' : ''),
                          onClick: () => openDetail(s.name),
                        },
                          h('div', { className: 'dsh-mcp-skill-card-inner' },
                            h('div', { className: 'dsh-mcp-skill-card-top' },
                              // 市场同款头像位：wbexpert 捆绑技能反推专家真头像、其余按 SkillHub
                              // slug 精确匹配补真图标（skillIconFor），取不到真图才用生成头像。
                              // 分类语义保留：title 带分类名，foot 里有分类文字。
                              skillIconFor(s, expertByPlugin)
                                ? h(Avatar, { url: skillIconFor(s, expertByPlugin), name: s.name, className: 'dsh-mcp-skill-avatar-img', title: sCat.name })
                                : h(SkillAvatar, { name: s.name, title: sCat.name }),
                              h('span', { className: 'dsh-mcp-skill-card-name' }, s.name),
                            ),
                            s.description
                              ? h('div', { className: 'dsh-mcp-skill-desc' }, s.description)
                              : h('div', { className: 'dsh-mcp-skill-desc dsh-mcp-skill-desc-none' }, t('（无描述）')),
                            note ? h('div', { className: 'dsh-mcp-skill-note', title: note.title }, note.text) : null,
                            h('div', { className: 'dsh-mcp-skill-card-foot' },
                              h('span', { className: 'dsh-mcp-skill-cat-tag' }, sCat.name),
                              skillTimeBadge(s),
                              h('div', { className: 'dsh-mcp-skill-sub' },
                                s.modelInvocable ? h(Badge, { cls: 't-http' }, t('模型可调用')) : null,
                                s.userInvocable ? h(Badge, { cls: 't-stdio' }, t('用户可调用')) : null,
                              ),
                            ),
                          ),
                        );
                      }),
                    ),
                  ))),
        ),
      ),
      // 网格视图的详情以弹窗呈现（与市场卡片详情同一套观感），列表视图仍走右侧栏。
      // 遮罩单独做一层兄弟节点而不是包住弹窗：点遮罩即关，点弹窗内部不会冒泡到它。
      isModal
        ? h('div', { className: 'dsh-mcp-skill-modal-hit', onClick: requestCloseDetail })
        : null,
      h('div', {
        className: 'dsh-mcp-skill-detail' + (isModal ? ' is-modal' : ''),
        role: isModal ? 'dialog' : undefined,
        'aria-modal': isModal ? true : undefined,
        'aria-label': isModal ? t('技能详情') : undefined,
        tabIndex: isModal ? -1 : undefined,
        ref: isModal ? focusModal : undefined,
        onKeyDown: isModal
          ? (e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                requestCloseDetail();
              }
            }
          : undefined,
      },
        // 弹窗要有看得见的出口：市场那边的详情弹窗都带关闭按钮，这里保持一致。
        isModal
          ? h('button', {
              type: 'button',
              className: 'dsh-mcp-skill-d-close',
              title: t('关闭'),
              'aria-label': t('关闭'),
              onClick: requestCloseDetail,
            }, h(Icon, { d: ICONS.x, size: 14 }))
          : null,
        !summary && !detailLoading
          ? h('div', { className: 'dsh-mcp-skill-empty' }, t('从左侧选择一个 skill 查看详情'))
          : null,
        summary ? h('div', { className: 'dsh-mcp-skill-d-head' },
          // 详情头与市场详情弹层同一构图：头像 + 标题块，打开目录按钮保持在最右。
          h('div', { className: 'dsh-mcp-skill-d-id' },
            skillIconFor(summary, expertByPlugin)
              ? h(Avatar, { url: skillIconFor(summary, expertByPlugin), name: summary.name, className: 'dsh-mcp-skill-avatar-img lg' })
              : h(SkillAvatar, { name: summary.name, size: 'lg' }),
            h('div', null,
              h('h3', { className: 'dsh-mcp-skill-d-title' }, summary.name),
              h('div', { className: 'dsh-mcp-skill-d-badges' },
                summaryCat ? h(Badge, { cls: 't-stdio' }, summaryCat.name) : null,
                summary.modelInvocable ? h(Badge, { cls: 't-http' }, t('模型可调用')) : null,
                summary.userInvocable ? h(Badge, { cls: 't-stdio' }, t('用户可调用')) : null,
              ),
              h('p', { className: 'dsh-mcp-skill-d-src' },
                skillSourceLabel(summary.source) + (summary.provider ? ' · ' + summary.provider : '')),
            ),
          ),
          summary.path ? h('button', {
            type: 'button',
            className: 'dsh-mcp-skill-d-path',
            title: t('把 skill 所在目录交给宿主在资源管理器中打开（只读定位）'),
            onClick: () => { call('revealSkill', { ...skillScopeArg(scope), name: summary.name, path: summary.path }); },
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
            h('b', null, t('详情')),
            h('div', { className: 'dsh-mcp-skill-d-meta' },
              h('span', null, t('所属分类')),
              h('b', null, summaryCat ? summaryCat.name : '—'),
              h('span', null, t('来源目录')),
              h('b', null, skillSourceLabel(summary.source) + (summary.provider ? ' · ' + summary.provider : '')),
              summary.path ? [h('span', { key: 'pl' }, t('文件位置')), h('b', { key: 'pv' }, summary.path)] : null,
              installTime ? [h('span', { key: 'itl' }, t('安装时间')), h('b', { key: 'itv' }, wbFormatDate(installTime))] : null,
              summaryInstall?.marketName
                ? [h('span', { key: 'ml' }, t('市场原名')),
                   h('b', { key: 'mnv' }, summaryInstall.marketName
                     + (summaryInstall.marketplace
                       ? ' · ' + (summaryInstall.marketplace === 'workbuddy-skills' ? t('SkillHub') : summaryInstall.marketplace)
                       : ''))] : null,
            ),
          ),
          h('div', { className: 'dsh-mcp-skill-d-actions' },
            summary.path ? h('button', {
              type: 'button', className: 'dsh-mcp-btn', onClick: copySkillMdPath,
            }, h(Icon, { d: ICONS.copy, size: 13 }), t('复制 SKILL.md 路径')) : null,
            h('button', {
              type: 'button', className: 'dsh-mcp-btn', onClick: copySessionRef,
            }, h(Icon, { d: ICONS.copy, size: 13 }), t('复制 @会话引用')),
            // 卸载入口只在「来源可定位到用户级/项目级 skills 根」且确有磁盘路径时出现。
            // 二次确认就地展开（不弹窗、不移位），确认按钮为危险色，取消在左侧。
            skillRemovable(summary.source) && summary.path
              ? (confirmRemove
                  ? h(InlineConfirm, {
                      question: t('将从磁盘永久删除 {0}（不可撤销），确认卸载？', [summary.name]),
                      confirmLabel: removing ? t('卸载中…') : t('确认卸载'),
                      busy: removing,
                      onConfirm: removeSelected,
                      onCancel: () => setConfirmRemove(false),
                    })
                  : h('button', {
                      type: 'button', className: 'dsh-mcp-btn danger', disabled: removing,
                      title: t('永久删除这个 skill 所在目录（不可撤销）'),
                      onClick: () => { setRemoveError(''); setConfirmRemove(true); },
                    }, h(Icon, { d: ICONS.trash, size: 13 }), t('卸载')))
              : null,
          ),
          !skillRemovable(summary.source)
            ? h('div', { className: 'dsh-mcp-readonly-note' },
                h(Icon, { d: ICONS.eye, size: 12 }),
                h('span', null, t('这个 skill 来自「{0}」，不在可卸载范围内：随 DSH 分发、运行时注册与自定义目录的 skill 只能查看。要停用它，请编辑所属预设或 SKILL.md。', [skillSourceLabel(summary.source)])),
              )
            : null,
          removeError ? h('div', { className: 'dsh-mcp-d-err' }, removeError) : null,
          detailLoading ? h('div', { className: 'dsh-mcp-skill-empty' }, t('读取 skill 内容…')) : null,
          detailError ? h('div', { className: 'dsh-mcp-d-err' }, detailError) : null,
          detail && detail.content !== undefined ? h('div', { className: 'dsh-mcp-skill-d-sec' },
            h('b', null, t('指令内容（') + detail.content.length + t(' 字符）')),
            h('pre', { className: 'dsh-mcp-skill-d-md' }, detail.content),
          ) : null,
          toast ? h('div', { className: 'dsh-mcp-skill-d-flash' + (toast.ok ? '' : ' err') }, toast.msg) : null,
        ) : null,
      ),
    ) : null,
    // 套件管理弹窗：挂在「看板可用」判据**之外**——它读的是本插件自己的数据层，
    // 就算宿主没挂载 skill 注册表（error 态、工具条不渲染），召唤菜单里的「管理套件…」
    // 也仍应能把它打开，只是左侧候选列表是空的。
    suiteOpen
      ? h(SuiteManager, {
          call,
          // 用未按作用域收窄的全集：套件成员常是用户级技能，项目作用域下也必须能判出
          // 「有效 / 已失效」，不能因为当前 tab 是某个工作区就把它们全标失效。
          skills: allSkills,
          catOf,
          suites,
          onClose: () => setSuiteOpen(false),
          // 保存成功后一律以宿主返回的集合为真值：新分配的 id 只出现在返回值里，
          // 拿本地副本回填会让同一条套件在下次保存时被当成「新建」再存一份。
          onSaved: setSuites,
          notify: showNotice,
        })
      : null,
    notice ? h('div', { className: 'dsh-mcp-toast ' + (notice.ok ? 'ok' : 'err'), role: 'status' }, notice.msg) : null,
  );
};

// ── WorkBuddy 市场直连（看板分类之一）────────────────────────────────
// 两个市场一个面板：上半「连接器」（WorkBuddy 官方 ZIP，MCP 配置直接可装），下半「技能」
// （SkillHub 公开 API，逐文件 sha256 校验后装进 ~/.agents/skills）。数据与安装都走 Host 的
// wb* RPC（浏览器不直连腾讯/SkillHub），失败文案保留 Host 给出的原因。
// 已安装标记：技能按 wbSkillInstalled 的目录记录——只在进入面板时取一次，装/卸后局部刷新。
const WB_MARKET_CONNECTOR_PAGE_SIZE = 60;
// 社区 MCP（官方 Registry）：单页 100 是服务端上限，也是翻页步长——页内容互斥，
// 内存里始终只有一页，不再需要「累计上限」。与 lib/mcp-community.js 的
// COMMUNITY_PAGE_LIMIT 同值（浏览器侧是独立产物，改一处记得另一处）。
const COMMUNITY_BATCH_LIMIT = 100;
// T02/R2：visible_in 标签筛选语义与 lib/wb-market.js 的 matchesVisibleIn 一致——
// selected 为空 = 全过；行未标 = 不受该维度过滤；命中为「任一命中」（OR，UI 直观）。
// 放这里而不是组件内：纯数据判断，避免每次渲染重建闭包。
const connectorMatchesVisibleIn = (rowVisibleTags, selectedTags) => {
  if (!Array.isArray(selectedTags) || !selectedTags.length) return true;
  if (!Array.isArray(rowVisibleTags) || !rowVisibleTags.length) return true;
  return rowVisibleTags.some((tag) => selectedTags.includes(tag));
};
const WB_SKILLHUB_SORTS = [
  { key: 'downloads', get label() { return t('下载量（本页排序）'); } },
  { key: 'installs', get label() { return t('最多安装'); } },
  { key: 'stars', get label() { return t('最多星标'); } },
  { key: 'score', get label() { return t('综合评分'); } },
];
// T05/R10：连接器排序（全量本地排序，不受分页影响）。
// 目录自带 skillCount（捆绑技能数）与 visibleIn（适用环境标签数），够做有意义的排序；
// upstream 无下载量/评分字段，不臆造。
const WB_CONNECTOR_SORTS = [
  { key: 'default', get label() { return t('目录默认顺序'); } },
  { key: 'skills', get label() { return t('技能数由多到少'); } },
  { key: 'name', get label() { return t('名称 A→Z'); } },
];
// T06/Awesome：DSH 社区目录排序（全量本地排序，不受分页影响）。
// upstream 自带 stars 与 lastVerified，无评分字段，不臆造。
// 下载量从 2.3.x 起有了（npm 公开统计），但它**只给当前页按可见卡片懒取**、且是
// 近 30 天窗口：拿一份不完整、随页变化的数据做全量排序会排出个假名次，所以不加这档。
const AWESOME_SORTS = [
  { key: 'stars', get label() { return t('最多星标'); } },
  { key: 'recent', get label() { return t('最新收录'); } },
  { key: 'name', get label() { return t('名称 A→Z'); } },
];
const AWESOME_CATEGORIES = [
  { key: 'all', get label() { return t('全部'); } },
  { key: 'plugin', get label() { return t('插件'); } },
  { key: 'skill', get label() { return t('技能'); } },
  { key: 'bundle', get label() { return t('套件'); } },
  { key: 'tool', get label() { return t('工具'); } },
];
const AWESOME_TAGS = ['ui', 'terminal', 'agents', 'memory', 'models', 'vision', 'capabilities', 'channels', 'notifications', 'usage', 'observability', 'marketplace', 'devtools', 'safety', 'knowledge', 'interop', 'fun'];
const AWESOME_PAGE_SIZE = 50;

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
// §4.2 跨分类技能定位：专家卡上的捆绑技能 chip 点击 → 跳 Skill 页并打开该技能详情。
// 两段式：页面可能还没挂载（当前在专家页），所以目标先记在模块里，SkillBoard 挂载后自领；
// 已挂载时直接广播，省掉一次可见的中间态。
let pendingSkillFocus = '';
const skillFocusListeners = new Set();
function openSkillFocus(name) {
  const target = String(name || '').trim();
  if (!target) return;
  pendingSkillFocus = target;
  for (const listener of [...skillFocusListeners]) {
    try { listener(target); } catch { /* 单个订阅者失败不影响跳转本身 */ }
  }
  openBoardCategory('skill');
}
const onSkillFocus = (listener) => {
  skillFocusListeners.add(listener);
  return () => { skillFocusListeners.delete(listener); };
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
  // 正在拉详情的那张卡（plugin 名）：加载期间只把这一个卡片的「详情」按钮标成「读取中…」，
  // 弹层等数据到手才挂载——中途先 setDetail 一个只有标题的矮盒子会「先闪小窗、再跳大窗」
  // （.dsh-mcp-modal 高度随内容自适应）。与市场页 ExpertMarket 同一套做法。
  const [openingPlugin, setOpeningPlugin] = useState('');
  // §4.1 在场：expertActive 是「谁真的挂在会话上」的唯一真源。没有它，「已召唤」
  // （预设已落盘，新会话才接管）和「在场」（人设真的在这轮对话里生效）就是同一个绿 tag，
  // 而这恰恰是这一页最该说清楚的区别。
  const [activeRows, setActiveRows] = useState([]);
  // §4.1 送还二次确认：内联确认，不弹窗（弹窗会打断「确认—执行」的因果关系）。
  const [confirmDismiss, setConfirmDismiss] = useState('');
  // OPT-16 · 3.2：persona 预览展开态（已召唤专家详情弹层局部）。
  const [personaExpanded, setPersonaExpanded] = useState(false);
  // §4.1 空白区填充：召唤位推荐（catalog 前若干位，排除已召唤）。
  const [catalog, setCatalog] = useState([]);
  // OPT-21：详情弹层此前没有 ref，焦点陷阱需要容器节点。
  const summonedRef = useRef(null);
  useFocusTrap(summonedRef, !!detail);

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

  // §4.1 在场快照：与 SessionExpertBadge 同源（expertActive），并订阅同一个变更总线，
  // 这样在会话头挂了/摘了专家，这一页不需要刷新就是对的。
  useEffect(() => {
    let alive = true;
    const sync = () => {
      call('expertActive').then((res) => {
        if (!alive) return;
        const rows = res && res.ok && Array.isArray(res.sessions) ? res.sessions : [];
        setActiveRows(rows);
      }).catch(() => {});
    };
    sync();
    const off = onExpertChange(sync);
    const stopPoll = startVisibilityAwarePolling(typeof document === 'undefined' ? null : document, null, 5000, sync);
    return () => { alive = false; off(); stopPoll(); };
  }, [call]);

  // §4.1 召唤位推荐 + 头像补全：无条件取共享目录（模块级 10 分钟缓存，与市场页同一条，
  // 市场开过就是零网络）。为什么不能只在架上为空时取：预设行的 avatarUrl 依赖**宿主侧**
  // expert-market.js 的新旧——宿主进程没重启时 wbExpertInstalled 不带 avatarUrl，卡面就
  // 永远是字母。目录是稳定的旧 RPC，卡片头像一律先查目录（plugin → avatarUrl）再回落行字段。
  useEffect(() => {
    if (loading) return undefined;
    let alive = true;
    loadExpertCatalogShared(call).then((data) => {
      if (alive) setCatalog(Array.isArray(data.experts) ? data.experts : []);
    }).catch(() => {});
    return () => { alive = false; };
  }, [call, loading]);

  // 召唤（推荐位点击）：与市场页同一条写链，成功后刷新本页 + 广播给会话头徽章。
  const summon = async (expert) => {
    setBusy(true); setBusyLabel(t('正在召唤 {0}…', [expert.name || expert.plugin])); setError('');
    try {
      const res = await call('wbExpertSummon', { plugin: expert.plugin, withSkills: true });
      if (!res?.ok) throw new Error(res?.error || t('召唤失败'));
      setNote(t('{0} 已召唤，新建会话时可在预设选择器里选它', [expert.name || expert.plugin]));
      await load();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false); setBusyLabel('');
    }
  };

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
    // 弹层只在详情数据到手后挂载一次（理由同市场页：中途挂矮盒子会闪一下再变大）。
    if (openingPlugin) return;   // 串行化：一条没回来就别再拉第二条。
    setOpeningPlugin(plugin);
    setNote('');
    try {
      const res = await call('wbExpertDetail', { plugin });
      if (!res?.ok) throw new Error(res?.error || t('读取详情失败'));
      setDetail({ ...res });
    } catch (e) {
      // 失败也开弹层：里面有 detailError 红字，比「点了没反应」好排查。
      setDetail({ plugin, detailError: String(e?.message || e) });
    } finally {
      setOpeningPlugin('');
    }
  };

  // 技能按 plugin 分组：预设行是主行，捆绑技能是它的附件清单。
  const skillsByPlugin = {};
  for (const row of skills) (skillsByPlugin[row.plugin] ??= []).push(row.skill);
  // 在场行按 plugin 归并：同一专家可能同时挂在多个会话上（不同 sessionId），
  // 卡面只关心「这个 plugin 现在有几个会话在用」，逐个会话平铺会把同一张卡切成多份。
  const activeByPlugin = new Map();
  for (const row of activeRows) {
    if (!activeByPlugin.has(row.plugin)) activeByPlugin.set(row.plugin, []);
    activeByPlugin.get(row.plugin).push(row);
  }
  // 推荐位：目录里还没召唤的，按目录序取前 6 —— 不排序、不评分，避免自造推荐逻辑。
  const summonedPlugins = new Set(presets.map((row) => row.plugin));
  const recommend = catalog.filter((item) => item && item.plugin && !summonedPlugins.has(item.plugin)).slice(0, 6);
  // plugin → 头像：预设行字段优先？不——目录优先。预设行的 avatarUrl 依赖宿主侧模块
  // 新旧（宿主没重启就不带），目录走的是稳定旧 RPC，两处都有时值也相同，取目录只为
  // 在行字段缺席时仍能出图。查不到（目录没落盘）回落行字段，再回落空 → Avatar 出字母。
  const catalogAvatar = new Map();
  for (const item of catalog) {
    if (item && item.plugin && item.avatarUrl) catalogAvatar.set(item.plugin, item.avatarUrl);
  }
  const presetAvatar = (plugin) => catalogAvatar.get(plugin) || '';
  return h('div', null,
    note ? h('div', { className: 'dsh-mcp-wb-note', role: 'status' }, note) : null,
    busyLabel ? h('div', { className: 'dsh-mcp-wb-note busy', 'aria-live': 'polite' }, busyLabel) : null,
    error ? h('div', { className: 'dsh-mcp-wb-error', role: 'alert' }, error) : null,
    loading ? h('div', { className: 'dsh-mcp-wb-empty' }, t('正在读取已召唤专家…')) : null,
    // §4.1「当前在场」区：已召唤 = 预设已落盘（新会话才接管），在场 = 人设真的挂在
    // 运行中的会话上。这两件事原来共用一个绿 tag，是最容易误判的地方，所以单独成区、
    // 单独给色（在场用绿，已召唤但不在场用中性）。
    !loading
      ? h('div', { className: 'dsh-mcp-onsite' },
          h('div', { className: 'dsh-mcp-onsite-head' },
            h('b', null, t('当前在场')),
            h('span', null, activeRows.length
              ? t('{0} 个专家正挂在 {1} 个会话上', [activeByPlugin.size, activeRows.length])
              : t('没有专家正在接管会话')),
          ),
          activeRows.length === 0
            ? h('div', { className: 'dsh-mcp-onsite-empty' },
                t('召唤的专家是「预设」：新建会话时在预设选择器里选它才真正接管。想立刻让某个专家接管当前会话，用输入框左侧的召唤菜单。'))
            : [...activeByPlugin.entries()].map(([plugin, rows]) => {
                const preset = presets.find((p) => p.plugin === plugin);
                const bound = skillsByPlugin[plugin] || [];
                return h('div', { key: plugin, className: 'dsh-mcp-onsite-body' },
                  // 在场行也给头像：目录优先（稳定旧 RPC），回落预设行字段，与下方卡片一一对应。
                  h(Avatar, {
                    url: preset ? (presetAvatar(plugin) || preset.avatarUrl) : '',
                    name: (rows[0] && rows[0].name) || (preset && preset.nameZh) || plugin,
                    className: 'dsh-mcp-onsite-avatar',
                  }),
                  h('div', { className: 'dsh-mcp-onsite-name' }, (rows[0] && rows[0].name) || (preset && preset.presetId) || plugin),
                  preset && preset.presetId ? h('div', { className: 'dsh-mcp-onsite-role' }, preset.presetId) : null,
                  bound.length
                    ? h('div', { className: 'dsh-mcp-onsite-chips' },
                        bound.slice(0, 6).map((skill) => h('button', {
                          key: skill,
                          type: 'button',
                          className: 'dsh-mcp-chip-s',
                          title: t('在 Skill 页查看 {0}', [skill]),
                          onClick: () => openSkillFocus(skill),
                        }, skill)),
                        bound.length > 6 ? h('span', { className: 'dsh-mcp-chip-s more' }, '+' + (bound.length - 6)) : null,
                      )
                    : h('div', { className: 'dsh-mcp-onsite-chips' }, h('span', { className: 'dsh-mcp-onsite-role' }, t('无捆绑技能'))),
                  h('div', { className: 'dsh-mcp-onsite-act' },
                    h('span', { className: 'dsh-mcp-onsite-role', title: rows.map((r) => r.sessionId).join('\n') },
                      rows.length > 1 ? t('{0} 个会话', [rows.length]) : t('会话 {0}', [String(rows[0].sessionId || '').slice(0, 8)])),
                  ),
                );
              }),
        )
      : null,
    // 已召唤清单：这里才是「送还」的主场；送还走内联确认（见 §4.1）。
    !loading && !presets.length && !skills.length
      ? h(EmptyState, {
          icon: 'expert',
          title: t('还没有召唤任何专家'),
          hint: t('召唤后它会作为独立 Agent 预设出现在新会话的预设选择器里；也可以直接从下面的推荐位挑一位。'),
          actions: [{ label: t('去市场挑专家'), icon: 'store', onClick: () => openBoardCategory('wb') }],
        })
      : null,
    !loading && presets.length
      ? h('div', { className: 'dsh-mcp-wb-grid' },
          presets.map((row) => {
            const boundSkills = skillsByPlugin[row.plugin] || [];
            const activeList = activeByPlugin.get(row.plugin) || [];
            const confirming = confirmDismiss === row.plugin;
            // 显示名与召唤菜单同一投影（跟宿主语言）：目录缓存名 → 预设行自带名 → plugin 标识名。
            const presetLabel = usesEnglish()
              ? (row.nameEn || row.nameZh || row.plugin)
              : (row.nameZh || row.nameEn || row.plugin);
            return h('div', { key: row.presetId, className: 'dsh-mcp-card wb installed' },
              h('div', { className: 'dsh-mcp-card-top' },
                // 市场专家卡同款头像位：目录优先（稳定旧 RPC，宿主没重启也能出图），
                // 回落 wbExpertInstalled 带出的行字段；取不到图时 Avatar 自动回落首字母。
                h('div', { className: 'dsh-mcp-card-person' },
                  h(Avatar, { url: presetAvatar(row.plugin) || row.avatarUrl, name: presetLabel, className: 'dsh-mcp-card-avatar' }),
                  h('div', null,
                    h('div', { className: 'dsh-mcp-card-name' }, presetLabel),
                    h('div', { className: 'dsh-mcp-card-vendor' }, row.presetId),
                  ),
                ),
                activeList.length
                  ? h(Badge, { cls: 's-on' }, t('在场 · {0} 会话', [activeList.length]))
                  : h(Badge, { cls: 's-off' }, t('已召唤 · 未接管')),
              ),
              // §4.2 绑定技能 chips 化：纯文本看不出能不能点，点了以后去哪也不清楚。
              boundSkills.length
                ? h('div', { className: 'dsh-mcp-card-tags' },
                    boundSkills.map((skill) => h('button', {
                      key: skill,
                      type: 'button',
                      className: 'dsh-mcp-chip-s',
                      title: t('在 Skill 页查看 {0}', [skill]),
                      onClick: () => openSkillFocus(skill),
                    }, skill)))
                : h('div', { className: 'dsh-mcp-card-summary' }, t('无捆绑技能（预设本体在 profile 补丁）')),
              h('div', { className: 'dsh-mcp-wb-card-actions' },
                h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: openingPlugin === row.plugin, 'aria-busy': openingPlugin === row.plugin || undefined, onClick: () => openDetail(row.plugin) }, openingPlugin === row.plugin ? t('读取中…') : t('详情')),
                confirming
                  // 内联确认：不弹窗、不移位——原地换成「确认/取消」，误触成本从 0 提到 1 次点击。
                  ? h(InlineConfirm, {
                      question: t('送还后此人设从所有会话移除，确认送还？'),
                      confirmLabel: t('确认送还'),
                      busy,
                      onConfirm: () => { setConfirmDismiss(''); dismiss(row.plugin, row.plugin); },
                      onCancel: () => setConfirmDismiss(''),
                    })
                  : h('button', {
                      type: 'button', className: 'dsh-mcp-btn danger', disabled: busy,
                      onClick: () => setConfirmDismiss(row.plugin),
                    }, t('送还')),
              ),
            );
          }),
        )
      : null,
    // §4.1 空白区：推荐位（原页面 80% 是空白，且没有任何「下一步」）。
    // 排版走 .dsh-mcp-wb-reco：提示行与上方已召唤网格、下方推荐卡网格之间都要留白，
    // 10.5px 的小字提示紧贴卡片会糊成一片（间距见 CSS 侧同名规则）。
    !loading && recommend.length
      ? h('div', { className: 'dsh-mcp-wb-reco' },
          h('div', { className: 'dsh-mcp-item-sub' },
            h('span', null, presets.length ? t('再看看这些（目录前 {0} 位未召唤）', [recommend.length]) : t('可以从这几位开始（目录前 {0} 位）', [recommend.length])),
            h('a', { href: '#', onClick: (e) => { e.preventDefault(); openBoardCategory('wb'); } }, t('去市场看全部')),
          ),
          h('div', { className: 'dsh-mcp-wb-grid' },
            recommend.map((item) => h('div', { key: item.plugin, className: 'dsh-mcp-card wb' },
              h('div', { className: 'dsh-mcp-card-top' },
                // 推荐位与市场卡同构（card-person + Avatar），目录行自带 avatarUrl。
                h('div', { className: 'dsh-mcp-card-person' },
                  h(Avatar, { url: item.avatarUrl, name: item.name || item.plugin, className: 'dsh-mcp-card-avatar' }),
                  h('div', null,
                    h('div', { className: 'dsh-mcp-card-name' }, item.name || item.plugin),
                    h('div', { className: 'dsh-mcp-card-vendor' }, item.profession || item.category || item.plugin),
                  ),
                ),
              ),
              item.description ? h('div', { className: 'dsh-mcp-card-summary' }, item.description) : null,
              h('div', { className: 'dsh-mcp-wb-card-actions' },
                h('button', { type: 'button', className: 'dsh-mcp-btn primary', disabled: busy, onClick: () => summon(item) }, t('召唤')),
              ),
            )),
          ),
        )
      : null,
    // 详情弹层：与市场页共用结构（只读 + 送还）。
    detail
      ? h('div', { className: 'dsh-mcp-overlay', onClick: (e) => !busy && e.target === e.currentTarget && setDetail(null) },
          h('div', { ref: summonedRef, className: 'dsh-mcp-modal dsh-mcp-wb-modal', role: 'dialog', 'aria-modal': true, 'aria-label': t('已召唤专家详情'), tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); setDetail(null); } } },
            // 详情头与市场专家详情同一构图：头像 + 标题行（wbExpertDetail 展开 catalog 行自带 avatarUrl）。
            h('div', { className: 'dsh-mcp-wb-modal-head' },
              h(Avatar, { url: detail.avatarUrl, name: detail.name || detail.plugin, className: 'dsh-mcp-detail-avatar' }),
              h('h3', null, detail.name ? t('{0}（{1}）', [detail.name, detail.profession || '']) : detail.plugin),
            ),
            h('div', null,
                  detail.detailError ? h('p', { className: 'dsh-mcp-wb-error' }, detail.detailError) : null,
                  detail.description ? h('p', { className: 'dsh-mcp-wb-modal-desc' }, detail.description) : null,
                  Array.isArray(detail.skills) && detail.skills.length
                    ? h('div', { className: 'dsh-mcp-card-tags' },
                        detail.skills.map((skill) => h(Badge, { key: skill.name, cls: skill.local ? 's-on' : '' }, skill.name)))
                    : null,
                  detail.personaSource === 'generated'
                    ? h('p', { className: 'dsh-mcp-wb-modal-note' }, t('人设正文是按专家介绍生成的替身，不是原作者设定；原文不可用。'))
                    : null,
                  detail.persona
                    ? h('div', { className: 'dsh-mcp-skill-d-sec' },
                        h('b', null, t('人设正文（{0} 字符）', [detail.personaChars || detail.persona.length])),
                        h('pre', { className: 'dsh-mcp-skill-d-md' }, personaExpanded || detail.persona.length <= PERSONA_PREVIEW_MAX ? detail.persona : detail.persona.slice(0, PERSONA_PREVIEW_MAX) + t('\n…（预览截断）')),
                          personaExpanded
                            ? h('button', { type: 'button', className: 'dsh-mcp-btn dsh-mcp-link-btn', onClick: () => setPersonaExpanded(false) }, t('收起'))
                            : detail.persona.length > PERSONA_PREVIEW_MAX
                              ? h('button', { type: 'button', className: 'dsh-mcp-btn dsh-mcp-link-btn', onClick: () => setPersonaExpanded(true) }, t('展开全文（{0} 字符）', [fmtInt(detail.persona.length)]))
                              : null,
                      )
                    : null,
                  h('p', { className: 'dsh-mcp-wb-modal-note' },
                    t('该专家以独立 Agent 预设生效：新建会话时在预设选择器选择「WorkBuddy 专家 · …」即专家接管。送还会同时清掉它的捆绑技能。')),
                ),
            h('div', { className: 'dsh-mcp-modal-actions' },
              h(Btn, { onClick: () => setDetail(null), disabled: busy, children: t('关闭') }),
              h(Btn, { danger: true, icon: 'trash', disabled: busy, onClick: () => dismiss(detail.plugin, detail.name), children: t('送还') }),
            ),
          ),
        )
      : null,
  );
};
// 装备清单「去市场」需要把专家搜索词带进专家页；ExpertMarket 的签名被回归测试钉死，
// 所以用一个一次性模块级种子，不新增 prop。
let expertMarketSeedQuery = '';
const seedExpertMarketQuery = (value) => { expertMarketSeedQuery = String(value || '').trim(); };
const takeExpertMarketSeedQuery = () => {
  const value = expertMarketSeedQuery;
  expertMarketSeedQuery = '';
  return value;
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
  const [meta, setMeta] = useState({});
  const [source, setSource] = useState('');
  const [query, setQuery] = useState(() => takeExpertMarketSeedQuery());
  const [category, setCategory] = useState('all');
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState(null);
  // 已召唤预设行（含 personaText）：团队行需要人设正文做 stale 体检——
  // 旧版本召唤写入的团队预设没有桥接段，新会话选它会调不存在的 TeamCreate/Agent。
  const [presetRows, setPresetRows] = useState([]);
  const presets = useMemo(() => new Set(presetRows.map((row) => row.plugin)), [presetRows]);
  const [withSkills, setWithSkills] = useState(true);
  const [installedSkillPlugins, setInstalledSkillPlugins] = useState(new Set());
  // OPT-21：市场专家详情弹层此前没有 ref。
  const expertDetailRef = useRef(null);
  useFocusTrap(expertDetailRef, !!detail);
  // OPT-16/26 · 3.2/3.3：详情弹层里「人设全文展开」「quickPrompts 全部展开」两个局部开关。
  // 必须声明在组件顶层、**每次渲染都调用**：这两个 hook 原先写在
  // `detail ? (() => { … })() : null` 这个条件 IIFE 里，首帧 detail 为 null 时一次都不调用，
  // 点卡片「详情」后同一组件突然多调用两个 hook —— React #310
  // 「Rendered more hooks than during the previous render」直接把整块面板打进错误边界
  // （用户看到的就是市场专家页点详情即白屏报 #310）。开关只在打开详情时重置，
  // 保证换一个专家进来是折叠态，而不是沿用上一条的展开状态。
  const [personaExpanded, setPersonaExpanded] = useState(false);
  const [showAllPrompts, setShowAllPrompts] = useState(false);
  // 正在拉详情的那张卡片（plugin 名）：加载期间只把这一个卡片的「详情」按钮标成「读取中…」，
  // 详情弹层等数据到手才挂载。**不要**在加载中途先 setDetail 一个只有标题的矮盒子——.dsh-mcp-modal
  // 高度随内容自适应，那会让用户看到「先闪一个小窗、再跳成大窗」。
  const [openingPlugin, setOpeningPlugin] = useState('');

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
      setMeta(data.meta || {});
      setSource(data.loadedFrom);
      if (recordMarketSnapshot('expert', data.experts.map((expert) => ({
        key: expert.id || expert.plugin,
        name: expert.name,
        sig: String(expert.updatedAt || ''),
      })))) {
        emitMarketPulse();
      }
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setLoading(false);
    }
  }, [call]);

  useEffect(() => { load(); loadInstalled(); }, [load, loadInstalled]);

  const openDetail = async (expert) => {
    // 弹层**只在详情数据到手后挂载一次**。此前这里是「先 setDetail({…, loading:true}) 挂个矮盒子，
    // 拿到人设与技能清单后再 setDetail 一次」：因为 .dsh-mcp-modal 高度随内容自适应，用户看到的就是
    // 先闪一个小窗、再跳成大窗。现在加载期间只在卡片按钮上显示「读取中…」，弹层一次到位。
    if (openingPlugin) return;   // 串行化：一条还没回来就别再拉第二条，避免后到的覆盖先到的。
    setOpeningPlugin(expert.plugin);
    setNote('');
    // 展开态跟着「这一次打开」重置，别让上一条专家留下的展开状态带进来。
    setPersonaExpanded(false);
    setShowAllPrompts(false);
    try {
      const res = await call('wbExpertDetail', { plugin: expert.plugin });
      if (!res?.ok) throw new Error(res?.error || t('读取详情失败'));
      setDetail({ ...expert, ...res });
    } catch (e) {
      // 失败也要把弹层开出来：里面有 detailError 的红字，比「点了没反应」好排查。
      setDetail({ ...expert, detailError: String(e?.message || e) });
    } finally {
      setOpeningPlugin('');
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
  // §6.4 分类 chips：原来只有一个分类下拉，429 位专家怎么分布完全看不见，
  // 用户点进去才知道某个分类只有两三个人。改成 chips 条后各类体量一眼可见。
  // 计数在这里一次算完（而不是每个 option 里各 filter 一遍——那是 O(n×m)）。
  const categoryCounts = {};
  for (const item of experts) categoryCounts[item.categoryId] = (categoryCounts[item.categoryId] || 0) + 1;
  const categoryChips = [
    { id: 'all', name: t('全部'), count: experts.length },
    ...categories.map((cat) => ({ id: cat.id, name: cat.name, count: categoryCounts[cat.id] || 0 })),
  ].filter((row) => row.count > 0 || row.id === 'all');
  return h('div', null,
    h('div', { className: 'dsh-mcp-wb-toolbar' },
      h(WbSearchBox, {
        value: query, placeholder: t('搜索专家（花名 / 职业 / 描述 / 标签）'), busy: loading,
        onChange: (value) => { setQuery(value); setPage(1); },
      }),
      h('span', { className: 'dsh-mcp-builtin-count' },
        t('显示 {0} / {1}', [filtered.length, experts.length]) + (searching ? t(' · 全库搜索（忽略分类）') : '') + (source === 'network' ? t(' · 已更新') : source === 'disk' ? t(' · 缓存') : '')),
    ),
    (meta.authorName || meta.lastUpdated)
      ? h('div', { className: 'dsh-mcp-catalog-meta' },
          meta.authorName ? h('span', null, t('目录维护方：{0}', [meta.authorName])) : null,
          meta.lastUpdated ? h('span', null, t('目录更新于 {0}', [relativeLabel(meta.lastUpdated)])) : null,
          /^https?:\/\//i.test(String(meta.authorSource || ''))
            ? h('a', { href: meta.authorSource, target: '_blank', rel: 'noreferrer' }, t('查看来源'))
            : null,
          meta.license ? h('span', null, meta.license) : null,
        )
      : null,
    // 搜索态置灰不隐藏：位置稳定，用户知道「分类还在，只是这次搜索没按它筛」。
    h('div', { className: 'dsh-mcp-market-chips' + (searching ? ' muted' : ''), title: searching ? t('搜索时自动在全库匹配（忽略分类）') : undefined },
      categoryChips.map((row) => h('button', {
        key: row.id, type: 'button',
        className: 'dsh-mcp-chip' + (!searching && category === row.id ? ' sel' : ''),
        'aria-pressed': !searching && category === row.id,
        disabled: searching || loading,
        onClick: () => { setCategory(row.id); setPage(1); },
      }, row.name, h('span', { className: 'dsh-mcp-chip-count' }, row.count))),
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
                h('div', { className: 'dsh-mcp-card-person' },
                  h(Avatar, { url: item.avatarUrl, name: item.name, className: 'dsh-mcp-card-avatar' }),
                  h('div', null,
                    h('div', { className: 'dsh-mcp-card-name' }, t('{0}（{1}）', [item.name, item.profession])),
                    h('div', { className: 'dsh-mcp-card-vendor' }, item.categoryName || item.categoryId),
                  ),
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
                item.updatedAt ? h(Badge, { title: wbFormatDate(timestampOf(item.updatedAt)) }, t('更新于 {0}', [relativeLabel(item.updatedAt)])) : null,
              ),
              h('div', { className: 'dsh-mcp-wb-card-actions' },
                h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: openingPlugin === item.plugin, 'aria-busy': openingPlugin === item.plugin || undefined, onClick: () => openDetail(item) }, openingPlugin === item.plugin ? t('读取中…') : t('详情')),
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
      ? h(Pager, { page: safePage, pageCount, total: filtered.length, onPage: setPage })
      : null,
    // ── 专家详情弹层：召唤前看人设原文 + 捆绑技能 ──
    detail
      ? (() => {
        // 弹层里该给哪些按钮：与卡片按钮同源（expertCardActions），只是换到详情对象上算。
        // 注意：这个 IIFE 里**不允许再出现任何 hook**（personaExpanded / showAllPrompts 已上提到
        // 组件顶层）——它本身就在 `detail ?` 条件分支里，一旦在此调用 hook 就是 React #310。
        const detailActions = expertCardActions({
          summoned: presets.has(detail.plugin),
          expertType: detail.expertType,
          personaText: personaTextOf(presetRows, detail.plugin),
        });
        return h('div', { className: 'dsh-mcp-overlay', onClick: (e) => !busy && e.target === e.currentTarget && setDetail(null) },
          h('div', { ref: expertDetailRef, className: 'dsh-mcp-modal dsh-mcp-wb-modal', role: 'dialog', 'aria-modal': true, 'aria-label': t('专家详情'), tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); setDetail(null); } } },
            h('div', { className: 'dsh-mcp-detail-person' },
              h(Avatar, { url: detail.avatarUrl, name: detail.name, className: 'dsh-mcp-detail-avatar' }),
              h('div', null,
                h('h3', null, t('{0}（{1}）', [detail.name, detail.profession])),
                h('div', { className: 'dsh-mcp-card-vendor' }, detail.categoryName || detail.categoryId || ''),
              ),
            ),
            h(PresenceLine, {
              owner: meta.authorName,
              updatedAt: detail.updatedAt,
              note: detail.expertType === 'team' ? t('专家团') : t('专家人设'),
              className: 'dsh-mcp-presence-detail',
            }),
            // 真实出口前置：详情再长也不必先滑到底才能去仓库 / 提 Issue。
            h(FeedbackLinks, {
              item: detail, kind: 'expert',
              homepage: meta.authorSource,
              sourceLabel: meta.authorName ? t('目录维护方：{0}', [meta.authorName]) : '',
            }),
            h('div', null,
                  detail.detailError ? h('p', { className: 'dsh-mcp-wb-error' }, detail.detailError) : null,
                  detail.description ? h('p', { className: 'dsh-mcp-wb-modal-desc' }, detail.description) : null,
                  (meta.version || detail.createdAt || detail.updatedAt)
                    ? h('div', { className: 'dsh-mcp-card-tags' },
                        meta.version ? h(Badge, null, 'v' + meta.version) : null,
                        detail.createdAt ? h(Badge, null, t('加入时间 {0}', [wbFormatDate(timestampOf(detail.createdAt))])) : null,
                        detail.updatedAt ? h(Badge, null, t('人设更新于 {0}', [relativeLabel(detail.updatedAt)])) : null,
                      )
                    : null,
                  detail.quickPrompts && detail.quickPrompts.length
                      ? (() => {
                        // OPT-26 · 3.3：quickPrompts 超过 3 条时默认折叠，按钮切换展开/收起。
                        const promptsShown = showAllPrompts ? detail.quickPrompts : detail.quickPrompts.slice(0, 3);
                        return h('div', { className: 'dsh-mcp-wb-examples' },
                          h('b', null, t('试试这样问')),
                          h('ul', null, promptsShown.map((prompt, index) => h('li', { key: index }, prompt))),
                          detail.quickPrompts.length > 3
                            ? h('button', { type: 'button', className: 'dsh-mcp-btn dsh-mcp-link-btn', onClick: () => setShowAllPrompts(!showAllPrompts) },
                                showAllPrompts ? t('收起') : t('显示全部 {0} 条', [fmtInt(detail.quickPrompts.length)]))
                            : null,
                        );
                      })()
                      : null,
                  Array.isArray(detail.skills)
                    ? h('div', { className: 'dsh-mcp-card-tags' },
                        detail.skills.length
                          ? detail.skills.map((skill) => h(Badge, { key: skill.name, cls: skill.local ? 's-on' : '' }, t('{0}{1}', [skill.name, skill.local ? t('（本机可完整安装）') : t('（仅 SKILL.md）')])))
                          : h(Badge, null, t('无捆绑技能')),
                      )
                    : null,
                  detail.personaSource === 'generated'
                    ? h('p', { className: 'dsh-mcp-wb-modal-note' }, t('人设正文是按专家介绍生成的替身，不是原作者设定；原文不可用。'))
                    : null,
                  detail.persona
                    ? h('div', { className: 'dsh-mcp-skill-d-sec' },
                        h('b', null, t('人设正文（{0} 字符，召唤后成为会话系统提示）', [detail.personaChars || detail.persona.length])),
                        h('pre', { className: 'dsh-mcp-skill-d-md' }, personaExpanded || detail.persona.length <= PERSONA_PREVIEW_MAX ? detail.persona : detail.persona.slice(0, PERSONA_PREVIEW_MAX) + t('\n…（预览截断，召唤时写入完整正文）')),
                          personaExpanded
                            ? h('button', { type: 'button', className: 'dsh-mcp-btn dsh-mcp-link-btn', onClick: () => setPersonaExpanded(false) }, t('收起'))
                            : detail.persona.length > PERSONA_PREVIEW_MAX
                              ? h('button', { type: 'button', className: 'dsh-mcp-btn dsh-mcp-link-btn', onClick: () => setPersonaExpanded(true) }, t('展开全文（{0} 字符）', [fmtInt(detail.persona.length)]))
                              : null,
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
                    ? h('p', { className: 'dsh-mcp-wb-modal-note', style: { color: 'var(--dsw-alias-state-warn-primary)' } },
                        t('⚠ 这条预设是旧版本召唤写入的：人设缺「DSH 运行时适配」桥接段，用它的新会话主理人只会调不存在的 TeamCreate/Agent，成员子智能体开不出来。点下方「更新预设」重跑召唤即可刷新。'))
                    : null,
                ),
            h('div', { className: 'dsh-mcp-modal-actions' },
              h(Btn, { onClick: () => setDetail(null), disabled: busy, children: t('关闭') }),
              detailActions.update
                ? h(Btn, { primary: true, icon: 'refresh', disabled: busy, onClick: () => summon(detail), children: busy ? t('更新中…') : t('更新预设') })
                : null,
              detailActions.dismiss
                ? h(Btn, { danger: true, icon: 'trash', disabled: busy, onClick: () => dismiss(detail), children: t('送还') })
                : null,
              detailActions.summon
                ? h(Btn, { primary: true, icon: 'plus', disabled: busy, onClick: () => summon(detail), children: busy ? t('召唤中…') : detail.expertType === 'team' ? t('召唤专家团') : t('召唤') })
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
  { key: 'skill', get label() { return t('技能'); }, icon: 'skill', get hint() { return t('技能按需触发：选择后以 /技能名 插入输入框'); } },
  { key: 'mcp', label: 'MCP', icon: 'plug', get hint() { return t('MCP 工具按 server 生效：选择后点名 mcp__服务__* 工具'); } },
  { key: 'expert', get label() { return t('专家'); }, icon: 'expert', get hint() { return t('专家随时挂/换/摘：点一个即接管本会话，再点别的直接换，点 chip 的 × 取消'); } },
];
// 子菜单列表每屏固定 6 行（6 × 28px），更多条目在 .dsh-mcp-quick-list 里纵向滚动；
// 「最近」徽章只标最近池里的前 6 名（首屏可见的那批），避免整列都是徽章。
// 专家预设显示名前缀：召唤时写死的 `WorkBuddy 专家 · <显示名>`（见 expert-market.js
// buildExpertPresetRow），宿主的会话头预设标签原样显示它——用来识别「那条会过期的标签」。
// 这是**匹配用**前缀，不是展示文案：宿主 expert-market.js 写入预设定名时永远用
// 中文 `WorkBuddy 专家 · `（见 buildExpertPresetRow），这里必须逐字相同。
// 不能包 t()——英文环境下翻译成 "WorkBuddy Expert · " 会永远匹配不上宿主标签。
const EXPERT_PRESET_LABEL_PREFIX = 'WorkBuddy 专家 · ';
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
// 二级菜单横向展开方向：输入框动作区贴右侧，主菜单常被视口夹到右缘；若第二级仍向右开，
// 232px 会整块伸出屏幕。以锚点行为基准判断（不用子菜单当前所在侧，避免翻转后来回抖动）：
// 右侧放不下且左侧更宽裕时向左开；两侧都放不下时也选更宽的一侧，把溢出减到最小。
// width 传子菜单实测外宽（含 padding/border）；未挂载时按 232 + 12 估算。
const quickSubmenuOpensLeft = (row, width = 244) => {
  if (!row) return false;
  const rect = row.getBoundingClientRect();
  const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
  const gap = 4 + 8; // 与主菜单的 4px 间距 + 视口 8px 留白
  const roomRight = viewportW - rect.right - gap;
  const roomLeft = rect.left - gap;
  const outerWidth = Math.min(width, Math.max(0, viewportW - 16));
  return roomRight < outerWidth && roomLeft >= roomRight;
};
const SummonQuickMenu = ({ call, inputActions, sessionId: sessionIdProp }) => {
  useI18nRevision(); // 宿主切语言后重渲染，模块级 getter 文案即时更新
  const [open, setOpen] = useState(false);
  const [hoverKind, setHoverKind] = useState(null);
  const [recent, setRecent] = useState(null); // { skill: [], mcp: [], expert: [] }
  const [listError, setListError] = useState('');
  const [copied, setCopied] = useState('');
  // 子菜单翻转：展开后实测几何，纵向越界加 flip（向上展开），横向越界加 hflip（向左展开）。
  // 只在展开/hoverKind 变化时测一次（临时浮层，不监听滚动缩放）。
  const [flipKinds, setFlipKinds] = useState(() => new Set());
  const [hflipKinds, setHflipKinds] = useState(() => new Set());
  const rowRefs = useRef(new Map());
  const rootRef = useRef(null);
  const closeTimer = useRef(null);
  const cancelClose = () => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } };
  // 展开子菜单前先定横向方向：等挂载后再测会先按默认方向画一帧，而菜单贴右缘时
  // 那一帧整块在屏幕外。实测宽度的精修仍由下面的 effect 负责。
  const markSubmenuSide = (kindKey, row) => {
    const opensLeft = quickSubmenuOpensLeft(row);
    setHflipKinds((prev) => {
      if (prev.has(kindKey) === opensLeft) return prev;
      const next = new Set(prev);
      if (opensLeft) next.add(kindKey); else next.delete(kindKey);
      return next;
    });
  };
  // scheduleClose 在 JSX 前定义（rootHoverProps 用它）；此处不重复声明。

  // 菜单打开时拉一次各类清单。清单取全量（不做 6 条截断），交给子菜单自己
  // 「最近使用置顶 + 每屏 6 行滚动」展示；三类并行取，任何一类失败不影响其它类。
  // MCP 行字段是 serverName（gateway list() 的行形状，与面板列表同一来源）；禁用的不进菜单。
  const loadRecent = useCallback(async () => {
    setListError('');
    const [recentRes, skillsRes, mcpRes, expertRes, suitesRes] = await Promise.all([
      call('wbExpertRecent'),
      call('listSkills', skillScopeArg('global')),
      call('list'),
      call('wbExpertInstalled'),
      // 套件读本插件自己的数据层（不是宿主接口），失败不该连累整个菜单——Promise.all 是
      // 「一败全败」，所以单独兜住：宿主还没重启（接口 404）时菜单照常出技能/MCP/专家。
      call('listSkillSuites').catch(() => ({ ok: false })),
    ]);
    const kinds = recentRes?.ok && recentRes.kinds ? recentRes.kinds : {};
    const skillRows = skillsRes?.ok && Array.isArray(skillsRes.skills) ? skillsRes.skills : [];
    const mcpRows = mcpRes?.ok && Array.isArray(mcpRes.servers) ? mcpRes.servers.filter((server) => !server.disabled && server.serverName) : [];
    const expertRows = expertRes?.ok && Array.isArray(expertRes.presets) ? expertRes.presets : [];
    const suiteRows = suitesRes?.ok && Array.isArray(suitesRes.suites) ? suitesRes.suites : [];
    setRecent({
      skill: skillRows.map((row) => ({ name: row.name, description: row.description || row.whenToUse || '' })),
      mcp: mcpRows.map((row) => ({ name: row.serverName, description: row.url || row.command || row.transport || '' })),
      // 专家显示名由宿主从目录缓存补上（nameZh/nameEn），两套都留在行里：
      // 菜单开着时宿主切语言，itemLabel 直接按当前 locale 重选，不必重新拉取。
      expert: expertRows.map((row) => ({
        plugin: row.plugin,
        name: row.nameZh || row.nameEn || row.plugin,
        nameEn: row.nameEn || row.nameZh || row.plugin,
        presetId: row.presetId,
      })),
      // 数据层读侧已经滤掉「无名/无成员」的残缺条目，这里再兜一次手改文件的形状：
      // 空套件展开后什么都插不进草稿，留在菜单里只是个点了没反应的死条目。
      suite: suiteRows
        .filter((row) => row && row.name && Array.isArray(row.members) && row.members.length)
        .map((row) => ({
          id: String(row.id || ''),
          name: String(row.name),
          desc: String(row.desc || ''),
          members: row.members.map((name) => String(name)),
        })),
      recentSkill: Array.isArray(kinds.skill) ? kinds.skill : [],
      recentMcp: Array.isArray(kinds.mcp) ? kinds.mcp : [],
      recentExpert: Array.isArray(kinds.expert) ? kinds.expert : [],
    });
  }, [call]);
  // 关闭时保留上次清单：再次打开先用缓存内容按最终高度出菜单，后台再刷新，
  // 避免每次点击都先闪一版 loading 骨架再收缩。首次打开仍会短暂显示骨架，
  // 但位置已在布局阶段定好，不会出现「高菜单栏闪一下」。
  useEffect(() => {
    if (!open) return;
    loadRecent().catch((e) => setListError(String(e?.message || e)));
  }, [open, loadRecent]);

  // ── 主菜单 fixed 定位（页面不动的根修）────────────────────────────────
  // 菜单原来 position:absolute 锚在图标上：attachNote/新建按钮让菜单变高时，
  // 向上伸展改变祖先滚动容器的可滚动区，会话页滚动位置跟着跳一下。改为
  // position:fixed（脱离滚动容器）+ 打开时实测 trigger 的视口坐标定位：
  // 菜单再高也只是视口内的浮层，页面滚动零位移。翻转/关闭判定不受影响。
  const menuRef = useRef(null);
  const [menuPos, setMenuPos] = useState(null);
  // 必须用 useLayoutEffect：菜单首帧还没有定位（style 为空）时，position:fixed 会按
  // 静态位置落在输入框行里，一帧后再跳到实测位置——用户看到的就是「很高的菜单栏闪现」。
  // 布局阶段测量 + 定位，浏览器一次绘制就已经在正确位置；未定位前菜单保持 visibility:hidden。
  useLayoutEffect(() => {
    if (!open) { setMenuPos(null); return; }
    const measure = () => {
      const trigger = rootRef.current?.querySelector('.dsh-mcp-quick-trigger');
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = menuRef.current?.offsetWidth || 128;
      // 一级菜单水平居中于引用图标：left = 图标中心 − 菜单半宽。
      // 贴到视口右缘时夹回视口内，左侧不足 4px 时向右兜底。
      const centered = rect.left + rect.width / 2 - width / 2;
      const left = Math.max(4, Math.min(centered, window.innerWidth - width - 4));
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
    if (!open) {
      // 关闭后清空翻转态：下次在别处打开时先按默认方向渲染，再由实测修正，
      // 避免沿用上一次位置的 flip/hflip 闪一下。
      setFlipKinds((prev) => (prev.size ? new Set() : prev));
      setHflipKinds((prev) => (prev.size ? new Set() : prev));
      return;
    }
    if (!hoverKind) return;
    let alive = true;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (!alive) return;
      const row = rowRefs.current.get(hoverKind);
      const sub = row ? row.querySelector('.dsh-mcp-quick-sub') : null;
      if (!row || !sub) return;
      const rect = sub.getBoundingClientRect();
      const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
      const overflowBottom = rect.bottom - viewportH;
      setFlipKinds((prev) => {
        const shouldFlip = overflowBottom > 8;
        if (prev.has(hoverKind) === shouldFlip) return prev;
        const next = new Set(prev);
        if (shouldFlip) next.add(hoverKind); else next.delete(hoverKind);
        return next;
      });
      // 横向用子菜单实测外宽精修一次（CSS max-width 在窄窗下会收窄它）；
      // 方向判据与悬停前那次一致，不会因当前所在侧而抖动。
      const shouldHflip = quickSubmenuOpensLeft(row, sub.offsetWidth || 232);
      setHflipKinds((prev) => {
        if (prev.has(hoverKind) === shouldHflip) return prev;
        const next = new Set(prev);
        if (shouldHflip) next.add(hoverKind); else next.delete(hoverKind);
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

  // 插入动作（技能 / MCP / 套件共用）：把引用插进输入框光标处。
  // 写通道（按优先级）：
  //   ① inputActions.insertText(text, captureInsertion()) —— composer 的 standard provide channel
  //     （InputBar 同款 useInput/inputActions），在光标处插入并保留现有草稿，最贴近 WorkBuddy；
  //   ② inputActions.setDraft(现草稿 + 引用) —— insertText 不可用时的整草稿兜底；
  //   ③ 复制进剪贴板 + 按钮上闪现「已复制」（绝不跳走：跳页是上一版的行为缺陷）。
  // 套件展开出来是一整串 `/a /b /c`，走的正是同一条通道——所以「引用套件」不需要
  // 宿主认识套件这个概念，宿主看到的仍然只是普通草稿文本。
  const insertRef = async (text) => {
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
  const pick = async (kind, item, text) => {
    setOpen(false); setHoverKind(null);
    // 上报最近使用（失败静默：纯增值数据）。expert 不经 pick（点击分支直接 attachExpert）。
    const row = kind === 'mcp' ? { serverName: item.name } : { name: item.name };
    call('wbExpertRecordUse', { kind, row }).catch(() => {});
    await insertRef(text);
  };
  // 引用一个套件 = 把成员逐个展开成引用文本拼成一段插入草稿（纯插件侧展开，宿主零改动）。
  // 文本用 quickMentionText('skill', …) 逐成员生成，与单个技能的引用格式完全同源：
  // 合法标识符走 `/name`，中文名等走 `名字：`——两处各写一套正则必然漂移。
  // 最近使用按**成员**上报而不是按套件：技能最近池里只该出现真实的 skill 名，
  // 记套件名会污染池子（子菜单的「最近」徽章拿套件名去匹技能，永远匹配不上）。
  const pickSuite = async (suite) => {
    setOpen(false); setHoverKind(null);
    const members = (Array.isArray(suite?.members) ? suite.members : []).map((name) => String(name).trim()).filter(Boolean);
    if (!members.length) return;
    for (const name of members) call('wbExpertRecordUse', { kind: 'skill', row: { name } }).catch(() => {});
    await insertRef(members.map((name) => quickMentionText('skill', { name }).trim()).join(' ') + ' ');
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
  // 专家名跟随宿主语言：两套名都已随行送到（见 loadRecent），这里只做投影；
  // 由 useI18nRevision 驱动重渲染，切换语言当帧生效。缺译文时回落另一语言，最后才是 plugin。
  const itemLabel = (kind, item) => {
    if (kind !== 'expert') return item.name;
    return usesEnglish()
      ? (item.nameEn || item.name || item.plugin)
      : (item.name || item.nameEn || item.plugin);
  };
  const itemDesc = (kind, item) => (kind === 'mcp' ? (item.transport ? item.transport : '') : (item.description || '').slice(0, 48));

  // ── 挂专家（WorkBuddy 式：随时挂 / 换 / 摘）──────────────────────────────
  // 主通道是宿主新的会话级人设 RPC expertAttach/expertDetach：它把专家人设作为
  // systemPrompt 的「本会话作用域 section」注入（与 dsh-persona / dsh-subagent 同款
  // deployment:persona-prefix 遮蔽机制），因此：
  //   - 不受 agent-preset/locked 限制 —— 会话已开过口也能挂、能换、能摘；
  //   - 只影响这一个会话，不动工具目录、不动 profile 预设；
  //   - 反复点不同专家 = 直接替换（Host 先摘旧的再装新的），不再是一次性。
  // 选择由 Host 落盘（session-persona.json），切会话/重启/压缩导致 agent 重建时会自动
  // 补回人设；chip 从 expertActive 同步的是「用户选择」而不是「当前是否恰好生效」，
  // 所以恢复过程中也不会闪没。
  // 挂载只走人设通道（预设通道 agentPresets.select 会在会话投影里留下永不更新的
  // 专家名，造成「顶栏显示 A、实际生效 B」的分叉——见 SessionExpertBadge 注释）。
  // sessionId 来源：conversation.input.right 是 session 座位，slot 渲染时把 sessionId
  // 作为 prop 显式传入（apply() 注册处 inject: (sessionId) => ({ call, sessionId })）；
  // 会话 summary 行本身不带 id 字段（id 只走 props），所以不能从 useSession 投影里取。
  const [attached, setAttached] = useState(null); // { plugin, name, mode: 'persona' }
  const [attachBusy, setAttachBusy] = useState(false);
  const [attachNote, setAttachNote] = useState('');
  // 团队型专家的长说明（60+ 字）：只挂到 trigger 的 title，不进菜单气泡（否则撑高菜单）。
  const [teamHint, setTeamHint] = useState('');
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
        // 团队型说明只在 trigger 的 title（悬停）里出现，不进菜单气泡：
        // 这句 60+ 字，菜单 min-width 只有 128px，塞进气泡会折成多行把菜单撑高。
        // 成功态本来就有两处可见反馈——专家 chip（名字 + ×）与菜单项的「已挂」徽章。
        // adopted：人设生效但拿不到撤销句柄，必须如实告诉用户取消要重启。
        setAttachNote(res.needsRestart
          ? t('人设已生效，但该会话残留旧注册，取消需重启 DSH 后生效。')
          : (res.personaSource === 'generated' ? t('人设正文是按专家介绍生成的替身，不是原作者设定；原文不可用。') : ''));
        setTeamHint(res.expertType === 'team'
          ? t('成员由主理人用 subagent 调度；若本会话没有 subagent 工具，请新建会话并选择「WorkBuddy 专家 · {0}」预设', [res.name || item.name || item.plugin])
          : '');
        call('wbExpertRecordUse', { kind: 'expert', row: { plugin: item.plugin, name: item.name || item.plugin } }).catch(() => {});
        // 立即广播：会话头徽章 + 陈旧预设标签的隐藏同步生效，三处显示同帧对齐。
        emitExpertChange();
      } else {
        // 失败必须可见，但同样压成一行：只留错误首行，截到 80 字。
        setAttachNote(t('挂载失败：') + String((res && res.error) || t('未知错误')).split('\n')[0].slice(0, 80));
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
      setTeamHint('');
      setAttachNote(res?.needsRestart
        ? t('人设已生效，但该会话残留旧注册，取消需重启 DSH 后生效。')
        : (res && res.ok && res.removed ? t('✓ 已取消本会话的专家') : t('本会话没有挂着专家')));
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
    // 成功提示不进菜单（chip + 菜单项「已挂」徽章已表达）；失败才出一行气泡。
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
      title: (attachNote ? attachNote + t('　') : '') + (attached ? t('已挂专家：') + attached.name + t('（本会话全局生效）') + (teamHint ? t('　') + teamHint : '') + t('　') : '') + t('技能 / MCP / 专家 快速调用'),
      'aria-label': t('打开技能、MCP、专家快速调用菜单'),
      'aria-expanded': open,
      onClick: (e) => { e.stopPropagation(); setOpen((value) => !value); setHoverKind(null); },
    }, h(Icon, { d: ICONS.board, size: 15 })),
    open
      ? h('div', { className: 'dsh-mcp-quick-menu', role: 'menu', 'aria-label': t('快速调用'), ref: menuRef, style: menuPos || { position: 'fixed', visibility: 'hidden' } },
          // 只报「已复制」，不复述内容：MCP 那条 mention 有 60+ 字，拼进来会折行撑高菜单
          // （OPT-32）。内容已在剪贴板，用户直接粘贴即可；完整文本留作 title 悬停可查。
          copied ? h('div', { className: 'dsh-mcp-quick-note', title: copied }, t('已复制，粘贴到输入框')) : null,
          attachBusy ? h('div', { className: 'dsh-mcp-quick-note' }, t('正在挂载专家…')) : null,
          // 只在失败时出气泡（一行短句）。成功态靠专家 chip + 菜单项「已挂」徽章表达，
          // 不再渲染 ✓ 提示行——那是把菜单撑高的直接原因（见 attachExpert 里的注释）。
          attachNote ? h('div', { className: 'dsh-mcp-quick-note err', role: 'alert', title: attachNote }, attachNote) : null,
          listError ? h('div', { className: 'dsh-mcp-quick-err' }, listError) : null,
          !recent && !listError ? h('div', { className: 'dsh-mcp-quick-loading' }, h(Skeleton, { rows: 3 })) : null,
          QUICK_MENU_KINDS.map((kind) => {
            const items = subItems(kind.key);
            const expanded = hoverKind === kind.key;
            // 套件只在「技能」子菜单里出现，且作为独立分组置顶（决策：与单个技能同级但分组，
            // 让用户一眼看出「这一条点下去是同时引用好几个 skill」）。
            const suites = kind.key === 'skill' && recent && Array.isArray(recent.suite) ? recent.suite : [];
            const skillRows = Array.isArray(items) ? items : [];
            // 子菜单的空态判据要把套件算进来：只有套件、一个技能都没有时也是「有内容」，
            // 否则 .empty 会把分组头和条目一起按空态样式压掉。
            const hasAny = skillRows.length > 0 || suites.length > 0;
            return h('div', {
              key: kind.key,
              className: 'dsh-mcp-quick-row' + (expanded && flipKinds.has(kind.key) ? ' flip' : '') + (expanded && hflipKinds.has(kind.key) ? ' hflip' : ''),
              ref: (el) => { if (el && expanded) rowRefs.current.set(kind.key, el); else rowRefs.current.delete(kind.key); },
              // 悬停开合由根节点统一管理（见 rootHoverProps）：行内只负责展开子菜单。
              onMouseEnter: (e) => { cancelClose(); markSubmenuSide(kind.key, e.currentTarget); setHoverKind(kind.key); },
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
                onClick: (e) => {
                  e.stopPropagation(); cancelClose();
                  const willOpen = hoverKind !== kind.key;
                  // 点按 / 键盘路径也要先定方向：贴右缘时先向右画一帧会整块跑到屏幕外。
                  if (willOpen) markSubmenuSide(kind.key, e.currentTarget.closest('.dsh-mcp-quick-row'));
                  setHoverKind(willOpen ? kind.key : null);
                },
                title: kind.hint,
              },
                h(Icon, { d: ICONS[kind.icon], size: 13 }),
                h('span', null, kind.label),
                // 计数只报技能本身（与主菜单「这一类有多少条」的语义一致），不把套件数混进去。
                skillRows.length ? h('span', { className: 'dsh-mcp-quick-count' }, skillRows.length) : null,
                h('span', { className: 'dsh-mcp-quick-arrow', 'aria-hidden': true }, '›'),
              ),
              hoverKind === kind.key
                ? h('div', { className: 'dsh-mcp-quick-sub' + (hasAny ? '' : ' empty'), role: 'menu', 'aria-label': kind.label + t('可选项') },
                    hasAny
                      ? h('div', { className: 'dsh-mcp-quick-list', role: 'group', 'aria-label': kind.label + t('列表（最多显示 6 行，滚动查看更多）') },
                          // ── 套件分组（仅技能子菜单）─────────────────────────────
                          suites.length ? h('div', { className: 'dsh-mcp-quick-group', 'aria-hidden': true },
                            h(Icon, { d: ICONS.layers, size: 11 }),
                            t('套件'),
                          ) : null,
                          suites.map((suite, index) => h('button', {
                            key: suite.id || suite.name || index,
                            type: 'button',
                            role: 'menuitem',
                            className: 'dsh-mcp-quick-item suite',
                            title: t('引用套件：展开为 {0} 个 /name', [suite.members.length]),
                            onClick: (e) => { e.stopPropagation(); pickSuite(suite); },
                          },
                            h('span', { className: 'ic', 'aria-hidden': true }, h(Icon, { d: ICONS.layers, size: 12 })),
                            h('span', { className: 'dsh-mcp-quick-item-name' }, suite.name),
                            h('span', { className: 'dsh-mcp-quick-item-badge' }, t('{0} 技能', [suite.members.length])),
                            suite.desc ? h('span', { className: 'dsh-mcp-quick-item-desc', title: suite.desc }, suite.desc) : null,
                          )),
                          // 分隔线只在两段都有内容时画：只有一段时它是条多余的尾巴。
                          suites.length && skillRows.length ? h('div', { className: 'dsh-mcp-quick-sep', role: 'separator' }) : null,
                          skillRows.map((item, index) => h('button', {
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
                            itemDesc(kind.key, item) ? h('span', { className: 'dsh-mcp-quick-item-desc', title: itemDesc(kind.key, item) }, itemDesc(kind.key, item)) : null,
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
                      h('span', { className: 'dsh-mcp-quick-item-name' }, t('管理{0}…', [kind.label])),
                    ),
                    // 套件管理入口只在技能子菜单里给（套件就是技能的组合，放在别处会找不到语境）。
                    // 走 openSuiteManager()：它广播 + 切到 skill 看板，弹窗由 SkillBoard 那边挂出来——
                    // 菜单自己是输入框旁的临时浮层，不适合承载一个模态对话框。
                    kind.key === 'skill'
                      ? h('button', {
                          type: 'button',
                          role: 'menuitem',
                          className: 'dsh-mcp-quick-manage',
                          title: t('新建或修改套件（把多个相关 skill 打包，引用一次全部生效）'),
                          onClick: (e) => { e.stopPropagation(); setOpen(false); setHoverKind(null); openSuiteManager(); },
                        },
                          h('span', { className: 'ic', 'aria-hidden': true }, h(Icon, { d: ICONS.layers, size: 11 })),
                          h('span', { className: 'dsh-mcp-quick-item-name' }, t('管理套件…')),
                        )
                      : null,
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
  useI18nRevision(); // 宿主切语言后重渲染，模块级 getter 文案即时更新
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
    // P0-3：首拉推迟到空闲帧。会话头挂载时宿主正在铺消息列表，这一发 RPC + 回包后的
    // setState 会跟首屏抢主线程；徽章本来就要等真源回来才有内容，晚一个空闲帧无感。
    // 专家变更总线（onExpertChange）仍然立即同步——那是用户动作，等不得。
    const cancelIdleSync = scheduleIdle(() => { if (!cancelled) sync(); });
    const off = onExpertChange(sync);
    // OPT-05：同上，徽章这一处也改走可见性感知轮询。P0-3：5s → 15s——挂/换/摘都由总线
    // 立即触发，轮询只兜底「别的进程改了人设」这类外部变化，15s 足够且省下 2/3 的调用。
    const stopPoll = startVisibilityAwarePolling(typeof document === 'undefined' ? null : document, null, 15000, sync);
    return () => { cancelled = true; cancelIdleSync(); off(); stopPoll(); };
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
// OAuth 记录里的 expiresAt 是 ISO 串（旧版本可能写成数字毫秒）：两种都认，认不出就原样透出，
// 不编一个「永久有效」——用户要的是「什么时候会失效」这个事实。
const authExpiryText = (value) => {
  if (value === undefined || value === null || value === '') return '';
  const raw = typeof value === 'number' ? value : Date.parse(String(value));
  if (!Number.isFinite(raw)) return String(value);
  try {
    const date = new Date(raw);
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  } catch {
    return String(value);
  }
};

// ── 社区「人味」信号：真实的人、真实的维护节奏、真实的反馈出口 ────────────────
// 市场目录里的条目不该只是「一个可安装的对象」：谁做的、最后一次动是什么时候、
// 项目还活着吗、遇到问题该找谁。这些信号全部来自上游既有字段或 GitHub 公开 API，
// 不生成任何虚构的作者 / 评价 / 在线人数。
const ARMORY_REPO_URL = 'https://github.com/2026heshao/dsh-armory';
const parseGithubRepoKey = (value) => {
  const text = String(value || '').trim();
  if (!text) return '';
  const ssh = /^git@github\.com:([^/\s]+)\/([^/\s#]+?)(?:\.git)?$/i.exec(text);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  const http = /^(?:git\+)?https?:\/\/(?:www\.)?github\.com\/([^/\s#?]+)\/([^/\s#?]+)/i.exec(text);
  if (http) return `${http[1]}/${http[2].replace(/\.git$/i, '')}`;
  const bare = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(text);
  if (bare) return `${bare[1]}/${bare[2].replace(/\.git$/i, '')}`;
  return '';
};
// ── 头像取图通道：GitHub 系一律走镜像代理 ───────────────────────────────────
// 三条候选通道都在本机实测过（2026-10-24，真实 owner 名单取自 awesome 目录 4203 个）：
//   · 直连 `avatars.githubusercontent.com/<login>`：单发 0.35s 很快，但 6 并发就有
//     一半挂到 12 秒；更不能接受的是它对不存在的账号回 **200 + 一张占位图**，而且
//     大小写敏感（`perrylink` 失败、`PERRYLINK` 成功）。目录里的 owner 写法五花八门，
//     这条会把「头像取不到」变成「显示成别人的脸」，比字母更糟。
//   · `api.github.com/users/<login>` 换 canonical `/u/<id>`：0.67s 能成，但未认证配额
//     只有 60 次/小时（实测 X-RateLimit-Remaining 剩 38），而首页 50 张卡就有 41 个
//     不同 owner —— 看完一页配额见底，后面几页全退回字母。
//   · 镜像代理 `wsrv.nl` 去取 `https://github.com/<login>.png`（重定向由代理在服务端跟，
//     本机的挂起路由根本不参与）：12 并发全部 200，0.56–2.83s、中位约 1.1s，
//     单张 webp 0.3–2.7KB，响应头 `Cache-Control: public, max-age=31536000`
//     （浏览器自己缓存一年），账号不存在干净回 404 → 落回字母，且**一次都不花配额**。
// README 插图早就走同一条代理（`README_IMG_PROXY` / `readmeProxiedSrc`），头像沿用
// 同一个取舍。代价说清楚：代理是第三方服务，它会知道面板这一屏渲染了哪些 GitHub
// 用户名——面板已经把这批名字发给同一个代理处理 README 图，所以不是新增的暴露面。
// 也**不做**「代理失败再回退直连 github.com」：直连那条源要 10 秒级（见下面 avatarRecord
// 的实测注释），为一张头像把请求发回那条挂起的路上不值得。
//
// 但「首选代理挂了怎么办」要有答案。这里照 dshmarket 的 `githubRouteCandidates` /
// `OwnerAvatar` 做成**有序路由**：第一条 onError/超时就直接换下一条，全部用完才落字母。
//   · 首选 `wsrv.nl`，备胎 `images.weserv.nl` —— 实测两者是**同一个后端的不同域名**
//     （同一份图、同样 200、同样一年强缓存），差别只在浏览器把它们当两个 host、
//     各有约 6 条 HTTP/1.1 连接。所以备胎不只是「挂了再试」，也躲得开主域名被挤爆
//     的那段时间（本机测过：12 并发走 wsrv 全部 200，但 images.weserv 单张更慢，
//     所以它只配当第二条，不配当首选）。
//   · 另两条常见加速域名对头像地址是坏的：`gh-proxy.com` 回 404、`ghfast.top` 回 403
//     （都实测过），别再往表里加。
const AVATAR_PROXY_BASES = ['https://wsrv.nl/?output=webp&q=80', 'https://images.weserv.nl/?output=webp&q=80'];
const AVATAR_PROXY_HOSTS = ['github.com', 'avatars.githubusercontent.com', 'camo.githubusercontent.com'];

/** 该不该交给代理取：只有 GitHub 系域名需要（本机跟不动它的重定向），别的域名原样。 */
const avatarProxyHost = (text) => {
  try {
    return AVATAR_PROXY_HOSTS.indexOf(new URL(text).hostname.toLowerCase()) >= 0;
  } catch {
    return false;
  }
};

/**
 * 头像地址 → **有序候选路由**（数组长度就是允许的尝试次数）。
 * · 已经是本代理族某条路由的地址：保留它自带的 `w`/`h`，只把域名依次换成族里每一条。
 *   这样「卡片算出来的地址」和「这里再算一遍」永远是同一个字符串（合并的前提），
 *   也不会套出第二层代理 —— 套两层就把图取坏了。
 * · GitHub 系源地址：按 `size`（CSS 像素，夹在 32~192，按 2 倍图取）拼出每一条路由。
 * · 其他域名 / 脏串：原样一条，交给浏览器自己取，取不到就是字母。
 * · 空输入返回**空数组**，调用方靠它判「这一位压根没图」。
 */
const avatarRouteCandidates = (src, size = 64) => {
  const text = String(src || '').trim();
  if (!text) return [];
  const wrapped = AVATAR_PROXY_BASES.findIndex((base) => text.startsWith(base));
  if (wrapped >= 0) {
    const tail = text.slice(AVATAR_PROXY_BASES[wrapped].length);
    return AVATAR_PROXY_BASES.map((base) => `${base}${tail}`);
  }
  if (!avatarProxyHost(text)) return [text];
  const side = Math.max(32, Math.min(192, Math.round(Number(size) || 64)));
  return AVATAR_PROXY_BASES.map((base) => `${base}&w=${side}&h=${side}&url=${encodeURIComponent(text)}`);
};
/** 首选路由 = 登记表里的键 = 界面上最常见的那个 src；再过一道也不变（幂等）。 */
const avatarProxyUrl = (src, size = 64) => avatarRouteCandidates(src, size)[0] || '';
const githubAvatarUrl = (repo, size = 64) => {
  const key = parseGithubRepoKey(repo);
  return key ? avatarProxyUrl(`https://github.com/${key.split('/')[0]}.png`, size) : '';
};
// ── 头像：首帧字母，图片探到了再换 ───────────────────────────────────────────
//
// 为什么不能再把 src 直接交给 <img>（实测，2026-10-24）：
//   · 全部卡片头像的**源**都是 `https://github.com/<login>.png`（awesome 的 slim.json 里
//     根本没有 icon/avatar 字段，插件目录也一样）；现在这个源只作为代理的 `url=` 参数出现，
//     面板自己不再直连 github.com（通道选型见上面 avatarProxyUrl）；
//   · 首页 50 张卡 = 100 个 <img>（卡片一个、它下面那行 PresenceLine 又一个），
//     而这 50 条只有 41 个不同 owner —— 一半请求是重复的；
//   · 直连那条源时，github.com 的 302 回得很快（0.76s），慢在重定向落点：实测跟完整重定向链
//     要 14.7 秒才拿到字节，单发 10.7 秒抛 "fetch failed"。浏览器在**报错之前**一直算
//     「加载中」，Chromium 对单个 host 又只有约 6 条 HTTP/1.1 连接，100 个请求排队，于是
//     整页都在等 10 秒级的挂起；这段时间 CSS 给 <img> 画的 background + border 就是用户
//     看到的空灰圈，`onError` 里的 visibility:hidden 根本没机会触发。
// 所以这里把「发请求」和「显示」拆开：
//   1. 首帧永远渲染字母占位（.fallback），不留空圈 —— 慢的时候也得有内容；
//   2. 后台用 new Image() 探一次，AVATAR_TIMEOUT_MS 内成功才换成 <img>
//      （此时字节已在浏览器缓存里，绘制是即时的）；首选代理不成换下一条路由，
//      全部用完才判死（见上面的 AVATAR_PROXY_BASES）；
//   3. 超时或报错就**粘住**记进模块级登记表：同一个 URL 本次会话不再发第二次，
//      再进市场这些头像一次请求都不发（粘住的是请求，不是显示——迟到的成功仍然采纳，
//      因为「慢」不等于「坏」，而且不额外花一次网络）；
//   4. 卡片行与 PresenceLine 传的是同一个 URL 字符串，共用同一条登记 →
//      一次挂载发两遍同样的请求，自动合并成一遍；
//   5. 探测只在「这个头像离视口 200px 以内」时才发起（useNearViewport，抄 dshmarket
//      的卡片图口径）—— 视口外的那几十个 owner 根本进不了登记表。
// 代价说清楚：每个 owner 至多 AVATAR_PROXY_BASES.length 次请求（一条代理 + 一条备胎），
// 全挂之后归零，本次会话不再探；面板列表滚动时视口外的卡片根本进不了登记（见下面
// useNearViewport），所以总量还能从 41 再往下压。
//
// 还要再加一层**并发闸门**（同样是本机实测，不是猜的）：wsrv.nl 在这台机上只给
// HTTP/1.1（curl 实测 ver=1.1），Chromium 每域约 6 条连接，而代理单张串行
// 0.58–2.46s、中位 1.7s；一屏就有 41~57 个不同 owner，浏览器里 57 并发实测
// 「1.5 秒内只上屏 3 张、中位 4825ms、9 秒后仍有 30 张在途」—— 全并发打出去等于谁都要
// 等 9 秒。更要紧的是：浏览器的 socket 队列排在**上网之前**，而 `new Image()` 的超时
// 是从调用起算的，全并发时第 30 张其实还没发出就被我们的 4 秒判了死，而且是**粘住**的死
// （本次会话不再重试）—— 把「慢」误杀成「坏」。所以：
//   · 同时在途的头像请求不超过 AVATAR_INFLIGHT_MAX 条，其余排队（FIFO，入队顺序 =
//     挂载顺序 = 文档顺序，也就是从上往下：用户先看到的那几张先拿到带宽）；
//   · 超时从**真正发出请求**那一刻起算，不是从挂载起算 —— 排在队里等名额不算它慢；
//   · 只取 3 条而不是把 6 条连接占满：README 插图走的是**同一个 wsrv.nl 域名**，
//     打开 README 弹层时不能把它的额度挤死。
const AVATAR_TIMEOUT_MS = 4000;
const AVATAR_REGISTRY_MAX = 300;
const AVATAR_INFLIGHT_MAX = 3;
/** 首选路由地址 → { status, waiters, timer, dispatched, released, routes, route, resolved } */
const avatarRegistry = new Map();
/** 已登记、还没轮到发出的 URL（按挂载顺序） */
const avatarQueue = [];
let avatarInflight = 0;
let avatarDraining = false;

const avatarSettle = (rec, next) => {
  if (rec.status === 'ok') return;
  if (rec.status === 'fail' && next !== 'ok') return;
  rec.status = next;
  for (const notify of rec.waiters) notify();
};

const avatarClearTimer = (rec) => {
  if (rec.timer) {
    clearTimeout(rec.timer);
    rec.timer = 0;
  }
};

const avatarSucceeded = (rec, url) => {
  avatarClearTimer(rec);
  // resolved 记住**成功那条路由的地址**：备胎出图时界面上要画备胎那条，不能画回主那条。
  rec.resolved = url;
  avatarFinish(rec, 'ok');
};

/**
 * 一条路由失败（onerror 或超时）：还有备胎就换下一条，**继续占着同一个在途名额**
 * —— 名额代表「这个 owner 还没结算」，不是一次 HTTP；备胎用尽才判死并释放名额。
 * 换路由后重新起表：主域名挂满 4 秒不该把备域名那 4 秒也吃掉。
 */
const avatarAttemptFailed = (rec) => {
  avatarClearTimer(rec);
  if (rec.route + 1 < rec.routes.length) {
    rec.route += 1;
    avatarDispatch(rec);
    return;
  }
  avatarFinish(rec, 'fail');
};

const avatarDispatch = (rec) => {
  if (!rec.dispatched) {
    rec.dispatched = true;
    avatarInflight += 1;
  }
  const url = rec.routes[rec.route];
  // 计时起点在这里，不在 avatarRecord：排队时间不该计入超时（见上面的并发闸门说明）。
  rec.timer = setTimeout(() => {
    rec.timer = 0;
    avatarAttemptFailed(rec);
  }, AVATAR_TIMEOUT_MS);
  try {
    const image = new Image();
    image.referrerPolicy = 'no-referrer';
    image.onload = () => avatarSucceeded(rec, url);
    image.onerror = () => avatarAttemptFailed(rec);
    image.src = url;
  } catch {
    // 拿不到 Image 构造器（非浏览器宿主 / 内存受限）：走完尝试后判失败，界面停在字母上。
    avatarAttemptFailed(rec);
  }
};

/** 腾出一个在途名额并立刻补队。每条只允许释放一次，否则计数会跑负、闸门形同虚设。 */
const avatarRelease = (rec) => {
  if (!rec.dispatched || rec.released) return;
  rec.released = true;
  avatarInflight -= 1;
  avatarDrain();
};

const avatarFinish = (rec, next) => {
  avatarClearTimer(rec);
  avatarSettle(rec, next);
  avatarRelease(rec);
};

const avatarDrain = () => {
  // 重入保护：同步判死那条路径（Image 构造抛异常）会在 dispatch 里再调一次 drain，
  // 嵌套调用会绕开 while 的计数检查、把在途数打出上限。外层循环每轮都重读计数，
  // 所以让嵌套那次直接返回、由外层收摊，不会漏发。
  if (avatarDraining) return;
  avatarDraining = true;
  try {
    while (avatarInflight < AVATAR_INFLIGHT_MAX && avatarQueue.length) {
      const url = avatarQueue.shift();
      const rec = avatarRegistry.get(url);
      // 队头跳过：这条已被别的入口结算，或登记表已因溢出把它换掉了（绝不重复发）。
      if (!rec || rec.status !== 'loading' || rec.dispatched) continue;
      avatarDispatch(rec);
    }
  } finally {
    avatarDraining = false;
  }
};

/**
 * 取某头像的加载登记，键是**首选路由地址**（卡片与 PresenceLine 算出同一个字符串，
 * 所以自动共用同一条登记）。只有第一次建立时才入队发请求。
 * 组件只在 useEffect 里、且只在「离视口够近」时调用，所以首帧一定先出字母。
 */
const avatarRecord = (routes) => {
  const key = Array.isArray(routes) ? routes[0] : '';
  if (!key) return { status: 'fail', waiters: new Set(), timer: 0, dispatched: false, released: true, route: 0, routes: [], resolved: '' };
  const existing = avatarRegistry.get(key);
  if (existing) return existing;
  if (avatarRegistry.size >= AVATAR_REGISTRY_MAX) {
    // 先按插入序腾出一条**已结算**的。绝不优先杀在途或还在排队的：它们的回调 / 队位还认着
    // 这条记录，杀了之后同 URL 会被重建、再发一遍 —— 正好违反本层唯一的硬约束
    // （每个 URL 至多一次）。若一条都腾不出来，宁可不再探，也不让登记表随刷过的页数无限长。
    let freed = false;
    for (const [registered, rec] of avatarRegistry) {
      if (rec.status !== 'loading') {
        avatarRegistry.delete(registered);
        freed = true;
        break;
      }
    }
    // 溢出条：dispatched=false + released=true，让它永远不碰在途计数、也不入队。
    if (!freed) return { status: 'fail', waiters: new Set(), timer: 0, dispatched: false, released: true, route: 0, routes, resolved: '', overflow: true };
  }
  const rec = { status: 'loading', waiters: new Set(), timer: 0, dispatched: false, released: false, routes, route: 0, resolved: '' };
  avatarRegistry.set(key, rec);
  avatarQueue.push(key);
  avatarDrain();
  return rec;
};

/**
 * 「这一个头像离视口近不近」—— 照 dshmarket 的 `useNearViewport` / `CardShot` 的口径：
 * **没靠近视口就不发请求**（`rootMargin` 提前 200px，滚到之前就备好）。这条比并发闸门
 * 更根本：闸门只是排队，视口门是**根本不排队**——一屏十几张卡之外的那几十个 owner
 * 一次都不请求；面板切走、容器隐藏时同样一次都不请求。
 * 宿主没有 IntersectionObserver（老 Webview、非浏览器环境）时初值就是 `true`：
 * 宁可退回「全都探」，也绝不能因为观察不到而让头像永远停在字母上。
 * 节点走 `useRef` 而不是 `useState`：effect 在提交之后运行，那时 ref 已经挂上真实 DOM，
 * 不必为了「拿到节点」再多渲染一次（dshmarket 用 state，代价是每个头像挂载都多一趟重绘）。
 */
const AVATAR_VIEWPORT_MARGIN = '200px';
const useNearViewport = (rootMargin = AVATAR_VIEWPORT_MARGIN) => {
  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');
  const nodeRef = useRef(null);
  useEffect(() => {
    if (near || nodeRef.current === null) return undefined;
    let observer = null;
    try {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry && entry.isIntersecting)) setNear(true);
      }, { rootMargin });
      observer.observe(nodeRef.current);
    } catch {
      // 构造 / 挂载失败（老内核不认 rootMargin 这类参数）：当作已在视口，别把头像锁死。
      setNear(true);
    }
    return () => {
      if (observer) observer.disconnect();
    };
  }, [near, rootMargin]);
  return [nodeRef, near];
};

/**
 * 统一的头像位。`url` 空、还没进视口范围、或还没探到 → 字母；探到了 → <img>。
 * 地址在这一层先过一道 `avatarRouteCandidates`：GitHub 系换成代理小图（包括 wbRepoMeta
 * 给的 canonical `/u/<id>?v=4`，那是原图尺寸、直连又慢），别的域名原样透传。归一化收在
 * 这层而不是散到各调用点，十个头像位才不会有人漏掉。默认尺寸：卡片和它下面那行
 * PresenceLine 传的是同一个 owner，只有两边算出**同一个字符串**才合并成一次请求。
 * 状态用 `ready = { key, src }` 而不是布尔：切换详情时 key 变了但布尔还留着 true，
 * 会有一帧拿旧状态去绘新 src，这里靠「ready.key !== 当前 key 即回落字母」挡掉；
 * src 单独记是因为出图的可能不是首选路由（备胎），要画就画真正成功的那条地址。
 * hook 一律声明在组件顶层，条件只控制渲染、不控制声明（本仓库的 React #310 规矩）。
 */
const Avatar = ({ url, name, className }) => {
  const [nodeRef, near] = useNearViewport();
  const routes = avatarRouteCandidates(url);
  const key = routes[0] || '';
  const letter = String(name || '?').slice(0, 1).toUpperCase() || '?';
  const [ready, setReady] = useState(null);
  useEffect(() => {
    if (!key || !near) return undefined;
    const rec = avatarRecord(routes);
    if (rec.status === 'ok') {
      setReady({ key, src: rec.resolved || key });
      return undefined;
    }
    const done = () => {
      if (rec.status === 'ok') setReady({ key, src: rec.resolved || key });
      else if (rec.status === 'fail') setReady(null);
    };
    rec.waiters.add(done);
    return () => {
      rec.waiters.delete(done);
    };
  }, [key, near]);
  if (!key || !near || !ready || ready.key !== key) {
    return h('span', { ref: nodeRef, className: `${className} fallback`, 'aria-hidden': true }, letter);
  }
  return h('img', {
    ref: nodeRef,
    className,
    src: ready.src,
    alt: '',
    // 字节已经在浏览器缓存里（探到了才画这张图），所以**不写** `loading="lazy"`：
    // 那等于对一张必定要画的图说「晚点再取」，是自相矛盾的写法。
    // decoding / fetchPriority 是给少见情况兜底：缓存被挤掉、浏览器真要回源时，
    // 别抢别的请求的优先级、也别同步解码卡住主线程（一次可能有好几张同时换成图）。
    decoding: 'async',
    fetchPriority: 'low',
    referrerPolicy: 'no-referrer',
    // 缓存被挤掉、图片中途失效这类少见情况：退回字母，不留破图。
    onError: () => setReady(null),
  });
};
const timestampOf = (value) => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
};
const relativeLabel = (value) => {
  const at = timestampOf(value);
  return at ? fmtLast(at) : '';
};
const communityStatus = (meta) => {
  if (!meta) return null;
  if (meta.archived === true) return { cls: 's-warn dot', label: t('已归档') };
  const at = timestampOf(meta.pushedAt || meta.updatedAt);
  if (!at) return null;
  const days = Math.floor((Date.now() - at) / 86_400_000);
  if (days <= 30) return { cls: 's-on dot', label: t('近 30 天有提交') };
  if (days <= 180) return { cls: '', label: t('最近更新 {0}', [relativeLabel(at)]) };
  return { cls: 's-warn dot', label: t('超过半年未更新') };
};
// 卡片级的轻量「人」行：不发网络请求，只用目录里已经带回来的发布方 / 头像 / 时间。
const PresenceLine = ({ owner, avatar, updatedAt, href, note, className }) => {
  const at = timestampOf(updatedAt);
  const meta = at ? t('更新于 {0}', [relativeLabel(at)]) : (note || '');
  const name = String(owner || '').trim();
  if (!name && !meta) return null;
  return h('div', { className: 'dsh-mcp-presence-inline' + (className ? ' ' + className : '') },
    // 头像与发布方都没有时仍然什么都不画（这条分支是 PresenceLine 的既有契约）；
    // 只要有其一，就交给 Avatar：url 为空它会直接出字母，和原来「没图就字母」一致，
    // 而 url 非空时首帧也是字母，直到后台探到图片才换 —— 这正是合并请求后不重复发的那条路。
    avatar || name
      ? h(Avatar, { url: avatar, name, className: 'dsh-mcp-presence-inline-avatar' })
      : null,
    name
      ? h('span', { className: 'dsh-mcp-presence-inline-owner' },
          href ? h('a', { href, target: '_blank', rel: 'noreferrer' }, name) : name)
      : null,
    meta ? h('span', { className: 'dsh-mcp-presence-inline-note' }, meta) : null,
  );
};
// ── 市场连接器卡片头像 ──────────────────────────────────────────────────
// 连接器没有 GitHub 仓库可考，图标本体在官方分发包 ZIP 的 icons/<id>.<ext> 里，
// 宿主按需出 data URL（wbConnectorIcon）。与 Avatar（远程 URL 探活）分开：
// data URL 不走网络，占探活闸门的并发名额没有意义；但「进视口才取、取到就缓存」
// 的纪律一致 —— 客户端按 id 缓存，卡片、详情弹层、翻页重挂载都只发一次 RPC；
// 探过且没有的记 null，同样不再发。RPC 失败不记缓存，下次进视口还能重试。
const connectorIconCache = new Map();
const connectorIconPending = new Map();
const ConnectorAvatar = ({ call, connectorId, name, className }) => {
  const [nodeRef, near] = useNearViewport();
  const key = String(connectorId || '').trim();
  const letter = String(name || key || '?').slice(0, 1).toUpperCase() || '?';
  const [src, setSrc] = useState(() => connectorIconCache.get(key) || '');
  useEffect(() => {
    setSrc(connectorIconCache.get(key) || '');
    if (!key || !near || connectorIconCache.has(key)) return undefined;
    let alive = true;
    let pending = connectorIconPending.get(key);
    if (!pending) {
      pending = call('wbConnectorIcon', { connectorId: key })
        .then((res) => {
          // 两层 ok:false 语义不同，缓存策略也不同：
          //   · 信封层的 ok:false 带 error（方法 404 / 宿主抛错 / 服务未连接）——是
          //     **暂时**的（宿主还没重载等），不记缓存，下次进视口重试；
          //   · 宿主业务层的 ok:false 不带 error（目录里就是没图标）——是**最终**的，
          //     记 null，同一会话不再发。
          if (res?.ok) {
            const dataUrl = String(res.dataUrl || '');
            connectorIconCache.set(key, dataUrl || null);
            return dataUrl;
          }
          if (!res?.error) connectorIconCache.set(key, null);
          return '';
        })
        .catch(() => '')
        .finally(() => { connectorIconPending.delete(key); });
      connectorIconPending.set(key, pending);
    }
    pending.then((dataUrl) => { if (alive && dataUrl) setSrc(dataUrl); });
    return () => { alive = false; };
  }, [call, key, near]);
  if (!src) {
    return h('span', { ref: nodeRef, className: `${className} fallback`, 'aria-hidden': true }, letter);
  }
  return h('img', {
    ref: nodeRef,
    className,
    src,
    alt: '',
    decoding: 'async',
    referrerPolicy: 'no-referrer',
    // data URL 一般不会中途失效；真坏了退回字母，不留破图。
    onError: () => setSrc(''),
  });
};
// 详情级的维护信号：打开详情时按需查一次 GitHub（宿主侧 6 小时缓存）。
// 单条仓库查不到不阻塞详情——只把这一行收掉，正文照常可看。
const CommunityPresence = ({ call, repo, owner, avatar, updatedAt, compact }) => {
  const key = parseGithubRepoKey(repo);
  const [state, setState] = useState({ loading: Boolean(key), meta: null, error: '' });
  useEffect(() => {
    if (!key || typeof call !== 'function') {
      setState({ loading: false, meta: null, error: '' });
      return undefined;
    }
    let alive = true;
    setState({ loading: true, meta: null, error: '' });
    call('wbRepoMeta', { repos: [key] }).then((res) => {
      if (!alive) return;
      const row = res && res.repos ? res.repos[key] : null;
      setState({
        loading: false,
        meta: row && row.ok === true ? row : null,
        error: row && row.ok !== true ? String(row.error || '') : '',
      });
    }).catch((error) => {
      if (alive) setState({ loading: false, meta: null, error: String(error?.message || error || '') });
    });
    return () => { alive = false; };
  }, [call, key]);
  const meta = state.meta;
  const ownerName = String(meta?.owner || owner || (key ? key.split('/')[0] : '')).trim();
  const ownerUrl = meta?.ownerUrl || (key ? `https://github.com/${key.split('/')[0]}` : '');
  const avatarUrl = meta?.ownerAvatar || avatar || (key ? githubAvatarUrl(key) : '');
  const status = communityStatus(meta);
  const pushedAt = timestampOf(meta?.pushedAt);
  const fromUpstream = (compact ? ' dsh-mcp-presence-compact' : '');
  return h('div', { className: 'dsh-mcp-presence' + fromUpstream },
    h(Avatar, { url: avatarUrl, name: ownerName, className: 'dsh-mcp-presence-avatar' }),
    h('div', { className: 'dsh-mcp-presence-body' },
      h('div', { className: 'dsh-mcp-presence-line' },
        ownerName
          ? (ownerUrl
              ? h('a', { className: 'dsh-mcp-presence-owner', href: ownerUrl, target: '_blank', rel: 'noreferrer', title: t('打开维护者主页') }, ownerName)
              : h('span', { className: 'dsh-mcp-presence-owner' }, ownerName))
          : h('span', { className: 'dsh-mcp-presence-owner' }, t('来源未标注')),
        status ? h(Badge, { cls: status.cls }, status.label) : null,
        state.loading ? h('span', { className: 'dsh-mcp-presence-loading' }, t('读取维护动态…')) : null,
      ),
      h('div', { className: 'dsh-mcp-presence-meta' },
        meta
          ? [
              pushedAt ? h('span', { key: 'pushed' }, t('最近提交 {0}', [relativeLabel(pushedAt)])) : null,
              h('span', { key: 'issues' }, t('{0} 个开放 issue', [fmtInt(meta.openIssues)])),
              h('span', { key: 'stars' }, '★ ' + wbFormatCount(meta.stars)),
              meta.license ? h('span', { key: 'license' }, meta.license) : null,
              meta.language ? h('span', { key: 'lang' }, meta.language) : null,
            ]
          : h('span', null,
              updatedAt
                ? t('更新于 {0}', [relativeLabel(updatedAt)])
                : state.error
                  ? t('维护动态读取失败：{0}', [state.error])
                  : key
                    ? t('维护动态读取中…')
                    : t('这个条目没有公开仓库')),
      ),
    ),
  );
};
// 详情接口的 homepage 历史上可能是 api.skillhub.cn（JSON 接口，浏览器打开 405）。
// 数据层已统一成公开页（lib/wb-market.js 的 skillhubHomepage）；渲染层再兜一层，
// 旧缓存或未来上游变化都不会把接口地址交给浏览器。
const browsableHomepageUrl = (value) => {
  const url = String(value || '').trim();
  if (!/^https?:\/\//i.test(url)) return '';
  if (/^https?:\/\/api\.skillhub\.cn(?=[/?#]|$)/i.test(url)) return '';
  return url;
};
// 外部链接只接受 https。社区 MCP 的 repository.url 由上游提交，javascript: / file:
// 直接进 href 会在点击时执行；数据层已过滤，渲染层再兜一层（旧缓存 / 上游变化）。
const externalHref = (value) => {
  const url = String(value || '').trim();
  if (!/^https:\/\//i.test(url)) return '';
  try {
    return new URL(url).toString();
  } catch {
    return '';
  }
};
// 详情回包只覆盖「有值」的字段：上游对缺失字段返回空串 / 空数组时，不能把列表项里
// 已有的中文名、介绍、上架时间冲掉（issue #4）。0 与 false 是合法值，照常覆盖。
const mergeSkillDetail = (listItem, detail) => {
  const merged = { ...(listItem || {}) };
  for (const [key, value] of Object.entries(detail || {})) {
    if (value === '' || value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    merged[key] = value;
  }
  return merged;
};
const feedbackKindLabel = (kind) =>
  kind === 'skill' ? t('技能') : kind === 'expert' ? t('专家') : kind === 'plugin' ? t('插件') : kind === 'connector' ? t('连接器') : t('条目');
const feedbackTemplate = (item, kind, repo, homepage) => {
  const name = String(item?.name || item?.id || item?.plugin || item?.slug || '').trim() || t('未命名条目');
  const version = String(item?.version || '').trim();
  const source = String(repo || item?.repo || item?.repository || homepage || item?.homepage || item?.upstreamUrl || '').trim();
  const env = typeof navigator !== 'undefined' ? String(navigator.userAgent || '') : '';
  return [
    '### ' + t('条目：{0}', [name]),
    '- ' + t('类型：{0}', [feedbackKindLabel(kind)]),
    source ? '- ' + t('来源：{0}', [source]) : '',
    version ? '- ' + t('版本：{0}', [version]) : '',
    '',
    '### ' + t('发生了什么'),
    '',
    '',
    '### ' + t('环境'),
    '- ' + t('系统：{0}', [env]),
  ].filter(Boolean).join('\n');
};
// 真实社区出口：GitHub 仓库 / Issue / 复制模板 / 给军械库提建议。
// 刻意不做站内论坛、不做点赞收藏——那些只会把「有没有人」变成一种布景。
// 所有链接都在新标签页打开，正文先给用户看，点了才提交。
const FeedbackLinks = ({ item, kind, repo, homepage, sourceLabel }) => {
  const [copied, setCopied] = useState(false);
  const name = String(item?.name || item?.id || item?.plugin || item?.slug || '').trim() || t('未命名条目');
  const repoKey = parseGithubRepoKey(repo || item?.repo || item?.repository);
  const repoUrl = repoKey ? `https://github.com/${repoKey}` : '';
  const home = browsableHomepageUrl(homepage || item?.homepage || item?.upstreamUrl);
  const homeUrl = home && home !== repoUrl ? home : '';
  const template = feedbackTemplate(item, kind, repoUrl || homeUrl, homeUrl);
  const title = t('{0} · {1} 的反馈', [feedbackKindLabel(kind), name]);
  const issueUrl = ARMORY_REPO_URL + '/issues/new?title=' + encodeURIComponent(title) + '&body=' + encodeURIComponent(template);
  return h('div', { className: 'dsh-mcp-feedback' },
    h('div', { className: 'dsh-mcp-feedback-head' },
      h('b', null, t('找到真实的人')),
      sourceLabel ? h('span', { className: 'dsh-mcp-feedback-source' }, sourceLabel) : null,
    ),
    h('div', { className: 'dsh-mcp-feedback-actions' },
      repoUrl ? h('a', { className: 'dsh-mcp-btn', href: repoUrl, target: '_blank', rel: 'noreferrer' }, t('去仓库')) : null,
      repoUrl ? h('a', { className: 'dsh-mcp-btn', href: repoUrl + '/issues', target: '_blank', rel: 'noreferrer' }, t('看讨论 / 提 Issue')) : null,
      homeUrl ? h('a', { className: 'dsh-mcp-btn', href: homeUrl, target: '_blank', rel: 'noreferrer' }, t('来源主页')) : null,
      h('a', { className: 'dsh-mcp-btn', href: issueUrl, target: '_blank', rel: 'noreferrer' }, t('向军械库反馈')),
      h('button', {
        type: 'button', className: 'dsh-mcp-btn',
        onClick: async () => { setCopied(await copyText(template)); },
      }, copied ? t('已复制模板') : t('复制反馈模板')),
    ),
    h('p', { className: 'dsh-mcp-feedback-note' },
      t('反馈会打开 GitHub 新标签页；内容先由你过目，确认后才提交。')),
  );
};

// ── 顶栏「点 Star」：把用户送到 GitHub 那个真正的 Star 按钮前面 ─────────────
// 为什么放在分类栏右端而不是市场页里：这是整个插件的门面位，五个页签都看得到。
// 「给项目点个 Star」本来就不该藏在某一个子页的详情里。
//
// 边界（刻意的，别改成"真一键"）：GitHub 不支持匿名 star——PUT /user/starred 必须带
// 用户自己的凭据。插件不做站内账号、不存 token（见 docs/design.md 的边界一节），
// 所以这里只诚实做两件事：显示上游**真实**的 star 数，和一键打开仓库页让用户按
// GitHub 自己的 Star。不写本地「已 star」状态：那是一条没人能验证的布景，
// 而且会误导用户以为已经点过了。
//
// 数字走宿主侧 wbRepoMeta（6 小时缓存 + ETag + 限流回落），客户端不自己打 api.github.com。
// 读不到就不显示数字，按钮本身照常可用——它不该因为一个计数失败而消失。
const ARMORY_REPO_KEY = parseGithubRepoKey(ARMORY_REPO_URL);
const RepoStarChip = ({ call }) => {
  const [stars, setStars] = useState(null);
  // 点击爆裂动画靠 class 开关驱动；burstKey 让「连点」也能重放（同 class 不会重启动画）。
  const [burstKey, setBurstKey] = useState(0);
  useEffect(() => {
    if (typeof call !== 'function' || !ARMORY_REPO_KEY) return undefined;
    let alive = true;
    call('wbRepoMeta', { repos: [ARMORY_REPO_KEY] }).then((res) => {
      const row = alive && res && res.repos ? res.repos[ARMORY_REPO_KEY] : null;
      if (row && row.ok === true && typeof row.stars === 'number') setStars(row.stars);
    }).catch(() => { /* 保留 null：宁可不显示数字，也不显示一个假的 */ });
    return () => { alive = false; };
  }, [call]);
  useEffect(() => {
    if (!burstKey) return undefined;
    const timer = setTimeout(() => setBurstKey(0), 620);
    return () => clearTimeout(timer);
  }, [burstKey]);
  return h('a', {
    className: 'dsh-mcp-star' + (burstKey ? ' burst' : ''),
    href: ARMORY_REPO_URL,
    target: '_blank',
    rel: 'noreferrer',
    title: t('在 GitHub 打开 dsh-armory 仓库，点右上角的 Star'),
    'aria-label': t('给 dsh-armory 点 Star（新标签页打开 GitHub 仓库）'),
    onClick: () => setBurstKey((n) => n + 1),
  },
    h('span', { className: 'dsh-mcp-star-spark a', 'aria-hidden': true }),
    h('span', { className: 'dsh-mcp-star-spark b', 'aria-hidden': true }),
    h('svg', { className: 'dsh-mcp-star-svg', viewBox: '0 0 16 16', 'aria-hidden': true },
      h('path', { d: 'M8 1l1.7 4.65 4.96.19-3.9 3.14 1.37 4.8L8 10.6l-4.13 3.18 1.37-4.8-3.9-3.14 4.96-.19z' })),
    h('span', { className: 'dsh-mcp-star-label' }, t('点 Star')),
    // 数字没读到就整段不出现：空位比「★ —」诚实。
    stars === null ? null : h('span', { className: 'dsh-mcp-star-count' }, wbFormatCount(stars)),
  );
};

// ── 装备清单：把本机配置导出成可分享的 JSON，导入只做差异对比 ──────────────
// 与「最近动静」同一原则：不搭后端、不做账号、不自动装。清单只含身份字段，
// 敏感值在宿主侧就被投影掉（lib/loadout.js 的白名单），客户端拿不到也不该存。
const LOADOUT_KIND_ORDER = ['mcp', 'skill', 'expert', 'plugin'];
const loadoutKindLabel = (kind) =>
  kind === 'mcp' ? t('MCP') : kind === 'skill' ? t('技能') : kind === 'expert' ? t('专家') : kind === 'plugin' ? t('插件') : t('条目');
const loadoutSourceLabel = (source) => {
  const value = String(source || '').trim();
  if (!value) return '';
  if (value.startsWith('builtin:')) return t('内置 · {0}', [value.slice(8)]);
  if (value.startsWith('connector:')) return t('连接器 · {0}', [value.slice(10)]);
  if (value === 'manual') return t('手动配置');
  if (value === 'workbuddy-expert') return t('WorkBuddy 专家中心');
  if (value === 'skillhub' || value === 'workbuddy-skills') return t('SkillHub');
  if (value === 'codebuddy-plugins-official') return t('CodeBuddy 官方');
  if (value === 'awesome') return t('DSH 社区');
  if (value === 'local') return t('本机 / 自带');
  return value;
};
const loadoutStatusMeta = (status) =>
  status === 'update'
    ? { cls: 's-warn', label: t('可更新') }
    : status === 'missing'
      ? { cls: 's-warn', label: t('本机没有') }
      : { cls: 's-on', label: t('已安装') };
const loadoutCountText = (loadout) => {
  const counts = loadout && loadout.counts ? loadout.counts : {};
  const parts = LOADOUT_KIND_ORDER
    .filter((kind) => Number(counts[kind]) > 0)
    .map((kind) => `${loadoutKindLabel(kind)} ${counts[kind]}`);
  return parts.length ? parts.join(' · ') : t('清单为空。');
};
const loadoutFileNameOf = (name) => {
  const base = String(name || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '');
  return `${base || 'dsh-loadout'}.json`;
};
const downloadLoadoutFile = (filename, text) => {
  try {
    const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch {
    return false;
  }
};

const LoadoutModal = ({ call, onClose, onLocate }) => {
  const dialogRef = useRef(null);
  useFocusTrap(dialogRef, true);
  const [mode, setMode] = useState('export');
  const [name, setName] = useState('');
  const [loadout, setLoadout] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState('');
  const [importText, setImportText] = useState('');
  const [diff, setDiff] = useState(null);

  const generate = useCallback(async (customName) => {
    setBusy(true); setError(''); setNote('');
    try {
      const res = await call('wbLoadoutExport', { name: String(customName ?? '').trim() });
      if (!res?.ok || !res.loadout) throw new Error(res?.error || t('导出失败'));
      setLoadout(res.loadout);
      setText(JSON.stringify(res.loadout, null, 2));
      if (!String(customName ?? name ?? '').trim()) setName(res.loadout.name || '');
      return res.loadout;
    } catch (e) {
      setError(t('生成失败：{0}', [String(e?.message || e)]));
      return null;
    } finally {
      setBusy(false);
    }
  }, [call, name]);

  useEffect(() => { generate(''); }, []);

  const markCopied = (tag) => {
    setCopied(tag);
    setTimeout(() => setCopied(''), 1600);
  };
  const copyJson = async () => {
    if (!text) return;
    if (await copyText(text)) {
      setNote(t('已复制 JSON'));
      markCopied('json');
    }
  };
  const download = () => {
    if (!text) return;
    if (downloadLoadoutFile(loadoutFileNameOf(loadout?.name || name), text)) setNote(t('已开始下载'));
    else setNote(t('浏览器不允许下载，请改用复制 JSON'));
  };
  const copyName = async (value) => {
    if (await copyText(String(value || ''))) markCopied('name:' + String(value || ''));
  };
  const readFile = async (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 256 * 1024) {
      setError(t('文件过大（上限 256KB）'));
      return;
    }
    try {
      setImportText(await file.text());
      setDiff(null);
      setError('');
    } catch (e) {
      setError(t('文件读取失败：{0}', [String(e?.message || e)]));
    }
  };
  const compare = async () => {
    const raw = importText.trim();
    if (!raw) {
      setError(t('先粘贴一份清单，或选择 .json 文件。'));
      return;
    }
    setBusy(true); setError(''); setNote(''); setDiff(null);
    try {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        throw new Error(t('不是有效的 JSON：{0}', [String(e?.message || e)]));
      }
      const res = await call('wbLoadoutDiff', { loadout: parsed });
      if (!res?.ok) throw new Error(res?.error || t('对比失败'));
      setDiff(res);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  return h('div', { className: 'dsh-mcp-overlay', onClick: (e) => !busy && e.target === e.currentTarget && onClose() },
    h('div', {
      ref: dialogRef, className: 'dsh-mcp-modal dsh-mcp-loadout-modal', role: 'dialog', 'aria-modal': true,
      'aria-label': t('装备清单'), tabIndex: -1,
      onKeyDown: (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); onClose(); } },
    },
    h('h3', null, t('装备清单')),
    h('div', { className: 'dsh-mcp-loadout-tabs', role: 'tablist' },
      h('button', {
        type: 'button', role: 'tab', 'aria-selected': mode === 'export',
        className: 'dsh-mcp-loadout-tab', onClick: () => setMode('export'),
      }, t('导出')),
      h('button', {
        type: 'button', role: 'tab', 'aria-selected': mode === 'import',
        className: 'dsh-mcp-loadout-tab', onClick: () => setMode('import'),
      }, t('导入对比')),
    ),
    mode === 'export'
      ? h('div', { className: 'dsh-mcp-loadout-pane' },
          h('p', { className: 'dsh-mcp-loadout-hint' },
            t('把本机的 MCP、技能、专家与插件导出成一份可分享的清单；导入只做对比，不会自动安装。')),
          h('label', { className: 'dsh-mcp-loadout-name' },
            h('span', null, t('清单名称')),
            h('input', {
              value: name, maxLength: 120, disabled: busy,
              placeholder: t('我的 DSH 装备清单'),
              onChange: (e) => setName(e.target.value),
            }),
            h(Btn, { onClick: () => generate(name), disabled: busy || !name.trim(), children: busy ? t('读取本机配置…') : t('重新生成') }),
          ),
          loadout
            ? h('div', { className: 'dsh-mcp-loadout-result' },
                h('div', { className: 'dsh-mcp-loadout-summary' },
                  h('span', null, loadoutCountText(loadout)),
                  loadout.truncated ? h('span', { className: 'dsh-mcp-loadout-warn' }, t('超过 200 条，只导出前 200 条。')) : null,
                ),
                h('pre', { className: 'dsh-mcp-loadout-json' }, text),
                h('div', { className: 'dsh-mcp-loadout-actions' },
                  h(Btn, { onClick: copyJson, disabled: !text, children: copied === 'json' ? t('已复制') : t('复制 JSON') }),
                  h(Btn, { onClick: download, disabled: !text, children: t('下载 .json') }),
                  h(Btn, { onClick: () => setMode('import'), children: t('导入对比') }),
                ),
              )
            : h('div', { className: 'dsh-mcp-wb-empty' }, busy ? t('读取本机配置…') : t('还没有生成清单。')),
          h('p', { className: 'dsh-mcp-loadout-note' },
            t('这份清单只含名称、类型、来源与版本；不会写入密钥、header 或环境变量的值。')),
        )
      : h('div', { className: 'dsh-mcp-loadout-pane' },
          h('p', { className: 'dsh-mcp-loadout-hint' },
            t('把朋友发来的清单贴在这里，或选择文件。导入只做对比，不会自动安装。')),
          h('textarea', {
            className: 'dsh-mcp-loadout-input', value: importText, rows: 8, spellCheck: false,
            placeholder: t('粘贴清单 JSON…'),
            onChange: (e) => { setImportText(e.target.value); setDiff(null); setError(''); },
          }),
          h('div', { className: 'dsh-mcp-loadout-actions' },
            h('label', { className: 'dsh-mcp-btn dsh-mcp-loadout-file' },
              t('选择 .json 文件'),
              h('input', { type: 'file', accept: '.json,application/json', hidden: true, onChange: readFile }),
            ),
            h(Btn, { onClick: compare, disabled: busy || !importText.trim(), children: busy ? t('对比中…') : t('对比本机') }),
            importText ? h('button', {
              type: 'button', className: 'dsh-mcp-btn',
              onClick: () => { setImportText(''); setDiff(null); setError(''); },
            }, t('清空')) : null,
          ),
          diff
            ? h('div', { className: 'dsh-mcp-loadout-result' },
                h('div', { className: 'dsh-mcp-loadout-summary' },
                  h('span', null, t('共 {0} 项 · 已安装 {1} · 可更新 {2} · 本机没有 {3}', [
                    diff.counts?.total || 0, diff.counts?.installed || 0, diff.counts?.update || 0, diff.counts?.missing || 0,
                  ])),
                  diff.loadout?.name ? h('span', { className: 'dsh-mcp-loadout-from' }, t('清单来自 {0}', [diff.loadout.name])) : null,
                ),
                h('div', { className: 'dsh-mcp-loadout-rows' },
                  (diff.rows || []).map((row) => {
                    const meta = loadoutStatusMeta(row.status);
                    const nameKey = 'name:' + String(row.name || '');
                    return h('div', { key: String(row.kind) + ':' + String(row.name), className: 'dsh-mcp-loadout-row' },
                      h('div', { className: 'dsh-mcp-loadout-row-main' },
                        h('div', { className: 'dsh-mcp-loadout-row-title' },
                          h('span', { className: 'dsh-mcp-loadout-kind' }, loadoutKindLabel(row.kind)),
                          h('b', null, row.name),
                          h(Badge, { cls: meta.cls }, meta.label),
                        ),
                        h('div', { className: 'dsh-mcp-loadout-row-meta' },
                          row.source ? h('span', null, t('来源：{0}', [loadoutSourceLabel(row.source)])) : null,
                          row.version ? h('span', null, t('版本：{0}', [row.version])) : null,
                          row.localVersion && row.localVersion !== row.version ? h('span', null, t('本机：{0}', [row.localVersion])) : null,
                        ),
                      ),
                      h('div', { className: 'dsh-mcp-loadout-row-actions' },
                        row.status !== 'installed' ? h('button', {
                          type: 'button', className: 'dsh-mcp-btn',
                          onClick: () => onLocate(row),
                        }, t('去市场')) : null,
                        h('button', {
                          type: 'button', className: 'dsh-mcp-btn',
                          onClick: () => copyName(row.name),
                        }, copied === nameKey ? t('已复制名称') : t('复制名称')),
                      ),
                    );
                  }),
                ),
              )
            : null,
          h('p', { className: 'dsh-mcp-loadout-note' },
            t('导入只做对比；点「去市场」逐项安装，不会自动写入任何配置。')),
        ),
    error ? h('div', { className: 'dsh-mcp-wb-error', role: 'alert' }, error) : null,
    note ? h('div', { className: 'dsh-mcp-wb-note', role: 'status' }, note) : null,
    h('div', { className: 'dsh-mcp-modal-actions' },
      h(Btn, { onClick: onClose, disabled: busy, children: t('关闭') }),
    ),
    ),
  );
};

// ── 最近动静：本机快照对比，不联网、不统计、不伪造「在线人数」───────────────
// 语义边界（必须诚实）：
//   - 只对比「这台机器上次成功读取目录」与「这一次读取」的差异；
//   - 只有**同一份清单**的两次读取才互为基线（basis，见 recordMarketSnapshot）：翻页切片、
//     带搜索词的结果、不同排序的首页是三个不同的集合，拿来互比只会造出假动静；
//   - 只记录新增 / 移除 / 版本或核验状态变化，不做消息流，也不假装实时；
//   - 没有变化就直说没有；事件 7 天过期，用户可一键清除。
const MARKET_PULSE_KEY = KEY_PREFIX + '.marketPulse.v2';
// v2 的由来（2026-10-24 用户报「切换页面重新进入时重复读取」）：v1 的技能基线取的是
// SkillHub「下载量（本页排序）」首页，而这一档根本不给上游发 sortBy（见 wb-market.js 的
// SKILLHUB_REMOTE_SORTS）——无 ORDER BY 的 LIMIT 20 每次返回的是 19 万库里随机 20 条
// （实测：同一请求隔 2.5 秒重合 0/20，而 sortBy=installs 重合 20/20）。于是每进一次市场
// 就记一对「新增 20 / 移除 20」。旧键里攒下来的全是这种假动静，没有一条可信到值得挑出来
// 保留，所以读到即整份丢弃、不搬值。
const LEGACY_MARKET_PULSE_KEY = KEY_PREFIX + '.marketPulse.v1';
// 两次读取的键重合度低于此值 ⇒ 读到的不是同一份清单（上游换了默认排序、目录整批改写、
// 或一次被截断的部分响应）。这种差异报出来就是「全增全删」的噪音，闭嘴重新起底更诚实。
const MARKET_PULSE_MIN_OVERLAP = 0.1;
const MARKET_PULSE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MARKET_PULSE_MAX_EVENTS = 8;
const MARKET_PULSE_SOURCES = {
  awesome: { get label() { return t('DSH 社区'); }, tab: 'plugin' },
  expert: { get label() { return t('专家中心'); }, tab: 'expert' },
  skill: { get label() { return t('SkillHub'); }, tab: 'skill' },
  connector: { get label() { return t('连接器市场'); }, tab: 'connector' },
};
const emptyMarketPulse = () => ({ version: 2, snapshots: {}, events: [] });
const readMarketPulse = () => {
  try {
    // 旧键一次性丢弃（removeItem 幂等；隐私模式下和下面的 getItem 一起被同一个 catch 兜住）。
    localStorage.removeItem(LEGACY_MARKET_PULSE_KEY);
    const raw = JSON.parse(localStorage.getItem(MARKET_PULSE_KEY) || 'null');
    if (!raw || raw.version !== 2 || typeof raw.snapshots !== 'object' || !Array.isArray(raw.events)) return emptyMarketPulse();
    const now = Date.now();
    // CodeBuddy 插件源已移除：旧快照与「最近动静」里 source='plugin' 的记录一并丢弃，
    // 否则会留下一条点不进去、也没有市场对应的历史事件。
    const snapshots = { ...raw.snapshots };
    delete snapshots.plugin;
    return {
      version: 2,
      snapshots,
      events: raw.events.filter((event) => event && event.source !== 'plugin' && now - Number(event.at || 0) <= MARKET_PULSE_TTL_MS).slice(0, MARKET_PULSE_MAX_EVENTS),
    };
  } catch { return emptyMarketPulse(); }
};
const writeMarketPulse = (state) => {
  try { localStorage.setItem(MARKET_PULSE_KEY, JSON.stringify(state)); } catch { /* 配额 / 隐私模式：静默降级 */ }
};
const pushPulseEvent = (state, source, kind, keys, current, previous) => {
  const names = keys.map((key) => current[key]?.n || previous[key]?.n || key).slice(0, 3);
  state.events.unshift({
    id: source + ':' + kind + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 6),
    source, kind, count: keys.length, names, at: Date.now(),
  });
  state.events = state.events.slice(0, MARKET_PULSE_MAX_EVENTS);
};
/**
 * 记录一次目录快照并返回是否有变化。
 * rows: [{ key, name, sig }]；sig 是「版本 + 核验状态」这类稳定签名，不用来比较热门度
 * （星数每天波动，属于噪音，不当作「动静」）。
 * options.basis: 这份清单的「可比身份」，默认 'full'（整份目录）。只有 basis 相同的两次
 * 读取才互为基线；不同就静默换基线——不报错、也不造事件。局部视图必须把视图身份写进
 * basis（技能侧传 'skill:installs' 这类，见 loadSkills）。
 */
const recordMarketSnapshot = (source, rows, options = {}) => {
  if (!source || !Array.isArray(rows) || !rows.length) return false;
  const basis = String(options.basis || 'full');
  const state = readMarketPulse();
  const current = {};
  for (const row of rows) {
    const key = String(row && row.key || '').trim();
    if (!key) continue;
    current[key] = { s: String(row.sig || ''), n: String(row.name || key) };
  }
  if (!Object.keys(current).length) return false;
  const last = state.snapshots[source];
  const previous = last && last.items ? last.items : null;
  state.snapshots[source] = { at: Date.now(), basis, items: current };
  // 三条「不比」的路径：没有基线、基线不是同一份清单、两份清单重合度过低。
  // 都只写新基线、不产事件——宁可少报，也不报假的。
  if (!previous || last.basis !== basis) {
    writeMarketPulse(state);
    return false;
  }
  const currentKeys = Object.keys(current);
  const previousKeys = Object.keys(previous);
  const shared = currentKeys.reduce((n, key) => n + (key in previous ? 1 : 0), 0);
  if (shared / Math.max(currentKeys.length, previousKeys.length) < MARKET_PULSE_MIN_OVERLAP) {
    writeMarketPulse(state);
    return false;
  }
  const added = currentKeys.filter((key) => !(key in previous));
  const removed = previousKeys.filter((key) => !(key in current));
  const updated = currentKeys.filter((key) => key in previous && current[key].s !== previous[key].s);
  if (!added.length && !removed.length && !updated.length) {
    writeMarketPulse(state);
    return false;
  }
  if (added.length) pushPulseEvent(state, source, 'added', added, current, previous);
  if (removed.length) pushPulseEvent(state, source, 'removed', removed, current, previous);
  if (updated.length) pushPulseEvent(state, source, 'updated', updated, current, previous);
  writeMarketPulse(state);
  return true;
};
const clearMarketPulse = () => {
  try { localStorage.removeItem(MARKET_PULSE_KEY); } catch { /* 隐私模式 */ }
};
// 子组件（专家市场）写完备忘录后，通知面板重读一次；模块级单监听，组件卸载即摘除。
let marketPulseListener = null;
const setMarketPulseListener = (listener) => { marketPulseListener = typeof listener === 'function' ? listener : null; };
const emitMarketPulse = () => { try { marketPulseListener?.(); } catch { /* 单个监听失败不影响业务 */ } };
const MarketPulse = ({ state, onJump, onClear }) => {
  const events = Array.isArray(state?.events) ? state.events : [];
  const snapshotAts = Object.values(state?.snapshots || {}).map((row) => Number(row?.at || 0)).filter(Boolean);
  const lastAt = snapshotAts.length ? Math.max(...snapshotAts) : 0;
  if (!events.length) {
    return h('div', { className: 'dsh-mcp-pulse quiet' },
      h('span', { className: 'dsh-mcp-pulse-title' }, t('最近动静')),
      h('span', { className: 'dsh-mcp-pulse-quiet' },
        lastAt
          ? t('暂无新变化 · 上次对比 {0} · 只在本机对比快照', [relativeLabel(lastAt)])
          : t('已开始记录市场动态；下次打开时这里会列出真实变化')),
    );
  }
  return h('div', { className: 'dsh-mcp-pulse' },
    h('div', { className: 'dsh-mcp-pulse-head' },
      h('b', { className: 'dsh-mcp-pulse-title' }, t('最近动静')),
      h('span', { className: 'dsh-mcp-pulse-note' }, t('自上次打开市场以来，目录里真实发生的变化（本机快照对比）')),
      h('button', { type: 'button', className: 'dsh-mcp-pulse-clear', onClick: onClear }, t('清除')),
    ),
    h('ul', { className: 'dsh-mcp-pulse-list' }, events.map((event) => {
      const meta = MARKET_PULSE_SOURCES[event.source] || null;
      const sourceLabel = meta ? meta.label : event.source;
      const text = event.kind === 'added'
        ? t('{0} 新增 {1} 条', [sourceLabel, event.count])
        : event.kind === 'removed'
          ? t('{0} 移除 {1} 条', [sourceLabel, event.count])
          : t('{0} 更新 {1} 条', [sourceLabel, event.count]);
      const sample = event.names && event.names.length ? ' · ' + event.names.join(', ') + (event.count > event.names.length ? t(' 等') : '') : '';
      return h('li', { key: event.id },
        h('button', {
          type: 'button', className: 'dsh-mcp-pulse-item', title: t('跳到对应市场'),
          onClick: () => { if (meta && typeof onJump === 'function') onJump(meta); },
        },
          h('span', { className: 'dsh-mcp-pulse-kind ' + event.kind }, text),
          h('span', { className: 'dsh-mcp-pulse-sample' }, sample),
        ),
        h('span', { className: 'dsh-mcp-pulse-time' }, relativeLabel(event.at)),
      );
    })),
  );
};

// ── 市场面板：WorkBuddy 连接器 / SkillHub 技能 / 插件 / 专家子标签 ──────────────
// 市场搜索框：左内置放大镜、圆角胶囊、聚焦高亮、右一键清空。
// 两处复用（连接器 / 插件）：两者都是纯本地过滤，输入即过滤；
// 技能走服务端搜索，onCommit 由防抖或回车触发（见 WorkBuddyMarket 内注释）。
// busy 只做视觉提示，**绝不 disabled 输入框**：disabled 会让浏览器立刻收走焦点，
// 技能搜索防抖生效那一刻（含按 Delete 删字后的停顿）输入框被禁用 → 光标丢失，
// 用户得重新点一次才能继续输入。加载态改由放大镜呼吸动画表达（见 .busy CSS）。
const WbSearchBox = ({ value, onChange, placeholder, busy, onCommit }) =>
  h('div', { className: 'dsh-mcp-wb-search' + (busy ? ' busy' : '') },
    h('span', { className: 'dsh-mcp-wb-search-ico', 'aria-hidden': true }, h(Icon, { d: ICONS.search, size: 14 })),
    h('input', {
      type: 'search', className: 'dsh-mcp-wb-search-input', placeholder,
      value, spellCheck: false, 'aria-busy': busy || undefined,
      onChange: (e) => onChange(e.target.value),
      onKeyDown: onCommit
        ? (e) => { if (e.key === 'Enter') { e.preventDefault(); onCommit(); } }
        : undefined,
    }),
    value
      ? h('button', {
          type: 'button', className: 'dsh-mcp-wb-search-clear', title: t('清空'),
          'aria-label': t('清空搜索'),
          onClick: () => { onChange(''); if (onCommit) onCommit(); },
        }, h(Icon, { d: ICONS.x, size: 12 }))
      : null,
  );
// ── P1-5：技能列表 SWR（模块级，跨面板开关存活）────────────────────────────
// SkillHub 是远程分页接口（本机实测 187–229ms/次），而用户在「技能 ↔ 连接器」之间
// 来回切时看到的往往还是同一页。按 page|sort|keyword 缓存 60 秒：命中直接渲染，
// 不再发那一次远程请求；过期后照常请求。搜索词 / 排序 / 页码都是缓存键的一部分，
// 不会把 A 的结果显示到 B 上。条数封顶 30 条，避免长会话里无限涨。
const SKILL_SWR_TTL_MS = 60 * 1000;
const SKILL_SWR_MAX_ENTRIES = 30;
const skillListCache = new Map(); // key -> { at, skills, total }
function readSkillCache(key) {
  if (!MARKET_PERF.skillSwr) return null;
  const hit = skillListCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SKILL_SWR_TTL_MS) { skillListCache.delete(key); return null; }
  return hit;
}
function writeSkillCache(key, value) {
  if (!MARKET_PERF.skillSwr) return;
  skillListCache.set(key, { at: Date.now(), ...value });
  while (skillListCache.size > SKILL_SWR_MAX_ENTRIES) {
    const oldest = skillListCache.keys().next();
    if (oldest.done) break;
    skillListCache.delete(oldest.value);
  }
}
// ── P2-3：卡片 hover 预取详情（模块级，单条缓存）──────────────────────────────
// 鼠标扫过一屏卡片会连发几十次 mouseenter，所以在「停在同一张卡上 200ms」后才发一条；
// 离开卡片立即取消，进入下一张会把上一条挂起的取消掉（同时最多一条待发、一条在飞）。
// 三类详情各留**最近一条**结果：用户真点开时直接用手上的回包，二次请求为 0；
// 换一张卡就覆盖，不做无界字典。60 秒 TTL 只为了不把「很久前的授权态」摆到眼前
// （授权 / 重连之后状态会变）；技能详情与 README 属内容型数据，超时重拉也不吃亏。
const HOVER_PREFETCH_DELAY_MS = 200;
const DETAIL_MEMO_TTL_MS = 60 * 1000;
let hoverPrefetchTimer = null;
const hoverMemo = {
  skillDetail: { key: '', at: 0, value: null },
  connectorAuth: { key: '', at: 0, value: null },
  readme: { key: '', at: 0, value: null },
};
function cancelHoverPrefetch() {
  if (hoverPrefetchTimer) { clearTimeout(hoverPrefetchTimer); hoverPrefetchTimer = null; }
}
function scheduleHoverPrefetch(run) {
  if (!MARKET_PERF.hoverPrefetch) return;
  cancelHoverPrefetch();
  hoverPrefetchTimer = setTimeout(() => {
    hoverPrefetchTimer = null;
    try { run(); } catch { /* 预取失败无感：点开时照常请求 */ }
  }, HOVER_PREFETCH_DELAY_MS);
}
function readDetailMemo(slot, key) {
  if (!MARKET_PERF.hoverPrefetch) return null;
  if (!key || slot.key !== key || !slot.value) return null;
  if (Date.now() - slot.at > DETAIL_MEMO_TTL_MS) return null;
  return slot.value;
}
function writeDetailMemo(slot, key, value) {
  if (!MARKET_PERF.hoverPrefetch || !key || !value) return;
  slot.key = key; slot.at = Date.now(); slot.value = value;
}
const skillDetailMemoKey = (skill) => String(skill?.namespace || '') + '/' + String(skill?.slug || '');
const readmeMemoKey = (item) => {
  const npm = typeof item?.npm === 'string' ? item.npm : (item?.npm && item.npm.name) || '';
  return String(item?.name || '') + '|' + npm + '|' + String(item?.repo || '');
};
// ── 「最近动静」跳转口径：直达该来源的**全量市场** ────────────────────────────
// 「新增 3 条 / 更新 2 条」说的是整个目录的变化，落到一半的过滤条件里就看不见它了：
// 搜索词、只看已安装、分类、排序、页码任意一项生效，用户还得自己挨个清掉才能核对。
// 所以点条目时把目标页签重置回全量：搜索清空、筛选取消、排序回默认、页码回 1。
// 口径写成纯函数（不碰 state），行为可被测试直接跑；组件只负责把值写回 setter。
//   连接器：回到 WorkBuddy 源（动静只记录这份目录），并取消「只看可直接安装 / 已安装」；
//   技能：清空搜索与排序、回第 1 页（记录口径本身就是默认页 / 无关键词）；
//   插件：清空搜索、分类、标签与「只看已安装」，排序回 stars；
//   专家：状态全在 ExpertMarket 内部，交回「重挂」信号，由组件递增 key 回到全量首屏。
const marketFullScope = (tabKey) => {
  if (tabKey === 'connector') {
    return {
      connectorFeed: 'wb',
      connectorQuery: '',
      connectorOnlyReady: false,
      connectorOnlyInstalled: false,
      connectorSort: 'default',
      connectorPage: 1,
    };
  }
  if (tabKey === 'skill') {
    return {
      skillKeyword: '',
      skillKeywordInput: '',
      skillSort: 'downloads',
      skillOnlyInstalled: false,
      skillPage: 1,
    };
  }
  if (tabKey === 'plugin') {
    return {
      awesomeQuery: '',
      awesomeCategory: 'all',
      awesomeTags: [],
      awesomeSort: 'stars',
      awesomeOnlyInstalled: false,
      awesomePage: 1,
    };
  }
  if (tabKey === 'expert') return { expertRemount: true };
  return null;
};
const WorkBuddyMarket = ({ call, pluginManager }) => {
  // ── 共享状态 ──
  const [tab, setTab] = useState('connector');       // connector | skill
  const [loading, setLoading] = useState(true);
  // P1-1：连接器首屏（含快照）是否已落地。插件 / 专家目录预取都等它，避免三个市场
  // 同时抢 IPC 与主线程——首屏那 300ms 是用户唯一能感知到的部分。
  const [connectorSettled, setConnectorSettled] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState('');
  const [note, setNote] = useState('');
  // 「最近动静」只读本机快照：读写失败静默降级，绝不阻塞市场主流程。
  const [pulse, setPulse] = useState(() => readMarketPulse());
  // 装备清单：打开时现读本机，不在面板挂载时就做汇总（省一次 IPC 与目录读取）。
  const [loadoutOpen, setLoadoutOpen] = useState(false);
  // 专家页搜索种子的一次性 epoch：即使当前已停在专家页，也能用 key 重挂并带上搜索词。
  const [expertEpoch, setExpertEpoch] = useState(0);
  // 专家子页签徽标：市场挂载后延迟一拍预取专家目录，只取条数。目录读失败静默——
  // 徽标先不显示，绝不拖垮市场主流程；用户进过一次专家页后磁盘缓存常驻，之后零网络。
  const [expertTotal, setExpertTotal] = useState(null);
  const refreshPulse = useCallback(() => setPulse(readMarketPulse()), []);
  useEffect(() => {
    setMarketPulseListener(refreshPulse);
    return () => setMarketPulseListener(null);
  }, [refreshPulse]);
  const [connectorSource, setConnectorSource] = useState('');
  const [connectors, setConnectors] = useState([]);
  const [connectorQuery, setConnectorQuery] = useState('');
  const [connectorOnlyReady, setConnectorOnlyReady] = useState(true);
  // ── 社区 MCP（连接器页的第二个来源）──
  // 与上面的 connectorSource（目录来自 network/disk）不是一回事：这里是「当前看哪个来源」，
  // 名字必须区分。默认停在 wb，行为与改造前完全一致。
  const [connectorFeed, setConnectorFeed] = useState('wb');
  const [communityRows, setCommunityRows] = useState([]);
  const [communityQueryInput, setCommunityQueryInput] = useState('');
  const [communityQuery, setCommunityQuery] = useState('');
  const [communityNextCursor, setCommunityNextCursor] = useState(null);
  // 翻页：Registry 是游标分页且不返回总数，前端只记「第几页」与本次查询已读取的累计条数。
  // 页内容互斥（第 2 页替换第 1 页），不像「加载更多」那样越堆越长。
  const [communityPage, setCommunityPage] = useState(1);
  const [communityReadTotal, setCommunityReadTotal] = useState(0);
  const [communityLoading, setCommunityLoading] = useState(false);
  const [communityError, setCommunityError] = useState('');
  // 「缓存结果」：断网 / 上游变慢时保留上次内存结果并如实标注，而不是清空列表。
  const [communityStale, setCommunityStale] = useState(false);
  const [communityOnlyRunnable, setCommunityOnlyRunnable] = useState(true);
  // 社区目录「全库总数」（连接器页徽标常驻显示的那个数）。口径与续爬策略见模块级
  // COMMUNITY_COUNT_KEY 一节：上游不给总数，只能有界地一段一段数，进度存本地。
  const [communityCount, setCommunityCount] = useState(readCommunityCount);
  const communityCountRef = useRef(communityCount);
  // 本次面板会话已花掉的统计页数（不是累计条数）：预算用尽就不再占网络，下次开面板接着来。
  const communityCountPagesRef = useRef(0);
  const communityCountBusyRef = useRef(false);
  // 社区条目的「加入 MCP」草稿：预填 AddEditModal，用户确认后才写盘。
  const [communityDraft, setCommunityDraft] = useState(null);
  // 社区卡片详情：点整卡打开，交互与插件 README 弹层一致（遮罩 / Esc 关闭、焦点陷阱）。
  // 内容全部来自当前列表行（Registry 一次响应已带 command / args / env），不再发请求。
  const [communityDetail, setCommunityDetail] = useState(null);
  // T04/R8：已安装筛选（全量本地筛选，不受分页影响——与技能侧「仅本页」不同）。
  const [connectorOnlyInstalled, setConnectorOnlyInstalled] = useState(false);
  // T05/R10：连接器排序键（全量本地排序）。
  const [connectorSort, setConnectorSort] = useState('default');
  const [connectorPage, setConnectorPage] = useState(1);
  const [connectorDetail, setConnectorDetail] = useState(null);
  // P0：连接器「真实连接态」。市场卡片此前只认安装账本——「写进过配置」不等于「连得上」，
  // 用户看到「已安装」却用不了（ima / 腾讯自选股就是这么被误判的）。这里读 MCP 面板同一份
  // list() 投影：连接态的唯一证据是工具数（lib/mcp-observability.js deriveMcpPhase），不猜日志。
  const [mcpServerRows, setMcpServerRows] = useState([]);
  // 详情弹层里的授权概况（wbOAuthOverview：只读落盘记录，不联网）。此前这个 RPC 声明了
  // 却从未被调用，用户看不到授权是否还有效、什么时候过期。
  const [connectorAuth, setConnectorAuth] = useState(null);
  const connectorDetailIdRef = useRef('');
  // ── 技能 ──
  const [skillPage, setSkillPage] = useState(1);
  const [skillSort, setSkillSort] = useState('downloads');
  const [skillKeyword, setSkillKeyword] = useState('');
  const [skillKeywordInput, setSkillKeywordInput] = useState('');
  const [skills, setSkills] = useState([]);
  const [skillTotal, setSkillTotal] = useState(0);
  // 子页签徽标用的「全库」总量：只在无关键词的响应里更新。搜索命中数不进来，
  // 徽标与连接器 / 插件徽标同语义——市场规模，不随当前筛选变。
  const [skillMarketTotal, setSkillMarketTotal] = useState(0);
  // 技能侧自己的加载/错误态：此前与连接器共用 `loading`/`error`，两种请求谁先回来谁就
  // 把对方的态改掉——连接器 1 秒读完就把 loading 置 false，技能还在飞，于是技能页先画
  // 「技能目录暂时是空的 / 可能还没同步下来」；等技能真的超时，又把整页 banner 改成报错。
  // 拆开之后，技能慢只影响技能页自己的 loading/error。
  const [skillLoading, setSkillLoading] = useState(true);
  const [skillError, setSkillError] = useState('');
  const [skillDetail, setSkillDetail] = useState(null);
  // 已安装集合：键是 namespace/slug 双键 → 值是安装时间（毫秒，0 = 取不到）。Map 上的
  // has() 与 Set 同用法，所有既有判定点不变；get() 供「安装于 …」徽标取时间。
  const [installedSkills, setInstalledSkills] = useState(new Map());
  // §6.3 已安装筛选：SkillHub 每页 20 条远程分页，而「已装」是本地集合，
  // 所以这层过滤只能作用于**当前页**——必须在标签上写清，否则会被误读成全库筛选。
  // T04/R7：令牌弹窗。连接器 mcp.json 里带 ${...} 占位符时要先让用户填值——
  // 面板只做「用户明确输入」的透传，绝不代填、绝不猜值（X9 边界）。
  // tokenDialog = { item, values: Record<占位符名, string> } | null
  const [tokenDialog, setTokenDialog] = useState(null);
  // R8：OAuth 授权对话框。连接器探测到 401 不再报错，改为弹这里引导浏览器授权。
  // authDialog = { item, serverName, sessionId, authorizeUrl, mode, redirectUri, hint,
  //                status, error, callbackUrl, manualToken } | null
  const [authDialog, setAuthDialog] = useState(null);
  const authDialogRef = useRef(null);
  authDialogRef.current = authDialog;
  const authPollRef = useRef(null);
  const authDialogRefNode = useRef(null);
  useFocusTrap(authDialogRefNode, !!authDialog);
  const [skillOnlyInstalled, setSkillOnlyInstalled] = useState(false);
  // 「已安装」集合的键是 namespace/slug 双键，不是 slug 单键：SkillHub 上同 slug 不同
  // namespace 的技能一大把（find-skills 实测三家在架）。单键会让没装过的同名卡片假显示
  // 「已安装」，在假卡片上点卸载又必撞「本机没有这个市场技能的安装记录」——用户报的
  // 「假安装」截图正是这一对症状。wbSkillInstalled 行的 namespace/slug 从目录名解析
  // （与安装时同一套 sanitize 口径），与卡片两字段天然一一对应。
  const skillInstalledKey = (row) => row.namespace + '/' + row.slug;
  // OPT-21：两个详情弹层此前都没有 ref（焦点陷阱需要容器节点）。
  const connectorDetailRef = useRef(null);
  const skillDetailRef = useRef(null);
  // 技能详情请求序号：关掉弹层或改点另一条后，在途回包必须作废，
  // 否则会把已关闭的弹层重新打开，或把 A 的详情盖到 B 上（issue #4 同类竞态）。
  const skillDetailSeq = useRef(0);
  const closeSkillDetail = () => {
    skillDetailSeq.current += 1;
    setSkillDetail(null);
  };
  // 社区详情若从弹层里点「加入 MCP」会先关掉自己再开 AddEditModal，两层不会叠加。
  const communityDetailRef = useRef(null);
  // 令牌 / 授权弹层可能叠在详情之上：此时只让上层陷阱接管 Tab，避免两层焦点陷阱互抢。
  useFocusTrap(connectorDetailRef, !!connectorDetail && !tokenDialog && !authDialog);
  useFocusTrap(skillDetailRef, !!skillDetail);
  useFocusTrap(communityDetailRef, !!communityDetail);
  const WB_PAGE_SIZE = 20;

  const loadInstalled = useCallback(async () => {
    const res = await call('wbSkillInstalled');
    if (res?.ok) setInstalledSkills(new Map((res.installed || []).map((row) => [skillInstalledKey(row), Math.max(0, Number(row.installedAt) || 0)])));
  }, [call]);

  // T04/R8：安装状态账本（三类安装的统一登记，宿主 ~/.dsh/armory/install-state.json）。
  // 与技能侧的 installedSkills 不同：这是**全量**集合，不受分页影响。
  const [installRecords, setInstallRecords] = useState([]);
  const loadInstallState = useCallback(async () => {
    try {
      const res = await call('wbInstallState');
      if (res?.ok) setInstallRecords(Array.isArray(res.items) ? res.items : []);
    } catch {
      // 安装状态是辅助信息，读失败不打断市场面板主流程。
      setInstallRecords([]);
    }
  }, [call]);
  const installedKeySet = (kind) => new Set(
    installRecords.filter((row) => row && row.kind === kind).map((row) => String(row.key || '')),
  );

  // P0：MCP 连接态。失败只清空（不显示健康徽标），绝不打断市场主流程——连接态是辅助信息。
  const loadMcpServerRows = useCallback(async () => {
    try {
      const res = await call('list');
      setMcpServerRows(Array.isArray(res?.servers) ? res.servers : []);
    } catch {
      setMcpServerRows([]);
    }
  }, [call]);

  const loadConnectors = useCallback(async () => {
    // P1-4 / P2-2：先铺快照（本次会话的内存镜像优先，其次 24h 内的 localStorage 镜像），
    // 再后台刷新。快照命中时不再进入骨架屏——用户第一眼就是列表。
    const cached = connectorCatalogMemo || readConnectorSnapshot();
    if (cached) {
      setConnectors(cached.connectors);
      setConnectorSource(cached.source || '');
      setLoading(false);
      setConnectorSettled(true);
    } else {
      setLoading(true);
    }
    setError(''); setNote('');
    try {
      const res = await call('wbConnectorCatalog');
      if (!res?.ok) throw new Error(res?.error || t('读取连接器目录失败'));
      const rows = res.connectors || [];
      setConnectors(rows);
      setConnectorSource(res.loadedFrom || '');
      connectorCatalogMemo = { connectors: rows, source: res.loadedFrom || '', at: Date.now() };
      const snapshotSig = rows.length + '|' + (res.loadedFrom || '') + '|'
        + rows.map((row) => row.id + ':' + (row.version || '') + ':' + (row.installable ? '1' : '0')).join(',');
      if (snapshotSig !== connectorSnapshotSigRef.current) {
        connectorSnapshotSigRef.current = snapshotSig;
        scheduleIdle(() => writeConnectorSnapshot({ connectors: rows, source: res.loadedFrom }), 5000);
      }
      // 目录快照只记「版本 + 可装性」这种稳定签名：星数 / 下载量波动不是「动静」。
      if (recordMarketSnapshot('connector', rows.map((row) => ({
        key: row.id, name: row.name, sig: String(row.version || '') + '|' + (row.installable ? '1' : '0'),
      })))) refreshPulse();
    } catch (e) {
      // 有快照时不拿错误条盖掉列表：列表还能用（只是可能过期），错误降级成一行提示。
      if (cached) setNote(t('刷新连接器目录失败，当前显示的是本机快照：{0}', [String(e?.message || e)]));
      else setError(String(e?.message || e));
    } finally {
      setLoading(false);
      // P1-1：连接器首屏已落地（成功或失败都算），后台预取可以排队了。
      setConnectorSettled(true);
    }
  }, [call, refreshPulse]);

  // 技能列表请求序号：搜索防抖与翻页会连发多个请求，慢的那个回来时不能盖掉新的结果。
  const skillSeq = useRef(0);
  const loadSkills = useCallback(async (page, sort, keyword) => {
    const seq = ++skillSeq.current;
    // P1-5：60 秒内的同参查询直接吃缓存（不占 SkillHub 配额、不闪 loading）。
    const cacheKey = page + '|' + sort + '|' + String(keyword || '');
    const cached = readSkillCache(cacheKey);
    if (cached) {
      setSkills(cached.skills);
      setSkillTotal(cached.total);
      if (!String(keyword || '').trim()) setSkillMarketTotal(cached.total);
      setSkillLoading(false);
      setSkillError('');
      return;
    }
    setSkillLoading(true); setSkillError('');
    try {
      const res = await call('wbSkillCatalog', { page, sort, keyword, pageSize: WB_PAGE_SIZE });
      if (seq !== skillSeq.current) return; // 过期响应，直接丢弃
      if (!res?.ok) throw new Error(res?.error || t('读取技能目录失败'));
      const rows = res.skills || [];
      setSkills(rows);
      setSkillTotal(res.total || 0);
      writeSkillCache(cacheKey, { skills: rows, total: res.total || 0 });
      if (!String(keyword || '').trim()) setSkillMarketTotal(res.total || 0);
      // 「最近动静」：技能是远程分页 + 服务端搜索，任何一次响应都只是 19 万库里的一个切片，
      // 切片之间互比等于自欺。只有**服务端全局排序**（最多安装 / 最多星标 / 综合评分）的
      // 无关键词首页才是稳定集合，才配当基线，并且基线按排序分档存（installs 的 Top20 和
      // stars 的 Top20 是两个集合，互比又会造出「全增全删」）。
      // 默认那档「下载量（本页排序）」不给上游发 sortBy，上游无 ORDER BY 的 LIMIT 20
      // 每次返回随机 20 条（2026-10-24 实测重合 0/20）——v1 就是把它当基线，才每次进市场
      // 刷出一对「新增 20 / 移除 20」，即用户报的「切换页面重新进入时重复读取」。
      const skillPulseBasis = page === 1 && !String(keyword || '').trim() && sort !== 'downloads'
        ? 'skill:' + sort
        : '';
      if (skillPulseBasis && recordMarketSnapshot('skill', rows.map((row) => ({
        key: row.namespace + '/' + row.slug, name: row.name, sig: String(row.version || ''),
      })), { basis: skillPulseBasis })) refreshPulse();
    } catch (e) {
      if (seq === skillSeq.current) setSkillError(String(e?.message || e));
    } finally {
      if (seq === skillSeq.current) setSkillLoading(false);
    }
  }, [call]);

  useEffect(() => {
    loadConnectors();
    loadInstalled();
    loadInstallState();
    loadMcpServerRows();
  }, [loadConnectors, loadInstalled, loadInstallState, loadMcpServerRows]);
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
  // T02/R2：visible_in 标签本地筛选。全集取自目录实际出现的标签（不发明筛选维度）；
  // 上游没标 visible_in 的行不受标签筛选（matchesVisibleIn 的空集语义）。
  const [visibleTagFilter, setVisibleTagFilter] = useState([]);
  const connectorVisibleTagUniverse = useMemo(() => {
    const counts = new Map();
    for (const item of connectors) {
      for (const tag of item.visibleIn || []) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([tag, count]) => ({ tag, count }));
  }, [connectors]);
  // T04/R8：已安装集合按 kind 取（全量，不受分页影响）。
  const installedConnectorKeys = installedKeySet('connector');
  const installedPluginKeys = installedKeySet('plugin');
  const filteredConnectors = connectors.filter((item) => {
    // T04/R8：只看已安装——用 item.id 匹配账本 key（安装时 key 就是 connectorId）。
    if (connectorOnlyInstalled && !installedConnectorKeys.has(String(item.id || ''))) return false;
    if (connectorOnlyReady && !item.installable) return false;
    if (!connectorMatchesVisibleIn(item.visibleIn, visibleTagFilter)) return false;
    if (!connectorQueryKey) return true;
    return [item.name, item.nameEn, item.id, item.description].filter(Boolean).join(' ').toLowerCase().includes(connectorQueryKey);
  });
  // T05/R10：排序在过滤之后、分页之前做——保证全量排序，翻页不会打乱顺序。
  const sortedConnectors = connectorSort === 'default' ? filteredConnectors : (() => {
    const rows = [...filteredConnectors];
    if (connectorSort === 'skills') {
      rows.sort((a, b) => (b.skillCount || 0) - (a.skillCount || 0) || String(a.name || '').localeCompare(String(b.name || '')));
    } else if (connectorSort === 'name') {
      rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    }
    return rows;
  })();
  const connectorPageCount = Math.max(1, Math.ceil(sortedConnectors.length / WB_MARKET_CONNECTOR_PAGE_SIZE));
  const safeConnectorPage = Math.min(connectorPage, connectorPageCount);
  const visibleConnectors = sortedConnectors.slice((safeConnectorPage - 1) * WB_MARKET_CONNECTOR_PAGE_SIZE, safeConnectorPage * WB_MARKET_CONNECTOR_PAGE_SIZE);

  // ── 社区 MCP：取数 / 游标翻页 ──
  // Registry 是游标分页、不返回总数，所以不用按总页数算的 Pager：页面只保留当前一页，
  // 「上一页 / 下一页」按游标栈跳转（第 N 页的游标 = 第 N-1 页返回的 nextCursor）。
  // 顶部数量显示的是本次查询「已读取的总数」（跨页累计去重），不是当前页条数。
  // 请求序号照 skillSeq，过期响应直接丢弃。
  // 页面卸载时清掉「加入后补刷」的定时器，避免对已卸载组件 setState。
  const communityDraftRefreshRef = useRef(null);
  // 连接器快照的签名：目录没变（条数 / 来源 / 每条的 id|version|installable）就不重写，
  // 也不在返回渲染的同一帧里做一次 769KB 序列化——写盘推到空闲帧（与插件快照同款）。
  const connectorSnapshotSigRef = useRef('');
  useEffect(() => () => { if (communityDraftRefreshRef.current) clearTimeout(communityDraftRefreshRef.current); }, []);
  // 离场时取消还在防抖窗口里的 hover 预取：晚到的预取只会白烧一次远程请求
  // （结果写进模块级 memo，但用户已经不在这个面板上了）。
  useEffect(() => () => cancelHoverPrefetch(), []);
  const communitySeq = useRef(0);
  const communityRowsRef = useRef([]);
  const communityQueryRef = useRef('');
  const communityLoadedQueryRef = useRef(null);
  const communityNamesRef = useRef([]);
  // 游标栈：cursors[0] 恒为 ''（第一页），cursors[n] = 第 n+1 页的游标。
  // 已读 key 集合与游标栈都按查询词隔离——换搜索词就从头开始。
  const communityCursorsRef = useRef([]);
  const communityReadKeysRef = useRef(new Set());
  const communityReadQueryRef = useRef(null);
  // 后台统计要让路给列表请求：循环里读到的是最新值，所以每次渲染同步一次。
  const communityLoadingRef = useRef(false);
  // 每次渲染同步最新值：loadCommunity 不把 rows/query/已装列表塞进依赖——
  // 否则 MCP 列表一刷新就重建回调，让防抖 / 懒加载 effect 误触发第二次请求。
  communityRowsRef.current = communityRows;
  communityLoadingRef.current = communityLoading;
  communityQueryRef.current = communityQuery;
  communityNamesRef.current = mcpServerRows.map((row) => String(row?.serverName || '')).filter(Boolean);

  const loadCommunity = useCallback(async ({ cursor = '', page = 1, query } = {}) => {
    const search = query === undefined ? communityQueryRef.current : String(query || '');
    const seq = ++communitySeq.current;
    setCommunityLoading(true);
    setCommunityError('');
    try {
      const res = await call('wbMcpCommunityList', {
        search,
        cursor,
        limit: COMMUNITY_BATCH_LIMIT,
        takenNames: communityNamesRef.current,
      });
      if (seq !== communitySeq.current) return; // 过期响应，直接丢弃
      if (!res?.ok) throw new Error(res?.error || t('读取社区 MCP 失败'));
      // 新查询：游标栈与已读计数一起归零（同一个词的来回翻页则保留累计）。
      if (communityReadQueryRef.current !== search) {
        communityReadQueryRef.current = search;
        communityReadKeysRef.current = new Set();
        communityCursorsRef.current = [];
      }
      const incoming = Array.isArray(res.rows) ? res.rows.filter(Boolean) : [];
      const unique = [];
      const seen = new Set();
      for (const row of incoming) {
        if (!row?.key || seen.has(row.key)) continue;
        seen.add(row.key);
        unique.push(row);
      }
      setCommunityRows(unique);
      setCommunityPage(page);
      setCommunityNextCursor(res.nextCursor || null);
      setCommunityStale(res.cached === true);
      communityCursorsRef.current[page - 1] = String(cursor || '');
      communityCursorsRef.current[page] = res.nextCursor ? String(res.nextCursor) : '';
      for (const row of unique) communityReadKeysRef.current.add(row.key);
      setCommunityReadTotal(communityReadKeysRef.current.size);
      communityLoadedQueryRef.current = search;
    } catch (e) {
      if (seq !== communitySeq.current) return;
      setCommunityError(String(e?.message || e));
      // 上次结果还在内存里就保留并标「缓存结果」；否则列表保持为空、只显示错误行。
      if (communityRowsRef.current.length) setCommunityStale(true);
      // 失败不算「这个词已经加载过」：切回来 / 重试时应重新请求。
      communityLoadedQueryRef.current = null;
    } finally {
      if (seq === communitySeq.current) setCommunityLoading(false);
    }
  }, [call]);

  // 社区搜索：输入即搜（服务端 search），500ms 防抖合并连击；回车立即搜。
  useEffect(() => {
    const timer = setTimeout(() => setCommunityQuery(communityQueryInput.trim()), 500);
    return () => clearTimeout(timer);
  }, [communityQueryInput]);

  // 懒加载：首次切到社区、或换搜索词才发请求；切回 WB 不卸载任何状态（列表/搜索词原样保留）。
  useEffect(() => {
    if (connectorFeed !== 'community') return;
    // 只看「这个词是否成功加载过」：空结果是合法结果，不能因为 length=0 每次切回来都重发。
    if (communityLoadedQueryRef.current === communityQuery) return;
    loadCommunity({ cursor: '' });
  }, [connectorFeed, communityQuery, loadCommunity]);

  // ── 社区目录全库总数：有界、可续爬的后台统计 ──
  // 进连接器页 + 停在社区源时才开，而且先用 scheduleIdle 让列表请求走前面；然后一块一块数
  // （每块 3 页），本次会话最多 12 页 —— 全库实测 ≥13,000 条，一次爬完要十几分钟和约 9MB，
  // 不能占住用户的网络。每数完一块立刻落盘并更新徽标，所以用户看到的是数字在慢慢长准。
  // 上游失败就保住已数到的部分直接收工（不重试、不清进度），下次进面板从记录的游标接着来。
  useEffect(() => {
    if (tab !== 'connector' || connectorFeed !== 'community') return undefined;
    let cancelled = false;
    let pauseTimer = null;
    const runChunks = async () => {
      if (cancelled || communityCountBusyRef.current) return; // 同一面板里只允许一条统计流水
      communityCountBusyRef.current = true;
      try {
        while (!cancelled && communityCountPagesRef.current < COMMUNITY_COUNT_PAGE_BUDGET) {
          const record = communityCountRef.current || emptyCommunityCount();
          if (record.done) break;
          const res = await call('wbMcpCommunityCount', {
            cursor: record.cursor || '',
            pages: Math.min(COMMUNITY_COUNT_CHUNK_PAGES, COMMUNITY_COUNT_PAGE_BUDGET - communityCountPagesRef.current),
          });
          if (cancelled) break; // 面板已切走 / 卸载：结果不要，进度也不回滚
          if (!res || res.ok !== true) break;
          const done = res.done === true;
          const next = {
            counted: record.counted + Math.max(0, Number(res.counted) || 0),
            // 数到底就不留游标，避免下次又误以为"还有活要干"。
            cursor: done ? '' : String(res.nextCursor || record.cursor || ''),
            done,
            at: Date.now(),
          };
          communityCountPagesRef.current += Math.max(1, Number(res.pages) || 1);
          communityCountRef.current = next; // 不等 re-render：下一块必须用最新游标
          setCommunityCount(next);
          writeCommunityCount(next);
          if (done) break;
          // 列表请求在飞就多让一拍；没在飞也歇一下，别把公共 API 当自家目录连着打。
          await new Promise((resolve) => {
            pauseTimer = setTimeout(resolve, communityLoadingRef.current ? 1500 : 400);
          });
        }
      } catch { /* 徽标那枚数字而已：任何异常都不该把社区列表带崩 */ }
      finally { communityCountBusyRef.current = false; }
    };
    const cancelIdle = scheduleIdle(runChunks, 3000);
    return () => { cancelled = true; if (pauseTimer) clearTimeout(pauseTimer); cancelIdle(); };
  }, [tab, connectorFeed, call]);

  const communityVisibleRows = communityOnlyRunnable ? communityRows.filter((row) => row.runnable) : communityRows;
  const communityHiddenCount = communityRows.length - communityVisibleRows.length;
  // 上一页的游标来自游标栈（第 N-1 页的入口游标）；第 1 页没有上一页。
  const communityPrevCursor = communityPage > 1 ? (communityCursorsRef.current[communityPage - 2] || '') : null;
  // 「已加入」只按 serverName 命中现有 MCP 列表：社区条目没有 WorkBuddy 代注入，
  // 不存在「已安装 · 需授权」这种工作流。
  // 「已加入」比的是**原始名**，不是带冲突后缀的预填名（baseServerName，见 lib/mcp-community.js）。
  // 用 serverName 比是死锁：装完 adeu 之后 taken 里就有 adeu，下一轮列表把这条预填成 adeu-2，
  // adeu-2 永远不等于任何已装名 → 徽标与按钮禁用一起失效，用户以为没装、再点一次装出第二条。
  const communityJoined = (row) => {
    const base = String(row?.baseServerName || row?.serverName || '');
    const prefill = String(row?.serverName || '');
    if (!base) return false;
    return mcpServerRows.some((server) => {
      const installed = String(server?.serverName || '');
      return installed === base || installed === prefill;
    });
  };

  // 「加入 MCP」= 预填草稿，用户在弹层里确认后才由宿主写盘（与连接器一键安装不同语义）。
  const openCommunityDraft = (row) => {
    const env = {};
    for (const item of row.env || []) env[item.name] = item.hasDefault ? item.default : '';
    setCommunityDraft({
      serverName: row.serverName,
      transport: row.transport === 'http' ? 'http' : 'stdio',
      url: row.remoteUrl || '',
      command: row.command || '',
      args: Array.isArray(row.args) ? row.args : [],
      env,
      // 必填环境变量只用于弹层内的温和提示（允许提交：有些值允许运行时兜底）。
      requiredEnv: (row.env || []).filter((item) => item.required).map((item) => item.name),
    });
  };
  const submitCommunityDraft = async (spec, setFormError) => {
    setBusy(true);
    // 进度浮层：写盘 + 宿主自动连接这两段都在 RPC 之后才发生，弹层一关就没了现场。
    // key 带动作前缀，重连同一台服务器不会顶掉这条「加入」行（也不是插件名，不参与按钮禁用）。
    const taskKey = spec?.name ? 'mcp:add:' + String(spec.name) : '';
    progressToastStart(taskKey, spec?.name, PROGRESS_GROUP_MCP, MCP_ADD_TASK_LABELS);
    try {
      const res = await call('add', spec);
      if (res && res.ok) {
        setCommunityDraft(null);
        setNote(t('已加入 ') + spec.name);
        progressToastFinish(taskKey, 'ok');
        // 宿主写盘后列表刷新有一拍延迟：先立即刷一次，再补一次让「已加入」稳定亮起。
        loadMcpServerRows();
        communityDraftRefreshRef.current = setTimeout(() => { loadMcpServerRows(); }, 1200);
      } else {
        setFormError((res && res.error) || t('添加失败'));
        progressToastFinish(taskKey, 'fail');
      }
    } catch (e) {
      setFormError(String(e?.message || e));
      progressToastFinish(taskKey, 'fail');
    } finally {
      setBusy(false);
    }
  };

  // P0：连接器卡的真实健康度。只认 list() 里的同名 server（serverNames 来自 mcp.json）：
  //   connected 至少一条已注册工具；auth 有 server 报 401/403 类失败；failed 其余失败。
  // 找不到同名行一律 unknown——连接器可能装在别的 profile / 别的会话里，不能拿「没搜到」冒充「没连上」。
  const mcpRowByName = useMemo(
    () => new Map(mcpServerRows.map((row) => [String(row?.serverName || ''), row])),
    [mcpServerRows],
  );
  const connectorServerRows = (item) => (Array.isArray(item?.serverNames) ? item.serverNames : [])
    .map((name) => mcpRowByName.get(String(name)))
    .filter(Boolean);
  const connectorHealth = (item) => {
    const rows = connectorServerRows(item);
    if (!rows.length) return 'unknown';
    if (rows.some((row) => row.status === 'connected')) return 'connected';
    if (rows.some((row) => row.authRequired)) return 'auth';
    return 'failed';
  };
  // 卡片右上角徽标：安装账本只说明「写进过配置」，健康度说明「现在到底能不能用」。
  const connectorBadge = (item) => {
    if (installedConnectorKeys.has(String(item.id || ''))) {
      const health = connectorHealth(item);
      if (health === 'connected') return h(Badge, { cls: 's-on', title: t('服务器已连接并注册了工具') }, t('已安装 · 已连接'));
      if (health === 'auth') return h(Badge, { cls: 's-warn', title: t('服务器返回 401/403 类鉴权失败，重连不会恢复，需要重新授权') }, t('已安装 · 需授权'));
      if (health === 'failed') return h(Badge, { cls: 's-err', title: t('配置已写入，但服务器当前没有连上（点「重连」再试）') }, t('已安装 · 未连接'));
      return h(Badge, { cls: 's-on', title: t('已写入 MCP 配置') }, t('已安装'));
    }
    return h(Badge, { cls: item.installable ? 's-on' : '' }, item.installable ? t('可安装') : t('仅展示'));
  };

  // P2-3：hover 预取。连接器详情真正要显示的是授权概览（openConnectorDetail 只调
  // wbOAuthOverview），未安装的连接器没有这项数据，预取只会白跑一次 IPC —— 直接跳过。
  const prefetchConnectorDetail = (item) => {
    const key = String(item?.id || '');
    if (!key || !installedConnectorKeys.has(key)) return;
    if (readDetailMemo(hoverMemo.connectorAuth, key)) return; // 已有可用的回包，不再发
    scheduleHoverPrefetch(() => {
      call('wbOAuthOverview', { connectorId: item.id })
        .then((res) => { if (res) writeDetailMemo(hoverMemo.connectorAuth, key, res); })
        .catch(() => { /* 预取失败留给点开时的正式请求报错 */ });
    });
  };

  const openConnectorDetail = async (item) => {
    setConnectorDetail(item);
    connectorDetailIdRef.current = String(item?.id || '');
    setNote('');
    setConnectorAuth(null);
    if (!installedConnectorKeys.has(String(item?.id || ''))) return;
    const memoKey = String(item.id);
    const precached = readDetailMemo(hoverMemo.connectorAuth, memoKey);
    if (precached) { setConnectorAuth({ loading: false, ...precached }); return; }
    setConnectorAuth({ loading: true });
    try {
      const res = await call('wbOAuthOverview', { connectorId: item.id });
      // 用户可能已经关了弹层 / 换了另一条：迟到的回包不写回界面。
      if (connectorDetailIdRef.current !== String(item.id)) return;
      if (res) writeDetailMemo(hoverMemo.connectorAuth, memoKey, res);
      setConnectorAuth(res ? { loading: false, ...res } : { loading: false });
    } catch {
      if (connectorDetailIdRef.current === String(item.id)) setConnectorAuth({ loading: false, error: t('读取授权状态失败') });
    }
  };
  // P0：已安装但连不上的入口。鉴权失败走「重新授权」，其余走「重连」——两条路都不该让用户
  // 滚回 MCP 面板自己找。
  const reconnectConnector = async (item) => {
    if (!item) return;
    const rows = connectorServerRows(item);
    const authRow = rows.find((row) => row.authRequired);
    if (authRow) { await beginConnectorAuth(item, authRow.serverName); return; }
    setBusy(true); setBusyLabel(t('正在重连…')); setError('');
    // 与「加入 MCP」同一枚进度浮层（顶部、跨面板卸载存活）：重连是逐台串行的，
    // 一台一行，用户切走再回来还能看到到底哪台在跑、哪台没成。
    const serverNames = Array.isArray(item.serverNames) ? item.serverNames : [];
    const taskKeys = new Map();
    for (const name of serverNames) {
      const key = 'mcp:reconnect:' + String(name);
      taskKeys.set(String(name), key);
      progressToastStart(key, String(name), PROGRESS_GROUP_MCP, MCP_RECONNECT_TASK_LABELS);
    }
    try {
      let lastNote = '';
      const failed = [];
      for (const name of serverNames) {
        const res = await call('reconnect', String(name));
        // call() 把宿主失败收敛成 {ok:false, error}，这里必须看 ok，否则一条都没连上也会
        // 显示「已请求重连」。
        if (res && res.ok === false) {
          failed.push(name + ': ' + (res.error || t('调用失败')));
          progressToastFinish(taskKeys.get(String(name)), 'fail');
          continue;
        }
        lastNote = res?.note || lastNote;
        progressToastFinish(taskKeys.get(String(name)), 'ok');
      }
      if (failed.length) setError(t('{0}：{1}', [item.name, failed.join('; ')]));
      else setNote(t('{0}：{1}', [item.name, lastNote || t('已请求重连')]));
      await loadMcpServerRows();
    } catch (e) {
      setError(String(e?.message || e));
      for (const key of taskKeys.values()) progressToastFinish(key, 'fail');
    } finally {
      setBusy(false); setBusyLabel('');
    }
  };
  // ── R8：连接器 OAuth 授权 ────────────────────────────────────────────────
  // 宿主探测到 401 会回传 needsAuth，这里把它变成「打开浏览器 → 等回调 → 自动重装」。
  // 服务器只认自定义 scheme 回调（如 workbuddy://）时浏览器跳不过去，就走
  // manual-callback：让用户把地址栏里那条 URL 粘回来，等价于把 code 交给宿主。
  const stopAuthPoll = () => {
    if (authPollRef.current) {
      clearTimeout(authPollRef.current);
      authPollRef.current = null;
    }
  };
  const closeAuthDialog = async () => {
    stopAuthPoll();
    const sessionId = authDialogRef.current?.sessionId;
    setAuthDialog(null);
    if (sessionId) {
      try { await call('wbOAuthCancel', { sessionId }); } catch { /* 会话已结束，忽略 */ }
    }
  };
  const finishConnectorAuth = async (item) => {
    stopAuthPoll();
    setAuthDialog(null);
    if (!item) return;
    // 授权成功后立刻重装：宿主会把已存储的 token 注进 headers 再探测，这一步不会再 401。
    setNote(t('{0}：授权成功，正在完成安装…', [item.name]));
    await installConnector(item);
  };
  const pollAuthOnce = async (sessionId) => {
    let res;
    try {
      res = await call('wbOAuthPoll', { sessionId });
    } catch {
      res = null;
    }
    // 用户中途关掉弹窗/换了会话，就别再把状态写回界面。
    if (authDialogRef.current?.sessionId !== sessionId) return;
    if (res?.status === 'authorized') {
      await finishConnectorAuth(authDialogRef.current?.item);
      return;
    }
    if (res?.status === 'failed') {
      stopAuthPoll();
      setAuthDialog((cur) => (cur && cur.sessionId === sessionId
        ? { ...cur, status: 'failed', error: res.error || t('授权失败') }
        : cur));
      return;
    }
    authPollRef.current = setTimeout(() => { pollAuthOnce(sessionId); }, 1500);
  };
  const beginConnectorAuth = async (item, serverName) => {
    setError('');
    setBusy(true); setBusyLabel(t('正在启动授权…'));
    try {
      const res = await call('wbOAuthBegin', { connectorId: item.id, serverName });
      if (!res?.ok) {
        // 授权页这条路走不通（服务器不做 OAuth 发现、动态注册被拒、要求客户端认证）时，
        // 不能只甩一行红字就把用户关在门外：手填令牌那条兜底路还在，把弹层开出来摊给他。
        if (res?.manualTokenOnly) {
          // 用户要的是「点安装就给我一个能填凭据的窗口」。无论有没有 ${...} 槽位，都在这里
          // 直接开手填令牌弹层——有令牌的人能立刻装，没有的人也能看清需要什么，不再把卡片
          // 降级成「需 WorkBuddy 账号授权」把入口收走。
          setAuthDialog({
            item,
            serverName: res.serverName || serverName || item.name,
            sessionId: '',
            authorizeUrl: '',
            mode: 'manual-token',
            redirectUri: '',
            hint: '',
            status: 'manual',
            error: res.error || t('该服务器无法自动打开授权页。'),
            callbackUrl: '',
            manualToken: '',
          });
          return;
        }
        throw new Error(res?.error || t('无法启动授权流程'));
      }
      setAuthDialog({
        item,
        serverName: res.serverName || serverName || item.name,
        sessionId: res.sessionId,
        authorizeUrl: res.authorizeUrl,
        mode: res.mode,
        redirectUri: res.redirectUri,
        hint: res.hint || '',
        status: 'pending',
        error: res.opened ? '' : t('没能自动唤起浏览器，请复制下方链接手动打开。'),
        callbackUrl: '',
        manualToken: '',
      });
      // 宿主第一条打开通路（shell / rundll32）失败时立即补一发 wbOAuthOpen 再试一次：
      // 多数失败是瞬时抖动，同一 URL 重开往往就成功了；补开成功就撤掉"没能唤起浏览器"
      // 的提示回到纯等待态，仍失败则弹层里的链接与「重新打开浏览器」按钮还在。
      if (!res.opened && res.authorizeUrl) {
        call('wbOAuthOpen', { url: res.authorizeUrl }).then((openRes) => {
          if (openRes?.opened && authDialogRef.current?.sessionId === res.sessionId) {
            setAuthDialog((cur) => (cur && cur.sessionId === res.sessionId ? { ...cur, error: '' } : cur));
          }
        }).catch(() => {});
      }
      if (res.sessionId) {
        stopAuthPoll();
        authPollRef.current = setTimeout(() => { pollAuthOnce(res.sessionId); }, 1200);
      }
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false); setBusyLabel('');
    }
  };
  const submitAuthCallback = async () => {
    const current = authDialogRef.current;
    if (!current) return;
    const url = String(current.callbackUrl || '').trim();
    if (!url) return;
    setBusy(true); setBusyLabel(t('正在校验回调…'));
    try {
      const res = await call('wbOAuthPoll', { sessionId: current.sessionId, callbackUrl: url });
      if (res?.status === 'authorized') {
        await finishConnectorAuth(current.item);
        return;
      }
      stopAuthPoll();
      setAuthDialog((cur) => (cur ? { ...cur, status: 'failed', error: res?.error || t('回调地址无效，请重新授权。') } : cur));
    } catch (e) {
      setAuthDialog((cur) => (cur ? { ...cur, status: 'failed', error: String(e?.message || e) } : cur));
    } finally {
      setBusy(false); setBusyLabel('');
    }
  };
  const submitAuthToken = async () => {
    const current = authDialogRef.current;
    if (!current) return;
    const token = String(current.manualToken || '').trim();
    if (!token) return;
    setBusy(true); setBusyLabel(t('正在保存令牌…'));
    try {
      const res = await call('wbOAuthToken', { connectorId: current.item.id, serverName: current.serverName, token });
      if (!res?.ok) throw new Error(res?.error || t('保存失败'));
      await finishConnectorAuth(current.item);
    } catch (e) {
      setAuthDialog((cur) => (cur ? { ...cur, error: String(e?.message || e) } : cur));
    } finally {
      setBusy(false); setBusyLabel('');
    }
  };
  useEffect(() => () => { stopAuthPoll(); }, []);
  // 「我有令牌」入口：详情里给需要授权的连接器开一扇门，已持有服务方令牌的人
  // 不必等浏览器授权发现失败，直接粘贴即可走同一条落盘 + 安装链路。
  const openManualTokenDialog = (item) => {
    if (!item) return;
    stopAuthPoll();
    setError('');
    setAuthDialog({
      item,
      serverName: (Array.isArray(item.serverNames) ? item.serverNames[0] : '') || item.name,
      sessionId: '',
      authorizeUrl: '',
      mode: 'manual-token',
      redirectUri: '',
      hint: '',
      status: 'manual',
      error: '',
      callbackUrl: '',
      manualToken: '',
    });
  };
  // P0：强制刷新已存令牌 → 再装一次把新凭据写回 headers（mcp-client 只在建连时快照 headers）。
  // 刷不动就回到浏览器授权，不留「刷新失败」的死胡同。
  const refreshConnectorAuth = async (item) => {
    if (!item) return;
    setBusy(true); setBusyLabel(t('正在刷新授权…')); setError('');
    try {
      const res = await call('wbOAuthRefresh', { connectorId: item.id });
      if (!res?.ok) {
        if (res?.needsAuth) {
          await beginConnectorAuth(item);
          return;
        }
        throw new Error(res?.error || t('刷新授权失败'));
      }
      setNote(t('{0}：授权已刷新，正在把新凭据写回配置…', [item.name]));
      await installConnector(item);
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false); setBusyLabel('');
    }
  };
  const installConnector = async (item, tokens = null) => {
    setBusy(true); setBusyLabel(t('正在安装 {0}…', [item.name])); setError('');
    try {
      // T04/R7：只把用户明确填写的槽位透传给宿主，未填的槽位由宿主保留原占位符
      // 并通过 missingSlots 回传——面板负责提示，绝不代填。
      const payload = { connectorId: item.id, mode: 'merge' };
      if (tokens && typeof tokens === 'object' && Object.keys(tokens).length) payload.tokens = tokens;
      const res = await call('wbConnectorInstall', payload);
      if (!res?.ok) {
        // R8：401 不再当作安装失败。宿主回传 needsAuth 时弹授权框，授权完成后
        // finishConnectorAuth 会重新调用本函数，此时 token 已落盘可径直装上。
        const needsAuth = Array.isArray(res?.needsAuth) ? res.needsAuth : [];
        if (needsAuth.length) {
          setTokenDialog(null);
          stopAuthPoll();
          await beginConnectorAuth(item, needsAuth[0]?.serverName);
          return;
        }
        // issue #3：本地客户端型连接器（如 NVIDIA App）依赖固定路径的本机程序。缺程序时
        // 宿主连 10 次才放弃，用户只看得到「mcp 连接失败」；这里在安装前就把缺失路径说清楚。
        const localMissing = Array.isArray(res?.localMissing) ? res.localMissing : [];
        const localUnsupported = Array.isArray(res?.localUnsupported) ? res.localUnsupported : [];
        if (localMissing.length) {
          throw new Error(t('本机没有找到该连接器依赖的程序：{0}。请先安装对应客户端并开启它的 MCP / 集成访问后重试。', [localMissing.join(t('、'))]));
        }
        if (localUnsupported.length) {
          throw new Error(t('该连接器依赖本机程序，但当前系统不支持：{0}', [localUnsupported.join(t('、'))]));
        }
        throw new Error(res?.error || t('安装失败'));
      }
      const missing = Array.isArray(res?.missingSlots) ? res.missingSlots : [];
      const localDeps = Array.isArray(res?.localDeps) ? res.localDeps : [];
      const baseNote = t('{0}：{1}', [item.name, res.note || t('已写入 MCP 配置')])
        + (localDeps.some((dep) => dep.status === 'found')
          ? ' ' + t('本机依赖已找到；若连接失败，请确认对应客户端正在运行并已开启 MCP / 集成访问。')
          : '');
      setNote(missing.length
        ? baseNote + ' ' + t('另有 {0} 个占位符未填写，配置里保留原样，可用前请补全。', [missing.length])
        : baseNote);
      setTokenDialog(null);
      setConnectorDetail(null);
      await loadConnectors();
      await loadInstallState();
      // 新写入的 server 要等宿主建连才有工具：这里刷新一次投影，卡片不会停在「未连接」。
      await loadMcpServerRows();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false); setBusyLabel('');
    }
  };
  // T04/R7：安装入口。目录条目声明了 needsTokens 就先弹窗收令牌，否则直接装。
  // R8：needsOAuth 的连接器也走同一条路——宿主已存 token 就直接装，没存会回传
  // needsAuth 并把流程转到授权弹窗，所以这里不需要额外分支。
  const requestInstallConnector = (item) => {
    if (!item) return;
    if (item.needsTokens) {
      setError('');
      setTokenDialog({ item, values: {} });
      return;
    }
    installConnector(item);
  };
  const skillInstallInFlight = useRef(new Set());
  const installSkill = async (skill) => {
    // 同一技能的上一次安装还在飞时直接挡回：宿主侧已有按目录的互斥锁兜底串行，
    // 这里再挡一层是为了不给用户制造「点了两次、两次都报成功」的错觉。
    const flightKey = skillInstalledKey(skill);
    if (skillInstallInFlight.current.has(flightKey)) {
      setNote(t('该技能正在安装中，请等当前任务结束'));
      return;
    }
    skillInstallInFlight.current.add(flightKey);
    setBusy(true); setBusyLabel(t('正在下载并校验 {0}…', [skill.name])); setError('');
    try {
      const res = await call('wbSkillInstall', { slug: skill.slug, namespace: skill.namespace, name: skill.name });
      if (!res?.ok) throw new Error(res?.error || t('安装失败'));
      setNote(t('{0}：{1}', [skill.name, res.note || t('已安装')]));
      closeSkillDetail();
      // 磁盘上的 skill 集合已经变了：广播出去，顶部分类计数与（切回时的）Skill 看板
      // 立即按新集合重算，不再等用户离开看板/重挂载。市场自己的列表照旧局部刷新。
      emitSkillChange('market-install');
      await loadInstalled();
      await loadInstallState();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      skillInstallInFlight.current.delete(flightKey);
      setBusy(false); setBusyLabel('');
    }
  };
  const uninstallSkill = async (skill) => {
    setBusy(true); setBusyLabel(t('正在卸载 {0}…', [skill.name])); setError('');
    try {
      const res = await call('wbSkillUninstall', { slug: skill.slug, namespace: skill.namespace });
      if (!res?.ok) throw new Error(res?.error || t('卸载失败'));
      setNote(t('{0}：{1}', [skill.name, res.note || t('已卸载')]));
      closeSkillDetail();
      emitSkillChange('market-uninstall');
      await loadInstalled();
      await loadInstallState();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false); setBusyLabel('');
    }
  };
  // P2-3：hover 预取技能详情。命中缓存就什么都不发；同一条结果点开时直接复用。
  const prefetchSkillDetail = (skill) => {
    const key = skillDetailMemoKey(skill);
    if (!skill?.slug || !skill?.namespace) return;
    if (readDetailMemo(hoverMemo.skillDetail, key)) return;
    scheduleHoverPrefetch(() => {
      call('wbSkillDetail', { slug: skill.slug, namespace: skill.namespace })
        .then((res) => { if (res?.ok) writeDetailMemo(hoverMemo.skillDetail, key, res); })
        .catch(() => { /* 预取失败留给点开时的正式请求报错 */ });
    });
  };
  const openSkillDetail = async (skill) => {
    const seq = ++skillDetailSeq.current;
    const memoKey = skillDetailMemoKey(skill);
    const precached = readDetailMemo(hoverMemo.skillDetail, memoKey);
    setNote('');
    if (precached) {
      // 预取的就是这一条：省掉 loading 闪烁与一次往返。
      setSkillDetail({ ...mergeSkillDetail(skill, precached), loading: false });
      return;
    }
    setSkillDetail({ ...skill, loading: true });
    try {
      const res = await call('wbSkillDetail', { slug: skill.slug, namespace: skill.namespace });
      if (seq !== skillDetailSeq.current) return; // 已关闭 / 已改点另一条
      if (!res?.ok) throw new Error(res?.error || t('读取详情失败'));
      writeDetailMemo(hoverMemo.skillDetail, memoKey, res);
      // 回包里的空串不能覆盖列表项已有的中文名 / 介绍（issue #4）。
      setSkillDetail({ ...mergeSkillDetail(skill, res), loading: false });
    } catch (e) {
      if (seq !== skillDetailSeq.current) return;
      setSkillDetail({ ...skill, loading: false, detailError: String(e?.message || e) });
    }
  };

  // 插件安装走宿主的 pluginManager.installBundle(spec, {}) 严格双参（少传第二个会被
  // wire 拒绝，见本文件 runUpgrade 的踩坑注释）；装完宿主进程不热载新包，必须重启 DSH
  // 才生效——提示条 state 常驻（不写 localStorage，本次会话内不消失）。
  const [restartNotice, setRestartNotice] = useState('');
  // T06/Awesome：DSH 社区插件市场（awesome-dsh-plugins）状态机与数据接入。
  // 插件页只有这一个来源；首屏快照见下方 awesomeSnapshotRef。
  // P1-3：快照懒读。旧实现在市场每次挂载时就把上次的快照 JSON.parse 一遍（2.98MB 目录
  // 约 100ms 主线程），而默认落地页是「连接器」——绝大多数会话根本不会看插件页。
  // 现在首帧给空数组，用户真切到插件 tab 时才 hydrate（见 switchTab / hydrateAwesomeFromSnapshot）。
  // 写侧也改成「签名变了才写 + idle 写」：目录没变就不必再序列化 3MB。
  const awesomeSnapshotRef = useRef(undefined);
  if (awesomeSnapshotRef.current === undefined && !MARKET_PERF.awesomeSnapshotLazy) {
    awesomeSnapshotRef.current = readAwesomeSnapshot();
  }
  const [awesomePlugins, setAwesomePlugins] = useState(() => {
    const snapshot = awesomeSnapshotRef.current;
    return snapshot ? snapshot.plugins.map((item) => ({ ...item, marketplace: snapshot.marketplace || 'awesome-dsh-plugins' })) : [];
  });
  const [awesomeLoading, setAwesomeLoading] = useState(false);
  const [awesomeError, setAwesomeError] = useState('');
  const [awesomeUpdateHint, setAwesomeUpdateHint] = useState(null);
  const [awesomeStale, setAwesomeStale] = useState(false);
  const [awesomeQuery, setAwesomeQuery] = useState('');
  const [awesomeCategory, setAwesomeCategory] = useState('all');
  const [awesomeTags, setAwesomeTags] = useState([]);
  const [awesomeSort, setAwesomeSort] = useState('stars');
  const [awesomePage, setAwesomePage] = useState(1);
  const [awesomeOnlyInstalled, setAwesomeOnlyInstalled] = useState(false);
  // 静默预取失败时用来判断「有没有快照可留」：有快照就不弹错误条。
  const awesomeLenRef = useRef(awesomePlugins.length);
  useEffect(() => { awesomeLenRef.current = awesomePlugins.length; }, [awesomePlugins.length]);
  // P1-3：切到插件页时才读快照（0 网络、0 IPC，只是把 JSON.parse 推到真正需要它的时刻）。
  // 只 hydrate 一次：真实目录回来后再切回来不该被旧快照盖掉（setAwesomePlugins 前判空）。
  const hydrateAwesomeFromSnapshot = useCallback(() => {
    if (!MARKET_PERF.awesomeSnapshotLazy) return;
    if (awesomeSnapshotRef.current !== undefined) return;
    const snapshot = readAwesomeSnapshot();
    awesomeSnapshotRef.current = snapshot || null;
    if (!snapshot) return;
    setAwesomePlugins((prev) => (prev.length ? prev : snapshot.plugins.map((item) => ({
      ...item,
      marketplace: snapshot.marketplace || 'awesome-dsh-plugins',
    }))));
  }, []);
  // P1-3：上次写进 localStorage 的目录签名。签名没变就不重写（3MB 序列化 + 落盘）。
  const awesomeSnapshotSigRef = useRef('');
  // 所有「切到插件 tab」的入口都走这里：先补快照，再切页（React 同一批更新里渲染）。
  const switchTab = useCallback((next) => {
    if (next === 'plugin') hydrateAwesomeFromSnapshot();
    setTab(next);
  }, [hydrateAwesomeFromSnapshot]);
  // 「最近动静」的跳转动作：先按 marketFullScope 的口径把目标页签重置回全量，再切页签。
  // 只在用户点条目时执行，不影响正常的页签切换（后者保留用户的搜索 / 筛选 / 页码）。
  const applyFullMarket = (next) => {
    const patch = marketFullScope(next);
    if (!patch) return;
    if (patch.expertRemount) {
      // 专家页内部状态（搜索 / 分类 / 页码）只能靠重挂回到默认；不动其它三页签。
      setExpertEpoch((value) => value + 1);
      return;
    }
    if ('connectorFeed' in patch) {
      setConnectorFeed(patch.connectorFeed);
      setConnectorQuery(patch.connectorQuery);
      setConnectorOnlyReady(patch.connectorOnlyReady);
      setConnectorOnlyInstalled(patch.connectorOnlyInstalled);
      setConnectorSort(patch.connectorSort);
      setConnectorPage(patch.connectorPage);
    }
    if ('skillKeyword' in patch) {
      setSkillKeyword(patch.skillKeyword);
      setSkillKeywordInput(patch.skillKeywordInput);
      setSkillSort(patch.skillSort);
      setSkillOnlyInstalled(patch.skillOnlyInstalled);
      setSkillPage(patch.skillPage);
    }
    if ('awesomeQuery' in patch) {
      setAwesomeQuery(patch.awesomeQuery);
      setAwesomeCategory(patch.awesomeCategory);
      setAwesomeTags(patch.awesomeTags);
      setAwesomeSort(patch.awesomeSort);
      setAwesomeOnlyInstalled(patch.awesomeOnlyInstalled);
      setAwesomePage(patch.awesomePage);
    }
  };
  const loadAwesomeCatalog = useCallback(async (refresh = false, silent = false) => {
    setAwesomeLoading(true); setAwesomeError('');
    try {
      const res = await call('wbAwesomeCatalog', refresh ? { refresh: true } : {});
      if (!res?.ok) throw new Error(res?.error || t('读取插件目录失败'));
      setAwesomeStale(Boolean(res.stale));
      // 响应级 marketplace 标记统一贴到每条记录上（「只看已安装」按 source.marketplace 归账）。
      const marketplace = res.marketplace || 'awesome-dsh-plugins';
      const catalog = (res.plugins || []).map((item) => ({ ...item, marketplace }));
      setAwesomePlugins(catalog);
      // 「最近动静」：只对比新增 / 移除 / 版本或核验状态变化。星数不进签名（每天波动属噪音）。
      if (recordMarketSnapshot('awesome', catalog.map((item) => ({
        key: item.name,
        name: item.name,
        sig: String(item.version || '') + '|' + String(item.verifiedAgainst || '') + '|' + String(item.status || ''),
      })))) refreshPulse();
      // 顺手把这次的目录留成下次的首屏快照：签名没变就不重写（省一次 3MB 序列化 + 落盘），
      // 写盘也推到空闲帧，不与这次渲染抢主线程（写失败静默，不影响本次渲染）。
      const snapshotSig = catalog.length + '|' + (res.fetchedAt || '') + '|' + marketplace;
      if (snapshotSig !== awesomeSnapshotSigRef.current) {
        awesomeSnapshotSigRef.current = snapshotSig;
        scheduleIdle(() => writeAwesomeSnapshot({ plugins: catalog, marketplace, fetchedAt: res.fetchedAt }), 5000);
      }
    } catch (e) {
      // 静默预取失败且已有快照 → 保留旧目录；没有快照才让错误条接管。
      if (!silent || awesomeLenRef.current === 0) setAwesomeError(String(e?.message || e));
    } finally {
      setAwesomeLoading(false);
    }
  }, [call]);
  // 探测节流 6 小时；force=true（用户点「重新加载」）跳过节流立即重探。
  // 注意：时间戳只在真的发起探测时写，否则每次挂载都会把闸门往后推、探测永不再跑。
  const checkAwesomeUpdate = useCallback(async (force = false) => {
    if (!force && Date.now() - readAwesomeProbeAt() < AWESOME_PROBE_INTERVAL_MS) return;
    writeAwesomeProbeAt(Date.now());
    try {
      const res = await call('wbAwesomeUpdateCheck');
      // probe-failed 是环境性的瞬时失败（源不可达 / 超时 / HEAD 被拒），一律静默：
      // 真正「更新源不可达」由 awesomeStale 那条中性提示负责，不重复喊狼来了。
      setAwesomeUpdateHint(res && res.reason !== 'probe-failed' ? res : null);
    } catch {
      setAwesomeUpdateHint(null);
    }
  }, [call]);
  const awesomeUpdateChecked = useRef(false);
  // ── README 预览弹层 ──────────────────────────────────────────────────────
  // 点卡片时才按需拉一次（服务端 npm registry / GitHub raw + 7 天落盘缓存）；
  // 目录本身仍是 13 字段瘦身版，不因预览而变重。
  const [readmeView, setReadmeView] = useState(null);
  const readmeSeq = useRef(0);
  const readmeNodeRef = useRef(null);
  useFocusTrap(readmeNodeRef, !!readmeView);
  const closeReadme = () => {
    readmeSeq.current += 1; // 作废在途请求，避免关掉之后又被写回来
    setReadmeView(null);
  };
  // P2-3：hover 预取 README。宿主侧本来就有 7 天落盘缓存，这里只负责把「点开那一拍」
  // 的往返提前到鼠标停留的 200ms 里；重读（refresh）永远走真实请求。
  const prefetchReadme = (item) => {
    const key = readmeMemoKey(item);
    if (!item?.name) return;
    if (readDetailMemo(hoverMemo.readme, key)) return;
    scheduleHoverPrefetch(() => {
      const npm = typeof item.npm === 'string' ? item.npm : (item.npm && item.npm.name) || '';
      call('wbAwesomeReadme', { name: item.name, npm, repo: item.repo || '' })
        .then((res) => { if (res?.ok) writeDetailMemo(hoverMemo.readme, key, res); })
        .catch(() => { /* 预取失败留给点开时的正式请求报错 */ });
    });
  };
  const loadAwesomeReadme = useCallback(async (item, refresh = false) => {
    if (!item) return;
    // 弹层的排版样式随首次打开注入。放在事件回调里而不是组件顶层，是为了不引入
    // 任何新的 Hook —— 这也正是 no-conditional-hooks 测试要防的那类崩溃。
    ensureReadmeStyle();
    const seq = ++readmeSeq.current;
    const memoKey = readmeMemoKey(item);
    const precached = refresh === true ? null : readDetailMemo(hoverMemo.readme, memoKey);
    if (precached) {
      setReadmeView({
        item, loading: false, ok: true,
        markdown: precached.markdown || '', base: precached.base || '', error: '',
        source: precached.source || '', reason: precached.reason || '', truncated: precached.truncated === true,
      });
      return;
    }
    const npm = typeof item.npm === 'string' ? item.npm : (item.npm && item.npm.name) || '';
    setReadmeView({ item, loading: true, ok: false, markdown: '', base: '', error: '', source: '', reason: '', truncated: false });
    let res = null;
    try {
      res = await call('wbAwesomeReadme', { name: item.name, npm, repo: item.repo || '', refresh: refresh === true });
    } catch (error) {
      res = { ok: false, error: error && error.message ? error.message : String(error) };
    }
    if (seq !== readmeSeq.current) return;
    if (!res || res.ok !== true) {
      const raw = (res && res.error) || '';
      // 宿主进程若仍是旧版（新 Remote 未注册），这里会收到 404 transport failure：
      // 换成一句可操作的话，别让用户以为功能坏了。
      const message = /404|not\s*found/i.test(raw)
        ? t('预览服务尚未加载，请完全退出 DSH 后重新打开再试')
        : (raw || t('读取 README 失败：未知错误'));
      setReadmeView({ item, loading: false, ok: false, markdown: '', base: '', error: message, source: '', reason: (res && res.reason) || '', truncated: false });
      return;
    }
    writeDetailMemo(hoverMemo.readme, memoKey, res);
    setReadmeView({ item, loading: false, ok: true, markdown: res.markdown || '', base: res.base || '', error: '', source: res.source || '', reason: res.reason || '', truncated: res.truncated === true });
  }, [call]);
  // 目录预取：以前市场一挂载就在 400ms 后把 2.98MB 的 DSH 社区目录拉下来，与连接器
  // 首屏抢 IPC 与主线程。P1-1：等连接器首屏落地（connectorSettled），再空等 1200ms，
  // 然后在空闲帧里才发；「已切到插件页」的路径仍是立即发（用户要看，就不该等）。
  // 只跑一次，失败由列表里的错误条 / 空态提供手动重试。
  const awesomeAutoLoaded = useRef(false);
  useEffect(() => {
    if (awesomeAutoLoaded.current || !connectorSettled) return undefined;
    const fire = () => {
      if (awesomeAutoLoaded.current) return;
      awesomeAutoLoaded.current = true;
      loadAwesomeCatalog(false, true);
    };
    if (MARKET_PERF.prefetchMode === 'legacy') {
      const timer = setTimeout(fire, 400);
      return () => clearTimeout(timer);
    }
    let cancelIdle = null;
    const timer = setTimeout(() => { cancelIdle = scheduleIdle(fire, 3000); }, 1200);
    return () => { clearTimeout(timer); cancelIdle?.(); };
  }, [connectorSettled, loadAwesomeCatalog]);
  // 用户已经在插件页时不等预取延迟：立即发（旧行为保留，预取只负责「还没切过来」）。
  useEffect(() => {
    if (tab !== 'plugin' || awesomeAutoLoaded.current) return;
    awesomeAutoLoaded.current = true;
    loadAwesomeCatalog(false, true);
  }, [tab, loadAwesomeCatalog]);
  // 专家目录预取（只为子页签徽标取条数）：P1-2 同款节奏——连接器首屏后 idle 起算
  // 2500ms 才拉；用户切到专家页时 ExpertMarket 自己会立即拉，不等这条预取。
  // loadExpertCatalogShared 带模块级 TTL 缓存，专家页挂载时复用同一份，不会二连网络；
  // 组件卸载后回包只作废，不写状态。
  useEffect(() => {
    if (!connectorSettled || tab === 'expert') return undefined;
    let alive = true;
    let cancelIdle = null;
    const timer = setTimeout(() => {
      cancelIdle = scheduleIdle(() => {
        loadExpertCatalogShared(call).then((data) => {
          if (alive) setExpertTotal((data.experts || []).length || null);
        }).catch(() => { /* 徽标读不到就先不显示 */ });
      }, 3000);
    }, MARKET_PERF.prefetchMode === 'legacy' ? 400 : 2500);
    return () => { alive = false; clearTimeout(timer); cancelIdle?.(); };
  }, [call, connectorSettled, tab]);
  useEffect(() => {
    // 目录加载完成后探一次；awesomeUpdateChecked 保证组件存续期内不重复；已有提示不再探。
    if (tab !== 'plugin' || awesomeLoading || !awesomePlugins.length || awesomeError || awesomeUpdateHint) return;
    if (awesomeUpdateChecked.current) return;
    awesomeUpdateChecked.current = true;
    checkAwesomeUpdate();
  }, [tab, awesomeLoading, awesomePlugins.length, awesomeError, awesomeUpdateHint, checkAwesomeUpdate]);
  useEffect(() => { setAwesomePage(1); }, [awesomeQuery, awesomeCategory, awesomeTags, awesomeSort]);
  // DSH 社区条目的主安装路径是 npm 包名：installBundle 直接接受 `npm:<name>` 形态的
  // spec。没有 npm 的条目在 UI 层已灰置（「暂不支持安装」），走不到这里。
  const pluginInstallSpec = (plugin) => {
    const npm = String(plugin?.npm || '').trim();
    return npm ? `npm:${npm}` : null;
  };
  const installPlugin = async (plugin) => {
    if (!pluginManager || typeof pluginManager[UPGRADE_METHOD] !== 'function') {
      setError(t('宿主未提供插件管理器（pluginManager），无法安装插件'));
      return;
    }
    const spec = pluginInstallSpec(plugin);
    if (!spec) { setError(t('该条目未提供 npm 包名，暂不支持安装')); return; }
    setBusy(true); setBusyLabel(t('正在安装插件 {0}…', [plugin.name])); setError('');
    // 顶部浮层与组件 state 并行记账：面板被卸载（切标签 / 切窗口）后浮层仍在，用户不会误以为被取消。
    installToastStart(plugin.name);
    try {
      // 严格双参：installBundle(spec, {})。少传第二个会被 wire 直接拒绝。
      const res = await pluginManager[UPGRADE_METHOD](spec, {});
      if (!res || res.ok !== true) throw new Error((res?.error && (res.error.message || res.error.code)) || t('调用失败'));
      const r = res.value || {};
      if (r.application === 'failed' || r.application === 'cancelled') {
        throw new Error((r.error && (r.error.message || r.error.code)) || r.error || t('插件安装失败（宿主安装器返回失败）'));
      }
      // T04/R8：插件由客户端回写登记（宿主不知道 pluginManager 装了什么）。
      // 登记失败不影响安装结果——只提示，不抛。
      try {
        const rec = await call('wbInstallStateRecord', {
          kind: 'plugin',
          key: plugin.name,
          name: plugin.name,
          version: plugin.version || '',
          source: { kind: 'marketplace', marketplace: plugin.marketplace || 'awesome-dsh-plugins' },
        });
        if (!rec?.ok) setNote(t('插件已安装，但安装状态登记失败：{0}', [rec?.error || t('未知错误')]));
      } catch (e) {
        setNote(t('插件已安装，但安装状态登记失败：{0}', [String(e?.message || e)]));
      }
      await loadInstallState();
      // 快照里若还有这条旧目录数据，标记已安装由 installedPluginKeys 负责，无需改动。
      setRestartNotice(t('插件 {0} 安装成功，需重启 DSH 宿主后生效。', [plugin.name]));
      installToastFinish(plugin.name, 'ok');
    } catch (e) {
      setError(String(e?.message || e));
      installToastFinish(plugin.name, 'fail');
    } finally {
      setBusy(false); setBusyLabel('');
    }
  };
  // T06/Awesome：社区目录筛选 / 排序 / 分页（全量本地，不受分页影响；tags 多选为「或」语义）。
  const awesomeQueryKey = awesomeQuery.trim().toLowerCase();
  const filteredAwesome = awesomePlugins.filter((item) => {
    if (awesomeOnlyInstalled && !installedPluginKeys.has(String(item.name || ''))) return false;
    if (awesomeCategory !== 'all' && (item.category || 'plugin') !== awesomeCategory) return false;
    if (awesomeTags.length && !(item.tags || []).some((tag) => awesomeTags.includes(tag))) return false;
    if (!awesomeQueryKey) return true;
    return [item.name, item.description, item.repo, item.npm].filter(Boolean).join(' ').toLowerCase().includes(awesomeQueryKey);
  });
  const sortedAwesome = (() => {
    const rows = [...filteredAwesome];
    if (awesomeSort === 'stars') rows.sort((a, b) => (Number(b.stars) || 0) - (Number(a.stars) || 0));
    else if (awesomeSort === 'recent') rows.sort((a, b) => String(b.lastVerified || '').localeCompare(String(a.lastVerified || '')));
    else if (awesomeSort === 'name') rows.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    return rows;
  })();
  const awesomePageCount = Math.max(1, Math.ceil(sortedAwesome.length / AWESOME_PAGE_SIZE));
  const safeAwesomePage = Math.min(awesomePage, awesomePageCount);
  const visibleAwesome = sortedAwesome.slice((safeAwesomePage - 1) * AWESOME_PAGE_SIZE, safeAwesomePage * AWESOME_PAGE_SIZE);
  // 下载量只给「当前这一页」排队：一页 50 张 → 最多 5 个批量请求（宿主侧再缓存 7 天）。
  // 放在这里（不是每张卡片里）是因为 hook 不能在 .map 里调，而页级批量已经足够省。
  useNpmDownloads(call, visibleAwesome);

  // 装备清单的「去市场」：只做定位，不替用户点安装。各市场搜索词互不相通，
  // 所以按 kind / source 落到对应子页并写入该页的搜索框。
  const locateLoadoutRow = async (row) => {
    const name = String(row?.name || '').trim();
    const source = String(row?.source || '');
    setLoadoutOpen(false);
    if (row?.kind === 'mcp') {
      if (source.startsWith('connector:')) {
        switchTab('connector');
        setConnectorQuery(name);
        setConnectorOnlyReady(false);
        setConnectorPage(1);
        setNote(t('已定位到连接器市场：{0}', [name]));
      } else {
        // 非 connector 来源（手动配置或历史 builtin 导入）不在任何市场里：
        // 复制名称让用户去 MCP 页自己加，绝不替用户写配置。
        await copyText(name);
        setNote(t('这是手动配置的 MCP，名称已复制；可到 MCP 页自行添加。'));
      }
      return;
    }
    if (row?.kind === 'skill') {
      switchTab('skill');
      setSkillPage(1);
      setSkillKeywordInput(name);
      setSkillKeyword(name);
      setNote(t('已定位到技能市场：{0}', [name]));
      return;
    }
    if (row?.kind === 'expert') {
      seedExpertMarketQuery(name);
      setExpertEpoch((value) => value + 1);
      switchTab('expert');
      setNote(t('已定位到专家市场：{0}', [name]));
      return;
    }
    setAwesomeQuery(name);
    switchTab('plugin');
    setNote(t('已定位到插件市场：{0}', [name]));
  };

  const connectorSearch = h(WbSearchBox, {
    value: connectorQuery, placeholder: t('搜索连接器（名称 / 说明 / ID）'), busy: loading,
    onChange: (value) => { setConnectorQuery(value); setConnectorPage(1); },
  });
  const skillSearch = h(WbSearchBox, {
    value: skillKeywordInput, placeholder: t('搜索 SkillHub 技能（19 万+）'), busy: skillLoading,
    onChange: (value) => setSkillKeywordInput(value),
    // 回车跳过防抖立即生效（防抖本身也会触发，双保险但幂等）。
    onCommit: () => { setSkillPage(1); setSkillKeyword(skillKeywordInput); },
  });

  const skillPageCount = Math.max(1, Math.ceil(skillTotal / WB_PAGE_SIZE));
  const skillMeta = skillTotal
    ? t('第 {0} / {1} 页 · 共 {2} 个技能', [skillPage, skillPageCount, wbFormatCount(skillTotal)])
    : '';
  // §6.3 当前页的「已安装」子集。SkillHub 是远程分页（每页 20 条），
  // 已安装状态只在本地知道，所以这层过滤只作用于本页——计数文案里写清楚，
  // 免得用户以为「只看已安装」能翻遍全库。
  const shownSkills = skillOnlyInstalled
    ? skills.filter((skill) => installedSkills.has(skillInstalledKey(skill)))
    : skills;
  const installedOnPage = skills.filter((skill) => installedSkills.has(skillInstalledKey(skill))).length;

  // §6.1 子页签：原来用与顶栏 `.dsh-mcp-cat` 同款的胶囊按钮，两排长得一样，
  // 用户分不清「换整页」还是「换市场内部子页」。改成下划线式页签 + 面包屑，
  // 视觉上与顶栏彻底分开。面包屑并入页签行最右侧（不再独占一行），随当前子页更新。
  const MARKET_TABS = [
    { key: 'connector', label: t('连接器'), count: connectors.length || null },
    // 技能库 19 万+，徽标走 wbFormatCount 缩写（193k）；数字只在无关键词响应里更新，
    // 搜索命中数不进来——与连接器 / 插件徽标同语义：市场规模，不随筛选变。
    { key: 'skill', label: t('技能'), count: skillMarketTotal ? wbFormatCount(skillMarketTotal) : null },
    // 插件市场子页签。count 在目录加载后才有（未载时灰字入口，同技能）。
    { key: 'plugin', label: t('插件'), count: awesomePlugins.length || null },
    // 专家徽标同款：挂载后延迟预取目录条数，读到才显示。
    { key: 'expert', label: t('专家'), count: expertTotal },
  ];
  const marketTabLabel = (MARKET_TABS.find((row) => row.key === tab) || MARKET_TABS[0]).label;
  return h('div', { className: 'dsh-mcp-wb' },
    h('div', { className: 'dsh-mcp-mk-subtabs', role: 'tablist', 'aria-label': t('WorkBuddy 市场') },
      MARKET_TABS.map((row) => h('button', {
        key: row.key, type: 'button', role: 'tab', 'aria-selected': tab === row.key,
        className: 'dsh-mcp-mk-subtab', onClick: () => switchTab(row.key),
      }, row.label, row.count ? h('i', null, row.count) : null)),
      // 右侧：免责声明 + 装备清单入口 + 面包屑（面包屑 aria-hidden：当前位置已由选中页签表达）。
      // 声明从页签下方的一行挪到这里：不占纵向高度，窄屏自动省略（完整口径在 title 里）。
      h('div', { className: 'dsh-mcp-mk-topright' },
        h('span', {
          className: 'dsh-mcp-mk-note',
          role: 'note',
          title: t('连接器来自 WorkBuddy 官方分发（static.workbuddy.cn）；技能来自 SkillHub 公开 API；专家来自 WorkBuddy 专家中心分发。')
            + t('第三方接口的字段可能随上游改版变化，安装前请在详情里核对传输类型与凭据要求。'),
        }, t('连接器 / 技能 / 专家均为第三方分发，本面板只做浏览与安装入口；内容版权归原作者所有。')),
        h('button', {
          type: 'button', className: 'dsh-mcp-loadout-open',
          title: t('导出本机配置，或导入朋友的清单做差异对比'),
          onClick: () => setLoadoutOpen(true),
        }, t('装备清单')),
        h('div', { className: 'dsh-mcp-mk-crumb', 'aria-hidden': 'true' },
          h('span', { className: 'dsh-mcp-mk-crumb-root' }, t('市场')),
          h('span', { className: 'dsh-mcp-mk-crumb-sep' }, '/'),
          h('b', null, marketTabLabel),
        ),
      ),
    ),
    // §6.5 免责声明已挪到子页签行右侧（.dsh-mcp-mk-note），这里不再占一行。
    // 「最近动静」：本机快照对比，只报真实的目录变化；没有变化就说没有。
    h(MarketPulse, {
      state: pulse,
      onClear: () => { clearMarketPulse(); setPulse(emptyMarketPulse()); },
      onJump: (meta) => {
        if (!meta?.tab) return;
        // 直达全量市场：清掉该页签残留的搜索 / 筛选 / 排序 / 页码，再切过去。
        applyFullMarket(meta.tab);
        switchTab(meta.tab);
      },
    }),
    // 连接器来源切换：同一个列表位置两个来源，默认仍停在 WorkBuddy（行为与改造前一致）。
    // 用 .dsh-mcp-seg 与作用域切换同一观感；切到社区不卸载 WB 侧的搜索/筛选/页码。
    tab === 'connector'
      ? h('div', { className: 'dsh-mcp-wb-toolbar dsh-mcp-wb-feedbar' },
          h('div', { className: 'dsh-mcp-seg', role: 'tablist', 'aria-label': t('连接器来源') },
            h('button', {
              type: 'button', role: 'tab', 'aria-selected': connectorFeed === 'wb', className: 'dsh-mcp-seg-item',
              title: t('WorkBuddy 官方分发的连接器；多数需要 WorkBuddy 账号授权'),
              onClick: () => setConnectorFeed('wb'),
            },
              t('WorkBuddy 连接器'),
              // 徽标常驻：数字一隐藏就会被读成"这一页就是全部"。连接器是一次返回全量，
              // 所以这个数就是总数；没取到之前显示「…」而不是空着。
              h('span', {
                className: 'dsh-mcp-seg-count',
                title: connectors.length ? t('WorkBuddy 官方目录里的连接器总数') : t('正在读取连接器列表…'),
              }, connectors.length || '…'),
            ),
            h('button', {
              type: 'button', role: 'tab', 'aria-selected': connectorFeed === 'community', className: 'dsh-mcp-seg-item',
              title: t('官方 MCP Registry 的社区条目，不依赖 WorkBuddy 账号'),
              onClick: () => setConnectorFeed('community'),
            },
              t('社区 MCP'),
              // 这里显示的是**全库总数**（数到底）或**下界**（还在续爬，形如 1200+），
              // 不再是「已读取 98 条」——那个数会被读成"社区一共只有 98 个"（2026-10-30 用户
              // 反馈）。查询内的已读累计仍在下面那行工具条里，两个数各有各的口径。
              h('span', { className: 'dsh-mcp-seg-count', title: communityCountBadgeTitle(communityCount) }, communityCountBadgeText(communityCount)),
            ),
          ),
        )
      : null,
    // 未审核声明常驻（可折叠就等于没有）：社区条目由第三方提交，命令与环境变量自行确认。
    tab === 'connector' && connectorFeed === 'community'
      ? h('div', { className: 'dsh-mcp-wb-note warn', role: 'note' },
          t('社区 MCP 来自官方 MCP Registry，由社区提交；军械库未审核其代码，加入前请自行确认命令与环境变量。'))
      : null,
    tab === 'connector' && connectorFeed === 'community'
      ? h('div', { className: 'dsh-mcp-wb-toolbar' },
          h(WbSearchBox, {
            value: communityQueryInput, placeholder: t('搜索社区 MCP（名称 / 说明）'), busy: communityLoading,
            onChange: (value) => setCommunityQueryInput(value),
            // 回车跳过防抖立即生效（防抖本身也会触发，幂等）。
            onCommit: () => setCommunityQuery(communityQueryInput.trim()),
          }),
          h('label', {
            className: 'dsh-mcp-check',
            title: t('只显示带 npx / uvx 启动包的条目；远程 HTTP 条目需要自备令牌'),
          },
            h('input', { type: 'checkbox', checked: communityOnlyRunnable, onChange: (e) => setCommunityOnlyRunnable(e.target.checked) }),
            t('只看可直接运行（npx / uvx）'),
          ),
          h('span', { className: 'dsh-mcp-builtin-count', title: t('本次查询已逐页读取的条数；上方徽标显示的是社区目录全库总数') },
            t('已读取 {0} 条', [communityReadTotal]) + (communityStale ? t(' · 缓存结果') : '')),
          communityOnlyRunnable && communityHiddenCount > 0
            ? h('span', { className: 'dsh-mcp-builtin-count', title: t('这些条目只有远程地址，需要自备令牌') },
                t('已隐藏 {0} 个远程条目', [communityHiddenCount]))
            : null,
        )
      : null,
    tab === 'connector' && connectorFeed === 'wb'
      ? h('div', { className: 'dsh-mcp-wb-toolbar' },
          connectorSearch,
          h('label', { className: 'dsh-mcp-check', title: t('默认只显示可直接安装的条目；取消勾选可看到「仅展示」的不兼容条目') },
            h('input', { type: 'checkbox', checked: connectorOnlyReady, onChange: (e) => { setConnectorOnlyReady(e.target.checked); setConnectorPage(1); } }),
            t('只看可直接安装')),
          // T04/R8：已安装筛选是全量本地筛选（跨页生效），不随分页变化。
          h('label', { className: 'dsh-mcp-check', title: t('在全量 {0} 条目录里筛出已安装的连接器（跨页生效，与技能侧「仅本页」不同）', [connectors.length]) },
            h('input', { type: 'checkbox', checked: connectorOnlyInstalled, disabled: loading, onChange: (e) => { setConnectorOnlyInstalled(e.target.checked); setConnectorPage(1); } }),
            t('只看已安装')),
          // T05/R10：排序下拉（全量本地排序，翻页不打乱）。
          h('select', {
            className: 'dsh-mcp-input dsh-mcp-wb-sort', value: connectorSort, disabled: loading,
            onChange: (e) => { setConnectorSort(e.target.value); setConnectorPage(1); },
          }, WB_CONNECTOR_SORTS.map((option) => h('option', { key: option.key, value: option.key }, option.label))),
          connectorOnlyInstalled
            ? h('span', { className: 'dsh-mcp-builtin-count' }, t('已安装 {0} / {1}', [installedConnectorKeys.size, connectors.length]))
            : null,
          // 被过滤掉多少条要明说，否则用户会以为目录里就这么多。
          !connectorOnlyReady || loading ? null : (() => {
            const hidden = connectors.filter((row) => !row.installable).length;
            return hidden > 0
              ? h('span', { className: 'dsh-mcp-builtin-count', title: t('这些条目缺少传输类型等必要信息，本面板无法生成配置') },
                  t('已隐藏 {0} 个不兼容条目', [hidden]))
              : null;
          })(),
          h('span', { className: 'dsh-mcp-builtin-count' },
            t('显示 {0} / {1}', [visibleConnectors.length, filteredConnectors.length]) + (connectorSource === 'network' ? t(' · 已更新') : connectorSource === 'disk' ? t(' · 缓存') : '')),
        )
      : null,
    // T02/R2：visible_in 标签筛选 chips（只在连接器 tab 且目录里确实出现标签时显示）。
    // 语义：未选任何标签 = 不过滤；选中后任一命中即保留（OR）；没标 visible_in 的行不受影响。
    tab === 'connector' && connectorFeed === 'wb' && connectorVisibleTagUniverse.length
      ? h('div', { className: 'dsh-mcp-wb-toolbar dsh-mcp-wb-tagbar' },
          h('span', { className: 'dsh-mcp-wb-tagbar-label' }, t('适用环境：')),
          connectorVisibleTagUniverse.map(({ tag, count }) => h('button', {
            key: tag,
            type: 'button',
            className: 'dsh-mcp-tag-chip' + (visibleTagFilter.includes(tag) ? ' on' : ''),
            'aria-pressed': visibleTagFilter.includes(tag),
            title: t('{0} 个连接器适用', [count]),
            onClick: () => {
              setVisibleTagFilter((current) => (current.includes(tag) ? current.filter((row) => row !== tag) : [...current, tag]));
              setConnectorPage(1);
            },
          }, tag)),
          visibleTagFilter.length
            ? h('button', { type: 'button', className: 'dsh-mcp-tag-chip clear', onClick: () => { setVisibleTagFilter([]); setConnectorPage(1); } }, t('清除标签筛选'))
            : null,
        )
      : null,
    tab === 'plugin'
        ? h('div', { className: 'dsh-mcp-wb-toolbar' },
            h(WbSearchBox, { value: awesomeQuery, placeholder: t('搜索插件（名称 / 描述 / 作者）'), onChange: (value) => setAwesomeQuery(value) }),
            ...AWESOME_CATEGORIES.map((cat) => h('button', { key: cat.key, type: 'button', className: 'dsh-mcp-tag-chip' + (awesomeCategory === cat.key ? ' on' : ''), 'aria-pressed': awesomeCategory === cat.key, onClick: () => setAwesomeCategory(cat.key) }, cat.label)),
            ...AWESOME_TAGS.map((tag) => h('button', { key: tag, type: 'button', className: 'dsh-mcp-tag-chip' + (awesomeTags.includes(tag) ? ' on' : ''), 'aria-pressed': awesomeTags.includes(tag), onClick: () => setAwesomeTags(awesomeTags.includes(tag) ? awesomeTags.filter((row) => row !== tag) : [...awesomeTags, tag]) }, tag)),
            h('select', { className: 'dsh-mcp-wb-sort', value: awesomeSort, onChange: (e) => setAwesomeSort(e.target.value) }, AWESOME_SORTS.map((option) => h('option', { key: option.key, value: option.key }, option.label))),
            h('label', { className: 'dsh-mcp-check', title: t('在全量 {0} 条插件里筛出已安装的（跨页生效）', [awesomePlugins.length]) }, h('input', { type: 'checkbox', checked: awesomeOnlyInstalled, onChange: (e) => setAwesomeOnlyInstalled(e.target.checked) }), t('只看已安装')),
            h('span', { className: 'dsh-mcp-builtin-count' }, t('显示 {0} / {1}', [visibleAwesome.length, filteredAwesome.length])),
          )
        : tab === 'expert'
          ? null
          : tab === 'skill'
          ? h('div', { className: 'dsh-mcp-wb-toolbar' },
              skillSearch,
            h('select', {
              className: 'dsh-mcp-input dsh-mcp-wb-sort', value: skillSort,
              title: t('SkillHub 已不再提供全站下载量排序；这一项只在当前页内按下载量排序。'),
              onChange: (e) => { setSkillSort(e.target.value); setSkillPage(1); },
            }, WB_SKILLHUB_SORTS.map((option) => h('option', { key: option.key, value: option.key }, option.label))),
            h('label', { className: 'dsh-mcp-check', title: t('仅在本页 {0} 条里筛出已安装的（SkillHub 是远程分页，无法跨页筛选）', [skills.length]) },
              h('input', { type: 'checkbox', checked: skillOnlyInstalled, onChange: (e) => setSkillOnlyInstalled(e.target.checked) }),
              t('只看已安装')),
            skillOnlyInstalled
              ? h('span', { className: 'dsh-mcp-builtin-count' }, t('本页已安装 {0} / {1}', [installedOnPage, skills.length]))
              : null,
            h('span', { className: 'dsh-mcp-builtin-count' }, skillMeta),
          )
          : null,
    note ? h('div', { className: 'dsh-mcp-wb-note', role: 'status' }, note) : null,
    busyLabel ? h('div', { className: 'dsh-mcp-wb-note busy', 'aria-live': 'polite' }, busyLabel) : null,
    error ? h('div', { className: 'dsh-mcp-wb-error', role: 'alert' }, error) : null,
    // 技能加载失败只落在这一行（带重试），不再借用整页 banner：一个上游接口挂了
    // 不该让「连接器 / 技能 / 插件 / 专家」页签看起来都坏了。
    tab === 'skill' && skillError
      ? h('div', { className: 'dsh-mcp-wb-error', role: 'alert' }, skillError, ' ',
          h('button', {
            type: 'button', className: 'dsh-mcp-btn', disabled: skillLoading,
            onClick: () => loadSkills(skillPage, skillSort, skillKeyword),
          }, t('重试')))
      : null,
    loading && !connectors.length && tab === 'connector' && connectorFeed === 'wb' ? h('div', { className: 'dsh-mcp-wb-empty' }, t('正在读取连接器目录…')) : null,
    // 首次加载 / 换搜索词后的第一批：还没有这一批的结果时显示读取中（旧结果不冒充新搜索）。
    communityLoading && tab === 'connector' && connectorFeed === 'community'
      && (!communityRows.length || communityLoadedQueryRef.current !== communityQuery)
      ? h('div', { className: 'dsh-mcp-wb-empty', role: 'status' }, t('正在读取社区 MCP…'))
      : null,
    skillLoading && !skills.length && tab === 'skill' ? h('div', { className: 'dsh-mcp-wb-empty' }, t('正在读取技能目录…')) : null,
    // §1.4 「只看可直接安装」把本页筛空了：这是本页最容易踩的坑（默认勾选），
    // 主操作就是取消它——一句话说清「这里本来有条目，是筛选挡掉了」。
    !loading && tab === 'connector' && connectorFeed === 'wb' && !visibleConnectors.length
      ? (connectors.length
          ? h(EmptyState, {
              icon: 'store',
              title: t('当前筛选下没有可安装的连接器'),
              hint: connectorOnlyReady
                ? t('目录里有 {0} 个条目，「只看可直接安装」把不具备传输类型的挡掉了。', [connectors.length])
                : t('换个关键词试试，或清空搜索回到完整目录。'),
              actions: connectorOnlyReady
                ? [
                    { label: t('显示全部条目'), icon: 'eye', onClick: () => { setConnectorOnlyReady(false); setConnectorPage(1); } },
                    { label: t('清空搜索'), icon: 'x', onClick: () => { setConnectorQuery(''); setConnectorPage(1); } },
                  ]
                : [{ label: t('清空搜索'), icon: 'x', onClick: () => { setConnectorQuery(''); setConnectorPage(1); } }],
            })
          : h(EmptyState, {
              icon: 'store',
              title: t('连接器目录暂时是空的'),
              hint: t('目录来自 WorkBuddy 官方分发，可能还没同步下来；重读一次通常就好。'),
              actions: [{ label: t('重新读取目录'), icon: 'refresh', onClick: () => { loadConnectors(); } }],
            }))
      : null,
    // 社区加载失败：错误只落在列表内（带重试），不影响 WB 连接器；上次结果还在时
    // 由工具栏的「缓存结果」标注说明，不在这里重复一遍。
    tab === 'connector' && connectorFeed === 'community' && communityError
      ? h('div', { className: 'dsh-mcp-wb-error', role: 'alert' },
          t('社区列表加载失败：{0}', [communityError]), ' ',
          h('button', {
            type: 'button', className: 'dsh-mcp-btn', disabled: communityLoading,
            onClick: () => loadCommunity({ cursor: '' }),
          }, t('重试')))
      : null,
    // 社区空结果：搜索无命中与「只看可直接运行」筛空是两种不同的空，提示分开。
    !communityLoading && tab === 'connector' && connectorFeed === 'community' && !communityError && !communityVisibleRows.length
      ? h(EmptyState, {
          icon: 'store',
          tight: true,
          title: t('没有匹配的社区条目'),
          hint: communityOnlyRunnable && communityHiddenCount > 0
            ? t('有 {0} 条只有远程地址的条目被「只看可直接运行」挡住了。', [communityHiddenCount])
            : t('换一个更短的关键词，或取消「只看可直接运行」。'),
          actions: communityOnlyRunnable && communityHiddenCount > 0
            ? [{ label: t('显示全部条目'), icon: 'eye', onClick: () => setCommunityOnlyRunnable(false) }]
            : [{ label: t('重新读取'), icon: 'refresh', onClick: () => loadCommunity({ cursor: '' }) }],
        })
      : null,
    // §1.4 技能：搜索与「只看已安装」是两种完全不同的空，说法必须分开——
    // 否则用户会以为 SkillHub 里根本没有这个词。
    !skillLoading && tab === 'skill' && !skills.length
      ? h(EmptyState, {
          icon: 'skill',
          title: skillKeyword.trim() ? t('没有搜到「{0}」相关的技能', [skillKeyword.trim()]) : t('技能目录暂时是空的'),
          hint: skillKeyword.trim() ? t('SkillHub 的搜索按名称与描述匹配；换一个更短的词通常更容易命中。') : t('技能来自 SkillHub 公开 API，可能还没同步下来。'),
          actions: skillKeyword.trim()
            ? [{ label: t('清空搜索'), icon: 'x', onClick: () => { setSkillKeywordInput(''); setSkillKeyword(''); setSkillPage(1); } }]
            : [],
        })
      : null,
    // 「只看已安装」把本页筛空了：不能沿用「没有匹配的技能」——那会让人以为搜索没结果。
    !skillLoading && tab === 'skill' && skills.length && !shownSkills.length
      ? h(EmptyState, {
          icon: 'skill',
          tight: true,
          title: t('本页没有已安装的技能'),
          hint: t('SkillHub 是远程分页，只能在当前 {0} 条里筛。翻页找找，或取消「只看已安装」。', [skills.length]),
          actions: [{ label: t('取消「只看已安装」'), icon: 'x', onClick: () => setSkillOnlyInstalled(false) }],
        })
      : null,
    tab === 'connector' && connectorFeed === 'wb' && visibleConnectors.length
      ? h('div', { className: 'dsh-mcp-wb-grid' },
          visibleConnectors.map((item) => h('div', {
            key: item.id,
            className: 'dsh-mcp-card wb' + (item.installable ? '' : ' blocked'),
            // P2-3：停住 200ms 才预取授权概览；扫过就离开不发请求。
            onMouseEnter: () => prefetchConnectorDetail(item),
            onMouseLeave: cancelHoverPrefetch,
          },
            // §6.2 不兼容卡片：原来只在卡片底部一行 10.5px 橙字「不兼容：…」，
            // 用户要滚到卡底才知道装不了。改成右上角橙色角标，一眼可见；
            // 完整原因仍留在 blockedReason，hover 卡片或角标都能看到。
            item.installable ? null : h('span', { className: 'dsh-mcp-mk-corner', title: item.blockedReason || t('不兼容') }, t('不兼容')),
            h('div', { className: 'dsh-mcp-card-top' },
              // 头像来自官方分发包 ZIP 的 icons/<id>（ConnectorAvatar 进视口才取），
              // 布局与技能卡同款 person 行：头像 + 名字并排，徽标仍靠右。
              h('div', { className: 'dsh-mcp-card-person' },
                h(ConnectorAvatar, { call, connectorId: item.id, name: item.name, className: 'dsh-mcp-card-avatar' }),
                h('div', null, h('div', { className: 'dsh-mcp-card-name' }, item.name)),
              ),
              // T04/R8 + P0：安装账本只说明「写进过配置」；徽标按真实连接态细分
              // （已连接 / 需授权 / 未连接），找不到同名 server 时退回「已安装」。
              connectorBadge(item),
            ),
            h('div', { className: 'dsh-mcp-card-summary' },
              // T02/R3：examples 优先（displayBody 由 host 侧 displayCopyOf 产出），
              // description 只作兜底；都无时回落 nameEn / id（与旧行为一致）。
              item.displayBody || item.description || item.nameEn || item.id),
            h('div', { className: 'dsh-mcp-card-tags' },
              item.skillCount ? h(Badge, null, t('含 {0} 技能', [item.skillCount])) : null,
              item.transport ? h(Badge, { cls: item.transport === 'streamable-http' ? 't-http' : 't-stdio' }, item.transport === 'streamable-http' ? 'HTTP' : 'stdio') : null,
              item.authMode ? h(Badge, null, item.authMode) : null,
              // T02/R1：token 注入规则标注（只展示，DSH 不代注入）。
              item.injectionRuleCount ? h(Badge, { cls: 's-warn', title: t('存在 token 注入规则（依赖 WB 账号体系，DSH 不代注入）') }, t('注入规则 ×{0}', [item.injectionRuleCount])) : null,
              // T02/R2：visible_in 标签 chips（最多展示 3 个，多出的折叠进 +N）。
              (item.visibleIn || []).length
                ? h(Badge, null,
                    item.visibleIn.slice(0, 3).join(' / ')
                    + ((item.visibleIn.length > 3) ? t(' +{0}', [item.visibleIn.length - 3]) : ''))
                : null,
            ),
            h('div', { className: 'dsh-mcp-wb-card-actions' },
              h('button', { type: 'button', className: 'dsh-mcp-btn', onClick: () => openConnectorDetail(item) }, t('详情')),
              // P0：已安装但当前没连上 → 就地给出口（鉴权失败给「重新授权」，其余给「重连」），
              // 不让用户为了一个红点去 MCP 面板自己找。
              installedConnectorKeys.has(String(item.id || '')) && connectorHealth(item) !== 'connected' && connectorHealth(item) !== 'unknown'
                ? h('button', {
                    type: 'button', className: 'dsh-mcp-btn', disabled: busy,
                    title: connectorHealth(item) === 'auth' ? t('服务器拒绝当前凭据：重新走一次授权') : t('拆掉这条连接并按当前配置重建'),
                    onClick: () => reconnectConnector(item),
                  }, connectorHealth(item) === 'auth' ? t('重新授权') : t('重连'))
                : null,
              item.installable
                ? h('button', { type: 'button', className: 'dsh-mcp-btn primary', disabled: busy, onClick: () => requestInstallConnector(item) }, t('安装'))
                : h('span', {
                    className: 'dsh-mcp-wb-blocked',
                    title: item.blockedReason,
                  }, item.blockedReason ? t('不兼容：') + item.blockedReason : t('需上游提供传输类型')),
            ),
          )),
        )
      : null,
    tab === 'connector' && connectorFeed === 'wb' && connectorPageCount > 1
      ? h(Pager, { page: safeConnectorPage, pageCount: connectorPageCount, total: sortedConnectors.length, onPage: setConnectorPage })
      : null,
    // ── 社区 MCP 卡片 ──
    // 与 WB 连接器同一视觉（.dsh-mcp-card wb）。字段只填 Registry 真实有的内容：
    // 标题 / 完整命名空间 / 描述 / 传输类型 / 环境变量数量 / 密钥字段 / 版本。
    // 命令不折行塞卡片：完整 command / args / env 在点开卡片后的详情弹层里只读展示，
    // 要改则走「加入 MCP」的预填弹层——两层各司其职，避免卡片被长命令行撑变形。
    tab === 'connector' && connectorFeed === 'community' && communityVisibleRows.length
      && !(communityLoading && communityLoadedQueryRef.current !== communityQuery)
      ? h('div', { className: 'dsh-mcp-wb-grid' },
          communityVisibleRows.map((row) => {
            const joined = communityJoined(row);
            const detailLabel = t('查看 {0} 的详情', [row.title || row.name]);
            const repoHref = externalHref(row.repoUrl);
            // 卡片本身不再是 role=button：里面已有「加入 MCP」按钮与仓库链接，
            // 把整张卡声明成按钮会产生嵌套交互控件，aria-label 还会吞掉整段卡片内容。
            // 鼠标点卡片任意处仍可开详情；键盘用户走操作区里真正的「详情」按钮。
            return h('div', {
              key: row.key,
              className: 'dsh-mcp-card wb clickable',
              title: detailLabel,
              onClick: () => setCommunityDetail(row),
            },
              h('div', { className: 'dsh-mcp-card-top' },
                h('div', { className: 'dsh-mcp-card-person' },
                  // 头像只在 owner 可解析时才探图（与技能卡同一代理通道）；解析不出用字母占位。
                  h(Avatar, {
                    url: row.owner ? avatarProxyUrl('https://github.com/' + row.owner + '.png', 64) : '',
                    name: row.title || row.name,
                    className: 'dsh-mcp-card-avatar',
                  }),
                  h('div', null,
                    h('div', { className: 'dsh-mcp-card-name' }, row.title || row.name),
                    h('div', { className: 'dsh-mcp-card-vendor', title: row.name }, row.name),
                  ),
                ),
                joined ? h(Badge, { cls: 's-on', title: t('当前 MCP 列表里已有同名服务器') }, t('已加入')) : null,
              ),
              h('div', { className: 'dsh-mcp-card-summary' }, row.description || row.name),
              h('div', { className: 'dsh-mcp-card-tags' },
                h(Badge, { cls: row.transport === 'http' ? 't-http' : 't-stdio' },
                  row.transport === 'http' ? t('远程（需自备令牌）') : 'stdio'),
                row.env.length ? h(Badge, { title: row.env.map((item) => item.name).join(' / ') }, t('需 {0} 个环境变量', [row.env.length])) : null,
                row.env.some((item) => item.secret) ? h(Badge, { cls: 's-warn' }, t('含密钥字段')) : null,
                row.version ? h(Badge, null, 'v' + row.version) : null,
              ),
              h('div', { className: 'dsh-mcp-wb-card-actions', onClick: (e) => e.stopPropagation(), onKeyDown: (e) => e.stopPropagation() },
                h('button', {
                  type: 'button', className: 'dsh-mcp-btn', 'aria-label': detailLabel,
                  onClick: () => setCommunityDetail(row),
                }, t('详情')),
                h('button', {
                  type: 'button', className: 'dsh-mcp-btn primary', disabled: busy || joined,
                  title: joined ? t('当前 MCP 列表里已有同名服务器') : t('预填一条 MCP 配置，确认后写入全局配置'),
                  onClick: () => openCommunityDraft(row),
                }, joined ? t('已加入') : t('加入 MCP')),
                repoHref
                  ? h('a', { className: 'dsh-mcp-btn', href: repoHref, target: '_blank', rel: 'noreferrer' }, t('仓库'))
                  : null,
              ),
            );
          }),
        )
      : null,
    // 游标翻页：Registry 不返回总页数，只提供「第 N 页 + 下一页是否有」。
    // 下一页只在用户点击时才请求；当前页内容原地替换，不累加。
    // 用「已读取 > 0」而不是「本页有条目」作为显示条件：某页刚好被筛空时，
    // 上一页 / 下一页仍要在，否则用户会被困在空白页里。
    tab === 'connector' && connectorFeed === 'community' && communityReadTotal > 0
      ? h('div', { className: 'dsh-mcp-wb-more' },
          h('button', {
            type: 'button', className: 'dsh-mcp-btn',
            disabled: communityLoading || communityPrevCursor === null,
            onClick: () => loadCommunity({ cursor: communityPrevCursor || '', page: communityPage - 1 }),
          }, t('上一页')),
          h('span', { className: 'dsh-mcp-builtin-count' }, t('第 {0} 页', [communityPage])),
          h('button', {
            type: 'button', className: 'dsh-mcp-btn',
            disabled: communityLoading || !communityNextCursor,
            title: communityNextCursor ? undefined : t('已经到底了'),
            onClick: () => loadCommunity({ cursor: communityNextCursor || '', page: communityPage + 1 }),
          }, communityLoading ? t('正在加载…') : t('下一页')),
        )
      : null,
    tab === 'skill' && shownSkills.length
      ? h('div', { className: 'dsh-mcp-wb-grid' },
          shownSkills.map((skill) => {
            const installedKey = skillInstalledKey(skill);
            const installed = installedSkills.has(installedKey);
            // 安装时间：wbSkillInstalled 行自带（账本首次安装时间，无账本回落目录创建时间）。
            const installedAt = installedSkills.get(installedKey) || 0;
            const installedLabel = installedAt ? t('安装于 {0}', [wbFormatDate(installedAt)]) : '';
            return h('div', {
              key: skill.namespace + '/' + skill.slug,
              className: 'dsh-mcp-card wb',
              // P2-3：同上，停住才预取技能详情。
              onMouseEnter: () => prefetchSkillDetail(skill),
              onMouseLeave: cancelHoverPrefetch,
            },
              h('div', { className: 'dsh-mcp-card-top' },
                h('div', { className: 'dsh-mcp-card-person' },
                  h(Avatar, {
                    url: skill.iconUrl || githubAvatarUrl(skill.homepage),
                    name: skill.ownerName || skill.namespace || skill.name,
                    className: 'dsh-mcp-card-avatar',
                  }),
                  h('div', null,
                    h('div', { className: 'dsh-mcp-card-name' }, skill.name),
                    h('div', { className: 'dsh-mcp-card-vendor' }, skill.canonical || skill.namespace),
                  ),
                ),
                installed ? h(Badge, { cls: 's-on', title: installedLabel || undefined }, t('已安装')) : null,
              ),
              h('div', { className: 'dsh-mcp-card-summary' }, skill.description || skill.name),
              h(PresenceLine, {
                owner: skill.ownerName || skill.namespace,
                avatar: skill.iconUrl || githubAvatarUrl(skill.homepage),
                updatedAt: skill.updatedAt,
                href: browsableHomepageUrl(skill.homepage),
                className: 'dsh-mcp-presence-card',
              }),
              h('div', { className: 'dsh-mcp-card-tags' },
                h(Badge, null, `↓${wbFormatCount(skill.downloads)}`),
                skill.installs ? h(Badge, null, t('装 {0}', [wbFormatCount(skill.installs)])) : null,
                skill.stars ? h(Badge, null, `★${wbFormatCount(skill.stars)}`) : null,
                skill.verified ? h(Badge, { cls: 's-on' }, t('认证')) : null,
                skill.version ? h(Badge, null, 'v' + skill.version) : null,
                wbFormatDate(skill.updatedAt) ? h(Badge, null, wbFormatDate(skill.updatedAt)) : null,
                installed && installedAt ? h(Badge, null, installedLabel) : null,
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
      ? h(Pager, { page: skillPage, pageCount: skillPageCount, total: skillTotal, onPage: setSkillPage, disabled: skillLoading })
      : null,
    // ── 插件安装后的重启提示 ──
    // 常驻本 tab 顶部（组件卸载即消失，不写 localStorage）——installBundle 装完包，
    // 宿主进程不热载，不重启就以为装失败了。
    tab === 'plugin' && restartNotice
      ? h('div', { className: 'dsh-mcp-wb-note restart', role: 'status' },
          restartNotice,
          h('button', { type: 'button', className: 'dsh-mcp-btn', onClick: () => setRestartNotice('') }, t('知道了')),
        )
      : null,
    // ── T06/Awesome：DSH 社区（awesome-dsh-plugins）目录 ──
    tab === 'plugin' && awesomeStale ? h('div', { className: 'dsh-mcp-wb-note', role: 'status' }, t('目录缓存已过期（更新源暂时不可达，显示的是本地缓存）。'), h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: awesomeLoading, onClick: () => { writeAwesomeProbeAt(0); awesomeUpdateChecked.current = false; loadAwesomeCatalog(true); } }, t('重新加载'))) : null,
    tab === 'plugin' && awesomeUpdateHint && (awesomeUpdateHint.reason === 'update-available' || awesomeUpdateHint.reason === 'no-cache') ? h('div', { className: 'dsh-mcp-wb-note', role: 'status' }, awesomeUpdateHint.reason === 'update-available' ? t('DSH 社区目录有新版本（本地缓存 {0}）。点「重新加载」可拉取最新目录。', [awesomeUpdateHint.localEtag || t('未知错误')]) : t('本地还没有 DSH 社区目录缓存，点「重新加载」可首次拉取目录。'), h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: awesomeLoading, onClick: async () => { setAwesomeUpdateHint(null); writeAwesomeProbeAt(0); awesomeUpdateChecked.current = false; await loadAwesomeCatalog(true); } }, t('重新加载')), h('button', { type: 'button', className: 'dsh-mcp-btn', onClick: () => setAwesomeUpdateHint(null) }, t('知道了'))) : null,
    
    tab === 'plugin' && awesomeError ? h('div', { className: 'dsh-mcp-wb-error', role: 'alert' }, awesomeError, h('button', { type: 'button', className: 'dsh-mcp-btn', disabled: awesomeLoading, onClick: () => loadAwesomeCatalog() }, t('重试'))) : null,
    tab === 'plugin' && awesomeLoading && !awesomePlugins.length ? h('div', { className: 'dsh-mcp-wb-empty' }, t('正在加载 DSH 社区目录…')) : null,
    tab === 'plugin' && !awesomeError && !awesomeLoading && !awesomePlugins.length ? h(EmptyState, { icon: 'store', title: t('DSH 社区目录暂时是空的'), hint: t('目录来自 awesome-dsh-plugins 社区清单（jsdelivr CDN 分发），拉取失败可重试。'), actions: [{ label: t('重新读取目录'), icon: 'refresh', onClick: () => loadAwesomeCatalog() }] }) : null,
    tab === 'plugin' && awesomePlugins.length && !visibleAwesome.length ? h(EmptyState, { tight: true, title: t('没有匹配的社区插件'), hint: t('换个关键词，或清空分类与标签筛选。'), actions: [{ label: t('清空筛选'), icon: 'x', onClick: () => { setAwesomeQuery(''); setAwesomeCategory('all'); setAwesomeTags([]); } }] }) : null,
    tab === 'plugin' && visibleAwesome.length ? h('div', { className: 'dsh-mcp-wb-grid' }, visibleAwesome.map((item) => {
      const repoKey = parseGithubRepoKey(item.repo);
      const repoLabel = item.repo ? String(item.repo).replace(/^https?:\/\/github\.com\//i, '') : (item.npm ? String(item.npm) : '');
      const metaTitle = item.repo ? String(item.repo) : (item.npm ? String(item.npm) : '');
      const verifiedLabel = item.verifiedAgainst ? t('已验证 · dsh {0}', [item.verifiedAgainst]) : '';
      // 42.3% 的社区条目 npm 包名 ≠ 显示名，装的时候只能用包名，以前卡面上完全不显示。
      // 它排第一，且是标签行里唯一可收缩的一枚（CSS .dsh-mcp-pchip.mono 是 flex:0 1 auto）：
      // 放不下时它自己省略号截断，后面的分类/标签不会被挤成半截；完整包名进 title 兜底。
      const npmPackage = item.npm && String(item.npm) !== String(item.name || '') ? String(item.npm) : '';
      const chips = [];
      if (npmPackage) chips.push(npmPackage);
      if (item.category && item.category !== 'plugin' && !chips.includes(item.category)) chips.push(item.category);
      for (const tag of item.tags || []) if (tag && !chips.includes(tag)) chips.push(tag);
      const shownChips = chips.slice(0, 3);
      const extraChips = chips.length - shownChips.length;
      const stars = Number(item.stars) || 0;
      const verifiedDate = item.lastVerified ? wbFormatDate(timestampOf(item.lastVerified)).slice(5) : '';
      // 底栏三枚事实，对齐技能卡的「↓N ★N 日期」，但卡高一 px 都不长：
      //   ↓ 近 30 天 npm 下载量——目录里没这字段，按包名去 npm 公开统计接口补；问不到
      //     （下架 / 未被统计）就整枚不画，绝不显示 0 冒充「没人下载」。
      //   ★ 仓库星数，目录自带。
      //   核验 MM-DD 是**目录批次核验日期**，不是插件自身的更新时间（6430 条里 37.5%
      //     同一批核验）；所以带「核验」二字与说明 title，宁可不写也不伪造「更新于」。
      // 「dsh 版本」不再占这一行，退回右上角已验证徽标的 title（装不装看的是已验证）。
      const downloads = npmDownloadsFor(item.npm);
      const dateFact = verifiedDate ? t('核验 {0}', [verifiedDate]) : '';
      const sealTip = verifiedLabel ? verifiedLabel + (verifiedDate ? ' · ' + t('核验 {0}', [verifiedDate]) : '') : '';
      const installed = installedPluginKeys.has(String(item.name || ''));
      const hostComponent = item.npm && String(item.npm).startsWith('@deepseek-ai/');
      return h('div', { key: item.name, className: 'dsh-mcp-pcard', role: 'button', tabIndex: 0, title: t('查看 README 介绍与插图'), 'aria-label': t('查看 {0} 的 README', [item.name]), onClick: () => loadAwesomeReadme(item), onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); loadAwesomeReadme(item); } }, onMouseEnter: () => prefetchReadme(item), onMouseLeave: cancelHoverPrefetch },
      h('div', { className: 'dsh-mcp-phead' },
        h('span', { className: 'dsh-mcp-pavatar', 'aria-hidden': true },
          String(item.name || '?').slice(0, 1).toUpperCase() || '?',
          repoKey ? h('img', {
            src: githubAvatarUrl(repoKey), alt: '', loading: 'lazy', referrerPolicy: 'no-referrer',
            // 头像加载失败就藏起图片（不删 React 管理的节点），露出底下的首字母，不留空白圆圈。
            onError: (e) => { e.currentTarget.style.display = 'none'; },
          }) : null),
        h('div', { className: 'dsh-mcp-piden' },
          h('h3', { className: 'dsh-mcp-pname', title: item.name }, item.name),
          h('div', { className: 'dsh-mcp-pmeta' },
            item.official ? h('span', { className: 'official' }, h('span', { className: 'odot', 'aria-hidden': true }), t('官方')) : null,
            item.official && repoLabel ? h('span', { className: 'pdot', 'aria-hidden': true }, '·') : null,
            repoLabel ? h('span', { className: 'dsh-mcp-prepo', title: metaTitle }, repoLabel) : null)),
        verifiedLabel ? h('span', { className: 'dsh-mcp-pverified', role: 'img', 'aria-label': verifiedLabel, title: sealTip || verifiedLabel }, h(VerifiedSeal, { size: 15 })) : null),
      h('div', { className: 'dsh-mcp-pdesc' }, item.description || item.name),
      h('div', { className: 'dsh-mcp-pchips' },
        shownChips.map((tag) => h('span', { key: tag, className: 'dsh-mcp-pchip' + (tag === npmPackage ? ' mono' : ''), title: tag === npmPackage ? npmPackage : undefined }, tag)),
        extraChips > 0 ? h('span', { className: 'dsh-mcp-pchip more', title: chips.slice(3).join(', ') }, '+' + extraChips) : null),
      h('div', { className: 'dsh-mcp-pfoot' },
        h(PluginCardFacts, {
          downloadsText: downloads && downloads > 0 ? wbFormatCount(downloads) : '',
          downloadsTitle: t('npm 近 30 天下载量'),
          starText: stars ? wbFormatCount(stars) : '',
          starTitle: '★ ' + stars,
          dateText: dateFact,
          dateTitle: t('核验日期来自目录批次核验，不是插件自身的更新时间'),
        }),
        h('div', { className: 'dsh-mcp-wb-card-actions', onClick: (e) => e.stopPropagation(), onKeyDown: (e) => e.stopPropagation() },
          item.npm
            ? (hostComponent
              ? h('span', { className: 'dsh-mcp-phost', title: t('DSH 宿主官方组件随宿主本体分发，无法也不需要从市场安装') }, h(Icon, { className: 'ico', d: ICONS.info, size: 11 }), t('宿主组件'))
              : h('button', { type: 'button', className: 'dsh-mcp-pbtn' + (installed ? ' installed' : ''), disabled: busy || isInstallRunning(item.name), onClick: () => installPlugin(item) }, installed ? t('已安装') : t('安装')))
            : h('span', { className: 'dsh-mcp-phost', title: t('该条目未提供 npm 包名，暂不支持安装') }, t('暂不支持安装')))));
    })) : null,
    tab === 'plugin' && awesomePageCount > 1 ? h(Pager, { page: safeAwesomePage, pageCount: awesomePageCount, total: sortedAwesome.length, onPage: setAwesomePage }) : null,
    // ── DSH 社区插件 README 预览（点卡片打开；插图来自 README 自身的相对/绝对地址）──
    readmeView
      ? h('div', { className: 'dsh-mcp-overlay', onClick: (e) => { if (e.target === e.currentTarget) closeReadme(); } },
          h('div', { ref: readmeNodeRef, className: 'dsh-mcp-modal dsh-mcp-wb-modal dsh-mcp-readme-modal', role: 'dialog', 'aria-modal': true, 'aria-label': t('{0} README 预览', [readmeView.item && readmeView.item.name ? readmeView.item.name : '']), tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeReadme(); } } },
            h('div', { className: 'dsh-mcp-detail-person' },
              h(Avatar, { url: githubAvatarUrl(readmeView.item?.repo, 88), name: readmeView.item?.name, className: 'dsh-mcp-detail-avatar' }),
              h('div', null,
                h('h3', null, readmeView.item && readmeView.item.name ? readmeView.item.name : ''),
                readmeView.item && readmeView.item.repo
                  ? h('div', { className: 'dsh-mcp-card-vendor', title: readmeView.item.repo }, String(readmeView.item.repo).replace(/^https?:\/\/github\.com\//i, ''))
                  : null,
              ),
            ),
            h('div', { className: 'dsh-mcp-readme-meta' },
              readmeView.item && readmeView.item.repo ? h(Badge, { title: readmeView.item.repo }, String(readmeView.item.repo).replace(/^https?:\/\/github\.com\//i, '')) : null,
              readmeView.item && readmeView.item.npm ? h(Badge, { title: readmeView.item.npm }, 'npm') : null,
              readmeView.source ? h(Badge, null, readmeView.source === 'npm' ? 'npm registry' : 'GitHub') : null),
            h(CommunityPresence, {
              call,
              repo: readmeView.item && readmeView.item.repo,
              owner: readmeView.item ? parseGithubRepoKey(readmeView.item.repo).split('/')[0] : '',
              compact: true,
            }),
            // README 可能很长：出口放在正文之前，打开即点得到。
            readmeView.item ? h(FeedbackLinks, {
              item: readmeView.item, kind: 'plugin',
              repo: readmeView.item.repo, homepage: readmeView.item.homepage,
              sourceLabel: readmeView.item.repo ? String(readmeView.item.repo).replace(/^https?:\/\/github\.com\//i, '') : '',
            }) : null,
            readmeView.loading
              ? h('p', { className: 'dsh-mcp-wb-modal-note', role: 'status' }, t('正在读取 README…'))
              : readmeView.ok
                ? h('div', { className: 'dsh-mcp-readme-body' }, renderReadmeBlocks(readmeView.markdown, readmeView.base))
                : h('p', { className: 'dsh-mcp-wb-error', role: 'alert' }, readmeView.error),
            readmeView.ok && readmeView.truncated ? h('p', { className: 'dsh-mcp-wb-modal-note' }, t('README 过长，已截断显示。')) : null,
            h('div', { className: 'dsh-mcp-modal-actions' },
              h(Btn, { onClick: closeReadme, children: t('关闭') }),
              readmeView.item && readmeView.item.npm ? h(Btn, { primary: true, icon: 'plus', disabled: busy || isInstallRunning(readmeView.item.name), onClick: () => { const target = readmeView.item; closeReadme(); installPlugin(target); } }, t('安装')) : null,
              h(Btn, { onClick: () => loadAwesomeReadme(readmeView.item, true), disabled: readmeView.loading, children: t('重新读取') })),
            // README 可能很长：右下角常驻「跳到末尾」。sticky 让它不随正文滚走，又留在
            // 弹层内部（焦点陷阱、Esc 与点遮罩关闭都不受影响）；外层不拦鼠标，只有按钮可点。
            readmeView.ok
              ? h('div', { className: 'dsh-mcp-readme-jump-wrap' },
                  h('button', {
                    type: 'button',
                    className: 'dsh-mcp-readme-jump',
                    title: t('滑动到 README 末尾'),
                    'aria-label': t('滑动到 README 末尾'),
                    onClick: () => {
                      const node = readmeNodeRef.current;
                      if (!node) return;
                      node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
                    },
                  }, h(Icon, { d: ICONS.down, size: 12 }), h('span', null, t('跳到末尾'))))
              : null))
      : null,
    // ── T04/R7：令牌弹窗（连接器 mcp.json 里的 ${...} 占位符）──
    // 设计约束：只收集用户输入并原样透传；槽位来自目录条目的 tokenSlots，
    // 同一占位符可能出现多次（同 server 的 env 与 header），按 placeholder 去重。
    tokenDialog
      ? (() => {
          const slots = [];
          const seen = new Set();
          for (const slot of tokenDialog.item.tokenSlots || []) {
            if (!slot || !slot.placeholder || seen.has(slot.placeholder)) continue;
            seen.add(slot.placeholder);
            slots.push(slot);
          }
          return h('div', { className: 'dsh-mcp-overlay dsh-mcp-front', onClick: (e) => !busy && e.target === e.currentTarget && setTokenDialog(null) },
            h('div', { className: 'dsh-mcp-modal dsh-mcp-wb-modal', role: 'dialog', 'aria-modal': true, 'aria-label': t('填写连接器凭据'), tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); setTokenDialog(null); } } },
              h('h3', null, t('填写 {0} 的凭据', [tokenDialog.item.name])),
              h('p', { className: 'dsh-mcp-wb-modal-note', role: 'note' },
                t('该连接器的配置里有 {0} 个占位符，需要你提供对应凭据才能生效。没填的会保持原样，安装后仍可在 MCP 配置里手动补全。', [slots.length])),
              slots.length
                ? h('div', { className: 'dsh-mcp-wb-tokenform' }, slots.map((slot) => h('label', { key: slot.placeholder, className: 'dsh-mcp-wb-tokenfield' },
                    h('span', { className: 'dsh-mcp-wb-tokenlabel' }, slot.placeholder + t('（{0}）', [
                      slot.container === 'header'
                        ? t('请求头 ') + slot.key
                        : slot.container === 'url'
                          ? t('URL 参数')
                          : t('环境变量 ') + slot.key,
                    ])),
                    h('input', {
                      type: 'password',
                      autoComplete: 'off',
                      disabled: busy,
                      value: tokenDialog.values[slot.placeholder] || '',
                      placeholder: t('留空表示稍后自行补全'),
                      onChange: (e) => {
                        const next = e.target.value;
                        setTokenDialog((current) => (current ? { ...current, values: { ...current.values, [slot.placeholder]: next } } : current));
                      },
                    }),
                  )))
                : h('p', { className: 'dsh-mcp-wb-modal-note' }, t('该连接器没有可填写的占位符，可直接安装。')),
              h('div', { className: 'dsh-mcp-modal-actions' },
                h(Btn, { onClick: () => setTokenDialog(null), disabled: busy, children: t('取消') }),
                h(Btn, { primary: true, icon: 'plus', disabled: busy, onClick: () => installConnector(tokenDialog.item, tokenDialog.values), children: busy ? t('安装中…') : t('带凭据安装') }),
              ),
            ),
          );
        })()
      : null,
    tab === 'expert' ? h(ExpertMarket, { call, key: 'expert-' + expertEpoch }) : null,
    // ── R8：OAuth 授权弹层（401 → 浏览器授权 → 自动重装）──
    authDialog
      ? h('div', { className: 'dsh-mcp-overlay dsh-mcp-front', onClick: (e) => !busy && e.target === e.currentTarget && closeAuthDialog() },
          h('div', { ref: authDialogRefNode, className: 'dsh-mcp-modal dsh-mcp-wb-modal', role: 'dialog', 'aria-modal': true, 'aria-label': t('授权 {0}', [authDialog.serverName]), tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); closeAuthDialog(); } } },
            h('h3', null, t('授权 {0}', [authDialog.serverName])),
            h('p', { className: 'dsh-mcp-wb-modal-note', role: 'note' },
              authDialog.status === 'authorized'
                ? t('{0}：授权成功，正在完成安装…', [authDialog.item?.name || authDialog.serverName])
                : authDialog.mode === 'manual-token'
                  ? t('该服务器没有提供标准 OAuth 授权发现，无法自动打开授权页。如果你已经从服务方拿到访问令牌，粘贴在下面即可安装。')
                  : t('该连接器要求在浏览器里完成一次登录授权。授权页会尝试自动打开；授权完成后这里会自动继续，无需手动刷新。')),
            authDialog.error
              ? h('p', { className: 'dsh-mcp-wb-modal-note', role: 'alert', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, authDialog.error)
              : null,
            authDialog.authorizeUrl
              ? h('label', { className: 'dsh-mcp-wb-tokenfield' },
                  h('span', { className: 'dsh-mcp-wb-tokenlabel' }, t('授权链接')),
                  h('input', {
                    type: 'text',
                    readOnly: true,
                    value: authDialog.authorizeUrl,
                    onFocus: (e) => e.target.select(),
                  }),
                  h(Btn, { icon: 'plus', disabled: busy, onClick: () => { call('wbOAuthOpen', { url: authDialog.authorizeUrl }); }, children: t('重新打开浏览器') }),
                )
              : null,
            authDialog.mode === 'manual-callback'
              ? h('div', { className: 'dsh-mcp-wb-tokenform' },
                  h('p', { className: 'dsh-mcp-wb-modal-note' },
                    t('该服务器只接受自定义协议回调，浏览器跳转后页面会打不开。请把地址栏里的完整地址复制到下面。')),
                  h('label', { className: 'dsh-mcp-wb-tokenfield' },
                    h('span', { className: 'dsh-mcp-wb-tokenlabel' }, t('粘贴完整回调地址')),
                    h('input', {
                      type: 'text',
                      autoComplete: 'off',
                      disabled: busy,
                      value: authDialog.callbackUrl || '',
                      placeholder: authDialog.redirectUri || '',
                      onChange: (e) => {
                        const next = e.target.value;
                        setAuthDialog((current) => (current ? { ...current, callbackUrl: next } : current));
                      },
                    }),
                    h(Btn, { primary: true, disabled: busy || !String(authDialog.callbackUrl || '').trim(), onClick: () => { submitAuthCallback(); }, children: t('提交回调') }),
                  ),
                )
              : null,
            h('div', { className: 'dsh-mcp-wb-tokenform' },
              h('label', { className: 'dsh-mcp-wb-tokenfield' },
                h('span', { className: 'dsh-mcp-wb-tokenlabel' }, t('也可以直接粘贴访问令牌')),
                h('input', {
                  type: 'password',
                  autoComplete: 'off',
                  disabled: busy,
                  value: authDialog.manualToken || '',
                  placeholder: t('粘贴访问令牌'),
                  onChange: (e) => {
                    const next = e.target.value;
                    setAuthDialog((current) => (current ? { ...current, manualToken: next } : current));
                  },
                }),
                h(Btn, { disabled: busy || !String(authDialog.manualToken || '').trim(), onClick: () => { submitAuthToken(); }, children: t('用令牌安装') }),
              ),
            ),
            h('div', { className: 'dsh-mcp-modal-actions' },
              h(Btn, { disabled: busy, onClick: () => closeAuthDialog(), children: t('取消') }),
            ),
          ),
        )
      : null,
    // ── 连接器详情弹层：安装前看真实 mcp.json ──
    connectorDetail
      ? h('div', { className: 'dsh-mcp-overlay', onClick: (e) => !busy && e.target === e.currentTarget && setConnectorDetail(null) },
          h('div', { ref: connectorDetailRef, className: 'dsh-mcp-modal dsh-mcp-wb-modal', role: 'dialog', 'aria-modal': true, 'aria-label': t('连接器详情'), tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); setConnectorDetail(null); } } },
            // 头像行与技能详情同款（detail-person）：图标 + 名称并排。
            h('div', { className: 'dsh-mcp-detail-person' },
              h(ConnectorAvatar, {
                call, connectorId: connectorDetail.id, name: connectorDetail.name,
                className: 'dsh-mcp-detail-avatar',
              }),
              h('div', null, h('h3', null, connectorDetail.name)),
            ),
            h(FeedbackLinks, {
              item: connectorDetail, kind: 'connector',
              sourceLabel: t('来源：WorkBuddy 官方分发'),
            }),
            // issue #3：R3 让 examples 占正文，description 只在没有 examples 时才出现——于是
            // NVIDIA App 这类「需先装本机客户端」的前置要求被整段藏掉。examples 在场时补一行
            // 说明，把要求原样透出（英文界面取 descriptionEn）。
            connectorDetail.displayFrom === 'examples' && (connectorDetail.description || connectorDetail.descriptionEn)
              ? h('p', { className: 'dsh-mcp-wb-modal-note' },
                  t('说明：{0}', [usesEnglish()
                    ? (connectorDetail.descriptionEn || connectorDetail.description)
                    : connectorDetail.description])) : null,
            // T02/R3：详情正文同样 examples 优先，description 兜底。
            connectorDetail.displayBody || connectorDetail.description
              ? h('p', { className: 'dsh-mcp-wb-modal-desc' }, connectorDetail.displayBody || connectorDetail.description) : null,
            // T02/R1：token 注入规则标注——只展示条数，不注入、不展示规则内容（X9 边界）。
            connectorDetail.injectionRuleCount
              ? h('p', { className: 'dsh-mcp-wb-modal-note', role: 'note' },
                  t('存在 {0} 条 token 注入规则（依赖 WB 账号体系，DSH 不代注入）。', [connectorDetail.injectionRuleCount]))
              : null,
            // T02/R3：基础元数据照常透出。
            connectorDetail.version || connectorDetail.authMode
              ? h('div', { className: 'dsh-mcp-card-tags' },
                  connectorDetail.version ? h(Badge, null, 'v' + connectorDetail.version) : null,
                  connectorDetail.authMode ? h(Badge, null, t('凭据: ') + connectorDetail.authMode) : null,
                )
              : null,
            // P0：授权状态（只看已安装的连接器）。此前 wbOAuthOverview 声明了却从没被调用，
            // 用户看不到「授权还有效吗 / 什么时候过期」——token 一过期就只剩一句连接失败。
            installedConnectorKeys.has(String(connectorDetail.id || '')) && (connectorAuth || connectorDetail.needsOAuth)
              ? h('div', { className: 'dsh-mcp-wb-examples' },
                  h('b', null, t('授权状态')),
                  connectorAuth?.loading
                    ? h('p', null, t('正在读取授权状态…'))
                    : connectorAuth?.authorized
                      ? h('p', null, connectorAuth.fresh === false
                          ? t('授权已过期（{0}），点「刷新授权」重新获取；刷不动会自动回到浏览器授权。', [authExpiryText(connectorAuth.expiresAt) || t('无有效期记录')])
                          : t('已授权{0}', [connectorAuth.expiresAt ? t('，有效期至 {0}', [authExpiryText(connectorAuth.expiresAt)]) : '']))
                      : h('p', null, connectorDetail.needsOAuth
                          ? t('尚未授权：安装时会引导你完成浏览器授权。')
                          : t('没有可用的授权记录。')),
                  connectorAuth?.refreshable
                    ? h('p', { className: 'dsh-mcp-wb-modal-note' }, t('服务器提供了 refresh_token：过期后可以在这里直接刷新，无需重走浏览器。'))
                    : null,
                  connectorAuth?.authorized
                    ? h('div', { className: 'dsh-mcp-wb-card-actions' },
                        h(Btn, { disabled: busy, onClick: () => refreshConnectorAuth(connectorDetail), children: t('刷新授权') }))
                    : connectorDetail.needsOAuth
                      ? h('div', { className: 'dsh-mcp-wb-card-actions' },
                          h(Btn, { disabled: busy, onClick: () => beginConnectorAuth(connectorDetail), children: t('去授权') }))
                      : null,
                )
              : null,
            connectorDetail.examples && connectorDetail.examples.length
              ? h('div', { className: 'dsh-mcp-wb-examples' },
                  h('b', null, t('用法示例')),
                  h('ul', null, connectorDetail.examples.slice(0, 4).map((example, index) => h('li', { key: index }, example))),
                )
              : null,
            // 本机固定依赖（issue #3）：本地客户端型连接器把绝对路径写死在 mcp.json 里。
            // 这里直接列出路径与静态检查结果；缺依赖时安装闸会拦住，不再写一条连不上的配置。
            connectorDetail.localDeps && connectorDetail.localDeps.length
              ? h('div', { className: 'dsh-mcp-wb-examples' },
                  h('b', null, t('本机依赖')),
                  h('ul', null, connectorDetail.localDeps.map((dep) => h('li', { key: dep.path },
                    dep.status === 'found'
                      ? t('已找到：{0}', [dep.path])
                      : dep.status === 'platform'
                        ? t('当前系统不支持：{0}', [dep.path])
                        : t('未找到：{0}', [dep.path])))),
                  connectorDetail.localDeps.some((dep) => dep.status !== 'found')
                    ? h('p', { className: 'dsh-mcp-wb-modal-note' },
                        t('本地客户端缺失时安装会失败；请先安装对应客户端，并开启它的 MCP / 集成访问后再重试。'))
                    : null,
                )
              : null,
            h('p', { className: 'dsh-mcp-wb-modal-note' },
              t(`安装 = 把该连接器的 mcpServers 合并写入当前作用域（与「导入 JSON」同一链路，同名跳过）。`) +
              (connectorDetail.skillCount ? t('另含 {0} 个连接器技能，如需请从技能市场或手动安装。', [connectorDetail.skillCount]) : '')),
            // OAuth 型连接器的逃生口：浏览器授权发现失败时仍可手填令牌；入口常驻在详情里，
            // 不必先点一次安装失败才出现。
            connectorDetail.installable && connectorDetail.needsOAuth
              ? h('div', { className: 'dsh-mcp-wb-examples' },
                  h('b', null, t('凭据来源')),
                  h('p', null, t('该连接器需要通过浏览器完成一次授权；如果你已经从服务方拿到访问令牌，也可以在这里直接填写。')),
                  h('div', { className: 'dsh-mcp-wb-card-actions' },
                    h(Btn, { disabled: busy, onClick: () => openManualTokenDialog(connectorDetail), children: t('我已有令牌') })),
                )
              : null,
            h('div', { className: 'dsh-mcp-modal-actions' },
              h(Btn, { onClick: () => setConnectorDetail(null), disabled: busy, children: t('取消') }),
              connectorDetail.installable
                ? h(Btn, { primary: true, icon: 'plus', disabled: busy, onClick: () => requestInstallConnector(connectorDetail), children: busy ? t('安装中…') : t('安装到全局') })
                : h('span', { className: 'dsh-mcp-wb-blocked' }, connectorDetail.blockedReason || t('不可安装')),
            ),
          ),
        )
      : null,
    // ── 技能详情弹层：安全报告 + 发布方 + 安装/卸载 ──
    skillDetail
      ? h('div', { className: 'dsh-mcp-overlay', onClick: (e) => !busy && e.target === e.currentTarget && closeSkillDetail() },
          h('div', { ref: skillDetailRef, className: 'dsh-mcp-modal dsh-mcp-wb-modal', role: 'dialog', 'aria-modal': true, 'aria-label': t('技能详情'), tabIndex: -1, onKeyDown: (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); closeSkillDetail(); } } },
            h('div', { className: 'dsh-mcp-detail-person' },
              h(Avatar, {
                url: skillDetail.iconUrl || githubAvatarUrl(skillDetail.homepage, 88),
                name: skillDetail.ownerName || skillDetail.publisher || skillDetail.namespace,
                className: 'dsh-mcp-detail-avatar',
              }),
              h('div', null,
                h('h3', null, skillDetail.name),
                h('div', { className: 'dsh-mcp-card-vendor' }, skillDetail.canonical || skillDetail.namespace || ''),
              ),
            ),
            h(CommunityPresence, {
              call, repo: skillDetail.homepage || skillDetail.upstreamUrl,
              owner: skillDetail.ownerName || skillDetail.publisher,
              avatar: skillDetail.iconUrl,
              updatedAt: skillDetail.updatedAt,
            }),
            h(FeedbackLinks, {
              item: skillDetail, kind: 'skill',
              // upstream_url（GitHub）优先，其次才是技能公开页：公开页不是仓库时
              // 不该占掉「去仓库」的位置。
              repo: parseGithubRepoKey(skillDetail.upstreamUrl)
                ? skillDetail.upstreamUrl
                : (parseGithubRepoKey(skillDetail.homepage) ? skillDetail.homepage : ''),
              homepage: skillDetail.homepage || skillDetail.upstreamUrl,
              sourceLabel: skillDetail.ownerName || skillDetail.publisher || t('SkillHub'),
            }),
            // 介绍先从列表项渲染（不必等详情回来），详情到达后原地替换为完整正文。
            skillDetail.description ? h('p', { className: 'dsh-mcp-wb-modal-desc' }, skillDetail.description) : null,
            skillDetail.loading
              ? h('p', { className: 'dsh-mcp-wb-modal-note' }, t('正在读取详情…'))
              : h('div', null,
                  skillDetail.detailError ? h('p', { className: 'dsh-mcp-wb-error' }, skillDetail.detailError) : null,
                  h('div', { className: 'dsh-mcp-card-tags' },
                    skillDetail.version ? h(Badge, null, 'v' + skillDetail.version) : null,
                    skillDetail.publisher ? h(Badge, null, skillDetail.publisher + (skillDetail.verifiedPublisher ? t('（已认证）') : '')) : null,
                    skillDetail.certifiedName ? h(Badge, { cls: 's-on' }, skillDetail.certifiedName) : null,
                    (installedSkills.get(skillInstalledKey(skillDetail)) || 0)
                      ? h(Badge, { cls: 's-on' }, t('安装于 {0}', [wbFormatDate(installedSkills.get(skillInstalledKey(skillDetail)))])) : null,
                    skillDetail.createdAt ? h(Badge, null, t('加入时间 {0}', [wbFormatDate(skillDetail.createdAt)])) : null,
                    skillDetail.updatedAt ? h(Badge, null, t('更新于 {0}', [relativeLabel(skillDetail.updatedAt)])) : null,
                    Array.isArray(skillDetail.security) ? skillDetail.security.map((status, index) => h(Badge, { key: index, cls: status === 'benign' ? 's-on' : '' }, t('安全: ') + status)) : null,
                  ),
                  skillDetail.changelog ? h('p', { className: 'dsh-mcp-wb-modal-note' }, t('最新版本说明：') + skillDetail.changelog) : null,
                  h('p', { className: 'dsh-mcp-wb-modal-note' },
                    t('安装 = 逐文件下载并 sha256 校验后写入 ~/.agents/skills/，即刻被 DSH 发现（无需重启）。已装版本重装即更新。')),
                ),
            h('div', { className: 'dsh-mcp-modal-actions' },
              h(Btn, { onClick: () => closeSkillDetail(), disabled: busy, children: t('关闭') }),
              installedSkills.has(skillInstalledKey(skillDetail))
                ? h(Btn, { danger: true, icon: 'trash', disabled: busy, onClick: () => uninstallSkill(skillDetail), children: t('卸载') })
                : h(Btn, { primary: true, icon: 'plus', disabled: busy || skillDetail.loading, onClick: () => installSkill(skillDetail), children: busy ? t('安装中…') : t('安装') }),
            ),
          ),
        )
      : null,
    // ── 社区 MCP 详情弹层：整卡点开，内容与交互对齐插件 README 弹层 ──
    // 只展示 Registry 已给的字段：command / args / env 只读，要改走「加入 MCP」预填。
    communityDetail
      ? h('div', { className: 'dsh-mcp-overlay', onClick: (e) => !busy && e.target === e.currentTarget && setCommunityDetail(null) },
          h('div', {
            ref: communityDetailRef,
            className: 'dsh-mcp-modal dsh-mcp-wb-modal',
            role: 'dialog',
            'aria-modal': true,
            'aria-label': t('社区 MCP 详情'),
            tabIndex: -1,
            onKeyDown: (e) => { if (e.key === 'Escape' && !busy) { e.stopPropagation(); setCommunityDetail(null); } },
          },
            h('div', { className: 'dsh-mcp-detail-person' },
              h(Avatar, {
                url: communityDetail.owner ? avatarProxyUrl('https://github.com/' + communityDetail.owner + '.png', 88) : '',
                name: communityDetail.title || communityDetail.name,
                className: 'dsh-mcp-detail-avatar',
              }),
              h('div', null,
                h('h3', null, communityDetail.title || communityDetail.name),
                h('div', { className: 'dsh-mcp-card-vendor', title: communityDetail.name }, communityDetail.name),
              ),
            ),
            h('div', { className: 'dsh-mcp-card-tags' },
              h(Badge, { cls: communityDetail.transport === 'http' ? 't-http' : 't-stdio' },
                communityDetail.transport === 'http' ? t('远程（需自备令牌）') : 'stdio'),
              communityDetail.version ? h(Badge, null, 'v' + communityDetail.version) : null,
              communityDetail.env.length ? h(Badge, null, t('需 {0} 个环境变量', [communityDetail.env.length])) : null,
              communityDetail.env.some((item) => item.secret) ? h(Badge, { cls: 's-warn' }, t('含密钥字段')) : null,
              communityJoined(communityDetail) ? h(Badge, { cls: 's-on' }, t('已加入')) : null,
            ),
            communityDetail.description
              ? h('p', { className: 'dsh-mcp-wb-modal-desc' }, communityDetail.description)
              : null,
            // 环境变量：默认值原样展示（可能含令牌），但绝不写进配置；是否落盘由用户在草稿里决定。
            communityDetail.env.length
              ? h('div', { className: 'dsh-mcp-wb-examples' },
                  h('b', null, t('环境变量')),
                  h('ul', null, communityDetail.env.map((item) => h('li', { key: item.name },
                    h('code', null, item.name),
                    ' · ' + (item.required ? t('必填') : t('可选')),
                    item.secret ? ' · ' + t('密钥') : '',
                    item.description ? ' — ' + item.description : '',
                    item.hasDefault ? ' · ' + t('默认值：') + item.default : ''))),
                )
              : null,
            communityDetail.runnable
              ? h('div', { className: 'dsh-mcp-wb-examples' },
                  h('b', null, t('启动命令')),
                  h('p', { className: 'dsh-mcp-cmdline' }, [communityDetail.command].concat(communityDetail.args || []).filter(Boolean).join(' ')))
              : communityDetail.remoteUrl
                ? h('div', { className: 'dsh-mcp-wb-examples' },
                    h('b', null, t('远程地址')),
                    h('p', { className: 'dsh-mcp-cmdline' }, communityDetail.remoteUrl))
                : null,
            h('p', { className: 'dsh-mcp-wb-modal-note' },
              t('社区 MCP 来自官方 MCP Registry，由社区提交；军械库未审核其代码，加入前请自行确认命令与环境变量。')),
            h('div', { className: 'dsh-mcp-modal-actions' },
              h(Btn, { disabled: busy, onClick: () => setCommunityDetail(null), children: t('关闭') }),
              externalHref(communityDetail.repoUrl)
                ? h('a', { className: 'dsh-mcp-btn', href: externalHref(communityDetail.repoUrl), target: '_blank', rel: 'noreferrer' }, t('仓库'))
                : null,
              communityJoined(communityDetail)
                ? h(Btn, { disabled: true, children: t('已加入') })
                : h(Btn, {
                    primary: true, icon: 'plus', disabled: busy,
                    // 先关详情再开草稿：两层弹层不叠加，焦点陷阱也不会互抢。
                    onClick: () => { const row = communityDetail; setCommunityDetail(null); openCommunityDraft(row); },
                    children: t('加入 MCP'),
                  }),
            ),
          ),
        )
      : null,
    // 社区条目的「加入 MCP」：与 MCP 页同一个表单，draft 模式（预填 + 提交走新增）。
    // 不静默写盘：用户必须在这层确认 command / args / env 后才落盘。
    h(AddEditModal, {
      open: !!communityDraft,
      initial: communityDraft,
      draft: true,
      onClose: () => setCommunityDraft(null),
      onSubmit: submitCommunityDraft,
      busy,
      scopeName: t('全局'),
    }),
    // 装备清单：导出 / 导入对比。只读，不自动安装。
    loadoutOpen
      ? h(LoadoutModal, {
          call,
          onClose: () => setLoadoutOpen(false),
          onLocate: locateLoadoutRow,
        })
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
  useI18nRevision(); // 宿主切语言后重渲染，模块级 getter 文案即时更新
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
    // info：componentDidCatch 拿到的 React 组件栈，只有它能把「哪个子组件抛的」说清楚，
    // 而控制台里的 console.error 用户在崩溃现场是抓不到、也不想抓的。
    this.state = { error: null, info: null, copyState: null };
    this.retry = this.retry.bind(this);
    this.copyDetails = this.copyDetails.bind(this);
    this.copyTimer = null;
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    // 只记录、不吞掉：控制台保留完整堆栈，用户回报时才有东西可看。
    console.error('[dsh-armory] panel crashed:', error, info);
    // OPT-20 · 6.1：同时留一份在 state 里，供「复制错误详情」一键带走。
    this.setState({ info });
  }
  componentWillUnmount() {
    // 复制反馈的 1.5s 定时器必须在卸载时清掉：否则它会在组件没了之后 setState，
    // 在开发态刷一条无害但吵人的告警，测试里也会留下悬挂的计时器。
    if (this.copyTimer) { clearTimeout(this.copyTimer); this.copyTimer = null; }
  }
  retry() {
    this.setState({ error: null, info: null, copyState: null });
  }
  // 复制成功/失败后的短暂反馈：1.5 秒后自动回到常态文案。
  finishCopy(state) {
    if (this.copyTimer) clearTimeout(this.copyTimer);
    this.setState({ copyState: state });
    this.copyTimer = setTimeout(() => {
      this.copyTimer = null;
      this.setState({ copyState: null });
    }, 1500);
  }
  // 拼诊断文本并写剪贴板。用户回报 bug 时最缺的三件事全在这里：什么时候、什么环境、
  // 哪一段栈。段落用方括号标出来，粘进 issue 里不需要额外解释。
  copyDetails() {
    const { error, info } = this.state;
    const text = [
      'dsh-armory panel crashed',
      'time: ' + new Date().toISOString(),
      'locale: ' + I18N_LOCALE,
      '[error]',
      String((error && error.stack) || error),
      '[componentStack]',
      String((info && info.componentStack) || '(unavailable)'),
    ].join('\n');
    // 与文件里其它复制点同一 idiom：优先 navigator.clipboard.writeText，被拒或非安全
    // 上下文（file://、http://）时回落到 copyText 的 textarea + execCommand 降级路径。
    const viaClipboard = typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function'
      ? navigator.clipboard.writeText(text).then(() => true, () => false)
      : Promise.resolve(false);
    viaClipboard
      .then((ok) => (ok ? true : copyText(text)))
      .then((ok) => this.finishCopy(ok ? 'ok' : 'fail'))
      .catch(() => this.finishCopy('fail'));
  }
  render() {
    const { error, copyState } = this.state;
    if (!error) return this.props.children;
    const copyLabel = copyState === 'ok'
      ? t('已复制')
      : copyState === 'fail'
        ? t('复制失败')
        : t('复制错误详情');
    return h('div', { className: 'dsh-mcp-panel-error', role: 'alert' },
      h('b', null, t('这个面板加载失败')),
      h('p', null, String((error && error.message) || error)),
      h('div', { className: 'dsh-mcp-panel-error-act' },
        h('button', { type: 'button', className: 'dsh-mcp-btn primary', onClick: this.retry }, t('重试')),
        h('button', { type: 'button', className: 'dsh-mcp-btn', onClick: this.copyDetails }, copyLabel),
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
// ── §1.5 命令面板（Ctrl+K）──────────────────────────────────────────────
// 为什么不是「再做一个搜索框」：这个插件已经有四个搜索框（MCP 列表、Skill 列表、
// 市场技能、市场连接器），每个只认自己那一页。用户记得「rea」这个名字，但不记得
// 它是 MCP 还是 Skill、在哪个页签——这才是真正花时间的地方。命令面板唯一的价值
// 就是跨页签按名字找东西，所以它必须能同时搜四类，并且选中即直达。
//
// 索引惰性加载：打开面板才拉清单（三发并发），关掉即释放。常驻内存没有意义——
// 面板是低频入口，而清单会随会话变化，缓存反而给出过期结果。
//
// 动作类只放「一定能做成」的：刷新、打开面板、五个分类跳转。不放「召唤专家」
// 这类需要上下文的操作——面板没有拿到当前会话，做出来只会是半个功能。
const PALETTE_GROUP_LIMIT = 6;
// 跨组件通道：命令面板选中某台 MCP / 要求刷新时，McpTab 可能还没挂载或正被
// 其它分类替换。与 openSkillFocus 同一套两段式（模块里留 pending + 已挂载则广播）。
let pendingMcpQuery = '';
const mcpQueryListeners = new Set();
function openMcpQuery(name) {
  const target = String(name || '').trim();
  if (!target) return;
  pendingMcpQuery = target;
  for (const listener of [...mcpQueryListeners]) {
    try { listener(target); } catch { /* 单个订阅者失败不影响跳转 */ }
  }
  openBoardCategory('mcp');
}
const onMcpQuery = (listener) => {
  mcpQueryListeners.add(listener);
  return () => { mcpQueryListeners.delete(listener); };
};
const mcpRefreshListeners = new Set();
function emitMcpRefresh() {
  for (const listener of [...mcpRefreshListeners]) {
    try { listener(); } catch { /* 同上 */ }
  }
}
const onMcpRefresh = (listener) => {
  mcpRefreshListeners.add(listener);
  return () => { mcpRefreshListeners.delete(listener); };
};

const CommandPalette = ({ open, onClose, call, category, onJump }) => {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(null); // { mcp: [], skill: [], expert: [] } | null
  const [indexError, setIndexError] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef(null);
  const listRef = useRef(null);
  // OPT-21：命令面板容器此前没有 ref。注意它的输入框 effect 已把焦点送进输入框，
  // 陷阱的初焦点逻辑检测到 activeElement 已在容器内就不会抢，两者不冲突。
  const cmdkRef = useRef(null);
  useFocusTrap(cmdkRef, open);
  // 每次打开重新拉：清单随会话变，缓存过期比多一次请求更麻烦。
  useEffect(() => {
    if (!open) { setQuery(''); setCursor(0); setIndexError(''); return; }
    let alive = true;
    setIndex(null);
    Promise.all([
      call('list').catch(() => null),
      call('listSkills', skillScopeArg('global')).catch(() => null),
      call('wbExpertInstalled').catch(() => null),
    ]).then(([mcpRes, skillsRes, expertRes]) => {
      if (!alive) return;
      const servers = mcpRes?.ok && Array.isArray(mcpRes.servers) ? mcpRes.servers : [];
      const skills = skillsRes?.ok && Array.isArray(skillsRes.skills) ? skillsRes.skills : [];
      const experts = expertRes?.ok && Array.isArray(expertRes.presets) ? expertRes.presets : [];
      setIndex({
        mcp: servers.map((s) => ({
          name: s.serverName,
          desc: [s.transport, typeof s.toolCount === 'number' ? t('{0} 工具', [s.toolCount]) : '', s.disabled ? t('已禁用') : ''].filter(Boolean).join(' · '),
          disabled: s.disabled === true,
        })),
        skill: skills.map((s) => ({ name: s.name, desc: s.description || s.whenToUse || s.source || '' })),
        expert: experts.map((e) => ({ name: e.plugin, desc: e.presetId || '', raw: e })),
      });
    }).catch((e) => { if (alive) setIndexError(String(e?.message || e)); });
    return () => { alive = false; };
  }, [call, open]);
  // 打开后聚焦输入框：面板的唯一入口是键盘，落地就应该能打字。
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const q = query.trim().toLowerCase();
  const hit = (text) => !q || String(text || '').toLowerCase().includes(q);

  // 行模型统一：group + name + desc + hint + run。跳转与动作各占一组，
  // 搜索命中按类别分组——分组不是装饰，它让「同名的 MCP 和技能」不再混淆。
  const rows = useMemo(() => {
    const out = [];
    // 无输入时先给动作与跳转（面板刚打开的默认视图就该是「能做什么」）。
    for (const cat of BOARD_CATEGORIES) {
      if (!hit(cat.label) && !hit(CATEGORY_BLURB[cat.key])) continue;
      out.push({
        key: 'go:' + cat.key,
        group: t('跳转'),
        name: cat.label,
        desc: CATEGORY_BLURB[cat.key] || '',
        hint: category === cat.key ? t('当前') : t('打开'),
        icon: cat.icon,
        run: () => { onJump(cat.key); onClose(); },
      });
    }
    const actions = [
      { key: 'act:refresh', name: t('刷新 MCP 状态'), desc: t('重新读取服务器与工具清单'), icon: 'refresh', run: () => { emitMcpRefresh(); onJump('mcp'); onClose(); } },
      { key: 'act:panel', name: t('打开悬浮管理面板'), desc: t('在不离开会话的情况下查看 MCP'), icon: 'board', run: () => { openBoardPanel(); onClose(); } },
    ];
    for (const act of actions) {
      if (!hit(act.name) && !hit(act.desc)) continue;
      out.push({ ...act, group: t('动作'), hint: '' });
    }
    if (index) {
      for (const s of index.mcp) {
        if (!hit(s.name) && !hit(s.desc)) continue;
        out.push({
          key: 'mcp:' + s.name,
          group: 'MCP',
          name: s.name,
          desc: s.desc,
          hint: s.disabled ? t('已禁用') : t('筛选'),
          icon: 'plug',
          run: () => { openMcpQuery(s.name); onClose(); },
        });
      }
      for (const s of index.skill) {
        if (!hit(s.name) && !hit(s.desc)) continue;
        out.push({
          key: 'skill:' + s.name,
          group: 'Skill',
          name: s.name,
          desc: s.desc,
          hint: t('查看'),
          icon: 'skill',
          run: () => { openSkillFocus(s.name); onClose(); },
        });
      }
      for (const e of index.expert) {
        if (!hit(e.name) && !hit(e.desc)) continue;
        out.push({
          key: 'expert:' + e.name,
          group: t('专家'),
          name: e.name,
          desc: e.desc,
          hint: t('打开'),
          icon: 'expert',
          run: () => { onJump('expert'); onClose(); },
        });
      }
    }
    // 分组内截断：跨四类全量铺开会有上百行，键盘走不动，扫描也失效。
    // 截断只影响展示，输入更多字符就能看到更精确的结果，比「加载更多」诚实。
    const seen = new Map();
    return out.filter((row) => {
      const n = (seen.get(row.group) || 0) + 1;
      seen.set(row.group, n);
      return n <= PALETTE_GROUP_LIMIT;
    });
  }, [index, q, category, onJump, onClose]);

  // 结果集变化时游标归零：否则回车会落到一个已被过滤掉的位置上。
  useEffect(() => { setCursor(0); }, [q, index]);
  const clampedCursor = rows.length ? Math.min(cursor, rows.length - 1) : 0;
  // 选中行滚进视野：键盘上下移动时看不到高亮就等于没有高亮。
  useEffect(() => {
    const box = listRef.current;
    if (!box) return;
    const el = box.querySelector('[data-cursor="' + clampedCursor + '"]');
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [clampedCursor, rows.length]);

  if (!open) return null;
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
    if (e.key === 'ArrowDown' || (e.key === 'n' && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => (rows.length ? (Math.min(c, rows.length - 1) + 1) % rows.length : 0));
      return;
    }
    if (e.key === 'ArrowUp' || (e.key === 'p' && e.ctrlKey)) {
      e.preventDefault();
      setCursor((c) => (rows.length ? (Math.min(c, rows.length - 1) + rows.length - 1) % rows.length : 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[clampedCursor];
      if (row) row.run();
    }
  };

  // 分组渲染：rows 已按组连续排列（跳转→动作→MCP→Skill→专家），顺序扫一遍即可，
  // 不必再建 Map 保持插入序。
  const groups = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.name === row.group) last.rows.push(row);
    else groups.push({ name: row.group, rows: [row] });
  }
  let flat = -1;
  return h('div', { className: 'dsh-mcp-cmdk-overlay', onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
    h('div', { ref: cmdkRef, className: 'dsh-mcp-cmdk', role: 'dialog', 'aria-modal': true, 'aria-label': t('命令面板'), onKeyDown },
      h('div', { className: 'dsh-mcp-cmdk-head' },
        h(Icon, { d: ICONS.search, size: 14 }),
        h('input', {
          ref: inputRef,
          className: 'dsh-mcp-cmdk-input',
          value: query,
          placeholder: t('搜索 MCP、技能、专家，或跳转分类…'),
          onChange: (e) => setQuery(e.target.value),
          'aria-label': t('搜索'),
        }),
        h('span', { className: 'dsh-mcp-cmdk-kbd' }, 'Esc'),
      ),
      h('div', { className: 'dsh-mcp-cmdk-list', ref: listRef },
        indexError ? h('div', { className: 'dsh-mcp-cmdk-group' }, indexError) : null,
        !index && !indexError ? h('div', { className: 'dsh-mcp-cmdk-group' }, t('正在读取清单…')) : null,
        groups.map((group) => h('div', { key: group.name },
          h('div', { className: 'dsh-mcp-cmdk-group' }, group.name),
          group.rows.map((row) => {
            flat += 1;
            const on = flat === clampedCursor;
            return h('button', {
              key: row.key,
              type: 'button',
              'data-cursor': flat,
              className: 'dsh-mcp-cmdk-item' + (on ? ' on' : ''),
              onMouseEnter: () => setCursor(flat),
              onClick: row.run,
            },
              h(Icon, { d: ICONS[row.icon] || ICONS.plug, size: 13 }),
              h('span', { className: 'dsh-mcp-cmdk-item-main' },
                h('span', { className: 'dsh-mcp-cmdk-item-name' }, row.name),
                row.desc ? h('span', { className: 'dsh-mcp-cmdk-item-desc' }, row.desc) : null,
              ),
              row.hint ? h('span', { className: 'dsh-mcp-cmdk-item-hint' }, row.hint) : null,
            );
          }),
        )),
        index && !rows.length ? h('div', { className: 'dsh-mcp-cmdk-group' }, t('没有匹配项')) : null,
      ),
      h('div', { className: 'dsh-mcp-cmdk-foot' },
        h('span', null, h('b', null, '↑↓'), ' ', t('选择')),
        h('span', null, h('b', null, '↵'), ' ', t('执行')),
        h('span', null, h('b', null, 'Esc'), ' ', t('关闭')),
      ),
    ),
  );
};

// 跨分类跳转的 pending：与 pendingSkillFocus / pendingMcpQuery 同一套两段式。
// 为什么必须有它：boardCategoryListeners 只通知**当前已挂载**的订阅者，而跨分类跳转最
// 常见的触发场景恰恰是看板页还没挂载（从会话界面 / 浮层里点按钮）。广播无人接收就等于
// 目标分类永久丢失，挂载后只能回落到 hash 记忆或默认分类。
let pendingBoardCategory = '';

// 强制选中看板面板（不 toggle）。openBoardCategory 是「带目标的跳转」，语义上必须落到
// 看板页；而 openBoardPanel 的开关语义是给**入口按钮**用的（再点一次回对话），两者混用
// 就会出现「点『去市场找现成的』却被踢回会话」——分类广播刚发完，紧接着 openBoardPanel()
// 看到已在看板页，反手 selectPanel(null)。入口按钮的 toggle 行为是有意设计，不能动，
// 所以这里另开一条只进不退的通道。
function selectBoardPanel() {
  const ctx = MODULE_CTX.ctx;
  const layout = ctx && typeof ctx.get === 'function' ? ctx.get('layout') : null;
  if (!layout || typeof layout.selectPanel !== 'function') return;
  try {
    layout.selectPanel(PANEL_ID);
  } catch { /* main slot 里还没注册同 key 条目时宿主会抛：入口没响应比抛错好 */ }
}

function openBoardCategory(key) {
  // 只认 BOARD_CATEGORIES 里的 key：命令面板的分类行、召唤菜单的「管理」按钮传的是各自
  // kind，拼写漂移或新增 kind 未同步时宁可什么都不做，也不要选中一个不存在的分类。
  if (!BOARD_CATEGORIES.some((cat) => cat.key === key)) return;
  pendingBoardCategory = key;
  boardCategoryListeners.forEach((listener) => { try { listener(key); } catch { /* 单个订阅者失败不拖累其它 */ } });
  // 走强制选中而不是 openBoardPanel()：后者是开关，已在看板页时会把用户送回会话。
  selectBoardPanel();
}
const McpBoardPage = (props) => {
  const { call, timer, pluginManager } = props;
  useI18nRevision(); // 宿主切语言后整块看板重渲染，模块级 getter 文案即时更新
  // §1.2 URL 记忆：分类写进 hash，刷新 / 从别处退回 / 分享链接都能回到同一页。
  // 初值只在首帧读一次（useState 惰性初始化），之后由 effect 单向写出，
  // 不做 hash→state 的反向监听：宿主可能在任意时刻改 hash，双向同步必然互相打架。
  const [category, setCategoryState] = useState(() => {
    // pending 优先于 hash：用户刚刚点下的意图 > 上次留下的 URL 记忆。两者都不可用时
    // 才回落到默认分类。pending 在这里读、在下面的 effect 里清——惰性初始化只在首帧
    // 跑一次，不能承担副作用，所以只读取不消费。
    const focus = pendingBoardCategory;
    if (BOARD_CATEGORIES.some((cat) => cat.key === focus)) return focus;
    const fromHash = readHashParam('armory');
    return BOARD_CATEGORIES.some((cat) => cat.key === fromHash) ? fromHash : 'mcp';
  });
  const setCategory = useCallback((key) => {
    setCategoryState(key);
    writeHashParams({ armory: key });
  }, []);
  useEffect(() => {
    // 已挂载时的广播：领到就清 pending，与挂载自领走同一份状态，不会留下过期目标。
    const listener = (key) => {
      if (!BOARD_CATEGORIES.some((cat) => cat.key === key)) return;
      pendingBoardCategory = '';
      setCategory(key);
    };
    boardCategoryListeners.add(listener);
    // 挂载时自领 pending：从会话界面 / 浮层跳过来时广播早已发完（当时本组件还没挂载），
    // 目标分类只剩模块里这一份。与 pendingSkillFocus / pendingMcpQuery 完全同一套语义：
    // 领到就清空，避免下一次挂载被一条早已过期的意图劫持。
    const pending = pendingBoardCategory;
    pendingBoardCategory = '';
    if (pending && BOARD_CATEGORIES.some((cat) => cat.key === pending)) setCategory(pending);
    return () => { boardCategoryListeners.delete(listener); };
  }, [setCategory]);
  // §1.1 hover 摘要：记录当前悬停的 chip 与它的左偏移，浮层直接挂在分类条容器上，
  // 避免给每个 chip 各写一份定位逻辑（也避免 chip 内部的 overflow 裁掉浮层）。
  const [catHint, setCatHint] = useState(null); // { key, left }
  const catsRef = useRef(null);
  const showCatHint = useCallback((key, e) => {
    const el = e && e.currentTarget;
    const parent = catsRef.current;
    if (!el || !parent) return;
    const width = parent.clientWidth || 0;
    // 浮层最宽 300；靠右的 chip 会被推到边界内，宁可轻微左移也不出屏。
    const left = Math.max(0, Math.min(el.offsetLeft, Math.max(0, width - 300)));
    setCatHint({ key, left });
  }, []);
  const hideCatHint = useCallback(() => setCatHint(null), []);
  // 顶层分类计数：全部是「本机在手」数据，打开看板就先取齐，
  // 让 chip 数字常驻——而不是「进过哪一页才出现哪个」，视觉上才协调。
  // 四类里只有 Skill 会随用户操作变化（市场装/卸、看板卸载），所以它下面额外接了
  // 变更总线重取；其余三类仍是一次性读取。
  // 市场是唯一例外+特例：目录在远端（24MB ZIP），不能为个数字在打开看板时
  // 全量下载；这里调 wbConnectorCachedCount 只读磁盘缓存（绝不联网），
  // 用户没进过市场时返回 null（chip 暂不显示数字），进过一次后就常驻。
  const [skillCount, setSkillCount] = useState(null);
  const [mcpCount, setMcpCount] = useState(null);
  const [expertCount, setExpertCount] = useState(null);
  const [mkCount, setMkCount] = useState(null);
  const countsLoaded = useRef(false);
  // Skill 角标会在挂载后被反复重取（市场装/卸、Skill 看板卸载都会广播变更），用序号挡住
  // 乱序回包；读失败保留旧值——角标读不到不该把数字改成 0，也不该拖垮其它分类的计数。
  const skillCountSeq = useRef(0);
  const refreshSkillCount = useCallback(async () => {
    const seq = ++skillCountSeq.current;
    try {
      const res = await call('listSkills', skillScopeArg('global'));
      if (seq !== skillCountSeq.current) return;
      if (res && res.ok) setSkillCount(Array.isArray(res.skills) ? res.skills.length : null);
    } catch { /* 保留旧值 */ }
  }, [call]);
  useEffect(() => {
    if (countsLoaded.current) return;
    countsLoaded.current = true;
    let alive = true;
    refreshSkillCount();
    call('list').then((res) => {
      if (alive && res && res.ok && Array.isArray(res.servers)) setMcpCount(res.servers.length);
    }).catch(() => {});
    // 专家计数 = 已召唤预设数（本地文件，便宜）；与 Skill 同语义是「在手」而非「总量」。
    call('wbExpertInstalled').then((res) => {
      if (alive && res && res.ok && Array.isArray(res.presets)) setExpertCount(res.presets.length);
    }).catch(() => {});
    // 市场计数 = 本地缓存的连接器条数（零网络）；无缓存 → null，进过市场后才有。
    call('wbConnectorCachedCount').then((res) => {
      if (alive && res && res.ok && Number.isFinite(res.total)) setMkCount(res.total);
    }).catch(() => {});
    return () => { alive = false; };
  }, [call, refreshSkillCount]);
  // 关键：角标不再只在首次挂载读一次。市场装完就广播，这里直接重取数量并重渲染；
  // Skill 看板挂着时它自己的订阅负责刷新列表，没挂着时靠其挂载 effect 重读，路径不同但都不漏。
  useEffect(() => onSkillChange(() => { refreshSkillCount(); }), [refreshSkillCount]);
  // OPT-04：报告上提到这里，分类角标与 ToolTailor 页面本体共用同一份。
  // 扫描时机不再等进裁缝页——账本是本机文件，打开看板就扫，橙点角标才有数。
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
    if (tailorRequested.current) return;
    tailorRequested.current = true;
    let alive = true;
    call('toolTailor', { days: 30 }).then((res) => {
      if (alive && res && res.ok) setTailorReport(res);
    }).catch(() => {}).finally(() => { if (alive) setTailorSettled(true); });
    return () => { alive = false; };
  }, [call]);
  // 首次进入裁缝分类时若父层还在扫，就告诉子组件「等我的」（已扫完则为 false，子组件直接用 report prop）。
  const tailorSeedPending = category === 'tailor' && !tailorSettled;

  // §1.5 Ctrl+K：面板只在看板页挂载，所以快捷键也挂在这里——离开看板时不该
  // 还有监听器在抢键。同时提供「/」聚焦当前页搜索（只在没有输入焦点时生效，
  // 否则在搜索框里打斜杠就会跳走）。
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const isTyping = (el) => {
      if (!el) return false;
      const tag = String(el.tagName || '').toLowerCase();
      return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable === true;
    };
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
        return;
      }
      // '/' 聚焦搜索框：宿主会话页也把 '/' 当命令入口，所以这里必须避开输入态，
      // 并且只在事件目标不在可编辑元素内时才接管。
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isTyping(e.target)) {
        const box = document.querySelector('.dsh-mcp-page .dsh-mcp-search input, .dsh-mcp-page .dsh-mcp-tools-search input, .dsh-mcp-page .dsh-mcp-wb-search input, .dsh-mcp-page .dsh-mcp-skill-search input');
        if (box) { e.preventDefault(); box.focus(); box.select?.(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return h('div', { className: 'dsh-mcp-page' },
    h('div', { className: 'dsh-mcp-wrap' },
      // 分类栏与右端「点 Star」共行。star 刻意挂在 role=tablist **之外**：
      // tablist 里只该有 tab，把非 tab 控件塞进去会让读屏器的 tab 计数出错。
      h('div', { className: 'dsh-mcp-cats-row' },
        h('div', { className: 'dsh-mcp-cats', role: 'tablist', 'aria-label': t('看板分类'), ref: catsRef },
          BOARD_CATEGORIES.map((cat) =>
            h('button', {
              key: cat.key,
              type: 'button',
              role: 'tab',
              'aria-pressed': category === cat.key,
              'aria-selected': category === cat.key,
              className: 'dsh-mcp-cat',
              onClick: () => setCategory(cat.key),
              // §1.1 hover 摘要替代原来的 title 长文案：title 要等一秒、不可扫读、
              // 移动端根本没有。摘要用同一份数据渲染成两三行事实，鼠标停住就能读。
              onMouseEnter: (e) => showCatHint(cat.key, e),
              onMouseLeave: hideCatHint,
              onFocus: (e) => showCatHint(cat.key, e),
              onBlur: hideCatHint,
            },
              h(Icon, { d: ICONS[cat.icon], size: 14 }),
              cat.label,
              cat.key === 'mcp' && mcpCount !== null ? h('span', { className: 'dsh-mcp-cat-count' }, mcpCount) : null,
              cat.key === 'skill' && skillCount !== null ? h('span', { className: 'dsh-mcp-cat-count' }, skillCount) : null,
              cat.key === 'tailor' && tailorReport && typeof tailorReport.deadMcpCount === 'number' ? h('span', { className: 'dsh-mcp-cat-count' }, tailorReport.deadMcpCount) : null,
              cat.key === 'expert' && expertCount !== null ? h('span', { className: 'dsh-mcp-cat-count' }, expertCount) : null,
              cat.key === 'wb' && mkCount !== null ? h('span', { className: 'dsh-mcp-cat-count' }, mkCount) : null,
              // 异常红点：只在「这一页里有需要处理的东西」时出现，不参与布局也不改宽度。
              // 裁缝页的死 MCP 用 warn（橙）——它只是白交税，不是错误；
              // 若无死工具则完全不点，避免"每个标签都带点"导致红点失效。
              cat.key === 'tailor' && tailorReport && typeof tailorReport.deadMcpCount === 'number' && tailorReport.deadMcpCount > 0
                ? h('span', { className: 'dsh-mcp-cat-alert warn', 'aria-hidden': true })
                : null,
            )),
          catHint ? h(CatHintPopover, { hint: catHint, category, counts: { mcp: mcpCount, skill: skillCount, expert: expertCount, tailor: tailorReport, wb: mkCount } }) : null,
        ),
        h(RepoStarChip, { call }),
      ),
      // OPT-07：每个分类各自包一层错误边界。key 用分类名，切走再切回会重建边界，
      // 顺带让「重试」之外还有一条自然恢复路径。
      category === 'mcp'
        ? h(ArmoryPanelBoundary, { key: 'mcp', hint: t('MCP 列表加载失败；Skill、专家、裁缝、市场仍可正常使用。') }, h(McpTab, { call, timer, pluginManager, tailorReport }))
        : category === 'tailor'
          ? h(ArmoryPanelBoundary, { key: 'tailor', hint: t('工具账本加载失败；其余分类仍可正常使用。') }, h(ToolTailor, { call, timer, report: tailorReport, onReport: setTailorReport, seedPending: tailorSeedPending }))
          : category === 'expert'
            ? h(ArmoryPanelBoundary, { key: 'expert', hint: t('已召唤专家列表加载失败；其余分类仍可正常使用。') }, h(ExpertInstalledBoard, { call }))
            : category === 'wb'
              ? h(ArmoryPanelBoundary, { key: 'wb', hint: t('市场数据加载失败；其余分类仍可正常使用。') }, h(WorkBuddyMarket, { call, pluginManager }))
              : h(ArmoryPanelBoundary, { key: 'skill', hint: t('Skill 看板加载失败；其余分类仍可正常使用。') }, h(SkillBoard, { call, timer })),
      // 命令面板挂在最外层的 wrap 里：它自己是 fixed 浮层，位置与父元素无关，
      // 但放在这里可确保它和分类正文共享同一次渲染，不会因分类切换被重建。
      h(CommandPalette, { open: paletteOpen, onClose: () => setPaletteOpen(false), call, category, onJump: setCategory }),
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
// OPT-13 · 1.3 状态化：已读版本改存 JSON 状态键 dsh-armory.whatsNew.state
// （{"seen":"<版本>"}）。这是格式迁移不是键改名——旧裸键只做读回落，弹窗版本
// 比较语义不变，故不进 LEGACY_KEY_SUFFIXES（那是要改名的迁移表）。
const WHATS_NEW_STATE_KEY = 'dsh-armory.whatsNew.state';
const readWhatsNewSeen = () => {
  try {
    const raw = localStorage.getItem(WHATS_NEW_STATE_KEY);
    if (raw) {
      const state = JSON.parse(raw);
      if (state && typeof state.seen === 'string' && state.seen) return state.seen;
    }
  } catch { /* 新键缺失或 JSON 损坏：回落旧裸键（旧版格式迁移） */ }
  try { return localStorage.getItem(WHATS_NEW_SEEN_KEY); } catch { return null; /* 存储不可用：视为未读过 */ }
};
const writeWhatsNewSeen = (version) => {
  try { localStorage.setItem(WHATS_NEW_STATE_KEY, JSON.stringify({ seen: version })); } catch { return; /* 存储不可用：下次打开面板会再提示一次 */ }
  try { localStorage.removeItem(WHATS_NEW_SEEN_KEY); } catch { /* 旧裸键清理失败不报错，读回落仍兼容 */ }
};

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
  useI18nRevision(); // P1：宿主切语言后条目按新 locale 重新选择
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
        try { seen = readWhatsNewSeen(); } catch { /* 存储不可用：这次仍提示，只是下次还会提示 */ }
        const unseen = whatsNewFor(res.current, seen, res.entries);
        if (unseen.length) setNotice({ current: res.current, entries: unseen });
      })
      .catch(() => { /* 见上：提示失败不影响面板 */ });
    return () => { alive = false; };
  }, []);

  const dismiss = () => {
    try { if (notice?.current) writeWhatsNewSeen(notice.current); } catch { /* 存储不可用：本次关闭有效，下次打开面板会再提示一次 */ }
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
  // OPT-21：上面的 focusin 守卫解决「宿主抢焦点」，但 Tab 仍可走到弹层外；这里补上循环。
  useFocusTrap(boxRef, !!notice);

  if (!notice) return null;
  // 在渲染期按当前 locale 选择，而不是在 RPC 回包时固化：弹窗开着时切语言也能即时变。
  const localizedEntries = localizeWhatsNewEntries(notice.entries);
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
        localizedEntries.map((entry) =>
          h('div', { key: entry.version, className: 'dsh-mcp-whatsnew-entry' },
            // 一次跳多个版本时每条自带版本号；只报一条时标题里的版本号就够了。
            localizedEntries.length > 1 ? h('div', { className: 'dsh-mcp-whatsnew-ver' }, 'v' + entry.version) : null,
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

// 当前主面板 id：与 openBoardPanel 读同一份 layout.panelInfo 快照。
// 取不到（旧宿主 / layout 还没装好）就返回 undefined —— 悬浮按钮保持原样，不误隐藏。
function readActivePanelId() {
  try {
    const ctx = MODULE_CTX.ctx;
    const layout = ctx && typeof ctx.get === 'function' ? ctx.get('layout') : null;
    const info = layout && layout.panelInfo;
    const snapshot = info && typeof info.getSnapshot === 'function'
      ? info.getSnapshot()
      : (info && typeof info.getState === 'function' ? info.getState() : null);
    return snapshot && typeof snapshot.activePanelId === 'string' ? snapshot.activePanelId : undefined;
  } catch {
    return undefined;
  }
}
// 订阅宿主的面板切换。panelInfo 有 subscribe 就真订阅（zustand 风格 store），
// 没有就 1 秒轮询兜底——面板开合是低频事件，这个代价可以忽略。
const useActivePanelId = () => {
  const [active, setActive] = useState(readActivePanelId);
  useEffect(() => {
    let disposed = false;
    let off = null;
    let timer = 0;
    const bind = () => {
      if (disposed) return;
      const ctx = MODULE_CTX.ctx;
      const layout = ctx && typeof ctx.get === 'function' ? ctx.get('layout') : null;
      const info = layout && layout.panelInfo;
      if (!info) {
        timer = setTimeout(bind, 1000);
        return;
      }
      const read = () => { if (!disposed) setActive(readActivePanelId()); };
      read();
      if (typeof info.subscribe === 'function') {
        const stop = info.subscribe(read);
        if (typeof stop === 'function') off = stop;
        return;
      }
      timer = setInterval(read, 1000);
    };
    bind();
    return () => {
      disposed = true;
      clearTimeout(timer);
      clearInterval(timer);
      if (typeof off === 'function') off();
    };
  }, []);
  return active;
};

// ── 悬浮按钮宿主（shell.overlay）：只剩这一个席位 ────────────────────────────────
const McpOverlay = () => {
  useI18nRevision(); // 宿主切语言后重渲染，模块级 getter 文案即时更新
  const mode = useEntryMode();
  const activePanelId = useActivePanelId();
  // 看板页打开时自动收起：悬浮按钮固定在中栏之上，会直接盖住列表与详情文字（issue #4）。
  const fabVisible = fabVisibleFor(mode, activePanelId);
  const canHideFab = entryModeWithoutFab(mode) !== mode;
  const [pos, setPos] = useState(() => readFabPos() || defaultFabPos());
  const [menuOpen, setMenuOpen] = useState(false);
  const [hideHint, setHideHint] = useState(false);
  const fabRef = useRef(null);
  const menuRef = useRef(null);
  const dragRef = useRef(null);
  const suppressClickRef = useRef(false);
  const pressTimerRef = useRef(0);

  // 窗口尺寸变化时把按钮拉回可视区，避免记忆的位置因分辨率变化而出界。
  // 悬浮按钮不可见时不订阅：给一个看不见的按钮算位置只是白渲染。
  useEffect(() => {
    if (!fabVisible) return;
    const onResize = () => setPos((current) => clampFabPos(current.x, current.y));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [fabVisible]);

  // 按钮被隐藏（手动 / 看板页自动收起）时，菜单不能留在屏幕上。
  useEffect(() => {
    if (!fabVisible) setMenuOpen(false);
  }, [fabVisible]);

  // 菜单外侧点击 / Esc 关闭。菜单项自己的 click 由 stopPropagation 挡住，不会误关。
  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (event) => {
      if (menuRef.current && menuRef.current.contains(event.target)) return;
      setMenuOpen(false);
    };
    const onKey = (event) => { if (event.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('click', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  // 隐藏后的提示条自动收起（文案在渲染期取 t()，切语言即时变）。
  useEffect(() => {
    if (!hideHint) return;
    const id = setTimeout(() => setHideHint(false), 6000);
    return () => clearTimeout(id);
  }, [hideHint]);

  // 长按（触屏 / 手写笔）与右键都能叫出菜单；鼠标拖动与长按互不抢占。
  const cancelPressMenu = () => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = 0;
    }
  };
  useEffect(() => cancelPressMenu, []);

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
    if (event.pointerType && event.pointerType !== 'mouse') {
      cancelPressMenu();
      pressTimerRef.current = setTimeout(() => {
        pressTimerRef.current = 0;
        dragRef.current = null;
        suppressClickRef.current = true;
        setMenuOpen(true);
      }, FAB_MENU_PRESS_MS);
    }
  };
  const handlePointerMove = (event) => {
    const drag = dragRef.current;
    const el = fabRef.current;
    if (!drag || !el) return;
    const dx = event.clientX - drag.startClientX;
    const dy = event.clientY - drag.startClientY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    drag.moved = true;
    cancelPressMenu();
    drag.live = clampFabPos(drag.startX + dx, drag.startY + dy);
    // 跟手：直接写 DOM，不触发 React 渲染；松手时才 setPos 提交。
    el.style.left = drag.live.x + 'px';
    el.style.top = drag.live.y + 'px';
    el.style.cursor = 'grabbing';
  };
  const handlePointerEnd = () => {
    cancelPressMenu();
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
    // 菜单开着时，点按钮先把菜单收起（否则会同时打开看板 + 留下菜单）。
    if (menuOpen) { setMenuOpen(false); return; }
    openBoardPanel();
  };
  const handleContextMenu = (event) => {
    event.preventDefault();
    setMenuOpen(true);
  };
  const handleHideFab = () => {
    setMenuOpen(false);
    const next = entryModeWithoutFab(mode);
    if (next === mode) return;
    entryMode.set(next);
    setHideHint(true);
  };

  const style = { left: pos.x + 'px', top: pos.y + 'px', right: 'auto', bottom: 'auto' };
  // 菜单贴着按钮，但夹在视口内；下方放不下就翻到按钮上面。
  const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 768 : window.innerHeight;
  const menuWidth = 216;
  const menuHeight = canHideFab ? 78 : 112;
  const menuBelow = pos.y + FAB_SIZE + 8;
  const menuStyle = {
    left: Math.max(8, Math.min(pos.x, viewportWidth - menuWidth - 8)) + 'px',
    top: (menuBelow + menuHeight <= viewportHeight - 8
      ? menuBelow
      : Math.max(8, pos.y - menuHeight - 8)) + 'px',
    width: menuWidth + 'px',
  };

  return h(
    React2.Fragment,
    null,
    fabVisible ? h(
      'button',
      {
        ref: fabRef,
        type: 'button',
        className: 'dsh-mcp-fab',
        title: t('技能 · MCP · 专家看板（拖拽移动，右键或长按隐藏）'),
        'aria-label': t('打开技能 · MCP · 专家看板'),
        'aria-haspopup': 'menu',
        'aria-expanded': menuOpen,
        style,
        onClick: handleClick,
        onContextMenu: handleContextMenu,
        onPointerDown: handlePointerDown,
        onPointerMove: handlePointerMove,
        onPointerUp: handlePointerEnd,
        onPointerCancel: handlePointerEnd,
      },
      h(Icon, { d: ICONS.board, size: 22 }),
    ) : null,
    fabVisible && menuOpen ? h(
      'div',
      {
        ref: menuRef,
        className: 'dsh-mcp-tab-pop dsh-mcp-fab-menu',
        role: 'menu',
        'aria-label': t('悬浮按钮设置'),
        style: menuStyle,
        onClick: (event) => event.stopPropagation(),
        onContextMenu: (event) => event.preventDefault(),
      },
      h('button', {
        type: 'button',
        role: 'menuitem',
        className: 'dsh-mcp-entry-item dsh-mcp-fab-menu-item',
        disabled: !canHideFab,
        onClick: handleHideFab,
      }, t('隐藏悬浮按钮')),
      canHideFab
        ? null
        : h('p', { className: 'dsh-mcp-fab-menu-note' }, t('这是当前唯一入口；先到面板「入口」菜单切换模式。')),
    ) : null,
    hideHint ? h('div', { className: 'dsh-mcp-fab-hint', role: 'status' },
      t('悬浮按钮已隐藏，可从左上角「大肥鱼军械库」或面板「入口」菜单重新打开。')) : null,
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
    { id: 'dsh-armory#mcpManager/removeSkill', service: 'mcpManager', namespace: 'mcpManager', method: 'removeSkill', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    // 禁用 / 释放 skill（工具裁缝技能账本行内按钮）：写 SKILL.md frontmatter 的
    // disable-model-invocation 标志。与 typert.js、lib/index.js 三处同步，漏一处恒 404。
    { id: 'dsh-armory#mcpManager/disableSkill', service: 'mcpManager', namespace: 'mcpManager', method: 'disableSkill', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/enableSkill', service: 'mcpManager', namespace: 'mcpManager', method: 'enableSkill', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/skillInstallInfo', service: 'mcpManager', namespace: 'mcpManager', method: 'skillInstallInfo', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('SkillInstallInfoResult') },
    // 自定义套件：读全量集合 / 整集合覆盖保存（与 typert.js、lib/index.js 三处同步，
    // 漏一处这条通道恒 404 —— toolTailor、installInfo 各踩过一次）。
    { id: 'dsh-armory#mcpManager/listSkillSuites', service: 'mcpManager', namespace: 'mcpManager', method: 'listSkillSuites', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('SkillSuiteListResult') },
    { id: 'dsh-armory#mcpManager/saveSkillSuites', service: 'mcpManager', namespace: 'mcpManager', method: 'saveSkillSuites', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('SkillSuiteSaveResult') },
    // ── 工具裁缝：与 revealSkill 同批加入看板，但两端契约此前双双缺失（客户端永远 404）──
    { id: 'dsh-armory#mcpManager/toolTailor', service: 'mcpManager', namespace: 'mcpManager', method: 'toolTailor', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('TailorReport') },
    // ── WorkBuddy 市场直连：连接器 MCP + SkillHub 技能（同一命名空间同一信封）──
    { id: 'dsh-armory#mcpManager/wbConnectorCatalog', service: 'mcpManager', namespace: 'mcpManager', method: 'wbConnectorCatalog', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('WbCatalogResult') },
    // 顶栏「市场」chip 常驻计数：只读磁盘缓存（零网络），无缓存返回 { total: null }。
    { id: 'dsh-armory#mcpManager/wbConnectorCachedCount', service: 'mcpManager', namespace: 'mcpManager', method: 'wbConnectorCachedCount', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('WbCachedCountResult') },
    { id: 'dsh-armory#mcpManager/wbConnectorPreview', service: 'mcpManager', namespace: 'mcpManager', method: 'wbConnectorPreview', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WbPreviewResult') },
    // 市场连接器卡片头像：payload {connectorId}，出 {ok, dataUrl}。与宿主 method、typert.js 三处同步。
    { id: 'dsh-armory#mcpManager/wbConnectorIcon', service: 'mcpManager', namespace: 'mcpManager', method: 'wbConnectorIcon', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WbIconResult') },
    { id: 'dsh-armory#mcpManager/wbConnectorInstall', service: 'mcpManager', namespace: 'mcpManager', method: 'wbConnectorInstall', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/wbOAuthBegin', service: 'mcpManager', namespace: 'mcpManager', method: 'wbOAuthBegin', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/wbOAuthPoll', service: 'mcpManager', namespace: 'mcpManager', method: 'wbOAuthPoll', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/wbOAuthCancel', service: 'mcpManager', namespace: 'mcpManager', method: 'wbOAuthCancel', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/wbOAuthToken', service: 'mcpManager', namespace: 'mcpManager', method: 'wbOAuthToken', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/wbOAuthOverview', service: 'mcpManager', namespace: 'mcpManager', method: 'wbOAuthOverview', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/wbOAuthRefresh', service: 'mcpManager', namespace: 'mcpManager', method: 'wbOAuthRefresh', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/wbOAuthOpen', service: 'mcpManager', namespace: 'mcpManager', method: 'wbOAuthOpen', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/wbSkillCatalog', service: 'mcpManager', namespace: 'mcpManager', method: 'wbSkillCatalog', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WbSkillListResult') },
    { id: 'dsh-armory#mcpManager/wbSkillDetail', service: 'mcpManager', namespace: 'mcpManager', method: 'wbSkillDetail', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WbSkillDetailResult') },
    { id: 'dsh-armory#mcpManager/wbSkillInstall', service: 'mcpManager', namespace: 'mcpManager', method: 'wbSkillInstall', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/wbSkillUninstall', service: 'mcpManager', namespace: 'mcpManager', method: 'wbSkillUninstall', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/wbSkillInstalled', service: 'mcpManager', namespace: 'mcpManager', method: 'wbSkillInstalled', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('WbInstalledResult') },
    // T03/R4：多市场注册表（读 / 增改）。与宿主 method、typert.js 三处必须同步。
    { id: 'dsh-armory#mcpManager/wbMarketRegistry', service: 'mcpManager', namespace: 'mcpManager', method: 'wbMarketRegistry', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('WbMarketRegistryResult') },
    { id: 'dsh-armory#mcpManager/wbMarketRegistryUpsert', service: 'mcpManager', namespace: 'mcpManager', method: 'wbMarketRegistryUpsert', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WbMarketRegistryResult') },
    // T04/R8：安装状态账本（读全量 / 登记 / 忘记）。与宿主 method、typert.js 三处必须同步。
    { id: 'dsh-armory#mcpManager/wbInstallState', service: 'mcpManager', namespace: 'mcpManager', method: 'wbInstallState', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('InstallStateResult') },
    { id: 'dsh-armory#mcpManager/wbInstallStateRecord', service: 'mcpManager', namespace: 'mcpManager', method: 'wbInstallStateRecord', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    { id: 'dsh-armory#mcpManager/wbInstallStateForget', service: 'mcpManager', namespace: 'mcpManager', method: 'wbInstallStateForget', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('NoteResult') },
    // T06/Awesome：DSH 社区插件市场（awesome-dsh-plugins）。与宿主 method、typert.js 三处必须同步。
    { id: 'dsh-armory#mcpManager/wbAwesomeCatalog', service: 'mcpManager', namespace: 'mcpManager', method: 'wbAwesomeCatalog', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('AwesomeCatalogResult') },
    { id: 'dsh-armory#mcpManager/wbAwesomeDetail', service: 'mcpManager', namespace: 'mcpManager', method: 'wbAwesomeDetail', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('AwesomeDetailResult') },
  { id: 'dsh-armory#mcpManager/wbAwesomeReadme', service: 'mcpManager', namespace: 'mcpManager', method: 'wbAwesomeReadme', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('AwesomeReadmeResult') },
    { id: 'dsh-armory#mcpManager/wbAwesomeUpdateCheck', service: 'mcpManager', namespace: 'mcpManager', method: 'wbAwesomeUpdateCheck', invocation: { kind: 'direct' }, parameters: [], result: mcpCodec('WbUpdateHintResult') },
    // 社区 MCP（官方 MCP Registry v0，只读）：连接器页第二个来源。payload {search, cursor,
    // limit, takenNames}，返回 {ok, rows, nextCursor, fetchedAt, cached}。三处同步，漏一处恒 404。
    { id: 'dsh-armory#mcpManager/wbMcpCommunityList', service: 'mcpManager', namespace: 'mcpManager', method: 'wbMcpCommunityList', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WbMcpCommunityResult') },
    // 社区目录全库总数的有界统计（面板徽标常驻显示用）。payload {cursor, pages}，
    // 返回 {ok, counted, nextCursor, done, pages}。漏这一行 = 面板调它恒 404。
    { id: 'dsh-armory#mcpManager/wbMcpCommunityCount', service: 'mcpManager', namespace: 'mcpManager', method: 'wbMcpCommunityCount', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WbMcpCommunityCountResult') },
    // 社区元信息（仓库维护信号）：payload {repos, refresh}，返回 {repos:{repo:{...}}}。
    { id: 'dsh-armory#mcpManager/wbRepoMeta', service: 'mcpManager', namespace: 'mcpManager', method: 'wbRepoMeta', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WbRepoMetaResult') },
    // npm 近 30 天下载量：payload {packages, refresh}，返回 {packages:{pkg:{ok,downloads,...}}}。
    // 缺这一行 = 面板 call('wbNpmDownloads') 恒 404，卡片上那枚「↓」永远不出现。
    { id: 'dsh-armory#mcpManager/wbNpmDownloads', service: 'mcpManager', namespace: 'mcpManager', method: 'wbNpmDownloads', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('WbNpmDownloadsResult') },
    { id: 'dsh-armory#mcpManager/wbLoadoutExport', service: 'mcpManager', namespace: 'mcpManager', method: 'wbLoadoutExport', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('LoadoutResult') },
    { id: 'dsh-armory#mcpManager/wbLoadoutDiff', service: 'mcpManager', namespace: 'mcpManager', method: 'wbLoadoutDiff', invocation: { kind: 'direct' }, parameters: [mcpParam('payload', 'ImportPayload')], result: mcpCodec('LoadoutDiffResult') },
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
  // P0-2：apply 起止（相对 bundle materialize 起点）。开关关闭时 PERF_ON 为 false，空转。
  if (PERF_ON) perfMark('apply', 'start', performance.now() - PERF_T0);
  // OPT-25：先接宿主 locale（设置 → 通用里的语言），再注册槽位——槽位 label 是
  // 注册时求值的字符串，必须等这里算完。ctx.get 是可选读取，不写进 inject：
  // 老版本 DSH 没有 locale 服务时返回 undefined，自动回落 navigator/zh-CN。
  const readHostLocale = () => {
    try { return typeof ctx.get === 'function' ? ctx.get('locale') : null; } catch { return null; }
  };
  let hostLocaleService = readHostLocale();
  applyI18nLocale(resolveI18nLocale(hostLocaleService));
  const disposeMount = await ctx.remote.$mount(MCP_CONTRIBUTION);
  let disposeCss;
  let timer;
  let cleanupPromise;
  let disposeLocaleSub = null;
  let disposeServiceWatch = null;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      try {
        try { disposeLocaleSub?.(); } catch { /* 宿主订阅已失效 */ }
        try { disposeServiceWatch?.(); } catch { /* 宿主事件监听已失效 */ }
      } finally {
        try {
          timer?.dispose();
        } finally {
          try {
            disposeCss?.();
          } finally {
            await disposeMount();
          }
        }
      }
    })();
    return cleanupPromise;
  };

  try {
    disposeCss = __injectCss(MCP_CSS);
    timer = createTimer();
    MODULE_CTX.ctx = ctx;
    // P0-2：首个 business RPC 的方法名与往返耗时。第一次调用之后不再计时（只付一次分支）。
    let firstRpcDone = !PERF_ON;
    const call = async (method, args) => {
      const rpcStartedAt = firstRpcDone ? 0 : performance.now();
      try {
        const svc = (typeof ctx.get === 'function' ? ctx.get('remote.mcpManager') : null) || null;
        if (!svc || typeof svc[method] !== 'function') return { ok: false, error: t('MCP 市场服务未连接（面板仍可用）') };
        const r = args === undefined || args === null ? await svc[method]() : await svc[method](args);
        if (r && r.ok) return { ok: true, ...((r.value && typeof r.value === 'object') ? r.value : {}) };
        if (r && !r.ok) return { ok: false, error: (r.error && (r.error.message || r.error.code)) || t('调用失败') };
        return r;
      } finally {
        if (rpcStartedAt) {
          firstRpcDone = true;
          perfMark('firstRpc', 'ms', performance.now() - rpcStartedAt);
          if (perfBucket) perfBucket.firstRpc.method = method;
        }
      }
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
      ctx.slots.register({ name: 'main', key: PANEL_ID, label: panelLabel(), inject: () => ({ call, timer, pluginManager }) }, McpBoardPage),
    );
    // 输入框召唤菜单（conversation.input.right，list 型 slot）：权限/模型座位右侧的小图标，
    // 点开 = 技能/MCP/专家三分类 + 悬停最近使用子菜单。声明感知注入（会话 slot 由 conversation
    // 包声明，加载顺序不保证）；菜单组件自管开关与外部点击关闭。
    // sessionId 由 slot 渲染作为 prop 显式传入（session 座位约定：id 只走 props，不走 summary 投影），
    // 「挂专家」的人设通道 RPC 用它寻址当前会话。
    ctx.slots.inject('conversation.input.right', () =>
      ctx.slots.register({ name: 'conversation.input.right', id: PANEL_ID + '-quick', order: 40, label: panelLabel(), inject: (sessionId) => ({ call, sessionId }) }, SummonQuickMenu),
    );
    // 会话头「当前生效专家」徽章（conversation.session.header.actions，list 型 slot）：
    // 与宿主 AgentPresetLabel 同列——但显示的是人设通道真正生效的专家（expertActive），
    // 修复「换专家后顶栏仍显示第一次预设名」的显示/实效分叉。
    ctx.slots.inject('conversation.session.header.actions', () =>
      ctx.slots.register({ name: 'conversation.session.header.actions', id: PANEL_ID + '-head-expert', order: -5, label: panelLabel(), inject: (sessionId) => ({ call, sessionId }) }, SessionExpertBadge),
    );
    // 左上角全局面板行（sidebar.panellist）：「插件」旁边，主入口。行点击由宿主承担——
    // layout.selectPanel(PANEL_ID) 要求 main slot 里存在同 key 条目，上面的注册保证了这点。
    // 面板行不能用「渲染 null」隐藏（label 来自注册 options，不来自组件），所以按偏好
    // 在这里注册/注销，偏好运行期变化时走同一个同步函数。
    let disposePanelEntry = null;
    const syncPanelEntry = () => {
      const want = ENTRY_VISIBILITY[entryMode.get()].panel;
      if (want && !disposePanelEntry) disposePanelEntry = ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: PANEL_ORDER, label: sidebarEntryLabel() }, McpPanelIcon,
      );
      if (!want && disposePanelEntry) { disposePanelEntry(); disposePanelEntry = null; }
    };
    ctx.slots.inject('sidebar.panellist', () => { syncPanelEntry(); });
    entryMode.subscribe(syncPanelEntry);
    // OPT-25：宿主切换语言后重算字典并刷新槽位文案。
    // sidebar.panellist 的 label 来自注册参数而不是组件，只能 dispose + 重新注册；
    // 面板/菜单等内容组件通过 useI18nRevision 强制重渲染，getter 文案即时生效。
    const applyHostLocale = () => {
      const next = resolveI18nLocale(hostLocaleService);
      if (next === I18N_LOCALE) return;
      applyI18nLocale(next);
      // 只在入口已经注册过时重注册：否则可能在 sidebar.panellist 声明前直接
      // 调用 register（inject 的声明感知就白用了）。没注册过就没有旧文案可刷新，
      // 之后的 syncPanelEntry 会用新 locale 取 label。
      if (disposePanelEntry) {
        disposePanelEntry();
        disposePanelEntry = null;
        syncPanelEntry();
      }
      emitI18nChange();
    };
    const bindHostLocale = () => {
      const service = readHostLocale();
      if (!service) return;
      hostLocaleService = service;
      applyHostLocale();
      if (!disposeLocaleSub) disposeLocaleSub = subscribeI18nLocale(service, applyHostLocale);
    };
    bindHostLocale();
    // locale 插件可能晚于本插件完成 apply：服务注册时再绑一次（Cordis 内置事件）。
    // 老宿主没有该事件也无妨，启动时的 ctx.get 已经覆盖绝大多数加载顺序。
    if (typeof ctx.on === 'function') {
      disposeServiceWatch = ctx.on('internal/service', (name) => {
        if (name === 'locale') bindHostLocale();
      });
    }
    // 右下角悬浮按钮：保留既有能力，点击同样切到看板页。
    ctx.slots.inject('shell.overlay', () =>
      ctx.slots.register({ name: 'shell.overlay', id: 'mcp-fab', order: 1000, label: panelLabel(), inject: () => ({ call, timer, pluginManager }) }, McpOverlay),
    );
    // 左侧栏底部入口（sidebar.footer.action，0.1.5 起声明）：兼容入口，行为与面板行一致。
    // 用 inject 而不是直接 register：它声明感知，会等侧边栏把 slot 声明出来。
    ctx.slots.inject('sidebar.footer.action', () =>
      ctx.slots.register({ name: 'sidebar.footer.action', id: 'mcp-manager', order: 100, label: panelLabel() }, McpFooterAction),
    );
    if (PERF_ON) perfMark('apply', 'end', performance.now() - PERF_T0);
    return cleanup;
  } catch (error) {
    await cleanup();
    throw error;
  }
}
const inject = ['slots', 'remote', 'typert', 'remote.pluginManager'];
exports.apply = apply;
exports.inject = inject;
// P0-2：bundle 解析 + 全部组件定义完成的耗时（开关关闭时 perfMark 空转）。
if (PERF_ON) perfMark('module', 'materialize', performance.now() - PERF_T0);

		return module.exports;
	}
});
