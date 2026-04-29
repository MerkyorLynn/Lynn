import { useStore } from './stores';
import { renderMarkdown } from './utils/markdown';
import type { ChatListItem, ChatMessage, ContentBlock } from './stores/chat-types';

type SmokeScenario = 'home' | 'short' | 'tools' | 'long-code';

declare global {
  interface Window {
    __lynnUiSmokeReady?: boolean;
    __lynnUiSmokeScenario?: SmokeScenario;
    __lynnSetUiSmokeScenario?: (scenario: SmokeScenario) => boolean;
  }
}

export function isUiSmokeMode(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('uiSmoke') === '1';
  } catch {
    return false;
  }
}

function textBlock(markdown: string): ContentBlock {
  return { type: 'text', html: renderMarkdown(markdown), plainText: markdown };
}

function userMessage(id: string, text: string): ChatListItem {
  return {
    type: 'message',
    data: {
      id,
      role: 'user',
      text,
      textHtml: renderMarkdown(text),
      requestText: text,
      timestamp: Date.now(),
    },
  };
}

function assistantMessage(id: string, blocks: ContentBlock[]): ChatListItem {
  const data: ChatMessage = {
    id,
    role: 'assistant',
    blocks,
    model: 'ui-smoke-model',
    timestamp: Date.now(),
  };
  return { type: 'message', data };
}

function itemsForScenario(scenario: SmokeScenario): ChatListItem[] {
  if (scenario === 'tools') {
    return [
      userMessage('ui-smoke-tools-user', 'UI_SMOKE_TOOLS：整理工作区并展示工具卡片。'),
      assistantMessage('ui-smoke-tools-assistant', [
        {
          type: 'tool_group',
          collapsed: false,
          tools: [
            {
              name: 'bash',
              args: { command: 'mkdir -p reports && mv draft.md reports/' },
              done: true,
              success: true,
              startedAt: Date.now() - 1200,
              summary: {
                command: 'mkdir -p reports && mv draft.md reports/',
                outputPreview: 'reports/draft.md',
              },
            },
            {
              name: 'write',
              args: { file_path: 'reports/summary.md' },
              done: true,
              success: true,
              startedAt: Date.now() - 800,
              summary: { filePath: 'reports/summary.md', bytesWritten: 842 },
            },
          ],
        },
        {
          type: 'file_diff',
          filePath: 'reports/summary.md',
          diff: [
            '--- a/reports/summary.md',
            '+++ b/reports/summary.md',
            '@@ -1,2 +1,3 @@',
            ' # Summary',
            '-old draft',
            '+整理完成',
            '+UI_SMOKE_TOOL_CARD',
          ].join('\n'),
          linesAdded: 2,
          linesRemoved: 1,
          rollbackId: 'ui-smoke-rollback',
        },
        textBlock('已完成整理，并生成 `reports/summary.md`。UI_SMOKE_TOOL_CARD'),
      ]),
    ];
  }

  if (scenario === 'long-code') {
    return [
      userMessage('ui-smoke-long-user', 'UI_SMOKE_LONG_CODE：生成一段长文和代码块。'),
      assistantMessage('ui-smoke-long-assistant', [
        { type: 'thinking', content: '确认输出包含长段落、列表、代码块和结论。', sealed: true },
        textBlock([
          'UI_SMOKE_LONG_CODE',
          '',
          '下面是一段用于检查长输出排版的内容。它包含多个段落、列表和代码块，目标是验证聊天区滚动、Markdown 渲染、复制按钮、朗读按钮和最后一条消息操作栏不会互相遮挡。',
          '',
          '- 第一项：确认段落宽度正常。',
          '- 第二项：确认列表缩进正常。',
          '- 第三项：确认代码块不会撑破容器。',
          '',
          '```ts',
          'export function calculateTotal(items: Array<{ price: number; count: number }>): number {',
          '  return items.reduce((sum, item) => sum + item.price * item.count, 0);',
          '}',
          '',
          'const total = calculateTotal([',
          '  { price: 12, count: 2 },',
          '  { price: 8, count: 3 },',
          ']);',
          'console.log(total);',
          '```',
          '',
          '最后一段用于确认底部 action rail 仍然可见，且不会覆盖正文。'.repeat(6),
        ].join('\n')),
      ]),
    ];
  }

  return [
    userMessage('ui-smoke-short-user', 'UI_SMOKE_SHORT：用一句话说明你已准备好。'),
    assistantMessage('ui-smoke-short-assistant', [
      textBlock('UI_SMOKE_SHORT_OK：我已准备好，可以继续帮你处理写作、文件、研究和工具任务。'),
    ]),
  ];
}

function applyScenario(scenario: SmokeScenario): void {
  const sessionPath = `/tmp/lynn-ui-smoke-${scenario}.jsonl`;
  const now = new Date().toISOString();
  const isHome = scenario === 'home';

  useStore.setState({
    serverPort: '0',
    serverToken: 'ui-smoke',
    connected: true,
    wsState: 'connected',
    statusKey: 'status.connected',
    statusVars: {},
    currentTab: 'chat',
    activePanel: null,
    locale: 'zh',
    agentName: 'Lynn',
    userName: 'Smoke Tester',
    agentYuan: 'hanako',
    currentModel: { id: 'ui-smoke-model', provider: 'smoke' },
    sidebarOpen: true,
    jianOpen: false,
    welcomeVisible: isHome,
    pendingNewSession: isHome,
    sessionCreationPending: false,
    currentSessionPath: isHome ? null : sessionPath,
    sessions: isHome ? [] : [{
      path: sessionPath,
      title: `UI Smoke · ${scenario}`,
      firstMessage: `UI_SMOKE_${scenario.toUpperCase()}`,
      modified: now,
      messageCount: 2,
      agentId: 'lynn',
      agentName: 'Lynn',
      cwd: '/tmp',
    }],
    chatSessions: isHome ? {} : {
      [sessionPath]: {
        items: itemsForScenario(scenario),
        hasMore: false,
        loadingMore: false,
        oldestId: `ui-smoke-${scenario}-user`,
      },
    },
    streamingSessions: [],
    currentActivity: null,
    serverReady: true,
    serverStartupStage: 'ready',
    serverStartupError: null,
  });

  document.body.dataset.uiSmokeScenario = scenario;
  window.__lynnUiSmokeScenario = scenario;
}

export function installUiSmokeFixture(initialScenario: SmokeScenario = 'home'): void {
  window.__lynnSetUiSmokeScenario = (scenario: SmokeScenario) => {
    applyScenario(scenario);
    return true;
  };
  applyScenario(initialScenario);
  window.__lynnUiSmokeReady = true;
  window.dispatchEvent(new CustomEvent('lynn-ui-smoke-ready', { detail: { scenario: initialScenario } }));
  window.platform?.appReady?.();
}
