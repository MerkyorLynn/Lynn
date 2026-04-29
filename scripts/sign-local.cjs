/**
 * sign-local.cjs — 本地安装后的 ad-hoc 重签
 *
 * 策略：先用 --remove-signature 剥掉 electron-builder 的 Developer ID 签名，
 * 再统一用 ad-hoc 重签，确保所有 Mach-O 的 Team ID 完全一致。
 */
const { execFileSync, execSync, spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const APP = process.env.LYNN_SIGN_APP || "/Applications/Lynn.app";
const ENT = path.join(__dirname, "..", "desktop", "entitlements.mac.plist");
const DEFAULT_KEYCHAIN = path.join(process.env.HOME || "", "Library", "Keychains", "lynn-build.keychain-db");
const CODESIGN_KEYCHAIN = process.env.CODESIGN_KEYCHAIN || (fs.existsSync(DEFAULT_KEYCHAIN) ? DEFAULT_KEYCHAIN : "");
// 默认走 Developer ID 而不是 ad-hoc(`-`),避免 cdhash 变化后 macOS TCC 把
// Lynn.app 当成"新 app",导致用户每次 install:local 都要重新授权麦克风/相机/文件等。
// 找不到 Developer ID 证书时(纯 CI/无 keychain)再 fallback 到 ad-hoc。
function detectDeveloperId() {
  try {
    const keychainArg = CODESIGN_KEYCHAIN ? ` "${CODESIGN_KEYCHAIN}"` : "";
    const out = execSync(`security find-identity -v -p codesigning${keychainArg} 2>/dev/null | grep -E "Developer ID Application" | head -1`, { encoding: "utf8" });
    const m = out.match(/"(Developer ID Application: [^"]+)"/);
    return m ? m[1] : null;
  } catch (_) {
    return null;
  }
}
const DEFAULT_IDENTITY = detectDeveloperId() || "-";
const IDENTITY = process.env.CODESIGN_IDENTITY || DEFAULT_IDENTITY;
const TIMESTAMP = IDENTITY === "-" ? "" : "--timestamp";
const KEYCHAIN_FLAG = CODESIGN_KEYCHAIN && IDENTITY !== "-" ? `--keychain "${CODESIGN_KEYCHAIN}"` : "";
const RUNTIME_FLAG = IDENTITY === "-" ? "" : "--options runtime";

function strip(target) {
  try {
    execSync(`codesign --remove-signature "${target}"`, { stdio: "pipe" });
  } catch (_) {
    // 有些文件可能没有签名，忽略
  }
}

function sign(target, opts = "") {
  execSync(`codesign ${KEYCHAIN_FLAG} --sign "${IDENTITY}" --force ${TIMESTAMP} ${RUNTIME_FLAG} ${opts} "${target}"`, { stdio: "inherit" });
}

function walkFiles(root) {
  const files = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (err) {
      if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) continue;
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (entry.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}

function isMachO(target) {
  try {
    const output = execFileSync("file", ["-b", target], { encoding: "utf8" });
    return output.includes("Mach-O");
  } catch (err) {
    if (err && err.code === "ENOENT") return false;
    throw err;
  }
}

if (!fs.existsSync(APP)) {
  console.error(`App not found: ${APP}`);
  process.exit(1);
}

console.log(`[sign-local] app=${APP}`);
console.log(`[sign-local] identity=${IDENTITY}`);
if (CODESIGN_KEYCHAIN) {
  console.log(`[sign-local] keychain=${CODESIGN_KEYCHAIN}`);
  try {
    execFileSync("security", ["unlock-keychain", "-p", "", CODESIGN_KEYCHAIN], { stdio: "ignore" });
  } catch (err) {
    console.warn(`[sign-local] warning: failed to unlock keychain ${CODESIGN_KEYCHAIN}: ${err.message}`);
  }
}

try {
  execFileSync("xattr", ["-cr", APP], { stdio: "inherit" });
} catch (err) {
  console.warn(`[sign-local] warning: failed to clear extended attributes: ${err.message}`);
}

// ============================================================
// 收集所有需要签名的 Mach-O 文件
// ============================================================
const allTargets = [];

// 用 Node 递归遍历收集普通文件，再用 `file` 判断 Mach-O，避免 `find` 在 .app 内部偶发 fts_read 失败
try {
  for (const target of walkFiles(APP)) {
    if (isMachO(target)) {
      allTargets.push(target);
    }
  }
} catch (e) {
  console.error("Failed to find Mach-O files:", e.message);
  process.exit(1);
}

console.log(`[sign-local] Found ${allTargets.length} Mach-O binaries`);

// ============================================================
// Phase 1: 剥掉所有现有签名
// ============================================================
console.log("[sign-local] Phase 1: Stripping all existing signatures...");
for (const t of allTargets) {
  strip(t);
}
// 也剥掉 bundle 级签名
const frameworks = path.join(APP, "Contents", "Frameworks");
if (fs.existsSync(frameworks)) {
  for (const entry of fs.readdirSync(frameworks)) {
    const full = path.join(frameworks, entry);
    if (entry.endsWith(".framework") || entry.endsWith(".app")) {
      strip(full);
    }
  }
}
strip(APP);

// ============================================================
// Phase 2: 从内到外重新签名
// ============================================================
console.log("[sign-local] Phase 2: Re-signing all binaries...");

// 2a. 签所有非 bundle 的独立 Mach-O（dylib, .node, 独立二进制）
//     排除 .app/Contents/MacOS/* 和 .framework/Versions/A/主二进制（这些在后面签）
const bundleBins = new Set();

// 收集 framework 主二进制
if (fs.existsSync(frameworks)) {
  for (const entry of fs.readdirSync(frameworks)) {
    if (entry.endsWith(".framework")) {
      const binName = entry.replace(".framework", "");
      const mainBin = path.join(frameworks, entry, "Versions", "A", binName);
      if (fs.existsSync(mainBin)) bundleBins.add(mainBin);
    }
  }
}

// 收集 helper app 主二进制
if (fs.existsSync(frameworks)) {
  for (const entry of fs.readdirSync(frameworks)) {
    if (entry.endsWith(".app")) {
      const macosDir = path.join(frameworks, entry, "Contents", "MacOS");
      if (fs.existsSync(macosDir)) {
        for (const bin of fs.readdirSync(macosDir)) {
          bundleBins.add(path.join(macosDir, bin));
        }
      }
    }
  }
}

// 主 app 二进制
const mainMacosDir = path.join(APP, "Contents", "MacOS");
if (fs.existsSync(mainMacosDir)) {
  for (const bin of fs.readdirSync(mainMacosDir)) {
    bundleBins.add(path.join(mainMacosDir, bin));
  }
}

// 签独立二进制（不在 bundle 主二进制列表中的）
for (const t of allTargets) {
  if (!bundleBins.has(t)) {
    sign(t);
  }
}

// 2b. 签 framework 主二进制，然后签 framework bundle
if (fs.existsSync(frameworks)) {
  for (const entry of fs.readdirSync(frameworks)) {
    if (entry.endsWith(".framework")) {
      const full = path.join(frameworks, entry);
      const binName = entry.replace(".framework", "");
      const mainBin = path.join(full, "Versions", "A", binName);
      if (fs.existsSync(mainBin)) sign(mainBin);
      sign(full);
    }
  }
}

// 2c. 签 helper app 主二进制，然后签 helper app bundle
if (fs.existsSync(frameworks)) {
  for (const entry of fs.readdirSync(frameworks)) {
    if (entry.endsWith(".app")) {
      const full = path.join(frameworks, entry);
      const macosDir = path.join(full, "Contents", "MacOS");
      if (fs.existsSync(macosDir)) {
        for (const bin of fs.readdirSync(macosDir)) {
          sign(path.join(macosDir, bin), `--entitlements "${ENT}"`);
        }
      }
      sign(full, `--entitlements "${ENT}"`);
    }
  }
}

// 2d. 签主 app
if (fs.existsSync(mainMacosDir)) {
  for (const bin of fs.readdirSync(mainMacosDir)) {
    sign(path.join(mainMacosDir, bin), `--entitlements "${ENT}"`);
  }
}
sign(APP, `--entitlements "${ENT}"`);

// ============================================================
// Phase 3: 验证
// ============================================================
console.log("[sign-local] Phase 3: Verifying...");
execSync(`codesign --verify --deep --strict "${APP}"`, { stdio: "inherit" });

// 额外检查：Developer ID 签名时确保可执行代码都归属目标 Team ID。
try {
  const mismatched = [];
  for (const target of allTargets) {
    const result = spawnSync("codesign", ["-dvvv", target], { encoding: "utf8" });
    const detail = `${result.stdout || ""}\n${result.stderr || ""}`;
    if (IDENTITY !== "-" && !detail.includes("TeamIdentifier=KYB8UN3JP3")) {
      mismatched.push(`${target} → missing TeamIdentifier=KYB8UN3JP3`);
    }
  }
  if (mismatched.length > 0) {
    console.error("WARNING: Some binaries are not signed with expected Team ID:");
    mismatched.forEach(l => console.error("  " + l));
  }
} catch (_) {}

console.log("✓ Signed and verified");
