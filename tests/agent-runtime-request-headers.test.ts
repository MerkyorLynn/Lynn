import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createLynnAgentSession } from '../core/agent-runtime/create-session.js';
import { SessionManager } from '../core/agent-runtime/session-manager.js';
import { signClientAgentRequest } from '../shared/client-agent-identity.js';
let cwd: string;
beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'lynn-header-test-')); });
afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(cwd, { recursive: true, force: true }); });
const model = { id: 'fixture', provider: 'fixture', api: 'openai-completions', baseUrl: 'https://first.example/v1', apiKey: 'fixture-key', contextWindow: 4096, maxTokens: 100 } as any;
function response() {
  return new Response('data: {"choices":[{"delta":{"content":"The requested operation is complete."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
it('refreshes device timestamps and nonces for every request in one session', async () => {
  const sent: Headers[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => { sent.push(new Headers(init.headers)); return response(); }));
  const getRequestHeaders = vi.fn(() => signClientAgentRequest({ agentKey: 'fixture-device-key', secret: 'a'.repeat(64), method: 'POST', pathname: '/chat/completions' }));
  const { session } = await createLynnAgentSession({ cwd, model, tools: [], customTools: [], sessionManager: SessionManager.create(cwd, cwd), getRequestHeaders });
  await session.prompt('Say a complete sentence.');
  await session.prompt('Say another complete sentence.');
  expect(sent).toHaveLength(2);
  expect(getRequestHeaders).toHaveBeenCalledTimes(2);
  expect(sent[0].get('x-lynn-nonce')).toBeTruthy();
  expect(sent[1].get('x-lynn-nonce')).not.toBe(sent[0].get('x-lynn-nonce'));
  expect(sent[1].get('x-lynn-signature')).not.toBe(sent[0].get('x-lynn-signature'));
});
it('does not forward the original endpoint credentials to a different origin', async () => {
  const sent: Headers[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => { sent.push(new Headers(init.headers)); return response(); }));
  const { session } = await createLynnAgentSession({ cwd, model, tools: [], customTools: [], sessionManager: SessionManager.create(cwd, cwd), requestHeaders: { authorization: 'Bearer original-fixture', 'x-private-header': 'original-fixture' } });
  await session.prompt('Say a complete sentence.');
  session.setModel({ ...model, baseUrl: 'https://second.example/v1', apiKey: 'second-fixture' });
  await session.prompt('Say another complete sentence.');
  expect(sent[0].get('x-private-header')).toBe('original-fixture');
  expect(sent[1].get('x-private-header')).toBeNull();
  expect(sent[1].get('authorization')).toBe('Bearer second-fixture');
});
