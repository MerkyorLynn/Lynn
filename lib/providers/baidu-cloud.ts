/**
 * Baidu Cloud (百度智能云 / 千帆 / 文心) provider plugin
 *
 * 文档：https://cloud.baidu.com/doc/WENXINWORKSHOP/s/jlil56u11
 */

import type { ProviderPlugin } from "../../core/types.js";

export const baiduCloudPlugin: ProviderPlugin = {
  id: "baidu-cloud",
  displayName: "百度智能云 (文心)",
  displayNameEn: "Baidu Cloud (ERNIE)",
  authType: "api-key",
  defaultBaseUrl: "https://qianfan.baidubce.com/v2",
  defaultApi: "openai-completions",
};
