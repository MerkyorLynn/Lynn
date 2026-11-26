import { useCallback, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useStore } from '../../stores';
import type { ContentBlock } from '../../stores/chat-types';
import { ensureSession, showSidebarToast } from '../../stores/session-actions';
import { isChineseLocale } from '../../utils/locale';
import {
  DEEP_RESEARCH_FETCH_TIMEOUT_MS,
  DEEP_RESEARCH_TIMEOUT_MS,
  formatDeepResearchAssistantText,
  normalizeDeepResearchArtifact,
  normalizeDeepResearchErrorMessage,
  type DeepResearchArtifact,
} from './deep-research';

interface DeepResearchModelInfo {
  id?: string;
  name?: string;
  provider?: string;
}

interface UseDeepResearchRunnerArgs {
  activeModelInfo: DeepResearchModelInfo | null;
  composerText: string;
  deepResearchBusy: boolean;
  inputValue: string;
  isStreaming: boolean;
  localQwenEndpoint?: string;
  locale?: string;
  pendingNewSession: boolean;
  requestInputFocus: () => void;
  serverReady: boolean;
  setComposerText: (value: string) => void;
  setDeepResearchBusy: (value: boolean) => void;
  setDeepResearchOpen: (value: boolean) => void;
  setInlineError: (value: string | null) => void;
  setInlineNotice: (value: string | null) => void;
  setInputValue: (value: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

async function renderAssistantText(plainText: string): Promise<ContentBlock[]> {
  const { renderMarkdown } = await import('../../utils/markdown');
  return [{ type: 'text' as const, html: renderMarkdown(plainText), plainText }];
}

async function patchLocalAssistantMessage(
  sessionPath: string,
  messageId: string,
  plainText: string,
  artifact?: DeepResearchArtifact | null,
  locale?: string | null,
) {
  const blocks = await renderAssistantText(plainText);
  const normalizedArtifact = normalizeDeepResearchArtifact(artifact, locale);
  const nextBlocks: ContentBlock[] = normalizedArtifact
    ? [
      ...blocks,
      {
        type: 'artifact',
        artifactId: normalizedArtifact.artifactId,
        artifactType: normalizedArtifact.artifactType,
        title: normalizedArtifact.title,
        content: normalizedArtifact.content,
        language: normalizedArtifact.language,
      },
    ]
    : blocks;
  useStore.setState((state) => {
    const session = state.chatSessions[sessionPath];
    if (!session) return {};
    return {
      chatSessions: {
        ...state.chatSessions,
        [sessionPath]: {
          ...session,
          items: session.items.map((item) => {
            if (item.type !== 'message' || item.data.id !== messageId) return item;
            return {
              type: 'message' as const,
              data: {
                ...item.data,
                text: plainText,
                blocks: nextBlocks,
              },
            };
          }),
        },
      },
    };
  });
}

export function useDeepResearchRunner({
  activeModelInfo,
  composerText,
  deepResearchBusy,
  inputValue,
  isStreaming,
  localQwenEndpoint,
  locale,
  pendingNewSession,
  requestInputFocus,
  serverReady,
  setComposerText,
  setDeepResearchBusy,
  setDeepResearchOpen,
  setInlineError,
  setInlineNotice,
  setInputValue,
  t,
  textareaRef,
}: UseDeepResearchRunnerArgs) {
  return useCallback(async () => {
    const latestPromptValue = textareaRef.current?.value ?? useStore.getState().composerText ?? inputValue;
    if (latestPromptValue !== inputValue) setInputValue(latestPromptValue);
    if (latestPromptValue !== composerText) setComposerText(latestPromptValue);
    const prompt = latestPromptValue.trim();
    setDeepResearchOpen(true);
    if (!prompt) {
      const zh = isChineseLocale(locale);
      useStore.getState().addToast?.(
        zh ? '先输入一个调研问题，再点“开始深研”' : 'Type a research question first, then tap "Start research"',
        'info',
        3200,
        { dedupeKey: 'deep-research-empty' },
      );
      requestInputFocus();
      return;
    }
    if (deepResearchBusy || isStreaming) return;
    if (!serverReady) {
      showSidebarToast(t('chat.serverStarting') || 'Lynn is still starting up', 4000);
      return;
    }

    const zh = isChineseLocale(locale);
    const selectedProvider = String(activeModelInfo?.provider || '').trim();
    const selectedModel = String(activeModelInfo?.id || '').trim();
    const selectedModelLabel = String(activeModelInfo?.name || selectedModel || (zh ? '当前模型' : 'current model')).trim();
    const useLocalDeepResearch = /^local-qwen35-/u.test(selectedProvider);
    const useDefaultBrainDeepResearch = selectedProvider === 'brain';
    flushSync(() => {
      setDeepResearchBusy(true);
      setInlineNotice(zh
        ? `深研已启动：正在使用 ${selectedModelLabel} 生成答案…`
        : `Deep research started: generating with ${selectedModelLabel}…`);
      setInlineError(null);
    });
    try {
      if (pendingNewSession && !useStore.getState().selectedFolder && useStore.getState().homeFolder) {
        useStore.setState({ selectedFolder: useStore.getState().homeFolder });
      }
      if (useStore.getState().pendingNewSession) {
        const ok = await ensureSession();
        if (!ok) throw new Error(zh ? '无法创建新会话' : 'Could not create a new session');
      }
      const sessionPath = useStore.getState().currentSessionPath;
      if (!sessionPath) throw new Error(zh ? '当前没有可用会话' : 'No usable session right now');

      const renderMarkdown = (await import('../../utils/markdown')).renderMarkdown;
      const now = Date.now();
      const userId = `deep-user-${now}`;
      const assistantId = `deep-assistant-${now}`;
      const thinkingText = zh
        ? `深度调研正在使用 ${selectedModelLabel}。`
        : `Deep research is using ${selectedModelLabel}.`;
      const thinkingBlocks = await renderAssistantText(thinkingText);
      const session = useStore.getState().chatSessions[sessionPath];
      if (!session) {
        useStore.getState().initSession(sessionPath, [], false);
      }
      flushSync(() => {
        useStore.getState().appendItem(sessionPath, {
          type: 'message',
          data: {
            id: userId,
            role: 'user',
            taskMode: 'prompt',
            text: prompt,
            textHtml: renderMarkdown(prompt),
            requestText: prompt,
          },
        });
        useStore.getState().appendItem(sessionPath, {
          type: 'message',
          data: {
            id: assistantId,
            role: 'assistant',
            text: thinkingText,
            blocks: thinkingBlocks,
            model: zh ? '深度调研' : 'Deep research',
            timestamp: now,
          },
        });
        setComposerText('');
        setInputValue('');
        setDeepResearchOpen(false);
        useStore.setState({ welcomeVisible: false });
      });

      const response = await hanaFetch('/api/deep-research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeout: DEEP_RESEARCH_FETCH_TIMEOUT_MS,
        body: JSON.stringify({
          prompt,
          sessionPath,
          candidates: useLocalDeepResearch
            ? [selectedProvider]
            : undefined,
          provider: selectedProvider || undefined,
          model: selectedModel || undefined,
          sourceLabel: useDefaultBrainDeepResearch
            ? (zh ? '默认工作模型' : 'default work model')
            : selectedModelLabel,
          localBaseUrl: useLocalDeepResearch ? localQwenEndpoint : undefined,
          timeoutMs: DEEP_RESEARCH_TIMEOUT_MS,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || (zh
          ? `深度调研请求失败 (${response.status})`
          : `Deep research request failed (${response.status})`));
      }

      await patchLocalAssistantMessage(
        sessionPath,
        assistantId,
        formatDeepResearchAssistantText(data, locale),
        data?.artifact,
        locale,
      );
      setInlineNotice(null);
    } catch (err) {
      const message = normalizeDeepResearchErrorMessage(err, locale);
      const sessionPath = useStore.getState().currentSessionPath;
      const session = sessionPath ? useStore.getState().chatSessions[sessionPath] : null;
      const lastAssistant = session?.items.slice().reverse().find(
        (item) => item.type === 'message' && item.data.role === 'assistant' && item.data.id.startsWith('deep-assistant-'),
      );
      if (sessionPath && lastAssistant?.type === 'message') {
        await patchLocalAssistantMessage(
          sessionPath,
          lastAssistant.data.id,
          (zh ? '深度调研启动失败：' : 'Deep research failed to start: ') + message,
          undefined,
          locale,
        );
      } else {
        useStore.getState().addToast?.(
          (zh ? '深度调研启动失败：' : 'Deep research failed to start: ') + message,
          'error',
          5000,
        );
      }
      setInlineNotice(null);
    } finally {
      setDeepResearchBusy(false);
    }
  }, [
    activeModelInfo?.id,
    activeModelInfo?.name,
    activeModelInfo?.provider,
    composerText,
    deepResearchBusy,
    inputValue,
    isStreaming,
    localQwenEndpoint,
    locale,
    pendingNewSession,
    requestInputFocus,
    serverReady,
    setComposerText,
    setDeepResearchBusy,
    setDeepResearchOpen,
    setInlineError,
    setInlineNotice,
    setInputValue,
    t,
    textareaRef,
  ]);
}
