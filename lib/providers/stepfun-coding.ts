/**
 * StepFun Coding Plan provider plugin
 *
 * Step Plan 使用专属 Coding 端点，而不是通用 StepFun API 域名。
 * 文档：https://platform.stepfun.com/docs/zh/step-plan/integrations/openclaw
 */

import type { ProviderPlugin } from "../../core/types.js";

export const stepfunCodingPlugin: ProviderPlugin = {
  id: "stepfun-coding",
  displayName: "阶跃星辰 Coding Plan",
  displayNameEn: "StepFun Coding Plan",
  authType: "api-key",
  defaultBaseUrl: "https://api.stepfun.com/step_plan/v1",
  defaultApi: "openai-completions",
};
