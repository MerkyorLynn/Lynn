/**
 * PressToTalkButton · 点击录音 · v0.77
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
 *   • 点击一次: 启动 MediaRecorder + 显示波形动画 + 计时
 *   • 再点击一次: 停录 → 上传 → 显示转写 → 完成回调
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
  const recordingStartedAtRef = useRef(0);
  const durationRef = useRef(0);
  const stopRequestedRef = useRef(false);
  const recordedBytesRef = useRef(0);
  const audioPeakRef = useRef(0);
  const trackStatusRef = useRef("unknown");
  const recorderMimeRef = useRef("audio/webm");

  // ============ 录音控制 ============
  const startRecording = useCallback(async () => {
    setError(null);
    setState("starting");
    cancelledRef.current = false;
    stopRequestedRef.current = false;
    chunksRef.current = [];
    recordedBytesRef.current = 0;
    audioPeakRef.current = 0;
    durationRef.current = 0;
    recordingStartedAtRef.current = 0;
    trackStatusRef.current = "unknown";
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
      const track = stream.getAudioTracks()[0];
      if (track) {
        trackStatusRef.current = `${track.label || "默认麦克风"} · ${track.readyState}${track.muted ? " · muted" : ""}`;
        track.onmute = () => {
          trackStatusRef.current = `${track.label || "默认麦克风"} · ${track.readyState} · muted`;
        };
        track.onunmute = () => {
          trackStatusRef.current = `${track.label || "默认麦克风"} · ${track.readyState}`;
        };
        track.onended = () => {
          trackStatusRef.current = `${track.label || "默认麦克风"} · ended`;
        };
      }

      // MediaRecorder
      const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      recorderMimeRef.current = mime;
      const recorder = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 64000 });
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
          recordedBytesRef.current += e.data.size;
        }
      };
      recorder.onerror = (event) => {
        const error = (event as unknown as { error?: Error }).error;
        setError(`录音器异常: ${error?.message || "MediaRecorder error"}`);
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
      } catch {
        // 波形不是关键功能,失败不影响录音
      }

      // 计时
      const startTs = Date.now();
      recordingStartedAtRef.current = startTs;
      timerRef.current = window.setInterval(() => {
        const sec = (Date.now() - startTs) / 1000;
        durationRef.current = sec;
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
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === "inactive" || stopRequestedRef.current) return;
    stopRequestedRef.current = true;
    // Chromium/Electron 偶发只在 stop() 后给一个 header-only WebM。
    // 先 requestData(),稍等一个 tick,能显著降低 700B 空 blob。
    try {
      if (recorder.state === "recording") recorder.requestData();
    } catch {
      // requestData 不是关键路径,失败后继续 stop。
    }
    window.setTimeout(() => {
      const latest = mediaRecorderRef.current;
      if (latest && latest.state !== "inactive") latest.stop();
    }, 80);
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
    mediaRecorderRef.current = null;
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  // ============ 发送到后端 ============
  const finalize = useCallback(async () => {
    setState("uploading");
    cleanup();

    const actualDuration = Math.max(
      durationRef.current,
      recordingStartedAtRef.current ? (Date.now() - recordingStartedAtRef.current) / 1000 : 0,
    );
    const blob = new Blob(chunksRef.current, { type: recorderMimeRef.current || "audio/webm" });
    // DEBUG: 让用户能看到 blob size 判断 MediaRecorder 是否真录到音
    console.log(
      `[PTT] blob size=${blob.size} bytes, chunks=${chunksRef.current.length}, duration=${actualDuration.toFixed(2)}s, peak=${audioPeakRef.current}, track=${trackStatusRef.current}`,
    );
    chunksRef.current = [];

    // [voice-min-size guard · 2026-04-27 night] 防止短按/空 blob 触发 sensevoice 500 EBML header 错位
    // 实测:< 1KB 的 WebM 是 header-only/不完整,ffmpeg 解码必败,server 返回 500
    // 改为前端早拦截 + 友好提示,不浪费一次后端调用
    if (blob.size < 1024 || actualDuration < 0.4) {
      const isLikelyPermission = blob.size < 1024 && actualDuration >= 0.4;
      let reason: string;
      if (isLikelyPermission) {
        const heardHint = audioPeakRef.current > 0 ? `检测到音量峰值 ${audioPeakRef.current},但编码器没有产出音频帧` : "没有检测到可用音量";
        reason = `(录了 ${actualDuration.toFixed(2)}s 但 blob 仅 ${blob.size}B；${heardHint}；设备状态: ${trackStatusRef.current}。请到 系统设置 → 隐私与安全性 → 麦克风 重新授权 Lynn,或退出后重开 App)`;
      } else if (blob.size < 1024) {
        reason = `(blob ${blob.size}B 太小,可能麦克风没拿到音频；设备状态: ${trackStatusRef.current})`;
      } else {
        reason = `(只录了 ${actualDuration.toFixed(2)}s,太短)`;
      }
        setError(`录音太短,请录完一句话后再点一次结束 ${reason}`);
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
    const bins = analyser.fftSize;
    const data = new Uint8Array(bins);

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = "rgba(250, 244, 233, 0.96)";
      ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = "rgba(83, 125, 150, 0.16)";
      ctx.fillRect(8, Math.floor(h / 2), w - 16, 1);

      const barCount = 32;
      const gap = 2;
      const barWidth = (w - gap * (barCount - 1)) / barCount;
      const step = Math.max(1, Math.floor(bins / barCount));
      const now = performance.now();

      for (let i = 0; i < barCount; i++) {
        let peak = 0;
        const start = i * step;
        const end = Math.min(start + step, bins);
        for (let j = start; j < end; j++) {
          const amp = Math.abs(data[j] - 128);
          if (amp > peak) peak = amp;
        }
        if (peak > audioPeakRef.current) audioPeakRef.current = peak;

        const normalized = peak / 128;
        // 环境很安静时也给一点呼吸动画,避免用户看到一整块空白误以为没在录。
        const breath = (Math.sin(now / 170 + i * 0.7) + 1) / 2;
        const visible = Math.max(normalized, 0.08 + breath * 0.08);
        const barH = Math.max(4, visible * h * 0.92);
        const x = i * (barWidth + gap);
        const y = (h - barH) / 2;
        const alpha = Math.min(1, 0.45 + visible * 1.3);
        ctx.fillStyle = normalized > 0.08
          ? `rgba(83, 125, 150, ${alpha})`
          : `rgba(196, 143, 72, ${0.30 + breath * 0.22})`;
        const radius = Math.min(barWidth / 2, 3);
        const right = x + barWidth;
        const bottom = y + barH;
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(right - radius, y);
        ctx.quadraticCurveTo(right, y, right, y + radius);
        ctx.lineTo(right, bottom - radius);
        ctx.quadraticCurveTo(right, bottom, right - radius, bottom);
        ctx.lineTo(x + radius, bottom);
        ctx.quadraticCurveTo(x, bottom, x, bottom - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.fill();
      }

      animFrameRef.current = requestAnimationFrame(tick);
    };
    tick();
  }, []);

  useEffect(() => {
    if (state !== "recording" || !analyserRef.current || !canvasRef.current) return;
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    animFrameRef.current = null;
    drawWaveform();
  }, [drawWaveform, state]);

  // ============ 点击录音事件 ============
  const handleToggleRecording = () => {
    if (isBusy || state === "starting") return;
    if (state === "recording") {
      lockedRef.current = false;
      setLocked(false);
      stopRecording();
      return;
    }
    lockedRef.current = false;
    setLocked(false);
    startRecording();
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
              <div className="ptt-status">
                <span className="ptt-live-dot" aria-hidden />
                <span>录音中</span>
              </div>
              <canvas
                ref={canvasRef}
                width={180}
                height={30}
                className="ptt-waveform"
                aria-hidden
              />
              <div className="ptt-duration">{duration.toFixed(1)}s</div>
              <div className="ptt-hint">再点结束</div>
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
          color: locked && isRecording ? "#7A4E18" : isRecording ? "#B67A2A" : isBusy ? "#537D96" : "#8E9196",
          background: locked && isRecording
            ? "rgba(196, 143, 72, 0.18)"
            : isRecording
            ? "rgba(196, 143, 72, 0.10)"
            : isBusy
            ? "rgba(83, 125, 150, 0.08)"
            : "transparent",
          border: `1px solid ${
            locked && isRecording
              ? "rgba(196, 143, 72, 0.48)"
              : isRecording
              ? "rgba(196, 143, 72, 0.34)"
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
        onClick={handleToggleRecording}
        disabled={isBusy}
        aria-label={isRecording ? "录音中,再次点击结束" : "点击开始录音"}
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
