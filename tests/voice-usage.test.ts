import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { parseKey } from '../src/secrets.js';
import { relayCallToken } from '../src/store/relay.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';

// A live call's voice usage in its one cost record (owner's decisions, 2026-10-11): the characters synthesised for it,
// priced at the voice provider its telephony provider's speech relay speaks with, and its own model decisions' tokens,
// priced at each model's rate in force when the call started. Driven through the real relay, against fakes.
const relayFixture = JSON.parse(readFileSync(new URL('./fixtures/twilio-relay.json', import.meta.url), 'utf8'));
type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let twilioId: string; let voiceId: string; let port = 0;
const BASE = 'https://voicelab.test';
const TW_TOKEN = 'tw-usage-token';
const OUR = '+60300000991'; const CUSTOMER = '+60123450991';

async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}
const post = (url: string, body: unknown) => env.call(env.staffToken, 'POST', url, body);
const put = (url: string, body: unknown) => env.call(env.staffToken, 'PUT', url, body);
const twilioSig = (url: string, params: Record<string, string>) =>
  createHmac('sha1', TW_TOKEN).update(url + Object.keys(params).sort().map((k) => k + params[k]).join('')).digest('base64');
const twilioPost = (path: string, params: Record<string, string>) => env.app.inject({
  method: 'POST', url: path, payload: new URLSearchParams(params).toString(),
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSig(BASE + path, params) },
});

// "Hello from Voice Lab." is recorded; "Can you pay this week?" (22 characters) is synthesised.
const flow: WorkflowDefinition = { start: 'hi', variables: [], nodes: {
  hi: { type: 'speak', speech: 'fixed', text: 'Hello from Voice Lab.', transitions: [{ to: 'ask' }] },
  ask: { type: 'speak', speech: 'fixed', text: 'Can you pay this week?', listen: { captureAs: 'a' }, transitions: [{ to: 'done' }] },
  done: { type: 'end', outcome: 'promised' },
} };

const linkVoice = async (id: string | null) => { await must(put(`/internal/providers/${twilioId}/speech-voice`, { voiceProviderId: id })); };

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  tenantId = (await must(post('/internal/tenants', { name: 'Usage Co' }))).json().id;
  twilioId = (await must(post('/internal/providers', { adapterKey: 'twilio', name: 'tw-usage', params: { accountSid: 'AC1', authToken: TW_TOKEN, twimlAppVoiceUrl: `${BASE}/v` } }))).json().id;
  await must(post(`/internal/providers/${twilioId}/charging`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 60, concurrencyLimit: 100,
    components: [{ component: 'telephony_leg', unit: 'per_minute', rate: '0.0085', currency: 'USD', direction: 'inbound' }] }));
  // The voice provider's speech rate, and a line of its that is not speech (it must never be charged to a call's speech).
  voiceId = (await must(post('/internal/providers', { adapterKey: 'elevenlabs', name: 'el-usage', params: { apiKey: 'k' } }))).json().id;
  await must(post(`/internal/providers/${voiceId}/charging`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1,
    components: [{ component: 'tts', unit: 'per_character', rate: '0.00003', currency: 'USD' }, { component: 'platform', unit: 'flat', rate: '5', currency: 'USD' }] }));
  await linkVoice(voiceId);
  await must(post('/internal/fx', { currency: 'MYR', perUsd: '4.5', effectiveFrom: '2026-01-01T00:00:00Z' }));
  await must(post('/internal/rate-card', { effectiveFrom: '2026-01-01T00:00:00Z', inboundCreditsPerMinute: '1', outboundCreditsPerMinute: '2', creditValueUsd: '0.01' }));
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(64, 1)]);
  await must(post(`/internal/tenants/${tenantId}/recordings`, { language: 'en', text: 'Hello from Voice Lab.', contentType: 'audio/wav', audioBase64: wav.toString('base64'), durationMs: 1200 }));
  const numberId = (await must(post('/internal/numbers', { providerId: twilioId, e164: OUR, tenantId, country: 'MY' }))).json().id;
  const c = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'usage_flow', definition: flow }))).json();
  await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'staging' }));
  await must(post(`/internal/workflows/${c.workflow.id}/simulate`, { scenarios: [{ name: 's', variables: {}, replies: ['yes'], expect: { outcome: 'promised' } }] }));
  await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'production' }));
  await must(put(`/internal/numbers/${numberId}/workflow`, { workflowId: c.workflow.id }));
  // Model prices per million tokens: one in USD, one in MYR (13.5 and 67.5 MYR are 3 and 15 USD at 4.5), and a later
  // price for the first that starts after these calls, which must not be used.
  await must(post('/internal/model-rates', { model: 'fast-model', effectiveFrom: '2026-01-01T00:00:00Z', inputPer1m: '1', outputPer1m: '5', currency: 'USD' }));
  await must(post('/internal/model-rates', { model: 'fast-model', effectiveFrom: '2099-01-01T00:00:00Z', inputPer1m: '100', outputPer1m: '500', currency: 'USD' }));
  await must(post('/internal/model-rates', { model: 'big-model', effectiveFrom: '2026-01-01T00:00:00Z', inputPer1m: '13.5', outputPer1m: '67.5', currency: 'MYR' }));
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  port = (env.app.server.address() as { port: number }).port;
});
afterAll(async () => { await env?.teardown(); });

let n = 0;
/** A caller rings, the relay hears the greeting (recorded) and the question (synthesised), and hangs up. */
async function liveCall() {
  const callSid = `CA_usage_${++n}`;
  expect((await twilioPost(`/webhooks/twilio/${twilioId}/voice`, { CallSid: callSid, CallStatus: 'ringing', Direction: 'inbound', From: CUSTOMER, To: OUR })).statusCode).toBe(200);
  const callId = (await env.pool.query('SELECT id FROM calls WHERE provider_call_id = $1', [callSid])).rows[0].id as string;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay/twilio/${twilioId}`, { headers: { 'x-twilio-signature': twilioSig(`wss://voicelab.test/relay/twilio/${twilioId}`, {}) } });
  await new Promise<void>((ok, bad) => { ws.once('open', () => ok()); ws.once('error', bad); });
  const got: unknown[] = [];
  ws.on('message', (d) => got.push(JSON.parse(String(d))));
  ws.send(JSON.stringify({ ...relayFixture.inbound.setup, callSid, customParameters: { callId, token: relayCallToken(parseKey(env.config.VOICELAB_SECRET_KEY), callId) } }));
  for (let i = 0; i < 200 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
  expect(got).toHaveLength(2);
  const closed = new Promise<void>((r) => ws.on('close', () => r()));
  ws.close(); await closed; await new Promise((r) => setTimeout(r, 50));
  return { callSid, callId };
}
const end = (callSid: string) => twilioPost(`/webhooks/twilio/${twilioId}/status`, { CallSid: callSid, CallStatus: 'completed', CallDuration: '90', Direction: 'inbound', From: CUSTOMER, To: OUR });
const decide = (callId: string, task: string, model: string | null, input: number, output: number) => env.pool.query(
  `INSERT INTO ai_decisions (tenant_id, task, subject_type, subject_id, decision, reason, model, input_tokens, output_tokens, call_id)
   VALUES ($1,$2,'run_step','x','proceeded','A line was written.',$3,$4,$5,$6)`, [tenantId, task, model, input, output, callId]);
const lines = async (callId: string) => (await env.pool.query(
  `SELECT l.component, l.model, l.billing_line, l.quantity, l.amount_usd, (l.provider_id IS NOT NULL) AS has_provider, (l.model_rate_id IS NOT NULL) AS has_model_rate
     FROM call_cost_lines l JOIN call_costs k ON k.id = l.call_cost_id WHERE k.call_id = $1 AND k.status = 'estimated' ORDER BY l.id`, [callId])).rows;
const costRow = async (callId: string) => (await env.pool.query('SELECT cost_status, cost_error FROM calls WHERE id = $1', [callId])).rows[0];
const retry = (callId: string) => post(`/internal/calls/${callId}/cost/retry`, {});

describe('a live call\'s voice usage in its cost record', () => {
  it('prices the synthesised characters, never the recorded ones, and each model\'s tokens at its own rate, exactly', async () => {
    const { callSid, callId } = await liveCall();
    // a line said again on a takeover (10 characters), as the relay records it
    await env.pool.query(`INSERT INTO call_events (tenant_id, call_id, type, payload) VALUES ($1,$2,'relay.said_again','{"lines":1,"synthChars":10}')`, [tenantId, callId]);
    // the relay's own voice also said the wait line (19) and the holding message (31): speech too
    await env.pool.query(`INSERT INTO call_events (tenant_id, call_id, type, payload) VALUES ($1,$2,'relay.wait_line','{"synthChars":19}'), ($1,$2,'relay.holding_message','{"synthChars":31}')`, [tenantId, callId]);
    // the call's own model decisions, and a QA score made about it afterwards (a batch: the platform's cost, not the call's)
    await decide(callId, 'speak_dynamic', 'fast-model', 1200, 300);
    await decide(callId, 'speak_dynamic', 'fast-model', 0, 0);
    await decide(callId, 'speak_dynamic', 'big-model', 500, 100);
    await decide(callId, 'speak_dynamic', null, 0, 0);                         // a rule decided: no tokens, nothing to price
    await decide(callId, 'qa_judge', 'big-model', 99_999, 99_999);
    expect((await end(callSid)).statusCode).toBe(204);
    expect(await costRow(callId)).toEqual({ cost_status: 'recorded', cost_error: null });
    // Worked by hand. The call: 90 s inbound billed as 2 minutes at 0.0085 = 0.0170. Speech: 22 + 10 + 19 + 31 = 82
    // characters at 0.00003 = 0.00246 (the recorded greeting is free; the provider's flat line is not speech). fast-model: 1200 input at
    // 1 per million = 0.0012, 300 output at 5 = 0.0015. big-model in MYR: 500 at 13.5 = 0.00675 MYR = 0.0015 USD, 100 at
    // 67.5 = 0.00675 MYR = 0.0015 USD. Total 0.02516 USD.
    expect(await lines(callId)).toEqual([
      { component: 'telephony_leg', model: null, billing_line: 'main', quantity: '120s', amount_usd: '0.01700000', has_provider: true, has_model_rate: false },
      { component: 'tts', model: null, billing_line: 'main', quantity: '82', amount_usd: '0.00246000', has_provider: true, has_model_rate: false },
      { component: 'llm', model: 'big-model', billing_line: 'input', quantity: '500', amount_usd: '0.00150000', has_provider: false, has_model_rate: true },
      { component: 'llm', model: 'big-model', billing_line: 'output', quantity: '100', amount_usd: '0.00150000', has_provider: false, has_model_rate: true },
      { component: 'llm', model: 'fast-model', billing_line: 'input', quantity: '1200', amount_usd: '0.00120000', has_provider: false, has_model_rate: true },
      { component: 'llm', model: 'fast-model', billing_line: 'output', quantity: '300', amount_usd: '0.00150000', has_provider: false, has_model_rate: true },
    ]);
    // credits follow the caller's time only: 2 minutes at 1 a minute
    expect((await env.pool.query(`SELECT total_usd, credits_drawn FROM call_costs WHERE call_id = $1`, [callId])).rows).toEqual([{ total_usd: '0.02516000', credits_drawn: '2.0000' }]);
    expect((await env.pool.query(`SELECT credits FROM credit_entries WHERE ref = $1`, [`call:${callId}`])).rows).toEqual([{ credits: '-2.0000' }]);
    // checked against Twilio's price for the call, which covers only its own line; the reconciled record keeps every line
    expect((await must(post(`/internal/calls/${callId}/reconcile`, { source: 'manual', reportedSeconds: 90, reportedCost: '0.0170' }))).json().outcome).toBe('matched');
    expect((await env.pool.query(`SELECT count(*)::int AS n FROM call_cost_lines l JOIN call_costs k ON k.id = l.call_cost_id WHERE k.call_id = $1 AND k.status = 'reconciled'`, [callId])).rows[0].n).toBe(6);
    expect((await env.pool.query(`SELECT credits FROM credit_entries WHERE ref = $1`, [`call:${callId}`])).rows).toHaveLength(1);
  });

  it('refuses to price speech with no voice provider linked, or one with no speech rate, and prices it once one is', async () => {
    await linkVoice(null);
    try {
      const a = await liveCall();
      await end(a.callSid);
      expect(await costRow(a.callId)).toMatchObject({ cost_status: 'failed', cost_error: expect.stringContaining('no voice provider linked') });
      expect((await env.pool.query('SELECT count(*)::int AS n FROM call_costs WHERE call_id = $1', [a.callId])).rows[0].n).toBe(0);
      // only a voice provider can be linked, only to a telephony provider, only by an admin, and the change is audited
      const refused = await put(`/internal/providers/${twilioId}/speech-voice`, { voiceProviderId: twilioId });
      expect(refused.statusCode).toBe(400); expect(refused.json().error).toContain('not a voice provider');
      expect((await put(`/internal/providers/${voiceId}/speech-voice`, { voiceProviderId: voiceId })).statusCode).toBe(400);
      expect((await put(`/internal/providers/${twilioId}/speech-voice`, { voiceProviderId: 'not-an-id' })).statusCode).toBe(400);
      const viewer = (await must(post('/internal/staff', { email: 'usage-viewer@daythree.test', role: 'internal_viewer' }))).json().token;
      expect((await env.call(viewer, 'PUT', `/internal/providers/${twilioId}/speech-voice`, { voiceProviderId: voiceId })).statusCode).toBe(403);
      expect((await env.pool.query('SELECT speech_provider_id FROM providers WHERE id = $1', [twilioId])).rows[0].speech_provider_id).toBeNull();
      expect((await retry(a.callId)).json()).toEqual({ cost_status: 'failed' });
      // a voice provider with no per-character speech rate cannot price it either
      const bare = (await must(post('/internal/providers', { adapterKey: 'elevenlabs', name: 'el-bare', params: { apiKey: 'k' } }))).json().id;
      await must(post(`/internal/providers/${bare}/charging`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1, components: [{ component: 'platform', unit: 'flat', rate: '1', currency: 'USD' }] }));
      await linkVoice(bare);
      expect((await retry(a.callId)).json()).toEqual({ cost_status: 'failed' });
      expect((await costRow(a.callId)).cost_error).toContain('no per-character speech rate');
      // linked properly: re-priced, with the speech
      await linkVoice(voiceId);
      expect((await retry(a.callId)).json()).toEqual({ cost_status: 'recorded' });
      expect((await lines(a.callId)).map((l) => `${l.component}:${l.quantity}`)).toEqual(['telephony_leg:120s', 'tts:22']);
      expect((await env.pool.query(`SELECT detail FROM audit_log WHERE action = 'provider.speech_voice' AND entity_id = $1 ORDER BY id DESC LIMIT 1`, [twilioId])).rows[0].detail).toEqual({ voiceProviderId: voiceId });
    } finally { await linkVoice(voiceId); }
  });

  it('refuses to price tokens of a model with no rate in force, or of a decision that names no model', async () => {
    const a = await liveCall();
    await decide(a.callId, 'speak_dynamic', 'unpriced-model', 10, 10);
    await end(a.callSid);
    expect(await costRow(a.callId)).toMatchObject({ cost_status: 'failed', cost_error: expect.stringContaining('unpriced-model has no price') });
    // a price that starts after the call started does not price it
    await must(post('/internal/model-rates', { model: 'unpriced-model', effectiveFrom: '2099-01-01T00:00:00Z', inputPer1m: '1', outputPer1m: '1', currency: 'USD' }));
    expect((await retry(a.callId)).json()).toEqual({ cost_status: 'failed' });
    await must(post('/internal/model-rates', { model: 'unpriced-model', effectiveFrom: '2026-01-01T00:00:00Z', inputPer1m: '2', outputPer1m: '4', currency: 'USD' }));
    expect((await retry(a.callId)).json()).toEqual({ cost_status: 'recorded' });

    // Tokens a decision used without naming its model are never guessed at: they wait for a person to give the name
    // "unnamed" a rate, which is the recorded way to settle them.
    const b = await liveCall();
    await decide(b.callId, 'speak_dynamic', null, 5, 0);
    await end(b.callSid);
    expect(await costRow(b.callId)).toMatchObject({ cost_status: 'failed', cost_error: expect.stringContaining('unnamed has no price') });
    await must(post('/internal/model-rates', { model: 'unnamed', effectiveFrom: '2026-01-01T00:00:00Z', inputPer1m: '10', outputPer1m: '10', currency: 'USD' }));
    expect((await retry(b.callId)).json()).toEqual({ cost_status: 'recorded' });
    expect((await lines(b.callId)).filter((l) => l.component === 'llm')).toEqual([
      { component: 'llm', model: 'unnamed', billing_line: 'input', quantity: '5', amount_usd: '0.00005000', has_provider: false, has_model_rate: true }]);
  });

  it('keeps model rates dated and append-only, read strictly, and out of the client role\'s reach', async () => {
    const bad = [
      { model: 'x', effectiveFrom: '2026-02-01T00:00:00Z', inputPer1m: '1,000', outputPer1m: '1', currency: 'USD' },
      { model: 'x', effectiveFrom: '2026-02-01T00:00:00Z', inputPer1m: '-1', outputPer1m: '1', currency: 'USD' },
      { model: 'x', effectiveFrom: '2026-02-01T00:00:00Z', inputPer1m: '1', outputPer1m: '1', currency: 'usd' },
      { model: 'has space', effectiveFrom: '2026-02-01T00:00:00Z', inputPer1m: '1', outputPer1m: '1', currency: 'USD' },
      { model: 'x', effectiveFrom: 'soon', inputPer1m: '1', outputPer1m: '1', currency: 'USD' },
      { model: 'x', effectiveFrom: '2026-02-01T00:00:00Z', inputPer1m: '1', outputPer1m: '1', currency: 'USD', extra: 1 },
    ];
    for (const b of bad) expect((await post('/internal/model-rates', b)).statusCode).toBe(400);
    // gateway and dated names are fine, and a model chosen for a task must be one a rate can be given for
    for (const m of ['vendor/some-model', 'some-model@20261001', 'model-x[1m]']) {
      expect((await post('/internal/model-rates', { model: m, effectiveFrom: '2026-01-01T00:00:00Z', inputPer1m: '1', outputPer1m: '1', currency: 'USD' })).statusCode).toBe(201);
    }
    const { setModel } = await import('../src/store/ai-decisions.js');
    const { withActor } = await import('../src/db.js');
    await expect(withActor(env.pool, { kind: 'internal' }, (c) => setModel(c, null, { taskKey: 'speak_dynamic', tier: 'haiku', modelId: 'has space', escalateTo: null }))).rejects.toThrow(/named as its provider names it/);
    expect((await post('/internal/model-rates', { model: 'fast-model', effectiveFrom: '2026-01-01T00:00:00Z', inputPer1m: '9', outputPer1m: '9', currency: 'USD' })).statusCode).toBe(409);
    const list = (await must(env.call(env.staffToken, 'GET', '/internal/model-rates'))).json() as { model: string; effective_from: string; input_per_1m: string }[];
    expect(list.filter((r) => r.model === 'fast-model').map((r) => r.input_per_1m)).toEqual(['100.00000000', '1.00000000']);   // newest first
    await expect(env.pool.query(`UPDATE model_rates SET input_per_1m = 0 WHERE model = 'fast-model'`)).rejects.toThrow();
    await expect(env.pool.query(`DELETE FROM model_rates WHERE model = 'fast-model'`)).rejects.toThrow();
    expect((await env.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'model_rate.add'`)).rows[0].n).toBeGreaterThan(0);
    const client = await env.pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SET LOCAL ROLE voicelab_client');
      await expect(client.query('SELECT * FROM model_rates')).rejects.toThrow(/permission denied/);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('waits while the relay still serves the call, so speech and model decisions landing late are priced, and a person can say the relay is gone', async () => {
    // The call ends while its relay connection is still open (Twilio's end can arrive before the socket closes).
    const callSid = `CA_usage_${++n}`;
    await twilioPost(`/webhooks/twilio/${twilioId}/voice`, { CallSid: callSid, CallStatus: 'ringing', Direction: 'inbound', From: CUSTOMER, To: OUR });
    const callId = (await env.pool.query('SELECT id FROM calls WHERE provider_call_id = $1', [callSid])).rows[0].id as string;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay/twilio/${twilioId}`, { headers: { 'x-twilio-signature': twilioSig(`wss://voicelab.test/relay/twilio/${twilioId}`, {}) } });
    await new Promise<void>((ok, bad) => { ws.once('open', () => ok()); ws.once('error', bad); });
    const got: unknown[] = []; ws.on('message', (d) => got.push(d));
    ws.send(JSON.stringify({ ...relayFixture.inbound.setup, callSid, customParameters: { callId, token: relayCallToken(parseKey(env.config.VOICELAB_SECRET_KEY), callId) } }));
    for (let i = 0; i < 200 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect((await end(callSid)).statusCode).toBe(204);
    expect(await costRow(callId)).toMatchObject({ cost_status: 'pending' });
    expect((await env.pool.query(`SELECT count(*)::int AS n FROM call_events WHERE call_id = $1 AND type = 'call.cost_waiting'`, [callId])).rows[0].n).toBe(1);
    expect((await retry(callId)).json()).toEqual({ cost_status: 'pending' });       // still waiting
    // a model decision lands after the end (a reply still being applied), then the relay lets go: priced with it
    await decide(callId, 'speak_dynamic', 'fast-model', 1000, 0);
    const closed = new Promise<void>((r) => ws.on('close', () => r()));
    ws.close(); await closed;
    for (let i = 0; i < 100 && (await costRow(callId)).cost_status === 'pending'; i++) await new Promise((r) => setTimeout(r, 20));
    expect(await costRow(callId)).toMatchObject({ cost_status: 'recorded' });
    expect((await lines(callId)).filter((l) => l.component === 'llm').map((l) => l.quantity)).toEqual(['1000']);

    // A reply still being applied when the call ended: the cost waits for it, and is priced when it is given up.
    const r = await liveCall();
    await env.pool.query(`UPDATE workflow_runs SET status = 'processing', updated_at = now() - interval '1 hour' WHERE call_id = $1`, [r.callId]);
    await end(r.callSid);
    expect(await costRow(r.callId)).toMatchObject({ cost_status: 'pending' });
    const { abandonStaleRuns } = await import('../src/store/runs.js');
    await abandonStaleRuns({ pool: env.pool, key: parseKey(env.config.VOICELAB_SECRET_KEY) }, null, { olderThanMinutes: 30 });
    expect(await costRow(r.callId)).toMatchObject({ cost_status: 'recorded' });

    // A relay whose server died holding the call never lets go: a person says so, and it is priced from what was recorded.
    const d = await liveCall();
    await env.pool.query(`UPDATE calls SET relay_owner = '00000000-0000-4000-8000-00000000dead' WHERE id = $1`, [d.callId]);
    await end(d.callSid);
    expect(await costRow(d.callId)).toMatchObject({ cost_status: 'pending' });
    expect((await post(`/internal/calls/${d.callId}/cost/retry`, { relayGone: false })).statusCode).toBe(400);
    expect((await post(`/internal/calls/${d.callId}/cost/retry`, { relayGone: true })).json()).toEqual({ cost_status: 'recorded' });
    expect((await env.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'call_cost.relay_gone' AND entity_id = $1`, [d.callId])).rows[0].n).toBe(1);
  });

  it('prices speech at the voice the call was handed to, refuses two speech rates at once, and reads a rate per thousand characters', async () => {
    // a second voice with a different rate, per thousand characters
    const other = (await must(post('/internal/providers', { adapterKey: 'elevenlabs', name: 'el-other', params: { apiKey: 'k' } }))).json().id;
    await must(post(`/internal/providers/${other}/charging`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1, components: [{ component: 'tts', unit: 'per_1k_characters', rate: '0.5', currency: 'USD' }] }));
    const a = await liveCall();                                          // handed to the relay while el-usage was linked
    await linkVoice(other);
    try {
      await end(a.callSid);
      expect((await lines(a.callId)).find((l) => l.component === 'tts')).toMatchObject({ quantity: '22', amount_usd: '0.00066000' });   // 22 at 0.00003
      const b = await liveCall();                                        // handed over with el-other linked: 22 per 1000 at 0.5
      await end(b.callSid);
      expect((await lines(b.callId)).find((l) => l.component === 'tts')).toMatchObject({ quantity: '22', amount_usd: '0.01100000' });
      // two speech rates at once would charge the characters twice: refused
      const two = (await must(post('/internal/providers', { adapterKey: 'elevenlabs', name: 'el-two', params: { apiKey: 'k' } }))).json().id;
      await must(post(`/internal/providers/${two}/charging`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1, components: [
        { component: 'tts', unit: 'per_character', rate: '0.00003', currency: 'USD', billingLine: 'standard' },
        { component: 'tts', unit: 'per_character', rate: '0.00009', currency: 'USD', billingLine: 'turbo' }] }));
      await linkVoice(two);
      const c = await liveCall();
      await end(c.callSid);
      expect(await costRow(c.callId)).toMatchObject({ cost_status: 'failed', cost_error: expect.stringContaining('more than one per-character speech rate') });
    } finally { await linkVoice(voiceId); }
  });

  it('refuses to take a live call\'s cost from figures entered by hand, which would leave its voice usage out', async () => {
    const a = await liveCall();
    const r = await post(`/internal/calls/${a.callId}/cost`, { tenantId, direction: 'inbound', occurredAt: '2026-10-11T00:00:00Z', usage: [{ providerId: twilioId, usage: { seconds: 90 } }] });
    expect(r.statusCode).toBe(409);
    expect((await env.pool.query('SELECT count(*)::int AS n FROM call_costs WHERE call_id = $1', [a.callId])).rows[0].n).toBe(0);
  });
});
