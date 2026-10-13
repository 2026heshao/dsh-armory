// 测试专用加载器：把裸导入 `yaml` / `smol-toml` / `zod` 重定向到宿主 profile 的
// node_modules 副本（工作区被沙箱限制无法创建 node_modules 目录，ESM 也不认 NODE_PATH）。
// 用法：node --import ./test/loader.mjs test/expert-manual.mjs
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";

const PROFILE_MODULES = join(homedir(), ".dsh", "profiles", "desktop", "node_modules");
// 宿主模块（从 app.asar 提取）的裸导入也按此表重定向：优先 profile 副本，
// 缺失的（如 js-yaml）回退到 pnpm store 的实际落点。
const REDIRECT = new Set(["yaml", "smol-toml", "zod", "js-yaml", "@deepseek-ai/cordis", "@deepseek-ai/cordis-plugin-loader", "@deepseek-ai/schemastery", "@deepseek-ai/dsh-home-paths", "@deepseek-ai/cosmokit", "cordis", "dot-prop", "fast-glob", "regenerator-runtime", "schemastery"]);
const targetCache = new Map();

/** pnpm store（node_modules/.pnpm）里按包名@版本目录定位真实包根。 */
function pnpmStoreRoot(name) {
  const store = join(PROFILE_MODULES, ".pnpm");
  let best = null;
  let names = [];
  try { names = readdirSync(store); } catch { return null; }
  for (const entry of names) {
    if (!entry.startsWith(name + "@")) continue;
    const candidate = join(store, entry, "node_modules", name);
    try { if (statSync(candidate).isDirectory()) { if (!best || entry.length > best.length) best = candidate; } } catch { /* 跳过 */ }
  }
  return best;
}

/** 解析一个宿主裸导入：profile 副本 → pnpm store → _research 提取副本。 */
function hostModuleRoot(name) {
  const flat = join(PROFILE_MODULES, name);
  try { if (statSync(flat).isDirectory()) return flat; } catch { /* 落到 store */ }
  const store = pnpmStoreRoot(name);
  if (store) return store;
  // app.asar 提取副本（_research/<name 替换斜杠为 ->.js）：宿主模块在
  // profile 里是 pnpm 虚拟 store，包不直接展开，这里按提取副本兜底。
  const extracted = { "js-yaml": null, "@deepseek-ai/cordis": "cordis-index.js", "@deepseek-ai/cordis-plugin-loader": "plugin-loader-index.js", "@deepseek-ai/dsh-app-boot": "app-boot-index.js" };
  if (name in extracted && extracted[name]) return { extractedEntry: extracted[name] };
  return null;
}

/** 用包自己的 package.json（exports → main）解析出真实入口文件。 */
function packageEntry(specifier) {
  if (targetCache.has(specifier)) return targetCache.get(specifier);
  const parts = specifier.split("/");
  const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const subPath = specifier.startsWith("@") ? parts.slice(2).join("/") : parts.slice(1).join("/");
  const root = hostModuleRoot(name);
  if (!root) throw new Error(`loader redirect: package ${name} not found in profile node_modules, .pnpm store, or extracted copies`);
  // 提取副本模式：单文件就是整个包的入口。
  if (root.extractedEntry) {
    if (subPath && subPath !== "lib/index.js") throw new Error(`loader redirect: extracted copy only covers the package entry, not ${specifier}`);
    const resolved = pathToFileURL(join("D:", "桌面", "AI Port", "DSH plugins", "_research", root.extractedEntry)).href;
    targetCache.set(specifier, resolved);
    return resolved;
  }
  const pkgRoot = root;
  let resolved;
  try {
    const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
    const exportsField = manifest.exports;
    let entry = undefined;
    if (exportsField && !Array.isArray(exportsField)) {
      if (typeof exportsField === "string") entry = exportsField;
      else if (subPath && exportsField["./" + subPath]) entry = exportsField["./" + subPath];
      else if (!subPath) {
        const dot = exportsField["."];
        entry = typeof dot === "string" ? dot : dot?.default ?? dot?.import;
      } else if (exportsField["./" + subPath]) entry = exportsField["./" + subPath];
      if (entry && typeof entry === "object") entry = entry.default ?? entry.import ?? entry.node;
    }
    resolved = pathToFileURL(join(pkgRoot, entry ?? manifest.main ?? "index.js", subPath && !entry ? "" : "")).href;
  } catch {
    resolved = pathToFileURL(join(pkgRoot, subPath || "index.js")).href;
  }
  targetCache.set(specifier, resolved);
  return resolved;
}

export async function resolve(specifier, context, next) {
  const parts = specifier.split("/");
  const pkg = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (REDIRECT.has(pkg) && !specifier.startsWith("file:") && !specifier.startsWith(".")) {
    // CI/新环境：标准解析（node_modules 里有就先用）——本机 profile redirect 只是兜底。
    try {
      return await next(specifier, context);
    } catch { /* 落到 redirect */ }
    return next(packageEntry(specifier), context);
  }
  return next(specifier, context);
}

