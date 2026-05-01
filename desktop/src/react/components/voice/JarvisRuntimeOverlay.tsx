import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useStore } from '../../stores';
import { sendPrompt } from '../../stores/prompt-actions';
import type { ChatListItem, ChatMessage, ContentBlock } from '../../stores/chat-types';
import { JARVIS_RUNTIME_OPEN_EVENT, JARVIS_RUNTIME_START_EVENT, JARVIS_RUNTIME_TOGGLE_EVENT } from '../../services/jarvis-runtime-events';
import { VoiceWsClient, VOICE_STATE, type VoiceHealthStatus, type VoiceState, type VoiceWsClientStats } from '../../services/voice-ws-client';
import type { PcmStats } from '../../services/audio-stream';
import type { PlaybackStats } from '../../services/audio-playback';
import { voiceTextStreamBus, type VoiceStreamEvent } from '../../services/voice-text-stream-bus';
import { IncrementalTtsSegmenter } from '../../services/incremental-tts-segmenter';
import styles from './JarvisRuntimeOverlay.module.css';

export const LYNN_RUNTIME_DISPLAY_NAME = 'Lynn';
export const LYNN_RUNTIME_ARIA_LABEL = 'Lynn Runtime';

type JarvisAction = 'start' | 'end-turn' | 'interrupt-listen' | 'interrupt';

interface JarvisStatus {
  state: VoiceState | string;
  transcript: string;
  assistantReply: string;
  emotion: string | null;
  stats: VoiceWsClientStats | null;
  health: VoiceHealthStatus | null;
  error: string | null;
  inputMode: 'pcm' | null;
  captureStats: PcmStats | null;
  playbackStats: PlaybackStats | null;
}

const INITIAL_STATUS: JarvisStatus = {
  state: VOICE_STATE.IDLE,
  transcript: '',
  assistantReply: '',
  emotion: null,
  stats: null,
  health: null,
  error: null,
  inputMode: null,
  captureStats: null,
  playbackStats: null,
};

export function resolveJarvisPrimaryAction(state: VoiceState | string): JarvisAction {
  if (state === VOICE_STATE.LISTENING) return 'end-turn';
  if (state === VOICE_STATE.SPEAKING) return 'interrupt-listen';
  if (state === VOICE_STATE.THINKING) return 'interrupt';
  return 'start';
}

export function jarvisPrimaryLabel(action: JarvisAction): string {
  switch (action) {
    case 'end-turn':
      return '完成';
    case 'interrupt-listen':
      return '插话';
    case 'interrupt':
      return '中断';
    default:
      return '开始';
  }
}

function stateLabel(state: VoiceState | string): string {
  switch (state) {
    case VOICE_STATE.LISTENING:
      return '正在听';
    case VOICE_STATE.THINKING:
      return '思考中';
    case VOICE_STATE.SPEAKING:
      return '正在说';
    case VOICE_STATE.DEGRADED:
      return '主链异常';
    default:
      return '待机';
  }
}

function formatEmotion(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const label = record.label || record.emotion || record.top || record.category;
  if (typeof label === 'string') return label;
  if (Array.isArray(record.labels) && typeof record.labels[0] === 'string') return record.labels[0];
  return null;
}

function formatStats(stats: VoiceWsClientStats | null): string | null {
  if (!stats) return null;
  const rtt = typeof stats.rttMs === 'number' ? ` · ${Math.round(stats.rttMs)}ms` : '';
  return `↑${stats.pcmFramesOut} ↓${stats.ttsFramesIn}${rtt}`;
}

function formatHealth(health: VoiceHealthStatus | null): string | null {
  if (!health) return null;
  // 2026-05-01 优先用 orchestrator 给的 tierLabel(Tier 1/2 为空字符串 → 不显示)
  if (typeof health.tierLabel === 'string') {
    return health.tierLabel || null;
  }
  // 向后兼容:旧版 server 没返回 tier 时,按 providers 降级情况拼文案
  if (!health.providers) return null;
  if (health.ok && !health.degraded) return null;
  const labels: Record<string, string> = {
    asr: '语音识别',
    ser: '情绪识别',
    tts: '语音合成',
  };
  const degraded = Object.entries(health.providers)
    .filter(([, value]) => value && (!value.ok || value.degraded))
    .map(([key]) => `${labels[key] || key}主链不可用`);
  return degraded.length ? degraded.join(' · ') : null;
}

function textFromAssistantBlock(block: ContentBlock): string {
  if (block.type === 'text') return block.plainText || '';
  if (block.type === 'review') return block.content || '';
  if (block.type === 'file_output') return block.label || '';
  return '';
}

function clampActivityLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * 2026-05-01 P1-② — Voice 上下文 prompt prefix(精简版,2026-05-01 修)。
 *
 * 旧版 5 行 ~120 字,每 turn 重复浪费 token。新版 1 行 ~50 字,关键信号给齐:
 *   ① 短答口语化(限制输出长度)
 *   ② 无 markdown(防 splitTextForTts 切到 ** 中间)
 *   ③ 工具直接执行,不展开候选(memory session_0427 FIX-1 反向)
 *
 * 只加在 requestText,displayText 仍是原转写(chat history 看到原话)。
 */
const VOICE_PROMPT_PREFIX = "[语音对话·短答口语化无markdown·有工具直接执行不展开候选] ";

export function buildVoiceRequestText(transcript: string): string {
  return `${VOICE_PROMPT_PREFIX}${transcript.trim()}`;
}

export function extractAssistantSpeechText(message: ChatMessage | null | undefined): string {
  if (!message || message.role !== 'assistant') return '';
  const blocks = message.blocks || [];
  return blocks.map(textFromAssistantBlock).filter(Boolean).join('\n\n').trim();
}

function assistantMessages(items: ChatListItem[] | undefined): ChatMessage[] {
  return (items || [])
    .filter((item): item is { type: 'message'; data: ChatMessage } => item.type === 'message' && item.data.role === 'assistant')
    .map((item) => item.data);
}

export function JarvisRuntimeOverlay() {
  const addToast = useStore((s) => s.addToast);
  const currentSessionPath = useStore((s) => s.currentSessionPath);
  const isStreaming = useStore((s) => s.isStreaming);
  const currentChatSession = useStore((s) => {
    const path = s.currentSessionPath;
    return path ? s.chatSessions[path] || null : null;
  });
  const currentChatItems = useMemo(() => currentChatSession?.items || [], [currentChatSession]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<JarvisStatus>(INITIAL_STATUS);
  const clientRef = useRef<VoiceWsClient | null>(null);
  const pendingVoiceTurnRef = useRef<{
    transcript: string;
    sessionPath: string | null;
    assistantBaseline: number;
    spokenText: string | null;
    /**
     * 2026-05-01 P0-① 增量 TTS:bus + segmenter 路径已在 fire segments 时设 true,
     * useEffect 兼容路径见到 true 跳过(防同一回复播两遍)。
     */
    incrementalActive: boolean;
  } | null>(null);
  // 2026-05-01 P0-① — 增量 TTS 状态(每个 voice turn 独立)
  const incrementalRef = useRef<{
    segmenter: IncrementalTtsSegmenter;
    unsubscribe: () => void;
    sessionPath: string | null;
    firstEmitted: boolean;
  } | null>(null);

  const tearDownIncremental = useCallback((reason: 'turn_end' | 'error' | 'reset' | 'interrupt') => {
    const inc = incrementalRef.current;
    if (!inc) return;
    incrementalRef.current = null;
    try { inc.unsubscribe(); } catch { /* ignore */ }
    if (reason === 'turn_end') {
      try { inc.segmenter.finish(); } catch { /* ignore */ }
    } else {
      // error/reset/interrupt:不再 fire 残段,重置即可
      try { inc.segmenter.reset(); } catch { /* ignore */ }
    }
    // 2026-05-01 修 B1:tearDown 时一并清 pendingVoiceTurnRef,避免下次 turn 复用错乱。
    // 之前 useEffect 主动清是 race source(第一段 emit 后 ref 立刻 null)。
    if (reason === 'turn_end' || reason === 'error' || reason === 'interrupt') {
      pendingVoiceTurnRef.current = null;
    }
  }, []);

  const ensureClient = useCallback(async () => {
    if (clientRef.current) return clientRef.current;
    const [port, token] = await Promise.all([
      window.platform?.getServerPort?.(),
      window.platform?.getServerToken?.(),
    ]);
    const client = new VoiceWsClient({
      port,
      token,
      mode: 'chat',
      onOpen: () => setStatus((s) => ({ ...s, error: null })),
      onClose: () => {
        pendingVoiceTurnRef.current = null;
        setStatus((s) => ({ ...s, state: VOICE_STATE.IDLE }));
      },
      onError: (err) => {
        const message = err.message || String(err);
        setStatus((s) => ({ ...s, error: message }));
        addToast(`${LYNN_RUNTIME_DISPLAY_NAME} 语音连接失败：${message}`, 'error', 4000, { dedupeKey: 'jarvis-runtime-error' });
      },
      onState: (state) => setStatus((s) => ({
        ...s,
        state: pendingVoiceTurnRef.current && state === VOICE_STATE.IDLE ? s.state : state,
        error: null,
      })),
      onTranscriptPartial: (text) => setStatus((s) => ({ ...s, transcript: text })),
      onTranscriptFinal: (text) => {
        const transcript = text.trim();
        setStatus((s) => ({ ...s, transcript }));
        if (!transcript) return;
        const store = useStore.getState();
        const sessionPath = store.currentSessionPath;
        const baseline = assistantMessages(sessionPath ? store.chatSessions[sessionPath]?.items : []).length;
        pendingVoiceTurnRef.current = {
          transcript,
          sessionPath,
          assistantBaseline: baseline,
          spokenText: null,
          incrementalActive: false,
        };
        setStatus((s) => ({ ...s, state: VOICE_STATE.THINKING, assistantReply: '' }));

        // 2026-05-01 P0-① — 增量 TTS:订阅 chat WS text_delta,见到句子边界
        // 立刻吐到 voice-ws SPEAK_TEXT_APPEND。首音节延迟从 ~3s 砍到 ~0.9s。
        // turn_end 时 finish + unsubscribe;失败/重启 voice 时 tearDown。
        tearDownIncremental('reset'); // 防同 turn 重叠
        const segmenter = new IncrementalTtsSegmenter({
          onSegment: (segment) => {
            // 2026-05-01 修 B1 race fix:
            //   旧实现依赖 pendingVoiceTurnRef.current 作守护,但 useEffect 在
            //   incrementalActive=true 时会主动清 ref → 第一段后 ref=null →
            //   后续 segment onSegment 提前 return → 只读首句 bug。
            //   新实现仅依赖 incrementalRef(本 turn 局部 ref),tearDown 时清。
            //   pendingVoiceTurnRef 仅做 useEffect 兜底跳过判断,不参与 fire 决策。
            const inc = incrementalRef.current;
            if (!inc || inc.segmenter !== segmenter) return;
            const isFirst = !inc.firstEmitted;
            inc.firstEmitted = true;
            // 同步标记 pending(若仍存在)— 让 useEffect 兜底跳过整段播放
            const turn = pendingVoiceTurnRef.current;
            if (turn) {
              turn.incrementalActive = true;
              turn.spokenText = (turn.spokenText || '') + segment;
            }
            if (isFirst) {
              setStatus((s) => ({ ...s, state: VOICE_STATE.SPEAKING, assistantReply: segment }));
            } else {
              setStatus((s) => ({ ...s, assistantReply: (s.assistantReply || '') + segment }));
            }
            void ensureClient().then((client) => {
              if (isFirst) return client.speakText(segment);
              return client.speakTextAppend(segment);
            }).catch((err) => {
              const message = err instanceof Error ? err.message : String(err);
              // 增量路径失败 → 不污染主 turn,记 console;最终的"完整 message"仍可走 useEffect 兜底
              // eslint-disable-next-line no-console
              console.warn('[jarvis] incremental TTS speak failed:', message);
            });
          },
        });
        const baselineSessionPath = sessionPath;
        let lockedSessionPath: string | null = null;
        const handler = (msg: VoiceStreamEvent) => {
          // 锁定 sessionPath:第一次 text_delta/thinking_start 时记下 brain 实际的 sessionPath
          // (sendPrompt 后 currentSessionPath 可能已切到新 session)
          if (msg.type === 'text_delta' || msg.type === 'thinking_start') {
            if (lockedSessionPath === null) {
              lockedSessionPath = (msg.sessionPath as string) || baselineSessionPath || null;
            }
          }
          if (msg.sessionPath && lockedSessionPath && msg.sessionPath !== lockedSessionPath) return;
          // memory feedback_brain_test_persistent_ws / session_0428 CROSS-PROMPT FENCE:
          // turn_end 后 retry text_delta 仍可能流进来,segmenter.finished=true 自动 no-op。
          if (msg.type === 'text_delta' && typeof msg.delta === 'string') {
            segmenter.feed(msg.delta);
          } else if (msg.type === 'turn_end') {
            // finish 会吐剩余 buffer
            tearDownIncremental('turn_end');
          } else if (msg.type === 'error' || msg.type === 'stream_event_close') {
            tearDownIncremental('error');
          }
        };
        const unsubscribe = voiceTextStreamBus.subscribe(handler);
        incrementalRef.current = { segmenter, unsubscribe, sessionPath: baselineSessionPath, firstEmitted: false };

        void sendPrompt({
          text: transcript,
          displayText: transcript,
          requestText: buildVoiceRequestText(transcript),
        }).then((ok) => {
          if (!ok) {
            tearDownIncremental('error');
            pendingVoiceTurnRef.current = null;
            setStatus((s) => ({ ...s, state: VOICE_STATE.IDLE, error: '语音转写已完成，但发送到聊天框失败。' }));
          } else if (pendingVoiceTurnRef.current?.transcript === transcript) {
            pendingVoiceTurnRef.current.sessionPath = useStore.getState().currentSessionPath;
          }
        }).catch((err) => {
          tearDownIncremental('error');
          pendingVoiceTurnRef.current = null;
          const message = err instanceof Error ? err.message : String(err);
          setStatus((s) => ({ ...s, state: VOICE_STATE.DEGRADED, error: `语音转聊天失败：${message}` }));
        });
      },
      onAssistantReply: (text) => setStatus((s) => ({ ...s, assistantReply: text })),
      onEmotion: (emotion) => setStatus((s) => ({ ...s, emotion: formatEmotion(emotion) })),
      onHealth: (health) => setStatus((s) => ({ ...s, health })),
      onStats: (stats) => setStatus((s) => ({ ...s, stats })),
      onCaptureStats: (captureStats) => setStatus((s) => ({ ...s, captureStats })),
      onPlaybackStats: (playbackStats) => setStatus((s) => ({ ...s, playbackStats })),
      stopCaptureOnEndTurn: true,
      // 2026-05-01 P1-① — Tier 1 全双工:关浏览器原生 AEC/NS/AGC,让 server 端
      // tonarino webrtc-audio-processing native AEC 接管(reference signal 在 server
      // 已构造,零 IPC)。平台无 prebuilt → server 自动降级为 mic 直传(等同现状)。
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
    clientRef.current = client;
    return client;
  }, [addToast, tearDownIncremental]);

  useEffect(() => {
    const pending = pendingVoiceTurnRef.current;
    if (!pending || isStreaming) return;
    // 2026-05-01 P0-① + 修 B1:增量路径已 fire → 跳过兜底播放,但 ref 保留
    //   旧实现这里清 ref,会让 segmenter 后续 onSegment 失去守护对象触发 race;
    //   ref 由 tearDownIncremental('turn_end' / 'error' / 'interrupt') 统一清。
    if (pending.incrementalActive) {
      return;
    }
    const sessionPath = pending.sessionPath || currentSessionPath;
    if (!sessionPath || sessionPath !== currentSessionPath) return;
    const assistants = assistantMessages(currentChatItems);
    if (assistants.length <= pending.assistantBaseline) return;
    const latestAssistant = assistants[assistants.length - 1];
    const speechText = extractAssistantSpeechText(latestAssistant);
    if (!speechText || speechText === pending.spokenText) return;
    pending.spokenText = speechText;
    pendingVoiceTurnRef.current = null;
    setStatus((s) => ({ ...s, assistantReply: speechText, state: VOICE_STATE.SPEAKING, error: null }));
    void ensureClient().then((client) => client.speakText(speechText)).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      setStatus((s) => ({ ...s, state: VOICE_STATE.DEGRADED, error: `语音播放失败：${message}` }));
    });
  }, [currentChatItems, currentSessionPath, ensureClient, isStreaming]);

  const startListening = useCallback(async () => {
    pendingVoiceTurnRef.current = null;
    tearDownIncremental('reset');
    setBusy(true);
    setOpen(true);
    setStatus((s) => ({
      ...s,
      error: null,
      transcript: s.state === VOICE_STATE.IDLE ? '' : s.transcript,
      assistantReply: s.state === VOICE_STATE.IDLE ? '' : s.assistantReply,
    }));
    let client: VoiceWsClient | null = null;
    try {
      client = await ensureClient();
      await client.startListening();
      setStatus((s) => ({ ...s, state: VOICE_STATE.LISTENING, inputMode: 'pcm' }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus((s) => ({
        ...s,
        state: VOICE_STATE.DEGRADED,
        inputMode: null,
        error: `Spark 语音主链不可用：${message}`,
      }));
      addToast(`${LYNN_RUNTIME_DISPLAY_NAME} 语音主链不可用：${message}`, 'error', 5000, { dedupeKey: 'jarvis-runtime-start' });
    } finally {
      setBusy(false);
    }
  }, [addToast, ensureClient, tearDownIncremental]);

  const startListeningAfterInterrupt = useCallback(async () => {
    pendingVoiceTurnRef.current = null;
    tearDownIncremental('interrupt');
    setOpen(true);
    setStatus((s) => ({ ...s, error: null }));
    let client: VoiceWsClient | null = null;
    try {
      client = await ensureClient();
      await client.startListening();
      setStatus((s) => ({ ...s, state: VOICE_STATE.LISTENING, inputMode: 'pcm' }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus((s) => ({
        ...s,
        state: VOICE_STATE.DEGRADED,
        inputMode: null,
        error: `Spark 语音主链不可用：${message}`,
      }));
      addToast(`${LYNN_RUNTIME_DISPLAY_NAME} 插话启动失败：${message}`, 'error', 5000, { dedupeKey: 'jarvis-runtime-interrupt-start' });
    }
  }, [addToast, ensureClient, tearDownIncremental]);

  const endTurn = useCallback(async () => {
    setBusy(true);
    try {
      const sent = await clientRef.current?.endTurn();
      setStatus((s) => (
        sent === false
          ? { ...s, state: VOICE_STATE.IDLE, error: '语音连接已断开，请重新开始。' }
          : { ...s, state: VOICE_STATE.THINKING }
      ));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus((s) => ({ ...s, error: message }));
    } finally {
      setBusy(false);
    }
  }, []);

  const interrupt = useCallback(async (listenAfter = false) => {
    pendingVoiceTurnRef.current = null;
    tearDownIncremental('interrupt');
    setBusy(true);
    try {
      if (listenAfter) {
        await startListeningAfterInterrupt();
        return;
      }
      await clientRef.current?.interrupt();
      setStatus((s) => ({ ...s, state: VOICE_STATE.IDLE, error: null }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus((s) => ({ ...s, error: message }));
    } finally {
      setBusy(false);
    }
  }, [startListeningAfterInterrupt, tearDownIncremental]);

  const close = useCallback(() => {
    pendingVoiceTurnRef.current = null;
    tearDownIncremental('reset');
    clientRef.current?.destroy();
    clientRef.current = null;
    setStatus(INITIAL_STATUS);
    setOpen(false);
    setBusy(false);
  }, [tearDownIncremental]);

  const handlePrimary = useCallback(async () => {
    const action = resolveJarvisPrimaryAction(status.state);
    if (action === 'end-turn') {
      await endTurn();
    } else if (action === 'interrupt-listen') {
      await interrupt(true);
    } else if (action === 'interrupt') {
      await interrupt(false);
    } else {
      await startListening();
    }
  }, [endTurn, interrupt, startListening, status.state]);

  useEffect(() => {
    const openHandler = () => setOpen(true);
    const startHandler = () => {
      void startListening();
    };
    const toggleHandler = () => {
      if (open) {
        close();
      } else {
        setOpen(true);
      }
    };
    window.addEventListener(JARVIS_RUNTIME_OPEN_EVENT, openHandler);
    window.addEventListener(JARVIS_RUNTIME_START_EVENT, startHandler);
    window.addEventListener(JARVIS_RUNTIME_TOGGLE_EVENT, toggleHandler);
    return () => {
      window.removeEventListener(JARVIS_RUNTIME_OPEN_EVENT, openHandler);
      window.removeEventListener(JARVIS_RUNTIME_START_EVENT, startHandler);
      window.removeEventListener(JARVIS_RUNTIME_TOGGLE_EVENT, toggleHandler);
    };
  }, [close, open, startListening]);

  useEffect(() => () => {
    pendingVoiceTurnRef.current = null;
    clientRef.current?.destroy();
    clientRef.current = null;
  }, []);

  const primaryAction = useMemo(() => resolveJarvisPrimaryAction(status.state), [status.state]);
  const healthLabel = useMemo(() => formatHealth(status.health), [status.health]);
  const activityActive = status.state === VOICE_STATE.LISTENING || status.state === VOICE_STATE.SPEAKING || status.state === VOICE_STATE.THINKING;
  const activityLevel = status.state === VOICE_STATE.LISTENING
    ? clampActivityLevel((status.captureStats?.avgAmplitude || 0) * 18)
    : status.state === VOICE_STATE.SPEAKING
      ? clampActivityLevel((status.playbackStats?.queueSamples || 0) / 16000)
      : status.state === VOICE_STATE.THINKING
        ? 0.45
        : 0;
  const meterBars = [0.42, 0.72, 0.92, 0.58, 0.78, 0.48, 0.86, 0.64, 0.74, 0.54, 0.82, 0.46];

  if (!open) return null;

  return (
    <section className={styles.shell} aria-label={LYNN_RUNTIME_ARIA_LABEL}>
      <div className={styles.header}>
        <div
          className={styles.orb}
          data-state={status.state}
          data-orb-color={status.health?.orbColor || 'green'}
          data-tier={status.health?.tier || 1}
          aria-hidden="true"
        />
        <div className={styles.titleBlock}>
          <h2 className={styles.title}>{LYNN_RUNTIME_DISPLAY_NAME}</h2>
          <div className={styles.stateLine} aria-live="polite">
            {stateLabel(status.state)}{healthLabel ? ` · ${healthLabel}` : ''}
          </div>
        </div>
        <div className={styles.compactActions}>
          <button className={styles.primaryButton} type="button" onClick={handlePrimary} disabled={busy}>
            {busy ? '处理中' : jarvisPrimaryLabel(primaryAction)}
          </button>
          <button className={styles.secondaryButton} type="button" onClick={() => void interrupt(false)} disabled={busy || status.state === VOICE_STATE.IDLE}>
            停止
          </button>
        </div>
        <button className={styles.closeButton} type="button" onClick={close} aria-label={`关闭 ${LYNN_RUNTIME_DISPLAY_NAME}`}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div
        className={styles.activityMeter}
        data-state={status.state}
        data-active={activityActive ? 'true' : 'false'}
        aria-hidden="true"
      >
        {meterBars.map((height, index) => (
          <span
            key={index}
            style={{
              '--bar-height': `${Math.round(4 + height * 14 + activityLevel * 6)}px`,
              '--bar-delay': `${index * 64}ms`,
            } as CSSProperties}
          />
        ))}
      </div>

      {status.error && <div className={styles.error}>{status.error}</div>}
    </section>
  );
}
