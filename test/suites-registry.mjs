// 自定义套件数据层（lib/suites-registry.js）的回归套件。
//
// 覆盖：整集合覆盖保存、id 分配与写侧幂等、成员有序去重、拒绝档六种脏数据、
// 放行档三种截断/丢弃、原子写无残留、损坏文件读侧回落、残缺条目读侧过滤。
// 失败模式两态（拒绝 / 放行 + 截断）都各有用例——只验单档等于没覆盖。
//
// 隔离纪律：mkdtemp 临时目录 + options.rootDir 注入，绝不碰真实 ~/.dsh，零网络。
// 用法：node ./test/suites-registry.mjs
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  SUITES_MAX,
  SUITES_VERSION,
  SUITE_DESC_MAX,
  SUITE_MEMBERS_MAX,
  SUITE_NAME_MAX,
  normalizeSuite,
  readSuites,
  saveSuites,
  suitesPath,
} = await import(new URL("../lib/suites-registry.js", import.meta.url).href);

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const freshRoot = () => mkdtemp(join(tmpdir(), "dsh-armory-suites-"));

/** 确定性 id 生成器：注入后同一 payload 两次保存的产物字节一致（幂等断言用）。 */
const stableIds = () => {
  let n = 0;
  return () => `suite-fixed-${++n}`;
};

/** 断言「这次调用抛错」，并把错误消息回传给用例做文案断言。 */
async function expectThrow(name, run) {
  try {
    await run();
    ok(name, false, "预期抛错但没有");
    return "";
  } catch (error) {
    ok(name, true);
    return String(error?.message || error);
  }
}

// ── 1. 读侧回落：无文件 / 损坏 JSON / 结构不对 ───────────────────────────────
{
  const root = await freshRoot();
  const empty = await readSuites({ rootDir: root });
  ok("无文件：version 回落 SUITES_VERSION", empty.version === SUITES_VERSION, JSON.stringify(empty));
  ok("无文件：suites 为空数组且不抛错", Array.isArray(empty.suites) && empty.suites.length === 0);

  await writeFile(suitesPath({ rootDir: root }), "not json {{{");
  ok("损坏 JSON：回落空集合", (await readSuites({ rootDir: root })).suites.length === 0);

  await writeFile(suitesPath({ rootDir: root }), JSON.stringify({ version: 7, suites: "不是数组" }));
  const wrongShape = await readSuites({ rootDir: root });
  ok("suites 非数组：回落空集合", wrongShape.suites.length === 0);
  ok("version 是数字就照收（不擅自改写）", wrongShape.version === 7);
  await rm(root, { recursive: true, force: true });
}

// ── 2. 保存 → 读回：字段完整、成员保序 ──────────────────────────────────────
{
  const root = await freshRoot();
  const saved = await saveSuites(
    [{ id: "", name: "文档流水线", desc: "写文档要的那几把", members: ["pptx", "docx", "xlsx"] }],
    { rootDir: root, createId: stableIds() },
  );
  ok("保存返回一条", saved.suites.length === 1);
  ok("空 id 被分配（非空且带前缀）", /^suite-/.test(saved.suites[0].id), saved.suites[0].id);
  ok("首写补 createdAt/updatedAt（>0）", saved.suites[0].createdAt > 0 && saved.suites[0].updatedAt > 0);
  ok("返回值的 id 与落盘 id 一致", (await readSuites({ rootDir: root })).suites[0].id === saved.suites[0].id);
  const back = (await readSuites({ rootDir: root })).suites[0];
  ok("成员顺序 = 传入顺序（拖拽排序语义）", back.members.join(",") === "pptx,docx,xlsx", back.members.join(","));
  ok("名称与说明原样落盘", back.name === "文档流水线" && back.desc === "写文档要的那几把");
  await rm(root, { recursive: true, force: true });
}

// ── 3. 整集合覆盖 = 少传一条即删除；已有 id / 时间戳不被改写 ─────────────────
{
  const root = await freshRoot();
  const first = await saveSuites(
    [
      { id: "", name: "A", members: ["a1"] },
      { id: "", name: "B", members: ["b1"] },
    ],
    { rootDir: root, createId: stableIds() },
  );
  ok("首存两条", first.suites.length === 2);
  const keep = first.suites[0];
  // 只回传 A（并改成员），B 不在集合里 = 删除 B。
  const second = await saveSuites([{ ...keep, members: ["a1", "a2"], updatedAt: keep.updatedAt + 1000 }], {
    rootDir: root,
  });
  ok("覆盖保存：未回传的条目被删除", second.suites.length === 1 && second.suites[0].name === "A");
  ok("覆盖保存：id 保留不重分配", second.suites[0].id === keep.id, `${second.suites[0].id} vs ${keep.id}`);
  ok("覆盖保存：createdAt 保留首值", second.suites[0].createdAt === keep.createdAt);
  ok("覆盖保存：updatedAt 用调用方传入值（不由数据层擅自刷新）", second.suites[0].updatedAt === keep.updatedAt + 1000);
  ok("覆盖保存：成员变更生效", second.suites[0].members.join(",") === "a1,a2");
  await rm(root, { recursive: true, force: true });
}

// ── 4. 写侧幂等：同 payload 连存两次，落盘字节一致 ──────────────────────────
{
  const root = await freshRoot();
  const payload = [{ id: "suite-1", name: "幂等", desc: "", members: ["x", "y"], createdAt: 1700000000000, updatedAt: 1700000009999 }];
  await saveSuites(payload, { rootDir: root });
  const once = await readFile(suitesPath({ rootDir: root }), "utf8");
  await saveSuites(payload, { rootDir: root });
  const twice = await readFile(suitesPath({ rootDir: root }), "utf8");
  ok("同 payload 重放：文件字节一致（不刷新时间戳）", once === twice);
  await rm(root, { recursive: true, force: true });
}

// ── 5. 拒绝档：六种脏数据都抛错 ─────────────────────────────────────────────
{
  const root = await freshRoot();
  const msgNotArray = await expectThrow("拒绝：入参不是数组", () => saveSuites({ suites: [] }, { rootDir: root }));
  ok("拒绝文案点名「数组」", msgNotArray.includes("数组"), msgNotArray);

  const msgNotObject = await expectThrow("拒绝：条目不是对象", () => saveSuites(["字符串条目"], { rootDir: root }));
  ok("拒绝文案带条目序号", msgNotObject.includes("第 1 条"), msgNotObject);

  const msgNoName = await expectThrow("拒绝：名称为空", () =>
    saveSuites([{ id: "", name: "   ", members: ["x"] }], { rootDir: root }),
  );
  ok("拒绝文案点名「名称」", msgNoName.includes("名称"), msgNoName);

  const msgNoMembers = await expectThrow("拒绝：成员为空", () => saveSuites([{ name: "空套件", members: [] }], { rootDir: root }));
  ok("拒绝文案带套件名", msgNoMembers.includes("空套件"), msgNoMembers);

  const msgDupId = await expectThrow("拒绝：非空 id 重复", () =>
    saveSuites(
      [
        { id: "dup", name: "甲", members: ["a"] },
        { id: "dup", name: "乙", members: ["b"] },
      ],
      { rootDir: root },
    ),
  );
  ok("拒绝文案带重复 id", msgDupId.includes("dup"), msgDupId);

  const tooMany = Array.from({ length: SUITES_MAX + 1 }, (_, i) => ({ id: `s-${i}`, name: `套件${i}`, members: ["m"] }));
  await expectThrow("拒绝：套件总数超上限", () => saveSuites(tooMany, { rootDir: root }));

  // 任一拒绝都不得写盘：目录里连文件都不该出现。
  const entries = await readdir(root);
  ok("拒绝后零写入：目录里既无 suites.json 也无 .staging", entries.length === 0, entries.join(","));
  await rm(root, { recursive: true, force: true });
}

// ── 6. 拒绝不得破坏已有文件（校验先于写盘） ─────────────────────────────────
{
  const root = await freshRoot();
  await saveSuites([{ id: "keep-me", name: "原有套件", members: ["old"] }], { rootDir: root });
  const before = await readFile(suitesPath({ rootDir: root }), "utf8");
  await expectThrow("坏集合被拒（其中一条无名）", () =>
    saveSuites(
      [
        { id: "keep-me", name: "原有套件", members: ["old"] },
        { id: "bad", name: "", members: ["x"] },
      ],
      { rootDir: root },
    ),
  );
  const after = await readFile(suitesPath({ rootDir: root }), "utf8");
  ok("拒绝后原文件逐字节未变", before === after);
  ok("拒绝后原集合仍可读回", (await readSuites({ rootDir: root })).suites[0].id === "keep-me");
  await rm(root, { recursive: true, force: true });
}

// ── 7. 放行档：超长截断 + 成员去重/丢非字符串 ───────────────────────────────
{
  const root = await freshRoot();
  const longName = "名".repeat(SUITE_NAME_MAX + 30);
  const longDesc = "说".repeat(SUITE_DESC_MAX + 50);
  const members = [];
  for (let i = 0; i < SUITE_MEMBERS_MAX + 20; i += 1) members.push(`skill-${i}`);
  const saved = await saveSuites(
    [{ id: "clamp", name: longName, desc: longDesc, members: ["dup", "dup", "  ", 42, null, "real", ...members] }],
    { rootDir: root },
  );
  const row = saved.suites[0];
  ok("放行：名称截到 SUITE_NAME_MAX", row.name.length === SUITE_NAME_MAX, `${row.name.length}`);
  ok("放行：说明截到 SUITE_DESC_MAX", row.desc.length === SUITE_DESC_MAX, `${row.desc.length}`);
  ok("放行：成员截到 SUITE_MEMBERS_MAX", row.members.length === SUITE_MEMBERS_MAX, `${row.members.length}`);
  ok("放行：重复成员按首次出现去重", row.members.filter((m) => m === "dup").length === 1);
  ok("放行：空白与非字符串成员被丢弃", !row.members.some((m) => m !== String(m).trim() || m === ""));
  ok("放行：截断保序（首个合法成员仍在首位）", row.members[0] === "dup", row.members[0]);
  await rm(root, { recursive: true, force: true });
}

// ── 8. normalizeSuite 纯函数：不造 id、防御补全 ─────────────────────────────
{
  const normalized = normalizeSuite({ name: "  带空白  ", members: "不是数组", createdAt: -5 });
  ok("normalizeSuite：id 缺失留空（由 saveSuites 分配）", normalized.id === "");
  ok("normalizeSuite：名称 trim", normalized.name === "带空白");
  ok("normalizeSuite：members 非数组折成空数组", Array.isArray(normalized.members) && normalized.members.length === 0);
  ok("normalizeSuite：畸形时间戳回落 0", normalized.createdAt === 0 && normalized.updatedAt === 0);
  ok("normalizeSuite：desc 缺失补空串", normalized.desc === "");
  ok("normalizeSuite(null) 不抛错", normalizeSuite(null).name === "");
}

// ── 9. 读侧过滤残缺条目（手改坏的文件不炸面板） ─────────────────────────────
{
  const root = await freshRoot();
  await writeFile(
    suitesPath({ rootDir: root }),
    JSON.stringify({
      version: 1,
      suites: [
        null,
        42,
        { id: "", name: "无 id", members: ["x"] },
        { id: "no-name", name: "  ", members: ["x"] },
        { id: "no-members", name: "空成员", members: [] },
        { id: "survivor", name: "合法条目", members: ["a", "b"] },
      ],
    }),
  );
  const { suites } = await readSuites({ rootDir: root });
  ok("读侧：畸形与残缺条目全被过滤", suites.length === 1 && suites[0].id === "survivor", JSON.stringify(suites));
  ok("读侧：合法条目字段完整", suites[0].members.join(",") === "a,b" && suites[0].name === "合法条目");
  await rm(root, { recursive: true, force: true });
}

// ── 10. 原子写：无 .staging 残留 + 落盘形状 ─────────────────────────────────
{
  const root = await freshRoot();
  await saveSuites([{ id: "atomic", name: "原子", members: ["m1"] }], { rootDir: root });
  const entries = await readdir(root);
  ok("原子写：目录里没有 .staging 残留", !entries.some((name) => name.endsWith(".staging")), entries.join(","));
  const onDisk = JSON.parse(await readFile(suitesPath({ rootDir: root }), "utf8"));
  ok("原子写：suites.json 落盘且 version=SUITES_VERSION", onDisk.version === SUITES_VERSION && Array.isArray(onDisk.suites));
  ok("原子写：文件名固定为 suites.json（不随入参变化）", suitesPath({ rootDir: root }).endsWith("suites.json"));
  ok("原子写：另一 rootDir 得到另一路径（隔离有效）", suitesPath({ rootDir: join(root, "other") }) !== suitesPath({ rootDir: root }));
  await rm(root, { recursive: true, force: true });
}

// ── 11. 真实调用路径：读 → 改 → 存 → 再读（UI 保存链的等价驱动） ────────────
{
  const root = await freshRoot();
  const emptyDoc = await readSuites({ rootDir: root });
  const withNew = await saveSuites(
    [...emptyDoc.suites, { id: "", name: "前端一条龙", desc: "设计到实现", members: ["frontend-design", "code-generation", "code-review"] }],
    { rootDir: root, createId: stableIds() },
  );
  ok("UI 链：新建后集合含一条", withNew.suites.length === 1);
  const renamed = await saveSuites(
    withNew.suites.map((suite) => ({ ...suite, name: "前端全链路", members: suite.members.filter((m) => m !== "code-review") })),
    { rootDir: root },
  );
  ok("UI 链：改名 + 移除成员后仍只有一条", renamed.suites.length === 1 && renamed.suites[0].name === "前端全链路");
  ok("UI 链：成员移除生效", renamed.suites[0].members.join(",") === "frontend-design,code-generation");
  const reread = await readSuites({ rootDir: root });
  ok("UI 链：重开弹窗读回的就是刚存的那份", reread.suites[0].id === renamed.suites[0].id && reread.suites[0].members.length === 2);
  await rm(root, { recursive: true, force: true });
}

// ── 12. 证伪：对「id 归属」不变量主动构造反例，试图推翻它 ──────────────────────
// 不变量（lib/suites-registry.js 顶部契约）：id 由数据层分配、整集合覆盖保存、
// 因此「同一套件被存成两条」在数据层不可能自发产生。
// 下面四条是**违反假设的输入**，不是 happy-path 的换皮：
//   A 同批两条空 id 且**不注入** createId → 默认生成器会不会撞车？
//   B 成员全是非法值 → normalize 后为空，会不会落一条「展开后什么都插不进草稿」的空套件？
//   C local- 前缀临时 id **泄漏**到数据层（client 侧忘了过 suitePayloadOf）→ 会不会分裂？
//   D 读回的文件原样再存 → round-trip 会不会漂移？
{
  // A：真实场景就是「一次新建两个套件再点保存」，两条的 id 都是空串。
  const rootA = await freshRoot();
  const twoNew = await saveSuites(
    [
      { id: "", name: "前端一条龙", members: ["frontend-design"] },
      { id: "", name: "调试一条龙", members: ["bug-diagnosis"] },
    ],
    { rootDir: rootA },
  );
  const idsA = twoNew.suites.map((s) => s.id);
  ok("反例 A：同批两条空 id 得到两个**不同**的真 id（默认生成器未撞车）", idsA.length === 2 && idsA[0] !== idsA[1], JSON.stringify(idsA));
  ok("反例 A：默认生成器给出 suite- 前缀且非空", idsA.every((id) => typeof id === "string" && id.startsWith("suite-")));

  // B：members 全非法 → normalizeMembers 折成空数组 → 必须走拒绝档而不是放行。
  const rootB = await freshRoot();
  const msgB = await expectThrow("反例 B：成员全是非法值（null/空串/数字/对象）→ 抛错，不落空套件", () =>
    saveSuites([{ id: "", name: "空壳套件", members: [null, "", 123, {}] }], { rootDir: rootB }),
  );
  ok("反例 B：拒绝文案点名「没有成员」（不是泛化报错）", msgB.includes("没有成员"), msgB);
  const dirB = await readdir(rootB);
  ok("反例 B：拒绝后零写入（目录里既无 suites.json 也无 .staging）", dirB.length === 0, JSON.stringify(dirB));

  // C：泄漏的 local- id 会被原样收下——数据层**不审查 id 形态**，归一是 client 侧
  // suitePayloadOf 的职责（该职责由 test/suites-client.mjs 第 1 节钉住）。
  // 这里要证的是：即便泄漏了，整集合覆盖也不会把它变成两条。
  const rootC = await freshRoot();
  const leaked = await saveSuites([{ id: "local-1", name: "泄漏套件", members: ["code-review"] }], { rootDir: rootC });
  ok("反例 C：泄漏的 local- id 被原样落盘（数据层不猜语义）", leaked.suites[0].id === "local-1");
  // 下一轮 UI 走对了：id 洗空 → 分配真 id。条数必须仍是 1（这就是「覆盖」挡住分裂的地方）。
  const healed = await saveSuites([{ id: "", name: "泄漏套件", members: ["code-review"] }], { rootDir: rootC });
  ok("反例 C：归一后再存**条数恒为 1**（整集合覆盖挡住了分裂）", healed.suites.length === 1, JSON.stringify(healed.suites.map((s) => s.id)));
  ok("反例 C：归一后 id 换成真 id（不再是 local- 前缀）", healed.suites[0].id.startsWith("suite-"), healed.suites[0].id);

  // D：读回 → 原样再存（不注入 createId，条目 id 非空所以不会走分配分支）→ 字节稳定。
  // 字节必须在**重存之前**取，否则两次读的是同一份文件，断言恒真。
  const back = await readSuites({ rootDir: rootC });
  const bytesBefore = await readFile(suitesPath({ rootDir: rootC }), "utf8");
  const resaved = await saveSuites(
    back.suites.map((s) => ({ ...s })),
    { rootDir: rootC },
  );
  const bytesAfter = await readFile(suitesPath({ rootDir: rootC }), "utf8");
  ok("反例 D：round-trip 后 id 不漂移", resaved.suites[0].id === back.suites[0].id);
  ok("反例 D：round-trip 后文件字节一致（createdAt/updatedAt 都未被擅自刷新）", bytesBefore === bytesAfter, `${bytesBefore.length}B → ${bytesAfter.length}B`);

  await rm(rootA, { recursive: true, force: true });
  await rm(rootB, { recursive: true, force: true });
  await rm(rootC, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "SUITES-REGISTRY PASS" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
