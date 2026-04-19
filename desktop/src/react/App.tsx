/**
 * App.tsx — React 根组件（纯布局编排）
 *
 * 初始化逻辑在 app-init.ts，拖拽/主内容区在 MainContent.tsx。
 * 此文件只负责 titlebar + sidebar + 主区域 + overlays 的组装。
 */

import { useEffect, lazy, Suspense, useState, useCallback, useMemo, useRef } from 'react';
import { useStore } from './stores';
import type { ActivePanel, Session } from './types';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RegionalErrorBoundary } from './components/RegionalErrorBoundary';
import { ActivityPanel } from './components/ActivityPanel';
import { AutomationPanel } from './components/AutomationPanel';
import { BridgePanel } from './components/BridgePanel';
import { ChangesPanel } from './components/ChangesPanel';

const SkillViewerOverlay = lazy(() => import('./components/SkillViewerOverlay').then(m => ({ default: m.SkillViewerOverlay })));
import { PreviewPanel } from './components/PreviewPanel';
import { DiagnosticsPanel } from './components/debug/DiagnosticsPanel';
import { DeskSection } from './components/DeskSection';
import { DeskSkillsSection } from './components/desk/DeskSkillsSection';
import { InputArea } from './components/InputArea';
import { SessionList } from './components/SessionList';
import { SidebarCapabilityBar } from './components/SidebarCapabilityBar';
import { WelcomeScreen } from './components/WelcomeScreen';
import { ChatArea } from './components/chat/ChatArea';
import { AgentDiscoveryDialog } from './components/AgentDiscoveryDialog';
import { SidebarLayout, toggleSidebar } from './components/SidebarLayout';
import { FloatPreviewCard, useFloatCard } from './components/FloatPreviewCard';
import { useSidebarResize } from './hooks/use-sidebar-resize';
import { createNewSession, renameSession } from './stores/session-actions';
import { toggleJianSidebar } from './stores/desk-actions';
import { WindowControls } from './components/WindowControls';
import { ToastContainer } from './components/ToastContainer';
import { ConfirmationDialog } from './components/ConfirmationDialog';
import { StatusBar } from './components/StatusBar';
import { initTheme, initDragPrevention } from './bootstrap';
import { initApp } from './app-init';
import { MainContent } from './MainContent';

declare function t(key: string, vars?: Record<string, string | number>): string;

initTheme();
initDragPrevention();

function togglePanel(panel: ActivePanel) {
  const s = useStore.getState();
  s.setActivePanel(s.activePanel === panel ? null : panel);
}

function WelcomeContainer() {
  const visible = useStore(s => s.welcomeVisible);
  return (
    <div className={`welcome${visible ? '' : ' hidden'}`} id="welcome">
      <WelcomeScreen />
    </div>
  );
}

function AutomationBadge() {
  const count = useStore(s => s.automationCount);
  return <span className="automation-count-badge">{count > 0 ? String(count) : ''}</span>;
}

function SettingsButton() {
  const [showPulse, setShowPulse] = useState(() => {
    try {
      return !localStorage.getItem('hanako-settings-clicked');
    } catch {
      return false;
    }
  });

  const handleClick = useCallback(() => {
    if (showPulse) {
      setShowPulse(false);
      try {
        localStorage.setItem('hanako-settings-clicked', '1');
      } catch {
        // ignore storage failures
      }
      window.platform.openSettings('providers');
      return;
    }
    window.platform.openSettings();
  }, [showPulse]);

  return (
    <button
      className={`sidebar-settings-btn${showPulse ? ' sidebar-settings-pulse' : ''}`}
      id="settingsBtn"
      title={t('settings.title')}
      onClick={handleClick}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
      <span>{t('settings.title')}</span>
    </button>
  );
}

function BridgeDot() {
  const connected = useStore(s => s.bridgeDotConnected);
  return <span className={`sidebar-bridge-dot${connected ? ' connected' : ''}`}></span>;
}

function ConnectionStatus() {
  const connected = useStore(s => s.connected);
  const statusKey = useStore(s => s.statusKey);
  const statusVars = useStore(s => s.statusVars);
  return (
    <div className={`connection-status${connected ? ' connected' : ''}`}>
      <span className="status-dot"></span>
      <span className="status-text">{statusKey ? t(statusKey, statusVars) : ''}</span>
    </div>
  );
}

function folderLabel(folderPath: string | null): string {
  if (!folderPath) return '';
  const parts = folderPath.split('/').filter(Boolean);
  return parts[parts.length - 1] || folderPath;
}

function countPendingJianTodos(content: string | null): number {
  const text = String(content || '');
  const matches = text.match(/^- \[( |x|X)\] /gm) || [];
  const done = matches.filter((item) => /\[(x|X)\]/.test(item)).length;
  return matches.length - done;
}

function trimTitle(value: string | null | undefined): string {
  const raw = (value || '').trim();
  if (!raw) return 'Lynn';
  if (raw.length <= 40) return raw;
  return `${raw.slice(0, 39)}...`;
}

function resolveSessionTitle(session: Session | null, fallback: string): string {
  if (!session) return fallback;
  return trimTitle(session.title || session.firstMessage || fallback);
}

function App() {
  useSidebarResize();
  useStore(s => s.locale);
  const sidebarOpen = useStore(s => s.sidebarOpen);
  const jianOpen = useStore(s => s.jianOpen);
  const browserRunning = useStore(s => s.browserRunning);
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const currentAgentId = useStore(s => s.currentAgentId);
  const sessions = useStore(s => s.sessions);
  const deskBasePath = useStore(s => s.deskBasePath || s.selectedFolder || s.homeFolder || null);
  const agentName = useStore(s => s.agentName) || 'Lynn';
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const sessionCreationPending = useStore(s => s.sessionCreationPending);
  const hasPanels = !welcomeVisible && !!currentSessionPath;
  const jianContent = useStore(s => s.deskJianContent);
  const isStreaming = useStore(s => s.isStreaming);
  const deskPatrolStatus = useStore(s => s.deskPatrolStatus);
  const currentActivity = useStore(s => s.currentActivity);
  const isWorking = isStreaming || deskPatrolStatus?.state === 'running';
  const jianHasContent = !!jianContent && jianContent.trim().length > 0;
  const jianPendingCount = countPendingJianTodos(jianContent);
  const { floatCard, show: showFloat, scheduleHide: scheduleFloatHide, cancelHide: cancelFloatHide, hide: hideFloat } = useFloatCard();

  const currentSession = useMemo(
    () => sessions.find((session) => session.path === currentSessionPath) || null,
    [sessions, currentSessionPath],
  );
  const titlePrimary = useMemo(() => {
    // [PROGRESS-UX v1] when streaming with an active tool, replace title with activity label
    if (isStreaming && currentActivity) {
      const ag = agentName || 'Lynn';
      const friendly = t(`tool.${currentActivity}.running`, { name: ag });
      const fb = t('tool._fallback.running', { name: ag });
      const label = (friendly && friendly !== `tool.${currentActivity}.running`)
        ? friendly
        : (fb && fb !== 'tool._fallback.running' ? fb : `正在调用 ${currentActivity}`);
      return label;
    }
    if (welcomeVisible) return '';
    if (currentSession) return resolveSessionTitle(currentSession, agentName);
    if (pendingNewSession) return t('sidebar.newChat') || '新对话';
    return agentName;
  }, [agentName, currentSession, pendingNewSession, welcomeVisible, isStreaming, currentActivity]);
  const titleSecondary = useMemo(() => {
    const workspace = folderLabel(deskBasePath);
    if (!workspace) return '';
    return workspace;
  }, [deskBasePath]);
  const titleRenameEnabled = !!currentSession && !welcomeVisible;
  const [titleEditing, setTitleEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setTitleEditing(false);
    setTitleDraft('');
  }, [currentSessionPath]);

  useEffect(() => {
    if (!titleEditing || !titleInputRef.current) return;
    titleInputRef.current.focus();
    titleInputRef.current.select();
  }, [titleEditing]);

  const startTitleRename = useCallback(() => {
    if (!currentSession) return;
    setTitleDraft(currentSession.title || currentSession.firstMessage || '');
    setTitleEditing(true);
  }, [currentSession]);

  const commitTitleRename = useCallback(async () => {
    if (!currentSession) {
      setTitleEditing(false);
      return;
    }
    const trimmed = titleDraft.trim();
    setTitleEditing(false);
    if (!trimmed) return;
    if (trimmed === (currentSession.title || currentSession.firstMessage || '')) return;
    await renameSession(currentSession.path, trimmed);
  }, [currentSession, titleDraft]);

  const cancelTitleRename = useCallback(() => {
    setTitleEditing(false);
    setTitleDraft('');
  }, []);

  const handleTitleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      void commitTitleRename();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelTitleRename();
    }
  }, [cancelTitleRename, commitTitleRename]);

  useEffect(() => {
    initApp().catch((err: unknown) => {
      console.error('[init] 初始化异常:', err);
      window.platform?.appReady?.();
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isModifier = event.metaKey || event.ctrlKey;
      if (!isModifier || !event.shiftKey || event.key.toLowerCase() !== 'd') return;
      event.preventDefault();
      setDiagnosticsOpen((prev) => !prev);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem('hana-tab', 'chat');
    } catch {
      // ignore storage failures
    }
    useStore.setState({
      currentTab: 'chat',
      currentChannel: null,
      channelMessages: [],
      channelMembers: [],
      channelTotalUnread: 0,
      channelHeaderName: '',
      channelHeaderMembersText: '',
      channelInfoName: '',
      channelIsDM: false,
      channelArchived: false,
      channelsEnabled: false,
      channelCreateOverlayVisible: false,
      addMemberOverlayVisible: false,
      addMemberTargetChannel: null,
    });
  }, []);

  return (
    <ErrorBoundary>
      <SidebarLayout />

      <div className="titlebar">
        <button
          className={`tb-toggle tb-toggle-left${sidebarOpen ? ' active' : ''}`}
          id="tbToggleLeft"
          title={t('sidebar.toggle')}
          onClick={() => { hideFloat(); toggleSidebar(); }}
          onMouseEnter={(e) => showFloat('left', e.currentTarget)}
          onMouseLeave={scheduleFloatHide}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="9" y1="3" x2="9" y2="21"></line>
          </svg>
        </button>
        <div className={`tb-title${titleRenameEnabled ? ' is-editable' : ''}`}>
          {isWorking && <span className="tb-working-dot" />}
          {titleEditing && currentSession ? (
            <input
              ref={titleInputRef}
              className="tb-title-input"
              value={titleDraft}
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={() => { void commitTitleRename(); }}
              onKeyDown={handleTitleInputKeyDown}
              onClick={(e) => e.stopPropagation()}
              aria-label={t('session.rename')}
            />
          ) : (
            <button
              type="button"
              className="tb-title-primary tb-title-primary-button"
              onClick={startTitleRename}
              disabled={!titleRenameEnabled}
              title={titleRenameEnabled ? t('session.rename') : undefined}
            >
              {titlePrimary}
            </button>
          )}
          {titleSecondary ? <span className="tb-title-secondary">{titleSecondary}</span> : null}
        </div>
        <button
          className={`tb-toggle tb-toggle-right${jianOpen ? ' active' : ''}`}
          id="tbToggleRight"
          title={t('sidebar.jian')}
          onClick={() => { hideFloat(); toggleJianSidebar(); }}
          onMouseEnter={(e) => showFloat('right', e.currentTarget)}
          onMouseLeave={scheduleFloatHide}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="15" y1="3" x2="15" y2="21"></line>
          </svg>
          <span className={`tb-toggle-badge${jianPendingCount > 0 ? ' has-count' : jianHasContent ? ' has-content' : ''}`}>
            {jianPendingCount > 0 ? String(Math.min(jianPendingCount, 99)) : jianHasContent ? '•' : '+'}
          </span>
        </button>
        <WindowControls />
      </div>

      <div className="app">
        <aside className={`sidebar${sidebarOpen ? '' : ' collapsed'}`} id="sidebar">
          <div className="sidebar-inner">
            <div className="sidebar-chat-content">
              <div className="sidebar-header">
                <span className="sidebar-title">{t('sidebar.title')}</span>
                <div className="sidebar-header-actions">
                  <button className="sidebar-footer-btn" id="bridgeBar" title={t('sidebar.bridgeShort')} onClick={() => togglePanel('bridge')}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path>
                      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
                    </svg>
                    <BridgeDot />
                  </button>
                  <button className="sidebar-footer-btn" id="activityBar" title={t('sidebar.activity')} onClick={() => togglePanel('activity')}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
                    </svg>
                  </button>
                  <button
                    className="sidebar-action-btn"
                    id="newSessionBtn"
                    title={t('sidebar.newChat')}
                    onClick={createNewSession}
                    disabled={sessionCreationPending}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="5" x2="12" y2="19"></line>
                      <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                  </button>
                  <button className="sidebar-action-btn" id="sidebarCollapseBtn" title={t('sidebar.collapse')} onClick={() => toggleSidebar()}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="15 6 9 12 15 18"></polyline>
                    </svg>
                  </button>
                </div>
              </div>
              <button className="sidebar-activity-bar" id="automationBar" onClick={() => togglePanel('automation')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                <span>{t('automation.title')}</span>
                <AutomationBadge />
              </button>
              <button className={`sidebar-activity-bar browser-bg-bar${browserRunning ? '' : ' hidden'}`} id="browserBgBar" title={t('browser.backgroundHint')} onClick={() => window.platform?.openBrowserViewer?.()}>
                <svg className="browser-bg-globe" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="2" y1="12" x2="22" y2="12"></line>
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1 4-10z"></path>
                </svg>
                <span>{t('browser.background')}</span>
              </button>
              <SidebarCapabilityBar />
              <div className="session-list" id="sessionList">
                <RegionalErrorBoundary region="sidebar" resetKeys={[currentAgentId]}>
                  <SessionList />
                </RegionalErrorBoundary>
              </div>
            </div>
          </div>
          <div className="sidebar-footer-icons">
            <SettingsButton />
          </div>
          <div className="resize-handle resize-handle-right" id="sidebarResizeHandle"></div>
        </aside>

        <MainContent>
          <div className={`chat-area${hasPanels ? ' has-panels' : ''}`}>
            <WelcomeContainer />
            <RegionalErrorBoundary region="chat" resetKeys={[currentSessionPath]}>
              <ChatArea />
            </RegionalErrorBoundary>
          </div>

          <div className="input-area">
            <RegionalErrorBoundary region="input" resetKeys={[currentSessionPath]}>
              <InputArea />
            </RegionalErrorBoundary>
          </div>

          <ActivityPanel />
          <ChangesPanel />
          <AutomationPanel />
          <BridgePanel />
        </MainContent>

        <PreviewPanel />

        <aside className={`jian-sidebar${jianOpen ? '' : ' collapsed'}`} id="jianSidebar">
          <div className="resize-handle resize-handle-left" id="jianResizeHandle"></div>
          <div className="jian-sidebar-inner">
            <div className="jian-chat-content">
              <RegionalErrorBoundary region="desk">
                <DeskSection />
              </RegionalErrorBoundary>
            </div>
          </div>
        </aside>
      </div>

      <ConnectionStatus />
      <DeskSkillsSection />
      <Suspense fallback={null}><SkillViewerOverlay /></Suspense>
      <AgentDiscoveryDialog />

      {floatCard && (
        <FloatPreviewCard
          state={floatCard}
          onMouseEnter={cancelFloatHide}
          onMouseLeave={scheduleFloatHide}
          onAction={hideFloat}
        />
      )}

      <StatusBar />
      <ConfirmationDialog />
      <ToastContainer />
      <DiagnosticsPanel open={diagnosticsOpen} onClose={() => setDiagnosticsOpen(false)} />
    </ErrorBoundary>
  );
}

export default App;
