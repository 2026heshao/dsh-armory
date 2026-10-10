/**
 * `!!js` 受限表达式的**唯一**所有者。
 *
 * 这个语言只有三类 term——字符串字面量、`process.env.NAME`、`(process.env.NAME ?? "…")`——
 * 用顶层 `+` 拼接。它有四个方向的使用者：生成（导入器把 `${VAR}` 变成它）、校验（写入前的
 * 安全检查）、抽取（缺值环境变量提示）、反转与求值（项目文件的 `${VAR}` 模板与建连取值）。
 * 四份实现迟早会漂移，而漂移的代价是真实的：**接受面比产出面宽一格**就足以让裸的
 * `process.env.X` 被当成"合法表达式"直通，变量缺失时求值为 `undefined`，而 mcp-client 的
 * Config 只接受字符串，宿主于是整棵插件树加载失败（本地实测过）。所以这里只有一份语法：
 * `makeExpression` 是唯一的产出形式，`parseExpression` 是唯一的接受判据。
 *
 * 边界：本模块只认识这一种语言。`${VAR}` 模板、JSONC、TOML 都不是它的事。
 */

const JS_PREFIX = '!!js '
const ENV_TOKEN = /^process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/
const FALLBACK_TOKEN = /^\(process\.env\.([A-Za-z_][A-Za-z0-9_]*) \?\? ("(?:\\.|[^"\\])*")\)$/
const STRING_TOKEN = /^"(?:\\.|[^"\\])*"$/

/**
 * 按顶层 `+` 拆分拼接表达式；字符串字面量内部的 `+` 不拆。
 * 引号前连续反斜杠为奇数 → 转义引号，不能当作字符串结束。
 */
function splitTopLevel(body) {
  const tokens = []
  let cursor = 0
  let inString = false
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char === '"') {
      if (!inString) {
        inString = true
      } else {
        let slashes = 0
        for (let previous = index - 1; previous >= 0 && body[previous] === '\\'; previous -= 1) slashes += 1
        if (slashes % 2 === 0) inString = false
      }
      continue
    }
    if (char === '+' && !inString) {
      tokens.push(body.slice(cursor, index).trim())
      cursor = index + 1
    }
  }
  tokens.push(body.slice(cursor).trim())
  return tokens.filter(Boolean)
}

/**
 * 解析 `!!js …`。返回 token 列表，`null` 表示"不是受限表达式"。
 * token：`{ kind: 'literal', text }` / `{ kind: 'env', name }` / `{ kind: 'fallback', name, fallback }`。
 */
export function parseExpression(value) {
  if (typeof value !== 'string' || !value.startsWith(JS_PREFIX)) return null
  const body = value.slice(JS_PREFIX.length).trim()
  if (!body) return null
  const tokens = []
  for (const part of splitTopLevel(body)) {
    let match = STRING_TOKEN.exec(part)
    if (match) {
      tokens.push({ kind: 'literal', text: JSON.parse(part) })
      continue
    }
    match = ENV_TOKEN.exec(part)
    if (match) {
      tokens.push({ kind: 'env', name: match[1] })
      continue
    }
    match = FALLBACK_TOKEN.exec(part)
    if (match) {
      tokens.push({ kind: 'fallback', name: match[1], fallback: JSON.parse(match[2]) })
      continue
    }
    return null
  }
  return tokens.length ? tokens : null
}

function renderToken(token) {
  if (token.kind === 'literal') return JSON.stringify(token.text)
  if (token.kind === 'fallback') return `(process.env.${token.name} ?? ${JSON.stringify(token.fallback)})`
  return `(process.env.${token.name} ?? "")`
}

/**
 * token 列表 → 规范表达式。**总会**给每个环境变量引用补上 `?? ""`，即产出的一定是
 * 「总值」表达式：变量缺失只让这一处退化为空字符串（服务器自己连不上，面板里看得见），
 * 而不是把 `undefined` 交给只接受字符串的 Config。
 */
export function makeExpression(tokens) {
  return JS_PREFIX + tokens.map(renderToken).join(' + ')
}

/** 单个环境变量引用的规范写法：`${VAR}` / `${VAR:-fallback}` 模板的唯一产出形式。 */
export function makeEnvExpression(name, fallback) {
  return makeExpression([fallback === undefined ? { kind: 'env', name } : { kind: 'fallback', name, fallback }])
}

/** 受限表达式 → 规范（总值）形式；不是受限表达式时返回 `null`。 */
export function canonicalizeExpression(value) {
  const tokens = parseExpression(value)
  return tokens ? makeExpression(tokens) : null
}

/** 是否是受限表达式。 */
export function isSafeExpression(value) {
  return parseExpression(value) !== null
}

/** 是否每个环境变量引用都有兜底——只有这种表达式可以安全地交给宿主求值。 */
export function isTotalExpression(value) {
  const tokens = parseExpression(value)
  return tokens !== null && tokens.every((token) => token.kind !== 'env')
}

/**
 * 引用了哪些环境变量。只认真正的引用：字符串字面量里的 `process.env.X`
 * 是文案，不是引用（用正则扫全文会把它算成缺值变量，让界面多一条假提示）。
 */
export function envNamesIn(value) {
  const tokens = parseExpression(value)
  if (!tokens) return []
  const names = []
  for (const token of tokens) {
    if (token.kind === 'literal' || names.includes(token.name)) continue
    names.push(token.name)
  }
  return names
}

/**
 * 受限表达式 → `${VAR}` / `${VAR:-fallback}` 模板（项目文件里对其他工具可见的写法）。
 * 无法安全反转时抛错：宁可拒绝写盘，也不把 JS 表达式当普通字符串存进 JSON。
 */
export function toTemplate(value) {
  if (typeof value !== 'string') return value
  if (!value.startsWith(JS_PREFIX)) return value
  // 报文里不放表达式原文：这段值可能来自用户主目录里的配置文件（含密钥），而写入失败
  // 是经 RPC 回浏览器的。诊断信息够定位（哪个字段由外层补），值本身不出 Host。
  if (!value.slice(JS_PREFIX.length).trim()) throw new Error('空的 !!js 表达式无法写回项目配置')
  const tokens = parseExpression(value)
  if (!tokens) throw new Error('无法安全写回项目配置的表达式')
  let output = ''
  let hasTemplate = false
  for (const token of tokens) {
    if (token.kind === 'literal') {
      output += token.text
      continue
    }
    hasTemplate = true
    output += token.kind === 'fallback' && token.fallback !== '' ? `\${${token.name}:-${token.fallback}}` : `\${${token.name}}`
  }
  if (!hasTemplate && output === '') throw new Error('空的 !!js 表达式无法写回项目配置')
  return output
}

/**
 * 求值受限表达式（`process.env` / `?? fallback` / 字面量拼接）。非表达式原样返回；
 * 无法求值时抛错（绝不把 JS 字符串当普通字面量传下去）。裸引用缺值退化为空字符串，
 * 与 `?? ""` 一致。
 */
export function evaluateExpression(value, env = process.env) {
  if (typeof value !== 'string' || !value.startsWith(JS_PREFIX)) return value
  // 同 toTemplate：报文不回显表达式原文（可能是含密钥的配置值）。
  if (!value.slice(JS_PREFIX.length).trim()) throw new Error('空的 !!js 表达式无法求值')
  const tokens = parseExpression(value)
  if (!tokens) throw new Error('无法求值的 !!js 表达式')
  let output = ''
  for (const token of tokens) {
    if (token.kind === 'literal') {
      output += token.text
      continue
    }
    output += env?.[token.name] ?? (token.kind === 'fallback' ? token.fallback : '')
  }
  return output
}
