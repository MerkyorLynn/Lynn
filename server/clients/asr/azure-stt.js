/**
 * Azure Speech-to-Text Provider · v0.77
 *
 * BYOK 模式：用户填 Azure Speech Key 和 Region。
 * 配置项：apiKey, region
 *
 * 注意：Azure STT REST API 与 Whisper 不同，需要单独适配。
 * 当前为占位实现，需要时补充完整逻辑。
 */

export function createAzureSTTProvider(config) {
  const apiKey = config?.apiKey || config?.api_key || "";
  const region = config?.region || "eastasia";

  return {
    name: "azure-stt",
    label: "Azure Speech-to-Text",

    async transcribe(audioBuffer, { language = "zh-CN", filename = "audio.webm" } = {}) {
      if (!apiKey) throw new Error("Azure Speech Key is not configured");

      // Azure STT REST API: POST /speechtotext/v3.1/transcriptions
      // 或单次识别：POST https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1
      // 占位：抛错提示未实现
      throw new Error(
        "Azure STT provider is not yet fully implemented. " +
        "Please use faster-whisper or OpenAI Whisper for now."
      );
    },

    async health() {
      if (!apiKey || !region) return false;
      // 占位
      return false;
    },
  };
}
