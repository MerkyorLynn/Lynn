/**
 * Zhipu Coding Plan provider plugin
 *
 * 智谱编码套餐与通用 GLM API 端点不同，需使用专属 Coding 端点。
 */

import type { ProviderPlugin } from "../../core/types.js";

export const zhipuCodingPlugin: ProviderPlugin = {
  id: "zhipu-coding",
  displayName: "智谱 Coding Plan",
  displayNameEn: "Zhipu Coding Plan",
  authType: "api-key",
  defaultBaseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  defaultApi: "openai-completions",
};
