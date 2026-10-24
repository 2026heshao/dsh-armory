// 自定义套件（Skill 看板）—— ~/.dsh/armory/suites.json 的读写层。
//
// 职责：把「一组相关 skill 的命名组合」持久化，供两处消费——
//   1. Skill 看板工具栏的「自定义套件」按钮 → 套件管理弹窗（增删改）；
//   2. 输入框召唤菜单的技能子菜单 → 选中一个套件即把成员的 `/name` 逐个插进草稿，
//      一次引用等于同时应用多个相关 skill（纯插件侧展开，宿主零改动）。
//
// 契约（与 UI 的分工，勿两头各写一套）：
//   - id 由**本层**分配：UI 新建的套件传 id: ''，保存后必须以返回值里的 id 为准，
//     不得拿旧副本再存一次（否则同一套件会分裂成两条）。
//   - members 是**有序**数组（拖拽排序即数组序），展开时按序拼 `/name`。
//   - 保存语义是**整集合覆盖**（UI 的「保存」一次提交右侧全部套件），不是增量 upsert；
//     原子性靠 staging + rename，所以不存在「写一半」的中间态。
//
// 失败模式分档（对齐 execution-safety「失败模式处置分档」）：
//   - 拒绝（抛错）：入参不是数组 / 条目不是对象 / 名称为空 / 成员为空 /
//     非空 id 重复 / 套件总数超上限。这些都是「写进去就是脏数据」的形态。
//   - 放行 + 截断：name / desc 超长、members 超上限、members 里的非字符串项——
//     截断与丢弃都发生在 normalize 里，返回值就是落盘值，UI 以返回值为准。
//   - 读取永不抛错：文件缺失 / JSON 损坏 / 结构不对 → 空集合（与 wb-registry、
//     wb-install-state 同一口径），坏文件不炸面板。
//
// 纯数据层：零网络、零宿主依赖。存储根目录可注入（options.rootDir / 环境变量
// DSH_ARMORY_HOME），测试用 mkdtemp 隔离，绝不碰真实 ~/.dsh。
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SUITES_VERSION = 1;

/** 套件名上限：召唤菜单一行 28px，名字过长会挤掉成员计数徽章。 */
export const SUITE_NAME_MAX = 40;
/** 说明上限：只用于弹窗与菜单 title 悬停，不做正文展示。 */
export const SUITE_DESC_MAX = 120;
/** 单套件成员上限：展开后是一整串 `/name`，再多草稿框也读不下去。 */
export const SUITE_MEMBERS_MAX = 40;
/** 套件总数上限：文件体积与菜单长度的双重保险丝。 */
export const SUITES_MAX = 100;

/** 存储根目录：显式 rootDir > 环境变量 > 真实 ~/.dsh/armory（与 wb-registry 同一解析序）。 */
function armoryRoot(options = {}) {
  return options.rootDir || process.env.DSH_ARMORY_HOME || join(homedir(), ".dsh", "armory");
}

/** 套件文件绝对路径（入参只能选根目录，文件名不可外部指定——避免路径穿越面）。 */
export function suitesPath(options = {}) {
  return join(armoryRoot(options), "suites.json");
}

function asString(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asTimestamp(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** 截断到上限（超长属「放行 + 截断」档，不抛错）。 */
function clampText(value, max) {
  const text = asString(value).trim();
  return text.length > max ? text.slice(0, max) : text;
}

/** 成员数组归一：只留非空字符串、按首次出现去重、截到上限（顺序即展开序）。 */
function normalizeMembers(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const members = [];
  for (const item of raw) {
    const name = typeof item === "string" ? item.trim() : "";
    if (!name || seen.has(name)) continue;
    seen.add(name);
    members.push(name);
    if (members.length >= SUITE_MEMBERS_MAX) break;
  }
  return members;
}

/**
 * 把任意原始对象规范成一条完整的 Suite：缺失字段防御性补全，畸形成员丢弃。
 * id 为空表示「新建」，由 saveSuites 分配；normalizeSuite 本身不造 id（保持纯函数）。
 */
export function normalizeSuite(raw) {
  return {
    id: asString(raw?.id).trim(),
    name: clampText(raw?.name, SUITE_NAME_MAX),
    desc: clampText(raw?.desc, SUITE_DESC_MAX),
    members: normalizeMembers(raw?.members),
    createdAt: asTimestamp(raw?.createdAt, 0),
    updatedAt: asTimestamp(raw?.updatedAt, 0),
  };
}

/** 默认 id 生成器：时间戳 36 进制 + 随机尾，够避免同毫秒连点撞车。 */
function defaultCreateId() {
  return `suite-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 从磁盘读原始文档；不存在/损坏一律返回 null（由调用方决定回落语义）。 */
async function readRawDoc(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null; // ENOENT / ENOTDIR / JSON 解析失败同途处理
  }
}

/** 拆出目录部分（路径既有 / 也有 \ 的 Windows 形态，不为 dirname 多引依赖）。 */
function dirnameOf(path) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

/** 唯一临时名 + rename 原子写（与 wb-registry.writeAtomic 同一模式）：rename 覆盖已存在
 *  文件（Windows 实测），固定 `.staging` 反而在并发保存时互相消费对方的临时文件。 */
async function writeAtomic(path, doc) {
  await mkdir(dirnameOf(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(doc, null, 2));
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** 读取时同样过一遍 normalize：手改坏的条目在读侧就被拉回合法形状。 */
function normalizeList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .map(normalizeSuite)
    .filter((suite) => suite.id && suite.name && suite.members.length);
}

/**
 * 读全部套件。文件缺失 / 损坏 / 结构不对 → { version, suites: [] }，永不抛错。
 * 读侧过滤掉「无 id / 无名 / 无成员」的残缺条目：它们展开后什么也插不进草稿，
 * 留在列表里只是噪声（写侧本来也拒绝这种形态，读侧过滤只兜手改坏的文件）。
 */
export async function readSuites(options = {}) {
  const raw = await readRawDoc(suitesPath(options));
  const version = raw && typeof raw.version === "number" ? raw.version : SUITES_VERSION;
  return { version, suites: normalizeList(raw?.suites) };
}

/**
 * 整集合覆盖保存（UI「保存」= 一次提交右侧全部套件）。
 *
 * 校验（拒绝档）：入参必须是数组；每条必须是对象；名称非空；成员非空；
 * 非空 id 不得重复；总数不超 SUITES_MAX。任一不过 → 抛错且不写盘（原文件保持不变）。
 * 补全：空 id 分配新 id（createId 可注入，测试用确定性实现）；缺 createdAt 补 now。
 * updatedAt 由调用方决定（传了就落，没传落 now）——同 payload 重放得到同结果，写侧幂等。
 *
 * 返回写入后的 { version, suites }：UI 必须用它刷新本地副本（新 id 只在这里出现）。
 */
export async function saveSuites(suites, options = {}) {
  if (!Array.isArray(suites)) throw new Error("套件集合必须是数组");
  if (suites.length > SUITES_MAX) throw new Error(`套件数量超过上限 ${SUITES_MAX} 个`);
  const createId = typeof options.createId === "function" ? options.createId : defaultCreateId;
  const now = Date.now();
  const seenIds = new Set();
  const list = suites.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`第 ${index + 1} 条套件不是对象`);
    }
    const suite = normalizeSuite(raw);
    if (!suite.name) throw new Error(`第 ${index + 1} 条套件缺少名称`);
    if (!suite.members.length) throw new Error(`套件「${suite.name}」没有成员`);
    const id = suite.id || String(createId(index) || "").trim();
    if (!id) throw new Error(`第 ${index + 1} 条套件无法分配 id`);
    if (seenIds.has(id)) throw new Error(`套件 id 重复：${id}`);
    seenIds.add(id);
    return {
      ...suite,
      id,
      createdAt: suite.createdAt || now,
      updatedAt: suite.updatedAt || now,
    };
  });
  const path = suitesPath(options);
  await writeAtomic(path, { version: SUITES_VERSION, suites: list });
  return { version: SUITES_VERSION, suites: list };
}
