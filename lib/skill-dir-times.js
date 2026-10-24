// Skill 看板的「安装时间 + 市场原名」投影（按 skill 名字索引）。
//
// 为什么不按 listSkills 行里的 path 查：宿主注册表的行**不一定**带 path（字段是条件
// 展开，lib/index.js 只透传注册表给的），实测有的版本整列都缺——按 path 查会整表静默
// 落空。这里改为宿主自建映射：扫描标准技能根目录，读每个目录 SKILL.md 头部的
// `name:` 字段得到「看板显示名」，建立 名字 → 目录 → 时间/原名 的映射，按名字返回。
// 面板的每一行必有 name（看板主键），join 永不落空。
//
// installedAt 取值优先级（与 wb-market.wbSkillInstalled 同一口径）：
//   ① 安装状态账本（kind=skill，按 installPath 归一对齐）登记的首次安装时间；
//   ② 目录创建时间——重装 = rm 后 rename 换入新目录，创建时间即最近一次落盘；
//   ③ 目录修改时间兜底（个别文件系统不吐 birthtime）。
// 没有 SKILL.md 的目录不会被注册表发现，直接跳过；同名目录按扫描序首个优先
// （agents 根在 dsh 根之前，与注册表的来源优先级同向）。
// 账本命中的条目附带 marketName / marketplace / marketVersion：账本登记的是市场里的
// 名字，看板显示的是 SKILL.md 的 name 字段——两者可以不同，投影出去供面板对应。
//
// 纯只读（readdir / stat / 只读 SKILL.md 头部 4KB）；账本读失败只降级到 ②③。
// 存储根目录可注入（options.rootDir / DSH_ARMORY_HOME），home 可注入（options.home，测试用）。
import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { listInstalled } from "./wb-install-state.js";

/** join 键归一：分隔符统一 /、去尾斜杠。账本 installPath 与实际扫描目录是两套来源，
 *  Windows 下分隔符与结尾斜杠可能有差异，对齐前先拉齐形态。 */
const normPath = (value) => String(value || "").trim().replace(/[\\/]+/g, "/").replace(/\/+$/, "");

/** 只读文件头部 4KB——frontmatter 永远在最前面，整读大 SKILL.md 不值得。 */
async function head(path, bytes = 4096) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close().catch(() => {});
  }
}

/** SKILL.md 头部 frontmatter 的 name 字段；没有 frontmatter / 没写 name 返回空串。 */
export function frontmatterName(text) {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(String(text || ""));
  if (!block) return "";
  const line = /^name:[ \t]*(.+?)[ \t]*$/m.exec(block[1]);
  return line ? line[1].replace(/^["']|["']$/g, "") : "";
}

/**
 * 扫描技能根目录，返回「看板名字 → 安装信息」映射。
 * @param {object} payload 客户端信封：{ cwd? }（项目作用域时带项目根）
 * @returns {Promise<{info: Record<string, {installedAt: number, dir: string,
 *   marketName?: string, marketplace?: string, marketVersion?: string}>}>}
 */
export async function skillInstallInfo(payload = {}, options = {}) {
  const home = options.home || homedir();
  const roots = [
    join(home, ".agents", "skills"),
    join(home, ".dsh", "skills"),
  ];
  const cwd = String(payload?.cwd || "").trim();
  if (cwd) {
    roots.push(join(cwd, ".agents", "skills"));
    roots.push(join(cwd, ".dsh", "skills"));
  }
  const ledger = await listInstalled("skill", options).catch(() => []);
  const byPath = new Map(
    ledger.filter((row) => row && row.installPath).map((row) => [normPath(row.installPath), row]),
  );
  const info = {};
  for (const root of roots) {
    let entries = [];
    try {
      entries = await readdir(root);
    } catch {
      continue; // 根目录不存在（没装过任何市场技能 / 没有 ~/.dsh/skills）：跳过
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const dir = join(root, entry);
      let dirStat;
      try {
        dirStat = await stat(dir);
      } catch {
        continue; // 竞态删除等：跳过
      }
      if (!dirStat.isDirectory()) continue;
      let name = "";
      try {
        name = frontmatterName(await head(join(dir, "SKILL.md")));
      } catch {
        continue; // 没有 SKILL.md：注册表发现不了，不进映射
      }
      if (!name) name = entry;
      if (info[name]) continue; // 同名：首个根/首个目录优先
      const hit = byPath.get(normPath(dir));
      const bornAt = Math.round(Number(dirStat.birthtimeMs) || 0);
      const row = {
        installedAt: (hit?.installedAt || 0) || bornAt || Math.round(Number(dirStat.mtimeMs) || 0),
        dir,
      };
      if (hit?.name) {
        row.marketName = hit.name;
        row.marketplace = hit.source?.marketplace || "";
        row.marketVersion = hit.version || "";
      }
      info[name] = row;
    }
  }
  return { info };
}
