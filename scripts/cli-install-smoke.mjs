#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const cliRoot = path.join(root, "cli");
const nodeBin = process.execPath;

function stringArg(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

const remoteRequested = process.argv.includes("--remote");
const externalTarball = stringArg("--tarball-url") || process.env.LYNN_CLI_TARBALL_URL || null;
if (remoteRequested && !externalTarball) {
  throw new Error("[cli-install-smoke] --remote requires LYNN_CLI_TARBALL_URL or --tarball-url <url>");
}

function run(name, command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env: { ...process.env, ...(options.env || {}) },
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { name, code, stdout, stderr };
      if (code === 0) {
        resolve(result);
      } else {
        reject(new Error(`[cli-install-smoke] ${name} failed with exit ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`));
      }
    });
    if (typeof options.stdin === "string") child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

function assertIncludes(name, text, needle) {
  if (!text.includes(needle)) {
    throw new Error(`[cli-install-smoke] ${name} output did not include ${JSON.stringify(needle)}\n${text}`);
  }
}

function assertNotIncludes(name, text, needle) {
  if (text.includes(needle)) {
    throw new Error(`[cli-install-smoke] ${name} output unexpectedly included ${JSON.stringify(needle)}\n${text}`);
  }
}

function assertNpmInstallClean(result) {
  const combined = `${result.stdout}\n${result.stderr}`;
  assertNotIncludes(result.name, combined, "EBADENGINE");
  assertNotIncludes(result.name, combined, "EEXIST");
}

function binPath(installDir, name) {
  return process.platform === "win32"
    ? path.join(installDir, "node_modules", ".bin", `${name}.cmd`)
    : path.join(installDir, "node_modules", ".bin", name);
}

async function existingBin(installDir, names) {
  for (const name of names) {
    const candidate = binPath(installDir, name);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next spelling. npm on case-insensitive filesystems may only
      // materialize one of Lynn/lynn even when both are declared.
    }
  }
  throw new Error(`[cli-install-smoke] none of these CLI bins exist: ${names.join(", ")}`);
}

async function assertNoLiteralLowercaseShim(dir) {
  if (process.platform === "win32") return;
  const entries = await fs.readdir(dir).catch(() => []);
  if (entries.includes("lynn")) {
    throw new Error(`[cli-install-smoke] unexpected lowercase lynn shim in ${dir}; npm cannot install Lynn/lynn safely on case-insensitive filesystems`);
  }
}

async function seedLegacyLowercaseShim(globalDir) {
  if (process.platform === "win32") return;
  const legacyPkgBin = path.join(globalDir, "lib", "node_modules", "@lynn", "cli", "bin");
  await fs.mkdir(legacyPkgBin, { recursive: true });
  await fs.writeFile(path.join(legacyPkgBin, "lynn.mjs"), "#!/usr/bin/env node\n", "utf8");
  const legacyShim = path.join(globalDir, "bin", "lynn");
  await fs.rm(legacyShim, { force: true });
  await fs.symlink("../lib/node_modules/@lynn/cli/bin/lynn.mjs", legacyShim);
}

if (!externalTarball) {
  await fs.access(path.join(cliRoot, "package.json")).catch(() => {
    throw new Error("[cli-install-smoke] missing cli/package.json; run from repo root");
  });
}

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "lynn-cli-install-smoke-"));
const packDir = path.join(tmp, "pack");
const installDir = path.join(tmp, "consumer");
const globalDir = path.join(tmp, "global");
const dataDir = path.join(tmp, "data");
const npmCacheDir = path.join(tmp, "npm-cache");
await fs.mkdir(packDir, { recursive: true });
await fs.mkdir(installDir, { recursive: true });
await fs.mkdir(path.join(globalDir, "bin"), { recursive: true });
await fs.mkdir(dataDir, { recursive: true });
await fs.mkdir(npmCacheDir, { recursive: true });

try {
  let tarball = externalTarball;
  let tarballName = externalTarball || "";
  if (!tarball) {
    const packed = await run("npm pack", "npm", ["pack", "--pack-destination", packDir, "--silent"], { cwd: cliRoot });
    tarballName = packed.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    if (!tarballName) throw new Error("[cli-install-smoke] npm pack did not report a tarball");
    tarball = path.join(packDir, tarballName);
    await fs.access(tarball);
  }

  await fs.writeFile(path.join(installDir, "package.json"), JSON.stringify({ private: true, type: "module" }, null, 2), "utf8");
  const installLabel = externalTarball ? "remote CLI" : "packed CLI";
  const npmInstallFlags = ["--silent", "--omit=dev", "--cache", npmCacheDir];
  if (externalTarball) npmInstallFlags.push("--prefer-online");
  const localInstall = await run(`npm install ${installLabel}`, "npm", ["install", ...npmInstallFlags, tarball], { cwd: installDir });
  assertNpmInstallClean(localInstall);

  await seedLegacyLowercaseShim(globalDir);
  const globalInstall = await run(`npm global install ${installLabel}`, "npm", ["install", "--global", "--prefix", globalDir, ...npmInstallFlags, tarball], { cwd: installDir });
  assertNpmInstallClean(globalInstall);
  const globalLynn = process.platform === "win32"
    ? path.join(globalDir, "Lynn.cmd")
    : path.join(globalDir, "bin", "Lynn");
  await assertNoLiteralLowercaseShim(path.join(globalDir, "bin"));
  const globalVersion = await run("global Lynn version", globalLynn, ["version"], { cwd: installDir });
  assertIncludes(globalVersion.name, globalVersion.stdout, "@lynn/cli");

  await assertNoLiteralLowercaseShim(path.join(installDir, "node_modules", ".bin"));
  const lynnBin = await existingBin(installDir, ["Lynn"]);

  const version = await run("Lynn version", lynnBin, ["version"], { cwd: installDir });
  assertIncludes(version.name, version.stdout, "@lynn/cli");

  const doctor = await run("Lynn doctor offline", lynnBin, ["doctor", "--offline"], { cwd: installDir, env: { LYNN_DATA_DIR: dataDir } });
  assertIncludes(doctor.name, doctor.stdout, "OK node");
  assertIncludes(doctor.name, doctor.stdout, "brain: skipped");

  const mock = await run("Lynn mock prompt", lynnBin, ["-p", "你好", "--mock-brain"], { cwd: installDir, env: { LYNN_DATA_DIR: dataDir } });
  assertIncludes(mock.name, mock.stdout, "你好");
  assertNotIncludes(mock.name, mock.stdout, "Cannot find module");

  const localRuntime = await run("Lynn local runtime answer", lynnBin, ["-p", "你的版本号", "--json", "--brain-url", "http://127.0.0.1:1"], { cwd: installDir, env: { LYNN_DATA_DIR: dataDir } });
  assertIncludes(localRuntime.name, localRuntime.stdout, "\"local\":true");
  assertIncludes(localRuntime.name, localRuntime.stdout, "Lynn CLI 版本");
  assertIncludes(localRuntime.name, localRuntime.stdout, "0.80.3");
  assertNotIncludes(localRuntime.name, localRuntime.stdout + localRuntime.stderr, "fetch failed");

  const nonRuntime = await run("Lynn non-version prompt", lynnBin, ["-p", "write a semantic version comparator", "--mock-brain", "--json", "--brain-url", "http://127.0.0.1:1"], { cwd: installDir, env: { LYNN_DATA_DIR: dataDir } });
  assertIncludes(nonRuntime.name, nonRuntime.stdout, "semantic version comparator");
  assertNotIncludes(nonRuntime.name, nonRuntime.stdout, "\"local\":true");
  assertNotIncludes(nonRuntime.name, nonRuntime.stdout, "Lynn CLI 版本");

  const tools = await run("Lynn code list tools", lynnBin, ["code", "--list-tools"], { cwd: installDir, env: { LYNN_DATA_DIR: dataDir } });
  assertIncludes(tools.name, tools.stdout, "read_file");
  assertIncludes(tools.name, tools.stdout, "apply_patch");

  const codePrompt = await run("Lynn code headless prompt", lynnBin, ["code", "-p", "headless smoke", "--mock-brain", "--json"], { cwd: installDir, env: { LYNN_DATA_DIR: dataDir } });
  assertIncludes(codePrompt.name, codePrompt.stdout, "\"type\":\"code.task.started\"");
  assertIncludes(codePrompt.name, codePrompt.stdout, "\"task\":\"headless smoke\"");
  assertIncludes(codePrompt.name, codePrompt.stdout, "\"type\":\"code.task.finished\"");
  assertNotIncludes(codePrompt.name, codePrompt.stdout, "code mode ready");

  await run("direct node entry", nodeBin, [path.join(installDir, "node_modules", "@lynn", "cli", "bin", "lynn.mjs"), "version"], { cwd: installDir });

  console.log(`[cli-install-smoke] ${externalTarball ? "remote" : "packed"} install passed: ${tarballName}`);
} finally {
  if (process.env.KEEP_LYNN_CLI_INSTALL_SMOKE !== "1") {
    await fs.rm(tmp, { recursive: true, force: true });
  } else {
    console.log(`[cli-install-smoke] kept temp dir: ${tmp}`);
  }
}
