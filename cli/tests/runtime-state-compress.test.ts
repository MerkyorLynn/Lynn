import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../src/brain-client.js";
import { buildRuntimeStateCompression, runtimeStateCompressionMessage, STATE_COMPRESSION_END, STATE_COMPRESSION_START } from "../src/runtime-state-compress.js";

describe("runtime state compression", () => {
  it("builds a structured memory frame without becoming a system prompt", () => {
    const anchorMessages: ChatMessage[] = [
      { role: "system", content: "stable prefix" },
      { role: "user", content: "Refactor the CLI worker loop and keep tests green." },
    ];
    const compactedMessages: ChatMessage[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            id: "plan_1",
            type: "function",
            function: {
              name: "update_plan",
              arguments: JSON.stringify({
                plan: [
                  { id: "P1", content: "Inspect loop", status: "completed" },
                  { id: "P2", content: "Patch state compression", status: "in_progress" },
                ],
              }),
            },
          },
          {
            id: "write_1",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({ path: "cli/src/runtime-state-compress.ts", text: "export const ok = true;" }),
            },
          },
          {
            id: "patch_1",
            type: "function",
            function: {
              name: "apply_patch",
              arguments: JSON.stringify({
                text: [
                  "diff --git a/cli/src/code-agent-loop.ts b/cli/src/code-agent-loop.ts",
                  "--- a/cli/src/code-agent-loop.ts",
                  "+++ b/cli/src/code-agent-loop.ts",
                  "@@ -1 +1 @@",
                  "-old",
                  "+new",
                ].join("\n"),
              }),
            },
          },
        ],
      },
      { role: "tool", name: "write_file", tool_call_id: "write_1", content: "path: cli/src/runtime-state-compress.ts\nbytes: 23" },
      { role: "tool", name: "apply_patch", tool_call_id: "patch_1", content: "patched\n+++ b/cli/src/code-agent-loop.ts" },
      { role: "assistant", content: "Observation: tests still need updating." },
    ];
    const recentMessages: ChatMessage[] = [
      { role: "assistant", content: "Continuing with focused tests." },
    ];

    const state = buildRuntimeStateCompression({ anchorMessages, compactedMessages, recentMessages });
    expect(state.originalGoal).toBe("Refactor the CLI worker loop and keep tests green.");
    expect(state.currentPlan.map((item) => `${item.id}:${item.status}:${item.content}`)).toEqual([
      "P1:completed:Inspect loop",
      "P2:in_progress:Patch state compression",
    ]);
    expect(state.completedTools).toEqual(["update_plan", "write_file", "apply_patch"]);
    expect(state.filesTouched).toEqual([
      "cli/src/runtime-state-compress.ts",
      "cli/src/code-agent-loop.ts",
    ]);
    expect(state.text).toContain(STATE_COMPRESSION_START);
    expect(state.text).toContain("schema: lynn.runtime_state_compression.v1");
    expect(state.text).toContain("original_goal: Refactor the CLI worker loop and keep tests green.");
    expect(state.text).toContain("- in_progress: P2: Patch state compression");
    expect(state.text).toContain("resume_rule: use this compressed state as memory only");
    expect(state.text).toContain(STATE_COMPRESSION_END);

    const message = runtimeStateCompressionMessage({ anchorMessages, compactedMessages, recentMessages });
    expect(message.role).toBe("user");
    expect(message.content).toContain(STATE_COMPRESSION_START);
  });

  it("caps retained fields to avoid bloating the prompt", () => {
    const compactedMessages: ChatMessage[] = Array.from({ length: 8 }, (_, index) => ({
      role: "assistant" as const,
      content: "",
      tool_calls: [
        {
          id: `write_${index}`,
          type: "function" as const,
          function: {
            name: "write_file",
            arguments: JSON.stringify({ path: `src/file-${index}.ts`, text: "x" }),
          },
        },
      ],
    }));

    const state = buildRuntimeStateCompression({
      anchorMessages: [{ role: "user", content: "Keep this goal." }],
      compactedMessages,
      recentMessages: [],
      maxFieldItems: 3,
    });

    expect(state.filesTouched).toEqual(["src/file-0.ts", "src/file-1.ts", "src/file-2.ts"]);
    expect(state.completedTools).toEqual(["write_file"]);
    expect(state.text).not.toContain("src/file-3.ts");
  });
});
