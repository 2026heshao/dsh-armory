// 安装浮层（顶部轻提示）的行为直测。
//
// 为什么需要这个套件：市场里点「安装」后，进度原本只存在面板组件的局部 state 里，
// 面板一卸载（切标签页 / 切窗口）进度就没了，用户以为装被取消了。浮层改成挂
// document.body 的模块级单例，跨面板卸载存活——这条「跨卸载仍然可见」的性质，
// 只靠人眼点一遍很容易回归（比如有人把 node 挂回组件子树里），所以在这里直测。
//
// 怎么测的：`lib/client.js` 是浏览器 bundle（`window.__ModuleLoader__.load({ factory })`），
// 不能直接 import。但浮层这一节是自足的（只依赖 document / Map / setTimeout / t），
// 所以把「浮层一节」的源码原文抽出来放进 vm 里**真正执行**，配一个最小 DOM 替身，
// 然后对真实产生的 DOM 树做断言——不是对文本做匹配。
//
// 附带副作用：抽源码靠起止标记，标记找不到直接失败。有人把这节改名/搬走而没同步本测试，
// 会立刻暴露，而不是悄悄退化成「测了个空」。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 必须走 fileURLToPath：本仓库路径含中文，`URL.pathname` 是百分号编码的。
const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");

const START_MARKER = "const INSTALL_TOAST_ID =";
const END_MARKER = "// ── 样式表 MCP_CSS";

let failures = 0;
const ok = (name, condition, extra = "") => {
	if (!condition) failures += 1;
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};

// ── 对比度计算（WCAG 2.1 相对亮度）─────────────────────────────────────────────
// 为什么放在这里：这次的故障本质是「深蓝字压深蓝底」，而宿主 token 的值由皮肤决定
// （whale-song 浅色皮：toast-bg #1a3a7a / label-primary #0a1e4a = 1.49:1）。
// 只断言「CSS 里写了哪个变量名」守不住颜色——皮肤一改、或有人把色值调浅调深，
// 界面照样糊。所以这里按真实十六进制值算实测比值，把可读性变成可执行断言。
const hexToRgb = (hex) => {
	const raw = String(hex).replace("#", "");
	const full = raw.length === 3 ? raw.split("").map((c) => c + c).join("") : raw;
	return {
		r: parseInt(full.slice(0, 2), 16),
		g: parseInt(full.slice(2, 4), 16),
		b: parseInt(full.slice(4, 6), 16),
		a: full.length >= 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
	};
};
// 半透明浮层落在皮肤页面底色上：先合成再谈对比度（合成后底色变浅，是最不利的一档）。
const composite = (top, bottom) => {
	const t = hexToRgb(top);
	const b = hexToRgb(bottom);
	const over = (x, y) => Math.round(x * t.a + y * (1 - t.a));
	return "#" + [over(t.r, b.r), over(t.g, b.g), over(t.b, b.b)].map((v) => v.toString(16).padStart(2, "0")).join("");
};
const relativeLuminance = (hex) => {
	const { r, g, b } = hexToRgb(hex);
	const channel = (v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : Math.pow((v / 255 + 0.055) / 1.055, 2.4));
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (a, b) => {
	const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
};
// whale-song 皮肤（本机现役皮）的页面底色，取证自 ~/.dsh/skins/whale-song/skin.css 第 2/8 行。
const SKIN_PAGE_LIGHT = "#d0e8f8";
const SKIN_PAGE_DARK = "#081a40";

// ── 0. 抽出待测源码 ───────────────────────────────────────────────────────────
const source = await readFile(CLIENT, "utf8");
const startAt = source.indexOf(START_MARKER);
const endAt = source.indexOf(END_MARKER, startAt + START_MARKER.length);
ok("能在 lib/client.js 里定位到安装浮层一节的起止标记", startAt >= 0 && endAt > startAt, `start=${startAt} end=${endAt}`);
if (startAt < 0 || endAt <= startAt) {
	console.log("\nINSTALL-TOAST FAIL（标记缺失，无法抽取待测源码）");
	process.exit(1);
}
const slice = source.slice(startAt, endAt);
const PROGRESS_FUNCTIONS = ["ensureInstallToast", "renderInstallToast", "installToastStart", "installToastFinish", "isInstallRunning", "progressToastStart", "progressToastFinish", "taskStatusLabel"];
ok("抽出的片段包含浮层核心函数（含通用进度入口）", PROGRESS_FUNCTIONS.every((n) => slice.includes(`function ${n}`)), PROGRESS_FUNCTIONS.filter((n) => !slice.includes(`function ${n}`)).join(","));

// KEY_PREFIX 在切片之前定义，从原文里取真实值（写死会漂移）。
const prefixMatch = /const KEY_PREFIX = '([^']+)';/.exec(source);
ok("能从原文取到 KEY_PREFIX", Boolean(prefixMatch), prefixMatch ? `KEY_PREFIX=${prefixMatch[1]}` : "");
if (!prefixMatch) {
	console.log("\nINSTALL-TOAST FAIL（取不到 KEY_PREFIX）");
	process.exit(1);
}

// ── 1. 最小 DOM 替身 ─────────────────────────────────────────────────────────
class FakeNode {
	constructor(tag) {
		this.tagName = tag;
		this.childNodes = [];
		this.attributes = Object.create(null);
		this.id = "";
		this._text = "";
		this._classes = new Set();
		this.parent = null;
		this.connected = false;
	}
	get isConnected() {
		return this.connected;
	}
	get className() {
		return [...this._classes].join(" ");
	}
	set className(value) {
		this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
	}
	get classList() {
		return {
			add: (name) => { this._classes.add(name); },
			remove: (name) => { this._classes.delete(name); },
			contains: (name) => this._classes.has(name),
		};
	}
	get textContent() {
		if (this.childNodes.length) return this.childNodes.map((child) => child.textContent).join("");
		return this._text;
	}
	set textContent(value) {
		this._text = String(value);
		for (const child of this.childNodes) child.connected = false;
		this.childNodes = [];
	}
	get children() {
		return this.childNodes;
	}
	get dataset() {
		// 真实实现用 `row.dataset.phase = …` 写状态；替身里等价映射到 data-* 属性，
		// 这样断言既能读 dataset 也能读 getAttribute，不会因为替身缺能力而误判实现。
		const self = this;
		const key = (name) => `data-${String(name).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
		return new Proxy(Object.create(null), {
			get: (_target, name) => self.attributes[key(name)],
			set: (_target, name, value) => {
				self.attributes[key(name)] = String(value);
				return true;
			},
			has: (_target, name) => key(name) in self.attributes,
			deleteProperty: (_target, name) => {
				delete self.attributes[key(name)];
				return true;
			},
		});
	}
	setAttribute(name, value) {
		this.attributes[name] = String(value);
	}
	getAttribute(name) {
		return name in this.attributes ? this.attributes[name] : null;
	}
	appendChild(child) {
		if (child.parent) child.parent.removeChild(child);
		child.parent = this;
		this.childNodes.push(child);
		this.markConnected(this.connected);
		return child;
	}
	removeChild(child) {
		const at = this.childNodes.indexOf(child);
		if (at >= 0) this.childNodes.splice(at, 1);
		child.parent = null;
		child.markConnected(false);
		return child;
	}
	replaceChildren() {
		for (const child of this.childNodes) {
			child.parent = null;
			child.markConnected(false);
		}
		this.childNodes = [];
		this._text = "";
	}
	markConnected(state) {
		this.connected = state;
		for (const child of this.childNodes) child.markConnected(state);
	}
	walk(visit) {
		visit(this);
		for (const child of this.childNodes) child.walk(visit);
	}
}

const createDocument = () => {
	const head = new FakeNode("head");
	const body = new FakeNode("body");
	body.markConnected(true);
	const document = {
		head,
		body,
		createElement: (tag) => new FakeNode(tag),
		getElementById: (id) => {
			let found = null;
			const visit = (node) => {
				if (!found && String(node.id) === String(id)) found = node;
			};
			head.walk(visit);
			body.walk(visit);
			return found;
		},
	};
	return document;
};

// ── 2. 在隔开的 vm 里执行这段源码 ─────────────────────────────────────────────
const boot = () => {
	const document = createDocument();
	const context = {
		console,
		globalThis: null,
		document,
		KEY_PREFIX: prefixMatch[1],
		setTimeout,
		clearTimeout,
		// 展示文案的插值语义与真实实现一致即可（i18n 骨架本身由 client-i18n.mjs 守护）。
		t: (text, vars) => (Array.isArray(vars) ? String(text).replace(/\{(\d+)\}/g, (m, i) => (i < vars.length ? vars[i] : m)) : text),
	};
	context.globalThis = context;
	const proof = vm.createContext(context);
	const epilogue = `
		globalThis.__probe = {
			INSTALL_TOAST_ID, INSTALL_TOAST_CSS_ID, installTasks,
			ensureInstallToast, renderInstallToast, installToastStart, installToastFinish, isInstallRunning,
			progressToastStart, progressToastFinish, taskStatusLabel,
			PROGRESS_GROUP_PLUGIN, PROGRESS_GROUP_MCP,
			PLUGIN_TASK_LABELS, MCP_ADD_TASK_LABELS, MCP_RECONNECT_TASK_LABELS,
		};`;
	vm.runInContext(slice + epilogue, proof, { filename: "client-install-toast-slice.js" });
	return { probe: proof.__probe, document };
};

const rowsOf = (node) => node.childNodes.filter((child) => child._classes.has("dsh-mcp-install-toast-row"));
const titleOf = (node) => {
	const title = node.childNodes.find((child) => child._classes.has("dsh-mcp-install-toast-title"));
	return title ? title.textContent : "";
};
const cellOf = (row, cls) => {
	const cell = row.childNodes.find((child) => child._classes.has(cls));
	return cell ? cell.textContent : "";
};

// ── 3. 冷启动：还没有任何安装任务 ─────────────────────────────────────────────
{
	const { probe, document } = boot();
	ok("冷启动时没有任务", probe.installTasks.size === 0);
	const node = probe.ensureInstallToast();
	ok("浮层节点挂到 document.body（不是组件子树）", Boolean(node) && node.parent === document.body, `parent=${node && node.parent && node.parent.tagName}`);
	ok("浮层节点带 role=status / aria-live=polite（读屏可播报）", node.getAttribute("role") === "status" && node.getAttribute("aria-live") === "polite");
	const style = document.getElementById(probe.INSTALL_TOAST_CSS_ID);
	ok("样式表只注入一次、写在独立 <style> 里（不碰巨型 MCP_CSS）", Boolean(style) && style.parent === document.head, `style=${Boolean(style)}`);
	const css = style ? style.textContent : "";
	ok("浮层固定在视口上方且居中", css.includes("position:fixed") && css.includes("top:64px") && css.includes("translate(-50%"));
	ok("浮层不抢鼠标（pointer-events:none）", css.includes("pointer-events:none"));
	ok("系统「减少动态效果」时关掉动画与过渡", css.includes("prefers-reduced-motion"));
	ok("重复调用不会出现第二个浮层", probe.ensureInstallToast() === node && document.body.childNodes.filter((child) => child.id === probe.INSTALL_TOAST_ID).length === 1);
}

// ── 4. 单个安装：进行中 → 成功 ────────────────────────────────────────────────
{
	const { probe, document } = boot();
	probe.installToastStart("dsh-expert");
	const node = document.getElementById(probe.INSTALL_TOAST_ID);
	ok("开始安装后浮层可见（.on）", Boolean(node) && node.classList.contains("on"));
	ok("标题显示正在安装的插件数量", titleOf(node) === "正在安装 1 个插件…", `得到="${titleOf(node)}"`);
	let rows = rowsOf(node);
	ok("只有一行任务", rows.length === 1, `rows=${rows.length}`);
	ok("行上带 data-phase=running（决定圆点颜色）", rows[0] && rows[0].getAttribute("data-phase") === "running");
	ok("行内显示插件名", cellOf(rows[0], "dsh-mcp-install-toast-name") === "dsh-expert");
	ok("行内状态是「安装中…」", cellOf(rows[0], "dsh-mcp-install-toast-status") === "安装中…");
	ok("isInstallRunning 对进行中的插件返回 true（按钮据此禁用）", probe.isInstallRunning("dsh-expert") === true);
	ok("isInstallRunning 对没装过的名字返回 false", probe.isInstallRunning("nope") === false);
	ok("isInstallRunning 对空名不抛错", probe.isInstallRunning(undefined) === false);

	probe.installToastFinish("dsh-expert", "ok");
	rows = rowsOf(node);
	ok("成功后行状态切到 ok", rows[0] && rows[0].getAttribute("data-phase") === "ok");
	ok("成功后状态文案是「已安装」", cellOf(rows[0], "dsh-mcp-install-toast-status") === "已安装");
	ok("成功后不再算「进行中」", probe.isInstallRunning("dsh-expert") === false);
	ok("没有进行中任务时标题改成「安装任务已结束」", titleOf(node) === "安装任务已结束", `得到="${titleOf(node)}"`);
}

// ── 5. 两个并发安装：计数与失败态 ─────────────────────────────────────────────
{
	const { probe } = boot();
	const node = probe.ensureInstallToast();
	probe.installToastStart("alpha");
	probe.installToastStart("beta");
	ok("两个并发安装时标题计数为 2", titleOf(node) === "正在安装 2 个插件…", `得到="${titleOf(node)}"`);
	ok("两个任务都渲染成行", rowsOf(node).length === 2, `rows=${rowsOf(node).length}`);
	ok("两个都算进行中", probe.isInstallRunning("alpha") && probe.isInstallRunning("beta"));

	probe.installToastFinish("alpha", "ok");
	ok("一个装完后计数降到 1", titleOf(node) === "正在安装 1 个插件…", `得到="${titleOf(node)}"`);
	ok("另一个仍在进行中", probe.isInstallRunning("beta") === true);

	probe.installToastFinish("beta", "fail");
	const betaRow = rowsOf(node).find((row) => cellOf(row, "dsh-mcp-install-toast-name") === "beta");
	ok("失败的行状态切到 fail", betaRow && betaRow.getAttribute("data-phase") === "fail");
	ok("失败的状态文案是「安装失败」", cellOf(betaRow, "dsh-mcp-install-toast-status") === "安装失败");

	// 同一插件重复开装：不应该出现两行，也不该被上一轮的淡出定时器误删。
	probe.installToastStart("alpha");
	ok("同一插件重新开装不会重复成行", rowsOf(node).filter((row) => cellOf(row, "dsh-mcp-install-toast-name") === "alpha").length === 1);
	ok("同一插件重新开装后回到进行中", probe.isInstallRunning("alpha") === true);
	probe.installToastFinish("alpha", "ok");

	// 结果态留 4.2s 再淡出：等过这个窗口，浮层应自己收起（不需要任何用户操作）。
	await new Promise((resolve) => setTimeout(resolve, 4400));
	ok("结果态到期后从任务表里移除", probe.installTasks.size === 0, `size=${probe.installTasks.size}`);
	ok("结果态到期后浮层自动隐藏（不再是 .on）", !node.classList.contains("on"));
	ok("隐藏后不残留行节点", rowsOf(node).length === 0);
}

// ── 6. 任务行数上限：超过 3 个只画 3 行，标题计数仍然准确 ─────────────────────
{
	const { probe } = boot();
	const node = probe.ensureInstallToast();
	for (const name of ["p1", "p2", "p3", "p4", "p5"]) probe.installToastStart(name);
	ok("标题计数统计全部任务", titleOf(node) === "正在安装 5 个插件…", `得到="${titleOf(node)}"`);
	ok("行数封顶 3，避免浮层长成一面墙", rowsOf(node).length === 3, `rows=${rowsOf(node).length}`);
	ok("全部 5 个都登记在进行中（按钮禁用不因封顶而失效）", ["p1", "p2", "p3", "p4", "p5"].every((name) => probe.isInstallRunning(name)));
	for (const name of ["p1", "p2", "p3", "p4", "p5"]) probe.installToastFinish(name, "ok");
}

// ── 7. 没有 document（例如 SSR / 早期引导阶段）时不能抛 ──────────────────────
{
	const context = { console, globalThis: null, KEY_PREFIX: prefixMatch[1], setTimeout, clearTimeout, t: (s) => s };
	context.globalThis = context;
	const proof = vm.createContext(context);
	vm.runInContext(slice + "\nglobalThis.__probe = { ensureInstallToast, renderInstallToast, installToastStart, installTasks };", proof, { filename: "client-install-toast-slice-nodom.js" });
	let threw = null;
	try {
		proof.__probe.installToastStart("x");
	} catch (error) {
		threw = error;
	}
	ok("无 document 环境里开始安装不抛异常（降级为只用任务表）", threw === null, threw ? String(threw) : "");
	ok("无 document 环境里任务仍然登记", proof.__probe.installTasks.has("x"));
}

// ── 8. MCP 组：社区「加入 MCP」的进行中 → 结果 ───────────────────────────────
{
	const { probe } = boot();
	const node = probe.ensureInstallToast();
	const key = "mcp:add:adeu";
	probe.progressToastStart(key, "adeu", probe.PROGRESS_GROUP_MCP, probe.MCP_ADD_TASK_LABELS);
	ok("MCP 组标题按 MCP 措辞", titleOf(node) === "正在处理 1 个 MCP 任务…", `得到="${titleOf(node)}"`);
	let rows = rowsOf(node);
	ok("行内显示 MCP 服务器名", cellOf(rows[0], "dsh-mcp-install-toast-name") === "adeu");
	ok("进行中文案是「写入配置中…」（不是插件那套「安装中…」）", cellOf(rows[0], "dsh-mcp-install-toast-status") === "写入配置中…", `得到="${cellOf(rows[0], "dsh-mcp-install-toast-status")}"`);
	ok("MCP 任务不参与插件「安装」按钮禁用（key 带前缀，查不到插件名）", probe.isInstallRunning("adeu") === false);
	probe.progressToastFinish(key, "ok");
	rows = rowsOf(node);
	ok("成功文案说明后面还有自动连接", cellOf(rows[0], "dsh-mcp-install-toast-status") === "已加入 · 宿主自动连接中", `得到="${cellOf(rows[0], "dsh-mcp-install-toast-status")}"`);
	ok("无进行中任务时标题改成「MCP 任务已结束」", titleOf(node) === "MCP 任务已结束", `得到="${titleOf(node)}"`);
	probe.progressToastFinish("mcp:add:从来没开过", "fail");
	ok("收尾一个不存在的任务不抛错、也不新增行", rowsOf(node).length === 1, `rows=${rowsOf(node).length}`);
}

// ── 9. MCP 重连组：每台一行 + 失败态 ─────────────────────────────────────────
{
	const { probe } = boot();
	const node = probe.ensureInstallToast();
	for (const name of ["n1", "n2"]) probe.progressToastStart("mcp:reconnect:" + name, name, probe.PROGRESS_GROUP_MCP, probe.MCP_RECONNECT_TASK_LABELS);
	ok("逐台重连每台占一行", rowsOf(node).length === 2, `rows=${rowsOf(node).length}`);
	ok("重连进行中文案「正在重连…」", rowsOf(node).every((row) => cellOf(row, "dsh-mcp-install-toast-status") === "正在重连…"));
	probe.progressToastFinish("mcp:reconnect:n1", "fail");
	const failed = rowsOf(node).find((row) => cellOf(row, "dsh-mcp-install-toast-name") === "n1");
	ok("失败行 data-phase=fail（决定红点）", failed && failed.getAttribute("data-phase") === "fail");
	ok("失败文案「重连失败」", failed && cellOf(failed, "dsh-mcp-install-toast-status") === "重连失败");
	probe.progressToastFinish("mcp:reconnect:n2", "ok");
	const done = rowsOf(node).find((row) => cellOf(row, "dsh-mcp-install-toast-name") === "n2");
	ok("成功文案「已请求重连」", done && cellOf(done, "dsh-mcp-install-toast-status") === "已请求重连");
	ok("两组全部结束后标题仍是 MCP 措辞", titleOf(node) === "MCP 任务已结束", `得到="${titleOf(node)}"`);
}

// ── 10. 同名不顶行：插件行与 MCP 行各归各 ────────────────────────────────────
{
	const { probe } = boot();
	const node = probe.ensureInstallToast();
	probe.installToastStart("same");
	probe.progressToastStart("mcp:add:same", "same", probe.PROGRESS_GROUP_MCP, probe.MCP_ADD_TASK_LABELS);
	const rows = rowsOf(node);
	ok("同名插件与 MCP 加入各占一行（前缀 key 不互相覆盖）", rows.length === 2, `rows=${rows.length}`);
	const pluginRow = rows.find((row) => cellOf(row, "dsh-mcp-install-toast-status") === "安装中…");
	const mcpRow = rows.find((row) => cellOf(row, "dsh-mcp-install-toast-status") === "写入配置中…");
	ok("两行分别用自己的文案（没串组）", Boolean(pluginRow) && Boolean(mcpRow));
	ok("isInstallRunning 仍只认插件那行", probe.isInstallRunning("same") === true);
	ok("两组都在跑时标题按第一条进行中的分组（这里是插件）", titleOf(node) === "正在安装 1 个插件…", `得到="${titleOf(node)}"`);
	probe.installToastFinish("same", "ok");
	ok("插件那组结束后标题转按仍在跑的 MCP 组", titleOf(node) === "正在处理 1 个 MCP 任务…", `得到="${titleOf(node)}"`);
	probe.progressToastFinish("mcp:add:same", "ok");
}

// ── 11. 浮层样式：颜色自持，不再依赖皮肤没定义的宿主 token ────────────────────
{
	const { probe, document } = boot();
	probe.ensureInstallToast();
	const css = document.getElementById(probe.INSTALL_TOAST_CSS_ID).textContent;
	ok("底色走自持 --mcp-tip-bg（弃用本皮根本没定义的 --dsw-alias-bg-elevated）", css.includes("var(--mcp-tip-bg") && !css.includes("--dsw-alias-bg-elevated"));
	ok("文字走自持 --mcp-tip-fg（弃用 --dsw-alias-text-primary）", css.includes("var(--mcp-tip-fg") && !css.includes("--dsw-alias-text-primary"));
	ok("成功/失败圆点用自持态色（弃用 --dsw-alias-status-*）", css.includes("var(--mcp-tip-ok") && css.includes("var(--mcp-tip-err") && !css.includes("--dsw-alias-status-"));
	ok("投影有确定值，不再依赖 --dsw-shadow-lv3", css.includes("var(--mcp-tip-shadow"));
	ok("多行任务左对齐（居中的行列表读起来会错位）", css.includes("text-align:start"));
}

// ── 12. 底部提示窗（深蓝浮层）：色值实算对比度 ────────────────────────────────
{
	const cssAt = source.indexOf("const MCP_CSS = `");
	ok("能定位到 MCP_CSS 样式表", cssAt >= 0, `at=${cssAt}`);
	const cssBlock = source.slice(cssAt, source.indexOf("`;", cssAt));
	// 行首才是「它自己那条规则」：分组选择器里也出现 .dsh-mcp-toast{，那条要单独审。
	const toastRule = /(?:^|\n)\.dsh-mcp-toast\{[^}]*\}/.exec(cssBlock)?.[0] || "";
	ok("底部提示窗规则能取到", toastRule.length > 200, `len=${toastRule.length}`);
	ok("底色与文字都改走自持 token", toastRule.includes("background:var(--mcp-tip-bg)") && toastRule.includes("color:var(--mcp-tip-fg)"));
	ok("旧故障形态已消失：不再把页面主文字色写在深蓝底上", !toastRule.includes("--dsw-alias-label-primary"));
	ok("toast 只继承字体族，颜色那条已把它摘出分组选择器",
		cssBlock.includes(".dsh-mcp-toast{font-family:") && !/\.[^{]*\.dsh-mcp-toast[^{]*\{[^}]*color:var\(--dsw-alias-label-primary\)/.test(cssBlock));
	ok("状态描边用自持态色", /\.dsh-mcp-toast\.err\{border-color:var\(--mcp-tip-err\)\}/.test(cssBlock) && /\.dsh-mcp-toast\.ok\{border-color:var\(--mcp-tip-ok\)\}/.test(cssBlock));
	ok("窄窗口不超屏、超长文案能折行", toastRule.includes("max-width:min(560px,calc(100vw - 32px))") && toastRule.includes("overflow-wrap:anywhere"));

	const lightTokens = /body\{--mcp-cat-all:[^}]*\}/.exec(cssBlock)?.[0] || "";
	const darkTokens = /body\[data-ds-dark-theme\]\{[^}]*\}/.exec(cssBlock)?.[0] || "";
	const tokenOf = (block, name) => {
		const m = new RegExp(`--${name}:([^;}]+)`, "i").exec(block);
		return m ? m[1].trim() : "";
	};
	const bgLight = tokenOf(lightTokens, "mcp-tip-bg");
	const bgDark = tokenOf(darkTokens, "mcp-tip-bg");
	const fg = tokenOf(lightTokens, "mcp-tip-fg");
	const err = tokenOf(lightTokens, "mcp-tip-err");
	const good = tokenOf(lightTokens, "mcp-tip-ok");
	ok("浅色/深色各定义了一组浮层底色，文字色共用", /^#[0-9a-f]{6,8}$/i.test(bgLight) && /^#[0-9a-f]{6,8}$/i.test(bgDark) && /^#[0-9a-f]{6}$/i.test(fg), `bg=${bgLight}/${bgDark} fg=${fg}`);
	const ratioLight = contrast(composite(bgLight, SKIN_PAGE_LIGHT), fg);
	const ratioDark = contrast(composite(bgDark, SKIN_PAGE_DARK), fg);
	ok("浅色皮下浮层文字对比度 ≥7:1（WCAG AAA）", ratioLight >= 7, `${composite(bgLight, SKIN_PAGE_LIGHT)} vs ${fg} = ${ratioLight.toFixed(2)}:1`);
	ok("深色皮下同样 ≥7:1", ratioDark >= 7, `${composite(bgDark, SKIN_PAGE_DARK)} vs ${fg} = ${ratioDark.toFixed(2)}:1`);
	// 描边是非文本图形，按 WCAG 1.4.11 要 ≥3:1，否则「红圈/绿圈」等于没标。
	ok("错误描边在浮层底上可见（≥3:1）", contrast(composite(bgLight, SKIN_PAGE_LIGHT), err) >= 3, `= ${contrast(composite(bgLight, SKIN_PAGE_LIGHT), err).toFixed(2)}:1`);
	ok("成功描边在浮层底上可见（≥3:1）", contrast(composite(bgLight, SKIN_PAGE_LIGHT), good) >= 3, `= ${contrast(composite(bgLight, SKIN_PAGE_LIGHT), good).toFixed(2)}:1`);

	// 反向自测：改动前用的正是皮肤这套配对（toast-bg 压 label-primary），它必须被判不合格，
	// 否则上面的阈值就是恒真、这个套件等于没测。
	const legacyLight = contrast("#1a3a7a", "#0a1e4a");
	const legacyBorder = contrast("#1a3a7a", "#c00000");
	ok("自测：旧配对确实读不清（<4.5:1 正文门槛）", legacyLight < 4.5, `旧文字/底 = ${legacyLight.toFixed(2)}:1`);
	ok("自测：旧状态描边确实看不见（<3:1 图形门槛）", legacyBorder < 3, `旧红圈/底 = ${legacyBorder.toFixed(2)}:1`);
}

console.log(failures === 0 ? "\nINSTALL-TOAST PASS" : `\nINSTALL-TOAST FAIL（${failures} 条断言未通过）`);
if (failures > 0) process.exitCode = 1;