/**
 * mentions.ts — filesystem half of @-mention Tab completion. completion.ts owns
 * the pure string logic; this module lists candidate paths under the workspace.
 * The walk is shallow (only the token's directory), so completion stays instant
 * on large repos, and it never escapes the workspace root.
 */
import fs from "node:fs";
import path from "node:path";

const IGNORE_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".cache",
  ".turbo",
  ".venv",
]);

/**
 * List workspace-relative paths matching the partial @-mention token. Directories
 * come back with a trailing '/' so a follow-up Tab descends into them. Dotfiles are
 * hidden unless the token itself starts with '.'. Anything resolving outside the
 * workspace root returns nothing — @-mentions can't be used to escape the repo.
 */
export function listMentionCandidates(cwd: string, token: string, limit = 50): string[] {
  const root = path.resolve(cwd);
  const slash = token.lastIndexOf("/");
  const dirPart = slash >= 0 ? token.slice(0, slash + 1) : "";
  const namePart = slash >= 0 ? token.slice(slash + 1) : token;
  const absDir = path.resolve(root, dirPart || ".");
  if (absDir !== root && !absDir.startsWith(`${root}${path.sep}`)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && !namePart.startsWith(".")) continue;
    if (entry.isDirectory() && IGNORE_DIRS.has(entry.name)) continue;
    if (!entry.name.startsWith(namePart)) continue;
    out.push(`${dirPart}${entry.name}${entry.isDirectory() ? "/" : ""}`);
  }
  out.sort((a, b) => {
    const aDir = a.endsWith("/");
    const bDir = b.endsWith("/");
    if (aDir !== bDir) return aDir ? -1 : 1; // directories first
    return a.localeCompare(b);
  });
  return out.slice(0, limit);
}
