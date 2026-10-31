import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, expect, it, vi } from 'vitest';
import { PreferencesManager } from '../core/preferences-manager.js';
import { writeSessionIndex } from '../core/session-index.js';
import { wrapMcpFilePaths } from '../core/engine-tool-runtime.js';
import { isSensitiveFilePath } from '../shared/sensitive-file-path.js';
const require = createRequire(import.meta.url);
const JSZip = require('jszip');
const { extractSkillPreview } = require('../desktop/safe-zip-preview.cjs');
const roots: string[] = [];
function temp() { const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lynn-final-'))); roots.push(p); return p; }
afterEach(() => { roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })); });

it('preserves another process configuration and independent changes from stale snapshots', () => {
  const root = temp(), userDir = path.join(root, 'user'), agentsDir = path.join(root, 'agents');
  const a = new PreferencesManager({ userDir, agentsDir });
  const b = new PreferencesManager({ userDir, agentsDir });
  const one = a.getPreferences(), two = b.getPreferences();
  one.locale = 'zh'; one.desk = { trusted_roots: ['/chosen'] }; a.savePreferences(one);
  two.thinking_level = 'high'; b.savePreferences(two);
  expect(a.getPreferences()).toMatchObject({ locale: 'zh', thinking_level: 'high', desk: { trusted_roots: ['/chosen'] } });
  const old = a.getPreferences();
  b.setSandbox(false);
  old.locale = 'en'; a.savePreferences(old);
  expect(b.getPreferences()).toMatchObject({ locale: 'en', sandbox: false, thinking_level: 'high' });
  if (process.platform !== 'win32') expect(fs.statSync(path.join(userDir, 'preferences.json')).mode & 0o777).toBe(0o600);
});

it('preserves corrupt settings for recovery and rebuilds a usable file', () => {
  const root = temp(), userDir = path.join(root, 'user'); fs.mkdirSync(userDir);
  fs.writeFileSync(path.join(userDir, 'preferences.json'), '{broken');
  const prefs = new PreferencesManager({ userDir, agentsDir: path.join(root, 'agents') });
  prefs.setSandbox(true);
  expect(prefs.getSandbox()).toBe(true);
  const backup = fs.readdirSync(userDir).find(n => n.includes('.invalid.'))!;
  expect(fs.readFileSync(path.join(userDir, backup), 'utf8')).toBe('{broken');
});

it('keeps concurrent session index writes valid and leaves no shared temporary filename', async () => {
  const root = temp();
  await Promise.all(Array.from({ length: 12 }, (_, i) => writeSessionIndex(root, [{ path: path.join(root, `${i}.jsonl`) }])));
  expect(JSON.parse(fs.readFileSync(path.join(root, 'session-index.json'), 'utf8')).sessions).toHaveLength(1);
  expect(fs.readdirSync(root)).toEqual(['session-index.json']);
});

it('rejects traversal and symbolic links in ZIPs and extracts an ordinary skill', async () => {
  const root = temp(), zipPath = path.join(root, 'skill.zip');
  const good = new JSZip(); good.file('demo/SKILL.md', '# Example');
  fs.writeFileSync(zipPath, await good.generateAsync({ type: 'nodebuffer' }));
  const extracted = await extractSkillPreview(zipPath, root);
  expect(fs.readFileSync(path.join(extracted, 'demo/SKILL.md'), 'utf8')).toBe('# Example');
  for (const mode of ['traversal', 'symlink']) {
    const bad = new JSZip();
    if (mode === 'traversal') bad.file('../escaped.md', 'escape');
    else bad.file('link', '../../outside', { unixPermissions: 0o120777 });
    fs.writeFileSync(zipPath, await bad.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
    await expect(extractSkillPreview(zipPath, root)).rejects.toThrow(/unsafe/i);
  }
  expect(fs.existsSync(path.join(root, 'escaped.md'))).toBe(false);
});

it('blocks MCP file writes outside the workspace, including symlinks and custom-home credentials', async () => {
  const root = temp(), work = path.join(root, 'work'); fs.mkdirSync(work);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(work, 'link'));
  const execute = vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  const tool = wrapMcpFilePaths({ name: 'mcp__kimi-datasource__export', execute }, {
    cwd: work, workspace: work, trustedRoots: [work], agentDir: path.join(root, 'agents/main'),
    lynnHome: path.join(root, 'appdata'), sandboxEnabled: false, securityMode: 'authorized', emitEvent: () => {},
  });
  for (const file_path of ['../outside/x.csv', 'link/x.csv', '.env', path.join(root, 'appdata/user/preferences.json')]) {
    expect(await tool.execute!('bad', { params: { file_path } })).toMatchObject({ isError: true });
  }
  expect(execute).not.toHaveBeenCalled();
  await tool.execute!('good', { file_path: 'result.csv' });
  expect(execute).toHaveBeenCalledWith('good', { file_path: path.join(work, 'result.csv') });
  expect(isSensitiveFilePath(path.join(root, 'user/preferences.json'), root)).toBe(true);
});
