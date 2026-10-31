import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createInstallSkillTool } from '../lib/tools/install-skill.js';
let agentDir: string;
beforeEach(() => { agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lynn-skill-auth-')); });
afterEach(() => fs.rmSync(agentDir, { recursive: true, force: true }));
const params = { skill_name: 'approved-skill', skill_content: '---\nname: approved-skill\ndescription: a test skill\n---\nExplain the requested file.', reason: 'Requested task', user_requested: true };
function makeTool(authorize?: (request: any) => Promise<boolean>) {
  return createInstallSkillTool({ agentDir, getConfig: () => ({ capabilities: { learn_skills: { enabled: true, safety_review: false } } }), resolveUtilityConfig: () => null, authorize });
}
it('does not trust model-provided approval flags without a backend authorization callback', async () => {
  const result = await makeTool().execute('call', params);
  expect(result.isError).toBe(true);
  expect(fs.existsSync(path.join(agentDir, 'learned-skills'))).toBe(false);
});
it('leaves the persistent directory untouched when approval is denied', async () => {
  const authorize = vi.fn(async () => false);
  expect((await makeTool(authorize).execute('call', params)).isError).toBe(true);
  expect(authorize).toHaveBeenCalledOnce();
  expect(fs.readdirSync(agentDir)).toEqual([]);
});
it('installs the requested skill after explicit backend approval', async () => {
  const authorize = vi.fn(async () => true);
  const result = await makeTool(authorize).execute('call', params);
  expect(result.isError).not.toBe(true);
  expect(authorize).toHaveBeenCalledOnce();
  expect(fs.readFileSync(path.join(agentDir, 'learned-skills/approved-skill/SKILL.md'), 'utf8')).toContain('Explain the requested file.');
});
