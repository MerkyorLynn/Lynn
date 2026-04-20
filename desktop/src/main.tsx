import { createRoot } from 'react-dom/client';
import App from './react/App';

// v0.77 dev mock service worker (仅开发模式 + 显式开启)
// 用法: VITE_USE_MSW=true npm run dev:renderer
async function maybeStartMockSW() {
  if (!import.meta.env.DEV) return;
  if (import.meta.env.VITE_USE_MSW !== 'true') return;
  try {
    const { worker } = await import('./dev-mock-sw');
    await worker.start({
      onUnhandledRequest: 'bypass',
      serviceWorker: { url: '/mockServiceWorker.js' },
    });
    // eslint-disable-next-line no-console
    console.log('[v0.77] mock service worker active · /v1/memory/* /v1/audio/* 走 mock');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[v0.77] mock SW 启动失败,继续走真实后端', err);
  }
}

async function pickRoot() {
  // ?v077-demo · 显示 v0.77 组件视觉测试页(开发期专用)
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('v077-demo')) {
    const { V077Demo } = await import('./components/v077-demo');
    return <V077Demo />;
  }
  return <App />;
}

void (async () => {
  await maybeStartMockSW();
  const node = await pickRoot();
  const el = document.getElementById('react-root');
  if (el) createRoot(el).render(node);
})();
