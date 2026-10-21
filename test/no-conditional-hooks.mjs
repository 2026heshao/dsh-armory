#!/usr/bin/env node
// 回归：条件分支里不许出现 hook —— 这是 React #310 的唯一定式来源。
//
// 事故（2.0.1）：市场 → 专家，点卡片「详情」整块面板崩进错误边界，报
//   "Minified React error #310"（= Rendered more hooks than during the previous render）。
// 根因：ExpertMarket 的详情弹层写成 `detail ? (() => { … })() : null`，而弹层内部又
// 直接声明了 `const [personaExpanded, setPersonaExpanded] = useState(false)` 与
// `const [showAllPrompts, setShowAllPrompts] = useState(false)`。首帧 detail 为 null，
// 这两个 hook 一次都不调用；点「详情」后同一个组件突然多调用两个 hook，React 直接抛 #310。
//
// 修法是把两个 hook 上提到组件顶层（每次渲染都调用）。本用例守的就是这条线：**任何**
// 三元 / && / || 分支里的 IIFE，只要里面出现 use[A-Z] 调用就判失败——不管这次有没有
// 写崩，形状本身就是雷。同时用「反向自测」证明这条断言真的在检查（把 bug 塞回去必须变红）。
//
// 为什么要自己写个遮罩词法器：lib/client.js 是 630KB 手写 h() 单文件，模板串里全是
// `{0}` 这类占位，直接按 `{}` 配平会被字符串里的花括号带偏。这里把字符串 / 模板 /
// 注释替换成等长空格（保留换行，因此偏移与行号都对得上原文件），再在遮罩文本上配平。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url)); // 仓库路径含中文，必须 fileURLToPath
const CLIENT = join(here, "..", "lib", "client.js");
const SOURCE = readFileSync(CLIENT, "utf8");

let failures = 0;
const ok = (name, condition, extra = "") => {
  const tag = condition ? "PASS" : "FAIL";
  if (!condition) failures += 1;
  console.log(`\n${tag}  ${name}${extra ? `\n      ${extra}` : ""}`);
  return condition;
};
const info = (name, extra = "") => console.log(`INFO  ${name}${extra ? `  ${extra}` : ""}`);
const lineOf = (text, at) => text.slice(0, at).split("\n").length;

// ── 遮罩：字符串 / 模板 / 注释 → 等长空格（换行保留）────────────────────
const maskLiterals = (text) => {
  const out = text.split("");
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (text[k] !== "\n") out[k] = " ";
    }
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "/" && text[i + 1] === "/") {
      let end = text.indexOf("\n", i);
      if (end === -1) end = text.length;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      let end = text.indexOf("*/", i + 2);
      end = end === -1 ? text.length : end + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let cursor = i + 1;
      while (cursor < text.length) {
        if (text[cursor] === "\\") { cursor += 2; continue; }
        if (text[cursor] === quote) { cursor += 1; break; }
        // 模板串里的 ${…} 也整体当字面量放过：里面即使有 useXxx( 也不是组件顶层调用
        cursor += 1;
      }
      blank(i, cursor);
      i = cursor;
      continue;
    }
    i += 1;
  }
  return out.join("");
};

const maskedOf = (text) => maskLiterals(text);

// 从 `{` 配平到对应 `}`；不配平返回 -1（调用方记为扫描失败，绝不静默当成「没 hook」）
const matchBrace = (masked, openAt) => {
  let depth = 0;
  for (let i = openAt; i < masked.length; i += 1) {
    if (masked[i] === "{") depth += 1;
    else if (masked[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
};

// 条件表达式里的 IIFE：`? (() => {`、`&& (() => {`、`|| (() => {`
const CONDITIONAL_IIFE = /(\?|&&|\|\|)\s*\(\s*\(\s*\)\s*=>\s*\{/g;
// 任何 use[A-Z] 开头的调用都算 hook（含本项目自定义 useFocusTrap），宁严不宽
const HOOK_CALL = /\b(use[A-Z][A-Za-z0-9_]*)\s*\(/g;

const findConditionalIifeHooks = (text) => {
  const masked = maskedOf(text);
  const sites = [];
  const unbalanced = [];
  CONDITIONAL_IIFE.lastIndex = 0;
  let match;
  while ((match = CONDITIONAL_IIFE.exec(masked)) !== null) {
    const openAt = match.index + match[0].length - 1; // 命中的最后一个字符就是 `{`
    const closeAt = matchBrace(masked, openAt);
    if (closeAt === -1) {
      unbalanced.push(lineOf(text, openAt));
      continue;
    }
    const body = masked.slice(openAt, closeAt + 1);
    const hooks = [];
    HOOK_CALL.lastIndex = 0;
    let hit;
    while ((hit = HOOK_CALL.exec(body)) !== null) {
      hooks.push({ name: hit[1], line: lineOf(text, openAt + hit.index) });
    }
    sites.push({ openAt, closeAt, operator: match[1], line: lineOf(text, openAt), hooks });
  }
  return { sites, unbalanced };
};

// ── 1. 基线：整改后的源码里，条件 IIFE 内 hook 数为 0 ────────────────────
const { sites, unbalanced } = findConditionalIifeHooks(SOURCE);
const offenders = sites.filter((site) => site.hooks.length > 0);

info(
  "扫到的条件 IIFE 站点（行号）",
  sites.length ? sites.map((site) => `${site.line}${site.operator}`).join(", ") : "(none)",
);
ok("遮罩 + 配平没有失败（每个站点都取到了完整闭包）", unbalanced.length === 0, `未配平行=[${unbalanced.join(",")}]`);
ok("确实扫到了条件 IIFE（否则下面的 0 只是「没扫到」）", sites.length >= 2, `站点数=${sites.length}`);
ok(
  "条件分支（三元 / && / || 的 IIFE）里没有任何 hook 调用",
  offenders.length === 0,
  offenders.length
    ? offenders.map((site) => `行 ${site.line} ${site.operator} → ${site.hooks.map((h) => `${h.name}()@${h.line}`).join(", ")}`).join(" | ")
    : `检查了 ${sites.length} 个站点`,
);

// ── 2. 定点：ExpertMarket 详情弹层里那三个开关必须声明在条件分支之外 ──────
const expertMarketAt = SOURCE.indexOf("const ExpertMarket = ({ call }) => {");
ok("定位到 ExpertMarket 组件", expertMarketAt !== -1, expertMarketAt === -1 ? "" : `行 ${lineOf(SOURCE, expertMarketAt)}`);
const expertDetailSite = sites.find(
  (site) => site.openAt > expertMarketAt && SOURCE.slice(expertMarketAt, site.openAt).includes("detail ?"),
);
ok("定位到详情弹层 `detail ? (() => { … })()`", Boolean(expertDetailSite), expertDetailSite ? `行 ${expertDetailSite.line}` : "");
if (expertDetailSite) {
  ok(
    "详情弹层 IIFE 内零 hook（#310 的直接判据）",
    expertDetailSite.hooks.length === 0,
    expertDetailSite.hooks.length ? expertDetailSite.hooks.map((h) => `${h.name}()@${h.line}`).join(", ") : "0 个",
  );
  const head = SOURCE.slice(expertMarketAt, expertDetailSite.openAt);
  const declPersona = head.indexOf("const [personaExpanded, setPersonaExpanded] = useState(false)");
  const declPrompts = head.indexOf("const [showAllPrompts, setShowAllPrompts] = useState(false)");
  ok(
    "personaExpanded 的 useState 声明在组件顶层、且在条件分支之前",
    declPersona !== -1,
    declPersona === -1 ? "没找到声明" : `声明行 ${lineOf(SOURCE, expertMarketAt + declPersona)} < 弹层行 ${expertDetailSite.line}`,
  );
  ok(
    "showAllPrompts 的 useState 声明在组件顶层、且在条件分支之前",
    declPrompts !== -1,
    declPrompts === -1 ? "没找到声明" : `声明行 ${lineOf(SOURCE, expertMarketAt + declPrompts)} < 弹层行 ${expertDetailSite.line}`,
  );
  ok(
    "两处开关都在同一个组件函数体内（没有被挪到别的组件里凑数）",
    declPersona !== -1 && declPrompts !== -1 && Math.abs(declPersona - declPrompts) < 400,
    declPersona !== -1 && declPrompts !== -1 ? `相距 ${Math.abs(declPersona - declPrompts)} 字符` : "",
  );
}

// ── 3. 反向自测：把 bug 塞回去，检测器必须变红 ──────────────────────────
// 3a：任意站点注入一个 hook
if (sites.length) {
  const victim = sites[0];
  const at = victim.openAt + 1;
  const mutated = `${SOURCE.slice(0, at)}\n const [__injected, __setInjected] = useState(false);\n${SOURCE.slice(at)}`;
  const result = findConditionalIifeHooks(mutated);
  const caught = result.sites.filter((site) => site.hooks.length > 0);
  ok(
    "自测：往条件 IIFE 里注入一个 useState，检测器确实报出违规",
    caught.length === 1 && caught[0].hooks.some((hook) => hook.name === "useState"),
    caught.length ? `报出行 ${caught[0].line} → ${caught[0].hooks.map((h) => h.name).join(",")}` : "没报出（检测器是假的）",
  );
}

// 3b：把原始 bug 原样还原（两个 hook 塞回详情弹层）
if (expertDetailSite) {
  const at = expertDetailSite.openAt + 1;
  const replay =
    `${SOURCE.slice(0, at)}\n` +
    "      const [personaExpanded, setPersonaExpanded] = useState(false);\n" +
    "      const [showAllPrompts, setShowAllPrompts] = useState(false);\n" +
    `${SOURCE.slice(at)}`;
  const result = findConditionalIifeHooks(replay);
  const caught = result.sites.filter((site) => site.hooks.length > 0);
  const caughtHooks = caught.flatMap((site) => site.hooks);
  ok(
    "自测：原样还原 #310 现场（两个 useState 塞回详情弹层）必须被抓到，且正好 2 个",
    caught.length === 1 && caughtHooks.length === 2,
    caught.length ? `报出行 ${caught[0].line} → ${caughtHooks.map((h) => `${h.name}@${h.line}`).join(", ")}` : "没报出（检测器是假的）",
  );
}

// 3c：改动位置但仍在条件分支里（hook 藏在闭包里）也要抓到
if (sites.length) {
  const victim = sites[0];
  const at = victim.openAt + 1;
  const mutated = `${SOURCE.slice(0, at)}\n const later = () => { const [v, setV] = useState(1); return v; };\n${SOURCE.slice(at)}`;
  const result = findConditionalIifeHooks(mutated);
  const caught = result.sites.filter((site) => site.hooks.length > 0);
  ok("自测：条件 IIFE 内层闭包里藏 hook 也会被抓到", caught.length === 1, caught.length ? `行 ${caught[0].line}` : "漏报");
}

console.log(failures === 0 ? "\nNO-CONDITIONAL-HOOKS PASS" : `\nNO-CONDITIONAL-HOOKS FAIL (${failures})`);
process.exitCode = failures === 0 ? 0 : 1;