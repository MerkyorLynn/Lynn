/**
 * delegate-tool.js — Sub-agent 委派工具
 *
 * 将独立子任务委派给隔离的 agent session 执行。
 * 子任务在独立上下文中运行，只返回最终结果，
 * 不占用主对话的上下文窗口。
 *
 * 底层复用 executeIsolated，并行由 PI SDK 的
 * 多 tool_call 机制自然支持。
 */

import { Type } from "@sinclair/typebox";
import { t, getLocale } from "../../server/i18n.js";

/** sub-agent 可用的 custom tools（只读/研究类） */
const DELEGATE_CUSTOM_TOOLS_READONLY = [
  "search_memory", "recall_experience",
  "web_search", "web_fetch",
];

/** sub-agent 可用的 custom tools（含写入能力） */
const DELEGATE_CUSTOM_TOOLS_WRITE = [
  ...DELEGATE_CUSTOM_TOOLS_READONLY,
  "present_files",
];

const DEFAULT_DELEGATE_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟（从 5 分钟提升）

/** 注入到子任务 prompt 前的前导指令 */
function getDelegatePreamble() {
  const isZh = getLocale().startsWith("zh");
  if (isZh) {
    return "你现在是一个调研子任务。要求：\n" +
      "- 不需要 MOOD 区块\n" +
      "- 不需要寒暄，直接给结论\n" +
      "- 输出简洁、结构化，附上关键证据和来源\n" +
      "- 如果信息不足，明确说明缺什么\n\n" +
      "任务：\n";
  }
  return "You are a research sub-task. Requirements:\n" +
    "- No MOOD block\n" +
    "- No pleasantries — go straight to conclusions\n" +
    "- Output should be concise, structured, with key evidence and sources\n" +
    "- If information is insufficient, state clearly what is missing\n\n" +
    "Task:\n";
}

let activeCount = 0;
const MAX_CONCURRENT = 5;

/**
 * 创建 delegate 工具
 * @param {object} deps
 * @param {(prompt: string, opts: object) => Promise} deps.executeIsolated
 * @param {() => string|null} deps.resolveUtilityModel
 * @param {string[]} deps.readOnlyBuiltinTools
 * @returns {import('@mariozechner/pi-coding-agent').ToolDefinition}
 */
export function createDelegateTool(deps) {
  return {
    name: "delegate",
    label: t("toolDef.delegate.label"),
    description: t("toolDef.delegate.description"),
    parameters: Type.Object({
      task: Type.String({ description: t("toolDef.delegate.taskDesc") }),
      model: Type.Optional(Type.String({ description: t("toolDef.delegate.modelDesc") })),
      allowWrite: Type.Optional(Type.Boolean({ description: "Allow the sub-agent to write/edit files (default: false, read-only)" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default: 600)" })),
      dryRun: Type.Optional(Type.Boolean({ description: "Run writes in a temporary shadow workspace and return validation info." })),
    }),

    execute: async (_toolCallId, params, signal) => {
      if (activeCount >= MAX_CONCURRENT) {
        return {
          content: [{ type: "text", text: t("error.delegateMaxConcurrent", { max: MAX_CONCURRENT }) }],
        };
      }

      const timeoutMs = (params.timeout && params.timeout > 0)
        ? Math.min(params.timeout * 1000, 30 * 60 * 1000) // 最大 30 分钟
        : DEFAULT_DELEGATE_TIMEOUT_MS;

      // 合并外部 signal 和超时 signal
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const combinedSignal = signal
        ? AbortSignal.any([signal, timeoutSignal])
        : timeoutSignal;

      const customTools = params.allowWrite
        ? DELEGATE_CUSTOM_TOOLS_WRITE
        : DELEGATE_CUSTOM_TOOLS_READONLY;

      // allowWrite 时不限制 builtin tools（可用 read/write/edit/bash/grep/find/ls）
      const builtinFilter = params.allowWrite ? undefined : deps.readOnlyBuiltinTools;

      activeCount++;
      try {
        const result = await deps.executeIsolated(
          getDelegatePreamble() + params.task,
          {
            model: params.model || deps.resolveUtilityModel(),
            toolFilter: customTools,
            builtinFilter,
            dryRun: params.dryRun === true,
            signal: combinedSignal,
          },
        );

        if (result.error) {
          return {
            content: [{ type: "text", text: t("error.delegateFailed", { msg: result.error }) }],
          };
        }
        return {
          content: [{ type: "text", text: result.replyText || t("error.delegateNoOutput") }],
        };
      } finally {
        activeCount--;
      }
    },
  };
}
