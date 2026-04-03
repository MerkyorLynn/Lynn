import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReviewRoute } from '../server/routes/review.js';

vi.mock('../hub/agent-executor.js', () => ({
  runAgentSession: vi.fn(async () => 'Review looks good.\n```json\n{"summary":"Looks good.","verdict":"pass","findings":[]}\n```'),
}));

const { runAgentSession } = await import('../hub/agent-executor.js');

function makeEngine() {
  const prefs = {};
  const agents = [
    { id: 'agent-main', name: 'Lynn Main', yuan: 'lynn', tier: 'local', hasAvatar: true },
    { id: 'agent-hanako', name: 'Hanako Review', yuan: 'hanako', tier: 'local', hasAvatar: true },
    { id: 'agent-butter', name: 'Butter Review', yuan: 'butter', tier: 'local', hasAvatar: false },
    { id: 'expert-director', name: 'Director', yuan: 'hanako', tier: 'expert', hasAvatar: false },
  ];

  return {
    currentAgentId: 'agent-main',
    currentSessionPath: '/tmp/session.jsonl',
    listAgents: () => agents,
    getAgent: (id) => {
      const agent = agents.find((item) => item.id === id);
      return {
        ...agent,
        config: {
          api: { provider: id === 'agent-butter' ? 'anthropic' : 'openai' },
          models: { chat: { id: id === 'agent-butter' ? 'claude-3-7' : 'gpt-4.1', provider: id === 'agent-butter' ? 'anthropic' : 'openai' } },
        },
        agentName: agent?.name,
      };
    },
    getPreferences: () => prefs,
    savePreferences: vi.fn((next) => Object.assign(prefs, next)),
  };
}

describe('review route', () => {
  let engine;
  let app;
  let broadcast;
  let taskRuntime;

  beforeEach(() => {
    runAgentSession.mockClear();
    engine = makeEngine();
    broadcast = vi.fn();
    taskRuntime = { createReviewFollowUpTask: vi.fn(() => ({ id: 'task-follow-up', title: '处理复查发现：Missing edge case' })) };
    app = new Hono();
    app.route('/api', createReviewRoute(engine, { broadcast, taskRuntime }));
  });

  it('lists only hanako and butter non-expert candidates', async () => {
    const res = await app.request('/api/review/agents');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.reviewers.map((item) => item.id)).toEqual(['agent-hanako', 'agent-butter']);
  });

  it('persists review config and rejects invalid reviewer binding', async () => {
    const okRes = await app.request('/api/review/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultReviewer: 'butter', butterReviewerId: 'agent-butter' }),
    });

    expect(okRes.status).toBe(200);
    const okData = await okRes.json();
    expect(okData.defaultReviewer).toBe('butter');
    expect(okData.butterReviewerId).toBe('agent-butter');

    const badRes = await app.request('/api/review/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hanakoReviewerId: 'expert-director' }),
    });

    expect(badRes.status).toBe(400);
  });

  it('uses configured hanako/butter reviewers and emits reviewer metadata', async () => {
    await app.request('/api/review/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ defaultReviewer: 'hanako', hanakoReviewerId: 'agent-hanako' }),
    });

    const res = await app.request('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: 'Check this change please.' }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.reviewerName).toBe('Hanako');
    expect(data.reviewerAgent).toBe('agent-hanako');
    expect(data.reviewerYuan).toBe('hanako');
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({
      type: 'review_start',
      sessionPath: '/tmp/session.jsonl',
      reviewerName: 'Hanako',
      reviewerAgent: 'agent-hanako',
      reviewerAgentName: 'Hanako Review',
      reviewerYuan: 'hanako',
      reviewerHasAvatar: true,
    }));
  });

  it('returns reviewer_not_configured when requested reviewer kind has no candidate', async () => {
    engine.currentAgentId = 'agent-butter';
    engine.listAgents = () => [
      { id: 'agent-butter', name: 'Butter Review', yuan: 'butter', tier: 'local', hasAvatar: false },
    ];

    const res = await app.request('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: 'Check this change please.', reviewerKind: 'butter' }),
    });

    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.code).toBe('reviewer_not_configured');
    expect(data.reviewerKind).toBe('butter');
  });

  it('emits progress and structured findings payloads', async () => {
    runAgentSession.mockResolvedValueOnce('Review found an issue.\n```json\n{"summary":"One issue found.","verdict":"concerns","findings":[{"severity":"medium","title":"Missing edge case","detail":"Nil value path is not covered.","suggestion":"Add a guard branch.","filePath":"src/review.ts"}],"nextStep":"Patch and rerun tests."}\n```');

    await app.request('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: 'Please review this patch.' }),
    });

    await Promise.resolve();
    await Promise.resolve();

    const progressStages = broadcast.mock.calls
      .map(([msg]) => msg)
      .filter((msg) => msg.type === 'review_progress')
      .map((msg) => msg.stage);
    expect(progressStages).toEqual(['packing_context', 'reviewing', 'structuring', 'done']);

    const resultMsg = broadcast.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg.type === 'review_result');
    expect(resultMsg.structured).toEqual(expect.objectContaining({
      verdict: 'concerns',
      workflowGate: 'follow_up',
      findings: [expect.objectContaining({
        severity: 'medium',
        title: 'Missing edge case',
        filePath: 'src/review.ts',
      })],
    }));
    expect(resultMsg.followUpPrompt).toContain('Review verdict: concerns');
    expect(resultMsg.followUpPrompt).toContain('Missing edge case');
    expect(resultMsg.contextPack).toEqual(expect.objectContaining({
      request: 'Please review this patch.',
      gitContext: expect.objectContaining({
        sessionFile: 'session.jsonl',
      }),
    }));
  });

  it('marks high-severity findings as hold and keeps a follow-up prompt', async () => {
    runAgentSession.mockResolvedValueOnce('Blocking issue.\n```json\n{"summary":"Unsafe write path.","verdict":"concerns","findings":[{"severity":"high","title":"Writes outside workspace","detail":"The patch can escape the repo root.","suggestion":"Clamp writes to trusted roots.","filePath":"server/routes/fs.js"}],"nextStep":"Fix guard before shipping."}\n```');

    await app.request('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: 'Review the file write guard.' }),
    });

    await Promise.resolve();
    await Promise.resolve();

    const resultMsg = broadcast.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg.type === 'review_result' && msg.structured?.summary === 'Unsafe write path.');
    expect(resultMsg.structured).toEqual(expect.objectContaining({
      verdict: 'concerns',
      workflowGate: 'hold',
      findings: [expect.objectContaining({
        severity: 'high',
        title: 'Writes outside workspace',
      })],
    }));
    expect(resultMsg.followUpPrompt).toContain('Fix guard before shipping.');
  });

  it('creates an execution task from structured findings', async () => {
    const res = await app.request('/api/review/follow-up-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        reviewId: 'review-123',
        reviewerName: 'Hanako',
        structuredReview: {
          summary: 'One issue found.',
          verdict: 'concerns',
          workflowGate: 'follow_up',
          findings: [{
            severity: 'medium',
            title: 'Missing edge case',
            detail: 'Nil value path is not covered.',
            suggestion: 'Add a guard branch.',
            filePath: 'src/review.ts',
          }],
          nextStep: 'Patch and rerun tests.',
        },
        contextPack: {
          request: 'Please review this patch.',
          workspacePath: '/Users/lynn/openhanako',
        },
        followUpPrompt: 'Review verdict: concerns',
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.task.id).toBe('task-follow-up');
    expect(taskRuntime.createReviewFollowUpTask).toHaveBeenCalledWith(expect.objectContaining({
      reviewId: 'review-123',
      reviewerName: 'Hanako',
      structuredReview: expect.objectContaining({
        workflowGate: 'follow_up',
      }),
      contextPack: expect.objectContaining({
        workspacePath: '/Users/lynn/openhanako',
      }),
    }));
    expect(taskRuntime.createReviewFollowUpTask.mock.calls[0][0].prompt).toContain('Missing edge case');
  });

  it('rejects follow-up task creation without findings', async () => {
    const res = await app.request('/api/review/follow-up-task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        structuredReview: { summary: 'Looks good.', verdict: 'pass', workflowGate: 'clear', findings: [] },
      }),
    });

    expect(res.status).toBe(400);
  });

});
