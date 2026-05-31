import { getStringFlag, hasFlag, type ParsedArgs } from "../args.js";
import { streamBrainChat, type BrainStreamEvent, type ChatMessage } from "../brain-client.js";
import { formatBrainErrorForHuman, renderBrainEventForHuman, summarizeUsage, type HumanBrainRenderState } from "../brain-render.js";
import { nowIso, writeJsonLine } from "../jsonl.js";
import { parseReasoningOptions, shouldRenderReasoning } from "../reasoning.js";
import { appendSessionTurn, resolveDataDir } from "../session/store.js";
import { TerminalSpinner } from "../terminal-spinner.js";
import { resolveCliProviderProfile } from "../provider-profile.js";
import { t } from "../i18n.js";
import { buildImagesContentParts, parseImageList } from "../media.js";
import { resetCliRuntimeMessages } from "../runtime-context.js";
import { isLocalRuntimeQuestion, localeForText, renderLocalRuntimeAnswer } from "../runtime-answer.js";
import { chatRouteLabel } from "./chat.js";
import { resolveDefaultBrainUrl } from "../brain-url.js";

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
  const brainUrl = await resolveDefaultBrainUrl(args);
  const saveSession = hasFlag(args.flags, "save-session", "session") || !!process.env.LYNN_CLI_SAVE_SESSION;
  const sessionPath = getStringFlag(args.flags, "session");
  const dataDir = resolveDataDir(getStringFlag(args.flags, "data-dir"));
  const title = getStringFlag(args.flags, "title");
  const cliProvider = await resolveCliProviderProfile(args);
  const imagePaths = promptImagePaths(args);

  if (options.json) {
    writeJsonLine({ type: "run.started", ts: nowIso(), prompt, reasoning, ...(imagePaths.length ? { images: imagePaths } : {}) });
  }

  if (!imagePaths.length && isLocalRuntimeQuestion(prompt)) {
    const text = renderLocalRuntimeAnswer({
      routeLabel: chatRouteLabel(cliProvider?.profile),
      brainUrl,
      cwd: process.cwd(),
      reasoning: reasoning.effort,
    }, localeForText(prompt));
    if (options.json) {
      writeJsonLine({ type: "assistant.delta", ts: nowIso(), text });
      writeJsonLine({ type: "run.finished", ts: nowIso(), ok: true, local: true });
    } else {
      process.stdout.write(`${text}\n`);
    }
    if (saveSession) {
      const savedPath = await appendSessionTurn({ dataDir, sessionPath, cwd: process.cwd(), title, prompt, assistant: text, modelProvider: "lynn-cli", modelId: "local-runtime" });
      if (options.json) writeJsonLine({ type: "session.saved", ts: nowIso(), path: savedPath });
    }
    return 0;
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
  const startedAt = Date.now();
  if (!options.json) spinner.start();
  try {
    const userContent = imagePaths.length ? await buildImagesContentParts(imagePaths, prompt) : prompt;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let attemptAssistant = "";
      let attemptSawReasoning = false;
      const retryVisibleAnswer = attempt > 0;
      const messages: ChatMessage[] = [
        ...resetCliRuntimeMessages(chatRouteLabel(cliProvider?.profile)),
        ...(retryVisibleAnswer
          ? [{
              role: "system" as const,
              content: "The previous attempt returned hidden reasoning without a visible answer. Return a concise visible final answer in assistant content. Do not return reasoning only.",
            }]
          : []),
        {
          role: "user" as const,
          content: userContent,
        },
      ];
      for await (const event of streamBrainChat({
        brainUrl,
        messages,
        reasoning,
        fallbackProvider: cliProvider?.profile,
      })) {
        const renderReasoning = shouldRenderReasoning(reasoning.display, !!options.json);
        if (!options.json && eventWritesHumanOutput(event, renderReasoning)) {
          spinner.stop();
        }
        if (event.type === "brain.error") {
          if (options.json) {
            handleBrainEvent(event, {
              json: true,
              renderReasoning,
              renderState,
              startedAt,
            });
          }
          throw new Error(formatBrainErrorForHuman(event.error, event.code));
        }
        handleBrainEvent(event, {
          json: !!options.json,
          renderReasoning,
          renderState,
          startedAt,
        });
        if (event.type === "provider") {
          if (event.activeProvider.startsWith("cli-byok:") && cliProvider) {
            modelProvider = cliProvider.profile.provider;
            modelId = cliProvider.profile.model;
          } else {
            modelProvider = event.activeProvider;
            modelId = "lynn-brain-router";
          }
        }
        if (event.type === "reasoning.delta") {
          sawReasoning = true;
          attemptSawReasoning = true;
        }
        if (event.type === "assistant.delta") attemptAssistant += event.text;
      }
      if (attemptAssistant.trim()) {
        assistant = attemptAssistant;
        break;
      }
      if (attemptSawReasoning && attempt === 0) {
        if (options.json) {
          writeJsonLine({
            type: "run.retry",
            ts: nowIso(),
            code: "empty_visible_answer",
            reason: "hidden_reasoning_only",
          });
        }
        continue;
      }
      assistant = attemptAssistant;
      break;
    }
  } finally {
    spinner.stop();
  }
  if (!assistant.trim()) {
    const message = sawReasoning ? t("prompt.emptyAfterReasoning") : t("prompt.empty");
    if (options.json) {
      writeJsonLine({
        type: "run.finished",
        ts: nowIso(),
        ok: false,
        code: "empty_visible_answer",
        error: message,
        reasoningReturned: sawReasoning,
      });
    } else {
      process.stderr.write(`${message}\n`);
    }
    return 2;
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

function eventWritesHumanOutput(event: BrainStreamEvent, renderReasoning: boolean): boolean {
  return event.type === "assistant.delta"
    || event.type === "provider"
    || event.type === "tool_progress"
    || event.type === "brain.error"
    || event.type === "usage"
    || (event.type === "reasoning.delta" && renderReasoning);
}

function promptImagePaths(args: ParsedArgs): string[] {
  return [
    ...parseImageList(getStringFlag(args.flags, "images")),
    ...parseImageList(getStringFlag(args.flags, "image", "shot")),
  ];
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
      process.stdin.pause();
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

function handleBrainEvent(event: BrainStreamEvent, opts: { json: boolean; renderReasoning: boolean; renderState: HumanBrainRenderState; startedAt?: number }): void {
  if (opts.json) {
    if (event.type === "assistant.delta" || event.type === "reasoning.delta") {
      writeJsonLine({ ...event, ts: nowIso() });
    } else if (event.type === "provider" || event.type === "tool_progress" || event.type === "brain.error") {
      writeJsonLine({ ...event, ts: nowIso() });
    } else if (event.type === "usage") {
      writeJsonLine({ type: "usage", ts: nowIso(), usage: event.usage, durationMs: opts.startedAt ? Date.now() - opts.startedAt : undefined });
    }
    return;
  }

  if (event.type === "assistant.delta") {
    process.stdout.write(event.text);
  } else if (event.type === "reasoning.delta" && opts.renderReasoning) {
    process.stderr.write(event.text);
  } else if (event.type === "usage") {
    const summary = summarizeUsage(event.usage, { durationMs: opts.startedAt ? Date.now() - opts.startedAt : undefined });
    if (summary) process.stderr.write(`\nusage: ${summary}\n`);
  } else {
    renderBrainEventForHuman(event, opts.renderState, process.stderr);
  }
}
