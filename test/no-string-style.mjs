// test/no-string-style.mjs
//
// 护栏对象：lib/client.js 里 `style:` 属性不得传字符串。h = React.createElement
// （client.js 顶部），React 对 `style: 'color:x'` 这种字符串直接抛 Minified React
// error #62（"The `style` prop expects a mapping from style properties to values,
// not a string"）——而且是在渲染期抛，面板顶层错误边界直接把整块面板换成
// 「这个面板加载失败」。2026-10-24 实测：授权弹窗（authDialog.error 的警示行）与
// 专家详情弹层（stale 团队行的警示行）各埋了一处，前者在「安装需 OAuth 的连接器、
// 宿主没能自动唤起浏览器」这条路上必崩——用户点安装看到的是整面板崩掉，而不是
// 授权页/复制链接的弹层。
//
// 这类 bug 的狡猾之处：正常路径（浏览器打开成功 → error 为空串）根本不渲染那一行，
// 一切测试全绿；只有打开失败/手动令牌模式才走进去。词法守卫是最便宜的钉法——
// 字符串 style 在本仓库没有合法形态（对象一律 `style: {`，动态值一律三目/变量），
// 所以直接断言 `style:` 后面不跟引号。反向自测：注回一处字符串 style 必须变红。
//
// 只用 node: 内置模块。用法：node ./test/no-string-style.mjs

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;
const ok = (cond, label, detail = "") => {
  if (cond) { passed += 1; console.log(`PASS  ${label}`); }
  else { failed += 1; console.log(`FAIL  ${label}${detail ? `：${detail}` : ""}`); }
};

const client = await readFile(join(here, "..", "lib", "client.js"), "utf8");

// ── 1. 词法守卫：`style:` 后面不允许紧跟字符串字面量（' " `）──────────────────
// 匹配 `style: '...'` / `style: "..."` / `style: \`...\``（属性值为字符串字面量）。
// 对象/三目/变量（`style: {`、`style: cond ? {`、`style: someVar`）都合法，不会命中。
const STRING_STYLE = /style:\s*(['"`])/g;
const hits = [...client.matchAll(STRING_STYLE)].map((m) => client.slice(0, m.index).split("\n").length);
ok(hits.length === 0, "client.js 无字符串字面量形态的 style 属性",
  hits.length ? `行号：${hits.join("、")}` : "");

// ── 2. 两处修复点钉住对象形态（防"顺手改回字符串"）────────────────────────────
ok(client.includes("style: { color: 'var(--dsw-alias-state-warn-primary)' }"),
  "授权弹窗/专家详情的警示行 style 为对象形态（--dsw-alias-state-warn-primary）");

// ── 3. 授权弹窗补开浏览器：opened=false 时必须立即重试 wbOAuthOpen ────────────
// 这是「点安装 → 直接跳转授权页」的兜底路径：宿主第一通路失败 ≠ 放弃，
// 客户端补一发 wbOAuthOpen；成功且弹层还是这一个会话时撤掉错误提示。
ok(/wbOAuthOpen'\s*,\s*\{\s*url:\s*res\.authorizeUrl\s*\}/.test(client),
  "beginConnectorAuth 在 opened=false 时立即补发 wbOAuthOpen");

// ── 反向自测：注回一处字符串 style，守卫必须变红 ──────────────────────────────
{
  const poisoned = client.replace(
    "style: { color: 'var(--dsw-alias-state-warn-primary)' }",
    "style: 'color:var(--dsw-alias-state-warn-primary)'",
  );
  const poisonedHits = [...poisoned.matchAll(STRING_STYLE)];
  ok(poisonedHits.length > 0, "反向自测：注回字符串 style 后守卫必须命中（护栏抓得住这次回退）");
}

console.log(`\n共 ${passed + failed} 条断言：PASS ${passed} / FAIL ${failed}`);
process.exit(failed ? 1 : 0);
