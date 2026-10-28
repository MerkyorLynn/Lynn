// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ModelTimeoutSettings } from './ModelTimeoutSettings';
import { hanaFetch } from '../api';
import { useSettingsStore } from '../store';
import { modelTimeoutDiagnostics } from '../../../../../core/agent-runtime/model-call-timeouts.js';

vi.mock('../api', () => ({ hanaFetch: vi.fn() }));
let host: HTMLDivElement;
let root: Root;
const configured = { firstChunkMs: 300_000, idleMs: 120_000, totalMs: 0 };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  useSettingsStore.setState({ serverPort: 8791, serverToken: 'test-token' });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.mocked(hanaFetch).mockResolvedValue(Response.json({ configured, effective: { ...configured, idleMs: 180_000 }, brainEffective: configured, diagnostics: modelTimeoutDiagnostics(configured) }));
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it('shows saved seconds and effective env overrides and persists edited milliseconds', async () => {
  await act(async () => root.render(<ModelTimeoutSettings />));
  const inputs = host.querySelectorAll('input');
  expect(Array.from(inputs).map(input => input.value)).toEqual(['300', '120', '0']);
  expect(host.textContent).toContain('300 / 180 / 0');
  expect(host.querySelector('details')?.textContent).toContain('cliBrainHeaders');
  expect(host.querySelector('details')?.textContent).toContain('preferences.model_call_timeouts');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(inputs[0], '600');
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
  });
  vi.mocked(hanaFetch).mockResolvedValueOnce(Response.json({ configured: { ...configured, firstChunkMs: 600_000 }, effective: configured, brainEffective: configured }));
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  const request = vi.mocked(hanaFetch).mock.calls.find(([, options]) => options?.method === 'PUT')!;
  expect(JSON.parse(String(request[1]?.body))).toEqual({ ...configured, firstChunkMs: 600_000 });
  expect(host.querySelector('[role="status"]')?.textContent).toContain('已保存');
});

it('does not claim save success on server failure', async () => {
  await act(async () => root.render(<ModelTimeoutSettings />));
  vi.mocked(hanaFetch).mockResolvedValueOnce(Response.json({ error: 'Disk full' }, { status: 500 }));
  await act(async () => host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(host.querySelector('[role="status"]')?.textContent).toBe('Disk full');
  expect(host.textContent).not.toContain('已保存');
});

it('waits for Settings bootstrap when opened directly on the models tab', async () => {
  useSettingsStore.setState({ serverPort: null, serverToken: '' });
  await act(async () => root.render(<ModelTimeoutSettings />));
  expect(hanaFetch).not.toHaveBeenCalled();
  expect(host.querySelector('button')!.disabled).toBe(true);
  await act(async () => useSettingsStore.setState({ serverPort: 8792, serverToken: 'ready-token' }));
  expect(hanaFetch).toHaveBeenCalledTimes(1);
  expect(host.querySelector('button')!.disabled).toBe(false);
  expect(host.textContent).toContain('300 / 180 / 0');
  expect(host.textContent).not.toContain('settings server is not ready');
});

it('reloads after a server restart and ignores a response from the old connection', async () => {
  let finishOld!: (response: Response) => void;
  vi.mocked(hanaFetch).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
  await act(async () => root.render(<ModelTimeoutSettings />));
  const newer = { ...configured, firstChunkMs: 600_000 };
  vi.mocked(hanaFetch).mockResolvedValueOnce(Response.json({ configured: newer, effective: newer, brainEffective: newer }));
  await act(async () => useSettingsStore.setState({ serverPort: 8793, serverToken: 'new-token' }));
  expect(hanaFetch).toHaveBeenCalledTimes(2);
  await act(async () => finishOld(Response.json({ configured, effective: configured, brainEffective: configured })));
  expect(host.querySelector('input')!.value).toBe('600');
  expect(host.querySelector('button')!.disabled).toBe(false);
});

it('ignores an old save after the server credentials change', async () => {
  await act(async () => root.render(<ModelTimeoutSettings />));
  let finishSave!: (response: Response) => void;
  vi.mocked(hanaFetch).mockImplementationOnce(() => new Promise(resolve => { finishSave = resolve; }));
  await act(async () => { host.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  const newer = { ...configured, firstChunkMs: 900_000 };
  vi.mocked(hanaFetch).mockResolvedValueOnce(Response.json({ configured: newer, effective: newer, brainEffective: newer }));
  await act(async () => useSettingsStore.setState({ serverToken: 'rotated-token' }));
  await act(async () => finishSave(Response.json({ configured, effective: configured, brainEffective: configured })));
  expect(host.querySelector('input')!.value).toBe('900');
  expect(host.querySelector('button')!.disabled).toBe(false);
  expect(host.textContent).not.toContain('已保存');
});
