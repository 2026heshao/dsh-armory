// 本机「自建专家」的数据层（issue #15）。
//
// 2026-11-13 从 WorkBuddy 内置的 expert-manager 技能里查到官方约定：
//   专家目录（固定）= $WORKBUDDY_CONFIG_DIR/plugins/marketplaces/my-experts/plugins
//   缺省 ~/.workbuddy/plugins/marketplaces/my-experts/plugins
// 每个专家是一个插件包：`.codebuddy-plugin/plugin.json` + `agents/<agentName>.md` +
// `avatars/*.png`。这条路径不在市场清单（expert_center.json）里，所以面板此前完全
// 看不见用户自己建的专家——这正是 issue #15 的诉求。
//
// 命名空间：本地专家与市场专家可能同名（用户照着市场专家改一份），而召唤预设的行 id
// 与 config id 都直接由 plugin 拼出来（preset-wbexpert-<plugin> / wbexpert-<plugin>）。
// 若两者共用同一个 plugin 名，后召唤的那个会覆盖前一个的行。因此本地专家的 plugin
// 统一加 `local--` 前缀：id 天然唯一，而读侧（readExpertPresets 按前缀剥名）不需要
// 有任何改动，召唤 / 送还 / 已召唤判定全部沿用既有通路。
//
// 这个模块只读磁盘、不联网、不写任何东西：注入 home / configDir 即可在临时目录里测。
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

/** 本地专家的 plugin 命名空间前缀（见文件头）。 */
export const LOCAL_PLUGIN_PREFIX = 'local--';
/** 头像上限：data URL 会随目录一次性走 RPC，超限的一律回落到生成头像。 */
export const LOCAL_AVATAR_MAX_BYTES = 256 * 1024;
/** 单个 plugin.json 上限：正常只有几 KB，超限说明不是我们认识的清单。 */
const MANIFEST_MAX_BYTES = 512 * 1024;

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** WorkBuddy 配置根：与官方一致，环境变量优先。 */
function configRoot(options = {}) {
  const explicit = options.configDir || process.env.WORKBUDDY_CONFIG_DIR;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  return join(options.home || homedir(), '.workbuddy');
}

/** 自建专家的 plugins 根目录（`<配置根>/plugins/marketplaces/my-experts/plugins`）。 */
export function localExpertsRoot(options = {}) {
  return join(configRoot(options), 'plugins', 'marketplaces', 'my-experts', 'plugins');
}

/** plugin 名（`local--foo`）→ 目录名（`foo`）；不是本地命名空间时返回空串。 */
export function localPluginDirName(plugin) {
  const text = typeof plugin === 'string' ? plugin : '';
  return text.startsWith(LOCAL_PLUGIN_PREFIX) ? text.slice(LOCAL_PLUGIN_PREFIX.length) : '';
}

/**
 * 目录名 → plugin 名。
 *
 * 不截断：plugin 是回查目录的唯一凭据（`readLocalExpert` 由它拼路径），截断后就取不回
 * 原名。WorkBuddy 的专家目录名是 kebab-case（init_expert.py 生成，惯例远短于 48 字符），
 * 因此与 expert-market 的 safeSegment（48 上限）不会冲突；真遇到超长名，症状是召唤后
 * 「已召唤」对不上——这是已知边界，不在读取层偷偷改名。
 */
export function localPluginId(dirName) {
  return LOCAL_PLUGIN_PREFIX + String(dirName || '');
}

/** 双语字段取值：优先中文，缺了取英文，再缺取纯字符串。 */
function bi(value) {
  if (value && typeof value === 'object') return String(value.zh || value.en || '');
  return String(value || '');
}

/** 双语数组（tags / quickPrompts）：只保留能取到文案的项，最多 limit 条。 */
function biList(value, limit) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => bi(item))
    .filter(Boolean)
    .slice(0, limit);
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/[\\/]+$/, '');
}

/** 读清单文件；不存在 / 不是文件 / 超过上限 / 解析失败都返回 null（由调用方计入 skipped）。 */
async function readManifest(dir) {
  const file = join(dir, '.codebuddy-plugin', 'plugin.json');
  const info = await stat(file).catch(() => null);
  if (!info || !info.isFile() || info.size > MANIFEST_MAX_BYTES) return null;
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** 头像文件 → data URL；读不到或超限返回空串（调用方回落到生成头像）。 */
async function readAvatarDataUrl(dir, relPath) {
  const rel = trimTrailingSlash(relPath);
  if (!rel) return '';
  const file = resolve(dir, rel);
  // 清单里的 avatar 是相对路径，但要挡住 `../../` 逃出专家目录的写法。
  const root = resolve(dir);
  if (!file.startsWith(root + sep)) return '';
  const mime = MIME_BY_EXT[file.slice(file.lastIndexOf('.')).toLowerCase()];
  if (!mime) return '';
  const info = await stat(file).catch(() => null);
  if (!info || !info.isFile() || info.size > LOCAL_AVATAR_MAX_BYTES) return '';
  try {
    const bytes = await readFile(file);
    return `data:${mime};base64,${bytes.toString('base64')}`;
  } catch {
    return '';
  }
}

/**
 * 把一个专家包目录投影成与市场清单同构的行。
 *
 * 字段口径对齐 expert_center.json 的条目（projectExpert 的入参），这样面板与召唤
 * 通路可以复用；本地没有的信息一律给空值/空数组，不编造分类与提示词。
 */
async function projectPackage(dir, dirName) {
  const manifest = await readManifest(dir);
  if (!manifest) return null;
  const name = String(manifest.name || dirName || '').trim();
  if (!name) return null;
  const plugin = localPluginId(name);
  const agentName = String(manifest.agentName || '').trim();
  const agents = Array.isArray(manifest.agents) ? manifest.agents.map((item) => String(item || '')) : [];
  const promptFile = agents[0] || (agentName ? `./agents/${agentName}.md` : '');
  const avatarUrl = await readAvatarDataUrl(dir, manifest.avatar);
  return {
    // —— 与 projectExpert 同构的部分 ——
    id: plugin,
    plugin,
    agentName,
    expertType: 'agent',
    members: [],
    name: bi(manifest.displayName) || name,
    profession: bi(manifest.profession),
    description: bi(manifest.displayDescription) || String(manifest.description || ''),
    promptFile,
    categoryId: String(manifest.categoryId || ''),
    categoryName: '',
    tags: biList(manifest.tags, 3),
    quickPrompts: biList(manifest.quickPrompts, 3),
    defaultInitPrompt: bi(manifest.defaultInitPrompt),
    createdAt: '',
    updatedAt: '',
    isOPC: false,
    avatarUrl,
    // —— 本地专有 ——
    source: 'local',
    localPath: dir,
    localManifest: name,
  };
}

/**
 * 扫描自建专家目录。
 *
 * 不静默：读不出来的目录计入 `skipped`（面板可以据此说明「有几个包没读懂」），
 * 目录本身不存在时 `available=false` 而不是抛错——绝大多数用户没建过专家。
 *
 * @param {{ home?: string, configDir?: string }} [options]
 * @returns {Promise<{ root: string, available: boolean, experts: object[], skipped: string[] }>}
 */
export async function listLocalExperts(options = {}) {
  const root = localExpertsRoot(options);
  const rootInfo = await stat(root).catch(() => null);
  if (!rootInfo || !rootInfo.isDirectory()) return { root, available: false, experts: [], skipped: [] };
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const experts = [];
  const skipped = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    if (entry.name.startsWith('.')) continue;
    const dir = join(root, entry.name);
    const row = await projectPackage(dir, entry.name).catch(() => null);
    if (row) experts.push(row);
    else skipped.push(entry.name);
  }
  experts.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return { root, available: true, experts, skipped };
}

/**
 * 读一个自建专家的完整内容（详情 / 召唤共用）。
 *
 * 人设取 `plugin.json.agents[0]`（缺省 `agents/<agentName>.md`），读不到就抛错——
 * 与市场侧「上游 404 时给替身」不同：本地文件缺了是用户能自己修的事，静默给替身
 * 只会让他以为专家就长这样。
 *
 * @param {string} plugin `local--<name>`
 * @param {{ home?: string, configDir?: string }} [options]
 * @returns {Promise<{ row: object, pluginJson: object, persona: string, personaFile: string }>}
 */
export async function readLocalExpert(plugin, options = {}) {
  const dirName = localPluginDirName(plugin);
  if (!dirName) throw new Error(`不是本地专家：${plugin}`);
  const root = localExpertsRoot(options);
  const dir = join(root, dirName);
  if (!isAbsolute(dir)) throw new Error('本地专家目录路径不是绝对路径');
  const row = await projectPackage(dir, dirName);
  if (!row) throw new Error(`本地专家 ${dirName} 的 .codebuddy-plugin/plugin.json 读不出来或缺少 name`);
  const manifest = await readManifest(dir);
  const rel = trimTrailingSlash(String(row.promptFile || '').replace(/^\.\//, ''));
  if (!rel) throw new Error(`本地专家 ${dirName} 没有声明 agents 人设文件`);
  const file = resolve(dir, rel);
  if (!file.startsWith(resolve(dir) + sep)) throw new Error('人设文件路径越出了专家目录');
  let persona = '';
  try {
    persona = await readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`本地专家 ${dirName} 的人设文件读不出来（${rel}）：${String(error?.message || error)}`);
  }
  if (!persona.trim()) throw new Error(`本地专家 ${dirName} 的人设文件是空的（${rel}）`);
  return { row, pluginJson: manifest, persona, personaFile: rel };
}
