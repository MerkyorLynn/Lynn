#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DIALOGUE_PROMPTS } from "./dialogue-scenario-bank.mjs";
import { CLI_FUNCTIONAL_TIMEOUTS, createCliTurnDeadline, isCliTurnActivity } from "./cli-turn-deadline.mjs";
import { weatherAnswerUsesUnrelatedSearch, hasUsdCnyRate, deniesAvailableToolCapability, additionalDialogueQualityReason, claimsFreshToolEvidence, containsMislabeledRelativeDate, containsPastDateFutureStartContradiction, hasVerifiedEmptySportsResult, hasVerifiedNoFixturePredictionAnswer, omitVerifiedSportsFetchWindows, overridesVerifiedEmptySportsWindow, requiresFreshEvidenceForDialogue } from "./dialogue-quality-rules.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CLI = resolve(ROOT, "cli/bin/lynn.mjs");

const PROMPTS = DIALOGUE_PROMPTS;

const BAD_TEXT_NEEDLES = [
  "我已经拿到工具结果",
  "接管总结模型",
  "error.searchFollowupHint",
  "没有形成最终回复",
  "模型这次没有返回可见内容",
  "工具链已执行多轮",
  "工具已经完成执行",
  "模型没有生成最终总结",
  "可见工具证据摘要",
  "已执行 1 个操作",
  "已执行 2 个操作",
  "已执行 3 个操作",
  "已执行 4 个操作",
  "已执行 5 个操作",
  "且模型没有返回总结回复",
  "基于这些工具结果总结一下",
  "可以直接继续追问",
  "providerQuery is not defined",
  "Tool not found",
  "<reflect>",
  "</reflect>",
  "<position>",
  "<cancellation>",
  "<reviews>",
  "<｜｜DSML｜｜",
  "DSML｜｜tool_calls",
  "根据本轮已执行工具返回的证据",
  "根据本轮已执行操作返回的可见结果",
  "这轮操作已有可见结果",
  "先看一下当前代码仓库",
  "让我先看一下当前代码仓库",
  "find /Users/lynn/Downloads/Lynn",
  "工具已经返回内容",
  "工具执行包含",
  "请查看上方工具卡片",
  "抓取出错",
  "抓取失败",
  "HTTP 403",
  "没有提取到足够可靠的事实",
  "能先确认这些数字线索",
  "如果需要更精确的实时结论",
  "【研究资料】",
  "【补充搜索线索】",
  "最新 资料 数据 来源",
  "官方 公告 报告 文档",
  "分析 观点 对比 风险",
  "aborted",
  "request timeout",
  "模型请求超时",
  "模型请求超时，请重试",
  "请缩小问题范围后重试",
  "工具结果中未查到",
  "mimo 搜索",
  "Lynn CLI 版本:",
  "Lynn CLI version:",
  "模型路由:StepFun",
  "Runtime route: StepFun",
  "运行时优化:",
  "Runtime optimizations:",
];

const BAD_ERROR_NEEDLES = [
  ...BAD_TEXT_NEEDLES,
  "Error:",
];

const CURRENT_YEAR = 2026;
function beijingDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function readArgValue(argv, name) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === name) return argv[i + 1] || "";
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return "";
}

function resolveGateCurrentDate(argv = process.argv.slice(2)) {
  const explicit = readArgValue(argv, "--current-date") || process.env.LYNN_GATE_CURRENT_DATE || "";
  if (explicit) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(explicit)) {
      throw new Error(`Invalid --current-date ${explicit}; expected YYYY-MM-DD`);
    }
    return explicit;
  }
  return beijingDate();
}

const CURRENT_DATE = resolveGateCurrentDate();


function parseArgs(argv) {
  const args = {
    cli: process.env.LYNN_CLI_50_BIN || DEFAULT_CLI,
    timeoutMs: Number(process.env.LYNN_CLI_50_TIMEOUT_MS || CLI_FUNCTIONAL_TIMEOUTS.totalMs),
    firstChunkTimeoutMs: Number(process.env.LYNN_CLI_50_FIRST_CHUNK_TIMEOUT_MS || CLI_FUNCTIONAL_TIMEOUTS.firstChunkMs),
    idleTimeoutMs: Number(process.env.LYNN_CLI_50_IDLE_TIMEOUT_MS || CLI_FUNCTIONAL_TIMEOUTS.idleMs),
    limit: PROMPTS.length,
    only: "",
    output: "",
    mode: process.env.LYNN_CLI_50_MODE || "brain",
    dataDir: process.env.LYNN_CLI_50_DATA_DIR || "",
    repeat: Number(process.env.LYNN_CLI_50_REPEAT || "1"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--cli") args.cli = next();
    else if (arg.startsWith("--cli=")) args.cli = arg.slice("--cli=".length);
    else if (arg === "--timeout-ms") args.timeoutMs = Number(next());
    else if (arg.startsWith("--timeout-ms=")) args.timeoutMs = Number(arg.slice("--timeout-ms=".length));
    else if (arg === "--first-chunk-timeout-ms") args.firstChunkTimeoutMs = Number(next());
    else if (arg.startsWith("--first-chunk-timeout-ms=")) args.firstChunkTimeoutMs = Number(arg.slice("--first-chunk-timeout-ms=".length));
    else if (arg === "--idle-timeout-ms") args.idleTimeoutMs = Number(next());
    else if (arg.startsWith("--idle-timeout-ms=")) args.idleTimeoutMs = Number(arg.slice("--idle-timeout-ms=".length));
    else if (arg === "--limit") args.limit = Number(next());
    else if (arg.startsWith("--limit=")) args.limit = Number(arg.slice("--limit=".length));
    else if (arg === "--only") args.only = next();
    else if (arg.startsWith("--only=")) args.only = arg.slice("--only=".length);
    else if (arg === "--output") args.output = next();
    else if (arg.startsWith("--output=")) args.output = arg.slice("--output=".length);
    else if (arg === "--mode") args.mode = next();
    else if (arg.startsWith("--mode=")) args.mode = arg.slice("--mode=".length);
    else if (arg === "--data-dir") args.dataDir = next();
    else if (arg.startsWith("--data-dir=")) args.dataDir = arg.slice("--data-dir=".length);
    else if (arg === "--repeat") args.repeat = Number(next());
    else if (arg.startsWith("--repeat=")) args.repeat = Number(arg.slice("--repeat=".length));
    else if (arg === "--current-date") next();
    else if (arg.startsWith("--current-date=")) {
      // Parsed before parseArgs via resolveGateCurrentDate().
    }
    else if (arg === "--help" || arg === "-h") {
      console.log(`Usage:
  node scripts/cli-50-dialogue-runner.mjs

Options:
  --cli PATH       CLI entry, default: cli/bin/lynn.mjs
  --limit N        run first N prompts for quick checks
  --only LIST      run prompt indexes, e.g. 14,15 or 11-15
  --timeout-ms N   per-dialogue total safety deadline, default 660000
  --first-chunk-timeout-ms N  first useful event deadline, default 600000
  --idle-timeout-ms N  resettable useful-event idle deadline, default 120000
  --output PATH    write JSON report to this path
  --mode MODE      brain (default) or ambient
  --data-dir PATH  CLI data dir; brain mode defaults to a temporary empty dir
  --repeat N       repeat the selected prompt set, default 1
  --current-date YYYY-MM-DD
                   gate date anchor for relative-date assertions`);
      process.exit(0);
    }
  }
  if (!["brain", "ambient"].includes(args.mode)) {
    throw new Error(`Unsupported --mode ${args.mode}; expected brain or ambient`);
  }
  for (const field of ["timeoutMs", "firstChunkTimeoutMs", "idleTimeoutMs"]) {
    if (!Number.isFinite(args[field]) || args[field] <= 0 || args[field] > 2147483647) throw new Error(`Invalid ${field}: ${args[field]}`);
  }
  args.repeat = Math.max(1, Math.floor(Number(args.repeat) || 1));
  if (args.mode === "brain" && !args.dataDir) {
    args.dataDir = mkdtempSync(resolve(os.tmpdir(), "lynn-cli-50-"));
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const outPath = resolve(args.output || `reports/cli-50-results-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
mkdirSync(dirname(outPath), { recursive: true });

function parseOnlyIndexes(raw, total) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const selected = new Set();
  for (const part of text.split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const range = piece.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      for (let idx = lo; idx <= hi; idx += 1) {
        if (idx >= 1 && idx <= total) selected.add(idx);
      }
      continue;
    }
    const idx = Number(piece);
    if (Number.isInteger(idx) && idx >= 1 && idx <= total) selected.add(idx);
  }
  if (!selected.size) throw new Error(`--only did not select any prompt: ${raw}`);
  return selected;
}

function selectedPromptItems(args) {
  const only = parseOnlyIndexes(args.only, PROMPTS.length);
  const all = PROMPTS.map(([category, prompt], index) => ({ index: index + 1, category, prompt }));
  const selected = only ? all.filter((item) => only.has(item.index)) : all.slice(0, Math.max(0, Math.min(args.limit, PROMPTS.length)));
  const repeated = [];
  for (let round = 1; round <= args.repeat; round += 1) {
    for (const item of selected) {
      repeated.push({ ...item, runIndex: repeated.length + 1, repeatRound: round });
    }
  }
  return repeated;
}

function classify(result) {
  const text = result.assistantText.trim();
  const joinedErrors = result.errors.join("\n");
  const bad = BAD_TEXT_NEEDLES.find((needle) => text.includes(needle))
    || BAD_ERROR_NEEDLES.find((needle) => joinedErrors.includes(needle));
  if (result.timedOut) return { status: "timeout", reason: `${result.timeoutKind || "total"} timeout` };
  if (result.exitCode !== 0) return { status: "process_fail", reason: `exit ${result.exitCode}` };
  if (!text) return { status: "empty", reason: "no assistant text" };
  if (bad) return { status: "fallback_or_error_text", reason: bad };
  const qualityIssue = qualityReason(result.prompt, text, result);
  if (qualityIssue) return { status: "quality_fail", reason: qualityIssue };
  return { status: "ok", reason: "" };
}

function hasToolEvidence(result) {
  return Array.isArray(result.toolNames) && result.toolNames.length > 0;
}

function buildReactReview(result) {
  const requiresFreshEvidence = requiresFreshEvidenceForDialogue({
    category: result.category,
    prompt: result.prompt,
  });
  const toolEvents = Array.isArray(result.toolEvents) ? result.toolEvents : [];
  const toolNames = Array.isArray(result.toolNames) ? result.toolNames : [];
  const providerTrail = Array.isArray(result.providerTrail) ? result.providerTrail : [];
  const status = result.status || "unknown";
  let nextAction = "none";
  if (status === "timeout") {
    nextAction = "inspect route/provider latency and tool long-tail; do not mask as acceptable";
  } else if (status === "empty") {
    nextAction = "fix final-answer synthesis or retry/finalizer path; empty visible answer is user-visible failure";
  } else if (status === "fallback_or_error_text") {
    nextAction = "remove leaked fallback/error text at source and ensure a human answer is synthesized";
  } else if (status === "quality_fail") {
    nextAction = "repair route/tool/evidence behavior for this prompt; do not add broad keyword exceptions";
  } else if (status === "process_fail") {
    nextAction = "inspect process stderr/rawTail and fix CLI runtime crash";
  }
  return {
    task: {
      category: result.category,
      prompt: result.prompt,
      requiresFreshEvidence,
    },
    execute: {
      providerTrail,
      toolNames,
      toolEvents,
      hadTools: toolNames.length > 0,
    },
    observe: {
      status,
      reason: result.reason || "",
      textChars: String(result.assistantText || "").trim().length,
      reasoningChars: result.reasoningChars || 0,
      errorCount: Array.isArray(result.errors) ? result.errors.length : 0,
      timedOut: Boolean(result.timedOut),
      durationMs: result.durationMs || 0,
    },
    review: {
      userExperience: status === "ok" ? "answer-visible-and-contract-held" : "needs-react-fix",
      nextAction,
    },
  };
}


function isMetaToolOrSearchQuestion(prompt) {
  const p = String(prompt || "");
  return /(为什么|如何|怎么|原因|解释|原则|流程|设计|检查清单|门禁|复核|冲突|矩阵|回归|测试|信息架构|草案|工作台)/.test(p)
    && /(工具|搜索|检索|复核|模型|空答|门禁|流程|结论|结果|内核|矩阵|CLI|GUI|工作台|信息架构)/.test(p);
}

function isStaleWorldCupAnswer(prompt, text, result) {
  const hasHonestNoMatchBoundary = /ESPN\s+scoreboard/i.test(text)
    && /不等于赛事数量为\s*0|不能从这条直接数据源确认.{0,24}(?:赛程|对阵|比赛数量)/.test(text);
  if (/(今晚|今夜|赛程|有几场)/.test(prompt) && hasHonestNoMatchBoundary) return false;
  const hasConcreteUpcomingSchedule = /(?:\d+)\s*场/.test(text)
    && /(?:vs|对阵|西班牙|沙特|比利时|伊朗|乌拉圭|佛得角|新西兰|埃及|Spain|Saudi|Belgium|Iran|Uruguay|Cape Verde|New Zealand|Egypt)/i.test(text)
    && /(?:未开始|Scheduled|北京时间|\b0?[0369]:00\b|00:00|03:00|06:00|09:00)/i.test(text);
  if (/(今晚|今夜|赛程|有几场)/.test(prompt) && hasConcreteUpcomingSchedule) return false;
  if (containsPastDateFutureStartContradiction(text, CURRENT_DATE)) return true;
  if (!/2022年卡塔尔世界杯/.test(text)) return false;
  const asksCurrentWorldCup = /2026|今年|本届|今晚|今夜|今天|今日|昨晚|昨天|赛程|比分|赛果|结果|几场|半决赛|世界杯/.test(prompt);
  const givesCurrentWorldCupAnswer = /2026|美加墨|本届|今年|北京时间|赛程|比分|小组赛|半决赛/.test(text);
  return asksCurrentWorldCup && !givesCurrentWorldCupAnswer;
}

function hasWrongWorldCupSemifinalDate(text) {
  const normalized = String(text || "").replace(/\s+/g, "");
  return /7月(?:10|11|12)日?|(?:2026[-/])?0?7[-/]?(?:10|11|12)\b|July(?:10|11|12)\b/i.test(normalized);
}

function hasSupportedWorldCupSemifinalDate(text) {
  const normalized = String(text || "").replace(/\s+/g, "");
  return /7月(?:14|15|16)日?|(?:2026[-/])?0?7[-/]?(?:14|15|16)\b|July(?:14|15)\b/i.test(normalized);
}

function hasSplicedWorldCupScoreEvidence(text) {
  const normalized = String(text || "").replace(/\s+/g, "");
  const hasUsBosniaScore = /美国\s*(?:1|一)\s*[-–—:：比]\s*(?:1|一)\s*波黑/.test(normalized);
  const givesCanadaCreditForThatResult = /加拿大.{0,24}(?:世界杯历史第?1个积分|首个积分|拿到1[-–—:：比]1平局|首战波黑拿到1[-–—:：比]1)/.test(normalized);
  return hasUsBosniaScore && givesCanadaCreditForThatResult;
}

function hasGoldPrice(text) {
  return /\d{3,5}(?:\.\d+)?\s*元\/克|\d{3,5}(?:\.\d+)?\s*美元\/盎司|XAU\/USD[\s\S]{0,100}\d{3,5}(?:\.\d+)?/iu.test(String(text || ""));
}

function hasJpyCnyRate(text) {
  const raw = String(text || "");
  const oneJpy = /1\s*(?:JPY|日元)[\s\S]{0,24}0\.0\d+\s*(?:CNY|人民币)?/iu;
  const hundredJpy = /100\s*(?:JPY|日元)[\s\S]{0,28}[3-9](?:\.\d+)?\s*(?:CNY|人民币)?/iu;
  const contextual = /日元[兑对]人民币[\s\S]{0,140}(?:1\s*日元[\s\S]{0,24}0\.0\d+|100\s*日元[\s\S]{0,28}[3-9](?:\.\d+)?)/iu;
  const wrongHundredUnit = /100\s*(?:JPY|日元)\s*(?:=|≈|约|可兑换|兑换|兑|约合)?\s*0\.0\d+\s*(?:CNY|人民币)?/iu;
  return (oneJpy.test(raw) || hundredJpy.test(raw) || contextual.test(raw)) && !wrongHundredUnit.test(raw);
}

function hasIndexPointOrHonestMiss(text) {
  const raw = String(text || "");
  const pointNumber = String.raw`(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{4,6}(?:\.\d+)?)`;
  return new RegExp(String.raw`(纳斯达克指数|纳指|Nasdaq|NASDAQ)[\s\S]{0,120}${pointNumber}\s*点?`, "iu").test(raw)
    || /(没有拿到|未拿到|未检索到|没有检索到|无法确认)[\s\S]{0,80}(纳斯达克指数|纳指|点位)/iu.test(raw);
}

function hasValidZodSchemaAnswer(text) {
  const raw = String(text || "");
  const hasZObject = /\bz\.object\s*\(/.test(raw);
  const hasImport = /from\s+(['"])zod\1/.test(raw) || /require\s*\(\s*(['"])zod\1\s*\)/.test(raw);
  return hasZObject && hasImport;
}

function hasCryptoPrice(text) {
  const raw = String(text || "");
  const price = String.raw`(?:\$\s*)?(?:\d{1,3}(?:,\d{3})+|\d{4,})(?:\.\d+)?\s*(?:美元|USD|USDT|CNY|人民币|元)?`;
  return new RegExp(
    String.raw`(?:比特币|Bitcoin|BTC)[\s\S]{0,160}${price}|${price}\s*(?:美元|USD|USDT)?[\s\S]{0,80}(?:比特币|Bitcoin|BTC)`,
    "iu",
  ).test(raw);
}

function isWorldCupPredictionPrompt(prompt) {
  return /世界杯/.test(String(prompt || "")) && /预测|预估|猜|可能比分|比分预测/.test(String(prompt || ""));
}

function hasWorldCupPredictionAnswer(text) {
  const raw = String(text || "");
  const hasPredictionCue = /预测|猜测|不是事实|不代表实际|仅供参考|娱乐|不构成投注/i.test(raw);
  const hasScore = /\b\d{1,2}\s*[-–—:：比]\s*\d{1,2}\b|预测比分\s*\d{1,2}\s*[-–—:：比]\s*\d{1,2}/.test(raw);
  const honestNoFixtureBoundary = /(?:未返回|未拿到|没有拿到|无法确认).{0,60}(?:对阵|赛程)/.test(raw)
    && (/(?:不能|无法|不应|不要).{0,40}(?:编|预测|给出).{0,20}(?:比分|具体比分)/.test(raw)
      || /(?:编|预测|给出).{0,20}(?:比分|具体比分).{0,20}(?:没有依据|无依据|不可靠)/.test(raw));
  return hasPredictionCue && (hasScore || honestNoFixtureBoundary);
}

function hasPreviousYearLeakForRelativePrompt(prompt, text) {
  if (!/(今天|今日|今晚|今夜|明天|明日|昨晚|昨日|昨天)/.test(String(prompt || ""))) return false;
  const previousYear = CURRENT_YEAR - 1;
  const raw = String(text || "");
  if (new RegExp(`${previousYear}\\s*[-~—–]\\s*${CURRENT_YEAR}`).test(raw)) return false;
  return new RegExp(`${previousYear}年\\s*\\d{1,2}月\\s*\\d{1,2}日`).test(raw)
    || new RegExp(`${previousYear}-\\d{1,2}-\\d{1,2}`).test(raw);
}

function hasSyntheticOfficialModelLeak(prompt, text) {
  const p = String(prompt || "");
  const raw = String(text || "").replace(/[\u2010-\u2015\u2212]/g, "-");
  if (/(?:OpenAI|ChatGPT|GPT).{0,24}(?:最新|最近|新模型|官方|发布|model|release)/i.test(p)) {
    const hasOpenAIOfficialSource = /(?:https?:\/\/)?(?:platform\.openai\.com|openai\.com|help\.openai\.com)|Model Release Notes|OpenAI API models docs|官方页面正文抓取/i.test(raw);
    return /\bGPT\s*-?\s*5\.(?:3|4)\b/i.test(raw)
      || (/\bGPT\s*-?\s*5\.5\b/i.test(raw) && !hasOpenAIOfficialSource);
  }
  if (/(?:Claude|Anthropic).{0,24}(?:最新|最近|公开|模型|官方|发布|model|release)/i.test(p)) {
    return /Claude\s+Fable\s+5|Fable\s+5|Mythos\s+5|神话级|Mythos\s*级/i.test(raw);
  }
  return false;
}

function isDgxSparkPrompt(prompt) {
  return /DGX\s*Spark/i.test(String(prompt || ""));
}

function hasDgxSparkOfficialSignal(text) {
  const raw = String(text || "");
  return /DGX\s*Spark/i.test(raw)
    && (
      /docs\.nvidia\.com|marketplace\.nvidia\.com|nvidia\.com/i.test(raw)
      || /DGX\s*OS\s*\d|580\.159\.03|CUDA\s*Toolkit\s*13|June\s+2026|2026\s*年\s*6\s*月/i.test(raw)
    );
}

function hasDgxSparkPseudoEvidence(text) {
  return /(丽台|信弘|ZENTEK|广州力铭|万集光电|电子发烧友|装机|历史沿革|培训|Omniverse Enterprise|GPU资源分配)/i.test(String(text || ""));
}

function hasInternalToolLabelVisible(text) {
  const raw = String(text || "");
  return /数据来源\/判断依据/.test(raw)
    || /(?:^|\n)\s*-\s*工具：\s*(?:research_prefetch|stock_market|weather|sports_score|live_news|web_search|web_fetch|browser)\b/i.test(raw)
    || /工具：(?:research_prefetch|stock_market|weather|sports_score|live_news|web_search|web_fetch)/.test(raw);
}

function hasSportsContextCrosswire(prompt, text) {
  if (!/世界杯|World\s*Cup|FIFA/i.test(String(prompt || ""))) return false;
  return /总决赛已打场次|NBA\s*总决赛|马刺|尼克斯/i.test(String(text || ""));
}

function allowsFileCreation(prompt) {
  return /(?:保存|写入|创建|生成|导出).{0,16}(?:文件|文档|md|markdown|docx|pdf|xlsx|表格|到书桌|到桌面)|(?:形成|输出).{0,16}(?:文件|文档|docx|pdf|xlsx)/iu.test(String(prompt || ""));
}

function usedUnrequestedFileCreation(prompt, result = {}) {
  if (allowsFileCreation(prompt)) return false;
  const toolNames = Array.isArray(result.toolNames) ? result.toolNames.map(String) : [];
  return toolNames.some((name) => /^(?:write|present_files|edit|edit-diff|create_report|create_docx|create_xlsx)$/i.test(name));
}

function qualityReason(prompt, text, result = {}) {
  if (/针对“[^”]+”，我能从工具证据中确认/.test(String(text || ""))) {
    return "tool-evidence-template-leaked";
  }
  if (hasInternalToolLabelVisible(text)) {
    return "internal-tool-label-visible";
  }
  if (usedUnrequestedFileCreation(prompt, result)) {
    return "unrequested-file-creation-tool-used";
  }
  const sharedQualityIssue = additionalDialogueQualityReason({
    category: result.category,
    prompt,
    text,
    hasToolEvidence: hasToolEvidence(result),
  });
  if (sharedQualityIssue) return sharedQualityIssue;
  if (hasSportsContextCrosswire(prompt, text)) {
    return "sports-answer-crosswired-competition-context";
  }
  if (/file\s+HANDOFF-\d{4}-\d{2}-\d{2}/.test(String(text || ""))) {
    return "conceptual-question-used-local-file-list";
  }
  if (/CUDA\s*Toolkit\s*13/i.test(prompt) && !/CUDA\s*Toolkit\s*13\.3|13\.3/i.test(text)) {
    return "cuda-toolkit-13-question-without-version";
  }
  if (/Python\s*3\.13/i.test(prompt) && !/3\.13\.14|Python\s*3\.13\.14/i.test(text)) {
    return "python-313-question-without-maintenance-version";
  }
  if (/Kimi\s*K2\.7\s*Code/i.test(prompt) && !/(没有|未|暂无|不能确认|未确认).{0,40}(Kimi\s*K2\.7\s*Code|K2\.7)/i.test(text)) {
    return "kimi-k27-question-claimed-release-without-proof";
  }
  if (/GLM\s*5\.0\s*Turbo/i.test(prompt) && !/(没有|未|暂无|不能确认|未确认).{0,60}(GLM\s*5\.0\s*Turbo|当前可用性|可用)/i.test(text)) {
    return "glm-50-turbo-question-claimed-availability-without-proof";
  }
  if (/Anthropic\s+docs?.{0,24}Claude\s+Code|Claude\s+Code.{0,24}Anthropic\s+docs?/i.test(prompt)
    && (!/Claude\s+Code/i.test(text) || /未查到|未提到|没有(?:明确)?提到|没有找到|未找到/i.test(text))) {
    return "anthropic-claude-code-docs-answer-missed-official-page";
  }
  if (/Microsoft\s+Windows\s+on\s+Arm|Windows\s+on\s+Arm/i.test(prompt)
    && !/(developer\.microsoft\.com\/windows\/arm|Windows\s+on\s+Arm\s+开发者页面|Arm\s+设备上构建、测试和优化\s+Windows\s+应用)/i.test(text)) {
    return "windows-on-arm-answer-without-official-developer-page";
  }
  if (/Responses\s*API/i.test(prompt) && /根据本轮已执行工具返回|网页抓取|抓取出错|Skip to content/i.test(text)) {
    return "responses-api-answer-leaked-fetch-noise";
  }
  if (containsMislabeledRelativeDate(prompt, omitVerifiedSportsFetchWindows(text, result.toolEvents), CURRENT_DATE)) {
    return "relative-date-answer-used-wrong-explicit-date";
  }
  if (hasPreviousYearLeakForRelativePrompt(prompt, text)) {
    return "relative-date-answer-used-previous-year";
  }
  if (hasSyntheticOfficialModelLeak(prompt, text)) {
    return "official-model-question-used-synthetic-model-name";
  }
  if (isDgxSparkPrompt(prompt)) {
    if (!hasDgxSparkOfficialSignal(text)) return "dgx-spark-question-without-official-product-evidence";
    if (hasDgxSparkPseudoEvidence(text)) return "dgx-spark-answer-used-pseudo-related-search-result";
  }
  if (/(?:深圳|北京|天气|暴雨|空气质量|今天|明天|昨晚|今晚)/.test(prompt)) {
    if (new RegExp(`${CURRENT_YEAR - 1}年`).test(text) && !new RegExp(`${CURRENT_YEAR - 1}\\s*[-~—–]\\s*${CURRENT_YEAR}`).test(text)) {
      return "relative-date-answer-used-previous-year";
    }
  }
  if (weatherAnswerUsesUnrelatedSearch(prompt, text)) return "weather-answer-used-unrelated-search-result";
  if (/(金价|黄金|XAU|gold)/i.test(prompt) && !hasGoldPrice(text)) {
    return "gold-question-without-price";
  }
  if (/(汇率|美元人民币|美元兑人民币|USD\s*\/?\s*CNY)/i.test(prompt) && !hasUsdCnyRate(text)) {
    return "fx-question-without-rate";
  }
  if (/(日元|JPY).{0,12}(人民币|CNY)|(人民币|CNY).{0,12}(日元|JPY)/i.test(prompt) && !hasJpyCnyRate(text)) {
    return "jpy-cny-question-without-correct-unit";
  }
  if (/(纳斯达克指数|纳指).{0,12}(点位|多少|最新)/i.test(prompt)) {
    if (/AAPL|苹果公司|Apple\b/i.test(text)) return "index-question-leaked-default-stock-quote";
    if (!hasIndexPointOrHonestMiss(text)) return "index-question-without-index-point";
  }
  if (/(比特币|Bitcoin|BTC).{0,16}(价格|多少|现在|大概|最新)/i.test(prompt) && !hasCryptoPrice(text)) {
    return "crypto-question-without-price";
  }
  if (/zod\s+schema|schema\s+校验|校验\s+release\s+manifest/i.test(prompt) && !hasValidZodSchemaAnswer(text)) {
    return "zod-schema-answer-has-invalid-or-missing-import";
  }
  if (!isMetaToolOrSearchQuestion(prompt) && claimsFreshToolEvidence(text) && !hasToolEvidence(result)) {
    return "claims-fresh-tool-evidence-without-tool-event";
  }
  if (hasToolEvidence(result) && deniesAvailableToolCapability(text)) {
    return "denies-available-tool-after-tool-event";
  }
  if (/世界杯/.test(prompt)) {
    if (isWorldCupPredictionPrompt(prompt)) {
      if (!hasWorldCupPredictionAnswer(text) && !hasVerifiedNoFixturePredictionAnswer({ ...result, currentDate: CURRENT_DATE })) return "world-cup-prediction-without-score-or-disclaimer";
      return "";
    }
    if (isStaleWorldCupAnswer(prompt, text, result)) {
      return "world-cup-stale-or-not-started-answer";
    }
    if (overridesVerifiedEmptySportsWindow({ ...result, currentDate: CURRENT_DATE })) {
      return "sports-answer-overrode-verified-empty-window";
    }
    const scorePattern = /\d+\s*[\u00a0\u202f ]*(?:[-–—:：比])[\u00a0\u202f ]*\d+/;
    if (/已经出的赛事比分|最新的比赛结果|上一场比分/.test(prompt) && !scorePattern.test(text)
      && !hasVerifiedEmptySportsResult({ ...result, currentDate: CURRENT_DATE })) {
      return "world-cup-score-question-without-score";
    }
    if (/今晚|今天|赛程|有几场/.test(prompt) && !/(?:\d+)\s*场|北京时间|赛程/.test(text)) {
      return "world-cup-schedule-question-without-schedule";
    }
    if (/半决赛/.test(prompt) && hasWrongWorldCupSemifinalDate(text)) {
      return "world-cup-semifinal-wrong-date";
    }
    if (
      /半决赛/.test(prompt)
      && /四分之一决赛|1\/4\s*决赛|quarter\s*-?\s*final/i.test(text)
      && !/四分之一决赛的?胜者|四分之一决赛第\s*\d+\s*场的?胜者|四分之一决赛结束后|1\/4\s*决赛的?胜者|1\/4\s*决赛第\s*\d+\s*场的?胜者|quarter\s*-?\s*final\s+\d+\s+(?:winner|胜者)|quarter\s*-?\s*final\s+winner/i.test(text)
    ) {
      return "world-cup-semifinal-answer-called-quarterfinal";
    }
    if (/半决赛/.test(prompt) && !hasSupportedWorldCupSemifinalDate(text) && !/semi/i.test(text)) {
      return "world-cup-semifinal-question-without-date";
    }
    if (/2026世界杯已经出的赛事比分|最新的比赛结果/.test(prompt) && hasSplicedWorldCupScoreEvidence(text)) {
      return "world-cup-spliced-score-evidence";
    }
  }
  return "";
}

function cliInvocation(cliPath) {
  const looksLikeNodeEntry =
    cliPath.endsWith(".mjs") ||
    cliPath.endsWith(".js") ||
    cliPath.startsWith(".") ||
    cliPath.startsWith("/");
  if (looksLikeNodeEntry) return { command: process.execPath, args: [cliPath] };
  return { command: cliPath, args: [] };
}

function runOne(runIndex, index, category, prompt, repeatRound) {
  return new Promise((resolveOne) => {
    const startedAt = Date.now();
    const invocation = cliInvocation(args.cli);
    const cliArgs = [...invocation.args, "-p", prompt, "--json", "--no-ink", "--no-save-session"];
    const childEnv = {
      ...process.env,
      FORCE_COLOR: "0",
      LYNN_GATE_CURRENT_DATE: CURRENT_DATE,
      LYNN_CURRENT_DATE: CURRENT_DATE,
    };
    if (args.mode === "brain") {
      cliArgs.push("--data-dir", args.dataDir);
      childEnv.LYNN_CLI_DISABLE_BYOK_FALLBACK = "1";
      for (const key of [
        "LYNN_CLI_PRESET",
        "OPENAI_COMPATIBLE_PRESET",
        "LYNN_CLI_BASE_URL",
        "OPENAI_BASE_URL",
        "LYNN_CLI_MODEL",
        "LYNN_CLI_API_KEY",
        "LYNN_CLI_PROVIDER",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "DEEPSEEK_API_KEY",
        "ZHIPUAI_API_KEY",
        "DASHSCOPE_API_KEY",
      ]) {
        delete childEnv[key];
      }
    }
    const child = spawn(invocation.command, cliArgs, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv,
    });
    const result = {
      index,
      runIndex,
      repeatRound,
      category,
      prompt,
      exitCode: null,
      durationMs: 0,
      providerTrail: [],
      toolNames: [],
      assistantText: "",
      reasoningChars: 0,
      usage: null,
      errors: [],
      toolEvents: [],
      rawTail: "",
      timedOut: false,
      timeoutKind: null,
    };
    let stdoutTail = "";
    let stderr = "";
    const deadline = createCliTurnDeadline({
      firstChunkMs: args.firstChunkTimeoutMs,
      idleMs: args.idleTimeoutMs,
      totalMs: args.timeoutMs,
      onTimeout(kind) {
        result.timedOut = true;
        result.timeoutKind = kind;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1500).unref();
      },
    });
    child.stdout.on("data", (buf) => {
      stdoutTail += buf.toString("utf8");
      const lines = stdoutTail.split(/\r?\n/);
      stdoutTail = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        result.rawTail = `${result.rawTail}\n${line}`.slice(-4000);
        try {
          const event = JSON.parse(line);
          if (isCliTurnActivity(event)) deadline.activity();
          if (event.type === "provider" && event.activeProvider) result.providerTrail.push(event.activeProvider);
          if (event.type === "tool.start") {
            const name = event.name || event.tool || "tool";
            result.toolNames.push(name);
            result.toolEvents.push({ event: "start", name });
          }
          if (event.type === "tool_progress") {
            const name = event.name || event.tool || "tool";
            result.toolEvents.push({ event: event.event || "", name, ok: event.ok ?? null, summary: event.summary, details: event.details, argsSummary: event.argsSummary });
            if ((event.event === "start" || event.event === "end") && !result.toolNames.includes(name)) {
              result.toolNames.push(name);
            }
          }
          if (event.type === "assistant.delta") result.assistantText += event.text || "";
          if (event.type === "reasoning.delta") result.reasoningChars += String(event.text || "").length;
          if (event.type === "usage") result.usage = event.usage || null;
          if (event.type === "error") result.errors.push(event.message || JSON.stringify(event));
        } catch {
          result.errors.push(`non-json: ${line.slice(0, 240)}`);
        }
      }
    });
    child.stderr.on("data", (buf) => {
      stderr += buf.toString("utf8");
    });
    child.on("close", (code) => {
      deadline.stop();
      result.exitCode = code;
      result.durationMs = Date.now() - startedAt;
      if (stderr.trim()) result.errors.push(stderr.trim().slice(-1000));
      Object.assign(result, classify(result));
      result.reactReview = buildReactReview(result);
      resolveOne(result);
    });
  });
}

const results = [];
const selected = selectedPromptItems(args);
for (const item of selected) {
  const { index, runIndex, repeatRound, category, prompt } = item;
  console.log(`[${runIndex}/${selected.length}] #${index} r${repeatRound} ${category}: ${prompt}`);
  const result = await runOne(runIndex, index, category, prompt, repeatRound);
  results.push(result);
  console.log(`  -> ${result.status} ${result.durationMs}ms provider=${result.providerTrail.join(">") || "-"} tools=${result.toolNames.join(",") || "-"} text=${result.assistantText.trim().slice(0, 80).replace(/\s+/g, " ")}`);
  writeFileSync(outPath, JSON.stringify({ outPath, generatedAt: new Date().toISOString(), results }, null, 2));
}

const counts = results.reduce((acc, item) => {
  acc[item.status] = (acc[item.status] || 0) + 1;
  return acc;
}, {});
const providerCounts = results.reduce((acc, item) => {
  const last = item.providerTrail.at(-1) || "unknown";
  acc[last] = (acc[last] || 0) + 1;
  return acc;
}, {});
const toolRuns = results.filter((item) => item.toolNames.length).length;
const stepExecuteRuns = results.filter((item) => item.toolNames.includes("step_execute")).length;
const avgMs = Math.round(results.reduce((sum, item) => sum + item.durationMs, 0) / Math.max(1, results.length));
const summary = { outPath, mode: args.mode, dataDir: args.mode === "brain" ? args.dataDir : "", gateCurrentDate: CURRENT_DATE, timeouts: { firstChunkMs: args.firstChunkTimeoutMs, idleMs: args.idleTimeoutMs, totalMs: args.timeoutMs }, prompts: selected.length / args.repeat, repeat: args.repeat, total: results.length, counts, providerCounts, toolRuns, stepExecuteRuns, avgMs };

writeFileSync(outPath, JSON.stringify({ ...summary, generatedAt: new Date().toISOString(), results }, null, 2));
console.log(`SUMMARY ${JSON.stringify(summary)}`);
if (Object.entries(counts).some(([status]) => status !== "ok")) process.exit(1);
