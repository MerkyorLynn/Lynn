/**
 * path-guard.js — 路径权限校验
 *
 * 定义四种访问级别：BLOCKED / READ_ONLY / READ_WRITE / FULL
 * 所有路径先经过 realpath 解析符号链接，再匹配区域。
 *
 * 常量从 policy.js 导入（单一来源）。
 */

import fs from "fs";
import path from "path";
import os from "os";
import { t } from "../../server/i18n.js";
import {
  BLOCKED_FILES,
  BLOCKED_DIRS,
  READ_ONLY_AGENT_FILES,
  READ_ONLY_AGENT_DIRS,
  READ_ONLY_HOME_DIRS,
  READ_WRITE_AGENT_DIRS,
  READ_WRITE_AGENT_FILES,
  READ_WRITE_HOME_DIRS,
} from "./policy.js";

export const AccessLevel = {
  BLOCKED: "blocked",
  READ_ONLY: "read_only",
  READ_WRITE: "read_write",
  FULL: "full",
};

/** 操作 → 所需最低级别 */
const OP_REQUIREMENTS = {
  read: new Set([AccessLevel.READ_ONLY, AccessLevel.READ_WRITE, AccessLevel.FULL]),
  write: new Set([AccessLevel.READ_WRITE, AccessLevel.FULL]),
  delete: new Set([AccessLevel.FULL]),
};

export class PathGuard {
  /**
   * @param {object} policy  从 deriveSandboxPolicy() 得到，或兼容旧格式
   */
  constructor(policy) {
    if (policy.mode === "full-access") {
      this._fullAccess = true;
      return;
    }
    this._fullAccess = false;
    this.lynnHome = path.resolve(policy.lynnHome);
    this.agentDir = path.resolve(policy.agentDir);
    this.workspace = policy.workspace ? path.resolve(policy.workspace) : null;
    this.trustedRoots = Array.isArray(policy.trustedRoots)
      ? policy.trustedRoots.map((root) => path.resolve(root))
      : (this.workspace ? [this.workspace] : []);
  }

  /**
   * 解析路径（跟踪符号链接）。
   * 文件不存在时递归往上找到最近的存在的祖先目录，
   * 对它做 realpath，然后把不存在的段拼回去。
   * 这样 mkdir -p 多层目录时也能正确判断权限。
   */
  _resolveReal(p) {
    const abs = path.resolve(p);
    try {
      return fs.realpathSync(abs);
    } catch (err) {
      if (err.code !== "ENOENT") return null;

      const pending = [];
      let current = abs;
      while (true) {
        const parent = path.dirname(current);
        if (parent === current) return null;
        pending.push(path.basename(current));
        try {
          const realParent = fs.realpathSync(parent);
          pending.reverse();
          const joined = path.join(realParent, ...pending);

          let check = joined;
          while (true) {
            try {
              const realCheck = fs.realpathSync(check);
              if (!realCheck.startsWith(realParent + path.sep) && realCheck !== realParent) {
                return null;
              }
              break;
            } catch (e2) {
              if (e2.code !== "ENOENT") return null;
              const up = path.dirname(check);
              if (up === check) return null;
              check = up;
            }
          }

          return joined;
        } catch (e) {
          if (e.code !== "ENOENT") return null;
          current = parent;
        }
      }
    }
  }

  /** 判断 target 是否在 base 内部（含相等） */
  _isInside(target, base) {
    return target === base || target.startsWith(base + path.sep);
  }

  /**
   * 获取路径的访问级别
   * @param {string} rawPath 绝对路径
   * @returns {string} AccessLevel
   */
  getAccessLevel(rawPath) {
    const resolved = this._resolveReal(rawPath);
    if (!resolved) return AccessLevel.BLOCKED;

    for (const f of BLOCKED_FILES) {
      if (resolved === path.join(this.lynnHome, f)) return AccessLevel.BLOCKED;
    }

    for (const d of BLOCKED_DIRS) {
      if (this._isInside(resolved, path.join(this.lynnHome, d))) {
        return AccessLevel.BLOCKED;
      }
    }

    for (const f of READ_ONLY_AGENT_FILES) {
      if (resolved === path.join(this.agentDir, f)) return AccessLevel.READ_ONLY;
    }

    for (const d of READ_ONLY_AGENT_DIRS) {
      if (this._isInside(resolved, path.join(this.agentDir, d))) {
        return AccessLevel.READ_ONLY;
      }
    }

    for (const d of READ_ONLY_HOME_DIRS) {
      if (this._isInside(resolved, path.join(this.lynnHome, d))) {
        return AccessLevel.READ_ONLY;
      }
    }

    for (const d of READ_WRITE_AGENT_DIRS) {
      if (this._isInside(resolved, path.join(this.agentDir, d))) {
        return AccessLevel.READ_WRITE;
      }
    }

    for (const f of READ_WRITE_AGENT_FILES) {
      if (resolved === path.join(this.agentDir, f)) return AccessLevel.READ_WRITE;
    }

    for (const d of READ_WRITE_HOME_DIRS) {
      if (this._isInside(resolved, path.join(this.lynnHome, d))) {
        return AccessLevel.READ_WRITE;
      }
    }

    if (this._isInside(resolved, this.lynnHome)) return AccessLevel.BLOCKED;

    for (const root of this.trustedRoots) {
      if (this._isInside(resolved, root)) {
        return AccessLevel.FULL;
      }
    }

    return AccessLevel.BLOCKED;
  }

  /**
   * 检查操作是否被允许
   *
   * 审计模式：始终允许操作，但记录敏感路径访问日志。
   * 安全感来自透明 + 可回滚，而非阻止。
   *
   * @param {string} absolutePath
   * @param {"read"|"write"|"delete"} operation
   * @returns {{ allowed: boolean, reason?: string, logged?: boolean }}
   */
  check(absolutePath, operation) {
    if (this._fullAccess) return { allowed: true };
    const level = this.getAccessLevel(absolutePath);
    const wouldBlock = !(OP_REQUIREMENTS[operation]?.has(level) ?? false);

    if (wouldBlock) {
      const resolved = this._resolveReal(absolutePath) || absolutePath;
      try {
        console.log(`[PathGuard:audit] ${operation} ${resolved} (level=${level})`);
        appendAuditLog({ operation, path: resolved, level, ts: new Date().toISOString() });
      } catch {}
      return { allowed: true, logged: true };
    }

    return { allowed: true };
  }
}

// ── 审计日志持久化 ──

const AUDIT_LOG_PATH = path.join(os.homedir(), ".lynn", "audit.jsonl");
const MAX_AUDIT_SIZE = 2 * 1024 * 1024; // 2MB，超过则截断保留后半

function appendAuditLog(entry) {
  try {
    const dir = path.dirname(AUDIT_LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    // 文件过大时截断（保留后 1MB）
    try {
      const stat = fs.statSync(AUDIT_LOG_PATH);
      if (stat.size > MAX_AUDIT_SIZE) {
        const content = fs.readFileSync(AUDIT_LOG_PATH, "utf-8");
        const lines = content.split("\n");
        const half = Math.floor(lines.length / 2);
        fs.writeFileSync(AUDIT_LOG_PATH, lines.slice(half).join("\n"), "utf-8");
      }
    } catch {}
    fs.appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + "\n", "utf-8");
  } catch {}
}

export function readAuditLog(limit = 100) {
  try {
    if (!fs.existsSync(AUDIT_LOG_PATH)) return [];
    const content = fs.readFileSync(AUDIT_LOG_PATH, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}
