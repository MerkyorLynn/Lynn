import { t, getLocale } from "../server/i18n.js";
import { formatProjectInstructions } from "../lib/project-instructions.js";
import { getBrainDisplayName, isBrainModelRef } from "../shared/brain-provider.js";
import { getUserFacingModelAlias } from "../shared/assistant-role-models.js";
import {
  DEFAULT_SECURITY_MODE,
  SecurityMode,
} from "../shared/security-mode.js";
import { resolveModelContextWindow } from "./compaction-settings.js";
import {
  buildKnownFolderAliasPrompt,
  shouldInjectLocalRoutePromptHints,
} from "./session-context-hints.js";

type AnyRecord = Record<string, any>;

export function createSessionResourceLoader(opts: {
  baseResourceLoader: AnyRecord;
  sessionEntry: AnyRecord;
  effectiveModel: AnyRecord | null | undefined;
  getAgent: () => AnyRecord;
  getAgentById?: (agentId: string) => AnyRecord | null | undefined;
  getHomeCwd: () => string | null | undefined;
  getMcpPromptContext?: () => string | null | undefined;
}) {
  const {
    baseResourceLoader,
    sessionEntry,
    effectiveModel,
    getAgent,
    getAgentById,
    getHomeCwd,
    getMcpPromptContext,
  } = opts;

  return Object.create(baseResourceLoader, {
    getAppendSystemPrompt: {
      value: () => {
        const base = baseResourceLoader.getAppendSystemPrompt?.() || [];
        const extras = [...base];

        if (sessionEntry._lastRecallContext) {
          extras.push(sessionEntry._lastRecallContext);
        }
        if (sessionEntry._lastSkillHintContext) {
          extras.push(sessionEntry._lastSkillHintContext);
        }
        if (sessionEntry._atInjectionHintContext) {
          extras.push(sessionEntry._atInjectionHintContext);
        }
        if (sessionEntry._turnInstructionHintContext) {
          extras.push(sessionEntry._turnInstructionHintContext);
        }
        if (shouldInjectLocalRoutePromptHints() && sessionEntry._routeIntentHintContext) {
          extras.push(sessionEntry._routeIntentHintContext);
        }
        if (sessionEntry._scenarioContractHintContext) {
          extras.push(sessionEntry._scenarioContractHintContext);
        }
        if (sessionEntry._relaySummaryContext) {
          extras.push(sessionEntry._relaySummaryContext);
        }

        const secMode = sessionEntry.securityMode || DEFAULT_SECURITY_MODE;
        const isZh = String(getAgent().config?.locale || "").startsWith("zh");

        if (secMode === SecurityMode.PLAN) {
          const planModePrompt = isZh
            ? "【系统通知】当前处于「规划模式」，用户在设置中选择了只读规划。你只能使用只读工具（read、grep、find、ls）和自定义工具。不能执行写入、编辑、删除等操作。如果用户要求你做这些操作，请告知当前处于规划模式，需要先在输入框左下角切换到「执行模式」。"
            : "[System Notice] Currently in PLAN MODE. You can only use read-only tools (read, grep, find, ls) and custom tools. You cannot write, edit, or delete. If the user asks for these operations, inform them to switch to 'Execute Mode' via the selector at the bottom-left of the input area.";
          extras.push(planModePrompt);
        } else if (secMode === SecurityMode.SAFE) {
          const safeModePrompt = isZh
            ? "【系统通知】当前处于「安全模式」，所有危险操作（sudo、chmod 等）和受保护路径的写入都会被直接拒绝，不会弹出确认。如果用户确实需要执行这些操作，请告知先在输入框左下角切换到「执行模式」。"
            : "[System Notice] Currently in SAFE MODE. Dangerous operations (sudo, chmod, etc.) and writes to protected paths are directly rejected with no approval prompt. If the user truly needs them, ask them to switch to 'Execute Mode' via the selector at the bottom-left of the input area.";
          extras.push(safeModePrompt);
        } else {
          const executeModePrompt = isZh
            ? [
                "【系统通知】当前处于「执行模式」，你可以使用真实工具执行命令、读写文件和完成安装类操作。",
                "当用户要求你安装软件、安装依赖、执行终端命令、检查命令是否成功时，不要说自己没有 shell/命令工具，也不要让用户手动复制命令去终端运行。",
                "在这类场景下，应优先使用真实 bash 工具执行，并基于执行结果继续完成任务。",
                "如果命令涉及安装软件、提升权限、写入系统路径或执行远程安装脚本，系统会自动弹出确认卡片；你只需要正常发起真实工具调用。",
              ].join(" ")
            : [
                "[System Notice] You are currently in EXECUTE MODE and may use real tools to run commands, read/write files, and carry out installation tasks.",
                "When the user asks you to install software, install dependencies, run terminal commands, or verify whether a command succeeded, do not claim that you lack shell or command tools and do not tell the user to copy commands into a terminal manually.",
                "In these cases, prefer the real bash tool and continue the task based on the execution result.",
                "If a command installs software, elevates privileges, writes to system paths, or runs a remote install script, the system will automatically show a confirmation card; you should still initiate the real tool call normally.",
              ].join(" ");
          extras.push(executeModePrompt);
        }

        const sessionCwd = sessionEntry.session?.sessionManager?.getCwd?.() || getHomeCwd() || "";
        const preferredDeskPath = getHomeCwd() || "";
        if (preferredDeskPath) {
          const deskHint = isZh
            ? (sessionCwd && sessionCwd !== preferredDeskPath
                ? `【书桌工作区】用户提到「书桌」「当前工作区」时，默认优先指 ${preferredDeskPath}。只有用户明确说当前代码仓库、当前源码目录或当前 cwd 时，才使用 ${sessionCwd}。`
                : `【书桌工作区】用户提到「书桌」「当前工作区」时，默认就是 ${preferredDeskPath}。`)
            : (sessionCwd && sessionCwd !== preferredDeskPath
                ? `[Desk workspace] When the user says "desk" or "current workspace", prefer ${preferredDeskPath} by default. Only switch to ${sessionCwd} when they explicitly mean the current repo/cwd.`
                : `[Desk workspace] When the user says "desk" or "current workspace", it refers to ${preferredDeskPath}.`);
          extras.push(deskHint);
        }
        extras.push(buildKnownFolderAliasPrompt(isZh));
        if (sessionCwd) {
          try {
            const projectCtx = formatProjectInstructions(sessionCwd, isZh);
            if (projectCtx) extras.push(projectCtx);
          } catch { /* non-fatal */ }
        }

        try {
          const mcpCtx = getMcpPromptContext?.();
          if (mcpCtx) extras.push(mcpCtx);
        } catch { /* non-fatal */ }

        const modelCw = resolveModelContextWindow(sessionEntry.session?.model);
        const isSmallModel = modelCw && modelCw < 32_000;
        if (isSmallModel) {
          const compactPrompt = isZh
            ? "【重要】回复末尾用 <!-- KEY: 结论 --> 标注本轮关键结论，压缩时优先保留。回复控制在 500 字以内。"
            : "[IMPORTANT] End replies with <!-- KEY: conclusion --> to mark key conclusions for retention. Keep replies under 500 words.";
          extras.push(compactPrompt);
          extras.push(isZh
            ? [
                "【工具调用规则】",
                "1. 每次只调用一个工具，等结果回来再决定下一步",
                "2. 调用工具前先用一句话说清楚你要做什么",
                "3. 不要编造不存在的工具名",
                "4. 参数中的文件路径必须使用绝对路径",
                "5. 如果不确定该用哪个工具，先用 bash 执行简单命令",
                "6. 不要在正文中模拟工具调用（如写出 JSON、<tool_call>、<tool>、<toolcode>、<function=...> 这类文本但不通过工具接口发送）",
              ].join("\n")
            : [
                "[Tool Call Rules]",
                "1. Call only one tool at a time; wait for the result before deciding the next step",
                "2. Before calling a tool, briefly state what you intend to do",
                "3. Do not invent tool names that do not exist",
                "4. Always use absolute paths for file parameters",
                "5. When unsure which tool to use, try bash with a simple command first",
                "6. Do not simulate tool calls in text (for example JSON, <tool_call>, <tool>, <toolcode>, or <function=...> markup without actually invoking a tool)",
              ].join("\n")
          );
          extras.push(isZh
            ? "可用工具概览：文件操作（read/write/edit/bash）、搜索（grep/find/web_search）。先想清楚要做什么，再选工具。"
            : "Tool overview: File ops (read/write/edit/bash), Search (grep/find/web_search). Think first, then pick."
          );
          extras.push(isZh
            ? "对于用户已经明确要求的本地整理、移动、创建、读取、安装等任务，在执行模式下应继续使用真实工具完成到可验证结果，不要只列计划或停在第一步。只有路径不明确、可能删除/覆盖重要数据、需要 sudo/系统目录/远程脚本等高风险操作时，才先向用户确认。"
            : "For clearly requested local organize/move/create/read/install tasks, continue using real tools in execute mode until there is a verifiable result; do not stop after planning or the first step. Ask for confirmation first only when paths are ambiguous, important data may be deleted/overwritten, or the action needs sudo/system paths/remote scripts."
          );
        } else {
          const importancePrompt = isZh
            ? "【上下文保留策略】当对话很长时，系统会自动压缩旧消息。为确保关键信息不丢失：在输出重要决策、计划步骤、验证结论或用户明确要求记住的内容时，请用简洁的要点重申核心结论，这样即使旧消息被压缩，关键信息也会在最近的消息中保留。"
            : "[Context Retention] When conversations are long, the system auto-compacts old messages. To ensure critical info survives: when outputting important decisions, plan steps, verification conclusions, or things the user explicitly asked to remember, briefly restate the core conclusions so they remain in recent messages even after compaction.";
          extras.push(importancePrompt);
        }

        extras.push(isZh
          ? "【工具调用底线】绝不要在正文中伪造工具调用（例如输出 <tool_call>、<invoke>、<toolcode>、XML/JSON 工具参数等文本）。需要用工具时必须调用真实工具接口，而不是把工具格式打印给用户看。"
          : "[Tool Call Hard Rule] Never fake tool calls in plain text (for example <tool_call>, <invoke>, <toolcode>, or XML/JSON tool arguments). When a tool is needed, you must invoke the real tool interface instead of printing tool-call markup to the user."
        );

        const turnCount = sessionEntry.session?.turnCount ?? sessionEntry.session?.sessionManager?.getTurnCount?.() ?? 0;
        if (turnCount <= 2 && !sessionEntry._jianHintInjected) {
          sessionEntry._jianHintInjected = true;
          const jianHint = isZh
            ? "【一次性提示】如果用户提到了持续要推进的任务或计划，在回复末尾自然地加一句：「如果有持续要推进的事，可以写在右侧的笺里（⌘J 打开），我会定期去看并主动推进。」不要每次都说，只在第一次合适的时机提一次。"
            : "[One-time hint] If the user mentions ongoing tasks or plans, naturally add at the end of your reply: 'If you have ongoing tasks, you can write them in the Jian panel on the right (⌘J to toggle). I'll check periodically and work on them proactively.' Only mention this once, at an appropriate moment.";
          extras.push(jianHint);
        }

        const selectedModelId = sessionEntry.modelId || effectiveModel?.id || null;
        const selectedModelProvider = sessionEntry.modelProvider || effectiveModel?.provider || null;
        if (selectedModelId) {
          const sessionAgentRole = getAgentById?.(sessionEntry.agentId)?.config?.agent?.yuan || null;
          const publicModelAlias = getUserFacingModelAlias({
            modelId: selectedModelId,
            provider: selectedModelProvider,
            role: sessionAgentRole,
            purpose: "chat",
          });
          const selectedModelTag = selectedModelProvider
            ? `${selectedModelProvider} / ${selectedModelId}`
            : selectedModelId;
          const modelHint = (publicModelAlias || isBrainModelRef(selectedModelId, selectedModelProvider))
            ? (
                isZh
                  ? [
                      `当前用户选择的是${publicModelAlias || getBrainDisplayName()}。`,
                      `把“${publicModelAlias || getBrainDisplayName()}”当作你的用户可见身份，不要把任何具体上游厂商或型号当作自我介绍。`,
                      `当用户问“你现在是什么模型”“你用的是什么模型”“你是哪家模型”时，先回答“我是 Lynn 的${publicModelAlias || getBrainDisplayName()}”或“当前走的是 Lynn 的${publicModelAlias || getBrainDisplayName()}”。`,
                      "不要主动说出具体上游模型名、供应商名或 provider ID。",
                      "即使用户直接追问你当前是什么模型，也不要把具体上游型号当成最终答案；默认只回答角色对应的默认模型身份。",
                      "只有当用户明确是在排错，并且明确要求底层路由/技术实现细节时，才可以补充后台可能会动态路由到第三方模型。",
                    ].join(" ")
                  : [
                      `The user selected ${publicModelAlias || getBrainDisplayName()}.`,
                      `Treat "${publicModelAlias || getBrainDisplayName()}" as your user-facing identity and do not introduce yourself as a specific upstream vendor or model.`,
                      `When the user asks which model you are, answer with "${publicModelAlias || getBrainDisplayName()}" or "Lynn's default model service" first.`,
                      "Do not proactively reveal concrete upstream model names, provider names, or provider IDs.",
                      "Even when the user directly asks which model you are, do not treat the upstream routed model as the final user-facing answer.",
                      "Only mention underlying routing details when the user is explicitly debugging and explicitly asks for the backend implementation details.",
                    ].join(" ")
              )
            : (
                isZh
                  ? `当前运行模型：${selectedModelTag}。当用户要求署名、标注生成模型或询问你是什么模型时，使用这个信息。`
                  : `Current model: ${selectedModelTag}. Use this when the user asks you to sign, attribute, or identify which model generated the content.`
              );
          extras.push(modelHint);
        }

        return extras;
      },
    },
  });
}
