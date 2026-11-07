// auth_injection_rules 解析 + mcpServers token 占位符工具（R1 / R7 的纯函数部分）。
//
// 设计边界（X9）：WB 的 auth_injection_rules 是 WB 账号体系的**代注入**机制，DSH 不做
// 注入——本模块只解析、只关联、只展示（R1）；R7 的令牌引导安装用的是**用户自填 token**
// 对 `${...}` 占位符的显式替换，与 WB 代注入是两回事。
//
// 纯函数库：零 IO、零网络、零 Remote/UI 依赖。所有函数对畸形输入一律防御性返回
// 空集合/原样副本，绝不抛错——上游 JSON 是远端 zip 里的内容，任何形状都可能出现。
//
// 实测参考结构（仅防御解析参考，不硬编码依赖）：
//   规则 = { id, when:{active_in:[]}, applies_to_connectors:[], requires_connected_connectors:[],
//            timing:"request", inject:[{from_connector, token_type, header, value_template}] }

/**
 * 解析 connectors.json 顶层的 auth_injection_rules 数组。
 * 非数组 / 字段缺失 / 元素不是对象 → 返回 []（绝不抛错）。
 * 元素原样保留（下游只读 id / applies_to_connectors / inject 等字段做展示）。
 */
export function parseInjectionRules(indexJson) {
  const rules = indexJson?.auth_injection_rules;
  if (!Array.isArray(rules)) return [];
  return rules.filter((rule) => rule && typeof rule === "object" && !Array.isArray(rule));
}

/**
 * 按 connectorId 命中规则：applies_to_connectors 数组包含该 id 即命中。
 * 返回命中规则数组（空输入 / 非数组 applies_to_connectors 一律不命中）。
 */
export function rulesFor(rules, connectorId) {
  if (!Array.isArray(rules)) return [];
  const id = String(connectorId ?? "").trim();
  if (!id) return [];
  return rules.filter((rule) => {
    const applies = rule?.applies_to_connectors;
    return Array.isArray(applies) && applies.map((entry) => String(entry ?? "").trim()).includes(id);
  });
}

/** 一个待填 token 槽位：占位符在哪个 server 的哪个容器字段里。 */
// 形状：{ server, container: "env"|"header"|"url", key, template, placeholder, value }
// url 槽位是「凭据写在连接地址里」的形态：`https://api.x/mcp/?token=${TOKEN}`。实测
// 连接器市场里有 12 条 auth_mode=token 只把占位符写在 url（tushare / 百度地图 / 快递100…），
// 只扫 env/headers 会让它们既没有可填槽位、又被判「未声明可替换」，安装入口整个消失。

const PLACEHOLDER_PATTERN = /\$\{([^}]+)\}/g;
// 非全局版：.test() 不会推进 lastIndex（全局正则连续 test 会漏判残留占位符）。
const HAS_PLACEHOLDER = /\$\{[^}]+\}/;

/**
 * 扫描 mcpServers 的 env / headers / url 里的 `${...}` 模板占位符。
 * 返回槽位清单：[{ server, container: "env"|"header"|"url", key, template, placeholder, value }]
 *   - container   字段容器：env → env 对象；header → headers 对象（对外统一命名）；
 *                 url → server 的连接地址（key 固定为 "url"）
 *   - template    原始模板串（如 "Bearer ${token}"、"?token=${TOKEN}"）
 *   - placeholder 第一个占位符（如 "token"）；模板无占位符的条目不进清单
 *   - value       原值（供 applyTokens 做精确字符串替换与回显）
 * mcpServers / env / headers / url 畸形（null、数组、值非字符串）一律跳过，不抛错。
 */
export function scanTokenSlots(mcpServers) {
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) return [];
  const slots = [];
  for (const [server, rawServer] of Object.entries(mcpServers)) {
    // transport 可能嵌套（wb-market.serverInstallability 的 nested 形态）：env/headers
    // 在 server 本体或 server.transport 上都认。
    const nested = rawServer && typeof rawServer === "object" && typeof rawServer.transport === "object" && rawServer.transport !== null
      ? rawServer.transport
      : (typeof rawServer === "object" && rawServer !== null ? rawServer : null);
    if (!nested) continue;
    const bags = [["env", nested.env], ["header", nested.headers]];
    for (const [container, bag] of bags) {
      if (!bag || typeof bag !== "object" || Array.isArray(bag)) continue;
      for (const [key, value] of Object.entries(bag)) {
        if (typeof value !== "string") continue;
        const matches = [...value.matchAll(PLACEHOLDER_PATTERN)];
        if (!matches.length) continue;
        slots.push({
          server,
          container,
          key,
          template: value,
          placeholder: matches[0][1].trim(),
          value,
        });
      }
    }
    // url 槽位：凭据写在连接地址里（?token=${X} / /mcp/${X}）。与 env/headers 分开处理，
    // 因为它在 server 本体的字符串字段上，applyTokens 也要按字符串整体替换。
    const urlValue = typeof nested.url === "string" ? nested.url : "";
    const urlMatches = urlValue ? [...urlValue.matchAll(PLACEHOLDER_PATTERN)] : [];
    if (urlMatches.length) {
      slots.push({
        server,
        container: "url",
        key: "url",
        template: urlValue,
        placeholder: urlMatches[0][1].trim(),
        value: urlValue,
      });
    }
  }
  return slots;
}

/**
 * 百分号编码只给 url 槽位用。
 *
 * 为什么必须有它：`fillPlaceholders` 原先对所有容器一律做原样字符串替换，而 url 槽位是
 * 拼在查询串里的（实测市场里 12 条 `auth_mode=token` 只把占位符写在 url，如
 * `https://mcp.map.qq.com/sse?key=${TENCENT_MAP_KEY}&format=0`）。token 一旦含 URL 保留字符，
 * 替换结果就不是「同一个值」了：`ab&c#d` 变成 `?key=ab&c#d&format=0`（服务器收到的是 `ab`，
 * `c` 成了新参数、`d` 掉进 fragment）；base64 / URL-token 形态密钥里常见的 `+` 会被解成
 * 空格，`/`、`?`、`=`、`#`、空格同理。用户侧表现只是一句 401 / 鉴权失败，联不到编码问题。
 *
 * 已经是纯百分号编码形态的值（`a%2Bb`）不再二次编码，否则会变成 `%252B`。
 * env / header 槽位**不走这里**——那两个容器原样传值才对，编码反而会破坏凭据。
 */
const ALREADY_ENCODED_SHAPE = /^[A-Za-z0-9\-._~%]*$/;
const BARE_PERCENT = /%(?![0-9a-fA-F]{2})/;
function encodeUrlToken(token) {
  const text = String(token);
  if (ALREADY_ENCODED_SHAPE.test(text) && !BARE_PERCENT.test(text)) return text;
  return encodeURIComponent(text);
}

/** 把模板串里所有有值 token 的占位符替换掉；无值占位符原样保留。 */
function fillPlaceholders(template, tokenMap, encode = null) {
  let filled = String(template);
  // 迭代基于进入时的模板，替换作用在累积结果上：先按名字去重，再逐个 split/join 全替换，
  // 同一个占位符出现多处（"Bearer ${a}/${b}" 那种）都能一次换净，也不会因为上一个 token
  // 的正文里恰好含 `${...}` 而被带偏。
  const names = new Set([...String(template).matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1].trim()));
  for (const name of names) {
    const token = tokenMap[name];
    if (typeof token !== "string" || !token.length) continue;
    filled = filled.split("${" + name + "}").join(encode ? encode(token) : token);
  }
  return filled;
}

/**
 * 按槽位把占位符替换为用户 token，产出「可安全写盘」的 mcpServers 副本。
 *   - tokens: Record<placeholder, value>，键为占位符名（如 { access_token: "xxx" }）。
 *   - 未提供 token 的槽位**保留原样**并在 missingSlots 里标记（供 UI 提示缺槽）。
 * 返回 { mcpServers, missingSlots }：
 *   mcpServers    深拷贝后的替换结果（原对象永不改动）
 *   missingSlots  [{ server, container, key, placeholder, template }] 未填槽位清单
 * 输入畸形时返回 { mcpServers: {}, missingSlots: [] }；对每个槽位同时应用模板内**所有**
 * 占位符（"Bearer ${a}/${b}" 两处都能换），全替换后仍含 `${` 的值按未填槽位上报。
 * url 槽位整串替换（`?token=${TOKEN}` → `?token=xxx`），写回 server.url / transport.url。
 */
export function applyTokens(mcpServers, tokens) {
  const source = mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers) ? mcpServers : {};
  const tokenMap = tokens && typeof tokens === "object" && !Array.isArray(tokens) ? tokens : {};
  const missingSlots = [];
  const result = structuredClone(source);
  const slots = scanTokenSlots(result);
  for (const slot of slots) {
    // url 槽位落在 server 本体的字符串字段上；transport 嵌套形态则落在 transport.url。
    const urlHolder = result[slot.server]?.transport && typeof result[slot.server].transport === "object"
      ? result[slot.server].transport
      : result[slot.server];
    const target = slot.container === "url"
      ? (urlHolder && typeof urlHolder.url === "string" ? urlHolder : null)
      : slot.container === "header"
        ? result[slot.server]?.transport?.headers ?? result[slot.server]?.headers
        : result[slot.server]?.transport?.env ?? result[slot.server]?.env;
    if (!target || typeof target !== "object") continue;
    // url 槽位要百分号编码（保留字符会改变查询串结构），env / header 槽位原样传值。
    const filled = fillPlaceholders(
      slot.container === "url" ? target.url : target[slot.key],
      tokenMap,
      slot.container === "url" ? encodeUrlToken : null,
    );
    if (HAS_PLACEHOLDER.test(filled)) {
      // 仍有残留占位符 → 该槽位缺 token：保留原样并上报。
      missingSlots.push({
        server: slot.server,
        container: slot.container,
        key: slot.key,
        placeholder: slot.placeholder,
        template: slot.template,
      });
    } else {
      target[slot.key] = filled;
    }
  }
  return { mcpServers: result, missingSlots };
}
