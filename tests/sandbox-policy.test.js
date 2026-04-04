import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveSandboxPolicy } from "../lib/sandbox/policy.js";
import { AccessLevel, PathGuard } from "../lib/sandbox/path-guard.js";

describe("sandbox policy", () => {
  const tmpRoots = [];

  function makeFixture() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "lynn-sandbox-policy-")));
    tmpRoots.push(root);
    const lynnHome = path.join(root, ".lynn");
    const agentDir = path.join(lynnHome, "agents", "lynn");
    fs.mkdirSync(path.join(lynnHome, "skills"), { recursive: true });
    fs.mkdirSync(path.join(lynnHome, "user"), { recursive: true });
    fs.mkdirSync(path.join(lynnHome, "channels"), { recursive: true });
    fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
    return { root, lynnHome, agentDir };
  }

  afterEach(() => {
    for (const root of tmpRoots.splice(0)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows writing inside lynnHome skills without adding a trusted root", () => {
    const { lynnHome, agentDir } = makeFixture();
    const policy = deriveSandboxPolicy({
      lynnHome,
      agentDir,
      workspace: null,
      trustedRoots: [],
      mode: "standard",
    });

    const guard = new PathGuard(policy);
    const skillDir = path.join(lynnHome, "skills", "stock-analysis");
    const skillFile = path.join(skillDir, "SKILL.md");

    expect(guard.getAccessLevel(skillDir)).toBe(AccessLevel.READ_WRITE);
    expect(guard.getAccessLevel(skillFile)).toBe(AccessLevel.READ_WRITE);
    expect(guard.check(skillFile, "write")).toEqual({ allowed: true });
    expect(policy.writablePaths).toContain(path.join(lynnHome, "skills"));
  });

  it("keeps sensitive lynnHome files blocked even though skills is writable", () => {
    const { lynnHome, agentDir } = makeFixture();
    const policy = deriveSandboxPolicy({
      lynnHome,
      agentDir,
      workspace: null,
      trustedRoots: [],
      mode: "standard",
    });

    const guard = new PathGuard(policy);
    const authJson = path.join(lynnHome, "auth.json");

    expect(guard.getAccessLevel(authJson)).toBe(AccessLevel.BLOCKED);
    expect(guard.check(authJson, "write").allowed).toBe(false);
  });
});
