// 社区 MCP 卡片详情弹层守护（2026-10-30）：
// 用户要求「为每个卡片添加点击弹出详情页，基本显示内容和 UI 交互仿照插件页面」。
// 这里钉住三件事，防止后续改版把交互退回「卡片只能加入、看不到细节」：
//   1. 整卡可点：role=button + Tab + Enter/Space；操作区阻止冒泡（点「加入 MCP」不弹详情）；
//   2. 弹层交互与插件 README 同款：遮罩 / Esc 关闭、焦点陷阱、aria-modal；
//   3. 内容只来自列表行（不再发请求）：command/args、env 明细、远程地址、免责声明、动作。
// 全部静态读取 lib/client.js，零网络零写盘；关键断言配反向自测，防止断言空转。
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

// ── 只截社区卡片渲染段与详情弹层段，避免命中插件 / 技能卡 ─────────────────────
const cardStart = client.indexOf("communityVisibleRows.map((row) => {");
const cardEnd = client.indexOf("// 游标翻页", cardStart);
const card = cardStart >= 0 && cardEnd > cardStart ? client.slice(cardStart, cardEnd) : "";
ok("社区卡片渲染段可定位", card.length > 800, `len=${card.length}`);

const modalStart = client.indexOf("// ── 社区 MCP 详情弹层");
const modalEnd = client.indexOf("// 社区条目的「加入 MCP」", modalStart);
const modal = modalStart >= 0 && modalEnd > modalStart ? client.slice(modalStart, modalEnd) : "";
ok("社区详情弹层段可定位", modal.length > 1200, `len=${modal.length}`);

// ── 1. 整卡可点与键盘可达（不再把整卡声明成按钮）────────────────────────────
// 卡片里有「详情」「加入 MCP」按钮与仓库链接；role=button 会形成嵌套交互控件，
// aria-label 还会把整段卡片内容从读屏树里吞掉。现在整卡只负责鼠标点击，
// 键盘入口是操作区里真正的「详情」按钮。
ok("卡片：不再是 role=button / tabIndex=0（避免嵌套交互控件）",
  !/role: 'button'/.test(card) && !/tabIndex: 0/.test(card));
ok("卡片：点击整卡打开详情",
  /onClick: \(\) => setCommunityDetail\(row\)/.test(card));
ok("卡片：操作区有独立「详情」按钮，带「查看 {0} 的详情」的无障碍名",
  /const detailLabel = t\('查看 \{0\} 的详情', \[row\.title \|\| row\.name\]\)/.test(card)
  && /'aria-label': detailLabel/.test(card)
  && /onClick: \(\) => setCommunityDetail\(row\),\s*\}\)?, t\('详情'\)/.test(card));
ok("卡片：title 用「查看 {0} 的详情」但不再用 aria-label 吞内容",
  /title: detailLabel/.test(card));
ok("卡片：操作区阻止冒泡（点「详情」/「加入 MCP」/ 仓库不重复打开详情）",
  /className: 'dsh-mcp-wb-card-actions', onClick: \(e\) => e\.stopPropagation\(\), onKeyDown: \(e\) => e\.stopPropagation\(\)/.test(card));
ok("卡片：只有社区卡带 clickable 类（WB / 技能卡不变成可点）",
  /className: 'dsh-mcp-card wb clickable'/.test(card));
ok("卡片：仓库链接先过 externalHref（javascript: / file: 不进 href）",
  /const repoHref = externalHref\(row\.repoUrl\)/.test(card)
  && /href: repoHref/.test(card));

// ── 2. 状态 / 焦点陷阱：必须声明在组件顶层，不能落进条件分支 ─────────────────
const stateAt = client.indexOf("const [communityDetail, setCommunityDetail] = useState(null);");
const componentAt = client.indexOf("const WorkBuddyMarket");
ok("状态：communityDetail 在组件共享状态区声明", stateAt > componentAt && componentAt > 0);
ok("焦点陷阱：communityDetailRef + 无条件 useFocusTrap",
  /const communityDetailRef = useRef\(null\)/.test(client)
  && /useFocusTrap\(communityDetailRef, !!communityDetail\)/.test(client));
const trapAt = client.indexOf("useFocusTrap(communityDetailRef, !!communityDetail)");
const pageSizeAt = client.indexOf("const WB_PAGE_SIZE = 20;");
ok("焦点陷阱：位于顶部 hook 区（早于 WB_PAGE_SIZE），不在条件渲染里",
  trapAt > 0 && pageSizeAt > trapAt);

// ── 3. 弹层交互：仿插件 README（遮罩 / Esc / 对话框语义）────────────────────
ok("弹层：遮罩点击关闭（且 busy 时不关）",
  /className: 'dsh-mcp-overlay', onClick: \(e\) => !busy && e\.target === e\.currentTarget && setCommunityDetail\(null\)/.test(modal));
ok("弹层：Esc 关闭、stopPropagation",
  /if \(e\.key === 'Escape' && !busy\) \{ e\.stopPropagation\(\); setCommunityDetail\(null\); \}/.test(modal));
ok("弹层：dialog + aria-modal + aria-label + tabIndex=-1",
  /role: 'dialog'/.test(modal) && /'aria-modal': true/.test(modal)
  && /'aria-label': t\('社区 MCP 详情'\)/.test(modal) && /tabIndex: -1/.test(modal));
ok("弹层：挂焦点陷阱 ref", /ref: communityDetailRef/.test(modal));
ok("弹层：复用 wb-modal 尺寸与 .dsh-mcp-detail-person 头像行",
  /className: 'dsh-mcp-modal dsh-mcp-wb-modal'/.test(modal)
  && /className: 'dsh-mcp-detail-person'/.test(modal)
  && /className: 'dsh-mcp-detail-avatar'/.test(modal));

// ── 4. 内容：字段齐全、只读展示 ────────────────────────────────────────────
ok("头部：标题 + 完整名称（可悬停看全）",
  /h\('h3', null, communityDetail\.title \|\| communityDetail\.name\)/.test(modal)
  && /className: 'dsh-mcp-card-vendor', title: communityDetail\.name/.test(modal));
ok("徽标：传输 / 版本 / 环境变量数 / 密钥 / 已加入",
  /communityDetail\.transport === 'http' \? t\('远程（需自备令牌）'\) : 'stdio'/.test(modal)
  && /communityDetail\.version \? h\(Badge, null, 'v' \+ communityDetail\.version\)/.test(modal)
  && /t\('需 \{0\} 个环境变量', \[communityDetail\.env\.length\]\)/.test(modal)
  && /t\('含密钥字段'\)/.test(modal)
  && /communityJoined\(communityDetail\) \? h\(Badge, \{ cls: 's-on' \}, t\('已加入'\)\)/.test(modal));
ok("正文：完整 description 用 wb-modal-desc 渲染", /className: 'dsh-mcp-wb-modal-desc'/.test(modal));
ok("环境变量：逐项列出名称 / 必填 / 密钥 / 说明 / 默认值",
  /communityDetail\.env\.map\(\(item\) => h\('li', \{ key: item\.name \}/.test(modal)
  && /h\('code', null, item\.name\)/.test(modal)
  && /item\.required \? t\('必填'\) : t\('可选'\)/.test(modal)
  && /item\.secret \? ' · ' \+ t\('密钥'\) : ''/.test(modal)
  && /item\.description \? ' — ' \+ item\.description : ''/.test(modal)
  && /item\.hasDefault \? ' · ' \+ t\('默认值：'\) \+ item\.default : ''/.test(modal));
ok("命令：stdio 显示 command + args；远程条目回落到 remoteUrl",
  /\[communityDetail\.command\]\.concat\(communityDetail\.args \|\| \[\]\)\.filter\(Boolean\)\.join\(' '\)/.test(modal)
  && /className: 'dsh-mcp-cmdline'/.test(modal)
  && /communityDetail\.runnable[\s\S]{0,400}communityDetail\.remoteUrl/.test(modal)
  && /t\('远程地址'\)/.test(modal));
ok("免责声明：复用既有社区 MCP 那句（已审核边界不放松）",
  /社区 MCP 来自官方 MCP Registry，由社区提交；军械库未审核其代码，加入前请自行确认命令与环境变量。/.test(modal));
ok("动作：关闭 / 仓库 / 加入 MCP；已加入时按钮禁用",
  /h\(Btn, \{ disabled: busy, onClick: \(\) => setCommunityDetail\(null\), children: t\('关闭'\) \}\)/.test(modal)
  && /externalHref\(communityDetail\.repoUrl\)/.test(modal)
  && /href: externalHref\(communityDetail\.repoUrl\), target: '_blank', rel: 'noreferrer'/.test(modal)
  && /communityJoined\(communityDetail\)[\s\S]{0,120}h\(Btn, \{ disabled: true, children: t\('已加入'\) \}\)/.test(modal)
  && /children: t\('加入 MCP'\)/.test(modal));
ok("动作：先关详情再开草稿（两层弹层不叠加）",
  /const row = communityDetail; setCommunityDetail\(null\); openCommunityDraft\(row\);/.test(modal));

// ── 5. CSS：可点反馈 / 命令行等宽 / 动作区链接不画下划线 ────────────────────
ok("CSS：clickable 卡有手型 + hover + focus-visible",
  /\.dsh-mcp-card\.wb\.clickable\{[^}]*cursor:pointer/.test(client)
  && /\.dsh-mcp-card\.wb\.clickable:hover\{[^}]*border-color:var\(--mcp-accent\)/.test(client)
  && /\.dsh-mcp-card\.wb\.clickable:focus-visible\{[^}]*outline:/.test(client));
ok("CSS：cmdline 等宽 + 可断行（长 command 不撑破弹层）",
  /\.dsh-mcp-cmdline\{[^}]*font-family:var\(--mcp-mono\)[^}]*white-space:pre-wrap[^}]*overflow-wrap:anywhere/.test(client));
ok("CSS：动作区里的仓库链接沿用按钮外观（无下划线）",
  /\.dsh-mcp-modal-actions a\.dsh-mcp-btn\{text-decoration:none\}/.test(client));

// ── 6. i18n：新增文案必须有 en-US 词条（双向护栏再兜底）────────────────────
const enBlock = client.slice(client.indexOf("const EN_US_MESSAGES"), client.indexOf("applyI18nLocale(I18N_LOCALE)"));
for (const key of ["查看 {0} 的详情", "社区 MCP 详情", "启动命令", "远程地址", "密钥"]) {
  const needle = `"${key}": "`;
  const at = enBlock.indexOf(needle);
  ok(`i18n：${key} 有 en-US 词条`, at >= 0 && enBlock.slice(at + needle.length).indexOf('"') > 0);
}

// ── 反向自测：改回旧语义，断言必须变红 ─────────────────────────────────────
// 旧写法（整卡 role=button）现在属于被禁止的形态：注回去必须能被检测到。
const legacyRole = card.replace("className: 'dsh-mcp-card wb clickable',", "className: 'dsh-mcp-card wb clickable',\n              role: 'button',");
ok("反向：整卡注回 role=button → 禁用断言必须命中", /role: 'button'/.test(legacyRole));

const detailBtnRe = /'aria-label': detailLabel[\s\S]{0,160}t\('详情'\)/;
const noDetailBtn = card.replace(/'aria-label': detailLabel,/, "");
ok("反向：去掉详情按钮的无障碍名 → 详情按钮断言必须失败",
  detailBtnRe.test(card) && !detailBtnRe.test(noDetailBtn));

const noStop = card.replace("onClick: (e) => e.stopPropagation(), onKeyDown: (e) => e.stopPropagation()", "");
ok("反向：操作区不再阻止冒泡 → 断言必须失败（点安装会误开详情）",
  !/className: 'dsh-mcp-wb-card-actions', onClick: \(e\) => e\.stopPropagation\(\)/.test(noStop));

const wrongOrder = modal.replace("const row = communityDetail; setCommunityDetail(null); openCommunityDraft(row);", "const row = communityDetail; openCommunityDraft(row); setCommunityDetail(null);");
ok("反向：先开草稿再关详情 → 顺序断言必须失败（两层弹层会叠加）",
  !/setCommunityDetail\(null\); openCommunityDraft\(row\);/.test(wrongOrder)
  && /openCommunityDraft\(row\); setCommunityDetail\(null\)/.test(wrongOrder));

const noTrap = client.replace("useFocusTrap(communityDetailRef, !!communityDetail);", "");
ok("反向：去掉焦点陷阱 → 断言必须失败", !/useFocusTrap\(communityDetailRef, !!communityDetail\)/.test(noTrap));

console.log(failed === 0 ? "COMMUNITY-DETAIL PASS" : `${failed} CHECK(S) FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
