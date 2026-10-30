// 会话级专家人设注入 —— 让「专家」像 WorkBuddy 一样可随时挂/换/摘，不受 agent-preset/locked 限制。
//
// 为什么需要这条独立通道：宿主的 agentPresets.select() 有硬锁（会话一旦开过口就
// `agent-preset/locked`），因为**预设**决定工具目录与提示词结构，中途换会破坏前后一致。
// 但用户要的是 WorkBuddy 式体验：任何会话、任何时刻都能换专家或摘掉。可行的原因是
// 人设（persona）与预设是两件事——preset 的 persona 行只是一段提示词 section：
//
//   dsh-persona 的注释写明该行是 **scope-only**：挂进某个 agent 预设时，它只遮蔽
//   「那一个会话」的部署人设。dsh-subagent 也用同一手法给子会话装人设：
//     childCtx.systemPrompt.section({ name: "deployment:persona-prefix",
//       order: childCtx.systemPrompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX"),
//       text: persona })
//
// 而 systemPrompt.section() 的归属 scope 取自定义层自身 ctx 的 kScope（见 dsh-scope
// 的 scopeOf / ScopedLayers.effect），cordis 的 tracker 代理会把服务方法的 this.ctx
// 重绑为**调用方 ctx** —— 所以用 `agent.ctx.systemPrompt.section(...)` 注册，段就落在
// 该会话自己的 scope 层：只影响这个会话，且 ctx.effect 返回的 disposer 可随时撤销。
//
// ── 为什么专家会「掉」（2026-10 抖音反馈）────────────────────────────────
// 上面那个 section 的生命周期是**这个 live agent 的 scope**，不是会话文件：
//   - 会话切走/落盘后 agent 被卸载（dsh-session 明说「persisted-but-unloaded sources」），
//     再打开走 agents.resume() 重建 agent —— 旧 scope 连同 section 一起销毁；
//   - 宿主重启同理，且本模块原来只有内存 Map，重启后连「挂过谁」都不知道；
//   - 原先 reconcilePersonas 还把「不在 agents.list() 里」当成用户取消，把仅有的记录删掉。
// 于是 chip 消失、人设失效，只能重新勾选——这正是「每个会话中专家容易掉」的来源。
//
// WorkBuddy 的逻辑是「专家属于这个会话」：选择是持久的，会话回来时专家就回来。这里照做：
//   1. 选择（plugin/name/personaText）落盘到 ~/.dsh/wb-market/experts/session-persona.json；
//   2. 每个 agent/created（含 resume / clear / compaction）都把该会话的选择重新注入；
//      宿主在创建事务里 await 串行监听器，所以恢复后的**第一个模型请求**就带着人设；
//   3. reconcile 只清理失效的运行时 section，**绝不**因为会话暂时不在运行就删选择；
//   4. 只有用户点 ×（detach）才删除选择。
// 人设正文随选择一起存：重启/离线时不必再请求专家市场，恢复出来的行为与当时一致。
//
// 与「召唤预设」的分工不变：召唤写 profile patch，管**新会话的预设选择器**（长期身份）；
// 本模块管**当前会话的即时人设**（会话内挂/换/摘）。两者互不干扰：预设仍在，随时可用；
// 会话内挂的专家只是这段提示词 section 的替换，不动工具目录与 profile 配置。新增的落盘
// 文件只记录「哪个会话挂了哪位专家」，是纯增值数据，损坏时静默重置。

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 与 dsh-persona / dsh-subagent 共用的 section 名（同名即遮蔽，最近 scope 胜出）。 */
const PERSONA_PREFIX_SECTION = "deployment:persona-prefix";
/** 最多记住多少个会话的选择（防泄漏；正常使用远小于此）。 */
const MAX_SESSIONS = 64;
/** 运行中的注入记录：sessionId -> { plugin, name, disposer, agentCtx }。 */
const activePersonas = new Map();
/** 持久化的用户选择：sessionId -> { plugin, name, personaText, savedAt }。 */
const stickyPersonas = new Map();
let stickyLoaded = false;

// ── 落盘 ────────────────────────────────────────────────────────────────
// 与 expert-market.js 的 cacheDir 同一根（同一套 DSH_ARMORY_MARKET_HOME 测试隔离口）。
// 不 import 那个模块：它带 yaml 等依赖，而本模块会被 test/session-persona.mjs 直接 import。
function storeFile() {
	const root = process.env.DSH_ARMORY_MARKET_HOME || join(homedir(), ".dsh", "wb-market");
	return join(root, "experts", "session-persona.json");
}
function ensureSticky() {
	if (stickyLoaded) return;
	stickyLoaded = true;
	let raw = null;
	try {
		raw = JSON.parse(readFileSync(storeFile(), "utf8"));
	} catch {
		return; // 没有文件 / 损坏：纯增值数据，静默重置
	}
	const rows = Array.isArray(raw?.sessions) ? raw.sessions : [];
	for (const row of rows) {
		const sessionId = typeof row?.sessionId === "string" ? row.sessionId.trim() : "";
		const personaText = typeof row?.personaText === "string" ? row.personaText.trim() : "";
		if (!sessionId || !personaText) continue;
		stickyPersonas.set(sessionId, {
			plugin: String(row.plugin || ""),
			name: String(row.name || row.plugin || "专家"),
			personaText,
			savedAt: Number(row.savedAt) || 0,
		});
	}
	pruneSticky();
}
function persistSticky(ctx) {
	try {
		const target = storeFile();
		mkdirSync(dirname(target), { recursive: true });
		const payload = {
			version: 1,
			sessions: [...stickyPersonas.entries()].map(([sessionId, row]) => ({ sessionId, ...row })),
		};
		const tmp = `${target}.${process.pid}.${Date.now().toString(36)}.tmp`;
		try {
			writeFileSync(tmp, JSON.stringify(payload, null, 1), "utf8");
			renameSync(tmp, target);
		} catch (error) {
			rmSync(tmp, { force: true });
			throw error;
		}
	} catch (error) {
		// 落盘失败不影响本次挂载：section 已经生效，只是重启后不会自动恢复。
		ctx?.logger?.warn?.(`armory: 会话专家选择落盘失败（本次仍生效）：${error?.message || error}`);
	}
}
/** 超出上限时丢掉最久没用的选择（连同其运行时注入）。 */
function pruneSticky() {
	if (stickyPersonas.size <= MAX_SESSIONS) return;
	const oldest = [...stickyPersonas.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt);
	for (const [sessionId] of oldest.slice(0, stickyPersonas.size - MAX_SESSIONS)) {
		stickyPersonas.delete(sessionId);
		clearPersona(sessionId);
	}
}

// ── 运行时注入 ───────────────────────────────────────────────────────────
// 插件 HMR 后模块级 Map 会重置，但 agent scope 里的 section 仍在——此时再注册同名 section
// 会被宿主拒绝（NamedEntries 同名即抛）。用一个跨模块实例共享的 WeakMap 记住「这个 agent
// 作用域注册过什么」，重装时先撤旧的再装新的，HMR 前后都能做到幂等。
const REGISTRATION_KEY = Symbol.for("dsh-armory.sessionPersona.registrations");
function registrationStore() {
	const host = globalThis;
	if (!(host[REGISTRATION_KEY] instanceof WeakMap)) host[REGISTRATION_KEY] = new WeakMap();
	return host[REGISTRATION_KEY];
}

function agentCtxOf(ctx, sessionId) {
	const agents = typeof ctx?.get === "function" ? ctx.get("agents") : undefined;
	if (!agents || typeof agents.get !== "function") return { error: "宿主未提供 agents 服务（agentRegistry 不可用），无法定位会话" };
	const agent = agents.get(sessionId);
	if (agent === undefined) return { error: "会话不在运行中（可能已归档或尚未激活）：" + sessionId };
	const agentCtx = agent.ctx;
	if (agentCtx === undefined) return { error: "该会话没有可用的作用域上下文" };
	return { agentCtx };
}

/**
 * 摘掉某会话当前注入的人设（若有）。只动运行时 section，不动持久化选择。
 * @returns {boolean} 是否真的摘掉了一段。
 */
function clearPersona(sessionId) {
	const current = activePersonas.get(sessionId);
	if (!current) return false;
	activePersonas.delete(sessionId);
	try {
		current.disposer?.();
	} catch { /* 撤销失败不回滚状态：section 已随 scope 失效，重复撤销无害 */ }
	if (current.agentCtx) registrationStore().delete(current.agentCtx);
	return true;
}

function isDuplicateSection(error) {
	return /already registered/i.test(String(error?.message || error));
}

/**
 * 把一段人设注册进某个 agent scope。同名 section 已存在时视为「已在生效」（HMR 前一代
 * 留下的注册无法撤销），返回 adopted 而不是把异常抛给用户。
 */
function registerSection(agentCtx, text) {
	const prompt = agentCtx.systemPrompt;
	if (!prompt || typeof prompt.section !== "function") {
		throw new Error("该会话没有 systemPrompt 服务，无法注入人设");
	}
	// 同一作用域里本模块先前留下的注册：先撤掉，保证「换专家」是替换而不是叠加。
	try {
		registrationStore().get(agentCtx)?.();
	} catch { /* 已失效的 disposer 重复调用无害 */ }
	registrationStore().delete(agentCtx);
	try {
		// 与 dsh-persona 同款：同名 section + 同一处 order = 遮蔽该会话的部署人设前缀。
		const disposer = prompt.section({
			name: PERSONA_PREFIX_SECTION,
			order: typeof prompt.getSectionOrder === "function"
				? prompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX")
				: 0,
			text,
		});
		registrationStore().set(agentCtx, disposer);
		return { disposer, adopted: false };
	} catch (error) {
		if (!isDuplicateSection(error)) throw error;
		return { disposer: null, adopted: true };
	}
}

/** 当前挂在某会话上的专家（读的是用户选择；会话暂时不在运行也有值）。 */
export function personaOf(sessionId) {
	ensureSticky();
	const row = stickyPersonas.get(String(sessionId || "").trim());
	return row ? { plugin: row.plugin, name: row.name } : null;
}

/**
 * 所有「挂了专家」的会话快照。
 * 刻意以持久化选择为准而不是运行时 Map：会话被宿主卸载时 agent scope 已销毁，但用户
 * 的选择还在，chip 不应闪没；恢复完成后 expertActive 仍是同一答案。
 */
export function listPersonas() {
	ensureSticky();
	return [...stickyPersonas.entries()].map(([sessionId, row]) => ({ sessionId, plugin: row.plugin, name: row.name }));
}

/**
 * 给一个运行中的会话注入（或替换）专家人设。同一会话可反复调用：先摘旧的再装新的。
 * @param {object} ctx - 插件宿主上下文。
 * @param {string} sessionId - 目标会话。
 * @param {object} spec - { plugin, name, personaText }。
 * @param {{persist?: boolean}} [options] - persist=false 用于「按已存选择恢复」，不再写盘。
 * @returns {{ok: true, plugin: string, name: string, replaced: boolean}}
 */
export function attachPersona(ctx, sessionId, spec, options = {}) {
	const id = String(sessionId || "").trim();
	if (!id) throw new Error("缺少会话 id");
	const text = String(spec?.personaText || "").trim();
	if (!text) throw new Error("人设内容为空，无法挂载");
	ensureSticky();
	const { agentCtx, error } = agentCtxOf(ctx, id);
	if (error) throw new Error(error);
	const replaced = clearPersona(id);
	const { disposer, adopted } = registerSection(agentCtx, text);
	if (adopted) {
		// 只可能来自上一版插件在同一 agent scope 留下的同名 section（那一代的 disposer 已丢）：
		// 人设仍然生效，但本次拿不到撤销句柄，点 × 要等会话重建后才彻底生效。
		ctx?.logger?.warn?.("armory: 该会话已有同名专家人设 section，本次沿用（重启 DSH 后可正常取消）");
	}
	const plugin = String(spec?.plugin || "");
	const name = String(spec?.name || spec?.plugin || "专家");
	activePersonas.set(id, { plugin, name, disposer, agentCtx });
	if (options.persist !== false) {
		stickyPersonas.set(id, { plugin, name, personaText: text, savedAt: Date.now() });
		pruneSticky();
		persistSticky(ctx);
	}
	return { ok: true, plugin, name, replaced };
}

/** 摘掉某会话的专家人设与持久化选择（用户点 ×）。@returns {{ok: true, removed: boolean}} */
export function detachPersona(ctx, sessionId) {
	const id = String(sessionId || "").trim();
	if (!id) throw new Error("缺少会话 id");
	ensureSticky();
	const removedRuntime = clearPersona(id);
	const removedSticky = stickyPersonas.delete(id);
	if (removedSticky) persistSticky(ctx);
	return { ok: true, removed: removedRuntime || removedSticky };
}

/**
 * 会话（重新）创建时按已存选择恢复人设。任何失败都只返回原因、不抛出——本函数挂在
 * 宿主的串行 agent/created 监听器上，抛错会**否决会话创建**。
 * @returns {{restored: boolean, plugin?: string, name?: string, reason?: string}}
 */
export function restorePersonaForAgent(ctx, agent) {
	const id = String(agent?.id || "").trim();
	if (!id) return { restored: false, reason: "缺少会话 id" };
	ensureSticky();
	const record = stickyPersonas.get(id);
	if (!record) return { restored: false, reason: "该会话没有专家选择" };
	const agentCtx = agent.ctx;
	if (!agentCtx) return { restored: false, reason: "该会话没有可用的作用域上下文" };
	const current = activePersonas.get(id);
	if (current && current.agentCtx === agentCtx) return { restored: false, reason: "人设已生效" };
	try {
		const result = attachPersona(ctx, id, {
			plugin: record.plugin,
			name: record.name,
			personaText: record.personaText,
		}, { persist: false });
		return { restored: true, plugin: result.plugin, name: result.name };
	} catch (error) {
		// 记录保留：下一次 agent/created 或 reconcile 再试，绝不因为一次失败丢掉选择。
		return { restored: false, reason: String(error?.message || error) };
	}
}

/**
 * 对齐运行时注入与宿主存活会话：
 *   - 失效（agent 已卸载/已被新 agent 取代）的运行时记录撤销，但**保留用户选择**；
 *   - 活着的 agent 若有选择却没有注入（切换会话恢复、插件热重载、上次恢复失败），立刻补上。
 * 不抛错：它由只读 RPC expertActive 轮询调用，不能影响状态查询。
 */
export function reconcilePersonas(ctx) {
	const agents = typeof ctx?.get === "function" ? ctx.get("agents") : undefined;
	if (!agents || typeof agents.get !== "function" || typeof agents.list !== "function") return;
	ensureSticky();
	let live = [];
	try {
		live = agents.list() || [];
	} catch {
		return;
	}
	for (const [sessionId, row] of [...activePersonas]) {
		const agent = live.find((candidate) => candidate.id === sessionId);
		if (agent && agent.ctx === row.agentCtx) continue;
		clearPersona(sessionId);
	}
	for (const agent of live) {
		if (!stickyPersonas.has(agent.id)) continue;
		const current = activePersonas.get(agent.id);
		if (current && current.agentCtx === agent.ctx) continue;
		restorePersonaForAgent(ctx, agent);
	}
}

/**
 * 安装会话专家运行时：订阅 agent/created（宿主串行 await，恢复后首轮即带人设），并对
 * 安装时已经活着的会话做一次补装（插件热重载 / 运行中安装的场景）。
 * @returns {() => void} 幂等清理函数。
 */
export function installPersonaRuntime(ctx) {
	if (typeof ctx?.on !== "function") return () => {};
	ensureSticky();
	let disposed = false;
	let off;
	const cleanup = () => {
		if (disposed) return;
		disposed = true;
		try { off?.(); } catch { /* noop */ }
	};
	try {
		off = ctx.on("agent/created", (payload) => {
			// 边界：agent/created 是串行且抛错会否决创建的。人设恢复失败只能记账，不能挡会话。
			try {
				const agent = payload?.agent;
				if (agent?.id) {
					const result = restorePersonaForAgent(ctx, agent);
					if (!result.restored && result.reason && result.reason !== "该会话没有专家选择" && result.reason !== "人设已生效") {
						ctx.logger?.warn?.(`armory: 恢复会话专家失败（不影响会话创建）：${result.reason}`);
					}
				}
			} catch (error) {
				ctx.logger?.warn?.(`armory: 恢复会话专家异常（已吞掉，不阻断会话创建）：${error?.message || error}`);
			}
		});
		if (typeof ctx.effect === "function") ctx.effect(() => cleanup, "armory.sessionPersona");
	} catch (error) {
		cleanup();
		ctx.logger?.warn?.(`armory: 订阅 agent/created 失败，会话专家不会自动恢复：${error?.message || error}`);
		return () => {};
	}
	// 安装前就活着的会话（热重载）：逐个补装。
	try {
		const agents = typeof ctx.get === "function" ? ctx.get("agents") : undefined;
		if (agents && typeof agents.list === "function") {
			for (const agent of agents.list() || []) {
				if (agent?.id && stickyPersonas.has(agent.id)) restorePersonaForAgent(ctx, agent);
			}
		}
	} catch { /* 补装失败留给下一次 reconcile */ }
	return cleanup;
}
