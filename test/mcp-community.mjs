// 社区 MCP 数据层（lib/mcp-community.js）直测：零真实网络、零磁盘、零真实 ~/.dsh。
//
// 钉的是「照真实条目映射」而不是 happy path：
//   - 参数顺序（runtimeArguments 必须在 identifier 之前，`-y` 反了就变成 `pkg -y`）；
//   - pypi → uvx、oci → 丢弃（v1 不支持 docker 映射，生成跑不起来的配置比不生成更糟）；
//   - 只有 remotes → http + 需自备令牌 + runnable=false；
//   - environmentVariables 的 isRequired / isSecret / default 映射；
//   - 畸形响应（servers 非数组 / 缺 name / nextCursor 非字符串）不抛错；
//   - serverName 净化与冲突后缀（与已装条目、同批条目都不得撞名）；
//   - 搜索 / 游标的 URL 编码与 limit 钳制；
//   - 失败路径 {ok:false} 不抛、只对网络错误与 5xx 重试、4xx 不重试；
//   - 内存缓存命中不再发请求、TTL 过期重新取。
//
// 用法：node ./test/mcp-community.mjs
import {
  COMMUNITY_PAGE_LIMIT,
  MCP_REGISTRY_SOURCES,
  buildRegistryUrl,
  filterCommunityRows,
  mapRegistryServer,
  normalizeRegistryResponse,
  parseGithubOwner,
  resetCommunityCache,
  safeRepoUrl,
  sanitizeServerName,
  wbMcpCommunityList,
} from "../lib/mcp-community.js";

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);

const META_OK = { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true } };

/** 真实条目形状的夹具（2026-10-30 本机实测字段）。 */
function npmEntry(overrides = {}) {
  return {
    server: {
      $schema: "https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json",
      name: "com.pulsemcp/remote-filesystem",
      title: "Remote Filesystem",
      description: "MCP server for remote filesystem operations on cloud storage.",
      version: "0.1.5",
      repository: { url: "https://github.com/pulsemcp/mcp-servers", source: "github", subfolder: "experimental/remote-filesystem" },
      packages: [{
        registryType: "npm",
        identifier: "remote-filesystem-mcp-server",
        version: "0.1.5",
        runtimeHint: "npx",
        transport: { type: "stdio" },
        runtimeArguments: [{ type: "positional", value: "-y" }],
        environmentVariables: [
          { description: "bucket", isRequired: true, name: "GCS_BUCKET" },
          { description: "key", isSecret: true, name: "GCS_PRIVATE_KEY" },
          { description: "flag", default: "false", name: "GCS_MAKE_PUBLIC" },
        ],
      }],
      ...overrides,
    },
    _meta: META_OK,
  };
}

// ── 1. 源常量与 URL 拼接 ───────────────────────────────────────────────────
eq("源地址只有一条且为官方 Registry v0", MCP_REGISTRY_SOURCES, ["https://registry.modelcontextprotocol.io/v0/servers"]);
{
  const url = new URL(buildRegistryUrl({ search: "file system", cursor: "a/b:c", limit: 500 }));
  eq("limit 钳制到 100", url.searchParams.get("limit"), String(COMMUNITY_PAGE_LIMIT));
  eq("version=latest", url.searchParams.get("version"), "latest");
  eq("搜索词原样", url.searchParams.get("search"), "file system");
  eq("游标经编码后原样往返", url.searchParams.get("cursor"), "a/b:c");
  ok("游标中的冒号被 URL 编码", url.search.includes("cursor=a%2Fb%3Ac"), url.search);
  eq("无搜索/游标时不带参数", new URL(buildRegistryUrl({})).searchParams.has("search"), false);
  eq("limit 非法回落默认值", new URL(buildRegistryUrl({ limit: "x" })).searchParams.get("limit"), "100");
  eq("limit 0 钳到 1", new URL(buildRegistryUrl({ limit: 0 })).searchParams.get("limit"), "1");
}

// ── 2. npm + npx：参数顺序钉死 ─────────────────────────────────────────────
{
  const row = mapRegistryServer(npmEntry());
  ok("npm 条目映射成功", !!row);
  eq("命令来自 runtimeHint", row.command, "npx");
  eq("参数顺序 runtimeArguments → identifier → packageArguments", row.args, ["-y", "remote-filesystem-mcp-server"]);
  eq("没有多余参数（-y 与包名各一次）", row.args.filter((arg) => arg === "-y" || arg === "remote-filesystem-mcp-server").length, 2);
  eq("stdio 包 → runnable", row.runnable, true);
  eq("transport=stdio", row.transport, "stdio");
  eq("标题优先 title", row.title, "Remote Filesystem");
  eq("owner 从 repository.url 解析", row.owner, "pulsemcp");
  eq("repoUrl 原样带出", row.repoUrl, "https://github.com/pulsemcp/mcp-servers");
  eq("serverName 取尾段", row.serverName, "remote-filesystem");
  eq("requiresToken：有必填环境变量即为 true", row.requiresToken, true);
  eq("ac.* 命名空间按官方/厂商处理", row.official, true);
  eq("key 用完整名称", row.key, "com.pulsemcp/remote-filesystem");
}

// ── 3. packageArguments 排在 identifier 之后 ──────────────────────────────
{
  const entry = npmEntry({
    packages: [{
      registryType: "npm",
      identifier: "demo-mcp",
      runtimeHint: "npx",
      transport: { type: "stdio" },
      runtimeArguments: [{ value: "-y" }],
      packageArguments: [{ value: "--root" }, { value: "/tmp" }],
    }],
  });
  eq("packageArguments 在 identifier 之后", mapRegistryServer(entry).args, ["-y", "demo-mcp", "--root", "/tmp"]);
}

// ── 4. pypi → uvx；oci → 丢弃 ─────────────────────────────────────────────
{
  const pypi = npmEntry({
    name: "io.example/py-mcp",
    packages: [{ registryType: "pypi", identifier: "py-mcp", transport: { type: "stdio" } }],
  });
  const row = mapRegistryServer(pypi);
  eq("pypi 无 runtimeHint → uvx", row.command, "uvx");
  eq("社区命名空间 io.github/io.example 需显式前缀才算社区", row.official, true, "io.example 不在社区前缀表里");
  const github = mapRegistryServer(npmEntry({ name: "io.github.someone/thing" }));
  eq("io.github.* 视为社区", github.official, false);

  const oci = npmEntry({ packages: [{ registryType: "oci", identifier: "x", transport: { type: "stdio" } }] });
  eq("oci 包直接丢弃", mapRegistryServer(oci), null);
}

// ── 5. 只有 remotes → http / requiresToken / runnable=false ───────────────
{
  const row = mapRegistryServer({
    server: {
      name: "ac.inference.sh/mcp",
      description: "run any ai model.",
      version: "2.0.1",
      remotes: [{ type: "streamable-http", url: "https://api.inference.sh/mcp" }],
    },
    _meta: META_OK,
  });
  eq("远程条目 transport=http", row.transport, "http");
  eq("远程条目 runnable=false", row.runnable, false);
  eq("远程条目 remoteUrl 带出", row.remoteUrl, "https://api.inference.sh/mcp");
  eq("远程条目 requiresToken=true", row.requiresToken, true);
  eq("远程条目无命令", row.command, "");
  eq("远程条目 serverName 取尾段", row.serverName, "mcp");
}

// ── 6. environmentVariables 映射 ──────────────────────────────────────────
{
  const row = mapRegistryServer(npmEntry());
  eq("env 逐项映射", row.env.map((item) => [item.name, item.required, item.secret, item.default]), [
    ["GCS_BUCKET", true, false, ""],
    ["GCS_PRIVATE_KEY", false, true, ""],
    ["GCS_MAKE_PUBLIC", false, false, "false"],
  ]);
  ok("hasDefault 精确区分默认值", row.env[2].hasDefault === true && row.env[0].hasDefault === false);
}

// ── 7. 畸形输入不抛错 ─────────────────────────────────────────────────────
{
  eq("null 条目 → null", mapRegistryServer(null), null);
  eq("缺 name → null", mapRegistryServer({ server: { description: "x" }, _meta: META_OK }), null);
  eq("name 为空白 → null", mapRegistryServer({ server: { name: "   " }, _meta: META_OK }), null);
  eq("既无 packages 也无 remotes → null", mapRegistryServer({ server: { name: "a/b" }, _meta: META_OK }), null);
  eq("status 非 active → 丢弃", mapRegistryServer({ ...npmEntry(), _meta: { "io.modelcontextprotocol.registry/official": { status: "deleted" } } }), null);
  const noMeta = npmEntry();
  delete noMeta._meta;
  ok("缺 _meta 视为 active（宽容读取）", !!mapRegistryServer(noMeta));
  eq("servers 非数组 → 空集", normalizeRegistryResponse({ servers: "x" }).servers, []);
  eq("响应为 null → 空集", normalizeRegistryResponse(null).servers, []);
  eq("nextCursor 非字符串 → null", normalizeRegistryResponse({ servers: [], metadata: { nextCursor: 42 } }).nextCursor, null);
  eq("nextCursor 空串 → null", normalizeRegistryResponse({ servers: [], metadata: { nextCursor: "" } }).nextCursor, null);
  eq("nextCursor 有效字符串保留", normalizeRegistryResponse({ servers: [], metadata: { nextCursor: "abc" } }).nextCursor, "abc");
}

// ── 8. description 截断 200 ───────────────────────────────────────────────
{
  const long = "x".repeat(500);
  const row = mapRegistryServer(npmEntry({ description: long }));
  eq("description 截断到 200 字符", row.description.length, 200);
  ok("截断尾部带省略号", row.description.endsWith("…"));
}

// ── 9. serverName 净化与冲突后缀 ──────────────────────────────────────────
{
  eq("大写转小写", sanitizeServerName("Foo/BarBaz"), "barbaz");
  eq("非法字符收敛为连字符", sanitizeServerName("io.github.x/my server!!"), "my-server");
  eq("保留下划线", sanitizeServerName("a/b_c-d"), "b_c-d");
  eq("尾段为空（尾部斜杠）回落到上一段", sanitizeServerName("io.github.onlynamespace/"), "io-github-onlynamespace");
  eq("纯非法字符回落 mcp-server", sanitizeServerName("///!!!"), "mcp-server");
  eq("与已装冲突追加 -2", sanitizeServerName("server-filesystem", ["server-filesystem"]), "server-filesystem-2");
  eq("多级冲突追加 -3", sanitizeServerName("server-filesystem", ["server-filesystem", "server-filesystem-2"]), "server-filesystem-3");
  eq("冲突判定不区分大小写", sanitizeServerName("A/B", ["b"]), "b-2");
}

// ── 10. GitHub owner 解析 ─────────────────────────────────────────────────
{
  eq("标准仓库地址", parseGithubOwner("https://github.com/pulsemcp/mcp-servers"), "pulsemcp");
  eq("带 .git 后缀", parseGithubOwner("https://github.com/foo/bar.git"), "foo");
  eq("非 GitHub 地址返回空串", parseGithubOwner("https://gitlab.com/foo/bar"), "");
  eq("空值不抛", parseGithubOwner(undefined), "");
}

// ── 11. filterCommunityRows ───────────────────────────────────────────────
{
  const rows = [{ runnable: true }, { runnable: false }];
  eq("默认只留可直接运行", filterCommunityRows(rows).length, 1);
  eq("onlyRunnable=false 全留", filterCommunityRows(rows, { onlyRunnable: false }).length, 2);
  eq("非数组入参不抛", filterCommunityRows(null).length, 0);
}

// ── 12. wbMcpCommunityList：取数 / 映射 / 游标 / 缓存 ─────────────────────
function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

{
  resetCommunityCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({
      servers: [
        npmEntry(),
        { server: { name: "ac.remote/thing", remotes: [{ url: "https://x/y" }] }, _meta: META_OK },
        { server: { name: "broken/nothing" }, _meta: META_OK },
      ],
      metadata: { nextCursor: "cursor-1", count: 3 },
    });
  };
  const first = await wbMcpCommunityList({ search: "filesystem" }, { fetchImpl, now: () => 1000 });
  ok("列表成功", first.ok === true);
  eq("不可用条目被过滤", first.rows.length, 2);
  eq("游标带出", first.nextCursor, "cursor-1");
  eq("fetchedAt 来自注入时钟", first.fetchedAt, 1000);
  eq("首次请求非缓存", first.cached, false);
  eq("首次只发一次请求", calls, 1);

  const second = await wbMcpCommunityList({ search: "filesystem" }, { fetchImpl, now: () => 2000 });
  eq("同 key 命中内存缓存", second.cached, true);
  eq("命中缓存不再发请求", calls, 1);
  eq("缓存沿用首次 fetchedAt", second.fetchedAt, 1000);

  const expired = await wbMcpCommunityList({ search: "filesystem" }, { fetchImpl, now: () => 1000 + 5 * 60_000 + 1 });
  eq("超过 TTL 重新请求", expired.cached, false);
  eq("TTL 过期后请求次数 +1", calls, 2);
}

// ── 13. takenNames 冲突 + 同批撞名 ────────────────────────────────────────
{
  resetCommunityCache();
  const fetchImpl = async () => jsonResponse({
    servers: [
      npmEntry({ name: "io.github.a/filesystem" }),
      npmEntry({ name: "io.github.b/filesystem" }),
    ],
    metadata: {},
  });
  const res = await wbMcpCommunityList({ takenNames: ["filesystem"] }, { fetchImpl });
  eq("第一条与已装冲突 → -2", res.rows[0].serverName, "filesystem-2");
  eq("同批第二条继续后缀 → -3", res.rows[1].serverName, "filesystem-3");
  ok("nextCursor 缺失 → null", res.nextCursor === null);
}

// ── 13b. 缓存命中时要按「本次的 takenNames」重算 serverName ─────────────────
{
  resetCommunityCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse({
      servers: [
        npmEntry({ name: "io.github.a/filesystem" }),
        npmEntry({ name: "io.github.b/filesystem" }),
      ],
      metadata: {},
    });
  };
  const first = await wbMcpCommunityList({}, { fetchImpl });
  eq("首次：无冲突 → filesystem", first.rows[0].serverName, "filesystem");
  eq("首次：同批第二条 → filesystem-2", first.rows[1].serverName, "filesystem-2");
  const hit = await wbMcpCommunityList({ takenNames: ["filesystem"] }, { fetchImpl });
  eq("缓存命中仍复用上游结果", hit.cached, true);
  eq("缓存命中也只发一次请求", calls, 1);
  eq("缓存命中：与本次已装冲突 → filesystem-2", hit.rows[0].serverName, "filesystem-2");
  eq("缓存命中：同批第二条继续后缀 → filesystem-3", hit.rows[1].serverName, "filesystem-3");
  ok("重算 serverName 不改写缓存里的原始行", hit.rows[0] !== first.rows[0]);
  const again = await wbMcpCommunityList({}, { fetchImpl });
  eq("无冲突时缓存行原名可原样复用", again.rows[0].serverName, "filesystem");
  ok("再次命中不复制未变化的行", again.rows[0] === first.rows[0]);
}

// ── 13c. repository.url 协议白名单：只放 https ──────────────────────────────
{
  eq("safeRepoUrl：https 原样保留", safeRepoUrl("https://github.com/o/r"), "https://github.com/o/r");
  eq("safeRepoUrl：http 丢弃", safeRepoUrl("http://github.com/o/r"), "");
  eq("safeRepoUrl：javascript: 丢弃", safeRepoUrl("javascript:alert(1)"), "");
  eq("safeRepoUrl：file: 丢弃", safeRepoUrl("file:///C:/Windows/System32/calc.exe"), "");
  eq("safeRepoUrl：data: 丢弃", safeRepoUrl("data:text/html,<script>alert(1)</script>"), "");
  eq("safeRepoUrl：畸形 URL / 空值丢弃", safeRepoUrl("not a url"), "");
  eq("safeRepoUrl：null 丢弃", safeRepoUrl(null), "");
  const bad = mapRegistryServer(npmEntry({ repository: { url: "javascript:alert(1)" } }));
  eq("映射层：恶意 repository.url 不带出 repoUrl", bad.repoUrl, "");
  eq("映射层：恶意 repository.url 也解析不出 owner", bad.owner, "");
}

// ── 13d. 远程传输只收宿主支持的 streamable-http ─────────────────────────────
{
  const remoteEntry = (...remotes) => ({
    server: { name: "io.example/remote-only", remotes },
    _meta: META_OK,
  });
  eq("只有 sse 远程 → 丢弃（宿主会拒绝）", mapRegistryServer(remoteEntry({ type: "sse", url: "https://x/sse" })), null);
  eq("只有 ws 远程 → 丢弃", mapRegistryServer(remoteEntry({ type: "ws", url: "wss://x/ws" })), null);
  eq("只有 sse + ws → 丢弃", mapRegistryServer(remoteEntry({ type: "sse", url: "https://x/sse" }, { type: "ws", url: "wss://x/ws" })), null);
  const missingType = mapRegistryServer(remoteEntry({ url: "https://x/mcp" }));
  ok("缺 type → 按 streamable-http 接收", missingType?.transport === "http" && missingType.remoteUrl === "https://x/mcp");
  const httpType = mapRegistryServer(remoteEntry({ type: "http", url: "https://x/mcp" }));
  eq("type=http 接收", httpType?.remoteUrl, "https://x/mcp");
  const streamable = mapRegistryServer(remoteEntry({ type: "streamable-http", url: "https://x/mcp" }));
  eq("type=streamable-http 接收", streamable?.remoteUrl, "https://x/mcp");
  const mixed = mapRegistryServer(remoteEntry({ type: "sse", url: "https://x/sse" }, { type: "streamable-http", url: "https://x/mcp" }));
  eq("sse 与 streamable-http 混合：选可用的那条", mixed?.remoteUrl, "https://x/mcp");
  const withPkg = npmEntry({ remotes: [{ type: "sse", url: "https://x/sse" }] });
  eq("有 stdio 包 + 仅 sse：仍按 stdio 可运行，remoteUrl 为空", mapRegistryServer(withPkg)?.remoteUrl, "");

  // docker 需要 run -i --rm 整套参数，v1 不映射；绝不能生成 `docker <pkg>` 这种必坏配置。
  const dockerNpm = mapRegistryServer(npmEntry({
    packages: [{
      registryType: "npm",
      identifier: "demo-docker",
      runtimeHint: "docker",
      transport: { type: "stdio" },
      runtimeArguments: [{ value: "-y" }],
    }],
  }));
  ok("runtimeHint=docker 不产出 docker 命令", dockerNpm?.command !== "docker", dockerNpm?.command);
  const dockerUnknown = mapRegistryServer({
    server: {
      name: "io.example/docker-only",
      packages: [{ registryType: "unknown", identifier: "img", runtimeHint: "docker", transport: { type: "stdio" } }],
    },
    _meta: META_OK,
  });
  eq("docker + 未知 registryType → 丢弃（不生成跑不起来的卡片）", dockerUnknown, null);
}

// ── 14. 失败路径：4xx 不重试 / 网络错误重试一次 / 永不抛 ─────────────────
{
  resetCommunityCache();
  let calls = 0;
  const notFound = async () => { calls += 1; return jsonResponse({ error: "nope" }, 404); };
  const res = await wbMcpCommunityList({ search: "404" }, { fetchImpl: notFound });
  eq("4xx 返回 ok:false", res.ok, false);
  ok("错误文案带状态码", /404/.test(res.error), res.error);
  eq("4xx 不重试", calls, 1);

  resetCommunityCache();
  calls = 0;
  const flaky = async () => {
    calls += 1;
    if (calls === 1) throw new Error("ECONNRESET");
    return jsonResponse({ servers: [], metadata: {} });
  };
  const retried = await wbMcpCommunityList({ search: "flaky" }, { fetchImpl: flaky });
  ok("网络错误重试后成功", retried.ok === true);
  eq("网络错误只重试一次", calls, 2);

  resetCommunityCache();
  calls = 0;
  const serverError = async () => { calls += 1; return jsonResponse({}, 503); };
  const down = await wbMcpCommunityList({ search: "503" }, { fetchImpl: serverError });
  eq("5xx 重试后仍失败 → ok:false", down.ok, false);
  eq("5xx 重试一次", calls, 2);

  resetCommunityCache();
  const broken = async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } });
  const bad = await wbMcpCommunityList({ search: "badjson" }, { fetchImpl: broken });
  eq("解析失败收敛为 ok:false", bad.ok, false);

  resetCommunityCache();
  const noFetch = async () => { throw new Error("offline"); };
  const offline = await wbMcpCommunityList({ search: "offline" }, { fetchImpl: noFetch });
  ok("断网不抛错", offline.ok === false && typeof offline.error === "string");

  // ok=false 但拿不到状态码（代理 / 网关异常）：不能当成功，也不能静默只试一次。
  resetCommunityCache();
  calls = 0;
  const opaque = async () => { calls += 1; return { ok: false, status: 0, json: async () => ({ servers: [] }) }; };
  const opaqueRes = await wbMcpCommunityList({ search: "opaque" }, { fetchImpl: opaque });
  eq("ok=false + status 0 → ok:false", opaqueRes.ok, false);
  eq("无状态码的失败按网关异常重试一次", calls, 2);
  const opaqueOk = async () => ({ ok: false, status: 200, json: async () => ({ servers: [] }) });
  const okFalse = await wbMcpCommunityList({ search: "okfalse" }, { fetchImpl: opaqueOk });
  ok("ok=false 即使 status=200 也判失败", okFalse.ok === false);
}

// ── 15. 页码上限常量与真实响应形态 ────────────────────────────────────────
{
  eq("单页上限 100", COMMUNITY_PAGE_LIMIT, 100);
  const normalized = normalizeRegistryResponse({
    servers: [{ server: { name: "a/b" }, _meta: META_OK }],
    metadata: { nextCursor: "io.github.Evozim/chroot-filesystem-jail-mcp:2.0.0", count: 100 },
  });
  eq("真实游标形态（含冒号）原样保留", normalized.nextCursor, "io.github.Evozim/chroot-filesystem-jail-mcp:2.0.0");
  eq("servers 原样保留", normalized.servers.length, 1);
}

console.log(failures === 0 ? "\nMCP COMMUNITY PASS" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
