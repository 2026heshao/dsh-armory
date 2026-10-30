// 专家人设取数链回归 —— issue #5：「技能匠人」详情页只有一行红字「拉取人设失败：HTTP 404」。
//
// 根因不在我们的拼路径：manifest 里给的 promptFile 是
//   /plugins/skill-smith/agents/skill-smith.md
// 而 WorkBuddy 公开分发地址（acc-1258344699.cos.accelerate.myqcloud.com）上并没有这个包。
// 2026-10-27 全量探过 428 个专家的人设地址：243 个 200、185 个 404（含全部开学季）。
// 「拿不到原文」是上游事实，改不了；能改的是取数顺序，本套件逐条钉住：
//   1. 本机覆盖 ~/.dsh/wb-market/experts/overrides/<包>.md 优先于一切，且不能借包名穿越目录；
//   2. 本机 WorkBuddy 缓存优先于网络（本机明明有正文，不该被 404 挡掉）；
//   3. 本机也没有时回落公开分发地址；
//   4. 上游明确缺包（404 / 410）时给「兜底人设」，且必须显式标注非原文（否则召唤出来的会话会以为
//      自己就是原作者）；断网 / 超时 / 5xx 是暂时故障，必须如实抛错让用户重试或放本机覆盖，
//      不许静默换成替身——那会让用户以为专家原文就长这样（M6）；
//   5. 任何情况下都不许静默产出空人设，也不许把裸 404 抛到界面上把专家变成不可用。
//
// 用法：node ./test/expert-persona-source.mjs

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 隔离：目录缓存与本机 WorkBuddy 缓存都指到临时目录，不碰真实 ~/.dsh 与 ~/.workbuddy。
const MARKET_HOME = join(tmpdir(), `dsh-armory-persona-${process.pid}`);
const WB_CACHE = join(tmpdir(), `dsh-armory-wbcache-${process.pid}`);
process.env.DSH_ARMORY_MARKET_HOME = MARKET_HOME;
process.env.DSH_ARMORY_WORKBUDDY_CACHE = WB_CACHE;

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};

const ORIGIN = "https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace";
const OVERRIDES = join(MARKET_HOME, "experts", "overrides");

const entry = (plugin, zh, overrides = {}) => ({
  id: plugin,
  plugin,
  agentName: plugin,
  expertType: "agent",
  categoryId: "15-BackToSchool",
  displayName: { zh, en: plugin },
  profession: { zh: "测试职业", en: "Test" },
  description: { zh: "测试用专家", en: "test expert" },
  promptFile: `/plugins/${plugin}/agents/${plugin}.md`,
  avatar: `/avatars/${plugin}.png`,
  tags: [{ zh: "测试", en: "test" }],
  quickPrompts: [{ zh: "试试这样问", en: "try this" }],
  ...overrides,
});

async function seedManifest() {
  const dir = join(MARKET_HOME, "experts");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "expert_center.json"),
    JSON.stringify({
      version: "1.0.0",
      lastUpdated: "2026-08-18T03:00:00Z",
      author: { name: "AI Expert Center", source: "https://example.test/agents", license: "MIT" },
      categories: [{ id: "15-BackToSchool", name: { zh: "开学季", en: "Back to School" }, description: { zh: "", en: "" } }],
      experts: [
        entry("demo-local", "本机有缓存"),
        entry("demo-cdn", "只有 CDN"),
        entry("demo-missing", "上游缺包"),
        entry("demo-down", "网络故障"),
        entry("demo-alt", "文件名不一致"),
        entry("demo-empty", "缓存里是空文件"),
        entry("demo-override", "本机覆盖优先"),
        entry("demo-blank-override", "覆盖文件是空的"),
        entry("demo-bare", "清单字段几乎全缺", {
          description: { zh: "", en: "" },
          tags: [],
          quickPrompts: [],
        }),
        // 中文 agentName：WorkBuddy 的 agents 目录本来就允许非 ASCII 文件名，
        // 用 [a-zA-Z0-9] 白名单重建会导致明明缓存里有正文却取不到（M7）。
        entry("demo-unicode", "中文文件名的人设", { agentName: "中文专家" }),
        // agentName 试图穿越 agents/ 目录：只该在 agents/ 内按文件名找。
        entry("demo-agent-traversal", "agentName 穿越", { agentName: "../evil" }),
        // 穿越尝试：safeSegment 之后只该在 overrides/ 内找它。
        entry("../evil", "穿越尝试"),
      ],
    }),
  );
  // meta.json 留空 ETag：清单只会走磁盘（网络分支在替身里必然失败）。
  await writeFile(join(dir, "meta.json"), JSON.stringify({ etag: "", fetchedAt: Date.now() }));
}

/** 往本机 WorkBuddy 缓存里造一个专家包。 */
async function seedWorkbuddyExpert(plugin, { agentFileName = `${plugin}.md`, persona = "", pluginJson = true } = {}) {
  const root = join(WB_CACHE, plugin, "1.2.0");
  await mkdir(join(root, "agents"), { recursive: true });
  if (persona !== null) await writeFile(join(root, "agents", agentFileName), persona);
  if (pluginJson) {
    await mkdir(join(root, ".codebuddy-plugin"), { recursive: true });
    await writeFile(
      join(root, ".codebuddy-plugin", "plugin.json"),
      JSON.stringify({ name: plugin, version: "1.2.0", agentName: plugin, skills: [] }),
    );
  }
}

async function seedOverride(fileName, text) {
  await mkdir(OVERRIDES, { recursive: true });
  await writeFile(join(OVERRIDES, fileName), text);
}

await seedManifest();
await seedWorkbuddyExpert("demo-local", { persona: "# 本机人设\n\n你来自本机 WorkBuddy 缓存。\n" });
await seedWorkbuddyExpert("demo-alt", { agentFileName: "the-only-one.md", persona: "# 唯一份人设\n" });
await seedWorkbuddyExpert("demo-unicode", { agentFileName: "中文专家.md", persona: "# 中文人设\n" });
await seedWorkbuddyExpert("demo-agent-traversal", { agentFileName: "evil.md", persona: "# agents 内的人设\n" });
// agents/ 之外放一份同名字诱饵：agentName 若被当成路径拼接，就会读到它。
await writeFile(join(WB_CACHE, "demo-agent-traversal", "1.2.0", "evil.md"), "# 穿越诱饵\n");
await seedWorkbuddyExpert("demo-empty", { persona: "   \n\n" });
// 覆盖与缓存同时存在：必须覆盖赢。
await seedWorkbuddyExpert("demo-override", { persona: "# 缓存人设\n\n缓存里的旧版本。\n" });
await seedOverride("demo-override.md", "# 覆盖人设\n\n这份来自本机覆盖目录。\n");
// 空白覆盖文件不算命中，应该继续走到缓存。
await seedWorkbuddyExpert("demo-blank-override", { persona: "# 缓存兜底\n" });
await seedOverride("demo-blank-override.md", "   \n\n");
// 穿越尝试：overrides/ 里一份真文件 + experts/ 下一份诱饵，读错就会拿到诱饵。
await seedOverride("evil.md", "# 覆盖 evil\n");
await writeFile(join(MARKET_HOME, "experts", "evil.md"), "# 诱饵\n");

// fetch 替身：只放行 demo-cdn 的人设，其余一律按剧本失败。记录所有命中，用来断言「没联网」。
// 返回体照 fetchWithLimits 实际用到的字段造（ok / status / headers / arrayBuffer），不引 Response。
const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  arrayBuffer: async () => Buffer.from(body, "utf8"),
});
const calls = [];
globalThis.fetch = async (url) => {
  const target = String(url);
  calls.push(target);
  if (target.includes("expert_center.json")) throw new Error("测试期间不联网");
  if (target.endsWith("/plugins/demo-cdn/agents/demo-cdn.md")) return reply("# CDN 人设\n");
  if (target.endsWith("/plugins/demo-cdn/.codebuddy-plugin/plugin.json")) return reply("{}");
  if (target.endsWith("/plugins/demo-override/agents/demo-override.md")) return reply("# 不该被读到的 CDN 人设\n");
  if (target.endsWith("/plugins/demo-down/agents/demo-down.md")) throw new Error("The operation was aborted due to timeout");
  return reply("NoSuchKey", 404);
};

const { wbExpertDetail } = await import(new URL("../lib/expert-market.js", import.meta.url).href);

try {
  // ── 1. 本机覆盖优先于缓存与网络 ───────────────────────────────────────
  {
    calls.length = 0;
    const detail = await wbExpertDetail({ plugin: "demo-override" });
    ok("本机覆盖：内容取自覆盖文件", detail.persona.includes("这份来自本机覆盖目录"), detail.personaSource);
    ok("本机覆盖：标注 personaSource=override", detail.personaSource === "override");
    ok(
      "本机覆盖：不请求人设地址（缓存与 CDN 都不该被读）",
      calls.every((url) => url.endsWith("/expert_center.json")),
      `calls=${calls.map((url) => url.replace(ORIGIN, "")).join(",") || "0"}`,
    );
  }

  // ── 2. 空白覆盖不算命中，继续回落缓存 ────────────────────────────────
  {
    const detail = await wbExpertDetail({ plugin: "demo-blank-override" });
    ok("空白覆盖：当作没写，回落到本机缓存", detail.persona.includes("缓存兜底") && detail.personaSource === "workbuddy-cache", detail.personaSource);
  }

  // ── 3. 包名穿越：只许读 overrides/ 内被净化后的文件名 ─────────────────
  {
    const detail = await wbExpertDetail({ plugin: "../evil" });
    ok("包名穿越：读到 overrides/evil.md", detail.persona.includes("覆盖 evil"), detail.personaSource);
    ok("包名穿越：不会读到 overrides 之外的诱饵文件", !detail.persona.includes("诱饵"));
  }

  // ── 4. 本机缓存优先，且完全不联网 ─────────────────────────────────────
  {
    calls.length = 0;
    const detail = await wbExpertDetail({ plugin: "demo-local" });
    ok("本机缓存命中：返回人设正文", detail.persona.includes("你来自本机 WorkBuddy 缓存"), `chars=${detail.personaChars}`);
    ok("本机缓存命中：标注 personaSource=workbuddy-cache", detail.personaSource === "workbuddy-cache", detail.personaSource);
    // 目录本身每次进程都要探一次 ETag（拿不到就用磁盘），这不算人设请求。
    ok(
      "本机缓存命中：没有为人设发过任何请求",
      calls.every((url) => url.endsWith("/expert_center.json")),
      `calls=${calls.map((url) => url.replace(ORIGIN, "")).join(",") || "0"}`,
    );
    ok("本机缓存命中：plugin.json 版本照常带出", detail.version === "1.2.0", detail.version);
  }

  // ── 5. 本机没有时回落 CDN ─────────────────────────────────────────────
  {
    calls.length = 0;
    const detail = await wbExpertDetail({ plugin: "demo-cdn" });
    ok("回落 CDN：返回正文", detail.persona.includes("# CDN 人设"), `chars=${detail.personaChars}`);
    ok("回落 CDN：标注 personaSource=cdn", detail.personaSource === "cdn", detail.personaSource);
    ok("回落 CDN：确实请求了 promptFile 指定的地址", calls.some((url) => url === `${ORIGIN}/plugins/demo-cdn/agents/demo-cdn.md`));
    ok("回落 CDN：没有 personaNotice", detail.personaNotice === "");
  }

  // ── 6. 上游缺包（404）：不再抛错，给标注非原文的兜底人设 ──────────────
  {
    let detail = null;
    let message = "";
    try {
      detail = await wbExpertDetail({ plugin: "demo-missing" });
    } catch (error) {
      message = String(error?.message || error);
    }
    ok("404：不再抛错（专家必须仍然可用）", detail !== null, message.slice(0, 60));
    if (detail) {
      ok("404：标注 personaSource=generated", detail.personaSource === "generated", detail.personaSource);
      ok("404：正文第一屏就写明不是原文", detail.persona.includes("这份人设不是原文"), detail.persona.slice(0, 30));
      ok("404：正文带上专家名与职业", detail.persona.includes("上游缺包") && detail.persona.includes("测试职业"));
      ok("404：带上官方介绍与示例问题", detail.persona.includes("测试用专家") && detail.persona.includes("试试这样问"));
      ok("404：带上标签", detail.persona.includes("测试"));
      ok("404：给出覆盖文件的具体路径", detail.persona.includes("/overrides/demo-missing.md"));
      ok("404：notice 说明是上游缺包而非网络问题", detail.personaNotice.includes("404"), detail.personaNotice);
      ok("404：正文不是空壳（有工作原则与开场）", detail.persona.includes("## 工作原则") && detail.persona.includes("## 开场"));
    }
  }

  // ── 7. 网络故障：不伪造人设，抛可操作的错误（只有上游 404/410 才兜底）──
  {
    let detail = null;
    let message = "";
    try {
      detail = await wbExpertDetail({ plugin: "demo-down" });
    } catch (error) {
      message = String(error?.message || error);
    }
    ok("网络故障：不再伪造替身人设（detail 必须为空）", detail === null);
    ok("网络故障：错误说明拉取失败并要求检查网络", message.includes("拉取专家人设失败") && message.includes("请检查网络"), message.slice(0, 80));
    ok("网络故障：不冒充上游缺包（错误里没有 404）", !message.includes("404"));
    ok("网络故障：给出本机覆盖目录这一兜底路径", message.includes("覆盖目录"));
  }

  // ── 8. 人设文件名与 plugin 不一致时，接受 agents/ 下唯一那份 md ────────
  {
    calls.length = 0;
    const detail = await wbExpertDetail({ plugin: "demo-alt" });
    ok("文件名不一致：仍能从本机缓存取到", detail.persona.includes("唯一份人设"), detail.personaSource);
    ok("文件名不一致：同样不联网", calls.length === 0);
  }

  // ── 8b. 非 ASCII agentName / agentName 穿越 ─────────────────────────────
  {
    const uni = await wbExpertDetail({ plugin: "demo-unicode" });
    ok("中文 agentName：能读到 agents/中文专家.md", uni.persona.includes("中文人设") && uni.personaSource === "workbuddy-cache", uni.personaSource);
    const trav = await wbExpertDetail({ plugin: "demo-agent-traversal" });
    ok("agentName 穿越：只读 agents/ 内的文件", trav.persona.includes("agents 内的人设"), trav.personaSource);
    ok("agentName 穿越：不会读到 agents/ 之外的诱饵", !trav.persona.includes("穿越诱饵"));
  }

  // ── 9. 缓存里是空白文件 → 不算命中，最终落到兜底人设 ──────────────────
  {
    const detail = await wbExpertDetail({ plugin: "demo-empty" });
    ok("空白人设：不当作命中，落到兜底生成", detail.personaSource === "generated", detail.personaSource);
    ok("空白人设：兜底正文非空且标注非原文", detail.persona.includes("这份人设不是原文"));
    ok("空白人设：原因仍指向上游 404", detail.personaNotice.includes("404"), detail.personaNotice);
  }

  // ── 10. 清单字段几乎全缺时，兜底人设依然可用 ────────────────────────
  {
    const detail = await wbExpertDetail({ plugin: "demo-bare" });
    ok("字段缺失：仍生成非空人设", detail.personaSource === "generated" && detail.personaChars > 200, `chars=${detail.personaChars}`);
    ok("字段缺失：不出现 undefined / null 字面量", !/undefined|null/.test(detail.persona));
    ok("字段缺失：说明没有介绍文字", detail.persona.includes("没有为它提供介绍文字"));
  }

  // ── 11. 源码纪律：召唤写盘前必须先拿到人设 ───────────────────────────
  {
    const { readFile } = await import("node:fs/promises");
    const indexSource = await readFile(new URL("../lib/index.js", import.meta.url), "utf8");
    const summonAt = indexSource.indexOf("async wbExpertSummon(payload)");
    // P0-1 之后召唤链改经懒加载模块（expertApi.wbExpertDetail），针跟着改为方法名调用。
    const detailAt = indexSource.indexOf(".wbExpertDetail({ plugin })", summonAt);
    const writeAt = indexSource.indexOf("withPatchWrite(this.ctx", summonAt);
    ok("wbExpertSummon 先取详情（人设失败即整体不动）", summonAt >= 0 && detailAt > summonAt && writeAt > detailAt, `summon=${summonAt} detail=${detailAt} write=${writeAt}`);
  }
} finally {
  await rm(MARKET_HOME, { recursive: true, force: true }).catch(() => {});
  await rm(WB_CACHE, { recursive: true, force: true }).catch(() => {});
}

console.log(failures === 0 ? "\nEXPERT-PERSONA-SOURCE PASS" : `\nEXPERT-PERSONA-SOURCE FAIL（${failures} 项）`);
process.exit(failures === 0 ? 0 : 1);
