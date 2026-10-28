// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { ProvidersTab } from './ProvidersTab';
import { useSettingsStore } from '../store';
import { hanaFetch } from '../api';
import { ProviderDetail } from './providers/ProviderDetail';
import { ModelTimeoutSettings } from './ModelTimeoutSettings';
vi.mock('../api', () => ({ hanaFetch: vi.fn() }));
vi.mock('../actions', () => ({ loadSettingsConfig: vi.fn() }));
vi.mock('../helpers', () => ({ t: (key: string) => key, PROVIDER_PRESETS: [] }));
vi.mock('./providers/ProviderDetail', () => ({ ProviderDetail: vi.fn(() => <div>provider-detail-mounted</div>) }));
vi.mock('./ModelTimeoutSettings', () => ({ ModelTimeoutSettings: vi.fn(() => <div>timeouts-mounted</div>) }));
vi.mock('./providers/ProviderList', () => ({ AddCustomButton: () => null }));
const summary = { type: 'api-key' as const, display_name: 'DeepSeek', base_url: 'https://example.com', api: 'openai-completions', api_key: '', models: ['test-model'], custom_models: [], has_credentials: true, supports_oauth: false, can_delete: true };
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  useSettingsStore.setState({ serverPort: null, serverToken: '', selectedProviderId: 'deepseek', providersSummary: { deepseek: summary }, settingsConfig: null });
  vi.mocked(hanaFetch).mockResolvedValue(Response.json({ providers: { deepseek: summary } }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
it('defers every provider form and request until the server connection is ready', async () => {
  await act(async () => root.render(<ProvidersTab />));
  expect(host.textContent).toContain('正在连接设置服务');
  expect(hanaFetch).not.toHaveBeenCalled();
  expect(ProviderDetail).not.toHaveBeenCalled();
  expect(ModelTimeoutSettings).not.toHaveBeenCalled();
  await act(async () => useSettingsStore.setState({ serverPort: 49152, serverToken: 'ready-token' }));
  expect(hanaFetch).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain('provider-detail-mounted');
  expect(host.textContent).toContain('timeouts-mounted');
});
it('unmounts stale forms while reconnecting and initializes them after recovery', async () => {
  await act(async () => root.render(<ProvidersTab />));
  await act(async () => useSettingsStore.setState({ serverPort: 49152, serverToken: 'first-token' }));
  await act(async () => useSettingsStore.setState({ serverPort: null, serverToken: '' }));
  expect(host.textContent).not.toContain('provider-detail-mounted');
  expect(host.textContent).toContain('正在连接设置服务');
  await act(async () => useSettingsStore.setState({ serverPort: 49153, serverToken: 'second-token' }));
  expect(hanaFetch).toHaveBeenCalledTimes(2);
  expect(host.textContent).toContain('provider-detail-mounted');
});
