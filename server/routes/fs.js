/**
 * fs.js — 文件系统 API（Web 客户端用）
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

function resolveCanonicalPath(rawPath) {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) return null;

  const absolute = path.resolve(trimmed);
  try {
    return fs.realpathSync(absolute);
  } catch (err) {
    if (err?.code !== "ENOENT") return null;

    const pending = [];
    let current = absolute;
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) return null;
      pending.unshift(path.basename(current));
      try {
        const realParent = fs.realpathSync(parent);
        return path.join(realParent, ...pending);
      } catch (parentErr) {
        if (parentErr?.code !== "ENOENT") return null;
        current = parent;
      }
    }
  }
}

function isInsideRoot(targetPath, rootPath) {
  return targetPath === rootPath || targetPath.startsWith(rootPath + path.sep);
}

function uniqueCanonicalPaths(paths) {
  const out = [];
  const seen = new Set();
  for (const entry of paths) {
    const canonical = resolveCanonicalPath(entry);
    if (!canonical || seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

function getWorkspaceRoots(engine) {
  const config = engine.config || {};
  const prefs = engine.getPreferences?.() || {};
  return uniqueCanonicalPaths(getConfiguredWorkspaceRoots(config, prefs));
}

function getAllowedRoots(engine, mode) {
  const workspaceRoots = getWorkspaceRoots(engine);
  const uploadsRoots = workspaceRoots.map(root => path.join(root, ".lynn-uploads"));

  if (mode === "write") {
    return uniqueCanonicalPaths([
      ...workspaceRoots,
      ...uploadsRoots,
      path.join(os.tmpdir(), ".lynn-uploads"),
    ]);
  }

  const externalSkillPaths = Array.isArray(engine.getPreferences?.()?.external_skill_paths)
    ? engine.getPreferences().external_skill_paths
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

function isSafePath(filePath, allowedRoots) {
  const resolved = resolveCanonicalPath(filePath);
  if (!resolved) return false;
  return allowedRoots.some(root => isInsideRoot(resolved, root));
}

export function createFsRoute(engine) {
  const route = new Hono();
  const editRollbackStore = engine.editRollbackStore || null;

  route.get("/fs/read", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "missing path" }, 400);
    if (!isSafePath(filePath, getAllowedRoots(engine, "read"))) {
      return c.json({ error: "path not allowed" }, 403);
    }
    const content = safeReadFile(filePath, null);
    if (content === null) return c.json({ error: "file not found" }, 404);
    return c.text(content);
  });

  route.get("/fs/read-base64", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "missing path" }, 400);
    if (!isSafePath(filePath, getAllowedRoots(engine, "read"))) {
      return c.json({ error: "path not allowed" }, 403);
    }
    try {
      const buf = fs.readFileSync(filePath);
      return c.text(buf.toString("base64"));
    } catch {
      return c.json({ error: "file not found" }, 404);
    }
  });

  route.get("/fs/docx-html", async (c) => {
    const filePath = c.req.query("path");
    if (!filePath) return c.json({ error: "missing path" }, 400);
    if (!isSafePath(filePath, getAllowedRoots(engine, "read"))) {
      return c.json({ error: "path not allowed" }, 403);
    }
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) return c.json({ error: "not a file" }, 400);
      if (stat.size > 20 * 1024 * 1024) return c.json({ error: "file too large" }, 413);
      const mammoth = (await import("mammoth")).default;
      const result = await mammoth.convertToHtml({ path: filePath });
      return c.text(result.value);
    } catch (err) {
      if (err?.code === "ENOENT") return c.json({ error: "file not found" }, 404);
      return c.json({ error: "docx parse failed" }, 500);
    }
  });

  route.post("/fs/apply", async (c) => {
    try {
      const body = await c.req.json();
      const { filePath, content } = body;
      if (!filePath || typeof content !== "string") {
        return c.json({ error: "missing filePath or content" }, 400);
      }
      if (!isSafePath(filePath, getAllowedRoots(engine, "write"))) {
        return c.json({ error: "path not allowed" }, 403);
      }
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(filePath, content, "utf-8");
      return c.json({ ok: true, bytesWritten: Buffer.byteLength(content, "utf-8") });
    } catch (err) {
      return c.json({ error: err?.message || "write failed" }, 500);
    }
  });

  route.post("/fs/revert-edit", async (c) => {
    try {
      const body = await c.req.json();
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
      if (!isSafePath(snapshot.filePath, getAllowedRoots(engine, "write"))) {
        return c.json({ error: "path not allowed" }, 403);
      }

      const currentContent = safeReadFile(snapshot.filePath, null);
      const currentHash = currentContent == null
        ? null
        : crypto.createHash("sha256").update(currentContent).digest("hex");
      const snapshotHash = crypto.createHash("sha256").update(snapshot.originalContent).digest("hex");

      const dir = path.dirname(snapshot.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(snapshot.filePath, snapshot.originalContent, "utf-8");

      return c.json({
        ok: true,
        filePath: snapshot.filePath,
        bytesWritten: Buffer.byteLength(snapshot.originalContent, "utf-8"),
        rollbackId,
        restoredHash: snapshotHash,
        replacedHash: currentHash,
      });
    } catch (err) {
      return c.json({ error: err?.message || "rollback failed" }, 500);
    }
  });

  // ── [2026-04-16] 对比外部修改：git diff HEAD -- <file> ──
  // 用于查看 Lynn 会话外（Claude Code / VSCode / 手改）对文件的修改
  route.post("/fs/external-diff", async (c) => {
    try {
      const body = await c.req.json();
      const filePath = typeof body?.filePath === "string" ? body.filePath.trim() : "";
      if (!filePath) {
        return c.json({ error: "missing filePath" }, 400);
      }
      if (!isSafePath(filePath, getAllowedRoots(engine, "read"))) {
        return c.json({ error: "path not allowed" }, 403);
      }
      if (!fs.existsSync(filePath)) {
        return c.json({ error: "file not found" }, 404);
      }

      const fileDir = path.dirname(filePath);

      // 查 git 仓库根目录
      let gitRoot = null;
      try {
        gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
          cwd: fileDir,
          encoding: "utf-8",
          stdio: ["pipe", "pipe", "pipe"],
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
        });
        isTracked = true;
      } catch {
        isTracked = false;
      }

      if (isTracked) {
        diffOutput = execFileSync(
          "git",
          ["--no-pager", "diff", "HEAD", "--", relPath],
          { cwd: gitRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
        );
      } else {
        // 新文件（HEAD 里还没有）— 对比空文件
        try {
          diffOutput = execFileSync(
            "git",
            ["--no-pager", "diff", "--no-index", "/dev/null", filePath],
            { cwd: gitRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
          );
        } catch (err2) {
          // git diff --no-index 有改动时退出码为 1，需要 catch 才能拿到输出
          if (err2?.stdout) {
            diffOutput = err2.stdout.toString();
          } else {
            return c.json({ error: "git diff failed: " + (err2?.message || "unknown") }, 500);
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
      let added = 0, removed = 0;
      for (const line of diffOutput.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) added++;
        if (line.startsWith("-") && !line.startsWith("---")) removed++;
      }

      // 保存 rollbackId，使得 reject 可走 /fs/revert-edit 的流程
      // 从 git HEAD 读出原始内容作为 rollback snapshot
      let rollbackId = null;
      try {
        const headContent = execFileSync(
          "git",
          ["--no-pager", "show", `HEAD:${relPath}`],
          { cwd: gitRoot, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
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
      return c.json({ error: err?.message || "external-diff failed" }, 500);
    }
  });

  return route;
}
