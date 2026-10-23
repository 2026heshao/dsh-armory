// 已安装 skill 卸载数据层（lib/skill-remove.js）的回归套件。
//
// 这是全仓唯一会「永久删文件」的函数，所以测试目标不是 happy path，而是**不能删什么**：
//   - 来源白名单：bundled / runtime / custom / 未知 / 项目级缺 cwd → 一律拒绝；
//   - 路径边界：根自身、`..` 穿越、跨来源根、相对路径 → 拒绝且磁盘不变；
//   - 符号链接：只删链接本身，链接指向的真实目录（含技能内容）必须原样保留；
//   - 祖先符号链接：路径字符串在根内、实际落在根外 → 拒绝（realpath 校验）；
//   - 形态校验：缺 SKILL.md、目标不是目录、已不存在 → 拒绝且不误删兄弟目录。
//
// 隔离纪律：全部落在 mkdtemp 下，home / cwd 显式注入，绝不碰真实 ~/.agents 或 ~/.dsh。
// 符号链接在 Windows 用 junction（无需管理员权限），语义与目录 symlink 相同。
// 用法：node ./test/skill-remove.mjs
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { REMOVABLE_SKILL_SOURCES, removeSkillFromDisk, skillRootFor } = await import(
  new URL("../lib/skill-remove.js", import.meta.url).href
);

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

async function expectThrow(name, run, fragment = "") {
  try {
    await run();
    ok(name, false, "预期抛错但没有");
    return "";
  } catch (error) {
    const message = String(error?.message || error);
    ok(name, !fragment || message.includes(fragment), message);
    return message;
  }
}

const exists = async (path) => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

/** 造一个最小可用 skill 目录：目录 + SKILL.md。 */
async function makeSkill(dir) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), "# demo\n");
  return dir;
}

const linkType = process.platform === "win32" ? "junction" : "dir";

const base = await mkdtemp(join(tmpdir(), "dsh-armory-skill-remove-"));
const home = join(base, "home");
const cwd = join(base, "project");

// ── 1. 四类可卸载来源：各自根目录内删除成功，兄弟目录不受影响 ─────────────────
{
  ok("白名单恰好四条（与客户端 SKILL_REMOVABLE_SOURCES 同步）", REMOVABLE_SKILL_SOURCES.length === 4);

  const cases = [
    ["user-agents", join(home, ".agents", "skills")],
    ["user-dsh", join(home, ".dsh", "skills")],
    ["project-agents", join(cwd, ".agents", "skills")],
    ["project-dsh", join(cwd, ".dsh", "skills")],
  ];
  for (const [source, root] of cases) {
    const target = await makeSkill(join(root, "alpha-" + source));
    const sibling = await makeSkill(join(root, "sibling-" + source));
    const result = await removeSkillFromDisk({ name: "alpha", source, path: target }, { home, cwd });
    ok(`${source}：目录被永久删除`, !(await exists(target)), target);
    ok(`${source}：返回 kind=dir 与真实路径`, result.kind === "dir" && result.path === target);
    ok(`${source}：同根兄弟目录保留`, await exists(sibling));

    // 宿主注册表的真实形态：path 指向 <skill>/SKILL.md，而不是目录本身。
    const viaManifest = await makeSkill(join(root, "manifest-" + source));
    const viaResult = await removeSkillFromDisk(
      { name: "manifest", source, path: join(viaManifest, "SKILL.md") },
      { home, cwd },
    );
    ok(
      `${source}：path 指向 SKILL.md 时按父目录卸载`,
      viaResult.kind === "dir" && viaResult.path === viaManifest && !(await exists(viaManifest)),
    );
  }
}

// ── 2. 来源白名单：不该由面板删除的一律拒绝，且磁盘不变 ─────────────────────────
{
  const root = join(home, ".agents", "skills");
  for (const source of ["bundled", "runtime", "custom", "unknown", ""]) {
    const target = await makeSkill(join(root, "keep-" + (source || "blank")));
    await expectThrow(
      `来源 ${source || "(空)"}：拒绝卸载`,
      () => removeSkillFromDisk({ source, path: target }, { home, cwd }),
      "不在可卸载范围内",
    );
    ok(`来源 ${source || "(空)"}：目录原样保留`, await exists(target));
  }
}

// ── 3. 项目级缺 cwd：拒绝而不是猜目录 ────────────────────────────────────────
{
  const target = await makeSkill(join(cwd, ".dsh", "skills", "needs-cwd"));
  await expectThrow(
    "项目级 skill 缺 cwd：拒绝",
    () => removeSkillFromDisk({ source: "project-dsh", path: target }, { home }),
    "需要当前项目路径",
  );
  ok("缺 cwd：目录原样保留", await exists(target));
}

// ── 4. 路径边界：根自身 / `..` 穿越 / 跨来源根 / 相对路径 ─────────────────────
{
  const root = join(home, ".dsh", "skills");
  await mkdir(root, { recursive: true });
  await expectThrow(
    "路径就是根目录本身：拒绝",
    () => removeSkillFromDisk({ source: "user-dsh", path: root }, { home }),
    "不在预期的 skills 根目录内",
  );
  await expectThrow(
    "路径是根目录下的 SKILL.md（归一化后仍是根）：拒绝",
    () => removeSkillFromDisk({ source: "user-dsh", path: join(root, "SKILL.md") }, { home }),
    "不在预期的 skills 根目录内",
  );

  const outside = await makeSkill(join(base, "outside", "escape"));
  await expectThrow(
    "`..` 穿越到根外：拒绝",
    () => removeSkillFromDisk({ source: "user-dsh", path: join(root, "..", "..", "outside", "escape") }, { home }),
    "不在预期的 skills 根目录内",
  );
  ok("`..` 穿越：根外目录原样保留", await exists(outside));

  const otherRootSkill = await makeSkill(join(home, ".agents", "skills", "other-root"));
  await expectThrow(
    "声明 user-dsh 却指向 .agents 根：拒绝",
    () => removeSkillFromDisk({ source: "user-dsh", path: otherRootSkill }, { home }),
    "不在预期的 skills 根目录内",
  );
  ok("跨来源根：目录原样保留", await exists(otherRootSkill));

  await expectThrow(
    "相对路径：拒绝",
    () => removeSkillFromDisk({ source: "user-agents", path: ".agents/skills/relative" }, { home, cwd }),
    "不是绝对路径",
  );
  await expectThrow(
    "没有 path（运行时注册形态）：拒绝",
    () => removeSkillFromDisk({ source: "user-agents" }, { home, cwd }),
    "没有可卸载的磁盘路径",
  );
}

// ── 5. 形态校验：缺 SKILL.md / 不是目录 / 已经不存在 ─────────────────────────
{
  const root = join(home, ".agents", "skills");
  const noManifest = join(root, "not-a-skill");
  await mkdir(noManifest, { recursive: true });
  await writeFile(join(noManifest, "README.md"), "not a skill\n");
  await expectThrow(
    "目录里没有 SKILL.md：拒绝",
    () => removeSkillFromDisk({ source: "user-agents", path: noManifest }, { home }),
    "没有 SKILL.md",
  );
  ok("缺 SKILL.md：目录原样保留", await exists(noManifest));

  const plainFile = join(root, "plain.txt");
  await writeFile(plainFile, "x");
  await expectThrow(
    "目标是普通文件：拒绝",
    () => removeSkillFromDisk({ source: "user-agents", path: plainFile }, { home }),
    "不是目录",
  );
  ok("普通文件原样保留", await exists(plainFile));

  const gone = join(root, "already-gone");
  await expectThrow(
    "目标已不存在：拒绝",
    () => removeSkillFromDisk({ source: "user-agents", path: gone }, { home }),
    "已经不在磁盘上",
  );
}

// ── 6. 符号链接：只删链接本身，目标（技能内容）必须保留 ────────────────────────
{
  const root = join(home, ".agents", "skills");
  const external = await makeSkill(join(base, "external", "tabbit"));
  const link = join(root, "tabbit");
  await symlink(external, link, linkType);

  const result = await removeSkillFromDisk({ source: "user-agents", path: link }, { home });
  ok("符号链接：返回 kind=symlink", result.kind === "symlink");
  ok("符号链接：链接本身被删除", !(await exists(link)));
  ok("符号链接：链接指向的目录仍存在", await exists(external));
  ok("符号链接：链接指向的 SKILL.md 未被波及", await exists(join(external, "SKILL.md")));

  // 注册表也可能给出「链接目录内的 SKILL.md」形态：同样只能删链接本身。
  const external2 = await makeSkill(join(base, "external", "linked-manifest"));
  const link2 = join(root, "linked-manifest");
  await symlink(external2, link2, linkType);
  const manifestResult = await removeSkillFromDisk(
    { source: "user-agents", path: join(link2, "SKILL.md") },
    { home },
  );
  ok("符号链接 + SKILL.md 路径：返回 kind=symlink", manifestResult.kind === "symlink");
  ok("符号链接 + SKILL.md 路径：只删链接", !(await exists(link2)));
  ok("符号链接 + SKILL.md 路径：目标目录与清单保留", await exists(join(external2, "SKILL.md")));
}

// ── 7. 祖先符号链接逃逸：路径字符串在根内、真实位置在根外 → 拒绝 ───────────────
{
  const root = join(home, ".agents", "skills");
  const externalRoot = join(base, "ancestor-external");
  const crafted = await makeSkill(join(externalRoot, "crafted"));
  const bridge = join(root, "bridge");
  await symlink(externalRoot, bridge, linkType);

  await expectThrow(
    "祖先符号链接指向根外：拒绝",
    () => removeSkillFromDisk({ source: "user-agents", path: join(bridge, "crafted") }, { home }),
    "符号链接指向了 skills 根目录之外",
  );
  ok("祖先符号链接逃逸：根外目录原样保留", await exists(crafted));
}

// ── 8. 根目录自身是符号链接：允许（用户级 skills 目录常被链接到别处） ──────────
{
  const home2 = join(base, "home-linked");
  const realRoot = join(base, "real-agents-skills");
  await makeSkill(join(realRoot, "via-link"));
  await mkdir(join(home2, ".agents"), { recursive: true });
  await symlink(realRoot, join(home2, ".agents", "skills"), linkType);

  const reported = join(home2, ".agents", "skills", "via-link");
  const result = await removeSkillFromDisk({ source: "user-agents", path: reported }, { home: home2 });
  ok("根是符号链接：仍能按真实路径卸载", result.kind === "dir");
  ok("根是符号链接：条目目录确实删除", !(await exists(join(realRoot, "via-link"))));
  ok("根是符号链接：根目录本身保留", await exists(realRoot));
}

// ── 9. 根目录推导表（home / cwd 注入） ───────────────────────────────────────
{
  ok("skillRootFor(user-agents)", skillRootFor("user-agents", { home }) === join(home, ".agents", "skills"));
  ok("skillRootFor(user-dsh)", skillRootFor("user-dsh", { home }) === join(home, ".dsh", "skills"));
  ok("skillRootFor(project-agents)", skillRootFor("project-agents", { cwd }) === join(cwd, ".agents", "skills"));
  ok("skillRootFor(project-dsh)", skillRootFor("project-dsh", { cwd }) === join(cwd, ".dsh", "skills"));
  ok("skillRootFor(project-* 缺 cwd) → null", skillRootFor("project-dsh", {}) === null);
  ok("skillRootFor(custom) → null", skillRootFor("custom", { home, cwd }) === null);
}

await rm(base, { recursive: true, force: true });

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
