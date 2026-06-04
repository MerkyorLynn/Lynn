import { execFileSync } from "node:child_process";

// Git-aware rollback. When the workspace is a git work tree, this is the complete
// and *reversible* way to undo a failed task: instead of overwriting/deleting
// files (the file-snapshot fallback in code-snapshot.ts, which also misses
// bash-made changes), we `git stash push --include-untracked` the task's work
// away. Nothing is destroyed — `git stash pop` brings it all back — and it
// captures every change in the tree, however it was made.

export interface GitRestorePoint {
  cwd: string;
  head: string;
  cleanAtStart: boolean;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/**
 * Capture a restore point iff `cwd` is a git work tree with at least one commit.
 * Returns null otherwise (caller falls back to the file snapshot). Read-only:
 * runs `rev-parse` / `status`, touches nothing.
 */
export function captureGitRestorePoint(cwd: string): GitRestorePoint | null {
  try {
    if (git(cwd, ["rev-parse", "--is-inside-work-tree"]) !== "true") return null;
    const head = git(cwd, ["rev-parse", "HEAD"]); // throws on an unborn branch (no commits)
    const cleanAtStart = git(cwd, ["status", "--porcelain"]) === "";
    return { cwd, head, cleanAtStart };
  } catch {
    return null; // not a git repo, no commits, or git unavailable
  }
}

/**
 * Roll the working tree back to the restore point by stashing the task's changes
 * away — reversibly. `git stash push --include-untracked` moves every tracked and
 * untracked change into a named stash and returns the tree to HEAD; nothing is
 * deleted, and `git stash pop` restores the task's work.
 */
export function restoreGitRestorePoint(point: GitRestorePoint): { ok: boolean; message: string } {
  try {
    if (git(point.cwd, ["status", "--porcelain"]) === "") {
      return { ok: true, message: "git: working tree already clean — nothing to roll back" };
    }
    git(point.cwd, ["stash", "push", "--include-untracked", "-m", `lynn-rollback ${point.head.slice(0, 8)}`]);
    const notes: string[] = [];
    if (safeHead(point.cwd) !== point.head) notes.push("new commits were left in place; only uncommitted work was stashed");
    if (!point.cleanAtStart) notes.push("the tree was already dirty at task start, so pre-existing changes were stashed too");
    const note = notes.length ? ` (${notes.join("; ")})` : "";
    return { ok: true, message: `git: task changes stashed — recover with \`git stash pop\`${note}` };
  } catch (error) {
    return { ok: false, message: `git rollback failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function safeHead(cwd: string): string {
  try {
    return git(cwd, ["rev-parse", "HEAD"]);
  } catch {
    return "";
  }
}
