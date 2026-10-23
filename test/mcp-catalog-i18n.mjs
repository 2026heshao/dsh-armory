// P1：内置 MCP 目录的 en-US 覆盖（lib/mcp-catalog-en.js）。
//
// mcp-catalog.js 是生成文件（来源 YAML + scripts/build-catalog.mjs 未随本仓库分发），
// 所以英文不能直接写进去：下次生成会被冲掉。覆盖表与生成目录分开，由 mcp-config.js
// 投影、builtins RPC 随条目一起送中英字段、客户端按 locale 选择。
//
// 这里钉住「目录新增一条，英文不可能悄悄缺」：
//   1. 47 个 id、10 个分类一一对应；多余/缺失都失败；
//   2. summary / access 必有英文且无 CJK；中文有 authNote 时英文也必须有；
//   3. 中文 label 必须有 labelEn（否则英文面板里冒出「DeepWiki（本地抓取）」）；
//   4. builtinMcpCatalog 真的带上了全部英文字段，且 installation configuration
//      没有泄漏任何展示字段（builtinSpec 白名单是安全边界，不是格式偏好）；
//   5. 客户端 localizeBuiltinItem 能用真实目录行选出完整英文。
//
// 反向自测：把覆盖表里的 deepwiki-fetch 英文删掉，parity 断言必须变红；
// 把客户端 helper 的 `summaryEn ||` 去掉，英文摘要断言必须变红。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { MCP_CATALOG, CATEGORY_ORDER } from "../lib/mcp-catalog.js";
import { MCP_CATALOG_EN, CATEGORY_LABELS_EN, CATALOG_LABELS_EN } from "../lib/mcp-catalog-en.js";
import { builtinMcpCatalog } from "../lib/mcp-config.js";

const here = dirname(fileURLToPath(import.meta.url));
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};
const info = (name, extra = "") => console.log(`INFO  ${name}${extra ? `  ${extra}` : ""}`);

const catalogIds = MCP_CATALOG.map((entry) => entry.id);
const overlayIds = Object.keys(MCP_CATALOG_EN);

// ── 1. 覆盖表与生成目录的 id / 分类一一对应 ────────────────────────────────
const missingIds = catalogIds.filter((id) => !MCP_CATALOG_EN[id]);
const orphanIds = overlayIds.filter((id) => !catalogIds.includes(id));
ok("目录里每个 id 都有英文覆盖", missingIds.length === 0, missingIds.length ? `缺=${JSON.stringify(missingIds)}` : "");
ok("英文覆盖里没有目录中不存在的孤儿 id", orphanIds.length === 0, orphanIds.length ? `孤儿=${JSON.stringify(orphanIds)}` : "");
const missingCategories = CATEGORY_ORDER.filter((key) => !CATEGORY_LABELS_EN[key]);
const orphanCategories = Object.keys(CATEGORY_LABELS_EN).filter((key) => !CATEGORY_ORDER.includes(key));
ok("10 个分类都有英文标签，且没有多余分类",
  missingCategories.length === 0 && orphanCategories.length === 0,
  `缺=${JSON.stringify(missingCategories)} 孤儿=${JSON.stringify(orphanCategories)}`);
info("目录规模", `${catalogIds.length} 个服务 / ${CATEGORY_ORDER.length} 个分类`);

// ── 2. 每条文案都有真英文，且没有 CJK ──────────────────────────────────────
const textProblems = [];
const cjkProblems = [];
for (const entry of MCP_CATALOG) {
  const en = MCP_CATALOG_EN[entry.id];
  if (!en) continue;
  for (const field of ["summary", "access"]) {
    if (typeof en[field] !== "string" || !en[field].trim()) textProblems.push(`${entry.id}.${field} 缺失`);
    else if (CJK.test(en[field])) cjkProblems.push(`${entry.id}.${field}`);
  }
  if (entry.authNote) {
    if (typeof en.authNote !== "string" || !en.authNote.trim()) textProblems.push(`${entry.id}.authNote 缺失`);
    else if (CJK.test(en.authNote)) cjkProblems.push(`${entry.id}.authNote`);
  }
  if (en.summary === entry.summary) textProblems.push(`${entry.id}.summary 与中文相同（恒等 = 没翻）`);
  if (en.access === entry.access) textProblems.push(`${entry.id}.access 与中文相同（恒等 = 没翻）`);
}
ok("summary / access / 有中文 authNote 时都有英文，且不是中文原文", textProblems.length === 0,
  textProblems.length ? `问题=${JSON.stringify(textProblems.slice(0, 8))}` : "");
ok("所有英文目录文案没有 CJK", cjkProblems.length === 0,
  cjkProblems.length ? `含中文=${JSON.stringify(cjkProblems.slice(0, 8))}` : "");

const labelProblems = [];
for (const entry of MCP_CATALOG) {
  if (CJK.test(entry.label) && !CATALOG_LABELS_EN[entry.id]) labelProblems.push(entry.id);
}
for (const [id, label] of Object.entries(CATALOG_LABELS_EN)) {
  if (!catalogIds.includes(id)) labelProblems.push(`孤儿 label:${id}`);
  if (CJK.test(label)) labelProblems.push(`含中文 label:${id}`);
}
ok("中文品牌名都有英文 label，且覆盖面没有孤儿/中文", labelProblems.length === 0,
  labelProblems.length ? `问题=${JSON.stringify(labelProblems)}` : "");
const categoryCjk = Object.entries(CATEGORY_LABELS_EN).filter(([, label]) => CJK.test(label)).map(([key]) => key);
ok("分类英文标签没有 CJK", categoryCjk.length === 0, categoryCjk.length ? `含中文=${JSON.stringify(categoryCjk)}` : "");

// ── 3. builtins 投影：英文字段随 RPC 到达，且不污染安装配置 ────────────────
const rows = builtinMcpCatalog([]);
ok("builtinMcpCatalog 返回与目录等量的行", rows.length === MCP_CATALOG.length, `rows=${rows.length}`);
const projectionProblems = [];
for (const row of rows) {
  for (const field of ["labelEn", "summaryEn", "accessEn", "categoryLabelEn"]) {
    if (typeof row[field] !== "string" || !row[field].trim()) projectionProblems.push(`${row.id}.${field}`);
  }
  const source = MCP_CATALOG.find((entry) => entry.id === row.id);
  if (source?.authNote && (typeof row.authNoteEn !== "string" || !row.authNoteEn.trim())) {
    projectionProblems.push(`${row.id}.authNoteEn`);
  }
  if (!source?.authNote && "authNoteEn" in row) projectionProblems.push(`${row.id}.authNoteEn（不应存在）`);
  // 安装配置是白名单投影：英文展示字段绝不能漏进用户配置文件。
  for (const field of ["labelEn", "summaryEn", "accessEn", "authNoteEn", "categoryLabelEn", "summary", "access", "authNote"]) {
    if (field in (row.configuration || {})) projectionProblems.push(`${row.id}.configuration.${field} 泄漏`);
  }
}
ok("每行都带 labelEn/summaryEn/accessEn/categoryLabelEn（authNoteEn 与中文同生同灭）",
  projectionProblems.length === 0, projectionProblems.length ? `问题=${JSON.stringify(projectionProblems.slice(0, 8))}` : "");
const deepwiki = rows.find((row) => row.id === "deepwiki-fetch");
ok("中文品牌名在 RPC 里同时有中英 label",
  deepwiki && CJK.test(deepwiki.label) && deepwiki.labelEn === "DeepWiki (local fetch)",
  deepwiki ? `${deepwiki.label} / ${deepwiki.labelEn}` : "缺行");
const github = rows.find((row) => row.id === "github");
ok("authNoteEn 随条目送达（github）", github && /PAT/.test(github.authNoteEn || ""), github?.authNoteEn);

// ── 4. 客户端 helper 用真实目录行选出完整英文 ──────────────────────────────
const CLIENT = join(here, "..", "lib", "client.js");
const source = await readFile(CLIENT, "utf8");
const START = "const localizeBuiltinItem = (item, english = usesEnglish()) => {";
const END = "// ── 旧插件名 → 新插件名的 localStorage 键迁移";
const startAt = source.indexOf(START);
const endAt = source.indexOf(END, startAt + START.length);
ok("能定位客户端 localizeBuiltinItem", startAt >= 0 && endAt > startAt, `start=${startAt} end=${endAt}`);
if (startAt >= 0 && endAt > startAt) {
  function loadHelper(code) {
    const context = { console };
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(`${code}\nglobalThis.__probe = { localizeBuiltinItem };`, context, { filename: "builtin-localizer.js" });
    return context.__probe;
  }
  const helper = loadHelper(source.slice(startAt, endAt));
  const localized = helper.localizeBuiltinItem(deepwiki, true);
  ok("英文模式：真实 deepwiki-fetch 行的 label/summary/access/category 全部变英文",
    localized.label === "DeepWiki (local fetch)"
    && localized.summary === MCP_CATALOG_EN["deepwiki-fetch"].summary
    && localized.access === MCP_CATALOG_EN["deepwiki-fetch"].access
    && localized.categoryLabel === CATEGORY_LABELS_EN[deepwiki.category],
    `${localized.label} / ${localized.categoryLabel}`);
  ok("英文模式：authNote 存在时选 authNoteEn（github）",
    helper.localizeBuiltinItem(github, true).authNote === MCP_CATALOG_EN.github.authNote);
  ok("中文模式：返回原对象（不做无意义拷贝）", helper.localizeBuiltinItem(deepwiki, false) === deepwiki);

  // 反向自测：去掉 summaryEn 选择后，英文行必须退回中文摘要。
  const original = source.slice(startAt, endAt);
  const mutated = original.replace(
    "...(item.summaryEn ? { summary: item.summaryEn } : {}),",
    "...(false ? { summary: item.summaryEn } : {}),",
  );
  ok("自测前置：成功改坏 summary 选择", mutated !== original);
  if (mutated !== original) {
    const broken = loadHelper(mutated);
    ok("自测：改坏后英文行退回中文摘要（证明第 4 节不是恒真）",
      broken.localizeBuiltinItem(deepwiki, true).summary === deepwiki.summary);
  }
}

// ── 5. 覆盖表本身的反向自测：删一条，parity 检查必须抓到 ──────────────────
{
  const mutated = { ...MCP_CATALOG_EN };
  delete mutated["deepwiki-fetch"];
  const missing = catalogIds.filter((id) => !mutated[id]);
  ok("自测：删掉一条覆盖后缺失检查会变红", missing.includes("deepwiki-fetch") && missing.length === 1);
}

console.log(`\n${failures === 0 ? "MCP-CATALOG-I18N PASS" : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
