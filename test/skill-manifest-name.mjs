// issue #22 回归：市场技能「假安装」——SKILL.md frontmatter 的 name 不是宿主能认的
// kebab-case（中文 / 大写 / 空格 / 下划线）时，安装原字节落盘、面板亮「已安装」，
// 而宿主 @deepseek-ai/dsh-skill 的 parseSkillFile 只打一条 logger 警告就整条丢弃，
// 模型目录与 /菜单永远看不到。
//
// 本套件钉三件事：
//   1. 宿主正则不是空转——中文/大写/空格/下划线确实被拒（否则下面的「归一」没有意义）；
//   2. 归一纯函数的每条路径（fallback 阶梯、displayName 补写、CRLF/BOM、四类拒绝码、
//      幂等、重复 key 收敛），以及「改写后必须仍可解析」这道写盘闸门；
//   3. staging 落盘步骤（normalizeStagedManifest）：改名写回、撞名加前缀、不可救包
//      抛错且原文件逐字节不变。
//
// 隔离纪律：mkdtemp 临时目录，绝不碰真实 ~/.agents 或 ~/.dsh；零网络。
// 用法：node ./test/skill-manifest-name.mjs
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const libDir = new URL("../lib/", import.meta.url);
const {
  HOST_SKILL_NAME_RE,
  SkillManifestError,
  hostSafeName,
  inspectSkillManifest,
  normalizeSkillManifest,
  normalizeStagedManifest,
} = await import(new URL("skill-manifest.js", libDir).href);

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const throwsCode = (fn, code) => {
  try {
    fn();
    return false;
  } catch (error) {
    return error instanceof SkillManifestError && error.code === code;
  }
};

// ── 1. 宿主正则不是空转（反向自测：这些值必须被拒，否则归一器在修一个不存在的问题）──
for (const bad of ["文章转PPT底稿_秋叶职场", "Skill Finder (x)", "High_End", "UPPER", "with space", "-lead", "trail-", "a--b", ""]) {
  ok(`宿主正则拒绝「${bad}」`, !HOST_SKILL_NAME_RE.test(bad));
}
for (const good of ["ppt-script-writer", "a1", "123", "find-skills"]) {
  ok(`宿主正则接受「${good}」`, HOST_SKILL_NAME_RE.test(good));
}
ok("hostSafeName 折叠非法字符（保留拉丁片段）", hostSafeName("文章转PPT底稿_秋叶职场") === "ppt");
ok("hostSafeName 大小写/空格/括号", hostSafeName("Skill Finder (Find ClawHub skills + Search Skills.sh)") === "skill-finder-find-clawhub-skills-search-skills-sh".slice(0, 48).replace(/-+$/, ""));
ok("hostSafeName 截断后不留尾横线", !hostSafeName("a".repeat(47) + "---b").endsWith("-"));

// ── 2. 纯函数：合法名逐字节不动 ─────────────────────────────────────────────
const validDoc = "---\nname: find-skills\ndescription: Find skills.\n---\n\n# Body\nkeep me\n";
{
  const result = normalizeSkillManifest(validDoc, { fallbackName: "ignored" });
  ok("合法名：changed=false", result.changed === false);
  ok("合法名：renamed=false", result.renamed === false);
  ok("合法名：text 逐字节不变", result.text === validDoc);
}

// ── 3. 纯函数：中文名走安装 slug，displayName 补回原名 ──────────────────────
const cjkDoc = "---\nname: \"文章转PPT底稿_秋叶职场\"\nslug: ppt-script-writer\ndescription: 重构技能。\n---\n\n# 正文\n内容一\n";
{
  const result = normalizeSkillManifest(cjkDoc, { fallbackName: "ppt-script-writer" });
  ok("中文名：改为安装 slug", result.name === "ppt-script-writer" && result.renamed === true);
  ok("中文名：原名保留在 originalName", result.originalName === "文章转PPT底稿_秋叶职场");
  ok("中文名：补写 displayName 原名", result.text.includes("displayName: \"文章转PPT底稿_秋叶职场\""));
  ok("中文名：description 原样", result.text.includes("description: 重构技能。"));
  ok("中文名：正文原样", result.text.includes("# 正文\n内容一"));
  ok("中文名：闭合 --- 独占一行", result.text.includes("description: 重构技能。\n---\n\n# 正文"));
  const info = inspectSkillManifest(result.text);
  ok("中文名：改写后仍可解析且 name 正确", info.ok === true && info.name === "ppt-script-writer");
}

// ── 4. fallback 阶梯：无安装 slug 时用 frontmatter 的 slug 字段 ──────────────
{
  const result = normalizeSkillManifest(cjkDoc, {});
  ok("无安装 slug：回落到 frontmatter slug", result.name === "ppt-script-writer");
}

// ── 5. fallback 阶梯：全都没有时用确定性 hash 兜底 ──────────────────────────
{
  const doc = "---\nname: 纯中文名\ndescription: d\n---\n\nbody\n";
  const a = normalizeSkillManifest(doc, {});
  const b = normalizeSkillManifest(doc, {});
  ok("hash 兜底：形如 skill-xxxxxxxx", /^skill-[0-9a-f]{8}$/.test(a.name));
  ok("hash 兜底：确定性（两次相同）", a.name === b.name);
}

// ── 6. 英文显示名同样归一 ───────────────────────────────────────────────────
{
  const doc = "---\nname: \"Skill Finder (Find ClawHub skills + Search Skills.sh)\"\ndescription: d\n---\n";
  const result = normalizeSkillManifest(doc, { fallbackName: "skill-finder" });
  ok("英文显示名：使用安装 slug", result.name === "skill-finder");
  ok("英文显示名：结果过宿主正则", HOST_SKILL_NAME_RE.test(result.name));
}

// ── 7. CRLF 保留 ───────────────────────────────────────────────────────────
{
  const doc = "---\r\nname: 中文名\r\ndescription: d\r\n---\r\n\r\nbody\r\n";
  const result = normalizeSkillManifest(doc, { fallbackName: "x-y" });
  ok("CRLF：改写后无裸 LF", !/[^\r]\n/.test(result.text));
  ok("CRLF：仍含 CRLF", result.text.includes("\r\n"));
  ok("CRLF：name 正确", inspectSkillManifest(result.text).name === "x-y");
}

// ── 8. displayName 已存在时不覆盖、不重复 ───────────────────────────────────
{
  const doc = "---\nname: 中文名\ndisplayName: 已有显示名\ndescription: d\n---\n";
  const result = normalizeSkillManifest(doc, { fallbackName: "cjk" });
  const count = (result.text.match(/^displayName:/gm) || []).length;
  ok("已有 displayName：零新增", count === 1);
  ok("已有 displayName：原值保留", result.text.includes("displayName: 已有显示名"));
}

// ── 9. 幂等与重复 name key 收敛 ────────────────────────────────────────────
{
  const once = normalizeSkillManifest(cjkDoc, { fallbackName: "ppt-script-writer" });
  const twice = normalizeSkillManifest(once.text, { fallbackName: "ppt-script-writer" });
  ok("幂等：第二次 changed=false", twice.changed === false);
  const dup = "---\nname: 一个中文\ndescription: d\nname: 又一个中文\n---\n";
  ok(
    "重复 name key：与宿主一致按非法 YAML 拒绝（yaml 解析器 uniqueKeys）",
    throwsCode(() => normalizeSkillManifest(dup, { fallbackName: "dup-fix" }), "manifest-invalid-yaml"),
  );
}

// ── 10. BOM ────────────────────────────────────────────────────────────────
{
  const doc = "\ufeff---\nname: ok-skill\ndescription: d\n---\n";
  const result = normalizeSkillManifest(doc, {});
  ok("BOM：被剥离且 changed=true", result.changed === true && result.text.charCodeAt(0) !== 0xfeff);
  ok("BOM：name 不变", result.name === "ok-skill" && result.renamed === false);
}

// ── 11. 不可救的四类拒绝（每种都必须是 code，不是静默放过）───────────────────
{
  ok("无 frontmatter：拒绝", throwsCode(() => normalizeSkillManifest("# 标题\n正文", {}), "manifest-no-frontmatter"));
  ok("缺 description：拒绝", throwsCode(() => normalizeSkillManifest("---\nname: 中文名\n---\n", {}), "manifest-missing-description"));
  ok("缺 name：拒绝", throwsCode(() => normalizeSkillManifest("---\ndescription: d\n---\n", {}), "manifest-missing-name"));
  ok("流式 frontmatter：拒绝", throwsCode(() => normalizeSkillManifest("---\n{\"name\": \"x\", \"description\": \"d\"}\n---\n", {}), "manifest-flow-style"));
  ok("name 多行块：拒绝", throwsCode(() => normalizeSkillManifest("---\nname: >\n  中文名\ndescription: d\n---\n", {}), "manifest-multiline-name"));
  ok("targetName 非法：拒绝", throwsCode(() => normalizeSkillManifest(cjkDoc, { targetName: "中文名" }), "manifest-empty-target"));
}

// ── 12. staging 落盘：改名写回 / 撞名 / 不可救包原样 ─────────────────────────
const root = await mkdtemp(join(tmpdir(), "dsh-armory-manifest-"));
try {
  const staging = join(root, "user-x__ppt-script-writer.installing");
  const finalDir = join(root, "user-x__ppt-script-writer");
  await mkdir(staging, { recursive: true });
  await writeFile(join(staging, "SKILL.md"), cjkDoc);
  const installed = await normalizeStagedManifest(staging, { finalDir, skillsRoot: root, namespace: "user-x", slug: "ppt-script-writer" });
  const onDisk = await readFile(join(staging, "SKILL.md"), "utf8");
  ok("staging：返回归一后的 name", installed.name === "ppt-script-writer" && installed.renamed === true);
  ok("staging：磁盘文件已写回", onDisk.includes("name: \"ppt-script-writer\""));

  // 撞名：另一条已装技能占用了 ppt-script-writer → 加 namespace 前缀
  const other = join(root, "occupied__by-other");
  await mkdir(other, { recursive: true });
  await writeFile(join(other, "SKILL.md"), "---\nname: ppt-script-writer\ndescription: d\n---\n");
  const staging2 = join(root, "user-y__ppt-script-writer.installing");
  await mkdir(staging2, { recursive: true });
  await writeFile(join(staging2, "SKILL.md"), cjkDoc);
  const collided = await normalizeStagedManifest(staging2, { finalDir: join(root, "user-y__ppt-script-writer"), skillsRoot: root, namespace: "user-y", slug: "ppt-script-writer" });
  ok("撞名：加 namespace 前缀", collided.name === "user-y-ppt-script-writer");

  // 再撞一次 → -2
  const other2 = join(root, "occupied__again");
  await mkdir(other2, { recursive: true });
  await writeFile(join(other2, "SKILL.md"), "---\nname: user-y-ppt-script-writer\ndescription: d\n---\n");
  const staging3 = join(root, "user-y__second.installing");
  await mkdir(staging3, { recursive: true });
  await writeFile(join(staging3, "SKILL.md"), "---\nname: 又一个中文\ndescription: d\n---\n");
  const collided2 = await normalizeStagedManifest(staging3, { finalDir: join(root, "user-y__second"), skillsRoot: root, namespace: "user-y", slug: "ppt-script-writer" });
  ok("连撞两次：加 -2 后缀", collided2.name === "user-y-ppt-script-writer-2");

  // 不可救的包：抛错且原文件逐字节不变
  const staging4 = join(root, "broken__no-frontmatter.installing");
  await mkdir(staging4, { recursive: true });
  const brokenText = "# 标题\n没有 frontmatter\n";
  await writeFile(join(staging4, "SKILL.md"), brokenText);
  let rejectedCode = "";
  try {
    await normalizeStagedManifest(staging4, { finalDir: join(root, "broken__no-frontmatter"), skillsRoot: root, namespace: "broken", slug: "no-frontmatter" });
  } catch (error) {
    rejectedCode = error?.code || "";
  }
  ok("不可救包：抛 manifest-no-frontmatter", rejectedCode === "manifest-no-frontmatter");
  ok("不可救包：原文件逐字节未变", (await readFile(join(staging4, "SKILL.md"), "utf8")) === brokenText);

  // 合法包：零改写
  const staging5 = join(root, "ok__fine.installing");
  await mkdir(staging5, { recursive: true });
  const fine = "---\nname: find-skills\ndescription: d\n---\n";
  await writeFile(join(staging5, "SKILL.md"), fine);
  const untouched = await normalizeStagedManifest(staging5, { finalDir: join(root, "ok__fine"), skillsRoot: root, namespace: "ok", slug: "fine" });
  ok("合法包：零改写", untouched.changed === false && (await readFile(join(staging5, "SKILL.md"), "utf8")) === fine);

  // 缺 SKILL.md
  const staging6 = join(root, "empty__pkg.installing");
  await mkdir(staging6, { recursive: true });
  let missingCode = "";
  try {
    await normalizeStagedManifest(staging6, { finalDir: join(root, "empty__pkg"), skillsRoot: root, namespace: "empty", slug: "pkg" });
  } catch (error) {
    missingCode = error?.code || "";
  }
  ok("缺 SKILL.md：拒绝", missingCode === "manifest-missing-file");
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
