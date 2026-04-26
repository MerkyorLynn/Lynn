function normalizedText(raw) {
  return String(raw || "").trim();
}

function repairMarkdownBoundaries(raw) {
  return String(raw || "")
    .replace(/\r\n/g, "\n")
    .replace(/([^\n])\s*(#{1,6}\s+)/g, "$1\n\n$2")
    .replace(/([。！？；;.!?])\s*-\s+/g, "$1\n- ")
    .replace(/([^\n])\s*(\d+\.\s+[\u4e00-\u9fa5A-Za-z])/g, "$1\n$2")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripUnfinishedToolPromises(raw) {
  return String(raw || "")
    .replace(/(?:^|(?<=[。！？；;.!?\n]))\s*(?:我(?:来|先|会|需要)?|让我|现在(?:先)?)(?:去|来)?(?:搜一下|搜索|查询|查一下|查找|检索|看一下|补充)(?:[^。！？\n]{0,90})(?:[。！？]|$)/g, "")
    .replace(/(?:^|(?<=[。！？；;.!?\n]))\s*(?:I'll|I will|Let me)\s+(?:search|look up|check|query|fetch)(?:[^.!?\n]{0,120})(?:[.!?]|$)/gi, "");
}

function cleanReportText(raw) {
  return repairMarkdownBoundaries(stripUnfinishedToolPromises(raw));
}

function hasSection(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function heading(title, body) {
  return `## ${title}\n${body}`.trim();
}

function detectStockReport(text) {
  if (!text) return false;
  if (/深度走势预测报告|走势预测报告|投资评级|三种情景推演|资金情绪|技术面/.test(text)
    && /(?:\b[0368]\d{5}\b|股票|股价|标的|现价|目标价|止损|止盈|仓位)/.test(text)) {
    return true;
  }
  return /(?:\b[0368]\d{5}\b).{0,120}(?:未来1-3个月|走势|技术面|基本面|操作策略|风险提示)/s.test(text);
}

function detectRealEstateReport(text) {
  if (!text) return false;
  if (/鸣溪谷|山语海|兰溪谷/.test(text)) return true;
  return /(?:楼盘|小区|住宅|二手房|房价).{0,160}(?:容积率|绿化率|山海景观|景观|匹配度|均价|价格)/s.test(text);
}

const STOCK_COMPANY_PROMPT_RE = /[\u4e00-\u9fa5A-Za-z]{2,18}(?:科技|股份|电子|智能|软件|证券|银行|集团|药业|医药|能源|材料|半导体|光电|电气|通信|汽车|机器人|芯片|电力|股份)/;
const STOCK_PROMPT_ANALYSIS_RE = /(?:股票|股价|个股|A股|a股|科创板|创业板|标的|走势|怎么看|技术面|基本面|资金|资金流|财报|研报|公告|解禁|减持|支撑位|压力位|K线|k线|均线|成交量|成交额|筹码|止损|止盈|仓位|目标价|三种情景|操作计划|未来1-3个月|深度|报告|预测|分析|调研|研究)/i;
const SIMPLE_STOCK_QUOTE_PROMPT_RE = /(?:股价|现价|最新价|行情|报价|涨跌幅|成交额|换手率).{0,80}(?:多少|是多少|给|只给|直接给|来源|数字)|(?:只给|直接给).{0,80}(?:价格|现价|涨跌幅|成交额|换手率|来源|数字)/i;
const STOCK_DEEP_INTENT_RE = /(?:怎么看|分析|研究|调研|报告|预测|走势|未来|基本面|技术面|估值|市值|区间|资金|资金流|财报|研报|公告|解禁|减持|支撑位|压力位|K线|k线|均线|成交量|筹码|止损|止盈|仓位|目标价|三种情景|操作计划|风险|买|卖|投资)/i;

function detectStockResearchPrompt(text) {
  if (SIMPLE_STOCK_QUOTE_PROMPT_RE.test(text) && !STOCK_DEEP_INTENT_RE.test(text)) {
    return false;
  }
  if (/(?:\b[0368]\d{5}\b|股票|股价|走势|技术面|资金情绪|三种情景|操作计划|风险提示).{0,160}(?:深度|报告|预测|分析|未来1-3个月|腾讯文档|怎么看|支撑位|压力位|调研|研究)/s.test(text)) {
    return true;
  }
  return STOCK_COMPANY_PROMPT_RE.test(text) && STOCK_PROMPT_ANALYSIS_RE.test(text);
}

function extractStockName(text) {
  const withCode = text.match(/([\u4e00-\u9fa5A-Za-z]{2,20})[（(]?([0368]\d{5})(?:\.[A-Z]{2})?[）)]?/);
  if (withCode) return `${withCode[1]}（${withCode[2]}）`;
  const codeOnly = text.match(/\b([0368]\d{5})\b/);
  if (codeOnly) return codeOnly[1];
  return "当前标的";
}

function extractPriceLine(text) {
  const price = text.match(/(?:当前价位|当前价格|现价|收盘价|价格)[:：\s]*([0-9]+(?:\.[0-9]+)?\s*元?)/);
  if (price) return price[1].trim();
  const yuan = text.match(/([0-9]+(?:\.[0-9]+)?元)/);
  if (yuan) return yuan[1].trim();
  return "以最新行情源二次核验";
}

function buildStockConclusion(text) {
  if (/高位震荡|震荡/.test(text)) return "未来1-3个月更适合按“高位震荡、等待业绩与资金面验证”的框架处理；向上需要业绩/订单/板块情绪共振，向下重点防范高估值、减持解禁与板块退潮。";
  if (/谨慎偏多|偏多|突破/.test(text)) return "未来1-3个月偏谨慎乐观，但只有放量突破并获得业绩验证后，才适合提高仓位；否则以区间交易和风险控制为主。";
  if (/悲观|下探|跌破/.test(text)) return "未来1-3个月风险收益比偏谨慎，优先观察关键支撑和业绩验证，避免在高波动阶段重仓追高。";
  return "未来1-3个月建议按“数据验证优先、仓位分批、严格止损”的框架处理，避免只凭题材或短线情绪追高。";
}

function normalizeStockReport(text) {
  // Do not synthesize research sections here. The app should get evidence before
  // answering; this pass only cleans transport/model artifacts.
  return cleanReportText(text);
}

function normalizeRealEstateReport(text) {
  return cleanReportText(text);
}

export function inferReportKind(text) {
  const normalized = normalizedText(text);
  if (!normalized) return "";
  if (detectStockReport(normalized)) return "stock";
  if (detectRealEstateReport(normalized)) return "real_estate";
  return "";
}

export function normalizeReportResponseText(text) {
  const normalized = cleanReportText(normalizedText(text));
  if (!normalized) return String(text || "");
  const kind = inferReportKind(normalized);
  if (kind === "stock") return normalizeStockReport(normalized);
  if (kind === "real_estate") return normalizeRealEstateReport(normalized);
  return repairMarkdownBoundaries(String(text || ""));
}

export function inferReportPromptKind(text) {
  const normalized = normalizedText(text);
  if (!normalized) return "";
  if (detectStockResearchPrompt(normalized)) {
    return "stock";
  }
  if (/(?:鸣溪谷|山语海|兰溪谷|楼盘|小区|蛇口|容积率|绿化率|山海景观|二手房|房价).{0,160}(?:评估|对比|标准|价格|匹配|分析|报告|补充)/s.test(normalized)) {
    return "real_estate";
  }
  return "";
}

export function buildReportStructureHint(text, locale = "zh") {
  const kind = inferReportPromptKind(text);
  if (!kind) return "";
  const isZh = String(locale || "").toLowerCase().startsWith("zh");
  if (!isZh) {
    return [
      "[Adaptive research requirement]",
      "Research the user's exact question instead of forcing a fixed report template.",
      "First identify what evidence the question needs, fetch or calculate that evidence when tools/scripts are available, then answer with sections that match the question.",
      "Use temporary Python/Node scripts when useful for parsing source text, deduplicating search hits, calculating valuation ranges, or building comparison tables.",
      "If key data is unavailable, mark it as [needs verification], answer only from verified evidence, and ask the user for the specific missing screenshot, link, export, PDF, or assumption.",
      kind === "stock"
        ? "For stocks, choose only the relevant modules: fundamentals, valuation/market-cap range, technical support/resistance, funds/sentiment, scenarios, operation plan, or risks depending on what the user asked."
        : "For real estate, choose only the relevant modules: baseline criteria, candidates, FAR/greenery, view resources, prices, match ranking, conclusion, and verification gaps depending on what the user asked.",
    ].join("\n");
  }
  if (kind === "stock") {
    return [
      "【自适应研究要求】",
      "用户要什么就研究什么，不要把所有股票问题都套成固定报告。先把用户命题拆成资料需求，再找资料、交叉核验、必要时自己用 bash 跑临时 Python/Node 脚本做抓取、解析、表格汇总或估值/区间计算。",
      "如果用户问“怎么看/深度/未来走势”，再覆盖基本面、估值、技术面、资金情绪、情景推演、操作计划和风险；如果只问压力位/支撑位，就重点研究 K 线、均线、成交量、筹码、近期高低点、缺口、量价确认和失效条件；如果问估值/市值区间，就重点找财报、总股本、市值、利润/收入假设、可比公司倍数和情景区间。",
      "工具或资料不足时，不要硬编，也不要停在“我搜一下”。先给已验证结论和推导过程，再明确列出还缺什么，并向用户索要具体交易软件截图、公告链接、财报页、导出数据、PDF 或持仓成本/周期假设。",
      "输出结构按用户命题自然组织；可以有“资料路径/证据表/计算过程/结论/风险/还缺资料”，但不要为了凑模板强行添加无关小节。",
    ].join("\n");
  }
  return [
    "【自适应研究要求】",
    "用户要什么就研究什么，不要把所有楼盘问题都套成固定报告。先拆出用户关心的指标（例如容积率、绿化率、山海景观、价格、成交、学区、地铁、物业、噪音、楼龄），再围绕这些指标找资料和组织答案。",
    "资料不完整时，用【待核验】标注来源不确定，但不要直接结束；继续给出基于已验证信息的候选、匹配度、价格判断和核验路径。",
    "若需要比较或排序，可以自己用脚本把候选项目、指标、价格和缺口整理成表；若缺少关键成交/挂牌/楼层视野数据，要明确向用户要贝壳/链家截图、成交页、具体户型楼层或预算约束。",
  ].join("\n");
}
