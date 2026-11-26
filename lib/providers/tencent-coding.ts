/**
 * Tencent Cloud Coding Plan (腾讯云 Coding Plan) provider plugin
 *
 * 文档：https://cloud.tencent.com/document/product/1772
 */

import type { ProviderPlugin } from "../../core/types.js";

export const tencentCodingPlugin: ProviderPlugin = {
  id: "tencent-coding",
  displayName: "腾讯云 Coding Plan",
  displayNameEn: "Tencent Cloud Coding Plan",
  authType: "api-key",
  defaultBaseUrl: "https://api.lkeap.cloud.tencent.com/coding/v3",
  defaultApi: "openai-completions",
};
