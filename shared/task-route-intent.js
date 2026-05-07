import { classifyByLLM, scoreRegexConfidence } from "./llm-triage.js";

const ROUTE_INTENTS = Object.freeze({
  CHAT: "chat",
  REASONING: "reasoning",
  UTILITY: "utility",
  CODING: "coding",
  VISION: "vision",
});

const STRICT_TOOL_FIRST_PROVIDER_IDS = new Set([
  "moonshot",
  "kimi-coding",
  "minimax",
  "minimax-coding",
  "stepfun",
  "stepfun-coding",
  "gemini",
  "openrouter",
]);

const STRICT_TOOL_FIRST_MODEL_RE = /\b(?:kimi|moonshot|minimax|step|gemini)\b/i;
const PENDING_TOOL_EXECUTION_PATTERNS = [
  /^(?:让我|我来|我先|现在就|马上)(?:去|来)?(?:查询|查一下|查找|搜索|搜一下|检索|查看|看一下|看|读取|读一下|读|打开|检查|扫描|浏览|列出|整理|分析|获取|比对|对比|比较)/i,
  /^(?:让我|我来|我先|现在就|马上).*(?:天气|金价|股价|指数|基金|汇率|新闻|头条|热点|比分|赛程|排名|评测|测评|版本更新|官方文档)/i,
  /^(?:我来|我先|让我).*(?:工作区|当前目录|桌面|文件夹|目录|文件|工作清单|优先事项|笺)/i,
  /(?:开始|接下来|下一步|准备|现在).{0,24}(?:创建|新建|建立|移动|挪到|挪进|复制|拷贝|删除|执行|运行|调用|读取|查询|搜索|整理|归档)/i,
  /^(?:我需要|需要|应该|必须).{0,24}(?:用|使用|调用).{0,18}(?:正确的|真实的)?(?:工具|bash|shell|ls|read|grep|find|命令).{0,28}(?:读取|查看|列出|搜索|查询|获取)/i,
  /^(?:我需要|需要|应该|必须).{0,28}(?:读取|查看|列出|打开).{0,20}(?:工作区|当前目录|桌面|文件夹|目录|文件|工作清单|优先事项|笺)/i,
  /(?:没有|缺少|无法|不能).{0,16}(?:文件系统|本地文件|目录|文件夹).{0,18}(?:权限|工具|读取|访问|列出)/i,
  /(?:没有|无法使用|不能使用).{0,18}(?:ls|read|grep|find|bash|shell|命令行|终端).{0,12}(?:工具|能力|权限)?/i,
  /^(?:let me|i(?:'ll| will))\s+(?:check|look up|search|find|get|compare|review)\b/i,
  /(?:no|without|lack|missing|cannot|can't|unable to).{0,24}(?:file system|local file|directory|folder|shell|command).{0,24}(?:access|permission|tool|read|list)/i,
  /^(?:directly|now|next)\s+(?:use|call|run|invoke)\s+(?:the )?(?:real )?(?:weather|stock_market|sports_score|live_news|web_search|web_fetch)\b/i,
  /^(?:直接|立刻|立即|马上).*(?:调用|使用).*(?:weather|stock_market|sports_score|live_news|web_search|web_fetch|搜索工具|天气工具|行情工具)/i,
  /(?:^|[\n。.！？\s])\s*开始(?:系统|深度|深入|进一步)?(?:调研|研究|搜集|收集|挖掘|探索|检索)/i,
  /(?:[，,。.\s]|^)继续(?:深挖|深入|搜集|搜索|抓取|爬取|挖掘|挖|检索)(?=[，,。.！？\s]|具体|更多|详细|深入|页面|数据|信息|资料|$)/i,
  /(?:搜索结果|检索结果|查询结果|结果|信息|资料)(?:较|偏|有些|稍|有点)?(?:简略|简单|浅|泛|少|不够|不足|有限|偏泛)/i,
  /需要(?:再|进一步|继续|更|更多)?(?:抓取|爬取|搜索|查询|检索|挖掘|搜集)(?:具体|更多|详细|深入|页面|数据|信息|资料)/i,
];

const CODE_FILE_RE = /\b[\w./-]+\.(?:tsx?|jsx?|css|json|md|py|rs|go|java|vue|svelte|swift|kt|kts|c|cc|cpp|h|hpp|m|mm|sql|yaml|yml|toml|sh)\b/i;
const INSTALL_RE = /(?:\b(?:install|setup|set up|upgrade|homebrew|brew|uvx?|pip3?|apt(?:-get)?|yum|dnf|pacman|cargo install|go install|npm install|pnpm add|yarn add|yarn global add)\b|安装|装一下|装上|配环境|装依赖|安装依赖|安装软件|安装工具)/i;
const CODING_RE = /(?:\b(?:code|coding|bug|debug|refactor|compile|build|test|fix|patch|repo|repository|pull request|pr|commit|stack trace|syntax error|lint|typescript|javascript|python|node|npm|pnpm|yarn|bun|rust|cargo|go test)\b|写代码|改代码|修复|重构|编译|测试|报错|堆栈|仓库|提交|接口实现|代码审查|代码评审)/i;
const UTILITY_RE = /(?:\b(?:workspace|working directory|folder|directory|file system|terminal|command|shell|bash|script|automation|cron|inspect files|scan files|list files|read file|open file|find file|grep|ls|pwd|pdf|spreadsheet|excel|merge reports?)\b|工作区|当前目录|桌面|文件夹|目录|终端|命令|脚本|自动任务|定时任务|提醒|巡检|检查文件|读取文件|查看文件|读取PDF|PDF|合并报表|合并报告|整理桌面|整理工作区|打开文件|笺|工作清单)/i;
const SEARCH_FIRST_RE = /(?:\b(?:today|latest|live|current|market|price|prices|quote|quotes|weather|forecast|news|headline|headlines|trend|trends|score|scores|schedule|standings|gold|silver|oil|stock|stocks|index|indices|fund|funds|fx|exchange rate|benchmark|benchmarks|leaderboard|release note|release notes|changelog|official docs?|research|investigate|compare|comparison)\b|今天|今日|最新|实时|当前|行情|价格|报价|收盘价|盘前|盘后|涨跌|财报|天气|预报|新闻|头条|热点|趋势|比分|赛程|排名|金价|银价|油价|股价|指数|基金|汇率|评测|测评|基准|榜单|官方文档|调研|研究|对比|比较)/i;
const LIVE_EVENT_RE = /(?=.*(?:美伊|伊朗|美国|中东|巴以|以色列|巴勒斯坦|俄乌|俄罗斯|乌克兰|关税|制裁|冲突|停火|谈判|选举|地震|台风|事故))(?=.*(?:今天|今日|最新|实时|进展|消息|新闻|报道|发生|了吗|如何|怎么样))/i;
const DOMAIN_RESEARCH_RE = /(?=.*(?:调研|研究|评估|分析|对比|比较|查|搜|搜索|查询|补充|整理|汇总|报告))(?=.*(?:楼盘|小区|房价|新房|二手房|容积率|绿化率|开盘|成交价|学校|医院|配套|爆款|热销|榜单|竞品|舆情|公司|品牌|产品|政策|法规|公告|论文|专利))/i;
const STOCK_RESEARCH_RE = /(?=.*(?:股票|股价|个股|A股|a股|科创板|创业板|标的|走势|怎么看|技术面|基本面|资金|资金流|财报|研报|公告|解禁|减持|支撑位|压力位|K线|k线|均线|成交量|成交额|筹码|止损|止盈|仓位|目标价|三种情景|操作计划|未来1-3个月|深度|报告|预测|分析|调研|研究))(?=.*(?:\b[0368]\d{5}\b|股票|股价|个股|A股|a股|科创板|创业板|[\u4e00-\u9fa5A-Za-z]{2,18}(?:科技|股份|电子|智能|软件|证券|银行|集团|药业|医药|能源|材料|半导体|光电|电气|通信|汽车|机器人|芯片|电力)))/i;
const VISION_RE = /(?:\b(?:image|images|screenshot|screenshots|photo|diagram|chart|ocr|vision|ui diff|visual)\b|图片|截图|照片|图表|流程图|界面图|识图|看图|OCR|视觉)/i;
const NAMED_ASCII_CONCEPT_QUESTION_RE = /(?:你知道|知道|了解|听说过|介绍一下|讲讲|解释一下|什么是|是啥|what\s+is|do\s+you\s+know|tell\s+me\s+about)\s*[“"'`《]?[A-Za-z][A-Za-z0-9_.:+/-]{2,}/i;
const NAMED_ZH_CONCEPT_QUESTION_RE = /(?:你知道|知道|了解|听说过|介绍一下|讲讲|解释一下|什么是|是啥)\s*[“"'`《]?[\u4e00-\u9fa5A-Za-z0-9][\u4e00-\u9fa5A-Za-z0-9 _+./-]{1,60}(?:模型|项目|工具|框架|库|论文|算法|产品|服务|协议|标准|团队|公司)/i;
const EXPLICIT_VISION_OBJECT_RE = /(?:这张|这个|这些|上传|附件|屏幕|界面).{0,12}(?:图片|截图|照片|图|图表|界面|image|screenshot|photo|diagram|chart)|(?:图片|截图|照片|图表|OCR|识图|看图|vision|visual).{0,16}(?:内容|文字|识别|提取|分析|看看|看一下|是什么|有什么)/i;
// [FIX 2026-04-27 night] file-management verbs + folder/file objects → UTILITY (优先级高于 VISION)
// 防止"新建图片文件夹/移动图片到文件夹/整理桌面图片"被 VISION_RE("图片"裸字) 误判成图像分析任务,
// 进而注入"默认推理链路"系统提示让模型只 narrate 不调工具。
const FILE_OPS_RE = /(?:(?:新建|创建|建立|建一个|做一个|加一个|生成).{0,8}(?:文件夹|目录|folder|directory))|(?:(?:移动|挪到|挪进|挪去|放到|放进|拷贝|复制|copy|move).{0,12}(?:文件夹|目录|folder|directory|里|进))|(?:(?:整理|归档|归类|分类|清理).{0,10}(?:文件夹|目录|文件|桌面|下载))|(?:把.{0,30}(?:移到|放到|放进|挪到|挪进|归档到|归类到))/i;
const REASONING_RE = /(?:\b(?:analyze|analysis|explain|compare|research|investigate|latest|today|live|market|price|prices|news|trend|trends|summary|summarize|report|proposal|plan|why|what happened|stock|stocks|gold|silver|fx|exchange rate|score|scores|sports)\b|分析|解释|对比|调研|研究|总结|汇总|最新|今日|今天|实时|行情|价格|新闻|趋势|热搜|爆款|方案|计划|为什么|股价|金价|汇率|比分|体育)/i;
const INTERNAL_AUTOMATION_RE = /(?:\[心跳巡检\]|\[目录巡检\]|系统自动触发|不是用户发来的|用户目前没有在跟你对话|内部思考环节|下一轮才是你真正|回复会直接发送到群聊|#ch_crew|频道最近消息|error\.defaultChannelDesc|search_memory)/i;

function normalizedText(raw) {
  return String(raw || "").trim();
}

function isPlainNamedConceptQuestion(text) {
  const normalized = normalizedText(text);
  if (!normalized) return false;
  if (SEARCH_FIRST_RE.test(normalized) || LIVE_EVENT_RE.test(normalized) || DOMAIN_RESEARCH_RE.test(normalized) || STOCK_RESEARCH_RE.test(normalized)) {
    return false;
  }
  if (EXPLICIT_VISION_OBJECT_RE.test(normalized)) return false;
  return NAMED_ASCII_CONCEPT_QUESTION_RE.test(normalized) || NAMED_ZH_CONCEPT_QUESTION_RE.test(normalized);
}

export function matchesInstallIntent(text) {
  return INSTALL_RE.test(normalizedText(text));
}

export function isInternalAutomationPrompt(text) {
  const normalized = normalizedText(text);
  if (!normalized) return false;
  if (/\[心跳巡检\]|\[目录巡检\]/.test(normalized)) return true;
  if (/系统自动触发/.test(normalized) && /不是用户发来的/.test(normalized)) return true;
  if (/用户目前没有在跟你对话/.test(normalized)) return true;
  if (/#ch_crew|频道最近消息|error\.defaultChannelDesc/i.test(normalized)
    && /内部思考环节|下一轮才是你真正|回复会直接发送到群聊|search_memory/i.test(normalized)) {
    return true;
  }
  return INTERNAL_AUTOMATION_RE.test(normalized)
    && /不是用户发来的|内部思考环节|回复会直接发送到群聊|用户目前没有在跟你对话/i.test(normalized);
}

export function normalizeRouteIntent(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return Object.values(ROUTE_INTENTS).includes(normalized) ? normalized : ROUTE_INTENTS.CHAT;
}

// [LLM Triage v1 · 2026-04-27 night] 把 text 跑过所有 regex,返回每类是否命中。
// 用于 scoreRegexConfidence:1 命中 = 高信心(regex 直接定)、2+ 命中 = 歧义(LLM 兜底)。
function computeRegexHits(text, opts = {}) {
  const normalized = normalizedText(text);
  const hasImages = Number(opts.imagesCount || 0) > 0 || Number(opts.attachmentsCount || 0) > 0;
  return {
    fileOps: !hasImages && FILE_OPS_RE.test(normalized),
    vision: hasImages || VISION_RE.test(normalized),
    coding: CODE_FILE_RE.test(normalized) || CODING_RE.test(normalized),
    install: INSTALL_RE.test(normalized),
    utility: UTILITY_RE.test(normalized),
    liveEvent: LIVE_EVENT_RE.test(normalized),
    domainResearch: DOMAIN_RESEARCH_RE.test(normalized),
    stockResearch: STOCK_RESEARCH_RE.test(normalized),
    searchFirst: SEARCH_FIRST_RE.test(normalized),
    reasoning: REASONING_RE.test(normalized),
  };
}

export function classifyRouteIntent(text, opts = {}) {
  const normalized = normalizedText(text);
  const hasImages = Number(opts.imagesCount || 0) > 0 || Number(opts.attachmentsCount || 0) > 0;

  // [FIX 2026-04-27 night] 文本里没有真附件时,文件管理动词 + 文件夹/目录 优先判 UTILITY,
  // 避免 VISION_RE 看到裸"图片"两字就把"新建图片文件夹/移动图片到目录"误判成图像分析。
  if (!hasImages && FILE_OPS_RE.test(normalized)) return ROUTE_INTENTS.UTILITY;

  if (isInternalAutomationPrompt(normalized)) return ROUTE_INTENTS.REASONING;
  if (INSTALL_RE.test(normalized)) return ROUTE_INTENTS.UTILITY;
  if (CODE_FILE_RE.test(normalized) || CODING_RE.test(normalized)) return ROUTE_INTENTS.CODING;
  if (!hasImages && isPlainNamedConceptQuestion(normalized)) return ROUTE_INTENTS.CHAT;
  if (hasImages || VISION_RE.test(normalized)) return ROUTE_INTENTS.VISION;
  if (UTILITY_RE.test(normalized)) return ROUTE_INTENTS.UTILITY;
  if (LIVE_EVENT_RE.test(normalized)) return ROUTE_INTENTS.UTILITY;
  if (DOMAIN_RESEARCH_RE.test(normalized)) return ROUTE_INTENTS.UTILITY;
  if (STOCK_RESEARCH_RE.test(normalized)) return ROUTE_INTENTS.UTILITY;
  if (SEARCH_FIRST_RE.test(normalized)) return ROUTE_INTENTS.UTILITY;
  if (REASONING_RE.test(normalized)) return ROUTE_INTENTS.REASONING;
  return ROUTE_INTENTS.CHAT;
}

/**
 * [LLM Triage v1 · 2026-04-27 night] Hybrid 分类器:
 *   regex 高 confidence(单一类命中)→ 直接走 classifyRouteIntent
 *   regex 歧义(多个类同时命中)/ 全空(很短查询)→ 调 Spark FP8 LLM 兜底
 *   LLM 不可达(Spark down)→ degrade 到 regex 的 best-effort
 *
 * 用于替代纯 regex 分类,保证文件管理(新建/移动/挪)+ 图片场景这种典型歧义不再误判。
 *
 * 注意:async,用 await。同步 caller 用 classifyRouteIntent。
 */
export async function classifyRouteIntentHybrid(text, opts = {}) {
  const normalized = normalizedText(text);
  const hasImages = Number(opts.imagesCount || 0) > 0 || Number(opts.attachmentsCount || 0) > 0;

  // 0) FILE_OPS hard rule(高 confidence,直接定 — 跟同步版一致,保证回归测试稳定)
  if (!hasImages && FILE_OPS_RE.test(normalized)) return ROUTE_INTENTS.UTILITY;

  // 1) 跑所有 regex,算 confidence
  const hits = computeRegexHits(text, opts);
  // 把 fileOps/install/utility/liveEvent/domainResearch/stockResearch/searchFirst 都归 utility 大类来算 confidence
  const utilityFamily = hits.fileOps || hits.install || hits.utility
    || hits.liveEvent || hits.domainResearch || hits.stockResearch || hits.searchFirst;
  const summary = {
    vision: hits.vision,
    coding: hits.coding,
    utility: utilityFamily,
    reasoning: hits.reasoning,
  };
  const confidence = scoreRegexConfidence(summary);

  // 2) 高 confidence → regex 直接定
  if (confidence >= 0.85) {
    return classifyRouteIntent(text, opts);
  }

  // 3) 歧义 → LLM Triage 兜底
  if (opts.skipLLM) {
    return classifyRouteIntent(text, opts);
  }
  const llm = await classifyByLLM(normalized, opts);
  if (llm && llm.intent) {
    if (llm.intent === "vision") return ROUTE_INTENTS.VISION;
    if (llm.intent === "utility") return ROUTE_INTENTS.UTILITY;
    if (llm.intent === "coding") return ROUTE_INTENTS.CODING;
    if (llm.intent === "reasoning") return ROUTE_INTENTS.REASONING;
    return ROUTE_INTENTS.CHAT;
  }

  // 4) LLM 不可达 → fallback 到 regex
  return classifyRouteIntent(text, opts);
}

export function buildRouteIntentSystemHint(routeIntent, locale = "zh") {
  const isZh = String(locale || "").toLowerCase().startsWith("zh");
  const intent = normalizeRouteIntent(routeIntent);

  if (intent === ROUTE_INTENTS.CODING) {
    return isZh
      ? "【本轮任务类型】这更像编码型任务。优先按“默认编码链路”思考与执行：先检查相关文件、错误信息和测试线索，再用真实工具逐步修改、验证并完成，不要停留在泛泛建议。调试/修复类任务的最终回答必须给出可复制的验证命令（例如 python main.py、npm test、pytest），并明确提示用户“请运行验证”；没有真实修改时不要说“已修复”。"
      : "[Current task type] This is primarily a coding task. Treat it as a default coding-route task: inspect relevant files, errors, and test signals first, then use real tools to edit, verify, and finish. Do not stay at generic advice. For debugging/fix tasks, the final answer must include a copyable verification command (for example python main.py, npm test, or pytest) and explicitly ask the user to run it; do not say it is fixed when no real change was made.";
  }
  if (intent === ROUTE_INTENTS.UTILITY) {
    return isZh
      ? "【本轮任务类型】这更像工具优先任务。优先按“默认工作链路”处理：工作区/文件/命令用 ls/read/grep/find/bash；安装依赖用 bash 并等待结果；天气用 weather；金价/股价/指数/汇率用 stock_market，必要时补 web_search；体育比分/赛程用 sports_score；实时新闻、国际事件、热点、房产楼盘、竞品调研、模型评测、版本更新和官方资料用 live_news / web_search / web_fetch。用户问什么就围绕什么自然延展：证据链任务可以用 bash 跑临时 Python/Node 脚本抓取、解析、去重、制表和计算；资料不足时先给已验证部分，再向用户索要具体截图、链接、导出文件、PDF 或假设参数。如果上下文已经出现【系统已完成】或【系统已完成实时/行情/天气/新闻/楼盘/股票资料预取】，说明 Lynn 本地工具已经拿到真实资料，此时直接基于资料回答，不要重复调用工具或模拟工具。先拿到真实工具结果，再总结给用户；如果工具链没有稳定返回，也要用可见正文说明已知信息、未核验缺口和下一步，不要只输出“我来查一下”后结束。不要先输出计划、反思、<execute>、web_search(...) 或任何伪工具文本。"
      : "[Current task type] This is primarily a tool-first task. Treat it as a default work-route task: use ls/read/grep/find/bash for workspace, files, and commands; bash for installation requests; weather for weather; stock_market for prices, equities, indices, and exchange rates, with web_search as backup; sports_score for sports; live_news / web_search / web_fetch for breaking news, public events, real estate, competitive research, benchmarks, release notes, and official docs. Follow the user's exact question instead of a fixed template: for evidence-chain tasks, use bash to run temporary Python/Node scripts to fetch, parse, deduplicate, tabulate, and calculate; if source material is missing, provide verified findings and ask for the specific screenshot, link, export, PDF, or assumption. If the context already contains a completed Lynn prefetch block, local tools have already gathered real evidence; answer directly from that evidence instead of calling or simulating tools again. Get real tool results first, then summarize. If the tool chain does not return stable results, still write visible text with known information, unverified gaps, and the next step; do not only say that you will look something up. Do not emit planning, reflection, <execute>, web_search(...), or any pseudo tool text.";
  }
  if (intent === ROUTE_INTENTS.VISION) {
    return isZh
      ? "【本轮任务类型】这更像图像或附件分析任务。优先按“默认推理链路”处理，先理解图片/附件里的关键信息，再给结论；只有确实需要时才补充额外工具。"
      : "[Current task type] This is primarily an image or attachment analysis task. Treat it as a default reasoning-route task: understand the key information in the image or attachment first, then answer. Only add extra tools when they are genuinely needed.";
  }
  if (intent === ROUTE_INTENTS.REASONING) {
    return isZh
      ? "【本轮任务类型】这更像分析调研任务。优先按“默认推理链路”处理：先梳理用户真正的问题，再按命题决定需要哪些资料、计算和验证；涉及数据、文档、财经、房产、竞品或长报告时，不要只凭常识写，必要时转工具或脚本拿证据。"
      : "[Current task type] This is primarily an analysis or research task. Treat it as a default reasoning-route task: identify the user's real question first, then decide what evidence, calculation, and verification it needs; for data, documents, finance, real estate, competitive research, or long reports, do not rely on general knowledge when tools or scripts can provide evidence.";
  }
  return "";
}

function shouldUseStrictToolFirstHint(provider, modelId, routeIntent) {
  const intent = normalizeRouteIntent(routeIntent);
  if (![ROUTE_INTENTS.UTILITY, ROUTE_INTENTS.CODING].includes(intent)) return false;
  const providerId = String(provider || "").trim().toLowerCase();
  const id = String(modelId || "").trim();
  if (providerId === "zhipu" || providerId === "zhipu-coding") return false;
  if (STRICT_TOOL_FIRST_PROVIDER_IDS.has(providerId)) return true;
  return STRICT_TOOL_FIRST_MODEL_RE.test(`${providerId} ${id}`);
}

export function buildProviderToolCallHint({ routeIntent, provider, modelId, locale = "zh" } = {}) {
  if (!shouldUseStrictToolFirstHint(provider, modelId, routeIntent)) return "";
  const isZh = String(locale || "").toLowerCase().startsWith("zh");
  if (isZh) {
    return [
      "【工具优先兼容提示】当前这条模型链路只有在你先发出标准 tool call 时，才能稳定完成搜索、天气、行情、新闻、比分、安装和资料查询任务。",
      "遇到这类任务时，不要先输出 Premise / Conduct / Reflection / Act，也不要先说“我来查询”“让我搜索”“我先看看”。",
      "第一步就直接调用真实工具；如果需要多个工具，一次只调一个，等结果回来再继续。",
      "在拿到真实工具结果之前，正文保持极短或为空；但如果工具链没有稳定返回，最终也必须用可见正文说明已知信息、限制和下一步，不能空答。绝不要在正文里打印 web_search(...)、weather(...)、stock_market(...) 或任何伪工具调用标记。",
    ].join(" ");
  }
  return [
    "[Tool-first compatibility hint] This provider only completes lookup and execution tasks reliably when you emit a standard tool call first.",
    "For search, weather, market data, news, scores, installation, or docs lookup tasks, do not output Premise / Conduct / Reflection / Act and do not say things like \"let me search\" first.",
    "Your first step must be a real tool call. If you need more than one tool, call one tool at a time and wait for the result before continuing.",
    "Until a real tool result arrives, keep the assistant text empty or extremely short. If the tool chain does not return stable results, the final answer must still include visible text with known information, limits, and the next step; do not end empty. Never print pseudo tool-call text such as web_search(...), weather(...), or stock_market(...).",
  ].join(" ");
}

function collectPendingExecutionCandidates(text) {
  const normalized = normalizedText(text);
  if (!normalized) return [];
  const paragraphs = normalized.split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  const lines = normalized.split("\n").map((item) => item.trim()).filter(Boolean);
  const candidates = [
    normalized,
    paragraphs.at(-1) || "",
    paragraphs.slice(-2).join(" "),
    lines.at(-1) || "",
    lines.slice(-4).join(" "),
  ];
  return [...new Set(candidates.filter(Boolean).map((item) => item.replace(/\s+/g, " ").trim()))];
}

export function looksLikePendingToolExecutionText(text, routeIntent) {
  const intent = normalizeRouteIntent(routeIntent);
  if (![ROUTE_INTENTS.UTILITY, ROUTE_INTENTS.CODING].includes(intent)) return false;
  const candidates = collectPendingExecutionCandidates(text);
  return candidates.some((candidate) => {
    if (!candidate || candidate.length > 420) return false;
    return PENDING_TOOL_EXECUTION_PATTERNS.some((re) => re.test(candidate));
  });
}

export function getRouteIntentNoticeKey(routeIntent) {
  const intent = normalizeRouteIntent(routeIntent);
  if (intent === ROUTE_INTENTS.CODING) return "status.routeCodingPlanned";
  if (intent === ROUTE_INTENTS.UTILITY) return "status.routeExecutionPlanned";
  if (intent === ROUTE_INTENTS.VISION) return "status.routeVisionPlanned";
  if (intent === ROUTE_INTENTS.REASONING) return "status.routeReasoningPlanned";
  return "";
}

export function getDefaultRouteSlowNoticeKey(routeIntent, elapsedMs = 0) {
  const intent = normalizeRouteIntent(routeIntent);
  const stillWorking = elapsedMs >= 60_000;
  if (intent === ROUTE_INTENTS.CODING) {
    return stillWorking ? "status.defaultCodingStillWorking" : "status.defaultCodingSlowResponse";
  }
  if (intent === ROUTE_INTENTS.UTILITY) {
    return stillWorking ? "status.defaultExecutionStillWorking" : "status.defaultExecutionSlowResponse";
  }
  if (intent === ROUTE_INTENTS.REASONING || intent === ROUTE_INTENTS.VISION) {
    return stillWorking ? "status.defaultReasoningStillWorking" : "status.defaultReasoningSlowResponse";
  }
  return stillWorking ? "status.defaultModelStillWorking" : "status.defaultModelSlowResponse";
}

export function getDefaultRouteRecoveryNoticeKey(routeIntent) {
  const intent = normalizeRouteIntent(routeIntent);
  if (intent === ROUTE_INTENTS.CODING) return "status.defaultCodingRecoveringToolExecution";
  return "status.defaultModelRecoveringToolExecution";
}

export { ROUTE_INTENTS };
