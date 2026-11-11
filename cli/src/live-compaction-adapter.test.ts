import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliLiveCompactionAdapter } from "./live-compaction-adapter.js";

function round(messages: any[], index: number): void {
  const callId = `cli-call-${index}`;
  messages.push({ role: "user", content: `task ${index}` });
  messages.push({
    role: "assistant",
    content: "",
    tool_calls: [{ id: callId, type: "function", function: { name: "read", arguments: "{}" } }],
  });
  messages.push({ role: "tool", tool_call_id: callId, name: "read", content: "y".repeat(20_000) });
  messages.push({ role: "assistant", content: `done ${index}` });
}

describe("CLI live compaction adapter", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is opt-in and replaces only older complete tool rounds", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-cli-live-"));
    const messages: any[] = [];
    for (let index = 0; index < 5; index += 1) round(messages, index);
    const adapter = new CliLiveCompactionAdapter(root, "run-1");

    expect(adapter.compact(messages)).toBeNull();
    vi.stubEnv("LYNN_LIVE_COMPACTION", "1");
    const result = adapter.compact(messages);
    expect(result?.replaced).toBeGreaterThan(0);
    expect(messages.filter((message) => message.role === "tool" && String(message.content).includes("[Lynn Live Compact]")).length).toBeGreaterThan(0);
    expect(fs.readdirSync(path.join(root, "agents", "cli", ".live-compact", "run-1")).some((name) => name.endsWith(".txt"))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("uses the async capture queue before mutating the CLI context", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-cli-live-async-"));
    const messages: any[] = [];
    for (let index = 0; index < 5; index += 1) round(messages, index);
    vi.stubEnv("LYNN_LIVE_COMPACTION", "1");
    const adapter = new CliLiveCompactionAdapter(root, "run-async");
    const result = await adapter.compactAsync(messages);
    expect(result?.replaced).toBeGreaterThan(0);
    expect(messages.some((message) => String(message.content).includes("[Lynn Live Compact]"))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
