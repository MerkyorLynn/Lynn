/**
 * Voice Fallback Orchestrator — Lynn V0.79 Phase 2.5 · DS V4 Pro 反馈 #5 落地
 *
 * 纯函数设计:不新开常驻进程,不管理状态机,只做一件事 ——
 *   输入 providers 的 health snapshot + brain 健康度 → 输出 Tier + Orb 颜色 + 文案
 *
 * voice-ws.js::checkHealth() 每次拿到 asr/ser/tts health 后调 computeVoiceTier,
 * 把结果通过 FRAME.HEALTH_STATUS 广播给客户端。Overlay 根据 tier 更换 Orb 颜色。
 *
 * 🔴 严禁:此模块不能做 provider 切换 / 进程重启 / 缓存状态。
 *        fallback 切换已在 createASRFallbackProvider / createTTSFallbackProvider 里做过,
 *        本模块只负责"报告现状 + 决定 UI 层观感"。
 *
 * Tier 设计(对齐 docs/PLAN-v0.79-JARVIS-MODE.md v2.3 的三档 + DS 反馈 #5):
 *   Tier 1  全绿                   →  Orb 绿呼吸,"全双工 Jarvis"
 *   Tier 2  SER 挂(emotion 缺)     →  Orb 绿(emotion 不阻塞主链),无提示
 *   Tier 3  ASR 用 fallback         →  Orb 黄呼吸,"ASR 降级:当前用 SenseVoice"
 *   Tier 4  TTS 用 fallback         →  Orb 黄呼吸,"TTS 降级:当前用 Edge TTS"
 *   Tier 5  ASR + TTS 都用 fallback  →  Orb 黄呼吸,"双降级运行"
 *   Tier 6  ASR primary + fallback 都挂 / TTS 同 → Orb 红,"语音功能临时不可用"
 */

/**
 * 输入:从 providerHealthStatus 归一化后的结构
 *   {
 *     ok: bool,                   // primary 是否健康
 *     fallbackOk: bool,           // fallback 是否健康(若 provider 没 fallback 能力则恒 false)
 *     degraded: bool,             // 已走降级(primary 死 但 fallback 活)
 *     error: string?
 *   }
 *
 * 输出:
 *   {
 *     tier: 1..6,
 *     orbColor: 'green' | 'yellow' | 'red',
 *     label: string,            // 中文用户提示(tier > 2 才显示)
 *     details: { asr, ser, tts }
 *   }
 */
export function computeVoiceTier({ asr, ser, tts } = {}) {
  // Tier 6:硬红线 — ASR 或 TTS 的 primary 和 fallback 都挂
  const asrCompletelyDown = asr && !asr.ok && !asr.fallbackOk;
  const ttsCompletelyDown = tts && !tts.ok && !tts.fallbackOk;
  if (asrCompletelyDown || ttsCompletelyDown) {
    return {
      tier: 6,
      orbColor: "red",
      label: buildFatalLabel(asrCompletelyDown, ttsCompletelyDown),
      details: { asr, ser, tts },
    };
  }

  const asrDegraded = !!asr?.degraded;
  const ttsDegraded = !!tts?.degraded;
  const serDead = ser && !ser.ok; // SER 无 fallback,挂了就挂了,但不阻塞

  // Tier 5:ASR 和 TTS 都在 fallback 上
  if (asrDegraded && ttsDegraded) {
    return {
      tier: 5,
      orbColor: "yellow",
      label: "ASR 和 TTS 都在降级运行",
      details: { asr, ser, tts },
    };
  }

  // Tier 4:仅 TTS 降级
  if (ttsDegraded) {
    return {
      tier: 4,
      orbColor: "yellow",
      label: "TTS 降级:改用 Edge TTS",
      details: { asr, ser, tts },
    };
  }

  // Tier 3:仅 ASR 降级
  if (asrDegraded) {
    return {
      tier: 3,
      orbColor: "yellow",
      label: "ASR 降级:改用 SenseVoice",
      details: { asr, ser, tts },
    };
  }

  // Tier 2:SER 挂(emotion 增强缺失,但主链完全 OK)
  if (serDead) {
    return {
      tier: 2,
      orbColor: "green",
      label: "", // 不给用户提示,主链无感
      details: { asr, ser, tts },
    };
  }

  // Tier 1:全绿
  return {
    tier: 1,
    orbColor: "green",
    label: "",
    details: { asr, ser, tts },
  };
}

function buildFatalLabel(asrDown, ttsDown) {
  if (asrDown && ttsDown) return "语音服务完全不可用(ASR/TTS 双挂)";
  if (asrDown) return "ASR 完全不可用,请检查网络或切回文字模式";
  if (ttsDown) return "TTS 完全不可用,请检查网络或切回文字模式";
  return "语音服务异常";
}

/**
 * 把 tier 转成客户端可渲染的紧凑对象(进 FRAME.HEALTH_STATUS payload)
 * 原 health JSON 保留(向后兼容),再附加 tier 字段
 */
export function enrichHealthWithTier(rawHealth) {
  if (!rawHealth || !rawHealth.providers) return rawHealth;
  const tierInfo = computeVoiceTier(rawHealth.providers);
  return {
    ...rawHealth,
    tier: tierInfo.tier,
    orbColor: tierInfo.orbColor,
    tierLabel: tierInfo.label,
  };
}
