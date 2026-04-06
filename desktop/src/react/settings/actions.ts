/**
 * Settings shared actions — extracted from SettingsApp to avoid circular imports
 */
import { useSettingsStore } from './store';
import { hanaFetch, hanaUrl } from './api';
import { t } from './helpers';

const platform = window.platform;
const BUILT_IN_AGENT_IDS = new Set(['lynn', 'hanako', 'butter']);

async function getWorkspaceDefaults() {
  try {
    return await platform?.getOnboardingDefaults?.();
  } catch {
    return null;
  }
}

export async function loadAgents() {
  const store = useSettingsStore.getState();
  try {
    const res = await hanaFetch('/api/agents');
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const allAgents = data.agents || [];
    const requestedSettingsAgentId = store.settingsAgentId;
    const effectiveSettingsAgentId = requestedSettingsAgentId
      && allAgents.some((agent: any) => agent.id === requestedSettingsAgentId)
      ? requestedSettingsAgentId
      : null;
    // 设置页默认只显示普通助手；内部 reviewer 仅在被显式导航时保留。
    const agents = allAgents.filter((a: any) => {
      if (a.tier === 'expert') return false;
      if (a.tier === 'reviewer') {
        if (BUILT_IN_AGENT_IDS.has(a.id)) return true;
        return a.id === effectiveSettingsAgentId;
      }
      return true;
    });
    let currentAgentId = store.currentAgentId;
    const hasCurrentAgent = currentAgentId
      && allAgents.some((agent: any) => agent.id === currentAgentId);
    if (!hasCurrentAgent) {
      const primary = agents.find((a: any) => a.isPrimary) || agents[0];
      currentAgentId = primary?.id || null;
    }
    const currentAgent = allAgents.find((a: any) => a.id === currentAgentId) || agents.find((a: any) => a.id === currentAgentId);
    store.set({
      agents,
      currentAgentId,
      settingsAgentId: effectiveSettingsAgentId,
      agentYuan: currentAgent?.yuan || store.agentYuan,
      agentName: currentAgent?.name || store.agentName,
    });
  } catch (err) {
    console.error('[agents] load failed:', err);
  }
}

export async function loadRuntimeSnapshot() {
  const store = useSettingsStore.getState();
  try {
    const res = await hanaFetch('/api/app-state');
    const data = await res.json();
    const defaults = await getWorkspaceDefaults();
    const fallbackTrustedRoots = Array.isArray(defaults?.trustedRoots) ? defaults.trustedRoots : [];
    const preferredProviderId = data?.model?.preferredProviderId || null;
    const nextSelectedProviderId = store.selectedProviderId || preferredProviderId || null;
    store.set({
      currentAgentId: data?.agent?.currentAgentId || store.currentAgentId,
      agentName: data?.agent?.name || store.agentName,
      agentYuan: data?.agent?.yuan || store.agentYuan,
      preferredProviderId,
      selectedProviderId: nextSelectedProviderId,
      homeFolder: data?.desk?.homeFolder || store.homeFolder || defaults?.workspacePath || null,
      trustedRoots: Array.isArray(data?.desk?.trustedRoots) && data.desk.trustedRoots.length > 0
        ? data.desk.trustedRoots
        : (Array.isArray(store.trustedRoots) && store.trustedRoots.length > 0 ? store.trustedRoots : fallbackTrustedRoots),
    });
  } catch (err) {
    console.warn('[settings] runtime snapshot load failed:', err);
  }
}

export async function loadAvatars() {
  const ts = Date.now();
  const store = useSettingsStore.getState();
  try {
    const res = await hanaFetch('/api/health');
    const data = await res.json();
    const avatars = data.avatars || {};
    for (const role of ['agent', 'user']) {
      if (avatars[role]) {
        const url = hanaUrl(`/api/avatar/${role}?t=${ts}`);
        if (role === 'agent') store.set({ agentAvatarUrl: url });
        else store.set({ userAvatarUrl: url });
      } else {
        if (role === 'agent') store.set({ agentAvatarUrl: null });
        else store.set({ userAvatarUrl: null });
      }
    }
  } catch {}
}

export async function loadSettingsConfig() {
  const store = useSettingsStore.getState();
  try {
    const requestedAgentId = store.getSettingsAgentId();
    const agentId = requestedAgentId || store.currentAgentId || store.agents[0]?.id || null;
    if (!agentId) return;
    if (store.settingsAgentId && store.settingsAgentId !== agentId) {
      store.set({ settingsAgentId: agentId === store.currentAgentId ? null : agentId });
    }
    const defaults = await getWorkspaceDefaults();
    const agentBase = `/api/agents/${agentId}`;
    const [configRes, globalConfigRes, identityRes, ishikiRes, publicIshikiRes, userProfileRes, pinnedRes, globalModelsRes, experienceRes] =
      await Promise.all([
        hanaFetch(`${agentBase}/config`),
        hanaFetch('/api/config'),
        hanaFetch(`${agentBase}/identity`),
        hanaFetch(`${agentBase}/ishiki`),
        hanaFetch(`${agentBase}/public-ishiki`),
        hanaFetch('/api/user-profile'),
        hanaFetch(`${agentBase}/pinned`),
        hanaFetch('/api/preferences/models'),
        hanaFetch(`${agentBase}/experience`),
      ]);

    const config = await configRes.json();
    const globalConfig = await globalConfigRes.json();
    const globalModels = await globalModelsRes.json();
    const identityData = await identityRes.json();
    config._identity = identityData.content || '';
    const ishikiData = await ishikiRes.json();
    config._ishiki = ishikiData.content || '';
    const publicIshikiData = await publicIshikiRes.json();
    config._publicIshiki = publicIshikiData.content || '';
    const userProfileData = await userProfileRes.json();
    config._userProfile = userProfileData.content || '';
    const pinnedData = await pinnedRes.json();
    const experienceData = await experienceRes.json();
    config._experience = experienceData.content || '';

    const globalDesk = globalConfig?.desk || {};
    const effectiveHomeFolder = globalDesk.home_folder || config.desk?.home_folder || store.homeFolder || defaults?.workspacePath || null;
    const effectiveTrustedRoots = Array.isArray(globalDesk.trusted_roots) && globalDesk.trusted_roots.length > 0
      ? globalDesk.trusted_roots
      : Array.isArray(config.desk?.trusted_roots) && config.desk.trusted_roots.length > 0
        ? config.desk.trusted_roots
      : Array.isArray(store.trustedRoots)
        ? (store.trustedRoots.length > 0 ? store.trustedRoots : (Array.isArray(defaults?.trustedRoots) ? defaults.trustedRoots : []))
        : (Array.isArray(defaults?.trustedRoots) ? defaults.trustedRoots : []);
    config.desk = {
      ...(config.desk || {}),
      home_folder: effectiveHomeFolder || '',
      trusted_roots: effectiveTrustedRoots,
    };

    store.set({
      settingsConfig: config,
      settingsConfigAgentId: agentId,
      globalModelsConfig: globalModels,
      homeFolder: effectiveHomeFolder,
      trustedRoots: effectiveTrustedRoots,
      currentPins: pinnedData.pins || [],
    });
  } catch (err) {
    console.error('[settings] load failed:', err);
  }
}

export async function browseAgent(agentId: string) {
  await loadAgents();
  useSettingsStore.setState({
    settingsAgentId: agentId,
    selectedProviderId: null,
    settingsConfig: null,
    settingsConfigAgentId: null,
  });
  await loadSettingsConfig();
  await loadAgents();
}

export async function switchToAgent(agentId: string) {
  const store = useSettingsStore.getState();
  try {
    const res = await hanaFetch('/api/agents/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: agentId }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    store.set({
      settingsAgentId: null,
      selectedProviderId: null,
      settingsConfig: null,
      settingsConfigAgentId: null,
      currentAgentId: data.agent.id,
      agentName: data.agent.name,
    });
    platform?.settingsChanged?.('agent-switched', {
      agentName: data.agent.name,
      agentId: data.agent.id,
    });
    await loadSettingsConfig();
    await loadAgents();
    store.showToast(t('settings.agent.switched', { name: data.agent.name }), 'success');
  } catch (err: any) {
    store.showToast(t('settings.agent.switchFailed') + ': ' + err.message, 'error');
  }
}
