/**
 * inferred-profile.js — 辩证式用户画像
 *
 * 在 UserProfile 的统计层之上，补一层轻量语义推断：
 * - 输入：session 摘要 + 现有画像
 * - 输出：增量 traits / goals
 * - 合并：一致则升权，矛盾则降权或替换
 *
 * 存储：{agentDir}/memory/user-inferred.json
 */

import fs from "fs";
import path from "path";
import { callText } from "../../core/llm-client.js";
import { getLocale } from "../../server/i18n.js";

const PROFILE_VERSION = 1;
const MIN_SUMMARY_LENGTH = 80;
const MIN_CONFIDENCE_TO_KEEP = 0.3;
const MIN_CONFIDENCE_TO_PROMPT = 0.6;
const MAX_PROMPT_TRAITS = 4;
const MAX_PROMPT_GOALS = 2;

const ALLOWED_DIMENSIONS = new Set([
  "tech_preference",
  "code_style",
  "work_pattern",
  "communication",
  "domain_knowledge",
  "project_goal",
]);

function createEmptyProfile() {
  return {
    version: PROFILE_VERSION,
    updatedAt: null,
    traits: [],
    goals: [],
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeText(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function extractJsonPayload(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const fenceMatch = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n\s*```\s*$/);
  const candidate = (fenceMatch ? fenceMatch[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeTrait(input, nowIso) {
  const dimension = normalizeText(input?.dimension).toLowerCase();
  const value = normalizeText(input?.value || input?.new_value);
  const confidence = clamp(Number(input?.confidence ?? input?.evidence_strength ?? 0), 0, 1);
  const evidenceCount = Math.max(1, Number(input?.evidenceCount || 1));
  if (!dimension || !value || !ALLOWED_DIMENSIONS.has(dimension)) return null;
  return {
    dimension,
    value,
    confidence,
    evidenceCount,
    lastUpdated: nowIso,
  };
}

function normalizeGoal(input, nowIso) {
  const goal = normalizeText(input?.goal || input?.value);
  const confidence = clamp(Number(input?.confidence ?? input?.evidence_strength ?? 0), 0, 1);
  const evidenceCount = Math.max(1, Number(input?.evidenceCount || 1));
  if (!goal) return null;
  return {
    goal,
    confidence,
    evidenceCount,
    lastUpdated: nowIso,
  };
}

function summarizeExisting(profile) {
  const traits = (profile?.traits || []).map((trait) => ({
    dimension: trait.dimension,
    value: trait.value,
    confidence: Number(trait.confidence || 0),
    evidenceCount: Number(trait.evidenceCount || 0),
  }));
  const goals = (profile?.goals || []).map((goal) => ({
    goal: goal.goal,
    confidence: Number(goal.confidence || 0),
    evidenceCount: Number(goal.evidenceCount || 0),
  }));
  return { traits, goals };
}

function buildInferencePrompt(existing) {
  const isZh = getLocale().startsWith("zh");
  if (isZh) {
    return `你是一个用户建模系统。根据对话摘要，推断用户的稳定偏好与当前目标。

## 现有画像
${JSON.stringify(existing, null, 2)}

## 输出格式
严格输出 JSON，不要 markdown：
{
  "new_traits": [
    { "dimension": "tech_preference", "value": "偏好 TypeScript + React 技术栈", "evidence_strength": 0.8 }
  ],
  "updated_traits": [
    { "dimension": "communication", "direction": "confirm", "new_value": "喜欢直接简洁的回答", "evidence_strength": 0.7 }
  ],
  "new_goals": [
    { "goal": "打造 Lynn 桌面 AI 助手产品并商业化", "evidence_strength": 0.9 }
  ],
  "updated_goals": [
    { "goal": "打造 Lynn 桌面 AI 助手产品并商业化", "direction": "confirm", "new_value": "打造 Lynn 桌面 AI 助手产品并商业化", "evidence_strength": 0.9 }
  ]
}

## 规则
1. 只推断有明确证据的稳定偏好与目标，不要猜测。
2. dimension 只能是：tech_preference, code_style, work_pattern, communication, domain_knowledge, project_goal。
3. evidence_strength 取 0 到 1：单次提及 0.3，反复出现 0.7，明确声明 0.9。
4. 对现有画像一致则用 direction=\"confirm\"；如果明显冲突才用 \"contradict\"。
5. 不推断敏感信息：年龄、性别、政治、宗教、民族、联系方式、住址。
6. 没有新信息就返回空数组。`;
  }

  return `You are a user modeling system. Infer stable preferences and current goals from the conversation summary.

## Existing profile
${JSON.stringify(existing, null, 2)}

## Output format
Return strict JSON, no markdown:
{
  "new_traits": [
    { "dimension": "tech_preference", "value": "Prefers TypeScript + React stacks", "evidence_strength": 0.8 }
  ],
  "updated_traits": [
    { "dimension": "communication", "direction": "confirm", "new_value": "Prefers concise direct answers", "evidence_strength": 0.7 }
  ],
  "new_goals": [
    { "goal": "Build and commercialize the Lynn desktop AI assistant", "evidence_strength": 0.9 }
  ],
  "updated_goals": [
    { "goal": "Build and commercialize the Lynn desktop AI assistant", "direction": "confirm", "new_value": "Build and commercialize the Lynn desktop AI assistant", "evidence_strength": 0.9 }
  ]
}

## Rules
1. Infer only from clear evidence; do not guess.
2. dimension must be one of: tech_preference, code_style, work_pattern, communication, domain_knowledge, project_goal.
3. evidence_strength is 0-1: single mention 0.3, repeated evidence 0.7, explicit statement 0.9.
4. Use direction="confirm" for consistent updates; use "contradict" only for clear conflict.
5. Never infer sensitive information such as age, gender, politics, religion, ethnicity, contact details, or address.
6. Return empty arrays when there is no new information.`;
}

export class InferredProfile {
  constructor({ profilePath }) {
    this._profilePath = profilePath;
    this._profile = null;
  }

  _load() {
    if (this._profile) return this._profile;
    const raw = safeReadJson(this._profilePath, null);
    this._profile = {
      ...createEmptyProfile(),
      ...raw,
      traits: Array.isArray(raw?.traits) ? [...raw.traits] : [],
      goals: Array.isArray(raw?.goals) ? [...raw.goals] : [],
    };
    return this._profile;
  }

  _save() {
    if (!this._profile) return;
    try {
      fs.mkdirSync(path.dirname(this._profilePath), { recursive: true });
      fs.writeFileSync(this._profilePath, JSON.stringify(this._profile, null, 2), "utf-8");
    } catch (err) {
      console.error(`[inferred-profile] save failed: ${err.message}`);
    }
  }

  _mergeTrait(target, update, direction, nowIso) {
    const existing = target.traits.find((item) => item.dimension === update.dimension);
    if (!existing) {
      target.traits.push({
        ...update,
        confidence: clamp(Math.min(0.7, update.confidence || 0.5), 0, 1),
        evidenceCount: 1,
        lastUpdated: nowIso,
      });
      return;
    }

    if (direction === "contradict") {
      if ((update.confidence || 0) > (existing.confidence || 0)) {
        existing.value = update.value;
        existing.confidence = clamp(Math.min(0.7, update.confidence || 0.5), 0, 1);
        existing.evidenceCount = 1;
      } else {
        existing.confidence = clamp((existing.confidence || 0) * 0.85, 0, 1);
      }
      existing.lastUpdated = nowIso;
      return;
    }

    existing.value = update.value || existing.value;
    existing.confidence = clamp(
      (existing.confidence || 0) + (1 - (existing.confidence || 0)) * 0.15,
      0,
      0.99,
    );
    existing.evidenceCount = Number(existing.evidenceCount || 0) + 1;
    existing.lastUpdated = nowIso;
  }

  _mergeGoal(target, update, direction, nowIso) {
    const existing = target.goals.find((item) => normalizeText(item.goal) === normalizeText(update.goal));
    if (!existing) {
      target.goals.push({
        ...update,
        confidence: clamp(Math.min(0.8, update.confidence || 0.5), 0, 1),
        evidenceCount: 1,
        lastUpdated: nowIso,
      });
      return;
    }

    if (direction === "contradict") {
      if ((update.confidence || 0) > (existing.confidence || 0)) {
        existing.goal = update.goal;
        existing.confidence = clamp(Math.min(0.75, update.confidence || 0.5), 0, 1);
        existing.evidenceCount = 1;
      } else {
        existing.confidence = clamp((existing.confidence || 0) * 0.85, 0, 1);
      }
      existing.lastUpdated = nowIso;
      return;
    }

    existing.confidence = clamp(
      (existing.confidence || 0) + (1 - (existing.confidence || 0)) * 0.15,
      0,
      0.99,
    );
    existing.evidenceCount = Number(existing.evidenceCount || 0) + 1;
    existing.lastUpdated = nowIso;
  }

  _prune(profile) {
    profile.traits = (profile.traits || [])
      .filter((item) => normalizeText(item.value) && Number(item.confidence || 0) >= MIN_CONFIDENCE_TO_KEEP)
      .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
    profile.goals = (profile.goals || [])
      .filter((item) => normalizeText(item.goal) && Number(item.confidence || 0) >= MIN_CONFIDENCE_TO_KEEP)
      .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));
  }

  applyInference(delta) {
    const profile = this._load();
    const nowIso = new Date().toISOString();

    for (const item of delta?.new_traits || []) {
      const trait = normalizeTrait(item, nowIso);
      if (!trait) continue;
      this._mergeTrait(profile, trait, "confirm", nowIso);
    }

    for (const item of delta?.updated_traits || []) {
      const trait = normalizeTrait(item, nowIso);
      const direction = normalizeText(item?.direction).toLowerCase() === "contradict" ? "contradict" : "confirm";
      if (!trait) continue;
      this._mergeTrait(profile, trait, direction, nowIso);
    }

    for (const item of delta?.new_goals || []) {
      const goal = normalizeGoal(item, nowIso);
      if (!goal) continue;
      this._mergeGoal(profile, goal, "confirm", nowIso);
    }

    for (const item of delta?.updated_goals || []) {
      const goal = normalizeGoal(item, nowIso);
      const direction = normalizeText(item?.direction).toLowerCase() === "contradict" ? "contradict" : "confirm";
      if (!goal) continue;
      this._mergeGoal(profile, goal, direction, nowIso);
    }

    profile.version = PROFILE_VERSION;
    profile.updatedAt = nowIso;
    this._prune(profile);
    this._save();
    return profile;
  }

  async inferFromSession(summaryText, resolvedModel) {
    if (!summaryText || summaryText.trim().length < MIN_SUMMARY_LENGTH) return null;
    if (!resolvedModel?.model || !resolvedModel?.api || !resolvedModel?.base_url) return null;

    const existing = summarizeExisting(this._load());
    const prompt = buildInferencePrompt(existing);
    const raw = await callText({
      api: resolvedModel.api,
      apiKey: resolvedModel.api_key,
      baseUrl: resolvedModel.base_url,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      systemPrompt: prompt,
      messages: [{ role: "user", content: summaryText }],
      temperature: 0.2,
      maxTokens: 1200,
      timeoutMs: 45_000,
      requestHeaders: resolvedModel.requestHeaders || null,
    });

    const parsed = extractJsonPayload(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return this.applyInference(parsed);
  }

  formatForPrompt(isZh) {
    const profile = this._load();
    const traits = (profile.traits || [])
      .filter((item) => Number(item.confidence || 0) >= MIN_CONFIDENCE_TO_PROMPT)
      .slice(0, MAX_PROMPT_TRAITS)
      .map((item) => item.value);
    const goals = (profile.goals || [])
      .filter((item) => Number(item.confidence || 0) >= MIN_CONFIDENCE_TO_PROMPT)
      .slice(0, MAX_PROMPT_GOALS)
      .map((item) => item.goal);

    if (traits.length === 0 && goals.length === 0) return "";

    const parts = [];
    if (traits.length > 0) {
      parts.push(isZh ? `用户特征：${traits.join(" | ")}` : `User traits: ${traits.join(" | ")}`);
    }
    if (goals.length > 0) {
      parts.push(isZh ? `当前目标：${goals.join(" | ")}` : `Current goals: ${goals.join(" | ")}`);
    }
    return parts.join("\n");
  }

  getRawProfile() {
    return this._load();
  }
}
