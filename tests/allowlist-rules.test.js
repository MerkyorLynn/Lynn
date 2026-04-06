import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { SecurityAllowlist, SessionAllowlist } from "../lib/sandbox/allowlist.js";

const createdDirs = [];

function makeTmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hana-allowlist-test-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("SecurityAllowlist", () => {
  it("persists and matches trustedRoot-scoped rule", () => {
    const home = makeTmpHome();
    const allowlist = new SecurityAllowlist(home);
    allowlist.add({
      category: "path_write",
      identifier: "/workspace/project/file.txt",
      trustedRoot: "/workspace/project",
    });

    expect(allowlist.check("path_write", "/workspace/project/file.txt", {
      path: "/workspace/project/sub/file.txt",
    })).toBe(true);

    expect(allowlist.check("path_write", "/workspace/project/file.txt", {
      path: "/workspace/other/file.txt",
    })).toBe(false);
  });

  it("loads legacy map format", () => {
    const home = makeTmpHome();
    const file = path.join(home, "security-allowlist.json");
    fs.writeFileSync(file, JSON.stringify({ "elevated_command:chmod": true }, null, 2));

    const allowlist = new SecurityAllowlist(home);
    expect(allowlist.check("elevated_command", "chmod", {})).toBe(true);
  });
});

describe("SessionAllowlist", () => {
  it("stores session-only rules in memory", () => {
    const allowlist = new SessionAllowlist();
    allowlist.add({ category: "elevated_command", identifier: "chmod", trustedRoot: "/workspace" });

    expect(allowlist.check("elevated_command", "chmod", { path: "/workspace/a.sh" })).toBe(true);
    expect(allowlist.check("elevated_command", "chmod", { path: "/tmp/a.sh" })).toBe(false);
    expect(allowlist.list()[0]?.scope).toBe("session");
  });
});
