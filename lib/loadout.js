// 装备清单（loadout）：把「这台机器装了什么」变成一份可分享、可对比的清单。
//
// 边界（决定了这里为什么只做投影，不做安装）：
//   - 只记录名称 / 类型 / 来源 / 版本这类**身份信息**，绝不写入 env、header、
//     token、authorization 或任何配置值；MCP 最多保留 env/header 的**键名**。
//   - 导入只做解析与差异计算，不写盘、不安装、不调用任何市场写链。
//   - 清单是用户主动导出、主动分享的文件；没有后端、没有账号、没有遥测。
//
// 数据层保持纯函数：宿主只负责收集本机条目，校验与 diff 都在这里，可独立测试。
export const LOADOUT_SCHEMA = "dsh-armory/loadout@1";
export const LOADOUT_MAX_ITEMS = 200;
export const LOADOUT_MAX_BYTES = 256 * 1024;
export const LOADOUT_DEFAULT_NAME = "我的 DSH 装备清单";

const KINDS = new Set(["mcp", "skill", "expert", "plugin"]);
const TRANSPORTS = new Set(["http", "stdio", "local", "?"]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g;

function text(value, limit) {
  return String(value ?? "").replace(CONTROL_CHARS, " ").trim().slice(0, limit);
}

function keyOf(item) {
  return `${item.kind}\u0000${item.name}`;
}

/** 单条投影：只放行白名单字段，其余（含任何看起来像密钥的键）一律丢弃。 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const kind = text(raw.kind, 20).toLowerCase();
  if (!KINDS.has(kind)) return null;
  const name = text(raw.name, 120);
  if (!name) return null;

  const item = { kind, name };
  const source = text(raw.source, 200);
  if (source) item.source = source;
  const version = text(raw.version, 100);
  if (version) item.version = version;
  const updatedAt = text(raw.updatedAt, 60);
  if (updatedAt) item.updatedAt = updatedAt;

  if (kind === "mcp") {
    const transport = text(raw.transport, 12).toLowerCase();
    if (TRANSPORTS.has(transport)) item.transport = transport;
    const endpointHost = text(raw.endpointHost, 200);
    if (endpointHost) item.endpointHost = endpointHost;
    if (Array.isArray(raw.configKeys)) {
      const keys = [];
      for (const value of raw.configKeys) {
        const key = text(value, 80);
        if (!key || keys.includes(key)) continue;
        keys.push(key);
        if (keys.length >= 20) break;
      }
      if (keys.length) item.configKeys = keys;
    }
    if (typeof raw.enabled === "boolean") item.enabled = raw.enabled;
  } else if (kind === "expert") {
    const plugin = text(raw.plugin, 160);
    if (plugin) item.plugin = plugin;
  } else if (kind === "plugin") {
    const key = text(raw.key, 160);
    if (key) item.key = key;
  }
  return item;
}

function countItems(items) {
  const counts = { total: items.length, mcp: 0, skill: 0, expert: 0, plugin: 0 };
  for (const item of items) counts[item.kind] += 1;
  return counts;
}

function countStatuses(rows) {
  const counts = { total: rows.length, installed: 0, update: 0, missing: 0 };
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/**
 * 解析并校验一份清单（对象或 JSON 文本）。
 * 非法结构直接抛错；单条非法 / 重复静默丢弃，避免一个坏行毁掉整份清单。
 */
export function normalizeLoadout(input) {
  let raw = input;
  if (typeof input === "string") {
    if (input.length > LOADOUT_MAX_BYTES) throw new Error("装备清单文件过大（上限 256KB）");
    try {
      raw = JSON.parse(input);
    } catch {
      throw new Error("不是有效的 JSON");
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("装备清单必须是一个对象");
  if (raw.schema !== LOADOUT_SCHEMA) throw new Error("不是 dsh-armory 装备清单（schema 不匹配）");
  if (!Array.isArray(raw.items)) throw new Error("装备清单缺少 items 数组");

  const items = [];
  const seen = new Set();
  for (const row of raw.items) {
    const item = normalizeItem(row);
    if (!item) continue;
    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
    if (items.length >= LOADOUT_MAX_ITEMS) break;
  }

  const loadout = {
    schema: LOADOUT_SCHEMA,
    name: text(raw.name, 120) || LOADOUT_DEFAULT_NAME,
    generatedAt: text(raw.generatedAt, 60),
    items,
    counts: countItems(items),
  };
  if (raw.app && typeof raw.app === "object") {
    const name = text(raw.app.name, 80);
    const version = text(raw.app.version, 40);
    if (name) loadout.app = { name, ...(version ? { version } : {}) };
  }
  if (raw.truncated === true) loadout.truncated = true;
  return loadout;
}

/** 由本机收集到的条目构建一份可导出的清单。 */
export function buildLoadout({ name, items, generatedAt, appVersion } = {}) {
  const sourceItems = Array.isArray(items) ? items : [];
  const loadout = normalizeLoadout({
    schema: LOADOUT_SCHEMA,
    name: text(name, 120) || LOADOUT_DEFAULT_NAME,
    generatedAt: text(generatedAt, 60) || new Date().toISOString(),
    app: { name: "dsh-armory", version: text(appVersion, 40) },
    items: sourceItems,
  });
  if (sourceItems.length > LOADOUT_MAX_ITEMS) loadout.truncated = true;
  return loadout;
}

/**
 * 与清单做本机差异对比。
 * 只按 kind + name 匹配；双方都有版本且不同才算「可更新」，避免把缺版本的条目误判。
 */
export function diffLoadout(remoteInput, localItems) {
  const remote = normalizeLoadout(remoteInput);
  const local = new Map();
  for (const row of Array.isArray(localItems) ? localItems : []) {
    const item = normalizeItem(row);
    if (item && !local.has(keyOf(item))) local.set(keyOf(item), item);
  }
  const rows = remote.items.map((item) => {
    const hit = local.get(keyOf(item));
    const status = !hit ? "missing" : item.version && hit.version && item.version !== hit.version ? "update" : "installed";
    return { ...item, status, localVersion: hit?.version || "" };
  });
  return {
    loadout: {
      schema: remote.schema,
      name: remote.name,
      generatedAt: remote.generatedAt,
      counts: remote.counts,
    },
    rows,
    counts: countStatuses(rows),
  };
}

/** 稳定、人类可读的导出文本。 */
export function stringifyLoadout(input) {
  return JSON.stringify(normalizeLoadout(input), null, 2);
}

/** 下载文件名：保留中文，只清理 Windows / URL 不接受的字符。 */
export function loadoutFileName(name) {
  const base = text(name, 80).replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  return `${base || "dsh-loadout"}.json`;
}
