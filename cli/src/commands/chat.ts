import { stdin as input, stdout as output } from "node:process";
import { getStringFlag, hasFlag, parseArgs, type ParsedArgs } from "../args.js";
import { BrainConnectionError, streamBrainChat, type BrainStreamEvent, type ChatMessage } from "../brain-client.js";
import { renderBrainModelChoices, renderProvidersInfo, resolveProvidersInfo, runProviders } from "./providers.js";
import { parseReasoningOptions, shouldRenderReasoning } from "../reasoning.js";
import { TerminalSpinner } from "../terminal-spinner.js";
import { formatBrainErrorForHuman, renderBrainEventForHuman, summarizeUsage, type HumanBrainRenderState } from "../brain-render.js";
import { dangerLine, dim, red, supportsColor } from "../terminal-style.js";
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

export const CHAT_SLASH_COMMANDS = [
  "/exit",
  "/quit",
  "/help",
  "/version",
  "/about",
  "/fast",
  "/think",
  "/reasoning",
  "/yolo",
  "/ask",
  "/mode",
  "/model",
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
  "/providers",
  "/providers set",
  "/providers unset",
  "/providers test",
  "/providers presets",
  "/byok set",
  "/byok unset",
  "/clear",
];

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
  let cliProvider = await resolveCliProviderProfile(args);
  const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
  let memoryFrame = buildMemoryContextFrameSync(dataDir);
  const messages: ChatMessage[] = resetCliRuntimeMessages(chatRouteLabel(cliProvider?.profile), memoryFrame);
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
    appendHistory(text, histFile);
    if (text === "/exit" || text === "/quit") return "break";
    if (text === "/help") {
      output.write(`${t("chat.help")}\n\n`);
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
      output.write(`${t("chat.cleared")}\n\n`);
      return "continue";
    }
    if (text === "/cwd" || text === "/pwd") {
      output.write(`${t("cwd.info", { cwd: chatCwd })}\n\n`);
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
    messages.push({ role: "user", content });
    if (mockBrain) {
      const answer = t("mock.response", { text: displayText });
      messages.push({ role: "assistant", content: answer });
      output.write(`${answer}\n\n`);
      return "continue";
    }

    let assistant = "";
    let latestUsage: string | null = null;
    const renderState: HumanBrainRenderState = {};
    const spinner = new TerminalSpinner(process.stderr);
    const renderReasoning = shouldRenderReasoning(reasoning.display, false);
    const md = new MarkdownStream((s) => output.write(s), supportsColor(output));
    const turnStarted = Date.now();
    const decodeTracker = createDecodeSpeedTracker(turnStarted);
    let decodeTps: string | null = null;
    try {
      spinner.start();
      for await (const event of streamBrainChat({ brainUrl, messages, reasoning, fallbackProvider: cliProvider?.profile })) {
        if (eventWritesHumanOutput(event, renderReasoning)) {
          spinner.stop();
        }
        if (event.type === "brain.error") {
          throw new Error(event.code ? `${event.error} (${event.code})` : event.error);
        }
        if (event.type === "assistant.delta") {
          md.push(event.text);
          decodeTps = decodeTracker.add(event.text) || decodeTps;
          assistant += event.text;
        } else {
          if (event.type === "usage") latestUsage = summarizeUsage(event.usage, { durationMs: Date.now() - turnStarted });
          renderChatEvent(event, renderReasoning, renderState, turnStarted);
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
    md.end();
    messages.push({ role: "assistant", content: assistant });
    output.write(`\n${renderStatusBar({
      model: renderState.provider ? modelDisplayName(renderState.provider) : t("status.chat.prefix"),
      cwd: chatCwd,
      mode: renderMode(mode),
      reasoning: reasoning.effort,
      usage: latestUsage,
      decodeTps,
      color: supportsColor(output),
    })}\n\n`);
    return "continue";
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

function eventWritesHumanOutput(event: BrainStreamEvent, renderReasoning: boolean): boolean {
  return event.type === "assistant.delta"
    || event.type === "provider"
    || event.type === "tool_progress"
    || event.type === "brain.error"
    || event.type === "usage"
    || (event.type === "reasoning.delta" && renderReasoning);
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
  return `${mode.approval} / ${mode.sandbox}`;
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
  const label = dangerous ? red(renderMode(mode), color) : renderMode(mode);
  const warning = dangerous ? `\n${dangerLine(t("mode.danger.warning"), color)}` : "";
  return `✓ ${message}\nmode: ${label}${warning}\n\n`;
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
