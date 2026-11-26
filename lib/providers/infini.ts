/**
 * Infini (无问芯穹) provider plugin
 *
 * 文档：https://cloud.infini-ai.com/genstudio/model/list
 */

import type { ProviderPlugin } from "../../core/types.js";

export const infiniPlugin: ProviderPlugin = {
  id: "infini",
  displayName: "无问芯穹 (Infini)",
  displayNameEn: "Infini",
  authType: "api-key",
  defaultBaseUrl: "https://cloud.infini-ai.com/maas/v1",
  defaultApi: "openai-completions",
};
