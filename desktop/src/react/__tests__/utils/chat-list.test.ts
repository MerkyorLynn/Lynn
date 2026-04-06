import { describe, expect, it } from 'vitest';
import { findLastAssistantMessageId } from '../../utils/chat-list';
import type { ChatListItem } from '../../stores/chat-types';

describe('chat-list', () => {
  it('returns the latest assistant message id', () => {
    const items: ChatListItem[] = [
      { type: 'message', data: { id: 'u1', role: 'user', text: 'hello' } },
      { type: 'message', data: { id: 'a1', role: 'assistant', blocks: [] } },
      { type: 'message', data: { id: 'u2', role: 'user', text: 'again' } },
      { type: 'message', data: { id: 'a2', role: 'assistant', blocks: [] } },
    ];

    expect(findLastAssistantMessageId(items)).toBe('a2');
  });

  it('returns null when no assistant message exists', () => {
    const items: ChatListItem[] = [
      { type: 'message', data: { id: 'u1', role: 'user', text: 'hello' } },
    ];

    expect(findLastAssistantMessageId(items)).toBeNull();
  });
});
