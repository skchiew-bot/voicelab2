import { createHmac, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db.js';
import { redactNumbers } from '../src/telephony/types.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env;
let tenantId: string; let projectId: string;
let twilioId: string; let telnyxId: string;
const BASE = 'https://voicelab.test';
const TW_TOKEN = 'tw-auth-token';
const OUR_TW = '+60312345678'; const OUR_TX = '+60387654321';
const CUSTOMER = '+60123456789'; const BLOCKED = '+60198765432';
const keys = generateKeyPairSync('ed25519');
const pubB64 = keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');

async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  const st = env.staffToken;
  tenantId = (await must(env.call(st, 'POST', '/internal/tenants', { name: 'Tel Co' }))).json().id;
  projectId = (await must(env.call(st, 'POST', `/internal/tenants/${tenantId}/projects`, { name: 'Collections' }))).json().id;
  twilioId = (await must(env.call(st, 'POST', '/internal/providers', {
    adapterKey: 'twilio', name: 'tw', params: { accountSid: 'AC1', authToken: TW_TOKEN, twimlAppVoiceUrl: `${BASE}/v` },
  }))).json().id;
  telnyxId = (await must(env.call(st, 'POST', '/internal/providers', {
    adapterKey: 'telnyx', name: 'tx', params: { apiKey: 'KEY', webhookUrl: `${BASE}/h`, connectionId: 'conn-1', webhookPublicKey: pubB64 },
  }))).json().id;
  for (const [id, rate] of [[twilioId, '0.0140'], [telnyxId, '0.0070']] as const) {
    await must(env.call(st, 'POST', `/internal/providers/${id}/charging`, {
      effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 6,
      components: [{ component: 'telephony_leg', unit: 'per_minute', rate, currency: 'USD' }],
    }));
  }
  await must(env.call(st, 'POST', '/internal/fx', { currency: 'MYR', perUsd: '4.5', effectiveFrom: '2026-01-01T00:00:00Z' }));
  await must(env.call(st, 'POST', '/internal/numbers', { providerId: twilioId, e164: OUR_TW, tenantId, projectId, country: 'MY' }));
  await must(env.call(st, 'POST', '/internal/numbers', { providerId: telnyxId, e164: OUR_TX, tenantId, projectId, country: 'MY' }));
  await must(env.call(st, 'POST', '/internal/dnc/registries', { country: 'MY', requirement: 'registry', source: 'test' }));
  await must(env.call(st, 'POST', '/internal/dnc/numbers', { country: 'MY', numbers: [BLOCKED] }));
});
afterAll(async () => { await env?.teardown(); });

// ---- independent implementations of the providers' signing, so the tests do not just agree with the code
const twilioSig = (path: string, params: Record<string, string>) =>
  createHmac('sha1', TW_TOKEN).update(BASE + path + Object.keys(params).sort().map((k) => k + params[k]).join('')).digest('base64');

const twilioPost = (path: string, params: Record<string, string>, o: { sig?: string | null } = {}) =>
  env.app.inject({
    method: 'POST', url: path, payload: new URLSearchParams(params).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(o.sig === null ? {} : { 'x-twilio-signature': o.sig ?? twilioSig(path, params) }) },
  });

const telnyxEvent = (type: string, payload: Record<string, unknown>, at = new Date(), id = randomUUID()) =>
  ({ data: { id, event_type: type, occurred_at: at.toISOString(), record_type: 'event', payload } });

const telnyxPost = (body: unknown, o: { ts?: number; sig?: string; providerId?: string; tamper?: boolean } = {}) => {
  const raw = JSON.stringify(body);
  const ts = String(o.ts ?? Math.floor(Date.now() / 1000));
  const sig = o.sig ?? sign(null, Buffer.from(`${ts}|${raw}`), keys.privateKey).toString('base64');
  return env.app.inject({
    method: 'POST', url: `/webhooks/telnyx/${o.providerId ?? telnyxId}`, payload: o.tamper ? raw.replace('call.', 'call,') : raw,
    headers: { 'content-type': 'application/json', 'telnyx-signature-ed25519': sig, 'telnyx-timestamp': ts },
  });
};

const dial = (body: object) => env.call(env.staffToken, 'POST', '/internal/calls/outbound', { tenantId, projectId, country: 'MY', ...body });
const events = async (callId: string) => (await env.call(env.staffToken, 'GET', `/internal/calls/${callId}/events`)).json().map((e: { type: string }) => e.type);
const callRow = async (callId: string) => (await env.call(env.staffToken, 'GET', `/internal/calls/${callId}`)).json();
const cost = async (callId: string) => (await env.call(env.staffToken, 'GET', `/internal/calls/${callId}/cost`)).json();
const webhookCount = async () => (await env.pool.query('SELECT count(*)::int AS n FROM webhook_events')).rows[0].n as number;
const reset = () => { env.provider.calls.length = 0; };

describe('webhook signatures: anything unverifiable is refused and changes nothing', () => {
  it('Twilio: accepts a correct signature, refuses missing, wrong and tampered ones', async () => {
    const path = `/webhooks/twilio/${twilioId}/status`;
    const unknown = { CallSid: 'CA_sig', CallStatus: 'ringing', Direction: 'outbound-api' };
    const before = await webhookCount();
    expect((await twilioPost(path, unknown, { sig: null })).statusCode).toBe(403);
    expect((await twilioPost(path, unknown, { sig: 'AAAA' })).statusCode).toBe(403);
    const tampered = twilioSig(path, { ...unknown, CallStatus: 'completed' });
    expect((await twilioPost(path, unknown, { sig: tampered })).statusCode).toBe(403);
    expect((await twilioPost(`${path}?x=1`, unknown, { sig: twilioSig(path, unknown) })).statusCode).toBe(403); // URL is part of what is signed
    expect(await webhookCount()).toBe(before);
    expect((await twilioPost(path, unknown)).statusCode).toBe(204);
  });

  it('Twilio: refuses outright when the provider has no Auth Token to verify with', async () => {
    const id = (await must(env.call(env.staffToken, 'POST', '/internal/providers', {
      adapterKey: 'twilio', name: 'tw-keypair', params: { accountSid: 'AC2', apiKeySid: 'SK1', apiKeySecret: 's', twimlAppVoiceUrl: `${BASE}/v` },
    }))).json().id;
    const res = await twilioPost(`/webhooks/twilio/${id}/status`, { CallSid: 'CA_x', CallStatus: 'ringing' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toContain('Auth Token');
  });

  it('Telnyx: accepts a correct signature and refuses wrong key, stale timestamp and tampered body', async () => {
    const ev = telnyxEvent('call.initiated', { call_control_id: 'cc_sig', direction: 'outgoing' });
    const before = await webhookCount();
    const other = generateKeyPairSync('ed25519');
    const forged = sign(null, Buffer.from(`${Math.floor(Date.now() / 1000)}|${JSON.stringify(ev)}`), other.privateKey).toString('base64');
    expect((await telnyxPost(ev, { sig: forged })).statusCode).toBe(403);
    expect((await telnyxPost(ev, { ts: Math.floor(Date.now() / 1000) - 3600 })).statusCode).toBe(403); // a captured request cannot be replayed later
    expect((await telnyxPost(ev, { tamper: true })).statusCode).toBe(403);
    expect((await telnyxPost(ev, { sig: '' })).statusCode).toBe(403);
    expect(await webhookCount()).toBe(before);
    expect((await telnyxPost(ev)).statusCode).toBe(200);
  });

  it('Telnyx: refuses when no public key is configured, and for an unknown or mismatched provider', async () => {
    const id = (await must(env.call(env.staffToken, 'POST', '/internal/providers', {
      adapterKey: 'telnyx', name: 'tx-nokey', params: { apiKey: 'K', webhookUrl: `${BASE}/h` },
    }))).json().id;
    expect((await telnyxPost(telnyxEvent('call.initiated', { call_control_id: 'c' }), { providerId: id })).statusCode).toBe(503);
    expect((await telnyxPost(telnyxEvent('call.initiated', { call_control_id: 'c' }), { providerId: randomUUID() })).statusCode).toBe(404);
    expect((await twilioPost(`/webhooks/twilio/${telnyxId}/status`, { CallSid: 'x' })).statusCode).toBe(404); // a Telnyx provider is not a Twilio webhook target
  });
});

describe('outbound calls', () => {
  it('Twilio: places the call, follows its status callbacks, prices it on completion, and ignores a retried callback', async () => {
    reset();
    env.provider.state.respond = (url) => url.includes('/Calls.json') ? new Response(JSON.stringify({ sid: 'CA_out_1' }), { status: 201 }) : new Response('{}');
    const placed = (await dial({ providerId: twilioId, from: OUR_TW, to: CUSTOMER })).json();
    expect(placed).toMatchObject({ allowed: true, status: 'dialing' });

    const req = env.provider.calls.find((c) => c.url.includes('/Calls.json'))!;
    const form = new URLSearchParams(req.body);
    expect(req.method).toBe('POST');
    expect(req.headers.authorization).toBe('Basic ' + Buffer.from(`AC1:${TW_TOKEN}`).toString('base64'));
    expect(form.get('To')).toBe(CUSTOMER);
    expect(form.get('From')).toBe(OUR_TW);
    expect(form.get('Url')).toBe(`${BASE}/webhooks/twilio/${twilioId}/voice?callId=${placed.callId}`);
    expect(form.get('StatusCallback')).toBe(`${BASE}/webhooks/twilio/${twilioId}/status?callId=${placed.callId}`);
    expect(form.getAll('StatusCallbackEvent')).toEqual(['initiated', 'ringing', 'answered', 'completed']);

    const path = `/webhooks/twilio/${twilioId}/status?callId=${placed.callId}`;
    const send = (CallStatus: string, extra: Record<string, string> = {}) =>
      twilioPost(path, { CallSid: 'CA_out_1', CallStatus, Direction: 'outbound-api', From: OUR_TW, To: CUSTOMER, ...extra });
    for (const s of ['initiated', 'ringing', 'in-progress']) expect((await send(s)).statusCode).toBe(204);
    expect((await callRow(placed.callId)).status).toBe('in_progress');
    expect((await send('completed', { CallDuration: '61' })).statusCode).toBe(204);

    const row = await callRow(placed.callId);
    expect(row).toMatchObject({ status: 'completed', direction: 'outbound', cost_status: 'recorded', end_reason: 'completed' });
    expect(Number(row.duration_seconds)).toBe(61);
    expect(await events(placed.callId)).toEqual(['dial.allowed', 'call.dialing', 'call.ringing', 'call.answered', 'call.ended']);
    const c = await cost(placed.callId);
    expect(c.lines[0]).toMatchObject({ billed_seconds: 66, rate: '0.01400000' });
    expect(c.total_usd).toBe('0.01540000');
    expect(c.project_id).toBe(projectId);

    // The provider retries the final callback: nothing is logged or priced twice.
    expect((await send('completed', { CallDuration: '61' })).statusCode).toBe(204);
    expect(await events(placed.callId)).toHaveLength(5);
    expect((await env.pool.query('SELECT count(*)::int AS n FROM call_costs WHERE call_id = $1', [placed.callId])).rows[0].n).toBe(1);

    // A late "ringing" cannot move a finished call backwards.
    await send('ringing');
    expect((await callRow(placed.callId)).status).toBe('completed');
  });

  it('Twilio: an unanswered call is recorded as such, with no duration and a zero cost', async () => {
    reset();
    env.provider.state.respond = () => new Response(JSON.stringify({ sid: 'CA_out_2' }), { status: 201 });
    const placed = (await dial({ providerId: twilioId, from: OUR_TW, to: '+60111222333' })).json();
    const path = `/webhooks/twilio/${twilioId}/status?callId=${placed.callId}`;
    await twilioPost(path, { CallSid: 'CA_out_2', CallStatus: 'no-answer', Direction: 'outbound-api', CallDuration: '0' });
    expect(await callRow(placed.callId)).toMatchObject({ status: 'unanswered', end_reason: 'no_answer', cost_status: 'recorded' });
    expect((await cost(placed.callId)).total_usd).toBe('0.00000000');
  });

  it('Telnyx: places the call, answers its own events with commands, and prices from answer to hangup', async () => {
    reset();
    env.provider.state.respond = (url) => url.endsWith('/v2/calls')
      ? new Response(JSON.stringify({ data: { call_control_id: 'cc_out_1' } }), { status: 200 }) : new Response('{}', { status: 200 });
    const placed = (await dial({ providerId: telnyxId, from: OUR_TX, to: CUSTOMER })).json();
    const req = env.provider.calls.find((c) => c.url.endsWith('/v2/calls'))!;
    const body = JSON.parse(req.body);
    expect(req.headers.authorization).toBe('Bearer KEY');
    expect(body).toMatchObject({ connection_id: 'conn-1', to: CUSTOMER, from: OUR_TX, webhook_url: `${BASE}/webhooks/telnyx/${telnyxId}` });
    expect(Buffer.from(body.client_state, 'base64').toString()).toBe(placed.callId);

    const t0 = new Date(); // provider timestamps order the event log, so use the present, after our own dial events
    const p = (extra: Record<string, unknown> = {}) => ({ call_control_id: 'cc_out_1', client_state: body.client_state, direction: 'outgoing', ...extra });
    await telnyxPost(telnyxEvent('call.initiated', p(), t0));
    await telnyxPost(telnyxEvent('call.answered', p(), new Date(t0.getTime() + 5_000)));
    const speak = env.provider.calls.find((c) => c.url.endsWith('/actions/speak'))!;
    expect(speak.url).toBe('https://api.telnyx.com/v2/calls/cc_out_1/actions/speak');
    expect(JSON.parse(speak.body).payload).toContain('test call');
    await telnyxPost(telnyxEvent('call.speak.ended', p(), new Date(t0.getTime() + 9_000)));
    expect(env.provider.calls.some((c) => c.url.endsWith('/actions/hangup'))).toBe(true);
    await telnyxPost(telnyxEvent('call.hangup', p({ hangup_cause: 'normal_clearing' }), new Date(t0.getTime() + 66_000)));

    const row = await callRow(placed.callId);
    expect(row).toMatchObject({ status: 'completed', cost_status: 'recorded', end_reason: 'completed' });
    expect(Number(row.duration_seconds)).toBe(61); // answered at +5s, hung up at +66s
    expect((await cost(placed.callId)).total_usd).toBe('0.00770000'); // 66s billed at 0.007 per minute
    expect(await events(placed.callId)).toEqual(['dial.allowed', 'call.dialing', 'call.answered', 'call.speak_ended', 'call.ended']);
  });

  it('a Telnyx hangup before anyone answered is unanswered, not billed', async () => {
    reset();
    env.provider.state.respond = (url) => url.endsWith('/v2/calls') ? new Response(JSON.stringify({ data: { call_control_id: 'cc_out_2' } })) : new Response('{}');
    const placed = (await dial({ providerId: telnyxId, from: OUR_TX, to: '+60111222444' })).json();
    const cs = Buffer.from(placed.callId).toString('base64');
    await telnyxPost(telnyxEvent('call.hangup', { call_control_id: 'cc_out_2', client_state: cs, hangup_cause: 'user_busy' }));
    expect(await callRow(placed.callId)).toMatchObject({ status: 'unanswered', end_reason: 'busy' });
    expect((await cost(placed.callId)).total_usd).toBe('0.00000000');
  });
});

describe('the do-not-call gate comes before the provider', () => {
  it('never contacts the provider for a blocked number, and says why', async () => {
    reset();
    const res = await dial({ providerId: twilioId, from: OUR_TW, to: BLOCKED });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ allowed: false, reason: 'on_national_registry', status: 'blocked' });
    expect(env.provider.calls).toHaveLength(0);
    expect(await events(res.json().callId)).toEqual(['dial.blocked']);
    expect((await callRow(res.json().callId)).status).toBe('blocked');
  });

  it('blocks a country nobody has declared, and a malformed number', async () => {
    reset();
    expect((await dial({ providerId: twilioId, from: OUR_TW, to: CUSTOMER, country: 'SG' })).json().reason).toBe('no_registry_declared');
    expect((await dial({ providerId: telnyxId, from: OUR_TX, to: '0123456789' })).json().reason).toBe('invalid_number');
    expect(env.provider.calls).toHaveLength(0);
  });

  it('refuses a caller ID that is not one of the client\'s numbers on that provider', async () => {
    reset();
    expect((await dial({ providerId: twilioId, from: '+60399990000', to: CUSTOMER })).statusCode).toBe(400);
    expect((await dial({ providerId: twilioId, from: OUR_TX, to: CUSTOMER })).statusCode).toBe(400); // belongs to the other provider
    expect(env.provider.calls).toHaveLength(0);
  });
});

describe('when the provider refuses', () => {
  it('fails the call cleanly and never repeats the customer number in what it records or returns', async () => {
    reset();
    env.provider.state.respond = () => new Response(JSON.stringify({ message: `The 'To' number ${CUSTOMER} is not a valid phone number` }), { status: 400 });
    const res = await dial({ providerId: twilioId, from: OUR_TW, to: CUSTOMER });
    expect(res.statusCode).toBe(502);
    expect(res.body).not.toContain('123456789');
    expect(res.json().error).toContain('[number]');
    const failed = (await env.pool.query(`SELECT id FROM calls WHERE status = 'failed' ORDER BY started_at DESC LIMIT 1`)).rows[0];
    expect(await events(failed.id)).toEqual(['dial.allowed', 'call.failed']);
  });

  it('redacts anything number-shaped from provider text', () => {
    expect(redactNumbers('bad number +60 12-345 6789 and 0123456789 here')).toBe('bad number [number] and [number] here');
    expect(redactNumbers('Error 404 on call CA123')).toBe('Error 404 on call CA123');
  });
});

describe('inbound calls', () => {
  it('Twilio: routes by the number dialled, answers, and prices the call when it ends', async () => {
    const voice = `/webhooks/twilio/${twilioId}/voice`;
    const params = { CallSid: 'CA_in_1', CallStatus: 'ringing', Direction: 'inbound', From: CUSTOMER, To: OUR_TW };
    const res = await twilioPost(voice, params);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    expect(res.body).toContain('<Say>');

    const call = (await env.pool.query(`SELECT * FROM calls WHERE provider_call_id = 'CA_in_1'`)).rows[0];
    expect(call).toMatchObject({ tenant_id: tenantId, project_id: projectId, direction: 'inbound', status: 'ringing', country: 'MY' });
    expect(await events(call.id)).toEqual(['call.initiated']);

    const status = `/webhooks/twilio/${twilioId}/status`;
    await twilioPost(status, { ...params, CallStatus: 'in-progress' });
    await twilioPost(status, { ...params, CallStatus: 'completed', CallDuration: '30' });
    expect(await callRow(call.id)).toMatchObject({ status: 'completed', cost_status: 'recorded' });
    expect((await cost(call.id)).total_usd).toBe('0.00700000'); // 30s at 0.014 per minute

    // Twilio re-asks for instructions: still answered, not rejected, and no second call is created.
    const again = await twilioPost(voice, params);
    expect(again.body).toContain('<Say>');
    expect((await env.pool.query(`SELECT count(*)::int AS n FROM calls WHERE provider_call_id = 'CA_in_1'`)).rows[0].n).toBe(1);
  });

  it('Twilio: rejects a number no client owns, and records nothing about the caller', async () => {
    const before = (await env.pool.query('SELECT count(*)::int AS n FROM calls')).rows[0].n;
    const res = await twilioPost(`/webhooks/twilio/${twilioId}/voice`, { CallSid: 'CA_in_x', CallStatus: 'ringing', Direction: 'inbound', From: CUSTOMER, To: '+60300000000' });
    expect(res.body).toContain('<Reject/>');
    expect((await env.pool.query('SELECT count(*)::int AS n FROM calls')).rows[0].n).toBe(before);
    expect((await env.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'inbound.unrouted'`)).rows[0].n).toBeGreaterThan(0);
  });

  it('Telnyx: answers a call to one of our numbers, and rejects one to a number nobody owns', async () => {
    reset();
    env.provider.state.respond = () => new Response('{}', { status: 200 });
    const inc = { call_control_id: 'cc_in_1', direction: 'incoming', from: CUSTOMER, to: OUR_TX };
    await telnyxPost(telnyxEvent('call.initiated', inc));
    expect(env.provider.calls.some((c) => c.url.endsWith('/calls/cc_in_1/actions/answer'))).toBe(true);
    const call = (await env.pool.query(`SELECT * FROM calls WHERE provider_call_id = 'cc_in_1'`)).rows[0];
    expect(call).toMatchObject({ tenant_id: tenantId, direction: 'inbound' });

    const t = new Date();
    await telnyxPost(telnyxEvent('call.answered', inc, t));
    await telnyxPost(telnyxEvent('call.hangup', { ...inc, hangup_cause: 'normal_clearing' }, new Date(t.getTime() + 12_000)));
    expect(Number((await callRow(call.id)).duration_seconds)).toBe(12);
    expect((await cost(call.id)).lines[0].billed_seconds).toBe(12);

    reset();
    await telnyxPost(telnyxEvent('call.initiated', { call_control_id: 'cc_in_2', direction: 'incoming', from: CUSTOMER, to: '+60300000000' }));
    expect(env.provider.calls.some((c) => c.url.endsWith('/calls/cc_in_2/actions/reject'))).toBe(true);
    expect((await env.pool.query(`SELECT 1 FROM calls WHERE provider_call_id = 'cc_in_2'`)).rowCount).toBe(0);
  });
});

describe('robustness', () => {
  it('a failure to price never loses the call or fails the webhook, and can be retried', async () => {
    const st = env.staffToken;
    const bare = (await must(env.call(st, 'POST', '/internal/providers', {
      adapterKey: 'twilio', name: 'tw-bare', params: { accountSid: 'AC9', authToken: TW_TOKEN, twimlAppVoiceUrl: `${BASE}/v` },
    }))).json().id;
    await must(env.call(st, 'POST', '/internal/numbers', { providerId: bare, e164: '+60311110000', tenantId, country: 'MY' }));
    const p = { CallSid: 'CA_bare', CallStatus: 'ringing', Direction: 'inbound', From: CUSTOMER, To: '+60311110000' };
    const voice = `/webhooks/twilio/${bare}/voice`; const status = `/webhooks/twilio/${bare}/status`;
    const sigFor = (path: string, params: Record<string, string>) => twilioSig(path, params);
    expect(sigFor(voice, p)).toBeTruthy();
    await twilioPost(voice, p);
    const done = await twilioPost(status, { ...p, CallStatus: 'completed', CallDuration: '60' });
    expect(done.statusCode).toBe(204);

    const call = (await env.pool.query(`SELECT id FROM calls WHERE provider_call_id = 'CA_bare'`)).rows[0];
    expect(await callRow(call.id)).toMatchObject({ status: 'completed', cost_status: 'failed' });
    expect((await callRow(call.id)).cost_error).toContain('no charging version');
    expect(await events(call.id)).toContain('call.cost_failed');

    await must(env.call(st, 'POST', `/internal/providers/${bare}/charging`, {
      effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1,
      components: [{ component: 'telephony_leg', unit: 'per_minute', rate: '0.01', currency: 'USD' }],
    }));
    const retry = await env.call(st, 'POST', `/internal/calls/${call.id}/cost/retry`);
    expect(retry.json()).toEqual({ cost_status: 'recorded' });
    expect((await cost(call.id)).total_usd).toBe('0.01000000');
  });

  it('survives the same final callback arriving three times at once', async () => {
    reset();
    env.provider.state.respond = () => new Response(JSON.stringify({ sid: 'CA_race' }), { status: 201 });
    const placed = (await dial({ providerId: twilioId, from: OUR_TW, to: '+60155550001' })).json();
    const path = `/webhooks/twilio/${twilioId}/status?callId=${placed.callId}`;
    const p = { CallSid: 'CA_race', CallStatus: 'completed', Direction: 'outbound-api', CallDuration: '45' };
    const rs = await Promise.all([1, 2, 3].map(() => twilioPost(path, p)));
    expect(rs.map((r) => r.statusCode)).toEqual([204, 204, 204]);
    expect((await events(placed.callId)).filter((t: string) => t === 'call.ended')).toHaveLength(1);
    expect((await env.pool.query('SELECT count(*)::int AS n FROM call_costs WHERE call_id = $1', [placed.callId])).rows[0].n).toBe(1);
  });

  it('survives two different final callbacks for the same call at once', async () => {
    reset();
    env.provider.state.respond = () => new Response(JSON.stringify({ sid: 'CA_race2' }), { status: 201 });
    const placed = (await dial({ providerId: twilioId, from: OUR_TW, to: '+60155550003' })).json();
    const path = `/webhooks/twilio/${twilioId}/status?callId=${placed.callId}`;
    const base = { CallSid: 'CA_race2', Direction: 'outbound-api', CallDuration: '20' };
    await Promise.all([twilioPost(path, { ...base, CallStatus: 'completed' }), twilioPost(path, { ...base, CallStatus: 'canceled' })]);
    expect((await events(placed.callId)).filter((t: string) => t === 'call.ended')).toHaveLength(1);
    expect((await env.pool.query('SELECT count(*)::int AS n FROM call_costs WHERE call_id = $1', [placed.callId])).rows[0].n).toBe(1);
  });

  it('does not crash on a callback for a call it never saw', async () => {
    const res = await twilioPost(`/webhooks/twilio/${twilioId}/status`, { CallSid: 'CA_never', CallStatus: 'completed', Direction: 'outbound-api', CallDuration: '5' });
    expect(res.statusCode).toBe(204);
    expect((await env.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'webhook.unknown_call'`)).rows[0].n).toBeGreaterThan(0);
  });

  it('ignores event types it does not track, and a callback id that belongs to another provider', async () => {
    expect((await telnyxPost(telnyxEvent('call.dtmf.received', { call_control_id: 'cc_z' }))).statusCode).toBe(200);
    reset();
    env.provider.state.respond = () => new Response(JSON.stringify({ sid: 'CA_mine' }), { status: 201 });
    const placed = (await dial({ providerId: twilioId, from: OUR_TW, to: '+60155550002' })).json();
    const other = (await env.pool.query(`SELECT id FROM providers WHERE name = 'tw-bare'`)).rows[0].id;
    const path = `/webhooks/twilio/${other}/status?callId=${placed.callId}`;
    await twilioPost(path, { CallSid: 'CA_hijack', CallStatus: 'completed', Direction: 'outbound-api', CallDuration: '99' });
    expect((await callRow(placed.callId)).status).toBe('dialing'); // not touched
  });
});

describe('customer numbers are never kept, and clients cannot see any of this', () => {
  it('appear in no table, event, audit entry or cost record', async () => {
    const tables = ['calls', 'call_events', 'audit_log', 'webhook_events', 'call_costs', 'call_cost_lines', 'dnc_entries', 'credit_entries'];
    for (const t of tables) {
      const dump = (await env.pool.query(`SELECT row_to_json(x)::text AS j FROM ${t} x`)).rows.map((r) => r.j).join('\n');
      for (const n of [CUSTOMER, BLOCKED, '+60111222333', '+60155550001']) {
        expect(dump, `${t} contains ${n}`).not.toContain(n.slice(1));
      }
    }
  });

  it('our own numbers are stored, because inbound routing needs them', async () => {
    const rows = (await env.call(env.staffToken, 'GET', '/internal/numbers')).json();
    expect(rows.map((r: { e164: string }) => r.e164)).toContain(OUR_TW);
  });

  it('are out of reach of the client role and client tokens', async () => {
    const user = (await env.call(env.staffToken, 'POST', `/internal/tenants/${tenantId}/users`, { email: 'c@tel.test', role: 'tenant_admin' })).json();
    const asClient = (sql: string) => withActor(env.pool, { kind: 'client', tenantId }, (c) => c.query(sql));
    for (const t of ['calls', 'phone_numbers', 'webhook_events']) await expect(asClient(`SELECT * FROM ${t}`), t).rejects.toThrow(/permission denied/);
    expect((await env.call(user.token, 'POST', '/internal/calls/outbound', { providerId: twilioId, from: OUR_TW, to: CUSTOMER, tenantId, country: 'MY' })).statusCode).toBe(403);
    expect((await env.call(user.token, 'GET', '/internal/numbers')).statusCode).toBe(403);
  });
});
