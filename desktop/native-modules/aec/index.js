/**
 * Lynn V0.79 AEC native module — platform dispatcher
 *
 * 加载平台对应的 prebuilt .node 文件。
 * 如果当前平台无 prebuilt,export AecUnavailable 让上层 fallback 到 Tier 2/3。
 *
 * Lynn 默认走 Tier 1 全双工(此 module 可用) → Tier 2 半双工(VAD pause TTS,无 AEC)
 * 见 docs/PLAN-v0.79-JARVIS-MODE.md v2.3 体验承诺三档
 */
const path = require("path");

function getPlatformBinaryPath() {
  const platform = process.platform;
  const arch = process.arch;
  return path.join(__dirname, `lynn-aec-napi.${platform}-${arch}.node`);
}

let aec = null;
let loadError = null;
try {
  aec = require(getPlatformBinaryPath());
} catch (err) {
  loadError = err;
}

module.exports = {
  /** 当前平台是否有可用的 native AEC */
  available: aec !== null,
  /** 加载失败原因(给降级路径上报) */
  loadError,
  /**
   * 创建 AEC processor 句柄
   * @param {object} cfg
   * @param {number} cfg.sampleRate - 16000 / 48000 等
   * @param {boolean} [cfg.enableNs=true] - 是否同时启用噪声抑制
   * @returns {object} AEC handle
   */
  createProcessor: aec ? aec.createProcessor : null,
  /**
   * 喂 far-end (TTS reference) PCM,10ms 帧
   * @param {object} handle
   * @param {Float32Array} farEndPcm
   */
  processRender: aec ? aec.processRender : null,
  /**
   * 喂 near-end (mic) PCM,10ms 帧,返回清掉 echo 的 PCM
   * @param {object} handle
   * @param {Float32Array} nearEndPcm
   * @returns {Float32Array}
   */
  processCapture: aec ? aec.processCapture : null,
  /** 调试信息 */
  info: aec ? aec.info : null,
};
