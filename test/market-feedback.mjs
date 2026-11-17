// 市场失败/空态互斥、全部已装跳转清筛选、逐台重连结果；零网络零用户目录。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8');
let checks = 0;
const ok = (name, condition) => { assert.ok(condition, name); checks++; console.log('PASS  ' + name); };
const grab = (text, start, end) => {
  const a = text.indexOf(start); const b = text.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, '源码锚点存在：' + start);
  return text.slice(a, b);
};
const emptyTests = [
  ["!loading && !catalogError && !filtered.length", { loading: false, catalogError: '', filtered: [] }, 'catalogError'],
  ["!skillLoading && !skillError && skillReady && tab === 'skill' && !skills.length", { skillLoading: false, skillError: '', skillReady: true, tab: 'skill', skills: [] }, 'skillError'],
  ["!skillLoading && !skillError && skillReady && tab === 'skill' && skills.length && !shownSkills.length", { skillLoading: false, skillError: '', skillReady: true, tab: 'skill', skills: [{}], shownSkills: [] }, 'skillError'],
];
for (const [mark, state, errorKey] of emptyTests) {
  // 从实际 JSX 条件取值；错误与成功空结果分别执行，不把字符串存在当行为通过。
  const expr = grab(source, mark, '?').trim();
  ok('成功且无结果才显示空态：' + errorKey, !!vm.runInNewContext(expr, state));
  ok('加载失败不再显示空态：' + errorKey, !vm.runInNewContext(expr, { ...state, [errorKey]: 'network failed' }));
  const legacy = expr.replace(' && !' + errorKey, '');
  ok('反向自测：删错误守卫就会同屏显示空态', !!vm.runInNewContext(legacy, { ...state, [errorKey]: 'network failed' }));
}
{
  const expert = source.slice(source.indexOf('const ExpertMarket = ({ call }) => {'));
  const load = grab(expert, '  const load = useCallback', '\n  useEffect(() => { load();');
  const state = { loading: false, error: '', catalogError: '', experts: null };
  const ctx = vm.createContext({
    useCallback: (fn) => fn, call: () => {},
    setLoading: (v) => { state.loading = v; }, setError: (v) => { state.error = v; },
    setCatalogError: (v) => { state.catalogError = v; }, setNote: () => {},
    setExperts: (v) => { state.experts = v; }, setCategories: () => {}, setMeta: () => {}, setSource: () => {},
    recordMarketSnapshot: () => false, emitMarketPulse: () => {},
    loadExpertCatalogShared: async () => { throw new Error('catalog offline'); },
  });
  vm.runInContext(load + '\nglobalThis.loadCatalog = load;', ctx);
  await ctx.loadCatalog();
  ok('专家目录失败单独记录，加载结束，不混业务错误', state.catalogError === 'catalog offline' && !state.loading && !state.error);
  let forceValue;
  ctx.loadExpertCatalogShared = async (_call, force) => { forceValue = force; return { experts: [], categories: [] }; };
  const retry = grab(expert, "    catalogError ? h('div'", '\n    !loading');
  let retryClick;
  vm.runInNewContext('[' + retry + ']', {
    catalogError: 'offline', loading: false, t: (s) => s,
    load: ctx.loadCatalog,
    h: (tag, props) => { if (tag === 'button') retryClick = props.onClick; return {}; },
  });
  await retryClick();
  ok('真实重试按钮强制重取，成功清错并保留合法空结果', forceValue === true && state.catalogError === '' && state.experts.length === 0);
}
{
  const intent = grab(source, 'let pendingInstalledSkills =', 'const SkillBoard =');
  const reset = grab(source, '  useEffect(() => {\n    const reset = () => {\n      pendingInstalledSkills', '\n  // 卸载在途时拒绝关闭详情');
  const state = { scope: 'old-project', cat: 'old', query: 'old', onlyModel: true, onlyUser: true, onlyDisabled: true, sourceFilter: 'old', recentOnly: true, detail: 'old', confirm: true };
  const hash = { skillws: 'old', skillcat: 'old', skillpick: 'old', other: 'keep' };
  let cleanup; let category;
  const ctx = vm.createContext({
    pendingSkillFocus: 'old', useEffect: (fn) => { cleanup = fn(); },
    writeHashParams: (patch) => { for (const [k, v] of Object.entries(patch)) { if (v === null) delete hash[k]; else hash[k] = v; } },
    openBoardCategory: (v) => { category = v; },
    closeDetail: () => { state.detail = null; }, cancelSharedConfirm: () => { state.confirm = false; },
  });
  for (const key of ['scope', 'cat', 'query', 'onlyModel', 'onlyUser', 'onlyDisabled', 'sourceFilter', 'recentOnly']) {
    ctx['set' + key[0].toUpperCase() + key.slice(1)] = (v) => { state[key] = v; };
  }
  vm.runInContext(intent + '\nglobalThis.openAll = openInstalledSkills;', ctx);
  ctx.openAll(); // 未挂载先存意图
  vm.runInContext(reset, ctx);
  ok('未挂载时领取跳转，回全局且清全部旧过滤/详情', state.scope === 'global' && state.cat === '' && state.query === '' && !state.onlyModel && !state.onlyUser && !state.onlyDisabled && state.sourceFilter === 'all' && !state.recentOnly && state.detail === null && !state.confirm);
  ok('跳技能看板，清技能 hash 和待打开详情，不改别页 hash', category === 'skill' && !hash.skillws && !hash.skillcat && !hash.skillpick && hash.other === 'keep' && ctx.pendingSkillFocus === '');
  state.query = 'new'; ctx.openAll();
  ok('已挂载时广播也能清旧搜索', state.query === '');
  cleanup(); state.query = 'unmounted'; ctx.openAll();
  ok('卸载会退订，不再操作旧组件', state.query === 'unmounted');
}
{
  const code = grab(source, '  const reconnectConnector = async', '  // ── R8：连接器 OAuth');
  const tasks = new Map(); const finishes = []; const errors = [];
  const ctx = vm.createContext({
    connectorServerRows: () => [], beginConnectorAuth: () => {},
    setBusy: () => {}, setBusyLabel: () => {}, setError: (v) => errors.push(v), setNote: () => {},
    PROGRESS_GROUP_MCP: 'mcp', MCP_RECONNECT_TASK_LABELS: {}, installTasks: tasks,
    progressToastStart: (key) => tasks.set(key, { phase: 'running' }),
    progressToastFinish: (key, phase, reason) => { tasks.get(key).phase = phase; finishes.push({ key, phase, reason }); },
    t: (text, args = []) => text.replace(/\{(\d+)\}/g, (_m, n) => args[n]),
    call: async (_method, name) => { if (name === 'bad') throw new Error('transport offline'); return { ok: true }; },
    loadMcpServerRows: async () => { throw new Error('refresh offline'); },
  });
  vm.runInContext(code + '\nglobalThis.reconnect = reconnectConnector;', ctx);
  await ctx.reconnect({ name: 'demo', serverNames: ['good', 'bad', 'after'] });
  ok('一台失败不阻断其余重连', finishes.length === 3 && finishes[0].phase === 'ok' && finishes[2].phase === 'ok');
  ok('失败浮层带真实原因', finishes[1].phase === 'fail' && finishes[1].reason === 'transport offline');
  ok('后续列表刷新失败不篡改已完成结果', tasks.get('mcp:reconnect:good').phase === 'ok' && errors.at(-1) === 'refresh offline');
}
console.log(`MARKET-FEEDBACK PASS ${checks}/${checks}`);
