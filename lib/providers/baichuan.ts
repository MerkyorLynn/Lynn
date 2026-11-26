/**
 * Baichuan (百川智能) provider plugin
 *
 * 文档：https://platform.baichuan-ai.com/docs/api
 */

import type { ProviderPlugin } from "../../core/types.js";

export const baichuanPlugin: ProviderPlugin = {
  id: "baichuan",
  displayName: "百川智能",
  displayNameEn: "Baichuan",
  authType: "api-key",
  defaultBaseUrl: "https://api.baichuan-ai.com/v1",
  defaultApi: "openai-completions",
};
