// MCP 配置层的回归套件（OPT-09 第二套件）：lib/mcp-config.js + lib/env-expression.js。
//
// 为什么必须有它：这个模块是**唯一**把「用户粘贴的 JSON / 别家客户端的配置」翻译成 DSH
// patch 条目的地方。它出错的表现不是崩溃，而是「静默少一条 server」「密钥字段被悄悄丢掉」
// 「同名条目把整份配置卡死」——这些都不是 jsdom 或手测能稳定发现的。
//
// 依赖边界（有意为之）：本套件只 import mcp-config.js 及其零裸依赖的下游
// （env-expression.js），所以只需要 `yaml`。**TOML 一侧不在本套件**：
// mcp-import-sources.js 顶层 import 'smol-toml'，而本仓库的 devDependencies 并不安装它
// （它是宿主的 peer），装了也只会在 CI 上缺。那一侧由 upgrade-plan / 宿主侧用例覆盖。
//
// 用法：node ./test/mcp-config.mjs
import {
  normalizeMcpImport,
  duplicateServerNames,
  readManagedMcpServers,
  setManagedMcpDisabled,
  updateManagedMcpPatch,
} from "../lib/mcp-config.js";

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const skip = (name, why) => console.log(`SKIP  ${name}  ${why}`);

/** 断言抛出，且消息匹配。只断言「抛了」会放过错误类型退化。 */
function throws(name, fn, pattern) {
  try {
    fn();
    ok(name, false, "预期抛错但没有抛");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ok(name, pattern.test(message), pattern.test(message) ? "" : `消息不匹配：${message}`);
  }
}

const one = (servers) => normalizeMcpImport({ mcpServers: servers }).servers[0];

// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── 1. 导入入口的拒绝面 ──");
// ══════════════════════════════════════════════════════════════════════════════
// 这些分支的共同点是「宁可报错也不猜」：猜错的代价是配置看起来导入成功、实际连不上。
throws("JSON 根节点不是对象就拒绝", () => normalizeMcpImport([]), /根节点必须是对象/);
throws("同时含 mcpServers 与 servers 就拒绝", () => normalizeMcpImport({ mcpServers: {}, servers: {} }), /无法确定应导入哪一组/);
throws("两组都没有就拒绝", () => normalizeMcpImport({ foo: 1 }), /没有找到 mcpServers 或 servers/);
throws("VS Code inputs 需要交互，拒绝", () => normalizeMcpImport({ inputs: [{ id: 'x' }], servers: {} }), /需要交互式取值/);
throws("command 与 url 并存就拒绝", () => one({ a: { command: 'x', url: 'https://x.test' } }), /同时包含 command 和 url/);
throws("sse 传输拒绝（当前 DSH 不支持）", () => one({ a: { url: 'https://x.test/sse', type: 'sse' } }), /不受当前 DSH MCP 配置支持/);
throws("ws 传输拒绝", () => one({ a: { url: 'wss://x.test', type: 'ws' } }), /不受当前 DSH MCP 配置支持/);
throws("envFile 无法安全转换，拒绝", () => one({ a: { command: 'x', envFile: '.env' } }), /envFile 在 DSH MCP 配置中不支持/);
throws("oauth 无法安全转换，拒绝", () => one({ a: { url: 'https://x.test', oauth: {} } }), /oauth 在 DSH MCP 配置中不支持/);
throws("serverName 含空格拒绝", () => one({ 'has space': { command: 'x' } }), /不符合 DSH serverName 格式/);
throws("serverName 超 32 字符拒绝", () => one({ ['a'.repeat(33)]: { command: 'x' } }), /不符合 DSH serverName 格式/);
throws("stdio 缺 command 拒绝", () => one({ a: { transport: 'stdio' } }), /缺少 command/);
throws("HTTP 缺 url 拒绝", () => one({ a: { transport: 'streamable-http' } }), /需要 http\(s\):\/\/ URL/);
throws("url 不是 http(s) 拒绝", () => one({ a: { url: 'ftp://x.test' } }), /需要有效的 http\(s\):\/\/ URL/);
throws("args 含非字符串拒绝", () => one({ a: { command: 'x', args: ['ok', 1] } }), /args 必须全部是字符串/);
throws("toolCallTimeoutMs 非正整数拒绝", () => one({ a: { command: 'x', toolCallTimeoutMs: 0 } }), /toolCallTimeoutMs 必须是正整数/);
throws("reconnect.initialDelayMs > maxDelayMs 拒绝", () => one({ a: { command: 'x', reconnect: { initialDelayMs: 10, maxDelayMs: 5 } } }), /不能大于 maxDelayMs/);
throws("reconnect.maxAttempts 非正整数拒绝", () => one({ a: { command: 'x', reconnect: { maxAttempts: 0 } } }), /maxAttempts 必须是正整数/);
throws("failOnStartupError 非布尔拒绝", () => one({ a: { command: 'x', failOnStartupError: 'yes' } }), /failOnStartupError 必须是布尔值/);

// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── 2. 别家客户端变量：能转的转，不能转的明确拒绝 ──");
// ══════════════════════════════════════════════════════════════════════════════
// 这一段守的是「密钥不进浏览器」与「缺失变量不能把宿主拖下水」两条不变量：
// 所有 env 引用都必须变成带 `?? ""` 的总值表达式。
ok("${VAR} 转成带空串兜底的表达式", one({ a: { command: 'x', env: { K: '${K}' } } }).env.K === '!!js (process.env.K ?? "")');
ok("${VAR:-dflt} 保留兜底值", one({ a: { command: 'x', env: { K: '${K:-dflt}' } } }).env.K === '!!js (process.env.K ?? "dflt")');
ok("${env:VAR} 与 ${VAR} 等价", one({ a: { command: 'x', env: { K: '${env:K}' } } }).env.K === '!!js (process.env.K ?? "")');
ok("插值出现在串中间时产出的仍是总值表达式",
  one({ a: { url: 'https://x.test/mcp?k=${KEY:-dflt}' } }).url === '!!js "https://x.test/mcp?k=" + (process.env.KEY ?? "dflt")',
  one({ a: { url: 'https://x.test/mcp?k=${KEY:-dflt}' } }).url);
ok("args 里的环境变量同样转换", one({ a: { command: 'x', args: ['${env:ARG}'] } }).args[0] === '!!js (process.env.ARG ?? "")');
ok("合法 !!js 表达式原样保留", one({ a: { command: 'x', env: { K: '!!js (process.env.K ?? "")' } } }).env.K === '!!js (process.env.K ?? "")');
// 历史模板写法只认 `${process.env.X}` 这一种变量语法（normalizeLegacyTemplate 的正则）。
// 把整个 JS 表达式塞进反引号是不接受的——这条断言存在的意义就是别让人以为它也支持。
ok("!!js 模板写法（${process.env.X}）被规范化成总值表达式",
  one({ a: { command: 'x', env: { K: '!!js `${process.env.K}`' } } }).env.K === '!!js (process.env.K ?? "")');
ok("模板里带前后缀时拼成完整表达式",
  one({ a: { command: 'x', env: { K: '!!js `pre-${process.env.K}-post`' } } }).env.K
  === '!!js "pre-" + (process.env.K ?? "") + "-post"');
throws("反引号里直接写 JS 表达式不算合法模板，拒绝",
  () => one({ a: { command: 'x', env: { K: '!!js `process.env.K ?? ""`' } } }), /只允许受限的 process\.env/);
throws("${workspaceFolder} 是别家变量，拒绝而不是猜", () => one({ a: { command: '${workspaceFolder}/b' } }), /是其他客户端变量/);
throws("${userHome} 是别家变量，拒绝", () => one({ a: { command: 'x', args: ['${userHome}/y'] } }), /是其他客户端变量/);
throws("非法 !!js （非 process.env 形态）拒绝", () => one({ a: { command: 'x', env: { K: '!!js require("fs")' } } }), /只允许受限的 process\.env/);
// 错误消息不能回显用户配置片段：那段文本含密钥，而且错误会经 RPC 送进浏览器。
// 注意只有「不是合法变量名」的插值才会抛（`${SECRET}${nope}` 是两条合法插值，能正常转换）；
// `${1bad}` 起头不是字母，正则不认，于是留在字面量里成了残留的 `${`。
try {
  one({ a: { command: 'x', args: ['${SECRET_TOKEN_ABC}${1bad}'] } });
  ok("拒绝消息不回显用户片段", false, "预期抛错但没有抛");
} catch (error) {
  ok("拒绝消息不回显用户片段", !error.message.includes('SECRET_TOKEN_ABC'), error.message);
}

// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── 3. 归一化产物：字段该留的留、该丢的丢 ──");
// ══════════════════════════════════════════════════════════════════════════════
ok("serverName 优先于对象键名", one({ key: { serverName: 'real', command: 'x' } }).name === 'real');
ok("名子两端空白被裁掉", one({ ' a ': { command: 'x' } }).name === 'a');
ok("type: http 归一成 streamable-http", one({ a: { url: 'https://x.test', type: 'http' } }).transport === 'streamable-http');
ok("嵌套 transport 对象被展开",
  JSON.stringify(one({ a: { transport: { type: 'stdio', command: 'npx' } } })) === JSON.stringify({ name: 'a', transport: 'stdio', command: 'npx' }));
ok("顶层单条配置（无 mcpServers）也能导入",
  normalizeMcpImport({ command: 'npx', args: ['p'] }).servers[0].name === 'mcp-server');
ok("args 是字符串时整体保留为一个参数，不按 shell 拆",
  JSON.stringify(one({ a: { command: 'x', args: '--a --b' } }).args) === JSON.stringify(['--a --b']));
const envWarned = normalizeMcpImport({ mcpServers: { a: { command: 'x', env: { N: 42, Z: null } } } });
ok("env 非字符串值被转成字符串并告警",
  envWarned.servers[0].env.N === '42' && envWarned.servers[0].env.Z === ''
  && envWarned.warnings.some((w) => w.includes('N')) && envWarned.warnings.some((w) => w.includes('Z')));
const otherClient = normalizeMcpImport({ mcpServers: { a: { command: 'x', alwaysAllow: [], unknownField: 1 } } });
ok("别家客户端字段只告警、不落盘",
  !('alwaysAllow' in otherClient.servers[0])
  && otherClient.warnings.some((w) => w.includes('alwaysAllow'))
  && otherClient.warnings.some((w) => w.includes('unknownField')));
ok("directTools: true 翻译成 disabled: false", one({ a: { command: 'x', directTools: true } }).disabled === false);
ok("directTools: false 翻译成 disabled: true", one({ a: { command: 'x', directTools: false } }).disabled === true);
ok("空 cwd 不保留（空串等于没配）", !('cwd' in one({ a: { command: 'x', cwd: '' } })));
ok("空 args 不保留", !('args' in one({ a: { command: 'x', args: [] } })));
ok("空 headers 不保留", !('headers' in one({ a: { url: 'https://x.test', headers: {} } })));

const warnsOnTimeout = normalizeMcpImport({ mcpServers: { a: { command: 'x', timeout: 1000 } } });
ok("timeout 不自动换算，只提示用 toolCallTimeoutMs",
  !('toolCallTimeoutMs' in warnsOnTimeout.servers[0]) && warnsOnTimeout.warnings.some((w) => w.includes('toolCallTimeoutMs')));

// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── 4. 重名检测：只在归一化之后才能看见 ──");
// ══════════════════════════════════════════════════════════════════════════════
// ' a ' 与 'a' 归一化后是同一个名字——检测要发生在 trim 之后，否则会漏。
const collided = normalizeMcpImport({ mcpServers: { ' a ': { command: 'x' }, a: { command: 'y' } } }).servers;
ok("trim 后才撞名的两条能被检出", JSON.stringify(duplicateServerNames(collided)) === JSON.stringify(['a']));
ok("没有重名时返回空数组", duplicateServerNames([{ name: 'a' }, { name: 'b' }]).length === 0);
ok("三条同名只报一次", JSON.stringify(duplicateServerNames([{ name: 'a' }, { name: 'a' }, { name: 'a' }])) === JSON.stringify(['a']));

// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── 5. patch 往返：写出去的东西读回来必须一模一样 ──");
// ══════════════════════════════════════════════════════════════════════════════
const fullSpec = {
  name: 'demo',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'some-mcp'],
  env: { TOKEN: '!!js `process.env.MCP_TOKEN ?? ""`', EMPTY: '' },
  toolCallTimeoutMs: 60000,
  failOnStartupError: false,
  reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 5000, maxAttempts: 3 },
};
const patch = updateManagedMcpPatch('', [fullSpec]);
const roundtrip = readManagedMcpServers(patch).servers;
// 分层语义：patch 读写是**纯载体**（写什么读什么，不做规范化），规范化只发生在
// normalizeMcpImport。分开断言两层，才不会把「载体原样」误判成「往返丢了转换」。
ok("全字段往返无损（patch 层是纯载体，不做规范化）",
  JSON.stringify(roundtrip) === JSON.stringify([fullSpec]), JSON.stringify(roundtrip));
// 规范化那一层用模板写法当输入（反引号里塞 JS 表达式是**不合法**的写法，见第 2 节），
// 两层的输入本来就不同：patch 层存的是已规范化的结果，用户配置里写的才是模板。
const templated = { ...fullSpec, env: { TOKEN: '${MCP_TOKEN}', EMPTY: '' } };
const pipelined = normalizeMcpImport({ mcpServers: { demo: templated } }).servers[0];
ok("经 normalizeMcpImport 后模板写法被规范化成总值表达式",
  pipelined.env.TOKEN === '!!js (process.env.MCP_TOKEN ?? "")', pipelined.env.TOKEN);
ok("规范化后的结果再走 patch 往返仍然不变",
  JSON.stringify(readManagedMcpServers(updateManagedMcpPatch('', [pipelined])).servers) === JSON.stringify([pipelined]));
ok("空 patch 也能写入（0 字节文件是合法的）", updateManagedMcpPatch('', [{ name: 'z', transport: 'stdio', command: 'c' }]).includes('serverName: z'));
ok("再次写入同一 spec 是幂等的（字节完全一致）", updateManagedMcpPatch(patch, [fullSpec]) === patch);

const ids = readManagedMcpServers(patch).entryIds;
ok("entryIds 按 serverName 回传", ids.demo === 'mcp-demo');

const disabledPatch = setManagedMcpDisabled(patch, 'demo', true);
ok("置 disabled 后读得出来", readManagedMcpServers(disabledPatch).servers[0].disabled === true);
ok("取消 disabled 后字段被删掉（而不是写 false）",
  !('disabled' in readManagedMcpServers(setManagedMcpDisabled(disabledPatch, 'demo', false)).servers[0]));
throws("给不存在的 server 置 disabled 会明确报错", () => setManagedMcpDisabled(patch, 'nope', true), /没有可管理的 MCP/);

// 注释、非 MCP 条目都必须原样留住——用户手写过的东西不能被插件吃掉。
const withComment = '# 头部注释\n- insert:\n    - id: keep-me\n      name: other\n';
const appended = updateManagedMcpPatch(withComment, [{ name: 'n', transport: 'stdio', command: 'c' }]);
ok("补新条目时保留文件头部注释", appended.startsWith('# 头部注释'));
ok("补新条目时保留非 MCP 条目", appended.includes('name: other') && appended.includes('keep-me'));
ok("补进去的条目能被读回", JSON.stringify(readManagedMcpServers(appended).servers.map((s) => s.name)) === JSON.stringify(['n']));

// 本次修复的缺陷：以前 `contents: null` 被当成「不是 YAML 列表」直接抛错，而 0 字节
// 与只有注释的 patch 在语法上完全合法。抛在这里等于 managedState 整块失败、MCP 面板全白。
// （lib/mcp-config.js 的 parsePatch 现在会补一个空 seq。）
for (const [label, content] of [['空串', ''], ['只有换行', '\n'], ['只有注释', '# only a comment\n']]) {
  let read;
  try {
    read = readManagedMcpServers(content);
  } catch {
    // 这里刻意吞掉原因：断言只关心「有没有抛」，抛了什么由下面那条 ok 的失败信息体现。
    read = null;
  }
  ok(`${label}的 patch 被当成空列表而不是报错`,
    read !== null && read.servers.length === 0 && Object.keys(read.entryIds).length === 0);
  const written = updateManagedMcpPatch(content, [{ name: 'z', transport: 'stdio', command: 'c' }]);
  ok(`${label}的 patch 可以追加条目且原注释保留`,
    JSON.stringify(readManagedMcpServers(written).servers.map((s) => s.name)) === JSON.stringify(['z'])
    && (content.trim().startsWith('#') ? written.includes('# only a comment') : true));
}

throws("真正的语法错误仍然要报错（不能靠上面的兜底掩盖）",
  () => readManagedMcpServers('a: [unclosed'), /无法解析/);
throws("YAML 是映射而不是列表时要报错", () => readManagedMcpServers('a: 1'), /必须是 YAML 列表/);

// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── 6. 增删语义：replace / removeNames / reservedIds ──");
// ══════════════════════════════════════════════════════════════════════════════
const twoServers = updateManagedMcpPatch('', [
  { name: 'keep', transport: 'stdio', command: 'k' },
  { name: 'drop', transport: 'stdio', command: 'd' },
]);
ok("replace: true 会连同未列出的条目一起清掉",
  JSON.stringify(readManagedMcpServers(updateManagedMcpPatch(twoServers, [{ name: 'keep', transport: 'stdio', command: 'k2' }], { replace: true })).servers.map((s) => s.name)) === JSON.stringify(['keep']));
ok("removeNames 精确删除一条",
  JSON.stringify(readManagedMcpServers(updateManagedMcpPatch(twoServers, [], { removeNames: ['drop'] })).servers.map((s) => s.name)) === JSON.stringify(['keep']));
// 删光所有条目后，那个只剩 insert 的空壳条目也要一起消失，否则 patch 文件里会留下一堆空壳。
const emptied = updateManagedMcpPatch(twoServers, [], { removeNames: ['keep', 'drop'] });
ok("删空后不留下空壳 insert 条目", !emptied.includes('insert:'), JSON.stringify(emptied));
ok("reservedIds 占用的 id 会被跳过",
  updateManagedMcpPatch('', [{ name: 'a', transport: 'stdio', command: 'c' }], { reservedIds: ['mcp-a'] }).includes('id: mcp-a-2'));
// 同名条目重复写入时 id 要递增，否则宿主加载时会因为 id 撞车而报错。
const twice = updateManagedMcpPatch('', [
  { name: 'x', transport: 'stdio', command: 'c' },
  { name: 'x', transport: 'stdio', command: 'd' },
]);
ok("同名条目重复写入时 id 递增", twice.includes('id: mcp-x') && twice.includes('id: mcp-x-2'));
// 上游 admitImportedServers 会先去重，所以真实路径到不了这里；但读回口必须拒绝，
// 免得手改文件造成的重名被静默当成「最后一条赢」。
throws("重名 patch 读回时拒绝（不静默取其一）", () => readManagedMcpServers(twice), /存在重复 serverName/);

// idleTimeoutMs / readyTimeoutMs 是**项目级**字段，刻意不进全局 patch：写进 profile
// patch 等于把它泄漏成全局策略。这条断言把「刻意不写」和「忘了写」区分开。
const projectOnly = one({ p: { command: 'x', idleTimeoutMs: 0, readyTimeoutMs: 5000 } });
ok("项目级字段在归一化时保留", projectOnly.idleTimeoutMs === 0 && projectOnly.readyTimeoutMs === 5000);
ok("项目级字段不会落进全局 patch",
  JSON.stringify(readManagedMcpServers(updateManagedMcpPatch('', [projectOnly])).servers)
  === JSON.stringify([{ name: 'p', transport: 'stdio', command: 'x' }]));

// ══════════════════════════════════════════════════════════════════════════════
console.log("\n── 8. Codex TOML 来源：别家客户端的字段迁移 ──");
// ══════════════════════════════════════════════════════════════════════════════
// 这一节**依赖 smol-toml**：本地 profile 的 node_modules 里有（宿主带下来的），但本仓库
// 的 devDependencies 与 CI 的安装清单里都没有。所以「能 import 就跑、不能就 SKIP」——
// CI 上少一层覆盖但不会误红，本地开发时始终有覆盖。
//
// 为什么值得单独覆盖：Codex 的 TOML 是**唯一**一条源格式不是 JSON 的导入路径，而它的
// 三处转换只有真跑才看得见——`bearer_token_env_var` 要拼成 Authorization 头、
// `env_http_headers` 的值要换成 `${VAR}` 引用、`tool_timeout_sec` 要从秒换成毫秒。
// 任何一处写反，用户导入后的表现都不是崩溃，而是「能连上但每个请求 401」或
// 「超时时间差 1000 倍」——两种都不会在界面上留下任何线索。
let sources = null;
let sourcesWhy = "";
try {
  const { register } = await import("node:module");
  register("./loader.mjs", import.meta.url);
  sources = await import("../lib/mcp-import-sources.js");
} catch (error) {
  sourcesWhy = `缺少 smol-toml（${error?.code || error?.message}）`;
}

if (sources === null) {
  skip("Codex TOML 来源的字段迁移", sourcesWhy);
} else {
  const codex = sources.IMPORT_SOURCES.find((s) => s.id === "codex");
  const convert = (lines) => sources.normalizeSourceText(codex, lines.join("\n"), "toml");

  const stdio = convert([
    "[mcp_servers.demo]",
    'command = "npx"',
    'args = ["-y", "demo-mcp"]',
    "tool_timeout_sec = 45",
    "enabled = false",
  ]);
  ok("Codex stdio 条目正常转换",
    stdio.error === "" && stdio.entries.length === 1 && stdio.entries[0].spec?.command === "npx");
  ok("Codex tool_timeout_sec 由秒换算成毫秒", stdio.entries[0].spec?.toolCallTimeoutMs === 45000);
  ok("Codex enabled=false 映射成 disabled=true", stdio.entries[0].spec?.disabled === true);

  const remote = convert([
    "[mcp_servers.remote]",
    'url = "https://x.test/mcp"',
    'bearer_token_env_var = "MY_TOKEN"',
    "",
    "[mcp_servers.remote.env_http_headers]",
    'X-Api-Key = "MY_KEY"',
  ]);
  const headers = remote.entries[0].spec?.headers ?? {};
  // 断言精确形态而不只是「含 MY_TOKEN」：这个值最终会被当作代码求值，
  // 少一对括号或漏掉 `?? ""` 都会在运行时变成另一件事。
  ok("Codex bearer_token_env_var 拼成受限表达式而不是明文 token",
    headers.Authorization === '!!js "Bearer " + (process.env.MY_TOKEN ?? "")');
  ok("Codex env_http_headers 的值转成环境变量引用",
    headers["X-Api-Key"] === '!!js (process.env.MY_KEY ?? "")');

  const both = convert(["[mcp_servers.bad]", 'command = "npx"', 'url = "https://x.test/mcp"']);
  ok("Codex 同时配 command 与 url 报条目级错误",
    both.error === "" && both.entries[0].spec === null
    && /同时配置了 command 和 url/.test(both.entries[0].error));

  const empty = convert(["[mcp_servers.empty]", 'note = "hi"']);
  ok("Codex 既无 command 也无 url 报条目级错误",
    empty.entries[0].spec === null && /既没有 command 也没有 url/.test(empty.entries[0].error));

  // 逐条容错：一条坏条目不能吞掉整份配置（用户往往只配错了一个 server）。
  const mixed = convert([
    "[mcp_servers.good]",
    'command = "npx"',
    "",
    "[mcp_servers.bad]",
    'note = "x"',
  ]);
  ok("Codex 一条坏条目不吞掉其余条目",
    mixed.entries.length === 2 && mixed.entries[0].spec !== null && mixed.entries[1].spec === null);

  const unknown = convert([
    "[mcp_servers.demo]",
    'command = "npx"',
    'env_vars = ["A"]',
    "weird_field = 1",
  ]);
  const notes = unknown.entries[0].warnings.join("\n");
  ok("Codex 已知但无对应项的字段逐个点名（用户以为带过来了）",
    /env_vars（环境变量透传白名单）/.test(notes));
  ok("Codex 未识别字段也点名而不是静默丢弃",
    /weird_field 不是 Codex 为 stdio 传输定义的字段/.test(notes));

  ok("Codex 配置里没有 mcp_servers 时给出整份级提示",
    convert(["[other]", 'key = "v"']).error === "没有找到该客户端使用的 MCP 段落");

  // 解析失败的 message 绝不能进界面：smol-toml 会把出错那一行原文贴出来，
  // 而这段文本来自用户机器上的配置文件，里面常有密钥。只留行号。
  const broken = convert(["command = "]);
  ok("非法 TOML 只报行号、不回显原文",
    broken.error === "不是合法 TOML（第 1 行附近）" && !broken.error.includes("command"));
}

// ══════════════════════════════════════════════════════════════════════════════
console.log(failures === 0 ? "\nMCP-CONFIG PASS" : `\nMCP-CONFIG FAIL（${failures} 项）`);
process.exitCode = failures === 0 ? 0 : 1;
