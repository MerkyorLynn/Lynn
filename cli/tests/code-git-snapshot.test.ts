import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureGitRestorePoint, restoreGitRestorePoint } from "../src/code-git-snapshot.js";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-git-snap-"));
  made.push(dir);
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "t@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(dir, "a.txt"), "original\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

describe("git restore point", () => {
  it("returns null outside a git work tree", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lynn-nogit-"));
    made.push(dir);
    expect(captureGitRestorePoint(dir)).toBeNull();
  });

  it("rolls back tracked + untracked changes, reversibly via the stash", () => {
    const dir = initRepo();
    const point = captureGitRestorePoint(dir);
    expect(point?.cleanAtStart).toBe(true);

    // A failed task makes a mess: a tracked edit + a brand-new untracked file.
    fs.writeFileSync(path.join(dir, "a.txt"), "BROKEN\n");
    fs.writeFileSync(path.join(dir, "new.txt"), "junk\n");

    const res = restoreGitRestorePoint(point!);
    expect(res.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("original\n");
    expect(fs.existsSync(path.join(dir, "new.txt"))).toBe(false);

    // Reversible: the task's work is recoverable from the stash, nothing destroyed.
    git(dir, ["stash", "pop"]);
    expect(fs.readFileSync(path.join(dir, "a.txt"), "utf8")).toBe("BROKEN\n");
    expect(fs.existsSync(path.join(dir, "new.txt"))).toBe(true);
  });

  it("is a safe no-op when the tree is already clean", () => {
    const dir = initRepo();
    const res = restoreGitRestorePoint(captureGitRestorePoint(dir)!);
    expect(res.ok).toBe(true);
    expect(res.message).toMatch(/nothing to roll back/);
  });
});
