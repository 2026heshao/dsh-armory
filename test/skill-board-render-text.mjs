// 技能看板渲染层的文本归一护栏（issue #17 / 与 #11 同一类数据）。
//
// 宿主 skill 注册表给的 `description` / `whenToUse` **不保证是字符串**：issue #11 已经
// 实测到本地化对象（`{ zh, en }`）与数组两种形态。旧看板把这些值直接当 React 子节点
// 渲染（`h('div', ..., s.description)`），一旦命中就是 React #31/ErrorBoundary 整块
// 面板变「这个面板加载失败」——用户报的「第一次点技能就闪一下错误页」属于同一片嫌疑。
//
// 这里只钉「渲染前必须过 textOf」这一件事，不去猜那条具体报错（那个要堆栈）；断言的是
// 结构不变式：任何来自注册表的展示文本都要归一。反向自测把旧写法注回去，证明断言不空转。
//
// 零网络、零写盘，纯源码检查。

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = join(ROOT, 'lib', 'client.js');

let failures = 0;
const ok = (name, condition, extra = '') => {
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`);
};

const source = await readFile(CLIENT, 'utf8');
const count = (haystack, needle) => haystack.split(needle).length - 1;

// ── 1. 五个渲染点都必须归一 ────────────────────────────────────────────────
ok(
  '行视图描述走 textOf',
  source.includes("textOf(s.description) ? h('div', { className: 'dsh-mcp-skill-desc' }, textOf(s.description)) : null"),
);
ok(
  '卡片视图描述走 textOf（空值回落「（无描述）」）',
  source.includes("textOf(s.description)\n                                ? h('div', { className: 'dsh-mcp-skill-desc' }, textOf(s.description))"),
);
ok('详情描述走 textOf', source.includes("textOf(summary.description) || t('（无描述）')"));
ok('详情「何时使用」走 textOf', source.includes("h('p', { className: 'dsh-mcp-skill-d-desc' }, textOf(summary.whenToUse))"));
ok('套件成员行描述走 textOf', source.includes("h('span', { className: 'ds' }, textOf(s.description) || t('（无描述）'))"));
ok(
  '命令面板索引的描述走 textOf',
  source.includes("desc: textOf(s.description) || textOf(s.whenToUse) || textOf(s.source)"),
);

// ── 2. 反向：旧写法不得复活 ────────────────────────────────────────────────
// 旧形态是「直接把字段塞进 h(...) 的子节点位」：`}, s.description)` / `}, summary.description)`。
// 归一后这些形态应当一条不剩；留着就说明某处又被改回直通。
const directDescription = count(source, "}, s.description)") + count(source, "}, summary.description)");
ok('没有把 description 直接当 React 子节点的写法', directDescription === 0, `found=${directDescription}`);

// ── 3. 反向自测：把旧写法注回去，上面的断言必须命中 ────────────────────────
// 用同一判据检查一段「构造出来的旧源码」，证明第 2 节不是恒真。
const legacySnippet = "h('div', { className: 'dsh-mcp-skill-desc' }, s.description)";
const legacyDirect = count(legacySnippet, "}, s.description)");
ok('反向自测：旧写法能被同一个判据抓到', legacyDirect === 1, `found=${legacyDirect}`);

if (failures > 0) {
  console.log(`\nSKILL-BOARD-RENDER-TEXT FAIL（${failures} 条断言未通过）`);
  process.exit(1);
}
console.log('\nSKILL-BOARD-RENDER-TEXT PASS');
