// 测试入口：注册 loader 重定向后运行 expert-manual。
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register("./test/loader.mjs", pathToFileURL("./"));
await import("./expert-manual.mjs");
