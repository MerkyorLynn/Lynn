/**
 * InputArea — 聊天输入区域 React 组件
 *
 * 子组件拆分到 ./input/ 目录。
 * 斜杠命令逻辑在 ./input/slash-commands.ts。
 */

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import { useStore } from '../stores';
import { hanaFetch } from '../hooks/use-hana-fetch';
import { useI18n } from '../hooks/use-i18n';
import { ensureSession, showSidebarToast } from '../stores/session-actions';
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
import { DeepResearchPanel } from './input/DeepResearchPanel';
import { JARVIS_RUNTIME_START_EVENT } from '../services/jarvis-runtime-events';
import { loadModels } from '../utils/ui-helpers';
import {
  XING_PROMPT, executeDiary, executeCompact, executeClear, executePlan, executeSave, buildSlashCommands,
  buildTaskModeSlashCommands,
  type SlashCommand,
} from './input/slash-commands';
import {
  DEEP_RESEARCH_FETCH_TIMEOUT_MS,
  DEEP_RESEARCH_TIMEOUT_MS,
  formatDeepResearchAssistantText,
  normalizeDeepResearchArtifact,
  normalizeDeepResearchErrorMessage,
  type DeepResearchArtifact,
} from './input/deep-research';
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
import type { ContentBlock } from '../stores/chat-types';
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
const LOCAL_QWEN35_PROVIDER_ID = 'local-qwen35-9b-q4km-imatrix';
const LOCAL_QWEN35_MODEL_ID = 'qwen35-9b-q4km-imatrix';
const LOCAL_QWEN35_ENDPOINT = 'http://127.0.0.1:18099/v1';
const LOCAL_QWEN_PROMPT_DISMISS_KEY = 'lynn-local-model-prompt-dismissed-date';
const LOCAL_QWEN_PROMPT_SHOWN_KEY = 'lynn-local-model-prompt-shown-date';
// 2026-05-24 U3 fix: 60s 太晚,新装用户多半在 60s 内就关或换 provider 了,根本看不到安装 banner。
// 8s 是综合考虑(避免开屏即弹太突兀 + 用户能注意到)。
const LOCAL_QWEN_PROMPT_DELAY_MS = 8_000;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

type LocalQwen35RuntimeStatus = {
  ok?: boolean;
  registered_provider?: boolean;
  runtime?: {
    base_url?: string;
    gui_url?: string;
    pid?: number | null;
    endpoint_running?: boolean;
    endpoint_running_any?: boolean;
    endpoint_loading?: boolean;
    endpoint_occupied?: boolean;
    serves_default_model?: boolean;
    process_alive?: boolean;
    health_status?: number;
    model_ids?: string[];
    foreign_model_ids?: string[];
    slots?: {
      total?: number;
      busy?: number;
    } | null;
    metrics?: {
      prompt_tokens_total?: number | null;
      predicted_tokens_total?: number | null;
      requests_total?: number | null;
    } | null;
    metrics_available?: boolean;
  };
  plan?: {
    base_url?: string;
    observed?: {
      endpoint_running?: boolean;
      endpoint_loading?: boolean;
      endpoint_occupied?: boolean;
      served_model_ids?: string[];
      gguf?: string | null;
      llama_server?: string | null;
    };
    plan?: {
      base_url?: string;
      observed?: {
        endpoint_running?: boolean;
        endpoint_loading?: boolean;
        endpoint_occupied?: boolean;
        served_model_ids?: string[];
        gguf?: string | null;
        llama_server?: string | null;
      };
      hardware?: {
        can_enable?: boolean;
        recommended_runtime?: {
          label?: string;
        };
      };
    };
    hardware?: {
      can_enable?: boolean;
      recommended_runtime?: {
        label?: string;
      };
    };
  };
};

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
  const [localQwenStatus, setLocalQwenStatus] = useState<LocalQwen35RuntimeStatus | null>(null);
  const [localQwenDismissed, setLocalQwenDismissed] = useState(false);
  const [localQwenOptimisticStarting, setLocalQwenOptimisticStarting] = useState(false);
  const [localQwenPanelOpen, setLocalQwenPanelOpen] = useState(false);
  const [localQwenPromptReady, setLocalQwenPromptReady] = useState(false);
  const [localQwenSnoozed, setLocalQwenSnoozed] = useState(() => {
    try {
      const today = todayKey();
      return localStorage.getItem(LOCAL_QWEN_PROMPT_DISMISS_KEY) === today
        || localStorage.getItem(LOCAL_QWEN_PROMPT_SHOWN_KEY) === today;
    } catch {
      return false;
    }
  });
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
  const localQwenModel = useMemo(
    () => models.find(m => m.id === LOCAL_QWEN35_MODEL_ID && m.provider === LOCAL_QWEN35_PROVIDER_ID),
    [models],
  );
  const localQwenServedModelIds = localQwenStatus?.runtime?.model_ids
    || localQwenStatus?.plan?.observed?.served_model_ids
    || localQwenStatus?.plan?.plan?.observed?.served_model_ids
    || [];
  const localQwenDefaultServed = localQwenStatus?.runtime?.serves_default_model === true
    || localQwenServedModelIds.includes(LOCAL_QWEN35_MODEL_ID);
  const localQwenEndpointOccupied = localQwenStatus?.runtime?.endpoint_occupied === true
    || localQwenStatus?.plan?.observed?.endpoint_occupied === true
    || localQwenStatus?.plan?.plan?.observed?.endpoint_occupied === true
    || ((localQwenStatus?.runtime?.endpoint_running_any === true || localQwenStatus?.runtime?.endpoint_running === true)
      && localQwenServedModelIds.length > 0
      && !localQwenDefaultServed);
  const localQwenRunning = localQwenDefaultServed && (
    localQwenStatus?.runtime?.endpoint_running === true
    || localQwenStatus?.plan?.observed?.endpoint_running === true
    || localQwenStatus?.plan?.plan?.observed?.endpoint_running === true
  );
  const localQwenRuntimeLoading = !localQwenEndpointOccupied && (
    localQwenStatus?.runtime?.endpoint_loading === true
    || localQwenStatus?.runtime?.process_alive === true
    || localQwenStatus?.plan?.observed?.endpoint_loading === true
    || localQwenStatus?.plan?.plan?.observed?.endpoint_loading === true
  );
  const localQwenLoading = !localQwenRunning && (
    localQwenOptimisticStarting
      || localQwenRuntimeLoading
  );
  const localQwenStarting = !localQwenRunning && localQwenOptimisticStarting && !localQwenRuntimeLoading;
  const localQwenActive = localQwenRunning || localQwenLoading || localQwenEndpointOccupied;
  const localQwenCurrent = currentModelInfo?.id === LOCAL_QWEN35_MODEL_ID && currentModelInfo?.provider === LOCAL_QWEN35_PROVIDER_ID;
  const localQwenStatusVisible = localQwenActive && !localQwenDismissed;
  const localQwenEndpoint = localQwenStatus?.runtime?.base_url
    || localQwenStatus?.plan?.base_url
    || localQwenStatus?.plan?.plan?.base_url
    || 'http://127.0.0.1:18099/v1';
  const localQwenRuntimeLabel = localQwenStatus?.plan?.hardware?.recommended_runtime?.label
    || localQwenStatus?.plan?.plan?.hardware?.recommended_runtime?.label
    || '本机 32K';
  const localQwenCanEnable = (localQwenStatus?.plan?.hardware?.can_enable
    ?? localQwenStatus?.plan?.plan?.hardware?.can_enable) !== false;
  const localQwenHasModel = !!(localQwenStatus?.plan?.observed?.gguf || localQwenStatus?.plan?.plan?.observed?.gguf);
  const localQwenHasRuntime = !localQwenEndpointOccupied
    && !!(localQwenStatus?.plan?.observed?.llama_server || localQwenStatus?.plan?.plan?.observed?.llama_server);
  const localQwenRecommended = localQwenPromptReady && !!localQwenStatus?.ok && localQwenCanEnable && !localQwenActive && !localQwenDismissed && !localQwenSnoozed;
  const localQwenMetricTokens = Math.round(
    Number(localQwenStatus?.runtime?.metrics?.predicted_tokens_total || 0)
      + Number(localQwenStatus?.runtime?.metrics?.prompt_tokens_total || 0),
  );
  const localQwenMetricsReady = localQwenStatus?.runtime?.metrics_available === true;
  const localQwenSlotSummary = useMemo(() => {
    const slots = localQwenStatus?.runtime?.slots;
    if (!slots?.total) return null;
    const busy = slots.busy || 0;
    const idle = Math.max(0, slots.total - busy);
    return busy > 0 ? `生成中 ${busy}/${slots.total}` : `可用 ${idle}/${slots.total}`;
  }, [localQwenStatus?.runtime?.slots]);
  const localQwenBusySlots = Number(localQwenStatus?.runtime?.slots?.busy || 0);
  const localQwenMetricSummary = localQwenMetricsReady
    ? (localQwenMetricTokens > 0 ? `服务累计处理 ${localQwenMetricTokens.toLocaleString()} tokens` : '服务暂无 token 统计')
    : '运行统计同步中';
  const localQwenColdStartLikely = localQwenRunning && localQwenCurrent && localQwenBusySlots > 0 && localQwenMetricTokens < 800;
  const localQwenWarmupStage = localQwenRunning
    ? 'ready'
    : localQwenStarting
      ? 'launching'
      : localQwenLoading
        ? 'loading'
        : 'checking';
  const localQwenWarmupTitle = localQwenEndpointOccupied
    ? '检测到 Qwen3.5-4B 降级端点正在运行'
    : localQwenRunning
    ? (localQwenCurrent ? '本地 Qwen3.5-9B 正在运行' : '本地 Qwen3.5-9B 已就绪')
    : localQwenWarmupStage === 'launching'
      ? '本地 Qwen3.5-9B 正在启动'
      : localQwenWarmupStage === 'loading'
        ? '本地 Qwen3.5-9B 正在加载'
        : '本地 Qwen3.5-9B 正在连接';
  const localQwenWarmupCopy = localQwenEndpointOccupied
    ? '4B 只作为低配降级/兼容模型，不再作为默认引导；停止该端点后可启动默认 9B MTP。'
    : localQwenRunning
    ? localQwenCurrent
      ? (localQwenColdStartLikely
        ? '本地端点已就绪，正在生成首个回答'
        : `${localQwenRuntimeLabel} · 本地离线运行，不消耗云端额度`)
      : localQwenModel
        ? '已注册到模型列表，可一键切换为本地优先'
        : '端点已就绪，正在同步到模型列表'
    : localQwenWarmupStage === 'launching'
      ? '正在拉起 llama.cpp，本地端点马上接管'
      : localQwenWarmupStage === 'loading'
        ? 'llama.cpp 已启动，正在加载 Qwen3.5-9B 权重'
        : '正在确认本地端点状态，稍后会自动刷新。';
  const localQwenStatusBarClass = [
    styles['local-model-status-bar'],
    (!localQwenRunning || localQwenEndpointOccupied) ? styles['local-model-status-bar-muted'] : '',
    localQwenActive && !localQwenRunning ? styles['local-model-status-bar-busy'] : '',
  ].filter(Boolean).join(' ');
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

  const refreshLocalQwenStatus = useCallback(async (showFeedback = false) => {
    if (showFeedback) {
      showSidebarToast('正在刷新本地模型状态…', 1600, 'info', 'local-qwen-refreshing');
    }
    try {
      const res = await hanaFetch('/api/local-qwen35-9b/status', { timeout: 10_000 });
      const data = await res.json();
      setLocalQwenStatus(data);
      if (data?.runtime?.endpoint_running === true
        || data?.plan?.observed?.endpoint_running === true
        || data?.plan?.plan?.observed?.endpoint_running === true) {
        setLocalQwenOptimisticStarting(false);
      }
      if (data?.registered_provider && data?.plan?.observed?.endpoint_running) {
        void loadModels();
      }
      if (showFeedback) {
        showSidebarToast('本地模型状态已刷新。', 2400, 'success', 'local-qwen-refreshed');
      }
    } catch (err) {
      if (showFeedback) {
        const msg = err instanceof Error ? err.message : String(err);
        showSidebarToast('刷新本地模型状态失败：' + msg, 5000, 'error', 'local-qwen-refresh-failed');
      }
      // Local model readiness is an affordance, not a blocking app health signal.
    }
  }, []);

  const markLocalQwenLoading = useCallback(() => {
    setLocalQwenOptimisticStarting(true);
    setLocalQwenStatus(prev => ({
      ...(prev || { ok: true }),
      ok: prev?.ok ?? true,
      runtime: {
        ...(prev?.runtime || {}),
        base_url: prev?.runtime?.base_url || LOCAL_QWEN35_ENDPOINT,
        endpoint_running: prev?.runtime?.endpoint_running ?? false,
        endpoint_loading: true,
        process_alive: true,
      },
      plan: {
        ...(prev?.plan || {}),
        base_url: prev?.plan?.base_url || LOCAL_QWEN35_ENDPOINT,
        observed: {
          ...(prev?.plan?.observed || {}),
          endpoint_loading: true,
          llama_server: prev?.plan?.observed?.llama_server || 'llama-server',
        },
      },
    }));
  }, []);

  const markLocalQwenStopped = useCallback(() => {
    setLocalQwenOptimisticStarting(false);
    setLocalQwenStatus(prev => ({
      ...(prev || { ok: true }),
      ok: prev?.ok ?? true,
      runtime: {
        ...(prev?.runtime || {}),
        base_url: prev?.runtime?.base_url || LOCAL_QWEN35_ENDPOINT,
        endpoint_running: false,
        endpoint_loading: false,
        process_alive: false,
      },
      plan: {
        ...(prev?.plan || {}),
        base_url: prev?.plan?.base_url || LOCAL_QWEN35_ENDPOINT,
        observed: {
          ...(prev?.plan?.observed || {}),
          endpoint_running: false,
          endpoint_loading: false,
        },
        plan: prev?.plan?.plan
          ? {
              ...prev.plan.plan,
              observed: {
                ...(prev.plan.plan.observed || {}),
                endpoint_running: false,
                endpoint_loading: false,
              },
            }
          : prev?.plan?.plan,
      },
    }));
  }, []);

  const scheduleLocalQwenRefreshBurst = useCallback(() => {
    [0, 250, 750, 1500, 3000, 6000, 12000].forEach(delay => {
      window.setTimeout(() => void refreshLocalQwenStatus(), delay);
    });
  }, [refreshLocalQwenStatus]);

  const ensureCurrentLocalQwenReady = useCallback(async () => {
    if (!localQwenCurrent) return true;

    let endpointRunning = localQwenRunning;
    if (!endpointRunning) {
      try {
        const res = await hanaFetch('/api/local-qwen35-9b/status', { timeout: 3500 });
        const data = await res.json();
        setLocalQwenStatus(data);
        endpointRunning = data?.runtime?.endpoint_running === true
          || data?.plan?.observed?.endpoint_running === true
          || data?.plan?.plan?.observed?.endpoint_running === true;
        if (data?.registered_provider && endpointRunning) {
          void loadModels();
        }
      } catch {
        endpointRunning = false;
      }
    }

    if (endpointRunning) return true;

    setLocalQwenDismissed(false);
    setInlineNotice(null);
    setInlineError('本地 Qwen3.5-9B 未运行。请先点击上方"启动"，或从模型选择器切换到云端模型。');
    showSidebarToast('本地模型还没启动。请先启动本地 Qwen3.5-9B，或切换到云端模型。', 5000, 'warning', 'local-qwen-not-running');
    requestInputFocus();
    return false;
  }, [localQwenCurrent, localQwenRunning, requestInputFocus, setInlineError, setInlineNotice]);

  useEffect(() => {
    void refreshLocalQwenStatus();
    const id = window.setInterval(refreshLocalQwenStatus, 15_000);
    return () => window.clearInterval(id);
  }, [refreshLocalQwenStatus]);

  useEffect(() => {
    const id = window.setTimeout(() => setLocalQwenPromptReady(true), LOCAL_QWEN_PROMPT_DELAY_MS);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    if (!localQwenRecommended) return;
    try {
      localStorage.setItem(LOCAL_QWEN_PROMPT_SHOWN_KEY, todayKey());
    } catch {
      // ignore unavailable storage
    }
  }, [localQwenRecommended]);

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

  const renderAssistantText = useCallback(async (plainText: string): Promise<ContentBlock[]> => {
    const { renderMarkdown } = await import('../utils/markdown');
    return [{ type: 'text' as const, html: renderMarkdown(plainText), plainText }];
  }, []);

  const patchLocalAssistantMessage = useCallback(async (
    sessionPath: string,
    messageId: string,
    plainText: string,
    artifact?: DeepResearchArtifact | null,
  ) => {
    const blocks = await renderAssistantText(plainText);
    const normalizedArtifact = normalizeDeepResearchArtifact(artifact);
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
  }, [renderAssistantText]);

  const handleDeepResearchRun = useCallback(async () => {
    const latestPromptValue = textareaRef.current?.value ?? useStore.getState().composerText ?? inputValue;
    if (latestPromptValue !== inputValue) setInputValue(latestPromptValue);
    if (latestPromptValue !== composerText) setComposerText(latestPromptValue);
    const prompt = latestPromptValue.trim();
    setDeepResearchOpen(true);
    if (!prompt) {
      useStore.getState().addToast?.('先输入一个调研问题，再点“开始深研”', 'info', 3200, {
        dedupeKey: 'deep-research-empty',
      });
      requestInputFocus();
      return;
    }
    if (deepResearchBusy || isStreaming) return;
    if (!serverReady) {
      showSidebarToast(t('chat.serverStarting') || 'Lynn 还在启动中', 4000);
      return;
    }

    const selectedProvider = String(activeModelInfo?.provider || '').trim();
    const selectedModel = String(activeModelInfo?.id || '').trim();
    const selectedModelLabel = String(activeModelInfo?.name || selectedModel || '当前模型').trim();
    const useLocalDeepResearch = /^local-qwen35-/u.test(selectedProvider);
    const useDefaultBrainDeepResearch = selectedProvider === 'brain';
    flushSync(() => {
      setDeepResearchBusy(true);
      setInlineNotice(`深研已启动：正在用 ${selectedModelLabel} 生成答案…`);
      setInlineError(null);
    });
    try {
      if (pendingNewSession && !useStore.getState().selectedFolder && useStore.getState().homeFolder) {
        useStore.setState({ selectedFolder: useStore.getState().homeFolder });
      }
      if (useStore.getState().pendingNewSession) {
        const ok = await ensureSession();
        if (!ok) throw new Error('无法创建新会话');
      }
      const sessionPath = useStore.getState().currentSessionPath;
      if (!sessionPath) throw new Error('当前没有可用会话');

      const renderMarkdown = (await import('../utils/markdown')).renderMarkdown;
      const now = Date.now();
      const userId = `deep-user-${now}`;
      const assistantId = `deep-assistant-${now}`;
      const thinkingText = `深度调研正在使用 ${selectedModelLabel}。`;
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
            model: '深度调研',
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
          sourceLabel: useDefaultBrainDeepResearch ? '默认工作模型' : selectedModelLabel,
          localBaseUrl: useLocalDeepResearch ? localQwenEndpoint : undefined,
          timeoutMs: DEEP_RESEARCH_TIMEOUT_MS,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || `深度调研请求失败 (${response.status})`);
      }

      await patchLocalAssistantMessage(
        sessionPath,
        assistantId,
        formatDeepResearchAssistantText(data),
        data?.artifact,
      );
      setInlineNotice(null);
    } catch (err) {
      const message = normalizeDeepResearchErrorMessage(err);
      const sessionPath = useStore.getState().currentSessionPath;
      const session = sessionPath ? useStore.getState().chatSessions[sessionPath] : null;
      const lastAssistant = session?.items.slice().reverse().find(
        (item) => item.type === 'message' && item.data.role === 'assistant' && item.data.id.startsWith('deep-assistant-'),
      );
      if (sessionPath && lastAssistant?.type === 'message') {
        await patchLocalAssistantMessage(sessionPath, lastAssistant.data.id, `深度调研启动失败：${message}`);
      } else {
        useStore.getState().addToast?.(`深度调研启动失败：${message}`, 'error', 5000);
      }
      setInlineNotice(null);
    } finally {
      setDeepResearchBusy(false);
    }
  }, [
    deepResearchBusy,
    isStreaming,
    patchLocalAssistantMessage,
    pendingNewSession,
    renderAssistantText,
    requestInputFocus,
    serverReady,
    activeModelInfo?.id,
    activeModelInfo?.name,
    activeModelInfo?.provider,
    composerText,
    inputValue,
    localQwenEndpoint,
    setComposerText,
    setInlineError,
    setInlineNotice,
    t,
  ]);

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

  const switchToLocalQwen = useCallback(async () => {
    try {
      await hanaFetch('/api/models/set', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId: LOCAL_QWEN35_MODEL_ID, provider: LOCAL_QWEN35_PROVIDER_ID }),
      });
      await loadModels();
      showSidebarToast('已切换到本地 Qwen3.5-9B。', 4000, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showSidebarToast('切换本地 Qwen3.5-9B 失败：' + msg, 5000, 'error');
    }
  }, []);

  const stopLocalQwen = useCallback(async () => {
    try {
      const managerStop = await window.platform?.llamacppStop?.();
      if (managerStop && managerStop.ok === false) {
        throw new Error(managerStop.reason || 'llamacpp_manager_stop_failed');
      }
      const res = await hanaFetch('/api/local-qwen35-9b/stop', { method: 'POST', timeout: 10_000 });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || 'stop_failed');
      }
      markLocalQwenStopped();
      setLocalQwenDismissed(false);
      await refreshLocalQwenStatus();
      showSidebarToast('本地模型已停止，已释放 llama.cpp。', 4000, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showSidebarToast('停止本地模型失败：' + msg, 5000, 'error');
    }
  }, [markLocalQwenStopped, refreshLocalQwenStatus]);

  const openLocalQwenSettings = useCallback(() => {
    window.platform?.openSettings?.({
      tab: 'providers',
      providerId: LOCAL_QWEN35_PROVIDER_ID,
    });
  }, []);

  const dismissLocalQwenStatus = useCallback(() => {
    const message = localQwenActive
      ? '只是收起本地模型状态条，不会停止模型。之后可点聊天框里的“本地模型状态”恢复，或去“设置 > 模型”停止本地模型。'
      : '收起这条本地模型提示？之后仍可在“设置 > 模型”里启动。';
    if (!window.confirm(message)) return;
    setLocalQwenDismissed(true);
  }, [localQwenActive]);

  const startLocalQwen = useCallback(async () => {
    try {
      flushSync(() => {
        setLocalQwenDismissed(false);
        markLocalQwenLoading();
      });
      scheduleLocalQwenRefreshBurst();
      const managerStart = await window.platform?.llamacppStartDownload?.({ modelId: 'qwen35-9b-q4km-imatrix' });
      if (managerStart) {
        if (managerStart.ok === false) {
          throw new Error(managerStart.reason || 'llamacpp_manager_start_failed');
        }
        await hanaFetch('/api/models/set', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ modelId: LOCAL_QWEN35_MODEL_ID, provider: LOCAL_QWEN35_PROVIDER_ID }),
        }).catch(() => null);
        showSidebarToast('本地 Qwen3.5-9B 正在启动，Lynn 会自动切换到本地模型。', 4500, 'info');
        await loadModels();
        await refreshLocalQwenStatus();
        scheduleLocalQwenRefreshBurst();
        return;
      }
      const res = await hanaFetch('/api/local-qwen35-9b/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authorized: true, variant: 'imatrix', start: true }),
        timeout: 30_000,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data?.ok === false) {
        throw new Error(data?.error || 'start_failed');
      }
      showSidebarToast('本地 Qwen3.5-9B 正在启动，Lynn 会自动切换到本地模型。', 4500, 'info');
      await refreshLocalQwenStatus();
      scheduleLocalQwenRefreshBurst();
    } catch (err) {
      setLocalQwenOptimisticStarting(false);
      const msg = err instanceof Error ? err.message : String(err);
      showSidebarToast('启动本地 Qwen3.5-9B 失败：' + msg, 5000, 'error');
      openLocalQwenSettings();
    }
  }, [markLocalQwenLoading, openLocalQwenSettings, refreshLocalQwenStatus, scheduleLocalQwenRefreshBurst]);

  const openLocalQwenDashboard = useCallback(() => {
    setLocalQwenPanelOpen((open) => !open);
    void refreshLocalQwenStatus();
  }, [refreshLocalQwenStatus]);

  const snoozeLocalQwenPrompt = useCallback(() => {
    try {
      localStorage.setItem(LOCAL_QWEN_PROMPT_DISMISS_KEY, todayKey());
    } catch {
      // ignore unavailable storage
    }
    setLocalQwenSnoozed(true);
    setLocalQwenDismissed(true);
    showSidebarToast('今天不再提醒本地模型安装。你仍可在“设置 > 模型”里随时启动。', 3600, 'info', 'local-qwen-snoozed');
  }, []);

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
      h('input.hintGoal', '输入 /goal 设定一个不达成不停的目标'),
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
      {slashBusy && (
        <div className={styles['slash-busy-bar']}>
          <span className={styles['slash-busy-dot']} />
          <span>{slashCommands.find(c => c.name === slashBusy)?.busyLabel || t('common.executing')}</span>
        </div>
      )}
      {compacting && (
        <div className={`${styles['slash-busy-bar']} ${styles['slash-busy-bar-soft']}`}>
          <span className={styles['slash-busy-dot']} />
          <span>{t('chat.compacting')}，输入会保留；完成后可继续发送</span>
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
      {localQwenStatusVisible && (
        <div className={styles['local-model-status-stack']}>
          <div className={localQwenStatusBarClass}>
            <div className={styles['local-model-status-left']}>
              <span className={styles['local-model-status-dot']} aria-hidden="true" />
              <div className={styles['local-model-status-copy']}>
                <strong>{localQwenWarmupTitle}</strong>
                <span>{localQwenWarmupCopy}</span>
              </div>
            </div>
            <div className={styles['local-model-status-meta']}>
              <span>llama.cpp</span>
              <span>{localQwenMetricSummary}</span>
              {localQwenSlotSummary && <span>{localQwenSlotSummary}</span>}
              <span>{localQwenEndpoint.replace(/^https?:\/\//, '')}</span>
            </div>
            <div className={styles['local-model-status-actions']}>
              {localQwenRunning && localQwenModel && !localQwenCurrent && (
                <button type="button" onClick={switchToLocalQwen}>切换</button>
              )}
              <button type="button" onClick={() => refreshLocalQwenStatus(true)}>刷新</button>
              <button type="button" onClick={openLocalQwenDashboard} aria-expanded={localQwenPanelOpen}>状态</button>
              {localQwenActive && <button type="button" onClick={stopLocalQwen}>停止</button>}
              <button type="button" onClick={dismissLocalQwenStatus} aria-label="收起本地模型状态">×</button>
            </div>
          </div>
          {!localQwenEndpointOccupied && (localQwenColdStartLikely || (localQwenActive && !localQwenRunning)) && (
            <div className={styles['local-model-warmup-note']} role="status" aria-live="polite">
              <strong>首次暖机提示</strong>
              <span>本地 Qwen3.5-9B 刚启动时要加载权重和预热上下文，第一问可能 10-20 秒；暖好后同一会话会明显更快。</span>
            </div>
          )}
          {localQwenPanelOpen && (
            <div className={styles['local-model-status-panel']} role="status" aria-live="polite">
              <div className={styles['local-model-status-panel-head']}>
                <div>
                  <strong>本地 Qwen3.5-9B</strong>
                  <span>{localQwenEndpointOccupied
                    ? '当前端口由 4B 降级/兼容端点占用，默认 9B 尚未启动'
                    : 'Q4_K_M imatrix · MTP 加速 · thinking-on 稳定性优先'}</span>
                </div>
                <button type="button" onClick={() => setLocalQwenPanelOpen(false)} aria-label="收起本地模型状态">×</button>
              </div>
              <div className={styles['local-model-status-panel-grid']}>
                <span><b>端点</b>{localQwenEndpoint}</span>
                <span><b>进程</b>{localQwenStatus?.runtime?.pid ? `PID ${localQwenStatus.runtime.pid}` : localQwenLoading ? '加载中' : '运行中'}</span>
                <span><b>任务槽</b>{localQwenEndpointOccupied ? '非默认端点' : (localQwenSlotSummary || '可用 1/1')}</span>
                <span><b>统计</b>{localQwenMetricSummary}</span>
                {localQwenEndpointOccupied && (
                  <span><b>当前模型</b>{localQwenServedModelIds.join(', ') || '非 9B'}</span>
                )}
              </div>
              <p>{localQwenEndpointOccupied
                ? '这不是默认 9B 引导模型。需要启用默认 9B 时，先停止当前本地端点。'
                : '退出 Lynn 时会自动停止本地模型；需要马上释放内存时点“停止”。'}</p>
            </div>
          )}
        </div>
      )}
      {localQwenActive && localQwenDismissed && (
        <button
          type="button"
          className={styles['local-model-status-restore']}
          onClick={() => {
            setLocalQwenDismissed(false);
            setLocalQwenPanelOpen(true);
          }}
        >
          <span className={styles['local-model-status-dot']} aria-hidden="true" />
          <strong>{localQwenEndpointOccupied ? '4B 降级端点正在运行' : (localQwenRunning ? '本地 Qwen3.5-9B 正在运行' : '本地 Qwen3.5-9B 正在加载')}</strong>
          <span>显示状态</span>
        </button>
      )}
      {!localQwenActive && localQwenModel && localQwenHasModel && localQwenHasRuntime && !localQwenDismissed && (
        <div className={`${styles['local-model-status-bar']} ${styles['local-model-status-bar-muted']}`}>
          <div className={styles['local-model-status-left']}>
            <span className={styles['local-model-status-dot-muted']} aria-hidden="true" />
            <div className={styles['local-model-status-copy']}>
              <strong>{localQwenCurrent ? '当前本地 Qwen3.5-9B 未启动' : '本地 Qwen3.5-9B 未运行'}</strong>
              <span>
                {localQwenCurrent
                  ? '你已选择本地模型。点击启动后，Lynn 会拉起 llama.cpp 并继续使用当前模型。'
                  : '模型文件已就绪。点击启动后，Lynn 会自动拉起本地端点。'}
              </span>
            </div>
          </div>
          <div className={styles['local-model-status-actions']}>
            <button type="button" onClick={startLocalQwen}>启动</button>
            <button type="button" onClick={() => refreshLocalQwenStatus(true)}>刷新</button>
            <button type="button" onClick={dismissLocalQwenStatus} aria-label="收起本地模型状态">×</button>
          </div>
        </div>
      )}
      {localQwenRecommended && (!localQwenModel || !localQwenHasModel || !localQwenHasRuntime) && (
        <div className={`${styles['local-model-status-bar']} ${styles['local-model-status-bar-recommend']}`}>
          <div className={styles['local-model-status-left']}>
            <span className={styles['local-model-status-dot']} aria-hidden="true" />
            <div className={styles['local-model-status-copy']}>
              <strong>可安装本地 Qwen3.5-9B</strong>
              <span>
                {localQwenHasModel && localQwenHasRuntime
                  ? '模型和 llama.cpp 已就绪，授权后即可启动本地离线端点。'
                  : 'Qwen3.5-9B Q4_K_M imatrix MTP · 5.78GB / 5.38GiB · 32K 上下文；授权后自动准备，当前模型照常保留。'}
              </span>
            </div>
          </div>
          <div className={styles['local-model-status-actions']}>
            <button type="button" onClick={openLocalQwenSettings}>安装本地模型</button>
            <button type="button" onClick={snoozeLocalQwenPrompt}>稍后</button>
          </div>
        </div>
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
      {deepResearchOpen && !recoveryMessage && !taskRecoveryMessage && !inlineError && (
        <DeepResearchPanel
          busy={deepResearchBusy}
          isStreaming={isStreaming}
          onClose={() => setDeepResearchOpen(false)}
          onFillTemplate={() => {
            const next = '为我做一份深度调研：';
            if (readLatestInputValue().trim()) {
              useStore.getState().addToast?.('输入框已有内容，未覆盖模板；可以直接开始深研。', 'info', 3000, {
                dedupeKey: 'deep-research-template-kept',
              });
              requestInputFocus();
              return;
            }
            setInputValue(next);
            setComposerText(next);
            useStore.getState().addToast?.('已填入深度调研模板。', 'success', 2200, {
              dedupeKey: 'deep-research-template-filled',
            });
            requestInputFocus();
          }}
          onStart={handleDeepResearchRun}
        />
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
        {inputLargeSummary && (
          <div className={styles['input-large-summary']} title="已保留完整输入内容，发送时会完整提交">
            <span className={styles['input-large-summary-dot']} />
            <span>已载入长文本</span>
            <strong>{inputLargeSummary}</strong>
          </div>
        )}
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
            <button
              type="button"
              className={`${styles['deep-research-pill']} ${deepResearchOpen ? styles['deep-research-pill-active'] : ''}`}
              onClick={() => {
                setDeepResearchOpen((open) => !open);
                requestInputFocus();
              }}
              disabled={deepResearchBusy}
              title="深度调研：生成可预览 HTML 报告"
              aria-pressed={deepResearchOpen}
              aria-label="深度调研"
            >
              <span className={styles['deep-research-pill-mark']}>⌁</span>
              <span>深研</span>
            </button>
            <SecurityModeSelector />
            <WritingModeToggle />
          </div>
          <div className={styles['input-controls']}>
            {activeModelInfo?.reasoning !== false && (
              <ThinkingLevelButton level={thinkingLevel} onChange={setThinkingLevel} modelXhigh={currentModelInfo?.xhigh ?? false} />
            )}
            <ContextRing />
            <div className={styles['send-controls']}>
              <ModelSelector
                models={selectorModels}
                disabled={isStreaming}
                localQwenRunning={localQwenRunning}
                localQwenLoading={localQwenLoading}
              />
              {showModelConfigHint && (
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
      </div>
    </>
  );
}
