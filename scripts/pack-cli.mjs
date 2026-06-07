#!/usr/bin/env node

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ROOT = path.join(ROOT, "cli");
const DEFAULT_OUT = path.join(ROOT, "dist", "cli");
const MAX_CLI_TARBALL_BYTES = 5 * 1024 * 1024;
const CLI_MIRROR_UPLOAD_TARGET = "tencent:/opt/lobster-brain/public/downloads/cli/";

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...(options.env || {}) },
      shell: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`[pack-cli] ${command} ${args.join(" ")} failed with exit ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

async function sha256(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(await fs.readFile(filePath));
  return hash.digest("hex");
}

async function removeOldTarballs(outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const entries = await fs.readdir(outDir).catch(() => []);
  await Promise.all(entries
    .filter((name) => /^lynn(?:-cli)?-\d+\.\d+\.\d+.*\.tgz$/.test(name))
    .map((name) => fs.rm(path.join(outDir, name), { force: true })));
}

async function main() {
  const outDir = path.resolve(arg("--out") || DEFAULT_OUT);
  const cliPkg = JSON.parse(await fs.readFile(path.join(CLI_ROOT, "package.json"), "utf8"));
  const version = cliPkg.version;
  if (cliPkg.name !== "@lynn/cli") {
    throw new Error(`[pack-cli] refusing to pack non-CLI package: ${cliPkg.name || "(missing)"}`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(version || "")) {
    throw new Error(`[pack-cli] invalid CLI version: ${version || "(missing)"}`);
  }

  await removeOldTarballs(outDir);
  const packed = await run("npm", ["pack", "--pack-destination", outDir, "--silent"], { cwd: CLI_ROOT });
  const tarballName = packed.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  const expectedName = `lynn-cli-${version}.tgz`;
  if (tarballName !== expectedName) {
    throw new Error(`[pack-cli] wrong tarball produced: ${tarballName || "(none)"}; expected ${expectedName}. Use \`npm run pack:cli\`, not \`npm pack\` from the repo root.`);
  }

  const tarballPath = path.join(outDir, tarballName);
  const stat = await fs.stat(tarballPath);
  if (stat.size <= 0 || stat.size > MAX_CLI_TARBALL_BYTES) {
    throw new Error(`[pack-cli] suspicious CLI tarball size: ${stat.size} bytes (${tarballPath})`);
  }

  const digest = await sha256(tarballPath);
  const manifest = {
    name: cliPkg.name,
    version,
    file: tarballName,
    path: tarballPath,
    size: stat.size,
    sha256: digest,
    install: `npm install -g --force https://download.merkyorlynn.com/downloads/cli/${tarballName}`,
    uploadTarget: CLI_MIRROR_UPLOAD_TARGET,
    note: "CLI tarballs are served by the nginx alias /downloads/cli/ -> /opt/lobster-brain/public/downloads/cli/, not by /var/www/download-site.",
  };
  await fs.writeFile(path.join(outDir, "lynn-cli-package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`[pack-cli] ${tarballName} ${stat.size} bytes sha256=${digest}`);
  console.log(`[pack-cli] upload target: ${CLI_MIRROR_UPLOAD_TARGET} (not /var/www/download-site)`);
  console.log(`[pack-cli] wrote ${path.relative(ROOT, path.join(outDir, "lynn-cli-package.json"))}`);
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
