// Bridge between Lynn's ultra orchestrator (pure, code-ultra.ts) and the live
// runtime: the planner/synthesizer model call (streamBrainChat) and the worker
// (runCodeAgentLoop — the existing atomic-step, verify-after-mutation loop).
//
// Keeping this separate from code-ultra.ts means the orchestration core stays
// unit-testable with no I/O, and this file holds only the thin wiring.

import { streamBrainChat } from "./brain-client.js";
import { runCodeAgentLoop, type CodeAgentEvent } from "./code-agent-loop.js";
import type { CodeContext } from "./code-context.js";
import { buildSelfVerifyPrompt, parseSelfVerifyVerdict } from "./code-self-verify.js";
import {
  runUltraTask,
  type UltraEvent,
  type UltraOptions,
  type UltraResult,
  type UltraSubtask,
  type UltraSubtaskContext,
  type UltraWorkerOutput,
} from "./code-ultra.js";
import type { CliProviderProfile } from "./provider-profile.js";
import { parseReasoningOptions } from "./reasoning.js";
import type { ToolRunContext } from "./tools/types.js";

export interface UltraRunnerInput {
  task: string;
  context: CodeContext;
  brainUrl: string;
  fallbackProvider?: CliProviderProfile;
  reasoning: ReturnType<typeof parseReasoningOptions>;
  maxSteps: number;
  toolCtx: ToolRunContext;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  options?: UltraOptions;
  onEvent?: (event: UltraEvent) => void;
  onSubtaskEvent?: (subtaskId: string, event: CodeAgentEvent) => void;
}

/** Compose the worker brief: a self-contained instruction for one isolated agent. */
export function buildSubtaskBrief(overallTask: string, subtask: UltraSubtask, ctx: UltraSubtaskContext): string {
  const lines = [
    `You are worker "${subtask.id}" handling ONE sub-task of a larger job, running in isolation from the other workers.`,
    "",
    "Overall goal (context only — do NOT try to do all of it):",
    overallTask.trim(),
    "",
    "YOUR sub-task — do exactly this and nothing more:",
    subtask.brief.trim(),
  ];
  if (ctx.dependencyResults.length) {
    lines.push("", "Results from prerequisite sub-tasks you can build on:");
    for (const dep of ctx.dependencyResults) {
      lines.push(`- [${dep.id} ${dep.title}] ${truncateForBrief(dep.text)}`);
    }
  }
  lines.push(
    "",
    "Work through your sub-task with concrete tool actions, then report what you changed and verified.",
  );
  return lines.join("\n");
}

export async function runUltraCodeTask(input: UltraRunnerInput): Promise<UltraResult> {
  const complete = async (prompt: string): Promise<string> => {
    let text = "";
    for await (const event of streamBrainChat({
      brainUrl: input.brainUrl,
      prompt,
      reasoning: input.reasoning,
      fallbackProvider: input.fallbackProvider,
    })) {
      if (event.type === "assistant.delta") text += event.text;
      else if (event.type === "brain.error") throw new Error(event.error);
    }
    return text;
  };

  const runSubtask = async (subtask: UltraSubtask, ctx: UltraSubtaskContext): Promise<UltraWorkerOutput> => {
    const result = await runCodeAgentLoop({
      task: buildSubtaskBrief(input.task, subtask, ctx),
      context: input.context,
      brainUrl: input.brainUrl,
      fallbackProvider: input.fallbackProvider,
      reasoning: input.reasoning,
      json: false,
      maxSteps: input.maxSteps,
      toolCtx: input.toolCtx,
      input: input.input,
      output: input.output,
      onEvent: input.onSubtaskEvent ? (event) => input.onSubtaskEvent?.(subtask.id, event) : undefined,
    });
    return {
      // A worker counts as ok when it finished within budget and produced an
      // answer. The deeper correctness gate (typecheck, postconditions,
      // self-verify) already runs INSIDE runCodeAgentLoop via guards #1-#7.
      ok: !result.maxStepsReached && Boolean(result.text.trim()),
      text: result.text,
      maxStepsReached: result.maxStepsReached,
      mutated: result.mutated,
    };
  };

  const verifySubtask = async (subtask: UltraSubtask, output: { text: string }) => {
    const verdict = parseSelfVerifyVerdict(await complete(buildSelfVerifyPrompt(subtask.brief, output.text)));
    return { pass: verdict.pass, reason: verdict.issues };
  };

  return runUltraTask({
    task: input.task,
    complete: (prompt) => complete(prompt),
    runSubtask,
    verifySubtask,
    options: input.options,
    onEvent: input.onEvent,
  });
}

function truncateForBrief(value: string, max = 600): string {
  const clean = value.trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}
