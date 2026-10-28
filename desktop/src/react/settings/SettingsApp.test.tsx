// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { useSettingsStore } from './store';
import { hanaFetch } from './api';
import { AgentTab } from './tabs/AgentTab';
import { ProvidersTab } from './tabs/ProvidersTab';
vi.mock('./api', () => ({ hanaFetch: vi.fn() }));
vi.mock('./helpers', () => ({ t: (key: string) => key }));
vi.mock('./actions', () => ({ loadAgents: vi.fn(async () => {}), loadAvatars: vi.fn(async () => {}), loadRuntimeSnapshot: vi.fn(async () => {}), loadSettingsConfig: vi.fn(async () => {}) }));
vi.mock('./SettingsNav', () => ({ SettingsNav: () => null }));
vi.mock('./Toast', () => ({ Toast: () => null }));
vi.mock('./tabs/AgentTab', () => ({ AgentTab: vi.fn(() => <div>agent-tab-mounted</div>) }));
vi.mock('./tabs/ProvidersTab', () => ({ ProvidersTab: vi.fn(() => <div>provider-tab-mounted</div>) }));
vi.mock('./tabs/MeTab', () => ({ MeTab: () => null }));
vi.mock('./tabs/InterfaceTab', () => ({ InterfaceTab: () => null }));
vi.mock('./tabs/WorkTab', () => ({ WorkTab: () => null }));
vi.mock('./tabs/SkillsTab', () => ({ SkillsTab: () => null }));
vi.mock('./tabs/BridgeTab', () => ({ BridgeTab: () => null }));
vi.mock('./tabs/McpTab', () => ({ McpTab: () => null }));
vi.mock('./tabs/AboutTab', () => ({ AboutTab: () => null }));
vi.mock('./tabs/PluginsTab', () => ({ PluginsTab: () => null }));
vi.mock('./tabs/VoiceTab', () => ({ VoiceTab: () => null }));
vi.mock('./overlays/CropOverlay', () => ({ CropOverlay: () => null }));
vi.mock('./overlays/AgentCreateOverlay', () => ({ AgentCreateOverlay: () => null }));
vi.mock('./overlays/AgentDeleteOverlay', () => ({ AgentDeleteOverlay: () => null }));
vi.mock('./overlays/MemoryViewer', () => ({ MemoryViewer: () => null }));
vi.mock('./overlays/CompiledMemoryViewer', () => ({ CompiledMemoryViewer: () => null }));
vi.mock('./overlays/ClearMemoryConfirm', () => ({ ClearMemoryConfirm: () => null }));
vi.mock('./overlays/BridgeTutorial', () => ({ BridgeTutorial: () => null }));
vi.mock('./overlays/WechatQrcodeOverlay', () => ({ WechatQrcodeOverlay: () => null }));

const bridge = { getInitialSettingsNavigationTarget: vi.fn(), getServerPort: vi.fn(), getServerToken: vi.fn(async () => 'test-token') };
Object.assign(window, { platform: bridge, i18n: { load: vi.fn(async () => {}) } });
const { SettingsApp } = await import('./SettingsApp');
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.clearAllMocks(); localStorage.clear();
  useSettingsStore.setState({ activeTab: 'agent', ready: false, serverPort: null, serverToken: '', settingsAgentId: null });
  vi.mocked(hanaFetch).mockResolvedValue(Response.json({ locale: 'zh-CN' }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it('does not mount the default tab while the initial navigation target is pending', async () => {
  const nav=deferred<{tab:string}>(),port=deferred<number>();bridge.getInitialSettingsNavigationTarget.mockReturnValue(nav.promise);bridge.getServerPort.mockReturnValue(port.promise);
  await act(async () => root.render(<SettingsApp />));
  const premature=vi.mocked(AgentTab).mock.calls.length;
  await act(async () => nav.resolve({ tab: 'providers' }));
  const beforePort=vi.mocked(ProvidersTab).mock.calls.length;
  await act(async () => port.resolve(49152));
  expect(premature).toBe(0);expect(beforePort).toBe(0);expect(host.textContent).toContain('provider-tab-mounted');expect(AgentTab).not.toHaveBeenCalled();
});
it('does not mount providers until the service address and initialization are ready', async () => {
  const port=deferred<number>();bridge.getInitialSettingsNavigationTarget.mockResolvedValue({tab:'providers'});bridge.getServerPort.mockReturnValue(port.promise);
  await act(async () => root.render(<SettingsApp />));const early=vi.mocked(ProvidersTab).mock.calls.length;
  await act(async () => port.resolve(49153));expect(early).toBe(0);expect(host.textContent).toContain('provider-tab-mounted');
});
it('keeps tabs unmounted if a readiness timeout fires before a valid service port exists', async () => {
  const port=deferred<number>();bridge.getInitialSettingsNavigationTarget.mockResolvedValue({tab:'providers'});bridge.getServerPort.mockReturnValue(port.promise);
  await act(async () => root.render(<SettingsApp />));await act(async () => useSettingsStore.setState({ready:true}));const early=vi.mocked(ProvidersTab).mock.calls.length;
  await act(async () => port.resolve(49154));expect(early).toBe(0);expect(host.textContent).toContain('provider-tab-mounted');
});
