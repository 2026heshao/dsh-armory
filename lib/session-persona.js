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
// 与「召唤预设」的分工：召唤写 profile patch，管**新会话的预设选择器**（长期身份）；
// 本模块管**当前会话的即时人设**（会话内挂/换/摘）。两者互不干扰：预设仍在，随时可用；
// 会话内挂的专家只是这段提示词 section 的替换，不动工具目录与任何持久化配置。

/** 与 dsh-persona / dsh-subagent 共用的 section 名（同名即遮蔽，最近 scope 胜出）。 */
const PERSONA_PREFIX_SECTION = "deployment:persona-prefix";
/** 单个会话最多保留的撤销记录（防泄漏；正常使用远小于此）。 */
const MAX_SESSIONS = 64;
/** sessionId -> { plugin, name, disposer } */
const activePersonas = new Map();

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
 * 摘掉某会话当前注入的人设（若有）。
 * @returns {boolean} 是否真的摘掉了一段。
 */
function clearPersona(sessionId) {
	const current = activePersonas.get(sessionId);
	if (!current) return false;
	activePersonas.delete(sessionId);
	try {
		current.disposer?.();
	} catch { /* 撤销失败不回滚状态：section 已随 scope 失效，重复撤销无害 */ }
	return true;
}

/** 当前挂在某会话上的专家（供客户端 chip 显示真实状态）。 */
export function personaOf(sessionId) {
	const row = activePersonas.get(sessionId);
	return row ? { plugin: row.plugin, name: row.name } : null;
}

/** 所有会话的挂载快照（会话被销毁后由 reconcile 清理）。 */
export function listPersonas() {
	return [...activePersonas.entries()].map(([sessionId, row]) => ({ sessionId, plugin: row.plugin, name: row.name }));
}

/** 会话已不在运行 → 清掉它的撤销记录（disposer 早已随 scope 失效）。 */
export function reconcilePersonas(ctx) {
	const agents = typeof ctx?.get === "function" ? ctx.get("agents") : undefined;
	if (!agents || typeof agents.get !== "function") return;
	const live = new Set(agents.list().map((agent) => agent.id));
	for (const sessionId of [...activePersonas.keys()]) {
		if (!live.has(sessionId)) activePersonas.delete(sessionId);
	}
}

/**
 * 给一个运行中的会话注入（或替换）专家人设。同一会话可反复调用：先摘旧的再装新的。
 * @param {object} ctx - 插件宿主上下文。
 * @param {string} sessionId - 目标会话。
 * @param {object} spec - { plugin, name, personaText }。
 * @returns {{ok: true, plugin: string, name: string, replaced: boolean}}
 */
export function attachPersona(ctx, sessionId, spec) {
	const id = String(sessionId || "").trim();
	if (!id) throw new Error("缺少会话 id");
	const text = String(spec?.personaText || "").trim();
	if (!text) throw new Error("人设内容为空，无法挂载");
	const { agentCtx, error } = agentCtxOf(ctx, id);
	if (error) throw new Error(error);
	const prompt = agentCtx.systemPrompt;
	if (!prompt || typeof prompt.section !== "function") {
		throw new Error("该会话没有 systemPrompt 服务，无法注入人设");
	}
	const replaced = clearPersona(id);
	// 与 dsh-persona 同款：同名 section + 同一处 order = 遮蔽该会话的部署人设前缀。
	const disposer = prompt.section({
		name: PERSONA_PREFIX_SECTION,
		order: typeof prompt.getSectionOrder === "function"
			? prompt.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX")
			: 0,
		text,
	});
	activePersonas.set(id, {
		plugin: String(spec?.plugin || ""),
		name: String(spec?.name || spec?.plugin || "专家"),
		disposer,
	});
	// 防泄漏：超出上限时丢掉最早的记录（其 disposer 一并撤销）。
	while (activePersonas.size > MAX_SESSIONS) {
		const oldest = activePersonas.keys().next().value;
		clearPersona(oldest);
	}
	return { ok: true, plugin: String(spec?.plugin || ""), name: String(spec?.name || spec?.plugin || "专家"), replaced };
}

/** 摘掉某会话的专家人设。@returns {{ok: true, removed: boolean}} */
export function detachPersona(ctx, sessionId) {
	const id = String(sessionId || "").trim();
	if (!id) throw new Error("缺少会话 id");
	return { ok: true, removed: clearPersona(id) };
}
