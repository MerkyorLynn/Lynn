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
import type { WorkingSetFile } from '../stores/input-slice';
import { TodoDisplay } from './input/TodoDisplay';
import { AttachedFilesBar } from './input/AttachedFilesBar';
import { SecurityModeSelector } from './input/SecurityModeSelector';
import { DocContextButton } from './input/DocContextButton';
import { ContextRing } from './input/ContextRing';
import { ThinkingLevelButton } from './input/ThinkingLevelButton';
import { ModelSelector } from './input/ModelSelector';
import { SlashCommandMenu } from './input/SlashCommandMenu';
import { AtMentionMenu } from './input/AtMentionMenu';
import { SendButton } from './input/SendButton';
import { QuotedSelectionCard } from './input/QuotedSelectionCard';
import { WorkingSetBar } from './input/WorkingSetBar';
import { ContextOverviewCard } from './input/ContextOverviewCard';
import {
  XING_PROMPT, executeDiary, executeCompact, buildSlashCommands,
  type SlashCommand,
} from './input/slash-commands';
import {
  fileToWorkingSet,
  getComposerSessionKey,
  mergeWorkingSetFiles,
  resolveDocContextToggle,
  toggleComposerAttachment,
} from '../utils/composer-state';
import {
  buildComposerContextOverview,
  prepareComposerTask,
  type ComposerTaskMode,
  type GitContextSnapshot,
} from '../utils/prompt-task';
import styles from './input/InputArea.module.css';

export type { SlashCommand };

export function InputArea() {
  return <InputAreaInner />;
}

function InputAreaInner() {
  const { t } = useI18n();

  const isStreaming = useStore(s => s.isStreaming);
  const connected = useStore(s => s.connected);
  const pendingNewSession = useStore(s => s.pendingNewSession);
  const selectedFolder = useStore(s => s.selectedFolder);
  const currentSessionPath = useStore(s => s.currentSessionPath);
  const composerSessionKey = getComposerSessionKey(currentSessionPath, pendingNewSession);
  const compacting = useStore(s => currentSessionPath ? s.compactingSessions.includes(currentSessionPath) : false);
  const inlineError = useStore(s => s.inlineError);
  const wsState = useStore(s => s.wsState);
  const wsReconnectAttempt = useStore(s => s.wsReconnectAttempt);
  const recoverableDraft = useStore(s => s.lastSubmittedDrafts[composerSessionKey] || null);
  const todosBySession = useStore(s => s.todosBySession);
  const sessionTodos = (todosBySession && currentSessionPath && todosBySession[currentSessionPath]) || [];
  const attachedFiles = useStore(s => s.attachedFiles);
  const docContextAttached = useStore(s => s.docContextAttached);
  const docContextFile = useStore(s => s.docContextFile);
  const quotedSelection = useStore(s => s.quotedSelection);
  const artifacts = useStore(s => s.artifacts);
  const activeTabId = useStore(s => s.activeTabId);
  const previewOpen = useStore(s => s.previewOpen);
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
  const setInlineError = useStore(s => s.setInlineError);
  const workingSetRecentFiles = useStore(s => s.workingSetRecentFiles);
  const rememberWorkingSetFile = useStore(s => s.rememberWorkingSetFile);
  const deskFiles = useStore(s => s.deskFiles);
  const deskBasePath = useStore(s => s.deskBasePath);
  const deskCurrentPath = useStore(s => s.deskCurrentPath);

  const currentModelInfo = useMemo(() => models.find(m => m.isCurrent), [models]);
  const activeModelInfo = currentModelInfo || (models.length > 0 ? models[0] : null);
  const selectorModels = models;
  const noModelsAtAll = models.length === 0;
  const supportsVision = activeModelInfo?.vision !== false && activeModelInfo !== null;

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

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposing = useRef(false);
  const skipNextDraftSaveRef = useRef(true);

  const inputFocusTrigger = useStore(s => s.inputFocusTrigger);
  const requestInputFocus = useStore(s => s.requestInputFocus);
  useEffect(() => {
    if (inputFocusTrigger > 0) textareaRef.current?.focus();
  }, [inputFocusTrigger]);

  const addAttachedFile = useStore(s => s.addAttachedFile);
  const removeAttachedFile = useStore(s => s.removeAttachedFile);
  const setAttachedFiles = useStore(s => s.setAttachedFiles);
  const setDocContextAttached = useStore(s => s.setDocContextAttached);
  const clearQuotedSelection = useStore(s => s.clearQuotedSelection);

  const currentDoc = useMemo(() => {
    if (docContextFile) return docContextFile;
    if (!previewOpen || !activeTabId) return null;
    const art = artifacts.find(a => a.id === activeTabId);
    if (!art?.filePath) return null;
    return { path: art.filePath, name: art.title || art.filePath.split('/').pop() || '' };
  }, [docContextFile, previewOpen, activeTabId, artifacts]);
  const hasDoc = !!currentDoc;

  const deskWorkingSetFiles = useMemo(() => {
    if (!deskBasePath) return [];
    const baseDir = deskCurrentPath ? `${deskBasePath}/${deskCurrentPath}` : deskBasePath;
    return deskFiles
      .filter(file => !file.isDir)
      .slice(0, 6)
      .map(file => fileToWorkingSet({ path: `${baseDir}/${file.name}`, name: file.name }, 'desk'));
  }, [deskBasePath, deskCurrentPath, deskFiles]);

  const visibleWorkingSetFiles = useMemo(() => mergeWorkingSetFiles(
    workingSetRecentFiles,
    deskWorkingSetFiles,
  ), [workingSetRecentFiles, deskWorkingSetFiles]);

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
  }, [composerSessionKey, composerText, attachedFiles, quotedSelection, docContextFile, workingSetRecentFiles, saveComposerDraft]);

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

  const diaryFn = useCallback(
    executeDiary(t, showSlashResult, setSlashBusy, setComposerText, setSlashMenuOpen),
    [t, showSlashResult, setComposerText],
  );
  const xingFn = useCallback(async () => {
    setComposerText('');
    setSlashMenuOpen(false);
    await sendAsUser(XING_PROMPT);
  }, [sendAsUser, setComposerText]);
  const compactFn = useCallback(
    executeCompact(setSlashBusy, setComposerText, setSlashMenuOpen),
    [setComposerText],
  );

  const slashCommands = useMemo(
    () => buildSlashCommands(t, diaryFn, xingFn, compactFn),
    [diaryFn, xingFn, compactFn, t],
  );

  const filteredCommands = useMemo(() => {
    if (!composerText.startsWith('/')) return slashCommands;
    const query = composerText.slice(1).toLowerCase();
    return slashCommands.filter(c => c.name.startsWith(query));
  }, [composerText, slashCommands]);

  const handleInputChange = useCallback((value: string) => {
    setComposerText(value);
    if (value.startsWith('/') && value.length <= 20) {
      setSlashMenuOpen(true);
      setSlashSelected(0);
      setAtMenuOpen(false);
    } else {
      setSlashMenuOpen(false);
    }

    const atMatch = value.match(/@(\S*)$/);
    if (atMatch && !value.startsWith('/')) {
      setAtMenuOpen(true);
      setAtQuery(atMatch[1]);
      setAtSelected(0);
    } else {
      setAtMenuOpen(false);
      setAtQuery('');
      setAtResults([]);
    }
  }, [setComposerText]);

  useEffect(() => {
    setAtSelected((index) => {
      if (atResults.length === 0) return 0;
      return Math.min(index, atResults.length - 1);
    });
  }, [atResults]);

  const handleAttachWorkingSetFile = useCallback((file: WorkingSetFile) => {
    if (currentDoc?.path && file.path === currentDoc.path) {
      const next = resolveDocContextToggle(docContextAttached ? currentDoc.path : null, {
        path: currentDoc.path,
        name: currentDoc.name,
      });
      setDocContextAttached(next.attached, next.file);
      rememberWorkingSetFile(fileToWorkingSet(currentDoc, 'current'));
      requestInputFocus();
      return;
    }

    const nextFiles = toggleComposerAttachment(attachedFiles, {
      path: file.path,
      name: file.name,
      isDirectory: file.isDirectory,
    });
    setAttachedFiles(nextFiles);
    rememberWorkingSetFile(file);
    requestInputFocus();
  }, [attachedFiles, currentDoc, docContextAttached, rememberWorkingSetFile, requestInputFocus, setAttachedFiles, setDocContextAttached]);

  const handleAttachCurrentDoc = useCallback(() => {
    if (!currentDoc) return;
    const next = resolveDocContextToggle(docContextAttached ? currentDoc.path : null, {
      path: currentDoc.path,
      name: currentDoc.name,
    });
    setDocContextAttached(next.attached, next.file);
    rememberWorkingSetFile(fileToWorkingSet(currentDoc, 'current'));
    requestInputFocus();
  }, [currentDoc, docContextAttached, rememberWorkingSetFile, requestInputFocus, setDocContextAttached]);

  const handleToggleDocContext = useCallback(() => {
    const next = resolveDocContextToggle(docContextAttached ? currentDoc?.path ?? null : null, currentDoc);
    setDocContextAttached(next.attached, next.file);
    if (currentDoc && next.attached) {
      rememberWorkingSetFile(fileToWorkingSet(currentDoc, 'current'));
    }
    requestInputFocus();
  }, [currentDoc, docContextAttached, rememberWorkingSetFile, requestInputFocus, setDocContextAttached]);

  const handleRestoreLastDraft = useCallback(() => {
    restoreLastSubmittedDraft(composerSessionKey);
    setInlineError(null);
    requestInputFocus();
  }, [composerSessionKey, requestInputFocus, restoreLastSubmittedDraft, setInlineError]);

  const openProvidersSettings = useCallback(() => {
    try { localStorage.setItem('hanako-settings-clicked', '1'); } catch {}
    window.platform?.openSettings?.({
      tab: 'providers',
      providerId: activeModelInfo?.provider ?? null,
      resetProviderSelection: !activeModelInfo?.provider,
    });
  }, [activeModelInfo?.provider]);

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

  const hasContent = composerText.trim().length > 0 || attachedFiles.length > 0 || docContextAttached || !!quotedSelection;
  const canSend = hasContent && connected && !isStreaming;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
  }, [composerText]);

  const placeholder = (() => {
    const yuanPh = t(`yuan.placeholder.${agentYuan}`);
    return (yuanPh && !yuanPh.startsWith('yuan.')) ? yuanPh : t('input.placeholder');
  })();

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (!item.type.startsWith('image/')) continue;
      if (!supportsVision) { e.preventDefault(); return; }
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) continue;
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
      break;
    }
  }, [addAttachedFile, t, supportsVision]);

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

  const currentTaskMode: ComposerTaskMode = isStreaming && composerText.trim() ? 'steer' : 'prompt';
  const contextOverview = useMemo(() => buildComposerContextOverview({
    mode: currentTaskMode,
    composerText,
    attachedFiles,
    docContextAttached,
    currentDoc,
    quotedSelection,
    supportsVision,
    gitContext,
  }), [attachedFiles, composerText, currentDoc, currentTaskMode, docContextAttached, gitContext, quotedSelection, supportsVision]);

  const heldBackLabels = useMemo(() => contextOverview.heldBack.map((item) => {
    switch (item) {
      case 'quote':
        return t('input.contextQuote');
      case 'doc':
        return t('input.contextDoc');
      case 'files':
        return t('input.contextFiles');
      case 'images':
        return t('input.contextImages');
      case 'git':
        return t('input.contextGit');
      default:
        return item;
    }
  }), [contextOverview.heldBack, t]);

  const modelLabel = useMemo(() => {
    if (!activeModelInfo?.id) return null;
    if ('metaLabel' in activeModelInfo && activeModelInfo.metaLabel) {
      return `${activeModelInfo.name} · ${activeModelInfo.metaLabel}`;
    }
    return ('provider' in activeModelInfo && activeModelInfo.provider) ? `${activeModelInfo.provider} / ${activeModelInfo.id}` : activeModelInfo.id;
  }, [activeModelInfo]);

  const contextCardVisible = hasContent;

  const handleSubmitTask = useCallback(async (mode: ComposerTaskMode) => {
    if (mode === 'prompt') {
      if (pendingNewSession && !useStore.getState().selectedFolder && useStore.getState().homeFolder) {
        useStore.setState({ selectedFolder: useStore.getState().homeFolder });
      }
      const hasSendable = !!(composerText.trim() || attachedFiles.length > 0 || docContextAttached || quotedSelection);
      if (!hasSendable || !connected) {
        if (!connected && hasSendable) showSidebarToast(t('chat.needWsConnection'));
        return;
      }
    } else {
      if (!composerText.trim()) return;
    }

    if (sending) return;
    if (mode === 'prompt' && isStreaming) return;

    setSending(true);
    try {
      const prepared = await prepareComposerTask({
        mode,
        composerText,
        attachedFiles,
        docContextAttached,
        currentDoc,
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
        if (docContextAttached) setDocContextAttached(false, null);
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
    composerText,
    connected,
    currentDoc,
    docContextAttached,
    isStreaming,
    pendingNewSession,
    quotedSelection,
    rememberWorkingSetFile,
    sending,
    setDocContextAttached,
    setLastSubmittedDraft,
    setComposerText,
    supportsVision,
    t,
    workingSetRecentFiles,
    gitContext,
  ]);

  const handleSend = useCallback(async () => {
    const text = composerText.trim();

    if (text.startsWith('/') && slashMenuOpen && filteredCommands.length > 0) {
      const cmd = filteredCommands[slashSelected] || filteredCommands[0];
      if (cmd) {
        cmd.execute();
        return;
      }
    }

    await handleSubmitTask('prompt');
  }, [composerText, filteredCommands, handleSubmitTask, slashMenuOpen, slashSelected]);

  const handleAtSelect = useCallback((file: { name: string; path: string; rel: string; isDir: boolean }) => {
    const atMatch = composerText.match(/@(\S*)$/);
    if (atMatch) {
      const before = composerText.slice(0, composerText.length - atMatch[0].length);
      setComposerText(before + '@' + file.name + ' ');
    }
    addAttachedFile({ path: file.path, name: file.name, isDirectory: file.isDir });
    setAtMenuOpen(false);
    setAtQuery('');
    textareaRef.current?.focus();
  }, [composerText, addAttachedFile, setComposerText]);

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
    if (e.key === 'Enter' && !e.shiftKey && !isComposing.current) {
      e.preventDefault();
      if (isStreaming && composerText.trim()) handleSteer(); else handleSend();
    }
  }, [handleAtSelect, handleSend, handleSteer, isStreaming, composerText, slashMenuOpen, filteredCommands, slashSelected, setComposerText, atMenuOpen, atResults, atSelected]);

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
                恢复草稿
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
      {inlineError && !recoverableDraft && (
        <div className={styles['slash-error-bar']}>
          <span className={styles['slash-error-dot']} />
          <span>{inlineError}</span>
        </div>
      )}
      {!slashBusy && !compacting && !inlineError && slashResult && (
        <div className={styles['slash-busy-bar']}><span>{slashResult.text}</span></div>
      )}
      <WorkingSetBar
        files={visibleWorkingSetFiles}
        currentDocPath={currentDoc?.path}
        docContextPath={docContextAttached ? currentDoc?.path ?? null : null}
        attachedPaths={attachedFiles.map(file => file.path)}
        onAttachFile={handleAttachWorkingSetFile}
        onAttachCurrentDoc={handleAttachCurrentDoc}
      />
      {contextCardVisible && (
        <ContextOverviewCard
          mode={contextOverview.mode}
          modelLabel={modelLabel}
          textLength={contextOverview.textLength}
          quotedSummary={contextOverview.quotedSummary}
          docName={contextOverview.docName}
          attachmentNames={contextOverview.attachmentNames}
          imageNames={contextOverview.imageNames}
          gitSummary={contextOverview.gitSummary}
          heldBackLabels={heldBackLabels}
        />
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
      <div className={styles['input-wrapper']}>
        <textarea ref={textareaRef} id="inputBox" className={styles['input-box']} placeholder={placeholder}
          rows={1} spellCheck={false} value={composerText}
          onChange={e => handleInputChange(e.target.value)} onKeyDown={handleKeyDown} onPaste={handlePaste}
          onCompositionStart={() => { isComposing.current = true; }}
          onCompositionEnd={() => { isComposing.current = false; }} />
        <div className={styles['input-bottom-bar']}>
          <div className={styles['input-actions']}>
            <SecurityModeSelector />
            <DocContextButton active={docContextAttached} disabled={!hasDoc} onToggle={handleToggleDocContext} />
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
            <SendButton isStreaming={isStreaming} hasInput={!!composerText.trim()}
              disabled={isStreaming ? false : !canSend} onSend={handleSend} onSteer={handleSteer} onStop={handleStop} />
          </div>
        </div>
      </div>
    </>
  );
}
