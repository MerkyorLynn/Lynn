#!/usr/bin/env node
// 根据 package.json version 生成 .github/update-manifest.json。
// 发布约定:跟 electron-builder artifactName 保持一致:
//   Lynn-${version}-macOS-${arch}.dmg
//
// 用法:
//   node --import tsx scripts/generate-update-manifest.ts
//   node --import tsx scripts/generate-update-manifest.ts --channel beta --notes "fix X"
//   node --import tsx scripts/generate-update-manifest.ts --notes-file .github/release-notes.md

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { createHash } from "node:crypto";
import { signUpdateManifest } from "../shared/update-manifest-signature.cjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REPO_BASE = "https://github.com/MerkyorLynn/Lynn";
// [HOTPATCH 2026-04-27 night] 资产 URL 必须走腾讯镜像不能走 GitHub
// CN 用户从 GitHub releases 下载会卡死,memory feedback_macos_dmg_naming.md 早写了这条铁律。
// releaseUrl points at the canonical GitHub Releases page; .dmg/.exe downloads must stay on the download mirror.
const MIRROR_DOWNLOAD_BASE = "https://download.merkyorlynn.com/downloads";

type ReleaseChannel = "stable" | "beta";

interface CliArgs {
  channel: string;
  version: string | null;
  notes: string | null;
  notesFile: string | null;
}

interface ManifestEntry {
  version: string;
  releaseUrl: string;
  notes: string;
  assets: ReturnType<typeof buildAssetUrls>;
  integrity?: Record<string, { size: number; sha512: string }>;
}

type UpdateManifest = Partial<Record<ReleaseChannel | string, ManifestEntry>>;

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const result: CliArgs = { channel: "stable", version: null, notes: null, notesFile: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i] ?? "";
    if (arg === "--channel") result.channel = next();
    else if (arg === "--version") result.version = next();
    else if (arg === "--notes") result.notes = next();
    else if (arg === "--notes-file") result.notesFile = next();
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: generate-update-manifest.ts [--channel stable|beta] [--version X.Y.Z] [--notes \"...\"] [--notes-file path]");
      process.exit(0);
    }
  }
  return result;
}

function readPackageVersion(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8")) as { version?: unknown };
  return typeof pkg.version === "string" ? pkg.version : "";
}

function buildAssetUrls(version: string) {
  // [HOTPATCH 2026-04-27 night] 真实下载 URL 全走腾讯镜像(CN 用户必经),不再用 GitHub。
  // default(fallback)指向镜像站 download.html 让用户自己选,不跳 GitHub release tag。
  const assets: Record<string, string> = {
    "darwin-arm64": `${MIRROR_DOWNLOAD_BASE}/Lynn-${version}-macOS-arm64.dmg`,
    "darwin-x64": `${MIRROR_DOWNLOAD_BASE}/Lynn-${version}-macOS-x64.dmg`,
    default: "https://download.merkyorlynn.com/download.html",
  };
  if (process.env.LYNN_RELEASE_INCLUDE_WINDOWS === "1") {
    assets["win32-x64"] = `${MIRROR_DOWNLOAD_BASE}/Lynn-${version}-Windows-Setup.exe`;
  }
  return assets;
}

function buildDownloadUrls(version: string) {
  return {
    macArm: `${MIRROR_DOWNLOAD_BASE}/Lynn-${version}-macOS-arm64.dmg`,
    macX64: `${MIRROR_DOWNLOAD_BASE}/Lynn-${version}-macOS-x64.dmg`,
    windows: `${MIRROR_DOWNLOAD_BASE}/Lynn-${version}-Windows-Setup.exe`,
  };
}

function resolveNotes({ notes, notesFile }: Pick<CliArgs, "notes" | "notesFile">): string {
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

function isReleaseChannel(value: string): value is ReleaseChannel {
  return value === "stable" || value === "beta";
}

function generateManifest({ channel, version, notes }: {
  channel: ReleaseChannel;
  version: string;
  notes: string;
}): string {
  const manifestPath = path.join(ROOT, ".github/update-manifest.json");
  let existing: UpdateManifest = {};
  if (fs.existsSync(manifestPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as UpdateManifest;
    } catch {
      existing = {};
    }
  }

  const entry: ManifestEntry = {
    version,
    releaseUrl: `${REPO_BASE}/releases/tag/v${version}`,
    notes,
    assets: buildAssetUrls(version),
  };

  const next: UpdateManifest & { version?: string; notes?: string; downloads?: ReturnType<typeof buildDownloadUrls> } = {
    ...existing,
    [channel]: entry,
  };
  const dist = path.join(ROOT, "dist");
  const integrity: Record<string, { size: number; sha512: string }> = {};
  if (fs.existsSync(dist)) {
    for (const name of fs.readdirSync(dist)) {
      if (!name.startsWith(`Lynn-${version}-`) || !/\.(?:dmg|zip|exe)$/.test(name)) continue;
      const file = path.join(dist, name);
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      integrity[name] = { size: stat.size, sha512: createHash("sha512").update(fs.readFileSync(file)).digest("base64") };
    }
  }
  entry.integrity = integrity;
  if (channel === "stable") {
    next.version = version;
    next.notes = notes;
    next.downloads = buildDownloadUrls(version);
  }
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const keyPath = process.env.LYNN_UPDATE_SIGNING_KEY_PATH || path.join(os.homedir(), ".config", "lynn-release", "update-signing-ed25519.pem");
  const signed = signUpdateManifest(next, fs.readFileSync(keyPath, "utf8"));
  fs.writeFileSync(manifestPath, JSON.stringify(signed, null, 2) + "\n", "utf-8");
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
  if (!isReleaseChannel(channel)) {
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
