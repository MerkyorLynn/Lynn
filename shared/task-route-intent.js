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
  /^(?:让我|我来|我先|现在就|马上)(?:去|来)?(?:查询|查一下|查找|搜索|搜一下|检索|查看|看一下|获取|比对|对比|比较)/i,
  /^(?:让我|我来|我先|现在就|马上).*(?:天气|金价|股价|指数|基金|汇率|新闻|头条|热点|比分|赛程|排名|评测|测评|版本更新|官方文档)/i,
  /^(?:let me|i(?:'ll| will))\s+(?:check|look up|search|find|get|compare|review)\b/i,
  /^(?:directly|now|next)\s+(?:use|call|run|invoke)\s+(?:the )?(?:real )?(?:weather|stock_market|sports_score|live_news|web_search|web_fetch)\b/i,
  /^(?:直接|立刻|立即|马上).*(?:调用|使用).*(?:weather|stock_market|sports_score|live_news|web_search|web_fetch|搜索工具|天气工具|行情工具)/i,
];

const CODE_FILE_RE = /\b[\w./-]+\.(?:tsx?|jsx?|css|json|md|py|rs|go|java|vue|svelte|swift|kt|kts|c|cc|cpp|h|hpp|m|mm|sql|yaml|yml|toml|sh)\b/i;
const INSTALL_RE = /(?:\b(?:install|setup|set up|upgrade|homebrew|brew|uvx?|pip3?|apt(?:-get)?|yum|dnf|pacman|cargo install|go install|npm install|pnpm add|yarn add|yarn global add)\b|安装|装一下|装上|配环境|装依赖|安装依赖|安装软件|安装工具)/i;
const CODING_RE = /(?:\b(?:code|coding|bug|debug|refactor|compile|build|test|fix|patch|repo|repository|pull request|pr|commit|stack trace|syntax error|lint|typescript|javascript|python|node|npm|pnpm|yarn|bun|rust|cargo|go test)\b|写代码|改代码|修复|重构|编译|测试|报错|堆栈|仓库|提交|接口实现|代码审查|代码评审)/i;
const UTILITY_RE = /(?:\b(?:workspace|working directory|folder|directory|file system|terminal|command|shell|bash|script|automation|cron|inspect files|scan files|list files|read file|open file|find file|grep|ls|pwd)\b|工作区|当前目录|文件夹|目录|终端|命令|脚本|自动任务|定时任务|巡检|检查文件|读取文件|查看文件|笺|工作清单|整理工作区|打开文件)/i;
const SEARCH_FIRST_RE = /(?:\b(?:today|latest|live|current|market|price|prices|quote|quotes|weather|forecast|news|headline|headlines|trend|trends|score|scores|schedule|standings|gold|silver|oil|stock|stocks|index|indices|fund|funds|fx|exchange rate|benchmark|benchmarks|leaderboard|release note|release notes|changelog|official docs?|research|investigate|compare|comparison)\b|今天|今日|最新|实时|当前|行情|价格|报价|天气|预报|新闻|头条|热点|趋势|比分|赛程|排名|金价|银价|油价|股价|指数|基金|汇率|评测|测评|基准|榜单|官方文档|调研|研究|对比|比较)/i;
const VISION_RE = /(?:\b(?:image|images|screenshot|screenshots|photo|diagram|chart|ocr|vision|ui diff|visual)\b|图片|截图|照片|图表|流程图|界面图|识图|看图|OCR|视觉)/i;
const REASONING_RE = /(?:\b(?:analyze|analysis|explain|compare|research|investigate|latest|today|live|market|price|prices|news|trend|trends|summary|summarize|report|proposal|plan|why|what happened|stock|stocks|gold|silver|fx|exchange rate|score|scores|sports)\b|分析|解释|对比|调研|研究|总结|汇总|最新|今日|今天|实时|行情|价格|新闻|趋势|热搜|爆款|方案|计划|为什么|股价|金价|汇率|比分|体育)/i;

function normalizedText(raw) {
  return String(raw || "").trim();
}

export function matchesInstallIntent(text) {
  return INSTALL_RE.test(normalizedText(text));
}

export function normalizeRouteIntent(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return Object.values(ROUTE_INTENTS).includes(normalized) ? normalized : ROUTE_INTENTS.CHAT;
}

export function classifyRouteIntent(text, opts = {}) {
  const normalized = normalizedText(text);
  const hasImages = Number(opts.imagesCount || 0) > 0 || Number(opts.attachmentsCount || 0) > 0;

  if (hasImages || VISION_RE.test(normalized)) return ROUTE_INTENTS.VISION;
  if (INSTALL_RE.test(normalized)) return ROUTE_INTENTS.UTILITY;
  if (CODE_FILE_RE.test(normalized) || CODING_RE.test(normalized)) return ROUTE_INTENTS.CODING;
  if (UTILITY_RE.test(normalized)) return ROUTE_INTENTS.UTILITY;
  if (SEARCH_FIRST_RE.test(normalized)) return ROUTE_INTENTS.UTILITY;
  if (REASONING_RE.test(normalized)) return ROUTE_INTENTS.REASONING;
  return ROUTE_INTENTS.CHAT;
}

export function buildRouteIntentSystemHint(routeIntent, locale = "zh") {
  const isZh = String(locale || "").toLowerCase().startsWith("zh");
  const intent = normalizeRouteIntent(routeIntent);

  if (intent === ROUTE_INTENTS.CODING) {
    return isZh
      ? "【本轮任务类型】这更像编码型任务。优先按“默认编码链路”思考与执行：先检查相关文件、错误信息和测试线索，再用真实工具逐步修改、验证并完成，不要停留在泛泛建议。"
      : "[Current task type] This is primarily a coding task. Treat it as a default coding-route task: inspect relevant files, errors, and test signals first, then use real tools to edit, verify, and finish. Do not stay at generic advice.";
  }
  if (intent === ROUTE_INTENTS.UTILITY) {
    return isZh
      ? "【本轮任务类型】这更像执行型任务。优先按“默认执行链路”处理：多用真实工具检查工作区、文件、命令和自动化状态，尽快拿到可验证结果，不要只停留在口头建议。遇到安装软件、安装依赖、brew/npm/pip/uv 这类请求时，应直接使用真实 bash 工具执行，并等待执行结果。对于金价、股价、指数、天气、新闻、体育比分、模型评测、版本更新、官方资料这类搜索型问题，也应优先直接调用真实信息工具或 web_search / web_fetch，再基于结果总结；不要先输出一段计划或反思再卡住。"
      : "[Current task type] This is primarily an execution task. Treat it as a default execution-route task: use real tools to inspect the workspace, files, commands, and automation state, and get to verifiable results quickly instead of staying in advisory mode. For software or dependency installation requests (brew/npm/pip/uv, etc.), use the real bash tool directly and wait for its result. For lookup-style tasks such as prices, market data, weather, news, sports scores, model benchmarks, release notes, or official docs, call real information tools or web_search / web_fetch first and only then summarize the result. Do not emit planning or reflection text and stop there.";
  }
  if (intent === ROUTE_INTENTS.VISION) {
    return isZh
      ? "【本轮任务类型】这更像图像或附件分析任务。优先按“默认推理链路”处理，先理解图片/附件里的关键信息，再给结论；只有确实需要时才补充额外工具。"
      : "[Current task type] This is primarily an image or attachment analysis task. Treat it as a default reasoning-route task: understand the key information in the image or attachment first, then answer. Only add extra tools when they are genuinely needed.";
  }
  if (intent === ROUTE_INTENTS.REASONING) {
    return isZh
      ? "【本轮任务类型】这更像分析调研任务。优先按“默认推理链路”处理：先梳理问题、结构化分析，再在必要时调用搜索或读取工具，不要把它当成闲聊。"
      : "[Current task type] This is primarily an analysis or research task. Treat it as a default reasoning-route task: structure the problem first, analyze it clearly, and only then call search or reading tools when needed. Do not treat it like casual chat.";
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
      "在拿到真实工具结果之前，正文保持极短或为空；绝不要在正文里打印 web_search(...)、weather(...)、stock_market(...) 或任何伪工具调用标记。",
    ].join(" ");
  }
  return [
    "[Tool-first compatibility hint] This provider only completes lookup and execution tasks reliably when you emit a standard tool call first.",
    "For search, weather, market data, news, scores, installation, or docs lookup tasks, do not output Premise / Conduct / Reflection / Act and do not say things like \"let me search\" first.",
    "Your first step must be a real tool call. If you need more than one tool, call one tool at a time and wait for the result before continuing.",
    "Until a real tool result arrives, keep the assistant text empty or extremely short. Never print pseudo tool-call text such as web_search(...), weather(...), or stock_market(...).",
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
