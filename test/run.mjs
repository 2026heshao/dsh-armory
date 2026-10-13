// 测试入口：注册 loader 重定向后运行指定模块（expert-manual 或 migrate-profile-patch）。
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./test/loader.mjs", pathToFileURL("./"));
const target = process.argv[2] === "migrate" ? "./test/migrate-profile-patch.mjs" : "./test/expert-manual.mjs";
// migrate 的 --write 参数要透传给目标模块。
if (process.argv[2] === "migrate") process.argv.splice(2, 1);
await import(pathToFileURL(target).href);
