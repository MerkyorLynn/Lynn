import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createFsRoute } from '../server/routes/fs.js';
import { isSensitiveFilePath } from '../shared/sensitive-file-path.js';
let root: string, home: string, workspace: string, app: Hono;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lynn-fs-read-'));
  home = path.join(root, 'custom-home'); workspace = path.join(root, 'workspace');
  fs.mkdirSync(home); fs.mkdirSync(workspace);
  app = new Hono(); app.route('/api', createFsRoute({ lynnHome: home, config: { last_cwd: workspace, cwd_history: [workspace] }, getPreferences: () => ({ home_folder: workspace }) }));
});
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
it('continues to preview workspace files but blocks secrets in custom data homes', async () => {
  const regular = path.join(workspace, 'note.md'); fs.writeFileSync(regular, 'public text');
  expect(await (await app.request('/api/fs/read?path=' + encodeURIComponent(regular))).text()).toBe('public text');
  const secret = path.join(home, 'preferences.json'); fs.writeFileSync(secret, '{"client_agent_secret":"fixture"}');
  for (const endpoint of ['read', 'read-base64', 'docx-html']) expect((await app.request('/api/fs/' + endpoint + '?path=' + encodeURIComponent(secret))).status).toBe(403);
});
it('rejects a leaf symlink swapped after canonical path authorization', async () => {
  const regular = path.join(fs.realpathSync(workspace), 'note.md'), secret = path.join(root, 'private.txt');
  fs.writeFileSync(regular, 'public'); fs.writeFileSync(secret, 'private');
  const original = fs.openSync;
  let swapped = false;
  vi.spyOn(fs, 'openSync').mockImplementation(((file: any, ...args: any[]) => {
    if (String(file) === regular) { swapped = true; fs.unlinkSync(regular); fs.symlinkSync(secret, regular); }
    return (original as any)(file, ...args);
  }) as any);
  const result = await app.request('/api/fs/read?path=' + encodeURIComponent(regular));
  expect(swapped).toBe(true);
  expect(result.status).toBe(403); expect(await result.text()).not.toContain('private');
});
it('rejects oversized text before reading it into memory', async () => {
  const large = path.join(workspace, 'large.log'); const fd = fs.openSync(large, 'w'); fs.ftruncateSync(fd, 9 * 1024 * 1024); fs.closeSync(fd);
  expect((await app.request('/api/fs/read?path=' + encodeURIComponent(large))).status).toBe(413);
});
it.each(['C:\\Users\\Tester\\.SSH\\id_ed25519', 'C:\\Users\\Tester\\.aws\\credentials', '/home/test/.lynn/preferences.json', '/home/test/.lynn-engine/providers/a.json'])('recognizes sensitive paths on both platforms: %s', file => expect(isSensitiveFilePath(file)).toBe(true));
