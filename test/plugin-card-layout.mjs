// DSH 社区插件卡片排版守护（2026-10-24）：
// 用户反馈「插件卡片信息排版乱、标题被徽章挤断、按钮不在同一水平线」。改法是把卡片拆成
// 五条固定水平线：头部 34 / 摘要 38 / 标签 18 / 页脚 38，整卡 176。这里钉住三件事：
//   1. 尺寸账不能漂：CSS 里的固定值一旦被改回内容驱动，卡片会重新参差；
//   2. 信息分配：作者只出现一次、验证态只留图标、标签最多三个、星标与 npm 近 30 天下载量
//      与核验日期进页脚（页脚那一行由 PluginCardFacts 负责，见下面三次改版的注释），
//      包名上标签行（它是行内唯一可收缩的一枚，见 2026-10-24 二次改版的注释）；
//   3. 隔离与移除：只作用于 .dsh-mcp-pcard；CodeBuddy 插件卡与来源切换已整体移除，不得复活。
// 全部静态读取 lib/client.js，零网络零写盘。每条关键断言都配反向自测，防止断言空转。
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

// ── 只截 DSH 社区插件卡片的渲染段，避免命中 CodeBuddy / 技能 / 专家卡片 ──────────
const start = client.indexOf("visibleAwesome.map((item) => {");
const end = client.indexOf("awesomePageCount > 1", start);
const card = start >= 0 && end > start ? client.slice(start, end) : "";
ok("渲染段可定位（找不到锚点直接失败，避免测个空）", card.length > 1200, `len=${card.length}`);

// ── 底栏那一行的专属组件（页脚三枚事实的排版规矩都在它里面）──────────────────
const factsStart = client.indexOf("const PluginCardFacts = ({");
const factsEnd = factsStart >= 0 ? client.indexOf("// ── Skill 看板", factsStart) : -1;
const facts = factsStart >= 0 && factsEnd > factsStart ? client.slice(factsStart, factsEnd) : "";
ok("底栏组件可定位（PluginCardFacts 在卡片外、Skill 看板前）", facts.length > 600, `len=${facts.length}`);

// ── 尺寸账：固定行高，而不是被内容撑开 ─────────────────────────────────────
const pcardBlock = (client.match(/\.dsh-mcp-pcard\{([^}]*)\}/) || [])[1] || "";
ok("CSS：卡片内边距 12px、间距 7px、最小高度 176px",
  /padding:12px/.test(pcardBlock) && /gap:7px/.test(pcardBlock) && /min-height:176px/.test(pcardBlock));
ok("CSS：头部 32px 头像列 + 34px 行高",
  /\.dsh-mcp-phead\{[^}]*grid-template-columns:32px minmax\(0,1fr\) auto[^}]*min-height:34px/.test(client));
ok("CSS：标题 14px / 1.3，单行省略",
  /\.dsh-mcp-pname\{[^}]*font-size:14px[^}]*line-height:1\.3[^}]*white-space:nowrap[^}]*text-overflow:ellipsis/.test(client));
ok("CSS：摘要固定 38px、两行截断",
  /\.dsh-mcp-pdesc\{[^}]*height:38px[^}]*line-clamp:2/.test(client));
ok("CSS：标签行固定 18px、不换行",
  /\.dsh-mcp-pchips\{[^}]*height:18px[^}]*white-space:nowrap/.test(client));
// 包名芯片的收缩规矩：只让它一枚可缩，且不碰 line-height/padding —— 碰了行高就漂，
// 卡高 176 的尺寸账（下面那条 34+38+18+38）当场作废。
ok("CSS：包名芯片 mono 可收缩 + 省略号",
  /\.dsh-mcp-pchip\.mono\{[^}]*flex:0 1 auto[^}]*min-width:0[^}]*overflow:hidden[^}]*text-overflow:ellipsis/.test(client));
ok("CSS：mono 不得改行高来源（不设 line-height / padding / height）",
  ! /\.dsh-mcp-pchip\.mono\{[^}]*(line-height|padding|height):/.test(client));
ok("CSS：分类与标签芯片仍 flex:none（半截只可能是包名那枚）",
  /\.dsh-mcp-pchip\{[^}]*flex:none/.test(client));
ok("CSS：页脚 38px、贴底、带上分隔线",
  /\.dsh-mcp-pfoot\{[^}]*min-height:38px[^}]*margin-top:auto[^}]*border-top:1px solid var\(--mcp-line\)/.test(client));
// 2026-10-24 三次改版：底栏那一行加到三枚事实（↓近30天下载 / ★ / 核验日期），字号
// 10.5→11.5px 并要求卡高不动。两条规矩把这件事钉住：
//   · 字号 11.5×1.4 = 16.1px，仍远小于页脚 min-height 38px → 这行字变大不动卡高；
//   · 分隔点整体去掉（gap:7px 顶上），且这一行 flex:1 1 0 —— 行盒宽度恒等于可用宽，
//     JS 量到的才是真可用宽（内容伸缩的话永远量不出「其实放不下」），按钮也永不被挤换行。
ok("CSS：底栏 11.5px / gap 7px，两枚「·」分隔点样式不得复活",
  /\.dsh-mcp-pfacts\{[^}]*font-size:11\.5px/.test(client)
  && /\.dsh-mcp-pfacts\{[^}]*gap:7px/.test(client)
  && !/\.dsh-mcp-pfacts \.sep/.test(client));
ok("CSS：底栏 position:relative + flex:1 1 0 + min-width:0（行宽=可用宽，收缩不落按钮）",
  /\.dsh-mcp-pfacts\{[^}]*position:relative[^}]*flex:1 1 0/.test(client)
  && /\.dsh-mcp-pfacts\{[^}]*min-width:0/.test(client)
  && /\.dsh-mcp-pfacts\{[^}]*overflow:hidden/.test(client));
ok("CSS：离流探针 width:max-content + visibility:hidden（在流里就量不出溢出）",
  /\.dsh-mcp-pfacts-probe\{[^}]*width:max-content[^}]*visibility:hidden/.test(client));
ok("尺寸账：底栏行 16.1px < 页脚 38px，字号变大不动卡高", 11.5 * 1.4 < 38);
ok("CSS：按钮 28px 高，安装与已安装两态",
  /\.dsh-mcp-pbtn\{[^}]*height:28px/.test(client) && /\.dsh-mcp-pbtn\.installed\{/.test(client));
ok("尺寸账自洽：24 内边距 + 2 边框 + 34 + 38 + 18 + 38 + 3×7 = 175，min-height 补到 176",
  24 + 2 + 34 + 38 + 18 + 38 + 21 === 175);

// ── 信息分配：每条信息只出现一次 ──────────────────────────────────────────
ok("渲染：卡片使用专属 class（不沿用 CodeBuddy 的 dsh-mcp-card wb）",
  /className: 'dsh-mcp-pcard'/.test(card) && !/dsh-mcp-card wb/.test(card));
ok("渲染：头像先出首字母，图片失败时藏起图片露出字母",
  /className: 'dsh-mcp-pavatar'/.test(card)
  && /String\(item\.name \|\| '\?'\)\.slice\(0, 1\)\.toUpperCase\(\)/.test(card)
  && /onError: \(e\) => \{ e\.currentTarget\.style\.display = 'none'; \}/.test(card)
  && !/currentTarget\.remove\(\)/.test(card));
ok("渲染：标题带 title，超长可悬停看全名", /className: 'dsh-mcp-pname', title: item\.name/.test(card));
ok("渲染：官方标记与仓库合并到一行，不再单独占行",
  /className: 'dsh-mcp-pmeta'/.test(card) && /item\.official && repoLabel/.test(card) && !/dsh-mcp-card-vendor/.test(card));
ok("渲染：验证态只留图标 + tooltip，不再输出整段 verified 文字",
  /VerifiedSeal/.test(card) && !/verified \(dsh/.test(card));
ok("渲染：作者信息不再调用 PresenceLine（避免作者/核验日期重复）", !/PresenceLine/.test(card));
// 2026-10-24 二次改版：42.3% 的条目 npm 包名 ≠ 显示名，装的时候只能用包名，所以包名上卡面。
// 它排在标签行第一枚，并且是那一行里**唯一可收缩**的一枚 —— 分类/标签保持 flex:none，
// 放不下的是包名自己（省略号），不会出现半截芯片。上一版「npm 不上卡面」的分配已作废。
ok("渲染：包名芯片排第一，只在 ≠ 显示名时出现",
  /const npmPackage = item\.npm && String\(item\.npm\) !== String\(item\.name \|\| ''\) \? String\(item\.npm\) : ''/.test(card)
  && /if \(npmPackage\) chips\.push\(npmPackage\)/.test(card)
  && /className: 'dsh-mcp-pchip' \+ \(tag === npmPackage \? ' mono' : ''\)/.test(card)
  && /title: tag === npmPackage \? npmPackage : undefined/.test(card));
ok("渲染：星标从标签行移出、走紧凑计数（不用 Badge）",
  !/item\.npm \? h\(Badge/.test(card) && !/item\.stars \? h\(Badge/.test(card));

// 三次改版：底栏那一行整体交给 PluginCardFacts，卡片里不再手写 span/sep。
ok("渲染：底栏交给 PluginCardFacts，卡片里不手写那一行",
  /h\(PluginCardFacts, \{/.test(card) && !/className: 'dsh-mcp-pfacts'/.test(card));
ok("渲染：星标与下载量走紧凑计数，星数保留精确值 tooltip",
  /starText: stars \? wbFormatCount\(stars\)/.test(card) && /starTitle: '★ ' \+ stars/.test(card)
  && /wbFormatCount\(downloads\)/.test(card));
// ↓ 的真源是 npm 公开统计（api.npmjs.org last-month），目录里没有这个字段。
// 拿不到（下架 / 未被统计 / 接口挂）就整枚不画：0 会被读成「没人下载」，那是假信号。
ok("渲染：下载量只在真值 > 0 时出现，缺值不画 0",
  /const downloads = npmDownloadsFor\(item\.npm\);/.test(card)
  && /downloadsText: downloads && downloads > 0 \? wbFormatCount\(downloads\) : ''/.test(card));
ok("渲染：↓ 的 title 写明是近 30 天（技能卡那枚是累计口径，不能混）",
  /downloadsTitle: t\('npm 近 30 天下载量'\)/.test(card));
ok("渲染：日期只写「核验」，不得伪装成插件自身的更新时间",
  /const dateFact = verifiedDate \? t\('核验 \{0\}', \[verifiedDate\]\) : '';/.test(card)
  && /dateTitle: t\('核验日期来自目录批次核验，不是插件自身的更新时间'\)/.test(card)
  && !/t\('更新于/.test(card)
  && /wbFormatDate\(timestampOf\(item\.lastVerified\)\)\.slice\(5\)/.test(card));
// 「dsh 版本」从底栏退到右上角已验证徽标的 tooltip（底栏三枚已经排满，版本留给判断
// 「能不能装」的那一层看；信息一条没丢，只是换了个出口）。
ok("渲染：dsh 版本退出底栏、并进已验证徽标 tooltip",
  !/const footFact/.test(card)
  && !/'dsh ' \+ String\(item\.verifiedAgainst\)/.test(card)
  && /const sealTip = verifiedLabel \? verifiedLabel \+ \(verifiedDate \? ' · ' \+ t\('核验 \{0\}', \[verifiedDate\]\) : ''\) : '';/.test(card)
  && /title: sealTip \|\| verifiedLabel/.test(card));
ok("渲染：下载量按当前页在组件顶层取（hook 不得落进 .map）",
  client.includes("useNpmDownloads(call, visibleAwesome)")
  && client.indexOf("useNpmDownloads(call, visibleAwesome)") < start);
ok("底栏组件：放不下时整枚收起日期那枚（而不是 overflow 裁半截字）",
  /setDropDate\(probe\.getBoundingClientRect\(\)\.width > have \+ 1\)/.test(facts)
  && /if \(withDate && dateText\)/.test(facts));
ok("底栏组件：容器宽 0（面板切走）时不下结论，日期不被误收", /if \(have < 8\) return;/.test(facts));
ok("底栏组件：列宽变化经 ResizeObserver 重测，宿主没有则不抛",
  /new ResizeObserver\(measure\)/.test(facts) && /typeof ResizeObserver !== 'function'/.test(facts));
ok("渲染：标签最多三个，余量折叠成 +N",
  /chips\.slice\(0, 3\)/.test(card) && /extraChips > 0/.test(card) && /'\+' \+ extraChips/.test(card));
ok("渲染：已安装状态落到页脚按钮（不再占头部徽章位）",
  /className: 'dsh-mcp-pbtn' \+ \(installed \? ' installed' : ''\)/.test(card) && /installed \? t\('已安装'\) : t\('安装'\)/.test(card));
ok("渲染：宿主组件只读、无 npm 条目不可安装，说明仍保留",
  /t\('宿主组件'\)/.test(card) && /t\('暂不支持安装'\)/.test(card));

// ── 隔离与移除：只剩 DSH 社区卡片 ─────────────────────────────────────────
ok("移除：CodeBuddy 可点击卡片 / 来源切换 / 拉取契约均不得复活",
  !client.includes("dsh-mcp-card wb dsh-mcp-card-clickable")
  && !/\bpluginSource\b/.test(client)
  && !client.includes("wbPluginCatalog")
  && !client.includes("wbPluginDetail")
  && !client.includes("wbPluginUpdateCheck"));
ok("隔离：新卡片保留 pointer / hover / focus-visible 反馈",
  /\.dsh-mcp-pcard\{[^}]*cursor:pointer/.test(client)
  && /\.dsh-mcp-pcard:hover\{[^}]*border-color:var\(--mcp-accent\)/.test(client)
  && /\.dsh-mcp-pcard:focus-visible\{[^}]*outline:/.test(client));
ok("隔离：操作区仍阻止冒泡（点安装不打开 README）",
  /className: 'dsh-mcp-wb-card-actions', onClick: \(e\) => e\.stopPropagation\(\), onKeyDown: \(e\) => e\.stopPropagation\(\)/.test(card));

// ── 反向自测：把关键写法改回旧语义，断言必须变红 ─────────────────────────
const heightBroken = client.replace(/\.dsh-mcp-pcard\{([^}]*?)min-height:176px/, ".dsh-mcp-pcard{$1min-height:auto");
ok("反向：卡片改回内容撑高 → 尺寸账断言必须失败",
  !/min-height:176px/.test((heightBroken.match(/\.dsh-mcp-pcard\{([^}]*)\}/) || [])[1] || ""));

const chipsBroken = card.replace("chips.slice(0, 3)", "chips");
ok("反向：标签不再截到三个 → 折叠断言必须失败", !/chips\.slice\(0, 3\)/.test(chipsBroken));

const monoBroken = client.replace(".dsh-mcp-pchip.mono{flex:0 1 auto", ".dsh-mcp-pchip.mono{flex:none");
ok("反向：包名芯片改成不可收缩 → mono 断言必须失败（那样会挤裁后面的分类/标签）",
  ! /\.dsh-mcp-pchip\.mono\{[^}]*flex:0 1 auto/.test(monoBroken));

const lhBroken = client.replace(".dsh-mcp-pchip.mono{flex:0 1 auto", ".dsh-mcp-pchip.mono{line-height:18px;flex:0 1 auto");
ok("反向：mono 加 line-height → 行高不得被改的断言必须失败（176 尺寸账会漂）",
  /line-height/.test((lhBroken.match(/\.dsh-mcp-pchip\.mono\{([^}]*)\}/) || [])[1] || ""));

const npmGoneBroken = card.replace("if (npmPackage) chips.push(npmPackage);", "");
ok("反向：包名不再进标签行 → 包名断言必须失败",
  !/if \(npmPackage\) chips\.push\(npmPackage\)/.test(npmGoneBroken));

const footBroken = card.replace("title: sealTip || verifiedLabel", "title: verifiedLabel");
ok("反向：核验日期从已验证徽标 tooltip 里丢掉 → 版本退位的断言必须失败（信息就真没了）",
  !/title: sealTip \|\| verifiedLabel/.test(footBroken));

const zeroBroken = card.replace("downloads && downloads > 0 ? wbFormatCount(downloads) : ''", "wbFormatCount(downloads)");
ok("反向：拿不到下载量也画一枚 → 缺值不画 0 的断言必须失败（0 会被读成没人下载）",
  !/downloads && downloads > 0/.test(zeroBroken));

const fakeDateBroken = card.replace("t('核验 {0}', [verifiedDate])", "t('更新于 {0}', [verifiedDate])");
ok("反向：把核验日期写成「更新于」→ 语义断言必须失败（那是伪造插件更新时间）",
  !/const dateFact = verifiedDate \? t\('核验/.test(fakeDateBroken) && !!/t\('更新于/.test(fakeDateBroken));

const collapseBroken = facts.replace("setDropDate(probe.getBoundingClientRect().width > have + 1)", "setDropDate(false)");
ok("反向：取消整枚收起 → 兜底断言必须失败（那就回到裁半截字）",
  !/setDropDate\(probe\.getBoundingClientRect\(\)\.width > have \+ 1\)/.test(collapseBroken));

const sepBroken = client.replace(".dsh-mcp-pfacts{position:relative", ".dsh-mcp-pfacts .sep{opacity:.55}\n.dsh-mcp-pfacts{position:relative");
ok("反向：底栏「·」分隔点样式复活 → 「无分隔点」断言必须变红（那是白掉的 25px）",
  /\.dsh-mcp-pfacts \.sep/.test(sepBroken) && !/\.dsh-mcp-pfacts \.sep/.test(client));

const dupeBroken = card.replace("className: 'dsh-mcp-pmeta'", "className: 'dsh-mcp-card-vendor'");
ok("反向：作者信息退回旧 class → 去重断言必须失败", /dsh-mcp-card-vendor/.test(dupeBroken));

console.log(failed === 0 ? "PLUGIN-CARD-LAYOUT PASS" : `${failed} CHECK(S) FAILED`);
process.exitCode = failed === 0 ? 0 : 1;
