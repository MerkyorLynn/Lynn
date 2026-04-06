/**
 * experience-extractor.js — session 结束后台经验提取
 *
 * 与 deep-memory.js 同构：从 session summary 中提取操作教训，
 * 写入经验分类文件。由 memory-ticker 的 notifySessionEnd 调用。
 */

import { recordEntry } from "./tools/experience.js";
import { callText } from "../core/llm-client.js";
import { getLocale } from "../server/i18n.js";

/**
 * 从 session summary 中提取经验教训
 *
 * @param {string} summaryText - session 摘要文本
 * @param {string} experienceDir - experience/ 目录路径
 * @param {string} indexPath - experience.md 索引路径
 * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
 * @returns {Promise<{ extracted: number }>}
 */
export async function extractSessionExperiences(
  summaryText,
  experienceDir,
  indexPath,
  resolvedModel,
) {
  if (!summaryText || summaryText.trim().length < 100) {
    return { extracted: 0 };
  }

  const { model: utilityModel, api, api_key, base_url } = resolvedModel;
  const raw = await callText({
    api, model: utilityModel,
    apiKey: api_key,
    baseUrl: base_url,
    systemPrompt: buildExtractionPrompt(),
    messages: [{ role: "user", content: summaryText }],
    temperature: 0.3,
    maxTokens: 2048,
    timeoutMs: 60_000,
  });

  // 兼容 markdown 代码块包裹
  const fenceMatch = raw.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  const jsonStr = (fenceMatch ? fenceMatch[1] : raw).trim();

  let entries;
  try {
    entries = JSON.parse(jsonStr);
    if (!Array.isArray(entries)) return { extracted: 0 };
  } catch {
    console.error(`[experience] JSON 解析失败: ${jsonStr.slice(0, 200)}`);
    return { extracted: 0 };
  }

  let extracted = 0;
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.category !== "string" ||
      typeof entry.content !== "string" ||
      !entry.category.trim() ||
      !entry.content.trim()
    ) {
      continue;
    }

    const result = recordEntry(
      experienceDir,
      indexPath,
      entry.category.trim(),
      entry.content.trim(),
    );
    if (result.added) extracted++;
  }

  if (extracted > 0) {
    console.log(
      `\x1b[90m[experience] 提取了 ${extracted} 条经验\x1b[0m`,
    );
  }

  return { extracted };
}

function buildExtractionPrompt() {
  const isZh = getLocale().startsWith("zh");

  if (isZh) {
    return `你是一个经验提取器。分析以下对话摘要，提取可复用的操作教训。

## 提取标准

只提取以下类型的内容：
1. **用户纠正**：用户指出助手犯了错误，并说明了正确做法
2. **试错成功**：助手尝试了多种方法，最终发现了有效做法
3. **行为指令**：用户明确给出「以后要/不要这样做」的指令

## 不要提取

- 关于用户的事实性信息（偏好、身份、项目背景等）
- 一次性的、不可复用的操作细节
- 对话内容的简单复述

## 输出格式

严格 JSON 数组，不要 markdown 代码块：
[
  {"category": "工具使用", "content": "搜索时先用 web_search 再用 web_fetch"},
  {"category": "回答风格", "content": "解释技术概念时多用类比"}
]

- category：2-4 字的短语分类名
- content：一句话，简洁直接
- 如果没有可提取的教训，返回空数组 []`;
  }

  return `You are an experience extractor. Analyze the following conversation summary and extract reusable operational lessons.

## Extraction Criteria

Only extract the following types of content:
1. **User corrections**: The user pointed out a mistake the assistant made and explained the correct approach
2. **Trial-and-error successes**: The assistant tried multiple approaches and ultimately found an effective method
3. **Behavioral directives**: The user explicitly gave instructions like "do/don't do this in the future"

## Do NOT Extract

- Factual information about the user (preferences, identity, project background, etc.)
- One-off, non-reusable operational details
- Simple restatements of conversation content

## Output Format

Strict JSON array, no markdown code blocks:
[
  {"category": "tool usage", "content": "Use web_search before web_fetch when searching"},
  {"category": "response style", "content": "Use analogies when explaining technical concepts"}
]

- category: a short phrase (2-4 words) as category name
- content: one sentence, concise and direct
- If no lessons can be extracted, return an empty array []`;
}
