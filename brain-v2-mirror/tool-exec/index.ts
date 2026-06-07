// @ts-nocheck
// Brain v2 · tool-exec dispatcher
// 服务端工具注册表 + 调度器
// 16 个 server tool: web_search + 5 utility + 8 ported + 5 newly ported (stock_market/live_news/stock_research/create_report/create_pptx)
import { webSearch } from './web_search.js';
import { exchangeRate, sportsScore, expressTracking, calendar, unitConvert } from './utility.js';
import { webFetch } from './web_fetch.js';
import { createArtifact } from './create_artifact.js';
import { createPdf } from './create_pdf.js';
import { weather } from './weather.js';
import { parallelResearch } from './parallel_research.js';
import { stockMarket } from './stock_market.js';
import { liveNews } from './live_news.js';
import { stockResearch } from './stock_research.js';
import { createReport } from './create_report.js';
import { createPptx } from './create_pptx.js';

// ── server-side tool definitions(给 model 看的 schema)─────
export const SERVER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web for real-time information (news, prices, docs, current events). Returns aggregated results from multiple sources.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query (any language)' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch the content of a given URL and extract text. Useful for reading articles, docs, API responses. Pair with web_search.',
      parameters: { type: 'object', properties: { url: { type: 'string' }, max_length: { type: 'number', description: 'default 8000' } }, required: ['url'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'weather',
      description: 'Get current weather and 3-day forecast for a city.',
      parameters: { type: 'object', properties: { city: { type: 'string', description: 'City name in Chinese or English' } }, required: ['city'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'exchange_rate',
      description: 'Get real-time forex/currency exchange rates (USD/EUR/GBP/JPY/HKD etc to CNY).',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Currency query e.g. 美元汇率' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'express_tracking',
      description: 'Track express/courier package delivery status by tracking number.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Tracking number' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'sports_score',
      description: 'Get live or recent sports scores and results (football, basketball, tennis, F1, etc).',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Sports query' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calendar',
      description: 'Get date info, holidays, day-of-week, date calculations, countdown to events.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Date query' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'unit_convert',
      description: 'Convert units: temperature, length, weight, area, volume.',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Value with unit e.g. 100公里' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_artifact',
      description: 'Create a rich content preview (HTML page, code snippet, or markdown document).',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['html', 'code', 'markdown'] },
          title: { type: 'string' },
          content: { type: 'string' },
          language: { type: 'string', description: 'Programming language (only for type=code)' },
        },
        required: ['type', 'title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_pdf',
      description: 'Generate a professional PDF document with cover page, headings, tables, callouts.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          author: { type: 'string' },
          type: { type: 'string', enum: ['report', 'proposal', 'analysis', 'general'] },
          accent: { type: 'string', description: 'Accent color hex' },
          content: { type: 'array', items: { type: 'object' } },
        },
        required: ['title', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stock_market',
      description: 'Get stock/commodity prices and market data (A-shares, US stocks, HK stocks, gold, oil, crypto, forex).',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'Stock or commodity query' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'live_news',
      description: 'Get latest breaking news on a topic. Returns recent headlines and summaries (今日/3天/7天 三窗口).',
      parameters: { type: 'object', properties: { query: { type: 'string', description: 'News topic to search for' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stock_research',
      description: 'Comprehensive A-share research from Tushare Pro: 60-day price history, key financials (8 quarters), income statement, top-10 shareholders, valuation. Call before create_report for real data. A-shares only (SH/SZ/BJ).',
      parameters: { type: 'object', properties: { code: { type: 'string', description: 'Stock code with exchange suffix, e.g. 688629.SH or 000001.SZ' }, name: { type: 'string', description: 'Company name (for display)' } }, required: ['code'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_report',
      description: 'Generate a professional dark-themed HTML analysis report from JSON (title + sections[], provide >=3 sections). Each section = {title, type, ...type-specific fields}. By type: metrics -> metrics:[{label,value,change,direction:up|down|neutral}] (KPI cards); text -> content (string) or blocks:[{heading,text}]; table -> headers:[str] + rows:[[str]]; verdict -> items:[{period,range,note}] (prediction cards); warning -> content (alert text).',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          tag: { type: 'string' },
          subtitle: { type: 'string' },
          date: { type: 'string' },
          sections: { type: 'array', description: 'Section objects; shape per the description above', items: { type: 'object' } },
          disclaimer: { type: 'string' },
        },
        required: ['title', 'sections'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_pptx',
      description: 'Generate a PowerPoint (.pptx). slides[] = each {title, layout, body, notes}. layout: title | content (default) | section | two_column. In body, lines starting with "-" are bullets; for two_column split the two columns with "|||". Returns a download URL.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          author: { type: 'string' },
          slides: { type: 'array', description: 'Slide objects; shape per the description above', items: { type: 'object' } },
        },
        required: ['title', 'slides'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'parallel_research',
      description: '并行调用多个查询工具,一轮拿回所有结果。用于多源对比 / 多角度调研。比串行调用快 N 倍——优先在 N≥2 多源场景使用。',
      parameters: {
        type: 'object',
        properties: {
          queries: {
            type: 'array', minItems: 2, maxItems: 8,
            items: {
              type: 'object',
              properties: {
                tool: { type: 'string', enum: ['web_search', 'stock_market', 'weather', 'live_news', 'sports_score', 'exchange_rate', 'calendar', 'unit_convert', 'express_tracking'] },
                args: { type: 'object' },
                label: { type: 'string' },
              },
              required: ['tool', 'args'],
            },
          },
        },
        required: ['queries'],
      },
    },
  },
];

export const SERVER_TOOL_NAMES = new Set(SERVER_TOOLS.map(t => t.function.name));

// ── dispatcher ────────────────────────────────────────────
export async function executeServerTool(name, argsStr, { log } = {}) {
  if (!SERVER_TOOL_NAMES.has(name)) return JSON.stringify({ error: 'tool not handled by brain server: ' + name });
  let args;
  try { args = typeof argsStr === 'string' ? JSON.parse(argsStr || '{}') : (argsStr || {}); }
  catch { return JSON.stringify({ error: 'invalid tool args (not JSON): ' + String(argsStr).slice(0, 200) }); }
  try {
    switch (name) {
      case 'web_search':       return (await webSearch(args.query || '', { log })) || JSON.stringify({ error: 'no results' });
      case 'web_fetch':        return await webFetch(args.url || '', args.max_length || 8000, { log });
      case 'weather':          return await weather(args.city || args.location || args.query || '北京', { log, webSearchFn: (q) => webSearch(q, { log }) });
      case 'exchange_rate':    return await exchangeRate(args.query || '');
      case 'express_tracking': return await expressTracking(args.query || '');
      case 'sports_score':     return await sportsScore(args.query || '');
      case 'calendar':         return calendar(args.query || '');
      case 'unit_convert':     return unitConvert(args.query || '');
      case 'create_artifact':  return await createArtifact(args, { log });
      case 'create_pdf':       return await createPdf(args, { log });
      case 'stock_market':     return await stockMarket(args.query || '', { log, webSearchFn: (q) => webSearch(q, { log }) });
      case 'live_news':        return await liveNews(args.query || '', { log, webSearchFn: (q) => webSearch(q, { log }) });
      case 'stock_research':   return await stockResearch(args, { log });
      case 'create_report':    return await createReport(args, { log });
      case 'create_pptx':      return await createPptx(args, { log });
      case 'parallel_research': return await parallelResearch(args, { log, dispatchFn: (subName, subArgs) => executeServerTool(subName, subArgs, { log }) });
      default: return JSON.stringify({ error: 'unhandled tool: ' + name });
    }
  } catch (e) {
    log && log('warn', 'tool-exec/' + name + ' failed: ' + (e.message || String(e)));
    return JSON.stringify({ error: e.message || String(e) });
  }
}

export function isServerTool(name) {
  return SERVER_TOOL_NAMES.has(name);
}

// Heavy, rarely-needed document generators. Their full JSON schemas cost ~600 tok, but a
// plain text/coding turn never needs them. We inject them only when the conversation shows
// explicit document intent (users who want these almost always say so), so the capability
// is preserved on the turns that actually need it while the common path stays lean.
export const GATED_TOOLS = new Set(['create_report', 'create_pptx', 'create_pdf', 'create_artifact']);

const DOC_INTENT_RE = new RegExp([
  // zh: a create-verb followed (within one clause) by a document object — the gap
  // covers connectors/measure-words like 成/个/一份/详细的 ("做成PPT", "做一份详细的报告").
  '(生成|制作|做|帮我做|给我做|帮我生成|导出|搞|整理|写|画|出)[^。!?,;，；\\n]{0,8}(报告|研报|分析报告|ppt|pptx|幻灯片?|演示文稿|演示|海报|pdf|artifact|预览)',
  // zh: strong standalone format words
  '研报|演示文稿|幻灯片|pptx',
  // en: a create-verb followed by a document object
  '\\b(create|generate|make|build|export|produce|draft|write)\\b[^\\n]{0,24}\\b(report|presentation|pptx?|powerpoint|slides?|slide\\s*deck|deck|pdf|artifact)\\b',
  // en: strong standalone format words
  '\\b(pptx|powerpoint)\\b',
].join('|'), 'i');

// Does the recent conversation explicitly ask to generate a document / deck / PDF / artifact?
export function wantsGatedTools(messages) {
  if (!Array.isArray(messages)) return false;
  const text = messages
    .filter(m => m && m.role === 'user')
    .slice(-3)
    .map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))
    .join('\n');
  return DOC_INTENT_RE.test(text);
}

// Merge serverTools into a client-provided tools array (de-dup by name).
// When `messages` is provided, the GATED_TOOLS document generators are injected only on
// explicit document intent; when `messages` is omitted, all server tools are injected
// (back-compat for non-chat callers and tests).
export function mergeWithServerTools(clientTools, messages) {
  const list = Array.isArray(clientTools) ? [...clientTools] : [];
  const seen = new Set(list.filter(t => t?.function?.name).map(t => t.function.name));
  const allowGated = messages === undefined ? true : wantsGatedTools(messages);
  for (const st of SERVER_TOOLS) {
    if (seen.has(st.function.name)) continue;
    if (!allowGated && GATED_TOOLS.has(st.function.name)) continue;
    list.push(st);
  }
  return list;
}
