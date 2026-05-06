import { useStore } from './index';
import type { PromptImage, UserAttachment, GitContext } from './chat-types';
import type { ComposerDraft, QuotedSelection } from './input-slice';
import { ensureSession, showSidebarToast } from './session-actions';
import { getWebSocket } from '../services/websocket';
import { getModeById } from '../config/task-modes';

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
  gitContext?: GitContext | null;
}

function canSendPayload(text: string, images?: PromptImage[]): boolean {
  return text.trim().length > 0 || !!images?.length;
}

function syncOptimisticSessionList(displayText: string, sessionPath: string): void {
  const state = useStore.getState();
  const firstMessage = displayText.trim().slice(0, 100);
  const modified = new Date().toISOString();
  const currentModel = state.currentModel;
  const sessions = [...state.sessions];
  const idx = sessions.findIndex((session) => session.path === sessionPath);
  const nextSession = {
    path: sessionPath,
    title: idx >= 0 ? sessions[idx].title || null : null,
    firstMessage,
    modified,
    messageCount: Math.max((idx >= 0 ? sessions[idx].messageCount : 0) || 0, 1),
    cwd: idx >= 0 ? sessions[idx].cwd ?? state.selectedFolder ?? null : state.selectedFolder ?? null,
    agentId: idx >= 0 ? sessions[idx].agentId ?? state.currentAgentId ?? null : state.currentAgentId ?? null,
    agentName: idx >= 0 ? sessions[idx].agentName ?? state.agentName ?? null : state.agentName ?? null,
    modelId: idx >= 0 ? sessions[idx].modelId ?? currentModel?.id ?? null : currentModel?.id ?? null,
    modelProvider: idx >= 0 ? sessions[idx].modelProvider ?? currentModel?.provider ?? null : currentModel?.provider ?? null,
    labels: idx >= 0 ? sessions[idx].labels ?? [] : [],
  };
  if (idx >= 0) {
    sessions.splice(idx, 1);
  }
  useStore.setState({ sessions: [nextSession, ...sessions] });
}

export async function sendPrompt(options: SendPromptOptions): Promise<boolean> {
  return submitPromptTask({ ...options, mode: options.mode ?? 'prompt' });
}

export async function submitPromptTask(options: SendPromptOptions): Promise<boolean> {
  const mode = options.mode ?? 'prompt';
  const displayText = options.displayText ?? options.text;
  let requestText = options.requestText ?? options.text;

  // ── 任务模式 persona 注入（仅新发 prompt；steer 流中已有上下文，不重复注入）──
  if (mode === 'prompt') {
    const activeModeId = useStore.getState().taskModeId;
    const activeMode = activeModeId ? getModeById(activeModeId) : null;
    const persona = activeMode?.persona;
    if (persona && activeModeId !== 'auto') {
      requestText = `${persona}\n\n${requestText}`;
    }
  }

  if (!canSendPayload(requestText, options.images)) {
    return false;
  }

  const initialState = useStore.getState();
  if (!initialState.serverReady && mode === 'prompt') {
    const stage = initialState.serverStartupStage || 'starting';
    showSidebarToast(window.t?.('chat.serverStarting') ?? `Assistant is still starting (${stage})`, 5000);
    return false;
  }

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
      gitContext: options.gitContext ?? undefined,
      requestText,
      requestImages: options.images,
      retryDraft: options.retryDraft ?? null,
    },
  });
  syncOptimisticSessionList(displayText || requestText, sessionPath);
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
