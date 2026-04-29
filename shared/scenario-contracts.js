const SCENARIO_CONTRACT_IDS = Object.freeze({
  WEATHER: "weather",
  GOLD: "gold",
  STOCK: "stock",
  FILES: "files",
  NEWS: "news",
  LONG_REPORT: "long_report",
  REALTIME_DATA: "realtime_data",
  MARKET_RESEARCH: "market_research",
  NEWS_FACT: "news_fact",
  DOCUMENT_FILE: "document_file",
  LOCAL_AUTOMATION: "local_automation",
  MULTIMEDIA: "multimedia",
  LONG_AGENT: "long_agent",
  GENERAL: "general",
});

const CONTRACTS = Object.freeze({
  [SCENARIO_CONTRACT_IDS.WEATHER]: {
    title: "天气",
    requiredEvidence: ["地点", "日期/时间", "天气状态", "温度/降雨", "来源"],
    passCriteria: "必须给出地点、日期、温度或降雨判断；无法从主源拿到结果时换源或明确说未核验。",
    failureMode: "说明天气源失败或无数据，给出用户可核验的官方天气入口，不用猜测替代实时数据。",
    regressionCases: ["上海明天下雨吗", "今天北京天气和温度", "明早 8 点深圳适合出门吗"],
    examples: ["天气", "下雨", "温度", "带伞"],
  },
  [SCENARIO_CONTRACT_IDS.GOLD]: {
    title: "金价",
    requiredEvidence: ["品种", "价格", "单位", "时间戳", "来源"],
    passCriteria: "必须区分国际金价/沪金/回收金价等口径，给出单位和来源；不能只说涨跌。",
    failureMode: "说明哪个行情源失败，给出可核验来源或提示稍后重试，不编造价格。",
    regressionCases: ["今天金价如何", "现在黄金回收多少钱一克", "XAU 最新报价"],
    examples: ["黄金", "金价", "沪金", "XAU", "黄金回收"],
  },
  [SCENARIO_CONTRACT_IDS.STOCK]: {
    title: "股票/行情",
    requiredEvidence: ["标的/候选池", "价格或关键指标", "时间戳", "来源", "风险提示"],
    passCriteria: "单标的必须给最新可用行情；板块/概念必须先建立候选池再排序；投资相关必须标注非投资建议。",
    failureMode: "行情源失败时说明缺口，保留已验证部分，不用旧数据或主观判断冒充实时行情。",
    regressionCases: ["查 AAPL 和 TSLA 最新股价", "DeepSeek 概念股今天表现", "美股七姐妹今天表现"],
    examples: ["股票", "股价", "行情", "概念股", "指数", "ETF"],
  },
  [SCENARIO_CONTRACT_IDS.FILES]: {
    title: "文件",
    requiredEvidence: ["真实路径", "执行前状态", "执行动作/读取内容", "执行后状态"],
    passCriteria: "读文件必须说明读到的文件名/页数/表名；移动/创建/删除必须有执行前后状态，删除必须先确认范围。",
    failureMode: "路径、权限或格式失败时明确未完成项；不能把计划、扫描或空输出说成已经完成。",
    regressionCases: ["把当前目录所有 Excel 和 CSV 移到表格文件夹", "删除 delete-me.txt 但保留 keep.txt", "读取这个 PDF 并提取付款条款"],
    examples: ["文件", "PDF", "Excel", "移动", "删除", "创建文件夹"],
  },
  [SCENARIO_CONTRACT_IDS.NEWS]: {
    title: "新闻",
    requiredEvidence: ["发生日期", "可靠来源", "链接/出处", "事实与解读分离"],
    passCriteria: "必须给新闻发生日期和来源；事实、影响、推测分开写；无法联网时明确说明。",
    failureMode: "没有可靠来源时说未核验，给出检索建议，不把搜索摘要、旧闻或传闻当事实。",
    regressionCases: ["今天科技/AI 领域两条重要新闻", "美伊谈判今天有进展吗", "这个政策最新消息按时间线整理"],
    examples: ["新闻", "最新消息", "政策", "时间线", "事实核查"],
  },
  [SCENARIO_CONTRACT_IDS.LONG_REPORT]: {
    title: "长报告",
    requiredEvidence: ["任务拆解", "证据链", "中间产物", "最终交付"],
    passCriteria: "必须先拆解，再收集证据和中间产物，最后交付完整报告；不能只给标题或空壳。",
    failureMode: "超时或资料不足时交付当前进度、证据清单、缺口和下一步，不静默空答。",
    regressionCases: ["做一份完整深度报告，不要伪深度", "分析这个项目代码结构并给优化方案", "长文调研一个行业"],
    examples: ["深度报告", "深度研究", "项目代码分析", "复杂报告"],
  },
  [SCENARIO_CONTRACT_IDS.REALTIME_DATA]: {
    title: "实时数据类",
    requiredEvidence: ["数字", "时间戳", "来源"],
    passCriteria: "必须给出可读数值、报价或状态；拿不到主源时换源，不用长篇解释代替答案。",
    failureMode: "明确说明哪个来源失败、已尝试哪些兜底，并给出下一步最小补充信息。",
    examples: ["金价", "原油", "汇率", "天气", "航班", "体育比分", "股价"],
  },
  [SCENARIO_CONTRACT_IDS.MARKET_RESEARCH]: {
    title: "行情/研究类",
    requiredEvidence: ["候选池", "批量行情/基本面数据", "结论排序"],
    passCriteria: "先建立标的或候选池，再批量拉数据，最后输出判断；不能只有标题或空壳报告。",
    failureMode: "如果候选池或关键数据不足，先给已验证部分和缺口，不伪造深度结论。",
    examples: ["股票", "概念股", "行业板块", "深度报告", "房地产"],
  },
  [SCENARIO_CONTRACT_IDS.NEWS_FACT]: {
    title: "新闻/事实类",
    requiredEvidence: ["时间线", "至少一个可靠来源", "事实与解读分离"],
    passCriteria: "按时间排序，交叉验证关键事实，明确区分发生了什么和市场/舆论解读。",
    failureMode: "没有可靠来源时直接说未核验，不把旧闻、传闻或搜索摘要当成事实。",
    examples: ["最新新闻", "政策", "公司动态", "国际事件"],
  },
  [SCENARIO_CONTRACT_IDS.DOCUMENT_FILE]: {
    title: "文档/文件类",
    requiredEvidence: ["真实读取到的文件", "文件名/页数/表名/段落", "提取内容"],
    passCriteria: "必须真实读取文件，并列出读到了什么；没读到不能假装分析。",
    failureMode: "说明文件不可读、路径不对或格式不支持，并请求用户补文件或授权。",
    examples: ["PDF", "Word", "Excel", "合同", "桌面文件", "合并报表"],
  },
  [SCENARIO_CONTRACT_IDS.LOCAL_AUTOMATION]: {
    title: "本地任务/自动化类",
    requiredEvidence: ["执行前状态", "执行动作", "执行后状态"],
    passCriteria: "执行前后有状态，失败可恢复；用户不需要看巡检噪音。",
    failureMode: "失败时保留可恢复路径，说明未完成项和安全边界。",
    examples: ["整理桌面", "定时提醒", "批量改名", "生成 HTML/Markdown/PPT"],
  },
  [SCENARIO_CONTRACT_IDS.MULTIMEDIA]: {
    title: "多媒体类",
    requiredEvidence: ["附件/音频/图片已进入处理链路", "服务健康状态", "fallback 说明"],
    passCriteria: "附件必须可靠进入模型；TTS/ASR 先做健康检查，失败要明确 fallback。",
    failureMode: "如果图片/音频没有进入模型，直接提示重新上传或给路径，不假装看过/听过。",
    examples: ["图片识别", "TTS", "ASR", "图片生成"],
  },
  [SCENARIO_CONTRACT_IDS.LONG_AGENT]: {
    title: "长任务/Agent 类",
    requiredEvidence: ["任务拆解", "证据链", "中间产物", "最终交付"],
    passCriteria: "拆任务、拿证据、运行脚本、生成中间产物并交付完整结果，不允许伪深度。",
    failureMode: "超时或资料不足时交付当前进度、证据清单和下一步，而不是空壳报告。",
    examples: ["深度研究", "项目代码分析", "复杂报告", "连续多步任务"],
  },
  [SCENARIO_CONTRACT_IDS.GENERAL]: {
    title: "通用对话",
    requiredEvidence: [],
    passCriteria: "自然回答用户问题。",
    failureMode: "不确定时说明假设。",
    examples: [],
  },
});

const WEATHER_RE = /(?:天气|下雨|降雨|温度|气温|带伞|台风|空气质量|AQI|weather|rain|temperature)/i;
const GOLD_RE = /(?:金价|黄金|沪金|伦敦金|黄金回收|\bXAU\b|\bau\b|gold)/i;
const STOCK_RE = /(?:股票|股价|行情|最新价|现价|收盘|开盘|涨跌|成交|市值|美股|港股|A股|a股|纳斯达克|纽交所|道指|标普|纳指|概念股|板块|行业|题材|赛道|龙头|成分股|ETF|基金|ticker|symbol|stock|share|quote|market|nasdaq|nyse|DeepSeek概念|七姐妹)/i;
const FILES_RE = /(?:PDF|Word|Excel|docx|xlsx|csv|合同|报表|文件|文件夹|目录|桌面|下载文件夹|读取|读一下|打开|合并报表|条款|页码|表格|附件)|(?:(?:移动|挪到|挪进|挪去|放到|放进|归档|整理|删除|删掉|创建|新建|保存到|拷贝|复制).{0,16}(?:文件|文件夹|目录|桌面|下载|PDF|Word|Excel|docx|xlsx|csv|表格|附件|图片|folder|directory))|(?:(?:文件|文件夹|目录|桌面|下载|PDF|Word|Excel|docx|xlsx|csv|表格|附件|图片|folder|directory).{0,16}(?:移动|挪到|挪进|挪去|放到|放进|归档|整理|删除|删掉|创建|新建|保存到|拷贝|复制))/i;
const NEWS_RE = /(?:新闻|最新消息|政策|发布|宣布|进展|谈判|制裁|关税|冲突|停火|选举|地震|台风|事故|公司动态|发生了什么|报道|时间线|事实核查)/i;
const LONG_REPORT_SPECIFIC_RE = /(?:长任务|深度研究|深度调研|深度报告|完整调研|复杂报告|项目代码分析|架构分析|代码结构|连续多步|尽调|从头到尾|完整报告|完整深度报告|伪深度|跑脚本|运行脚本|中间产物|交付结果)/i;

const REALTIME_RE = /(?:今天|今日|实时|当前|最新|现在|明天|昨天).{0,24}(?:金价|黄金|银价|白银|原油|布伦特|WTI|汇率|天气|下雨|温度|航班|比分|赛程|股价|行情|指数|ETF|基金|价格|报价|现价|收盘|涨跌|盘前|盘后)|(?:金价|黄金|银价|白银|油价|原油|布伦特|汇率|天气|航班|比分|股价|现价|报价).{0,18}(?:如何|多少|怎么样|几度|涨|跌)/i;
const MARKET_RESEARCH_RE = /(?:概念股|板块|行业|七姐妹|太空光伏|DeepSeek概念|基本面|估值|市值|技术面|资金面|研报|财报|公告|支撑位|压力位|K线|均线|深度报告|走势预判|房地产|楼盘|容积率|绿化率|候选楼盘|标的池|股票池)/i;
const NEWS_FACT_RE = /(?:新闻|最新消息|政策|发布|宣布|进展|谈判|制裁|关税|冲突|停火|选举|地震|台风|事故|公司动态|发生了什么|报道|时间线|事实核查)/i;
const DOCUMENT_FILE_RE = /(?:PDF|Word|Excel|docx|xlsx|csv|合同|报表|文件|桌面|读取|读一下|打开|合并报表|条款|页码|表格|附件).{0,24}(?:分析|提取|总结|合并|读取|看一下|整理)|(?:读取|读一下|打开|分析|提取).{0,24}(?:PDF|Word|Excel|docx|xlsx|csv|合同|文件|附件)/i;
const LOCAL_AUTOMATION_RE = /(?:整理桌面|整理工作区|批量改名|定时|提醒|闹钟|自动化|巡检|生成HTML|生成 HTML|生成Markdown|生成 Markdown|生成PPT|创建文件|保存到桌面|移动文件|删除重复|归档)/i;
const MULTIMEDIA_RE = /(?:图片|截图|照片|图像|OCR|看图|识图|TTS|ASR|朗读|语音|音频|麦克风|录音|生成图片|画一张|配音|播放失败|合成中)/i;
// [FIX 2026-04-27 night] file-management verbs + folder/file objects → LOCAL_AUTOMATION 优先于 MULTIMEDIA
// 镜像 task-route-intent.js 的 FILE_OPS_RE,防止 MULTIMEDIA_RE 看到"图片"裸字把
// "新建图片文件夹/移动图片到文件夹/整理桌面图片"误判成 multimedia → 注入"附件必须可靠进入模型"系统提示
const SCENARIO_FILE_OPS_RE = /(?:(?:新建|创建|建立|建一个|做一个|加一个|生成).{0,8}(?:文件夹|目录|folder|directory))|(?:(?:移动|挪到|挪进|挪去|放到|放进|拷贝|复制|copy|move).{0,12}(?:文件夹|目录|folder|directory|里|进))|(?:(?:整理|归档|归类|分类|清理).{0,10}(?:文件夹|目录|文件|桌面|下载))|(?:把.{0,30}(?:移到|放到|放进|挪到|挪进|归档到|归类到))/i;
const LONG_AGENT_RE = /(?:长任务|深度研究|深度调研|深度报告|完整调研|复杂报告|项目代码分析|架构分析|代码结构|连续多步|尽调|从头到尾|完整报告|完整深度报告|伪深度|跑脚本|运行脚本|中间产物|交付结果)/i;

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function normalizeScenarioContractId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return Object.values(SCENARIO_CONTRACT_IDS).includes(normalized)
    ? normalized
    : SCENARIO_CONTRACT_IDS.GENERAL;
}

export function getScenarioContract(value) {
  return CONTRACTS[normalizeScenarioContractId(value)] || CONTRACTS[SCENARIO_CONTRACT_IDS.GENERAL];
}

export function classifyScenarioContract(text, opts = {}) {
  const normalized = normalizeText(text);
  if (!normalized) return SCENARIO_CONTRACT_IDS.GENERAL;

  const hasImages = Number(opts.imagesCount || 0) > 0;
  const hasAttachments = Number(opts.attachmentsCount || 0) > 0;
  const hasAudio = Number(opts.audioCount || 0) > 0;

  // [FIX 2026-04-27 night] 没有真附件 + 文件管理动词 → 文件契约优先,
  // 防止 MULTIMEDIA_RE 看到"图片"裸字误判,把文件管理任务塞进"多媒体"契约。
  if (!hasImages && !hasAudio && SCENARIO_FILE_OPS_RE.test(normalized)) {
    return SCENARIO_CONTRACT_IDS.FILES;
  }

  if (!hasImages && !hasAudio && NEWS_RE.test(normalized)) return SCENARIO_CONTRACT_IDS.NEWS;
  if (!hasImages && !hasAudio && FILES_RE.test(normalized)) return SCENARIO_CONTRACT_IDS.FILES;

  if (hasImages || hasAudio || MULTIMEDIA_RE.test(normalized)) return SCENARIO_CONTRACT_IDS.MULTIMEDIA;
  if (LONG_REPORT_SPECIFIC_RE.test(normalized)) return SCENARIO_CONTRACT_IDS.LONG_REPORT;
  if (NEWS_RE.test(normalized)) return SCENARIO_CONTRACT_IDS.NEWS;
  if (GOLD_RE.test(normalized)) return SCENARIO_CONTRACT_IDS.GOLD;
  if (WEATHER_RE.test(normalized)) return SCENARIO_CONTRACT_IDS.WEATHER;
  if (STOCK_RE.test(normalized)) return SCENARIO_CONTRACT_IDS.STOCK;
  if (DOCUMENT_FILE_RE.test(normalized)) return SCENARIO_CONTRACT_IDS.DOCUMENT_FILE;
  if (LOCAL_AUTOMATION_RE.test(normalized)) return SCENARIO_CONTRACT_IDS.LOCAL_AUTOMATION;
  if (LONG_AGENT_RE.test(normalized)) return SCENARIO_CONTRACT_IDS.LONG_AGENT;
  if (MARKET_RESEARCH_RE.test(normalized)) return SCENARIO_CONTRACT_IDS.MARKET_RESEARCH;
  if (REALTIME_RE.test(normalized)) return SCENARIO_CONTRACT_IDS.REALTIME_DATA;
  if (NEWS_FACT_RE.test(normalized)) return SCENARIO_CONTRACT_IDS.NEWS_FACT;
  if (hasAttachments) return SCENARIO_CONTRACT_IDS.DOCUMENT_FILE;
  return SCENARIO_CONTRACT_IDS.GENERAL;
}

export function buildScenarioContractHint(contractId, locale = "zh") {
  const id = normalizeScenarioContractId(contractId);
  if (id === SCENARIO_CONTRACT_IDS.GENERAL) return "";
  const contract = getScenarioContract(id);
  const isZh = String(locale || "").toLowerCase().startsWith("zh");
  if (!isZh) {
    return [
      `[Scenario contract] ${contract.title}.`,
      `Required evidence: ${contract.requiredEvidence.join(", ") || "none"}.`,
      `Completion bar: ${contract.passCriteria}`,
      `Fallback: ${contract.failureMode}`,
    ].join(" ");
  }
  return [
    `【场景契约】${contract.title}。`,
    contract.requiredEvidence.length ? `必需证据：${contract.requiredEvidence.join("、")}。` : "",
    `完成标准：${contract.passCriteria}`,
    `失败兜底：${contract.failureMode}`,
  ].filter(Boolean).join(" ");
}

export function buildScenarioContractHintForText(text, opts = {}) {
  const id = classifyScenarioContract(text, opts);
  return buildScenarioContractHint(id, opts.locale || "zh");
}

export { CONTRACTS as SCENARIO_CONTRACTS, SCENARIO_CONTRACT_IDS };
