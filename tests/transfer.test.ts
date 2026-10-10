import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { parseKey } from '../src/secrets.js';
import { relayCallToken } from '../src/store/relay.js';
import { twimlRelay } from '../src/telephony/relay.js';
import { dialOutcome, twimlDialAgent, twimlWhisper, whisperText } from '../src/telephony/transfer.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';
import { localParts } from '../src/cases/policy.js';
import { countryZone, numberZone } from '../src/telephony/countries.js';

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
    // the agent must press 1; silence (a voicemail) or any other key ends the agent's leg
    expect(twimlWhisper('Hi <there>.', 'https://v.test/a?callId=c1&b=2')).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Gather action="https://v.test/a?callId=c1&amp;b=2" method="POST" numDigits="1" timeout="8">'
      + '<Say>Hi &lt;there&gt;. Press 1 to take the call.</Say></Gather><Hangup/></Response>');
  });

  it('places a number in its country by calling code, telling apart the countries that share +1 and +7, and knows nothing it was not told', () => {
    expect(numberZone('+60387654321')).toBe('MY');
    expect(numberZone('+6561234567')).toBe('SG');
    expect(numberZone('+420212345678')).toBe('CZ');
    expect(numberZone('+12125550123')).toBe('US/CA');
    expect(numberZone('+14165550123')).toBe('US/CA');
    expect(numberZone('+18765550123')).toBe('JM');          // a Caribbean area code is its own country, not the United States
    expect(numberZone('+77012345678')).toBe('KZ');
    expect(numberZone('+74951234567')).toBe('RU');
    expect(numberZone('+99912345678')).toBeNull();
    expect(numberZone('60387654321')).toBeNull();
    expect(countryZone('ca')).toBe('US/CA'); expect(countryZone('JM')).toBe('JM'); expect(countryZone('XX')).toBeNull();
    expect(countryZone('constructor')).toBeNull();
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
    // only in a country where the client has one of our numbers (Malaysia here): never abroad, never somewhere unknown
    for (const abroad of ['+6561234567', '+18765550123', '+12125550123', '+99912345678']) {
      const r = await put(`/internal/tenants/${tenantId}/transfer`, { agentNumber: abroad });
      expect(r.statusCode, abroad).toBe(400);
    }
    expect((await put(`/internal/tenants/${tenantId}/transfer`, { agentNumber: '+6561234567' })).json().error).toContain('(MY)');
    const noNumbers = (await must(post('/internal/tenants', { name: 'Numberless Co' }))).json().id;
    expect((await put(`/internal/tenants/${noNumbers}/transfer`, { agentNumber: AGENT })).statusCode).toBe(409);
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

  it('does not ring an agent for a caller who has already gone, and leaves the client a note to call them back, once', async () => {
    const { callSid, callId } = await handedOver();
    expect((await relayEnded(callSid, callId, { CallStatus: 'completed' })).body).toBe(HANGUP);
    expect(await callRow(callId)).toMatchObject({ transfer_status: 'abandoned' });
    expect(await callbacks(callId)).toEqual(['the caller asked for a person and hung up before reaching one']);
    expect((await relayEnded(callSid, callId, { CallStatus: 'completed' })).body).toBe(HANGUP);
    expect(await callbacks(callId)).toHaveLength(1);

    // hung up while the agent's phone was ringing: the same note, once
    const b = await handedOver();
    await relayEnded(b.callSid, b.callId);
    expect((await dialled(b.callSid, b.callId, { CallStatus: 'completed', DialCallStatus: 'canceled' })).body).toContain('<Hangup/>');
    expect(await callRow(b.callId)).toMatchObject({ transfer_status: 'abandoned' });
    expect(await dialled(b.callSid, b.callId, { CallStatus: 'completed', DialCallStatus: 'canceled' })).toBeTruthy();
    expect(await callbacks(b.callId)).toEqual(['the caller asked for a person and hung up before reaching one']);
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

  it('calls a caller on a case back after they hang up waiting for a person: within the hour, or at the end of quiet hours', async () => {
    const KL = 'Asia/Kuala_Lumpur';
    const hhmm = (d: Date) => { const p = localParts(d, KL); return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`; };
    const hours = (h: number) => new Date(Date.now() + h * 3_600_000);
    const policy = (quietStart: string, quietEnd: string) => must(put(`/internal/tenants/${tenantId}/contact-policy`, { timeZone: KL, quietStart, quietEnd, maxPerDay: 20, maxPerWeek: 50, minGapMinutes: 0 }));
    const onCase = async () => {
      const ref = `T-${++n}`;
      const caseId = (await must(post(`/internal/tenants/${tenantId}/cases`, { caseRef: ref, contactRef: `client-${ref}`, phone: CUSTOMER, country: 'MY', currency: 'MYR', openingBalance: '100.00', timeZone: KL }))).json().id as string;
      const h = await handedOver();
      await env.pool.query('UPDATE calls SET case_id = $2 WHERE id = $1', [h.callId, caseId]);
      return { ...h, caseId };
    };
    const callbackFor = async (caseId: string) => (await env.pool.query(`SELECT kind, channel, scheduled_for, locked_for, status FROM case_actions WHERE case_id = $1 AND dedupe_key LIKE 'transfer-callback:%'`, [caseId])).rows;

    // quiet hours far from now: called back in about a quarter of an hour, by our own dial (through the gate), not a note
    await policy(hhmm(hours(6)), hhmm(hours(8)));
    const a = await onCase();
    const before = Date.now();
    await relayEnded(a.callSid, a.callId, { CallStatus: 'completed' });
    const [cb] = await callbackFor(a.caseId);
    expect(cb).toMatchObject({ kind: 'callback', channel: 'voice', status: 'pending' });
    const due = new Date(cb.scheduled_for).getTime();
    expect(due).toBeGreaterThanOrEqual(before + 15 * 60_000 - 1000);
    expect(due).toBeLessThanOrEqual(Date.now() + 15 * 60_000 + 1000);
    expect(await callbacks(a.callId)).toEqual([]);
    await relayEnded(a.callSid, a.callId, { CallStatus: 'completed' });
    expect(await callbackFor(a.caseId)).toHaveLength(1);                            // once, however often Twilio asks

    // quiet hours now and for the next two hours: called back the moment they end, not inside them
    await policy(hhmm(hours(-1)), hhmm(hours(2)));
    const b = await onCase();
    await relayEnded(b.callSid, b.callId);
    await dialled(b.callSid, b.callId, { CallStatus: 'completed', DialCallStatus: 'canceled' });
    const [late] = await callbackFor(b.caseId);
    expect(hhmm(new Date(late.scheduled_for))).toBe(hhmm(hours(2)));
    expect(new Date(late.scheduled_for).getTime()).toBeGreaterThan(Date.now() + 90 * 60_000);
    expect(new Date(late.locked_for).getTime()).toBe(new Date(late.scheduled_for).getTime());
    await policy('21:00', '08:00');
  });

  it('costs the agent leg as ours, draws credits on the caller\'s call only, and checks both legs against Twilio', async () => {
    const st = env.staffToken;
    await must(env.call(st, 'POST', `/internal/providers/${twilioId}/charging/reference`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 60 }));
    await must(env.call(st, 'POST', '/internal/fx', { currency: 'MYR', perUsd: '4.5', effectiveFrom: '2026-01-01T00:00:00Z' }));
    await must(env.call(st, 'POST', '/internal/rate-card', { effectiveFrom: '2026-01-01T00:00:00Z', inboundCreditsPerMinute: '1', outboundCreditsPerMinute: '2', creditValueUsd: '0.01' }));
    const { callSid, callId } = await handedOver();
    await relayEnded(callSid, callId);
    await whisperReq(callSid, callId); await acceptReq(callSid, callId, '1');
    await dialled(callSid, callId, { DialCallStatus: 'completed', DialCallSid: 'CA_agent_leg_7', DialCallDuration: '61' });
    expect((await env.pool.query('SELECT transfer_leg_sid, transfer_seconds FROM calls WHERE id = $1', [callId])).rows[0]).toEqual({ transfer_leg_sid: 'CA_agent_leg_7', transfer_seconds: '61.000' });
    // the call ends: 3 minutes in all, 61 seconds of it with the agent
    expect((await twilioPost(`/webhooks/twilio/${twilioId}/status`, { CallSid: callSid, CallStatus: 'completed', CallDuration: '180', Direction: 'inbound', From: CUSTOMER, To: OUR })).statusCode).toBe(204);
    expect((await env.pool.query('SELECT cost_status, cost_error FROM calls WHERE id = $1', [callId])).rows[0]).toEqual({ cost_status: 'recorded', cost_error: null });
    const cost = (await env.pool.query(`SELECT id, credits_drawn FROM call_costs WHERE call_id = $1 AND status = 'estimated'`, [callId])).rows[0];
    expect(cost.credits_drawn).toBe('3.0000');                                   // 3 inbound minutes at 1 credit: the whole call, once
    // the caller's leg at Twilio's inbound rate, and the agent's (61 s, billed by the minute) at its outbound rate
    const legs = (await env.pool.query(`SELECT billed_seconds, rate FROM call_cost_lines WHERE call_cost_id = $1 AND component = 'telephony_leg' ORDER BY id`, [cost.id])).rows;
    expect(legs).toEqual([{ billed_seconds: 180, rate: '0.00850000' }, { billed_seconds: 120, rate: '0.01400000' }]);

    // Twilio's figures for both legs, each looked up by its own id
    const seen: string[] = [];
    env.provider.state.respond = (url) => { seen.push(url); return new Response(JSON.stringify(url.includes('CA_agent_leg_7') ? { duration: '61', price: '-0.0200', price_unit: 'USD' } : { duration: '180', price: '-0.0300', price_unit: 'USD' }), { status: 200 }); };
    const r = await env.call(st, 'POST', `/internal/calls/${callId}/reconcile`, { source: 'provider_api' });
    expect(r.statusCode).toBe(200);
    expect(seen.some((u) => u.includes(`/Calls/${callSid}.json`))).toBe(true);
    expect(seen.some((u) => u.includes('/Calls/CA_agent_leg_7.json'))).toBe(true);
    const rec = (await env.pool.query('SELECT our_seconds, reported_seconds, reported_cost_usd FROM call_reconciliations WHERE call_id = $1', [callId])).rows[0];
    expect(rec).toEqual({ our_seconds: '241.000', reported_seconds: '241.000', reported_cost_usd: '0.05000000' });
    // reconciling never draws credits again
    expect((await env.pool.query(`SELECT sum(credits_drawn)::text AS n FROM call_costs WHERE call_id = $1 AND status = 'estimated'`, [callId])).rows[0].n).toBe('3.0000');
  });
});
