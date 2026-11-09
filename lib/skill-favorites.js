// 技能收藏（Skill 看板 + 召唤菜单）—— ~/.dsh/armory/skill-favorites.json 的读写层。
//
// 职责：把「常用技能」持久化成一份按 name 唯一的轻量清单，供两处消费——
//   1. Skill 看板的网格卡片 / 列表行 / 详情星标；
//   2. 输入框召唤菜单技能子菜单的「收藏」三级。
//
// 契约（与 UI 的分工，勿两头各写一套）：
//   - name 是唯一键：全局与项目作用域共用一份收藏，同名只留一条；
//   - favoritedAt 是排序真值：新收藏置顶，重复收藏只更新时间；
//   - 总数上限 20，超出淘汰 favoritedAt 最旧的一条（返回值里带 evicted 名字）；
//   - name / description 超长属「放行 + 截断」档，截断发生在 normalize 里；
//   - 读取永不抛错：文件缺失 / JSON 损坏 / 结构不对 → 空集合（与 suites-registry、
//     wb-registry 同一口径），坏文件不炸面板；
//   - 写入失败抛错：UI 必须回滚乐观更新并给一行可见提示，不能假装成功。
//
// 纯数据层：零网络、零宿主依赖。存储根目录可注入（options.rootDir / 环境变量
// DSH_ARMORY_HOME），测试用 mkdtemp 隔离，绝不碰真实 ~/.dsh。
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SKILL_FAVORITES_VERSION = 1;

/** 技能名上限：菜单一行 28px，名字过长会挤掉描述与星标。 */
export const SKILL_FAVORITE_NAME_MAX = 120;
/** 说明上限：只用于三级菜单的 48 字副标题与详情 title，不做正文展示。 */
export const SKILL_FAVORITE_DESC_MAX = 200;
/** 收藏总数上限：文件体积与三级菜单长度的双重保险丝。 */
export const SKILL_FAVORITES_MAX = 20;

/** 存储根目录：显式 rootDir > 环境变量 > 真实 ~/.dsh/armory（与 suites-registry 同一解析序）。 */
function armoryRoot(options = {}) {
  return options.rootDir || process.env.DSH_ARMORY_HOME || join(homedir(), ".dsh", "armory");
}

/** 收藏文件绝对路径（入参只能选根目录，文件名不可外部指定——避免路径穿越面）。 */
export function skillFavoritesPath(options = {}) {
  return join(armoryRoot(options), "skill-favorites.json");
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

/** 把任意原始条目规范成 { name, description, favoritedAt }；无名条目丢弃。 */
function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const name = clampText(raw.name, SKILL_FAVORITE_NAME_MAX);
  if (!name) return null;
  return {
    name,
    description: clampText(raw.description, SKILL_FAVORITE_DESC_MAX),
    favoritedAt: asTimestamp(raw.favoritedAt, 0),
  };
}

/**
 * 读侧归一：同名只留 favoritedAt 更大的一条，按时间倒序，截到上限。
 * 手改坏的文件最多让某条看起来「旧一点」，不会把面板带崩。
 */
function normalizeList(raw) {
  if (!Array.isArray(raw)) return [];
  const byName = new Map();
  for (const item of raw) {
    const row = normalizeEntry(item);
    if (!row) continue;
    const prev = byName.get(row.name);
    if (!prev || row.favoritedAt >= prev.favoritedAt) byName.set(row.name, row);
  }
  return [...byName.values()]
    .sort((a, b) => b.favoritedAt - a.favoritedAt)
    .slice(0, SKILL_FAVORITES_MAX);
}

/** 从磁盘读原始文档；不存在/损坏一律返回 null（由调用方决定回落语义）。 */
async function readRawDoc(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null; // ENOENT / ENOTDIR / EISDIR / JSON 解析失败同途处理
  }
}

/** 拆出目录部分（路径既有 / 也有 \ 的 Windows 形态，不为 dirname 多引依赖）。 */
function dirnameOf(path) {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : path;
}

/** 唯一临时名 + rename 原子写（与 suites-registry.writeAtomic 同一模式）：rename 覆盖已存在
 *  文件（Windows 实测），固定 `.staging` 反而在并发保存时互相消费对方的临时文件。 */
async function writeAtomic(path, doc) {
  await mkdir(dirnameOf(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(doc, null, 2));
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * 读全部收藏。文件缺失 / 损坏 / 结构不对 → { version, skills: [] }，永不抛错。
 * 读侧也过 normalize：手改坏的名字 / 描述 / 时间戳在读侧就被拉回合法形状。
 */
export async function readSkillFavorites(options = {}) {
  const raw = await readRawDoc(skillFavoritesPath(options));
  const version = raw && typeof raw.version === "number" ? raw.version : SKILL_FAVORITES_VERSION;
  return { version, skills: normalizeList(raw?.skills) };
}

/**
 * 收藏 / 取消收藏一条技能。
 *
 * 入参：{ name, favorite, description? }。favorite 必须是布尔值，name 去空格后不能为空；
 * 不合法直接抛错（写进去就是脏数据）。description 省略时保留已有描述，新增时为空串。
 *
 * 返回：{ version, skills, favorite, evicted }。skills 是落盘后的完整清单（已排序、已截断），
 * UI 必须用它刷新本地副本——上限淘汰与新顺序只在这里出现。evicted 是本次被淘汰的最旧名字。
 */
export async function setSkillFavorite(input = {}, options = {}) {
  const name = clampText(input && input.name, SKILL_FAVORITE_NAME_MAX);
  if (!name) throw new Error("缺少 skill 名称");
  if (typeof (input && input.favorite) !== "boolean") throw new Error("favorite 必须是布尔值");
  const now = typeof options.now === "number" && Number.isFinite(options.now) && options.now >= 0
    ? options.now
    : Date.now();

  const current = await readSkillFavorites(options);
  const existing = current.skills.find((row) => row.name === name) || null;
  const rest = current.skills.filter((row) => row.name !== name);
  let skills;
  let evicted = null;

  if (input.favorite) {
    const description = input.description === undefined || input.description === null
      ? (existing ? existing.description : "")
      : clampText(input.description, SKILL_FAVORITE_DESC_MAX);
    skills = [{ name, description, favoritedAt: now }, ...rest];
    if (skills.length > SKILL_FAVORITES_MAX) {
      const dropped = skills.slice(SKILL_FAVORITES_MAX);
      evicted = dropped.length ? dropped[dropped.length - 1].name : null;
      skills = skills.slice(0, SKILL_FAVORITES_MAX);
    }
  } else {
    skills = rest;
  }

  await writeAtomic(skillFavoritesPath(options), { version: SKILL_FAVORITES_VERSION, skills });
  return { version: SKILL_FAVORITES_VERSION, skills, favorite: input.favorite, evicted };
}
