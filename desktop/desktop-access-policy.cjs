const path = require("path");

function safeReadJSON(fs, filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf-8")); }
  catch (err) {
    console.error(`[safeReadJSON] ${filePath}: ${err.message}`);
    return fallback;
  }
}

function createDesktopAccessPolicy({
  fs,
  os,
  yaml,
  lynnHome,
  pathPolicy,
  brainUrlPolicy,
}) {
  const {
    normalizePolicyPath,
    resolveCanonicalPath,
    isPathInsideRoot,
    uniqueCanonicalPaths,
  } = pathPolicy;
  const {
    CANONICAL_BRAIN_API_ROOT,
    CANONICAL_BRAIN_PROVIDER_BASE_URL,
    normalizeBrainUrl,
    isDeprecatedBrainApiRoot,
    isDeprecatedBrainProviderBaseUrl,
  } = brainUrlPolicy;

  const fileAccessGrants = new Map();
  const trackedGrantWebContents = new Set();

  function readUserPreferences() {
    return safeReadJSON(fs, path.join(lynnHome, "user", "preferences.json"), {}) || {};
  }

  function writeUserPreferences(nextPrefs) {
    const prefsPath = path.join(lynnHome, "user", "preferences.json");
    fs.mkdirSync(path.dirname(prefsPath), { recursive: true });
    fs.writeFileSync(prefsPath, JSON.stringify(nextPrefs, null, 2) + "\n", "utf-8");
  }

  function migrateBrainProviderStorage() {
    const providersPath = path.join(lynnHome, "added-models.yaml");
    try {
      const raw = fs.readFileSync(providersPath, "utf-8");
      const data = yaml.load(raw) || {};
      const brainProvider = data?.providers?.brain;
      if (!brainProvider || typeof brainProvider !== "object") return false;
      if (!isDeprecatedBrainProviderBaseUrl(brainProvider.base_url)) return false;
      brainProvider.base_url = CANONICAL_BRAIN_PROVIDER_BASE_URL;
      fs.writeFileSync(providersPath, yaml.dump(data, { lineWidth: 120 }), "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  function deriveBrainApiRootFromProviders() {
    try {
      const providersPath = path.join(lynnHome, "added-models.yaml");
      const raw = fs.readFileSync(providersPath, "utf-8");
      const data = yaml.load(raw) || {};
      const baseUrl = String(data?.providers?.brain?.base_url || "").trim().replace(/\/+$/, "");
      if (!baseUrl) return "";
      return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -3) : baseUrl;
    } catch {
      return "";
    }
  }

  function readBrainRuntimeConfig() {
    const migratedProviderStorage = migrateBrainProviderStorage();
    const prefs = readUserPreferences();
    let changedPrefs = false;

    const normalize = normalizeBrainUrl;
    let persistedApiRoot = normalize(prefs.brain_api_root || prefs.default_model_api_root);
    if (isDeprecatedBrainApiRoot(persistedApiRoot)) {
      persistedApiRoot = CANONICAL_BRAIN_API_ROOT;
      prefs.brain_api_root = CANONICAL_BRAIN_API_ROOT;
      if (isDeprecatedBrainApiRoot(prefs.default_model_api_root)) {
        prefs.default_model_api_root = CANONICAL_BRAIN_API_ROOT;
      }
      changedPrefs = true;
    }

    const derivedApiRoot = persistedApiRoot || deriveBrainApiRootFromProviders();
    if (!persistedApiRoot && derivedApiRoot) {
      prefs.brain_api_root = derivedApiRoot;
      changedPrefs = true;
    }

    if (migratedProviderStorage && !prefs.brain_api_root) {
      prefs.brain_api_root = CANONICAL_BRAIN_API_ROOT;
      changedPrefs = true;
    }

    if (changedPrefs) writeUserPreferences(prefs);
    return {
      apiRoot: derivedApiRoot,
      host: normalize(prefs.brain_api_host || prefs.default_model_api_host),
      legacyApiRoot: normalize(prefs.brain_legacy_api_root),
      legacyHost: normalize(prefs.brain_legacy_host),
    };
  }

  function normalizeTrustedRoot(rawPath) {
    if (typeof rawPath !== "string") return null;
    const trimmed = rawPath.trim();
    if (!trimmed || trimmed.includes("\0")) return null;
    const expanded = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.resolve(expanded);
  }

  function uniqueTrustedRoots(paths) {
    const out = [];
    const seen = new Set();
    for (const entry of paths || []) {
      const normalized = normalizeTrustedRoot(entry);
      if (!normalized) continue;
      const key = normalizePolicyPath(normalized);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(normalized);
    }
    return out;
  }

  function getDefaultDesktopRoot() {
    return path.join(os.homedir(), "Desktop");
  }

  function isLegacyDesktopWorkspaceSeed(prefs = {}, configuredRoots = null) {
    if (prefs?.setupComplete === true) return false;

    const desktopRoot = getDefaultDesktopRoot();
    const topLevelHome = normalizeTrustedRoot(prefs?.home_folder);
    const deskHome = normalizeTrustedRoot(prefs?.desk?.home_folder);
    const topLevelRoots = configuredRoots ?? uniqueTrustedRoots(
      Array.isArray(prefs?.trusted_roots) ? prefs.trusted_roots : []
    );
    const deskRoots = uniqueTrustedRoots(
      Array.isArray(prefs?.desk?.trusted_roots) ? prefs.desk.trusted_roots : []
    );

    if (deskHome || deskRoots.length > 0) return false;

    const usesDesktopHome = topLevelHome === desktopRoot;
    const usesOnlyDesktopRoots = topLevelRoots.length > 0 && topLevelRoots.every((root) => root === desktopRoot);
    const hasOnlyLegacyTopLevelRoots = topLevelRoots.length === 0 || usesOnlyDesktopRoots;

    return hasOnlyLegacyTopLevelRoots && (usesDesktopHome || usesOnlyDesktopRoots);
  }

  function getPreferredHomeFolder(prefs = {}) {
    const configured = normalizeTrustedRoot(prefs?.home_folder)
      || normalizeTrustedRoot(prefs?.desk?.home_folder);
    if (!configured) return null;
    return isLegacyDesktopWorkspaceSeed(prefs) ? null : configured;
  }

  function getConfiguredTrustedRoots(prefs = {}) {
    const configuredRoots = uniqueTrustedRoots([
      ...(Array.isArray(prefs?.trusted_roots) ? prefs.trusted_roots : []),
      ...(Array.isArray(prefs?.desk?.trusted_roots) ? prefs.desk.trusted_roots : []),
    ]);
    return isLegacyDesktopWorkspaceSeed(prefs, configuredRoots) ? [] : configuredRoots;
  }

  function getEffectiveTrustedRoots(prefs = {}) {
    return uniqueTrustedRoots([
      getPreferredHomeFolder(prefs),
      ...getConfiguredTrustedRoots(prefs),
    ]);
  }

  function getConfiguredWorkspaceRoots(config = {}, prefs = {}) {
    const history = Array.isArray(config?.cwd_history) ? config.cwd_history : [];
    return uniqueTrustedRoots([
      ...getEffectiveTrustedRoots(prefs),
      config?.last_cwd,
      ...history,
    ]);
  }

  function getCurrentAgentId() {
    const prefsPath = path.join(lynnHome, "user", "preferences.json");
    const agentsDir = path.join(lynnHome, "agents");

    try {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
      if (prefs.primaryAgent) {
        const agentDir = path.join(agentsDir, prefs.primaryAgent);
        if (fs.existsSync(path.join(agentDir, "config.yaml"))) return prefs.primaryAgent;
      }
    } catch {}

    try {
      const entries = fs.readdirSync(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && fs.existsSync(path.join(agentsDir, entry.name, "config.yaml"))) {
          return entry.name;
        }
      }
    } catch {}

    return null;
  }

  function readCurrentAgentConfig() {
    const agentId = getCurrentAgentId();
    if (!agentId) return {};
    try {
      const configPath = path.join(lynnHome, "agents", agentId, "config.yaml");
      return yaml.load(fs.readFileSync(configPath, "utf-8")) || {};
    } catch {
      return {};
    }
  }

  function listAgentRoots(subdir) {
    const agentsDir = path.join(lynnHome, "agents");
    try {
      return fs.readdirSync(agentsDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && fs.existsSync(path.join(agentsDir, entry.name, "config.yaml")))
        .map(entry => path.join(agentsDir, entry.name, subdir));
    } catch {
      return [];
    }
  }

  function getWorkspaceRoots() {
    const prefs = readUserPreferences();
    const config = readCurrentAgentConfig();
    return uniqueCanonicalPaths(getConfiguredWorkspaceRoots(config, prefs));
  }

  function getExternalSkillRoots() {
    const prefs = readUserPreferences();
    return uniqueCanonicalPaths(Array.isArray(prefs.external_skill_paths) ? prefs.external_skill_paths : []);
  }

  function getTrustedPathPolicy() {
    const workspaceRoots = getWorkspaceRoots();
    const uploadsRoots = workspaceRoots.map(root => path.join(root, ".lynn-uploads"));
    return {
      read: uniqueCanonicalPaths([
        path.join(lynnHome, "skills"),
        path.join(lynnHome, "audio"),
        ...listAgentRoots("desk"),
        ...listAgentRoots("learned-skills"),
        ...workspaceRoots,
        ...uploadsRoots,
        path.join(os.tmpdir(), ".lynn-uploads"),
        ...getExternalSkillRoots(),
      ]),
      write: uniqueCanonicalPaths([
        ...workspaceRoots,
        ...uploadsRoots,
        path.join(os.tmpdir(), ".lynn-uploads"),
      ]),
    };
  }

  function resolveGrantTarget(target) {
    if (!target) return null;
    if (typeof target.id === "number" && typeof target.send === "function") return target;
    if (target.webContents && typeof target.webContents.id === "number") return target.webContents;
    return null;
  }

  function getGrantBucket(target) {
    const webContents = resolveGrantTarget(target);
    if (!webContents) return null;
    let bucket = fileAccessGrants.get(webContents.id);
    if (!bucket) {
      bucket = { read: new Set(), write: new Set() };
      fileAccessGrants.set(webContents.id, bucket);
    }
    if (!trackedGrantWebContents.has(webContents.id)) {
      trackedGrantWebContents.add(webContents.id);
      webContents.once("destroyed", () => {
        fileAccessGrants.delete(webContents.id);
        trackedGrantWebContents.delete(webContents.id);
      });
    }
    return bucket;
  }

  function grantWebContentsAccess(target, rawPath, level = "read") {
    const canonical = resolveCanonicalPath(rawPath);
    const bucket = getGrantBucket(target);
    if (!canonical || !bucket) return null;
    bucket.read.add(canonical);
    if (level === "write" || level === "readwrite") bucket.write.add(canonical);
    return canonical;
  }

  function hasGrantedAccess(target, canonicalPath, mode) {
    const webContents = resolveGrantTarget(target);
    if (!webContents) return false;
    const bucket = fileAccessGrants.get(webContents.id);
    if (!bucket) return false;

    const candidates = mode === "write"
      ? [...bucket.write]
      : [...bucket.read, ...bucket.write];
    return candidates.some(root => isPathInsideRoot(canonicalPath, root));
  }

  function hasTrustedAccess(canonicalPath, mode) {
    const policy = getTrustedPathPolicy();
    const roots = mode === "write" ? policy.write : policy.read;
    return roots.some(root => isPathInsideRoot(canonicalPath, root));
  }

  function canAccessPath(target, rawPath, mode = "read") {
    const canonical = resolveCanonicalPath(rawPath);
    if (!canonical) return { allowed: false, canonical: null };
    return {
      allowed: hasTrustedAccess(canonical, mode) || hasGrantedAccess(target, canonical, mode),
      canonical,
    };
  }

  function isSetupComplete() {
    const prefsPath = path.join(lynnHome, "user", "preferences.json");
    try {
      const prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8"));
      if (prefs.setupComplete === true) return true;
    } catch {}

    try {
      const agentsDir = path.join(lynnHome, "agents");
      const agents = fs.readdirSync(agentsDir, { withFileTypes: true });
      for (const entry of agents) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const sessDir = path.join(agentsDir, entry.name, "sessions");
        if (!fs.existsSync(sessDir)) continue;
        const sessions = fs.readdirSync(sessDir).filter(f => f.endsWith(".jsonl"));
        if (sessions.length > 0) {
          try {
            let prefs = {};
            try { prefs = JSON.parse(fs.readFileSync(prefsPath, "utf-8")); } catch {}
            prefs.setupComplete = true;
            fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2) + "\n", "utf-8");
            console.log("[desktop] 检测到已有 session，自动标记 setupComplete");
          } catch {}
          return true;
        }
      }
    } catch {}

    return false;
  }

  function hasExistingConfig() {
    try {
      const agentId = getCurrentAgentId();
      if (!agentId) return false;
      const configPath = path.join(lynnHome, "agents", agentId, "config.yaml");
      const configText = fs.readFileSync(configPath, "utf-8");

      if (/api_key:\s*["']?[^"'\s]+/.test(configText)) return true;

      const parsedConfig = yaml.load(configText) || {};
      const currentProvider = String(parsedConfig?.api?.provider || "").trim();

      const providersPath = path.join(lynnHome, "added-models.yaml");
      const providersRaw = fs.readFileSync(providersPath, "utf-8");
      const providersData = yaml.load(providersRaw) || {};
      const providers = providersData?.providers || {};
      const hasProviderKey = (entry) => typeof entry?.api_key === "string" && String(entry.api_key).trim().length > 0;

      if (currentProvider && hasProviderKey(providers[currentProvider])) return true;
      return Object.values(providers).some(hasProviderKey);
    } catch {}
    return false;
  }

  return {
    readUserPreferences,
    writeUserPreferences,
    readBrainRuntimeConfig,
    getCurrentAgentId,
    readCurrentAgentConfig,
    grantWebContentsAccess,
    canReadPath: (target, rawPath) => canAccessPath(target, rawPath, "read"),
    canWritePath: (target, rawPath) => canAccessPath(target, rawPath, "write"),
    resolveCanonicalPath,
    isPathInsideRoot,
    isSetupComplete,
    hasExistingConfig,
  };
}

module.exports = { createDesktopAccessPolicy, safeReadJSON };
