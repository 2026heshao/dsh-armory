// 部署后自检：运行时副本能 import、能吃已有缓存（不发新请求），并报告缓存实际状态。
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const RUN = join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "dsh-armory", "lib");
const mod = await import(pathToFileURL(join(RUN, "npm-downloads.js")).href);
const cachePath = join(homedir(), ".dsh", "armory", "npm-downloads.json");
const raw = JSON.parse(await readFile(cachePath, "utf8"));
const rows = Object.values(raw.packages);
const withData = rows.filter((r) => r.data && typeof r.data.downloads === "number");
const missing = rows.filter((r) => r.missing);
console.log(`缓存：version=${raw.version} unavailableUntil=${raw.unavailableUntil ? new Date(raw.unavailableUntil).toISOString() : "无"} 条目=${rows.length}（有值 ${withData.length} / 确认没有 ${missing.length}）`);
console.log(`下载量区间：${Math.min(...withData.map(r => r.data.downloads))} … ${Math.max(...withData.map(r => r.data.downloads))}`);
// 用缓存里已有的包名调用：命中缓存 → 零外网（联网次数应为 0）
let net = 0;
const out = await mod.wbNpmDownloads({ packages: withData.slice(0, 5).map(r => r.data.package) }, {
  fetchImpl: async () => { net += 1; throw new Error("不该联网"); },
});
console.log(`命中检查：外网请求=${net} 取值=${Object.values(out.packages).map(p => `${p.package}:${p.downloads}${p.cached ? "(缓存)" : ""}`).join(" ")}`);
