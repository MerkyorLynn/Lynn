import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { assertWorkspaceBashAllowed, bashTool } from "../src/tools/bash.js";

const check = (command: string) => () => assertWorkspaceBashAllowed(command, "workspace-write");

describe("assertWorkspaceBashAllowed", () => {
  it("allows safe allowlisted commands", () => {
    expect(check("npm test")).not.toThrow();
    expect(check("git status")).not.toThrow();
    expect(check("rg foo src")).not.toThrow();
  });

  it("blocks non-allowlisted binaries (default-deny allowlist)", () => {
    expect(check("rm -rf foo")).toThrow();
    expect(check("eval $X")).toThrow();
  });

  it("blocks destructive uses of allowlisted binaries (find / git)", () => {
    expect(check("find . -delete")).toThrow();
    expect(check("find . -name '*.ts' -exec rm {} +")).toThrow();
    expect(check("git clean -fdx")).toThrow();
  });

  it("blocks workspace escapes, chaining, and absolute redirects", () => {
    expect(check("cat ../../etc/passwd")).toThrow();
    expect(check("ls; rm -rf /")).toThrow();
    expect(check("git log > /tmp/x")).toThrow();
  });

  it("allows everything in danger-full-access", () => {
    expect(() => assertWorkspaceBashAllowed("find . -delete", "danger-full-access")).not.toThrow();
  });

  it("blocks whole-machine find even after danger-full-access approval", () => {
    const previous = process.env.LYNN_CLI_ALLOW_FULL_DISK_FIND;
    delete process.env.LYNN_CLI_ALLOW_FULL_DISK_FIND;
    try {
      expect(() => assertWorkspaceBashAllowed("find / -name lynn-cli-runtime-knowledge.md", "danger-full-access")).toThrow(/full-disk/);
      expect(() => assertWorkspaceBashAllowed("find . -name lynn-cli-runtime-knowledge.md", "danger-full-access")).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.LYNN_CLI_ALLOW_FULL_DISK_FIND;
      else process.env.LYNN_CLI_ALLOW_FULL_DISK_FIND = previous;
    }
  });

  it("allows whole-machine find only behind an explicit escape hatch", () => {
    const previous = process.env.LYNN_CLI_ALLOW_FULL_DISK_FIND;
    process.env.LYNN_CLI_ALLOW_FULL_DISK_FIND = "1";
    try {
      expect(() => assertWorkspaceBashAllowed("find / -name lynn-cli-runtime-knowledge.md", "danger-full-access")).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.LYNN_CLI_ALLOW_FULL_DISK_FIND;
      else process.env.LYNN_CLI_ALLOW_FULL_DISK_FIND = previous;
    }
  });

  it("allows only safe pwd/ls bash without yolo approval", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-bash-safe-"));
    try {
      await fs.writeFile(path.join(dir, "ok.txt"), "ok", "utf8");
      await expect(bashTool({ cwd: dir, approval: "ask", sandbox: "workspace-write" }, "pwd")).resolves.toMatchObject({ ok: true });
      const listed = await bashTool({ cwd: dir, approval: "ask", sandbox: "workspace-write" }, "ls");
      expect(listed.ok).toBe(true);
      expect(JSON.stringify(listed.output)).toContain("ok.txt");
      await expect(bashTool({ cwd: dir, approval: "ask", sandbox: "workspace-write" }, "git status")).rejects.toThrow(/requires approval/);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
