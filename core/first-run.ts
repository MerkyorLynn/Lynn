/**
 * first-run.ts — 首次运行播种
 *
 * 在 server/engine 启动之前调用，确保 ~/.lynn/ 结构存在。
 * 如果是全新安装（agents/ 为空），自动创建默认 agent。
 */

import fs from "fs";
import path from "path";
import os from "os";
import YAML from "js-yaml";
import type { DumpOptions } from "js-yaml";
import { safeCopyDir } from '../shared/safe-fs.js';
import { AppError } from '../shared/errors.js';
import { errorBus } from '../shared/error-bus.js';
import { uniqueTrustedRoots } from '../shared/trusted-roots.js';
import { getRoleDefaultModelRefs } from "../shared/assistant-role-models.js";

type JsonObject = Record<string, any>;

type AgentSpec = {
  id: string;
  name: string;
  yuan: string;
};

type FirstRunDirs = {
  agentsDir: string;
  productDir: string;
  prefsPath: string;
};

type BuiltInSeedContext = {
  templateConfig: JsonObject;
  referenceConfig: JsonObject;
  userName: string;
};

type TemplateWriteOptions = {
  targetPath: string;
  templatePath: string | null;
  replacements: {
    agentName?: string;
    userName?: string;
  };
};

type SkillInfo = {
  dirName: string;
  name: string;
  requiresCredentials: boolean;
};

const YAML_DUMP_OPTIONS = {
  lineWidth: 120,
  noRefs: true,
  quotingType: '"',
} as unknown as DumpOptions;

const RECOMMENDED_DEFAULT_SKILLS = [
  "self-improving-agent",
  "find-skills",
  "summarize",
  "agent-browser",
  "github",
  "proactive-agent",
  "ontology",
  "skill-vetter",
  "nano-pdf",
  "humanizer",
  "ffmpeg-video-editor",
  "docker-essentials",
];

const BUILT_IN_AGENT_SPECS = [
  { id: "lynn", name: "Lynn", yuan: "lynn" },
  { id: "hanako", name: "Hanako", yuan: "hanako" },
  { id: "butter", name: "Butter", yuan: "butter" },
] satisfies AgentSpec[];

function firstExistingPath(...paths: Array<string | null | undefined>): string | null {
  for (const p of paths) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 确保 ~/.lynn/ 数据目录就绪
 * @param {string} lynnHome - ~/.lynn 绝对路径
 * @param {string} productDir - 产品模板目录（lib/）
 */
export function ensureFirstRun(lynnHome: string, productDir: string): void {
  // 0. 从旧数据目录 ~/.hanako 复制首份 Lynn 数据；保留 OpenHanako 原目录
  migrateFromHanako(lynnHome);

  // 1. 确保目录结构存在
  fs.mkdirSync(path.join(lynnHome, "agents"), { recursive: true });
  fs.mkdirSync(path.join(lynnHome, "user"), { recursive: true });

  const prefsPath = path.join(lynnHome, "user", "preferences.json");

  // 1b. 老版本主助手迁移：旧安装里主助手目录仍叫 hanako，
  // 但显示名已经是 Lynn，会导致新逻辑和运行时状态长期错位。
  migrateLegacyPrimaryAgent({ agentsDir: path.join(lynnHome, "agents"), prefsPath, productDir });

  // 2. 如果 agents/ 没有任何 agent → 播种默认 agent
  const agentsDir = path.join(lynnHome, "agents");
  const hasAgent = fs.readdirSync(agentsDir, { withFileTypes: true }).some(entry => {
    return entry.isDirectory()
      && !entry.name.startsWith('.')
      && fs.existsSync(path.join(agentsDir, entry.name, "config.yaml"));
  });

  if (!hasAgent) {
    console.log("[first-run] 首次启动，正在创建内置助手...");
  }

  ensureBuiltInAgents({ agentsDir, productDir, prefsPath });

  // 3. 同步 skills：从 skills2set/ 复制到 ~/.lynn/skills/
  const skillsSrc = path.join(productDir, "..", "skills2set");
  const skillsDst = path.join(lynnHome, "skills");
  fs.mkdirSync(skillsDst, { recursive: true });
  if (fs.existsSync(skillsSrc)) {
    syncSkills(skillsSrc, skillsDst);
    seedRecommendedSkills(agentsDir, skillsDst);
    unseedDeprecatedRecommendedSkills(agentsDir);
  }

  // 4. 确保可选文件存在（老用户升级 + 新 agent 都覆盖）
  const touchIfMissing = (p: string) => { if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf-8'); };
  touchIfMissing(path.join(lynnHome, 'user', 'user.md'));
  const agents = fs.readdirSync(agentsDir, { withFileTypes: true });
  for (const entry of agents) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    touchIfMissing(path.join(agentsDir, entry.name, 'pinned.md'));
  }

  // 5. 确保 user/preferences.json 存在
  if (!fs.existsSync(prefsPath)) {
    fs.writeFileSync(
      prefsPath,
      JSON.stringify({
        primaryAgent: "lynn",
      }, null, 2) + "\n",
      "utf-8",
    );
  }

  ensureDefaultWorkspacePrefs(prefsPath, productDir);
}

/**
 * 从旧版 ~/.hanako 复制首份数据到 ~/.lynn。
 * 如果 ~/.lynn 已存在则跳过（用户已迁移或全新安装）。
 * 注意：不能 rename/move 旧目录，否则 OpenHanako 用户会丢失自己的应用数据。
 */
function migrateFromHanako(lynnHome: string): void {
  const defaultLynn = path.join(os.homedir(), ".lynn");
  if (lynnHome !== defaultLynn) return; // 自定义路径，不自动迁移

  const oldHome = path.join(os.homedir(), ".hanako");
  if (!fs.existsSync(oldHome)) return;
  if (fs.existsSync(defaultLynn)) return; // 新目录已存在，不覆盖

  try {
    safeCopyDir(oldHome, defaultLynn);
    console.log(`[first-run] 已从旧数据目录复制初始数据: ~/.hanako → ~/.lynn`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[first-run] 数据目录迁移失败 (${message})，将使用新目录`);
  }
}

function migrateLegacyPrimaryAgent({ agentsDir, prefsPath, productDir }: FirstRunDirs): void {
  const legacyAgentId = "hanako";
  const nextAgentId = "lynn";
  const legacyDir = path.join(agentsDir, legacyAgentId);
  const nextDir = path.join(agentsDir, nextAgentId);

  if (!fs.existsSync(legacyDir) || fs.existsSync(nextDir)) return;

  const prefs = readJsonFile(prefsPath);
  const primaryAgent = typeof prefs.primaryAgent === "string" ? prefs.primaryAgent.trim() : "";
  if (primaryAgent && primaryAgent !== legacyAgentId) return;

  const configPath = path.join(legacyDir, "config.yaml");
  if (!fs.existsSync(configPath)) return;

  let config: JsonObject;
  try {
    config = loadYamlObject(configPath);
  } catch {
    return;
  }

  const agentName = String(config?.agent?.name || "").trim().toLowerCase();
  const yuanType = String(config?.agent?.yuan || "").trim().toLowerCase();
  const looksLikeLegacyMainAgent = agentName === "lynn" && (!yuanType || yuanType === "hanako");
  if (!looksLikeLegacyMainAgent) return;

  fs.renameSync(legacyDir, nextDir);
  normalizeMigratedLynnAgent(nextDir, productDir);

  const nextPrefs: JsonObject = { ...prefs, primaryAgent: nextAgentId };
  if (Array.isArray(nextPrefs.agentOrder)) {
    nextPrefs.agentOrder = nextPrefs.agentOrder.map((id: unknown) => id === legacyAgentId ? nextAgentId : id);
  }
  if (nextPrefs.review && typeof nextPrefs.review === "object") {
    if (nextPrefs.review.hanakoReviewerId === legacyAgentId) nextPrefs.review.hanakoReviewerId = null;
    if (nextPrefs.review.butterReviewerId === legacyAgentId) nextPrefs.review.butterReviewerId = null;
  }
  writeJsonFile(prefsPath, nextPrefs);

  console.log(`[first-run] 已将旧主助手 "${legacyAgentId}" 迁移为 "${nextAgentId}"`);
}

function normalizeMigratedLynnAgent(agentDir: string, productDir: string): void {
  const configPath = path.join(agentDir, "config.yaml");
  try {
    const cfg = loadYamlObject(configPath);
    cfg.agent = cfg.agent || {};
    if (!String(cfg.agent.name || "").trim()) cfg.agent.name = "Lynn";
    if (!String(cfg.agent.yuan || "").trim() || String(cfg.agent.yuan).trim().toLowerCase() === "hanako") {
      cfg.agent.yuan = "lynn";
    }
    fs.writeFileSync(configPath, YAML.dump(cfg, YAML_DUMP_OPTIONS), "utf-8");
  } catch {}

  const lynnPublicIshiki = path.join(productDir, "public-ishiki-templates", "lynn.md");
  const publicIshikiPath = path.join(agentDir, "public-ishiki.md");
  if (!fs.existsSync(publicIshikiPath) && fs.existsSync(lynnPublicIshiki)) {
    fs.copyFileSync(lynnPublicIshiki, publicIshikiPath);
  }
}

function readJsonFile(filePath: string): JsonObject {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function writeJsonFile(filePath: string, value: JsonObject): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function loadYamlObject(filePath: string): JsonObject {
  return (YAML.load(fs.readFileSync(filePath, "utf-8")) || {}) as JsonObject;
}

function ensureDefaultWorkspacePrefs(prefsPath: string, productDir: string): void {
  const prefs = readJsonFile(prefsPath);
  const desktopRoot = path.join(os.homedir(), 'Desktop');
  const workspacePath = path.join(desktopRoot, 'Lynn');

  try { fs.mkdirSync(workspacePath, { recursive: true }); } catch {}

  const existingRoots = Array.isArray(prefs.trusted_roots) ? prefs.trusted_roots : [];
  const sanitizedRoots = existingRoots.filter((root: unknown) => {
    const normalized = String(root || '').trim().replace(/\\/g, '/');
    if (!normalized) return false;
    if (normalized.includes('/Applications/Lynn.app/Contents/Resources/server')) return false;
    if (normalized.includes('/Applications/Lynn.app/Contents/Resources/app.asar/server')) return false;
    return true;
  });

  const nextHomeFolder = String(prefs.home_folder || '').trim() || workspacePath;
  const nextTrustedRoots = uniqueTrustedRoots([
    ...sanitizedRoots,
    desktopRoot,
    workspacePath,
  ]);

  const changed = nextHomeFolder !== prefs.home_folder
    || JSON.stringify(nextTrustedRoots) !== JSON.stringify(Array.isArray(prefs.trusted_roots) ? prefs.trusted_roots : []);

  if (!changed) return;

  writeJsonFile(prefsPath, {
    ...prefs,
    home_folder: nextHomeFolder,
    trusted_roots: nextTrustedRoots,
  });
}

/**
 * 从模板播种内置助手（与 engine.createAgent 相同逻辑，但纯同步、无依赖）
 */
function ensureBuiltInAgents({ agentsDir, productDir, prefsPath }: FirstRunDirs): void {
  const createdIds: string[] = [];
  for (const spec of BUILT_IN_AGENT_SPECS) {
    const created = ensureBuiltInAgent({ agentsDir, productDir, spec });
    if (created) createdIds.push(spec.id);
  }

  ensureBuiltInAgentOrder(prefsPath, agentsDir);

  if (createdIds.length > 0) {
    console.log(`[first-run] 已补齐内置助手: ${createdIds.join(", ")}`);
  }
}

function ensureBuiltInAgent({ agentsDir, productDir, spec }: { agentsDir: string; productDir: string; spec: AgentSpec }): boolean {
  const agentDir = path.join(agentsDir, spec.id);
  const configPath = path.join(agentDir, "config.yaml");
  const seedContext = getBuiltInSeedContext(agentsDir, productDir);
  const desiredChatModel = getBuiltInAgentChatModelSeed(spec);

  ensureAgentScaffold(agentDir);

  let created = false;
  if (!fs.existsSync(configPath)) {
    const config = buildBuiltInAgentConfig(productDir, spec, seedContext);
    fs.writeFileSync(configPath, YAML.dump(config, YAML_DUMP_OPTIONS), "utf-8");
    created = true;
  } else {
    try {
      const config = loadYamlObject(configPath);
      config.agent = config.agent || {};
      let changed = false;
      if (String(config.agent.name || "").trim() !== spec.name) {
        config.agent.name = spec.name;
        changed = true;
      }
      if (String(config.agent.yuan || "").trim().toLowerCase() !== spec.yuan) {
        config.agent.yuan = spec.yuan;
        changed = true;
      }
      if (!config.models || typeof config.models !== "object") {
        config.models = {};
        changed = true;
      }
      if (!config.models.chat && desiredChatModel) {
        config.models.chat = desiredChatModel;
        changed = true;
      }
      if (String(config.agent.tier || "").trim().toLowerCase() === "reviewer") {
        config.agent.tier = "local";
        changed = true;
      }
      if (changed) {
        fs.writeFileSync(configPath, YAML.dump(config, YAML_DUMP_OPTIONS), "utf-8");
      }
    } catch {}
  }

  writeTemplateIfMissing({
    targetPath: path.join(agentDir, "identity.md"),
    templatePath: firstExistingPath(
      path.join(productDir, "identity-templates", `${spec.yuan}.md`),
      path.join(productDir, "identity.example.md"),
    ),
    replacements: { agentName: spec.name, userName: seedContext.userName },
  });

  writeTemplateIfMissing({
    targetPath: path.join(agentDir, "ishiki.md"),
    templatePath: firstExistingPath(
      path.join(productDir, "ishiki-templates", `${spec.yuan}.md`),
      path.join(productDir, "ishiki.example.md"),
    ),
    replacements: { agentName: spec.name, userName: seedContext.userName },
  });

  writeTemplateIfMissing({
    targetPath: path.join(agentDir, "public-ishiki.md"),
    templatePath: firstExistingPath(
      path.join(productDir, "public-ishiki-templates", `${spec.yuan}.md`),
      path.join(productDir, "public-ishiki-templates", "hanako.md"),
    ),
    replacements: { agentName: spec.name, userName: seedContext.userName },
  });

  const touchIfMissing = (p: string) => { if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf-8'); };
  touchIfMissing(path.join(agentDir, 'pinned.md'));

  return created;
}

function ensureAgentScaffold(agentDir: string): void {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "avatars"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "desk"), { recursive: true });
}

function getBuiltInSeedContext(agentsDir: string, productDir: string): BuiltInSeedContext {
  const templateConfigPath = path.join(productDir, "config.example.yaml");
  const templateConfig = fs.existsSync(templateConfigPath)
    ? loadYamlObject(templateConfigPath)
    : {};

  const referenceConfig = readFirstExistingAgentConfig(agentsDir);
  const userName = String(referenceConfig?.user?.name || templateConfig?.user?.name || "").trim();
  return {
    templateConfig,
    referenceConfig,
    userName,
  };
}

function readFirstExistingAgentConfig(agentsDir: string): JsonObject {
  const preferredOrder = BUILT_IN_AGENT_SPECS.map((spec) => spec.id);
  const existingIds = fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
  const orderedIds = [...preferredOrder, ...existingIds.filter((id) => !preferredOrder.includes(id))];

  for (const agentId of orderedIds) {
    const configPath = path.join(agentsDir, agentId, "config.yaml");
    if (!fs.existsSync(configPath)) continue;
    try {
      return loadYamlObject(configPath);
    } catch {}
  }

  return {};
}

function buildBuiltInAgentConfig(productDir: string, spec: AgentSpec, seedContext: BuiltInSeedContext): JsonObject {
  const base = deepClone(seedContext.templateConfig || {});
  const reference = deepClone(seedContext.referenceConfig || {});

  for (const key of ["user", "api", "embedding_api", "models", "memory", "search", "skills", "capabilities", "channels", "desk", "last_cwd", "cwd_history"]) {
    if (reference[key] !== undefined) {
      base[key] = deepClone(reference[key]);
    }
  }

  base.agent = {
    ...(base.agent || {}),
    name: spec.name,
    yuan: spec.yuan,
  };
  base.models = {
    ...(base.models || {}),
  };
  const desiredChatModel = getBuiltInAgentChatModelSeed(spec);
  if (desiredChatModel) {
    base.models.chat = desiredChatModel;
  }
  base.user = {
    ...(base.user || {}),
    name: seedContext.userName,
  };

  return base;
}

function getBuiltInAgentChatModelSeed(spec: AgentSpec): string | JsonObject | null {
  const role = String(spec?.yuan || "").trim().toLowerCase();
  const purpose = role === "lynn" ? "chat" : "review";
  const primaryRef = getRoleDefaultModelRefs(role, purpose)[0] || null;
  if (!primaryRef?.id) return null;
  return primaryRef.provider
    ? { id: primaryRef.id, provider: primaryRef.provider }
    : primaryRef.id;
}

function deepClone<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value));
}

function writeTemplateIfMissing({ targetPath, templatePath, replacements }: TemplateWriteOptions): void {
  if (fs.existsSync(targetPath) || !templatePath || !fs.existsSync(templatePath)) return;
  const raw = fs.readFileSync(templatePath, "utf-8");
  const filled = raw
    .replace(/\{\{agentName\}\}/g, replacements.agentName || "")
    .replace(/\{\{userName\}\}/g, replacements.userName || "");
  fs.writeFileSync(targetPath, filled, "utf-8");
}

function ensureBuiltInAgentOrder(prefsPath: string, agentsDir: string): void {
  const prefs = readJsonFile(prefsPath);
  const existingOrder: string[] = Array.isArray(prefs.agentOrder) ? prefs.agentOrder.filter(Boolean).map(String) : [];
  const known = new Set(existingOrder);
  let changed = false;

  for (const spec of BUILT_IN_AGENT_SPECS) {
    const configPath = path.join(agentsDir, spec.id, "config.yaml");
    if (!fs.existsSync(configPath) || known.has(spec.id)) continue;
    existingOrder.push(spec.id);
    known.add(spec.id);
    changed = true;
  }

  if (!prefs.primaryAgent) {
    prefs.primaryAgent = "lynn";
    changed = true;
  }

  if (!changed) return;
  prefs.agentOrder = existingOrder;
  writeJsonFile(prefsPath, prefs);
}

/**
 * 同步 skills2set/ → ~/.lynn/skills/
 * 每次启动都跑，确保新增/更新的 skill 能同步到用户目录
 */
function syncSkills(srcDir: string, dstDir: string): void {
  fs.mkdirSync(dstDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

    const skillSrc = path.join(srcDir, entry.name);
    const skillDst = path.join(dstDir, entry.name);

    // 只要源里有 SKILL.md 就同步整个目录
    if (!fs.existsSync(path.join(skillSrc, "SKILL.md"))) continue;

    try {
      safeCopyDir(skillSrc, skillDst);
    } catch (err) {
      errorBus.report(new AppError('SKILL_SYNC_FAILED', {
        cause: err instanceof Error ? err : new Error(String(err)),
        context: { skill: entry.name },
      }));
      // Continue with other skills, don't abort
    }
  }
}

function parseSkillName(skillMdPath: string, fallbackName: string): string {
  try {
    const content = fs.readFileSync(skillMdPath, "utf-8");
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    const nameMatch = fmMatch?.[1]?.match(/^name:\s*(.+)$/m);
    const parsed = nameMatch?.[1]?.trim().replace(/^["']|["']$/g, "");
    return parsed || fallbackName;
  } catch {
    return fallbackName;
  }
}

function skillRequiresUserCredentials(skillMdPath: string): boolean {
  try {
    const content = fs.readFileSync(skillMdPath, "utf-8");
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    const parsed = (fmMatch ? (YAML.load(fmMatch[1]) || {}) : {}) as JsonObject;
    const metadata = parsed?.metadata && typeof parsed.metadata === "object" ? parsed.metadata : {};
    const providers = [
      metadata?.clawdbot,
      metadata?.openclaw,
      metadata?.hana,
      parsed,
    ];
    const explicitEnvRequirement = providers.some((entry: JsonObject | undefined) => {
      const env = entry?.requires?.env;
      return Array.isArray(env) && env.some(Boolean);
    });
    if (explicitEnvRequirement) return true;

    const body = fmMatch ? content.slice(fmMatch[0].length) : content;
    if (/\b[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN)\b/.test(body)) return true;
    if (/Needs env:/i.test(body)) return true;
    return false;
  } catch {
    return false;
  }
}

function collectBundledSkillInfo(skillsDir: string): Map<string, SkillInfo> {
  const info = new Map<string, SkillInfo>();
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;
      const record = {
        dirName: entry.name,
        name: parseSkillName(skillMdPath, entry.name),
        requiresCredentials: skillRequiresUserCredentials(skillMdPath),
      };
      info.set(entry.name, record);
      info.set(record.name, record);
    }
  } catch {}
  return info;
}

function seedRecommendedSkills(agentsDir: string, skillsDir: string): void {
  const availableSkillInfo = collectBundledSkillInfo(skillsDir);
  const recommended = RECOMMENDED_DEFAULT_SKILLS.filter((name) => {
    const record = availableSkillInfo.get(name);
    return record && !record.requiresCredentials;
  });
  if (recommended.length === 0) return;

  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const configPath = path.join(agentsDir, entry.name, "config.yaml");
    if (!fs.existsSync(configPath)) continue;

    try {
      const cfg = loadYamlObject(configPath);
      cfg.skills = cfg.skills || {};
      if (cfg.skills._recommended_seeded === true) continue;

      const currentEnabled = Array.isArray(cfg.skills.enabled) ? cfg.skills.enabled.filter(Boolean).map(String) : [];
      const looksUnseeded = currentEnabled.length === 0
        || (currentEnabled.length === 1 && currentEnabled[0] === "quiet-musing");
      if (!looksUnseeded) {
        cfg.skills._recommended_seeded = true;
        fs.writeFileSync(configPath, YAML.dump(cfg, YAML_DUMP_OPTIONS), "utf-8");
        continue;
      }

      cfg.skills.enabled = [...new Set([...currentEnabled, ...recommended])];
      cfg.skills._recommended_seeded = true;
      fs.writeFileSync(configPath, YAML.dump(cfg, YAML_DUMP_OPTIONS), "utf-8");
    } catch {}
  }
}

function hasStockAnalysisUserData(): boolean {
  const root = path.join(os.homedir(), ".clawdbot", "skills", "stock-analysis");
  return fs.existsSync(path.join(root, "portfolios.json"))
    || fs.existsSync(path.join(root, "watchlist.json"));
}

function unseedDeprecatedRecommendedSkills(agentsDir: string): void {
  const deprecated = new Set(["stock-analysis"]);
  if (deprecated.size === 0 || hasStockAnalysisUserData()) return;

  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const configPath = path.join(agentsDir, entry.name, "config.yaml");
    if (!fs.existsSync(configPath)) continue;

    try {
      const cfg = loadYamlObject(configPath);
      const enabled = Array.isArray(cfg?.skills?.enabled) ? cfg.skills.enabled.filter(Boolean).map(String) : [];
      if (enabled.length === 0) continue;

      const nextEnabled = enabled.filter((name: string) => !deprecated.has(name));
      if (nextEnabled.length === enabled.length) continue;

      cfg.skills = cfg.skills || {};
      cfg.skills.enabled = nextEnabled;
      fs.writeFileSync(configPath, YAML.dump(cfg, YAML_DUMP_OPTIONS), "utf-8");
    } catch {}
  }
}
