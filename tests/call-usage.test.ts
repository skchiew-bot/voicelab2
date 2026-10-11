import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db.js';
import { costCall, costPendingCalls, COST_WAIT_MS } from '../src/store/calls.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';

// A call's cost record holds everything the call used: the phone line, Twilio's speech relay (its minutes and the
// characters it synthesised, priced by "relay" lines on the Twilio provider's own rates) and the AI models its
// decisions used (priced by a model provider per model). Only the phone line draws the client's credits.

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let twilioId: string; let wfId: string;

async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}
const post = (url: string, body: unknown) => env.call(env.staffToken, 'POST', url, body);

const flow: WorkflowDefinition = { start: 'hi', variables: [], nodes: {
  hi: { type: 'speak', speech: 'fixed', text: 'Hello from Voice Lab.', transitions: [{ to: 'ask' }] },         // 21 characters
  ask: { type: 'speak', speech: 'fixed', text: 'Can you pay this week?', listen: { captureAs: 'a', intents: { yes: ['yes'] } }, transitions: [{ to: 'done' }] },   // 22
  done: { type: 'end', outcome: 'promised' },
} };

const PHONE = { component: 'telephony_leg', unit: 'per_minute', rate: '0.0085', currency: 'USD' };
const RELAY_MINUTE = { component: 'platform', unit: 'per_minute', rate: '0.07', currency: 'USD', billingLine: 'relay' };
const RELAY_CHARS = { component: 'tts', unit: 'per_1k_characters', rate: '0.30', currency: 'USD', billingLine: 'relay' };

/** A Twilio provider with these rates from the start of the year. */
async function twilio(name: string, components: object[]) {
  const id = (await must(post('/internal/providers', { adapterKey: 'twilio', name, params: { accountSid: 'AC1', authToken: 'FAKE_TOKEN_tw', twimlAppVoiceUrl: 'https://voicelab.test/v' } }))).json().id as string;
  await must(post(`/internal/providers/${id}/charging`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 60, components }));
  return id;
}

/** A model provider for one model id, with its token rates from the start of the year. */
async function modelProvider(model: string, input: string, output: string | null = null) {
  const id = (await must(post('/internal/providers', { adapterKey: 'anthropic', name: model, params: { model } }))).json().id as string;
  await must(post(`/internal/providers/${id}/charging`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1, components: [
    { component: 'llm', unit: 'per_1m_tokens', rate: input, currency: 'USD', billingLine: 'input' },
    ...(output ? [{ component: 'llm', unit: 'per_1m_tokens', rate: output, currency: 'USD', billingLine: 'output' }] : []),
  ] }));
  return id;
}

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  tenantId = (await must(post('/internal/tenants', { name: 'Usage Co' }))).json().id;
  twilioId = await twilio('tw-usage', [PHONE, RELAY_MINUTE, RELAY_CHARS]);
  await must(post('/internal/fx', { currency: 'MYR', perUsd: '4.5', effectiveFrom: '2026-01-01T00:00:00Z' }));
  await must(post('/internal/rate-card', { effectiveFrom: '2026-01-01T00:00:00Z', inboundCreditsPerMinute: '1', outboundCreditsPerMinute: '2', creditValueUsd: '0.01' }));
  const w = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'usage_flow', definition: flow }))).json();
  wfId = w.workflow.id;
  await must(post(`/internal/workflows/${wfId}/deploy`, { versionId: w.version.id, environment: 'staging' }));
  await must(post(`/internal/workflows/${wfId}/simulate`, { scenarios: [{ name: 's', variables: {}, replies: ['yes'], expect: { outcome: 'promised' } }] }));
  await must(post(`/internal/workflows/${wfId}/deploy`, { versionId: w.version.id, environment: 'production' }));
});
afterAll(async () => { await env?.teardown(); });

/** A finished inbound call of `seconds`, ended `agoMs` ago, as the call-control flow leaves it, not yet costed. */
async function finishedCall(seconds: number, provider = twilioId, agoMs = 60_000) {
  const id = randomUUID();
  const ended = new Date(Date.now() - agoMs);
  const started = new Date(ended.getTime() - seconds * 1000);
  await env.pool.query(
    `INSERT INTO calls (id, tenant_id, provider_id, provider_call_id, direction, status, started_at, answered_at, ended_at, duration_seconds)
     VALUES ($1,$2,$3,$4,'inbound','completed',$5,$5,$6,$7)`, [id, tenantId, provider, `CA_${id.slice(0, 8)}`, started, ended, seconds]);
  return { id, started, ended };
}
const event = (callId: string, type: string, at: Date, payload: object = {}) => env.pool.query(
  `INSERT INTO call_events (tenant_id, call_id, type, payload, occurred_at) VALUES ($1,$2,$3,$4,$5)`, [tenantId, callId, type, payload, at]);
const decision = (callId: string, model: string | null, input: number, output: number, o: { task?: string; at?: Date } = {}) => env.pool.query(
  `INSERT INTO ai_decisions (tenant_id, task, subject_type, subject_id, decision, reason, model, tier, input_tokens, output_tokens, call_id, at)
   VALUES ($1,$7,'call',$2::text,'proceeded','read the turn',$3,$4,$5,$6,$2::uuid,coalesce($8, now()))`,
  [tenantId, callId, model, model ? 'haiku' : 'rules', input, output, o.task ?? 'speak_dynamic', o.at ?? null]);
const cost = async (callId: string) => (await env.call(env.staffToken, 'POST', `/internal/calls/${callId}/cost/retry`, {})).json().cost_status as string;
const status = async (callId: string) => (await env.pool.query('SELECT cost_status, cost_error FROM calls WHERE id = $1', [callId])).rows[0];
const lines = async (callId: string) => (await env.pool.query(
  `SELECT l.provider_id, l.component || ':' || l.billing_line AS line, l.quantity, l.amount::text AS amount FROM call_cost_lines l JOIN call_costs k ON k.id = l.call_cost_id
    WHERE k.call_id = $1 AND k.status = 'estimated' ORDER BY l.id`, [callId])).rows as { provider_id: string; line: string; quantity: string; amount: string }[];
const credits = async (callId: string) => (await env.pool.query(`SELECT credits::text FROM credit_entries WHERE ref = $1`, [`call:${callId}`])).rows;

describe('a call\'s cost record holds everything the call used', () => {
  it('prices the tokens each model used at the rates of that model, as our cost only, and leaves out work about the call done later', async () => {
    const small = await modelProvider('test-model-small', '1.00', '5.00');
    const medium = await modelProvider('test-model-medium', '3.00', '15.00');
    const call = await finishedCall(120);
    await decision(call.id, 'test-model-small', 1000, 200);
    await decision(call.id, 'test-model-small', 500, 100);
    await decision(call.id, 'test-model-medium', 2000, 400);
    await decision(call.id, null, 0, 0);                                         // a decision the rules made: nothing to price
    // scoring the call afterwards is not the call's cost, even with a model nothing prices; nor is anything long after it ended
    await decision(call.id, 'test-model-unpriced-qa', 9000, 900, { task: 'qa_judge' });
    await decision(call.id, 'test-model-unpriced-later', 9000, 900, { at: new Date(call.ended.getTime() + 10 * 60_000) });
    expect(await cost(call.id)).toBe('recorded');
    const ls = await lines(call.id);
    // worked out by hand: 1500 input tokens at 1.00 per million, 300 output at 5.00; 2000 at 3.00, 400 at 15.00
    expect(ls.filter((l) => l.provider_id === small).map((l) => [l.line, l.amount]).sort()).toEqual([['llm:input', '0.00150000'], ['llm:output', '0.00150000']]);
    expect(ls.filter((l) => l.provider_id === medium).map((l) => [l.line, l.amount]).sort()).toEqual([['llm:input', '0.00600000'], ['llm:output', '0.00600000']]);
    expect(await credits(call.id)).toEqual([{ credits: '-2.0000' }]);           // credits follow the phone line: 2 inbound minutes
    expect(await cost(call.id)).toBe('recorded');                                // priced once: asked again, nothing changes
    expect(await credits(call.id)).toEqual([{ credits: '-2.0000' }]);
  });

  it('refuses to cost a call whose model nothing prices, or prices only in part, saying which, and costs them all again on one request', async () => {
    const unpriced = await finishedCall(60);
    await decision(unpriced.id, 'test-model-later', 100, 10);
    const half = await finishedCall(60);
    await modelProvider('test-model-half', '1.00');                              // input tokens only: output would be costed as nothing
    await decision(half.id, 'test-model-half', 100, 10);
    const nameless = await finishedCall(60);
    await decision(nameless.id, null, 50, 5);
    for (const id of [unpriced.id, half.id, nameless.id]) expect(await cost(id)).toBe('failed');
    expect((await status(unpriced.id)).cost_error).toContain('"test-model-later"');
    expect((await status(half.id)).cost_error).toContain('output tokens');
    expect(await lines(unpriced.id)).toEqual([]);
    expect(await credits(unpriced.id)).toEqual([]);                              // nothing drawn for a call not costed
    // the missing rate is entered: one request costs again every call that failed
    await modelProvider('test-model-later', '1.00', '1.00');
    const r = (await must(post('/internal/calls/cost/retry-failed', {}))).json();
    expect(r).toMatchObject({ recorded: 1, failed: 2 });
    expect((await status(unpriced.id)).cost_status).toBe('recorded');
    // one provider per model, so which rate applies is never unclear
    expect((await post('/internal/providers', { adapterKey: 'anthropic', name: 'again', params: { model: 'test-model-later' } })).statusCode).toBe(409);
    expect((await post('/internal/providers', { adapterKey: 'anthropic', name: 'no-model', params: {} })).statusCode).toBe(400);
  });

  it('prices the speech relay on the Twilio provider, by its minutes on the call and every character it synthesised', async () => {
    const call = await finishedCall(180);
    // the relay connected 10 seconds in and closed after 90 seconds on the line
    await event(call.id, 'relay.connected', new Date(call.started.getTime() + 10_000));
    await event(call.id, 'relay.closed', new Date(call.started.getTime() + 100_000));
    // the workflow runs live on the call: it says its greeting and asks its question (21 + 22 characters)
    await must(post(`/internal/workflows/${wfId}/runs`, { environment: 'production', kind: 'live', variables: {}, callId: call.id }));
    await event(call.id, 'relay.said_again', new Date(call.started.getTime() + 60_000), { lines: 1, synthChars: 22 });   // a reconnected line asked again
    expect(await cost(call.id)).toBe('recorded');
    // the phone line (3 minutes) and the relay (90 s billed by the minute, 65 characters), all on Twilio, which bills them
    expect((await lines(call.id)).map((l) => [l.line, l.provider_id === twilioId, l.quantity, l.amount]).sort()).toEqual([
      ['platform:relay', true, '120s', '0.14000000'],
      ['telephony_leg:main', true, '180s', '0.02550000'],
      ['tts:relay', true, '65', '0.01950000'],
    ]);
    expect(await credits(call.id)).toEqual([{ credits: '-3.0000' }]);           // 3 inbound minutes: the relay draws none
  });

  it('counts the relay to the end of the call: a close after it, or a reconnect that never closed', async () => {
    const late = await finishedCall(30);
    await event(late.id, 'relay.connected', new Date(late.started.getTime() + 5_000));
    await event(late.id, 'relay.closed', new Date(late.ended.getTime() + 120_000));     // the socket closed well after the call ended
    expect(await cost(late.id)).toBe('recorded');
    expect((await lines(late.id)).filter((l) => l.line === 'platform:relay').map((l) => l.quantity)).toEqual(['60s']);   // 25 s: one minute

    const crashed = await finishedCall(300);
    await event(crashed.id, 'relay.connected', crashed.started);
    await event(crashed.id, 'relay.closed', new Date(crashed.started.getTime() + 30_000));
    await event(crashed.id, 'relay.connected', new Date(crashed.started.getTime() + 31_000));   // took the call over; its server stopped
    expect(await cost(crashed.id)).toBe('recorded');
    expect((await lines(crashed.id)).filter((l) => l.line === 'platform:relay').map((l) => l.quantity)).toEqual(['300s']);
  });

  it('refuses a relay call whose Twilio rates have no relay line, or none for its characters, and costs a call without the relay as before', async () => {
    const bare = await twilio('tw-no-relay', [PHONE]);
    const none = await finishedCall(60, bare);
    await event(none.id, 'relay.connected', none.started);
    expect(await cost(none.id)).toBe('failed');
    expect((await status(none.id)).cost_error).toContain('"relay" billing line');
    const minutesOnly = await twilio('tw-relay-minutes', [PHONE, RELAY_MINUTE]);
    const spoke = await finishedCall(60, minutesOnly);
    await event(spoke.id, 'relay.connected', spoke.started);
    await event(spoke.id, 'relay.said_again', spoke.started, { lines: 1, synthChars: 40 });
    expect(await cost(spoke.id)).toBe('failed');
    expect((await status(spoke.id)).cost_error).toContain('characters');
    const plain = await finishedCall(60, bare);
    expect(await cost(plain.id)).toBe('recorded');
    expect((await lines(plain.id)).map((l) => l.line)).toEqual(['telephony_leg:main']);
  });

  it('waits to cost a call while the relay still holds it, then costs it once it lets go, or after five minutes if it never does', async () => {
    const deps = { pool: env.pool } as Parameters<typeof costPendingCalls>[0];
    const held = await finishedCall(60, twilioId, 0);
    await env.pool.query('UPDATE calls SET relay_owner = $2 WHERE id = $1', [held.id, randomUUID()]);
    expect(await withActor(env.pool, { kind: 'internal' }, (c) => costCall(c, null, held.id))).toBe('pending');
    expect(await status(held.id)).toMatchObject({ cost_status: 'pending' });
    // a reply landing after the end is still counted, since nothing has been priced yet
    await decision(held.id, 'test-model-small', 1000, 0);
    await env.pool.query('UPDATE calls SET relay_owner = NULL WHERE id = $1', [held.id]);
    expect(await costPendingCalls(deps)).toMatchObject({ recorded: 1 });
    expect((await lines(held.id)).some((l) => l.line === 'llm:input')).toBe(true);

    // a relay that never lets go (its server stopped) does not hold the cost for ever
    const stuck = await finishedCall(60, twilioId, COST_WAIT_MS + 1000);
    await env.pool.query(`UPDATE calls SET relay_owner = $2 WHERE id = $1`, [stuck.id, randomUUID()]);
    expect(await costPendingCalls(deps)).toMatchObject({ recorded: 1 });
    expect((await status(stuck.id)).cost_status).toBe('recorded');
  });

  it('keeps model providers out of call control: nothing to drain, fail over or prefer', async () => {
    const id = await modelProvider('test-model-control', '1.00', '1.00');
    for (const action of ['drain', 'force_failover', 'set_preferred']) {
      const r = await post('/internal/control-tower/actions', { action, providerId: id, reason: 'testing a model provider' });
      expect(r.statusCode, action).toBe(400);
      expect(r.json().error, action).toContain('is a model provider');
    }
  });

  it('ends the relay time only at a close by the connection serving the call, not one standing by', async () => {
    const call = await finishedCall(240);
    await event(call.id, 'relay.connected', call.started);
    await event(call.id, 'relay.closed', new Date(call.started.getTime() + 30_000), { finished: false, owner: false });   // a standby went away
    expect(await cost(call.id)).toBe('recorded');
    expect((await lines(call.id)).filter((l) => l.line === 'platform:relay').map((l) => l.quantity)).toEqual(['240s']);
  });

  it('checks a relay call against Twilio by its phone line alone, since Twilio prices the relay as its own item', async () => {
    const call = await finishedCall(180);
    await event(call.id, 'relay.connected', call.started);
    await event(call.id, 'relay.closed', call.ended, { finished: true, owner: true });
    expect(await cost(call.id)).toBe('recorded');
    // Twilio's price for the call: 3 minutes at 0.0085, the phone line only
    env.provider.state.respond = () => new Response(JSON.stringify({ duration: '180', price: '-0.0255', price_unit: 'USD' }), { status: 200 });
    const r = await env.call(env.staffToken, 'POST', `/internal/calls/${call.id}/reconcile`, { source: 'provider_api' });
    expect(r.json()).toMatchObject({ outcome: 'matched' });
  });

  it('does not cost a caller timed out of the queue before the provider says how long they were held, and a retry never forces a call still pending', async () => {
    const queued = await finishedCall(0, twilioId, COST_WAIT_MS + 60_000);
    await env.pool.query(`UPDATE calls SET end_reason = 'queue_timeout', duration_seconds = NULL WHERE id = $1`, [queued.id]);
    await costPendingCalls({ pool: env.pool } as Parameters<typeof costPendingCalls>[0]);
    expect((await status(queued.id)).cost_status).toBe('pending');

    const held = await finishedCall(60, twilioId, 0);
    await env.pool.query('UPDATE calls SET relay_owner = $2 WHERE id = $1', [held.id, randomUUID()]);
    expect(await cost(held.id)).toBe('pending');                                 // an operator's retry seconds after the end
    expect((await status(held.id)).cost_status).toBe('pending');
  });

  it('leaves a call the relay still holds pending when Twilio reports its end, and costs it once the relay lets go', async () => {
    const id = randomUUID(); const sid = `CA_hook_${id.slice(0, 6)}`;
    await env.pool.query(
      `INSERT INTO calls (id, tenant_id, provider_id, provider_call_id, direction, status, started_at, answered_at, relay_owner)
       VALUES ($1,$2,$3,$4,'inbound','in_progress',now() - interval '2 minutes',now() - interval '2 minutes',$5)`, [id, tenantId, twilioId, sid, randomUUID()]);
    const params = { CallSid: sid, CallStatus: 'completed', CallDuration: '120', Direction: 'inbound' };
    const path = `/webhooks/twilio/${twilioId}/status`;
    const sig = createHmac('sha1', 'FAKE_TOKEN_tw').update('https://voicelab.test' + path + Object.keys(params).sort().map((k) => k + params[k as keyof typeof params]).join('')).digest('base64');
    const r = await env.app.inject({ method: 'POST', url: path, payload: new URLSearchParams(params).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig } });
    expect(r.statusCode).toBe(204);
    expect(await status(id)).toMatchObject({ cost_status: 'pending' });
    await env.pool.query('UPDATE calls SET relay_owner = NULL WHERE id = $1', [id]);
    await costPendingCalls({ pool: env.pool } as Parameters<typeof costPendingCalls>[0]);
    expect((await status(id)).cost_status).toBe('recorded');
  });
});
