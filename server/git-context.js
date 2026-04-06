import fs from "fs";
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

function countUnifiedDiffStats(diffText) {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const line of String(diffText || "").split("\n")) {
    if (line.startsWith("+++")) continue;
    if (line.startsWith("---")) continue;
    if (line.startsWith("+")) linesAdded += 1;
    if (line.startsWith("-")) linesRemoved += 1;
  }
  return { linesAdded, linesRemoved };
}

function readRepoLineStats(cwd) {
  try {
    const output = runGit(["diff", "--numstat", "HEAD"], cwd);
    if (!output) return { linesAdded: 0, linesRemoved: 0 };
    let linesAdded = 0;
    let linesRemoved = 0;
    for (const line of output.split("\n")) {
      const [added, removed] = line.split("\t");
      const addNum = Number.parseInt(added, 10);
      const removeNum = Number.parseInt(removed, 10);
      if (!Number.isNaN(addNum)) linesAdded += addNum;
      if (!Number.isNaN(removeNum)) linesRemoved += removeNum;
    }
    return { linesAdded, linesRemoved };
  } catch {
    return { linesAdded: 0, linesRemoved: 0 };
  }
}

function buildSyntheticUntrackedDiff(filePath, absolutePath) {
  try {
    const raw = fs.readFileSync(absolutePath, "utf8");
    const lines = raw.split(/\r?\n/);
    const header = `@@ -0,0 +1,${Math.max(lines.length, 1)} @@`;
    const body = lines.slice(0, 400).map((line) => `+${line}`).join("\n");
    const diff = [
      `--- /dev/null`,
      `+++ b/${filePath}`,
      header,
      body,
    ].filter(Boolean).join("\n");
    return {
      available: true,
      filePath,
      diff,
      linesAdded: lines.length,
      linesRemoved: 0,
      synthetic: true,
      untracked: true,
    };
  } catch {
    return { available: false, filePath, diff: "", linesAdded: 0, linesRemoved: 0 };
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
    const lineInfo = readRepoLineStats(targetDir);

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
      linesAdded: lineInfo.linesAdded,
      linesRemoved: lineInfo.linesRemoved,
      changedFiles: fileInfo.changedFiles,
      recentCommits: readRecentCommits(targetDir, maxCommits),
    };
  } catch {
    return { available: false };
  }
}

export function readGitDiff(targetDir, filePath) {
  try {
    const root = runGit(["rev-parse", "--show-toplevel"], targetDir);
    if (!root) return { available: false, filePath };
    const normalized = String(filePath || "").trim().replace(/^\/+/, "");
    if (!normalized) return { available: false, filePath };

    let diff = "";
    try {
      diff = runGit(["diff", "--no-ext-diff", "HEAD", "--", normalized], targetDir);
    } catch {
      diff = "";
    }

    if (diff) {
      return {
        available: true,
        filePath: normalized,
        diff,
        ...countUnifiedDiffStats(diff),
        synthetic: false,
        untracked: false,
      };
    }

    const absolutePath = path.join(root, normalized);
    if (fs.existsSync(absolutePath)) {
      return buildSyntheticUntrackedDiff(normalized, absolutePath);
    }

    return { available: false, filePath: normalized, diff: "", linesAdded: 0, linesRemoved: 0 };
  } catch {
    return { available: false, filePath, diff: "", linesAdded: 0, linesRemoved: 0 };
  }
}
