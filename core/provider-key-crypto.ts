// provider-key-crypto.ts — stable local encryption for BYOK provider API keys.
//
// WHY (#74): the old scheme derived the AES key from `os.hostname()`. On macOS without an
// explicit HostName, `os.hostname()` drifts (DHCP / `.local` name changes per network, or a
// name collision turns "Foo" into "Foo-2"). When it drifts, previously-encrypted API keys can
// no longer be decrypted → the provider settings look "reset" every launch and models stop
// replying. (Windows hostnames are stable, which is why it only reproduced on macOS.)
//
// FIX: derive from a random seed persisted once in the data dir, so the key is stable across
// launches, networks, and machine renames. Decryption falls back to the legacy hostname key so
// installs whose hostname is still stable keep their keys and migrate to the seed on next save.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const ENC_ALGO = "aes-256-gcm";
const ENC_SALT = "hanako-provider-keys-v1"; // unchanged → legacy ciphertext stays derivable
const SEED_FILE = ".provider-key-seed";

function resolveLynnHome(lynnHome?: string): string {
  const explicit = typeof lynnHome === "string" ? lynnHome.trim() : "";
  const raw = explicit || (process.env.LYNN_HOME || "").trim();
  if (raw) return path.resolve(raw.replace(/^~/, os.homedir()));
  return path.join(os.homedir(), ".lynn");
}

const _seedMaterialByHome = new Map<string, string>();
const _derivedKeys = new Map<string, Buffer>();
function stableSeedMaterial(lynnHome?: string): string {
  const home = resolveLynnHome(lynnHome);
  const cached = _seedMaterialByHome.get(home);
  if (cached) return cached;
  const seedPath = path.join(home, SEED_FILE);
  try {
    const hex = fs.readFileSync(seedPath, "utf-8").trim();
    if (/^[0-9a-f]{64}$/i.test(hex)) { _seedMaterialByHome.set(home, hex); return hex; }
  } catch { /* missing → create below */ }
  const seed = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(seedPath), { recursive: true });
    fs.writeFileSync(seedPath, seed, { encoding: "utf-8", mode: 0o600 });
    try { fs.chmodSync(seedPath, 0o600); } catch { /* best-effort */ }
    _seedMaterialByHome.set(home, seed);
    return seed;
  } catch {
    // Can't persist a seed (read-only data dir) → fall back to a deterministic, machine-stable
    // material instead of an ephemeral random one, so the key still doesn't drift between launches.
    const fallback = `lynn-stable-key:${home}:${os.userInfo().username}`;
    _seedMaterialByHome.set(home, fallback);
    return fallback;
  }
}

function deriveStableKey(lynnHome?: string): Buffer {
  const seed = stableSeedMaterial(lynnHome);
  const cached = _derivedKeys.get(seed);
  if (cached) return cached;
  const key = crypto.pbkdf2Sync(seed, ENC_SALT, 100000, 32, "sha256");
  _derivedKeys.set(seed, key);
  return key;
}

// Legacy key (pre-fix) — only used to decrypt old ciphertext on installs whose hostname is
// still the one used at encryption time, so they migrate without re-entering keys.
function deriveLegacyKey(): Buffer {
  const material = `${os.hostname()}:${os.userInfo().username}`;
  return crypto.pbkdf2Sync(material, ENC_SALT, 100000, 32, "sha256");
}

export function encryptApiKey(plaintext: string, lynnHome?: string): string {
  if (!plaintext) return plaintext;
  try {
    const key = deriveStableKey(lynnHome);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ENC_ALGO, key, iv);
    let enc = cipher.update(plaintext, "utf8", "hex");
    enc += cipher.final("hex");
    const tag = cipher.getAuthTag().toString("hex");
    return `enc:${iv.toString("hex")}:${tag}:${enc}`;
  } catch {
    throw new Error("Unable to encrypt provider credential; nothing was saved");
  }
}

export function decryptApiKey(stored: string | undefined, lynnHome?: string): string {
  // non-enc values are plaintext from before encryption existed — return as-is
  if (!stored || typeof stored !== "string" || !stored.startsWith("enc:")) return stored || "";
  const parts = stored.split(":");
  if (parts.length !== 4) return "";
  const [, ivHex, tagHex, encHex] = parts;
  for (const key of [deriveStableKey(lynnHome), deriveLegacyKey()]) {
    try {
      const decipher = crypto.createDecipheriv(ENC_ALGO, key, Buffer.from(ivHex, "hex"));
      decipher.setAuthTag(Buffer.from(tagHex, "hex"));
      let dec = decipher.update(encHex, "hex", "utf8");
      dec += decipher.final("utf8");
      return dec;
    } catch { /* try the legacy key, then give up */ }
  }
  return ""; // undecryptable (key drifted before the fix) → treat as missing, user re-enters once
}

// exposed for tests / diagnostics
export const __test = { deriveStableKey, deriveLegacyKey, stableSeedMaterial };
