
const REDACTED_VALUE = '__DSH_MCP_REDACTED__'
const LOG_URL = /\bhttps?:\/\/[^\s"'<>]+/gi
const SENSITIVE_KEY_SOURCE = '(?:authorization|auth[-_]?token|api[-_]?key|token|secret|password|[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))'
const SENSITIVE_DOUBLE_QUOTED = new RegExp(`(^|[^A-Za-z0-9_])(["']?${SENSITIVE_KEY_SOURCE}["']?\\s*[:=]\\s*)"(?:\\\\.|[^"\\\\])*"`, 'gim')
const SENSITIVE_SINGLE_QUOTED = new RegExp(`(^|[^A-Za-z0-9_])(["']?${SENSITIVE_KEY_SOURCE}["']?\\s*[:=]\\s*)'(?:\\\\.|[^'\\\\])*'`, 'gim')
const SENSITIVE_ASSIGNMENT = new RegExp(`(^|[^A-Za-z0-9_])(["']?${SENSITIVE_KEY_SOURCE}["']?\\s*[:=]\\s*)(?!["'])(?:(?:Bearer|Basic)\\s+)?[^\\s,;)}\\]]+`, 'gim')
const SENSITIVE_DOUBLE_FLAG = /(--(?:api[-_]?key|token|secret|password)\s+)"(?:\\.|[^"\\])*"/gi
const SENSITIVE_SINGLE_FLAG = /(--(?:api[-_]?key|token|secret|password)\s+)'(?:\\.|[^'\\])*'/gi
const SENSITIVE_FLAG = /(--(?:api[-_]?key|token|secret|password)\s+)[^\s,;)}\]]+/gi
const EMBEDDED_ARGS = /(^|[^A-Za-z0-9_])(["']?args["']?\s*[:=]\s*)\[/im
const BEARER_VALUE = /\b(Bearer|Basic)\s+[^\s,;)}\]]+/gi
const SENSITIVE_LOG_KEY = /(?:authorization|auth[-_]?token|api[-_]?key|token|secret|password|private[-_]?key)/i
const SENSITIVE_LOG_CONTAINER = /^(?:args|env|headers)$/i

function redactStructuredLog(value, key = '') {
  if (SENSITIVE_LOG_CONTAINER.test(key)) {
    return Array.isArray(value) ? [REDACTED_VALUE] : REDACTED_VALUE
  }
  if (SENSITIVE_LOG_KEY.test(key)) return REDACTED_VALUE
  if (Array.isArray(value)) return value.map((item) => redactStructuredLog(item))
  if (value && typeof value === 'object') {
    const result = {}
    for (const [childKey, childValue] of Object.entries(value)) result[childKey] = redactStructuredLog(childValue, childKey)
    return result
  }
  return value
}

function redactEmbeddedArgs(value) {
  const match = EMBEDDED_ARGS.exec(value)
  if (!match) return value
  return `${value.slice(0, match.index)}${match[1]}${match[2]}["${REDACTED_VALUE}"]...`
}

function redactLogUrl(value) {
  const punctuation = /[),.;\]}]+$/.exec(value)?.[0] || ''
  const candidate = punctuation ? value.slice(0, -punctuation.length) : value
  try {
    const url = new URL(candidate)
    if (url.username || url.password || url.search || url.hash) return REDACTED_VALUE + punctuation
    return candidate + punctuation
  } catch {
    return REDACTED_VALUE + punctuation
  }
}

export function sanitizeMcpLog(value) {
  const raw = String(value ?? '')
  let text = raw
  try {
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') text = JSON.stringify(redactStructuredLog(parsed))
  } catch {
    // Non-JSON log lines are handled by the text patterns below.
    text = redactEmbeddedArgs(text)
  }
  text = text.replace(LOG_URL, redactLogUrl)
  text = text.replace(SENSITIVE_DOUBLE_QUOTED, `$1$2"${REDACTED_VALUE}"`)
  text = text.replace(SENSITIVE_SINGLE_QUOTED, `$1$2'${REDACTED_VALUE}'`)
  text = text.replace(SENSITIVE_ASSIGNMENT, `$1$2${REDACTED_VALUE}`)
  text = text.replace(SENSITIVE_DOUBLE_FLAG, `$1"${REDACTED_VALUE}"`)
  text = text.replace(SENSITIVE_SINGLE_FLAG, `$1'${REDACTED_VALUE}'`)
  text = text.replace(SENSITIVE_FLAG, `$1${REDACTED_VALUE}`)
  text = text.replace(BEARER_VALUE, `$1 ${REDACTED_VALUE}`)
  return text.length > 2000 ? `${text.slice(0, 1997)}...` : text
}

/**
 * 单一连接判定：MCP 是否“已连接”只由工具注册结果决定。
 * fiber 处于 ACTIVE 只能说明 mcp-client 插件在跑，不能说明握手成功
 * （failOnStartupError=false 时 ECONNREFUSED 也会让 fiber 保持 ACTIVE）。
 *
 * @param row - summarize() 产出的行（phase 已归一化为语义名）。
 * @param lastLog - 该 server 最近一条 mcp-client 日志（可为 null）。
 * @returns 'connected' | 'failed' | 'waiting' | 'loading' | 'stopped' | 'disabled'
 */
export function deriveMcpPhase(row, lastLog) {
  if (!row.enabled) return 'disabled'
  if (row.toolCount > 0) return 'connected'
  if (row.toolCountAmbiguous) return 'unknown'
  if (row.phase === 'failed') return 'failed'
  if (row.phase === 'loading' || row.phase === 'waiting') return 'loading'
  if (row.phase !== 'connected') return 'stopped'
  // mcp-client 的 apply() 会等待首次连接和 tools/list 结束后才让 fiber ACTIVE。
  // 因此 ACTIVE 且 0 工具已经是“不可用”的终态证据，不应继续显示连接中。
  return 'failed'
}

/**
 * 把 logger Message 格式化为可展示文本。
 * 复用 Cordis Logger.format 的语义：首个参数为 Error 时输出 stack，
 * 否则按 % 占位符拼接。这里做简化实现（不引用 reggol），保持零依赖。
 */
export function formatMcpLog(message) {
  const args = message.args || []
  if (args.length && args[0] instanceof Error) {
    return args[0].stack || args[0].message
  }
  if (typeof args[0] === 'string') {
    return args.join(' ')
  }
  return args.map((value) => (value && typeof value === 'object' ? JSON.stringify(redactStructuredLog(value)) : String(value))).join(' ')
}
