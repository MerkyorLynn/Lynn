const path = require("path");

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function createWindowLoader({ dirname, fs, isDev = false, viteDevUrl = "" }) {
  const distRenderer = path.join(dirname, "dist-renderer");

  function loadWindowErrorPage(win, pageName, err) {
    const detail = escapeHtml(err?.message || err || "unknown error");
    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(pageName)}</title>
  <style>
    :root { color-scheme: light; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
      box-sizing: border-box;
      background: #f8f5ed;
      color: #4f5b66;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    .card {
      width: min(560px, 100%);
      background: rgba(255,255,255,0.88);
      border-radius: 18px;
      box-shadow: 0 18px 40px rgba(74, 92, 106, 0.12);
      padding: 24px 28px;
    }
    h1 { margin: 0 0 10px; font-size: 20px; color: #3f4a55; }
    p { margin: 0; line-height: 1.7; }
    code {
      display: block;
      margin-top: 14px;
      padding: 12px 14px;
      border-radius: 12px;
      background: rgba(79, 91, 102, 0.08);
      color: #556372;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>${escapeHtml(pageName)} 加载失败</h1>
    <p>这个窗口没有正确加载出来。重新打开一次试试；如果仍然出现，请把下面这段错误信息发给开发者。</p>
    <code>${detail}</code>
  </div>
</body>
</html>`;
    return win.loadURL(`data:text/html;charset=UTF-8,${encodeURIComponent(html)}`);
  }

  function loadWindowURL(win, pageName, opts) {
    if (isDev && viteDevUrl) {
      let url = `${viteDevUrl}/${pageName}.html`;
      if (opts?.query && Object.keys(opts.query).length > 0) {
        const qs = new URLSearchParams(opts.query).toString();
        url += `?${qs}`;
      }
      return win.loadURL(url);
    }

    const built = path.join(distRenderer, `${pageName}.html`);
    if (isDev) {
      return win.loadFile(path.join(dirname, "src", `${pageName}.html`), opts);
    }
    if (!fs.existsSync(built)) {
      const err = new Error(`renderer entry missing: ${built}`);
      console.error(`[desktop] ${pageName} 页面入口缺失: ${built}`);
      return loadWindowErrorPage(win, pageName, err);
    }
    return win.loadFile(built, opts).catch((err) => {
      console.error(`[desktop] ${pageName} 页面加载失败: ${err.message}`);
      return loadWindowErrorPage(win, pageName, err);
    });
  }

  function getWindowEntryStamp(pageName) {
    try {
      const entryPath = isDev
        ? path.join(dirname, "src", `${pageName}.html`)
        : path.join(distRenderer, `${pageName}.html`);
      const stat = fs.statSync(entryPath);
      return `${entryPath}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
    } catch {
      return `${pageName}:missing`;
    }
  }

  return {
    loadWindowErrorPage,
    loadWindowURL,
    getWindowEntryStamp,
  };
}

module.exports = { createWindowLoader, escapeHtml };
