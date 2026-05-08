// Brain v2 · web_search tool
// Promise.allSettled 多源聚合: Zhipu + MiMo + Bocha/Tavily/Serper (when configured)
// 5min LRU 缓存,14s 总预算
import { makeLruCache, aggregateAllSettled } from './_helpers.js';

const cache = makeLruCache(200, 5 * 60 * 1000);
const BUDGET_MS = 14_000;
const NL = String.fromCharCode(10);

function envOr(name, fallback = '') { return process.env[name] || fallback; }

// ── racers ────────────────────────────────────────────────────

async function searchZhipu(query, signal) {
  const key = envOr('ZHIPU_KEY');
  if (!key) throw new Error('ZHIPU_KEY missing');
  const base = envOr('ZHIPU_LITE_BASE', 'https://open.bigmodel.cn/api/paas/v4');
  const resp = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model: 'glm-4-flash',
      messages: [{ role: 'user', content: query }],
      tools: [{ type: 'web_search', web_search: { enable: true, search_result: true } }],
      stream: false,
      max_tokens: 50,
    }),
    signal,
  });
  if (!resp.ok) throw new Error('zhipu HTTP ' + resp.status);
  const data = await resp.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('zhipu empty msg');
  let info = '';
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (tc.type === 'web_search' && tc.web_search?.search_result) {
        for (const sr of tc.web_search.search_result) {
          info += '[' + sr.title + '](' + sr.link + '): ' + (sr.content || '') + NL;
        }
      }
    }
  }
  const summary = msg.content || '';
  const out = (info ? '搜索结果:' + NL + info + NL : '') + (summary ? '摘要: ' + summary : '');
  if (!out.trim()) throw new Error('zhipu empty result');
  return out.trim();
}

async function searchMimo(query, signal) {
  const key = envOr('MIMO_SEARCH_KEY');
  if (!key) throw new Error('MIMO_SEARCH_KEY missing');
  const base = envOr('MIMO_SEARCH_BASE', 'https://token-plan-cn.xiaomimimo.com/v1');
  const model = envOr('MIMO_SEARCH_MODEL', 'mimo-v2.5-pro');
  const resp = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: query }],
      enable_search: true,
      max_completion_tokens: 2000,
      thinking: { type: 'disabled' },
      stream: false,
    }),
    signal,
  });
  if (!resp.ok) throw new Error('mimo HTTP ' + resp.status);
  const data = await resp.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('mimo empty msg');
  let info = '';
  for (const ann of (msg.annotations || [])) {
    if (ann.type === 'url_citation') {
      info += '[' + (ann.title || '') + '](' + (ann.url || '') + '): ' + (ann.summary || '') + NL;
    }
  }
  const summary = msg.content || '';
  const out = (info ? '搜索结果:' + NL + info + NL : '') + (summary ? '摘要: ' + summary : '');
  if (!out.trim()) throw new Error('mimo empty result');
  return out.trim();
}

async function searchBocha(query, signal) {
  const key = envOr('BOCHA_KEY');
  if (!key) throw new Error('BOCHA_KEY missing');
  const resp = await fetch('https://api.bochaai.com/v1/web-search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({ query, summary: true, count: 8 }),
    signal,
  });
  if (!resp.ok) throw new Error('bocha HTTP ' + resp.status);
  const data = await resp.json();
  const items = data?.data?.webPages?.value || [];
  if (!items.length) throw new Error('bocha empty');
  return items.map((it, i) => (i + 1) + '. ' + it.name + NL + '   ' + it.url + NL + '   ' + (it.snippet || it.summary || '').slice(0, 240)).join(NL);
}

async function searchTavily(query, signal) {
  const key = envOr('TAVILY_KEY');
  if (!key) throw new Error('TAVILY_KEY missing');
  const resp = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: key, query, search_depth: 'basic', max_results: 8 }),
    signal,
  });
  if (!resp.ok) throw new Error('tavily HTTP ' + resp.status);
  const data = await resp.json();
  const items = data?.results || [];
  if (!items.length) throw new Error('tavily empty');
  return items.map((it, i) => (i + 1) + '. ' + it.title + NL + '   ' + it.url + NL + '   ' + (it.content || '').slice(0, 240)).join(NL);
}

async function searchSerper(query, signal) {
  const key = envOr('SERPER_KEY');
  if (!key) throw new Error('SERPER_KEY missing');
  const resp = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': key },
    body: JSON.stringify({ q: query, num: 8 }),
    signal,
  });
  if (!resp.ok) throw new Error('serper HTTP ' + resp.status);
  const data = await resp.json();
  const items = data?.organic || [];
  if (!items.length) throw new Error('serper empty');
  return items.map((it, i) => (i + 1) + '. ' + it.title + NL + '   ' + it.link + NL + '   ' + (it.snippet || '').slice(0, 240)).join(NL);
}

// ── public webSearch ───────────────────────────────────────────

const RACERS = [
  { source: 'zhipu',  fn: (q, s) => searchZhipu(q, s) },
  { source: 'mimo',   fn: (q, s) => searchMimo(q, s) },
  { source: 'bocha',  fn: (q, s) => searchBocha(q, s),  optional: true, envKey: 'BOCHA_KEY' },
  { source: 'tavily', fn: (q, s) => searchTavily(q, s), optional: true, envKey: 'TAVILY_KEY' },
  { source: 'serper', fn: (q, s) => searchSerper(q, s), optional: true, envKey: 'SERPER_KEY' },
];

export async function webSearch(query, { log } = {}) {
  const q = String(query || '').trim();
  if (!q) return JSON.stringify({ error: 'empty query' });
  const cached = cache.get(q.toLowerCase());
  if (cached) {
    log && log('info', 'tool-exec/web_search cache HIT q=' + q);
    return cached;
  }

  const ctrl = new AbortController();
  const racers = RACERS
    .filter(r => !r.optional || envOr(r.envKey))
    .map(r => ({ source: r.source, fn: () => r.fn(q, ctrl.signal) }));

  log && log('info', 'tool-exec/web_search start q=' + q + ' racers=' + racers.map(r => r.source).join(','));
  const settled = await aggregateAllSettled(racers, 14_000);
  ctrl.abort();  // cancel any laggards

  const wins = settled.filter(s => s.ok && s.value && String(s.value).trim());
  if (wins.length === 0) {
    log && log('warn', 'tool-exec/web_search all racers failed: ' + settled.map(s => s.source + (s.ok ? '✓' : '✗:' + s.error)).join(', '));
    return JSON.stringify({ error: 'all search sources failed', detail: settled.map(s => ({ source: s.source, ok: s.ok, error: s.error })) });
  }
  log && log('info', 'tool-exec/web_search ' + wins.length + '/' + settled.length + ' sources OK');
  const aggregated = wins.map(w => '── ' + w.source + ' ──' + NL + w.value).join(NL + NL);
  cache.set(q.toLowerCase(), aggregated);
  return aggregated;
}

export const __testing__ = { searchZhipu, searchMimo, searchBocha, searchTavily, searchSerper, cache };
