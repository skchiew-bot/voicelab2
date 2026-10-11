import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseTelnyxCost } from '../src/telephony/telnyx.js';

/**
 * Telnyx reports what it charged for each call in a signed `call.cost` webhook (Telnyx's published API description,
 * kept in tests/fixtures/telnyx-call-cost.json). The report is kept against the call and the call's estimate is checked
 * against it, as Twilio's are against its usage API.
 */
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/telnyx-call-cost.json', import.meta.url), 'utf8'));
type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let projectId: string; let telnyxId: string;
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
  tenantId = (await must(env.call(st, 'POST', '/internal/tenants', { name: 'Telnyx Co' }))).json().id;
  projectId = (await must(env.call(st, 'POST', `/internal/tenants/${tenantId}/projects`, { name: 'Camp' }))).json().id;
  telnyxId = (await must(env.call(st, 'POST', '/internal/providers', {
    adapterKey: 'telnyx', name: 'tx', params: { apiKey: 'KEY', webhookUrl: 'https://voicelab.test/h', connectionId: 'conn-1', webhookPublicKey: pubB64 },
  }))).json().id;
  // 0.0070 a minute, billed by the minute: a 61-second call is billed 120 seconds, 0.0140 USD.
  await must(env.call(st, 'POST', `/internal/providers/${telnyxId}/charging`, { reason: 'Set up for this test.',
    effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 60,
    components: [{ component: 'telephony_leg', unit: 'per_minute', rate: '0.0070', currency: 'USD' }],
  }));
  await must(env.call(st, 'POST', '/internal/fx', { currency: 'MYR', perUsd: '4.5', effectiveFrom: '2026-01-01T00:00:00Z' }));
  await must(env.call(st, 'POST', '/internal/fx', { currency: 'EUR', perUsd: '0.8', effectiveFrom: '2026-01-01T00:00:00Z' }));
  await must(env.call(st, 'POST', '/internal/rate-card', { effectiveFrom: '2026-01-01T00:00:00Z', inboundCreditsPerMinute: '1', outboundCreditsPerMinute: '2', creditValueUsd: '0.01' }));
});
afterAll(async () => { await env?.teardown(); });

/** A finished Telnyx call, with its estimate recorded unless `costed` is false. */
async function mkCall(o: { seconds?: number; costed?: boolean } = {}) {
  const id = randomUUID(); const ccid = `v3:cc_${id.slice(0, 8)}`;
  await env.pool.query(
    `INSERT INTO calls (id, tenant_id, project_id, provider_id, provider_call_id, direction, status, country, started_at, answered_at, ended_at, duration_seconds, end_reason, cost_status)
     VALUES ($1,$2,$3,$4,$5,'outbound','completed','MY', now() - interval '2 hours', now() - interval '2 hours', now() - interval '1 hour', $6, 'completed', 'pending')`,
    [id, tenantId, projectId, telnyxId, ccid, o.seconds ?? 61]);
  if (o.costed !== false) await costIt(id, o.seconds ?? 61);
  return { id, ccid };
}
async function costIt(id: string, seconds: number) {
  await must(env.call(env.staffToken, 'POST', `/internal/calls/${id}/cost`, {
    tenantId, projectId, direction: 'outbound', occurredAt: new Date(Date.now() - 7_200_000).toISOString(),
    usage: [{ providerId: telnyxId, usage: { seconds } }],
  }));
  await env.pool.query(`UPDATE calls SET cost_status = 'recorded' WHERE id = $1`, [id]);
}

/** Telnyx's own report, from the fixture, for one of our calls. */
const report = (call: { id: string; ccid: string }, over: Record<string, unknown> = {}, eventId = randomUUID()) => {
  const b = structuredClone(FIXTURE.callCost);
  b.data.id = eventId;
  b.data.occurred_at = new Date().toISOString();
  Object.assign(b.data.payload, {
    call_control_id: call.ccid, client_state: Buffer.from(call.id).toString('base64'),
    total_cost: '0.0140', billed_duration_secs: 120,
    cost_parts: [{ call_part: 'call-control', rate: '0.00700', cost: '0.0140', currency: 'USD', billed_duration_secs: 120 }],
  }, over);
  return b;
};
// An independent implementation of Telnyx's signing, so the tests do not just agree with the code.
const post = (body: unknown, o: { sig?: string } = {}) => {
  const raw = JSON.stringify(body); const ts = String(Math.floor(Date.now() / 1000));
  return env.app.inject({
    method: 'POST', url: `/webhooks/telnyx/${telnyxId}`, payload: raw,
    headers: { 'content-type': 'application/json', 'telnyx-timestamp': ts, 'telnyx-signature-ed25519': o.sig ?? sign(null, Buffer.from(`${ts}|${raw}`), keys.privateKey).toString('base64') },
  });
};
const callRow = async (id: string) => (await env.call(env.staffToken, 'GET', `/internal/calls/${id}`)).json();
const checks = async (id: string) => (await env.call(env.staffToken, 'GET', `/internal/calls/${id}/reconciliations`)).json() as { outcome: string; source: string; our_seconds: string; reported_seconds: string | null; reported_cost_usd: string | null }[];
const reports = async (id: string) => (await env.pool.query('SELECT r.status, r.billed_seconds, r.amounts FROM provider_cost_reports r JOIN calls ca ON ca.id = $1 WHERE r.call_id = ca.id OR (r.provider_id = ca.provider_id AND r.provider_call_id = ca.provider_call_id) ORDER BY r.id', [id])).rows;
const credits = async () => (await env.call(env.staffToken, 'GET', `/internal/tenants/${tenantId}/credits`)).json().balance as string;
const recon = (id: string) => env.call(env.staffToken, 'POST', `/internal/calls/${id}/reconcile`, { source: 'provider_api' });

describe('reading a Telnyx call cost report', () => {
  it('reads the example Telnyx publishes: each part in its own currency, the billed seconds, and nothing for other events', () => {
    const r = parseTelnyxCost(FIXTURE.callCost)!;
    expect(r).toMatchObject({ key: '0ccc7b54-4df3-4bca-a65a-3da1ecc777f0', providerCallId: FIXTURE.callCost.data.payload.call_control_id, status: 'ready', billedSeconds: 120 });
    expect(r.status === 'ready' && r.amounts).toEqual([{ cost: '0.01060000', currency: 'USD' }]); // 0.0050 + 0.0038 + 0.0018
    expect(parseTelnyxCost({ data: { ...FIXTURE.callCost.data, event_type: 'call.hangup' } })).toBeNull();
    const mixed = structuredClone(FIXTURE.callCost); mixed.data.payload.cost_parts[1].currency = 'eur';
    expect((parseTelnyxCost(mixed) as { amounts: unknown }).amounts).toEqual([{ cost: '0.00680000', currency: 'USD' }, { cost: '0.00380000', currency: 'EUR' }]);
    const failed = structuredClone(FIXTURE.callCost); failed.data.payload.status = 'error';
    expect(parseTelnyxCost(failed)!.status).toBe('error');
  });

  it('refuses a report it cannot read, instead of guessing: parts that do not add up, a total with no parts, an odd status or amount', () => {
    const variant = (f: (p: any) => void) => { const b = structuredClone(FIXTURE.callCost); f(b.data.payload); return () => parseTelnyxCost(b); };
    expect(variant((p) => { p.total_cost = '0.0200'; })).toThrow(/do not add up/);
    expect(variant((p) => { p.cost_parts = []; })).toThrow(/currency is unknown/);
    expect(variant((p) => { p.status = 'pending'; })).toThrow(/status/);
    expect(variant((p) => { p.cost_parts[0].cost = '-0.0050'; })).toThrow(/cost part/);
    expect(variant((p) => { p.cost_parts[0].cost = 0.005; })).toThrow(/cost part/);
    expect(variant((p) => { p.cost_parts[0].currency = undefined; })).toThrow(/cost part/);
    expect(variant((p) => { p.billed_duration_secs = 1.5; })).toThrow(/billed duration/);
    expect(variant((p) => { delete p.call_control_id; })).toThrow(/call id/);
    // A call that cost nothing can come with no parts at all.
    expect((variant((p) => { p.cost_parts = []; p.total_cost = '0'; })() as { amounts: unknown }).amounts).toEqual([]);
  });
});

describe('a Telnyx call cost report', () => {
  it('checks the call as soon as it arrives: a match promotes the record without drawing credits again, and a retried delivery changes nothing', async () => {
    const call = await mkCall();
    const before = await credits();
    const body = report(call);
    expect((await post(body)).statusCode).toBe(200);
    expect((await callRow(call.id)).cost_status).toBe('reconciled');
    const [c] = await checks(call.id);
    // Telnyx bills by the minute: its 120 seconds are set against our 120 billed seconds, not the call's 61.
    expect(c).toMatchObject({ outcome: 'matched', source: 'provider_api', reported_seconds: '120.000', reported_cost_usd: '0.01400000' });
    expect(Number(c!.our_seconds)).toBe(120);
    expect(await credits()).toBe(before);
    expect((await post(body)).statusCode).toBe(200);
    expect(await reports(call.id)).toHaveLength(1);
    expect(await checks(call.id)).toHaveLength(1);
  });

  it('flags a difference and leaves the estimate alone, and converts a part priced in another currency', async () => {
    const dear = await mkCall();
    await post(report(dear, { total_cost: '0.0200', cost_parts: [{ call_part: 'call-control', cost: '0.0200', currency: 'USD', billed_duration_secs: 120 }] }));
    expect((await callRow(dear.id)).cost_status).toBe('variance');
    expect((await checks(dear.id))[0]!.reported_cost_usd).toBe('0.02000000');
    expect((await env.call(env.staffToken, 'GET', `/internal/calls/${dear.id}/cost`)).json().total_usd).toBe('0.01400000');

    const longer = await mkCall();
    await post(report(longer, { billed_duration_secs: 180 }));
    expect((await callRow(longer.id)).cost_status).toBe('variance'); // the cost agrees, the billed time does not

    // 0.0070 USD of telephony and 0.0056 EUR (0.0070 USD at 0.8 EUR to the dollar) of a second part: 0.0140 USD in all.
    const split = await mkCall();
    await post(report(split, { total_cost: null, cost_parts: [
      { call_part: 'sip-trunking', cost: '0.0070', currency: 'USD', billed_duration_secs: 120 },
      { call_part: 'call-control', cost: '0.0056', currency: 'EUR', billed_duration_secs: 120 },
    ] }));
    expect((await checks(split.id))[0]).toMatchObject({ outcome: 'matched', reported_cost_usd: '0.01400000' });
  });

  it('is kept when it arrives before the call is costed, and the sweep checks the call once it is', async () => {
    const call = await mkCall({ costed: false });
    expect((await post(report(call))).statusCode).toBe(200);
    expect(await reports(call.id)).toHaveLength(1);
    expect(await checks(call.id)).toHaveLength(0);
    await costIt(call.id, 61);
    const tally = (await env.call(env.staffToken, 'POST', '/internal/reconcile/run', { olderThanMinutes: 0, limit: 100 })).json();
    expect(tally.matched).toBeGreaterThanOrEqual(1);
    expect((await callRow(call.id)).cost_status).toBe('reconciled');
  });

  it('leaves a call Telnyx has not priced as pending: no report, or a report that it could not price it, and a later failure takes no price away', async () => {
    const none = await mkCall();
    expect((await recon(none.id)).json()).toMatchObject({ outcome: 'pending' });
    // The sweep does not spend its tries on a Telnyx call with no report: it has nothing to ask.
    await env.call(env.staffToken, 'POST', '/internal/reconcile/run', { olderThanMinutes: 0, limit: 100 });
    expect((await env.pool.query('SELECT reconcile_attempts FROM calls WHERE id = $1', [none.id])).rows[0].reconcile_attempts).toBe(0);

    const failed = await mkCall();
    await post(report(failed, { status: 'error', total_cost: null, cost_parts: [] }));
    expect(await reports(failed.id)).toEqual([{ status: 'error', billed_seconds: null, amounts: [] }]);
    expect((await recon(failed.id)).json()).toMatchObject({ outcome: 'pending' });
    expect(await checks(failed.id)).toHaveLength(0);
    // Nor on one Telnyx said it could not price: that would use up the call's tries with nothing to check.
    await env.call(env.staffToken, 'POST', '/internal/reconcile/run', { olderThanMinutes: 0, limit: 100 });
    expect((await env.pool.query('SELECT reconcile_attempts FROM calls WHERE id = $1', [failed.id])).rows[0].reconcile_attempts).toBe(0);

    // Priced, then (out of order) "could not price it": the price stands.
    const priced = await mkCall({ costed: false });
    await post(report(priced));
    await post(report(priced, { status: 'error', total_cost: null, cost_parts: [] }));
    await costIt(priced.id, 61);
    expect((await recon(priced.id)).json()).toMatchObject({ outcome: 'matched' });
  });

  it('is refused when unsigned or unreadable, and stores nothing for a call that is not ours', async () => {
    const call = await mkCall();
    expect((await post(report(call), { sig: Buffer.alloc(64).toString('base64') })).statusCode).toBe(403);
    expect((await post(report(call, { total_cost: '9.9999' }))).statusCode).toBe(400);
    expect(await reports(call.id)).toHaveLength(0);
    expect((await callRow(call.id)).cost_status).toBe('recorded');

    // The refusal leaves a trace in our own words, so a report Telnyx stops retrying is not lost unseen.
    const trace = (await env.pool.query(`SELECT detail FROM audit_log WHERE action = 'webhook.unreadable' AND entity_id = $1`, [telnyxId])).rows;
    expect(trace).toEqual([{ detail: { kind: 'cost', reason: 'Telnyx sent a call cost whose parts do not add up to its total.' } }]);

    // A leg Voice Lab does not know is kept unattached and audited; nothing is put on any call.
    const stranger = { id: randomUUID(), ccid: 'v3:not_ours' };
    expect((await post(report(stranger))).statusCode).toBe(200);
    expect((await env.pool.query(`SELECT call_id FROM provider_cost_reports WHERE provider_call_id = 'v3:not_ours'`)).rows).toEqual([{ call_id: null }]);
    expect((await env.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'webhook.unknown_call' AND detail->>'kind' = 'cost'`)).rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('is found for a call recorded after it arrived, so a report that comes first is not lost', async () => {
    const id = randomUUID(); const ccid = `v3:cc_late_${id.slice(0, 6)}`;
    // An inbound call whose own first event is delivered late: the cost report reaches us before the call exists.
    expect((await post(report({ id: randomUUID(), ccid }, { client_state: undefined }))).statusCode).toBe(200);
    await env.pool.query(
      `INSERT INTO calls (id, tenant_id, project_id, provider_id, provider_call_id, direction, status, country, started_at, answered_at, ended_at, duration_seconds, end_reason, cost_status)
       VALUES ($1,$2,$3,$4,$5,'outbound','completed','MY', now() - interval '2 hours', now() - interval '2 hours', now() - interval '1 hour', 61, 'completed', 'pending')`,
      [id, tenantId, projectId, telnyxId, ccid]);
    await costIt(id, 61);
    await env.call(env.staffToken, 'POST', '/internal/reconcile/run', { olderThanMinutes: 0, limit: 100 });
    expect((await callRow(id)).cost_status).toBe('reconciled');
  });

  it('never puts another leg on the call because it carries our call id, and checks a corrected report again', async () => {
    const call = await mkCall();
    // A leg Telnyx created from ours (a bridge, a transfer) carries our client_state but is not the call's own leg.
    await post(report({ id: call.id, ccid: 'v3:other_leg' }, { total_cost: '0.0500', cost_parts: [{ call_part: 'call-control', cost: '0.0500', currency: 'USD', billed_duration_secs: 120 }] }));
    expect((await callRow(call.id)).cost_status).toBe('recorded');
    expect(await checks(call.id)).toHaveLength(0);

    // A first report that does not match, then a corrected one: the call is checked again, against the newer report.
    const wrong = report(call, { total_cost: '0.0200', cost_parts: [{ call_part: 'call-control', cost: '0.0200', currency: 'USD', billed_duration_secs: 120 }] });
    wrong.data.occurred_at = new Date(Date.now() - 60_000).toISOString();
    await post(wrong);
    expect((await callRow(call.id)).cost_status).toBe('variance');
    await post(report(call));
    expect((await callRow(call.id)).cost_status).toBe('reconciled');
    expect((await checks(call.id)).map((c) => c.outcome)).toEqual(['variance', 'matched']);
  });

  it('keeps a report priced in a currency with no exchange rate, and checks the call once the rate exists', async () => {
    const call = await mkCall();
    const gbp = report(call, { total_cost: '0.0112', cost_parts: [{ call_part: 'call-control', cost: '0.0112', currency: 'GBP', billed_duration_secs: 120 }] });
    expect((await post(gbp)).statusCode).toBe(200);
    expect(await reports(call.id)).toHaveLength(1);
    expect((await callRow(call.id)).cost_status).toBe('recorded');
    await must(env.call(env.staffToken, 'POST', '/internal/fx', { currency: 'GBP', perUsd: '0.8', effectiveFrom: '2026-01-01T00:00:00Z' }));
    await env.call(env.staffToken, 'POST', '/internal/reconcile/run', { olderThanMinutes: 0, limit: 100 });
    expect((await callRow(call.id)).cost_status).toBe('reconciled');
  });

  it('keeps one report and one check when the same report is delivered several times at once', async () => {
    const call = await mkCall();
    const body = report(call);
    const res = await Promise.all([post(body), post(body), post(body)]);
    expect(res.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(await reports(call.id)).toHaveLength(1);
    expect((await checks(call.id)).map((c) => c.outcome)).toEqual(['matched']);
  });

  it('is append-only and out of reach of clients', async () => {
    const call = await mkCall();
    await post(report(call));
    await expect(env.pool.query('UPDATE provider_cost_reports SET billed_seconds = 1 WHERE call_id = $1', [call.id])).rejects.toThrow();
    await expect(env.pool.query('DELETE FROM provider_cost_reports WHERE call_id = $1', [call.id])).rejects.toThrow();
    const c = await env.pool.connect();
    try {
      await c.query('BEGIN'); await c.query('SET LOCAL ROLE voicelab_client');
      await expect(c.query('SELECT 1 FROM provider_cost_reports')).rejects.toThrow(/permission denied/);
    } finally { await c.query('ROLLBACK'); c.release(); }
  });
});

describe('a Telnyx call from dial to reconciled', () => {
  it('is placed, priced at hangup, and checked against the cost Telnyx then reports', async () => {
    await must(env.call(env.staffToken, 'POST', '/internal/numbers', { providerId: telnyxId, e164: '+60387654321', tenantId, projectId, country: 'MY' }));
    await must(env.call(env.staffToken, 'POST', '/internal/dnc/registries', { country: 'MY', requirement: 'registry', source: 'test' }));
    env.provider.state.respond = (url) => url.endsWith('/v2/calls')
      ? new Response(JSON.stringify({ data: { call_control_id: 'v3:cc_live' } }), { status: 200 }) : new Response('{}', { status: 200 });
    const placed = await must(env.call(env.staffToken, 'POST', '/internal/calls/outbound', { tenantId, projectId, country: 'MY', providerId: telnyxId, from: '+60387654321', to: '+60123456789' }));
    const callId = placed.json().callId as string;
    const cs = Buffer.from(callId).toString('base64');
    const ev = (type: string, at: Date, extra: Record<string, unknown> = {}) =>
      ({ data: { id: randomUUID(), event_type: type, occurred_at: at.toISOString(), record_type: 'event', payload: { call_control_id: 'v3:cc_live', client_state: cs, direction: 'outgoing', ...extra } } });
    const t0 = new Date();
    for (const b of [ev('call.initiated', t0), ev('call.answered', new Date(t0.getTime() + 5_000)), ev('call.hangup', new Date(t0.getTime() + 66_000), { hangup_cause: 'normal_clearing' })]) {
      expect((await post(b)).statusCode).toBe(200);
    }
    const row = await callRow(callId);
    expect(row.cost_status).toBe('recorded');
    const ours = (await env.call(env.staffToken, 'GET', `/internal/calls/${callId}/cost`)).json();
    const billed = Math.max(...ours.lines.map((l: { billed_seconds: number | null }) => l.billed_seconds ?? 0));
    await post(report({ id: callId, ccid: 'v3:cc_live' }, {
      total_cost: ours.total_usd.replace(/0+$/, ''), billed_duration_secs: billed,
      cost_parts: [{ call_part: 'call-control', cost: ours.total_usd.replace(/0+$/, ''), currency: 'USD', billed_duration_secs: billed }],
    }));
    expect((await callRow(callId)).cost_status).toBe('reconciled');
  });
});
