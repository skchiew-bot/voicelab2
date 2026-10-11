import { createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTelnyx } from '../src/telephony/telnyx.js';
import { parseTwilio } from '../src/telephony/twilio.js';

/**
 * A carrier that answers an outbound dial with a clear block on the number shown locks that DID away from the contact by
 * itself (owner's decision, 2026-10-11): SIP 607 Unwanted and 608 Rejected only. Telnyx reports the code as
 * `sip_hangup_cause` (its published API description); Twilio's `SipResponseCode` is assumed, unchecked against a live call.
 */
type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let projectId: string; let twilioId: string; let telnyxId: string;
const BASE = 'https://voicelab.test';
const TW_TOKEN = 'tw-auth-token';
const TX1 = '+60387651001'; const TX2 = '+60387651002'; const TW1 = '+60312341001';
const keys = generateKeyPairSync('ed25519');
const pubB64 = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}
const post = (u: string, b?: unknown) => env.call(env.staffToken, 'POST', u, b);

let n = 0;
beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  tenantId = (await must(post('/internal/tenants', { name: 'Lock Co' }))).json().id;
  projectId = (await must(post(`/internal/tenants/${tenantId}/projects`, { name: 'Collections' }))).json().id;
  twilioId = (await must(post('/internal/providers', { adapterKey: 'twilio', name: 'tw', params: { accountSid: 'AC1', authToken: TW_TOKEN, twimlAppVoiceUrl: `${BASE}/v` } }))).json().id;
  telnyxId = (await must(post('/internal/providers', { adapterKey: 'telnyx', name: 'tx', params: { apiKey: 'KEY', webhookUrl: `${BASE}/h`, connectionId: 'c1', webhookPublicKey: pubB64 } }))).json().id;
  for (const id of [twilioId, telnyxId]) {
    await must(post(`/internal/providers/${id}/charging`, { reason: 'Set up for this test.', effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 6, components: [{ component: 'telephony_leg', unit: 'per_minute', rate: '0.0100', currency: 'USD' }] }));
  }
  await must(post('/internal/fx', { currency: 'MYR', perUsd: '4.5', effectiveFrom: '2026-01-01T00:00:00Z' }));
  for (const [providerId, e164] of [[telnyxId, TX1], [telnyxId, TX2], [twilioId, TW1]] as const) {
    await must(post('/internal/numbers', { providerId, e164, tenantId, projectId, country: 'MY' }));
  }
  await must(post('/internal/dnc/registries', { country: 'MY', requirement: 'registry', source: 'test' }));
  env.provider.state.respond = (url) => {
    if (url.includes('/Calls.json')) return new Response(JSON.stringify({ sid: `CA_lock_${++n}` }), { status: 201 });
    if (url.endsWith('/v2/calls')) return new Response(JSON.stringify({ data: { call_control_id: `cc_lock_${++n}` } }));
    return new Response('{}');
  };
});
afterAll(async () => { await env?.teardown(); });

/** Dial a contact from the pool (optionally only one provider's numbers); returns the call, the caller ID and its provider id. */
async function dial(to: string, providerId?: string) {
  env.provider.calls.length = 0;
  const callId = (await must(post('/internal/calls/outbound', { tenantId, projectId, country: 'MY', to, ...(providerId ? { providerId } : {}) }))).json().callId as string;
  const req = env.provider.calls.find((c) => c.url.includes('/Calls.json') || c.url.endsWith('/v2/calls'))!;
  const twilio = req.url.includes('/Calls.json');
  const from = twilio ? new URLSearchParams(req.body).get('From')! : JSON.parse(req.body).from as string;
  const row = (await env.pool.query('SELECT provider_call_id FROM calls WHERE id = $1', [callId])).rows[0];
  return { callId, from, twilio, providerCallId: row.provider_call_id as string };
}

// Independent implementations of the providers' signing, so the tests do not just agree with the code.
const telnyxPost = (body: unknown) => {
  const raw = JSON.stringify(body); const ts = String(Math.floor(Date.now() / 1000));
  return env.app.inject({ method: 'POST', url: `/webhooks/telnyx/${telnyxId}`, payload: raw,
    headers: { 'content-type': 'application/json', 'telnyx-timestamp': ts, 'telnyx-signature-ed25519': sign(null, Buffer.from(`${ts}|${raw}`), keys.privateKey).toString('base64') } });
};
const twilioPost = (params: Record<string, string>) => {
  const path = `/webhooks/twilio/${twilioId}/status`;
  const sig = createHmac('sha1', TW_TOKEN).update(BASE + path + Object.keys(params).sort().map((k) => k + params[k]).join('')).digest('base64');
  return env.app.inject({ method: 'POST', url: path, payload: new URLSearchParams(params).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig } });
};

/** The provider says the dial ended, rejected, with this SIP code (or none). */
async function ended(call: { callId: string; twilio: boolean; providerCallId: string }, sip: string | undefined, eventId = randomUUID()) {
  if (call.twilio) {
    const r = await twilioPost({ CallSid: call.providerCallId, CallStatus: 'failed', Direction: 'outbound-api', CallDuration: '0', ...(sip === undefined ? {} : { SipResponseCode: sip }) });
    expect(r.statusCode).toBeLessThan(300);
    return;
  }
  const payload = { call_control_id: call.providerCallId, client_state: Buffer.from(call.callId).toString('base64'), direction: 'outgoing', hangup_cause: 'call_rejected', hangup_source: 'callee', ...(sip === undefined ? {} : { sip_hangup_cause: sip }) };
  const r = await telnyxPost({ data: { id: eventId, event_type: 'call.hangup', occurred_at: new Date().toISOString(), record_type: 'event', payload } });
  expect(r.statusCode).toBe(200);
}
const locks = async (callId: string) => (await env.pool.query('SELECT reason, recorded_by FROM did_failures WHERE call_id = $1', [callId])).rows;
const lockEvents = async (callId: string) => (await env.pool.query(`SELECT payload FROM call_events WHERE call_id = $1 AND type = 'did.locked'`, [callId])).rows.map((r) => r.payload);

describe('reading the SIP code a provider ends a call with', () => {
  it('takes a three-digit SIP code from Telnyx and Twilio, and nothing from "unspecified", an empty field or anything else', () => {
    const tx = (v: unknown) => parseTelnyx({ data: { id: 'e', event_type: 'call.hangup', payload: { call_control_id: 'cc', hangup_cause: 'call_rejected', sip_hangup_cause: v } } })!.sipCode;
    expect(tx('608')).toBe(608);
    expect(tx('607')).toBe(607);
    for (const v of ['unspecified', '', '6080', 'abc', '099', '700', undefined, null]) expect(tx(v)).toBeUndefined();
    const tw = (v?: string) => parseTwilio({ CallSid: 'CA1', CallStatus: 'failed', ...(v === undefined ? {} : { SipResponseCode: v }) })!.sipCode;
    expect(tw('607')).toBe(607);
    expect(tw(undefined)).toBeUndefined();
    expect(tw('60 7')).toBeUndefined();
  });
});

describe('a carrier blocking the number we showed', () => {
  it('locks the DID for that contact when Telnyx ends the dial with 608, and never shows it to them again', async () => {
    const to = '+60123451001';
    const first = await dial(to, telnyxId);
    await ended(first, '608');
    expect(await locks(first.callId)).toEqual([{ reason: 'carrier_blocked', recorded_by: null }]);
    expect(await lockEvents(first.callId)).toEqual([{ phoneNumberId: expect.any(String), reason: 'carrier_blocked', source: 'carrier', sipCode: 608 }]);
    for (let i = 0; i < 4; i++) expect((await dial(to, telnyxId)).from).not.toBe(first.from);
    // Another contact can still be called from it.
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) seen.add((await dial('+60123451002', telnyxId)).from);
    expect(seen.has(first.from)).toBe(true);
  });

  it('locks it as flagged as spam when the contact marked the call unwanted (607), from Twilio too', async () => {
    const first = await dial('+60123451003', twilioId);
    expect(first.from).toBe(TW1);
    await ended(first, '607');
    expect(await locks(first.callId)).toEqual([{ reason: 'spam_flagged', recorded_by: null }]);
    // The only Twilio number is now locked for this contact, so a dial restricted to Twilio is refused before any provider is asked.
    env.provider.calls.length = 0;
    const again = await post('/internal/calls/outbound', { tenantId, projectId, country: 'MY', to: '+60123451003', providerId: twilioId });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain('Every number in the pool has failed');
    expect(env.provider.calls).toHaveLength(0);
  });

  it('locks nothing for a decline, busy, a server error, no code at all, or "unspecified"', async () => {
    for (const sip of ['603', '486', '480', '500', '404', undefined, 'unspecified']) {
      const call = await dial('+60123451004', telnyxId);
      await ended(call, sip);
      expect(await locks(call.callId)).toEqual([]);
    }
    const tw = await dial('+60123451005', twilioId);
    await ended(tw, '603');
    expect(await locks(tw.callId)).toEqual([]);
  });

  it('locks once when the same end is delivered again, and never from an inbound call', async () => {
    const call = await dial('+60123451006', telnyxId);
    const id = randomUUID();
    await ended(call, '608', id);
    await ended(call, '608', id);        // the same delivery again
    await ended(call, '608');            // a second end for a call already ended
    expect(await locks(call.callId)).toHaveLength(1);

    // An inbound call ended with 608 has no DID of ours shown to anyone: nothing to lock.
    const inbound = { call_control_id: 'cc_in_lock', direction: 'incoming', from: '+60123451007', to: TX1 };
    await telnyxPost({ data: { id: randomUUID(), event_type: 'call.initiated', occurred_at: new Date().toISOString(), record_type: 'event', payload: inbound } });
    await telnyxPost({ data: { id: randomUUID(), event_type: 'call.hangup', occurred_at: new Date().toISOString(), record_type: 'event', payload: { ...inbound, hangup_cause: 'call_rejected', sip_hangup_cause: '608' } } });
    const row = (await env.pool.query(`SELECT id, status, end_reason FROM calls WHERE provider_call_id = 'cc_in_lock'`)).rows[0];
    expect(row).toMatchObject({ status: 'unanswered', end_reason: 'rejected' });
    expect(await locks(row.id)).toEqual([]);
  });

  it('locks nothing for a call that was answered, whatever code its end carries, or for another leg carrying our call id', async () => {
    const tx = await dial('+60123451008', telnyxId);
    const cs = Buffer.from(tx.callId).toString('base64');
    const at = (ms: number) => new Date(Date.now() + ms).toISOString();
    await telnyxPost({ data: { id: randomUUID(), event_type: 'call.answered', occurred_at: at(0), record_type: 'event', payload: { call_control_id: tx.providerCallId, client_state: cs } } });
    await telnyxPost({ data: { id: randomUUID(), event_type: 'call.hangup', occurred_at: at(30_000), record_type: 'event', payload: { call_control_id: tx.providerCallId, client_state: cs, hangup_cause: 'normal_clearing', sip_hangup_cause: '608' } } });
    expect((await env.pool.query('SELECT status FROM calls WHERE id = $1', [tx.callId])).rows[0].status).toBe('completed');
    expect(await locks(tx.callId)).toEqual([]);

    const tw = await dial('+60123451009', twilioId);
    expect((await twilioPost({ CallSid: tw.providerCallId, CallStatus: 'completed', Direction: 'outbound-api', CallDuration: '42', SipResponseCode: '607' })).statusCode).toBeLessThan(300);
    expect(await locks(tw.callId)).toEqual([]);

    // A leg Telnyx made from ours keeps our client_state; its end is not our dial being blocked.
    const other = await dial('+60123451010', telnyxId);
    await telnyxPost({ data: { id: randomUUID(), event_type: 'call.hangup', occurred_at: at(0), record_type: 'event', payload: { call_control_id: 'cc_another_leg', client_state: Buffer.from(other.callId).toString('base64'), hangup_cause: 'call_rejected', sip_hangup_cause: '608' } } });
    expect(await locks(other.callId)).toEqual([]);
  });

  it('locks on a block however the provider files the end: Twilio calling it busy, or Telnyx sending the code as a number', async () => {
    const tw = await dial('+60123451011', twilioId);
    expect((await twilioPost({ CallSid: tw.providerCallId, CallStatus: 'busy', Direction: 'outbound-api', CallDuration: '0', SipResponseCode: '608' })).statusCode).toBeLessThan(300);
    expect(await locks(tw.callId)).toEqual([{ reason: 'carrier_blocked', recorded_by: null }]);
    const tx = await dial('+60123451012', telnyxId);
    await telnyxPost({ data: { id: randomUUID(), event_type: 'call.hangup', occurred_at: new Date().toISOString(), record_type: 'event', payload: { call_control_id: tx.providerCallId, client_state: Buffer.from(tx.callId).toString('base64'), hangup_cause: 'call_rejected', sip_hangup_cause: 607 } } });
    expect(await locks(tx.callId)).toEqual([{ reason: 'spam_flagged', recorded_by: null }]);
  });

  it('still ends and costs the call once when the lock cannot be written, and raises an alert until a person locks it by hand', async () => {
    const call = await dial('+60123451013', telnyxId);
    const hash = (await env.pool.query('SELECT contact_hash FROM calls WHERE id = $1', [call.callId])).rows[0].contact_hash as string;
    // The database refuses a lock for this one contact, as a failure would.
    await env.pool.query(`CREATE FUNCTION refuse_lock() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN
      IF NEW.contact_hash = '${hash}' THEN RAISE EXCEPTION 'lock refused for the test'; END IF; RETURN NEW; END $f$`);
    await env.pool.query('CREATE TRIGGER refuse_lock BEFORE INSERT ON did_failures FOR EACH ROW EXECUTE FUNCTION refuse_lock()');
    try { await ended(call, '608'); }
    finally { await env.pool.query('DROP TRIGGER refuse_lock ON did_failures'); await env.pool.query('DROP FUNCTION refuse_lock()'); }
    const row = (await env.pool.query('SELECT status, cost_status FROM calls WHERE id = $1', [call.callId])).rows[0];
    // The end stands, priced as any rejected dial is: ended, with its one cost record.
    expect(row).toEqual({ status: 'unanswered', cost_status: 'recorded' });
    expect((await env.pool.query('SELECT count(*)::int AS n FROM call_costs WHERE call_id = $1', [call.callId])).rows[0].n).toBe(1);
    expect(await locks(call.callId)).toEqual([]);
    const alert = async () => (await env.call(env.staffToken, 'GET', '/internal/control-tower')).json().alerts.find((a: { code: string }) => a.code === 'did_lock_failed');
    expect(await alert()).toMatchObject({ severity: 'high', link: '#/numbers' });
    expect((await post(`/internal/calls/${call.callId}/did-failure`, { reason: 'carrier_blocked' })).statusCode).toBe(201);
    expect(await alert()).toBeUndefined();
  });
});
