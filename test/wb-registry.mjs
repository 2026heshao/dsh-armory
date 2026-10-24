// 多市场注册表（lib/wb-registry.js）的回归套件（T01）。
//
// 覆盖：内置默认回落（无文件/损坏 JSON/畸形结构）、合并投影（用户条目追加、
// 同 id 覆盖内置）、upsert/remove 增删改、sourceFor 优先序、原子写、防御解析。
// 2026-10-24 起 CodeBuddy 插件市场整体移除：注册表只剩 connectors 一类内置默认，
// 旧的 kind="plugins" 条目读侧丢弃、写侧拒绝（本套件把它们钉进用例）。
//
// 隔离纪律：全程用 mkdtemp 临时目录 + options.rootDir 注入，绝不碰真实 ~/.dsh，
// 也绝不清 process.env.DSH_ARMORY_HOME 以外的任何环境（不联网、零 fetch）。
// 用法：node ./test/wb-registry.mjs
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { readRegistry, upsertMarketplace, removeMarketplace, sourceFor, registryPath, builtinMarketplaces, normalizeEntry } =
  await import(new URL("../lib/wb-registry.js", import.meta.url).href);

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

/** 每个用例独立临时根目录（互不渗漏）。 */
function freshRoot() {
  return mkdtemp(join(tmpdir(), "dsh-armory-reg-"));
}

// ── 1. 无文件：只剩 connectors 一条内置默认 + 首读落盘 ──────────────────────
{
  const root = await freshRoot();
  const doc = await readRegistry({ rootDir: root });
  ok("无文件回落：marketplaces 有且仅有 1 条内置默认（connectors）",
    doc.version === 1 && doc.marketplaces.length === 1, `n=${doc.marketplaces.length}`);
  const connectors = doc.marketplaces.find((m) => m.kind === "connectors");
  ok("内置 connectors 源 URL 与 lib/wb-market.js:27 现值一致",
    connectors?.id === "workbuddy-connectors"
    && connectors?.source.url === "https://static.workbuddy.cn/connectors-config-v2/connectors-config.zip",
    connectors?.source.url);
  ok("内置 connectors 清单路径为 .codebuddy-connector/connectors.json", connectors?.manifestPath === ".codebuddy-connector/connectors.json");
  ok("内置条目 addedAt/lastUpdated 缺省补 0", connectors?.addedAt === 0 && connectors?.lastUpdated === 0);
  ok("CodeBuddy 插件市场默认项不再回归", !doc.marketplaces.some((m) => m.kind === "plugins"));
  // 首读落盘：文件必须真实存在且内容与投影一致。
  const onDisk = JSON.parse(await readFile(registryPath({ rootDir: root }), "utf8"));
  ok("首读落盘：marketplaces.json 已写入且 version=1、仅 1 条",
    onDisk.version === 1 && Array.isArray(onDisk.marketplaces) && onDisk.marketplaces.length === 1);
  await rm(root, { recursive: true, force: true });
}

// ── 2. 损坏文件 / 畸形结构：回落内置默认，不抛错 ─────────────────────────────
{
  const root = await freshRoot();
  await writeFile(registryPath({ rootDir: root }), "{ 这不是 JSON");
  const doc = await readRegistry({ rootDir: root });
  ok("损坏 JSON 回落内置默认且不抛错", doc.marketplaces.length === 1 && doc.version === 1);
  await rm(root, { recursive: true, force: true });
}
{
  const root = await freshRoot();
  await writeFile(registryPath({ rootDir: root }), JSON.stringify({ version: 1, marketplaces: "not-an-array", junk: 1 }));
  const doc = await readRegistry({ rootDir: root });
  ok("marketplaces 非数组回落内置默认", doc.marketplaces.length === 1);
  await rm(root, { recursive: true, force: true });
}
{
  const root = await freshRoot();
  // 条目畸形（null / 数组 / 缺 id）被防御性过滤或补全；旧 plugins 条目整条丢弃。
  await writeFile(registryPath({ rootDir: root }), JSON.stringify({
    marketplaces: [
      null,
      [],
      { kind: "connectors", id: "" },
      { kind: "plugins", id: "user-plugin", source: { url: "https://example.invalid/p.zip" } },
      { kind: "connectors", id: "user-connector", source: { url: "https://example.invalid/c.zip" } },
    ],
  }));
  const doc = await readRegistry({ rootDir: root });
  ok("畸形条目被防御补全：缺 id 保留空串但结构完整",
    doc.marketplaces.some((m) => m.id === "" && m.kind === "connectors" && typeof m.source === "object"));
  ok("旧 plugins 条目在读侧被丢弃（不会伪装成 connectors）",
    !doc.marketplaces.some((m) => m.id === "user-plugin"));
  ok("正常的用户 connectors 条目按原样保留并追加在默认项之后",
    doc.marketplaces[doc.marketplaces.length - 1]?.id === "user-connector");
  await rm(root, { recursive: true, force: true });
}

// ── 3. 合并投影：文件条目覆盖同 id 内置默认 ─────────────────────────────────
{
  const root = await freshRoot();
  await writeFile(registryPath({ rootDir: root }), JSON.stringify({
    version: 1,
    marketplaces: [{
      id: "workbuddy-connectors",
      kind: "connectors",
      type: "zip",
      source: { url: "https://mirror.example.invalid/connectors.zip" },
      isBuiltIn: true,
      description: "镜像源",
    }],
  }));
  const doc = await readRegistry({ rootDir: root });
  const connectors = doc.marketplaces.filter((m) => m.kind === "connectors");
  ok("文件内同 id 条目覆盖内置默认（仅 1 条 connectors）", connectors.length === 1, `n=${connectors.length}`);
  ok("覆盖后的源 URL 是文件里的镜像值", connectors[0]?.source.url === "https://mirror.example.invalid/connectors.zip");
  ok("覆盖后 description 为文件值", connectors[0]?.description === "镜像源");
  ok("投影里不存在 plugins 默认项", doc.marketplaces.filter((m) => m.kind === "plugins").length === 0);
  await rm(root, { recursive: true, force: true });
}

// ── 4. upsert：新增 + 覆盖 + addedAt/lastUpdated 语义 + 拒绝已下线类型 ───────
{
  const root = await freshRoot();
  const afterAdd = await upsertMarketplace({
    id: "my-connectors",
    kind: "connectors",
    type: "zip",
    source: { url: "https://example.invalid/my.zip" },
    manifestPath: "connectors.json",
  }, { rootDir: root });
  const added = afterAdd.marketplaces.find((m) => m.id === "my-connectors");
  ok("upsert 新增：条目出现在合并投影", !!added && added.source.url === "https://example.invalid/my.zip");
  ok("upsert 新增：addedAt 被补上（>0）", (added?.addedAt ?? 0) > 0);
  ok("upsert 新增：isBuiltIn 缺省为 false", added?.isBuiltIn === false);
  ok("upsert 新增：autoUpdate 缺省为 false（DSH 永不静默更新）", added?.autoUpdate === false);

  const afterUpdate = await upsertMarketplace({
    id: "my-connectors",
    kind: "connectors",
    type: "zip",
    source: { url: "https://example.invalid/my-v2.zip" },
  }, { rootDir: root });
  const updated = afterUpdate.marketplaces.filter((m) => m.id === "my-connectors");
  ok("upsert 覆盖：同 id 不产生第二条", updated.length === 1, `n=${updated.length}`);
  ok("upsert 覆盖：源 URL 已更新", updated[0]?.source.url === "https://example.invalid/my-v2.zip");
  ok("upsert 覆盖：addedAt 保留首次值", updated[0]?.addedAt === added.addedAt);

  // 缺 id 的 upsert 必须显式报错（数据层契约，不是静默吞掉）。
  let threw = false;
  try {
    await upsertMarketplace({ kind: "connectors" }, { rootDir: root });
  } catch {
    threw = true;
  }
  ok("upsert 缺 id：显式抛错", threw);

  // 已下线的 plugins 类型：写侧必须拒绝，而不是回落成 connectors。
  let rejected = null;
  try {
    await upsertMarketplace({ id: "sneaky", kind: "plugins", source: { url: "https://example.invalid/p.zip" } }, { rootDir: root });
  } catch (error) {
    rejected = error;
  }
  ok("upsert plugins 类型：显式抛错且文案点名已移除",
    rejected instanceof Error && rejected.message.includes("CodeBuddy") && rejected.message.includes("plugins"),
    rejected?.message);
  const afterReject = await readRegistry({ rootDir: root });
  ok("upsert 被拒后：投影里没有 sneaky，也没有 plugins 条目",
    !afterReject.marketplaces.some((m) => m.id === "sneaky" || m.kind === "plugins"));

  // 文件里残留的旧 plugins 条目，任何一次写盘都要被清掉。
  const raw = JSON.parse(await readFile(registryPath({ rootDir: root }), "utf8"));
  raw.marketplaces.push({ id: "legacy-plugin", kind: "plugins", source: { url: "https://example.invalid/old.zip" } });
  await writeFile(registryPath({ rootDir: root }), JSON.stringify(raw));
  await upsertMarketplace({ id: "another-connector", kind: "connectors", source: { url: "https://example.invalid/n.zip" } }, { rootDir: root });
  const persisted = JSON.parse(await readFile(registryPath({ rootDir: root }), "utf8"));
  ok("写盘：文件里残留的旧 plugins 条目被清除",
    !persisted.marketplaces.some((m) => m.kind === "plugins" || m.id === "legacy-plugin"));
  await rm(root, { recursive: true, force: true });
}

// ── 5. remove：删除用户条目 / 恢复内置默认覆盖 / 清掉旧 plugins ─────────────
{
  const root = await freshRoot();
  await upsertMarketplace({ id: "temp-market", kind: "connectors", type: "zip", source: { url: "https://example.invalid/t.zip" } }, { rootDir: root });
  const afterRemove = await removeMarketplace("temp-market", { rootDir: root });
  ok("remove 删除用户条目：投影中消失", !afterRemove.marketplaces.some((m) => m.id === "temp-market"));

  // 删除内置同 id 的覆盖记录 → 内置默认回归。
  await upsertMarketplace({ id: "workbuddy-connectors", kind: "connectors", type: "zip", source: { url: "https://mirror.example.invalid/connectors.zip" } }, { rootDir: root });
  const restored = await removeMarketplace("workbuddy-connectors", { rootDir: root });
  const connectors = restored.marketplaces.filter((m) => m.kind === "connectors");
  ok("remove 覆盖记录后内置默认回归",
    connectors.length === 1 && connectors[0]?.source.url.includes("static.workbuddy.cn"));

  // 不存在的 id：无害空操作。
  const noop = await removeMarketplace("ghost-id", { rootDir: root });
  ok("remove 不存在的 id：无害空操作（投影不变）", noop.marketplaces.length === restored.marketplaces.length);

  // 缺 id 显式报错。
  let threw = false;
  try {
    await removeMarketplace("", { rootDir: root });
  } catch {
    threw = true;
  }
  ok("remove 缺 id：显式抛错", threw);
  await rm(root, { recursive: true, force: true });
}

// ── 6. sourceFor：kind 第一条 + 已下线 kind 恒 null ────────────────────────
{
  const root = await freshRoot();
  const connectors = await sourceFor("connectors", { rootDir: root });
  const plugins = await sourceFor("plugins", { rootDir: root });
  ok("sourceFor(connectors)：内置默认（无用户条目时）", connectors?.id === "workbuddy-connectors");
  ok("sourceFor(plugins)：null（插件源已移除）", plugins === null);
  // 用户先加一条 connectors：合并序 = 默认项优先，仍取内置第一条。
  await upsertMarketplace({ id: "user-conn", kind: "connectors", type: "zip", source: { url: "https://example.invalid/u.zip" } }, { rootDir: root });
  const stillBuiltin = await sourceFor("connectors", { rootDir: root });
  ok("sourceFor 取该 kind 第一条（默认项优先）", stillBuiltin?.id === "workbuddy-connectors");
  const ghost = await sourceFor("skills", { rootDir: root });
  ok("sourceFor 未知 kind：null（不抛错）", ghost === null);
  await rm(root, { recursive: true, force: true });
}

// ── 7. 原子写：staging 临时文件不残留 ────────────────────────────────────────
{
  const root = await freshRoot();
  await upsertMarketplace({ id: "a", kind: "connectors", type: "zip", source: { url: "https://example.invalid/a.zip" } }, { rootDir: root });
  const entries = await readdir(root);
  ok("原子写：目录里没有 .staging 残留", !entries.some((name) => name.endsWith(".staging")), entries.join(","));
  ok("原子写：marketplaces.json 在场", entries.includes("marketplaces.json"));
  await rm(root, { recursive: true, force: true });
}

// ── 8. normalizeEntry / builtinMarketplaces 纯函数防御 ──────────────────────
{
  const normalized = normalizeEntry(null);
  ok("normalizeEntry(null)：返回完整默认结构",
    normalized.id === "" && normalized.kind === "connectors" && normalized.type === "zip" && normalized.addedAt === 0);
  const weird = normalizeEntry({ id: " x ", kind: "widgets", type: "tar", source: "nope", addedAt: "later", autoUpdate: "yes" });
  ok("normalizeEntry 畸形字段：kind 回落 connectors、type 回落 zip、时间戳补 0",
    weird.id === "x" && weird.kind === "connectors" && weird.type === "zip" && weird.addedAt === 0 && weird.autoUpdate === false);
  // 两次调用返回不同数组对象（深比较相等即可），防止调用方意外共享可变引用。
  const builtinsA = builtinMarketplaces();
  const builtinsB = builtinMarketplaces();
  ok("builtinMarketplaces 每次返回新数组（防外部污染）",
    builtinsA !== builtinsB && JSON.stringify(builtinsA) === JSON.stringify(builtinsB));
  ok("builtinMarketplaces 只剩 connectors 一条", builtinsA.length === 1 && builtinsA[0].kind === "connectors");
}

console.log(`\n${failures === 0 ? "WB-REGISTRY PASS" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
