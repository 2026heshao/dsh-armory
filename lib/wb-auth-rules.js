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
// 形状：{ server, container: "env"|"header", key, template, placeholder, value }

const PLACEHOLDER_PATTERN = /\$\{([^}]+)\}/g;
// 非全局版：.test() 不会推进 lastIndex（全局正则连续 test 会漏判残留占位符）。
const HAS_PLACEHOLDER = /\$\{[^}]+\}/;

/**
 * 扫描 mcpServers 的 env 与 headers 值里的 `${...}` 模板占位符。
 * 返回槽位清单：[{ server, container: "env"|"header", key, template, placeholder, value }]
 *   - container   字段容器：env → env 对象；header → headers 对象（对外统一命名）
 *   - template    原始模板串（如 "Bearer ${token}"）
 *   - placeholder 第一个占位符（如 "token"）；模板无占位符的条目不进清单
 *   - value       原值（供 applyTokens 做精确字符串替换与回显）
 * mcpServers / env / headers 畸形（null、数组、值非字符串）一律跳过，不抛错。
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
  }
  return slots;
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
 */
export function applyTokens(mcpServers, tokens) {
  const source = mcpServers && typeof mcpServers === "object" && !Array.isArray(mcpServers) ? mcpServers : {};
  const tokenMap = tokens && typeof tokens === "object" && !Array.isArray(tokens) ? tokens : {};
  const missingSlots = [];
  const result = structuredClone(source);
  const slots = scanTokenSlots(result);
  for (const slot of slots) {
    const target = slot.container === "header"
      ? result[slot.server]?.transport?.headers ?? result[slot.server]?.headers
      : result[slot.server]?.transport?.env ?? result[slot.server]?.env;
    if (!target || typeof target !== "object") continue;
    let filled = String(target[slot.key]);
    for (const match of filled.matchAll(PLACEHOLDER_PATTERN)) {
      const token = tokenMap[match[1].trim()];
      if (typeof token === "string" && token.length) {
        filled = filled.split(match[0]).join(token);
      }
    }
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
