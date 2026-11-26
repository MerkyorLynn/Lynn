/**
 * Tencent Hunyuan (腾讯混元) provider plugin
 *
 * 文档：https://cloud.tencent.com/document/product/1729
 */

import type { ProviderPlugin } from "../../core/types.js";

export const hunyuanPlugin: ProviderPlugin = {
  id: "hunyuan",
  displayName: "腾讯混元",
  displayNameEn: "Tencent Hunyuan",
  authType: "api-key",
  defaultBaseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
  defaultApi: "openai-completions",
};
