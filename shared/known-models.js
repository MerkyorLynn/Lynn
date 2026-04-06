/**
 * known-models.js — 模型词典查询
 *
 * 加载 lib/known-models.json（provider → model 二级结构），
 * 提供 lookupKnown(provider, modelId) 查询接口。
 */
import { readFileSync } from "fs";
import { fromRoot } from "./hana-root.js";

const _raw = JSON.parse(readFileSync(fromRoot("lib", "known-models.json"), "utf-8"));

/**
 * 查词典：provider + modelId 二级查找，fallback 遍历所有 provider
 * @param {string} provider
 * @param {string} modelId
 * @returns {object|null}
 */
export function lookupKnown(provider, modelId) {
  if (typeof modelId !== "string" || !modelId.trim()) return null;
  if (provider && _raw[provider]?.[modelId]) return _raw[provider][modelId];
  const bare = modelId.includes("/") ? modelId.split("/").pop() : null;
  if (bare && provider && _raw[provider]?.[bare]) return _raw[provider][bare];
  for (const models of Object.values(_raw)) {
    if (typeof models !== "object" || models === null) continue;
    if (models[modelId]) return models[modelId];
    if (bare && models[bare]) return models[bare];
  }
  return null;
}

/**
 * 查询模型的工具分层等级
 * @param {string} provider
 * @param {string} modelId
 * @returns {"full"|"standard"|"minimal"|null} null = 未知，按 full 处理
 */
export function lookupToolTier(provider, modelId) {
  const known = lookupKnown(provider, modelId);
  return known?.toolTier || null;
}
