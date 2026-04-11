/**
 * SkillManager — Skill 加载、过滤、per-agent 隔离
 *
 * 管理全量 skill 列表、learned skills 扫描、外部兼容技能扫描、per-agent 隔离过滤。
 * 从 Engine 提取，Engine 通过 manager 访问 skill 状态。
 */
import fs from "fs";
import path from "path";
import chokidar from "chokidar";
import { parseSkillMetadata } from "../lib/skills/skill-metadata.js";

function normalizeSkillAlias(value) {
  return String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
}

const SKILL_MATCH_STOPWORDS = new Set([
  "skill", "skills", "tool", "tools", "agent", "lynn", "hanako", "butter",
  "请", "帮我", "需要", "使用", "一下", "这个", "那个", "功能", "处理",
  "the", "and", "for", "with", "from", "that", "this", "into", "use", "using",
]);

function tokenizeSkillText(value) {
  const matches = String(value || "").match(/[\p{Script=Han}]{2,}|[a-zA-Z][a-zA-Z0-9_.-]{1,}/gu) || [];
  const tokens = [];
  const seen = new Set();
  for (const raw of matches) {
    const token = normalizeSkillAlias(raw).replace(/\.+/g, "-");
    if (!token || SKILL_MATCH_STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

const QUERY_TOKEN_SYNONYMS = [
  { pattern: /搜索|查找|检索|搜一下/u, expansions: ["search", "find", "lookup"] },
  { pattern: /总结|概括|摘要|整理/u, expansions: ["summarize", "summary"] },
  { pattern: /新闻|资讯|动态/u, expansions: ["news"] },
  { pattern: /文档|文件|pdf/u, expansions: ["document", "file", "pdf"] },
  { pattern: /github|仓库|代码/u, expansions: ["github", "repo", "code"] },
];

function expandQueryTokens(text, tokens) {
  const expanded = new Set(tokens);
  const rawText = String(text || "");
  for (const entry of QUERY_TOKEN_SYNONYMS) {
    if (!entry.pattern.test(rawText)) continue;
    for (const token of entry.expansions) {
      expanded.add(token);
    }
  }
  return [...expanded];
}

export class SkillManager {
  /**
   * @param {object} opts
   * @param {string} opts.skillsDir - 全局 skills 目录
   * @param {Array<{ dirPath: string, label: string }>} [opts.externalPaths] - 外部兼容技能目录
   */
  constructor({ skillsDir, externalPaths = [] }) {
    this.skillsDir = skillsDir;
    this._allSkills = [];
    this._hiddenSkills = new Set();
    this._watcher = null;
    this._reloadTimer = null;
    this._reloadDeps = null; // { resourceLoader, agents, onReloaded }
    this._externalPaths = externalPaths;
    this._externalWatchers = new Map();
    /** @type {Map<string, { skills: Array, mtime: number }>} */
    this._cwdSkillCache = new Map();
  }

  /** 全量 skill 列表 */
  get allSkills() { return this._allSkills; }

  /**
   * 首次加载：从 resourceLoader 获取内置 skills + 合并所有 agent 的 learned skills + 外部技能
   * @param {object} resourceLoader - Pi SDK DefaultResourceLoader 实例
   * @param {Map} agents - agent Map
   * @param {Set<string>} hiddenSkills - 需要隐藏的 skill name 集合
   */
  init(resourceLoader, agents, hiddenSkills) {
    this._hiddenSkills = hiddenSkills;
    this._allSkills = resourceLoader.getSkills().skills;
    for (const s of this._allSkills) {
      s._hidden = hiddenSkills.has(s.name);
    }
    for (const [, ag] of agents) {
      this._allSkills.push(...this.scanLearnedSkills(ag.agentDir));
    }
    this._appendExternalSkills();
  }

  /** 将 agent 启用的 skill 同步到 agent 的 system prompt */
  syncAgentSkills(agent) {
    const enabled = agent?.config?.skills?.enabled || [];
    const enabledAliases = new Set(enabled.map(normalizeSkillAlias).filter(Boolean));
    const skills = this._allSkills.filter((s) => this._isSkillEnabled(s, enabledAliases));
    agent.setEnabledSkills(skills);
  }

  /** 返回全量 skill 列表（供 API 使用），附带指定 agent 的 enabled 状态 */
  getAllSkills(agent) {
    const enabled = agent?.config?.skills?.enabled || [];
    const enabledAliases = new Set(enabled.map(normalizeSkillAlias).filter(Boolean));
    return this._allSkills.map(s => ({
      name: s.name,
      description: s.description,
      filePath: s.filePath,
      baseDir: s.baseDir,
      source: s.source,
      hidden: !!s._hidden,
      enabled: this._isSkillEnabled(s, enabledAliases),
      externalLabel: s._externalLabel || null,
      externalPath: s._externalPath || null,
      readonly: !!s._readonly,
    }));
  }

  /** 按 agent 过滤可用 skills（learned skills 有 per-agent 隔离） */
  getSkillsForAgent(targetAgent) {
    const enabled = targetAgent?.config?.skills?.enabled;
    if (!enabled || enabled.length === 0) {
      return { skills: [], diagnostics: [] };
    }
    const agentId = targetAgent ? path.basename(targetAgent.agentDir) : null;
    const enabledAliases = new Set(enabled.map(normalizeSkillAlias).filter(Boolean));
    return {
      skills: this._allSkills.filter(s =>
        this._isSkillEnabled(s, enabledAliases)
        && (!s._agentId || s._agentId === agentId)
      ),
      diagnostics: [],
    };
  }

  suggestSkillsForText(targetAgent, text, limit = 3) {
    const query = String(text || "").trim();
    if (!query) return [];
    const { skills } = this.getSkillsForAgent(targetAgent);
    if (!skills.length) return [];

    const queryText = normalizeSkillAlias(query);
    const queryTokens = expandQueryTokens(query, tokenizeSkillText(query));
    if (!queryTokens.length) return [];

    return skills
      .map((skill) => {
        const skillTokens = tokenizeSkillText(`${skill.name} ${skill.description || ""}`);
        let score = 0;
        const matchedTokens = [];

        const alias = normalizeSkillAlias(skill.name);
        if (alias && queryText.includes(alias)) {
          score += 8;
          matchedTokens.push(skill.name);
        }

        for (const token of skillTokens) {
          if (!queryTokens.includes(token)) continue;
          matchedTokens.push(token);
          score += token.length >= 4 ? 3 : 2;
        }

        return score > 0
          ? {
              name: skill.name,
              description: skill.description,
              filePath: skill.filePath,
              score,
              matchedTokens: [...new Set(matchedTokens)].slice(0, 4),
            }
          : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, limit));
  }

  /**
   * 重新加载 skills（安装/删除后调用）
   * @param {object} resourceLoader
   * @param {Map} agents
   */
  async reload(resourceLoader, agents) {
    // 暂时恢复原始 getSkills 以便 reload() 正确扫描
    delete resourceLoader.getSkills;
    await resourceLoader.reload();

    this._allSkills = resourceLoader.getSkills().skills;
    for (const s of this._allSkills) {
      s._hidden = this._hiddenSkills.has(s.name);
    }
    for (const [, ag] of agents) {
      this._allSkills.push(...this.scanLearnedSkills(ag.agentDir));
    }
    this._appendExternalSkills();
  }

  /**
   * 监听 skillsDir 变化，自动 reload（debounce 1s）
   * @param {object} resourceLoader
   * @param {Map} agents
   * @param {() => void} onReloaded - reload 完成后的回调（用于 syncAllAgentSkills 等）
   */
  watch(resourceLoader, agents, onReloaded) {
    this._reloadDeps = { resourceLoader, agents, onReloaded };
    if (this._watcher) return;
    try {
      this._watcher = chokidar.watch(this.skillsDir, {
        ignoreInitial: true,
        ignored: [/(^|[/\\])\./, /[~#]$/],
        persistent: true,
      });
      this._watcher.on("all", () => {
        if (this._reloadTimer) clearTimeout(this._reloadTimer);
        this._reloadTimer = setTimeout(() => this._autoReload(), 1000);
      });
      this._watcher.on("error", (err) => {
        console.error("[skill-manager] watcher error:", err.message);
      });
    } catch (err) {
      console.error("[skill-manager] failed to create watcher:", err.message);
    }
    this._watchExternalPaths();
  }

  async _autoReload() {
    const deps = this._reloadDeps;
    if (!deps) return;
    try {
      await this.reload(deps.resourceLoader, deps.agents);
      deps.onReloaded?.();
    } catch (err) {
      console.warn("[skill-manager] auto-reload failed:", err.message);
    }
  }

  /** 停止文件监听 */
  unwatch() {
    if (this._watcher) { this._watcher.close(); this._watcher = null; }
    if (this._reloadTimer) { clearTimeout(this._reloadTimer); this._reloadTimer = null; }
    this._reloadDeps = null;
    this._closeExternalWatchers();
  }

  /**
   * 更新外部路径（纯数据更新 + 重建 watcher，不触发 reload）
   * @param {Array<{ dirPath: string, label: string }>} paths
   */
  setExternalPaths(paths) {
    this._externalPaths = paths;
    this._closeExternalWatchers();
    if (this._reloadDeps) {
      this._watchExternalPaths();
    }
  }

  // ── CWD 项目级技能扫描（带缓存） ──

  /**
   * 获取目录 mtime 的最大值（检测技能目录变化）
   * @param {string} dir
   * @param {Array<{ sub: string, label: string }>} skillDirs
   * @returns {number} 最新 mtime（ms）
   */
  _getCwdSkillsMtime(dir, skillDirs) {
    let maxMtime = 0;
    for (const { sub } of skillDirs) {
      const skillsDir = path.join(dir, sub);
      try {
        const stat = fs.statSync(skillsDir);
        if (stat.mtimeMs > maxMtime) maxMtime = stat.mtimeMs;
        // 也检查子目录的 mtime（新增/删除技能文件夹会更新父目录 mtime）
      } catch {
        // 目录不存在，跳过
      }
    }
    return maxMtime;
  }

  /**
   * 扫描 CWD 下的项目级技能，带 mtime 缓存
   * @param {string} dir - 工作区目录
   * @param {Array<{ sub: string, label: string }>} skillDirs - 技能子目录配置
   * @returns {{ skills: Array, mtime: number, fromCache: boolean }}
   */
  scanCwdSkills(dir, skillDirs) {
    const mtime = this._getCwdSkillsMtime(dir, skillDirs);
    const cached = this._cwdSkillCache.get(dir);
    if (cached && cached.mtime === mtime) {
      return { skills: cached.skills, mtime, fromCache: true };
    }

    // 缓存未命中，扫描文件系统
    const results = [];
    for (const { sub, label } of skillDirs) {
      const skillsDir = path.join(dir, sub);
      if (!fs.existsSync(skillsDir)) continue;
      try {
        for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const skillFile = path.join(skillsDir, entry.name, "SKILL.md");
          if (!fs.existsSync(skillFile)) continue;
          try {
            const content = fs.readFileSync(skillFile, "utf-8");
            const meta = parseSkillMetadata(content, entry.name);
            results.push({
              name: meta.name,
              description: meta.description,
              source: label,
              dirPath: skillsDir,
              filePath: skillFile,
              baseDir: path.join(skillsDir, entry.name),
            });
          } catch {}
        }
      } catch {}
    }

    // 写入缓存
    this._cwdSkillCache.set(dir, { skills: results, mtime });

    // 限制缓存大小（最多保留 20 个工作区）
    if (this._cwdSkillCache.size > 20) {
      const firstKey = this._cwdSkillCache.keys().next().value;
      this._cwdSkillCache.delete(firstKey);
    }

    return { skills: results, mtime, fromCache: false };
  }

  /**
   * 使指定工作区的缓存失效
   * @param {string} [dir] - 不传则清空全部
   */
  invalidateCwdCache(dir) {
    if (dir) {
      this._cwdSkillCache.delete(dir);
    } else {
      this._cwdSkillCache.clear();
    }
  }

  _collectSkillAliases(skill) {
    const aliases = new Set();
    if (skill?.name) aliases.add(normalizeSkillAlias(skill.name));
    if (skill?.baseDir) aliases.add(normalizeSkillAlias(path.basename(skill.baseDir)));
    if (skill?.filePath) aliases.add(normalizeSkillAlias(path.basename(path.dirname(skill.filePath))));
    return aliases;
  }

  _isSkillEnabled(skill, enabledAliases) {
    if (!(enabledAliases instanceof Set) || enabledAliases.size === 0) return false;
    for (const alias of this._collectSkillAliases(skill)) {
      if (enabledAliases.has(alias)) return true;
    }
    return false;
  }

  // ── 外部技能扫描 ──

  /**
   * 扫描所有外部路径下的技能
   * @returns {Array} 外部技能列表
   */
  scanExternalSkills() {
    const results = [];
    for (const { dirPath, label } of this._externalPaths) {
      if (!fs.existsSync(dirPath)) continue;
      try {
        for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const skillFile = path.join(dirPath, entry.name, "SKILL.md");
          if (!fs.existsSync(skillFile)) continue;
          try {
            const content = fs.readFileSync(skillFile, "utf-8");
            const meta = parseSkillMetadata(content, entry.name);
            results.push({
              name: meta.name,
              description: meta.description,
              filePath: skillFile,
              baseDir: path.join(dirPath, entry.name),
              source: "external",
              disableModelInvocation: meta.disableModelInvocation,
              _agentId: null,
              _hidden: false,
              _externalLabel: label,
              _externalPath: dirPath,
              _readonly: true,
            });
          } catch {}
        }
      } catch {}
    }
    return results;
  }

  /** 将外部技能追加到 _allSkills（去重：内部优先） */
  _appendExternalSkills() {
    const existingNames = new Set(this._allSkills.map(s => s.name));
    for (const ext of this.scanExternalSkills()) {
      if (!existingNames.has(ext.name)) {
        this._allSkills.push(ext);
        existingNames.add(ext.name);
      }
    }
  }

  // ── 外部路径 watcher ──

  _watchExternalPaths() {
    for (const { dirPath } of this._externalPaths) {
      if (!fs.existsSync(dirPath)) continue;
      if (this._externalWatchers.has(dirPath)) continue;
      try {
        const w = chokidar.watch(dirPath, {
          ignoreInitial: true,
          ignored: [/(^|[/\\])\./, /[~#]$/],
          persistent: true,
        });
        w.on("all", () => {
          if (this._reloadTimer) clearTimeout(this._reloadTimer);
          this._reloadTimer = setTimeout(() => this._autoReload(), 1000);
        });
        w.on("error", (err) => {
          console.error(`[skill-manager] external watcher error (${dirPath}):`, err.message);
        });
        this._externalWatchers.set(dirPath, w);
      } catch (err) {
        console.error(`[skill-manager] failed to watch external path (${dirPath}):`, err.message);
      }
    }
  }

  _closeExternalWatchers() {
    for (const [, w] of this._externalWatchers) {
      try { w.close(); } catch {}
    }
    this._externalWatchers.clear();
  }

  // ── 自学技能扫描 ──

  /**
   * 扫描 agentDir/learned-skills/ 下的自学 skills
   * @param {string} agentDir
   */
  scanLearnedSkills(agentDir) {
    const agentId = path.basename(agentDir);
    const learnedDir = path.join(agentDir, "learned-skills");
    if (!fs.existsSync(learnedDir)) return [];
    const results = [];
    for (const entry of fs.readdirSync(learnedDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(learnedDir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      try {
        const content = fs.readFileSync(skillFile, "utf-8");
        const meta = parseSkillMetadata(content, entry.name);
        results.push({
          name: meta.name,
          description: meta.description,
          filePath: skillFile,
          baseDir: path.join(learnedDir, entry.name),
          source: "learned",
          disableModelInvocation: meta.disableModelInvocation,
          _agentId: agentId,
          _hidden: false,
        });
      } catch {}
    }
    return results;
  }
}
