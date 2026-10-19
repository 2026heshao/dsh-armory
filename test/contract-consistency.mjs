// 契约三处一致性（护栏 1）：
//   ① lib/typert.js   —— TYPERT 声明层（strict schema，宿主 loader 注册进 ctx.typert.local）
//   ② lib/client.js   —— 浏览器半契约数组 MCP_CONTRIBUTION.descriptors（面板能调什么）
//   ③ lib/index.js    —— 宿主 McpManagerGateway（strict 描述符直接 Reflect 到的方法 + Remote 装饰器）
// 「面板调了 ⇒ 宿主有 ⇒ 类型层有 schema」——漏一层就是恒 404（toolTailor、installInfo 踩过）。
//
// 方向（基于 @deepseek-ai/dsh-api-gateway 真实分发链核实，不是猜的）：
//   - client ⊆ typert  —— 面板调用走 strict 描述符；typert.js 没声明的 method 在
//     typert-loader 注册后就不可达（SRC fallback 只认 Remote 装饰器打的 marker）。
//   - client ⊆ index 方法集 —— 网关 prepareInvocation 把 descriptor.method 直接
//     Reflect.get 到类实例；不存在就是 gateway/method-unavailable。方法集 = 装饰器方法
//     ∪ 无装饰器 async 方法（后者靠 strict 声明可达，**不是缺陷**——所以这里的第三处
//     不是「装饰器列表」而是完整方法集；只数装饰器会把 14+ 个合法方法误报成缺失）。
//   - index 装饰器 ⊆ typert —— 装饰器存在就有 marker，可与 strict 并存（同名冗余合法），
//     但装饰器的 Remote 名必须声明过，否则 marker 只走 SRC fallback、没有 strict schema。
//   - typert ⊆ client / typert ⊆ index **不要求**：typert 可以有非 RPC 的纯类型条目。
//
// 全部运行时解析三份源码，不硬编码方法名或数量：client.js 正在被持续改写，
// 任何硬编码常量都会让护栏变成第二条「下次改动必红」的坑。
//
// 只用 node: 内置模块。用法：node ./test/contract-consistency.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const LIB = join(here, "..", "lib");

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

/** 按（首个匹配行号升序）报告一个差集，方便一眼定位要改哪一层。 */
function diffDetail(label, missing) {
  if (!missing.length) return "";
  return missing.join(", ");
}

/** 读文件并带「读得到但解析零命中必须 FAIL」的前置断言。 */
function readSource(file, label) {
  try {
    return readFileSync(join(LIB, file), "utf8");
  } catch (cause) {
    ok(`${label}：源文件可读（${file}）`, false, String(cause?.message ?? cause));
    return null;
  }
}

// ── ① typert.js：mv('方法名', ...) 声明 ────────────────────────────────────
const typertText = readSource("typert.js", "typert 声明层");
let typertMethods = [];
let typertHits = 0;
if (typertText !== null) {
  // mv 的真实形态是 `mv('list', {...}, 'ListResult')`（单/双引号都兼容）。
  const mvRe = /\bmv\(\s*['"]([A-Za-z0-9_]+)['"]/g;
  const seen = new Set();
  for (const match of typertText.matchAll(mvRe)) {
    typertHits += 1;
    seen.add(match[1]);
  }
  typertMethods = [...seen];
  ok("typert 声明层：mv 模式有命中", typertHits > 0, `命中 ${typertHits} 处 / 去重 ${typertMethods.length} 个方法`);
}

// ── ② client.js：MCP_CONTRIBUTION.descriptors 的契约条目 ──────────────────
const clientText = readSource("client.js", "client 契约层");
let clientMethods = [];
if (clientText !== null) {
  // 不能裸匹配 method: 'x' —— client.js 里 method: 还有别的用途。锚定契约条目本身：
  // id 里带 `dsh-armory#mcpManager/<method>`，同一行上的 method: 必须与之一致。
  // 有 export 别名的条目（id 是别名）以 id 段为准——它才是面板实际调用的端点名。
  const contractRe = /id:\s*['"]dsh-armory#mcpManager\/([A-Za-z0-9_]+)['"][^\n]*?method:\s*['"]([A-Za-z0-9_]+)['"]/g;
  const seen = new Set();
  const mismatches = [];
  for (const match of clientText.matchAll(contractRe)) {
    seen.add(match[1]);
    if (match[1] !== match[2]) mismatches.push(`${match[1]} ≠ method:${match[2]}`);
  }
  clientMethods = [...seen];
  ok("client 契约层：id 锚定模式有命中", clientMethods.length > 0, `${clientMethods.length} 条契约`);
  ok("client 契约层：id 与 method 字段一致", mismatches.length === 0, mismatches.join("; "));
  // 孤儿 method（method: 有、id 没锚到）的廉价兜底：契约条目行必然同时带两段。
  const orphans = [...clientText.matchAll(/method:\s*['"]([A-Za-z0-9_]+)['"]/g)]
    .map((match) => match[1])
    .filter((method) => !clientMethods.includes(method) && /dsh-armory#mcpManager/.test(clientText));
  if (orphans.length) {
    console.log(`NOTE  client 契约层：以下 method 出现但未被 id 锚定（人工核对是否新条目写法变了）：${[...new Set(orphans)].join(", ")}`);
  }
}

// ── ③ index.js：Remote 装饰器 ∪ 无装饰器 async 方法 ───────────────────────
const indexText = readSource("index.js", "index 宿主层");
let decoratorTargets = [];
let classMethods = [];
if (indexText !== null) {
  // 装饰器声明：_x_decorators = [Remote("x")]（也可能单引号/带第二参，都兼容）。
  const decoratorRe = /_([A-Za-z0-9_]+)_decorators\s*=\s*\[\s*Remote\(\s*["']([A-Za-z0-9_]+)["']/g;
  const seenDecorators = new Set();
  for (const match of indexText.matchAll(decoratorRe)) seenDecorators.add(match[2]);
  decoratorTargets = [...seenDecorators];

  // 宿主类 McpManagerGateway 的方法集：从 class 声明行截到 IIFE 收尾 `})();`，
  // 避免把文件里其它工具函数（summarizeWorkspaceRow 等）误当 RPC 方法。
  const classStart = indexText.indexOf("return class McpManagerGateway extends");
  const classEndAnchor = indexText.indexOf("})();", classStart);
  if (classStart === -1 || classEndAnchor === -1) {
    ok("index 宿主层：McpManagerGateway 类边界可定位", false);
  } else {
    const classBody = indexText.slice(classStart, classEndAnchor);
    // 方法声明形态：`async name(...)` / `name(...)`，任何缩进（装饰器方法与普通方法缩进不同，但都算）。
    const methodRe = /^\s*(?:async\s+)?([A-Za-z0-9_]+)\s*\([^)]*\)\s*\{/gm;
    const seenMethods = new Set();
    for (const match of classBody.matchAll(methodRe)) seenMethods.add(match[1]);
    // 构造器等特殊名剔除（constructor 不会是 RPC 端点）。
    seenMethods.delete("constructor");
    classMethods = [...seenMethods];
    ok("index 宿主层：装饰器 Remote 有命中", decoratorTargets.length > 0, `${decoratorTargets.length} 个装饰器目标`);
    ok("index 宿主层：类方法有命中", classMethods.length > 0, `${classMethods.length} 个方法（含非 RPC 成员）`);
  }
}

// ── 三向一致性 ─────────────────────────────────────────────────────────────
console.log("\n── 契约三处一致性 ──");
console.log(`  typert 声明: ${typertMethods.length}  client 契约: ${clientMethods.length}  index 装饰器: ${decoratorTargets.length}  index 方法集: ${classMethods.length}`);

const missingInTypert = clientMethods.filter((method) => !typertMethods.includes(method));
ok(
  "client ⊆ typert（面板可调 ⇒ 类型层已声明）",
  typertMethods.length > 0 && clientMethods.length > 0 && missingInTypert.length === 0,
  missingInTypert.length ? `typert 缺: ${diffDetail("typert", missingInTypert)}` : "0 缺口",
);

const missingInIndex = clientMethods.filter((method) => !classMethods.includes(method));
ok(
  "client ⊆ index 方法集（面板可调 ⇒ 宿主可 Reflect 到）",
  classMethods.length > 0 && clientMethods.length > 0 && missingInIndex.length === 0,
  missingInIndex.length ? `index 缺: ${diffDetail("index", missingInIndex)}` : "0 缺口",
);

const missingTypertForDecorators = decoratorTargets.filter((method) => !typertMethods.includes(method));
ok(
  "index 装饰器 ⊆ typert（有 marker ⇒ 有 strict schema）",
  typertMethods.length > 0 && decoratorTargets.length > 0 && missingTypertForDecorators.length === 0,
  missingTypertForDecorators.length ? `typert 缺: ${diffDetail("typert", missingTypertForDecorators)}` : "0 缺口",
);

// informational：无装饰器方法的 typert 覆盖（它们只靠 strict 声明可达，缺声明才是真 404）。
// 已被上面的 client ⊆ typert 覆盖（client 会包含这些端点）；这里单独打印帮助定位。
const undecorated = classMethods.filter((method) => !decoratorTargets.includes(method) && typertMethods.includes(method));
if (undecorated.length) {
  console.log(`NOTE  无装饰器、靠 strict 声明可达的方法（合法形态，非缺陷）：${undecorated.join(", ")}`);
}

console.log(failures === 0 ? "\nCONTRACT CONSISTENCY PASS" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
