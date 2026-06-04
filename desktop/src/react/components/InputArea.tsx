/**
 * InputArea — 聊天输入区域 React 组件
 *
 * 子组件拆分到 ./input/ 目录。
 * 斜杠命令逻辑在 ./input/slash-commands.ts。
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useStore } from '../stores';
import { useI18n } from '../hooks/use-i18n';
import { showSidebarToast } from '../stores/session-actions';
import { getWebSocket, manualReconnect } from '../services/websocket';
import { sendPrompt, submitPromptTask } from '../stores/prompt-actions';
import { ComposerTextarea } from './input/ComposerTextarea';
import { SubmitArea } from './input/SubmitArea';
import { DeepResearchLauncher } from './input/DeepResearchLauncher';
import { InputStatusBars } from './input/InputStatusBars';
import { InputDiscoveryHints } from './input/InputDiscoveryHints';
import { InputContextOverlays } from './input/InputContextOverlays';
import { JARVIS_RUNTIME_START_EVENT } from '../services/jarvis-runtime-events';
import { loadModels } from '../utils/ui-helpers';
import {
  XING_PROMPT, executeDiary, executeCompact, executeClear, executePlan, executeSave, buildSlashCommands,
  buildTaskModeSlashCommands,
  type SlashCommand,
} from './input/slash-commands';
import {
  useDeepResearchRunner,
} from './input/useDeepResearchRunner';
import { useLocalQwenStatusController } from './input/useLocalQwenStatusController';
import {
  formatVisionUnsupportedMessage,
  modelDisplayName,
  modelSupportsVision,
} from './input/multimodal-guard';
import { useAttachmentHandlers } from './input/useAttachmentHandlers';
import { useInputEventBridge } from './input/useInputEventBridge';
import { usePlaceholderRotation } from './input/usePlaceholderRotation';
import { useGitContext } from './input/useGitContext';
import { useConfiguredThinkingLevel } from './input/useConfiguredThinkingLevel';
import { useTextareaAutoResize } from './input/useTextareaAutoResize';
import { detectInlineFileSuggestion } from './input/file-context-suggestions';
import { computeComposerTextUpdate, type ComposerInsertMode } from './input/composer-text';
import {
  fileToWorkingSet,
  getComposerSessionKey,
} from '../utils/composer-state';
import {
  prepareComposerTask,
  type ComposerTaskMode,
} from '../utils/prompt-task';
import { resolveUiI18nText } from '../utils/ui-i18n';
import styles from './input/InputArea.module.css';

export type { SlashCommand };

export function InputArea() {
  return <InputAreaInner />;
}

function InputAreaInner() {
  const { t } = useI18n();

  const isStreaming = useStore(s => s.isStreaming);
  const connected = useStore(s => s.connected);
  const serverReady = useStore(s => s.serverReady);
  const serverStartupStage = useStore(s => s.serverStartupStage);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const selectedFolder = useStore(s => s.selectedFolder);
  const homeFolder = useStore(s => s.homeFolder);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const composerSessionKey = getComposerSessionKey(currentSessionPath, pendingNewSession);
  const compacting = useStore(s => currentSessionPath ? s.compactingSessions.includes(currentSessionPath) : false);
  const inlineNotice = useStore(s => s.inlineNotice);
  const inlineError = useStore(s => s.inlineError);
  const wsState = useStore(s => s.wsState);
  const wsReconnectAttempt = useStore(s => s.wsReconnectAttempt);
  const recoverableDraft = useStore(s => s.lastSubmittedDrafts[composerSessionKey] || null);
  const todosBySession = useStore(s => s.todosBySession);
  const sessionTodos = (todosBySession && currentSessionPath && todosBySession[currentSessionPath]) || [];
  const attachedFiles = useStore(s => s.attachedFiles);
  const quotedSelection = useStore(s => s.quotedSelection);
  const models = useStore(s => s.models);
  const currentModelRef = useStore(s => s.currentModel);
  const agentYuan = useStore(s => s.agentYuan);
  const thinkingLevel = useStore(s => s.thinkingLevel);
  const setThinkingLevel = useStore(s => s.setThinkingLevel);
  const composerText = useStore(s => s.composerText);
  const setComposerText = useStore(s => s.setComposerText);
  const saveComposerDraft = useStore(s => s.saveComposerDraft);
  const restoreComposerDraft = useStore(s => s.restoreComposerDraft);
  const restoreLastSubmittedDraft = useStore(s => s.restoreLastSubmittedDraft);
  const clearComposerState = useStore(s => s.clearComposerState);
  const setLastSubmittedDraft = useStore(s => s.setLastSubmittedDraft);
  const setInlineNotice = useStore(s => s.setInlineNotice);
  const setInlineError = useStore(s => s.setInlineError);
  const workingSetRecentFiles = useStore(s => s.workingSetRecentFiles);
  const rememberWorkingSetFile = useStore(s => s.rememberWorkingSetFile);
  const deskBasePath = useStore(s => s.deskBasePath);
  const deskCurrentPath = useStore(s => s.deskCurrentPath);
  const taskSnapshot = useStore(s => s.taskSnapshot);
  const setActivePanel = useStore(s => s.setActivePanel);
  const setPendingConfirm = useStore(s => s.setPendingConfirm);

  const effectiveModels = useMemo(() => {
    if (!currentModelRef?.id) return models;
    if (models.some(m => m.isCurrent)) return models;
    const sameModel = (m: { id?: string; provider?: string }) =>
      m.id === currentModelRef.id && (m.provider || '') === (currentModelRef.provider || '');
    if (models.some(sameModel)) {
      return models.map(m => sameModel(m) ? { ...m, isCurrent: true } : m);
    }
    const isDefaultBrain = currentModelRef.provider === 'brain' && currentModelRef.id === 'lynn-brain-router';
    return [
      {
        id: currentModelRef.id,
        provider: currentModelRef.provider,
        name: isDefaultBrain ? '默认模型' : currentModelRef.id,
        isCurrent: true,
        reasoning: true,
        contextWindow: isDefaultBrain ? 128000 : undefined,
        maxTokens: isDefaultBrain ? 8192 : undefined,
      },
      ...models,
    ];
  }, [currentModelRef, models]);
  const currentModelInfo = useMemo(() => effectiveModels.find(m => m.isCurrent), [effectiveModels]);
  const activeModelInfo = currentModelInfo || (effectiveModels.length > 0 ? effectiveModels[0] : null);
  const selectorModels = effectiveModels;
  const noModelsAtAll = selectorModels.length === 0;
  const showModelConfigHint = noModelsAtAll || (models.length <= 1 && !currentModelRef?.id);
  const supportsVision = modelSupportsVision(activeModelInfo);
  const warnVisionUnsupported = useCallback(() => {
    const modelLabel = modelDisplayName(activeModelInfo);
    const locale = String((window as { i18n?: { locale?: string } }).i18n?.locale || '');
    const message = formatVisionUnsupportedMessage(modelLabel, locale);
    showSidebarToast(message, 6500, 'warning', 'vision-unsupported-image');
    setInlineNotice(message);
  }, [activeModelInfo, setInlineNotice]);
  const translatedInlineNotice = useMemo(() => {
    if (!inlineNotice) return null;
    return resolveUiI18nText(inlineNotice);
  }, [inlineNotice]);

  const [sending, setSending] = useState(false);
  const [slashMenuOpen, setSlashMenuOpen] = useState(false);
  const [slashSelected, setSlashSelected] = useState(0);
  const [slashBusy, setSlashBusy] = useState<string | null>(null);
  const [slashResult, setSlashResult] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [atMenuOpen, setAtMenuOpen] = useState(false);
  const [atQuery, setAtQuery] = useState('');
  const [atSelected, setAtSelected] = useState(0);
  const [atResults, setAtResults] = useState<Array<{ name: string; path: string; rel: string; isDir: boolean }>>([]);
  const gitContext = useGitContext({ deskBasePath, deskCurrentPath, pendingNewSession, selectedFolder });
  const [inputValue, setInputValue] = useState(composerText);
  const [deepResearchOpen, setDeepResearchOpen] = useState(false);
  const [deepResearchBusy, setDeepResearchBusy] = useState(false);
  const [showAtDiscovery, setShowAtDiscovery] = useState(() => {
    try {
      return !localStorage.getItem('hana-at-discovery-seen');
    } catch {
      return true;
    }
  });
  const [atInlineHintSeen, setAtInlineHintSeen] = useState(() => {
    try {
      return Number(localStorage.getItem('hana-at-inline-hint-seen') || '0');
    } catch {
      return 0;
    }
  });
  const inputLineCount = useMemo(() => {
    if (!inputValue) return 0;
    return inputValue.split(/\r\n|\n|\r/).length;
  }, [inputValue]);
  const inputLargeSummary = useMemo(() => {
    const charCount = inputValue.trim().length;
    if (charCount < 1200 && inputLineCount < 9) return null;
    const displayChars = charCount >= 10000 ? `${(charCount / 10000).toFixed(1)} 万字` : `${charCount} 字`;
    return `${inputLineCount} 行 · ${displayChars}`;
  }, [inputLineCount, inputValue]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposing = useRef(false);
  const skipNextDraftSaveRef = useRef(true);

  const inputFocusTrigger = useStore(s => s.inputFocusTrigger);
  const requestInputFocus = useStore(s => s.requestInputFocus);
  const localQwen = useLocalQwenStatusController({
    models,
    currentModelInfo,
    statusClassNames: {
      base: styles['local-model-status-bar'],
      muted: styles['local-model-status-bar-muted'],
      busy: styles['local-model-status-bar-busy'],
    },
    requestInputFocus,
    setInlineError,
    setInlineNotice,
  });
  const localQwenEndpoint = localQwen.endpoint;
  const localQwenRunning = localQwen.running;
  const localQwenLoading = localQwen.loading;
  const ensureCurrentLocalQwenReady = localQwen.ensureCurrentReady;

  useEffect(() => {
    if (inputFocusTrigger > 0) textareaRef.current?.focus();
  }, [inputFocusTrigger]);

  useEffect(() => {
    if (!serverReady || models.length > 0) return;
    void loadModels();
    const retry = window.setTimeout(() => {
      if (useStore.getState().models.length === 0) {
        void loadModels();
      }
    }, 1500);
    return () => window.clearTimeout(retry);
  }, [models.length, serverReady]);

  useEffect(() => {
    if (isComposing.current) return;
    setInputValue(composerText);
  }, [composerText]);

  const addAttachedFile = useStore(s => s.addAttachedFile);
  const removeAttachedFile = useStore(s => s.removeAttachedFile);
  const clearQuotedSelection = useStore(s => s.clearQuotedSelection);

  useEffect(() => {
    skipNextDraftSaveRef.current = true;
    restoreComposerDraft(composerSessionKey);
  }, [composerSessionKey, restoreComposerDraft]);

  useEffect(() => {
    if (skipNextDraftSaveRef.current) {
      skipNextDraftSaveRef.current = false;
      return;
    }
    saveComposerDraft(composerSessionKey);
  }, [composerSessionKey, composerText, attachedFiles, quotedSelection, workingSetRecentFiles, saveComposerDraft]);

  const sendAsUser = useCallback(async (text: string, displayText?: string): Promise<boolean> => {
    if (pendingNewSession && !useStore.getState().selectedFolder && useStore.getState().homeFolder) {
      useStore.setState({ selectedFolder: useStore.getState().homeFolder });
    }
    return sendPrompt({ text, displayText });
  }, [pendingNewSession]);

  const handleDeepResearchRun = useDeepResearchRunner({
    activeModelInfo,
    composerText,
    deepResearchBusy,
    inputValue,
    isStreaming,
    localQwenEndpoint,
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
  });

  const showSlashResult = useCallback((text: string, type: 'success' | 'error') => {
    setSlashBusy(null);
    setSlashResult({ text, type });
    setTimeout(() => setSlashResult(null), 3000);
  }, []);

  const diaryFn = useMemo(
    () => executeDiary(t, showSlashResult, setSlashBusy, setComposerText, setSlashMenuOpen),
    [setComposerText, showSlashResult, t],
  );
  const xingFn = useCallback(async () => {
    setComposerText('');
    setSlashMenuOpen(false);
    await sendAsUser(XING_PROMPT);
  }, [sendAsUser, setComposerText]);
  const compactFn = useMemo(
    () => executeCompact(setSlashBusy, setComposerText, setSlashMenuOpen),
    [setComposerText],
  );
  const clearFn = useMemo(
    () => executeClear(t, showSlashResult, setSlashBusy, setComposerText, setSlashMenuOpen),
    [setComposerText, showSlashResult, t],
  );
  const planFn = useMemo(
    () => executePlan(setSlashBusy, setComposerText, setSlashMenuOpen),
    [setComposerText],
  );
  const saveFn = useMemo(
    () => executeSave(t, showSlashResult, setSlashBusy, setComposerText, setSlashMenuOpen),
    [setComposerText, showSlashResult, t],
  );
  const fillSlashInput = useCallback((text: string) => {
    setInputValue(text);
    setComposerText(text);
  }, [setComposerText]);
  const goalFn = useMemo(
    () => async () => {
      fillSlashInput('/goal ');
      setSlashMenuOpen(false);
      showSlashResult('Goal 模式：写下目标和验收标准，Lynn 会持续推进直到完成或遇到真实阻塞。', 'success');
      requestInputFocus();
    },
    [fillSlashInput, requestInputFocus, showSlashResult],
  );

  const slashCommands = useMemo(
    () => {
      const core = buildSlashCommands(t, diaryFn, xingFn, compactFn, clearFn, planFn, saveFn, goalFn);
      const taskModeSlash = buildTaskModeSlashCommands(fillSlashInput, setSlashMenuOpen, requestInputFocus);
      return [...core, ...taskModeSlash];
    },
    [diaryFn, xingFn, compactFn, clearFn, planFn, saveFn, goalFn, t, fillSlashInput, requestInputFocus],
  );

  const filteredCommands = useMemo(() => {
    if (!composerText.startsWith('/')) return slashCommands;
    const query = composerText.slice(1).toLowerCase();
    return slashCommands.filter(c => c.name.startsWith(query));
  }, [composerText, slashCommands]);

  const handleInputChange = useCallback((value: string) => {
    setInputValue(value);
    if (!isComposing.current) setComposerText(value);
  }, [setComposerText]);

  const readLatestInputValue = useCallback(() => {
    return textareaRef.current?.value ?? inputValue;
  }, [inputValue]);

  const syncLatestInputValue = useCallback(() => {
    const latest = readLatestInputValue();
    if (latest !== inputValue) setInputValue(latest);
    if (latest !== composerText) setComposerText(latest);
    return latest;
  }, [composerText, inputValue, readLatestInputValue, setComposerText]);

  const markAtDiscoverySeen = useCallback(() => {
    setShowAtDiscovery(false);
    try {
      localStorage.setItem('hana-at-discovery-seen', '1');
    } catch {
      // ignore
    }
  }, []);

  const markAtInlineHintSeen = useCallback(() => {
    setAtInlineHintSeen((prev) => {
      const next = Math.min(3, prev + 1);
      try {
        localStorage.setItem('hana-at-inline-hint-seen', String(next));
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (isComposing.current) return;
    if (inputValue.startsWith('/') && inputValue.length <= 20) {
      setSlashMenuOpen(true);
      setSlashSelected(0);
      setAtMenuOpen(false);
      return;
    }

    setSlashMenuOpen(false);

    const atMatch = inputValue.match(/@(\S*)$/);
    if (atMatch && !inputValue.startsWith('/')) {
      setAtMenuOpen(true);
      setAtQuery(atMatch[1]);
      setAtSelected(0);
      return;
    }

    setAtMenuOpen(false);
    setAtQuery('');
    setAtResults([]);
  }, [inputValue]);

  useEffect(() => {
    if (atMenuOpen) markAtDiscoverySeen();
  }, [atMenuOpen, markAtDiscoverySeen]);

  useEffect(() => {
    setAtSelected((index) => {
      if (atResults.length === 0) return 0;
      return Math.min(index, atResults.length - 1);
    });
  }, [atResults]);



  const handleRestoreLastDraft = useCallback(() => {
    restoreLastSubmittedDraft(composerSessionKey);
    setInlineNotice(null);
    setInlineError(null);
    requestInputFocus();
  }, [composerSessionKey, requestInputFocus, restoreLastSubmittedDraft, setInlineError, setInlineNotice]);

  const openProvidersSettings = useCallback(() => {
    const hana = window.hana as { debugOpenOnboarding?: () => Promise<void> } | undefined;
    try { localStorage.setItem('hanako-settings-clicked', '1'); } catch { /* ignore */ }
    if (models.length === 0 && hana?.debugOpenOnboarding) {
      void hana.debugOpenOnboarding();
      return;
    }
    window.platform?.openSettings?.({
      tab: 'providers',
      providerId: activeModelInfo?.provider ?? null,
      resetProviderSelection: !activeModelInfo?.provider,
    });
  }, [activeModelInfo?.provider, models.length]);

  const recoveryMessage = useMemo(() => {
    if (wsState === 'reconnecting') {
      return `${t('status.reconnecting')} (${wsReconnectAttempt}) · 你可以继续编辑，连接恢复后再发送`;
    }
    if (wsState === 'disconnected') {
      return `${t('status.disconnected')} · 草稿和上下文会保留，恢复连接后可继续发送`;
    }
    if (inlineError && recoverableDraft) {
      return `${inlineError} · 可恢复到输入框继续修改`;
    }
    return null;
  }, [inlineError, recoverableDraft, t, wsReconnectAttempt, wsState]);

  const taskRecoveryMessage = useMemo(() => {
    if (!taskSnapshot?.activeCount) return null;
    if (taskSnapshot.waitingApprovalCount > 0) {
      return t('status.tasksRecoveredWaiting', {
        count: taskSnapshot.activeCount,
        waiting: taskSnapshot.waitingApprovalCount,
      });
    }
    return t('status.tasksRecoveredRunning', { count: taskSnapshot.activeCount });
  }, [t, taskSnapshot]);

  const securityMode = useStore(s => s.securityMode);
  const hasContent = inputValue.trim().length > 0 || attachedFiles.length > 0 || !!quotedSelection;
  const canSend = hasContent && connected && serverReady && !isStreaming;
  const serverStartingLabel = t('chat.serverStarting');
  const sendDisabledTitle = !serverReady
    ? (serverStartingLabel === 'chat.serverStarting'
      ? `Assistant is still starting (${serverStartupStage || 'starting'})`
      : serverStartingLabel)
    : undefined;

  const setComposerTextFromEvent = useCallback((
    text: string,
    options: { mode?: ComposerInsertMode; appendSpacer?: boolean } = {},
  ) => {
    const incoming = String(text || '');
    if (!incoming) return;

    const el = textareaRef.current;
    const current = el?.value ?? useStore.getState().composerText;
    const update = computeComposerTextUpdate({
      current,
      incoming,
      selectionStart: el?.selectionStart ?? current.length,
      selectionEnd: el?.selectionEnd ?? current.length,
      mode: options.mode,
      appendSpacer: options.appendSpacer,
    });

    setInputValue(update.next);
    setComposerText(update.next);
    requestInputFocus();
    requestAnimationFrame(() => {
      const target = textareaRef.current;
      if (!target) return;
      target.focus();
      target.setSelectionRange(update.caretStart, update.caretEnd);
      if (!isComposing.current) {
        target.style.height = 'auto';
        target.style.height = Math.min(target.scrollHeight, 120) + 'px';
      }
    });
  }, [requestInputFocus, setComposerText]);

  useInputEventBridge({
    deskBasePath,
    deskCurrentPath,
    securityMode,
    selectedFolder,
    setComposerTextFromEvent,
    setInlineNotice,
    setPendingConfirm,
    t,
    textareaRef,
  });

  useTextareaAutoResize({ inputValue, isComposing, textareaRef });

  const [textareaFocused, setTextareaFocused] = useState(false);
  const placeholder = usePlaceholderRotation({ agentYuan, inputValue, t, textareaFocused });

  const inlineFileSuggestion = useMemo(() => {
    if (atInlineHintSeen >= 3) return null;
    if (attachedFiles.length > 0 || quotedSelection) return null;
    if (!inputValue.trim() || inputValue.includes('@')) return null;
    return detectInlineFileSuggestion(inputValue);
  }, [atInlineHintSeen, attachedFiles.length, inputValue, quotedSelection]);

  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleVoiceClick = useCallback(() => {
    window.dispatchEvent(new CustomEvent(JARVIS_RUNTIME_START_EVENT));
  }, []);

  const handleTryAtInjection = useCallback(() => {
    markAtDiscoverySeen();
    setInputValue('@');
    setComposerText('@');
    requestInputFocus();
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(1, 1);
    });
  }, [markAtDiscoverySeen, requestInputFocus, setComposerText]);

  const handleUseInlineAtHint = useCallback(() => {
    if (!inlineFileSuggestion) return;
    markAtDiscoverySeen();
    markAtInlineHintSeen();
    const stripped = inputValue.replace(inlineFileSuggestion, '').replace(/\s{2,}/g, ' ').trim();
    const next = stripped ? `${stripped} @${inlineFileSuggestion}` : `@${inlineFileSuggestion}`;
    setInputValue(next);
    setComposerText(next);
    requestInputFocus();
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
  }, [inlineFileSuggestion, inputValue, markAtDiscoverySeen, markAtInlineHintSeen, requestInputFocus, setComposerText]);

  const { handleFileInputChange, handlePaste } = useAttachmentHandlers({
    addAttachedFile,
    setComposerTextFromEvent,
    supportsVision,
    t,
    warnVisionUnsupported,
  });

  useConfiguredThinkingLevel(setThinkingLevel);

  const canSteer = isStreaming && inputValue.trim().length > 0;

  const handleSubmitTask = useCallback(async (mode: ComposerTaskMode) => {
    const latestInputValue = syncLatestInputValue();

    if (mode === 'prompt') {
      if (pendingNewSession && !useStore.getState().selectedFolder && useStore.getState().homeFolder) {
        useStore.setState({ selectedFolder: useStore.getState().homeFolder });
      }
      const hasSendable = !!(latestInputValue.trim() || attachedFiles.length > 0 || quotedSelection);
      if (!hasSendable || !connected) {
        if (!connected && hasSendable) showSidebarToast(t('chat.needWsConnection'));
        return;
      }
      const localReady = await ensureCurrentLocalQwenReady();
      if (!localReady) return;
    } else {
      if (!latestInputValue.trim()) return;
    }

    if (sending) return;
    if (mode === 'prompt' && isStreaming) return;

    setSending(true);
    try {
      setInlineNotice(null);
      setInlineError(null);
      const prepared = await prepareComposerTask({
        mode,
        composerText: latestInputValue,
        preferredWorkspace: selectedFolder || deskBasePath || homeFolder || null,
        attachedFiles,
        docContextAttached: false,
        currentDoc: null,
        quotedSelection,
        workingSetRecentFiles,
        supportsVision,
        gitContext,
        readFileBase64: window.hana?.readFileBase64?.bind(window.hana),
      });

      const sent = await submitPromptTask({
        ...prepared.submission,
        gitContext: gitContext ? {
          repoName: gitContext.repoName,
          branch: gitContext.branch,
          changedCount: gitContext.totalChanged,
        } : null,
      });
      if (!sent) return;

      const nextSessionPath = useStore.getState().currentSessionPath;
      if (nextSessionPath) {
        setLastSubmittedDraft(nextSessionPath, prepared.draft);
      }

      if (mode === 'prompt') {
        prepared.otherFiles.forEach(file => {
          rememberWorkingSetFile(fileToWorkingSet({ path: file.path, name: file.name }, file.isDirectory ? 'desk' : 'recent', file.isDirectory));
        });
        if (prepared.docForRender) {
          rememberWorkingSetFile(fileToWorkingSet(prepared.docForRender, 'current'));
        }

        clearComposerState();
        setSlashMenuOpen(false);
        setAtMenuOpen(false);
        setAtQuery('');
        if (quotedSelection) clearQuotedSelection();
      } else {
        setComposerText('');
      }
    } finally {
      setSending(false);
    }
  }, [
    attachedFiles,
    clearComposerState,
    clearQuotedSelection,
    connected,
    isStreaming,
    pendingNewSession,
    quotedSelection,
    rememberWorkingSetFile,
    sending,
    setLastSubmittedDraft,
    setComposerText,
    supportsVision,
    t,
    workingSetRecentFiles,
    gitContext,
    homeFolder,
    selectedFolder,
    deskBasePath,
    ensureCurrentLocalQwenReady,
    setInlineError,
    setInlineNotice,
    syncLatestInputValue,
  ]);

  const handleSend = useCallback(async () => {
    const text = readLatestInputValue().trim();

    if (text.startsWith('/') && slashMenuOpen && filteredCommands.length > 0) {
      const cmd = filteredCommands[slashSelected] || filteredCommands[0];
      if (cmd) {
        cmd.execute();
        return;
      }
    }

    if (deepResearchOpen && text) {
      await handleDeepResearchRun();
      return;
    }

    await handleSubmitTask('prompt');
  }, [deepResearchOpen, filteredCommands, handleDeepResearchRun, handleSubmitTask, readLatestInputValue, slashMenuOpen, slashSelected]);

  const handleAtSelect = useCallback((file: { name: string; path: string; rel: string; isDir: boolean }) => {
    const atMatch = inputValue.match(/@(\S*)$/);
    if (atMatch) {
      const before = inputValue.slice(0, inputValue.length - atMatch[0].length);
      const next = before + '@' + file.name + ' ';
      setInputValue(next);
      setComposerText(next);
    }
    addAttachedFile({ path: file.path, name: file.name, isDirectory: file.isDir });
    setAtMenuOpen(false);
    setAtQuery('');
    textareaRef.current?.focus();
  }, [inputValue, addAttachedFile, setComposerText]);

  const handleSteer = useCallback(async () => {
    await handleSubmitTask('steer');
  }, [handleSubmitTask]);

  const handleStop = useCallback(() => {
    const ws = getWebSocket();
    if (!isStreaming || !ws) return;
    ws.send(JSON.stringify({ type: 'abort', sessionPath: useStore.getState().currentSessionPath }));
  }, [isStreaming]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (atMenuOpen) {
      if (e.key === 'ArrowDown' && atResults.length > 0) {
        e.preventDefault();
        setAtSelected(i => (i + 1) % atResults.length);
        return;
      }
      if (e.key === 'ArrowUp' && atResults.length > 0) {
        e.preventDefault();
        setAtSelected(i => (i - 1 + atResults.length) % atResults.length);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && atResults.length > 0) {
        e.preventDefault();
        handleAtSelect(atResults[atSelected] || atResults[0]);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setAtMenuOpen(false); return; }
    }

    if (slashMenuOpen && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashSelected(i => (i + 1) % filteredCommands.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSlashSelected(i => (i - 1 + filteredCommands.length) % filteredCommands.length); return; }
      if (e.key === 'Tab') { e.preventDefault(); const cmd = filteredCommands[slashSelected]; if (cmd) setComposerText('/' + cmd.name); return; }
      if (e.key === 'Escape') { e.preventDefault(); setSlashMenuOpen(false); return; }
    }
    const nativeEvent = e.nativeEvent as KeyboardEvent & { isComposing?: boolean };
    const composing = isComposing.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;
    if (e.key === 'Enter' && composing) {
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (isStreaming && readLatestInputValue().trim()) handleSteer(); else handleSend();
    }
  }, [handleAtSelect, handleSend, handleSteer, isStreaming, readLatestInputValue, slashMenuOpen, filteredCommands, slashSelected, setComposerText, atMenuOpen, atResults, atSelected]);

  return (
    <>
      <InputStatusBars
        compacting={compacting}
        inlineError={inlineError}
        inlineNotice={inlineNotice}
        localQwen={localQwen}
        onOpenActivity={() => setActivePanel('activity')}
        onReconnect={() => manualReconnect()}
        onRestoreLastDraft={handleRestoreLastDraft}
        recoverableDraft={recoverableDraft}
        recoveryMessage={recoveryMessage}
        slashBusy={slashBusy}
        slashCommands={slashCommands}
        slashResult={slashResult}
        t={t}
        taskRecoveryMessage={taskRecoveryMessage}
        translatedInlineNotice={translatedInlineNotice}
        wsState={wsState}
      />
      <InputContextOverlays
        attachedFiles={attachedFiles}
        atMenuOpen={atMenuOpen}
        atQuery={atQuery}
        atResults={atResults}
        atSelected={atSelected}
        filteredCommands={filteredCommands}
        onAtHover={setAtSelected}
        onAtResultsChange={setAtResults}
        onAtSelect={handleAtSelect}
        onAttachmentRemove={removeAttachedFile}
        onSlashHover={setSlashSelected}
        onSlashSelect={(cmd) => cmd.execute()}
        quotedSelection={quotedSelection}
        sessionTodos={sessionTodos}
        slashBusy={slashBusy}
        slashMenuOpen={slashMenuOpen}
        slashSelected={slashSelected}
      />
      <InputDiscoveryHints
        inlineFileSuggestion={inlineFileSuggestion}
        onDismissAtDiscovery={markAtDiscoverySeen}
        onDismissInlineHint={markAtInlineHintSeen}
        onTryAtInjection={handleTryAtInjection}
        onUseInlineAtHint={handleUseInlineAtHint}
        showAtDiscovery={showAtDiscovery && !inputValue.trim() && attachedFiles.length === 0 && !quotedSelection && !recoveryMessage && !taskRecoveryMessage && !inlineError && !inlineNotice && !slashBusy && !compacting}
        t={t}
      />
      <DeepResearchLauncher
        busy={deepResearchBusy}
        inlineError={inlineError}
        isStreaming={isStreaming}
        onClose={() => setDeepResearchOpen(false)}
        onStart={handleDeepResearchRun}
        readLatestInputValue={readLatestInputValue}
        recoveryMessage={recoveryMessage}
        requestInputFocus={requestInputFocus}
        setComposerText={setComposerText}
        setInputValue={setInputValue}
        taskRecoveryMessage={taskRecoveryMessage}
        visible={deepResearchOpen}
      />
      <div className={`${styles['input-wrapper']} ${styles[`input-wrapper-${securityMode}`] || ''}`}>
        <ComposerTextarea
          textareaRef={textareaRef}
          isComposing={isComposing}
          value={inputValue}
          placeholder={placeholder}
          inputLargeSummary={inputLargeSummary}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onFocusChange={setTextareaFocused}
          onCompositionValue={(next) => {
            setInputValue(next);
            setComposerText(next);
          }}
        />
        <SubmitArea
          fileInputRef={fileInputRef}
          thinkingLevel={thinkingLevel}
          modelXhigh={currentModelInfo?.xhigh ?? false}
          showThinkingControl={activeModelInfo?.reasoning !== false}
          selectorModels={selectorModels}
          isStreaming={isStreaming}
          localQwenRunning={localQwenRunning}
          localQwenLoading={localQwenLoading}
          showModelConfigHint={showModelConfigHint}
          deepResearchOpen={deepResearchOpen}
          deepResearchBusy={deepResearchBusy}
          canSteer={canSteer}
          canSend={canSend}
          sendDisabledTitle={sendDisabledTitle}
          t={t}
          onAttachClick={handleAttachClick}
          onFileInputChange={handleFileInputChange}
          onVoiceClick={handleVoiceClick}
          onDeepResearchToggle={() => {
            setDeepResearchOpen((open) => !open);
            requestInputFocus();
          }}
          onThinkingLevelChange={setThinkingLevel}
          onOpenProvidersSettings={openProvidersSettings}
          onSend={handleSend}
          onSteer={handleSteer}
          onStop={handleStop}
        />
      </div>
    </>
  );
}
