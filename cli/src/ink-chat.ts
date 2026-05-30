import React, { useEffect, useMemo, useState } from "react";
import { Box, Static, Text, render, useApp, useInput } from "ink";
import { detectImageProtocol, renderImageThumbnail } from "./terminal-image.js";
import { getStringFlag, hasFlag, type ParsedArgs } from "./args.js";
import { streamBrainChat, type BrainStreamEvent, type ChatMessage } from "./brain-client.js";
import { formatBrainErrorForHuman, summarizeUsage } from "./brain-render.js";
import { HistoryNavigator, appendHistory, historyPath, loadHistory } from "./history.js";
import { t } from "./i18n.js";
import { completeSlash } from "./completion.js";
import { normalizeSlashInput } from "./completion.js";
import { completeMentionInput } from "./mentions.js";
import { parseReasoningOptions, shouldRenderReasoning, type ReasoningOptions } from "./reasoning.js";
import { resolveCliProviderProfile, type CliProviderProfile } from "./provider-profile.js";
import { resolveEffectivePermissions } from "./permissions.js";
import { displayCwd } from "./startup.js";
import { CHAT_SLASH_COMMANDS, applyModeCommand, applyReasoningCommand, chatRouteLabel, renderMode, type ChatMode } from "./commands/chat.js";
import { InkMarkdown } from "./ink-markdown.js";
import { handleInkProviderCommand } from "./ink-provider-commands.js";
import { InkInputLine } from "./ink-input-line.js";
import { refreshCliRuntimeSystemMessage, resetCliRuntimeMessages } from "./runtime-context.js";
import { analyzePastedContext, appendPastedText, parseImagePromptCommand, summarizeImageRefs, summarizePastedContext } from "./pasted-context.js";
import { buildImagesContentParts } from "./media.js";
import { buildMemoryContextFrameSync, handleMemorySlashCommand } from "./session/memory.js";
import { resolveDataDir } from "./session/store.js";
import { rotatingPlaceholder } from "./ink-placeholders.js";
import { resolveDefaultBrainUrl } from "./brain-url.js";

type Turn = {
  id: number;
  role: "user" | "assistant" | "system";
  text: string;
  meta?: string;
  pending?: boolean;
  error?: boolean;
};

interface InkChatProps {
  args: ParsedArgs;
  brainUrl: string;
  mockBrain: boolean;
  initialReasoning: ReasoningOptions;
  initialMode: ChatMode;
  fallbackProvider?: CliProviderProfile | null;
}

export async function runInkChat(args: ParsedArgs): Promise<number> {
  const mockBrain = hasFlag(args.flags, "mock-brain", "mock");
  const brainUrl = await resolveDefaultBrainUrl(args);
  const initialReasoning = parseReasoningOptions(args);
  const permissions = await resolveEffectivePermissions(args);
  const initialMode: ChatMode = { approval: permissions.approval, sandbox: permissions.sandbox };
  const fallbackProvider = (await resolveCliProviderProfile(args))?.profile || null;
  const instance = render(React.createElement(InkChatApp, {
    args,
    brainUrl,
    mockBrain,
    initialReasoning,
    initialMode,
    fallbackProvider,
  }));
  await instance.waitUntilExit();
  return 0;
}

type Thumb = { id: number; esc: string };

async function emitThumbnails(text: string, cwd: string, setThumbs: (updater: (prev: Thumb[]) => Thumb[]) => void): Promise<void> {
  const protocol = detectImageProtocol();
  if (!protocol) return;
  const refs = analyzePastedContext(text, cwd).imageRefs;
  if (!refs.length) return;
  const next: Thumb[] = [];
  for (const ref of refs) {
    const esc = await renderImageThumbnail(ref.path, protocol, { widthCells: 28, heightCells: 8, maxBytes: 6_000_000 });
    if (esc) next.push({ id: Date.now() + next.length, esc });
  }
  if (next.length) setThumbs((prev) => [...prev, ...next]);
}

function InkChatApp(props: InkChatProps): React.ReactElement {
  const app = useApp();
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [frame, setFrame] = useState(0);
  const [reasoning, setReasoning] = useState(props.initialReasoning);
  const [mode, setMode] = useState(props.initialMode);
  const [fallbackProvider, setFallbackProvider] = useState<CliProviderProfile | null>(props.fallbackProvider || null);
  const [provider, setProvider] = useState(chatRouteLabel(props.fallbackProvider));
  const [usage, setUsage] = useState<string | null>(null);
  const [thumbs, setThumbs] = useState<Thumb[]>([]);
  const [history] = useState(() => new HistoryNavigator(loadHistory(historyPath())));
  const dataDir = useMemo(() => resolveDataDir(getStringFlag(props.args.flags, "data-dir")), [props.args.flags]);
  const effectiveCwd = getStringFlag(props.args.flags, "cwd") || process.cwd();
  const contextInfo = useMemo(() => analyzePastedContext(input, effectiveCwd), [input, effectiveCwd]);
  const [memoryFrame, setMemoryFrame] = useState(() => buildMemoryContextFrameSync(dataDir));
  const messages = useMemo<ChatMessage[]>(() => resetCliRuntimeMessages(chatRouteLabel(props.fallbackProvider), memoryFrame), [props.fallbackProvider]);

  useEffect(() => {
    const timer = setInterval(() => setFrame((value) => value + 1), busy ? 90 : 4_000);
    return () => clearInterval(timer);
  }, [busy]);

  useInput((value, key) => {
    if (busy) return;
    if (key.ctrl && value === "c") {
      app.exit();
      return;
    }
    const newlineIndex = value.search(/[\r\n]/);
    if (!key.return && newlineIndex >= 0) {
      const lines = value.replace(/\r\n?/g, "\n").split("\n");
      if (!lines.slice(1).some((line) => line.length > 0)) {
        void submitInput({
          text: `${input}${lines[0] || ""}`,
          setInput,
          setTurns,
          setBusy,
          setProvider,
          setUsage,
          setReasoning,
          setMode,
          fallbackProvider,
          setFallbackProvider,
          appExit: app.exit,
          messages,
          props,
          reasoning,
          mode,
          dataDir,
          memoryFrame,
          setMemoryFrame,
          cwd: effectiveCwd,
        });
        return;
      }
      setInput((current) => appendPastedText(current, value));
      return;
    }
    if (key.return && (key.shift || key.meta)) {
      const prefix = newlineIndex >= 0 ? value.slice(0, newlineIndex) : "";
      setInput((current) => `${current}${prefix}\n`);
      return;
    }
    if (key.return && input.endsWith("\\")) {
      const prefix = newlineIndex >= 0 ? value.slice(0, newlineIndex) : "";
      setInput((current) => `${current.slice(0, -1)}${prefix}\n`);
      return;
    }
    if (key.return) {
      const prefix = newlineIndex >= 0 ? value.slice(0, newlineIndex) : "";
      const submitted = `${input}${prefix}`;
      void emitThumbnails(submitted, effectiveCwd, setThumbs);
      void submitInput({
        text: submitted,
        setInput,
        setTurns,
        setBusy,
        setProvider,
        setUsage,
        setReasoning,
        setMode,
        fallbackProvider,
        setFallbackProvider,
        appExit: app.exit,
        messages,
        props,
        reasoning,
        mode,
        dataDir,
        memoryFrame,
        setMemoryFrame,
        cwd: effectiveCwd,
      });
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => Array.from(current).slice(0, -1).join(""));
      return;
    }
    if (key.upArrow) {
      setInput((current) => history.prev(current));
      return;
    }
    if (key.downArrow) {
      setInput(history.next());
      return;
    }
    if (key.tab) {
      const mentionCompletion = completeMentionInput(input, effectiveCwd);
      if (mentionCompletion) {
        const completion = mentionCompletion;
        if (completion.matches.length > 1) {
          setTurns((current) => [...current, { id: Date.now(), role: "system", text: completion.matches.slice(0, 12).join("  "), meta: "completions" }]);
        }
        setInput(completion.completed);
        return;
      }
      const completion = completeSlash(input, CHAT_SLASH_COMMANDS);
      if (completion.matches.length > 1) {
        setTurns((current) => [...current, { id: Date.now(), role: "system", text: completion.matches.join("  "), meta: "completions" }]);
      }
      setInput(completion.completed);
      return;
    }
    if (value) setInput((current) => current + value);
  });

  const recentTurns = turns.slice(-8);
  return React.createElement(Box, { flexDirection: "column", paddingX: 1 },
    React.createElement(Static, {
      items: thumbs,
      children: (item: unknown) => {
        const thumb = item as Thumb;
        return React.createElement(Box, { key: thumb.id, height: 8 }, React.createElement(Text, null, thumb.esc));
      },
    }),
    React.createElement(Box, { borderStyle: "round", borderColor: "gray", paddingX: 1, flexDirection: "column" },
      React.createElement(Text, { bold: true }, "Lynn CLI"),
      React.createElement(Text, null, `模型: ${provider}`),
      React.createElement(Text, null, `权限: ${renderMode(mode)}   Shift+Tab / /yolo / /ask`),
      React.createElement(Text, null, `Brain: ${props.brainUrl}`),
      React.createElement(Text, null, `目录: ${displayCwd(effectiveCwd)}   cd / --cwd 切换`),
    ),
    React.createElement(Box, { marginTop: 1, flexDirection: "column" },
      recentTurns.length
        ? recentTurns.map((turn) => React.createElement(TurnView, { key: turn.id, turn }))
        : React.createElement(Text, { color: "gray" }, t("chat.placeholder")),
    ),
    busy
      ? React.createElement(Box, { flexDirection: "row" },
        React.createElement(InkShimmerText, { text: t("spinner.thinking"), frame }),
        React.createElement(Text, null, " "),
        React.createElement(InkSweep, { width: 28, frame }),
      )
      : null,
    React.createElement(Text, { color: "gray" }, `${provider} · ${displayCwd(effectiveCwd)} · ${renderMode(mode)} · think ${reasoning.effort}${usage ? ` · ${usage}` : ""}`),
    React.createElement(InkInputLine, {
      value: input,
      placeholder: rotatingPlaceholder("chat", frame),
      danger: mode.approval === "yolo" || mode.sandbox === "danger-full-access",
      commands: CHAT_SLASH_COMMANDS,
      contextSummary: contextInfo.hasContext ? summarizePastedContext(contextInfo) : "",
    }),
  );
}

function TurnView({ turn }: { turn: Turn }): React.ReactElement {
  if (turn.role === "user") {
    return React.createElement(Box, { marginTop: 1, flexDirection: "column" },
      React.createElement(Box, null,
        React.createElement(Text, { color: "gray" }, "› "),
        React.createElement(Text, null, turn.text),
      ),
      turn.meta ? React.createElement(Text, { color: "cyan" }, `  ${turn.meta}`) : null,
    );
  }
  if (turn.role === "system") {
    return React.createElement(Text, { color: turn.error ? "red" : "gray" }, turn.text);
  }
  return React.createElement(Box, { marginTop: 1, flexDirection: "column" },
    turn.meta ? React.createElement(Text, { color: "gray" }, turn.meta) : null,
    React.createElement(InkMarkdown, { text: turn.text, error: turn.error }),
  );
}

function InkShimmerText({ text, frame }: { text: string; frame: number }): React.ReactElement {
  const chars = Array.from(text);
  const head = frame % (chars.length + 6);
  return React.createElement(Text, null,
    ...chars.map((char, index) => {
      const distance = Math.abs(index - head);
      if (distance === 0) return React.createElement(Text, { key: index, color: "cyan", bold: true }, char);
      if (distance <= 1) return React.createElement(Text, { key: index, color: "cyan" }, char);
      if (distance <= 3) return React.createElement(Text, { key: index, color: "gray" }, char);
      return React.createElement(Text, { key: index }, char);
    }),
  );
}

function InkSweep({ width, frame }: { width: number; frame: number }): React.ReactElement {
  const head = (frame % (width + 8)) - 4;
  return React.createElement(Text, null,
    ...Array.from({ length: width }, (_, index) => {
      const distance = Math.abs(index - head);
      if (distance === 0) return React.createElement(Text, { key: index, color: "cyan", bold: true }, "━");
      if (distance <= 1) return React.createElement(Text, { key: index, color: "cyan" }, "━");
      if (distance <= 3) return React.createElement(Text, { key: index, color: "gray" }, "─");
      return React.createElement(Text, { key: index }, " ");
    }),
  );
}

async function submitInput(inputData: {
  text: string;
  setInput: (value: string) => void;
  setTurns: React.Dispatch<React.SetStateAction<Turn[]>>;
  setBusy: (value: boolean) => void;
  setProvider: (value: string) => void;
  setUsage: (value: string | null) => void;
  setReasoning: (value: ReasoningOptions) => void;
  setMode: (value: ChatMode) => void;
  fallbackProvider: CliProviderProfile | null;
  setFallbackProvider: (value: CliProviderProfile | null) => void;
  appExit: () => void;
  messages: ChatMessage[];
  props: InkChatProps;
  reasoning: ReasoningOptions;
  mode: ChatMode;
  dataDir: string;
  memoryFrame: string;
  setMemoryFrame: (value: string) => void;
  cwd: string;
}): Promise<void> {
  const text = normalizeSlashInput(inputData.text.trim());
  if (!text) return;
  inputData.setInput("");
  appendHistory(text, historyPath());

  if (text === "/exit" || text === "/quit") {
    inputData.appExit();
    return;
  }
  if (text === "/fast") {
    const next = { ...inputData.reasoning, effort: "off" as const };
    inputData.setReasoning(next);
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: t("chat.fast") }]);
    return;
  }
  if (text === "/think") {
    const next = { ...inputData.reasoning, effort: "high" as const };
    inputData.setReasoning(next);
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: t("chat.think") }]);
    return;
  }
  if (text.startsWith("/reasoning ")) {
    const result = applyReasoningCommand(inputData.reasoning, text.slice(11).trim());
    inputData.setReasoning(result.reasoning);
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: result.message }]);
    return;
  }
  if (text === "/yolo" || text === "/ask") {
    const next = { ...inputData.mode };
    const message = applyModeCommand(next, text.slice(1));
    inputData.setMode(next);
    const danger = next.approval === "yolo" || next.sandbox === "danger-full-access";
    const body = danger ? `${message}\n${t("mode.yolo.factory")}` : message;
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: body, error: danger }]);
    return;
  }
  if (text.startsWith("/mode ")) {
    const next = { ...inputData.mode };
    const message = applyModeCommand(next, text.slice(6).trim());
    inputData.setMode(next);
    const danger = next.approval === "yolo" || next.sandbox === "danger-full-access";
    const body = danger ? `${message}\n${t("mode.yolo.factory")}` : message;
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: body, error: danger }]);
    return;
  }
  if (text === "/help") {
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: t("chat.help") }]);
    return;
  }
  if (text === "/clear") {
      inputData.messages.splice(0, inputData.messages.length, ...resetCliRuntimeMessages(chatRouteLabel(inputData.fallbackProvider), inputData.memoryFrame));
      inputData.setTurns([]);
      return;
    }
  if (text === "/cwd" || text === "/pwd") {
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: t("cwd.info", { cwd: inputData.cwd }) }]);
    return;
  }
  const memoryCommand = await handleMemorySlashCommand(text, inputData.dataDir);
  if (memoryCommand?.handled) {
    if (memoryCommand.changed) {
      const nextMemoryFrame = buildMemoryContextFrameSync(inputData.dataDir);
      inputData.setMemoryFrame(nextMemoryFrame);
      refreshCliRuntimeSystemMessage(inputData.messages, chatRouteLabel(inputData.fallbackProvider), nextMemoryFrame);
    }
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: memoryCommand.message }]);
    return;
  }
  const providerCommand = await handleInkProviderCommand(text, inputData.props.args);
  if (providerCommand.handled) {
    if (providerCommand.refreshedProvider !== undefined) {
      inputData.setFallbackProvider(providerCommand.refreshedProvider);
      const nextRoute = chatRouteLabel(providerCommand.refreshedProvider);
      refreshCliRuntimeSystemMessage(inputData.messages, nextRoute, inputData.memoryFrame);
      inputData.setProvider(nextRoute);
    }
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: providerCommand.message }]);
    return;
  }
  const imageCommand = parseImagePromptCommand(text, inputData.cwd);
  if (imageCommand) {
    if (!imageCommand.imageRefs.length) {
      inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: t("chat.image.usage") }]);
      return;
    }
    let userContent: ChatMessage["content"];
    try {
      userContent = await buildImagesContentParts(imageCommand.imageRefs.map((ref) => ref.path), imageCommand.prompt);
    } catch (error) {
      inputData.setTurns((current) => [...current, {
        id: Date.now(),
        role: "system",
        text: t("chat.image.readError", { error: error instanceof Error ? error.message : String(error) }),
        error: true,
      }]);
      return;
    }
    await submitChatTurn({
      ...inputData,
      promptText: imageCommand.prompt,
      userContent,
      contextSummary: summarizeImageRefs(imageCommand.imageRefs),
    });
    return;
  }
  if (text.startsWith("/")) {
    inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: t("slash.unknown") }]);
    return;
  }

  const context = analyzePastedContext(text, inputData.cwd);
  const promptText = context.text || (context.imageRefs.length ? t("chat.image.defaultPrompt") : text);
  let userContent: ChatMessage["content"] = promptText;
  const contextSummary = context.hasContext ? summarizePastedContext(context) : "";
  if (context.imageRefs.length) {
    try {
      userContent = await buildImagesContentParts(context.imageRefs.map((ref) => ref.path), promptText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      inputData.setTurns((current) => [...current, { id: Date.now(), role: "system", text: `图片上下文无法读取:${message}`, error: true }]);
      return;
    }
  }

  await submitChatTurn({
    ...inputData,
    promptText,
    userContent,
    contextSummary,
  });
}

async function submitChatTurn(inputData: {
  setTurns: React.Dispatch<React.SetStateAction<Turn[]>>;
  setBusy: (value: boolean) => void;
  setProvider: (value: string) => void;
  setUsage: (value: string | null) => void;
  messages: ChatMessage[];
  props: InkChatProps;
  reasoning: ReasoningOptions;
  fallbackProvider: CliProviderProfile | null;
  promptText: string;
  userContent: ChatMessage["content"];
  contextSummary: string;
}): Promise<void> {
  const userTurn: Turn = { id: Date.now(), role: "user", text: inputData.promptText, meta: inputData.contextSummary };
  const assistantId = userTurn.id + 1;
  inputData.setTurns((current) => [...current, userTurn, { id: assistantId, role: "assistant", text: "", pending: true }]);
  inputData.messages.push({ role: "user", content: inputData.userContent });
  inputData.setBusy(true);

  if (inputData.props.mockBrain) {
    const answer = t("mock.response", { text: inputData.promptText });
    inputData.messages.push({ role: "assistant", content: answer });
    inputData.setTurns((current) => current.map((turn) => turn.id === assistantId ? { ...turn, text: answer, pending: false, meta: "mock Brain" } : turn));
    inputData.setBusy(false);
    return;
  }

  let assistant = "";
  const startedAt = Date.now();
  try {
    for await (const event of streamBrainChat({
      brainUrl: inputData.props.brainUrl,
      messages: inputData.messages,
      reasoning: inputData.reasoning,
      fallbackProvider: inputData.fallbackProvider,
    })) {
      if (event.type === "provider") inputData.setProvider(event.activeProvider);
      if (event.type === "usage") inputData.setUsage(summarizeUsage(event.usage, { durationMs: Date.now() - startedAt }));
      if (event.type === "brain.error") throw new Error(formatBrainErrorForHuman(event.error, event.code));
      if (event.type === "reasoning.delta" && shouldRenderReasoning(inputData.reasoning.display, false)) {
        inputData.setTurns((current) => current.map((turn) => turn.id === assistantId ? { ...turn, meta: `${turn.meta || ""}${event.text}`.slice(-180) } : turn));
      }
      if (event.type !== "assistant.delta") continue;
      assistant += event.text;
      inputData.setTurns((current) => current.map((turn) => turn.id === assistantId ? { ...turn, text: assistant, pending: false } : turn));
    }
    inputData.messages.push({ role: "assistant", content: assistant });
  } catch (error) {
    inputData.messages.pop();
    const message = error instanceof Error ? error.message : String(error);
    inputData.setTurns((current) => current.map((turn) => turn.id === assistantId ? { ...turn, text: message, pending: false, error: true } : turn));
  } finally {
    inputData.setBusy(false);
  }
}
