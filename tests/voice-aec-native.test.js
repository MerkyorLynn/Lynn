/**
 * AEC native module integration test — Lynn V0.79 Phase 1
 *
 * 测 .node 加载 + createProcessor + processRender + processCapture 完整闭环
 *
 * 跳过条件:当前平台没 prebuilt .node(CI Linux 还没 build,Win 同理)
 * 通过条件:macOS arm64 上 .node 已编出,完整 hello world 跑通,粗估 ERLE > 0
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

let aec;
let loadError = null;
try {
  aec = require("../desktop/native-modules/aec/index.js");
} catch (e) {
  loadError = e;
}

describe("AEC native module — desktop/native-modules/aec", () => {
  it("module loads (or skip if no prebuilt for this platform)", () => {
    if (loadError) {
      console.warn(`[skip] no AEC binary for ${process.platform}-${process.arch}: ${loadError.message}`);
      return;
    }
    expect(aec).toBeDefined();
    expect(typeof aec.available).toBe("boolean");
  });

  it("on platforms with prebuilt: createProcessor / processRender / processCapture all callable", () => {
    if (!aec || !aec.available) {
      console.warn(`[skip] AEC not available on ${process.platform}-${process.arch}`);
      return;
    }
    // 创建 16kHz processor
    const proc = aec.createProcessor({ sampleRate: 16000, enableNs: true });
    expect(proc).toBeDefined();
    const info = aec.info(proc);
    expect(info).toContain("16000Hz");
    expect(info).toContain("samples/frame=160");
  });

  it("on platforms with prebuilt: AEC reduces synthetic echo (sanity check)", () => {
    if (!aec || !aec.available) return;

    const proc = aec.createProcessor({ sampleRate: 16000, enableNs: false });
    const SAMPLES = 160; // 10ms @ 16k

    // 模拟 TTS 信号(440Hz 正弦)
    const tts = new Float32Array(SAMPLES);
    for (let i = 0; i < SAMPLES; i++) {
      tts[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.3;
    }

    // 模拟 mic = 用户语音(200Hz 弱) + 拾到的 TTS 回声(50% 衰减,5ms 延迟)
    const mic = new Float32Array(SAMPLES);
    for (let i = 0; i < SAMPLES; i++) {
      const speech = Math.sin((2 * Math.PI * 200 * i) / 16000) * 0.1;
      const echoIdx = i - 80;
      const echo = echoIdx >= 0 ? tts[echoIdx] * 0.5 : 0;
      mic[i] = speech + echo;
    }

    aec.processRender(proc, tts);
    const cleaned = aec.processCapture(proc, mic);
    expect(cleaned).toBeInstanceOf(Float32Array);
    expect(cleaned.length).toBe(SAMPLES);

    // 单帧粗估 ERLE,合成数据应该明显减少能量
    let micEnergy = 0, cleanedEnergy = 0;
    for (let i = 0; i < SAMPLES; i++) {
      micEnergy += mic[i] ** 2;
      cleanedEnergy += cleaned[i] ** 2;
    }
    // cleaned 能量应小于 mic 能量(AEC 起作用)
    // 注:首帧粗估,真实 ERLE 见 Spike 5
    expect(cleanedEnergy).toBeLessThan(micEnergy);
  });

  it("rejects wrong frame size", () => {
    if (!aec || !aec.available) return;
    const proc = aec.createProcessor({ sampleRate: 16000 });
    // 16kHz 期望 160 samples,给 200 应被拒
    const wrongSize = new Float32Array(200);
    expect(() => aec.processRender(proc, wrongSize)).toThrow(/length/);
    expect(() => aec.processCapture(proc, wrongSize)).toThrow(/length/);
  });
});
