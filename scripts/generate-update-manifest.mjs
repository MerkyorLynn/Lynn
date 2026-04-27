#!/usr/bin/env node
// 根据 package.json version 生成 .github/update-manifest.json。
// 发布约定: arm64 → Apple-Silicon / x64 → Intel (见 feedback_macos_dmg_naming)。
//
// 用法:
//   node scripts/generate-update-manifest.mjs
//   node scripts/generate-update-manifest.mjs --channel beta --notes "fix X"
//   node scripts/generate-update-manifest.mjs --notes-file .github/release-notes.md

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REPO_BASE = "https://github.com/MerkyorLynn/Lynn";
// [HOTPATCH 2026-04-27 night] 资产 URL 必须走腾讯镜像不能走 GitHub
// CN 用户从 GitHub releases 下载会卡死,memory feedback_macos_dmg_naming.md 早写了这条铁律。
// releaseUrl 保留 GitHub(官方 release notes 页) — 但 .dmg/.exe 真实下载必须从镜像站走。
const MIRROR_DOWNLOAD_BASE = "https://download.merkyorlynn.com/downloads";

function parseArgs() {
  const args = process.argv.slice(2);
  const result = { channel: "stable", version: null, notes: null, notesFile: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i];
    if (arg === "--channel") result.channel = next();
    else if (arg === "--version") result.version = next();
    else if (arg === "--notes") result.notes = next();
    else if (arg === "--notes-file") result.notesFile = next();
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: generate-update-manifest.mjs [--channel stable|beta] [--version X.Y.Z] [--notes \"...\"] [--notes-file path]");
      process.exit(0);
    }
  }
  return result;
}

function readPackageVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));
  return pkg.version;
}

function buildAssetUrls(version) {
  // [HOTPATCH 2026-04-27 night] 真实下载 URL 全走腾讯镜像(CN 用户必经),不再用 GitHub。
  // default(fallback)指向镜像站 download.html 让用户自己选,不跳 GitHub release tag。
  return {
    "darwin-arm64": `${MIRROR_DOWNLOAD_BASE}/Lynn-${version}-macOS-Apple-Silicon.dmg`,
    "darwin-x64": `${MIRROR_DOWNLOAD_BASE}/Lynn-${version}-macOS-Intel.dmg`,
    "win32-x64": `${MIRROR_DOWNLOAD_BASE}/Lynn-${version}-Windows-Setup.exe`,
    default: "https://download.merkyorlynn.com/download.html",
  };
}

function resolveNotes({ notes, notesFile }) {
  if (notes) return notes.trim();
  if (notesFile) {
    const resolved = path.isAbsolute(notesFile) ? notesFile : path.join(ROOT, notesFile);
    if (fs.existsSync(resolved)) return fs.readFileSync(resolved, "utf-8").trim();
    console.error(`[generate-manifest] notes file not found: ${notesFile}`);
    process.exit(1);
  }
  const defaultFile = path.join(ROOT, ".github/release-notes.md");
  if (fs.existsSync(defaultFile)) return fs.readFileSync(defaultFile, "utf-8").trim();
  return "";
}

function generateManifest({ channel, version, notes }) {
  const manifestPath = path.join(ROOT, ".github/update-manifest.json");
  let existing = {};
  if (fs.existsSync(manifestPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    } catch {
      existing = {};
    }
  }

  const entry = {
    version,
    releaseUrl: `${REPO_BASE}/releases/tag/v${version}`,
    notes,
    assets: buildAssetUrls(version),
  };

  const next = { ...existing, [channel]: entry };
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(next, null, 2) + "\n", "utf-8");
  return manifestPath;
}

function main() {
  const { channel, notes, notesFile, version } = parseArgs();
  const finalVersion = version || readPackageVersion();
  const finalNotes = resolveNotes({ notes, notesFile });

  if (!finalVersion) {
    console.error("Error: no version (pass --version or ensure package.json has version)");
    process.exit(1);
  }
  if (channel !== "stable" && channel !== "beta") {
    console.error(`Error: invalid channel "${channel}" (must be stable or beta)`);
    process.exit(1);
  }

  const manifestPath = generateManifest({ channel, version: finalVersion, notes: finalNotes });
  const rel = path.relative(ROOT, manifestPath);
  console.log(`[generate-manifest] wrote ${rel} (channel=${channel}, version=${finalVersion}${finalNotes ? "" : ", empty notes"})`);
  if (!finalNotes) {
    console.log("[generate-manifest] hint: pass --notes \"...\" or create .github/release-notes.md for release notes");
  }
}

main();
