/**
 * platform.js — 平台适配层
 *
 * Electron 环境：直接转发给 preload 注入的 window.lynn/window.hana（IPC）
 * Web 环境：降级到 HTTP API + 浏览器原生 API
 *
 * 使用方式：所有前端代码调 platform.xxx()，不再直接碰 window.hana/window.lynn。
 */
(function () {
  if (window.lynn || window.hana) {
    // Electron — 直接用 preload 注入的 IPC bridge
    const bridge = window.lynn || window.hana;
    window.lynn = bridge;
    window.hana = bridge;
    window.platform = bridge;
    return;
  }

  // Web / 非 Electron 环境 — HTTP fallback
  const params = new URLSearchParams(location.search);
  const tokenFromQuery = params.get('token') || '';
  const tokenFromStorage = localStorage.getItem('hana-token') || '';
  const token = tokenFromQuery || tokenFromStorage;

  if (token) {
    try {
      localStorage.setItem('hana-token', token);
      document.cookie = `hana_token=${encodeURIComponent(token)}; path=/; SameSite=Strict`;
      if (tokenFromQuery) {
        params.delete('token');
        const nextQuery = params.toString();
        const nextUrl = `${location.pathname}${nextQuery ? `?${nextQuery}` : ''}${location.hash}`;
        window.history.replaceState({}, '', nextUrl);
      }
    } catch {
      // Storage/cookie writes can fail in restricted browser contexts.
    }
  }

  const baseUrl = `${location.protocol}//${location.host}`;

  function apiFetch(path, opts = {}) {
    const headers = { ...opts.headers };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetch(`${baseUrl}${path}`, { ...opts, headers });
  }

  window.platform = {
    // 服务器连接
    getServerPort: async () => location.port || '3000',
    getServerToken: async () => token,
    appReady: async () => {},

    // 文件 I/O → server HTTP
    readFile: (p) => apiFetch(`/api/fs/read?path=${encodeURIComponent(p)}`).then(r => r.ok ? r.text() : null),
    readFileBase64: (p) => apiFetch(`/api/fs/read-base64?path=${encodeURIComponent(p)}`).then(r => r.ok ? r.text() : null),
    readDocxHtml: (p) => apiFetch(`/api/fs/docx-html?path=${encodeURIComponent(p)}`).then(r => r.ok ? r.text() : null),
    readXlsxHtml: (p) => apiFetch(`/api/fs/xlsx-html?path=${encodeURIComponent(p)}`).then(r => r.ok ? r.text() : null),

    // 文件写入 / 监听 / 编辑器窗口 → Web 不支持
    writeFile: async () => false,
    watchFile: async () => false,
    unwatchFile: async () => false,
    onFileChanged: () => {},
    openEditorWindow: () => {},
    onEditorDockFile: () => {},
    onEditorDetached: () => {},

    // 文件路径（Web 不支持系统路径）
    getFilePath: () => null,
    getAvatarPath: () => null,
    getSplashInfo: async () => ({}),

    // 系统对话框 → Web 降级
    selectFolder: async () => null,
    selectGgufModel: async () => null,
    getOnboardingDefaults: async () => ({ workspacePath: '', trustedRoots: [], installRoot: null, desktopRoot: null }),
    selectSkill: async () => null,
    llamacppOpenModelDir: async () => ({ ok: false, reason: 'desktop-only' }),
    llamacppStartCustomModel: async () => ({ ok: false, reason: 'desktop-only' }),
    llamacppStop: async () => ({ ok: false, reason: 'desktop-only' }),
    llamacppStartDownload: async () => ({ ok: false, reason: 'desktop-only' }),

    // OS 集成 → 静默降级
    openFolder: () => {},
    openFile: () => {},
    openHtmlInBrowser: async (html) => {
      try {
        const escape = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const isolated = `<!doctype html><html><head><meta charset="utf-8"><title>HTML preview</title></head><body style="margin:0"><iframe title="HTML preview" sandbox="allow-scripts allow-downloads allow-popups" referrerpolicy="no-referrer" style="border:0;width:100vw;height:100vh;display:block" srcdoc="${escape(html)}"></iframe></body></html>`;
        const blob = new Blob([isolated], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank', 'noopener,noreferrer');
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch { /* web fallback only */ }
    },
    exportHtmlToPng: async () => null,  // Web 环境无离屏渲染能力,降级 null;调用方应判断后给提示
    openExternal: (url) => { try { const parsed = new URL(url); if (['https:', 'http:'].includes(parsed.protocol) && !parsed.username && !parsed.password) window.open(parsed.href, '_blank', 'noopener,noreferrer'); } catch { /* invalid URL / popup blocked */ } },
    showInFinder: () => {},
    startDrag: () => {},
    confirmAction: async (opts = {}) => window.confirm(opts.message || 'Confirm'),
    onConfirmActionRequest: () => () => {},
    respondConfirmAction: () => {},
    getNotificationPermissionStatus: async () => 'unsupported',
    requestNotificationPermission: async () => 'unsupported',

    // 窗口管理 → 单页降级
    openSettings: () => {},
    getGlobalSummonShortcutStatus: async () => ({
      ok: false,
      accelerator: null,
      fallbackUsed: false,
      attempted: [],
      configured: null,
      defaultAccelerator: null,
      layer: null,
      errors: {},
    }),
    setGlobalSummonShortcut: async () => ({
      ok: false,
      accelerator: null,
      fallbackUsed: false,
      attempted: [],
      configured: null,
      defaultAccelerator: null,
      layer: null,
      errors: {},
    }),
    reloadMainWindow: () => location.reload(),

    // 设置通信 → Web 环境暂不支持跨窗口
    settingsChanged: () => {},
    onSettingsChanged: () => {},

    // 浏览器查看器 → Web 环境暂不支持
    openBrowserViewer: () => {},
    closeBrowserViewer: () => {},
    onBrowserUpdate: () => {},
    browserGoBack: () => {},
    browserGoForward: () => {},
    browserReload: () => {},
    browserEmergencyStop: () => {},

    // Skill 查看器 → Web 环境暂不支持
    openSkillViewer: () => {},
    listSkillFiles: async () => [],
    readSkillFile: async () => null,
    onSkillViewerLoad: () => {},
    closeSkillViewer: () => {},

    // Onboarding
    onboardingComplete: async () => true,
    debugOpenOnboarding: async () => {},
    debugOpenOnboardingPreview: async () => {},

    // 窗口控制（Web 不需要）
    getPlatform: async () => 'web',
    windowMinimize: () => {},
    windowMaximize: () => {},
    windowClose: () => {},
    windowIsMaximized: async () => false,
    onMaximizeChange: () => {},
  };
})();

// ── 平台检测 ──
(async function initPlatform() {
  const p = window.platform;
  if (!p?.getPlatform) return;
  const plat = await p.getPlatform();
  document.documentElement.setAttribute('data-platform', plat);
  // Windows/Linux 窗口控制按钮已迁移到 React (App.tsx WindowControls)
})();
