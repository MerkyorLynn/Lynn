/**
 * InputArea — 聊天输入区域 React 组件
 *
 * 子组件拆分到 ./input/ 目录。
 * 斜杠命令逻辑在 ./input/slash-commands.ts。
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import { showSidebarToast } from '../stores/session-actions';
import { getWebSocket, manualReconnect } from '../services/websocket';
import { sendPrompt, submitPromptTask } from '../stores/prompt-actions';
import type { ThinkingLevel } from '../stores/model-slice';
import { TodoDisplay } from './input/TodoDisplay';
import { AttachedFilesBar } from './input/AttachedFilesBar';
import { SecurityModeSelector } from './input/SecurityModeSelector';
import { ContextRing } from './input/ContextRing';
import { enterWritingMode, exitWritingMode } from '../hooks/use-writing-preview';
import { ThinkingLevelButton } from './input/ThinkingLevelButton';
import { ModelSelector } from './input/ModelSelector';
import { SlashCommandMenu } from './input/SlashCommandMenu';
import { AtMentionMenu } from './input/AtMentionMenu';
import { SendButton } from './input/SendButton';
import { QuotedSelectionCard } from './input/QuotedSelectionCard';
import { TaskModePicker } from './input/TaskModePicker';
import { JARVIS_RUNTIME_START_EVENT } from '../services/jarvis-runtime-events';
import {
  XING_PROMPT, executeDiary, executeCompact, executeClear, executePlan, executeSave, buildSlashCommands,
  buildTaskModeSlashCommands,
  type SlashCommand,
} from './input/slash-commands';
import {
  fileToWorkingSet,
  getComposerSessionKey,
} from '../utils/composer-state';
import {
  prepareComposerTask,
  type ComposerTaskMode,
  type GitContextSnapshot,
} from '../utils/prompt-task';
import { resolveUiI18nText } from '../utils/ui-i18n';
import styles from './input/InputArea.module.css';

export type { SlashCommand };

export function InputArea() {
  return <InputAreaInner />;
}

// ── 写作模式切换按钮（✎ 图标）──
function WritingModeToggle() {
  const writingMode = useStore(s => s.writingMode);
  const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || '');
  const kbd = isMac ? '⇧⌘M' : 'Ctrl+Shift+M';
  const isZh = String(document?.documentElement?.lang || '').startsWith('zh');
  const title = writingMode
    ? (isZh ? `退出写作模式 (${kbd})` : `Exit writing mode (${kbd})`)
    : (isZh ? `进入写作模式 (${kbd}) — 加宽聊天 + 自动 MD 预览` : `Writing mode (${kbd}) — wider chat + auto MD preview`);

  const toggle = useCallback(() => {
    if (writingMode) exitWritingMode();
    else enterWritingMode();
  }, [writingMode]);

  return (
    <button
      type="button"
      onClick={toggle}
      title={title}
      aria-pressed={writingMode}
      aria-label={isZh ? '写作模式' : 'Writing mode'}
      style={{
        flexShrink: 0,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        padding: 0,
        border: `1px solid ${writingMode ? 'var(--accent)' : 'rgba(var(--accent-rgb), 0.14)'}`,
        borderRadius: 'var(--radius-sm, 6px)',
        background: writingMode ? 'rgba(var(--accent-rgb), 0.12)' : 'transparent',
        color: writingMode ? 'var(--accent)' : 'var(--text-muted)',
        cursor: 'pointer',
        transition: 'all 0.15s',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    </button>
  );
}

function deriveRunRisk(command: string): 'low' | 'medium' | 'high' {
  const normalized = command.trim().toLowerCase();
  if (/\b(rm|sudo|chmod|chown|mv|scp|ssh|docker\s+rm|git\s+push|npm\s+publish)\b/.test(normalized)) {
    return 'high';
  }
  if (/\b(git|npm|pnpm|yarn|bun|cargo|go|python|node|uv|make|brew|curl|wget)\b/.test(normalized)) {
    return 'medium';
  }
  return 'low';
}

function runRiskLabel(risk: 'low' | 'medium' | 'high', t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (risk === 'high') return t('markdown.runRisk.high') || '高风险';
  if (risk === 'medium') return t('markdown.runRisk.medium') || '中风险';
  return t('markdown.runRisk.low') || '低风险';
}

function buildRunCommandPrompt(command: string, cwd: string | null): string {
  const cwdLine = cwd ? `当前工作目录：${cwd}\n` : '';
  return `请直接在终端执行下面的命令，并基于真实结果回复。不要只解释命令本身。\n${cwdLine}\n\`\`\`sh\n${command.trim()}\n\`\`\``;
}

const FILE_CONTEXT_PATTERN = /\b([A-Za-z0-9_./-]+\.(?:tsx?|jsx?|css|json|md|py|rs|go|java|vue|svelte|swift|kt|kts|c|cc|cpp|h|hpp|m|mm|sql|yaml|yml|toml|sh))\b/i;

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

  const currentModelInfo = useMemo(() => models.find(m => m.isCurrent), [models]);
  const activeModelInfo = currentModelInfo || (models.length > 0 ? models[0] : null);
  const selectorModels = models;
  const noModelsAtAll = models.length === 0;
  const supportsVision = activeModelInfo?.vision !== false && activeModelInfo !== null;
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
  const [gitContext, setGitContext] = useState<GitContextSnapshot | null>(null);
  const [inputValue, setInputValue] = useState(composerText);
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

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isComposing = useRef(false);
  const skipNextDraftSaveRef = useRef(true);

  const inputFocusTrigger = useStore(s => s.inputFocusTrigger);
  const requestInputFocus = useStore(s => s.requestInputFocus);
  useEffect(() => {
    if (inputFocusTrigger > 0) textareaRef.current?.focus();
  }, [inputFocusTrigger]);

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

  const slashCommands = useMemo(
    () => {
      const core = buildSlashCommands(t, diaryFn, xingFn, compactFn, clearFn, planFn, saveFn);
      const taskModeSlash = buildTaskModeSlashCommands(setComposerText, setSlashMenuOpen, requestInputFocus);
      return [...core, ...taskModeSlash];
    },
    [diaryFn, xingFn, compactFn, clearFn, planFn, saveFn, t, setComposerText, requestInputFocus],
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

  const insertTextIntoComposer = useCallback((text: string) => {
    const incoming = String(text || '');
    if (!incoming) return;

    const el = textareaRef.current;
    const current = useStore.getState().composerText;
    const start = el ? el.selectionStart : current.length;
    const end = el ? el.selectionEnd : current.length;
    const needsSpacer = current && start === current.length && !current.endsWith('\n') ? '\n\n' : '';
    const insert = start === current.length ? `${needsSpacer}${incoming}` : incoming;
    const next = `${current.slice(0, start)}${insert}${current.slice(end)}`;
    const caret = start + insert.length;

    setComposerText(next);
    requestInputFocus();
    requestAnimationFrame(() => {
      const target = textareaRef.current;
      if (!target) return;
      target.focus();
      target.setSelectionRange(caret, caret);
    });
  }, [requestInputFocus, setComposerText]);

  const insertPastedTextIntoComposer = useCallback((text: string) => {
    const incoming = String(text || '');
    if (!incoming) return;

    const el = textareaRef.current;
    const current = el?.value ?? useStore.getState().composerText;
    const start = el ? el.selectionStart : current.length;
    const end = el ? el.selectionEnd : current.length;
    const next = `${current.slice(0, start)}${incoming}${current.slice(end)}`;
    const caret = start + incoming.length;

    setInputValue(next);
    setComposerText(next);
    requestInputFocus();
    requestAnimationFrame(() => {
      const target = textareaRef.current;
      if (!target) return;
      target.focus();
      target.setSelectionRange(caret, caret);
      if (!isComposing.current) {
        target.style.height = 'auto';
        target.style.height = Math.min(target.scrollHeight, 120) + 'px';
      }
    });
  }, [requestInputFocus, setComposerText]);

  useEffect(() => {
    const handlePasteToInput = (event: Event) => {
      const detail = (event as CustomEvent<{ text?: string }>).detail || {};
      insertTextIntoComposer(detail.text || '');
    };
    window.addEventListener('hana-paste-to-input', handlePasteToInput);
    return () => window.removeEventListener('hana-paste-to-input', handlePasteToInput);
  }, [insertTextIntoComposer]);

  useEffect(() => {
    const handleRunCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ command?: string; language?: string }>).detail || {};
      const command = String(detail.command || '').trim();
      if (!command) return;

      const cwd = deskBasePath
        ? (deskCurrentPath ? `${deskBasePath}/${deskCurrentPath}` : deskBasePath)
        : (selectedFolder || useStore.getState().homeFolder || null);
      const risk = deriveRunRisk(command);
      const riskText = runRiskLabel(risk, t);
      const modeText = securityMode === 'safe'
        ? (t('security.mode.safe') || '只读')
        : securityMode === 'plan'
          ? (t('security.mode.plan') || '规划')
          : (t('security.mode.authorized') || '执行');

      setPendingConfirm({
        title: t('markdown.runConfirm.title') || '执行代码块命令',
        message: (t('markdown.runConfirm.message') || '将把这段命令发给 Lynn 执行。').replace('{mode}', modeText),
        detail: [
          `${t('markdown.runConfirm.cwd') || '工作目录'}: ${cwd || (t('markdown.runConfirm.cwdUnknown') || '未指定')}`,
          `${t('markdown.runConfirm.risk') || '风险级别'}: ${riskText}`,
          command,
        ].join('\n'),
        confirmLabel: t('markdown.runConfirm.confirm') || '继续执行',
        cancelLabel: t('common.cancel') || '取消',
        tone: risk === 'high' ? 'danger' : 'default',
        onConfirm: async () => {
          const ok = await submitPromptTask({
            mode: 'prompt',
            text: command,
            displayText: command,
            requestText: buildRunCommandPrompt(command, cwd),
          });
          if (!ok) {
            throw new Error(t('chat.needWsConnection') || '连接未就绪');
          }
        },
      });
    };

    window.addEventListener('hana-run-command', handleRunCommand);
    return () => window.removeEventListener('hana-run-command', handleRunCommand);
  }, [deskBasePath, deskCurrentPath, securityMode, selectedFolder, setPendingConfirm, t]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // IME 组合态不要 resize，避免中文输入法候选框飞到左下角。
    if (isComposing.current) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [inputValue]);

  const placeholderHints = useMemo(() => {
    const yuanPh = t(`yuan.placeholder.${agentYuan}`);
    const base = (yuanPh && !yuanPh.startsWith('yuan.')) ? yuanPh : t('input.placeholder');
    const h = (key: string, fallback: string) => {
      const v = t(key);
      return (v && v !== key && !v.startsWith('input.hint')) ? v : fallback;
    };
    return [
      base,
      h('input.hintAnalyzeExcel', '帮我分析桌面上的 Excel...'),
      h('input.hintSlash', '输入 / 查看快捷命令'),
      h('input.hintScanStock', '扫描一下今天 A 股有什么异动...'),
      h('input.hintDrag', '拖拽文件到此处附加上下文'),
      h('input.hintOrganize', '把这个文件夹里的文档整理一下...'),
      h('input.hintAt', '输入 @ 引用文件或文件夹'),
      h('input.hintDesk', 'Cmd+J 打开任务清单'),
    ];
  }, [agentYuan, t]);

  const [phIndex, setPhIndex] = useState(0);
  const [textareaFocused, setTextareaFocused] = useState(false);
  useEffect(() => {
    // [2026-04-26 IME-FIX] textarea focused 时暂停 placeholder 轮播 ——
    // macOS 中文 IME 期间 placeholder 属性 DOM 变更会让候选窗 detach 飞到屏幕左下角
    if (inputValue.trim() || textareaFocused) return;
    const timer = setInterval(() => setPhIndex(i => (i + 1) % placeholderHints.length), 6000);
    return () => clearInterval(timer);
  }, [inputValue, textareaFocused, placeholderHints.length]);

  const placeholder = placeholderHints[phIndex] || placeholderHints[0];

  const inlineFileSuggestion = useMemo(() => {
    if (atInlineHintSeen >= 3) return null;
    if (attachedFiles.length > 0 || quotedSelection) return null;
    if (!inputValue.trim() || inputValue.includes('@')) return null;
    const match = inputValue.match(FILE_CONTEXT_PATTERN);
    return match?.[1] || null;
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

  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    for (const file of Array.from(files)) {
      if (useStore.getState().attachedFiles.length >= 9) break;
      const filePath = await window.platform?.getFilePath?.(file);
      if (filePath) {
        addAttachedFile({ path: filePath, name: file.name });
      } else if (file.type.startsWith('image/')) {
        const reader = new FileReader();
        reader.onload = () => {
          const dataUrl = reader.result as string;
          const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
          if (!match) return;
          const [, mimeType, base64Data] = match;
          addAttachedFile({
            path: `local-${Date.now()}-${file.name}`,
            name: file.name,
            base64Data,
            mimeType,
          });
        };
        reader.readAsDataURL(file);
      } else {
        addAttachedFile({ path: file.name, name: file.name });
      }
    }
    e.target.value = '';
  }, [addAttachedFile]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    const text = e.clipboardData?.getData('text/plain') || '';
    const imageItem = items ? Array.from(items).find(item => item.type.startsWith('image/')) : null;

    if (text) {
      e.preventDefault();
      insertPastedTextIntoComposer(text);
      return;
    }

    if (!imageItem) return;
    if (!supportsVision) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    const file = imageItem.getAsFile();
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
      if (!match) return;
      const [, mimeType, base64Data] = match;
      const ext = mimeType.split('/')[1] || 'png';
      addAttachedFile({
        path: `clipboard-${Date.now()}.${ext}`,
        name: `${t('input.pastedImage')}.${ext}`,
        base64Data,
        mimeType,
      });
    };
    reader.readAsDataURL(file);
  }, [addAttachedFile, insertPastedTextIntoComposer, t, supportsVision]);

  useEffect(() => {
    hanaFetch('/api/config')
      .then(r => r.json())
      .then(d => { if (d.thinking_level) setThinkingLevel(d.thinking_level as ThinkingLevel); })
      .catch((err: unknown) => console.warn('[InputArea] load config failed', err));
  }, [setThinkingLevel]);

  useEffect(() => {
    const dir = deskBasePath
      ? (deskCurrentPath ? `${deskBasePath}/${deskCurrentPath}` : deskBasePath)
      : (pendingNewSession ? selectedFolder : null);
    if (!dir) {
      setGitContext(null);
      return;
    }

    let cancelled = false;
    const params = new URLSearchParams({ dir });
    hanaFetch(`/api/desk/git-context?${params.toString()}`)
      .then(r => r.json())
      .then((data) => {
        if (!cancelled) setGitContext(data?.available ? data : null);
      })
      .catch(() => {
        if (!cancelled) setGitContext(null);
      });

    return () => {
      cancelled = true;
    };
  }, [deskBasePath, deskCurrentPath, pendingNewSession, selectedFolder]);

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

    await handleSubmitTask('prompt');
  }, [filteredCommands, handleSubmitTask, readLatestInputValue, slashMenuOpen, slashSelected]);

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
      {slashBusy && (
        <div className={styles['slash-busy-bar']}>
          <span className={styles['slash-busy-dot']} />
          <span>{slashCommands.find(c => c.name === slashBusy)?.busyLabel || t('common.executing')}</span>
        </div>
      )}
      {compacting && (
        <div className={styles['slash-busy-bar']}>
          <span className={styles['slash-busy-dot']} />
          <span>{t('chat.compacting')}</span>
        </div>
      )}
      {recoveryMessage && (
        <div className={styles['connection-recovery-bar']}>
          <span>{recoveryMessage}</span>
          <div className={styles['recovery-actions']}>
            {recoverableDraft && (
              <button className={styles['recovery-action']} onClick={handleRestoreLastDraft}>
                {t('input.restoreDraft') || '恢复草稿'}
              </button>
            )}
            {wsState !== 'connected' && (
              <button className={styles['recovery-action']} onClick={() => manualReconnect()}>
                {t('status.reconnect')}
              </button>
            )}
          </div>
        </div>
      )}
      {!recoveryMessage && taskRecoveryMessage && (
        <div className={styles['connection-recovery-bar']}>
          <span>{taskRecoveryMessage}</span>
          <div className={styles['recovery-actions']}>
            <button className={styles['recovery-action']} onClick={() => setActivePanel('activity')}>
              {t('activity.openRecoveredTasks')}
            </button>
          </div>
        </div>
      )}
      {translatedInlineNotice && !recoveryMessage && !taskRecoveryMessage && (
        <div className={styles['slash-notice-bar']}>
          <span className={styles['slash-notice-dot']} />
          <span>{translatedInlineNotice}</span>
        </div>
      )}
      {inlineError && !recoverableDraft && (
        <div className={styles['slash-error-bar']}>
          <span className={styles['slash-error-dot']} />
          <span>{inlineError}</span>
        </div>
      )}
      {!slashBusy && !compacting && !inlineError && !inlineNotice && slashResult && (
        <div className={styles['slash-busy-bar']}><span>{slashResult.text}</span></div>
      )}
      {(quotedSelection || sessionTodos.length > 0) && (
        <div className={styles['input-context-row']}>
          <div className={styles['input-context-left']}>
            <QuotedSelectionCard />
          </div>
          <TodoDisplay todos={sessionTodos} />
        </div>
      )}
      {slashMenuOpen && filteredCommands.length > 0 && (
        <SlashCommandMenu commands={filteredCommands} selected={slashSelected} busy={slashBusy}
          onSelect={(cmd) => cmd.execute()} onHover={(i) => setSlashSelected(i)} />
      )}
      {atMenuOpen && (
        <AtMentionMenu
          query={atQuery}
          selected={atSelected}
          onSelect={handleAtSelect}
          onHover={(i) => setAtSelected(i)}
          onResultsChange={setAtResults}
        />
      )}
      {attachedFiles.length > 0 && (
        <AttachedFilesBar files={attachedFiles} onRemove={removeAttachedFile} />
      )}
      {showAtDiscovery && !inputValue.trim() && attachedFiles.length === 0 && !quotedSelection && !recoveryMessage && !taskRecoveryMessage && !inlineError && !inlineNotice && !slashBusy && !compacting && (
        <div className={styles['at-discovery-row']}>
          <button type="button" className={styles['at-discovery-pill']} onClick={handleTryAtInjection}>
            <span className={styles['at-discovery-badge']}>@</span>
            <span className={styles['at-discovery-copy']}>
              <strong>{t('input.atDiscovery.title') || '试试 @ 引用文件或文件夹'}</strong>
              <span>{t('input.atDiscovery.subtitle') || '例如：@App.tsx 帮我看这段路由'}</span>
            </span>
          </button>
          <button
            type="button"
            className={styles['at-discovery-dismiss']}
            onClick={markAtDiscoverySeen}
            aria-label={t('common.close') || '关闭'}
            title={t('common.close') || '关闭'}
          >
            ×
          </button>
        </div>
      )}
      {inlineFileSuggestion && (
        <div className={styles['at-inline-hint']}>
          <button type="button" className={styles['at-inline-hint-main']} onClick={handleUseInlineAtHint}>
            <span>{t('input.atDiscovery.inlineHint', { name: inlineFileSuggestion }) || `💡 输入 @${inlineFileSuggestion} 可以直接让 Lynn 看这个文件`}</span>
            <span className={styles['at-inline-hint-action']}>{t('input.atDiscovery.inlineAction') || '改成 @ 引用'}</span>
          </button>
          <button
            type="button"
            className={styles['at-inline-hint-dismiss']}
            onClick={markAtInlineHintSeen}
            aria-label={t('common.close') || '关闭'}
            title={t('common.close') || '关闭'}
          >
            ×
          </button>
        </div>
      )}
      <div className={`${styles['input-wrapper']} ${styles[`input-wrapper-${securityMode}`] || ''}`}>
        <textarea ref={textareaRef} id="inputBox" className={styles['input-box']} placeholder={placeholder}
          aria-label={t('input.placeholder') || '输入消息'}
          rows={1} spellCheck={false} value={inputValue}
          onChange={e => handleInputChange(e.target.value)} onKeyDown={handleKeyDown} onPaste={handlePaste}
          onFocus={() => setTextareaFocused(true)}
          onBlur={() => setTextareaFocused(false)}
          onCompositionStart={() => { isComposing.current = true; }}
          onCompositionEnd={(e) => {
            isComposing.current = false;
            const next = e.currentTarget.value;
            setInputValue(next);
            setComposerText(next);
            // 组合事件结束的同一 tick 里继续改 textarea 布局，macOS IME
            // 偶发会把候选窗坐标缓存成屏幕左下角。延后一帧再补高度。
            requestAnimationFrame(() => {
              const el = textareaRef.current;
              if (!el || isComposing.current) return;
              el.style.height = 'auto';
              el.style.height = Math.min(el.scrollHeight, 120) + 'px';
            });
          }} />
        <div className={styles['input-bottom-bar']}>
          <div className={styles['input-actions']}>
            <button type="button" className={styles['attach-btn']} onClick={handleAttachClick} title={t('input.attachFile') || '添加附件'}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            </button>
            <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleFileInputChange} />
            <button
              type="button"
              className={styles['attach-btn']}
              onClick={handleVoiceClick}
              title="Lynn 语音"
              aria-label="打开 Lynn 语音"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <path d="M12 19v3" />
                <path d="M8 22h8" />
              </svg>
            </button>
            <TaskModePicker />
            <SecurityModeSelector />
            <WritingModeToggle />
            <ContextRing />
          </div>
          <div className={styles['input-controls']}>
            {activeModelInfo?.reasoning !== false && (
              <ThinkingLevelButton level={thinkingLevel} onChange={setThinkingLevel} modelXhigh={currentModelInfo?.xhigh ?? false} />
            )}
            <ModelSelector models={selectorModels} disabled={isStreaming} />
            {(noModelsAtAll || models.length <= 1) && (
              <button
                type="button"
                className={styles['model-upgrade-btn']}
                onClick={openProvidersSettings}
                title={t('input.embeddedModel.upgradeTitle')}
              >
                <span className={styles['model-upgrade-icon']}>✦</span>
                <span className={styles['model-upgrade-copy']}>
                  <span className={styles['model-upgrade-title']}>{t('input.embeddedModel.upgrade')}</span>
                  <span className={styles['model-upgrade-subtitle']}>{t('input.embeddedModel.hint')}</span>
                </span>
              </button>
            )}
            <SendButton isStreaming={isStreaming} canSteer={canSteer} disabled={isStreaming ? false : !canSend} title={sendDisabledTitle} onSend={handleSend} onSteer={handleSteer} onStop={handleStop} />
          </div>
        </div>
      </div>
    </>
  );
}
