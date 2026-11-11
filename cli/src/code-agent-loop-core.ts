import { brainToolEvidenceMessages } from "../../shared/brain-tool-evidence.js";
import { drainCompletedJobs } from "./background-jobs.js";
import { type ChatMessage } from "./brain-client.js";
import { formatBrainErrorForHuman, summarizeUsage, thinkingStatusLabel, type HumanBrainRenderState } from "./brain-render.js";
import { streamBrainTurn } from "./brain-turn-stream.js";
import { collectBrainText, createClientToolStormState, createTurnForwarder, evidenceMessageFromToolProgress, observeClientToolRequest, planModeBlockedReason, recoverAnswerFromEvidence } from "./code-agent-loop-support.js";
import type { CodeAgentLoopCoreResult, InternalCodeAgentLoopInput, PermissionDenial } from "./code-agent-loop-types.js";
import { buildAutoVerifyEvent, formatAutoVerifyFeedback, formatAutoVerifyObservation, isLikelyVerificationCommand, resolveAutoVerifyPlan, runAutoVerify } from "./code-autoverify.js";
import { compactConversation, shouldCompact } from "./code-compaction.js";
import { buildCodePrompt } from "./code-context.js";
import { checkPlanContract, checkToolBudget, defaultToolBudget } from "./code-plan-contract.js";
import { extractLatestPlan, formatToolResultForLoop } from "./code-resume.js";
import { compactRuntimeMessages } from "./code-runtime-compaction.js";
import { createCliLiveCompactionAdapter } from "./live-compaction-adapter.js";
import { buildCodeRuntimeFrames } from "./code-runtime-frames.js";
import { buildSelfVerifyPrompt, formatSelfVerifyCritique, parseSelfVerifyVerdict, selfVerifyEnabled } from "./code-self-verify.js";
import { autoRollbackEnabled, createWorkspaceSnapshot, recordWorkspaceSnapshotForRequest, restoreWorkspaceSnapshot, type WorkspaceSnapshot } from "./code-snapshot.js";
import { assistantToolCallsForMessages, codeToolDefinitions, parseCodeToolRequests, toolRequestFingerprint, toolRequestsFromCollectedCalls, type CodeToolRequest } from "./code-tool-protocol.js";
import { ToolApprovalRequiredError, formatDangerousToolPreview, isDangerousClientTool, redactToolArgs, renderClientToolResult, renderClientToolStart, resolveToolApproval, type ToolApprovalRequest } from "./code-tool-render.js";
import { augmentToolResultSection } from "./code-tool-verify.js";
import { applyWorkingCheckpoint, formatWorkingCheckpointFrame, workingCheckpointObservation } from "./code-working-checkpoint.js";
import { buildCodeContextMessages } from "./context-layers.js";
import { loadHookConfig, runHooks, type HookConfig } from "./hooks.js";
import { t } from "./i18n.js";
import { nowIso, writeJsonLine } from "./jsonl.js";
import { buildImagesContentParts } from "./media.js";
import { alwaysAllowRule, decidePermission, loadPermissionRules, saveAlwaysAllowRule } from "./permission-rules.js";
import { normalizePlanItems } from "./plan-tool.js";
import { formatSkillListing, loadSkillCatalog } from "./skills.js";
import { TerminalSpinner, renderCard, renderPlanCard } from "./terminal-spinner.js";
import { supportsColor } from "./terminal-style.js";
import { renderToolLedger, toolLedgerEntry, type ToolLedgerEntry } from "./tool-ledger.js";
import { applyToolResultBudget } from "./tool-result-budget.js";
import { isMetaTool, isReadOnlyTool } from "./tool-scheduler.js";
import { clearReadState } from "./tools/read-state.js";
import { runClientTool } from "./tools/registry.js";
import type { ClientToolResult } from "./tools/types.js";


const MAX_AUTOVERIFY_REVERIFIES = 3;

const MAX_PLAN_REMINDERS = 2;
export async function runCodeAgentLoopCore(inputData: InternalCodeAgentLoopInput): Promise<CodeAgentLoopCoreResult> {
  inputData.signal?.throwIfAborted();
  const frames = buildCodeRuntimeFrames(inputData);
  const skills = await loadSkillCatalog(inputData.toolCtx.cwd);
  if (skills.length) {
    frames.push({
      kind: "cacheable_context",
      source: "cli",
      title: "Skills",
      text: formatSkillListing(skills),
    });
  }
  const hookConfig: HookConfig = await loadHookConfig(inputData.toolCtx.cwd);
  const emitHookWarning = (message: string): void => {
    if (inputData.json) writeJsonLine({ type: "code.hook.warning", ts: nowIso(), message });
    inputData.onEvent?.({ type: "hook.warning", message });
  };
  for (const warning of hookConfig.errors) emitHookWarning(warning);
  const hookBase = {
    cwd: inputData.toolCtx.cwd,
    timestamp: nowIso(),
    session_id: inputData.lifecycle.snapshot().runId,
    permission_mode: inputData.toolCtx.approval,
  };
  const sessionHook = await runHooks("SessionStart", { ...hookBase, event: "SessionStart", prompt: inputData.task }, hookConfig);
  for (const warning of sessionHook.warnings) emitHookWarning(`SessionStart: ${warning}`);
  const promptHook = await runHooks("UserPromptSubmit", { ...hookBase, event: "UserPromptSubmit", prompt: inputData.task }, hookConfig);
  for (const warning of promptHook.warnings) emitHookWarning(`UserPromptSubmit: ${warning}`);
  if (promptHook.blocked) throw new Error(`Blocked by UserPromptSubmit hook: ${promptHook.reason || "no reason given"}`);

  const initialPrompt = [
    sessionHook.additionalContext ? `<session-start-hook>\n${sessionHook.additionalContext}\n</session-start-hook>` : "",
    buildCodePrompt(inputData.task, inputData.context, inputData.imagePaths),
    promptHook.additionalContext ? `<user-prompt-hook>\n${promptHook.additionalContext}\n</user-prompt-hook>` : "",
  ].filter(Boolean).join("\n\n");
  const initialContent = inputData.imagePaths?.length
    ? await buildImagesContentParts(inputData.imagePaths, initialPrompt)
    : initialPrompt;
  let { messages } = buildCodeContextMessages({
    frames,
    resumeMessages: inputData.resumeMessages,
    currentUserContent: initialContent,
  });
  const runtimeAnchorCount = messages.length;
  const runId = inputData.lifecycle.snapshot().runId;
  const liveCompaction = createCliLiveCompactionAdapter(runId);
  let permissionRules = await loadPermissionRules(inputData.toolCtx.cwd);
  for (const invalid of permissionRules.rules.errors) {
    if (inputData.json) writeJsonLine({ type: "code.permission.rule_invalid", ts: nowIso(), error: invalid });
    inputData.onEvent?.({ type: "permission.rule_invalid", message: invalid });
  }
  let finalText = "";
  let latestUsageSummary: string | null = null;
  const usageRecords: Array<{ usage: unknown; durationMs: number }> = [];
  const approvalSession = { approveAll: false, alwaysAllow: false };
  const hookContexts = new Map<number, string>();
  const permissionDenials: PermissionDenial[] = [];
  const deniedIndexes = new Set<number>();
  const recordDenial = (index: number, tool: string, reason: string, source: PermissionDenial["source"]): void => {
    if (deniedIndexes.has(index)) return;
    deniedIndexes.add(index);
    permissionDenials.push({ tool, reason, source });
  };

  const notifyCompletedJobs = async (): Promise<void> => {
    const completed = await drainCompletedJobs();
    for (const { job, tail } of completed) {
      const notification = [
        "<task-notification>",
        `<task-id>${job.id}</task-id>`,
        "<status>completed</status>",
        `<exit>${job.exitCode ?? job.signal ?? "unknown"}</exit>`,
        `<command>${job.command}</command>`,
        `<log path="${job.logPath}">`,
        tail.trim(),
        "</log>",
        "</task-notification>",
      ].join("\n");
      messages.push({ role: "user", content: notification });
      if (inputData.onCheckpoint) await inputData.onCheckpoint({ type: "user", content: notification });
      if (inputData.json) {
        writeJsonLine({
          type: "code.background.completed",
          ts: nowIso(),
          id: job.id,
          exitCode: job.exitCode,
          signal: job.signal,
          logPath: job.logPath,
          command: job.command,
        });
      }
      inputData.onEvent?.({
        type: "background.job",
        id: job.id,
        exitCode: job.exitCode,
        signal: job.signal,
        logPath: job.logPath,
      });
    }
  };
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

  const rememberAllowRule = async (toolRequest: CodeToolRequest): Promise<void> => {
    const rule = alwaysAllowRule(toolRequest.tool, toolRequest.args as Record<string, unknown>);
    if (!rule) return;
    try {
      const savedPath = await saveAlwaysAllowRule(rule);
      permissionRules = await loadPermissionRules(inputData.toolCtx.cwd);
      if (inputData.json) writeJsonLine({ type: "code.permission.rule_saved", ts: nowIso(), rule, path: savedPath });
      inputData.onEvent?.({ type: "permission.rule_saved", rule, path: savedPath });
    } catch {
      // Persisting a rule is best-effort; never fail the tool call for it.
    }
  };

  // Model-backed compaction with a deterministic fallback. Runs at the same point
  // Claude Code does: after a tool round, before the next request.
  const compactNow = async (): Promise<{ engine: "live" | "model" | "fallback"; compacted: number; summaryChars: number } | null> => {
    const maxChars = Math.max(20_000, Number(process.env.LYNN_CLI_COMPACT_CHARS || 150_000) || 150_000);
    const live = await liveCompaction.compactAsync(messages);
    const liveResult = live ? { engine: "live" as const, compacted: live.replaced, summaryChars: 0 } : null;
    if (!shouldCompact(messages, maxChars)) return liveResult;
    try {
      const outcome = await compactConversation({
        messages,
        keepGroups: Math.max(2, Number(process.env.LYNN_CLI_COMPACT_KEEP_GROUPS || 6) || 6),
        maxChars,
        anchorCount: runtimeAnchorCount,
        cwd: inputData.toolCtx.cwd,
        runId,
        complete: async (prompt) => {
          const result = await collectBrainText({
            brainUrl: inputData.brainUrl,
            fallbackProvider: inputData.fallbackProvider,
            messages: [{ role: "user", content: prompt }],
            reasoning: inputData.reasoning,
            json: false,
            label: t("spinner.compacting"),
            noTools: true,
            onEvent: () => {},
            signal: inputData.signal,
          });
          return result.text;
        },
      });
      if (!outcome) return liveResult;
      messages = outcome.messages;
      clearReadState();
      if (inputData.onCheckpoint) {
        await inputData.onCheckpoint({
          type: "user",
          content: String(outcome.boundary.content),
          data: { compaction: "boundary", compacted: outcome.compactedCount, summaryChars: outcome.summary.length },
        });
        if (outcome.refreshMessage) {
          await inputData.onCheckpoint({
            type: "user",
            content: String(outcome.refreshMessage.content),
            data: { compaction: "refresh" },
          });
        }
      }
      return { engine: "model", compacted: outcome.compactedCount + (liveResult?.compacted || 0), summaryChars: outcome.summary.length };
    } catch {
      const fallback = compactRuntimeMessages(messages, undefined, undefined, runtimeAnchorCount);
      return fallback > 0
        ? { engine: "fallback", compacted: fallback + (liveResult?.compacted || 0), summaryChars: 0 }
        : liveResult;
    }
  };

  for (let step = 0; step < inputData.maxSteps; step += 1) {
    inputData.signal?.throwIfAborted();
    const label = step === 0 ? t("spinner.coding") : t("spinner.reviewing");
    inputData.onEvent?.({ type: "step.started", step, label });
    await notifyCompletedJobs();
    // Pin the working checkpoint (if any) as the freshest, last thing the model
    // sees — re-derived from state each turn, so it survives history compaction
    // without polluting the persistent transcript.
    const turnMessages = workingCheckpoint
      ? [...messages, { role: "user" as const, content: formatWorkingCheckpointFrame(workingCheckpoint) }]
      : messages;
    const turnAbort = new AbortController();
    const abortTurn = () => turnAbort.abort(inputData.signal?.reason ?? new Error("aborted"));
    if (inputData.signal?.aborted) abortTurn();
    else inputData.signal?.addEventListener("abort", abortTurn, { once: true });

    const scheduledRequests: CodeToolRequest[] = [];
    const toolOutcomes: Array<{ section: string; ledger: ToolLedgerEntry | null; result: ClientToolResult; requested: CodeToolRequest }> = [];
    const executions: Array<Promise<void>> = [];
    let writeBarrier: Promise<void> = Promise.resolve();
    let activeReads = 0;
    const readWaiters: Array<() => void> = [];
    const configuredReadCap = Number(process.env.LYNN_CLI_READ_CONCURRENCY || 6);
    const readCap = Number.isFinite(configuredReadCap) ? Math.min(32, Math.max(1, Math.floor(configuredReadCap))) : 6;
    const acquireRead = async (): Promise<void> => {
      if (activeReads < readCap) {
        activeReads += 1;
        return;
      }
      await new Promise<void>((resolve) => readWaiters.push(resolve));
      activeReads += 1;
    };
    const releaseRead = (): void => {
      activeReads = Math.max(0, activeReads - 1);
      readWaiters.shift()?.();
    };

    const executeToolRequest = async (toolIndex: number, signal: AbortSignal): Promise<void> => {
      signal.throwIfAborted();
      const toolRequest = scheduledRequests[toolIndex]!;
      const stormVerdict = observeClientToolRequest(toolStorm, toolRequest);
      const lifecycleCallId = toolRequest.toolCallId || `lynn_call_${step}_${toolIndex}`;
      const lifecycleToolStart = inputData.lifecycle.beginTool(
        lifecycleCallId,
        toolRequest.tool,
        toolRequestFingerprint(toolRequest),
      );
      if (!isMetaTool(toolRequest.tool)) toolCallCount += 1;
      if (inputData.json) writeJsonLine({ type: "code.tool.requested", ts: nowIso(), index: toolIndex, tool: toolRequest.tool, args: redactToolArgs(toolRequest) });
      const preview = formatDangerousToolPreview(toolRequest.tool, toolRequest.args, supportsColor(inputData.output));
      inputData.onEvent?.({ type: "tool.requested", index: toolIndex, tool: toolRequest.tool, args: redactToolArgs(toolRequest) as CodeToolRequest["args"], preview });
      if (!inputData.json && !inputData.onEvent && !isMetaTool(toolRequest.tool)) renderClientToolStart(toolRequest);
      let toolResult: ClientToolResult;
      if (!lifecycleToolStart.accepted) {
        toolResult = {
          ok: false,
          tool: toolRequest.tool,
          error: lifecycleToolStart.conflict
            ? "Conflicting reuse of a tool call id was suppressed by Lynn CLI. No action was performed."
            : "Duplicate tool call id was suppressed by Lynn CLI. No action was performed twice.",
        };
        if (inputData.json) {
          writeJsonLine({ type: "code.tool.loop_guard", ts: nowIso(), tool: toolRequest.tool, args: redactToolArgs(toolRequest), repeats: 2, reason: "duplicate_call_id" });
        }
        inputData.onEvent?.({ type: "tool.loop_guard", tool: toolRequest.tool, repeats: 2 });
      } else if (stormVerdict.suppress) {
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
          const blockedByPlan = planModeBlockedReason(inputData.toolCtx.planMode, toolRequest.tool, toolRequest.args);
          if (blockedByPlan) {
            recordDenial(toolIndex, toolRequest.tool, blockedByPlan, "plan");
            throw new Error(blockedByPlan);
          }
          let effectiveApproval: ToolApprovalRequest["approval"] = inputData.toolCtx.approval;
          const ruleVerdict = decidePermission(toolRequest.tool, toolRequest.args as Record<string, unknown>, permissionRules.rules);
          if (ruleVerdict.decision === "deny") {
            const reason = `Blocked by permission rule ${ruleVerdict.rule}: ${ruleVerdict.reason}. Edit ~/.lynn/permissions/cli.json if this is intended.`;
            recordDenial(toolIndex, toolRequest.tool, reason, "rule");
            throw new Error(reason);
          }
          const preHook = await runHooks("PreToolUse", {
            ...hookBase,
            event: "PreToolUse",
            tool: toolRequest.tool,
            tool_input: toolRequest.args as Record<string, unknown>,
          }, hookConfig);
          for (const warning of preHook.warnings) emitHookWarning(`PreToolUse ${toolRequest.tool}: ${warning}`);
          if (preHook.blocked) {
            const reason = `Blocked by PreToolUse hook: ${preHook.reason || "no reason given"}`;
            recordDenial(toolIndex, toolRequest.tool, reason, "hook");
            throw new Error(reason);
          }
          if (preHook.additionalContext) hookContexts.set(toolIndex, preHook.additionalContext);
          const hookAsk = preHook.decision === "ask";
          const hookAllow = preHook.decision === "allow";
          const askViaPrompt = async (): Promise<void> => {
            inputData.lifecycle.transition("waiting_approval");
            const decision = await inputData.requestApproval!({
              tool: toolRequest.tool,
              args: redactToolArgs(toolRequest) as CodeToolRequest["args"],
              cwd: inputData.toolCtx.cwd,
              preview,
            });
            inputData.lifecycle.transition("waiting_tool");
            if (decision === "deny") {
              recordDenial(toolIndex, toolRequest.tool, "denied by user", "user");
              throw new Error(`${toolRequest.tool} cancelled by user`);
            }
            if (decision === "approve_all") approvalSession.approveAll = true;
            if (decision === "always") await rememberAllowRule(toolRequest);
            effectiveApproval = "yolo";
          };
          if (hookAsk || (ruleVerdict.decision === "ask" && ruleVerdict.rule)) {
            if (inputData.toolCtx.approval === "never") {
              const reason = `Explicit rule or hook requires approval for ${toolRequest.tool}, but approval mode is never`;
              recordDenial(toolIndex, toolRequest.tool, reason, "mode");
              throw new Error(reason);
            }
            if (!inputData.requestApproval) {
              const reason = `Explicit rule or hook requires approval for ${toolRequest.tool}; no interactive approval is available`;
              recordDenial(toolIndex, toolRequest.tool, reason, "mode");
              throw new Error(reason);
            }
            await askViaPrompt();
          } else if (ruleVerdict.decision === "allow" || hookAllow) {
            effectiveApproval = "yolo";
          } else if (
            inputData.requestApproval &&
            isDangerousClientTool(toolRequest.tool) &&
            inputData.toolCtx.approval === "ask" &&
            !approvalSession.approveAll
          ) {
            await askViaPrompt();
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
            if (approvalSession.alwaysAllow) {
              approvalSession.alwaysAllow = false;
              await rememberAllowRule(toolRequest);
            }
          }
          if (toolRequest.tool === "write_file" || toolRequest.tool === "apply_patch" || toolRequest.tool === "edit") {
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
          if (toolRequest.tool === "exit_plan_mode") {
            const planText = typeof toolRequest.args.plan === "string" ? toolRequest.args.plan.trim() : "";
            if (inputData.json) writeJsonLine({ type: "code.plan.presented", ts: nowIso(), text: planText });
            inputData.onEvent?.({ type: "plan.presented", text: planText });
            toolResult = {
              ok: true,
              tool: "exit_plan_mode",
              output: {
                plan: planText,
                note: "Plan recorded. Writes are still blocked in plan mode; ask the user to approve and switch modes (Shift+Tab or /ask).",
              },
            };
          } else if (toolRequest.tool === "update_working_checkpoint") {
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
            toolResult = await runClientTool({ ...inputData.toolCtx, approval: effectiveApproval, sandbox: effectiveSandbox, signal, runId }, {
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
          const message = error instanceof Error ? error.message : String(error);
          if (/requires approval|current mode is never|no interactive approval/i.test(message)) {
            recordDenial(toolIndex, toolRequest.tool, message, "mode");
          }
          toolResult = {
            ok: false,
            tool: toolRequest.tool,
            error: message,
          };
        }
      }
      inputData.lifecycle.finishTool(lifecycleCallId, {
        ok: toolResult.ok,
        cancelled: /cancelled by user/i.test(String(toolResult.error || "")),
        error: toolResult.error || null,
      });
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
      const budgeted = await applyToolResultBudget(toolResult, { runId });
      const finalResult = budgeted.result;
      const postHook = await runHooks("PostToolUse", {
        ...hookBase,
        event: "PostToolUse",
        tool: toolRequest.tool,
        tool_input: toolRequest.args as Record<string, unknown>,
        tool_result: finalResult,
      }, hookConfig);
      for (const warning of postHook.warnings) emitHookWarning(`PostToolUse ${toolRequest.tool}: ${warning}`);
      const hookContext = [hookContexts.get(toolIndex), postHook.additionalContext]
        .filter((value): value is string => !!value)
        .join("\n\n");
      const baseSection = [
        `Tool result for ${toolRequest.tool}:`,
        formatToolResultForLoop(finalResult, 24_000),
        ...(autoVerifyObservation ? [autoVerifyObservation] : []),
        ...(hookContext ? [`[hook context]\n${hookContext}`] : []),
      ].join("\n");
      toolOutcomes[toolIndex] = {
        result: finalResult,
        requested: toolRequest,
        ledger: toolLedgerEntry(finalResult),
        section: augmentToolResultSection(toolRequest, finalResult, inputData.toolCtx.cwd, baseSection),
      };
      if (inputData.json) writeJsonLine({ type: "code.tool.result", ts: nowIso(), index: toolIndex, ...finalResult });
      inputData.onEvent?.({ type: "tool.result", result: finalResult, index: toolIndex });
      if (!inputData.json && !inputData.onEvent && !isMetaTool(toolRequest.tool)) {
        renderClientToolResult(finalResult, process.stderr, toolRequest);
      }
    };


    const scheduleRequest = (request: CodeToolRequest): void => {
      const index = scheduledRequests.length;
      scheduledRequests.push(request);
      const serial = !isReadOnlyTool(request.tool) || isMetaTool(request.tool);
      const run = async (): Promise<void> => {
        try {
          if (serial) {
            await executeToolRequest(index, turnAbort.signal);
            return;
          }
          await acquireRead();
          try {
            await executeToolRequest(index, turnAbort.signal);
          } finally {
            releaseRead();
          }
        } catch (error) {
          // executeToolRequest normally turns failures into results; this is the
          // last resort so one broken tool can never leave the turn without a
          // matching tool result.
          if (toolOutcomes[index]) return;
          const result: ClientToolResult = {
            ok: false,
            tool: request.tool,
            error: error instanceof Error ? error.message : String(error),
          };
          toolOutcomes[index] = {
            result,
            requested: request,
            ledger: toolLedgerEntry(result),
            section: `Tool result for ${request.tool}:\n${JSON.stringify(result, null, 2)}`,
          };
          if (inputData.json) writeJsonLine({ type: "code.tool.result", ts: nowIso(), index, ...result });
          inputData.onEvent?.({ type: "tool.result", result, index });
          if (!inputData.json && !inputData.onEvent && !isMetaTool(request.tool)) {
            renderClientToolResult(result, process.stderr, request);
          }
        }
      };
      // A write waits for everything before it and blocks everything after it.
      const started = (serial ? Promise.all([...executions]) : writeBarrier).then(run);
      if (serial) writeBarrier = started.then(() => undefined, () => undefined);
      executions.push(started.catch(() => undefined));
    };

    const spinner = new TerminalSpinner(process.stderr, label, {
      danger: inputData.toolCtx.approval === "yolo" || inputData.toolCtx.sandbox === "danger-full-access",
    });
    const renderState: HumanBrainRenderState = {};
    const turnStartedAt = Date.now();
    const brainEvidenceMessages: ChatMessage[] = [];
    let assistantText = "";
    let streamFailure: Error | null = null;
    const forward = createTurnForwarder({
      json: inputData.json,
      onEvent: inputData.onEvent,
      reasoning: inputData.reasoning,
      spinner,
      renderState,
      startedAt: turnStartedAt,
      onText: (chunk) => { assistantText += chunk; },
      onUsage: (usage, durationMs) => {
        usageRecords.push({ usage, durationMs });
        const summary = summarizeUsage(usage, { durationMs });
        latestUsageSummary = summary || latestUsageSummary;
        if (summary) inputData.onEvent?.({ type: "usage", summary });
        if (inputData.json) writeJsonLine({ type: "usage", ts: nowIso(), usage, durationMs });
        if (!inputData.json && !inputData.onEvent) {
          const waiting = thinkingStatusLabel(usage, turnStartedAt);
          if (waiting) spinner.setLabel(waiting);
        }
      },
      onEvidence: (event) => {
        const evidence = brainToolEvidenceMessages(event);
        if (evidence.length) {
          turnMessages.push(...evidence);
        } else {
          const message = evidenceMessageFromToolProgress(event);
          if (message) brainEvidenceMessages.push(message);
        }
      },
    });

    if (!inputData.json && !inputData.onEvent) spinner.start();
    try {
      for await (const event of streamBrainTurn({
        brainUrl: inputData.brainUrl,
        fallbackProvider: inputData.fallbackProvider,
        messages: turnMessages,
        reasoning: inputData.reasoning,
        tools: codeToolDefinitions(),
        signal: turnAbort.signal,
      })) {
        if (event.type === "tool_call") {
          for (const request of toolRequestsFromCollectedCalls([event.call], step, scheduledRequests.length)) {
            scheduleRequest(request);
          }
          continue;
        }
        if (event.type === "error") {
          streamFailure = new Error(formatBrainErrorForHuman(event.error.error, event.error.code));
          continue;
        }
        if (event.type === "done") continue;
        forward(event);
      }
    } catch (error) {
      streamFailure = error instanceof Error ? error : new Error(String(error));
    } finally {
      spinner.stop();
      await Promise.all(executions);
      inputData.signal?.removeEventListener("abort", abortTurn);
    }

    // Providers that put tool JSON in the text body cannot stream-execute; run
    // them once the turn is complete, preserving the old behaviour.
    const structuredCalls = scheduledRequests.length > 0;
    if (!structuredCalls && !streamFailure && !turnAbort.signal.aborted) {
      for (const request of parseCodeToolRequests(assistantText)) scheduleRequest(request);
      if (scheduledRequests.length) await Promise.all(executions);
    }

    if (streamFailure && scheduledRequests.length === 0) {
      const recovered = await recoverAnswerFromEvidence({
        brainUrl: inputData.brainUrl,
        fallbackProvider: inputData.fallbackProvider,
        messages: [...messages, ...brainEvidenceMessages],
        reasoning: inputData.reasoning,
        json: inputData.json,
        signal: inputData.signal,
      });
      if (!recovered) throw streamFailure;
      assistantText = recovered.text;
      latestUsageSummary = recovered.usageSummary || latestUsageSummary;
      usageRecords.push(...recovered.usageRecords);
      streamFailure = null;
    }
    if (streamFailure) {
      if (inputData.json) {
        writeJsonLine({ type: "code.stream.interrupted", ts: nowIso(), message: streamFailure.message, tools: scheduledRequests.length });
      }
      inputData.onEvent?.({ type: "stream.interrupted", message: streamFailure.message });
    }
    messages.push(structuredCalls
      ? {
          role: "assistant",
          content: assistantText,
          tool_calls: assistantToolCallsForMessages(scheduledRequests),
        }
      : { role: "assistant", content: assistantText });
    if (inputData.onCheckpoint) {
      if (structuredCalls) {
        await inputData.onCheckpoint({
          type: "assistant",
          content: assistantText,
          data: { tool_calls: assistantToolCallsForMessages(scheduledRequests) },
        });
      } else if (assistantText.trim()) {
        await inputData.onCheckpoint({ type: "assistant", content: assistantText });
      }
    }
    if (scheduledRequests.length === 0) {
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
          const currentSnapshot = snapshot as WorkspaceSnapshot | null;
          if (autoRollbackEnabled() && currentSnapshot?.available && !rolledBack && autoVerifyReverifies + 1 >= MAX_AUTOVERIFY_REVERIFIES) {
            const restore = restoreWorkspaceSnapshot(inputData.toolCtx.cwd, currentSnapshot);
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
          signal: inputData.signal,
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
    const toolResultSections = toolOutcomes.map((outcome) => outcome.section);
    const toolLedgerEntries = toolOutcomes.map((outcome) => outcome.ledger).filter((entry): entry is ToolLedgerEntry => !!entry);
    const toolLedger = renderToolLedger(toolLedgerEntries, step);
    if (toolLedger) {
      if (inputData.json) writeJsonLine({ type: "code.tool.ledger", ts: nowIso(), step, text: toolLedger });
      inputData.onEvent?.({ type: "tool.ledger", text: toolLedger });
    }
    if (structuredCalls) {
      for (let i = 0; i < scheduledRequests.length; i += 1) {
        const request = scheduledRequests[i];
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

    if (streamFailure) {
      const note = "The previous response stream ended before the turn completed. The tool results above are real; continue from them and mention the interruption briefly.";
      messages.push({ role: "user", content: note });
      if (inputData.onCheckpoint) await inputData.onCheckpoint({ type: "user", content: note });
    }
    const budgetVerdict = checkToolBudget(toolCallCount, toolBudget, budgetWarned);
    if (budgetVerdict.message) {
      budgetWarned = true;
      messages.push({ role: "user", content: budgetVerdict.message });
      if (inputData.onCheckpoint) await inputData.onCheckpoint({ type: "user", content: budgetVerdict.message });
    }
    const compaction = await compactNow();
    if (compaction) {
      if (inputData.json) {
        writeJsonLine({
          type: "code.runtime.compacted",
          ts: nowIso(),
          messages: compaction.compacted,
          engine: compaction.engine,
          summaryChars: compaction.summaryChars,
        });
      }
      inputData.onEvent?.({ type: "runtime.compacted", messages: compaction.compacted });
      if (!inputData.json && !inputData.onEvent) {
        process.stderr.write(`${renderCard({
          kind: "info",
          title: `runtime compacted · ${compaction.compacted} old messages (${compaction.engine})`,
          body: ["kept the active goal, current plan, recent tool results and refreshed files"],
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
    permissionDenials,
  };
}
