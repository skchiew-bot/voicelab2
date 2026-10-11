import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A costed call draws its providers' funding down by exactly what it cost them, once, and a balance it empties fails the
// provider over at once. A balance nobody keeps is never drawn down into looking empty.
type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string;
const st = () => env.staffToken;
const post = (u: string, b?: unknown) => env.call(st(), 'POST', u, b);
const get = (u: string) => env.call(st(), 'GET', u);
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}

let n = 0;
/** A telephony provider at 0.014 USD a minute in 6-second steps, and a voice provider charging tokens and characters. */
async function providers() {
  const tel = (await must(post('/internal/providers', { adapterKey: 'twilio', name: `tw-fund-${++n}`, params: { accountSid: 'AC1', authToken: 't', twimlAppVoiceUrl: 'https://x.example/v' } }))).json().id as string;
  const voice = (await must(post('/internal/providers', { adapterKey: 'openai', name: `oa-fund-${n}`, params: { apiKey: 'k' } }))).json().id as string;
  await must(post(`/internal/providers/${tel}/charging`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 6,
    components: [{ component: 'telephony_leg', unit: 'per_minute', rate: '0.0140', currency: 'USD' }] }));
  await must(post(`/internal/providers/${voice}/charging`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1, components: [
    { component: 'llm', unit: 'per_1m_tokens', rate: '2.50', currency: 'USD', billingLine: 'input' },
    { component: 'tts', unit: 'per_1k_characters', rate: '0.30', currency: 'EUR' },
  ] }));
  return { tel, voice };
}
const topUp = (providerId: string, amount: string, currency = 'USD') => must(post(`/internal/providers/${providerId}/funding`, { kind: 'topup', amount, currency }));
const balances = async (providerId: string) => Object.fromEntries((await must(get(`/internal/providers/${providerId}/funding`))).json().map((b: { currency: string; balance: string }) => [b.currency.trim(), b.balance]));
const cost = (callId: string, usage: object[]) => post(`/internal/calls/${callId}/cost`, { tenantId, direction: 'outbound', occurredAt: '2026-03-01T10:00:00Z', usage });
const drawn = async (callId: string) => (await env.pool.query(
  `SELECT provider_id, kind, amount::text, trim(currency) AS currency, ref FROM provider_funding_entries WHERE call_id = $1 ORDER BY provider_id, currency`, [callId])).rows;
const health = async (providerId: string) => (await env.pool.query('SELECT state FROM provider_health WHERE provider_id = $1', [providerId])).rows[0]?.state ?? 'healthy';

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  tenantId = (await must(post('/internal/tenants', { name: 'Funding Co' }))).json().id;
  await must(post('/internal/fx', { currency: 'MYR', perUsd: '4.5', effectiveFrom: '2026-01-01T00:00:00Z' }));
  await must(post('/internal/fx', { currency: 'EUR', perUsd: '0.8', effectiveFrom: '2026-01-01T00:00:00Z' }));
});
afterAll(async () => { await env?.teardown(); });

describe('provider funding drawn down as calls are costed', () => {
  it('draws each provider down by exactly what the call cost it, in the currency it charged in, to the eighth place', async () => {
    const { tel, voice } = await providers();
    await topUp(tel, '10'); await topUp(voice, '5'); await topUp(voice, '2', 'EUR');
    const call = randomUUID();
    await must(cost(call, [{ providerId: tel, usage: { seconds: 61 } }, { providerId: voice, usage: { inputTokens: 1_003, characters: 333 } }]));
    // 61 s billed as 66 s: 1.1 min x 0.014 = 0.0154 USD. 1003 tokens x 2.50/1M = 0.0025075 USD. 333 chars x 0.30/1k = 0.0999 EUR.
    expect(await drawn(call)).toEqual(expect.arrayContaining([
      { provider_id: tel, kind: 'usage', amount: '-0.01540000', currency: 'USD', ref: `call:${call}` },
      { provider_id: voice, kind: 'usage', amount: '-0.00250750', currency: 'USD', ref: `call:${call}` },
      { provider_id: voice, kind: 'usage', amount: '-0.09990000', currency: 'EUR', ref: `call:${call}` },
    ]));
    expect(await drawn(call)).toHaveLength(3);
    expect(await balances(tel)).toEqual({ USD: '9.98460000' });
    expect(await balances(voice)).toEqual({ EUR: '1.90010000', USD: '4.99749250' });
  });

  it('draws nothing from a provider, or a currency, whose balance nobody keeps, so it never looks empty and fails over', async () => {
    const { tel, voice } = await providers();
    await topUp(voice, '5');                                                    // the voice provider's USD only; nothing for the telephony one
    const call = randomUUID();
    await must(cost(call, [{ providerId: tel, usage: { seconds: 60 } }, { providerId: voice, usage: { inputTokens: 4_000, characters: 1_000 } }]));
    expect(await drawn(call)).toEqual([{ provider_id: voice, kind: 'usage', amount: '-0.01000000', currency: 'USD', ref: `call:${call}` }]);
    expect(await balances(tel)).toEqual({});
    expect(await balances(voice)).toEqual({ USD: '4.99000000' });               // the EUR spend is not set against a USD balance
    expect([await health(tel), await health(voice)]).toEqual(['healthy', 'healthy']);
  });

  it('draws a call down once: not again when it is sent again, sent three times at once, or reconciled, and nothing for a free call', async () => {
    const { tel } = await providers();
    await topUp(tel, '1');
    const call = randomUUID();
    await env.pool.query(
      `INSERT INTO calls (id, tenant_id, provider_id, provider_call_id, direction, status, started_at, ended_at, duration_seconds, cost_status)
       VALUES ($1,$2,$3,$4,'outbound','completed', now() - interval '5 minutes', now() - interval '3 minutes', 60, 'recorded')`, [call, tenantId, tel, `CA_fund_${call.slice(0, 8)}`]);
    const rs = await Promise.all([1, 2, 3].map(() => cost(call, [{ providerId: tel, usage: { seconds: 60 } }])));
    expect(rs.map((r) => r.statusCode)).toEqual([201, 201, 201]);
    await must(cost(call, [{ providerId: tel, usage: { seconds: 60 } }]));
    await must(post(`/internal/calls/${call}/reconcile`, { source: 'manual', reportedCost: '0.014' }));
    expect((await env.pool.query(`SELECT count(*)::int AS n FROM call_costs WHERE call_id = $1`, [call])).rows[0].n).toBe(2);   // estimated and reconciled
    expect(await drawn(call)).toEqual([{ provider_id: tel, kind: 'usage', amount: '-0.01400000', currency: 'USD', ref: `call:${call}` }]);
    expect(await balances(tel)).toEqual({ USD: '0.98600000' });
    // Even asked twice directly, a call's draw-down is written once.
    const c = await env.pool.connect();
    try {
      const { drawFundingForCall } = await import('../src/store/ledgers.js');
      await c.query('BEGIN');
      await drawFundingForCall(c, call, [{ providerId: tel, currency: 'USD', amount: 1_400_000n }]);
      await c.query('COMMIT');
    } finally { c.release(); }
    expect(await drawn(call)).toHaveLength(1);
    const free = randomUUID();
    await must(cost(free, [{ providerId: tel, usage: { seconds: 0 } }]));
    expect(await drawn(free)).toEqual([]);
  });

  it('fails the provider over at once when a call empties its balance, and a top-up brings it back on probation', async () => {
    const { tel } = await providers();
    await topUp(tel, '0.02');
    const first = randomUUID();
    await must(cost(first, [{ providerId: tel, usage: { seconds: 60 } }]));     // 0.014 drawn: 0.006 left
    expect(await health(tel)).toBe('healthy');
    const second = randomUUID();
    await must(cost(second, [{ providerId: tel, usage: { seconds: 60 } }]));    // another 0.014: -0.008
    expect(await balances(tel)).toEqual({ USD: '-0.00800000' });
    expect(await health(tel)).toBe('unfunded');
    const log = (await env.pool.query(`SELECT trigger, detail FROM failover_events WHERE from_provider = $1 ORDER BY id`, [tel])).rows;
    expect(log).toEqual([{ trigger: 'funding', detail: { from: 'healthy', to: 'unfunded', reason: 'The funding balance has run out.' } }]);
    await topUp(tel, '5');
    expect(await health(tel)).not.toBe('unfunded');
  });

  it('still takes funding a person records by hand, with any reference, and never mistakes it for a call\'s draw-down', async () => {
    const { tel } = await providers();
    await topUp(tel, '3');
    for (let i = 0; i < 2; i++) await must(post(`/internal/providers/${tel}/funding`, { kind: 'usage', amount: '-1', currency: 'USD', ref: 'invoice 42' }));
    expect(await balances(tel)).toEqual({ USD: '1.00000000' });
    expect((await env.pool.query('SELECT count(*)::int AS n FROM provider_funding_entries WHERE provider_id = $1 AND call_id IS NOT NULL', [tel])).rows[0].n).toBe(0);
  });

  it('keeps the draw-downs append-only and away from clients', async () => {
    await expect(env.pool.query(`UPDATE provider_funding_entries SET amount = 0 WHERE call_id IS NOT NULL`)).rejects.toThrow(/append-only/);
    await expect(env.pool.query(`DELETE FROM provider_funding_entries WHERE call_id IS NOT NULL`)).rejects.toThrow(/append-only/);
    const client = await env.pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SET LOCAL ROLE voicelab_client');
      await expect(client.query('SELECT call_id FROM provider_funding_entries')).rejects.toThrow(/permission denied/);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
