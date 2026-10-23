// P1：应用内更新日志的 en-US 覆盖（lib/whats-new-en.js）与客户端选择逻辑。
//
// 为什么单独测：更新日志是**数据**，不是 client.js 里的 t() 字面量——字典覆盖率
// 套件看不到它。少一条英文，英文用户就会在「本次更新」弹窗里看到中文；而
// whats-new.js 的发版契约（最后一条 = package.json）由 upgrade-plan 守着，不能
// 为了翻译去动它的顺序或形状。这里钉四件事：
//   1. 每个版本、每个条目都有对应英文，且英文里没有 CJK（没翻干净 = 没翻）；
//   2. 中文 where 有值时必须给 whereEn（否则英文正文配中文指路）；
//   3. attachWhatsNewEnglish 只追加 textEn/whereEn，不改中文源与顺序；
//   4. 客户端 localizeWhatsNewEntries 在英文下选英文、中文下选中文、缺译文逐条回落，
//      且弹窗真的调用它（不是只写了个 helper 没人用）。
//
// 反向自测：把 helper 的 `item.textEn || item.text` 改回 `item.text`，行为断言必须变红。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { WHATS_NEW } from "../lib/whats-new.js";
import { WHATS_NEW_EN, attachWhatsNewEnglish } from "../lib/whats-new-en.js";

const here = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(here, "..", "lib", "client.js");
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};
const info = (name, extra = "") => console.log(`INFO  ${name}${extra ? `  ${extra}` : ""}`);

// ── 1. 覆盖表与中文源逐版本、逐条对齐 ───────────────────────────────────────
const zhVersions = WHATS_NEW.map((entry) => entry.version);
const enVersions = Object.keys(WHATS_NEW_EN);
ok("英文覆盖的版本与 whats-new.js 完全一致（顺序 + 数量）",
  zhVersions.join(",") === enVersions.join(","),
  `zh=${zhVersions.length} en=${enVersions.length}`);

let itemCount = 0;
const shapeProblems = [];
const cjkProblems = [];
for (const entry of WHATS_NEW) {
  const translated = WHATS_NEW_EN[entry.version];
  if (!Array.isArray(translated)) {
    shapeProblems.push(`${entry.version}: 缺整个版本`);
    continue;
  }
  if (translated.length !== entry.items.length) {
    shapeProblems.push(`${entry.version}: ${entry.items.length} 中文 / ${translated.length} 英文`);
  }
  entry.items.forEach((item, index) => {
    itemCount += 1;
    const en = translated[index];
    if (!en) return;
    if (typeof en.text !== "string" || !en.text.trim()) shapeProblems.push(`${entry.version}[${index}]: text 为空`);
    else if (CJK.test(en.text)) cjkProblems.push(`${entry.version}[${index}] text`);
    if (item.where && (typeof en.where !== "string" || !en.where.trim())) shapeProblems.push(`${entry.version}[${index}]: 缺 whereEn`);
    if (en.where) {
      if (!item.where) shapeProblems.push(`${entry.version}[${index}]: 中文无 where 但英文有`);
      if (CJK.test(en.where)) cjkProblems.push(`${entry.version}[${index}] where`);
    }
  });
}
info("条目总数", `${itemCount}`);
ok("每个条目都有对应英文 text，中文 where 有值时有 whereEn", shapeProblems.length === 0,
  shapeProblems.length ? `问题=${JSON.stringify(shapeProblems.slice(0, 8))}` : "");
ok("英文 text / where 里没有 CJK（没翻干净等价于没翻）", cjkProblems.length === 0,
  cjkProblems.length ? `含中文=${JSON.stringify(cjkProblems.slice(0, 8))}` : "");
ok("覆盖表没有多余版本（防止改了版本号忘删旧表）",
  Object.keys(WHATS_NEW_EN).every((version) => zhVersions.includes(version)));

// ── 2. attachWhatsNewEnglish：只追加字段，不改源数据 ────────────────────────
const attached = attachWhatsNewEnglish(WHATS_NEW);
ok("attach 后版本/条目顺序与中文源一致",
  attached.length === WHATS_NEW.length
  && attached.every((entry, i) => entry.version === WHATS_NEW[i].version && entry.items.length === WHATS_NEW[i].items.length));
ok("attach 不改中文 text / where",
  attached.every((entry, i) => entry.items.every((item, j) => item.text === WHATS_NEW[i].items[j].text && item.where === WHATS_NEW[i].items[j].where)));
ok("attach 给每条挂上 textEn，有 where 的挂上 whereEn",
  attached.every((entry, i) => entry.items.every((item, j) => item.textEn === WHATS_NEW_EN[entry.version][j].text
    && (!WHATS_NEW[i].items[j].where || item.whereEn === WHATS_NEW_EN[entry.version][j].where))));
ok("attach 不修改原数组（纯函数）",
  !("textEn" in WHATS_NEW[0].items[0]) && attached[0].items[0].textEn !== undefined);

// 缺译文的运行时回落：合成一个覆盖表里没有的版本，必须保留中文、不产生空字符串。
const fallback = attachWhatsNewEnglish([{ version: "0.0.0", items: [{ text: "中文条目", where: "中文指路" }] }]);
ok("缺英文覆盖时逐条回落中文（不渲染 undefined/空串）",
  fallback[0].items[0].text === "中文条目"
  && fallback[0].items[0].textEn === undefined
  && fallback[0].items[0].where === "中文指路"
  && fallback[0].items[0].whereEn === undefined);

// ── 3. 客户端选择逻辑：抽源码真跑 ───────────────────────────────────────────
const source = await readFile(CLIENT, "utf8");
const START = "// ── P1：数据型英文覆盖（更新日志 / 内置 MCP 目录）";
const END = "// ── 旧插件名 → 新插件名的 localStorage 键迁移";
const startAt = source.indexOf(START);
const endAt = source.indexOf(END, startAt + START.length);
ok("能在 client.js 定位数据型英文覆盖一节", startAt >= 0 && endAt > startAt, `start=${startAt} end=${endAt}`);
if (startAt < 0 || endAt <= startAt) {
  console.log("\nWHATS-NEW-I18N FAIL（标记缺失，无法继续）");
  process.exit(1);
}
const helperSource = source.slice(startAt, endAt);

function loadHelpers(code = helperSource) {
  const context = { console };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(`${code}\nglobalThis.__probe = { localizeWhatsNewEntries, localizeBuiltinItem };`, context, { filename: "overlay-helpers.js" });
  return context.__probe;
}
const helpers = loadHelpers();

const sample = [{
  version: "9.9.9",
  items: [
    { text: "中文正文", textEn: "English body", where: "中文位置", whereEn: "English location" },
    { text: "只有中文", where: "只有中文位置" },
  ],
}];
const english = helpers.localizeWhatsNewEntries(sample, true);
ok("英文模式：有 textEn/whereEn 的条目选英文",
  english[0].items[0].text === "English body" && english[0].items[0].where === "English location");
ok("英文模式：缺译文的条目逐条回落中文",
  english[0].items[1].text === "只有中文" && english[0].items[1].where === "只有中文位置");
const chinese = helpers.localizeWhatsNewEntries(sample, false);
ok("中文模式：始终使用中文（即使带了英文）",
  chinese[0].items[0].text === "中文正文" && chinese[0].items[0].where === "中文位置");

const builtinSample = {
  label: "中文名", labelEn: "English name",
  summary: "中文摘要", summaryEn: "English summary",
  access: "中文接入", accessEn: "English access",
  authNote: "中文说明", authNoteEn: "English note",
  categoryLabel: "中文分类", categoryLabelEn: "English category",
};
const builtinEn = helpers.localizeBuiltinItem(builtinSample, true);
ok("内置目录英文模式：label/summary/access/authNote/categoryLabel 全部选英文",
  builtinEn.label === "English name" && builtinEn.summary === "English summary"
  && builtinEn.access === "English access" && builtinEn.authNote === "English note"
  && builtinEn.categoryLabel === "English category");
const builtinZh = helpers.localizeBuiltinItem(builtinSample, false);
ok("内置目录中文模式：保持中文原字段", builtinZh === builtinSample);
const partial = helpers.localizeBuiltinItem({ summary: "中文摘要", access: "中文接入" }, true);
ok("内置目录缺英文字段时逐字段回落中文",
  partial.summary === "中文摘要" && partial.access === "中文接入"
  && !("authNote" in partial) && !("categoryLabel" in partial));

// ── 4. 接线断言：helper 必须真的被弹窗调用 ─────────────────────────────────
const modalStart = source.indexOf("const WhatsNewModal = ({ call }) => {");
const modalEnd = source.indexOf("// ── 数据型英文覆盖", modalStart) >= 0
  ? source.length
  : source.indexOf("\n};", modalStart);
const modalBlock = source.slice(modalStart, modalEnd > modalStart ? modalEnd : source.length);
ok("WhatsNewModal 订阅 i18n 变化并重渲染", /useI18nRevision\(\)/.test(modalBlock));
ok("WhatsNewModal 在渲染期调用 localizeWhatsNewEntries(notice.entries)",
  /localizeWhatsNewEntries\(notice\.entries\)/.test(modalBlock) && /localizedEntries\.map\(/.test(modalBlock));

// ── 5. 反向自测：去掉英文选择，断言必须变红 ────────────────────────────────
{
  const mutated = helperSource.replace("text: item.textEn || item.text,", "text: item.text,");
  ok("自测前置：成功改坏了英文选择", mutated !== helperSource);
  if (mutated !== helperSource) {
    const broken = loadHelpers(mutated);
    const result = broken.localizeWhatsNewEntries(sample, true);
    ok("自测：改坏后英文条目仍显示中文（证明第 3 节不是恒真）", result[0].items[0].text === "中文正文");
  }
}

console.log(`\n${failures === 0 ? "WHATS-NEW-I18N PASS" : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
