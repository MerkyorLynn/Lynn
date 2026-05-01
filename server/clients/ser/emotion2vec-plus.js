/**
 * emotion2vec+ base SER Provider · Lynn V0.79 Jarvis Runtime
 *
 * 阿里达摩院 emotion2vec_plus_base,中英双语,9 类情绪
 * SM121 实测稳态:P50 70ms / P90 75ms / 稳态 < 100ms (warmup 后)
 *
 * 9 类输出 schema:
 *   labels: ['生气/angry', '厌恶/disgusted', '恐惧/fearful', '开心/happy',
 *            '中立/neutral', '其他/other', '难过/sad', '吃惊/surprised', '<unk>']
 *   scores: [..9 floats..] 归一化概率
 *
 * ★ Foundation Gate 决策点 1(2026-04-30 实测):
 *   稳态 P99 < 100ms,可注入【当前轮】LLM,AI 第一句话 emotion-aware
 *
 * Lynn 集成策略:
 *   - 短段模式:取最后 3s + 开头 1s 共 4s 喂模型(DS V4 Pro 反馈 2)
 *   - 不阻塞主链:跟 ASR 转写并行,emotion 结果异步注入 LLM context
 *   - warmup 必须:Lynn voice-ws session 启动时跑一次 dummy 模型预热
 *
 * 部署方式(2026-04-30 实测):
 *   - DGX venv: pip install funasr modelscope
 *   - FunASR `iic/emotion2vec_plus_base` 自动下载
 *   - 实际部署一个 Python HTTP server 包装 FunASR AutoModel
 *
 * 协议(Phase 1):
 *   POST /classify  multipart/form-data { file: audio/* }
 *   Response: { labels: string[], scores: number[], top1: string, top1_score: number }
 *
 * 环境变量:LYNN_EMOTION2VEC_URL(默认 http://localhost:18008)
 */

const SER_URL = process.env.LYNN_EMOTION2VEC_URL || "http://localhost:18008";

// 9 类情绪 → 简化 tag(Lynn LLM context 用的英文小写 token)
const EMO_TAG_MAP = {
  "生气/angry": "angry",
  "厌恶/disgusted": "disgusted",
  "恐惧/fearful": "fearful",
  "开心/happy": "happy",
  "中立/neutral": "neutral",
  "其他/other": "other",
  "难过/sad": "sad",
  "吃惊/surprised": "surprised",
  "<unk>": "unknown",
};

export function createEmotion2VecProvider(_config) {
  return {
    name: "emotion2vec-plus-base",
    label: "emotion2vec+ base (V0.79 SER,SM121 实测 P50 70ms)",

    /**
     * 短段情绪识别(4s 模式)
     * @param {Buffer} audioBuffer - 通常是 mic 录音的最后 3s + 开头 1s
     * @param {object} opts
     * @returns {Promise<{tag: string, score: number, all: object[]}>}
     */
    async classify(audioBuffer, { filename = "audio.webm" } = {}) {
      const form = new FormData();
      form.append("file", new Blob([audioBuffer], { type: "audio/webm" }), filename);

      const res = await fetch(`${SER_URL}/classify`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`emotion2vec classify failed: HTTP ${res.status} ${errText.slice(0, 120)}`);
      }
      const result = await res.json();
      // 归一化输出
      const top1Label = result.top1 || result.labels?.[0];
      const top1Score = result.top1_score || result.scores?.[0] || 0;
      const tag = EMO_TAG_MAP[top1Label] || "unknown";
      return {
        tag,
        score: top1Score,
        all: (result.labels || []).map((label, i) => ({
          label,
          tag: EMO_TAG_MAP[label] || "unknown",
          score: result.scores?.[i] || 0,
        })),
      };
    },

    /**
     * 预热(Lynn voice-ws session 启动时调一次,避免首次推理 P99 spike)
     */
    async warmup() {
      try {
        const r = await fetch(`${SER_URL}/warmup`, {
          method: "POST",
          signal: AbortSignal.timeout(5000),
        });
        return r.ok;
      } catch {
        return false;
      }
    },

    async health() {
      try {
        const r = await fetch(`${SER_URL}/health`, { signal: AbortSignal.timeout(2000) });
        return r.ok;
      } catch {
        return false;
      }
    },
  };
}

/**
 * 把 emotion tag 映射成给 LLM 的 system-prompt 注入提示
 * 用于 voice-persona.js 拼提示词(Phase 4 实装)
 */
export const EMOTION_LLM_HINT = {
  happy: "用户当前情绪愉快,可以轻松一些",
  sad: "用户当前情绪低落,回复要温和、关切",
  angry: "用户当前情绪烦躁,回复要平和、不要刺激",
  fearful: "用户当前焦虑,回复要安抚、给确定性",
  surprised: "用户感到意外,可以解释清楚",
  disgusted: "用户对某事反感,回复时避开该话题",
  neutral: null,
  other: null,
  unknown: null,
};
