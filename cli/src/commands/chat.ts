import { emitKeypressEvents } from "node:readline";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { BrainConnectionError, streamBrainChat, type BrainStreamEvent, type ChatMessage } from "../brain-client.js";
import { renderProvidersInfo, resolveProvidersInfo } from "./providers.js";
import { parseReasoningOptions, shouldRenderReasoning } from "../reasoning.js";
import { TerminalSpinner } from "../terminal-spinner.js";
import { renderBrainEventForHuman, summarizeUsage, type HumanBrainRenderState } from "../brain-render.js";
import { dangerLine, dim, red, supportsColor } from "../terminal-style.js";
import { renderStartupBanner } from "../startup.js";
import { resolveCliProviderProfile } from "../provider-profile.js";
import { t } from "../i18n.js";

export async function runChat(args: ParsedArgs, options: { intro?: boolean; brainReachable?: boolean } = {}): Promise<number> {
  const mockBrain = hasFlag(args.flags, "mock-brain", "mock");
  const brainUrl = getStringFlag(args.flags, "brain-url") || process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790";
  let reasoning = parseReasoningOptions(args);
  const mode = resolveMode(args);
  const cliProvider = await resolveCliProviderProfile(args);
  const messages: ChatMessage[] = [];
  const rl = readline.createInterface({ input, output, terminal: input.isTTY && output.isTTY });
  const cleanupModeHotkey = input.isTTY && output.isTTY
    ? installModeHotkey({ input, output, readlineInterface: rl, mode })
    : () => {};

  if (options.intro !== false) {
    output.write(`${renderStartupBanner({
      brainUrl,
      brainStatus: "unknown",
      modeLabel: renderMode(mode),
      modelLabel: "MiMo via Brain router (auto)",
    })}\n\n`);
  } else if (options.brainReachable === false && !mockBrain) {
    output.write(`${renderOfflineChatHint(mode, brainUrl)}\n`);
  }
  async function handleText(raw: string): Promise<"continue" | "break"> {
    const text = raw.trim();
    if (!text) return "continue";
    if (text === "/exit" || text === "/quit") return "break";
    if (text === "/help") {
      output.write("/exit leave chat\n/clear reset context\n/model show model/BYOK route\n/providers show BYOK setup\n/fast low-latency replies\n/think deeper reasoning\n/reasoning show or set reasoning mode\n/mode show permission mode\n/mode ask|yolo|read-only|workspace|danger change permission mode\n/help show commands\n\n");
      return "continue";
    }
    if (text === "/fast") {
      reasoning = { ...reasoning, effort: "off" };
      output.write("Fast mode enabled: MiMo/Brain thinking is off for short low-latency replies.\n\n");
      return "continue";
    }
    if (text === "/think") {
      reasoning = { ...reasoning, effort: "high" };
      output.write("Thinking mode enabled: reasoning effort is high.\n\n");
      return "continue";
    }
    if (text === "/reasoning") {
      output.write(`reasoning: ${reasoning.effort} · display ${reasoning.display}\nUse /fast, /think, or /reasoning off|auto|low|medium|high|xhigh.\n\n`);
      return "continue";
    }
    if (text.startsWith("/reasoning ")) {
      const result = applyReasoningCommand(reasoning, text.slice(11).trim());
      reasoning = result.reasoning;
      output.write(`${result.message}\nreasoning: ${reasoning.effort} · display ${reasoning.display}\n\n`);
      return "continue";
    }
    if (text === "/mode") {
      output.write(`mode: ${renderMode(mode)}\nUse /mode yolo for full local tool permission, /mode ask for guarded mode, or Shift+Tab to toggle.\n\n`);
      return "continue";
    }
    if (text.startsWith("/mode ")) {
      const result = applyModeCommand(mode, text.slice(6).trim());
      output.write(renderInteractiveModeChange(result, mode, supportsColor(output)));
      return "continue";
    }
    if (text === "/model" || text === "/providers") {
      output.write(`${renderProvidersInfo(await resolveProvidersInfo(args))}\n\n`);
      return "continue";
    }
    if (text === "/clear") {
      messages.length = 0;
      output.write("Context cleared.\n\n");
      return "continue";
    }

    messages.push({ role: "user", content: text });
    if (mockBrain) {
      const answer = t("mock.response", { text });
      messages.push({ role: "assistant", content: answer });
      output.write(`${answer}\n\n`);
      return "continue";
    }

    let assistant = "";
    const renderState: HumanBrainRenderState = {};
    const spinner = new TerminalSpinner(process.stderr);
    const renderReasoning = shouldRenderReasoning(reasoning.display, false);
    try {
      spinner.start();
      for await (const event of streamBrainChat({ brainUrl, messages, reasoning, fallbackProvider: cliProvider?.profile })) {
        if (event.type === "assistant.delta" || (event.type === "reasoning.delta" && renderReasoning)) {
          spinner.stop();
        }
        if (renderChatEvent(event, renderReasoning, renderState)) {
          assistant += event.text;
        }
        if (event.type === "brain.error") {
          throw new Error(event.code ? `${event.error} (${event.code})` : event.error);
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
    messages.push({ role: "assistant", content: assistant });
    output.write("\n\n");
    return "continue";
  }

  try {
    if (!input.isTTY) {
      for await (const line of rl) {
        if (await handleText(line) === "break") break;
      }
    } else {
      for (;;) {
        const text = await rl.question("");
        if (await handleText(text) === "break") break;
      }
    }
  } finally {
    cleanupModeHotkey();
    rl.close();
  }
  return 0;
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

export interface ModeHotkeyStreams {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  readlineInterface: unknown;
  mode: ChatMode;
}

function resolveMode(args: ParsedArgs): ChatMode {
  const approval = getStringFlag(args.flags, "approval");
  const sandbox = getStringFlag(args.flags, "sandbox");
  return {
    approval: approval === "on-failure" || approval === "never" || approval === "yolo" ? approval : "ask",
    sandbox: sandbox === "read-only" || sandbox === "danger-full-access" ? sandbox : "workspace-write",
  };
}

export function renderMode(mode: ChatMode): string {
  return `${mode.approval} / ${mode.sandbox}`;
}

export function renderOfflineChatHint(_mode: ChatMode, _brainUrl = "http://127.0.0.1:8790"): string {
  // The startup banner already shows brain URL + mode; keep this hint concise and
  // non-redundant — just the localized next steps.
  return t("offline.body");
}

export function applyModeCommand(mode: ChatMode, raw: string): string {
  const value = raw.toLowerCase();
  if (value === "yolo") {
    mode.approval = "yolo";
    mode.sandbox = "danger-full-access";
    return "YOLO mode enabled.";
  }
  if (value === "ask" || value === "guarded") {
    mode.approval = "ask";
    mode.sandbox = "workspace-write";
    return "Guarded mode enabled.";
  }
  if (value === "read-only" || value === "readonly") {
    mode.approval = "ask";
    mode.sandbox = "read-only";
    return "Read-only mode enabled.";
  }
  if (value === "workspace" || value === "workspace-write") {
    mode.approval = "ask";
    mode.sandbox = "workspace-write";
    return "Workspace-write mode enabled.";
  }
  if (value === "danger" || value === "danger-full-access") {
    mode.approval = "yolo";
    mode.sandbox = "danger-full-access";
    return "Danger-full-access mode enabled.";
  }
  return `Unknown mode: ${raw || "(empty)"}. Try /mode ask or /mode yolo.`;
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
  const warning = dangerous ? `\n${dangerLine("YOLO mode enabled: local edits and shell commands will not ask again.", color)}` : "";
  return `✓ ${message}\nmode: ${label}${warning}\n\n`;
}

export function applyReasoningCommand(current: ReturnType<typeof parseReasoningOptions>, raw: string): { reasoning: ReturnType<typeof parseReasoningOptions>; message: string } {
  const value = raw.toLowerCase();
  if (value === "off" || value === "auto" || value === "low" || value === "medium" || value === "high" || value === "xhigh") {
    return { reasoning: { ...current, effort: value }, message: `Reasoning effort set to ${value}.` };
  }
  if (value === "show" || value === "always") {
    return { reasoning: { ...current, display: "always" }, message: "Reasoning display set to always." };
  }
  if (value === "hide" || value === "never") {
    return { reasoning: { ...current, display: "never" }, message: "Reasoning display set to never." };
  }
  return { reasoning: current, message: `Unknown reasoning mode: ${raw || "(empty)"}.` };
}

export function installModeHotkey({ input, output, readlineInterface, mode }: ModeHotkeyStreams): () => void {
  emitKeypressEvents(input, readlineInterface as Parameters<typeof emitKeypressEvents>[1]);
  const onKeypress = (_chunk: string, key: KeypressLike) => {
    if (!isModeToggleKeypress(key)) return;
    const message = toggleMode(mode);
    output.write(`\n${renderInteractiveModeChange(message, mode, supportsColor(output))}`);
  };
  input.on("keypress", onKeypress);
  return () => {
    input.off("keypress", onKeypress);
  };
}

export function formatChatError(error: unknown): string {
  if (error instanceof BrainConnectionError) {
    return `Brain offline: start the Lynn client GUI for MiMo, or run /providers to configure CLI BYOK. (${error.brainUrl})`;
  }
  const message = error instanceof Error ? error.message : String(error);
  return `Lynn error: ${message}`;
}

function renderChatEvent(event: BrainStreamEvent, renderReasoning: boolean, renderState: HumanBrainRenderState): event is { type: "assistant.delta"; text: string } {
  if (event.type === "assistant.delta") {
    output.write(event.text);
    return true;
  }
  if (event.type === "reasoning.delta" && renderReasoning) {
    process.stderr.write(dim(event.text, supportsColor(process.stderr)));
  } else if (event.type === "usage") {
    const summary = summarizeUsage(event.usage);
    if (summary) process.stderr.write(`\nusage: ${summary}\n`);
  } else {
    renderBrainEventForHuman(event, renderState, process.stderr);
  }
  return false;
}
