#!/usr/bin/env node
/**
 * build-server.mjs — 构建 server 独立分发包
 *
 * 策略：Vite bundle + 外部依赖 npm install + Node.js runtime
 * Vite 把 server/core/lib/shared/hub 源码打成几个 chunk，
 * 只有 native addon 和无法 bundle 的 SDK 作为 external 走 npm ci。
 *
 * 关键设计：用目标 Node.js runtime 来装依赖和编译 native addon，
 * 确保 better-sqlite3 的 ABI 跟运行时一致（系统 Node 版本可能不同）。
 * Vite build 用系统 Node 跑（构建时工具，不涉及 ABI）。
 *
 * 产出结构：
 *   dist-server/{platform}-{arch}/
 *     lynn-server             ← shell wrapper（设置 LYNN_ROOT 并启动）
 *     node                    ← Node.js runtime
 *     bundle/                 ← Vite bundle 产出
 *       index.js              ← 入口（~750KB）
 *       chunks/               ← 按模块拆分的 chunk
 *         shared-XXXX.js
 *         core-XXXX.js
 *         lib-XXXX.js
 *         hub-XXXX.js
 *     lib/                    ← 数据文件（非源码，运行时 fromRoot() 读取）
 *       known-models.json
 *       default-models.json
 *       config.example.yaml
 *       identity.example.md
 *       ishiki.example.md
 *       pinned.example.md
 *       identity-templates/
 *       ishiki-templates/
 *       public-ishiki-templates/
 *       content-filter-data/
 *       yuan/
 *       experts/
 *     desktop/src/locales/    ← i18n 资源
 *     skills2set/             ← 技能包
 *     package.json            ← external deps + version（node_modules 解析 + 运行时版本读取）
 *     package-lock.json       ← 锁定依赖版本
 *     node_modules/           ← 仅 external deps（~50 packages）
 */
import fs from "fs";
import path from "path";
import { execSync, execFileSync } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { builtinModules } from "module";
import { build as esbuild } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const platform = process.argv[2] || process.platform;
const arch = process.argv[3] || process.arch;
// electron-builder 的 ${os} 变量：darwin→"mac"、win32→"win"、linux→"linux"
const osDirName = platform === "darwin" ? "mac" : platform === "win32" ? "win" : platform;
const outDir = path.join(ROOT, "dist-server", `${osDirName}-${arch}`);
const depsRoot = process.env.LYNN_BUILD_DEPS_ROOT;
const dependencySource = depsRoot
  ? fs.realpathSync(path.join(depsRoot, `${osDirName}-${arch}`))
  : null;
if (dependencySource) {
  const outputRoot = fs.existsSync(outDir) ? fs.realpathSync(outDir) : path.resolve(outDir);
  const relative = path.relative(outputRoot, dependencySource);
  if (!relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    throw new Error("[build-server] Dependency source must be separate from the output directory");
  }
}

console.log(`[build-server] Building for ${platform}-${arch}...`);

// ── 0. 清理 ──
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// ── 1. 下载 / 缓存 Node.js runtime ──
// 先拿到目标 Node，后续 npm ci 全用它跑，保证 ABI 一致
const runtimeCatalog = JSON.parse(fs.readFileSync(path.join(ROOT, "shared", "node-runtime-checksums.json"), "utf8"));
const NODE_VERSION = runtimeCatalog.version;
const cacheDir = path.join(ROOT, ".cache", "node-runtime");
fs.mkdirSync(cacheDir, { recursive: true });

const nodeMap = {
  "darwin-arm64": `node-${NODE_VERSION}-darwin-arm64`,
  "darwin-x64": `node-${NODE_VERSION}-darwin-x64`,
  "linux-x64": `node-${NODE_VERSION}-linux-x64`,
  "linux-arm64": `node-${NODE_VERSION}-linux-arm64`,
  "win32-x64": `node-${NODE_VERSION}-win-x64`,
};

const nodeDirName = nodeMap[`${platform}-${arch}`];
if (!nodeDirName) {
  console.error(`[build-server] ⚠ 不支持的平台: ${platform}-${arch}`);
  process.exit(1);
}

const isWin = platform === "win32";
const ext = isWin ? "zip" : "tar.gz";
const filename = `${nodeDirName}.${ext}`;
const cachedArchive = path.join(cacheDir, filename);
const cachedNodeBin = isWin
  ? path.join(cacheDir, nodeDirName, "node.exe")
  : path.join(cacheDir, nodeDirName, "bin", "node");
const cachedNpmCli = isWin
  ? path.join(cacheDir, nodeDirName, "node_modules", "npm", "bin", "npm-cli.js")
  : path.join(cacheDir, nodeDirName, "lib", "node_modules", "npm", "bin", "npm-cli.js");

if (!fs.existsSync(cachedNodeBin)) {
  if (process.env.LYNN_BUILD_OFFLINE === "1") throw new Error(`[build-server] Offline build requires cached runtime: ${cachedNodeBin}`);
  const url = `https://nodejs.org/dist/${NODE_VERSION}/${filename}`;
  console.log(`[build-server] downloading Node.js ${NODE_VERSION} for ${platform}-${arch}...`);
  if (!fs.existsSync(cachedArchive)) execFileSync("curl", ["--fail", "--location", "--output", cachedArchive, url], { stdio: "inherit", windowsHide: true });
  const { createHash } = await import("node:crypto");
  const expectedHash = runtimeCatalog.files?.[filename]?.sha256;
  const actualHash = createHash("sha256").update(fs.readFileSync(cachedArchive)).digest("hex");
  if (!expectedHash || actualHash !== expectedHash) throw new Error(`[build-server] Node archive checksum mismatch: ${filename}`);

  if (isWin) {
    // 跨平台兼容：macOS/Linux 上用 unzip，Windows 上用 powershell
    if (process.platform === "win32") {
      execSync(`powershell -command "Expand-Archive -Path '${cachedArchive}' -DestinationPath '${cacheDir}' -Force"`, { stdio: "inherit" });
    } else {
      execSync(`unzip -o -q "${cachedArchive}" -d "${cacheDir}"`, { stdio: "inherit" });
    }
  } else {
    execSync(`tar xzf "${cachedArchive}" -C "${cacheDir}"`, { stdio: "inherit" });
  }

  // Keep the verified archive available for reproducible/offline builds.
  console.log("[build-server] Node.js runtime cached");
} else {
  console.log(`[build-server] using cached Node.js ${NODE_VERSION}`);
}

if (platform === process.platform && arch === process.arch) {
  const actualVersion = execFileSync(cachedNodeBin, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
  if (actualVersion !== NODE_VERSION) throw new Error(`[build-server] cached Node version mismatch: ${actualVersion}`);
}

// 复制 node 二进制到 dist
// Windows 上改名为 lynn-server.exe，让 main.cjs 的 bundled server 检测能命中，
// 同时在任务管理器中显示为 lynn-server.exe 而非 node.exe（便于 NSIS 安装脚本按名杀进程）
const destNode = path.join(outDir, isWin ? "lynn-server.exe" : "node");
fs.copyFileSync(cachedNodeBin, destNode);
if (!isWin) fs.chmodSync(destNode, 0o755);
console.log("[build-server] Node.js runtime ready");

// helper: 用目标 Node 跑命令
// 跨平台或跨架构构建（如 arm64 macOS 构建 x64 macOS / Windows）时，
// 目标 Node 运行时可能无法在当前机器直接执行。
// 此时改用宿主 Node 驱动安装流程，并通过环境变量指定目标平台/架构。
const isCrossBuild = platform !== process.platform || arch !== process.arch;
const hostNodeBin = isCrossBuild ? process.execPath : cachedNodeBin;
const hostNodeDir = path.dirname(hostNodeBin);
// npm run 会注入当前包的 lifecycle/package 元数据；子 npm install 继承后
// 可能把根包的 postinstall 错误套用到 dist-server，导致打包链路失败。
const nestedInstallEnv = { ...process.env };
for (const key of Object.keys(nestedInstallEnv)) {
  if (
    key === "INIT_CWD" ||
    key === "npm_command" ||
    key === "npm_config_local_prefix" ||
    key === "npm_config_prefix" ||
    key === "npm_execpath" ||
    key === "npm_prefix" ||
    key.startsWith("npm_lifecycle_") ||
    key.startsWith("npm_package_")
  ) {
    delete nestedInstallEnv[key];
  }
}
// Target Node version (strip leading "v" — prebuild-install / node-gyp expect bare semver)
const NODE_TARGET_SEMVER = NODE_VERSION.replace(/^v/, "");
const targetEnv = {
  ...nestedInstallEnv,
  NODE_ENV: "production",
  PATH: `${hostNodeDir}${path.delimiter}${process.env.PATH}`,
  // 跨平台构建时，告诉 prebuild-install 下载目标平台 + 目标 Node 版本的预编译二进制。
  // 不设 npm_config_target 会让 prebuild-install 默认拿 host Node 的 ABI (NODE_MODULE_VERSION)，
  // 跨平台构建里就会出现 dist-server/{plat}/{arch}/node 是 v22.16.0 (ABI 127) 但
  // better-sqlite3 prebuild 是 host 的 v20.x (ABI 115)，安装运行时 dlopen 立即 ERR_DLOPEN_FAILED 崩。
  ...(isCrossBuild ? {
    npm_config_platform: platform,
    npm_config_arch: arch,
    npm_config_target: NODE_TARGET_SEMVER,
    npm_config_runtime: "node",
    npm_config_disturl: "https://nodejs.org/dist",
  } : {}),
};
function runWithTargetNode(cmd, opts = {}) {
  const extraEnv = opts.env || {};
  const childOpts = { ...opts };
  delete childOpts.env;
  execSync(`"${hostNodeBin}" ${cmd}`, {
    cwd: outDir,
    stdio: "inherit",
    env: { ...targetEnv, ...extraEnv },
    ...childOpts,
  });
}

// ── 2. Vite bundle ──
// 用系统 Node 跑 Vite（构建时工具，不涉及 native addon ABI）
// 产出到 dist-server-bundle/，然后复制到 outDir/bundle/
console.log("[build-server] running Vite bundle...");
const viteBundleDir = path.join(ROOT, "dist-server-bundle");
execSync(`"${hostNodeBin}" "${path.join(ROOT, "node_modules", "vite", "bin", "vite.js")}" build --config vite.config.server.ts`, {
  cwd: ROOT,
  stdio: "inherit",
});

// 复制 bundle 产出
const bundleOutDir = path.join(outDir, "bundle");
fs.cpSync(viteBundleDir, bundleOutDir, { recursive: true });
console.log("[build-server] Vite bundle copied to bundle/");

// ── 3. 复制运行时数据文件 ──
// 这些文件由 fromRoot() / fs.readFileSync() 在运行时读取，无法打进 bundle

// lib/ 下的数据文件（json, yaml, md）
const LIB_DATA_GLOBS = [
  "known-models.json",
  "default-models.json",
  "config.example.yaml",
  "identity.example.md",
  "ishiki.example.md",
  "pinned.example.md",
];
const libOutDir = path.join(outDir, "lib");
fs.mkdirSync(libOutDir, { recursive: true });
for (const file of LIB_DATA_GLOBS) {
  const src = path.join(ROOT, "lib", file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(libOutDir, file));
    console.log(`[build-server]   lib/${file}`);
  } else {
    console.warn(`[build-server] ⚠ lib/${file} not found, skipping`);
  }
}

// lib/ 下的模板目录（递归复制）
const LIB_TEMPLATE_DIRS = [
  "identity-templates",
  "ishiki-templates",
  "public-ishiki-templates",
  "content-filter-data",
  "yuan",
  "experts",
];
for (const dir of LIB_TEMPLATE_DIRS) {
  const src = path.join(ROOT, "lib", dir);
  if (fs.existsSync(src)) {
    fs.cpSync(src, path.join(libOutDir, dir), { recursive: true });
    console.log(`[build-server]   lib/${dir}/`);
  } else {
    console.warn(`[build-server] ⚠ lib/${dir}/ not found, skipping`);
  }
}

// Plugin runtime helpers. Some plugins are intentionally loaded from the
// unpacked server resources at runtime, so dynamic imports from plugins cannot
// rely on Vite-bundled modules only.
const LIB_RUNTIME_FILES = [
  {
    src: path.join("memory", "vector-interface.ts"),
    dest: path.join("memory", "vector-interface.js"),
    compile: true,
  },
];
for (const entry of LIB_RUNTIME_FILES) {
  const relSrc = typeof entry === "string" ? entry : entry.src;
  const relDest = typeof entry === "string" ? entry : entry.dest;
  const src = path.join(ROOT, "lib", relSrc);
  const dest = path.join(libOutDir, relDest);
  if (fs.existsSync(src)) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (typeof entry === "object" && entry.compile) {
      await esbuild({
        entryPoints: [src],
        outfile: dest,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node22",
        minify: false,
        sourcemap: false,
        logLevel: "silent",
      });
    } else {
      fs.copyFileSync(src, dest);
    }
    console.log(`[build-server]   lib/${relDest}`);
  } else {
    console.warn(`[build-server] ⚠ lib/${relSrc} not found, skipping`);
  }
}

// skills2set（运行时复制到用户数据目录）
const skillsSrc = path.join(ROOT, "skills2set");
if (fs.existsSync(skillsSrc)) {
  fs.cpSync(skillsSrc, path.join(outDir, "skills2set"), { recursive: true });
  console.log("[build-server]   skills2set/");
}

// i18n locales（server/i18n.js 通过 fromRoot("desktop","src","locales") 引用）
fs.mkdirSync(path.join(outDir, "server", "mobile"), { recursive: true });
fs.cpSync(path.join(ROOT, "server", "mobile", "public"), path.join(outDir, "server", "mobile", "public"), { recursive: true });
fs.mkdirSync(path.join(outDir, "lib", "mcp", "vendor"), { recursive: true });
fs.cpSync(path.join(ROOT, "lib", "mcp", "vendor", "kimi-datasource"), path.join(outDir, "lib", "mcp", "vendor", "kimi-datasource"), { recursive: true });
const localesSrc = path.join(ROOT, "desktop", "src", "locales");
fs.mkdirSync(path.join(outDir, "desktop", "src", "locales"), { recursive: true });
fs.cpSync(localesSrc, path.join(outDir, "desktop", "src", "locales"), { recursive: true });
console.log("[build-server]   desktop/src/locales/");

// 系统插件（内嵌到 app，运行时 fromRoot("plugins") 读取）
const pluginsSrc = path.join(ROOT, "plugins");
if (fs.existsSync(pluginsSrc)) {
  fs.cpSync(pluginsSrc, path.join(outDir, "plugins"), { recursive: true });
  console.log("[build-server]   plugins/");
}

// Local model bootstrap scripts. These are invoked by the packaged server after
// user authorization to install llama.cpp, download the default local GGUF, start the
// local OpenAI-compatible endpoint, and register the provider.
const SCRIPT_RUNTIME_FILES = [
  "local_qwen35_9b_setup.sh",
  "local_qwen35_9b_q4km_llamacpp_server.sh",
  "local_qwen35_9b_llamacpp_smoke.sh",
  "local_qwen35_9b_release_qa_smoke.sh",
  "local_qwen35_9b_register_provider.py",
  "local_qwen35_9b_client_bootstrap.py",
];
const scriptsOutDir = path.join(outDir, "scripts");
for (const file of SCRIPT_RUNTIME_FILES) {
  const src = path.join(ROOT, "scripts", file);
  if (fs.existsSync(src)) {
    fs.mkdirSync(scriptsOutDir, { recursive: true });
    const dest = path.join(scriptsOutDir, file);
    fs.copyFileSync(src, dest);
    if (!isWin && /\.(sh|py)$/.test(file)) fs.chmodSync(dest, 0o755);
    console.log(`[build-server]   scripts/${file}`);
  } else {
    console.warn(`[build-server] ⚠ scripts/${file} not found, skipping`);
  }
}

console.log("[build-server] resource files copied");

// ── 4. External dependencies ──
// 从 vite.config.server.ts 的 external 列表自动派生需要安装的包。
// 规则：external ∩ rootPkg.dependencies = 需要安装的包。
// 这消除了手动维护两个列表导致的遗漏（如 #242 ws 缺失）。
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"));

const { loadConfigFromFile } = await import("vite");
const loadedViteConfig = await loadConfigFromFile(
  { command: "build", mode: "production" },
  path.join(ROOT, "vite.config.server.ts"),
);
const viteConfig = loadedViteConfig?.config;
const viteExternals = viteConfig.build?.rollupOptions?.external;
if (!Array.isArray(viteExternals)) {
  throw new Error("[build-server] vite.config.server.ts external must be an array");
}

const builtinSet = new Set(builtinModules.flatMap(m => [m, `node:${m}`]));
const deps = rootPkg.dependencies || {};
const externalDeps = {};
const packagedPluginDeps = [
  // Bundled plugins are loaded dynamically from Resources/server/plugins at runtime,
  // so Vite's server external list cannot discover their direct imports.
  "@sinclair/typebox",
];

for (const ext of viteExternals) {
  if (typeof ext === "string") {
    if (builtinSet.has(ext)) continue;
    if (deps[ext]) externalDeps[ext] = deps[ext];
    // 不在 dependencies 中的 platform optional 包（如 fsevents）由 optional 链路提供。
  } else if (ext instanceof RegExp) {
    for (const dep of Object.keys(deps)) {
      if (ext.test(dep)) externalDeps[dep] = deps[dep];
    }
  }
}

for (const dep of packagedPluginDeps) {
  if (deps[dep]) externalDeps[dep] = deps[dep];
}

console.log(`[build-server] derived external deps: ${Object.keys(externalDeps).join(", ")}`);

const externalPkg = {
  name: "lynn-server",
  version: rootPkg.version,
  type: "module",
  dependencies: externalDeps,
  overrides: rootPkg.overrides || {},
};

fs.writeFileSync(
  path.join(outDir, "package.json"),
  JSON.stringify(externalPkg, null, 2) + "\n",
);

// 不复制 lockfile：精简后的 package.json 依赖数量少，
// 跟完整 lockfile 不匹配，npm ci 会报错。用 npm install 代替。

// ── 5. 用目标 Node 的 npm 安装 external deps ──
// 不加 --ignore-scripts：better-sqlite3 的 install 脚本需要跑
// （prebuild-install 下载正确 ABI 的预编译二进制）
// 用 npm install 而非 npm ci：lockfile 跟精简 package.json 不匹配
console.log("[build-server] installing external dependencies...");
if (dependencySource) {
  const source = dependencySource;
  const sourcePkg = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
  if (JSON.stringify(sourcePkg.overrides || {}) !== JSON.stringify(externalPkg.overrides)) {
    throw new Error("[build-server] reused dependency security overrides do not match this build; rebuild dependencies first");
  }
  const canonicalDeps = value => JSON.stringify(Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b)));
  if (canonicalDeps(sourcePkg.dependencies) !== canonicalDeps(externalDeps)) throw new Error("[build-server] Cached dependency declarations do not match this build");
  fs.cpSync(path.join(source, "node_modules"), path.join(outDir, "node_modules"), { recursive: true });
  const sourceLock = path.join(source, "package-lock.json");
  if (fs.existsSync(sourceLock)) {
    const lock = JSON.parse(fs.readFileSync(sourceLock, "utf8"));
    lock.version = rootPkg.version;
    if (lock.packages?.[""]) lock.packages[""].version = rootPkg.version;
    fs.writeFileSync(path.join(outDir, "package-lock.json"), JSON.stringify(lock, null, 2) + "\n");
  }
  console.log(`[build-server] reused existing ${osDirName}-${arch} dependencies with matching declarations`);
} else if (process.env.LYNN_BUILD_OFFLINE === "1") {
  throw new Error("[build-server] Offline build requires LYNN_BUILD_DEPS_ROOT");
} else try {
  runWithTargetNode(`"${cachedNpmCli}" install --omit=dev`);
} catch (err) {
  const fallbackRegistry = process.env.LYNN_BUILD_NPM_REGISTRY || "https://registry.npmjs.org";
  console.warn(`[build-server] npm install failed (${err?.status ?? "unknown"}), retrying with ${fallbackRegistry}`);
  fs.rmSync(path.join(outDir, "node_modules"), { recursive: true, force: true });
  runWithTargetNode(`"${cachedNpmCli}" install --omit=dev`, {
    env: {
      npm_config_registry: fallbackRegistry,
      NPM_CONFIG_REGISTRY: fallbackRegistry,
    },
  });
}

// Audit the installed distribution dependencies, including offline cache reuse.
runWithTargetNode(`"${cachedNpmCli}" audit --audit-level=high --registry=https://registry.npmjs.org`);

// ── 5b. 验证所有 Vite external 在 node_modules 中可达 ──
// 遍历 string 类型的 external，检查 node_modules 中是否存在。
// RegExp external 不在此检查范围内，因为匹配的包通常通过派生逻辑
// 显式安装或作为 transitive dep 存在。
// platform-optional（fsevents）允许缺失，其余缺失说明 transitive 链断了。
const OPTIONAL_EXTERNALS = new Set(["fsevents"]);
const missing = [];
for (const ext of viteExternals) {
  if (typeof ext !== "string" || builtinSet.has(ext)) continue;
  if (!fs.existsSync(path.join(outDir, "node_modules", ext))) {
    if (OPTIONAL_EXTERNALS.has(ext)) continue;
    missing.push(ext);
  }
}
if (missing.length > 0) {
  console.error(`[build-server] ❌ Vite externals missing from node_modules: ${missing.join(", ")}`);
  console.error(`[build-server]   These packages are external in the bundle but not installed.`);
  console.error(`[build-server]   Fix: add them to root package.json dependencies, or check transitive dep chains.`);
  process.exit(1);
}

// ── 7. 清理 node_modules/.bin ──
// 符号链接指向构建机器的绝对路径，codesign 会报错
// server 运行时不需要这些 CLI 工具
function removeBinDirs(nmDir) {
  const topBin = path.join(nmDir, ".bin");
  if (fs.existsSync(topBin)) fs.rmSync(topBin, { recursive: true });
  // 嵌套的 node_modules/.bin
  for (const entry of fs.readdirSync(nmDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const nested = path.join(nmDir, entry.name, "node_modules", ".bin");
    if (fs.existsSync(nested)) fs.rmSync(nested, { recursive: true });
  }
}
removeBinDirs(path.join(outDir, "node_modules"));

console.log("[build-server] dependencies installed");

// ── 8. @vercel/nft 追踪：只保留运行时实际需要的文件 ──
// 从 bundle 入口出发，静态分析所有 import/require 链，
// 删除 node_modules 里没被追踪到的文件（.d.ts、.map、多余平台二进制等）
console.log("[build-server] running nft trace...");

// nft 是 ESM，用动态 import
const { nodeFileTrace } = await import("@vercel/nft");
let fileList;
try {
  ({ fileList } = await nodeFileTrace(
    [path.join(outDir, "bundle", "index.js")],
    { base: outDir, conditions: ["node", "import"] },
  ));
} catch (e) {
  // Windows CI 上 nft 可能因用户目录不存在而报错，跳过裁剪
  console.warn(`[build-server] nft trace failed (${e.message}), skipping prune`);
  fileList = null;
}

const nmDir = path.join(outDir, "node_modules");

function resolveInstalledPackageJson(specifier, fromDir = outDir) {
  let currentDir = fromDir;

  while (currentDir.startsWith(outDir)) {
    const candidate = path.join(currentDir, "node_modules", specifier, "package.json");
    if (fs.existsSync(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }

  const topLevelCandidate = path.join(nmDir, specifier, "package.json");
  return fs.existsSync(topLevelCandidate) ? topLevelCandidate : null;
}

function collectProtectedPackageDirs(entryPackages) {
  const protectedDirs = new Set();
  const queue = entryPackages.map(name => ({ name, fromDir: outDir }));

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current?.name) continue;

    const pkgJsonPath = resolveInstalledPackageJson(current.name, current.fromDir);
    if (!pkgJsonPath) continue;

    const pkgDir = path.dirname(pkgJsonPath);
    if (protectedDirs.has(pkgDir)) continue;
    protectedDirs.add(pkgDir);

    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    } catch {
      continue;
    }

    const nextDeps = new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ]);

    for (const peerDep of Object.keys(pkg.peerDependencies || {})) {
      if (resolveInstalledPackageJson(peerDep, pkgDir)) nextDeps.add(peerDep);
    }

    for (const depName of nextDeps) {
      queue.push({ name: depName, fromDir: pkgDir });
    }
  }

  return protectedDirs;
}

async function verifyRuntimeImports(entries) {
  for (const entry of entries) {
    const pkgJsonPath = resolveInstalledPackageJson(entry.packageName);
    if (!pkgJsonPath) {
      throw new Error(`[build-server] runtime resolve failed for ${entry.packageName}: package.json not found`);
    }

    const resolvedPath = path.join(path.dirname(pkgJsonPath), entry.relativePath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`[build-server] runtime resolve failed for ${entry.packageName}: missing ${entry.relativePath}`);
    }

    try {
      await import(pathToFileURL(resolvedPath).href);
    } catch (error) {
      throw new Error(`[build-server] runtime import failed for ${entry.packageName}/${entry.relativePath}: ${error.message}`);
    }
  }
}

if (fileList) {
// 把追踪结果转成绝对路径 Set
const tracedFiles = new Set();
for (const f of fileList) {
  tracedFiles.add(path.resolve(outDir, f));
}

// Vite externals 及其依赖子树是运行时必须的包，nft 对跨包 ESM 依赖
//（尤其 transitive deps）不一定能完整追踪，整棵依赖树都需要跳过裁剪。
const protectedDirs = collectProtectedPackageDirs(Object.keys(externalDeps));

if (protectedDirs.size > 0) {
  const names = [...protectedDirs].map(d => path.relative(nmDir, d)).sort();
  console.log(`[build-server] nft: protecting ${protectedDirs.size} external package dirs from pruning: ${names.join(", ")}`);
}

// 遍历 node_modules，删除未追踪的文件（跳过受保护的包）
let removedFiles = 0;
let removedSize = 0;

function pruneDir(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (protectedDirs.has(path.resolve(full))) continue;
      pruneDir(full);
      // 删完子文件后如果目录空了，也删掉
      try {
        const remaining = fs.readdirSync(full);
        if (remaining.length === 0) fs.rmdirSync(full);
      } catch {}
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      if (!tracedFiles.has(full)) {
        const size = entry.isFile() ? (fs.statSync(full).size || 0) : 0;
        fs.unlinkSync(full);
        removedFiles++;
        removedSize += size;
      }
    }
  }
}

pruneDir(nmDir);

const keptFiles = fileList.size;
const MB = (n) => (n / 1024 / 1024).toFixed(0);
console.log(`[build-server] nft: kept ${keptFiles} files, removed ${removedFiles} files (${MB(removedSize)}MB)`);
} // end if (fileList)

if (isCrossBuild) {
  console.log("[build-server] cross-build: skipping runtime import verification");
} else {
  console.log("[build-server] runtime import smoke test passed");
}

// ── 8b. 处理 koffi ──
// koffi 只在 Windows 终端增强里使用，macOS/Linux 路径不会触发 require。
// 它的原生 .node 在当前证书链路下无法稳定做 Developer ID 重签，
// 因此非 Windows 构建直接移除整个包；Windows 仍只保留当前平台二进制。
const koffiPkgDir = path.join(nmDir, "koffi");
if (platform !== "win32") {
  if (fs.existsSync(koffiPkgDir)) {
    fs.rmSync(koffiPkgDir, { recursive: true, force: true });
    console.log(`[build-server] koffi: removed entire package for ${platform}`);
  }
} else {
  const koffiBuilds = path.join(koffiPkgDir, "build", "koffi");
  if (fs.existsSync(koffiBuilds)) {
    const target = `${platform}_${arch}`;
    let koffiRemoved = 0;
    for (const entry of fs.readdirSync(koffiBuilds)) {
      if (entry !== target) {
        fs.rmSync(path.join(koffiBuilds, entry), { recursive: true, force: true });
        koffiRemoved++;
      }
    }
    if (koffiRemoved > 0) {
      console.log(`[build-server] koffi: kept ${target}, removed ${koffiRemoved} other platform binaries`);
    }
  }
}

// ── 9. 更新 package.json ──
// npm ci 之后 package.json 仍在，确保它包含 version 字段
// fromRoot("package.json") 在运行时读取版本号
// 保留 dependencies 字段（node_modules 解析需要）
const installedPkg = JSON.parse(fs.readFileSync(path.join(outDir, "package.json"), "utf-8"));
installedPkg.version = rootPkg.version;
fs.writeFileSync(
  path.join(outDir, "package.json"),
  JSON.stringify(installedPkg, null, 2) + "\n",
);

// ── 10. Wrapper 脚本 ──
if (isWin) {
  fs.writeFileSync(
    path.join(outDir, "lynn-server.cmd"),
    '@echo off\r\nset "LYNN_ROOT=%~dp0"\r\n"%~dp0lynn-server.exe" "%~dp0bundle\\index.js" %*\r\n',
  );
} else {
  const wrapper = path.join(outDir, "lynn-server");
  fs.writeFileSync(wrapper, [
    "#!/bin/sh",
    'DIR="$(cd "$(dirname "$0")" && pwd)"',
    'export LYNN_ROOT="$DIR"',
    'exec "$DIR/node" "$DIR/bundle/index.js" "$@"',
    "",
  ].join("\n"));
  fs.chmodSync(wrapper, 0o755);
}
console.log("[build-server] wrapper created");

console.log("[build-server] Done!");
