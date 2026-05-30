import { describe, expect, it } from "vitest";
import { buildResumableMessageGroups } from "../src/commands/code.js";

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
