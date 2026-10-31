/**
 * snapshot.js — 工作区文件快照（防丢失）
 *
 * 在 Agent 执行危险命令前自动快照目标路径。
 * - macOS: rsync --link-dest（hardlink 去重）
 * - Linux: cp -al（hardlink）
 * - Windows: robocopy /MIR（镜像复制）
 *
 * 快照存储在 ~/.lynn/snapshots/{agent-id}/{timestamp}/
 * 未修改的文件通过 hardlink 共享 inode，零额外磁盘开销。
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execFile, execFileSync } from "child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { debugLog } from "../debug-log.js";

const SNAPSHOT_BASE = path.join(os.homedir(), ".lynn", "snapshots");
const execFileAsync = promisify(execFile);

export interface SnapshotResult {
  snapshotPath: string | null;
  success: boolean;
  error?: string;
}

export interface SnapshotInfo {
  name: string;
  path: string;
  created: Date;
}

interface ExecError extends Error {
  status?: number;
  code?: string | number;
}

/** 确保快照基础目录存在 */
function ensureSnapshotDir(agentId?: string | null): string {
  const dir = path.join(SNAPSHOT_BASE, agentId || "default");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 对目标路径创建增量快照
 * @param {string} targetPath - 要快照的目录
 * @param {string} agentId - agent 标识
 * @param {string} [reason] - 触发原因（用于日志）
 * @returns {{ snapshotPath: string, success: boolean, error?: string }}
 */
export async function createSnapshot(
  targetPath: string | null | undefined,
  agentId?: string | null,
  reason?: string,
): Promise<SnapshotResult> {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return { snapshotPath: null, success: false, error: "target path does not exist" };
  }

  // 只对目录做快照，文件不快照
  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    return { snapshotPath: null, success: false, error: "target is not a directory" };
  }

  const snapshotDir = ensureSnapshotDir(agentId);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19) + "-" + randomUUID().slice(0, 8);
  const snapshotPath = path.join(snapshotDir, timestamp);
  const dirName = path.basename(targetPath);
  const destPath = path.join(snapshotPath, dirName);

  try {
    fs.mkdirSync(snapshotPath, { recursive: true });

    const platform = process.platform;
    if (platform === "darwin") {
      // macOS: rsync with hardlink dedup
      // Find previous snapshot for --link-dest
      const prevSnapshots = fs.readdirSync(snapshotDir)
        .filter(d => d !== timestamp && fs.statSync(path.join(snapshotDir, d)).isDirectory())
        .sort()
        .reverse();

      const args = ["-a"];
      if (prevSnapshots.length > 0) {
        const prevPath = path.join(snapshotDir, prevSnapshots[0], dirName);
        if (fs.existsSync(prevPath)) {
          args.push(`--link-dest=${prevPath}`);
        }
      }
      await execFileAsync("rsync", [...args, "--", `${targetPath}/`, `${destPath}/`], { timeout: 60000, windowsHide: true });
    } else if (platform === "linux") {
      // Linux: cp -al (hardlink copy)
      await execFileAsync("cp", ["-a", "--reflink=auto", "--", targetPath, destPath], { timeout: 60000 });
    } else {
      // Windows: robocopy mirror
      try {
        await execFileAsync("robocopy", [targetPath, destPath, "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns", "/np"], {
          windowsHide: true,
          timeout: 60000,
        });
      } catch (e) {
        // robocopy returns non-zero exit codes for success (1 = files copied)
        const error = e as ExecError;
        const status = typeof error.code === "number" ? error.code : error.status;
        if (status === undefined || status > 7) throw e;
      }
    }

    debugLog()?.log("snapshot", `created snapshot: ${snapshotPath} (reason: ${reason || "manual"})`);
    return { snapshotPath, success: true };
  } catch (err) {
    const message = errorMessage(err);
    debugLog()?.error("snapshot", `snapshot failed: ${message}`);
    return { snapshotPath: null, success: false, error: message };
  }
}

/**
 * 列出某个 agent 的所有快照
 * @param {string} agentId
 * @returns {Array<{ name: string, path: string, created: Date }>}
 */
export function listSnapshots(agentId?: string | null): SnapshotInfo[] {
  const dir = path.join(SNAPSHOT_BASE, agentId || "default");
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter(d => {
      try { return fs.statSync(path.join(dir, d)).isDirectory(); }
      catch { return false; }
    })
    .sort()
    .reverse()
    .map(d => ({
      name: d,
      path: path.join(dir, d),
      created: fs.statSync(path.join(dir, d)).mtime,
    }));
}

/**
 * 恢复快照到目标路径
 * @param {string} snapshotPath - 快照目录
 * @param {string} targetPath - 恢复到的目标路径
 * @returns {{ success: boolean, error?: string }}
 */
export function restoreSnapshot(snapshotPath: string, targetPath: string): Omit<SnapshotResult, "snapshotPath"> {
  if (!fs.existsSync(snapshotPath)) {
    return { success: false, error: "snapshot not found" };
  }

  try {
    // 列出快照中的子目录（原始目录名）
    const contents = fs.readdirSync(snapshotPath);
    if (contents.length === 0) {
      return { success: false, error: "snapshot is empty" };
    }

    const sourcePath = path.join(snapshotPath, contents[0]);
    const platform = process.platform;

    if (platform === "win32") {
      try {
        execFileSync("robocopy", [sourcePath, targetPath, "/MIR", "/NFL", "/NDL", "/NJH", "/NJS", "/nc", "/ns", "/np"], {
          windowsHide: true,
          stdio: "pipe",
          timeout: 120000,
        });
      } catch (e) {
        const error = e as ExecError;
        const status = typeof error.code === "number" ? error.code : error.status;
        if (status === undefined || status > 7) throw e;
      }
    } else {
      execFileSync("rsync", ["-a", "--delete", "--", `${sourcePath}/`, `${targetPath}/`], {
        windowsHide: true,
        stdio: "pipe",
        timeout: 120000,
      });
    }

    debugLog()?.log("snapshot", `restored snapshot: ${snapshotPath} → ${targetPath}`);
    return { success: true };
  } catch (err) {
    const message = errorMessage(err);
    debugLog()?.error("snapshot", `restore failed: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * 清理超期快照
 * @param {string} agentId
 * @param {number} maxDays - 保留天数（默认 7）
 * @returns {number} 删除的快照数
 */
export function cleanupSnapshots(agentId?: string | null, maxDays = 7): number {
  const dir = path.join(SNAPSHOT_BASE, agentId || "default");
  if (!fs.existsSync(dir)) return 0;

  const cutoff = Date.now() - maxDays * 86400000;
  let deleted = 0;

  for (const d of fs.readdirSync(dir)) {
    const fp = path.join(dir, d);
    try {
      const stat = fs.statSync(fp);
      if (stat.isDirectory() && stat.mtimeMs < cutoff) {
        fs.rmSync(fp, { recursive: true, force: true });
        deleted++;
      }
    } catch {}
  }

  if (deleted > 0) {
    debugLog()?.log("snapshot", `cleaned ${deleted} expired snapshots (maxDays=${maxDays})`);
  }
  return deleted;
}

/** 危险命令模式匹配 */
const DANGEROUS_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|.*-[a-zA-Z]*f[a-zA-Z]*)/,  // rm -rf, rm -r, rm -f
  /\brm\s+/,                                                       // any rm
  /\bgit\s+clean\b/,                                               // git clean
  /\bgit\s+checkout\s+--\s+\./,                                    // git checkout -- .
  /\bgit\s+reset\s+--hard/,                                        // git reset --hard
  /\bmv\s+.*\s+\/dev\/null/,                                       // mv to /dev/null
];

/**
 * 检查命令是否为危险操作
 * @param {string} command
 * @returns {boolean}
 */
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some(p => p.test(command));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
