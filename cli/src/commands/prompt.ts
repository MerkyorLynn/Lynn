import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { streamBrainChat, type BrainStreamEvent } from "../brain-client.js";
import { renderBrainEventForHuman, summarizeUsage, type HumanBrainRenderState } from "../brain-render.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { parseReasoningOptions, shouldRenderReasoning } from "../reasoning.js";
import { appendSessionTurn, resolveDataDir } from "../session/store.js";
import { TerminalSpinner } from "../terminal-spinner.js";
import { resolveCliProviderProfile } from "../provider-profile.js";
import { t } from "../i18n.js";

export interface PromptOptions {
  json?: boolean;
  mockBrain?: boolean;
}

export function resolvePrompt(args: ParsedArgs): string {
  return getStringFlag(args.flags, "p", "print", "prompt") || args.positionals.join(" ").trim();
}

export function mergePromptAndStdin(prompt: string, stdinText: string): string {
  const cleanPrompt = prompt.trim();
  const cleanStdin = stdinText.trim();
  if (cleanPrompt === "-") return cleanStdin;
  if (!cleanStdin) return cleanPrompt;
  if (!cleanPrompt) return cleanStdin;
  return `${cleanPrompt}\n\n--- stdin ---\n${cleanStdin}`;
}

export async function runPrompt(args: ParsedArgs, options: PromptOptions = {}): Promise<number> {
  const rawPrompt = resolvePrompt(args);
  const stdinText = await readPromptStdin(rawPrompt);
  const prompt = mergePromptAndStdin(rawPrompt, stdinText);
  if (!prompt) {
    throw new Error("prompt is required");
  }
  const reasoning = parseReasoningOptions(args);
  const brainUrl = getStringFlag(args.flags, "brain-url") || process.env.LYNN_BRAIN_URL || "http://127.0.0.1:8790";
  const saveSession = hasFlag(args.flags, "save-session", "session") || !!process.env.LYNN_CLI_SAVE_SESSION;
  const sessionPath = getStringFlag(args.flags, "session");
  const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
  const title = getStringFlag(args.flags, "title");
  const cliProvider = await resolveCliProviderProfile(args);

  if (options.json) {
    writeJsonLine({ type: "run.started", ts: nowIso(), prompt, reasoning });
  }

  if (options.mockBrain) {
    const text = t("mock.response", { text: prompt });
    if (options.json) {
      writeJsonLine({ type: "assistant.delta", ts: nowIso(), text });
      writeJsonLine({ type: "run.finished", ts: nowIso(), ok: true });
    } else {
      process.stdout.write(`${text}\n`);
    }
    if (saveSession) {
      const savedPath = await appendSessionTurn({ dataDir, sessionPath, cwd: process.cwd(), title, prompt, assistant: text, modelProvider: "mock", modelId: "mock-brain" });
      if (options.json) writeJsonLine({ type: "session.saved", ts: nowIso(), path: savedPath });
    }
    return 0;
  }

  let assistant = "";
  let sawReasoning = false;
  let modelProvider = "brain";
  let modelId = "lynn-brain-router";
  const renderState: HumanBrainRenderState = {};
  const spinner = new TerminalSpinner(process.stderr);
  if (!options.json) spinner.start();
  try {
    for await (const event of streamBrainChat({ brainUrl, prompt, reasoning, fallbackProvider: cliProvider?.profile })) {
      const renderReasoning = shouldRenderReasoning(reasoning.display, !!options.json);
      if (event.type === "assistant.delta" || (event.type === "reasoning.delta" && renderReasoning)) {
        spinner.stop();
      }
      handleBrainEvent(event, {
        json: !!options.json,
        renderReasoning,
        renderState,
      });
      if (event.type === "brain.error") {
        throw new Error(event.code ? `${event.error} (${event.code})` : event.error);
      }
      if (event.type === "provider") {
        if (event.activeProvider.startsWith("cli-byok:") && cliProvider) {
          modelProvider = cliProvider.profile.provider;
          modelId = cliProvider.profile.model;
        } else {
          modelProvider = event.activeProvider;
          modelId = "lynn-brain-router";
        }
      }
      if (event.type === "reasoning.delta") sawReasoning = true;
      if (event.type === "assistant.delta") assistant += event.text;
    }
  } finally {
    spinner.stop();
  }
  if (saveSession) {
    const savedPath = await appendSessionTurn({
      dataDir,
      sessionPath,
      cwd: process.cwd(),
      title,
      prompt,
      assistant,
      modelProvider,
      modelId,
    });
    if (options.json) writeJsonLine({ type: "session.saved", ts: nowIso(), path: savedPath });
  }
  if (options.json) {
    writeJsonLine({ type: "run.finished", ts: nowIso(), ok: true, reasoningReturned: sawReasoning });
  } else {
    process.stdout.write("\n");
  }
  return 0;
}

async function readPromptStdin(prompt: string): Promise<string> {
  if (prompt.trim() !== "-" && process.stdin.isTTY) return "";
  if (prompt.trim() !== "-") return readOptionalStdin(100);
  try {
    let text = "";
    for await (const chunk of process.stdin) {
      text += String(chunk);
    }
    return text;
  } catch {
    return "";
  }
}

function readOptionalStdin(firstChunkTimeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let text = "";
    let settled = false;
    let sawData = false;
    let timer: NodeJS.Timeout | null = setTimeout(() => finish(), firstChunkTimeoutMs);
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onEnd);
      resolve(text);
    };
    const onData = (chunk: Buffer | string) => {
      sawData = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      text += String(chunk);
    };
    const onEnd = () => finish();
    process.stdin.on("data", onData);
    process.stdin.once("end", onEnd);
    process.stdin.once("error", onEnd);
    process.stdin.resume();
    if (sawData && timer) {
      clearTimeout(timer);
      timer = null;
    }
  });
}

function handleBrainEvent(event: BrainStreamEvent, opts: { json: boolean; renderReasoning: boolean; renderState: HumanBrainRenderState }): void {
  if (opts.json) {
    if (event.type === "assistant.delta" || event.type === "reasoning.delta") {
      writeJsonLine({ ...event, ts: nowIso() });
    } else if (event.type === "provider" || event.type === "tool_progress" || event.type === "brain.error") {
      writeJsonLine({ ...event, ts: nowIso() });
    } else if (event.type === "usage") {
      writeJsonLine({ type: "usage", ts: nowIso(), usage: event.usage });
    }
    return;
  }

  if (event.type === "assistant.delta") {
    process.stdout.write(event.text);
  } else if (event.type === "reasoning.delta" && opts.renderReasoning) {
    process.stderr.write(event.text);
  } else if (event.type === "usage") {
    const summary = summarizeUsage(event.usage);
    if (summary) process.stderr.write(`\nusage: ${summary}\n`);
  } else {
    renderBrainEventForHuman(event, opts.renderState, process.stderr);
  }
}
