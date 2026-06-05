import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadBrainEnvFiles } from '../env-loader.js';

const tmpDirs = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynn-brain-env-'));
  tmpDirs.push(dir);
  return dir;
}

describe('brain env loader', () => {
  it('loads explicit, user, and cwd env files without overriding existing env', () => {
    const dir = makeTmpDir();
    const home = path.join(dir, 'home');
    const cwd = path.join(dir, 'cwd');
    fs.mkdirSync(path.join(home, '.lynn'), { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    const explicit = path.join(dir, 'explicit.env');
    fs.writeFileSync(explicit, 'STEP37_KEY=from-explicit\nKEEP=explicit\n');
    fs.writeFileSync(path.join(home, '.lynn', 'brain.env'), 'ZHIPU_KEY="from-user"\nKEEP=user\n');
    fs.writeFileSync(path.join(cwd, '.env'), "DEEPSEEK_KEY='from-cwd'\n");

    const env = { BRAIN_V2_ENV_FILE: explicit, KEEP: 'shell' };
    const result = loadBrainEnvFiles({ cwd, env, homeDir: home });

    expect(result.files).toEqual([
      path.resolve(explicit),
      path.resolve(path.join(home, '.lynn', 'brain.env')),
      path.resolve(path.join(cwd, '.env')),
    ]);
    expect(env.STEP37_KEY).toBe('from-explicit');
    expect(env.ZHIPU_KEY).toBe('from-user');
    expect(env.DEEPSEEK_KEY).toBe('from-cwd');
    expect(env.KEEP).toBe('shell');
  });

  it('maps legacy provider env names when the canonical key is missing', () => {
    const env = {
      STEP_KEY: 'legacy-step',
      STEP_BASE: 'https://legacy-step.example/v1',
      STEP_TEXT_MODEL: 'step-legacy',
    };

    const result = loadBrainEnvFiles({ env, paths: [] });

    expect(env.STEP37_KEY).toBe('legacy-step');
    expect(env.STEP37_BASE).toBe('https://legacy-step.example/v1');
    expect(env.STEP37_MODEL).toBe('step-legacy');
    expect(result.aliases).toEqual(expect.arrayContaining([
      'STEP_KEY->STEP37_KEY',
      'STEP_BASE->STEP37_BASE',
      'STEP_TEXT_MODEL->STEP37_MODEL',
    ]));
  });
});
