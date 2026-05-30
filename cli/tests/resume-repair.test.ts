import { describe, expect, it } from "vitest";
import {
  buildResumableMessageGroups,
  summarizeResumeMessages,
  RESUME_REPAIR_NOTE,
  RESUME_COMPACTION_NOTE,
} from "../src/commands/code.js";

describe("buildResumableMessageGroups — interrupted tool chains", () => {
  it("synthesizes a placeholder for each missing tool_call so resume stays valid", () => {
    const groups = buildResumableMessageGroups([
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "a", function: { name: "read_file", arguments: "{}" } },
          { id: "b", function: { name: "bash", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "a", name: "read_file", content: "result a" },
    ] as never);

    expect(groups).toHaveLength(1);
    // assistant + 2 tool results (a real, b synthesized) => every tool_call answered
    const tools = groups[0].filter((message) => message.role === "tool");
    expect(tools).toHaveLength(2);
    const synth = groups[0].find((message: { tool_call_id?: string }) => message.tool_call_id === "b") as {
      content: string;
      name?: string;
    };
    expect(synth.content).toContain("did not finish");
    expect(synth.name).toBe("bash");
  });

  it("keeps a complete chain unchanged", () => {
    const groups = buildResumableMessageGroups([
      { role: "assistant", content: "", tool_calls: [{ id: "a", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "a", name: "read_file", content: "ok" },
    ] as never);
    expect(groups[0]).toHaveLength(2);
  });
});

describe("summarizeResumeMessages — resume diagnostics", () => {
  it("counts repaired tools and detects compaction", () => {
    const diag = summarizeResumeMessages([
      { role: "user", content: `[Lynn CLI resumed this task. ${RESUME_COMPACTION_NOTE}; inspect files if needed.]` },
      { role: "assistant", content: "", tool_calls: [{ id: "b", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "b", name: "bash", content: `Tool result for bash:\n[Lynn CLI: ${RESUME_REPAIR_NOTE}. Re-run it if its result is needed.]` },
      { role: "tool", tool_call_id: "a", name: "read_file", content: "real result" },
    ] as never);
    expect(diag.messages).toBe(4);
    expect(diag.repairedTools).toBe(1);
    expect(diag.compacted).toBe(true);
  });

  it("reports a clean resume with no repairs and no compaction", () => {
    const diag = summarizeResumeMessages([
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ] as never);
    expect(diag).toEqual({ messages: 2, repairedTools: 0, compacted: false });
  });
});
