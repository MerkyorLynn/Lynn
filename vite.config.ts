import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { copyLegacyFiles, preserveLegacyCss, restoreLegacyCss } from './desktop/build/legacy-assets';

/**
 * CSP 集中管理：
 * 所有窗口的 CSP 策略统一定义在此，Vite 构建/开发时注入。
 * HTML 源文件中保留 CSP meta tag 作为 fallback（loadFile 回退路径）。
 *
 * 修改 CSP 时只改这里，然后同步更新 HTML 源文件。
 */
const CSP_PROFILES: Record<string, string> = {
  // 主窗口：需要 API 连接、图片、字体（KaTeX）、iframe（artifacts）
  'index.html':
    "default-src 'self'; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*; img-src 'self' data: file: http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:; frame-src blob: data:",
  // 设置窗口：需要 API 连接、图片、字体
  'settings.html':
    "default-src 'self'; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*; img-src 'self' data: file: http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:",
  // Onboarding：需要 API 连接、图片、字体
  'onboarding.html':
    "default-src 'self'; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*; img-src 'self' data: file: http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self' data:",
  // 以下窗口不加载第三方字体，保持严格策略
  'splash.html':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' file:",
  'browser-viewer.html':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' file:",
  'editor-window.html':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'",
};

function injectCsp(): Plugin {
  return {
    name: 'hana-inject-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const filename = path.basename(ctx.filename);
        const profile = CSP_PROFILES[filename];
        if (!profile) return html;

        let csp = profile;
        // Dev 模式放宽：React Refresh 需要 unsafe-inline，Vite HMR 需要 ws
        if (process.env.NODE_ENV !== 'production') {
          csp = csp.replace(
            /script-src 'self'/,
            "script-src 'self' 'unsafe-inline'",
          );
          if (csp.includes('connect-src')) {
            csp = csp.replace(
              /connect-src 'self'/,
              "connect-src 'self' ws://localhost:5173",
            );
          }
        }

        return html.replace(
          /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*"\s*\/?>/,
          `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
        );
      },
    },
  };
}

export default defineConfig({
  root: 'desktop/src',
  base: './',
  plugins: [
    preserveLegacyCss(),
    react(),
    injectCsp(),
    restoreLegacyCss(),
    copyLegacyFiles(__dirname),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'desktop/src/react'),
    },
  },
  build: {
    outDir: '../dist-renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'desktop/src/index.html'),
        settings: path.resolve(__dirname, 'desktop/src/settings.html'),
        onboarding: path.resolve(__dirname, 'desktop/src/onboarding.html'),
        splash: path.resolve(__dirname, 'desktop/src/splash.html'),
        'browser-viewer': path.resolve(__dirname, 'desktop/src/browser-viewer.html'),
        'editor-window': path.resolve(__dirname, 'desktop/src/editor-window.html'),
      },
      output: {
        manualChunks(id) {
          if (id.includes('vite/preload-helper')) {
            return 'preload-helper';
          }

          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom') || id.includes('node_modules/scheduler')) {
            return 'react-vendor';
          }

          if (id.includes('node_modules/zustand')) {
            return 'state-vendor';
          }

          if (id.includes('@codemirror') || id.includes('@lezer')) {
            return 'codemirror-vendor';
          }

          if (id.includes('node_modules/katex') || id.includes('markdown-it') || id.includes('dompurify')) {
            return 'rendering-vendor';
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    root: path.resolve(__dirname),
  },
});
