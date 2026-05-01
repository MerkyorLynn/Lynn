/**
 * server-side AEC native loader · Lynn V0.79 P1-① 2026-05-01
 *
 * server 进程是独立 spawn 出的 Node 进程(不在 Electron renderer 沙箱),可以
 * 直接 require napi-rs 编的 `lynn-aec-napi.<platform>-<arch>.node`。reference
 * signal 已在 server 侧构造(server 是 PCM_TTS 的发送方),零 IPC 时序对齐。
 *
 * Path 解析:
 *   1. 优先读 env LYNN_AEC_NATIVE_DIR(由 desktop main.cjs 启动 server 时注入,
 *      生产环境指向 .app/Contents/Resources/app.asar.unpacked/desktop/native-modules/aec)
 *   2. 否则相对 server 源码路径回退到 `../../../desktop/native-modules/aec`(开发模式)
 *
 * 加载失败(平台无 prebuilt / .node ABI 不兼容)→ available=false,VoiceSession
 * 走原 mic 帧直传路径,等同于现状,不阻塞主链。
 *
 * 资源生命周期(2026-05-01 修 5 验证):
 *   AecHandle 是 napi-rs `#[napi]` struct,内部 `Arc<Mutex<Processor>>`。
 *   Drop 由 napi-rs finalizer 自动接管 — JS GC 回收 handle 时调 Rust drop,
 *   Arc 引用计数 → 0 → Processor drop → 内存释放。
 *   即:**不需要显式 destroy**;VoiceSession.onClose 时让 GC 自然清理即可。
 *   见 desktop/native-modules/aec/src/lib.rs:21-25 (`pub struct AecHandle`)。
 */
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const requireCjs = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveNativeDir() {
  if (process.env.LYNN_AEC_NATIVE_DIR) return process.env.LYNN_AEC_NATIVE_DIR;
  // 开发模式:server/clients/aec/ → ../../../desktop/native-modules/aec/
  return path.resolve(__dirname, "..", "..", "..", "desktop", "native-modules", "aec");
}

let nativeModule = null;
let loadError = null;
try {
  const dir = resolveNativeDir();
  nativeModule = requireCjs(path.join(dir, "index.js"));
} catch (err) {
  loadError = err;
  nativeModule = null;
}

const isAvailable = !!(nativeModule && nativeModule.available);

export const aecAvailable = isAvailable;
export const aecLoadError = loadError;

/**
 * 创建 AEC processor 句柄。
 * @param {{sampleRate?:number, enableNs?:boolean}} cfg
 * @returns {object|null} handle,available=false 时返回 null
 */
export function createAecProcessor(cfg = {}) {
  if (!isAvailable) return null;
  try {
    return nativeModule.createProcessor({
      sampleRate: cfg.sampleRate || 16000,
      enableNs: cfg.enableNs !== false,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[aec] createProcessor failed:", err?.message || err);
    return null;
  }
}

/**
 * 喂 far-end (TTS reference) PCM 一帧 10ms (160 samples Float32 @ 16kHz)。
 * 必须在 processCapture 之前调用(API 顺序约束,见 lib.rs 注释)。
 */
export function aecProcessRender(handle, farEnd) {
  if (!handle || !nativeModule) return;
  nativeModule.processRender(handle, farEnd);
}

/**
 * 喂 near-end (mic) PCM 一帧 10ms (160 samples Float32),返回清掉 echo 的 PCM。
 * @returns {Float32Array}
 */
export function aecProcessCapture(handle, nearEnd) {
  if (!handle || !nativeModule) return nearEnd;
  return nativeModule.processCapture(handle, nearEnd);
}

export function aecInfo() {
  return nativeModule?.info || null;
}
