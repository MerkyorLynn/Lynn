/**
 * worktree-manager.ts — git worktree lifecycle for the fleet (B-line).
 * Async wrapper over `git` (extends the execFile pattern of server/git-context.ts).
 * One worktree per worker; changed-files/diff feed the scope guard + the GUI.
 */
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const pExecFile = promisify(execFile);

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await pExecFile("git", args, { cwd, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string | null;
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
}

export interface WorktreeCommitResult {
  changed: boolean;
  commit?: string;
}

export interface WorktreeIntegrateResult {
  branch: string;
  commit: string;
  sourceCommit: string;
  /** Whether the integrated branch was pushed to a remote (close the loop off-machine). */
  pushed: boolean;
  pushRemote?: string;
  /** Set when a requested push failed — the cherry-pick still landed locally. */
  pushError?: string;
}

export class WorktreeManager {
  constructor(private repoRoot: string) {}

  async create(relPath: string, branch: string, baseRef = "HEAD"): Promise<WorktreeInfo> {
    if (!isSafeRelPath(relPath)) throw new Error(`invalid worktree path: ${relPath}`);
    if (!isSafeBranchName(branch)) throw new Error(`invalid branch: ${branch}`);
    await runGit(["worktree", "add", relPath, "-b", branch, baseRef], this.repoRoot);
    return { path: relPath, branch, head: await this.head(relPath) };
  }

  async head(worktreePath: string): Promise<string | null> {
    try {
      return await runGit(["rev-parse", "HEAD"], worktreePath);
    } catch {
      return null;
    }
  }

  /** Changed paths vs baseRef: tracked diff + untracked, deduped. The scope guard's input. */
  async changedFiles(worktreePath: string, baseRef = "HEAD"): Promise<string[]> {
    const tracked = await runGit(["diff", "--name-only", baseRef], worktreePath).catch(() => "");
    const untracked = await runGit(["ls-files", "--others", "--exclude-standard"], worktreePath).catch(() => "");
    const set = new Set<string>();
    for (const line of `${tracked}\n${untracked}`.split("\n")) {
      const p = line.trim();
      if (p) set.add(p);
    }
    return [...set];
  }

  async diffStat(worktreePath: string, baseRef = "HEAD"): Promise<DiffStat> {
    const out = await runGit(["diff", "--numstat", baseRef], worktreePath).catch(() => "");
    let files = 0;
    let insertions = 0;
    let deletions = 0;
    for (const line of out.split("\n")) {
      const m = line.trim().match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
      if (!m) continue;
      files++;
      if (m[1] !== "-") insertions += Number(m[1]);
      if (m[2] !== "-") deletions += Number(m[2]);
    }
    return { files, insertions, deletions };
  }

  /** `git diff` for a single file in the worktree (read-only; for the GUI diff drawer). */
  async fileDiff(worktreePath: string, file: string, baseRef = "HEAD"): Promise<string> {
    const untracked = await runGit(["ls-files", "--others", "--exclude-standard", "--", file], worktreePath).catch(() => "");
    if (untracked.split("\n").map((line) => line.trim()).includes(file)) {
      const { stdout } = await pExecFile("git", ["diff", "--no-index", "--", "/dev/null", file], {
        cwd: worktreePath,
        maxBuffer: 16 * 1024 * 1024,
      }).catch((error: { stdout?: string }) => ({ stdout: error.stdout || "" }));
      return stdout.trim();
    }
    return runGit(["diff", baseRef, "--", file], worktreePath).catch(() => "");
  }

  /** Stage and commit all current worktree changes. Does not merge into the main repo. */
  async commitAll(worktreePath: string, message: string): Promise<WorktreeCommitResult> {
    const status = await runGit(["status", "--porcelain"], worktreePath).catch(() => "");
    if (!status.trim()) return { changed: false };

    await runGit(["add", "-A"], worktreePath);
    if (!(await hasStagedChanges(worktreePath))) return { changed: false };

    await runGit(["commit", "-m", message], worktreePath);
    const commit = await runGit(["rev-parse", "--short", "HEAD"], worktreePath);
    return { changed: true, commit };
  }

  /**
   * Cherry-pick an approved worker commit into a staging branch from a temporary
   * worktree, so the user's main checkout is never switched or dirtied.
   */
  async integrateCommit(
    sourceCommit: string,
    targetBranch = "fleet/integration",
    baseRef = "HEAD",
    opts: { push?: boolean; remote?: string } = {},
  ): Promise<WorktreeIntegrateResult> {
    if (!isSafeBranchName(targetBranch)) throw new Error(`invalid target branch: ${targetBranch}`);
    if (!/^[0-9a-f]{6,40}$/i.test(sourceCommit)) throw new Error(`invalid source commit: ${sourceCommit}`);
    const remote = opts.remote || "origin";
    if (opts.push && !/^[A-Za-z0-9._/-]+$/.test(remote)) throw new Error(`invalid remote: ${remote}`);

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-fleet-integrate-"));
    let added = false;
    try {
      const exists = await branchExists(this.repoRoot, targetBranch);
      await runGit(
        exists
          ? ["worktree", "add", tmp, targetBranch]
          : ["worktree", "add", "-b", targetBranch, tmp, baseRef],
        this.repoRoot,
      );
      added = true;
      await runGit(["cherry-pick", sourceCommit], tmp);
      const commit = await runGit(["rev-parse", "--short", "HEAD"], tmp);
      // Optionally push the integrated branch to a remote — this is what closes
      // the fleet loop off the local machine. A push failure is non-fatal: the
      // cherry-pick already landed locally, so we report it rather than abort.
      let pushed = false;
      let pushError: string | undefined;
      if (opts.push) {
        try {
          await runGit(["push", remote, `HEAD:refs/heads/${targetBranch}`], tmp);
          pushed = true;
        } catch (pushErr) {
          pushError = pushErr instanceof Error ? pushErr.message : String(pushErr);
        }
      }
      return { branch: targetBranch, commit, sourceCommit, pushed, ...(opts.push ? { pushRemote: remote } : {}), ...(pushError ? { pushError } : {}) };
    } catch (e) {
      if (added) await runGit(["cherry-pick", "--abort"], tmp).catch(() => "");
      throw e;
    } finally {
      if (added) await runGit(["worktree", "remove", tmp, "--force"], this.repoRoot).catch(() => "");
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async list(): Promise<WorktreeInfo[]> {
    const out = await runGit(["worktree", "list", "--porcelain"], this.repoRoot).catch(() => "");
    return parseWorktreePorcelain(out);
  }

  async remove(worktreePath: string, force = false): Promise<void> {
    const args = ["worktree", "remove", worktreePath];
    if (force) args.push("--force");
    await runGit(args, this.repoRoot);
  }
}

async function branchExists(repoRoot: string, branch: string): Promise<boolean> {
  try {
    await runGit(["rev-parse", "--verify", `refs/heads/${branch}`], repoRoot);
    return true;
  } catch {
    return false;
  }
}

async function hasStagedChanges(cwd: string): Promise<boolean> {
  try {
    await pExecFile("git", ["diff", "--cached", "--quiet"], { cwd, maxBuffer: 16 * 1024 * 1024 });
    return false;
  } catch (err) {
    if (typeof err === "object" && err && "code" in err && (err as { code?: unknown }).code === 1) {
      return true;
    }
    throw err;
  }
}

function isSafeBranchName(branch: string): boolean {
  if (!branch || branch.startsWith("/") || branch.endsWith("/") || branch.includes("..")) return false;
  if (branch.includes("@{") || branch.endsWith(".lock")) return false;
  return /^[A-Za-z0-9._/-]+$/.test(branch);
}

function isSafeRelPath(p: string): boolean {
  if (!p || path.isAbsolute(p)) return false;
  return !p.split(/[\\/]/).includes("..");
}

/** Pure parser for `git worktree list --porcelain` output (exported for tests). */
export function parseWorktreePorcelain(out: string): WorktreeInfo[] {
  const infos: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> = {};
  const flush = () => {
    if (cur.path) infos.push({ path: cur.path, branch: cur.branch ?? null, head: cur.head ?? null });
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      cur = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace("refs/heads/", "");
    }
  }
  flush();
  return infos;
}
