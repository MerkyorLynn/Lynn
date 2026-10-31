// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { SessionList } from './SessionList';
import { deleteSession } from '../stores/session-actions';

const state = vi.hoisted(() => ({
  sessions: [{ path: '/agents/a/sessions/one.jsonl', title: 'Delete me', messageCount: 2, agentId: 'a', cwd: '/project', modified: '2026-10-14T00:00:00Z' }],
  agents: [], streamingSessions: [], bridgeSessions: [], currentSessionPath: '/agents/a/sessions/one.jsonl', agentName: 'Lynn',
  setPendingConfirm: vi.fn(), setBridgeSessions: vi.fn(),
}));
vi.mock('../stores', () => ({ useStore: Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state }) }));
vi.mock('../hooks/use-hana-fetch', () => ({ hanaFetch: vi.fn(async () => Response.json({ sessions: [] })), hanaUrl: (url: string) => url }));
vi.mock('../hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('../stores/session-actions', () => ({ switchSession: vi.fn(), archiveSession: vi.fn(), deleteSession: vi.fn(), renameSession: vi.fn(), branchSession: vi.fn() }));
vi.mock('../stores/bridge-actions', () => ({ openBridgeSession: vi.fn() }));
vi.mock('../hooks/use-session-body-search', () => ({ useSessionBodySearch: () => ({ snippets: {} }) }));
vi.mock('../utils/agent-helpers', () => ({ yuanFallbackAvatar: () => '' }));

it.each(['contextmenu', 'click'])('offers delete with confirmation from %s menu', async trigger => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  try {
    await act(async () => root.render(<SessionList />));
    const target = trigger === 'click' ? host.querySelector('[title="session.menuTrigger"]')! : host.querySelector('[title="session.menuTrigger"]')!.closest('[data-session-path]')!;
    await act(async () => target.dispatchEvent(new MouseEvent(trigger, { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
    const deleteItem = Array.from(document.querySelectorAll<HTMLElement>('.context-menu-item')).find(item => item.textContent === 'session.delete')!;
    expect(deleteItem).toBeTruthy();
    await act(async () => deleteItem.click());
    expect(deleteSession).not.toHaveBeenCalled();
    const confirmation = state.setPendingConfirm.mock.calls[0][0];
    expect(confirmation).toMatchObject({ title: 'session.delete', tone: 'danger' });
    await act(async () => { confirmation.onConfirm(); });
    expect(deleteSession).toHaveBeenCalledWith('/agents/a/sessions/one.jsonl');
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
});
