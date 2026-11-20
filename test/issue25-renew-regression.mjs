// QA 独立回归：issue #25（tyc-mcp 天眼查连接器）三处修复。
//
// 【背景】用户报「连接器市场安装天眼查后无任何配置提示、连接失败且面板直接渲染
// 一段 HTML 报错页」。审查结论（详见 2026-11-18 工作日志）：
//   ① 2.5.8 的装前探测遇 needsAuth 已阻断写入，reporter 的「装成功」实际走的是
//      两条静默放行通道：probe unreachable（fetch 抛错）或 WAF 回 HTML 200。
//   ② 已授权连接器的令牌从不自动续期（ensureAccessToken 只有手动刷新一个调用方），
//      天眼查 expires_in=900s，授权成功 15 分钟后连接必挂。
//   ③ lastError 里的原始 HTML 直出面板。
//
// 【本套件钉住的契约】
//   A. 探测 unreachable 且定义无任何凭据通道（无 headers.authorization、无 ${...}
//      占位符）→ 回 warning:"probe-unreachable-no-credentials"；有凭据通道则照旧放行。
//   B. 探测收到 200 + HTML 拦截页 → 回 warning:"gateway-html"，正文经
//      summarizeErrorBody 净化（剥标签、标注疑似网关拦截页）；401 + HTML 仍是 needsAuth。
//   C. probeMcpServersAuthorization 聚合 needsAuth 与 warnings 两张清单。
//   D. listTokenRecords 清点令牌库：坏文件/非 JSON/缺 serverUrl 一律静默跳过。
//   E. 静态不变式：wbOAuthRenewAll 已注册为 Remote 端点、续期后回写配置
//      （rewriteBearerTokenEverywhere）、面板有续期定时器与 lastError 净化。
//
// 【运行】node ./test/issue25-renew-regression.mjs   （退出码 0 全过 / 1 有失败）
// 动态项全部走 node:http 本地服务器，零外网、零真实 sleep。
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const LIB = join(here, "..", "lib");

process.env.DSH_ARMORY_MARKET_OFFLINE ||= "1";

const market = await import(new URL("../lib/wb-market.js", import.meta.url).href);
const oauth = await import(new URL("../lib/mcp-oauth.js", import.meta.url).href);

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const section = (title) => console.log(`\n── ${title} ──`);

/** 起一个按给定 status/body 应答 POST 的本地服务器；零外网。 */
async function withProbeServer(status, bodyText, contentType = "application/json") {
  const server = createServer((req, res) => {
    const extraHeaders = {};
    if (status === 401 || status === 403) {
      extraHeaders["www-authenticate"] =
        'Bearer resource_metadata="https://example.invalid/.well-known/oauth-protected-resource"';
    }
    res.writeHead(status, { "content-type": contentType, ...extraHeaders });
    res.end(bodyText);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/mcp`;
  return { url, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** 找一个当前必然拒连的端口：先听后关，拿到的端口在多数环境短暂空闲。 */
async function withDeadPort() {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}/mcp`;
}

// ════════════════════════════════════════════════════════════════════════════
// 第 1 节 · 探测 unreachable：无凭据通道才回 warning（A）
// ════════════════════════════════════════════════════════════════════════════
section("1. 探测 unreachable：无凭据 → warning；有凭据 → 照旧放行");

{
  const url = await withDeadPort();
  const bare = await market.probeServerAuthorization("tyc-mcp", { url, type: "streamableHttp", timeout: 600000 });
  ok(
    "1a  裸 URL（无 headers 无占位符）→ authorized + warning=probe-unreachable-no-credentials",
    bare?.authorized === true && bare?.warning === "probe-unreachable-no-credentials" && bare?.error === "probe-unreachable",
    `warning=${bare?.warning}`,
  );
  const withHeader = await market.probeServerAuthorization("srv", { url, type: "streamableHttp", headers: { authorization: "Bearer abcdef1234567890" } });
  ok(
    "1b  已声明 headers.authorization → 无 warning",
    withHeader?.authorized === true && withHeader?.warning === undefined,
    `warning=${withHeader?.warning}`,
  );
  const withPlaceholder = await market.probeServerAuthorization("srv", { url, type: "streamableHttp", headers: { authorization: "Bearer ${TOKEN}" } });
  ok(
    "1c  占位符槽位（待面板补填）→ 无 warning",
    withPlaceholder?.authorized === true && withPlaceholder?.warning === undefined,
    `warning=${withPlaceholder?.warning}`,
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 第 2 节 · WAF HTML 拦截页：200+HTML 回 warning；401+HTML 仍是 needsAuth（B）
// ════════════════════════════════════════════════════════════════════════════
section("2. WAF HTML 拦截页识别与正文净化");

const WAF_PAGE = `<!DOCTYPE html><html><head><title>Forbidden</title><style>body{color:#333}</style></head><body><p>Your request has been blocked by WAF.</p></body></html>`;

{
  const s = await withProbeServer(200, WAF_PAGE, "text/html");
  try {
    const result = await market.probeServerAuthorization("tyc-mcp", { url: s.url, type: "streamableHttp" });
    ok(
      "2a  200 + HTML → authorized + warning=gateway-html",
      result?.authorized === true && result?.warning === "gateway-html" && result?.status === 200,
      `warning=${result?.warning}`,
    );
    ok(
      "2b  bodyHint 已净化（无标签、带标注）",
      typeof result?.bodyHint === "string"
        && !result.bodyHint.includes("<style")
        && !result.bodyHint.includes("<!DOCTYPE")
        && result.bodyHint.includes("疑似网关/WAF 拦截页"),
      result?.bodyHint?.slice(0, 80),
    );
  } finally {
    await s.close();
  }
}
{
  const s = await withProbeServer(401, WAF_PAGE, "text/html");
  try {
    const result = await market.probeServerAuthorization("tyc-mcp", { url: s.url, type: "streamableHttp" });
    ok(
      "2c  401 + HTML → 仍判 needsAuth（拦截页不掩盖鉴权要求）",
      result?.needsAuth === true && result?.authorized === false,
      `status=${result?.status}`,
    );
    ok(
      "2d  needsAuth 的 bodyHint 同样净化",
      typeof result?.bodyHint === "string" && !result.bodyHint.includes("<style") && result.bodyHint.includes("疑似网关/WAF 拦截页"),
      result?.bodyHint?.slice(0, 80),
    );
  } finally {
    await s.close();
  }
}
{
  const s = await withProbeServer(200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
  try {
    const result = await market.probeServerAuthorization("srv", { url: s.url, type: "streamableHttp" });
    ok(
      "2e  正常 JSON-RPC 200 → 放行且无 warning（防误伤回归）",
      result?.authorized === true && result?.warning === undefined,
      `warning=${result?.warning}`,
    );
  } finally {
    await s.close();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 第 3 节 · 聚合入口：needsAuth 与 warnings 分清单（C）
// ════════════════════════════════════════════════════════════════════════════
section("3. probeMcpServersAuthorization：needsAuth / warnings 双清单");

{
  const s = await withProbeServer(200, WAF_PAGE, "text/html");
  try {
    const result = await market.probeMcpServersAuthorization({
      "tyc-mcp": { url: s.url, type: "streamableHttp" },
    });
    ok(
      "3a  聚合结果带 warnings 清单",
      result?.ok === true && Array.isArray(result?.warnings) && result.warnings.length === 1
        && result.warnings[0]?.warning === "gateway-html" && result.warnings[0]?.serverName === "tyc-mcp",
      `warnings=${JSON.stringify(result?.warnings?.map((w) => w.warning))}`,
    );
  } finally {
    await s.close();
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 第 4 节 · summarizeErrorBody：净化边界（纯函数）
// ════════════════════════════════════════════════════════════════════════════
section("4. summarizeErrorBody 纯函数边界");

{
  ok(
    "4a  普通文本原样折叠截断，不加标注",
    market.summarizeErrorBody("  token parse failed  \n second line") === "token parse failed second line"
      && !market.summarizeErrorBody("token parse failed").includes("疑似网关"),
  );
  const long = market.summarizeErrorBody(WAF_PAGE, { limit: 40 });
  ok("4b  HTML 按指定 limit 截断", long.includes("疑似网关/WAF 拦截页") && long.length <= "[疑似网关/WAF 拦截页，非 MCP 应答] ".length + 40 + 2, `len=${long.length}`);
  ok("4c  空输入不抛错", market.summarizeErrorBody("") === "" && market.summarizeErrorBody(null) === "");
  ok("4d  script/style 内容被整体剥除", !market.summarizeErrorBody("<html><body><script>alert(1)</script>blocked</body></html>").includes("alert(1)"));
}

// ════════════════════════════════════════════════════════════════════════════
// 第 5 节 · listTokenRecords：令牌库清点容错（D）
// ════════════════════════════════════════════════════════════════════════════
section("5. listTokenRecords：坏文件静默跳过");

{
  const home = mkdtempSync(join(tmpdir(), "dsh-oauth-test-"));
  const dir = join(home, "armory-oauth");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "aaa.json"), JSON.stringify({ serverUrl: "https://mcp.example.com/v1", accessToken: "tok-a", expiresAt: "" }));
  writeFileSync(join(dir, "bbb.json"), "{ this is not json");
  writeFileSync(join(dir, "ccc.json"), JSON.stringify({ accessToken: "tok-c" })); // 缺 serverUrl
  writeFileSync(join(dir, "notes.txt"), "not a record");
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const records = await oauth.listTokenRecords();
    ok(
      "5a  只回形状完整的记录",
      Array.isArray(records) && records.length === 1 && records[0]?.serverUrl === "https://mcp.example.com/v1" && records[0]?.accessToken === "tok-a",
      `n=${records?.length}`,
    );
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
}
{
  // 目录不存在（从未授权过）→ 空数组而不是抛错。
  const home = mkdtempSync(join(tmpdir(), "dsh-oauth-empty-"));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const records = await oauth.listTokenRecords();
    ok("5b  无令牌库目录 → 空数组不抛错", Array.isArray(records) && records.length === 0, `n=${records?.length}`);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 第 6 节 · 静态接线不变式：续期链路与面板净化必须真的接上（E）
// ════════════════════════════════════════════════════════════════════════════
section("6. 静态不变式：续期 + 净化的接线");

{
  const indexSrc = readFileSync(join(LIB, "index.js"), "utf8");
  const clientSrc = readFileSync(join(LIB, "client.js"), "utf8");

  ok(
    "6a  wbOAuthRenewAll 注册为 Remote 端点",
    /_wbOAuthRenewAll_decorators = \[Remote\("wbOAuthRenewAll"\)\]/.test(indexSrc)
      && /async wbOAuthRenewAll\(\)/.test(indexSrc),
  );
  ok(
    "6b  续期从令牌库清点出发并按新鲜度跳过",
    /oauthListRecords\(\)/.test(indexSrc) && /oauthTokenIsFresh\(record\)/.test(indexSrc),
  );
  ok(
    "6c  刷新后回写配置（rewriteBearerTokenEverywhere）",
    /rewriteBearerTokenEverywhere\(this\.ctx, oldToken, newToken\)/.test(indexSrc)
      && /async function rewriteBearerTokenEverywhere/.test(indexSrc),
  );
  ok(
    "6d  全局层回写在写锁内做（withPatchWrite）",
    /withPatchWrite\(ctx, async \(\) => \{[\s\S]*?managedState\(ctx\)[\s\S]*?split\(oldToken\)\.join\(newToken\)[\s\S]*?writePatch/.test(indexSrc.slice(indexSrc.indexOf("async function rewriteBearerTokenEverywhere"))),
  );
  ok(
    "6e  项目层回写覆盖工作区并写后对齐连接",
    /writeWorkspaceConfigFile\(wsPath, servers, config\.exclude\)/.test(indexSrc)
      && /alignWorkspaceConnections\(ctx, wsPath\)/.test(indexSrc),
  );
  ok(
    "6f  wbConnectorInstall 把探测 warning 透传面板",
    /const probeWarnings = Array\.isArray\(probe\?\.warnings\)/.test(indexSrc)
      && /missingSlots, localDeps, wrote, probeWarnings \}/.test(indexSrc),
  );
  ok(
    "6g  面板对 lastError 做 HTML 净化",
    /summarizeConnectionError\(server\.lastError\)/.test(clientSrc) && /const summarizeConnectionError = /.test(clientSrc),
  );
  ok(
    "6h  面板有续期定时器（wbOAuthRenewAll + 10 分钟轮询 + 互斥）",
    /call\('wbOAuthRenewAll'\)/.test(clientSrc)
      && /setInterval\(renewConnectorAuths, 10 \* 60 \* 1000\)/.test(clientSrc)
      && /oauthRenewInFlight\.current = true/.test(clientSrc),
  );
  ok(
    "6i  面板安装成功提示包含探测 warning 文案",
    /probeWarnings\.map\(\(item\) => item\?\.warning === 'gateway-html'/.test(clientSrc),
  );
}

console.log(`\n${failures ? `FAILED: ${failures} 项未过` : "ALL PASS"}`);
process.exit(failures ? 1 : 0);
