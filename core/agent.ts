import { requestAuthorization } from "../lib/sandbox/tool-wrapper.js";
/**
 * Agent — 一个助手实例
 *
 * 拥有自己的身份、人格、记忆、工具和 prompt 拼装逻辑。
 * Engine 持有一个 Agent，未来可以持有多个。
 */
import fs from "fs";
import { createRequire } from "module";
import path from "path";
import { loadConfig, saveConfig } from "../lib/memory/config-loader.js";
import { safeReadFile, safeReadJSON } from "../shared/safe-fs.js";
import { FactStore } from "../lib/memory/fact-store.js";
import { SessionSummaryManager } from "../lib/memory/session-summary.js";
import { createMemoryTicker } from "../lib/memory/memory-ticker.js";
import { createMemorySearchTool } from "../lib/memory/memory-search.js";
import { initWebSearch, createWebSearchTool } from "../lib/tools/web-search.js";
import { createTodoTool } from "../lib/tools/todo.js";
import { createRestoreSnapshotTool } from "../lib/tools/restore-snapshot-tool.js";
import { createDeskManager } from "../lib/desk/desk-manager.js";
import { CronStore } from "../lib/desk/cron-store.js";
import { createCronTool } from "../lib/tools/cron-tool.js";
import { createWebFetchTool } from "../lib/tools/web-fetch.js";
import { createStockMarketTool } from "../lib/tools/stock-market.js";
import { createLiveNewsTool, createSportsScoreTool, createWeatherTool } from "../lib/tools/realtime-info.js";
import { createPresentFilesTool } from "../lib/tools/output-file-tool.js";
import { createArtifactTool } from "../lib/tools/artifact-tool.js";
import { createPptxTool } from "../lib/tools/pptx-tool.js";
import { createReportTool } from "../lib/tools/report-tool.js";
import { createDocxTool } from "../lib/tools/docx-tool.js";
import { createStockResearchTool } from "../lib/tools/stock-research-tool.js";
import { createPosterTool } from "../lib/tools/poster-tool.js";
import { createChannelTool } from "../lib/tools/channel-tool.js";
import { createAskAgentTool } from "../lib/tools/ask-agent-tool.js";
import { createDmTool } from "../lib/tools/dm-tool.js";
import { createBrowserTool } from "../lib/tools/browser-tool.js";
import { createPinnedMemoryTools } from "../lib/tools/pinned-memory.js";
import { createExperienceTools } from "../lib/tools/experience.js";
import { createActiveTaskTool } from "../lib/tools/active-task.js";
import { ProactiveRecall } from "../lib/memory/proactive-recall.js";
import { ProjectMemory } from "../lib/memory/project-memory.js";
import { UserProfile } from "../lib/memory/user-profile.js";
import { InferredProfile } from "../lib/memory/inferred-profile.js";
import { MemoryExclusions } from "../lib/memory/memory-exclusions.js";
import { SkillDistiller } from "../lib/memory/skill-distiller.js";
import { HybridRetriever } from "../lib/memory/retriever.js";
import { ActiveTaskMemory } from "../lib/memory/active-task.js";
import { createInstallSkillTool } from "../lib/tools/install-skill.js";
import { createNotifyTool } from "../lib/tools/notify-tool.js";
import { createUpdateSettingsTool } from "../lib/tools/update-settings-tool.js";
import { createDelegateTool } from "../lib/tools/delegate-tool.js";
import { READ_ONLY_BUILTIN_TOOLS } from "./config-coordinator.js";
import { formatSkillsForPrompt } from "./agent-runtime/skills.js";
import { runCompatChecks } from "../lib/compat/index.js";
import { buildAgentDynamicPrompt } from "./agent-dynamic-prompt.js";
import { createAgentStaticPromptCacheKey } from "./agent-prompt-cache.js";

type AnyRecord = Record<string, any>;
type LogFn = (msg: string) => void;
type ToolLike = AnyRecord;
type SearchConfigResolver = (...args: any[]) => any;
type ResolveModelFn = (bareId: string, agentConfig: object) => object | null;

interface AgentOptions {
  agentDir: string;
  productDir: string;
  userDir: string;
  channelsDir?: string | null;
  agentsDir?: string | null;
  searchConfigResolver?: SearchConfigResolver | null;
}

interface SharedModels {
  utility?: string | null;
  utility_large?: string | null;
  [key: string]: unknown;
}

interface AgentConfig extends AnyRecord {
  locale?: string;
  user?: { name?: string; [key: string]: any };
  agent?: { name?: string; yuan?: string; [key: string]: any };
  memory?: {
    enabled?: boolean;
    base_importance?: number;
    hit_bonus?: number;
    compile_threshold?: number;
    [key: string]: any;
  };
  models?: {
    chat?: string | null;
    utility?: string | null;
    utility_large?: string | null;
    embedding_dimensions?: number;
    [key: string]: any;
  };
  skills?: { enabled?: string[]; [key: string]: any };
  desk?: { cron_auto_approve?: boolean; [key: string]: any };
  capabilities?: AnyRecord;
  search?: AnyRecord;
}

interface AgentEngineLike extends AnyRecord {
  cwd?: string;
  homeCwd?: string;
  confirmStore?: unknown;
  currentSessionPath?: string | null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const require = createRequire(import.meta.url);

export class Agent {
  agentDir: string;
  productDir: string;
  userDir: string;
  channelsDir: string | null;
  agentsDir: string | null;
  configPath: string;
  factsDbPath: string;
  memoryMdPath: string;
  todayMdPath: string;
  weekMdPath: string;
  longtermMdPath: string;
  factsMdPath: string;
  activeTaskPath: string;
  summariesDir: string;
  sessionDir: string;
  deskDir: string;
  userName: string;
  agentName: string;

  _searchConfigResolver: SearchConfigResolver | null;
  _config: AgentConfig;
  _factStore: AnyRecord | null;
  _summaryManager: AnyRecord | null;
  _memoryTicker: AnyRecord | null;
  _memorySearchTool: ToolLike | null;
  _webSearchTool: ToolLike | null;
  _webFetchTool: ToolLike | null;
  _stockMarketTool: ToolLike | null;
  _weatherTool: ToolLike | null;
  _liveNewsTool: ToolLike | null;
  _sportsScoreTool: ToolLike | null;
  _staticPromptCache: string | null;
  _staticPromptDeps: string | null;
  _todoTool: ToolLike | null;
  _restoreSnapshotTool: ToolLike | null;
  _pinnedMemoryTools: ToolLike[];
  _experienceTools: ToolLike[];
  _activeTaskTool: ToolLike | null;
  _memoryMasterEnabled: boolean;
  _memorySessionEnabled: boolean;
  _enabledSkills: unknown[];
  _systemPrompt: string;
  _proactiveRecall: AnyRecord | null;
  _projectMemory: AnyRecord | null;
  _userProfile: AnyRecord | null;
  _inferredProfile: AnyRecord | null;
  _memoryExclusions: AnyRecord | null;
  _skillDistiller: AnyRecord | null;
  _activeTaskMemory: AnyRecord | null;
  _deskManager: AnyRecord | null;
  _cronStore: AnyRecord | null;
  _cronTool: ToolLike | null;
  _presentFilesTool: ToolLike | null;
  _artifactTool: ToolLike | null;
  _pptxTool: ToolLike | null;
  _reportTool: ToolLike | null;
  _docxTool: ToolLike | null;
  _posterTool: ToolLike | null;
  _stockResearchTool: ToolLike | null;
  _channelTool: ToolLike | null;
  _askAgentTool: ToolLike | null;
  _dmTool: ToolLike | null;
  _browserTool: ToolLike | null;
  _notifyTool: ToolLike | null;
  _installSkillTool: ToolLike | null;
  _updateSettingsTool: ToolLike | null;
  _delegateTool: ToolLike | null;
  _retriever: AnyRecord | null;
  _utilityModel: string | null;
  _memoryModel: string | null;
  _resolvedUtilityModel: AnyRecord | null;
  _resolvedMemoryModel: AnyRecord | null;
  _memoryModelUnavailableReason: string | null;
  _engine: AgentEngineLike | null;
  _disposing: boolean;
  _notifyHandler: ((title: string, body?: string) => void) | null;
  _channelPostHandler: ((channelName: string, senderId: string) => void) | null;
  _dmSentHandler: ((fromId: string, toId: string) => void) | null;
  _onInstallCallback: ((skillName: string) => unknown | Promise<unknown>) | null;

  /**
   * @param {object} opts
   * @param {string} opts.agentDir   - 这个助手的数据目录（yuan, ishiki, config, memory, avatars）
   * @param {string} opts.productDir - 产品模板目录（ishiki.example.md, yuan 模板等）
   * @param {string} opts.userDir    - 用户数据目录（user.md, 用户头像）—— 跨助手共享
   */
  constructor({ agentDir, productDir, userDir, channelsDir, agentsDir, searchConfigResolver }: AgentOptions) {
    this.agentDir = agentDir;
    this.productDir = productDir;
    this.userDir = userDir;
    this.channelsDir = channelsDir || null;
    this.agentsDir = agentsDir || null;
    this._searchConfigResolver = searchConfigResolver || null;

    // 路径
    this.configPath = path.join(agentDir, "config.yaml");
    this.factsDbPath = path.join(agentDir, "memory", "facts.db");
    this.memoryMdPath = path.join(agentDir, "memory", "memory.md");
    this.todayMdPath    = path.join(agentDir, "memory", "today.md");
    this.weekMdPath     = path.join(agentDir, "memory", "week.md");
    this.longtermMdPath = path.join(agentDir, "memory", "longterm.md");
    this.factsMdPath    = path.join(agentDir, "memory", "facts.md");
    this.activeTaskPath = path.join(agentDir, "memory", "active-task.json");
    this.summariesDir = path.join(agentDir, "memory", "summaries");
    this.sessionDir = path.join(agentDir, "sessions");
    this.deskDir = path.join(agentDir, "desk");

    // 身份（init 后从 config 填充）
    this.userName = "User";
    this.agentName = "Lynn";

    // 运行时状态
    this._config = {};
    this._factStore = null;
    this._summaryManager = null;
    this._memoryTicker = null;
    this._memorySearchTool = null;
    this._webSearchTool = null;
    this._webFetchTool = null;
    this._stockMarketTool = null;
    this._weatherTool = null;
    this._liveNewsTool = null;
    this._sportsScoreTool = null;

    // System Prompt 静态/动态分层缓存（Claude Code 启发）
    this._staticPromptCache = null;  // { hash, text }
    this._staticPromptDeps = null;   // identity+yuan+ishiki+skills 的 hash
    this._todoTool = null;
    this._restoreSnapshotTool = null;
    this._pinnedMemoryTools = [];
    this._experienceTools = [];
    this._activeTaskTool = null;
    this._memoryMasterEnabled = true;   // agent 级别总开关（config.yaml memory.enabled）
    this._memorySessionEnabled = true;  // per-session 开关（WelcomeScreen toggle）
    this._enabledSkills = [];
    this._systemPrompt = "";

    // 智能记忆增强（Phase 1-3）
    this._proactiveRecall = null;
    this._projectMemory = null;
    this._userProfile = null;
    this._inferredProfile = null;
    this._memoryExclusions = null;
    this._skillDistiller = null;
    this._activeTaskMemory = null;

    // Desk 系统（与 memory 完全独立）
    this._deskManager = null;
    this._cronStore = null;
    this._cronTool = null;
    this._presentFilesTool = null;
    this._artifactTool = null;
    this._pptxTool = null;
    this._reportTool = null;
    this._docxTool = null;
    this._posterTool = null;
    this._stockResearchTool = null;
    this._channelTool = null;
    this._askAgentTool = null;
    this._dmTool = null;
    this._browserTool = null;
    this._notifyTool = null;
    this._installSkillTool = null;
    this._updateSettingsTool = null;
    this._delegateTool = null;
    this._retriever = null;
    this._utilityModel = null;
    this._memoryModel = null;
    this._resolvedUtilityModel = null;
    this._resolvedMemoryModel = null;
    this._memoryModelUnavailableReason = null;
    this._engine = null;
    this._disposing = false;
    this._notifyHandler = null;
    this._channelPostHandler = null;
    this._dmSentHandler = null;
    this._onInstallCallback = null;
  }

  // ════════════════════════════
  //  生命周期
  // ════════════════════════════

  /**
   * 初始化助手：加载配置、编译记忆、创建工具
   * @param {(msg: string) => void} [log]
   * @param {object} [sharedModels] - 全局共享模型配置（由 engine 传入）
   * @param {(bareId: string, agentConfig: object) => object} [resolveModel] - 统一模型解析回调
   */
  async init(log: LogFn = () => {}, sharedModels: SharedModels = {}, resolveModel: ResolveModelFn | null = null) {
    // 0. 兼容性检查（目录、数据库、配置文件）
    await runCompatChecks({
      agentDir: this.agentDir,
      lynnHome: path.dirname(path.dirname(this.agentDir)),
      log,
    });

    // 1. 加载配置
    log(`  [agent] 1. loadConfig...`);
    this._config = loadConfig(this.configPath);
    log(`  [agent] 1. loadConfig 完成`);

    // 2. 身份 + 记忆总开关
    const isZh = String(this._config.locale || "").startsWith("zh");
    this.userName = this._config.user?.name || (isZh ? "用户" : "User");
    this.agentName = this._config.agent?.name || "Lynn";
    this._memoryMasterEnabled = this._config.memory?.enabled !== false;

    // 3. 初始化各模块
    log(`  [agent] 3. initWebSearch...`);
    initWebSearch(this.configPath, this._searchConfigResolver
      ? { searchConfigResolver: this._searchConfigResolver as any }
      : {});
    log(`  [agent] 3. 模块初始化完成`);

    // 4. 记忆 v2：FactStore + SessionSummaryManager + ticker
    log(`  [agent] 4. FactStore...`);
    fs.mkdirSync(path.join(this.agentDir, "memory", "summaries"), { recursive: true });
    this._activeTaskMemory = new ActiveTaskMemory({ filePath: this.activeTaskPath });
    this._factStore = new FactStore(this.factsDbPath, {
      baseImportance: this._config?.memory?.base_importance,
      hitBonus: this._config?.memory?.hit_bonus,
      compileThreshold: this._config?.memory?.compile_threshold,
    });
    this._summaryManager = new SessionSummaryManager(this.summariesDir);

    // v1 → v2 迁移：仅当迁移标记不存在且旧 memories.db 存在时执行一次
    const oldMemoriesPath = path.join(this.agentDir, "memory", "memories.db");
    const migrationDone = path.join(this.agentDir, "memory", ".v2-migrated");
    if (!fs.existsSync(migrationDone) && fs.existsSync(oldMemoriesPath)) {
      try {
        log(`  [agent] 4. v1→v2 迁移: 发现旧 memories.db，开始迁移...`);
        const Database = require("better-sqlite3") as any;
        const oldDb = new Database(oldMemoriesPath, { readonly: true });
        const rows = oldDb.prepare("SELECT content, tags, date, created_at FROM memories").all() as AnyRecord[];
        oldDb.close();

        if (rows.length > 0) {
          const facts = rows.map((row: AnyRecord) => ({
            fact: row.content,
            tags: (() => { try { return JSON.parse(row.tags); } catch { return []; } })(),
            time: row.date ? row.date + "T00:00" : null,
            session_id: "v1-migration",
          }));
          this._factStore.addBatch(facts);
          log(`  [agent] 4. v1→v2 迁移完成: ${facts.length} 条记忆已迁入 facts.db`);
        }
        // 写迁移标记，防止重复迁移
        fs.writeFileSync(migrationDone, new Date().toISOString());
      } catch (err) {
        const message = errorMessage(err);
        console.error(`[agent] v1→v2 迁移失败（不影响启动）: ${message}`);
        // 迁移失败也写标记，避免每次启动重试
        try { fs.writeFileSync(migrationDone, `failed: ${message}`); } catch {}
      }
    }

    log(`  [agent] 4. FactStore + SummaryManager 完成`);

    // utility / memory 模型：
    // 共享模型优先；旧用户若还保留在 per-agent config.yaml 中，则按 utility_large -> utility -> chat 回退。
    const configuredChatModel = this._config?.models?.chat || null;
    this._utilityModel =
      sharedModels.utility
      || this._config?.models?.utility
      || configuredChatModel
      || null;
    this._memoryModel =
      sharedModels.utility_large
      || this._config?.models?.utility_large
      || this._utilityModel
      || configuredChatModel
      || null;
    this._resolvedUtilityModel = null;

    // 预解析记忆模型凭证（统一解析层）
    this._resolvedMemoryModel = null;
    this._memoryModelUnavailableReason = null;
    if (this._memoryModel && resolveModel) {
      try {
        this._resolvedMemoryModel = resolveModel(this._memoryModel, this._config);
      } catch (err) {
        const message = errorMessage(err);
        this._memoryModelUnavailableReason = message;
        console.warn(`[memory] 记忆系统未启动：大工具模型（utility_large）解析失败 — ${message}`);
        this._engine?.emitDevLog?.(`记忆系统未启动：大工具模型解析失败 — ${message}`, "error");
      }
    } else if (!this._memoryModel) {
      this._memoryModelUnavailableReason = "utility_large 未配置";
      console.warn("[memory] 记忆系统未启动：大工具模型（utility_large）未配置。请在设置中配置 utility_large 模型以启用记忆功能。");
      this._engine?.emitDevLog?.("记忆系统未启动：大工具模型（utility_large）未配置", "warn");
    }

    if (this._utilityModel && resolveModel) {
      try {
        this._resolvedUtilityModel = resolveModel(this._utilityModel, this._config);
      } catch (err) {
        console.warn(`[memory] 用户画像推断未启动：工具模型（utility）解析失败 — ${errorMessage(err)}`);
      }
    }

    if (this._resolvedMemoryModel) {
      log(`  [agent] 4. memoryTicker...`);
      this._memoryTicker = createMemoryTicker({
        summaryManager: this._summaryManager,
        configPath: this.configPath,
        factStore: this._factStore,
        getResolvedMemoryModel: () => this._resolvedMemoryModel,
        getMemoryMasterEnabled: () => this._memoryMasterEnabled,
        isSessionMemoryEnabled: (sessionPath: string | null | undefined) => this.isSessionMemoryEnabledFor(sessionPath),
        getProjectMemory: () => this._projectMemory,
        getUserProfile: () => this._userProfile,
        getInferredProfile: () => this._inferredProfile,
        getMemoryExclusions: () => this._memoryExclusions,
        getResolvedUtilityModel: () => this._resolvedUtilityModel || this._resolvedMemoryModel,
        getSkillDistiller: () => this._skillDistiller,
        getCwd: () => this._engine?.cwd || "",
        onCompiled: () => {
          this._systemPrompt = this.buildSystemPrompt();
          console.log(`[${this.agentName}] 记忆编译完成，system prompt 已刷新`);
        },
        sessionDir: this.sessionDir,
        memoryMdPath: this.memoryMdPath,
        todayMdPath: this.todayMdPath,
        weekMdPath: this.weekMdPath,
        longtermMdPath: this.longtermMdPath,
        factsMdPath: this.factsMdPath,
        experienceDir: path.join(this.agentDir, "experience"),
        experienceIndexPath: path.join(this.agentDir, "experience.md"),
      } as any);
      log(`  [agent] 4. memoryTicker 创建完成`);

      // 5. 后台跑首次 tick（不阻塞启动，memory.md 已有上次编译结果）
      log(`  [agent] 5. 后台 tick...`);
      this._memoryTicker.tick().then(() => {
        log(`✿ 记忆整理完成`);
      }).catch((err: unknown) => {
        console.error(`[记忆] 启动 tick 出错：${errorMessage(err)}`);
      });

      // 6. 启动定时调度
      this._memoryTicker.start();
    } else {
      console.warn(`[agent] ⚠ 未配置 utility 模型，记忆系统暂不可用（用户可在设置中配置后重启）`);
    }

    // Phase 4: 混合检索器（标签 + FTS + 本地向量）
    const retriever = new HybridRetriever({
      factStore: this._factStore as any,
      vectorConfig: {
        type: 'tfidf-local',
        dbPath: path.join(this.agentDir, 'memory', 'vectors.db'),
        dimensions: this._config?.models?.embedding_dimensions || 256,
      },
    });
    this._retriever = retriever;
    retriever.rebuildIndex().catch((err: unknown) => {
      console.warn(`[memory] vector index rebuild failed: ${errorMessage(err)}`);
    });

    // 7. 创建工具（记忆 + 通用）
    log(`  [agent] 7. 创建工具...`);
    this._memorySearchTool = createMemorySearchTool(this._factStore as any, { retriever: retriever as any });
    this._webSearchTool = createWebSearchTool();
    this._webFetchTool = createWebFetchTool();
    this._stockMarketTool = createStockMarketTool();
    this._weatherTool = createWeatherTool();
    this._liveNewsTool = createLiveNewsTool();
    this._sportsScoreTool = createSportsScoreTool();
    this._todoTool = createTodoTool();
    this._restoreSnapshotTool = createRestoreSnapshotTool(path.basename(this.agentDir));
    this._pinnedMemoryTools = createPinnedMemoryTools(this.agentDir);
    this._experienceTools = createExperienceTools(this.agentDir);
    this._activeTaskTool = createActiveTaskTool(this._activeTaskMemory as any, {
      onUpdated: () => {
        this._systemPrompt = this.buildSystemPrompt();
      },
    });

    // Phase 1: 主动记忆召回
    this._proactiveRecall = new ProactiveRecall({
      factStore: this._factStore as any,
      experienceDir: path.join(this.agentDir, "experience"),
      experienceIndexPath: path.join(this.agentDir, "experience.md"),
      isMemoryEnabled: () => this.memoryEnabled,
    });
    this._proactiveRecall.setRetriever(retriever);

    // Phase 2: 项目级记忆
    this._projectMemory = new ProjectMemory({
      projectsDir: path.join(this.agentDir, "memory", "projects"),
    });

    // Phase 3: 用户行为画像
    this._userProfile = new UserProfile({
      profilePath: path.join(this.agentDir, "memory", "user-profile.json"),
    });
    this._inferredProfile = new InferredProfile({
      profilePath: path.join(this.agentDir, "memory", "user-inferred.json"),
    });
    this._memoryExclusions = new MemoryExclusions({
      filePath: path.join(this.agentDir, "memory", "exclusions.json"),
    });
    this._skillDistiller = new SkillDistiller({
      agentDir: this.agentDir,
      factStore: this._factStore as any,
      listExistingSkills: () => this._engine?.getAllSkills(path.basename(this.agentDir)) || [],
      resolveDistillModel: () => this._resolvedMemoryModel || this._resolvedUtilityModel,
      resolveSafetyModel: () => this._resolvedUtilityModel || this._resolvedMemoryModel,
      onInstalled: async (skillName) => {
        const enabled = new Set(this._config?.skills?.enabled || []);
        enabled.add(skillName);
        this.updateConfig({ skills: { enabled: [...enabled] } });
        await this._engine?.reloadSkills?.();
        this._engine?.emitEvent?.({ type: "skills-changed" }, null);
      },
      onUpdated: async () => {
        await this._engine?.reloadSkills?.();
        this._engine?.emitEvent?.({ type: "skills-changed" }, null);
      },
    });

    // 8. Desk 系统（与 memory 完全独立）
    log(`  [agent] 8. Desk 系统...`);
    this._deskManager = createDeskManager(this.deskDir);
    this._deskManager.ensureDir();
    this._cronStore = new CronStore(
      path.join(this.deskDir, "cron-jobs.json"),
      path.join(this.deskDir, "cron-runs"),
    );
    this._cronTool = createCronTool(this._cronStore as any, {
      getAutoApprove: () => this._config?.desk?.cron_auto_approve !== false,
      confirmStore: this._engine?.confirmStore as any,
      emitEvent: (event) => this._engine?._emitEvent(event, this._engine?._sessionCoord?.currentSessionPath),
      getSessionPath: () => this._engine?._sessionCoord?.currentSessionPath,
    });
    this._presentFilesTool = createPresentFilesTool();
    this._artifactTool = createArtifactTool();
    this._pptxTool = createPptxTool({ getDeskDir: () => this.deskDir });
    this._reportTool = createReportTool({ getDeskDir: () => this.deskDir });
    this._docxTool = createDocxTool({ getDeskDir: () => this.deskDir });
    this._posterTool = createPosterTool({ getDeskDir: () => this.deskDir });
    this._stockResearchTool = createStockResearchTool();
    this._browserTool = createBrowserTool();
    this._notifyTool = createNotifyTool({
      onNotify: (title, body) => this._notifyHandler?.(title, body),
    });

    // 10. 设置修改工具
    this._updateSettingsTool = createUpdateSettingsTool({
      getEngine: () => this._engine,
      getConfirmStore: () => this._engine?.confirmStore,
      getSessionPath: () => this._engine?.currentSessionPath,
      emitEvent: (event: unknown) => this._engine?.emitSessionEvent(event),
    } as any);

    // 9. 频道工具 + 私信工具（需要 channelsDir 和 agentsDir）
    if (this.channelsDir && this.agentsDir) {
      const agentId = path.basename(this.agentDir);
      const agentsDir = this.agentsDir;
      const listAgents = () => {
        try {
          return fs.readdirSync(agentsDir, { withFileTypes: true })
            .filter(e => e.isDirectory() && fs.existsSync(path.join(agentsDir, e.name, "config.yaml")))
            .map(e => {
              try {
                const raw = fs.readFileSync(path.join(agentsDir, e.name, "config.yaml"), "utf-8");
                const nameMatch = raw.match(/^\s*name:\s*(.+)$/m);
                return { id: e.name, name: nameMatch?.[1]?.trim() || e.name };
              } catch { return { id: e.name, name: e.name }; }
            });
        } catch { return []; }
      };

      this._channelTool = createChannelTool({
        channelsDir: this.channelsDir,
        agentsDir: this.agentsDir,
        agentId,
        listAgents,
        onPost: (channelName, senderId) => {
          this._channelPostHandler?.(channelName, senderId);
        },
      });

      this._askAgentTool = createAskAgentTool({
        agentId,
        listAgents,
        engine: this._engine as any,
      });

      this._dmTool = createDmTool({
        agentId,
        agentsDir: path.dirname(this.agentDir),
        listAgents,
        onDmSent: (fromId, toId) => this._dmSentHandler?.(fromId, toId),
      });
    }

    // 10. install_skill 工具（需要 agentDir + config + engine.resolveUtilityConfig）
    this._installSkillTool = createInstallSkillTool({
      agentDir: this.agentDir,
      authorize: async ({ name, githubUrl, reason }) => {
        const decision = await requestAuthorization({
          category: "script_install",
          identifier: githubUrl || name || "install_skill",
          command: `install_skill ${githubUrl || name || ""}`,
          reason,
          description: "Install persistent agent instructions and executable skill files",
          path: this.agentDir,
          confirmStore: this._engine?.confirmStore,
          sessionPath: this._engine?._sessionCoord?.currentSessionPath,
          emitEvent: (event, sessionPath) => this._engine?._emitEvent(event, sessionPath),
        });
        return decision.allowed;
      },
      getConfig: () => {
        const cfg = { ...this._config };
        // learn_skills 从全局 preferences 注入（覆盖 agent config 中的值）
        const globalLearn = this._engine?.getLearnSkills?.() || {};
        if (!cfg.capabilities) cfg.capabilities = {};
        cfg.capabilities = { ...cfg.capabilities, learn_skills: globalLearn };
        return cfg;
      },
      resolveUtilityConfig: () => this._engine?.resolveUtilityConfig?.(),
      onInstalled: async (skillName) => {
        await this._onInstallCallback?.(skillName);
      },
    });

    // 11. delegate 工具（sub-agent 委派）
    this._delegateTool = createDelegateTool({
      executeIsolated: (prompt, opts) => {
        if (!this._engine) throw new Error("delegate 调用失败：engine 未初始化");
        return this._engine.executeIsolated(prompt, opts);
      },
      resolveUtilityModel: () => this._memoryModel || this._utilityModel || null,
      readOnlyBuiltinTools: READ_ONLY_BUILTIN_TOOLS,
    });

    // 12. 组装 system prompt
    log(`  [agent] 9. buildSystemPrompt...`);
    this._systemPrompt = this.buildSystemPrompt();
    log(`  [agent] init 全部完成`);
  }

  /**
   * 优雅关闭：停止记忆调度，等待 tick 完成后关闭 DB
   */
  async dispose() {
    await this._memoryTicker?.stop();
    this._retriever?.close?.();
    this._factStore?.close();
  }

  /**
   * 非阻塞关闭：立即停止定时器，后台等 tick 完成后关闭 DB
   * 用于跨 agent 切换时不阻塞 UI（各 agent 的 DB 独立，不冲突）
   */
  disposeInBackground() {
    this._disposing = true;
    const ticker = this._memoryTicker;
    const factStore = this._factStore;
    const retriever = this._retriever;

    const cleanup = () => {
      this._memoryTicker = null;
      this._retriever = null;
      this._factStore = null;
      this._disposing = false;
      retriever?.close?.();
      factStore?.close();
    };

    if (ticker) {
      ticker.stop().then(cleanup).catch(cleanup);
    } else {
      cleanup();
    }
  }

  // ════════════════════════════
  //  状态访问
  // ════════════════════════════

  get config() { return this._config; }
  get factStore() { return this._factStore; }
  get systemPrompt() { return this._systemPrompt; }
  /** 综合记忆状态：master && session 都开启才为 true */
  get memoryEnabled() { return this._memoryMasterEnabled && this._memorySessionEnabled; }
  /** agent 级别总开关 */
  get memoryMasterEnabled() { return this._memoryMasterEnabled; }
  /** per-session 级别（持久化、API 返回用，不受 master 影响） */
  get sessionMemoryEnabled() { return this._memorySessionEnabled; }
  get yuanPrompt() { return this._readYuan(); }
  get publicIshiki() { return this._readPublicIshiki(); }
  get utilityModel() { return this._utilityModel; }
  get memoryModel() { return this._memoryModel; }
  get resolvedMemoryModel() { return this._resolvedMemoryModel; }
  /** 记忆模型不可用的原因（null 表示可用） */
  get memoryModelUnavailableReason() { return this._memoryModelUnavailableReason; }
  get summaryManager() { return this._summaryManager; }
  get memoryTicker() { return this._memoryTicker; }
  get tools() {
    const memTools = this.memoryEnabled ? [
      this._memorySearchTool,
      this._activeTaskTool,
      ...this._pinnedMemoryTools,
      ...this._experienceTools,
    ].filter(Boolean) : [];
    return [
      ...memTools,
      this._webSearchTool,
      this._webFetchTool,
      this._stockMarketTool,
      this._weatherTool,
      this._liveNewsTool,
      this._sportsScoreTool,
      this._todoTool,
      this._restoreSnapshotTool,
      this._cronTool,
      this._presentFilesTool,
      this._artifactTool,
      this._pptxTool,
      this._reportTool,
      this._docxTool,
      this._posterTool,
      this._stockResearchTool,
      this._channelTool,
      this._askAgentTool,
      this._dmTool,
      this._browserTool,
      this._installSkillTool,
      this._notifyTool,
      this._updateSettingsTool,
      this._delegateTool,
    ].filter(Boolean);
  }

  // Desk 系统访问
  get deskManager() { return this._deskManager; }
  get cronStore() { return this._cronStore; }

  // ════════════════════════════
  //  记忆开关
  // ════════════════════════════

  /** 设置 per-session 记忆开关（持久化由 engine 负责） */
  setMemoryEnabled(val: unknown) {
    this._memorySessionEnabled = !!val;
    this._systemPrompt = this.buildSystemPrompt();
  }

  /** 查询指定 session 的持久化记忆开关，缺省视为开启 */
  isSessionMemoryEnabledFor(sessionPath?: string | null) {
    if (!sessionPath) return this._memorySessionEnabled;
    const metaPath = path.join(this.sessionDir, "session-meta.json");
    const meta = safeReadJSON(metaPath, {}) as Record<string, { memoryEnabled?: boolean } | undefined>;
    return meta[path.basename(sessionPath)]?.memoryEnabled !== false;
  }

  /** 设置 agent 级别记忆总开关（同时重载 config 以获取 disabledSince/reenableAt） */
  setMemoryMasterEnabled(val: unknown) {
    this._memoryMasterEnabled = !!val;
    this._config = loadConfig(this.configPath);
    this._systemPrompt = this.buildSystemPrompt();
  }

  /** 设置当前启用的 skill 列表（由 engine._syncAgentSkills 调用） */
  setEnabledSkills(skills: unknown[]) {
    this._enabledSkills = skills || [];
    this._systemPrompt = this.buildSystemPrompt();
  }

  // ════════════════════════════
  //  主动记忆召回（Phase 1）
  // ════════════════════════════

  /**
   * 对用户消息进行主动召回，返回格式化后的注入文本
   *
   * @param {string} userMessage - 用户消息
   * @param {string} [cwd] - 当前工作目录（Phase 2 用）
   * @returns {Promise<string>} - 注入文本（空字符串表示无需注入）
   */
  async recallForMessage(userMessage: string, cwd?: string) {
    if (!this._proactiveRecall || !this.memoryEnabled) return "";

    try {
      // Phase 2: 获取项目标签
      const projectTags: string[] = [];
      if (this._projectMemory && cwd) {
        const profile = this._projectMemory.getProfile(cwd);
        if (profile?.detected) {
          if (profile.detected.framework) projectTags.push(profile.detected.framework);
          if (profile.detected.language) projectTags.push(profile.detected.language);
        }
      }

      const result = await this._proactiveRecall.recall(userMessage, {
        projectTags,
        projectPath: cwd,
      });
      const isZh = String(this._config.locale || "").startsWith("zh");
      return {
        text: this._proactiveRecall.formatForInjection(result, isZh),
        injectedFactIds: result.injectedFactIds || [],
      };
    } catch (err) {
      console.error(`[agent] recallForMessage failed: ${errorMessage(err)}`);
      return "";
    }
  }

  get proactiveRecall() { return this._proactiveRecall; }
  get projectMemory() { return this._projectMemory; }
  get userProfile() { return this._userProfile; }
  get inferredProfile() { return this._inferredProfile; }
  get activeTaskMemory() { return this._activeTaskMemory; }

  // ════════════════════════════
  //  配置更新
  // ════════════════════════════

  /**
   * 更新配置（写入 config.yaml 并刷新受影响的模块）
   * @param {object} partial - 要合并的配置片段
   */
  updateConfig(partial: AgentConfig) {
    // 写入磁盘 + 重新加载
    saveConfig(this.configPath, partial);
    this._config = loadConfig(this.configPath);

    // 更新身份
    const isZh = String(this._config.locale || "").startsWith("zh");
    if (partial.agent?.name) this.agentName = this._config.agent?.name || "Lynn";
    if (partial.user?.name) this.userName = this._config.user?.name || (isZh ? "用户" : "User");

    // yuan 切换只需更新 config，buildSystemPrompt 会实时读模板
    if (partial.agent?.yuan) {
      console.log(`[agent] yuan type switched to: ${partial.agent.yuan}`);
    }

    // 记忆总开关
    if (partial.memory && "enabled" in partial.memory) {
      this._memoryMasterEnabled = this._config.memory?.enabled !== false;
    }

    // 刷新受影响的模块
    if (partial.search) {
      initWebSearch(this.configPath, this._searchConfigResolver
        ? { searchConfigResolver: this._searchConfigResolver as any }
        : {});
    }

    // 重建 system prompt
    this._systemPrompt = this.buildSystemPrompt();
  }

  // ════════════════════════════
  //  System Prompt 组装
  // ════════════════════════════

  /** 返回纯人格 prompt（identity + yuan + ishiki），不含记忆、用户档案等 */
  get personality() {
    const isZh = String(this._config.locale || "").startsWith("zh");
    const fill = (text: string) => text
      .replace(/\{\{userName\}\}/g, this.userName)
      .replace(/\{\{agentName\}\}/g, this.agentName)
      .replace(/\{\{agentId\}\}/g, path.basename(this.agentDir));
    const readFile = (p: string) => safeReadFile(p, "");
    const langDir = isZh ? "" : "en/";
    const yuanType = this._config?.agent?.yuan === "ming" ? "lynn" : (this._config?.agent?.yuan || "hanako");
    const identityMd = readFile(path.join(this.agentDir, "identity.md"))
      || readFile(path.join(this.productDir, "identity-templates", `${langDir}${yuanType}.md`))
      || readFile(path.join(this.productDir, "identity-templates", `${yuanType}.md`))
      || readFile(path.join(this.productDir, "identity.example.md"));
    const yuanMd = this._readYuan();
    const ishikiMd = readFile(path.join(this.agentDir, "ishiki.md"))
      || readFile(path.join(this.productDir, "ishiki-templates", `${langDir}${yuanType}.md`))
      || readFile(path.join(this.productDir, "ishiki-templates", `${yuanType}.md`))
      || readFile(path.join(this.productDir, "ishiki.example.md"));
    return fill(identityMd) + "\n\n" + fill(yuanMd || "") + "\n\n" + fill(ishikiMd);
  }

  /** 读取 yuan 模板（能力定义） */
  _readYuan(): string {
    const rawYuan = this._config?.agent?.yuan || "hanako";
    const yuanType = rawYuan === "ming" ? "lynn" : rawYuan;
    const isZh = String(this._config.locale || "").startsWith("zh");
    const langDir = isZh ? "" : "en/";
    return safeReadFile(path.join(this.productDir, "yuan", `${langDir}${yuanType}.md`), "")
      || safeReadFile(path.join(this.productDir, "yuan", `${yuanType}.md`), "");
  }

  /** 读取对外意识（public-ishiki.md），guest 会话使用 */
  _readPublicIshiki(): string {
    const readFile = (p: string) => safeReadFile(p, "");
    const fill = (text: string) => text
      .replace(/\{\{userName\}\}/g, this.userName)
      .replace(/\{\{agentName\}\}/g, this.agentName)
      .replace(/\{\{agentId\}\}/g, path.basename(this.agentDir));
    const rawYuan = this._config?.agent?.yuan || "hanako";
    const yuanType = rawYuan === "ming" ? "lynn" : rawYuan;
    const isZh = String(this._config.locale || "").startsWith("zh");
    const langDir = isZh ? "" : "en/";
    const raw = readFile(path.join(this.agentDir, "public-ishiki.md"))
      || readFile(path.join(this.productDir, "public-ishiki-templates", `${langDir}${yuanType}.md`))
      || readFile(path.join(this.productDir, "public-ishiki-templates", `${yuanType}.md`))
      || "";
    return fill(raw);
  }

  /** 组装 system prompt（静态/动态分层缓存） */
  buildSystemPrompt(): string {
    const isZh = String(this._config.locale || "").startsWith("zh");
    const readFile = (filePath: string) => safeReadFile(filePath, "");

    // ── 静态部分（identity + yuan + ishiki + skills + 固定规则，可缓存） ──
    const staticParts = this._buildStaticPrompt(isZh);

    // ── 动态边界 ──
    const DYNAMIC_BOUNDARY = "\n\n<!-- SYSTEM_PROMPT_DYNAMIC_BOUNDARY -->\n\n";

    // ── 动态部分（memory + user.md + pinned + 项目上下文，每次实时读取） ──
    const dynamicParts = this._buildDynamicPrompt(isZh, readFile);

    return staticParts + DYNAMIC_BOUNDARY + dynamicParts;
  }

  /** 静态 prompt（personality + 固定规则 + skills），config 不变时缓存复用 */
  _buildStaticPrompt(isZh: boolean): string {
    const rawYuan = this._config?.agent?.yuan || "hanako";
    const yuanType = rawYuan === "ming" ? "lynn" : rawYuan;
    if (!this._readYuan()) throw new Error(`Cannot find yuan "${yuanType}". Check lib/yuan/`);
    const ishiki = this.personality;
    const skillsText = this._enabledSkills?.length > 0 ? formatSkillsForPrompt(this._enabledSkills as any) : "";
    const learnCfg = this._engine?.getLearnSkills?.() || this._config?.capabilities?.learn_skills || {};

    // 缓存 key：基于实际静态 prompt 依赖做哈希，避免“长度相同但内容变化”时命中脏缓存
    const cacheKey = createAgentStaticPromptCacheKey({
      isZh,
      yuanType,
      personality: ishiki,
      skillsText,
      learnSkillsEnabled: !!learnCfg.enabled,
      allowGithubFetch: !!learnCfg.allow_github_fetch,
    });
    if (this._staticPromptCache && this._staticPromptDeps === cacheKey) {
      return this._staticPromptCache;
    }

    const parts = [
      isZh
        ? "你运行在 Lynn 平台上。项目主页：https://gitee.com/merkyor/Lynn"
        : "You are running on the Lynn platform. Project page: https://gitee.com/merkyor/Lynn",
      ishiki,
    ];

    if (isZh) {
      parts.push(
        "\n## 语言偏好\n\n"
        + "用户使用中文或界面语言为中文时，最终回答优先使用中文。"
      );
    }

    if (skillsText) parts.push(skillsText);
    if (skillsText) {
      parts.push(isZh
        ? "\n## 已启用技能匹配规则\n\n"
          + "已启用的 skill 不是装饰。遇到和某个 skill 描述明显匹配的任务时：\n"
          + "1. 先用 read 工具打开对应 skill 的 `SKILL.md`\n"
          + "2. 按 skill 里的步骤执行，而不是只凭技能名或简短描述猜\n"
          + "3. 如果多个已启用 skill 都相关，先加载最贴近主任务的那个，再按需要补第二个\n"
          + "4. 不要在已经有匹配 skill 的情况下重新上网搜替代技能\n"
          + "5. 像“今天金价多少”“天气如何”“今天股价/指数/新闻”“体育比分”这类通用实时查询，优先使用当前链路已提供的实时信息工具（例如 stock_market、weather、sports_score、live_news），若当前链路未提供，再回退到 web_search、web_fetch。体育赛程/比分/几场这类问题中，若 sports_score 已返回 provider: espn_scoreboard 且 matched > 0，直接基于该直源回答；不要再用泛 web_search 交叉核对或覆盖它。不要优先读取重型分析 skill（例如 stock-analysis、weather）的 SKILL.md。只有当用户明确要求股票分析、持仓分析、分红分析、趋势扫描、传闻扫描、观察列表、深度天气分析或 /stock 系列命令时，才使用这类 skill"
        : "\n## Enabled Skill Matching Rules\n\n"
          + "Enabled skills are not decorative. When the request clearly matches a skill description:\n"
          + "1. Read that skill's `SKILL.md` first\n"
          + "2. Follow the workflow in the skill instead of guessing from the name or short description\n"
          + "3. If multiple enabled skills are relevant, load the one most central to the task first, then add others as needed\n"
          + "4. Do not search for replacement skills when an enabled skill already matches\n"
          + "5. For generic real-time lookups such as today's gold price, weather, stock price/index/news, or sports scores, prefer any real-time information tools available on the current route (for example stock_market, weather, sports_score, or live_news). If sports_score returns provider: espn_scoreboard with matched > 0 for schedule/score/count questions, answer directly from that source; do not cross-check or override it with generic web_search. If the current route does not provide those realtime tools, fall back to web_search and web_fetch. Do not default to heavyweight analysis skills (for example stock-analysis or weather) unless the user explicitly asks for stock analysis, portfolio/dividend analysis, trend scanning, rumor scanning, watchlists, deeper weather analysis, or /stock-style workflows"
      );
    }

    // 网页工具选择优先级
    parts.push(isZh
      ? "\n## 网页工具优先级\n\n"
        + "获取网页信息时，按以下顺序选择工具：\n"
        + "1. **web_search** — 查找信息、获取 URL。大多数「帮我查一下 XX」的请求用这个就够了\n"
        + "2. **web_fetch** — 已知 URL，需要提取页面文字内容。简单抓取必须用这个\n"
        + "3. **browser** — 只在以下情况使用：页面需要登录/身份验证、需要填表或点击交互、web_fetch 返回的内容为空或不完整（JS 动态渲染页面）、需要查看页面视觉布局\n\n"
        + "对于「今日/最新/实时/行情/新闻/调研/官方文档」这类任务：若当前链路提供了实时信息工具（例如 stock_market、weather、sports_score、live_news），优先使用；否则先用 **web_search** 找结果，再对最相关的 1-2 个 URL 用 **web_fetch** 深读，不要只看搜索标题就下结论。\n"
        + "对于「股价/金价/基金/汇率/指数/天气/热点资讯」这类任务：优先交叉核对 2 个来源；如果 web_search 已提示推荐来源（如 AkShare、腾讯自选股、新浪财经等），优先从这些来源里挑结果继续深读。对于体育比分/赛程/几场，sports_score 的 ESPN scoreboard 直源优先级高于泛搜索；直源已匹配时不要再用 web_search 补旧赛程或新闻摘要。\n\n"
        + "对于 Lynn 内部 UX 文案、Session Map/工作地图、右侧工作台、按钮 tooltip、状态文案、验收标准这类请求，除非用户明确要求查外部来源，否则直接根据当前产品语境回答，不要把内部概念拿去公网搜索。\n\n"
        + "**禁止**在 web_search 或 web_fetch 能完成的场景下启动浏览器。浏览器启动成本高、会打开窗口干扰用户。"
      : "\n## Web Tool Priority\n\n"
        + "When fetching web information, choose tools in this order:\n"
        + "1. **web_search** — Find information, get URLs. Most \"look up XX\" requests are handled by this alone\n"
        + "2. **web_fetch** — Known URL, need to extract page text. Simple scraping must use this\n"
        + "3. **browser** — Only use when: the page requires login/authentication, form filling or click interaction is needed, web_fetch returns empty or incomplete content (JS-rendered pages), or you need to see visual layout\n\n"
        + "For queries like today/latest/live/market/news/research/official docs, use route-provided real-time tools first when available (for example stock_market, weather, sports_score, or live_news). Otherwise use **web_search** first and then **web_fetch** the most relevant 1-2 URLs before drawing conclusions.\n"
        + "For stock prices, gold prices, funds, FX, indexes, weather, or breaking-news summaries, cross-check at least two sources. For sports scores, fixtures, and match-count questions, an ESPN scoreboard result from sports_score takes priority over generic search; when it has matched events, do not use web_search to add stale schedules or news snippets. If web_search suggests preferred non-sports sources (for example AkShare, Tencent quotes, or Sina Finance), use those results first for deeper reading.\n\n"
        + "For Lynn-internal UX copy, Session Map/work map, right workspace, button tooltips, status copy, or acceptance criteria, answer from the current product context unless the user explicitly asks for external sources; do not web-search an internal concept as a public brand.\n\n"
        + "**Do not** launch the browser when web_search or web_fetch can do the job. Browser startup is expensive and opens a window that interrupts the user."
    );

    parts.push(isZh
      ? "\n## 工具执行纪律\n\n"
        + "遇到工具型、编码型、长任务型请求时：\n"
        + "1. 先想清楚 2-5 个步骤，再开始调工具\n"
        + "2. 每一轮尽量只做 1-2 个彼此强相关的工具调用，不要一口气乱并发\n"
        + "3. 工具返回后先读结果、判断是否足够，再继续下一步\n"
        + "4. 搜索类任务如果结果不够，优先改写查询词、换来源、再深读，不要反复输出同一段空话\n"
        + "5. 关键数字、时间、文件路径、命令结果必须以工具返回为准，不要脑补\n"
        + "6. 工具失败两次后，要换策略（换 query、换来源、缩小范围、改用其他工具），不要机械重试\n"
        + "7. 用户要研究什么，就围绕这个命题自然延展资料路径；不要把任务套进固定模板。任何需要证据链的长任务，都可以自己用 bash 启动临时 Python/Node 脚本来抓取、解析、去重、汇总和计算；先产出可核验的中间数据，再写结论，不要只凭常识写报告\n"
        + "8. 如果脚本、搜索或抓取拿不到关键资料（例如交易软件行情、公告全文、PDF 原文、成交明细、用户持仓成本、具体房源截图），不要硬编；先给已验证部分，再明确列出缺口并向用户索要具体截图、链接、导出文件或假设参数\n"
        + "9. 用户让你修代码或排查 traceback 时，若你没有实际编辑文件并成功运行验证，不要说“已修复”。给出最小改动建议后，最后必须写一条用户可执行的验证命令，并用“请运行验证：”开头；如果报错入口是 `main.py`，验证命令应包含 `python main.py` 或 `python3 main.py`\n"
        + "10. 不要把普通答案自动升级成交付物。只有用户明确要求生成报告、HTML、文档、文件、附件、可预览页面、导出物或 PPT/DOCX/PDF 时，才调用 create_report、create_artifact、create_docx、create_pptx、present_files 等交付物工具。文字写作、人物小传、小说片段/大纲、角色或世界观设定必须直接用文字回答；只有用户明确要求生成或编辑图片、插画、海报、封面、头像等视觉产物时，才调用 generate_image/flux。用户要求把已有结果/数据/表格/图表输出成图片、长图、PNG 或 HTML 可视化时，走 create_report/create_artifact 这类确定性 HTML→PNG 路径；不要用 generate_image/flux 画一张会幻觉的数据图。简单计算、表格、摘要、管理建议、代码片段和对话性回答必须直接写在聊天正文里\n"
        + "11. OKR、计划、清单、排期、框架等内容请求应直接在聊天正文回答，不要据此修改会话待办。只有用户明确要求添加/修改待办、设置提醒，或当前确实在执行多步骤代码/文件/部署工作时，才调用 todo。用户只是要求你记住一个普通事实、标签、偏好或项目代号,并要求简短确认时,直接在聊天里确认即可。不要调用 read/write/edit/bash/create_artifact 或任何技能来保存;Lynn 的记忆系统会在回合结束后处理"
      : "\n## Tool Execution Discipline\n\n"
        + "For tool-heavy, coding-heavy, or long-running tasks:\n"
        + "1. Think in 2-5 concrete steps before calling tools\n"
        + "2. Keep each round to 1-2 tightly related tool calls instead of chaotic fan-out\n"
        + "3. Read the result and decide whether it is sufficient before moving on\n"
        + "4. If search results are weak, rewrite the query, change sources, or deepen reading before repeating the same answer\n"
        + "5. Trust tool outputs for numbers, timestamps, file paths, and command results; do not invent them\n"
        + "6. After two failed tool attempts, change strategy instead of mechanically retrying\n"
        + "7. Follow the user's exact research question instead of forcing a fixed template. For any evidence-chain long task, use bash to run temporary Python/Node scripts when useful for fetching, parsing, deduplicating, aggregating, or calculating; build verifiable intermediate data before writing conclusions\n"
        + "8. If scripts, search, or fetch cannot obtain key source material, do not fabricate. Provide the verified portion, then explicitly ask the user for the needed screenshot, URL, exported file, PDF, or assumption\n"
        + "9. When the user asks you to fix code or debug a traceback, do not say it is fixed unless you actually edited files and successfully ran verification. After the minimal fix guidance, end with an explicit verification command. If the failing entrypoint is `main.py`, include `python main.py` or `python3 main.py`\n"
        + "10. Do not auto-upgrade ordinary answers into deliverables. Only call deliverable tools such as create_report, create_artifact, create_docx, create_pptx, or present_files when the user explicitly asks for a report, HTML, document, file, attachment, preview page, export, PPT/DOCX/PDF, or similar artifact. Text writing, character biographies, novel scenes/outlines, and character or world-building notes must be answered directly as text; call generate_image/flux only when the user explicitly requests a visual output such as an image, illustration, poster, cover, avatar, or an edit to one. When the user asks to turn existing results/data/tables/charts into an image, long image, PNG, or HTML visualization, use deterministic create_report/create_artifact HTML→PNG paths; do not use generate_image/flux to paint a hallucinated data graphic. Simple calculations, tables, summaries, management advice, code snippets, and conversational answers must stay in the chat body\n"
        + "11. Requests for OKRs, plans, checklists, schedules, or frameworks should be answered directly in chat and must not mutate the session todo list. Call todo only when the user explicitly asks to add or change todos, set a reminder, or when you are actually executing multi-step code, file, or deployment work. When the user only asks you to remember a normal fact, label, preference, or project code and requests a short acknowledgement, reply directly in chat. Do not call read/write/edit/bash/create_artifact or any skill to store it; Lynn's memory system handles persistence after the turn"
    );

    // 设置工具路由
    parts.push(isZh
      ? "\n## 设置修改\n\n"
        + "用户提到修改设置而未指明具体软件时，默认指本应用的设置。\n"
        + "用户要求修改偏好设置（包括但不限于：外观主题、语言地区、模型选择、安全权限、记忆功能、个人信息、工作目录）时，使用 update_settings 工具。不要搜索网页，不要编辑配置文件。意图明确时直接 apply，不确定时先 search。"
      : "\n## Settings Changes\n\n"
        + "When the user mentions changing settings without specifying a particular application, assume they mean this application.\n"
        + "When the user asks to change preferences (including but not limited to: appearance/theme, language/region, model selection, security/permissions, memory, personal info, working directory), use the update_settings tool. Do not search the web or edit config files. When intent is clear, apply directly; when unsure, search first."
    );

    parts.push(isZh
      ? "\n## 技能创建与安装\n\n"
        + "整理好可复用技能后，先展示来源、用途和将要写入的目录。只有用户明确要求安装或确认后，才可使用 install_skill 工具。\n"
        + "不要把 SKILL.md 先写到桌面或工作区，再让用户自己 mv/复制到技能目录。\n"
        + "只有当用户明确要求导出一个工作区副本时，才额外写一份到指定目录。"
      : "\n## Skill Authoring And Installation\n\n"
        + "Present a reusable skill's source, purpose and target directory first. Use install_skill only when the user has explicitly requested or confirmed installation.\n"
        + "Do not write SKILL.md into the desktop or workspace first and then ask the user to move or copy it manually.\n"
        + "Only write an extra workspace copy when the user explicitly asks for an exported copy."
    );

    // 主动技能获取引导
    if (learnCfg.enabled && learnCfg.allow_github_fetch) {
      parts.push(isZh
        ? "\n## 主动技能获取\n\n"
          + "遇到专业领域任务且没有对应技能时，可以搜索并展示候选；安装前必须取得用户明确确认。\n\n"
          + "### 搜索\n\n"
          + "1. `site:clawhub.ai {关键词}` 或 `site:github.com/openclaw/skills {关键词}`\n"
          + "2. GitHub 上其他含 SKILL.md 的仓库\n"
          + "3. install_skill 安装：用 github_url 参数\n\n"
          + "### 判断\n\n"
          + "- 已有相关技能则直接使用，不重复搜索\n"
          + "- 仅专业领域任务搜索，日常对话不搜\n"
          + "- 安装应能显著提升输出质量\n\n"
          + "### 行为\n\n"
          + "- 找到后展示来源与用途；只有用户明确要求或确认安装后才安装和应用\n"
          + "- 安装失败则尝试自己完成\n"
          + "- 搜索无果正常完成，不反复尝试"
        : "\n## Proactive Skill Acquisition\n\n"
          + "For specialized tasks, search and present candidate skills; obtain explicit user approval before installation.\n\n"
          + "### Search\n\n"
          + "1. `site:clawhub.ai {keywords}` or `site:github.com/openclaw/skills {keywords}`\n"
          + "2. Other GitHub repos containing SKILL.md\n"
          + "3. install_skill: use github_url parameter\n\n"
          + "### When\n\n"
          + "- If you already have a relevant skill, use it directly — don't search again\n"
          + "- Only search for specialized tasks, not everyday conversation\n"
          + "- Installation should significantly improve output quality\n\n"
          + "### Behavior\n\n"
          + "- Present the source and purpose; install and apply only after explicit user approval\n"
          + "- If installation fails, try to complete the task yourself\n"
          + "- If search yields nothing, proceed normally without retrying"
      );
    }

    const result = parts.join("\n");
    this._staticPromptCache = result;
    this._staticPromptDeps = cacheKey;
    return result;
  }

  /** 动态 prompt（memory + user.md + pinned + 项目/用户画像），每次实时读取 */
  _buildDynamicPrompt(isZh: boolean, readFile: (filePath: string) => string): string {
    return buildAgentDynamicPrompt({
      userDir: this.userDir,
      agentDir: this.agentDir,
      memoryMdPath: this.memoryMdPath,
      userName: this.userName,
      memoryEnabled: this.memoryEnabled,
      engine: this._engine,
      projectMemory: this._projectMemory,
      userProfile: this._userProfile,
      inferredProfile: this._inferredProfile,
      activeTaskMemory: this._activeTaskMemory,
    }, isZh, readFile);
  }
}
