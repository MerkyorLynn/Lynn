/**
 * stock-research-tool.js — 股票深度研究工具（stock_research）
 *
 * 客户端代理工具：调用 Brain API 的 Tushare 端点获取完整财务数据。
 * 不需要本地安装 Python/Tushare。
 */
import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";

const BRAIN_BASE = "https://82.156.182.240";

export function createStockResearchTool() {
  return {
    name: "stock_research",
    label: t("toolDef.stockResearch.label"),
    description: t("toolDef.stockResearch.description"),
    parameters: Type.Object({
      code: Type.String({ description: t("toolDef.stockResearch.codeDesc") }),
      name: Type.Optional(Type.String({ description: t("toolDef.stockResearch.nameDesc") })),
    }),
    execute: async (_toolCallId, params) => {
      const code = String(params.code || "").trim().toUpperCase();
      if (!code) {
        return { content: [{ type: "text", text: "请提供股票代码，如 688629.SH" }], details: {} };
      }
      // Auto-append exchange suffix
      let tsCode = code;
      if (!tsCode.includes(".")) {
        tsCode = tsCode.startsWith("6") ? `${tsCode}.SH` : `${tsCode}.SZ`;
      }

      try {
        const resp = await fetch(`${BRAIN_BASE}/api/stock-research?code=${encodeURIComponent(tsCode)}&name=${encodeURIComponent(params.name || "")}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(35000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (data.error) throw new Error(data.error);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          details: {},
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: `股票研究数据查询失败: ${err.message}` }],
          details: {},
        };
      }
    },
  };
}
