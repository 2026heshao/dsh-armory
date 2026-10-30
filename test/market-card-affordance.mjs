// 插件卡片可点击性的守护套件：
//   · 可点击卡片必须有 cursor:pointer（只在真有点击行为的卡片上加类）；
//   · 键盘可达（role=button + tabIndex + Enter/Space）；
//   · 卡片内的操作按钮要 stopPropagation，否则点「安装」会连带打开 README 弹层；
//   · 插件页现在只有 DSH 社区一个来源，卡片统一是 .dsh-mcp-pcard；
//     CodeBuddy 卡片（dsh-mcp-card wb dsh-mcp-card-clickable）已随插件源移除，不得复活。
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const client = await readFile(join(here, "..", "lib", "client.js"), "utf8");

let failed = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failed += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

// ── CSS affordance ──────────────────────────────────────────────────────
ok("CSS：DSH 社区卡片有 pointer 指针", /\.dsh-mcp-pcard\{[^}]*cursor:pointer/.test(client));
ok("CSS：DSH 社区卡片 hover 有强调边框", /\.dsh-mcp-pcard:hover\{[^}]*border-color:var\(--mcp-accent\)/.test(client));
ok("CSS：DSH 社区卡片键盘聚焦有可见轮廓", /\.dsh-mcp-pcard:focus-visible\{[^}]*outline:/.test(client));
ok("CSS：已移除的 CodeBuddy 可点击卡片样式不得复活",
  !client.includes(".dsh-mcp-card.wb.dsh-mcp-card-clickable"));

// ── 渲染层：唯一来源的卡片挂上可点击类 ──────────────────────────────────
const clickableCards = client.match(/className: 'dsh-mcp-pcard'/g) || [];
ok("渲染层：插件页只有 DSH 社区一种可点击卡片", clickableCards.length === 1, `count=${clickableCards.length}`);
ok("渲染层：卡片有 role=button", (client.match(/dsh-mcp-pcard',\s*role: 'button'/g) || []).length === 1);
ok("渲染层：卡片有 tabIndex=0", (client.match(/dsh-mcp-pcard',[\s\S]{0,160}?tabIndex: 0/g) || []).length === 1);
ok("渲染层：卡片支持 Enter/Space 键盘触发",
  (client.match(/dsh-mcp-pcard',[\s\S]{0,480}?onKeyDown: \(e\) => \{ if \(e\.key === 'Enter' \|\| e\.key === ' '\)/g) || []).length === 1);

// ── 卡片内按钮不冒泡到卡片点击 ───────────────────────────────────────────
// 可点卡片现在有两族：插件卡（打开 README）与社区 MCP 卡（打开详情）。两族的操作行
// 都必须阻止冒泡；WB / 技能卡不可点，操作行保持原样。所以这里只要求「至少一处」，
// 各族的具体绑定由 plugin-card-layout / community-detail 分别钉住。
const stoppedActionRows = client.match(/className: 'dsh-mcp-wb-card-actions', onClick: \(e\) => e\.stopPropagation\(\), onKeyDown: \(e\) => e\.stopPropagation\(\)/g) || [];
ok("可点卡片的操作行阻止冒泡（点安装不会连带打开详情）", stoppedActionRows.length >= 1, `count=${stoppedActionRows.length}`);

// ── 点击与键盘共用同一处理函数 ───────────────────────────────────────────
ok("卡片点击与 Enter/Space 共用 loadAwesomeReadme",
  /onClick: \(\) => loadAwesomeReadme\(item\)/.test(client)
  && /onKeyDown: \(e\) => \{ if \(e\.key === 'Enter' \|\| e\.key === ' '\) \{ e\.preventDefault\(\); loadAwesomeReadme\(item\); \}/.test(client));
ok("已移除的 CodeBuddy 详情入口（openDetail 作为插件卡点击）不得复活",
  !/className: 'dsh-mcp-card wb dsh-mcp-card-clickable'/.test(client));

console.log(failed === 0 ? "MARKET-CARD-AFFORDANCE PASS" : `${failed} CHECK(S) FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
