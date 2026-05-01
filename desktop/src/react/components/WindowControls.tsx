/**
 * WindowControls.tsx — Windows/Linux 自绘窗口控制按钮（最小化、最大化、关闭）
 *
 * 共享组件，同时用于主窗口（App.tsx）和设置窗口（SettingsApp.tsx）。
 * macOS 和 Web 环境下不渲染。
 */

import { useEffect, useState, useCallback } from 'react';

export function WindowControls() {
  const t = window.t ?? ((p: string) => p);
  const [isWin, setIsWin] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | void;
    const p = window.platform;
    if (!p?.getPlatform) return;

    const setIsWinIfChanged = (next: boolean) => {
      if (!cancelled) setIsWin((prev) => (prev === next ? prev : next));
    };
    const setMaximizedIfChanged = (next: boolean) => {
      if (!cancelled) setMaximized((prev) => (prev === next ? prev : next));
    };

    p.getPlatform()
      .then((plat: string) => {
        const shouldRenderNativeControls = plat !== 'darwin' && plat !== 'web';
        setIsWinIfChanged(shouldRenderNativeControls);
        if (!shouldRenderNativeControls || cancelled) return;

        unsubscribe = p.onMaximizeChange?.((val: boolean) => setMaximizedIfChanged(!!val));
        p.windowIsMaximized?.()
          .then((val: boolean) => setMaximizedIfChanged(!!val))
          .catch(() => {});
      })
      .catch(() => setIsWinIfChanged(false));

    return () => {
      cancelled = true;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  const minimize = useCallback(() => window.platform?.windowMinimize?.(), []);
  const maximize = useCallback(() => window.platform?.windowMaximize?.(), []);
  const close = useCallback(() => window.platform?.windowClose?.(), []);

  if (!isWin) return null;

  return (
    <div className="window-controls">
      <button className="wc-btn wc-minimize" title={t('window.minimize')} onClick={minimize}>
        <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="6" x2="10" y2="6" stroke="currentColor" strokeWidth="1"/></svg>
      </button>
      <button className="wc-btn wc-maximize" title={t('window.maximize')} onClick={maximize}>
        <svg width="12" height="12" viewBox="0 0 12 12">
          {maximized
            ? <><rect x="3" y="1" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1"/><rect x="1" y="3" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1"/></>
            : <rect x="2" y="2" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1"/>
          }
        </svg>
      </button>
      <button className="wc-btn wc-close" title={t('window.close')} onClick={close}>
        <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1"/><line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1"/></svg>
      </button>
    </div>
  );
}
