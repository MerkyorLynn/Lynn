import os from "os";
import path from "path";

function normalizeKey(p) {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

export function getDefaultDesktopRoot() {
  return path.join(os.homedir(), "Desktop");
}

function isLegacyDesktopWorkspaceSeed(prefs = {}, configuredRoots = null) {
  if (prefs?.setupComplete === true) return false;

  const desktopRoot = getDefaultDesktopRoot();
  const topLevelHome = normalizeTrustedRoot(prefs?.home_folder);
  const deskHome = normalizeTrustedRoot(prefs?.desk?.home_folder);
  const topLevelRoots = configuredRoots ?? uniqueTrustedRoots(
    Array.isArray(prefs?.trusted_roots) ? prefs.trusted_roots : []
  );
  const deskRoots = uniqueTrustedRoots(
    Array.isArray(prefs?.desk?.trusted_roots) ? prefs.desk.trusted_roots : []
  );

  if (deskHome || deskRoots.length > 0) return false;

  const usesDesktopHome = topLevelHome === desktopRoot;
  const usesOnlyDesktopRoots = topLevelRoots.length > 0 && topLevelRoots.every((root) => root === desktopRoot);
  const hasOnlyLegacyTopLevelRoots = topLevelRoots.length === 0 || usesOnlyDesktopRoots;

  return hasOnlyLegacyTopLevelRoots && (usesDesktopHome || usesOnlyDesktopRoots);
}

export function normalizeTrustedRoot(rawPath) {
  if (typeof rawPath !== "string") return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.includes("\0")) return null;
  const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
  return path.resolve(expanded);
}

export function uniqueTrustedRoots(paths) {
  const out = [];
  const seen = new Set();
  for (const entry of paths || []) {
    const normalized = normalizeTrustedRoot(entry);
    if (!normalized) continue;
    const key = normalizeKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export function getConfiguredTrustedRoots(prefs = {}) {
  const configuredRoots = uniqueTrustedRoots([
    ...(Array.isArray(prefs?.trusted_roots) ? prefs.trusted_roots : []),
    ...(Array.isArray(prefs?.desk?.trusted_roots) ? prefs.desk.trusted_roots : []),
  ]);
  return isLegacyDesktopWorkspaceSeed(prefs, configuredRoots) ? [] : configuredRoots;
}

export function getPreferredHomeFolder(prefs = {}) {
  const configured = normalizeTrustedRoot(prefs?.home_folder)
    || normalizeTrustedRoot(prefs?.desk?.home_folder);
  if (!configured) return null;
  return isLegacyDesktopWorkspaceSeed(prefs) ? null : configured;
}

export function getBaselineTrustedRoots(prefs = {}) {
  return uniqueTrustedRoots([getPreferredHomeFolder(prefs)]);
}

export function getEffectiveTrustedRoots(prefs = {}) {
  return uniqueTrustedRoots([
    ...getBaselineTrustedRoots(prefs),
    ...getConfiguredTrustedRoots(prefs),
  ]);
}

export function getWorkspaceRoots(config = {}, prefs = {}) {
  const history = Array.isArray(config?.cwd_history) ? config.cwd_history : [];
  return uniqueTrustedRoots([
    ...getEffectiveTrustedRoots(prefs),
    config?.last_cwd,
    ...history,
  ]);
}
