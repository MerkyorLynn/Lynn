import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceSnapshot, recordWorkspaceSnapshotForRequest, restoreWorkspaceSnapshot, autoRollbackEnabled } from "../src/code-snapshot.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-sidecar-snap-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("sidecar workspace snapshots", () => {
  it("records and restores only the file Lynn is about to edit", () => {
    fs.writeFileSync(path.join(dir, "a.ts"), "original\n");
    fs.writeFileSync(path.join(dir, "busy.bin"), "v1\n");
    let snap = createWorkspaceSnapshot(dir);
    snap = recordWorkspaceSnapshotForRequest(dir, snap, { tool: "write_file", args: { path: "a.ts", text: "next\n" } });

    fs.writeFileSync(path.join(dir, "a.ts"), "BROKEN\n");
    fs.writeFileSync(path.join(dir, "busy.bin"), "v2\n");
    const result = restoreWorkspaceSnapshot(dir, snap);

    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, "a.ts"), "utf8")).toBe("original\n");
    expect(fs.readFileSync(path.join(dir, "busy.bin"), "utf8")).toBe("v2\n");
  });

  it("reversibly trashes files created by Lynn when rewinding before their creation", () => {
    let snap = createWorkspaceSnapshot(dir);
    snap = recordWorkspaceSnapshotForRequest(dir, snap, { tool: "write_file", args: { path: "new.ts", text: "created\n" } });
    fs.writeFileSync(path.join(dir, "new.ts"), "created\n");

    const result = restoreWorkspaceSnapshot(dir, snap);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/recoverable/); // moved to trash, not unlinked
    expect(fs.existsSync(path.join(dir, "new.ts"))).toBe(false);
  });

  it("extracts touched files from patches without snapshotting unrelated dirty files", () => {
    fs.writeFileSync(path.join(dir, "a.ts"), "a0\n");
    fs.writeFileSync(path.join(dir, "b.ts"), "b0\n");
    fs.writeFileSync(path.join(dir, "unrelated.pdf"), "external-v1\n");
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-a0",
      "+a1",
      "*** Update File: b.ts",
      "@@",
      "-b0",
      "+b1",
    ].join("\n");
    let snap = createWorkspaceSnapshot(dir);
    snap = recordWorkspaceSnapshotForRequest(dir, snap, { tool: "apply_patch", args: { text: patch } });

    fs.writeFileSync(path.join(dir, "a.ts"), "a1\n");
    fs.writeFileSync(path.join(dir, "b.ts"), "b1\n");
    fs.writeFileSync(path.join(dir, "unrelated.pdf"), "external-v2\n");
    restoreWorkspaceSnapshot(dir, snap);

    expect(fs.readFileSync(path.join(dir, "a.ts"), "utf8")).toBe("a0\n");
    expect(fs.readFileSync(path.join(dir, "b.ts"), "utf8")).toBe("b0\n");
    expect(fs.readFileSync(path.join(dir, "unrelated.pdf"), "utf8")).toBe("external-v2\n");
  });

  it("skips oversized files instead of copying them into the snapshot store", () => {
    fs.writeFileSync(path.join(dir, "large.bin"), Buffer.alloc(6 * 1024 * 1024, 1));
    let snap = createWorkspaceSnapshot(dir);
    snap = recordWorkspaceSnapshotForRequest(dir, snap, { tool: "write_file", args: { path: "large.bin", text: "small\n" } });

    expect(snap.entries).toBe(0);
    expect(snap.skipped).toEqual(["large.bin"]);
  });
});

describe("autoRollbackEnabled (default-on for danger-full-access)", () => {
  it("defaults on only under the danger-full-access sandbox", () => {
    expect(autoRollbackEnabled({})).toBe(false);
    expect(autoRollbackEnabled({}, { sandbox: "workspace-write" })).toBe(false);
    expect(autoRollbackEnabled({}, { sandbox: "read-only" })).toBe(false);
    expect(autoRollbackEnabled({}, { sandbox: "danger-full-access" })).toBe(true);
  });
  it("honors the env override either way", () => {
    expect(autoRollbackEnabled({ LYNN_CLI_AUTO_ROLLBACK: "1" })).toBe(true);
    expect(autoRollbackEnabled({ LYNN_CLI_AUTO_ROLLBACK: "0" }, { sandbox: "danger-full-access" })).toBe(false);
  });
});
