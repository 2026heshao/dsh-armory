// test/market-avatar.mjs
//
// 护栏对象：市场页头像的加载方式（2026-10-24 连着三单：「优化头像加载速度」
// ＋「头像真显示出来」＋「照 dshmarket 的加载逻辑改」）。
//
// 症状与真因（全部在本机实测，不是推测）：
//   · 卡片头像的唯一**源**是 `https://github.com/<login>.png`（awesome 的 slim.json、
//     插件目录都没有 icon/avatar 字段）；首页 50 张卡 = 100 个 <img>，只有 41 个不同
//     owner，一半请求是重复的。
//   · 直连那条源：github.com 的 302 回得很快（0.76s），慢在重定向落点 —— 跟完整重定向
//     链实测 14.7s，单发 10.7s 抛 "fetch failed"。浏览器在报错之前一直算「加载中」，
//     Chromium 每域约 6 条 HTTP/1.1 连接，100 个请求排队，整页陪着等；这段时间
//     CSS 画的 background + border 就是用户看到的空灰圈。
//   · 修法一（拆请求与显示）：首帧字母、后台 new Image() 探、同 URL 本次会话至多一次、
//     失败粘住、迟到的成功仍采纳。
//   · 修法二（换通道）：直连 `avatars.githubusercontent.com/<login>` 不能用 —— 大小写敏感
//     （perrylink 失败 / PERRYLINK 成功）、不存在的账号回 **200 + 占位图**（把「取不到」
//     变成「显示成别人的脸」）、6 并发就有一半挂到 12s；`api.github.com` 能拿 canonical
//     `/u/<id>` 但未认证只有 60 次/小时（实测剩 38），一屏 41 个 owner 就把配额打空。
//     最终走 `wsrv.nl` 代理 `github.com/<login>.png`（重定向由代理在服务端跟）：12 并发全绿、
//     单张 webp 0.1–2.7KB、`Cache-Control: max-age=31536000`、账号不存在干净回 404、零配额。
//     备胎 `images.weserv.nl` 实测是**同一个后端的不同域名**（同样 200、单张更慢），所以
//     做成有序路由两条；另两条加速域对头像地址是坏的（gh-proxy.com 404、ghfast.top 403）。
//   · 修法三（限并发）：换完通道在浏览器里 57 并发实测「1.5 秒内只上屏 3 张、中位 4825ms、
//     9 秒后仍有 30 张在途」，因为 wsrv.nl 在这台机只给 HTTP/1.1（ver=1.1），单张串行
//     0.58–2.46s（中位 1.7s）。所以同时在途只放 3 条、其余按挂载顺序排队，**且超时从真正
//     发出请求起算**（排队等名额不算它慢）—— 否则第 30 张还没上网就被判死，还是粘住的死。
//   · 修法四（视口门，抄 dshmarket 的 useNearViewport / CardShot）：闸门只是排队，
//     视口门是**根本不排队** —— 离视口 200px 以外的头像一次请求都不发，面板切走也不发。
//
// 本套件钉的就是这九条：首帧字母 / 同 URL 至多一次 / 失败粘住 / 迟到成功仍采纳 /
// 代理通道与有序路由与幂等 / 并发闸门与从发出起算的超时 / 视口门 / 登记表封顶 /
// 四类头像的接线口径。每一条都能被一次「顺手改回 <img src>」「把超时调回 1.5 秒」
// 「把视口门删掉更简单」无声踩穿，而踩穿之后只是变慢或退回字母，不报错，所以必须钉。
//
// 手法沿用 test/repo-star-chip.mjs：lib/client.js 是浏览器 bundle 不能 import，
// 于是把「社区信号」那一节（parseGithubRepoKey → PresenceLine）整段抽进 vm，配一个
// **带依赖比较的** hook 垫片真渲染它，对产出的元素树断言行为。零真实网络：Image 是替身，
// IntersectionObserver 也是替身（默认**不装**，即「宿主没有 IO」那条回退路径；要测视口门
// 就 buildEnv(patch, { io: true }) 显式装上，{ ioThrows: true } 再换成「构造就抛」的类，
// 模拟老内核不认 rootMargin —— 必须在构造器里真抛，用 string replace 换个非构造器进去
// 是不成立的模拟：observe() 才炸，测试会红在别处），定时器是手动推进的假时钟
// （超时这条路径必须能确定性地复现，不能让测试睡 4 秒）。
//
// 关于 rerender：垫片把状态存在实例数组里，setState 不会自己重绘。凡是「异步结算之后
// 界面变成什么」的断言，都必须显式再渲染一次才看得到——首帧那棵树是快照。
// 依赖比较不能省：Avatar 的 effect 依赖是 [key, near]，浏览器换 src 后触发的 onError 改
// 状态时**不会**重跑 effect（否则又立刻被 registry 的 ok 拉回 <img>，把破图退字母这条
// 逃生路测歪）。垫片按 React 的提交顺序**先挂 ref 再跑 effect**，否则 useNearViewport
// 读不到节点，视口门那条路径根本测不出来。
//
// 只用 node: 内置模块。用法：node ./test/market-avatar.mjs

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, "..", "lib", "client.js");
const ESLINTRC = join(HERE, "..", "eslint.config.mjs");

const START_MARKER = "const parseGithubRepoKey = (value) => {";
const END_MARKER = "// 详情级的维护信号";

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};

const source = await readFile(CLIENT, "utf8");
const eslintRc = await readFile(ESLINTRC, "utf8");

const startAt = source.indexOf(START_MARKER);
const endAt = source.indexOf(END_MARKER, startAt + START_MARKER.length);
ok(
  "能在 lib/client.js 里定位到头像所在的起止锚点",
  startAt >= 0 && endAt > startAt && source.indexOf(START_MARKER, startAt + 1) < 0 && source.indexOf(END_MARKER, endAt + 1) < 0,
  `start=${startAt} end=${endAt}`,
);
if (startAt < 0 || endAt <= startAt) {
  console.log("\nMARKET-AVATAR FAIL（锚点缺失，无法抽取待测源码）");
  process.exit(1);
}
const SLICE = source.slice(startAt, endAt);
ok(
  "抽出的片段含路由表、登记表、视口门、Avatar 与 PresenceLine",
  SLICE.includes("const avatarRouteCandidates = (src, size = 64) => {")
    && SLICE.includes("const avatarRecord = (routes) => {")
    && SLICE.includes("const useNearViewport = (rootMargin = AVATAR_VIEWPORT_MARGIN) => {")
    && SLICE.includes("const Avatar = ({ url, name, className }) => {")
    && SLICE.includes("const PresenceLine = ({"),
);

const shape = (node) => (node && typeof node === "object" ? (node.type === "span" ? `span:${node.props.className}` : node.type === "img" ? `img:${node.props.src}` : String(node.type && node.type.name ? node.type.name : node.type)) : String(node));
const flatText = (node) => {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flatText).join("");
  return flatText(node.children);
};

/**
 * 建一套干净环境：fresh registry / fresh 队列 / fresh 假时钟 / fresh Image 替身
 * （可选 fresh IntersectionObserver）。
 * 每个用例都自己建环境，避免模块级登记表把上一条的粘住失败带进来（那正是被测行为）。
 * `options.io` 默认 false = 宿主**没有** IntersectionObserver → 视口门按回退路径打开；
 * 要测「视口外不发请求」就显式传 { io: true }；{ ioThrows: true } 再模拟老内核
 * 构造观察者直接抛（钉住 catch 那条回落）。
 */
function buildEnv(patch, options = {}) {
  const withIO = options.io === true || options.ioThrows === true;
  const imageLog = [];
  const images = [];
  const observers = [];
  const timers = new Map();
  let clock = 0;
  let nextTimerId = 1;

  class FakeImage {
    constructor() {
      this.onload = null;
      this.onerror = null;
      this.referrerPolicy = "";
      this._src = "";
      images.push(this);
    }

    set src(value) {
      this._src = value;
      imageLog.push(value);
    }

    get src() {
      return this._src;
    }

    succeed() {
      if (typeof this.onload !== "function") throw new Error("替身没拿到 onload");
      this.onload();
    }

    fail() {
      if (typeof this.onerror !== "function") throw new Error("替身没拿到 onerror");
      this.onerror();
    }
  }

  class FakeIntersectionObserver {
    constructor(callback, opts) {
      this.callback = callback;
      this.options = opts || {};
      this.nodes = [];
      this.disconnected = false;
      observers.push(this);
    }

    observe(node) {
      this.nodes.push(node);
    }

    unobserve(node) {
      this.nodes = this.nodes.filter((item) => item !== node);
    }

    disconnect() {
      this.disconnected = true;
      this.nodes = [];
    }
  }

  // 老内核 / 受限宿主：构造观察者**就**抛。必须在构造器里真抛，`observer` 才会保持 null，
  // 于是 catch 分支只 setNear(true)、cleanup 那行 `if (observer) observer.disconnect()`
  // 也踩不到空对象。用 string replace 把 `new IntersectionObserver(` 换成 `new TypeError(`
  // 是不成立的模拟：构造 TypeError 不抛，接着 observer.observe() 才炸，测试会红在别处。
  class ThrowingIntersectionObserver {
    constructor() {
      throw new TypeError("本宿主不支持 IntersectionObserver");
    }
  }

  const context = vm.createContext({
    console,
    FakeImage,
    // avatarProxyHost 用 new URL(text).hostname 判来源域；vm 默认没有 URL，必须显式给，
    // 否则 `catch { return false; }` 把所有地址当成「不用代理」，代理那条就测了个寂寞。
    URL,
    // 视口门的替身。默认不装：属性存在但值为 undefined → `typeof IntersectionObserver
    // === 'undefined'` 成立 → near 初值 true → 走「全都探」的回退路径。
    IntersectionObserver: withIO ? (options.ioThrows === true ? ThrowingIntersectionObserver : FakeIntersectionObserver) : undefined,
    // 手动时钟：超时路径必须能确定性地按毫秒推进，不能让测试真睡 4 秒。
    setTimeout: (fn, ms) => {
      const id = nextTimerId++;
      timers.set(id, { fn, due: clock + Number(ms) });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    __advance: (ms) => {
      clock += Number(ms);
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.due <= clock) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    __now: () => clock,
    t: (text) => text,
    fmtLast: () => "很久以前",
  });

  vm.runInContext(
    `
    const Image = FakeImage;
    const h = (type, props, ...kids) => ({
      type,
      props: props || {},
      children: kids.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    });
    let __current = null;
    const sameDeps = (a, b) => {
      if (a === undefined || b === undefined) return false;
      if (a.length !== b.length) return false;
      return a.every((value, i) => Object.is(value, b[i]));
    };
    const useState = (init) => {
      const inst = __current;
      const i = inst.cursor++;
      if (!(i in inst.state)) inst.state[i] = typeof init === 'function' ? init() : init;
      const set = (value) => { inst.state[i] = typeof value === 'function' ? value(inst.state[i]) : value; };
      return [inst.state[i], set];
    };
    // useRef 必须像 useState 一样**跨渲染持久**（React 把 ref 对象存在 fiber 上）：
    // 每次渲染 new 一个 {current:null} 的话，useNearViewport 的 effect 永远读不到节点，
    // 视口门那条路径会测出一个假的「不发请求」。
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
      // 与 React 一致：**只在依赖变了或首次**才跑 effect；依赖没变时绝不能把上一次的
      // cleanup 调掉——那会把 waiter 摘走却不再挂回来，之后图片结算就再也通知不到实例，
      // 「超时后再等到成功」这类用例会测出一颗假的字母。
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
    ${patch === undefined ? SLICE : patch}
    globalThis.__probe = {
      Avatar, PresenceLine, ConnectorAvatar, githubAvatarUrl, avatarProxyUrl, avatarRouteCandidates, useNearViewport,
      avatarRegistry, avatarQueue, connectorIconCache, connectorIconPending,
      AVATAR_TIMEOUT_MS, AVATAR_REGISTRY_MAX, AVATAR_INFLIGHT_MAX,
      AVATAR_PROXY_BASES, AVATAR_PROXY_HOSTS, AVATAR_VIEWPORT_MARGIN,
      // 闸门的**真**计数：它是模块里的一个 let，外部只能靠行为反推。换成读快照条目
      // （dispatched && !released）就看不出「同一条目被重复占位/释放跑负」这类错，
      // 而那正是 12i/12j/12k 要钉的三条。
      get slots() { return avatarInflight; },
    };
    globalThis.__mount = (Comp, props) => {
      const inst = { Comp, props, state: {}, cursor: 0, hooks: {}, pending: [], el: null, node: null };
      const draw = (nextProps) => {
        if (nextProps !== undefined) inst.props = nextProps;
        inst.cursor = 0;
        inst.pending = [];
        const outer = __current;
        __current = inst;
        const el = Comp(inst.props);
        __current = outer;
        // React 的提交顺序：DOM 挂好 → ref → effect。视口门的 effect 要读 nodeRef.current，
        // 所以这里**必须先挂 ref 再跑 effect**，顺序反了就观察不到任何东西。
        if (el && el.props && el.props.ref) {
          if (!inst.node) inst.node = { fakeNode: true };
          if (typeof el.props.ref === 'function') el.props.ref(inst.node);
          else el.props.ref.current = inst.node;
        }
        for (const i of inst.pending) {
          const hook = inst.hooks[i];
          const cleanup = hook.fn();
          hook.cleanup = typeof cleanup === 'function' ? cleanup : null;
        }
        inst.el = el;
        return el;
      };
      const el = draw();
      return {
        get el() { return inst.el; },
        rerender: (nextProps) => draw(nextProps),
        unmount: () => {
          for (const hook of Object.values(inst.hooks)) { if (hook.cleanup) hook.cleanup(); hook.cleanup = null; }
          inst.state = {};
        },
      };
    };
    `,
    context,
    { filename: "market-avatar-slice.js" },
  );

  const probe = context.__probe;
  const nodeOf = (observer) => observer.nodes[0];
  return {
    probe,
    mount: (Comp, props) => context.__mount(Comp, props),
    imageLog,
    images,
    observers,
    advance: (ms) => context.__advance(ms),
    now: () => context.__now(),
    pendingTimers: () => timers.size,
    /** 已经发出过请求的条目数（含已结算的）—— 用来核对「换路由不重复占位」。 */
    dispatched: () => [...probe.avatarRegistry.values()].filter((rec) => rec.dispatched).length,
    /** **此刻**仍占用在途名额的条目数（已发出且未释放）。 */
    inflight: () => [...probe.avatarRegistry.values()].filter((rec) => rec.dispatched && !rec.released).length,
    /** 闸门自己的计数：跑负 / 翻倍只会在这里露出来（条目快照看不出来）。 */
    slots: () => probe.slots,
    /**
     * 把第 i 个观察者的节点报成「进入视口」。节点为空的（已 disconnect）也照样回调 ——
     * 真实浏览器里 disconnect 之后仍可能有一次在途回调落地，而「卸载后被报进视口不炸」
     * 正是要钉的行为；「有没有挂到节点」由 7c 与 12t 单独断言，不靠这里报错兜底。
     */
    enter: (i) => {
      const observer = observers[i];
      if (!observer) throw new Error(`没有第 ${i} 个 IntersectionObserver`);
      observer.callback([{ target: nodeOf(observer) ?? { stray: true }, isIntersecting: true }], observer);
    },
    /** 把第 i 个观察者的节点报成「没进视口」（钉住 isIntersecting 的判断）。 */
    leave: (i) => {
      const observer = observers[i];
      if (!observer) throw new Error(`没有第 ${i} 个 IntersectionObserver`);
      observer.callback([{ target: nodeOf(observer) ?? { stray: true }, isIntersecting: false }], observer);
    },
  };
}

// 输入仍是「源地址」，断言看的是**发出去的地址**：面板已经不再直连 github.com 了。
const URL_A = "https://github.com/octocat.png";
const URL_B = "https://github.com/torvalds.png";
const MAIN = "https://wsrv.nl/?output=webp&q=80";
const ALT = "https://images.weserv.nl/?output=webp&q=80";
const proxied = (base, owner, size = 64) => `${base}&w=${size}&h=${size}&url=${encodeURIComponent(`https://github.com/${owner}.png`)}`;
const PROXY_A = proxied(MAIN, "octocat");
const ALT_A = proxied(ALT, "octocat");
const PROXY_B = proxied(MAIN, "torvalds");
const PROXY_88 = (owner) => proxied(MAIN, owner, 88);
const CARD = "dsh-mcp-card-avatar";
const sourceOf = (url) => decodeURIComponent(new URL(url).searchParams.get("url"));

// ── 1. 首帧是字母，不是空灰圈 ───────────────────────────────────────────────
// 这一节跑在「宿主没有 IO」的环境：视口门在这种宿主上按回退路径打开，挂载即进队列
// （有 IO 的宿主单独在第 7 节测）。
{
  const env = buildEnv();
  const view = env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
  ok("1a 有 url 的首帧渲染的是 span 而不是 <img>（用户看到的不再是空灰圈）", view.el.type === "span", `实际=${shape(view.el)}`);
  ok("1b 首帧带 .fallback 类（有字母底色，不是裸 img 的 background+border）", view.el.props.className === `${CARD} fallback`, `实际=${view.el.props.className}`);
  ok("1c 字母取名称首字符并大写", flatText(view.el.children) === "O", `实际=${JSON.stringify(flatText(view.el.children))}`);
  ok("1d 占位对读屏隐藏（字母不是内容，名字在标题里已经念过）", view.el.props["aria-hidden"] === true);
  ok("1e 首帧没有 src —— 图片节点根本不在树上", view.el.props.src === undefined);
  ok("1f 首帧就把节点交给 ref（视口门要观察的就是这个字母 span）", Boolean(view.el.props.ref), `实际=${typeof view.el.props.ref}`);
  ok("1g 后台发出的一次探测走代理小图，不是直连 github.com", env.imageLog.length === 1 && env.imageLog[0] === PROXY_A, `实际=${JSON.stringify(env.imageLog)}`);
  ok("1h 替身带上了 referrerPolicy（沿用原来 <img no-referrer> 的隐私口径）", env.images[0].referrerPolicy === "no-referrer");
}

// ── 2. 同一个 URL 只发一次：卡片 + PresenceLine 合并 ─────────────────────────
{
  const env = buildEnv();
  const card = env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
  const line = env.mount(env.probe.PresenceLine, { owner: "octocat", avatar: URL_A, href: "https://github.com/octocat" });
  const avatarChild = (line.el.children || []).find((child) => child && child.type === env.probe.Avatar);
  ok("2a PresenceLine 的头像位也交给 Avatar（不是自己再写一个 <img>）", !!avatarChild, `子节点=${(line.el.children || []).map(shape).join(",")}`);
  ok("2b 卡片首帧同样是字母，而 PresenceLine 拿到的 url 与它完全同一个字符串 —— 合并的前提就是这两个字符串相等",
    !!avatarChild && avatarChild.props.url === URL_A && avatarChild.props.className === "dsh-mcp-presence-inline-avatar" && card.el.props.className === `${CARD} fallback`,
    `实际=${avatarChild && JSON.stringify(avatarChild.props)} 卡片=${card.el.props.className}`);
  env.mount(env.probe.Avatar, { url: avatarChild ? avatarChild.props.url : "", name: "octocat", className: "dsh-mcp-presence-inline-avatar" });
  ok("2c 卡片 + PresenceLine 两处挂载 = 仍然只发一次请求（首页 100 → 41 的那一半）", env.imageLog.length === 1, `实际=${JSON.stringify(env.imageLog)}`);
  env.mount(env.probe.Avatar, { url: URL_B, name: "torvalds", className: CARD });
  ok("2d 不同 owner 各发各的（合并不是把不同人也压成一张图）", env.imageLog.length === 2 && env.imageLog[1] === PROXY_B, `实际=${JSON.stringify(env.imageLog)}`);
}

// ── 3. PresenceLine 的既有契约没被改坏 ──────────────────────────────────────
{
  const env = buildEnv();
  const nothing = env.mount(env.probe.PresenceLine, { owner: "", avatar: "" });
  ok("3a 既没头像也没发布方时 PresenceLine 仍然整行不渲染（不多出 '?' 圆点）", nothing.el === null, `实际=${shape(nothing.el)}`);
  const letters = env.mount(env.probe.PresenceLine, { owner: "ada", avatar: "" });
  const child = (letters.el.children || []).find((c) => c && c.type === env.probe.Avatar);
  ok("3b 只有发布方没有头像时把空 url 交给 Avatar（走字母路径）", !!child && child.props.url === "" && child.props.name === "ada", `实际=${child && JSON.stringify(child.props)}`);
  env.mount(env.probe.Avatar, { url: child.props.url, name: child.props.name, className: "dsh-mcp-presence-inline-avatar" });
  ok("3c 无 url 时一次网络都不发", env.imageLog.length === 0, `实际=${JSON.stringify(env.imageLog)}`);
  const letter = env.mount(env.probe.Avatar, { url: "", name: "", className: CARD });
  ok("3d url 与 name 都空 → 问号占位，仍然不是空圈", letter.el.type === "span" && flatText(letter.el.children) === "?", `实际=${shape(letter.el)} ${JSON.stringify(flatText(letter.el.children))}`);
  const icon = env.mount(env.probe.Avatar, { url: "https://cdn.example.com/icon.png", name: "skill", className: CARD });
  ok("3e 技能自带图标（非 GitHub 域名）照样先出字母，地址原样交给浏览器", icon.el.type === "span" && env.imageLog.includes("https://cdn.example.com/icon.png"), `实际=${JSON.stringify(env.imageLog)}`);
}

// ── 4. 探到了才换图；换图后能退回字母 ────────────────────────────────────────
{
  const env = buildEnv();
  const view = env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
  env.images[0].succeed();
  view.rerender();
  ok("4a 图片加载成功后换成 <img>", view.el.type === "img", `实际=${shape(view.el)}`);
  ok("4b <img> 用原类名（字母不再盖在图上），src 是成功那条路由的地址", view.el.props.className === CARD && view.el.props.src === PROXY_A, `实际=${view.el.props.className}`);
  ok("4c alt 仍为空、referrerPolicy 仍 no-referrer（装饰性图片口径不变）", view.el.props.alt === "" && view.el.props.referrerPolicy === "no-referrer");
  ok("4d 图上有 decoding:async 与 fetchPriority:low，但**没有** loading:lazy（字节已在缓存，lazy 是自相矛盾的写法）",
    view.el.props.decoding === "async" && view.el.props.fetchPriority === "low" && view.el.props.loading === undefined,
    `实际=${JSON.stringify({ decoding: view.el.props.decoding, fetchPriority: view.el.props.fetchPriority, loading: view.el.props.loading })}`);
  ok("4e <img> 也挂着 ref（换成图之后节点仍然交得出，视口门不会瞎）", Boolean(view.el.props.ref));
  ok("4f 换成 <img> 之后没有再补一次请求", env.imageLog.filter((u) => u === PROXY_A).length === 1, `实际=${JSON.stringify(env.imageLog)}`);
  view.el.props.onError();
  view.rerender();
  ok("4g <img> 自己报错时退回字母（缓存被挤掉不留破图）", view.el.type === "span" && view.el.props.className === `${CARD} fallback`, `实际=${shape(view.el)}`);
  ok("4h 退字母没有额外发请求", env.imageLog.length === 1);
}

// ── 5. 超时：4 秒一条，先换备胎路由，全部用完才粘住 ──────────────────────────
{
  const env = buildEnv();
  ok("5a 超时值是 4000ms（实测代理单张串行中位 1.7s、样本最大 2.46s：1.5s 会把半数本来能显示的判死）", env.probe.AVATAR_TIMEOUT_MS === 4000, `实际=${env.probe.AVATAR_TIMEOUT_MS}`);
  const view = env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
  env.advance(3999);
  view.rerender();
  ok("5b 3.999 秒仍未结算：还是字母、还只发过一条", view.el.type === "span" && env.imageLog.length === 1 && env.pendingTimers() === 1, `实际=${shape(view.el)} 请求=${env.imageLog.length}`);
  env.advance(1);
  view.rerender();
  ok("5c 主路由挂满 4 秒 → 立刻换第二条路由（换域名、同一个源），而不是直接判死",
    env.imageLog.length === 2 && env.imageLog[1] === ALT_A && sourceOf(env.imageLog[1]) === sourceOf(PROXY_A),
    `实际=${JSON.stringify(env.imageLog)}`);
  ok("5d 换路由仍只占一个在途名额（名额代表「这个 owner 没结算」，不是一次 HTTP）",
    env.slots() === 1 && env.inflight() === 1 && env.dispatched() === 1 && env.pendingTimers() === 1,
    `名额=${env.slots()} 在途=${env.inflight()} 定时器=${env.pendingTimers()}`);
  ok("5e 换成备胎的这一刻界面还是字母", view.el.type === "span");
  env.advance(3999);
  ok("5f 备胎那 4 秒是重新起表的（主路由挂掉的时间没把它一起吃掉）", env.pendingTimers() === 1 && env.imageLog.length === 2, `定时器=${env.pendingTimers()}`);
  env.advance(1);
  view.rerender();
  ok("5g 两条路由都用完才判死：不画 <img>、不留空圈、也不会发第三条",
    view.el.type === "span" && view.el.props.className === `${CARD} fallback` && env.imageLog.length === 2 && env.pendingTimers() === 0,
    `实际=${shape(view.el)} 请求=${env.imageLog.length} 定时器=${env.pendingTimers()}`);
  const again = env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
  again.rerender();
  ok("5h 粘住：再挂一个同 URL 的头像既不重发也不再计时", env.imageLog.length === 2 && env.pendingTimers() === 0, `请求=${JSON.stringify(env.imageLog)} 定时器=${env.pendingTimers()}`);
  ok("5i 粘住的是请求不是显示：重挂后仍然是字母", again.el.type === "span");
  env.images[1].succeed();
  again.rerender();
  view.rerender();
  ok("5j 迟到的成功照样采纳，而且在挂载的两个头像上都生效（慢不等于坏，且不额外花一次网络）",
    view.el.type === "img" && again.el.type === "img", `首挂=${shape(view.el)} 重挂=${shape(again.el)}`);
  ok("5k 出的是**真正成功那条**路由的地址（备胎），不是首选那条", view.el.props.src === ALT_A && again.el.props.src === ALT_A, `实际=${view.el.props.src}`);
  ok("5l 迟到成功没有变成第三次请求", env.imageLog.length === 2);
}

// ── 6. 报错先换路由；两条都坏才粘住；切 url 不闪旧图 ─────────────────────────
{
  const env = buildEnv();
  const view = env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
  env.images[0].fail();
  view.rerender();
  ok("6a 主路由 onerror 立刻换备胎，不用等满 4 秒（账号不存在时代理干净回 404）",
    env.imageLog.length === 2 && env.imageLog[1] === ALT_A && view.el.type === "span", `实际=${JSON.stringify(env.imageLog)} ${shape(view.el)}`);
  env.images[1].fail();
  view.rerender();
  ok("6b 备胎也报错才判死：定时器收干，尝试停在两条", env.pendingTimers() === 0 && env.imageLog.length === 2 && view.el.type === "span", `定时器=${env.pendingTimers()} 请求=${env.imageLog.length}`);
  const third = env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
  ok("6c 失败粘住：新挂载不重试（再进市场不会又是 82 次）", env.imageLog.length === 2);
  const live = env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
  live.rerender({ url: URL_B, name: "torvalds", className: CARD });
  ok("6d 换 url 的那一帧回到字母，不会拿旧状态去绘新 src", live.el.type === "span" && live.el.props.src === undefined, `实际=${shape(live.el)}`);
  ok("6e 新 url 发自己的首选路由", env.imageLog.length === 3 && env.imageLog[2] === PROXY_B, `实际=${JSON.stringify(env.imageLog)}`);
  env.images[2].succeed();
  live.rerender();
  ok("6f 新 url 主路由探到后正常出图", live.el.type === "img" && live.el.props.src === PROXY_B);
  third.rerender({ url: URL_B, name: "torvalds", className: CARD });
  third.rerender();
  ok("6g 已粘住失败的 owner 换到人之后仍能显示（粘的是那条 URL，不是这个位置），且不为此多花一次请求",
    third.el.type === "img" && third.el.props.src === PROXY_B && env.imageLog.length === 3,
    `实际=${shape(third.el)} 请求=${env.imageLog.length}`);
  let afterUnmount = "no-throw";
  try {
    live.unmount();
    env.images[2].succeed();
    env.advance(9000);
  } catch (error) {
    afterUnmount = String(error && error.message);
  }
  ok("6h 卸载后结算与超时都不再往已死的实例上写状态（waiter 已摘走）", afterUnmount === "no-throw", `实际=${afterUnmount}`);
}

// ── 7. 视口门（dshmarket 的 useNearViewport）：视口外一次都不发 ──────────────
{
  const env = buildEnv(undefined, { io: true });
  const views = [];
  for (let i = 0; i < 12; i += 1) {
    views.push(env.mount(env.probe.Avatar, { url: `https://github.com/v${i}.png`, name: `v${i}`, className: CARD }));
  }
  ok("7a 装了 IO 的宿主：挂载 12 个头像**一次请求都不发**（闸门只是排队，这里根本不排队）",
    env.imageLog.length === 0 && env.probe.avatarRegistry.size === 0, `发出=${env.imageLog.length} 登记=${env.probe.avatarRegistry.size}`);
  ok("7b 视口门外也还是字母，不是空白也不是不渲染", views[11].el.type === "span" && views[11].el.props.className === `${CARD} fallback`);
  ok("7c 每个头像各挂一个观察者，观察的就是首帧那个字母节点", env.observers.length === 12 && env.observers.every((observer) => observer.nodes.length === 1), `观察者=${env.observers.length}`);
  ok(`7d rootMargin 用 ${env.probe.AVATAR_VIEWPORT_MARGIN}（照 dshmarket 的量：提前一点备好，滚到才不空）`,
    env.probe.AVATAR_VIEWPORT_MARGIN === "200px" && env.observers[0].options.rootMargin === "200px", `实际=${JSON.stringify(env.observers[0].options)}`);
  env.leave(0);
  views[0].rerender();
  ok("7e isIntersecting:false 不算进视口（IO 也报「离开」，别一收到回调就发请求）", env.imageLog.length === 0 && views[0].el.type === "span", `发出=${env.imageLog.length}`);
  env.enter(0);
  views[0].rerender();
  ok("7f 进入视口后才发第一条，发的是首选路由", env.imageLog.length === 1 && env.imageLog[0] === proxied(MAIN, "v0"), `实际=${JSON.stringify(env.imageLog)}`);
  ok("7g 只有进过视口的那一个发请求：其余 11 个既没发也没进登记", env.probe.avatarRegistry.size === 1 && env.imageLog.length === 1, `登记=${env.probe.avatarRegistry.size}`);
  env.images[0].succeed();
  views[0].rerender();
  ok("7h 视口门只挡请求，不挡显示：结算后照样出图", views[0].el.type === "img" && views[0].el.props.src === proxied(MAIN, "v0"), `实际=${shape(views[0].el)}`);
  views[1].unmount();
  ok("7i 卸载即 disconnect 观察者（不越滚越多）", env.observers[1].disconnected === true);
  let stray = "no-throw";
  try {
    env.enter(1);
    views[2].rerender();
  } catch (error) {
    stray = String(error && error.message);
  }
  ok("7j 已卸载的头像之后被报进视口也不炸、也不多发消息；没进视口的那张仍停在字母",
    stray === "no-throw" && env.imageLog.length === 1 && env.probe.avatarRegistry.size === 1 && views[2].el.type === "span",
    `${stray} 发出=${env.imageLog.length}`);
}

// 视口门的回退：宿主没有 IO 时必须立刻能发（否则头像就永远停在字母上）。
{
  const plain = buildEnv();
  plain.mount(plain.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
  ok("7k 没有 IntersectionObserver 的宿主：首帧就进探测队列（宁可全都探）", plain.imageLog.length === 1, `发出=${plain.imageLog.length}`);
  const noCtor = buildEnv(undefined, { io: true, ioThrows: true });
  const broken = noCtor.mount(noCtor.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
  broken.rerender();
  ok("7l IO 构造抛异常（老内核不认参数）也当作已在视口，绝不把头像锁死在字母上",
    noCtor.observers.length === 0 && noCtor.imageLog.length === 1 && noCtor.probe.avatarRegistry.size === 1,
    `观察者=${noCtor.observers.length} 发出=${noCtor.imageLog.length}`);
  broken.rerender();
  ok("7m 这条回退只走一次：构造失败后不会每帧重建观察者", noCtor.observers.length === 0);
}

// ── 8. 并发闸门：一屏 40 个 owner 也不能把连接挤死 ──────────────────────────
// 用「没有 IO」的环境：全都进探测队列，正好把闸门压满。
{
  const env = buildEnv();
  const views = [];
  for (let i = 0; i < 40; i += 1) {
    views.push(env.mount(env.probe.Avatar, { url: `https://github.com/u${i}.png`, name: `u${i}`, className: CARD }));
  }
  const width = env.probe.AVATAR_INFLIGHT_MAX;
  ok(`8a 同时只允许 ${width} 条在途（实测 57 并发时中位 4825ms、9 秒还剩 30 条在途：全并发等于谁都要等）`,
    env.imageLog.length === width && env.slots() === width, `发出=${env.imageLog.length} 名额=${env.slots()}`);
  ok(`8b 其余进队列而不是并发（队列长度 = 40 - ${width}）`, env.probe.avatarQueue.length === 40 - width, `实际队列=${env.probe.avatarQueue.length}`);
  ok("8c 队列按挂载顺序排 = 文档顺序 = 用户从上往下先看到的那几张先拿到带宽",
    env.probe.avatarQueue[0] === proxied(MAIN, "u3") && env.imageLog[0] === proxied(MAIN, "u0"),
    `队头=${env.probe.avatarQueue[0]} 首个发出=${env.imageLog[0]}`);
  ok("8d 排队中的头像一律是字母，不是空圈", views[39].el.type === "span" && views[width].el.type === "span");
  env.images[0].succeed();
  ok("8e 一条结算后马上补发下一条（闸门不是只进不出）", env.imageLog.length === width + 1 && env.slots() === width, `发出=${env.imageLog.length} 名额=${env.slots()}`);
  env.images[width].fail();
  ok("8f 换备胎仍只占一个名额（名额 = 没结算的 owner，不是一次 HTTP）", env.slots() === width, `名额=${env.slots()}`);
  let teardown = "no-throw";
  try {
    for (const view of views) view.unmount();
    for (let round = 0; round < 120 && (env.probe.avatarQueue.length || env.slots() > 0); round += 1) env.advance(4100);
  } catch (error) {
    teardown = String(error && error.message);
  }
  ok("8g 全部结算/超时后在途归零、队列排空、定时器收干、不抛错",
    env.pendingTimers() === 0 && env.slots() === 0 && env.inflight() === 0 && env.probe.avatarQueue.length === 0 && teardown === "no-throw",
    `残留定时器=${env.pendingTimers()} 名额=${env.slots()} 在途=${env.inflight()} 队列=${env.probe.avatarQueue.length} ${teardown}`);
  // 40 个人 × 2 条路由 = 80 是上限；u0 在 8e 主路由就成功了，只花 1 次 → 79。
  const attempts = new Map();
  for (const url of env.imageLog) attempts.set(sourceOf(url), (attempts.get(sourceOf(url)) || 0) + 1);
  ok("8h 每个 owner 至多两条路由、成功即停手：总请求正好 79（39×2 + u0 那次），一次也不多花",
    attempts.size === 40 && [...attempts.values()].every((n) => n <= 2) && env.imageLog.length === 79,
    `实际=${env.imageLog.length} 人数=${attempts.size} 最多尝试=${Math.max(...attempts.values())}`);
}

// ── 9. 登记表封顶：条目数不随刷过的页数无限长 ────────────────────────────────
{
  const env = buildEnv();
  const cap = env.probe.AVATAR_REGISTRY_MAX;
  const views = [];
  for (let i = 0; i < cap + 120; i += 1) {
    views.push(env.mount(env.probe.Avatar, { url: `https://github.com/z${i}.png`, name: `z${i}`, className: CARD }));
  }
  ok(`9a 登记条目封顶在 ${cap}（长列表刷一整天也不涨内存）`, env.probe.avatarRegistry.size <= cap, `实际=${env.probe.avatarRegistry.size}`);
  ok("9b 首帧仍然全是字母（封顶逻辑没把渲染带跑）", views[cap + 119].el.type === "span");
  ok("9c 队列不另开一本账：能入队的前提就是已登记，腾不出已结算的条目就既不登记也不入队（只删条目不拦请求等于没封顶）",
    env.probe.avatarQueue.every((url) => env.probe.avatarRegistry.has(url))
    && env.probe.avatarRegistry.size === cap
    && env.probe.avatarQueue.length === cap - env.probe.AVATAR_INFLIGHT_MAX,
    `队列=${env.probe.avatarQueue.length} 登记=${env.probe.avatarRegistry.size}`);
  ok("9d 溢出那批直接是字母，一个请求都不多花（也不在队列里占位）",
    views[cap + 5].el.type === "span" && !env.probe.avatarQueue.includes(proxied(MAIN, `z${cap + 5}`)) && !env.probe.avatarRegistry.has(proxied(MAIN, `z${cap + 5}`)),
    `队列含溢出项=${env.probe.avatarQueue.includes(proxied(MAIN, `z${cap + 5}`))}`);
  ok("9e 在途本身也不超预算", env.slots() === env.probe.AVATAR_INFLIGHT_MAX && env.inflight() === env.probe.AVATAR_INFLIGHT_MAX, `名额=${env.slots()} 在途=${env.inflight()}`);
  for (const view of views) view.unmount();
}

// 封顶不等于"锁死"：已结算的条目要能被腾出去，否则一次挂死就把后面的头像全灭了。
{
  const env = buildEnv();
  const cap = env.probe.AVATAR_REGISTRY_MAX;
  const views = [];
  for (let i = 0; i < cap; i += 1) {
    views.push(env.mount(env.probe.Avatar, { url: `https://github.com/u${i}.png`, name: `u${i}`, className: CARD }));
  }
  views[0].unmount();
  env.images[0].succeed(); // 腾出一条**已结算**的（而不是随便杀在途或排队中的那条）
  const extra = env.mount(env.probe.Avatar, { url: "https://github.com/late.png", name: "late", className: CARD });
  ok("9f 腾出一条已结算的后就又多出一个名额（预算会回流，不是永久拉闸）",
    env.probe.avatarRegistry.has(proxied(MAIN, "late")) && env.probe.avatarRegistry.size === cap, `登记=${env.probe.avatarRegistry.size}`);
  ok("9g 腾出去的是最早那条，不是随便挑一条在途/排队的",
    !env.probe.avatarRegistry.has(proxied(MAIN, "u0")) && env.probe.avatarRegistry.has(proxied(MAIN, "u1")));
  ok("9h 新那条照样先出字母", extra.el.type === "span");
  for (const view of views.slice(1)) view.unmount();
}

// ── 10. 取图通道：githubAvatarUrl / avatarProxyUrl / 有序路由的契约 ──────────
{
  const env = buildEnv();
  const { githubAvatarUrl, avatarProxyUrl, avatarRouteCandidates, AVATAR_PROXY_BASES, AVATAR_PROXY_HOSTS } = env.probe;
  ok("10a 仓库写法与裸 owner/repo 得出同一个 URL —— 不然同一个人会发两遍",
    githubAvatarUrl("https://github.com/octocat/hello-world") === githubAvatarUrl("octocat/hello-world")
    && githubAvatarUrl("git+https://github.com/octocat/hello-world.git") === githubAvatarUrl("git@github.com:octocat/hello-world.git"),
    `实际=${githubAvatarUrl("https://github.com/octocat/hello-world")}`);
  ok("10b 非 GitHub 来源不产 URL（交回字母，不发无谓请求）", githubAvatarUrl("https://gitlab.com/a/b") === "" && githubAvatarUrl("") === "");
  ok("10c 产物是代理地址，代理的 url= 解码后正是 github.com/<owner>.png（源交给代理去跟重定向）",
    githubAvatarUrl("octocat/hello") === PROXY_A && sourceOf(PROXY_A) === "https://github.com/octocat.png",
    `实际=${githubAvatarUrl("octocat/hello")}`);
  ok("10d 面板不再往 github.com 发头像请求：两条路由的 hostname 都是代理域",
    new URL(PROXY_A).hostname === "wsrv.nl" && new URL(ALT_A).hostname === "images.weserv.nl");
  ok("10e size 参数落到代理的 w/h（详情 42px 圆按 2 倍图取 88）", githubAvatarUrl("octocat/x", 88) === PROXY_88("octocat"), `实际=${githubAvatarUrl("octocat/x", 88)}`);
  ok("10f 幂等：已经代理过的地址再进一道不会被套两层", avatarProxyUrl(PROXY_A) === PROXY_A && avatarProxyUrl(PROXY_88("a")) === PROXY_88("a"));
  ok("10g wbRepoMeta 给的 canonical CDN 地址（原图尺寸、直连又慢）也代理成小图",
    avatarProxyUrl("https://avatars.githubusercontent.com/u/583231?v=4") === `${MAIN}&w=64&h=64&url=${encodeURIComponent("https://avatars.githubusercontent.com/u/583231?v=4")}`,
    `实际=${avatarProxyUrl("https://avatars.githubusercontent.com/u/583231?v=4")}`);
  ok("10h 非 GitHub 域名（技能自带图标）原样透传，不强行改道", avatarProxyUrl("https://cdn.example.com/icon.png") === "https://cdn.example.com/icon.png");
  ok("10i 空值与脏值不炸：空串进空数组，非法地址原样返回（交给字母）",
    avatarRouteCandidates("").length === 0 && avatarRouteCandidates(undefined).length === 0
    && avatarProxyUrl("") === "" && avatarProxyUrl(undefined) === "" && avatarProxyUrl("not a url") === "not a url");
  ok("10j size 夹在 32~192：脏 size（NaN / 0 / 超大）不会产出 w=NaN 或 w=9999 的坏 URL",
    avatarProxyUrl(URL_A, Number.NaN) === PROXY_A && avatarProxyUrl(URL_A, 0) === PROXY_A
    && avatarProxyUrl(URL_A, 99999) === proxied(MAIN, "octocat", 192)
    && avatarProxyUrl(URL_A, 4) === proxied(MAIN, "octocat", 32));
  ok(`10k GitHub 系有 ${AVATAR_PROXY_BASES.length} 条有序路由，首选是 wsrv.nl、备胎是 images.weserv.nl`,
    AVATAR_PROXY_BASES.length === 2 && AVATAR_PROXY_BASES[0] === MAIN && AVATAR_PROXY_BASES[1] === ALT
    && avatarRouteCandidates(URL_A).length === 2 && avatarRouteCandidates(URL_A)[0] === PROXY_A && avatarRouteCandidates(URL_A)[1] === ALT_A,
    `实际=${JSON.stringify(avatarRouteCandidates(URL_A))}`);
  ok("10l 备胎与首选只差域名，url= / w / h 完全一致（同一个源，换的只是走哪台代理）",
    sourceOf(ALT_A) === sourceOf(PROXY_A) && new URL(ALT_A).searchParams.get("w") === "64" && new URL(ALT_A).searchParams.get("h") === "64");
  ok("10m 非 GitHub 域名只有一条路由（不硬塞备胎，白多打一次别人的服务器）", avatarRouteCandidates("https://cdn.example.com/icon.png").length === 1);
  ok("10n 已经是代理地址的也照样补齐备胎（README 弹层那种传进来的就是代理地址）",
    avatarRouteCandidates(PROXY_A).length === 2 && avatarRouteCandidates(PROXY_A)[0] === PROXY_A
    && avatarRouteCandidates(PROXY_88("a")).length === 2 && avatarRouteCandidates(PROXY_88("a"))[0] === PROXY_88("a"));
  // 分两个变量存再比，而不是把同一个调用写两遍：后者会被 eslint 的 no-self-compare 判错，
  // 而「两次调用结果相等」这条本身就是被测对象（登记表合并与封顶都靠这个字符串稳定）。
  const routesOnce = avatarRouteCandidates(URL_A);
  const routesTwice = avatarRouteCandidates(URL_A);
  ok("10o 路由顺序稳定：同一个源两次算出的数组完全相等（合并与封顶都靠这个字符串）",
    JSON.stringify(routesOnce) === JSON.stringify(routesTwice)
    && JSON.stringify(routesOnce) === JSON.stringify([PROXY_A, ALT_A]));
  ok("10p camo（README 里常见的 GitHub 图片代理域）也在代理名单里", AVATAR_PROXY_HOSTS.includes("camo.githubusercontent.com") && AVATAR_PROXY_HOSTS.includes("github.com"));
}

// ── 11. 接线：四个头像类名都只能走 Avatar ────────────────────────────────────
// 口径要说清楚，别把邻居的活儿钉成自己的护栏：并行会话在改版 awesome 卡片
// （.dsh-mcp-pavatar / .dsh-mcp-skill-avatar 那套「字母常驻 + 图上叠」），本套件**不**钉
// 那个变体的存在或不存在，只钉一件事——凡是 dsh-mcp-*avatar 这四个类名，就不许再出现
// 直写 <img> 的旧写法（那才会退回空灰圈），也不许绕过代理与视口门。
function freshProbe() {
  return buildEnv().probe;
}
{
  const AVATAR_CLASSES = ["dsh-mcp-card-avatar", "dsh-mcp-detail-avatar", "dsh-mcp-presence-avatar", "dsh-mcp-presence-inline-avatar"];
  const raw = /h\('img',\s*\{[^}]*className:\s*'dsh-mcp-[a-z-]*avatar'/g;
  const leftovers = source.match(raw) || [];
  ok("11a lib/client.js 里不再有任何直写 <img className='dsh-mcp-*avatar'>（四类头像全收进 Avatar）",
    leftovers.length === 0, `残留=${JSON.stringify(leftovers.map((s) => s.slice(0, 40)))}`);
  const declared = (source.match(/const Avatar = \(\{ url, name, className \}\) => \{/g) || []).length;
  const missing = AVATAR_CLASSES.filter((cls) => !new RegExp(`h\\(Avatar,[\\s\\S]{0,240}className: '${cls}'`).test(source));
  ok("11b Avatar 定义唯一，且四个头像类名各自都仍有 Avatar 调用",
    declared === 1 && missing.length === 0, `定义=${declared} 缺类=${JSON.stringify(missing)}`);
  ok("11c 归一化与视口门都收在 Avatar 内部（每个头像位都过代理、都等视口，不靠各调用点自觉）",
    /const Avatar = \(\{ url, name, className \}\) => \{\s*const \[nodeRef, near\] = useNearViewport\(\);\s*const routes = avatarRouteCandidates\(url\);/.test(source),
    `视口门在首行=${/const \[nodeRef, near\] = useNearViewport\(\);/.test(source)}`);
  ok("11d 渲染条件里 key 与 near 都在（视口门真的挡在显示层，不只是挡请求）",
    /if \(!key \|\| !near \|\| !ready \|\| ready\.key !== key\)/.test(source));
  ok("11e eslint 的浏览器全局里声明了 Image 与 IntersectionObserver（否则 CI 的 no-undef 直接红）",
    /^\s*Image:\s*'readonly',/m.test(eslintRc) && /^\s*IntersectionObserver:\s*'readonly',/m.test(eslintRc),
    `Image=${/Image/.test(eslintRc)} IO=${/IntersectionObserver/.test(eslintRc)}`);
  ok("11f 四个头像类名都还有 .fallback 样式（字母占位要有底色，不然首帧是空白不是字母）",
    AVATAR_CLASSES.every((cls) => source.includes(`.${cls}.fallback{`)),
    `缺=${JSON.stringify(AVATAR_CLASSES.filter((cls) => !source.includes(`.${cls}.fallback{`)))}`);
  ok("11g 旧的 visibility:hidden 逃生写法不再挂在任何头像类名上（超时下它根本来不及触发）",
    !/dsh-mcp-[a-z-]*avatar[\s\S]{0,240}visibility:\s*'hidden'/.test(source));
  ok("11h 并发闸门留的连接数少于 Chromium 每域 6 条（README 插图与它同域名，别挤死）",
    freshProbe().AVATAR_INFLIGHT_MAX >= 1 && freshProbe().AVATAR_INFLIGHT_MAX < 6, `AVATAR_INFLIGHT_MAX=${freshProbe().AVATAR_INFLIGHT_MAX}`);
  ok("11i 头像首选与 README 插图是同一条代理（口径统一，别一个走 wsrv 一个走别的）",
    source.includes("const README_IMG_PROXY = 'https://wsrv.nl/") && freshProbe().AVATAR_PROXY_BASES[0].startsWith("https://wsrv.nl/"));
}

// ── 11B. 市场连接器头像（ConnectorAvatar）：data URL 通道的分工与缓存语义 ─────
// 连接器没有 GitHub 仓库可考，图标本体在官方分发包 ZIP 的 icons/<id> 里，宿主按需出
// data URL（wbConnectorIcon）。与 Avatar 的分工：data URL 不走网络，**不进探活闸门**
// （imageLog 必须恒空）；与 Avatar 的纪律：进视口才发、同 id 只发一次、首帧字母。
// 缓存语义必须分两层（2026-10-24「经典假头像」一单的沉淀）：宿主业务级 ok:false
// （目录里确实没图标）是最终答案，记 null 不再发；信封级 ok:false 带 error（宿主
// 还没重载 / 网关 404 / 服务未连接）是**暂时**的，绝不能记死 —— 否则宿主重载后整个
// 会话都停在字母上，用户重启也救不回来（webview 的模块缓存要到面板重建才清）。
{
  const DATA_URL = "data:image/svg+xml;base64,PHN2Zy8+";
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const freshCall = (behaviour) => {
    const calls = [];
    const call = async (method, args) => {
      calls.push({ method, args });
      return behaviour({ method, args, connectorId: args && args.connectorId });
    };
    return { call, calls };
  };

  // 成功路径：视口门 → RPC → img
  {
    const env = buildEnv(undefined, { io: true });
    const { call, calls } = freshCall(({ connectorId }) => ({ ok: true, connectorId, dataUrl: DATA_URL }));
    const view = env.mount(env.probe.ConnectorAvatar, { call, connectorId: "tencent-weiyun", name: "微云", className: CARD });
    ok("11B-1a 首帧是字母 span（与 Avatar 同款 .fallback，不是空灰圈）", view.el.type === "span" && view.el.props.className === `${CARD} fallback`, `实际=${shape(view.el)}`);
    ok("11B-1b 字母取名称首字符", flatText(view.el.children) === "微", `实际=${JSON.stringify(flatText(view.el.children))}`);
    ok("11B-1c 进视口之前不发 RPC（视口门对 data URL 通道同样有效）", calls.length === 0, `实际=${calls.length}`);
    env.enter(0);
    view.rerender();
    ok("11B-1d 进视口后向宿主要图标（wbConnectorIcon，payload 带 connectorId）", calls.length === 1 && calls[0].method === "wbConnectorIcon" && calls[0].args.connectorId === "tencent-weiyun", `实际=${JSON.stringify(calls)}`);
    await flush();
    view.rerender();
    ok("11B-1e 图标到手后画 <img>，src 就是宿主给的 data URL", view.el.type === "img" && view.el.props.src === DATA_URL, `实际=${shape(view.el)}`);
    ok("11B-1f data URL 不进探活闸门（不发 new Image()，与远程头像分工）", env.imageLog.length === 0, `实际=${JSON.stringify(env.imageLog)}`);
    ok("11B-1g img 同样带 ref（视口门要持续观察这个节点）", Boolean(view.el.props.ref));
    const second = env.mount(env.probe.ConnectorAvatar, { call, connectorId: "tencent-weiyun", name: "微云", className: CARD });
    second.rerender();
    ok("11B-1h 同 id 第二次挂载直接出图（缓存命中，不发第二次 RPC）", second.el.type === "img" && second.el.props.src === DATA_URL && calls.length === 1, `实际 calls=${calls.length} el=${shape(second.el)}`);
  }

  // 业务级 ok:false（确实没图标）：记 null，不再发
  {
    const env = buildEnv(undefined, { io: true });
    const { call, calls } = freshCall(({ connectorId }) => ({ ok: false, connectorId, dataUrl: "" }));
    const view = env.mount(env.probe.ConnectorAvatar, { call, connectorId: "no-icon", name: "无图", className: CARD });
    env.enter(0);
    view.rerender();
    await flush();
    view.rerender();
    ok("11B-2a 确实没图标：重绘后仍停在字母（回落不是坏图）", view.el.type === "span", `实际=${shape(view.el)}`);
    const again = env.mount(env.probe.ConnectorAvatar, { call, connectorId: "no-icon", name: "无图", className: CARD });
    env.enter(env.observers.length - 1);
    again.rerender();
    await flush();
    ok("11B-2b 没图标是最终答案：同会话重挂不再发（记 null）", calls.length === 1, `实际 calls=${calls.length}`);
  }

  // 信封级 ok:false 带 error（宿主没重载 / 网关 404）：不记死，重挂重试 —— 自愈路径
  {
    const env = buildEnv(undefined, { io: true });
    let mode = "fail";
    const { call, calls } = freshCall(({ connectorId }) => (mode === "fail"
      ? { ok: false, error: "MCP 市场服务未连接（面板仍可用）" }
      : { ok: true, connectorId, dataUrl: DATA_URL }));
    const view = env.mount(env.probe.ConnectorAvatar, { call, connectorId: "ima-mcp", name: "ima", className: CARD });
    env.enter(0);
    view.rerender();
    await flush();
    view.rerender();
    ok("11B-3a 宿主不可用：停字母但不炸", view.el.type === "span", `实际=${shape(view.el)}`);
    const again = env.mount(env.probe.ConnectorAvatar, { call, connectorId: "ima-mcp", name: "ima", className: CARD });
    env.enter(env.observers.length - 1);
    again.rerender();
    await flush();
    ok("11B-3b 信封级失败不记缓存：重挂会再试（自愈，等宿主重载）", calls.length === 2, `实际 calls=${calls.length}`);
    mode = "ok";
    const third = env.mount(env.probe.ConnectorAvatar, { call, connectorId: "ima-mcp", name: "ima", className: CARD });
    env.enter(env.observers.length - 1);
    third.rerender();
    await flush();
    third.rerender();
    ok("11B-3c 宿主恢复后同一会话即可出图（不用重建面板）", third.el.type === "img" && third.el.props.src === DATA_URL, `实际=${shape(third.el)}`);
  }

  // RPC 抛异常（catch 分支）：同样不记缓存
  {
    const env = buildEnv(undefined, { io: true });
    const calls = [];
    const call = async () => { calls.push(1); throw new TypeError("gateway/method-unavailable"); };
    const view = env.mount(env.probe.ConnectorAvatar, { call, connectorId: "x", name: "X", className: CARD });
    env.enter(0);
    view.rerender();
    await flush();
    view.rerender();
    ok("11B-4a RPC 抛异常不炸、停字母", view.el.type === "span", `实际=${shape(view.el)}`);
    ok("11B-4b RPC 抛异常不记缓存（下次还能重试）", env.probe.connectorIconCache.get("x") === undefined, `实际=${String(env.probe.connectorIconCache.get("x"))}`);
  }
}

// ── 12. 反向自测：把 bug 写回去，本套件必须变红 ──────────────────────────────
// 只有"改坏了会红"的护栏才真的拦得住下一个人顺手改回去。
const mutates = [
  {
    name: "12a 首帧直接挂 <img src>（= 修复前的空灰圈）",
    from: "  if (!key || !near || !ready || ready.key !== key) {",
    to: "  if (!key) {",
    check: (env) => {
      const view = env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
      return view.el.type === "span" && view.el.props.className === `${CARD} fallback`;
    },
  },
  {
    name: "12b 去掉同 URL 复用登记（= 卡片与 PresenceLine 各发一遍）",
    from: "  const existing = avatarRegistry.get(key);\n  if (existing) return existing;",
    to: "  avatarRegistry.get(key);",
    check: (env) => {
      env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
      env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: "dsh-mcp-presence-inline-avatar" });
      return env.imageLog.length === 1;
    },
  },
  {
    name: "12c 超时后连迟到的成功也不认（= 把慢判成坏，永久丢头像）",
    from: "  if (rec.status === 'fail' && next !== 'ok') return;",
    to: "  if (rec.status === 'fail') return;",
    check: (env) => {
      const view = env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
      // 两轮 4 秒：第一轮挂主路由并换到备胎，第二轮才把备胎也挂掉 → 真正进入 fail。
      // 只 advance 一次的话记录还停在 loading，粘住那条纹丝不动，这条坏例自然抓不住。
      env.advance(4100);
      env.advance(4100);
      env.images[1].succeed();
      view.rerender();
      return view.el.type === "img";
    },
  },
  {
    name: "12d 超时调回 1500ms（实测代理中位 1.7s：半数本来能显示的被判死）",
    from: "const AVATAR_TIMEOUT_MS = 4000;",
    to: "const AVATAR_TIMEOUT_MS = 1500;",
    check: (env) => env.probe.AVATAR_TIMEOUT_MS === 4000,
  },
  {
    name: "12e 超时改成从登记（挂载）起算（排队等名额的头像被集体误杀，还是粘住的死）",
    from: "  avatarRegistry.set(key, rec);\n  avatarQueue.push(key);",
    to: "  avatarRegistry.set(key, rec);\n  rec.timer = setTimeout(() => { rec.timer = 0; avatarFinish(rec, 'fail'); }, AVATAR_TIMEOUT_MS);\n  avatarQueue.push(key);",
    check: (env) => {
      const width = env.probe.AVATAR_INFLIGHT_MAX;
      for (let i = 0; i < width + 5; i += 1) {
        env.mount(env.probe.Avatar, { url: `https://github.com/q${i}.png`, name: `q${i}`, className: CARD });
      }
      env.advance(4100);
      // 排在队里根本没发出的那几条，此刻仍该是 loading（超时只从真正发出那刻起算）
      const queued = env.probe.avatarQueue.map((url) => env.probe.avatarRegistry.get(url)).filter(Boolean);
      return queued.length > 0 && queued.every((rec) => rec.status === "loading" && rec.dispatched === false);
    },
  },
  {
    name: "12f 失败不粘住、下次挂载重试（= 再进市场又是 82 次）",
    from: "  const existing = avatarRegistry.get(key);\n  if (existing) return existing;",
    to: "  const existing = avatarRegistry.get(key);\n  if (existing && existing.status !== 'fail') return existing;",
    check: (env) => {
      env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
      env.advance(4100);
      env.advance(4100);
      env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
      return env.imageLog.length === 2;
    },
  },
  {
    name: "12g 登记表满了还照入队（只腾条目不拦请求 = 封顶是假的）",
    from: "    if (!freed) return { status: 'fail', waiters: new Set(), timer: 0, dispatched: false, released: true, route: 0, routes, resolved: '', overflow: true };",
    to: "    if (false) return undefined;",
    check: (env) => {
      const cap = env.probe.AVATAR_REGISTRY_MAX;
      for (let i = 0; i < cap + 120; i += 1) {
        env.mount(env.probe.Avatar, { url: `https://github.com/z${i}.png`, name: `z${i}`, className: CARD });
      }
      return env.probe.avatarRegistry.size <= cap
        && env.probe.avatarQueue.length === cap - env.probe.AVATAR_INFLIGHT_MAX
        && env.probe.avatarQueue.every((url) => env.probe.avatarRegistry.has(url));
    },
  },
  {
    name: "12h 去掉并发闸门（= 回到 57 并发、中位 4825ms、9 秒还剩 30 条在途）",
    from: "  while (avatarInflight < AVATAR_INFLIGHT_MAX && avatarQueue.length) {",
    to: "  while (avatarQueue.length) {",
    check: (env) => {
      for (let i = 0; i < 40; i += 1) {
        env.mount(env.probe.Avatar, { url: `https://github.com/u${i}.png`, name: `u${i}`, className: CARD });
      }
      return env.imageLog.length === env.probe.AVATAR_INFLIGHT_MAX && env.slots() === env.probe.AVATAR_INFLIGHT_MAX;
    },
  },
  {
    name: "12i 结算后不让名额回流（闸门只进不出，第一条挂死就把队列焊住）",
    from: "  avatarInflight -= 1;\n  avatarDrain();",
    to: "  avatarDrain();",
    check: (env) => {
      for (let i = 0; i < 6; i += 1) {
        env.mount(env.probe.Avatar, { url: `https://github.com/u${i}.png`, name: `u${i}`, className: CARD });
      }
      const before = env.imageLog.length;
      env.images[0].succeed();
      return env.imageLog.length === before + 1 && env.slots() === env.probe.AVATAR_INFLIGHT_MAX;
    },
  },
  {
    name: "12j released 不挡住第二次释放（在途计数跑负 → 闸门形同虚设）",
    from: "  if (!rec.dispatched || rec.released) return;",
    to: "  if (!rec.dispatched) return;",
    check: (env) => {
      const width = env.probe.AVATAR_INFLIGHT_MAX;
      env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
      env.advance(4100);
      env.advance(4100); // 两条路由都挂满 → 判死，名额已经回流过一次
      // 迟到的成功仍会走 avatarFinish → release：名额**只能**退一次，否则计数跑负。
      env.images[1].succeed();
      for (let i = 0; i < width + 1; i += 1) {
        env.mount(env.probe.Avatar, { url: `https://github.com/n${i}.png`, name: `n${i}`, className: CARD });
      }
      // 正解：跑负那条不会多要名额 → 只补发 width 条；计数被多减一次就会漏成 width + 1。
      return env.imageLog.length === 2 + width && env.slots() === width;
    },
  },
  {
    name: "12k 换路由时把在途名额重复占上（闸门实际宽度翻倍）",
    from: "  if (!rec.dispatched) {\n    rec.dispatched = true;\n    avatarInflight += 1;\n  }",
    to: "  rec.dispatched = true;\n  avatarInflight += 1;",
    check: (env) => {
      for (let i = 0; i < 8; i += 1) {
        env.mount(env.probe.Avatar, { url: `https://github.com/u${i}.png`, name: `u${i}`, className: CARD });
      }
      env.advance(4100); // 三条主路由同时挂死 → 全换备胎
      // 正解：名额数不变（还占着那 3 个），只是各自换了地址。
      return env.slots() === env.probe.AVATAR_INFLIGHT_MAX && env.imageLog.length === 2 * env.probe.AVATAR_INFLIGHT_MAX;
    },
  },
  {
    name: "12l 已代理地址不再补齐备胎（README 弹层那种传进来的就是代理地址，主域挂了直接落字母）",
    from: "    const tail = text.slice(AVATAR_PROXY_BASES[wrapped].length);\n    return AVATAR_PROXY_BASES.map((base) => `${base}${tail}`);",
    to: "    return [text];",
    check: (env) => env.probe.avatarRouteCandidates(PROXY_A).length === 2 && env.probe.avatarRouteCandidates(PROXY_A)[0] === PROXY_A,
  },
  {
    name: "12m 代理不幂等（同一个人被包两层代理，url= 里塞的是代理地址）",
    from: "    return AVATAR_PROXY_BASES.map((base) => `${base}${tail}`);",
    to: "    return AVATAR_PROXY_BASES.map((base) => `${base}&url=${encodeURIComponent(text)}`);",
    check: (env) => {
      const once = env.probe.avatarProxyUrl(URL_A);
      return env.probe.avatarProxyUrl(once) === once && sourceOf(env.probe.avatarProxyUrl(once)) === "https://github.com/octocat.png";
    },
  },
  {
    name: "12n 白名单漏掉 avatars.githubusercontent.com（wbRepoMeta 的原图又被直连）",
    from: "const AVATAR_PROXY_HOSTS = ['github.com', 'avatars.githubusercontent.com', 'camo.githubusercontent.com'];",
    to: "const AVATAR_PROXY_HOSTS = ['github.com', 'camo.githubusercontent.com'];",
    check: (env) => env.probe.avatarProxyUrl("https://avatars.githubusercontent.com/u/583231?v=4").startsWith("https://wsrv.nl/"),
  },
  {
    name: "12o 去掉视口门（= 一屏之外的那几十个 owner 全进队列，回到 9 秒还剩 30 条在途）",
    from: "    if (!key || !near) return undefined;",
    to: "    if (!key) return undefined;",
    check: (env) => {
      for (let i = 0; i < 12; i += 1) {
        env.mount(env.probe.Avatar, { url: `https://github.com/v${i}.png`, name: `v${i}`, className: CARD });
      }
      return env.imageLog.length === 0 && env.probe.avatarRegistry.size === 0;
    },
    options: { io: true },
  },
  {
    name: "12p 去掉 isIntersecting 判断（IO 报「离开视口」也当成进来）",
    from: "        if (entries.some((entry) => entry && entry.isIntersecting)) setNear(true);",
    to: "        if (entries.length) setNear(true);",
    check: (env) => {
      const view = env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
      env.leave(0);
      view.rerender();
      return env.imageLog.length === 0 && view.el.type === "span";
    },
    options: { io: true },
  },
  {
    name: "12q 没有 IO 的宿主把 near 初值写死 false（头像永远停在字母上）",
    from: "  const [near, setNear] = useState(typeof IntersectionObserver === 'undefined');",
    to: "  const [near, setNear] = useState(false);",
    check: (env) => {
      env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
      return env.imageLog.length === 1;
    },
  },
  {
    name: "12r IO 构造失败后不回落（锁死在字母上，每帧还重建观察者）",
    from: "      setNear(true);\n    }\n    return () => {\n      if (observer) observer.disconnect();",
    to: "    }\n    return () => {\n      if (observer) observer.disconnect();",
    check: (env) => {
      const broken = env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
      broken.rerender();
      broken.rerender();
      return env.imageLog.length === 1 && env.observers.length === 0;
    },
    // 用「构造必抛」的 IO 替身跑这条：真的走到 catch，才谈得上钉住那条回落。
    options: { io: true, ioThrows: true },
  },
  {
    name: "12s 换 url 后还能拿旧 ready 绘新 src（详情来回切时闪一张别人的脸）",
    from: "  if (!key || !near || !ready || ready.key !== key) {",
    to: "  if (!key || !near || !ready) {",
    check: (env) => {
      const view = env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
      env.images[0].succeed();
      view.rerender();
      view.rerender({ url: URL_B, name: "torvalds", className: CARD });
      return view.el.type === "span";
    },
  },
  {
    name: "12t 首帧那个字母节点没把 ref 交出去（视口门观察不到任何东西，头像永远停在字母）",
    from: "    return h('span', { ref: nodeRef, className: `${className} fallback`, 'aria-hidden': true }, letter);",
    to: "    return h('span', { className: `${className} fallback`, 'aria-hidden': true }, letter);",
    check: (env) => {
      const view = env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
      view.rerender();
      if (env.observers.length !== 1 || env.observers[0].nodes.length !== 1) return false;
      env.enter(0);
      view.rerender();
      return env.imageLog.length === 1;
    },
    options: { io: true },
  },
  {
    name: "12u 图上写 loading:lazy（对一张必定要画的图说「晚点再取」，自相矛盾）",
    from: "    decoding: 'async',\n    fetchPriority: 'low',",
    to: "    loading: 'lazy',\n    decoding: 'async',\n    fetchPriority: 'low',",
    check: (env) => {
      const view = env.mount(env.probe.Avatar, { url: URL_A, name: "octocat", className: CARD });
      env.images[0].succeed();
      view.rerender();
      return view.el.type === "img" && view.el.props.loading === undefined && view.el.props.decoding === "async";
    },
  },
];

for (const mutation of mutates) {
  const edits = mutation.edits || [{ from: mutation.from, to: mutation.to }];
  const missing = edits.filter((edit) => !SLICE.includes(edit.from));
  if (missing.length) {
    ok(`反向自测锚点存在：${mutation.name}`, false, `找不到 ${JSON.stringify(missing[0].from)}`);
    continue;
  }
  let patch = SLICE;
  for (const edit of edits) patch = patch.replace(edit.from, edit.to);
  const env = buildEnv(patch, mutation.options || {});
  let verdict = false;
  let note = "";
  try {
    verdict = Boolean(mutation.check(env));
  } catch (error) {
    verdict = false;
    note = `坏例里跑炸了：${String(error && error.message).slice(0, 60)}`;
  }
  ok(`${mutation.name} —— 写回旧语义后本套件必须变红`, verdict === false, note || `坏例下断言仍为 ${verdict}（说明护栏抓不住这次回退）`);
}

console.log(`\n${failures ? `MARKET-AVATAR FAIL（${failures} 条不通过）` : "MARKET-AVATAR PASS"}`);
process.exit(failures ? 1 : 0);
