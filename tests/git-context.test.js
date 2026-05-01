import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import { readGitContext } from "../server/git-context.js";

function git(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "lynn-git-context-"));
}

function realpath(target) {
  return fs.realpathSync.native ? fs.realpathSync.native(target) : fs.realpathSync(target);
}

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe("readGitContext", () => {
  it("returns unavailable for directories outside a git repository", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    expect(readGitContext(dir)).toEqual({ available: false });
  });

  it("summarizes branch, changed files, and recent commits", () => {
    const dir = makeTempDir();
    tempDirs.push(dir);

    git(["init"], dir);
    git(["config", "user.name", "Lynn Test"], dir);
    git(["config", "user.email", "lynn@example.com"], dir);

    fs.writeFileSync(path.join(dir, "tracked.txt"), "line 1\n");
    git(["add", "tracked.txt"], dir);
    git(["commit", "-m", "initial commit"], dir);

    fs.appendFileSync(path.join(dir, "tracked.txt"), "line 2\n");
    fs.writeFileSync(path.join(dir, "staged.txt"), "staged\n");
    git(["add", "staged.txt"], dir);
    fs.writeFileSync(path.join(dir, "new.txt"), "new\n");

    const result = readGitContext(dir);

    expect(result.available).toBe(true);
    expect(realpath(result.root)).toBe(realpath(dir));
    expect(result.repoName).toBe(path.basename(dir));
    expect(typeof result.branch).toBe("string");
    expect(result.detached).toBe(false);
    expect(result.ahead).toBe(0);
    expect(result.behind).toBe(0);
    expect(result.stagedCount).toBe(1);
    expect(result.unstagedCount).toBe(1);
    expect(result.untrackedCount).toBe(1);
    expect(result.totalChanged).toBe(3);
    expect(result.changedFiles).toEqual(expect.arrayContaining(["tracked.txt", "staged.txt", "new.txt"]));
    expect(result.changedFiles).toHaveLength(3);
    expect(result.recentCommits[0]).toMatch(/initial commit$/);
  });
});
