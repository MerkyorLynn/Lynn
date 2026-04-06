/**
 * StepFun Coding Plan provider plugin
 *
 * Step Plan 使用专属 Coding 端点，而不是通用 StepFun API 域名。
 * 文档：https://platform.stepfun.com/docs/zh/step-plan/integrations/openclaw
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const stepfunCodingPlugin = {
  id: "stepfun-coding",
  displayName: "阶跃星辰 Coding Plan",
  authType: "api-key",
  defaultBaseUrl: "https://api.stepfun.com/step_plan/v1",
  defaultApi: "openai-completions",
};
