/**
 * MiMo V2.5 TTS Provider · v0.79.5
 *
 * 文档参考:
 *   https://platform.xiaomimimo.com/docs/zh-CN/usage-guide/speech-synthesis-v2.5
 *
 * 支持的 model 变体:
 *   - mimo-v2.5-tts             (默认,preset voice,8 个声优:冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean)
 *   - mimo-v2.5-tts-voicedesign (用文字描述定制音色)
 *   - mimo-v2.5-tts-voiceclone  (上传音频克隆音色)
 *
 * 调用约定(MiMo 特有):请求体的 messages 数组里
 *   user.content    = 风格/语速指令(自然语言)
 *   assistant.content = 要合成的文本(实际 TTS 内容)
 *
 * 输出:24kHz PCM16LE mono,wav 或 pcm16 容器,base64 in choices[0].message.audio.data
 * 注意:文档明示"低延迟流式输出功能暂未上线",当前一次性返回完整音频。
 *
 * 配置:
 *   apiKey            — MiMo Token Plan key (env fallback: MIMO_TTS_KEY → MIMO_SEARCH_KEY)
 *   baseUrl           — 默认 https://api.xiaomimimo.com/v1
 *   model             — 默认 mimo-v2.5-tts
 *   voice             — 默认音色 ID(preset list)
 *   format            — wav | pcm16,默认 wav
 *   style             — 默认风格指令(可被 synthesize call 覆盖)
 *   cloneAudioDataUri — 克隆模式音频源(data:audio/mpeg;base64,...),自动切到 -voiceclone model
 *   voiceDescription  — design 模式文字描述,自动切到 -voicedesign model
 */
import fs from "fs";

const DEFAULT_PRESET_VOICES = ["mimo_default", "冰糖", "茉莉", "苏打", "白桦", "Mia", "Chloe", "Milo", "Dean"];

function speedToInstruction(speed) {
  if (typeof speed !== "number" || !Number.isFinite(speed)) return null;
  if (speed >= 1.25) return "请用明显加快的语速朗读。";
  if (speed >= 1.08) return "请用稍快一点的语速朗读。";
  if (speed <= 0.78) return "请用明显放慢的语速朗读。";
  if (speed <= 0.92) return "请用稍慢一点的语速朗读。";
  return null;
}

export function createMiMoTTSProvider(config = {}) {
  const apiKey =
    config?.apiKey ||
    config?.api_key ||
    process.env.MIMO_TTS_KEY ||
    process.env.MIMO_SEARCH_KEY ||
    "";
  const baseUrl = (
    config?.baseUrl ||
    config?.base_url ||
    process.env.MIMO_TTS_BASE ||
    "https://api.xiaomimimo.com/v1"
  ).replace(/\/+$/, "");
  const defaultModel = config?.model || "mimo-v2.5-tts";
  const defaultVoice = config?.voice || "冰糖";
  const defaultFormat = config?.format || "wav";
  const defaultStyle = config?.style || "";
  const cloneAudioDataUri = config?.cloneAudioDataUri || config?.clone_audio || "";
  const voiceDescription = config?.voiceDescription || config?.voice_description || "";

  return {
    name: "mimo-tts",
    label: "MiMo V2.5 TTS",

    /** 8 preset voice + 用户可填自定义 ID */
    listVoices() {
      return DEFAULT_PRESET_VOICES.slice();
    },

    /**
     * synthesize({ text, voice?, speed?, outPath, style?, cloneAudio?, voiceDescription? })
     *
     * cloneAudio (per-call) 或 cloneAudioDataUri (config) 命中 → -voiceclone model
     * voiceDescription (per-call) 或 voiceDescription (config) 命中 → -voicedesign model
     * 否则使用 defaultModel(mimo-v2.5-tts)
     */
    async synthesize({ text, voice, speed, outPath, style, cloneAudio, voiceDescription: vd } = {}) {
      if (!apiKey) {
        throw new Error(
          "MiMo TTS API key is not configured (set config.apiKey, MIMO_TTS_KEY or MIMO_SEARCH_KEY)",
        );
      }
      const synthText = String(text || "").trim();
      if (!synthText) throw new Error("MiMo TTS: text is empty");

      // 构造 user 指令(MiMo 风格控制全靠自然语言)
      const styleParts = [];
      const effectiveStyle = (style || defaultStyle || "").toString().trim();
      if (effectiveStyle) styleParts.push(effectiveStyle);
      const speedInstr = speedToInstruction(speed);
      if (speedInstr) styleParts.push(speedInstr);
      const userMessage = styleParts.join(" ") || "请用自然平和的语气朗读。";

      // 决定 model 变体 + audio 参数
      let model = defaultModel;
      const audio = { format: defaultFormat };
      const cloneSrc = (cloneAudio || cloneAudioDataUri || "").toString();
      const designSrc = (vd || voiceDescription || "").toString().trim();

      if (cloneSrc) {
        model = "mimo-v2.5-tts-voiceclone";
        audio.voice = cloneSrc; // data:audio/mpeg;base64,...
      } else if (designSrc) {
        model = "mimo-v2.5-tts-voicedesign";
        audio.optimize_text_preview = true;
        // voicedesign 把音色描述放在 user message(覆盖 style)
      } else {
        audio.voice = voice || defaultVoice;
      }

      const messages =
        model === "mimo-v2.5-tts-voicedesign"
          ? [
              { role: "user", content: designSrc },
              { role: "assistant", content: synthText },
            ]
          : [
              { role: "user", content: userMessage },
              { role: "assistant", content: synthText },
            ];

      const body = { model, messages, audio };

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          // 文档指定 api-key 头;部分网关也接 Bearer,这里以文档为准
          "api-key": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw new Error(`MiMo TTS failed: HTTP ${res.status} ${err.slice(0, 300)}`);
      }

      const data = await res.json();
      const audioData = data?.choices?.[0]?.message?.audio?.data;
      if (!audioData || typeof audioData !== "string") {
        throw new Error("MiMo TTS: response missing choices[0].message.audio.data");
      }

      const buffer = Buffer.from(audioData, "base64");
      if (outPath) fs.writeFileSync(outPath, buffer);
      return {
        ok: true,
        provider: "mimo-tts",
        path: outPath || null,
        format: defaultFormat,
        sampleRate: 24000,
        channels: 1,
        bytes: buffer.length,
      };
    },
  };
}

// for tests
export const __testing__ = { speedToInstruction, DEFAULT_PRESET_VOICES };
