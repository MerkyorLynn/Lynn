import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGitSnapshot } from "../src/git-checkpoint.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasGit)("createGitSnapshot", () => {
  it("returns null outside a git work tree", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-nogit-"));
    await expect(createGitSnapshot(dir)).resolves.toBeNull();
  });

  it("snapshots a dirty tree (tracked + untracked) non-destructively, and skips a clean one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-git-"));
    git(dir, "init", "-q");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "Test");
    fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-qm", "init");

    // Clean tree → nothing to snapshot.
    await expect(createGitSnapshot(dir)).resolves.toBeNull();

    // Dirty: modify a tracked file AND create an untracked one.
    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
    fs.writeFileSync(path.join(dir, "new.txt"), "brand new\n");

    const snap = await createGitSnapshot(dir);
    expect(snap).not.toBeNull();
    expect(snap!.dirtyFiles).toBeGreaterThanOrEqual(2);

    // The snapshot is a real commit capturing BOTH the change and the untracked file.
    expect(git(dir, "cat-file", "-t", snap!.sha)).toBe("commit");
    expect(git(dir, "show", `${snap!.sha}:a.txt`)).toBe("two");
    expect(git(dir, "show", `${snap!.sha}:new.txt`)).toBe("brand new");

    // Non-destructive: the user's worktree/index is untouched — new.txt is still untracked.
    expect(git(dir, "status", "--porcelain")).toContain("?? new.txt");
    // ...and no branch was moved (HEAD is still the init commit).
    expect(git(dir, "log", "--oneline").split("\n")).toHaveLength(1);
  });
});
