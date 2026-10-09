import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env;
let tenantId: string; let projectId: string;
let telephony: string; let voice: string;

// Setup calls must succeed, or every later assertion is meaningless.
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  const st = env.staffToken;
  tenantId = (await must(env.call(st, 'POST', '/internal/tenants', { name: 'Cost Co' }))).json().id;
  projectId = (await must(env.call(st, 'POST', `/internal/tenants/${tenantId}/projects`, { name: 'Collections MY' }))).json().id;
  telephony = (await must(env.call(st, 'POST', '/internal/providers', {
    adapterKey: 'twilio', name: 'tw', params: { accountSid: 'AC1', authToken: 't', twimlAppVoiceUrl: 'https://x.example/v' },
  }))).json().id;
  voice = (await must(env.call(st, 'POST', '/internal/providers', { adapterKey: 'openai', name: 'oa', params: { apiKey: 'k' } }))).json().id;

  await must(env.call(st, 'POST', `/internal/providers/${telephony}/charging`, {
    effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 6, burstPremiumMultiplier: 2,
    components: [{ component: 'telephony_leg', unit: 'per_minute', rate: '0.0140', currency: 'USD' }],
  }));
  await must(env.call(st, 'POST', `/internal/providers/${voice}/charging`, {
    effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1,
    components: [
      { component: 'llm', unit: 'per_1m_tokens', rate: '2.50', currency: 'USD', billingLine: 'input' },
      { component: 'llm', unit: 'per_1m_tokens', rate: '10.00', currency: 'USD', billingLine: 'output' },
      { component: 'tts', unit: 'per_1k_characters', rate: '0.30', currency: 'USD' },
    ],
  }));
  await must(env.call(st, 'POST', '/internal/fx', { currency: 'MYR', perUsd: '4.5', effectiveFrom: '2026-01-01T00:00:00Z' }));
});
afterAll(async () => { await env?.teardown(); });

const cost = (body: object, callId = randomUUID()) =>
  env.call(env.staffToken, 'POST', `/internal/calls/${callId}/cost`, {
    tenantId, projectId, direction: 'outbound', occurredAt: '2026-03-01T10:00:00Z', ...body,
  });
const T = (seconds: number, extra: object = {}) => ({ providerId: telephony, usage: { seconds, ...extra } });

describe('per-call cost record', () => {
  it('bills the telephony leg on seconds after the increment, in USD and MYR, with credits at zero', async () => {
    const res = await cost({ usage: [T(61)] });
    expect(res.statusCode).toBe(201);
    const r = res.json();
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]).toMatchObject({ component: 'telephony_leg', billed_seconds: 66, rate: '0.01400000', currency: 'USD' });
    expect(r.total_usd).toBe('0.01540000'); // 66s = 1.1 min * 0.014
    expect(r.myr_per_usd).toBe('4.50000000');
    expect(r.total_myr).toBe('0.06930000');
    expect(r.credits_drawn).toBe('0.0000');
    expect(r.margin_usd).toBe('-0.01540000');
    expect(r.status).toBe('estimated');
    expect(r.project_id).toBe(projectId);
  });

  it('adds STT/LLM/TTS-style lines for a voice provider, and counts only synthesised characters', async () => {
    const r = (await cost({ usage: [T(60), { providerId: voice, usage: { inputTokens: 40_000, outputTokens: 5_000, characters: 2_500 } }] })).json();
    const by = (c: string, line?: string) => r.lines.find((l: { component: string; billing_line: string }) => l.component === c && (!line || l.billing_line === line));
    expect(by('llm', 'input').amount).toBe('0.10000000');  // 40k tokens at 2.50 per 1M
    expect(by('llm', 'output').amount).toBe('0.05000000'); // 5k tokens at 10 per 1M
    expect(by('tts').amount).toBe('0.75000000');            // 2.5k chars at 0.30 per 1k
    expect(r.total_usd).toBe('0.91400000');                 // 0.014 + 0.10 + 0.05 + 0.75

    const prerecorded = (await cost({ usage: [{ providerId: voice, usage: { characters: 0 } }] })).json();
    expect(prerecorded.lines[0].amount).toBe('0.00000000'); // pre-recorded segments cost nothing to synthesise
  });

  it('keeps old calls at the rate they were billed at after a rate change', async () => {
    const st = env.staffToken;
    const p = (await env.call(st, 'POST', '/internal/providers', {
      adapterKey: 'telnyx', name: 'tx-rates', params: { apiKey: 'k', webhookUrl: 'https://x.example/h' },
    })).json().id;
    const add = (from: string, rate: string) => env.call(st, 'POST', `/internal/providers/${p}/charging`, {
      effectiveFrom: from, billingIncrementSeconds: 1, components: [{ component: 'telephony_leg', unit: 'per_minute', rate, currency: 'USD' }],
    });
    await add('2026-01-01T00:00:00Z', '0.0070');
    await add('2026-06-01T00:00:00Z', '0.0050');

    const before = (await cost({ occurredAt: '2026-03-01T00:00:00Z', usage: [{ providerId: p, usage: { seconds: 60 } }] })).json();
    const after = (await cost({ occurredAt: '2026-07-01T00:00:00Z', usage: [{ providerId: p, usage: { seconds: 60 } }] })).json();
    expect(before.total_usd).toBe('0.00700000');
    expect(after.total_usd).toBe('0.00500000');

    const reread = (await env.call(st, 'GET', `/internal/calls/${before.call_id}/cost`)).json();
    expect(reread.total_usd).toBe('0.00700000');
    expect(reread.lines[0].charging_version_id).toBe(before.lines[0].charging_version_id);
    expect(after.lines[0].charging_version_id).not.toBe(before.lines[0].charging_version_id);
  });

  it('applies the burst premium only when burst was triggered', async () => {
    const calm = (await cost({ usage: [T(60)] })).json();
    const burst = (await cost({ usage: [T(60, { burst: true })] })).json();
    expect(calm.total_usd).toBe('0.01400000');
    expect(burst.total_usd).toBe('0.02800000');
    expect(burst.lines[0].burst_multiplier).toBe('2.000');
  });

  it('converts a line in another currency to USD and MYR with the rate in force', async () => {
    const st = env.staffToken;
    await env.call(st, 'POST', '/internal/fx', { currency: 'EUR', perUsd: '0.8', effectiveFrom: '2026-01-01T00:00:00Z' });
    const p = (await env.call(st, 'POST', '/internal/providers', { adapterKey: 'elevenlabs', name: 'el-eur', params: { apiKey: 'k' } })).json().id;
    await env.call(st, 'POST', `/internal/providers/${p}/charging`, {
      effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1,
      components: [{ component: 'platform', unit: 'per_minute', rate: '0.08', currency: 'EUR' }],
    });
    const r = (await cost({ usage: [{ providerId: p, usage: { seconds: 60 } }] })).json();
    expect(r.lines[0]).toMatchObject({ amount: '0.08000000', currency: 'EUR', per_usd: '0.80000000', amount_usd: '0.10000000' });
    expect(r.total_myr).toBe('0.45000000');
  });

  it('refuses to cost a call it cannot price, instead of recording a wrong number', async () => {
    const st = env.staffToken;
    const bare = (await env.call(st, 'POST', '/internal/providers', { adapterKey: 'openai', name: 'oa-bare', params: { apiKey: 'k' } })).json().id;
    expect((await cost({ usage: [{ providerId: bare, usage: { seconds: 10 } }] })).statusCode).toBe(409); // no rates captured
    expect((await cost({ occurredAt: '2025-01-01T00:00:00Z', usage: [T(10)] })).statusCode).toBe(409);   // before any version
    expect((await cost({ usage: [{ providerId: voice, usage: { seconds: 10 } }] })).statusCode).toBe(400); // usage matches no component
    expect((await cost({ occurredAt: '2025-06-01T00:00:00Z', usage: [T(10)] })).statusCode).toBe(409);
    expect((await cost({ usage: [{ providerId: randomUUID(), usage: { seconds: 10 } }] })).statusCode).toBe(400);
  });

  it('is idempotent: a retried call returns the same record', async () => {
    const callId = randomUUID();
    const a = (await cost({ usage: [T(30)] }, callId)).json();
    const b = (await cost({ usage: [T(30)] }, callId)).json();
    expect(b.id).toBe(a.id);
    expect((await env.pool.query('SELECT count(*)::int AS n FROM call_costs WHERE call_id = $1', [callId])).rows[0].n).toBe(1);
  });

  it('serialises concurrent deliveries of the same call', async () => {
    const callId = randomUUID();
    const rs = await Promise.all([1, 2, 3].map(() => cost({ usage: [T(30)] }, callId)));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([201, 201, 201]);
    expect(new Set(rs.map((r) => r.json().id)).size).toBe(1);
  });

  it('rejects bad input', async () => {
    expect((await cost({ usage: [] })).statusCode).toBe(400);
    expect((await cost({ usage: [T(-5)] })).statusCode).toBe(400);
    expect((await env.call(env.staffToken, 'POST', '/internal/calls/not-a-uuid/cost', {})).statusCode).toBe(400);
  });
});

describe('FX with no MYR rate', () => {
  it('refuses with a message that says what to add', async () => {
    const e2 = await (await import('./helpers.js')).setupDb();
    try {
      const st = e2.staffToken;
      const t = (await e2.call(st, 'POST', '/internal/tenants', { name: 'T' })).json().id;
      const p = (await e2.call(st, 'POST', '/internal/providers', { adapterKey: 'telnyx', name: 'x', params: { apiKey: 'k', webhookUrl: 'https://x.example/h' } })).json().id;
      await e2.call(st, 'POST', `/internal/providers/${p}/charging`, {
        effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1,
        components: [{ component: 'telephony_leg', unit: 'per_minute', rate: '0.01', currency: 'USD' }],
      });
      const res = await e2.call(st, 'POST', `/internal/calls/${randomUUID()}/cost`, {
        tenantId: t, direction: 'inbound', occurredAt: '2026-03-01T00:00:00Z', usage: [{ providerId: p, usage: { seconds: 10 } }],
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toContain('No FX rate for MYR');
    } finally { await e2.teardown(); }
  });
});

describe('credits and the client meter', () => {
  it('draw zero until a rate card exists, then mirror the provider increment', async () => {
    const st = env.staffToken;
    const t2 = (await env.call(st, 'POST', '/internal/tenants', { name: 'Meter Co' })).json().id;
    const mk = (callId: string, seconds: number, direction = 'outbound') => env.call(st, 'POST', `/internal/calls/${callId}/cost`, {
      tenantId: t2, direction, occurredAt: '2026-09-01T00:00:00Z', usage: [T(seconds)],
    });

    const early = (await mk(randomUUID(), 61)).json();
    expect(early.credits_drawn).toBe('0.0000');
    expect((await env.pool.query(`SELECT count(*)::int AS n FROM credit_entries WHERE tenant_id = $1 AND kind = 'usage'`, [t2])).rows[0].n).toBe(0);

    await env.call(st, 'POST', '/internal/rate-card', {
      effectiveFrom: '2026-08-01T00:00:00Z', inboundCreditsPerMinute: '1', outboundCreditsPerMinute: '2', creditValueUsd: '0.01',
    });
    const call = randomUUID();
    const r = (await mk(call, 61)).json();
    // 61s is billed as 66s by the provider's 6s increment, so the client is metered on 66s too: 2 * 1.1 = 2.2
    expect(r.credits_drawn).toBe('2.2000');
    expect(r.margin_usd).toBe('0.00660000'); // 2.2 credits * 0.01 - 0.0154 cost
    expect((await mk(randomUUID(), 61, 'inbound')).json().credits_drawn).toBe('1.1000');

    const summary = (await env.call(st, 'GET', `/internal/tenants/${t2}/credits`)).json();
    expect(summary.balance).toBe('-3.3000');

    // Re-delivering the same call must not draw credits a second time.
    await mk(call, 61);
    expect((await env.call(st, 'GET', `/internal/tenants/${t2}/credits`)).json().balance).toBe('-3.3000');
  });

  it('rounds credits to four decimals, half up', async () => {
    const st = env.staffToken;
    const t3 = (await env.call(st, 'POST', '/internal/tenants', { name: 'Round Co' })).json().id;
    const p = (await env.call(st, 'POST', '/internal/providers', { adapterKey: 'telnyx', name: 'tx-round', params: { apiKey: 'k', webhookUrl: 'https://x.example/h' } })).json().id;
    await env.call(st, 'POST', `/internal/providers/${p}/charging`, {
      effectiveFrom: '2027-01-01T00:00:00Z', billingIncrementSeconds: 1,
      components: [{ component: 'telephony_leg', unit: 'per_minute', rate: '0.01', currency: 'USD' }],
    });
    await env.call(st, 'POST', '/internal/fx', { currency: 'MYR', perUsd: '4.6', effectiveFrom: '2027-01-01T00:00:00Z' });
    await env.call(st, 'POST', '/internal/rate-card', {
      effectiveFrom: '2027-01-01T00:00:00Z', inboundCreditsPerMinute: '1', outboundCreditsPerMinute: '1', creditValueUsd: '0.01',
    });
    const r = (await env.call(st, 'POST', `/internal/calls/${randomUUID()}/cost`, {
      tenantId: t3, direction: 'outbound', occurredAt: '2027-02-01T00:00:00Z', usage: [{ providerId: p, usage: { seconds: 1 } }],
    })).json();
    expect(r.credits_drawn).toBe('0.0167'); // 1/60 = 0.016666...
    expect(r.myr_per_usd).toBe('4.60000000'); // the newer MYR rate was used, not the earlier one
  });
});

describe('campaign rollup and isolation', () => {
  it('rolls cost up per campaign', async () => {
    const rows = (await env.call(env.staffToken, 'GET', `/internal/costs/campaigns?tenantId=${tenantId}`)).json();
    const mine = rows.find((r: { project_id: string }) => r.project_id === projectId);
    expect(mine.project).toBe('Collections MY');
    expect(mine.calls).toBeGreaterThan(3);
    const direct = await env.pool.query('SELECT sum(total_usd) AS s FROM call_costs WHERE project_id = $1', [projectId]);
    expect(Number(mine.total_usd)).toBeCloseTo(Number(direct.rows[0].s), 8);
  });

  it('keeps cost, margin, FX, rate cards and do-not-call lists away from clients', async () => {
    const user = (await env.call(env.staffToken, 'POST', `/internal/tenants/${tenantId}/users`, { email: 'c@cost.test', role: 'tenant_admin' })).json();
    const asClient = (sql: string) => withActor(env.pool, { kind: 'client', tenantId }, (c) => c.query(sql));
    for (const table of ['call_costs', 'call_cost_lines', 'fx_rates', 'rate_cards', 'dnc_registries', 'dnc_entries']) {
      await expect(asClient(`SELECT * FROM ${table}`), table).rejects.toThrow(/permission denied/);
    }
    for (const url of [`/internal/costs/campaigns`, '/internal/fx', '/internal/rate-card', '/internal/dnc/registries']) {
      expect((await env.call(user.token, 'GET', url)).statusCode, url).toBe(403);
    }
  });

  it('keeps cost records append-only', async () => {
    await expect(env.pool.query('UPDATE call_costs SET total_usd = 0')).rejects.toThrow(/append-only/);
    await expect(env.pool.query('DELETE FROM call_cost_lines')).rejects.toThrow(/append-only/);
    await expect(env.pool.query('UPDATE fx_rates SET per_usd = 1')).rejects.toThrow(/append-only/);
  });
});
