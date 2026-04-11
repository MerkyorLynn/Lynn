import { AppError } from "../../shared/errors.js";
import { errorBus } from "../../shared/error-bus.js";
import {
  getBrainDisplayName,
  isBrainModelRef,
} from "../../shared/brain-provider.js";
import {
  getDefaultRouteRecoveryNoticeKey,
  getDefaultRouteSlowNoticeKey,
} from "../../shared/task-route-intent.js";
import { t } from "../i18n.js";

export function resolveCurrentModelInfo(engine) {
  const model = engine.resolveModelOverrides?.(engine.currentModel) || engine.currentModel || null;
  return {
    model,
    provider: model?.provider || null,
    modelId: model?.id || null,
    modelName: model?.name || model?.id || null,
    api: model?.api || null,
    isBrain: isBrainModelRef(model?.id, model?.provider),
  };
}

export function shouldExposeModelRouting() {
  if (typeof process === "undefined" || !process?.env) return false;
  return process.env.LYNN_DEBUG_MODELS === "1" || process.env.DEBUG_MODEL_ROUTING === "1";
}

export function buildEmptyResponseUserMessage(engine) {
  const info = resolveCurrentModelInfo(engine);
  if (info.isBrain) {
    return t("error.defaultModelNoResponse", { model: getBrainDisplayName() });
  }
  return t("error.modelNoResponse", {
    model: info.modelName || info.modelId || info.provider || t("model.unknown"),
  });
}

export function reportEmptyResponse(engine, sessionPath) {
  const info = resolveCurrentModelInfo(engine);
  const exposeRouting = shouldExposeModelRouting();
  errorBus.report(new AppError("LLM_EMPTY_RESPONSE", {
    message: "Model returned no displayable content",
    context: {
      sessionPath,
      isBrain: info.isBrain,
      ...(exposeRouting ? {
        provider: info.provider,
        modelId: info.modelId,
        modelName: info.modelName,
        api: info.api,
      } : {}),
    },
  }), {
    dedupeKey: info.isBrain
      ? "LLM_EMPTY_RESPONSE:brain"
      : `LLM_EMPTY_RESPONSE:${info.provider || "unknown"}:${info.modelId || "unknown"}`,
  });
}

export function buildSlowNoticePayload(engine, sessionPath, routeIntent, elapsedMs) {
  const info = resolveCurrentModelInfo(engine);
  if (info.isBrain) {
    const noticeKey = getDefaultRouteSlowNoticeKey(routeIntent, elapsedMs);
    if (elapsedMs < 60_000) {
      return {
        type: "status",
        isStreaming: true,
        sessionPath,
        noticeKey,
      };
    }
    return {
      type: "status",
      isStreaming: true,
      sessionPath,
      noticeKey,
      noticeVars: {
        minutes: Math.max(1, Math.round(elapsedMs / 60_000)),
      },
    };
  }
  if (elapsedMs < 60_000) {
    return {
      type: "status",
      isStreaming: true,
      sessionPath,
      noticeKey: "status.llmSlowResponse",
    };
  }
  return {
    type: "status",
    isStreaming: true,
    sessionPath,
    noticeKey: "status.llmStillWorking",
    noticeVars: {
      minutes: Math.max(1, Math.round(elapsedMs / 60_000)),
    },
  };
}

export function buildPseudoToolRecoveryNotice(engine, sessionPath, routeIntent) {
  const info = resolveCurrentModelInfo(engine);
  return {
    type: "status",
    isStreaming: true,
    sessionPath,
    noticeKey: info.isBrain
      ? getDefaultRouteRecoveryNoticeKey(routeIntent)
      : "status.recoveringToolExecution",
  };
}

export function buildPseudoToolRecoverySteerText() {
  return [
    "你刚才在正文里输出了伪工具调用标记（如 <tool_call>、<invoke>、XML 标签、web_search(...) 这种函数调用样式），这不会真正执行工具。",
    "不要再输出 Premise / Conduct / Reflection / Act、'我来查询'、'让我搜索' 这类计划文本。",
    "立即停止输出任何伪工具调用文本，改为使用真实工具接口继续完成当前任务；只有拿到工具结果后再向用户汇报。",
    "Do not simulate tool calls in plain text. Stop outputting pseudo tool-call markup or function-call-style tool text and use the real tool interface now. Continue the current task and only reply after real tool results arrive.",
  ].join("\n");
}

export function buildPseudoToolRetryPrompt(promptText) {
  return [
    "【严格执行要求】上一轮把工具调用写成了正文文本，没有真正执行工具。",
    "这一次不要输出任何 <tool_call>、XML、shell、web_search(...) 一类的伪工具文本，也不要先输出 Premise / Conduct / Reflection / Act 或“我来查询”“让我搜索”这种计划句。",
    "请直接调用真实工具完成当前任务，拿到工具结果后再回复用户。",
    String(promptText || ""),
  ].filter(Boolean).join("\n\n");
}

export function looksLikeManualShellDeflection(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return false;
  return [
    /没有(?:直接)?执行\s*shell(?:\s*命令)?的工具/i,
    /没有\s*(?:shell|bash|命令)(?:\s*\/\s*命令)?工具/i,
    /无法直接帮你安装/i,
    /需要你在终端手动(?:运行|执行)/i,
    /我(?:这边)?没有直接执行\s*shell/i,
    /I (?:do not|don't) have (?:a )?(?:shell|bash|command) tool/i,
    /cannot (?:directly )?(?:run|execute) shell/i,
    /you need to run (?:it )?manually in (?:the )?terminal/i,
    /Please install uv ?\/ ?uvx first/i,
  ].some((re) => re.test(normalized));
}

export function buildInstallRecoverySteerText() {
  return [
    "你刚才错误地声称自己没有 shell/命令工具，或者让用户手动去终端执行安装命令。",
    "当前会话处于执行模式，你确实可以使用真实 bash 工具。",
    "对于 brew install、npm install、pip install、uv、curl | sh 这类安装请求，必须直接调用真实 bash 工具；不要再输出手动安装教程。",
    "安装或远程脚本会自动弹出确认卡。先执行真实命令，再根据执行结果继续完成任务。",
    "You do have access to the real bash tool in this session. For installation requests, call the real bash tool instead of telling the user to copy commands manually.",
  ].join("\n");
}

export function buildInstallRetryPrompt(promptText) {
  return [
    "【严格执行要求】上一轮错误地说自己没有 shell/命令工具，或者把安装步骤写成了手动教程。",
    "这一次不要再输出任何“请在终端手动运行”的说明。请直接调用真实 bash 工具执行安装，并根据命令结果继续回答。",
    String(promptText || ""),
  ].filter(Boolean).join("\n\n");
}

export function buildInvalidToolSimulationUserMessage(engine) {
  const info = resolveCurrentModelInfo(engine);
  if (info.isBrain) return t("error.defaultModelInvalidToolSimulation");
  return t("error.invalidToolSimulation");
}

export const MAX_PSEUDO_TOOL_MARKERS_WITHOUT_REAL_TOOL = 3;
export const MAX_PSEUDO_TOOL_RECOVERY_ATTEMPTS = 1;
