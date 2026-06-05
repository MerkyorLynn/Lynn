import path from "node:path";
import { stdin as input, stdout as output, stderr as errorOutput } from "node:process";
import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { formatBrainRecoveryHint, type ChatMessage } from "../brain-client.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { resolveEffectivePermissions } from "../permissions.js";
import { parseReasoningOptions, shouldRenderReasoning } from "../reasoning.js";
import { shouldUseInkTui } from "../terminal-safety.js";
import { bold, dangerLine, dim, orange, supportsColor } from "../terminal-style.js";
import { renderMarkdown } from "../markdown.js";
import { HistoryNavigator, appendHistory, historyPath, loadHistory } from "../history.js";
import { completeSlash, normalizeSlashInput } from "../completion.js";
import { readInteractiveLine } from "../interactive-line.js";
import { box, displayCwd, padLine } from "../startup.js";
import { t } from "../i18n.js";
import { resolveCliProviderProfile, type CliProviderProfile } from "../provider-profile.js";
import { modelLabelWithId } from "../provider-presets.js";
import { CLIENT_TOOL_DEFINITIONS, runClientTool } from "../tools/registry.js";
import type { ClientToolName, ToolRunContext } from "../tools/types.js";
import { applyModeCommand, applyReasoningCommand, applyThinkCommand, buildChatProviderArgs, renderMode, shouldRefreshProviderRoute, shouldShowProviderSetUsage, toggleMode, type ChatMode } from "./chat.js";
import { renderBrainModelChoices, renderProvidersInfo, resolveProvidersInfo, runProviders } from "./providers.js";
import { readVersionInfo } from "../version.js";
import { renderCodeHeadlessHelp } from "../code-headless-help.js";
import { appendSessionLine, appendSessionMetadata, appendSessionTurn, listSessions, readSessionLines, resolveDataDir } from "../session/store.js";
import { buildMemoryContextFrameSync } from "../session/memory.js";
import { computeCodeContextLayerDiagnostics } from "../context-layers.js";
import { prepareCodeTaskInput } from "../code-input.js";
import { resolveDefaultBrainUrl } from "../brain-url.js";
import { isLocalRuntimeQuestion, localeForText, renderLocalRuntimeAnswer } from "../runtime-answer.js";
import { renderPlanCard } from "../terminal-spinner.js";
import { isLocalExitText, parseLocalReadOnlyCommand, renderLocalReadOnlyBlocked, renderLocalReadOnlyResult, runLocalReadOnlyCommand } from "../local-command.js";
import {
  assistantToolCallsForMessages,
  codeToolDefinitions,
  createStreamingToolCallAccumulator,
  toolRequestFingerprint,
  toolRequestsFromCollectedCalls,
  type CodeToolRequest,
  type CollectedToolCall,
} from "../code-tool-protocol.js";
import {
  canPromptForDangerousTool,
  formatDangerousToolPreview,
  isDangerousClientTool,
  resolveToolApproval,
} from "../code-tool-render.js";
import {
  buildCodePrompt,
  codeMediaPaths,
  collectCodeContext,
  renderMockCodeTask,
  type CodeContext,
} from "../code-context.js";
import {
  buildResumableMessageGroups,
  extractLatestPlan,
  formatToolResultForLoop,
  loadResumeMessages,
  readResumeSessionInfo,
  resolveCodeResumePath,
  resumeCommandForSession,
  shouldSaveCodeSession,
  summarizeResumeMessages,
  truncateForResume,
} from "../code-resume.js";
import { runCodeRewindCommand, runCodeRewindSlash } from "../code-rewind-command.js";

export { renderCodeHeadlessHelp } from "../code-headless-help.js";
import { buildCodeRuntimeFrames } from "../code-runtime-frames.js";
import {
  runCodeAgentLoop,
  type CodeAgentApprovalRequest,
  type CodeAgentEvent,
} from "../code-agent-loop.js";
import { runUltraCodeTask } from "../code-ultra-runner.js";
import type { UltraEvent, UltraOptions } from "../code-ultra.js";
import { mergeWorkspaceSnapshots } from "../code-snapshot.js";

export {
  codeToolDefinitions,
  createStreamingToolCallAccumulator,
  parseCodeToolRequest,
  parseCodeToolRequests,
  toolRequestFingerprint,
  toolRequestsFromCollectedCalls,
  assistantToolCallsForMessages,
  type CodeToolRequest,
  type CollectedToolCall,
} from "../code-tool-protocol.js";

export {
  canPromptForDangerousTool,
  isDangerousClientTool,
} from "../code-tool-render.js";

export {
  buildResumableMessageGroups,
  extractLatestPlan,
  formatToolResultForLoop,
  loadResumeMessages,
  readResumeSessionInfo,
  RESUME_COMPACTION_NOTE,
  RESUME_REPAIR_NOTE,
  RESUME_TORN_NOTE,
  resumeCommandForSession,
  summarizeResumeMessages,
} from "../code-resume.js";

export { buildCodeRuntimeFrames } from "../code-runtime-frames.js";
export type { CodeAgentApprovalRequest, CodeAgentEvent } from "../code-agent-loop.js";

function approval(args: ParsedArgs): "ask" | "on-failure" | "never" | "yolo" {
  const value = getStringFlag(args.flags, "approval");
  if (value === "ask" || value === "on-failure" || value === "never" || value === "yolo") return value;
  return "ask";
}

function cwd(args: ParsedArgs): string {
  return getStringFlag(args.flags, "cwd") || process.cwd();
}

function timeoutMs(args: ParsedArgs): number | undefined {
  const raw = getStringFlag(args.flags, "timeout-ms", "timeout");
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error("--timeout-ms must be a positive integer");
  return parsed;
}

function sandbox(args: ParsedArgs): ToolRunContext["sandbox"] {
  const value = getStringFlag(args.flags, "sandbox");
  if (value === "read-only" || value === "danger-full-access") return value;
  return "workspace-write";
}

const DEFAULT_MAX_STEPS = 8;
const STANDARD_MAX_STEPS = 20;
const LONG_MAX_STEPS = 1000;

export function isLongRun(args: ParsedArgs): boolean {
  return hasFlag(args.flags, "long", "endurance");
}

export function withLongRunCodeFlags(flags: Record<string, string | boolean> = {}): Record<string, string | boolean> {
  return {
    ...flags,
    long: flags.long ?? true,
    "save-session": flags["save-session"] ?? true,
    "max-steps": flags["max-steps"] ?? "1000",
  };
}

export function parseCodeResumeSlash(raw: string): { resume: string; task: string } {
  const text = raw.trim();
  const body = text.replace(/^\/(?:resume|continue)\b/i, "").trim();
  if (!body) return { resume: "last", task: "继续这个任务" };
  const [first = "", ...rest] = body.split(/\s+/);
  const looksLikeResumeRef = first === "last"
    || first === "latest"
    || first.endsWith(".jsonl")
    || first.startsWith("/")
    || first.startsWith("~")
    || first.includes(path.sep);
  if (!looksLikeResumeRef) return { resume: "last", task: body };
  return { resume: first, task: rest.join(" ").trim() || "继续这个任务" };
}

export function maxSteps(args: ParsedArgs): number {
  const raw = getStringFlag(args.flags, "max-steps", "steps");
  if (!raw) return DEFAULT_MAX_STEPS;
  const parsed = Number.parseInt(raw, 10);
  const cap = isLongRun(args) ? LONG_MAX_STEPS : STANDARD_MAX_STEPS;
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > cap) {
    const hint = isLongRun(args) ? "" : " (pass --long for endurance runs up to 1000 steps)";
    throw new Error(`--max-steps must be an integer from 1 to ${cap}${hint}`);
  }
  return parsed;
}

export async function runCode(args: ParsedArgs): Promise<number> {
  const json = hasFlag(args.flags, "json", "jsonl");
  if (hasFlag(args.flags, "help", "h")) {
    const text = renderCodeHeadlessHelp();
    if (json) writeJsonLine({ type: "code.help", ts: nowIso(), text });
    else process.stdout.write(`${text}\n`);
    return 0;
  }
  if (hasFlag(args.flags, "list-tools")) {
    const payload = { type: "code.tools", ts: nowIso(), tools: CLIENT_TOOL_DEFINITIONS };
    if (json) writeJsonLine(payload);
    else process.stdout.write(`${CLIENT_TOOL_DEFINITIONS.map((tool) => `${tool.name}${tool.dangerous ? " (approval required)" : ""}: ${tool.description}`).join("\n")}\n`);
    return 0;
  }
  if (hasFlag(args.flags, "rewind")) {
    return runCodeRewindCommand(args, json, { output, errorOutput });
  }

  const tool = getStringFlag(args.flags, "tool") as ClientToolName | null;
  if (!tool) {
    const task = codeTaskPrompt(args);
    if (task && isLocalRuntimeQuestion(task)) return runCodeLocalRuntimeAnswer(args, task, json);
    if (task) return runCodeTask(args, task, json);
    if (!json && input.isTTY && output.isTTY) {
      if (ultraEnabled(args)) {
        errorOutput.write(`${dim("note: --ultra applies to headless tasks (e.g. Lynn code --ultra -p \"…\"); this interactive session runs normally.", supportsColor(errorOutput))}\n`);
      }
      if (shouldUseInkTui(args)) {
        const { runInkCode } = await import("../ink-code.js");
        return runInkCode(args, runCodeTaskWithEvents);
      }
      return runCodeInteractive(args);
    }
    const message = "code mode ready; pass a task, --list-tools, or --tool <name>";
    if (json) writeJsonLine({ type: "code.ready", ts: nowIso(), message, cwd: cwd(args) });
    else process.stdout.write(`${message}\n`);
    return 0;
  }

  const toolCwd = cwd(args);
  const toolMode = await resolveCodeMode(args);
  const toolArgsForApproval = {
    path: getStringFlag(args.flags, "path") || undefined,
    text: getStringFlag(args.flags, "text", "content") || args.positionals.join(" ") || undefined,
    command: getStringFlag(args.flags, "command") || args.positionals.join(" ") || undefined,
  };
  const toolApproval = await resolveToolApproval({
    tool,
    approval: toolMode.approval,
    cwd: toolCwd,
    json,
    input,
    output: errorOutput,
    preview: formatDangerousToolPreview(tool, toolArgsForApproval, supportsColor(errorOutput)),
    args: toolArgsForApproval,
  });
  const result = await runClientTool(
    { cwd: toolCwd, approval: toolApproval, sandbox: toolMode.sandbox, timeoutMs: timeoutMs(args) },
    {
      name: tool,
      path: getStringFlag(args.flags, "path") || undefined,
      text: getStringFlag(args.flags, "text", "content") || args.positionals.join(" ") || undefined,
      query: getStringFlag(args.flags, "query") || undefined,
      pattern: getStringFlag(args.flags, "pattern") || undefined,
      command: getStringFlag(args.flags, "command") || args.positionals.join(" ") || undefined,
      maxBytes: Number(getStringFlag(args.flags, "max-bytes") || 0) || undefined,
    },
  );
  if (json) writeJsonLine({ type: "code.tool.result", ts: nowIso(), ...result });
  else process.stdout.write(`${JSON.stringify(result.output, null, 2)}\n`);
  return result.ok ? 0 : 1;
}

export function codeTaskPrompt(args: ParsedArgs): string {
  return [
    getStringFlag(args.flags, "p", "print", "prompt", "task"),
    args.positionals.join(" ").trim(),
  ].filter((part): part is string => !!part && !!part.trim()).join("\n\n").trim();
}

async function runCodeLocalRuntimeAnswer(args: ParsedArgs, task: string, json: boolean): Promise<number> {
  const mode = await resolveCodeMode(args);
  const reasoning = parseReasoningOptions(args);
  const cliProvider = await resolveCliProviderProfile(args);
  const text = await renderCodeLocalRuntimeAnswer(args, task, mode, reasoning, cliProvider?.profile);
  if (json) {
    writeJsonLine({ type: "code.task.started", ts: nowIso(), task, local: true });
    writeJsonLine({ type: "assistant.delta", ts: nowIso(), text });
    writeJsonLine({ type: "code.task.finished", ts: nowIso(), ok: true, local: true, contentReturned: true });
  } else {
    process.stdout.write(renderAssistantBlock(text, renderCodeFooter({
      context: { cwd: cwd(args), gitStatus: "unknown", gitDiffStat: "", topFiles: [], packageScripts: {} },
      mode,
      mockBrain: false,
      reasoning,
      fallbackProvider: cliProvider?.profile,
    })));
  }
  return 0;
}

async function renderCodeLocalRuntimeAnswer(
  args: ParsedArgs,
  text: string,
  mode: ChatMode,
  reasoning: ReturnType<typeof parseReasoningOptions>,
  fallbackProvider?: CliProviderProfile,
): Promise<string> {
  return renderLocalRuntimeAnswer({
    routeLabel: codeRouteLabel(false, fallbackProvider),
    brainUrl: await resolveDefaultBrainUrl(args),
    cwd: cwd(args),
    mode: renderMode(mode),
    reasoning: reasoning.effort,
  }, localeForText(text));
}

async function runCodeInteractive(args: ParsedArgs): Promise<number> {
  const mode = await resolveCodeMode(args);
  let reasoning = parseReasoningOptions(args);
  let cliProvider = await resolveCliProviderProfile(args);
  const interactiveCwd = getStringFlag(args.flags, "cwd") || process.cwd();
  output.write(renderCodeIntro(mode, reasoning, { color: supportsColor(output), modelLabel: codeRouteLabel(false, cliProvider?.profile) }));
  const histFile = historyPath();
  const history = loadHistory(histFile);
  const slashCommands = [
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
    "/goal",
    "/resume",
    "/rewind",
    "/providers",
    "/help",
    "/exit",
    "/quit",
    "/version",
    "/about",
    "/reasoning",
    "/continue",
    "/model stepfun",
  "/model spark",
  "/setup",
  "/byok",
  "/providers set",
    "/providers unset",
    "/providers test",
    "/providers presets",
    "/byok set",
    "/byok unset",
  ];
  try {
    for (;;) {
      const raw = await readCodeLine("› ", mode, {
        placeholder: t("code.placeholder"),
        history: new HistoryNavigator(history),
        completions: slashCommands,
      });
      if (raw === null) break;
      const text = normalizeSlashInput(raw.trim());
      if (!text) continue;
      if (isLocalExitText(text)) break;
      history.push(text);
      appendHistory(text, histFile);
      if (text === "/help") {
        output.write(`${t("code.help")}\n\n`);
        continue;
      }
      if (isLocalRuntimeQuestion(text)) {
        output.write(`${await renderCodeLocalRuntimeAnswer(args, text, mode, reasoning, cliProvider?.profile)}\n\n`);
        continue;
      }
      if (text === "/tools") {
        output.write(`${CLIENT_TOOL_DEFINITIONS.map((tool) => `${tool.name}${tool.dangerous ? t("tool.approval.suffix") : ""}: ${tool.description}`).join("\n")}\n\n`);
        continue;
      }
      if (text === "/fast") {
        reasoning = { ...reasoning, effort: "off" };
        output.write(`${t("code.fast")}\n\n`);
        continue;
      }
      if (text === "/think") {
        reasoning = { ...reasoning, effort: "high" };
        output.write(`${t("code.think")}\n\n`);
        continue;
      }
      if (text.startsWith("/think ")) {
        const result = applyThinkCommand(reasoning, text.slice(7).trim(), "code");
        reasoning = result.reasoning;
        output.write(`✓ ${result.message}\n${t("code.reasoning.state", { effort: reasoning.effort, display: reasoning.display })}\n\n`);
        continue;
      }
      if (text === "/reasoning") {
        output.write(`${t("code.reasoning.show", { effort: reasoning.effort, display: reasoning.display })}\n\n`);
        continue;
      }
      if (text.startsWith("/reasoning ")) {
        const result = applyReasoningCommand(reasoning, text.slice(11).trim());
        reasoning = result.reasoning;
        output.write(`✓ ${result.message}\n${t("code.reasoning.state", { effort: reasoning.effort, display: reasoning.display })}\n\n`);
        continue;
      }
      if (text === "/goal") {
        output.write(`${t("code.goal.usage")}\n\n`);
        continue;
      }
      if (text.startsWith("/goal ")) {
        const task = text.slice(6).trim();
        output.write(`${t("code.goal.started")}\n\n`);
        const taskArgs: ParsedArgs = {
          ...args,
          positionals: [task],
          flags: withLongRunCodeFlags({
            ...args.flags,
            approval: mode.approval,
            sandbox: mode.sandbox,
            reasoning: reasoning.effort,
            "show-reasoning": reasoning.display,
          }),
        };
        try {
          await runCodeTask(taskArgs, task, false, { compact: true });
        } catch (error) {
          const message = formatBrainRecoveryHint(error);
          errorOutput.write(`• ${message}\n`);
        }
        output.write("\n");
        continue;
      }
      if (text === "/rewind" || text.startsWith("/rewind ")) {
        await runCodeRewindSlash(text, args, { output, errorOutput });
        continue;
      }
      if (text === "/resume" || text === "/continue" || text.startsWith("/resume ") || text.startsWith("/continue ")) {
        const parsed = parseCodeResumeSlash(text);
        output.write(`${t("code.resume.started", { resume: parsed.resume })}\n\n`);
        const taskArgs: ParsedArgs = {
          ...args,
          positionals: [parsed.task],
          flags: withLongRunCodeFlags({
            ...args.flags,
            resume: parsed.resume,
            approval: mode.approval,
            sandbox: mode.sandbox,
            reasoning: reasoning.effort,
            "show-reasoning": reasoning.display,
          }),
        };
        try {
          await runCodeTask(taskArgs, parsed.task, false, { compact: true });
        } catch (error) {
          const message = formatBrainRecoveryHint(error);
          errorOutput.write(`• ${message}\n`);
        }
        output.write("\n");
        continue;
      }
      if (text === "/mode") {
        output.write(`${t("code.mode.show", { mode: renderMode(mode) })}\n\n`);
        continue;
      }
      if (text === "/yolo" || text === "/ask") {
        const result = applyModeCommand(mode, text.slice(1));
        output.write(renderModeChange(result, mode, supportsColor(output)));
        continue;
      }
      if (text.startsWith("/mode ")) {
        const result = applyModeCommand(mode, text.slice(6).trim());
        output.write(renderModeChange(result, mode, supportsColor(output)));
        continue;
      }
      if (text === "/model") {
        output.write(`${renderBrainModelChoices(await resolveProvidersInfo(args))}\n\n`);
        continue;
      }
      if (text === "/providers" || text === "/byok") {
        output.write(`${renderProvidersInfo(await resolveProvidersInfo(args))}\n\n`);
        continue;
      }
      const providerCommand = buildChatProviderArgs(text, args);
      if (providerCommand) {
        if (shouldShowProviderSetUsage(providerCommand, input.isTTY && output.isTTY)) {
          output.write(`${t("chat.providers.setUsage")}\n\n`);
          continue;
        }
        const previousRoute = codeRouteLabel(false, cliProvider?.profile);
        try {
          const code = await runProviders(providerCommand, false);
          if (shouldRefreshProviderRoute(providerCommand)) {
            cliProvider = await resolveCliProviderProfile(providerCommand) || await resolveCliProviderProfile(args);
            const nextRoute = codeRouteLabel(false, cliProvider?.profile);
            const changed = previousRoute !== nextRoute;
            output.write(`\n${t(changed ? "chat.providers.routeReloaded" : "chat.providers.routeUnchanged", { route: nextRoute })}\n\n`);
          } else if (code === 0) {
            output.write("\n");
          }
        } catch (error) {
          const message = formatBrainRecoveryHint(error);
          errorOutput.write(`• ${message}\n`);
        }
        continue;
      }
      if (text.startsWith("/providers ") || text.startsWith("/byok ")) {
        output.write(`${t("chat.providers.usage")}\n\n`);
        continue;
      }
      const localReadOnly = parseLocalReadOnlyCommand(text, interactiveCwd);
      if (localReadOnly?.kind === "blocked") {
        output.write(`${renderLocalReadOnlyBlocked(localReadOnly, output)}\n\n`);
        continue;
      }
      if (localReadOnly?.kind === "command") {
        const result = await runLocalReadOnlyCommand(localReadOnly.command);
        output.write(`${renderLocalReadOnlyResult(localReadOnly.command, result, output)}\n\n`);
        continue;
      }
      if (text.startsWith("/")) {
        output.write(`${t("slash.unknown")}\n\n`);
        continue;
      }
      const taskArgs: ParsedArgs = {
        ...args,
        positionals: [text],
        flags: {
          ...args.flags,
          approval: mode.approval,
          sandbox: mode.sandbox,
          reasoning: reasoning.effort,
          "show-reasoning": reasoning.display,
        },
      };
      try {
        await runCodeTask(taskArgs, text, false, { compact: true });
      } catch (error) {
        const message = formatBrainRecoveryHint(error);
        errorOutput.write(`• ${message}\n`);
      }
      output.write("\n");
    }
  } finally {
    // no-op; readCodeLine restores raw mode per prompt
  }
  return 0;
}

export async function readCodeLine(prompt: string, mode: ChatMode, options: { placeholder?: string; history?: HistoryNavigator; completions?: string[] } = {}): Promise<string | null> {
  return readInteractiveLine(prompt, mode, {
    ...options,
    onShiftTab: () => renderModeChange(toggleMode(mode), mode, supportsColor(output)),
  });
}

export function renderCodeIntro(
  mode: ChatMode,
  reasoning = parseReasoningOptions({ command: "code", positionals: [], flags: {} }),
  options: { color?: boolean; modelLabel?: string } = {},
): string {
  const color = !!options.color;
  const version = readVersionInfo().version;
  const lines = [
    `Lynn Code (${version})`,
    "",
    padLine(t("banner.label.model"), options.modelLabel || t("banner.model.default"), t("banner.hint.model")),
    padLine(t("banner.label.dir"), displayCwd(process.cwd())),
  ];
  const dangerous = mode.approval === "yolo" || mode.sandbox === "danger-full-access";
  return [
    box(lines),
    "",
    dangerous
      ? `  ${dangerLine(t("code.danger.warning"), color)}`
      : `  ${t("code.tip")}`,
    "",
  ].join("\n");
}

function renderModeChange(message: string, mode: ChatMode, color: boolean): string {
  const dangerous = mode.approval === "yolo" || mode.sandbox === "danger-full-access";
  const modeLabel = dangerous ? orange(renderMode(mode), color) : renderMode(mode);
  const warning = dangerous
    ? `\n${dangerLine(t("mode.danger.warning"), color)}`
    : "";
  return `✓ ${message}\nmode: ${modeLabel}${warning}\n\n`;
}

export function renderCodeTaskHeader(inputData: {
  cwd: string;
  approval: ToolRunContext["approval"];
  sandbox: NonNullable<ToolRunContext["sandbox"]>;
  reasoning: ReturnType<typeof parseReasoningOptions>;
  maxSteps: number;
  mockBrain?: boolean;
  fallbackProvider?: CliProviderProfile;
}): string {
  const route = codeRouteLabel(!!inputData.mockBrain, inputData.fallbackProvider);
  return [
    box([
      `Lynn Code · ${route}`,
      "",
      padLine(t("banner.label.dir"), displayCwd(inputData.cwd)),
      padLine(t("banner.label.mode"), `${inputData.approval} / ${inputData.sandbox}`),
      padLine(t("code.label.think"), `${inputData.reasoning.effort} · ${t("code.maxsteps", { n: inputData.maxSteps })}`),
    ]),
    "",
  ].join("\n");
}

async function resolveCodeMode(args: ParsedArgs): Promise<ChatMode> {
  const permissions = await resolveEffectivePermissions(args);
  return {
    approval: permissions.approval,
    sandbox: permissions.sandbox,
  };
}

export async function runCodeTaskWithEvents(
  args: ParsedArgs,
  task: string,
  onEvent: (event: CodeAgentEvent) => void,
  options: { requestApproval?: (request: CodeAgentApprovalRequest) => Promise<"approve" | "approve_all" | "deny"> } = {},
): Promise<number> {
  return runCodeTask(args, task, false, { compact: true, onEvent, requestApproval: options.requestApproval });
}

async function runCodeTask(
  args: ParsedArgs,
  task: string,
  json: boolean,
  options: {
    compact?: boolean;
    onEvent?: (event: CodeAgentEvent) => void;
    requestApproval?: (request: CodeAgentApprovalRequest) => Promise<"approve" | "approve_all" | "deny">;
  } = {},
): Promise<number> {
  const context = await collectCodeContext(cwd(args));
  const preparedInput = prepareCodeTaskInput(task, context.cwd, t("chat.image.defaultPrompt"));
  const taskText = preparedInput.task;
  const mediaPaths = codeMediaPaths(args, preparedInput.mediaPaths);
  const reasoning = parseReasoningOptions(args);
  const stepBudget = maxSteps(args);
  const brainUrl = await resolveDefaultBrainUrl(args);
  const mockBrain = hasFlag(args.flags, "mock-brain", "mock");
  const mode = await resolveCodeMode(args);
  const cliProvider = await resolveCliProviderProfile(args);
  const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
  const memoryFrame = buildMemoryContextFrameSync(dataDir, taskText);
  const resumePath = await resolveCodeResumePath(getStringFlag(args.flags, "resume"), dataDir);
  const resumeMessages = resumePath ? await loadResumeMessages(resumePath) : [];
  const resumeDiag = resumePath ? summarizeResumeMessages(resumeMessages) : null;
  const resumeInfo = resumePath ? await readResumeSessionInfo(resumePath) : null;
  const resumePlan = resumePath ? extractLatestPlan(resumeMessages) : [];
  const saveSession = shouldSaveCodeSession(args, { json, mockBrain, resumePath });
  const sessionPath = getStringFlag(args.flags, "session") || resumePath;
  const title = getStringFlag(args.flags, "title") || taskText;
  let liveSessionPath = sessionPath;
  if (!json && !options.compact && !options.onEvent) {
    errorOutput.write(renderCodeTaskHeader({
      cwd: context.cwd,
      approval: mode.approval,
      sandbox: mode.sandbox,
      reasoning,
      maxSteps: stepBudget,
      mockBrain,
      fallbackProvider: cliProvider?.profile,
    }));
  }
  if (resumeDiag && !json && !options.compact && !options.onEvent) {
    if (resumeInfo?.firstPrompt) {
      errorOutput.write(`${t("code.resume.task", { task: truncateForResume(resumeInfo.firstPrompt) })}\n`);
    }
    let detail = "";
    if (resumeDiag.repairedTools > 0) detail += t("code.resume.repaired", { n: resumeDiag.repairedTools });
    if (resumeDiag.compacted) detail += t("code.resume.compacted");
    if (resumeDiag.tornLines > 0) detail += t("code.resume.torn", { n: resumeDiag.tornLines });
    errorOutput.write(`${t("code.resume.summary", { messages: resumeDiag.messages, detail })}\n`);
    if (resumePlan.length) {
      errorOutput.write(`${renderPlanCard(resumePlan.map((item) => ({
        status: item.status,
        text: item.content,
      })), supportsColor(errorOutput))}\n`);
    }
    if (resumeInfo?.cwd && path.resolve(resumeInfo.cwd) !== path.resolve(context.cwd)) {
      errorOutput.write(`${t("code.resume.cwdDrift", { saved: resumeInfo.cwd, current: context.cwd })}\n`);
    }
    // When we auto-picked the latest session, name a couple of recent alternatives
    // so resume is an informed choice, not a silent guess.
    if (["last", "latest"].includes((getStringFlag(args.flags, "resume") || "").trim())) {
      const others = (await listSessions(dataDir))
        .filter((entry) => path.resolve(entry.path) !== path.resolve(resumePath as string))
        .slice(0, 2);
      if (others.length) {
        const list = others.map((entry) => truncateForResume(entry.title || entry.firstMessage || entry.path, 40)).join(" · ");
        errorOutput.write(`${t("code.resume.others", { list })}\n`);
      }
    }
  }
  if (json) {
    writeJsonLine({ type: "code.task.started", ts: nowIso(), task: taskText, context, mediaPaths });
    if (resumePath) writeJsonLine({ type: "session.resumed", ts: nowIso(), path: resumePath, messages: resumeMessages.length, repairedTools: resumeDiag?.repairedTools ?? 0, compacted: resumeDiag?.compacted ?? false, tornLines: resumeDiag?.tornLines ?? 0, plan: resumePlan });
  }
  if (resumePath) options.onEvent?.({ type: "session.resumed", path: resumePath, messages: resumeMessages.length });

  if (mockBrain) {
    const text = renderMockCodeTask(taskText, context);
    options.onEvent?.({ type: "assistant.delta", text });
    options.onEvent?.({ type: "task.finished", ok: true, text, usageSummary: null });
    if (json) {
      writeJsonLine({ type: "assistant.delta", ts: nowIso(), text });
      writeJsonLine({ type: "code.task.finished", ts: nowIso(), ok: true });
    } else if (!options.onEvent) {
      process.stdout.write(renderAssistantBlock(text, renderCodeFooter({ context, mode, mockBrain, reasoning })));
    }
    if (saveSession) {
      const savedPath = await appendSessionTurn({ dataDir, sessionPath, cwd: context.cwd, title, prompt: taskText, assistant: text, modelProvider: "mock", modelId: "mock-brain" });
      await appendSessionMetadata({ dataDir, sessionPath: savedPath, data: { kind: "code_task", mock: true, cwd: context.cwd, images: mediaPaths, resumedFrom: resumePath || null } });
      options.onEvent?.({ type: "session.saved", path: savedPath });
      if (json) writeJsonLine({ type: "session.saved", ts: nowIso(), path: savedPath });
    }
    return 0;
  }

  const toolCtx: ToolRunContext = {
    cwd: cwd(args),
    approval: mode.approval,
    sandbox: mode.sandbox,
    timeoutMs: timeoutMs(args),
  };
  if (ultraEnabled(args) && !options.compact) {
    return runUltraCodeBranch({
      args,
      taskText,
      context,
      brainUrl,
      fallbackProvider: cliProvider?.profile,
      reasoning,
      json,
      toolCtx,
      stepBudget,
      mode,
      options,
      dataDir,
      saveSession,
      sessionPath,
      title,
      modelProvider: cliProvider?.profile.provider || "brain",
      modelId: cliProvider?.profile.model || "lynn-brain-router",
    });
  }
  let savedSessionPath: string | null = null;
  let rewindBeforeLine: number | null = null;
  const rewindSnapshots: Array<{ ref: string; restoreCommand: string }> = [];
  if (saveSession) {
    rewindBeforeLine = liveSessionPath ? (await readSessionLines(liveSessionPath).catch(() => [])).length : 0;
    liveSessionPath = await appendSessionLine({
      dataDir,
      sessionPath: liveSessionPath,
      cwd: context.cwd,
      title,
      line: { type: "user", content: taskText, data: { kind: "code_user_turn" } },
      modelProvider: cliProvider?.profile.provider || "brain",
      modelId: cliProvider?.profile.model || "lynn-brain-router",
    });
    if (json) writeJsonLine({ type: "session.checkpoint", ts: nowIso(), path: liveSessionPath, line: "user" });
    options.onEvent?.({ type: "session.checkpoint", path: liveSessionPath, line: "user" });
  }
  const final = await runCodeAgentLoop({
    task: taskText,
    context,
    brainUrl,
    fallbackProvider: cliProvider?.profile,
    reasoning,
    json,
    maxSteps: stepBudget,
    toolCtx,
    input,
    output: errorOutput,
    imagePaths: mediaPaths,
    resumeMessages,
    memoryFrame,
    onEvent: (event) => {
      if (event.type === "snapshot") rewindSnapshots.push({ ref: event.ref, restoreCommand: event.restoreCommand });
      options.onEvent?.(event);
    },
    requestApproval: options.requestApproval,
    onCheckpoint: saveSession && liveSessionPath
      ? async (line) => {
          liveSessionPath = await appendSessionLine({
            dataDir,
            sessionPath: liveSessionPath,
            cwd: context.cwd,
            title,
            line,
            modelProvider: cliProvider?.profile.provider || "brain",
            modelId: cliProvider?.profile.model || "lynn-brain-router",
          });
          if (json) writeJsonLine({ type: "session.checkpoint", ts: nowIso(), path: liveSessionPath, line: line.type });
          options.onEvent?.({ type: "session.checkpoint", path: liveSessionPath, line: line.type });
        }
      : undefined,
  });
  if (saveSession) {
    if (liveSessionPath && final.text.trim()) {
      const existingLines = await readSessionLines(liveSessionPath).catch(() => []);
      const lastMessage = [...existingLines].reverse().find((line) => line.type === "assistant" || line.type === "user");
      if (!(lastMessage?.type === "assistant" && lastMessage.content === final.text)) {
        liveSessionPath = await appendSessionLine({
          dataDir,
          sessionPath: liveSessionPath,
          cwd: context.cwd,
          title,
          line: { type: "assistant", content: final.text },
          modelProvider: cliProvider?.profile.provider || "brain",
          modelId: cliProvider?.profile.model || "lynn-brain-router",
        });
        if (json) writeJsonLine({ type: "session.checkpoint", ts: nowIso(), path: liveSessionPath, line: "assistant" });
        options.onEvent?.({ type: "session.checkpoint", path: liveSessionPath, line: "assistant" });
      }
    }
    savedSessionPath = liveSessionPath || await appendSessionTurn({
      dataDir,
      sessionPath,
      cwd: context.cwd,
      title,
      prompt: taskText,
      assistant: final.text,
      modelProvider: cliProvider?.profile.provider || "brain",
      modelId: cliProvider?.profile.model || "lynn-brain-router",
    });
    if (rewindBeforeLine !== null && rewindSnapshots.length) {
      const uniqueSnapshots = [...new Map(rewindSnapshots.map((snapshot) => [snapshot.ref, snapshot])).values()];
      for (const snapshot of uniqueSnapshots) {
        await appendSessionMetadata({
          dataDir,
          sessionPath: savedSessionPath,
          data: {
            kind: "code_rewind_checkpoint",
            snapshotRef: snapshot.ref,
            restoreCommand: snapshot.restoreCommand,
            cwd: context.cwd,
            task: taskText,
            beforeLine: rewindBeforeLine,
            createdAt: new Date().toISOString(),
          },
        });
      }
    }
    await appendSessionMetadata({
      dataDir,
      sessionPath: savedSessionPath,
      data: {
        kind: "code_task",
        cwd: context.cwd,
        images: mediaPaths,
        reasoning,
        maxSteps: stepBudget,
        maxStepsReached: final.maxStepsReached,
        cacheDiagnostics: computeCodeContextLayerDiagnostics(buildCodeRuntimeFrames({ context, toolCtx, memoryFrame }), resumeMessages.length),
        usageSummary: final.usageSummary,
        usageRecords: final.usageRecords,
        resumedFrom: resumePath || null,
      },
    });
    options.onEvent?.({ type: "session.saved", path: savedSessionPath });
    if (json) writeJsonLine({ type: "session.saved", ts: nowIso(), path: savedSessionPath });
  }
  const resumeCommand = final.maxStepsReached && savedSessionPath
    ? resumeCommandForSession(savedSessionPath)
    : null;
  options.onEvent?.({
    type: "task.finished",
    ok: !final.maxStepsReached,
    text: final.text,
    usageSummary: final.usageSummary,
    maxStepsReached: final.maxStepsReached,
    resumeCommand: resumeCommand || undefined,
    sessionPath: savedSessionPath,
  });
  if (json) {
    if (final.text.trim()) writeJsonLine({ type: "assistant.delta", ts: nowIso(), text: final.text });
    writeJsonLine({
      type: "code.task.finished",
      ts: nowIso(),
      ok: !final.maxStepsReached,
      contentReturned: !!final.text.trim(),
      ...(final.usageSummary ? { usageSummary: final.usageSummary } : {}),
      ...(final.maxStepsReached ? { code: "max_steps_reached" } : {}),
      ...(savedSessionPath ? { sessionPath: savedSessionPath } : {}),
      ...(resumeCommand ? { resumeCommand } : {}),
    });
  } else if (!options.onEvent) {
    const answer = [
      renderMarkdown(final.text.trim() || "(no answer)", supportsColor(output)),
      resumeCommand ? t("code.resume.maxSteps", { command: resumeCommand }) : "",
    ].filter(Boolean).join("\n\n");
    process.stdout.write(renderAssistantBlock(answer, renderCodeFooter({
      context,
      mode,
      mockBrain,
      reasoning,
      fallbackProvider: cliProvider?.profile,
      usage: final.usageSummary,
    })));
  }
  return final.maxStepsReached ? 2 : 0;
}

function renderAssistantBlock(text: string, footer?: string): string {
  const lines = text.replace(/\s+$/g, "").split(/\r?\n/);
  const body = lines.map((line, index) => `${index === 0 ? "• " : "  "}${line}`).join("\n");
  return `${body}${footer ? `\n\n${footer}` : ""}\n`;
}

function ultraEnabled(args: ParsedArgs): boolean {
  return hasFlag(args.flags, "ultra");
}

function ultraOptions(args: ParsedArgs): UltraOptions {
  const opts: UltraOptions = {};
  const maxSubtasks = Number.parseInt(getStringFlag(args.flags, "ultra-max-subtasks") || "", 10);
  const maxConcurrency = Number.parseInt(getStringFlag(args.flags, "ultra-concurrency") || "", 10);
  if (Number.isFinite(maxSubtasks)) opts.maxSubtasks = maxSubtasks;
  if (Number.isFinite(maxConcurrency)) opts.maxConcurrency = maxConcurrency;
  if (hasFlag(args.flags, "ultra-verify")) opts.adversarialVerify = true;
  return opts;
}

async function runUltraCodeBranch(p: {
  args: ParsedArgs;
  taskText: string;
  context: CodeContext;
  brainUrl: string;
  fallbackProvider?: CliProviderProfile;
  reasoning: ReturnType<typeof parseReasoningOptions>;
  json: boolean;
  toolCtx: ToolRunContext;
  stepBudget: number;
  mode: ChatMode;
  options: { compact?: boolean; onEvent?: (event: CodeAgentEvent) => void };
  dataDir: string;
  saveSession: boolean;
  sessionPath?: string | null;
  title: string;
  modelProvider: string;
  modelId: string;
}): Promise<number> {
  const color = supportsColor(errorOutput);
  const compact = Boolean(p.options.compact || p.options.onEvent);
  const workerSnapshots: string[] = [];

  // Open the session with the user turn before running, so a crash still leaves
  // a resumable transcript and the rewind checkpoint anchors correctly.
  let liveSessionPath = p.sessionPath;
  let rewindBeforeLine: number | null = null;
  if (p.saveSession) {
    rewindBeforeLine = liveSessionPath ? (await readSessionLines(liveSessionPath).catch(() => [])).length : 0;
    liveSessionPath = await appendSessionLine({
      dataDir: p.dataDir,
      sessionPath: liveSessionPath,
      cwd: p.context.cwd,
      title: p.title,
      line: { type: "user", content: p.taskText, data: { kind: "code_ultra_user_turn" } },
      modelProvider: p.modelProvider,
      modelId: p.modelId,
    });
  }

  if (p.json) {
    writeJsonLine({ type: "code.ultra.started", ts: nowIso(), task: p.taskText });
  } else if (!compact) {
    errorOutput.write(`${orange("⚡ ultra", color)} ${dim("— decomposing into parallel sub-tasks…", color)}\n`);
  }

  const ultra = await runUltraCodeTask({
    task: p.taskText,
    context: p.context,
    brainUrl: p.brainUrl,
    fallbackProvider: p.fallbackProvider,
    reasoning: p.reasoning,
    maxSteps: p.stepBudget,
    toolCtx: p.toolCtx,
    input,
    output: errorOutput,
    options: ultraOptions(p.args),
    onEvent: (event) => emitUltraEvent(event, { json: p.json, compact, color, onEvent: p.options.onEvent }),
    onSubtaskEvent: (_subtaskId, event) => {
      if (event.type === "snapshot" && event.ref) workerSnapshots.push(event.ref);
    },
  });

  if (p.json) {
    writeJsonLine({
      type: "code.ultra.finished",
      ts: nowIso(),
      ok: ultra.ok,
      waves: ultra.waves,
      fallback: ultra.plan.fallback,
      subtasks: ultra.results.map((r) => ({ id: r.id, title: r.title, ok: r.ok, skipped: Boolean(r.skipped) })),
    });
    writeJsonLine({ type: "assistant.delta", ts: nowIso(), text: ultra.synthesis });
    writeJsonLine({ type: "code.task.finished", ts: nowIso(), ok: ultra.ok });
  } else if (p.options.onEvent) {
    p.options.onEvent({ type: "assistant.delta", text: ultra.synthesis });
    p.options.onEvent({ type: "task.finished", ok: ultra.ok, text: ultra.synthesis, usageSummary: null });
  } else {
    process.stdout.write(renderAssistantBlock(ultra.synthesis, renderCodeFooter({
      context: p.context,
      mode: p.mode,
      mockBrain: false,
      reasoning: p.reasoning,
    })));
  }

  // Persist the run: synthesis as the assistant turn + a single merged rewind
  // checkpoint that undoes every file all workers touched.
  if (p.saveSession && liveSessionPath) {
    liveSessionPath = await appendSessionLine({
      dataDir: p.dataDir,
      sessionPath: liveSessionPath,
      cwd: p.context.cwd,
      title: p.title,
      line: { type: "assistant", content: ultra.synthesis, data: { kind: "code_ultra_synthesis" } },
      modelProvider: p.modelProvider,
      modelId: p.modelId,
    });
    await appendSessionMetadata({
      dataDir: p.dataDir,
      sessionPath: liveSessionPath,
      data: {
        kind: "code_ultra_task",
        cwd: p.context.cwd,
        ok: ultra.ok,
        waves: ultra.waves,
        fallback: ultra.plan.fallback,
        subtasks: ultra.results.map((r) => ({ id: r.id, title: r.title, ok: r.ok, skipped: Boolean(r.skipped) })),
      },
    });
    if (workerSnapshots.length && rewindBeforeLine !== null) {
      const merged = mergeWorkspaceSnapshots(workerSnapshots);
      if (merged.available && merged.ref) {
        await appendSessionMetadata({
          dataDir: p.dataDir,
          sessionPath: liveSessionPath,
          data: {
            kind: "code_rewind_checkpoint",
            snapshotRef: merged.ref,
            restoreCommand: merged.restoreCommand,
            cwd: p.context.cwd,
            task: p.taskText,
            beforeLine: rewindBeforeLine,
            createdAt: new Date().toISOString(),
          },
        });
      }
    }
    if (p.json) writeJsonLine({ type: "session.saved", ts: nowIso(), path: liveSessionPath });
    p.options.onEvent?.({ type: "session.saved", path: liveSessionPath });
  }
  return ultra.ok ? 0 : 1;
}

function emitUltraEvent(
  event: UltraEvent,
  ctx: { json: boolean; compact: boolean; color: boolean; onEvent?: (event: CodeAgentEvent) => void },
): void {
  if (ctx.json) {
    writeJsonLine({ ...event, ts: nowIso() });
    return;
  }
  if (ctx.compact) {
    const plain = formatUltraEventLine(event, false);
    if (plain) ctx.onEvent?.({ type: "tool.progress", message: plain.trim() });
    return;
  }
  const line = formatUltraEventLine(event, ctx.color);
  if (line) errorOutput.write(`${line}\n`);
}

function formatUltraEventLine(event: UltraEvent, color: boolean): string | null {
  switch (event.type) {
    case "ultra.plan": {
      const n = event.plan.subtasks.length;
      const label = event.plan.fallback ? "single worker (no useful split)" : `${n} sub-task${n === 1 ? "" : "s"}`;
      const warn = event.plan.warnings.length ? ` ${dim(`(${event.plan.warnings.length} note(s))`, color)}` : "";
      return `${bold("plan", color)} ${dim("→", color)} ${label}${warn}`;
    }
    case "ultra.wave":
      return dim(`wave ${event.wave}: ${event.ids.join(", ")}`, color);
    case "ultra.subtask.started":
      return dim(`  ▸ ${event.id} ${event.title}`, color);
    case "ultra.subtask.verified":
      if (event.pass) return dim(`  ${event.id} verify ✓`, color);
      return `  ${dangerLine("✗", color)} ${event.id} verify refuted${event.reason ? `: ${event.reason.replace(/\s+/g, " ").slice(0, 80)}` : ""}`;
    case "ultra.subtask.finished":
      if (event.skipped) return dim(`  ${event.id} skipped (dependency failed)`, color);
      if (event.ok) return `  ${orange("✓", color)} ${event.id} ${event.title}`;
      return `  ${dangerLine("✗", color)} ${event.id} ${event.title}`;
    case "ultra.synthesis.started":
      return dim("synthesizing results…", color);
    case "ultra.synthesis":
      return null; // printed as the final answer
    default:
      return null;
  }
}

function renderCodeFooter(inputData: {
  context: CodeContext;
  mode: ChatMode;
  mockBrain: boolean;
  reasoning: ReturnType<typeof parseReasoningOptions>;
  fallbackProvider?: CliProviderProfile;
  usage?: string | null;
}): string {
  const color = supportsColor(output);
  const model = inputData.mockBrain ? "mock Brain" : inputData.fallbackProvider ? `CLI BYOK:${modelLabelWithId(inputData.fallbackProvider.model)}` : "StepFun 3.7 Flash";
  const mode = renderMode(inputData.mode);
  return dim([
    model,
    displayCwd(inputData.context.cwd),
    mode,
    `think ${inputData.reasoning.effort}`,
    inputData.usage,
  ].filter(Boolean).join(" · "), color);
}

function codeRouteLabel(mockBrain: boolean, fallbackProvider?: CliProviderProfile): string {
  if (mockBrain) return t("code.route.mock");
  if (fallbackProvider) return `CLI BYOK: ${modelLabelWithId(fallbackProvider.model)}`;
  return t("code.route.brain");
}
