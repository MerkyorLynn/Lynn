/**
 * SiliconFlow (硅基流动) provider plugin
 *
 * 聚合平台，支持 DeepSeek、Qwen、GLM、Llama 等 70+ 开源模型。
 * 文档：https://docs.siliconflow.cn
 */

import type { ProviderPlugin } from "../../core/types.js";

export const siliconflowPlugin: ProviderPlugin = {
  id: "siliconflow",
  displayName: "SiliconFlow (硅基流动)",
  displayNameEn: "SiliconFlow",
  authType: "api-key",
  defaultBaseUrl: "https://api.siliconflow.cn/v1",
  defaultApi: "openai-completions",
};
