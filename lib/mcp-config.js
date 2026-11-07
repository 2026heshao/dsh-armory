import { parseDocument, Scalar, YAMLMap, YAMLSeq, isMap, isSeq } from 'yaml'
import { isSafeExpression, makeEnvExpression, makeExpression } from './env-expression.js'
import { isCmdShellCommand, planStdioLaunch, win32LaunchContext } from './win32-stdio.js'

export const MCP_PLUGIN_NAME = '@deepseek-ai/dsh-mcp-client'
const JS_TAG = 'tag:yaml.org,2002:js'
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const MAX_TIMER_DELAY_MS = 2147483647
const MANAGED_CONFIG_FIELDS = ['transport', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'toolCallTimeoutMs', 'failOnStartupError', 'reconnect']
const INTERPOLATION = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-(.*?))?\}/g
const UNSUPPORTED_TEMPLATE = '不支持的变量表达式（只允许 ${VAR}、${VAR:-fallback} 与 ${env:VAR}）'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
}

function scalarValue(node) {
  if (node === undefined) return undefined
  if (node.tag === JS_TAG) return `!!js ${String(node.value)}`
  return node.value
}

function nodeValue(node) {
  if (node === undefined) return undefined
  if (isMap(node)) {
    const value = {}
    for (const pair of node.items) setOwn(value, String(scalarValue(pair.key)), nodeValue(pair.value))
    return value
  }
  if (isSeq(node)) return node.items.map(nodeValue)
  return scalarValue(node)
}

function getNode(map, key) {
  return isMap(map) ? map.get(key, true) : undefined
}

function getValue(map, key) {
  return nodeValue(getNode(map, key))
}

/**
 * `!!js \`…\`` 这一历史写法 → 受限表达式。`${process.env.X}` 是它唯一的变量语法；
 * 转出时一律走 `makeExpression`，因此产出的一定是「总值」表达式。
 */
function normalizeLegacyTemplate(value) {
  const legacy = /^!!js `([^`\\]*)`$/.exec(value)
  if (!legacy) return null
  const body = legacy[1]
  const pattern = /\$\{process\.env\.([A-Za-z_][A-Za-z0-9_]*)\}/g
  const tokens = []
  let cursor = 0
  let match
  let hasReference = false
  while ((match = pattern.exec(body))) {
    const literal = body.slice(cursor, match.index)
    if (literal.includes('${')) return null
    if (literal) tokens.push({ kind: 'literal', text: literal })
    tokens.push({ kind: 'env', name: match[1] })
    hasReference = true
    cursor = match.index + match[0].length
  }
  const tail = body.slice(cursor)
  if (!hasReference || tail.includes('${')) return null
  if (tail) tokens.push({ kind: 'literal', text: tail })
  return makeExpression(tokens)
}

function expressionValue(value) {
  if (typeof value !== 'string') return value
  if (value.startsWith('!!js ')) {
    if (isSafeExpression(value)) return value
    const normalized = normalizeLegacyTemplate(value)
    if (normalized) return normalized
    throw new Error('!!js 只允许受限的 process.env.NAME 环境变量表达式')
  }
  const reserved = /\$\{(?:workspaceFolder(?:Basename)?|userHome|pathSeparator|\/)\}/.exec(value)
  if (reserved) throw new Error(`${reserved[0]} 是其他客户端变量，DSH 不支持安全转换`)
  const exact = /^\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?\}$/.exec(value)
  // 一律走 makeEnvExpression：它**总会**补上 `?? ""`（理由见 env-expression.js）。变量缺失
  // 只该让这一处退化成空字符串——服务器自己连不上、面板里看得见——而不能把宿主一起拖下水。
  if (exact) return makeEnvExpression(exact[1], exact[2])

  const tokens = []
  let cursor = 0
  let match
  INTERPOLATION.lastIndex = 0
  while ((match = INTERPOLATION.exec(value))) {
    const literal = value.slice(cursor, match.index)
    // 不回显出错片段：这段文本来自用户配置（含密钥），错误信息会被送进浏览器。
    if (literal.includes('${')) throw new Error(UNSUPPORTED_TEMPLATE)
    if (literal) tokens.push({ kind: 'literal', text: literal })
    tokens.push(match[2] === undefined ? { kind: 'env', name: match[1] } : { kind: 'fallback', name: match[1], fallback: match[2] })
    cursor = match.index + match[0].length
  }
  INTERPOLATION.lastIndex = 0
  const tail = value.slice(cursor)
  if (tail.includes('${')) throw new Error(UNSUPPORTED_TEMPLATE)
  if (!tokens.length) return value
  if (tail) tokens.push({ kind: 'literal', text: tail })
  return makeExpression(tokens)
}

function normalizeMap(value, field, warnings, serverName) {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new Error(`${serverName}.${field} 必须是对象`)
  const result = {}
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === 'string') setOwn(result, key, expressionValue(raw))
    else if (raw === null) {
      setOwn(result, key, '')
      warnings.push(`${serverName}.${field}.${key} 不是字符串，已转换为空字符串`)
    } else {
      setOwn(result, key, expressionValue(String(raw)))
      warnings.push(`${serverName}.${field}.${key} 不是字符串，已转换为字符串`)
    }
  }
  return result
}

function normalizeArgs(value, serverName, warnings) {
  if (value === undefined) return undefined
  if (Array.isArray(value)) {
    if (!value.every((item) => typeof item === 'string')) throw new Error(`${serverName}.args 必须全部是字符串`)
    return value.map(expressionValue)
  }
  if (typeof value === 'string') {
    warnings.push(`${serverName}.args 是字符串，已作为一个完整参数保留；DSH 不会按 shell 规则拆分`)
    return [value]
  }
  throw new Error(`${serverName}.args 必须是字符串数组`)
}

function warnUnsupported(raw, serverName, warnings) {
  const fatal = ['envFile', 'oauth', 'headersHelper']
  for (const field of fatal) if (hasOwn(raw, field)) throw new Error(`${serverName}.${field} 在 DSH MCP 配置中不支持，无法安全转换`)
  const clientOnly = ['alwaysAllow', 'autoApprove', 'disabledTools', 'sandbox', 'sandboxEnabled', 'dev']
  for (const field of clientOnly) if (hasOwn(raw, field)) warnings.push(`${serverName}.${field} 是其他客户端字段，DSH 不会保存或执行`)
  if (hasOwn(raw, 'directTools')) {
    if (hasOwn(raw, 'disabled')) warnings.push(`${serverName}.directTools 已忽略；显式 disabled 优先`)
    else if (raw.directTools === true) warnings.push(`${serverName}.directTools: true 已转换为 disabled: false（DSH 始终直接注册 MCP 工具）`)
    else if (raw.directTools === false) warnings.push(`${serverName}.directTools: false 已转换为 disabled: true（DSH 不支持间接工具模式）`)
    else warnings.push(`${serverName}.directTools 不是布尔值，已忽略`)
  }
  if (hasOwn(raw, 'timeout') && !hasOwn(raw, 'toolCallTimeoutMs')) warnings.push(`${serverName}.timeout 的单位因客户端而异，未自动转换；如需设置请使用 toolCallTimeoutMs`)
  const known = new Set(['serverName', 'name', 'type', 'transport', 'command', 'args', 'env', 'cwd', 'url', 'serverUrl', 'server_url', 'headers', 'toolCallTimeoutMs', 'failOnStartupError', 'reconnect', 'idleTimeoutMs', 'readyTimeoutMs', 'disabled', 'timeout', 'directTools', ...fatal, ...clientOnly])
  for (const field of Object.keys(raw)) if (!known.has(field)) warnings.push(`${serverName}.${field} 不是 DSH MCP 字段，已忽略`)
}

function normalizeEntry(name, input, warnings, applyWin32Launch = true) {
  if (!isObject(input)) throw new Error(`${name} 必须是对象`)
  const raw = isObject(input.transport) ? { ...input, ...input.transport } : input
  const serverName = String(raw.serverName || raw.name || name).trim()
  if (!SERVER_NAME_PATTERN.test(serverName)) throw new Error(`${serverName || name} 不符合 DSH serverName 格式：[A-Za-z0-9_-]{1,32}`)
  warnUnsupported(raw, serverName, warnings)
  const hasCommand = typeof raw.command === 'string' && raw.command.trim() !== ''
  const url = raw.url ?? raw.serverUrl ?? raw.server_url
  const hasUrl = typeof url === 'string' && url.trim() !== ''
  if (hasCommand && hasUrl) throw new Error(`${serverName} 同时包含 command 和 url，无法判断传输方式`)
  let transport = raw.type ?? (typeof raw.transport === 'string' ? raw.transport : undefined)
  if (!transport) transport = hasCommand ? 'stdio' : hasUrl ? 'streamable-http' : undefined
  const aliases = { http: 'streamable-http', streamableHttp: 'streamable-http', 'streamable-http': 'streamable-http', stdio: 'stdio', sse: 'sse', ws: 'ws', websocket: 'ws' }
  transport = aliases[transport] || transport
  if (transport === 'sse' || transport === 'ws') throw new Error(`${serverName} 的传输 ${transport} 不受当前 DSH MCP 配置支持；请先转换成 Streamable HTTP`)
  if (transport !== 'stdio' && transport !== 'streamable-http') throw new Error(`${serverName} 缺少可识别的 stdio 或 HTTP 传输类型`)

  const result = { name: serverName, transport }
  if (transport === 'stdio') {
    if (!hasCommand) throw new Error(`${serverName} 的 stdio 配置缺少 command`)
    result.command = expressionValue(raw.command.trim())
    const args = normalizeArgs(raw.args, serverName, warnings)
    if (args?.length) result.args = args
    const env = normalizeMap(raw.env, 'env', warnings, serverName)
    if (env && Object.keys(env).length) result.env = env
    if (raw.cwd !== undefined) {
      if (typeof raw.cwd !== 'string') throw new Error(`${serverName}.cwd 必须是字符串`)
      if (raw.cwd) result.cwd = expressionValue(raw.cwd)
    }
    // win32 上以 `.cmd` 壳形态存在的裸 npx / npm 需要换成可 spawn 的本机 Node 形态，
    // 判据、实测与不确定性见 lib/win32-stdio.js 头注。
    //
    // `applyWin32Launch` 只在**写方向**为 true（默认）。读盘必须是 false：
    // `.dsh/mcp.json` 是项目共享、进版本库的文件，`readWorkspaceConfig` 一旦在读取时改写
    // command/args/env，任何「只动别的字段」的写回（屏蔽全局 server、移除条目、合并导入）
    // 都会把作者本机的绝对路径落进所有人的配置里，而 mac/Linux 永远不会把它还原。
    // 非 win32、绝对路径、${VAR} / !!js 表达式一律原样放行。
    if (applyWin32Launch) {
      const launchContext = win32LaunchContext()
      const launch = planStdioLaunch(result, launchContext)
      if (launch.rewritten) {
        if (launch.reason === 'repointed') {
          // 形态是本层留下的，但路径不在这台机器上（跨机导入 / Node 换位）：重指是必要的，
          // 也是最容易被用户误会成「配置自己变了」的一次改动，必须报出来。
          warnings.push(`${serverName}：原命令指向别台机器的 Node，已重指到本机启动器（${launch.spec.command}）；这份配置换机器要重新保存本条`)
        } else if (launch.reason === 'denormalized') {
          warnings.push(`${serverName}：原命令带着别台机器的 Windows 绝对路径，本机用不了，已还原成裸 ${launch.spec.command} 交给 PATH 解析`)
        } else {
          warnings.push(`${serverName}：Windows 上裸 ${result.command} 无法 spawn，已改用本机 Node 启动器（${launch.spec.command}）`)
        }
        result.command = launch.spec.command
        result.args = launch.spec.args
        if (launch.spec.env !== undefined) result.env = launch.spec.env
      } else if (launchContext.probeError && isCmdShellCommand(result.command)) {
        // 探测层异常时如实说明「本该归一但没归」，别让条目带着裸 npx 落盘后只剩一句连接失败。
        warnings.push(`${serverName}：本机 Node 启动器探测失败（${launchContext.probeError}），命令已按原样写入，Windows 上可能无法启动`)
      } else if (launch.reason === 'node-not-found') {
        // 比探测抛错更常见的降级：PATH 里没有 node.exe，或有 node 但同目录没有 npm 的
        // npx-cli.js（volta / scoop / pnpm 托管、以服务模式启动不继承登录 PATH、装完 Node
        // 还没重启宿主）。这一支以前既不改写也不发一句话，用户只在事后看到「Connection closed」，
        // 于是「装上要先修」根本无从下手。这里把缺什么、怎么办写进安装提示。
        warnings.push(`${serverName}：Windows 上没探测到可用的本机 Node 启动器（PATH 里缺 node.exe，或缺 node_modules/npm/bin/npx-cli.js），命令已按原样写入，很可能无法启动；装上 Node 并重启 DSH 后重新保存本条即可`)
      }
    }
  } else {
    const normalizedUrl = hasUrl ? expressionValue(url.trim()) : ''
    if (!hasUrl) throw new Error(`${serverName} 的 HTTP 配置需要 http(s):// URL`)
    if (!normalizedUrl.startsWith('!!js ')) {
      let parsedUrl
      try {
        parsedUrl = new URL(normalizedUrl)
      } catch {
        throw new Error(`${serverName} 的 HTTP 配置需要有效的 http(s):// URL`)
      }
      if (!['http:', 'https:'].includes(parsedUrl.protocol) || !parsedUrl.hostname) throw new Error(`${serverName} 的 HTTP 配置需要有效的 http(s):// URL`)
    }
    result.url = normalizedUrl
    const headers = normalizeMap(raw.headers, 'headers', warnings, serverName)
    if (headers && Object.keys(headers).length) result.headers = headers
  }
  if (raw.toolCallTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(raw.toolCallTimeoutMs) || raw.toolCallTimeoutMs < 1) throw new Error(`${serverName}.toolCallTimeoutMs 必须是正整数`)
    result.toolCallTimeoutMs = raw.toolCallTimeoutMs
  }
  if (raw.failOnStartupError !== undefined) {
    if (typeof raw.failOnStartupError !== 'boolean') throw new Error(`${serverName}.failOnStartupError 必须是布尔值`)
    result.failOnStartupError = raw.failOnStartupError
  }
  if (raw.reconnect !== undefined) {
    if (!isObject(raw.reconnect)) throw new Error(`${serverName}.reconnect 必须是对象`)
    const reconnect = {}
    const reconnectFields = ['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts']
    for (const key of reconnectFields) if (raw.reconnect[key] !== undefined) reconnect[key] = raw.reconnect[key]
    for (const key of Object.keys(raw.reconnect)) if (!reconnectFields.includes(key)) warnings.push(`${serverName}.reconnect.${key} 不是 DSH MCP 字段，已忽略`)
    for (const key of ['initialDelayMs', 'maxDelayMs']) {
      if (reconnect[key] !== undefined && (!Number.isFinite(reconnect[key]) || reconnect[key] <= 0)) throw new Error(`${serverName}.reconnect.${key} 必须是正数`)
      if (reconnect[key] !== undefined && reconnect[key] > MAX_TIMER_DELAY_MS) throw new Error(`${serverName}.reconnect.${key} 不能大于 ${MAX_TIMER_DELAY_MS}`)
    }
    if (reconnect.maxAttempts !== undefined && (!Number.isSafeInteger(reconnect.maxAttempts) || reconnect.maxAttempts < 1)) {
      throw new Error(`${serverName}.reconnect.maxAttempts 必须是正整数`)
    }
    if (reconnect.initialDelayMs !== undefined && reconnect.maxDelayMs !== undefined && reconnect.initialDelayMs > reconnect.maxDelayMs) {
      throw new Error(`${serverName}.reconnect.initialDelayMs 不能大于 maxDelayMs`)
    }
    if (reconnect.enabled !== undefined && typeof reconnect.enabled !== 'boolean') throw new Error(`${serverName}.reconnect.enabled 必须是布尔值`)
    result.reconnect = reconnect
  }
  if (raw.disabled !== undefined) {
    if (typeof raw.disabled !== 'boolean') throw new Error(`${serverName}.disabled 必须是布尔值`)
    result.disabled = raw.disabled
  } else if (raw.directTools === true) result.disabled = false
  else if (raw.directTools === false) result.disabled = true
  // 项目级连接的**空闲回收**策略（插件自己的字段，不下发给 mcp-client）：会话全部结束不等于
  // 「不再需要」，所以默认保留 5 分钟再回收；0 表示永不自动回收，显式拆除只能来自配置删除/改动、
  // 面板重建或插件卸载。它按 server 生效，属于项目配置面，因此**不**进 MANAGED_CONFIG_FIELDS
  // （那条清单是全局 profile patch 的投影面，写进去等于把它泄漏成全局字段）。
  if (raw.idleTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(raw.idleTimeoutMs) || raw.idleTimeoutMs < 0) throw new Error(`${serverName}.idleTimeoutMs 必须是非负整数（0 = 不回收）`)
    if (raw.idleTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`${serverName}.idleTimeoutMs 不能大于 ${MAX_TIMER_DELAY_MS}`)
    result.idleTimeoutMs = raw.idleTimeoutMs
  }
  // 挂载时等待这条连接就绪的**总预算**（毫秒，0 = 不等）。目的只有一个：让「首轮请求里就有工具」
  // 成为确定性结果，而不是一场竞态（mcp-client README 的第一条契约就是 tools appear before the
  // first turn）。超时不算失败：会话照常创建，面板按 fiber 状态如实显示「连接中/连接失败」。
  if (raw.readyTimeoutMs !== undefined) {
    if (!Number.isSafeInteger(raw.readyTimeoutMs) || raw.readyTimeoutMs < 0) throw new Error(`${serverName}.readyTimeoutMs 必须是非负整数（0 = 不等就绪）`)
    if (raw.readyTimeoutMs > MAX_TIMER_DELAY_MS) throw new Error(`${serverName}.readyTimeoutMs 不能大于 ${MAX_TIMER_DELAY_MS}`)
    result.readyTimeoutMs = raw.readyTimeoutMs
  }
  return result
}

/**
 * 归一化一批 server 定义。
 *
 * `options.applyWin32Launch`（默认 true）决定要不要做 win32 启动器改写：
 * - **写盘路径保持默认**（面板添加/编辑、JSON 导入、导入源）；
 * - **读盘路径必须显式传 false**（`lib/workspace-config.js` 的 `readWorkspaceConfig`），
 *   否则共享的 `.dsh/mcp.json` 会在"只是被读了一次"之后带上作者本机的绝对路径。
 */
export function normalizeMcpImport(input, options = {}) {
  if (!isObject(input)) throw new Error('JSON 根节点必须是对象')
  if (Array.isArray(input.inputs) && input.inputs.length) throw new Error('VS Code inputs 需要交互式取值，DSH 当前不支持安全转换')
  if (hasOwn(input, 'mcpServers') && hasOwn(input, 'servers')) throw new Error('JSON 同时包含 mcpServers 和 servers，无法确定应导入哪一组')
  let source = input.mcpServers ?? input.servers
  if (source === undefined && (input.command || input.url || input.serverUrl)) source = { [input.name || input.serverName || 'mcp-server']: input }
  if (!isObject(source)) throw new Error('JSON 中没有找到 mcpServers 或 servers 对象')
  const applyWin32Launch = options.applyWin32Launch !== false
  const warnings = []
  const servers = Object.entries(source).map(([name, value]) => normalizeEntry(name, value, warnings, applyWin32Launch))
  return { servers, warnings }
}

/**
 * 归一化之后同名的 serverName（`" a"` 与 `"a"` 会撞成同一个 `a`）。这里只做**检测**，
 * 处理策略留给边界，因为只有边界知道赌注是什么：
 * - 读一份配置文件（`.dsh/mcp.json`）→ 整份拒绝：文件自相矛盾，静默少一条更糟；
 * - 导入一批来源 / 粘贴 → 跳过重复项并逐条提示：不能让一条重名把其余条目挡在门外。
 */
export function duplicateServerNames(servers) {
  const seen = new Set()
  const duplicates = []
  for (const server of servers) {
    if (seen.has(server.name) && !duplicates.includes(server.name)) duplicates.push(server.name)
    seen.add(server.name)
  }
  return duplicates
}

function makeScalar(value) {
  if (typeof value === 'string' && value.startsWith('!!js ')) {
    const scalar = new Scalar(value.slice(5))
    scalar.tag = JS_TAG
    return scalar
  }
  return value
}

function makeNode(doc, value) {
  if (Array.isArray(value)) {
    const seq = new YAMLSeq()
    for (const item of value) seq.items.push(makeNode(doc, item))
    return seq
  }
  if (isObject(value)) {
    const map = new YAMLMap()
    for (const [key, item] of Object.entries(value)) map.set(key, makeNode(doc, item))
    return map
  }
  return makeScalar(value)
}

function entrySpec(entry) {
  const config = getNode(entry, 'config')
  const name = getValue(config, 'serverName')
  if (!isMap(config) || typeof name !== 'string') return null
  const spec = { name, transport: getValue(config, 'transport') }
  for (const field of ['command', 'args', 'env', 'cwd', 'url', 'headers', 'toolCallTimeoutMs', 'failOnStartupError', 'reconnect']) {
    const value = getValue(config, field)
    if (value !== undefined) spec[field] = value
  }
  if (getValue(entry, 'disabled') === true) spec.disabled = true
  return spec
}

function isMcpEntry(entry) {
  return isMap(entry) && getValue(entry, 'name') === MCP_PLUGIN_NAME && entrySpec(entry)
}

function makeEntry(doc, spec, id = `mcp-${spec.name}`) {
  const entry = new YAMLMap()
  entry.set('id', id)
  entry.set('name', MCP_PLUGIN_NAME)
  if (spec.disabled) entry.set('disabled', true)
  const config = new YAMLMap()
  config.set('serverName', spec.name)
  for (const field of ['transport', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'toolCallTimeoutMs', 'failOnStartupError', 'reconnect']) {
    if (spec[field] !== undefined) config.set(field, makeNode(doc, spec[field]))
  }
  entry.set('config', config)
  return entry
}

function parsePatch(content) {
  const doc = parseDocument(content || '')
  if (doc.errors.length) throw new Error(`MCP patch YAML 无法解析：${doc.errors[0].message}`)
  // 0 字节的文件、只有注释的文件，解析出来是 `contents: null` 而 errors 是 0 条——语法上
  // 完全合法。以前这里直接报「必须是 YAML 列表」，于是 `managedState` 整块失败、MCP 面板
  // 全白，而用户手上的文件根本没有写错。补一个空 seq 就能继续；String(doc) 会原样保留注释。
  if (doc.contents === null) doc.contents = new YAMLSeq()
  if (!isSeq(doc.contents)) throw new Error('MCP patch 必须是 YAML 列表')
  return doc
}

function findInsertSeq(item) {
  const insert = getNode(item, 'insert')
  return isSeq(insert) ? insert : null
}

export function readManagedMcpServers(content) {
  const doc = parsePatch(content)
  const servers = []
  const entryIds = {}
  const names = new Set()
  for (const item of doc.contents.items) {
    const insert = findInsertSeq(item)
    if (!insert) continue
    for (const entry of insert.items) {
      if (!isMcpEntry(entry)) continue
      const spec = entrySpec(entry)
      if (names.has(spec.name)) throw new Error(`当前 profile 中存在重复 serverName：${spec.name}`)
      names.add(spec.name)
      servers.push(spec)
      const id = getValue(entry, 'id')
      if (typeof id === 'string') setOwn(entryIds, spec.name, id)
    }
  }
  return { servers, entryIds }
}

function collectIds(node, ids = new Set()) {
  if (isMap(node)) {
    const id = getValue(node, 'id')
    if (typeof id === 'string') ids.add(id)
    for (const pair of node.items) collectIds(pair.value, ids)
  } else if (isSeq(node)) {
    for (const item of node.items) collectIds(item, ids)
  }
  return ids
}

function nextEntryId(name, ids) {
  const base = `mcp-${name}`
  let id = base
  let suffix = 2
  while (ids.has(id)) id = `${base}-${suffix++}`
  ids.add(id)
  return id
}

export function setManagedMcpDisabled(content, name, disabled) {
  const doc = parsePatch(content)
  for (const item of doc.contents.items) {
    const insert = findInsertSeq(item)
    if (!insert) continue
    for (const entry of insert.items) {
      const spec = isMcpEntry(entry) ? entrySpec(entry) : null
      if (spec?.name !== name) continue
      if (disabled) entry.set('disabled', true)
      else entry.delete('disabled')
      return String(doc)
    }
  }
  throw new Error(`当前 profile 中没有可管理的 MCP：${name}`)
}

function updateEntry(doc, entry, spec) {
  if (Object.hasOwn(spec, 'disabled')) {
    if (spec.disabled) entry.set('disabled', true)
    else entry.delete('disabled')
  }
  const config = getNode(entry, 'config')
  config.set('serverName', spec.name)
  for (const field of MANAGED_CONFIG_FIELDS) {
    if (spec[field] === undefined) config.delete(field)
    else config.set(field, makeNode(doc, spec[field]))
  }
}

export function updateManagedMcpPatch(content, specs, { replace = false, removeNames = [], reservedIds = [] } = {}) {
  const doc = parsePatch(content)
  const specByName = new Map(specs.map((spec) => [spec.name, spec]))
  const remove = new Set(removeNames)
  const updated = new Set()
  for (let index = doc.contents.items.length - 1; index >= 0; index -= 1) {
    const item = doc.contents.items[index]
    const insert = findInsertSeq(item)
    if (!insert) continue
    insert.items = insert.items.filter((entry) => {
      if (!isMcpEntry(entry)) return true
      const name = entrySpec(entry).name
      if (remove.has(name) || (replace && !specByName.has(name))) return false
      const spec = specByName.get(name)
      if (spec && !updated.has(name)) {
        updateEntry(doc, entry, spec)
        updated.add(name)
      }
      return true
    })
    if (insert.items.length === 0 && isMap(item) && item.items.length === 1) doc.contents.items.splice(index, 1)
  }
  const additions = specs.filter((spec) => !updated.has(spec.name))
  if (additions.length) {
    const ids = collectIds(doc.contents, new Set(reservedIds))
    const patch = new YAMLMap()
    const insert = new YAMLSeq()
    for (const spec of additions) insert.items.push(makeEntry(doc, spec, nextEntryId(spec.name, ids)))
    patch.set('insert', insert)
    doc.contents.items.push(patch)
  }
  return String(doc)
}
