/**
 * policy.js — 沙盒策略单一来源
 *
 * 所有 ACL 常量在这里定义一份。
 * PathGuard 和 OS 沙盒（seatbelt/bwrap）都从这里导入。
 */

import path from "path";

// ─── 常量 ─────────────────────────────────────

/** lynnHome 根级别被屏蔽的文件 */
export const BLOCKED_FILES = ["auth.json", "models.json", "added-models.yaml", "crash.log"];

/** lynnHome 根级别被屏蔽的目录 */
export const BLOCKED_DIRS = ["browser-data", "playwright-browsers"];

/** agentDir 下只读的文件 */
export const READ_ONLY_AGENT_FILES = [
  "ishiki.md",
  "config.yaml",
  "identity.md",
  "yuan.md",
];

/** lynnHome 根级别只读的目录 */
export const READ_ONLY_HOME_DIRS = ["user"];

/** agentDir 下可读写的目录 */
export const READ_WRITE_AGENT_DIRS = [
  "memory",
  "sessions",
  "desk",
  "heartbeat",
  "book",
  "activity",
  "avatars",
];

/** agentDir 下只读的目录（install_skill 工具绕过 PathGuard 直接写入） */
export const READ_ONLY_AGENT_DIRS = ["learned-skills"];

/** agentDir 下可读写的文件 */
export const READ_WRITE_AGENT_FILES = ["pinned.md", "channels.md"];

/** lynnHome 根级别可读写的目录
 * 说明：
 * - skills 是 Lynn 自己的用户技能工作区，沙盒模式下也应允许 agent 在这里创建/更新技能。
 * - 仍然不会放开整个 lynnHome；只有显式列出的子目录可写。
 */
export const READ_WRITE_HOME_DIRS = ["channels", "logs", "skills"];

function uniqueResolvedPaths(paths) {
  const out = [];
  const seen = new Set();
  for (const entry of paths || []) {
    if (!entry) continue;
    const resolved = path.resolve(entry);
    const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

// ─── 策略推导 ──────────────────────────────────

/**
 * 从 agent 配置推导沙盒策略
 *
 * @param {object} opts
 * @param {string} opts.agentDir
 * @param {string|null} opts.workspace
 * @param {string[]|null} [opts.trustedRoots]
 * @param {string} opts.lynnHome
 * @param {"standard"|"full-access"} opts.mode
 * @returns {object} policy
 */
export function deriveSandboxPolicy({ agentDir, workspace, trustedRoots, lynnHome, mode }) {
  if (mode === "full-access") {
    return { mode: "full-access" };
  }

  const normalizedTrustedRoots = uniqueResolvedPaths([
    ...(Array.isArray(trustedRoots) ? trustedRoots : []),
    workspace,
  ]);

  return {
    mode: "standard",
    lynnHome,
    agentDir,
    workspace,
    trustedRoots: normalizedTrustedRoots,

    // OS 沙盒用：可写路径
    writablePaths: uniqueResolvedPaths([
      ...READ_WRITE_AGENT_DIRS.map((d) => path.join(agentDir, d)),
      ...READ_WRITE_HOME_DIRS.map((d) => path.join(lynnHome, d)),
      ...normalizedTrustedRoots,
    ]),

    // OS 沙盒用：拒绝读取（文件 + 目录）
    denyReadPaths: [
      ...BLOCKED_FILES.map((f) => path.join(lynnHome, f)),
      ...BLOCKED_DIRS.map((d) => path.join(lynnHome, d)),
    ],

    // OS 沙盒用：写保护（在可写范围内再限制）
    protectedPaths: uniqueResolvedPaths(normalizedTrustedRoots.map((root) => path.join(root, ".git"))),
  };
}
