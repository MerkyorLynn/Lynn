/**
 * extract-zip.js — 跨平台 zip 解压
 *
 * macOS/Linux 用系统 unzip，Windows 用 PowerShell Expand-Archive。
 */

import { execFileSync } from "child_process";

export function extractZip(zipPath, destDir) {
  if (process.platform === "win32") {
    execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-Command",
      `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
    ], { stdio: "ignore", windowsHide: true });
  } else {
    execFileSync("unzip", ["-o", "-q", zipPath, "-d", destDir]);
  }
}
