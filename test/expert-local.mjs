// 本机自建专家（issue #15）的回归护栏。
//
// 官方约定（取自 WorkBuddy 内置 expert-manager 技能）：自建专家固定落在
//   $WORKBUDDY_CONFIG_DIR/plugins/marketplaces/my-experts/plugins/<name>/
// 包结构：.codebuddy-plugin/plugin.json + agents/<agentName>.md + avatars/*.png
//
// 这里用临时目录造四个包真跑：
//   完整包 / 缺展示字段 / 清单损坏 / 头像超出上限（含一条 `../` 穿越的头像路径）。
// 断言的是「能读的读出来、读不出的如实上报、绝不静默跳过、绝不放行越界路径」。
//
// 同时验证命名空间：本地 plugin 带 `local--` 前缀，因此与市场同名专家可以并存
// （用户选的是「两条都显示」），且召唤预设行 id 天然不撞。
//
// 零网络、零写盘到真实目录（全部在 mkdtemp 里）。

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_AVATAR_MAX_BYTES, listLocalExperts, localExpertsRoot, localPluginDirName, readLocalExpert } from '../lib/expert-local.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
void ROOT;

let failures = 0;
const ok = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
};

// 1×1 PNG（67 字节）：头像正常路径用。
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const configDir = await mkdtemp(join(tmpdir(), 'wb-local-experts-'));
const pluginsRoot = localExpertsRoot({ configDir });
await mkdir(pluginsRoot, { recursive: true });

/** 造一个专家包。manifest === null 表示写坏掉的 plugin.json。 */
async function makePack(dirName, manifest, persona = '# 人设\n\n你是测试专家。\n') {
  const dir = join(pluginsRoot, dirName);
  await mkdir(join(dir, '.codebuddy-plugin'), { recursive: true });
  await mkdir(join(dir, 'agents'), { recursive: true });
  await mkdir(join(dir, 'avatars'), { recursive: true });
  const body = manifest === null ? '{ 这不是 JSON' : JSON.stringify(manifest, null, 2);
  await writeFile(join(dir, '.codebuddy-plugin', 'plugin.json'), body, 'utf8');
  if (persona !== null) await writeFile(join(dir, 'agents', `${manifest?.agentName || dirName}.md`), persona, 'utf8');
  return dir;
}

const full = await makePack('demo-full', {
  name: 'demo-full',
  version: '1.2.3',
  description: 'A demo expert',
  expertType: 'agent',
  agentName: 'demo-full',
  agents: ['./agents/demo-full.md'],
  displayName: { zh: '演示专家', en: 'Demo Expert' },
  profession: { zh: '测试工程师', en: 'Test Engineer' },
  displayDescription: { zh: '用来验证本地专家读取的一条记录。', en: 'A record for local expert tests.' },
  tags: [{ zh: '甲' }, { zh: '乙' }, { zh: '丙' }],
  quickPrompts: [{ zh: '提示一' }, { zh: '提示二' }, { zh: '提示三' }],
  avatar: 'avatars/expert.png',
  categoryId: 'dev',
});
await writeFile(join(full, 'avatars', 'expert.png'), PNG_1PX);

// 缺展示字段：只有必填的 name/version/description + agents。
await makePack('demo-bare', {
  name: 'demo-bare',
  version: '0.0.1',
  description: 'Bare minimum',
  agentName: 'demo-bare',
  agents: ['./agents/demo-bare.md'],
});

// 清单损坏：应当被计入 skipped，而不是让整个扫描失败。
await makePack('demo-broken', null);

// 头像超限 + 路径穿越：两个都要被挡。
const huge = await makePack('demo-huge', {
  name: 'demo-huge',
  version: '1.0.0',
  description: 'Huge avatar',
  agentName: 'demo-huge',
  agents: ['./agents/demo-huge.md'],
  avatar: 'avatars/huge.png',
});
await writeFile(join(huge, 'avatars', 'huge.png'), Buffer.alloc(LOCAL_AVATAR_MAX_BYTES + 1024, 1));
await makePack('demo-escape', {
  name: 'demo-escape',
  version: '1.0.0',
  description: 'Escaping avatar path',
  agentName: 'demo-escape',
  agents: ['./agents/demo-escape.md'],
  avatar: '../../../../etc/passwd',
});

const result = await listLocalExperts({ configDir });

// ── 1. 扫描与投影 ─────────────────────────────────────────────────────────
ok('目录存在时 available=true', result.available === true);
ok('四个能读的包都被收录', result.experts.length === 4, `got ${result.experts.length}`);
ok('坏清单计入 skipped（不静默）', result.skipped.includes('demo-broken'), JSON.stringify(result.skipped));

const row = result.experts.find((item) => item.plugin === 'local--demo-full');
ok('完整包被投影', !!row);
ok('plugin 带本地命名空间', row?.plugin === 'local--demo-full');
ok('显示名取中文', row?.name === '演示专家', row?.name);
ok('职业/描述取中文', row?.profession === '测试工程师' && row?.description === '用来验证本地专家读取的一条记录。');
ok('tags / quickPrompts 各三条', row?.tags.length === 3 && row?.quickPrompts.length === 3);
ok('头像转成 data URL', String(row?.avatarUrl).startsWith('data:image/png;base64,'), String(row?.avatarUrl).slice(0, 24));
ok('来源标记为 local', row?.source === 'local');
ok('保留真实目录（只读引用）', row?.localPath === full || String(row?.localPath).endsWith('demo-full'));

const bare = result.experts.find((item) => item.plugin === 'local--demo-bare');
ok('缺展示字段时 name 回落到插件名', bare?.name === 'demo-bare');
ok('缺字段不编造分类 / 标签', bare?.categoryId === '' && bare?.tags.length === 0 && bare?.avatarUrl === '');

const hugeRow = result.experts.find((item) => item.plugin === 'local--demo-huge');
ok('超限头像不再内联（回落生成头像）', hugeRow?.avatarUrl === '');

const escapeRow = result.experts.find((item) => item.plugin === 'local--demo-escape');
ok('越过专家目录的头像路径被拒绝', escapeRow?.avatarUrl === '');

// ── 2. 命名空间与市场同名共存 ─────────────────────────────────────────────
const marketSameName = { plugin: 'demo-full' };
ok('同名的市场条目与本地条目不撞 id', marketSameName.plugin !== row.plugin);
ok('local-- 前缀可逆', localPluginDirName('local--demo-full') === 'demo-full' && localPluginDirName('demo-full') === '');

// ── 3. 详情读取 ───────────────────────────────────────────────────────────
const detail = await readLocalExpert('local--demo-full', { configDir });
ok('详情能读到人设正文', detail.persona.includes('你是测试专家'));
ok('人设文件是归一后的相对路径', detail.personaFile === 'agents/demo-full.md', detail.personaFile);
ok('详情带回 plugin.json 版本', String(detail.pluginJson?.version) === '1.2.3');

// 人设文件缺失：必须抛错，不能给替身（本地文件缺了是用户能修的事）。
const emptyDir = await makePack('demo-nopersona', {
  name: 'demo-nopersona',
  version: '1.0.0',
  description: 'No persona',
  agentName: 'demo-nopersona',
  agents: ['./agents/demo-nopersona.md'],
}, null);
void emptyDir;
let personaError = '';
try {
  await readLocalExpert('local--demo-nopersona', { configDir });
} catch (error) {
  personaError = String(error?.message || error);
}
ok('人设缺失时抛错（不给替身）', personaError.includes('人设文件'), personaError);

// 非本地 plugin 不得走这条通路。
let wrongNamespace = '';
try {
  await readLocalExpert('senior-developer', { configDir });
} catch (error) {
  wrongNamespace = String(error?.message || error);
}
ok('非 local-- 前缀被拒绝', wrongNamespace.includes('不是本地专家'), wrongNamespace);

// ── 4. 目录不存在时不抛错 ─────────────────────────────────────────────────
const missingDir = await mkdtemp(join(tmpdir(), 'wb-local-empty-'));
const missing = await listLocalExperts({ configDir: missingDir });
ok('目录不存在时 available=false 且不抛错', missing.available === false && missing.experts.length === 0);

// ── 5. 反向自测：去掉命名空间就会撞 id ────────────────────────────────────
const naiveId = (name) => name;
ok('反向自测：不带前缀时本地与市场同名会撞', naiveId('demo-full') === marketSameName.plugin);
ok('反向自测：带前缀后不撞', localPluginDirName(row.plugin) && row.plugin !== marketSameName.plugin);

// 清理
await rm(configDir, { recursive: true, force: true });
await rm(missingDir, { recursive: true, force: true });

if (failures > 0) {
  console.log(`\nEXPERT-LOCAL FAIL（${failures} 条断言未通过）`);
  process.exit(1);
}
console.log('\nEXPERT-LOCAL PASS');
void readFile;
