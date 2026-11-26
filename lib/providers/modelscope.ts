/**
 * ModelScope (魔搭) provider plugin
 *
 * 阿里开源模型社区推理服务。
 * 文档：https://modelscope.cn/docs/model-service/API-Inference/intro
 */

import type { ProviderPlugin } from "../../core/types.js";

export const modelscopePlugin: ProviderPlugin = {
  id: "modelscope",
  displayName: "魔搭 (ModelScope)",
  displayNameEn: "ModelScope",
  authType: "api-key",
  defaultBaseUrl: "https://api-inference.modelscope.cn/v1",
  defaultApi: "openai-completions",
};
