#!/usr/bin/env node

/**
 * Prepare the pinned llama.cpp Linux x64 CPU runtime.
 *
 * Mirrors prepare-windows-llamacpp.mjs, with three deliberate differences:
 *
 *   1. The upstream asset is a .tar.gz, so extraction shells out to tar.
 *   2. The archive ships versioned .so files with relative symlinks (libllama.so
 *      -> libllama.so.0 -> libllama.so.0.0.10153). We resolve them with cp -L so
 *      the vendor tree holds real files: electron-builder's asar/extraResources
 *      copy does not preserve symlinks reliably, and a dangling symlink would
 *      break the runtime silently.
 *   3. Binaries are ELF, so instead of checking for the "MZ" magic we check the
 *      ELF magic and that the executable bit survived.
 *
 * The pinned source is verified by SHA-256 before anything is unpacked, and the
 * resulting directory is re-verified against a generated manifest, so a partial
 * or tampered download can never reach a release build.
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SPEC_PATH = path.join(ROOT, "build", "linux-llamacpp-runtime.json");
const TARGET_DIR = path.join(ROOT, "vendor", "llama.cpp", "linux-x64");
const RUNTIME_MANIFEST = "runtime-manifest.json";
const verifyOnly = process.argv.includes("--verify-only");

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyFile(filePath, expected, label) {
  const stat = await fs.stat(filePath);
  if (stat.size !== expected.size) {
    throw new Error(`${label} size mismatch: expected ${expected.size}, got ${stat.size}`);
  }
  const digest = await sha256(filePath);
  if (digest !== expected.sha256) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expected.sha256}, got ${digest}`);
  }
}

async function download(url, outputPath) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status}) for ${url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(outputPath, { flags: "wx" }));
}

async function extractTarGz(archivePath, outputDir) {
  // --strip-components=1 drops the <tag>/ wrapper, so the files land flat.
  await execFileAsync("tar", ["-xzf", archivePath, "-C", outputDir, "--strip-components=1"]);
}

async function verifyElfExecutable(filePath) {
  const handle = await fs.open(filePath, "r");
  try {
    const magic = Buffer.alloc(4);
    await handle.read(magic, 0, magic.length, 0);
    if (!magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
      throw new Error(`${path.basename(filePath)} is not an ELF binary`);
    }
    const stat = await fs.stat(filePath);
    if ((stat.mode & 0o111) === 0) {
      throw new Error(`${path.basename(filePath)} is not executable`);
    }
  } finally {
    await handle.close();
  }
}

async function buildRuntimeManifest(spec, runtimeDir) {
  const files = {};
  for (const name of [...spec.files, spec.license.name]) {
    const filePath = path.join(runtimeDir, name);
    const stat = await fs.stat(filePath);
    files[name] = { size: stat.size, sha256: await sha256(filePath) };
  }
  return {
    schemaVersion: 1,
    sourceTag: spec.tag,
    sourceArchive: spec.archive.name,
    sourceArchiveSize: spec.archive.size,
    sourceArchiveSha256: spec.archive.sha256,
    files,
  };
}

async function verifyRuntime(spec, runtimeDir) {
  const manifestPath = path.join(runtimeDir, RUNTIME_MANIFEST);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== 1
    || manifest.sourceTag !== spec.tag
    || manifest.sourceArchive !== spec.archive.name
    || manifest.sourceArchiveSize !== spec.archive.size
    || manifest.sourceArchiveSha256 !== spec.archive.sha256
  ) {
    throw new Error("runtime manifest does not match the pinned llama.cpp source");
  }

  const expectedNames = [...spec.files, spec.license.name].sort();
  const manifestNames = Object.keys(manifest.files || {}).sort();
  if (JSON.stringify(manifestNames) !== JSON.stringify(expectedNames)) {
    throw new Error("runtime manifest file list does not match the allowlist");
  }

  const directoryNames = (await fs.readdir(runtimeDir))
    .filter((name) => name !== RUNTIME_MANIFEST)
    .sort();
  if (JSON.stringify(directoryNames) !== JSON.stringify(expectedNames)) {
    throw new Error("runtime directory contains missing or unexpected files");
  }

  for (const name of expectedNames) {
    const filePath = path.join(runtimeDir, name);
    // Symlinks must be gone: a dangling link would pass existsSync-style checks
    // but fail at exec time.
    if ((await fs.lstat(filePath)).isSymbolicLink()) {
      throw new Error(`${name} is still a symlink; expected a resolved file`);
    }
    await verifyFile(filePath, manifest.files[name], name);
    if (name === "llama-server") {
      await verifyElfExecutable(filePath);
    }
  }
  await verifyFile(path.join(runtimeDir, spec.license.name), spec.license, spec.license.name);
  return manifest;
}

async function main() {
  if (process.platform !== "linux") {
    throw new Error(`this script targets linux; current platform is ${process.platform}`);
  }
  const spec = JSON.parse(await fs.readFile(SPEC_PATH, "utf8"));
  if (verifyOnly) {
    await verifyRuntime(spec, TARGET_DIR);
    console.log(`[llama.cpp] verified ${spec.tag} Linux x64 runtime at ${TARGET_DIR}`);
    return;
  }

  try {
    await verifyRuntime(spec, TARGET_DIR);
    console.log(`[llama.cpp] verified existing ${spec.tag} Linux x64 runtime; download skipped`);
    return;
  } catch {
    // Missing or stale runtime: rebuild it atomically from the pinned source.
  }

  await fs.mkdir(path.dirname(TARGET_DIR), { recursive: true });
  const workDir = await fs.mkdtemp(path.join(path.dirname(TARGET_DIR), ".prepare-linux-"));
  const archivePath = path.join(workDir, spec.archive.name);
  const extractedDir = path.join(workDir, "extracted");
  const stagingDir = path.join(workDir, "runtime");
  const licensePath = path.join(stagingDir, spec.license.name);
  try {
    await fs.mkdir(extractedDir, { recursive: true });
    await fs.mkdir(stagingDir, { recursive: true });

    console.log(`[llama.cpp] downloading pinned ${spec.tag} Linux x64 runtime`);
    await download(spec.archive.url, archivePath);
    await verifyFile(archivePath, spec.archive, spec.archive.name);
    await extractTarGz(archivePath, extractedDir);

    // -L dereferences the versioned .so symlinks into real files.
    for (const name of spec.files) {
      await execFileAsync("cp", ["-L", path.join(extractedDir, name), path.join(stagingDir, name)]);
    }
    await execFileAsync("chmod", ["755", path.join(stagingDir, "llama-server")]);
    await verifyElfExecutable(path.join(stagingDir, "llama-server"));

    await download(spec.license.url, licensePath);
    await verifyFile(licensePath, spec.license, spec.license.name);

    const runtimeManifest = await buildRuntimeManifest(spec, stagingDir);
    await fs.writeFile(
      path.join(stagingDir, RUNTIME_MANIFEST),
      `${JSON.stringify(runtimeManifest, null, 2)}\n`,
      "utf8",
    );
    await verifyRuntime(spec, stagingDir);

    await fs.rm(TARGET_DIR, { recursive: true, force: true });
    await fs.rename(stagingDir, TARGET_DIR);
    await verifyRuntime(spec, TARGET_DIR);
    console.log(`[llama.cpp] ready: ${spec.files.length} files plus MIT license`);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[llama.cpp] prepare failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
