/**
 * 预取上下文 — 离线计算与本地预取
 *
 * 从 server/routes/chat.js 提取。负责本地精确计算（预算等）和
 * report-research 预取决策。
 */
export function shouldPrefetchReportContext(reportKind, currentModelInfo) {
  if (!reportKind) return false;
  if (!currentModelInfo?.isBrain) return true;
  return new Set([
    "market_weather_brief", "weather", "sports", "market", "news",
  ]).has(reportKind);
}

export function shouldSuppressLocalToolPrefetch(text) {
  const source = String(text || "");
  return /(?:不要|不必|不用|无需|别|勿).{0,12}(?:调用|使用|用).{0,8}(?:工具|搜索|联网|查询|检索)/.test(source)
    || /(?:不要|不必|不用|无需|别|勿).{0,8}(?:搜索|联网|查询|检索)/.test(source)
    || /(?:只|仅)(?:回复|输出|回答)\s*[：:]/.test(source);
}

export function prefetchToolNameForKind(kind) {
  if (kind === "market_weather_brief") return "market_weather_brief";
  if (kind === "weather") return "weather";
  if (kind === "sports") return "sports_score";
  if (kind === "market" || kind === "stock") return "stock_market";
  if (kind === "news") return "live_news";
  return "web_search";
}

function parseLooseAmount(value) {
  const n = Number(String(value || "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function buildBudgetCalculationContext(text) {
  const source = String(text || "");
  if (!/(?:月收入|收入)/.test(source) || !/(?:攒|存|储蓄|存款)/.test(source)) return "";

  const income = parseLooseAmount(source.match(/月收入\s*[：:]?\s*[¥￥]?\s*([\d,\s]+)/)?.[1]);
  const rent = parseLooseAmount(source.match(/房租\s*[：:]?\s*[¥￥]?\s*([\d,\s]+)/)?.[1]);
  const fixed = parseLooseAmount(source.match(/固定支出\s*[：:]?\s*[¥￥]?\s*([\d,\s]+)/)?.[1]);
  const months = parseLooseAmount(source.match(/(\d+)\s*个?\s*月/)?.[1]);
  const goal = parseLooseAmount(
    source.match(/(?:攒|存|储蓄|存款)\s*[¥￥]?\s*([\d,\s]+)/)?.[1]
      || source.match(/目标(?:金额|存款|储蓄)?\s*[：:]?\s*[¥￥]?\s*([\d,\s]+)/)?.[1],
  );

  if (![income, rent, fixed, months, goal].every((n) => Number.isFinite(n) && n > 0)) return "";
  const fixedSpend = rent + fixed;
  const remainingBeforeSaving = income - fixedSpend;
  const monthlySaving = goal / months;
  const disposableAfterSaving = remainingBeforeSaving - monthlySaving;
  const fmt = (n) => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/\.00$/, "");

  return [
    "【系统已完成本地精确计算】",
    "请直接使用下面这些数字回答用户，不要重新心算，不要输出损坏的 Markdown 表格；如果要列表，优先用短句或要点。",
    `月收入：${fmt(income)}`,
    `房租：${fmt(rent)}`,
    `固定支出：${fmt(fixed)}`,
    `房租+固定支出：${fmt(fixedSpend)}`,
    `未储蓄前每月剩余：${fmt(remainingBeforeSaving)}`,
    `目标金额：${fmt(goal)}`,
    `目标周期：${fmt(months)} 个月`,
    `每月需要存：${fmt(monthlySaving)}`,
    `完成储蓄后每月可支配：${fmt(disposableAfterSaving)}`,
    "现实建议：若可支配金额偏紧，优先建议延长到 12 个月或降低月存款，不要建议全部压缩基本生活支出。",
  ].join("\n");
}
