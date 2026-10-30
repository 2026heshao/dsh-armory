// issue #3 回归：本地客户端型连接器（NVIDIA App）的本机固定依赖预检。
//
// 背景：nvapp-windows-local 的 mcp.json 把本机桥接程序写死在 `cmd.exe /d /c <path>` 里。
// 旧实现只校验「配置形状可导入」，缺这个程序也照写配置，宿主随后重连 10 次才注销工具，
// 用户只看得到一行「mcp 连接失败」。这里钉住三件事：
//   ① 只认显式绝对路径（cmd /c、sh -c、直接绝对 command），不把 npx 包名/数据路径误判成依赖；
//   ② `${...}` 未求值时不猜；transport 对象形态要解包；
//   ③ 状态检查区分 found / missing / platform，并按路径去重。
//
// 全程只读：不联网、不 spawn、不写盘、不碰真实 ~/.dsh。
import { localExecutablePathsOf, connectorLocalDeps } from "../lib/wb-market.js";

let failures = 0;
const ok = (name, condition, extra = "") => {
  if (!condition) failures += 1;
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const nvidia = {
  type: "stdio",
  command: "cmd.exe",
  args: [
    "/d",
    "/c",
    "C:\\Program Files\\NVIDIA Corporation\\NVIDIA App\\McpServer\\NvAppMcpServer.exe",
  ],
};
const nvidiaPath = "C:\\Program Files\\NVIDIA Corporation\\NVIDIA App\\McpServer\\NvAppMcpServer.exe";

console.log("== 1. 路径识别（只认固定本机程序）==");
ok("1a cmd /d /c 包装取目标路径", same(localExecutablePathsOf(nvidia), [nvidiaPath]));
ok(
  "1b 直接绝对 command",
  same(localExecutablePathsOf({ command: "C:\\Tools\\local-mcp.exe" }), ["C:\\Tools\\local-mcp.exe"]),
);
ok("1c 绝对 cmd.exe 只看 /c 目标", same(localExecutablePathsOf({
  command: "C:\\Windows\\System32\\cmd.exe",
  args: ["/d", "/c", "C:\\Tools\\local-mcp.exe"],
}), ["C:\\Tools\\local-mcp.exe"]));
ok("1d 裸 cmd.exe 没有 /c 目标时不误判", same(localExecutablePathsOf({ command: "cmd.exe", args: ["/d"] }), []));
ok(
  "1e npx 包名不误判",
  same(localExecutablePathsOf({ command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "."] }), []),
);
ok(
  "1f npx 的数据路径不误判（不是 shell 包装）",
  same(localExecutablePathsOf({ command: "npx", args: ["-y", "some-tool", "C:\\data\\notes.txt"] }), []),
);
ok(
  "1g sh -c 包装取目标路径",
  same(localExecutablePathsOf({ command: "sh", args: ["-c", "/opt/local-mcp/bin/server"] }), ["/opt/local-mcp/bin/server"]),
);
ok(
  "1h ${...} 未求值时不猜",
  same(localExecutablePathsOf({ command: "cmd.exe", args: ["/c", "${LOCAL_MCP_EXE}"] }), []),
);
ok(
  "1i transport 对象形态解包",
  same(localExecutablePathsOf({ transport: { type: "stdio", command: "cmd.exe", args: ["/c", nvidiaPath] } }), [nvidiaPath]),
);
ok("1j http 型不参与本机依赖", same(localExecutablePathsOf({ type: "http", url: "https://example.com/mcp" }), []));

console.log("== 2. 状态检查 ==");
const found = await connectorLocalDeps({ one: { command: process.execPath } });
ok("2a 当前解释器判定 found", found.length === 1 && found[0].status === "found", JSON.stringify(found));

const missingPath = "C:\\__dsh_armory_missing_dependency__\\nope.exe";
const missing = await connectorLocalDeps({ one: { command: missingPath } });
const expectedMissingStatus = process.platform === "win32" ? "missing" : "platform";
ok(
  `2b 不存在的 Windows 路径在 ${process.platform} 上判 ${expectedMissingStatus}`,
  missing.length === 1 && missing[0].status === expectedMissingStatus,
  JSON.stringify(missing),
);

const posix = await connectorLocalDeps({ one: { command: "/__dsh_armory_missing_dependency__/nope" } });
const expectedPosixStatus = process.platform === "win32" ? "platform" : "missing";
ok(
  `2c 不存在的 POSIX 路径在 ${process.platform} 上判 ${expectedPosixStatus}`,
  posix.length === 1 && posix[0].status === expectedPosixStatus,
  JSON.stringify(posix),
);

const deduped = await connectorLocalDeps({
  first: { command: process.execPath },
  second: { command: "cmd.exe", args: ["/c", process.execPath] },
});
ok("2d 同一路径只查一次", deduped.length === 1 && deduped[0].status === "found", JSON.stringify(deduped));

const empty = await connectorLocalDeps({ remote: { type: "http", url: "https://example.com/mcp" } });
ok("2e 没有固定依赖时为空数组", empty.length === 0);

console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
