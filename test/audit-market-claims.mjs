// 核对 README 宣传数字的真实来源（只读，不写盘）：
//   L35: SkillHub 19万+ 技能 / WorkBuddy 316 个连接器
//   投稿 yml: 429 位专家 / SkillHub 190k+
// 这些数字写进了 README 与投稿 yml，若与上游实际不符就是虚假宣传，必须改。
// 注意：直连上游（WorkBuddy COS / SkillHub），与用户在面板里看到的是同一数据源。
// （内置 MCP 目录已从市场移除，原「47 个一手核实的内置服务」一节随之撤销。）
import { wbConnectorCatalog, wbSkillCatalog } from "../lib/wb-market.js";
import { wbExpertCatalog } from "../lib/expert-market.js";

const r = (label, ok, extra = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);

// 1) WorkBuddy 连接器数
try {
  const c = await wbConnectorCatalog();
  r("WorkBuddy 连接器实际数量", true, `got ${c.connectors?.length ?? "?"}（README 写 316）`);
} catch (e) { r("WorkBuddy 连接器", false, String(e.message || e)); }

// 2) SkillHub 技能总量
try {
  const s = await wbSkillCatalog({ page: 1, pageSize: 1 });
  const total = s.total ?? s.skills?.length ?? "?";
  r("SkillHub 技能总量", true, `got ${total}（README 写 19万+/190k+）`);
} catch (e) { r("SkillHub 目录", false, String(e.message || e)); }

// 3) WorkBuddy 专家数
try {
  const e = await wbExpertCatalog();
  r("WorkBuddy 专家实际数量", true, `got ${e.total}（README/投稿写 429）`);
} catch (e2) { r("专家目录", false, String(e2.message || e2)); }
