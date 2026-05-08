// Brain v2 · tool-exec/parallel_research
// 接收 {queries: [{tool, args, label?}, ...]},并行调度 dispatcher
// 调用方需注入 dispatchFn(name, argsObj) → Promise<resultStr>
import { aggregateAllSettled } from './_helpers.js';

const ALLOWED = new Set([
  'web_search', 'stock_market', 'weather', 'live_news', 'sports_score',
  'exchange_rate', 'calendar', 'unit_convert', 'express_tracking',
]);
const BUDGET_MS = Number(process.env.BRAIN_V2_PARALLEL_RESEARCH_BUDGET_MS || 14_000);
const MIN_SUCCESS = Number(process.env.BRAIN_V2_PARALLEL_RESEARCH_MIN_SUCCESS || 2);
const SETTLE_WINDOW_MS = Number(process.env.BRAIN_V2_PARALLEL_RESEARCH_SETTLE_WINDOW_MS || 120);

export async function parallelResearch(args, { log, dispatchFn } = {}) {
  const queries = Array.isArray(args && args.queries) ? args.queries : [];
  if (queries.length < 2) return JSON.stringify({ error: 'parallel_research 至少需要 2 个 queries(单查询请直接调对应工具)' });
  if (queries.length > 8) return JSON.stringify({ error: 'parallel_research 最多支持 8 个并行 query' });
  for (const q of queries) {
    if (!q || typeof q !== 'object') return JSON.stringify({ error: '每个 query 必须是 {tool, args, label?} 对象' });
    if (!q.tool || !ALLOWED.has(q.tool)) return JSON.stringify({ error: `子工具 '${q?.tool}' 不在白名单 (${[...ALLOWED].join(', ')})` });
    if (!q.args || typeof q.args !== 'object') return JSON.stringify({ error: `query for tool '${q.tool}' 缺少 args 对象` });
  }
  if (typeof dispatchFn !== 'function') return JSON.stringify({ error: 'parallel_research: dispatchFn not injected' });

  const t0 = Date.now();
  const racers = queries.map((q, i) => ({
    source: q.label || ('q' + (i + 1)),
    fn: async () => {
    const label = q.label || ('q' + (i + 1));
    const subResult = await dispatchFn(q.tool, q.args);
    let parsed = subResult;
    try { parsed = JSON.parse(subResult); } catch { /* keep string */ }
    return { index: i, label, tool: q.tool, args: q.args, result: parsed, ok: true };
    },
  }));
  const settled = await aggregateAllSettled(racers, BUDGET_MS, {
    minSuccess: Math.min(Math.max(1, MIN_SUCCESS), queries.length),
    settleWindowMs: SETTLE_WINDOW_MS,
  });
  const seen = new Set();
  const results = [];
  for (const entry of settled) {
    const q = queries.find((item, idx) => (item.label || ('q' + (idx + 1))) === entry.source);
    const index = queries.findIndex((item, idx) => (item.label || ('q' + (idx + 1))) === entry.source);
    if (!q || seen.has(entry.source)) continue;
    seen.add(entry.source);
    if (entry.ok) {
      results.push(entry.value);
    } else {
      results.push({
        index,
        label: q.label || ('q' + (index + 1)),
        tool: q.tool,
        args: q.args,
        error: entry.error || 'unknown error',
        ok: false,
      });
    }
  }
  const elapsedMs = Date.now() - t0;
  const done = results.length;
  const ok = results.filter(r => r && r.ok).length;
  log && log('info', 'tool-exec/parallel_research ' + ok + '/' + queries.length + ' sub-queries returned in ' + elapsedMs + 'ms');
  return JSON.stringify({ parallel: true, count: queries.length, returned: done, elapsedMs, budgetMs: BUDGET_MS, partial: done < queries.length, results });
}

export const __testing__ = { ALLOWED };
