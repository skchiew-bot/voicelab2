import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildReplay, type ReplayStep } from '../src/journey/replay.js';
import { scoreCall, type Criterion, type Judge } from '../src/journey/qa.js';
import { DEFAULT_JOURNEY } from '../src/journey/tracker.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';
import { reply, start, type Deps } from '../src/workflows/engine.js';

const def: WorkflowDefinition = {
  start: 'greet', variables: ['name'],
  nodes: {
    greet: { type: 'speak', speech: 'hybrid', text: 'Hello {{name}}, this is Voice Lab. Can you pay this week?', listen: { captureAs: 'a', intents: { yes: ['yes'], no: ['no'] } },
      transitions: [{ when: { var: 'a_intent', op: 'eq', value: 'yes' }, to: 'thanks' }, { to: 'greet' }] },
    thanks: { type: 'speak', speech: 'fixed', text: 'Thank you.', transitions: [{ to: 'done' }] },
    done: { type: 'end', outcome: 'paid_promise' },
  },
};
async function replayOf(replies: string[]) {
  const deps: Deps = { load: () => def, journey: DEFAULT_JOURNEY };
  let r = await start('w', { name: 'Aisha' }, deps); const records = [...r.records];
  for (const t of replies) { r = await reply(r.state, t, deps); records.push(...r.records); }
  const steps: ReplayStep[] = records.map((x, k) => ({ seq: k + 1, type: x.type, workflow: x.workflow, node: x.node ?? null, payload: x.payload, created_at: x.at! }));
  return buildReplay({ run: { id: 'r', workflow: 'w', status: r.state.status, outcome: r.state.outcome ?? null, error: null, environment: 'production', kind: 'live', versions: { w: '1.0' } }, steps, definitions: { w: def } });
}
const c = (id: string, rest: object, weight = 1): Criterion => ({ id, label: id, weight, ...rest }) as Criterion;
const judge = (tier: Judge['tier'], answers: { passed: boolean; confidence: number }[]): Judge & { asked: string[] } => {
  const asked: string[] = []; let i = 0;
  return { tier, model: `${tier}-model`, asked, judge: async (q) => { asked.push(q.question); const a = answers[Math.min(i++, answers.length - 1)]!; return { ...a, reason: `${tier} says ${a.passed}`, inputTokens: 100, outputTokens: 10 }; } };
};

describe('the scorecard: rules', () => {
  it('checks each kind of criterion against the replay and weighs the result', async () => {
    const rp = await replayOf(['yes thanks']);
    const card = await scoreCall([
      c('adherence', { type: 'adherence_min', min: 90 }, 3), c('outcome', { type: 'outcome_in', outcomes: ['paid_promise', 'callback'] }, 3),
      c('calm', { type: 'no_escalation' }, 2), c('safe', { type: 'no_fault' }, 1),
      c('intro', { type: 'must_say', phrases: ['this is voice lab'] }, 2), c('manners', { type: 'must_not_say', phrases: ['final warning'] }, 1),
      c('fast', { type: 'max_latency_ms', ms: 60_000 }, 1), c('mood', { type: 'sentiment_not_worse' }, 1), c('clear', { type: 'max_misunderstood', max: 0 }, 1),
    ], rp);
    expect(card.results.every((r) => r.passed === true)).toBe(true);
    expect(card).toMatchObject({ score: 100, complete: true });
    expect(card.usage).toEqual([]);                                                // rules cost no tokens
  });

  it('fails what should fail, says why, and scores by weight', async () => {
    const rp = await replayOf(['hmm', 'uh']);                                       // not understood twice: escalated
    const card = await scoreCall([
      c('outcome', { type: 'outcome_in', outcomes: ['paid_promise'] }, 5), c('calm', { type: 'no_escalation' }, 3),
      c('intro', { type: 'must_say', phrases: ['voice lab', 'terms and conditions'] }, 1), c('clear', { type: 'max_misunderstood', max: 0 }, 1),
    ], rp);
    const by = Object.fromEntries(card.results.map((r) => [r.id, r]));
    expect(by.outcome).toMatchObject({ passed: false, detail: 'The call ended handoff_human.' });
    expect(by.calm).toMatchObject({ passed: false });
    expect(by.intro!.detail).toBe('The call never said: "terms and conditions".');
    expect(by.clear!.detail).toContain('2 turns were not understood');
    expect(card.score).toBe(0);
    const part = await scoreCall([c('a', { type: 'no_fault' }, 3), c('b', { type: 'no_escalation' }, 1)], rp);
    expect(part.score).toBe(75);                                                    // 3 of 4 weight
  });
});

describe('the scorecard: questions of judgement', () => {
  const q = c('empathy', { type: 'judge', question: 'Did the agent show empathy?' }, 4);

  it('leaves a judgement out of the score, and says so, when no model is available', async () => {
    const card = await scoreCall([q, c('safe', { type: 'no_fault' }, 1)], await replayOf(['yes thanks']));
    expect(card.results[0]).toMatchObject({ passed: null, scorer: 'skipped' });
    expect(card).toMatchObject({ score: 100, complete: false });
  });
  it('asks the small model first and takes a confident answer', async () => {
    const haiku = judge('haiku', [{ passed: true, confidence: 0.9 }]); const sonnet = judge('sonnet', [{ passed: false, confidence: 0.99 }]);
    const card = await scoreCall([q], await replayOf(['yes thanks']), { primary: haiku, escalate: sonnet });
    expect(card.results[0]).toMatchObject({ passed: true, scorer: 'model', model: 'haiku-model' });
    expect(sonnet.asked).toEqual([]);
    expect(card.usage).toEqual([expect.objectContaining({ tier: 'haiku', inputTokens: 100, outputTokens: 10, escalatedFrom: null })]);
  });
  it('goes up one tier when the small model is not sure, and records the step up', async () => {
    const haiku = judge('haiku', [{ passed: true, confidence: 0.4 }]); const sonnet = judge('sonnet', [{ passed: false, confidence: 0.95 }]);
    const card = await scoreCall([q], await replayOf(['yes thanks']), { primary: haiku, escalate: sonnet });
    expect(card.results[0]).toMatchObject({ passed: false, model: 'sonnet-model' });
    expect(card.usage.map((u) => [u.tier, u.escalatedFrom])).toEqual([['haiku', null], ['sonnet', 'haiku']]);
    expect(haiku.asked).toHaveLength(1); expect(sonnet.asked).toHaveLength(1);
  });
  it('shows a model nothing of a sensitive answer', async () => {
    const sens: WorkflowDefinition = { start: 'a', nodes: { a: { type: 'speak', speech: 'fixed', text: 'PIN?', listen: { captureAs: 'p', sensitive: true }, transitions: [{ to: 'z' }] }, z: { type: 'end', outcome: 'ok' } } };
    const deps: Deps = { load: () => sens, journey: DEFAULT_JOURNEY };
    const s = await start('w', {}, deps); const r = await reply(s.state, 'my pin is 4321', deps);
    const steps: ReplayStep[] = [...s.records, ...r.records].map((x, k) => ({ seq: k + 1, type: x.type, workflow: x.workflow, node: x.node ?? null, payload: x.payload, created_at: x.at! }));
    const rp = buildReplay({ run: { id: 'r', workflow: 'w', status: 'ended', outcome: 'ok', error: null, environment: 'production', kind: 'live', versions: {} }, steps, definitions: { w: sens } });
    let seen = '';
    const spy: Judge = { tier: 'haiku', model: 'h', judge: async (x) => { seen = JSON.stringify(x); return { passed: true, confidence: 1, reason: 'ok', inputTokens: 1, outputTokens: 1 }; } };
    await scoreCall([q], rp, { primary: spy });
    expect(seen).not.toContain('4321');
  });
});

import { withActor } from '../src/db.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let wfId: string;
const haiku = judge('haiku', [{ passed: true, confidence: 0.4 }, { passed: true, confidence: 0.95 }]);
const sonnet = judge('sonnet', [{ passed: false, confidence: 0.9 }]);
const st = () => env.staffToken;
const get = (u: string) => env.call(st(), 'GET', u);
const post = (u: string, b?: unknown) => env.call(st(), 'POST', u, b);
const put = (u: string, b?: unknown) => env.call(st(), 'PUT', u, b);
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}

describe('scoring finished calls in batches', () => {
  beforeAll(async () => {
    env = await (await import('./helpers.js')).setupDb({ judges: { haiku, sonnet } });
    tenantId = (await must(post('/internal/tenants', { name: 'QA Co' }))).json().id;
    const created = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'qa_flow', definition: def }))).json();
    wfId = created.workflow.id;
    await must(post(`/internal/workflows/${wfId}/deploy`, { versionId: created.version.id, environment: 'staging' }));
  });
  afterAll(async () => { await env?.teardown(); });

  const finished = async (replies: string[]) => {
    const r = (await must(post(`/internal/workflows/${wfId}/runs`, { environment: 'staging', kind: 'test', variables: { name: 'Aisha' } }))).json();
    for (const t of replies) await must(post(`/internal/workflow-runs/${r.id}/reply`, { text: t }));
    return r.id as string;
  };

  it('leaves calls alone until the client has criteria, then scores them all, once', async () => {
    const a = await finished(['yes thanks']); const b = await finished(['hmm', 'uh']);
    expect((await post(`/internal/tenants/${tenantId}/qa/score`, {})).json()).toMatchObject({ scored: 0, skipped: 2 });
    const set = await must(post(`/internal/tenants/${tenantId}/qa-criteria`, { useCase: '*', criteria: [
      { id: 'outcome', label: 'Reached a promise to pay', type: 'outcome_in', outcomes: ['paid_promise'], weight: 6 },
      { id: 'intro', label: 'Introduced Voice Lab', type: 'must_say', phrases: ['this is voice lab'], weight: 2 },
      { id: 'empathy', label: 'Showed empathy', type: 'judge', question: 'Did the agent show empathy to the caller?', weight: 2 },
    ] }));
    expect(set.json()).toMatchObject({ version: 1 });
    const out = (await post(`/internal/tenants/${tenantId}/qa/score`, {})).json();
    expect(out).toMatchObject({ scored: 2, skipped: 0, usedModel: false });          // no model configured yet: rules only
    const scores = (await get(`/internal/qa/scores?tenantId=${tenantId}`)).json();
    expect(scores).toHaveLength(2);
    const sa = scores.find((s: { run_id: string }) => s.run_id === a); const sb = scores.find((s: { run_id: string }) => s.run_id === b);
    expect(Number(sa.score)).toBe(100); expect(sa.results.complete).toBe(false);     // the empathy question was not scored
    expect(Number(sb.score)).toBe(25);                                                // 'intro' passed (2 of 8); outcome failed
    expect(sa).toMatchObject({ workflow: 'qa_flow', use_case: '*', criteria_version: 1, scorer: 'rules', input_tokens: 0 });
    expect((await post(`/internal/tenants/${tenantId}/qa/score`, {})).json()).toMatchObject({ scored: 0 });   // not twice
    await expect(env.pool.query('UPDATE qa_scores SET score = 100')).rejects.toThrow(/append-only/);
  });

  it('uses the model the task is configured for, steps up a tier when unsure, and records both with their tokens', async () => {
    await must(put('/internal/model-config/qa_judge', { tier: 'haiku', modelId: 'haiku-model', escalateTo: 'sonnet' }));
    await must(put('/internal/model-config/speak_dynamic', { tier: 'sonnet', modelId: 'sonnet-model', escalateTo: null }));
    const run = await finished(['yes thanks']);
    const out = (await post(`/internal/tenants/${tenantId}/qa/score`, {})).json();
    expect(out).toMatchObject({ scored: 1, usedModel: true });
    const score = (await get(`/internal/qa/scores?runId=${run}`)).json()[0];
    expect(score).toMatchObject({ scorer: 'model+rules', model: 'sonnet-model', tier: 'sonnet', input_tokens: 200, output_tokens: 20, escalated_from: 'haiku' });
    expect(Number(score.score)).toBe(80);                                             // outcome 6 + intro 2 passed, empathy (2) failed on the stronger model
    const decisions = (await get(`/internal/ai-decisions?subjectType=qa_criterion&subjectId=${run}:empathy`)).json();
    expect(decisions.map((d: { tier: string; escalated_from: string | null }) => [d.tier, d.escalated_from]).sort()).toEqual([['haiku', null], ['sonnet', 'haiku']]);
    const usage = (await get(`/internal/ai-usage?tenantId=${tenantId}`)).json();
    const sonnetUse = usage.find((u: { model: string }) => u.model === 'sonnet-model');
    expect(sonnetUse).toMatchObject({ task: 'qa_judge', tier: 'sonnet', escalations: 1 });
    expect(Number(sonnetUse.input_tokens)).toBe(100);
  });

  it('keeps old scores on the criteria they used, takes a changed set from the next batch, and prefers a workflow\'s own set', async () => {
    await must(post(`/internal/tenants/${tenantId}/qa-criteria`, { useCase: 'qa_flow', criteria: [{ id: 'calm', label: 'No escalation', type: 'no_escalation', weight: 1 }] }));
    const run = await finished(['yes thanks']);
    await post(`/internal/tenants/${tenantId}/qa/score`, {});
    const s = (await get(`/internal/qa/scores?runId=${run}`)).json()[0];
    expect(s).toMatchObject({ use_case: 'qa_flow', criteria_version: 1 });
    expect(s.results.results.map((r: { id: string }) => r.id)).toEqual(['calm']);
    const v2 = await must(post(`/internal/tenants/${tenantId}/qa-criteria`, { useCase: 'qa_flow', criteria: [{ id: 'calm', label: 'No escalation', type: 'no_escalation', weight: 1 }, { id: 'fault', label: 'No drop', type: 'no_fault', weight: 1 }] }));
    expect(v2.json().version).toBe(2);
    expect((await get(`/internal/tenants/${tenantId}/qa-criteria`)).json().find((x: { use_case: string }) => x.use_case === 'qa_flow').version).toBe(2);
    const old = (await get(`/internal/qa/scores?tenantId=${tenantId}&limit=200`)).json().find((x: { run_id: string }) => x.run_id === run);
    expect(old.criteria_version).toBe(1);
  });

  it('summarises scores by workflow and what fails most', async () => {
    const sum = (await get(`/internal/tenants/${tenantId}/qa/summary`)).json();
    expect(sum.byWorkflow[0]).toMatchObject({ workflow: 'qa_flow' });
    expect(sum.byWorkflow[0].scored).toBeGreaterThanOrEqual(4);
    expect(sum.mostFailed.map((m: { criterion: string }) => m.criterion)).toContain('outcome');
    const left = await finished(['yes thanks']);
    expect((await get(`/internal/tenants/${tenantId}/qa/summary`)).json().unscored).toBe(1);
    void left;
  });

  it('refuses criteria that cannot be checked, and a task that escalates downwards', async () => {
    const bad = (criteria: unknown) => post(`/internal/tenants/${tenantId}/qa-criteria`, { useCase: 'x', criteria });
    expect((await bad([])).statusCode).toBe(400);
    expect((await bad([{ id: 'a', label: 'a', type: 'telepathy', weight: 1 }])).statusCode).toBe(400);
    expect((await bad([{ id: 'a', label: 'a', type: 'no_fault', weight: 11 }])).statusCode).toBe(400);
    expect((await bad([{ id: 'a', label: 'a', type: 'no_fault', weight: 1 }, { id: 'a', label: 'b', type: 'no_escalation', weight: 1 }])).statusCode).toBe(400);
    expect((await bad([{ id: 'a', label: 'a', type: 'must_say', phrases: [], weight: 1 }])).statusCode).toBe(400);
    expect((await put('/internal/model-config/qa_judge', { tier: 'sonnet', modelId: 'm', escalateTo: 'haiku' })).statusCode).toBe(400);
    void withActor;
  });
});
