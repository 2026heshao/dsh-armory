// 已安装 skill 的卸载数据层（Skill 看板「卸载」的唯一落盘点）。
//
// 为什么不让客户端传路径直接删：path 来自 listSkills 的回包，但 RPC 入参是浏览器可写的。
// 这里只认「宿主注册表给这条 skill 的真实 source + path」，并且把删除范围钉死在四类
// skills 根目录里——用户级 ~/.agents/skills、~/.dsh/skills，项目级 <cwd>/.agents/skills、
// <cwd>/.dsh/skills。随 DSH 分发（bundled）、运行时注册（runtime）、自定义目录（custom）
// 一律拒绝：前两者不该由用户面板删，后者没有可信的根目录可用来做包含性校验。
//
// 安全闸门（按顺序，任一不过即抛错，绝不"尽力而为"地删）：
//   1. source 在白名单内，且能推导出绝对根目录（项目级必须有 cwd）；
//   2. path 是绝对路径，且 resolve 后严格位于根目录内（≠ 根自身，`..` 穿越不过）；
//      宿主注册表返回的 path 通常指向 `<skill>/SKILL.md`，先归一化到其父目录再校验，
//      否则会把 SKILL.md 当成「不是目录」误拒（GUI 验证抓到的真实形态）；
//   3. 父目录的 realpath 必须仍在根目录 realpath 内（防祖先符号链接把写入面带到别处）；
//   4. 目标是符号链接 → 只 unlink 链接本身，**绝不**触碰链接指向的目录；
//   5. 目标是目录 → 其 realpath 仍在根内，且目录里确实有 SKILL.md（文件），才递归删除。
//
// 删除是**永久删除**（不进回收站）：UI 侧有二次确认，并明示不可撤销。这与用户对删除的
// 偏好一致；不做「移到 .trash」这类软删除——那会让看板显示已卸载、磁盘却仍在。
//
// 纯数据层：零网络、零宿主依赖；home / cwd 可注入，测试用 mkdtemp 隔离。
import { lstat, readdir, realpath, rm, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/** 可卸载来源：值与宿主注册表的 skill.source 一致，客户端 SKILL_REMOVABLE_SOURCES 必须同步。 */
export const REMOVABLE_SKILL_SOURCES = ["user-agents", "user-dsh", "project-agents", "project-dsh"];

/**
 * 来源 → skills 根目录。project-* 需要 cwd；拿不到时返回 null（拒绝，而不是猜一个目录）。
 * 只写「从哪来」，不校验存在性——存在性在删除流程里按目标路径判断。
 */
export function skillRootFor(source, options = {}) {
	const home = options.home || homedir();
	const cwd = options.cwd;
	switch (source) {
		case "user-agents": return join(home, ".agents", "skills");
		case "user-dsh": return join(home, ".dsh", "skills");
		case "project-agents": return cwd ? join(cwd, ".agents", "skills") : null;
		case "project-dsh": return cwd ? join(cwd, ".dsh", "skills") : null;
		default: return null;
	}
}

/** 严格包含：child 在 parent 之内且不等于 parent。 */
function isInside(parent, child) {
	const rel = relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** 包含或相等：符号链接项只做父目录校验，父目录可以就是根。 */
function isInsideOrEqual(parent, child) {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 路径比较：Windows 大小写不敏感，其余平台按字节。 */
export const samePath = (left, right) => process.platform === "win32"
	? String(left).toLowerCase() === String(right).toLowerCase()
	: String(left) === String(right);

/**
 * 把宿主注册表给的 skill.path 映射回 skills 根目录里的「入口」。
 *
 * 关键事实：宿主 dsh-skill-filesystem 在 parseSkillFile 里返回的是 **realpath**
 * （`readSkillText` 先 realpath 再读），所以符号链接技能的 path 是链接目标，通常落在
 * skills 根之外。用户把 ~/.dsh/skills 整体链到统一技能库时，每一条都是这种形态；
 * 如果只拿 path 做根目录包含性校验，所有链接技能都会被误拒（真实 GUI 报
 * 「skill 路径不在预期的 skills 根目录内」）。
 *
 * 这里按 realpath 回查根目录里的入口：
 *   - 普通目录 / 普通 .md → 直接返回；
 *   - 根内直接子项是链接（链接本身就是技能入口）→ 返回链接路径，并标记 viaLink；
 *   - 根目录自身是链接 → 条目是真实目录，但 viaLink 也置真（整棵库共享）；
 *   - 祖先链接（根内 link/sub/SKILL.md）**不算**直接入口：entryPath 的 lstat 不是链接，
 *     viaLink 保持 false，后续 realpath 闸门仍会拒绝，安全边界不变。
 *
 * @param {{ name?: string, source?: string, path?: string }} skill
 * @param {{ cwd?: string, home?: string }} [options]
 * @returns {Promise<null | { entryPath: string, manifestPath: string, targetReal: string, kind: "dir"|"link-dir"|"file"|"link-file", viaLink: boolean }>}
 */
export async function locateSkillEntry(skill, options = {}) {
	const source = typeof skill?.source === "string" ? skill.source : "";
	const root = skillRootFor(source, options);
	if (!root || !isAbsolute(root)) return null;
	const raw = typeof skill?.path === "string" ? skill.path.trim() : "";
	if (!raw || !isAbsolute(raw)) return null;
	const rootAbs = resolve(root);
	const rawAbs = resolve(raw);
	// 根目录自己的 SKILL.md 不是一条独立技能，不能拿它当入口。
	if (samePath(dirname(rawAbs), rootAbs) && basename(rawAbs).toLowerCase() === "skill.md") return null;
	const rawReal = await realpath(rawAbs).catch(() => null);
	if (!rawReal) return null;
	const rootReal = await realpath(rootAbs).catch(() => rootAbs);
	const rootLinked = !samePath(rootReal, rootAbs);

	const fromEntry = async (entryPath) => {
		if (samePath(entryPath, rootAbs)) return null;
		const info = await stat(entryPath).catch(() => null);
		if (!info) return null;
		// 扁平技能只认 .md；其它文件不是 skill 清单，交给调用方报具体形态错误。
		if (!info.isDirectory() && !entryPath.toLowerCase().endsWith(".md")) return null;
		const manifestPath = info.isDirectory() ? join(entryPath, "SKILL.md") : entryPath;
		const targetReal = await realpath(manifestPath).catch(() => null);
		if (!targetReal) return null;
		const linkInfo = await lstat(entryPath).catch(() => null);
		const entryLinked = !!linkInfo?.isSymbolicLink();
		return {
			entryPath,
			manifestPath,
			targetReal,
			kind: info.isDirectory() ? (entryLinked ? "link-dir" : "dir") : (entryLinked ? "link-file" : "file"),
			viaLink: entryLinked || rootLinked,
		};
	};

	// 1) 根内路径：普通目录 / 普通 .md / 根内链接 / 注册表直接给链接路径。
	if (isInside(rootAbs, rawAbs)) {
		if (basename(rawAbs).toLowerCase() === "skill.md") {
			const byDir = await fromEntry(dirname(rawAbs));
			if (byDir) return byDir;
		}
		const direct = await fromEntry(rawAbs);
		if (direct) return direct;
	}

	// 2) 注册表给的是 realpath（链接目标在根外）：回查根目录里指向同一清单的直接入口。
	const entries = await readdir(rootAbs, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (entry.name === ".system") continue;
		const entryPath = join(rootAbs, entry.name);
		const candidate = await fromEntry(entryPath);
		if (!candidate) continue;
		if (samePath(candidate.targetReal, rawReal)) return candidate;
		// 注册表偶尔给的是技能目录（不是 SKILL.md）：再比一次目录 realpath。
		const entryReal = await realpath(entryPath).catch(() => null);
		if (entryReal && samePath(entryReal, rawReal)) return candidate;
	}
	return null;
}

/** 看板展示用的链接位：入口本身是链接（或整个 skills 根是链接）才算共享源。 */
export async function describeSkillEntryLink(skill, options = {}) {
	const located = await locateSkillEntry(skill, options);
	if (!located) return { linked: false };
	return located.viaLink
		? { linked: true, realPath: located.targetReal }
		: { linked: false };
}

function describeSource(source) {
	return source ? `「${source}」` : "未知来源";
}

/**
 * 从磁盘永久删除一条已发现的 skill。
 *
 * @param {{ name?: string, source?: string, path?: string }} skill 宿主注册表返回的条目（path 可为目录或目录内的 SKILL.md）
 * @param {{ cwd?: string, home?: string }} [options]
 * @returns {Promise<{ path: string, kind: "symlink" | "dir" }>}
 */
export async function removeSkillFromDisk(skill, options = {}) {
	const source = typeof skill?.source === "string" ? skill.source : "";
	const root = skillRootFor(source, options);
	if (!root) {
		if (source === "project-agents" || source === "project-dsh") {
			throw new Error(`卸载项目级 skill 需要当前项目路径（来源：${describeSource(source)}）`);
		}
		throw new Error(`这个 skill 来自${describeSource(source)}，不在可卸载范围内（只支持用户级/项目级的 .dsh/skills 与 .agents/skills）`);
	}
	if (!isAbsolute(root)) throw new Error("拒绝卸载：无法确定 skills 根目录的绝对路径");
	const raw = typeof skill?.path === "string" ? skill.path.trim() : "";
	if (!raw) throw new Error("这个 skill 没有可卸载的磁盘路径（运行时注册的 skill 不落盘）");
	if (!isAbsolute(raw)) throw new Error("拒绝卸载：skill 路径不是绝对路径");

	const rawAbs = resolve(raw);
	const rootAbs = resolve(root);
	// 注册表给的是 realpath（宿主读清单前先 realpath），直接子项是链接时 path 会落在根外。
	// locateSkillEntry 会按 realpath 回查根目录里的入口；找不到时再按形态给出具体原因。
	const located = await locateSkillEntry(skill, options);
	if (!located) {
		// 根目录自身的 SKILL.md 与根外路径都不是一条可删技能，先按边界拒绝；
		// 只有真正落在根内的路径才继续区分「已消失 / 缺清单 / 非目录」。
		if (samePath(dirname(rawAbs), rootAbs) && basename(rawAbs).toLowerCase() === "skill.md") {
			throw new Error(`拒绝卸载：skill 路径不在预期的 skills 根目录内（${rootAbs}）`);
		}
		if (!isInside(rootAbs, rawAbs)) {
			throw new Error(`拒绝卸载：skill 路径不在预期的 skills 根目录内（${rootAbs}）`);
		}
		const info = await stat(rawAbs).catch(() => null);
		if (!info) throw new Error("这个 skill 已经不在磁盘上了（可能刚被移动或删除）");
		if (info.isDirectory()) {
			const manifest = await stat(join(rawAbs, "SKILL.md")).catch(() => null);
			if (!manifest || !manifest.isFile()) throw new Error("拒绝卸载：目录里没有 SKILL.md，看起来不是 skill 目录");
		} else if (!rawAbs.toLowerCase().endsWith(".md")) {
			throw new Error("拒绝卸载：该路径不是目录（也不是符号链接）");
		}
		throw new Error(`拒绝卸载：skill 路径不在预期的 skills 根目录内（${rootAbs}）`);
	}

	// 入口本身是链接：只删链接，绝不触碰目标。包括「目录链接」与「扁平 .md 文件链接」。
	if (located.viaLink) {
		const linkInfo = await lstat(located.entryPath).catch(() => null);
		if (linkInfo?.isSymbolicLink()) {
			await unlink(located.entryPath);
			return { path: located.entryPath, kind: "symlink" };
		}
	}

	// 根目录自身是链接时，条目是真实目录；仍按 realpath 后的根做包含性校验。
	// 祖先链接（根内 link/sub/SKILL.md）的 entryPath 不是链接，viaLink=false，会在这里被拒。
	const rootReal = await realpath(rootAbs);
	const entryReal = await realpath(located.entryPath).catch(() => null);
	if (!entryReal || !isInsideOrEqual(rootReal, entryReal)) {
		throw new Error("拒绝卸载：skill 路径经符号链接指向了 skills 根目录之外");
	}

	const info = await stat(located.entryPath).catch(() => null);
	if (!info) throw new Error("这个 skill 已经不在磁盘上了（可能刚被移动或删除）");
	if (!info.isDirectory()) throw new Error("拒绝卸载：该路径不是目录（也不是符号链接）");
	const manifest = await stat(join(located.entryPath, "SKILL.md")).catch(() => null);
	if (!manifest || !manifest.isFile()) {
		throw new Error("拒绝卸载：目录里没有 SKILL.md，看起来不是 skill 目录");
	}
	await rm(located.entryPath, { recursive: true, force: false });
	return { path: located.entryPath, kind: "dir" };
}
