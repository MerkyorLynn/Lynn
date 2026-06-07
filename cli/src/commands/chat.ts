import { stdin as input, stdout as output } from "node:process";
import { getStringFlag, hasFlag, parseArgs, type ParsedArgs } from "../args.js";
import { BrainConnectionError, streamBrainChat, type BrainStreamEvent, type ChatMessage } from "../brain-client.js";
import { renderBrainModelChoices, renderProvidersInfo, resolveProvidersInfo, runProviders } from "./providers.js";
import { parseReasoningOptions, shouldRenderReasoning } from "../reasoning.js";
import { TerminalSpinner, renderCard } from "../terminal-spinner.js";
import { formatBrainErrorForHuman, renderBrainEventForHuman, renderToolDetail, renderToolDetailsList, summarizeUsage, type HumanBrainRenderState } from "../brain-render.js";
import { bold, dim, green, orange, red, supportsColor } from "../terminal-style.js";
import { renderStartupBanner } from "../startup.js";
import { renderStatusBar } from "../status-bar.js";
import { resolveCliProviderProfile } from "../provider-profile.js";
import { t } from "../i18n.js";
import { MarkdownStream } from "../markdown.js";
import { appendHistory, historyPath, loadHistory } from "../history.js";
import { completeSlash, normalizeSlashInput } from "../completion.js";
import { resolveEffectivePermissions } from "../permissions.js";
import { HistoryNavigator } from "../history.js";
import { readInteractiveLine } from "../interactive-line.js";
import { refreshCliRuntimeSystemMessage, resetCliRuntimeMessages } from "../runtime-context.js";
import { isLocalRuntimeQuestion, localeForText, renderLocalRuntimeAnswer } from "../runtime-answer.js";
import { modelDisplayName, modelLabelWithId } from "../provider-presets.js";
import { buildImagesContentParts } from "../media.js";
import { parseImagePromptCommand, summarizeImageRefs } from "../pasted-context.js";
import { buildMemoryContextFrameSync, handleMemorySlashCommand } from "../session/memory.js";
import { resolveDataDir } from "../session/store.js";
import { resolveDefaultBrainUrl } from "../brain-url.js";
import { shouldUseInkTui } from "../terminal-safety.js";
import { createDecodeSpeedTracker } from "../decode-speed.js";
import { createRuntimeMetrics, recordDecodeTps, recordUsageMetrics, renderRuntimeMetrics } from "../runtime-metrics.js";
import { compactChatMessages } from "../chat-compaction.js";
import { isLocalExitText, parseLocalReadOnlyCommand, renderLocalReadOnlyBlocked, renderLocalReadOnlyResult, runLocalReadOnlyCommand } from "../local-command.js";
import { assistantToolCallsForMessages, codeToolDefinitions, createStreamingToolCallAccumulator, parseCodeToolRequests, toolRequestsFromCollectedCalls, type CodeToolRequest } from "../code-tool-protocol.js";
import { formatDangerousToolPreview, renderClientToolResult, renderClientToolStart, resolveToolApproval } from "../code-tool-render.js";
import { CLIENT_TOOL_DEFINITIONS, runClientTool } from "../tools/registry.js";
import type { ClientToolResult } from "../tools/types.js";
import { applyChatRewind, beginChatRewindTurn, createChatRewindState, finishChatRewindTurn, maybeRecordChatRewindSnapshot, parseChatRewindCommand, renderChatRewind } from "../chat-rewind.js";

export const CHAT_SLASH_COMMANDS = [
  "/yolo",
  "/ask",
  "/model",
  "/mode",
  "/think",
  "/think high",
  "/think medium",
  "/think low",
  "/fast",
  "/tools",
  "/providers",
  "/help",
  "/exit",
  "/quit",
  "/tool",
  "/version",
  "/about",
  "/reasoning",
  "/model mimo",
  "/model stepfun",
  "/model spark",
  "/memory",
  "/memory add",
  "/memory forget",
  "/cwd",
  "/image",
  "/images",
  "/attach",
  "/setup",
  "/byok",
  "/providers set",
  "/providers unset",
  "/providers test",
  "/providers presets",
  "/byok set",
  "/byok unset",
  "/clear",
  "/rewind",
];

const CHAT_MAX_TOOL_STEPS = 20;

export function completeChatInput(line: string): [string[], string] {
  const result = completeSlash(line, CHAT_SLASH_COMMANDS);
  return [result.matches, line];
}

export async function runChat(args: ParsedArgs, options: { intro?: boolean; brainReachable?: boolean } = {}): Promise<number> {
  if (input.isTTY && output.isTTY && shouldUseInkTui(args)) {
    const { runInkChat } = await import("../ink-chat.js");
    return runInkChat(args);
  }
  const mockBrain = hasFlag(args.flags, "mock-brain", "mock");
  const brainUrl = await resolveDefaultBrainUrl(args);
  const chatCwd = getStringFlag(args.flags, "cwd") || process.cwd();
  let reasoning = parseReasoningOptions(args);
  const mode = await resolveChatMode(args);
  const approvalSession = { approveAll: false };
  let cliProvider = await resolveCliProviderProfile(args);
  const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
  let memoryFrame = buildMemoryContextFrameSync(dataDir);
  const messages: ChatMessage[] = resetCliRuntimeMessages(chatRouteLabel(cliProvider?.profile), memoryFrame);
  const rewindState = createChatRewindState();
  let pendingRewind: { phase: "list" | "preview"; ordinal: number | null } | null = null;
  const brainRenderState: HumanBrainRenderState = {};
  const runtimeMetrics = createRuntimeMetrics();
  const histFile = historyPath();
  const history = loadHistory(histFile);
  const rl = !input.isTTY
    ? (await import("node:readline/promises")).createInterface({ input, output, terminal: false })
    : null;
  if (options.intro !== false) {
    output.write(`${renderStartupBanner({
      cwd: chatCwd,
      brainUrl,
      brainStatus: "unknown",
      modeLabel: renderMode(mode),
      modelLabel: chatRouteLabel(cliProvider?.profile),
      byokLabel: cliProvider?.profile ? t("startup.byok.cliFallback") : undefined,
    })}\n\n`);
  } else if (options.brainReachable === false && !mockBrain) {
    output.write(`${renderOfflineChatHint(mode, brainUrl, cliProvider?.profile)}\n\n`);
  }
  async function handleText(raw: string): Promise<"continue" | "break"> {
    const text = normalizeSlashInput(raw.trim());
    if (!text) return "continue";
    if (isLocalExitText(text)) return "break";
    appendHistory(text, histFile);
    if (pendingRewind) {
      const selected = parsePendingRewindInput(text, pendingRewind);
      if (selected) {
        try {
          const body = selected.apply
            ? applyChatRewind(rewindState, selected.ordinal, messages, chatCwd, supportsColor(output))
            : renderChatRewind(rewindState, { ordinal: selected.ordinal, apply: false }, supportsColor(output));
          pendingRewind = selected.apply ? null : { phase: "preview", ordinal: selected.ordinal };
          output.write(`${body}\n\n`);
        } catch (error) {
          pendingRewind = null;
          output.write(`${red(error instanceof Error ? error.message : String(error), supportsColor(output))}\n\n`);
        }
        return "continue";
      }
      pendingRewind = null;
    }
    if (text === "/help") {
      output.write(`${t("chat.help")}\n\n`);
      return "continue";
    }
    if (text === "/tool") {
      output.write(`${renderToolDetailsList(brainRenderState, supportsColor(output))}\n\n`);
      return "continue";
    }
    if (text === "/tools") {
      output.write(`${renderLocalToolList(supportsColor(output))}\n\n`);
      return "continue";
    }
    const toolDetailMatch = text.match(/^\/tool\s+(\d+)$/);
    if (toolDetailMatch) {
      output.write(`${renderToolDetail(brainRenderState, Number(toolDetailMatch[1]), supportsColor(output))}\n\n`);
      return "continue";
    }
    if (isLocalRuntimeQuestion(text)) {
      output.write(`${renderLocalRuntimeAnswer({
        routeLabel: chatRouteLabel(cliProvider?.profile),
        brainUrl,
        cwd: chatCwd,
        mode: renderMode(mode),
        reasoning: reasoning.effort,
      }, localeForText(text))}\n\n`);
      return "continue";
    }
    if (text === "/fast") {
      reasoning = { ...reasoning, effort: "off" };
      output.write(`${t("chat.fast")}\n\n`);
      return "continue";
    }
    if (text === "/think") {
      reasoning = { ...reasoning, effort: "high" };
      output.write(`${t("chat.think")}\n\n`);
      return "continue";
    }
    if (text.startsWith("/think ")) {
      const result = applyThinkCommand(reasoning, text.slice(7).trim(), "chat");
      reasoning = result.reasoning;
      output.write(`${result.message}\n${t("reasoning.state", { effort: reasoning.effort, display: reasoning.display })}\n\n`);
      return "continue";
    }
    if (text === "/reasoning") {
      output.write(`${t("chat.reasoning.show", { effort: reasoning.effort, display: reasoning.display })}\n\n`);
      return "continue";
    }
    if (text.startsWith("/reasoning ")) {
      const result = applyReasoningCommand(reasoning, text.slice(11).trim());
      reasoning = result.reasoning;
      output.write(`${result.message}\n${t("reasoning.state", { effort: reasoning.effort, display: reasoning.display })}\n\n`);
      return "continue";
    }
    if (text === "/yolo" || text === "/ask") {
      const result = applyModeCommand(mode, text.slice(1));
      output.write(renderInteractiveModeChange(result, mode, supportsColor(output)));
      return "continue";
    }
    if (text === "/mode") {
      output.write(`${t("chat.mode.show", { mode: renderMode(mode) })}\n\n`);
      return "continue";
    }
    if (text.startsWith("/mode ")) {
      const result = applyModeCommand(mode, text.slice(6).trim());
      output.write(renderInteractiveModeChange(result, mode, supportsColor(output)));
      return "continue";
    }
    if (text === "/model") {
      output.write(`${renderBrainModelChoices(await resolveProvidersInfo(args))}\n\n`);
      return "continue";
    }
    const imageCommand = parseImagePromptCommand(text, chatCwd);
    if (imageCommand) {
      if (!imageCommand.imageRefs.length) {
        output.write(`${t("chat.image.usage")}\n\n`);
        return "continue";
      }
      let userContent: ChatMessage["content"];
      try {
        userContent = await buildImagesContentParts(imageCommand.imageRefs.map((ref) => ref.path), imageCommand.prompt);
      } catch (error) {
        output.write(`${t("chat.image.readError", { error: error instanceof Error ? error.message : String(error) })}\n\n`);
        return "continue";
      }
      output.write(`${t("chat.image.attached", { summary: summarizeImageRefs(imageCommand.imageRefs) })}\n\n`);
      return sendUserMessage(imageCommand.prompt, userContent);
    }
    if (text === "/providers" || text === "/byok") {
      output.write(`${renderProvidersInfo(await resolveProvidersInfo(args))}\n\n`);
      return "continue";
    }
    const providerCommand = buildChatProviderArgs(text, args);
    if (providerCommand) {
      if (shouldShowProviderSetUsage(providerCommand, input.isTTY && output.isTTY)) {
        output.write(`${t("chat.providers.setUsage")}\n\n`);
        return "continue";
      }
      const previousRoute = chatRouteLabel(cliProvider?.profile);
      try {
        const code = await runProviders(providerCommand, false);
        if (shouldRefreshProviderRoute(providerCommand)) {
          cliProvider = await resolveCliProviderProfile(providerCommand) || await resolveCliProviderProfile(args);
          const nextRoute = chatRouteLabel(cliProvider?.profile);
          refreshCliRuntimeSystemMessage(messages, nextRoute, memoryFrame);
          const changed = previousRoute !== nextRoute;
          output.write(`\n${t(changed ? "chat.providers.routeReloaded" : "chat.providers.routeUnchanged", { route: nextRoute })}\n\n`);
        } else if (code === 0) {
          output.write("\n");
        }
      } catch (error) {
        output.write(`${formatChatError(error)}\n\n`);
      }
      return "continue";
    }
    if (text.startsWith("/providers ") || text.startsWith("/byok ")) {
      output.write(`${t("chat.providers.usage")}\n\n`);
      return "continue";
    }
    if (text === "/clear") {
      messages.splice(0, messages.length, ...resetCliRuntimeMessages(chatRouteLabel(cliProvider?.profile), memoryFrame));
      rewindState.checkpoints = [];
      rewindState.active = null;
      pendingRewind = null;
      output.write(`${t("chat.cleared")}\n\n`);
      return "continue";
    }
    const rewindCommand = parseChatRewindCommand(text);
    if (rewindCommand) {
      try {
        const body = rewindCommand.apply && rewindCommand.ordinal !== null
          ? applyChatRewind(rewindState, rewindCommand.ordinal, messages, chatCwd, supportsColor(output))
          : renderChatRewind(rewindState, rewindCommand, supportsColor(output));
        pendingRewind = !rewindCommand.apply
          ? { phase: rewindCommand.ordinal === null ? "list" : "preview", ordinal: rewindCommand.ordinal }
          : null;
        output.write(`${body}\n\n`);
      } catch (error) {
        pendingRewind = null;
        output.write(`${red(error instanceof Error ? error.message : String(error), supportsColor(output))}\n\n`);
      }
      return "continue";
    }
    if (text === "/cwd" || text === "/pwd") {
      output.write(`${t("cwd.info", { cwd: chatCwd })}\n\n`);
      return "continue";
    }
    const localReadOnly = parseLocalReadOnlyCommand(text, chatCwd);
    if (localReadOnly?.kind === "blocked") {
      output.write(`${renderLocalReadOnlyBlocked(localReadOnly, output)}\n\n`);
      return "continue";
    }
    if (localReadOnly?.kind === "command") {
      const result = await runLocalReadOnlyCommand(localReadOnly.command);
      output.write(`${renderLocalReadOnlyResult(localReadOnly.command, result, output)}\n\n`);
      return "continue";
    }
    const memoryCommand = await handleMemorySlashCommand(text, dataDir);
    if (memoryCommand?.handled) {
      if (memoryCommand.changed) {
        memoryFrame = buildMemoryContextFrameSync(dataDir);
        refreshCliRuntimeSystemMessage(messages, chatRouteLabel(cliProvider?.profile), memoryFrame);
      }
      output.write(`${memoryCommand.message}\n\n`);
      return "continue";
    }
    if (text.startsWith("/")) {
      output.write(`${t("slash.unknown")}\n\n`);
      return "continue";
    }

    return sendUserMessage(text, text);
  }

  async function sendUserMessage(displayText: string, content: ChatMessage["content"]): Promise<"continue"> {
    const checkpoint = beginChatRewindTurn(rewindState, displayText, messages.length);
    messages.push({ role: "user", content });
    try {
      renderChatCompaction(compactChatMessages(messages));
      if (mockBrain) {
        const answer = t("mock.response", { text: displayText });
        messages.push({ role: "assistant", content: answer });
        renderChatCompaction(compactChatMessages(messages));
        output.write(`${answer}\n\n`);
        return "continue";
      }

      let latestUsage: string | null = null;
      const spinner = new TerminalSpinner(process.stderr, t("spinner.thinking"), {
        danger: mode.approval === "yolo" || mode.sandbox === "danger-full-access",
      });
      const renderReasoning = shouldRenderReasoning(reasoning.display, false);
      const color = supportsColor(output);
      const maxEmptyAttempts = 3;
      let decodeTps: string | null = null;
      let finalAssistant = "";
      for (let attempt = 1; attempt <= maxEmptyAttempts; attempt += 1) {
        latestUsage = null;
        decodeTps = null;
        let toolSteps = 0;
        let attemptHadToolCalls = false;
        try {
          for (;;) {
            const round = await streamChatModelRound({
              brainUrl,
              messages,
              reasoning,
              cliProvider,
              renderReasoning,
              brainRenderState,
              runtimeMetrics,
              spinner,
              color,
            });
            latestUsage = round.latestUsage || latestUsage;
            decodeTps = round.decodeTps || decodeTps;
            const requests = round.toolRequests;
            if (!requests.length) {
              finalAssistant = round.assistant;
              break;
            }
            attemptHadToolCalls = true;
            if (round.structuredToolCalls) {
              messages.push({
                role: "assistant",
                content: round.assistant,
                tool_calls: assistantToolCallsForMessages(requests),
              });
            } else {
              messages.push({ role: "assistant", content: round.assistant });
            }
            const fallbackSections: string[] = [];
            for (const request of requests) {
              toolSteps += 1;
              if (toolSteps > CHAT_MAX_TOOL_STEPS) {
                const message = `Lynn chat stopped after ${CHAT_MAX_TOOL_STEPS} local tool steps. Try narrowing the request or use Lynn code for a long-running task.`;
                messages.push({ role: "user", content: message });
                output.write(`\n${red(message, color)}\n\n`);
                return "continue";
              }
              const result = await runChatClientTool(request);
              const section = formatChatClientToolSection(request, result);
              if (round.structuredToolCalls) {
                messages.push({
                  role: "tool",
                  tool_call_id: request.toolCallId,
                  name: request.tool,
                  content: section,
                });
              } else {
                fallbackSections.push(section);
              }
            }
            if (!round.structuredToolCalls && fallbackSections.length) {
              messages.push({ role: "user", content: `<lynn_local_tool_observations>\n${fallbackSections.join("\n\n")}\n</lynn_local_tool_observations>` });
            }
          }
        } catch (error) {
          spinner.stop();
          messages.pop();
          output.write(`\n${formatChatError(error)}\n\n`);
          return "continue";
        } finally {
          spinner.stop();
        }
        if (finalAssistant.trim()) break;
        if (attemptHadToolCalls) break;
        if (attempt < maxEmptyAttempts) output.write(`\n${dim(t("prompt.empty.retry"), color)}\n\n`);
      }
      if (!finalAssistant.trim()) {
        messages.pop();
        output.write(`${red(t("prompt.empty"), color)}\n\n`);
        return "continue";
      }
      messages.push({ role: "assistant", content: finalAssistant });
      renderChatCompaction(compactChatMessages(messages));
      recordDecodeTps(runtimeMetrics, decodeTps);
      output.write(`\n${renderStatusBar({
        model: brainRenderState.provider ? modelDisplayName(brainRenderState.provider) : t("status.chat.prefix"),
        cwd: chatCwd,
        mode: renderMode(mode),
        reasoning: reasoning.effort,
        usage: latestUsage,
        decodeTps,
        metrics: renderRuntimeMetrics(runtimeMetrics),
        color,
      })}\n\n`);
      return "continue";
    } finally {
      finishChatRewindTurn(rewindState, checkpoint);
    }
  }

  async function streamChatModelRound(inputData: {
    brainUrl: string;
    messages: ChatMessage[];
    reasoning: typeof reasoning;
    cliProvider: typeof cliProvider;
    renderReasoning: boolean;
    brainRenderState: HumanBrainRenderState;
    runtimeMetrics: ReturnType<typeof createRuntimeMetrics>;
    spinner: TerminalSpinner;
    color: boolean;
  }): Promise<{ assistant: string; toolRequests: CodeToolRequest[]; structuredToolCalls: boolean; latestUsage: string | null; decodeTps: string | null }> {
    let assistant = "";
    let latestUsage: string | null = null;
    let decodeTps: string | null = null;
    const md = new MarkdownStream((s) => output.write(s), inputData.color);
    const turnStarted = Date.now();
    const decodeTracker = createDecodeSpeedTracker(turnStarted);
    const toolAccumulator = createStreamingToolCallAccumulator();
    try {
      inputData.spinner.start();
      for await (const event of streamBrainChat({
        brainUrl: inputData.brainUrl,
        messages: inputData.messages,
        reasoning: inputData.reasoning,
        fallbackProvider: inputData.cliProvider?.profile,
        tools: codeToolDefinitions(),
      })) {
        if (event.type === "tool_call.delta") {
          toolAccumulator.append(event);
          continue;
        }
        if (eventWritesHumanOutput(event, inputData.renderReasoning)) {
          inputData.spinner.stop();
        }
        if (event.type === "brain.error") {
          throw new Error(event.code ? `${event.error} (${event.code})` : event.error);
        }
        if (event.type === "assistant.delta") {
          md.push(event.text);
          decodeTps = decodeTracker.add(event.text) || decodeTps;
          assistant += event.text;
        } else {
          if (event.type === "usage") {
            latestUsage = summarizeUsage(event.usage, { durationMs: Date.now() - turnStarted });
            recordUsageMetrics(inputData.runtimeMetrics, event.usage);
          }
          renderChatEvent(event, inputData.renderReasoning, inputData.brainRenderState, turnStarted);
          if (shouldResumeWaitingSpinner(event)) inputData.spinner.start();
        }
      }
    } finally {
      inputData.spinner.stop();
      md.end();
    }
    const structuredRequests = toolRequestsFromCollectedCalls(toolAccumulator.toToolCalls(), 0);
    if (structuredRequests.length) {
      return { assistant, toolRequests: structuredRequests, structuredToolCalls: true, latestUsage, decodeTps };
    }
    return { assistant, toolRequests: parseCodeToolRequests(assistant), structuredToolCalls: false, latestUsage, decodeTps };
  }

  async function runChatClientTool(request: CodeToolRequest): Promise<ClientToolResult> {
    const preview = formatDangerousToolPreview(request.tool, request.args, supportsColor(output));
    renderClientToolStart(request, process.stderr);
    try {
      const effectiveApproval = await resolveToolApproval({
        tool: request.tool,
        approval: mode.approval,
        cwd: chatCwd,
        json: false,
        input,
        output,
        preview,
        args: request.args,
        session: approvalSession,
      });
      const effectiveSandbox = request.tool === "bash"
        && mode.approval === "ask"
        && effectiveApproval === "yolo"
        ? "danger-full-access"
        : mode.sandbox;
      maybeRecordChatRewindSnapshot(rewindState, chatCwd, request);
      const result = await runClientTool({ cwd: chatCwd, approval: effectiveApproval, sandbox: effectiveSandbox }, {
        name: request.tool,
        ...request.args,
      });
      renderClientToolResult(result, process.stderr, request);
      return result;
    } catch (error) {
      const result: ClientToolResult = {
        ok: false,
        tool: request.tool,
        error: error instanceof Error ? error.message : String(error),
      };
      renderClientToolResult(result, process.stderr, request);
      return result;
    }
  }

  function formatChatClientToolSection(request: CodeToolRequest, result: ClientToolResult): string {
    const body = result.ok
      ? JSON.stringify(result.output ?? {}, null, 2)
      : `ERROR: ${result.error || "tool failed"}`;
    return [
      `Tool result for ${request.tool}:`,
      compactToolResultBody(body),
    ].join("\n");
  }

  function renderChatCompaction(result: ReturnType<typeof compactChatMessages>): void {
    if (!result.compactedMessages) return;
    const color = supportsColor(process.stderr);
    process.stderr.write(`${renderCard({
      kind: "info",
      title: `context compacted · ${result.compactedMessages} old messages`,
      body: ["kept the first request, recent turns, links, and runtime notes"],
    }, color)}\n`);
  }

  try {
    if (!input.isTTY) {
      if (!rl) return 0;
      for await (const line of rl) {
        if (await handleText(line) === "break") break;
      }
    } else {
      const prompt = "› ";
      for (;;) {
        const text = await readInteractiveLine(prompt, mode, {
          placeholder: t("chat.placeholder"),
          history: new HistoryNavigator(history),
          completions: CHAT_SLASH_COMMANDS,
          frameStatus: buildPromptFrameStatus(cliProvider?.profile, mode, reasoning.effort),
          onShiftTab: () => renderInteractiveModeChange(toggleMode(mode), mode, supportsColor(output)),
        });
        if (text === null) break;
        if (await handleText(text) === "break") break;
      }
    }
  } finally {
    rl?.close();
  }
  return 0;
}

function parsePendingRewindInput(text: string, pending: { phase: "list" | "preview"; ordinal: number | null }): { ordinal: number; apply: boolean } | null {
  if (/^\d+$/.test(text)) return { ordinal: Number(text), apply: false };
  if (pending.phase === "preview" && pending.ordinal !== null && /^(?:y|yes|apply|确认|应用)$/i.test(text)) {
    return { ordinal: pending.ordinal, apply: true };
  }
  return null;
}

function eventWritesHumanOutput(event: BrainStreamEvent, renderReasoning: boolean): boolean {
  return event.type === "assistant.delta"
    || event.type === "provider"
    || event.type === "tool_progress"
    || event.type === "brain.error"
    || event.type === "usage"
    || (event.type === "reasoning.delta" && renderReasoning);
}

function shouldResumeWaitingSpinner(event: BrainStreamEvent): boolean {
  return event.type === "provider" || event.type === "tool_progress";
}

function compactToolResultBody(body: string, max = 16_000): string {
  if (body.length <= max) return body;
  return `${body.slice(0, max)}\n[Lynn chat truncated this local tool result from ${body.length} chars. Ask for a narrower read/search if more detail is needed.]`;
}

export interface ChatMode {
  approval: "ask" | "on-failure" | "never" | "yolo";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
}

interface KeypressLike {
  name?: string;
  shift?: boolean;
  sequence?: string;
}

export async function resolveChatMode(args: ParsedArgs): Promise<ChatMode> {
  const permissions = await resolveEffectivePermissions(args);
  return {
    approval: permissions.approval,
    sandbox: permissions.sandbox,
  };
}

export function renderMode(mode: ChatMode): string {
  const sandbox = mode.sandbox === "danger-full-access" ? "full-access" : mode.sandbox;
  return `${mode.approval} / ${sandbox}`;
}

function buildPromptFrameStatus(
  profile: { provider: string; model: string } | null | undefined,
  mode: ChatMode,
  effort: string,
): string {
  const model = profile ? modelLabelWithId(profile.model) : "StepFun 3.7 Flash";
  const think = effort === "off" ? "fast" : `think ${effort}`;
  return `Lynn · ${model} · ${renderMode(mode)} · ${think}`;
}

export function chatRouteLabel(provider?: { provider: string; model: string } | null): string {
  if (provider) return `CLI BYOK: ${modelLabelWithId(provider.model)}`;
  return "StepFun 3.7 Flash → MiMo V2.5 Pro → Spark Qwen 3.6 35B A3B via Brain router (auto)";
}

export function splitChatCommandLine(raw: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;
  for (const char of raw.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (escaping) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}

export function buildChatProviderArgs(raw: string, baseArgs: ParsedArgs): ParsedArgs | null {
  const tokens = splitChatCommandLine(raw);
  const head = tokens[0]?.toLowerCase();
  if (head !== "/providers" && head !== "/byok" && head !== "/setup" && head !== "/model") return null;
  if (head === "/model") {
    const rest = tokens.slice(1);
    if (!rest.length) return null;
    const subcommand = (rest[0] || "").toLowerCase();
    const parsed = ["set", "unset", "clear", "reset", "test", "presets"].includes(subcommand)
      ? parseArgs(["providers", ...rest])
      : parseArgs(["providers", "set", ...rest.slice(rest[0]?.startsWith("-") ? 0 : 1)]);
    if (subcommand && !["set", "unset", "clear", "reset", "test", "presets"].includes(subcommand) && !rest[0]?.startsWith("-")) {
      if (getStringFlag(parsed.flags, "base-url", "api-base")) {
        if (!getStringFlag(parsed.flags, "model")) parsed.flags.model = rest[0];
      } else if (!getStringFlag(parsed.flags, "preset")) {
        parsed.flags.preset = rest[0];
      }
    }
    const dataDir = getStringFlag(baseArgs.flags, "data-dir");
    if (dataDir && !getStringFlag(parsed.flags, "data-dir")) parsed.flags["data-dir"] = dataDir;
    return parsed;
  }
  if (head === "/setup") {
    const parsed = parseArgs(["providers", "set", ...tokens.slice(1).filter((value) => value.toLowerCase() !== "set")]);
    const dataDir = getStringFlag(baseArgs.flags, "data-dir");
    if (dataDir && !getStringFlag(parsed.flags, "data-dir")) parsed.flags["data-dir"] = dataDir;
    return parsed;
  }
  const rest = tokens.slice(1);
  const subcommand = (rest[0] || "").toLowerCase();
  if (!["set", "unset", "clear", "reset", "test", "presets"].includes(subcommand)) return null;
  const parsed = parseArgs(["providers", ...rest]);
  const dataDir = getStringFlag(baseArgs.flags, "data-dir");
  if (dataDir && !getStringFlag(parsed.flags, "data-dir")) parsed.flags["data-dir"] = dataDir;
  return parsed;
}

export function shouldRefreshProviderRoute(args: ParsedArgs): boolean {
  const subcommand = (args.positionals[0] || "").toLowerCase();
  return subcommand === "set" || subcommand === "unset" || subcommand === "clear" || subcommand === "reset";
}

export function shouldShowProviderSetUsage(args: ParsedArgs, interactive = false): boolean {
  const subcommand = (args.positionals[0] || "").toLowerCase();
  if (subcommand !== "set") return false;
  if (interactive) return false;
  return !(
    getStringFlag(args.flags, "provider")
    || getStringFlag(args.flags, "preset")
    || getStringFlag(args.flags, "base-url", "api-base")
    || getStringFlag(args.flags, "api-key")
    || getStringFlag(args.flags, "model")
  );
}

export function renderOfflineChatHint(_mode: ChatMode, _brainUrl = "http://127.0.0.1:8790", provider?: { provider: string; model: string } | null): string {
  // The startup banner already shows brain URL + mode; keep this hint concise and
  // non-redundant — just the localized next steps.
  if (provider) return t("offline.body.byok", { provider: provider.provider, model: provider.model });
  return t("offline.body");
}

export function applyModeCommand(mode: ChatMode, raw: string): string {
  const value = raw.toLowerCase();
  if (value === "yolo") {
    mode.approval = "yolo";
    mode.sandbox = "danger-full-access";
    return t("mode.yolo.enabled");
  }
  if (value === "ask" || value === "guarded") {
    mode.approval = "ask";
    mode.sandbox = "workspace-write";
    return t("mode.ask.enabled");
  }
  if (value === "read-only" || value === "readonly") {
    mode.approval = "ask";
    mode.sandbox = "read-only";
    return t("mode.readonly.enabled");
  }
  if (value === "workspace" || value === "workspace-write") {
    mode.approval = "ask";
    mode.sandbox = "workspace-write";
    return t("mode.workspace.enabled");
  }
  if (value === "danger" || value === "danger-full-access") {
    mode.approval = "yolo";
    mode.sandbox = "danger-full-access";
    return t("mode.danger.enabled");
  }
  return t("mode.unknown", { raw: raw || "(empty)" });
}

export function isModeToggleKeypress(key: KeypressLike | undefined): boolean {
  return !!key && (key.sequence === "\u001b[Z" || (key.name === "tab" && key.shift === true));
}

export function toggleMode(mode: ChatMode): string {
  if (mode.approval === "yolo" || mode.sandbox === "danger-full-access") {
    return applyModeCommand(mode, "ask");
  }
  return applyModeCommand(mode, "yolo");
}

function renderInteractiveModeChange(message: string, mode: ChatMode, color: boolean): string {
  const dangerous = mode.approval === "yolo" || mode.sandbox === "danger-full-access";
  if (dangerous) {
    const head = "⚠  YOLO / full-access  ⚠";
    return [
      "",
      orange(bold(head, color), color),
      orange(message, color),
      `mode: ${orange(bold(renderMode(mode), color), color)}`,
      orange(t("mode.danger.warning"), color),
      "",
      "",
    ].join("\n");
  }
  return `${green("✓", color)} ${message}\nmode: ${dim(renderMode(mode), color)}\n\n`;
}

function renderLocalToolList(color: boolean): string {
  return CLIENT_TOOL_DEFINITIONS
    .map((tool) => {
      const suffix = tool.dangerous ? t("tool.approval.suffix") : "";
      return `${tool.name}${suffix}: ${dim(tool.description, color)}`;
    })
    .join("\n");
}

export function applyReasoningCommand(current: ReturnType<typeof parseReasoningOptions>, raw: string): { reasoning: ReturnType<typeof parseReasoningOptions>; message: string } {
  const value = raw.toLowerCase();
  if (value === "off" || value === "auto" || value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return { reasoning: { ...current, effort: value }, message: t("reasoning.effortSet", { value }) };
  }
  if (value === "show" || value === "always") {
    return { reasoning: { ...current, display: "always" }, message: t("reasoning.displayAlways") };
  }
  if (value === "hide" || value === "never") {
    return { reasoning: { ...current, display: "never" }, message: t("reasoning.displayNever") };
  }
  return { reasoning: current, message: t("reasoning.unknown", { raw: raw || "(empty)" }) };
}

export function applyThinkCommand(current: ReturnType<typeof parseReasoningOptions>, raw: string, scope: "chat" | "code"): { reasoning: ReturnType<typeof parseReasoningOptions>; message: string } {
  const value = raw.toLowerCase();
  if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "auto") {
    return {
      reasoning: { ...current, effort: value },
      message: t(scope === "chat" ? "chat.think.set" : "code.think.set", { value }),
    };
  }
  if (value === "off" || value === "fast") {
    return { reasoning: { ...current, effort: "off" }, message: t(scope === "chat" ? "chat.fast" : "code.fast") };
  }
  return { reasoning: current, message: t("reasoning.unknown", { raw: raw || "(empty)" }) };
}

export function formatChatError(error: unknown): string {
  if (error instanceof BrainConnectionError) {
    return t("chat.error.brainOffline", { brainUrl: error.brainUrl });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/all providers failed/i.test(message)) return formatBrainErrorForHuman(message);
  return `Lynn error: ${message}`;
}

function renderChatEvent(event: BrainStreamEvent, renderReasoning: boolean, renderState: HumanBrainRenderState, startedAt = Date.now()): event is { type: "assistant.delta"; text: string } {
  if (event.type === "assistant.delta") {
    output.write(event.text);
    return true;
  }
  if (event.type === "reasoning.delta" && renderReasoning) {
    process.stderr.write(dim(event.text, supportsColor(process.stderr)));
  } else if (event.type === "usage") {
    const summary = summarizeUsage(event.usage, { durationMs: Date.now() - startedAt });
    if (summary) process.stderr.write(`\nusage: ${summary}\n`);
  } else {
    renderBrainEventForHuman(event, renderState, process.stderr);
  }
  return false;
}
