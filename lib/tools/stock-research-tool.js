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

function exchangeForAStockCode(code) {
  if (/^6/.test(code)) return "SH";
  if (/^[03]/.test(code)) return "SZ";
  if (/^[48]/.test(code)) return "BJ";
  return "";
}

export function normalizeStockResearchTsCode(rawCode) {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) {
    return { ok: false, message: "请提供股票代码，如 688629.SH" };
  }
  if (/\bHK\b|HKG|NYSE|NASDAQ|^\d{4,5}\.HK$/i.test(code) || /^[A-Z]{1,5}$/.test(code)) {
    return {
      ok: false,
      message: "stock_research 仅支持 A 股深度财务接口；港股/美股报价请使用 stock_market 行情工具。",
    };
  }

  const match = code.match(/^([0368]\d{5})(?:\.(SH|SZ|BJ))?$/i);
  if (!match) {
    return {
      ok: false,
      message: `不是有效 A 股代码：${code}。stock_research 只接受 0/3/6/4/8 开头的 6 位 A 股代码，例如 688629.SH。`,
    };
  }

  const digits = match[1];
  const expectedExchange = exchangeForAStockCode(digits);
  const explicitExchange = match[2]?.toUpperCase() || "";
  if (!expectedExchange) {
    return {
      ok: false,
      message: `无法识别 A 股交易所：${code}。请使用类似 688629.SH / 002639.SZ / 430047.BJ 的代码。`,
    };
  }
  if (explicitExchange && explicitExchange !== expectedExchange) {
    return {
      ok: false,
      message: `股票代码与交易所后缀不匹配：${code}，建议使用 ${digits}.${expectedExchange}。`,
    };
  }

  return { ok: true, tsCode: `${digits}.${expectedExchange}` };
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
      const normalized = normalizeStockResearchTsCode(params.code);
      if (!normalized.ok) {
        return {
          content: [{ type: "text", text: normalized.message }],
          details: { rejected: true, reason: "invalid_a_share_code" },
        };
      }

      try {
        const data = await fetchStockResearch(normalized.tsCode, params.name || "");
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
