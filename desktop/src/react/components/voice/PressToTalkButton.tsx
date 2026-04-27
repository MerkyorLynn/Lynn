/**
 * PressToTalkButton · 按住说话 · v0.77
 *
 * 用法:
 *   <PressToTalkButton
 *     onTranscribed={(text) => setInput(text)}
 *     onSent={(text, replyStream) => handleReply(replyStream)}
 *     directSendToChat={false}  // true=语音直接进 chat 不经手
 *     mockMode={import.meta.env.DEV}
 *   />
 *
 * 行为:
 *   • 按下: 启动 MediaRecorder + 显示波形动画 + 计时
 *   • 松开: 停录 → 上传 → 显示转写 → 完成回调
 *   • 取消: 拖出按钮范围松开 = 丢弃录音
 *
 * 接口对齐 /api/v1/audio/transcribe (JSON 一次性返回):
 *   POST /api/v1/audio/transcribe
 *   Response: { text, language, duration_ms }
 */
import { useEffect, useRef, useState, useCallback } from "react";
import type { CSSProperties } from "react";

// ============ Types ============
export interface PressToTalkButtonProps {
  onTranscribed?: (text: string) => void;
  onSent?: (text: string, replyStream?: ReadableStream) => void;
  directSendToChat?: boolean;
  apiBase?: string;
  mockMode?: boolean;
  language?: "auto" | "zh" | "en" | "ja" | "ko";
  className?: string;
  maxDurationSec?: number;
}

type RecordingState = "idle" | "starting" | "recording" | "uploading" | "transcribing";

// ============ Component ============
export function PressToTalkButton({
  onTranscribed,
  onSent,
  directSendToChat = false,
  apiBase = "/api/v1",
  mockMode = false,
  language = "auto",
  className = "",
  maxDurationSec = 60,
}: PressToTalkButtonProps) {
  const [state, setState] = useState<RecordingState>("idle");
  const [partialText, setPartialText] = useState("");
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animFrameRef = useRef<number | null>(null);

  // ============ 录音控制 ============
  const startRecording = useCallback(async () => {
    setError(null);
    setState("starting");
    cancelledRef.current = false;
    chunksRef.current = [];
    setDuration(0);
    setPartialText("");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({  /* enhanced audio constraints */
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      // MediaRecorder
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64000 });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        if (cancelledRef.current) {
          cleanup();
          setState("idle");
          return;
        }
        finalize();
      };
      // 不传 timeslice → 整个录音单 WebM blob,EBML header 完整(chunked 模式 ffmpeg 解码会失败)
      recorder.start();

      // 波形分析
      try {
        const ac = new AudioContext({ sampleRate: 16000 });
        const src = ac.createMediaStreamSource(stream);
        const analyser = ac.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
        audioContextRef.current = ac;
        analyserRef.current = analyser;
        drawWaveform();
      } catch {
        // 波形不是关键功能,失败不影响录音
      }

      // 计时
      const startTs = Date.now();
      timerRef.current = window.setInterval(() => {
        const sec = (Date.now() - startTs) / 1000;
        setDuration(sec);
        if (sec >= maxDurationSec) stopRecording();
      }, 100);

      setState("recording");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`麦克风启动失败: ${msg}`);
      setState("idle");
      cleanup();
    }
  }, [maxDurationSec]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const cancelRecording = useCallback(() => {
    cancelledRef.current = true;
    stopRecording();
  }, [stopRecording]);

  // ============ B 模式:长按锁定连续录音 ============
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockedRef = useRef(false);
  const [locked, setLocked] = useState(false);

  const cleanup = useCallback(() => {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    animFrameRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    audioContextRef.current?.close();
    audioContextRef.current = null;
    analyserRef.current = null;
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  // ============ 发送到后端 ============
  const finalize = useCallback(async () => {
    setState("uploading");
    cleanup();

    const blob = new Blob(chunksRef.current, { type: "audio/webm" });
    // DEBUG: 让用户能看到 blob size 判断 MediaRecorder 是否真录到音
    console.log(`[PTT] blob size=${blob.size} bytes, chunks=${chunksRef.current.length}, duration=${duration}s`);
    chunksRef.current = [];

    // [voice-min-size guard · 2026-04-27 night] 防止短按/空 blob 触发 sensevoice 500 EBML header 错位
    // 实测:< 1KB 的 WebM 是 header-only/不完整,ffmpeg 解码必败,server 返回 500
    // 改为前端早拦截 + 友好提示,不浪费一次后端调用
    if (blob.size < 1024 || duration < 0.4) {
      const reason = blob.size < 1024
        ? `(blob ${blob.size}B 太小,可能麦克风没拿到音频)`
        : `(只录了 ${duration.toFixed(2)}s,太短)`;
      setError(`录音太短,请按住说一句话再松开 ${reason}`);
      setState("idle");
      setPartialText("");
      return;
    }

    try {
      let finalText = "";
      if (mockMode) {
        finalText = await mockTranscribe(blob, (partial) => setPartialText(partial));
      } else {
        finalText = await realTranscribe(blob, apiBase, language, directSendToChat, (partial) =>
          setPartialText(partial),
        );
      }
      setState("idle");
      setPartialText("");
      if (directSendToChat) {
        onSent?.(finalText);
      } else {
        onTranscribed?.(finalText);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(`转写失败: ${msg}`);
      setState("idle");
      setPartialText("");
    }
  }, [apiBase, cleanup, directSendToChat, language, mockMode, onSent, onTranscribed]);

  // ============ 波形绘制 ============
  const drawWaveform = useCallback(() => {
    const canvas = canvasRef.current;
    const analyser = analyserRef.current;
    if (!canvas || !analyser) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    const bins = analyser.frequencyBinCount;
    const data = new Uint8Array(bins);

    const tick = () => {
      analyser.getByteFrequencyData(data);
      ctx.clearRect(0, 0, w, h);

      const barCount = 28;
      const barWidth = (w - barCount * 2) / barCount;
      const step = Math.floor(bins / barCount);
      for (let i = 0; i < barCount; i++) {
        const v = data[i * step] / 255;
        const barH = Math.max(3, v * h);
        const x = i * (barWidth + 2);
        const y = (h - barH) / 2;
        ctx.fillStyle = `rgba(255, 90, 90, ${0.5 + v * 0.5})`;
        ctx.fillRect(x, y, barWidth, barH);
      }

      animFrameRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, []);

  // ============ 鼠标/触摸事件 ============
  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    // 已锁定状态 → 第二次点击 = 结束录音并发送
    if (lockedRef.current && state === "recording") {
      lockedRef.current = false;
      setLocked(false);
      stopRecording();
      return;
    }
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    startRecording();
    // 长按 600ms 自动锁定连续录音
    longPressTimerRef.current = setTimeout(() => {
      lockedRef.current = true;
      setLocked(true);
    }, 600);
  };
  const handlePointerUp = (e: React.PointerEvent) => {
    e.preventDefault();
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    // 锁定状态 → 不停止,等下次点击
    if (lockedRef.current) return;
    stopRecording();
  };
  const handlePointerLeave = () => {
    // 锁定状态下离开 button 不取消(继续录)
    if (lockedRef.current) return;
    if (state === "recording") cancelRecording();
  };

  // ============ Render ============
  const isRecording = state === "recording";
  const isBusy = state === "uploading" || state === "transcribing";

  return (
    <div className={`ptt-root ${className}`}>
      {/* 录音中浮层: 波形 + 时长 + 实时转写 */}
      {(isRecording || isBusy) && (
        <div className="ptt-overlay" role="status" aria-live="polite">
          {isRecording && (
            <>
              <canvas
                ref={canvasRef}
                width={240}
                height={40}
                className="ptt-waveform"
                aria-hidden
              />
              <div className="ptt-duration">{duration.toFixed(1)}s</div>
              <div className="ptt-hint">松开发送 · 移开取消</div>
            </>
          )}
          {isBusy && (
            <>
              <div className="ptt-spinner" aria-hidden />
              <div className="ptt-partial">
                {partialText || "正在转写..."}
              </div>
            </>
          )}
        </div>
      )}

      <button
        type="button"
        className={`ptt-btn ${isRecording ? "ptt-btn--recording" : ""} ${isBusy ? "ptt-btn--busy" : ""}`}
        style={{
          /* 100% 优先级 — 防 Electron renderer cache 旧 CSS 或 vite extract 失败 */
          flexShrink: 0,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 32,
          height: 32,
          padding: 0,
          fontFamily: "inherit",
          fontSize: 14,
          lineHeight: 1,
          color: locked && isRecording ? "#8B3A3A" : isRecording ? "#EC8F8D" : isBusy ? "#537D96" : "#8E9196",
          background: locked && isRecording
            ? "rgba(139, 58, 58, 0.18)"
            : isRecording
            ? "rgba(236, 143, 141, 0.12)"
            : isBusy
            ? "rgba(83, 125, 150, 0.08)"
            : "transparent",
          border: `1px solid ${
            locked && isRecording
              ? "rgba(139, 58, 58, 0.55)"
              : isRecording
              ? "rgba(236, 143, 141, 0.45)"
              : isBusy
              ? "rgba(83, 125, 150, 0.30)"
              : "rgba(83, 125, 150, 0.18)"
          }`,
          borderRadius: 8,
          cursor: isBusy ? "not-allowed" : "pointer",
          opacity: isBusy ? 0.7 : 1,
          transition: "all 0.15s ease",
          WebkitAppRegion: "no-drag",
          WebkitUserSelect: "none",
          userSelect: "none",
        } as CSSProperties & { WebkitAppRegion?: string }}
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        disabled={isBusy}
        aria-label={isRecording ? "录音中,松开发送" : "按住说话"}
      >
        {state === "idle" && "🎤"}
        {state === "starting" && "..."}
        {isRecording && !locked && "🔴"}
        {isRecording && locked && "🔒"}
        {isBusy && "⏳"}
      </button>

      {error && (
        <div className="ptt-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

// ============ 真实 API 调用 (JSON 一次性返回) ============
import { hanaFetch } from "../../hooks/use-hana-fetch";
import "./PressToTalkButton.css";

async function realTranscribe(
  blob: Blob,
  apiBase: string,
  language: string,
  directSendToChat: boolean,
  onPartial: (text: string) => void,
): Promise<string> {
  if (directSendToChat) {
    throw new Error("directSendToChat is not yet implemented");
  }

  const form = new FormData();
  form.append("file", blob, "audio.webm");

  // apiBase 默认 "/api/v1",拼出 "/api/v1/audio/transcribe?language=zh"
  const path = `${apiBase}/audio/transcribe?language=${language}`;

  // 用 hanaFetch 自带 Bearer token,不会被 server middleware reject 成 forbidden
  const res = await hanaFetch(path, { method: "POST", body: form, timeout: 60_000 });
  // hanaFetch 已经 throws on !ok,这里直接读 json
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  const finalText = data.text || "";
  onPartial(finalText); // 一次性显示最终结果
  return finalText;
}

// ============ Mock (dev 用) ============
async function mockTranscribe(
  _blob: Blob,
  onPartial: (text: string) => void,
): Promise<string> {
  const segments = ["你好", "你好,我是", "你好,我是 Lynn", "你好,我是 Lynn,这是一段模拟转写"];
  for (const s of segments) {
    await new Promise((r) => setTimeout(r, 200));
    onPartial(s);
  }
  return segments[segments.length - 1];
}
