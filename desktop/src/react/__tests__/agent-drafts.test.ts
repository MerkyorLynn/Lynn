import { expect, it, vi } from 'vitest';
function storage() {
  const map = new Map<string, string>();
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, removeItem: (key: string) => { map.delete(key); } };
}
const draft = { name: 'Draft name', identity: 'Unsaved identity', ishiki: 'Unsaved instructions', experience: '[{"name":"work","entries":["unsaved fact"]}]', yuan: 'hanako', nameTouched: true };
it('restores unsaved fields after the settings module is recreated', async () => {
  const target = storage();
  const before = await import('../settings/agent-drafts');
  expect(before.saveAgentDraft('restart-case', draft, target)).toBe(true);
  vi.resetModules();
  const reopened = await import('../settings/agent-drafts');
  expect(reopened.loadAgentDraft('restart-case', target)).toEqual(draft);
  reopened.clearAgentDraft('restart-case', target);
  expect(reopened.loadAgentDraft('restart-case', target)).toBeUndefined();
});
it('keeps agents separate and reports a failed durable save without dropping the in-memory draft', async () => {
  const api = await import('../settings/agent-drafts');
  const target = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem() {} };
  expect(api.saveAgentDraft('quota-case', draft, target)).toBe(false);
  expect(api.loadAgentDraft('quota-case', target)).toEqual(draft);
  expect(api.loadAgentDraft('another-agent', target)).toBeUndefined();
});
it('rejects corrupted experience state before rendering it', async () => {
  const target = storage(); target.setItem('lynn-settings-agent-draft-v1:bad-case', JSON.stringify({ ...draft, experience: '[{"name":"bad","entries":[null]}]' }));
  const api = await import('../settings/agent-drafts');
  expect(api.loadAgentDraft('bad-case', target)).toBeUndefined();
});
