import type { RuntimeInstructionFrame } from "../../shared/runtime-instruction-frames.js";
import type { CodeContext } from "./code-context.js";
import type { ToolRunContext } from "./tools/types.js";

export interface CodeRuntimeFrameInput {
  context: CodeContext;
  toolCtx: Pick<ToolRunContext, "approval" | "sandbox" | "cwd">;
  memoryFrame?: string;
}

export function buildCodeRuntimeFrames(input: CodeRuntimeFrameInput): RuntimeInstructionFrame[] {
  return [
    {
      kind: "base_system",
      source: "cli",
      text: [
        "You are Lynn CLI code mode.",
        "The default online route is StepFun 3.7 Flash first (256K context; high reasoning with a 32K reasoning/generation budget) through the local Lynn Brain router, and Spark Qwen 3.6 35B A3B second as local fallback.",
        "StepFun 3.7 Flash is the text/coding head route. Keep responses in the user's language.",
        "You help with repository-level coding tasks from the terminal.",
        "You may request local tools using exactly one JSON object and no prose:",
        '{"tool":"update_plan|read_file|grep|glob|apply_patch|bash|write_file","args":{...}}',
        "For non-trivial tasks, first call update_plan/TodoWrite with items and statuses pending/in_progress/completed, then update it as work progresses.",
        "Prefer read_file, grep, and glob before editing. Use apply_patch for edits when possible.",
        "When you are done, answer normally with a concise summary and tests run.",
        "Do not claim you edited files unless a tool actually changed them.",
        "Never download models, datasets, training packs, BF16, or GGUF files to the local Mac.",
      ].join("\n"),
    },
    {
      kind: "cacheable_context",
      source: "cli",
      title: "Repository context",
      text: `Repository root: ${input.context.cwd}`,
    },
    ...(input.memoryFrame ? [{
      kind: "cacheable_context" as const,
      source: "cli",
      title: "Durable memory",
      text: input.memoryFrame,
    }] : []),
    {
      kind: "permission_state",
      source: "cli",
      title: "Current tool permissions",
      text: `approval=${input.toolCtx.approval} sandbox=${input.toolCtx.sandbox || "workspace-write"}`,
      stable: false,
      cacheable: false,
    },
    {
      kind: "tool_guard",
      source: "cli",
      title: "Local tool guard",
      text: "Local tools can read and edit only inside the current workspace. Dangerous tools require approval unless approval mode is yolo or on-failure.",
      stable: false,
      cacheable: false,
    },
  ];
}
