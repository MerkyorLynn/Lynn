import { afterEach, describe, expect, it, vi } from "vitest";
import iconv from "iconv-lite";

const searchMock = vi.hoisted(() => ({
  runSearchQuery: vi.fn(),
}));

const fetchContentMock = vi.hoisted(() => ({
  fetchWebContent: vi.fn(),
}));

vi.mock("../lib/tools/web-search.js", () => searchMock);
vi.mock("../lib/tools/web-fetch.js", () => fetchContentMock);

import { createStockMarketTool } from "../lib/tools/stock-market.js";
import { createWeatherTool } from "../lib/tools/realtime-info.js";
import { inferReportResearchKind } from "../server/chat/report-research-context.js";

function jsonResponse(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function gbkTextResponse(text) {
  return new Response(iconv.encode(String(text || ""), "gbk"), {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

function sinaHkQuote({ name, previous, open, high, low, close, change, pct }) {
  const hk = Array.from({ length: 76 }, () => "");
  hk[1] = name;
  hk[2] = previous;
  hk[3] = open;
  hk[4] = high;
  hk[5] = low;
  hk[6] = close;
  hk[7] = change;
  hk[8] = pct;
  hk[17] = "2026/04/24";
  hk[18] = "16:08:34";
  return hk.join(",");
}

function tencentAQuote({ code, name, price, previous = "10.00", change = "0.10", pct = "1.00" }) {
  const fields = Array.from({ length: 50 }, () => "");
  fields[1] = name;
  fields[2] = code;
  fields[3] = price;
  fields[4] = previous;
  fields[5] = previous;
  fields[30] = "20260424161451";
  fields[31] = change;
  fields[32] = pct;
  fields[33] = price;
  fields[34] = price;
  fields[36] = "123456";
  fields[37] = "12345";
  fields[38] = "2.34";
  fields[39] = "42.0";
  return fields.join("~");
}

describe("realtime market/weather tools", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    searchMock.runSearchQuery.mockReset();
    fetchContentMock.fetchWebContent.mockReset();
  });

  it("routes common realtime prompts into deterministic prefetch kinds", () => {
    expect(inferReportResearchKind("今天金价如何")).toBe("market");
    expect(inferReportResearchKind("今天布伦特石油价格，请给美元/桶")).toBe("market");
    expect(inferReportResearchKind("雪人集团002639现在股价多少？只给价格、涨跌幅和来源。")).toBe("market");
    expect(inferReportResearchKind("雪人集团002639支撑位和压力位怎么看？")).toBe("stock");
    expect(inferReportResearchKind("恒生科技成分股今天表现")).toBe("market");
    expect(inferReportResearchKind("纳指科技股今天表现")).toBe("market");
    expect(inferReportResearchKind("创业板科技股今天表现")).toBe("market");
    expect(inferReportResearchKind("DeepSeek概念股今天表现")).toBe("market");
    expect(inferReportResearchKind("上海明天下雨吗？")).toBe("weather");
  });

  it("uses Gold-API direct quotes before search snippets for gold queries", async () => {
    const goldPageText = [
      "各品牌黄金首饰金店报价",
      "中国黄金 1401 700 - 元/克 2026-04-24",
      "老凤祥 1445 850 1288 元/克 2026-04-24",
      "六福珠宝 1442 782 1265 元/克 2026-04-24",
      "银行投资金条价格",
      "农行传世之宝金条 1046.29",
      "工商银行如意金条 1057.0",
      "今日黄金回收价格",
      "黄金回收 1027.0 元/克 2026-04-24",
    ].join("\n");

    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("/price/XAU")) {
        return jsonResponse({
          symbol: "XAU",
          price: 4724.6,
          updatedAt: "2026-04-24T08:20:00Z",
        });
      }
      if (href.includes("/price/XAG")) {
        return jsonResponse({
          symbol: "XAG",
          price: 75.1,
          updatedAt: "2026-04-24T08:20:00Z",
        });
      }
      if (href.includes("open.er-api.com")) {
        return jsonResponse({
          rates: { CNY: 6.84 },
          time_last_update_utc: "Fri, 24 Apr 2026 00:00:00 +0000",
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      plan: { scene: "finance" },
      results: [{ title: "今日黄金价格", url: "https://www.huilvbiao.com/gold", snippet: "金价" }],
    });
    fetchContentMock.fetchWebContent.mockResolvedValue({ text: goldPageText });

    const result = await createStockMarketTool().execute("test", { query: "今天金价如何" });
    const text = result.content[0].text;

    expect(result.details.kind).toBe("gold");
    expect(result.details.evidence.some((item) => item.type === "source" && item.source)).toBe(true);
    expect(text).toContain("黄金价格快照");
    expect(text).toContain("国际现货黄金（XAU/USD）");
    expect(text).toContain("元/克");
    expect(text).toContain("品牌金店首饰金价：1401-1445 元/克");
    expect(text).toContain("银行投资金条：1046.29-1057 元/克");
    expect(text).toContain("黄金回收：约 1027 元/克");
  });

  it("uses Sina direct quotes for Brent oil queries", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("hq.sinajs.cn/list=hf_OIL")) {
        return gbkTextResponse('var hq_str_hf_OIL="100.88,,,,101.20,99.50,15:30,99.35,,,,,2026-04-24,布伦特原油";');
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      plan: { scene: "finance" },
      results: [],
    });

    const result = await createStockMarketTool().execute("test", { query: "今天布伦特石油价格是多少？请给美元/桶和涨跌。" });
    const text = result.content[0].text;

    expect(result.details.kind).toBe("oil");
    expect(result.details.evidence.some((item) => item.source === "新浪财经")).toBe(true);
    expect(text).toContain("布伦特原油：100.88 美元/桶");
  });

  it("uses Tencent direct quote for simple A-share price queries", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("qt.gtimg.cn/q=sz002639")) {
        return gbkTextResponse('v_sz002639="51~雪人集团~002639~18.04~18.37~18.11~413968~176083~237885~18.04~1248~18.03~793~18.02~225~18.01~255~18.00~1337~18.05~504~18.06~266~18.07~310~18.08~1740~18.09~986~~20260424161451~-0.33~-1.80~18.46~17.86~18.04/413968/749021964~413968~74902~6.36~335.20";');
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      plan: { scene: "finance" },
      results: [],
    });

    const result = await createStockMarketTool().execute("test", {
      query: "雪人集团002639现在股价多少？只给价格、涨跌幅和来源。",
    });
    const text = result.content[0].text;

    expect(result.details.kind).toBe("stock");
    expect(result.details.provider).toBe("腾讯行情");
    expect(result.details.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "quote",
        symbol: "002639.SZ",
        value: "18.04",
        source: "腾讯行情",
      }),
    ]));
    expect(text).toContain("002639.SZ 最近可用行情");
    expect(text).toContain("雪人集团");
    expect(text).toContain("18.04 CNY");
    expect(text).toContain("-0.33 / -1.80%");
    expect(text).toContain("成交额: 7.49 亿元");
    expect(text).toContain("换手率: 6.36%");
    expect(searchMock.runSearchQuery).not.toHaveBeenCalled();
  });

  it("uses direct HK and US price queries", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("hq.sinajs.cn/list=rt_hk00700")) {
        return gbkTextResponse(`var hq_str_rt_hk00700="${sinaHkQuote({
          name: "腾讯控股",
          previous: "495.200",
          open: "492.000",
          high: "495.000",
          low: "487.000",
          close: "493.400",
          change: "-1.800",
          pct: "-0.36",
        })}";`);
      }
      if (href.includes("stooq.com")) {
        return new Response("Symbol,Date,Time,Open,High,Low,Close,Volume\nAAPL.US,2026-04-24,22:00:07,270.00,273.06,269.65,271.06,38135000\n", {
          status: 200,
          headers: { "content-type": "text/csv" },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      plan: { scene: "finance" },
      results: [],
    });

    const prompt = "查询 AAPL 和腾讯控股 0700.HK 最新股价，只要价格和涨跌幅。";
    const result = await createStockMarketTool().execute("test", { query: prompt });
    const text = result.content[0].text;

    expect(inferReportResearchKind(prompt)).toBe("market");
    expect(result.details.kind).toBe("stock");
    expect(text).toContain("AAPL");
    expect(text).toContain("271.06 USD");
    expect(text).toContain("腾讯控股");
    expect(text).toContain("493.400 HKD");
    expect(text).toContain("-1.800 / -0.36%");
    expect(searchMock.runSearchQuery).not.toHaveBeenCalled();
  });

  it("expands HK tech sector queries into direct basket quotes", async () => {
    const quoteMap = new Map([
      ["00700", { name: "腾讯控股", close: "480.400", change: "-13.000", pct: "-2.64" }],
      ["09988", { name: "阿里巴巴-W", close: "118.200", change: "-4.000", pct: "-3.27" }],
      ["03690", { name: "美团-W", close: "101.700", change: "-2.800", pct: "-2.68" }],
      ["01810", { name: "小米集团-W", close: "45.300", change: "-0.900", pct: "-1.95" }],
      ["01024", { name: "快手-W", close: "74.500", change: "-1.100", pct: "-1.46" }],
      ["09618", { name: "京东集团-SW", close: "130.800", change: "-2.400", pct: "-1.80" }],
    ]);

    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      const match = href.match(/rt_hk(\d{5})/);
      if (match && quoteMap.has(match[1])) {
        const item = quoteMap.get(match[1]);
        return gbkTextResponse(`var hq_str_rt_hk${match[1]}="${sinaHkQuote({
          name: item.name,
          previous: "500.000",
          open: item.close,
          high: item.close,
          low: item.close,
          close: item.close,
          change: item.change,
          pct: item.pct,
        })}";`);
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      plan: { scene: "finance" },
      results: [],
    });

    const prompt = "恒生科技成分股今天表现";
    const result = await createStockMarketTool().execute("test", { query: prompt });
    const text = result.content[0].text;

    expect(inferReportResearchKind(prompt)).toBe("market");
    expect(result.details.kind).toBe("stock");
    expect(result.details.provider).toBe("新浪财经");
    expect(result.details.directQuotes).toHaveLength(6);
    expect(text).toContain("00700.HK 最近可用行情");
    expect(text).toContain("腾讯控股");
    expect(text).toContain("09988.HK 最近可用行情");
    expect(text).toContain("阿里巴巴-W");
    expect(text).toContain("03690.HK 最近可用行情");
    expect(text).toContain("美团-W");
    expect(searchMock.runSearchQuery).not.toHaveBeenCalled();
  });

  it("expands A-share and US sector queries into representative direct baskets", async () => {
    const aShareMap = new Map([
      ["688629", { name: "华丰科技", price: "125.57" }],
      ["300308", { name: "中际旭创", price: "388.00" }],
      ["300502", { name: "新易盛", price: "299.00" }],
      ["002230", { name: "科大讯飞", price: "60.00" }],
      ["000977", { name: "浪潮信息", price: "55.00" }],
      ["688981", { name: "中芯国际", price: "120.00" }],
    ]);
    const usMap = new Map([
      ["aapl.us", ["AAPL.US", "271.06"]],
      ["msft.us", ["MSFT.US", "512.20"]],
      ["nvda.us", ["NVDA.US", "190.10"]],
      ["googl.us", ["GOOGL.US", "310.00"]],
      ["amzn.us", ["AMZN.US", "235.00"]],
      ["meta.us", ["META.US", "755.00"]],
      ["tsla.us", ["TSLA.US", "470.00"]],
    ]);

    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      const aMatch = href.match(/qt\.gtimg\.cn\/q=(?:sh|sz)(\d{6})/);
      if (aMatch && aShareMap.has(aMatch[1])) {
        const item = aShareMap.get(aMatch[1]);
        return gbkTextResponse(`v_${aMatch[1]}="${tencentAQuote({
          code: aMatch[1],
          name: item.name,
          price: item.price,
        })}";`);
      }
      const sMatch = href.match(/s=([^&]+)/);
      const stooqKey = decodeURIComponent(sMatch?.[1] || "").toLowerCase();
      if (usMap.has(stooqKey)) {
        const [symbol, close] = usMap.get(stooqKey);
        return new Response(`Symbol,Date,Time,Open,High,Low,Close,Volume\n${symbol},2026-04-24,22:00:07,100.00,110.00,99.00,${close},1000000\n`, {
          status: 200,
          headers: { "content-type": "text/csv" },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      plan: { scene: "finance" },
      results: [],
    });

    const aResult = await createStockMarketTool().execute("test", { query: "创业板科技股今天表现" });
    const aText = aResult.content[0].text;
    expect(aResult.details.directQuotes.length).toBeGreaterThanOrEqual(5);
    expect(aText).toContain("688629.SH 最近可用行情");
    expect(aText).toContain("华丰科技");
    expect(aText).toContain("300308.SZ 最近可用行情");
    expect(searchMock.runSearchQuery).not.toHaveBeenCalled();

    const usResult = await createStockMarketTool().execute("test", { query: "美股七姐妹今天表现" });
    const usText = usResult.content[0].text;
    expect(usResult.details.directQuotes.length).toBe(7);
    expect(usText).toContain("AAPL");
    expect(usText).toContain("NVDA");
    expect(usText).toContain("MSFT");
    expect(searchMock.runSearchQuery).not.toHaveBeenCalled();
  });

  it("resolves open-ended concept-stock queries through search before direct quotes", async () => {
    const aShareMap = new Map([
      ["002261", { name: "拓维信息", price: "28.60" }],
      ["300766", { name: "每日互动", price: "38.20" }],
      ["600633", { name: "浙数文化", price: "18.88" }],
    ]);
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      const aMatch = href.match(/qt\.gtimg\.cn\/q=(?:sh|sz)(\d{6})/);
      if (aMatch && aShareMap.has(aMatch[1])) {
        const item = aShareMap.get(aMatch[1]);
        return gbkTextResponse(`v_${aMatch[1]}="${tencentAQuote({
          code: aMatch[1],
          name: item.name,
          price: item.price,
        })}";`);
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      plan: { scene: "finance" },
      results: [{
        title: "DeepSeek概念股龙头名单",
        url: "https://example.com/deepseek-stocks",
        snippet: "DeepSeek概念股包括拓维信息(002261)、每日互动(300766)、浙数文化(600633)等。",
      }],
    });

    const result = await createStockMarketTool().execute("test", { query: "DeepSeek概念股今天表现" });
    const text = result.content[0].text;

    expect(result.details.kind).toBe("stock");
    expect(result.details.directQuotes).toHaveLength(3);
    expect(text).toContain("002261.SZ 最近可用行情");
    expect(text).toContain("拓维信息");
    expect(text).toContain("300766.SZ 最近可用行情");
    expect(text).toContain("每日互动");
    expect(text).toContain("600633.SH 最近可用行情");
    expect(text).toContain("浙数文化");
    expect(searchMock.runSearchQuery).toHaveBeenCalled();
  });

  it("does not treat finance source brands as concept constituents", async () => {
    const aShareMap = new Map([
      ["002261", { name: "拓维信息", price: "28.60" }],
      ["300766", { name: "每日互动", price: "38.20" }],
    ]);
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      const aMatch = href.match(/qt\.gtimg\.cn\/q=(?:sh|sz)(\d{6})/);
      if (aMatch && aShareMap.has(aMatch[1])) {
        const item = aShareMap.get(aMatch[1]);
        return gbkTextResponse(`v_${aMatch[1]}="${tencentAQuote({
          code: aMatch[1],
          name: item.name,
          price: item.price,
        })}";`);
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      plan: { scene: "finance" },
      results: [{
        title: "DeepSeek概念股 东方财富 股票代码 中信证券研报",
        url: "https://data.eastmoney.com/concept/deepseek",
        snippet: "东方财富整理 DeepSeek 概念股名单，中信证券研报点评；相关标的包括拓维信息(002261)、每日互动(300766)。",
      }],
    });
    fetchContentMock.fetchWebContent.mockResolvedValue({ text: "页面导航：东方财富 数据中心 中信证券研报。DeepSeek概念股包括拓维信息(002261)、每日互动(300766)。" });

    const result = await createStockMarketTool().execute("test", { query: "DeepSeek概念股今天表现" });
    const symbols = result.details.directQuotes.map((item) => item.symbol);

    expect(symbols).toEqual(expect.arrayContaining(["002261.SZ", "300766.SZ"]));
    expect(symbols).not.toContain("300059.SZ");
    expect(symbols).not.toContain("600030.SH");
  });

  it("does not repeat dynamic concept resolution after an empty first attempt", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      throw new Error(`unexpected direct quote fetch ${String(url)}`);
    }));

    searchMock.runSearchQuery.mockResolvedValue({
      provider: "mock-search",
      plan: { scene: "finance" },
      results: [{
        title: "DeepSeek 行业新闻",
        url: "https://example.com/deepseek-news",
        snippet: "OPEN DEEP BANK GROW 都只是普通英文词，这里没有股票代码。",
      }],
    });
    fetchContentMock.fetchWebContent.mockResolvedValue({
      text: "这是一篇行业新闻，没有 A 股代码、港股代码或美股 ticker。",
    });

    await createStockMarketTool().execute("test", { query: "DeepSeek概念股今天表现" });

    // Two concept-search queries plus one final general fallback search.
    // The old path retried concept resolution a second time and inflated this to five calls.
    expect(searchMock.runSearchQuery).toHaveBeenCalledTimes(3);
  });

  it("uses Open-Meteo forecast data with temperature and rain probability", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("geocoding-api.open-meteo.com")) {
        return jsonResponse({
          results: [{
            name: "深圳",
            admin1: "广东",
            latitude: 22.54554,
            longitude: 114.0683,
            timezone: "Asia/Shanghai",
          }],
        });
      }
      if (href.includes("api.open-meteo.com")) {
        return jsonResponse({
          current: {
            temperature_2m: 22.2,
            apparent_temperature: 24.1,
            relative_humidity_2m: 80,
            precipitation: 0.1,
            weather_code: 3,
            wind_speed_10m: 9.2,
          },
          daily: {
            time: ["2026-04-24", "2026-04-25"],
            weather_code: [61, 3],
            temperature_2m_min: [20.1, 21.0],
            temperature_2m_max: [26.6, 28.0],
            precipitation_probability_max: [80, 25],
            precipitation_sum: [3.2, 0.1],
          },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    const result = await createWeatherTool().execute("test", {
      query: "深圳明天天气如何？给温度区间和降雨概率",
    });
    const text = result.content[0].text;

    expect(result.details.provider).toBe("open-meteo");
    expect(result.details.location).toBe("深圳");
    expect(result.details.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "weather",
        source: "open-meteo",
        location: "深圳",
        fallback: true,
      }),
    ]));
    expect(text).toContain("深圳 · 广东");
    expect(text).toContain("20.1~26.6°C");
    expect(text).toContain("降雨概率 25%");
  });

  it("localizes wttr weather labels for Chinese city queries", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("wttr.in")) {
        return jsonResponse({
          nearest_area: [{ areaName: [{ value: "Pootung" }] }],
          current_condition: [{
            weatherDesc: [{ value: "Sunny" }],
            temp_C: "24",
            FeelsLikeC: "25",
            humidity: "54",
            windspeedKmph: "10",
            precipMM: "0.0",
          }],
          weather: [{
            date: "2026-04-24",
            mintempC: "18",
            maxtempC: "26",
            hourly: [{ weatherDesc: [{ value: "Patchy rain nearby" }] }],
          }],
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    const result = await createWeatherTool().execute("test", {
      query: "上海明天天气",
    });
    const text = result.content[0].text;

    expect(result.details.provider).toBe("wttr.in");
    expect(result.details.location).toBe("上海");
    expect(text).toContain("上海 当前天气");
    expect(text).toContain("天气: 晴");
    expect(text).toContain("24°C");
    expect(text).toContain("附近有零星小雨");
    expect(text).not.toContain("Pootung");
  });

  it("extracts common city names from rain questions without a weather keyword", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("geocoding-api.open-meteo.com")) {
        return jsonResponse({
          results: [{
            name: "上海",
            admin1: "上海",
            latitude: 31.2304,
            longitude: 121.4737,
            timezone: "Asia/Shanghai",
          }],
        });
      }
      if (href.includes("api.open-meteo.com")) {
        return jsonResponse({
          current: {
            temperature_2m: 18,
            apparent_temperature: 18,
            relative_humidity_2m: 70,
            precipitation: 0,
            weather_code: 3,
            wind_speed_10m: 8,
          },
          daily: {
            time: ["2026-04-24", "2026-04-25"],
            weather_code: [3, 61],
            temperature_2m_min: [15, 16],
            temperature_2m_max: [21, 22],
            precipitation_probability_max: [10, 65],
            precipitation_sum: [0, 2.3],
          },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    const result = await createWeatherTool().execute("test", {
      query: "上海明天下雨吗？",
    });

    expect(result.details.provider).toBe("open-meteo");
    expect(result.details.location).toBe("上海");
    expect(result.content[0].text).toContain("上海 · 上海");
    expect(result.content[0].text).toContain("降雨概率 65%");
  });

  it("does not strip the leading character from city names such as 和田", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      const href = String(url);
      if (href.includes("geocoding-api.open-meteo.com")) {
        expect(decodeURIComponent(href)).toContain("和田");
        return jsonResponse({
          results: [{
            name: "和田",
            admin1: "新疆",
            latitude: 37.1143,
            longitude: 79.9225,
            timezone: "Asia/Shanghai",
          }],
        });
      }
      if (href.includes("api.open-meteo.com")) {
        return jsonResponse({
          current: {
            temperature_2m: 12,
            apparent_temperature: 11,
            relative_humidity_2m: 40,
            precipitation: 0,
            weather_code: 0,
            wind_speed_10m: 7,
          },
          daily: {
            time: ["2026-04-24", "2026-04-25"],
            weather_code: [0, 1],
            temperature_2m_min: [8, 9],
            temperature_2m_max: [20, 22],
            precipitation_probability_max: [0, 5],
            precipitation_sum: [0, 0],
          },
        });
      }
      throw new Error(`unexpected fetch ${href}`);
    }));

    const result = await createWeatherTool().execute("test", {
      query: "和田明天天气",
    });

    expect(result.details.location).toBe("和田");
    expect(result.content[0].text).toContain("和田 · 新疆");
  });
});
