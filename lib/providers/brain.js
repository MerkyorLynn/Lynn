/**
 * Brain API provider plugin
 *
 * 默认免费模型服务，走 OpenAI 兼容协议，设备鉴权由 Lynn 的签名头完成。
 */

import {
  BRAIN_PROVIDER_ID,
  BRAIN_PROVIDER_LABEL,
  BRAIN_PROVIDER_BASE_URL,
  BRAIN_PROVIDER_API,
} from "../../shared/brain-provider.js";

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const brainPlugin = {
  id: BRAIN_PROVIDER_ID,
  displayName: BRAIN_PROVIDER_LABEL,
  authType: "none",
  defaultBaseUrl: BRAIN_PROVIDER_BASE_URL,
  defaultApi: BRAIN_PROVIDER_API,
};
