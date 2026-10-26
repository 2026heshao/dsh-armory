// issue #4（2026-10-26）数据层回归：技能详情的 name / description / homepage 映射。
//
// 用户报的三条里，前两条都源自同一个上游形状变化：
//   · 列表接口的 homepage 实际是 `https://api.skillhub.cn/<namespace>/<slug>`——JSON 接口，
//     浏览器打开 405；人可读页面在 `https://skillhub.cn/...`（实测 200 text/html）。
//   · 详情接口把技能本体挂在 `skill` 子对象下，字段名是 displayName / summary_zh / summary /
//     iconUrl；根层没有 name / description / homepage。旧实现只读根层，于是标题退化成 slug、
//     介绍空白。
//
// 手法：真 import lib/wb-market.js，只把 globalThis.fetch 换成按 URL 返回固定 JSON 的替身。
// 零真实网络、零 ~/.dsh 读写（这两个函数不碰缓存目录）。断言的是**行为**：
// 同一份用户提供的真实响应形状进来，映射出来的字段必须完整、可浏览。
//
// 用法：node ./test/skillhub-detail-fix.mjs

import { skillhubHomepage, wbSkillCatalog, wbSkillDetail } from "../lib/wb-market.js";

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};
const section = (title) => console.log(`\n── ${title} ─────────────────────────────────────────────`);

// ── 0. 纯函数：homepage 归一 ───────────────────────────────────────────────
section("0. skillhubHomepage：只把接口地址换成公开页");
{
  const api = "https://api.skillhub.cn/user_98035bfb/zlbx-bidding";
  ok("0.1 api.skillhub.cn 的 JSON 地址 → skillhub.cn 公开页",
    skillhubHomepage(api, "user_98035bfb", "zlbx-bidding") === "https://skillhub.cn/user_98035bfb/zlbx-bidding",
    skillhubHomepage(api, "user_98035bfb", "zlbx-bidding"));
  ok("0.2 没有 namespace/slug 时只去掉 api. 前缀（不再把接口地址交出去）",
    skillhubHomepage(api) === "https://skillhub.cn/user_98035bfb/zlbx-bidding",
    skillhubHomepage(api));
  ok("0.3 homepage 缺失时用 namespace + slug 拼公开页",
    skillhubHomepage("", "user_98035bfb", "zlbx-bidding") === "https://skillhub.cn/user_98035bfb/zlbx-bidding");
  ok("0.4 GitHub 等其它可浏览地址原样保留",
    skillhubHomepage("https://github.com/o/r", "user_x", "skill") === "https://github.com/o/r");
  ok("0.5 形似域名（api.skillhub.cn.evil）不被误判",
    skillhubHomepage("https://api.skillhub.cn.evil.example/x", "u", "s") === "https://api.skillhub.cn.evil.example/x");
  ok("0.6 非法 URL 原样返回（不抛错）", skillhubHomepage("not a url", "u", "s") === "not a url");
}

// ── 1. 替身 fetch：按 URL 返回用户报告里的真实响应形状 ──────────────────────
const CATALOG_BODY = {
  data: {
    total: 1,
    skills: [{
      slug: "zlbx-bidding",
      name: "全国招标中标查询及分析【知了标讯】",
      namespace: { handle: "user_98035bfb", displayName: "user_98035bfb", canonicalName: "@user_98035bfb/zlbx-bidding" },
      iconUrl: "https://example.com/icon.png",
      // 上游真实值：JSON 接口地址。
      homepage: "https://api.skillhub.cn/user_98035bfb/zlbx-bidding",
      upstream_url: "https://clawhub.ai/user_98035bfb/zlbx-bidding",
      description_zh: "列表里的中文介绍",
      downloads: 160075,
      updated_at: 1792817295000,
    }],
  },
};

const DETAIL_BODY = {
  contentZhAvailable: false,
  latestVersion: { version: "2.5.6", changelog: "版本说明" },
  namespace: { handle: "user_98035bfb", displayName: "user_98035bfb", canonicalName: "@user_98035bfb/zlbx-bidding" },
  owner: { displayName: "user_98035bfb" },
  securityReports: {
    keen: { status: "benign" },
    sanbu: { status: "benign" },
  },
  skill: {
    displayName: "全国招标中标查询及分析【知了标讯】",
    summary: "英文/通用摘要",
    summary_zh: "完整中文介绍（418 字）",
    iconUrl: "https://example.com/icon-detail.png",
    createdAt: 1775204455588,
    category: "business-ops",
    source: "community",
    slug: "zlbx-bidding",
  },
  slug: "zlbx-bidding",
};

const requests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  requests.push(String(url));
  const target = String(url);
  const body = target.includes("/api/v1/skills/") ? DETAIL_BODY : CATALOG_BODY;
  return new globalThis.Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

try {
  // ── 2. 列表：homepage 归一，upstream 保真 ─────────────────────────────────
  section("2. wbSkillCatalog：卡片上的 homepage 不再指向接口");
  {
    const catalog = await wbSkillCatalog({ page: 1, pageSize: 20 });
    const row = catalog.skills[0];
    ok("2.1 列表 homepage → 公开页", row.homepage === "https://skillhub.cn/user_98035bfb/zlbx-bidding", row.homepage);
    ok("2.2 upstreamUrl 保留真实外部来源", row.upstreamUrl === "https://clawhub.ai/user_98035bfb/zlbx-bidding", row.upstreamUrl);
    ok("2.3 列表其它字段不受影响", row.name === "全国招标中标查询及分析【知了标讯】" && row.description === "列表里的中文介绍");
  }

  // ── 3. 详情：从 skill 子对象取中文名与完整介绍 ────────────────────────────
  section("3. wbSkillDetail：标题不再退化成 slug、介绍不再空白");
  {
    const detail = await wbSkillDetail({ slug: "zlbx-bidding", namespace: "user_98035bfb" });
    ok("3.1 name 取 skill.displayName（不是 slug）", detail.name === "全国招标中标查询及分析【知了标讯】", detail.name);
    ok("3.2 description 取 skill.summary_zh（完整介绍）", detail.description === "完整中文介绍（418 字）", detail.description);
    ok("3.3 homepage 永远是可浏览的公开页", detail.homepage === "https://skillhub.cn/user_98035bfb/zlbx-bidding", detail.homepage);
    ok("3.4 iconUrl 透出详情图标", detail.iconUrl === "https://example.com/icon-detail.png");
    ok("3.5 发布方/创建时间/分类等仍可用",
      detail.ownerName === "user_98035bfb" && detail.createdAt === 1775204455588 && detail.category === "business-ops");
    ok("3.6 版本与安全报告不变", detail.version === "2.5.6" && detail.security.join(",") === "benign,benign");
    ok("3.7 请求确实打到了详情端点（namespace 被带上）",
      requests.some((url) => url.includes("/api/v1/skills/zlbx-bidding") && url.includes("namespace=user_98035bfb")),
      requests.join(" | "));
  }

  // ── 4. 回退链：summary_zh → summary → 根层旧字段 → slug ──────────────────
  section("4. 回退链：上游字段缺失时逐级降落");
  {
    const before = DETAIL_BODY.skill;
    DETAIL_BODY.skill = { summary_zh: "", summary: "只有通用摘要" };
    const onlySummary = await wbSkillDetail({ slug: "zlbx-bidding", namespace: "user_98035bfb" });
    ok("4.1 空 summary_zh 不挡住 summary 回退", onlySummary.description === "只有通用摘要", onlySummary.description);
    ok("4.2 缺 displayName 时回落 slug", onlySummary.name === "zlbx-bidding", onlySummary.name);

    // 根层旧字段是 2.4.0 之前的兼容形状：skill 子对象缺席时仍要能读出介绍。
    DETAIL_BODY.skill = {};
    DETAIL_BODY.description_zh = "根层旧字段介绍";
    const legacy = await wbSkillDetail({ slug: "zlbx-bidding", namespace: "user_98035bfb" });
    ok("4.3 skill 子对象为空时回落根层 description_zh", legacy.description === "根层旧字段介绍", legacy.description);

    DETAIL_BODY.skill = before;
    delete DETAIL_BODY.description_zh;
  }
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\n${failures === 0 ? "SKILLHUB-DETAIL-FIX PASS" : `${failures} FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
