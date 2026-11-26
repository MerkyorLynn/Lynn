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
import { D, isChineseLocale } from '../../utils/locale';

export const LYNN_RUNTIME_DISPLAY_NAME = 'Lynn';
export const LYNN_RUNTIME_ARIA_LABEL = 'Lynn voice assistant';

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

const AUTO_RESUME_AFTER_SPEECH_MS = 1200;

export function resolveJarvisPrimaryAction(state: VoiceState | string): JarvisAction {
  if (state === VOICE_STATE.LISTENING) return 'end-turn';
  if (state === VOICE_STATE.SPEAKING) return 'interrupt-listen';
  if (state === VOICE_STATE.THINKING) return 'interrupt';
  return 'start';
}

export function shouldAutoResumeVoiceListening(previous: VoiceState | string, next: VoiceState | string, enabled: boolean): boolean {
  return enabled && previous === VOICE_STATE.SPEAKING && next === VOICE_STATE.IDLE;
}

function tr(key: string, fallback: string): string {
  const value = typeof window === 'undefined'
    ? undefined
    : (window as { t?: (key: string) => string }).t?.(key);
  return value && value !== key ? value : fallback;
}

export function jarvisPrimaryLabel(action: JarvisAction): string {
  switch (action) {
    case 'end-turn':
      return tr('jarvis.action.endTurn', '完成本轮');
    case 'interrupt-listen':
      return tr('jarvis.action.interruptListen', '插话');
    case 'interrupt':
      return tr('jarvis.action.interrupt', '停止');
    default:
      return tr('jarvis.action.start', '实时对话');
  }
}

function stateLabel(state: VoiceState | string): string {
  switch (state) {
    case VOICE_STATE.LISTENING:
      return tr('jarvis.state.listening', '正在听 · 说完点完成本轮');
    case VOICE_STATE.THINKING:
      return tr('jarvis.state.thinking', '思考中');
    case VOICE_STATE.SPEAKING:
      return tr('jarvis.state.speaking', '正在用语音回答');
    case VOICE_STATE.DEGRADED:
      return tr('jarvis.state.degraded', '语音服务异常');
    default:
      return tr('jarvis.state.idle', '安静环境点实时对话');
  }
}

function modeHint(state: VoiceState | string): string {
  if (state === VOICE_STATE.LISTENING) return tr('jarvis.hint.listening', '正在听；嘈杂环境说完点“完成本轮”。');
  if (state === VOICE_STATE.SPEAKING) return tr('jarvis.hint.speaking', '正在朗读回答，结束后会自动继续听；点“插话”可打断。');
  if (state === VOICE_STATE.THINKING) return tr('jarvis.hint.thinking', '正在组织回答，完成后会直接语音播报。');
  return tr('jarvis.hint.idle', '点一次进入连续语音；播报结束会自动继续听，点停止/关闭退出。');
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
    asr: D('语音识别', 'Speech recognition'),
    ser: D('情绪识别', 'Emotion detection'),
    tts: D('语音合成', 'Speech synthesis'),
  };
  const degraded = Object.entries(health.providers)
    .filter(([, value]) => value && (!value.ok || value.degraded))
    .map(([key]) => D(`${labels[key] || key}主链不可用`, `${labels[key] || key} primary route unavailable`));
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
// #32: voice prompt prefix — language-aware (was: hardcoded Chinese)
// English speakers were getting a Chinese system instruction prepended invisibly.
const VOICE_PROMPT_PREFIX_ZH = "[语音模式·你是Lynn·直接回答用户问题·短答口语化·无markdown·有工具直接执行] ";
const VOICE_PROMPT_PREFIX_EN = "[Voice mode · you are Lynn · answer directly · short conversational answer · no markdown · execute tools directly] ";

function resolveVoicePrefix(): string {
  try {
    const locale = (window as unknown as { i18n?: { locale?: string } }).i18n?.locale
      || (typeof navigator !== 'undefined' ? navigator.language : '')
      || '';
    return locale.toLowerCase().startsWith('zh') || locale.toLowerCase().startsWith('ja') || locale.toLowerCase().startsWith('ko')
      ? VOICE_PROMPT_PREFIX_ZH
      : VOICE_PROMPT_PREFIX_EN;
  } catch {
    return VOICE_PROMPT_PREFIX_ZH;
  }
}

export function buildVoiceRequestText(transcript: string): string {
  return `${resolveVoicePrefix()}${transcript.trim()}`;
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
  // 2026-06-11: voice transport mode. 'realtime' = StepFun Realtime full-duplex (primary).
  // On a DEGRADED frame we first RECONNECT realtime (the brain session reconnects cleanly —
  // verified e2e); only after REALTIME_MAX_RETRIES consecutive failures do we flip to 'chat'
  // (the DGX ASR→model→TTS fallback). A healthy SPEAKING frame resets the retry counter.
  const voiceModeRef = useRef<'realtime' | 'chat'>('realtime');
  const realtimeRetryRef = useRef(0);
  // Set when the user hits 停止/× so an in-flight DEGRADED can't auto-reconnect and resurrect the
  // session (that race made the overlay "refuse to close"). Cleared on the next explicit start.
  const userStoppedRef = useRef(false);
  const degradeFallbackRef = useRef<(() => void) | null>(null);
  const autoContinueRef = useRef(false);
  const latestStateRef = useRef<VoiceState | string>(INITIAL_STATUS.state);
  const previousStateRef = useRef<VoiceState | string>(INITIAL_STATUS.state);
  const autoResumeTimerRef = useRef<number | null>(null);
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
      // 2026-06-11: StepFun Realtime full-duplex (mode='realtime', Brain-hosted shared key) is the
      // primary path; voiceModeRef flips to 'chat' (DGX ASR→model→TTS) after repeated failures. The
      // server's /voice-ws route maps mode→RealtimeVoiceSession|VoiceSession.
      mode: voiceModeRef.current,
      onOpen: () => setStatus((s) => ({ ...s, error: null })),
      onClose: () => {
        pendingVoiceTurnRef.current = null;
        setStatus((s) => ({ ...s, state: VOICE_STATE.IDLE }));
      },
      onError: (err) => {
        const message = err.message || String(err);
        setStatus((s) => ({ ...s, error: message }));
        addToast(`${LYNN_RUNTIME_DISPLAY_NAME}${D(' 语音连接失败：', ' voice connection failed: ')}${message}`, 'error', 4000, { dedupeKey: 'jarvis-runtime-error' });
      },
      onState: (state) => {
        // A healthy turn (assistant speaking, or a reconnected session reaching LISTENING) means
        // realtime is viable → clear the retry budget so transient blips don't accrue toward DGX.
        if (state === VOICE_STATE.SPEAKING || state === VOICE_STATE.LISTENING) realtimeRetryRef.current = 0;
        // Realtime engine reported DEGRADED → reconnect realtime first, DGX only as last resort.
        if (state === VOICE_STATE.DEGRADED && voiceModeRef.current === 'realtime') {
          degradeFallbackRef.current?.();
          return;
        }
        setStatus((s) => ({
          ...s,
          state: pendingVoiceTurnRef.current && state === VOICE_STATE.IDLE && s.state !== VOICE_STATE.SPEAKING ? s.state : state,
          error: null,
        }));
      },
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
            setStatus((s) => ({ ...s, state: VOICE_STATE.IDLE, error: D('语音转写已完成，但发送到聊天框失败。', 'Transcription finished, but sending it to the composer failed.') }));
          } else if (pendingVoiceTurnRef.current?.transcript === transcript) {
            pendingVoiceTurnRef.current.sessionPath = useStore.getState().currentSessionPath;
          }
        }).catch((err) => {
          tearDownIncremental('error');
          pendingVoiceTurnRef.current = null;
          const message = err instanceof Error ? err.message : String(err);
          setStatus((s) => ({ ...s, state: VOICE_STATE.DEGRADED, error: `${D('语音转聊天失败：', 'Sending the transcript to chat failed: ')}${message}` }));
        });
	      },
	      onAssistantReply: (text) => setStatus((s) => ({ ...s, assistantReply: text })),
      onEmotion: (emotion) => setStatus((s) => ({ ...s, emotion: formatEmotion(emotion) })),
      onHealth: (health) => setStatus((s) => ({ ...s, health })),
      onStats: (stats) => setStatus((s) => ({ ...s, stats })),
      onCaptureStats: (captureStats) => setStatus((s) => ({ ...s, captureStats })),
      onPlaybackStats: (playbackStats) => setStatus((s) => ({ ...s, playbackStats })),
	      // realtime duplex: StepFun server-VAD owns turn boundaries, so an accidental "end turn"
	      // tap must NOT stop the continuous mic stream (it would silently go deaf). chat/PTT keeps
	      // the original stop-on-end-turn behavior.
      stopCaptureOnEndTurn: voiceModeRef.current !== 'realtime',
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
      setStatus((s) => ({ ...s, state: VOICE_STATE.DEGRADED, error: `${D('语音播放失败：', 'Voice playback failed: ')}${message}` }));
    });
  }, [currentChatItems, currentSessionPath, ensureClient, isStreaming]);

  const startListening = useCallback(async () => {
	    autoContinueRef.current = true;
	    userStoppedRef.current = false; // explicit (re)start clears the stop guard
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
        error: `${D('语音服务不可用：', 'Voice service unavailable: ')}${message}`,
      }));
      addToast(`${LYNN_RUNTIME_DISPLAY_NAME}${D(' 语音服务不可用：', ' voice service unavailable: ')}${message}`, 'error', 5000, { dedupeKey: 'jarvis-runtime-start' });
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
        error: `${D('语音服务不可用：', 'Voice service unavailable: ')}${message}`,
      }));
      addToast(`${LYNN_RUNTIME_DISPLAY_NAME}${D(' 插话启动失败：', ' failed to start talking over: ')}${message}`, 'error', 5000, { dedupeKey: 'jarvis-runtime-interrupt-start' });
    }
  }, [addToast, ensureClient, tearDownIncremental]);

  const endTurn = useCallback(async () => {
    setBusy(true);
    try {
      const sent = await clientRef.current?.endTurn();
      setStatus((s) => (
        sent === false
          ? { ...s, state: VOICE_STATE.IDLE, error: D('语音连接已断开，请重新开始。', 'The voice connection dropped. Please start again.') }
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
    // 2026-05-02 修:旧版"插话"路径整段 await startListeningAfterInterrupt()
    // (含 ensureClient + startListening 启 mic,可能 100ms-秒级)期间 busy=true,
    // 两个按钮全 disabled(变暗灰看似"黑"),用户没法再次中断 → UI 死锁。
    // 拆成两步:
    //   ① 永远先 fire client.interrupt() — 几 ms 内真停 PCM 推 + flush worklet,
    //      不依赖 listenAfter,setBusy 只包这一段
    //   ② listenAfter=true → fire-and-forget 启 mic,不阻塞 setBusy(false)
    pendingVoiceTurnRef.current = null;
    tearDownIncremental('interrupt');
    // 停止 (listenAfter=false): also stop the mic. In realtime duplex the stream keeps feeding
    // StepFun otherwise, so it would keep replying and the session would "refuse to stop".
    if (!listenAfter) { autoContinueRef.current = false; userStoppedRef.current = true; clientRef.current?.stopCapture?.(); }
    setBusy(true);
    try {
      await clientRef.current?.interrupt();
      setStatus((s) => ({ ...s, state: VOICE_STATE.IDLE, error: null }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus((s) => ({ ...s, error: message }));
    } finally {
      setBusy(false);
    }
    if (listenAfter) {
      // 不阻塞 busy:用户可在 mic 起来期间继续点别的(再点中断 / 点关闭)
      void startListeningAfterInterrupt().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        setStatus((s) => ({ ...s, state: VOICE_STATE.DEGRADED, error: `${D('插话启动失败:', 'Failed to start talking over: ')}${message}` }));
      });
    }
  }, [startListeningAfterInterrupt, tearDownIncremental]);

  const close = useCallback(() => {
    autoContinueRef.current = false;
    userStoppedRef.current = true; // block any in-flight degrade reconnect from reopening
    if (autoResumeTimerRef.current !== null) {
      window.clearTimeout(autoResumeTimerRef.current);
      autoResumeTimerRef.current = null;
    }
    pendingVoiceTurnRef.current = null;
    tearDownIncremental('reset');
    clientRef.current?.destroy();
    clientRef.current = null;
    voiceModeRef.current = 'realtime'; // fresh open retries the realtime primary
    realtimeRetryRef.current = 0;
    setStatus(INITIAL_STATUS);
    setOpen(false);
    setBusy(false);
  }, [tearDownIncremental]);

  // Wire the degrade recovery. Defined after startListening so the ref breaks the
  // ensureClient↔startListening dependency cycle. The brain realtime session reconnects cleanly
  // (verified e2e: reconnect + same-session continuation both work), so a DEGRADED frame first
  // RECONNECTS realtime; only after REALTIME_MAX_RETRIES consecutive failures (the counter is
  // cleared by a healthy SPEAKING frame) do we fall back to the DGX 'chat' pipeline.
  useEffect(() => {
    const REALTIME_MAX_RETRIES = 5;
    degradeFallbackRef.current = () => {
      if (userStoppedRef.current) return; // user hit 停止/×; do not resurrect the session
      if (voiceModeRef.current !== 'realtime') return; // already on DGX → onState renders degraded
      try { clientRef.current?.destroy(); } catch { /* ignore */ }
      clientRef.current = null;
      if (realtimeRetryRef.current >= REALTIME_MAX_RETRIES) {
        voiceModeRef.current = 'chat';
        addToast(`${LYNN_RUNTIME_DISPLAY_NAME}${D(' 实时语音多次中断，已切换备用引擎', ' realtime voice kept dropping, so a fallback engine took over')}`, 'warning', 4000, { dedupeKey: 'jarvis-runtime-fallback' });
      } else {
        // Silent reconnect — a healthy LISTENING/SPEAKING frame resets the count, so transient
        // idle-closes recover transparently without toast spam.
        realtimeRetryRef.current += 1;
      }
      void startListening().catch(() => { /* startListening sets its own DEGRADED UI */ });
    };
  }, [addToast, startListening]);

  useEffect(() => {
    const previous = previousStateRef.current;
    latestStateRef.current = status.state;
    previousStateRef.current = status.state;
    if (!open || !shouldAutoResumeVoiceListening(previous, status.state, autoContinueRef.current)) return;
    if (autoResumeTimerRef.current !== null) window.clearTimeout(autoResumeTimerRef.current);
    autoResumeTimerRef.current = window.setTimeout(() => {
      autoResumeTimerRef.current = null;
      if (!open || !autoContinueRef.current || latestStateRef.current !== VOICE_STATE.IDLE) return;
      void startListening().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        setStatus((s) => ({ ...s, state: VOICE_STATE.DEGRADED, inputMode: null, error: `${D('自动续听失败：', 'Automatic re-listen failed: ')}${message}` }));
      });
    }, AUTO_RESUME_AFTER_SPEECH_MS);
    return () => {
      if (autoResumeTimerRef.current !== null) {
        window.clearTimeout(autoResumeTimerRef.current);
        autoResumeTimerRef.current = null;
      }
    };
  }, [open, startListening, status.state]);

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
    // #17: Esc dismisses overlay when open (was: only × button)
    const escHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener(JARVIS_RUNTIME_OPEN_EVENT, openHandler);
    window.addEventListener(JARVIS_RUNTIME_START_EVENT, startHandler);
    window.addEventListener(JARVIS_RUNTIME_TOGGLE_EVENT, toggleHandler);
    window.addEventListener('keydown', escHandler);
    return () => {
      window.removeEventListener('keydown', escHandler);
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
      ? clampActivityLevel((status.playbackStats?.queueSamples || 0) / 24000)
      : status.state === VOICE_STATE.THINKING
        ? 0.45
        : 0;
  const meterBars = [0.42, 0.72, 0.92, 0.58, 0.78, 0.48, 0.86, 0.64, 0.74, 0.54, 0.82, 0.46];

  if (!open) return null;

  return (
    <section className={styles.shell} aria-label={tr('jarvis.ariaLabel', LYNN_RUNTIME_ARIA_LABEL)}>
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
            {busy ? tr('jarvis.action.working', 'Working') : jarvisPrimaryLabel(primaryAction)}
          </button>
          <button
            className={styles.secondaryButton}
            type="button"
            onClick={() => void interrupt(false)}
            disabled={status.state === VOICE_STATE.IDLE}
            title={tr('jarvis.action.stopTitle', 'Stop the current playback or response')}
          >
            {tr('jarvis.action.interrupt', 'Stop')}
          </button>
        </div>
        <button className={styles.closeButton} type="button" onClick={close} aria-label={tr('jarvis.action.close', `Close ${LYNN_RUNTIME_DISPLAY_NAME}`)}>
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

      <div className={styles.modeHint}>{modeHint(status.state)}</div>
      {status.stats && (
        <div className={styles.stats} aria-label={tr('jarvis.stats.label', 'Voice connection statistics')}>
          <span>{tr('jarvis.stats.rtt', 'RTT')} {Math.max(0, Math.round(status.stats.rttMs || 0))} ms</span>
          <span>{tr('jarvis.stats.upload', 'Up')} {Math.round((status.stats.pcmBytesOut || 0) / 1024)} KB</span>
          <span>{tr('jarvis.stats.download', 'Down')} {Math.round((status.stats.ttsBytesIn || 0) / 1024)} KB</span>
        </div>
      )}
      {status.error && <div className={styles.error}>{status.error}</div>}
    </section>
  );
}
