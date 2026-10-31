// 连接器凭据获取通道 —— 从随包 SKILL.md 的「鉴权 / 凭证」章节里提取申请入口。
//
// 背景：WorkBuddy 的 connectors.json 只有 id / name / description / auth_mode，没有
// 「API Key 去哪申请」字段；mcp.json 也只写 `${TOKEN}` 占位符。110 条 token 型连接器
// 因此只能告诉用户「要令牌」，却说不清去哪拿。实测这些连接器随包的 SKILL.md 里，
// 相当一部分在「鉴权说明」章节直接写了控制台 / api-keys / dashboard 地址，本模块把它们
// 自动挖出来，配上端点域名兜底与搜索兜底，供详情与令牌弹窗展示。
//
// 边界：
//   - 只读 ZIP 内已经解出来的文本，零网络、零写盘、零凭据；不猜 URL、不改写占位符。
//   - 只返回 https 链接；排除 MCP 端点本身、图片 / 示例域名 / `...` 残片。
//   - 数据层只输出「通道」，具体填什么仍由用户从服务方复制（X9：不代填、不代注入）。

const URL_PATTERN = /https?:\/\/[^\s"'`<>()[\]（）【】，。；：！？、]+/gi;
const TRAILING_PUNCTUATION = /[.,;:!?，。；：！？、）)\]】》]+$/;
const AUTH_SECTION = /(鉴权|认证|授权|凭证|凭据|密钥|令牌|token|api\s*key|apikey|access key|获取|申请|配置)/i;
const ACQUIRE_CONTEXT = /(获取|申请|注册|登录|前往|打开|进入|控制台|后台|工作台|开放平台|开发者|凭证|凭据|密钥|api\s*key|apikey|access key|dashboard|console|settings)/i;
const CREDENTIAL_PATH = /(api[-_]?key|apikey|access[-_]?key|token|keys|credential|secret|console|dashboard|settings|developer|openapi|open\/|apply|register|login|account|profile|mcp\/keys|api-keys)/i;
const DOC_PATH = /(docs?|guide|help|faq|wiki|manual)/i;
const ASSET_PATH = /\.(png|jpe?g|gif|svg|webp|ico|css|js|woff2?|ttf|zip|gz|mp4|mov|pdf)$/i;
const EXCLUDED_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)$|(^|\.)example\.(com|org|net)$/i;
// 这些站点不是「凭据申请入口」：文档镜像 / 代码托管 / 公共 CDN。
const NON_CREDENTIAL_HOSTS = new Set([
  "clawhub.ai",
  "github.com",
  "raw.githubusercontent.com",
  "gitee.com",
  "npmjs.com",
  "npmjs.org",
]);
const WEAK_PATH = /(pricing|plans?|download|reader|about|contact|blog|news|terms|privacy|capabilities|faq)/i;
const STRONG_PATH = /(api[-_]?key|apikey|access[-_]?key|personalaccesstoken|dashboard|console|settings|developer|profile|mcp[-/]keys|\/keys?($|\/)|\/tokens?($|\/))/i;
// 这些是宿主 / 公共平台域名：从端点反推「服务商官网」会得到无意义的大站首页。
const GENERIC_HOSTS = new Set([
  "qq.com",
  "tencent.com",
  "tencentcloud.com",
  "myqcloud.com",
  "aliyun.com",
  "alibaba.com",
  "alipay.com",
  "github.com",
  "githubusercontent.com",
  "npmjs.com",
  "npmjs.org",
  "jsdelivr.net",
  "clawhub.ai",
  "w3.org",
]);
const MULTI_PART_SUFFIXES = new Set([
  "com.cn",
  "net.cn",
  "org.cn",
  "gov.cn",
  "edu.cn",
  "co.uk",
  "org.uk",
  "com.hk",
  "com.tw",
  "com.au",
  "co.jp",
  "co.kr",
  "com.sg",
]);
const MAX_LINKS = 3;
const MAX_SKILL_TEXT = 64 * 1024;

/**
 * 人工核过的入口：只放确定是「申请 / 管理凭据」的页面。
 * 其余尽量交给 SKILL.md 自动提取；提取不到时走端点官网或搜索兜底。
 */
const CURATED = {
  tushare: {
    provider: "Tushare",
    links: [{ url: "https://tushare.pro/user/token", kind: "credential" }],
    note: "登录 Tushare 后，在个人主页复制「接口 TOKEN」。",
  },
  "bugly-token": {
    provider: "Bugly",
    links: [{ url: "https://bugly.qq.com/", kind: "official" }],
    note: "登录 Bugly 后，在产品设置里获取 OpenAPI 个人访问令牌。",
  },
  "tencent-map": {
    provider: "腾讯位置服务",
    links: [{ url: "https://lbs.qq.com/dev/console/application/mine", kind: "credential" }],
    note: "在腾讯位置服务控制台创建应用，添加 Key 并勾选 WebServiceAPI。",
  },
  "baidu-maps": {
    provider: "百度地图开放平台",
    links: [
      { url: "https://lbsyun.baidu.com/apiconsole/key", kind: "credential" },
      { url: "https://lbsyun.baidu.com/", kind: "official" },
    ],
    note: "在百度地图开放平台创建应用，获取服务端 AK。",
  },
  tccc: {
    provider: "腾讯云",
    links: [{ url: "https://console.cloud.tencent.com/cam/capi", kind: "credential" }],
    note: "在腾讯云访问管理创建 SecretId / SecretKey；建议用子账号并授予最小权限。",
  },
  kuaidi100: {
    provider: "快递100",
    links: [{ url: "https://api.kuaidi100.com/", kind: "official" }],
    note: "登录快递100开放平台的企业管理后台，在授权信息里获取 API Key。",
  },
  "eudic-openapi": {
    provider: "欧路词典",
    links: [{ url: "https://my.eudic.net/", kind: "official" }],
    note: "登录欧路账号后，在账号设置 / OpenAPI 授权页生成访问令牌。",
  },
  "tencent-union-igro": {
    provider: "腾讯营销联盟",
    links: [{ url: "https://adnet.qq.com/", kind: "official" }],
    note: "登录腾讯营销联盟，进入「接入中心」获取 MCP API Key。",
  },
  listinggood: {
    provider: "ListingGood",
    links: [{ url: "https://listinggood.com/developers", kind: "credential" }],
    note: "在 ListingGood 开发者页登录后复制 API Key。",
  },
  tdengine: {
    provider: "TDengine",
    links: [{ url: "https://www.taosdata.com/", kind: "official" }],
    note: "登录 TDengine Cloud 控制台后创建 API Key；自建实例按部署文档配置。",
  },
  "wendao-partner-workbuddy-connector": {
    provider: "携程问道",
    links: [{ url: "https://www.ctrip.com/wendao/openclaw", kind: "official" }],
    note: "在携程问道开放页申请接入凭证。",
  },
};

function str(value) {
  return typeof value === "string" ? value : "";
}

function trimTrailing(value) {
  return String(value || "")
    .replace(/%EF%BC%8C.*$/i, "") // 「，」的中文逗号编码：URL 后面紧跟正文时只保留地址本体
    .replace(/%E3%80%82.*$/i, "") // 「。」
    .replace(TRAILING_PUNCTUATION, "");
}

/** 候选链接不能是 API 端点本身、凭据拼接参数或公共代码托管页。 */
function isCredentialCandidate(url) {
  if (NON_CREDENTIAL_HOSTS.has(url.hostname)) return false;
  for (const key of url.searchParams.keys()) {
    if (/(^|_)(token|key|secret|credential|access_token|api_key)($|_)/i.test(key)) return false;
  }
  const path = decodeURIComponent(url.pathname).toLowerCase();
  // 只排除「路径本身就是 MCP 端点」的地址；/settings/mcp、/mcp/keys 是设置 / 凭据页，必须保留。
  if (/^\/(mcp|sse)\/?$/.test(path) || /\/capabilities\/?$/.test(path)) return false;
  if (/\/asset\/v\d+\/token($|\/)/.test(path)) return false;
  if (/\/(v\d+)\/(token|mcp|sse|chat|messages)($|\/)/.test(path)) return false;
  return true;
}

/** 只接受可安全交给浏览器的 https 地址；其余（含未替换占位符）一律丢弃。 */
export function safeHttpsUrl(value) {
  const raw = trimTrailing(str(value).trim());
  if (!/^https:\/\//i.test(raw)) return "";
  if (/\$\{|\{|\}|\.\.\./.test(raw)) return "";
  try {
    const url = new URL(raw);
    if (!url.hostname || EXCLUDED_HOST.test(url.hostname)) return "";
    if (ASSET_PATH.test(url.pathname)) return "";
    return url.toString();
  } catch {
    return "";
  }
}

/** 取 registrable domain（近似 eTLD+1）；IP / 公共平台 / 单段域名返回空串。 */
export function providerSiteOf(serverUrl) {
  let host = "";
  try {
    host = new URL(String(serverUrl || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
  if (!host || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) return "";
  const parts = host.split(".").filter(Boolean);
  if (parts.length < 2) return "";
  const lastTwo = parts.slice(-2).join(".");
  const domain = MULTI_PART_SUFFIXES.has(lastTwo) && parts.length >= 3
    ? parts.slice(-3).join(".")
    : lastTwo;
  if (GENERIC_HOSTS.has(domain)) return "";
  return `https://${domain}/`;
}

function serverUrlsOf(mcpServers) {
  const urls = [];
  for (const rawServer of Object.values(mcpServers || {})) {
    const nested = rawServer && typeof rawServer.transport === "object" && rawServer.transport !== null
      ? rawServer.transport
      : rawServer;
    if (typeof nested?.url === "string" && nested.url.trim()) urls.push(nested.url.trim());
  }
  return urls;
}

function sectionsOf(text) {
  const sections = [];
  let current = { heading: "", body: [] };
  for (const line of String(text || "").split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      if (current.heading || current.body.length) sections.push(current);
      current = { heading: heading[1].trim(), body: [] };
    } else {
      current.body.push(line);
    }
  }
  if (current.heading || current.body.length) sections.push(current);
  return sections;
}

function contextAround(text, index, before = 180, after = 240) {
  return String(text || "").slice(Math.max(0, index - before), Math.min(text.length, index + after));
}

function scoreUrl(candidate, text, index, authSection, placeholders) {
  const url = new URL(candidate);
  const path = decodeURIComponent(url.pathname);
  let score = 0;
  if (authSection) score += 4;
  if (ACQUIRE_CONTEXT.test(contextAround(text, index))) score += 3;
  if (CREDENTIAL_PATH.test(`${url.hostname}${path}${url.search}`)) score += 4;
  if (STRONG_PATH.test(path)) score += 3;
  if (WEAK_PATH.test(path)) score -= 4;
  if (DOC_PATH.test(path)) score += 1;
  if (placeholders.some((key) => contextAround(text, index).includes(key))) score += 2;
  return score;
}

function kindForUrl(url) {
  return STRONG_PATH.test(decodeURIComponent(url.pathname)) ? "credential" : "official";
}

/**
 * 从一段 SKILL.md 文本里找「凭据申请入口」候选。
 * 返回 [{ url, score, authSection }]，按分数降序；同 URL 只留最高分。
 */
export function extractCredentialLinks(text, { placeholders = [], serverUrls = [] } = {}) {
  const body = String(text || "").slice(0, MAX_SKILL_TEXT);
  if (!body) return [];
  const sections = sectionsOf(body);
  // 记录每个字符区间属于哪个章节；最多几百段，线性扫一遍。
  const sectionRanges = [];
  let cursor = 0;
  for (const section of sections) {
    const raw = [section.heading ? `# ${section.heading}` : "", ...section.body].join("\n");
    const start = cursor;
    const end = start + raw.length;
    sectionRanges.push({
      start,
      end,
      auth: AUTH_SECTION.test(section.heading) || placeholders.some((key) => raw.includes(key)),
    });
    cursor = end + 1;
  }
  const isAuthSection = (index) => sectionRanges.some((range) => index >= range.start && index <= range.end && range.auth);

  const endpointSet = new Set(serverUrls.map((url) => safeHttpsUrl(url)).filter(Boolean));
  const best = new Map();
  for (const match of body.matchAll(URL_PATTERN)) {
    const cleaned = trimTrailing(match[0]);
    const url = safeHttpsUrl(cleaned);
    if (!url) continue;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (!isCredentialCandidate(parsed)) continue;
    if (endpointSet.has(url)) continue;
    // 指向 MCP 端点自身的链接不当作申请入口；但 /mcp 端点旁边的 /mcp-keys、
    // /mcp/keys、/settings/mcp 是凭据页，不能因为前缀相同被误杀。
    if (serverUrls.some((serverUrl) => {
      try {
        const server = new URL(serverUrl);
        const target = new URL(url);
        if (target.host !== server.host) return false;
        const serverPath = server.pathname.replace(/\/+$/, "") || "/";
        const targetPath = target.pathname.replace(/\/+$/, "") || "/";
        if (targetPath === serverPath) return true;
        const subPath = targetPath.startsWith(`${serverPath}/`) ? targetPath.slice(serverPath.length) : "";
        return Boolean(subPath) && !/\/(keys?|api-keys|tokens?|settings|dashboard|console)(\/|$)/i.test(subPath);
      } catch {
        return false;
      }
    })) continue;
    const authSection = isAuthSection(match.index || 0);
    const score = scoreUrl(url, body, match.index || 0, authSection, placeholders);
    if (score < 3) continue;
    const previous = best.get(url);
    if (!previous || score > previous.score) best.set(url, { url, score, authSection, kind: kindForUrl(parsed) });
  }
  return [...best.values()].sort((a, b) => b.score - a.score || a.url.length - b.url.length);
}

const CREDENTIAL_WORD = /(API\s*Key|Access\s*Key|Token|令牌|密钥|凭据|凭证|Secret|PAT)/i;
const ACQUIRE_VERB = /(获取|申请|生成|注册|创建|登录|前往|打开|进入)/;
// 「设置」单独出现太泛（连接器设置、参数设置都会命中），必须带具体落点才算获取指引。
const WHERE_WORD = /(官网|控制台|后台|工作台|开放平台|开发者|管理平台|门户|dashboard|console|portal|→|>|OpenAPI|API\s*授权|「[^」]+」)/i;
const NEGATIVE_HINT = /(无需|不需要|不要向用户|未登录即可|不存在需要|已在本机填入|自动注入|无需额外|unknown|revoked|invalid|expired)/i;

/**
 * 从鉴权章节里挑一句「怎么拿」的原文；只做摘录，不改写事实。
 * 宁可少给，也不把错误处理 / 工具说明 / 分页规则误当成获取步骤。
 */
export function extractCredentialNote(text, { placeholders = [] } = {}) {
  const body = String(text || "").slice(0, MAX_SKILL_TEXT);
  if (!body) return "";
  const candidates = [];
  let heading = "";
  for (const rawLine of body.split(/\r?\n/)) {
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(rawLine);
    if (headingMatch) {
      heading = headingMatch[1].trim();
      continue;
    }
    const line = rawLine
      .replace(/^\s*[-*+]\s+/, "")
      .replace(/`/g, "")
      .replace(/\*\*/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "对应页面")
      .replace(/\$\{[^}]*\}/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line.length < 12 || line.length > 180) continue;
    if (line.startsWith("|") || /^HTTP\s*[45]\d\d/i.test(line)) continue;
    if (/^description:/i.test(line) || /工具[:：]/.test(line)) continue;
    if (/[<>]/.test(line) || /[:：]$/.test(line)) continue;
    if (/\b(missing|failed|error)\b/i.test(line)) continue;
    if (/(若返回|鉴权失败|提示用户|失败时|不要反复|不要换参数|说明文档)/.test(line)) continue;
    if (/\b(?:create|get|list|call|upload|delete|update)_[a-z0-9_]+\b/.test(line)) continue;
    if (NEGATIVE_HINT.test(line)) continue;
    if (!CREDENTIAL_WORD.test(line)) continue;
    if (!ACQUIRE_VERB.test(line)) continue;
    const inAuthSection = AUTH_SECTION.test(heading);
    const mentionsPlaceholder = placeholders.some((key) => rawLine.includes(key));
    if (!inAuthSection && !mentionsPlaceholder) continue;
    if (!WHERE_WORD.test(line) && !mentionsPlaceholder) continue;
    let score = 0;
    if (mentionsPlaceholder) score += 3;
    if (inAuthSection) score += 2;
    if (/(获取|申请|生成|注册)/.test(line)) score += 2;
    if (/(控制台|后台|工作台|开放平台|开发者|dashboard|console|settings)/i.test(line)) score += 2;
    candidates.push({ line, score });
  }
  candidates.sort((a, b) => b.score - a.score || a.line.length - b.line.length);
  const note = candidates[0]?.line || "";
  return note
    .replace(/Authorization:\s*Bearer\s*[;；]?/gi, "Authorization 请求头")
    .replace(/[:：]\s*对应页面$/, "")
    .trim()
    .slice(0, 160);
}

/** 占位符类型：UI 据此说明「这里要的是应用 ID / 密钥 / 账号 / 地址」。 */
export function placeholderKind(key) {
  const name = String(key || "").toUpperCase();
  if (/(^|_)(URL|BASE_URL|ENDPOINT|HOST|API_BASE|API_SCHEMA)($|_)/.test(name)) return "endpoint";
  if (/(CLIENT_ID|APP_ID|APPKEY_ID)/.test(name)) return "clientId";
  if (/(CLIENT_SECRET|APP_SECRET|APPSECRET|MACHINE_SECRET|SECRET_KEY)/.test(name)) return "clientSecret";
  if (/(PASSWORD|PASSWD|PWD)/.test(name)) return "password";
  if (/(USERNAME|LOGIN_NAME|USER_ID|USERID|OPEN_ID|ORG_CODE|TENANT|SITE_ID|LANGUAGE|ENV|TID|ROUTE_ID)/.test(name)) return "identifier";
  if (/(KEY|TOKEN|PAT|SECRET|CODE|AK|SK|CREDENTIAL)/.test(name)) return "token";
  return "other";
}

function searchUrlFor(name, placeholders) {
  const keys = placeholders.slice(0, 2).join(" ");
  const query = `${name || "MCP 连接器"} ${keys} API Key 获取 申请`.trim();
  return `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
}

function uniqueLinks(links) {
  const seen = new Set();
  const out = [];
  for (const link of links) {
    const url = safeHttpsUrl(link?.url);
    if (!url) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ url, kind: link.kind === "credential" || link.kind === "official" ? link.kind : "search" });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}

/**
 * 生成一条连接器的凭据获取指引。
 *
 * @param {object} options
 * @param {string} options.connectorId
 * @param {string} options.name
 * @param {Array}  [options.tokenSlots]   scanTokenSlots 的结果
 * @param {object} [options.mcpServers]   用于端点域名兜底
 * @param {string[]} [options.skillTexts] 随包 SKILL.md 正文（已截断）
 * @returns {null | {provider:string, source:string, links:Array, placeholders:string[],
 *   placeholderKinds:Record<string,string>, note:string}}
 */
export function buildAuthHelp({ connectorId = "", name = "", tokenSlots = [], mcpServers = {}, skillTexts = [] } = {}) {
  const placeholders = [...new Set(
    (Array.isArray(tokenSlots) ? tokenSlots : [])
      .map((slot) => String(slot?.placeholder || "").trim())
      .filter(Boolean),
  )];
  if (!placeholders.length) return null;

  const texts = (Array.isArray(skillTexts) ? skillTexts : []).map(str).filter(Boolean);
  const serverUrls = serverUrlsOf(mcpServers);
  const curated = CURATED[String(connectorId || "")] || null;

  const extracted = [];
  for (const text of texts) extracted.push(...extractCredentialLinks(text, { placeholders, serverUrls }));
  extracted.sort((a, b) => b.score - a.score || a.url.length - b.url.length);
  // 有明确凭据页时，不再把 pricing / reader / about 这类弱相关页塞进来。
  const strongExtracted = extracted.filter((row) => !WEAK_PATH.test(new URL(row.url).pathname));
  const primaryCandidates = strongExtracted.length ? strongExtracted : extracted;

  let links = [];
  let source = "search";
  if (curated?.links?.length) {
    links = uniqueLinks(curated.links);
    source = "curated";
  } else {
    links = uniqueLinks(pickPrimaryLinks(primaryCandidates, 2));
    if (links.length) source = "skill";
  }
  const site = providerSiteOf(serverUrls[0]);
  // 只在「还没有官网入口，且主入口不足两条」时补站点根：人工核过的入口已有官网时
  // 不再叠一条更泛的父域（例如百度地图不该再补 baidu.com）。
  if (site && !links.some((link) => link.kind === "official") && links.length < 2) {
    links = uniqueLinks([...links, { url: site, kind: "official" }]);
    if (!source || source === "search") source = "endpoint";
  }
  if (!links.length) {
    links = uniqueLinks([{ url: searchUrlFor(name, placeholders), kind: "search" }]);
    source = "search";
  }

  let note = str(curated?.note);
  if (!note) {
    for (const text of texts) {
      note = extractCredentialNote(text, { placeholders });
      if (note) break;
    }
  }

  const placeholderKinds = {};
  for (const key of placeholders) placeholderKinds[key] = placeholderKind(key);

  return {
    provider: str(curated?.provider) || str(name) || String(connectorId || ""),
    source,
    links,
    placeholders,
    placeholderKinds,
    note,
  };
}

/** 同一 host 只保留更具体的路径：有 /api-keys 时不再列站点根。 */
function pickPrimaryLinks(rows, max) {
  const picked = [];
  const specificHosts = new Set();
  for (const row of rows) {
    let url;
    try {
      url = new URL(row.url);
    } catch {
      continue;
    }
    const isRoot = url.pathname === "/" || url.pathname === "";
    if (isRoot && specificHosts.has(url.hostname)) continue;
    if (!isRoot) {
      for (let index = picked.length - 1; index >= 0; index -= 1) {
        const existing = new URL(picked[index].url);
        if (existing.hostname === url.hostname && (existing.pathname === "/" || existing.pathname === "")) {
          picked.splice(index, 1);
        }
      }
      specificHosts.add(url.hostname);
    }
    if (picked.some((link) => link.url === row.url)) continue;
    picked.push({ url: row.url, kind: row.kind });
    if (picked.length >= max) break;
  }
  return picked;
}
