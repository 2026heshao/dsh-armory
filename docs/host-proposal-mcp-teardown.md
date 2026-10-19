# 上游提案：stdio MCP transport 的 teardown 上界

这份文档回答一个问题：**Windows 上「MCP 子进程回收卡住」这件事，根因在哪一层的哪一行，该由谁修、修成什么样。**

它是给 `@modelcontextprotocol/client`（下文简称上游）维护者的技术提案，不是本插件的使用说明。日常使用请看 [README](../README.md) 与 [项目 MCP 生命周期](project-mcp-lifecycle.md)。

- [问题陈述](#问题陈述)
- [上游现状（贴证据）](#上游现状贴证据)
- [可复现条件](#可复现条件)
- [建议方案](#建议方案按优先级)
- [对本项目的影响](#对本项目的影响)
- [临时缓解（本侧已做）](#临时缓解本侧已做)

## 问题陈述

Windows 上，stdio 传输的 MCP server 常常**自己再拉起子进程**：`npx` / `uvx` 这类包装器本身就是「一个 JS 进程去起真正的 server」，很多 server 内部还会再 spawn 语言运行时、helper、语言服务器。这些**孙进程默认继承父进程的标准句柄**，包括上游建的那两根管道（`stdin` / `stdout`）。

于是出现下面这条因果链：

1. 宿主决定回收某条连接，调 `transport.close()`。
2. `close()` 结束子进程的 `stdin` 并等 `'close'` 事件。
3. `'close'` 的语义不是「进程结束了」，而是「**进程结束了、且它的全部 stdio 流都关闭了**」。
4. 孙进程仍持有那两根管道的写端/读端，流就关不掉，`'close'` 永远不来。
5. 回收方一直在等。宿主侧看到的是「这条连接在释放中」，但没有上界、没有进度、没有错误——只是不动了。

后果不是「慢一点」：插件卸载、会话销毁、配置热更新全部挂在这一步后面。用户能观察到的现象是**面板停止响应、改配置不生效、退出宿主时进程残留**，而日志里一条错误都没有——因为根本没有错误，只有一个永远 pending 的 promise。

## 上游现状（贴证据）

证据版本：`@modelcontextprotocol/client@2.0.0`，`dist/stdio.mjs`。

### 1. `spawn` 没有建进程组

`dist/stdio.mjs:68-81`：

```js
this._process = spawn(this._serverParams.command, this._serverParams.args ?? [], {
	env: { ...getDefaultEnvironment(), ...this._serverParams.env },
	stdio: ["pipe", "pipe", this._serverParams.stderr ?? "inherit"],
	shell: false,
	windowsHide: process.platform === "win32",
	cwd: this._serverParams.cwd
});
```

`detached` 未设置（即 `false`）。在 POSIX 上这意味着子进程与宿主同进程组，`process.kill(-pid, sig)` 会连同宿主一起打中，所以**想按进程组回收也没有条件**；在 Windows 上则意味着没有任何可用于 `taskkill /T` 的归属标记被记录下来。

### 2. `close()` 等的是 `'close'`，且三段式只管直接子进程

`dist/stdio.mjs:175-199`：

```js
async close() {
	if (this._process) {
		const processToClose = this._process;
		this._process = void 0;
		const closePromise = new Promise((resolve) => {
			processToClose.once("close", () => { resolve(); });
		});
		try { processToClose.stdin?.end(); } catch {}
		await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 2e3).unref())]);
		if (processToClose.exitCode === null) {
			try { processToClose.kill("SIGTERM"); } catch {}
			await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 2e3).unref())]);
		}
		if (processToClose.exitCode === null) try {
			processToClose.kill("SIGKILL");
		} catch {}
	}
	this._readBuffer.clear();
}
```

两个具体问题：

- **等待条件选错了。** 三段都在等 `closePromise`，而它绑的是 `'close'`。孙进程持管道时，即使直接子进程已被 SIGKILL，`'close'` 依然可能不来。第三段之后**没有 await**，函数直接 `return` ——看起来是「兜底返回」，实际效果是把一个仍在 pending 的 `close` 事件留在身后，而 `_process` 已经被置为 `undefined`，后续没有任何路径再回收它。
- **SIGKILL 只覆盖一个 pid。** `proc.kill("SIGKILL")` 打的是直接子进程；孙进程不在信号可达范围内（POSIX 需负 pid 打进程组，Windows 需 `taskkill /T`）。最需要被杀掉的那批进程恰好一个都没被打中。

### 3. 上游已经写出了正确解法，却只给内部探针用

`dist/stdio.mjs:140-174`，原文注释：

```js
/**
* Reap a disposable probe sibling (see the version-negotiation sibling
* flow): signal-first teardown awaiting process `exit` — never the `close`
* event, so a helper process holding the child's stdio pipes can never
* block disposal. Not part of the public transport lifecycle.
*
* @internal
*/
async _dispose() {
	...
	const exited = new Promise((resolve) => proc.once("exit", () => resolve()));
	...
	await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1e3).unref())]);
	if (proc.exitCode === null && proc.signalCode === null) try {
		proc.kill("SIGKILL");
	} catch {}
	await exited;
	...
}
```

注释原文那句是关键：

> **"awaiting process `exit` — never the `close` event, so a helper process holding the child's stdio pipes can never block disposal"**

也就是说，**上游作者完全知道**「孙进程持有管道会让 `close` 永远不触发」，并且针对探针兄弟进程已经改用 `'exit'`、还做了「不设上界的 `await exited` 收尾」。但常规生命周期路径 `close()` 走的仍是 `'close'`。这不是设计取舍，是两条路径没对齐——`_dispose()` 的注释里 "Not part of the public transport lifecycle" 也侧面承认了这一点。

## 可复现条件

同时满足以下条件即会触发（可据此判断某个用户的现场是否属于此类）：

1. **`command` 是包装器**：`npx`、`uvx`、`bunx`、`pnpm dlx`、`docker exec`、`cmd /c`、`.bat`/`.cmd` shim（Windows 上 npm 全局安装的 CLI 全是这一种）。
2. **server 进程内部再 spawn 至少一个子进程**，且该子进程**继承 stdout/stderr**（Node 的 `spawn` 默认 `stdio: "inherit"`/`"pipe"` 时子侧持有句柄；Python 的 `subprocess.Popen` 默认同样继承）。
3. **该孙进程生命周期长于父进程**：语言服务器、watcher、索引器、常驻 helper，或干脆是忘记 `unref`/忘记退出的失控进程。
4. 父进程被回收（`close()` / `SIGTERM` / 崩溃）——此时孙进程成为孤儿但仍持有管道句柄。

反过来，以下情况**不会**触发，不必怀疑本例：server 是单进程（如纯 Node 的 `node dist/index.js< /dev/null`、无内部 spawn 的 Python 脚本）、或孙进程启动时显式 `stdio: "ignore"` / `detached: true` 并自己管理生命周期。

判定手法：回收卡住时对目标 pid 跑一次 `wmic process where "ParentProcessId=<pid>" get ProcessId,CommandLine`（或 PowerShell `Get-CimInstance Win32_Process -Filter "ParentProcessId=<pid>"`）。有存活子进程且它们的父已经不在 → 就是本例。POSIX 上用 `ps -o pid,ppid,pgid,stat -g <pgid>` 看进程组里的残留。

## 建议方案（按优先级）

### 方案 A（推荐，最小改动）：`close()` 与 `_dispose()` 对齐

三处改动，全部在上游内部，不改变公开 API 形状：

1. **把等待条件从 `'close'` 换成 `'exit'`**（与 `_dispose()` 完全一致）。`'exit'` 的语义是「本进程已终止」，不依赖任何流被关闭，因此孙进程持管道不再是阻塞条件。
2. **把 SIGKILL 阶段扩展为「按进程组」。** 这需要 spawn 时加 `detached: true`：POSIX 下子进程自成一组，用 `process.kill(-child.pid, signal)` 打整组；Windows 下 `detached: true` 让子进程成为新进程组的根，配合 `taskkill /T /F /PID <pid>` 才能连带孙进程。
3. **给最后的 `await exited` 加上上界**（`_dispose()` 现在这行是无上界的）。一组进程全杀光也可能因权限/句柄原因一直不 exit，收尾必须能失败返回，并把结果（`timedOut: true`）交给调用方。

代价：`detached: true` 是**行为变更**——POSIX 下子进程默认不再与宿主共享进程组，宿主的 Ctrl-C / 终端信号不再自动传给 MCP server。对 MCP 这类由宿主全权管理的子进程，这通常是想要的（宿主本来就有 `close()`），但对「依赖宿主信号传播来退出」的现有集成是破坏性的。**因此建议至少把 (2) 放进一个 opt-in 选项**（见方案 B），而 (1)(3) 可以直接改：它们只把「无限等待」变成「有界等待」，不改变任何成功路径的行为。

### 方案 B（推荐与 A 并行）：`detached` 做成 transport 选项

`StdioServerParameters` 加一个字段（名字供参考）：

```ts
/** 让 MCP 子进程自成进程组，使 close() 能按组回收孙进程。默认 false（保持现状）。 */
detached?: boolean;
```

默认关闭即**零破坏性**：现有集成的行为一字不变，需要的宿主显式开启。开启后上游在 `close()` 中按平台选择 `process.kill(-pid, ...)` / `taskkill /T /F /PID`。

代价：多一个配置项要写文档、要写跨平台分支；Windows 的 `taskkill` 是外部进程，需处理「命令不存在」「拒绝访问」「进程已退出（退出码 128）」等噪音。相对收益（真正能杀掉进程树）这个代价是值得的。

### 方案 C（保底，成本最低）：至少把 `child.pid` 暴露出来

即使前两条都不做，也建议把直接子进程的 pid 通过公开 API 给出，例如：

```ts
get pid(): number | undefined;
```

理由：判定「是连接卡住还是宿主卡住」需要 pid（见上一节判定手法）；有了 pid，宿主或插件可以自行做进程树回收、写诊断、在面板上显示「这条连接对应 pid 1234」。上游什么都不用改变，只是**把已有的内部事实变成可观察事实**。代价几乎为零（一个 getter + 生命周期上的 `undefined` 时机说明）。

> 三条方案的取舍一句话：**A 修正确性，B 保兼容，C 保可观测。** A 里 (1)(3) 无破坏性、可直接进；(2) 有破坏性、建议走 B 的开关。

## 对本项目的影响

`dsh-armory`（本插件）在 MCP 子进程这件事上是**纯观察者**：

- 它**从不 spawn 任何 MCP 子进程**。对 `lib/` 全目录 grep `SIGTERM | SIGKILL | taskkill | kill(` —— **零命中**。
- 子进程由宿主的 `@deepseek-ai/dsh-scope` 与 `@deepseek-ai/dsh-mcp-client` 拥有。插件侧只拿到 `scopeMod.createScope(ctx, scopeKey)` 返回的 `scoped` 句柄，回收时调 `scoped.dispose()`。
- 因此插件**没有 pid、没有 ChildProcess 对象、没有可 kill 的句柄**。在本插件内实现「taskkill 进程树」在技术上不可能——不是没做，是无从下手。

结论：本插件无法自己解决这个问题，只能等上游。上游采纳**任一条**（A 的 (1)(3)、B、C）本插件都直接受益：

- 采纳 A(1)(3)：`scoped.dispose()` 从「可能永不返回」变成「有界返回」，本插件的 `retireSharedConnection` 天然跟上，无需改代码。
- 采纳 B：宿主可在建连时开启 `detached`，插件侧零改动。
- 采纳 C：本插件的诊断视图能从「已释放 12.3s 仍在等」升级为「pid 1234 已释放 12.3s 仍在等」，用户可直接去任务管理器处理。

## 临时缓解（本侧已做）

在上游改动落地前，本插件做了一件事：**把「卡住」从沉默变成可见事实**。这不是修复，是让人能做决定。

- `lib/workspace-runtime.js` 新增常量 `TEARDOWN_STUCK_MS = 5_000`，与既有的 `DEAD_CONNECTION_AGE_MS = 5_000` 对齐——同一份连接在同一条时间尺度上被判定「已死」与「回收卡住」，两个数字不同会让排障时对不上号。
- 每次回收在模块级记录表里留一条 `{ wsPath, serverName, startedAt, settledAt, elapsedMs, settled, stuck, error }`，按 app root 分桶、每 connKey 只留最近一条（`TEARDOWN_RECORD_MAX = 64` 兜底）。**回收永不返回时，记录里仍有它的出生时间**，于是「已经等了多久」永远算得出来。
- 面板行新增 `teardown` 字段（`null` 或上述读数的投影），于是界面能显示「这条连接已释放 12.3s 仍在等」而不是干等。超龄（`TEARDOWN_RECORD_STALE_MS = 600_000`）的旧结果不再送出——10 分钟前的回收结果对「现在卡不卡」没有解释力。
- 该字段是**纯增量**：沿用已注册的 `dsh-armory#mcpManager/projectConnections` 契约（其 result codec 透传任意结构），不改契约、不改 `lib/typert.js`、不改 `lib/index.js`。

**用户的正确处置**：面板上看到某条连接 `stuck: true` 且 `elapsedMs` 持续增长时，不要再等——重启宿主。残留的孙进程需要手工清理（Windows：任务管理器按父 pid 找；POSIX：`ps -g <pgid>` 后整组 `kill`）。这份文档的目的就是让这条手工路径最终能被上游的改动取代。
