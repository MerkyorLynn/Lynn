/**
 * git-checkpoint.ts — pair a long coding task's conversation checkpoint with its
 * file state. Resume restores the transcript; this captures the working tree so a
 * paused/continued task can also get its files back.
 *
 * The snapshot is fully NON-DESTRUCTIVE: it builds a dangling commit through a
 * throwaway index (GIT_INDEX_FILE), so the user's real index, staged changes,
 * branch, working tree and stash stack are never touched. Unlike `git stash
 * create`, the temp-index + add -A approach also captures *untracked* new files —
 * which a coding task creates constantly. Restore later with e.g.
 *   git restore --source <sha> -- .      (or)   git stash apply <sha>
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);

export interface GitSnapshot {
  sha: string;
  /** Number of dirty/untracked entries captured (from `git status --porcelain`). */
  dirtyFiles: number;
}

/**
 * Capture the working tree under `cwd` as a dangling commit. Returns null when
 * `cwd` isn't a git work tree, when the tree is clean (nothing to snapshot), or
 * when git is unavailable — callers treat a null snapshot as "skip", never an error.
 */
export async function createGitSnapshot(cwd: string): Promise<GitSnapshot | null> {
  const run = (args: string[], extraEnv?: Record<string, string>) =>
    exec("git", ["-C", cwd, ...args], {
      timeout: 15_000,
      maxBuffer: 64 * 1024 * 1024,
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });

  try {
    const inside = await run(["rev-parse", "--is-inside-work-tree"]);
    if (inside.stdout.trim() !== "true") return null;
  } catch {
    return null;
  }

  let dirtyFiles = 0;
  try {
    const status = await run(["status", "--porcelain"]);
    dirtyFiles = status.stdout.split(/\r?\n/).filter(Boolean).length;
  } catch {
    return null;
  }
  if (dirtyFiles === 0) return null;

  const tmpIndex = path.join(
    os.tmpdir(),
    `lynn-snap-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.index`,
  );
  const withIndex = { GIT_INDEX_FILE: tmpIndex };
  try {
    let head: string | null = null;
    try {
      head = (await run(["rev-parse", "HEAD"])).stdout.trim() || null;
    } catch {
      head = null; // fresh repo with no commits yet
    }
    // Seed the temp index from HEAD so `add -A` only re-hashes what changed.
    if (head) await run(["read-tree", head], withIndex);
    await run(["add", "-A"], withIndex);
    const tree = (await run(["write-tree"], withIndex)).stdout.trim();
    if (!tree) return null;
    const commitArgs = head
      ? ["commit-tree", tree, "-p", head, "-m", "lynn checkpoint"]
      : ["commit-tree", tree, "-m", "lynn checkpoint"];
    const sha = (await run(commitArgs)).stdout.trim();
    if (!sha) return null;
    return { sha, dirtyFiles };
  } catch {
    return null;
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => undefined);
  }
}
