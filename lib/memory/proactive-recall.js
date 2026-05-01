/**
 * proactive-recall.js — 主动记忆召回
 *
 * 每条用户消息发给 LLM 前，快速提取关键词 → 搜索 FactStore + 经验库
 * → 将相关结果作为隐形上下文注入 system prompt 尾部。
 *
 * 设计原则：
 * - 纯正则/启发式提取关键词（<5ms，不调 LLM）
 * - 总搜索耗时 < 50ms（SQLite prepared statements）
 * - 注入上限：5 facts + 2 experiences ≈ 300 tokens
 * - 格式化时不暴露"记忆"存在（隐形助手原则）
 */

import fs from "fs";
import path from "path";

/**
 * 中文词组正则：2-8 个连续汉字（避免单字噪声）
 */
const RE_ZH_WORDS = /[\u4e00-\u9fff]{2,8}/g;

/**
 * 英文术语正则：2+ 个字母组成的单词（含连字符，如 "Next.js"）
 */
const RE_EN_TERMS = /[A-Za-z][\w.-]*[A-Za-z\d]/g;

/**
 * 引号内容（中英文引号）
 */
const RE_QUOTED = /[""「]([^""」]{2,30})[""」]/g;

/**
 * 常见停用词（不参与检索）
 */
const STOP_WORDS = new Set([
  // 中文
  "什么", "怎么", "如何", "为什么", "可以", "能不能", "是否", "有没有",
  "帮我", "请问", "谢谢", "麻烦", "一下", "这个", "那个", "还是",
  "已经", "然后", "但是", "所以", "因为", "不过", "或者", "以及",
  // 英文
  "the", "this", "that", "what", "how", "why", "can", "could",
  "would", "should", "please", "help", "with", "from", "about",
  "have", "has", "been", "will", "just", "some", "also", "like",
]);

const CATEGORY_HINTS = [
  {
    category: "pitfall",
    pattern: /(踩坑|坑|教训|误区|bug|故障|失败|回归|超时|卡死|崩溃|不兼容|timeout|regression|failure|failed|broken|hang|stuck)/i,
  },
  {
    category: "task",
    pattern: /(当前任务|下一步|待办|计划|进行中|阻塞|继续|收尾|todo|next step|in progress|blocked|active task)/i,
  },
  {
    category: "model_benchmark",
    pattern: /(吞吐|门禁|基准|测速|压测|并发|tok\/s|tokens\/s|t\/s|benchmark|v8|mtp|nvfp4|fp4|fp8|qwen|deepseek|spark|dgx)/i,
  },
  {
    category: "project_decision",
    pattern: /(决定|决策|取舍|采用|弃用|保留|迁移|改成|架构选择|adr|decision)/i,
  },
  {
    category: "procedure",
    pattern: /(流程|步骤|操作手册|排障|复现|命令|runbook|playbook|procedure|workflow)/i,
  },
];

const NOTE_FACT_CATEGORIES = new Set(["pitfall", "procedure"]);
const TASK_FACT_CATEGORIES = new Set(["task"]);

function inferPreferredCategories(message, keywords = []) {
  const haystack = `${message || ""} ${keywords.join(" ")}`;
  const preferred = [];
  for (const hint of CATEGORY_HINTS) {
    if (hint.pattern.test(haystack)) preferred.push(hint.category);
  }
  return preferred;
}

function factCategory(fact) {
  return String(fact?.category || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_");
}

export class ProactiveRecall {
  /**
   * @param {object} opts
   * @param {import('./fact-store.js').FactStore} opts.factStore
   * @param {string} opts.experienceDir - experience/ 目录路径
   * @param {string} opts.experienceIndexPath - experience.md 索引路径
   * @param {() => boolean} opts.isMemoryEnabled - 综合记忆开关
   */
  constructor({ factStore, experienceDir, experienceIndexPath, isMemoryEnabled }) {
    this._factStore = factStore;
    this._experienceDir = experienceDir;
    this._experienceIndexPath = experienceIndexPath;
    this._isMemoryEnabled = isMemoryEnabled;
    this._retriever = null; // Phase 4: HybridRetriever 替代直接 FactStore 调用
  }

  /**
   * Phase 4 接口：注入 HybridRetriever
   */
  setRetriever(retriever) {
    this._retriever = retriever;
  }

  /**
   * 从用户消息中提取关键词（纯正则，<5ms）
   *
   * @param {string} message - 用户消息文本
   * @returns {string[]} - top-5 关键词
   */
  extractKeywords(message) {
    if (!message || typeof message !== "string") return [];

    // 提取文本内容（处理数组格式的 content）
    const text = message.trim();
    if (!text) return [];

    const candidates = new Map(); // word → score

    // 1. 引号内容（最高优先级）
    let match;
    while ((match = RE_QUOTED.exec(text)) !== null) {
      const word = match[1].trim();
      if (word.length >= 2) {
        candidates.set(word, (candidates.get(word) || 0) + 3);
      }
    }

    // 2. 中文词组
    const zhMatches = text.match(RE_ZH_WORDS) || [];
    for (const w of zhMatches) {
      if (!STOP_WORDS.has(w)) {
        candidates.set(w, (candidates.get(w) || 0) + 2);
      }
    }

    // 3. 英文术语（过滤常见词和极短词）
    const enMatches = text.match(RE_EN_TERMS) || [];
    for (const w of enMatches) {
      const lower = w.toLowerCase();
      if (!STOP_WORDS.has(lower) && w.length >= 3) {
        // 保留原始大小写（技术术语大小写敏感）
        candidates.set(w, (candidates.get(w) || 0) + 1);
      }
    }

    // 按分数排序，取 top-5
    return [...candidates.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([word]) => word);
  }

  /**
   * 主入口：召回相关记忆和经验
   *
   * @param {string} userMessage - 用户消息
   * @param {object} [context] - 可选上下文
   * @param {string[]} [context.projectTags] - Phase 2: 项目标签（framework, language）
   * @returns {Promise<{ facts: Array, experiences: Array, keywords: string[], preferredCategories: string[] }>}
   */
  async recall(userMessage, context = {}) {
    if (!this._isMemoryEnabled()) {
      return { facts: [], experiences: [], keywords: [], preferredCategories: [] };
    }

    const keywords = this.extractKeywords(userMessage);
    if (keywords.length === 0) {
      return { facts: [], experiences: [], keywords: [], preferredCategories: [] };
    }

    // 合并项目标签（Phase 2 注入）
    const allKeywords = context.projectTags
      ? [...keywords, ...context.projectTags.filter(t => !keywords.includes(t))]
      : keywords;
    const preferredCategories = inferPreferredCategories(userMessage, allKeywords);

    // 并行搜索
    const [facts, experiences] = await Promise.all([
      this._searchFacts(allKeywords, {
        projectPath: context.projectPath,
        preferredCategories,
      }),
      this._scanExperiences(keywords),
    ]);

    return { facts, experiences, keywords, preferredCategories };
  }

  /**
   * 搜索 FactStore（tag + FTS 混合）
   *
   * @param {string[]} keywords
   * @returns {Promise<Array<{ fact: string, tags: string[], time: string }>>}
   */
  async _searchFacts(keywords, opts = {}) {
    if (!this._factStore || this._factStore.size === 0) return [];

    // Phase 4: 使用 HybridRetriever
    if (this._retriever) {
      const results = await this._retriever.search(keywords, 5, {
        projectPath: opts.projectPath,
        preferredCategories: opts.preferredCategories || [],
      });
      return results;
    }

    // 默认：使用 FactStore.searchCombined
    try {
      if (opts.projectPath && typeof this._factStore.searchByProject === "function") {
        return this._factStore.searchByProject(opts.projectPath, keywords, 5);
      }
      return this._factStore.searchCombined(keywords, 5);
    } catch (err) {
      console.error(`[proactive-recall] fact search failed: ${err.message}`);
      return [];
    }
  }

  /**
   * 扫描经验库（字符串匹配 experience.md 索引）
   *
   * @param {string[]} keywords
   * @returns {Promise<Array<{ category: string, content: string }>>}
   */
  async _scanExperiences(keywords) {
    if (!this._experienceDir || !this._experienceIndexPath) return [];

    try {
      const index = _safeReadFile(this._experienceIndexPath);
      if (!index.trim()) return [];

      // 扫描索引找到匹配的分类
      const matchedCategories = [];
      const blocks = index.split(/\n(?=# )/);

      for (const block of blocks) {
        const headerMatch = block.match(/^# (.+?)(?:\uff08|（)/);
        if (!headerMatch) continue;

        const category = headerMatch[1];
        const blockLower = block.toLowerCase();

        // 计算关键词命中数
        let hits = 0;
        for (const kw of keywords) {
          if (blockLower.includes(kw.toLowerCase())) hits++;
        }

        if (hits > 0) {
          matchedCategories.push({ category, hits });
        }
      }

      if (matchedCategories.length === 0) return [];

      // 按命中数排序，取 top-2
      matchedCategories.sort((a, b) => b.hits - a.hits);
      const topCategories = matchedCategories.slice(0, 2);

      const results = [];
      for (const { category } of topCategories) {
        const filePath = path.join(this._experienceDir, `${category}.md`);
        const content = _safeReadFile(filePath);
        if (!content.trim()) continue;

        // 从分类文件中找到最相关的条目（关键词匹配）
        const entries = content.split("\n").filter(l => /^\d+\.\s/.test(l.trim()));
        const scored = entries.map(entry => {
          let score = 0;
          const entryLower = entry.toLowerCase();
          for (const kw of keywords) {
            if (entryLower.includes(kw.toLowerCase())) score++;
          }
          return { entry, score };
        }).filter(e => e.score > 0).sort((a, b) => b.score - a.score);

        if (scored.length > 0) {
          results.push({
            category,
            content: scored[0].entry.replace(/^\d+\.\s*/, "").trim(),
          });
        }
      }

      return results.slice(0, 2);
    } catch (err) {
      console.error(`[proactive-recall] experience scan failed: ${err.message}`);
      return [];
    }
  }

  /**
   * 格式化召回结果为注入文本
   *
   * 关键原则：不使用"记忆""记得"等暴露性字眼
   *
   * @param {{ facts: Array, experiences: Array, keywords: string[] }} result
   * @param {boolean} isZh - 是否中文
   * @returns {string} - 格式化后的注入文本（空字符串表示无需注入）
   */
  formatForInjection(result, isZh) {
    const { facts, experiences } = result;
    if (facts.length === 0 && experiences.length === 0) return "";

    const parts = [];

    if (facts.length > 0) {
      const taskFacts = [];
      const noteFacts = [];
      const contextFacts = [];

      for (const f of facts) {
        const fact = typeof f === "string" ? f : f.fact;
        const category = typeof f === "string" ? "" : factCategory(f);
        if (!fact) continue;
        if (TASK_FACT_CATEGORIES.has(category)) taskFacts.push(fact);
        else if (NOTE_FACT_CATEGORIES.has(category)) noteFacts.push(fact);
        else contextFacts.push(fact);
      }

      if (taskFacts.length > 0) {
        const header = isZh ? "当前任务状态：" : "Current task state:";
        parts.push(header + "\n" + taskFacts.map(f => `- ${f}`).join("\n"));
      }
      if (noteFacts.length > 0) {
        const header = isZh ? "注意事项：" : "Notes:";
        parts.push(header + "\n" + noteFacts.map(f => `- ${f}`).join("\n"));
      }
      if (contextFacts.length > 0) {
        const header = isZh ? "相关背景：" : "Relevant context:";
        parts.push(header + "\n" + contextFacts.map(f => `- ${f}`).join("\n"));
      }
    }

    if (experiences.length > 0) {
      const header = isZh ? "注意事项：" : "Notes:";
      const lines = experiences.map(e => `- ${e.content}`);
      parts.push(header + "\n" + lines.join("\n"));
    }

    return parts.join("\n\n");
  }
}

function _safeReadFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return "";
  }
}
