import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db.js';
import { compare } from '../src/reconcile-rules.js';

describe('the comparison rule', () => {
  const base = { ourSeconds: 61, ourCostUsd: '0.02800000', tolerancePct: 2 };
  it('agrees when every figure is within tolerance', () => {
    expect(compare({ ...base, reportedSeconds: 61, reportedCostUsd: '0.02800000' }).matched).toBe(true);
    expect(compare({ ...base, reportedCostUsd: '0.02850000' }).matched).toBe(true); // 1.8% out
  });
  it('differs when a figure is outside tolerance, and says which', () => {
    const v = compare({ ...base, reportedSeconds: 61, reportedCostUsd: '0.05000000' });
    expect(v.matched).toBe(false);
    expect(v.detail).toContain('duration agrees');
    expect(v.detail).toContain('cost differs');
  });
  it('needs every figure the provider gave to agree, not just one', () => {
    expect(compare({ ...base, ourSeconds: 600, reportedSeconds: 640, reportedCostUsd: '0.02800000' }).matched).toBe(false);
  });
  it('ignores noise below a second and below a hundredth of a cent', () => {
    expect(compare({ ...base, reportedSeconds: 62 }).matched).toBe(true);
    expect(compare({ ourSeconds: 5, ourCostUsd: '0.00001000', reportedCostUsd: '0.00009000', tolerancePct: 0 }).matched).toBe(true);
    expect(compare({ ourSeconds: 5, ourCostUsd: '0.00001000', reportedCostUsd: '0.00020000', tolerancePct: 0 }).matched).toBe(false);
  });
  it('refuses to give a verdict with nothing to compare', () => {
    expect(() => compare(base)).toThrow(/Nothing to compare/);
  });
});

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let projectId: string; let twilioId: string; let telnyxId: string;

async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  const st = env.staffToken;
  tenantId = (await must(env.call(st, 'POST', '/internal/tenants', { name: 'Recon Co' }))).json().id;
  projectId = (await must(env.call(st, 'POST', `/internal/tenants/${tenantId}/projects`, { name: 'Camp' }))).json().id;
  twilioId = (await must(env.call(st, 'POST', '/internal/providers', {
    adapterKey: 'twilio', name: 'tw', params: { accountSid: 'AC1', authToken: 't', twimlAppVoiceUrl: 'https://x.example/v' },
  }))).json().id;
  telnyxId = (await must(env.call(st, 'POST', '/internal/providers', {
    adapterKey: 'telnyx', name: 'tx', params: { apiKey: 'k', webhookUrl: 'https://x.example/h' },
  }))).json().id;
  for (const id of [twilioId, telnyxId]) {
    await must(env.call(st, 'POST', `/internal/providers/${id}/charging/reference`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 60 }));
  }
  await must(env.call(st, 'POST', '/internal/fx', { currency: 'MYR', perUsd: '4.5', effectiveFrom: '2026-01-01T00:00:00Z' }));
  await must(env.call(st, 'POST', '/internal/fx', { currency: 'EUR', perUsd: '0.8', effectiveFrom: '2026-01-01T00:00:00Z' }));
  await must(env.call(st, 'POST', '/internal/rate-card', { effectiveFrom: '2026-01-01T00:00:00Z', inboundCreditsPerMinute: '1', outboundCreditsPerMinute: '2', creditValueUsd: '0.01' }));
});
afterAll(async () => { await env?.teardown(); });

/** A finished call with a recorded estimate, as the call-control flow would leave it. */
async function mkCall(o: { providerId: string; direction?: 'inbound' | 'outbound'; seconds: number; sid?: string }) {
  const id = randomUUID();
  const sid = o.sid ?? `CA_${id.slice(0, 8)}`;
  await env.pool.query(
    `INSERT INTO calls (id, tenant_id, project_id, provider_id, provider_call_id, direction, status, country, started_at, answered_at, ended_at, duration_seconds, end_reason, cost_status)
     VALUES ($1,$2,$3,$4,$5,$6,'completed','MY', now() - interval '2 hours', now() - interval '2 hours', now() - interval '1 hour', $7, 'completed', 'pending')`,
    [id, tenantId, projectId, o.providerId, sid, o.direction ?? 'outbound', o.seconds],
  );
  const res = await env.call(env.staffToken, 'POST', `/internal/calls/${id}/cost`, {
    tenantId, projectId, direction: o.direction ?? 'outbound', occurredAt: new Date(Date.now() - 7_200_000).toISOString(),
    usage: [{ providerId: o.providerId, usage: { seconds: o.seconds } }],
  });
  if (res.statusCode !== 201) throw new Error(`cost failed: ${res.body}`);
  await env.pool.query(`UPDATE calls SET cost_status = 'recorded' WHERE id = $1`, [id]);
  return { id, sid };
}
const twilioSays = (b: object) => { env.provider.state.respond = () => new Response(JSON.stringify(b), { status: 200 }); };
const recon = (id: string, body: object) => env.call(env.staffToken, 'POST', `/internal/calls/${id}/reconcile`, body);
const credits = async () => (await env.call(env.staffToken, 'GET', `/internal/tenants/${tenantId}/credits`)).json().balance as string;
const rollup = async () => (await env.call(env.staffToken, 'GET', `/internal/costs/campaigns?tenantId=${tenantId}`)).json()[0];

describe('the blueprint\'s reference rates', () => {
  it('are offered per provider type, and saved as unconfirmed versions with the caller\'s billing increment', async () => {
    const list = (await env.call(env.staffToken, 'GET', '/internal/reference-rates')).json();
    expect(list.map((r: { adapterKey: string }) => r.adapterKey).sort()).toEqual(['elevenlabs', 'openai', 'telnyx', 'twilio']);
    const v = (await env.call(env.staffToken, 'GET', `/internal/providers/${twilioId}/charging`)).json()[0];
    expect(v).toMatchObject({ confirmed: false, billing_increment_seconds: 60 });
    expect(v.notes).toContain('unconfirmed');
    const byDir = Object.fromEntries(v.components.map((c: { direction: string; rate: string }) => [c.direction, c.rate]));
    expect(byDir).toEqual({ outbound: '0.01400000', inbound: '0.00850000' });
  });

  it('do not guess a billing increment', async () => {
    expect((await env.call(env.staffToken, 'POST', `/internal/providers/${twilioId}/charging/reference`, { effectiveFrom: '2027-01-01T00:00:00Z' })).statusCode).toBe(400);
  });

  it('carry ElevenLabs\' overburst doubling', async () => {
    const el = (await must(env.call(env.staffToken, 'POST', '/internal/providers', { adapterKey: 'elevenlabs', name: 'el', params: { apiKey: 'k' } }))).json().id;
    const v = (await must(env.call(env.staffToken, 'POST', `/internal/providers/${el}/charging/reference`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1 }))).json();
    expect(v.burst_premium_multiplier).toBe('2.000');
  });
});

describe('direction-specific rates', () => {
  it('price an inbound and an outbound call from the same provider differently', async () => {
    const out = await mkCall({ providerId: twilioId, direction: 'outbound', seconds: 60 });
    const inb = await mkCall({ providerId: twilioId, direction: 'inbound', seconds: 60 });
    const cost = async (id: string) => (await env.call(env.staffToken, 'GET', `/internal/calls/${id}/cost`)).json();
    expect((await cost(out.id)).total_usd).toBe('0.01400000');
    expect((await cost(inb.id)).total_usd).toBe('0.00850000');
    expect((await cost(inb.id)).lines).toHaveLength(1); // the outbound line was skipped, not zeroed
  });

  it('leave a provider with only an outbound rate unable to price an inbound call, rather than inventing one', async () => {
    const res = await env.call(env.staffToken, 'POST', `/internal/calls/${randomUUID()}/cost`, {
      tenantId, direction: 'inbound', occurredAt: '2026-03-01T00:00:00Z', usage: [{ providerId: telnyxId, usage: { seconds: 60 } }],
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('reconciling against the provider', () => {
  it('Twilio: asks the provider for the call, and a match promotes the record without redrawing credits or double counting', async () => {
    const call = await mkCall({ providerId: twilioId, seconds: 61 }); // 61s on 60s blocks = 2 minutes = 0.028
    const before = { credits: await credits(), rollup: await rollup() };
    env.provider.calls.length = 0;
    twilioSays({ duration: '61', price: '-0.0280', price_unit: 'USD' });
    const res = await recon(call.id, { source: 'provider_api' });
    expect(res.json()).toMatchObject({ outcome: 'matched' });

    const req = env.provider.calls[0]!;
    expect(req.method).toBe('GET');
    expect(req.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/AC1/Calls/${call.sid}.json`);
    expect(req.headers.authorization).toBe('Basic ' + Buffer.from('AC1:t').toString('base64'));

    const cost = (await env.call(env.staffToken, 'GET', `/internal/calls/${call.id}/cost`)).json();
    expect(cost.status).toBe('reconciled');
    expect(cost.lines).toHaveLength(1);
    expect((await env.call(env.staffToken, 'GET', `/internal/calls/${call.id}`)).json().cost_status).toBe('reconciled');
    expect(await credits()).toBe(before.credits);
    const after = await rollup();
    expect(after.calls).toBe(before.rollup.calls);
    expect(after.total_usd).toBe(before.rollup.total_usd);
    expect((await env.pool.query(`SELECT count(*)::int AS n FROM call_costs WHERE call_id = $1`, [call.id])).rows[0].n).toBe(2);
  });

  it('Twilio: a difference is stored and flagged, and the estimate is left alone', async () => {
    const call = await mkCall({ providerId: twilioId, seconds: 61 });
    twilioSays({ duration: '61', price: '-0.0500', price_unit: 'USD' });
    const res = (await recon(call.id, { source: 'provider_api' })).json();
    expect(res.outcome).toBe('variance');
    expect(res.detail).toContain('cost differs');
    const cost = (await env.call(env.staffToken, 'GET', `/internal/calls/${call.id}/cost`)).json();
    expect(cost.status).toBe('estimated');
    expect(cost.total_usd).toBe('0.02800000');
    expect((await env.call(env.staffToken, 'GET', `/internal/calls/${call.id}`)).json().cost_status).toBe('variance');
    const types = (await env.call(env.staffToken, 'GET', `/internal/calls/${call.id}/events`)).json().map((e: { type: string }) => e.type);
    expect(types).toContain('call.cost_variance');
    const rows = (await env.call(env.staffToken, 'GET', `/internal/calls/${call.id}/reconciliations`)).json();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'variance', reported_cost_usd: '0.05000000', our_cost_usd: '0.02800000' });
  });

  it('Twilio: a price not yet published is "pending" and stores nothing', async () => {
    const call = await mkCall({ providerId: twilioId, seconds: 30 });
    twilioSays({ duration: '30', price: null, price_unit: null });
    expect((await recon(call.id, { source: 'provider_api' })).json().outcome).toBe('pending');
    expect((await env.call(env.staffToken, 'GET', `/internal/calls/${call.id}/reconciliations`)).json()).toHaveLength(0);
    expect((await env.call(env.staffToken, 'GET', `/internal/calls/${call.id}`)).json().cost_status).toBe('recorded');
  });

  it('is repeatable: a matched call stays matched, and a variance can be settled with corrected figures', async () => {
    const call = await mkCall({ providerId: twilioId, seconds: 61 });
    twilioSays({ duration: '61', price: '-0.0500', price_unit: 'USD' });
    expect((await recon(call.id, { source: 'provider_api' })).json().outcome).toBe('variance');
    const fixed = await recon(call.id, { source: 'manual', reportedSeconds: 61, reportedCost: '0.0280' });
    expect(fixed.json().outcome).toBe('matched');
    const again = (await recon(call.id, { source: 'manual', reportedCost: '9.9' })).json();
    expect(again).toMatchObject({ outcome: 'matched', alreadyReconciled: true });
    expect((await env.pool.query(`SELECT count(*)::int AS n FROM call_costs WHERE call_id = $1 AND status = 'reconciled'`, [call.id])).rows[0].n).toBe(1);
  });

  it('manual figures work for any provider, in another currency', async () => {
    const call = await mkCall({ providerId: telnyxId, seconds: 61 }); // 2 minutes at 0.007 = 0.014 USD = 0.0112 EUR
    const res = await recon(call.id, { source: 'manual', reportedSeconds: 61, reportedCost: '0.0112', currency: 'eur' });
    expect(res.json().outcome).toBe('matched');
  });

  it('refuses what it cannot check', async () => {
    const tx = await mkCall({ providerId: telnyxId, seconds: 61 });
    expect((await recon(tx.id, { source: 'provider_api' })).statusCode).toBe(400); // no automatic check for Telnyx yet
    expect((await recon(tx.id, { source: 'manual' })).statusCode).toBe(400);       // no figures given
    expect((await recon(randomUUID(), { source: 'manual', reportedCost: '1' })).statusCode).toBe(404);
    const open = randomUUID();
    await env.pool.query(`INSERT INTO calls (id, tenant_id, provider_id, direction, status, provider_call_id) VALUES ($1,$2,$3,'outbound','in_progress','CA_open')`, [open, tenantId, twilioId]);
    expect((await recon(open, { source: 'manual', reportedCost: '1' })).statusCode).toBe(409);
  });

  it('reports a provider outage as an error and stores nothing', async () => {
    const call = await mkCall({ providerId: twilioId, seconds: 61 });
    env.provider.state.respond = () => { throw new Error('connect ETIMEDOUT'); };
    const res = await recon(call.id, { source: 'provider_api' });
    expect(res.statusCode).toBe(502);
    expect((await env.call(env.staffToken, 'GET', `/internal/calls/${call.id}/reconciliations`)).json()).toHaveLength(0);
  });

  it('sweeps finished Twilio calls that have not been checked, leaving unpriced ones for next time', async () => {
    const fresh = [await mkCall({ providerId: twilioId, seconds: 61 }), await mkCall({ providerId: twilioId, seconds: 61 })];
    const unpriced = await mkCall({ providerId: twilioId, seconds: 61 });
    env.provider.state.respond = (url) => url.includes(unpriced.sid)
      ? new Response(JSON.stringify({ duration: '61', price: null }), { status: 200 })
      : new Response(JSON.stringify({ duration: '61', price: '-0.0280', price_unit: 'USD' }), { status: 200 });
    const tally = (await env.call(env.staffToken, 'POST', '/internal/reconcile/run', { olderThanMinutes: 0, limit: 100 })).json();
    expect(tally.matched).toBeGreaterThanOrEqual(2);
    expect(tally.pending).toBeGreaterThanOrEqual(1);
    for (const c of fresh) expect((await env.call(env.staffToken, 'GET', `/internal/calls/${c.id}`)).json().cost_status).toBe('reconciled');
    expect((await env.call(env.staffToken, 'GET', `/internal/calls/${unpriced.id}`)).json().cost_status).toBe('recorded');
    // A second sweep does not re-ask about calls already reconciled.
    env.provider.calls.length = 0;
    await env.call(env.staffToken, 'POST', '/internal/reconcile/run', { olderThanMinutes: 0, limit: 100 });
    expect(env.provider.calls.some((c) => c.url.includes(fresh[0]!.sid))).toBe(false);
  });
});

describe('listing calls and access', () => {
  it('lists recent calls, filterable by status', async () => {
    const all = (await env.call(env.staffToken, 'GET', '/internal/calls?limit=5')).json();
    expect(all.length).toBeLessThanOrEqual(5);
    const open = (await env.call(env.staffToken, 'GET', '/internal/calls?status=in_progress')).json();
    expect(open.every((c: { status: string }) => c.status === 'in_progress')).toBe(true);
    expect((await env.call(env.staffToken, 'GET', '/internal/calls?status=bogus')).statusCode).toBe(400);
  });

  it('keeps reconciliation out of reach of clients', async () => {
    const user = (await env.call(env.staffToken, 'POST', `/internal/tenants/${tenantId}/users`, { email: 'c@recon.test', role: 'tenant_admin' })).json();
    await expect(withActor(env.pool, { kind: 'client', tenantId }, (c) => c.query('SELECT * FROM call_reconciliations'))).rejects.toThrow(/permission denied/);
    for (const [m, u] of [['POST', '/internal/reconcile/run'], ['GET', '/internal/calls'], ['GET', '/internal/reference-rates']] as const) {
      expect((await env.call(user.token, m, u, m === 'POST' ? {} : undefined)).statusCode, u).toBe(403);
    }
    await expect(env.pool.query('UPDATE call_reconciliations SET outcome = $1', ['matched'])).rejects.toThrow(/append-only/);
  });
});
