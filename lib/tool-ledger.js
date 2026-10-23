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
//   1. 会话日志扫描 → 每个工具的调用次数 / 错误数 / 最后使用时间（窗口内）；
//   2. 当前注册表的 Schema（ctx.tools.schemas()）→ 每个工具每次请求占用的上下文 token 估算。
// 窗口内零调用的 MCP 工具就是「裁缝建议」：它们既不干活，还每轮请求白收上下文税。
//
// §6.1 第三路（同一趟扫描，不额外遍历）：`request/header` 事件的 `data.header.tools` 里存着
// **该次请求真实下发给模型的工具清单**。上下文税此前只有「注册表当前快照」这一个口径，它是
// Schema 长度的纯函数，与时间完全无关 —— 于是用户连着几天看到同一个数字，既无法判断裁缝是否
// 还在工作，也无法判断「我改注册表之后到底降了没有」。真实下发清单补上的是时间维度：按天采样
// 就能回答「这份清单这几天变过没有、什么时候变的」，并且和注册表快照互为对照（不一致 = 宿主没
// 重启 / 新工具尚未生效，这类状态此前完全不可见）。
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

/**
 * 真实下发工具清单的**种类上限**（§6.1）。每种只在首次出现时算一次全量税，超出后不再新增、
 * 只把 `wireTaxTruncated` 置真并交给界面上屏。设这道闸是因为「每次请求清单都不一样」这种病态
 * 日志会让 wireTaxByKey 无界增长，而那恰恰是要靠趋势线暴露的场景——宁可少报几种并明确说「已
 * 截断」，也不能让只读账本把宿主主进程的内存吃掉。
 */
const WIRE_TAX_MAX_KEYS = 64;


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

/**
 * 单个工具 Schema 投影成「要下发的那段 JSON」后的上下文税。
 *
 * 注册表侧与日志真实下发侧**必须共用这一个投影**：两处各写一遍 `{name, description,
 * parameters}` 时，任何一侧改了键集合或兜底写法，「注册表快照 vs 真实下发」的偏差里就会
 * 混进口径差而不是真差异，那个偏差卡就成了长期误报的假告警。
 * @param {{name: string, description?: string, parameters?: unknown}} tool
 * @returns {number} 估算 token 数。
 */
function schemaTokensOf(tool) {
	return estimateTokens(JSON.stringify({ name: tool.name, description: tool.description || "", parameters: tool.parameters ?? null }));
}

/**
 * 一次请求真实下发的整份工具清单的税（§6.1，口径与 {@link schemaTokensOf} 逐工具一致）。
 * @param {Array<{name?: unknown, description?: unknown, parameters?: unknown}>} tools
 * @returns {{ tokens: number, toolCount: number }}
 */
function wireToolsSummary(tools) {
	let tokens = 0;
	let counted = 0;
	for (const tool of tools) {
		if (!tool || typeof tool.name !== "string") continue;
		tokens += schemaTokensOf(tool);
		counted += 1;
	}
	return { tokens, toolCount: counted };
}

/**
 * 工具清单的**廉价**内容指纹（§6.1）：只读长度与工具名，不做 stringify，所以每个请求事件都算
 * 得起；真正的税计算只在指纹第一次出现时做一次（见 WIRE_TAX_MAX_KEYS）。
 *
 * 精度取舍要说清楚：工具数相同、工具名集合相同、描述总长相同，但**参数结构**不同的两份清单
 * 会撞成同一个指纹，此时后一份沿用前一份的税值。真实改动几乎不可能同时满足这三个条件（改参数
 * 一般会带动描述或增删工具），而撞车时的失真只影响趋势线的颗粒度与 `wireTaxChanges` 的次数，
 * 主口径 `taxTotalTokens` 来自注册表快照、完全不经这里。
 * @param {Array<{name?: unknown, description?: unknown}>} tools
 * @returns {string}
 */
function wireToolsFingerprint(tools) {
	let count = 0;
	let descLen = 0;
	let hash = 5381;
	for (const tool of tools) {
		if (!tool || typeof tool.name !== "string") continue;
		count += 1;
		descLen += typeof tool.description === "string" ? tool.description.length : 0;
		for (let i = 0; i < tool.name.length; i++) hash = ((hash * 33) + tool.name.charCodeAt(i)) >>> 0;
	}
	return `${count}:${descLen}:${hash >>> 0}`;
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
	// §6.2 无 time 的调用事件：窗口过滤写的是「time 是数字且早于 cutoff 才丢」，所以缺 time
	// 的事件会**无条件计入任何窗口**。当前宿主日志 100% 带数字 time（实测 6542/6542），但格式
	// 一变就会静默发生，而且症状恰好是「切窗口数字不动」——与本次排查的表象一模一样。宁可多一个
	// 恒为 0 的计数器，也不能再让这类失配无声无息。
	let undatedCalls = 0;
	// §6.3 本次真正读到的调用事件时间跨度（**含**早于窗口、因此在下面被 `continue` 掉的那些）。
	// 用它才能解释「近 90 天与近 30 天输出一字不差」：机器上只有 14 天日志时，加长窗口本来
	// 就无从改变结果。别用日志文件 mtime 代替：追加写的 mtime 是「最后写入」而不是「最早内容」。
	let scannedEventsOldestMs = null;
	let scannedEventsNewestMs = null;
	// §5.4 逐日趋势：扫描时顺手按天分桶，不额外遍历日志。
	// 桶只存「窗口内的相对天序号」（0 = 最早一天，windowDays-1 = 今天），
	// 由界面负责渲染；返回绝对日期反而让前端多一次时区换算的机会出错。
	const dayBuckets = new Array(windowDays).fill(0);
	// §6.1 真实下发税的按天采样。`dayTaxKeys` 每个日桶只存**当天最后一次**请求的指纹（数字与
	// 短串，不持有工具数组引用 —— 365 个日桶各留一份 234 项清单会常驻几十 MB，宿主主进程里不
	// 可接受）；`wireTaxByKey` 存每个不同清单的税，只在指纹首次出现时算一次，上限 WIRE_TAX_MAX_KEYS
	// 种，超出后置 `wireTaxTruncated` 而不是无界增长。成本与「清单种类数」同阶，与请求数无关。
	const dayTaxKeys = new Array(windowDays); // idx -> { time, fingerprint } | undefined
	const wireTaxByKey = new Map(); // fingerprint -> { firstMs, lastMs, tokens, toolCount }
	let wireTaxTruncated = false;


	const dayIndex = (time) => {
		if (typeof time !== "number") return null;
		const offset = now - time;
		const idx = windowDays - 1 - Math.floor(offset / 86_400_000);
		return idx >= 0 && idx < windowDays ? idx : null;
	};
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
					// §6.3 先记时间跨度，再做窗口过滤：被窗口丢掉的事件同样是「本机日志里真实存在过的
					// 调用记录」，界面要用它解释「把窗口从 30 天加到 90 天为什么什么都没变」。
					if (event.type === "tool/call" && time !== null) {
						if (scannedEventsOldestMs === null || time < scannedEventsOldestMs) scannedEventsOldestMs = time;
						if (scannedEventsNewestMs === null || time > scannedEventsNewestMs) scannedEventsNewestMs = time;
					}
					if (time !== null && time < cutoffMs) continue;
					if (event.type === "tool/call") {
						const name = typeof event.data?.name === "string" ? event.data.name : null;
						const callId = typeof event.data?.callId === "string" ? event.data.callId : null;
						if (!name) continue;
						// §6.2 计到账上了但没有 time → 这条落在哪个窗口都无法判定，它已经在**任何**窗口
						// 里被计数（含下面的 1 天窗口）。这是口径失配，必须单独报出去。
						if (time === null) undatedCalls += 1;

						let record = usage.get(name);
						if (!record) {
							record = emptyToolRecord();
							usage.set(name, record);
						}
						record.calls += 1;
						totalCalls += 1;
						dirHadCall = true;
						const bucket = dayIndex(time);
						if (bucket !== null) dayBuckets[bucket] += 1;
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
					} else if (event.type === "request/header") {
						// §6.1 该次请求真实下发给模型的整份工具清单。宿主把 `data.header.tools` 原样
						// 落盘，所以「注册表快照」有了一个可对照的真值：两者不一致就是「改了没生效」。
						const tools = event.data?.header?.tools;
						if (!Array.isArray(tools) || tools.length === 0) continue;
						// 没有 time 的清单快照无法归入日桶，直接丢；这类事件的存在由 undatedCalls
						// 那一路负责显形，两条口径不要混在一起。
						const taxBucket = dayIndex(time);
						if (taxBucket === null) continue;
						const fingerprint = wireToolsFingerprint(tools);
						const known = wireTaxByKey.get(fingerprint);
						if (!known) {
							if (wireTaxByKey.size >= WIRE_TAX_MAX_KEYS) {
								wireTaxTruncated = true;
								continue;
							}
							const summary = wireToolsSummary(tools);
							wireTaxByKey.set(fingerprint, { fingerprint, firstMs: time, lastMs: time, ...summary });
						} else if (time > known.lastMs) known.lastMs = time;
						const dayBest = dayTaxKeys[taxBucket];
						if (!dayBest || time > dayBest.time) dayTaxKeys[taxBucket] = { time, fingerprint };
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
			schemaTokens: schemaTokensOf(schema),
			serverDisabled: classification.server !== null && disabled.has(classification.server),
		});
	}
	// 有调用记录的工具也补 Schema 税（有 Schema 的才有值）。
	for (const tool of tools) {
		if (tool.schemaTokens === null && schemaByName.has(tool.name)) {
			tool.schemaTokens = schemaTokensOf(schemaByName.get(tool.name));
		}
	}

	const mcpTools = tools.filter((tool) => tool.kind === "mcp");
	const deadTools = tools.filter((tool) => tool.calls === 0);
	const deadMcpTools = deadTools.filter((tool) => tool.kind === "mcp");
	const taxTotalTokens = tools.reduce((sum, tool) => sum + (tool.schemaTokens ?? 0), 0);
	const deadMcpTaxTokens = deadMcpTools.reduce((sum, tool) => sum + (tool.schemaTokens ?? 0), 0);

	// §6.1 收尾：把按天采到的指纹换成税值，并挑出「窗口内出现过的不同清单」按首次出现时间排序。
	// 界面要回答的是「这份清单这几天动过没有」，所以清单种类（通常 1~5 种）远比请求条数有意义。
	const wireTaxDaily = new Array(windowDays).fill(0);
	for (let i = 0; i < windowDays; i++) {
		const dayBest = dayTaxKeys[i];
		if (!dayBest) continue;
		const entry = wireTaxByKey.get(dayBest.fingerprint);
		if (entry) wireTaxDaily[i] = entry.tokens;
	}
	const wireTaxSnapshots = [...wireTaxByKey.values()].sort((a, b) => a.firstMs - b.firstMs);
	// latest = 时间最晚那次请求所用的清单（不是「最后一个非空日桶」：日桶按天存当天最后一次，
	// 但同一天里先后的两份清单都记在 wireTaxSnapshots 的 firstMs/lastMs 上，这里取 lastMs 最大者）。
	let wireTaxLatest = null;
	for (const entry of wireTaxSnapshots) {
		if (wireTaxLatest === null || entry.lastMs > wireTaxLatest.atMs) wireTaxLatest = { atMs: entry.lastMs, tokens: entry.tokens, toolCount: entry.toolCount };
	}

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
		// OPT-19：解压文本缓存的占用快照（见 textCacheStats）。128 MB 常驻占用此前对用户
		// 完全不可见——报告带上它，面板才有数据展示「缓存占了多少 / 装了多少条」。面板那一行
		// 现在是**只读**的：「手动清空」整条动作链已于 2026-10-23 删除（反馈恒错 + 占用不降 +
		// 本机命中率 0%；理由记在 client.js 的 cacheLine 上方与 index.js 的 toolTailor 里，
		// 护栏是 test/tailor-cache-line.mjs）。utilization 仍照常产出，只是界面不再显示——它把
		// 字节占比与条数占比混成一个数，本机恒为 1，摆上屏只会把人推向那个已经不存在的按钮。
		textCache: textCacheStats(),
		totalCalls,
		totalResults,
		totalErrors,
		orphanResults,
		// §6.2 被计入任何窗口但无法定位时间的调用（当前宿主恒为 0；一旦变红就是日志格式失配）。
		undatedCalls,
		// §6.3 本次读到的调用记录跨度。**按窗口变化**：更长的窗口会打开更多日志文件，读到更早的
		// 事件。界面用「spanDays < windowDays」解释为什么加长窗口什么都没改变。
		scannedEventsOldestMs,
		scannedEventsNewestMs,
		// 取整方式由 test/tailor-timeline.mjs §6 钉住：这里**必须**是 round 而不是 ceil。任何事
		// 件的时间戳都严格早于本次扫描的 now（哪怕只早几毫秒），ceil 于是恒定时把「2 天前」印成
		// 「跨 3 天」——正是本功能要消灭的那类「看起来没错、实际误导」的数字。round 的另一半好处
		// 在触发条件：ceil 下 2.0 天前的数据算成 3 天，3 天窗口 `3 > 3` 不成立，归因提示漏报；
		// round 给 2 天，提示正常出现。误差半天的漏报阈值远小于面板的语义颗粒（天）。
		scannedSpanDays: scannedEventsOldestMs === null ? 0 : Math.max(1, Math.round((now - scannedEventsOldestMs) / 86_400_000)),
		toolCount: tools.length,
		mcpToolCount: mcpTools.length,
		deadCount: deadTools.length,
		deadMcpCount: deadMcpTools.length,
		taxTotalTokens,
		deadMcpTaxTokens,
		// §5.4 趋势数据：逐日调用量（下标 0 = 窗口最早一天）。
		// 界面只在「确实有调用」时画 sparkline，全 0 从这里就能看出来，不必前端猜。
		dailyCalls: dayBuckets,
		// §6.1 真实下发税时间线：税值第一次有了「按天」的形状，用户不必再靠「这个数字看着没变」
		// 来猜注册表动没动。0 = 那天没有 request/header 记录（税不可能算成 0，所以 0 就是缺数据）。
		wireTaxDaily,
		wireTaxSnapshots: wireTaxSnapshots.map((entry) => ({ firstMs: entry.firstMs, lastMs: entry.lastMs, tokens: entry.tokens, toolCount: entry.toolCount })),
		wireTaxLatest,
		wireTaxChangeCount: wireTaxByKey.size,
		wireTaxTruncated,
		// 注册表快照与最近一次真实下发的差额（正数 = 注册表比线上更大，例如加了服务器还没生效）。
		// 没有真实下发记录时为 null —— 界面必须把「不知道」和「差 0」分开呈现。
		wireTaxDivergenceTokens: wireTaxLatest === null ? null : taxTotalTokens - wireTaxLatest.tokens,
		tools,
	};
}

// OPT-19：解压文本缓存（OPT-03）的**可观测性**。128 MB 上界在长时间运行的宿主里是笔实实在在的
// 常驻占用，但本模块此前只导出 scanSessionLedger，条数/字节数/新鲜度全关在模块私有作用域里：
// 用户既看不到占用，也没有任何回收手段，出问题只能重启宿主。下面两个导出只读写模块私有状态——
// 不读盘、不解压、不新增 RPC 契约。可观测性已经接上面板（cacheLine 那一行，只读）；「手动回收」
// 也接过一次，但因那条链的反馈恒错且实测不降占用，已于 2026-10-23 连界面入口一起删除，
// clearTextCache 因此暂时没有调用方——它仍是将来改缓存策略（槽位按文件数自适应、或只缓存最近
// 若干会话）的落点，所以留着。

/** utilization 的量化倍数：10^4，即保留 4 位小数（0.0001 精度），避免浮点长尾进入面板文案。 */
const UTILIZATION_SCALE = 10_000;

/**
 * 从缓存条目的戳（`size:mtimeMs`）里取出**毫秒时间戳**。
 *
 * 戳是复合串：它同时编码落盘体积与 mtime，用来判「内容是否变化」（见 readLogTextCached）。
 * 但对外契约要的是 number ——「这条缓存有多久没动」是个时间点，复合串既不是数字、也不能
 * 直接按字典序比较大小（`"9:..."` > `"10:..."`），所以这里只取后段的 mtimeMs。解析不出来
 * （历史遗留条目或将来改了格式）时返回 null，由调用方跳过该条，绝不让 NaN 污染最值聚合。
 * @param {{ stamp?: unknown }} entry - 缓存条目。
 * @returns {number|null} 毫秒时间戳，无法解析时为 null。
 */
function stampTimeMs(entry) {
	if (typeof entry?.stamp !== "string") return null;
	const sep = entry.stamp.lastIndexOf(":");
	if (sep === -1) return null;
	const ms = Number(entry.stamp.slice(sep + 1));
	return Number.isFinite(ms) ? ms : null;
}

/**
 * 解压文本缓存的只读快照。**纯数据、无副作用**：不读盘、不解压、不改变 LRU 顺序，可以在
 * 面板渲染时顺手取一次而不用担心干扰扫描。
 *
 * `utilization` 取「字节占用率」与「条数占用率」的**较大者**：rememberCacheEntry 的收缩条件
 * 是 `size > maxEntries || bytes > maxBytes`，任一维度逼近上界都会触发淘汰；只看字节会漏掉
 * 「32 条小文件把条数打满、字节却很低」这种同样会开始丢缓存的情况。
 * @returns {{
 *   entries: number,
 *   bytes: number,
 *   maxEntries: number,
 *   maxBytes: number,
 *   utilization: number,
 *   oldestStamp: number|null,
 *   newestStamp: number|null
 * }} 缓存占用快照；空缓存时 entries/bytes/utilization 全为 0，两个戳为 null。
 */
export function textCacheStats() {
	let oldestStamp = null;
	let newestStamp = null;
	for (const entry of textCache.values()) {
		const stamp = stampTimeMs(entry);
		if (stamp === null) continue;
		if (oldestStamp === null || stamp < oldestStamp) oldestStamp = stamp;
		if (newestStamp === null || stamp > newestStamp) newestStamp = stamp;
	}
	const entries = textCache.size;
	const bytes = Number.isFinite(textCacheBytes) ? textCacheBytes : 0;
	// 必须 clamp：淘汰是「先写入、再按预算收缩」，单条最大可到 128 MB，写后到收缩之间瞬时
	// 会越过上界（raw 可能 > 1）；下界 0 则是防计数漂移（理论上不该为负，但负数利用率上屏
	// 毫无意义）。四舍五入放在 clamp 之后，保证结果恒在 [0, 1] 且只保留 4 位小数。
	const raw = Math.max(bytes / TEXT_CACHE_MAX_BYTES, entries / TEXT_CACHE_MAX_ENTRIES);
	const utilization = Math.round(Math.min(Math.max(raw, 0), 1) * UTILIZATION_SCALE) / UTILIZATION_SCALE;
	return {
		entries,
		bytes,
		maxEntries: TEXT_CACHE_MAX_ENTRIES,
		maxBytes: TEXT_CACHE_MAX_BYTES,
		utilization,
		oldestStamp,
		newestStamp,
	};
}

/**
 * 清空解压文本缓存并复位计数，返回被清掉的内容概要（条数与字节数）。
 *
 * **当前没有调用方**：面板的「清空缓存」按钮与 index.js 的 toolTailor action 分支已于
 * 2026-10-23 一并删除（理由记在 client.js cacheLine 上方）。要把这类动作接回界面，光调这个
 * 函数不够——`textCacheStats()` 里没有 `clearedBytes` 键，宿主必须把本函数的返回值原样放进
 * 报告，否则面板拿不到「释放了多少」，只能落到兜底文案，看上去永远在忙；那正是当初删掉它的
 * 三个理由之一。护栏见 test/tailor-cache-line.mjs。
 *
 * 实现顺序是有意为之——**先取 size 快照 → 再 clear → 最后把计数显式归零**：
 *   1. 不能先 `textCache.clear()` 再取 size / 遍历求和：那时 Map 已空，clearedEntries 与
 *      clearedBytes 会恒为 0，面板就永远只能说「已释放 0 MB」；
 *   2. 也不能指望 `dropCacheEntry` 顺手收拾计数——它按 logPath 逐条 `-=`，必须先于 clear
 *      调用才有意义；clear 之后它拿不到任何条目，等于什么也没做（这正是最容易被写反的地方）；
 *   3. 计数变量 `textCacheBytes` 是**独立**于 Map 的，`Map.clear()` 不会动它。漏掉归零就会
 *      留下一笔幽灵占用：此后 rememberCacheEntry 的预算循环会立刻判定超限并把刚写进去的条目
 *      淘汰掉（表现为缓存「莫名其妙永不命中」）。所以这里无条件赋 0，而不是 `-= clearedBytes`。
 *
 * 安全性：清空后下一次 scanSessionLedger 走的是 readLogTextCached 的未命中分支（读盘 →
 * 解压 → 回填），完全不依赖缓存状态，只是「重新解压一遍」，不会抛错。风险点其实在反方向：
 * 清空后若 `textCacheBytes` 没归零（留着正数），后续每一次 rememberCacheEntry 都会在预算
 * 循环里把刚写进来的条立刻丢掉，看上去就像「缓存失效了」；归零才不会把缓存卡死。
 * 幂等：空缓存上再调一次，返回 clearedEntries 与 clearedBytes 均为 0。
 * @returns {{ clearedEntries: number, clearedBytes: number, entries: number, bytes: number }}
 *   被清掉的条数/字节数；entries 与 bytes 恒为 0，表示清空后的状态。
 */
export function clearTextCache() {
	const clearedEntries = textCache.size;
	// 负值只可能来自计数漂移；对面板而言「-0.0 MB」没有任何意义，按 0 呈现。清空后的状态
	// 则无条件归零，漂移不会被带进下一轮的预算判断。
	const clearedBytes = Number.isFinite(textCacheBytes) ? Math.max(textCacheBytes, 0) : 0;
	textCache.clear();
	textCacheBytes = 0;
	return { clearedEntries, clearedBytes, entries: 0, bytes: 0 };
}
