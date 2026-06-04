"use strict";

// Path canonicalization + containment for file-access security (extracted from main.cjs).

const fs = require("fs");
const path = require("path");

function normalizePolicyPath(p) {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

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

function isPathInsideRoot(targetPath, rootPath) {
  const target = normalizePolicyPath(path.resolve(targetPath));
  const root = normalizePolicyPath(path.resolve(rootPath));
  return target === root || target.startsWith(root + path.sep);
}

function uniqueCanonicalPaths(paths) {
  const out = [];
  const seen = new Set();
  for (const p of paths) {
    const canonical = resolveCanonicalPath(p);
    if (!canonical) continue;
    const key = normalizePolicyPath(canonical);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canonical);
  }
  return out;
}

module.exports = { normalizePolicyPath, resolveCanonicalPath, isPathInsideRoot, uniqueCanonicalPaths };
