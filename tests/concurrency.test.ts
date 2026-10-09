import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db.js';
import { parseKey } from '../src/secrets.js';
import { loadProvider, processWebhook, type CallDeps } from '../src/store/calls.js';
import { dncKeyFrom } from '../src/store/dnc.js';
import type { NormalizedEvent } from '../src/telephony/types.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env;
let tenantId: string; let twilioId: string; let telnyxId: string; let voiceId: string;
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

let sid = 0;
let failTelnyx = false;
const answer = () => {
  env.provider.state.respond = (url) => {
    if (url.includes('/Calls.json')) return new Response(JSON.stringify({ sid: `CA_c_${++sid}` }), { status: 201 });
    if (url.endsWith('/v2/calls')) return failTelnyx ? new Response('{"errors":[{"detail":"upstream unavailable"}]}', { status: 503 }) : new Response(JSON.stringify({ data: { call_control_id: `cc_c_${++sid}` } }));
    return new Response('{}');
  };
};
const dials = () => env.provider.calls.filter((c) => c.url.includes('/Calls.json') || c.url.endsWith('/v2/calls'));
const usedProvider = (c: { url: string }) => (c.url.includes('/Calls.json') ? twilioId : telnyxId);
const contact = (() => { let n = 0; return () => `+6012${String(7000000 + ++n)}`; })();
const dial = (tenant: string, body: object = {}) => post('/internal/calls/outbound', { tenantId: tenant, country: 'MY', to: contact(), ...body });
const row = async (callId: string) => (await env.pool.query('SELECT * FROM calls WHERE id = $1', [callId])).rows[0];
const finish = async (callId: string, seconds = 60) => {
  await env.pool.query(`UPDATE calls SET status = 'completed', answered_at = now() - make_interval(secs => $2), ended_at = now(), duration_seconds = $2 WHERE id = $1`, [callId, seconds]);
};
async function freshTenant(name: string, numbers: [string, string][]) {
  const t = (await must(post('/internal/tenants', { name }))).json().id as string;
  for (const [providerId, e164] of numbers) await must(post('/internal/numbers', { providerId, e164, tenantId: t, country: 'MY' }));
  return t;
}
const clearActive = () => env.pool.query(`UPDATE calls SET status = 'completed', ended_at = coalesce(ended_at, now()) WHERE status IN ('dialing', 'ringing', 'in_progress', 'queued')`);
const resetHealth = () => env.pool.query('DELETE FROM provider_health');

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  twilioId = (await must(post('/internal/providers', { adapterKey: 'twilio', name: 'tw', params: { accountSid: 'AC1', authToken: 'tok', twimlAppVoiceUrl: `${BASE}/v` } }))).json().id;
  telnyxId = (await must(post('/internal/providers', { adapterKey: 'telnyx', name: 'tx', params: { apiKey: 'KEY', webhookUrl: `${BASE}/h`, connectionId: 'c1', webhookPublicKey: 'AAAA' } }))).json().id;
  voiceId = (await must(post('/internal/providers', { adapterKey: 'elevenlabs', name: 'el', params: { apiKey: 'k' } }))).json().id;
  void voiceId;
  const rates = (id: string, rate: string, limit: number, burst: number) => post(`/internal/providers/${id}/charging`, {
    effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1, concurrencyLimit: limit, burstPremiumMultiplier: burst,
    components: [{ component: 'telephony_leg', unit: 'per_minute', rate, currency: 'USD' }],
  });
  await must(rates(telnyxId, '0.0060', 2, 2)); await must(rates(twilioId, '0.0120', 3, 1.5));
  await must(post('/internal/fx', { currency: 'MYR', perUsd: '4.5', effectiveFrom: '2026-01-01T00:00:00Z' }));
  await must(post('/internal/rate-card', { effectiveFrom: '2026-01-01T00:00:00Z', inboundCreditsPerMinute: '1', outboundCreditsPerMinute: '2', creditValueUsd: '0.01' }));
  await must(post('/internal/dnc/registries', { country: 'MY', requirement: 'registry', source: 'test' }));
  answer();
});
afterAll(async () => { await env?.teardown(); });

describe('concurrency ceilings: never over the limit, no burst charge', () => {
  it('sends calls to the cheapest provider until its ceiling, then to one with room, and prices none at a premium', async () => {
    const t = await freshTenant('Ceil Co', [[telnyxId, '+60300000001'], [telnyxId, '+60300000002'], [twilioId, '+60300000003'], [twilioId, '+60300000004']]);
    env.provider.calls.length = 0;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await must(dial(t))).json().callId);
    const by = dials().map(usedProvider);
    expect(by.filter((p) => p === telnyxId)).toHaveLength(2);          // Telnyx's ceiling is 2
    expect(by.filter((p) => p === twilioId)).toHaveLength(3);          // the rest go where there is room (Twilio's ceiling is 3)
    expect(by.slice(0, 2)).toEqual([telnyxId, telnyxId]);              // cheapest first
    for (const id of ids) expect((await row(id)).burst).toBe(false);

    // finish them all and price them: not one line carries a burst multiplier
    for (const id of ids) { await finish(id); expect((await post(`/internal/calls/${id}/cost/retry`)).json().cost_status).toBe('recorded'); }
    const lines = (await env.pool.query(`SELECT l.burst_multiplier FROM call_cost_lines l JOIN call_costs c ON c.id = l.call_cost_id WHERE c.call_id = ANY($1)`, [ids])).rows;
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.burst_multiplier === null)).toBe(true);
    await clearActive();
  });

  it('holds a dial back, with a retry time, when every provider is full, and records nothing and contacts nobody', async () => {
    await clearActive();
    const t = await freshTenant('Full Co', [[telnyxId, '+60300000011'], [twilioId, '+60300000012']]);
    for (let i = 0; i < 5; i++) await must(dial(t));                    // 2 + 3 = every channel
    env.provider.calls.length = 0;
    const before = (await env.pool.query('SELECT count(*)::int AS n FROM calls')).rows[0].n;
    const held = await dial(t);
    expect(held.statusCode).toBe(429);
    expect(held.headers['retry-after']).toBe('10');
    expect(held.json()).toMatchObject({ deferred: true, status: 'deferred', retryAfterSeconds: 10 });
    expect(dials()).toHaveLength(0);
    expect((await env.pool.query('SELECT count(*)::int AS n FROM calls')).rows[0].n).toBe(before);
    expect((await env.pool.query(`SELECT detail FROM failover_events WHERE scope = 'telephony' AND trigger = 'capacity' ORDER BY id DESC LIMIT 1`)).rows[0].detail).toMatchObject({ reason: 'at_capacity' });
    const cap = (await get('/internal/capacity')).json();
    expect(cap.find((c: { providerId: string }) => c.providerId === telnyxId)).toMatchObject({ active: 2, ceiling: 2 });

    // a channel frees: the next dial goes through
    const one = (await env.pool.query(`SELECT id FROM calls WHERE provider_id = $1 AND status = 'dialing' LIMIT 1`, [telnyxId])).rows[0].id;
    await finish(one);
    expect((await dial(t)).statusCode).toBe(201);
    await clearActive();
  });

  it('never exceeds the ceiling when dials arrive at the same moment', async () => {
    await clearActive();
    const t = await freshTenant('Burst Co', [[telnyxId, '+60300000021'], [twilioId, '+60300000022']]);
    const results = await Promise.all(Array.from({ length: 12 }, () => dial(t)));
    expect(results.filter((r) => r.statusCode === 201)).toHaveLength(5);   // 2 + 3
    expect(results.filter((r) => r.statusCode === 429)).toHaveLength(7);
    const cap = (await get('/internal/capacity')).json();
    for (const c of cap) expect(c.active).toBeLessThanOrEqual(c.ceiling);
    await clearActive();
  });

  it('takes a call beyond the ceiling only for a client that agreed to the premium, and says so in its cost', async () => {
    await clearActive();
    const t = await freshTenant('Premium Co', [[telnyxId, '+60300000031']]);
    await must(put(`/internal/tenants/${t}/entitlement`, { inboundChannels: 5, overburstMultiplier: '1.5' }));
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await must(dial(t, { providerId: telnyxId }))).json().callId);
    expect(await Promise.all(ids.map(async (id) => (await row(id)).burst))).toEqual([false, false, true]);   // the third is over Telnyx's ceiling of 2
    expect((await row(ids[2]!)).credit_multiplier).toBe('1.500');
    for (const id of [ids[0]!, ids[2]!]) { await finish(id, 60); await post(`/internal/calls/${id}/cost/retry`); }
    const cost = async (id: string) => (await get(`/internal/calls/${id}/cost`)).json();
    const normal = await cost(ids[0]!); const over = await cost(ids[2]!);
    expect(normal.lines[0].burst_multiplier).toBeNull();
    expect(over.lines[0].burst_multiplier).toBe('2.000');                        // the provider's premium
    expect(Number(over.total_usd)).toBeCloseTo(Number(normal.total_usd) * 2, 8);
    expect(Number(over.credits_drawn)).toBeCloseTo(Number(normal.credits_drawn) * 1.5, 4);   // the client's agreed premium
    await clearActive();
  });
});

describe('telephony failover between Twilio and Telnyx', () => {
  it('tries the other provider when the cheaper one fails to place the call, and stops sending to a provider that keeps failing', async () => {
    await clearActive(); await resetHealth();
    const t = await freshTenant('Failover Co', [[telnyxId, '+60300000041'], [twilioId, '+60300000042']]);
    failTelnyx = true; env.provider.calls.length = 0;
    const first = (await must(dial(t))).json();
    expect(dials().map(usedProvider)).toEqual([telnyxId, twilioId]);              // Telnyx refused; Twilio took it
    expect((await row(first.callId)).provider_id).toBe(twilioId);
    expect((await row(first.callId)).status).toBe('dialing');
    const events = (await get(`/internal/calls/${first.callId}/events`)).json().map((e: { type: string }) => e.type);
    expect(events).toContain('failover.telephony');

    await clearActive();
    for (let i = 0; i < 2; i++) { await must(dial(t)); await clearActive(); }   // two more failures: three errors in the window
    expect((await env.pool.query('SELECT state FROM provider_health WHERE provider_id = $1', [telnyxId])).rows[0].state).toBe('failed');
    env.provider.calls.length = 0;
    await must(dial(t));
    expect(dials().map(usedProvider)).toEqual([twilioId]);                        // Telnyx is no longer even tried
    failTelnyx = false;
    await clearActive();
  });

  it('refuses plainly, without contacting a provider, when every provider is failed or unfunded', async () => {
    await clearActive(); await resetHealth();
    const t = await freshTenant('Down Co', [[telnyxId, '+60300000051'], [twilioId, '+60300000052']]);
    await must(post(`/internal/providers/${telnyxId}/funding`, { kind: 'topup', amount: '5', currency: 'USD' }));
    await must(post(`/internal/providers/${telnyxId}/funding`, { kind: 'usage', amount: '-5', currency: 'USD' }));     // out of funding: at once
    await must(post(`/internal/providers/${twilioId}/samples`, { kind: 'error' }));
    await must(post(`/internal/providers/${twilioId}/samples`, { kind: 'error' }));
    await must(post(`/internal/providers/${twilioId}/samples`, { kind: 'error' }));
    env.provider.calls.length = 0;
    const r = await dial(t);
    expect(r.statusCode).toBe(503);
    expect(dials()).toHaveLength(0);
    expect((await env.pool.query(`SELECT status, end_reason, cost_status FROM calls WHERE end_reason = 'providers_unhealthy'`)).rows).toEqual([{ status: 'failed', end_reason: 'providers_unhealthy', cost_status: 'not_applicable' }]);
    const tower = (await get('/internal/control-tower')).json();
    expect(tower.alerts.filter((a: { code: string }) => a.code === 'provider_unhealthy')).toHaveLength(2);
    expect(tower.alerts.some((a: { code: string }) => a.code === 'provider_failing')).toBe(false);   // a refusal is not the provider failing

    // topped up and probed back: it takes calls again, only after proving itself
    await must(post(`/internal/providers/${telnyxId}/funding`, { kind: 'topup', amount: '100', currency: 'USD' }));
    expect((await env.pool.query('SELECT state FROM provider_health WHERE provider_id = $1', [telnyxId])).rows[0].state).toBe('failed');   // on probation
    await resetHealth();
    await clearActive();
  });
});

describe('inbound entitlement and the waiting queue', () => {
  let deps: CallDeps; let telnyx: Awaited<ReturnType<typeof loadProvider>>;
  const OUR = '+60300000061';
  let tenant: string;
  const key = () => parseKey(env.config.VOICELAB_SECRET_KEY);
  const ev = (kind: NormalizedEvent['kind'], providerCallId: string, extra: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
    key: randomUUID(), providerCallId, kind, direction: 'inbound', occurredAt: new Date(), transient: { to: OUR, from: '+60129990000' }, ...extra,
  });
  const send = (e: NormalizedEvent) => processWebhook(deps, telnyx!, e);
  const status = async (pcid: string) => (await env.pool.query('SELECT status, end_reason, burst, credit_multiplier FROM calls WHERE provider_call_id = $1', [pcid])).rows[0];

  beforeAll(async () => {
    tenant = await freshTenant('Inbound Co', [[telnyxId, OUR]]);
    deps = { pool: env.pool, key: key(), dncKey: dncKeyFrom(key()), http: env.provider.fetch, baseUrl: BASE };
    telnyx = await withActor(env.pool, { kind: 'internal' }, (c) => loadProvider(c, telnyxId));
  });

  it('serves calls up to the client\'s channels, queues the next, plays it a hold message and does not hang up on it', async () => {
    await clearActive();
    await must(put(`/internal/tenants/${tenant}/entitlement`, { inboundChannels: 1, extraChannels: 1 }));
    for (const id of ['in1', 'in2']) { expect((await send(ev('initiated', id))).actions[0]).toMatchObject({ action: 'answer' }); await send(ev('answered', id)); }
    const third = await send(ev('initiated', 'in3'));
    expect(third.actions[0]).toMatchObject({ action: 'answer' });              // answered, to be held
    expect((await status('in1')).status).toBe('in_progress');
    expect((await status('in3')).status).toBe('queued');
    const answered = await send(ev('answered', 'in3'));
    expect(answered.actions[0]).toMatchObject({ action: 'speak', body: { payload: expect.stringContaining('busy') } });
    expect((await status('in3')).status).toBe('queued');                        // answering the hold does not start service
    expect((await send(ev('speak_ended', 'in3'))).actions).toEqual([]);          // and finishing the hold message does not hang up
    expect((await get('/internal/control-tower')).json().alerts.some((a: { code: string }) => a.code === 'calls_queued')).toBe(true);
  });

  it('moves the longest-waiting caller up when a channel frees', async () => {
    await send(ev('initiated', 'in4'));
    expect((await status('in4')).status).toBe('queued');
    await send(ev('ended', 'in1', { durationSeconds: 30, endReason: 'completed' }));
    expect((await status('in3')).status).toBe('in_progress');                    // in3 waited longest
    expect((await status('in4')).status).toBe('queued');
    await send(ev('ended', 'in2', { durationSeconds: 30, endReason: 'completed' }));
    expect((await status('in4')).status).toBe('in_progress');
  });

  it('ends a caller who hangs up while waiting as abandoned, not as served', async () => {
    await clearActive();
    await send(ev('initiated', 'in5')); await send(ev('answered', 'in5')); await send(ev('initiated', 'in6')); await send(ev('initiated', 'in7'));
    expect((await status('in7')).status).toBe('queued');
    await send(ev('ended', 'in7', { durationSeconds: 0, endReason: 'canceled' }));
    expect(await status('in7')).toMatchObject({ status: 'unanswered', end_reason: 'abandoned_in_queue' });
  });

  it('does not leave a caller waiting for ever: they are ended and a callback request is recorded', async () => {
    await clearActive();
    for (const id of ['in8', 'in9']) { await send(ev('initiated', id)); await send(ev('answered', id)); }      // both channels in use
    await send(ev('initiated', 'in10')); await send(ev('initiated', 'in13'));
    await env.pool.query(`UPDATE calls SET queued_at = now() - interval '10 minutes' WHERE provider_call_id = 'in10'`);
    expect((await post('/internal/queue/expire', { maxWaitSeconds: 300 })).json()).toEqual({ expired: 1 });
    expect(await status('in10')).toMatchObject({ status: 'unanswered', end_reason: 'queue_timeout' });
    expect((await status('in13')).status).toBe('queued');                         // not waited long enough
    const cb = (await env.pool.query(`SELECT reason FROM callback_requests WHERE call_id = (SELECT id FROM calls WHERE provider_call_id = 'in10')`)).rows;
    expect(cb).toEqual([{ reason: 'waited too long for a channel' }]);
  });

  it('takes a call beyond the channels at the agreed premium instead of queueing it, when the client has agreed one', async () => {
    await clearActive();
    await must(put(`/internal/tenants/${tenant}/entitlement`, { inboundChannels: 1, overburstMultiplier: '2' }));
    await send(ev('initiated', 'in11')); await send(ev('answered', 'in11'));
    await send(ev('initiated', 'in12'));
    expect(await status('in12')).toMatchObject({ status: 'ringing', credit_multiplier: '2.000' });
  });

  it('does not limit a client that has no entitlement set', async () => {
    await clearActive();
    const free = await freshTenant('Unlimited Co', [[telnyxId, '+60300000071']]);
    void free;
    const e2 = (id: string) => ({ ...ev('initiated', id), transient: { to: '+60300000071', from: '+60129990000' } });
    for (const id of ['u1', 'u2', 'u3', 'u4']) await send(e2(id));
    expect((await env.pool.query(`SELECT count(*)::int AS n FROM calls WHERE provider_call_id LIKE 'u%' AND status = 'ringing'`)).rows[0].n).toBe(4);
  });
});

describe('extra channels are charged to credits once a month', () => {
  it('charges once per month, however often it is asked, and a different month charges again', async () => {
    const t = (await must(post('/internal/tenants', { name: 'Channels Co' }))).json().id;
    await must(put(`/internal/tenants/${t}/entitlement`, { inboundChannels: 2, extraChannels: 3, extraChannelCredits: '2.5' }));
    const balance = async () => Number((await env.pool.query(`SELECT coalesce(sum(credits), 0) AS b FROM credit_entries WHERE tenant_id = $1`, [t])).rows[0].b);
    const first = (await must(post(`/internal/tenants/${t}/channel-charges`, { month: '2026-07' }))).json();
    expect(first).toEqual({ charged: true, extraChannels: 3, credits: '7.5000' });
    expect(await balance()).toBe(-7.5);
    const again = (await must(post(`/internal/tenants/${t}/channel-charges`, { month: '2026-07' }))).json();
    expect(again.charged).toBe(false);
    await Promise.all([post(`/internal/tenants/${t}/channel-charges`, { month: '2026-08' }), post(`/internal/tenants/${t}/channel-charges`, { month: '2026-08' })]);
    expect(await balance()).toBe(-15);                                              // two months, one charge each
    expect((await post(`/internal/tenants/${t}/channel-charges`, { month: '2026-13' })).statusCode).toBe(400);
    const none = (await must(post('/internal/tenants', { name: 'No Extras Co' }))).json().id;
    expect((await must(post(`/internal/tenants/${none}/channel-charges`, { month: '2026-07' }))).json().charged).toBe(false);
  });
});

describe('funding-health monitor', () => {
  it('alerts at the levels someone set, before the balance reaches zero, and not at levels nobody chose', async () => {
    const p = (await must(post('/internal/providers', { adapterKey: 'openai', name: 'oa-monitor', params: { apiKey: 'k' } }))).json().id;
    await must(post(`/internal/providers/${p}/funding`, { kind: 'topup', amount: '100', currency: 'USD' }));
    const level = async () => (await get('/internal/funding/status')).json().find((f: { providerId: string }) => f.providerId === p).level;
    const alerts = async () => (await get('/internal/control-tower')).json().alerts.filter((a: { code: string; message: string }) => a.message.startsWith('oa-monitor')).map((a: { code: string }) => a.code);
    expect(await level()).toBe('ok');
    await must(put(`/internal/providers/${p}/funding-thresholds`, { currency: 'usd', warnBelow: '50', criticalBelow: '10' }));
    expect(await level()).toBe('ok');
    await must(post(`/internal/providers/${p}/funding`, { kind: 'usage', amount: '-60', currency: 'USD' }));    // 40
    expect(await level()).toBe('warn');
    expect(await alerts()).toEqual(['funding_low']);
    await must(post(`/internal/providers/${p}/funding`, { kind: 'usage', amount: '-35', currency: 'USD' }));    // 5
    expect(await level()).toBe('critical');
    expect(await alerts()).toEqual(['funding_critical']);
    expect((await env.pool.query('SELECT state FROM provider_health WHERE provider_id = $1', [p])).rows[0]).toBeUndefined();   // not failed over yet: still funded
    await must(post(`/internal/providers/${p}/funding`, { kind: 'usage', amount: '-5', currency: 'USD' }));     // 0
    expect(await level()).toBe('empty');
    expect((await env.pool.query('SELECT state FROM provider_health WHERE provider_id = $1', [p])).rows[0].state).toBe('unfunded');
    expect((await put(`/internal/providers/${p}/funding-thresholds`, { currency: 'USD', warnBelow: '5', criticalBelow: '10' })).statusCode).toBe(400);
  });
});
