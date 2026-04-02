import type { ChatListItem } from '../stores/chat-types';

export function findLastAssistantMessageId(items: ChatListItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.type === 'message' && item.data.role === 'assistant') {
      return item.data.id;
    }
  }
  return null;
}
