import path from "path";
import { execFileSync } from "child_process";

function runGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function parseBranchHeader(line) {
  const header = String(line || "").trim();
  const body = header.startsWith("## ") ? header.slice(3) : header;
  const detached = body.startsWith("HEAD ") || body === "HEAD";
  const trackingMatch = body.match(/\[(.*?)\]$/);
  const tracking = trackingMatch?.[1] || "";
  const aheadMatch = tracking.match(/ahead (\d+)/);
  const behindMatch = tracking.match(/behind (\d+)/);

  if (detached) {
    return {
      branch: null,
      detached: true,
      ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
      behind: behindMatch ? Number(behindMatch[1]) : 0,
    };
  }

  const branchPart = body.split("...")[0]?.trim() || null;
  return {
    branch: branchPart,
    detached: false,
    ahead: aheadMatch ? Number(aheadMatch[1]) : 0,
    behind: behindMatch ? Number(behindMatch[1]) : 0,
  };
}

function normalizeChangedPath(rawPath) {
  const cleaned = String(rawPath || "").trim();
  if (!cleaned) return "";
  if (cleaned.includes(" -> ")) {
    return cleaned.split(" -> ").pop()?.trim() || cleaned;
  }
  return cleaned;
}

function parseStatusEntries(lines, maxFiles) {
  const changedFiles = [];
  const seen = new Set();
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;

  for (const line of lines) {
    if (!line || !line.trim()) continue;
    const status = line.slice(0, 2);
    const filePath = normalizeChangedPath(line.slice(3));

    if (status === "??") {
      untrackedCount += 1;
    } else {
      if (status[0] && status[0] !== " ") stagedCount += 1;
      if (status[1] && status[1] !== " ") unstagedCount += 1;
    }

    if (filePath && !seen.has(filePath)) {
      seen.add(filePath);
      if (changedFiles.length < maxFiles) changedFiles.push(filePath);
    }
  }

  return {
    changedFiles,
    totalChanged: seen.size,
    stagedCount,
    unstagedCount,
    untrackedCount,
  };
}

function readRecentCommits(cwd, maxCommits) {
  try {
    const logOutput = runGit(["log", "--oneline", `-${maxCommits}`], cwd);
    if (!logOutput) return [];
    return logOutput
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function readGitContext(targetDir, { maxFiles = 8, maxCommits = 3 } = {}) {
  try {
    const root = runGit(["rev-parse", "--show-toplevel"], targetDir);
    if (!root) return { available: false };

    const statusOutput = runGit(["status", "--porcelain=v1", "--branch"], targetDir);
    const statusLines = statusOutput ? statusOutput.split("\n") : [];
    const branchInfo = parseBranchHeader(statusLines[0] || "");
    const fileInfo = parseStatusEntries(statusLines.slice(1), maxFiles);

    return {
      available: true,
      root,
      repoName: path.basename(root),
      branch: branchInfo.branch,
      detached: branchInfo.detached,
      ahead: branchInfo.ahead,
      behind: branchInfo.behind,
      stagedCount: fileInfo.stagedCount,
      unstagedCount: fileInfo.unstagedCount,
      untrackedCount: fileInfo.untrackedCount,
      totalChanged: fileInfo.totalChanged,
      changedFiles: fileInfo.changedFiles,
      recentCommits: readRecentCommits(targetDir, maxCommits),
    };
  } catch {
    return { available: false };
  }
}
