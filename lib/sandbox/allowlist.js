/**
 * allowlist.js — 安全白名单（持久 + 会话）
 *
 * 持久化规则存储在 ~/.lynn/security-allowlist.json。
 * 会话规则只保存在内存中，由 SessionAllowlist 管理。
 */

import fs from "fs";
import path from "path";

function normalizeKey(text) {
  if (typeof text !== "string") return "";
  return process.platform === "win32" ? text.toLowerCase() : text;
}

function normalizeRoot(root) {
  if (!root || typeof root !== "string") return null;
  return path.resolve(root);
}

function isInsideRoot(targetPath, rootPath) {
  const target = normalizeKey(path.resolve(targetPath));
  const root = normalizeKey(path.resolve(rootPath));
  return target === root || target.startsWith(root + path.sep);
}

function toRule(entryOrCategory, identifier, options = {}) {
  if (typeof entryOrCategory === "object" && entryOrCategory) {
    return {
      category: entryOrCategory.category,
      identifier: entryOrCategory.identifier,
      trustedRoot: normalizeRoot(entryOrCategory.trustedRoot),
    };
  }
  return {
    category: entryOrCategory,
    identifier,
    trustedRoot: normalizeRoot(options.trustedRoot),
  };
}

function ruleKey(rule) {
  return JSON.stringify({
    category: rule.category,
    identifier: rule.identifier,
    trustedRoot: rule.trustedRoot || null,
  });
}

function matchesRule(rule, query) {
  if (rule.category !== query.category || rule.identifier !== query.identifier) return false;
  if (!rule.trustedRoot) return true;
  if (!query.path) return false;
  return isInsideRoot(query.path, rule.trustedRoot);
}

function normalizeLegacyRaw(raw) {
  if (Array.isArray(raw)) {
    return raw
      .filter((entry) => entry && typeof entry.category === "string" && typeof entry.identifier === "string")
      .map((entry) => ({
        category: entry.category,
        identifier: entry.identifier,
        trustedRoot: normalizeRoot(entry.trustedRoot),
      }));
  }

  if (raw && typeof raw === "object") {
    return Object.keys(raw)
      .filter((key) => raw[key])
      .map((key) => {
        const idx = key.indexOf(":");
        return {
          category: key.slice(0, idx),
          identifier: key.slice(idx + 1),
          trustedRoot: null,
        };
      });
  }

  return [];
}

class RuleStore {
  constructor(initialRules = []) {
    this._rules = [];
    this._keys = new Set();
    for (const rule of initialRules) {
      this.add(rule);
    }
  }

  check(entryOrCategory, identifier, options = {}) {
    const query = toRule(entryOrCategory, identifier, options);
    const pathForCheck = options.path || query.identifier;
    return this._rules.some((rule) => matchesRule(rule, {
      category: query.category,
      identifier: query.identifier,
      path: pathForCheck,
    }));
  }

  add(entryOrCategory, identifier, options = {}) {
    const rule = toRule(entryOrCategory, identifier, options);
    if (!rule.category || !rule.identifier) return false;
    const key = ruleKey(rule);
    if (this._keys.has(key)) return false;
    this._keys.add(key);
    this._rules.push(rule);
    return true;
  }

  clear() {
    this._rules = [];
    this._keys.clear();
  }

  list(scope = "persistent") {
    return this._rules.map((rule) => ({
      key: ruleKey(rule),
      category: rule.category,
      identifier: rule.identifier,
      trustedRoot: rule.trustedRoot || null,
      scope,
    }));
  }

  removeByKey(key) {
    if (!this._keys.has(key)) return false;
    this._rules = this._rules.filter((rule) => ruleKey(rule) !== key);
    this._keys.delete(key);
    return true;
  }

  toJSON() {
    return this._rules.map((rule) => ({
      category: rule.category,
      identifier: rule.identifier,
      trustedRoot: rule.trustedRoot || null,
    }));
  }
}

export class SessionAllowlist extends RuleStore {
  constructor() {
    super([]);
  }

  list() {
    return super.list("session");
  }
}

export class SecurityAllowlist extends RuleStore {
  /**
   * @param {string} lynnHome  ~/.lynn 目录
   */
  constructor(lynnHome) {
    super([]);
    this._path = path.join(lynnHome, "security-allowlist.json");

    const loadedRules = SecurityAllowlist._loadFromDisk(this._path);
    for (const rule of loadedRules) {
      super.add(rule);
    }
  }

  static _loadFromDisk(filePath) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return normalizeLegacyRaw(raw);
    } catch {
      return [];
    }
  }

  add(entryOrCategory, identifier, options = {}) {
    const changed = super.add(entryOrCategory, identifier, options);
    if (changed) this._save();
    return changed;
  }

  remove(category, identifier) {
    const prefix = JSON.stringify({ category, identifier }).slice(0, -1);
    const before = this._keys.size;
    for (const item of this.list("persistent")) {
      if (item.key.startsWith(prefix)) {
        super.removeByKey(item.key);
      }
    }
    if (this._keys.size !== before) this._save();
  }

  removeByKey(key) {
    const changed = super.removeByKey(key);
    if (changed) this._save();
  }

  clear() {
    super.clear();
    this._save();
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this._path), { recursive: true });
      const tmp = `${this._path}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.toJSON(), null, 2) + "\n", "utf-8");
      fs.renameSync(tmp, this._path);
    } catch (err) {
      console.error("[allowlist] save failed:", err.message);
    }
  }
}
