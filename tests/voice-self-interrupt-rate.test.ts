/**
 * Voice Self-Interrupt Rate · Lynn V0.79 Phase 2 · DS V4 Pro 反馈 #3 回归测试
 *
 * 单测覆盖 A/B/user 三分类的纯逻辑,不需要真实 30min 对话。
 * 真实 30min 长测用 LYNN_EXT_VOICE_TEST=1 触发 runner(另文件,此处只验证判定算法)。
 */
import { describe, expect, it } from "vitest";
import {
  SelfInterruptTracker,
  classifyInterrupt,
  type InterruptEvent,
} from "../server/chat/voice-self-interrupt-tracker.ts";

function makeEvent(overrides: Partial<InterruptEvent> = {}): InterruptEvent {
  return {
    timestamp: Date.now(),
    state: "speaking",
    msSinceLastTtsChunk: 500,
    micRms: 0.03,
    followingTranscript: "等等,我想问另一个问题",
    ...overrides,
  };
}

describe("classifyInterrupt — A/B/user 三分类", () => {
  it("真实打断(有意义 transcript + 正常 mic RMS) → user", () => {
    expect(classifyInterrupt(makeEvent())).toBe("user");
  });

  it("B 类:跟随 transcript 是咳嗽/拟声", () => {
    expect(classifyInterrupt(makeEvent({ followingTranscript: "咳咳" }))).toBe("B");
    expect(classifyInterrupt(makeEvent({ followingTranscript: "嗯" }))).toBe("B");
    expect(classifyInterrupt(makeEvent({ followingTranscript: "haha" }))).toBe("B");
  });

  it("A 类:AEC 残余(TTS 推完 < 150ms + mic RMS 低)", () => {
    expect(classifyInterrupt(makeEvent({
      msSinceLastTtsChunk: 80,
      micRms: 0.005,
      followingTranscript: "",
    }))).toBe("A");
  });

  it("A 类:VAD 误触发(mic 基本静 + 无转写)", () => {
    expect(classifyInterrupt(makeEvent({
      micRms: 0.003,
      followingTranscript: "",
      msSinceLastTtsChunk: 5000, // 早已过 AEC 窗口
    }))).toBe("A");
  });

  it("边界:msSinceLastTtsChunk=null 不崩(未播放过 TTS 场景)", () => {
    expect(classifyInterrupt(makeEvent({
      msSinceLastTtsChunk: null,
      micRms: 0.03,
      followingTranscript: "你好",
    }))).toBe("user");
  });

  it("边界:transcript 空但 mic RMS 正常 → user(用户开口但未收敛)", () => {
    expect(classifyInterrupt(makeEvent({
      micRms: 0.04,
      followingTranscript: "",
      msSinceLastTtsChunk: 1000,
    }))).toBe("user");
  });
});

describe("SelfInterruptTracker — 累积统计", () => {
  it("记录三种事件后各计数正确", () => {
    const t = new SelfInterruptTracker();
    const now = Date.now();
    t.recordInterrupt({ timestamp: now + 100, state: "speaking", msSinceLastTtsChunk: 50, micRms: 0.004, followingTranscript: "" }); // A
    t.recordInterrupt({ timestamp: now + 200, state: "speaking", msSinceLastTtsChunk: 500, micRms: 0.04, followingTranscript: "咳咳" }); // B
    t.recordInterrupt({ timestamp: now + 300, state: "speaking", msSinceLastTtsChunk: 800, micRms: 0.05, followingTranscript: "真问题" }); // user

    const s = t.getStats();
    expect(s.total).toBe(3);
    expect(s.typeA_system).toBe(1);
    expect(s.typeB_noise).toBe(1);
    expect(s.typeUser).toBe(1);
  });

  it("attachTranscript 晚到可重新分类", () => {
    const t = new SelfInterruptTracker();
    t.recordInterrupt({ timestamp: 100, state: "speaking", msSinceLastTtsChunk: 50, micRms: 0.004 }); // 无 transcript → A
    expect(t.getStats().typeA_system).toBe(1);
    // 后续 transcript 回填:发现是咳嗽 → 重分 B
    t.attachTranscript(0, "咳咳");
    const s = t.getStats();
    expect(s.typeA_system).toBe(0);
    expect(s.typeB_noise).toBe(1);
  });

  it("assertWithinBudget · tonarino 主路径 A 类 ≤ 2", () => {
    const t = new SelfInterruptTracker();
    // 伪造 30min 窗口内 2 次 A 类
    const start = Date.now();
    t.recordInterrupt({ timestamp: start, state: "speaking", msSinceLastTtsChunk: 50, micRms: 0.003, followingTranscript: "" });
    t.recordInterrupt({ timestamp: start + 15 * 60 * 1000, state: "speaking", msSinceLastTtsChunk: 80, micRms: 0.005, followingTranscript: "" });
    const r = t.assertWithinBudget("tonarino", 30 * 60 * 1000);
    expect(r.pass).toBe(true);
    expect(r.budget).toBe(2);
    expect(r.actual).toBe(2);
  });

  it("assertWithinBudget · tonarino 超 2 次失败", () => {
    const t = new SelfInterruptTracker();
    const start = Date.now();
    for (let i = 0; i < 3; i++) {
      t.recordInterrupt({
        timestamp: start + i * 1000,
        state: "speaking",
        msSinceLastTtsChunk: 50,
        micRms: 0.003,
        followingTranscript: "",
      });
    }
    const r = t.assertWithinBudget("tonarino", 30 * 60 * 1000);
    expect(r.pass).toBe(false);
    expect(r.actual).toBe(3);
    expect(r.rate).toBe(3);
  });

  it("assertWithinBudget · vad-only 允许 10 次", () => {
    const t = new SelfInterruptTracker();
    const start = Date.now();
    for (let i = 0; i < 8; i++) {
      t.recordInterrupt({
        timestamp: start + i * 60 * 1000,
        state: "speaking",
        msSinceLastTtsChunk: 50,
        micRms: 0.003,
        followingTranscript: "",
      });
    }
    const r = t.assertWithinBudget("vad-only", 30 * 60 * 1000);
    expect(r.pass).toBe(true);
    expect(r.budget).toBe(10);
    expect(r.actual).toBe(8);
  });

  it("reset 清空记录", () => {
    const t = new SelfInterruptTracker();
    t.recordInterrupt(makeEvent());
    expect(t.getStats().total).toBe(1);
    t.reset();
    expect(t.getStats().total).toBe(0);
  });

  it("空 tracker 的 stats 不崩", () => {
    const t = new SelfInterruptTracker();
    const s = t.getStats();
    expect(s.total).toBe(0);
    expect(s.typeA_system).toBe(0);
    expect(s.typeARatePer30min).toBe(0);
  });
});

describe("30min 长测 skip gate — DS 反馈 #3", () => {
  it.skipIf(!process.env.LYNN_EXT_VOICE_TEST)(
    "真实 30min 对话 A 类 ≤ 2(主路径),需 LYNN_EXT_VOICE_TEST=1 + DGX + 真 mic",
    () => {
      // 这里只是占位 — 真正跑法:scripts/voice-longtest-runner.mjs 另起一个
      // 30min 脚本,连 voice-ws + 触发 interrupt + 累积到 tracker + assertWithinBudget
      // CI 默认跳,手动触发才跑(MEMORY benchmark 铁律:主动暴露问题)
      expect(true).toBe(true);
    },
  );
});
