const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

function ipcOk(payload = {}) {
  return { ok: true, ...payload };
}

function ipcError(reason, payload = {}) {
  return { ok: false, reason: String(reason || "unknown-error"), ...payload };
}

function parseGgufModelPathPayload(payload, key = "modelPath") {
  const rawPath = typeof payload === "string" ? payload : payload?.[key];
  if (typeof rawPath !== "string" || !rawPath.trim()) return ipcError("missing-model-path");
  if (rawPath.includes("\0")) return ipcError("invalid-model-path");
  const modelPath = path.resolve(rawPath);
  if (path.extname(modelPath).toLowerCase() !== ".gguf") return ipcError("not-gguf");
  return { ok: true, modelPath };
}

function createFileIpcController(deps) {
  const {
    app,
    BrowserWindow,
    dialog,
    shell,
    nativeImage,
    wrapIpcHandler,
    wrapIpcOn,
    ipcMain,
    mt,
    lynnHome,
    getMainWindow,
    getCurrentAgentId,
    canReadPath,
    canWritePath,
    grantWebContentsAccess,
    resolveCanonicalPath,
    logger = console,
  } = deps;

// ── Skill 预览 → 主窗口 overlay ──
function _showSkillViewer(skillInfo) {
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("show-skill-viewer", skillInfo);
    mainWindow.show();
    mainWindow.focus();
  }
}

/** 递归扫描目录，返回文件树 */
function scanSkillDir(dir, rootDir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith("."))
    .sort((a, b) => {
      // 目录排前面，SKILL.md 排最前
      if (a.name === "SKILL.md") return -1;
      if (b.name === "SKILL.md") return 1;
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

  return entries.map(e => {
    const fullPath = path.join(dir, e.name);
    if (e.isDirectory()) {
      return { name: e.name, path: fullPath, isDir: true, children: scanSkillDir(fullPath, rootDir) };
    }
    return { name: e.name, path: fullPath, isDir: false };
  });
}


// 获取头像本地路径（splash 用，不依赖 server）
wrapIpcHandler("get-avatar-path", (_event, role) => {
  if (role !== "agent" && role !== "user") return null;
  // First check the user-uploaded avatar slot (P2-3 onboarding upload).
  try {
    const uploadedDir = path.join(lynnHome, "avatars");
    for (const ext of ["png", "jpg", "jpeg", "webp"]) {
      const p = path.join(uploadedDir, `${role}.${ext}`);
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  const agentId = getCurrentAgentId();
  // agent 头像在 agents/{id}/avatars/，user 头像在 user/avatars/
  const baseDir = role === "user"
    ? path.join(lynnHome, "user")
    : agentId ? path.join(lynnHome, "agents", agentId) : null;
  if (!baseDir) return null;
  const avatarDir = path.join(baseDir, "avatars");
  for (const ext of ["png", "jpg", "jpeg", "webp"]) {
    const p = path.join(avatarDir, `${role}.${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
});

// P2-3: Upload a user-supplied avatar image into ~/.lynn/avatars/ keyed by role.
// Returns { ok, path } on success. Used by onboarding NameStep.
wrapIpcHandler("avatar:upload", async (event, role) => {
  try {
    if (role !== "agent" && role !== "user") return { ok: false, reason: "bad-role" };
    const win = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow();
    const { canceled, filePaths } = await dialog.showOpenDialog(win || undefined, {
      title: role === "user" ? "Select your avatar" : "Select agent avatar",
      properties: ["openFile"],
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (canceled || !filePaths?.length) return { ok: false, reason: "cancelled" };
    const src = filePaths[0];
    const stat = fs.statSync(src);
    // Reject anything larger than 8 MB so the renderer doesn't strain.
    if (stat.size > 8 * 1024 * 1024) return { ok: false, reason: "too-large" };
    const ext = (path.extname(src) || ".png").toLowerCase();
    const safeExt = [".png", ".jpg", ".jpeg", ".webp"].includes(ext) ? ext : ".png";
    const targetDir = path.join(lynnHome, "avatars");
    fs.mkdirSync(targetDir, { recursive: true });
    const targetPath = path.join(targetDir, `${role}${safeExt}`);
    // Remove any prior avatar (different ext) so lookup is unambiguous.
    for (const e of [".png", ".jpg", ".jpeg", ".webp"]) {
      const stale = path.join(targetDir, `${role}${e}`);
      if (stale !== targetPath) { try { fs.rmSync(stale, { force: true }); } catch {} }
    }
    fs.copyFileSync(src, targetPath);
    return { ok: true, path: targetPath };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
});

// 读取 config.yaml 基本信息（splash 用，不依赖 server）
wrapIpcHandler("get-splash-info", () => {
  try {
    const agentId = getCurrentAgentId();
    if (!agentId) return { agentName: null, locale: "zh-CN", yuan: "lynn" };
    const configPath = path.join(lynnHome, "agents", agentId, "config.yaml");
    const text = fs.readFileSync(configPath, "utf-8");
    // 简易提取：agent:\n  name: xxx / yuan: xxx 和顶层 locale: xxx
    const agentMatch = text.match(/^agent:\s*\n\s+name:\s*([^#\n]+)/m);
    const localeMatch = text.match(/^locale:\s*(.+)/m);
    const yuanMatch = text.match(/^\s+yuan:\s*([^#\n]+)/m);
    return {
      agentName: agentMatch?.[1]?.trim() || null,
      locale: localeMatch?.[1]?.trim() || null,
      yuan: yuanMatch?.[1]?.trim() || "lynn",
    };
  } catch {
    return { agentName: null, locale: "zh-CN", yuan: "lynn" };
  }
});

// 选择文件夹（系统原生对话框）
wrapIpcHandler("select-folder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || getMainWindow();
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openDirectory"],
    title: mt("dialog.selectFolder", null, "Select Working Folder"),
  });
  if (result.canceled || !result.filePaths.length) return null;
  const selectedPath = result.filePaths[0];
  grantWebContentsAccess(event.sender, selectedPath, "readwrite");
  return selectedPath;
});

wrapIpcHandler("get-onboarding-defaults", () => {
  const desktopRoot = path.join(os.homedir(), "Desktop");
  const workspacePath = path.join(desktopRoot, "Lynn");
  const installRoot = path.resolve(process.cwd());
  try { fs.mkdirSync(workspacePath, { recursive: true }); } catch {}
  return {
    workspacePath,
    desktopRoot,
    installRoot,
    trustedRoots: Array.from(new Set([desktopRoot, workspacePath].filter(Boolean))),
  };
});

// 选择技能文件/文件夹（支持 .zip / .skill / 文件夹）
wrapIpcHandler("select-skill", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || getMainWindow();
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile", "openDirectory"],
    title: mt("dialog.selectSkill", null, "Select Skill"),
    filters: [
      { name: "Skill", extensions: ["zip", "skill"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const selectedPath = result.filePaths[0];
  grantWebContentsAccess(event.sender, selectedPath, "read");
  return selectedPath;
});

wrapIpcHandler("select-gguf-model", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender) || getMainWindow();
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile"],
    title: "选择 GGUF 模型",
    filters: [
      { name: "GGUF Model", extensions: ["gguf"] },
      { name: "All Files", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return null;
  const parsedPath = parseGgufModelPathPayload(result.filePaths[0]);
  if (!parsedPath.ok || !fs.existsSync(parsedPath.modelPath)) return null;
  grantWebContentsAccess(event.sender, parsedPath.modelPath, "read");
  return parsedPath.modelPath;
});

// ── Skill 预览窗口 IPC ──
wrapIpcHandler("open-skill-viewer", (event, data) => {
  if (!data) return;

  if (data.skillPath) {
    const skillPathAccess = canReadPath(event.sender, data.skillPath);
    if (!skillPathAccess.allowed) return;
  }

  if (data.baseDir) {
    const baseDirAccess = canReadPath(event.sender, data.baseDir);
    if (!baseDirAccess.allowed) return;
  }

  // .skill / .zip 文件 → 优先查找已安装目录，否则解压临时目录
  if (data.skillPath && path.isAbsolute(data.skillPath)) {
    const fileExt = path.extname(data.skillPath).toLowerCase();
    if (fileExt === ".skill" || fileExt === ".zip") {
      const baseName = path.basename(data.skillPath, fileExt);

      // 先检查同名 skill 是否已安装在 skills 目录
      const installedDir = path.join(lynnHome, "skills", baseName);
      if (fs.existsSync(path.join(installedDir, "SKILL.md"))) {
        grantWebContentsAccess(getMainWindow(), installedDir, "read");
        _showSkillViewer({ name: baseName, baseDir: installedDir, installed: false });
        return;
      }

      // 否则解压 .skill 文件
      if (!fs.existsSync(data.skillPath)) {
        console.warn("[skill-viewer] .skill file not found:", data.skillPath);
        return;
      }
      try {
        const { execFileSync } = require("child_process");
        const tmpDir = path.join(app.getPath("temp"), "hana-skill-preview-" + Date.now());
        fs.mkdirSync(tmpDir, { recursive: true });
        if (process.platform === "win32") {
          execFileSync("powershell.exe", [
            "-NoProfile", "-NonInteractive", "-Command",
            `Expand-Archive -Path '${data.skillPath.replace(/'/g, "''")}' -DestinationPath '${tmpDir.replace(/'/g, "''")}' -Force`,
          ], { stdio: "ignore", windowsHide: true });
        } else {
          execFileSync("unzip", ["-o", "-q", data.skillPath, "-d", tmpDir]);
        }

        let skillDir = null;
        if (fs.existsSync(path.join(tmpDir, "SKILL.md"))) {
          skillDir = tmpDir;
        } else {
          const sub = fs.readdirSync(tmpDir, { withFileTypes: true })
            .filter(e => e.isDirectory() && !e.name.startsWith("."));
          const found = sub.find(e => fs.existsSync(path.join(tmpDir, e.name, "SKILL.md")));
          if (found) skillDir = path.join(tmpDir, found.name);
        }
        if (!skillDir) return;

        const content = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf-8");
        const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
        const nameMatch = fmMatch?.[1]?.match(/^name:\s*(.+)$/m);
        const name = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, "") : baseName;

        grantWebContentsAccess(getMainWindow(), skillDir, "read");
        _showSkillViewer({ name, baseDir: skillDir, installed: false });
      } catch (err) {
        console.error("[skill-viewer] Failed to extract .skill file:", err.message);
      }
      return;
    }
  }

  if (!data.baseDir || !path.isAbsolute(data.baseDir)) return;
  grantWebContentsAccess(getMainWindow(), data.baseDir, "read");
  _showSkillViewer(data);
});

wrapIpcHandler("skill-viewer-list-files", (event, baseDir) => {
  const access = canReadPath(event.sender, baseDir);
  if (!baseDir || !path.isAbsolute(baseDir) || !access.allowed) return [];
  try {
    if (!fs.statSync(access.canonical).isDirectory()) return [];
    return scanSkillDir(access.canonical, access.canonical);
  } catch {
    return [];
  }
});

wrapIpcHandler("skill-viewer-read-file", (event, filePath) => {
  const access = canReadPath(event.sender, filePath);
  if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return null;
  try {
    const stat = fs.statSync(access.canonical);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return null;
    return fs.readFileSync(access.canonical, "utf-8");
  } catch {
    return null;
  }
});

// close-skill-viewer: overlay 模式下由渲染进程 setState 关闭，保留 handler 避免 preload 报错
wrapIpcHandler("close-skill-viewer", () => {});

// 在系统文件管理器中打开文件夹（限制为目录且为绝对路径）
wrapIpcHandler("open-folder", (event, folderPath) => {
  const access = canReadPath(event.sender, folderPath);
  if (!folderPath || !path.isAbsolute(folderPath) || !access.allowed) return;
  try {
    if (!fs.statSync(access.canonical).isDirectory()) return;
  } catch { return; }
  shell.openPath(access.canonical);
});

// 原生拖拽：书桌文件拖到 Finder / 聊天区
wrapIpcOn("start-drag", async (event, filePaths) => {
  const requestedPaths = Array.isArray(filePaths) ? filePaths : [filePaths];
  const paths = requestedPaths
    .map(filePath => canReadPath(event.sender, filePath))
    .filter(result => result.allowed && result.canonical)
    .map(result => result.canonical);
  if (paths.length === 0) return;

  let icon;
  try {
    icon = await app.getFileIcon(paths[0], { size: "small" });
  } catch {
    icon = nativeImage.createFromDataURL(
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI12P4z8BQDwAEgAF/QualIQAAAABJRU5ErkJggg=="
    );
  }
  if (paths.length === 1) {
    event.sender.startDrag({ file: paths[0], icon });
  } else {
    event.sender.startDrag({ files: paths, icon });
  }
});

wrapIpcHandler("show-in-finder", (event, filePath) => {
  const access = canReadPath(event.sender, filePath);
  if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return;
  shell.showItemInFolder(access.canonical);
});

wrapIpcHandler("open-file", (event, filePath) => {
  const access = canReadPath(event.sender, filePath);
  if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return;
  try {
    if (!fs.statSync(access.canonical).isFile()) return;
  } catch { return; }
  shell.openPath(access.canonical);
});

const STANDALONE_HTML_CSP = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data: https: file:; style-src 'unsafe-inline' https:; font-src https: data:; connect-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'\">";

function sanitizeStandaloneHtml(html) {
  let next = String(html || "").slice(0, 5 * 1024 * 1024);
  next = next
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<\s*(iframe|object|embed)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*(iframe|object|embed)\b[^>]*\/?>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "")
    .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s+(href|src)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, " $1=\"#\"");

  if (/<head\b[^>]*>/i.test(next)) {
    return next.replace(/<head\b([^>]*)>/i, `<head$1>${STANDALONE_HTML_CSP}`);
  }
  return `${STANDALONE_HTML_CSP}\n${next}`;
}

wrapIpcHandler("open-html-in-browser", async (_event, html, title) => {
  if (typeof html !== "string" || !html) return;
  const safeTitle = String(title || "lynn-report").replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
  const tmpFile = path.join(os.tmpdir(), `${safeTitle}-${Date.now()}.html`);
  try {
    fs.writeFileSync(tmpFile, sanitizeStandaloneHtml(html), "utf-8");
    await shell.openPath(tmpFile);
  } catch (err) {
    logger.error("[open-html-in-browser]", err.message || err);
  }
});

/**
 * export-html-to-png — 用离屏 BrowserWindow 把 HTML 渲染为 PNG。
 *
 * 流程:
 *   1. sanitizeStandaloneHtml(html) 注入 CSP, 去 script / on* / iframe
 *   2. 写到 tmpFile, file:// 加载(支持长 HTML, 避开 data: URL 长度限制)
 *   3. 等 document.fonts.ready + 1.5s buffer (Google Fonts CDN)
 *   4. 测全文档高度, resize 离屏窗口
 *   5. capturePage() → PNG → 写到 ~/Downloads/<title>-<ts>.png
 *   6. 可选自动 showInFinder
 *
 * 安全: BrowserWindow webPreferences 关 nodeIntegration / contextIsolation,
 *       sandbox: true, 不加载 preload, 等价于普通浏览器 tab 的隔离。
 *       CSP script-src 'none' 阻止 HTML 内 inline script 执行。
 */
wrapIpcHandler("export-html-to-png", async (_event, html, title, opts = {}) => {
  if (typeof html !== "string" || !html) return null;
  const safeTitle = String(title || "lynn-export").replace(/[\\/:*?"<>|]/g, "-").slice(0, 80);
  const width = Math.max(320, Math.min(opts.width || 1180, 4096));
  const tmpFile = path.join(os.tmpdir(), `lynn-png-${Date.now()}.html`);
  let win = null;
  try {
    fs.writeFileSync(tmpFile, sanitizeStandaloneHtml(html), "utf-8");

    win = new BrowserWindow({
      show: false,
      width,
      height: 800,
      useContentSize: true,
      backgroundColor: opts.background || "#ffffff",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: true, // 仅用于 main → renderer 的 executeJavaScript 测高
        webSecurity: true,
      },
    });

    await win.loadFile(tmpFile);

    // 等字体加载(Google Fonts) + 短 buffer 给 layout 收敛
    try {
      await win.webContents.executeJavaScript(
        "(async () => { if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch {} } return true; })()",
        true,
      );
    } catch { /* fonts API 不可用就 fallback 到 timeout */ }
    await new Promise((r) => setTimeout(r, 1500));

    // 测全文档高度
    let fullHeight = 800;
    try {
      fullHeight = await win.webContents.executeJavaScript(
        "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0, 800)",
        true,
      );
    } catch { /* 测不到就用默认 800 */ }
    fullHeight = Math.min(Math.max(800, fullHeight), 32000); // 32k 像素上限

    win.setContentSize(width, fullHeight);
    await new Promise((r) => setTimeout(r, 300)); // 让 resize 后 reflow 收敛

    const image = await win.webContents.capturePage();
    const png = image.toPNG();

    const outDir = app.getPath("downloads") || os.tmpdir();
    fs.mkdirSync(outDir, { recursive: true });
    const filePath = path.join(outDir, `${safeTitle}-${Date.now()}.png`);
    fs.writeFileSync(filePath, png);

    if (opts.revealAfter !== false) {
      try { shell.showItemInFolder(filePath); } catch { /* finder 失败不致命 */ }
    }

    const size = image.getSize();
    return {
      filePath,
      bytes: png.length,
      width: size.width,
      height: size.height,
    };
  } catch (err) {
    logger.error("[export-html-to-png]", err.message || err);
    return null;
  } finally {
    try { if (win && !win.isDestroyed()) win.destroy(); } catch { /* destroy 失败忽略 */ }
    try { fs.unlinkSync(tmpFile); } catch { /* tmp 清理失败忽略 */ }
  }
});

wrapIpcHandler("save-file-dialog", async (event, opts = {}) => {
  const win = BrowserWindow.fromWebContents(event.sender) || getMainWindow();
  if (!win) return null;
  const result = await dialog.showSaveDialog(win, {
    title: opts.title || mt("common.save", null, "Save"),
    defaultPath: opts.defaultPath,
    filters: Array.isArray(opts.filters) ? opts.filters : undefined,
  });
  if (result.canceled || !result.filePath) return null;
  grantWebContentsAccess(event.sender, result.filePath, "readwrite");
  return result.filePath;
});

wrapIpcHandler("open-external", (_event, url) => {
  if (!url) return;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      shell.openExternal(url);
    }
  } catch {}
});

wrapIpcHandler("confirm-action", async (event, opts = {}) => {
  const sender = event.sender;
  const webContents = sender?.isDestroyed?.() ? null : sender;
  if (!webContents) return false;

  const requestId = `confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return await new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener(`confirm-action-response:${requestId}`, handleResponse);
      resolve(false);
    }, 5 * 60 * 1000);

    const handleResponse = (respEvent, payload = {}) => {
      if (respEvent?.sender !== webContents) {
        console.warn("[confirm-action] rejected response from untrusted sender");
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      ipcMain.removeListener(`confirm-action-response:${requestId}`, handleResponse);
      resolve(payload.approved === true);
    };

    ipcMain.once(`confirm-action-response:${requestId}`, handleResponse);

    try {
      webContents.send("confirm-action-request", {
        requestId,
        title: opts.title || "Lynn",
        message: opts.message || mt("common.confirm", null, "Confirm"),
        detail: opts.detail || "",
        confirmLabel: opts.confirmLabel || mt("common.confirm", null, "Confirm"),
        cancelLabel: opts.cancelLabel || mt("common.cancel", null, "Cancel"),
        tone: opts.tone === "danger" ? "danger" : "default",
      });
    } catch (err) {
      clearTimeout(timeout);
      ipcMain.removeListener(`confirm-action-response:${requestId}`, handleResponse);
      resolve(false);
    }
  });
});

// 读取文件内容（仅文本文件，用于 Artifacts 预览）
wrapIpcHandler("read-file", (event, filePath) => {
  const access = canReadPath(event.sender, filePath);
  if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return null;
  try {
    const stat = fs.statSync(access.canonical);
    if (!stat.isFile()) return null;
    if (stat.size > 5 * 1024 * 1024) return null;
    return fs.readFileSync(access.canonical, "utf-8");
  } catch { return null; }
});

// 写入文本文件（artifact 编辑用）
wrapIpcHandler("write-file", (event, filePath, content) => {
  const access = canWritePath(event.sender, filePath);
  if (!filePath || !path.isAbsolute(filePath) || !access.allowed || typeof content !== "string") return false;
  try {
    fs.writeFileSync(access.canonical, content, "utf-8");
    return true;
  } catch { return false; }
});

// 文件监听（artifact 编辑 — 外部变更刷新用）
const _fileWatchers = new Map();
wrapIpcHandler("watch-file", (event, filePath) => {
  const access = canReadPath(event.sender, filePath);
  if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return false;
  if (_fileWatchers.has(access.canonical)) {
    _fileWatchers.get(access.canonical).close();
    _fileWatchers.delete(access.canonical);
  }
  try {
    const watcher = fs.watch(access.canonical, { persistent: false }, (eventType) => {
      if (eventType === "change") {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) {
          win.webContents.send("file-changed", access.canonical);
        }
      }
    });
    _fileWatchers.set(access.canonical, watcher);
    return true;
  } catch { return false; }
});

wrapIpcHandler("unwatch-file", (_event, filePath) => {
  const canonical = resolveCanonicalPath(filePath);
  if (canonical && _fileWatchers.has(canonical)) {
    _fileWatchers.get(canonical).close();
    _fileWatchers.delete(canonical);
  }
  return true;
});

// 读取二进制文件为 base64（图片、PDF 等）
wrapIpcHandler("read-file-base64", (event, filePath) => {
  const access = canReadPath(event.sender, filePath);
  if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return null;
  try {
    const stat = fs.statSync(access.canonical);
    if (!stat.isFile()) return null;
    if (stat.size > 20 * 1024 * 1024) return null;
    return fs.readFileSync(access.canonical).toString("base64");
  } catch { return null; }
});

// 读取 docx 文件并转为 HTML（mammoth）
wrapIpcHandler("read-docx-html", async (event, filePath) => {
  const access = canReadPath(event.sender, filePath);
  if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return null;
  try {
    const stat = fs.statSync(access.canonical);
    if (!stat.isFile()) return null;
    if (stat.size > 20 * 1024 * 1024) return null;
    const mammoth = require("mammoth");
    const result = await mammoth.convertToHtml({ path: access.canonical });
    return result.value;
  } catch { return null; }
});

// 读取 xlsx 文件并转为 HTML 表格（ExcelJS）
wrapIpcHandler("read-xlsx-html", async (event, filePath) => {
  const access = canReadPath(event.sender, filePath);
  if (!filePath || !path.isAbsolute(filePath) || !access.allowed) return null;
  try {
    const stat = fs.statSync(access.canonical);
    if (!stat.isFile()) return null;
    if (stat.size > 20 * 1024 * 1024) return null;
    const ExcelJS = require("exceljs");
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(access.canonical);
    const sheet = workbook.worksheets[0];
    if (!sheet || sheet.rowCount === 0) return null;
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    let html = "<table>";
    sheet.eachRow((row) => {
      html += "<tr>";
      for (let i = 1; i <= sheet.columnCount; i++) {
        html += `<td>${esc(row.getCell(i).text)}</td>`;
      }
      html += "</tr>";
    });
    html += "</table>";
    return html;
  } catch { return null; }
});

wrapIpcHandler("grant-file-access", (event, filePath) => !!grantWebContentsAccess(event.sender, filePath, "read"));

// 重新加载主窗口（DevTools 用）
wrapIpcHandler("reload-main-window", () => {
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.reload();
  }
});



  function closeFileWatchers() {
    for (const [, watcher] of _fileWatchers) watcher.close();
    _fileWatchers.clear();
  }

  return { closeFileWatchers };
}

module.exports = { createFileIpcController, parseGgufModelPathPayload };
