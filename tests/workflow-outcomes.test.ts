import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKey } from '../src/secrets.js';
import { onRelayMessage, openRelay, relayCallToken } from '../src/store/relay.js';
import { abandonRun, replyRunSpoken, startRunSpoken } from '../src/store/runs.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';
import { start, type Deps } from '../src/workflows/engine.js';
import { evaluateScenario } from '../src/workflows/simulate.js';
import { validateDefinition } from '../src/workflows/validate.js';

// A workflow says how an outbound call turned out at the end it finishes at; a live call records it as the call's outcome.
const flow: WorkflowDefinition = {
  start: 'ask', variables: [],
  nodes: {
    ask: { type: 'speak', speech: 'fixed', text: 'Is this a good time to talk about your account?', listen: { captureAs: 'a', intents: { yes: ['yes'], no: ['no'] } },
      transitions: [{ when: { var: 'a_intent', op: 'eq', value: 'yes' }, to: 'ok' }, { when: { var: 'a_intent', op: 'eq', value: 'no' }, to: 'refused' }, { to: 'unsure' }] },
    ok: { type: 'end', outcome: 'talked', contact: 'contacted' },
    refused: { type: 'end', outcome: 'declined', contact: 'rejected' },
    unsure: { type: 'end', outcome: 'no_clear_answer' },
  },
};

describe('an end that says how the call turned out', () => {
  it('is checked when the workflow is saved: only a known call outcome is allowed', () => {
    expect(validateDefinition(flow).errors).toEqual([]);
    const bad = { ...flow, nodes: { ...flow.nodes, ok: { type: 'end', outcome: 'talked', contact: 'reached' } } } as unknown as WorkflowDefinition;
    expect(validateDefinition(bad).errors.map((e) => [e.code, e.nodeId])).toEqual([['unknown_contact', 'ok']]);
  });

  it('counts only at the end the call finishes at, not at the end of a subflow that hands back', async () => {
    const child: WorkflowDefinition = { start: 'x', variables: [], nodes: { x: { type: 'end', outcome: 'checked', contact: 'wrong_number' } } };
    const parent: WorkflowDefinition = { start: 's', variables: [], nodes: {
      s: { type: 'subflow', workflow: 'child', transitions: [{ to: 'done' }] }, done: { type: 'end', outcome: 'finished' } } };
    const deps: Deps = { load: (n) => ({ parent, child } as Record<string, WorkflowDefinition>)[n] };
    const r = await start('parent', {}, deps);
    expect(r.records.find((x) => x.type === 'end')?.payload).toEqual({ outcome: 'finished' });
    const direct = await start('child', {}, deps);
    expect(direct.records.find((x) => x.type === 'end')?.payload).toEqual({ outcome: 'checked', contact: 'wrong_number' });
  });

  it('carries only a known call outcome, even from a version saved before outcomes were checked', async () => {
    const old = { start: 'x', variables: [], nodes: { x: { type: 'end', outcome: 'done', contact: 'reached <b>' } } } as unknown as WorkflowDefinition;
    const r = await start('old', {}, { load: () => old });
    expect(r.records.filter((x) => x.type === 'reached_end' || x.type === 'end').map((x) => x.payload)).toEqual([{ outcome: 'done' }, { outcome: 'done' }]);
  });

  it('can be expected by a rehearsal, as an outcome or as none', async () => {
    const deps: Deps = { load: () => flow };
    const ran = async (reply: string) => {
      const { reply: engineReply } = await import('../src/workflows/engine.js');
      const s = await start('flow', {}, deps);
      const r = await engineReply(s.state, reply, deps);
      return { state: r.state, records: [...s.records, ...r.records], unusedReplies: 0 };
    };
    expect(evaluateScenario({ name: 'yes', variables: {}, expect: { outcome: 'talked', contact: 'contacted' } }, await ran('yes')).passed).toBe(true);
    expect(evaluateScenario({ name: 'mumble', variables: {}, expect: { contact: 'none' } }, await ran('hmm')).passed).toBe(true);
    const wrong = evaluateScenario({ name: 'no', variables: {}, expect: { contact: 'contacted' } }, await ran('no'));
    expect(wrong.failures).toEqual(['Expected the call to end as "contacted" but it ended as "rejected".']);
    // a call still waiting for the caller has not ended at all, so it ends as nothing, not as "none"
    const waiting = await start('flow', {}, deps);
    const still = evaluateScenario({ name: 'silent', variables: {}, expect: { contact: 'none' } }, { state: waiting.state, records: waiting.records, unusedReplies: 0 });
    expect(still.failures).toEqual(['The call was still waiting for the caller after the last scripted reply.', 'Expected the call to end as "none" but it had not ended.']);
  });
});

// ------------------------------------------------------------------ live calls, against fakes
type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let projectId: string; let twilioId: string; let numberId: string; let wfId: string;
const BASE = 'https://voicelab.test';
const post = (u: string, b?: unknown) => env.call(env.staffToken, 'POST', u, b);
const get = (u: string) => env.call(env.staffToken, 'GET', u);
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  tenantId = (await must(post('/internal/tenants', { name: 'Outcome Co' }))).json().id;
  projectId = (await must(post(`/internal/tenants/${tenantId}/projects`, { name: 'Collections' }))).json().id;
  twilioId = (await must(post('/internal/providers', { adapterKey: 'twilio', name: 'tw-outcomes', params: { accountSid: 'AC1', authToken: 'tw-outcome-token', twimlAppVoiceUrl: `${BASE}/v` } }))).json().id;
  numberId = (await must(post('/internal/numbers', { providerId: twilioId, e164: '+60300000888', tenantId, projectId, country: 'MY' }))).json().id;
  const c = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'outcome_flow', definition: flow }))).json();
  await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'staging' }));
  // The rehearsal can say which outcome each path records.
  const sim = (await must(post(`/internal/workflows/${c.workflow.id}/simulate`, { scenarios: [
    { name: 'agrees', variables: {}, replies: ['yes'], expect: { outcome: 'talked', contact: 'contacted' } },
    { name: 'declines', variables: {}, replies: ['no'], expect: { outcome: 'declined', contact: 'rejected' } },
    { name: 'unclear', variables: {}, replies: ['hmm'], expect: { outcome: 'no_clear_answer', contact: 'none' } },
  ] }))).json();
  expect(sim.results.map((r: { passed: boolean }) => r.passed)).toEqual([true, true, true]);
  await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'production' }));
  wfId = c.workflow.id;
});
afterAll(async () => { await env?.teardown(); });

const runs = () => ({ pool: env.pool, key: parseKey(env.config.VOICELAB_SECRET_KEY) });
/** A call as the dial path leaves it: answered, with the workflow it runs, and no customer number. */
async function liveCall(direction: 'outbound' | 'inbound' = 'outbound') {
  const id = randomUUID(); const sid = `CA_outcome_${id.slice(0, 8)}`;
  await env.pool.query(
    `INSERT INTO calls (id, tenant_id, project_id, provider_id, provider_call_id, direction, status, country, from_number_id, workflow_id, cost_status)
     VALUES ($1,$2,$3,$4,$5,$6,'in_progress','MY',$7,$8,'pending')`, [id, tenantId, projectId, twilioId, sid, direction, numberId, wfId]);
  return { id, sid };
}
const outcomesOf = async (callId: string) =>
  (await env.pool.query(`SELECT outcome, recorded_by FROM outbound_outcomes WHERE call_id = $1 ORDER BY id`, [callId])).rows;
const live = (callId: string) => startRunSpoken(runs(), null, { workflowId: wfId, environment: 'production', kind: 'live', variables: {}, callId });

describe('a live outbound call whose workflow ends at an end that says how it turned out', () => {
  it('records that as the call\'s outcome, in the same step that ends the run, with no person named', async () => {
    const call = await liveCall();
    const r = await live(call.id);
    expect(await outcomesOf(call.id)).toEqual([]);                                    // still talking: nothing yet
    await replyRunSpoken(runs(), r.view.id, 'yes', r.view.version);
    expect(await outcomesOf(call.id)).toEqual([{ outcome: 'contacted', recorded_by: null }]);
    const a = (await env.pool.query(`SELECT actor_id, detail FROM audit_log WHERE action = 'outbound.outcome' AND entity_id = $1`, [call.id])).rows;
    expect(a).toEqual([{ actor_id: null, detail: { outcome: 'contacted', callback: false, source: 'workflow', run: r.view.id } }]);
  });

  it('records the outcome each end names, and nothing for an end that names none, an inbound call or a call that was abandoned', async () => {
    const refused = await liveCall();
    let r = await live(refused.id);
    await replyRunSpoken(runs(), r.view.id, 'no', r.view.version);
    expect(await outcomesOf(refused.id)).toEqual([{ outcome: 'rejected', recorded_by: null }]);

    const unclear = await liveCall();
    r = await live(unclear.id);
    await replyRunSpoken(runs(), r.view.id, 'hmm', r.view.version);
    expect((await env.pool.query('SELECT status, outcome FROM workflow_runs WHERE id = $1', [r.view.id])).rows[0]).toEqual({ status: 'ended', outcome: 'no_clear_answer' });
    expect(await outcomesOf(unclear.id)).toEqual([]);                               // not guessed: shown as answered, not classified

    const inbound = await liveCall('inbound');
    r = await live(inbound.id);
    await replyRunSpoken(runs(), r.view.id, 'yes', r.view.version);
    expect((await env.pool.query('SELECT outcome FROM workflow_runs WHERE id = $1', [r.view.id])).rows[0].outcome).toBe('talked');
    expect(await outcomesOf(inbound.id)).toEqual([]);                               // outcomes are for outbound calls

    const hungUp = await liveCall();
    r = await live(hungUp.id);
    expect(await abandonRun(runs(), r.view.id)).toBe(true);                         // the caller hung up mid-call
    expect(await outcomesOf(hungUp.id)).toEqual([]);
  });

  it('records nothing for a staging test, even one placed as a real call, so tests never count in the analytics', async () => {
    const before = (await env.pool.query('SELECT count(*)::int AS n FROM outbound_outcomes')).rows[0].n;
    const call = await liveCall();
    for (const callId of [undefined, call.id]) {
      const r = await startRunSpoken(runs(), null, { workflowId: wfId, environment: 'staging', kind: 'test', variables: {}, callId });
      await replyRunSpoken(runs(), r.view.id, 'yes', r.view.version);
      expect((await env.pool.query('SELECT outcome FROM workflow_runs WHERE id = $1', [r.view.id])).rows[0].outcome).toBe('talked');
    }
    expect((await env.pool.query('SELECT count(*)::int AS n FROM outbound_outcomes')).rows[0].n).toBe(before);
  });

  it('counts in the outbound analytics once the call has completed, and a person can still correct it', async () => {
    const call = await liveCall();
    const r = await live(call.id);
    await replyRunSpoken(runs(), r.view.id, 'yes', r.view.version);
    const stats = async () => (await must(get(`/internal/analytics/outbound?tenantId=${tenantId}`))).json().outcomes;
    const before = await stats();
    await env.pool.query(`UPDATE calls SET status = 'completed', ended_at = now() WHERE id = $1`, [call.id]);   // the provider reports the end after the workflow's
    const after = await stats();
    expect(after.contacted).toBe(before.contacted + 1);
    expect(after.unclassified).toBe(before.unclassified);
    // a person listening back says someone else answered: theirs is the current outcome, and the workflow's is kept
    await must(post(`/internal/calls/${call.id}/outcome`, { outcome: 'third_party' }));
    const corrected = await stats();
    expect([corrected.contacted, corrected.thirdParty]).toEqual([after.contacted - 1, after.thirdParty + 1]);
    expect((await outcomesOf(call.id)).map((o) => o.outcome)).toEqual(['contacted', 'third_party']);
  });

  it('never replaces what a person said, even when the workflow\'s outcome lands after it', async () => {
    const call = await liveCall();
    const r = await live(call.id);
    // The caller hung up while the answer was being worked out; the call completed and a supervisor classified it.
    await env.pool.query(`UPDATE calls SET status = 'completed', ended_at = now() WHERE id = $1`, [call.id]);
    await must(post(`/internal/calls/${call.id}/outcome`, { outcome: 'third_party' }));
    await replyRunSpoken(runs(), r.view.id, 'yes', r.view.version);                  // the workflow's "contacted" lands late
    expect((await env.pool.query('SELECT status, outcome FROM workflow_runs WHERE id = $1', [r.view.id])).rows[0]).toEqual({ status: 'ended', outcome: 'talked' });
    expect((await outcomesOf(call.id)).map((o) => [o.outcome, o.recorded_by === null])).toEqual([['third_party', false]]);
  });

  it('refuses a rehearsal expecting an outcome that does not exist', async () => {
    const r = await post(`/internal/workflows/${wfId}/simulate`, { scenarios: [{ name: 'x', variables: {}, replies: ['yes'], expect: { outcome: 'talked', contact: 'reached' } }] });
    expect(r.statusCode).toBe(400);
  });

  it('is recorded when the call runs through the live voice link', async () => {
    const call = await liveCall();
    const d = { runs: runs(), baseUrl: BASE };
    const setup = { type: 'setup' as const, sessionId: 'VX1', accountSid: 'AC1', callSid: call.sid, customParameters: { callId: call.id, token: relayCallToken(d.runs.key, call.id) } };
    const o = await openRelay(d, twilioId, setup);
    expect(o.send).toEqual([{ type: 'text', token: 'Is this a good time to talk about your account?', last: true }]);
    expect(await onRelayMessage(d, o.session!, { type: 'prompt', voicePrompt: 'no', last: true }, o.session!.version)).toEqual([{ type: 'end' }]);
    expect(await outcomesOf(call.id)).toEqual([{ outcome: 'rejected', recorded_by: null }]);
  });
});
