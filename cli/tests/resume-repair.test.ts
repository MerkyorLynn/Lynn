import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildResumableMessageGroups,
  summarizeResumeMessages,
  extractLatestPlan,
  loadResumeMessages,
  readResumeSessionInfo,
  RESUME_REPAIR_NOTE,
  RESUME_COMPACTION_NOTE,
} from "../src/commands/code.js";

async function writeSession(lines: unknown[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-resume-"));
  const file = path.join(dir, "session.jsonl");
  await fs.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return file;
}

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
    expect(diag).toEqual({ messages: 2, repairedTools: 0, compacted: false, tornLines: 0 });
  });

  it("counts torn lines recovered by the crash-tolerant reader", () => {
    const diag = summarizeResumeMessages([
      { role: "user", content: "[Lynn CLI torn-lines=3: some transcript lines were unreadable...]" },
      { role: "user", content: "real task" },
    ] as never);
    expect(diag.tornLines).toBe(3);
  });
});

describe("extractLatestPlan — plan/todo restoration", () => {
  it("recovers the most recent plan from update_plan tool calls", () => {
    const plan = extractLatestPlan([
      { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "update_plan", arguments: JSON.stringify({ plan: [{ content: "old", status: "pending" }] }) } }] },
      { role: "assistant", content: "", tool_calls: [{ id: "2", type: "function", function: { name: "update_plan", arguments: JSON.stringify({ plan: [{ content: "step A", status: "completed" }, { content: "step B", status: "in_progress" }] }) } }] },
    ] as never);
    expect(plan.map((item) => `${item.status}:${item.content}`)).toEqual(["completed:step A", "in_progress:step B"]);
  });

  it("returns an empty plan when no update_plan call exists", () => {
    expect(extractLatestPlan([{ role: "assistant", content: "hi" }] as never)).toEqual([]);
  });
});

describe("loadResumeMessages — pin the original goal on compaction", () => {
  it("keeps the first user task pinned even when older turns are trimmed", async () => {
    const file = await writeSession([
      { type: "user", content: "ORIGINAL GOAL: build the feature", ts: "1" },
      { type: "assistant", content: `working ${"x".repeat(400)}`, ts: "2" },
      { type: "user", content: `more context ${"y".repeat(400)}`, ts: "3" },
      { type: "assistant", content: "latest answer", ts: "4" },
    ]);
    const messages = await loadResumeMessages(file, 200); // tiny budget forces trimming
    const text = messages.map((message) => message.content).join("\n");
    expect(text).toContain("ORIGINAL GOAL"); // goal pinned despite compaction
    expect(text).toContain("compacted"); // gap is explained
    expect(messages.at(-1)?.content).toBe("latest answer"); // recent window kept
  });
});

describe("readResumeSessionInfo", () => {
  it("reads cwd, git snapshot and the first prompt from the session", async () => {
    const file = await writeSession([
      { type: "user", content: "first prompt here", ts: "1" },
      { type: "assistant", content: "ok", ts: "2" },
      { type: "metadata", ts: "3", data: { kind: "code_task", cwd: "/repo/x", gitSnapshot: "abc123def456" } },
    ]);
    await expect(readResumeSessionInfo(file)).resolves.toEqual({
      cwd: "/repo/x",
      gitSnapshot: "abc123def456",
      firstPrompt: "first prompt here",
    });
  });
});
