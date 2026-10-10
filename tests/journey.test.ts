import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db.js';
import { parseKey } from '../src/secrets.js';
import { loadProvider, processWebhook, type CallDeps } from '../src/store/calls.js';
import { sweepFaults } from '../src/store/call-end.js';
import { dncKeyFrom } from '../src/store/dnc.js';
import type { NormalizedEvent } from '../src/telephony/types.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env;
let tenantId: string; let telnyxId: string; let deps: CallDeps; let telnyx: Awaited<ReturnType<typeof loadProvider>>;
const OUR = '+60300000501';
const BASE = 'https://voicelab.test';
const st = () => env.staffToken;
const get = (u: string) => env.call(st(), 'GET', u);
const post = (u: string, b?: unknown) => env.call(st(), 'POST', u, b);
const put = (u: string, b?: unknown) => env.call(st(), 'PUT', u, b);
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}

const flow: WorkflowDefinition = {
  start: 'ask', variables: ['name'],
  intentRoutes: [{ when: { kind: 'complaint' }, to: 'listen' }],
  nodes: {
    ask: { type: 'speak', speech: 'hybrid', text: 'Hello {{name}}, can you pay this week?', listen: { captureAs: 'a', intents: { yes: ['yes'], no: ['no'] } },
      transitions: [{ when: { var: 'a_intent', op: 'eq', value: 'yes' }, to: 'thanks' }, { to: 'ask' }] },
    listen: { type: 'speak', speech: 'fixed', text: 'I am sorry to hear that.', listen: { captureAs: 'c' }, transitions: [{ to: 'ask' }] },
    thanks: { type: 'speak', speech: 'fixed', text: 'Thank you.', transitions: [{ to: 'done' }] },
    done: { type: 'end', outcome: 'paid_promise' },
  },
};
const failing: WorkflowDefinition = {
  start: 'look', variables: [],
  nodes: { look: { type: 'api', integration: 'nothing', path: '/x', transitions: [{ to: 'done' }] }, done: { type: 'end', outcome: 'ok' } },
};
let workflowId: string; let failingId: string;

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  tenantId = (await must(post('/internal/tenants', { name: 'Journey Co' }))).json().id;
  telnyxId = (await must(post('/internal/providers', { adapterKey: 'telnyx', name: 'tx', params: { apiKey: 'K', webhookUrl: `${BASE}/h`, connectionId: 'c1', webhookPublicKey: 'AAAA' } }))).json().id;
  await must(post(`/internal/providers/${telnyxId}/charging`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1, components: [{ component: 'telephony_leg', unit: 'per_minute', rate: '0.006', currency: 'USD' }] }));
  await must(post('/internal/fx', { currency: 'MYR', perUsd: '4.5', effectiveFrom: '2026-01-01T00:00:00Z' }));
  await must(post('/internal/numbers', { providerId: telnyxId, e164: OUR, tenantId, country: 'MY' }));
  const mk = async (name: string, def: WorkflowDefinition) => {
    const c = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name, definition: def }))).json();
    await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'staging' }));
    return c.workflow.id as string;
  };
  workflowId = await mk('journey_flow', flow); failingId = await mk('failing_flow', failing);
  const key = parseKey(env.config.VOICELAB_SECRET_KEY);
  deps = { pool: env.pool, key, dncKey: dncKeyFrom(key), http: env.provider.fetch, baseUrl: BASE };
  telnyx = await withActor(env.pool, { kind: 'internal' }, (c) => loadProvider(c, telnyxId));
});
afterAll(async () => { await env?.teardown(); });

const ev = (kind: NormalizedEvent['kind'], pcid: string, extra: Partial<NormalizedEvent> = {}): NormalizedEvent =>
  ({ key: randomUUID(), providerCallId: pcid, kind, direction: 'inbound', occurredAt: new Date(), transient: { to: OUR, from: '+60129990000' }, ...extra });
const send = (e: NormalizedEvent) => processWebhook(deps, telnyx!, e);
const callRow = async (pcid: string) => (await env.pool.query('SELECT * FROM calls WHERE provider_call_id = $1', [pcid])).rows[0];
let n = 0;
/** An answered inbound call with a workflow run attached. */
async function liveCall(workflow = workflowId, vars: Record<string, unknown> = { name: 'Aisha' }) {
  const pcid = `jc${++n}`;
  await send(ev('initiated', pcid)); await send(ev('answered', pcid));
  const call = await callRow(pcid);
  const started = (await must(post(`/internal/workflows/${workflow}/runs`, { environment: 'staging', kind: 'test', variables: vars, callId: call.id }))).json();
  return { pcid, callId: call.id as string, runId: started.id as string, started };
}
const reply = (runId: string, text: string) => post(`/internal/workflow-runs/${runId}/reply`, { text });

describe('escalation tickets', () => {
  it('opens a ticket with every required field when the call is passed to a person, in the same step', async () => {
    const { runId, callId } = await liveCall();
    await must(reply(runId, 'no, that is bad'));            // understood, but upset: one
    const last = (await must(reply(runId, 'hmm what'))).json();  // not understood: two in a row
    expect(last).toMatchObject({ status: 'ended', outcome: 'handoff_human' });
    const list = (await get(`/internal/tickets?tenantId=${tenantId}`)).json();
    expect(list).toHaveLength(1);
    const t = (await get(`/internal/tickets/${list[0].id}`)).json();
    expect(t).toMatchObject({ kind: 'escalation', trigger: 'failed_recoveries', status: 'open', node: 'ask', call_id: callId, run_id: runId });
    expect(t.reason).toContain('Escalated to a person');
    expect(t.customer_view).toContain('The caller said');
    expect(t.customer_view).toContain('hmm what');
    expect(t.customer_view).toMatch(/mood went from -?\d\.\d\d to -?\d\.\d\d/);
    expect(t.ai_reviews).toHaveLength(1);
    expect(t.ai_reviews[0]).toMatchObject({ reviewer: 'rules' });
    expect(t.ai_reviews[0].findings.map((f: { check: string }) => f.check)).toEqual(['trigger', 'understanding', 'workflow_adherence', 'integrations']);
    expect(t.ai_reviews[0].verdict).toContain('followed the policy');
    expect(t.council_notes).toMatchObject({ status: 'not_requested' });
    expect(t.impact).toMatchObject({ workflow: 'journey_flow', node: 'ask', sameNodeLast30d: 1 });
    expect((await get(`/internal/calls/${callId}/events`)).json().map((e: { type: string }) => e.type)).toContain('ticket.opened');
  });

  it('cannot exist with a field missing: the database refuses it', async () => {
    const base = ['escalation', 'x', 'why', 'ask', 'view', '[{"a":1}]', '{}', '{}'];
    const insert = (over: Record<number, unknown>) => env.pool.query(
      `INSERT INTO tickets (tenant_id, run_id, kind, trigger, reason, node, customer_view, ai_reviews, council_notes, impact) VALUES ($1, gen_random_uuid(), $2,$3,$4,$5,$6,$7,$8,$9)`,
      [tenantId, ...base.map((v, i) => (i in over ? over[i] : v))]);
    await insert({}).then(() => undefined);                                    // a complete one is fine
    await expect(insert({ 4: '' })).rejects.toThrow(/customer_view/);           // no customer's view
    await expect(insert({ 2: '' })).rejects.toThrow(/reason/);                  // no reason
    await expect(insert({ 5: '[]' })).rejects.toThrow(/ai_reviews/);            // no AI review
    await expect(insert({ 6: '[]' })).rejects.toThrow(/council_notes/);         // council notes not an object
    await expect(insert({ 7: '[]' })).rejects.toThrow(/impact/);                // impact not an object
    await expect(env.pool.query(`UPDATE tickets SET reason = 'x'`)).rejects.toThrow(/append-only/);
    await expect(env.pool.query(`DELETE FROM tickets`)).rejects.toThrow(/append-only/);
  });

  it('raises one ticket per escalated run, however it is asked, and none for a rehearsal', async () => {
    const before = (await get(`/internal/tickets?tenantId=${tenantId}`)).json().length;
    const { runId } = await liveCall();
    await must(reply(runId, 'I will call my lawyer'));                         // severe: at once
    const after = (await get(`/internal/tickets?tenantId=${tenantId}`)).json();
    expect(after).toHaveLength(before + 1);
    const { ticketForEscalation } = await import('../src/store/tickets.js');
    expect(await withActor(env.pool, { kind: 'internal' }, (c) => ticketForEscalation(c, null, runId))).toBeNull();   // already raised
    expect((await get(`/internal/tickets?tenantId=${tenantId}`)).json()).toHaveLength(before + 1);
    // a simulation that escalates is a finding, not a customer in trouble
    const sim = (await must(post(`/internal/workflows/${workflowId}/simulate`, { scenarios: [{ name: 'angry', variables: { name: 'A' }, replies: ['I will call my lawyer'], expect: { outcome: 'handoff_human' } }] }))).json();
    expect(sim.passed).toBe(1);
    expect((await get(`/internal/tickets?tenantId=${tenantId}`)).json()).toHaveLength(before + 1);
    expect(after.find((t: { trigger: string }) => t.trigger === 'severe_sentiment')).toBeTruthy();
  });

  it('records what happens to a ticket without changing it, and lets the council add its notes', async () => {
    const t = (await get(`/internal/tickets?tenantId=${tenantId}`)).json()[0];
    await must(post(`/internal/tickets/${t.id}/events`, { kind: 'status', status: 'in_review' }));
    await must(post(`/internal/tickets/${t.id}/events`, { kind: 'note', note: 'Called the customer back.' }));
    await must(post(`/internal/tickets/${t.id}/events`, { kind: 'council', note: 'Wording at ask is too blunt; propose a softer line.' }));
    await must(post(`/internal/tickets/${t.id}/events`, { kind: 'status', status: 'resolved' }));
    const full = (await get(`/internal/tickets/${t.id}`)).json();
    expect(full.status).toBe('resolved');
    expect(full.events.map((e: { kind: string }) => e.kind)).toEqual(['status', 'note', 'council', 'status']);
    expect(full.council_notes).toMatchObject({ status: 'reviewed', notes: [{ note: expect.stringContaining('too blunt') }] });
    expect((await get(`/internal/tickets?status=resolved`)).json().map((x: { id: string }) => x.id)).toContain(t.id);
    expect((await post(`/internal/tickets/${t.id}/events`, { kind: 'status' })).statusCode).toBe(400);
    expect((await post(`/internal/tickets/${t.id}/events`, { kind: 'note', note: '  ' })).statusCode).toBe(400);
    await expect(env.pool.query('DELETE FROM ticket_events')).rejects.toThrow(/append-only/);
  });

  it('keeps a sensitive answer out of the ticket, whatever the caller said', async () => {
    const sens: WorkflowDefinition = { start: 'a', nodes: { a: { type: 'speak', speech: 'fixed', text: 'Last four digits?', listen: { captureAs: 'ic', sensitive: true }, transitions: [{ to: 'b' }] }, b: { type: 'speak', speech: 'fixed', text: 'And how are you?', listen: { captureAs: 'mood' }, transitions: [{ to: 'b' }] } } };
    const c = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'sens_flow', definition: sens }))).json();
    await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'staging' }));
    const r = (await must(post(`/internal/workflows/${c.workflow.id}/runs`, { environment: 'staging', kind: 'test' }))).json();
    await must(reply(r.id, 'my number is 9001-4567-8'));
    await must(reply(r.id, 'my lawyer will hear of this'));
    const t = (await get(`/internal/tickets?tenantId=${tenantId}`)).json()[0];
    const full = JSON.stringify((await get(`/internal/tickets/${t.id}`)).json());
    expect(full).not.toContain('9001');
  });
});

describe('who ended the call, and system drops', () => {
  const end = (pcid: string, extra: Partial<NormalizedEvent> = {}) => send(ev('ended', pcid, { durationSeconds: 30, endReason: 'completed', ...extra }));

  it('records a caller who hung up while the workflow was waiting for them, and where', async () => {
    const { pcid, callId } = await liveCall();
    await end(pcid);
    expect(await callRow(pcid)).toMatchObject({ ended_by: 'customer', ended_node: 'ask', fault: false });
    const types = (await get(`/internal/calls/${callId}/events`)).json().map((e: { type: string }) => e.type);
    expect(types).toContain('call.end_classified');
    expect(types).not.toContain('call.fault');
  });

  it('records a call the workflow finished and then ended as the system\'s own doing, and no fault', async () => {
    const { pcid, runId } = await liveCall();
    await must(reply(runId, 'yes thanks'));
    await end(pcid);
    expect(await callRow(pcid)).toMatchObject({ ended_by: 'system', ended_node: 'done', fault: false });
  });

  it('flags a call dropped after the workflow failed as a fault: loudly, with a ticket', async () => {
    const { pcid, callId } = await liveCall(failingId, {});
    const run = (await env.pool.query('SELECT status, outcome FROM workflow_runs WHERE call_id = $1', [callId])).rows[0];
    expect(run).toMatchObject({ status: 'ended', outcome: 'integration_failed' });   // no integration is set up: the flow failed
    await end(pcid);                                                           // a normal hang-up after the flow had already failed
    const c = await callRow(pcid);
    expect(c).toMatchObject({ ended_by: 'system', fault: true });
    expect(c.fault_reason).toContain('workflow failed');
    expect(c.fault_at).not.toBeNull();
    const events = (await get(`/internal/calls/${callId}/events`)).json().map((e: { type: string }) => e.type);
    expect(events).toContain('call.fault');
    const ticket = (await get(`/internal/tickets?tenantId=${tenantId}`)).json().find((t: { call_id: string }) => t.call_id === callId);
    expect(ticket).toMatchObject({ kind: 'fault', trigger: 'system_drop' });
    const full = (await get(`/internal/tickets/${ticket.id}`)).json();
    expect(full.customer_view).toContain('cut off by the system');
    expect(full.ai_reviews[0].verdict).toContain('system fault');

    // the alert is there as soon as the fault is flagged, within the agreed latency, until someone has looked
    const tower = (await get('/internal/control-tower')).json();
    expect(tower.alerts.find((a: { code: string }) => a.code === 'system_drop')).toMatchObject({ severity: 'high', link: '#/faults' });
    const faults = (await get('/internal/faults?acknowledged=false')).json();
    expect(faults.map((f: { id: string }) => f.id)).toContain(callId);
    const latency = (await get('/internal/journey/drop-latency')).json().seconds;
    expect(Number(faults.find((f: { id: string }) => f.id === callId).flagged_after_ms)).toBeLessThan(latency * 1000);
    await must(post(`/internal/calls/${callId}/fault-ack`, { note: 'seen' }));
    expect((await get('/internal/faults?acknowledged=false')).json().map((f: { id: string }) => f.id)).not.toContain(callId);
    expect((await get('/internal/control-tower')).json().alerts.some((a: { code: string }) => a.code === 'system_drop')).toBe(false);
    expect((await post(`/internal/calls/${callId}/fault-ack`, {})).statusCode).toBe(200);          // asking again changes nothing
  });

  it('flags a call that ended while the workflow was still working, and one the provider reported as failed', async () => {
    const mid = await liveCall();
    await env.pool.query(`UPDATE workflow_runs SET status = 'processing' WHERE id = $1`, [mid.runId]);
    await end(mid.pcid);
    expect(await callRow(mid.pcid)).toMatchObject({ ended_by: 'system', fault: true });
    expect((await callRow(mid.pcid)).fault_reason).toContain('still working');

    const bare = `jc-bare-${++n}`;
    await send(ev('initiated', bare)); await send(ev('answered', bare));
    await end(bare, { endReason: 'failed' });
    expect(await callRow(bare)).toMatchObject({ ended_by: 'system', fault: true });
    const ok = `jc-ok-${++n}`;
    await send(ev('initiated', ok)); await send(ev('answered', ok));
    await end(ok);
    expect(await callRow(ok)).toMatchObject({ ended_by: null, fault: false });          // no workflow: nothing to say about who ended it
  });

  it('catches a drop that never came with an end event, once the failure is older than the agreed latency', async () => {
    await must(put('/internal/journey/drop-latency', { seconds: 90 }));
    const { callId, pcid } = await liveCall(failingId, {});                    // the flow failed; nobody hung up, so the call stays open
    expect((await callRow(pcid)).status).toBe('in_progress');
    const now = new Date();
    const run = async (at: Date) => withActor(env.pool, { kind: 'internal' }, (c) => sweepFaults(c, at));
    expect((await run(now)).flagged).toEqual([]);                              // just failed: inside the latency
    expect((await run(new Date(now.getTime() + 60_000))).flagged).toEqual([]);
    const late = await run(new Date(now.getTime() + 100_000));                 // older than 90 s
    expect(late).toMatchObject({ latencySeconds: 90 });
    expect(late.flagged).toEqual([callId]);
    expect((await callRow(pcid)).fault).toBe(true);
    expect((await run(new Date(now.getTime() + 200_000))).flagged).toEqual([]);   // once only
    expect((await get(`/internal/tickets?tenantId=${tenantId}`)).json().filter((t: { call_id: string }) => t.call_id === callId)).toHaveLength(1);
    expect((await put('/internal/journey/drop-latency', { seconds: 0 })).statusCode).toBe(400);
    await must(put('/internal/journey/drop-latency', { seconds: 60 }));
  });
});

describe('the watchdog on a stalled workflow', () => {
  it('flags a call whose workflow stopped mid-step, but only once it has been stuck longer than the agreed latency', async () => {
    const { callId, pcid } = await liveCall();
    await env.pool.query(`UPDATE workflow_runs SET status = 'processing', updated_at = now() - interval '30 seconds' WHERE call_id = $1`, [callId]);
    const sweep = (secondsFromNow: number) => withActor(env.pool, { kind: 'internal' }, (c) => sweepFaults(c, new Date(Date.now() + secondsFromNow * 1000)));
    expect((await sweep(0)).flagged).not.toContain(callId);                       // stuck 30 s of the 60 allowed
    expect((await sweep(45)).flagged).toContain(callId);                          // stuck 75 s
    expect((await callRow(pcid)).fault_reason).toContain('stopped responding');
  });
});

describe('replaying a call', () => {
  it('lays a finished production call out in full: steps with their reasons, transcript, sentiment, adherence, end, and failover', async () => {
    // production needs a simulation that states its outcome
    const prod = (await must(post('/internal/tenants', { name: 'Prod Co' }))).json().id;
    const c = (await must(post(`/internal/tenants/${prod}/workflows`, { name: 'prod_flow', definition: flow }))).json();
    await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'staging' }));
    await must(post(`/internal/workflows/${c.workflow.id}/simulate`, { scenarios: [{ name: 'pays', variables: { name: 'A' }, replies: ['yes'], expect: { outcome: 'paid_promise' } }] }));
    await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'production' }));
    await must(post('/internal/numbers', { providerId: telnyxId, e164: '+60300000502', tenantId: prod, country: 'MY' }));

    const pcid = `prod${++n}`;
    const tr = { to: '+60300000502', from: '+60129990000' };
    await send(ev('initiated', pcid, { transient: tr })); await send(ev('answered', pcid, { transient: tr }));
    const call = await callRow(pcid);
    const started = (await must(post(`/internal/workflows/${c.workflow.id}/runs`, { environment: 'production', kind: 'live', variables: { name: 'Aisha' }, callId: call.id }))).json();
    await must(reply(started.id, 'no, that is bad'));
    await must(reply(started.id, 'yes great thank you'));
    await env.pool.query(`INSERT INTO failover_events (scope, tenant_id, call_id, trigger, detail) VALUES ('voice', $1, $2, 'hard_errors', '{}')`, [prod, call.id]);
    await send(ev('ended', pcid, { durationSeconds: 42, endReason: 'completed', transient: tr }));

    const rp = (await get(`/internal/calls/${call.id}/replay`)).json();
    expect(rp.run).toMatchObject({ workflow: 'prod_flow', environment: 'production', kind: 'live', outcome: 'paid_promise', versions: { prod_flow: '1.0' } });
    expect(rp.summary).toMatchObject({ outcome: 'paid_promise', turns: 2, endedBy: 'system', endedAtNode: 'done', fault: false, escalated: false });
    expect(rp.transcript.map((t: { speaker: string }) => t.speaker)).toEqual(['assistant', 'caller', 'assistant', 'caller', 'assistant']);
    expect(rp.transcript[0].text).toBe('Hello Aisha, can you pay this week?');
    const types = rp.timeline.map((t: { type: string }) => t.type);
    for (const need of ['start', 'say', 'heard', 'route', 'reached_end', 'end', 'call.answered', 'call.ended', 'call.end_classified', 'failover.voice']) expect(types, need).toContain(need);
    const heard = rp.timeline.find((t: { type: string }) => t.type === 'heard');
    expect(heard.reasoning).toMatchObject({ intent: 'no', matchedWords: ['no: no'] });
    expect(rp.timeline.find((t: { type: string }) => t.type === 'say').policy).toContain('hybrid line');
    expect(rp.sentiment).toHaveLength(2);
    expect(rp.sentiment[0].sentiment).toBeLessThan(rp.sentiment[1].sentiment);               // the mood improved
    for (const point of rp.sentiment) expect(rp.transcript[point.transcriptIndex].timelineIndex).toBe(point.timelineIndex);
    expect(rp.adherence).toMatchObject({ score: 100, deviations: [] });
    expect(rp.call).toMatchObject({ direction: 'inbound', ended_by: 'system' });
    // the same through the run
    const viaRun = (await get(`/internal/workflow-runs/${started.id}/replay`)).json();
    expect(viaRun.timeline.map((t: { type: string }) => t.type)).toEqual(types);
  });

  it('replays a call no workflow ran on from its events alone, and says plainly when there is nothing', async () => {
    const pcid = `bare${++n}`;
    await send(ev('initiated', pcid)); await send(ev('answered', pcid)); await send(ev('ended', pcid, { durationSeconds: 10, endReason: 'completed' }));
    const rp = (await get(`/internal/calls/${(await callRow(pcid)).id}/replay`)).json();
    expect(rp.run).toBeNull();
    expect(rp.timeline.map((t: { type: string }) => t.type)).toEqual(expect.arrayContaining(['call.answered', 'call.ended']));
    expect(rp.adherence.score).toBeNull();
    expect((await get(`/internal/calls/${randomUUID()}/replay`)).statusCode).toBe(404);
    expect((await get(`/internal/workflow-runs/${randomUUID()}/replay`)).statusCode).toBe(404);
  });

  it('shows how long each step took, from the times they happened, not from the one transaction that saved them', async () => {
    const { runId } = await liveCall();
    await new Promise((r) => setTimeout(r, 30));
    await must(reply(runId, 'no, that is bad'));
    const rp = (await get(`/internal/workflow-runs/${runId}/replay`)).json();
    const heard = rp.timeline.find((t: { type: string }) => t.type === 'heard');
    expect(heard.latencyMs).toBeGreaterThanOrEqual(25);
    const steps = (await env.pool.query('SELECT created_at, occurred_at FROM workflow_run_steps WHERE run_id = $1', [runId])).rows;
    expect(steps.every((s) => s.occurred_at !== null)).toBe(true);
  });
});

describe('how a client\'s calls are read', () => {
  it('lets a client add words and change when to escalate, and refuses nonsense', async () => {
    const t = (await must(post('/internal/tenants', { name: 'Config Co' }))).json().id;
    expect((await get(`/internal/tenants/${t}/journey-config`)).json()).toMatchObject({ maxRecoveries: 2, severeBelow: -0.75 });
    const set = await put(`/internal/tenants/${t}/journey-config`, { maxRecoveries: 3, lexicon: { severe: ['ombudsman'], topics: { rebate: ['rebate'] } } });
    expect(set.json()).toMatchObject({ maxRecoveries: 3 });
    expect((await put(`/internal/tenants/${t}/journey-config`, { lexicon: { severe: 'x' } })).statusCode).toBe(400);
    expect((await put(`/internal/tenants/${t}/journey-config`, { lexicon: { evil: ['x'] } })).statusCode).toBe(400);
    expect((await put(`/internal/tenants/${t}/journey-config`, { lexicon: { topics: { constructor: ['x'] } } })).statusCode).toBe(400);
    expect((await put(`/internal/tenants/${t}/journey-config`, { negativeBelow: -0.8, severeBelow: -0.2 })).statusCode).toBe(400);
    expect((await put(`/internal/tenants/${t}/journey-config`, { maxRecoveries: 0 })).statusCode).toBe(400);
    // the word the client added is read as severe on that client's calls, and only theirs
    const wf = (await must(post(`/internal/tenants/${t}/workflows`, { name: 'cfg_flow', definition: { start: 'a', nodes: { a: { type: 'speak', speech: 'fixed', text: 'Hi', listen: { captureAs: 'x' }, transitions: [{ to: 'a' }] } } } }))).json();
    await must(post(`/internal/workflows/${wf.workflow.id}/deploy`, { versionId: wf.version.id, environment: 'staging' }));
    const r = (await must(post(`/internal/workflows/${wf.workflow.id}/runs`, { environment: 'staging', kind: 'test' }))).json();
    expect((await must(reply(r.id, 'I will go to the ombudsman'))).json()).toMatchObject({ status: 'ended', outcome: 'handoff_human' });
    const other = (await must(post(`/internal/workflows/${workflowId}/runs`, { environment: 'staging', kind: 'test', variables: { name: 'A' } }))).json();
    expect((await must(reply(other.id, 'yes the ombudsman'))).json().outcome).toBe('paid_promise');
  });
});
