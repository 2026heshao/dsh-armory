// 认证注入规则 + 令牌槽扫描（lib/wb-auth-rules.js）的回归套件（T01）。
//
// 全部纯函数零 IO：真值表逐条断言 + 畸形输入不抛错。覆盖 parseInjectionRules /
// rulesFor / scanTokenSlots / applyTokens 的完整行为面，重点：
// applyTokens 绝不修改入参（structuredClone）、嵌套 transport 形态、
// 多占位符模板、tokens 缺失时槽保留原样并上报 missingSlots。
//
// 用法：node ./test/wb-auth-rules.mjs
const { parseInjectionRules, rulesFor, scanTokenSlots, applyTokens } =
  await import(new URL("../lib/wb-auth-rules.js", import.meta.url).href);

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

/** 一个带 token 槽的标准 mcpServers 形态（direct env + nested transport headers）。 */
function sampleServers() {
  return {
    "tencent-docs": {
      command: "npx",
      env: { APP_ID: "${TENCENT_APP_ID}", SECRET: "Bearer ${TENCENT_SECRET}" },
    },
    "nested-one": {
      transport: {
        type: "http",
        headers: { Authorization: "Bearer ${NESTED_TOKEN}", "X-Plain": "no-slot-here" },
      },
    },
    "no-tokens": { env: { PLAIN: "value" } },
  };
}

// ── 1. parseInjectionRules：真值 + 畸形输入 ──────────────────────────────────
{
  const rules = parseInjectionRules({
    auth_injection_rules: [
      { id: "tencent", applies_to_connectors: ["tencent-docs"], tokens: [{ name: "TENCENT_APP_ID", prompt: "App ID" }] },
      { id: "global", applies_to_connectors: ["*"] },
      "not-an-object",   // 畸形元素被过滤
      null,
      42,
    ],
  });
  ok("parseInjectionRules：取顶层 auth_injection_rules 数组", Array.isArray(rules) && rules.length === 2, `n=${rules.length}`);
  ok("parseInjectionRules：保留合法规则对象", rules[0].id === "tencent" && rules[1].id === "global");

  ok("parseInjectionRules：无 auth_injection_rules 键 → []", parseInjectionRules({}).length === 0);
  ok("parseInjectionRules：auth_injection_rules 非数组 → []", parseInjectionRules({ auth_injection_rules: "yes" }).length === 0);
  ok("parseInjectionRules：入参为 null → []", parseInjectionRules(null).length === 0);
  ok("parseInjectionRules：入参为字符串 → []", parseInjectionRules("junk").length === 0);
  ok("parseInjectionRules：数组全是畸形元素 → []", parseInjectionRules({ auth_injection_rules: [1, null, []] }).length === 0);
}

// ── 2. rulesFor：applies_to_connectors 包含命中 + 通配 ──────────────────────
{
  const rules = [
    { id: "tencent", applies_to_connectors: ["tencent-docs", "other-docs"] },
    { id: "wild", applies_to_connectors: ["*"] },
    { id: "empty", applies_to_connectors: [] },
    { id: "no-field" },
  ];
  ok("rulesFor：命中列表内的 id", rulesFor(rules, "tencent-docs").some((rule) => rule.id === "tencent"));
  ok("rulesFor：未命中列表 → 不含该规则", !rulesFor(rules, "unrelated").some((rule) => rule.id === "tencent"));
  // 通配符 "*" 只是普通字符串：不在列表里就不命中（精确包含语义，不做 glob 展开）。
  ok("rulesFor：通配 * 不自动命中任意 id（精确包含语义）", !rulesFor(rules, "anything").some((rule) => rule.id === "wild"));
  ok("rulesFor：id 恰为 '*' 时通配规则可被精确命中", rulesFor(rules, "*").some((rule) => rule.id === "wild"));
  ok("rulesFor：空列表不命中", !rulesFor(rules, "tencent-docs").some((rule) => rule.id === "empty"));
  ok("rulesFor：缺 applies_to_connectors 字段不命中（不炸不误配）", !rulesFor(rules, "tencent-docs").some((rule) => rule.id === "no-field"));
  ok("rulesFor：畸形规则数组 → 空", rulesFor(null, "x").length === 0);
}

// ── 3. scanTokenSlots：直接 env + 嵌套 transport.headers ─────────────────────
{
  const slots = scanTokenSlots(sampleServers());
  const find = (server, container, key) => slots.find((slot) => slot.server === server && slot.container === container && slot.key === key);
  ok("scanTokenSlots：扫描到 3 个槽位", slots.length === 3, `n=${slots.length}`);
  const appId = find("tencent-docs", "env", "APP_ID");
  ok("槽位形状完整（server/container/key/template/placeholder/value）",
    appId && appId.template === "${TENCENT_APP_ID}" && appId.placeholder === "TENCENT_APP_ID" && appId.value === "${TENCENT_APP_ID}",
    JSON.stringify(appId));
  const secret = find("tencent-docs", "env", "SECRET");
  ok("混合模板整串保留（Bearer ${X}）", secret?.template === "Bearer ${TENCENT_SECRET}" && secret?.placeholder === "TENCENT_SECRET");
  const auth = find("nested-one", "header", "Authorization");
  ok("嵌套 transport.headers 的槽位被扫到，container 统一命名 header",
    auth?.template === "Bearer ${NESTED_TOKEN}" && auth.container === "header");
  ok("无占位符的值不产生槽位", !find("nested-one", "header", "X-Plain") && !find("no-tokens", "env", "PLAIN"));
  ok("scanTokenSlots：空对象 → []", scanTokenSlots({}).length === 0);
  ok("scanTokenSlots：null → [] 不抛错", scanTokenSlots(null).length === 0);
  ok("scanTokenSlots：畸形 server 值（字符串）→ 跳过不抛错", scanTokenSlots({ bad: "just-a-string" }).length === 0);
}

// ── 4. applyTokens：完整替换 + 原对象不被修改（返回 { mcpServers, missingSlots }）──
{
  const servers = sampleServers();
  const snapshot = JSON.stringify(servers); // 副本基线：跑完必须与此完全一致。
  const tokens = { TENCENT_APP_ID: "10001", TENCENT_SECRET: "abc123", NESTED_TOKEN: "tk-9" };
  const filled = applyTokens(servers, tokens);
  const out = filled.mcpServers; // 返回是包装结构：替换结果在 .mcpServers 里。

  ok("applyTokens：direct env 占位符被替换", out["tencent-docs"].env.APP_ID === "10001");
  ok("applyTokens：混合模板整串替换（Bearer ${X} → Bearer abc123）", out["tencent-docs"].env.SECRET === "Bearer abc123");
  ok("applyTokens：嵌套 transport.headers 占位符被替换", out["nested-one"].transport.headers.Authorization === "Bearer tk-9");
  ok("applyTokens：无占位符的值原样保留", out["nested-one"].transport.headers["X-Plain"] === "no-slot-here" && out["no-tokens"].env.PLAIN === "value");
  ok("applyTokens：入参对象不被修改（structuredClone 语义）", JSON.stringify(servers) === snapshot);
  ok("applyTokens：tokens 齐全时 missingSlots 为空", filled.missingSlots.length === 0, JSON.stringify(filled.missingSlots));
  ok("applyTokens：齐全 tokens 下无 ${...} 残留", !JSON.stringify(out).includes("${"));
}

// ── 5. applyTokens：tokens 缺失 → 槽保留原样 + missingSlots 上报 ─────────────
{
  const servers = sampleServers();
  const filled = applyTokens(servers, { TENCENT_APP_ID: "10001" }); // 缺另外两个 token。
  const out = filled.mcpServers;
  ok("缺 token：已供占位符仍被替换", out["tencent-docs"].env.APP_ID === "10001");
  ok("缺 token：缺的槽保留原模板", out["tencent-docs"].env.SECRET === "Bearer ${TENCENT_SECRET}");
  ok("缺 token：嵌套槽同样保留", out["nested-one"].transport.headers.Authorization === "Bearer ${NESTED_TOKEN}");
  const missing = filled.missingSlots;
  ok("缺 token：missingSlots 精确上报 2 条", missing.length === 2, JSON.stringify(missing));
  ok("missingSlots 形状含 server/container/key/placeholder/template",
    missing.every((slot) => "server" in slot && "container" in slot && "key" in slot && "placeholder" in slot && "template" in slot));
  ok("missingSlots 记录正确槽位", missing.some((slot) => slot.server === "tencent-docs" && slot.placeholder === "TENCENT_SECRET")
    && missing.some((slot) => slot.server === "nested-one" && slot.placeholder === "NESTED_TOKEN"));
}

// ── 6. applyTokens：多占位符同模板 "Bearer ${a} ${b}" ────────────────────────
{
  const servers = { dual: { env: { AUTH: "Bearer ${A_TOKEN} ${B_TOKEN}" } } };
  const both = applyTokens(servers, { A_TOKEN: "x", B_TOKEN: "y" });
  ok("同模板两个占位符全替换", both.mcpServers.dual.env.AUTH === "Bearer x y", both.mcpServers.dual.env.AUTH);
  const one = applyTokens(servers, { A_TOKEN: "x" });
  // missingSlots 每个字段一个槽位，placeholder 记首个占位符（A_TOKEN），不是逐占位符上报。
  ok("只供一个 token：整模板残留并按槽位上报（placeholder=首个占位符）", one.mcpServers.dual.env.AUTH === "Bearer ${A_TOKEN} ${B_TOKEN}"
    && one.missingSlots.length === 1 && one.missingSlots[0].placeholder === "A_TOKEN");
  // 空 tokens：全部残留。
  const none = applyTokens(servers, {});
  ok("空 tokens：模板原样 + missingSlots 上报", none.mcpServers.dual.env.AUTH === "Bearer ${A_TOKEN} ${B_TOKEN}" && none.missingSlots.length === 1);
  // token 值含 $&{ } 等特殊字符：split/join 纯字符串拼接语义，替换后不误判。
  const weird = applyTokens(servers, { A_TOKEN: "$&{}", B_TOKEN: "}" });
  ok("token 值含特殊字符：split/join 语义安全", weird.mcpServers.dual.env.AUTH === "Bearer $&{} }", weird.mcpServers.dual.env.AUTH);
  // 已知保守边界：token 值本身含 "${" 会被残留检测判为缺槽（宁可不上盘也不写半成品，
  // 见 lib/wb-auth-rules.js applyTokens 注释），槽保留原样并上报。
  const sneaky = applyTokens(servers, { A_TOKEN: "${", B_TOKEN: "}" });
  ok("token 值本身含 ${：保守按残留处理，槽保留原样并上报", sneaky.mcpServers.dual.env.AUTH === "Bearer ${A_TOKEN} ${B_TOKEN}" && sneaky.missingSlots.length === 1);
}

// ── 7. applyTokens：防御输入 ─────────────────────────────────────────────────
{
  let okNoThrow = true;
  let emptyResult = null;
  try {
    emptyResult = applyTokens(null, { A: "1" });
  } catch {
    okNoThrow = false;
  }
  ok("applyTokens(null)：不抛错，返回空 mcpServers 包装", okNoThrow && emptyResult.mcpServers !== null && typeof emptyResult.mcpServers === "object");
  const empty = applyTokens({}, { A: "1" });
  ok("applyTokens：空 mcpServers → 空 missingSlots", empty.missingSlots.length === 0);
  const noTokens = applyTokens(sampleServers(), null);
  ok("applyTokens：tokens 为 null → 全部槽上报 missingSlots", noTokens.missingSlots.length === 3);
}

console.log(`\n${failures === 0 ? "WB-AUTH-RULES PASS" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
