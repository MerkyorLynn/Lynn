/**
 * AssistantMessage — 助手消息，遍历 ContentBlock 按类型渲染
 */

import { lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MarkdownContent } from './MarkdownContent';
import { ImageBlock } from './ImageBlock';
import { MoodBlock } from './MoodBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { ExecutionTraceBlock } from './ExecutionTraceBlock';
import { SettingsConfirmCard } from './SettingsConfirmCard';
import { AuthorizationCard } from './AuthorizationCard';
import type { ChatMessage, ContentBlock } from '../../stores/chat-types';
import { useStore } from '../../stores';
import { hanaFetch } from '../../hooks/use-hana-fetch';
import { useI18n } from '../../hooks/use-i18n';
import { openFilePreview, openSkillPreview } from '../../utils/file-preview';
import { openPreview } from '../../stores/artifact-actions';
import { isBundledLynnAvatarSrc, yuanFallbackAvatar } from '../../utils/agent-helpers';
import { buildRetryDraftFromMessage } from '../../utils/composer-state';
import { formatCompactModelLabel } from '../../utils/brain-models';
import { resendPromptRequest } from '../../stores/prompt-actions';
import styles from './Chat.module.css';

/* eslint-disable @typescript-eslint/no-explicit-any */

const XingCard = lazy(() => import('./XingCard').then((m) => ({ default: m.XingCard })));
const DiffViewer = lazy(() => import('./DiffViewer').then((m) => ({ default: m.DiffViewer })));
const WritingDiffViewer = lazy(() => import('./WritingDiffViewer').then((m) => ({ default: m.WritingDiffViewer })));
const ReviewCard = lazy(() => import('./ReviewCard').then((m) => ({ default: m.ReviewCard })));

interface Props {
  message: ChatMessage;
  showAvatar: boolean;
  isLastAssistant: boolean;
}

interface ReviewConfigAgent {
  id: string;
  name: string;
  yuan: string;
  hasAvatar?: boolean;
}

interface ReviewConfigResponse {
  defaultReviewer: 'hanako' | 'butter';
  hanakoReviewerId?: string | null;
  butterReviewerId?: string | null;
  resolvedReviewer?: ReviewConfigAgent | null;
}

const TOOL_LABELS: Record<string, string> = {
  web_search: '搜索中',
  web_fetch: '读取网页',
  weather: '查询天气',
  stock_market: '查询行情',
  stock_research: '股票研究',
  create_pptx: '生成 PPT',
  create_report: '生成报告',
  create_artifact: '创建预览',
  browser: '浏览器操作',
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  bash: '执行命令',
  grep: '搜索内容',
  find: '查找文件',
  ls: '列出目录',
  notify: '发送通知',
  cron: '定时任务',
  todo: '待办管理',
};

function parseMessageModelRef(raw?: string | null): { id: string; provider?: string } | null {
  const value = String(raw || '').trim();
  if (!value) return null;
  const spaced = value.split(/\s+\/\s+/);
  if (spaced.length >= 2 && spaced[0] && spaced.slice(1).join('/')) {
    return { provider: spaced[0], id: spaced.slice(1).join('/') };
  }
  const slashIndex = value.indexOf('/');
  if (slashIndex > 0 && slashIndex < value.length - 1) {
    return { provider: value.slice(0, slashIndex), id: value.slice(slashIndex + 1) };
  }
  const lower = value.toLowerCase();
  if (lower === 'lynn-brain-router') return { provider: 'brain', id: value };
  if (lower === 'qwen35-4b-q4km') {
    return { provider: 'local-qwen35-4b-q4km', id: value };
  }
  if (lower === 'qwen35-9b-q4km-imatrix') {
    return { provider: 'local-qwen35-9b-q4km-imatrix', id: value };
  }
  return { id: value };
}

function formatProviderRouteName(id?: string | null): string {
  const raw = String(id || '').trim();
  if (!raw) return '';
  const lower = raw.toLowerCase();
  if (lower.includes('mimo')) return 'MiMo';
  if (lower.includes('spark') || lower.includes('apex')) return 'Spark';
  if (lower.includes('deepseek')) return 'DeepSeek';
  if (lower.includes('openai') || lower.includes('gpt')) return 'OpenAI';
  if (lower.includes('local')) return 'Local';
  return raw
    .replace(/^qwen\d+[-_]/i, 'Qwen ')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 28);
}

function providerRouteLabel(route?: ChatMessage['providerRoute'] | null): string | null {
  if (!route?.activeProvider) return null;
  const fallback = (route.fallbackFrom || []).map((hop) => formatProviderRouteName(hop.id)).filter(Boolean);
  if (fallback.length === 0) return null;
  const chain = [...fallback, formatProviderRouteName(route.activeProvider)].filter(Boolean);
  return Array.from(new Set(chain)).join(' -> ');
}

function providerRouteTitle(route?: ChatMessage['providerRoute'] | null): string | undefined {
  if (!route?.activeProvider) return undefined;
  const active = formatProviderRouteName(route.activeProvider) || route.activeProvider;
  const fallback = route.fallbackFrom || [];
  if (fallback.length === 0) return `当前回答模型：${active}`;
  const details = fallback
    .map((hop) => {
      const name = formatProviderRouteName(hop.id) || hop.id;
      return hop.reason ? `${name}: ${hop.reason}` : name;
    })
    .join('；');
  return `备用链路已切换到 ${active}。跳过：${details}`;
}

type TtsPlaybackController = {
  stop: () => void;
  finished: Promise<void>;
};

/**
 * 播放 TTS 生成的音频文件。走 IPC readFileBase64 + WebAudio 而非 HTTP — 因为:
 *  1) HTMLAudioElement 不会自动带 Bearer token,直接 audio.src = http://... 会被 server 403
 *  2) Hono c.body(fs.createReadStream) 对 Node Readable Stream 兼容性问题,Audio 解码失败
 *  3) WebAudio 直接解码 ArrayBuffer,绕开 <audio> 对 blob/data source 的兼容性差异
 *
 * [TTS-STOPPABLE v1 · 2026-05-02] 返回 controller{stop, finished} 让 UI 中断长音频播报。
 */
async function playAudioHttpUrl(audioPath: string): Promise<TtsPlaybackController> {
  if (!audioPath) throw new Error('音频路径无效');
  const base64 = await window.hana?.readFileBase64?.(audioPath);
  if (!base64) throw new Error('读取音频文件失败（检查路径白名单）');

  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
  if (AudioContextCtor) {
    const audioContext = new AudioContextCtor();
    if (audioContext.state === 'suspended') {
      await audioContext.resume();
    }
    const buffer = await audioContext.decodeAudioData(bytes.buffer.slice(0));
    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);
    let stopped = false;
    const finished = new Promise<void>((resolve) => {
      source.onended = () => {
        void audioContext.close().catch(() => {});
        resolve();
      };
    });
    try {
      source.start(0);
    } catch (err) {
      void audioContext.close().catch(() => {});
      throw err;
    }
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { source.stop(0); } catch { /* source may already be stopped */ }
    };
    return { stop, finished };
  }

  // Very old WebViews only: fallback to HTMLAudioElement.
  const ext = audioPath.toLowerCase().endsWith('.mp3') ? 'mpeg' : audioPath.toLowerCase().endsWith('.aiff') ? 'aiff' : 'wav';
  const blob = new Blob([bytes], { type: `audio/${ext}` });
  const objectUrl = URL.createObjectURL(blob);
  const audio = new Audio(objectUrl);
  let stopped = false;
  const cleanup = () => URL.revokeObjectURL(objectUrl);
  const finished = new Promise<void>((resolve, reject) => {
    audio.onended = () => { cleanup(); resolve(); };
    audio.onerror = () => {
      const code = audio.error?.code;
      const codeMap: Record<number, string> = { 1: 'aborted', 2: 'network', 3: 'decode', 4: 'src-not-supported' };
      cleanup();
      // aborted = user-initiated stop, treat as resolve
      if (code === 1 || stopped) resolve();
      else reject(new Error(`audio error: ${codeMap[code || 0] || code}`));
    };
    audio.play().catch((err) => { cleanup(); reject(err); });
  });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { audio.pause(); audio.currentTime = 0; } catch { /* best-effort playback stop */ }
    cleanup();
  };
  return { stop, finished };
}

function summarizeToolState(blocks: ContentBlock[]): { running: number; total: number; activeLabel: string } {
  let running = 0;
  let total = 0;
  let activeLabel = '';
  for (const block of blocks) {
    if (block.type !== 'tool_group') continue;
    total += block.tools.length;
    for (const tool of block.tools) {
      if (!tool.done) {
        running++;
        if (!activeLabel) activeLabel = TOOL_LABELS[tool.name] || tool.name;
      }
    }
  }
  return { running, total, activeLabel };
}

function extractPlainTextFromBlocks(blocks: ContentBlock[]): string {
  const textBlocks = blocks.filter((b): b is ContentBlock & { type: 'text' } => b.type === 'text');
  if (textBlocks.length === 0) return '';
  const parser = new DOMParser();
  return textBlocks
    .map((block) => {
      if (typeof block.plainText === 'string') return block.plainText.trim();
      const doc = parser.parseFromString(block.html, 'text/html');
      return (doc.body.innerText || doc.body.textContent || '').trim();
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function reviewerKindFromConfig(config: ReviewConfigResponse | null): 'hanako' | 'butter' {
  return config?.defaultReviewer === 'butter' ? 'butter' : 'hanako';
}

function reviewerNameFromKind(kind: 'hanako' | 'butter'): string {
  return kind === 'butter' ? 'Butter' : 'Hanako';
}

const TRANSLATION_TARGETS = ['英文', '中文', '日文', '韩文', '繁体中文'];
const MAX_TRANSLATE_CHARS = 3_000;

function findLatestReviewBlock(blocks: ContentBlock[]): Extract<ContentBlock, { type: 'review' }> | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i];
    if (block.type === 'review') return block;
  }
  return null;
}

function shouldShowFollowUpAction(reviewBlock: Extract<ContentBlock, { type: 'review' }> | null): boolean {
  if (!reviewBlock || reviewBlock.status !== 'done') return false;
  if (!reviewBlock.followUpPrompt) return false;
  return reviewBlock.workflowGate === 'follow_up' || reviewBlock.workflowGate === 'hold';
}

export const AssistantMessage = memo(function AssistantMessage({ message, showAvatar, isLastAssistant }: Props) {
  const agentName = useStore(s => s.agentName) || 'Lynn';
  const agentYuan = useStore(s => s.agentYuan) || 'hanako';
  const agentAvatarUrl = useStore(s => s.agentAvatarUrl);
  const sessionAgent = useStore(s => s.sessionAgent);
  const addToast = useStore(s => s.addToast);
  const [avatarFailed, setAvatarFailed] = useState(false);

  const displayName = sessionAgent?.name || agentName;
  const displayYuan = sessionAgent?.yuan || agentYuan;
  const fallbackAvatar = useMemo(() => yuanFallbackAvatar(displayYuan), [displayYuan]);
  const avatarSrc = sessionAgent?.avatarUrl || agentAvatarUrl || fallbackAvatar;
  const isBundledLynnAvatar = useMemo(() => isBundledLynnAvatarSrc(avatarSrc), [avatarSrc]);

  useEffect(() => {
    setAvatarFailed(false);
  }, [sessionAgent?.avatarUrl, agentAvatarUrl, fallbackAvatar]);

  const blocks = useMemo(() => message.blocks || [], [message.blocks]);
  const toolGroups = useMemo(
    () => blocks.filter((block): block is Extract<ContentBlock, { type: 'tool_group' }> => block.type === 'tool_group'),
    [blocks],
  );
  const contentBlocks = useMemo(
    () => blocks.filter((block) => block.type !== 'tool_group'),
    [blocks],
  );
  const executionTools = useMemo(
    () => toolGroups.flatMap((group) => group.tools),
    [toolGroups],
  );
  const plainText = useMemo(() => extractPlainTextFromBlocks(blocks), [blocks]);
  const latestReviewBlock = useMemo(() => findLatestReviewBlock(blocks), [blocks]);
  const { running: runningTools, total: totalTools, activeLabel: activeToolLabel } = useMemo(() => summarizeToolState(blocks), [blocks]);
  const isStreamMsg = !!message.id?.startsWith('stream-');
  const appIsStreaming = useStore(s => s.isStreaming);
  const currentModel = useStore(s => s.currentModel);
  const messageModelLabel = useMemo(() => {
    const modelRef = parseMessageModelRef(message.model);
    const isActiveStreamingMessage = isStreamMsg && isLastAssistant && appIsStreaming;
    const fallbackRef = isActiveStreamingMessage ? currentModel : { provider: 'brain', id: 'lynn-brain-router' };
    return formatCompactModelLabel(modelRef || fallbackRef, { role: displayYuan, purpose: 'chat' });
  }, [message.model, currentModel, displayYuan, isStreamMsg, isLastAssistant, appIsStreaming]);
  const providerFallbackLabel = useMemo(() => providerRouteLabel(message.providerRoute), [message.providerRoute]);
  const providerFallbackTitle = useMemo(() => providerRouteTitle(message.providerRoute), [message.providerRoute]);
  const showStreamingMeta = isStreamMsg && (runningTools > 0 || blocks.some(block => block.type === 'thinking' && !block.sealed));
  // T2: TTFT 等待提示——streaming 中但还没有任何实际内容
  const showWaitingHint = isStreamMsg && blocks.length === 0;

  // 等待计时器：显示已等待的秒数
  const [waitSeconds, setWaitSeconds] = useState(0);
  useEffect(() => {
    if (!showWaitingHint) { setWaitSeconds(0); return; }
    const timer = setInterval(() => setWaitSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [showWaitingHint]);

  // 超时提示：等待超过 30 秒未收到内容，提示用户可能是网络问题
  const [waitingTooLong, setWaitingTooLong] = useState(false);
  useEffect(() => {
    if (!showWaitingHint) { setWaitingTooLong(false); return; }
    const timer = setTimeout(() => setWaitingTooLong(true), 15000);
    return () => clearTimeout(timer);
  }, [showWaitingHint]);

  // ── 空回复兜底：模型只产了 thinking 但没给正文 / 工具调用 ──
  // 流已结束 + 至少有一个 thinking block + 没有任何正文 / 工具 / 授权卡片
  // → 用户看到的是"两个折叠的思考完成 chip"然后没了，给个重试入口。
  const isEmptyAnswerAfterThinking = useMemo(() => {
    if (isStreamMsg) return false;
    if (blocks.length === 0) return false;
    if (toolGroups.length > 0) return false;
    if (plainText.length > 0) return false;
    return blocks.some((b) => b.type === 'thinking')
      && blocks.every((b) => b.type === 'thinking' || b.type === 'mood');
  }, [isStreamMsg, blocks, toolGroups, plainText]);

  // ── 模型表现评估：回复质量不佳时提示用户切换模型 ──
  const modelHintDismissKey = 'lynn-model-hint-dismissed';
  const showModelHint = false; // disabled: short response does not mean the model is weak
  const dismissModelHint = useCallback(() => {
    try { localStorage.setItem(modelHintDismissKey, String(Date.now())); } catch { /* localStorage may be unavailable */ }
  }, []);
  const openProvidersFromHint = useCallback(() => {
    dismissModelHint();
    window.platform?.openSettings?.({ tab: 'providers' });
  }, [dismissModelHint]);

  const { t } = useI18n();
  const openLabel = fallbackI18n(t('common.open'), 'Open');
  const [copied, setCopied] = useState(false);
  const [reviewRequestPending, setReviewRequestPending] = useState(false);
  const [pendingReviewId, setPendingReviewId] = useState<string | null>(null);
  const [reviewConfig, setReviewConfig] = useState<ReviewConfigResponse | null>(null);
  const [reviewConfigLoaded, setReviewConfigLoaded] = useState(false);
  const [ttsAudioPath, setTtsAudioPath] = useState<string | null>(null);
  // [TTS-STOPPABLE v1 · 2026-05-02] 长音频中断控制
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const ttsControllerRef = useRef<TtsPlaybackController | null>(null);
  const stopTtsPlayback = useCallback(() => {
    const ctrl = ttsControllerRef.current;
    ttsControllerRef.current = null;
    setTtsPlaying(false);
    try { ctrl?.stop(); } catch { /* best-effort playback stop */ }
  }, []);
  // 卸载时清理:防止用户切换/删除消息时音频还在跑
  useEffect(() => () => stopTtsPlayback(), [stopTtsPlayback]);

  // ── P0 [2026-05-28]: TTS pre-synth on streaming end ──────────────
  // streaming 结束时,如果用户开了 lynn-tts-auto-prefetch + 内容 > 50 字,后台
  // fire-and-forget 调 tts_speak 把音频烤进 plugin cache。用户点喇叭时大概率
  // 直接缓存命中,即时播放(0 等待)。短内容(<50字)不触发避免烧 quota。
  const prefetchFiredRef = useRef(false);
  useEffect(() => {
    if (isStreamMsg) return;                          // 还在 streaming,等
    if (prefetchFiredRef.current) return;             // 已 fire 过(防重)
    if (!plainText || plainText.length < 50) return;  // 太短,不值得 prefetch
    let enabled = false;
    try { enabled = localStorage.getItem('lynn-tts-auto-prefetch') === '1'; } catch { /* localStorage may be unavailable */ }
    if (!enabled) return;
    prefetchFiredRef.current = true;
    // Fire-and-forget,失败也不影响用户体验
    hanaFetch('/api/tools/tts-bridge.tts_speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: plainText.slice(0, 3000),
        filename: `msg_${message.id?.slice(-8) || Date.now()}`,
      }),
      timeout: 60_000,
    })
      .then(res => res.json())
      .then(data => {
        const audioPath = data?.details?.path || data?.result?.details?.path;
        if (audioPath) setTtsAudioPath(audioPath);  // 预设 path 让用户点喇叭直接走 startPlayback 分支
      })
      .catch(() => { /* silent */ });
  }, [isStreamMsg, plainText, message.id]);

  // ── P2 [2026-05-28]: Browser SpeechSynthesis instant fallback ──
  // Shift+click 喇叭 → 浏览器原生 TTS,TTFB <50ms,完全本地。音色弱但 draft 朗读 OK
  const speakViaBrowser = useCallback((text: string) => {
    try {
      const u = new SpeechSynthesisUtterance(text);
      // 中文 / 英文 自动选择
      const isZh = /[一-鿿]/.test(text.slice(0, 100));
      u.lang = isZh ? 'zh-CN' : 'en-US';
      u.rate = 1.0;
      window.speechSynthesis.cancel();  // 清掉前一个
      window.speechSynthesis.speak(u);
      return true;
    } catch (e) {
      console.warn('[tts] browser SpeechSynthesis failed:', e);
      return false;
    }
  }, []);
  const [translateTarget, setTranslateTarget] = useState('英文');
  const [translatedText, setTranslatedText] = useState<string | null>(null);
  const [translateBusy, setTranslateBusy] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  const reviewBusy = reviewRequestPending || !!pendingReviewId || latestReviewBlock?.status === 'loading';
  const canRequestReview = plainText.length > 0 && !showStreamingMeta;
  const showFollowUpAction = shouldShowFollowUpAction(latestReviewBlock);
  const showReviewActions = canRequestReview || showFollowUpAction || isLastAssistant;

  useEffect(() => {
    if (!isLastAssistant) return;

    let cancelled = false;
    const loadConfig = () => {
      hanaFetch('/api/review/config')
        .then((res) => res.json())
        .then((data) => {
          if (!cancelled) setReviewConfig(data);
        })
        .catch((err) => {
          console.warn('[review] config load failed:', err);
        })
        .finally(() => {
          if (!cancelled) setReviewConfigLoaded(true);
        });
    };

    loadConfig();
    const handleSettingsFocus = () => loadConfig();
    const handleReviewConfigChanged = () => loadConfig();
    window.addEventListener('focus', handleSettingsFocus);
    window.addEventListener('review-config-changed', handleReviewConfigChanged);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', handleSettingsFocus);
      window.removeEventListener('review-config-changed', handleReviewConfigChanged);
    };
  }, [isLastAssistant]);

  useEffect(() => {
    if (!pendingReviewId) return;
    if (latestReviewBlock?.reviewId !== pendingReviewId) return;
    setPendingReviewId(null);
  }, [latestReviewBlock, pendingReviewId]);

  const defaultReviewerKind = reviewerKindFromConfig(reviewConfig);
  const defaultReviewerName = reviewerNameFromKind(defaultReviewerKind);
  const reviewTargetLabel = reviewConfigLoaded
    ? defaultReviewerName
    : (isLastAssistant ? (t('review.loading') || 'Loading') : (t('review.auto') || 'Auto select'));
  const reviewButtonLabel = `${t('review.button') || 'Review'} ${reviewConfigLoaded ? defaultReviewerName : (t('review.auto') || 'Auto select')}`;
  const showActionRail = !showStreamingMeta && (showReviewActions || !!plainText || isLastAssistant);

  const openReviewSettings = useCallback((reviewerKind?: 'hanako' | 'butter', reviewerAgentId?: string | null) => {
    if (reviewerAgentId) {
      window.platform?.openSettings?.({ tab: 'agent', agentId: reviewerAgentId });
      return;
    }
    window.platform?.openSettings?.({ tab: 'work', reviewerKind: reviewerKind ?? null });
  }, []);

  const resolveReviewConfig = useCallback(async (): Promise<ReviewConfigResponse | null> => {
    if (reviewConfigLoaded) return reviewConfig;
    try {
      const res = await hanaFetch('/api/review/config');
      const data = await res.json() as ReviewConfigResponse;
      setReviewConfig(data);
      setReviewConfigLoaded(true);
      return data;
    } catch (err) {
      console.warn('[review] config load failed:', err);
      setReviewConfigLoaded(true);
      return reviewConfig;
    }
  }, [reviewConfig, reviewConfigLoaded]);

  const handleReview = useCallback(async () => {
    if (reviewBusy || !plainText) return;

    const config = await resolveReviewConfig();
    const reviewerKind = reviewerKindFromConfig(config);
    setReviewRequestPending(true);
    try {
      const res = await hanaFetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: plainText, reviewerKind }),
      });
      const data = await res.json().catch(() => null) as { reviewId?: string } | null;
      setPendingReviewId(typeof data?.reviewId === 'string' ? data.reviewId : null);
    } catch (err) {
      const messageText = err instanceof Error ? err.message : String(err);
      const normalized = messageText.replace(/^hanaFetch\s+\S+:\s*/, '').trim();
      console.error('[review] request failed:', err);
      if (/reviewer_not_configured/i.test(messageText) || /Hanako reviewer|Butter reviewer|Settings > Work/.test(messageText)) {
        addToast(normalized || (t('review.needsConfig') || 'Configure a reviewer first'), 'error');
        openReviewSettings(reviewerKind);
      } else {
        addToast(normalized || (t('review.requestFailed') || 'Review request failed'), 'error');
      }
      setPendingReviewId(null);
    } finally {
      setReviewRequestPending(false);
    }
  }, [addToast, openReviewSettings, plainText, resolveReviewConfig, reviewBusy, t]);

  const handleCopy = useCallback(() => {
    if (!plainText) return;
    const setOK = () => { setCopied(true); setTimeout(() => setCopied(false), 1500); };
    // [COPY-FIX 2026-05-05] navigator.clipboard 在 Electron 失焦/权限场景会 reject,fallback 到 execCommand
    const legacyFallback = () => {
      try {
        // eslint-disable-next-line no-restricted-syntax -- Electron clipboard fallback needs a temporary textarea for execCommand when navigator.clipboard rejects.
        const ta = document.createElement('textarea');
        ta.value = plainText;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.setAttribute('readonly', '');
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        const ok = document.execCommand('copy');
        document.body.removeChild(ta);
        if (ok) setOK();
      } catch { /* swallow */ }
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(plainText).then(setOK).catch(legacyFallback);
    } else {
      legacyFallback();
    }
  }, [plainText]);

  const handleTranslate = useCallback(async () => {
    if (!plainText || translateBusy) return;
    if (showStreamingMeta) {
      addToast('回复完成后再翻译', 'info');
      return;
    }
    if (plainText.length > MAX_TRANSLATE_CHARS) {
      const msg = `文本超过 ${MAX_TRANSLATE_CHARS} 字，请先拆成更短片段再翻译。`;
      setTranslateError(msg);
      addToast(msg, 'error');
      return;
    }
    setTranslateBusy(true);
    setTranslateError(null);
    try {
      const res = await hanaFetch('/api/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: plainText,
          targetLanguage: translateTarget,
        }),
        timeout: 70_000,
      });
      const data = await res.json().catch(() => null) as { text?: string; message?: string; error?: string } | null;
      if (!res.ok || !data?.text) {
        throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
      }
      setTranslatedText(data.text);
      addToast(`已翻译成${translateTarget}`, 'success');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTranslateError(msg);
      addToast(`翻译失败：${msg}`, 'error');
    } finally {
      setTranslateBusy(false);
    }
  }, [addToast, plainText, showStreamingMeta, translateBusy, translateTarget]);

  useEffect(() => {
    setTranslatedText(null);
    setTranslateError(null);
  }, [plainText, translateTarget]);


  const handleRetry = useCallback(() => {
    const state = useStore.getState();
    const sessionPath = state.currentSessionPath;
    if (!sessionPath) return;
    const chatSession = state.chatSessions[sessionPath];
    if (!chatSession?.items) return;

    for (let i = chatSession.items.length - 1; i >= 0; i--) {
      const item = chatSession.items[i];
      if (item.type !== 'message' || item.data.id !== message.id) continue;
      for (let j = i - 1; j >= 0; j--) {
        const prev = chatSession.items[j];
        if (prev.type !== 'message' || prev.data.role !== 'user') continue;
        if (prev.data.requestText) {
          if (resendPromptRequest(prev.data.requestText, prev.data.requestImages, sessionPath)) {
            return;
          }
        }
        const draft = buildRetryDraftFromMessage(prev.data);
        state.applyComposerDraft(draft);
        state.requestInputFocus();
        return;
      }
      return;
    }
  }, [message.id]);

  const handleReviewFollowUp = useCallback(() => {
    if (!latestReviewBlock?.followUpPrompt) return;
    const state = useStore.getState();
    state.applyComposerDraft({ text: latestReviewBlock.followUpPrompt });
    state.requestInputFocus();
  }, [latestReviewBlock]);

  const handleReviewTaskCreated = useCallback(() => {
    useStore.getState().setActivePanel('activity');
  }, []);

  return (
    <div className={`${styles.messageGroup} ${styles.messageGroupAssistant}`}>
      {showAvatar && (
        <div className={styles.avatarRow}>
          {!avatarFailed ? (
            <span className={styles.avatar}>
              <img
                className={`${styles.hanaAvatar}${isBundledLynnAvatar ? ` ${styles.hanaAvatarBundledLynn}` : ''}`}
                src={avatarSrc}
                alt={displayName}
                draggable={false}
                onError={(e) => {
                  const img = e.target as HTMLImageElement;
                  if (img.src.endsWith(fallbackAvatar)) {
                    img.onerror = null;
                    setAvatarFailed(true);
                    return;
                  }
                  img.onerror = null;
                  img.src = fallbackAvatar;
                }}
              />
            </span>
          ) : (
            <span className={`${styles.avatar} ${styles.userAvatar}`}>🌸</span>
          )}
          <span className={styles.avatarName}>{displayName}</span>
          {messageModelLabel && (
            <span className={styles.avatarMeta}>
              {messageModelLabel}
            </span>
          )}
          {providerFallbackLabel && (
            <span className={`${styles.avatarMeta} ${styles.providerRouteMeta}`} title={providerFallbackTitle}>
              {providerFallbackLabel}
            </span>
          )}
          {showStreamingMeta && (
            <span className={styles.avatarMeta}>
              {runningTools > 0 ? activeToolLabel + ' ' + runningTools + '/' + totalTools : (t('chat.thinking') || '正在思考')}
              <span className={styles.thinkingDots}><span /><span /><span /></span>
            </span>
          )}
          {showWaitingHint && !showStreamingMeta && (
            <span className={styles.avatarMeta}>
              {waitSeconds > 0 ? (t('chat.waiting') || '等待回复') + ' ' + waitSeconds + 's' : (t('chat.waiting') || '等待回复')}
              <span className={styles.thinkingDots}><span /><span /><span /></span>
            </span>
          )}
          {waitingTooLong && showWaitingHint && (
            <span className={styles.avatarMetaWarn}>
              {t('chat.waitingTooLong') || '响应较慢，可能正在切换备用模型...'}
            </span>
          )}
        </div>
      )}
      <div className={`${styles.message} ${styles.messageAssistant}`}>
        {executionTools.length > 0 && (
          <ExecutionTraceBlock tools={executionTools} />
        )}
        {contentBlocks.map((block, i) => (
        <ContentBlockView
          key={`block-${i}`}
          block={block}
          agentName={displayName}
          agentYuan={displayYuan}
          agentAvatarUrl={avatarSrc}
          agentModelLabel={messageModelLabel}
          openLabel={openLabel}
          stateKey={message.id}
          sourceResponse={plainText}
          onReviewTaskCreated={handleReviewTaskCreated}
        />
        ))}
        {showActionRail && (
          <div className={styles.messageActionRail}>
            <div className={styles.messageActionRailMain}>
              {showReviewActions && (
                <div className={styles.reviewActionGroup} data-last-assistant={isLastAssistant ? 'true' : 'false'}>
                  {canRequestReview && (
                    <button
                      className={styles.reviewBtn}
                      onClick={handleReview}
                      disabled={reviewBusy}
                      title={reviewButtonLabel}
                      aria-label={reviewButtonLabel}
                    >
                      <span className={styles.reviewBtnPrefix}>{t('review.button') || 'Review'}</span>
                      <span className={styles.reviewBtnTarget}>{reviewTargetLabel}</span>
                    </button>
                  )}
                  {showFollowUpAction && (
                    <button
                      className={`${styles.reviewBtn} ${styles.reviewFollowUpBtn}`}
                      onClick={handleReviewFollowUp}
                      title={t('review.followUp') || 'Handle review findings'}
                      aria-label={t('review.followUp') || 'Handle review findings'}
                    >
                      <span className={styles.reviewBtnPrefix}>{t('review.followUp') || 'Handle findings'}</span>
                    </button>
                  )}
                  {isLastAssistant && (
                    <button
                      className={styles.reviewConfigBtn}
                      onClick={() => openReviewSettings(defaultReviewerKind, reviewConfig?.resolvedReviewer?.id || null)}
                      title={t('review.configure') || 'Configure reviewer'}
                      aria-label={t('review.configure') || 'Configure reviewer'}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 3a2.5 2.5 0 0 1 2.45 2h1.13a2 2 0 0 1 1.73 1l.57.99 1-.58a2 2 0 0 1 2.73.73l1 1.73a2 2 0 0 1-.73 2.73l-.98.57.57.99a2 2 0 0 1 0 2l-.57.99.98.57a2 2 0 0 1 .73 2.73l-1 1.73a2 2 0 0 1-2.73.73l-1-.58-.57.99a2 2 0 0 1-1.73 1h-1.13a2.5 2.5 0 0 1-4.9 0H8.55a2 2 0 0 1-1.73-1l-.57-.99-1 .58a2 2 0 0 1-2.73-.73l-1-1.73a2 2 0 0 1 .73-2.73l.98-.57-.57-.99a2 2 0 0 1 0-2l.57-.99-.98-.57a2 2 0 0 1-.73-2.73l1-1.73a2 2 0 0 1 2.73-.73l1 .58.57-.99a2 2 0 0 1 1.73-1h1.13A2.5 2.5 0 0 1 12 3Z" />
                        <circle cx="12" cy="12" r="3" />
                      </svg>
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className={styles.messageActionRailIcons}>
              {!!plainText && (
                <span className={styles.msgTranslateGroup}>
                  <select
                    className={styles.msgTranslateSelect}
                    value={translateTarget}
                    onChange={(e) => setTranslateTarget(e.target.value)}
                    title="选择译文语言"
                    aria-label="选择译文语言"
                  >
                    {TRANSLATION_TARGETS.map((target) => (
                      <option key={target} value={target}>{target}</option>
                    ))}
                  </select>
                  <button
                    className={styles.msgTranslateBtn}
                    onClick={handleTranslate}
                    disabled={translateBusy || showStreamingMeta}
                    title={`翻译成${translateTarget}`}
                    aria-label={`翻译成${translateTarget}`}
                  >
                    {translateBusy ? '翻译中' : '翻译'}
                  </button>
                </span>
              )}
              <button className={`${styles.msgCopyBtn}${copied ? ` ${styles.msgCopyBtnCopied}` : ''}`} onClick={handleCopy} title={t('common.copyText')} aria-label={t('common.copyText')}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  {copied
                    ? <polyline points="20 6 9 17 4 12" />
                    : <>
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </>
                  }
                </svg>
              </button>
              <button
                className={styles.msgCopyBtn}
                onClick={async (e) => {
                  // P2 [2026-05-28]: Shift+click → 浏览器原生 SpeechSynthesis(TTFB <50ms,本地)
                  if (e.shiftKey) {
                    if (window.speechSynthesis.speaking) {
                      window.speechSynthesis.cancel();
                      addToast('已停止浏览器朗读', 'info');
                      return;
                    }
                    const ok = speakViaBrowser(plainText.slice(0, 3000));
                    if (ok) addToast('浏览器朗读中(Shift+点击停止)', 'info');
                    else addToast('浏览器 TTS 不可用', 'error');
                    return;
                  }
                  // [TTS-STOPPABLE v1 · 2026-05-02] toggle:正在朗读 → 立即停;否则启动播放
                  if (ttsPlaying) {
                    stopTtsPlayback();
                    addToast('已停止朗读', 'info');
                    return;
                  }
                  const startPlayback = async (audioPath: string, toastText: string) => {
                    const controller = await playAudioHttpUrl(audioPath);
                    ttsControllerRef.current = controller;
                    setTtsPlaying(true);
                    addToast(toastText, 'success');
                    controller.finished.finally(() => {
                      // 播完或被 stop 后清状态(stopTtsPlayback 已先清,此处兜底)
                      if (ttsControllerRef.current === controller) {
                        ttsControllerRef.current = null;
                        setTtsPlaying(false);
                      }
                    });
                  };
                  try {
                    if (ttsAudioPath) {
                      try {
                        await startPlayback(ttsAudioPath, '正在朗读 · 再按一次停止');
                        return;
                      } catch {
                        setTtsAudioPath(null);
                      }
                    }
                    addToast('准备朗读…', 'info');
                    const res = await hanaFetch('/api/tools/tts-bridge.tts_speak', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({
                        text: plainText.slice(0, 3000),
                        filename: `msg_${message.id?.slice(-8) || Date.now()}`,
                      }),
                      timeout: 60_000,
                    });
                    const data = await res.json();
                    const audioPath = data?.details?.path || data?.result?.details?.path;
                    if (!audioPath) {
                      addToast('TTS 返回缺失 path', 'error');
                      return;
                    }
                    setTtsAudioPath(audioPath);
                    try {
                      const cached = data?.details?.cached || data?.result?.details?.cached;
                      await startPlayback(audioPath, cached ? '正在朗读（已缓存）· 再按一次停止' : '正在朗读 · 再按一次停止 · 右键换音色');
                    } catch (err: any) {
                      addToast(`播放失败：${err?.message || err}。音频已保存，可在 Voice 设置里检查服务状态。`, 'error');
                    }
                  } catch (err) {
                    addToast(String(err), 'error');
                  }
                }}
                title={ttsPlaying ? '停止朗读' : (t('chat.speak') || '朗读 · Shift+点击=即时浏览器朗读 · 右键音色设置')}
                aria-label={ttsPlaying ? '停止朗读' : (t('chat.speak') || '朗读')}
                aria-pressed={ttsPlaying}
                onContextMenu={(e) => {
                  e.preventDefault();
                  window.hana?.openSettings?.('voice');
                }}
              >
                {ttsPlaying ? (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="6" y="6" width="12" height="12" rx="1.5" />
                  </svg>
                ) : (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                  </svg>
                )}
              </button>
              {isLastAssistant && (
                <button className={styles.msgCopyBtn} onClick={handleRetry} title={t('chat.retry') || 'Retry'} aria-label={t('chat.retry') || 'Retry'}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="1 4 1 10 7 10" />
                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        )}
        {(translatedText || translateError) && (
          <div className={styles.translationCard}>
            <div className={styles.translationCardHead}>
              <span>{translateError ? '翻译失败' : `译文 · ${translateTarget}`}</span>
              {translatedText && (
                <button
                  className={styles.translationCardCopy}
                  onClick={() => navigator.clipboard.writeText(translatedText).then(() => addToast('译文已复制', 'success')).catch(() => {})}
                >
                  复制
                </button>
              )}
            </div>
            <div className={styles.translationCardBody}>
              {translateError || translatedText}
            </div>
          </div>
        )}
        {showModelHint && (
          <div className={styles.modelHintBar}>
            <span className={styles.modelHintText}>
              {t('chat.modelHint') || '当前模型回复较简短，切换到更强的模型可能效果更好'}
            </span>
            <button className={styles.modelHintBtn} onClick={openProvidersFromHint}>
              {t('chat.modelHintAction') || '去设置'}
            </button>
            <button className={styles.modelHintDismiss} onClick={dismissModelHint}>×</button>
          </div>
        )}
        {isEmptyAnswerAfterThinking && (
          <div className={styles.modelHintBar}>
            <span className={styles.modelHintText}>
              {t('chat.emptyAnswerHint') || '模型只想了想，没说出话来。可以点重试再试一次。'}
            </span>
            <button className={styles.modelHintBtn} onClick={handleRetry}>
              {t('chat.emptyAnswerRetry') || '重试'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
});

const ContentBlockView = memo(function ContentBlockView({ block, agentName, agentYuan, agentAvatarUrl, agentModelLabel, openLabel, stateKey, sourceResponse, onReviewTaskCreated }: {
  block: ContentBlock;
  agentName: string;
  agentYuan?: string;
  agentAvatarUrl?: string | null;
  agentModelLabel?: string | null;
  openLabel: string;
  stateKey?: string;
  sourceResponse?: string;
  onReviewTaskCreated?: () => void;
}) {
  switch (block.type) {
    case 'thinking':
      return <ThinkingBlock content={block.content} sealed={block.sealed} modelLabel={agentModelLabel} />;
    case 'mood':
      return <MoodBlock yuan={block.yuan} text={block.text} />;
    case 'text':
      return <MarkdownContent html={block.html} stateKey={stateKey} />;
    case 'xing':
      return (
        <Suspense fallback={null}>
          <XingCard title={block.title} content={block.content} sealed={block.sealed} agentName={agentName} />
        </Suspense>
      );
    case 'file_output':
      return <FileOutputCard filePath={block.filePath} label={block.label} ext={block.ext} openLabel={openLabel} />;
    case 'file_diff': {
      const ext = (block.filePath.split('.').pop() || '').toLowerCase();
      const isProse = ext === 'md' || ext === 'markdown' || ext === 'txt';
      return (
        <Suspense fallback={null}>
          {isProse
            ? <WritingDiffViewer filePath={block.filePath} diff={block.diff} linesAdded={block.linesAdded} linesRemoved={block.linesRemoved} rollbackId={block.rollbackId} />
            : <DiffViewer filePath={block.filePath} diff={block.diff} linesAdded={block.linesAdded} linesRemoved={block.linesRemoved} rollbackId={block.rollbackId} />}
        </Suspense>
      );
    }
    case 'artifact':
      return <ArtifactCard title={block.title} artifactType={block.artifactType} artifactId={block.artifactId} content={block.content} language={block.language} />;
    case 'browser_screenshot':
      return <BrowserScreenshot base64={block.base64} mimeType={block.mimeType} />;
    case 'skill':
      return <SkillCard skillName={block.skillName} skillFilePath={block.skillFilePath} />;
    case 'cron_confirm':
      return <CronConfirmCard confirmId={(block as any).confirmId} jobData={block.jobData} status={block.status} />;
    case 'settings_confirm':
      return <SettingsConfirmCard {...block} />;
    case 'tool_authorization':
      return <AuthorizationCard
        confirmId={(block as any).confirmId}
        command={(block as any).command}
        reason={(block as any).reason}
        description={(block as any).description}
        category={(block as any).category}
        identifier={(block as any).identifier}
        trustedRoot={(block as any).trustedRoot}
        status={(block as any).status}
      />;
    case 'review':
      return (
        <Suspense fallback={null}>
          <ReviewCard
            reviewId={(block as any).reviewId}
            reviewerName={(block as any).reviewerName}
            reviewerAgent={(block as any).reviewerAgent}
            reviewerAgentName={(block as any).reviewerAgentName}
            reviewerYuan={(block as any).reviewerYuan}
            reviewerHasAvatar={(block as any).reviewerHasAvatar}
            reviewerModelLabel={(block as any).reviewerModelLabel}
            executorName={agentName}
            executorYuan={agentYuan}
            executorAvatarUrl={agentAvatarUrl}
            executorModelLabel={agentModelLabel}
            content={(block as any).content}
            error={(block as any).error}
            errorCode={(block as any).errorCode}
            status={(block as any).status}
            stage={(block as any).stage}
            findingsCount={(block as any).findingsCount}
            verdict={(block as any).verdict}
            workflowGate={(block as any).workflowGate}
            structured={(block as any).structured}
            contextPack={(block as any).contextPack}
            followUpPrompt={(block as any).followUpPrompt}
            followUpTask={(block as any).followUpTask}
            sourceResponse={sourceResponse}
            fallbackNote={(block as any).fallbackNote}
            onFollowUpTaskCreated={onReviewTaskCreated}
          />
        </Suspense>
      );
    default:
      return null;
  }
});

const EXT_LABELS: Record<string, string> = {
  pdf: 'PDF', doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel',
  ppt: 'Presentation', pptx: 'Presentation', md: 'Markdown', txt: 'Text',
  html: 'HTML', htm: 'HTML', css: 'Stylesheet', json: 'JSON', yaml: 'YAML', yml: 'YAML',
};

function extLabel(ext: string): string {
  return EXT_LABELS[ext.toLowerCase()] || ext.toUpperCase();
}

function fallbackI18n(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback;
  const trimmed = String(value).trim();
  if (/^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/i.test(trimmed)) return fallback;
  return trimmed;
}

function FileOutputCard({
  filePath,
  label,
  ext,
  openLabel,
}: {
  filePath: string;
  label: string;
  ext: string;
  openLabel: string;
}) {
  const [mdHtml, setMdHtml] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [externalDiff, setExternalDiff] = useState<{
    diff: string; linesAdded: number; linesRemoved: number; rollbackId?: string;
  } | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const isMd = ext === 'md' || ext === 'markdown';
  const isProse = isMd || ext === 'txt';
  const isZh = String(document?.documentElement?.lang || '').startsWith('zh');

  useEffect(() => {
    if (!isMd) return;
    let cancelled = false;
    window.platform?.readFile?.(filePath)?.then((content: string | null) => {
      if (cancelled || !content) return;
      import('../../utils/markdown').then(({ renderMarkdown }) => {
        if (!cancelled) setMdHtml(renderMarkdown(content));
      });
    });
    return () => { cancelled = true; };
  }, [filePath, isMd]);

  const handleViewExternalDiff = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (diffLoading) return;
    if (externalDiff) {
      // 已显示则切换隐藏
      setExternalDiff(null);
      return;
    }
    setDiffLoading(true);
    setDiffError(null);
    try {
      const res = await hanaFetch('/api/fs/external-diff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath }),
      });
      const data = await res.json();
      if (!data.hasChanges) {
        setDiffError(data.message || (isZh ? '无外部修改' : 'No external changes'));
        return;
      }
      setExternalDiff({
        diff: data.diff,
        linesAdded: data.linesAdded,
        linesRemoved: data.linesRemoved,
        rollbackId: data.rollbackId,
      });
    } catch (err) {
      const raw = err instanceof Error ? err.message : '';
      setDiffError(raw.replace(/^hanaFetch\s+\S+:\s*/, '').trim() || (isZh ? '对比失败' : 'Diff failed'));
    } finally {
      setDiffLoading(false);
    }
  }, [diffLoading, externalDiff, filePath, isZh]);

  return (
    <div
      className={styles.fileOutputCard}
      style={isMd && mdHtml ? { flexDirection: 'column', alignItems: 'stretch', maxWidth: '100%' } : undefined}
    >
      <div className={styles.fileOutputHead}>
        <span className={styles.fileOutputBadge}>{extLabel(ext)}</span>
        <span className={styles.fileOutputLabel}>{label || filePath.split('/').pop() || filePath}</span>
        <div className={styles.fileOutputActions}>
          <button type="button" className={styles.fileOutputOpen} onClick={() => openFilePreview(filePath, label, ext)}>
            {openLabel}
          </button>
          {isProse && (
            <button
              type="button"
              className={styles.fileOutputOpen}
              onClick={handleViewExternalDiff}
              disabled={diffLoading}
              title={isZh ? '对比 Git HEAD 以查看外部工具（如 Claude Code / VSCode）的修改' : 'Compare with git HEAD to view external edits'}
            >
              {diffLoading
                ? (isZh ? '… 对比中' : '… Comparing')
                : externalDiff
                  ? (isZh ? '隐藏对比' : 'Hide diff')
                  : (isZh ? '对比外部修改' : 'External diff')}
            </button>
          )}
          {isMd && mdHtml && (
            <button
              type="button"
              className={styles.fileOutputToggle}
              onClick={(e) => { e.stopPropagation(); setCollapsed(c => !c); }}
              aria-label={collapsed ? 'Expand preview' : 'Collapse preview'}
            >
              {collapsed ? '▶' : '▼'}
            </button>
          )}
        </div>
      </div>
      <div className={styles.fileOutputPath}>{filePath}</div>
      {diffError && (
        <div style={{
          marginTop: 8, padding: '6px 10px', fontSize: '0.78rem',
          color: 'var(--text-muted)', background: 'var(--overlay-subtle, rgba(0,0,0,0.03))',
          borderRadius: 4,
        }}>{diffError}</div>
      )}
      {externalDiff && (
        <div style={{ marginTop: 8 }}>
          <Suspense fallback={null}>
            <WritingDiffViewer
              filePath={filePath}
              diff={externalDiff.diff}
              linesAdded={externalDiff.linesAdded}
              linesRemoved={externalDiff.linesRemoved}
              rollbackId={externalDiff.rollbackId}
            />
          </Suspense>
        </div>
      )}
      {isMd && mdHtml && !collapsed && (
        <div
          className="md-content"
          style={{
            marginTop: '8px',
            padding: '12px',
            background: 'var(--bg-card, var(--bg))',
            borderRadius: '6px',
            border: '1px solid var(--overlay-light, rgba(0,0,0,0.06))',
            fontSize: '0.88rem',
            lineHeight: '1.6',
            maxHeight: '400px',
            overflowY: 'auto',
            wordBreak: 'break-word',
          }}
          dangerouslySetInnerHTML={{ __html: mdHtml }}
        />
      )}
    </div>
  );
}

function ArtifactCard({ title, artifactType, artifactId, content, language }: {
  title: string;
  artifactType: string;
  artifactId: string;
  content: string;
  language?: string;
}) {
  const t = window.t ?? ((p: string) => p);
  const handleOpenPreview = () => openPreview({ id: artifactId, type: artifactType as any, title, content, language });
  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    handleOpenPreview();
  };

  return (
    <div
      className={styles.fileOutputCard}
      style={{ cursor: 'pointer' }}
      role="button"
      tabIndex={0}
      onClick={handleOpenPreview}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.fileOutputHead}>
        <span className={styles.fileOutputBadge}>{artifactType.toUpperCase()}</span>
        <span className={styles.fileOutputLabel}>{title}</span>
        {artifactType === 'html' && (
          <div className={styles.fileOutputActions}>
            <button
              type="button"
              className={styles.fileOutputOpen}
              onClick={(e) => { e.stopPropagation(); window.platform?.openHtmlInBrowser?.(content, title); }}
            >
              {t('preview.openInBrowser')}
            </button>
            <button
              type="button"
              className={styles.fileOutputOpen}
              onClick={async (e) => {
                e.stopPropagation();
                if (!window.platform?.exportHtmlToPng) return;
                const result = await window.platform.exportHtmlToPng(content, title);
                if (!result?.filePath) {
                  // Web 降级或失败 — 静默,等后续可加 toast
                  return;
                }
                // 已自动 showItemInFolder 在 main 侧
              }}
            >
              {t('preview.exportPng')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function BrowserScreenshot({ base64, mimeType }: { base64: string; mimeType: string }) {
  return <ImageBlock className={styles.browserShot} src={`data:${mimeType};base64,${base64}`} alt="Browser Screenshot" />;
}

function SkillCard({ skillName, skillFilePath }: { skillName: string; skillFilePath: string }) {
  return (
    <button
      className={styles.fileOutputCard}
      onClick={() => openSkillPreview(skillName, skillFilePath)}
    >
      <div className={styles.fileOutputHead}>
        <span className={styles.fileOutputBadge}>SKILL</span>
        <span className={styles.fileOutputLabel}>{skillName}</span>
      </div>
      <div className={styles.fileOutputPath}>{skillFilePath}</div>
    </button>
  );
}

function CronConfirmCard({ confirmId, jobData, status }: { confirmId?: string; jobData: any; status: string }) {
  const { t } = useI18n();
  const addToast = useStore((s) => s.addToast);
  const [submitting, setSubmitting] = useState(false);

  const sendDecision = useCallback(async (action: 'approved' | 'rejected') => {
    if (!confirmId || submitting) return;
    setSubmitting(true);
    try {
      await hanaFetch(`/api/cron/confirm/${confirmId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      addToast(action === 'approved' ? t('common.saved') : t('common.cancelled'), 'success');
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSubmitting(false);
    }
  }, [addToast, confirmId, submitting, t]);

  return (
    <div className={styles.cronConfirmCard}>
      <div className={styles.cronConfirmTitle}>{jobData.label || t('cron.confirm.title')}</div>
      <div className={styles.cronConfirmMeta}>{jobData.schedule}</div>
      <div className={styles.cronConfirmPrompt}>{jobData.prompt}</div>
      {status === 'pending' && confirmId && (
        <div className={styles.cronConfirmActions}>
          <button onClick={() => sendDecision('rejected')} disabled={submitting}>{t('common.cancel')}</button>
          <button onClick={() => sendDecision('approved')} disabled={submitting}>{t('common.confirm')}</button>
        </div>
      )}
    </div>
  );
}
