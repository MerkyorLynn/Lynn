/**
 * Voice Self-Interrupt Tracker · Lynn V0.79 Phase 2 · DS V4 Pro 反馈 #3 落地
 *
 * 目的:30min 连续对话中统计自打断率,分 A/B 类型。
 *   A 类(系统 bug):AEC 残余回声 + VAD 误触发 + WS 抖动造成的非用户主动打断
 *   B 类(背景噪音):环境噪音(狗叫/楼下敲钟)导致的误打断,不可避免
 *
 * DS 反馈 #3 验收分级(docs/PLAN-v0.79-JARVIS-MODE.md v2.1 锁定):
 *   主路径 tonarino AEC   A 类 ≤ 2 次 / 30min
 *   降级 1 SpeexDSP        A 类 ≤ 5 次 / 30min
 *   降级 2 纯 VAD          A 类 ≤ 10 次 / 30min + UI 警告
 *
 * 分类判定算法(基于事件上下文):
 *   - 打断发生时 state === SPEAKING 且 后续 transcript_final 为"无意义"(咳嗽/笑声) → B 类
 *   - 打断发生时 TTS 段刚推完 <150ms (AEC 残余) → A 类
 *   - 打断发生后 transcript_final 为空且 mic RMS 低 → A 类(VAD 误触发)
 *   - 其他:属于真实用户打断,不计入自打断
 */

import { isSemanticTranscript } from "../routes/voice-ws.js";

/**
 * 单次事件:voice-ws 记录的打断时刻快照
 * voice-ws::onInterrupt 记录时调 tracker.recordInterrupt(event)
 */
export interface InterruptEvent {
  timestamp: number;
  /** 打断时 session 状态 */
  state: "speaking" | "thinking" | string;
  /** 打断时距离上次 PCM_TTS 推送的 ms 差(若 < 150ms 则高度疑似 AEC 残余) */
  msSinceLastTtsChunk: number | null;
  /** 打断后捕到的 mic 近 200ms 平均 RMS */
  micRms: number;
  /** 跟随打断的下一轮 transcript_final(可能在 endOfTurn 之后才 resolve) */
  followingTranscript?: string;
}

export type InterruptClass = "A" | "B" | "user";

export interface InterruptStats {
  /** 当前窗口总打断数 */
  total: number;
  /** A 类(系统 bug) */
  typeA_system: number;
  /** B 类(背景噪音) */
  typeB_noise: number;
  /** 真实用户主动打断 */
  typeUser: number;
  /** 最早事件 ts */
  startTs: number;
  /** 最晚事件 ts */
  endTs: number;
  /** 窗口实际持续 ms */
  windowMs: number;
  /** A 类率(次/30min) — 用于对照 DS 验收分级 */
  typeARatePer30min: number;
}

// AEC 残余回声判定阈值:TTS 推完后 150ms 内的打断高度疑似回声
const AEC_RESIDUAL_MS = 150;
// VAD 误触发判定阈值:mic RMS 低于此值但仍触发打断 → 系统 bug
const VAD_MISFIRE_RMS = 0.008;

export function classifyInterrupt(ev: InterruptEvent): InterruptClass {
  // B 类:跟随 transcript 为"无意义"(咳嗽/笑声/拟声)
  const transcript = ev.followingTranscript || "";
  if (transcript && !isSemanticTranscript(transcript)) {
    return "B";
  }

  // A 类判定 1:AEC 残余 — TTS 刚推完就打断,且 mic RMS 低
  if (
    ev.msSinceLastTtsChunk !== null &&
    ev.msSinceLastTtsChunk < AEC_RESIDUAL_MS &&
    ev.micRms < VAD_MISFIRE_RMS * 3
  ) {
    return "A";
  }

  // A 类判定 2:VAD 误触发 — 打断了但 mic 实际很静且没转写
  if (ev.micRms < VAD_MISFIRE_RMS && !transcript) {
    return "A";
  }

  // 其他:真实用户打断
  return "user";
}

/**
 * 长测 tracker — 累积 30min 事件,输出 stats + 给 DS 分级判定
 */
export class SelfInterruptTracker {
  private events: Array<InterruptEvent & { cls: InterruptClass }> = [];

  recordInterrupt(ev: InterruptEvent): InterruptClass {
    const cls = classifyInterrupt(ev);
    this.events.push({ ...ev, cls });
    return cls;
  }

  /** 用 followingTranscript 回填一个事件(endOfTurn 收敛晚于 interrupt 发生) */
  attachTranscript(eventIndex: number, transcript: string): void {
    const ev = this.events[eventIndex];
    if (!ev) return;
    ev.followingTranscript = transcript;
    ev.cls = classifyInterrupt(ev);
  }

  /** 获取当前 stats */
  getStats(windowMs?: number): InterruptStats {
    const total = this.events.length;
    const typeA_system = this.events.filter((e) => e.cls === "A").length;
    const typeB_noise = this.events.filter((e) => e.cls === "B").length;
    const typeUser = this.events.filter((e) => e.cls === "user").length;
    const startTs = total ? this.events[0].timestamp : 0;
    const endTs = total ? this.events[this.events.length - 1].timestamp : 0;
    const actualWindow = windowMs ?? Math.max(1, endTs - startTs);
    const typeARatePer30min = (typeA_system / actualWindow) * (30 * 60 * 1000);
    return {
      total,
      typeA_system,
      typeB_noise,
      typeUser,
      startTs,
      endTs,
      windowMs: actualWindow,
      typeARatePer30min,
    };
  }

  /**
   * DS 反馈 #3 分级判定(30min 窗口上限)
   *   aecMode: "tonarino" | "speexdsp" | "vad-only"
   */
  assertWithinBudget(
    aecMode: "tonarino" | "speexdsp" | "vad-only",
    windowMs?: number,
  ): { pass: boolean; budget: number; actual: number; rate: number } {
    const stats = this.getStats(windowMs);
    const budgets = { tonarino: 2, speexdsp: 5, "vad-only": 10 };
    const budget = budgets[aecMode];
    return {
      pass: stats.typeARatePer30min <= budget,
      budget,
      actual: stats.typeA_system,
      rate: stats.typeARatePer30min,
    };
  }

  reset(): void {
    this.events = [];
  }

  dump(): ReadonlyArray<InterruptEvent & { cls: InterruptClass }> {
    return this.events.slice();
  }
}
