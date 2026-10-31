import { expect, it, vi } from 'vitest';
import { requestAuthorization } from '../lib/sandbox/tool-wrapper.js';
it('does not reuse a remembered shell grant based only on the working directory', async () => {
  const remembered = { check: vi.fn(() => true), add: vi.fn(() => true) };
  const create = vi.fn(() => ({ confirmId: 'fixture', promise: Promise.resolve({ action: 'rejected' }) }));
  const result = await requestAuthorization({ category: 'delete', identifier: 'rm', command: 'rm /outside/file', reason: 'delete', description: '', path: '/project', trustedRoots: ['/project'], allowlist: remembered, sessionAllowlist: remembered, confirmStore: { create } });
  expect(result.allowed).toBe(false); expect(remembered.check).not.toHaveBeenCalled(); expect(create).toHaveBeenCalledOnce();
});
it('retains scoped reuse for a concrete path operation in its trusted workspace', async () => {
  const remembered = { check: vi.fn(() => true), add: vi.fn(() => true) };
  expect((await requestAuthorization({ category: 'path_write', identifier: '/project/note.md', command: 'write note.md', reason: 'write', description: '', path: '/project/note.md', trustedRoots: ['/project'], sessionAllowlist: remembered })).allowed).toBe(true);
  expect(remembered.check).toHaveBeenCalledOnce();
});
it('treats legacy reusable replies as one-time consent for unscoped shell actions', async () => {
  const remembered = { check: vi.fn(() => false), add: vi.fn(() => true) };
  expect((await requestAuthorization({ category: 'delete', identifier: 'rm', command: 'rm file', reason: 'delete', description: '', path: '/project', trustedRoots: ['/project'], sessionAllowlist: remembered, confirmStore: { create: () => ({ confirmId: 'fixture', promise: Promise.resolve({ action: 'confirmed_session' }) }) } })).allowed).toBe(true);
  expect(remembered.add).not.toHaveBeenCalled();
});
