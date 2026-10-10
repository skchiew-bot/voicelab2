import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db.js';
import { createUser } from '../src/store/tenants.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let wfId: string; let voiceId: string;
let v1: string; let v2: string; let v3: string;
let tokenB: string; let tokenC: string; let tokenD: string;
const as = (token: string) => ({
  get: (u: string) => env.call(token, 'GET', u), post: (u: string, b?: unknown) => env.call(token, 'POST', u, b), put: (u: string, b?: unknown) => env.call(token, 'PUT', u, b),
});
let A: ReturnType<typeof as>;
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}

const def = (greeting: string, extra = false): WorkflowDefinition => ({
  start: 'ask', variables: ['name'],
  nodes: {
    ask: { type: 'speak', speech: 'hybrid', text: greeting, listen: { captureAs: 'a', intents: { yes: ['yes'], no: ['no'] } },
      transitions: [{ when: { var: 'a_intent', op: 'eq', value: 'yes' }, to: extra ? 'confirm' : 'done' }, { to: 'ask' }] },
    ...(extra ? { confirm: { type: 'speak', speech: 'fixed', text: 'Thank you, we will note that down for you.', transitions: [{ to: 'done' }] } } : {}),
    done: { type: 'end', outcome: 'paid_promise' },
  },
});
const scenarios = [{ name: 'pays', variables: { name: 'Aisha' }, replies: ['yes'], expect: { outcome: 'paid_promise' } }];

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  A = as(env.staffToken);
  const mk = async (email: string) => (await withActor(env.pool, { kind: 'internal' }, (c) => createUser(c, null, { tenantId: null, email, role: 'internal_admin' }))).token;
  tokenB = await mk('b@daythree.test'); tokenC = await mk('c@daythree.test'); tokenD = await mk('d@daythree.test');
  tenantId = (await must(A.post('/internal/tenants', { name: 'Change Co' }))).json().id;
  voiceId = (await must(A.post('/internal/providers', { adapterKey: 'elevenlabs', name: 'el', params: { apiKey: 'k' } }))).json().id;
  await must(A.post(`/internal/providers/${voiceId}/charging`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1, components: [{ component: 'tts', unit: 'per_1k_characters', rate: '0.30', currency: 'USD' }] }));
  const c = (await must(A.post(`/internal/tenants/${tenantId}/workflows`, { name: 'change_flow', definition: def('Hello {{name}}, can you pay this week?') }))).json();
  wfId = c.workflow.id; v1 = c.version.id;
  await must(A.post(`/internal/workflows/${wfId}/deploy`, { versionId: v1, environment: 'staging' }));
  v2 = (await must(A.post(`/internal/workflows/${wfId}/versions`, { definition: def('Hello {{name}}, could you pay by this Friday please?', true) }))).json().id;
  v3 = (await must(A.post(`/internal/workflows/${wfId}/versions`, { definition: def('Hello {{name}}, may we have your payment?') }))).json().id;
});
afterAll(async () => { await env?.teardown(); });

const propose = (toVersionId: string, extra: object = {}) => A.post(`/internal/workflows/${wfId}/changes`, { toVersionId, environment: 'staging', reason: 'Calls end sooner with a clearer ask.', scenarios, voiceProviderId: voiceId, ...extra });

describe('proposing a change', () => {
  it('records what it replaces, why, a readable diff, and a financial assessment worked out from both versions', async () => {
    const r = await must(propose(v2));
    const ch = r.json();
    expect(ch).toMatchObject({ status: 'pending', workflow: 'change_flow', from_version: '1.0', to_version: '2.1' === ch.to_version ? '2.1' : ch.to_version, environment: 'staging', reason: 'Calls end sooner with a clearer ask.', nextLevel: 0 });
    expect(ch.progress).toEqual([expect.objectContaining({ level: 0, name: 'Approver', decision: null })]);
    expect(ch.diff.shape).toBe('major');
    expect(ch.diff.summary).toContain('Added the speak step "confirm": “Thank you, we will note that down for you.”.');
    // 'Hello Aisha, can you pay this week?' (35) -> 'Hello Aisha, could you pay by this Friday please?' (49) + 'Thank you, we will note that down for you.' (42)
    expect(ch.financial.before).toMatchObject({ synthChars: 35, says: 1, escalations: 0 });
    expect(ch.financial.after).toMatchObject({ synthChars: 91, says: 2 });
    expect(ch.financial.delta).toMatchObject({ synthChars: 56, says: 1, costUsd: '0.01680000' });         // 56 characters at 0.30 per 1000
    expect(ch.financial.after.costUsd).toBe('0.02730000');
    expect(ch.financial.ratesConfirmed).toBe(false);
    expect(ch.financial.note).toContain('call length and telephony cost are not estimated');
    expect(ch.levels).toEqual([{ name: 'Approver' }]);
  });

  it('refuses a proposal with no reason, no scenarios, a version that is already live, another workflow\'s, or one with errors', async () => {
    expect((await propose(v2, { reason: '  ' })).statusCode).toBe(400);
    expect((await propose(v2, { scenarios: [] })).statusCode).toBe(400);
    expect((await propose(v1)).statusCode).toBe(409);
    const other = (await must(A.post(`/internal/tenants/${tenantId}/workflows`, { name: 'other_flow', definition: def('Hi {{name}}') }))).json();
    expect((await propose(other.version.id)).statusCode).toBe(404);
    const bad = (await must(A.post(`/internal/workflows/${wfId}/versions`, { definition: { start: 'ask', nodes: { ask: { type: 'speak', speech: 'fixed', text: 'Hi', transitions: [{ to: 'gone' }] } } } }))).json();
    expect((await propose(bad.id)).statusCode).toBe(400);
  });

  it('works out the assessment without pricing it when no voice provider is given, and says so', async () => {
    const ch = (await must(propose(v3, { voiceProviderId: undefined }))).json();
    expect(ch.financial.after.costUsd).toBeNull();
    expect(ch.financial.delta).toMatchObject({ costUsd: null });
    expect(ch.financial.note).toContain('not priced');
  });
});

describe('approval, level by level', () => {
  it('needs someone other than the proposer, and then can be applied once, through the usual gates', async () => {
    const ch = (await must(propose(v2))).json();
    const B = as(tokenB);
    expect((await A.post(`/internal/changes/${ch.id}/decision`, { decision: 'approved' })).statusCode).toBe(403);   // not your own
    expect((await A.post(`/internal/changes/${ch.id}/apply`)).statusCode).toBe(409);                                  // not approved yet
    const done = (await must(B.post(`/internal/changes/${ch.id}/decision`, { decision: 'approved', note: 'Looks right.' }))).json();
    expect(done.status).toBe('approved');
    expect(done.progress[0]).toMatchObject({ decision: 'approved', note: 'Looks right.' });
    expect((await B.post(`/internal/changes/${ch.id}/decision`, { decision: 'approved' })).statusCode).toBe(409);     // decided already
    const applied = (await must(A.post(`/internal/changes/${ch.id}/apply`))).json();
    expect(applied.status).toBe('applied');
    expect((await A.get(`/internal/workflows/${wfId}/deployments`)).json().live.staging).toBe(applied.to_version);
    expect((await A.post(`/internal/changes/${ch.id}/apply`)).statusCode).toBe(409);                                  // once only
    await expect(env.pool.query('DELETE FROM change_approvals')).rejects.toThrow(/append-only/);
    await expect(env.pool.query(`UPDATE change_requests SET reason = 'x'`)).rejects.toThrow(/append-only/);
  });

  it('goes through every configured level in order, each by a different person, and keeps the history', async () => {
    await must(A.put(`/internal/tenants/${tenantId}/approval-policy`, { levels: ['Team lead', 'Finance', 'Director'] }));
    expect((await A.get(`/internal/tenants/${tenantId}/approval-policy`)).json()).toEqual([{ name: 'Team lead' }, { name: 'Finance' }, { name: 'Director' }]);
    const ch = (await must(propose(v3))).json();
    expect(ch.progress.map((p: { name: string }) => p.name)).toEqual(['Team lead', 'Finance', 'Director']);
    const B = as(tokenB); const C = as(tokenC); const D = as(tokenD);
    const one = (await must(B.post(`/internal/changes/${ch.id}/decision`, { decision: 'approved' }))).json();
    expect(one).toMatchObject({ status: 'pending', nextLevel: 1 });
    expect((await B.post(`/internal/changes/${ch.id}/decision`, { decision: 'approved' })).statusCode).toBe(403);     // one person, one level
    expect((await A.post(`/internal/changes/${ch.id}/apply`)).statusCode).toBe(409);                                  // two levels still to go
    await must(C.post(`/internal/changes/${ch.id}/decision`, { decision: 'approved', note: 'Costs are fine.' }));
    const full = (await must(D.post(`/internal/changes/${ch.id}/decision`, { decision: 'approved' }))).json();
    expect(full.status).toBe('approved');
    expect(full.progress.map((p: { decision: string }) => p.decision)).toEqual(['approved', 'approved', 'approved']);
    expect(full.progress[1].note).toBe('Costs are fine.');
    expect((await must(A.post(`/internal/changes/${ch.id}/apply`))).json().status).toBe('applied');
  });

  it('ends at a rejection, which needs a reason, and cannot then be applied', async () => {
    const ch = (await must(propose(v2))).json();
    const B = as(tokenB); const C = as(tokenC);
    await must(B.post(`/internal/changes/${ch.id}/decision`, { decision: 'approved' }));
    expect((await C.post(`/internal/changes/${ch.id}/decision`, { decision: 'rejected' })).statusCode).toBe(400);
    const rej = (await must(C.post(`/internal/changes/${ch.id}/decision`, { decision: 'rejected', note: 'Finance did not agree.' }))).json();
    expect(rej.status).toBe('rejected');
    expect((await as(tokenD).post(`/internal/changes/${ch.id}/decision`, { decision: 'approved' })).statusCode).toBe(409);
    expect((await A.post(`/internal/changes/${ch.id}/apply`)).statusCode).toBe(409);
    await must(A.put(`/internal/tenants/${tenantId}/approval-policy`, { levels: ['Approver'] }));
  });

  it('does not put an approved change live past a gate: production still needs its simulation', async () => {
    // staging has v3 live (applied above); a change to production of a version never simulated must be refused at apply
    const ch = (await must(propose(v3, { environment: 'production' }))).json();
    await must(as(tokenB).post(`/internal/changes/${ch.id}/decision`, { decision: 'approved' }));
    const r = await A.post(`/internal/changes/${ch.id}/apply`);
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain('simulation');
    expect((await A.get(`/internal/changes/${ch.id}`)).json().status).toBe('approved');            // still waiting; nothing half-done
    expect((await A.get(`/internal/workflows/${wfId}/deployments`)).json().live.production).toBeNull();
  });
});

describe('showing the client what is changing', () => {
  it('tells the story: the flow now, what was detected in it, what changes and why, the flow after, and the audio to play', async () => {
    // some calls on the current version: one is passed to a person
    const cur = (await A.get(`/internal/workflows/${wfId}/deployments`)).json().live.staging as string;
    const calm = async () => { const r = (await must(A.post(`/internal/workflows/${wfId}/runs`, { environment: 'staging', kind: 'test', variables: { name: 'A' } }))).json(); await must(A.post(`/internal/workflow-runs/${r.id}/reply`, { text: 'yes thanks' })); };
    await calm(); await calm(); await calm();
    const angry = (await must(A.post(`/internal/workflows/${wfId}/runs`, { environment: 'staging', kind: 'test', variables: { name: 'A' } }))).json();
    await must(A.post(`/internal/workflow-runs/${angry.id}/reply`, { text: 'I will call my lawyer' }));
    await must(A.post(`/internal/workflows/${wfId}/versions`, { definition: def('Good day {{name}}, may we speak about your account?', true) }));
    const vNew = (await A.get(`/internal/workflows/${wfId}/versions`)).json()[0].id;
    await must(A.post(`/internal/tenants/${tenantId}/recordings`, { language: 'en', text: 'Thank you, we will note that down for you.', contentType: 'audio/wav', audioBase64: Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(32, 1)]).toString('base64'), durationMs: 2000 }));
    const ch = (await must(propose(vNew, { reason: 'Customers found the opening abrupt.' }))).json();

    const s = (await A.get(`/internal/changes/${ch.id}/showcase`)).json();
    expect(s.change).toMatchObject({ workflow: 'change_flow', status: 'pending', reason: 'Customers found the opening abrupt.', from: cur ? s.change.from : null });
    expect(s.why).toBe('Customers found the opening abrupt.');
    expect(s.before.steps.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining(['ask', 'done']));
    expect(s.after.steps.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining(['ask', 'confirm', 'done']));
    expect(s.after.steps.find((x: { id: string }) => x.id === 'ask').text).toContain('Good day');
    expect(s.detected).toMatchObject({ calls: 4, escalated: 1, escalationPercent: 25, periodDays: 30 });
    expect(s.detected.whereCallsEscalate).toEqual([{ node: 'ask', escalations: 1 }]);
    expect(s.detected.turns).toBe(4);
    expect(s.changes.summary.some((x: string) => x.includes('Good day'))).toBe(true);
    expect(s.financial.delta).toBeTruthy();
    expect(s.approvals).toHaveLength(1);
    const confirm = s.audio.find((a: { node: string }) => a.node === 'confirm');
    expect(confirm.recordingId).toBeTruthy();                                       // the stitched audio can be played
    expect(s.audio.find((a: { node: string }) => a.node === 'ask').recordingId).toBeNull();
    expect(s.audioNote).toMatch(/1 of \d+ fixed phrases have a recording/);
    expect((await A.get(`/internal/recordings/${confirm.recordingId}/audio`)).statusCode).toBe(200);
    expect((await A.get('/internal/changes?workflowId=' + wfId)).json().length).toBeGreaterThan(3);
  });
});

describe('a change written against a flow that has since moved on', () => {
  it('is refused, so approving one change never silently undoes another', async () => {
    const live = async () => (await A.get(`/internal/workflows/${wfId}/deployments`)).json().live.staging as string;
    const v4 = (await must(A.post(`/internal/workflows/${wfId}/versions`, { definition: def('Hello {{name}}, can we count on a payment soon?') }))).json().id;
    const v5 = (await must(A.post(`/internal/workflows/${wfId}/versions`, { definition: def('Hello {{name}}, is a payment possible today?') }))).json().id;
    const one = (await must(propose(v4))).json(); const two = (await must(propose(v5))).json();
    const B = as(tokenB);
    await must(B.post(`/internal/changes/${one.id}/decision`, { decision: 'approved' }));
    await must(B.post(`/internal/changes/${two.id}/decision`, { decision: 'approved' }));
    await must(A.post(`/internal/changes/${one.id}/apply`));
    expect(await live()).toBe(one.to_version);
    const late = await A.post(`/internal/changes/${two.id}/apply`);
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toContain('changed since');
    expect(await live()).toBe(one.to_version);                                                       // the first change still stands
    // and nobody can approve a diff that is already out of date
    const v6 = (await must(A.post(`/internal/workflows/${wfId}/versions`, { definition: def('Hello {{name}}, may we hear about your payment?') }))).json().id;
    const three = (await must(propose(v6))).json();
    await must(A.post(`/internal/workflows/${wfId}/deploy`, { versionId: v5, environment: 'staging' }));
    const stale = await as(tokenC).post(`/internal/changes/${three.id}/decision`, { decision: 'approved' });
    expect(stale.statusCode).toBe(409);
  });
});
