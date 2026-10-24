// 多市场注册表（R4）—— ~/.dsh/armory/marketplaces.json 的读写层。
//
// 职责（对应设计 §8.3，类图 MarketRegistry）：
//   - 注册表文件不存在或损坏时，回落到**内置默认一条**：连接器源（与
//     lib/wb-market.js:27 的 CONNECTOR_ZIP_URL 保持同一现值，禁止在此发明第二处硬编码真相）；
//     首读时把默认项落盘。
//   - 合并投影：内置默认永远在场（文件内同 id 条目可覆盖其字段），用户自定义条目追加其后。
//   - 增删改一律 staging + rename 原子替换（沿用 wbSkillInstall 的 staging 模式）。
//
// 插件市场从 2.3.0 起只保留 DSH 社区源（awesome-dsh-plugins），CodeBuddy 官方 ZIP
// 插件源已整体移除；旧 marketplaces.json 里的 kind="plugins" 条目读侧直接丢弃，
// 写侧也顺手清掉，避免它们借 normalize 回落成一条假的连接器源。
//
// 纯数据层：不做任何网络请求，不依赖 Remote/UI。测试可通过 options.rootDir 或
// 环境变量 DSH_ARMORY_HOME 把存储根目录指到临时目录，绝不碰真实 ~/.dsh。
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// 与 lib/wb-market.js:27 现值一致（改动连接器源时两处必须同步，注册表化接入后此值
// 仅作为「内置默认项」的数据来源，不再被 wb-market 直接消费）。
const CONNECTOR_ZIP_URL = "https://static.workbuddy.cn/connectors-config-v2/connectors-config.zip";

export const REGISTRY_VERSION = 1;

/** 存储根目录：显式 rootDir > 环境变量 > 真实 ~/.dsh/armory。 */
function armoryRoot(options = {}) {
  return options.rootDir || process.env.DSH_ARMORY_HOME || join(homedir(), ".dsh", "armory");
}

/** 注册表文件绝对路径。 */
export function registryPath(options = {}) {
  return join(armoryRoot(options), "marketplaces.json");
}

/**
 * 内置默认市场条目（代码内声明，首读落盘）：
 *   connectors → 现有 connectors-config.zip（WorkBuddy 连接器市场分发地址）
 * 插件市场不在这里登记：它只有 DSH 社区一个源，由 lib/wb-awesome-market.js 直连。
 */
export function builtinMarketplaces() {
  return [
    {
      id: "workbuddy-connectors",
      kind: "connectors",
      manifestName: "workbuddy-connectors",
      type: "zip",
      source: { url: CONNECTOR_ZIP_URL, path: "" },
      manifestPath: ".codebuddy-connector/connectors.json",
      autoUpdate: false,
      isBuiltIn: true,
      description: "WorkBuddy 官方连接器市场（connectors-config.zip）",
      addedAt: 0,
      lastUpdated: 0,
    },
  ];
}

const KINDS = new Set(["connectors"]);
// 已下线的市场类型：读侧丢弃、写侧清除。绝不能让它回落到 connectors——
// 那会把一条 CodeBuddy 插件源伪装成连接器源。
const REMOVED_KINDS = new Set(["plugins"]);

/** 字符串字段防御读取：非字符串一律回落默认值。 */
function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

/** 布尔字段防御读取。 */
function asBool(value, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

/** 数字时间戳防御读取：非有限非负数一律回落 fallback。 */
function asTimestamp(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * 把任意原始对象规范成一条完整的 MarketplaceEntry：缺失字段防御性补全
 * （缺 addedAt/lastUpdated 补 0、缺 description 补空串等），畸形条目不炸调用方。
 */
export function normalizeEntry(raw, { isBuiltIn = false } = {}) {
  const source = raw && typeof raw.source === "object" && raw.source !== null ? raw.source : {};
  return {
    id: asString(raw?.id).trim(),
    kind: KINDS.has(raw?.kind) ? raw.kind : "connectors",
    manifestName: asString(raw?.manifestName, asString(raw?.id).trim()),
    type: raw?.type === "directory" ? "directory" : "zip",
    source: { url: asString(source.url), path: asString(source.path) },
    manifestPath: asString(raw?.manifestPath),
    autoUpdate: asBool(raw?.autoUpdate, false),
    isBuiltIn: asBool(raw?.isBuiltIn, isBuiltIn),
    description: asString(raw?.description),
    addedAt: asTimestamp(raw?.addedAt, 0),
    lastUpdated: asTimestamp(raw?.lastUpdated, 0),
  };
}

/** 从磁盘读原始文档；不存在/损坏一律返回 null（由调用方决定回落语义）。 */
async function readRawDoc(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null; // ENOENT / ENOTDIR / JSON 解析失败同途处理
  }
}

/** 唯一临时名 + rename 原子写（Windows 的 rename 覆盖已存在文件，无需先 rm）。固定
 * `<file>.staging` 在并发写时会互相踩踏——后写者会消费掉先写者的 staging，极端时序
 * 甚至把先写者刚提交的正本删掉，注册表条目就此丢失。 */
async function writeAtomic(path, doc) {
  await mkdir(armoryPathDirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(doc, null, 2));
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** 拆出目录部分（避免为 dirname 多引一个依赖，路径既有 / 也有 \ 的 Windows 形态）。 */
function armoryPathDirname(path) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

/**
 * 读注册表并返回合并投影：
 *   - 文件不存在 / 解析失败 / marketplaces 非数组 → 内置默认一条（并尽力落盘）；
 *   - 文件内与内置默认同 id 的条目**覆盖**默认项字段；
 *   - 其余文件条目按原顺序追加在默认项之后。
 * 返回 { version, marketplaces }，永不抛错。
 */
export async function readRegistry(options = {}) {
  const path = registryPath(options);
  const raw = await readRawDoc(path);
  const fileEntries = Array.isArray(raw?.marketplaces)
    ? raw.marketplaces.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && !REMOVED_KINDS.has(entry.kind))
    : null;

  if (fileEntries === null) {
    // 首读落盘：把内置默认写进文件，失败（只读盘等）不影响返回值。
    const defaults = builtinMarketplaces();
    try {
      await writeAtomic(path, { version: REGISTRY_VERSION, marketplaces: defaults });
    } catch {
      /* 落盘失败不致命：下次读仍回落内置默认 */
    }
    return { version: REGISTRY_VERSION, marketplaces: defaults };
  }

  const normalized = fileEntries.map((entry) => normalizeEntry(entry));
  const byId = new Map(normalized.map((entry) => [entry.id, entry]));
  const merged = builtinMarketplaces().map(
    (builtin) => (byId.has(builtin.id) ? byId.get(builtin.id) : builtin),
  );
  const builtinIds = new Set(builtinMarketplaces().map((entry) => entry.id));
  for (const entry of normalized) {
    if (!builtinIds.has(entry.id)) merged.push(entry);
  }
  const version = raw && typeof raw.version === "number" ? raw.version : REGISTRY_VERSION;
  return { version, marketplaces: merged };
}

/**
 * 新增或更新一条市场条目（按 id 定位）。新条目补 addedAt，任何写入都刷新 lastUpdated。
 * 用户 upsert 内置同 id 条目即形成覆盖记录（删掉后内置默认回归）。
 * 返回写入后的合并投影。
 */
export async function upsertMarketplace(entry, options = {}) {
  if (REMOVED_KINDS.has(entry?.kind)) {
    throw new Error("CodeBuddy 插件市场已移除，注册表不再接受 plugins 类型的市场源");
  }
  const normalized = normalizeEntry(entry);
  if (!normalized.id) throw new Error("市场条目缺少 id，无法登记");
  const path = registryPath(options);
  const raw = await readRawDoc(path);
  const list = Array.isArray(raw?.marketplaces)
    ? raw.marketplaces.filter((item) => item && typeof item === "object" && !Array.isArray(item) && !REMOVED_KINDS.has(item.kind))
    : [];
  const now = Date.now();
  const existingIndex = list.findIndex((item) => normalizeEntry(item).id === normalized.id);
  if (existingIndex >= 0) {
    const existing = normalizeEntry(list[existingIndex]);
    list[existingIndex] = {
      ...normalized,
      addedAt: existing.addedAt || now,
      lastUpdated: now,
    };
  } else {
    list.push({ ...normalized, addedAt: normalized.addedAt || now, lastUpdated: now });
  }
  await writeAtomic(path, { version: REGISTRY_VERSION, marketplaces: list });
  return readRegistry(options);
}

/**
 * 按 id 删除一条**文件内**条目。内置默认不受影响：删除同 id 的覆盖记录后，
 * 合并投影里内置默认回归。id 不存在时为无害空操作。
 * 返回写入后的合并投影。
 */
export async function removeMarketplace(id, options = {}) {
  const target = String(id ?? "").trim();
  if (!target) throw new Error("缺少要删除的市场 id");
  const path = registryPath(options);
  const raw = await readRawDoc(path);
  if (!Array.isArray(raw?.marketplaces)) {
    return readRegistry(options); // 文件本就没有用户条目，直接回落投影
  }
  const list = raw.marketplaces.filter(
    (item) => !(item && typeof item === "object" && (normalizeEntry(item).id === target || REMOVED_KINDS.has(item.kind))),
  );
  await writeAtomic(path, { version: REGISTRY_VERSION, marketplaces: list });
  return readRegistry(options);
}

/** 取某个 kind 的第一条市场源（合并投影序 = 内置默认优先）；没有则返回 null。 */
export async function sourceFor(kind, options = {}) {
  const wanted = String(kind ?? "").trim();
  const { marketplaces } = await readRegistry(options);
  return marketplaces.find((entry) => entry.kind === wanted) ?? null;
}
