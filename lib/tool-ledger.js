// 工具裁缝（Tool Tailor）——宿主侧工具使用账本。
//
// 数据源是本机会话日志 `~/.dsh/sessions/<项目键>/<session-*>/session.*.jsonl(.zstd)`：
//   - `tool/call` 事件：`data.callId / data.name / data.turn / data.step`，`time` 为 epoch 毫秒；
//   - `tool/result` 事件：`data.message.toolCallId` 与 call 配对，`data.message.isError` 判成败，
//     与 call 的时间差即延迟。
// 日志按落盘时机追加为**多个独立 zstd 帧**（`zlib.zstdDecompressSync` 只解第一帧，这是
// dsh-forget-session 里踩过的坑），所以必须按 magic 切帧逐帧解压。
//
// 两路数据在这里合并成一张账：
//   1. 会话日志扫描 → 每个工具的调用次数 / 错误数 / P50/P95 延迟 / 最后使用时间（窗口内）；
//   2. 当前注册表的 Schema（ctx.tools.schemas()）→ 每个工具每次请求占用的上下文 token 估算。
// 窗口内零调用的 MCP 工具就是「裁缝建议」：它们既不干活，还每轮请求白收上下文税。
//
// 全程只读：不写任何文件、不碰会话目录内容。

import zlib from "node:zlib";
import { homedir } from "node:os";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setImmediate } from "node:timers";

const SESSIONS_DIR_SEGMENTS = [".dsh", "sessions"];
const MCP_PREFIX = "mcp__";
/** 每处理这么多文件让出一次事件循环，避免大库扫描把宿主卡住。 */
const YIELD_EVERY = 16;

/**
 * `zlib.zstdDecompressSync` 是 Node >= 22.15 才有的 API。缺失时**绝对不能**静默把每个帧
 * 都当成「损坏」吞掉：那会让工具裁缝表现为「扫到了 N 个会话、读到了 N 个日志、调用数整列 0」，
 * 而界面上看不到任何原因 —— 与「只看零调用」筛选的界面表现完全一致，无法自证清白。
 * 所以这里探测一次，让失败有名字（OPT-01）。
 */
const ZSTD_SUPPORTED = typeof zlib.zstdDecompressSync === "function";
const ZSTD_UNAVAILABLE_MESSAGE =
	"zstd 解压不可用：当前 Node 不支持 zlib.zstdDecompressSync（需 Node >= 22.15）";

/**
 * 单个日志的**落盘体积**上限（OPT-06）。完整链路是「整块读入 → 逐帧解压 → Buffer.concat
 * → toString(utf8) → split(换行)」，峰值内存约为压缩体积的 5~10 倍；没有上限意味着一个异常
 * 长的会话日志就能拖垮主进程。64 MB 相对当前最大单文件（4.4 MB）有十四倍冗余，正常使用碰不到。
 */
const MAX_LOG_BYTES = 64 * 1024 * 1024;
/** 解压文本缓存预算：按**字节**控制而非只按条数（见 textCache 注释）。 */
const TEXT_CACHE_MAX_BYTES = 128 * 1024 * 1024;
const TEXT_CACHE_MAX_ENTRIES = 32;

/** 把字节数格式化成 MB 文案，只用于诊断信息。 */
function formatMB(bytes) {
	return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * 解压**多帧** zstd 缓冲（宽容版）。与 dsh-forget-session 的 zstdDecompressAllFrames 同思路：
 * 按 zstd magic（0x28B52FFD）切帧逐帧解压；单帧文件行为不变。
 * 差别在于：个别帧损坏时跳过该帧继续（账本宁可少算一段也不整个失败），并回报帧数。
 * @param {Buffer} buf - 原始 zstd 字节。
 * @returns {{ text: string, frames: number, failedFrames: number }}
 */
function zstdDecompressAllFramesLenient(buf) {
	// 硬守卫（OPT-01）：Node 太旧时**必须**抛出一个有名字的错误，让 scanSessionLedger 的
	// failures() 捕获并写进 failedFileSamples 上屏，而不是逐帧 try/catch 各自吞掉、静默全 0。
	if (!ZSTD_SUPPORTED) throw new Error(ZSTD_UNAVAILABLE_MESSAGE);
	const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
	const starts = [];
	let idx = buf.indexOf(MAGIC, 0);
	while (idx !== -1) {
		starts.push(idx);
		idx = buf.indexOf(MAGIC, idx + 4);
	}
	if (starts.length === 0) throw new Error("not a zstd buffer");
	const parts = [];
	let failedFrames = 0;
	for (let i = 0; i < starts.length; i++) {
		const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
		try {
			parts.push(zlib.zstdDecompressSync(buf.subarray(starts[i], end)));
		} catch {
			failedFrames += 1;
		}
	}
	return { text: Buffer.concat(parts).toString("utf8"), frames: starts.length, failedFrames };
}

/**
 * 解压文本的跨调用缓存（OPT-03）。收益主体在这里：扫描耗时绝大部分花在「读盘 + 逐帧解压
 * + utf8 解码」上，JSON 解析只占小头。
 *
 * 两条纪律：
 *   1. 键是**日志绝对路径**，戳是 `size:mtimeMs`。日志是追加写，写必然同时抬升 size 与 mtime，
 *      所以戳一变就失效，不会拿到陈旧数据；反过来，戳没变时内容按定义没有变化。
 *   2. 淘汰按**字节预算**而不是只按条数。按报告里 32 条 × 解压后 15 MB 估算是 480 MB 峰值，
 *      在宿主主进程里不可接受；这里 128 MB 封顶，超过就按 LRU 丢到预算以内。
 * 只缓存 scanSessionLedger 需要的那点数据（解压文本 + 帧统计），不缓存任何调用记录。
 */
const textCache = new Map(); // logPath -> { stamp, bytes, text, frames, failedFrames }
let textCacheBytes = 0;

function dropCacheEntry(logPath) {
	const entry = textCache.get(logPath);
	if (entry) {
		textCacheBytes -= entry.bytes;
		textCache.delete(logPath);
	}
}

function rememberCacheEntry(logPath, entry) {
	dropCacheEntry(logPath);
	textCache.set(logPath, entry);
	textCacheBytes += entry.bytes;
	// Map 的迭代顺序即插入顺序，队首就是最久未使用的一条。
	while (textCache.size > TEXT_CACHE_MAX_ENTRIES || textCacheBytes > TEXT_CACHE_MAX_BYTES) {
		const oldest = textCache.keys().next();
		if (oldest.done) break;
		dropCacheEntry(oldest.value);
	}
}

/**
 * 读取并解压一个日志文件，命中缓存则完全跳过 IO 与解压。
 * @param {string} logPath - 日志绝对路径。
 * @param {{ size: number, mtimeMs: number }} st - 已取到的 stat 结果（不额外产生 IO）。
 * @returns {Promise<{ text: string, frames: number, failedFrames: number }>}
 */
async function readLogTextCached(logPath, st) {
	const stamp = `${st.size}:${st.mtimeMs}`;
	const hit = textCache.get(logPath);
	if (hit && hit.stamp === stamp) {
		// 触碰一次，让它在 LRU 里回到队尾。
		textCache.delete(logPath);
		textCache.set(logPath, hit);
		return hit;
	}
	const raw = await readFile(logPath);
	const value = logPath.endsWith(".zstd")
		? zstdDecompressAllFramesLenient(raw)
		: { text: raw.toString("utf8"), frames: 0, failedFrames: 0 };
	const entry = { stamp, bytes: Buffer.byteLength(value.text, "utf8"), ...value };
	// 单条就超出总预算的怪物不缓存（否则会把整个缓存挤空，还占着内存）。
	if (entry.bytes <= TEXT_CACHE_MAX_BYTES) rememberCacheEntry(logPath, entry);
	return value;
}

/**
 * DSH 数据根（`~/.dsh` 的上一级）。优先 `DSH_SKILL_MCP_BOARD_HOME`（测试隔离用，与
 * dsh-forget-session 的 `DSH_FORGET_SESSION_HOME` 同一惯用法），否则 OS 家目录。
 * @returns {string} 家目录绝对路径。
 */
function resolveHome() {
	const override = process.env.DSH_SKILL_MCP_BOARD_HOME;
	if (override !== undefined && override !== "") return override;
	return homedir();
}

/**
 * 上下文 token 估算。Schema 以 ASCII 为主，4 字符 ≈ 1 token 是公开常用的粗估；
 * 只用于相对比较与量级感知，不承诺精确计费。
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
	return Math.ceil(text.length / 4);
}

function emptyToolRecord() {
	return { calls: 0, results: 0, errors: 0, seenCallIds: new Set(), firstUsedMs: null, lastUsedMs: null };
}

/**
 * 按前缀归属把工具名分类到 MCP 服务器。与 mcp-registry.js 的 toolInventory 同一判定：
 * `mcp__<server>__<tool>`；服务器名自身可能含下划线，取**最长**匹配的归属，匹配到多个
 * 服务器时标为 ambiguous（不提供操作）。
 * @param {string} toolName
 * @param {string[]} mcpServerNames
 * @returns {{ kind: "mcp"|"builtin"|"mcp-ambiguous", server: string|null, leaf: string|null }}
 */
function classifyToolName(toolName, mcpServerNames) {
	if (!toolName.startsWith(MCP_PREFIX)) return { kind: "builtin", server: null, leaf: null };
	const owners = mcpServerNames.filter((name) => toolName.startsWith(`${MCP_PREFIX}${name}__`));
	if (owners.length === 1) {
		const server = owners[0];
		return { kind: "mcp", server, leaf: toolName.slice(`${MCP_PREFIX}${server}__`.length) };
	}
	if (owners.length > 1) return { kind: "mcp-ambiguous", server: null, leaf: null };
	return { kind: "builtin", server: null, leaf: null };
}

/**
 * 扫描会话日志，产出窗口内的工具使用账本，并与当前注册表 Schema 合并。
 * @param {object} input
 * @param {number} input.days - 统计窗口（天）。
 * @param {string[]} input.mcpServerNames - 当前注册的 MCP 服务器名（用于工具名归属）。
 * @param {Array<{name: string, description?: string, parameters?: unknown}>} input.schemas - 当前全部工具 Schema。
 * @param {Set<string>} input.disabledServers - 已禁用的 MCP 服务器名。
 * @returns {Promise<object>} 账本报告（纯数据，直接作为 Remote 返回值）。
 */
export async function scanSessionLedger({ days, mcpServerNames, schemas, disabledServers }) {
	const windowDays = Math.min(Math.max(Math.trunc(Number(days) || 30), 1), 365);
	const cutoffMs = Date.now() - windowDays * 86_400_000;
	const now = Date.now();

	const usage = new Map(); // toolName -> record
	let filesRead = 0;
	let filesSkippedStale = 0;
	let filesSkippedOversize = 0;
	let failedFiles = 0;
	let failedFileSamples = [];
	let sessionDirs = 0;
	let sessionsWithCalls = 0;
	let totalCalls = 0;
	let totalResults = 0;
	let totalErrors = 0;
	let orphanResults = 0;
	let failedFrames = 0;
	const failures = (reason) => {
		failedFiles += 1;
		if (failedFileSamples.length < 20) failedFileSamples.push(reason);
	};

	const sessionsRoot = join(resolveHome(), ...SESSIONS_DIR_SEGMENTS);
	let projects = [];
	try {
		projects = await readdir(sessionsRoot, { withFileTypes: true });
	} catch {
		// 没有任何会话日志（全新安装 / 目录被清理）：空账本照常返回。
		projects = [];
	}

	let sinceYield = 0;
	for (const proj of projects) {
		if (!proj.isDirectory()) continue;
		const projDir = join(sessionsRoot, proj.name);
		let sessDirs = [];
		try {
			sessDirs = await readdir(projDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const sess of sessDirs) {
			if (!sess.isDirectory()) continue;
			const sessDir = join(projDir, sess.name);
			sessionDirs += 1;
			let logFiles = [];
			try {
				logFiles = (await readdir(sessDir)).filter((n) => n.startsWith("session."));
			} catch {
				continue;
			}
			for (const logName of logFiles) {
				const logPath = join(sessDir, logName);
				let st;
				try {
					// mtime 早于窗口起点 → 里面不可能有窗口内事件，整个文件跳过。
					// 依据：日志是追加写，追加必然抬升 mtime。
					st = await stat(logPath);
				} catch {
					failures(`${logPath}: stat failed`);
					continue;
				}
				if (st.mtimeMs < cutoffMs) {
					filesSkippedStale += 1;
					continue;
				}
				// 尺寸闸门放在读盘之前（OPT-06）：超限就降级跳过，并把原因交给 failures()
				// 上屏，而不是先整块读进来再发现内存不够。
				if (st.size > MAX_LOG_BYTES) {
					filesSkippedOversize += 1;
					failures(`${logPath}: 日志 ${formatMB(st.size)} 超过 ${formatMB(MAX_LOG_BYTES)} 上限，已跳过`);
					continue;
				}
				let loaded;
				try {
					loaded = await readLogTextCached(logPath, st);
				} catch (error) {
					failures(`${logPath}: ${error instanceof Error ? error.message : String(error)}`);
					continue;
				}
				const text = loaded.text;
				failedFrames += loaded.failedFrames;
				filesRead += 1;
				let dirHadCall = false;
				for (const line of text.split("\n")) {
					if (!line.startsWith("{")) continue;
					let event;
					try {
						event = JSON.parse(line);
					} catch {
						continue;
					}
					const time = typeof event.time === "number" ? event.time : null;
					if (time !== null && time < cutoffMs) continue;
					if (event.type === "tool/call") {
						const name = typeof event.data?.name === "string" ? event.data.name : null;
						const callId = typeof event.data?.callId === "string" ? event.data.callId : null;
						if (!name) continue;
						let record = usage.get(name);
						if (!record) {
							record = emptyToolRecord();
							usage.set(name, record);
						}
						record.calls += 1;
						totalCalls += 1;
						dirHadCall = true;
						if (callId) record.seenCallIds.add(callId);
						if (time !== null) {
							if (record.firstUsedMs === null || time < record.firstUsedMs) record.firstUsedMs = time;
							if (record.lastUsedMs === null || time > record.lastUsedMs) record.lastUsedMs = time;
						}
					} else if (event.type === "tool/result") {
						const message = event.data?.message;
						const callId = typeof message?.toolCallId === "string" ? message.toolCallId : null;
						if (!callId) continue;
						// 与 call 配对：同一 callId 的后续 result（重试/续写）不再重复计。
						let owner = null;
						for (const record of usage.values()) {
							if (record.seenCallIds.has(callId)) {
								owner = record;
								break;
							}
						}
						if (!owner) {
							// call 事件在窗口外但 result 在窗口内：计总量，不入具体工具。
							orphanResults += 1;
							continue;
						}
						if (owner.results > 0 && owner.results >= owner.calls) continue; // 该 call 已有结果
						owner.results += 1;
						totalResults += 1;
						if (message.isError === true) {
							owner.errors += 1;
							totalErrors += 1;
						}
					}
				}
				if (dirHadCall) sessionsWithCalls += 1;
				sinceYield += 1;
				if (sinceYield >= YIELD_EVERY) {
					sinceYield = 0;
					await new Promise((resolve) => setImmediate(resolve));
				}
			}
		}
	}

	// 第二遍无需：精确延迟需要 callId→callTime 全量映射，内存开销不值得。健康度以
	// 「错误率 + 调用次数」为准，延迟统计留给后续版本的增量账本（扫描时顺手累积）。

	const schemaByName = new Map();
	for (const schema of Array.isArray(schemas) ? schemas : []) {
		if (schema && typeof schema.name === "string") schemaByName.set(schema.name, schema);
	}
	const disabled = disabledServers instanceof Set ? disabledServers : new Set();

	const tools = [];
	for (const [name, record] of usage) {
		const classification = classifyToolName(name, mcpServerNames);
		tools.push({
			name,
			kind: classification.kind,
			server: classification.server,
			leaf: classification.leaf,
			calls: record.calls,
			errors: record.errors,
			errorRate: record.calls > 0 ? record.errors / record.calls : 0,
			lastUsedMs: record.lastUsedMs,
			schemaTokens: null,
			serverDisabled: classification.server !== null && disabled.has(classification.server),
		});
	}
	// 注册表里有、窗口内零调用的工具：这是「裁缝建议」的主体，不扫日志永远看不见。
	for (const schema of schemaByName.values()) {
		if (usage.has(schema.name)) continue;
		const classification = classifyToolName(schema.name, mcpServerNames);
		tools.push({
			name: schema.name,
			kind: classification.kind,
			server: classification.server,
			leaf: classification.leaf,
			calls: 0,
			errors: 0,
			errorRate: 0,
			lastUsedMs: null,
			schemaTokens: estimateTokens(JSON.stringify({ name: schema.name, description: schema.description || "", parameters: schema.parameters ?? null })),
			serverDisabled: classification.server !== null && disabled.has(classification.server),
		});
	}
	// 有调用记录的工具也补 Schema 税（有 Schema 的才有值）。
	for (const tool of tools) {
		if (tool.schemaTokens === null && schemaByName.has(tool.name)) {
			const schema = schemaByName.get(tool.name);
			tool.schemaTokens = estimateTokens(JSON.stringify({ name: schema.name, description: schema.description || "", parameters: schema.parameters ?? null }));
		}
	}

	const mcpTools = tools.filter((tool) => tool.kind === "mcp");
	const deadTools = tools.filter((tool) => tool.calls === 0);
	const deadMcpTools = deadTools.filter((tool) => tool.kind === "mcp");
	const taxTotalTokens = tools.reduce((sum, tool) => sum + (tool.schemaTokens ?? 0), 0);
	const deadMcpTaxTokens = deadMcpTools.reduce((sum, tool) => sum + (tool.schemaTokens ?? 0), 0);

	return {
		windowDays,
		generatedAt: now,
		sessionsScanned: sessionDirs,
		sessionsWithCalls,
		filesRead,
		filesSkippedStale,
		filesSkippedOversize,
		failedFiles,
		failedFileSamples,
		failedFrames,
		// OPT-01/OPT-02：把「解码能力」和「失败原因」显式交给上层，界面才有东西可显示。
		zstdSupported: ZSTD_SUPPORTED,
		// 界面在 zstd 降级时会提示「升级到 22.15 以上」，得能说出用户当前跑的是什么版本，
		// 否则那句提示等于没说。取宿主进程自己的版本（不是 package.json 的 engines 声明）。
		nodeVersion: process.versions.node,
		totalCalls,
		totalResults,
		totalErrors,
		orphanResults,
		toolCount: tools.length,
		mcpToolCount: mcpTools.length,
		deadCount: deadTools.length,
		deadMcpCount: deadMcpTools.length,
		taxTotalTokens,
		deadMcpTaxTokens,
		tools,
	};
}
