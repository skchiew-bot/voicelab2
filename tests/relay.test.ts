import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { parseKey } from '../src/secrets.js';
import { failed, mediaLink, mediaLinkValid, MEDIA_LINK_SECONDS, openRelay, relayCallToken, STUCK_REPLY_MS } from '../src/store/relay.js';
import { parseRelay, relaySettings, sayMessages, twimlRelay } from '../src/telephony/relay.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/twilio-relay.json', import.meta.url), 'utf8'));

describe('the speech relay messages', () => {
  it('reads every message Twilio sends in the published shape, and ignores anything malformed', () => {
    for (const [name, m] of Object.entries(fixture.inbound)) expect(parseRelay(JSON.stringify(m)), name).toMatchObject({ type: (m as { type: string }).type });
    expect(parseRelay('not json')).toBeNull();
    expect(parseRelay(JSON.stringify({ type: 'prompt' }))).toBeNull();                       // no words
    expect(parseRelay(JSON.stringify({ type: 'surprise', voicePrompt: 'x' }))).toBeNull();
    expect(parseRelay(JSON.stringify({ type: 'prompt', voicePrompt: 'x'.repeat(70_000) }))).toBeNull();
  });

  it('says a line in order: recordings by link, the rest as text, and speaks a recording it cannot link', () => {
    const lines = [{ lang: 'en', segments: [
      { kind: 'recorded' as const, characters: 6, recordingId: 'r1', durationMs: 900, text: 'Hello ' },
      { kind: 'synth' as const, characters: 5, text: 'Aisha' },
      { kind: 'recorded' as const, characters: 9, recordingId: 'r2', durationMs: 900, text: ', welcome.' },
    ] }];
    expect(sayMessages(lines, (id) => (id === 'r1' ? 'https://x.test/r1' : null))).toEqual([
      { type: 'play', source: 'https://x.test/r1' }, { type: 'text', token: 'Aisha', last: true }, { type: 'text', token: ', welcome.', last: true },
    ]);
    // the shapes we send are the published ones
    expect(Object.keys(fixture.outbound.text).sort()).toEqual(['last', 'token', 'type']);
    expect(Object.keys(fixture.outbound.play).sort()).toEqual(['source', 'type']);
  });

  it('hands an answered call to the relay by its id, escaping every setting, and leaves out a setting in an unexpected form', () => {
    const s = relaySettings({ relayLanguage: 'ms-MY', relayVoice: 'Aoede "x"><Hangup/>', relayTtsProvider: 'Google' });
    expect(s).toEqual({ language: 'ms-MY', ttsProvider: 'Google', voice: undefined, transcriptionProvider: undefined });
    expect(relaySettings({}).language).toBe('en-US');
    const x = twimlRelay('wss://v.test/relay/twilio/p', 'c-1"/><Hangup/>', 'k1', s);
    expect(x).toContain('<Connect><ConversationRelay url="wss://v.test/relay/twilio/p" language="ms-MY" ttsProvider="Google" interruptible="speech" dtmfDetection="false">');
    expect(x).toContain('<Parameter name="callId" value="c-1&quot;/&gt;&lt;Hangup/&gt;"/><Parameter name="token" value="k1"/>');
    expect(x).not.toContain('welcomeGreeting');
  });

  it('signs a recording link for one recording and a short time, and refuses any other', () => {
    const key = Buffer.alloc(32, 7); const now = new Date('2026-10-10T10:00:00Z'); const id = '11111111-1111-4111-8111-111111111111';
    const u = new URL(mediaLink('https://v.test', key, id, now));
    const exp = u.searchParams.get('exp')!; const sig = u.searchParams.get('sig')!;
    expect(mediaLinkValid(key, id, exp, sig, now)).toBe(true);
    expect(mediaLinkValid(key, id, exp, sig, new Date(now.getTime() + (MEDIA_LINK_SECONDS + 1) * 1000))).toBe(false);   // expired
    expect(mediaLinkValid(key, '22222222-2222-4222-8222-222222222222', exp, sig, now)).toBe(false);                   // another recording
    expect(mediaLinkValid(key, id, String(Number(exp) + 1), sig, now)).toBe(false);                                      // tampered time
    expect(mediaLinkValid(Buffer.alloc(32, 8), id, exp, sig, now)).toBe(false);                                         // another key
    expect(mediaLinkValid(key, id, String(Number(exp) + 86_400), createHmac('sha256', 'x').update('y').digest('hex'), now)).toBe(false);
  });
});

// ------------------------------------------------------------------ a live call, end to end, against fakes
type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let otherTenant: string; let twilioId: string; let numberId: string; let wfId: string; let otherWf: string; let recId: string;
const BASE = 'https://voicelab.test';
const TW_TOKEN = 'tw-relay-token';
const OUR = '+60300000777'; const CUSTOMER = '+60123450000';

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
const twilioPost = (path: string, params: Record<string, string>) => env.app.inject({
  method: 'POST', url: path, payload: new URLSearchParams(params).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSig(BASE + path, params) },
});

const flow: WorkflowDefinition = {
  start: 'hi', variables: [],
  nodes: {
    hi: { type: 'speak', speech: 'fixed', text: 'Hello from Voice Lab.', transitions: [{ to: 'ask' }] },
    ask: { type: 'speak', speech: 'fixed', text: 'Can you pay this week?', listen: { captureAs: 'a', intents: { yes: ['yes'], no: ['no'] } },
      transitions: [{ when: { var: 'a_intent', op: 'eq', value: 'yes' }, to: 'word' }, { to: 'bye' }] },
    word: { type: 'speak', speech: 'fixed', text: 'Please say your secret word.', listen: { captureAs: 'secret', sensitive: true }, transitions: [{ to: 'bye' }] },
    bye: { type: 'speak', speech: 'fixed', text: 'Thank you. Goodbye.', transitions: [{ to: 'done' }] },
    done: { type: 'end', outcome: 'promised' },
  },
};

async function liveWorkflow(tenant: string, name: string, def: WorkflowDefinition, scenario: { replies: string[]; outcome: string; integrations?: object }) {
  const c = (await must(post(`/internal/tenants/${tenant}/workflows`, { name, definition: def }))).json();
  await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'staging' }));
  await must(post(`/internal/workflows/${c.workflow.id}/simulate`, { scenarios: [{ name: 's', variables: {}, replies: scenario.replies, integrations: scenario.integrations, expect: { outcome: scenario.outcome } }] }));
  await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'production' }));
  return c.workflow.id as string;
}

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  tenantId = (await must(post('/internal/tenants', { name: 'Relay Co' }))).json().id;
  otherTenant = (await must(post('/internal/tenants', { name: 'Other Co' }))).json().id;
  twilioId = (await must(post('/internal/providers', { adapterKey: 'twilio', name: 'tw-relay',
    params: { accountSid: 'AC1', authToken: TW_TOKEN, twimlAppVoiceUrl: `${BASE}/v`, relayLanguage: 'en-GB', relayTtsProvider: 'ElevenLabs' } }))).json().id;
  numberId = (await must(post('/internal/numbers', { providerId: twilioId, e164: OUR, tenantId, country: 'MY' }))).json().id;
  wfId = await liveWorkflow(tenantId, 'relay_flow', flow, { replies: ['yes', 'banana'], outcome: 'promised' });
  otherWf = await liveWorkflow(otherTenant, 'other_flow', flow, { replies: ['no'], outcome: 'promised' });
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(64, 1)]);
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  port = (env.app.server.address() as { port: number }).port;
  recId = (await must(post(`/internal/tenants/${tenantId}/recordings`, { language: 'en', text: 'Hello from Voice Lab.', contentType: 'audio/wav', audioBase64: wav.toString('base64'), durationMs: 1200 }))).json().id;
});
afterAll(async () => { await env?.teardown(); });

let n = 0;
/** A caller rings our number; Twilio asks what to do. */
async function ring(): Promise<{ callSid: string; twiml: string; callId: string }> {
  const callSid = `CA_relay_${++n}`;
  const r = await twilioPost(`/webhooks/twilio/${twilioId}/voice`, { CallSid: callSid, CallStatus: 'ringing', Direction: 'inbound', From: CUSTOMER, To: OUR });
  expect(r.statusCode).toBe(200);
  const callId = (await env.pool.query('SELECT id FROM calls WHERE provider_call_id = $1', [callSid])).rows[0]?.id;
  return { callSid, twiml: r.body, callId };
}

const wsPath = () => `/relay/twilio/${twilioId}`;
const wsSig = (scheme = 'wss') => twilioSig(`${scheme}://voicelab.test${wsPath()}`, {});

interface Line { ws: WebSocket; got: Record<string, unknown>[]; closed: Promise<void>; send(m: object): void; until(count: number): Promise<Record<string, unknown>[]> }
let port = 0;
async function connect(sig: string | null = wsSig(), path?: string): Promise<Line> {
  const got: Record<string, unknown>[] = [];
  // A real socket to a listening server, as the relay would open.
  const ws = new WebSocket(`ws://127.0.0.1:${port}${path ?? wsPath()}`, { headers: sig === null ? {} : { 'x-twilio-signature': sig } });
  await new Promise<void>((ok, bad) => { ws.once('open', () => ok()); ws.once('unexpected-response', (_q, r) => bad(new Error(`refused: ${r.statusCode}`))); ws.once('error', bad); });
  ws.on('message', (d) => got.push(JSON.parse(String(d))));
  const closed = new Promise<void>((r) => ws.on('close', () => r()));
  return {
    ws, got, closed, send: (m) => ws.send(JSON.stringify(m)),
    async until(count) { for (let i = 0; i < 200 && got.length < count; i++) await new Promise((r) => setTimeout(r, 10)); return got; },
  };
}
const setup = (callSid: string, callId: string, token?: string) => ({ ...fixture.inbound.setup, callSid, customParameters: { callId, token: token ?? relayCallToken(parseKey(env.config.VOICELAB_SECRET_KEY), callId) } });
const relayDeps = () => ({ runs: { pool: env.pool, key: parseKey(env.config.VOICELAB_SECRET_KEY) }, baseUrl: BASE });
const callbacks = async (callId: string) => (await env.pool.query('SELECT count(*)::int AS n FROM callback_requests WHERE call_id = $1', [callId])).rows[0].n as number;
const prompt = (voicePrompt: string, last = true) => ({ type: 'prompt', voicePrompt, lang: 'en-US', last });
const runOf = async (callId: string) => (await env.pool.query(`SELECT id, status, outcome, state, sealed, kind FROM workflow_runs WHERE call_id = $1`, [callId])).rows;
const settle = () => new Promise((r) => setTimeout(r, 50));

describe('a live call through the speech relay', () => {
  it('hands a call to a number with a workflow to the relay, with the provider\'s voice settings; one without hears the test message', async () => {
    const before = await ring();
    expect(before.twiml).toContain('<Say>');                                                   // no workflow yet
    expect(before.twiml).not.toContain('ConversationRelay');
    await must(put(`/internal/numbers/${numberId}/workflow`, { workflowId: wfId }));
    const call = await ring();
    expect(call.twiml).toContain(`<ConversationRelay url="wss://voicelab.test/relay/twilio/${twilioId}" language="en-GB" ttsProvider="ElevenLabs"`);
    expect(call.twiml).toContain(`<Parameter name="callId" value="${call.callId}"/><Parameter name="token" value="${relayCallToken(parseKey(env.config.VOICELAB_SECRET_KEY), call.callId)}"/>`);
  });

  it('will not let a number answer with another client\'s workflow, and only an admin sets it', async () => {
    const r = await put(`/internal/numbers/${numberId}/workflow`, { workflowId: otherWf });
    expect(r.statusCode).toBe(400); expect(r.json().error).toContain('does not belong to this client');
    expect((await env.pool.query('SELECT inbound_workflow_id FROM phone_numbers WHERE id = $1', [numberId])).rows[0].inbound_workflow_id).toBe(wfId);
    const d = await post('/internal/calls/outbound', { tenantId, country: 'MY', to: CUSTOMER, providerId: twilioId, workflowId: otherWf });
    expect(d.statusCode).toBe(400); expect(d.json().error).toContain('does not belong to this client');
  });

  it('refuses a connection without Twilio\'s signature, or signed with another key, before it opens', async () => {
    await expect(connect(null)).rejects.toThrow();
    await expect(connect(createHmac('sha1', 'wrong').update(`wss://voicelab.test${wsPath()}`).digest('base64'))).rejects.toThrow();
    await expect(connect(wsSig(), `/relay/twilio/${twilioId}x`)).rejects.toThrow(/refused: 400/);
    await expect(connect(null)).rejects.toThrow(/refused: 403/);
  });

  it('talks with the caller: plays the recorded greeting, asks, applies each answer, never keeps a sensitive one, and ends', async () => {
    const { callSid, callId } = await ring();
    const line = await connect();
    line.send(setup(callSid, callId));
    const first = await line.until(2);
    expect(first[0]).toMatchObject({ type: 'play' });
    const link = new URL(String(first[0]!.source));
    expect(link.pathname).toBe(`/media/recordings/${recId}`);
    expect(first[1]).toEqual({ type: 'text', token: 'Can you pay this week?', last: true });
    // the relay can fetch the recording through that link, and only through it
    const audio = await env.app.inject({ method: 'GET', url: link.pathname + link.search });
    expect(audio.statusCode).toBe(200); expect(audio.headers['content-type']).toBe('audio/wav');
    expect((await env.app.inject({ method: 'GET', url: link.pathname + '?exp=' + link.searchParams.get('exp') + '&sig=' + '0'.repeat(64) })).statusCode).toBe(403);

    line.send(fixture.inbound.interrupt); line.send(prompt('yes I', false));                // neither moves the call on
    await settle();
    expect(line.got).toHaveLength(2);
    line.send(prompt('yes I can'));
    expect((await line.until(3))[2]).toEqual({ type: 'text', token: 'Please say your secret word.', last: true });
    line.send(prompt('pineapple'));
    const all = await line.until(5);
    expect(all.slice(3)).toEqual([{ type: 'text', token: 'Thank you. Goodbye.', last: true }, { type: 'end' }]);
    line.ws.close(); await line.closed; await settle();

    const [run] = await runOf(callId);
    expect(run).toMatchObject({ kind: 'live', status: 'ended', outcome: 'promised', sealed: null });
    const steps = (await env.pool.query(`SELECT type, payload FROM workflow_run_steps WHERE run_id = $1 ORDER BY seq`, [run.id])).rows;
    expect(JSON.stringify(steps)).not.toContain('pineapple');
    expect(JSON.stringify(run.state)).not.toContain('pineapple');
    expect(steps.filter((s) => s.type === 'say').every((s) => JSON.stringify(s.payload.segments).includes('"chars"') && !JSON.stringify(s.payload.segments).includes('"text"'))).toBe(true);
    const ev = (await env.pool.query(`SELECT type FROM call_events WHERE call_id = $1 ORDER BY id`, [callId])).rows.map((r) => r.type);
    expect(ev).toEqual(expect.arrayContaining(['relay.connected', 'relay.closed']));
  });

  it('does not apply an answer to a question the caller had not yet heard', async () => {
    const { callSid, callId } = await ring();
    const line = await connect();
    line.send(setup(callSid, callId)); await line.until(2);
    // Two finished utterances arrive together: the first answers the question; the second was said before the next one was asked.
    line.send(prompt('yes')); line.send(prompt('mango'));
    await line.until(3); await settle();
    expect(line.got.slice(2)).toEqual([{ type: 'text', token: 'Please say your secret word.', last: true }]);
    const [run] = await runOf(callId);
    expect(run.status).toBe('awaiting_reply');
    line.ws.close(); await line.closed; await settle();
  });

  it('carries on the same run when the relay reconnects, and starts the workflow once when two connections arrive together', async () => {
    const { callSid, callId } = await ring();
    const [a, b] = await Promise.all([connect(), connect()]);
    a.send(setup(callSid, callId)); b.send(setup(callSid, callId));
    await a.until(2); await b.until(0); await settle();
    expect(await runOf(callId)).toHaveLength(1);
    expect(a.got.length + b.got.length).toBe(2);                                               // the greeting and question, said once
    // b carries on where the call is: its answer applies
    const speaker = a.got.length ? b : a;
    speaker.send(prompt('no'));
    await speaker.until(2); await settle();
    expect(speaker.got.at(-1)).toEqual({ type: 'end' });
    for (const l of [a, b]) l.ws.close();
    await Promise.all([a.closed, b.closed]); await settle();
    expect((await runOf(callId))[0]).toMatchObject({ status: 'ended', outcome: 'promised' });
  });

  it('starts the workflow once, says its first lines once, and fails nobody when five connections for one call arrive at the same moment', async () => {
    await must(put(`/internal/numbers/${numberId}/workflow`, { workflowId: wfId }));
    const { callSid, callId } = await ring();
    const d = relayDeps();
    const opened = await Promise.all(Array.from({ length: 5 }, () => openRelay(d, twilioId, setup(callSid, callId))));
    expect(await runOf(callId)).toHaveLength(1);
    expect(opened.map((o) => o.send.length).sort()).toEqual([0, 0, 0, 0, 2]);
    expect(opened.every((o) => o.session !== null)).toBe(true);
    expect((await env.pool.query('SELECT count(*)::int AS n FROM callback_requests WHERE call_id = $1', [callId])).rows[0].n).toBe(0);
  });

  it('serves no call it is not: the id of another call, the wrong Twilio call, a malformed id, or a missing or wrong call key ends the line and starts nothing', async () => {
    const mine = await ring(); const theirs = await ring();
    const key = parseKey(env.config.VOICELAB_SECRET_KEY);
    for (const s of [setup(theirs.callSid, mine.callId), setup('CA_nope', mine.callId), setup(mine.callSid, 'not-a-uuid'),
      setup(mine.callSid, mine.callId, relayCallToken(key, theirs.callId)), setup(mine.callSid, mine.callId, 'f'.repeat(64)), { ...setup(mine.callSid, mine.callId), customParameters: { callId: mine.callId } }]) {
      const line = await connect();
      line.send(s);
      expect(await line.until(1)).toEqual([{ type: 'end' }]);
      await line.closed;
    }
    expect(await runOf(mine.callId)).toHaveLength(0);
    expect(await runOf(theirs.callId)).toHaveLength(0);
  });

  it('does not hang the server when more calls are answered at once than it has database connections', async () => {
    await must(put(`/internal/numbers/${numberId}/workflow`, { workflowId: wfId }));
    const calls = []; for (let i = 0; i < 14; i++) calls.push(await ring());
    const d = relayDeps();
    const all = Promise.all(calls.map((c) => openRelay(d, twilioId, setup(c.callSid, c.callId))));
    const r = await Promise.race([all, new Promise<'hung'>((ok) => setTimeout(() => ok('hung'), 20_000))]);
    expect(r).not.toBe('hung');
    expect((r as { send: unknown[] }[]).every((o) => o.send.length === 2)).toBe(true);
  }, 30_000);

  it('keeps serving the call on a new connection when the old one closes after it', async () => {
    await must(put(`/internal/numbers/${numberId}/workflow`, { workflowId: wfId }));
    const { callSid, callId } = await ring();
    const old = await connect();
    old.send(setup(callSid, callId)); await old.until(2);
    const fresh = await connect();
    fresh.send(setup(callSid, callId)); await settle(); await settle();
    old.ws.close(); await old.closed; await settle();
    expect((await runOf(callId))[0].status).toBe('awaiting_reply');                       // the stale line closing did not end it
    fresh.send(prompt('yes'));
    expect((await fresh.until(1))[0]).toEqual({ type: 'text', token: 'Please say your secret word.', last: true });
    fresh.ws.close(); await fresh.closed; await settle();
    expect((await runOf(callId))[0]).toMatchObject({ status: 'ended', outcome: 'abandoned' });  // the line that held it did
  });

  it('falls back, once, when a reply was left half-applied by a server that stopped', async () => {
    await must(put(`/internal/numbers/${numberId}/workflow`, { workflowId: wfId }));
    const { callSid, callId } = await ring();
    const line = await connect();
    line.send(setup(callSid, callId)); await line.until(2);
    const [run] = await runOf(callId);
    await env.pool.query(`UPDATE workflow_runs SET status = 'processing', claimed_at = now() - make_interval(secs => $2) WHERE id = $1`, [run.id, STUCK_REPLY_MS / 1000 + 5]);
    line.send(prompt('yes'));                                                                   // refused as "being applied", but nothing is
    const got = await line.until(4);
    expect(got.slice(2).map((m) => m.type)).toEqual(['text', 'end']);
    expect(await callbacks(callId)).toBe(1);
    line.ws.close(); await line.closed;
    // a reconnect after the fallback ends the line and records nothing more
    const again = await connect();
    again.send(setup(callSid, callId));
    expect(await again.until(1)).toEqual([{ type: 'end' }]);
    again.ws.close(); await again.closed;
    expect(await callbacks(callId)).toBe(1);
    // two failures landing on one call (the server's last-resort handler and the relay's own) record one callback
    const tenant = (await env.pool.query('SELECT tenant_id FROM calls WHERE id = $1', [callId])).rows[0].tenant_id;
    const session = { providerId: twilioId, callId, tenantId: tenant, projectId: null, runId: null, version: 0, ended: false, owner: 'x' };
    await Promise.all([failed(relayDeps(), { ...session }), failed(relayDeps(), { ...session })]);
    expect(await callbacks(callId)).toBe(1);
  });

  it('ends a run the caller hung up on, wiping what it held sensitive', async () => {
    const { callSid, callId } = await ring();
    const line = await connect();
    line.send(setup(callSid, callId)); await line.until(2);
    line.send(prompt('yes')); await line.until(3);
    line.ws.close(); await line.closed; await settle();
    const [run] = await runOf(callId);
    expect(run).toMatchObject({ status: 'ended', outcome: 'abandoned', sealed: null });
  });

  it('never leaves the caller in silence when the workflow fails: records a callback first, says the holding message, and ends', async () => {
    const broken: WorkflowDefinition = { start: 'look', variables: [], nodes: {
      look: { type: 'api', integration: 'billing', path: '/x', transitions: [{ to: 'done' }] }, done: { type: 'end', outcome: 'ok' } } };
    // It passes its simulation, where the client's system is stood in for; on the live call that system is not connected.
    const brokenId = await liveWorkflow(tenantId, 'broken_flow', broken, { replies: [], outcome: 'ok', integrations: { billing: { ok: true } } });
    await must(put(`/internal/numbers/${numberId}/workflow`, { workflowId: brokenId }));
    const { callSid, callId } = await ring();
    await must(put(`/internal/numbers/${numberId}/workflow`, { workflowId: wfId }));
    const line = await connect();
    line.send(setup(callSid, callId));
    const got = await line.until(2);
    expect(got[0]).toMatchObject({ type: 'text', last: true });
    expect(String(got[0]!.token).length).toBeGreaterThan(0);
    expect(got[1]).toEqual({ type: 'end' });
    const cb = (await env.pool.query('SELECT reason FROM callback_requests WHERE call_id = $1', [callId])).rows;
    expect(cb).toEqual([{ reason: 'the live call could not carry on' }]);
    line.ws.close(); await line.closed;
  });

  it('accepts the signature on the https form of the address too, as the scheme Twilio signs is not yet confirmed', async () => {
    const { callSid, callId } = await ring();
    const line = await connect(wsSig('https'));
    line.send(setup(callSid, callId));
    expect((await line.until(2))[1]).toMatchObject({ type: 'text' });
    line.ws.close(); await line.closed; await settle();
  });

  it('keeps recordings out of reach without a signed link', async () => {
    expect((await env.app.inject({ method: 'GET', url: `/media/recordings/${recId}` })).statusCode).toBe(403);
    const key = parseKey(env.config.VOICELAB_SECRET_KEY);
    const old = new URL(mediaLink(BASE, key, recId, new Date(Date.now() - (MEDIA_LINK_SECONDS + 5) * 1000)));
    expect((await env.app.inject({ method: 'GET', url: old.pathname + old.search })).statusCode).toBe(403);
  });
});
