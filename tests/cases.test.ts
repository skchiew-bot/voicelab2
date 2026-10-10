import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, localParts, localToInstant } from '../src/cases/policy.js';
import { withActor } from '../src/db.js';
import { parseKey } from '../src/secrets.js';
import { loadProvider, placeOutboundCall, processWebhook, type CallDeps } from '../src/store/calls.js';
import { checkPayments, decideCase, dispatchDue, sweepAgeing, type CaseDeps } from '../src/store/cases.js';
import { contactHash, contactKeyFrom, dncKeyFrom } from '../src/store/dnc.js';
import type { NormalizedEvent } from '../src/telephony/types.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let telnyxId: string; let deps: CaseDeps; let calls: CallDeps; let telnyx: Awaited<ReturnType<typeof loadProvider>>;
const OUR = '+60300000601';
const BASE = 'https://voicelab.test';
const KL = 'Asia/Kuala_Lumpur';
const st = () => env.staffToken;
const get = (u: string) => env.call(st(), 'GET', u);
const post = (u: string, b?: unknown) => env.call(st(), 'POST', u, b);
const put = (u: string, b?: unknown) => env.call(st(), 'PUT', u, b);
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}

// ---- a payment system of the client's own, over real TLS, that answers with whatever total each case has paid
const dir = mkdtempSync(path.join(tmpdir(), 'vl-cases-'));
let server: https.Server; let paymentHttp: NonNullable<CaseDeps['paymentHttp']>;
const paid = new Map<string, unknown>();
const toLoopback = ((_h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => (o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4))) as never;

// ---- time: the next given local hour in Kuala Lumpur, always a little ahead of the real clock
const nextLocal = (hh: string, plusDays = 0): Date => {
  const day = addDays(localParts(new Date(), KL).date, plusDays);
  const t = localToInstant(day, hh, KL);
  return t.getTime() > Date.now() + 5 * 60_000 ? t : localToInstant(addDays(day, 1), hh, KL);
};
const mins = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);

// ---- the customers' numbers: used for one dial and a keyed hash, never stored
const numbers = new Map<string, string>();
let phoneSeq = 0;
const newPhone = () => `+6012345${String(1000 + ++phoneSeq)}`;
const dials = () => env.provider.calls.filter((c) => c.url.endsWith('/v2/calls'));
let sid = 0;
const answerDials = () => { env.provider.state.respond = (url) => url.endsWith('/v2/calls') ? new Response(JSON.stringify({ data: { call_control_id: `cc_case_${++sid}` } })) : new Response('{}'); };

async function mkCase(ref: string, balance = '500', extra: object = {}, samePhone?: string) {
  const phone = samePhone ?? newPhone();
  numbers.set(ref, phone);
  const r = await must(post(`/internal/tenants/${tenantId}/cases`, { caseRef: ref, contactRef: `client-${ref}`, phone, country: 'MY', currency: 'MYR', openingBalance: balance, timeZone: KL, ...extra }));
  return { id: r.json().id as string, phone, ref };
}
const view = async (id: string) => (await get(`/internal/cases/${id}`)).json();
const actionsOf = async (id: string, kind?: string) => ((await view(id)).actions as { id: string; kind: string; status: string; channel: string; scheduled_for: string; attempt: number; call_id: string | null }[]).filter((a) => !kind || a.kind === kind);
const eventsOf = async (id: string) => ((await view(id)).events as { kind: string; detail: Record<string, unknown> }[]).map((e) => e.kind);
const callbackAt = (id: string, at: Date) => post(`/internal/cases/${id}/callbacks`, { at: at.toISOString() });
const evt = (kind: NormalizedEvent['kind'], pcid: string, extra: Partial<NormalizedEvent> = {}): NormalizedEvent =>
  ({ key: randomUUID(), providerCallId: pcid, kind, direction: 'outbound', occurredAt: new Date(), ...extra });
const send = (e: NormalizedEvent) => processWebhook(calls, telnyx!, e);
const providerCallIdOf = async (callId: string) => (await env.pool.query('SELECT provider_call_id FROM calls WHERE id = $1', [callId])).rows[0].provider_call_id as string;

beforeAll(async () => {
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout ${dir}/k.pem -out ${dir}/c.pem -days 2 -subj "/CN=payments.example.test" -addext "subjectAltName=DNS:payments.example.test" 2>/dev/null`);
  const cert = readFileSync(`${dir}/c.pem`, 'utf8');
  server = https.createServer({ key: readFileSync(`${dir}/k.pem`), cert }, (req, res) => {
    const ref = decodeURIComponent(/\/cases\/([^/]+)\/payments/.exec(req.url ?? '')?.[1] ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ paid: paid.has(ref) ? paid.get(ref) : '0' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  paymentHttp = { lookup: toLoopback, ca: cert, port: (server.address() as AddressInfo).port };

  env = await (await import('./helpers.js')).setupDb({ cases: { paymentHttp } });
  tenantId = (await must(post('/internal/tenants', { name: 'Cases Co' }))).json().id;
  telnyxId = (await must(post('/internal/providers', { adapterKey: 'telnyx', name: 'tx', params: { apiKey: 'K', webhookUrl: `${BASE}/h`, connectionId: 'c1', webhookPublicKey: 'AAAA' } }))).json().id;
  await must(post(`/internal/providers/${telnyxId}/charging`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1, components: [{ component: 'telephony_leg', unit: 'per_minute', rate: '0.006', currency: 'USD' }] }));
  await must(post('/internal/fx', { currency: 'MYR', perUsd: '4.5', effectiveFrom: '2026-01-01T00:00:00Z' }));
  await must(post('/internal/numbers', { providerId: telnyxId, e164: OUR, tenantId, country: 'MY' }));
  await must(post('/internal/dnc/registries', { country: 'MY', requirement: 'registry', source: 'test' }));
  await must(post('/internal/dnc/numbers', { country: 'MY', numbers: ['+60198765432'] }));
  await must(put(`/internal/tenants/${tenantId}/contact-policy`, { timeZone: KL, quietStart: '21:00', quietEnd: '08:00', maxPerDay: 20, maxPerWeek: 50, minGapMinutes: 0 }));
  await must(post(`/internal/tenants/${tenantId}/integrations`, { name: 'payments', baseUrl: 'https://payments.example.test/v1' }));
  await must(put(`/internal/tenants/${tenantId}/case-settings`, { paymentIntegration: 'payments', paymentPath: '/cases/{ref}/payments' }));
  answerDials();
  const key = parseKey(env.config.VOICELAB_SECRET_KEY);
  calls = { pool: env.pool, key, dncKey: dncKeyFrom(key), http: env.provider.fetch, baseUrl: BASE };
  deps = { calls, paymentHttp, resolveNumber: async (_t, _contactRef, caseRef) => numbers.get(caseRef) ?? null };
  telnyx = await withActor(env.pool, { kind: 'internal' }, (c) => loadProvider(c, telnyxId));
});
afterAll(async () => { server?.closeAllConnections(); await new Promise((r) => server?.close(r)); await env?.teardown(); });

describe('when and how often a contact may be called, for every dial', () => {
  it('refuses a dial inside the contact\'s quiet hours and allows the same dial in the day, without touching the provider', async () => {
    const phone = newPhone(); const before = dials().length;
    const night = await placeOutboundCall(calls, null, { tenantId, to: phone, country: 'MY', timeZone: KL, now: nextLocal('22:00') });
    expect(night).toMatchObject({ allowed: false, reason: 'quiet_hours', status: 'blocked' });
    expect(dials()).toHaveLength(before);
    const day = await placeOutboundCall(calls, null, { tenantId, to: phone, country: 'MY', timeZone: KL, now: nextLocal('10:00') });
    expect(day).toMatchObject({ allowed: true, status: 'dialing' });
    expect(dials()).toHaveLength(before + 1);
  });

  it('holds a contact to the daily limit and the minimum gap, counting only calls that went out', async () => {
    await must(put(`/internal/tenants/${tenantId}/contact-policy`, { timeZone: KL, quietStart: '21:00', quietEnd: '08:00', maxPerDay: 2, maxPerWeek: 50, minGapMinutes: 0 }));
    const phone = newPhone(); const now = nextLocal('10:00');
    for (let i = 0; i < 2; i++) expect(await placeOutboundCall(calls, null, { tenantId, to: phone, country: 'MY', now })).toMatchObject({ allowed: true });
    const third = await placeOutboundCall(calls, null, { tenantId, to: phone, country: 'MY', now });
    expect(third).toMatchObject({ allowed: false, reason: 'contact_limit' });
    await must(put(`/internal/tenants/${tenantId}/contact-policy`, { timeZone: KL, quietStart: '21:00', quietEnd: '08:00', maxPerDay: 20, maxPerWeek: 50, minGapMinutes: 10000 }));
    expect(await placeOutboundCall(calls, null, { tenantId, to: phone, country: 'MY', now })).toMatchObject({ allowed: false, reason: 'contact_limit' });     // two calls just made: inside the gap
    await must(put(`/internal/tenants/${tenantId}/contact-policy`, { timeZone: KL, quietStart: '21:00', quietEnd: '08:00', maxPerDay: 20, maxPerWeek: 50, minGapMinutes: 0 }));
    expect(await placeOutboundCall(calls, null, { tenantId, to: phone, country: 'MY', now })).toMatchObject({ allowed: true });                              // blocked ones did not count
  });

  it('rejects a policy that cannot work', async () => {
    const bad = (b: object) => put(`/internal/tenants/${tenantId}/contact-policy`, b);
    expect((await bad({ timeZone: 'Mars/Olympus' })).statusCode).toBe(400);
    expect((await bad({ timeZone: KL, maxPerDay: 5, maxPerWeek: 3 })).statusCode).toBe(400);
    expect((await bad({ timeZone: KL, quietStart: '25:00' })).statusCode).toBe(400);
  });
});

describe('opening a case', () => {
  it('keeps the client\'s reference and a keyed hash of the number, never the number', async () => {
    const c = await mkCase('open-1', '350');
    const row = (await env.pool.query('SELECT * FROM cases WHERE id = $1', [c.id])).rows[0];
    expect(JSON.stringify(row)).not.toContain(c.phone.slice(1));
    expect(row.contact_hash).toBe(contactHash(c.phone, contactKeyFrom(parseKey(env.config.VOICELAB_SECRET_KEY))));
    expect((await view(c.id))).toMatchObject({ caseRef: 'open-1', status: 'open', balance: '350.00000000', treatment: { level: 0, name: 'friendly' } });
    expect(JSON.stringify(await env.pool.query('SELECT detail FROM case_events'))).not.toContain(c.phone.slice(1));
    expect(JSON.stringify(await env.pool.query('SELECT detail FROM audit_log'))).not.toContain(c.phone.slice(1));
  });
  it('refuses a reference that looks like a phone number, a repeated reference, a bad zone and a bad amount', async () => {
    const open = (b: object) => post(`/internal/tenants/${tenantId}/cases`, { caseRef: 'x', phone: newPhone(), country: 'MY', currency: 'MYR', openingBalance: '10', timeZone: KL, ...b });
    expect((await open({ caseRef: '+60123456789' })).statusCode).toBe(400);
    expect((await open({ contactRef: 'call 012-345 6789' })).statusCode).toBe(400);
    expect((await open({ caseRef: 'open-1' })).statusCode).toBe(409);
    expect((await open({ caseRef: 'z1', timeZone: 'Nowhere/Land' })).statusCode).toBe(400);
    expect((await open({ caseRef: 'z2', openingBalance: '12.5e3' })).statusCode).toBe(400);
    expect((await open({ caseRef: 'z3', phone: '0123456789' })).statusCode).toBe(400);
  });
});

describe('a callback locked to a time', () => {
  it('is refused inside quiet hours, and placed within minutes of exactly its time, once', async () => {
    const c = await mkCase('cb-1'); const T = nextLocal('11:00');
    const quiet = await callbackAt(c.id, nextLocal('23:00'));
    expect(quiet.statusCode).toBe(409); expect(quiet.json().error).toContain('quiet hours');
    expect((await callbackAt(c.id, new Date(Date.now() - 3_600_000))).statusCode).toBe(400);
    await must(callbackAt(c.id, T));
    const before = dials().length;
    expect((await dispatchDue(deps, mins(T, -1))).placed).not.toContain((await actionsOf(c.id))[0]!.id);      // a minute early: nothing
    expect(dials()).toHaveLength(before);
    const out = await dispatchDue(deps, mins(T, 2));
    const [a] = await actionsOf(c.id, 'callback');
    expect(out.placed).toContain(a!.id);
    expect(a).toMatchObject({ status: 'placed' });
    expect(dials()).toHaveLength(before + 1);
    expect(JSON.parse(dials().at(-1)!.body).to).toBe(c.phone);                                                  // the number was used for the dial...
    expect((await env.pool.query('SELECT case_id FROM calls WHERE id = $1', [a!.call_id])).rows[0].case_id).toBe(c.id);
    await dispatchDue(deps, mins(T, 3));
    expect(dials()).toHaveLength(before + 1);                                                                    // ...and the callback is not placed twice
    expect(await eventsOf(c.id)).toEqual(expect.arrayContaining(['callback.scheduled', 'callback.placed']));
    expect(JSON.stringify((await view(c.id)).events)).not.toContain(c.phone.slice(1));
  });

  it('is missed, not made late, when the dispatcher is more than the agreed lateness behind; a retry is scheduled by the rules', async () => {
    const c = await mkCase('cb-late'); const T = nextLocal('11:00');
    await must(callbackAt(c.id, T));
    const before = dials().length; const now = mins(T, 45);
    const out = await dispatchDue(deps, now);
    const [cb] = await actionsOf(c.id, 'callback');
    expect(out.missed).toContain(cb!.id);
    expect(dials()).toHaveLength(before);
    const [retry] = await actionsOf(c.id, 'retry');
    expect(retry).toMatchObject({ status: 'pending', channel: 'voice', attempt: 1 });                           // nobody was dialled, so no retry is used up
    expect(new Date(retry!.scheduled_for).toISOString()).toBe(mins(now, 60).toISOString());                    // the first backoff step is 60 minutes
    expect(await eventsOf(c.id)).toContain('callback.missed');
  });

  it('is placed by one dispatcher only when two run at once', async () => {
    const c = await mkCase('cb-race'); const T = nextLocal('11:00');
    await must(callbackAt(c.id, T));
    const before = dials().length;
    const [a, b] = await Promise.all([dispatchDue(deps, mins(T, 1)), dispatchDue(deps, mins(T, 1))]);
    expect(a.placed.length + b.placed.length).toBeGreaterThanOrEqual(1);
    expect(dials().length - before).toBe(1);
  });

  it('is never repeated when its outcome is unknown, and a do-not-call number is blocked and not retried', async () => {
    const c = await mkCase('cb-unknown'); const T = nextLocal('11:00');
    await must(callbackAt(c.id, T));
    const real = env.provider.state.respond;
    env.provider.state.respond = (url) => { if (url.endsWith('/v2/calls')) throw new Error('socket hang up'); return real(url); };
    const out = await dispatchDue(deps, mins(T, 1));
    env.provider.state.respond = real;
    const [a] = await actionsOf(c.id, 'callback');
    expect(out.unknown).toContain(a!.id);
    expect(a).toMatchObject({ status: 'unknown' });
    const before = dials().length;
    await dispatchDue(deps, mins(T, 90)); await dispatchDue(deps, mins(T, 400));
    expect(dials()).toHaveLength(before);                                                                         // not redialled by any later run
    expect(await actionsOf(c.id, 'retry')).toHaveLength(0);

    const dnc = await mkCase('cb-dnc'); numbers.set('cb-dnc', '+60198765432');
    await env.pool.query(`UPDATE cases SET contact_hash = contact_hash WHERE id = $1`, [dnc.id]);
    await must(callbackAt(dnc.id, T));
    const n = dials().length;
    const o2 = await dispatchDue(deps, mins(T, 1));
    expect(o2.blocked).toHaveLength(1);
    expect(dials()).toHaveLength(n);
    expect(await actionsOf(dnc.id, 'retry')).toHaveLength(0);
  });
});

describe('calls that are not answered', () => {
  it('learn from each attempt, retry by the backoff rules, and move to the next channel after enough failures', async () => {
    const c = await mkCase('retry-1'); const T = nextLocal('11:00');
    await must(callbackAt(c.id, T));
    await dispatchDue(deps, mins(T, 1));
    const [first] = await actionsOf(c.id, 'callback');
    await send(evt('ended', await providerCallIdOf(first!.call_id!), { endReason: 'no_answer', occurredAt: mins(T, 2) }));
    expect((await actionsOf(c.id, 'callback'))[0]).toMatchObject({ status: 'unanswered' });
    const r1 = (await actionsOf(c.id, 'retry'))[0]!;
    expect(r1).toMatchObject({ status: 'pending', channel: 'voice', attempt: 2 });
    const attempts = (await env.pool.query('SELECT local_hour, outcome FROM case_attempts WHERE case_id = $1', [c.id])).rows;
    const startedAt = (await env.pool.query('SELECT started_at FROM calls WHERE id = $1', [first!.call_id])).rows[0].started_at as Date;
    expect(attempts).toEqual([{ local_hour: localParts(startedAt, KL).hour, outcome: 'no_answer' }]);       // by the contact's own clock, when the call really started

    await dispatchDue(deps, mins(new Date(r1.scheduled_for), 1));
    const placed = (await actionsOf(c.id, 'retry')).find((a) => a.status === 'placed')!;
    await send(evt('ended', await providerCallIdOf(placed.call_id!), { endReason: 'no_answer' }));
    const r2 = (await actionsOf(c.id, 'retry')).find((a) => a.attempt === 3)!;
    expect(r2).toMatchObject({ channel: 'whatsapp', status: 'pending' });                                       // two failures in a row: try another channel
    expect(new Date(r2.scheduled_for).getTime()).toBeGreaterThan(Date.now() + 3 * 3_600_000);                    // the second backoff step is 240 minutes
    const before = dials().length;
    await dispatchDue(deps, mins(new Date(r2.scheduled_for), 1));
    expect(dials()).toHaveLength(before);                                                                         // a message is not a call
    expect(((await get(`/internal/tenants/${tenantId}/case-outbox`)).json() as { id: string }[]).some((o) => o.id === r2.id)).toBe(false);   // and it is not handed over before its time
    await env.pool.query(`UPDATE case_actions SET scheduled_for = now() - interval '1 minute' WHERE id = $1`, [r2.id]);                 // time passes: it waits for the client's own sender
    const outbox = (await get(`/internal/tenants/${tenantId}/case-outbox`)).json() as { id: string; channel: string; case_ref: string }[];
    expect(outbox.find((o) => o.id === r2.id)).toMatchObject({ channel: 'whatsapp', case_ref: 'retry-1' });
    await must(post(`/internal/case-actions/${r2.id}/complete`, { note: 'sent' }));
    expect((await actionsOf(c.id, 'retry')).find((a) => a.id === r2.id)).toMatchObject({ status: 'done' });
  });

  it('learns when the person answers, and says when they are easiest to reach', async () => {
    const c = await mkCase('answer-1'); const T = nextLocal('10:00');
    await must(callbackAt(c.id, T));
    await dispatchDue(deps, mins(T, 1));
    const [a] = await actionsOf(c.id, 'callback');
    const pcid = await providerCallIdOf(a!.call_id!);
    await send(evt('answered', pcid)); await send(evt('ended', pcid, { durationSeconds: 60, endReason: 'completed' }));
    expect((await actionsOf(c.id, 'callback'))[0]).toMatchObject({ status: 'done' });
    expect(await actionsOf(c.id, 'retry')).toHaveLength(0);
    const best = (await get(`/internal/cases/${c.id}/best-times`)).json();
    const started = (await env.pool.query('SELECT started_at FROM calls WHERE id = $1', [a!.call_id])).rows[0].started_at as Date;
    expect(best[0]).toMatchObject({ hour: localParts(started, KL).hour, dow: localParts(started, KL).dow, answered: 1, tried: 1 });
    await send(evt('ended', pcid, { endReason: 'completed' }));                                                  // a repeated end changes nothing
    expect((await env.pool.query('SELECT count(*)::int AS n FROM case_attempts WHERE case_id = $1', [c.id])).rows[0].n).toBe(1);
  });

  it('stop at the retry limit and wait for a person, who must say what to do; the case is not called meanwhile', async () => {
    await must(put(`/internal/tenants/${tenantId}/case-settings`, { retryMax: 1 }));
    const c = await mkCase('exhaust-1'); const T = nextLocal('11:00');
    await must(callbackAt(c.id, T));
    let now = mins(T, 1);
    for (let i = 0; i < 2; i++) {
      await dispatchDue(deps, now);
      const placed = (await actionsOf(c.id)).find((x) => x.status === 'placed')!;
      await send(evt('ended', await providerCallIdOf(placed.call_id!), { endReason: 'no_answer' }));
      const next = (await actionsOf(c.id)).find((x) => x.status === 'pending');
      if (next) now = mins(new Date(next.scheduled_for), 1);
    }
    expect(await view(c.id)).toMatchObject({ status: 'decision_required' });
    expect(await eventsOf(c.id)).toEqual(expect.arrayContaining(['retries_exhausted', 'decision_required']));
    const bad = await post(`/internal/cases/${c.id}/decision`, { decision: 'continue', note: '' });
    expect(bad.statusCode).toBe(400);
    const before = dials().length;
    await dispatchDue(deps, mins(now, 5000));
    expect(dials()).toHaveLength(before);
    expect((await must(post(`/internal/cases/${c.id}/decision`, { decision: 'continue', note: 'Try once more by hand.' }))).json()).toMatchObject({ status: 'open' });
    expect((await post(`/internal/cases/${c.id}/decision`, { decision: 'continue', note: 'again' })).statusCode).toBe(409);       // only a case waiting for one
    await must(put(`/internal/tenants/${tenantId}/case-settings`, { retryMax: 3 }));
  });
});

describe('promises to pay, tracked through the client\'s payment system', () => {
  const today = () => localParts(new Date(), KL).date;
  const check = (now = new Date()) => checkPayments(deps, tenantId, now);

  it('keeps a promise that was paid, thanks the person once, recalculates the balance, and never counts a payment twice', async () => {
    const c = await mkCase('pay-kept', '500');
    await must(post(`/internal/cases/${c.id}/promises`, { amount: '200', dueOn: addDays(today(), 3) }));
    const reminder = (await actionsOf(c.id, 'reminder'))[0]!;
    expect(new Date(reminder.scheduled_for).toISOString()).toBe(mins(localToInstant(addDays(today(), 3), '09:00', KL), -24 * 60).toISOString());   // a day before it falls due
    paid.set('pay-kept', '200');
    expect((await check()).kept).toContain(c.id);
    const v = await view(c.id);
    expect(v).toMatchObject({ status: 'open', paidTotal: '200.00000000', balance: '300.00000000' });
    expect(v.promises[0]).toMatchObject({ status: 'kept' });
    expect(v.readBack).toBe('The balance now is 300 MYR.');
    expect(await actionsOf(c.id, 'thanks')).toHaveLength(1);
    await check(); await check();
    expect(await actionsOf(c.id, 'thanks')).toHaveLength(1);
    expect((await view(c.id)).paidTotal).toBe('200.00000000');
  });

  it('records a part payment, recalculates the balance exactly, and passes the case to a person or plan', async () => {
    const c = await mkCase('pay-part', '500.10');
    const due = addDays(today(), 0);
    await must(post(`/internal/cases/${c.id}/promises`, { amount: '200', dueOn: due }));
    paid.set('pay-part', '50.05');
    const zone = process.env.TZ; process.env.TZ = 'Asia/Kuala_Lumpur';                                           // a server east of UTC reads a date column as the day before
    try { expect((await check(localToInstant(addDays(due, 1), '12:00', KL))).partial).toHaveLength(0); }       // inside the grace day: still waiting
    finally { if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone; }
    const out = await check(localToInstant(addDays(due, 3), '12:00', KL));
    expect(out.partial).toContain(c.id);
    expect(await view(c.id)).toMatchObject({ needsHuman: true, balance: '450.05000000', paidTotal: '50.05000000' });
    expect((await view(c.id)).promises[0]).toMatchObject({ status: 'partial' });
    expect((await actionsOf(c.id, 'handoff'))).toHaveLength(1);
    await env.pool.query(`UPDATE case_actions SET scheduled_for = now() - interval '1 minute' WHERE case_id = $1 AND kind = 'handoff'`, [c.id]);
    expect(((await get(`/internal/tenants/${tenantId}/case-outbox`)).json() as { case_ref: string; kind: string }[]).some((o) => o.case_ref === 'pay-part' && o.kind === 'handoff')).toBe(true);
  });

  it('treats a broken promise with a firmer treatment each time, up to the last, and schedules the next call', async () => {
    const c = await mkCase('pay-broken', '500');
    const names: string[] = [];
    for (let i = 0; i < 3; i++) {
      const due = addDays(today(), 0);
      if (i > 0) await env.pool.query(`UPDATE promises SET due_on = due_on WHERE false`);
      await must(post(`/internal/cases/${c.id}/promises`, { amount: '100', dueOn: due }));
      const out = await check(localToInstant(addDays(due, 3), '12:00', KL));
      expect(out.broken).toContain(c.id);
      names.push((await view(c.id)).treatment.name);
    }
    expect(names).toEqual(['firm', 'final', 'final']);
    expect((await actionsOf(c.id, 'callback')).length).toBe(3);
    expect(await eventsOf(c.id)).toContain('promise.broken');
  });

  it('closes a case that is paid in full and cancels what was still to do; a total that falls, or is not an exact string, is not applied', async () => {
    const c = await mkCase('pay-full', '100');
    await must(post(`/internal/cases/${c.id}/promises`, { amount: '100', dueOn: addDays(today(), 2) }));
    paid.set('pay-full', 12.5);                                                                                  // a JSON number, which could be a float: refused
    expect((await check()).failed).toContain(c.id);
    expect(await view(c.id)).toMatchObject({ paidTotal: '0.00000000' });
    expect(await eventsOf(c.id)).toContain('payment_check_failed');
    paid.set('pay-full', '40'); await check();
    paid.set('pay-full', '30'); await check();                                                                   // a total that goes down is ignored
    expect((await view(c.id)).paidTotal).toBe('40.00000000');
    expect(await eventsOf(c.id)).toContain('payment_decreased');
    paid.set('pay-full', '100'); await check();
    const v = await view(c.id);
    expect(v).toMatchObject({ status: 'closed', closeReason: 'paid_in_full', balance: '0.00000000' });
    expect((await actionsOf(c.id)).filter((a) => a.status === 'pending').map((a) => a.kind)).toEqual(['thanks']);          // everything else is cancelled; the thank-you still goes
    expect((await post(`/internal/cases/${c.id}/callbacks`, { at: nextLocal('11:00').toISOString() })).statusCode).toBe(409);
  });

  it('refuses a promise for more than the balance, in the past, or while another is open', async () => {
    const c = await mkCase('pay-rules', '100');
    const promise = (b: object) => post(`/internal/cases/${c.id}/promises`, b);
    expect((await promise({ amount: '150', dueOn: addDays(today(), 2) })).statusCode).toBe(400);
    expect((await promise({ amount: '50', dueOn: addDays(today(), -1) })).statusCode).toBe(400);
    expect((await promise({ amount: '5e1', dueOn: addDays(today(), 2) })).statusCode).toBe(400);
    await must(promise({ amount: '50', dueOn: addDays(today(), 2) }));
    expect((await promise({ amount: '20', dueOn: addDays(today(), 2) })).statusCode).toBe(409);
  });
});

describe('case ageing', () => {
  it('stops an old case being called until a person decides, and the decision restarts its clock', async () => {
    const c = await mkCase('age-1'); const T = nextLocal('11:00');
    await must(callbackAt(c.id, T));
    const later = new Date(Date.now() + 31 * 86_400_000);
    const swept = await withActor(env.pool, { kind: 'internal' }, (x) => sweepAgeing(x, tenantId, later));
    expect(swept.flagged).toContain(c.id);
    expect(await view(c.id)).toMatchObject({ status: 'decision_required' });
    expect((await actionsOf(c.id, 'callback'))[0]).toMatchObject({ status: 'cancelled' });
    const user = (await env.pool.query('SELECT id FROM users LIMIT 1')).rows[0].id as string;
    await withActor(env.pool, { kind: 'internal' }, (x) => decideCase(x, user, c.id, { decision: 'continue', note: 'Customer is in hospital; keep open.' }));
    expect((await withActor(env.pool, { kind: 'internal' }, (x) => sweepAgeing(x, tenantId, new Date(Date.now() + 10 * 86_400_000)))).flagged).not.toContain(c.id);
    expect((await withActor(env.pool, { kind: 'internal' }, (x) => sweepAgeing(x, tenantId, new Date(Date.now() + 31 * 86_400_000)))).flagged).toContain(c.id);
    const close = await post(`/internal/cases/${c.id}/decision`, { decision: 'close', note: 'Written off.' });
    expect(close.json()).toMatchObject({ status: 'closed' });
  });
});

describe('a caller with an open case', () => {
  it('is recognised by the keyed hash of their number, and the call carries on with the case\'s variables', async () => {
    const c = await mkCase('inb-1', '420');
    const flow = { start: 'hello', variables: ['case_balance', 'case_currency', 'case_arrangement'], nodes: {
      hello: { type: 'speak', speech: 'hybrid', text: 'Welcome back. Your balance is {{case_balance}} {{case_currency}}. {{case_arrangement}}', transitions: [{ to: 'done' }] },
      done: { type: 'end', outcome: 'continued' } } };
    const wf = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'case_flow', definition: flow }))).json();
    await must(post(`/internal/workflows/${wf.workflow.id}/deploy`, { versionId: wf.version.id, environment: 'staging' }));
    await must(post(`/internal/cases/${c.id}/promises`, { amount: '100', dueOn: addDays(localParts(new Date(), KL).date, 5) }));

    const pcid = `inb_${randomUUID()}`;
    const inbound = (kind: NormalizedEvent['kind'], from: string) => evt(kind, pcid, { direction: 'inbound', transient: { to: OUR, from } });
    await send(inbound('initiated', c.phone)); await send(inbound('answered', c.phone));
    const call = (await env.pool.query('SELECT id, case_id, contact_hash FROM calls WHERE provider_call_id = $1', [pcid])).rows[0];
    expect(call.case_id).toBe(c.id);
    expect(call.contact_hash).toBe(contactHash(c.phone, contactKeyFrom(parseKey(env.config.VOICELAB_SECRET_KEY))));
    expect(await eventsOf(c.id)).toContain('inbound.recognised');

    const run = (await must(post(`/internal/workflows/${wf.workflow.id}/runs`, { environment: 'staging', kind: 'test', variables: {}, callId: call.id }))).json();
    expect(run.said[0]).toBe(`Welcome back. Your balance is 420 MYR. You have agreed to pay 100 MYR by ${addDays(localParts(new Date(), KL).date, 5)}. The balance now is 420 MYR.`);

    const stranger = `inb_${randomUUID()}`;
    await send(evt('initiated', stranger, { direction: 'inbound', transient: { to: OUR, from: newPhone() } }));
    expect((await env.pool.query('SELECT case_id FROM calls WHERE provider_call_id = $1', [stranger])).rows[0].case_id).toBeNull();
    await must(post(`/internal/cases/${c.id}/close`, { reason: 'settled elsewhere' }));
    const after = `inb_${randomUUID()}`;
    await send(evt('initiated', after, { direction: 'inbound', transient: { to: OUR, from: c.phone } }));
    expect((await env.pool.query('SELECT case_id FROM calls WHERE provider_call_id = $1', [after])).rows[0].case_id).toBeNull();   // a closed case is not continued
  });
});

describe('what stays private and what cannot be rewritten', () => {
  it('never rewrites a case\'s history or its attempts', async () => {
    await expect(env.pool.query(`UPDATE case_events SET kind = 'x'`)).rejects.toThrow(/append-only/);
    await expect(env.pool.query('DELETE FROM case_attempts')).rejects.toThrow(/append-only/);
  });
  it('shows the Control Tower the cases that need a person', async () => {
    const c = await mkCase('alert-1');
    await withActor(env.pool, { kind: 'internal' }, (x) => sweepAgeing(x, tenantId, new Date(Date.now() + 40 * 86_400_000)));
    const alerts = (await get('/internal/control-tower')).json().alerts as { code: string }[];
    expect(alerts.map((a) => a.code)).toContain('cases_decision');
    void c;
  });
});

describe('what the independent review found', () => {
  const setPolicy = (b: object) => must(put(`/internal/tenants/${tenantId}/contact-policy`, { timeZone: KL, quietStart: '21:00', quietEnd: '08:00', maxPerDay: 20, maxPerWeek: 50, minGapMinutes: 0, ...b }));

  it('holds every dial to a contact\'s limits even when they arrive together, or in one dispatcher batch', async () => {
    await setPolicy({ minGapMinutes: 10000 });
    const phone = newPhone(); const now = nextLocal('10:00');
    const out = await Promise.all([0, 1, 2].map(() => placeOutboundCall(calls, null, { tenantId, to: phone, country: 'MY', now })));
    expect(out.filter((o) => o.allowed).length).toBe(1);                                                          // three at once: one goes
    const a = await mkCase('batch-a', '500', {}, newPhone()); const phone2 = numbers.get('batch-a')!;
    const b = await mkCase('batch-b', '500', {}, phone2); const T = nextLocal('11:00');
    await must(callbackAt(a.id, T)); await must(callbackAt(b.id, T));
    const before = dials().length;
    const batch = await dispatchDue(deps, mins(T, 1));
    expect(dials().length - before).toBe(1);                                                                      // two cases, one person: one call
    expect(batch.deferred).toHaveLength(1);
    await setPolicy({});
  });

  it('does not call a case that was closed while its number was being looked up', async () => {
    const c = await mkCase('closing'); const T = nextLocal('11:00');
    await must(callbackAt(c.id, T));
    const closing: CaseDeps = { ...deps, resolveNumber: async (t, r, ref) => { await post(`/internal/cases/${c.id}/close`, { reason: 'paid elsewhere' }); return deps.resolveNumber!(t, r, ref); } };
    const before = dials().length;
    const out = await dispatchDue(closing, mins(T, 1));
    expect(dials()).toHaveLength(before);
    expect(out.cancelled).toHaveLength(1);
    expect((await actionsOf(c.id, 'callback'))[0]).toMatchObject({ status: 'cancelled' });
  });

  it('measures lateness from the time a callback was locked to, however long it was held back', async () => {
    await setPolicy({ minGapMinutes: 10000 });
    const phone = newPhone(); const c = await mkCase('held', '500', {}, phone);
    await placeOutboundCall(calls, null, { tenantId, to: phone, country: 'MY', now: nextLocal('10:00') });          // a call to the same person, which holds a callback back
    const T = nextLocal('11:00'); await must(callbackAt(c.id, T));
    expect((await dispatchDue(deps, mins(T, 1))).deferred).toHaveLength(1);
    const [held] = await actionsOf(c.id, 'callback');
    expect(new Date(held!.scheduled_for).getTime()).toBeGreaterThan(T.getTime() + 24 * 3_600_000);              // held back for days
    const before = dials().length;
    const out = await dispatchDue(deps, mins(new Date(held!.scheduled_for), 1));
    expect(out.missed).toContain(held!.id);                                                                         // days late: missed, not made
    expect(dials()).toHaveLength(before);
    await setPolicy({});
  });

  it('does not lose the outcome of a call the provider reported over before it was recorded', async () => {
    const c = await mkCase('early-end'); const T = nextLocal('11:00');
    await must(callbackAt(c.id, T));
    const real = env.provider.state.respond;
    env.provider.state.respond = async (url) => {
      if (url.endsWith('/v2/calls')) await env.pool.query(`UPDATE calls SET status = 'unanswered', ended_at = now(), end_reason = 'no_answer' WHERE id = (SELECT id FROM calls WHERE tenant_id = $1 AND status = 'dialing' ORDER BY started_at DESC LIMIT 1)`, [tenantId]);
      return real(url);
    };
    try { await dispatchDue(deps, mins(T, 1)); } finally { env.provider.state.respond = real; }
    expect((await actionsOf(c.id, 'callback'))[0]).toMatchObject({ status: 'unanswered' });
    expect((await actionsOf(c.id, 'retry'))).toHaveLength(1);                                                       // the retry chain goes on
    expect((await env.pool.query('SELECT count(*)::int AS n FROM case_attempts WHERE case_id = $1', [c.id])).rows[0].n).toBe(1);
  });

  it('closes a case that has been paid in full even when no promise was made, and counts only what is paid after a promise', async () => {
    const full = await mkCase('rev-full', '100');
    paid.set('rev-full', '100');
    expect((await checkPayments(deps, tenantId)).checked).toBeGreaterThan(0);
    expect(await view(full.id)).toMatchObject({ status: 'closed', closeReason: 'paid_in_full' });
    const c = await mkCase('rev-base', '500');
    paid.set('rev-base', '100');
    await must(post(`/internal/cases/${c.id}/promises`, { amount: '100', dueOn: addDays(localParts(new Date(), KL).date, 3) }));
    expect((await view(c.id)).paidTotal).toBe('100.00000000');                                                      // brought up to date first
    expect((await checkPayments(deps, tenantId)).kept).not.toContain(c.id);                                         // the earlier 100 does not pay the new promise
    paid.set('rev-base', '200');
    expect((await checkPayments(deps, tenantId)).kept).toContain(c.id);
  });

  it('applies quiet hours and limits to the gate API too, in the contact\'s zone', async () => {
    const now = localParts(new Date(), KL); const h = (n: number) => `${String((now.hour + n) % 24).padStart(2, '0')}:00`;
    await setPolicy({ quietStart: h(0), quietEnd: h(1) });                                                          // quiet right now
    const gate = (to: string) => post('/internal/dial/check', { tenantId, country: 'MY', to });
    expect((await gate(newPhone())).json()).toEqual({ allowed: false, reason: 'quiet_hours' });
    await setPolicy({ quietStart: h(2), quietEnd: h(3) });                                                          // quiet later, not now: whatever the time of day the suite runs
    expect((await gate(newPhone())).json()).toEqual({ allowed: true });
    await setPolicy({});
  });

  it('counts only a real failure to reach someone as an alert, not a plain no-answer', async () => {
    const c = await mkCase('quiet-alert'); const T = nextLocal('11:00');
    await must(callbackAt(c.id, T));
    await dispatchDue(deps, mins(T, 1));
    const [a] = await actionsOf(c.id, 'callback');
    await send(evt('ended', await providerCallIdOf(a!.call_id!), { endReason: 'no_answer' }));
    expect((await actionsOf(c.id, 'callback'))[0]).toMatchObject({ status: 'unanswered' });
    const alarming = (await actionsOf(c.id)).filter((x) => x.status === 'missed' || x.status === 'unknown');
    expect(alarming).toHaveLength(0);                                                                               // what the alert counts is missed and unknown, and this is neither
  });

  it('refuses a customer\'s number in a note, a reason or a callback note, and an impossible date', async () => {
    const c = await mkCase('notes');
    expect((await post(`/internal/cases/${c.id}/callbacks`, { at: nextLocal('11:00').toISOString(), note: 'call him on 012-345 6789' })).statusCode).toBe(400);
    expect((await post(`/internal/cases/${c.id}/promises`, { amount: '10', dueOn: '2026-02-31' })).statusCode).toBe(400);
    await env.pool.query(`UPDATE cases SET status = 'decision_required' WHERE id = $1`, [c.id]);
    expect((await post(`/internal/cases/${c.id}/decision`, { decision: 'continue', note: 'try +60123456789 again' })).statusCode).toBe(400);
    expect((await post(`/internal/cases/${c.id}/close`, { reason: 'number is +60123456789' })).statusCode).toBe(400);
    expect(JSON.stringify((await env.pool.query('SELECT detail FROM case_events WHERE case_id = $1', [c.id])).rows)).not.toContain('6789');
  });

  it('hands nothing to the client\'s sender for a case that is waiting on a decision, and sets up the next call after a decision', async () => {
    const c = await mkCase('outbox-gate');
    await env.pool.query(`INSERT INTO case_actions (case_id, kind, channel, scheduled_for, locked_for) VALUES ($1, 'retry', 'whatsapp', now() - interval '1 minute', now() - interval '1 minute')`, [c.id]);
    const listed = async () => ((await get(`/internal/tenants/${tenantId}/case-outbox`)).json() as { case_ref: string }[]).some((o) => o.case_ref === 'outbox-gate');
    expect(await listed()).toBe(true);
    await env.pool.query(`UPDATE cases SET status = 'decision_required' WHERE id = $1`, [c.id]);
    expect(await listed()).toBe(false);
    await must(post(`/internal/cases/${c.id}/decision`, { decision: 'continue', note: 'Carry on.' }));
    expect((await actionsOf(c.id, 'callback')).filter((a) => a.status === 'pending')).toHaveLength(1);              // not left with nothing scheduled
  });
});
