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
import { lstat, realpath, rm, stat, unlink } from "node:fs/promises";
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
	// 注册表把 skill.path 指向清单文件（<skill>/SKILL.md），删除目标是它所在的目录。
	// 若直接拿清单路径去删，只会得到「该路径不是目录」——真实 GUI 首跑就撞上了。
	const target = basename(rawAbs).toLowerCase() === "skill.md" ? dirname(rawAbs) : rawAbs;
	const rootAbs = resolve(root);
	if (!isInside(rootAbs, target)) {
		throw new Error(`拒绝卸载：skill 路径不在预期的 skills 根目录内（${rootAbs}）`);
	}

	let info;
	try {
		info = await lstat(target);
	} catch (error) {
		if (error?.code === "ENOENT") throw new Error("这个 skill 已经不在磁盘上了（可能刚被移动或删除）");
		throw error;
	}

	// 父目录的 realpath 校验：防「根内路径 → 祖先符号链接实际指向根外」。根目录本身是
	// 符号链接（例如 ~/.agents → 别处）是允许的，所以比的是 realpath 后的根。
	const rootReal = await realpath(rootAbs);
	const parentReal = await realpath(dirname(target));
	if (!isInsideOrEqual(rootReal, parentReal)) {
		throw new Error("拒绝卸载：skill 路径经符号链接指向了 skills 根目录之外");
	}

	if (info.isSymbolicLink()) {
		// 只删链接本身。链接可能指向任意位置（例如 tabbit 这种外部安装的 skill），
		// rm/lstat 都不会跟随，但我们仍显式只用 unlink，语义一目了然。
		await unlink(target);
		return { path: target, kind: "symlink" };
	}
	if (!info.isDirectory()) throw new Error("拒绝卸载：该路径不是目录（也不是符号链接）");

	const targetReal = await realpath(target);
	if (!isInside(rootReal, targetReal)) {
		throw new Error("拒绝卸载：skill 目录经符号链接指向了 skills 根目录之外");
	}
	const manifest = await stat(join(target, "SKILL.md")).catch(() => null);
	if (!manifest || !manifest.isFile()) {
		throw new Error("拒绝卸载：目录里没有 SKILL.md，看起来不是 skill 目录");
	}
	await rm(target, { recursive: true, force: false });
	return { path: target, kind: "dir" };
}
