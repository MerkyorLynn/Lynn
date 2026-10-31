import { isSensitiveFilePath } from "../../shared/sensitive-file-path.js";
/**
 * fs.ts — 文件系统 API（Web 客户端用）
 *
 * Electron 环境下这些操作走 IPC（preload.cjs），
 * Web / 云部署环境下前端通过这些 HTTP 端点读取文件。
 *
 * 安全：路径限定在受信任的 Lynn/工作区/技能目录内。
 */

import crypto from "crypto";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { safeReadFile } from "../../shared/safe-fs.js";
import { getWorkspaceRoots as getConfiguredWorkspaceRoots } from "../../shared/trusted-roots.js";
import type { TrustedRootsPrefs, WorkspaceRootsConfig } from "../../shared/trusted-roots.js";
import type { EditRollbackStore } from "../chat/edit-rollback-store.js";

type FsPreferences = TrustedRootsPrefs & {
  external_skill_paths?: unknown;
};

type FsRouteEngine = {
  lynnHome?: string;
  skillsDir?: string;
  learnedSkillsDir?: string;
  config?: WorkspaceRootsConfig | null;
  getPreferences?: () => FsPreferences | null | undefined;
  agent?: {
    deskManager?: {
      deskDir?: string;
    } | null;
  } | null;
  editRollbackStore?: Partial<EditRollbackStore> | null;
};

type FsApplyBody = {
  filePath?: unknown;
  content?: unknown;
};

type FsRevertBody = {
  rollbackId?: unknown;
};

type FsExternalDiffBody = {
  filePath?: unknown;
};

type ExecError = NodeJS.ErrnoException & {
  stdout?: Buffer | string;
};

type AccessMode = "read" | "write";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | undefined)?.code;
}

function resolveCanonicalPath(rawPath: unknown): string | null {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) return null;

  const absolute = path.resolve(trimmed);
  try {
    return fs.realpathSync(absolute);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") return null;

    const pending: string[] = [];
    let current = absolute;
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) return null;
      pending.unshift(path.basename(current));
      try {
        const realParent = fs.realpathSync(parent);
        return path.join(realParent, ...pending);
      } catch (parentErr) {
        if (errorCode(parentErr) !== "ENOENT") return null;
        current = parent;
      }
    }
  }
}

function isInsideRoot(targetPath: string, rootPath: string): boolean {
  return targetPath === rootPath || targetPath.startsWith(rootPath + path.sep);
}

function uniqueCanonicalPaths(paths: Iterable<unknown>): string[] {
  const out: string[] = [];
  const seen = new Set();
  for (const entry of paths) {
    const canonical = resolveCanonicalPath(entry);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

function getWorkspaceRoots(engine: FsRouteEngine): string[] {
  const config = engine.config || {};
  const prefs = engine.getPreferences?.() || {};
  return uniqueCanonicalPaths(getConfiguredWorkspaceRoots(config, prefs));
}

function getAllowedRoots(engine: FsRouteEngine, mode: AccessMode): string[] {
  const workspaceRoots = getWorkspaceRoots(engine);
  const uploadsRoots = workspaceRoots.map(root => path.join(root, ".lynn-uploads"));

  if (mode === "write") {
    return uniqueCanonicalPaths([
      ...workspaceRoots,
      ...uploadsRoots,
      path.join(os.tmpdir(), ".lynn-uploads"),
    ]);
  }

  const prefs = engine.getPreferences?.();
  const externalSkillPaths: unknown[] = Array.isArray(prefs?.external_skill_paths)
    ? prefs.external_skill_paths
    : [];

  return uniqueCanonicalPaths([
    engine.lynnHome,
    engine.skillsDir,
    engine.agent?.deskManager?.deskDir,
    engine.learnedSkillsDir,
    ...workspaceRoots,
    ...uploadsRoots,
    path.join(os.tmpdir(), ".lynn-uploads"),
    ...externalSkillPaths,
  ]);
}

// 2026-05-24 P2 security: 即使 ~/.lynn 在 allowed_roots(skills / 配置访问需要),
// 也绝不允许工具调用读敏感凭据文件 — prompt injection 不应能 exfiltrate secrets。
function isSensitivePath(resolvedPath: string, dataRoot?: string): boolean {
  return isSensitiveFilePath(resolvedPath, dataRoot ? resolveCanonicalPath(dataRoot) || dataRoot : undefined);
}

function isSafePath(filePath: unknown, allowedRoots: readonly string[], dataRoot?: string): boolean {
  const resolved = resolveCanonicalPath(filePath);
  if (!resolved) return false;
  if (isSensitivePath(resolved, dataRoot)) return false;  // 显式 deny secrets
  return allowedRoots.some(root => isInsideRoot(resolved, root));
}

class FilePreviewError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 413) { super(message); }
}

function readAllowedFile(filePath: string, allowedRoots: string[], dataRoot?: string, limit = 8 * 1024 * 1024): Buffer {
  const canonical = resolveCanonicalPath(filePath);
  if (!canonical || !isSafePath(canonical, allowedRoots, dataRoot)) throw new FilePreviewError("path not allowed", 403);
  const before = fs.statSync(canonical);
  let fd: number | undefined;
  try {
    fd = fs.openSync(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new FilePreviewError("not a file", 400);
    if (before.dev !== opened.dev || before.ino !== opened.ino || fs.realpathSync(canonical) !== canonical
      || resolveCanonicalPath(filePath) !== canonical) throw new FilePreviewError("path changed during read", 403);
    if (opened.size > limit) throw new FilePreviewError("file too large", 413);
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - total + 1));
      const count = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      total += count;
      if (total > limit) throw new FilePreviewError("file too large", 413);
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (errorCode(error) === "ELOOP") throw new FilePreviewError("path changed during read", 403);
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function createFsRoute(engine: FsRouteEngine): Hono {
  const route = new Hono();
  const editRollbackStore = engine.editRollbackStore || null;

  route.get("/fs/read", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "missing path" }, 400);
    if (!isSafePath(filePath, getAllowedRoots(engine, "read"), engine.lynnHome)) {
      return c.json({ error: "path not allowed" }, 403);
    }
    try {
      return c.text(readAllowedFile(filePath, getAllowedRoots(engine, "read"), engine.lynnHome).toString("utf8"));
    } catch (error) {
      if (error instanceof FilePreviewError) return c.json({ error: error.message }, error.status);
      return c.json({ error: "file not found" }, 404);
    }
  });

  route.get("/fs/read-base64", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "missing path" }, 400);
    if (!isSafePath(filePath, getAllowedRoots(engine, "read"), engine.lynnHome)) {
      return c.json({ error: "path not allowed" }, 403);
    }
    try {
      const buf = readAllowedFile(filePath, getAllowedRoots(engine, "read"), engine.lynnHome, 50 * 1024 * 1024);
      return c.text(buf.toString("base64"));
    } catch (error) {
      if (error instanceof FilePreviewError) return c.json({ error: error.message }, error.status);
      return c.json({ error: "file not found" }, 404);
    }
  });

  route.get("/fs/docx-html", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "missing path" }, 400);
    if (!isSafePath(filePath, getAllowedRoots(engine, "read"), engine.lynnHome)) {
      return c.json({ error: "path not allowed" }, 403);
    }
    try {
      const buffer = readAllowedFile(filePath, getAllowedRoots(engine, "read"), engine.lynnHome, 20 * 1024 * 1024);
      const mammoth = (await import("mammoth")).default;
      const result = await mammoth.convertToHtml({ buffer });
      return c.text(result.value);
    } catch (err) {
      if (err instanceof FilePreviewError) return c.json({ error: err.message }, err.status);
      if (errorCode(err) === "ENOENT") return c.json({ error: "file not found" }, 404);
      return c.json({ error: "docx parse failed" }, 500);
    }
  });

  route.post("/fs/apply", async (c) => {
    try {
      const body = await c.req.json() as FsApplyBody;
      const { filePath, content } = body;
      if (!filePath || typeof content !== "string") {
        return c.json({ error: "missing filePath or content" }, 400);
      }
      // 2026-05-25 P1-2 (security): TOCTOU fix — 写入必须用 canonical 解析后的路径,
      // 不能用 raw filePath。否则 symlink swap 攻击:check 时 workspace/notes.md → /tmp/safe,
      // write 时被换成 → ~/.ssh/authorized_keys。canonical 解析锁定 inode,确保 check 和 write
      // 看的是同一个文件。
      const allowedRoots = getAllowedRoots(engine, "write");
      if (!isSafePath(filePath, allowedRoots, engine.lynnHome)) {
        return c.json({ error: "path not allowed" }, 403);
      }
      const canonical = resolveCanonicalPath(filePath);
      if (!canonical || !isSafePath(canonical, allowedRoots)) {
        return c.json({ error: "path not allowed (canonical recheck)" }, 403);
      }
      const dir = path.dirname(canonical);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(canonical, content, "utf-8");
      return c.json({ ok: true, bytesWritten: Buffer.byteLength(content, "utf-8") });
    } catch (err) {
      return c.json({ error: errorMessage(err) || "write failed" }, 500);
    }
  });

  route.post("/fs/revert-edit", async (c) => {
    try {
      const body = await c.req.json() as FsRevertBody;
      const rollbackId = typeof body?.rollbackId === "string" ? body.rollbackId.trim() : "";

      if (!rollbackId) {
        return c.json({ error: "missing rollbackId" }, 400);
      }
      if (!editRollbackStore?.get) {
        return c.json({ error: "rollback unavailable" }, 503);
      }

      const snapshot = editRollbackStore.get(rollbackId);
      if (!snapshot) {
        return c.json({ error: "rollback not found" }, 404);
      }
      if (!snapshot.filePath || typeof snapshot.originalContent !== "string") {
        return c.json({ error: "rollback snapshot invalid" }, 500);
      }
      // 2026-05-25 P1-2 (security): TOCTOU fix — 同 /fs/apply,用 canonical 路径写入。
      const allowedRoots = getAllowedRoots(engine, "write");
      if (!isSafePath(snapshot.filePath, allowedRoots)) {
        return c.json({ error: "path not allowed" }, 403);
      }
      const canonical = resolveCanonicalPath(snapshot.filePath);
      if (!canonical || !isSafePath(canonical, allowedRoots)) {
        return c.json({ error: "path not allowed (canonical recheck)" }, 403);
      }

      const currentContent = safeReadFile(canonical, null);
      const currentHash = currentContent == null
        ? null
        : crypto.createHash("sha256").update(currentContent).digest("hex");
      const snapshotHash = crypto.createHash("sha256").update(snapshot.originalContent).digest("hex");

      const dir = path.dirname(canonical);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(canonical, snapshot.originalContent, "utf-8");

      return c.json({
        ok: true,
        filePath: snapshot.filePath,
        bytesWritten: Buffer.byteLength(snapshot.originalContent, "utf-8"),
        rollbackId,
        restoredHash: snapshotHash,
        replacedHash: currentHash,
      });
    } catch (err) {
      return c.json({ error: errorMessage(err) || "rollback failed" }, 500);
    }
  });

  // ── [2026-04-16] 对比外部修改：git diff HEAD -- <file> ──
  // 用于查看 Lynn 会话外（Claude Code / VSCode / 手改）对文件的修改
  route.post("/fs/external-diff", async (c) => {
    try {
      const body = await c.req.json() as FsExternalDiffBody;
      const filePath = typeof body?.filePath === "string" ? body.filePath.trim() : "";
      if (!filePath) {
        return c.json({ error: "missing filePath" }, 400);
      }
      if (!isSafePath(filePath, getAllowedRoots(engine, "read"), engine.lynnHome)) {
        return c.json({ error: "path not allowed" }, 403);
      }
      if (!fs.existsSync(filePath)) {
        return c.json({ error: "file not found" }, 404);
      }

      const fileDir = path.dirname(filePath);

      // 查 git 仓库根目录
      let gitRoot: string | null = null;
      try {
        gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
          cwd: fileDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        }).trim();
      } catch {
        return c.json({
          ok: false,
          hasChanges: false,
          source: "none",
          message: "文件不在 git 仓库内，无法对比外部修改",
        });
      }

      // 相对仓库根的路径
      const relPath = path.relative(gitRoot, filePath);

      // git diff HEAD -- <file>（unified diff 格式）
      // 注意：未跟踪新文件对 `git diff HEAD -- file` 会返回空，因此必须先判定 tracked 状态。
      let diffOutput = "";
      let isTracked = false;
      try {
        execFileSync("git", ["ls-files", "--error-unmatch", "--", relPath], {
          cwd: gitRoot,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        });
        isTracked = true;
      } catch {
        isTracked = false;
      }

      if (isTracked) {
        diffOutput = execFileSync(
          "git",
          ["--no-pager", "diff", "HEAD", "--", relPath],
          { cwd: gitRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
        );
      } else {
        // 新文件（HEAD 里还没有）— 对比空文件
        try {
          diffOutput = execFileSync(
            "git",
            ["--no-pager", "diff", "--no-index", "/dev/null", filePath],
            { cwd: gitRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
          );
        } catch (err2) {
          // git diff --no-index 有改动时退出码为 1，需要 catch 才能拿到输出
          const diffErr = err2 as ExecError;
          if (diffErr.stdout) {
            diffOutput = diffErr.stdout.toString();
          } else {
            return c.json({ error: "git diff failed: " + (errorMessage(err2) || "unknown") }, 500);
          }
        }
      }

      if (!diffOutput || !diffOutput.trim()) {
        return c.json({
          ok: true,
          hasChanges: false,
          filePath,
          source: "git",
          message: "没有检测到外部修改",
        });
      }

      // 统计 +/-
      let added = 0;
      let removed = 0;
      for (const line of diffOutput.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) added++;
        if (line.startsWith("-") && !line.startsWith("---")) removed++;
      }

      // 保存 rollbackId，使得 reject 可走 /fs/revert-edit 的流程
      // 从 git HEAD 读出原始内容作为 rollback snapshot
      let rollbackId: string | null = null;
      try {
        const headContent = execFileSync(
          "git",
          ["--no-pager", "show", `HEAD:${relPath}`],
          { cwd: gitRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
        );
        if (editRollbackStore?.finalize && editRollbackStore?.setPending) {
          const tmpId = `external-${crypto.randomBytes(8).toString("hex")}`;
          editRollbackStore.setPending(tmpId, {
            sessionPath: "",
            cwd: fileDir,
            filePath,
            originalContent: headContent,
          });
          const finalized = editRollbackStore.finalize(tmpId);
          rollbackId = finalized?.rollbackId || null;
        }
      } catch {
        // HEAD 没有这个文件（新增文件）— 回滚 = 删除文件
        // 暂不支持此场景的 reject（rollbackId 留 null）
      }

      return c.json({
        ok: true,
        hasChanges: true,
        filePath,
        diff: diffOutput,
        linesAdded: added,
        linesRemoved: removed,
        source: "git",
        rollbackId,
      });
    } catch (err) {
      return c.json({ error: errorMessage(err) || "external-diff failed" }, 500);
    }
  });

  return route;
}
