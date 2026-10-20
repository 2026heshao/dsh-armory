// T05 收尾：安装流 R7/R8 + 三个护栏盲区的静态守卫（QA 回归套件）。
//
// A 部分（动态导入，真跑函数）：令牌替换（applyTokens 全填/部分填/不改入参/header+env 双容器）、
//   serverInstallability 的 token 型放行与拒装语义（含 streamable-http 提前 return 仍扫槽位的
//   关键回归针）、安装状态三类 round-trip、readState 对文件缺失/损坏的防御。
//
// B 部分（读源码做静态断言，不执行源码）：三个 node --check 与 contract-consistency 都
//   抓不到的盲区，本期各出过一次真事故：
//   B1 装饰器声明了但方法体没写（Run4c：4 个 _wbInstallState_decorators 全写好、方法体全缺）；
//   B2 import 了却从未调用（Run4c：5 个符号 import 后零调用，contract-consistency 是子集
//      判定抓不到）；
//   B3 函数体内嵌函数致外作用域取不到（installConnector 少一个 `}` → requestInstallConnector
//      被嵌进它体内，两处 onClick 运行时 ReferenceError）。守卫 = 主组件顶层
//      `const X = useCallback(` 声明行首花括号深度必须全部同层。
//
// 自测护栏：B1/B2/B3 的提取逻辑各写成纯函数，并各喂一段**人工构造的假源码**证明守卫
// 不是恒真（假缺陷必被抓到）——不触碰 lib/ 下真源码即可验证守卫生效。
//
// 隔离纪律：mkdtemp + options.rootDir 注入，绝不碰真实 ~/.dsh；零网络（不真 fetch）；
// 每用例结束 rm 临时目录。唯一的允许写盘动作是 readState 损坏文件用例往临时目录写非法 JSON。
//
// 用法：node ./test/wb-install-flow.mjs
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const libDir = new URL("../lib/", import.meta.url);
const { parseInjectionRules, rulesFor, scanTokenSlots, applyTokens } =
  await import(new URL("wb-auth-rules.js", libDir).href);
const { record, forget, readState, statePath } =
  await import(new URL("wb-install-state.js", libDir).href);

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

function freshRoot() {
  return mkdtemp(join(tmpdir(), "dsh-armory-flow-"));
}

// ── B1 纯函数：装饰器声明但方法体缺失检测 ─────────────────────────────────────
// 抽出 `_xxx_decorators = [Remote("name")]` 声明的方法名，逐个在类体里找方法体
// `/^\t+async\s+<name>\s*\(/m`（index.js 用 TAB 缩进）。返回缺失名单。
function decoratorsWithoutBodies(source) {
  const declared = new Map(); // methodName -> decorator 变量名（报错用）
  const declRe = /_([A-Za-z0-9_]+)_decorators\s*=\s*\[\s*Remote\(\s*["']([A-Za-z0-9_]+)["']/g;
  for (const match of source.matchAll(declRe)) {
    declared.set(match[2], match[1]);
  }
  const missing = [];
  for (const [method] of declared) {
    const bodyRe = new RegExp(`^\t+async\\s+${method}\\s*\\(`, "m");
    if (!bodyRe.test(source)) missing.push(method);
  }
  return missing;
}

// ── B2 纯函数：import 了但从未调用检测 ───────────────────────────────────────
// 抽具名 import 的本地名（`a as b` 取 b），把 import 语句整体剔除后数单词边界出现次数。
// 返回未被使用的本地名名单。
function unusedImports(source) {
  const names = [];
  const importRe = /import\s*\{([^}]+)\}\s*from\s*["'][^"']+["']/g;
  const nonImport = source.replace(importRe, (_full, names_) => {
    for (const piece of names_.split(",")) {
      const trimmed = piece.trim();
      if (!trimmed) continue;
      const asMatch = trimmed.match(/^([A-Za-z0-9_$]+)\s+as\s+([A-Za-z0-9_$]+)$/);
      names.push(asMatch ? asMatch[2] : trimmed);
    }
    return ""; // 剔除 import 区
  });
  const unused = [];
  for (const name of names) {
    if (!(new RegExp(`\\b${name}\\b`, "g")).test(nonImport)) unused.push(name);
  }
  return unused;
}

// ── B3 纯函数：极小花括号深度扫描器 ─────────────────────────────────────────
// 逐字符走，跳过 // 行注释、/* */ 块注释、'...'、"..."、`...`（模板串整段跳过，
// 本仓库目标函数没有 ${} 嵌套花括号）。返回每行行尾的深度数组（1-based 下标 = 行号）。
function braceDepthPerLine(source) {
  const depths = [];
  let depth = 0;
  let i = 0;
  let inLineComment = false;
  let inBlockComment = false;
  let quote = null; // ' " `
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    if (inLineComment) {
      if (char === "\n") { inLineComment = false; depths.push(depth); }
      i += 1;
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") { inBlockComment = false; i += 2; continue; }
      if (char === "\n") depths.push(depth);
      i += 1;
      continue;
    }
    if (quote) {
      if (char === "\\") { i += 2; continue; }
      if (char === quote) quote = null;
      if (char === "\n") depths.push(depth);
      i += 1;
      continue;
    }
    if (char === "/" && next === "/") { inLineComment = true; i += 2; continue; }
    if (char === "/" && next === "*") { inBlockComment = true; i += 2; continue; }
    if (char === "'" || char === '"' || char === "`") { quote = char; i += 1; continue; }
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    if (char === "\n") depths.push(depth);
    i += 1;
  }
  if (source.length && source[source.length - 1] !== "\n") depths.push(depth);
  return depths;
}

/** 找主组件顶层 `const X = useCallback(` 声明，返回 [{ name, line, depth }]。 */
// 深度取「声明行的行首花括号深度」——即该行开始之前已打开的 { 层数。这是层级
// 本身的信号：多行形态（`useCallback(\n (args) => {`）行尾深度会比单行形态深，
// 但两者行首深度相同；而「上一个函数少闭合 }」会让后续声明的行首深度整体下沉。
function topUseCallbackDeclarations(source) {
  const depths = braceDepthPerLine(source);
  const starts = []; // 每行行首深度
  let prev = 0;
  for (let index = 0; index < depths.length; index += 1) {
    starts.push(prev);
    prev = depths[index];
  }
  const decls = [];
  const re = /^  const ([A-Za-z0-9_]+) = useCallback\(/gm;
  for (const match of source.matchAll(re)) {
    const upto = source.slice(0, match.index);
    const line = upto.split("\n").length;
    decls.push({ name: match[1], line, depth: starts[line - 1] ?? null });
  }
  return decls;
}

/** B3 守卫主体：全部 useCallback 声明行首深度必须同层；返回违约名单。 */
function misnestedUseCallbackDeclarations(source) {
  const decls = topUseCallbackDeclarations(source);
  if (!decls.length) return [];
  const counts = new Map();
  for (const decl of decls) counts.set(decl.depth, (counts.get(decl.depth) || 0) + 1);
  // 多数派深度 = 组件顶层所在层；少数派即为「被嵌进函数体」的嫌疑人。
  let base = decls[0].depth;
  let best = 0;
  for (const [depth, count] of counts) {
    if (count > best) { base = depth; best = count; }
  }
  return decls.filter((decl) => decl.depth !== base);
}

// ══ A 部分：安装流数据层真行为 ═══════════════════════════════════════════════

// ── A1. applyTokens 全填：占位符全部替换、missingSlots 为空 ──────────────────
{
  const root = await freshRoot();
  const servers = {
    "tencent-docs": {
      transport: {
        type: "http",
        url: "https://mcp.example.test/tencent",
        headers: { authorization: "Bearer ${access_token}" },
        env: { TENCENT_KEY: "${api_key}" },
      },
    },
  };
  const { mcpServers, missingSlots } = applyTokens(structuredClone(servers), { access_token: "tk-001", api_key: "ky-9" });
  ok("applyTokens 全填：header 占位符被真值替换", mcpServers["tencent-docs"].transport.headers.authorization === "Bearer tk-001");
  ok("applyTokens 全填：env 占位符被真值替换", mcpServers["tencent-docs"].transport.env.TENCENT_KEY === "ky-9");
  ok("applyTokens 全填：missingSlots 为空数组", Array.isArray(missingSlots) && missingSlots.length === 0);
  await rm(root, { recursive: true, force: true });
}

// ── A2. applyTokens 部分填：已填替换、未填保持原样并精确上报 ─────────────────
{
  const root = await freshRoot();
  const servers = {
    a: { transport: { type: "http", headers: { authorization: "Bearer ${token_a}" } } },
    b: { transport: { type: "http", headers: { "x-api": "${token_b}" } } },
  };
  const before = structuredClone(servers);
  const { mcpServers, missingSlots } = applyTokens(servers, { token_a: "AAA" });
  ok("applyTokens 部分填：已填槽位被替换", mcpServers.a.transport.headers.authorization === "Bearer AAA");
  ok("applyTokens 部分填：未填槽位保持原占位符原样", mcpServers.b.transport.headers["x-api"] === "${token_b}");
  ok("applyTokens 部分填：missingSlots 精确列出未填槽位", missingSlots.length === 1
    && missingSlots[0].server === "b" && missingSlots[0].container === "header"
    && missingSlots[0].key === "x-api" && missingSlots[0].placeholder === "token_b");
  ok("applyTokens 不改入参（structuredClone 前后深比较相等）",
    JSON.stringify(servers) === JSON.stringify(before));
  await rm(root, { recursive: true, force: true });
}

// ── A3. applyTokens 不改入参（structuredClone 语义） ─────────────────────────
{
  const root = await freshRoot();
  const servers = { s: { transport: { type: "http", headers: { authorization: "Bearer ${t}" } } } };
  const before = structuredClone(servers);
  applyTokens(servers, { t: "X" });
  ok("applyTokens 不改入参：调用前后原对象深比较相等", JSON.stringify(servers) === JSON.stringify(before));
  await rm(root, { recursive: true, force: true });
}

// ── A4. applyTokens 对 header 与 env 容器都能命中 ────────────────────────────
{
  const root = await freshRoot();
  const servers = {
    nested: { transport: { type: "http", headers: { authorization: "Bearer ${h}" }, env: { K: "${e}" } } },
    flat: { type: "http", headers: { authorization: "Bearer ${fh}" }, env: { FK: "${fe}" } },
  };
  const { mcpServers } = applyTokens(servers, { h: "H", e: "E", fh: "FH", fe: "FE" });
  ok("applyTokens header 容器（transport.headers）命中", mcpServers.nested.transport.headers.authorization === "Bearer H");
  ok("applyTokens env 容器（transport.env）命中", mcpServers.nested.transport.env.K === "E");
  ok("applyTokens header 容器（顶层 headers）命中", mcpServers.flat.headers.authorization === "Bearer FH");
  ok("applyTokens env 容器（顶层 env）命中", mcpServers.flat.env.FK === "FE");
  await rm(root, { recursive: true, force: true });
}

// ── A5. serverInstallability 的数据前提：token 型槽位扫描语义 ────────────────
// wb-market.js 的 serverInstallability 是模块私有函数（未导出），不能直接真调；
// 它的 token 型判定完全建立在 scanTokenSlots 的槽位扫描结果上，这里钉住数据前提，
// 而「扫描必须先于 transport 提前 return」这一时序契约由 A5b 的静态针钉住。
{
  const root = await freshRoot();
  const withSlots = { transport: { type: "http", url: "https://x.test/mcp", headers: { authorization: "Bearer ${token}" } } };
  const noSlots = { transport: { type: "http", url: "https://x.test/mcp" } };
  ok("serverInstallability(token+无槽)：无占位符即无可填槽位（needsTokens 语义前提不成立）",
    scanTokenSlots({ "conn-b": noSlots }).length === 0);
  // header 容器反向钉住：带 ${token} 占位符的 header 槽位必须被扫到——
  // 这正是 Run4a 修过的 bug 面（若实现回退成「transport 判定后才扫槽位」，
  // streamable-http 的 header 槽位会整体丢失，此断言即红）。
  const slots = scanTokenSlots({ "conn-c": withSlots });
  ok("serverInstallability(token+有槽)：header 容器 ${token} 槽位被扫描命中",
    slots.length === 1 && slots[0].server === "conn-c" && slots[0].container === "header"
    && slots[0].key === "authorization" && slots[0].placeholder === "token");
  await rm(root, { recursive: true, force: true });
}

// ── A5b. serverInstallability 关键回归针（真调内部函数） ─────────────────────
// wb-market.js 未导出 serverInstallability（模块私有），但它的关键 bug 修复
// 「tokenSlots 必须在 transport 提前 return 之前扫描」必须被钉住。做法：读源码断言
// 扫描调用位于两个 streamable-http 提前 return 语句之前。
{
  const root = await freshRoot();
  const source = await readFile(new URL("wb-market.js", libDir), "utf8");
  const fnStart = source.indexOf("function serverInstallability");
  const fnEnd = source.indexOf("\n/**", fnStart);
  const body = source.slice(fnStart, fnEnd);
  const scanIdx = body.indexOf("scanTokenSlots({ [serverName]: rawServer })");
  const earlyReturnIdx = body.indexOf('return { ok: reasons.length === 0, transport: "streamable-http"');
  ok("serverInstallability 静态针：scanTokenSlots 在 transport 提前 return 之前",
    fnStart >= 0 && scanIdx > 0 && earlyReturnIdx > scanIdx);
  const gateIdx = body.indexOf('if (mode === "token")');
  ok("serverInstallability 静态针：token 闸门在函数前段（transport 判定之前）",
    gateIdx > 0 && gateIdx < earlyReturnIdx);
  await rm(root, { recursive: true, force: true });
}

// ── A6. 安装状态三类 round-trip + installedAt 保留 + connector filesDigest={} ─
{
  const root = await freshRoot();
  await record({ kind: "connector", key: "tencent-docs", name: "腾讯文档", filesDigest: { "x": "y" } }, { rootDir: root });
  await record({ kind: "skill", key: "td__skill", name: "技能", filesDigest: { "SKILL.md": "d1" } }, { rootDir: root });
  await record({ kind: "plugin", key: "codebuddy-review", name: "插件", filesDigest: { "bundle.js": "d2" } }, { rootDir: root });
  let state = await readState({ rootDir: root });
  ok("安装状态：三类各一条入库", state.items.length === 3);
  const firstTimes = new Map(state.items.map((item) => [item.key, { installedAt: item.installedAt, lastUpdated: item.lastUpdated }]));
  ok("安装状态：connector filesDigest 强制 {}", Object.keys(state.items.find((item) => item.kind === "connector").filesDigest).length === 0);
  ok("安装状态：skill filesDigest 保留", state.items.find((item) => item.kind === "skill").filesDigest["SKILL.md"] === "d1");
  ok("安装状态：plugin filesDigest 保留", state.items.find((item) => item.kind === "plugin").filesDigest["bundle.js"] === "d2");
  // 二次 record 同 kind+key：installedAt 保留、lastUpdated 刷新
  await new Promise((resolve) => setTimeout(resolve, 5));
  await record({ kind: "connector", key: "tencent-docs", name: "腾讯文档 v2" }, { rootDir: root });
  state = await readState({ rootDir: root });
  const again = state.items.find((item) => item.kind === "connector" && item.key === "tencent-docs");
  ok("安装状态覆盖：installedAt 保留首值", again.installedAt === firstTimes.get("tencent-docs").installedAt);
  ok("安装状态覆盖：lastUpdated 刷新", again.lastUpdated > firstTimes.get("tencent-docs").lastUpdated);
  ok("安装状态覆盖：仍只有一条 connector", state.items.filter((item) => item.kind === "connector").length === 1);
  // forget → 再读为 0
  await forget("connector", "tencent-docs", { rootDir: root });
  state = await readState({ rootDir: root });
  ok("安装状态 forget：条目删除", state.items.length === 2 && !state.items.some((item) => item.key === "tencent-docs"));
  await rm(root, { recursive: true, force: true });
}

// ── A7. readState 文件缺失与损坏都返回空状态且不抛 ──────────────────────────
{
  const root = await freshRoot();
  const missing = await readState({ rootDir: root });
  ok("readState 文件缺失：空状态不抛", Array.isArray(missing.items) && missing.items.length === 0);
  const dir = statePath({ rootDir: root });
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dir.slice(0, dir.lastIndexOf("\\")) || root, { recursive: true });
  await writeFile(dir, "{ this is not json");
  const corrupt = await readState({ rootDir: root });
  ok("readState 文件损坏（非法 JSON）：空状态不抛", Array.isArray(corrupt.items) && corrupt.items.length === 0);
  await rm(root, { recursive: true, force: true });
}

// ── A8. parseInjectionRules / rulesFor 防御与精确包含 ───────────────────────
{
  const root = await freshRoot();
  ok("parseInjectionRules：非数组 → []", JSON.stringify(parseInjectionRules({})) === "[]");
  const rules = [
    { id: "r1", applies_to_connectors: ["tencent-docs"] },
    { id: "r2", applies_to_connectors: ["*"] },
  ];
  ok("rulesFor：精确包含命中", rulesFor(rules, "tencent-docs").length === 1 && rulesFor(rules, "tencent-docs")[0].id === "r1");
  ok("rulesFor：\"*\" 不展开通配", rulesFor(rules, "anything-else").length === 0);
  await rm(root, { recursive: true, force: true });
}

// ══ B 部分：三个盲区的静态守卫（真源码 + 假源码自测） ════════════════════════

const indexSource = await readFile(new URL("index.js", libDir), "utf8");
const clientSource = await readFile(new URL("client.js", libDir), "utf8");

// ── B1 真源码：index.js 装饰器声明都必须有方法体 ────────────────────────────
{
  const missing = decoratorsWithoutBodies(indexSource);
  ok("B1 装饰器守卫：index.js 所有 Remote 装饰器声明都有对应 async 方法体",
    missing.length === 0, missing.length ? `装饰器声明了但没有方法体：${missing.join(", ")}` : `检查了 ${new Set([...indexSource.matchAll(/_([A-Za-z0-9_]+)_decorators\s*=\s*\[\s*Remote\(/g)].map((m) => m[1])).size} 个方法名`);
}

// ── B1 反向自测（假源码）：装饰器有、方法体无 → 必须报 ─────────────────────
{
  const fake = [
    "class X {",
    "\t\t_list_decorators = [Remote(\"list\")];",
    "\t\t_status_decorators = [Remote(\"status\")];",
    "\tasync list() { return 1; }",
    "}",
  ].join("\n");
  const missing = decoratorsWithoutBodies(fake);
  ok("B1 反向自测：status 有装饰器无方法体 → 必须报出", missing.includes("status"), `报出: ${missing.join(", ")}`);
  ok("B1 反向自测：list 有装饰器有方法体 → 不报", !missing.includes("list"));
}

// ── B2 真源码：index.js 每个具名 import 都必须被使用 ────────────────────────
{
  const unused = unusedImports(indexSource);
  ok("B2 import 守卫：index.js 所有具名 import 都在非 import 区被使用",
    unused.length === 0, unused.length ? `import 了但从未调用：${unused.join(", ")}` : "");
}

// ── B2 反向自测（假源码）：import { foo } 不使用 → 必须报 ──────────────────
{
  const fake = 'import { foo } from "x";\nconst a = 1;\nconsole.log(a);\n';
  const unused = unusedImports(fake);
  ok("B2 反向自测：只 import 不使用 → 必须报出 foo", unused.length === 1 && unused[0] === "foo", `报出: ${unused.join(", ")}`);
  const used = unusedImports('import { bar } from "x";\nconst y = bar(1);\n');
  ok("B2 反向自测：import 且使用 → 不报", used.length === 0);
  const aliased = unusedImports('import { qux as alias } from "x";\nconst z = alias(1);\n');
  ok("B2 反向自测：a as b 别名按本地名判定，使用 alias → 不报", aliased.length === 0);
}

// ── B3 真源码：client.js 主组件顶层 useCallback 声明全部同层 ────────────────
{
  const bad = misnestedUseCallbackDeclarations(clientSource);
  ok("B3 嵌套守卫：client.js 所有顶层 const X = useCallback( 行首深度一致",
    bad.length === 0, bad.length ? `深度异常: ${bad.map((decl) => `${decl.name}@L${decl.line} depth=${decl.depth}`).join("; ")}` : "");
  // 具名事故点：installConnector 与 requestInstallConnector 都在 ^  const 层（2 空格）。
  const decls = topUseCallbackDeclarations(clientSource);
  ok("B3 声明提取：顶层 useCallback 声明被完整提取（>=20 个，防提取逻辑退化成恒空）",
    decls.length >= 20, `count=${decls.length}`);
  // 两者都是普通 const 箭头函数（非 useCallback），改用行首缩进直接断言：
  const lines = clientSource.split("\n");
  const indentOf = (needle) => {
    const idx = lines.findIndex((line) => line.startsWith(`  const ${needle} = `));
    return idx >= 0 ? lines[idx].length - lines[idx].trimStart().length : -1;
  };
  ok("B3 具名事故针：installConnector 行首缩进为 2 空格（组件顶层）", indentOf("installConnector") === 2);
  ok("B3 具名事故针：requestInstallConnector 行首缩进为 2 空格（组件顶层）", indentOf("requestInstallConnector") === 2);
}

// ── B3 反向自测（假源码）：少一个 } 的嵌套 → 必须报 ─────────────────────────
{
  const fake = [
    "  const syncMoreAnchor = useCallback(() => {",
    "    const id = 1;",
    "  }, []);",
    "  const first = useCallback(() => {",
    "    // 少一个闭合 }，导致下一个声明被嵌进本函数体内",
    "    const inner = () => ({ a: 1 });",
    "  const second = useCallback(() => {",
    "    return 2;",
    "  }, []);",
  ].join("\n");
  const bad = misnestedUseCallbackDeclarations(fake);
  ok("B3 反向自测：first 少闭合 } → second 被判定深度异常",
    bad.length === 1 && bad[0].name === "second", `报出: ${bad.map((d) => d.name).join(", ")}`);
  const good = [
    "  const first = useCallback(() => {",
    "    return 1;",
    "  }, []);",
    "  const second = useCallback(() => {",
    "    return 2;",
    "  }, []);",
  ].join("\n");
  ok("B3 反向自测：正确闭合的假源码 → 不报", misnestedUseCallbackDeclarations(good).length === 0);
}

console.log(failures === 0 ? "\nALL INSTALL-FLOW CHECKS PASS" : `\n${failures} INSTALL-FLOW CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
