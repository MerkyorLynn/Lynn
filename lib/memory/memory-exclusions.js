import fs from "fs";
import path from "path";

function normalizePhrase(value) {
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

export class MemoryExclusions {
  constructor({ filePath }) {
    this._filePath = filePath;
    this._data = null;
  }

  _load() {
    if (this._data) return this._data;
    const raw = safeReadJson(this._filePath, null);
    this._data = {
      phrases: Array.isArray(raw?.phrases)
        ? [...new Set(raw.phrases.map((item) => normalizePhrase(item)).filter(Boolean))]
        : [],
    };
    return this._data;
  }

  _save() {
    const data = this._load();
    fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
    fs.writeFileSync(this._filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  list() {
    const data = this._load();
    return { phrases: [...data.phrases] };
  }

  addPhrase(phrase) {
    const normalized = normalizePhrase(phrase);
    if (!normalized) return false;
    const data = this._load();
    if (data.phrases.includes(normalized)) return false;
    data.phrases.push(normalized);
    this._save();
    return true;
  }

  removePhrase(phrase) {
    const normalized = normalizePhrase(phrase);
    const data = this._load();
    const next = data.phrases.filter((item) => item !== normalized);
    if (next.length === data.phrases.length) return false;
    data.phrases = next;
    this._save();
    return true;
  }

  matchesFact(entry) {
    const data = this._load();
    if (data.phrases.length === 0) return false;
    const haystack = [
      entry?.fact || "",
      ...(Array.isArray(entry?.tags) ? entry.tags : []),
      entry?.evidence || "",
    ].join(" ").toLowerCase();
    return data.phrases.some((phrase) => haystack.includes(phrase.toLowerCase()));
  }
}
