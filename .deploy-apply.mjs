// 部署：仓库 lib/ → 运行时副本 lib/，仅复制 4 新增 + 4 更新，逐文件校验哈希
// 用法：node .deploy-apply.mjs            （预演，不写盘）
//       node .deploy-apply.mjs --apply    （真实写盘）
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const APPLY = process.argv.includes("--apply");
const REPO = "D:/桌面/AI Port/DSH plugins/dsh-armory/lib";
const RUN = join(homedir(), ".dsh", "profiles", "desktop", "node_modules", "dsh-armory", "lib");

const sha = async (p) => {
	try {
		const buf = await readFile(p);
		return createHash("sha256").update(buf).digest("hex").toUpperCase();
	} catch {
		return null;
	}
};

// 与 .deploy-diff.mjs 同源的判定，避免两处口径漂移
const repoFiles = (await readdir(REPO)).filter((n) => n.endsWith(".js")).sort();
const plan = [];
for (const name of repoFiles) {
	const a = await sha(join(REPO, name));
	const b = await sha(join(RUN, name));
	if (a === b) continue;
	plan.push({ name, kind: b ? "更新" : "新增", from: a, to: b });
}

console.log(`模式：${APPLY ? "真实写盘" : "预演（不写盘）"}`);
console.log(`计划部署 ${plan.length} 个文件：`);
for (const p of plan) console.log(`  [${p.kind}] ${p.name}\n        旧=${p.to ?? "(无)"}\n        新=${p.from}`);

if (!plan.length) {
	console.log("运行时副本已与仓库一致，无需部署。");
	process.exit(0);
}

if (!APPLY) {
	console.log("\n预演结束。加 --apply 参数才会真正写盘。");
	process.exit(0);
}

// 先备份运行时旧文件（可回滚），再覆盖——部署是可回退操作
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = join(RUN, `..\\.bak-deploy-${stamp}`);
await mkdir(backupDir, { recursive: true });
const backedUp = [];
for (const p of plan) {
	if (p.kind !== "更新") continue;
	const dst = join(RUN, p.name);
	await copyFile(dst, join(backupDir, p.name));
	const check = await sha(join(backupDir, p.name));
	if (check !== p.to) throw new Error(`备份校验失败：${p.name}（期望 ${p.to}，实际 ${check}）`);
	backedUp.push(p.name);
}
console.log(`\n已备份 ${backedUp.length} 个旧文件到：${backupDir}`);

let okCount = 0;
const failed = [];
for (const p of plan) {
	const src = join(REPO, p.name);
	const dst = join(RUN, p.name);
	try {
		await copyFile(src, dst);
		const after = await sha(dst);
		if (after === p.from) {
			console.log(`  ✔ ${p.name}  已部署，哈希校验一致 ${after.slice(0, 16)}…`);
			okCount++;
		} else {
			failed.push(`${p.name}：写后哈希不符（期望 ${p.from}，实际 ${after}）`);
			console.log(`  ✘ ${p.name}  写后哈希不符`);
		}
	} catch (e) {
		failed.push(`${p.name}：${e.message}`);
		console.log(`  ✘ ${p.name}  ${e.message}`);
	}
}

console.log(`\n部署结果：成功 ${okCount} / ${plan.length}，失败 ${failed.length}`);
if (failed.length) {
	failed.forEach((f) => console.log(`  - ${f}`));
	process.exitCode = 1;
} else {
	// 部署记录：可追溯（架构师 §8.7.3 要求「更新动作必须出现在部署记录里」）
	const stamp = new Date().toISOString();
	const record = {
		deployedAt: stamp,
		source: REPO,
		target: RUN,
		mode: "manual-copy (.deploy-apply.mjs)",
		files: plan.map((p) => ({ name: p.name, kind: p.kind, sha256: p.from })),
	};
	const recPath = "D:/桌面/AI Port/DSH plugins/dsh-armory/docs/.deploy-record.json";
	let history = [];
	try {
		history = JSON.parse(await readFile(recPath, "utf8"));
		if (!Array.isArray(history)) history = [];
	} catch {
		history = [];
	}
	history.push(record);
	await writeFile(recPath, JSON.stringify(history, null, 2), "utf8");
	console.log(`部署记录已追加：${recPath}（累计 ${history.length} 条）`);
}
