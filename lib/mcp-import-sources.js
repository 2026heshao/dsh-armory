import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { envNamesIn } from './env-expression.js'
import { normalizeMcpImport } from './mcp-config.js'

/**
 * 从本机其他 MCP 客户端读取配置，供面板导入。
 *
 * 这一层只做三件事：解析已知客户端的配置文件位置、把各家格式翻译成
 * `normalizeMcpImport` 已经吃得下的形状（`mcpServers` / `servers`）、并把结果
 * 按需归一化成 DSH 内部 spec。它不碰文件写入、不碰 profile patch、也不知道
 * 浏览器存在——导入的写盘路径完全复用既有 `importJson` / `importWorkspaceJson`。
 *
 * 两条硬边界：
 * 1. **路径只在这里拼**，且只拼固定文件名；调用方（浏览器）永远不传路径进来，
 *    所以 Host 侧不存在"读任意文件"的接口面。
 * 2. **识别得出的条目逐个归一化**，单个条目不被支持不会让整个来源读不出来
 *    （Codex 的 `enabled_tools`、别的客户端的 SSE 条目都属于这一类）。
 *
 * 注意分工：这里做的是"读进来的东西能不能变成 spec"（逐条目容错），"这一批 spec
 * 能不能落盘"（同作用域唯一、环境变量引用为总值）在 `import-admission.js`，由写盘入口
 * 调用——读取层不做集合级判断，避免同一条规则又长一份。
 */

/** 单文件读取上限：`~/.claude.json` 这类文件会混进大量与 MCP 无关的历史数据。 */
export const MAX_SOURCE_BYTES = 8 * 1024 * 1024

const TOO_LARGE_CODE = 'CODE_TOO_LARGE'

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function setOwn(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true })
}

function appDataDir(ctx) {
  if (ctx.platform === 'win32') return ctx.env.APPDATA || join(ctx.home, 'AppData', 'Roaming')
  if (ctx.platform === 'darwin') return join(ctx.home, 'Library', 'Application Support')
  return ctx.env.XDG_CONFIG_HOME || join(ctx.home, '.config')
}

/** OpenCode 这类跟随 XDG 的工具在**所有平台**上都用 `~/.config`（不是 Windows 的 APPDATA）。 */
function xdgConfigDir(ctx) {
  return ctx.env.XDG_CONFIG_HOME || join(ctx.home, '.config')
}

/** 展示用路径：把 home 前缀换回 `~`，避免把用户名带进浏览器。 */
export function displayPath(path, home) {
  if (!home) return path
  const normalized = path.replace(/\\/g, '/')
  const prefix = home.replace(/\\/g, '/')
  return normalized === prefix || normalized.startsWith(`${prefix}/`) ? `~${normalized.slice(prefix.length)}` : path
}

// ---------------------------------------------------------------------------
// Codex：TOML → mcpServers 条目
// ---------------------------------------------------------------------------

/**
 * Codex 有、DSH 没有对应物的字段。逐个列出而不是"未识别的都忽略"，
 * 是因为这些字段恰恰是用户自己配过、会以为被带过来的东西。
 */
const CODEX_NO_EQUIVALENT = {
  env_vars: '环境变量透传白名单',
  experimental_environment: '远程执行环境',
  startup_timeout_sec: '启动超时（由宿主统一管理）',
  startup_timeout_ms: '启动超时（由宿主统一管理）',
  required: 'required（与 DSH 的 failOnStartupError 语义不同）',
  enabled_tools: '工具白名单',
  disabled_tools: '工具黑名单',
  default_tools_approval_mode: '工具审批模式',
  tools: '按工具覆盖',
  auth: 'OAuth 认证策略',
  oauth: 'OAuth 客户端配置',
  oauth_resource: 'OAuth resource',
  scopes: 'OAuth scopes',
  http_headers_helper: '动态 header 助手',
  bearer_token: 'Bearer token 字面量（Codex 自身也拒绝该字段）',
  experimental_use_rmcp_client: '实验性客户端开关',
}

function codexSecondsToMs(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value * 1000) : undefined
}

/**
 * `[mcp_servers.<name>]` 的表 → 条目列表。两个映射是有实义的转换而不是丢弃：
 * `bearer_token_env_var` 变 `Authorization: Bearer ${VAR}`，`env_http_headers` 的值变 `${VAR}`；
 * 两者都会在下一步被转成受限的 `!!js` 表达式。
 */
function codexEntryToMcp(name, raw, warnings) {
  const entry = {}
  const hasCommand = typeof raw.command === 'string' && raw.command.trim() !== ''
  const hasUrl = typeof raw.url === 'string' && raw.url.trim() !== ''
  if (hasCommand && hasUrl) throw new Error(`${name} 同时配置了 command 和 url，Codex 本身也会拒绝`)

  if (hasCommand) {
    entry.command = raw.command.trim()
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || !raw.args.every((item) => typeof item === 'string')) throw new Error(`${name}.args 必须是字符串数组`)
      if (raw.args.length) entry.args = [...raw.args]
    }
    if (raw.env !== undefined) {
      if (!isObject(raw.env)) throw new Error(`${name}.env 必须是表`)
      entry.env = { ...raw.env }
    }
    if (typeof raw.cwd === 'string' && raw.cwd) entry.cwd = raw.cwd
  } else if (hasUrl) {
    entry.url = raw.url.trim()
    const headers = {}
    if (raw.http_headers !== undefined) {
      if (!isObject(raw.http_headers)) throw new Error(`${name}.http_headers 必须是表`)
      for (const [key, value] of Object.entries(raw.http_headers)) setOwn(headers, key, value)
    }
    if (raw.env_http_headers !== undefined) {
      if (!isObject(raw.env_http_headers)) throw new Error(`${name}.env_http_headers 必须是表`)
      for (const [key, variable] of Object.entries(raw.env_http_headers)) {
        if (typeof variable !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
          warnings.push(`${name}.env_http_headers.${key} 不是环境变量名，已忽略`)
          continue
        }
        setOwn(headers, key, `\${${variable}}`)
      }
    }
    if (raw.bearer_token_env_var !== undefined) {
      const variable = raw.bearer_token_env_var
      if (typeof variable !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable)) {
        warnings.push(`${name}.bearer_token_env_var 不是环境变量名，已忽略`)
      } else if (Object.hasOwn(headers, 'Authorization')) {
        warnings.push(`${name} 同时配置了 bearer_token_env_var 与 http_headers.Authorization，已保留后者`)
      } else {
        setOwn(headers, 'Authorization', `Bearer \${${variable}}`)
      }
    }
    if (Object.keys(headers).length) entry.headers = headers
  } else {
    throw new Error(`${name} 既没有 command 也没有 url`)
  }

  if (raw.tool_timeout_sec !== undefined) {
    const timeout = codexSecondsToMs(raw.tool_timeout_sec)
    if (timeout === undefined) warnings.push(`${name}.tool_timeout_sec 不是正数，已忽略`)
    else entry.toolCallTimeoutMs = timeout
  }
  if (raw.enabled === false) entry.disabled = true
  else if (raw.enabled !== undefined && raw.enabled !== true) warnings.push(`${name}.enabled 不是布尔值，已按启用处理`)

  const consumed = new Set(['tool_timeout_sec', 'enabled'])
  // 按传输方式判定「已处理」：Codex 自己也只认对应的那一半字段（stdio 不接受
  // http_headers、HTTP 不接受 args）。另一半落到下面的提示里，不会被静默丢掉。
  if (hasCommand) for (const field of ['command', 'args', 'env', 'cwd']) consumed.add(field)
  else for (const field of ['url', 'http_headers', 'env_http_headers', 'bearer_token_env_var']) consumed.add(field)
  for (const [field, label] of Object.entries(CODEX_NO_EQUIVALENT)) {
    if (Object.hasOwn(raw, field) && !consumed.has(field)) warnings.push(`${name}.${field}（${label}）在 DSH MCP 配置里没有对应项，已忽略`)
  }
  const transport = hasCommand ? 'stdio' : 'streamable_http'
  for (const field of Object.keys(raw)) {
    if (consumed.has(field) || Object.hasOwn(CODEX_NO_EQUIVALENT, field)) continue
    warnings.push(`${name}.${field} 不是 Codex 为 ${transport} 传输定义的字段，已忽略`)
  }
  return entry
}

function codexToMcpEntries(parsed) {
  const table = isObject(parsed) && isObject(parsed.mcp_servers) ? parsed.mcp_servers : null
  if (table === null) return null
  const entries = []
  for (const [name, raw] of Object.entries(table)) {
    if (!isObject(raw)) {
      entries.push({ name, error: `${name} 不是 Codex MCP 表` })
      continue
    }
    // 条目级提示跟着条目走，预览才能只列「你要导入的那几条」的提示。
    const entryWarnings = []
    try {
      entries.push({ name, raw: codexEntryToMcp(name, raw, entryWarnings), warnings: entryWarnings })
    } catch (error) {
      entries.push({ name, error: String(error?.message ?? error), warnings: entryWarnings })
    }
  }
  return entries
}

// ---------------------------------------------------------------------------
// OpenCode：`mcp` 表 → mcpServers 条目
// ---------------------------------------------------------------------------

/**
 * OpenCode 的插值是 `{env:VAR}`（**没有 `$`**）；不转换就会被当成普通字面量写进 profile。
 * 转成 `${env:VAR}` 后交给既有的表达式转换器。
 */
const OPENCODE_ENV = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g
const opencodeValue = (value) => (typeof value === 'string' ? value.replace(OPENCODE_ENV, '${env:$1}') : value)

function opencodeStringMap(value, name, field) {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new Error(`${name}.${field} 必须是对象`)
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, opencodeValue(String(item))]))
}

function opencodeEntryToMcp(name, raw, warnings) {
  const type = raw.type
  const entry = {}
  if (type === 'local') {
    // OpenCode 把可执行文件与参数合在一个数组里，DSH 分开存。
    if (!Array.isArray(raw.command) || !raw.command.length || !raw.command.every((part) => typeof part === 'string')) {
      throw new Error(`${name}.command 必须是「可执行文件 + 参数」的字符串数组`)
    }
    entry.command = opencodeValue(raw.command[0])
    const args = raw.command.slice(1).map((part) => opencodeValue(part))
    if (args.length) entry.args = args
    const env = opencodeStringMap(raw.environment, name, 'environment')
    if (env && Object.keys(env).length) entry.env = env
    if (typeof raw.cwd === 'string' && raw.cwd) entry.cwd = opencodeValue(raw.cwd)
  } else if (type === 'remote') {
    if (typeof raw.url !== 'string' || !raw.url.trim()) throw new Error(`${name}.url 必须是非空字符串`)
    entry.url = opencodeValue(raw.url.trim())
    const headers = opencodeStringMap(raw.headers, name, 'headers')
    if (headers && Object.keys(headers).length) entry.headers = headers
  } else {
    throw new Error(`${name}.type 必须是 local 或 remote`)
  }
  if (raw.enabled === false) entry.disabled = true
  else if (raw.enabled !== undefined && raw.enabled !== true) warnings.push(`${name}.enabled 不是布尔值，已按启用处理`)
  // `timeout` 是 OpenCode「取工具清单」的超时（默认 5000ms），与 DSH 的 toolCallTimeoutMs
  // 不是一回事，不自动转换（这两条提示也把「为什么不映射」说清楚）。
  if (raw.timeout !== undefined) warnings.push(`${name}.timeout 是 OpenCode 取工具清单的超时，与 DSH 的 toolCallTimeoutMs 语义不同，未自动转换`)
  if (isObject(raw.oauth)) warnings.push(`${name}.oauth 是 OpenCode 的 OAuth 配置，DSH MCP 配置没有对应项，已忽略`)

  const consumed = new Set(['type', 'enabled', 'timeout', 'oauth'])
  if (type === 'local') for (const field of ['command', 'environment', 'cwd']) consumed.add(field)
  else for (const field of ['url', 'headers']) consumed.add(field)
  for (const field of Object.keys(raw)) {
    if (!consumed.has(field)) warnings.push(`${name}.${field} 不是 OpenCode MCP 字段，已忽略`)
  }
  return entry
}

function opencodeToMcpEntries(parsed) {
  const table = isObject(parsed) && isObject(parsed.mcp) ? parsed.mcp : null
  if (table === null) return null
  const entries = []
  for (const [name, raw] of Object.entries(table)) {
    if (!isObject(raw)) {
      entries.push({ name, error: `${name} 必须是对象` })
      continue
    }
    const entryWarnings = []
    try {
      entries.push({ name, raw: opencodeEntryToMcp(name, raw, entryWarnings), warnings: entryWarnings })
    } catch (error) {
      entries.push({ name, error: String(error?.message ?? error), warnings: entryWarnings })
    }
  }
  return entries
}

// ---------------------------------------------------------------------------
// 来源表：新增一个客户端 = 这里加一行 + 一份 fixture
// ---------------------------------------------------------------------------

const pick = (key) => (parsed) => {
  const section = isObject(parsed) ? parsed[key] : undefined
  if (!isObject(section)) return null
  const entries = []
  for (const [name, raw] of Object.entries(section)) {
    if (!isObject(raw)) {
      entries.push({ name, error: `${name} 必须是对象` })
      continue
    }
    entries.push({ name, raw })
  }
  return entries
}

/**
 * 一个位置的候选文件，按顺序取第一个存在的（`oneOf` 只是为了写起来短）。
 * 格式属于**文件**而不是客户端：OpenCode 的 `.json` 与 `.jsonc` 就在同一个位置上。
 */
function oneOf(scope, candidates) {
  return { scope, candidates: candidates.map(([path, format = 'json']) => ({ path, format })) }
}
const file = (scope, path, format = 'json') => oneOf(scope, [[path, format]])
/** 项目作用域位置：没有 workspace 上下文时直接不产出，避免拼出半截路径。 */
function projectFile(ctx, segments, format = 'json') {
  return ctx.cwd ? [file('project', join(ctx.cwd, ...segments), format)] : []
}

/**
 * `select(parsed, warnings)` 的契约：返回条目数组 `[{ name, raw, warnings? }]`，
 * 格式转换阶段就失败的条目直接返回 `{ name, error, warnings? }`；`null` 表示
 * 这份配置里根本没有该客户端使用的段落（与「段落是空的」是两回事，提示文案不同）。
 * 条目自带诊断，所以 normalizeSourceText 不必往下游塞魔法字段。
 *
 * `locations(ctx)` 的不变量：**每个作用域最多一个位置**。来源的 key 就是
 * `sourceId:scope`，多一个同作用域的位置就会撞 key。同一个客户端有多个候选文件
 * （OpenCode 的 `.json` / `.jsonc`）就放进同一个位置的 candidates。
 */
export const IMPORT_SOURCES = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    locations: (ctx) => [
      file('global', join(ctx.env.CLAUDE_CONFIG_DIR || ctx.home, '.claude.json')),
      ...projectFile(ctx, ['.mcp.json']),
    ],
    select: pick('mcpServers'),
  },
  {
    id: 'codex',
    label: 'Codex',
    locations: (ctx) => [
      file('global', join(ctx.env.CODEX_HOME || join(ctx.home, '.codex'), 'config.toml'), 'toml'),
      ...projectFile(ctx, ['.codex', 'config.toml'], 'toml'),
    ],
    select: codexToMcpEntries,
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    locations: (ctx) => [
      ctx.env.OPENCODE_CONFIG
        ? file('global', ctx.env.OPENCODE_CONFIG, ctx.env.OPENCODE_CONFIG.endsWith('.jsonc') ? 'jsonc' : 'json')
        : oneOf('global', [
            [join(xdgConfigDir(ctx), 'opencode', 'opencode.json')],
            [join(xdgConfigDir(ctx), 'opencode', 'opencode.jsonc'), 'jsonc'],
          ]),
      ...(ctx.cwd
        ? [oneOf('project', [
            [join(ctx.cwd, 'opencode.json')],
            [join(ctx.cwd, 'opencode.jsonc'), 'jsonc'],
          ])]
        : []),
    ],
    select: opencodeToMcpEntries,
  },
  {
    id: 'pi',
    label: 'pi',
    locations: (ctx) => [
      file('global', join(ctx.env.PI_CODING_AGENT_DIR || join(ctx.home, '.pi', 'agent'), 'mcp.json')),
      ...projectFile(ctx, ['.pi', 'mcp.json']),
    ],
    select: pick('mcpServers'),
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    locations: (ctx) => [file('global', join(appDataDir(ctx), 'Claude', 'claude_desktop_config.json'))],
    select: pick('mcpServers'),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    locations: (ctx) => [
      file('global', join(ctx.home, '.cursor', 'mcp.json')),
      ...projectFile(ctx, ['.cursor', 'mcp.json']),
    ],
    select: pick('mcpServers'),
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    locations: (ctx) => [file('global', join(ctx.home, '.codeium', 'windsurf', 'mcp_config.json'))],
    select: pick('mcpServers'),
  },
  {
    id: 'vscode',
    label: 'VS Code',
    locations: (ctx) => [
      file('global', join(appDataDir(ctx), 'Code', 'User', 'mcp.json')),
      ...projectFile(ctx, ['.vscode', 'mcp.json']),
    ],
    select: pick('servers'),
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    locations: (ctx) => [file('global', join(ctx.home, '.gemini', 'settings.json'))],
    select: pick('mcpServers'),
  },
  {
    id: 'roo-code',
    label: 'Roo Code',
    locations: (ctx) => [
      file('global', join(ctx.home, '.roo', 'mcp.json')),
      ...projectFile(ctx, ['.roo', 'mcp.json']),
    ],
    select: pick('mcpServers'),
  },
  {
    // 跨工具的共享约定（pi 的适配器、以及其它工具都读它），不是某个客户端专属。
    id: 'shared-mcp',
    label: '共享 MCP 配置',
    locations: (ctx) => [
      oneOf('global', [
        [join(xdgConfigDir(ctx), 'mcp', 'mcp.json')],
        [join(ctx.home, '.agents', 'mcp.json')],
        [join(ctx.home, '.agents', 'mcp', 'mcp.json')],
      ]),
    ],
    select: pick('mcpServers'),
  },
]

function findImportSource(id) {
  return IMPORT_SOURCES.find((source) => source.id === id) || null
}

// ---------------------------------------------------------------------------
// 读取与归一化
// ---------------------------------------------------------------------------

/**
 * 去掉 JSONC 的注释与尾随逗号。必须自己跟字符串状态：`"https://x"` 里的 `//` 不是注释，
 * `"a\"b"` 里的转义引号也不能提前结束字符串——正则版一定会在 URL 上炸。
 */
function stripTrailingCommas(text) {
  let out = ''
  let inString = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      out += char
      if (char === '\\') {
        out += text[index + 1] ?? ''
        index += 1
        continue
      }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === ',') {
      let next = index + 1
      while (next < text.length && /\s/.test(text[next])) next += 1
      if (text[next] === '}' || text[next] === ']') continue
    }
    out += char
  }
  return out
}

export function stripJsonComments(text) {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (inLine) {
      // 行注释的终止必须和 JSON 的换行定义一致：只认 `\n` 会让 CR-only（经典 Mac 换行）
      // 或 U+2028/U+2029 之后的整段配置被当作注释吃掉，而不是解析失败。
      if (char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029') {
        inLine = false
        // `\n`/`\r` 本身就是合法 JSON 空白，原样保留；U+2028/U+2029 不是（JSON.parse 不认），
        // 统一成换行，否则"结束注释"会变成"解析失败"。
        out += char === '\u2028' || char === '\u2029' ? '\n' : char
      }
      continue
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false
        index += 1
      }
      continue
    }
    if (inString) {
      out += char
      if (char === '\\') {
        out += next ?? ''
        index += 1
        continue
      }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      out += char
      continue
    }
    if (char === '/' && next === '/') {
      inLine = true
      index += 1
      continue
    }
    if (char === '/' && next === '*') {
      inBlock = true
      index += 1
      continue
    }
    out += char
  }
  return stripTrailingCommas(out)
}

const PARSE_LABEL = { json: 'JSON', jsonc: 'JSONC', toml: 'TOML' }

function parseSourceText(format, text) {
  if (format === 'toml') return parseToml(text)
  if (format === 'jsonc') return JSON.parse(stripJsonComments(text))
  return JSON.parse(text)
}

/**
 * 解析失败时的行列号。**绝不复用解析器的 message**：smol-toml 会把出错那一行原文
 * 贴进 message（`1:  command = `），早版本的 V8 也会把 JSON 片段回显出来——而这段文本
 * 来自用户机器上的配置文件，里面常有密钥。只保留行号。
 */
function parseFailure(error, text) {
  if (Number.isInteger(error?.line) && error.line > 0) return error.line
  const message = String(error?.message ?? '')
  const column = /\(line (\d+) column /.exec(message)
  if (column) return Number(column[1])
  const position = /position (\d+)/.exec(message)
  if (position) return text.slice(0, Number(position[1])).split('\n').length
  return 0
}

/**
 * 按来源解析文本并归一化成 DSH spec。逐条目容错：一条不支持不影响其余条目。
 * 返回的 `spec` 是 Host 侧内部值（含 `!!js` 表达式与字面密钥），**不得**直接发给浏览器。
 */
/** UTF-8 BOM：Windows 上的记事本、PS 5.1 的 Out-File 会写，JSON.parse 不认。 */
const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

export function normalizeSourceText(source, text, format = 'json') {
  let parsed
  const content = stripBom(text)
  try {
    parsed = parseSourceText(format, content)
  } catch (error) {
    const line = parseFailure(error, content)
    return { entries: [], warnings: [], error: `不是合法 ${PARSE_LABEL[format] || format}${line ? `（第 ${line} 行附近）` : ''}` }
  }
  if (!isObject(parsed)) return { entries: [], warnings: [], error: '配置根节点必须是对象' }
  // VS Code 的 ${input:...} 需要交互取值，normalizeMcpImport 会整份拒绝；
  // 在取段落之前就给出同样的判断，避免一条输入变量吞掉整份文件。
  const warnings = []
  if (Array.isArray(parsed.inputs) && parsed.inputs.length > 0) {
    return { entries: [], warnings, error: 'VS Code inputs 需要交互式取值，DSH 当前不支持安全转换' }
  }
  const selected = source.select(parsed, warnings)
  if (selected === null) return { entries: [], warnings, error: '没有找到该客户端使用的 MCP 段落' }
  const entries = []
  for (const item of selected) {
    const carried = item.warnings || []
    if (item.error) {
      entries.push({ name: item.name, spec: null, error: item.error, warnings: carried })
      continue
    }
    try {
      const normalized = normalizeMcpImport({ mcpServers: { [item.name]: item.raw } })
      entries.push({ name: item.name, spec: normalized.servers[0], error: null, warnings: [...carried, ...normalized.warnings] })
    } catch (error) {
      entries.push({ name: item.name, spec: null, error: String(error?.message ?? error), warnings: carried })
    }
  }
  if (!entries.length) return { entries, warnings, error: '这条配置里没有 MCP' }
  return { entries, warnings, error: '' }
}

export function hashSourceText(text) {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * spec 里引用了、但当前环境里没有值的变量名。只回名字（回值就会把密钥送进浏览器）。
 * 导入后这些位置会退化成空字符串——那是个看得见的连接失败，不是启动失败，但用户
 * 应该在此之前就被告知。
 *
 * 取名字走 env-expression 的分词器而不是正则扫全文：字符串字面量里的 `process.env.X`
 * 是文案不是引用，扫全文会把它算成"缺值变量"，在界面上给出一条假提示。
 */
export function missingEnvNames(spec, env) {
  const names = []
  const walk = (value) => {
    if (typeof value === 'string') {
      for (const name of envNamesIn(value)) if (!names.includes(name)) names.push(name)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (isObject(value)) for (const item of Object.values(value)) walk(item)
  }
  for (const field of ['command', 'cwd', 'url', 'args', 'env', 'headers']) walk(spec[field])
  return names.filter((name) => !env?.[name])
}

function readError(error) {
  const code = error?.code
  if (code === TOO_LARGE_CODE) return `文件超过 ${Math.round(MAX_SOURCE_BYTES / 1024 / 1024)} MB 上限，已跳过`
  if (code === 'EISDIR') return '路径是目录'
  return String(error?.message ?? error)
}

/**
 * 在位置的候选文件里挑第一个存在的。读失败（超限/无权限/目录）就地报告、不再往后试：
 * 否则会静默换成一个用户没在界面上看到的文件。
 */
async function pickCandidate(location, readText) {
  for (const candidate of location.candidates) {
    try {
      return { candidate, text: await readText(candidate.path, MAX_SOURCE_BYTES) }
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      return { candidate, error }
    }
  }
  return null
}

/**
 * 检查一条来源位置。
 * `readText(path, maxBytes)` 由 Host 注入：它必须在读取前用文件大小拦掉超大文件。
 */
async function inspectImportLocation(source, location, ctx, readText) {
  // 一个候选都不存在时，拿第一个候选的路径作报错对象，让「未找到」说得具体。
  const first = location.candidates[0].path
  const row = {
    key: `${source.id}:${location.scope}`,
    sourceId: source.id,
    label: source.label,
    scope: location.scope,
    path: first,
    displayPath: displayPath(first, ctx.home),
    exists: false,
    error: '',
    contentHash: '',
    entries: [],
    warnings: [],
  }
  const picked = await pickCandidate(location, readText)
  if (!picked) return row
  row.path = picked.candidate.path
  row.displayPath = displayPath(picked.candidate.path, ctx.home)
  row.exists = true
  if (picked.error) {
    // 文件在那儿、只是读不出来：报出来，不要假装客户端没装。
    row.error = readError(picked.error)
    return row
  }
  row.contentHash = hashSourceText(picked.text)
  const normalized = normalizeSourceText(source, picked.text, picked.candidate.format)
  row.entries = normalized.entries
  row.warnings = normalized.warnings
  row.error = normalized.error
  return row
}

/**
 * 扫描**某一层**的来源位置：`scope` 由调用方显式给出（= 当前导入目标那一层），
 * 只返回摸得到的（存在的）位置，缺失的按「该客户端没装 / 没配」看待。
 *
 * 「看到的来源 == 会写进去的那一层」是这条功能的界面不变量：全局标签只列全局来源，
 * 项目标签只列当前项目的来源。用户不需要自己判断「这一行会导到哪儿去」。
 */
export async function collectImportLocations(ctx, readText, scope) {
  const rows = []
  for (const source of IMPORT_SOURCES) {
    for (const location of source.locations(ctx)) {
      if (location.scope !== scope) continue
      const row = await inspectImportLocation(source, location, ctx, readText)
      if (row.exists) rows.push(row)
    }
  }
  return rows
}

/**
 * 重新定位一条来源并解析。导入前必须重读：浏览器只送回 `sourceId`/`scope`
 * 和内容指纹，路径由 Host 自己再算一次，`contentHash` 用来发现"预览之后文件被改了"。
 */
export async function resolveImportLocation(ctx, { sourceId, scope }, readText) {
  const source = findImportSource(sourceId)
  if (!source) throw new Error(`未知的导入来源：${sourceId}`)
  const wanted = scope === 'project' ? 'project' : 'global'
  if (wanted === 'project' && !ctx.cwd) throw new Error('项目作用域需要 workspace 路径')
  const location = source.locations(ctx).find((item) => item.scope === wanted)
  if (!location) throw new Error(`来源 ${sourceId} 不支持${wanted === 'project' ? '项目' : '全局'}作用域`)
  return inspectImportLocation(source, location, ctx, readText)
}
