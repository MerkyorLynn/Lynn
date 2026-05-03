/**
 * fix-modules.cjs — electron-builder afterPack 钩子
 *
 * electron-builder 的依赖分析有时会漏掉新的子依赖。
 * 这个脚本在打包后检查 dist node_modules，把缺失的
 * 生产依赖从本地 node_modules 拷贝过去。
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

exports.default = async function (context) {
  const platformName = context.packager.platform.name;
  const arch = context.arch === 1 ? "x64" : context.arch === 3 ? "arm64" : "x64";
  const appDir = platformName === "mac"
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + ".app",
        "Contents", "Resources", "app")
    : path.join(context.appOutDir, "resources", "app");
  const distModules = path.join(appDir, "node_modules");
  const localModules = path.resolve(__dirname, "..", "node_modules");

  // ── server native deps 补全 ──
  // electron-builder 的 extraResources 会过滤 node_modules，
  // 这里手动把 build-server 产出的 node_modules 复制到 server 目录
  const resourcesDir = platformName === "mac"
    ? path.join(context.appOutDir, context.packager.appInfo.productFilename + ".app",
        "Contents", "Resources")
    : path.join(context.appOutDir, "resources");
  const serverDir = path.join(resourcesDir, "server");
  const osDirName = platformName === "mac" ? "mac" : platformName === "windows" ? "win" : "linux";
  const serverBuildModules = path.join(__dirname, "..", "dist-server", `${osDirName}-${arch}`, "node_modules");

  if (fs.existsSync(serverDir) && fs.existsSync(serverBuildModules)) {
    const serverNodeModules = path.join(serverDir, "node_modules");
    if (!fs.existsSync(serverNodeModules)) {
      fs.cpSync(serverBuildModules, serverNodeModules, { recursive: true });
      console.log(`[fix-modules] 补全 server native deps → ${serverNodeModules}`);
    }
  }

  // distModules 可能不存在（asar: true 时 app 被打成 app.asar）
  // 但 server/node_modules 仍需要清理，所以不能早退
  const hasDistModules = fs.existsSync(distModules);

  // 获取生产依赖树
  let prodDeps;
  try {
    const raw = execSync("npm ls --all --json --omit=dev", {
      cwd: path.resolve(__dirname, ".."),
      maxBuffer: 20 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    prodDeps = JSON.parse(raw);
  } catch (e) {
    // npm ls 在有 peer dep 警告时也会 exit 1，但 stdout 仍有数据
    try {
      prodDeps = JSON.parse(e.stdout?.toString() || "{}");
    } catch {
      console.log("[fix-modules] 无法解析依赖树，跳过");
      return;
    }
  }

  function collectDeps(obj, set = new Set()) {
    if (!obj || !obj.dependencies) return set;
    for (const [name, info] of Object.entries(obj.dependencies)) {
      set.add(name);
      collectDeps(info, set);
    }
    return set;
  }

  const allProd = collectDeps(prodDeps);
  let copied = 0;

  // 含 native binding 的包（需要平台匹配编译），补全时额外警告
  const NATIVE_PACKAGES = new Set(["bufferutil", "utf-8-validate"]);

  if (hasDistModules) {
    for (const dep of allProd) {
      const distPath = path.join(distModules, dep);
      const localPath = path.join(localModules, dep);
      if (!fs.existsSync(distPath) && fs.existsSync(localPath)) {
        if (NATIVE_PACKAGES.has(dep)) {
          console.warn(`[fix-modules] ⚠ 补全 native 包 "${dep}"（确保已针对当前平台编译）`);
        }
        fs.cpSync(localPath, distPath, { recursive: true });
        copied++;
      }
    }

    if (copied > 0) {
      console.log(`[fix-modules] 补全了 ${copied} 个缺失的生产依赖`);
    }
  }

  // 清理 node_modules 中指向 bundle 外部的 .bin 符号链接（codesign 会报错）
  let removedLinks = 0;
  function cleanBinLinks(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(full);
        // 绝对路径指向外部 → 删
        if (path.isAbsolute(target) && !target.startsWith(bundleRoot)) {
          fs.unlinkSync(full);
          removedLinks++;
          continue;
        }
        // 相对路径解析后指向 bundle 外 → 删
        try {
          const resolved = fs.realpathSync(full);
          if (!resolved.startsWith(bundleRoot)) {
            fs.unlinkSync(full);
            removedLinks++;
          }
        } catch {
          // 断链 → 删
          fs.unlinkSync(full);
          removedLinks++;
        }
      } else if (entry.isDirectory() && entry.name !== ".bin") {
        const binDir = path.join(full, "node_modules", ".bin");
        if (fs.existsSync(binDir)) cleanBinLinks(binDir);
      }
    }
  }

  function walk(dir, depth = 0) {
    if (depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === ".bin") {
        cleanBinLinks(full);
        continue;
      }
      if (entry.name === "node_modules") {
        walk(full, depth + 1);
        continue;
      }
      // Scope 目录（@cypress / @aws-sdk 等）当作容器，直接递归进去
      if (entry.name.startsWith("@")) {
        walk(full, depth + 1);
        continue;
      }
      // 普通 package 目录：找 node_modules 子目录
      const nm = path.join(full, "node_modules");
      if (fs.existsSync(nm)) walk(nm, depth + 1);
    }
  }

  // 扫两个根：renderer (Resources/app) + server (Resources/server)
  // bundleRoot 用 .app 根，确保任何指向外部路径的 symlink 都会被干掉
  let bundleRoot = appDir;
  if (platformName === "mac") {
    bundleRoot = path.join(context.appOutDir, context.packager.appInfo.productFilename + ".app");
  }

  if (hasDistModules) {
    const topBin1 = path.join(distModules, ".bin");
    if (fs.existsSync(topBin1)) cleanBinLinks(topBin1);
    walk(distModules);
  }

  const serverNM = path.join(serverDir, "node_modules");
  if (fs.existsSync(serverNM)) {
    const topBin2 = path.join(serverNM, ".bin");
    if (fs.existsSync(topBin2)) cleanBinLinks(topBin2);
    walk(serverNM);
  }

  if (removedLinks > 0) {
    console.log(`[fix-modules] 清理了 ${removedLinks} 个指向 bundle 外部的 .bin 符号链接`);
  }

  // ── platform-sweep cross-platform native modules(2026-05-04 hotpatch v0.77.5 #2)──
  // desktop/native-modules/aec 只有 lynn-aec-napi.darwin-arm64.node 一个 prebuild,
  // 但 electron-builder files glob "desktop/native-modules/aec/*.node" 把它打进所有平台,
  // Win 启动 dlopen Mach-O → ERR_DLOPEN_FAILED(用户实测 v0.77.5 仍崩)。
  //
  // Hotpatch #1 只 sweep 了 server bundle 的 @mariozechner/clipboard-*,这次扩展到 desktop。
  // 策略:napi-rs 标准命名 (*.{darwin|win32|linux}-{arm64|x64|...}.node),只保留当前 target 平台。
  const platformTag = platformName === "mac" ? "darwin"
                    : platformName === "windows" ? "win32"
                    : "linux";
  const NATIVE_TAG_RE = /\.(darwin|win32|linux)-(arm64|x64|x86|ia32|universal)\.node$/;
  const targetTag = `${platformTag}-${arch}`;

  function sweepNativeModules(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
    let swept = 0;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        swept += sweepNativeModules(full);
        continue;
      }
      if (!entry.name.endsWith(".node")) continue;
      const m = entry.name.match(NATIVE_TAG_RE);
      if (!m) continue;  // 不带平台 tag 的 .node(如 binding.node)跳过,不动
      // 接受当前平台 arch + universal 命名
      const fileTag = `${m[1]}-${m[2]}`;
      const isCurrent = fileTag === targetTag
        || fileTag === `${platformTag}-universal`
        || (platformTag === "darwin" && m[2] === "universal");
      if (!isCurrent) {
        try { fs.unlinkSync(full); swept++; } catch (e) { console.warn(`[fix-modules] sweep 失败 ${full}: ${e.message}`); }
      }
    }
    return swept;
  }

  // 扫两个候选根:resources/app.asar.unpacked/desktop/native-modules + resources/app/desktop/native-modules
  const sweepRoots = [
    path.join(resourcesDir, "app.asar.unpacked", "desktop", "native-modules"),
    path.join(appDir, "desktop", "native-modules"),
  ];
  let totalSwept = 0;
  for (const root of sweepRoots) {
    if (fs.existsSync(root)) {
      totalSwept += sweepNativeModules(root);
    }
  }
  if (totalSwept > 0) {
    console.log(`[fix-modules] platform-sweep: 删除 ${totalSwept} 个跨平台 .node 文件(目标=${targetTag})`);
  } else {
    console.log(`[fix-modules] platform-sweep: 无跨平台 .node 残留(目标=${targetTag})`);
  }
};
