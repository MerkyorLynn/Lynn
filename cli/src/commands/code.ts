import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline/promises";
import { stdin as input, stdout as output, stderr as errorOutput } from "node:process";
import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { formatBrainRecoveryHint, streamBrainChat, type BrainStreamEvent, type ChatAssistantToolCall, type ChatMessage, type ChatToolDefinition } from "../brain-client.js";
import { formatBrainErrorForHuman, renderBrainEventForHuman, summarizeUsage, type HumanBrainRenderState } from "../brain-render.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { resolveEffectivePermissions } from "../permissions.js";
import { parseReasoningOptions, shouldRenderReasoning } from "../reasoning.js";
import { TerminalSpinner } from "../terminal-spinner.js";
import { bold, dangerLine, dim, green, red, supportsColor } from "../terminal-style.js";
import { renderPatchPreview } from "../diff-format.js";
import { renderMarkdown } from "../markdown.js";
import { HistoryNavigator, appendHistory, historyPath, loadHistory } from "../history.js";
import { completeSlash, normalizeSlashInput } from "../completion.js";
import { readInteractiveLine } from "../interactive-line.js";
import { box, displayCwd, padLine } from "../startup.js";
import { t } from "../i18n.js";
import { resolveCliProviderProfile, type CliProviderProfile } from "../provider-profile.js";
import { modelLabelWithId } from "../provider-presets.js";
import { CLIENT_TOOL_DEFINITIONS, runClientTool } from "../tools/registry.js";
import type { ClientToolName, ClientToolResult, ToolRunContext } from "../tools/types.js";
import { normalizePlanItems, renderPlanItems, type CodePlanItem } from "../plan-tool.js";
import { createGitSnapshot } from "../git-checkpoint.js";
import { applyModeCommand, applyReasoningCommand, buildChatProviderArgs, renderMode, shouldRefreshProviderRoute, shouldShowProviderSetUsage, toggleMode, type ChatMode } from "./chat.js";
import { renderBrainModelChoices, renderProvidersInfo, resolveProvidersInfo, runProviders } from "./providers.js";
import { readVersionInfo } from "../version.js";
import { buildImagesContentParts, parseImageList } from "../media.js";
import { appendSessionLine, appendSessionMetadata, appendSessionTurn, latestSessionPath, listSessions, readSessionLines, readSessionLinesResult, resolveDataDir } from "../session/store.js";
import { buildMemoryContextFrameSync } from "../session/memory.js";
import { buildCodeContextMessages, computeCodeContextLayerDiagnostics } from "../context-layers.js";
import { renderToolLedger, toolLedgerEntry, type ToolLedgerEntry } from "../tool-ledger.js";
import { prepareCodeTaskInput } from "../code-input.js";
import type { RuntimeInstructionFrame } from "../../../shared/runtime-instruction-frames.js";
import { resolveDefaultBrainUrl } from "../brain-url.js";

const pExecFile = promisify(execFile);

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

  const tool = getStringFlag(args.flags, "tool") as ClientToolName | null;
  if (!tool) {
    const task = codeTaskPrompt(args);
    if (task) return runCodeTask(args, task, json);
    if (!json && input.isTTY && output.isTTY) {
      if (process.env.LYNN_CLI_LEGACY_TUI !== "1" && !hasFlag(args.flags, "no-ink", "legacy-tui")) {
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
  const toolApproval = await resolveToolApproval({
    tool,
    approval: toolMode.approval,
    cwd: toolCwd,
    json,
    input,
    output: errorOutput,
    preview: formatDangerousToolPreview(tool, {
      path: getStringFlag(args.flags, "path") || undefined,
      text: getStringFlag(args.flags, "text", "content") || args.positionals.join(" ") || undefined,
      command: getStringFlag(args.flags, "command") || args.positionals.join(" ") || undefined,
    }, supportsColor(errorOutput)),
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

export function renderCodeHeadlessHelp(): string {
  const version = readVersionInfo().version || "0.80.0";
  return [
    "Lynn code headless / CLI Fleet",
    "",
    "用途:",
    "  - 给人用: Lynn code",
    "  - 给其他智能体 / CI / GUI Fleet 用: Lynn code -p \"任务\" --json --cwd /repo",
    "",
    "安装(Node.js 20 LTS 或 22 LTS + npm):",
    `  npm install -g --force https://download.merkyorlynn.com/downloads/cli/lynn-cli-${version}.tgz`,
    "",
    "静默调用(处理完直接退出,不进入 TUI):",
    "  Lynn code -p \"review the current diff\" --json --cwd /repo",
    "  Lynn code -p \"fix tests, run the suite, summarize the diff\" \\",
    "    --json --cwd /worktree --approval yolo --sandbox workspace-write --save-session",
    "",
    "长任务/断点续跑:",
    "  Lynn code -p \"complete the migration until tests pass\" \\",
    "    --json --cwd /worktree --approval yolo --sandbox workspace-write \\",
    "    --long --max-steps 1000 --save-session",
    "  Lynn code --resume <session.jsonl> -p \"continue\" --json --long",
    "",
    "GUI Fleet worker(JSONL 事件流):",
    "  Lynn worker run --brief task.md --worktree /worktree \\",
    "    --jsonl --approval yolo --sandbox workspace-write",
    "  Lynn worker run --brief task.md --worktree /worktree \\",
    "    --agent custom --agent-command \"your-cli --json\" --jsonl",
    "",
    "规则:",
    "  - 自动化调用只解析 --json / --jsonl,不要解析人类 TUI。",
    "  - 总是传 --cwd 或 --worktree。",
    "  - --approval yolo 只用于隔离 git worktree;它表示零逐条审批。",
    "  - code.tool.ledger 是链式工具结果的 source-of-truth。",
    "  - code.task.finished.resumeCommand 存在时,按它继续。",
  ].join("\n");
}

async function runCodeInteractive(args: ParsedArgs): Promise<number> {
  const mode = await resolveCodeMode(args);
  let reasoning = parseReasoningOptions(args);
  let cliProvider = await resolveCliProviderProfile(args);
  output.write(renderCodeIntro(mode, reasoning, { color: supportsColor(output), modelLabel: codeRouteLabel(false, cliProvider?.profile) }));
  const histFile = historyPath();
  const history = loadHistory(histFile);
  const slashCommands = [
    "/exit",
    "/quit",
    "/help",
    "/tools",
    "/fast",
    "/think",
    "/reasoning",
    "/goal",
    "/resume",
    "/continue",
    "/yolo",
    "/ask",
    "/mode",
    "/model",
    "/model mimo",
    "/model stepfun",
    "/model spark",
    "/setup",
    "/byok",
    "/providers",
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
      history.push(text);
      appendHistory(text, histFile);
      if (text === "/exit" || text === "/quit") break;
      if (text === "/help") {
        output.write(`${t("code.help")}\n\n`);
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
  const modeLabel = dangerous ? red(renderMode(mode), color) : renderMode(mode);
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

interface ToolApprovalRequest {
  tool: ClientToolName;
  approval: "ask" | "on-failure" | "never" | "yolo";
  cwd: string;
  json: boolean;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  preview?: string;
  session?: { approveAll: boolean };
}

class ToolApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolApprovalRequiredError";
  }
}

export function isDangerousClientTool(tool: ClientToolName): boolean {
  return !!CLIENT_TOOL_DEFINITIONS.find((definition) => definition.name === tool)?.dangerous;
}

export function canPromptForDangerousTool(inputStream: Pick<NodeJS.ReadStream, "isTTY">, outputStream: Pick<NodeJS.WriteStream, "isTTY">, json: boolean): boolean {
  return !json && !!inputStream.isTTY && !!outputStream.isTTY;
}

async function resolveToolApproval(request: ToolApprovalRequest): Promise<ToolApprovalRequest["approval"]> {
  if (!isDangerousClientTool(request.tool)) return request.approval;
  if (request.approval === "yolo" || request.approval === "on-failure" || request.session?.approveAll) return "yolo";
  if (request.approval === "never") {
    throw new Error(`${request.tool} requires approval; current mode is never`);
  }
  if (!canPromptForDangerousTool(request.input, request.output, request.json)) {
    throw new ToolApprovalRequiredError(`${request.tool} requires --approval yolo or an interactive confirmation`);
  }
  const rl = readline.createInterface({ input: request.input, output: request.output, terminal: true });
  try {
    if (request.preview) request.output.write(`${request.preview}\n`);
    const answer = (await rl.question(t("approval.prompt", { tool: request.tool, cwd: request.cwd }))).trim().toLowerCase();
    if (answer === "a" || answer === "always") {
      if (request.session) request.session.approveAll = true;
      return "yolo";
    }
    if (/^(y|yes)$/.test(answer)) return "yolo";
    throw new Error(`${request.tool} cancelled by user`);
  } finally {
    rl.close();
  }
}

interface CodeContext {
  cwd: string;
  gitStatus: string;
  gitDiffStat: string;
  topFiles: string[];
  packageScripts: Record<string, string>;
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
    if (resumePlan.length) errorOutput.write(`${renderPlanItems(resumePlan)}\n`);
    if (resumeInfo?.cwd && path.resolve(resumeInfo.cwd) !== path.resolve(context.cwd)) {
      errorOutput.write(`${t("code.resume.cwdDrift", { saved: resumeInfo.cwd, current: context.cwd })}\n`);
    }
    if (resumeInfo?.gitSnapshot) {
      errorOutput.write(`${t("code.resume.snapshot", { sha: resumeInfo.gitSnapshot.slice(0, 12) })}\n`);
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
    if (resumePath) writeJsonLine({ type: "session.resumed", ts: nowIso(), path: resumePath, messages: resumeMessages.length, repairedTools: resumeDiag?.repairedTools ?? 0, compacted: resumeDiag?.compacted ?? false, tornLines: resumeDiag?.tornLines ?? 0, plan: resumePlan, gitSnapshot: resumeInfo?.gitSnapshot ?? null });
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
  let savedSessionPath: string | null = null;
  if (saveSession) {
    liveSessionPath = await appendSessionLine({
      dataDir,
      sessionPath: liveSessionPath,
      cwd: context.cwd,
      title,
      line: { type: "user", content: taskText },
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
    onEvent: options.onEvent,
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
    // Pair the conversation checkpoint with a non-destructive snapshot of the
    // working tree, so a paused/continued task can also restore its files.
    const fileSnapshot = await createGitSnapshot(context.cwd);
    if (fileSnapshot) {
      if (json) writeJsonLine({ type: "session.snapshot", ts: nowIso(), sha: fileSnapshot.sha, dirtyFiles: fileSnapshot.dirtyFiles });
      else if (!options.onEvent && !options.compact) errorOutput.write(`${t("code.snapshot.saved", { sha: fileSnapshot.sha.slice(0, 12), files: fileSnapshot.dirtyFiles })}\n`);
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
        gitSnapshot: fileSnapshot?.sha ?? null,
        gitSnapshotFiles: fileSnapshot?.dirtyFiles ?? 0,
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

export function resumeCommandForSession(sessionPath: string): string {
  return `Lynn code --resume ${shellQuote(sessionPath)} --long "继续这个任务"`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function resolveCodeResumePath(raw: string | null, dataDir: string): Promise<string | null> {
  if (!raw) return null;
  const value = raw.trim();
  if (value === "last" || value === "latest") {
    const latest = await latestSessionPath(dataDir);
    if (!latest) throw new Error("No CLI session found to resume. Run a human code task or pass --save-session first.");
    return latest;
  }
  return value;
}

function shouldSaveCodeSession(args: ParsedArgs, inputData: { json: boolean; mockBrain: boolean; resumePath: string | null }): boolean {
  if (hasFlag(args.flags, "no-save-session", "no-session")) return false;
  if (hasFlag(args.flags, "save-session", "session")) return true;
  const env = process.env.LYNN_CLI_SAVE_SESSION?.trim().toLowerCase();
  if (env === "0" || env === "false" || env === "off" || env === "no") return false;
  if (env) return true;
  if (inputData.resumePath) return true;
  // Human code turns should be recoverable by default, like Codex/Claude Code.
  // JSON/scripted and mock smoke paths stay side-effect-light unless explicitly opted in.
  return !inputData.json && !inputData.mockBrain;
}

function renderAssistantBlock(text: string, footer?: string): string {
  const lines = text.replace(/\s+$/g, "").split(/\r?\n/);
  const body = lines.map((line, index) => `${index === 0 ? "• " : "  "}${line}`).join("\n");
  return `${body}${footer ? `\n\n${footer}` : ""}\n`;
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
  const model = inputData.mockBrain ? "mock Brain" : inputData.fallbackProvider ? `CLI BYOK:${modelLabelWithId(inputData.fallbackProvider.model)}` : "StepFun 3.7 Flash→MiMo V2.5 Pro";
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

interface CodeAgentLoopInput {
  task: string;
  context: CodeContext;
  brainUrl: string;
  fallbackProvider?: CliProviderProfile;
  reasoning: ReturnType<typeof parseReasoningOptions>;
  json: boolean;
  maxSteps: number;
  toolCtx: ToolRunContext;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  imagePaths?: string[];
  resumeMessages?: ChatMessage[];
  memoryFrame?: string;
  onCheckpoint?: (line: { type: "user" | "assistant" | "tool"; content: string; data?: Record<string, unknown> }) => Promise<void>;
  onEvent?: (event: CodeAgentEvent) => void;
  requestApproval?: (request: CodeAgentApprovalRequest) => Promise<"approve" | "approve_all" | "deny">;
}

export interface CodeAgentApprovalRequest {
  tool: ClientToolName;
  args: CodeToolRequest["args"];
  cwd: string;
  preview?: string;
}

export type CodeAgentEvent =
  | { type: "step.started"; step: number; label: string }
  | { type: "provider"; provider: string }
  | { type: "usage"; summary: string }
  | { type: "reasoning.delta"; text: string }
  | { type: "assistant.delta"; text: string }
  | { type: "tool.progress"; message: string }
  | { type: "tool.requested"; tool: ClientToolName; args: CodeToolRequest["args"]; preview?: string }
  | { type: "tool.result"; result: ClientToolResult }
  | { type: "tool.ledger"; text: string }
  | { type: "tool.loop_guard"; tool: ClientToolName; repeats: number }
  | { type: "plan.updated"; items: CodePlanItem[] }
  | { type: "session.resumed"; path: string; messages: number }
  | { type: "session.checkpoint"; path: string; line: "user" | "assistant" | "tool" }
  | { type: "session.saved"; path: string }
  | { type: "task.finished"; ok: boolean; text: string; usageSummary: string | null; maxStepsReached?: boolean; resumeCommand?: string; sessionPath?: string | null }
  | { type: "error"; message: string };

interface CodeToolRequest {
  toolCallId?: string;
  toolCallName?: string;
  toolCallArguments?: string;
  tool: ClientToolName;
  args: {
    path?: string;
    text?: string;
    query?: string;
    pattern?: string;
    command?: string;
    maxBytes?: number;
    offset?: number;
    plan?: unknown;
  };
}

interface CodeAgentLoopResult {
  text: string;
  maxStepsReached: boolean;
  usageSummary: string | null;
  usageRecords: Array<{ usage: unknown; durationMs: number }>;
}

interface CollectedToolCall {
  id?: string;
  name?: string;
  arguments: string;
}

interface ClientToolStormState {
  recent: Array<{ fingerprint: string; readOnly: boolean }>;
}

interface ClientToolStormVerdict {
  suppress: boolean;
  repeatCount: number;
}

const TOOL_STORM_WINDOW = 8;

function createClientToolStormState(): ClientToolStormState {
  return { recent: [] };
}

function isReadOnlyToolRequest(request: CodeToolRequest): boolean {
  return request.tool === "read_file" || request.tool === "grep" || request.tool === "glob";
}

function observeClientToolRequest(state: ClientToolStormState, request: CodeToolRequest): ClientToolStormVerdict {
  if (request.tool === "update_plan") return { suppress: false, repeatCount: 1 };
  const readOnly = isReadOnlyToolRequest(request);
  if (!readOnly) {
    state.recent = state.recent.filter((entry) => !entry.readOnly);
  }
  const fingerprint = toolRequestFingerprint(request);
  const previous = state.recent.filter((entry) => entry.fingerprint === fingerprint).length;
  if (previous > 0) {
    return { suppress: true, repeatCount: previous + 1 };
  }
  state.recent.push({ fingerprint, readOnly });
  if (state.recent.length > TOOL_STORM_WINDOW) {
    state.recent.splice(0, state.recent.length - TOOL_STORM_WINDOW);
  }
  return { suppress: false, repeatCount: 1 };
}

async function runCodeAgentLoop(inputData: CodeAgentLoopInput): Promise<CodeAgentLoopResult> {
  const frames = buildCodeRuntimeFrames(inputData);
  const initialPrompt = buildCodePrompt(inputData.task, inputData.context, inputData.imagePaths);
  const initialContent = inputData.imagePaths?.length
    ? await buildImagesContentParts(inputData.imagePaths, initialPrompt)
    : initialPrompt;
  const { messages } = buildCodeContextMessages({
    frames,
    resumeMessages: inputData.resumeMessages,
    currentUserContent: initialContent,
  });
  let finalText = "";
  let latestUsageSummary: string | null = null;
  const usageRecords: Array<{ usage: unknown; durationMs: number }> = [];
  const approvalSession = { approveAll: false };
  const toolStorm = createClientToolStormState();
  for (let step = 0; step < inputData.maxSteps; step += 1) {
    const label = step === 0 ? t("spinner.coding") : t("spinner.reviewing");
    inputData.onEvent?.({ type: "step.started", step, label });
    const result = await collectBrainText({
      brainUrl: inputData.brainUrl,
      fallbackProvider: inputData.fallbackProvider,
      messages,
      reasoning: inputData.reasoning,
      json: inputData.json,
      label,
      onEvent: inputData.onEvent,
    });
    const assistantText = result.text;
    latestUsageSummary = result.usageSummary || latestUsageSummary;
    usageRecords.push(...result.usageRecords);
    const structuredToolRequests = toolRequestsFromCollectedCalls(result.toolCalls, step);
    const toolRequests = structuredToolRequests.length ? structuredToolRequests : parseCodeToolRequests(assistantText);
    messages.push(structuredToolRequests.length
      ? {
          role: "assistant",
          content: assistantText,
          tool_calls: assistantToolCallsForMessages(structuredToolRequests),
        }
      : { role: "assistant", content: assistantText });
    if (inputData.onCheckpoint) {
      if (structuredToolRequests.length) {
        await inputData.onCheckpoint({
          type: "assistant",
          content: assistantText,
          data: { tool_calls: assistantToolCallsForMessages(structuredToolRequests) },
        });
      } else if (assistantText.trim()) {
        await inputData.onCheckpoint({ type: "assistant", content: assistantText });
      }
    }
    if (!toolRequests.length) {
      finalText = assistantText;
      break;
    }
    const toolResultSections: string[] = [];
    const toolLedgerEntries: ToolLedgerEntry[] = [];
    for (const toolRequest of toolRequests) {
      const stormVerdict = observeClientToolRequest(toolStorm, toolRequest);
      if (inputData.json) writeJsonLine({ type: "code.tool.requested", ts: nowIso(), tool: toolRequest.tool, args: redactToolArgs(toolRequest) });
      const preview = formatDangerousToolPreview(toolRequest.tool, toolRequest.args, supportsColor(inputData.output));
      inputData.onEvent?.({ type: "tool.requested", tool: toolRequest.tool, args: redactToolArgs(toolRequest) as CodeToolRequest["args"], preview });
      if (!inputData.json && !inputData.onEvent && toolRequest.tool !== "update_plan") renderClientToolStart(toolRequest);
      let toolResult: ClientToolResult;
      if (stormVerdict.suppress) {
        toolResult = {
          ok: false,
          tool: toolRequest.tool,
          error: "Repeated identical tool request suppressed by Lynn CLI. Use a different tool, different arguments, or answer with the information already available.",
        };
        if (inputData.json) {
          writeJsonLine({ type: "code.tool.loop_guard", ts: nowIso(), tool: toolRequest.tool, args: redactToolArgs(toolRequest), repeats: stormVerdict.repeatCount });
        }
        inputData.onEvent?.({ type: "tool.loop_guard", tool: toolRequest.tool, repeats: stormVerdict.repeatCount });
      } else {
        try {
          let effectiveApproval: ToolApprovalRequest["approval"];
          if (
            inputData.requestApproval &&
            isDangerousClientTool(toolRequest.tool) &&
            inputData.toolCtx.approval === "ask" &&
            !approvalSession.approveAll
          ) {
            const decision = await inputData.requestApproval({
              tool: toolRequest.tool,
              args: redactToolArgs(toolRequest) as CodeToolRequest["args"],
              cwd: inputData.toolCtx.cwd,
              preview,
            });
            if (decision === "deny") throw new Error(`${toolRequest.tool} cancelled by user`);
            if (decision === "approve_all") approvalSession.approveAll = true;
            effectiveApproval = "yolo";
          } else {
            effectiveApproval = await resolveToolApproval({
              tool: toolRequest.tool,
              approval: inputData.toolCtx.approval,
              cwd: inputData.toolCtx.cwd,
              json: inputData.json,
              input: inputData.input,
              output: inputData.output,
              preview,
              session: approvalSession,
            });
          }
          toolResult = await runClientTool({ ...inputData.toolCtx, approval: effectiveApproval }, {
            name: toolRequest.tool,
            ...toolRequest.args,
          });
        } catch (error) {
          if (inputData.json && error instanceof ToolApprovalRequiredError) {
            writeJsonLine({
              type: "code.tool.approval_required",
              ts: nowIso(),
              status: "waiting_approval",
              tool: toolRequest.tool,
              args: redactToolArgs(toolRequest),
              approval: inputData.toolCtx.approval,
              sandbox: inputData.toolCtx.sandbox || "workspace-write",
              message: error.message,
            });
          }
          toolResult = {
            ok: false,
            tool: toolRequest.tool,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      if (toolRequest.tool === "update_plan") {
        const items = normalizePlanItems(toolRequest.args.plan);
        if (inputData.json) writeJsonLine({ type: "code.plan.updated", ts: nowIso(), items });
        inputData.onEvent?.({ type: "plan.updated", items });
        if (!inputData.json && !inputData.onEvent) process.stderr.write(`${renderPlanItems(items)}\n`);
      }
      if (inputData.json) writeJsonLine({ type: "code.tool.result", ts: nowIso(), ...toolResult });
      inputData.onEvent?.({ type: "tool.result", result: toolResult });
      if (!inputData.json && !inputData.onEvent && toolRequest.tool !== "update_plan") renderClientToolResult(toolResult);
      toolLedgerEntries.push(toolLedgerEntry(toolResult));
      toolResultSections.push([
        `Tool result for ${toolRequest.tool}:`,
        formatToolResultForLoop(toolResult),
      ].join("\n"));
    }
    const toolLedger = renderToolLedger(toolLedgerEntries, step);
    if (toolLedger) {
      if (inputData.json) writeJsonLine({ type: "code.tool.ledger", ts: nowIso(), step, text: toolLedger });
      inputData.onEvent?.({ type: "tool.ledger", text: toolLedger });
    }
    if (structuredToolRequests.length) {
      for (let i = 0; i < structuredToolRequests.length; i += 1) {
        const request = structuredToolRequests[i];
        const section = toolResultSections[i] || `Tool result for ${request.tool}:\n(no result captured)`;
        messages.push({
          role: "tool",
          tool_call_id: request.toolCallId,
          name: request.tool,
          content: section,
        });
        if (inputData.onCheckpoint) {
          await inputData.onCheckpoint({
            type: "tool",
            content: section,
            data: {
              tool_call_id: request.toolCallId,
              name: request.tool,
            },
          });
        }
      }
      if (toolLedger) {
        const ledgerMessage = [
          toolLedger,
          "Continue from the ledger. If no more tools are needed, give the final answer.",
        ].join("\n");
        messages.push({ role: "user", content: ledgerMessage });
        if (inputData.onCheckpoint) await inputData.onCheckpoint({ type: "user", content: ledgerMessage });
      }
    } else {
      const toolResultMessage = [
        toolResultSections.length === 1 ? "Tool results:" : `Tool results for ${toolResultSections.length} requested tools:`,
        ...toolResultSections,
        toolLedger,
        "Continue. If no more tools are needed, give the final answer.",
      ].filter(Boolean).join("\n");
      messages.push({
        role: "user",
        content: toolResultMessage,
      });
      if (inputData.onCheckpoint) await inputData.onCheckpoint({ type: "user", content: toolResultMessage });
    }
  }
  let maxStepsReached = false;
  if (!finalText) {
    maxStepsReached = true;
    finalText = "Stopped after the maximum tool steps. Review the emitted tool results before continuing.";
  }
  return {
    text: finalText,
    maxStepsReached,
    usageSummary: latestUsageSummary,
    usageRecords,
  };
}

/** Marker embedded in a synthesized tool result when a tool call was interrupted before resume. */
export const RESUME_REPAIR_NOTE = "this tool did not finish — the task was interrupted before resume";
/** Marker embedded in the resume prefix when older transcript turns were dropped to fit the budget. */
export const RESUME_COMPACTION_NOTE = "Earlier transcript turns were compacted to keep the continuation stable";
/** Marker embedded when the JSONL reader skipped crash-torn lines while loading the session. */
export const RESUME_TORN_NOTE = "some transcript lines were unreadable (likely a crash mid-write) and were skipped";

export interface ResumeDiagnostics {
  messages: number;
  repairedTools: number;
  compacted: boolean;
  tornLines: number;
}

/**
 * Inspect the messages produced by {@link loadResumeMessages} and report what the
 * frame-restoration pass had to do: how many interrupted tool calls were repaired
 * with a placeholder, and whether older turns were compacted away. Surfaced to the
 * user (and the JSON event stream) so a resumed long task is transparent, not silent.
 */
export function summarizeResumeMessages(messages: ChatMessage[]): ResumeDiagnostics {
  let repairedTools = 0;
  let compacted = false;
  let tornLines = 0;
  for (const message of messages) {
    if (typeof message.content !== "string") continue;
    if (message.role === "tool" && message.content.includes(RESUME_REPAIR_NOTE)) {
      repairedTools += 1;
    } else if (message.role === "user") {
      if (message.content.includes(RESUME_COMPACTION_NOTE)) compacted = true;
      const torn = /torn-lines=(\d+)/.exec(message.content);
      if (torn) tornLines = Number(torn[1]);
    }
  }
  return { messages: messages.length, repairedTools, compacted, tornLines };
}

/**
 * Recover the most recent plan/todo state from resumed messages. The plan lives in
 * update_plan tool calls (already persisted as assistant tool_calls), so the latest
 * one reconstructs the ✓●○ checklist — letting resume show "where the task was",
 * not just how many messages it had.
 */
export function extractLatestPlan(messages: ChatMessage[]): CodePlanItem[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;
    for (let j = message.tool_calls.length - 1; j >= 0; j -= 1) {
      const call = message.tool_calls[j];
      if (call.function?.name !== "update_plan") continue;
      try {
        const items = normalizePlanItems(JSON.parse(call.function.arguments || "{}"));
        if (items.length) return items;
      } catch {
        // malformed plan args — keep scanning older calls
      }
    }
  }
  return [];
}

/** Collapse a saved prompt to a single tidy line for the resume header. */
export function truncateForResume(text: string, max = 72): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export interface ResumeSessionInfo {
  cwd: string | null;
  gitSnapshot: string | null;
  firstPrompt: string | null;
}

/**
 * Read the session's persisted metadata (cwd + git snapshot) and original prompt,
 * for the resume header: confirming WHICH task was picked, warning on cwd drift,
 * and surfacing a restorable file snapshot. Uses the crash-tolerant reader.
 */
export async function readResumeSessionInfo(sessionPath: string): Promise<ResumeSessionInfo> {
  const { lines } = await readSessionLinesResult(sessionPath);
  let cwd: string | null = null;
  let gitSnapshot: string | null = null;
  let firstPrompt: string | null = null;
  for (const line of lines) {
    if (line.type === "metadata" && line.data) {
      if (typeof line.data.cwd === "string") cwd = line.data.cwd;
      if (typeof line.data.gitSnapshot === "string") gitSnapshot = line.data.gitSnapshot;
    } else if (!firstPrompt && line.type === "user" && typeof line.content === "string" && line.content.trim()) {
      firstPrompt = line.content.trim();
    }
  }
  return { cwd, gitSnapshot, firstPrompt };
}

export async function loadResumeMessages(sessionPath: string, maxChars = 24_000): Promise<ChatMessage[]> {
  const { lines, skipped } = await readSessionLinesResult(sessionPath);
  const turns = lines
    .flatMap((line): ChatMessage[] => {
      if (line.type === "user" && typeof line.content === "string" && line.content.trim()) {
        return [{ role: "user", content: line.content }];
      }
      if (line.type === "assistant") {
        const toolCalls = sessionToolCalls(line.data?.tool_calls);
        const content = typeof line.content === "string" ? line.content : "";
        if (!content.trim() && !toolCalls.length) return [];
        return [{
          role: "assistant",
          content,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        }];
      }
      if (line.type === "tool" && typeof line.content === "string" && line.content.trim()) {
        const toolCallId = typeof line.data?.tool_call_id === "string" ? line.data.tool_call_id : "";
        const name = typeof line.data?.name === "string" ? line.data.name : undefined;
        if (!toolCallId) return [];
        return [{ role: "tool", tool_call_id: toolCallId, name, content: line.content }];
      }
      return [];
    });
  const groups = buildResumableMessageGroups(turns);
  const selected: ChatMessage[] = [];
  let chars = 0;
  let firstIncluded = groups.length; // index of the oldest group that fit the budget
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i];
    const len = group.reduce((sum, turn) => sum + resumeMessageCost(turn), 0);
    if (selected.length && chars + len > maxChars) break;
    selected.unshift(...group);
    chars += len;
    firstIncluded = i;
  }
  const droppedGroups = firstIncluded; // groups[0..firstIncluded-1] didn't fit
  if (droppedGroups > 0) {
    // Compaction note explains the gap, sitting just before the recent window...
    selected.unshift({
      role: "user",
      content: `[Lynn CLI resumed this coding task from ${sessionPath}. ${RESUME_COMPACTION_NOTE}: ${droppedGroups} earlier turn group(s) dropped — the original task above is pinned. Ask the user or inspect files if missing details matter.]`,
    });
    // ...and the original task (groups[0]) is pinned at the very front so a long
    // task never loses sight of its own goal, no matter how much history is trimmed.
    if (groups.length > 0) selected.unshift(...groups[0]);
  }
  if (skipped > 0) {
    selected.unshift({
      role: "user",
      content: `[Lynn CLI torn-lines=${skipped}: ${RESUME_TORN_NOTE}. Earlier history may have gaps — inspect files or ask the user if a detail seems missing.]`,
    });
  }
  return selected;
}

export function buildResumableMessageGroups(turns: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (turn.role === "assistant" && turn.tool_calls?.length) {
      const required = new Set(turn.tool_calls.map((toolCall) => toolCall.id));
      const found = new Set<string>();
      const tools: ChatMessage[] = [];
      let j = i + 1;
      while (j < turns.length) {
        const candidate = turns[j];
        if (candidate.role !== "tool" || !candidate.tool_call_id || !required.has(candidate.tool_call_id)) break;
        tools.push(candidate);
        found.add(candidate.tool_call_id);
        j += 1;
        if (found.size === required.size) break;
      }
      if (found.size === required.size) {
        groups.push([turn, ...tools]);
      } else {
        // Interrupted mid-tool: keep the assistant turn + whatever results DID
        // complete, and synthesize a placeholder for each missing tool_call so
        // the resumed sequence stays valid (every tool_call has a matching tool
        // result) instead of dropping the partial work. This is the resume
        // validation / frame restoration step.
        const missing: ChatMessage[] = (turn.tool_calls || [])
          .filter((toolCall) => !found.has(toolCall.id))
          .map((toolCall) => ({
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function?.name,
            content: `Tool result for ${toolCall.function?.name || "tool"}:\n[Lynn CLI: ${RESUME_REPAIR_NOTE}. Re-run it if its result is needed.]`,
          }));
        groups.push([turn, ...tools, ...missing]);
      }
      i = Math.max(i, j - 1);
      continue;
    }
    if (turn.role === "tool") continue;
    groups.push([turn]);
  }
  return groups;
}

function resumeMessageCost(message: ChatMessage): number {
  const contentCost = typeof message.content === "string"
    ? message.content.length
    : JSON.stringify(message.content).length;
  const toolCallCost = message.tool_calls?.length ? JSON.stringify(message.tool_calls).length : 0;
  return contentCost + toolCallCost;
}

function sessionToolCalls(value: unknown): ChatAssistantToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is ChatAssistantToolCall => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const record = entry as Record<string, unknown>;
    const fn = record.function;
    return typeof record.id === "string"
      && record.type === "function"
      && !!fn
      && typeof fn === "object"
      && !Array.isArray(fn)
      && typeof (fn as Record<string, unknown>).name === "string"
      && typeof (fn as Record<string, unknown>).arguments === "string";
  });
}

export function formatToolResultForLoop(result: ClientToolResult, maxChars = 12_000): string {
  const json = JSON.stringify(result, null, 2);
  if (json.length <= maxChars) return json;
  return [
    json.slice(0, maxChars),
    "",
    `[Lynn CLI truncated this tool result from ${json.length} chars to ${maxChars} chars to keep the long-running coding loop stable. Use a narrower grep/read_file request if more detail is needed.]`,
  ].join("\n");
}

export function buildCodeRuntimeFrames(inputData: Pick<CodeAgentLoopInput, "context" | "toolCtx" | "memoryFrame">): RuntimeInstructionFrame[] {
  return [
    {
      kind: "base_system",
      source: "cli",
      text: [
        "You are Lynn CLI code mode.",
        "The default online route is StepFun 3.7 Flash high+32K first through the local Lynn Brain router, MiMo V2.5 Pro second for multimodal/native-search fallback, and Spark Qwen 3.6 35B A3B third as local fallback.",
        "StepFun 3.7 Flash is the text/coding head route. MiMo V2.5 Pro owns image/audio/video and native search fallback. Keep responses in the user's language.",
        "You help with repository-level coding tasks from the terminal.",
        "You may request local tools using exactly one JSON object and no prose:",
        '{"tool":"update_plan|read_file|grep|glob|apply_patch|bash|write_file","args":{...}}',
        "For non-trivial tasks, first call update_plan/TodoWrite with items and statuses pending/in_progress/completed, then update it as work progresses.",
        "Prefer read_file, grep, and glob before editing. Use apply_patch for edits when possible.",
        "For chained tool work, treat the latest <lynn_tool_ledger> as source-of-truth: carry exact values, paths, exit codes, and snippets forward instead of relying on memory.",
        "When you are done, answer normally with a concise summary and tests run.",
        "Do not claim you edited files unless a tool actually changed them.",
        "Never download models, datasets, training packs, BF16, or GGUF files to the local Mac.",
      ].join("\n"),
    },
    {
      kind: "cacheable_context",
      source: "cli",
      title: "Repository context",
      text: `Repository root: ${inputData.context.cwd}`,
    },
    ...(inputData.memoryFrame ? [{
      kind: "cacheable_context" as const,
      source: "cli",
      title: "Durable memory",
      text: inputData.memoryFrame,
    }] : []),
    {
      kind: "permission_state",
      source: "cli",
      title: "Current tool permissions",
      text: `approval=${inputData.toolCtx.approval} sandbox=${inputData.toolCtx.sandbox || "workspace-write"}`,
      stable: false,
      cacheable: false,
    },
    {
      kind: "tool_guard",
      source: "cli",
      title: "Local tool guard",
      text: "Local tools can read and edit only inside the current workspace. Dangerous tools require approval unless approval mode is yolo or on-failure.",
      stable: false,
      cacheable: false,
    },
  ];
}

function toolRequestFingerprint(request: CodeToolRequest): string {
  return JSON.stringify({
    tool: request.tool,
    args: stableObject(request.args as Record<string, unknown>),
  });
}

function stableObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, v && typeof v === "object" && !Array.isArray(v) ? stableObject(v as Record<string, unknown>) : v]),
  );
}

interface BrainTextResult {
  text: string;
  usageSummary: string | null;
  usageRecords: Array<{ usage: unknown; durationMs: number }>;
  toolCalls: CollectedToolCall[];
}

async function collectBrainText(inputData: {
  brainUrl: string;
  fallbackProvider?: CliProviderProfile;
  messages: ChatMessage[];
  reasoning: ReturnType<typeof parseReasoningOptions>;
  json: boolean;
  label: string;
  onEvent?: (event: CodeAgentEvent) => void;
}): Promise<BrainTextResult> {
  let text = "";
  let usageSummary: string | null = null;
  const usageRecords: Array<{ usage: unknown; durationMs: number }> = [];
  const streamedToolCalls = createStreamingToolCallAccumulator();
  const spinner = new TerminalSpinner(process.stderr, inputData.label);
  const renderState: HumanBrainRenderState = {};
  const startedAt = Date.now();
  if (!inputData.json && !inputData.onEvent) spinner.start();
  try {
    for await (const event of streamBrainChat({
      brainUrl: inputData.brainUrl,
      reasoning: inputData.reasoning,
      messages: inputData.messages,
      fallbackProvider: inputData.fallbackProvider,
      tools: codeToolDefinitions(),
    })) {
      const renderReasoning = shouldRenderReasoning(inputData.reasoning.display, inputData.json);
      if (event.type === "assistant.delta" || (event.type === "reasoning.delta" && renderReasoning)) {
        spinner.stop();
      }
      if (event.type === "reasoning.delta" && renderReasoning) {
        inputData.onEvent?.({ type: "reasoning.delta", text: event.text });
        if (!inputData.onEvent) {
          if (inputData.json) writeJsonLine({ type: "reasoning.delta", ts: nowIso(), text: event.text, hidden: true });
          else process.stderr.write(dim(event.text, supportsColor(process.stderr)));
        }
      }
      if (event.type === "assistant.delta") {
        text += event.text;
        inputData.onEvent?.({ type: "assistant.delta", text: event.text });
      }
      if (event.type === "tool_call.delta") streamedToolCalls.append(event);
      if (event.type === "provider") inputData.onEvent?.({ type: "provider", provider: event.activeProvider });
      if (event.type === "tool_progress") inputData.onEvent?.({ type: "tool.progress", message: [event.name, event.event].filter(Boolean).join(" ") });
      if (event.type === "usage") usageRecords.push({ usage: event.usage, durationMs: Date.now() - startedAt });
      if (inputData.json && (event.type === "provider" || event.type === "tool_progress" || event.type === "brain.error" || event.type === "usage")) {
        if (event.type === "usage") writeJsonLine({ type: "usage", ts: nowIso(), usage: event.usage, durationMs: Date.now() - startedAt });
        else writeJsonLine({ ...event, ts: nowIso() });
      }
      if (event.type === "brain.error") {
        throw new Error(formatBrainErrorForHuman(event.error, event.code));
      }
      if (!inputData.json && event.type !== "assistant.delta" && event.type !== "reasoning.delta") {
        if (event.type === "usage") {
          const summary = summarizeUsage(event.usage, { durationMs: Date.now() - startedAt });
          usageSummary = summary || usageSummary;
          if (summary) {
            inputData.onEvent?.({ type: "usage", summary });
            if (!inputData.onEvent) process.stderr.write(`usage: ${summary}\n`);
          }
        } else {
          if (!inputData.onEvent) renderBrainEventForHuman(event, renderState, process.stderr);
        }
      } else if (inputData.json && event.type === "usage") {
        usageSummary = summarizeUsage(event.usage, { durationMs: Date.now() - startedAt }) || usageSummary;
      } else if (inputData.onEvent && event.type === "usage") {
        const summary = summarizeUsage(event.usage, { durationMs: Date.now() - startedAt });
        usageSummary = summary || usageSummary;
        if (summary) inputData.onEvent({ type: "usage", summary });
      }
    }
  } finally {
    spinner.stop();
  }
  return { text, usageSummary, usageRecords, toolCalls: streamedToolCalls.toToolCalls() };
}

export function codeToolDefinitions(): ChatToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "update_plan",
        description: "Update the visible task plan. Use this before and during multi-step coding work.",
        parameters: objectSchema({
          items: {
            type: "array",
            description: "Plan items in execution order.",
            items: objectSchema({
              id: stringSchema("Optional stable item id, for example S0 or C1."),
              content: stringSchema("Task step description."),
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
                description: "Current state for this step.",
              },
            }, ["content", "status"]),
          },
        }, ["items"]),
      },
    },
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a UTF-8 text file inside the current workspace.",
        parameters: objectSchema({
          path: stringSchema("Workspace-relative file path."),
          maxBytes: numberSchema("Optional maximum bytes to read."),
          offset: numberSchema("Optional byte offset for continuing a previous read."),
        }, ["path"]),
      },
    },
    {
      type: "function",
      function: {
        name: "grep",
        description: "Search files in the workspace for a text or regex query.",
        parameters: objectSchema({
          query: stringSchema("Search query or regular expression."),
          path: stringSchema("Optional workspace-relative directory or file to search."),
        }, ["query"]),
      },
    },
    {
      type: "function",
      function: {
        name: "glob",
        description: "List workspace files matching a glob pattern.",
        parameters: objectSchema({
          pattern: stringSchema("Glob pattern, for example **/*.ts."),
          path: stringSchema("Optional workspace-relative directory to search."),
        }, ["pattern"]),
      },
    },
    {
      type: "function",
      function: {
        name: "apply_patch",
        description: "Apply a patch inside the workspace. Prefer this for edits.",
        parameters: objectSchema({
          text: stringSchema("Patch text. Supports Codex *** Begin Patch format or unified diff."),
        }, ["text"]),
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write a full text file inside the workspace. Use sparingly; prefer apply_patch for edits.",
        parameters: objectSchema({
          path: stringSchema("Workspace-relative file path."),
          text: stringSchema("Full file content to write."),
        }, ["path", "text"]),
      },
    },
    {
      type: "function",
      function: {
        name: "bash",
        description: "Run a shell command in the workspace, usually for tests or inspection.",
        parameters: objectSchema({
          command: stringSchema("Shell command to run."),
        }, ["command"]),
      },
    },
  ];
}

function objectSchema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required,
  };
}

function stringSchema(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function numberSchema(description: string): Record<string, unknown> {
  return { type: "number", description };
}

export function parseCodeToolRequest(text: string): CodeToolRequest | null {
  return parseCodeToolRequests(text)[0] ?? null;
}

export function parseCodeToolRequests(text: string): CodeToolRequest[] {
  const requests: CodeToolRequest[] = [];
  const seen = new Set<string>();
  for (const candidate of extractJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      for (const payload of toolPayloadCandidates(parsed)) {
        const request = normalizeToolPayload(payload);
        if (!request) continue;
        const fingerprint = toolRequestFingerprint(request);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        requests.push(request);
      }
    } catch {
      // Try the next candidate.
    }
  }
  return requests;
}

export interface StreamingToolCallAccumulator {
  append(event: Extract<BrainStreamEvent, { type: "tool_call.delta" }>): void;
  toJsonText(): string;
  toToolCalls(): CollectedToolCall[];
  hasCalls(): boolean;
}

export function createStreamingToolCallAccumulator(): StreamingToolCallAccumulator {
  const calls = new Map<number, { id?: string; name?: string; arguments: string }>();
  return {
    append(event) {
      const current = calls.get(event.index) || { arguments: "" };
      calls.set(event.index, {
        id: event.id || current.id,
        name: event.name || current.name,
        arguments: current.arguments + (event.arguments || ""),
      });
    },
    hasCalls() {
      return calls.size > 0;
    },
    toJsonText() {
      if (!calls.size) return "";
      return JSON.stringify({
        tool_calls: this.toToolCalls().map((call, index) => ({
          index,
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: call.arguments,
          },
        })),
      });
    },
    toToolCalls() {
      return [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => ({ id: call.id, name: call.name, arguments: call.arguments }));
    },
  };
}

function toolRequestsFromCollectedCalls(calls: readonly CollectedToolCall[], step: number): CodeToolRequest[] {
  const requests: CodeToolRequest[] = [];
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i];
    const request = normalizeToolPayload({ name: call.name, arguments: call.arguments });
    if (!request) continue;
    requests.push({
      ...request,
      toolCallId: call.id || `lynn_call_${step}_${i}`,
      toolCallName: call.name || request.tool,
      toolCallArguments: call.arguments,
    });
  }
  return requests;
}

function assistantToolCallsForMessages(requests: readonly CodeToolRequest[]): ChatAssistantToolCall[] {
  return requests.map((request, index) => ({
    id: request.toolCallId || `lynn_call_${index}`,
    type: "function",
    function: {
      name: request.toolCallName || request.tool,
      arguments: request.toolCallArguments || JSON.stringify(cleanToolArgsForProvider(request.args)),
    },
  }));
}

function cleanToolArgsForProvider(args: CodeToolRequest["args"]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
}

function normalizeToolPayload(payload: Record<string, unknown>): CodeToolRequest | null {
  const rawToolName = typeof payload.tool === "string"
    ? payload.tool
    : typeof payload.name === "string"
      ? payload.name
      : "";
  if (!rawToolName) return null;
  const toolName = normalizeClientToolName(rawToolName);
  if (!toolName) return null;
  const args = normalizeToolArgAliases(toolName, normalizeToolArgs(payload));
  return {
    tool: toolName,
    args: {
      path: stringArg(args.path),
      text: stringArg(args.text ?? args.content ?? args.patch),
      query: stringArg(args.query),
      pattern: stringArg(args.pattern),
      command: stringArg(args.command),
      maxBytes: numberArg(args.maxBytes ?? args.max_bytes),
      offset: numberArg(args.offset ?? args.start_offset ?? args.startOffset),
      plan: args.plan,
    },
  };
}

const TOOL_NAME_ALIASES: Record<string, ClientToolName> = {
  read_file: "read_file",
  read: "read_file",
  open_file: "read_file",
  read_path: "read_file",
  view_file: "read_file",
  cat: "read_file",
  write_file: "write_file",
  write: "write_file",
  create_file: "write_file",
  save_file: "write_file",
  edit_file: "apply_patch",
  edit: "apply_patch",
  patch: "apply_patch",
  apply_patch: "apply_patch",
  apply_diff: "apply_patch",
  apply_patch_file: "apply_patch",
  grep: "grep",
  search: "grep",
  search_files: "grep",
  ripgrep: "grep",
  rg: "grep",
  glob: "glob",
  list_files: "glob",
  find_files: "glob",
  ls: "glob",
  bash: "bash",
  shell: "bash",
  run_shell: "bash",
  run_bash: "bash",
  terminal: "bash",
  exec: "bash",
  update_plan: "update_plan",
  todowrite: "update_plan",
  todo_write: "update_plan",
  update_todos: "update_plan",
  todo: "update_plan",
  plan: "update_plan",
};

function normalizeClientToolName(raw: string): ClientToolName | null {
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return TOOL_NAME_ALIASES[key] ?? null;
}

function toolPayloadCandidates(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const parsed = value as Record<string, unknown>;
  const candidates: Record<string, unknown>[] = [parsed];
  const fn = parsed.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn)) {
    const functionCall = fn as Record<string, unknown>;
    candidates.push({ name: functionCall.name, arguments: functionCall.arguments });
  }
  const toolCalls = parsed.tool_calls ?? parsed.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (!call || typeof call !== "object" || Array.isArray(call)) continue;
      const record = call as Record<string, unknown>;
      const callFn = record.function;
      if (callFn && typeof callFn === "object" && !Array.isArray(callFn)) {
        const functionCall = callFn as Record<string, unknown>;
        candidates.push({ name: functionCall.name, arguments: functionCall.arguments });
      } else {
        candidates.push(record);
      }
    }
  }
  return candidates;
}

function normalizeToolArgs(parsed: Record<string, unknown>): Record<string, unknown> {
  const explicit = parsed.args ?? parsed.arguments ?? parsed.input ?? parsed.parameters;
  if (explicit && typeof explicit === "object" && !Array.isArray(explicit)) {
    return explicit as Record<string, unknown>;
  }
  if (typeof explicit === "string") {
    try {
      const decoded = JSON.parse(explicit) as unknown;
      if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) return decoded as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  const { tool: _tool, name: _name, args: _args, arguments: _arguments, input: _input, parameters: _parameters, function: _function, tool_calls: _toolCalls, toolCalls: _toolCallsCamel, ...topLevelArgs } = parsed;
  return topLevelArgs;
}

function normalizeToolArgAliases(tool: ClientToolName, args: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...args };
  const path = firstArg(args.path, args.file, args.filepath, args.filePath, args.filename, args.target);
  const oldText = firstArg(args.old_string, args.oldString, args.old_text, args.oldText, args.search, args.original);
  const newText = firstArg(args.new_string, args.newString, args.new_text, args.newText, args.replacement, args.replace);
  const editPatch = buildCodexEditPatch(path, oldText, newText);
  const text = firstArg(args.text, args.content, args.body, args.data, args.patch, args.diff, editPatch);
  const command = firstArg(args.command, args.cmd, args.shell, args.script);
  const query = firstArg(args.query, args.pattern, args.search, args.regex);
  const pattern = firstArg(args.pattern, args.glob, args.query);
  const dir = firstArg(args.path, args.dir, args.directory, args.cwd, args.folder);

  if ((tool === "read_file" || tool === "write_file") && path !== undefined) normalized.path = path;
  if (tool === "write_file" && text !== undefined) normalized.text = text;
  if (tool === "apply_patch" && text !== undefined) normalized.text = text;
  if (tool === "bash" && command !== undefined) normalized.command = command;
  if (tool === "update_plan") {
    normalized.plan = firstArg(args.plan, args.items, args.todos, args.tasks, args.steps, args);
  }
  if (tool === "grep") {
    if (query !== undefined) normalized.query = query;
    if (dir !== undefined) normalized.path = dir;
  }
  if (tool === "glob") {
    if (pattern !== undefined) normalized.pattern = pattern;
    if (dir !== undefined) normalized.path = dir;
  }
  return normalized;
}

function firstArg(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined && value !== null);
}

function buildCodexEditPatch(path: unknown, oldText: unknown, newText: unknown): string | undefined {
  if (typeof path !== "string" || typeof oldText !== "string" || typeof newText !== "string") return undefined;
  if (!path.trim() || !oldText) return undefined;
  return [
    "*** Begin Patch",
    `*** Update File: ${path.trim()}`,
    "@@",
    ...oldText.replace(/\r\n/g, "\n").split("\n").map((line) => `-${line}`),
    ...newText.replace(/\r\n/g, "\n").split("\n").map((line) => `+${line}`),
    "*** End Patch",
    "",
  ].join("\n");
}

function extractJsonCandidates(text: string): string[] {
  const out: string[] = [];
  const fence = text.match(/```(?:json|lynn-tool|tool)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) out.push(fence[1].trim());
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) out.push(trimmed);
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const candidate = scanJsonObject(text, start);
    if (candidate) out.push(candidate);
  }
  return [...new Set(out)];
}

function scanJsonObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
      if (depth < 0) return null;
    }
  }
  return null;
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberArg(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function redactToolArgs(request: CodeToolRequest): Record<string, unknown> {
  const args = { ...request.args } as Record<string, unknown>;
  for (const key of ["text", "command"]) {
    if (typeof args[key] === "string" && args[key].length > 500) {
      args[key] = `${args[key].slice(0, 500)}...`;
    }
  }
  return args;
}

function summarizeToolOutput(output: unknown): string {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  if (!text) return "(no output)";
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

function renderClientToolStart(request: CodeToolRequest): void {
  const target = request.args.path || request.args.query || request.args.pattern || request.args.command || "";
  const suffix = target ? ` ${oneLine(target, 96)}` : "";
  process.stderr.write(`\n╭─ tool ${request.tool}${suffix}\n`);
}

function renderClientToolResult(result: ClientToolResult): void {
  const color = supportsColor(process.stderr);
  const symbol = result.ok ? green("✓", color) : red("×", color);
  const detail = result.error || summarizeToolOutput(result.output);
  process.stderr.write(`╰─ ${symbol} ${oneLine(detail, 400)}\n`);
}

function formatDangerousToolPreview(tool: ClientToolName, args: { path?: string; text?: string; command?: string }, color: boolean): string {
  if (!isDangerousClientTool(tool)) return "";
  if (tool === "apply_patch") {
    const patch = args.text || "";
    if (!patch.trim()) return dim("(empty patch)", color);
    return renderPatchPreview(patch, color);
  }
  if (tool === "write_file") {
    return `${bold("write preview", color)} ${args.path || "(unknown path)"}\n${green(oneLine(args.text || "", 500), color)}`;
  }
  if (tool === "bash") {
    return `${bold("command", color)} ${args.command || "(empty command)"}`;
  }
  return "";
}

function oneLine(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

async function collectCodeContext(repoCwd: string): Promise<CodeContext> {
  const [gitStatus, gitDiffStat, topFiles, packageScripts] = await Promise.all([
    runGit(["status", "--short"], repoCwd),
    runGit(["diff", "--stat"], repoCwd),
    listTopFiles(repoCwd),
    readPackageScripts(repoCwd),
  ]);
  return { cwd: repoCwd, gitStatus, gitDiffStat, topFiles, packageScripts };
}

async function runGit(args: string[], repoCwd: string): Promise<string> {
  try {
    const { stdout } = await pExecFile("git", args, { cwd: repoCwd, maxBuffer: 256 * 1024 });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function listTopFiles(repoCwd: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(repoCwd, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith(".") && !["node_modules", "dist", "dist-renderer", "dist-server-bundle"].includes(entry.name))
      .slice(0, 80)
      .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);
  } catch {
    return [];
  }
}

async function readPackageScripts(repoCwd: string): Promise<Record<string, string>> {
  try {
    const text = await fs.readFile(path.join(repoCwd, "package.json"), "utf8");
    const parsed = JSON.parse(text) as { scripts?: Record<string, string> };
    return parsed.scripts || {};
  } catch {
    return {};
  }
}

function codeImagePaths(args: ParsedArgs): string[] {
  return [
    ...parseImageList(getStringFlag(args.flags, "images")),
    ...parseImageList(getStringFlag(args.flags, "image", "shot")),
  ];
}

function codeMediaPaths(args: ParsedArgs, inlineMediaPaths: readonly string[] = []): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const mediaPath of [...codeImagePaths(args), ...inlineMediaPaths]) {
    if (!mediaPath || seen.has(mediaPath)) continue;
    seen.add(mediaPath);
    out.push(mediaPath);
  }
  return out;
}

function buildCodePrompt(task: string, context: CodeContext, imagePaths?: readonly string[]): string {
  const scripts = Object.entries(context.packageScripts)
    .slice(0, 20)
    .map(([name, command]) => `- ${name}: ${command}`)
    .join("\n") || "(none)";
  return [
    `Task: ${task}`,
    imagePaths?.length ? `Attached images: ${imagePaths.join(", ")}` : "",
    "",
    `CWD: ${context.cwd}`,
    "",
    "Git status:",
    context.gitStatus || "(clean)",
    "",
    "Git diff stat:",
    context.gitDiffStat || "(none)",
    "",
    "Top-level files:",
    context.topFiles.join("\n") || "(unavailable)",
    "",
    "Package scripts:",
    scripts,
  ].filter((line, index, all) => line || all[index - 1] !== "").join("\n");
}

function renderMockCodeTask(task: string, context: CodeContext): string {
  return [
    t("mock.code", { task }),
    t("mock.code.cwd", { cwd: context.cwd }),
    t("mock.code.git", { status: context.gitStatus ? t("git.dirty") : t("git.clean") }),
  ].join("\n");
}

function handleCodeBrainEvent(event: BrainStreamEvent, opts: { json: boolean; renderReasoning: boolean }): void {
  if (opts.json) {
    if (event.type === "assistant.delta" || event.type === "reasoning.delta") {
      writeJsonLine({ ...event, ts: nowIso() });
    } else if (event.type === "usage") {
      writeJsonLine({ type: "usage", ts: nowIso(), usage: event.usage });
    }
    return;
  }

  if (event.type === "assistant.delta") {
    process.stdout.write(event.text);
  } else if (event.type === "reasoning.delta" && opts.renderReasoning) {
    process.stderr.write(dim(event.text, supportsColor(process.stderr)));
  }
}
