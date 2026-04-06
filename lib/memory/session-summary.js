/**
 * session-summary.js — Session 摘要管理器
 *
 * 每个 session 一个 JSON 文件（存在 memory/summaries/ 下），
 * 包含摘要文本 + 深度记忆处理的 snapshot。
 *
 * 摘要通过 rollingSummary() 滚动更新（覆盖式，非追加），
 * 输出固定为 ## 重要事实 + ## 事情经过 两节格式。
 *
 * 同时服务：
 * - 普通记忆（compile.js 读摘要 → 递归压缩 → memory.md）
 * - 深度记忆（deep-memory.js 读 snapshot diff → 拆元事实）
 */

import fs from "fs";
import path from "path";
import { scrubPII } from "../pii-guard.js";
import { callText } from "../../core/llm-client.js";
import { getLocale } from "../../server/i18n.js";

export class SessionSummaryManager {
  /**
   * @param {string} summariesDir - summaries/ 目录的绝对路径
   */
  constructor(summariesDir) {
    this.summariesDir = summariesDir;
    fs.mkdirSync(summariesDir, { recursive: true });
    this._cache = new Map();          // sessionId → summary data
    this._cachePopulated = false;     // 是否已做过全量扫描
  }

  // ════════════════════════════
  //  读写
  // ════════════════════════════

  /**
   * 读取指定 session 的摘要
   * @param {string} sessionId
   * @returns {object|null}
   */
  getSummary(sessionId) {
    if (this._cache.has(sessionId)) return this._cache.get(sessionId);
    const fp = this._filePath(sessionId);
    try {
      const data = JSON.parse(fs.readFileSync(fp, "utf-8"));
      this._cache.set(sessionId, data);
      return data;
    } catch {
      return null;
    }
  }

  /**
   * 写入摘要（原子写入）
   * @param {string} sessionId
   * @param {object} data
   */
  saveSummary(sessionId, data) {
    const fp = this._filePath(sessionId);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const tmp = fp + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    fs.renameSync(tmp, fp);
    this._cache.set(sessionId, data);
  }

  // ════════════════════════════
  //  脏 session 追踪（供深度记忆用）
  // ════════════════════════════

  /**
   * 获取所有"脏" session（summary !== snapshot）
   * @returns {Array<{ session_id, summary, snapshot, snapshot_at, updated_at }>}
   */
  getDirtySessions() {
    this._ensureCachePopulated();
    const dirty = [];
    for (const data of this._cache.values()) {
      if (!data?.summary) continue;
      if (data.summary !== (data.snapshot || "")) {
        dirty.push(data);
      }
    }
    return dirty;
  }

  /**
   * 标记 session 已被深度记忆处理（snapshot = summary）
   * @param {string} sessionId
   */
  markProcessed(sessionId) {
    const data = this.getSummary(sessionId);
    if (!data) return;

    data.snapshot = data.summary;
    data.snapshot_at = new Date().toISOString();
    this.saveSummary(sessionId, data);
  }

  // ════════════════════════════
  //  查询
  // ════════════════════════════

  /**
   * 获取所有摘要（按 updated_at 降序）
   * @returns {Array<object>}
   */
  getAllSummaries() {
    this._ensureCachePopulated();
    const summaries = [];
    for (const data of this._cache.values()) {
      if (data?.summary) summaries.push(data);
    }
    summaries.sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
    return summaries;
  }

  /** 首次调用时做一次全量扫描填充缓存 */
  _ensureCachePopulated() {
    if (this._cachePopulated) return;
    const files = this._listFiles();
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(file, "utf-8"));
        if (data?.session_id) this._cache.set(data.session_id, data);
      } catch (e) { console.warn("[session-summary]", e.message || e); }
    }
    this._cachePopulated = true;
  }

  /**
   * 获取指定日期范围内的摘要
   * @param {Date} startDate
   * @param {Date} endDate
   * @returns {Array<object>}
   */
  getSummariesInRange(startDate, endDate) {
    const startISO = startDate.toISOString();
    const endISO = endDate.toISOString();

    return this.getAllSummaries().filter((s) => {
      const updated = s.updated_at || s.created_at || "";
      return updated >= startISO && updated <= endISO;
    });
  }

  // ════════════════════════════
  //  内部
  // ════════════════════════════

  _filePath(sessionId) {
    // session 文件名可能包含时间戳前缀（如 1234567890_uuid），
    // 直接取 uuid 部分（去掉 .jsonl 后缀和时间戳前缀）
    const cleanId = sessionId.replace(/\.jsonl$/, "");
    return path.join(this.summariesDir, `${cleanId}.json`);
  }

  _listFiles() {
    try {
      return fs.readdirSync(this.summariesDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => path.join(this.summariesDir, f));
    } catch {
      return [];
    }
  }

  /**
   * 从消息列表构建带时间戳的对话文本
   * @param {Array<{role: string, content: any, timestamp?: string}>} messages
   * @returns {string}
   */
  _buildConversationText(messages) {
    const ASSISTANT_CAP = 300; // 助手消息截断上限（字符）
    const parts = [];

    for (const msg of messages) {
      const text = this._extractText(msg);
      if (!text) continue;

      // 时间标注
      let timePrefix = "";
      if (msg.timestamp) {
        const d = new Date(msg.timestamp);
        if (!isNaN(d.getTime())) {
          const h = String(d.getHours()).padStart(2, "0");
          const m = String(d.getMinutes()).padStart(2, "0");
          timePrefix = `[${h}:${m}] `;
        }
      }

      const isZh = getLocale().startsWith("zh");
      const speaker = msg.role === "user" ? (isZh ? "用户" : "User") : (isZh ? "助手" : "Assistant");
      let processed = text;

      if (msg.role === "assistant" && processed.length > ASSISTANT_CAP) {
        processed = processed.slice(0, ASSISTANT_CAP) + (isZh ? "…（长回复已截断）" : "… (long reply truncated)");
      }

      parts.push(`${timePrefix}【${speaker}】${processed}`);
    }

    return parts.join("\n\n");
  }

  // ════════════════════════════
  //  滚动摘要
  // ════════════════════════════

  /**
   * 滚动更新 session 摘要：每 10 轮或 session 结束时触发。
   * 若有旧摘要则将旧摘要 + 新对话合并产出新摘要（覆盖，非追加）；
   * 若无旧摘要则直接从对话生成。
   * 输出格式固定为两节：## 重要事实 + ## 事情经过。
   *
   * @param {string} sessionId
   * @param {Array<{role: string, content: any, timestamp?: string}>} messages
   * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
   * @returns {Promise<string>} 更新后的摘要文本
   */
  async rollingSummary(sessionId, messages, resolvedModel) {
    const existing = this.getSummary(sessionId);
    const prevSummary = existing?.summary || "";

    const convText = this._buildConversationText(messages);
    if (!convText) return prevSummary;

    // 按用户消息轮数计算摘要配额
    const turnCount = messages.filter((m) => m.role === "user").length;
    let newSummary = await this._callRollingLLM(convText, prevSummary, resolvedModel, turnCount);
    if (!newSummary?.trim()) return prevSummary;

    // PII 脱敏
    const { cleaned: scrubbedRolling, detected: rollingDetected } = scrubPII(newSummary);
    if (rollingDetected.length > 0) {
      console.warn(`[session-summary] PII detected in rolling summary (${rollingDetected.join(", ")}), redacted`);
      newSummary = scrubbedRolling;
    }

    const now = new Date().toISOString();
    this.saveSummary(sessionId, {
      session_id: sessionId,
      created_at: existing?.created_at || now,
      updated_at: now,
      summary: newSummary.trim(),
      snapshot: existing?.snapshot || "",
      snapshot_at: existing?.snapshot_at || null,
    });

    return newSummary.trim();
  }

  /**
   * 调用 LLM 生成滚动摘要（两节格式）
   * @param {string} convText - 本次对话文本
   * @param {string} prevSummary - 上一次摘要（可为空）
   * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
   * @returns {Promise<string>}
   */
  async _callRollingLLM(convText, prevSummary, resolvedModel, turnCount = 10) {
    const { model: utilityModel, api, api_key, base_url } = resolvedModel;

    const isZh = getLocale().startsWith("zh");
    const hasPrev = !!prevSummary;

    // 按轮数线性缩放：每轮 40 字配额，10 轮封顶 400 字
    const totalBudget = Math.min(400, Math.max(40, turnCount * 40));
    const factsBudget = Math.max(15, Math.round(totalBudget * 0.3));
    const eventsBudget = totalBudget - factsBudget;

    // 英文 budget 按 word 估算（约 1.5x 字符比）
    const factsWordBudget = Math.max(10, Math.round(factsBudget * 0.6));
    const eventsWordBudget = Math.max(20, Math.round(eventsBudget * 0.6));

    const systemPrompt = isZh
      ? `你是一个对话记忆系统。请根据${hasPrev ? "已有摘要和新增对话" : "以下对话"}，生成一份结构化摘要。

## 核心原则
摘要以用户侧为中心：记录用户说了什么、要了什么、决定了什么。助手的回复只需记录"做了什么"（如"生成了一篇关于X的文章""写了一段代码实现Y功能"），不记录回复的具体内容。

## 输出格式（严格遵守，直接以 ## 开头）

## 重要事实
本次对话中出现的稳定信息：用户的偏好、决定、习惯、身份特征。没有则写"无"。
字数要求：按实际信息量写，最多${factsBudget}字。信息少就写短，不要凑字数。

## 事情经过
按时间顺序记录发生了什么，带 HH:MM 时间标注，抓重点脉络。
字数要求：按实际信息量写，最多${eventsBudget}字。三句话能说清的事不要写成一段。

## 规则
1. 有已有摘要时：新旧内容合并，同一件事以新信息为准，不要重复
2. 时间标注从消息时间戳提取（HH:MM 格式）
3. 只记录客观事实，不记录 MOOD 或助手内心想法
4. 用户提供的文件/附件：只记录文件名和用途，忽略文件的具体内容
5. 助手的长篇输出（文章、代码、分析等）：只记录产出了什么，不摘录内容
6. 宁短勿长：摘要长度应与对话的实际信息密度成正比，闲聊几句只需一两行
7. 直接以 ## 重要事实 开头输出，不要前言后记`
      : `You are a conversation memory system. Based on ${hasPrev ? "the existing summary and new conversation" : "the following conversation"}, generate a structured summary.

## Core Principle
The summary is user-centric: record what the user said, requested, and decided. For the assistant's replies, only record what was done (e.g. "generated an article about X", "wrote code implementing Y"), not the actual content.

## Output Format (strictly follow, start directly with ##)

## Key Facts
Stable information from this conversation: user preferences, decisions, habits, identity traits. Write "None" if none.
Word limit: write according to actual information, max ${factsWordBudget} words. Keep it short if there's little info.

## Timeline
Record what happened in chronological order with HH:MM timestamps, capturing key points.
Word limit: write according to actual information, max ${eventsWordBudget} words. If three sentences suffice, don't write a paragraph.

## Rules
1. When existing summary is present: merge old and new, use newer info for the same topic, no duplicates
2. Extract time annotations from message timestamps (HH:MM format)
3. Only record objective facts, not MOOD or assistant's inner thoughts
4. User-provided files/attachments: only record filename and purpose, ignore file contents
5. Assistant's long outputs (articles, code, analysis): only record what was produced, don't excerpt content
6. Prefer brevity: summary length should be proportional to actual information density
7. Start output directly with ## Key Facts, no preamble or conclusion`;

    let userContent = "";
    if (hasPrev) {
      const prevLabel = isZh ? "## 已有摘要" : "## Existing Summary";
      const newLabel = isZh ? "## 新增对话" : "## New Conversation";
      userContent = `${prevLabel}\n\n${prevSummary}\n\n${newLabel}\n\n${convText}`;
    } else {
      userContent = convText;
    }

    // max_tokens 跟着配额走，避免固定值引导 LLM 写满
    const maxTokens = Math.max(150, Math.min(750, Math.round(totalBudget * 1.5)));

    return callText({
      api, model: utilityModel,
      apiKey: api_key,
      baseUrl: base_url,
      systemPrompt,
      messages: [{ role: "user", content: userContent }],
      temperature: 0.3,
      maxTokens: maxTokens,
      timeoutMs: 60_000,
    });
  }

  /** 从 message 的 content 提取纯文本 */
  _extractText(msg) {
    if (!msg.content) return "";
    if (typeof msg.content === "string") return msg.content;
    return msg.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
}
