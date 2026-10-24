/* Generated for dsh-armory — do not edit. */
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
  typeSymbol: `dsh-armory/typert#${symbol}`,
  schema,
  create: () => schema,
})

const mv = (method, params, resultSym) => ({
  id: `dsh-armory#mcpManager/${method}`,
  service: 'mcpManager',
  namespace: 'mcpManager',
  method,
  invocation: { kind: 'direct' },
  parameters: params,
  result: codec(resultSym, $any),
  sourceLocation: { file: 'dsh-armory/lib/typert.js', line: 7, column: 1 },
})

const nameParam = { name: 'name', wire: 'name', source: 'json', codec: codec('String', $name) }
const specParam = { name: 'spec', wire: 'spec', source: 'json', codec: codec('Spec', $any) }
const payloadParam = { name: 'payload', wire: 'payload', source: 'json', codec: codec('ImportPayload', $any) }

export const TYPERT = {
  package: 'dsh-armory',
  face: 'host',
  schemas: [],
  invocations: [
    mv('list', [], 'ListResult'),
    mv('status', [nameParam], 'StatusResult'),
    mv('enable', [nameParam], 'NoteResult'),
    mv('disable', [nameParam], 'NoteResult'),
    mv('reconnect', [nameParam], 'NoteResult'),
    mv('tools', [payloadParam], 'ToolsResult'),
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
    mv('previewWorkspaceImport', [payloadParam], 'ImportPreview'),
    mv('importWorkspaceJson', [payloadParam], 'ImportResult'),
    mv('revealWorkspaceServer', [payloadParam], 'RevealResult'),
    mv('projectConnections', [], 'ProjectConnectionsResult'),
    mv('reconnectWorkspaceServer', [payloadParam], 'NoteResult'),
    mv('updateHint', [], 'UpdateHintResult'),
    mv('whatsNew', [], 'WhatsNewResult'),
    // 安装形态（spec / source / profileDir）：客户端「一键升级」的安全判据。
    // 缺这一行 = 客户端 call('installInfo') 恒 404 → 按钮退回链接形态（同 toolTailor 的坑）。
    mv('installInfo', [], 'InstallInfoResult'),
    // Skill 看板（与 MCP 同一命名空间、同一信封：payload 进、{ok} 出）。
    mv('listSkills', [payloadParam], 'SkillListResult'),
    mv('skillDetail', [payloadParam], 'SkillDetailResult'),
    mv('revealSkill', [payloadParam], 'NoteResult'),
    // 卸载已安装 skill：永久删除用户级/项目级 skills 根目录内的条目。三处契约缺一即 404，
    // 删除规则全在 lib/skill-remove.js（来源白名单 / 根目录包含性 / 符号链接只删链接）。
    mv('removeSkill', [payloadParam], 'NoteResult'),
    // 安装时间 + 市场原名（Skill 看板卡片徽标 /「最近安装」排序的数据源）：宿主自扫
    // 标准根目录按 SKILL.md name 建映射，出 { ok, info: { [name]: { installedAt, ... } } }。
    // 不按 listSkills 行的 path 查——注册表行可能整列缺 path（实测）。形状由
    // lib/skill-dir-times.js 校验，与 wb* 系列同一宽容度（payload $any）。
    mv('skillInstallInfo', [payloadParam], 'SkillInstallInfoResult'),
    // 自定义套件（Skill 看板的「一组相关 skill 打包引用」）：读 = 全量集合，
    // 存 = 整集合覆盖（UI 一次提交右侧全部套件，不做增量 upsert）。数据层在
    // lib/suites-registry.js，id 分配 / 成员去重保序 / 脏数据拒绝都在那边，
    // 契约层与 listSkills 同一宽容度（payload $any）。
    mv('listSkillSuites', [], 'SkillSuiteListResult'),
    mv('saveSkillSuites', [payloadParam], 'SkillSuiteSaveResult'),
    // 工具裁缝（1.7.0 起的宿主方法）：此前两端契约双双缺失 = 客户端永远调不到，
    // 面板上一直是 404 ——「工具裁缝无法正常使用」的根因。payload 形状由
    // lib/tool-ledger.js 校验，与 wb* 系列同一宽容度。
    mv('toolTailor', [payloadParam], 'TailorReport'),
    // WorkBuddy 市场直连（连接器 MCP + SkillHub 技能）。payload 全部 $any：数据形状由
    // lib/wb-market.js 校验，契约层与 importJson 同一宽容度。
    mv('wbConnectorCatalog', [], 'WbCatalogResult'),
    // 顶栏「市场」chip 常驻计数：只读磁盘缓存，零网络；无缓存返回 { total: null }。
    mv('wbConnectorCachedCount', [], 'WbCachedCountResult'),
    mv('wbConnectorPreview', [payloadParam], 'WbPreviewResult'),
    // 市场连接器卡片头像：payload {connectorId}，出 {ok, dataUrl}。卡片进视口才调。
    mv('wbConnectorIcon', [payloadParam], 'WbIconResult'),
    mv('wbConnectorInstall', [payloadParam], 'NoteResult'),
    mv('wbSkillCatalog', [payloadParam], 'WbSkillListResult'),
    mv('wbSkillDetail', [payloadParam], 'WbSkillDetailResult'),
    mv('wbSkillInstall', [payloadParam], 'NoteResult'),
    mv('wbSkillUninstall', [payloadParam], 'NoteResult'),
    mv('wbSkillInstalled', [], 'WbInstalledResult'),
    // T03/R4：多市场注册表（读 / 增改）。payload $any，形状由 lib/wb-registry.js 校验。
    mv('wbMarketRegistry', [], 'WbMarketRegistryResult'),
    mv('wbMarketRegistryUpsert', [payloadParam], 'WbMarketRegistryResult'),
    // T04/R8：安装状态登记与查询（宿主侧落盘，客户端「已安装」筛选的数据源）。
    mv('wbInstallState', [], 'InstallStateResult'),
    mv('wbInstallStateRecord', [payloadParam], 'NoteResult'),
    mv('wbInstallStateForget', [payloadParam], 'NoteResult'),
    // T06/Awesome：DSH 社区插件市场（awesome-dsh-plugins，数据层 lib/wb-awesome-market.js）。
    mv('wbAwesomeCatalog', [payloadParam], 'AwesomeCatalogResult'),
    mv('wbAwesomeDetail', [payloadParam], 'AwesomeDetailResult'),
    // README 预览：点击卡片按需取一次（npm registry / GitHub raw），落盘缓存 7 天。
    mv('wbAwesomeReadme', [payloadParam], 'AwesomeReadmeResult'),
    mv('wbAwesomeUpdateCheck', [], 'WbUpdateHintResult'),
    // 社区元信息：打开详情时按需查 GitHub 仓库（维护者 / 最近提交 / issue / star），
    // 6 小时缓存。数据层 lib/community-meta.js，payload $any（{repos, refresh}）。
    mv('wbRepoMeta', [payloadParam], 'WbRepoMetaResult'),
    // npm 近 30 天下载量：插件卡片底栏的「↓N」。目录里没有这个字段，只能去 npm 统计接口取，
    // 7 天缓存 + 按可见卡片懒加载。数据层 lib/npm-downloads.js，payload $any（{packages, refresh}）。
    mv('wbNpmDownloads', [payloadParam], 'WbNpmDownloadsResult'),
    // 装备清单：导出本机全局配置 / 与贴入的清单做差异。payload $any，形状由
    // lib/loadout.js 校验；只读，不安装、不写盘、不接收任何凭据。
    mv('wbLoadoutExport', [payloadParam], 'LoadoutResult'),
    mv('wbLoadoutDiff', [payloadParam], 'LoadoutDiffResult'),
    // WorkBuddy 专家直连（召唤预设 + 捆绑技能）。payload 全部 $any：数据形状由
    // lib/expert-market.js 校验，与 wb* 系列同一宽容度。
    mv('wbExpertCatalog', [], 'WbExpertCatalogResult'),
    mv('wbExpertDetail', [payloadParam], 'WbExpertDetailResult'),
    mv('wbExpertSummon', [payloadParam], 'NoteResult'),
    mv('wbExpertDismiss', [payloadParam], 'NoteResult'),
    mv('wbExpertInstalled', [], 'WbExpertInstalledResult'),
    mv('wbExpertRecent', [], 'WbExpertRecentResult'),
    mv('wbExpertRecordUse', [payloadParam], 'NoteResult'),
    // 会话级专家人设（随时挂/换/摘）：走 systemPrompt 的会话作用域 section，
    // 不受 agent-preset/locked 限制。payload 交给 lib/session-persona.js 校验。
    mv('expertAttach', [payloadParam], 'NoteResult'),
    mv('expertDetach', [payloadParam], 'NoteResult'),
    mv('expertActive', [], 'ExpertActiveResult'),
    // R8：连接器 MCP 的浏览器授权（RFC 9728/8414/7591/7636）。副作用是起本地回调
    // 监听 + 拉系统浏览器，所以 begin/poll 都是独立 RPC，面板按需轮询。
    mv('wbOAuthBegin', [payloadParam], 'NoteResult'),
    mv('wbOAuthPoll', [payloadParam], 'NoteResult'),
    mv('wbOAuthCancel', [payloadParam], 'NoteResult'),
    mv('wbOAuthToken', [payloadParam], 'NoteResult'),
    mv('wbOAuthOverview', [payloadParam], 'NoteResult'),
    mv('wbOAuthOpen', [payloadParam], 'NoteResult'),
  ],
  model: { services: [], events: [], objects: [] },
}