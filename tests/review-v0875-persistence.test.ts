import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UserProfile } from "../lib/memory/user-profile.js";
import { parseSessionContent } from "../core/llm-utils.js";
import { SessionManager } from "../core/agent-runtime/session-manager.js";
import { LynnAgentSession } from "../core/agent-runtime/create-session.js";

const directories: string[] = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-v0875-persistence-")); directories.push(dir); return dir; }
afterEach(() => directories.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

describe("V0.87.5 persistence regressions", () => {
  it("keeps fresh agent profiles independent", () => {
    const dir = temp(); const a = new UserProfile({ profilePath: path.join(dir, "a.json") });
    const b = new UserProfile({ profilePath: path.join(dir, "b.json") });
    a.updateFromSession({ toolUsage: { bash: 3 }, languages: { ts: 2 }, hour: 8 });
    expect(b._load().toolUsage).toEqual({}); expect(b._load().languages).toEqual({});
    expect(b._load().hourDistribution[8]).toBe(0);
  });

  it("parses native string messages and native tool calls for summaries", async () => {
    const file = path.join(temp(), "s.jsonl");
    fs.writeFileSync(file, [
      { type: "message", message: { role: "user", content: "user goal" } },
      { type: "message", message: { role: "assistant", content: "done", tool_calls: [{ function: { name: "read" } }] } },
    ].map(JSON.stringify).join("\n"));
    expect(await parseSessionContent(file)).toMatchObject({ userText: "user goal", assistantText: "done", toolCalls: ["read"], toolCallsText: "read" });
  });

  it("persists a header before the first message and restores real compaction", async () => {
    const dir = temp(); const manager = SessionManager.create(dir, dir);
    for (let i = 0; i < 10; i++) {
      manager.appendMessage({ role: "user", content: `goal ${i}` });
      manager.appendMessage({ role: "assistant", content: `result ${i}` });
    }
    const file = manager.getSessionFile()!;
    expect(JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]).type).toBe("session");
    const session = new LynnAgentSession({ cwd: dir, sessionManager: manager, model: { id: "test", provider: "local" } });
    expect(session.getContextUsage().usedTokens).toBeGreaterThan(0);
    await session.compact();
    const restored = SessionManager.open(file, dir);
    expect(restored.buildSessionContext().messages).toHaveLength(9);
    expect(restored.buildSessionContext().messages[0].content).toContain("Earlier conversation summary");
    expect(restored.buildSessionContext().messages.at(-1)?.content).toBe("result 9");
    expect(restored.getHeader()?.cwd).toBe(dir);
    restored.close(); session.dispose();
  });
});
