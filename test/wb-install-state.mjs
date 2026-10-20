// 安装状态 + 来源锁（lib/wb-install-state.js）的回归套件（T01）。
//
// 覆盖：record 首写/覆盖更新（installedAt 保留、lastUpdated 刷新）、connector 不记
// filesDigest、forget 精确删除、listInstalled 按 kind 全量筛选、原子写、防御解析。
//
// 隔离纪律：mkdtemp 临时目录 + options.rootDir 注入，绝不碰真实 ~/.dsh，零网络。
// 用法：node ./test/wb-install-state.mjs
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { record, forget, listInstalled, readState, statePath } =
  await import(new URL("../lib/wb-install-state.js", import.meta.url).href);

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

function freshRoot() {
  return mkdtemp(join(tmpdir(), "dsh-armory-state-"));
}

// ── 1. record 首次写入：补 installedAt / lastUpdated ────────────────────────
{
  const root = await freshRoot();
  await record({
    kind: "skill",
    key: "tencent-adm__tencent-docs",
    name: "腾讯文档",
    scope: "managed",
    installPath: "C:/fake/.agents/skills/tencent-adm__tencent-docs",
    version: "1.2.0",
    dependencies: [],
    source: { marketplace: "skillhub", url: "https://api.skillhub.cn/x", kind: "api" },
    filesDigest: { "SKILL.md": "deadbeef" },
  }, { rootDir: root });
  const items = await listInstalled("skill", { rootDir: root });
  ok("record 首写：条目入库", items.length === 1 && items[0].key === "tencent-adm__tencent-docs");
  ok("record 首写：installedAt/lastUpdated 补为当前时间（>0）", items[0].installedAt > 0 && items[0].lastUpdated > 0);
  ok("record 首写：source 来源锁完整保留", items[0].source.marketplace === "skillhub" && items[0].source.url === "https://api.skillhub.cn/x");
  ok("record 首写：plugin/skill 记录 filesDigest", items[0].filesDigest["SKILL.md"] === "deadbeef");
  ok("record 首写：缺 scope 防御补 managed", items[0].scope === "managed");
  await rm(root, { recursive: true, force: true });
}

// ── 2. record 同 kind+key 覆盖：刷新 lastUpdated、保留 installedAt ───────────
{
  const root = await freshRoot();
  await record({ kind: "plugin", key: "codebuddy-review", name: "Code Review", version: "0.9.0" }, { rootDir: root });
  const first = (await listInstalled("plugin", { rootDir: root }))[0];
  // 覆盖更新：换版本、换来源，installedAt 不应被刷新成新时间。
  await record({ kind: "plugin", key: "codebuddy-review", name: "Code Review", version: "1.0.0", source: { marketplace: "codebuddy-plugins-official" } }, { rootDir: root });
  const second = (await listInstalled("plugin", { rootDir: root }))[0];
  ok("record 覆盖：仍只有一条", (await listInstalled("plugin", { rootDir: root })).length === 1);
  ok("record 覆盖：version 已更新为 1.0.0", second.version === "1.0.0");
  ok("record 覆盖：installedAt 保留首次值", second.installedAt === first.installedAt, `${second.installedAt} vs ${first.installedAt}`);
  ok("record 覆盖：lastUpdated >= installedAt（刷新语义）", second.lastUpdated >= first.lastUpdated);

  // 同 key 不同 kind：不算同一条（key 空间按 kind 分区）。
  await record({ kind: "skill", key: "codebuddy-review", name: "同名技能" }, { rootDir: root });
  ok("record：同 key 不同 kind 是独立条目", (await listInstalled("skill", { rootDir: root })).length === 1);
  await rm(root, { recursive: true, force: true });
}

// ── 3. connector 不记 filesDigest ────────────────────────────────────────────
{
  const root = await freshRoot();
  await record({
    kind: "connector",
    key: "tencent-docs",
    name: "腾讯文档",
    scope: "managed",
    version: "1.0.1",
    source: { marketplace: "workbuddy-connectors", url: "https://static.workbuddy.cn/connectors-config-v2/connectors-config.zip", kind: "zip" },
    filesDigest: { "应该被丢掉.txt": "x" },
  }, { rootDir: root });
  const items = await listInstalled("connector", { rootDir: root });
  ok("connector 首写：filesDigest 强制为空对象", Object.keys(items[0].filesDigest).length === 0, JSON.stringify(items[0].filesDigest));
  // 覆盖时传 filesDigest 也必须被丢弃。
  await record({ kind: "connector", key: "tencent-docs", name: "腾讯文档", version: "1.0.2", filesDigest: { "还是不行": "y" } }, { rootDir: root });
  const updated = (await listInstalled("connector", { rootDir: root }))[0];
  ok("connector 覆盖：filesDigest 仍为空", Object.keys(updated.filesDigest).length === 0);
  await rm(root, { recursive: true, force: true });
}

// ── 4. forget：精确删除 + 无害空操作 + 显式报错 ──────────────────────────────
{
  const root = await freshRoot();
  await record({ kind: "connector", key: "a" }, { rootDir: root });
  await record({ kind: "connector", key: "b" }, { rootDir: root });
  await record({ kind: "skill", key: "a" }, { rootDir: root });
  await forget("connector", "a", { rootDir: root });
  const connectors = await listInstalled("connector", { rootDir: root });
  ok("forget：目标条目消失", !connectors.some((item) => item.key === "a"));
  ok("forget：同 kind 其它条目不受影响", connectors.length === 1 && connectors[0].key === "b");
  ok("forget：不同 kind 的同名 key 不被误删", (await listInstalled("skill", { rootDir: root })).length === 1);
  await forget("connector", "ghost", { rootDir: root });
  ok("forget 不存在条目：无害空操作", (await listInstalled("connector", { rootDir: root })).length === 1);
  let threw = false;
  try {
    await forget("", "a", { rootDir: root });
  } catch {
    threw = true;
  }
  ok("forget 缺 kind：显式抛错", threw);
  await rm(root, { recursive: true, force: true });
}

// ── 5. listInstalled / readState 防御解析 ────────────────────────────────────
{
  const root = await freshRoot();
  // 文件不存在：空状态不抛错。
  ok("无文件：listInstalled 返回空数组", (await listInstalled("connector", { rootDir: root })).length === 0);
  ok("无文件：readState 返回 version+空 items", (await readState({ rootDir: root })).version === 1);
  // 损坏 JSON：同途回落。
  const { writeFile } = await import("node:fs/promises");
  await writeFile(statePath({ rootDir: root }), "not json at all {{{");
  ok("损坏 JSON：回落空状态", (await listInstalled("plugin", { rootDir: root })).length === 0);
  // items 里混入畸形元素：被过滤，不炸。
  await writeFile(statePath({ rootDir: root }), JSON.stringify({ version: 1, items: [null, 42, { kind: "skill", key: "survivor" }] }));
  const skills = await listInstalled("skill", { rootDir: root });
  ok("畸形条目被过滤，合法条目保留", skills.length === 1 && skills[0].key === "survivor");
  // 未知 kind 一律空。
  ok("listInstalled 未知 kind：空数组", (await listInstalled("widget", { rootDir: root })).length === 0);
  await rm(root, { recursive: true, force: true });
}

// ── 6. record 防御解析：缺 key 显式报错、畸形字段补全 ────────────────────────
{
  const root = await freshRoot();
  let threw = false;
  try {
    await record({ kind: "skill", key: "   " }, { rootDir: root });
  } catch {
    threw = true;
  }
  ok("record 缺 key：显式抛错", threw);
  await record({ kind: "widget", key: "x", dependencies: "not-array", source: null, installedAt: -5 }, { rootDir: root });
  const items = await readState({ rootDir: root });
  const row = items.items.find((item) => item.key === "x");
  ok("record 畸形字段：kind 回落 connector、dependencies 补空数组、source 折成空对象",
    row.kind === "connector" && Array.isArray(row.dependencies) && row.dependencies.length === 0
    && row.source.marketplace === "");
  ok("record 首写畸形时间戳：installedAt 被 record 补成 now（畸形值 -5 不会入库）", row.installedAt > 0);
  await rm(root, { recursive: true, force: true });
}

// ── 7. 原子写：staging 不残留 + 文件内容可回读 ───────────────────────────────
{
  const root = await freshRoot();
  await record({ kind: "skill", key: "persist-me", name: "留存" }, { rootDir: root });
  const entries = await readdir(root);
  ok("原子写：目录里没有 .staging 残留", !entries.some((name) => name.endsWith(".staging")), entries.join(","));
  const onDisk = JSON.parse(await readFile(statePath({ rootDir: root }), "utf8"));
  ok("原子写：install-state.json 落盘且 version=1", onDisk.version === 1 && onDisk.items.some((item) => item.key === "persist-me"));
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "WB-INSTALL-STATE PASS" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
