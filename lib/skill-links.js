// 技能链接位（Skill 看板启停开关的共享源警告）。
//
// 为什么不能直接比较「传入 path 与 realpath」：宿主 dsh-skill-filesystem 在
// parseSkillFile 里返回的 skill.path **本身就是 realpath**（readSkillText 先 realpath
// 再读清单）。所以链接技能的 path 永远等于目标路径，朴素比较会恒为 false——2.5.2 首版
// 就是这样漏掉了真实警告。真正的入口要从 skills 根目录里按 realpath 回查
// （lib/skill-remove.js 的 locateSkillEntry），这里只做一层看板可用的投影。
//
// 判定口径：
//   - 根内直接子项是链接（链接本身就是技能入口）→ linked:true，给出目标 realpath；
//   - skills 根目录自身是链接 → linked:true（整棵库共享）；
//   - 祖先链接 / 普通目录 / 找不到入口 → linked:false，不报假警告。
import { describeSkillEntryLink } from './skill-remove.js';

/**
 * @param {{ name?: string, source?: string, path?: string }} skill 宿主注册表条目
 * @param {{ cwd?: string, home?: string }} [options]
 * @returns {Promise<{ linked: boolean, realPath?: string }>}
 */
export async function describeSkillLink(skill, options = {}) {
  return describeSkillEntryLink(skill, options);
}
