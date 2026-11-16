// 专家预设加载失败回归（DSH 0.2.2-rc.3）：主入口已注册 list_agents，
// 旧 /list-agents 子入口不再导出。配置进入组合树不等于插件成功挂载。
// 默认离线：真跑写链 + 临时包的 Node exports 解析，不读真实 profile。
// 可选 DSH_EXPERT_TEST_HOST_ROOT=<宿主 dsh 目录>：再验证真实宿主全部模块入口。
// 注意：入口解析不是完整 Cordis 挂载，也不能替代宿主 UI 验收。
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { isDeepStrictEqual } from "node:util";
import { parseDocument, stringify } from "yaml";
import { readExpertPresets, writeExpertPreset } from "../lib/expert-market.js";

const CONTROL = "@deepseek-ai/dsh-tool-subagent-control";
const REMOVED = `${CONTROL}/list-agents`;
const PRESET = "@deepseek-ai/dsh-agent-preset";
let checks = 0;
let failures = 0;
const ok = (name, condition, extra = "") => {
  checks += 1;
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
};
const parse = (content) => {
  const doc = parseDocument(content);
  if (doc.errors.length) throw doc.errors[0];
  return doc.toJS();
};
const walk = (rows) => rows.flatMap((row) => [row, ...(row.group ? walk(row.config) : [])]);
const presetRows = (content) => parse(content).flatMap((row) => row.insert || [row]).filter((row) => row.name === PRESET);
const validControl = (row) => {
  const plugins = walk(row.config.plugins);
  return plugins.filter((item) => item.name === CONTROL && !item.disabled).length === 1
    && !plugins.some((item) => item.name === REMOVED || item.id === "tool-subagent-list-agents");
};
const resolutionErrors = (row, resolve, onlyControl = false) => {
  const names = [...new Set(walk(row.config.plugins).map((item) => item.name))]
    .filter((name) => name !== "cordis:group" && (!onlyControl || name.startsWith(CONTROL)));
  return names.flatMap((name) => {
    try { resolve(name); return []; }
    catch (error) { return [{ name, code: error.code }]; }
  });
};
const base = [{ id: "ui-theme", name: "@deepseek-ai/dsh-client-ui-theme", config: { preference: "light" } }];
const spec = { plugin: "entry-regression", displayName: "入口回归专家", profession: "开发", description: "", personaText: "# 专家\n原始人设与中文内容\n" };
const fresh = writeExpertPreset(stringify(base), spec);
const current = presetRows(fresh.content)[0];
const old = structuredClone(current);
old.config.name = "用户自定义名称";
old.config.plugins.find((row) => row.id === "delegation").config.push({ id: "tool-subagent-list-agents", name: REMOVED });
const oldOther = structuredClone(old);
oldOther.id = "preset-wbexpert-unrelated";
oldOther.config.id = "wbexpert-unrelated";
// 与生产写侧一致：每位专家各占一条 insert 指令。
const oldContent = stringify([...base, { insert: [old] }, { insert: [oldOther] }]);
const updatedSpec = { ...spec, personaText: "# 专家\n更新后的人设\n" };
const updated = writeExpertPreset(oldContent, updatedSpec);
const legacy = writeExpertPreset(stringify([...base, old]), updatedSpec);
const repeated = writeExpertPreset(updated.content, updatedSpec);
const local = writeExpertPreset(stringify(base), { ...spec, source: "local" });
const cases = [
  ["新建", fresh, spec], ["更新旧预设", updated, updatedSpec],
  ["旧裸条目迁移", legacy, updatedSpec], ["重复更新", repeated, updatedSpec], ["本机专家", local, spec],
];

for (const [label, result, expected] of cases) {
  const row = presetRows(result.content).find((item) => item.id === current.id);
  ok(`${label}：只保留一个控制主入口，不再写失效子入口`, validControl(row));
  ok(`${label}：行 id 与预设 id 不变`, row.id === current.id && row.config.id === current.config.id);
  ok(`${label}：人设完整保留`, readExpertPresets(result.content).find((item) => item.plugin === spec.plugin)?.personaText === expected.personaText);
  ok(`${label}：无关顶层配置未变`, isDeepStrictEqual(parse(result.content)[0], base[0]));
  const plugins = walk(row.config.plugins);
  ok(`${label}：委派工具、工作流和人设没有随入口一起删除`, ["persona", "tool-subagent", "tool-subagent-fork", "workflow-ptc", "tool-workflow"].every((id) => plugins.some((item) => item.id === id)));
}
ok("新建返回 inserted，其余更新返回 updated", fresh.mode === "inserted" && [updated, legacy, repeated].every((result) => result.mode === "updated"));
ok("更新保留用户改过的预设名称", presetRows(updated.content)[0].config.name === old.config.name);
ok("更新不改另一位专家（不能偷偷全局迁移）", isDeepStrictEqual(presetRows(updated.content)[1], oldOther));
ok("重复更新幂等", repeated.content === updated.content);
ok("裸条目迁移进入 insert，而非顶层裸条目", parse(legacy.content).some((row) => row.insert?.some((entry) => entry.id === current.id)));
ok("反向自测：把旧入口注回，结构护栏必须失败", !validControl(old));

const dir = await mkdtemp(join(tmpdir(), "dsh-expert-entry-"));
try {
  // 只复制当前宿主的 exports 边界，不冒充完整宿主或假装已加载工具。
  const pkg = join(dir, "node_modules", "@deepseek-ai", "dsh-tool-subagent-control");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: CONTROL, type: "module", exports: { ".": "./index.js" } }));
  await writeFile(join(pkg, "index.js"), "export {};\n");
  const req = createRequire(join(dir, "package.json"));
  for (const [label, result] of cases) {
    const row = presetRows(result.content).find((item) => item.id === current.id);
    const errors = resolutionErrors(row, req.resolve, true);
    ok(`${label}：真 Node exports 边界通过`, errors.length === 0, JSON.stringify(errors));
  }
  const errors = resolutionErrors(old, req.resolve, true);
  ok("反向自测：旧入口真抛 ERR_PACKAGE_PATH_NOT_EXPORTED", errors.length === 1 && errors[0].name === REMOVED && errors[0].code === "ERR_PACKAGE_PATH_NOT_EXPORTED", JSON.stringify(errors));
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (process.env.DSH_EXPERT_TEST_HOST_ROOT) {
  const req = createRequire(join(process.env.DSH_EXPERT_TEST_HOST_ROOT, "package.json"));
  for (const [label, result] of cases) {
    const row = presetRows(result.content).find((item) => item.id === current.id);
    const errors = resolutionErrors(row, req.resolve);
    ok(`${label}：真实宿主全部模块入口可解析（不等于完整挂载）`, errors.length === 0, JSON.stringify(errors));
  }
} else {
  console.log("SKIP  真实宿主入口解析：未指定 DSH_EXPERT_TEST_HOST_ROOT；离线护栏已运行");
}
console.log(`\n${failures ? "FAIL" : "PASS"}  expert-preset-entries：${checks} 项断言，${failures} 项失败`);
process.exitCode = failures ? 1 : 0;
