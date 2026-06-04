function createCrashLogWriter({
  fs,
  path,
  lynnHome,
  dirname,
  resourcesPath,
  getLogs,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  versions = process.versions,
}) {
  return function writeCrashLog(errorMessage) {
    const logs = (getLogs?.() || []).join("");
    const timestamp = new Date().toISOString();

    let diagnostics = "";
    if (!logs) {
      const isPackaged = resourcesPath && fs.existsSync(path.join(resourcesPath, "server"));
      const serverDir = isPackaged
        ? path.join(resourcesPath, "server")
        : path.join(dirname, "..", "server");
      const sqlitePath = path.join(
        serverDir,
        "node_modules",
        "better-sqlite3",
        "build",
        "Release",
        "better_sqlite3.node",
      );
      const bundlePath = path.join(serverDir, "bundle", "index.js");

      const items = [
        "",
        "--- Diagnostics ---",
        `LYNN_HOME: ${lynnHome}`,
        `Server dir: ${serverDir}`,
        `Packaged: ${Boolean(isPackaged)}`,
        `bundle/index.js exists: ${fs.existsSync(bundlePath)}`,
        `better_sqlite3.node exists: ${fs.existsSync(sqlitePath)}`,
        `ELECTRON_RUN_AS_NODE: ${env.ELECTRON_RUN_AS_NODE || "unset"}`,
        `Node ABI: ${versions.modules || "unknown"}`,
      ];

      if (platform === "win32" && isPackaged) {
        const exePath = path.join(serverDir, "lynn-server.exe");
        const cmdPath = path.join(serverDir, "lynn-server.cmd");
        const gitRoot = path.join(resourcesPath, "git");
        items.push(`lynn-server.exe exists: ${fs.existsSync(exePath)}`);
        items.push(`lynn-server.cmd exists (manual debug): ${fs.existsSync(cmdPath)}`);
        items.push(`MinGit dir exists: ${fs.existsSync(gitRoot)}`);
        items.push("");
        items.push(`Manual debug: open cmd.exe, cd to "${serverDir}", run lynn-server.cmd`);
      }

      diagnostics = items.join("\n");
    }

    const content = [
      "=== Lynn Crash Log ===",
      `Time: ${timestamp}`,
      `Error: ${errorMessage}`,
      `Platform: ${platform} ${arch}`,
      `Electron: ${versions.electron || "unknown"}`,
      `Node: ${versions.node || "unknown"}`,
      "",
      "--- Server Output ---",
      logs || "(no output captured)",
      diagnostics,
      "",
    ].join("\n");

    try {
      const crashLogPath = path.join(lynnHome, "crash.log");
      fs.mkdirSync(lynnHome, { recursive: true });
      fs.writeFileSync(crashLogPath, content, "utf-8");
    } catch (err) {
      console.error("[desktop] 写入 crash.log 失败:", err.message);
    }

    return content;
  };
}

module.exports = { createCrashLogWriter };
