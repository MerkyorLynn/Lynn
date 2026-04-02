import { useStore } from './index';
import type { PromptImage, UserAttachment } from './chat-types';
import type { ComposerDraft, QuotedSelection } from './input-slice';
import { ensureSession, showSidebarToast } from './session-actions';
import { getWebSocket } from '../services/websocket';

export interface SendPromptOptions {
  mode?: 'prompt' | 'steer';
  text: string;
  displayText?: string;
  requestText?: string;
  quotedText?: string;
  quotedSelection?: QuotedSelection | null;
  retryDraft?: ComposerDraft | null;
  attachments?: UserAttachment[];
  images?: PromptImage[];
}

function canSendPayload(text: string, images?: PromptImage[]): boolean {
  return text.trim().length > 0 || !!images?.length;
}

export async function sendPrompt(options: SendPromptOptions): Promise<boolean> {
  return submitPromptTask({ ...options, mode: options.mode ?? 'prompt' });
}

export async function submitPromptTask(options: SendPromptOptions): Promise<boolean> {
  const mode = options.mode ?? 'prompt';
  const displayText = options.displayText ?? options.text;
  const requestText = options.requestText ?? options.text;

  if (!canSendPayload(requestText, options.images)) {
    return false;
  }

  const initialState = useStore.getState();
  if (initialState.isStreaming && mode === 'prompt') {
    return false;
  }

  if (initialState.pendingNewSession && !initialState.selectedFolder && initialState.homeFolder) {
    useStore.setState({ selectedFolder: initialState.homeFolder });
  }

  if (mode === 'prompt' && useStore.getState().pendingNewSession) {
    const ok = await ensureSession();
    if (!ok) return false;
  }

  const sessionPath = useStore.getState().currentSessionPath;
  const ws = getWebSocket();
  if (!sessionPath || !ws || ws.readyState !== WebSocket.OPEN) {
    showSidebarToast(window.t?.('chat.needWsConnection') ?? 'Disconnected from assistant', 5000);
    return false;
  }

  const textHtml = displayText
    ? (await import('../utils/markdown')).renderMarkdown(displayText)
    : undefined;

  useStore.getState().appendItem(sessionPath, {
    type: 'message',
    data: {
      id: `user-${Date.now()}`,
      role: 'user',
      taskMode: mode,
      text: displayText || undefined,
      textHtml,
      quotedText: options.quotedText,
      quotedSelection: options.quotedSelection ?? null,
      attachments: options.attachments,
      requestText,
      requestImages: options.images,
      retryDraft: options.retryDraft ?? null,
    },
  });
  useStore.setState({ welcomeVisible: false });

  if (mode === 'steer') {
    ws.send(JSON.stringify({ type: 'steer', text: requestText, sessionPath }));
    return true;
  }

  return resendPromptRequest(requestText, options.images, sessionPath);
}

export function resendPromptRequest(requestText: string, images?: PromptImage[], sessionPath?: string | null): boolean {
  if (!canSendPayload(requestText, images)) {
    return false;
  }

  const state = useStore.getState();
  if (state.isStreaming) {
    return false;
  }

  const targetSession = sessionPath ?? state.currentSessionPath;
  const ws = getWebSocket();
  if (!targetSession || !ws || ws.readyState !== WebSocket.OPEN) {
    showSidebarToast(window.t?.('chat.needWsConnection') ?? 'Disconnected from assistant', 5000);
    return false;
  }

  const payload: Record<string, unknown> = {
    type: 'prompt',
    text: requestText,
    sessionPath: targetSession,
  };
  if (images?.length) {
    payload.images = images;
  }
  ws.send(JSON.stringify(payload));
  return true;
}
