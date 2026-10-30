// 技能禁用数据层（工具裁缝技能账本「禁用 / 释放」的唯一落盘点）。
//
// 机制：写 SKILL.md frontmatter 的 `disable-model-invocation` 标志。这是宿主
// （@deepseek-ai/dsh-skill-filesystem）官方支持的「模型侧禁用」键：置 true 后该技能
// 不再进模型目录与加载器，Schema 与描述不再随每轮请求下发（上下文税归零）；输入框
// 手动 /引用 不受影响。skills 根目录有监听器，改动会被自动拾取，无需重启宿主。
// 「释放」= 移除该标志，恢复模型可调用。禁用是可逆编辑，不是卸载——目录与正文分毫不动。
//
// 为什么不让客户端传路径直接改：与 lib/skill-remove.js 同一理由——RPC 入参是浏览器
// 可写的。这里只认「宿主注册表给这条 skill 的真实 source + path」，并把写入面钉死在
// 四类 skills 根目录里（用户级 ~/.agents/skills、~/.dsh/skills，项目级 <cwd>/.agents/
// skills、<cwd>/.dsh/skills）。bundled（随应用分发，升级会被覆盖回去）、runtime
// （不落盘）、custom（没有可信根目录做包含性校验）一律拒绝——白名单与 skill-remove 同集。
//
// 安全闸门（与 skill-remove 同序，任一不过即抛错，绝不「尽力而为」地写）：
//   1. source 在白名单内，且能推导出绝对根目录（项目级必须有 cwd）；
//   2. path 是绝对路径，resolve 后严格位于根目录内（≠ 根自身，`..` 穿越不过）；
//      注册表的 path 通常指向 <skill>/SKILL.md，也可能指向目录或扁平 <name>.md，
//      归一到「要编辑的那个 .md 清单文件」再校验；
//   3. 清单文件的 realpath 必须仍在根目录 realpath 内（防符号链接把写入面带出根；
//      链接指回根内是允许的——写 realpath 而不是链接路径，用户的链接结构分毫不动）。
//
// frontmatter 手术只动一处（editInvocationFlag 纯函数，磁盘外可测）：按与宿主解析器
// 相同的规则定位开/闭 `---` 行之间的块——
//   禁用：删掉块内全部 `disable-model-invocation` 行（重复键是脏数据，统一收敛），
//         在闭行前插入一行 `disable-model-invocation: true`；
//   释放：删掉块内全部该行（值为 false 的也删——恢复作者未写该键时的原貌）。
// 其余字节（键序、缩进、注释、正文）原样保留；行尾风格按文件现状保留（\n / \r\n）。
// 开/闭行缺失（没有合法 frontmatter）一律拒绝——那不是本层该修的文件。
//
// 纯数据层：零网络、零宿主服务依赖；home / cwd 可注入，测试用 mkdtemp 隔离。
import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { skillRootFor } from './skill-remove.js';

/** frontmatter 里的模型侧禁用键：宿主 dsh-skill-filesystem 的 canonical 拼写。 */
export const DISABLED_INVOCATION_KEY = 'disable-model-invocation';

const FLAG_LINE_RE = /^disable-model-invocation[ \t]*:/;

function describeSource(source) {
  return source ? `「${source}」` : '未知来源';
}

/** 严格包含：child 在 parent 之内且不等于 parent。 */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** 包含或相等：符号链接项只做包含校验，允许恰好落在根上。 */
function isInsideOrEqual(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 在 SKILL.md 原文里写入 / 移除 disable-model-invocation 标志（纯字符串手术）。
 *
 * 开/闭行判定与宿主 parseFrontmatter 同规则：首行去掉 \r 后必须恰为 `---`，闭行
 * 同为一整行 `---`；找不到任一者视为「没有合法 frontmatter」返回 null（调用方拒绝）。
 *
 * @param {string} text SKILL.md 原文
 * @param {boolean} disabled true = 置标志，false = 移除标志
 * @returns {string | null} 改写后的全文；无合法 frontmatter 时 null
 */
export function editInvocationFlag(text, disabled) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const firstBreak = text.indexOf('\n');
  if (firstBreak < 0) return null;
  if (text.slice(0, firstBreak).replace(/\r$/, '') !== '---') return null;
  // 闭行检索与宿主 findClosingFrontmatter 同步：逐行找去掉 \r 后恰为 `---` 的一行。
  let lineStart = firstBreak + 1;
  let closeStart = -1;
  while (lineStart <= text.length) {
    const nextBreak = text.indexOf('\n', lineStart);
    const lineEnd = nextBreak < 0 ? text.length : nextBreak;
    if (text.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      closeStart = lineStart;
      break;
    }
    if (nextBreak < 0) return null;
    lineStart = nextBreak + 1;
  }
  if (closeStart < 0) return null;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const block = text.slice(firstBreak + 1, closeStart);
  // 块恒以换行收口（closeStart 是闭行行首），split 的尾随空串是切片伪影，弹掉；
  // 中间的空行是真实内容，必须保留。
  const lines = block.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const kept = lines.map((line) => line.replace(/\r$/, '')).filter((line) => !FLAG_LINE_RE.test(line));
  if (disabled) kept.push(DISABLED_INVOCATION_KEY + ': true');
  // 闭行行首之前是上一行的换行符，所以块内每行（含新插入行）都要以行尾收口；
  // 空块释放后保持空串——开闭行紧邻的空 frontmatter 依然合法。
  const nextBlock = kept.length ? kept.join(eol) + eol : '';
  return text.slice(0, firstBreak + 1) + nextBlock + text.slice(closeStart);
}

/**
 * 把一条宿主注册表 skill 的「模型可调用」开关落到磁盘。
 *
 * @param {{ name?: string, source?: string, path?: string }} skill 宿主注册表返回的条目
 * @param {{ disabled: boolean, cwd?: string, home?: string }} options
 * @returns {Promise<{ path: string, disabled: boolean, changed: boolean }>}
 *   path 是实际写入的清单文件绝对路径；changed=false 表示文件本就处于目标状态
 *   （幂等重放），未写盘。
 */
export async function setSkillModelInvocationOnDisk(skill, options = {}) {
  const disabled = options.disabled === true;
  const source = typeof skill?.source === 'string' ? skill.source : '';
  const root = skillRootFor(source, options);
  if (!root) {
    if (source === 'project-agents' || source === 'project-dsh') {
      throw new Error(`禁用项目级 skill 需要当前项目路径（来源：${describeSource(source)}）`);
    }
    throw new Error(
      `这个 skill 来自${describeSource(source)}，不在可禁用范围内（只支持用户级/项目级的 .dsh/skills 与 .agents/skills）`,
    );
  }
  if (!isAbsolute(root)) throw new Error('拒绝修改：无法确定 skills 根目录的绝对路径');
  const raw = typeof skill?.path === 'string' ? skill.path.trim() : '';
  if (!raw) throw new Error('这个 skill 没有可修改的磁盘路径（运行时注册的 skill 不落盘）');
  if (!isAbsolute(raw)) throw new Error('拒绝修改：skill 路径不是绝对路径');

  const rootAbs = resolve(root);
  const rawAbs = resolve(raw);
  if (!isInside(rootAbs, rawAbs)) {
    throw new Error(`拒绝修改：skill 路径不在预期的 skills 根目录内（${rootAbs}）`);
  }

  // stat 跟随符号链接：整个 skill 目录是链接（常见于把仓库目录链进 skills 根）时
  // 也能正确识别成目录，最终由 realpath 闸门判定链接落点是否可信。
  let rawInfo;
  try {
    rawInfo = await stat(rawAbs);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('这个 skill 已经不在磁盘上了（可能刚被移动或删除）');
    throw error;
  }
  let manifestPath;
  if (rawInfo.isDirectory()) {
    manifestPath = join(rawAbs, 'SKILL.md');
  } else if (rawInfo.isFile() && rawAbs.toLowerCase().endsWith('.md')) {
    manifestPath = rawAbs; // 扁平 <name>.md 形态的 skill，清单就是文件本身
  } else {
    throw new Error('拒绝修改：skill 路径不是 skill 目录，也不是 .md 清单文件');
  }
  const manifest = await stat(manifestPath).catch(() => null);
  if (!manifest || !manifest.isFile()) {
    throw new Error('拒绝修改：目录里没有 SKILL.md，看起来不是 skill 目录');
  }

  // realpath 校验：防「根内路径 → 符号链接实际指向根外」。根目录本身是符号链接
  // （例如 ~/.agents → 别处）是允许的，所以比的是 realpath 后的根。
  const rootReal = await realpath(rootAbs);
  const fileReal = await realpath(manifestPath);
  if (!isInsideOrEqual(rootReal, fileReal)) {
    throw new Error('拒绝修改：skill 路径经符号链接指向了 skills 根目录之外');
  }

  // BOM 会同时挡住宿主解析器（首行不再是 ---）与本层手术，明确拒绝而不是绕过。
  const original = await readFile(fileReal, 'utf8');
  if (original.charCodeAt(0) === 0xfeff) {
    throw new Error('拒绝修改：SKILL.md 带 BOM 头，宿主解析器也无法读取它');
  }
  const next = editInvocationFlag(original, disabled);
  if (next === null) {
    throw new Error('拒绝修改：SKILL.md 没有合法的 YAML frontmatter（开/闭 --- 行缺失），本层不做修补');
  }
  if (next === original) {
    return { path: fileReal, disabled, changed: false };
  }
  // 写 realpath：rename 永远落在真实文件上，绝不把用户的符号链接替换成普通文件。
  await writeFileAtomic(fileReal, next, { mode: manifest.mode });
  return { path: fileReal, disabled, changed: true };
}
