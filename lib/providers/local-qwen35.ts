/**
 * Local Qwen default provider plugin.
 *
 * The model is served by llama.cpp on the user's machine. Startup/download is
 * managed by /api/local-qwen35-9b/*; once smoke passes, this provider becomes a
 * normal OpenAI-compatible local model.
 */

import type { ProviderPlugin } from "../../core/types.js";

export const localQwen35Plugin: ProviderPlugin = {
  id: "local-qwen35-9b-q4km-imatrix",
  displayName: "本地 Qwen3.6-27B",
  displayNameEn: "Local Qwen3.6-27B",
  authType: "none",
  defaultBaseUrl: process.env.LYNN_LOCAL_QWEN35_BASE || "http://127.0.0.1:18099/v1",
  defaultApi: "openai-completions",
};
