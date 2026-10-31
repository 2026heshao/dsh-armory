// R7 增强：连接器凭据获取通道。
//
// 覆盖三件事：
//   1. 纯函数边界：只放行 https；排除 MCP 端点 / 示例域名 / 图片 / 凭据拼接参数；
//   2. 提取质量：鉴权章节里的控制台 / api-keys 命中，错误处理与工具说明不得冒充；
//   3. 真实 ZIP 投影：110+ 条 token 连接器每条都有 authHelp，且占位符与目录一致。
// 真实 ZIP 不存在时第 3 节 SKIP（与 auth-gate-regression 同惯例）。
import {
  buildAuthHelp,
  extractCredentialLinks,
  extractCredentialNote,
  placeholderKind,
  providerSiteOf,
  safeHttpsUrl,
} from "../lib/connector-auth-help.js";
import { wbConnectorCatalog } from "../lib/wb-market.js";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let failed = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failed += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const section = (name) => console.log(`\n── ${name} ──`);

section("1. URL 与域名边界");
{
  ok("https 原样放行", safeHttpsUrl("https://console.example.cn/api-keys") === "https://console.example.cn/api-keys");
  ok("http 不放行", safeHttpsUrl("http://console.example.cn/api-keys") === "");
  ok("javascript 不放行", safeHttpsUrl("javascript:alert(1)") === "");
  ok("示例域名不放行", safeHttpsUrl("https://app.example.com/key") === "");
  ok("未替换占位符不放行", safeHttpsUrl("https://x.cn/${TOKEN}") === "");
  ok("图片地址不放行", safeHttpsUrl("https://x.cn/logo.png") === "");

  ok("api.tushare.pro → tushare.pro", providerSiteOf("https://api.tushare.pro/mcp") === "https://tushare.pro/");
  ok("mcp.cnfic.com.cn → cnfic.com.cn", providerSiteOf("https://mcp.cnfic.com.cn/mcp") === "https://cnfic.com.cn/");
  ok("公共大站 qq.com 不反推", providerSiteOf("https://bugly.tds.qq.com/mcp") === "");
  ok("IP 不反推", providerSiteOf("http://47.100.55.122/mcp") === "");
}

section("2. 占位符类型");
{
  ok("API_KEY → token", placeholderKind("TUSHARE_TOKEN") === "token" && placeholderKind("API_KEY") === "token");
  ok("CLIENT_ID → clientId", placeholderKind("CLIENT_ID") === "clientId");
  ok("CLIENT_SECRET → clientSecret", placeholderKind("CLIENT_SECRET") === "clientSecret");
  ok("PASSWORD → password", placeholderKind("ZFS_PASSWORD") === "password");
  ok("ORG_CODE → identifier", placeholderKind("ORG_CODE") === "identifier");
  ok("BASE_URL → endpoint", placeholderKind("PLUGIN_BASE_URL") === "endpoint");
}

section("3. 从 SKILL.md 提取入口");
{
  const text = [
    "# 示例连接器",
    "## 鉴权说明",
    "用户需要到控制台申请 API Key：",
    "- 打开 https://console.example.cn/api-keys 生成 API Key",
    "- MCP 端点：https://mcp.example.cn/mcp",
    "- 示意图：https://cdn.example.cn/a.png",
    "## 其它",
    "https://www.example.cn/pricing",
  ].join("\n");
  const links = extractCredentialLinks(text, {
    placeholders: ["EXAMPLE_API_KEY"],
    serverUrls: ["https://mcp.example.cn/mcp"],
  });
  ok("命中 api-keys 并标为 credential", links.some((row) => row.url === "https://console.example.cn/api-keys" && row.kind === "credential"));
  ok("排除 MCP 端点自身", !links.some((row) => row.url === "https://mcp.example.cn/mcp"));
  ok("排除图片", !links.some((row) => row.url.includes(".png")));
  ok("有强入口时不带 pricing", !links.some((row) => row.url.includes("/pricing")));

  const queryToken = extractCredentialLinks("鉴权：https://api.example.cn/v1/mcp?token=abc", {
    placeholders: ["TOKEN"],
    serverUrls: ["https://api.example.cn/v1/mcp"],
  });
  ok("排除带 token= 的 API 端点", !queryToken.some((row) => row.url.includes("token=")));

  const settingsMcp = extractCredentialLinks("## 鉴权\n到 https://chat.example.cn/settings/mcp 获取密钥", {
    placeholders: ["KEY"],
    serverUrls: ["https://mcp.example.cn/mcp"],
  });
  ok("/settings/mcp 是凭据页，不能被当成 MCP 端点误杀",
    settingsMcp.some((row) => row.url === "https://chat.example.cn/settings/mcp"));
}

section("4. 文档摘录只留获取步骤");
{
  const good = extractCredentialNote(
    "## 鉴权\n用户需在控制台 → 开放平台 创建 API Key。\n401 时请重试。\n工具：get_user 获取用户。",
    { placeholders: ["API_KEY"] },
  );
  ok("保留控制台获取指引", good.includes("控制台") && good.includes("API Key"));
  ok("剔除 401 / 工具说明", !good.includes("401") && !good.includes("get_user"));

  const negative = extractCredentialNote("## 鉴权\n无需额外登录，凭据已在本机填入。", { placeholders: ["API_KEY"] });
  ok("否定句不当作获取步骤", negative === "");

  const description = extractCredentialNote("## 说明\ndescription: 使用说明，覆盖 57 个工具和凭证参数。", { placeholders: ["API_KEY"] });
  ok("说明段不当作获取步骤", description === "");
}

section("5. buildAuthHelp 投影");
{
  ok("无占位符 → null", buildAuthHelp({ connectorId: "x", name: "X", tokenSlots: [] }) === null);

  const tushare = buildAuthHelp({
    connectorId: "tushare",
    name: "Tushare",
    tokenSlots: [{ placeholder: "TUSHARE_TOKEN" }],
    mcpServers: { tushare: { url: "https://api.tushare.pro/mcp/?token=${TUSHARE_TOKEN}" } },
  });
  ok("人工核过的入口优先", tushare.links[0].url === "https://tushare.pro/user/token" && tushare.source === "curated");

  const skill = buildAuthHelp({
    connectorId: "demo",
    name: "Demo",
    tokenSlots: [{ placeholder: "DEMO_API_KEY" }],
    mcpServers: { demo: { url: "https://api.demo.cn/mcp" } },
    skillTexts: ["## 认证前置\n在 https://console.demo.cn/api-keys 生成 API Key。"],
  });
  ok("随包文档命中 → source=skill", skill.source === "skill");
  ok("具体凭据页在前，官网根地址补充在后",
    skill.links[0].kind === "credential" && skill.links.some((link) => link.kind === "official"));
  ok("链接数量不超过 3", skill.links.length <= 3);
  ok("所有链接都是 https", skill.links.every((link) => /^https:\/\//.test(link.url)));

  const fallback = buildAuthHelp({
    connectorId: "stdio-demo",
    name: "Stdio Demo",
    tokenSlots: [{ placeholder: "DEMO_TOKEN" }],
    mcpServers: { demo: { command: "npx", args: ["-y", "demo"] } },
  });
  ok("无官网可推 → 搜索兜底", fallback.links.length === 1 && fallback.links[0].kind === "search");
  ok("搜索链接只含 https 且带服务商名", /^https:\/\/www\.bing\.com\/search\?/.test(fallback.links[0].url)
    && decodeURIComponent(fallback.links[0].url).includes("Stdio Demo"));
}

section("6. 真实目录投影（无缓存则 SKIP）");
let catalog = null;
try {
  catalog = await wbConnectorCatalog();
} catch {
  catalog = null;
}
if (!catalog || !Array.isArray(catalog.connectors) || !catalog.connectors.length) {
  console.log("SKIP  6. 目录不可用（无本地索引缓存）");
} else {
  const tokenRows = catalog.connectors.filter((row) => row.needsTokens === true);
  ok("token 型连接器都有 authHelp", tokenRows.length > 0 && tokenRows.every((row) => row.authHelp && typeof row.authHelp === "object"),
    `n=${tokenRows.length}`);
  ok("authHelp 占位符与 tokenSlots 完全一致", tokenRows.every((row) => {
    const fromSlots = [...new Set((row.tokenSlots || []).map((slot) => slot.placeholder).filter(Boolean))].sort();
    const fromHelp = [...(row.authHelp?.placeholders || [])].sort();
    return JSON.stringify(fromSlots) === JSON.stringify(fromHelp);
  }));
  ok("所有链接都是 https", tokenRows.every((row) => (row.authHelp?.links || []).every((link) => /^https:\/\//.test(link.url))));
  ok("链接数量不超过 3", tokenRows.every((row) => (row.authHelp?.links || []).length <= 3));
  ok("每条至少有 1 个入口", tokenRows.every((row) => (row.authHelp?.links || []).length >= 1));
  ok("摘录不含未替换占位符 / 序列化残骸", tokenRows.every((row) => {
    const note = String(row.authHelp?.note || "");
    return !note.includes("${") && !note.includes("[object");
  }));

  const byId = new Map(catalog.connectors.map((row) => [row.id, row]));
  const expectCredential = ["tushare", "baidu-maps", "ofdh-doc-convert", "guiputi-intent-card", "chinacscs-data", "msy-brandct"];
  for (const id of expectCredential) {
    const row = byId.get(id);
    if (!row) continue;
    ok(`${id} 有具体凭据页`, (row.authHelp?.links || []).some((link) => link.kind === "credential"),
      JSON.stringify((row.authHelp?.links || []).map((link) => link.url)));
  }
  const oauthRows = catalog.connectors.filter((row) => row.needsOAuth === true);
  ok("OAuth 型不走令牌指引", oauthRows.every((row) => !row.authHelp), `n=${oauthRows.length}`);
}

section("7. 详情页把凭据入口放在正文之前");
{
  const here = dirname(fileURLToPath(import.meta.url));
  const client = await readFile(join(here, "..", "lib", "client.js"), "utf8");
  const detailStart = client.indexOf("t('连接器详情')");
  const top = client.indexOf("dsh-mcp-credential-top", detailStart);
  const desc = client.indexOf("dsh-mcp-wb-modal-desc", detailStart);
  ok("详情弹层可定位", detailStart >= 0 && top > detailStart && desc > detailStart,
    `start=${detailStart} top=${top} desc=${desc}`);
  ok("凭据获取块排在简介正文之前", top > 0 && top < desc);
  ok("token 型顶部直接渲染 AuthHelpBlock", client.slice(top, top + 1800).includes("h(AuthHelpBlock, { help: connectorDetail.authHelp })"));
  ok("AuthHelpBlock 在详情里只出现一次（不再沉到正文之后）",
    (client.match(/h\(AuthHelpBlock, \{ help: connectorDetail\.authHelp \}\)/g) || []).length === 1);
  ok("OAuth 型顶部有「去授权 / 我已有令牌」两个入口",
    client.slice(top, top + 2200).includes("children: t('去授权')")
    && client.slice(top, top + 2200).includes("children: t('我已有令牌')"));
  ok("服务端代持型顶部有说明", client.slice(top, top + 2600).includes("该连接器的凭据由服务端代持"));
  // QQ邮箱 / 腾讯文档 / ima 这类目录没写 auth_mode 的远程连接器：不能因为「没声明」就
  // 什么都不显示——顶部的「安装并探测」就是可执行路径。
  ok("未声明鉴权的可安装 HTTP 连接器有兜底入口",
    client.slice(top, top + 4200).includes("目录未声明鉴权")
    && client.slice(top, top + 4200).includes("children: busy ? t('安装中…') : t('安装并探测')"));
}

console.log(failed === 0 ? "\nCONNECTOR-AUTH-HELP PASS" : `\n${failed} CHECK(S) FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
