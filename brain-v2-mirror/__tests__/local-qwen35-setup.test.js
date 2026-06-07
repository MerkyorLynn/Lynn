import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LOCAL_QWEN35_RUNTIME_POLICY,
  getLocalQwen35Plan,
  isLocalAddress,
  startLocalQwen35Setup,
} from '../local-qwen35-setup.js';

describe('local Qwen3.5-9B setup bridge', () => {
  it('requires explicit user authorization before install/download/start', () => {
    const result = startLocalQwen35Setup({ authorized: false });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('missing_user_authorization');
    expect(result.runtime_policy).toEqual(LOCAL_QWEN35_RUNTIME_POLICY);
  });

  it('treats only loopback clients as local', () => {
    expect(isLocalAddress('127.0.0.1')).toBe(true);
    expect(isLocalAddress('::1')).toBe(true);
    expect(isLocalAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLocalAddress('192.168.1.10')).toBe(false);
  });

  it('plans local 9B as opt-in and falls back to StepFun when bootstrap is missing', async () => {
    const oldBootstrap = process.env.LYNN_QWEN35_BOOTSTRAP;
    process.env.LYNN_QWEN35_BOOTSTRAP = path.join(os.tmpdir(), `missing-qwen35-${Date.now()}.py`);
    try {
      const result = await getLocalQwen35Plan();
      expect(result.ok).toBe(false);
      expect(result.error).toBe('bootstrap_not_found');
      expect(result.fallback_provider).toBe('step-3.7-flash');
      expect(result.runtime_policy).toEqual(LOCAL_QWEN35_RUNTIME_POLICY);
      expect(LOCAL_QWEN35_RUNTIME_POLICY.warm_pool_default).toBe(false);
      expect(LOCAL_QWEN35_RUNTIME_POLICY.idle_unload).toBe(true);
      expect(LOCAL_QWEN35_RUNTIME_POLICY.tool_schema_limit).toBeLessThanOrEqual(5);
    } finally {
      if (oldBootstrap === undefined) delete process.env.LYNN_QWEN35_BOOTSTRAP;
      else process.env.LYNN_QWEN35_BOOTSTRAP = oldBootstrap;
    }
  });
});
