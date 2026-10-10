/* Generated for dsh-skill-mcp-board — do not edit. */
import { z } from 'zod'

const $any = z.unknown()
const $name = z.string()

// strict codec 的形状由宿主校验，而宿主在两个渠道上查**不同的键**：
//   0.1.5-rc.x（= 当时 latest/next，npx 默认装到的那条）查 `schema` 必须是 zod v4 实例；
//   0.1.6-alpha.2 起改查 `create()` 工厂，不再看 `schema`（registry 用
//   `record.value ??= record.create()` 在进程内 realm 物化 schema）。
// 两边都忽略对方的键，所以**两个都写**是唯一同时满足基线与 alpha 的形状：少写 `schema`
// 会在最新 RC 上加载即拒，少写 `create` 会在 alpha 上加载即拒（`mode: 'src-json'` 不是出路
// ——loader 强制 invocation 的 codec 必须是 strict）。实测形状矩阵见 docs/design.md「版本
// 范围怎么定」。lib/client.js 有一份同形状的副本，两处必须一起改。
const codec = (symbol, schema) => ({
  mode: 'strict',
  typeSymbol: `dsh-skill-mcp-board/typert#${symbol}`,
  schema,
  create: () => schema,
})

const mv = (method, params, resultSym) => ({
  id: `dsh-skill-mcp-board#mcpManager/${method}`,
  service: 'mcpManager',
  namespace: 'mcpManager',
  method,
  invocation: { kind: 'direct' },
  parameters: params,
  result: codec(resultSym, $any),
  sourceLocation: { file: 'dsh-skill-mcp-board/lib/typert.js', line: 7, column: 1 },
})

const nameParam = { name: 'name', wire: 'name', source: 'json', codec: codec('String', $name) }
const specParam = { name: 'spec', wire: 'spec', source: 'json', codec: codec('Spec', $any) }
const payloadParam = { name: 'payload', wire: 'payload', source: 'json', codec: codec('ImportPayload', $any) }
const builtinInstallParam = { name: 'payload', wire: 'payload', source: 'json', codec: codec('BuiltinInstallPayload', $any) }

export const TYPERT = {
  package: 'dsh-skill-mcp-board',
  face: 'host',
  schemas: [],
  invocations: [
    mv('list', [], 'ListResult'),
    mv('status', [nameParam], 'StatusResult'),
    mv('enable', [nameParam], 'NoteResult'),
    mv('disable', [nameParam], 'NoteResult'),
    mv('reconnect', [nameParam], 'NoteResult'),
    mv('tools', [payloadParam], 'ToolsResult'),
    mv('builtins', [], 'BuiltinCatalogResult'),
    mv('installBuiltins', [builtinInstallParam], 'BuiltinInstallResult'),
    mv('add', [specParam], 'NoteResult'),
    mv('update', [specParam], 'NoteResult'),
    mv('removeServer', [nameParam], 'NoteResult'),
    mv('reveal', [payloadParam], 'RevealResult'),
    mv('previewImport', [payloadParam], 'ImportPreview'),
    mv('importJson', [payloadParam], 'ImportResult'),
    mv('scanImportSources', [payloadParam], 'ImportSourcesResult'),
    mv('previewImportSource', [payloadParam], 'ImportPreview'),
    mv('importSource', [payloadParam], 'ImportResult'),
    mv('listWorkspaces', [], 'WorkspaceListResult'),
    mv('getWorkspaceView', [payloadParam], 'WorkspaceViewResult'),
    mv('addWorkspaceServer', [payloadParam], 'NoteResult'),
    mv('updateWorkspaceServer', [payloadParam], 'NoteResult'),
    mv('removeWorkspaceServer', [payloadParam], 'NoteResult'),
    mv('setWorkspaceExclude', [payloadParam], 'NoteResult'),
    mv('installWorkspaceBuiltins', [builtinInstallParam], 'BuiltinInstallResult'),
    mv('previewWorkspaceImport', [payloadParam], 'ImportPreview'),
    mv('importWorkspaceJson', [payloadParam], 'ImportResult'),
    mv('revealWorkspaceServer', [payloadParam], 'RevealResult'),
    mv('projectConnections', [], 'ProjectConnectionsResult'),
    mv('reconnectWorkspaceServer', [payloadParam], 'NoteResult'),
    mv('updateHint', [], 'UpdateHintResult'),
    mv('whatsNew', [], 'WhatsNewResult'),
    // Skill 看板（与 MCP 同一命名空间、同一信封：payload 进、{ok} 出）。
    mv('listSkills', [payloadParam], 'SkillListResult'),
    mv('skillDetail', [payloadParam], 'SkillDetailResult'),
    mv('revealSkill', [payloadParam], 'NoteResult'),
  ],
  model: { services: [], events: [], objects: [] },
}