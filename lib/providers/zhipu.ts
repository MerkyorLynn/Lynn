/**
 * Zhipu AI (智谱) provider plugin
 *
 * GLM 系列大模型。
 * 文档：https://open.bigmodel.cn/dev/api/overview
 */

import type { ProviderPlugin } from "../../core/types.js";

export const zhipuPlugin: ProviderPlugin = {
  id: "zhipu",
  displayName: "智谱 AI (GLM)",
  displayNameEn: "Zhipu AI (GLM)",
  authType: "api-key",
  defaultBaseUrl: "https://open.bigmodel.cn/api/paas/v4",
  defaultApi: "openai-completions",
};
