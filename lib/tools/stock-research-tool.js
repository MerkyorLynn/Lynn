/**
 * stock-research-tool.js — 股票深度研究工具（stock_research）
 *
 * 客户端代理工具：调用 Brain API 的 Tushare 端点获取完整财务数据。
 * 不需要本地安装 Python/Tushare。
 */
import { Type } from "@sinclair/typebox";
import { t } from "../../server/i18n.js";
import { readSignedClientAgentHeaders } from "../../core/client-agent-identity.js";
import { BRAIN_API_ROOTS } from "../../shared/brain-provider.js";

const STOCK_RESEARCH_PATH = "/stock-research";

function normalizeRoot(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function resolveStockResearchRoots() {
  const override = normalizeRoot(process.env.LYNN_STOCK_RESEARCH_API_ROOT || "");
  return [...new Set([override, ...BRAIN_API_ROOTS.map(normalizeRoot)].filter(Boolean))];
}

function buildStockResearchUrl(root, tsCode, name) {
  const url = new URL(`${root}${STOCK_RESEARCH_PATH}`);
  url.searchParams.set("code", tsCode);
  if (name) url.searchParams.set("name", name);
  return url;
}

async function fetchStockResearch(tsCode, name) {
  const roots = resolveStockResearchRoots();
  if (roots.length === 0) throw new Error("Brain API root 未配置");

  const errors = [];
  for (let i = 0; i < roots.length; i++) {
    const url = buildStockResearchUrl(roots[i], tsCode, name);
    try {
      const resp = await fetch(url, {
        headers: {
          Accept: "application/json",
          ...readSignedClientAgentHeaders({ method: "GET", pathname: STOCK_RESEARCH_PATH }),
        },
        signal: AbortSignal.timeout(35_000),
      });
      const text = await resp.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch {}
      if (!resp.ok) throw new Error(data?.error || text?.slice(0, 120) || `HTTP ${resp.status}`);
      if (!data || typeof data !== "object") throw new Error("empty JSON response");
      if (data.error) throw new Error(data.error);
      return data;
    } catch (err) {
      errors.push(`endpoint ${i + 1}: ${err?.message || String(err)}`);
    }
  }
  throw new Error(errors.join(" | "));
}

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
        const data = await fetchStockResearch(tsCode, params.name || "");
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
