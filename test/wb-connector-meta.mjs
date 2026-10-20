// T02（R1/R2/R3）连接器元数据投影的守护套件：
//   R1 —— auth_injection_rules 解析与按连接器命中（X9：只展示，绝不注入）
//   R2 —— visible_in 标签透传与本地筛选
//   R3 —— examples 优先、description 兜底的展示文案
// 全部纯函数：零网络、零真实 ~/.dsh、零文件写盘（wb-market.js 里的远端解析入口
// 在 wbConnectorCatalog 内部，本套件直接对投影函数构造 connectors.json 样例真跑）。
import { injectionRuleNote, visibleInOf, matchesVisibleIn, displayCopyOf } from "../lib/wb-market.js";

let failed = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failed += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

// ── R1：auth_injection_rules 命中/未命中/畸形 ─────────────────────────────
const indexWithRules = {
  connectors: [],
  auth_injection_rules: [
    { id: "rule-a", applies_to_connectors: ["tencent-docs", "notion"] },
    { id: "rule-b", applies_to_connectors: ["notion"] },
    "not-an-object", // 畸形元素：必须被过滤，不影响计数
    null,
    { id: "rule-empty" }, // 缺 applies_to_connectors：不命中任何连接器
  ],
};
{
  const hit = injectionRuleNote(indexWithRules, "tencent-docs");
  ok("R1 命中：tencent-docs 计 1 条规则", hit.count === 1);
  ok("R1 命中文案：写明「不代注入」边界", hit.note.includes("不代注入") && hit.note.includes("1 条"));
  const miss = injectionRuleNote(indexWithRules, "unknown-connector");
  ok("R1 未命中：count=0 且 note 为空串", miss.count === 0 && miss.note === "");
  ok("R1 畸形规则元素被过滤：notion 只命中 2 条（畸形串/null 不计入）", injectionRuleNote(indexWithRules, "notion").count === 2);
  ok("R1 rules 缺 applies_to_connectors：不命中", injectionRuleNote(indexWithRules, "").count === 0);
  // 索引整体畸形：任何形状都不抛错。
  for (const [label, idx] of [["null 索引", null], ["数组索引", []], ["字符串索引", "bad"], ["无规则键", {}]]) {
    let threw = false;
    let result = null;
    try { result = injectionRuleNote(idx, "tencent-docs"); } catch { threw = true; }
    ok(`R1 索引畸形（${label}）不抛错且回落 0 条`, !threw && result.count === 0);
  }
  // 连接器 id 畸形同理。
  ok("R1 连接器 id 畸形（null/空串）回落 0 条", injectionRuleNote(indexWithRules, null).count === 0
    && injectionRuleNote(indexWithRules, "").count === 0);
}

// ── R2：visible_in 透传与筛选 ─────────────────────────────────────────────
{
  ok("R2 透传：字符串数组原样保留（trim 空白）", JSON.stringify(visibleInOf({ visible_in: [" workbuddy ", "cline", ""] })) === JSON.stringify(["workbuddy", "cline"]));
  ok("R2 缺失字段 → []", JSON.stringify(visibleInOf({})) === "[]");
  ok("R2 null/数组/字符串等畸形 → []", visibleInOf({ visible_in: null }).length === 0
    && visibleInOf({ visible_in: "workbuddy" }).length === 0
    && visibleInOf(null).length === 0);
  ok("R2 元素畸形（数字/null）被剔除", JSON.stringify(visibleInOf({ visible_in: ["workbuddy", 3, null] })) === JSON.stringify(["workbuddy"]));

  // 筛选语义：selected 为空 = 全过；行未标 = 不过滤该行；命中要求**全部** selected 都在。
  ok("R2 筛选：未选任何标签 → 全部通过", matchesVisibleIn(["workbuddy"], []) && matchesVisibleIn([], []));
  ok("R2 筛选：行未标 visible_in → 不受筛选（上游没标当全可见）", matchesVisibleIn([], ["cline"]));
  ok("R2 筛选：单标签命中/未命中", matchesVisibleIn(["workbuddy", "cline"], ["cline"]) && !matchesVisibleIn(["workbuddy"], ["cline"]));
  ok("R2 筛选：多标签要求全部命中（AND）", matchesVisibleIn(["workbuddy", "cline"], ["workbuddy", "cline"]) && !matchesVisibleIn(["workbuddy"], ["workbuddy", "cline"]));
  ok("R2 筛选：大小写不敏感", matchesVisibleIn(["WorkBuddy"], ["workbuddy"]));
  ok("R2 筛选：selected 畸形（非数组）安全放行", matchesVisibleIn(["workbuddy"], "workbuddy"));
}

// ── R3：examples 优先与语言回退 ───────────────────────────────────────────
{
  const zhFirst = displayCopyOf({
    examples_zh: ["示例一", "示例二"],
    examples_en: ["example one"],
    description_zh: "中文描述",
    description_en: "english description",
  });
  ok("R3 examples_zh 优先：正文取 examples、from=examples", zhFirst.from === "examples" && zhFirst.body === "示例一\n示例二" && zhFirst.examples.length === 2);
  const enOnly = displayCopyOf({ examples_en: ["example one", "example two"], description_zh: "中文描述" });
  ok("R3 缺 zh examples 回落 examples_en", enOnly.from === "examples" && enOnly.body === "example one\nexample two");
  const descOnly = displayCopyOf({ description_zh: "中文描述", description_en: "english" });
  ok("R3 无 examples 回落 description（zh 优先）", descOnly.from === "description" && descOnly.body === "中文描述" && descOnly.examples.length === 0);
  const enDescOnly = displayCopyOf({ description_en: "english only" });
  ok("R3 无 zh description 回落 description_en", enDescOnly.body === "english only");
  const bare = displayCopyOf({});
  ok("R3 全缺 → 空串、from 空", bare.body === "" && bare.from === "");
  ok("R3 畸形入参（null/数组/数字 examples）不抛错、回落 description",
    displayCopyOf(null).body === "" && displayCopyOf({ examples_zh: [1, null, "好的"], description: "兜底" }).body === "好的"
    && displayCopyOf({ examples_zh: "不是数组", description: "兜底" }).body === "兜底");
  ok("R3 description 字段兜底序 zh → 裸 description → en", displayCopyOf({ description: "裸描述", description_en: "en" }).body === "裸描述");
}

console.log(failed === 0 ? "WB-CONNECTOR-META PASS" : `${failed} CHECK(S) FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
