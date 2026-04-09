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
    _agents: agents,
    currentAgentId: 'agent-main',
    currentSessionPath: '/tmp/session.jsonl',
    currentModel: { id: 'step-3.5-flash-2603', name: 'Step 3.5 Flash 2603', provider: 'brain' },
    availableModels: [
      { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'openai' },
      { id: 'claude-3-7', name: 'Claude 3.7', provider: 'anthropic' },
      { id: 'step-3.5-flash-2603', name: 'Step 3.5 Flash 2603', provider: 'brain' },
    ],
    listAgents: () => agents,
    invalidateAgentListCache: vi.fn(),
    resolveUtilityConfig: () => ({
      utility_large: 'step-3.5-flash-2603',
      utility_large_provider: 'brain',
      utility_large_fallbacks: [],
      utility: 'gpt-4.1',
      utility_provider: 'openai',
      utility_fallbacks: [],
    }),
    getAgent: (id) => {
      const agent = agents.find((item) => item.id === id);
      return {
        ...agent,
        config: {
          agent: {
            name: agent?.name,
            yuan: agent?.yuan,
            tier: agent?.tier,
          },
          api: { provider: id === 'agent-butter' ? 'anthropic' : 'openai' },
          models: { chat: { id: id === 'agent-butter' ? 'claude-3-7' : 'gpt-4.1', provider: id === 'agent-butter' ? 'anthropic' : 'openai' } },
        },
        agentName: agent?.name,
        updateConfig: vi.fn((partial) => {
          if (!agent) return;
          if (partial?.agent?.yuan) agent.yuan = partial.agent.yuan;
          if (partial?.agent?.tier) agent.tier = partial.agent.tier;
          if (partial?.agent?.name) agent.name = partial.agent.name;
        }),
      };
    },
    getPreferences: () => prefs,
    savePreferences: vi.fn((next) => Object.assign(prefs, next)),
    createAgent: vi.fn(async ({ name, yuan }) => {
      const id = `agent-${yuan}-${agents.length + 1}`;
      const agent = { id, name, yuan, tier: 'local', hasAvatar: false };
      agents.push(agent);
      return { id, name };
    }),
    ensureAgentLoaded: vi.fn(async (id) => {
      const agent = agents.find((item) => item.id === id);
      return agent ? { id: agent.id } : null;
    }),
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
    const reviewOpts = runAgentSession.mock.calls[0][2];
    expect(reviewOpts.signal).toBeInstanceOf(AbortSignal);
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

  it('bootstraps a missing reviewer agent when the requested reviewer kind has no candidate', async () => {
    engine.currentAgentId = 'agent-butter';
    engine._agents.splice(0, engine._agents.length, ...[
      { id: 'agent-butter', name: 'Butter Review', yuan: 'butter', tier: 'local', hasAvatar: false },
    ]);

    const res = await app.request('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: 'Check this change please.', reviewerKind: 'butter' }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(engine.createAgent).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Butter Reviewer',
      yuan: 'butter',
    }));
    expect(data.reviewerYuan).toBe('butter');
  });

  it('repairs a bound reviewer agent whose persona drifted away from hanako/butter', async () => {
    engine._agents.splice(0, engine._agents.length, ...[
      { id: 'agent-main', name: 'Lynn Main', yuan: 'lynn', tier: 'local', hasAvatar: true },
      { id: 'hanako', name: 'Hanako', yuan: 'lynn', tier: 'local', hasAvatar: false },
      { id: 'butter', name: 'Butter', yuan: 'butter', tier: 'local', hasAvatar: false },
    ]);
    engine.savePreferences({
      review: {
        defaultReviewer: 'hanako',
        hanakoReviewerId: 'hanako',
        butterReviewerId: 'butter',
      },
    });

    const res = await app.request('/api/review/config');
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(engine._agents.find((item) => item.id === 'hanako')?.yuan).toBe('hanako');
    expect(engine._agents.find((item) => item.id === 'hanako')?.tier).toBe('local');
    expect(data.candidates.hanako.map((item) => item.id)).toContain('hanako');
  });

  it('preloads a configured reviewer before starting review execution', async () => {
    engine = makeEngine();
    let runtimeReady = false;
    engine.getAgent = (id) => {
      const agent = engine._agents.find((item) => item.id === id);
      if (!agent) return null;
      if (id === 'agent-hanako' && !runtimeReady) return null;
      return {
        ...agent,
        config: {
          agent: {
            name: agent?.name,
            yuan: agent?.yuan,
            tier: agent?.tier,
          },
          api: { provider: 'openai' },
          models: { chat: { id: 'gpt-4.1', provider: 'openai' } },
        },
        agentName: agent?.name,
        updateConfig: vi.fn(),
      };
    };
    engine.ensureAgentLoaded = vi.fn(async (id) => {
      if (id === 'agent-hanako') runtimeReady = true;
      return { id };
    });
    app = new Hono();
    app.route('/api', createReviewRoute(engine, { broadcast, taskRuntime }));

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
    expect(engine.ensureAgentLoaded).toHaveBeenCalledWith('agent-hanako');
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

  it('falls back to another model after timeout and tells the user what it switched to', async () => {
    runAgentSession
      .mockRejectedValueOnce(new Error('The operation was aborted due to timeout'))
      .mockResolvedValueOnce('Recovered review.\n```json\n{"summary":"Recovered.","verdict":"pass","findings":[]}\n```');

    const res = await app.request('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: 'Please review this timeout path.' }),
    });

    expect(res.status).toBe(200);
    const resultMsg = broadcast.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg.type === 'review_result' && msg.structured?.summary === 'Recovered.');

    expect(runAgentSession).toHaveBeenCalledTimes(2);
    expect(resultMsg.errorCode).toBe('review_timeout_recovered');
    expect(resultMsg.fallbackNote).toContain('默认复查模型');
    expect(resultMsg.fallbackNote).toMatch(/自动切换到|finished on/);
  });

  it('falls back when the first review attempt returns no output', async () => {
    runAgentSession
      .mockResolvedValueOnce('   ')
      .mockResolvedValueOnce('Recovered after empty review.\n```json\n{"summary":"Recovered after empty review.","verdict":"pass","findings":[]}\n```');

    const res = await app.request('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context: 'Please review this empty-output path.' }),
    });

    expect(res.status).toBe(200);
    const resultMsg = broadcast.mock.calls
      .map(([msg]) => msg)
      .find((msg) => msg.type === 'review_result' && msg.structured?.summary === 'Recovered after empty review.');

    expect(runAgentSession).toHaveBeenCalledTimes(2);
    expect(resultMsg.content).toContain('Recovered after empty review.');
    expect(resultMsg.fallbackNote).toMatch(/自动切换到|finished on/);
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
        sourceResponse: 'Original answer: keep the current patch and add a nil guard.',
        executionResolution: "Merge Hanako's correction first, then continue with Lynn's overall direction.",
      }),
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.task.id).toBe('task-follow-up');
    expect(taskRuntime.createReviewFollowUpTask).toHaveBeenCalledWith(expect.objectContaining({
      reviewId: 'review-123',
      reviewerName: 'Hanako',
      sourceResponse: 'Original answer: keep the current patch and add a nil guard.',
      executionResolution: "Merge Hanako's correction first, then continue with Lynn's overall direction.",
      structuredReview: expect.objectContaining({
        workflowGate: 'follow_up',
      }),
      contextPack: expect.objectContaining({
        workspacePath: '/Users/lynn/openhanako',
      }),
    }));
    expect(taskRuntime.createReviewFollowUpTask.mock.calls[0][0].prompt).toContain('Missing edge case');
    expect(taskRuntime.createReviewFollowUpTask.mock.calls[0][0].prompt).toMatch(/Suggested execution conclusion|建议执行结论/);
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
