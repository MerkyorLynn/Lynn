// Brain v2 · tool-exec/stock_market
// 新浪财经 + Tushare + 天天基金,A 股/港股/美股/商品/基金/龙虎榜
// Ported from brain v1 server.js (lines 2356-2986)
import { execSync } from 'child_process';

// ── Tushare 通用 API call ─────────────────────────────────
async function tushareApiCall(apiName, params = {}) {
  const token = process.env.TUSHARE_TOKEN || 'bc975ecd147d93f6a90bf7f60d73e6420a36e562678fe2690061171c';
  try {
    const resp = await fetch('http://api.tushare.pro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_name: apiName, token, params, fields: '' }),
      signal: AbortSignal.timeout(15000),
    });
    const d = await resp.json();
    if (d.code !== 0) return null;
    const { fields, items } = d.data || {};
    if (!fields || !items || !items.length) return null;
    return items.map((row) => {
      const obj = {};
      fields.forEach((f, i) => (obj[f] = row[i]));
      return obj;
    });
  } catch {
    return null;
  }
}

// ── 新浪 hq 行情解析 ──────────────────────────────────────
function parseSinaLine(line) {
  const match = line.match(/var hq_str_([^=]+)="(.*)"/);
  if (!match) return null;
  return { code: match[1], data: match[2].split(',') };
}

async function sinaFetchGbk(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetch(url, {
      headers: { Referer: 'http://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' },
      signal: controller.signal,
    });
    const buf = Buffer.from(await resp.arrayBuffer());
    let text;
    try {
      text = execSync('iconv -f gbk -t utf-8', { input: buf }).toString();
    } catch {
      text = buf.toString('utf-8');
    }
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchUSIndices() {
  const text = await sinaFetchGbk('http://hq.sinajs.cn/list=gb_dji,gb_ixic,gb_inx');
  const lines = text.trim().split('\n').map((l) => parseSinaLine(l.trim())).filter(Boolean);
  const nameMap = { gb_dji: '道琼斯', gb_ixic: '纳斯达克', gb_inx: '标普500' };
  return lines.map((l) => ({
    name: nameMap[l.code] || l.data[0] || l.code,
    price: l.data[1],
    changePercent: l.data[2] + '%',
    changeAmount: l.data[4],
    open: l.data[5],
    high: l.data[6],
    low: l.data[7],
    time: l.data[3],
  }));
}

async function fetchCNIndices() {
  const text = await sinaFetchGbk('http://hq.sinajs.cn/list=s_sh000001,s_sz399001,s_sz399006');
  const lines = text.trim().split('\n').map((l) => parseSinaLine(l.trim())).filter(Boolean);
  const nameMap = { s_sh000001: '上证指数', s_sz399001: '深证成指', s_sz399006: '创业板指' };
  return lines.map((l) => ({
    name: nameMap[l.code] || l.data[0] || l.code,
    price: l.data[1],
    changeAmount: l.data[2],
    changePercent: l.data[3] + '%',
  }));
}

async function fetchHKIndex() {
  const text = await sinaFetchGbk('http://hq.sinajs.cn/list=rt_hkHSI');
  const lines = text.trim().split('\n').map((l) => parseSinaLine(l.trim())).filter(Boolean);
  if (!lines.length) return [];
  const d = lines[0].data;
  return [
    {
      name: '恒生指数',
      price: d[2],
      prevClose: d[3],
      high: d[4],
      low: d[5],
      changeAmount: d[7],
      changePercent: d[8] + '%',
      time: d[17] + ' ' + (d[18] || ''),
    },
  ];
}

async function fetchStockQuote(code) {
  const text = await sinaFetchGbk('http://hq.sinajs.cn/list=' + code);
  const parsed = parseSinaLine(text.trim());
  if (!parsed || !parsed.data[0]) return null;
  return parsed;
}

async function fetchTopList(tradeDate) {
  const date = tradeDate || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const data = await tushareApiCall('top_list', { trade_date: date });
  if (!data) return [];
  return data.slice(0, 10).map((d) => ({
    name: d.name || d.ts_code,
    code: d.ts_code,
    close: d.close,
    changePct: d.pct_change ? d.pct_change + '%' : '',
    reason: d.reason || '',
    buyAmount: d.buy ? (d.buy / 10000).toFixed(0) + '万' : '',
    sellAmount: d.sell ? (d.sell / 10000).toFixed(0) + '万' : '',
  }));
}

async function fetchHKConnect() {
  try {
    const resp = await fetch('http://hq.sinajs.cn/list=rt_hk00700,rt_hk09988,rt_hk03690,rt_hk01810,rt_hk09999', {
      headers: { Referer: 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];
    const text = await resp.text();
    const results = [];
    const names = { hk00700: '腾讯控股', hk09988: '阿里巴巴', hk03690: '美团', hk01810: '小米集团', hk09999: '网易' };
    for (const line of text.split('\n')) {
      const m = line.match(/var hq_str_rt_(hk\d+)="([^"]+)"/);
      if (!m || !m[2]) continue;
      const d = m[2].split(',');
      if (d.length < 10) continue;
      const name = d[1] || names[m[1]] || m[1];
      results.push({ name, price: d[6] + ' HKD', changePercent: d[9] + '%', changeAmount: d[8] });
    }
    return results;
  } catch {
    return [];
  }
}

async function fetchFundNav(fundCode) {
  try {
    const resp = await fetch('https://fundgz.1234567.com.cn/js/' + fundCode + '.js', {
      headers: { Referer: 'https://fund.eastmoney.com/', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    const text = await resp.text();
    const m = text.match(/jsonpgz\(({.*?})\)/);
    if (!m) return null;
    const d = JSON.parse(m[1]);
    return { name: d.name, code: d.fundcode, nav: d.dwjz, estimateNav: d.gsz, estimateChange: d.gszzl + '%', date: d.jzrq };
  } catch {
    return null;
  }
}

async function fetchPopularFunds() {
  const codes = ['110011', '161725', '005827', '007340', '320007', '260108'];
  const results = [];
  for (const code of codes) {
    const f = await fetchFundNav(code);
    if (f) results.push(f);
  }
  return results;
}

async function fetchCommodities({ log } = {}) {
  try {
    const resp = await fetch('http://hq.sinajs.cn/list=hf_GC,hf_SI,hf_CL,hf_OIL,sh518880,USDCNY', {
      headers: { Referer: 'https://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!resp.ok) return [];
    const text = await resp.text();
    const results = [];
    const lines = text.split('\n').filter(Boolean);
    const names = { hf_GC: '国际黄金(COMEX)', hf_SI: '国际白银(COMEX)', hf_CL: '美原油(WTI)', hf_OIL: '布伦特原油', sh518880: '黄金ETF(518880)' };
    const units = { hf_GC: '美元/盎司', hf_SI: '美元/盎司', hf_CL: '美元/桶', hf_OIL: '美元/桶', sh518880: '元' };
    for (const line of lines) {
      const m = line.match(/var hq_str_(\w+)="([^"]+)"/);
      if (!m) continue;
      const code = m[1];
      const data = m[2].split(',');
      if (!data[0] || data[0] === '') continue;
      let price;
      let prevClose;
      let name = names[code] || code;
      let unit = units[code] || '';
      if (code.startsWith('hf_')) {
        price = parseFloat(data[0]);
        prevClose = parseFloat(data[7] || data[5] || price);
        if (code === 'hf_GC' || code === 'hf_SI') {
          let usdcny = 7.25;
          try {
            const fxLine = lines.find((l) => l.indexOf('USDCNY') !== -1);
            if (fxLine) {
              const fxD = fxLine.split('"')[1];
              if (fxD) usdcny = parseFloat(fxD.split(',')[1]) || 7.25;
            }
          } catch {}
          price = (price * usdcny) / 31.1035;
          prevClose = (prevClose * usdcny) / 31.1035;
          unit = '元/克';
          name = code === 'hf_GC' ? '国际金价(实时)' : '国际银价(实时)';
        }
      } else {
        price = parseFloat(data[3] || data[1]);
        prevClose = parseFloat(data[2] || data[1]);
      }
      if (isNaN(price)) continue;
      const change = price - prevClose;
      const changePct = prevClose ? ((change / prevClose) * 100).toFixed(2) : '0.00';
      results.push({ name, price: price.toFixed(2) + ' ' + unit, changePercent: changePct + '%', changeAmount: change.toFixed(2) });
    }
    if (results.length) return results;
  } catch (e) {
    log && log('warn', 'tool-exec/stock_market', 'fetchCommodities sina error: ' + e.message);
  }
  // gold-api fallback
  try {
    const fbResults = [];
    const usdcny = 7.25;
    const sources = [
      { sym: 'XAU', label: '国际金价(metals.live·实时)' },
      { sym: 'XAG', label: '国际银价(metals.live·实时)' },
    ];
    for (const s of sources) {
      try {
        const r = await fetch('https://api.gold-api.com/price/' + s.sym, { signal: AbortSignal.timeout(5000) });
        if (!r.ok) continue;
        const d = await r.json();
        const usdPerOz = parseFloat(d.price);
        if (isNaN(usdPerOz)) continue;
        const cnyPerG = ((usdPerOz * usdcny) / 31.1035).toFixed(2);
        fbResults.push({ name: s.label, price: cnyPerG + ' 元/克 (≈ $' + usdPerOz.toFixed(2) + '/oz)', changePercent: '—', changeAmount: '—' });
      } catch {}
    }
    return fbResults;
  } catch {
    return [];
  }
}

// ── 文本解析 ─────────────────────────────────────────────
const STOCK_NAME_MAP = {
  '茅台': 'sh600519', '贵州茅台': 'sh600519',
  '腾讯': 'hk00700', '阿里': 'hk09988', '阿里巴巴': 'hk09988',
  '比亚迪': 'sz002594', '宁德时代': 'sz300750', '浪潮信息': 'sz000977', '东方财富': 'sz300059', '中芯国际': 'sh688981',
  '中兵红箭': 'sz000519', '平安': 'sh601318', '中国平安': 'sh601318',
  '招商银行': 'sh600036', '工商银行': 'sh601398',
  '苹果': 'gb_aapl', 'apple': 'gb_aapl', 'aapl': 'gb_aapl',
  '特斯拉': 'gb_tsla', 'tesla': 'gb_tsla', 'tsla': 'gb_tsla',
  '英伟达': 'gb_nvda', 'nvidia': 'gb_nvda', 'nvda': 'gb_nvda',
  '微软': 'gb_msft', 'microsoft': 'gb_msft', 'msft': 'gb_msft',
  '谷歌': 'gb_goog', 'google': 'gb_goog', 'goog': 'gb_goog',
  '亚马逊': 'gb_amzn', 'amazon': 'gb_amzn', 'amzn': 'gb_amzn',
  '美团': 'hk03690', '小米': 'hk01810', '京东': 'hk09618',
};

function extractStockTarget(text) {
  const codeMatch = text.match(/\b(00\d{4}|30\d{4}|60\d{4}|68\d{4})\b/);
  if (codeMatch) {
    const c = codeMatch[1];
    const prefix = c.startsWith('6') ? 'sh' : 'sz';
    return { type: 'quote', code: prefix + c };
  }
  const usMatch = text.match(/\b([A-Z]{1,5})\b/);
  if (usMatch && STOCK_NAME_MAP[usMatch[1].toLowerCase()]) {
    return { type: 'quote', code: STOCK_NAME_MAP[usMatch[1].toLowerCase()] };
  }
  const lowerText = text.toLowerCase();
  for (const [name, code] of Object.entries(STOCK_NAME_MAP)) {
    if (lowerText.includes(name)) return { type: 'quote', code };
  }
  return null;
}

function detectMarketType(text) {
  const markets = [];
  if (/美股|道指|纳指|纳斯达克|标普|道琼斯|华尔街/.test(text)) markets.push('us');
  if (/A股|大A|a股|上证|深证|沪指|深指|创业板|沪深|两市/.test(text)) markets.push('cn');
  if (/港股|恒指|恒生|港市/.test(text)) markets.push('hk');
  if (/收盘|开盘|行情|大盘|股市/.test(text) && markets.length === 0) {
    markets.push('us', 'cn', 'hk');
  }
  return markets;
}

function extractPotentialStockNames(text) {
  const found = String(text || '').match(/[一-鿿]{2,8}/g) || [];
  const exclude = /今天|昨天|明天|后天|现在|一下|一下子|帮我|看看|查询|分析|多少|怎么|如何|什么|股价|股票|股市|行情|收盘|开盘|昨收|前收|涨跌|报告|简报|日报|定时|提醒|天气|新闻/;
  const result = [];
  for (const item of found) {
    if (item.length < 2 || exclude.test(item)) continue;
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

async function searchStockByName(name, { log } = {}) {
  const keyword = String(name || '').trim();
  if (!keyword || keyword.length < 2) return null;
  const encoded = encodeURIComponent(keyword);
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const resp = await fetch('https://smartbox.gtimg.cn/s3/?v=2&q=' + encoded + '&t=all', { signal: controller.signal });
    clearTimeout(timeout);
    const text = await resp.text();
    const match = text.match(/v_hint="([^"]+)"/);
    if (!match) return null;
    const items = match[1].split('^');
    for (const item of items) {
      const parts = item.split('~');
      if (parts.length < 5) continue;
      const market = parts[0];
      const stockCode = parts[1];
      const stockName = parts[2];
      const type = parts[4];
      if (/^GP-A/.test(type) || type === 'GP-SH' || type === 'GP-SZ') {
        const prefix = stockCode.startsWith('6') ? 'sh' : 'sz';
        return { type: 'quote', code: prefix + stockCode, name: stockName };
      }
      if (/^GP-HK/.test(type)) return { type: 'quote', code: 'hk' + stockCode, name: stockName };
      if (/^GP-US/.test(type) || market === 'us') return { type: 'quote', code: 'gb_' + stockCode.toLowerCase(), name: stockName };
    }
  } catch (e) {
    log && log('warn', 'tool-exec/stock_market', 'tencent stock search failed: ' + e.message);
  }
  return null;
}

function wantsHistoricalClose(text) {
  return /(昨天|昨日|上一个交易日|昨收|前收).*(收盘|收市|股价)|(?:收盘|收市|股价).*(昨天|昨日|上一个交易日|昨收|前收)/.test(String(text || ''));
}

function sinaCodeToTsCode(code) {
  const value = String(code || '').trim().toLowerCase();
  if (/^sh\d{6}$/.test(value)) return value.slice(2) + '.SH';
  if (/^sz\d{6}$/.test(value)) return value.slice(2) + '.SZ';
  return null;
}

function shanghaiNowParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const map = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  return { compact: map.year + map.month + map.day };
}

async function fetchYesterdayCloseFromTushare(code, { log } = {}) {
  if (!process.env.TUSHARE_TOKEN) return null;
  const tsCode = sinaCodeToTsCode(code);
  if (!tsCode) return null;
  const now = shanghaiNowParts();
  const script = [
    'import json',
    'import tushare as ts',
    'ts.set_token(' + JSON.stringify(process.env.TUSHARE_TOKEN) + ')',
    'pro = ts.pro_api()',
    "df = pro.daily(ts_code=" + JSON.stringify(tsCode) + ", start_date='20250101', end_date='20300101')",
    "cols = ['ts_code','trade_date','open','high','low','close','pre_close','pct_chg']",
    'rows = [] if df is None or df.empty else df[cols].to_dict(orient="records")',
    'print(json.dumps(rows, ensure_ascii=False))',
  ].join('\n');
  try {
    const raw = execSync("python3 - <<'PY'\n" + script + "\nPY", { encoding: 'utf8', timeout: 15000 });
    const rows = JSON.parse(String(raw || '[]').trim() || '[]');
    return rows.find((row) => String(row.trade_date || '') < now.compact) || null;
  } catch (e) {
    log && log('warn', 'tool-exec/stock_market', 'tushare history failed for ' + code + ': ' + e.message);
    return null;
  }
}

// ── 主入口 ───────────────────────────────────────────────
export async function stockMarket(query, { log, webSearchFn } = {}) {
  const text = String(query || '');
  try {
    const results = [];
    const markets = detectMarketType(text);
    const isCommodity = /金价|黄金|金条|白银|银价|油价|原油|期货|大宗|贵金属|gold|silver|oil|crude|commodity/i.test(text);
    const isHKConnect = /港股通|港股|腾讯|阿里|美团|小米|网易|恒生/i.test(text);
    const isFund = /基金|净值|定投|ETF|指数基金|混合基金/i.test(text);
    const isTopList = /龙虎榜|游资|主力|大单|涨停|跌停/i.test(text);
    let stockTarget = extractStockTarget(text);
    if (!stockTarget) {
      const candidates = extractPotentialStockNames(text);
      for (const candidate of candidates) {
        const searched = await searchStockByName(candidate, { log });
        if (searched) {
          stockTarget = searched;
          break;
        }
      }
    }

    const fetches = [];
    if (isCommodity) fetches.push(fetchCommodities({ log }).then((d) => ({ market: '贵金属/大宗商品', data: d })));
    if (isHKConnect) fetches.push(fetchHKConnect().then((d) => ({ market: '港股通', data: d })));
    if (isTopList)
      fetches.push(
        fetchTopList().then((d) => ({
          market: '龙虎榜(今日)',
          data: d.map((i) => ({
            name: i.name + '(' + i.code + ')',
            price: i.close,
            changePercent: i.changePct,
            changeAmount: '买入' + i.buyAmount + ' 卖出' + i.sellAmount + ' ' + i.reason,
          })),
        })),
      );
    if (isFund)
      fetches.push(
        fetchPopularFunds().then((funds) => ({
          market: '基金净值',
          data: funds.map((f) => ({
            name: f.name + '(' + f.code + ')',
            price: '净值 ' + f.nav + ' | 估值 ' + f.estimateNav,
            changePercent: f.estimateChange,
            changeAmount: '日期 ' + f.date,
          })),
        })),
      );
    if (markets.includes('us')) fetches.push(fetchUSIndices().then((d) => ({ market: '美股', data: d })));
    if (markets.includes('cn')) fetches.push(fetchCNIndices().then((d) => ({ market: 'A股', data: d })));
    if (markets.includes('hk')) fetches.push(fetchHKIndex().then((d) => ({ market: '港股', data: d })));

    const marketResults = await Promise.allSettled(fetches);
    for (const r of marketResults) {
      if (r.status === 'fulfilled' && r.value.data.length) {
        const { market, data } = r.value;
        const lines = data.map(
          (d) =>
            '  ' +
            d.name +
            ': ' +
            d.price +
            ' (' +
            (d.changePercent >= 0 ? '+' : '') +
            d.changePercent +
            ', ' +
            (d.changeAmount >= 0 ? '+' : '') +
            d.changeAmount +
            ')',
        );
        results.push('【' + market + '行情】\n' + lines.join('\n'));
      }
    }

    if (stockTarget) {
      if (wantsHistoricalClose(text) && (stockTarget.code.startsWith('sh') || stockTarget.code.startsWith('sz'))) {
        const history = await fetchYesterdayCloseFromTushare(stockTarget.code, { log });
        if (history) {
          results.push(
            '【个股昨收: ' +
              (stockTarget.name || stockTarget.code) +
              '】\n  交易日: ' +
              history.trade_date +
              '\n  收盘价: ' +
              history.close +
              '\n  开盘: ' +
              history.open +
              ', 最高: ' +
              history.high +
              ', 最低: ' +
              history.low +
              '\n  前收: ' +
              history.pre_close +
              ', 涨跌幅: ' +
              history.pct_chg +
              '%',
          );
        }
      }
      const quote = await fetchStockQuote(stockTarget.code);
      if (quote) {
        const d = quote.data;
        if (stockTarget.code.startsWith('gb_')) {
          results.push(
            '【个股: ' + d[0] + '】\n  现价: ' + d[1] + ', 涨跌幅: ' + d[2] + '%, 涨跌额: ' + d[4] + '\n  开盘: ' + d[5] + ', 最高: ' + d[6] + ', 最低: ' + d[7] + '\n  时间: ' + d[3],
          );
        } else if (stockTarget.code.startsWith('sh') || stockTarget.code.startsWith('sz')) {
          const lastClose = Number(d[2] || 0);
          const currentPrice = Number(d[3] || 0);
          const changePercent = lastClose > 0 ? (((currentPrice - lastClose) / lastClose) * 100).toFixed(2) : '0.00';
          const sign = Number(changePercent) >= 0 ? '+' : '';
          results.push(
            '【个股: ' +
              d[0] +
              '】\n  现价: ' +
              d[3] +
              '  涨跌幅: ' +
              sign +
              changePercent +
              '%\n  昨收: ' +
              d[2] +
              ', 今开: ' +
              d[1] +
              '\n  最高: ' +
              d[4] +
              ', 最低: ' +
              d[5] +
              '\n  成交量: ' +
              d[8] +
              '手, 成交额: ' +
              d[9] +
              '元\n  时间: ' +
              d[30] +
              ' ' +
              d[31],
          );
        } else if (stockTarget.code.startsWith('hk')) {
          const name = d[1] || d[0];
          const sign = Number(d[7] || 0) >= 0 ? '+' : '';
          results.push(
            '【个股: ' +
              name +
              '】\n  现价: ' +
              d[6] +
              ' HKD  涨跌幅: ' +
              sign +
              d[8] +
              '%  涨跌额: ' +
              d[7] +
              '\n  昨收: ' +
              d[3] +
              ', 今开: ' +
              d[4] +
              ', 日内最低: ' +
              d[5] +
              '\n  成交额: ' +
              Number(d[11] || 0).toLocaleString() +
              ' HKD, 成交量: ' +
              Number(d[12] || 0).toLocaleString() +
              ' 股\n  时间: ' +
              d[17] +
              ' ' +
              d[18],
          );
        }
      }
    }

    // commodity / forex fallback → web_search (if injected)
    if (!results.length && /金价|黄金|金条|金店|油价|原油|汇率|美元|比特币|crypto|gold|oil|forex|silver|白银/i.test(text)) {
      log && log('info', 'tool-exec/stock_market', 'commodity fallback → web_search');
      if (typeof webSearchFn === 'function') {
        try {
          const sr = await webSearchFn(text);
          if (sr) return sr;
        } catch {}
      }
    }
    if (!results.length) return JSON.stringify({ error: '未找到行情数据' });
    log && log('info', 'tool-exec/stock_market', 'success markets=' + markets.join(',') + ' individual=' + (stockTarget?.code || 'none'));
    return results.join('\n\n');
  } catch (err) {
    log && log('warn', 'tool-exec/stock_market', 'failed: ' + err.message);
    return JSON.stringify({ error: err.message });
  }
}
