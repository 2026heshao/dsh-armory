// 装备清单（lib/loadout.js）的回归套件。
//
// 覆盖：只放行身份字段（env/header/token 等一律不进清单）、单条非法与重复静默丢弃、
// 200 条上限与 truncated 标记、JSON 文本解析、版本差异判定、kind+name 匹配、
// 文件名清理。全部是纯函数，零网络、零磁盘。
// 用法：node ./test/loadout.mjs
import {
  LOADOUT_MAX_ITEMS,
  LOADOUT_SCHEMA,
  buildLoadout,
  diffLoadout,
  loadoutFileName,
  normalizeLoadout,
  stringifyLoadout,
} from "../lib/loadout.js";

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

// ── 1. 构建：字段白名单与敏感信息剥离 ───────────────────────────────────────
{
  const loadout = buildLoadout({
    name: "  前端工作台  ",
    appVersion: "2.3.0",
    generatedAt: "2026-10-24T00:00:00.000Z",
    items: [
      {
        kind: "mcp",
        name: "github",
        transport: "http",
        source: "builtin:github",
        endpointHost: "api.githubcopilot.com",
        configKeys: ["Authorization", "X-Org"],
        enabled: false,
        // 以下全部是必须被丢掉的敏感 / 未知字段。
        env: { GITHUB_TOKEN: "ghp_secret_value" },
        headers: { Authorization: "Bearer secret" },
        token: "secret",
        url: "https://user:pass@example.com/mcp?token=secret",
      },
      { kind: "skill", name: "frontend-dev", source: "skillhub", version: "1.2.0", content: "SKILL.md 全文" },
      { kind: "expert", name: "文博凯", source: "workbuddy-expert", plugin: "content-creator", personaText: "人设正文" },
      { kind: "plugin", name: "code-review", source: "awesome-dsh-plugins", key: "code-review", version: "0.9.0" },
    ],
  });
  ok("schema 固定", loadout.schema === LOADOUT_SCHEMA);
  ok("名称 trim", loadout.name === "前端工作台");
  ok("生成时间与来源应用", loadout.generatedAt === "2026-10-24T00:00:00.000Z" && loadout.app.version === "2.3.0");
  ok("分类计数", loadout.counts.total === 4 && loadout.counts.mcp === 1 && loadout.counts.skill === 1
    && loadout.counts.expert === 1 && loadout.counts.plugin === 1);
  const mcp = loadout.items.find((item) => item.kind === "mcp");
  ok("MCP 保留身份与配置键名", mcp.transport === "http" && mcp.endpointHost === "api.githubcopilot.com"
    && JSON.stringify(mcp.configKeys) === JSON.stringify(["Authorization", "X-Org"]) && mcp.enabled === false);
  const serialized = JSON.stringify(loadout);
  ok("绝不写入 env/header/token/url 值", !serialized.includes("ghp_secret_value")
    && !serialized.includes("Bearer secret") && !serialized.includes("user:pass")
    && !serialized.includes("token=secret"));
  ok("技能正文 / 专家人设不进清单", !serialized.includes("SKILL.md 全文") && !serialized.includes("人设正文"));
  const plugin = loadout.items.find((item) => item.kind === "plugin");
  ok("插件保留 key 与版本", plugin.key === "code-review" && plugin.version === "0.9.0");
}

// ── 2. 文本往返：stringify → normalize ──────────────────────────────────────
{
  const loadout = buildLoadout({ items: [{ kind: "skill", name: "a", source: "skillhub", version: "1" }] });
  const text = stringifyLoadout(loadout);
  const parsed = normalizeLoadout(text);
  ok("JSON 文本可回读", parsed.items.length === 1 && parsed.items[0].name === "a");
  ok("导出文本带缩进（便于贴 Issue / gist）", text.includes("\n  \"schema\""));
  ok("默认名称兜底", parsed.name.length > 0);
}

// ── 3. 非法输入显式报错 ────────────────────────────────────────────────────
{
  const rejects = [
    ["无效 JSON", "{not json"],
    ["非对象", "[]"],
    ["schema 不匹配", JSON.stringify({ schema: "other", items: [] })],
    ["缺 items", JSON.stringify({ schema: LOADOUT_SCHEMA })],
    ["超体积", "x".repeat(256 * 1024 + 1)],
  ];
  for (const [label, input] of rejects) {
    let threw = false;
    try {
      normalizeLoadout(input);
    } catch {
      threw = true;
    }
    ok(`拒绝：${label}`, threw);
  }
}

// ── 4. 单条防御：非法 / 重复 / 上限 ─────────────────────────────────────────
{
  const raw = {
    schema: LOADOUT_SCHEMA,
    name: "  ",
    items: [
      null,
      42,
      { kind: "widget", name: "未知类型" },
      { kind: "skill", name: "   " },
      { kind: "skill", name: "dup", version: "1" },
      { kind: "skill", name: "dup", version: "2" },
      { kind: "mcp", name: "keys", configKeys: ["A", "A", "", "B", ...Array.from({ length: 30 }, (_, i) => `K${i}`)] },
    ],
  };
  const loadout = normalizeLoadout(raw);
  ok("非法 / 缺名条目被丢弃（重复合并后剩 2 条）", loadout.items.length === 2, String(loadout.items.length));
  ok("重复 kind+name 只留第一条", loadout.items.filter((item) => item.name === "dup").length === 1
    && loadout.items.find((item) => item.name === "dup").version === "1");
  ok("configKeys 去重且最多 20 个", loadout.items.find((item) => item.name === "keys").configKeys.length === 20);
  ok("空名称回落默认名", loadout.name.length > 0);

  const many = Array.from({ length: LOADOUT_MAX_ITEMS + 5 }, (_, i) => ({ kind: "skill", name: `s-${i}` }));
  const capped = buildLoadout({ items: many });
  ok(`最多 ${LOADOUT_MAX_ITEMS} 条`, capped.items.length === LOADOUT_MAX_ITEMS, String(capped.items.length));
  ok("超限时标记 truncated", capped.truncated === true);
  const notCapped = buildLoadout({ items: many.slice(0, LOADOUT_MAX_ITEMS) });
  ok("未超限不标记 truncated", notCapped.truncated === undefined);
}

// ── 5. 差异对比：installed / update / missing ───────────────────────────────
{
  const remote = buildLoadout({
    name: "朋友的清单",
    items: [
      { kind: "mcp", name: "github", source: "builtin:github" },
      { kind: "skill", name: "frontend-dev", version: "2.0.0" },
      { kind: "skill", name: "same-version", version: "1.0.0" },
      { kind: "skill", name: "no-version" },
      { kind: "plugin", name: "code-review", version: "1.0.0" },
    ],
  });
  const local = [
    { kind: "mcp", name: "github" },
    { kind: "skill", name: "frontend-dev", version: "1.0.0" },
    { kind: "skill", name: "same-version", version: "1.0.0" },
    { kind: "skill", name: "no-version", version: "9.9.9" },
    // 同名不同 kind 不算已安装。
    { kind: "expert", name: "code-review" },
  ];
  const result = diffLoadout(remote, local);
  const byName = new Map(result.rows.map((row) => [row.name, row]));
  ok("MCP 同名即视为已安装", byName.get("github").status === "installed");
  ok("双方版本不同 → update", byName.get("frontend-dev").status === "update"
    && byName.get("frontend-dev").localVersion === "1.0.0");
  ok("版本相同 → installed", byName.get("same-version").status === "installed");
  ok("清单缺版本 → 不误判 update", byName.get("no-version").status === "installed");
  ok("本机没有 → missing", byName.get("code-review").status === "missing");
  ok("计数与行数一致", result.counts.total === 5 && result.counts.installed === 3
    && result.counts.update === 1 && result.counts.missing === 1, JSON.stringify(result.counts));
  ok("只带清单元信息，不回传本机全量", result.loadout.items === undefined && result.loadout.name === "朋友的清单");

  const wrongKind = diffLoadout(remote, [{ kind: "expert", name: "no-version" }]);
  ok("同名不同 kind 不得匹配", wrongKind.rows.find((row) => row.name === "no-version").status === "missing");
}

// ── 6. 文件名清理 ──────────────────────────────────────────────────────────
{
  ok("中文名保留", loadoutFileName("前端工作台") === "前端工作台.json");
  ok("Windows 非法字符被替换", loadoutFileName('a/b:c*?"<>|') === "a-b-c.json", loadoutFileName('a/b:c*?"<>|'));
  ok("空名兜底", loadoutFileName("   ") === "dsh-loadout.json");
}

console.log(`\n${failures === 0 ? "LOADOUT PASS" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
