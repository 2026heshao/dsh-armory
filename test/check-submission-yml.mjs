// 临时校验：投稿 yml 必须能被 yaml 解析器接受（投稿 CI 会解析它，语法错则投稿失败）。
// 由 test/run.mjs 经 loader 注册后运行：node ./test/run.mjs ymlcheck
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

// 相对本文件定位，不受 CWD 影响（run.mjs 从项目根跑，yml 在项目上一级目录）。
const here = dirname(fileURLToPath(import.meta.url));
const s = readFileSync(join(here, "..", "..", "_submission-awesome-dsh-plugin", "2026heshao__dsh-armory.yml"), "utf8");
const doc = parseDocument(s);
if (doc.errors.length) {
  console.log("FAIL  YAML 语法错误: " + doc.errors.map((e) => e.message).join("; "));
  process.exitCode = 1;
} else {
  const d = doc.toJS();
  const ok =
    d.url === "https://github.com/2026heshao/dsh-armory" &&
    d.name === "2026heshao/dsh-armory" &&
    /attach\/switch\/detach/.test(d.description.en) &&
    /随时挂上/.test(d.description.zh);
  console.log(`${ok ? "PASS" : "FAIL"}  投稿 yml 解析且含新能力描述`);
  console.log(`      category=${d.category}  en=${d.description.en.length} 字  zh=${d.description.zh.length} 字`);
  process.exitCode = ok ? 0 : 1;
}
