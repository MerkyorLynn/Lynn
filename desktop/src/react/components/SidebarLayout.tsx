/**
 * SidebarLayout — 侧边栏布局管理 React 组件
 *
 * 管理：sidebar 折叠/展开、responsive 自动收缩、
 * 键盘快捷键、按钮事件绑定。
 * 从 sidebar-shim.ts 的 initSidebar / updateLayout / toggleSidebar 迁移。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../stores';
import { createNewSession } from '../stores/session-actions';
import { closePreview } from '../stores/artifact-actions';
import { toggleJianSidebar } from '../stores/desk-actions';
import { enterWritingMode, exitWritingMode } from '../hooks/use-writing-preview';
import { getWebSocket } from '../services/websocket';
import { toggleSidebar, updateLayout } from '../services/layout-controller';
import { ShortcutHelpModal } from './ShortcutHelpModal';

export { toggleSidebar, updateLayout } from '../services/layout-controller';

// ══════════════════════════════════════════════════════
// React 组件
// ══════════════════════════════════════════════════════

export function SidebarLayout() {
  const initDone = useRef(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false);
  const closeShortcutHelp = useCallback(() => setShortcutHelpOpen(false), []);

  useEffect(() => {
    if (initDone.current) return;
    initDone.current = true;

    // 迁移 localStorage
    const legacy = localStorage.getItem('hana-sidebar');
    if (legacy && !localStorage.getItem('hana-sidebar-chat')) {
      localStorage.setItem('hana-sidebar-chat', legacy);
    }
    const savedOpen = localStorage.getItem('hana-sidebar-chat');
    const sidebarOpen = savedOpen !== 'closed';

    useStore.setState({
      sidebarOpen,
      sidebarAutoCollapsed: false,
      jianAutoCollapsed: false,
    });

    // Resize
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        updateLayout();
        resizeTimer = null;
      }, 50);
    };
    window.addEventListener('resize', onResize);

    // 键盘快捷键
    const onKeydown = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;

      // Cmd+? → 快捷键和 slash 命令帮助。多数键盘会表现为 Cmd+Shift+/。
      if (mod && (e.key === '?' || (e.shiftKey && e.key === '/'))) {
        e.preventDefault();
        setShortcutHelpOpen(true);
        return;
      }

      // Cmd+K → 侧边栏可见时搜索 session，否则聚焦输入框
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (useStore.getState().sidebarOpen) {
          window.dispatchEvent(new CustomEvent('hana-sidebar-search'));
        } else {
          useStore.getState().requestInputFocus();
        }
        return;
      }

      // Cmd+Shift+N → 新建会话
      if (mod && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        createNewSession();
        return;
      }

      // Cmd+/ → 切换侧边栏
      if (mod && e.key === '/') {
        e.preventDefault();
        toggleSidebar();
        return;
      }

      // Cmd+L → 聚焦输入框(对齐浏览器/ChatGPT Cmd+L 行为,新建会话用 Cmd+Shift+N / Cmd+N)
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        useStore.getState().requestInputFocus();
        return;
      }

      // Cmd+J → 切换 Desk 面板 (Jian sidebar)
      if (mod && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        toggleJianSidebar();
        return;
      }

      // Cmd+Shift+M → 切换写作模式（M = Markdown/Mode；避开 Cmd+Shift+W 的"关闭所有窗口"）
      if (mod && e.shiftKey && e.key.toLowerCase() === 'm') {
        e.preventDefault();
        const state = useStore.getState();
        if (state.writingMode) {
          exitWritingMode();
        } else {
          enterWritingMode();
        }
        return;
      }

      // Escape → 停止流式输出 / 关闭预览
      if (e.key === 'Escape') {
        if (e.defaultPrevented || document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
        const state = useStore.getState();
        if (state.pendingConfirm) return;
        if (state.previewOpen) {
          e.preventDefault();
          closePreview();
          return;
        }
        if (state.isStreaming) {
          e.preventDefault();
          const ws = getWebSocket();
          if (ws?.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'abort', sessionPath: state.currentSessionPath }));
          }
          return;
        }
      }

      // Legacy: Cmd+Shift+S → toggle sidebar (keep for backwards compat)
      if (mod && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        toggleSidebar();
      }
      // Legacy: Cmd+N → new session (keep for backwards compat)
      if (mod && !e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        createNewSession();
      }
    };
    document.addEventListener('keydown', onKeydown);

    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('keydown', onKeydown);
    };
  }, []);

  return <ShortcutHelpModal open={shortcutHelpOpen} onClose={closeShortcutHelp} />;
}
