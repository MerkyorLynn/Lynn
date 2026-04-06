/**
 * project-memory.js — 项目级记忆
 *
 * 每个工作目录维护一份项目 profile（技术栈、架构约定、常见问题）。
 * 自动从文件系统探测项目类型，从 session 摘要中学习项目知识。
 *
 * 存储：{agentDir}/memory/projects/{pathHash}.json
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";

/**
 * 项目类型探测规则
 * 每个规则：{ file: 检测文件, type: 项目类型, detect: (content) => { framework?, language? } }
 */
const PROJECT_DETECTORS = [
  {
    file: "package.json",
    type: "nodejs",
    detect: (content) => {
      const result = { language: "JavaScript" };
      try {
        const pkg = JSON.parse(content);
        const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

        // TypeScript
        if (allDeps.typescript || allDeps["ts-node"]) {
          result.language = "TypeScript";
        }

        // Framework detection
        if (allDeps.next) result.framework = "Next.js";
        else if (allDeps.nuxt) result.framework = "Nuxt";
        else if (allDeps.react) result.framework = "React";
        else if (allDeps.vue) result.framework = "Vue";
        else if (allDeps.svelte || allDeps["@sveltejs/kit"]) result.framework = "Svelte";
        else if (allDeps.express) result.framework = "Express";
        else if (allDeps.fastify) result.framework = "Fastify";
        else if (allDeps.koa) result.framework = "Koa";
        else if (allDeps.nest || allDeps["@nestjs/core"]) result.framework = "NestJS";
        else if (allDeps.electron) result.framework = "Electron";
        else if (allDeps["react-native"]) result.framework = "React Native";

        // Monorepo
        if (pkg.workspaces) result.monorepo = true;
      } catch {}
      return result;
    },
  },
  {
    file: "Cargo.toml",
    type: "rust",
    detect: (content) => {
      const result = { language: "Rust" };
      if (content.includes("[workspace]")) result.monorepo = true;
      if (content.includes("actix")) result.framework = "Actix";
      else if (content.includes("axum")) result.framework = "Axum";
      else if (content.includes("tokio")) result.framework = "Tokio";
      else if (content.includes("tauri")) result.framework = "Tauri";
      return result;
    },
  },
  {
    file: "go.mod",
    type: "go",
    detect: (content) => {
      const result = { language: "Go" };
      if (content.includes("github.com/gin-gonic/gin")) result.framework = "Gin";
      else if (content.includes("github.com/gofiber/fiber")) result.framework = "Fiber";
      else if (content.includes("github.com/labstack/echo")) result.framework = "Echo";
      return result;
    },
  },
  {
    file: "pyproject.toml",
    type: "python",
    detect: (content) => {
      const result = { language: "Python" };
      if (content.includes("django")) result.framework = "Django";
      else if (content.includes("fastapi")) result.framework = "FastAPI";
      else if (content.includes("flask")) result.framework = "Flask";
      else if (content.includes("pytorch") || content.includes("torch")) result.framework = "PyTorch";
      return result;
    },
  },
  {
    file: "requirements.txt",
    type: "python",
    detect: (content) => {
      const result = { language: "Python" };
      const lower = content.toLowerCase();
      if (lower.includes("django")) result.framework = "Django";
      else if (lower.includes("fastapi")) result.framework = "FastAPI";
      else if (lower.includes("flask")) result.framework = "Flask";
      return result;
    },
  },
  {
    file: "pom.xml",
    type: "java",
    detect: (content) => {
      const result = { language: "Java" };
      if (content.includes("spring-boot")) result.framework = "Spring Boot";
      return result;
    },
  },
  {
    file: "build.gradle",
    type: "java",
    detect: (content) => {
      const result = { language: "Java" };
      if (content.includes("kotlin")) result.language = "Kotlin";
      if (content.includes("spring")) result.framework = "Spring Boot";
      return result;
    },
  },
  {
    file: "pubspec.yaml",
    type: "dart",
    detect: (content) => {
      const result = { language: "Dart" };
      if (content.includes("flutter")) result.framework = "Flutter";
      return result;
    },
  },
  {
    file: "Gemfile",
    type: "ruby",
    detect: (content) => {
      const result = { language: "Ruby" };
      if (content.includes("rails")) result.framework = "Rails";
      return result;
    },
  },
  {
    file: "mix.exs",
    type: "elixir",
    detect: (content) => {
      const result = { language: "Elixir" };
      if (content.includes("phoenix")) result.framework = "Phoenix";
      return result;
    },
  },
  {
    file: "composer.json",
    type: "php",
    detect: (content) => {
      const result = { language: "PHP" };
      if (content.includes("laravel")) result.framework = "Laravel";
      return result;
    },
  },
  {
    file: "CMakeLists.txt",
    type: "cpp",
    detect: () => ({ language: "C++" }),
  },
  {
    file: "Makefile",
    type: "make",
    detect: () => ({}),
  },
];

export class ProjectMemory {
  /**
   * @param {object} opts
   * @param {string} opts.projectsDir - {agentDir}/memory/projects/
   */
  constructor({ projectsDir }) {
    this._projectsDir = projectsDir;
    this._cache = new Map(); // pathHash → profile
    fs.mkdirSync(projectsDir, { recursive: true });
  }

  /**
   * 生成路径 hash（稳定、短）
   */
  _pathHash(cwd) {
    return crypto.createHash("md5").update(cwd).digest("hex").slice(0, 12);
  }

  /**
   * profile 文件路径
   */
  _profilePath(cwd) {
    return path.join(this._projectsDir, `${this._pathHash(cwd)}.json`);
  }

  /**
   * 纯文件系统探测项目类型（不调 LLM）
   *
   * @param {string} cwd - 工作目录
   * @returns {{ type: string, framework?: string, language?: string, monorepo?: boolean } | null}
   */
  detectProject(cwd) {
    if (!cwd) return null;

    for (const detector of PROJECT_DETECTORS) {
      const filePath = path.join(cwd, detector.file);
      try {
        if (!fs.existsSync(filePath)) continue;
        const content = fs.readFileSync(filePath, "utf-8");
        const detected = detector.detect(content);
        return { type: detector.type, ...detected };
      } catch {
        continue;
      }
    }

    return null;
  }

  /**
   * 获取或创建项目 profile
   *
   * @param {string} cwd - 工作目录
   * @returns {object | null} - 项目 profile
   */
  getProfile(cwd) {
    if (!cwd) return null;

    const hash = this._pathHash(cwd);

    // 内存缓存
    if (this._cache.has(hash)) {
      return this._cache.get(hash);
    }

    // 磁盘读取
    const profilePath = this._profilePath(cwd);
    let profile = null;

    try {
      if (fs.existsSync(profilePath)) {
        profile = JSON.parse(fs.readFileSync(profilePath, "utf-8"));
      }
    } catch {}

    // 不存在则创建 + 自动检测
    if (!profile) {
      const detected = this.detectProject(cwd);
      profile = {
        path: cwd,
        name: path.basename(cwd),
        detected: detected || {},
        learned: {
          architecture: "",
          conventions: [],
          commonIssues: [],
        },
        sessionCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this._saveProfile(cwd, profile);
    }

    this._cache.set(hash, profile);
    return profile;
  }

  /**
   * 从 session 摘要中学习项目知识（由 memory-ticker.notifySessionEnd 调用）
   *
   * 注意：此方法需要 LLM 调用，由 memory-ticker 异步执行
   *
   * @param {string} cwd - 工作目录
   * @param {string} summaryText - session 摘要文本
   * @param {{ model: string, api: string, api_key: string, base_url: string }} resolvedModel
   */
  async learnFromSession(cwd, summaryText, resolvedModel) {
    if (!cwd || !summaryText || summaryText.trim().length < 50) return;

    const profile = this.getProfile(cwd);
    if (!profile) return;

    profile.sessionCount = (profile.sessionCount || 0) + 1;
    profile.updatedAt = new Date().toISOString();

    // 简单的启发式学习（不调 LLM，保持轻量）：
    // 从摘要中提取关键信息（架构、约定、问题）
    this._learnHeuristic(profile, summaryText);

    this._saveProfile(cwd, profile);
  }

  /**
   * 启发式学习：从摘要中提取项目知识
   * 纯正则/关键词匹配，不调 LLM
   */
  _learnHeuristic(profile, summaryText) {
    const text = summaryText.toLowerCase();

    // 提取提到的技术栈（如果 detected 中缺失）
    if (!profile.detected.framework) {
      const frameworkHints = [
        { kw: "next.js", fw: "Next.js" }, { kw: "nextjs", fw: "Next.js" },
        { kw: "react", fw: "React" }, { kw: "vue", fw: "Vue" },
        { kw: "svelte", fw: "Svelte" }, { kw: "express", fw: "Express" },
        { kw: "django", fw: "Django" }, { kw: "fastapi", fw: "FastAPI" },
        { kw: "spring boot", fw: "Spring Boot" }, { kw: "rails", fw: "Rails" },
        { kw: "flutter", fw: "Flutter" }, { kw: "electron", fw: "Electron" },
      ];
      for (const { kw, fw } of frameworkHints) {
        if (text.includes(kw)) {
          profile.detected.framework = fw;
          break;
        }
      }
    }

    // 提取常见问题模式
    const issuePatterns = [
      /(?:问题|error|bug|issue|fix|修复|解决)[：:]\s*(.{10,60})/gi,
      /需要先?\s*(.{5,40})\s*(?:才能|before)/gi,
    ];

    for (const pattern of issuePatterns) {
      let match;
      while ((match = pattern.exec(summaryText)) !== null) {
        const issue = match[1].trim();
        if (issue.length >= 10 && !profile.learned.commonIssues.includes(issue)) {
          profile.learned.commonIssues.push(issue);
          // 最多保留 10 条
          if (profile.learned.commonIssues.length > 10) {
            profile.learned.commonIssues = profile.learned.commonIssues.slice(-10);
          }
          break; // 每次只添加一条
        }
      }
    }
  }

  /**
   * 格式化为 prompt 注入文本（≤200 tokens）
   *
   * @param {string} cwd - 工作目录
   * @returns {string} - 格式化文本（空字符串表示无需注入）
   */
  formatForPrompt(cwd) {
    if (!cwd) return "";

    const profile = this.getProfile(cwd);
    if (!profile) return "";

    const { detected, learned } = profile;
    if (!detected.type && !detected.language && !detected.framework) return "";

    const parts = [];

    // 技术栈行
    const stack = [
      detected.language,
      detected.framework,
      detected.type && detected.type !== detected.language?.toLowerCase()
        ? `(${detected.type})` : null,
    ].filter(Boolean);

    if (stack.length > 0) {
      parts.push(`Tech: ${stack.join(" / ")}`);
    }

    // 架构约定
    if (learned.architecture) {
      parts.push(`Architecture: ${learned.architecture}`);
    }

    if (learned.conventions?.length > 0) {
      parts.push(`Conventions: ${learned.conventions.slice(0, 3).join("; ")}`);
    }

    // 常见问题（仅前 3 条）
    if (learned.commonIssues?.length > 0) {
      parts.push(`Known issues: ${learned.commonIssues.slice(0, 3).join("; ")}`);
    }

    if (parts.length === 0) return "";

    return `\n# Current Project: ${profile.name}\n${parts.join("\n")}`;
  }

  /**
   * 保存 profile 到磁盘
   */
  _saveProfile(cwd, profile) {
    try {
      const profilePath = this._profilePath(cwd);
      fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2), "utf-8");
      // 更新缓存
      this._cache.set(this._pathHash(cwd), profile);
    } catch (err) {
      console.error(`[project-memory] save failed: ${err.message}`);
    }
  }
}
