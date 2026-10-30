// issue #4（2026-10-26）面板侧回归：详情空值覆盖、接口主页直出、悬浮按钮不可关。
//
// 三条用户可见症状都不是「文本写错」，正则改一改就能骗过去，所以这里照仓库既有风格
// （client-entry / market-pulse / install-toast）把 client.js 的几个**纯函数片段**抽进
// node:vm 真跑，再对组件接线做源码针：
//   ① 详情回包里的空串不能覆盖列表项已有的中文名 / 介绍（mergeSkillDetail）；
//   ② api.skillhub.cn 是 JSON 接口（405），渲染层不得把它当「来源主页」（browsableHomepageUrl）；
//   ③ 悬浮按钮要能右键 / 长按隐藏，且看板页打开时自动收起（entryModeWithoutFab / fabVisibleFor /
//      readActivePanelId）。「隐藏」是换成同组其它席位的档位，不能把入口全关。
//
// 每条正向断言都配反向自测：把旧写法在内存里算一遍，必须得到用户报的那个坏结果——否则
// 说明断言是空转。零网络、零写盘、不碰真实 ~/.dsh。
//
// 用法：node ./test/skillhub-ux-fix.mjs

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "..", "lib", "client.js");

let failures = 0;
let checks = 0;
const ok = (name, condition, extra = "") => {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};
const section = (title) => console.log(`\n── ${title} ─────────────────────────────────────────────`);

const source = await readFile(CLIENT, "utf8");

const sliceBetween = (startMarker, endMarker, label) => {
  const start = source.indexOf(startMarker);
  const end = start < 0 ? -1 : source.indexOf(endMarker, start + startMarker.length);
  ok(`能定位「${label}」片段`, start >= 0 && end > start, `start=${start} end=${end}`);
  return start >= 0 && end > start ? source.slice(start, end) : "";
};

// ═══════════════════════════════════════════════════════════════════════════
// 1. 详情合并：空值不得覆盖列表字段
// ═══════════════════════════════════════════════════════════════════════════
section("1. mergeSkillDetail / browsableHomepageUrl");
const SLICE_DETAIL_UTILS = sliceBetween(
  "// 详情接口的 homepage 历史上可能是",
  "const feedbackKindLabel",
  "详情合并与主页过滤",
);
const detailProbe = (() => {
  const context = vm.createContext({ console });
  vm.runInContext(`${SLICE_DETAIL_UTILS}
    globalThis.__probe = { mergeSkillDetail, browsableHomepageUrl };`, context, { filename: "skillhub-detail-utils.js" });
  return context.__probe;
})();
ok("片段能在 vm 里独立执行", !!detailProbe && typeof detailProbe.mergeSkillDetail === "function");

const { mergeSkillDetail, browsableHomepageUrl } = detailProbe;
{
  const listItem = {
    name: "全国招标中标查询及分析【知了标讯】",
    description: "列表里已有的完整介绍",
    updatedAt: 1792817295000,
    security: ["benign"],
    version: "2.5.5",
  };
  const goodDetail = {
    name: "",              // 旧映射的空值
    description: "",       // 旧映射的空值
    iconUrl: "https://example.com/i.png",
    security: [],          // 空数组也不能清掉列表安全态
    version: "2.5.6",
    homepage: "https://skillhub.cn/u/s",
  };
  const merged = mergeSkillDetail(listItem, goodDetail);
  ok("1.1 空 name / description 不覆盖列表项（标题不会退化成 slug、介绍不会空）",
    merged.name === listItem.name && merged.description === listItem.description);
  ok("1.2 有值字段照常覆盖（版本 / 图标 / 公开页）",
    merged.version === "2.5.6" && merged.iconUrl === "https://example.com/i.png" && merged.homepage === "https://skillhub.cn/u/s");
  ok("1.3 空数组不覆盖已有数组", JSON.stringify(merged.security) === JSON.stringify(["benign"]));
  ok("1.4 列表独占字段（updatedAt）不会被详情回包弄丢", merged.updatedAt === 1792817295000);
  ok("1.5 0 / false 是合法值，照常覆盖", mergeSkillDetail({ n: 1, b: true }, { n: 0, b: false }).n === 0
    && mergeSkillDetail({ n: 1, b: true }, { n: 0, b: false }).b === false);
  ok("1.6 极端输入不抛错", (() => {
    try { mergeSkillDetail(null, null); mergeSkillDetail(undefined, ""); return true; } catch { return false; }
  })());

  // 反向自测：旧写法 `{ ...skill, ...res }` 必须复现用户报的坏结果。
  const oldMerged = { ...listItem, ...goodDetail };
  ok("1.7 自测：旧写法确实会用空串清掉介绍（证明 1.1 不是恒真）",
    oldMerged.name === "" && oldMerged.description === "" && oldMerged.security.length === 0);
}
{
  ok("1.8 GitHub / 普通站点主页保留",
    browsableHomepageUrl("https://github.com/o/r") === "https://github.com/o/r"
    && browsableHomepageUrl("https://skillhub.cn/u/s") === "https://skillhub.cn/u/s");
  ok("1.9 api.skillhub.cn 的接口地址被拒绝（不渲染「来源主页」）",
    browsableHomepageUrl("https://api.skillhub.cn/u/s") === ""
    && browsableHomepageUrl("http://api.skillhub.cn/u/s?x=1") === "");
  ok("1.10 非 http(s) / 空值 / 形似域名不被误伤",
    browsableHomepageUrl("javascript:alert(1)") === ""
    && browsableHomepageUrl("") === ""
    && browsableHomepageUrl("https://api.skillhub.cn.evil.example/u/s") === "https://api.skillhub.cn.evil.example/u/s");
  // 反向自测：旧校验 `^https?://` 会放行 405 接口地址。
  ok("1.11 自测：旧校验确实会放行接口地址（证明 1.9 不是恒真）",
    /^https?:\/\//i.test("https://api.skillhub.cn/u/s"));
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. 入口档位：隐藏悬浮按钮而不关死所有入口
// ═══════════════════════════════════════════════════════════════════════════
section("2. entryModeWithoutFab / fabVisibleFor");
const SLICE_ENTRY = sliceBetween("const ENTRY_KEY = 'dsh-armory/entry';", "// ── 全局面板入口", "入口可见性表");
const SLICE_PANEL_AND_FAB = (() => {
  const a = source.indexOf("const PANEL_ID = 'mcp-manager';");
  const b = source.indexOf("// 入口排序", a);
  ok("能定位 PANEL_ID 与 fabVisibleFor", a >= 0 && b > a, `start=${a} end=${b}`);
  return a >= 0 && b > a ? source.slice(a, b) : "";
})();
const entryProbe = (() => {
  const context = vm.createContext({ console, t: (s) => s });
  vm.runInContext(`${SLICE_ENTRY}
    ${SLICE_PANEL_AND_FAB}
    globalThis.__probe = {
      ENTRY_VISIBILITY, ENTRY_MODES, entryModeWithoutFab, fabVisibleFor, PANEL_ID,
    };`, context, { filename: "skillhub-entry.js" });
  return context.__probe;
})();
ok("入口片段能在 vm 里独立执行", !!entryProbe && typeof entryProbe.entryModeWithoutFab === "function");

const { ENTRY_VISIBILITY, ENTRY_MODES, PANEL_ID, entryModeWithoutFab, fabVisibleFor } = entryProbe;
const SEATS = ["panel", "fab", "sidebar"];
ok("2.1 新增档位没有破坏「至少一个入口可见」",
  ENTRY_MODES.every((mode) => SEATS.some((seat) => ENTRY_VISIBILITY[mode][seat] === true)));
ok("2.2 新增「面板 + 侧栏、无悬浮按钮」档位",
  !!ENTRY_VISIBILITY.panelSidebar
  && ENTRY_VISIBILITY.panelSidebar.panel === true
  && ENTRY_VISIBILITY.panelSidebar.fab === false
  && ENTRY_VISIBILITY.panelSidebar.sidebar === true);
{
  const cases = [
    ["both", "panel"],
    ["all", "panelSidebar"],
  ];
  for (const [from, to] of cases) {
    const next = entryModeWithoutFab(from);
    ok(`2.3 ${from} 隐藏悬浮按钮 → ${to}`, next === to, `得到=${next}`);
    ok(`2.4 ${from} → ${to} 后 panel/sidebar 席位不变`,
      ENTRY_VISIBILITY[next].panel === ENTRY_VISIBILITY[from].panel
      && ENTRY_VISIBILITY[next].sidebar === ENTRY_VISIBILITY[from].sidebar
      && ENTRY_VISIBILITY[next].fab === false);
  }
  ok("2.5 仅悬浮按钮是唯一入口时无法隐藏（结果原样返回，调用方据此禁用）",
    entryModeWithoutFab("fab") === "fab");
  ok("2.6 本来就没有悬浮按钮的档位不变",
    entryModeWithoutFab("panel") === "panel" && entryModeWithoutFab("sidebar") === "sidebar");
}
{
  ok("2.7 看板页打开时悬浮按钮自动收起（mcp-manager）",
    fabVisibleFor("both", PANEL_ID) === false && fabVisibleFor("fab", PANEL_ID) === false);
  ok("2.8 回到会话（别的 panelId / undefined）按钮复现",
    fabVisibleFor("both", undefined) === true
    && fabVisibleFor("both", "some-chat") === true
    && fabVisibleFor("fab", "some-chat") === true);
  ok("2.9 入口偏好关掉时任何 panelId 都不显示",
    fabVisibleFor("panel", undefined) === false && fabVisibleFor("sidebar", "x") === false);
  // 反向自测：旧公式只看偏好，会把按钮一直盖在看板页上。
  const oldVisible = (mode) => ENTRY_VISIBILITY[mode].fab === true;
  ok("2.10 自测：旧公式在看板页仍显示按钮（证明 2.7 不是恒真）", oldVisible("both") === true);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. 宿主面板 id 的读取与失败回落
// ═══════════════════════════════════════════════════════════════════════════
section("3. readActivePanelId");
const SLICE_READ_ACTIVE = sliceBetween(
  "function readActivePanelId() {",
  "// 订阅宿主的面板切换",
  "readActivePanelId",
);
const runReadActive = (ctx) => {
  const context = vm.createContext({ console, MODULE_CTX: { ctx } });
  vm.runInContext(`${SLICE_READ_ACTIVE}
    globalThis.__probe = { readActivePanelId };`, context, { filename: "skillhub-active-panel.js" });
  return context.__probe.readActivePanelId;
};
{
  const withSnapshot = runReadActive({
    get: (name) => name === "layout" ? { panelInfo: { getSnapshot: () => ({ activePanelId: PANEL_ID }) } } : null,
  });
  ok("3.1 layout.panelInfo.getSnapshot 的 activePanelId 能读到", withSnapshot() === PANEL_ID);
  ok("3.2 没有 layout / ctx 时返回 undefined（按钮保持原样，不误隐藏）", runReadActive(null)() === undefined);
  const throwing = runReadActive({
    get: () => ({ panelInfo: { getSnapshot: () => { throw new Error("boom"); } } }),
  });
  ok("3.3 快照抛错时静默回落 undefined", throwing() === undefined);
  const withState = runReadActive({
    get: () => ({ panelInfo: { getState: () => ({ activePanelId: PANEL_ID }) } }),
  });
  ok("3.4 getSnapshot 缺席时兼容 getState", withState() === PANEL_ID);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. 组件接线（源码针：行为已在上面的纯函数里真跑，这里只防接线被改断）
// ═══════════════════════════════════════════════════════════════════════════
section("4. 面板接线");
{
  const openDetailAt = source.indexOf("const openSkillDetail = async (skill) => {");
  const openDetailBody = openDetailAt >= 0 ? source.slice(openDetailAt, source.indexOf("// 插件安装走宿主的", openDetailAt)) : "";
  ok("4.1 openSkillDetail 用 mergeSkillDetail 合并回包", openDetailBody.includes("mergeSkillDetail(skill, res)"));

  const overlayAt = source.indexOf("// ── 技能详情弹层");
  const overlayBody = overlayAt >= 0 ? source.slice(overlayAt, source.indexOf("// 装备清单：导出 / 导入对比", overlayAt)) : "";
  const descAt = overlayBody.indexOf("skillDetail.description ? h('p'");
  const loadingAt = overlayBody.indexOf("skillDetail.loading\n");
  ok("4.2 介绍在 loading 分支之外渲染（打开即有正文，不等详情）", descAt >= 0 && loadingAt > descAt);
  ok("4.3 详情页「来源主页」走 browsableHomepageUrl", source.includes("const home = browsableHomepageUrl(homepage || item?.homepage || item?.upstreamUrl);"));
  ok("4.4 GitHub 仓库优先取 upstreamUrl", source.includes("repo: parseGithubRepoKey(skillDetail.upstreamUrl)"));

  const fabAt = source.indexOf("const McpOverlay = () => {");
  const fabBody = fabAt >= 0 ? source.slice(fabAt, source.indexOf("// ── 定时器宿主", fabAt)) : "";
  ok("4.5 悬浮按钮订阅当前主面板并按看板页收起", fabBody.includes("useActivePanelId()")
    && fabBody.includes("fabVisibleFor(mode, activePanelId)"));
  ok("4.6 右键菜单 + 长按菜单都接上", fabBody.includes("onContextMenu: handleContextMenu")
    && fabBody.includes("FAB_MENU_PRESS_MS"));
  ok("4.7 隐藏项写入口偏好并给出重开提示",
    fabBody.includes("entryMode.set(next)") && fabBody.includes("setHideHint(true)")
    && fabBody.includes("dsh-mcp-fab-hint"));
  ok("4.8 唯一入口时隐藏项禁用（不产生全关状态）",
    fabBody.includes("disabled: !canHideFab") && fabBody.includes("entryModeWithoutFab(mode) !== mode"));
  ok("4.9 CSS 有菜单与提示条", source.includes(".dsh-mcp-tab-pop.dsh-mcp-fab-menu{") && source.includes(".dsh-mcp-fab-hint{"));
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. McpOverlay 真渲染：入口偏好订阅 + 看板页自动收起 + 右键隐藏
// ═══════════════════════════════════════════════════════════════════════════
// 纯函数说明「应该怎样」，这里证明组件真的接上了：用带依赖比较的 hook 垫片渲染
// McpOverlay，模拟 store 通知与右键，断言产出元素树里悬浮按钮 / 菜单 / 提示条的有无。
// 取不到真实宿主，但这条链（useEntryMode / useActivePanelId / entryMode.set）正是
// 用户报的「切了入口按钮没消失」所在的链。
section("5. McpOverlay 渲染：订阅与隐藏");
const SLICE_FAB_POS = sliceBetween("const FAB_POS_KEY", "// ── 入口显示偏好", "FAB 位置");
const SLICE_ACTIVE_PANEL = sliceBetween("// 当前主面板 id", "// ── 悬浮按钮宿主", "面板订阅 hook");
const SLICE_OVERLAY = sliceBetween("const McpOverlay = () => {", "// ── 定时器宿主", "McpOverlay 组件");

const createOverlayHarness = () => {
  const storage = new Map([["dsh-armory/entry", "both"]]);
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
  };
  const panel = {
    active: undefined,
    listeners: new Set(),
    getSnapshot() { return { activePanelId: this.active }; },
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); },
    setActive(id) { this.active = id; for (const listener of [...this.listeners]) listener(); },
  };
  const layout = { panelInfo: panel, selectPanel() {} };
  const ctx = { get: (name) => (name === "layout" ? layout : null) };
  // 真实记账 addEventListener / removeEventListener：卸载断言不能只看「没抛错」，
  // 必须证明挂上的监听确实被摘掉了。
  const listeners = new Map(); // `${target}:${type}` -> Set<handler>
  const trackAdd = (target, type, handler) => {
    const key = `${target}:${type}`;
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(handler);
  };
  const trackRemove = (target, type, handler) => {
    listeners.get(`${target}:${type}`)?.delete(handler);
  };
  const listenerCount = () => [...listeners.values()].reduce((n, set) => n + set.size, 0);
  const windowStub = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, handler) { trackAdd("window", type, handler); },
    removeEventListener(type, handler) { trackRemove("window", type, handler); },
  };
  const documentStub = {
    addEventListener(type, handler) { trackAdd("document", type, handler); },
    removeEventListener(type, handler) { trackRemove("document", type, handler); },
  };
  const context = vm.createContext({
    console,
    localStorage,
    window: windowStub,
    document: documentStub,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    MODULE_CTX: { ctx },
    __openBoardCalls: 0,
  });
  vm.runInContext(`
    const FAB_SIZE = 50;
    const FAB_EDGE = 22;
    const React2 = { Fragment: 'fragment' };
    const ICONS = { board: 'board' };
    const Icon = (props) => h('svg', { 'data-icon': props.d });
    const openBoardPanel = () => { globalThis.__openBoardCalls += 1; };
    const useI18nRevision = () => {};
    const t = (text) => text;
    const h = (type, props, ...kids) => ({
      type,
      props: props || {},
      children: kids.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    });
    let __current = null;
    const sameDeps = (a, b) => a !== undefined && b !== undefined && a.length === b.length
      && a.every((value, i) => Object.is(value, b[i]));
    const useState = (init) => {
      const inst = __current;
      const i = inst.cursor++;
      if (!(i in inst.state)) inst.state[i] = typeof init === 'function' ? init() : init;
      const set = (value) => { inst.state[i] = typeof value === 'function' ? value(inst.state[i]) : value; };
      return [inst.state[i], set];
    };
    const useRef = (initial) => {
      const inst = __current;
      const i = inst.cursor++;
      if (!(i in inst.state)) inst.state[i] = { current: initial };
      return inst.state[i];
    };
    const useEffect = (fn, deps) => {
      const inst = __current;
      const i = inst.cursor++;
      const prev = inst.hooks[i];
      if (!prev) {
        inst.hooks[i] = { fn, deps, cleanup: null };
        inst.pending.push(i);
      } else if (!sameDeps(prev.deps, deps)) {
        if (prev.cleanup) prev.cleanup();
        prev.fn = fn;
        prev.deps = deps;
        prev.cleanup = null;
        inst.pending.push(i);
      }
    };
    const useCallback = (fn) => fn;
    const useMemo = (fn) => fn();
    ${SLICE_FAB_POS}
    ${SLICE_ENTRY}
    ${SLICE_PANEL_AND_FAB}
    ${SLICE_ACTIVE_PANEL}
    ${SLICE_OVERLAY}
    globalThis.__probe = { McpOverlay, entryMode };
    globalThis.__mount = (Comp, props) => {
      const inst = { Comp, props, state: {}, cursor: 0, hooks: {}, pending: [], el: null };
      const draw = () => {
        inst.cursor = 0;
        inst.pending = [];
        const outer = __current;
        __current = inst;
        const el = Comp(inst.props);
        __current = outer;
        for (const i of inst.pending) {
          const hook = inst.hooks[i];
          const cleanup = hook.fn();
          hook.cleanup = typeof cleanup === 'function' ? cleanup : null;
        }
        inst.el = el;
        return el;
      };
      draw();
      return {
        get el() { return inst.el; },
        rerender: () => draw(),
        unmount: () => {
          for (const hook of Object.values(inst.hooks)) {
            if (hook.cleanup) hook.cleanup();
            hook.cleanup = null;
          }
        },
      };
    };
  `, context, { filename: "skillhub-overlay-harness.js" });
  return { probe: context.__probe, mount: (Comp, props) => context.__mount(Comp, props), panel, storage, context, listenerCount };
};

const findAll = (el, predicate, out = []) => {
  if (el && typeof el === "object") {
    if (predicate(el)) out.push(el);
    for (const child of el.children || []) findAll(child, predicate, out);
  }
  return out;
};
const hasClass = (name) => (el) => String(el?.props?.className || "").split(/\s+/).includes(name);
const textOf = (el) => (el?.children || []).map((child) => typeof child === "string" ? child : textOf(child)).join("");

try {
  const harness = createOverlayHarness();
  const view = harness.mount(harness.probe.McpOverlay, {});
  const fab = () => findAll(view.el, hasClass("dsh-mcp-fab"))[0] || null;
  const menu = () => findAll(view.el, hasClass("dsh-mcp-fab-menu"))[0] || null;

  ok("5.1 默认档位 both：悬浮按钮渲染出来", !!fab());
  harness.probe.entryMode.set("panel");
  view.rerender();
  ok("5.2 切到「仅全局面板」后按钮真的消失（订阅生效）", !fab());

  harness.probe.entryMode.set("both");
  view.rerender();
  ok("5.3 切回 both 后按钮复现", !!fab());

  harness.panel.setActive(PANEL_ID);
  view.rerender();
  ok("5.4 看板页占据中栏时按钮自动收起", !fab());
  harness.panel.setActive("some-chat");
  view.rerender();
  ok("5.5 回到会话后按钮自动复现", !!fab());

  const liveFab = fab();
  liveFab.props.onContextMenu({ preventDefault() {} });
  view.rerender();
  const liveMenu = menu();
  ok("5.6 右键弹出隐藏菜单", !!liveMenu);
  const hideItem = findAll(liveMenu, (el) => el.type === "button")[0] || null;
  ok("5.7 both 档位下隐藏项可用", !!hideItem && hideItem.props.disabled === false);

  hideItem.props.onClick();
  view.rerender();
  ok("5.8 点隐藏：档位落盘为 panel、按钮消失、给出重开提示",
    harness.storage.get("dsh-armory/entry") === "panel"
    && !fab()
    && findAll(view.el, hasClass("dsh-mcp-fab-hint")).length === 1);
  ok("5.9 提示文案说明可从左上角/入口菜单重开",
    textOf(findAll(view.el, hasClass("dsh-mcp-fab-hint"))[0]).includes("左上角"));

  harness.probe.entryMode.set("fab");
  view.rerender();
  const onlyFab = fab();
  onlyFab.props.onContextMenu({ preventDefault() {} });
  view.rerender();
  const menuFabOnly = menu();
  const disabledItem = findAll(menuFabOnly, (el) => el.type === "button")[0] || null;
  ok("5.10 仅悬浮按钮是唯一入口时，隐藏项禁用并解释原因",
    !!disabledItem && disabledItem.props.disabled === true
    && textOf(menuFabOnly).includes("唯一入口"));

  const mountedListeners = harness.listenerCount();
  view.unmount();
  ok("5.11 卸载时清理订阅与定时器（原本挂着的监听全部摘掉）",
    mountedListeners > 0 && harness.listenerCount() === 0,
    `before=${mountedListeners} after=${harness.listenerCount()}`);
} catch (error) {
  ok("5.12 渲染链路不抛错", false, String(error && error.stack || error));
}

console.log(`\n共 ${checks} 条断言：${failures === 0 ? "SKILLHUB-UX-FIX PASS" : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
