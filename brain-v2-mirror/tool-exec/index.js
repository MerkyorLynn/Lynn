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
      description: 'Get comprehensive stock research data from Tushare Pro API. Returns: recent price history (60 days), key financial indicators (8 quarters), income statement, top 10 shareholders, valuation. Use BEFORE create_report to get real data. A-shares only (SH/SZ/BJ).',
      parameters: { type: 'object', properties: { code: { type: 'string', description: 'Stock code with exchange suffix, e.g. 688629.SH or 000001.SZ' }, name: { type: 'string', description: 'Company name (for display)' } }, required: ['code'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_report',
      description: 'Generate a professional dark-themed HTML analysis report. Provide structured JSON (title + sections). Section types: metrics (KPI cards), text (paragraphs/blocks), table (rows+headers), verdict (prediction cards), warning (alert). Always provide at least 3 sections.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Report title' },
          tag: { type: 'string', description: 'Category tag' },
          subtitle: { type: 'string' },
          date: { type: 'string' },
          sections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                type: { type: 'string', enum: ['metrics', 'text', 'table', 'verdict', 'warning'] },
                metrics: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, value: { type: 'string' }, change: { type: 'string' }, direction: { type: 'string', enum: ['up', 'down', 'neutral'] } } } },
                content: { type: 'string' },
                blocks: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, text: { type: 'string' } } } },
                headers: { type: 'array', items: { type: 'string' } },
                rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
                items: { type: 'array', items: { type: 'object', properties: { period: { type: 'string' }, range: { type: 'string' }, note: { type: 'string' } } } },
              },
              required: ['title', 'type'],
            },
          },
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
      description: 'Generate a PowerPoint presentation (.pptx file). Layouts: title / content (default) / section / two_column. Lines starting with "-" are bullets. For two_column, use "|||" or "---" to separate columns. Returns a download URL.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Presentation title' },
          author: { type: 'string', description: 'Author name (optional)' },
          slides: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                layout: { type: 'string', enum: ['title', 'content', 'section', 'two_column'] },
                title: { type: 'string' },
                body: { type: 'string' },
                notes: { type: 'string' },
              },
              required: ['title'],
            },
          },
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

// Merge serverTools into a client-provided tools array (de-dup by name)
export function mergeWithServerTools(clientTools) {
  const list = Array.isArray(clientTools) ? [...clientTools] : [];
  const seen = new Set(list.filter(t => t?.function?.name).map(t => t.function.name));
  for (const st of SERVER_TOOLS) {
    if (!seen.has(st.function.name)) list.push(st);
  }
  return list;
}
