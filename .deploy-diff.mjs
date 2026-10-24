// 只读比对：仓库 lib/ vs 运行时副本 lib/，按 SHA-256 分类（不写任何文件）
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const REPO = "D:/桌面/AI Port/DSH plugins/dsh-armory/lib";
const RUN = join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "dsh-armory", "lib");

const sha = async (p) => {
	try {
		const buf = await readFile(p);
		return createHash("sha256").update(buf).digest("hex").toUpperCase() + ` (${buf.length}B)`;
	} catch {
		return null;
	}
};

const listJs = async (dir) => {
	try {
		return (await readdir(dir)).filter((n) => n.endsWith(".js")).sort();
	} catch (e) {
		console.error(`目录不可读：${dir} → ${e.message}`);
		return [];
	}
};

const repoFiles = await listJs(REPO);
const runFiles = await listJs(RUN);
console.log(`仓库 lib/ JS 文件数 = ${repoFiles.length}`);
console.log(`运行时 lib/ JS 文件数 = ${runFiles.length}`);
console.log(`RUNTIME_LIB = ${RUN}`);
console.log("");

const all = [...new Set([...repoFiles, ...runFiles])].sort();
const add = [];
const upd = [];
const orphan = [];
const same = [];

for (const name of all) {
	const a = await sha(join(REPO, name));
	const b = await sha(join(RUN, name));
	if (!b) add.push(`${name}  repo=${a}`);
	else if (!a) orphan.push(`${name}  runtime=${b}`);
	else if (a !== b) upd.push(`${name}\n      repo   =${a}\n      runtime=${b}`);
	else same.push(`${name}  ${a}`);
}

const dump = (title, rows) => {
	console.log(`=== ${title} (${rows.length}) ===`);
	rows.forEach((r) => console.log(`  ${r}`));
	console.log("");
};
dump("缺失·需新增到运行时", add);
dump("内容不同·需覆盖", upd);
dump("运行时多出的孤儿", orphan);
dump("已一致", same);

const total = add.length + upd.length + orphan.length + same.length;
console.log(`合计 ${total} 个文件：新增 ${add.length} / 更新 ${upd.length} / 孤儿 ${orphan.length} / 一致 ${same.length}`);
console.log(`判定：${add.length === 0 && upd.length === 0 ? "已同步" : "需部署"}`);
