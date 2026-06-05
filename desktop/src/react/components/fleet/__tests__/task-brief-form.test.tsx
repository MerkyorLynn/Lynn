import { describe, expect, it } from 'vitest';
import { agentOptionLabel, buildFleetDispatchPayload, externalTargetsNeedFullAccess, isExternalFleetAgent } from '../TaskBriefForm';

describe('TaskBriefForm payload', () => {
  it('omits empty image for plain code tasks', () => {
    const payload = buildFleetDispatchPayload({
      title: 'Refactor input',
      agent: 'codex-cli',
      taskType: 'code',
      image: '   ',
      approval: 'ask',
      sandbox: 'read-only',
      objective: 'Split InputArea.',
      owned: 'desktop/src/react/components/input/**',
      forbidden: 'server/**',
      tests: '',
      branch: 'fleet/input',
      worktree: 'worktrees/fleet-input',
    });

    expect(payload).not.toHaveProperty('image');
    expect(payload.taskType).toBe('code');
    expect(payload).toMatchObject({ approval: 'ask', sandbox: 'read-only' });
    expect(payload.testCommands).toEqual([]);
  });

  it('labels unavailable agents with their availability hint', () => {
    expect(agentOptionLabel({ id: 'kimi-cli', label: 'Kimi', enabled: false, availability: 'not found on PATH' })).toBe('Kimi (not found on PATH)');
    expect(agentOptionLabel({ id: 'codex-cli', label: 'Codex', enabled: true, availability: '/bin/codex' })).toBe('Codex');
  });

  it('requires explicit YOLO/full-access before launching external CLI adapters', () => {
    expect(isExternalFleetAgent('codex-cli')).toBe(true);
    expect(isExternalFleetAgent('lynn-cli')).toBe(false);
    expect(externalTargetsNeedFullAccess({
      targets: ['lynn-cli', 'codex-cli'],
      approval: 'ask',
      sandbox: 'workspace-write',
    })).toBe(true);
    expect(externalTargetsNeedFullAccess({
      targets: ['lynn-cli', 'codex-cli'],
      approval: 'yolo',
      sandbox: 'danger-full-access',
    })).toBe(false);
    expect(externalTargetsNeedFullAccess({
      targets: ['lynn-cli', 'stepfun-flash'],
      approval: 'ask',
      sandbox: 'workspace-write',
    })).toBe(false);
  });
});
