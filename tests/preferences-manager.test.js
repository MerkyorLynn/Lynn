import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { PreferencesManager } from "../core/preferences-manager.js";

const tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

describe("PreferencesManager client agent key", () => {
  it("generates and persists a stable client agent key", () => {
    const root = makeTempDir("hanako-prefs-");
    const userDir = path.join(root, "user");
    const agentsDir = path.join(root, "agents");
    fs.mkdirSync(userDir, { recursive: true });
    fs.mkdirSync(agentsDir, { recursive: true });

    const prefs = new PreferencesManager({ userDir, agentsDir });
    const first = prefs.ensureClientAgentKey();
    const second = prefs.ensureClientAgentKey();

    expect(first).toMatch(/^ak_[a-f0-9]{32}$/);
    expect(second).toBe(first);
    expect(prefs.getClientAgentKey()).toBe(first);

    const reloaded = new PreferencesManager({ userDir, agentsDir });
    expect(reloaded.getClientAgentKey()).toBe(first);
  });
});
