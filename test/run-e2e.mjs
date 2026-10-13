// 端到端验证入口：注册 loader 重定向后运行 verify-e2e-compose。
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./test/loader.mjs", pathToFileURL("./"));
await import(pathToFileURL("./test/verify-e2e-compose.mjs").href);
