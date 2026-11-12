// 技能链接位（Skill 看板「启停开关」的符号链接警告数据）。
//
// 为什么单独一层：SKILL.md 的写入会按 realpath 落到真实文件上（见 lib/skill-disable.js），
// 所以当技能目录本身是指向共享 store 的符号链接时，开关改的是共享源文件，共用同一来源的
// 其他 agent 也会一起被禁用。前端拿不到 lstat/realpath，只能由宿主把「这条路径是否经过
// 链接」投影出来；这是一个只读判定，不参与写入决策。
//
// 判定口径：resolve 后的原始路径与 realpath 不一致即视为经过链接（目录链接、清单文件链接、
// 祖先目录链接都算）。Windows 大小写不敏感，比较时统一小写；realpath 失败（文件刚被删、
// 权限不足）一律回落 linked:false，绝不因为探测失败在界面上报一个假警告。
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

/**
 * @param {unknown} path 宿主注册表给出的 skill 路径（目录或 SKILL.md）
 * @param {{ platform?: NodeJS.Platform }} [options]
 * @returns {Promise<{ linked: boolean, realPath?: string }>}
 */
export async function describeSkillLink(path, options = {}) {
  const raw = typeof path === 'string' ? path.trim() : '';
  if (!raw || !isAbsolute(raw)) return { linked: false };
  const resolved = resolve(raw);
  try {
    const real = await realpath(resolved);
    const platform = options.platform || process.platform;
    const same = platform === 'win32'
      ? real.toLowerCase() === resolved.toLowerCase()
      : real === resolved;
    return same ? { linked: false } : { linked: true, realPath: real };
  } catch {
    return { linked: false };
  }
}
