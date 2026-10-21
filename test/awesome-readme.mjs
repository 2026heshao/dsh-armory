// README 预览：解析器 / 服务端入口 / Markdown 渲染器（不联网、不开浏览器）。
// 渲染器从 lib/client.js 里整节抽出来在 vm 里真跑，避免为了测试引入构建或 DOM 依赖。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { parseGithubRepo, wbAwesomeReadme } from "../lib/wb-awesome-market.js";

const here = dirname(fileURLToPath(import.meta.url));
// 注意：仓库路径含中文，必须走 fileURLToPath，URL.pathname 会把中文转义成 %XX 导致读不到文件。
const CLIENT = join(here, "..", "lib", "client.js");

let failed = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail === undefined ? "" : ` → ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
  }
}

// ── 1. GitHub 仓库地址解析 ────────────────────────────────────────────────
console.log("[1] parseGithubRepo");
const REPO_CASES = [
  ["https://github.com/dshworks/awesome-dsh-plugins", "dshworks/awesome-dsh-plugins"],
  ["https://github.com/foo/bar.git", "foo/bar"],
  ["git@github.com:foo/bar.git", "foo/bar"],
  ["foo/bar", "foo/bar"],
  ["https://github.com/foo/bar/tree/main/packages/x", "foo/bar"],
  ["github.com/foo/bar", ""],
  ["https://gitlab.com/foo/bar", ""],
  ["https://example.com/x", ""],
  ["", ""],
  [null, ""],
];
for (const [input, want] of REPO_CASES) {
  const got = parseGithubRepo(input);
  check(`${String(input)} → ${want || "(空)"}`, got === want, got);
}

// ── 2. 服务端入口：无来源时快速失败，不发请求 ──────────────────────────────
console.log("[2] wbAwesomeReadme / no-source");
const root = mkdtempSync(join(tmpdir(), "armory-readme-"));
try {
  const res = await wbAwesomeReadme({ name: "no-such-entry-xyz", rootDir: root });
  check("ok=false", res && res.ok === false, res && res.ok);
  check("reason=no-source", res && res.reason === "no-source", res && res.reason);
  check("带可读 error 文案", Boolean(res && typeof res.error === "string" && res.error.length > 0), res && res.error);
  check("无 markdown 字段", !(res && res.markdown), res && res.markdown);
} finally {
  rmSync(root, { recursive: true, force: true });
}

// ── 3. Markdown 渲染器（vm 内真跑，无需 DOM） ──────────────────────────────
const source = readFileSync(CLIENT, "utf8");
const startAt = source.indexOf("const README_STYLE_ID =");
const endAt = source.indexOf("// ── 样式表 MCP_CSS", startAt);
check("抽到渲染器源码切片", startAt > 0 && endAt > startAt, { startAt, endAt });
const block = source.slice(startAt, endAt);
check("切片里含 renderReadmeBlocks", /function renderReadmeBlocks\s*\(/.test(block));

const h = (type, props, ...children) => ({
  type,
  props: props || {},
  children: children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false),
});
const sandbox = {
  h,
  URL,
  KEY_PREFIX: "dsh-armory",
  React: { Fragment: "Fragment" },
  t: (text) => text,
  console,
  document: { getElementById: () => null, createElement: () => ({ setAttribute() {}, appendChild() {} }), head: { appendChild() {} } },
};
vm.createContext(sandbox);
vm.runInContext(block, sandbox);

const BASE = "https://example.test/base/";
const render = (markdown, base = BASE) => sandbox.renderReadmeBlocks(markdown, base);

/** 深度优先收集节点，方便做结构断言。 */
function collect(node, out = []) {
  if (Array.isArray(node)) {
    for (const item of node) collect(item, out);
    return out;
  }
  if (!node || typeof node !== "object") return out;
  out.push(node);
  collect(node.children, out);
  return out;
}
const ofType = (tree, type) => collect(tree).filter((node) => node.type === type);
function treeText(node) {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(treeText).join("");
  if (!node || typeof node !== "object") return "";
  return (node.children || []).map(treeText).join("");
}

console.log("[3] 块级渲染");
const headingTree = render("# Title **bold**");
const heading = ofType(headingTree, "div").find((node) => node.props.role === "heading");
check("标题 → 带 role=heading 的 div", Boolean(heading));
check("标题 aria-level 降两级（h1→3）", heading && heading.props["aria-level"] === "3", heading && heading.props["aria-level"]);
check("标题内粗体被递归渲染成 strong", ofType(headingTree, "strong").length === 1);

const listTree = render(["- one", "- two", "  - nested"].join("\n"));
check("无序列表 → ul", ofType(listTree, "ul").length === 1);
check("列表项 3 个", ofType(listTree, "li").length === 3, ofType(listTree, "li").length);
check("列表文字完整", treeText(listTree).includes("nested"), treeText(listTree));

const orderedTree = render(["1. first", "2. second"].join("\n"));
check("有序列表 → ol", ofType(orderedTree, "ol").length === 1);

const fenceTree = render(["```js", "const a = 1;", "```"].join("\n"));
check("代码块 → pre/code", ofType(fenceTree, "pre").length === 1 && ofType(fenceTree, "code").length === 1);
check("代码块保留原文", treeText(fenceTree).includes("const a = 1;"), treeText(fenceTree));

const quoteTree = render("> quoted");
check("引用 → blockquote", ofType(quoteTree, "blockquote").length === 1);

const tableTree = render(["| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n"));
check("表格 → table/thead/tbody", ofType(tableTree, "table").length === 1 && ofType(tableTree, "thead").length === 1 && ofType(tableTree, "tbody").length === 1);
check("表头 2 格", ofType(tableTree, "th").length === 2);
check("表格数据 2 格", ofType(tableTree, "td").length === 2);

const hrTree = render("---");
check("分隔线 → hr", ofType(hrTree, "hr").length === 1);

console.log("[4] 行内渲染");
const inlineTree = render("Intro with `code`, **bold**, [link](docs/a.md) and ![shot](img/x.png).");
check("行内代码 → code", ofType(inlineTree, "code").length === 1);
check("行内粗体 → strong", ofType(inlineTree, "strong").length === 1);
const anchor = ofType(inlineTree, "a")[0];
check("相对链接按 base 还原成绝对地址", Boolean(anchor) && anchor.props.href === `${BASE}docs/a.md`, anchor && anchor.props.href);
check("外链带 noopener", Boolean(anchor) && anchor.props.rel === "noreferrer noopener", anchor && anchor.props.rel);
const image = ofType(inlineTree, "img")[0];
check("相对插图按 base 还原", Boolean(image) && image.props.src === `${BASE}img/x.png`, image && image.props.src);
check("图片懒加载 + 不传 referrer", Boolean(image) && image.props.loading === "lazy" && image.props.referrerPolicy === "no-referrer");

// 插图尺寸与加载：README 截图动辄 1600~3000px，直连原图既撑爆弹层又要下几 MB。
const GH_IMG = "https://raw.githubusercontent.com/foo/bar/main/docs/a.png";
const ghTree = render(`![shot](${GH_IMG})`);
const ghImg = ofType(ghTree, "img")[0];
check(
  "GitHub 图源改走缩图代理",
  Boolean(ghImg) && ghImg.props.src.startsWith("https://wsrv.nl/?") && ghImg.props.src.endsWith(encodeURIComponent(GH_IMG)),
  ghImg && ghImg.props.src,
);
check("代理地址保留原图用于失败回退", Boolean(ghImg) && ghImg.props["data-readme-origin"] === GH_IMG, ghImg && ghImg.props["data-readme-origin"]);
check(
  "块级插图限高 40vh 且等比不裁切",
  Boolean(ghImg) && ghImg.props.style.maxHeight === "min(40vh,420px)" && ghImg.props.style.objectFit === "contain" && ghImg.props.style.width === "auto",
  ghImg && ghImg.props.style.maxHeight,
);
check("异步解码 + 懒加载", Boolean(ghImg) && ghImg.props.decoding === "async" && ghImg.props.loading === "lazy");

const npmTree = render("![logo](https://registry.npmjs.org/x/-/logo.png)");
const npmImg = ofType(npmTree, "img")[0];
check("非 GitHub 图源不代理", Boolean(npmImg) && npmImg.props.src === "https://registry.npmjs.org/x/-/logo.png" && !("data-readme-origin" in npmImg.props), npmImg && npmImg.props.src);

check("行内插图不代理且压到 22px", Boolean(image) && image.props.style.maxHeight === "22px" && !("data-readme-origin" in image.props), image && image.props.style.maxHeight);

// onError 两级回退：代理挂 → 原图；原图也挂 → 隐藏。
const fakeImg = {
  attrs: { src: ghImg.props.src, "data-readme-origin": GH_IMG },
  style: {},
  getAttribute(key) { return this.attrs[key]; },
  setAttribute(key, value) { this.attrs[key] = value; },
  removeAttribute(key) { delete this.attrs[key]; },
};
ghImg.props.onError({ currentTarget: fakeImg });
check("代理失败回退原图", fakeImg.attrs.src === GH_IMG && !("data-readme-origin" in fakeImg.attrs), fakeImg.attrs.src);
ghImg.props.onError({ currentTarget: fakeImg });
check("原图也失败则隐藏", fakeImg.style.display === "none", fakeImg.style.display);

console.log("[5] 安全边界");
const jsLinkTree = render("[bad](javascript:alert(1))");
check("javascript: 伪链接不生成 href", ofType(jsLinkTree, "a").length === 0);
check("伪链接降级为纯文本", treeText(jsLinkTree).includes("bad"), treeText(jsLinkTree));
const dataImgTree = render("![x](data:image/png;base64,iVBORw0KGgo=)");
check("data:image 插图放行", ofType(dataImgTree, "img").length === 1);
const noBaseTree = render("[rel](docs/a.md)", "");
check("无 base 时相对链接不猜地址", ofType(noBaseTree, "a").length === 0);
check("任何节点都不用 dangerouslySetInnerHTML", collect(render(["# T", "", "| a |", "| --- |", "| 1 |", "", "<b>x</b>"].join("\n"))).every((node) => !("dangerouslySetInnerHTML" in node.props)));

console.log("[6] 裸 HTML 块");
const htmlTree = render(['<img src="img/y.png" width="40" alt="raw">', "", "<b>bold html</b>"].join("\n"));
check("HTML 块里的 img 被薅出来", ofType(htmlTree, "img").length === 1, ofType(htmlTree, "img").length);
check("HTML 标签被剥成纯文本", treeText(htmlTree).includes("bold html") && !treeText(htmlTree).includes("<b>"), treeText(htmlTree));

console.log("[7] 大文档不炸栈");
const bigMarkdown = Array.from({ length: 400 }, (_, i) => `## 段 ${i}\n\n正文 **${i}** [l](a.md)\n\n- x\n- y`).join("\n\n");
const startedAt = process.hrtime.bigint();
const bigTree = render(bigMarkdown);
const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
check("400 段渲染出节点", collect(bigTree).length > 400, collect(bigTree).length);
check("400 段耗时 < 3000ms", elapsedMs < 3000, `${elapsedMs.toFixed(1)}ms`);

if (failed > 0) {
  console.log(`AWESOME-README FAILED: ${failed} 项`);
  process.exitCode = 1;
} else {
  console.log("AWESOME-README PASS");
}