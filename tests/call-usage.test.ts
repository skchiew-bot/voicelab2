import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '../src/workflows/definition.js';

// A call's cost record holds everything the call used: the phone line, the speech relay (its minutes and the characters
// it synthesised) and the AI models its decisions used. Each is priced by its own provider's dated rates; only the phone
// line draws the client's credits.

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let twilioId: string; let voiceId: string; let wfId: string;

async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}
const post = (url: string, body: unknown) => env.call(env.staffToken, 'POST', url, body);


const flow: WorkflowDefinition = { start: 'hi', variables: [], nodes: {
  hi: { type: 'speak', speech: 'fixed', text: 'Hello from Voice Lab.', transitions: [{ to: 'ask' }] },         // 21 characters
  ask: { type: 'speak', speech: 'fixed', text: 'Can you pay this week?', listen: { captureAs: 'a', intents: { yes: ['yes'] } }, transitions: [{ to: 'done' }] },   // 22
  done: { type: 'end', outcome: 'promised' },
} };

/** A model provider for one model id, with its token rates from the start of the year. */
async function modelProvider(model: string, input: string, output: string, name = model) {
  const id = (await must(post('/internal/providers', { adapterKey: 'anthropic', name, params: { model } }))).json().id as string;
  await must(post(`/internal/providers/${id}/charging`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1, components: [
    { component: 'llm', unit: 'per_1m_tokens', rate: input, currency: 'USD', billingLine: 'input' },
    { component: 'llm', unit: 'per_1m_tokens', rate: output, currency: 'USD', billingLine: 'output' },
  ] }));
  return id;
}

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  tenantId = (await must(post('/internal/tenants', { name: 'Usage Co' }))).json().id;
  voiceId = (await must(post('/internal/providers', { adapterKey: 'elevenlabs', name: 'relay speech', params: { apiKey: 'FAKE_TOKEN_voice' } }))).json().id;
  await must(post(`/internal/providers/${voiceId}/charging`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 60, components: [
    { component: 'platform', unit: 'per_minute', rate: '0.07', currency: 'USD' },
    { component: 'tts', unit: 'per_1k_characters', rate: '0.30', currency: 'USD' },
  ] }));
  twilioId = (await must(post('/internal/providers', { adapterKey: 'twilio', name: 'tw-usage', params: { accountSid: 'AC1', authToken: 'FAKE_TOKEN_tw', twimlAppVoiceUrl: 'https://voicelab.test/v', relayPricingProviderId: voiceId } }))).json().id;
  await must(post(`/internal/providers/${twilioId}/charging/reference`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 60 }));
  await must(post('/internal/fx', { currency: 'MYR', perUsd: '4.5', effectiveFrom: '2026-01-01T00:00:00Z' }));
  await must(post('/internal/rate-card', { effectiveFrom: '2026-01-01T00:00:00Z', inboundCreditsPerMinute: '1', outboundCreditsPerMinute: '2', creditValueUsd: '0.01' }));
  const w = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'usage_flow', definition: flow }))).json();
  wfId = w.workflow.id;
  await must(post(`/internal/workflows/${wfId}/deploy`, { versionId: w.version.id, environment: 'staging' }));
  await must(post(`/internal/workflows/${wfId}/simulate`, { scenarios: [{ name: 's', variables: {}, replies: ['yes'], expect: { outcome: 'promised' } }] }));
  await must(post(`/internal/workflows/${wfId}/deploy`, { versionId: w.version.id, environment: 'production' }));
});
afterAll(async () => { await env?.teardown(); });

/** A finished inbound call of `seconds`, as the call-control flow leaves it, not yet costed. */
async function finishedCall(seconds: number, provider = twilioId) {
  const id = randomUUID();
  const started = new Date(Date.now() - (seconds + 60) * 1000);
  const ended = new Date(started.getTime() + seconds * 1000);
  await env.pool.query(
    `INSERT INTO calls (id, tenant_id, provider_id, provider_call_id, direction, status, started_at, answered_at, ended_at, duration_seconds)
     VALUES ($1,$2,$3,$4,'inbound','completed',$5,$5,$6,$7)`, [id, tenantId, provider, `CA_${id.slice(0, 8)}`, started, ended, seconds]);
  return { id, started, ended };
}
const event = (callId: string, type: string, at: Date, payload: object = {}) => env.pool.query(
  `INSERT INTO call_events (tenant_id, call_id, type, payload, occurred_at) VALUES ($1,$2,$3,$4,$5)`, [tenantId, callId, type, payload, at]);
const decision = (callId: string, model: string | null, input: number, output: number) => env.pool.query(
  `INSERT INTO ai_decisions (tenant_id, task, subject_type, subject_id, decision, reason, model, tier, input_tokens, output_tokens, call_id)
   VALUES ($1,'turn_reading','call',$2::text,'proceeded','read the turn',$3,$4,$5,$6,$2::uuid)`, [tenantId, callId, model, model ? 'haiku' : 'rules', input, output]);
const cost = (callId: string) => env.call(env.staffToken, 'POST', `/internal/calls/${callId}/cost/retry`, {});
const status = async (callId: string) => (await env.pool.query('SELECT cost_status, cost_error FROM calls WHERE id = $1', [callId])).rows[0];
const lines = async (callId: string) => (await env.pool.query(
  `SELECT l.provider_id, l.component || ':' || l.billing_line AS component, l.quantity::text AS quantity, l.amount::text AS amount FROM call_cost_lines l JOIN call_costs k ON k.id = l.call_cost_id
    WHERE k.call_id = $1 AND k.status = 'estimated' ORDER BY l.id`, [callId])).rows;
const credits = async (callId: string) => (await env.pool.query(`SELECT credits::text FROM credit_entries WHERE ref = $1`, [`call:${callId}`])).rows;

describe('a call\'s cost record holds everything the call used', () => {
  it('prices the tokens each model used at that model\'s own rates, as our cost only, and leaves rule-only decisions out', async () => {
    const haiku = await modelProvider('test-model-small', '1.00', '5.00');
    const sonnet = await modelProvider('test-model-medium', '3.00', '15.00');
    const call = await finishedCall(120);
    await decision(call.id, 'test-model-small', 1000, 200);
    await decision(call.id, 'test-model-small', 500, 100);
    await decision(call.id, 'test-model-medium', 2000, 400);
    await decision(call.id, null, 0, 0);                                         // a decision the rules made: nothing to price
    expect((await cost(call.id)).json()).toEqual({ cost_status: 'recorded' });
    const ls = await lines(call.id);
    // worked out by hand: 1500 input tokens at 1.00 per million, 300 output at 5.00; 2000 at 3.00, 400 at 15.00
    expect(ls.filter((l) => l.provider_id === haiku).map((l) => [l.component, l.amount]).sort()).toEqual([['llm:input', '0.00150000'], ['llm:output', '0.00150000']]);
    expect(ls.filter((l) => l.provider_id === sonnet).map((l) => [l.component, l.amount]).sort()).toEqual([['llm:input', '0.00600000'], ['llm:output', '0.00600000']]);
    // credits follow the phone line only: 2 inbound minutes at 1 credit
    expect(await credits(call.id)).toEqual([{ credits: '-2.0000' }]);
  });

  it('refuses to cost a call that used a model nothing prices, saying which, and costs it once a provider exists', async () => {
    const call = await finishedCall(60);
    await decision(call.id, 'test-model-unpriced', 100, 10);
    expect((await cost(call.id)).json()).toEqual({ cost_status: 'failed' });
    expect((await status(call.id)).cost_error).toContain('"test-model-unpriced"');
    expect(await lines(call.id)).toEqual([]);
    expect(await credits(call.id)).toEqual([]);                                  // nothing drawn for a call not costed
    await modelProvider('test-model-unpriced', '1.00', '1.00');
    expect((await cost(call.id)).json()).toEqual({ cost_status: 'recorded' });

    // two providers pricing the same model: which rate applies is unclear, so it is refused
    await modelProvider('test-model-twice', '1.00', '1.00', 'twice-a'); await modelProvider('test-model-twice', '2.00', '2.00', 'twice-b');
    const twice = await finishedCall(60);
    await decision(twice.id, 'test-model-twice', 100, 10);
    expect((await cost(twice.id)).json()).toEqual({ cost_status: 'failed' });
    expect((await status(twice.id)).cost_error).toContain('More than one active model provider');
    // tokens with no model named cannot be priced either
    const nameless = await finishedCall(60);
    await decision(nameless.id, null, 50, 5);
    expect((await cost(nameless.id)).json()).toEqual({ cost_status: 'failed' });
  });

  it('prices the speech relay by its minutes on the call and the characters it synthesised, including lines said again', async () => {
    const call = await finishedCall(180);
    // the relay connected 10 seconds in and closed after 90 seconds on the line
    await event(call.id, 'relay.connected', new Date(call.started.getTime() + 10_000));
    await event(call.id, 'relay.closed', new Date(call.started.getTime() + 100_000));
    // the workflow runs live on the call: it says its greeting and asks its question (21 + 22 characters)
    await must(post(`/internal/workflows/${wfId}/runs`, { environment: 'production', kind: 'live', variables: {}, callId: call.id }));
    // a reconnected line said the question again
    await event(call.id, 'relay.said_again', new Date(call.started.getTime() + 60_000), { lines: 1, synthChars: 22 });
    expect((await cost(call.id)).json()).toEqual({ cost_status: 'recorded' });
    const relay = (await lines(call.id)).filter((l) => l.provider_id === voiceId);
    // 90 seconds billed by the minute is 2 minutes at 0.07; 65 characters at 0.30 per thousand
    expect(relay.map((l) => [l.component, l.quantity, l.amount])).toEqual([['platform:main', '120s', '0.14000000'], ['tts:main', '65', '0.01950000']]);
    expect(await credits(call.id)).toEqual([{ credits: '-3.0000' }]);           // 3 inbound minutes: the relay draws none
  });

  it('counts the relay only up to the end of the call, and refuses a relay call whose Twilio provider names nothing to price it', async () => {
    const call = await finishedCall(30);
    await event(call.id, 'relay.connected', new Date(call.started.getTime() + 5_000));
    await event(call.id, 'relay.closed', new Date(call.ended.getTime() + 120_000));   // the socket closed well after the call ended
    expect((await cost(call.id)).json()).toEqual({ cost_status: 'recorded' });
    expect((await lines(call.id)).filter((l) => l.provider_id === voiceId).map((l) => [l.component, l.quantity])).toEqual([['platform:main', '60s'], ['tts:main', '0']]);   // 25 s, one billed minute; nothing said

    const bare = (await must(post('/internal/providers', { adapterKey: 'twilio', name: 'tw-unpriced', params: { accountSid: 'AC2', authToken: 'FAKE_TOKEN_tw2', twimlAppVoiceUrl: 'https://voicelab.test/v' } }))).json().id;
    await must(post(`/internal/providers/${bare}/charging/reference`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 60 }));
    const unpriced = await finishedCall(60, bare);
    await event(unpriced.id, 'relay.connected', unpriced.started);
    expect((await cost(unpriced.id)).json()).toEqual({ cost_status: 'failed' });
    expect((await status(unpriced.id)).cost_error).toContain('Live call speech pricing');
    // a call that never used the relay is costed as before, by its phone line alone
    const plain = await finishedCall(60, bare);
    expect((await cost(plain.id)).json()).toEqual({ cost_status: 'recorded' });
    expect((await lines(plain.id)).every((l) => l.provider_id === bare)).toBe(true);
  });

  it('keeps model providers and their rates internal, and refuses a model provider without its model id', async () => {
    expect((await post('/internal/providers', { adapterKey: 'anthropic', name: 'no-model', params: {} })).statusCode).toBe(400);
    await expect(env.pool.query(`SET ROLE voicelab_client; SELECT * FROM charging_versions`)).rejects.toThrow(/permission denied/);
    await env.pool.query('RESET ROLE');
  });
});
