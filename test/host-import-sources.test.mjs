// OPT-17 导入源降级结构（护栏 2）：VS Code 的 `${input:xxx}` 占位符从「整份文件拒绝」
// 改为「逐条降级」。normalizeSourceText 的新返回结构：
//   { entries, warnings, unsupportedEntries, error } —— error 只留给「整份文件读不懂」。
// 降级规则：`${input:}` 在 url/command/cwd → 整条进 unsupportedEntries（带
//   {name, transport, reason, names} 四键）；在 env.*/headers.*/args 元素 → 剔字段 + warning，
//   条目仍可导入。lib/index.js:635 的注释明确说投影键集由本测试钉死。
//
// 真实运行断言 import 自 lib/mcp-import-sources.js（依赖 smol-toml/yaml 裸导入，
// 本机走 test/loader.mjs 的宿主 profile 重定向；CI 的标准 node_modules 解析兜底）。
// projectSourceRow（lib/index.js）未导出且 lib/index.js import @deepseek-ai/*（本机无
// 对应可加载副本），故其键集用窄锚静态断言钉死——弱于运行时断言，见文末 Known 局限。
//
// 只用 node: 内置模块。用法：node ./test/host-import-sources.test.mjs
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// 裸导入重定向（与 run-expert-manual.mjs 同一范式：register 后再动态 import）。
register("./loader.mjs", pathToFileURL(join(here, "/")));

const SOURCES_URL = new URL("../lib/mcp-import-sources.js", import.meta.url).href;
// 只解构本套件真正断言的两个导出：多解构一个不用的绑定会让 `no-unused-vars` 报错。
const { IMPORT_SOURCES, normalizeSourceText } = await import(SOURCES_URL);

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

// ── 取 vscode 来源对象（运行时查找，不硬编码下标）──────────────────────────
const vscodeSource = IMPORT_SOURCES.find((source) => source.id === "vscode");
ok("IMPORT_SOURCES 里有 vscode 来源", Boolean(vscodeSource), vscodeSource ? vscodeSource.label : "缺失");

// ── fixture：三条 server（A 硬位置整条降级 / B 软位置剔键 / C 干净）──────────
// A：command 带 ${input:token}（硬位置 → 整条降级进 unsupportedEntries）
// B：env.TOKEN 带 ${input:key}（软位置 → 剔键 + warning，条目仍可导入）
// C：干净条目
const FIXTURE = JSON.stringify({
  servers: {
    alpha: { type: "stdio", command: "npx ${input:token}", args: ["-y", "some-server"] },
    beta: { type: "stdio", command: "node", args: ["./x.js"], env: { TOKEN: "${input:key}", HOME: "/h" } },
    gamma: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer clean" } },
  },
});

const normalized = normalizeSourceText(vscodeSource, FIXTURE, "json");

console.log("\n── OPT-17 逐条降级结构 ──");
// 顶层形状。
ok("返回顶层四键齐全", ["entries", "warnings", "unsupportedEntries", "error"].every((key) => key in normalized));
ok("顶层 error 为空（文件整体可解析）", normalized.error === "", JSON.stringify(normalized.error));
ok("beta / gamma 进 entries（2 条）", normalized.entries.length === 2, normalized.entries.map((entry) => entry.name).join(", "));
ok("alpha 进 unsupportedEntries（1 条）", normalized.unsupportedEntries.length === 1 && normalized.unsupportedEntries[0].name === "alpha", JSON.stringify(normalized.unsupportedEntries.map((entry) => entry.name)));
// 软位置的降级说明挂在**条目**的 warnings 上（投影时才与来源级合并），顶层 warnings 只收来源级。
ok("顶层 warnings 是数组（来源级通道存在）", Array.isArray(normalized.warnings));

// 硬位置降级条目（alpha）。
const alpha = normalized.unsupportedEntries[0];
ok("alpha 条目四键（name/transport/reason/names）", alpha && ["name", "transport", "reason", "names"].every((key) => key in alpha));
ok("alpha.names 含 token", alpha && Array.isArray(alpha.names) && alpha.names.includes("token"), JSON.stringify(alpha?.names));
ok("alpha.reason 非空字符串", alpha && typeof alpha.reason === "string" && alpha.reason.length > 0);
ok("alpha.transport 判为 stdio", alpha && alpha.transport === "stdio", String(alpha?.transport));

// 软位置降级条目（beta）。
const beta = normalized.entries.find((entry) => entry.name === "beta");
ok("beta 条目五键（name/spec/error/warnings/unsupported）", beta && ["name", "spec", "error", "warnings", "unsupported"].every((key) => key in beta));
ok("beta.unsupported === null", beta && beta.unsupported === null);
ok("beta.spec 存在且 env.TOKEN 被剔除", beta && beta.spec && beta.spec.env && !("TOKEN" in beta.spec.env), JSON.stringify(beta?.spec?.env ?? null));
ok("beta.spec 保留干净键 HOME", beta && beta.spec?.env && beta.spec.env.HOME === "/h");
ok("beta 条目自身 warnings 非空", beta && Array.isArray(beta.warnings) && beta.warnings.length > 0, JSON.stringify(beta?.warnings));
ok("gamma 条目无 warnings、unsupported === null", (() => {
  const gamma = normalized.entries.find((entry) => entry.name === "gamma");
  return gamma && gamma.unsupported === null && gamma.warnings.length === 0;
})());

// 硬位置降级条目（url 变体 + 无 type 字段变体；guessTransport 优先显式 type，见 :555）。
const HARD_FIXTURE = JSON.stringify({
  servers: {
    blocked: { type: "stdio", command: "npx ${input:token}", args: ["-y", "srv"] },
    urlBlocked: { url: "https://gw.example.com/${input:region}/mcp" },
    ok: { type: "stdio", command: "node", args: ["./y.js"] },
  },
});
const hard = normalizeSourceText(vscodeSource, HARD_FIXTURE, "json");
ok("硬位置降级：command 带 ${input:} 整条进 unsupportedEntries", hard.unsupportedEntries.length === 2, JSON.stringify(hard.unsupportedEntries.map((entry) => entry.name)));
const blockedRow = hard.unsupportedEntries.find((entry) => entry.name === "blocked");
ok("blocked 条目四键（name/transport/reason/names）", blockedRow && ["name", "transport", "reason", "names"].every((key) => key in blockedRow));
ok("blocked.names 含 token", blockedRow && Array.isArray(blockedRow.names) && blockedRow.names.includes("token"), JSON.stringify(blockedRow?.names));
ok("blocked.reason 非空字符串", blockedRow && typeof blockedRow.reason === "string" && blockedRow.reason.length > 0);
ok("blocked.transport 判为 stdio", blockedRow && blockedRow.transport === "stdio", String(blockedRow?.transport));
const urlRow = hard.unsupportedEntries.find((entry) => entry.name === "urlBlocked");
ok("无 type 字段时 url 降级条目 transport 判为 streamable-http（guessTransport 按位置推断）", urlRow && urlRow.transport === "streamable-http", String(urlRow?.transport));
ok("硬位置降级不影响干净条目", hard.entries.length === 1 && hard.entries[0].name === "ok");
ok("硬位置降级顶层 error 仍为空（逐条降级，不是整份拒绝）", hard.error === "", JSON.stringify(hard.error));

// ── 边界：空 unsupportedEntries 投影为 [] 不抛错 ───────────────────────────
console.log("\n── 边界 ──");
const clean = normalizeSourceText(vscodeSource, JSON.stringify({ servers: { only: { type: "stdio", command: "node", args: ["./z.js"] } } }), "json");
ok("全干净配置：unsupportedEntries === []", Array.isArray(clean.unsupportedEntries) && clean.unsupportedEntries.length === 0);
ok("全干净配置：error === ''", clean.error === "");
ok("全干净配置：entries 1 条且 unsupported === null", clean.entries.length === 1 && clean.entries[0].unsupported === null);

// 整份解析失败（真正的 error 通道）。
const broken = normalizeSourceText(vscodeSource, "{not json", "json");
ok("坏 JSON：error 非空且 entries/unsupportedEntries 为空数组", typeof broken.error === "string" && broken.error.length > 0 && broken.entries.length === 0 && broken.unsupportedEntries.length === 0);

// ── projectSourceRow 投影键集钉死（静态窄锚）───────────────────────────────
console.log("\n── projectSourceRow 键集（静态窄锚钉死）──");
const indexPath = join(here, "..", "lib", "index.js");
const indexText = readFileSync(indexPath, "utf8");
// 窄锚：只看 projectSourceRow 函数体，其它位置的相似键不参与。
const anchor = "function projectSourceRow(row) {";
const start = indexText.indexOf(anchor);
if (start === -1) {
  ok("lib/index.js 能定位 projectSourceRow", false, "锚点缺失：函数可能已改名，需人工更新本测试");
} else {
  // 函数体：从锚点开始做括号配平（verify-host-installinfo.mjs 已有同类先例）。
  let depth = 0;
  let end = -1;
  for (let i = indexText.indexOf("{", start); i < indexText.length; i += 1) {
    const ch = indexText[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = end === -1 ? "" : indexText.slice(start, end);
  ok("projectSourceRow 函数体括号配平成功", body.length > 0);
  for (const key of ["key:", "sourceId:", "label:", "scope:", "displayPath:", "error:", "warnings:", "entries:", "unsupportedEntries:"]) {
    ok(`row 投影含 ${key.replace(":", "")}`, body.includes(key));
  }
  // entries 的条目投影四键：name/error/maskedFields/missingEnv。
  const entriesAnchor = body.indexOf("entries: row.entries.map");
  const entriesBody = entriesAnchor === -1 ? "" : body.slice(entriesAnchor, entriesAnchor + 400);
  for (const key of ["name:", "error:", "maskedFields:", "missingEnv:"]) {
    ok(`entries[*] 投影含 ${key.replace(":", "")}`, entriesBody.includes(key));
  }
  // unsupportedEntries 的条目投影四键：name/transport/reason/names。
  const unsupAnchor = body.indexOf("unsupportedEntries: (row.unsupportedEntries ?? []).map");
  const unsupBody = unsupAnchor === -1 ? "" : body.slice(unsupAnchor, unsupAnchor + 400);
  for (const key of ["name:", "transport:", "reason:", "names:"]) {
    ok(`unsupportedEntries[*] 投影含 ${key.replace(":", "")}`, unsupBody.includes(key));
  }
  // 反向钉死：投影里不得出现 spec（条目本体不外发，泄漏面不扩大）。
  ok("unsupportedEntries[*] 不透出 spec", unsupBody.length > 0 && !/spec:/.test(unsupBody));
  ok("entries[*] 不透出 spec", entriesBody.length > 0 && !/spec:/.test(entriesBody));
}

// selectSourceServers 的两类错误文案（OPT-17 行为护栏）：blocked 名字与缺失名字分开报。
const sssAnchor = "function selectSourceServers(row, names) {";
const sssStart = indexText.indexOf(sssAnchor);
const sssEnd = sssStart === -1 ? -1 : indexText.indexOf("\nfunction ", sssStart + 1);
const sssBody = sssStart === -1 || sssEnd === -1 ? "" : indexText.slice(sssStart, sssEnd);
ok("selectSourceServers 区分「需要交互取值」与「来源中没有」两类文案",
  sssBody.includes("需要交互取值") && sssBody.includes("来源中没有可导入的 MCP"));

console.log(failures === 0 ? "\nHOST IMPORT SOURCES PASS" : `\n${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
