// P0「装好了却用不了」回归套件（ima / 腾讯自选股 一类的售后整理）。
//
// 用户报的现象是两层叠在一起的：
//  1. 安装账本只要跑完一次 wbConnectorInstall 就登记「已安装」，哪怕 applyManagedImport
//     因为同名跳过没写进任何 server —— 徽标在说谎；
//  2. 已装但 401/403 的连接器只显示「连接失败」，用户以为重连能救，实际重连一百次也不会恢复。
//
// 本套件钉住修复后的四条行为契约：
//  A. connectorHealth / connectorBadge 的真值表（从 lib/client.js 抽源码进 new Function 真跑）；
//  B. 宿主安装闸：没写进任何 server 时不得登记「已安装」，且要如实回 ok:false；
//  C. 面板接线：卡片按健康度给徽标与「重连 / 重新授权」出口，详情里的授权状态与刷新链路；
//  D. manualTokenOnly（服务器不做 OAuth 发现）必须直接弹出手填令牌窗，不得把卡片
//     降级成「需 WorkBuddy 账号授权」；令牌 / 授权弹层要压在详情弹层之上。
//
// 隔离纪律：只读 lib/ 源码 + 纯函数执行，零网络、零写盘、不碰真实 ~/.dsh。
// 反向自测：B 的检查器喂一段「旧写法」假源码必须变红；A 的表里包含「没搜到行 ⇒ 不能报未连接」
// 这条反例，防止有人把 unknown 顺手改成 failed。
import { readFile } from "node:fs/promises";

const libDir = new URL("../lib/", import.meta.url);
const clientSource = await readFile(new URL("client.js", libDir), "utf8");
const indexSource = await readFile(new URL("index.js", libDir), "utf8");
const typertSource = await readFile(new URL("typert.js", libDir), "utf8");

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

/** 按起止标记取源码切片；任一标记缺失直接失败（防止悄悄测了个空）。 */
function sliceBetween(source, startNeedle, endNeedle, label) {
  const start = source.indexOf(startNeedle);
  ok(`切片锚点存在：${label}（起）`, start >= 0, start >= 0 ? "" : `找不到 ${JSON.stringify(startNeedle)}`);
  if (start < 0) return "";
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  ok(`切片锚点存在：${label}（止）`, end > start, end > start ? "" : `找不到 ${JSON.stringify(endNeedle)}`);
  if (end <= start) return "";
  return source.slice(start, end);
}

// ══ A. connectorHealth / connectorBadge 真值表 ═════════════════════════════
// 这两段长在面板组件体内（闭包 h / Badge / t / useMemo / installedConnectorKeys /
// accountAuthIds / mcpServerRows），所以抽源码后用 new Function 注入同名参数真跑。
// 只断言行数语义，不复制一份「测试版实现」——那会让实现漂移时两边一起错。
{
  const slice = sliceBetween(
    clientSource,
    "  const mcpRowByName = useMemo(",
    "  const openConnectorDetail = async (item) => {",
    "connectorHealth/connectorBadge",
  );
  let build = null;
  try {
    build = new Function(
      "installedConnectorKeys", "accountAuthIds", "mcpServerRows", "h", "Badge", "t", "useMemo",
      `${slice}\n return { connectorServerRows, connectorHealth, connectorBadge };`,
    );
  } catch (error) {
    ok("抽出的源码可编译（new Function）", false, String(error?.message || error));
  }
  if (build) {
    const fakeH = (type, props, ...children) => ({ type, props: props || {}, children });
    const fakeT = (text, vars) => {
      let out = String(text);
      if (Array.isArray(vars) && vars.length) {
        out = out.replace(/\{(\d+)\}/g, (raw, index) => (Number(index) in vars ? String(vars[index]) : raw));
      }
      return out;
    };
    const make = (installed, accountAuth, rows) => build(
      new Set(installed), new Set(accountAuth), rows, fakeH, "Badge", fakeT, (fn) => fn(),
    );
    const item = (extra = {}) => ({ id: "ima", name: "ima", serverNames: ["ima"], installable: true, ...extra });
    const badgeText = (badge) => (badge && badge.children && badge.children.length ? String(badge.children[0]) : "");
    const row = (serverName, status, authRequired = false) => ({ serverName, status, authRequired });

    const connected = make(["ima"], [], [row("ima", "connected")]);
    ok("健康度：server 已注册工具 → connected", connected.connectorHealth(item()) === "connected");
    ok("徽标：已安装且已连接 → 「已安装 · 已连接」s-on",
      badgeText(connected.connectorBadge(item())) === "已安装 · 已连接"
      && connected.connectorBadge(item()).props.cls === "s-on");

    const auth = make(["ima"], [], [row("ima", "failed", true)]);
    ok("健康度：401/403 类失败 → auth", auth.connectorHealth(item()) === "auth");
    ok("徽标：已安装但需授权 → 「已安装 · 需授权」s-warn（不是笼统的「连接失败」）",
      badgeText(auth.connectorBadge(item())) === "已安装 · 需授权"
      && auth.connectorBadge(item()).props.cls === "s-warn");

    const failed = make(["ima"], [], [row("ima", "failed", false)]);
    ok("健康度：非鉴权失败 → failed", failed.connectorHealth(item()) === "failed");
    ok("徽标：已安装但没连上 → 「已安装 · 未连接」s-err",
      badgeText(failed.connectorBadge(item())) === "已安装 · 未连接"
      && failed.connectorBadge(item()).props.cls === "s-err");

    // 反例守卫：连接器装在别的 profile / 别的会话里时 list() 里没有同名行——
    // 这时只能显示「已安装」，绝不能拿「没搜到」冒充「没连上」。
    const elsewhere = make(["ima"], [], [row("some-other-server", "connected")]);
    ok("健康度：无同名 server 行 → unknown（不冒充失败）", elsewhere.connectorHealth(item()) === "unknown");
    ok("徽标：无同名行 → 仍是「已安装」，不是「未连接」",
      badgeText(elsewhere.connectorBadge(item())) === "已安装"
      && elsewhere.connectorBadge(item()).props.cls !== "s-err");
    ok("健康度：serverNames 缺失 → unknown",
      make(["ima"], [], []).connectorHealth({ id: "ima", name: "ima" }) === "unknown");

    const mixed = make(["multi"], [], [row("a", "connected"), row("b", "failed", true)]);
    ok("健康度优先级：任一 server 已连上即 connected（不被另一条鉴权失败覆盖）",
      mixed.connectorHealth({ id: "multi", serverNames: ["a", "b"] }) === "connected");

    // 旧实现会把 manualTokenOnly 的连接器塞进 accountAuthIds，卡片降级成「仅展示」。
    // 用户反馈那条路把安装入口整个收走、令牌窗再也打不开——现在即使残留了旧集合，
    // 徽标也只看 installable，必须仍是「可安装」。
    const legacyAccount = make([], ["ima"], []);
    ok("徽标：旧 accountAuthIds 集合不再降级（仍显示可安装）",
      badgeText(legacyAccount.connectorBadge(item())) === "可安装");

    const installable = make([], [], []);
    ok("徽标：未安装可装 → 「可安装」", badgeText(installable.connectorBadge(item())) === "可安装");
    // 反例：没进安装账本时，即使 list() 里碰巧有同名且已连接的 server，也不能说「已安装」。
    ok("徽标：未登记安装 → 即便有同名已连接行也不显示「已安装」",
      badgeText(make([], [], [row("ima", "connected")]).connectorBadge(item())) === "可安装");
    ok("徽标：未安装不可装 → 「仅展示」",
      badgeText(installable.connectorBadge(item({ installable: false }))) === "仅展示");
  }
}

// ══ B. 宿主安装闸：没写盘就不许登记「已安装」 ═════════════════════════════
// 检查器写成纯函数，正向跑真源码、反向喂「旧写法」假源码证明不是恒真。
function installGateShape(source) {
  const start = source.indexOf("\tasync wbConnectorInstall(payload) {");
  if (start < 0) return { found: false };
  const end = source.indexOf("\n\tasync ", start + 10);
  const body = source.slice(start, end > start ? end : source.length);
  const iWrote = body.indexOf("const wrote =");
  const iGate = body.indexOf("if (!wrote)");
  const iRecord = body.indexOf("recordInstallState({");
  const iReturn = body.indexOf("return { ...result, missingSlots, localDeps, wrote }");
  const gateBlock = iGate >= 0 && iRecord > iGate ? body.slice(iGate, iRecord) : "";
  return {
    found: true,
    hasWrote: iWrote >= 0,
    hasGate: iGate >= 0,
    ordered: iWrote >= 0 && iGate > iWrote && iRecord > iGate,
    gateReturnsFalse: /ok:\s*false/.test(gateBlock) && /wrote:\s*0/.test(gateBlock),
    returnCarriesWrote: iReturn >= 0 && iReturn > iRecord,
  };
}

{
  const shape = installGateShape(indexSource);
  ok("安装闸：wbConnectorInstall 方法体被定位", shape.found === true);
  ok("安装闸：先算 wrote（added + updated）", shape.hasWrote === true);
  ok("安装闸：wrote 为 0 时走失败分支", shape.hasGate === true);
  ok("安装闸顺序：wrote → 0 判定 → recordInstallState（登记只在真的写盘后）", shape.ordered === true,
    JSON.stringify(shape));
  ok("安装闸：零写入的返回是 ok:false 且 wrote:0（面板会当失败提示）", shape.gateReturnsFalse === true);
  ok("安装闸：成功返回携带 wrote，供调用方区分跳过与装好", shape.returnCarriesWrote === true);

  // 反向自测：把「无条件登记」的旧写法喂进去，检查器必须报红。
  const fakeOld = [
    "\tasync wbConnectorInstall(payload) {",
    "\t\tconst json = { mcpServers: authorized };",
    "\t\tconst result = await applyManagedImport(this.ctx, admittedImport(json), mode);",
    "\t\tawait recordInstallState({ kind: \"connector\", key: connectorId });",
    "\t\tconst wrote = 0;",
    "\t\tif (!wrote) { return { ok: true }; }",
    "\t\treturn { ...result, missingSlots, localDeps, wrote };",
    "\t}",
    "\tasync wbOAuthBegin(payload) {",
  ].join("\n");
  const bad = installGateShape(fakeOld);
  ok("安装闸反向自测：旧写法（登记先于 wrote 判定）必须被判红", bad.ordered === false);
  ok("安装闸反向自测：零写入返回 ok:true 必须被判红", bad.gateReturnsFalse === false);
}

// ══ C. 面板接线：卡片出口 / 重连 / 刷新授权 / 详情授权状态 ═════════════════
/** 断言源码里存在一段逐字片段。 */
const mustInclude = (source, needle, label) => {
  ok(label, source.includes(needle), source.includes(needle) ? "" : `缺少片段 ${JSON.stringify(needle.slice(0, 80))}`);
};
/** 断言同一行同时出现若干片段（顺序无关的同行合取）。 */
const lineWith = (source, needles, label) => {
  const line = source.split("\n").find((candidate) => needles.every((needle) => candidate.includes(needle)));
  ok(label, Boolean(line), line ? "" : `找不到同一行同时含 ${needles.map((n) => JSON.stringify(n)).join(" + ")}`);
  return line || "";
};

{
  // C1. 连接态数据源：list() 投影，纯辅助信息、失败清空不打断市场主流程。
  mustInclude(clientSource, "const loadMcpServerRows = useCallback(async () => {", "接线：存在 loadMcpServerRows");
  mustInclude(clientSource, "const res = await call('list');", "接线：连接态取自 call('list')");
  mustInclude(clientSource, "    loadMcpServerRows();", "接线：市场页挂载时刷新连接态");
  mustInclude(clientSource, "[loadConnectors, loadInstalled, loadInstallState, loadMcpServerRows]",
    "接线：挂载 effect 依赖包含 loadMcpServerRows（避免陈旧闭包）");

  // C2. 卡片徽标不再无条件说「已安装」。
  mustInclude(clientSource, "              connectorBadge(item),", "卡片：徽标走 connectorBadge(item)");
  const reconnectButtonLine = lineWith(
    clientSource,
    ["installedConnectorKeys.has(String(item.id || ''))", "connectorHealth(item) !== 'connected'", "connectorHealth(item) !== 'unknown'"],
    "卡片：只有「已装且确认没连上」才出现重连/重新授权按钮",
  );
  ok("卡片：重连按钮不出现在 unknown（别的 profile）状态下",
    reconnectButtonLine.includes("!== 'unknown'"));
  mustInclude(clientSource, "}, connectorHealth(item) === 'auth' ? t('重新授权') : t('重连'))",
    "卡片：鉴权失败给「重新授权」，其余给「重连」");

  // C3. 重连/重新授权分流。
  const reconnectBody = sliceBetween(
    clientSource,
    "  const reconnectConnector = async (item) => {",
    "  // ── R8：连接器 OAuth 授权",
    "reconnectConnector",
  );
  ok("重连：先找报鉴权失败的 server 行", reconnectBody.includes("rows.find((row) => row.authRequired)"));
  ok("重连：鉴权失败转交 beginConnectorAuth（带 serverName）",
    reconnectBody.includes("beginConnectorAuth(item, authRow.serverName)"));
  ok("重连：其余情况逐个 call('reconnect')", reconnectBody.includes("call('reconnect', String(name))"));
  ok("重连：完成后刷新连接态投影", reconnectBody.includes("await loadMcpServerRows()"));

  // C4. 详情里的授权状态：wbOAuthOverview 终于被调用（此前声明了却从未接线）。
  const detailBody = sliceBetween(
    clientSource,
    "  const openConnectorDetail = async (item) => {",
    "  // P0：已安装但连不上的入口",
    "openConnectorDetail",
  );
  ok("详情：打开时调用 wbOAuthOverview", detailBody.includes("call('wbOAuthOverview', { connectorId: item.id })"));
  ok("详情：迟到回包按 connectorDetailIdRef 丢弃（换了连接器不写回）",
    detailBody.includes("connectorDetailIdRef.current !== String(item.id)"));
  ok("详情：仅在已安装时读取授权状态",
    /if \(!installedConnectorKeys\.has\(String\(item\?\.id \|\| ''\)\)\) return;/.test(detailBody));
  mustInclude(clientSource, "onClick: () => refreshConnectorAuth(connectorDetail)",
    "详情：「刷新授权」按钮接到 refreshConnectorAuth");
  ok("详情：已授权时展示有效期（authExpiryText）",
    clientSource.includes("t('已授权{0}', [connectorAuth.expiresAt ? t('，有效期至 {0}', [authExpiryText(connectorAuth.expiresAt)]) : ''])"));
  ok("详情：过期态提示可刷新、刷不动回浏览器授权",
    clientSource.includes("授权已过期（{0}），点「刷新授权」重新获取；刷不动会自动回到浏览器授权。"));

  // C5. 刷新授权链路：强制刷新 → 回写配置（再走安装）→ 失败回浏览器授权。
  const refreshBody = sliceBetween(
    clientSource,
    "  const refreshConnectorAuth = async (item) => {",
    "  const installConnector = async (item, tokens = null) => {",
    "refreshConnectorAuth",
  );
  ok("刷新：调用 wbOAuthRefresh（带 connectorId）", refreshBody.includes("call('wbOAuthRefresh', { connectorId: item.id })"));
  ok("刷新：needsAuth 时回落 beginConnectorAuth（不留死胡同）",
    refreshBody.includes("if (res?.needsAuth)") && refreshBody.includes("await beginConnectorAuth(item)"));
  ok("刷新：成功后重装一次把新凭据写回 headers", refreshBody.includes("await installConnector(item)"));
  // mcp-client 只在建连时快照 headers：只刷 token 不改配置，连接永远还用旧 header。
  mustInclude(indexSource, "oauthEnsureToken(target.url, { force: true })",
    "刷新：宿主强制刷新（force: true），不是拿缓存里的旧 token 再读一遍");
  mustInclude(typertSource, "mv('wbOAuthRefresh'", "刷新：typert 契约已声明 wbOAuthRefresh");

  // C6. 装成功后刷新安装账本与连接态（否则刚装上仍显示未连接直到重进页面）。
  // 「解除仅展示」随账号授权降级一起移除——安装入口不再会被收走。
  const successTail = sliceBetween(
    clientSource,
    "      setNote(missing.length",
    "  // T04/R7：安装入口。",
    "installConnector-success",
  );
  // 账号授权降级已整体移除：装成功不再需要「解除仅展示」这一步。
  ok("装成功：旧账号授权降级已移除（无需再解除仅展示）",
    !successTail.includes("setAccountAuthIds") && !successTail.includes("next.delete(item.id)"));
  ok("装成功：刷新安装账本与连接态", /await loadInstallState\(\);[\s\S]*await loadMcpServerRows\(\);/.test(successTail));

  // C7. 401/403 与普通失败在 MCP 面板分开说，并指向市场里的重新授权入口。
  ok("MCP 列表：鉴权失败显示「需授权」而不是「连接失败」",
    clientSource.includes("s.authRequired ? t('需授权') : t('连接失败')"));
  ok("MCP 详情：鉴权失败给出重新授权路径（含 ima 这类 DSH 无法代办的说明）",
    clientSource.includes("由 WorkBuddy 账号代注入凭据的连接器（如 ima）DSH 无法代办。"));
  mustInclude(indexSource, "const AUTH_FAILURE_RE =", "MCP 行：鉴权失败识别正则存在");
  ok("MCP 行：全局与项目两种投影都标注 authRequired",
    (indexSource.match(/row\.authRequired = row\.status === "failed"/g) || []).length >= 2);
}

// ══ D. manualTokenOnly 直接弹令牌窗 + 弹层层级 + 不再收回安装入口 ═══════════
// 用户反馈：点安装先显示「需 WorkBuddy 授权」，详情里的「我已有令牌」弹窗又被详情页
// 盖住看不见。修复契约：① manualTokenOnly 一律直接开手填令牌弹层；② 卡片 / 详情不再
// 因账号授权降级而收走安装按钮；③ 令牌与授权弹层 z-index 高于详情弹层。
{
  const beginBody = sliceBetween(
    clientSource,
    "  const beginConnectorAuth = async (item, serverName) => {",
    "  const submitAuthCallback = async () => {",
    "beginConnectorAuth",
  );
  ok("manualTokenOnly：不再按 tokenSlots 分流",
    !beginBody.includes("tokenSlots.length"));
  ok("manualTokenOnly：直接弹 manual-token 弹层（点安装即可填令牌）",
    beginBody.includes("if (res?.manualTokenOnly)")
    && beginBody.includes("mode: 'manual-token'"));
  ok("manualTokenOnly：不再写入 accountAuthIds / 不再把卡片降级",
    !beginBody.includes("setAccountAuthIds")
    && !beginBody.includes("该连接器由 WorkBuddy 账号授权"));

  mustInclude(clientSource, "  const openManualTokenDialog = (item) => {", "逃生口：openManualTokenDialog 存在");
  mustInclude(clientSource, "onClick: () => openManualTokenDialog(connectorDetail)",
    "逃生口：详情里的「我已有令牌」接到 openManualTokenDialog");
  ok("详情：OAuth 型连接器常驻「我已有令牌」入口",
    clientSource.includes("connectorDetail.installable && connectorDetail.needsOAuth")
    && clientSource.includes("该连接器需要通过浏览器完成一次授权"));
  ok("安装入口不再被账号授权集合收回",
    !clientSource.includes("accountAuthIds")
    && !clientSource.includes("需 WB 账号授权")
    && clientSource.includes("onClick: () => requestInstallConnector(item)"));
  ok("详情底部不再被账号授权集合收回",
    !clientSource.includes("connectorDetail.installable && !accountAuthIds.has(connectorDetail.id)"));

  // 层级：令牌窗 / 授权窗都要压过同 z-index=200 的详情弹层。
  ok("令牌与授权弹层使用 dsh-mcp-front 抬到 210",
    clientSource.includes(".dsh-mcp-overlay.dsh-mcp-front{z-index:210}")
    && (clientSource.match(/className: 'dsh-mcp-overlay dsh-mcp-front'/g) || []).length >= 2);
}

console.log(failures === 0 ? "\nCONNECTOR-AUTH-HEALTH PASS" : `\n${failures} CONNECTOR-AUTH-HEALTH CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
