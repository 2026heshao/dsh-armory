// CodeBuddy 插件市场（T03/R5）—— sourceFor("plugins") 的 ZIP 数据源与目录投影。
//
// 数据链路（与连接器市场同一套形状，缓存目录不同）：
//   1. 源：lib/wb-registry.js sourceFor("plugins") —— 内置默认
//      codebuddy-plugins-official（https://download.codebuddy.cn/...zip），
//      用户注册表条目可覆盖；读不到源时抛错（不发明第二处硬编码）。
//   2. 缓存：~/.dsh/armory/plugin-market/ 下 plugin.zip + meta.json{etag,fetchedAt}，
//      ETag 命中就不重复下载（与 wb-market.js 的连接器缓存同构；目录挂在 armory
//      根下而不是 ~/.dsh/wb-market/，因为这是 armory 自己引入的市场）。
//   3. 解析（zip 内嵌套清单，实测形状）：
//      .codebuddy-plugin/marketplace.json —— 市场索引（plugins 数组，取插件目录名）
//      external_plugins/<name>/.codebuddy-plugin/plugin.json —— 每个插件的清单，
//      投影 {name,description,author,repository,homepage,license,version,dependencies,lspServers}。
//
// 纪律：安装动作不在这里（客户端直接走官方 pluginManager.installBundle，T04 的 R8
// 才接 wb-install-state 记账）；本文件只做「取数 + 投影」，零副作用除缓存写盘。
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ZipReader } from "./wb-zip.js";
import { sourceFor } from "./wb-registry.js";

const USER_AGENT = "@2026heshao/dsh-armory (+https://github.com/2026heshao/dsh-armory)";
const MAX_ZIP_BYTES = 64 * 1024 * 1024;

/** 缓存根目录：~/.dsh/armory/plugin-market（测试可用 options.rootDir 覆盖）。 */
function pluginMarketDir(options = {}) {
  return join(options.rootDir || process.env.DSH_ARMORY_HOME || join(homedir(), ".dsh", "armory"), "plugin-market");
}
function zipPathOf(options) {
  return join(pluginMarketDir(options), "plugin.zip");
}
function metaPathOf(options) {
  return join(pluginMarketDir(options), "meta.json");
}

async function readJsonAt(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** 模块级缓存：一次进程内只解析一次 zip（与 wb-market cachedZip 同构）。 */
let cachedPluginZip = null;

async function downloadPluginZip(sourceUrl, etag) {
  const response = await fetch(sourceUrl, {
    headers: { "user-agent": USER_AGENT, ...(etag ? { "if-none-match": etag } : {}) },
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status === 304 && etag) return null;
  if (!response.ok) throw new Error(`插件市场下载失败：HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_ZIP_BYTES) throw new Error(`插件市场包超过 ${Math.round(MAX_ZIP_BYTES / 1024 / 1024)}MB 上限，疑似异常响应`);
  return { buffer, etag: response.headers.get("etag") || "" };
}

/** 下载（或复用磁盘缓存）并解析插件市场 zip。返回 { zip, loadedFrom }。 */
async function loadPluginZip(options = {}) {
  if (cachedPluginZip) return cachedPluginZip;
  const source = await sourceFor("plugins", options);
  const sourceUrl = source?.source?.url;
  if (typeof sourceUrl !== "string" || !sourceUrl) throw new Error("注册表里没有可用的 plugins 市场源");
  const dir = pluginMarketDir(options);
  await mkdir(dir, { recursive: true });
  const meta = (await readJsonAt(metaPathOf(options))) || {};
  const writeThrough = async (fresh) => {
    await writeFile(zipPathOf(options), fresh.buffer);
    await writeFile(metaPathOf(options), JSON.stringify({ etag: fresh.etag, fetchedAt: Date.now() }));
  };
  let zip = null;
  if (meta.etag) {
    try {
      const local = await readFile(zipPathOf(options));
      zip = new ZipReader(local);
      const fresh = await downloadPluginZip(sourceUrl, meta.etag);
      if (fresh === null) {
        cachedPluginZip = { zip, loadedFrom: "disk" };
        return cachedPluginZip;
      }
      zip = new ZipReader(fresh.buffer);
      await writeThrough(fresh);
      cachedPluginZip = { zip, loadedFrom: "network" };
      return cachedPluginZip;
    } catch {
      zip = null; // 磁盘缓存损坏 → 走完整重下
    }
  }
  const fresh = await downloadPluginZip(sourceUrl, "");
  zip = new ZipReader(fresh.buffer);
  await writeThrough(fresh);
  cachedPluginZip = { zip, loadedFrom: "network" };
  return cachedPluginZip;
}

// ── 清单解析（嵌套投影）──────────────────────────────────────────────────

/** 字符串字段防御读取。 */
function asString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

/**
 * marketplace.json → 插件目录名列表。实测形状 { plugins: ["name-a", ...] }；
 * 兼容 { plugins: [{ name }] } 与 { plugins: { ... } }（对象键即目录名）两种变体。
 * 畸形一律返回 []，不抛错。
 */
export function pluginNamesFromMarketplace(indexJson) {
  const raw = indexJson?.plugins;
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (typeof item === "string" ? item : asString(item?.name)))
      .filter(Boolean);
  }
  if (raw && typeof raw === "object") return Object.keys(raw).filter(Boolean);
  return [];
}

/** 去掉末尾斜杠并统一为 / 分隔（listByPrefix 是小写前缀匹配，路径形态无关紧要）。 */
/** zip 内插件清单的标准嵌套路径（导出给测试对形状做锚定）。 */
export function pluginJsonPath(name) {
  return `external_plugins/${name}/.codebuddy-plugin/plugin.json`;
}

/**
 * plugin.json → 面板投影。防御性提取：全部字段缺失不炸；dependencies 缺失 = []
 * （R6：实测清单无该字段，出现时展示、绝不自动安装）；lspServers 仅透传展示（X7）。
 */
export function projectPlugin(name, pluginJson) {
  const raw = pluginJson && typeof pluginJson === "object" ? pluginJson : {};
  const deps = Array.isArray(raw.dependencies)
    ? raw.dependencies
        .map((dep) => (typeof dep === "string"
          ? { name: dep.trim(), version: "" }
          : { name: asString(dep?.name), version: asString(dep?.version || dep?.spec || "") }))
        .filter((dep) => dep.name)
    : [];
  return {
    name: asString(raw.name) || asString(name),
    description: asString(raw.description),
    author: asString(raw.author),
    repository: asString(raw.repository),
    homepage: asString(raw.homepage),
    license: asString(raw.license),
    version: asString(raw.version),
    dependencies: deps,
    lspServers: raw.lspServers && typeof raw.lspServers === "object" ? raw.lspServers : null,
  };
}

/**
 * 从已解析的 ZipReader 枚举全部插件投影。先读市场索引拿目录名，再逐条读
 * external_plugins/<name>/.codebuddy-plugin/plugin.json（缺清单的目录跳过并计数）。
 */
export function readPluginCatalog(zip) {
  const marketManifestName = ".codebuddy-plugin/marketplace.json";
  if (!zip.has(marketManifestName)) {
    return { plugins: [], skipped: 0 };
  }
  let indexJson = null;
  try {
    indexJson = JSON.parse(zip.extract(marketManifestName).toString("utf8"));
  } catch {
    return { plugins: [], skipped: 0 };
  }
  const names = pluginNamesFromMarketplace(indexJson);
  const plugins = [];
  let skipped = 0;
  for (const name of names) {
    const manifestPath = pluginJsonPath(name);
    if (!zip.has(manifestPath)) {
      skipped += 1;
      continue;
    }
    try {
      const pluginJson = JSON.parse(zip.extract(manifestPath).toString("utf8"));
      plugins.push(projectPlugin(name, pluginJson));
    } catch {
      skipped += 1; // 单个插件清单损坏不拖垮整个目录
    }
  }
  return { plugins, skipped };
}

/**
 * 目录投影：catalog 返回 {ok, total, loadedFrom, plugins, skipped}。
 * 投影只保留列表需要的字段（详情从 detail 再取全量），保持响应轻。
 */
export async function wbPluginCatalog(options = {}) {
  const { zip, loadedFrom } = await loadPluginZip(options);
  const { plugins, skipped } = readPluginCatalog(zip);
  return {
    ok: true,
    loadedFrom,
    total: plugins.length,
    skipped,
    plugins: plugins.map((plugin) => ({
      name: plugin.name,
      description: plugin.description,
      author: plugin.author,
      repository: plugin.repository,
      version: plugin.version,
      license: plugin.license,
      dependencies: plugin.dependencies,
    })),
  };
}

/**
 * 单插件详情：全量投影（repository/homepage/lspServers 只在详情透出）。
 * name 未给或 zip 里没有 → ok:false（不抛错，客户端按「不可用」渲染）。
 */
export async function wbPluginDetail(name, options = {}) {
  const wanted = String(name ?? "").trim();
  if (!wanted) return { ok: false, error: "缺少插件名" };
  const { zip, loadedFrom } = await loadPluginZip(options);
  const manifestPath = pluginJsonPath(wanted);
  if (!zip.has(manifestPath)) return { ok: false, error: `zip 里没有插件 ${wanted}` };
  try {
    const pluginJson = JSON.parse(zip.extract(manifestPath).toString("utf8"));
    return { ok: true, loadedFrom, plugin: projectPlugin(wanted, pluginJson) };
  } catch (error) {
    return { ok: false, error: `插件清单解析失败：${error.message}` };
  }
}

/** 供测试与未来 R8（T04）检查缓存是否在场；只读，不联网。 */
export async function wbPluginCachedInfo(options = {}) {
  const meta = (await readJsonAt(metaPathOf(options))) || {};
  return { hasCache: Boolean(meta.etag), etag: meta.etag || "", fetchedAt: meta.fetchedAt || 0 };
}

// writeAtomic 同款 staging+rename（本文件缓存写用直写即可，这里导出给测试复用形态）。
export async function writeCacheStaging(path, data) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(`${path}.staging`, data);
  await rm(path, { force: true });
  await rename(`${path}.staging`, path);
}

/**
 * R9（T05）：插件市场更新探测 —— 只做条件请求，**绝不落盘**。
 *
 * 判定口径（设计文档）：ETag 与上次落盘的 meta.json 不一致即有更新；
 * HTTP 304 = 无更新，HTTP 200 = 有更新。HEAD 不传包体做轻量探测；
 * 服务端对 HEAD 返回 405/501 时降级为 GET，并立即 cancel() 丢弃响应体，
 * 不把 zip 读进内存。纯探测：不写 zip、不写 meta.json、不更新内存缓存。
 */
export async function wbPluginUpdateCheck(options = {}) {
  try {
    const source = await sourceFor("plugins", options);
    const sourceUrl = source?.source?.url;
    const meta = (await readJsonAt(metaPathOf(options))) || {};
    const localEtag = meta.etag || "";
    if (typeof sourceUrl !== "string" || !sourceUrl) {
      // 市场源检查必须先于 no-cache 分支：市场没配置时绝不能提示「有新版本」。
      return { ok: false, hasUpdate: false, reason: "no-source", localEtag, remoteEtag: "", checkedAt: Date.now(), error: "注册表里没有可用的 plugins 市场源" };
    }
    if (!localEtag) {
      // 本地没缓存过 → 无法比较，视为有更新，引导用户首次加载（纯探测仍不下载）。
      return { ok: true, hasUpdate: true, reason: "no-cache", localEtag: "", remoteEtag: "", checkedAt: Date.now() };
    }
    const headers = { "user-agent": USER_AGENT, "if-none-match": localEtag };
    let response;
    try {
      response = await fetch(sourceUrl, { method: "HEAD", headers, signal: AbortSignal.timeout(30_000) });
      if (response.status === 405 || response.status === 501) {
        // HEAD 不被支持 → 降级 GET，立刻 cancel() 丢弃响应体，不读进内存。
        response.body?.cancel?.();
        response = await fetch(sourceUrl, { method: "GET", headers, signal: AbortSignal.timeout(30_000) });
        response.body?.cancel?.();
      }
    } catch (error) {
      return { ok: false, hasUpdate: false, reason: "probe-failed", localEtag, remoteEtag: "", checkedAt: Date.now(), error: `更新探测失败：${error.message}` };
    }
    if (response.status === 304) {
      // 304：ETag 命中，服务端不回显 ETag；回显 localEtag 便于客户端展示。
      return { ok: true, hasUpdate: false, reason: "up-to-date", localEtag, remoteEtag: localEtag, checkedAt: Date.now() };
    }
    if (response.ok) {
      const remoteEtag = response.headers.get("etag") || "";
      const hasUpdate = remoteEtag !== localEtag;
      return { ok: true, hasUpdate, reason: hasUpdate ? "update-available" : "up-to-date", localEtag, remoteEtag, checkedAt: Date.now() };
    }
    return { ok: false, hasUpdate: false, reason: "probe-failed", localEtag, remoteEtag: "", checkedAt: Date.now(), error: `插件市场更新探测失败：HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, hasUpdate: false, reason: "probe-failed", localEtag: "", remoteEtag: "", checkedAt: Date.now(), error: `更新探测异常：${error.message}` };
  }
}
