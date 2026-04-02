/**
 * fs.js — 文件系统 API（Web 客户端用）
 *
 * Electron 环境下这些操作走 IPC（preload.cjs），
 * Web / 云部署环境下前端通过这些 HTTP 端点读取文件。
 *
 * 安全：路径限定在受信任的 Lynn/工作区/技能目录内。
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { Hono } from "hono";
import { safeReadFile } from "../../shared/safe-fs.js";

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
  const history = Array.isArray(config.cwd_history) ? config.cwd_history : [];
  return uniqueCanonicalPaths([
    engine.homeCwd,
    prefs.home_folder,
    config.last_cwd,
    ...history,
  ]);
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

  return route;
}
