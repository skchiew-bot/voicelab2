import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  const rates = (id: string, rate: string, limit: number) => post(`/internal/providers/${id}/charging`, { reason: 'Set up for this test.', 
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
    // Naming a drained provider's own caller ID waits (it is resting, not broken): nothing goes out and no call is recorded.
    const named = await dial(t, { from: '+60300000101' });
    expect(named.statusCode).toBe(429); expect(named.json()).toMatchObject({ deferred: true }); expect(dials()).toHaveLength(2);
    expect((await env.pool.query('SELECT 1 FROM calls WHERE id = $1', [named.json().callId])).rowCount).toBe(0);
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

describe('a drained provider in the retry path', () => {
  it('is not tried when the first provider refuses the dial: the call fails rather than going to a drained provider', async () => {
    const t = await freshTenant('Retry Co', [[telnyxId, '+60300000601'], [twilioId, '+60300000602']]);
    await forgetDials(); env.provider.calls.length = 0;
    await must(act({ action: 'drain', providerId: twilioId, reason: 'Resting Twilio.' }));
    const before = env.provider.state.respond;
    // Telnyx (the cheaper, first choice) refuses outright: a definite "no", which would normally be tried on another provider.
    env.provider.state.respond = (url, init) => (url.endsWith('/v2/calls') ? new Response('{"errors":[{"detail":"number not allowed"}]}', { status: 403 }) : before(url, init));
    try {
      const r = await dial(t);
      expect(r.statusCode).toBe(502);
      expect(dials().map(usedProvider)).toEqual([telnyxId]);                                       // never Twilio
    } finally { env.provider.state.respond = before; }
    // With Twilio restored, the same refusal is retried there.
    await must(act({ action: 'restore', providerId: twilioId, reason: 'Done resting.' }));
    env.provider.state.respond = (url, init) => (url.endsWith('/v2/calls') ? new Response('{"errors":[{"detail":"number not allowed"}]}', { status: 403 }) : before(url, init));
    try {
      expect((await must(dial(t))).json().status).toBe('dialing');
      expect(dials().map(usedProvider).slice(-2)).toEqual([telnyxId, twilioId]);
    } finally { env.provider.state.respond = before; }
    await clearActive();
  });
});

describe('a drain that leaves no provider', () => {
  it('holds dials back instead of failing them, so a case callback keeps its retries, and voice providers cannot be drained to nothing', async () => {
    const t = await freshTenant('Only Co', [[twilioId, '+60300000501']]);
    env.provider.calls.length = 0;
    await must(act({ action: 'drain', providerId: twilioId, reason: 'Planned maintenance window.' }));
    const r = await dial(t);
    expect(r.statusCode).toBe(429); expect(r.json()).toMatchObject({ deferred: true }); expect(dials()).toHaveLength(0);
    expect((await env.pool.query(`SELECT count(*)::int AS n FROM calls WHERE tenant_id = $1`, [t])).rows[0].n).toBe(0);   // no failed call row
    expect((await env.pool.query(`SELECT detail->>'reason' AS reason FROM failover_events WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1`, [t])).rows[0].reason).toBe('drained');
    // Named by provider too: still a wait, not a refusal.
    expect((await dial(t, { providerId: twilioId })).statusCode).toBe(429);
    await must(act({ action: 'restore', providerId: twilioId, reason: 'Maintenance done.' }));
    expect((await must(dial(t))).json().status).toBe('dialing');
    // A client whose only voice route is this provider would be left with none: refused, with the reason.
    await must(env.call(st(), 'PUT', `/internal/tenants/${t}/routes/voice`, { reason: 'Set up for this test.', providerIds: [voiceId] }));
    const v = await act({ action: 'drain', providerId: voiceId, reason: 'Testing.' });
    expect(v.statusCode).toBe(409); expect(v.json().error).toContain('only usable voice provider for 1 client');
    await clearActive();
  });
});

describe('forcing a failover', () => {
  it('fails the provider over at once, logs it as an operator\'s failover, and lets it earn its way back like any other', async () => {
    await must(env.call(st(), 'PUT', '/internal/resilience/policy', { reason: 'Set up for this test.', recoveryOkSamples: 2, recoveryDwellMs: 0 }));
    await must(act({ action: 'force_failover', providerId: twilioId, reason: 'Twilio latency spike seen by the team.' }));
    expect((await act({ action: 'force_failover', providerId: twilioId, reason: 'again' })).statusCode).toBe(409);
    const health = (await must(env.call(st(), 'GET', '/internal/resilience/health'))).json().find((h: { provider_id: string }) => h.provider_id === twilioId);
    expect(health).toMatchObject({ state: 'failed', reason: 'Failed over by an operator.' });
    const ev = (await env.pool.query(`SELECT trigger, detail FROM failover_events WHERE from_provider = $1 ORDER BY id DESC LIMIT 1`, [twilioId])).rows[0];
    expect(ev).toEqual({ trigger: 'operator', detail: { from: 'healthy', to: 'failed' } });
    for (let i = 0; i < 2; i++) await must(post(`/internal/providers/${twilioId}/samples`, { kind: 'ok', latencyMs: 50 }));
    expect((await must(env.call(st(), 'GET', '/internal/resilience/health'))).json().find((h: { provider_id: string }) => h.provider_id === twilioId).state).toBe('healthy');
    // A telephony provider has no probe, so a person can end a failover, with a reason; one that is not failed cannot be "ended".
    await must(act({ action: 'force_failover', providerId: twilioId, reason: 'Again, to test ending it.' }));
    await must(act({ action: 'end_failover', providerId: twilioId, reason: 'Twilio confirmed the fix.' }));
    expect((await must(env.call(st(), 'GET', '/internal/resilience/health'))).json().find((h: { provider_id: string }) => h.provider_id === twilioId).state).toBe('healthy');
    expect((await act({ action: 'end_failover', providerId: twilioId, reason: 'nothing to end' })).statusCode).toBe(409);
    expect((await log())[0]).toMatchObject({ action: 'control.end_failover', why: 'Twilio confirmed the fix.' });
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
    // A provider with no outbound rate cannot be preferred: its calls could not be priced.
    const bare = (await must(post('/internal/providers', { adapterKey: 'twilio', name: 'tw-norate', params: { accountSid: 'AC9', authToken: 'tok', twimlAppVoiceUrl: `${BASE}/v` } }))).json().id;
    const refused = await act({ action: 'set_preferred', providerId: bare, reason: 'Cheaper, apparently.' });
    expect(refused.statusCode).toBe(409); expect(refused.json().error).toContain('no outbound rate');
    await clearActive();
  });
});

describe('the dialling pace', () => {
  it('holds dials back once the minute\'s quota is used, even when they arrive at the same moment, and lifts when cleared', async () => {
    const t = await freshTenant('Pace Co', [[telnyxId, '+60300000301'], [twilioId, '+60300000302']]);
    await forgetDials(); env.provider.calls.length = 0;
    try {
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
      // A dial that never went out (blocked by the gate) does not use up the minute.
      await forgetDials(); await must(act({ action: 'set_pace', perMinute: 1, reason: 'One a minute.' }));
      await env.pool.query(`INSERT INTO calls (id, tenant_id, provider_id, direction, status) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'blocked')`, [t, telnyxId]);
      await env.pool.query(`INSERT INTO calls (id, tenant_id, provider_id, direction, status, end_reason) VALUES (gen_random_uuid(), $1, $2, 'outbound', 'failed', 'did_locked')`, [t, telnyxId]);
      expect((await must(dial(t))).json().status).toBe('dialing');
      await must(act({ action: 'set_pace', perMinute: null, reason: 'Campaign is stable.' }));
      expect((await must(dial(t))).json().status).toBe('dialing');
      expect((await log())[0]).toMatchObject({ action: 'control.set_pace', why: 'Campaign is stable.' });
      await clearActive();
    } finally {
      // A pace left set by a failed run would hold back the dials of every test after it, and show up as theirs failing.
      await act({ action: 'set_pace', perMinute: null, reason: 'Clearing the pace after the test.' });
    }
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
    for (const body of [{ action: 'set_pace', perMinute: 5 }, { action: 'drain', providerId: twilioId }, { action: 'force_failover', providerId: twilioId }, { action: 'end_failover', providerId: twilioId },
      { action: 'set_preferred', providerId: twilioId }, { action: 'retire_number', phoneNumberId: twilioId }]) {
      expect((await act({ ...body, reason: 'try this' }, user.token)).statusCode).toBe(403);
    }
    expect((await env.call(user.token, 'GET', '/internal/control-tower/controls')).statusCode).toBe(403);
    expect((await act({ action: 'set_pace', perMinute: 5, reason: 'customer on +60 12-345 6789 complained' })).statusCode).toBe(400);
    void withActor; void createUser;
  });
});

// ------------------------------------------------------------------------------------------------------------------
// A drain and the dial decision, together. Providers of their own for each test, so one test's ceilings, load and drain
// never reach another's: A is Twilio and dearer, B is Telnyx and cheaper, so the pool prefers B until it is drained.
// ------------------------------------------------------------------------------------------------------------------
let made = 0;
async function telephony(adapter: 'twilio' | 'telnyx', ceiling: number, rate: string) {
  const n = ++made;
  const params = adapter === 'twilio'
    ? { accountSid: `ACrace${n}`, authToken: 'tok', twimlAppVoiceUrl: `${BASE}/v` }
    : { apiKey: 'KEY', webhookUrl: `${BASE}/h`, connectionId: `race${n}`, webhookPublicKey: 'AAAA' };
  const id = (await must(post('/internal/providers', { adapterKey: adapter, name: `${adapter}-race-${n}`, params }))).json().id as string;
  await must(post(`/internal/providers/${id}/charging`, { reason: 'Set up for this test.',
    effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1, concurrencyLimit: ceiling,
    components: [{ component: 'telephony_leg', unit: 'per_minute', rate, currency: 'USD' }],
  }));
  return { id, sid: `ACrace${n}` };
}
let numbered = 0;
const e164 = () => `+60300009${String(++numbered).padStart(3, '0')}`;
/** A client with a caller ID at each of two providers; `ceilings` are A's and B's concurrency ceilings. */
async function pair(ceilings: [number, number], premium?: string) {
  const a = await telephony('twilio', ceilings[0], '0.0120'); const b = await telephony('telnyx', ceilings[1], '0.0060');
  const numA = e164(); const numB = e164();
  const t = await freshTenant(`Race Co ${made}`, [[a.id, numA], [b.id, numB]]);
  await must(env.call(st(), 'PUT', `/internal/tenants/${t}/entitlement`, { reason: 'Set up for this test.', inboundChannels: 5, ...(premium ? { overburstMultiplier: premium } : {}) }));
  return { a, b, t, numA, numB };
}
/** n calls under way at a provider, as if other dials had filled it. */
const occupy = (providerId: string, tenant: string, n: number) => env.pool.query(
  `INSERT INTO calls (id, tenant_id, provider_id, direction, status) SELECT gen_random_uuid(), $1, $2, 'outbound', 'dialing' FROM generate_series(1, $3)`, [tenant, providerId, n]);
const callRow = async (callId: string) => (await env.pool.query('SELECT provider_id, burst, credit_multiplier, status, end_reason FROM calls WHERE id = $1', [callId])).rows[0] as
  { provider_id: string; burst: boolean; credit_multiplier: string | null; status: string; end_reason: string | null };
const eventTypes = async (tenant: string) => (await env.pool.query('SELECT type FROM call_events WHERE tenant_id = $1 ORDER BY id', [tenant])).rows.map((r) => r.type as string);
const lastDeferral = async (tenant: string) => (await env.pool.query(`SELECT detail->>'reason' AS reason FROM failover_events WHERE tenant_id = $1 AND trigger = 'capacity' ORDER BY id DESC LIMIT 1`, [tenant])).rows[0]?.reason as string | undefined;
const callCount = async (tenant: string) => (await env.pool.query('SELECT count(*)::int AS n FROM calls WHERE tenant_id = $1', [tenant])).rows[0].n as number;
const load = async (providerId: string) => (await must(env.call(st(), 'GET', '/internal/capacity'))).json().find((c: { providerId: string }) => c.providerId === providerId) as { active: number; ceiling: number };
const drain = (providerId: string, why = 'Resting it for this test.') => must(act({ action: 'drain', providerId, reason: why }));
const restore = (providerId: string) => must(act({ action: 'restore', providerId, reason: 'Done resting it.' }));
/** The dialling pace is off for these tests, whatever an earlier test left it at: a dial held back by it would look like a drain doing so. */
const noPace = async () => { await must(act({ action: 'set_pace', perMinute: null, reason: 'No pace for this test.' })); };

describe('the premium for going over a ceiling, with a provider drained', () => {
  beforeEach(noPace);
  it('takes the call over the ceiling of the provider that is up, at the premium the client agreed to, and never sends it to a drained provider that has room', async () => {
    await clearActive(); await forgetDials();
    const { a, b, t } = await pair([1, 2], '1.5');
    await occupy(a.id, t, 1);                                                        // A is at its ceiling of 1; B has both channels free
    expect([await load(a.id), await load(b.id)]).toMatchObject([{ active: 1, ceiling: 1 }, { active: 0, ceiling: 2 }]);
    await drain(b.id); env.provider.calls.length = 0;
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = await dial(t); expect(r.statusCode).toBe(201);
      ids.push(r.json().callId);
    }
    for (const id of ids) expect(await callRow(id)).toMatchObject({ provider_id: a.id, burst: true, credit_multiplier: '1.500', status: 'dialing' });
    for (const id of ids) {
      const ev = (await must(env.call(st(), 'GET', `/internal/calls/${id}/events`))).json().filter((e: { type: string }) => e.type === 'call.burst');
      expect(ev).toHaveLength(1); expect(ev[0].payload).toEqual({ providerId: a.id, creditMultiplier: '1.500' });
    }
    expect(dials()).toHaveLength(2);
    expect(dials().every((c) => c.url.includes(`/Accounts/${a.sid}/Calls.json`))).toBe(true);   // both to A; Telnyx was not contacted
    expect((await load(b.id)).active).toBe(0);                                         // B took nothing
    await clearActive();
  });

  it('holds the dial back, rather than failing it or sending it to the drained provider, for a client that did not agree to a premium', async () => {
    await clearActive(); await forgetDials();
    const { a, b, t } = await pair([1, 2]);                                           // an entitlement, but no overburst multiplier
    await occupy(a.id, t, 1); await drain(b.id);
    const before = await callCount(t); env.provider.calls.length = 0;
    const r = await dial(t);
    expect(r.statusCode).toBe(429); expect(r.json()).toMatchObject({ deferred: true, status: 'deferred' });
    expect(dials()).toHaveLength(0);                                                  // nobody was contacted
    expect(await callCount(t)).toBe(before);                                          // and no call row, so nothing failed
    expect(await lastDeferral(t)).toBe('at_capacity');                                // A is full: that is the reason, not the drain
    const types = await eventTypes(t);
    expect(types).toContain('dial.deferred'); expect(types).not.toContain('call.failed'); expect(types).not.toContain('call.burst');
    // The same client, once it agrees to the premium, goes over A's ceiling and still not to B.
    await must(env.call(st(), 'PUT', `/internal/tenants/${t}/entitlement`, { reason: 'Premium agreed after all.', inboundChannels: 5, overburstMultiplier: '2' }));
    const paid = await dial(t); expect(paid.statusCode).toBe(201);
    expect(await callRow(paid.json().callId)).toMatchObject({ provider_id: a.id, burst: true, credit_multiplier: '2.000' });
    expect(dials().every((c) => c.url.includes(`/Accounts/${a.sid}/Calls.json`))).toBe(true);
    await clearActive();
  });

  it('defers a dial that names the caller ID of a provider that is both drained and full, for a client that agreed to a premium, instead of placing it as burst there', async () => {
    await clearActive(); await forgetDials();
    const { a, b, t, numA, numB } = await pair([1, 2], '1.5');
    await occupy(a.id, t, 1); await occupy(b.id, t, 2);                                // both at their ceilings
    await drain(b.id);
    const before = await callCount(t); env.provider.calls.length = 0;
    const named = await dial(t, { from: numB });
    expect(named.statusCode).toBe(429); expect(named.json()).toMatchObject({ deferred: true });
    expect(dials()).toHaveLength(0); expect(await callCount(t)).toBe(before);
    expect(await lastDeferral(t)).toBe('drained');                                     // resting, not full
    expect(await eventTypes(t)).not.toContain('call.burst');
    expect((await load(b.id)).active).toBe(2);
    // Naming the caller ID of the provider that is up still goes over its ceiling at the premium.
    const up = await dial(t, { from: numA }); expect(up.statusCode).toBe(201);
    expect(await callRow(up.json().callId)).toMatchObject({ provider_id: a.id, burst: true, credit_multiplier: '1.500' });
    await clearActive();
  });

  it('sends the next dial to the provider once it is restored, with no premium', async () => {
    await clearActive(); await forgetDials();
    const { a, b, t } = await pair([1, 2], '1.5');
    await occupy(a.id, t, 1); await drain(b.id);
    const over = await dial(t); expect(await callRow(over.json().callId)).toMatchObject({ provider_id: a.id, burst: true });
    await restore(b.id); env.provider.calls.length = 0;
    const back = await must(dial(t));
    expect(await callRow(back.json().callId)).toMatchObject({ provider_id: b.id, burst: false, credit_multiplier: null, status: 'dialing' });
    expect((await eventTypes(t)).filter((x) => x === 'call.burst')).toHaveLength(1);   // only the first call was over a ceiling
    expect(dials()).toHaveLength(1); expect(dials()[0]!.url.endsWith('/v2/calls')).toBe(true);
    await clearActive();
  });

  it('does not move a call over the ceiling to a drained provider when the provider refuses it; one restored meanwhile takes it, without the premium', async () => {
    await clearActive(); await forgetDials();
    const { a, b, t } = await pair([1, 2], '1.5');
    await occupy(a.id, t, 1); await drain(b.id);
    const before = env.provider.state.respond;
    const refuse = () => new Response('{"message":"number not allowed"}', { status: 403 });
    env.provider.state.respond = (url, init) => (url.includes('/Calls.json') ? refuse() : before(url, init));
    env.provider.calls.length = 0;
    try {
      const refused = await dial(t);
      expect(refused.statusCode).toBe(502);
      expect(dials().map((c) => c.url.includes('/Calls.json'))).toEqual([true]);       // A only; the drained B has room and was still not tried
      const failed = (await env.pool.query(`SELECT provider_id, status, end_reason FROM calls WHERE tenant_id = $1 AND status = 'failed'`, [t])).rows;
      expect(failed).toEqual([{ provider_id: a.id, status: 'failed', end_reason: 'provider_error' }]);
      // B is restored while A is still answering the next dial: the retry finds B up, with room, so the premium decided for A is dropped.
      env.provider.state.respond = async (url, init) => { if (url.includes('/Calls.json')) { await restore(b.id); return refuse(); } return before(url, init); };
      env.provider.calls.length = 0;
      const moved = await dial(t); expect(moved.statusCode).toBe(201);
      expect(dials().map((c) => c.url.includes('/Calls.json'))).toEqual([true, false]);
      expect(await callRow(moved.json().callId)).toMatchObject({ provider_id: b.id, burst: false, credit_multiplier: null, status: 'dialing' });
    } finally { env.provider.state.respond = before; }
    await clearActive();
  });

  it('records a premium call that failed with nowhere else to go as never over a ceiling: no premium on the call or in the Control Tower count, and the burst event stays in the log', async () => {
    await clearActive(); await forgetDials();
    const { a, b, t } = await pair([1, 2], '1.5');
    await occupy(a.id, t, 1); await drain(b.id);                                       // A is full and B drained: the call is decided over A's ceiling, at the premium
    const overCeiling = async () => ((await must(env.call(st(), 'GET', '/internal/control-tower/panels'))).json().concurrency.providers as { providerId: string; burst24h: number }[]).find((p) => p.providerId === a.id)!.burst24h;
    const before = env.provider.state.respond;
    env.provider.state.respond = (url, init) => (url.includes('/Calls.json') ? new Response('{"message":"number not allowed"}', { status: 403 }) : before(url, init));
    try {
      expect((await dial(t)).statusCode).toBe(502);                                    // A refuses it, and B is drained: there is nowhere else to go
      const failed = (await env.pool.query(`SELECT id, provider_id, status, end_reason, cost_status FROM calls WHERE tenant_id = $1 AND status = 'failed'`, [t])).rows;
      expect(failed).toHaveLength(1);
      expect(failed[0]).toMatchObject({ provider_id: a.id, status: 'failed', end_reason: 'provider_error', cost_status: 'not_applicable' });
      expect(await callRow(failed[0].id)).toMatchObject({ burst: false, credit_multiplier: null });   // it never went over a ceiling, and is never priced
      expect((await eventTypes(t)).filter((x) => x === 'call.burst')).toHaveLength(1);                // what was decided stays in the append-only log
      expect(await overCeiling()).toBe(0);                                             // so the capacity panel does not count it
    } finally { env.provider.state.respond = before; }
    // A call that does go over the ceiling is still counted.
    const placed = await dial(t); expect(placed.statusCode).toBe(201);
    expect(await callRow(placed.json().callId)).toMatchObject({ provider_id: a.id, burst: true, credit_multiplier: '1.500' });
    expect(await overCeiling()).toBe(1);
    await clearActive();
  });

  it('defers the dial of a client that agreed to a premium, as drained, when every provider is drained and full: it never goes over a ceiling, and goes out once one is restored', async () => {
    await clearActive(); await forgetDials();
    const { a, b, t, numA } = await pair([1, 2], '1.5');
    await occupy(a.id, t, 1); await occupy(b.id, t, 2);                                // both at their ceilings
    await drain(a.id); await drain(b.id);
    const before = await callCount(t); env.provider.calls.length = 0;
    for (const body of [{}, { from: numA }]) {                                         // let the pool choose, then name a caller ID
      const r = await dial(t, body);
      expect(r.statusCode).toBe(429); expect(r.json()).toMatchObject({ deferred: true, status: 'deferred' });
      expect(await lastDeferral(t)).toBe('drained');                                   // resting, not full, and not a premium to pay
    }
    expect(dials()).toHaveLength(0); expect(await callCount(t)).toBe(before);
    expect(await eventTypes(t)).not.toContain('call.burst'); expect(await eventTypes(t)).not.toContain('call.failed');
    await restore(a.id);
    const out = await dial(t); expect(out.statusCode).toBe(201);
    expect(await callRow(out.json().callId)).toMatchObject({ provider_id: a.id, burst: true, credit_multiplier: '1.500' });   // A is up again, and full: now the premium
    await clearActive();
  });

  it('defers the dial of a client that agreed to a premium, as drained, when one provider is drained and the other has really failed over', async () => {
    await clearActive(); await forgetDials();
    const { a, b, t } = await pair([1, 2], '1.5');
    await occupy(a.id, t, 1); await occupy(b.id, t, 2);
    await drain(a.id);
    await must(act({ action: 'force_failover', providerId: b.id, reason: 'Telnyx is failing for real, say the team.' }));
    const before = await callCount(t); env.provider.calls.length = 0;
    const r = await dial(t);
    expect(r.statusCode).toBe(429); expect(r.json()).toMatchObject({ deferred: true });
    expect(await lastDeferral(t)).toBe('drained');                                     // the drained one can come back by itself, so the dial waits for it rather than failing
    expect(dials()).toHaveLength(0); expect(await callCount(t)).toBe(before);
    expect(await eventTypes(t)).not.toContain('call.burst'); expect(await eventTypes(t)).not.toContain('call.failed');
    await clearActive();
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Racing requests. Each test forces the interleaving it is about from a side connection, so it does not rely on timing:
// the requests are held at a known point, the test waits until the database shows them there, then lets them go.
// ------------------------------------------------------------------------------------------------------------------
/** Sessions of this database waiting for a heavyweight lock: a row being written, or an advisory lock. Clients only, never the server's own workers. */
const waiting = async () => (await env.pool.query(
  `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend' AND wait_event_type = 'Lock'`)).rows[0].n as number;
/** Polls until `ok`. Gives up well inside vitest's 5 s test timeout, so a barrier never reached says what it waited for, not just "timed out". */
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 3_000) {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`gave up waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
/** A request in flight, and whether it has finished. */
function track<T>(p: Promise<T>) { const t = { settled: false, p: p.then((r) => { t.settled = true; return r; }) }; return t; }
/** Holds something in a transaction of its own until released (always release it, in a finally, or the requests wait for ever). */
async function hold(sql: string, params: unknown[] = []) {
  const side = await env.pool.connect(); let open = true;
  // A connection that failed to start, or to end, its transaction is destroyed (release with the error), never handed back to the pool.
  try { await side.query('BEGIN'); await side.query(sql, params); } catch (err) { await side.query('ROLLBACK').catch(() => {}); side.release(err as Error); throw err; }
  return { release: async () => {
    if (!open) return; open = false;
    try { await side.query('ROLLBACK'); } catch (err) { side.release(err as Error); throw err; }
    side.release();
  } };
}
const auditedDrains = async (providerId: string) => (await env.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'control.drain' AND entity_id = $1`, [providerId])).rows[0].n as number;
type Reply = Awaited<ReturnType<typeof act>>;

describe('a drain racing other requests', () => {
  beforeEach(noPace);
  it('drains a provider once when two operators drain it at the same moment: one is refused and one audit row is written', async () => {
    const p = await telephony('telnyx', 50, '0.0060');
    // An uncommitted row in the provider's controls holds the first drain after it has read "not drained", before it writes; the
    // second waits for the capacity lock the first holds, so it can only read once the first has committed.
    const h = await hold('INSERT INTO provider_controls (provider_id) VALUES ($1)', [p.id]);
    let results: Reply[];
    try {
      const both = [track(act({ action: 'drain', providerId: p.id, reason: 'First operator.' })), track(act({ action: 'drain', providerId: p.id, reason: 'Second operator.' }))];
      await until('both drains to be waiting, or one to have finished', async () => both.some((x) => x.settled) || (await waiting()) === 2);
      expect(both.map((x) => x.settled)).toEqual([false, false]);                   // neither finishes while the row is held
      await h.release();
      results = await Promise.all(both.map((x) => x.p));
    } finally { await h.release(); }
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().error).toContain('already drained');
    expect(await auditedDrains(p.id)).toBe(1);
    expect((await env.pool.query('SELECT drained_at FROM provider_controls WHERE provider_id = $1', [p.id])).rows[0].drained_at).not.toBeNull();
  });

  it('never leaves a client with no usable voice provider when its last two are drained at the same moment', async () => {
    const mk = async (name: string) => (await must(post('/internal/providers', { adapterKey: 'elevenlabs', name, params: { apiKey: 'k' } }))).json().id as string;
    const v1 = await mk('el-race-1'); const v2 = await mk('el-race-2');
    const t = (await must(post('/internal/tenants', { name: 'Voice Race Co' }))).json().id as string;
    await must(env.call(st(), 'PUT', `/internal/tenants/${t}/routes/voice`, { reason: 'Set up for this test.', providerIds: [v1, v2] }));
    // Uncommitted rows in both providers' controls: whichever drain gets the capacity lock first reads that the other provider is
    // usable and waits for its write; the other waits for the lock, so it reads only after the first has committed and sees the
    // drain. Without the lock both would read before either wrote, find the other usable, and both commit.
    const h = await hold('INSERT INTO provider_controls (provider_id) VALUES ($1), ($2)', [v1, v2]);
    let results: Reply[];
    try {
      const both = [track(act({ action: 'drain', providerId: v1, reason: 'Maintenance on the first.' })), track(act({ action: 'drain', providerId: v2, reason: 'Maintenance on the second.' }))];
      await until('both drains to be waiting, or one to have finished', async () => both.some((x) => x.settled) || (await waiting()) === 2);
      expect(both.map((x) => x.settled)).toEqual([false, false]);                   // neither finishes while the rows are held
      await h.release();
      results = await Promise.all(both.map((x) => x.p));
    } finally { await h.release(); }
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().error).toContain('only usable voice provider for 1 client');
    expect((await auditedDrains(v1)) + (await auditedDrains(v2))).toBe(1);
    const usable = (await env.pool.query(
      `SELECT count(*)::int AS n FROM provider_routes r WHERE r.tenant_id = $1 AND r.role = 'voice'
          AND NOT EXISTS (SELECT 1 FROM provider_controls k WHERE k.provider_id = r.provider_id AND k.drained_at IS NOT NULL)`, [t])).rows[0].n;
    expect(usable).toBe(1);
  });

  it('makes a drain wait for the capacity lock while a dial is deciding: the drain does not commit until that dial has placed its call', async () => {
    await clearActive(); await forgetDials();
    const { a, b, t } = await pair([50, 50]);
    // The dial takes the capacity lock, then waits for the caller-ID lock this holds. (That the dial reads the drain state under
    // the lock is shown by the next test; this one shows the drain takes the lock.)
    const h = await hold('SELECT pg_advisory_xact_lock(hashtext($1))', [`did:${t}:MY`]);
    let dialResult: Reply; let drainResult: Reply;
    try {
      const d = track(dial(t));
      await until('the dial to be deciding', async () => (await waiting()) === 1);
      const dr = track(act({ action: 'drain', providerId: b.id, reason: 'Drained while a dial was deciding.' }));
      await until('the drain to be queued behind the dial, or to have finished', async () => dr.settled || (await waiting()) === 2);
      expect(dr.settled).toBe(false);                // it must not finish while a dial that read B as usable is about to put a call on it
      expect(await waiting()).toBe(2);
      await h.release();
      [dialResult, drainResult] = await Promise.all([d.p, dr.p]);
    } finally { await h.release(); }
    expect(drainResult.statusCode).toBe(200);
    expect(dialResult.statusCode).toBe(201);
    expect((await callRow(dialResult.json().callId)).provider_id).toBe(b.id);       // decided before the drain
    const after = await must(dial(t));
    expect((await callRow(after.json().callId)).provider_id).toBe(a.id);            // decided after it
    await clearActive();
  });

  it('decides each dial on one side of a drain: those queued before it go to the provider, those queued after it do not', async () => {
    await clearActive(); await forgetDials();
    const { a, b, t } = await pair([50, 50]);
    // The capacity lock is held, so every request queues for it; each is queued in turn, so the order they get it in is known.
    const h = await hold(`SELECT pg_advisory_xact_lock(hashtext('capacity'))`);
    const sent: { settled: boolean; p: Promise<Reply> }[] = [];
    const send = async (what: string, p: Promise<Reply>) => {
      const x = track(p); sent.push(x);
      await until(`${what} to be queued for the capacity lock`, async () => (await waiting()) === sent.filter((s) => !s.settled).length);
    };
    let results: Reply[];
    try {
      await send('dial 1', dial(t)); await send('dial 2', dial(t));
      await send('the drain', act({ action: 'drain', providerId: b.id, reason: 'Drained between two pairs of dials.' }));
      await send('dial 3', dial(t)); await send('dial 4', dial(t));
      await h.release();
      results = await Promise.all(sent.map((s) => s.p));
    } finally { await h.release(); }
    expect(results[2]!.statusCode).toBe(200);                                         // the drain itself
    const ids = [results[0], results[1], results[3], results[4]].map((r) => { expect(r!.statusCode).toBe(201); return r!.json().callId as string; });
    // In the order the database decided them (the start is stamped under the lock): the first two on B, the last two not.
    const decided = (await env.pool.query('SELECT id, provider_id FROM calls WHERE id = ANY($1) ORDER BY started_at, id', [ids])).rows;
    expect(decided.map((r) => r.id)).toEqual(ids);
    expect(decided.map((r) => r.provider_id)).toEqual([b.id, b.id, a.id, a.id]);
    await clearActive();
  });

  // The retry after a provider refuses a dial decides again, so it takes the capacity lock again. B (the cheaper) refuses
  // outright here, which sends the dial to A.
  const telnyxRefuses = () => new Response('{"errors":[{"detail":"number not allowed"}]}', { status: 403 });
  type Held = Awaited<ReturnType<typeof hold>>;

  it('makes a drain wait for the capacity lock while a refused dial is choosing another provider: the drain does not commit until the call has landed on it', async () => {
    await clearActive(); await forgetDials();
    const { a, b, t } = await pair([50, 50]);
    const before = env.provider.state.respond;
    const side: { h?: Held; failure?: unknown } = {};
    // Before B's refusal comes back, the caller-ID lock is held from here: the retry takes the capacity lock, reads that A is
    // usable, and waits in chooseDid for the caller-ID lock.
    env.provider.state.respond = async (url, init) => {
      if (!url.endsWith('/v2/calls')) return before(url, init);
      try { side.h = await hold('SELECT pg_advisory_xact_lock(hashtext($1))', [`did:${t}:MY`]); } catch (err) { side.failure = err; }
      return telnyxRefuses();
    };
    env.provider.calls.length = 0;
    let dialResult: Reply; let drainResult: Reply;
    try {
      const d = track(dial(t));
      await until('the retry to be deciding', async () => side.failure !== undefined || (await waiting()) === 1);
      if (side.failure) throw side.failure;
      const dr = track(act({ action: 'drain', providerId: a.id, reason: 'Drained while a retry was deciding.' }));
      await until('the drain to be queued behind the retry, or to have finished', async () => dr.settled || (await waiting()) === 2);
      expect(dr.settled).toBe(false);                // it must not finish while a retry that read A as usable is about to put the call on it
      expect(d.settled).toBe(false);
      await side.h!.release();
      [dialResult, drainResult] = await Promise.all([d.p, dr.p]);
    } finally { await side.h?.release(); env.provider.state.respond = before; }
    expect(dialResult.statusCode).toBe(201);
    expect(drainResult.statusCode).toBe(200);
    expect(await callRow(dialResult.json().callId)).toMatchObject({ provider_id: a.id, burst: false, status: 'dialing' });   // decided before the drain
    expect(dials().map((c) => c.url.includes('/Calls.json'))).toEqual([false, true]);                                       // B refused, then A
    expect((await controls()).providers.find((p: { id: string }) => p.id === a.id).drained).not.toBeNull();                 // and the drain then committed
    // Drained now, A takes no retry: when B refuses again the call fails, and only B is contacted.
    env.provider.state.respond = (url, init) => (url.endsWith('/v2/calls') ? telnyxRefuses() : before(url, init));
    env.provider.calls.length = 0;
    try {
      expect((await dial(t)).statusCode).toBe(502);
      expect(dials().map((c) => c.url.includes('/Calls.json'))).toEqual([false]);
    } finally { env.provider.state.respond = before; }
    await clearActive();
  });

  it('decides a retry after a drain that was queued before it: the call fails rather than going to the provider just drained', async () => {
    await clearActive(); await forgetDials();
    const { a, b, t } = await pair([50, 50]);
    const before = env.provider.state.respond;
    const side: { h?: Held; drain?: { settled: boolean; p: Promise<Reply> }; failure?: unknown } = {};
    // Before B's refusal comes back, the capacity lock is held from here and a drain of A is queued for it; the retry that
    // follows the refusal then queues behind that drain.
    env.provider.state.respond = async (url, init) => {
      if (!url.endsWith('/v2/calls')) return before(url, init);
      try {
        side.h = await hold(`SELECT pg_advisory_xact_lock(hashtext('capacity'))`);
        side.drain = track(act({ action: 'drain', providerId: a.id, reason: 'Drained just before the retry.' }));
        await until('the drain to be queued for the capacity lock', async () => (await waiting()) === 1);
      } catch (err) { side.failure = err; }
      return telnyxRefuses();
    };
    env.provider.calls.length = 0;
    let dialResult: Reply; let drainResult: Reply;
    try {
      const d = track(dial(t));
      await until('the retry to be queued behind the drain, or to have finished', async () => side.failure !== undefined || d.settled || (await waiting()) === 2);
      if (side.failure) throw side.failure;
      expect(d.settled).toBe(false);                 // the retry waits its turn for the capacity lock; it does not decide on its own
      expect(side.drain!.settled).toBe(false);
      await side.h!.release();
      [dialResult, drainResult] = await Promise.all([d.p, side.drain!.p]);
    } finally { await side.h?.release(); env.provider.state.respond = before; }
    expect(drainResult.statusCode).toBe(200);
    expect(dialResult.statusCode).toBe(502);         // A was drained before the retry decided, and B had refused: nowhere to go
    expect(dials().map((c) => c.url.includes('/Calls.json'))).toEqual([false]);       // A was never contacted
    const failed = (await env.pool.query(`SELECT provider_id, status, end_reason FROM calls WHERE tenant_id = $1`, [t])).rows;
    expect(failed).toEqual([{ provider_id: b.id, status: 'failed', end_reason: 'provider_error' }]);
    await clearActive();
  });
});

// ------------------------------------------------------------------------------------------------------------------
// A voice route and a drain. A drain is refused when it would leave a client with no usable voice provider; a route
// change must be refused for the same state, however the two arrive.
// ------------------------------------------------------------------------------------------------------------------
describe('a voice route and a drain', () => {
  let named = 0;
  const voice = async () => (await must(post('/internal/providers', { adapterKey: 'elevenlabs', name: `el-route-${++named}`, params: { apiKey: 'k' } }))).json().id as string;
  const putRoutes = (t: string, providerIds: string[]) => env.call(st(), 'PUT', `/internal/tenants/${t}/routes/voice`, { reason: 'Changed for this test.', providerIds });
  const routesOf = async (t: string) => ((await must(env.call(st(), 'GET', `/internal/tenants/${t}/routes/voice`))).json() as { providerId: string }[]).map((r) => r.providerId);
  const newTenant = async (name: string, providerIds: string[]) => {
    const t = (await must(post('/internal/tenants', { name }))).json().id as string;
    await must(putRoutes(t, providerIds));
    return t;
  };

  it('refuses a voice route in which every provider is drained, leaving the routes as they were, and accepts any route with one usable provider, or none at all', async () => {
    const [v1, v2, v3] = [await voice(), await voice(), await voice()];
    const t = await newTenant('Route Co', [v1, v2, v3]);
    await drain(v1); await drain(v2);                                                  // v3 is still usable, so both are allowed
    const one = await putRoutes(t, [v1]);
    expect(one.statusCode).toBe(409); expect(one.json().error).toContain('is drained'); expect(one.json().error).toContain('Restore it on the Control Tower, or add another provider to the route.');
    const two = await putRoutes(t, [v2, v1]);
    expect(two.statusCode).toBe(409); expect(two.json().error).toContain('are drained'); expect(two.json().error).toContain('Restore one on the Control Tower, or add another provider to the route.');
    expect(await routesOf(t)).toEqual([v1, v2, v3]);                                   // a refused change changes nothing
    expect((await must(putRoutes(t, [v1, v3]))).statusCode).toBe(200);                 // v3 can take the calls
    expect(await routesOf(t)).toEqual([v1, v3]);
    expect((await must(putRoutes(t, []))).statusCode).toBe(200);                       // no routes at all is as it was: the fallback plan answers
    expect(await routesOf(t)).toEqual([]);
    await restore(v1);
    expect((await must(putRoutes(t, [v1]))).statusCode).toBe(200);                     // restored, it is usable again
    expect(await routesOf(t)).toEqual([v1]);
  });

  it('never leaves a client with only drained voice providers when a drain and a route change arrive at the same moment', async () => {
    const [v1, v2] = [await voice(), await voice()];
    const t = await newTenant('Route Race Co', [v1, v2]);
    // Both requests read before they write: a row held in v2's controls stops the drain at its write, a lock on the client's
    // route rows stops the route change at its write. With the capacity lock, whichever gets it first reads and waits at its
    // write, and the other waits for the lock and so reads only after the first has committed.
    const rows = await hold('INSERT INTO provider_controls (provider_id) VALUES ($1)', [v2]);
    let routeRows: Awaited<ReturnType<typeof hold>> | undefined;
    let results: Reply[];
    try {
      routeRows = await hold(`SELECT 1 FROM provider_routes WHERE tenant_id = $1 FOR UPDATE`, [t]);
      const both = [track(act({ action: 'drain', providerId: v2, reason: 'Maintenance on the second.' })), track(putRoutes(t, [v2]))];
      await until('both requests to be waiting, or one to have finished', async () => both.some((x) => x.settled) || (await waiting()) === 2);
      expect(both.map((x) => x.settled)).toEqual([false, false]);
      await rows.release(); await routeRows.release();
      results = await Promise.all(both.map((x) => x.p));
    } finally { await rows.release(); await routeRows?.release(); }
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);              // one of them is refused, whichever came first
    const usable = (await env.pool.query(
      `SELECT count(*)::int AS n FROM provider_routes r WHERE r.tenant_id = $1 AND r.role = 'voice'
          AND NOT EXISTS (SELECT 1 FROM provider_controls k WHERE k.provider_id = r.provider_id AND k.drained_at IS NOT NULL)`, [t])).rows[0].n;
    expect(usable).toBe(1);                                                            // the client still has a provider that can take its calls
  });
});
