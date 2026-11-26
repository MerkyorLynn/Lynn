/**
 * DashScope Coding Plan (百炼 Coding Plan) provider plugin
 *
 * 阿里云百炼 Coding Plan 订阅，与 dashscope (按量付费) 是同一厂商的不同接入方式。
 * 专用端点 coding.dashscope，API key 以 sk-sp- 开头。
 *
 * 文档：https://help.aliyun.com/zh/model-studio/coding-plan
 */

import type { ProviderPlugin } from "../../core/types.js";

export const dashscopeCodingPlugin: ProviderPlugin = {
  id: "dashscope-coding",
  displayName: "百炼 Coding Plan",
  displayNameEn: "DashScope Coding Plan",
  authType: "api-key",
  defaultBaseUrl: "https://coding.dashscope.aliyuncs.com/v1",
  defaultApi: "openai-completions",
};
