// 极简 ZIP 读取器 —— WorkBuddy 连接器市场数据的按需解压。
//
// 为什么自己写而不用 fflate/jszip：本插件的 dependencies 会被**从 GitHub 源码安装**的用户
// 重新拉取（dsh-market 对源码安装会跑 pnpm install），每多一个运行时依赖就多一处「国内网络
// 拉不下来导致整个插件装不上」的故障点。而 Node 自带的 zlib 就能解 DEFLATE——ZIP 容器格式
// 只是「central directory + local header + 数据」三层薄壳，定位条目用不到 100 行。
//
// 用法（见 wb-market.js）：整包 ZIP 落盘一次，之后每个条目都从**缓存的 ZIP**按需解压——
// 连接器市场 24MB、7000+ 条目，全部解压既慢又占内存；实际用到的只有 connectors.json、
// 某个连接器的 mcp.json 和安装技能时的那几十个文件。
import { inflateRawSync } from "node:zlib";

// ZIP 里我们只该见到这两压缩法：0 = store、8 = deflate。
// encrypted（第 0 位 = 1）的包读不了，遇到就如实报错。
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

function u16(buffer, offset) {
  return buffer.readUInt16LE(offset);
}
function u32(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

/**
 * 在 buffer 里从后往前找 EOCD（0x06054b50）。
 * ZIP 允许注释尾随（最长 65535 字节），所以最大回溯范围要盖住它。
 */
function findEocd(buffer) {
  const minEocdSize = 22;
  const maxComment = 0xffff;
  const start = Math.max(0, buffer.length - minEocdSize - maxComment);
  for (let i = buffer.length - minEocdSize; i >= start; i -= 1) {
    if (u32(buffer, i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * 解析 central directory，返回 { entries: Map<lowercased name, {offset, compressedSize, method}>, count }。
 * 名字统一小写做键：ZIP 条目大小写在不同打包工具下不一致（WorkBuddy 包里两种都有），
 * 查询端用 toLowerCase 对齐，调用方不需要关心。
 */
export function readCentralDirectory(buffer) {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error("wb-market: 不是有效的 ZIP 文件（找不到 EOCD）");
  const entryCount = u16(buffer, eocd + 10);
  let cdOffset = u32(buffer, eocd + 16);
  const entries = new Map();
  for (let i = 0; i < entryCount; i += 1) {
    if (u32(buffer, cdOffset) !== 0x02014b50) throw new Error("wb-market: ZIP central directory 损坏");
    const method = u16(buffer, cdOffset + 10);
    const compressedSize = u32(buffer, cdOffset + 20);
    const nameLength = u16(buffer, cdOffset + 28);
    const extraLength = u16(buffer, cdOffset + 30);
    const commentLength = u16(buffer, cdOffset + 32);
    const localOffset = u32(buffer, cdOffset + 42);
    const name = buffer.toString("utf8", cdOffset + 46, cdOffset + 46 + nameLength);
    entries.set(name.toLowerCase(), { offset: localOffset, compressedSize, method });
    cdOffset += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, count: entryCount };
}

/** 从 local header 之后取出条目数据并解压。directory 条目（size 0）返回空 Buffer。 */
function extractEntry(buffer, entry, name) {
  if (entry.compressedSize === 0) return Buffer.alloc(0);
  const localHeader = entry.offset;
  if (u32(buffer, localHeader) !== 0x04034b50) throw new Error(`wb-market: ZIP 条目损坏（${name}）`);
  const fileNameLength = u16(buffer, localHeader + 26);
  const extraFieldLength = u16(buffer, localHeader + 28);
  const dataStart = localHeader + 30 + fileNameLength + extraFieldLength;
  const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize);
  if (entry.method === METHOD_STORE) return Buffer.from(raw);
  if (entry.method === METHOD_DEFLATE) {
    try {
      return inflateRawSync(raw);
    } catch (error) {
      throw new Error(`wb-market: 解压失败（${name}）：${error.message}`);
    }
  }
  throw new Error(`wb-market: 不支持的 ZIP 压缩方法 ${entry.method}（${name}）`);
}

/** 已解析 ZIP 的只读门面。extract 是唯一出口，name 大小写不敏感。 */
export class ZipReader {
  constructor(buffer) {
    this.buffer = buffer;
    const { entries, count } = readCentralDirectory(buffer);
    this.entries = entries;
    this.count = count;
  }
  has(name) {
    return this.entries.has(String(name).toLowerCase());
  }
  extract(name) {
    const key = String(name).toLowerCase();
    const entry = this.entries.get(key);
    if (!entry) throw new Error(`wb-market: ZIP 里没有这个条目（${name}）`);
    return extractEntry(this.buffer, entry, name);
  }
  /** 前缀枚举（小写比较），返回原名的去重列表。技能安装要「拿一个技能目录下的所有文件」时用。 */
  listByPrefix(prefix) {
    const key = String(prefix).toLowerCase();
    const names = [];
    for (const name of this.entries.keys()) {
      if (name.startsWith(key) && name.length > key.length) names.push(name);
    }
    return names.sort();
  }
}
