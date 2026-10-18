// 测试入口：注册 loader 重定向后运行指定模块（expert-manual 或 migrate-profile-patch）。
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./test/loader.mjs", pathToFileURL("./"));
// 目标白名单：audit（README 宣传数字核对）为临时只读脚本。
const targets = {
  migrate: "./test/migrate-profile-patch.mjs",
  audit: "./test/audit-market-claims.mjs",
  ymlcheck: "./test/check-submission-yml.mjs",
};
const key = process.argv[2];
const target = targets[key] ?? "./test/expert-manual.mjs";
// migrate 的 --write 参数要透传给目标模块。
if (key === "migrate") process.argv.splice(2, 1);
await import(pathToFileURL(target).href);
