const ROUTE_INTENTS = Object.freeze({
  CHAT: "chat",
  REASONING: "reasoning",
  UTILITY: "utility",
  CODING: "coding",
  VISION: "vision",
});

const CODE_FILE_RE = /\b[\w./-]+\.(?:tsx?|jsx?|css|json|md|py|rs|go|java|vue|svelte|swift|kt|kts|c|cc|cpp|h|hpp|m|mm|sql|yaml|yml|toml|sh)\b/i;
const CODING_RE = /(?:\b(?:code|coding|bug|debug|refactor|compile|build|test|fix|patch|repo|repository|pull request|pr|commit|stack trace|syntax error|lint|typescript|javascript|python|node|npm|pnpm|yarn|bun|rust|cargo|go test)\b|写代码|改代码|修复|重构|编译|测试|报错|堆栈|仓库|提交|接口实现|代码审查|代码评审)/i;
const UTILITY_RE = /(?:\b(?:workspace|working directory|folder|directory|file system|terminal|command|shell|bash|script|automation|cron|inspect files|scan files|list files|read file|open file|find file|grep|ls|pwd)\b|工作区|当前目录|文件夹|目录|终端|命令|脚本|自动任务|定时任务|巡检|检查文件|读取文件|查看文件|笺|工作清单|整理工作区|打开文件)/i;
const VISION_RE = /(?:\b(?:image|images|screenshot|screenshots|photo|diagram|chart|ocr|vision|ui diff|visual)\b|图片|截图|照片|图表|流程图|界面图|识图|看图|OCR|视觉)/i;
const REASONING_RE = /(?:\b(?:analyze|analysis|explain|compare|research|investigate|latest|today|live|market|price|prices|news|trend|trends|summary|summarize|report|proposal|plan|why|what happened|stock|stocks|gold|silver|fx|exchange rate|score|scores|sports)\b|分析|解释|对比|调研|研究|总结|汇总|最新|今日|今天|实时|行情|价格|新闻|趋势|热搜|爆款|方案|计划|为什么|股价|金价|汇率|比分|体育)/i;

function normalizedText(raw) {
  return String(raw || "").trim();
}

export function normalizeRouteIntent(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return Object.values(ROUTE_INTENTS).includes(normalized) ? normalized : ROUTE_INTENTS.CHAT;
}

export function classifyRouteIntent(text, opts = {}) {
  const normalized = normalizedText(text);
  const hasImages = Number(opts.imagesCount || 0) > 0 || Number(opts.attachmentsCount || 0) > 0;

  if (hasImages || VISION_RE.test(normalized)) return ROUTE_INTENTS.VISION;
  if (CODE_FILE_RE.test(normalized) || CODING_RE.test(normalized)) return ROUTE_INTENTS.CODING;
  if (UTILITY_RE.test(normalized)) return ROUTE_INTENTS.UTILITY;
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
      ? "【本轮任务类型】这更像执行型任务。优先按“默认执行链路”处理：多用真实工具检查工作区、文件、命令和自动化状态，尽快拿到可验证结果，不要只停留在口头建议。"
      : "[Current task type] This is primarily an execution task. Treat it as a default execution-route task: use real tools to inspect the workspace, files, commands, and automation state, and get to verifiable results quickly instead of staying in advisory mode.";
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
