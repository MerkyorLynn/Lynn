import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SESSION_INDEX_FILENAME,
  normalizeSessionIndexEntry,
  readSessionIndex,
  writeSessionIndex,
} from "../core/session-index.js";

describe("session index sidecar", () => {
  const dirs = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-session-index-"));
    dirs.push(dir);
    return dir;
  }

  it("normalizes session metadata for indexing", () => {
    const entry = normalizeSessionIndexEntry({
      path: "/tmp/s1.jsonl",
      title: "Title",
      modified: new Date("2026-04-30T00:00:00.000Z"),
      messageCount: 3,
      labels: ["pinned", ""],
    }, { agent: { id: "a1", name: "Agent One" } });

    expect(entry).toMatchObject({
      path: "/tmp/s1.jsonl",
      title: "Title",
      modified: "2026-04-30T00:00:00.000Z",
      messageCount: 3,
      agentId: "a1",
      agentName: "Agent One",
      labels: ["pinned"],
    });
  });

  it("writes and reads an atomic JSON sidecar", async () => {
    const dir = tempDir();
    await writeSessionIndex(dir, [{
      path: "/tmp/s1.jsonl",
      title: "One",
      modified: "2026-04-30T01:00:00.000Z",
      pinned: true,
    }], { agent: { id: "agent-a", name: "Agent A" } });

    const filePath = path.join(dir, SESSION_INDEX_FILENAME);
    expect(fs.existsSync(filePath)).toBe(true);
    const sessions = await readSessionIndex(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      path: "/tmp/s1.jsonl",
      title: "One",
      agentId: "agent-a",
      pinned: true,
    });
  });
});
