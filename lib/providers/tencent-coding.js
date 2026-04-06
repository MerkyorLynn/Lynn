/**
 * Tencent Cloud Coding Plan (腾讯云 Coding Plan) provider plugin
 *
 * 文档：https://cloud.tencent.com/document/product/1772
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const tencentCodingPlugin = {
  id: "tencent-coding",
  displayName: "腾讯云 Coding Plan",
  authType: "api-key",
  defaultBaseUrl: "https://api.lkeap.cloud.tencent.com/coding/v3",
  defaultApi: "openai-completions",
};
