import React, { useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import { getStringFlag, hasFlag, type ParsedArgs } from "./args.js";
import { completeSlash, normalizeSlashInput } from "./completion.js";
import { completeMentionInput } from "./mentions.js";
import { parseCodeResumeSlash, withLongRunCodeFlags, type CodeAgentApprovalRequest, type CodeAgentEvent } from "./commands/code.js";
import { withBestCodeFlags } from "./code-best.js";
import { applyModeCommand, applyReasoningCommand, renderMode, toggleMode, type ChatMode } from "./commands/chat.js";
import { displayCwd } from "./startup.js";
import { HistoryNavigator, appendHistory, historyPath, loadHistory } from "./history.js";
import { parseReasoningOptions, type ReasoningOptions } from "./reasoning.js";
import { resolveEffectivePermissions } from "./permissions.js";
import { resolveCliProviderProfile } from "./provider-profile.js";
import { CLIENT_TOOL_DEFINITIONS } from "./tools/types.js";
import { t } from "./i18n.js";
import { InkDiffText, InkMarkdown } from "./ink-markdown.js";
import { handleInkProviderCommand } from "./ink-provider-commands.js";
import type { CodePlanItem } from "./plan-tool.js";
import { InkInputLine } from "./ink-input-line.js";
import { analyzePastedContext, appendPastedText, summarizePastedContext } from "./pasted-context.js";
import { modelLabelWithId } from "./provider-presets.js";
import { handleMemorySlashCommand } from "./session/memory.js";
import { resolveDataDir } from "./session/store.js";
import { addCodeInputMediaFlags, prepareCodeTaskInput } from "./code-input.js";
import { rotatingPlaceholder } from "./ink-placeholders.js";
import { createDecodeSpeedTracker, type DecodeSpeedTracker } from "./decode-speed.js";
import { terminalTuiProfile } from "./terminal-safety.js";

type CodeItem =
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string }
  | { id: number; kind: "system"; text: string; tone?: "normal" | "danger" | "success" }
  | { id: number; kind: "tool"; title: string; detail?: string; ok?: boolean }
  | { id: number; kind: "plan"; items: CodePlanItem[] };

type NewCodeItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "system"; text: string; tone?: "normal" | "danger" | "success" }
  | { kind: "tool"; title: string; detail?: string; ok?: boolean }
  | { kind: "plan"; items: CodePlanItem[] };

interface InkCodeProps {
  args: ParsedArgs;
  initialReasoning: ReasoningOptions;
  initialMode: ChatMode;
  modelLabel: string;
  runTask: CodeTaskRunner;
}

type CodeTaskRunner = (
  args: ParsedArgs,
  task: string,
  onEvent: (event: CodeAgentEvent) => void,
  options?: { requestApproval?: (request: CodeAgentApprovalRequest) => Promise<"approve" | "approve_all" | "deny"> },
) => Promise<number>;

interface ApprovalState {
  request: CodeAgentApprovalRequest;
}

const CODE_SLASH_COMMANDS = [
  "/exit",
  "/quit",
  "/help",
  "/tools",
  "/fast",
  "/think",
  "/reasoning",
  "/goal",
  "/best",
  "/exhaustive",
  "/resume",
  "/continue",
  "/memory",
  "/memory add",
  "/memory forget",
  "/cwd",
  "/yolo",
  "/ask",
  "/mode",
  "/mode yolo",
  "/model",
  "/model mimo",
  "/model stepfun",
  "/model spark",
  "/providers",
  "/providers set",
];

export async function runInkCode(args: ParsedArgs, runTask: CodeTaskRunner): Promise<number> {
  const permissions = await resolveEffectivePermissions(args);
  const fallbackProvider = (await resolveCliProviderProfile(args))?.profile || null;
  const modelLabel = hasFlag(args.flags, "mock-brain", "mock")
    ? t("code.route.mock")
    : fallbackProvider
      ? `CLI BYOK: ${fallbackProvider.provider} / ${fallbackProvider.model}`
      : t("code.route.brain");
  const instance = render(React.createElement(InkCodeApp, {
    args,
    initialReasoning: parseReasoningOptions(args),
    initialMode: { approval: permissions.approval, sandbox: permissions.sandbox },
    modelLabel,
    runTask,
  }));
  await instance.waitUntilExit();
  return 0;
}

function InkCodeApp(props: InkCodeProps): React.ReactElement {
  const app = useApp();
  const profile = React.useMemo(() => terminalTuiProfile(), []);
  const [input, setInput] = useState("");
  const [items, setItems] = useState<CodeItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [frame, setFrame] = useState(0);
  const [reasoning, setReasoning] = useState(props.initialReasoning);
  const [mode, setMode] = useState(props.initialMode);
  const [usage, setUsage] = useState<string | null>(null);
  const [decodeTps, setDecodeTps] = useState<string | null>(null);
  const [provider, setProvider] = useState(props.modelLabel);
  const [approval, setApproval] = useState<ApprovalState | null>(null);
  const approvalResolve = useRef<((value: "approve" | "approve_all" | "deny") => void) | null>(null);
  const [history] = useState(() => new HistoryNavigator(loadHistory(historyPath())));
  const assistantId = useRef<number | null>(null);
  const decodeTracker = useRef<DecodeSpeedTracker | null>(null);
  const dataDir = React.useMemo(() => resolveDataDir(typeof props.args.flags["data-dir"] === "string" ? props.args.flags["data-dir"] : null), [props.args.flags]);
  const effectiveCwd = getStringFlag(props.args.flags, "cwd") || process.cwd();
  const contextInfo = React.useMemo(() => analyzePastedContext(input, effectiveCwd), [input, effectiveCwd]);

  useEffect(() => {
    if (!busy || !profile.animation) return;
    const timer = setInterval(() => setFrame((value) => value + 1), 140);
    return () => clearInterval(timer);
  }, [busy, profile.animation]);

  const requestApproval = (request: CodeAgentApprovalRequest): Promise<"approve" | "approve_all" | "deny"> => new Promise((resolve) => {
    approvalResolve.current = resolve;
    setApproval({ request });
  });

  const resolveApproval = (decision: "approve" | "approve_all" | "deny") => {
    approvalResolve.current?.(decision);
    approvalResolve.current = null;
    setApproval(null);
    const label = decision === "deny" ? "denied" : decision === "approve_all" ? "approved for this task" : "approved";
    pushItem({ kind: "system", text: `tool ${label}`, tone: decision === "deny" ? "danger" : "success" });
  };

  const pushItem = (item: NewCodeItem) => {
    setItems((current) => [...current, { ...item, id: Date.now() + Math.floor(Math.random() * 1000) } as CodeItem].slice(-14));
  };

  useInput((value, key) => {
    if (approval) {
      const text = value.toLowerCase();
      if (text === "a") resolveApproval("approve_all");
      else if (text === "y") resolveApproval("approve");
      else if (text === "n" || key.escape || (key.ctrl && text === "c")) resolveApproval("deny");
      return;
    }
    if (busy) return;
    if (key.ctrl && value === "c") {
      app.exit();
      return;
    }
    if ((key.shift && key.tab) || value === "\u001b[Z") {
      const next = { ...mode };
      const message = toggleMode(next);
      setMode(next);
      pushItem({ kind: "system", text: message, tone: next.approval === "yolo" ? "danger" : "success" });
      return;
    }
    const newlineIndex = value.search(/[\r\n]/);
    if (!key.return && newlineIndex >= 0) {
      const lines = value.replace(/\r\n?/g, "\n").split("\n");
      if (!lines.slice(1).some((line) => line.length > 0)) {
        void submitInput(`${input}${lines[0] || ""}`);
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
      void submitInput(`${input}${prefix}`);
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
        if (completion.matches.length > 1) pushItem({ kind: "system", text: completion.matches.slice(0, 12).join("  ") });
        setInput(completion.completed);
        return;
      }
      const completion = completeSlash(input, CODE_SLASH_COMMANDS);
      if (completion.matches.length > 1) pushItem({ kind: "system", text: completion.matches.join("  ") });
      setInput(completion.completed);
      return;
    }
    if (value) setInput((current) => current + value);
  });

  const submitInput = async (raw: string) => {
    const text = normalizeSlashInput(raw.trim());
    if (!text) return;
    setInput("");
    appendHistory(text, historyPath());
    if (text === "/exit" || text === "/quit") {
      app.exit();
      return;
    }
    if (text === "/help") {
      pushItem({ kind: "system", text: t("code.help") });
      return;
    }
    if (text === "/cwd" || text === "/pwd") {
      pushItem({ kind: "system", text: t("cwd.info", { cwd: effectiveCwd }) });
      return;
    }
    const memoryCommand = await handleMemorySlashCommand(text, dataDir);
    if (memoryCommand?.handled) {
      pushItem({ kind: "system", text: memoryCommand.message, tone: memoryCommand.changed ? "success" : "normal" });
      return;
    }
    if (text === "/tools") {
      pushItem({ kind: "system", text: CLIENT_TOOL_DEFINITIONS.map((tool) => `${tool.name}${tool.dangerous ? t("tool.approval.suffix") : ""}: ${tool.description}`).join("\n") });
      return;
    }
    if (text === "/fast") {
      setReasoning((current) => ({ ...current, effort: "off" }));
      pushItem({ kind: "system", text: t("code.fast"), tone: "success" });
      return;
    }
    if (text === "/think") {
      setReasoning((current) => ({ ...current, effort: "high" }));
      pushItem({ kind: "system", text: t("code.think"), tone: "success" });
      return;
    }
    if (text.startsWith("/reasoning ")) {
      const result = applyReasoningCommand(reasoning, text.slice(11).trim());
      setReasoning(result.reasoning);
      pushItem({ kind: "system", text: result.message, tone: "success" });
      return;
    }
    if (text === "/goal") {
      pushItem({ kind: "system", text: t("code.goal.usage") });
      return;
    }
    if (text.startsWith("/goal ")) {
      const task = text.slice(6).trim();
      pushItem({ kind: "system", text: t("code.goal.started"), tone: "success" });
      await runCodeText(task, (flags) => withBestCodeFlags(flags));
      return;
    }
    if (text === "/best" || text === "/exhaustive") {
      pushItem({ kind: "system", text: t("code.best.usage") });
      return;
    }
    if (text.startsWith("/best ") || text.startsWith("/exhaustive ")) {
      const task = text.replace(/^\/(?:best|exhaustive)\s+/i, "").trim();
      pushItem({ kind: "system", text: t("code.best.started"), tone: "success" });
      await runCodeText(task, (flags) => withBestCodeFlags(flags));
      return;
    }
    if (text === "/resume" || text === "/continue" || text.startsWith("/resume ") || text.startsWith("/continue ")) {
      const parsed = parseCodeResumeSlash(text);
      pushItem({ kind: "system", text: t("code.resume.started", { resume: parsed.resume }), tone: "success" });
      await runCodeText(parsed.task, (flags) => withLongRunCodeFlags({ ...flags, resume: parsed.resume }));
      return;
    }
    if (text === "/yolo" || text === "/ask") {
      const next = { ...mode };
      const message = applyModeCommand(next, text.slice(1));
      setMode(next);
      pushItem({ kind: "system", text: message, tone: next.approval === "yolo" ? "danger" : "success" });
      return;
    }
    if (text.startsWith("/mode ")) {
      const next = { ...mode };
      const message = applyModeCommand(next, text.slice(6).trim());
      setMode(next);
      pushItem({ kind: "system", text: message, tone: next.approval === "yolo" ? "danger" : "success" });
      return;
    }
    const providerCommand = await handleInkProviderCommand(text, props.args);
    if (providerCommand.handled) {
      if (providerCommand.refreshedProvider !== undefined) {
        setProvider(providerCommand.refreshedProvider
          ? `CLI BYOK: ${modelLabelWithId(providerCommand.refreshedProvider.model)}`
          : props.modelLabel);
      }
      pushItem({ kind: "system", text: providerCommand.message });
      return;
    }
    if (text.startsWith("/")) {
      pushItem({ kind: "system", text: t("slash.unknown") });
      return;
    }

    await runCodeText(text);
  };

  const runCodeText = async (
    text: string,
    transformFlags: (flags: Record<string, string | boolean>) => Record<string, string | boolean> = (flags) => flags,
  ) => {
    const prepared = prepareCodeTaskInput(text, effectiveCwd, t("chat.image.defaultPrompt"));
    pushItem({ kind: "user", text: prepared.contextSummary ? `${prepared.task}\n${prepared.contextSummary}` : prepared.task });
    assistantId.current = Date.now() + 1;
    decodeTracker.current = createDecodeSpeedTracker(Date.now());
    setDecodeTps(null);
    setItems((current) => [...current, { id: assistantId.current!, kind: "assistant" as const, text: "" }].slice(-14));
    setBusy(true);
    try {
      const taskArgs: ParsedArgs = {
        ...props.args,
        positionals: [prepared.task],
        flags: addCodeInputMediaFlags(transformFlags({
          ...props.args.flags,
          approval: mode.approval,
          sandbox: mode.sandbox,
          reasoning: reasoning.effort,
          "show-reasoning": reasoning.display,
        }), prepared.mediaPaths),
      };
      await props.runTask(taskArgs, prepared.task, handleAgentEvent, { requestApproval });
    } catch (error) {
      pushItem({ kind: "system", text: error instanceof Error ? error.message : String(error), tone: "danger" });
    } finally {
      setBusy(false);
      assistantId.current = null;
      decodeTracker.current = null;
    }
  };

  const handleAgentEvent = (event: CodeAgentEvent) => {
    if (event.type === "provider") setProvider(event.provider);
    if (event.type === "usage") setUsage(event.summary);
    if (event.type === "step.started") pushItem({ kind: "system", text: `${event.label} · step ${event.step + 1}` });
    if (event.type === "reasoning.delta") {
      pushItem({ kind: "system", text: event.text.slice(-180) });
    }
    if (event.type === "assistant.delta") {
      const id = assistantId.current;
      if (!id) return;
      const nextDecodeTps = decodeTracker.current?.add(event.text);
      if (nextDecodeTps) setDecodeTps(nextDecodeTps);
      setItems((current) => current.map((item) => item.id === id && item.kind === "assistant" ? { ...item, text: `${item.text}${event.text}` } : item));
    }
    if (event.type === "tool.progress") pushItem({ kind: "system", text: event.message });
    if (event.type === "tool.requested") {
      pushItem({ kind: "tool", title: `tool ${event.tool}`, detail: event.preview || formatToolArgs(event.args) });
    }
    if (event.type === "tool.loop_guard") pushItem({ kind: "tool", title: `loop guard ${event.tool}`, detail: `${event.repeats} repeats`, ok: false });
    if (event.type === "plan.updated") pushItem({ kind: "plan", items: event.items });
    if (event.type === "session.resumed") {
      pushItem({ kind: "system", text: t("code.session.resumed", { path: event.path, messages: String(event.messages) }), tone: "success" });
    }
    if (event.type === "session.saved") {
      pushItem({ kind: "system", text: t("code.session.saved", { path: event.path }), tone: "success" });
    }
    if (event.type === "tool.result") {
      if (event.result.tool === "update_plan") return;
      pushItem({ kind: "tool", title: event.result.tool, detail: event.result.error || summarizeOutput(event.result.output), ok: event.result.ok });
    }
    if (event.type === "task.finished" && event.maxStepsReached) {
      pushItem({
        kind: "system",
        text: event.resumeCommand ? t("code.resume.maxSteps", { command: event.resumeCommand }) : t("code.resume.maxStepsFallback"),
        tone: "danger",
      });
    }
  };

  const danger = mode.approval === "yolo" || mode.sandbox === "danger-full-access";
  const recent = items.slice(-12);
  return React.createElement(Box, { flexDirection: "column", paddingX: 1 },
    React.createElement(Box, { borderStyle: "round", borderColor: danger ? "red" : "gray", paddingX: 1, flexDirection: "column" },
      React.createElement(Text, { bold: true }, "Lynn Code"),
      React.createElement(Text, null, `模型: ${provider}`),
      React.createElement(Text, { color: danger ? "red" : undefined }, `权限: ${renderMode(mode)}   Shift+Tab / /yolo / /ask`),
      React.createElement(Text, null, `目录: ${displayCwd(effectiveCwd)}   cd / --cwd 切换`),
    ),
    danger ? React.createElement(Text, { color: "red", bold: true }, "YOLO: local edits and shell commands are allowed") : null,
    React.createElement(Box, { marginTop: 1, flexDirection: "column" },
      recent.length ? recent.map((item) => React.createElement(CodeItemView, { key: item.id, item })) : React.createElement(Text, { color: "gray" }, t("code.placeholder")),
    ),
    busy ? profile.animation
      ? React.createElement(Box, { flexDirection: "row" },
        React.createElement(InkShimmerText, { text: t("spinner.coding"), frame }),
        React.createElement(Text, null, " "),
        React.createElement(InkSweep, { width: 28, frame }),
      )
      : React.createElement(Text, { color: "cyan" }, t("spinner.coding"))
    : null,
    React.createElement(Text, { color: "gray" }, `${provider} · ${displayCwd(effectiveCwd)} · ${renderMode(mode)} · think ${reasoning.effort}${decodeTps ? ` · decode ${decodeTps}` : ""}${usage ? ` · ${usage}` : ""}`),
    approval ? React.createElement(ApprovalPrompt, { approval }) : React.createElement(InkInputLine, {
      value: input,
      placeholder: profile.dynamicPlaceholders ? rotatingPlaceholder("code", frame) : t("code.placeholder"),
      danger,
      commands: CODE_SLASH_COMMANDS,
      contextSummary: contextInfo.hasContext ? summarizePastedContext(contextInfo) : "",
    }),
  );
}

function CodeItemView({ item }: { item: CodeItem }): React.ReactElement {
  if (item.kind === "user") return React.createElement(Text, null, `› ${item.text}`);
  if (item.kind === "assistant") return React.createElement(MarkdownText, { text: item.text || "…" });
  if (item.kind === "tool") {
    const color = item.ok === false ? "red" : item.ok === true ? "green" : "cyan";
    return React.createElement(Box, { flexDirection: "column" },
      React.createElement(Text, { color }, `${item.ok === false ? "×" : item.ok === true ? "✓" : "•"} ${item.title}`),
      item.detail ? React.createElement(InkDiffText, { text: item.detail }) : null,
    );
  }
  if (item.kind === "plan") return React.createElement(PlanView, { items: item.items });
  return React.createElement(Text, { color: item.tone === "danger" ? "red" : item.tone === "success" ? "green" : "gray" }, item.text);
}

function PlanView({ items }: { items: CodePlanItem[] }): React.ReactElement {
  return React.createElement(Box, { borderStyle: "round", borderColor: "gray", paddingX: 1, flexDirection: "column" },
    React.createElement(Text, { color: "cyan", bold: true }, "TodoWrite · Update todos"),
    ...items.map((item, index) => React.createElement(Text, { key: item.id || index, color: item.status === "completed" ? "green" : item.status === "in_progress" ? "yellow" : "gray" },
      `${item.status === "completed" ? "✓" : item.status === "in_progress" ? "●" : "○"} ${item.id || `P${index + 1}`}: ${item.content}`,
    )),
  );
}

function ApprovalPrompt({ approval }: { approval: ApprovalState }): React.ReactElement {
  return React.createElement(Box, { marginTop: 1, borderStyle: "double", borderColor: "red", paddingX: 1, flexDirection: "column" },
    React.createElement(Text, { color: "red", bold: true }, `${approval.request.tool} requires approval`),
    approval.request.preview ? React.createElement(InkDiffText, { text: approval.request.preview }) : null,
    React.createElement(Text, null, "y approve · a approve all for this task · n deny"),
  );
}

function MarkdownText({ text }: { text: string }): React.ReactElement {
  return React.createElement(InkMarkdown, { text });
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

function formatToolArgs(args: Record<string, unknown>): string {
  return Object.entries(args).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}: ${String(value)}`).join(" · ");
}

function summarizeOutput(output: unknown): string {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  if (!text) return "(no output)";
  return text.length > 400 ? `${text.slice(0, 400)}...` : text;
}
