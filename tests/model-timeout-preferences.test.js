import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PreferencesManager } from '../core/preferences-manager.js';
import { createPreferencesRoute } from '../server/routes/preferences.js';
import { readModelCallTimeouts } from '../core/agent-runtime/model-call-timeouts.js';

let directory;
let prefs;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lynn-timeout-prefs-'));
  vi.stubEnv('LYNN_HOME', directory);
  prefs = new PreferencesManager({ userDir: path.join(directory, 'user'), agentsDir: path.join(directory, 'agents') });
  prefs.savePreferences({ locale: 'en' });
});
afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); vi.unstubAllEnvs(); });

it('persists settings across restart, preserves unrelated preferences, and runtime rereads edits', async () => {
  const route = createPreferencesRoute(prefs);
  const configured = { firstChunkMs: 600_000, idleMs: 180_000, totalMs: 0 };
  const response = await route.request('/preferences/model-timeouts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(configured) });
  expect(response.status).toBe(200);
  expect(readModelCallTimeouts()).toEqual(configured);
  const restarted = new PreferencesManager({ userDir: path.join(directory, 'user'), agentsDir: path.join(directory, 'agents') });
  expect(restarted.getPreferences()).toEqual({ locale: 'en', model_call_timeouts: configured });
  vi.stubEnv('LYNN_MODEL_IDLE_TIMEOUT_MS', '250000');
  const data = await (await createPreferencesRoute(restarted).request('/preferences/model-timeouts')).json();
  expect(data.configured.idleMs).toBe(180_000);
  expect(data.effective.idleMs).toBe(250_000);
  expect(data.diagnostics.model.sources.idleMs).toBe('LYNN_MODEL_IDLE_TIMEOUT_MS');
  expect(data.diagnostics.model.sources.firstChunkMs).toBe('preferences.model_call_timeouts');
  expect(data.diagnostics.localQwen.effective).toEqual(data.effective);
  expect(data.diagnostics.cliBrainHeaders.withoutFallback.timeoutMs).toBe(5000);
  prefs.savePreferences({ ...prefs.getPreferences(), model_call_timeouts: { ...configured, idleMs: 200_000 } });
  expect(readModelCallTimeouts().idleMs).toBe(200_000);
});

it('keeps the previous in-memory and persisted settings when disk writing fails', async () => {
  const write = fs.writeFileSync.bind(fs);
  const failure = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, ...args) => {
    if (String(file).includes('preferences.json.') && String(file).endsWith('.tmp')) throw new Error('simulated disk failure');
    return write(file, ...args);
  });
  const response = await createPreferencesRoute(prefs).request('/preferences/model-timeouts', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstChunkMs: 600_000, idleMs: 120_000, totalMs: 0 }),
  });
  expect(response.status).toBe(500);
  expect(prefs.getPreferences()).toEqual({ locale: 'en' });
  expect(readModelCallTimeouts().firstChunkMs).toBe(600_000);
  failure.mockRestore();
});

it('exposes actual Brain, bridge, headers and turn sources without secrets', async () => {
  vi.stubEnv('LYNN_MODEL_TOTAL_TIMEOUT_MS', '0');
  vi.stubEnv('LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS', '45000');
  vi.stubEnv('LYNN_CLI_BRAIN_TIMEOUT_MS', '90000');
  vi.stubEnv('LYNN_TURN_HARD_ABORT_MS', '600000');
  vi.stubEnv('LYNN_FALLBACK_MODEL_CALL_TIMEOUT_MS', '70000');
  const data = await (await createPreferencesRoute(prefs).request('/preferences/model-timeouts')).json();
  expect(data.diagnostics.model.sources.firstChunkMs).toBe('default');
  expect(data.diagnostics.localQwen.effective.totalMs).toBe(0);
  expect(data.diagnostics.brain.effective.totalMs).toBe(45000);
  expect(data.diagnostics.brain.sources.totalMs).toBe('LYNN_BRAIN_MODEL_CALL_TIMEOUT_MS');
  expect(data.diagnostics.cliBrainHeaders.withFallback).toEqual({ timeoutMs: 30000, source: 'LYNN_CLI_BRAIN_TIMEOUT_MS' });
  expect(data.diagnostics.turn).toEqual({ timeoutMs: 600000, source: 'LYNN_TURN_HARD_ABORT_MS' });
  expect(data.diagnostics.fallbackFinalization.timeoutMs).toBe(70000);
});

it.each([
  {}, [], null,
  { firstChunkMs: 0, idleMs: 100, totalMs: 0 },
  { firstChunkMs: 100, idleMs: -1, totalMs: 0 },
  { firstChunkMs: 100, idleMs: 100, totalMs: -1 },
  { firstChunkMs: 2147483648, idleMs: 100, totalMs: 0 },
  { firstChunkMs: '100', idleMs: 100, totalMs: 0 },
  { firstChunkMs: 1.5, idleMs: 100, totalMs: 0 },
])('rejects invalid settings %j without writing', async body => {
  const response = await createPreferencesRoute(prefs).request('/preferences/model-timeouts', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  expect(response.status).toBe(400);
  expect(prefs.getPreferences()).toEqual({ locale: 'en' });
});
