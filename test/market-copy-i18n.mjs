// issue #9（2026-11-02）：市场数据型文案的 locale 选择。
//
// 上游 SkillHub 目前没有英文简介，连接器虽然带 description_en，但卡片/详情长期只读
// 中文投影。数据层已经同时送 descriptionZh / descriptionEn，这里守的是**渲染期**
// 的决策：中文界面中文优先，英文界面英文优先，英文缺失且原文是中文时给中性占位，
// 不能把整段中文静默塞进英文界面。
//
// 手法：从 lib/client.js 抽出市场文案选择的小节，在 vm 里换不同的 usesEnglish / t
// 替身真跑；再静态断言四个调用点确实走了 helper，防止有人改回 `skill.description`。
//
// 用法：node ./test/market-copy-i18n.mjs

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const CLIENT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "client.js");
const START = "// ── 市场数据型文案：按 locale 选中英两套字段（issue #9）";
const END = "// ── P1：数据型英文覆盖";

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};
const section = (title) => console.log(`\n── ${title} ─────────────────────────────────────────────`);

const source = await readFile(CLIENT, "utf8");
const startAt = source.indexOf(START);
const endAt = source.indexOf(END, startAt + START.length);
ok("能定位市场文案选择小节", startAt >= 0 && endAt > startAt, `start=${startAt} end=${endAt}`);
if (startAt < 0 || endAt <= startAt) {
  console.log("\nMARKET-COPY-I18N FAIL（标记缺失）");
  process.exit(1);
}

const DICT = { "目录未提供英文介绍": "No English description was provided by the directory." };
const probeFor = (english) => {
  const context = {
    usesEnglish: () => english,
    t: (key) => DICT[key] || key,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(
    source.slice(startAt, endAt) + "\nglobalThis.__probe = { marketCopy, marketSkillCopy, marketConnectorCopy, marketSkillName, marketConnectorName, humanizeSlug, isCjkText };",
    context,
    { filename: "market-copy.js" },
  );
  return context.__probe;
};

const zhProbe = probeFor(false);
const enProbe = probeFor(true);
const PLACEHOLDER = DICT["目录未提供英文介绍"];

section("1. marketCopy：按 locale 选择");
{
  ok("1.1 中文界面：中英都有时取中文", zhProbe.marketCopy("中文介绍", "English") === "中文介绍");
  ok("1.2 中文界面：缺中文时回落英文", zhProbe.marketCopy("", "English") === "English");
  ok("1.3 英文界面：中英都有时取英文", enProbe.marketCopy("中文介绍", "English") === "English");
  ok("1.4 英文界面：缺英文且原文是中文时给占位", enProbe.marketCopy("中文介绍", "") === PLACEHOLDER);
  ok("1.5 英文界面：英文字段本身是中文（上游脏数据）同样给占位",
    enProbe.marketCopy("中文介绍", "另一段中文") === PLACEHOLDER);
  ok("1.6 英文界面：原文本来就是英文时原样展示", enProbe.marketCopy("English only", "") === "English only");
  ok("1.7 两边都空：返回空串，由卡片回落名称", enProbe.marketCopy("", "") === "" && zhProbe.marketCopy("", "") === "");
  ok("1.8 空白字符串不算有内容", enProbe.marketCopy("   ", "  ") === "");
}

section("2. 技能 / 连接器字段投影");
{
  ok("2.1 技能优先 descriptionZh，旧回包回落 description",
    enProbe.marketSkillCopy({ descriptionZh: "中文", description: "旧中文", descriptionEn: "English" }) === "English"
    && enProbe.marketSkillCopy({ description: "旧中文", descriptionEn: "English" }) === "English");
  ok("2.2 技能中文界面取中文原文",
    zhProbe.marketSkillCopy({ descriptionZh: "中文", descriptionEn: "English" }) === "中文");
  ok("2.3 连接器优先 displayBody（examples 正文），再回落 description",
    enProbe.marketConnectorCopy({ displayBody: "中文示例", descriptionEn: "English desc" }) === "English desc"
    && enProbe.marketConnectorCopy({ displayBody: "中文示例", displayBodyEn: "English examples" }) === "English examples");
  ok("2.4 连接器缺英文投影时，中文原文给占位",
    enProbe.marketConnectorCopy({ displayBody: "中文示例" }) === PLACEHOLDER);
  ok("2.5 英文界面：有 nameEn 时标题取英文名",
    enProbe.marketSkillName({ name: "小说创作", nameEn: "Novel Writer", slug: "my-novel-writer" }) === "Novel Writer");
  ok("2.6 英文界面：中文标题 + 拉丁 slug 时由 slug 生成英文名",
    enProbe.marketSkillName({ name: "技能发现·Find Skills", slug: "find-skills" }) === "Find Skills");
  ok("2.7 中文界面：标题保持中文原名",
    zhProbe.marketSkillName({ name: "小说创作", nameEn: "Novel Writer", slug: "my-novel-writer" }) === "小说创作");
  ok("2.8 英文界面：本来就是拉丁标题时原样保留",
    enProbe.marketSkillName({ name: "Find Skills", slug: "find-skills" }) === "Find Skills");
  ok("2.9 英文界面：没有拉丁 slug 时只能保留中文标题（不伪造英文）",
    enProbe.marketSkillName({ name: "小说创作" }) === "小说创作");
  ok("2.10 英文界面：连接器优先 nameEn，没有则保留品牌名",
    enProbe.marketConnectorName({ name: "腾讯文档", nameEn: "Tencent Docs", id: "tencent-docs" }) === "Tencent Docs"
    && enProbe.marketConnectorName({ name: "ima", id: "ima" }) === "ima");
  ok("2.11 slug 生成：连字符/下划线/点都转空格并首字母大写",
    enProbe.humanizeSlug("find-skills_v2.beta") === "Find Skills V2 Beta");
}

section("3. 调用点：卡片 / 详情不再直读 description");
{
  ok("3.1 技能卡片走 marketSkillCopy", source.includes("marketSkillCopy(skill) || skill.name"));
  ok("3.2 技能详情走 marketSkillCopy", source.includes("const skillDetailCopy = skillDetail ? marketSkillCopy(skillDetail) : ''"));
  ok("3.3 连接器卡片走 marketConnectorCopy", source.includes("marketConnectorCopy(item) || item.nameEn || item.id"));
  ok("3.4 连接器详情走 marketConnectorCopy", source.includes("const connectorDetailCopy = connectorDetail ? marketConnectorCopy(connectorDetail) : ''"));
  ok("3.5 技能卡片不再直读 skill.description",
    !source.includes("h('div', { className: 'dsh-mcp-card-summary' }, skill.description"));
  ok("3.6 技能详情不再直读 skillDetail.description",
    !source.includes("skillDetail.description ? h('p', { className: 'dsh-mcp-wb-modal-desc' }"));
  ok("3.7 英文界面的连接器示例只取 examplesEn，并过滤中文示例",
    source.includes(".filter((example) => !isCjkText(example))"));
  ok("3.8 技能卡片标题走 marketSkillName", source.includes("dsh-mcp-card-name' }, marketSkillName(skill)"));
  ok("3.9 技能详情标题走 marketSkillName", source.includes("h('h3', null, marketSkillName(skillDetail))"));
  ok("3.10 连接器卡片标题走 marketConnectorName", source.includes("dsh-mcp-card-name' }, marketConnectorName(item)"));
  ok("3.11 连接器详情标题走 marketConnectorName", source.includes("h('h3', null, marketConnectorName(connectorDetail))"));
}

console.log(`\n${failures === 0 ? "MARKET-COPY-I18N PASS" : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
