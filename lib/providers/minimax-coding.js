/**
 * MiniMax Coding Plan provider plugin
 *
 * Coding Plan 使用专属订阅 API Key，仍走 MiniMax 兼容接口。
 * 文档：https://platform.minimax.io/docs/coding-plan/quickstart
 */

/** @type {import('../../core/provider-registry.js').ProviderPlugin} */
export const minimaxCodingPlugin = {
  id: "minimax-coding",
  displayName: "MiniMax Coding Plan",
  authType: "api-key",
  defaultBaseUrl: "https://api.minimaxi.com/v1",
  defaultApi: "openai-completions",
};
