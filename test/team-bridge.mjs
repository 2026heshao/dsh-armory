// 团队型专家桥接回归 —— 确保「53 个 team 型专家可被召唤」这条链路不回退。
//
// 为什么必须有这组用例：团队专家的人设是 WorkBuddy 的多智能体调度脚本，DSH 没有
// TeamCreate / Agent(name=)，桥接靠三件东西同时成立：
//   1. 成员人设落盘（主理人调度时 read 得到）
//   2. 主理人 persona 末尾追加映射段（否则主理人会去调不存在的工具）
//   3. 成员人设不进 preset（否则每轮请求白付 N 份人设的 token）
// 任何一条被改坏，团队专家就变成「能召唤但不干活」或「能干活但每轮贵 4 倍」——都不报错，
// 所以只能靠断言守住。用替身宿主跑，不碰真实 profile、不联网。
//
// 用法：node ./test/team-bridge.mjs
import { mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const modUrl = new URL("../lib/expert-market.js", import.meta.url);
// 旧版行模拟（8b）需要这两个插件名——它们不是公开导出，按真实值内联对齐即可；
// 若模块里改名，8b 的读回断言会失败并提醒同步此处。
const PRESET_PLUGIN_NAME = "@deepseek-ai/dsh-agent-preset";
const PERSONA_PLUGIN_NAME = "@deepseek-ai/dsh-persona";

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

const { buildTeamBridge, prepareExpertPersona, uninstallTeamMemberPersonas, TEAM_BRIDGE_MARKER, hasTeamBridge, readExpertPresets, writeExpertPreset } = await import(modUrl.href);

// ── 测试用的团队详情（形状与 wbExpertDetail 的真实返回一致）──────────────
const PLUGIN = "test-company";
const LEAD = { id: "test-team-lead", name: "主理人", profession: "交付总监", role: "lead", promptFile: "/plugins/test/agents/lead.md" };
const MEMBERS = [
  { id: "test-pm", name: "产品", profession: "产品经理", role: "member", promptFile: "/plugins/test/agents/pm.md" },
  { id: "test-arch", name: "架构", profession: "架构师", role: "member", promptFile: "/plugins/test/agents/arch.md" },
  { id: "test-qa", name: "测试", profession: "QA工程师", role: "member", promptFile: "/plugins/test/agents/qa.md" },
];
const PERSONA = "# 主理人人设\n\n你必须用 TeamCreate 建立团队，然后用 Agent 工具传 name=成员ID 调度。\n";
function teamDetail(overrides = {}) {
  return {
    plugin: PLUGIN,
    name: "测试团队",
    expertType: "team",
    persona: PERSONA,
    members: [LEAD, ...MEMBERS],
    ...overrides,
  };
}

// 落盘位置要可预测：直接算一遍（与 expert-market 内部同一条路径规则）。
const { homedir } = await import("node:os");
const TEAM_DIR = join(homedir(), ".dsh", "wb-market", "experts", "teams", PLUGIN);

// 成员人设的取数走「本机缓存 → CDN」，测试里把 CDN 那层屏蔽掉：
// 若缓存缺失就直接失败，这正好也验证「不联网时不得静默产出空人设」。
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  // 让 CDN 分支必然失败，从而必须走本机缓存；外部请求一律拒绝（测试不联网）。
  throw new Error(`测试期间禁止联网：${String(url).slice(0, 60)}`);
};

try {
  // ── 1. 桥接段：三个禁止项必须被明确改写 ────────────────────────────────
  {
    const files = new Map(MEMBERS.map((m) => [m.id, join(TEAM_DIR, `${m.id}.md`)]));
    const bridge = buildTeamBridge(teamDetail(), files);

    ok("桥接段非空", bridge.length > 200, `len=${bridge.length}`);
    ok("声明没有 TeamCreate", bridge.includes("TeamCreate") && bridge.includes("无需调用"));
    ok("给出 subagent 映射", bridge.includes("`subagent`") && bridge.includes("run_in_background: false"));
    ok("保留了人设铁律（不代写成员产出）", bridge.includes("不要改写") && bridge.includes("不要替它编"));
    ok("列出全部成员 ID", MEMBERS.every((m) => bridge.includes(m.id)));
    ok("主理人不在编制表里重复", !bridge.includes(`| \`${LEAD.id}\` |`));
    ok("列出成员人设文件路径", MEMBERS.every((m) => bridge.includes(join(TEAM_DIR, `${m.id}.md`))));
    ok("人设文件缺失时给出兜底说明", buildTeamBridge(teamDetail(), new Map()).includes("人设未落盘"));
    ok("续聊走 send_message", bridge.includes("send_message"));
  }

  // ── 2. 单人专家：桥接段必须原样不动 ────────────────────────────────────
  {
    const single = { plugin: "solo", name: "独狼", expertType: "agent", persona: PERSONA, members: [] };
    const bridge = buildTeamBridge(single, new Map());
    ok("单人专家不注入桥接段", bridge === "");
  }

  // ── 3. 没有成员的团队：不得产出半截桥接段 ──────────────────────────────
  {
    const bare = teamDetail({ members: [LEAD] });
    ok("只有主理人时不注入桥接段", buildTeamBridge(bare, new Map()) === "");
  }

  // ── 4. prepareExpertPersona：单人直通 / 团队加工 ────────────────────────
  {
    const single = { plugin: "solo", name: "独狼", expertType: "agent", persona: PERSONA, members: [] };
    const prepared = await prepareExpertPersona(single);
    ok("单人：人设原样返回", prepared.personaText === PERSONA);
    ok("单人：不产出成员结果", prepared.memberResult === null);
  }

  // ── 5. 团队 + 人设可读：落盘 + 追加桥接段，且 preset 里只有主理人人设 ──
  {
    await rm(TEAM_DIR, { recursive: true, force: true });
    // 伪造本机 WorkBuddy 缓存，让 readMemberPersona 走本地分支。
    const cacheRoot = join(homedir(), ".workbuddy", "plugins", "cache", "experts", PLUGIN, "1.0.0", "agents");
    await mkdir(cacheRoot, { recursive: true });
    for (const member of MEMBERS) {
      await writeFile(join(cacheRoot, `${member.id}.md`), `# ${member.name}的人设\n\n我是${member.profession}。\n`);
    }

    const prepared = await prepareExpertPersona(teamDetail(), { onLog: () => {} });
    const installed = prepared.memberResult?.installed || [];

    ok("团队成员人设全部落盘", installed.length === MEMBERS.length, `installed=${installed.length}`);
    ok("主理人不重复落盘", !installed.some((row) => row.id === LEAD.id));
    ok("落盘文件真实可读", await Promise.all(installed.map(async (row) => (await readFile(row.path, "utf8")).includes("我是"))).then((rows) => rows.every(Boolean)));
    ok("成员人设目录落在 wb-market/experts/teams 下", existsSync(TEAM_DIR));
    ok("personaText = 主理人人设 + 桥接段", prepared.personaText.startsWith(PERSONA) && prepared.personaText.includes("## DSH 运行时适配"));
    ok("personaText 里没有成员人设正文（不进系统提示）", !prepared.personaText.includes("我是产品经理"));
    ok("桥接段只增一次（无重复拼接）", prepared.personaText.split("## DSH 运行时适配").length === 2);

    // ── 6. 送还清理：目录必须彻底消失 ──────────────────────────────────
    await uninstallTeamMemberPersonas(PLUGIN);
    ok("送还后成员人设目录已清除", !existsSync(TEAM_DIR));

    // 清理伪造的缓存，避免污染真实环境。
    await rm(join(homedir(), ".workbuddy", "plugins", "cache", "experts", PLUGIN), { recursive: true, force: true });
  }

  // ── 7. 成员人设取不到：不得静默成功，要留下 notes ────────────────────────
  {
    await rm(TEAM_DIR, { recursive: true, force: true });
    const prepared = await prepareExpertPersona(teamDetail(), { onLog: () => {} });
    const notes = prepared.memberResult?.notes || [];
    ok("取不到人设时记录 notes", notes.length === MEMBERS.length, `notes=${notes.length}`);
    ok("取不到人设时不落空文件", !existsSync(TEAM_DIR) || (prepared.memberResult?.installed || []).length === 0);
    ok("取不到人设仍给主理人可用桥接段", prepared.personaText.includes("人设未落盘"));
    await uninstallTeamMemberPersonas(PLUGIN);
  }

  // ── 8. 召唤预设行的 stale 体检：读写往返 + 旧版行模拟 + upsert 刷新 ─────
  // 用户实测根因：旧版本召唤写入的团队预设没有桥接段，新会话选它只会调
  // 不存在的 TeamCreate/Agent。守卫三件事：readExpertPresets 带出人设正文、
  // hasTeamBridge 能区分新旧、upsert（重跑召唤）能把旧行刷成带桥接段。
  {
    const prepared = await prepareExpertPersona(teamDetail(), { onLog: () => {} });
    const spec = {
      plugin: PLUGIN,
      displayName: "测试团队",
      profession: "交付总监",
      description: "回归用团队",
      personaText: prepared.personaText,
    };

    // 8a. 新版召唤：写入 → 读回，personaText 必须带桥接段。
    const patchA = `- insert:\n  - id: keepme\n    name: "@deepseek-ai/keep"\n`;
    const written = writeExpertPreset(patchA, spec);
    ok("召唤写入产出 insert 指令行", written.mode === "inserted" && written.presetId === `preset-wbexpert-${PLUGIN}`);
    const rowsA = readExpertPresets(written.content);
    ok("召唤行读回恰一条", rowsA.length === 1, `rows=${rowsA.length}`);
    ok("读回带 presetId/plugin", rowsA[0]?.presetId === `preset-wbexpert-${PLUGIN}` && rowsA[0]?.plugin === PLUGIN);
    ok("读回 personaText 带桥接段（新版召唤不 stale）", hasTeamBridge(rowsA[0]?.personaText), `markerHits=${String(rowsA[0]?.personaText || "").split(TEAM_BRIDGE_MARKER).length - 1}`);
    ok("读回的人设不含成员正文（成员不进系统提示）", !(rowsA[0]?.personaText || "").includes("我是产品经理"));

    // 8b. 旧版行模拟：手写一条人设无桥接段的团队预设 → 读回必须判 stale。
    const legacyContent = patchA
      + `- insert:\n  - id: preset-wbexpert-${PLUGIN}\n    name: "${PRESET_PLUGIN_NAME}"\n    config:\n      id: wbexpert-${PLUGIN}\n      name: WorkBuddy 专家 · 测试团队\n      plugins:\n        - id: persona\n          name: "${PERSONA_PLUGIN_NAME}"\n          config:\n            prefix: ${JSON.stringify(PERSONA)}\n`;
    const rowsB = readExpertPresets(legacyContent);
    ok("旧版行读回 personaText 缺桥接段（stale 可判）", rowsB.length === 1 && !hasTeamBridge(rowsB[0]?.personaText));

    // 8c. upsert 刷新：在旧版 patch 上重跑召唤 → 行整体重写、人设带上桥接段。
    const refreshed = writeExpertPreset(legacyContent, spec);
    ok("upsert 旧行判定为 updated（不重复插入）", refreshed.mode === "updated");
    const rowsC = readExpertPresets(refreshed.content);
    ok("刷新后桥接段出现恰一次", rowsC.length === 1 && String(rowsC[0]?.personaText || "").split(TEAM_BRIDGE_MARKER).length === 2, `hits=${String(rowsC[0]?.personaText || "").split(TEAM_BRIDGE_MARKER).length - 1}`);
    ok("刷新后 keepme 行保留（不误伤他行）", refreshed.content.includes("keepme"));

    // 8d. 常量一致性：marker 文本含关键词（前端 client.js 内联同名常量靠它对齐）。
    ok("TEAM_BRIDGE_MARKER 稳定", TEAM_BRIDGE_MARKER === "## DSH 运行时适配（团队协作桥接）");
    ok("hasTeamBridge 对非字符串安全", hasTeamBridge(null) === false && hasTeamBridge(undefined) === false && hasTeamBridge(42) === false);

    await uninstallTeamMemberPersonas(PLUGIN);
  }
} finally {
  globalThis.fetch = realFetch;
  await rm(TEAM_DIR, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? "\nTEAM-BRIDGE PASS" : `\nTEAM-BRIDGE FAILED (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;
