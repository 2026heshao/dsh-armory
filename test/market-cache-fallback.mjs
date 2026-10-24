// test/market-cache-fallback.mjs
//
// 护栏对象：专家目录（expert-market.loadManifest）与连接器 ZIP（wb-market.loadConnectorZip）
// 的缓存回落路径。2026-10-24 全量检查修掉的一组同源 bug——旧实现里：
//   ① 本地缓存损坏/缺失时回落下载**仍带旧 ETag**：上游内容没变就回 304 → download 返回 null
//      → 对 null 取 `.buffer` 抛 TypeError；且没有任何自愈路径（每次调用都同样崩，直到
//      手删 meta.json 或上游换内容）。连接器侧同理（24MB ZIP 被杀软隔离/清理即触发）。
//   ② 网络挂掉时把**已验证可用**的磁盘缓存一并丢弃（catch 里 zip = null）→ 整个市场/专家
//      目录离线不可用，与两处头注承诺的「网络挂了继续用旧缓存」相反。
//   ③ ETag 路径拿到的 200 响应**不做结构校验**就写盘：CDN/中间代理回一份"可解析但不是清单"
//      的 JSON 会把好缓存当场覆盖掉（专家侧旧实现），与全量下载路径的校验不一致。
//   ④ 清单/ZIP/meta 的写盘是非原子 writeFile：进程中途被杀留下截断文件，正是 ① 的诱因。
// 修复后的契约（本文件逐条钉住）：
//   - 只在磁盘缓存**有效**时才带 If-None-Match；磁盘坏/缺 → 无条件全量下载（不带 etag）。
//   - 304 = 磁盘缓存是权威副本，直接用它。
//   - 网络失败 / 响应结构无效 → 有磁盘缓存就回落，绝不把面板打空；真没有才抛错。
//   - 网络数据先过结构校验（清单 experts 数组 / ZipReader 构造）再落盘；落盘走唯一
//     临时名 + rename，中途被杀不留截断正文。
//   - projectExpert 必须透出清单给的 promptFile（wbExpertDetail 的首选人设路径；
//     旧实现把它丢了，plugin.json 拉不到时整条专家硬报「没有人设文件路径」）。
//
// 隔离纪律：DSH_ARMORY_MARKET_HOME 指到 mkdtemp 临时目录（wb-market / expert-market
// 的 cacheDir 都认它）+ DSH_ARMORY_HOME 指到另一临时目录（wb-registry 首读落盘用），
// globalThis.fetch 全程替身，零真实网络、绝不碰真实 ~/.dsh。每个场景用 `?case=N`
// 查询串重新 import 拿一份干净的模块级缓存状态（cachedManifest / cachedZip）。
// 只用 node: 内置模块。用法：node ./test/market-cache-fallback.mjs

import { mkdtemp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import zlib from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

let passed = 0;
let failed = 0;
function ok(cond, label, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail ? `：${detail}` : ""}`);
  }
}

// ── 最小 ZIP 构造（store 法；wb-zip 只读 central directory / local header）────────
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
function buildZip(files) {
  const crc32 = typeof zlib.crc32 === "function" ? zlib.crc32 : () => 0;
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBuf.length), u16(0), nameBuf, data,
    ]);
    parts.push(local);
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length),
      u16(nameBuf.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ]));
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...parts, cd, eocd]);
}

const VALID_MANIFEST = {
  version: "2026-10-24",
  categories: [{ id: "dev", name: { zh: "开发", en: "Dev" } }],
  experts: [
    {
      id: "e1", plugin: "senior-developer", expertType: "agent",
      displayName: { zh: "吴八哥", en: "Senior Dev" }, profession: { zh: "编程", en: "Coding" },
      description: { zh: "x", en: "x" }, categoryId: "dev",
      promptFile: "/plugins/senior-developer/agents/senior-developer.md",
    },
  ],
};
const VALID_INDEX = { connectors: [] };
const VALID_ZIP = buildZip([
  { name: ".codebuddy-connector/connectors.json", data: Buffer.from(JSON.stringify(VALID_INDEX)) },
]);

// ── fetch 替身与场景骨架 ─────────────────────────────────────────────────────
// 注意 arrayBuffer 必须回「尺寸恰好」的 ArrayBuffer：Buffer 会从池里分配，直接给
// buf.buffer 会把整段 8KB 池内存（含垃圾字节）都交给 lib 的 JSON.parse。
const respondOk = (body, etag = '"v2"') => async (url, init = {}) => {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
  const exact = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return {
    ok: true, status: 200,
    headers: new Map([["etag", etag]]),
    arrayBuffer: async () => exact,
    text: async () => buf.toString("utf8"),
  };
};
const respond304 = async () => ({
  ok: false, status: 304, headers: new Map(),
  arrayBuffer: async () => new ArrayBuffer(0), text: async () => "",
});
const respondBroken = async () => { throw new Error("ECONNREFUSED（替身）"); };
const ifNoneMatchOf = (init = {}) => (init.headers && init.headers["if-none-match"]) || undefined;

const marketRoots = [];
const realFetch = globalThis.fetch;
const realMarketHome = process.env.DSH_ARMORY_MARKET_HOME;
const realArmoryHome = process.env.DSH_ARMORY_HOME;
try {
  let caseNo = 0;
  const freshExpert = async () => import(`../lib/expert-market.js?case=${++caseNo}`);
  const freshWb = async () => import(`../lib/wb-market.js?case=${++caseNo}`);
  const tempRoot = async () => {
    const root = await mkdtemp(join(tmpdir(), "armory-market-cache-"));
    marketRoots.push(root);
    return root;
  };
  const writeAt = async (path, value) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, value);
  };
  const readText = async (path) => readFile(path, "utf8");
  const expertPaths = (root) => ({
    manifest: join(root, "experts", "expert_center.json"),
    meta: join(root, "experts", "meta.json"),
  });
  const zipPaths = (root) => ({
    zip: join(root, "connectors-config.zip"),
    meta: join(root, "meta.json"),
  });

  // ── ① 专家：磁盘清单损坏 + 有 etag + 上游对带 etag 的请求一律 304 ──────────
  // 旧行为在这里死循环（304 → null.buffer TypeError，每次调用都崩）；修复后回落下载
  // 不带 etag → 拿到 200 全量 → 成功落盘。
  {
    const root = await tempRoot();
    process.env.DSH_ARMORY_MARKET_HOME = root;
    const p = expertPaths(root);
    await writeAt(p.meta, JSON.stringify({ etag: '"v1"', fetchedAt: 1 }));
    await writeAt(p.manifest, "{broken json");
    let sawHeader;
    globalThis.fetch = async (url, init = {}) => {
      sawHeader = ifNoneMatchOf(init);
      return sawHeader ? respond304() : respondOk(VALID_MANIFEST, '"v2"')(url, init);
    };
    const mod = await freshExpert();
    const res = await mod.wbExpertCatalog();
    ok(res && res.total === 1 && res.experts[0]?.plugin === "senior-developer",
      "专家①磁盘损坏+304：全量重下成功，不再对 null 取 buffer 崩溃", JSON.stringify(res).slice(0, 120));
    ok(sawHeader === undefined, "专家①回落下载不带 If-None-Match（带了就进 304 死路）", String(sawHeader));
    ok((await readText(p.manifest)).includes("senior-developer"), "专家①新清单已落盘");
    ok(JSON.parse(await readText(p.meta)).etag === '"v2"', "专家①meta 的 etag 已刷新");
  }

  // ── ② 专家：磁盘完好 + 网络挂 → 回落磁盘缓存，绝不把面板打空 ────────────────
  {
    const root = await tempRoot();
    process.env.DSH_ARMORY_MARKET_HOME = root;
    const p = expertPaths(root);
    await writeAt(p.meta, JSON.stringify({ etag: '"v1"', fetchedAt: 1 }));
    await writeAt(p.manifest, JSON.stringify(VALID_MANIFEST));
    globalThis.fetch = respondBroken;
    const mod = await freshExpert();
    const res = await mod.wbExpertCatalog();
    ok(res && res.loadedFrom === "disk" && res.total === 1,
      "专家②断网：回落磁盘缓存（loadedFrom=disk）", JSON.stringify(res).slice(0, 120));
  }

  // ── ③ 专家：磁盘完好 + 304 → 磁盘即权威（既有行为，钉住不回退）──────────────
  {
    const root = await tempRoot();
    process.env.DSH_ARMORY_MARKET_HOME = root;
    const p = expertPaths(root);
    await writeAt(p.meta, JSON.stringify({ etag: '"v1"', fetchedAt: 1 }));
    await writeAt(p.manifest, JSON.stringify(VALID_MANIFEST));
    let sawHeader;
    globalThis.fetch = async (url, init = {}) => { sawHeader = ifNoneMatchOf(init); return respond304(); };
    const mod = await freshExpert();
    const res = await mod.wbExpertCatalog();
    ok(res && res.loadedFrom === "disk" && res.total === 1, "专家③304：磁盘缓存直接可用", JSON.stringify(res).slice(0, 80));
    ok(sawHeader === '"v1"', "专家③探测带了既有 etag", String(sawHeader));
  }

  // ── ④ 专家：200 但结构无效（"可解析但不是清单"）→ 不写盘、不接管缓存，回落磁盘 ──
  {
    const root = await tempRoot();
    process.env.DSH_ARMORY_MARKET_HOME = root;
    const p = expertPaths(root);
    await writeAt(p.meta, JSON.stringify({ etag: '"v1"', fetchedAt: 1 }));
    await writeAt(p.manifest, JSON.stringify(VALID_MANIFEST));
    globalThis.fetch = respondOk(JSON.stringify({ error: "proxy intercepted" }), '"bad"');
    const mod = await freshExpert();
    const res = await mod.wbExpertCatalog();
    ok(res && res.loadedFrom === "disk" && res.total === 1,
      "专家④坏结构响应：回落磁盘，不接管缓存", JSON.stringify(res).slice(0, 120));
    ok((await readText(p.manifest)).includes("senior-developer"), "专家④坏响应未覆盖磁盘清单");
    ok(JSON.parse(await readText(p.meta)).etag === '"v1"', "专家④坏响应未覆盖 meta 的 etag");
  }

  // ── ⑤ 专家：projectExpert 透出 promptFile（清单给的权威人设路径）────────────
  {
    const root = await tempRoot();
    process.env.DSH_ARMORY_MARKET_HOME = root;
    await writeAt(expertPaths(root).manifest, JSON.stringify(VALID_MANIFEST));
    globalThis.fetch = respondOk(VALID_MANIFEST, '"v3"'); // 无 etag：首次装载走全量
    const mod = await freshExpert();
    const res = await mod.wbExpertCatalog();
    ok(res?.experts?.[0]?.promptFile === "/plugins/senior-developer/agents/senior-developer.md",
      "专家⑤目录行带 promptFile（wbExpertDetail 的首选路径）", JSON.stringify(res?.experts?.[0]?.promptFile));
  }

  // ── ⑥ 连接器：磁盘 ZIP 损坏 + 有 etag + 上游对带 etag 的请求一律 304 ─────────
  {
    const root = await tempRoot();
    process.env.DSH_ARMORY_MARKET_HOME = root;
    process.env.DSH_ARMORY_HOME = await tempRoot(); // wb-registry 首读落盘，指到临时目录
    const p = zipPaths(root);
    await writeAt(p.meta, JSON.stringify({ etag: '"z1"', fetchedAt: 1 }));
    await writeAt(p.zip, Buffer.from("PK-corrupted-not-a-zip"));
    let sawHeader;
    globalThis.fetch = async (url, init = {}) => {
      sawHeader = ifNoneMatchOf(init);
      return sawHeader ? respond304() : respondOk(VALID_ZIP, '"z2"')(url, init);
    };
    const mod = await freshWb();
    const res = await mod.wbConnectorCatalog();
    ok(res && Array.isArray(res.connectors),
      "连接器⑥磁盘损坏+304：全量重下成功，不再对 null 取 buffer 崩溃", JSON.stringify(res).slice(0, 120));
    ok(sawHeader === undefined, "连接器⑥回落下载不带 If-None-Match", String(sawHeader));
  }

  // ── ⑦ 连接器：磁盘 ZIP 完好 + 网络挂 → 回落磁盘缓存（离线市场可用）───────────
  {
    const root = await tempRoot();
    process.env.DSH_ARMORY_MARKET_HOME = root;
    process.env.DSH_ARMORY_HOME = await tempRoot();
    const p = zipPaths(root);
    await writeAt(p.meta, JSON.stringify({ etag: '"z1"', fetchedAt: 1 }));
    await writeAt(p.zip, VALID_ZIP);
    globalThis.fetch = respondBroken;
    const mod = await freshWb();
    const res = await mod.wbConnectorCatalog();
    ok(res && Array.isArray(res.connectors) && res.loadedFrom === "disk",
      "连接器⑦断网：回落磁盘 ZIP（loadedFrom=disk）", JSON.stringify(res).slice(0, 120));
  }

  // ── ⑧ 原子写：写完目录里没有 .staging / .tmp 残留（唯一临时名 + rename 的收尾纪律）──
  {
    const root = await tempRoot();
    process.env.DSH_ARMORY_MARKET_HOME = root;
    process.env.DSH_ARMORY_HOME = await tempRoot();
    globalThis.fetch = respondOk(VALID_MANIFEST, '"v9"');
    const expertMod = await freshExpert();
    await expertMod.wbExpertCatalog();
    globalThis.fetch = respondOk(VALID_ZIP, '"z9"');
    const wbMod = await freshWb();
    await wbMod.wbConnectorCatalog();
    const residues = [];
    for (const dir of [root, join(root, "experts")]) {
      for (const name of await readdir(dir)) {
        if (name.endsWith(".staging") || name.endsWith(".tmp")) residues.push(name);
      }
    }
    ok(residues.length === 0, "⑧缓存落盘无 .staging/.tmp 残留", residues.join(","));
  }

  // ── 反向自测：坏清单 + "带 etag 就 304" 的死路响应 → 任何实现都必须**响亮地失败**，
  // 不许静默返回空目录冒充成功（这条钉失败面，①钉的是成功面）。
  {
    const root = await tempRoot();
    process.env.DSH_ARMORY_MARKET_HOME = root;
    await writeAt(expertPaths(root).meta, JSON.stringify({ etag: '"v1"', fetchedAt: 1 }));
    await writeAt(expertPaths(root).manifest, "{broken json");
    globalThis.fetch = async (url, init = {}) =>
      ifNoneMatchOf(init) ? respond304() : respondOk("{broken", '"bad"')(url, init);
    const mod = await freshExpert();
    const res = await mod.wbExpertCatalog().then(() => "no-throw", (error) => String(error?.message || error));
    ok(res !== "no-throw", "反向自测：死路响应必须以失败显形（不许静默空目录）", String(res).slice(0, 80));
  }
} finally {
  globalThis.fetch = realFetch;
  if (realMarketHome === undefined) delete process.env.DSH_ARMORY_MARKET_HOME;
  else process.env.DSH_ARMORY_MARKET_HOME = realMarketHome;
  if (realArmoryHome === undefined) delete process.env.DSH_ARMORY_HOME;
  else process.env.DSH_ARMORY_HOME = realArmoryHome;
  for (const root of marketRoots) rmSync(root, { recursive: true, force: true });
}

console.log(`\n共 ${passed + failed} 条断言：PASS ${passed} / FAIL ${failed}`);
process.exit(failed ? 1 : 0);
