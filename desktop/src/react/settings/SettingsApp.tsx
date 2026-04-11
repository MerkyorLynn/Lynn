import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useSettingsStore } from './store';
import { hanaFetch } from './api';
import { t } from './helpers';
import { loadAgents, loadAvatars, loadRuntimeSnapshot, loadSettingsConfig } from './actions';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { WindowControls } from '../components/WindowControls';
import { SettingsNav } from './SettingsNav';
import { Toast } from './Toast';
import { AgentTab } from './tabs/AgentTab';
import { MeTab } from './tabs/MeTab';
import { InterfaceTab } from './tabs/InterfaceTab';
import { WorkTab } from './tabs/WorkTab';
import { SkillsTab } from './tabs/SkillsTab';
import { BridgeTab } from './tabs/BridgeTab';
import { ProvidersTab } from './tabs/ProvidersTab';
import { McpTab } from './tabs/McpTab';
import { AboutTab } from './tabs/AboutTab';
import { PluginsTab } from './tabs/PluginsTab';
import { CropOverlay } from './overlays/CropOverlay';
import { AgentCreateOverlay } from './overlays/AgentCreateOverlay';
import { AgentDeleteOverlay } from './overlays/AgentDeleteOverlay';
import { MemoryViewer } from './overlays/MemoryViewer';
import { CompiledMemoryViewer } from './overlays/CompiledMemoryViewer';
import { ClearMemoryConfirm } from './overlays/ClearMemoryConfirm';
import { BridgeTutorial } from './overlays/BridgeTutorial';
import { WechatQrcodeOverlay } from './overlays/WechatQrcodeOverlay';
import type { SettingsNavigationTarget } from '../types';
import styles from './Settings.module.css';

const platform = window.platform;
const titlebarEl = document.querySelector('.titlebar');

const TAB_COMPONENTS: Record<string, React.ComponentType> = {
  agent: AgentTab,
  me: MeTab,
  interface: InterfaceTab,
  work: WorkTab,
  skills: SkillsTab,
  bridge: BridgeTab,
  providers: ProvidersTab,
  mcp: McpTab,
  // plugins: PluginsTab,  // 暂时隐藏，等社区插件开放后启用
  about: AboutTab,
};

const SETTINGS_ACTIVE_TAB_KEY = 'hana-settings-active-tab';
function readPersistedSettingsUi(): { activeTab?: string } {
  try {
    const activeTab = localStorage.getItem(SETTINGS_ACTIVE_TAB_KEY);
    return {
      activeTab: activeTab && TAB_COMPONENTS[activeTab] ? activeTab : undefined,
    };
  } catch {
    return {};
  }
}

function persistSettingsUi(activeTab: string) {
  try {
    if (TAB_COMPONENTS[activeTab]) {
      localStorage.setItem(SETTINGS_ACTIVE_TAB_KEY, activeTab);
    }
    localStorage.removeItem('hana-settings-provider');
  } catch {
    // ignore persistence failures
  }
}

function normalizeNavigationTarget(target?: string | SettingsNavigationTarget | null): SettingsNavigationTarget | null {
  if (!target) return null;
  if (typeof target === 'string') {
    return TAB_COMPONENTS[target] ? { tab: target } : null;
  }
  const next: SettingsNavigationTarget = {};
  if (target.tab && TAB_COMPONENTS[target.tab]) next.tab = target.tab;
  if ('providerId' in target) next.providerId = target.providerId ?? null;
  if (target.resetProviderSelection) next.resetProviderSelection = true;
  if ('agentId' in target) next.agentId = target.agentId ?? null;
  if (target.resetAgentSelection) next.resetAgentSelection = true;
  if ('reviewerKind' in target) next.reviewerKind = target.reviewerKind ?? null;
  return Object.keys(next).length > 0 ? next : null;
}

function applyNavigationTarget(target?: string | SettingsNavigationTarget | null) {
  const normalized = normalizeNavigationTarget(target);
  if (!normalized) return false;
  const nextState: Record<string, string | null> = {};
  if (normalized.tab) nextState.activeTab = normalized.tab;
  if ('providerId' in normalized) {
    nextState.selectedProviderId = normalized.providerId ?? null;
  } else if (normalized.resetProviderSelection) {
    nextState.selectedProviderId = null;
  }
  if ('agentId' in normalized) {
    nextState.settingsAgentId = normalized.agentId ?? null;
  } else if (normalized.resetAgentSelection) {
    nextState.settingsAgentId = null;
  }
  if ('reviewerKind' in normalized) {
    nextState.pendingReviewerKind = normalized.reviewerKind ?? null;
  }
  useSettingsStore.setState(nextState);
  return true;
}

async function refreshSettingsSurface(opts: {
  runtime?: boolean;
  agents?: boolean;
  avatars?: boolean;
  config?: boolean;
} = {}) {
  const {
    runtime = true,
    agents = true,
    avatars = false,
    config = true,
  } = opts;
  // Phase 1: runtime + agents 必须先完成（设置 currentAgentId），config 依赖它
  const phase1: Promise<unknown>[] = [];
  if (runtime) phase1.push(loadRuntimeSnapshot());
  if (agents) phase1.push(loadAgents());
  if (avatars) phase1.push(loadAvatars());
  await Promise.allSettled(phase1);
  // Phase 2: config 依赖 agentId，必须在 phase1 之后
  if (config) await loadSettingsConfig().catch(() => {});
}

export function SettingsApp() {
  const { activeTab, ready, selectedProviderId, settingsAgentId } = useSettingsStore();
  const [uiRestored, setUiRestored] = React.useState(false);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | void;

    const boot = async () => {
      const restored = readPersistedSettingsUi();
      if (restored.activeTab) {
        useSettingsStore.setState(restored);
      }

      try {
        const target = await platform?.getInitialSettingsNavigationTarget?.();
        if (!disposed) applyNavigationTarget(target);
      } catch {
        // ignore initial navigation failures
      }

      if (disposed) return;
      unsubscribe = platform?.onSwitchTab?.((target: string | SettingsNavigationTarget) => {
        applyNavigationTarget(target);
      });

      setUiRestored(true);
      initSettings();
    };

    void boot();

    return () => {
      disposed = true;
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!uiRestored) return;
    persistSettingsUi(activeTab);
  }, [activeTab, selectedProviderId, uiRestored]);

  useEffect(() => {
    if (!ready || !settingsAgentId) return;
    loadSettingsConfig().catch((err) => console.warn('[settings] reload for target agent failed:', err));
  }, [ready, settingsAgentId]);

  // Server 重启后用新端口重新加载数据
  useEffect(() => {
    if (!platform?.onServerRestarted) return;
    platform.onServerRestarted((data: { port: number; token: string }) => {
      const store = useSettingsStore.getState();
      console.log('[settings] server restarted, new port:', data.port);
      store.set({ serverPort: data.port, serverToken: data.token });
      void refreshSettingsSurface();
    });
  }, []);

  useEffect(() => {
    const unsubscribe: (() => void) | void = platform?.onSettingsChanged?.((type: string, data: any) => {
      switch (type) {
        case 'agent-switched':
          useSettingsStore.setState({
            settingsAgentId: null,
            currentAgentId: data?.agentId || null,
          });
          void refreshSettingsSurface({ avatars: true });
          break;
        case 'agent-created':
        case 'agent-deleted':
          void refreshSettingsSurface({ config: false });
          break;
        case 'agent-updated':
          void refreshSettingsSurface({ avatars: true });
          break;
        case 'models-changed':
        case 'desk-config-changed':
          void refreshSettingsSurface({ agents: false });
          break;
        case 'skills-changed':
          window.dispatchEvent(new CustomEvent('settings-skills-changed', { detail: data || null }));
          break;
        case 'review-config-changed':
          void refreshSettingsSurface({ agents: false, config: false });
          window.dispatchEvent(new CustomEvent('review-config-changed', { detail: data || null }));
          break;
        case 'locale-changed':
          void refreshSettingsSurface({ agents: false, avatars: false, config: false });
          break;
        default:
          break;
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, []);

  const ActiveTab = TAB_COMPONENTS[activeTab] || AgentTab;

  return (
    <ErrorBoundary region="settings">
      <div className="settings-panel" id="settingsPanel">
        <div className="settings-header">
          <h1 className={styles['settings-title']}>{t('settings.title')}</h1>
        </div>
        <div className={styles['settings-body']}>
          <SettingsNav />
          <div className={styles['settings-main']}>
            <ErrorBoundary region={activeTab}>
              <ActiveTab />
            </ErrorBoundary>
          </div>
        </div>
      </div>

      <Toast />
      <CropOverlay />
      <AgentCreateOverlay />
      <AgentDeleteOverlay />
      <MemoryViewer />
      <CompiledMemoryViewer />
      <ClearMemoryConfirm />
      <BridgeTutorial />
      <WechatQrcodeOverlay />

      {!ready && (
        <div className="settings-loading-mask" id="settingsLoadingMask">
          <div style={{ position: 'absolute', bottom: '24px', left: 0, right: 0, textAlign: 'center', color: 'var(--text-muted, #aaa)', fontSize: '12px', opacity: 0.6 }}>
            loading...
          </div>
        </div>
      )}

      {titlebarEl && createPortal(<WindowControls />, titlebarEl)}
    </ErrorBoundary>
  );
}

async function initSettings() {
  const store = useSettingsStore.getState();

  const timeout = setTimeout(() => {
    if (!store.ready) {
      console.warn('[settings] init timeout (15s), forcing ready');
      store.set({ ready: true });
    }
  }, 15_000);

  try {
    const serverPort = Number(await platform.getServerPort());
    const serverToken = await platform.getServerToken();
    store.set({ serverPort, serverToken });

    const i18n = window.i18n;
    try {
      const cfgRes = await hanaFetch('/api/config');
      const cfg = await cfgRes.json();
      const locale = cfg.locale || 'zh-CN';
      await i18n.load(locale);
    } catch {
      try { await i18n.load('zh-CN'); } catch { /* i18n fallback failed, continue */ }
    }

    await refreshSettingsSurface({ avatars: true });

    store.set({ ready: true });
  } catch (err) {
    console.error('[settings] init failed:', err);
    store.set({ ready: true });
  } finally {
    clearTimeout(timeout);
  }
}
