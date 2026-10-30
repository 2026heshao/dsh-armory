// workspace-runtime 的宿主依赖替身（仅本套件使用）。
// 为什么需要：lib/workspace-runtime.js 静态导入 @deepseek-ai/dsh-atomic-write，
// 而 CI 按 .github/workflows/ci.yml 只装 yaml —— 真宿主包在 CI 上不存在。
// 本加载器把该裸导入重定向到 test/stubs/atomic-write.mjs，其余解析保持原样。
const STUB = new URL("./stubs/atomic-write.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
	if (specifier === "@deepseek-ai/dsh-atomic-write") return { url: STUB, shortCircuit: true };
	return nextResolve(specifier, context);
}
