// Brain v2 · tool-exec/stock_research
// Tushare Pro 全口径 A 股深度数据(日线/财务/股东/估值)
// Ported from brain v1 server.js (lines 5064-5199)
import { execSync } from 'child_process';
import fs from 'fs';

export async function stockResearch(args, { log } = {}) {
  if (!process.env.TUSHARE_TOKEN) return JSON.stringify({ error: 'Tushare token not configured' });
  const tsCode = String(args?.code || '').trim().toUpperCase();
  const researchName = String(args?.name || '').trim();

  // [HK/US bail v2] stock_research 只支持 A 股 (SH/SZ/BJ)
  const HK_NAMES = /^(腾讯|阿里|阿里巴巴|美团|小米|网易|京东|百度|快手|港交所|中国移动|中国平安|建设银行|工商银行|招商银行|比亚迪|吉利)/;
  const US_NAMES = /^(苹果|微软|谷歌|亚马逊|Meta|Tesla|特斯拉|英伟达|NVIDIA|AMD|Intel)/i;
  const isHKCode = /^HK\s|\.HK$|^HK\d|^0?\d{3,4}$/i.test(tsCode);
  const isStrictAShare = /^(60\d{4}|00\d{4}|30\d{4}|68\d{4}|8[3-9]\d{4}|92\d{4})\.(SH|SZ|BJ)$/i.test(tsCode);

  if (HK_NAMES.test(researchName) || isHKCode) {
    return JSON.stringify({ error: "stock_research 只支持 A 股 (SH/SZ/BJ)。港股请改用 stock_market,query='" + (researchName || tsCode) + " 股价'。" });
  }
  if (US_NAMES.test(researchName)) {
    return JSON.stringify({ error: "stock_research 只支持 A 股。美股请用 stock_market,query='" + researchName + " 股价'。" });
  }
  if (!tsCode || !tsCode.includes('.')) return JSON.stringify({ error: 'Invalid code format. Use 688629.SH or 000001.SZ.' });
  if (!isStrictAShare) {
    return JSON.stringify({ error: '无效 A 股代码 ' + tsCode + " — 标准前缀必须是 60/00/30/68 (沪深主板/创业/科创) 或 83-89/92 (北交所),其余如 89xxxx 是基金不是股票。请改用 stock_market 工具,query='" + (researchName || tsCode) + " 股价'。" });
  }
  const name = args?.name || tsCode;
  log && log('info', 'tool-exec/stock_research', 'querying ' + tsCode + ' (' + name + ')');

  const token = process.env.TUSHARE_TOKEN;

  // Build Python script for comprehensive data pull
  const script = `
import json, tushare as ts, warnings
warnings.filterwarnings('ignore')
ts.set_token(${JSON.stringify(token)})
pro = ts.pro_api()
result = {}

# 1. Daily prices (last 60 trading days)
try:
    df = pro.daily(ts_code=${JSON.stringify(tsCode)}, start_date='20250101', end_date='20300101')
    if df is not None and not df.empty:
        df = df.head(60)
        result['daily'] = df[['trade_date','open','high','low','close','pct_chg','vol','amount']].to_dict(orient='records')
        result['latest_price'] = float(df.iloc[0]['close'])
        result['latest_date'] = str(df.iloc[0]['trade_date'])
        result['price_30d_high'] = float(df.head(30)['high'].max())
        result['price_30d_low'] = float(df.head(30)['low'].min())
        result['price_60d_high'] = float(df['high'].max())
        result['price_60d_low'] = float(df['low'].min())
        chg_5d = float(df.head(5)['pct_chg'].sum()) if len(df)>=5 else None
        chg_20d = float(df.head(20)['pct_chg'].sum()) if len(df)>=20 else None
        result['chg_5d'] = round(chg_5d, 2) if chg_5d else None
        result['chg_20d'] = round(chg_20d, 2) if chg_20d else None
except Exception as e:
    result['daily_error'] = str(e)

# 2. Financial indicators (last 8 quarters)
try:
    df = pro.fina_indicator(ts_code=${JSON.stringify(tsCode)})
    if df is not None and not df.empty:
        df = df.head(8)
        cols = ['end_date','eps','roe','grossprofit_margin','netprofit_margin','current_ratio','debt_to_assets','or_yoy','netprofit_yoy']
        available = [c for c in cols if c in df.columns]
        result['fina'] = df[available].to_dict(orient='records')
except Exception as e:
    result['fina_error'] = str(e)

# 3. Income statement (last 4 annual)
try:
    df = pro.income(ts_code=${JSON.stringify(tsCode)}, fields='end_date,revenue,n_income,total_profit,operate_profit')
    if df is not None and not df.empty:
        annual = df[df['end_date'].str.endswith('1231')].head(4)
        if not annual.empty:
            result['income'] = annual.to_dict(orient='records')
except Exception as e:
    result['income_error'] = str(e)

# 4. Top 10 holders (latest)
try:
    df = pro.top10_holders(ts_code=${JSON.stringify(tsCode)})
    if df is not None and not df.empty:
        latest = df[df['end_date']==df['end_date'].max()]
        result['holders'] = latest[['holder_name','hold_amount','hold_ratio']].head(10).to_dict(orient='records')
except Exception as e:
    result['holders_error'] = str(e)

# 5. Basic info
try:
    df = pro.stock_basic(ts_code=${JSON.stringify(tsCode)}, fields='ts_code,name,area,industry,market,list_date,fullname')
    if df is not None and not df.empty:
        result['basic'] = df.iloc[0].to_dict()
except Exception as e:
    result['basic_error'] = str(e)

# 6. Market cap (daily_basic)
try:
    df = pro.daily_basic(ts_code=${JSON.stringify(tsCode)}, fields='trade_date,total_mv,circ_mv,pe_ttm,pb,turnover_rate')
    if df is not None and not df.empty:
        latest = df.iloc[0]
        result['valuation'] = {
            'total_mv': round(float(latest.get('total_mv',0))/10000, 2),
            'circ_mv': round(float(latest.get('circ_mv',0))/10000, 2),
            'pe_ttm': round(float(latest.get('pe_ttm',0)), 2) if latest.get('pe_ttm') else None,
            'pb': round(float(latest.get('pb',0)), 2) if latest.get('pb') else None,
            'turnover_rate': round(float(latest.get('turnover_rate',0)), 2) if latest.get('turnover_rate') else None,
        }
except Exception as e:
    result['valuation_error'] = str(e)

print(json.dumps(result, ensure_ascii=False, default=str))
`;

  try {
    const tmpScript = '/tmp/tushare_query_' + Date.now() + '.py';
    fs.writeFileSync(tmpScript, script, 'utf-8');
    const raw = execSync('python3 ' + tmpScript, { encoding: 'utf8', timeout: 30000 });
    try { fs.unlinkSync(tmpScript); } catch {}
    // sanitize Tushare illegal NaN/Infinity
    const sanitized = raw.trim()
      .replace(/:\s*NaN\b/g, ': null')
      .replace(/:\s*-?Infinity\b/g, ': null');
    const data = JSON.parse(sanitized);
    data._stock_code = tsCode;
    data._stock_name = name;
    log && log('info', 'tool-exec/stock_research', 'done for ' + tsCode + ': ' + Object.keys(data).length + ' fields');
    return JSON.stringify(data);
  } catch (err) {
    log && log('error', 'tool-exec/stock_research', 'failed: ' + err.message);
    return JSON.stringify({ error: 'Tushare query failed: ' + (err.message || '').slice(0, 200) });
  }
}
