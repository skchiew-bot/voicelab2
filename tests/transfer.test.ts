import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { parseKey } from '../src/secrets.js';
import { relayCallToken } from '../src/store/relay.js';
import { twimlRelay } from '../src/telephony/relay.js';
import { agentNumberAllowed, dialOutcome, dialSeconds, twimlDialAgent, twimlWhisper, whisperText } from '../src/telephony/transfer.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';

const relayFixture = JSON.parse(readFileSync(new URL('./fixtures/twilio-relay.json', import.meta.url), 'utf8'));
const fixture = JSON.parse(readFileSync(new URL('./fixtures/twilio-transfer.json', import.meta.url), 'utf8'));

describe('the TwiML that puts a caller through to a person', () => {
  it('asks what to do when the relay session ends, and rings the agent showing our number, never anything unchecked', () => {
    const x = twimlRelay('wss://v.test/relay/twilio/p', 'c1', 'k1', { language: 'en-US' }, 'https://v.test/webhooks/twilio/p/transfer/relay-ended?callId=c1&x="y"');
    expect(x).toContain('<Connect action="https://v.test/webhooks/twilio/p/transfer/relay-ended?callId=c1&amp;x=&quot;y&quot;" method="POST"><ConversationRelay ');
    expect(twimlRelay('wss://v.test/r', 'c1', 'k1', { language: 'en-US' })).toContain('<Connect><ConversationRelay ');

    const plan = { agent: '+60312345678', callerId: '+60300000888', ringSeconds: 20, actionUrl: 'https://v.test/d?callId=c1&a=1', whisperUrl: 'https://v.test/w?callId=c1' };
    expect(twimlDialAgent(plan)).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Dial action="https://v.test/d?callId=c1&amp;a=1" method="POST" timeout="20" callerId="+60300000888">'
      + '<Number url="https://v.test/w?callId=c1" method="POST">+60312345678</Number></Dial></Response>');
    expect(twimlDialAgent({ ...plan, whisperUrl: null, ringSeconds: 600 })).toContain('timeout="60" callerId="+60300000888"><Number>+60312345678</Number>');
    expect(() => twimlDialAgent({ ...plan, agent: '+6031"/><Hangup/>' })).toThrow();
    expect(() => twimlDialAgent({ ...plan, callerId: '' })).toThrow();
    // only a Malaysian agent number is ever rung, even if one from elsewhere reached this far (toll fraud)
    expect(() => twimlDialAgent({ ...plan, agent: '+6512345678' })).toThrow(/Malaysian/);
    expect(() => twimlDialAgent({ ...plan, agent: '+14155550100' })).toThrow(/Malaysian/);
  });

  it('allows only a Malaysian agent number, and reads the length of the agent leg strictly', () => {
    for (const ok of ['+60312345678', '+601123456789', '+6082123456']) expect(agentNumberAllowed(ok)).toBe(true);
    for (const no of ['+6512345678', '+14155550100', '+44207946000', '+600312345678', '+60123', '+6031234567890', '60312345678', '+60 312345678']) expect(agentNumberAllowed(no)).toBe(false);
    expect(dialSeconds('61')).toBe(61);
    expect(dialSeconds('0')).toBe(0);
    for (const bad of [undefined, '', '-1', '1.5', '1e3', ' 61', 'abc']) expect(dialSeconds(bad)).toBeNull();
  });

  it('whispers the reason in fixed words and a spelt-out ticket reference, and nothing else', () => {
    expect(whisperText({ trigger: 'severe_sentiment', ticketId: 'ab12cd34-0000-4000-8000-000000000000' }))
      .toBe('A Voice Lab caller is being put through to you, because the caller sounded upset. Ticket reference A B 1 2 C D 3 4.');
    expect(whisperText({ trigger: 'workflow_handoff', ticketId: null })).toBe('A Voice Lab caller is being put through to you, because the caller asked for a person.');
    // a trigger we do not know, or one named like an inherited property, is never read out (L-003)
    expect(whisperText({ trigger: 'constructor', ticketId: 'not-a-ticket' })).toBe('A Voice Lab caller is being put through to you, because the call was passed to a person.');
    // the agent must press 1; silence (a voicemail) or any other key ends the agent's leg
    expect(twimlWhisper('Hi <there>.', 'https://v.test/a?callId=c1&b=2')).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Gather action="https://v.test/a?callId=c1&amp;b=2" method="POST" numDigits="1" timeout="8">'
      + '<Say>Hi &lt;there&gt;. Press 1 to take the call.</Say></Gather><Hangup/></Response>');
  });

  it('counts only an answered dial as reaching a person; anything else, even a value never seen, did not', () => {
    expect(dialOutcome('completed')).toBe('answered');
    expect(dialOutcome('answered')).toBe('answered');
    for (const s of ['busy', 'no-answer', 'canceled']) expect(dialOutcome(s)).toBe('unanswered');
    for (const s of ['failed', undefined, 'surprise', '']) expect(dialOutcome(s)).toBe('failed');
  });
});

// ------------------------------------------------------------------ a call passed to a person, end to end, against fakes
type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let bareTenant: string; let twilioId: string; let handNumber: string; let askNumber: string; let bareNumber: string;
const BASE = 'https://voicelab.test';
const TW_TOKEN = 'tw-transfer-token';
const OUR = '+60300000881'; const ASK = '+60300000882'; const BARE = '+60300000883';
const CUSTOMER = '+60123456789'; const AGENT = '+60387654321';
let port = 0;

async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}
const post = (url: string, body: unknown) => env.call(env.staffToken, 'POST', url, body);
const put = (url: string, body: unknown) => env.call(env.staffToken, 'PUT', url, body);

// Twilio's signing, written out here so the test does not just agree with the code.
const twilioSig = (url: string, params: Record<string, string>) =>
  createHmac('sha1', TW_TOKEN).update(url + Object.keys(params).sort().map((k) => k + params[k]).join('')).digest('base64');
const twilioPost = (path: string, params: Record<string, string>, sig?: string) => env.app.inject({
  method: 'POST', url: path, payload: new URLSearchParams(params).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig ?? twilioSig(BASE + path, params) },
});

const handoff: WorkflowDefinition = { start: 'hi', variables: [], nodes: {
  hi: { type: 'speak', speech: 'fixed', text: 'Let me find someone for you.', transitions: [{ to: 'human' }] },
  human: { type: 'handoff', target: { human: { reason: 'The caller asked for a person.' } } },
} };
const ask: WorkflowDefinition = { start: 'ask', variables: [], nodes: {
  ask: { type: 'speak', speech: 'fixed', text: 'Can you pay this week?', listen: { captureAs: 'a', intents: { yes: ['yes'] } }, transitions: [{ to: 'done' }] },
  done: { type: 'end', outcome: 'promised' },
} };

async function liveWorkflow(tenant: string, name: string, def: WorkflowDefinition, replies: string[], outcome: string) {
  const c = (await must(post(`/internal/tenants/${tenant}/workflows`, { name, definition: def }))).json();
  await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'staging' }));
  await must(post(`/internal/workflows/${c.workflow.id}/simulate`, { scenarios: [{ name: 's', variables: {}, replies, expect: { outcome } }] }));
  await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'production' }));
  return c.workflow.id as string;
}

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  tenantId = (await must(post('/internal/tenants', { name: 'Transfer Co' }))).json().id;
  bareTenant = (await must(post('/internal/tenants', { name: 'No Agents Co' }))).json().id;
  twilioId = (await must(post('/internal/providers', { adapterKey: 'twilio', name: 'tw-transfer', params: { accountSid: 'AC1', authToken: TW_TOKEN, twimlAppVoiceUrl: `${BASE}/v` } }))).json().id;
  handNumber = (await must(post('/internal/numbers', { providerId: twilioId, e164: OUR, tenantId, country: 'MY' }))).json().id;
  askNumber = (await must(post('/internal/numbers', { providerId: twilioId, e164: ASK, tenantId, country: 'MY' }))).json().id;
  bareNumber = (await must(post('/internal/numbers', { providerId: twilioId, e164: BARE, tenantId: bareTenant, country: 'MY' }))).json().id;
  await must(put(`/internal/numbers/${handNumber}/workflow`, { workflowId: await liveWorkflow(tenantId, 'hand_flow', handoff, [], 'handoff_human') }));
  await must(put(`/internal/numbers/${askNumber}/workflow`, { workflowId: await liveWorkflow(tenantId, 'ask_flow', ask, ['yes'], 'promised') }));
  await must(put(`/internal/numbers/${bareNumber}/workflow`, { workflowId: await liveWorkflow(bareTenant, 'bare_flow', handoff, [], 'handoff_human') }));
  await must(put(`/internal/tenants/${tenantId}/transfer`, { agentNumber: '+60 3-8765 4321', ringSeconds: 20 }));
  // Twilio's rates, per started minute: an inbound caller and the outbound agent leg at different rates. Room for many calls.
  await rates(1000);
  await must(post('/internal/fx', { currency: 'MYR', perUsd: '4.5', effectiveFrom: '2026-01-01T00:00:00Z' }));
  await must(post('/internal/rate-card', { effectiveFrom: '2026-01-01T00:00:00Z', inboundCreditsPerMinute: '1', outboundCreditsPerMinute: '2', creditValueUsd: '0.01' }));
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  port = (env.app.server.address() as { port: number }).port;
});
afterAll(async () => { await env?.teardown(); });

/** A new charging version for the Twilio provider, in force from now, with this concurrency ceiling. */
let rateClock = Date.parse('2026-01-01T00:00:00Z');
const LEG = { component: 'telephony_leg', unit: 'per_minute', currency: 'USD' };
async function rates(ceiling: number, components: Record<string, string>[] = [
  { ...LEG, rate: '0.0085', direction: 'inbound' }, { ...LEG, rate: '0.0140', direction: 'outbound' },
]) {
  // Each version is a moment later than the last (and never in the future), so the newest is the one in force.
  rateClock = Math.min(Date.now() - 1000, Math.max(rateClock + 1000, Date.now() - 60_000));
  await must(post(`/internal/providers/${twilioId}/charging`, {
    effectiveFrom: new Date(rateClock).toISOString(), billingIncrementSeconds: 60, concurrencyLimit: ceiling,
    components,
  }));
}
/** How many channels the Twilio provider has in use, as every dial decision counts them. */
const inUse = async () => (await must(env.call(env.staffToken, 'GET', '/internal/capacity'))).json().find((r: { providerId: string }) => r.providerId === twilioId).active as number;

let n = 0;
/** A caller rings one of our numbers; Twilio asks what to do. */
async function ring(to = OUR) {
  const callSid = `CA_transfer_${++n}`;
  const r = await twilioPost(`/webhooks/twilio/${twilioId}/voice`, { CallSid: callSid, CallStatus: 'ringing', Direction: 'inbound', From: CUSTOMER, To: to });
  expect(r.statusCode).toBe(200);
  const callId = (await env.pool.query('SELECT id FROM calls WHERE provider_call_id = $1', [callSid])).rows[0].id as string;
  return { callSid, callId, twiml: r.body };
}

/** The relay connects, the workflow runs its first turn, and the relay hears what it says. */
async function converse(callSid: string, callId: string, expectMessages: number) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay/twilio/${twilioId}`, { headers: { 'x-twilio-signature': twilioSig(`wss://voicelab.test/relay/twilio/${twilioId}`, {}) } });
  await new Promise<void>((ok, bad) => { ws.once('open', () => ok()); ws.once('error', bad); });
  const got: Record<string, unknown>[] = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d))));
  ws.send(JSON.stringify({ ...relayFixture.inbound.setup, callSid, customParameters: { callId, token: relayCallToken(parseKey(env.config.VOICELAB_SECRET_KEY), callId) } }));
  for (let i = 0; i < 200 && got.length < expectMessages; i++) await new Promise((r) => setTimeout(r, 10));
  const closed = new Promise<void>((r) => ws.on('close', () => r()));
  return {
    got, close: async () => { ws.close(); await closed; await new Promise((r) => setTimeout(r, 50)); },
    say: async (words: string) => {
      const before = got.length;
      ws.send(JSON.stringify({ type: 'prompt', voicePrompt: words, lang: 'en-US', last: true }));
      for (let i = 0; i < 200 && (got.length === before || got.at(-1)?.type !== 'end'); i++) await new Promise((r) => setTimeout(r, 10));
    },
  };
}

const path = (step: string, callId: string) => `/webhooks/twilio/${twilioId}/transfer/${step}?callId=${callId}`;
const relayEnded = (callSid: string, callId: string, extra: Record<string, string> = {}, to = OUR) =>
  twilioPost(path('relay-ended', callId), { ...fixture.relayEnded, CallSid: callSid, From: CUSTOMER, To: to, ...extra });
const whisperReq = (callSid: string, callId: string, extra: Record<string, string> = {}) =>
  twilioPost(path('whisper', callId), { ...fixture.whisper, ParentCallSid: callSid, From: OUR, To: AGENT, ...extra });
const acceptReq = (callSid: string, callId: string, digits: string) =>
  twilioPost(path('accept', callId), { ...fixture.whisper, ParentCallSid: callSid, From: OUR, To: AGENT, Digits: digits });
const HANGUP = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
const dialled = (callSid: string, callId: string, extra: Record<string, string> = {}) =>
  twilioPost(path('dialled', callId), { ...fixture.dialled, CallSid: callSid, From: CUSTOMER, To: OUR, ...extra });
const callRow = async (callId: string) => (await env.pool.query('SELECT transfer_status, relay_failed FROM calls WHERE id = $1', [callId])).rows[0];
const callbacks = async (callId: string) => (await env.pool.query('SELECT reason FROM callback_requests WHERE call_id = $1', [callId])).rows.map((r) => r.reason as string);
const events = async (callId: string) => (await env.pool.query('SELECT type, payload FROM call_events WHERE call_id = $1 ORDER BY id', [callId])).rows;

/** A call whose workflow has passed the caller to a person, with the relay told to end. */
async function handedOver(to = OUR) {
  const c = await ring(to);
  expect(c.twiml).toContain(`<Connect action="${BASE}/webhooks/twilio/${twilioId}/transfer/relay-ended?callId=${c.callId}" method="POST">`);
  const line = await converse(c.callSid, c.callId, 2);
  expect(line.got).toEqual([{ type: 'text', token: 'Let me find someone for you.', last: true }, { type: 'end', handoffData: JSON.stringify({ reason: 'handoff_human' }) }]);
  await line.close();
  return c;
}

describe('a live caller passed to a person', () => {
  it('keeps the agent number to staff: refuses one of our own numbers or a malformed one, and audits the change without the number', async () => {
    expect((await put(`/internal/tenants/${tenantId}/transfer`, { agentNumber: ASK })).statusCode).toBe(400);
    expect((await put(`/internal/tenants/${tenantId}/transfer`, { agentNumber: '12345' })).statusCode).toBe(400);
    expect((await put(`/internal/tenants/${tenantId}/transfer`, { agentNumber: AGENT, ringSeconds: 2 })).statusCode).toBe(400);
    const got = await env.call(env.staffToken, 'GET', `/internal/tenants/${tenantId}/transfer`);
    expect(got.json()).toEqual({ agentNumber: AGENT, ringSeconds: 20, whisper: true });
    const audits = (await env.pool.query(`SELECT detail FROM audit_log WHERE action LIKE 'transfer.%'`)).rows;
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain('8765');
    // the client's own role cannot read where its calls go
    await expect(env.pool.query(`SET ROLE voicelab_client; SELECT * FROM transfer_settings`)).rejects.toThrow(/permission denied/);
    await env.pool.query('RESET ROLE');
  });

  it('puts the caller through to the agent, showing our number, whispers the reason and ticket, and ends when they are done', async () => {
    const { callSid, callId } = await handedOver();
    const r = await relayEnded(callSid, callId);
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Dial action="${BASE}/webhooks/twilio/${twilioId}/transfer/dialled?callId=${callId}" method="POST" timeout="20" callerId="${OUR}">`
      + `<Number url="${BASE}/webhooks/twilio/${twilioId}/transfer/whisper?callId=${callId}" method="POST">${AGENT}</Number></Dial></Response>`);
    expect(await callRow(callId)).toMatchObject({ transfer_status: 'dialing' });

    const ticket = (await env.pool.query(`SELECT id FROM tickets WHERE call_id = $1 AND kind = 'escalation'`, [callId])).rows[0].id as string;
    const w = await whisperReq(callSid, callId);
    expect(w.statusCode).toBe(200);
    expect(w.body).toContain(`<Gather action="${BASE}/webhooks/twilio/${twilioId}/transfer/accept?callId=${callId}" method="POST" numDigits="1" timeout="8">`);
    expect(w.body).toContain(`<Say>A Voice Lab caller is being put through to you, because the caller asked for a person. Ticket reference ${ticket.slice(0, 8).toUpperCase().split('').join(' ')}. Press 1 to take the call.</Say>`);
    expect(w.body).not.toContain('123456789');
    expect((await whisperReq(callSid, callId)).statusCode).toBe(200);              // a retried whisper is recorded once
    expect((await acceptReq(callSid, callId, '9')).body).toBe(HANGUP);              // any other key: not taken
    expect((await acceptReq(callSid, callId, '1')).body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');

    const d = await dialled(callSid, callId);
    expect(d.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(await callRow(callId)).toMatchObject({ transfer_status: 'answered' });
    expect(await callbacks(callId)).toEqual([]);
    const ev = await events(callId);
    expect(ev.map((e) => e.type)).toEqual(expect.arrayContaining(['transfer.dialing', 'transfer.whispered', 'transfer.accepted', 'transfer.answered']));
    expect(ev.filter((e) => e.type === 'transfer.whispered')).toHaveLength(1);
    // the caller's number is in every request Twilio sent; it is kept nowhere
    const kept = JSON.stringify([ev, (await env.pool.query('SELECT * FROM calls WHERE id = $1', [callId])).rows, (await env.pool.query('SELECT * FROM audit_log')).rows]);
    expect(kept).not.toContain('123456789');
    // a late or retried request changes nothing
    expect((await relayEnded(callSid, callId)).body).toContain('<Hangup/>');
    expect((await dialled(callSid, callId, { DialCallStatus: 'no-answer' })).body).toContain('<Hangup/>');
    expect(await callRow(callId)).toMatchObject({ transfer_status: 'answered' });
    expect(await callbacks(callId)).toEqual([]);
  });

  it('shows our number on an outbound call too, never the person it called', async () => {
    const { callSid, callId } = await handedOver();
    await env.pool.query(`UPDATE calls SET direction = 'outbound', from_number_id = $2 WHERE id = $1`, [callId, handNumber]);
    // on an outbound call Twilio's To is the customer: it must not become the caller ID
    const r = await relayEnded(callSid, callId, { Direction: 'outbound-api', From: OUR }, CUSTOMER);
    expect(r.body).toContain(`callerId="${OUR}"`);
    expect(r.body).not.toContain(CUSTOMER);
  });

  it('runs the callback ladder when no one answers: the request is recorded first and once, then the holding message, then the end', async () => {
    const { callSid, callId } = await handedOver();
    await must(put(`/internal/tenants/${tenantId}/fallback`, { holdingMessage: 'Sorry, no one is free. We will call you back.', offerCallback: true, humanTransfer: true, voicemail: false }));
    expect((await relayEnded(callSid, callId)).body).toContain('<Dial ');
    const twice = await Promise.all([dialled(callSid, callId, { DialCallStatus: 'no-answer' }), dialled(callSid, callId, { DialCallStatus: 'no-answer' })]);
    for (const d of twice) expect(d.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, no one is free. We will call you back.</Say><Hangup/></Response>');
    expect(await callbacks(callId)).toEqual(['the caller asked for a person and no one answered']);
    expect(await callRow(callId)).toMatchObject({ transfer_status: 'unanswered' });

    // busy, and a value never seen, are also no one reached
    const b = await handedOver();
    await relayEnded(b.callSid, b.callId);
    expect((await dialled(b.callSid, b.callId, { DialCallStatus: 'something-new' })).body).toContain('<Say>');
    expect(await callRow(b.callId)).toMatchObject({ transfer_status: 'failed' });
    expect(await callbacks(b.callId)).toHaveLength(1);
  });

  it('runs the callback ladder when the client has no agent number, and dials no one', async () => {
    const { callSid, callId } = await handedOver(BARE);
    const r = await relayEnded(callSid, callId, {}, BARE);
    expect(r.body).not.toContain('<Dial');
    expect(r.body).toContain('<Say>'); expect(r.body).toContain('<Hangup/>');
    expect(await callRow(callId)).toMatchObject({ transfer_status: 'unavailable' });
    expect(await callbacks(callId)).toEqual(['the caller asked for a person and there was no one to put them through to']);
    expect((await events(callId)).find((e) => e.type === 'transfer.unavailable')?.payload).toEqual({ reason: 'no_agent_number' });
    // asked again: said again, recorded once
    expect((await relayEnded(callSid, callId, {}, BARE)).body).toContain('<Hangup/>');
    expect(await callbacks(callId)).toHaveLength(1);
  });

  it('records the dial once when Twilio asks three times at the same moment, giving each the same answer', async () => {
    const { callSid, callId } = await handedOver();
    const rs = await Promise.all([relayEnded(callSid, callId), relayEnded(callSid, callId), relayEnded(callSid, callId)]);
    // Twilio asks once per session, and again only if our answer never reached it; so each is given the same dial, and it is recorded once
    for (const r of rs) expect(r.body).toContain('<Dial ');
    expect((await events(callId)).filter((e) => e.type === 'transfer.dialing')).toHaveLength(1);
  });

  it('records a callback, once, for a caller who asked for a person and hung up before the dial or while the agent phone rang', async () => {
    // Gone before the dial started: no one is rung, but they asked for a person and did not reach one.
    const { callSid, callId } = await handedOver();
    expect((await relayEnded(callSid, callId, { CallStatus: 'completed' })).body).toBe(HANGUP);
    expect(await callRow(callId)).toMatchObject({ transfer_status: 'abandoned' });
    expect(await callbacks(callId)).toEqual(['the caller asked for a person and hung up before they were put through']);
    expect((await events(callId)).find((e) => e.type === 'transfer.abandoned')?.payload).toEqual({ when: 'before_dial' });
    // asked again, and the call's end reported: still one
    expect((await relayEnded(callSid, callId, { CallStatus: 'completed' })).body).toBe(HANGUP);
    await twilioPost(`/webhooks/twilio/${twilioId}/status`, { CallSid: callSid, CallStatus: 'completed', CallDuration: '20', Direction: 'inbound', From: CUSTOMER, To: OUR });
    expect(await callbacks(callId)).toHaveLength(1);

    // Hung up while the agent's phone was ringing (the owner's decision of 2026-10-10: they did not reach a person).
    const b = await handedOver();
    await relayEnded(b.callSid, b.callId);
    expect((await dialled(b.callSid, b.callId, { CallStatus: 'completed', DialCallStatus: 'canceled', DialCallDuration: '0' })).body).toBe(HANGUP);
    expect(await callRow(b.callId)).toMatchObject({ transfer_status: 'abandoned' });
    expect(await callbacks(b.callId)).toEqual(['the caller asked for a person and hung up before anyone answered']);
    expect((await dialled(b.callSid, b.callId, { CallStatus: 'completed', DialCallStatus: 'canceled' })).body).toBe(HANGUP);
    await twilioPost(`/webhooks/twilio/${twilioId}/status`, { CallSid: b.callSid, CallStatus: 'completed', CallDuration: '40', Direction: 'inbound', From: CUSTOMER, To: OUR });
    expect(await callbacks(b.callId)).toHaveLength(1);

    // Hung up while the agent was hearing the whisper, before pressing 1: no person was reached either.
    const w = await handedOver();
    await relayEnded(w.callSid, w.callId);
    await whisperReq(w.callSid, w.callId);
    expect((await dialled(w.callSid, w.callId, { CallStatus: 'completed', DialCallStatus: 'completed', DialCallDuration: '6' })).body).toBe(HANGUP);
    expect(await callRow(w.callId)).toMatchObject({ transfer_status: 'abandoned' });
    expect(await callbacks(w.callId)).toHaveLength(1);

    // Put through and then hung up: they reached a person, so no callback.
    const p = await handedOver();
    await relayEnded(p.callSid, p.callId);
    await whisperReq(p.callSid, p.callId); await acceptReq(p.callSid, p.callId, '1');
    expect((await dialled(p.callSid, p.callId, { CallStatus: 'completed', DialCallStatus: 'completed' })).body).toBe(HANGUP);
    expect(await callRow(p.callId)).toMatchObject({ transfer_status: 'answered' });
    expect(await callbacks(p.callId)).toEqual([]);
  });

  it('records the callback once when the call ends before Twilio asks what next, or at the same moment', async () => {
    const end = (callSid: string) => twilioPost(`/webhooks/twilio/${twilioId}/status`, { CallSid: callSid, CallStatus: 'completed', CallDuration: '15', Direction: 'inbound', From: CUSTOMER, To: OUR });
    // the end first, then Twilio's late question
    const a = await handedOver();
    expect((await end(a.callSid)).statusCode).toBe(204);
    expect(await callRow(a.callId)).toMatchObject({ transfer_status: 'abandoned' });
    expect(await callbacks(a.callId)).toEqual(['the caller asked for a person and hung up before they were put through']);
    expect((await relayEnded(a.callSid, a.callId, { CallStatus: 'completed' })).body).toBe(HANGUP);
    expect(await callbacks(a.callId)).toHaveLength(1);
    // both at the same moment, twice over
    const b = await handedOver();
    await Promise.all([end(b.callSid), relayEnded(b.callSid, b.callId, { CallStatus: 'completed' }), end(b.callSid), relayEnded(b.callSid, b.callId, { CallStatus: 'completed' })]);
    expect(await callbacks(b.callId)).toHaveLength(1);
    expect((await events(b.callId)).filter((e) => e.type === 'transfer.abandoned')).toHaveLength(1);
    // a call that never asked for a person records nothing when it ends
    const plain = await ring(ASK);
    await twilioPost(`/webhooks/twilio/${twilioId}/status`, { CallSid: plain.callSid, CallStatus: 'completed', CallDuration: '15', Direction: 'inbound', From: CUSTOMER, To: ASK });
    expect(await callbacks(plain.callId)).toEqual([]);
  });

  it('refuses an agent number outside Malaysia when it is set, and again at dial time for one stored before the rule', async () => {
    for (const abroad of ['+6512345678', '+14155550100', '+44 20 7946 0000']) {
      const r = await put(`/internal/tenants/${bareTenant}/transfer`, { agentNumber: abroad });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toContain('Malaysian number (+60)');
    }
    expect((await env.call(env.staffToken, 'GET', `/internal/tenants/${bareTenant}/transfer`)).json()).toBeNull();
    // the database refuses one too, whatever path writes it
    await expect(env.pool.query(`INSERT INTO transfer_settings (tenant_id, agent_e164) VALUES ($1, '+6512345678')`, [bareTenant])).rejects.toThrow(/transfer_settings_agent_malaysian/);

    // A setting stored before the rule existed (the check is NOT VALID, so old rows stay): it is never rung.
    await env.pool.query('ALTER TABLE transfer_settings DROP CONSTRAINT transfer_settings_agent_malaysian');
    await env.pool.query(`INSERT INTO transfer_settings (tenant_id, agent_e164) VALUES ($1, '+6512345678')`, [bareTenant]);
    await env.pool.query(`ALTER TABLE transfer_settings ADD CONSTRAINT transfer_settings_agent_malaysian CHECK (agent_e164 ~ '^\\+60[1-9][0-9]{7,9}$') NOT VALID`);
    try {
      const { callSid, callId } = await handedOver(BARE);
      const r = await relayEnded(callSid, callId, {}, BARE);
      expect(r.body).not.toContain('<Dial'); expect(r.body).not.toContain('6512345678');
      expect(r.body).toContain('<Say>');
      expect(await callRow(callId)).toMatchObject({ transfer_status: 'unavailable' });
      expect((await events(callId)).find((e) => e.type === 'transfer.unavailable')?.payload).toEqual({ reason: 'agent_number_not_allowed' });
      expect(await callbacks(callId)).toEqual(['the caller asked for a person and there was no one to put them through to']);
    } finally { await env.pool.query('DELETE FROM transfer_settings WHERE tenant_id = $1', [bareTenant]); }
  });

  it('counts the agent leg against the ceiling of the provider, and runs the ladder instead of dialling when the provider is full', async () => {
    const a = await handedOver();
    const before = await inUse();
    await rates(before);                                         // every channel in use: no room for an agent leg
    try {
      const r = await relayEnded(a.callSid, a.callId);
      expect(r.body).not.toContain('<Dial'); expect(r.body).toContain('<Say>');
      expect(await callRow(a.callId)).toMatchObject({ transfer_status: 'unavailable' });
      expect((await events(a.callId)).find((e) => e.type === 'transfer.unavailable')?.payload).toEqual({ reason: 'at_capacity' });
      expect(await callbacks(a.callId)).toHaveLength(1);

      // Room for exactly one more leg, and two calls asking at the same moment: one is put through, one gets the ladder.
      const b = await handedOver(); const c = await handedOver();
      const before = await inUse();
      await rates(before + 1);
      const [rb, rc] = await Promise.all([relayEnded(b.callSid, b.callId), relayEnded(c.callSid, c.callId)]);
      expect([rb.body, rc.body].filter((x) => x.includes('<Dial ')).length).toBe(1);
      expect([rb.body, rc.body].filter((x) => x.includes('<Say>')).length).toBe(1);
      const dialling = rb.body.includes('<Dial ') ? b : c;
      // the dialling leg holds exactly one more channel until the dial ends
      const held = await inUse();
      expect(held).toBe(before + 1);
      await dialled(dialling.callSid, dialling.callId, { DialCallStatus: 'no-answer', DialCallDuration: '0' });
      expect(await inUse()).toBe(held - 1);
    } finally { await rates(1000); }
  });

  it('prices the agent leg only at its own telephony rate, refuses to call it free, and waits when its length is unknown', async () => {
    const end = (callSid: string, seconds: string) => twilioPost(`/webhooks/twilio/${twilioId}/status`, { CallSid: callSid, CallStatus: 'completed', CallDuration: seconds, Direction: 'inbound', From: CUSTOMER, To: OUR });
    const putThrough = async (dial: Record<string, string>) => {
      const x = await handedOver();
      await relayEnded(x.callSid, x.callId); await whisperReq(x.callSid, x.callId); await acceptReq(x.callSid, x.callId, '1');
      await dialled(x.callSid, x.callId, dial);
      await end(x.callSid, '90');
      return x.callId;
    };
    const costRow = async (callId: string) => (await env.pool.query('SELECT cost_status, cost_error FROM calls WHERE id = $1', [callId])).rows[0];
    try {
      // A relay charge per minute and a per-call fee that apply to any direction: the agent leg pays neither.
      await rates(1000, [
        { ...LEG, rate: '0.0085', direction: 'inbound' }, { ...LEG, rate: '0.0140', direction: 'outbound' },
        { component: 'other', unit: 'per_minute', rate: '0.0700', currency: 'USD', direction: 'any', billingLine: 'speech_relay' },
      ]);
      const a = await putThrough({ DialCallDuration: '61' });
      expect((await env.pool.query(
        `SELECT l.leg, l.component, l.amount_usd FROM call_cost_lines l JOIN call_costs k ON k.id = l.call_cost_id WHERE k.call_id = $1 ORDER BY l.leg DESC, l.component DESC`, [a])).rows)
        .toEqual([
          { leg: 'caller', component: 'telephony_leg', amount_usd: '0.01700000' },
          { leg: 'caller', component: 'other', amount_usd: '0.14000000' },
          { leg: 'agent', component: 'telephony_leg', amount_usd: '0.02800000' },
        ]);
      // Only an inbound rate: the agent leg cannot be priced, so the call is refused a cost, never recorded with the leg free.
      await rates(1000, [{ ...LEG, rate: '0.0085', direction: 'inbound' }]);
      const b = await putThrough({ DialCallDuration: '61' });
      expect(await costRow(b)).toMatchObject({ cost_status: 'failed', cost_error: expect.stringContaining('no outbound telephony rate') });
      expect((await env.pool.query('SELECT count(*)::int AS n FROM call_costs WHERE call_id = $1', [b])).rows[0].n).toBe(0);
    } finally { await rates(1000); }
    // A dial that ended in a way we do not know, with no length: unknown, so the cost waits rather than calling it free.
    const c = await putThrough({ DialCallStatus: 'something-new', DialCallDuration: '' });
    expect(await costRow(c)).toMatchObject({ cost_status: 'pending' });
    // One that never connected costs nothing, length or not.
    const n = await putThrough({ DialCallStatus: 'busy', DialCallDuration: '' });
    expect(await costRow(n)).toMatchObject({ cost_status: 'recorded' });
  });

  it('costs the agent leg in the one cost record of the call, exactly, with credits only for the time of the caller', async () => {
    const lines = async (callId: string) => (await env.pool.query(
      `SELECT l.leg, l.billed_seconds, l.amount_usd FROM call_cost_lines l JOIN call_costs k ON k.id = l.call_cost_id
        WHERE k.call_id = $1 AND k.status = 'estimated' ORDER BY l.leg DESC, l.id`, [callId])).rows;
    const head = async (callId: string) => (await env.pool.query(`SELECT total_usd, credits_drawn FROM call_costs WHERE call_id = $1 AND status = 'estimated'`, [callId])).rows;
    const end = (callSid: string, seconds: string) => twilioPost(`/webhooks/twilio/${twilioId}/status`, { CallSid: callSid, CallStatus: 'completed', CallDuration: seconds, Direction: 'inbound', From: CUSTOMER, To: OUR });

    // Put through: the dial ends (61 s of agent leg), then the call (90 s). Worked by hand: the caller's leg is 2 started
    // minutes inbound at 0.0085 = 0.0170; the agent's leg 2 started minutes outbound at 0.0140 = 0.0280; total 0.0450 USD.
    // Credits: 2 minutes of the caller's time at 1 a minute = 2; the agent leg draws none.
    const a = await handedOver();
    await relayEnded(a.callSid, a.callId); await whisperReq(a.callSid, a.callId); await acceptReq(a.callSid, a.callId, '1');
    await dialled(a.callSid, a.callId, { DialCallDuration: '61' });
    await end(a.callSid, '90');
    expect(await lines(a.callId)).toEqual([
      { leg: 'caller', billed_seconds: 120, amount_usd: '0.01700000' },
      { leg: 'agent', billed_seconds: 120, amount_usd: '0.02800000' },
    ]);
    expect(await head(a.callId)).toEqual([{ total_usd: '0.04500000', credits_drawn: '2.0000' }]);
    expect((await env.pool.query(`SELECT credits FROM credit_entries WHERE ref = $1`, [`call:${a.callId}`])).rows).toEqual([{ credits: '-2.0000' }]);

    // Reconciliation checks the caller's leg against Twilio's price for the call; the agent leg is a separate call there.
    const rec = await must(post(`/internal/calls/${a.callId}/reconcile`, { source: 'manual', reportedSeconds: 90, reportedCost: '0.0170' }));
    expect(rec.json().outcome).toBe('matched');
    const reconciled = (await env.pool.query(
      `SELECT k.total_usd, array_agg(l.leg ORDER BY l.leg DESC) AS legs FROM call_costs k JOIN call_cost_lines l ON l.call_cost_id = k.id
        WHERE k.call_id = $1 AND k.status = 'reconciled' GROUP BY k.id`, [a.callId])).rows;
    expect(reconciled).toEqual([{ total_usd: '0.04500000', legs: ['caller', 'agent'] }]);

    // No one picked up: a leg that never connected costs nothing, so only the caller's leg is priced.
    const n = await handedOver();
    await relayEnded(n.callSid, n.callId);
    await dialled(n.callSid, n.callId, { DialCallStatus: 'no-answer', DialCallDuration: '0' });
    await end(n.callSid, '50');
    expect(await lines(n.callId)).toEqual([{ leg: 'caller', billed_seconds: 60, amount_usd: '0.00850000' }]);

    // The call's end arrives before the dial's (lesson L-029): the cost waits for the agent leg, never priced without it.
    const b = await handedOver();
    await relayEnded(b.callSid, b.callId); await whisperReq(b.callSid, b.callId); await acceptReq(b.callSid, b.callId, '1');
    await end(b.callSid, '90');
    expect((await env.pool.query('SELECT cost_status FROM calls WHERE id = $1', [b.callId])).rows[0].cost_status).toBe('pending');
    expect(await head(b.callId)).toEqual([]);
    expect((await events(b.callId)).filter((e) => e.type === 'call.cost_waiting')).toHaveLength(1);
    expect((await dialled(b.callSid, b.callId, { CallStatus: 'completed', DialCallDuration: '61' })).body).toBe(HANGUP);
    expect(await head(b.callId)).toEqual([{ total_usd: '0.04500000', credits_drawn: '2.0000' }]);
    expect(await callRow(b.callId)).toMatchObject({ transfer_status: 'unknown' });   // still unknown whether anyone took it
    expect(await callbacks(b.callId)).toHaveLength(1);
    await dialled(b.callSid, b.callId, { CallStatus: 'completed', DialCallDuration: '61' });   // a retry prices nothing twice
    expect(await head(b.callId)).toHaveLength(1);

    // Pricing that fails outright when the late report lands undoes only the pricing: Twilio still gets its answer, and the
    // call stays waiting for a person (it shows as unpriced in the Control Tower), with the failure audited.
    const f = await handedOver();
    await relayEnded(f.callSid, f.callId);
    await end(f.callSid, '90');
    await env.pool.query(`CREATE FUNCTION refuse_cost() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'pricing broke'; END $$;
      CREATE TRIGGER refuse_cost BEFORE INSERT ON call_costs FOR EACH ROW EXECUTE FUNCTION refuse_cost()`);
    try {
      const r = await dialled(f.callSid, f.callId, { CallStatus: 'completed', DialCallDuration: '61' });
      expect(r.statusCode).toBe(200); expect(r.body).toBe(HANGUP);
    } finally { await env.pool.query('DROP TRIGGER refuse_cost ON call_costs; DROP FUNCTION refuse_cost()'); }
    expect((await env.pool.query('SELECT cost_status, transfer_seconds FROM calls WHERE id = $1', [f.callId])).rows[0]).toEqual({ cost_status: 'pending', transfer_seconds: '61.000' });
    expect((await env.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'transfer.cost_failed' AND entity_id = $1`, [f.callId])).rows[0].n).toBe(1);
    expect(await callbacks(f.callId)).toHaveLength(1);
    expect((await post(`/internal/calls/${f.callId}/cost/retry`, {})).json()).toEqual({ cost_status: 'recorded' });

    // Twilio never reports the dial: a person settles the leg from the provider's records, once, and it is audited.
    const c = await handedOver();
    await relayEnded(c.callSid, c.callId);
    await end(c.callSid, '30');
    expect((await post(`/internal/calls/${c.callId}/cost/retry`, {})).json()).toEqual({ cost_status: 'pending' });
    expect((await post(`/internal/calls/${c.callId}/cost/retry`, { agentLegSeconds: 1.5 })).statusCode).toBe(400);
    expect((await post(`/internal/calls/${c.callId}/cost/retry`, { agentLegSeconds: 20 })).json()).toEqual({ cost_status: 'recorded' });
    expect(await lines(c.callId)).toEqual([
      { leg: 'caller', billed_seconds: 60, amount_usd: '0.00850000' },
      { leg: 'agent', billed_seconds: 60, amount_usd: '0.01400000' },
    ]);
    expect((await post(`/internal/calls/${c.callId}/cost/retry`, { agentLegSeconds: 40 })).statusCode).toBe(409);
    expect((await env.pool.query(`SELECT detail FROM audit_log WHERE action = 'transfer.agent_leg_settled' AND entity_id = $1`, [c.callId])).rows).toEqual([{ detail: { seconds: 20 } }]);
    // a call priced before agent legs were costed (rang an agent, no length kept) is not changed after the fact
    await env.pool.query('UPDATE calls SET transfer_seconds = NULL WHERE id = $1', [n.callId]);
    const late = await post(`/internal/calls/${n.callId}/cost/retry`, { agentLegSeconds: 5 });
    expect(late.statusCode).toBe(409); expect(late.json().error).toContain('already priced');
    // a call that never rang an agent has no leg to settle
    const plain = await ring(ASK);
    await twilioPost(`/webhooks/twilio/${twilioId}/status`, { CallSid: plain.callSid, CallStatus: 'completed', CallDuration: '15', Direction: 'inbound', From: CUSTOMER, To: ASK });
    expect((await post(`/internal/calls/${plain.callId}/cost/retry`, { agentLegSeconds: 20 })).statusCode).toBe(409);
  });

  it('hangs up a call that finished normally, and never leaves a caller on a session that ended mid-conversation', async () => {
    const done = await ring(ASK);
    const line = await converse(done.callSid, done.callId, 1);
    expect(line.got).toEqual([{ type: 'text', token: 'Can you pay this week?', last: true }]);
    // Twilio's session ends while the conversation is unfinished and the caller is still on the line
    const r = await relayEnded(done.callSid, done.callId, {}, ASK);
    expect(r.body).toContain('<Say>'); expect(r.body).toContain('<Hangup/>');
    expect(await callbacks(done.callId)).toEqual(['the live call could not carry on']);
    expect(await callRow(done.callId)).toMatchObject({ relay_failed: true, transfer_status: null });
    expect((await relayEnded(done.callSid, done.callId, {}, ASK)).body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(await callbacks(done.callId)).toHaveLength(1);
    await line.close();

    // the same, with the caller gone: nothing to do
    const gone = await ring(ASK);
    const l2 = await converse(gone.callSid, gone.callId, 1);
    await l2.close();
    expect((await relayEnded(gone.callSid, gone.callId, { CallStatus: 'completed' }, ASK)).body).toContain('<Hangup/>');
    expect(await callbacks(gone.callId)).toEqual([]);

    // a conversation that reached its end is simply hung up
    const fine = await ring(ASK);
    const l3 = await converse(fine.callSid, fine.callId, 1);
    await env.pool.query(`UPDATE workflow_runs SET status = 'ended', outcome = 'promised' WHERE call_id = $1`, [fine.callId]);
    expect((await relayEnded(fine.callSid, fine.callId, {}, ASK)).body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(await callbacks(fine.callId)).toEqual([]);
    await l3.close();
  });

  it('refuses a request without Twilio\'s signature, for another call, or for no call, and changes nothing', async () => {
    const { callSid, callId } = await handedOver();
    const params = { ...fixture.relayEnded, CallSid: callSid, From: CUSTOMER, To: OUR };
    expect((await twilioPost(path('relay-ended', callId), params, 'bad')).statusCode).toBe(403);
    expect((await twilioPost(path('relay-ended', callId), params, createHmac('sha1', 'other').update('x').digest('base64'))).statusCode).toBe(403);
    expect((await relayEnded('CA_someone_else', callId)).statusCode).toBe(404);
    expect((await twilioPost(`/webhooks/twilio/${twilioId}/transfer/relay-ended`, params)).statusCode).toBe(400);
    expect((await twilioPost(`/webhooks/twilio/${twilioId}/transfer/elsewhere?callId=${callId}`, params)).statusCode).toBe(400);
    expect((await dialled(callSid, callId, { DialCallStatus: 'no-answer' })).body).toContain('<Hangup/>');   // not dialling: nothing to fall back on
    expect(await callRow(callId)).toMatchObject({ transfer_status: null });
    expect(await callbacks(callId)).toEqual([]);
  });

  it('does not take a voicemail on the agent phone for a person: a dial no one took with 1 runs the callback ladder', async () => {
    const { callSid, callId } = await handedOver();
    await relayEnded(callSid, callId);
    expect((await whisperReq(callSid, callId)).body).toContain('<Gather ');
    // the voicemail picks up and says its greeting; no key is pressed, so Twilio ends the agent's leg after the Gather
    const d = await dialled(callSid, callId, { DialCallStatus: 'completed' });
    expect(d.body).toContain('<Say>'); expect(d.body).toContain('<Hangup/>');
    expect(await callRow(callId)).toMatchObject({ transfer_status: 'unanswered' });
    expect(await callbacks(callId)).toEqual(['the caller asked for a person and no one answered']);
  });

  it('ends the agent leg when its request is not for the call being put through, and records the mismatch once', async () => {
    const { callSid, callId } = await handedOver();
    expect((await whisperReq(callSid, callId)).body).toBe(HANGUP);                  // not being put through yet
    await relayEnded(callSid, callId);
    expect((await whisperReq('CA_someone_else', callId)).body).toBe(HANGUP);
    expect((await acceptReq('CA_someone_else', callId, '1')).body).toBe(HANGUP);
    expect((await whisperReq(callSid, callId, { ParentCallSid: '' })).body).toBe(HANGUP);
    expect((await events(callId)).filter((e) => e.type === 'transfer.agent_leg_unmatched')).toHaveLength(1);
    expect(await callRow(callId)).toMatchObject({ transfer_status: 'dialing' });
  });

  it('records a callback once when the call ends while the dial is under way and Twilio never says how it ended', async () => {
    const { callSid, callId } = await handedOver();
    await relayEnded(callSid, callId);
    const end = { CallSid: callSid, CallStatus: 'completed', CallDuration: '90', Direction: 'inbound', From: CUSTOMER, To: OUR };
    expect((await twilioPost(`/webhooks/twilio/${twilioId}/status`, end)).statusCode).toBe(204);
    expect(await callRow(callId)).toMatchObject({ transfer_status: 'unknown' });
    expect(await callbacks(callId)).toEqual(['the caller asked for a person and the transfer did not finish']);
    // a late dial-ended request, or the end reported again, changes nothing
    expect((await dialled(callSid, callId, { CallStatus: 'completed', DialCallStatus: 'no-answer' })).body).toBe(HANGUP);
    await twilioPost(`/webhooks/twilio/${twilioId}/status`, end);
    expect(await callbacks(callId)).toHaveLength(1);
    // a call that ends with no transfer under way records nothing
    const plain = await ring(ASK);
    await twilioPost(`/webhooks/twilio/${twilioId}/status`, { ...end, CallSid: plain.callSid, To: ASK });
    expect(await callbacks(plain.callId)).toEqual([]);
  });

  it('runs the ladder when Twilio asks again after the agent number was removed', async () => {
    const { callSid, callId } = await handedOver();
    expect((await relayEnded(callSid, callId)).body).toContain('<Dial ');
    await must(env.call(env.staffToken, 'DELETE', `/internal/tenants/${tenantId}/transfer`));
    try {
      const r = await relayEnded(callSid, callId);
      expect(r.body).not.toContain('<Dial'); expect(r.body).toContain('<Say>');
      expect(await callRow(callId)).toMatchObject({ transfer_status: 'failed' });
      expect(await callbacks(callId)).toHaveLength(1);
    } finally { await must(put(`/internal/tenants/${tenantId}/transfer`, { agentNumber: AGENT, ringSeconds: 20 })); }
  });

  it('puts a caller the workflow escalated (severe sentiment) through, and tells the agent why', async () => {
    const { callSid, callId } = await ring(ASK);
    const line = await converse(callSid, callId, 1);
    line.got.length = 0;
    // the caller is upset: the workflow escalates and passes the call to a person
    await line.say('I will call my lawyer');
    expect(line.got.at(-1)).toEqual({ type: 'end', handoffData: JSON.stringify({ reason: 'handoff_human' }) });
    await line.close();
    expect((await relayEnded(callSid, callId, {}, ASK)).body).toContain(`callerId="${ASK}"`);
    expect((await whisperReq(callSid, callId)).body).toContain('because the caller sounded upset.');
  });

  it('runs the ladder when the relay closed first, abandoning the run, and the caller is still on the line', async () => {
    const { callSid, callId } = await ring(ASK);
    const line = await converse(callSid, callId, 1);
    await line.close();
    expect((await env.pool.query(`SELECT outcome FROM workflow_runs WHERE call_id = $1`, [callId])).rows[0].outcome).toBe('abandoned');
    expect((await relayEnded(callSid, callId, {}, ASK)).body).toContain('<Say>');
    expect(await callbacks(callId)).toEqual(['the live call could not carry on']);
  });

  it('does not ring the agent for a call the relay has already fallen back on, even if its run ended in a handoff', async () => {
    const { callSid, callId } = await handedOver();
    await env.pool.query('UPDATE calls SET relay_failed = true WHERE id = $1', [callId]);
    expect((await relayEnded(callSid, callId)).body).toBe(HANGUP);
    expect(await callRow(callId)).toMatchObject({ transfer_status: null });
    expect(await callbacks(callId)).toEqual([]);
  });
});
