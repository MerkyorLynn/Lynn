/**
 * tts-engine.js — 语音合成引擎（多 Provider 封装）
 *
 * 优先级（已拆分为独立 Provider，通过 registry 调度）：
 * 1. edge-tts（免费，322 音色，在线）
 * 2. openai-tts（BYOK）
 * 3. macOS say（本地，无网络依赖）
 */

import { createTTSProvider } from "./tts-registry.js";

export async function synthesize({ text, voice, speed, outPath, provider = "edge" }) {
  const tts = createTTSProvider({ provider });
  return tts.synthesize({ text, voice, speed, outPath });
}
