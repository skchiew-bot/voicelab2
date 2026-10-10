import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db.js';
import { createUser } from '../src/store/tenants.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env;
let twilioId: string; let telnyxId: string; let voiceId: string;
const BASE = 'https://voicelab.test';
const st = () => env.staffToken;
const post = (u: string, b?: unknown) => env.call(st(), 'POST', u, b);
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}
let sid = 0;
const dials = () => env.provider.calls.filter((c) => c.url.includes('/Calls.json') || c.url.endsWith('/v2/calls'));
const usedProvider = (c: { url: string }) => (c.url.includes('/Calls.json') ? twilioId : telnyxId);
const contact = (() => { let n = 0; return () => `+6012${String(8000000 + ++n)}`; })();
const dial = (tenant: string, body: object = {}) => post('/internal/calls/outbound', { tenantId: tenant, country: 'MY', to: contact(), ...body });
const act = (body: object, token = st()) => env.call(token, 'POST', '/internal/control-tower/actions', body);
const controls = async () => (await must(env.call(st(), 'GET', '/internal/control-tower/controls'))).json();
const clearActive = () => env.pool.query(`UPDATE calls SET status = 'completed', ended_at = coalesce(ended_at, now()) WHERE status IN ('dialing', 'ringing', 'in_progress', 'queued')`);
// Test clean-up only: outbound calls from earlier tests would count against the pace.
const forgetDials = () => env.pool.query(`UPDATE calls SET started_at = started_at - interval '1 hour' WHERE direction = 'outbound'`);
async function freshTenant(name: string, numbers: [string, string][]) {
  const t = (await must(post('/internal/tenants', { name }))).json().id as string;
  for (const [providerId, e164] of numbers) await must(post('/internal/numbers', { providerId, e164, tenantId: t, country: 'MY' }));
  return t;
}
const log = async () => (await must(env.call(st(), 'GET', '/internal/change-log?category=providers'))).json().entries as { action: string; who: string; why: string | null }[];

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  twilioId = (await must(post('/internal/providers', { adapterKey: 'twilio', name: 'tw', params: { accountSid: 'AC1', authToken: 'tok', twimlAppVoiceUrl: `${BASE}/v` } }))).json().id;
  telnyxId = (await must(post('/internal/providers', { adapterKey: 'telnyx', name: 'tx', params: { apiKey: 'KEY', webhookUrl: `${BASE}/h`, connectionId: 'c1', webhookPublicKey: 'AAAA' } }))).json().id;
  voiceId = (await must(post('/internal/providers', { adapterKey: 'elevenlabs', name: 'el', params: { apiKey: 'k' } }))).json().id;
  const rates = (id: string, rate: string, limit: number) => post(`/internal/providers/${id}/charging`, {
    effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1, concurrencyLimit: limit,
    components: [{ component: 'telephony_leg', unit: 'per_minute', rate, currency: 'USD' }],
  });
  await must(rates(telnyxId, '0.0060', 50)); await must(rates(twilioId, '0.0120', 50));     // Telnyx is cheaper, so the pool picks it
  await must(post('/internal/fx', { currency: 'MYR', perUsd: '4.5', effectiveFrom: '2026-01-01T00:00:00Z' }));
  await must(post('/internal/dnc/registries', { country: 'MY', requirement: 'registry', source: 'test' }));
  env.provider.state.respond = (url) => {
    if (url.includes('/Calls.json')) return new Response(JSON.stringify({ sid: `CA_a_${++sid}` }), { status: 201 });
    if (url.endsWith('/v2/calls')) return new Response(JSON.stringify({ data: { call_control_id: `cc_a_${++sid}` } }));
    return new Response('{}');
  };
});
afterAll(async () => { await env?.teardown(); });

describe('draining a provider', () => {
  it('sends it no new calls until it is restored, says so on the Control Tower, and keeps who and why', async () => {
    const t = await freshTenant('Drain Co', [[telnyxId, '+60300000101'], [twilioId, '+60300000102']]);
    env.provider.calls.length = 0;
    await must(dial(t)); expect(dials().map(usedProvider)).toEqual([telnyxId]);
    expect((await act({ action: 'drain', providerId: telnyxId, reason: '' })).statusCode).toBe(400);           // a reason is required
    await must(act({ action: 'drain', providerId: telnyxId, reason: 'Carrier incident reported by Telnyx.' }));
    expect((await act({ action: 'drain', providerId: telnyxId, reason: 'again' })).statusCode).toBe(409);
    await must(dial(t)); expect(dials().map(usedProvider)).toEqual([telnyxId, twilioId]);                       // the pool goes elsewhere
    // Naming a drained provider's own caller ID is refused, as for a failed provider, instead of going out anyway.
    const named = await dial(t, { from: '+60300000101' });
    expect(named.statusCode).toBe(503); expect(dials()).toHaveLength(2);
    const alert = (await must(env.call(st(), 'GET', '/internal/control-tower'))).json().alerts.find((a: { code: string }) => a.code === 'provider_drained');
    expect(alert).toMatchObject({ severity: 'medium', message: 'tx is drained by an operator and takes no new calls until it is restored.' });
    expect((await controls()).providers.find((p: { id: string }) => p.id === telnyxId).drained).toMatchObject({ by: 'staff@daythree.test', reason: 'Carrier incident reported by Telnyx.' });
    expect((await controls()).providers.find((p: { id: string }) => p.id === telnyxId).health).toBe('healthy');   // its real health is untouched
    await must(act({ action: 'restore', providerId: telnyxId, reason: 'Telnyx says the incident is over.' }));
    await must(dial(t)); expect(dials().map(usedProvider)).toEqual([telnyxId, twilioId, telnyxId]);
    expect((await log()).slice(0, 2).map((e) => [e.action, e.who, e.why])).toEqual([
      ['control.restore', 'staff@daythree.test', 'Telnyx says the incident is over.'],
      ['control.drain', 'staff@daythree.test', 'Carrier incident reported by Telnyx.'],
    ]);
    await clearActive();
  });
});

describe('forcing a failover', () => {
  it('fails the provider over at once, logs it as an operator\'s failover, and lets it earn its way back like any other', async () => {
    await must(env.call(st(), 'PUT', '/internal/resilience/policy', { recoveryOkSamples: 2, recoveryDwellMs: 0 }));
    await must(act({ action: 'force_failover', providerId: twilioId, reason: 'Twilio latency spike seen by the team.' }));
    expect((await act({ action: 'force_failover', providerId: twilioId, reason: 'again' })).statusCode).toBe(409);
    const health = (await must(env.call(st(), 'GET', '/internal/resilience/health'))).json().find((h: { provider_id: string }) => h.provider_id === twilioId);
    expect(health).toMatchObject({ state: 'failed', reason: 'Failed over by an operator.' });
    const ev = (await env.pool.query(`SELECT trigger, detail FROM failover_events WHERE from_provider = $1 ORDER BY id DESC LIMIT 1`, [twilioId])).rows[0];
    expect(ev).toEqual({ trigger: 'operator', detail: { from: 'healthy', to: 'failed' } });
    for (let i = 0; i < 2; i++) await must(post(`/internal/providers/${twilioId}/samples`, { kind: 'ok', latencyMs: 50 }));
    expect((await must(env.call(st(), 'GET', '/internal/resilience/health'))).json().find((h: { provider_id: string }) => h.provider_id === twilioId).state).toBe('healthy');
  });
});

describe('a preferred telephony provider', () => {
  it('is chosen first by the pool, even when another is cheaper, until it is no longer preferred', async () => {
    const t = await freshTenant('Prefer Co', [[telnyxId, '+60300000201'], [twilioId, '+60300000202']]);
    env.provider.calls.length = 0;
    await must(act({ action: 'set_preferred', providerId: twilioId, reason: 'Better answer rates this week.' }));
    await must(dial(t)); expect(dials().map(usedProvider)).toEqual([twilioId]);
    await must(act({ action: 'clear_preferred', providerId: twilioId, reason: 'Trial over.' }));
    await must(dial(t)); expect(dials().map(usedProvider)).toEqual([twilioId, telnyxId]);
    expect((await act({ action: 'set_preferred', providerId: voiceId, reason: 'not telephony' })).statusCode).toBe(400);
    await clearActive();
  });
});

describe('the dialling pace', () => {
  it('holds dials back once the minute\'s quota is used, even when they arrive at the same moment, and lifts when cleared', async () => {
    const t = await freshTenant('Pace Co', [[telnyxId, '+60300000301'], [twilioId, '+60300000302']]);
    await forgetDials(); env.provider.calls.length = 0;
    await must(act({ action: 'set_pace', perMinute: 2, reason: 'Ramping up a new campaign slowly.' }));
    const results = await Promise.all([1, 2, 3, 4].map(() => dial(t)));
    const bodies = results.map((r) => r.json());
    expect(bodies.filter((b) => b.status === 'dialing')).toHaveLength(2);
    expect(bodies.filter((b) => b.deferred === true)).toHaveLength(2);
    expect(dials()).toHaveLength(2);
    const held = (await env.pool.query(`SELECT count(*)::int AS n FROM failover_events WHERE trigger = 'capacity' AND detail->>'reason' = 'pace'`)).rows[0].n;
    expect(held).toBe(2);
    // Held back by the pace is not "every provider is full".
    expect((await must(env.call(st(), 'GET', '/internal/control-tower'))).json().alerts.map((a: { code: string }) => a.code)).not.toContain('dials_deferred');
    expect((await must(env.call(st(), 'GET', '/internal/control-tower/panels'))).json().concurrency).toMatchObject({ pacePerMinute: 2, paced24h: 2 });
    await must(act({ action: 'set_pace', perMinute: null, reason: 'Campaign is stable.' }));
    expect((await must(dial(t))).json().status).toBe('dialing');
    expect((await log())[0]).toMatchObject({ action: 'control.set_pace', why: 'Campaign is stable.' });
    await clearActive();
  });
});

describe('retiring a caller ID', () => {
  it('takes it out of the pool and brings it back', async () => {
    const t = await freshTenant('Retire Co', [[telnyxId, '+60300000401'], [telnyxId, '+60300000402']]);
    await forgetDials();
    const n1 = (await env.pool.query(`SELECT id FROM phone_numbers WHERE e164 = '+60300000401'`)).rows[0].id;
    await must(act({ action: 'retire_number', phoneNumberId: n1, reason: 'Flagged as spam by carriers.' }));
    expect((await act({ action: 'retire_number', phoneNumberId: n1, reason: 'again' })).statusCode).toBe(409);
    for (let i = 0; i < 3; i++) {
      const id = (await must(dial(t))).json().callId;
      expect((await env.pool.query('SELECT from_number_id FROM calls WHERE id = $1', [id])).rows[0].from_number_id).not.toBe(n1);
    }
    await must(act({ action: 'reactivate_number', phoneNumberId: n1, reason: 'Carrier cleared the flag.' }));
    expect((await env.pool.query('SELECT status FROM phone_numbers WHERE id = $1', [n1])).rows[0].status).toBe('active');
    await clearActive();
  });
});

describe('who may act', () => {
  it('is staff only, and keeps a number out of the reason', async () => {
    const tenant = (await must(post('/internal/tenants', { name: 'Who Co' }))).json().id;
    const user = (await must(post(`/internal/tenants/${tenant}/users`, { email: 'client@who.test', role: 'tenant_admin' }))).json();
    expect((await act({ action: 'set_pace', perMinute: 5, reason: 'try' }, user.token)).statusCode).toBe(403);
    expect((await env.call(user.token, 'GET', '/internal/control-tower/controls')).statusCode).toBe(403);
    expect((await act({ action: 'set_pace', perMinute: 5, reason: 'customer on +60 12-345 6789 complained' })).statusCode).toBe(400);
    void withActor; void createUser;
  });
});
