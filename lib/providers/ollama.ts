/**
 * Ollama provider plugin (本地模型)
 *
 * 无需认证，默认监听 localhost:11434。
 */

import type { ProviderPlugin } from "../../core/types.js";

export const ollamaPlugin: ProviderPlugin = {
  id: "ollama",
  displayName: "Ollama (本地)",
  displayNameEn: "Ollama (Local)",
  authType: "none",
  defaultBaseUrl: "http://localhost:11434/v1",
  defaultApi: "openai-completions",
};
