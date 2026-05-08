import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Use isolated tmp devices dir
const TMP_DIR = path.join(os.tmpdir(), 'brain-v2-auth-test-' + Date.now());
process.env.LOBSTER_DEVICES_DIR = TMP_DIR;

const auth = await import('../auth.js');
const { verifySignedRequest, buildClientSignaturePayload, timingSafeEqualHex, rememberNonce, AuthError, __testing__ } = auth;

const TEST_KEY = 'ak_test123';
const TEST_SECRET = 'aabbccdd11223344';

async function setupDevice({ disabled = false } = {}) {
  await fsp.mkdir(TMP_DIR, { recursive: true });
  await fsp.writeFile(
    path.join(TMP_DIR, TEST_KEY + '.json'),
    JSON.stringify({ key: TEST_KEY, secret: TEST_SECRET, disabled }, null, 2),
  );
}

function makeReq({ ts = Date.now(), nonce = 'n-' + Math.random(), key = TEST_KEY, secret = TEST_SECRET, pathname = '/v2/chat/completions', method = 'POST', omit = [] } = {}) {
  const payload = buildClientSignaturePayload({ method, pathname, timestamp: ts, nonce, agentKey: key });
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const headers = {
    'x-agent-key': key,
    'x-lynn-timestamp': String(ts),
    'x-lynn-nonce': nonce,
    'x-lynn-signature': 'v1:' + sig,
  };
  for (const k of omit) delete headers[k];
  return { headers, socket: { remoteAddress: '127.0.0.1' } };
}

beforeEach(async () => {
  __testing__._nonceCache.clear();
  try { await fsp.rm(TMP_DIR, { recursive: true, force: true }); } catch {}
});

describe('buildClientSignaturePayload', () => {
  it('builds canonical payload joined by newlines', () => {
    const p = buildClientSignaturePayload({ method: 'post', pathname: '/x', timestamp: 1, nonce: 'n', agentKey: 'k' });
    expect(p).toBe('v1\nPOST\n/x\n1\nn\nk');
  });
  it('uppercases method and trims pathname', () => {
    const p = buildClientSignaturePayload({ method: 'post', pathname: ' /a ', timestamp: 1, nonce: 'n', agentKey: 'k' });
    expect(p).toContain('POST');
    expect(p).toContain('/a');
  });
});

describe('timingSafeEqualHex', () => {
  it('matches identical hex', () => expect(timingSafeEqualHex('aabb', 'aabb')).toBe(true));
  it('rejects different lengths', () => expect(timingSafeEqualHex('aabb', 'aabbcc')).toBe(false));
  it('rejects different values', () => expect(timingSafeEqualHex('aabb', 'aacc')).toBe(false));
  it('rejects empty', () => expect(timingSafeEqualHex('', '')).toBe(false));
  it('rejects different-length hex inputs', () => expect(timingSafeEqualHex('aa', 'aabb')).toBe(false));
});

describe('rememberNonce', () => {
  it('first call returns true (nonce unique)', () => expect(rememberNonce('a', 'n1')).toBe(true));
  it('replay returns false', () => {
    rememberNonce('a', 'n1');
    expect(rememberNonce('a', 'n1')).toBe(false);
  });
  it('different keys with same nonce both succeed', () => {
    expect(rememberNonce('a', 'shared')).toBe(true);
    expect(rememberNonce('b', 'shared')).toBe(true);
  });
});

describe('verifySignedRequest (happy path)', () => {
  it('returns device on valid signature', async () => {
    await setupDevice();
    const req = makeReq();
    const device = await verifySignedRequest(req);
    expect(device.key).toBe(TEST_KEY);
  });

  it('relaxed: returns null when no headers (missing-headers allow)', async () => {
    const req = { headers: {}, socket: { remoteAddress: '1.2.3.4' } };
    const device = await verifySignedRequest(req, { log: () => {} });
    expect(device).toBe(null);
  });
});

describe('verifySignedRequest (failure modes)', () => {
  it('throws 401 on expired timestamp (>5min drift)', async () => {
    await setupDevice();
    const req = makeReq({ ts: Date.now() - 10 * 60 * 1000 });
    await expect(verifySignedRequest(req)).rejects.toThrowError(/expired/);
  });

  it('throws 401 on invalid (non-numeric) timestamp', async () => {
    await setupDevice();
    const req = makeReq();
    req.headers['x-lynn-timestamp'] = 'bogus';
    await expect(verifySignedRequest(req)).rejects.toThrowError(/invalid device timestamp/);
  });

  it('throws 401 when device not registered', async () => {
    // no device file exists
    const req = makeReq({ key: 'ak_unknown' });
    await expect(verifySignedRequest(req)).rejects.toThrowError(/not registered/);
  });

  it('throws 403 when device disabled', async () => {
    await setupDevice({ disabled: true });
    const req = makeReq();
    await expect(verifySignedRequest(req)).rejects.toThrowError(/disabled/);
  });

  it('throws 401 on signature version mismatch', async () => {
    await setupDevice();
    const req = makeReq();
    req.headers['x-lynn-signature'] = 'v2:badsig';
    await expect(verifySignedRequest(req)).rejects.toThrowError(/invalid signature version/);
  });

  it('throws 401 on signature mismatch', async () => {
    await setupDevice();
    const req = makeReq();
    req.headers['x-lynn-signature'] = 'v1:0000000000000000000000000000000000000000000000000000000000000000';
    await expect(verifySignedRequest(req)).rejects.toThrowError(/invalid device signature/);
  });

  it('relaxes nonce replay (allows but logs)', async () => {
    await setupDevice();
    const req1 = makeReq({ nonce: 'replay-test' });
    await verifySignedRequest(req1);
    await new Promise(r => setTimeout(r, 80));  // wait for fire-and-forget device writeFile
    // Use new req with same nonce but fresh timestamp + sig
    const req2 = makeReq({ nonce: 'replay-test' });
    const device = await verifySignedRequest(req2, { log: () => {} });
    expect(device.key).toBe(TEST_KEY);  // relaxed: still allowed
  });
});

describe('AuthError', () => {
  it('carries status code', () => {
    const e = new AuthError(403, 'no');
    expect(e.status).toBe(403);
    expect(e.message).toBe('no');
  });
});
