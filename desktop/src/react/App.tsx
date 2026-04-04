/**
 * App.tsx — React 根组件（纯布局编排）
 *
 * 初始化逻辑在 app-init.ts，拖拽/主内容区在 MainContent.tsx。
 * 此文件只负责 titlebar + sidebar + 主区域 + overlays 的组装。
 */

import { useEffect, lazy, Suspense, useState, useCallback, useRef } from 'react';
import { useStore } from './stores';
import type { ActivePanel } from './types';
import { ErrorBoundary } from './components/ErrorBoundary';
import { RegionalErrorBoundary } from './components/RegionalErrorBoundary';
import { ActivityPanel } from './components/ActivityPanel';
import { AutomationPanel } from './components/AutomationPanel';
import { BridgePanel } from './components/BridgePanel';

const SkillViewerOverlay = lazy(() => import('./components/SkillViewerOverlay').then(m => ({ default: m.SkillViewerOverlay })));
import { PreviewPanel } from './components/PreviewPanel';
import { DeskSection } from './components/DeskSection';
import { InputArea } from './components/InputArea';
import { SessionList } from './components/SessionList';
import { SidebarCapabilityBar } from './components/SidebarCapabilityBar';
import { WelcomeScreen } from './components/WelcomeScreen';
import { ChatArea } from './components/chat/ChatArea';
import { ChannelsPanel, ChannelMessages, ChannelMembers, ChannelInput, ChannelReadonly } from './components/ChannelsPanel';
import { ChannelTabBar } from './components/channels/ChannelTabBar';
import { ChannelListSidebar } from './components/channels/ChannelList';
import { ChannelHeader } from './components/channels/ChannelHeader';
import { ChannelCreateOverlay } from './components/channels/ChannelCreateOverlay';
import { AddMemberOverlay } from './components/channels/AddMemberOverlay';
import { AgentDiscoveryDialog } from './components/AgentDiscoveryDialog';
import { SidebarLayout, toggleSidebar } from './components/SidebarLayout';
import { FloatPreviewCard, useFloatCard } from './components/FloatPreviewCard';
import { useSidebarResize } from './hooks/use-sidebar-resize';
import { createNewSession } from './stores/session-actions';
import { toggleJianSidebar } from './stores/desk-actions';
import { WindowControls } from './components/WindowControls';
import { ToastContainer } from './components/ToastContainer';
import { ConfirmationDialog } from './components/ConfirmationDialog';
import { StatusBar } from './components/StatusBar';
import { initTheme, initDragPrevention } from './bootstrap';
import { initApp } from './app-init';
import { MainContent } from './MainContent';
import { hanaUrl, hanaFetch } from './hooks/use-hana-fetch';
import { yuanFallbackAvatar } from './utils/agent-helpers';

declare function t(key: string, vars?: Record<string, string | number>): string;

// ── 主题 + drag 阻止（import 时立即执行） ──
initTheme();
initDragPrevention();

// ── 面板切换 ──

function togglePanel(panel: ActivePanel) {
  const s = useStore.getState();
  s.setActivePanel(s.activePanel === panel ? null : panel);
}

// ── 内联子组件 ──

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
      try { localStorage.setItem('hanako-settings-clicked', '1'); } catch {}
      window.platform.openSettings('providers');
      return;
    }
    window.platform.openSettings();
  }, [showPulse]);

  return (
    <button
      className={`sidebar-action-btn${showPulse ? ' sidebar-settings-pulse' : ''}`}
      id="settingsBtn"
      title={t('settings.title')}
      onClick={handleClick}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
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

function ChannelInputArea() {
  const currentChannel = useStore(s => s.currentChannel);
  const isDM = useStore(s => s.channelIsDM);

  if (!currentChannel) return null;

  if (isDM) {
    return (
      <div className="channel-readonly-notice">
        <ChannelReadonly />
      </div>
    );
  }

  return (
    <div className="channel-input-area">
      <ChannelInput />
    </div>
  );
}

/** 频道成员项：显示 agent 头像 + 名字 + 当前使用的模型（可点击切换） */
function ChannelAgentMember({ agent }: { agent: any }) {
  const [showModels, setShowModels] = useState(false);
  const [currentModel, setCurrentModel] = useState<string | null>(null);
  const [models, setModels] = useState<any[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 加载 agent 当前模型
  useEffect(() => {
    hanaFetch(`/api/agents/${agent.id}/config`)
      .then(r => r.json())
      .then(d => setCurrentModel(d?.models?.chat || null))
      .catch(() => {});
  }, [agent.id]);

  // 加载可用模型列表
  useEffect(() => {
    if (!showModels) return;
    hanaFetch('/api/models')
      .then(r => r.json())
      .then(d => setModels(d?.models || []))
      .catch(() => {});
  }, [showModels]);

  // 点击外部关闭
  useEffect(() => {
    if (!showModels) return;
    const close = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setShowModels(false);
    };
    const timer = setTimeout(() => document.addEventListener('click', close, true), 0);
    return () => { clearTimeout(timer); document.removeEventListener('click', close, true); };
  }, [showModels]);

  const handleSelectModel = useCallback(async (modelId: string) => {
    setShowModels(false);
    try {
      await hanaFetch(`/api/agents/${agent.id}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ models: { chat: modelId } }),
      });
      setCurrentModel(modelId);
    } catch (err) {
      console.error('[ChannelAgentMember] set model failed:', err);
    }
  }, [agent.id]);

  const modelDisplay = currentModel
    ? currentModel.length > 16 ? currentModel.slice(0, 14) + '…' : currentModel
    : '—';

  return (
    <div ref={wrapRef} style={{ position: 'relative', padding: '4px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <img
          src={agent.hasAvatar ? hanaUrl(`/api/agents/${agent.id}/avatar?t=${Date.now()}`) : yuanFallbackAvatar(agent.yuan)}
          style={{ width: 24, height: 24, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
          onError={e => {
            (e.target as HTMLImageElement).onerror = null;
            (e.target as HTMLImageElement).src = yuanFallbackAvatar(agent.yuan);
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.85rem' }}>{agent.name || agent.id}</div>
          <button
            onClick={() => setShowModels(v => !v)}
            style={{
              fontSize: '0.65rem', color: 'var(--accent, #4ecdc4)', background: 'none', border: 'none',
              cursor: 'pointer', padding: 0, textAlign: 'left', opacity: 0.85,
            }}
            title={t('expert.recommendedModel')}
          >
            ⚡ {modelDisplay}
          </button>
        </div>
      </div>
      {showModels && models.length > 0 && (
        <div style={{
          position: 'absolute', left: 0, right: 0, top: '100%', zIndex: 100,
          background: 'var(--bg-secondary, #2a2a2a)', border: '1px solid var(--border-light, #444)',
          borderRadius: 6, maxHeight: 200, overflowY: 'auto', boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        }}>
          {models.map((m: any) => (
            <div
              key={m.name || m.id}
              onClick={() => handleSelectModel(m.name || m.id)}
              style={{
                padding: '6px 10px', fontSize: '0.75rem', cursor: 'pointer',
                background: (m.name || m.id) === currentModel ? 'var(--overlay-light)' : 'transparent',
              }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--overlay-light)')}
              onMouseLeave={e => (e.currentTarget.style.background = (m.name || m.id) === currentModel ? 'var(--overlay-light)' : 'transparent')}
            >
              {m.name || m.id}
              {m.provider ? <span style={{ opacity: 0.5, marginLeft: 4 }}>({m.provider})</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function JianChannelInfo() {
  const channelInfoName = useStore(s => s.channelInfoName);
  const isDM = useStore(s => s.channelIsDM);
  const channelMembers = useStore(s => s.channelMembers);
  const agents = useStore(s => s.agents);
  const currentAgentId = useStore(s => s.currentAgentId);
  const userName = useStore(s => s.userName);

  if (isDM) {
    const peerId = channelMembers[0] || '';
    const mainAgent = agents.find(a => a.id === currentAgentId);
    const peerAgent = agents.find(a => a.id === peerId || a.name === peerId);
    const dmAgents = [mainAgent, peerAgent].filter(Boolean);
    return (
      <div className="jian-card">
        <div className="channel-info-section">
          <div className="channel-info-label">{t('channel.dmLabel')}</div>
          <div className="channel-members-list">
            {dmAgents.map(a => (
              <div key={a!.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
                <img
                  src={a!.hasAvatar ? hanaUrl(`/api/agents/${a!.id}/avatar?t=${Date.now()}`) : yuanFallbackAvatar(a!.yuan)}
                  style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }}
                  onError={e => {
                    (e.target as HTMLImageElement).onerror = null;
                    (e.target as HTMLImageElement).src = yuanFallbackAvatar(a!.yuan);
                  }}
                />
                <span>{a!.name || a!.id}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // 群聊：只显示用户 + 在 agents 列表中能找到的成员，过滤残留
  const validMembers = channelMembers.filter(id => {
    if (id === 'user' || id === userName) return false; // 用户单独显示
    return agents.some(a => a.id === id || a.name === id);
  });

  return (
    <div className="jian-card">
      <div className="channel-info-section">
        <div className="channel-info-label">{t('channel.info')}</div>
        <div className="channel-info-name">{channelInfoName}</div>
      </div>
      <div className="channel-info-section">
        <div className="channel-info-label">{t('channel.members')}</div>
        <div className="channel-members-list">
          {/* 用户 */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}>
            <span style={{ width: 24, height: 24, borderRadius: '50%', background: 'var(--accent, #4ecdc4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem', color: '#fff', flexShrink: 0 }}>
              {(userName || 'U').charAt(0).toUpperCase()}
            </span>
            <span style={{ fontSize: '0.85rem' }}>{userName || 'user'}</span>
          </div>
          {/* Agent 成员 */}
          {validMembers.map(id => {
            const agent = agents.find(a => a.id === id || a.name === id);
            if (!agent) return null;
            return <ChannelAgentMember key={id} agent={agent} />;
          })}
        </div>
      </div>
    </div>
  );
}

// ── App 根组件 ──

function App() {
  useSidebarResize();
  // 订阅 locale 变化，驱动整棵树重渲染
  useStore(s => s.locale);
  const sidebarOpen = useStore(s => s.sidebarOpen);
  const jianOpen = useStore(s => s.jianOpen);
  const currentTab = useStore(s => s.currentTab);
  const browserRunning = useStore(s => s.browserRunning);
  const welcomeVisible = useStore(s => s.welcomeVisible);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const currentAgentId = useStore(s => s.currentAgentId);
  const currentChannel = useStore(s => s.currentChannel);
  const hasPanels = !welcomeVisible && !!currentSessionPath;
  const { floatCard, show: showFloat, scheduleHide: scheduleFloatHide, cancelHide: cancelFloatHide, hide: hideFloat } = useFloatCard();

  useEffect(() => {
    initApp().catch((err: unknown) => {
      console.error('[init] 初始化异常:', err);
      window.platform?.appReady?.();
    });
  }, []);

  return (
    <ErrorBoundary>
      {/* Headless behavior components */}
      <SidebarLayout />
      <ChannelsPanel />

      {/* ── Titlebar ── */}
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
        <ChannelTabBar />
        <button
          className={`tb-toggle tb-toggle-right${jianOpen ? ' active' : ''}`}
          id="tbToggleRight"
          title={currentTab === 'channels' ? t('channel.info') : t('sidebar.jian')}
          onClick={() => { hideFloat(); toggleJianSidebar(); }}
          onMouseEnter={(e) => showFloat('right', e.currentTarget)}
          onMouseLeave={scheduleFloatHide}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="15" y1="3" x2="15" y2="21"></line>
          </svg>
        </button>
        <WindowControls />
      </div>

      {/* ── App body ── */}
      <div className="app">
        {/* Left sidebar */}
        <aside className={`sidebar${sidebarOpen ? '' : ' collapsed'}`} id="sidebar">
          <div className="sidebar-inner">
            <div className={`sidebar-chat-content${currentTab === 'chat' ? '' : ' hidden'}`}>
              <div className="sidebar-header">
                <span className="sidebar-title">{t('sidebar.title')}</span>
                <div className="sidebar-header-actions">
                  <button className="sidebar-action-btn" id="newSessionBtn" title={t('sidebar.newChat')} onClick={createNewSession}>
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
                  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
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

            {/* 频道 tab 内容 */}
            <div className={`sidebar-channel-content${currentTab === 'channels' ? '' : ' hidden'}`}>
              <ChannelListSidebar />
            </div>
          </div>
          {/* 底部图标栏：Bridge + Activity + Settings */}
          <div className="sidebar-footer-icons">
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
            <SettingsButton />
          </div>
          <div className="resize-handle resize-handle-right" id="sidebarResizeHandle"></div>
        </aside>

        {/* Main content */}
        <MainContent>

          <div className={`chat-area${currentTab === 'chat' ? '' : ' hidden'}${hasPanels ? ' has-panels' : ''}`}>
            <WelcomeContainer />
            <RegionalErrorBoundary region="chat" resetKeys={[currentSessionPath]}>
              <ChatArea />
            </RegionalErrorBoundary>
          </div>

          <div className={`input-area${currentTab === 'chat' ? '' : ' hidden'}`}>
            <RegionalErrorBoundary region="input" resetKeys={[currentSessionPath]}>
              <InputArea />
            </RegionalErrorBoundary>
          </div>

          <div className={`channel-view${currentTab === 'channels' ? ' active' : ''}`}>
            {currentChannel ? (
              <>
                <ChannelHeader />
                <div className="channel-messages">
                  <ChannelMessages />
                </div>
                <ChannelInputArea />
              </>
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                {t('channel.selectHint')}
              </div>
            )}
          </div>

          {/* Floating panels render into main-content */}
          <ActivityPanel />
          <AutomationPanel />
          <BridgePanel />
        </MainContent>

        <PreviewPanel />

        {/* Right sidebar (Jian) */}
        <aside className={`jian-sidebar${jianOpen ? '' : ' collapsed'}`} id="jianSidebar">
          <div className="resize-handle resize-handle-left" id="jianResizeHandle"></div>
          <div className="jian-sidebar-inner">
            <div className={`jian-chat-content${currentTab === 'chat' ? '' : ' hidden'}`}>
              <RegionalErrorBoundary region="desk">
                <DeskSection />
              </RegionalErrorBoundary>
            </div>

            <div className={`jian-channel-content${currentTab === 'channels' ? '' : ' hidden'}`}>
              <JianChannelInfo />
            </div>
          </div>
        </aside>
      </div>

      {/* Connection status */}
      <ConnectionStatus />

      {/* Channel create overlay */}
      <ChannelCreateOverlay />

      {/* Add member overlay */}
      <AddMemberOverlay />

      {/* Skill viewer overlay */}
      <Suspense fallback={null}><SkillViewerOverlay /></Suspense>

      {/* Agent discovery dialog */}
      <AgentDiscoveryDialog />

      {/* Float preview card */}
      {floatCard && (
        <FloatPreviewCard
          state={floatCard}
          onMouseEnter={cancelFloatHide}
          onMouseLeave={scheduleFloatHide}
          onAction={hideFloat}
        />
      )}

      {/* Connection status bar */}
      <StatusBar />

      {/* Confirmation + toast notifications */}
      <ConfirmationDialog />
      <ToastContainer />
    </ErrorBoundary>
  );
}

export default App;
