import { stdin as input, stdout as output, stderr as errorOutput } from "node:process";
import { getStringFlag, hasFlag, type ParsedArgs } from "./args.js";
import { nowIso, writeJsonLine } from "./jsonl.js";
import { parseReasoningOptions } from "./reasoning.js";
import { appendSessionLine, appendSessionMetadata, readSessionLines } from "./session/store.js";
import { mergeWorkspaceSnapshots } from "./code-snapshot.js";
import { runUltraCodeTask } from "./code-ultra-runner.js";
import type { UltraEvent, UltraOptions } from "./code-ultra.js";
import type { CodeContext } from "./code-context.js";
import type { CodeAgentEvent } from "./code-agent-loop.js";
import type { ToolRunContext } from "./tools/types.js";
import type { CliProviderProfile } from "./provider-profile.js";
import type { ChatMode } from "./commands/chat.js";
import { renderAssistantBlock, renderCodeFooter } from "./code-output.js";
import { bold, dangerLine, dim, orange, supportsColor } from "./terminal-style.js";

export function ultraEnabled(args: ParsedArgs): boolean {
  return hasFlag(args.flags, "ultra");
}

function ultraOptions(args: ParsedArgs): UltraOptions {
  const opts: UltraOptions = {};
  const maxSubtasks = Number.parseInt(getStringFlag(args.flags, "ultra-max-subtasks") || "", 10);
  const maxConcurrency = Number.parseInt(getStringFlag(args.flags, "ultra-concurrency") || "", 10);
  if (Number.isFinite(maxSubtasks)) opts.maxSubtasks = maxSubtasks;
  if (Number.isFinite(maxConcurrency)) opts.maxConcurrency = maxConcurrency;
  if (hasFlag(args.flags, "ultra-verify")) opts.adversarialVerify = true;
  return opts;
}

export async function runUltraCodeBranch(p: {
  args: ParsedArgs;
  taskText: string;
  context: CodeContext;
  brainUrl: string;
  fallbackProvider?: CliProviderProfile;
  reasoning: ReturnType<typeof parseReasoningOptions>;
  json: boolean;
  toolCtx: ToolRunContext;
  stepBudget: number;
  mode: ChatMode;
  options: { compact?: boolean; onEvent?: (event: CodeAgentEvent) => void };
  dataDir: string;
  saveSession: boolean;
  sessionPath?: string | null;
  title: string;
  modelProvider: string;
  modelId: string;
}): Promise<number> {
  const color = supportsColor(errorOutput);
  const compact = Boolean(p.options.compact || p.options.onEvent);
  const workerSnapshots: string[] = [];

  let liveSessionPath = p.sessionPath;
  let rewindBeforeLine: number | null = null;
  if (p.saveSession) {
    rewindBeforeLine = liveSessionPath ? (await readSessionLines(liveSessionPath).catch(() => [])).length : 0;
    liveSessionPath = await appendSessionLine({
      dataDir: p.dataDir,
      sessionPath: liveSessionPath,
      cwd: p.context.cwd,
      title: p.title,
      line: { type: "user", content: p.taskText, data: { kind: "code_ultra_user_turn" } },
      modelProvider: p.modelProvider,
      modelId: p.modelId,
    });
  }

  if (p.json) {
    writeJsonLine({ type: "code.ultra.started", ts: nowIso(), task: p.taskText });
  } else if (!compact) {
    errorOutput.write(`${orange("⚡ ultra", color)} ${dim("— decomposing into parallel sub-tasks…", color)}\n`);
  }

  const ultra = await runUltraCodeTask({
    task: p.taskText,
    context: p.context,
    brainUrl: p.brainUrl,
    fallbackProvider: p.fallbackProvider,
    reasoning: p.reasoning,
    maxSteps: p.stepBudget,
    toolCtx: p.toolCtx,
    input,
    output: errorOutput,
    options: ultraOptions(p.args),
    onEvent: (event) => emitUltraEvent(event, { json: p.json, compact, color, onEvent: p.options.onEvent }),
    onSubtaskEvent: (_subtaskId, event) => {
      if (event.type === "snapshot" && event.ref) workerSnapshots.push(event.ref);
    },
  });

  if (p.json) {
    writeJsonLine({
      type: "code.ultra.finished",
      ts: nowIso(),
      ok: ultra.ok,
      waves: ultra.waves,
      fallback: ultra.plan.fallback,
      subtasks: ultra.results.map((r) => ({ id: r.id, title: r.title, ok: r.ok, skipped: Boolean(r.skipped) })),
    });
    writeJsonLine({ type: "assistant.delta", ts: nowIso(), text: ultra.synthesis });
    writeJsonLine({ type: "code.task.finished", ts: nowIso(), ok: ultra.ok });
  } else if (p.options.onEvent) {
    p.options.onEvent({ type: "assistant.delta", text: ultra.synthesis });
    p.options.onEvent({ type: "task.finished", ok: ultra.ok, text: ultra.synthesis, usageSummary: null });
  } else {
    process.stdout.write(renderAssistantBlock(ultra.synthesis, renderCodeFooter({
      context: p.context,
      mode: p.mode,
      mockBrain: false,
      reasoning: p.reasoning,
    })));
  }

  if (p.saveSession && liveSessionPath) {
    liveSessionPath = await appendSessionLine({
      dataDir: p.dataDir,
      sessionPath: liveSessionPath,
      cwd: p.context.cwd,
      title: p.title,
      line: { type: "assistant", content: ultra.synthesis, data: { kind: "code_ultra_synthesis" } },
      modelProvider: p.modelProvider,
      modelId: p.modelId,
    });
    await appendSessionMetadata({
      dataDir: p.dataDir,
      sessionPath: liveSessionPath,
      data: {
        kind: "code_ultra_task",
        cwd: p.context.cwd,
        ok: ultra.ok,
        waves: ultra.waves,
        fallback: ultra.plan.fallback,
        subtasks: ultra.results.map((r) => ({ id: r.id, title: r.title, ok: r.ok, skipped: Boolean(r.skipped) })),
      },
    });
    if (workerSnapshots.length && rewindBeforeLine !== null) {
      const merged = mergeWorkspaceSnapshots(workerSnapshots);
      if (merged.available && merged.ref) {
        await appendSessionMetadata({
          dataDir: p.dataDir,
          sessionPath: liveSessionPath,
          data: {
            kind: "code_rewind_checkpoint",
            snapshotRef: merged.ref,
            restoreCommand: merged.restoreCommand,
            cwd: p.context.cwd,
            task: p.taskText,
            beforeLine: rewindBeforeLine,
            createdAt: new Date().toISOString(),
          },
        });
      }
    }
    if (p.json) writeJsonLine({ type: "session.saved", ts: nowIso(), path: liveSessionPath });
    p.options.onEvent?.({ type: "session.saved", path: liveSessionPath });
  }
  return ultra.ok ? 0 : 1;
}

function emitUltraEvent(
  event: UltraEvent,
  ctx: { json: boolean; compact: boolean; color: boolean; onEvent?: (event: CodeAgentEvent) => void },
): void {
  if (ctx.json) {
    writeJsonLine({ ...event, ts: nowIso() });
    return;
  }
  if (ctx.compact) {
    const plain = formatUltraEventLine(event, false);
    if (plain) ctx.onEvent?.({ type: "tool.progress", message: plain.trim() });
    return;
  }
  const line = formatUltraEventLine(event, ctx.color);
  if (line) errorOutput.write(`${line}\n`);
}

function formatUltraEventLine(event: UltraEvent, color: boolean): string | null {
  switch (event.type) {
    case "ultra.plan": {
      const n = event.plan.subtasks.length;
      const label = event.plan.fallback ? "single worker (no useful split)" : `${n} sub-task${n === 1 ? "" : "s"}`;
      const warn = event.plan.warnings.length ? ` ${dim(`(${event.plan.warnings.length} note(s))`, color)}` : "";
      return `${bold("plan", color)} ${dim("→", color)} ${label}${warn}`;
    }
    case "ultra.wave":
      return dim(`wave ${event.wave}: ${event.ids.join(", ")}`, color);
    case "ultra.subtask.started":
      return dim(`  ▸ ${event.id} ${event.title}`, color);
    case "ultra.subtask.verified":
      if (event.pass) return dim(`  ${event.id} verify ✓`, color);
      return `  ${dangerLine("✗", color)} ${event.id} verify refuted${event.reason ? `: ${event.reason.replace(/\s+/g, " ").slice(0, 80)}` : ""}`;
    case "ultra.subtask.finished":
      if (event.skipped) return dim(`  ${event.id} skipped (dependency failed)`, color);
      if (event.ok) return `  ${orange("✓", color)} ${event.id} ${event.title}`;
      return `  ${dangerLine("✗", color)} ${event.id} ${event.title}`;
    case "ultra.synthesis.started":
      return dim("synthesizing results…", color);
    case "ultra.synthesis":
      return null;
    default:
      return null;
  }
}
