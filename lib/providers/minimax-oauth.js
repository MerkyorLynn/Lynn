/**
 * MiniMax OAuth provider plugin
 *
 * MiniMax 官方 OAuth 接入（区别于通过 DashScope 转发的 MiniMax 模型）。
 * authType: "oauth"，对应 auth.json 中的 minimax 条目。
 */

/** @type {import('../provider-registry.js').ProviderPlugin} */
export const minimaxOAuthPlugin = {
  id: "minimax-oauth",
  displayName: "MiniMax (OAuth)",
  authType: "oauth",
  defaultBaseUrl: "https://api.minimaxi.com/v1",
  defaultApi: "openai-completions",
  /** auth.json 中对应的 provider key（Pi SDK 用这个 key 存 token）*/
  authJsonKey: "minimax",
};
