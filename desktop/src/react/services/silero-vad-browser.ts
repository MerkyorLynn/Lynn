/**
 * Silero VAD 浏览器侧主 VAD · Lynn V0.79 Phase 2 · DS 反馈 #5 延伸
 *
 * 设计:此文件是 stub + 接入契约,真正激活需要 `npm i @ricky0123/vad-web`
 *       并按下方 "激活清单" 做 4 步打包配置。
 *
 * 为什么不现在就装:
 *   1. 任何 pnpm install 破 lockfile 都要走 release regression(MEMORY 铁律)
 *   2. 方案 C 目前 server energy VAD 已经能用,Silero 是优化项不是阻塞项
 *   3. 激活前要先跑 `@ricky0123/vad-web@0.0.29` 真实 MicVAD 兼容 Lynn 的 AudioWorklet
 *      链路(避免跟 aec-frame-adapter 的 10ms 帧冲突)
 *
 * 激活清单(下次手动执行):
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ 1. npm i @ricky0123/vad-web@0.0.29 onnxruntime-web@1.22.0        │
 *   │ 2. 拷静态资源到 desktop/public/vad/                             │
 *   │    cp node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js desktop/public/vad/
 *   │    cp node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx desktop/public/vad/
 *   │    cp node_modules/@ricky0123/vad-web/dist/silero_vad_legacy.onnx desktop/public/vad/
 *   │    cp node_modules/onnxruntime-web/dist/*.wasm desktop/public/vad/
 *   │    cp node_modules/onnxruntime-web/dist/*.mjs desktop/public/vad/  ← 容易漏!
 *   │ 3. electron-builder.yml 加 asarUnpack: ["**\*.onnx", "**\*.wasm"]
 *   │ 4. 本文件把 STUB_MODE=false,import 真的 MicVAD
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * 🔴 必踩坑(docs.vad.ricky0123.com 2026-01-30 官方文档 + 实测):
 *   1. 默认 getStream 会开 echoCancellation:true,会和 tonarino AEC native 打架
 *      → Lynn 必须传自定义 getStream,全关浏览器 AEC/AGC/NS(全部走 native)
 *   2. onnxWASMBasePath 旧版参数名 modelURL/workletURL 已废弃,统一用 baseAssetPath
 *   3. .mjs 文件必须一起拷贝(WebAssembly 初始化绑定)
 *   4. 打包时 .onnx / .wasm 放进 asarUnpack,否则 Electron file:// 协议拒绝
 *
 * 当前 stub 行为:
 *   - start() 返回一个 mock handle,不实际跑 VAD
 *   - 调用方代码可照常写,激活 STUB_MODE=false 后自动切真
 */

export const STUB_MODE = true;

export interface SileroVadHandle {
  /** 真实运行中(stub 模式下始终 false) */
  running: boolean;
  /** 停止 VAD,释放 AudioWorklet + mic stream */
  stop: () => Promise<void>;
}

export interface SileroVadOptions {
  /**
   * 用户开始说话时触发(最低延迟 ~200ms,比 server energy VAD 准)
   * Lynn 用途:立即触发 INTERRUPT 帧打断 AI 说话
   */
  onSpeechStart?: () => void;
  /**
   * 用户说完一段话,音频段已切好(16kHz Float32Array)
   * Lynn 用途:结合 END_OF_TURN 一起用
   */
  onSpeechEnd?: (audio: Float32Array) => void;
  /**
   * 可选:帧级 VAD 概率(每 ~30ms 一帧),可用于 UI 波形条动画
   */
  onFrameProcessed?: (probabilities: { isSpeech: number; notSpeech: number }) => void;
  /**
   * 从 Lynn 现有管道拿到的 MediaStream(已关浏览器 AEC/AGC/NS,走 tonarino native)
   * 必须传,不传会用默认 getUserMedia 开 AEC 导致跟 native AEC 打架
   */
  stream: MediaStream;
}

/**
 * 启动 Silero VAD(stub 模式下直接返回 no-op handle)
 */
export async function startSileroVad(_options: SileroVadOptions): Promise<SileroVadHandle> {
  if (STUB_MODE) {
    // eslint-disable-next-line no-console
    console.info("[SileroVad] stub 模式,跳过真实 VAD 启动;按文件顶部激活清单操作后切真");
    return {
      running: false,
      async stop() { /* no-op */ },
    };
  }
  // 真实实现(激活后打开下面注释):
  /*
  const { MicVAD } = await import("@ricky0123/vad-web");
  const vad = await MicVAD.new({
    baseAssetPath: "./vad/",              // 指向 desktop/public/vad/
    onnxWASMBasePath: "./vad/",
    getStream: async () => options.stream, // 关键:用 Lynn 已禁用浏览器 AEC 的流
    onSpeechStart: options.onSpeechStart,
    onSpeechEnd: options.onSpeechEnd,
    onFrameProcessed: options.onFrameProcessed,
  });
  vad.start();
  return {
    running: true,
    async stop() { vad.pause(); vad.destroy(); },
  };
  */
  throw new Error("Silero VAD 未激活,请按文件顶部激活清单操作");
}
