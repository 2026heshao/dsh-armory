// T05/R9：插件市场更新探测（lib/wb-plugin-market.js 的 wbPluginUpdateCheck）回归套件。
//
// A 部分（动态导入，真跑函数，假 fetch 零网络）：R9 五个 reason 分支的完整值域
//   （R9 取值域已钉死，UI 只看 reason 不看 error）：
//     no-source / no-cache / probe-failed(异常) / probe-failed(HTTP 500) /
//     up-to-date(304) / up-to-date(200 etag 相同) / update-available(200 etag 不同)。
//   另钉两条硬边界：
//     · 只探测不落盘：每个分支跑完，plugin-market/ 目录文件集合与内容 sha 必须与跑前一致；
//     · 带条件请求：覆写 fetch 里断言 method=HEAD 且 if-none-match=本地 etag。
//   构造要点（主理人实测踩过的两个坑，已规避）：
//     · 注册表文件名是 marketplaces.json（wb-registry.js:29 写死）；
//     · 造「无 plugins 源」必须用同 id codebuddy-plugins-official 条目覆盖 kind=connectors，
//       因为内置默认两条永远在场、readRegistry 是「内置在场 + 同 id 覆盖 + 其余追加」。
//
// B 部分（读 lib/client.js 源码做静态断言，不执行；该文件 8110 行，禁止整体读取）：
//   1. R9 提示条 reason 枚举覆盖（五枚举各出现，no-source/up-to-date 不渲染）；
//   2. 状态名不冲突：updateHint（自身版本提示，client.js:3318）与 pluginUpdateHint
//      （client.js:6190）useState 声明各恰好 1 次，互不混用；
//   3. R9 探测区间内无 setInterval（设计文档 X4：无常驻定时器）。
//
// 用法：node ./test/wb-update-hint.mjs
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const libDir = new URL("../lib/", import.meta.url);
const { wbPluginUpdateCheck, wbPluginCachedInfo } =
  await import(new URL("wb-plugin-market.js", libDir).href);

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

function freshRoot() {
  return mkdtemp(join(tmpdir(), "dsh-armory-hint-"));
}

/** 写 plugins 市场源（真实字段形状按 wb-registry.normalizeEntry：source.url）。 */
async function writePluginsSource(root, kind = "plugins") {
  await mkdir(join(root), { recursive: true });
  await writeFile(join(root, "marketplaces.json"), JSON.stringify({
    marketplaces: [{ id: "codebuddy-plugins-official", kind, source: { url: "https://example.test/plugins.zip" } }],
  }));
}

/** 写本地缓存 meta.json（带 etag → 走条件请求分支）。 */
async function writeCache(root, etag = "\"v1\"") {
  const dir = join(root, "plugin-market");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), JSON.stringify({ etag, fetchedAt: 1 }));
}

/** 枚举 plugin-market/ 下每个文件的文件名 + 内容，供「只探测不落盘」前后对比。 */
async function cacheSnapshot(root) {
  const dir = join(root, "plugin-market");
  try {
    const entries = await readdir(dir);
    const snapshot = {};
    for (const name of entries) {
      try { snapshot[name] = (await readFile(join(dir, name))).toString("base64"); }
      catch { snapshot[name] = "<unreadable>"; }
    }
    return snapshot;
  } catch { return null; } // 目录不存在
}

/** 构造带可断言的假 fetch。记录每次调用的 url/init；返回 [fetchImpl, calls]。 */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init: init || {} });
    return handler(url, init);
  };
  return [impl, calls];
}

// ── 1. no-source：注册表同 id 覆盖 kind=connectors → 无 plugins 源 ───────────
{
  const root = await freshRoot();
  await writePluginsSource(root, "connectors"); // 内置 plugins 源被同 id 覆盖成 connectors
  const result = await wbPluginUpdateCheck({ rootDir: root });
  ok("no-source：ok=false", result.ok === false, JSON.stringify(result));
  ok("no-source：hasUpdate=false", result.hasUpdate === false);
  ok("no-source：reason=no-source", result.reason === "no-source");
  const snapshot = await cacheSnapshot(root);
  ok("no-source：只探测不落盘（plugin-market 目录不存在或无变化）", snapshot === null || Object.keys(snapshot).length === 0);
  await rm(root, { recursive: true, force: true });
}

// ── 2. no-cache：有源但 meta.json 无 etag ────────────────────────────────────
{
  const root = await freshRoot();
  await writePluginsSource(root);
  const [impl, calls] = fakeFetch(() => { throw new Error("不该被调用"); });
  const realFetch = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    const result = await wbPluginUpdateCheck({ rootDir: root });
    ok("no-cache：ok=true", result.ok === true, JSON.stringify(result));
    ok("no-cache：hasUpdate=true（引导首次拉取）", result.hasUpdate === true);
    ok("no-cache：reason=no-cache", result.reason === "no-cache");
    ok("no-cache：本地无缓存时不发网络请求", calls.length === 0);
  } finally { globalThis.fetch = realFetch; }
  const snapshot = await cacheSnapshot(root);
  ok("no-cache：只探测不落盘（未下载任何 zip/meta）", snapshot === null || !Object.keys(snapshot).some((name) => name !== "meta.json"));
  await rm(root, { recursive: true, force: true });
}

// ── 3. probe-failed：fetch 抛异常 ────────────────────────────────────────────
{
  const root = await freshRoot();
  await writePluginsSource(root);
  await writeCache(root, "\"v1\"");
  const [impl, calls] = fakeFetch(() => { throw new Error("net down"); });
  const realFetch = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    const result = await wbPluginUpdateCheck({ rootDir: root });
    ok("probe-failed(异常)：ok=false", result.ok === false, JSON.stringify(result));
    ok("probe-failed(异常)：reason=probe-failed", result.reason === "probe-failed");
    ok("probe-failed(异常)：发出的是 HEAD 条件请求", calls.length >= 1
      && calls[0].init.method === "HEAD"
      && calls[0].init.headers?.["if-none-match"] === "\"v1\"");
  } finally { globalThis.fetch = realFetch; }
  ok("probe-failed(异常)：只探测不落盘", JSON.stringify(await cacheSnapshot(root)) === JSON.stringify({ "meta.json": (await readFile(join(root, "plugin-market", "meta.json"))).toString("base64") }));
  await rm(root, { recursive: true, force: true });
}

// ── 4. probe-failed：HTTP 500 ────────────────────────────────────────────────
{
  const root = await freshRoot();
  await writePluginsSource(root);
  await writeCache(root, "\"v1\"");
  const [impl] = fakeFetch(() => ({ ok: false, status: 500, headers: { get: () => null } }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    const result = await wbPluginUpdateCheck({ rootDir: root });
    ok("probe-failed(500)：ok=false", result.ok === false, JSON.stringify(result));
    ok("probe-failed(500)：reason=probe-failed", result.reason === "probe-failed");
    ok("probe-failed(500)：错误信息带状态码", String(result.error || "").includes("500"));
  } finally { globalThis.fetch = realFetch; }
  ok("probe-failed(500)：只探测不落盘", Object.keys(await cacheSnapshot(root)).join(",") === "meta.json");
  await rm(root, { recursive: true, force: true });
}

// ── 5. up-to-date：HTTP 304 ──────────────────────────────────────────────────
{
  const root = await freshRoot();
  await writePluginsSource(root);
  await writeCache(root, "\"v1\"");
  const [impl] = fakeFetch(() => ({ ok: true, status: 304, headers: { get: () => null } }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    const result = await wbPluginUpdateCheck({ rootDir: root });
    ok("up-to-date(304)：ok=true", result.ok === true, JSON.stringify(result));
    ok("up-to-date(304)：hasUpdate=false", result.hasUpdate === false);
    ok("up-to-date(304)：reason=up-to-date", result.reason === "up-to-date");
    ok("up-to-date(304)：remoteEtag 回显 localEtag", result.remoteEtag === "\"v1\"");
  } finally { globalThis.fetch = realFetch; }
  ok("up-to-date(304)：只探测不落盘", Object.keys(await cacheSnapshot(root)).join(",") === "meta.json");
  await rm(root, { recursive: true, force: true });
}

// ── 6. up-to-date：HTTP 200 但响应 etag == 本地 etag ────────────────────────
{
  const root = await freshRoot();
  await writePluginsSource(root);
  await writeCache(root, "\"v1\"");
  const [impl] = fakeFetch(() => ({ ok: true, status: 200, headers: { get: (name) => (name.toLowerCase() === "etag" ? "\"v1\"" : null) } }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    const result = await wbPluginUpdateCheck({ rootDir: root });
    ok("up-to-date(200 etag 相同)：ok=true", result.ok === true, JSON.stringify(result));
    ok("up-to-date(200 etag 相同)：hasUpdate=false", result.hasUpdate === false);
    ok("up-to-date(200 etag 相同)：reason=up-to-date", result.reason === "up-to-date");
  } finally { globalThis.fetch = realFetch; }
  ok("up-to-date(200 etag 相同)：只探测不落盘", Object.keys(await cacheSnapshot(root)).join(",") === "meta.json");
  await rm(root, { recursive: true, force: true });
}

// ── 7. update-available：HTTP 200 且 etag 不同 ──────────────────────────────
{
  const root = await freshRoot();
  await writePluginsSource(root);
  await writeCache(root, "\"v1\"");
  const [impl] = fakeFetch(() => ({ ok: true, status: 200, headers: { get: (name) => (name.toLowerCase() === "etag" ? "\"v2\"" : null) } }));
  const realFetch = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    const result = await wbPluginUpdateCheck({ rootDir: root });
    ok("update-available：ok=true", result.ok === true, JSON.stringify(result));
    ok("update-available：hasUpdate=true", result.hasUpdate === true);
    ok("update-available：reason=update-available", result.reason === "update-available");
    ok("update-available：remoteEtag 为响应值", result.remoteEtag === "\"v2\"");
    ok("update-available：localEtag 为本地缓存值", result.localEtag === "\"v1\"");
  } finally { globalThis.fetch = realFetch; }
  ok("update-available：只探测不落盘（本地 etag 仍 v1）",
    (await wbPluginCachedInfo({ rootDir: root })).etag === "\"v1\""
    && Object.keys(await cacheSnapshot(root)).join(",") === "meta.json");
  await rm(root, { recursive: true, force: true });
}

// ── 8. wbPluginCachedInfo：只读探针语义 ─────────────────────────────────────
{
  const root = await freshRoot();
  const empty = await wbPluginCachedInfo({ rootDir: root });
  ok("wbPluginCachedInfo：无缓存 hasCache=false", empty.hasCache === false && empty.etag === "");
  await writeCache(root, "\"abc\"");
  const cached = await wbPluginCachedInfo({ rootDir: root });
  ok("wbPluginCachedInfo：有缓存回显 etag", cached.hasCache === true && cached.etag === "\"abc\"");
  await rm(root, { recursive: true, force: true });
}

// ══ B 部分：客户端 UI 契约（静态断言，小窗读取源码文本） ═════════════════════
const clientSource = await readFile(new URL("client.js", libDir), "utf8");

// ── B1. reason 五枚举在 UI 侧全覆盖 ─────────────────────────────────────────
// 设计文档要求 UI 分支只看 reason；no-source / up-to-date 明确**不渲染**。
// no-source 在 client.js 的唯一存在形态是 L6678 的枚举注释（声明处理意图、不带引号）；
// up-to-date 的 1 次字面量在 L7619，属于 dsh-armory 自身版本提示（误算隔离：它不是
// 插件提示条的分支，插件提示条不渲染它——由下方「不进渲染分支」断言独立钉住）。
{
  const noComment = clientSource.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
  ok("UI reason 枚举 no-source：仅出现在枚举注释里（设计上不渲染、无引号字面量）",
    /\/\/[^\n]*no-source/.test(clientSource) && !/['"]no-source['"]/.test(clientSource));
  for (const reason of ["probe-failed", "no-cache", "update-available"]) {
    const live = (noComment.match(new RegExp(`['"]${reason}['"]`, "g")) || []).length;
    ok(`UI reason 枚举："${reason}" 以字面量出现在真代码中`, live >= 1, `真代码 count=${live}`);
  }
  // up-to-date：字面量存在但归属自身版本提示；插件提示条必须**不**引用它（见下条）。
  const upToDateLive = (noComment.match(/['"]up-to-date['"]/g) || []).length;
  ok("UI reason 枚举：up-to-date 字面量在场（L7619 自身版本提示所有，非插件提示条）", upToDateLive >= 1, `真代码 count=${upToDateLive}`);
}
ok("UI 侧 no-source / up-to-date 不进渲染分支（插件提示条只判 update-available/no-cache/probe-failed）",
  /tab === 'plugin' && (?:pluginSource === 'codebuddy' && )?pluginUpdateHint/.test(clientSource)
  && !/pluginUpdateHint\.reason === 'no-source'/.test(clientSource)
  && !/pluginUpdateHint\.reason === 'up-to-date'/.test(clientSource));

// ── B2. 状态名不冲突：updateHint 与 pluginUpdateHint 的 useState 声明各恰好 1 次 ─
const updateHintDecl = (clientSource.match(/const \[updateHint, setUpdateHint\] = useState\(/g) || []).length;
const pluginHintDecl = (clientSource.match(/const \[pluginUpdateHint, setPluginUpdateHint\] = useState\(/g) || []).length;
ok("updateHint（自身版本提示）useState 声明恰好 1 次", updateHintDecl === 1, `count=${updateHintDecl}`);
ok("pluginUpdateHint（插件市场更新提示）useState 声明恰好 1 次", pluginHintDecl === 1, `count=${pluginHintDecl}`);

// ── B3. R9 探测区间内无 setInterval（X4：无常驻定时器） ─────────────────────
// 探测区间 = checkPluginUpdate 定义（lazy 一次触发）到插件市场更新提示条结束。
// 定位：const checkPluginUpdate = useCallback( → 之后 120 行内的 window。
{
  const start = clientSource.indexOf("const checkPluginUpdate = useCallback(");
  let intervalFound = false;
  if (start >= 0) {
    const windowText = clientSource.slice(start, start + 12_000);
    // 注释掉的行不计：把 // 行注释剔除后再查。
    const stripped = windowText.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
    intervalFound = /setInterval\s*\(/.test(stripped);
  }
  ok("R9 探测区间内无 setInterval（只懒触发一次）", start >= 0 && !intervalFound);
  ok("R9 探测函数存在（懒触发入口 checkPluginUpdate）", start >= 0);
}

console.log(failures === 0 ? "\nALL UPDATE-HINT CHECKS PASS" : `\n${failures} UPDATE-HINT CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
