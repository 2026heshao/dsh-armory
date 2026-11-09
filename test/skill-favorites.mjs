// 技能收藏数据层（lib/skill-favorites.js）回归：
//   - 读取永不抛错：缺失 / 坏 JSON / 路径是目录 / 结构不对 → 空集合；
//   - 写入语义：同名唯一、重复收藏置顶、取消收藏幂等、20 上限淘汰最旧；
//   - 归一：name 120 / description 200 截断、坏时间戳回落 0、手改重复条目去重；
//   - 原子写：成功后目录里没有 .tmp 残留，文件可被 JSON.parse。
//
// 全部落在 mkdtemp 下，零网络、绝不碰真实 ~/.dsh。运行：
//   node ./test/skill-favorites.mjs

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	SKILL_FAVORITES_MAX,
	SKILL_FAVORITE_DESC_MAX,
	SKILL_FAVORITE_NAME_MAX,
	readSkillFavorites,
	setSkillFavorite,
	skillFavoritesPath,
} from "../lib/skill-favorites.js";

let failures = 0;
let checks = 0;
const ok = (name, condition, extra = "") => {
	checks += 1;
	const pass = !!condition;
	if (!pass) failures += 1;
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}${extra ? `  ${extra}` : ""}`);
	return pass;
};
const section = (title) => console.log(`\n── ${title} ─────────────────────────────────────────────`);

const roots = [];
const makeRoot = async () => {
	const root = await mkdtemp(join(tmpdir(), "dsh-armory-fav-"));
	roots.push(root);
	return root;
};
const settle = async (promise) => {
	try {
		const value = await promise;
		return { ok: true, value };
	} catch (error) {
		return { ok: false, error };
	}
};
const names = (doc) => doc.skills.map((row) => row.name);

section("0. 路径与缺失文件");
{
	const root = await makeRoot();
	const path = skillFavoritesPath({ rootDir: root });
	ok("文件落在注入的 rootDir 下", path === join(root, "skill-favorites.json"), path);
	const doc = await readSkillFavorites({ rootDir: root });
	ok("文件缺失 → version 1 + 空集合", doc.version === 1 && Array.isArray(doc.skills) && doc.skills.length === 0);
}

section("1. 入参校验：脏写入必须拒绝");
{
	const root = await makeRoot();
	const emptyName = await settle(setSkillFavorite({ name: "   ", favorite: true }, { rootDir: root }));
	ok("空 name 抛错", emptyName.ok === false && /名称/.test(String(emptyName.error?.message)));
	const noFavorite = await settle(setSkillFavorite({ name: "pdf" }, { rootDir: root }));
	ok("favorite 非布尔抛错", noFavorite.ok === false && /布尔/.test(String(noFavorite.error?.message)));
	const badFavorite = await settle(setSkillFavorite({ name: "pdf", favorite: "yes" }, { rootDir: root }));
	ok("favorite 字符串也拒绝（不做真值转换）", badFavorite.ok === false);
	ok("拒绝后不写盘：文件仍不存在", (await settle(readFile(skillFavoritesPath({ rootDir: root }), "utf8"))).ok === false);
}

section("2. 收藏 / 取消 / 重复收藏置顶");
{
	const root = await makeRoot();
	const options = { rootDir: root };
	await setSkillFavorite({ name: "alpha", description: "A", favorite: true }, { ...options, now: 100 });
	await setSkillFavorite({ name: "beta", description: "B", favorite: true }, { ...options, now: 200 });
	await setSkillFavorite({ name: "gamma", description: "C", favorite: true }, { ...options, now: 300 });
	let doc = await readSkillFavorites(options);
	ok("新收藏置顶：gamma → beta → alpha", JSON.stringify(names(doc)) === JSON.stringify(["gamma", "beta", "alpha"]));

	const again = await setSkillFavorite({ name: "alpha", description: "A2", favorite: true }, { ...options, now: 400 });
	doc = await readSkillFavorites(options);
	ok("重复收藏不增条数", doc.skills.length === 3);
	ok("重复收藏移到最前", JSON.stringify(names(doc)) === JSON.stringify(["alpha", "gamma", "beta"]));
	ok("重复收藏更新描述与时间", doc.skills[0].description === "A2" && doc.skills[0].favoritedAt === 400);
	ok("返回体是落盘后的完整清单", JSON.stringify(again.skills) === JSON.stringify(doc.skills));

	const noDesc = await setSkillFavorite({ name: "alpha", favorite: true }, { ...options, now: 500 });
	ok("省略 description 时保留旧描述", noDesc.skills[0].description === "A2" && noDesc.skills[0].favoritedAt === 500);

	const removed = await setSkillFavorite({ name: "gamma", favorite: false }, { ...options, now: 600 });
	doc = await readSkillFavorites(options);
	ok("取消收藏移除该条", JSON.stringify(names(doc)) === JSON.stringify(["alpha", "beta"]));
	ok("取消收藏返回 favorite:false", removed.favorite === false);
	const missing = await settle(setSkillFavorite({ name: "not-there", favorite: false }, { ...options, now: 700 }));
	ok("取消不存在的条目幂等且不抛", missing.ok === true && JSON.stringify(names(missing.value)) === JSON.stringify(["alpha", "beta"]));
}

section("3. 20 条上限：淘汰最旧，返回 evicted");
{
	const root = await makeRoot();
	const options = { rootDir: root };
	for (let i = 1; i <= SKILL_FAVORITES_MAX; i += 1) {
		await setSkillFavorite({ name: `s${String(i).padStart(2, "0")}`, favorite: true }, { ...options, now: i });
	}
	const last = await setSkillFavorite({ name: "s-new", favorite: true }, { ...options, now: 1000 });
	const doc = await readSkillFavorites(options);
	ok(`上限常驻 ${SKILL_FAVORITES_MAX} 条`, doc.skills.length === SKILL_FAVORITES_MAX, `len=${doc.skills.length}`);
	ok("最新一条在最前", doc.skills[0].name === "s-new");
	ok("最旧的 s01 被淘汰", !names(doc).includes("s01") && names(doc).includes("s02"));
	ok("evicted 返回被淘汰的名字", last.evicted === "s01", `evicted=${last.evicted}`);
	ok("返回列表也截到上限", last.skills.length === SKILL_FAVORITES_MAX);
}

section("4. 截断与坏数据归一");
{
	const root = await makeRoot();
	const options = { rootDir: root };
	const longName = "名".repeat(SKILL_FAVORITE_NAME_MAX + 30);
	const longDesc = "述".repeat(SKILL_FAVORITE_DESC_MAX + 50);
	const res = await setSkillFavorite({ name: longName, description: longDesc, favorite: true }, { ...options, now: 1 });
	ok("name 截到 120", res.skills[0].name.length === SKILL_FAVORITE_NAME_MAX);
	ok("description 截到 200", res.skills[0].description.length === SKILL_FAVORITE_DESC_MAX);

	await writeFile(skillFavoritesPath(options), JSON.stringify({
		version: 9,
		skills: [
			{ name: "dup", description: "old", favoritedAt: 10 },
			{ name: "dup", description: "new", favoritedAt: 20 },
			{ name: "", description: "empty", favoritedAt: 30 },
			null,
			"oops",
			{ name: "bad-time", description: 42, favoritedAt: "昨天" },
			{ name: "negative", favoritedAt: -3 },
		],
	}), "utf8");
	const doc = await readSkillFavorites(options);
	ok("同名读侧只留较新的一条（description=new）", doc.skills.find((row) => row.name === "dup")?.description === "new");
	ok("无名 / 非对象条目被丢弃", !doc.skills.some((row) => !row.name));
	ok("坏时间戳回落 0", doc.skills.find((row) => row.name === "bad-time")?.favoritedAt === 0);
	ok("非字符串描述归一成空串", doc.skills.find((row) => row.name === "bad-time")?.description === "");
	ok("负数时间戳回落 0", doc.skills.find((row) => row.name === "negative")?.favoritedAt === 0);
	ok("读侧保留文件里的 version 数字", doc.version === 9);
	ok("按时间倒序：dup(20) → bad-time(0) → negative(0)", doc.skills[0].name === "dup");
}

section("5. 坏 JSON / 路径是目录：读取永不抛错");
{
	const root = await makeRoot();
	const options = { rootDir: root };
	await writeFile(skillFavoritesPath(options), "{ not json", "utf8");
	const broken = await settle(readSkillFavorites(options));
	ok("坏 JSON 不抛错且返回空集合", broken.ok === true && broken.value.skills.length === 0);

	const root2 = await makeRoot();
	const dirPath = skillFavoritesPath({ rootDir: root2 });
	await mkdir(dirPath, { recursive: true });
	const asDir = await settle(readSkillFavorites({ rootDir: root2 }));
	ok("目标路径是目录时读取也不抛", asDir.ok === true && asDir.value.skills.length === 0);
}

section("6. 原子写：无 .tmp 残留，文件可解析");
{
	const root = await makeRoot();
	const options = { rootDir: root };
	await setSkillFavorite({ name: "atomic", description: "ok", favorite: true }, { ...options, now: 1 });
	const entries = await readdir(root);
	ok("目录里没有 .tmp 临时文件", entries.every((name) => !name.endsWith(".tmp")), entries.join(","));
	const text = await readFile(skillFavoritesPath(options), "utf8");
	let parsed = null;
	try { parsed = JSON.parse(text); } catch { parsed = null; }
	ok("文件是合法 JSON 且 version=1", parsed?.version === 1 && Array.isArray(parsed.skills));
	ok("落盘内容与返回值一致", parsed.skills[0].name === "atomic" && parsed.skills[0].description === "ok");
}

section("7. 取消全部收藏后文件仍合法");
{
	const root = await makeRoot();
	const options = { rootDir: root };
	await setSkillFavorite({ name: "a", favorite: true }, { ...options, now: 1 });
	await setSkillFavorite({ name: "b", favorite: true }, { ...options, now: 2 });
	await setSkillFavorite({ name: "a", favorite: false }, { ...options, now: 3 });
	await setSkillFavorite({ name: "b", favorite: false }, { ...options, now: 4 });
	const doc = await readSkillFavorites(options);
	ok("全部取消后为空", doc.skills.length === 0);
	const parsed = JSON.parse(await readFile(skillFavoritesPath(options), "utf8"));
	ok("空集合仍写入合法文档", parsed.version === 1 && Array.isArray(parsed.skills) && parsed.skills.length === 0);
}

for (const root of roots) await rm(root, { recursive: true, force: true });

console.log(`\n${checks - failures}/${checks} passed`);
console.log(failures === 0 ? "SKILL FAVORITES PASS" : `${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
