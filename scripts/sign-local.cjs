/**
 * sign-local.cjs — 本地安装后的 ad-hoc 重签
 *
 * 策略：先用 --remove-signature 剥掉 electron-builder 的 Developer ID 签名，
 * 再统一用 ad-hoc 重签，确保所有 Mach-O 的 Team ID 完全一致。
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const APP = process.env.LYNN_SIGN_APP || "/Applications/Lynn.app";
const ENT = path.join(__dirname, "..", "desktop", "entitlements.mac.plist");
const IDENTITY = process.env.CODESIGN_IDENTITY || "-";
const TIMESTAMP = IDENTITY === "-" ? "" : "--timestamp=none";

function strip(target) {
  try {
    execSync(`codesign --remove-signature "${target}"`, { stdio: "pipe" });
  } catch (_) {
    // 有些文件可能没有签名，忽略
  }
}

function sign(target, opts = "") {
  execSync(`codesign --sign "${IDENTITY}" --force ${TIMESTAMP} ${opts} "${target}"`, { stdio: "inherit" });
}

if (!fs.existsSync(APP)) {
  console.error(`App not found: ${APP}`);
  process.exit(1);
}

console.log(`[sign-local] app=${APP}`);
console.log(`[sign-local] identity=${IDENTITY}`);

// ============================================================
// 收集所有需要签名的 Mach-O 文件
// ============================================================
const allTargets = [];

// 用 `find` + `file` 命令找到所有 Mach-O 二进制，最可靠
try {
  const findOutput = execSync(
    `find "${APP}" -type f -exec sh -c 'file -b "$1" | grep -q "Mach-O" && echo "$1"' _ {} \\;`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
  for (const line of findOutput.trim().split("\n")) {
    if (line) allTargets.push(line);
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

// 额外检查：确保没有残留的旧 Team ID
try {
  const checkOutput = execSync(
    `find "${APP}" -type f -exec sh -c 'file -b "$1" | grep -q "Mach-O" && team=$(codesign -dvvv "$1" 2>&1 | grep TeamIdentifier) && echo "$1 → $team"' _ {} \\;`,
    { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
  );
  const mismatched = checkOutput.split("\n").filter(l => l.includes("KYB8UN3JP3"));
  if (mismatched.length > 0) {
    console.error("WARNING: Some binaries still have old Team ID:");
    mismatched.forEach(l => console.error("  " + l));
  }
} catch (_) {}

console.log("✓ Signed and verified");
