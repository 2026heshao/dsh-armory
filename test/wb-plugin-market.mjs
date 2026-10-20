// T03/R5+R6 插件市场的守护套件：清单嵌套解析、plugin.json 提取、dependencies 防御、
// catalog/detail 投影。不联网：官方 zip 的形状用手工字节（store 方法 0，无压缩）在
// 内存里构造，再喂 ZipReader 与 lib/wb-plugin-market.js 的纯解析层。
// 网络层（loadPluginZip 的下载/ETag/304）不在此套件覆盖——它需要真实下载，
// 与连接器套件同一纪律：本地形状全真跑，网络路径交给源码审查 + 未来集成夹具。
import { ZipReader } from "../lib/wb-zip.js";
import { pluginNamesFromMarketplace, pluginJsonPath, projectPlugin, readPluginCatalog } from "../lib/wb-plugin-market.js";

let failed = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failed += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

// ── 手工 ZIP 构造（store 方法 0）────────────────────────────────────────
// 结构：每条目 [local header][文件名][内容]；结尾 [central dir × N][EOCD]。
// ZipReader 只用偏移/大小/方法，CRC 直接填 0 也合法（解析层不校验内容哈希）。
const dosTime = 0, dosDate = 0x2100; // 固定时间戳，保证字节确定性
function zipEntry(name, content) {
  const nameBytes = Buffer.from(name, "utf8");
  const data = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // signature
  local.writeUInt16LE(20, 4);         // version needed
  local.writeUInt16LE(0x0800, 6);     // flags: UTF-8 names
  local.writeUInt16LE(0, 8);          // method 0 = store
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(0, 14);         // crc32（解析层不校验，填 0）
  local.writeUInt32LE(data.length, 18);   // compressed
  local.writeUInt32LE(data.length, 22);   // uncompressed
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(0, 28);         // extra length
  return { local: Buffer.concat([local, nameBytes, data]), nameBytes, data };
}
function buildZip(entries) {
  const parts = [];
  const centrals = [];
  let offset = 0;
  for (const entry of entries) {
    parts.push(entry.local);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);  // version made by
    central.writeUInt16LE(20, 6);  // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);  // method store
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(0, 16);  // crc
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(entry.nameBytes.length, 28);
    central.writeUInt32LE(offset, 42); // local header offset
    centrals.push(Buffer.concat([central, entry.nameBytes]));
    offset += entry.local.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, eocd]);
}

// ── 构造一份与官方形状一致的 zip 样例 ──────────────────────────────────
const marketplaceJson = JSON.stringify({
  plugins: ["alpha", "beta", "ghost", { name: "gamma" }, 42, null],
});
const alphaJson = JSON.stringify({
  name: "alpha", description: "第一个插件", author: "codebuddy",
  repository: "https://github.com/codebuddy/alpha", homepage: "https://alpha.dev",
  license: "MIT", version: "1.2.0",
  dependencies: ["left-pad", { name: "chalk", version: "^5.0.0" }],
  lspServers: { tsserver: { command: "node", args: ["lsp.js"] } },
});
const betaJson = JSON.stringify({
  name: "beta", description: "无依赖无 lsp", author: "someone", version: "0.1.0",
});
const gammaJson = "不是 JSON {{{";
const zip = new ZipReader(buildZip([
  zipEntry(".codebuddy-plugin/marketplace.json", marketplaceJson),
  zipEntry("external_plugins/alpha/.codebuddy-plugin/plugin.json", alphaJson),
  zipEntry("external_plugins/beta/.codebuddy-plugin/plugin.json", betaJson),
  zipEntry("external_plugins/gamma/.codebuddy-plugin/plugin.json", gammaJson),
  // ghost：索引里有目录名但 zip 里没有 plugin.json（上游常见：清单先行、包未发布）
]));

// ── 清单索引解析 ────────────────────────────────────────────────────────
{
  const indexJson = JSON.parse(marketplaceJson);
  const names = pluginNamesFromMarketplace(indexJson);
  ok("清单：字符串/对象混合元素都收，畸形（数字/null）剔除", JSON.stringify(names) === JSON.stringify(["alpha", "beta", "ghost", "gamma"]));
  ok("清单：plugins 为对象时键即目录名", JSON.stringify(pluginNamesFromMarketplace({ plugins: { a: 1, b: 2 } })) === JSON.stringify(["a", "b"]));
  ok("清单：缺失/畸形 plugins → []", pluginNamesFromMarketplace({}).length === 0
    && pluginNamesFromMarketplace({ plugins: "bad" }).length === 0
    && pluginNamesFromMarketplace(null).length === 0);
}

// ── plugin.json 提取与投影 ─────────────────────────────────────────────
{
  const { plugins, skipped } = readPluginCatalog(zip);
  ok("目录：索引 6 元素归一 4 名字，投影成功 2（alpha/beta），ghost（缺包）+ gamma（坏清单）计入 skipped", plugins.length === 2 && skipped === 2, `skipped=${skipped}（ghost + gamma 坏清单）`);
  const alpha = plugins.find((p) => p.name === "alpha");
  ok("投影 alpha：name/description/author/repository/homepage/license/version 全提取",
    alpha.description === "第一个插件" && alpha.author === "codebuddy"
    && alpha.repository === "https://github.com/codebuddy/alpha" && alpha.homepage === "https://alpha.dev"
    && alpha.license === "MIT" && alpha.version === "1.2.0");
  ok("R6 dependencies：字符串→{name,''}，对象→{name,version}，全部保留", alpha.dependencies.length === 2
    && alpha.dependencies[0].name === "left-pad" && alpha.dependencies[0].version === ""
    && alpha.dependencies[1].name === "chalk" && alpha.dependencies[1].version === "^5.0.0");
  ok("X7 lspServers：透传为对象（仅展示语义）", alpha.lspServers && typeof alpha.lspServers === "object" && !!alpha.lspServers.tsserver);
  const beta = plugins.find((p) => p.name === "beta");
  ok("R6 缺 dependencies 字段 → []（缺 = 无依赖）", Array.isArray(beta.dependencies) && beta.dependencies.length === 0);
  ok("R6 缺 lspServers 字段 → null（不出 LSP 说明）", beta.lspServers === null);
  ok("gamma：清单损坏被跳过、不拖垮整个目录", !plugins.some((p) => p.name === "gamma"));
}

// ── projectPlugin 纯函数防御 ───────────────────────────────────────────
{
  ok("投影：pluginJson 为 null/字符串等畸形 → 全空投影不炸", (() => {
    const p = projectPlugin("fallback", null);
    return p.name === "fallback" && p.description === "" && Array.isArray(p.dependencies) && p.dependencies.length === 0 && p.lspServers === null;
  })());
  ok("投影：name 缺失时用入参目录名兜底", projectPlugin("dir-name", {}).name === "dir-name");
  ok("投影：dependencies 元素缺 name 被剔除", projectPlugin("x", { dependencies: [{ version: "1" }, { name: "ok", spec: "2" }] }).dependencies
    .length === 1 && projectPlugin("x", { dependencies: [{ version: "1" }, { name: "ok", spec: "2" }] }).dependencies[0].version === "2");
  ok("路径：pluginJsonPath 形状与实测一致", pluginJsonPath("alpha") === "external_plugins/alpha/.codebuddy-plugin/plugin.json");
  ok("ZipReader 大小写不敏感命中嵌套路径", zip.has(pluginJsonPath("alpha")) && zip.has(".CODEBUDDY-PLUGIN/MARKETPLACE.JSON"));
}

console.log(failed === 0 ? "WB-PLUGIN-MARKET PASS" : `${failed} CHECK(S) FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
