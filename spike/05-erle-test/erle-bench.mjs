/**
 * Spike 05 — ERLE 实测 bench
 *
 * 验证:tonarino webrtc-audio-processing AEC 在真实 TTS reference 信号下的 ERLE
 *
 * 测试方法:
 *   1. 录一段 5-10s "AI 说话" WAV(模拟 TTS,从 Lynn V0.78 CosyVoice 录)
 *   2. 录一段同时长 mic 录音(扬声器播放 TTS,麦克风同时接到 + 你也说几句)
 *   3. 用本脚本跑 AEC 处理:
 *      - far-end ref = TTS WAV
 *      - near-end mic = 麦克风录音
 *   4. 输出 cleaned mic WAV
 *   5. 测三段能量:mic / cleaned / 用户语音(ground truth)
 *   6. 计算 ERLE = 10*log10(mic_echo_energy / cleaned_residual_echo_energy)
 *
 * ERLE 验收(Foundation Gate Tier 1 / 2 分界):
 *   ≥ 15 dB → Tier 1 准入(全双工 Jarvis)
 *   10-15 dB → Tier 2 半双工(双讲场景吞字明显)
 *   < 10 dB → Tier 3 PTT(半双工也勉强)
 *
 * 跑法:
 *   1. 准备录音(用 Audacity 或 macOS 录音 app):
 *      - tts.wav        16kHz mono - 一段干净的 AI 说话
 *      - mic.wav        16kHz mono - 同步录的 mic(含 TTS 拾音 + 你说话)
 *      - speech-only.wav 16kHz mono - 仅你说话(对比基线,可选)
 *   2. node erle-bench.mjs tts.wav mic.wav [speech-only.wav]
 *
 * ⚠️ 这个 spike 依赖 Spike 04 编译产物(lynn-aec-napi.node)
 */

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// 读 Spike 04 产物
let aec;
try {
  aec = require("../04-tonarino-aec-napi/lynn-aec-napi.node");
} catch (e) {
  console.error("❌ 加载 Spike 04 .node 失败:", e.message);
  console.error("先跑 Spike 04 build:cd ../04-tonarino-aec-napi && cargo build --release && npm run build");
  process.exit(1);
}

// 简易 WAV 读取(只支持 PCM16 mono 16kHz)
function readWav(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString("ascii", 0, 4) !== "RIFF") throw new Error("not RIFF");
  if (buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not WAVE");
  // 找 fmt + data chunk
  let offset = 12;
  let sampleRate = 0,
    channels = 0,
    bitsPerSample = 0,
    dataOffset = 0,
    dataSize = 0;
  while (offset < buf.length) {
    const chunkId = buf.toString("ascii", offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "fmt ") {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (chunkId === "data") {
      dataOffset = offset + 8;
      dataSize = chunkSize;
      break;
    }
    offset += 8 + chunkSize;
  }
  if (channels !== 1 || sampleRate !== 16000 || bitsPerSample !== 16) {
    throw new Error(`WAV 必须 mono 16kHz 16-bit,实际 ${channels}ch ${sampleRate}Hz ${bitsPerSample}-bit`);
  }
  const numSamples = dataSize / 2;
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    samples[i] = buf.readInt16LE(dataOffset + i * 2) / 32768;
  }
  return samples;
}

function writeWav(filePath, samples, sampleRate = 16000) {
  const numSamples = samples.length;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), 44 + i * 2);
  }
  fs.writeFileSync(filePath, buf);
}

function rms(samples, start = 0, len = samples.length) {
  let sum = 0;
  for (let i = start; i < start + len; i++) sum += samples[i] ** 2;
  return Math.sqrt(sum / len);
}

function energyDb(samples) {
  return 20 * Math.log10(rms(samples) + 1e-12);
}

// === main ===
const [, , ttsPath, micPath, speechPath] = process.argv;
if (!ttsPath || !micPath) {
  console.error("用法: node erle-bench.mjs tts.wav mic.wav [speech-only.wav]");
  process.exit(1);
}

console.log(`读取 TTS reference: ${ttsPath}`);
const tts = readWav(ttsPath);
console.log(`读取 mic input:    ${micPath}`);
const mic = readWav(micPath);

if (Math.abs(tts.length - mic.length) > 16000) {
  console.warn(`⚠ tts (${tts.length}) 和 mic (${mic.length}) 长度差 > 1s,对齐可能不准`);
}

const SAMPLES_PER_FRAME = 160; // 10ms @ 16k
const numFrames = Math.min(tts.length, mic.length) / SAMPLES_PER_FRAME | 0;

console.log(`处理 ${numFrames} 帧 (${(numFrames * 0.01).toFixed(1)}s)`);

const proc = aec.createProcessor({ sampleRate: 16000, channels: 1, enableNs: true });
console.log(aec.info(proc));

const cleaned = new Float32Array(numFrames * SAMPLES_PER_FRAME);

for (let f = 0; f < numFrames; f++) {
  const off = f * SAMPLES_PER_FRAME;
  const ttsFrame = Array.from(tts.subarray(off, off + SAMPLES_PER_FRAME));
  const micFrame = Array.from(mic.subarray(off, off + SAMPLES_PER_FRAME));

  aec.processRender(proc, ttsFrame);
  const out = aec.processCapture(proc, micFrame);
  for (let i = 0; i < SAMPLES_PER_FRAME; i++) {
    cleaned[off + i] = out[i];
  }
}

const outPath = path.join(__dirname, "out-cleaned.wav");
writeWav(outPath, cleaned);
console.log(`输出已写: ${outPath}`);

// === ERLE 估算 ===
// 严格 ERLE 需要 echo-only 信号(即麦克风只拾到回声不含用户语音)
// 简化估算:用 mic 整体能量 vs cleaned 整体能量
const micRms = rms(mic);
const cleanedRms = rms(cleaned);
const erleDb = 20 * Math.log10((micRms + 1e-12) / (cleanedRms + 1e-12));

console.log("\n=== 测量结果 ===");
console.log(`mic 平均 RMS:        ${micRms.toFixed(5)}  (${energyDb(mic).toFixed(2)} dBFS)`);
console.log(`cleaned 平均 RMS:    ${cleanedRms.toFixed(5)}  (${energyDb(cleaned).toFixed(2)} dBFS)`);
console.log(`mic→cleaned 衰减:    ${erleDb.toFixed(2)} dB`);

if (speechPath) {
  const speech = readWav(speechPath);
  const speechRms = rms(speech);
  console.log(`speech-only RMS:     ${speechRms.toFixed(5)}  (${energyDb(speech).toFixed(2)} dBFS)`);
  console.log(`期望 cleaned 接近 speech-only 能量(用户语音应保留)`);
}

console.log("\n=== Foundation Gate 判定 ===");
if (erleDb >= 15) {
  console.log("✓ ERLE ≥ 15 dB → Tier 1 全双工 Jarvis 准入");
} else if (erleDb >= 10) {
  console.log("⚠ ERLE 10-15 dB → Tier 2 半双工 Jarvis(双讲吞字明显)");
} else if (erleDb >= 5) {
  console.log("⚠ ERLE 5-10 dB → Tier 3 PTT 模式 + 用户文档建议戴耳机");
} else {
  console.log("❌ ERLE < 5 dB → AEC 基本无效,可能 reference 信号没对齐 / 实现有 bug");
}

console.log("\n注:");
console.log("- 严格 ERLE 测量需要 mic 只录回声(没用户语音)");
console.log("- 这个粗估在双讲场景下偏低(用户语音也会被算进 cleaned 能量)");
console.log("- 若有 speech-only.wav,可计算 ERLE 校正版");
