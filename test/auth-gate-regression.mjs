// QA 独立回归：dsh-armory「市场安装鉴权闸 + 装前 401 探测」（R8 版）。
//
// 【本版改了什么，为什么】
// 上一版的契约是「401/403 一律 throw + auth_mode=oauth 一律拒装」，而这条契约本身
// 就是用户报的那个 bug 的实现——装 OAuth 连接器时面板只会看到
//   连接器 server「westock-mcp」要求授权（HTTP 401）：… DSH 无法自动注入 …
// 浏览器授权页永远不会出现。R8 把契约改成了「能授权就授权」：
//   ① probeServerAuthorization 遇 401/403 **不抛错**，回传结构化结果
//      { authorized:false, needsAuth:true, status, serverName, url, wwwAuthenticate,
//        resourceMetadata }；其它状态码/网络错误/stdio/无 url 一律放行（不把服务器
//      故障误判成「需要授权」）。
//   ② probeMcpServersAuthorization 聚合为 { ok:true, checked, needsAuth:[…] }，把
//      「哪些 server 要授权」交给上层，而不是让整条安装链炸掉。
//   ③ serverInstallability 允许 auth_mode = oauth / oneid-token 安装，并标
//      needsOAuth:true；server-side / mcp 仍是硬拒（那两种确实无法在插件侧自解）。
//   ④ 安装链顺序：先注入已存 token → 再探测 → 探测报 needsAuth 就弹授权框、不再写配置。
//
// 【2026-10-24 追加：ima-mcp 事故】用户报「点安装 MCP 不跳授权页，安装也失败」，实测
// 根因是 ① 的实现写错了类型（详见第 7 节抬头），连带暴露三处缺口：
//   ⑤ ensureAccessToken 的对象返回值被整个字符串化 → `Bearer [object Object]` 落盘；
//   ⑥ 探测只看 401/403，而坏 token 让服务器改回 400 + JSON-RPC 鉴权正文 → 漏判；
//   ⑦ 服务器不做 OAuth 发现时（腾讯 ima 就不做）授权流程只能报错 → 面板把手填令牌
//      那条兜底路开成弹层（manualTokenOnly），不再把用户堵在一行红字前。
// 顺带修掉两条「装不上」：只写 url 不写 type 的远程条目一律撞「未知传输类型」（索引里
// 实有 11 条），以及第 4 节把 catalog.rows 当返回键、导致整节在任何机器上静默 SKIP。
//
// 【被测对象】仓库内 lib/（与 test/mcp-config.mjs 等其它套件一致）。旧版钉死
// ~/.dsh/profiles/desktop/node_modules/dsh-armory/lib 运行时副本并做哈希预检，效果是
// 「改了源码还没部署」就整片 FAIL，把编辑中间态误报成回归。部署由 .deploy-apply.mjs
// 负责，不在本套件里重复校验。
//
// 【运行】node ./test/auth-gate-regression.mjs   （退出码 0 全过 / 1 有失败）
// 动态项全部走 node:http 本地服务器，零外网、零真实 sleep。
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const LIB = join(here, "..", "lib");

const {
  probeServerAuthorization,
  probeMcpServersAuthorization,
  serverInstallability,
  wbConnectorCatalog,
} = await import(new URL("../lib/wb-market.js", import.meta.url).href);
const oauth = await import(new URL("../lib/mcp-oauth.js", import.meta.url).href);

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const section = (title) => console.log(`\n── ${title} ──`);

/** 起一个本地探针服务器：记录收到的请求，按 status 回复。零外网。 */
async function withProbeServer(status, handler, bodyText = null) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      const extraHeaders = {};
      if (status === 401 || status === 403) {
        extraHeaders["www-authenticate"] =
          'Bearer resource_metadata="https://example.invalid/.well-known/oauth-protected-resource"';
      }
      res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
      // bodyText 显式给出时用它：真实网关常在 400 的正文里才说清「这是鉴权问题」。
      res.end(bodyText ?? JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/mcp`;
  try {
    return await handler({ port, seen, url });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// ════════════════════════════════════════════════════════════════════════════
// 第 1 节 · 装前探测：401/403 必须「返回」而不是「抛错」
// ════════════════════════════════════════════════════════════════════════════
section("1. 装前探测：401/403 → 结构化 needsAuth（不抛错）");

await withProbeServer(401, async ({ url, seen }) => {
  let result;
  let threw = false;
  try {
    result = await probeServerAuthorization("westock-mcp", { transport: { type: "http", url } });
  } catch (e) {
    threw = true;
    result = { thrown: String(e?.message || e) };
  }
  ok("1a  401 不抛错", threw === false, threw ? result.thrown : "");
  ok("1a-2 401 → authorized:false", result?.authorized === false);
  ok("1a-3 401 → needsAuth:true", result?.needsAuth === true);
  ok("1a-4 401 → status 透传", result?.status === 401, `status=${result?.status}`);
  ok("1a-5 401 → 回带 serverName", result?.serverName === "westock-mcp", `serverName=${result?.serverName}`);
  ok("1a-6 401 → 回带 url", result?.url === url, `url=${result?.url}`);
  ok(
    "1a-7 401 → 解析出 resource_metadata",
    result?.resourceMetadata === "https://example.invalid/.well-known/oauth-protected-resource",
    `rm=${result?.resourceMetadata}`,
  );
  ok(
    "1a-8 401 → 保留 www-authenticate 原文（供后续发现授权服务器）",
    typeof result?.wwwAuthenticate === "string" && result.wwwAuthenticate.includes("resource_metadata"),
    `wa=${result?.wwwAuthenticate}`,
  );
  ok("1a-9 探测确实发出（非短路返回）", seen.length >= 1, `n=${seen.length}`);
});

await withProbeServer(403, async ({ url }) => {
  const result = await probeServerAuthorization("forbidden-one", { transport: { type: "http", url } });
  ok(
    "1b  403 → 与 401 同构（needsAuth:true）",
    result?.authorized === false && result?.needsAuth === true && result?.status === 403,
    `status=${result?.status}`,
  );
});

await withProbeServer(200, async ({ url }) => {
  const result = await probeServerAuthorization("open-one", { transport: { type: "http", url } });
  ok("1c  200 → authorized:true", result?.authorized === true && result?.status === 200);
  ok("1c-2 200 → 无 needsAuth 标记", !result?.needsAuth);
});

await withProbeServer(500, async ({ url }) => {
  const result = await probeServerAuthorization("broken-one", { transport: { type: "http", url } });
  // 5xx 是服务器故障，不是鉴权要求；硬判「要授权」会把用户引到错误的授权页。
  ok(
    "1d  500 放行（authorized:true + status 透传）",
    result?.authorized === true && result?.status === 500,
    `status=${result?.status}`,
  );
});

await withProbeServer(200, async ({ url, seen }) => {
  await probeServerAuthorization("shape-one", { transport: { type: "http", url } });
  const first = seen[0] || {};
  ok("1e  探测请求为 POST /mcp", first.method === "POST" && first.url === "/mcp", `${first.method} ${first.url}`);
  let body = null;
  try {
    body = JSON.parse(first.body || "{}");
  } catch {
    body = null;
  }
  ok("1e-2 body 是 JSON-RPC initialize", body?.jsonrpc === "2.0" && body?.method === "initialize", `method=${body?.method}`);
  ok("1e-3 initialize 带 protocolVersion", typeof body?.params?.protocolVersion === "string", `pv=${body?.params?.protocolVersion}`);
});

await withProbeServer(401, async ({ url, seen }) => {
  await probeServerAuthorization("header-one", { transport: { type: "http", url, headers: { "x-dsh-probe-canary": "yes" } } });
  ok("1f  mcp.json 声明的 headers 透传", seen[0]?.headers?.["x-dsh-probe-canary"] === "yes", `got=${seen[0]?.headers?.["x-dsh-probe-canary"]}`);
});

{
  // nested transport 也要认（connectors.json 里两种形状都出现过）。
  await withProbeServer(401, async ({ url }) => {
    const nested = await probeServerAuthorization("nested-one", { transport: { type: "http", url } });
    ok("1g  nested.transport.url 被识别", nested?.needsAuth === true, `needsAuth=${nested?.needsAuth}`);
  });
}

{
  const noUrl = await probeServerAuthorization("no-url", { transport: { type: "http" } });
  ok("1h  http 族但无 url → skipped 放行", noUrl?.authorized === true && noUrl?.skipped === true);
  const stdio = await probeServerAuthorization("stdio-one", { command: "npx", args: ["-y", "whatever"] });
  ok("1i  stdio transport → skipped 放行", stdio?.authorized === true && stdio?.skipped === true);
}

// ════════════════════════════════════════════════════════════════════════════
// 第 2 节 · 聚合入口：把「要授权」交上去，而不是整条安装链炸掉
// ════════════════════════════════════════════════════════════════════════════
section("2. probeMcpServersAuthorization：聚合入口回传 needsAuth");

await withProbeServer(401, async ({ url }) => {
  let result;
  let threw = false;
  try {
    result = await probeMcpServersAuthorization({
      "needs-auth": { transport: { type: "http", url } },
      "also-needs": { transport: { type: "http", url } },
    });
  } catch (e) {
    threw = true;
    result = { thrown: String(e?.message || e) };
  }
  ok("2a  任一 401 不抛错", threw === false, threw ? result.thrown : "");
  ok("2a-2 任一 401 → ok:true（安装链可继续走授权）", result?.ok === true);
  ok("2a-3 needsAuth 收集到全部命中项", Array.isArray(result?.needsAuth) && result.needsAuth.length === 2, `n=${result?.needsAuth?.length}`);
  const names = (result?.needsAuth || []).map((x) => x?.serverName).sort();
  ok("2a-4 needsAuth 定位到具体 server", names.join(",") === "also-needs,needs-auth", names.join(","));
});

await withProbeServer(200, async ({ url }) => {
  const result = await probeMcpServersAuthorization({ a: { transport: { type: "http", url } }, b: { transport: { type: "http", url } } });
  ok("2b  全放行 → { ok:true, checked:2, needsAuth:[] }", result?.ok === true && result?.checked === 2 && result?.needsAuth?.length === 0, `checked=${result?.checked}`);
});

{
  // stdio 项进了 checked，但绝不该出现在 needsAuth 里。
  const result = await probeMcpServersAuthorization({ stdio: { command: "npx", args: [] } });
  ok("2c  skipped 项不进 needsAuth", result?.ok === true && result?.needsAuth?.length === 0, `n=${result?.needsAuth?.length}`);
}

// ════════════════════════════════════════════════════════════════════════════
// 第 3 节 · 安装闸：oauth 放行，server-side / mcp 仍硬拒
// ════════════════════════════════════════════════════════════════════════════
section("3. serverInstallability：OAuth 放行 / server-side 仍拒装");

{
  const httpServer = { transport: { type: "http", url: "https://example.invalid/mcp" } };

  const oauthRow = serverInstallability("westock-mcp", httpServer, "oauth");
  ok("3a  oauth → 可安装", oauthRow.ok === true, `reasons=${JSON.stringify(oauthRow.reasons)}`);
  ok("3a-2 oauth → needsOAuth:true", oauthRow.needsOAuth === true);
  ok(
    "3a-3 oauth 不再背「无法自动注入」的理由",
    !oauthRow.reasons.some((r) => String(r).includes("无法自动注入")),
    JSON.stringify(oauthRow.reasons),
  );

  const oneid = serverInstallability("oneid-one", httpServer, "oneid-token");
  ok("3b  oneid-token → 可安装 + needsOAuth", oneid.ok === true && oneid.needsOAuth === true);

  const serverSide = serverInstallability("server-side-one", httpServer, "server-side");
  ok("3c  server-side 仍拒装", serverSide.ok === false);
  ok(
    "3c-2 server-side 理由含「无法自动注入」",
    serverSide.reasons.some((r) => String(r).includes("无法自动注入")),
    JSON.stringify(serverSide.reasons),
  );

  const mcpMode = serverInstallability("mcp-mode-one", httpServer, "mcp");
  ok("3d  auth_mode=mcp 仍拒装", mcpMode.ok === false);

  const tokenSlots = {
    transport: { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${TOKEN_HERE}" } },
  };
  const tokenRow = serverInstallability("token-one", tokenSlots, "token");
  ok("3e  token + 有槽位 → 可安装 + needsTokens", tokenRow.ok === true && tokenRow.needsTokens === true, `slots=${tokenRow.tokenSlots?.length}`);
  ok("3e-2 槽位被扫出来", Array.isArray(tokenRow.tokenSlots) && tokenRow.tokenSlots.length >= 1);

  // 回归针（MCP 市场点击安装不弹令牌窗）：有 12 条 token 连接器把凭据写在 url
  // （tushare / 百度地图 / 快递100…）。只扫 env/headers 时它们被判「未声明可替换」，
  // 卡片直接变成不可装、安装按钮消失——用户看到的就是「令牌窗口没了」。
  const urlOnlyToken = {
    type: "streamableHttp",
    url: "https://api.tushare.pro/mcp/?token=${TUSHARE_TOKEN}",
  };
  const urlTokenRow = serverInstallability("tushare", urlOnlyToken, "token");
  ok("3e-3 token + url 占位符 → 可安装 + needsTokens", urlTokenRow.ok === true && urlTokenRow.needsTokens === true,
    `ok=${urlTokenRow.ok} reasons=${JSON.stringify(urlTokenRow.reasons)}`);
  ok("3e-4 url 槽位带 container=url 供令牌窗渲染", urlTokenRow.tokenSlots?.some((slot) => slot.container === "url" && slot.placeholder === "TUSHARE_TOKEN"));

  const tokenNoSlot = serverInstallability("token-bare", httpServer, "token");
  ok("3f  token 但无槽位 → 拒装", tokenNoSlot.ok === false);
  ok(
    "3f-2 理由指明「未声明可替换」",
    tokenNoSlot.reasons.some((r) => String(r).includes("未声明可替换")),
    JSON.stringify(tokenNoSlot.reasons),
  );

  const plain = serverInstallability("plain-one", httpServer, "");
  ok("3g  无 auth_mode → 可安装且两种 needs 都为假", plain.ok === true && plain.needsOAuth === false && plain.needsTokens === false);

  const stdioInstall = serverInstallability("stdio-one", { command: "npx", args: ["-y", "x"] }, "");
  ok("3h  stdio 正常连接器可安装", stdioInstall.ok === true && stdioInstall.transport === "stdio", `transport=${stdioInstall.transport}`);

  // 拒装理由必须是非空中文串（空理由会让面板渲染出一行空白红字）。
  ok(
    "3i  所有拒装理由均为非空字符串",
    [serverSide, mcpMode, tokenNoSlot].every(
      (r) => r.reasons.length > 0 && r.reasons.every((x) => typeof x === "string" && x.trim()),
    ),
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 第 4 节 · 目录级冒烟：真实索引上的鉴权态投影（无缓存则 SKIP）
// ════════════════════════════════════════════════════════════════════════════
section("4. wbConnectorCatalog：真实索引上的鉴权态投影");

let catalog = null;
try {
  catalog = await wbConnectorCatalog();
} catch {
  catalog = null;
}
// 返回键是 connectors（不是 rows）：这里曾写成 catalog.rows，于是整节在任何机器上
// 都直接 SKIP ——一条永不执行的断言比没有断言更糟，它会让人以为这条契约有护栏。
if (!catalog || !Array.isArray(catalog.connectors) || catalog.connectors.length === 0) {
  console.log("SKIP  4. 目录不可用（无本地索引缓存），跳过投影断言");
} else {
  const rows = catalog.connectors;
  ok("4a  total 与 rows 长度一致", catalog.total === rows.length, `total=${catalog.total} rows=${rows.length}`);

  const oauthRows = rows.filter((r) => r.needsOAuth === true);
  if (oauthRows.length) {
    ok("4b  oauth 连接器全部可安装", oauthRows.every((r) => r.installable === true), `n=${oauthRows.length}`);
    ok("4b-2 oauth 连接器不带 blockedReason", oauthRows.every((r) => !r.blockedReason));
  } else {
    console.log("SKIP  4b. 索引里没有 needsOAuth 条目");
  }

  const serverSideRows = rows.filter((r) => (r.authMode === "server-side" || r.authMode === "mcp") && r.serverNames?.length);
  if (serverSideRows.length) {
    ok("4c  server-side / mcp 全部不可安装", serverSideRows.every((r) => r.installable === false), `n=${serverSideRows.length}`);
    ok(
      "4c-2 其 blockedReason 含「无法自动注入」或「未知类型」",
      serverSideRows.every(
        (r) => String(r.blockedReason || "").includes("无法自动注入") || String(r.blockedReason || "").includes("未知类型"),
      ),
    );
  } else {
    console.log("SKIP  4c. 索引里没有 server-side / mcp 条目");
  }

  // 两态互斥：可安装 ⇔ 没有 blockedReason。任一字段漂移都会让面板同时显示
  // 「可安装」和一条红字理由。
  ok(
    "4d  两态互斥（installable ⇔ 无 blockedReason）",
    rows.every((r) => (r.installable === true) === !r.blockedReason),
    `offenders=${rows.filter((r) => (r.installable === true) !== !r.blockedReason).length}`,
  );
  ok(
    "4e  需要令牌的连接器一定带槽位",
    rows.filter((r) => r.needsTokens).every((r) => Array.isArray(r.tokenSlots) && r.tokenSlots.length > 0),
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 第 5 节 · OAuth 客户端纯函数（授权链里最容易静默错的地方）
// ════════════════════════════════════════════════════════════════════════════
section("5. mcp-oauth 纯函数：PKCE / 回调模板 / 转义 / 令牌库");

{
  const a = oauth.createPkce();
  const b = oauth.createPkce();
  ok("5a  PKCE verifier 每次不同且够长", a.verifier !== b.verifier && a.verifier.length >= 43);
  // 实现里字段名是 method（createPkce 的返回契约），不是 challengeMethod。
  ok("5b  PKCE 用 S256", a.method === "S256", `m=${a.method}`);
  const expect = createHash("sha256").update(a.verifier, "ascii").digest("base64url");
  ok("5c  challenge == base64url(SHA256(verifier))", a.challenge === expect);
  ok("5d  verifier 只用 base64url 安全字符", /^[A-Za-z0-9\-._~]+$/.test(a.verifier), a.verifier.slice(0, 8));
  const s1 = oauth.createState();
  const s2 = oauth.createState();
  ok("5e  state 每次不同", s1 !== s2);
}

{
  // 真实踩过的坑：服务器在 JSON 错误体里把 < > 转成 \u003c \u003e。
  // 不解转义，占位符替换就空转，重试必然再 400 —— 这就是「授权页永远弹不出来」的
  // 最后一段根因。
  const raw =
    '{"error_description":"redirect_uri must be workbuddy://workbuddy/mcp/connector:\\u003cname\\u003e/oauth/callback"}';
  ok("5f  unescapeUnicodeEscapes 还原 < >", oauth.unescapeUnicodeEscapes(raw).includes("<name>"), oauth.unescapeUnicodeEscapes(raw).slice(0, 40));
  const found = oauth.extractExpectedRedirectUri(raw);
  ok("5g  能从错误体里抠出回调模板", typeof found === "string" && found.startsWith("workbuddy://"), `found=${found}`);
  const filled = oauth.substituteRedirectPlaceholder(found, "westock-mcp");
  ok(
    "5h  占位符替换成具体连接器名",
    filled === "workbuddy://workbuddy/mcp/connector:westock-mcp/oauth/callback",
    `filled=${filled}`,
  );
  ok("5h-2 替换后不再残留 <> 或 ${}", !/[<>]|\$\{/.test(filled), filled);

  const plain = "https://app.example/cb?x=1";
  ok("5i  无占位符原样返回", oauth.substituteRedirectPlaceholder(plain, "x") === plain);
  ok("5j  空/空值输入不炸", oauth.substituteRedirectPlaceholder("", "x") === "" && oauth.substituteRedirectPlaceholder(null, "x") === "");

  // 从 DCR 的 400 响应里要拿到人话，而不是一整坨 JSON。
  const readable = oauth.readableRegistrationError(raw);
  ok("5k  readableRegistrationError 抽到 error_description", /redirect_uri must be/.test(readable) && !readable.includes("{"), readable.slice(0, 60));
}

{
  const parsed = oauth.parseWwwAuthenticate('Bearer resource_metadata="https://a.example/meta", error="invalid_token"');
  // 实现把 scheme 归一成小写（便于比较），断言按不区分大小写写。
  ok("5l  parseWwwAuthenticate 取 scheme", String(parsed?.scheme).toLowerCase() === "bearer", `scheme=${parsed?.scheme}`);
  ok(
    "5m  parseWwwAuthenticate 取 resource_metadata",
    parsed?.params?.resource_metadata === "https://a.example/meta",
    `rm=${parsed?.params?.resource_metadata}`,
  );
  ok("5n  空 header 不炸且返回空", !oauth.parseWwwAuthenticate(""));
}

{
  // 令牌库：按 URL 哈希落盘（Windows 上不能把 URL 直接当文件名）。
  const dir = oauth.storeDirectory();
  ok("5o  storeDirectory 是绝对路径", typeof dir === "string" && /^[A-Za-z]:[\\/]|^\//.test(dir), dir);
  const fake = await oauth.readTokenRecord("https://never.example/mcp");
  ok("5p  未授权过的 server → 无记录", fake === null);
  ok("5q  tokenIsFresh 对空记录为假", oauth.tokenIsFresh(null) === false && oauth.tokenIsFresh({}) === false);
  ok(
    "5r  tokenIsFresh 对未过期记录为真",
    oauth.tokenIsFresh({ accessToken: "t", expiresAt: Date.now() + 600_000 }) === true,
  );
  ok(
    "5s  tokenIsFresh 对已过期/无 token 为假",
    oauth.tokenIsFresh({ accessToken: "t", expiresAt: Date.now() - 1000 }) === false &&
      oauth.tokenIsFresh({ expiresAt: Date.now() + 600_000 }) === false,
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 第 6 节 · 静态接线不变式：安装链顺序不能被打乱
// ════════════════════════════════════════════════════════════════════════════
section("6. 静态不变式：lib/index.js 安装链接线顺序");

{
  const indexSrc = readFileSync(join(LIB, "index.js"), "utf8");
  const marketSrc = readFileSync(join(LIB, "wb-market.js"), "utf8");

  ok(
    "6a  index.js 经懒加载模块调用 probeMcpServersAuthorization（P0-1 后不再静态导入）",
    // P0-1 把 wb-market / expert-market 改成首次调用才 import；安装链仍必须经由
    // 该模块拿到探测函数，所以钉住「动态 import + marketApi.probe…」这对组合。
    /import\(\s*["']\.\/wb-market\.js["']\s*\)/.test(indexSrc)
      && /marketApi\.probeMcpServersAuthorization\(/.test(indexSrc),
  );
  ok("6b  index.js 从 mcp-oauth 导入授权能力", /from\s*["']\.\/mcp-oauth\.js["']/.test(indexSrc));

  const atInject = indexSrc.indexOf("injectStoredOAuthTokens(");
  const atProbe = atInject >= 0 ? indexSrc.indexOf("probeMcpServersAuthorization(", atInject + 1) : -1;
  // 写盘锚点：安装链把（探测过的）条目装进 admittedImport 的那一行，源文是
  // `const json = { mcpServers };`——构造字面量，没有冒号也没有等号。早前这里写成
  // `const json = { mcpServers:` 去找一个不存在的冒号，恒返回 -1 让 6d/6e 假红。
  const atJson = atProbe >= 0 ? indexSrc.indexOf("const json = { mcpServers:", atProbe + 1) : -1;
  ok("6c  安装链先注入已存 token 再探测", atInject >= 0 && atProbe > atInject, `inject=${atInject} probe=${atProbe}`);
  ok("6d  探测在写配置之前", atProbe >= 0 && atJson > atProbe, `probe=${atProbe} json=${atJson}`);
  // 仓库版的 install 链在探测与写盘之间保留了一个 needsAuth 早返回：探测发现需要授权
  // 就整体中止（不写一半配置），把 needsAuth 抛给面板弹浏览器授权页。运行时副本可能是
  // 更早的 R8 版本（裸调用不阻断），所以这条断言只在仓库版口径下成立。
  const probeSlice = indexSrc.slice(atProbe, atJson > atProbe ? atJson : atProbe + 400);
  ok(
    "6e  needsAuth 分支落在探测与写配置之间",
    atProbe >= 0 && atJson > atProbe && /if\s*\(\s*probe\?\.needsAuth\?\.length\s*\)/.test(probeSlice),
    `slice=${probeSlice.replace(/\s+/g, " ").slice(0, 90)}`,
  );

  ok("6f  wb-market 探测不再 throw 鉴权错误", !/throw new Error\(\s*`连接器 server/.test(marketSrc));
  ok("6g  wb-market 导出 needsAuth 结构化字段", /needsAuth: true/.test(marketSrc));
  ok(
    "6h  wb-market 不再按 oauth 硬拒（oauth 分支附近无「无法自动注入」）",
    !/auth_mode\s*===\s*["']oauth["'][\s\S]{0,400}无法自动注入/.test(marketSrc),
  );

  // 浏览器兜底路径：`cmd /c start "" <url>` 会被 cmd 当成命令行解析。Node 仅对含空格的
  // 参数加引号，而授权 URL 不含空格，于是 URL 里的 & 成了命令分隔符，地址被截成
  // `?response_type=code`，服务端回 invalid_request: client_id is required。
  // 必须走参数直传的 ShellExecute（rundll32 url.dll,FileProtocolHandler）。
  ok("6i  index.js 不再用 cmd /c start 打开授权页", !/["']cmd["']\s*,\s*\[\s*["']\/c["']\s*,\s*["']start["']/.test(indexSrc));
  // issue #7 起这条兜底搬进了 lib/system-open.js（spawn 必须挂 error 监听，否则 headless
  // 主机缺 xdg-open 时 ENOENT 会带走宿主进程）。断言跟着实现走，参数直传的要求不变。
  const systemOpenSrc = readFileSync(join(LIB, "system-open.js"), "utf8");
  ok(
    "6j  Windows 兜底走 rundll32 参数直传（lib/system-open.js）",
    /["']rundll32["']\s*,\s*args:\s*\[\s*["']url\.dll,FileProtocolHandler["']/.test(systemOpenSrc) &&
      !/["']cmd["']\s*,\s*\[\s*["']\/c["']\s*,\s*["']start["']/.test(systemOpenSrc),
  );
}

// ════════════════════════════════════════════════════════════════════════════
// 第 7 节 · 「Bearer [object Object]」事故回归（ima-mcp 装不上、授权页永不弹）
// ════════════════════════════════════════════════════════════════════════════
// 根因链（2026-10-24 一手复现于 https://ima.qq.com/mcp）：
//   ① ensureAccessToken() 返回对象 {ok, accessToken, refreshed, error}，
//      而注入处写成 `String(await oauthEnsureToken(url))` → "[object Object]"；
//      对象恒真值 → 每个 HTTP 连接器都被注进 `authorization: Bearer [object Object]`。
//   ② 该头一旦带上，ima 回的就不是 401「empty access token」而是 400「token parse failed」，
//      而旧探测只认 401/403 → 判成「匿名可用」→ 配置照写、needsAuth 永不触发。
//   ③ 于是 mcp-client 连接期拿到 400 + JSON-RPC error（面板显示「连接失败」），
//      而用户点授权时 OAuth 发现又必然失败（ima 不挂任何 /.well-known）→ 一行红字，死路。
section("7. 凭据形状 / 非 401 的鉴权失败 / 手填令牌回落");

{
  const garbage = ["[object Object]", "Bearer [object Object]", "", "   ", "Bearer", "Bearer  ", "undefined", "null", "NaN", "x".repeat(9000)];
  ok(
    "7a  isUsableBearerToken 拒掉序列化残骸/空值/超长",
    garbage.every((v) => oauth.isUsableBearerToken(v) === false),
    garbage.filter((v) => oauth.isUsableBearerToken(v)).map((v) => v.slice(0, 20)).join(","),
  );
  ok(
    "7b  isUsableBearerToken 拒掉未替换占位符与控制符",
    oauth.isUsableBearerToken("Bearer ${TOKEN}") === false &&
      oauth.isUsableBearerToken("abc\r\nx-evil: 1") === false &&
      oauth.isUsableBearerToken({ accessToken: "abc" }) === false,
  );
  ok(
    "7c  isUsableBearerToken 接受正常令牌（带不带 Bearer 前缀都算）",
    oauth.isUsableBearerToken("eyJhbGciOi.abc-_123") === true && oauth.isUsableBearerToken("Bearer eyJhbGciOi.abc") === true,
  );
  ok(
    "7d  ${...} 占位符不算残骸（R7 要原样保留交给面板补填）",
    oauth.isSerializedGarbageCredential("Bearer ${PICSET_AGENT_SK}") === false &&
      oauth.isSerializedGarbageCredential("Bearer [object Object]") === true &&
      oauth.isSerializedGarbageCredential("real-token") === false,
  );
  // 令牌库这一层也要认：过期时间再远，残骸也不是令牌。
  ok(
    "7e  tokenIsFresh 不把 [object Object] 当有效令牌",
    oauth.tokenIsFresh({ accessToken: "[object Object]", expiresAt: Date.now() + 600_000 }) === false,
  );
}

{
  // mcpAuthFailure：状态码 + 正文一起判，且只收鉴权语义。
  const cases = [
    [401, "", true],
    [403, "", true],
    [400, '{"jsonrpc":"2.0","error":{"code":-32001,"message":"type:business, code:110042, msg:token parse failed"}}', true],
    [400, '{"jsonrpc":"2.0","error":{"message":"empty access token"}}', true],
    [400, '{"error":"invalid_token"}', true],
    [400, "authorization failed", true],
    [400, "not found", false],
    // 正文点名鉴权才算，状态码本身不是挡箭牌：网关在路由前就查凭据时 404 也会带 token 报错。
    [404, "empty access token", true],
    [404, "Cannot GET /mcp", false],
    [500, "token expired", false],
    [200, "", false],
    [0, "", false],
  ];
  const bad = cases.filter(([s, b, want]) => oauth.mcpAuthFailure(s, b) !== want).map(([s, b]) => `${s}:${b.slice(0, 24)}`);
  ok("7f  mcpAuthFailure 判定表逐条符合预期", bad.length === 0, bad.join(" | "));
}

await withProbeServer(
  400,
  async ({ url }) => {
    const result = await probeServerAuthorization("ima-mcp", { type: "streamableHttp", url });
    ok("7g  400 + token 鉴权正文 → needsAuth（旧版在这里放行并写出坏配置）", result?.needsAuth === true, `authorized=${result?.authorized}`);
    ok("7g-2 needsAuth 带上 status 与正文摘要", result?.status === 400 && String(result?.bodyHint || "").includes("token parse failed"), `hint=${result?.bodyHint}`);
  },
  '{"jsonrpc":"2.0","error":{"code":-32001,"message":"type:business, code:110042, msg:token parse failed"},"id":null}',
);

await withProbeServer(
  400,
  async ({ url }) => {
    const result = await probeServerAuthorization("broken-one", { type: "streamableHttp", url });
    ok("7h  400 但正文与鉴权无关 → 仍然放行（不把服务器故障判成要授权）", result?.authorized === true && !result?.needsAuth, `status=${result?.status}`);
  },
  '{"jsonrpc":"2.0","error":{"code":-32602,"message":"invalid params: unknown field"}}',
);

await withProbeServer(
  503,
  async ({ url }) => {
    const result = await probeServerAuthorization("flaky-one", { type: "streamableHttp", url });
    ok("7i  5xx 即使正文提到 token 也放行", result?.authorized === true && !result?.needsAuth, `status=${result?.status}`);
  },
  "service unavailable: token store down",
);

{
  const indexSrc = readFileSync(join(LIB, "index.js"), "utf8");
  const marketSrc = readFileSync(join(LIB, "wb-market.js"), "utf8");
  const clientSrc = readFileSync(join(LIB, "client.js"), "utf8");

  // 事故本体：对象被 String() 成了 "[object Object]"。这条写法一律不得复活。
  ok("7j  index.js 不再把 ensureAccessToken 的返回值整个 String 化", !/String\(\s*\(?\s*await oauthEnsureToken/.test(indexSrc));
  ok(
    "7k  index.js 取的是 .accessToken 且过形状闸",
    /result\?\.ok\s*&&\s*oauthIsUsableToken\(result\.accessToken\)/.test(indexSrc),
  );
  ok("7l  index.js 引入并使用凭据形状判定", /isUsableBearerToken as oauthIsUsableToken/.test(indexSrc) && /isSerializedGarbageCredential as oauthIsGarbageCredential/.test(indexSrc));
  ok("7m  坏掉的 authorization 会被摘掉而不是原样装回", /function stripBearerHeader/.test(indexSrc) && /poisoned \? stripBearerHeader\(rawServer\)/.test(indexSrc));
  ok("7n  授权靶点不带坏头去探测", /oauthIsGarbageCredential\(headers\.authorization\)/.test(indexSrc));
  ok("7o  wb-market 探测按「状态码 + 正文」判鉴权", /mcpAuthFailure\(response\.status, bodyText\)/.test(marketSrc));
  ok("7p  wb-market 不再只看 401/403", !/if\s*\(response\.status === 401 \|\| response\.status === 403\)\s*\{/.test(marketSrc));

  // 死路变活路：发现失败时必须把手填令牌弹层开出来。
  ok("7q  mcp-oauth 发现失败回传 manualTokenOnly", /manualTokenOnly: true/.test(readFileSync(join(LIB, "mcp-oauth.js"), "utf8")));
  ok("7r  index.js 把 manualTokenOnly 透传给面板", /manualTokenOnly: started\?\.manualTokenOnly === true/.test(indexSrc));
  ok("7s  面板对 manualTokenOnly 开弹层而非只报错", /res\?\.manualTokenOnly/.test(clientSrc) && /mode: 'manual-token'/.test(clientSrc));
  ok(
    "7t  弹层有 manual-token 专属说明，且已登记 en-US 译文",
    /mode === 'manual-token'/.test(clientSrc) &&
      clientSrc.includes('"该服务器没有提供标准 OAuth 授权发现，无法自动打开授权页。如果你已经从服务方拿到访问令牌，粘贴在下面即可安装。": "'),
  );
  // url 槽位（?token=${X}）也要能在令牌窗里显示：否则这类连接器即使恢复成可装，
  // 弹窗字段标签仍会错写成「环境变量 url」。
  ok(
    "7t-2 令牌窗为 url 槽位渲染专用标签（URL 参数 + en-US）",
    /slot\.container === 'url'/.test(clientSrc) && clientSrc.includes('"URL 参数": "URL parameter"'),
  );
}

{
  // 同一轮的第二个「装不上」成因：只写 url 不写 type 的远程条目（索引里实有 11 条，
  // 含 tencent-docs-oa / qq-mail / github / notion）曾被「未知传输类型（缺失）」一律拒装。
  const bareUrl = { timeout: 600, url: "https://saas.docs.qq.com/api/v6/open/agent/mcp" };
  const row = serverInstallability("tencent-docs-oa", bareUrl, "oneid-token");
  ok("7u  只有 url、没有 type → 按 streamable-http 判定可装", row.ok === true && row.transport === "streamable-http", `ok=${row.ok} transport=${row.transport} reasons=${JSON.stringify(row.reasons)}`);
  ok("7v  该形态仍要 OAuth 授权", row.needsOAuth === true);
  const bareSse = { type: "sse", url: "https://example.invalid/sse" };
  ok("7w  显式 sse 照旧拒装（缺省兜底不得把 sse 也放行）", serverInstallability("sse-one", bareSse, "").ok === false);
  const bareCmd = { command: "npx", args: ["-y", "x"] };
  ok("7x  command 缺 type 仍按 stdio（新兜底不得抢走 stdio 判定）", serverInstallability("cmd-one", bareCmd, "").transport === "stdio");
  // 探测口径必须与准入闸一致，否则这 11 条恰好绕过 401 防线。
  await withProbeServer(
    401,
    async ({ url }) => {
      const probed = await probeServerAuthorization("typeless-one", { url });
      ok("7y  无 type 的 url 条目确实被探测（与准入闸同口径）", probed?.needsAuth === true, `authorized=${probed?.authorized} skipped=${probed?.skipped}`);
    },
  );
}

console.log(`\n${failures === 0 ? "AUTH-GATE-REGRESSION PASS" : `${failures} CHECK(S) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;