// 召唤菜单「本项目」数据投影直测（lib/client.js 的 projectQuick* 一节）。
//
// 为什么需要这个套件：第四行是否出现「项目里配了、菜单里点不到」的回归，取决于三个
// 收窄规则同时成立——技能只留项目来源、MCP 去掉禁用与项目屏蔽、计数只算技能+MCP。
// 这些判定原先会内联在 JSX 里，node 测不到；抽成模块作用域纯函数后在这里真跑，
// 并用反向注入证明断言不是恒真。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// 必须走 fileURLToPath：本仓库路径含中文，`URL.pathname` 是百分号编码的。
const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");

const START_MARKER = "const PROJECT_SKILL_SOURCES = new Set(";
const END_MARKER = "// 看板顶层分类：MCP";

let failures = 0;
const ok = (name, condition, extra = "") => {
	if (!condition) failures += 1;
	console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};

const source = await readFile(CLIENT, "utf8");
const startAt = source.indexOf(START_MARKER);
const endAt = source.indexOf(END_MARKER, startAt + START_MARKER.length);
ok("能定位项目子菜单投影一节的起止标记", startAt >= 0 && endAt > startAt, `start=${startAt} end=${endAt}`);
if (startAt < 0 || endAt <= startAt) {
	console.log("\nQUICK-MENU-PROJECT FAIL（标记缺失，无法抽取待测源码）");
	process.exit(1);
}
const slice = source.slice(startAt, endAt);

const run = (text) => {
	const context = vm.createContext({ console });
	vm.runInContext(
		`${text}\nglobalThis.__probe = { projectQuickSkills, projectQuickMcp, projectQuickCount, isProjectSkillRow };`,
		context,
		{ filename: "client-project-quick-slice.js" },
	);
	return context.__probe;
};
const probe = run(slice);
ok("投影函数能在 vm 里独立执行", typeof probe.projectQuickSkills === "function"
	&& typeof probe.projectQuickMcp === "function"
	&& typeof probe.projectQuickCount === "function");

// ── 1. 技能：只留宿主的两个项目来源 ─────────────────────────────────────────
const skillRows = [
	{ name: "project-a", description: "项目技能 A", source: "project-dsh" },
	{ name: "project-b", description: "", source: "project-agents", whenToUse: "项目技能 B" },
	{ name: "user-a", description: "用户级", source: "user-dsh" },
	{ name: "bundled-a", description: "随包", source: "bundled" },
	{ name: "", description: "无名条目", source: "project-dsh" },
];
const skills = probe.projectQuickSkills(skillRows);
ok("项目技能只留 project-dsh / project-agents", skills.length === 2 && skills.every((row) => row.name.startsWith("project-")), JSON.stringify(skills.map((row) => row.name)));
ok("项目技能保留描述与 whenToUse 回落", skills[0].description === "项目技能 A" && skills[1].description === "项目技能 B");
ok("空名字条目不进菜单", skills.every((row) => row.name.length > 0));

// ── 2. MCP：去掉禁用、项目屏蔽与无名行 ─────────────────────────────────────
const view = {
	exclude: ["blocked"],
	servers: [
		{ serverName: "ok-stdio", transport: "stdio", enabled: true, status: "connected" },
		{ serverName: "ok-http", transport: "http", enabled: true, status: "loading" },
		{ serverName: "blocked", transport: "stdio", enabled: true, status: "connected" },
		{ serverName: "off", transport: "stdio", enabled: false, status: "disabled" },
		{ serverName: "", transport: "stdio", enabled: true, status: "connected" },
	],
};
const mcp = probe.projectQuickMcp(view);
ok("项目 MCP 去掉屏蔽与禁用条目", mcp.length === 2 && mcp.map((row) => row.name).join(",") === "ok-stdio,ok-http");
ok("项目 MCP 保留传输类型", mcp[0].transport === "stdio" && mcp[1].transport === "http");
ok("残缺 view 不抛异常", probe.projectQuickMcp(null).length === 0 && probe.projectQuickMcp({}).length === 0);

// ── 3. 计数 = 技能 + MCP，专家不参与 ───────────────────────────────────────
ok("计数为技能 + MCP", probe.projectQuickCount({ skills, mcp }) === 4);
ok("空项目计数为 0", probe.projectQuickCount({ skills: [], mcp: [] }) === 0);
ok("缺字段计数为 0", probe.projectQuickCount({}) === 0);
ok("专家字段不影响计数", probe.projectQuickCount({ skills, mcp, expert: [{ name: "x" }] }) === 4);

// ── 4. 反向自测：把收窄规则改坏，同一断言必须变红 ─────────────────────────
const looseSkills = run(slice.replace(".filter(isProjectSkillRow)", ".filter(() => true)"));
ok(
	"反向自测：技能收窄被移除 → 用户级技能会混进来（证明断言非恒真）",
	looseSkills.projectQuickSkills(skillRows).length === 4,
);
const looseMcp = run(slice.replace("!excluded.has(server.serverName)", "true"));
ok(
	"反向自测：屏蔽判定被移除 → blocked 会混进来（证明断言非恒真）",
	looseMcp.projectQuickMcp(view).length === 3,
);

// ── 5. 接线源码断言：第四行、数据源、无管理入口、分组与分割线 ───────────────
const quickKinds = source.slice(source.indexOf("const QUICK_MENU_KINDS = ["), source.indexOf("// 子菜单列表每屏固定 6 行"));
ok("一级菜单有四项且含 project", (quickKinds.match(/\{ key: '/g) || []).length === 4 && quickKinds.includes("{ key: 'project'"));
ok("第四行文案是「本项目」", quickKinds.includes("t('本项目')"));
const menuSource = source.slice(source.indexOf("const SummonQuickMenu = ("), source.indexOf("// ── 会话头「当前生效专家」徽章"));
ok("菜单通过 wbSessionWorkspace 取项目根", menuSource.includes("call('wbSessionWorkspace', { sessionId })"));
ok("项目技能走 listSkills({ cwd })", menuSource.includes("call('listSkills', { cwd })"));
ok("项目 MCP 走 getWorkspaceView({ wsPath: cwd })", menuSource.includes("call('getWorkspaceView', { wsPath: cwd })"));
ok("项目子菜单渲染技能组与 MCP 组", menuSource.includes("key: 'project-skills-group'") && menuSource.includes("key: 'project-mcp-group'"));
ok("两段都有内容才画分割线", menuSource.includes("skillRows.length && mcpRows.length ? h('div', { key: 'project-sep'"));
ok("项目分支不渲染管理入口", menuSource.includes("isProject ? null : h('button', {"));
ok("项目分支不渲染套件管理", menuSource.includes("isProject || kind.key !== 'skill'"));
ok("项目空态有独立文案入口", menuSource.includes("isProject ? projectEmptyNote() : t('暂无可选项')"));

// ── 6. 真实渲染冒烟：挂载阶段不得抛错（TDZ / 依赖数组）──────────────────────
// 2026-10-31 真机事故：sessionId 原本声明在专家段，本项目段的 useEffect 依赖数组
// 先引用了它 → 渲染时落进 TDZ，整个 slot 不渲染（输入框旁的引用按钮直接消失）。
// 静态断言先钉住声明顺序，再在 vm 里真跑一次组件挂载（关闭态），两层都能抓住回归。
const compStart = source.indexOf("const SummonQuickMenu = (");
const compEnd = source.indexOf("// ── 会话头「当前生效专家」徽章", compStart);
const componentSource = compStart >= 0 && compEnd > compStart ? source.slice(compStart, compEnd) : "";
const sessionDeclAt = componentSource.indexOf("const sessionId = typeof sessionIdProp");
const firstDepAt = componentSource.indexOf("[sessionId]");
ok(
	"sessionId 声明在依赖数组首次引用之前（TDZ 防护）",
	componentSource.length > 0 && sessionDeclAt >= 0 && firstDepAt > sessionDeclAt,
	`decl=${sessionDeclAt} firstUse=${firstDepAt}`,
);

const renderable = source.replace(
	"exports.apply = apply;",
	"exports.__SummonQuickMenu = SummonQuickMenu;\nexports.apply = apply;",
);
let factory = null;
class FakeComponent { constructor(props) { this.props = props; } setState() {} render() { return null; } }
let hookStates = [];
let hookIndex = 0;
const reactMock = {
	createElement(type, props, ...children) { return { type, props, children }; },
	Fragment: {}, Component: FakeComponent, PureComponent: FakeComponent,
	useState(init) {
		const index = hookIndex++;
		if (!(index in hookStates)) hookStates[index] = typeof init === "function" ? init() : init;
		return [hookStates[index], (next) => { hookStates[index] = typeof next === "function" ? next(hookStates[index]) : next; }];
	},
	useEffect() {}, useLayoutEffect() {},
	useCallback(fn) { return fn; }, useMemo(fn) { return fn(); },
	useRef(value) { const index = hookIndex++; if (!(index in hookStates)) hookStates[index] = { current: value }; return hookStates[index]; },
	useSyncExternalStore() { return null; },
	createContext() { return {}; }, useContext() { return null; },
	memo(fn) { return fn; }, forwardRef(fn) { return fn; },
};
const renderSandbox = {
	console,
	window: {
		__ModuleLoader__: { load(entry) { factory = entry.factory; } },
		addEventListener() {}, removeEventListener() {}, innerWidth: 1200, innerHeight: 800,
	},
	document: {
		querySelector() { return null; },
		createElement() { return { dataset: {}, style: {}, remove() {} }; },
		head: { appendChild() {} },
		addEventListener() {}, removeEventListener() {},
		documentElement: { clientWidth: 1200, clientHeight: 800 }, body: {},
	},
	localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
	navigator: { language: "zh-CN", clipboard: { writeText() { return Promise.resolve(); } } },
	performance: { now() { return 0; } },
	setTimeout, clearTimeout, setInterval, clearInterval,
	requestAnimationFrame() { return 1; }, cancelAnimationFrame() {},
	URL, URLSearchParams,
	fetch() { return Promise.reject(new Error("no network")); },
	location: { href: "dsh-app://x" },
};
renderSandbox.globalThis = renderSandbox;
renderSandbox.self = renderSandbox;
let renderTree = null;
let renderError = null;
try {
	const context = vm.createContext(renderSandbox);
	vm.runInContext(renderable, context, { filename: "client-render-smoke.js" });
	const exported = factory((name) => {
		if (name === "react") return reactMock;
		throw new Error(`unexpected require: ${name}`);
	});
	hookStates = [];
	hookIndex = 0;
	renderTree = exported.__SummonQuickMenu({ call: () => Promise.resolve({ ok: false }), inputActions: {}, sessionId: "s-test" });
} catch (error) {
	renderError = error;
}
ok(
	"关闭态真实渲染不抛错，且根节点是 .dsh-mcp-quick",
	renderError === null && renderTree && renderTree.props && renderTree.props.className === "dsh-mcp-quick",
	renderError ? String(renderError?.stack || renderError).split("\n")[0] : "",
);


console.log(failures ? `\nQUICK-MENU-PROJECT FAIL（${failures} 条）` : "\nQUICK-MENU-PROJECT PASS");
process.exit(failures ? 1 : 0);
