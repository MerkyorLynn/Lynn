/**
 * worktree-manager.ts — git worktree lifecycle for the fleet (B-line).
 * Async wrapper over `git` (extends the execFile pattern of server/git-context.ts).
 * One worktree per worker; changed-files/diff feed the scope guard + the GUI.
 */
import { execFile } from "node:child_process";
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

export class WorktreeManager {
  constructor(private repoRoot: string) {}

  async create(relPath: string, branch: string, baseRef = "HEAD"): Promise<WorktreeInfo> {
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
    return runGit(["diff", baseRef, "--", file], worktreePath).catch(() => "");
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
