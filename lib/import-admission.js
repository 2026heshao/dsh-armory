import { canonicalizeExpression, isTotalExpression } from './env-expression.js'
import { duplicateServerNames } from './mcp-config.js'

/**
 * 导入准入：把「刚读进来的 spec 集合」变成「可以落盘的 spec 集合」。
 *
 * 这是**唯一**表达"一份导入结果能不能写进配置"的地方。规则的归属是刻意的分工：
 * - 逐条目容错属于读取层（`normalizeSourceText`：一条不支持不影响同文件其余条目）；
 * - 集合自洽属于提交层（这里：整份结果要落进同一个作用域，就必须整体成立）。
 *
 * 两条不变量，任何一条被破坏都对应实测过的真事故：
 *
 * 1. **同一作用域内 serverName 唯一**。官方 mcp-client 按注册作用域预留 serverName，同作用域
 *    重名在插件加载时直接抛（`mcp-client: serverName "x" is already in use by another
 *    mcp-client instance`）——整棵插件树起不来；项目层则是在写 JSON 时被对象键静默覆盖、丢条目。
 *    粘贴路径原有一份去重，但它住在 `normalizeMcpImport` 里、随逐条目调用生效；来源导入正是
 *    逐条目调 `normalizeMcpImport` 的，于是那份去重整体失效。规则搬到这里，两个入口（以及
 *    以后任何入口）一并受保护。
 * 2. **环境变量引用必须是「总值」表达式**（`(process.env.X ?? "")`）。裸引用在变量缺失时求值为
 *    `undefined`，而 mcp-client 的 Config 只接受字符串——同样是宿主起不来。来源文件里现成的
 *    `!!js` 值同样要归一（不能因为"不是我生成的"就直通）。
 *
 * 规范化是**递归整份 spec**，不是维护一张"哪些字段可能带表达式"的清单：那张清单会随
 * `expressionValue` 支持新字段而静默过期，而 `!!js ` 前缀在本仓库只有一种含义。
 *
 * 幂等：`admitImportedServers(admitImportedServers(x))` 等价于一次调用，所以预览与写盘可以各自
 * 调一次，不需要约定谁先谁后。
 */

function canonicalizeAt(value, path) {
  if (typeof value === 'string') {
    if (!value.startsWith('!!js ') || isTotalExpression(value)) return value
    const canonical = canonicalizeExpression(value)
    // 不静默放行：写下去就是宿主求值时的失败，而不是解析失败。正常路径到这里之前已被
    // `expressionValue` 拒过；这条是给"以后有人把手工拼的 spec 塞进准入"兜底。
    // 报文只给字段路径，不回显值本身——值可能来自用户主目录里的配置。
    if (canonical === null) throw new Error(`导入结果的 ${path} 含不受支持的 !!js 表达式`)
    return canonical
  }
  if (Array.isArray(value)) return value.map((item, index) => canonicalizeAt(item, `${path}[${index}]`))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, canonicalizeAt(item, path ? `${path}.${key}` : key)]))
  }
  return value
}

/**
 * 输入/输出都是 `{ servers, warnings }`（`normalizeMcpImport` 与 `selectSourceServers` 的产出
 * 形状）。非导入结果不要调用它。
 *
 * 同名条目的处理是**保留先出现的那条、跳过其余**，并把名字放进 `skipped` 与 `warnings`：
 * 一条重名不该把整批挡在门外（用户勾了 8 条、其中 1 条重名，却一条都导不进来，是更差的体验）。
 * 跳过而不是覆盖，是因为那两条本来就是不同的服务器配置，谁覆盖谁都没有依据——真正的解法是让用户
 * 在来源文件里改名，提示里因此给出冲突的名字。
 */
export function admitImportedServers(normalized) {
  const servers = (normalized?.servers ?? []).map((server, index) => canonicalizeAt(server, `servers[${index}]`))
  const duplicates = duplicateServerNames(servers)
  const seen = new Set()
  const unique = servers.filter((server) => (seen.has(server.name) ? false : Boolean(seen.add(server.name))))
  // `skipped` 只累加：预览与写盘各自准入一次（幂等），第二次不该丢掉第一次记下的名字——否则
  // 导入结果的"跳过 N 条"会变成空话。提示只在**本次**真的跳过时追加，重复调用不会重复报警。
  const skipped = [...(normalized?.skipped ?? []), ...duplicates]
  const warnings = [...(normalized?.warnings ?? [])]
  if (duplicates.length) {
    warnings.push(`同名条目只保留先出现的那条，已跳过：${duplicates.join('、')}（同一作用域内 serverName 只能有一条）`)
  }
  return { ...normalized, servers: unique, skipped, warnings }
}
