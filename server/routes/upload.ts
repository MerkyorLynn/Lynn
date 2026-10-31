/**
 * upload.js — 文件上传路由
 *
 * POST /api/upload
 * Body: { paths: ["/absolute/path/to/file_or_dir", ...] }
 *
 * 纯粹的"搬运"操作：把文件或文件夹复制到统一的 uploads 目录。
 * 不做任何业务判断（PDF 解析、图片识别等由 skill 层处理）。
 *
 * 存储位置：
 *   - 有工作目录时：{cwd}/.lynn-uploads/
 *   - 无工作目录时：{os.tmpdir()}/.lynn-uploads/
 *
 * 返回复制后的新路径列表，供 agent 通过 read_file / list_files 访问。
 */
import fs from "fs";
import path from "path";
import os from "os";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { safeJson } from "../hono-helpers.js";
import { t } from "../i18n.js";
import { registerSessionFile, resolveSessionFile } from "../../lib/session-files.js";

const MAX_FILES = 9;

type UploadBody = {
  paths?: string[];
};

type UploadResult = {
  uploadId?: string;
  src: string;
  dest?: string;
  name?: string;
  isDirectory?: boolean;
  error?: string;
};

type UploadRouteEngine = {
  listSessions?: () => Array<{ path: string }> | Promise<Array<{ path: string }>>;
  cwd: string;
};

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 递归统计路径中的文件数量（文件夹递归计数内部文件，普通文件计 1） */
function countFiles(p: string, depth = 0, budget = { remaining: 10_000 }): number {
  try {
    if (depth > 32 || budget.remaining <= 0) return 0;
    budget.remaining -= 1;
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink()) return 0;
    if (!stat.isDirectory()) return 1;
    let count = 0;
    for (const entry of fs.readdirSync(p)) {
      count += countFiles(path.join(p, entry), depth + 1, budget);
      if (budget.remaining <= 0) break;
    }
    return count;
  } catch {
    return 0;
  }
}

/** 清理超过 24 小时的上传临时文件 */
function cleanOldUploads(uploadsDir: string): void {
  try {
    if (!fs.existsSync(uploadsDir)) return;
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of fs.readdirSync(uploadsDir, { withFileTypes: true })) {
      const fullPath = path.join(uploadsDir, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) {
          fs.rmSync(fullPath, { recursive: true, force: true });
        }
      } catch {
        // Ignore files that disappeared during cleanup.
      }
    }
  } catch {
    // Missing upload directory is not an error during cleanup.
  }
}

export function createUploadRoute(engine: UploadRouteEngine): Hono {
  const route = new Hono();
  const pending = new Map<string, { path: string; name: string; expires: number; bound: Map<string, string> }>();

  // The target session is known only when the composer submits its message.
  // Accept server-issued upload IDs, never a caller-supplied source file path.
  route.post("/upload/bind", async c => {
    const body = await safeJson<{ sessionPath?: string; uploadIds?: string[] }>(c);
    if (!Array.isArray(body.uploadIds) || body.uploadIds.length > MAX_FILES || body.uploadIds.some(id => typeof id !== "string")) return c.json({ error: "Invalid upload IDs" }, 400);
    const session = (await engine.listSessions?.() || []).find(item => item.path === body.sessionPath);
    if (!session) return c.json({ error: "Session not found" }, 404);
    const uploads = body.uploadIds.map(id => pending.get(id));
    if (uploads.some(item => !item || item.expires < Date.now())) return c.json({ error: "Upload expired. Add the attachment again before sending." }, 410);
    try {
      const files = uploads.map((item, index) => {
        const upload = item!;
        const existing = upload.bound.get(session.path);
        const fileId = existing || registerSessionFile(session.path, upload.path, { copy: true, name: upload.name }).fileId;
        upload.bound.set(session.path, fileId);
        const resolved = resolveSessionFile(session.path, fileId);
        return { ...resolved.file, uploadId: body.uploadIds![index], path: resolved.localPath };
      });
      return c.json({ files });
    } catch { return c.json({ error: "Attachment is unavailable. Add the attachment again before sending." }, 400); }
  });

  route.post("/upload", async (c) => {
    const body = await safeJson<UploadBody>(c);
    const { paths } = body;
    if (!Array.isArray(paths) || paths.length === 0) {
      return c.json({ error: t("error.pathsRequired") }, 400);
    }

    // 统计总文件数（文件夹递归计数）
    let totalFiles = 0;
    for (const p of paths) {
      totalFiles += countFiles(p);
    }
    if (totalFiles > MAX_FILES) {
      return c.json({
        error: t("error.tooManyFiles", { max: MAX_FILES, n: totalFiles }),
        totalFiles,
        max: MAX_FILES,
      }, 400);
    }

    // 确定 uploads 目录
    const cwd = engine.cwd;
    const isRealCwd = cwd !== process.cwd();
    const uploadsDir = isRealCwd
      ? path.join(cwd, ".lynn-uploads")
      : path.join(os.tmpdir(), ".lynn-uploads");

    fs.mkdirSync(uploadsDir, { recursive: true });

    // 清理超过 24 小时的旧上传文件
    cleanOldUploads(uploadsDir);
    for (const [id, upload] of pending) if (upload.expires < Date.now()) pending.delete(id);

    const results: UploadResult[] = [];

    for (const srcPath of paths) {
      try {
        if (!path.isAbsolute(srcPath)) {
          results.push({ src: srcPath, error: "Path must be absolute" });
          continue;
        }
        if (!fs.existsSync(srcPath)) {
          results.push({ src: srcPath, error: t("error.pathNotFound") });
          continue;
        }

        const stat = fs.statSync(srcPath);
        const name = path.basename(srcPath);
        const timestamp = `${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
        const isDir = stat.isDirectory();

        // 统一命名：原名_时间戳（文件保留扩展名）
        const ext = isDir ? "" : path.extname(srcPath);
        const base = isDir ? name : path.basename(srcPath, ext);
        const destName = `${base}_${timestamp}${ext}`;
        const destPath = path.join(uploadsDir, destName);

        if (isDir) {
          // 递归复制整个目录
          fs.cpSync(srcPath, destPath, { recursive: true });
        } else {
          fs.copyFileSync(srcPath, destPath);
        }

        let uploadId: string | undefined;
        if (!isDir && stat.size <= 50 * 1024 * 1024 && pending.size < 4096) {
          uploadId = randomUUID();
          pending.set(uploadId, { path: fs.realpathSync(destPath), name, expires: Date.now() + 24 * 60 * 60 * 1000, bound: new Map() });
        }
        results.push({
          src: srcPath,
          dest: destPath,
          name,
          isDirectory: isDir,
          uploadId,
        });
      } catch (err) {
        results.push({ src: srcPath, error: errorMessage(err) });
      }
    }

    return c.json({ uploads: results, uploadsDir });
  });

  return route;
}
