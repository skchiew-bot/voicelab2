import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { parseKey } from '../src/secrets.js';
import { relayCallToken } from '../src/store/relay.js';
import { twimlRelay } from '../src/telephony/relay.js';
import { dialOutcome, twimlDialAgent, whisperText } from '../src/telephony/transfer.js';
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
  });

  it('whispers the reason in fixed words and a spelt-out ticket reference, and nothing else', () => {
    expect(whisperText({ trigger: 'severe_sentiment', ticketId: 'ab12cd34-0000-4000-8000-000000000000' }))
      .toBe('A Voice Lab caller is being put through to you, because the caller sounded upset. Ticket reference A B 1 2 C D 3 4.');
    expect(whisperText({ trigger: 'workflow_handoff', ticketId: null })).toBe('A Voice Lab caller is being put through to you, because the caller asked for a person.');
    // a trigger we do not know, or one named like an inherited property, is never read out (L-003)
    expect(whisperText({ trigger: 'constructor', ticketId: 'not-a-ticket' })).toBe('A Voice Lab caller is being put through to you, because the call was passed to a person.');
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
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  port = (env.app.server.address() as { port: number }).port;
});
afterAll(async () => { await env?.teardown(); });

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
  return { got, close: async () => { ws.close(); await closed; await new Promise((r) => setTimeout(r, 50)); } };
}

const path = (step: string, callId: string) => `/webhooks/twilio/${twilioId}/transfer/${step}?callId=${callId}`;
const relayEnded = (callSid: string, callId: string, extra: Record<string, string> = {}, to = OUR) =>
  twilioPost(path('relay-ended', callId), { ...fixture.relayEnded, CallSid: callSid, From: CUSTOMER, To: to, ...extra });
const whisperReq = (callSid: string, callId: string, extra: Record<string, string> = {}) =>
  twilioPost(path('whisper', callId), { ...fixture.whisper, ParentCallSid: callSid, From: OUR, To: AGENT, ...extra });
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
    expect(w.body).toBe(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>A Voice Lab caller is being put through to you, because the caller asked for a person. Ticket reference ${ticket.slice(0, 8).toUpperCase().split('').join(' ')}.</Say></Response>`);

    const d = await dialled(callSid, callId);
    expect(d.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(await callRow(callId)).toMatchObject({ transfer_status: 'answered' });
    expect(await callbacks(callId)).toEqual([]);
    const ev = await events(callId);
    expect(ev.map((e) => e.type)).toEqual(expect.arrayContaining(['transfer.dialing', 'transfer.whispered', 'transfer.answered']));
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

  it('dials the agent once when Twilio asks twice at the same moment', async () => {
    const { callSid, callId } = await handedOver();
    const rs = await Promise.all([relayEnded(callSid, callId), relayEnded(callSid, callId), relayEnded(callSid, callId)]);
    // a retry is given the same dial, since the first answer may never have reached Twilio; it is recorded once
    for (const r of rs) expect(r.body).toContain('<Dial ');
    expect((await events(callId)).filter((e) => e.type === 'transfer.dialing')).toHaveLength(1);
  });

  it('does not ring an agent, or record a callback, for a caller who has already gone', async () => {
    const { callSid, callId } = await handedOver();
    expect((await relayEnded(callSid, callId, { CallStatus: 'completed' })).body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
    expect(await callRow(callId)).toMatchObject({ transfer_status: null });
    expect(await callbacks(callId)).toEqual([]);

    // hung up while the agent's phone was ringing: not a failure to reach anyone, and no callback (L-005)
    const b = await handedOver();
    await relayEnded(b.callSid, b.callId);
    expect((await dialled(b.callSid, b.callId, { CallStatus: 'completed', DialCallStatus: 'canceled' })).body).toContain('<Hangup/>');
    expect(await callRow(b.callId)).toMatchObject({ transfer_status: 'abandoned' });
    expect(await callbacks(b.callId)).toEqual([]);
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
    // a whisper for a call that is not being put through, or whose parent is another call, says nothing
    expect((await whisperReq(callSid, callId)).body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    await relayEnded(callSid, callId);
    expect((await whisperReq('CA_someone_else', callId)).body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    expect((await whisperReq(callSid, callId)).body).toContain('<Say>');
  });
});
