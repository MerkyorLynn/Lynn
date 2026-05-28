import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSessionSwitchMeta } from "../core/session-switch-meta.js";

describe("session switch meta helper", () => {
  const dirs = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-session-switch-meta-"));
    dirs.push(dir);
    return dir;
  }

  it("reads memory state and new model ref format", () => {
    const dir = tempDir();
    const sessionPath = path.join(dir, "s.jsonl");
    fs.writeFileSync(path.join(dir, "session-meta.json"), JSON.stringify({
      "s.jsonl": {
        memoryEnabled: false,
        model: { id: "qwen", provider: "local" },
      },
    }));

    expect(readSessionSwitchMeta({ sessionPath, sessionDir: dir })).toEqual({
      memoryEnabled: false,
      savedModelRef: { id: "qwen", provider: "local" },
    });
  });

  it("reads legacy modelId format", () => {
    const dir = tempDir();
    const sessionPath = path.join(dir, "old.jsonl");
    fs.writeFileSync(path.join(dir, "session-meta.json"), JSON.stringify({
      "old.jsonl": { modelId: "legacy-model" },
    }));

    expect(readSessionSwitchMeta({ sessionPath, sessionDir: dir })).toEqual({
      memoryEnabled: true,
      savedModelRef: { id: "legacy-model", provider: "" },
    });
  });

  it("ignores missing meta file and reports malformed meta", () => {
    const dir = tempDir();
    const onReadError = vi.fn();

    expect(readSessionSwitchMeta({
      sessionPath: path.join(dir, "missing.jsonl"),
      sessionDir: dir,
      onReadError,
    })).toEqual({ memoryEnabled: true, savedModelRef: null });
    expect(onReadError).not.toHaveBeenCalled();

    fs.writeFileSync(path.join(dir, "session-meta.json"), "{nope");
    expect(readSessionSwitchMeta({
      sessionPath: path.join(dir, "bad.jsonl"),
      sessionDir: dir,
      onReadError,
    })).toEqual({ memoryEnabled: true, savedModelRef: null });
    expect(onReadError).toHaveBeenCalledTimes(1);
  });
});
