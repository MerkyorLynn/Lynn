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
      const stream = await navigator.mediaDevices.getUserMedia({
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
      recorder.start(250); // 每 250ms 触发一次 dataavailable

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
    chunksRef.current = [];

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
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    startRecording();
  };
  const handlePointerUp = (e: React.PointerEvent) => {
    e.preventDefault();
    stopRecording();
  };
  const handlePointerLeave = () => {
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
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        disabled={isBusy}
        aria-label={isRecording ? "录音中,松开发送" : "按住说话"}
      >
        {state === "idle" && "🎤"}
        {state === "starting" && "..."}
        {isRecording && "🔴"}
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

  const url = `${apiBase}/audio/transcribe?language=${language}`;

  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

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

// ============ 默认样式 (可自己用 tailwind 覆盖) ============
// 内联到 <style data-ptt> 节点,组件首次挂载时插入
const style = `
.ptt-root { position: relative; display: inline-block; }
.ptt-btn {
  width: 48px; height: 48px; border-radius: 50%; border: 1px solid #30363d;
  background: #21262d; color: #e6edf3; font-size: 22px; cursor: pointer;
  transition: all 120ms ease; user-select: none;
}
.ptt-btn:hover { background: #30363d; }
.ptt-btn--recording { background: #da3633; transform: scale(1.1); }
.ptt-btn--busy { opacity: 0.7; cursor: progress; }
.ptt-overlay {
  position: absolute; bottom: 60px; left: 50%; transform: translateX(-50%);
  background: #161b22; border: 1px solid #30363d; border-radius: 12px;
  padding: 12px 16px; min-width: 280px; box-shadow: 0 8px 24px rgba(0,0,0,0.4);
  display: flex; flex-direction: column; align-items: center; gap: 6px; z-index: 100;
}
.ptt-waveform { display: block; }
.ptt-duration { color: #ff7b72; font-weight: 700; font-size: 14px; font-variant-numeric: tabular-nums; }
.ptt-hint { color: #8b949e; font-size: 11px; }
.ptt-spinner {
  width: 16px; height: 16px; border-radius: 50%;
  border: 2px solid #30363d; border-top-color: #58a6ff;
  animation: ptt-spin 0.8s linear infinite;
}
@keyframes ptt-spin { to { transform: rotate(360deg); } }
.ptt-partial { color: #e6edf3; font-size: 13px; max-width: 240px; text-align: center; }
.ptt-error {
  position: absolute; top: 60px; left: 50%; transform: translateX(-50%);
  background: #f85149; color: white; padding: 8px 12px; border-radius: 6px;
  font-size: 12px; white-space: nowrap;
}
`;
if (typeof document !== "undefined" && !document.querySelector("style[data-ptt]")) {
  const el = document.createElement("style");
  el.setAttribute("data-ptt", "");
  el.textContent = style;
  document.head.appendChild(el);
}
