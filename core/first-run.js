/**
 * first-run.js — 首次运行播种
 *
 * 在 server/engine 启动之前调用，确保 ~/.lynn/ 结构存在。
 * 如果是全新安装（agents/ 为空），自动创建默认 agent。
 */

import fs from "fs";
import path from "path";
import os from "os";
import YAML from "js-yaml";
import { safeCopyDir } from '../shared/safe-fs.js';
import { AppError } from '../shared/errors.js';
import { errorBus } from '../shared/error-bus.js';
import { uniqueTrustedRoots } from '../shared/trusted-roots.js';

const RECOMMENDED_DEFAULT_SKILLS = [
  "quiet-musing",
  "find-skills",
  "summarize",
  "baidu-search",
  "brave-search",
  "tavily",
  "github",
  "notion",
  "frontend-design",
  "weather",
  "Agent Browser",
];

/**
 * 确保 ~/.lynn/ 数据目录就绪
 * @param {string} lynnHome - ~/.lynn 绝对路径
 * @param {string} productDir - 产品模板目录（lib/）
 */
export function ensureFirstRun(lynnHome, productDir) {
  // 0. 迁移旧数据目录 ~/.hanako → ~/.lynn
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
    return entry.isDirectory() && !entry.name.startsWith('.');
  });

  if (!hasAgent) {
    console.log("[first-run] 首次启动，正在创建默认助手...");
    seedDefaultAgent(agentsDir, productDir);
  }

  // 3. 同步 skills：从 skills2set/ 复制到 ~/.lynn/skills/
  const skillsSrc = path.join(productDir, "..", "skills2set");
  const skillsDst = path.join(lynnHome, "skills");
  fs.mkdirSync(skillsDst, { recursive: true });
  if (fs.existsSync(skillsSrc)) {
    syncSkills(skillsSrc, skillsDst);
    seedRecommendedSkills(agentsDir, skillsDst);
  }

  // 4. 确保可选文件存在（老用户升级 + 新 agent 都覆盖）
  const touchIfMissing = (p) => { if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf-8'); };
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
 * 从旧版 ~/.hanako 迁移到 ~/.lynn
 * 如果 ~/.lynn 已存在则跳过（用户已迁移或全新安装）
 */
function migrateFromHanako(lynnHome) {
  const defaultLynn = path.join(os.homedir(), ".lynn");
  if (lynnHome !== defaultLynn) return; // 自定义路径，不自动迁移

  const oldHome = path.join(os.homedir(), ".hanako");
  if (!fs.existsSync(oldHome)) return;
  if (fs.existsSync(defaultLynn)) return; // 新目录已存在，不覆盖

  try {
    fs.renameSync(oldHome, defaultLynn);
    console.log(`[first-run] 已迁移数据目录: ~/.hanako → ~/.lynn`);
  } catch (err) {
    console.error(`[first-run] 数据目录迁移失败 (${err.message})，将使用新目录`);
  }
}

function migrateLegacyPrimaryAgent({ agentsDir, prefsPath, productDir }) {
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

  let config;
  try {
    config = YAML.load(fs.readFileSync(configPath, "utf-8")) || {};
  } catch {
    return;
  }

  const agentName = String(config?.agent?.name || "").trim().toLowerCase();
  const yuanType = String(config?.agent?.yuan || "").trim().toLowerCase();
  const looksLikeLegacyMainAgent = agentName === "lynn" && (!yuanType || yuanType === "hanako");
  if (!looksLikeLegacyMainAgent) return;

  fs.renameSync(legacyDir, nextDir);
  normalizeMigratedLynnAgent(nextDir, productDir);

  const nextPrefs = { ...prefs, primaryAgent: nextAgentId };
  if (Array.isArray(nextPrefs.agentOrder)) {
    nextPrefs.agentOrder = nextPrefs.agentOrder.map((id) => id === legacyAgentId ? nextAgentId : id);
  }
  if (nextPrefs.review && typeof nextPrefs.review === "object") {
    if (nextPrefs.review.hanakoReviewerId === legacyAgentId) nextPrefs.review.hanakoReviewerId = null;
    if (nextPrefs.review.butterReviewerId === legacyAgentId) nextPrefs.review.butterReviewerId = null;
  }
  writeJsonFile(prefsPath, nextPrefs);

  console.log(`[first-run] 已将旧主助手 "${legacyAgentId}" 迁移为 "${nextAgentId}"`);
}

function normalizeMigratedLynnAgent(agentDir, productDir) {
  const configPath = path.join(agentDir, "config.yaml");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const cfg = YAML.load(raw) || {};
    cfg.agent = cfg.agent || {};
    if (!String(cfg.agent.name || "").trim()) cfg.agent.name = "Lynn";
    if (!String(cfg.agent.yuan || "").trim() || String(cfg.agent.yuan).trim().toLowerCase() === "hanako") {
      cfg.agent.yuan = "lynn";
    }
    fs.writeFileSync(configPath, YAML.dump(cfg, { lineWidth: 120, noRefs: true, quotingType: '"' }), "utf-8");
  } catch {}

  const lynnPublicIshiki = path.join(productDir, "public-ishiki-templates", "lynn.md");
  const publicIshikiPath = path.join(agentDir, "public-ishiki.md");
  if (!fs.existsSync(publicIshikiPath) && fs.existsSync(lynnPublicIshiki)) {
    fs.copyFileSync(lynnPublicIshiki, publicIshikiPath);
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return {};
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf-8");
}

function ensureDefaultWorkspacePrefs(prefsPath, productDir) {
  const prefs = readJsonFile(prefsPath);
  const desktopRoot = path.join(os.homedir(), 'Desktop');
  const workspacePath = path.join(desktopRoot, 'Lynn');
  const installRoot = path.resolve(productDir, '..');

  try { fs.mkdirSync(workspacePath, { recursive: true }); } catch {}

  const nextHomeFolder = String(prefs.home_folder || '').trim() || workspacePath;
  const nextTrustedRoots = uniqueTrustedRoots([
    ...(Array.isArray(prefs.trusted_roots) ? prefs.trusted_roots : []),
    installRoot,
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
 * 从模板播种默认 agent（与 engine.createAgent 相同逻辑，但纯同步、无依赖）
 */
function seedDefaultAgent(agentsDir, productDir) {
  const agentId = "lynn";
  const agentDir = path.join(agentsDir, agentId);

  // 创建目录结构
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(path.join(agentDir, "memory"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "avatars"), { recursive: true });
  fs.mkdirSync(path.join(agentDir, "desk"), { recursive: true });

  // config.yaml（模板默认值：name=Lynn, yuan=hanako）
  const configSrc = path.join(productDir, "config.example.yaml");
  if (fs.existsSync(configSrc)) {
    fs.copyFileSync(configSrc, path.join(agentDir, "config.yaml"));
  }

  // identity.md（填入默认名字）
  const identitySrc = path.join(productDir, "identity.example.md");
  if (fs.existsSync(identitySrc)) {
    const tmpl = fs.readFileSync(identitySrc, "utf-8");
    const filled = tmpl
      .replace(/\{\{agentName\}\}/g, "Lynn")
      .replace(/\{\{userName\}\}/g, "");
    fs.writeFileSync(path.join(agentDir, "identity.md"), filled, "utf-8");
  }

  // yuan 由 buildSystemPrompt 实时从 lib/yuan/ 读取，无需复制

  // ishiki.md
  const ishikiSrc = path.join(productDir, "ishiki.example.md");
  if (fs.existsSync(ishikiSrc)) {
    fs.copyFileSync(ishikiSrc, path.join(agentDir, "ishiki.md"));
  }

  // public-ishiki.md（对外意识模板，lynn 或 fallback 到 hanako）
  const publicIshikiSrc = path.join(productDir, "public-ishiki-templates", `${agentId}.md`);
  const publicIshikiFallback = path.join(productDir, "public-ishiki-templates", "hanako.md");
  const publicSrc = fs.existsSync(publicIshikiSrc) ? publicIshikiSrc : publicIshikiFallback;
  if (fs.existsSync(publicSrc)) {
    fs.copyFileSync(publicSrc, path.join(agentDir, "public-ishiki.md"));
  }

  console.log(`[first-run] 默认助手 "${agentId}" 已创建`);
}

/**
 * 同步 skills2set/ → ~/.lynn/skills/
 * 每次启动都跑，确保新增/更新的 skill 能同步到用户目录
 */
function syncSkills(srcDir, dstDir) {
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

function parseSkillName(skillMdPath, fallbackName) {
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

function collectBundledSkillNames(skillsDir) {
  const names = new Set();
  try {
    const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const skillMdPath = path.join(skillsDir, entry.name, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;
      names.add(parseSkillName(skillMdPath, entry.name));
    }
  } catch {}
  return names;
}

function seedRecommendedSkills(agentsDir, skillsDir) {
  const availableSkillNames = collectBundledSkillNames(skillsDir);
  const recommended = RECOMMENDED_DEFAULT_SKILLS.filter((name) => availableSkillNames.has(name));
  if (recommended.length === 0) return;

  const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const configPath = path.join(agentsDir, entry.name, "config.yaml");
    if (!fs.existsSync(configPath)) continue;

    try {
      const cfg = YAML.load(fs.readFileSync(configPath, "utf-8")) || {};
      cfg.skills = cfg.skills || {};
      if (cfg.skills._recommended_seeded === true) continue;

      const currentEnabled = Array.isArray(cfg.skills.enabled) ? cfg.skills.enabled.filter(Boolean) : [];
      const looksUnseeded = currentEnabled.length === 0
        || (currentEnabled.length === 1 && currentEnabled[0] === "quiet-musing");
      if (!looksUnseeded) {
        cfg.skills._recommended_seeded = true;
        fs.writeFileSync(configPath, YAML.dump(cfg, { lineWidth: 120, noRefs: true, quotingType: '"' }), "utf-8");
        continue;
      }

      cfg.skills.enabled = [...new Set([...currentEnabled, ...recommended])];
      cfg.skills._recommended_seeded = true;
      fs.writeFileSync(configPath, YAML.dump(cfg, { lineWidth: 120, noRefs: true, quotingType: '"' }), "utf-8");
    } catch {}
  }
}
