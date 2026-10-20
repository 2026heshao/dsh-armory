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
ok("抽出的片段包含浮层四个核心函数", ["ensureInstallToast", "renderInstallToast", "installToastStart", "installToastFinish", "isInstallRunning"].every((n) => slice.includes(`function ${n}`)));

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

console.log(failures === 0 ? "\nINSTALL-TOAST PASS" : `\nINSTALL-TOAST FAIL（${failures} 条断言未通过）`);
if (failures > 0) process.exitCode = 1;