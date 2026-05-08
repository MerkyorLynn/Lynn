// Brain v2 · HMAC sign verification (compatible with brain v1)
// 复用 brain v1 device store: /opt/lobster-brain/data/devices/<agentKey>.json
// 模式:relaxed — missing headers → log warn, 允许通过(兼容旧客户端 / OpenHanako)
import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const DEVICE_AUTH_WINDOW_MS = Number(process.env.DEVICE_AUTH_WINDOW_MS || 5 * 60 * 1000);
const DEVICE_NONCE_TTL_MS = Number(process.env.DEVICE_NONCE_TTL_MS || 10 * 60 * 1000);
const DEVICES_DIR = process.env.LOBSTER_DEVICES_DIR || '/opt/lobster-brain/data/devices';

const _nonceCache = new Map(); // `${agentKey}:${nonce}` → expiresAt

function deviceFilePath(key) {
  return path.join(DEVICES_DIR, `${key}.json`);
}

export async function loadDevice(key) {
  const filePath = deviceFilePath(key);
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

export function buildClientSignaturePayload({ method = 'POST', pathname = '/chat/completions', timestamp, nonce, agentKey }) {
  const normalizedMethod = String(method || 'POST').toUpperCase();
  const normalizedPath = String(pathname || '/chat/completions').trim() || '/chat/completions';
  return [
    'v1',
    normalizedMethod,
    normalizedPath,
    String(timestamp || ''),
    String(nonce || ''),
    String(agentKey || ''),
  ].join('\n');
}

export function timingSafeEqualHex(expectedHex, actualHex) {
  if (!expectedHex || !actualHex || expectedHex.length !== actualHex.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(expectedHex, 'hex'), Buffer.from(actualHex, 'hex'));
  } catch { return false; }
}

function cleanupNonces(now = Date.now()) {
  for (const [k, expiresAt] of _nonceCache.entries()) {
    if (expiresAt <= now) _nonceCache.delete(k);
  }
}

export function rememberNonce(agentKey, nonce, now = Date.now()) {
  cleanupNonces(now);
  const k = `${agentKey}:${nonce}`;
  if (_nonceCache.has(k)) return false;
  _nonceCache.set(k, now + DEVICE_NONCE_TTL_MS);
  return true;
}

export class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Verify request signature. Returns device or null.
 * Throws AuthError(401|403) for invalid/expired signatures from devices that DID sign.
 * Returns null (allowed) for missing-header relaxed mode.
 */
export async function verifySignedRequest(req, { pathname = '/v2/chat/completions', method = 'POST', log } = {}) {
  const h = req.headers || {};
  const agentKey = String(h['x-agent-key'] || '').trim();
  const timestamp = String(h['x-lynn-timestamp'] || '').trim();
  const nonce = String(h['x-lynn-nonce'] || '').trim();
  const signatureHeader = String(h['x-lynn-signature'] || '').trim();

  if (!agentKey || !timestamp || !nonce || !signatureHeader) {
    log && log('warn', 'auth missing headers from ' + (h['x-agent-key'] || (req.socket?.remoteAddress) || '?') + ' — relaxed allow');
    return null;
  }

  const parsedTs = Number(timestamp);
  if (!Number.isFinite(parsedTs)) throw new AuthError(401, 'invalid device timestamp');
  if (Math.abs(Date.now() - parsedTs) > DEVICE_AUTH_WINDOW_MS) throw new AuthError(401, 'device signature expired');
  if (!rememberNonce(agentKey, nonce)) {
    log && log('warn', 'auth nonce replayed for ' + agentKey + ' — relaxed allow');
    // brain v1 also relaxes here (signature+timestamp considered enough)
  }

  const device = await loadDevice(agentKey);
  if (!device?.secret) throw new AuthError(401, 'device not registered');
  if (device.disabled) throw new AuthError(403, 'device disabled');

  const [version, actualSig = ''] = signatureHeader.split(':', 2);
  if (version !== 'v1' || !actualSig) throw new AuthError(401, 'invalid signature version');

  const expected = crypto
    .createHmac('sha256', device.secret)
    .update(buildClientSignaturePayload({ method, pathname, timestamp, nonce, agentKey }))
    .digest('hex');

  if (!timingSafeEqualHex(expected, actualSig)) throw new AuthError(401, 'invalid device signature');

  // Update lastSeenAt async (best effort)
  device.lastSeenAt = new Date().toISOString();
  device.clientVersion = String(h['x-lynn-client-version'] || device.clientVersion || '');
  device.clientPlatform = String(h['x-lynn-client-platform'] || device.clientPlatform || '');
  device.updatedAt = device.lastSeenAt;
  // Don't await: best-effort persistence shouldn't block the request
  fsp.writeFile(deviceFilePath(agentKey), JSON.stringify(device, null, 2), "utf8").catch(() => {});

  return device;
}

// for tests
export const __testing__ = { _nonceCache };
