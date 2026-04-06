import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState: Record<string, any> = {
  isStreaming: false,
  pendingNewSession: false,
  sessionCreationPending: false,
  selectedFolder: null,
  homeFolder: '/Users/lynn',
  currentSessionPath: '/sessions/current',
  currentAgentId: 'lynn',
  agentName: 'Lynn',
  currentModel: null,
  sessions: [],
  welcomeVisible: true,
  appended: [],
  appendItem: vi.fn((sessionPath: string, item: unknown) => {
    mockState.appended.push({ sessionPath, item });
  }),
  addToast: vi.fn(),
};

const setState = vi.fn((patch: Record<string, unknown>) => {
  Object.assign(mockState, patch);
});

const ensureSession = vi.fn();
const renderMarkdown = vi.fn(async (text: string) => `<p>${text}</p>`);
let websocketRef: { readyState: number; send: ReturnType<typeof vi.fn> } | null = null;

vi.mock('../../stores', () => ({
  useStore: {
    getState: () => mockState,
    setState,
  },
}));

vi.mock('../../stores/session-actions', () => ({
  ensureSession,
  showSidebarToast: (text: string, duration = 3000, type = 'info', dedupeKey?: string) => {
    mockState.addToast(text, type, duration, dedupeKey ? { dedupeKey } : undefined);
  },
}));

vi.mock('../../services/websocket', () => ({
  getWebSocket: () => websocketRef,
}));

vi.mock('../../utils/markdown', () => ({
  renderMarkdown,
}));

describe('prompt-actions', () => {
  beforeEach(() => {
    mockState.isStreaming = false;
    mockState.pendingNewSession = false;
    mockState.sessionCreationPending = false;
    mockState.selectedFolder = null;
    mockState.homeFolder = '/Users/lynn';
    mockState.currentSessionPath = '/sessions/current';
    mockState.currentAgentId = 'lynn';
    mockState.agentName = 'Lynn';
    mockState.currentModel = null;
    mockState.sessions = [];
    mockState.welcomeVisible = true;
    mockState.appended = [];
    mockState.appendItem.mockClear();
    mockState.addToast.mockClear();
    setState.mockClear();
    ensureSession.mockReset();
    ensureSession.mockResolvedValue(true);
    renderMarkdown.mockClear();
    websocketRef = { readyState: 1, send: vi.fn() };
    vi.stubGlobal('WebSocket', { OPEN: 1 });
    vi.stubGlobal('window', {
      t: vi.fn((key: string) => key),
    });
  });

  it('sendPrompt 默认按 prompt 发送', async () => {
    const { sendPrompt } = await import('../../stores/prompt-actions');

    const sent = await sendPrompt({ text: 'hello' });

    expect(sent).toBe(true);
    expect(mockState.appendItem).toHaveBeenCalledOnce();
    const appended = mockState.appended[0].item.data;
    expect(appended.taskMode).toBe('prompt');
    expect(websocketRef?.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'prompt',
      text: 'hello',
      sessionPath: '/sessions/current',
    }));
  });

  it('submitPromptTask 在流式中阻止新的 prompt', async () => {
    mockState.isStreaming = true;
    const { submitPromptTask } = await import('../../stores/prompt-actions');

    const sent = await submitPromptTask({ mode: 'prompt', text: '继续' });

    expect(sent).toBe(false);
    expect(mockState.appendItem).not.toHaveBeenCalled();
    expect(websocketRef?.send).not.toHaveBeenCalled();
  });

  it('submitPromptTask 在流式中允许 steer 并发送 steer 事件', async () => {
    mockState.isStreaming = true;
    const { submitPromptTask } = await import('../../stores/prompt-actions');

    const sent = await submitPromptTask({ mode: 'steer', text: '只补最后一步' });

    expect(sent).toBe(true);
    expect(mockState.appendItem).toHaveBeenCalledOnce();
    expect(websocketRef?.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'steer',
      text: '只补最后一步',
      sessionPath: '/sessions/current',
    }));
  });

  it('pending new session 时先回填 homeFolder 并 ensureSession', async () => {
    mockState.pendingNewSession = true;
    const { submitPromptTask } = await import('../../stores/prompt-actions');

    const sent = await submitPromptTask({ mode: 'prompt', text: '新会话第一条' });

    expect(sent).toBe(true);
    expect(setState).toHaveBeenCalledWith({ selectedFolder: '/Users/lynn' });
    expect(ensureSession).toHaveBeenCalledOnce();
  });

  it('append user message 时保留 gitContext 摘要', async () => {
    const { submitPromptTask } = await import('../../stores/prompt-actions');

    await submitPromptTask({
      mode: 'prompt',
      text: '显示文本',
      requestText: '真实请求',
      gitContext: { repoName: 'openhanako', branch: 'main', changedCount: 4 },
    });

    const appended = mockState.appended[0].item.data;
    expect(appended.gitContext).toEqual({ repoName: 'openhanako', branch: 'main', changedCount: 4 });
    expect(websocketRef?.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'prompt',
      text: '真实请求',
      sessionPath: '/sessions/current',
    }));
  });

  it('append user message 时保留 requestText、images 和 retryDraft', async () => {
    const { submitPromptTask } = await import('../../stores/prompt-actions');
    const retryDraft = {
      text: 'draft',
      attachedFiles: [{ path: '/repo/a.ts', name: 'a.ts' }],
      quotedSelection: null,
      docContextFile: null,
      workingSet: [{ path: '/repo/a.ts', name: 'a.ts', source: 'recent' as const }],
    };

    await submitPromptTask({
      mode: 'prompt',
      text: '显示文本',
      displayText: '显示文本',
      requestText: '真实请求',
      attachments: [{ path: '/repo/a.ts', name: 'a.ts', isDir: false }],
      images: [{ type: 'image', data: 'abc', mimeType: 'image/png' }],
      retryDraft,
    });

    const appended = mockState.appended[0].item.data;
    expect(appended).toMatchObject({
      role: 'user',
      taskMode: 'prompt',
      text: '显示文本',
      requestText: '真实请求',
      requestImages: [{ type: 'image', data: 'abc', mimeType: 'image/png' }],
      retryDraft,
    });
    expect(appended.attachments).toEqual([{ path: '/repo/a.ts', name: 'a.ts', isDir: false }]);
    expect(renderMarkdown).toHaveBeenCalledWith('显示文本');
    expect(setState).toHaveBeenCalledWith({ welcomeVisible: false });
  });

  it('首条用户消息会乐观加入侧边栏 session 列表', async () => {
    mockState.sessions = [];
    mockState.currentSessionPath = '/sessions/new';
    const { submitPromptTask } = await import('../../stores/prompt-actions');

    await submitPromptTask({
      mode: 'prompt',
      text: '帮我检查 App.tsx',
    });

    const sessionPatch = setState.mock.calls.find(
      ([patch]) => Array.isArray((patch as { sessions?: unknown[] }).sessions),
    )?.[0] as { sessions: Array<Record<string, unknown>> } | undefined;
    expect(sessionPatch?.sessions?.[0]).toMatchObject({
      path: '/sessions/new',
      firstMessage: '帮我检查 App.tsx',
      agentId: 'lynn',
      agentName: 'Lynn',
      messageCount: 1,
    });
  });

  it('resendPromptRequest 在空内容或 streaming 时阻止发送', async () => {
    const { resendPromptRequest } = await import('../../stores/prompt-actions');

    expect(resendPromptRequest('   ')).toBe(false);

    mockState.isStreaming = true;
    expect(resendPromptRequest('hello')).toBe(false);
    expect(websocketRef?.send).not.toHaveBeenCalled();
  });

  it('resendPromptRequest 断开连接时提示 toast', async () => {
    websocketRef = { readyState: 0, send: vi.fn() };
    const { resendPromptRequest } = await import('../../stores/prompt-actions');

    const sent = resendPromptRequest('hello');

    expect(sent).toBe(false);
    expect(mockState.addToast).toHaveBeenCalledWith('chat.needWsConnection', 'info', 5000, undefined);
  });
});
