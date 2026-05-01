/**
 * Spike 04 — N-API hello world
 *
 * 跑法:cargo build --release && node test/hello.mjs
 *
 * 预期输出:
 *   AEC processor: sample_rate=16000Hz channels=1 samples/frame=160
 *   render frame OK
 *   capture frame OK,output sample [0..3]: <floats>
 *   ✓ Spike 04 hello world 通过
 */

// build 输出在 target/release/lib<name>.dylib (mac) / .so (linux) / .dll (win)
// napi-rs 标准产物是 lynn-aec-napi.node 在仓根
import { createRequire } from "module";
const require = createRequire(import.meta.url);

let aec;
try {
  // napi-rs 产出平台特定名,例如 darwin-arm64
  const platformName = `${process.platform}-${process.arch}`;
  aec = require(`../lynn-aec-napi.${platformName}.node`);
} catch (e) {
  console.error("加载 .node 失败:", e.message);
  console.error("可能原因:");
  console.error("  1. 还没 cargo build --release && napi build");
  console.error("  2. 平台不匹配");
  console.error("  3. tonarino webrtc-audio-processing 编译失败(看 cargo build 输出)");
  process.exit(1);
}

const proc = aec.createProcessor({ sampleRate: 16000, channels: 1 });
console.log(aec.info(proc));

// 16kHz / 10ms = 160 samples
const SAMPLES = 160;

// 模拟 TTS 输出(440Hz 正弦波)
const tts = new Float32Array(SAMPLES);
for (let i = 0; i < SAMPLES; i++) {
  tts[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.3;
}

// 模拟麦克风输入(用户语音 + 拾到的扬声器回声)
const mic = new Float32Array(SAMPLES);
for (let i = 0; i < SAMPLES; i++) {
  // 用户语音 (200Hz, 较小)
  const speech = Math.sin((2 * Math.PI * 200 * i) / 16000) * 0.1;
  // 拾到的回声(TTS 信号衰减 50% + 5ms 延迟)
  const echoIdx = i - 80;
  const echo = echoIdx >= 0 ? tts[echoIdx] * 0.5 : 0;
  mic[i] = speech + echo;
}

// 步骤 1:render(far-end)先 analyze
aec.processRender(proc, tts);  // Float32Array 直传
console.log("render frame OK");

// 步骤 2:capture(near-end)后 process
const cleaned = aec.processCapture(proc, mic);  // Float32Array 直传
console.log("capture frame OK,output sample [0..3]:", Array.from(cleaned.slice(0, 3)));

// 简单 ERLE 估算(理论)
let micEnergy = 0,
  cleanedEnergy = 0,
  echoEnergy = 0;
for (let i = 0; i < SAMPLES; i++) {
  micEnergy += mic[i] ** 2;
  cleanedEnergy += cleaned[i] ** 2;
  // echo-only 信号
  const echoIdx = i - 80;
  const echo = echoIdx >= 0 ? tts[echoIdx] * 0.5 : 0;
  echoEnergy += echo ** 2;
}
const erleDb = 10 * Math.log10((micEnergy + 1e-12) / (cleanedEnergy + 1e-12));
console.log(`粗估 mic→cleaned 能量降低: ${erleDb.toFixed(2)} dB`);
console.log("(这个数字仅 1 帧粗估,真实 ERLE 测量见 Spike 05)");

console.log("✓ Spike 04 hello world 通过");
