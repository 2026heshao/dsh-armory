// 技能清单（SKILL.md frontmatter）名字归一（issue #22 的唯一落盘点）。
//
// 背景：SkillHub 上相当一部分技能包的 frontmatter name 是人读名（中文 / 大写 / 空格 /
// 下划线），而宿主 @deepseek-ai/dsh-skill 只接受 kebab-case 的
// /^[a-z0-9]+(?:-[a-z0-9]+)*$/；parseSkillFile 遇到非法名只打一条 logger 警告就整条丢弃。
// 市场安装又是原字节落盘 → 面板亮着「已安装」，模型目录和 /菜单永远看不到（哑包）。
// 2026-11-15 抽样 60 个市场技能：7 个名字非法 + 2 个连 frontmatter 都没有，约 15%。
//
// 本模块只做一件纯事：把 SKILL.md 的 name 改成宿主可接受的 slug，其余字节不动；
// 改不了就抛带 code 的错，由安装侧转成可操作的失败（绝不「尽力而为」地写）。
// 手术规则与 lib/skill-disable.js 同一套定位方式（首行 ---、逐行找闭行、流式块拒绝），
// 但刻意不共享代码：skill-disable 是已上线模块，十几行定位逻辑换它零风险不值得。
//
// 安全闸门（任一不过即抛错）：
//   1. 首行必须是 `---`、存在闭合 `---` 行（与宿主 parseFrontmatter 同规则）；
//   2. frontmatter 必须是能解析成键值对的 YAML，且 name / description 非空；
//   3. 流式（整块 JSON）与 name 写成 `>` / `|` 多行块的形态拒改——往这些形态里做行级
//      手术会写出非法 YAML，等于把一份宿主本来能读的文件改坏；
//   4. 改写后的块必须仍能解析、name 恰为目标值，否则放弃写盘。
//
// 纯数据层：零网络、零宿主服务依赖；skillsRoot / stagingDir 由调用方注入，测试用 mkdtemp 隔离。
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** 宿主的技能名语法（与 @deepseek-ai/dsh-skill 的 SKILL_NAME 逐字一致）。 */
export const HOST_SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 归一失败的错误码：安装侧据此给可操作文案，测试据此断言「拒的是什么」。 */
export class SkillManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SkillManifestError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SkillManifestError(code, message);
}

/**
 * 把任意字符串归一成宿主可接受的技能名。
 * 规则：小写 → 非 [a-z0-9] 的连续片段折叠为单个 `-` → 去首尾 `-` → 截断后再次去尾 `-`。
 * 全非法（例如整段中文）时返回空串，由调用方决定兜底——不在这里编名字。
 * 注意：不能复用 lib/wb-market.js 的 skillTargetName（它允许下划线，宿主不允许）。
 */
export function hostSafeName(value, maxLength = 48) {
  const collapsed = String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return collapsed.slice(0, maxLength).replace(/-+$/g, "");
}

function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 定位 frontmatter 块，规则与宿主 parseFrontmatter 完全一致：
 * 首行去掉 \r 后必须恰为 `---`；闭行是随后第一个同为 `---` 的整行。
 * 返回 openEnd（开行之后的位置）/ closeStart（闭行行首）/ block（块正文）。
 */
function locateFrontmatter(text) {
  const firstBreak = text.indexOf("\n");
  if (firstBreak < 0) return null;
  if (text.slice(0, firstBreak).replace(/\r$/, "") !== "---") return null;
  let lineStart = firstBreak + 1;
  while (lineStart <= text.length) {
    const nextBreak = text.indexOf("\n", lineStart);
    const lineEnd = nextBreak < 0 ? text.length : nextBreak;
    if (text.slice(lineStart, lineEnd).replace(/\r$/, "") === "---") {
      return { openEnd: firstBreak + 1, closeStart: lineStart, block: text.slice(firstBreak + 1, lineStart) };
    }
    if (nextBreak < 0) return null;
    lineStart = nextBreak + 1;
  }
  return null;
}

function firstContentLine(block) {
  return block
    .split("\n")
    .map((line) => line.replace(/\r$/, "").trim())
    .find((line) => line.length > 0);
}

function parseBlock(block) {
  let data;
  try {
    data = parseYaml(block);
  } catch (error) {
    fail("manifest-invalid-yaml", `SKILL.md 的 frontmatter 不是合法 YAML（${error?.message ?? error}）`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    fail("manifest-not-mapping", "SKILL.md 的 frontmatter 不是键值对");
  }
  return data;
}

/**
 * 只读体检：宿主解析器会怎么判断这份清单。不抛错，失败以 code 表达。
 * 用途：装后校验、撞名扫描、测试断言。
 * @param {string} text SKILL.md 原文
 * @returns {{ ok: true, name: string, description: string, displayName: string, slug: string }
 *   | { ok: false, code: string }}
 */
export function inspectSkillManifest(text) {
  try {
    const located = locateFrontmatter(stripBom(String(text ?? "")));
    if (!located) return { ok: false, code: "manifest-no-frontmatter" };
    const first = firstContentLine(located.block);
    if (first && /^[{[]/.test(first)) return { ok: false, code: "manifest-flow-style" };
    const data = parseBlock(located.block);
    const name = typeof data.name === "string" ? data.name.trim() : "";
    if (!name) return { ok: false, code: "manifest-missing-name" };
    const description = typeof data.description === "string" ? data.description.trim() : "";
    if (!description) return { ok: false, code: "manifest-missing-description" };
    return {
      ok: true,
      name,
      description,
      displayName: typeof data.displayName === "string" ? data.displayName : "",
      slug: typeof data.slug === "string" ? data.slug : "",
    };
  } catch (error) {
    return { ok: false, code: typeof error?.code === "string" ? error.code : "manifest-invalid-yaml" };
  }
}

const NAME_LINE_RE = /^name[ \t]*:/;
const DISPLAY_LINE_RE = /^displayName[ \t]*:/;

/**
 * 在 frontmatter 块内把 name 行替换为一行双引号包裹的目标名（重复 key 统一收敛为一行），
 * 并在缺 displayName 时补回原名。其余行、键序、行尾风格原样保留。
 */
function rewriteNameBlock(block, target, originalName) {
  const eol = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const out = [];
  let replaced = false;
  let hasDisplay = false;
  for (const line of lines) {
    if (DISPLAY_LINE_RE.test(line)) hasDisplay = true;
    if (!NAME_LINE_RE.test(line)) {
      out.push(line);
      continue;
    }
    const value = line.slice(line.indexOf(":") + 1).trim();
    if (value === "" || value.startsWith("|") || value.startsWith(">")) {
      fail("manifest-multiline-name", "SKILL.md 的 name 写成了多行块（| 或 >），本层不做改写");
    }
    if (!replaced) {
      // 双引号包裹：slug 本身只含安全字符，但引号能防 `123` 被 YAML 解析成数字。
      out.push(`name: ${JSON.stringify(target)}`);
      replaced = true;
    }
  }
  if (!replaced) fail("manifest-missing-name", "SKILL.md 的 frontmatter 缺少 name");
  if (!hasDisplay) {
    const nameIndex = out.findIndex((line) => NAME_LINE_RE.test(line));
    out.splice(nameIndex + 1, 0, `displayName: ${JSON.stringify(originalName)}`);
  }
  // 块恒以换行收口（闭行 `---` 才不会被粘到最后一行后面）；空 frontmatter 保持空串。
  return out.length ? out.join(eol) + eol : "";
}

/**
 * 把 SKILL.md 的 frontmatter name 归一成宿主可接受的名字。
 *
 * fallback 阶梯（仅供「原名非法」时使用）：
 *   options.targetName（调用方已定名，用于撞名后的二次改写）→ options.fallbackName（安装 slug）
 *   → frontmatter 里的 slug 字段 → 原名去噪 → `skill-<sha256(原名) 前 8 位>` 兜底。
 *
 * @param {string} text SKILL.md 原文
 * @param {{ fallbackName?: string, targetName?: string }} [options]
 * @returns {{ text: string, changed: boolean, renamed: boolean, name: string, originalName: string }}
 * @throws {SkillManifestError} 无法安全改写时抛错（code 说明哪道闸门没过）
 */
export function normalizeSkillManifest(text, options = {}) {
  const raw = String(text ?? "");
  const work = stripBom(raw);
  const bomStripped = work.length !== raw.length;
  if (!work) fail("manifest-empty", "SKILL.md 是空文件");
  const located = locateFrontmatter(work);
  if (!located) {
    fail("manifest-no-frontmatter", "SKILL.md 缺少 frontmatter（首行必须是 ---），DSH 无法识别这条技能");
  }
  const first = firstContentLine(located.block);
  if (first && /^[{[]/.test(first)) {
    fail("manifest-flow-style", "SKILL.md 的 frontmatter 是流式（JSON）写法，本层不做改写");
  }
  const data = parseBlock(located.block);
  const originalName = typeof data.name === "string" ? data.name.trim() : "";
  if (!originalName) fail("manifest-missing-name", "SKILL.md 的 frontmatter 缺少 name");
  const description = typeof data.description === "string" ? data.description.trim() : "";
  if (!description) fail("manifest-missing-description", "SKILL.md 的 frontmatter 缺少 description");

  if (HOST_SKILL_NAME_RE.test(originalName) && !options.targetName) {
    return { text: work, changed: bomStripped, renamed: false, name: originalName, originalName };
  }

  let target = "";
  if (options.targetName !== undefined) {
    target = String(options.targetName);
    if (!HOST_SKILL_NAME_RE.test(target)) {
      fail("manifest-empty-target", `自动选出的技能名不符合 DSH 规范（${target}）`);
    }
  } else {
    const candidates = [
      hostSafeName(options.fallbackName),
      hostSafeName(data.slug),
      hostSafeName(originalName),
    ].filter((candidate) => HOST_SKILL_NAME_RE.test(candidate));
    target = candidates[0] || `skill-${createHash("sha256").update(originalName).digest("hex").slice(0, 8)}`;
  }

  const nextBlock = rewriteNameBlock(located.block, target, originalName);
  const next = work.slice(0, located.openEnd) + nextBlock + work.slice(located.closeStart);
  // 写盘前最后一道闸门：改写后的块必须仍能解析，name 恰为目标值，description 没被带坏。
  const info = inspectSkillManifest(next);
  if (!info.ok || info.name !== target || info.description !== description) {
    fail("manifest-rewrite-unverifiable", "改写后的 frontmatter 没能得到目标 name，已放弃写盘");
  }
  return { text: next, changed: true, renamed: target !== originalName, name: target, originalName };
}

function pathEqual(left, right) {
  return process.platform === "win32"
    ? String(left).toLowerCase() === String(right).toLowerCase()
    : String(left) === String(right);
}

/** 目标名是否已被另一份已装技能的清单占用（跳过自己与在飞中的 staging 目录）。 */
async function skillNameTaken(skillsRoot, name, ownDir) {
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name === ".system" || entry.name.endsWith(".installing")) continue;
    const entryPath = join(skillsRoot, entry.name);
    if (pathEqual(entryPath, ownDir)) continue;
    const manifestPath = entry.isDirectory()
      ? join(entryPath, "SKILL.md")
      : entry.name.toLowerCase().endsWith(".md") ? entryPath : "";
    if (!manifestPath) continue;
    const text = await readFile(manifestPath, "utf8").catch(() => null);
    if (text === null) continue;
    const info = inspectSkillManifest(text);
    if (info.ok && info.name === name) return true;
  }
  return false;
}

/**
 * 安装流程的 staging 步骤：读取 `<staging>/SKILL.md`，名字非法则就地归一写回。
 * 在 rename 换入最终目录之前调用——失败时调用方的 catch 负责清理 staging，绝不留哑包。
 *
 * 撞名处理：归一后的名字若已被另一份已装技能占用，先试 `<namespace>-<slug>`，
 * 再 `-2`、`-3`…（上限 20）；不静默顶掉别人的名字。
 *
 * @param {string} stagingDir 下载暂存目录
 * @param {{ finalDir: string, skillsRoot: string, namespace?: string, slug?: string }} options
 * @returns {Promise<{ changed: boolean, renamed: boolean, name: string, originalName: string }>}
 */
export async function normalizeStagedManifest(stagingDir, options = {}) {
  const manifestPath = join(stagingDir, "SKILL.md");
  const original = await readFile(manifestPath, "utf8").catch(() => null);
  if (original === null) {
    fail("manifest-missing-file", "安装包里没有 SKILL.md，不是标准技能包，拒绝安装");
  }
  const fallbackName = typeof options.slug === "string" ? options.slug : "";
  let result = normalizeSkillManifest(original, { fallbackName });
  let wrote = result.changed;
  if (result.renamed) {
    const skillsRoot = options.skillsRoot;
    const finalDir = options.finalDir;
    let target = result.name;
    if (skillsRoot && finalDir && (await skillNameTaken(skillsRoot, target, finalDir))) {
      const namespace = hostSafeName(options.namespace);
      const base = hostSafeName(fallbackName);
      let attempt = 2;
      let prefixed = namespace && base ? `${namespace}-${base}` : target;
      while (prefixed === target || (await skillNameTaken(skillsRoot, prefixed, finalDir))) {
        if (attempt > 20) {
          throw new SkillManifestError(
            "manifest-name-taken",
            `技能名 "${target}" 已被本机另一条技能占用，且自动加前缀后仍冲突，请先卸载同名技能再安装`,
          );
        }
        prefixed = namespace && base ? `${namespace}-${base}-${attempt}` : `${base || target}-${attempt}`;
        attempt += 1;
      }
      result = normalizeSkillManifest(original, { fallbackName, targetName: prefixed });
      wrote = true;
    }
  }
  if (wrote) await writeFile(manifestPath, result.text);
  return { changed: result.changed, renamed: result.renamed, name: result.name, originalName: result.originalName };
}
