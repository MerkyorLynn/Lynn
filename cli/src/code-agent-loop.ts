import { streamBrainChat, type BrainStreamEvent, type ChatMessage } from "./brain-client.js";
import { formatBrainErrorForHuman, renderBrainEventForHuman, summarizeUsage, type HumanBrainRenderState } from "./brain-render.js";
import { buildCodePrompt, type CodeContext } from "./code-context.js";
import { buildCodeRuntimeFrames } from "./code-runtime-frames.js";
import { assistantToolCallsForMessages, codeToolDefinitions, createStreamingToolCallAccumulator, parseCodeToolRequests, toolRequestFingerprint, toolRequestsFromCollectedCalls, type CodeToolRequest, type CollectedToolCall } from "./code-tool-protocol.js";
import { formatDangerousToolPreview, isDangerousClientTool, redactToolArgs, renderClientToolResult, renderClientToolStart, resolveToolApproval, ToolApprovalRequiredError, type ToolApprovalRequest } from "./code-tool-render.js";
import { buildCodeContextMessages } from "./context-layers.js";
import { t } from "./i18n.js";
import { nowIso, writeJsonLine } from "./jsonl.js";
import { buildImagesContentParts } from "./media.js";
import { normalizePlanItems, type CodePlanItem } from "./plan-tool.js";
import type { CliProviderProfile } from "./provider-profile.js";
import { parseReasoningOptions, shouldRenderReasoning } from "./reasoning.js";
import { TerminalSpinner, renderCard, renderPlanCard } from "./terminal-spinner.js";
import { dim, supportsColor } from "./terminal-style.js";
import { renderToolLedger, toolLedgerEntry, type ToolLedgerEntry } from "./tool-ledger.js";
import { runClientTool } from "./tools/registry.js";
import type { ClientToolName, ClientToolResult, ToolRunContext } from "./tools/types.js";
import { RESUME_COMPACTION_NOTE, RESUME_REPAIR_NOTE, extractLatestPlan, formatToolResultForLoop } from "./code-resume.js";
import { augmentToolResultSection } from "./code-tool-verify.js";
import { resolveAutoVerifyPlan, runAutoVerify, formatAutoVerifyFeedback, buildAutoVerifyEvent, formatAutoVerifyObservation, isLikelyVerificationCommand } from "./code-autoverify.js";
import { checkPlanContract, defaultToolBudget, checkToolBudget } from "./code-plan-contract.js";
import { createWorkspaceSnapshot, recordWorkspaceSnapshotForRequest, restoreWorkspaceSnapshot, autoRollbackEnabled, type WorkspaceSnapshot } from "./code-snapshot.js";
import { selfVerifyEnabled, buildSelfVerifyPrompt, parseSelfVerifyVerdict, formatSelfVerifyCritique } from "./code-self-verify.js";
import { applyWorkingCheckpoint, formatWorkingCheckpointFrame, workingCheckpointObservation } from "./code-working-checkpoint.js";

const MAX_AUTOVERIFY_REVERIFIES = 3;
const MAX_PLAN_REMINDERS = 2;


export interface CodeAgentLoopInput {
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
  | { type: "auto.verify"; label: string; ok: boolean; ran: boolean; command?: string; attempt?: number; blockedFinish?: boolean; output?: string }
  | { type: "snapshot"; ref: string; restoreCommand: string }
  | { type: "rollback"; ok: boolean; message: string }
  | { type: "self.verify"; pass: boolean }
  | { type: "plan.updated"; items: CodePlanItem[] }
  | { type: "checkpoint.updated"; chars: number }
  | { type: "runtime.compacted"; messages: number }
  | { type: "session.resumed"; path: string; messages: number }
  | { type: "session.checkpoint"; path: string; line: "user" | "assistant" | "tool" }
  | { type: "session.saved"; path: string }
  | { type: "task.finished"; ok: boolean; text: string; usageSummary: string | null; maxStepsReached?: boolean; resumeCommand?: string; sessionPath?: string | null }
  | { type: "error"; message: string };

export interface CodeAgentLoopResult {
  text: string;
  maxStepsReached: boolean;
  usageSummary: string | null;
  usageRecords: Array<{ usage: unknown; durationMs: number }>;
}

interface ClientToolStormState {
  recent: Array<{ fingerprint: string; readOnly: boolean }>;
}

interface ClientToolStormVerdict {
  suppress: boolean;
  repeatCount: number;
}

const TOOL_STORM_WINDOW = 8;
const RUNTIME_COMPACTION_MAX_CHARS = 150_000;
const RUNTIME_COMPACTION_KEEP_GROUPS = 8;

interface AtomicToolPlan {
  deferredIndexes: Set<number>;
}

function planAtomicToolStep(requests: readonly CodeToolRequest[]): AtomicToolPlan {
  const deferredIndexes = new Set<number>();
  let usedActionTool = false;

  requests.forEach((request, index) => {
    if (request.tool === "update_plan") {
      return;
    }
    if (!usedActionTool) {
      usedActionTool = true;
      return;
    }
    deferredIndexes.add(index);
  });

  return { deferredIndexes };
}

function deferredAtomicToolSection(request: CodeToolRequest): string {
  return [
    `Tool result for ${request.tool}:`,
    "Not executed in this atomic tool step.",
    "Lynn returned the first non-plan tool observation before running additional non-plan tools.",
    "No filesystem, network, or shell action was performed for this request.",
  ].join("\n");
}

function createClientToolStormState(seedMessages: readonly ChatMessage[] = []): ClientToolStormState {
  const state: ClientToolStormState = { recent: [] };
  seedClientToolStormState(state, seedMessages);
  return state;
}

function isReadOnlyToolRequest(request: CodeToolRequest): boolean {
  return request.tool === "read_file" || request.tool === "grep" || request.tool === "glob";
}

/** Meta tools touch no files and don't count as real actions (plan, working checkpoint). */
function isMetaTool(tool: ClientToolName): boolean {
  return tool === "update_plan" || tool === "update_working_checkpoint";
}

function observeClientToolRequest(state: ClientToolStormState, request: CodeToolRequest): ClientToolStormVerdict {
  if (isMetaTool(request.tool)) return { suppress: false, repeatCount: 1 };
  const fingerprint = toolRequestFingerprint(request);
  const previous = state.recent.filter((entry) => entry.fingerprint === fingerprint).length;
  if (previous > 0) {
    return { suppress: true, repeatCount: previous + 1 };
  }
  rememberClientToolRequest(state, request);
  return { suppress: false, repeatCount: 1 };
}

function rememberClientToolRequest(state: ClientToolStormState, request: CodeToolRequest): void {
  if (isMetaTool(request.tool)) return;
  const readOnly = isReadOnlyToolRequest(request);
  if (!readOnly) {
    state.recent = state.recent.filter((entry) => !entry.readOnly);
  }
  state.recent.push({ fingerprint: toolRequestFingerprint(request), readOnly });
  if (state.recent.length > TOOL_STORM_WINDOW) {
    state.recent.splice(0, state.recent.length - TOOL_STORM_WINDOW);
  }
}

function seedClientToolStormState(state: ClientToolStormState, messages: readonly ChatMessage[]): void {
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role === "assistant" && message.tool_calls?.length) {
      const completedToolCallIds = completedToolCallsAfter(messages, i);
      const completedCalls = message.tool_calls
        .filter((toolCall) => completedToolCallIds.has(toolCall.id))
        .map((toolCall) => ({
          id: toolCall.id,
          name: toolCall.function.name,
          arguments: toolCall.function.arguments,
        }));
      for (const request of toolRequestsFromCollectedCalls(completedCalls, -1)) {
        rememberClientToolRequest(state, request);
      }
      continue;
    }
    if (message.role !== "assistant" || typeof message.content !== "string") continue;
    const next = messages[i + 1];
    if (next?.role !== "user" || typeof next.content !== "string") continue;
    if (!next.content.includes("Tool result") || next.content.includes(RESUME_REPAIR_NOTE)) continue;
    for (const request of parseCodeToolRequests(message.content)) {
      rememberClientToolRequest(state, request);
    }
  }
}

function completedToolCallsAfter(messages: readonly ChatMessage[], assistantIndex: number): Set<string> {
  const completed = new Set<string>();
  const assistant = messages[assistantIndex];
  const required = new Set(assistant?.role === "assistant" ? assistant.tool_calls?.map((toolCall) => toolCall.id) || [] : []);
  for (let i = assistantIndex + 1; i < messages.length && required.size > 0; i += 1) {
    const candidate = messages[i];
    if (candidate.role !== "tool" || !candidate.tool_call_id || !required.has(candidate.tool_call_id)) break;
    if (typeof candidate.content === "string" && candidate.content.includes(RESUME_REPAIR_NOTE)) break;
    completed.add(candidate.tool_call_id);
    required.delete(candidate.tool_call_id);
  }
  return completed;
}

export async function runCodeAgentLoop(inputData: CodeAgentLoopInput): Promise<CodeAgentLoopResult> {
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
  const runtimeAnchorCount = messages.length;
  let finalText = "";
  let latestUsageSummary: string | null = null;
  const usageRecords: Array<{ usage: unknown; durationMs: number }> = [];
  const approvalSession = { approveAll: false };
  const toolStorm = createClientToolStormState(inputData.resumeMessages);
  const autoVerifyPlan = resolveAutoVerifyPlan(inputData.toolCtx.cwd);
  let mutated = false;
  let lastMutationVerifyOk = false;
  let autoVerifyChecks = 0;
  let autoVerifyReverifies = 0;
  let latestPlan = inputData.resumeMessages ? extractLatestPlan(inputData.resumeMessages) : [];
  const toolBudget = defaultToolBudget(inputData.maxSteps);
  let toolCallCount = 0;
  let budgetWarned = false;
  let planReminders = 0;
  let snapshot: WorkspaceSnapshot | null = null;
  let snapshotAnnounced = false;
  let rolledBack = false;
  let selfVerifyPasses = 0;
  let workingCheckpoint = "";
  for (let step = 0; step < inputData.maxSteps; step += 1) {
    const label = step === 0 ? t("spinner.coding") : t("spinner.reviewing");
    inputData.onEvent?.({ type: "step.started", step, label });
    // Pin the working checkpoint (if any) as the freshest, last thing the model
    // sees — re-derived from state each turn, so it survives history compaction
    // without polluting the persistent transcript.
    const turnMessages = workingCheckpoint
      ? [...messages, { role: "user" as const, content: formatWorkingCheckpointFrame(workingCheckpoint) }]
      : messages;
    const result = await collectBrainText({
      brainUrl: inputData.brainUrl,
      fallbackProvider: inputData.fallbackProvider,
      messages: turnMessages,
      reasoning: inputData.reasoning,
      json: inputData.json,
      label,
      danger: inputData.toolCtx.approval === "yolo" || inputData.toolCtx.sandbox === "danger-full-access",
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
      if (mutated && !lastMutationVerifyOk && autoVerifyPlan.enabled && autoVerifyReverifies < MAX_AUTOVERIFY_REVERIFIES) {
        const outcome = await runAutoVerify(autoVerifyPlan, inputData.toolCtx.cwd);
        if (outcome.ran) {
          autoVerifyChecks += 1;
          const verifyEvent = buildAutoVerifyEvent(outcome, autoVerifyPlan, autoVerifyChecks);
          if (inputData.json) writeJsonLine({ type: "code.auto.verify", ts: nowIso(), ...verifyEvent });
          inputData.onEvent?.({ type: "auto.verify", ...verifyEvent });
          if (!inputData.json && !inputData.onEvent) {
            process.stderr.write(`${renderCard({
              kind: outcome.ok ? "ok" : "error",
              title: `auto-verify · ${outcome.label} · ${outcome.ok ? "passed" : "FAILED"}`,
            }, supportsColor(process.stderr))}\n`);
          }
        }
        const feedback = formatAutoVerifyFeedback(outcome);
        if (feedback) {
          if (autoRollbackEnabled() && snapshot?.available && !rolledBack && autoVerifyReverifies + 1 >= MAX_AUTOVERIFY_REVERIFIES) {
            const restore = restoreWorkspaceSnapshot(inputData.toolCtx.cwd, snapshot);
            rolledBack = true;
            autoVerifyReverifies = 0;
            if (inputData.json) writeJsonLine({ type: "code.rollback", ts: nowIso(), ok: restore.ok, message: restore.message });
            inputData.onEvent?.({ type: "rollback", ok: restore.ok, message: restore.message });
            const rollbackMsg = `${feedback}\n↩ Lynn rolled the workspace back to the pre-task snapshot (${restore.message}). The previous edits could not be made to pass — start over with a smaller, different approach.`;
            messages.push({ role: "user", content: rollbackMsg });
            if (inputData.onCheckpoint) await inputData.onCheckpoint({ type: "user", content: rollbackMsg });
            continue;
          }
          autoVerifyReverifies += 1;
          messages.push({ role: "user", content: feedback });
          if (inputData.onCheckpoint) await inputData.onCheckpoint({ type: "user", content: feedback });
          continue;
        }
      }
      const planVerdict = checkPlanContract(latestPlan);
      if (planVerdict.message && planReminders < MAX_PLAN_REMINDERS) {
        planReminders += 1;
        messages.push({ role: "user", content: planVerdict.message });
        if (inputData.onCheckpoint) await inputData.onCheckpoint({ type: "user", content: planVerdict.message });
        continue;
      }
      if (mutated && selfVerifyEnabled() && selfVerifyPasses < 1) {
        selfVerifyPasses += 1;
        const review = await collectBrainText({
          brainUrl: inputData.brainUrl,
          fallbackProvider: inputData.fallbackProvider,
          messages: [{ role: "user", content: buildSelfVerifyPrompt(inputData.task, assistantText) }],
          reasoning: inputData.reasoning,
          json: inputData.json,
          label: t("spinner.reviewing"),
          danger: inputData.toolCtx.approval === "yolo" || inputData.toolCtx.sandbox === "danger-full-access",
          noTools: true,
          onEvent: inputData.onEvent,
        });
        const verdict = parseSelfVerifyVerdict(review.text);
        if (inputData.json) writeJsonLine({ type: "code.self_verify", ts: nowIso(), pass: verdict.pass });
        inputData.onEvent?.({ type: "self.verify", pass: verdict.pass });
        if (!verdict.pass) {
          const critique = formatSelfVerifyCritique(verdict.issues);
          messages.push({ role: "user", content: critique });
          if (inputData.onCheckpoint) await inputData.onCheckpoint({ type: "user", content: critique });
          continue;
        }
      }
      finalText = assistantText;
      break;
    }
    const toolResultSections: string[] = [];
    const toolLedgerEntries: ToolLedgerEntry[] = [];
    const atomicPlan = planAtomicToolStep(toolRequests);
    for (let toolIndex = 0; toolIndex < toolRequests.length; toolIndex += 1) {
      const toolRequest = toolRequests[toolIndex];
      if (atomicPlan.deferredIndexes.has(toolIndex)) {
        const section = deferredAtomicToolSection(toolRequest);
        toolResultSections.push(section);
        if (inputData.json) {
          writeJsonLine({
            type: "code.tool.deferred",
            ts: nowIso(),
            tool: toolRequest.tool,
            args: redactToolArgs(toolRequest),
            reason: "atomic_tool_step",
          });
        }
        continue;
      }
      const stormVerdict = observeClientToolRequest(toolStorm, toolRequest);
      if (!isMetaTool(toolRequest.tool)) toolCallCount += 1;
      if (inputData.json) writeJsonLine({ type: "code.tool.requested", ts: nowIso(), tool: toolRequest.tool, args: redactToolArgs(toolRequest) });
      const preview = formatDangerousToolPreview(toolRequest.tool, toolRequest.args, supportsColor(inputData.output));
      inputData.onEvent?.({ type: "tool.requested", tool: toolRequest.tool, args: redactToolArgs(toolRequest) as CodeToolRequest["args"], preview });
      if (!inputData.json && !inputData.onEvent && !isMetaTool(toolRequest.tool)) renderClientToolStart(toolRequest);
      let toolResult: ClientToolResult;
      if (stormVerdict.suppress) {
        toolResult = {
          ok: false,
          tool: toolRequest.tool,
          error: "Repeated identical tool request suppressed by Lynn CLI. No action was performed for this duplicate request.",
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
              args: toolRequest.args,
              session: approvalSession,
            });
          }
          if (toolRequest.tool === "write_file" || toolRequest.tool === "apply_patch") {
            snapshot = recordWorkspaceSnapshotForRequest(
              inputData.toolCtx.cwd,
              snapshot || createWorkspaceSnapshot(inputData.toolCtx.cwd),
              toolRequest,
            );
            if (!snapshotAnnounced && snapshot.available && snapshot.ref && snapshot.restoreCommand && (snapshot.entries > 0 || snapshot.skipped.length > 0)) {
              snapshotAnnounced = true;
              if (inputData.json) writeJsonLine({ type: "code.snapshot", ts: nowIso(), ref: snapshot.ref, restoreCommand: snapshot.restoreCommand });
              inputData.onEvent?.({ type: "snapshot", ref: snapshot.ref, restoreCommand: snapshot.restoreCommand });
            }
          }
          if (toolRequest.tool === "update_working_checkpoint") {
            // Meta tool: never reaches the file/exec registry. Just update the
            // pinned scratchpad state and hand back a confirmation observation.
            workingCheckpoint = applyWorkingCheckpoint(toolRequest.args.content);
            if (inputData.json) writeJsonLine({ type: "code.checkpoint.updated", ts: nowIso(), chars: workingCheckpoint.length });
            inputData.onEvent?.({ type: "checkpoint.updated", chars: workingCheckpoint.length });
            toolResult = { ok: true, tool: toolRequest.tool, output: workingCheckpointObservation(workingCheckpoint) };
          } else {
            const effectiveSandbox = toolRequest.tool === "bash"
              && inputData.toolCtx.approval === "ask"
              && effectiveApproval === "yolo"
                ? "danger-full-access"
                : inputData.toolCtx.sandbox;
            toolResult = await runClientTool({ ...inputData.toolCtx, approval: effectiveApproval, sandbox: effectiveSandbox }, {
              name: toolRequest.tool,
              ...toolRequest.args,
            });
          }
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
      let autoVerifyObservation: string | null = null;
      if (
        mutated
        && autoVerifyPlan.enabled
        && toolRequest.tool === "bash"
        && !toolResult.ok
        && isLikelyVerificationCommand(toolRequest.args.command)
        && /requires approval|cancelled by user|interactive confirmation/i.test(String(toolResult.error || ""))
      ) {
        const outcome = await runAutoVerify(autoVerifyPlan, inputData.toolCtx.cwd);
        autoVerifyObservation = formatAutoVerifyObservation(outcome, autoVerifyPlan);
        if (outcome.ran) {
          autoVerifyChecks += 1;
          const verifyEvent = buildAutoVerifyEvent(outcome, autoVerifyPlan, autoVerifyChecks);
          if (inputData.json) writeJsonLine({ type: "code.auto.verify", ts: nowIso(), ...verifyEvent, source: "blocked_verification_tool" });
          inputData.onEvent?.({ type: "auto.verify", ...verifyEvent });
          if (!inputData.json && !inputData.onEvent) {
            process.stderr.write(`${renderCard({
              kind: outcome.ok ? "ok" : "error",
              title: `auto-verify · ${outcome.label} · ${outcome.ok ? "passed" : "FAILED"}`,
              body: ["ran after a verification shell command was blocked"],
            }, supportsColor(process.stderr))}\n`);
          }
        }
      }
      const successfulMutation = toolResult.ok && (toolRequest.tool === "write_file" || toolRequest.tool === "apply_patch");
      if (successfulMutation) {
        mutated = true;
        lastMutationVerifyOk = false;
        if (autoVerifyPlan.enabled) {
          const outcome = await runAutoVerify(autoVerifyPlan, inputData.toolCtx.cwd);
          autoVerifyObservation = [
            autoVerifyObservation,
            formatAutoVerifyObservation(outcome, autoVerifyPlan),
          ].filter(Boolean).join("\n\n");
          if (outcome.ran) {
            lastMutationVerifyOk = outcome.ok;
            autoVerifyChecks += 1;
            const verifyEvent = buildAutoVerifyEvent(outcome, autoVerifyPlan, autoVerifyChecks);
            if (inputData.json) writeJsonLine({ type: "code.auto.verify", ts: nowIso(), ...verifyEvent, source: "post_mutation_tool" });
            inputData.onEvent?.({ type: "auto.verify", ...verifyEvent });
            if (!inputData.json && !inputData.onEvent) {
              process.stderr.write(`${renderCard({
                kind: outcome.ok ? "ok" : "error",
                title: `auto-verify · ${outcome.label} · ${outcome.ok ? "passed" : "FAILED"}`,
                body: ["ran after a file mutation"],
              }, supportsColor(process.stderr))}\n`);
            }
          }
        }
      }
      if (toolRequest.tool === "update_plan") {
        const items = normalizePlanItems(toolRequest.args.plan);
        latestPlan = items;
        if (inputData.json) writeJsonLine({ type: "code.plan.updated", ts: nowIso(), items });
        inputData.onEvent?.({ type: "plan.updated", items });
        if (!inputData.json && !inputData.onEvent) {
          process.stderr.write(`${renderPlanCard(items.map((item) => ({
            status: item.status,
            text: item.content,
          })), supportsColor(process.stderr))}\n`);
        }
      }
      if (inputData.json) writeJsonLine({ type: "code.tool.result", ts: nowIso(), ...toolResult });
      inputData.onEvent?.({ type: "tool.result", result: toolResult });
      if (!inputData.json && !inputData.onEvent && !isMetaTool(toolRequest.tool)) renderClientToolResult(toolResult, process.stderr, toolRequest);
      toolLedgerEntries.push(toolLedgerEntry(toolResult));
      const baseSection = [
        `Tool result for ${toolRequest.tool}:`,
        formatToolResultForLoop(toolResult),
        ...(autoVerifyObservation ? [autoVerifyObservation] : []),
      ].join("\n");
      toolResultSections.push(augmentToolResultSection(toolRequest, toolResult, inputData.toolCtx.cwd, baseSection));
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
        const ledgerMessage = toolLedger;
        messages.push({ role: "user", content: ledgerMessage });
        if (inputData.onCheckpoint) await inputData.onCheckpoint({ type: "user", content: ledgerMessage });
      }
    } else {
      const toolResultMessage = [
        toolResultSections.length === 1 ? "Tool results:" : `Tool results for ${toolResultSections.length} requested tools:`,
        ...toolResultSections,
        toolLedger,
      ].filter(Boolean).join("\n");
      messages.push({
        role: "user",
        content: toolResultMessage,
      });
      if (inputData.onCheckpoint) await inputData.onCheckpoint({ type: "user", content: toolResultMessage });
    }
    const budgetVerdict = checkToolBudget(toolCallCount, toolBudget, budgetWarned);
    if (budgetVerdict.message) {
      budgetWarned = true;
      messages.push({ role: "user", content: budgetVerdict.message });
      if (inputData.onCheckpoint) await inputData.onCheckpoint({ type: "user", content: budgetVerdict.message });
    }
    const compactedMessages = compactRuntimeMessages(messages, undefined, undefined, runtimeAnchorCount);
    if (compactedMessages > 0) {
      if (inputData.json) writeJsonLine({ type: "code.runtime.compacted", ts: nowIso(), messages: compactedMessages });
      inputData.onEvent?.({ type: "runtime.compacted", messages: compactedMessages });
      if (!inputData.json && !inputData.onEvent) {
        process.stderr.write(`${renderCard({
          kind: "info",
          title: `runtime compacted · ${compactedMessages} old messages`,
          body: ["kept the active goal, current plan, and recent tool results"],
        }, supportsColor(process.stderr))}\n`);
      }
    }
  }
  let maxStepsReached = false;
  if (!finalText) {
    maxStepsReached = true;
    finalText = "Stopped after the maximum tool steps. Review the emitted tool results before continuing.";
    if (mutated && autoVerifyPlan.enabled) {
      const outcome = await runAutoVerify(autoVerifyPlan, inputData.toolCtx.cwd);
      if (outcome.ran) {
        autoVerifyChecks += 1;
        if (inputData.json) writeJsonLine({ type: "code.auto.verify", ts: nowIso(), label: outcome.label, ok: outcome.ok, atMaxSteps: true, attempt: autoVerifyChecks });
        inputData.onEvent?.({ type: "auto.verify", label: outcome.label, ok: outcome.ok, ran: outcome.ran });
        finalText += outcome.ok
          ? `\n\n✓ Auto-verification (${outcome.label}) PASSED — the workspace is in a verified-good state despite hitting the step limit.`
          : `\n\n⚠ Auto-verification (${outcome.label}) FAILED at the step limit:\n${outcome.output}`;
      }
    }
  }
  return {
    text: finalText,
    maxStepsReached,
    usageSummary: latestUsageSummary,
    usageRecords,
  };
}

export function compactRuntimeMessages(
  messages: ChatMessage[],
  maxChars = RUNTIME_COMPACTION_MAX_CHARS,
  keepGroups = RUNTIME_COMPACTION_KEEP_GROUPS,
  anchorCount = messages[0]?.role === "system" ? 1 : 0,
): number {
  if (messages.length < keepGroups * 2) return 0;
  const total = messages.reduce((sum, message) => sum + runtimeMessageCost(message), 0);
  if (total <= maxChars) return 0;
  const prefixCount = Math.max(0, Math.min(anchorCount, messages.length));
  const suffixGroups = buildRuntimeMessageGroups(messages.slice(prefixCount)).slice(-keepGroups);
  const keep = suffixGroups.flat();
  const keepSet = new Set(keep);
  const compactable = messages.slice(prefixCount).filter((message) => !keepSet.has(message));
  if (compactable.length < 2) return 0;
  const summary = summarizeRuntimeMessages(compactable);
  messages.splice(prefixCount, messages.length - prefixCount, {
    role: "user",
    content: `[Lynn CLI runtime compaction: ${RESUME_COMPACTION_NOTE}. Compacted ${compactable.length} older message(s) while preserving the active goal, recent tool results, and current plan. Summary:\n${summary}]`,
  }, ...keep);
  return compactable.length;
}

function buildRuntimeMessageGroups(turns: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (let i = 0; i < turns.length; i += 1) {
    const turn = turns[i];
    if (turn.role === "assistant" && turn.tool_calls?.length) {
      const required = new Set(turn.tool_calls.map((toolCall) => toolCall.id));
      const group = [turn];
      let j = i + 1;
      while (j < turns.length && required.size > 0) {
        const candidate = turns[j];
        if (candidate.role !== "tool" || !candidate.tool_call_id || !required.has(candidate.tool_call_id)) break;
        group.push(candidate);
        required.delete(candidate.tool_call_id);
        j += 1;
      }
      groups.push(group);
      i = Math.max(i, j - 1);
      continue;
    }
    if (turn.role === "tool") continue;
    groups.push([turn]);
  }
  return groups;
}

function summarizeRuntimeMessages(messages: readonly ChatMessage[]): string {
  return messages
    .map((message, index) => {
      const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content);
      const clean = content.replace(/\s+/g, " ").trim();
      const label = message.role === "assistant" && message.tool_calls?.length
        ? `assistant tool_calls=${message.tool_calls.map((toolCall) => toolCall.function.name).join(",")}`
        : message.role;
      return `${index + 1}. ${label}: ${clean.slice(0, 360)}${clean.length > 360 ? "..." : ""}`;
    })
    .join("\n")
    .slice(0, 12_000);
}

function runtimeMessageCost(message: ChatMessage): number {
  const contentCost = typeof message.content === "string" ? message.content.length : JSON.stringify(message.content).length;
  const toolCallCost = message.tool_calls?.length ? JSON.stringify(message.tool_calls).length : 0;
  return contentCost + toolCallCost;
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
  danger?: boolean;
  noTools?: boolean;
  onEvent?: (event: CodeAgentEvent) => void;
}): Promise<BrainTextResult> {
  let text = "";
  let usageSummary: string | null = null;
  const usageRecords: Array<{ usage: unknown; durationMs: number }> = [];
  const streamedToolCalls = createStreamingToolCallAccumulator();
  const spinner = new TerminalSpinner(process.stderr, inputData.label, { danger: inputData.danger });
  const renderState: HumanBrainRenderState = {};
  const startedAt = Date.now();
  if (!inputData.json && !inputData.onEvent) spinner.start();
  try {
    for await (const event of streamBrainChat({
      brainUrl: inputData.brainUrl,
      reasoning: inputData.reasoning,
      messages: inputData.messages,
      fallbackProvider: inputData.fallbackProvider,
      tools: inputData.noTools ? undefined : codeToolDefinitions(),
    })) {
      const renderReasoning = shouldRenderReasoning(inputData.reasoning.display, inputData.json);
      if (eventWritesHumanOutput(event, renderReasoning, !!inputData.json || !!inputData.onEvent)) {
        spinner.stop();
      }
      if (event.type === "reasoning.delta" && renderReasoning) {
        inputData.onEvent?.({ type: "reasoning.delta", text: event.text });
        if (inputData.json) writeJsonLine({ type: "reasoning.delta", ts: nowIso(), text: event.text, hidden: true });
        else if (!inputData.onEvent) process.stderr.write(dim(event.text, supportsColor(process.stderr)));
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
          if (!inputData.onEvent && shouldResumeWaitingSpinner(event)) spinner.start();
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

function shouldResumeWaitingSpinner(event: BrainStreamEvent): boolean {
  return event.type === "provider" || event.type === "tool_progress";
}

function eventWritesHumanOutput(event: BrainStreamEvent, renderReasoning: boolean, structuredOutput: boolean): boolean {
  if (structuredOutput) return false;
  return event.type === "assistant.delta"
    || event.type === "provider"
    || event.type === "tool_progress"
    || event.type === "brain.error"
    || event.type === "usage"
    || (event.type === "reasoning.delta" && renderReasoning);
}
