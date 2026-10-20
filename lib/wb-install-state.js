// 本地安装状态 + 来源锁（R8）—— ~/.dsh/armory/install-state.json 的读写层。
//
// 职责（设计文档 docs/system_design.md 8.3 / 类图 InstallStateStore）：
//   - record(item)：按 kind+key 定位，已存在则覆盖并刷新 lastUpdated；
//     首次写入补 installedAt。connector 不记 filesDigest，plugin/skill 记关键文件摘要。
//   - forget(kind, key)：删除一条登记，不存在时为无害空操作。
//   - listInstalled(kind)：返回该 kind 全部条目（顺序 = 写入序），供面板做「已安装」
//     **全量本地筛选**（不受分页影响，与技能侧 skillOnlyInstalled 只筛当前页不同）。
//
// 三类安装（connector=profile、skill=目录、plugin=宿主 bundle）在各自收尾点调用 record，
// 把分散的安装事实收敛到这一个文件里——这就是「来源锁」：登记条目带 source
// {marketplace, url, kind}，面板据此区分「本插件装的」与「其它途径来的」。
//
// 纯数据层：零网络。存储根目录可注入（options.rootDir / 环境变量 DSH_ARMORY_HOME），
// 测试绝不碰真实 ~/.dsh。写盘与 lib/wb-registry.js 同用 staging + rename 原子替换。
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const INSTALL_STATE_VERSION = 1;

const KINDS = new Set(["connector", "skill", "plugin"]);

/** 存储根目录：显式 rootDir > 环境变量 > 真实 ~/.dsh/armory（与 wb-registry 同一解析序）。 */
function armoryRoot(options = {}) {
  return options.rootDir || process.env.DSH_ARMORY_HOME || join(homedir(), ".dsh", "armory");
}

/** 状态文件绝对路径。 */
export function statePath(options = {}) {
  return join(armoryRoot(options), "install-state.json");
}

function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asTimestamp(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * 把任意原始对象规范成一条完整的 InstallStateItem：
 * 缺失字段防御性补全，畸形来源对象折成空对象而不是抛错。
 */
export function normalizeItem(raw) {
  const source = raw && typeof raw.source === "object" && raw.source !== null ? raw.source : {};
  const filesDigest = raw && typeof raw.filesDigest === "object" && raw.filesDigest !== null && !Array.isArray(raw.filesDigest)
    ? raw.filesDigest
    : {};
  return {
    kind: KINDS.has(raw?.kind) ? raw.kind : "connector",
    key: asString(raw?.key).trim(),
    name: asString(raw?.name),
    scope: asString(raw?.scope, "managed"),
    installPath: asString(raw?.installPath),
    version: asString(raw?.version),
    dependencies: Array.isArray(raw?.dependencies) ? raw.dependencies.map((dep) => String(dep)) : [],
    source: {
      marketplace: asString(source.marketplace),
      url: asString(source.url),
      kind: asString(source.kind),
    },
    installedAt: asTimestamp(raw?.installedAt, 0),
    lastUpdated: asTimestamp(raw?.lastUpdated, 0),
    filesDigest,
  };
}

/** 从磁盘读原始文档；不存在/损坏一律返回 null。 */
async function readRawDoc(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** 拆出目录部分（路径既有 / 也有 \ 的 Windows 形态）。 */
function dirnameOf(path) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

/** staging + rename 原子写（与 wb-registry.writeAtomic 同一模式）。 */
async function writeAtomic(path, doc) {
  await mkdir(dirnameOf(path), { recursive: true });
  await writeFile(`${path}.staging`, JSON.stringify(doc, null, 2));
  await rm(path, { force: true });
  await rename(`${path}.staging`, path);
}

/** 读全部条目（合并投影：文件缺失/损坏 = 空状态）。永不抛错。 */
export async function readState(options = {}) {
  const raw = await readRawDoc(statePath(options));
  const items = Array.isArray(raw?.items)
    ? raw.items.filter((item) => item && typeof item === "object" && !Array.isArray(item)).map(normalizeItem)
    : [];
  const version = raw && typeof raw.version === "number" ? raw.version : INSTALL_STATE_VERSION;
  return { version, items };
}

/**
 * 登记一条安装：同 kind+key 覆盖（刷新 lastUpdated，保留首次的 installedAt），
 * 首次写入补 installedAt。connector 不落 filesDigest（连接器装进 profile，
 * 没有关键文件可记）；plugin/skill 原样保留传入的 filesDigest。
 */
export async function record(item, options = {}) {
  const normalized = normalizeItem(item);
  if (!normalized.key) throw new Error("安装状态条目缺少 key，无法登记");
  const path = statePath(options);
  const { items } = await readState(options);
  const now = Date.now();
  const index = items.findIndex((entry) => entry.kind === normalized.kind && entry.key === normalized.key);
  if (index >= 0) {
    const existing = items[index];
    items[index] = {
      ...normalized,
      installedAt: existing.installedAt || now,
      lastUpdated: now,
      filesDigest: normalized.kind === "connector" ? {} : (Object.keys(normalized.filesDigest).length ? normalized.filesDigest : existing.filesDigest),
    };
  } else {
    items.push({
      ...normalized,
      installedAt: now,
      lastUpdated: now,
      filesDigest: normalized.kind === "connector" ? {} : normalized.filesDigest,
    });
  }
  await writeAtomic(path, { version: INSTALL_STATE_VERSION, items });
}

/** 删除一条登记（kind+key 定位）。不存在时为无害空操作。 */
export async function forget(kind, key, options = {}) {
  const wantedKind = String(kind ?? "").trim();
  const wantedKey = String(key ?? "").trim();
  if (!wantedKind || !wantedKey) throw new Error("forget 需要 kind 与 key");
  const path = statePath(options);
  const { items } = await readState(options);
  const kept = items.filter((entry) => !(entry.kind === wantedKind && entry.key === wantedKey));
  if (kept.length === items.length) return; // 没删到东西：不写盘
  await writeAtomic(path, { version: INSTALL_STATE_VERSION, items: kept });
}

/** 该 kind 的全部已安装条目（供「已安装」全量筛选）。 */
export async function listInstalled(kind, options = {}) {
  const wanted = String(kind ?? "").trim();
  const { items } = await readState(options);
  return items.filter((entry) => entry.kind === wanted);
}
