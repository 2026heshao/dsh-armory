// CI 只安装 `yaml`（见 .github/workflows/ci.yml），而 @deepseek-ai/dsh-atomic-write
// 是宿主内部包，registry 上不存在。本套件只在 mkdtemp 里造文件/坏 JSON，不需要原子写，
// 所以这里只满足导入形状；真被调用就显式失败，绝不假装写成功。
export async function writeFileAtomic() {
	throw new Error("workspace-runtime.test 不应触发原子写");
}
