import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import readline from "node:readline/promises";
import { stdin as input, stdout as output, stderr as errorOutput } from "node:process";
import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { formatBrainRecoveryHint, streamBrainChat, type BrainStreamEvent } from "../brain-client.js";
import { renderBrainEventForHuman, summarizeUsage, type HumanBrainRenderState } from "../brain-render.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { resolveEffectivePermissions } from "../permissions.js";
import { parseReasoningOptions, shouldRenderReasoning } from "../reasoning.js";
import { TerminalSpinner } from "../terminal-spinner.js";
import { bold, dangerLine, dim, green, red, supportsColor } from "../terminal-style.js";
import { colorizePatch } from "../diff-format.js";
import { renderMarkdown } from "../markdown.js";
import { HistoryNavigator, appendHistory, historyPath, loadHistory } from "../history.js";
import { completeSlash } from "../completion.js";
import { box, displayCwd, padLine } from "../startup.js";
import { t } from "../i18n.js";
import { resolveCliProviderProfile, type CliProviderProfile } from "../provider-profile.js";
import { CLIENT_TOOL_DEFINITIONS, runClientTool } from "../tools/registry.js";
import type { ClientToolName, ClientToolResult, ToolRunContext } from "../tools/types.js";
import { applyModeCommand, applyReasoningCommand, renderMode, toggleMode, type ChatMode } from "./chat.js";
import { renderProvidersInfo, resolveProvidersInfo } from "./providers.js";
import { readVersionInfo } from "../version.js";

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

function maxSteps(args: ParsedArgs): number {
  const raw = getStringFlag(args.flags, "max-steps", "steps");
  if (!raw) return 8;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 20) throw new Error("--max-steps must be an integer from 1 to 20");
  return parsed;
}

export async function runCode(args: ParsedArgs): Promise<number> {
  const json = hasFlag(args.flags, "json", "jsonl");
  if (hasFlag(args.flags, "list-tools")) {
    const payload = { type: "code.tools", ts: nowIso(), tools: CLIENT_TOOL_DEFINITIONS };
    if (json) writeJsonLine(payload);
    else process.stdout.write(`${CLIENT_TOOL_DEFINITIONS.map((tool) => `${tool.name}${tool.dangerous ? " (approval required)" : ""}: ${tool.description}`).join("\n")}\n`);
    return 0;
  }

  const tool = getStringFlag(args.flags, "tool") as ClientToolName | null;
  if (!tool) {
    const task = args.positionals.join(" ").trim();
    if (task) return runCodeTask(args, task, json);
    if (!json && input.isTTY && output.isTTY) return runCodeInteractive(args);
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

async function runCodeInteractive(args: ParsedArgs): Promise<number> {
  const mode = await resolveCodeMode(args);
  let reasoning = parseReasoningOptions(args);
  output.write(renderCodeIntro(mode, reasoning, { color: supportsColor(output) }));
  const histFile = historyPath();
  const history = loadHistory(histFile);
  const slashCommands = ["/exit", "/quit", "/help", "/tools", "/fast", "/think", "/reasoning", "/mode", "/model", "/providers"];
  try {
    for (;;) {
      const raw = await readCodeLine("", mode, {
        placeholder: t("code.placeholder"),
        history: new HistoryNavigator(history),
        completions: slashCommands,
      });
      if (raw === null) break;
      const text = raw.trim();
      if (!text) continue;
      history.push(text);
      appendHistory(text, histFile);
      if (text === "/exit" || text === "/quit") break;
      if (text === "/help") {
        output.write(renderCodeHelp());
        continue;
      }
      if (text === "/tools") {
        output.write(`${CLIENT_TOOL_DEFINITIONS.map((tool) => `${tool.name}${tool.dangerous ? " (approval required)" : ""}: ${tool.description}`).join("\n")}\n\n`);
        continue;
      }
      if (text === "/fast") {
        reasoning = { ...reasoning, effort: "off" };
        output.write("✓ fast mode · thinking off\n\n");
        continue;
      }
      if (text === "/think") {
        reasoning = { ...reasoning, effort: "high" };
        output.write("✓ thinking mode · high\n\n");
        continue;
      }
      if (text === "/reasoning") {
        output.write(`think: ${reasoning.effort} / display ${reasoning.display}\nUse /fast, /think, or /reasoning off|auto|low|medium|high|xhigh.\n\n`);
        continue;
      }
      if (text.startsWith("/reasoning ")) {
        const result = applyReasoningCommand(reasoning, text.slice(11).trim());
        reasoning = result.reasoning;
        output.write(`✓ ${result.message}\nthink: ${reasoning.effort} / display ${reasoning.display}\n\n`);
        continue;
      }
      if (text === "/mode") {
        output.write(`mode: ${renderMode(mode)}\nUse /mode yolo for full local tool permission or /mode ask for guarded mode.\n\n`);
        continue;
      }
      if (text.startsWith("/mode ")) {
        const result = applyModeCommand(mode, text.slice(6).trim());
        output.write(renderModeChange(result, mode, supportsColor(output)));
        continue;
      }
      if (text === "/model" || text === "/providers") {
        output.write(`${renderProvidersInfo(await resolveProvidersInfo(args))}\n\n`);
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

async function readCodeLine(prompt: string, mode: ChatMode, options: { placeholder?: string; history?: HistoryNavigator; completions?: string[] } = {}): Promise<string | null> {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") {
    const rl = readline.createInterface({ input, output, terminal: false });
    try {
      const line = await rl.question(prompt);
      return line;
    } finally {
      rl.close();
    }
  }

  const rawBefore = input.isRaw;
  input.setRawMode(true);
  input.resume();

  return await new Promise<string | null>((resolve) => {
    let buffer = "";
    const color = supportsColor(output);
    const placeholder = options.placeholder || "";
    const clearWidth = () => Math.max(80, typeof output.columns === "number" ? output.columns : 0, prompt.length + buffer.length + placeholder.length + 8);
    const cleanup = () => {
      input.off("data", onData);
      input.setRawMode(rawBefore);
      input.pause();
    };
    const redraw = () => {
      const visible = buffer ? buffer : placeholder ? dim(placeholder, color) : "";
      output.write(`\r${" ".repeat(clearWidth())}\r${prompt}${visible}`);
      if (!buffer && placeholder) output.write(`\r${prompt}`);
    };
    redraw();
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const newlineIndex = text.search(/[\r\n]/);
      if (newlineIndex >= 0) {
        const beforeNewline = text.slice(0, newlineIndex);
        const printableBeforeNewline = Array.from(beforeNewline).filter((char) => char >= " " && char !== "\u007f").join("");
        buffer += printableBeforeNewline;
        output.write(`\r${" ".repeat(clearWidth())}\r${prompt}${buffer}\n`);
        cleanup();
        resolve(buffer);
        return;
      }
      if (text === "\u0003") {
        output.write(`\r${" ".repeat(clearWidth())}\r^C\n`);
        cleanup();
        resolve(null);
        return;
      }
      if (text === "\u0004") {
        output.write(`\r${" ".repeat(clearWidth())}\r\n`);
        cleanup();
        resolve(null);
        return;
      }
      if (text === "\u001b[Z") {
        const message = toggleMode(mode);
        output.write(`\n${renderModeChange(message, mode, supportsColor(output))}`);
        redraw();
        return;
      }
      if (text === "\u007f" || text === "\b") {
        if (buffer.length) {
          buffer = Array.from(buffer).slice(0, -1).join("");
          redraw();
        }
        return;
      }
      if (text === "\u001b[A" && options.history) {
        buffer = options.history.prev(buffer);
        redraw();
        return;
      }
      if (text === "\u001b[B" && options.history) {
        buffer = options.history.next();
        redraw();
        return;
      }
      if (text === "\t" && options.completions) {
        const completion = completeSlash(buffer, options.completions);
        if (completion.matches.length > 1) output.write(`\n${completion.matches.join("  ")}\n`);
        buffer = completion.completed;
        redraw();
        return;
      }
      if (text.startsWith("\u001b")) return;
      const printable = Array.from(text).filter((char) => char >= " " && char !== "\u007f").join("");
      if (!printable) return;
      buffer += printable;
      redraw();
    };
    input.on("data", onData);
  });
}

export function renderCodeIntro(
  mode: ChatMode,
  reasoning = parseReasoningOptions({ command: "code", positionals: [], flags: {} }),
  options: { color?: boolean } = {},
): string {
  const color = !!options.color;
  const version = readVersionInfo().version;
  const lines = [
    `Lynn Code (${version})`,
    "",
    padLine("model", "MiMo", "/model to change"),
    padLine("directory", displayCwd(process.cwd())),
  ];
  const dangerous = mode.approval === "yolo" || mode.sandbox === "danger-full-access";
  return [
    box(lines),
    "",
    dangerous
      ? `  ${dangerLine("YOLO mode can edit files and run shell commands without asking.", color)}`
      : `  ${t("code.tip")}`,
    "",
  ].join("\n");
}

function renderModeChange(message: string, mode: ChatMode, color: boolean): string {
  const dangerous = mode.approval === "yolo" || mode.sandbox === "danger-full-access";
  const modeLabel = dangerous ? red(renderMode(mode), color) : renderMode(mode);
  const warning = dangerous
    ? `\n${dangerLine("YOLO mode enabled: local edits and shell commands will not ask again.", color)}`
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
}): string {
  const route = inputData.mockBrain ? "mock Brain" : "MiMo via local Brain router";
  return [
    box([
      `Lynn Code · ${route}`,
      "",
      padLine("directory", displayCwd(inputData.cwd)),
      padLine("mode", `${inputData.approval} / ${inputData.sandbox}`),
      padLine("think", `${inputData.reasoning.effort} · max steps ${inputData.maxSteps}`),
    ]),
    "",
  ].join("\n");
}

function renderCodeHelp(): string {
  return [
    "/exit leave code mode",
    "/tools list local coding tools",
    "/fast low-latency MiMo/Brain replies",
    "/think deeper MiMo/Brain reasoning",
    "/reasoning show or set reasoning mode",
    "/model show current Brain/BYOK route",
    "/providers show provider and BYOK setup",
    "/mode show permission mode",
    "/mode ask guarded workspace-write mode",
    "/mode yolo allow local writes and shell commands",
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

export function isDangerousClientTool(tool: ClientToolName): boolean {
  return !!CLIENT_TOOL_DEFINITIONS.find((definition) => definition.name === tool)?.dangerous;
}

export function canPromptForDangerousTool(inputStream: Pick<NodeJS.ReadStream, "isTTY">, outputStream: Pick<NodeJS.WriteStream, "isTTY">, json: boolean): boolean {
  return !json && !!inputStream.isTTY && !!outputStream.isTTY;
}

async function resolveToolApproval(request: ToolApprovalRequest): Promise<ToolApprovalRequest["approval"]> {
  if (!isDangerousClientTool(request.tool)) return request.approval;
  if (request.approval === "yolo" || request.session?.approveAll) return "yolo";
  if (request.approval === "never") {
    throw new Error(`${request.tool} requires approval; current mode is never`);
  }
  if (!canPromptForDangerousTool(request.input, request.output, request.json)) {
    throw new Error(`${request.tool} requires --approval yolo or an interactive confirmation`);
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

async function runCodeTask(args: ParsedArgs, task: string, json: boolean, options: { compact?: boolean } = {}): Promise<number> {
  const context = await collectCodeContext(cwd(args));
  const reasoning = parseReasoningOptions(args);
  const brainUrl = getStringFlag(args.flags, "brain-url") || process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790";
  const mockBrain = hasFlag(args.flags, "mock-brain", "mock");
  const mode = await resolveCodeMode(args);
  const cliProvider = await resolveCliProviderProfile(args);
  if (!json && !options.compact) {
    errorOutput.write(renderCodeTaskHeader({
      cwd: context.cwd,
      approval: mode.approval,
      sandbox: mode.sandbox,
      reasoning,
      maxSteps: maxSteps(args),
      mockBrain,
    }));
  }
  if (json) writeJsonLine({ type: "code.task.started", ts: nowIso(), task, context });

  if (mockBrain) {
    const text = renderMockCodeTask(task, context);
    if (json) {
      writeJsonLine({ type: "assistant.delta", ts: nowIso(), text });
      writeJsonLine({ type: "code.task.finished", ts: nowIso(), ok: true });
    } else {
      process.stdout.write(renderAssistantBlock(text, renderCodeFooter({ context, mode, mockBrain, reasoning })));
    }
    return 0;
  }

  const toolCtx: ToolRunContext = {
    cwd: cwd(args),
    approval: mode.approval,
    sandbox: mode.sandbox,
    timeoutMs: timeoutMs(args),
  };
  const final = await runCodeAgentLoop({
    task,
    context,
    brainUrl,
    fallbackProvider: cliProvider?.profile,
    reasoning,
    json,
    maxSteps: maxSteps(args),
    toolCtx,
    input,
    output: errorOutput,
  });
  if (json) {
    if (final.trim()) writeJsonLine({ type: "assistant.delta", ts: nowIso(), text: final });
    writeJsonLine({ type: "code.task.finished", ts: nowIso(), ok: true, contentReturned: !!final.trim() });
  } else {
    process.stdout.write(renderAssistantBlock(renderMarkdown(final.trim() || "(no answer)", supportsColor(output)), renderCodeFooter({ context, mode, mockBrain, reasoning, fallbackProvider: cliProvider?.profile })));
  }
  return 0;
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
}): string {
  const color = supportsColor(output);
  const model = inputData.mockBrain ? "mock Brain" : inputData.fallbackProvider ? `${inputData.fallbackProvider.provider}/${inputData.fallbackProvider.model}` : "MiMo";
  const mode = renderMode(inputData.mode);
  return dim(`${model} · ${displayCwd(inputData.context.cwd)} · ${mode} · think ${inputData.reasoning.effort}`, color);
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
}

interface CodeToolRequest {
  tool: ClientToolName;
  args: {
    path?: string;
    text?: string;
    query?: string;
    pattern?: string;
    command?: string;
    maxBytes?: number;
  };
}

async function runCodeAgentLoop(inputData: CodeAgentLoopInput): Promise<string> {
  const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
    {
      role: "system",
      content: [
        "You are Lynn CLI code mode.",
        "The default online route is MiMo through the local Lynn Brain router.",
        "MiMo is good at Chinese/English mixed product work; keep responses in the user's language.",
        "You help with repository-level coding tasks from the terminal.",
        "You may request local tools using exactly one JSON object and no prose:",
        '{"tool":"read_file|grep|glob|apply_patch|bash|write_file","args":{...}}',
        "Prefer read_file, grep, and glob before editing. Use apply_patch for edits when possible.",
        "When you are done, answer normally with a concise summary and tests run.",
        "Do not claim you edited files unless a tool actually changed them.",
        "Never download models, datasets, training packs, BF16, or GGUF files to the local Mac.",
      ].join("\n"),
    },
    { role: "user", content: buildCodePrompt(inputData.task, inputData.context) },
  ];
  let finalText = "";
  const approvalSession = { approveAll: false };
  for (let step = 0; step < inputData.maxSteps; step += 1) {
    const assistantText = await collectBrainText({
      brainUrl: inputData.brainUrl,
      fallbackProvider: inputData.fallbackProvider,
      messages,
      reasoning: inputData.reasoning,
      json: inputData.json,
      label: step === 0 ? t("spinner.coding") : t("spinner.reviewing"),
    });
    messages.push({ role: "assistant", content: assistantText });
    const toolRequest = parseCodeToolRequest(assistantText);
    if (!toolRequest) {
      finalText = assistantText;
      break;
    }
    if (inputData.json) writeJsonLine({ type: "code.tool.requested", ts: nowIso(), tool: toolRequest.tool, args: redactToolArgs(toolRequest) });
    else renderClientToolStart(toolRequest);
    let toolResult: ClientToolResult;
    try {
      const effectiveApproval = await resolveToolApproval({
        tool: toolRequest.tool,
        approval: inputData.toolCtx.approval,
        cwd: inputData.toolCtx.cwd,
        json: inputData.json,
        input: inputData.input,
        output: inputData.output,
        preview: formatDangerousToolPreview(toolRequest.tool, toolRequest.args, supportsColor(inputData.output)),
        session: approvalSession,
      });
      toolResult = await runClientTool({ ...inputData.toolCtx, approval: effectiveApproval }, {
        name: toolRequest.tool,
        ...toolRequest.args,
      });
    } catch (error) {
      toolResult = {
        ok: false,
        tool: toolRequest.tool,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (inputData.json) writeJsonLine({ type: "code.tool.result", ts: nowIso(), ...toolResult });
    else renderClientToolResult(toolResult);
    messages.push({ role: "user", content: `Tool result for ${toolRequest.tool}:\n${JSON.stringify(toolResult, null, 2)}\nContinue. If no more tools are needed, give the final answer.` });
  }
  if (!finalText) {
    finalText = "Stopped after the maximum tool steps. Review the emitted tool results before continuing.";
  }
  return finalText;
}

async function collectBrainText(inputData: {
  brainUrl: string;
  fallbackProvider?: CliProviderProfile;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  reasoning: ReturnType<typeof parseReasoningOptions>;
  json: boolean;
  label: string;
}): Promise<string> {
  let text = "";
  const spinner = new TerminalSpinner(process.stderr, inputData.label);
  const renderState: HumanBrainRenderState = {};
  if (!inputData.json) spinner.start();
  try {
    for await (const event of streamBrainChat({
      brainUrl: inputData.brainUrl,
      reasoning: inputData.reasoning,
      messages: inputData.messages,
      fallbackProvider: inputData.fallbackProvider,
    })) {
      const renderReasoning = shouldRenderReasoning(inputData.reasoning.display, inputData.json);
      if (event.type === "assistant.delta" || (event.type === "reasoning.delta" && renderReasoning)) {
        spinner.stop();
      }
      if (event.type === "reasoning.delta" && renderReasoning) process.stderr.write(dim(event.text, supportsColor(process.stderr)));
      if (event.type === "assistant.delta") text += event.text;
      if (inputData.json && (event.type === "provider" || event.type === "tool_progress" || event.type === "brain.error" || event.type === "usage")) {
        if (event.type === "usage") writeJsonLine({ type: "usage", ts: nowIso(), usage: event.usage });
        else writeJsonLine({ ...event, ts: nowIso() });
      }
      if (!inputData.json && event.type !== "assistant.delta" && event.type !== "reasoning.delta") {
        if (event.type === "usage") {
          const summary = summarizeUsage(event.usage);
          if (summary) process.stderr.write(`usage: ${summary}\n`);
        } else {
          renderBrainEventForHuman(event, renderState, process.stderr);
        }
      }
      if (event.type === "brain.error") {
        throw new Error(event.code ? `${event.error} (${event.code})` : event.error);
      }
    }
  } finally {
    spinner.stop();
  }
  return text;
}

export function parseCodeToolRequest(text: string): CodeToolRequest | null {
  for (const candidate of extractJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      const toolName = typeof parsed.tool === "string"
        ? parsed.tool
        : typeof parsed.name === "string"
          ? parsed.name
          : "";
      if (!toolName) continue;
      if (!CLIENT_TOOL_DEFINITIONS.some((definition) => definition.name === toolName)) continue;
      const args = normalizeToolArgs(parsed);
      return {
        tool: toolName as ClientToolName,
        args: {
          path: stringArg(args.path),
          text: stringArg(args.text ?? args.content ?? args.patch),
          query: stringArg(args.query),
          pattern: stringArg(args.pattern),
          command: stringArg(args.command),
          maxBytes: numberArg(args.maxBytes ?? args.max_bytes),
        },
      };
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

function normalizeToolArgs(parsed: Record<string, unknown>): Record<string, unknown> {
  const explicit = parsed.args ?? parsed.arguments;
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
  const { tool: _tool, name: _name, args: _args, arguments: _arguments, ...topLevelArgs } = parsed;
  return topLevelArgs;
}

function extractJsonCandidates(text: string): string[] {
  const out: string[] = [];
  const fence = text.match(/```(?:json|lynn-tool|tool)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) out.push(fence[1].trim());
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) out.push(trimmed);
  const start = text.indexOf("{");
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      if (depth === 0) {
        out.push(text.slice(start, i + 1));
        break;
      }
    }
  }
  return [...new Set(out)];
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
    return `${bold("patch preview", color)}\n${colorizePatch(patch, color)}`;
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

function buildCodePrompt(task: string, context: CodeContext): string {
  const scripts = Object.entries(context.packageScripts)
    .slice(0, 20)
    .map(([name, command]) => `- ${name}: ${command}`)
    .join("\n") || "(none)";
  return [
    `Task: ${task}`,
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
  ].join("\n");
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
