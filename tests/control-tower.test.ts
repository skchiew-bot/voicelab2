import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DECISIONS, PHASES } from '../src/progress.js';

const plan = readFileSync('BUILD_PLAN.md', 'utf8');

describe('the progress view is tied to the plan', () => {
  const planPhases = [...plan.matchAll(/^## Phase (\d+): (.+)$/gm)].map((m) => ({ id: m[1]!, name: m[2]!.trim() }));
  const section = (n: string) => plan.split(new RegExp(`^## Phase ${n}: .*$`, 'm'))[1]!.split(/^## /m)[0]!;
  const criteriaOf = (text: string) => {
    const m = /\*\*Exit criteria[^\n]*\*\*\n((?:- [^\n]+\n?)+)/.exec(text);
    return m ? m[1]!.trim().split('\n').map((l) => l.replace(/^- /, '').trim()) : [];
  };

  it('lists exactly the plan\'s phases, in order, with the plan\'s names', () => {
    expect(PHASES.filter((p) => p.id !== 'CT').map((p) => ({ id: p.id, name: p.name }))).toEqual(planPhases);
  });

  it('uses the plan\'s exit criteria word for word', () => {
    for (const p of PHASES.filter((x) => x.id !== 'CT')) {
      expect(p.criteria.map((c) => c.text), `phase ${p.id}`).toEqual(criteriaOf(section(p.id)));
    }
  });

  it('quotes the Control Tower\'s own criteria from the plan', () => {
    const ct = PHASES.find((p) => p.id === 'CT')!;
    expect(ct.criteria.length).toBeGreaterThan(0);
    for (const c of ct.criteria) expect(plan, c.text).toContain(c.text);
  });

  it('lists exactly the plan\'s open decisions', () => {
    const table = plan.split('## Open Decisions')[1]!.split('## Risks')[0]!;
    const rows = table.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Decision') && !l.startsWith('| ---')).map((l) => l.split('|')[1]!.trim());
    expect(DECISIONS).toEqual(rows);
  });

  it('cannot claim more than it shows: status and evidence must agree with the criteria', () => {
    for (const p of PHASES) {
      const states = p.criteria.map((c) => c.state);
      if (p.status === 'done') expect(states.every((s) => s === 'met') && p.open.length === 0, `${p.id} claims done`).toBe(true);
      if (p.status === 'not_started') expect(states.every((s) => s === 'not_met'), `${p.id} not started but has progress`).toBe(true);
      for (const c of p.criteria) {
        if (c.state === 'met') expect(c.proof, `${p.id}: "${c.text}" is met without proof`).not.toBe('none');
        if (c.state !== 'met') expect(c.note || p.status === 'not_started', `${p.id}: "${c.text}" needs a note saying what is missing`).toBeTruthy();
      }
    }
  });
});

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env;
const st = () => env.staffToken;
const tower = async () => (await env.call(st(), 'GET', '/internal/control-tower')).json();
const alerts = async (about?: string) => (await tower()).alerts.filter((a: { message: string }) => !about || a.message.includes(about));
const codes = async (about?: string) => (await alerts(about)).map((a: { code: string }) => a.code);

async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}
const twilio = async (name: string, extra: Record<string, string> = {}, skip = false) => (await must(env.call(st(), 'POST', '/internal/providers', {
  adapterKey: 'twilio', name, skipValidation: skip, params: { accountSid: 'AC1', authToken: 'tok', twimlAppVoiceUrl: 'https://x.example/v', ...extra },
}))).json();
const telnyx = async (name: string, extra: Record<string, string> = {}) => (await must(env.call(st(), 'POST', '/internal/providers', {
  adapterKey: 'telnyx', name, params: { apiKey: 'k', webhookUrl: 'https://x.example/h', ...extra },
}))).json();

beforeAll(async () => { env = await (await import('./helpers.js')).setupDb(); });
afterAll(async () => { await env?.teardown(); });

describe('what needs attention', () => {
  it('starts with the two things every installation lacks, and nothing about providers that do not exist', async () => {
    expect(await codes()).toEqual(['no_fx_myr', 'no_rate_card']);
    expect((await alerts())[0]).toMatchObject({ severity: 'high', link: '#/rates' });
  });

  it('flags a new provider\'s setup gaps, and each alert goes away when the gap is closed', async () => {
    const tw = await twilio('tw-alerts');
    expect(await codes('tw-alerts')).toEqual([]);                       // checked, nothing in use yet
    expect(await codes()).toContain('no_dnc');                           // a telephony provider exists, no country declared

    const unchecked = await twilio('tw-unchecked', {}, true);
    expect(await codes('tw-unchecked')).toEqual(['credentials_unchecked']);
    await must(env.call(st(), 'POST', `/internal/providers/${unchecked.id}/check`));
    expect(await codes('tw-unchecked')).toEqual([]);

    // Twilio can only verify call events with the Auth Token.
    await must(env.call(st(), 'POST', '/internal/providers', { adapterKey: 'twilio', name: 'tw-keypair',
      params: { accountSid: 'AC2', apiKeySid: 'SK1', apiKeySecret: 's', twimlAppVoiceUrl: 'https://x.example/v' } }));
    expect(await codes('tw-keypair')).toEqual(['webhook_unverifiable']);

    await telnyx('tx-nokey');
    expect(await codes('tx-nokey')).toEqual(['webhook_unverifiable']);
    await telnyx('tx-key', { webhookPublicKey: Buffer.alloc(32, 1).toString('base64') });
    expect(await codes('tx-key')).toEqual([]);

    await must(env.call(st(), 'POST', '/internal/dnc/registries', { country: 'MY', requirement: 'registry', source: 'test' }));
    expect(await codes()).not.toContain('no_dnc');
    void tw;
  });

  it('flags a provider that carries traffic without rates, then rates nobody has confirmed', async () => {
    const tenant = (await must(env.call(st(), 'POST', '/internal/tenants', { name: 'CT Co' }))).json().id;
    const p = await twilio('tw-rates');
    await must(env.call(st(), 'POST', '/internal/numbers', { providerId: p.id, e164: '+60311112222', tenantId: tenant, country: 'MY' }));
    expect((await alerts('tw-rates'))[0]).toMatchObject({ severity: 'high', code: 'no_rates', link: `#/providers/${p.id}` });

    const v = (await must(env.call(st(), 'POST', `/internal/providers/${p.id}/charging/reference`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 60 }))).json();
    expect(await codes('tw-rates')).toEqual(['rates_unconfirmed']);
    await must(env.call(st(), 'POST', `/internal/charging/${v.id}/confirm`, { sourceUrl: 'https://example.com/pricing' }));
    expect(await codes('tw-rates')).toEqual([]);
  });

  it('flags missing FX and rate card until they are added', async () => {
    await must(env.call(st(), 'POST', '/internal/fx', { currency: 'MYR', perUsd: '4.5', effectiveFrom: '2026-01-01T00:00:00Z' }));
    expect(await codes()).not.toContain('no_fx_myr');
    await must(env.call(st(), 'POST', '/internal/rate-card', { effectiveFrom: '2026-01-01T00:00:00Z', inboundCreditsPerMinute: '1', outboundCreditsPerMinute: '2', creditValueUsd: '0.01' }));
    expect(await codes()).not.toContain('no_rate_card');
  });

  it('flags calls that could not be priced or differ from the provider, with counts', async () => {
    const tenant = (await env.pool.query(`SELECT id FROM tenants WHERE name = 'CT Co'`)).rows[0].id;
    const prov = (await env.pool.query(`SELECT id FROM providers WHERE name = 'tw-rates'`)).rows[0].id;
    const mk = (cost_status: string) => env.pool.query(
      `INSERT INTO calls (id, tenant_id, provider_id, direction, status, ended_at, cost_status) VALUES ($1,$2,$3,'outbound','completed', now(), $4)`,
      [randomUUID(), tenant, prov, cost_status]);
    await mk('failed'); await mk('failed'); await mk('variance');
    const a = await alerts();
    expect(a.find((x: { code: string }) => x.code === 'cost_failed').message).toContain('2 calls could not be priced');
    expect(a.find((x: { code: string }) => x.code === 'cost_variance').message).toContain('1 call differs');
    await env.pool.query(`UPDATE calls SET cost_status = 'recorded'`);
    expect(await codes()).not.toContain('cost_failed');
  });

  it('flags a failing provider only once there are enough calls to judge by', async () => {
    const tenant = (await env.pool.query(`SELECT id FROM tenants WHERE name = 'CT Co'`)).rows[0].id;
    const prov = (await env.pool.query(`SELECT id FROM providers WHERE name = 'tx-key'`)).rows[0].id;
    const mk = (status: string) => env.pool.query(
      `INSERT INTO calls (id, tenant_id, provider_id, direction, status, ended_at, cost_status) VALUES ($1,$2,$3,'outbound',$4, now(), 'recorded')`,
      [randomUUID(), tenant, prov, status]);
    for (const s of ['failed', 'failed', 'failed', 'completed']) await mk(s);
    expect(await codes('tx-key')).not.toContain('provider_failing');   // 3 of 4 failed, but 4 calls are too few to judge by
    await mk('completed');
    expect(await codes('tx-key')).toContain('provider_failing');       // 3 of 5 (60%) is enough to say
    for (let i = 0; i < 3; i++) await mk('completed');
    expect(await codes('tx-key')).not.toContain('provider_failing');   // 3 of 8 (37.5%) is below the line again
  });

  it('flags a recorded funding balance that has run out', async () => {
    const prov = (await env.pool.query(`SELECT id FROM providers WHERE name = 'tw-rates'`)).rows[0].id;
    await must(env.call(st(), 'POST', `/internal/providers/${prov}/funding`, { kind: 'topup', amount: '10', currency: 'USD' }));
    expect(await codes('tw-rates')).not.toContain('funding_empty');
    await must(env.call(st(), 'POST', `/internal/providers/${prov}/funding`, { kind: 'usage', amount: '-10', currency: 'USD' }));
    expect(await codes('tw-rates')).toContain('funding_empty');
  });

  it('orders alerts most severe first', async () => {
    const order = { high: 0, medium: 1, low: 2 } as const;
    const sev = (await alerts()).map((a: { severity: keyof typeof order }) => order[a.severity]);
    expect(sev).toEqual([...sev].sort((a, b) => a - b));
  });
});

describe('the live panels', () => {
  it('show active calls, blocked dials, provider health and funding', async () => {
    const tenant = (await env.pool.query(`SELECT id FROM tenants WHERE name = 'CT Co'`)).rows[0].id;
    const prov = (await env.pool.query(`SELECT id FROM providers WHERE name = 'tw-rates'`)).rows[0].id;
    await env.pool.query(`INSERT INTO calls (id, tenant_id, provider_id, direction, status) VALUES ($1,$2,$3,'inbound','in_progress')`, [randomUUID(), tenant, prov]);
    await env.pool.query(`INSERT INTO calls (id, tenant_id, provider_id, direction, status) VALUES ($1,$2,$3,'outbound','blocked')`, [randomUUID(), tenant, prov]);
    const t = await tower();
    expect(t.activeCalls.map((c: { status: string }) => c.status)).toContain('in_progress');
    expect(t.activeCalls.every((c: { status: string }) => ['dialing', 'ringing', 'in_progress'].includes(c.status))).toBe(true);
    expect(t.blocked24h).toBe(1);
    const row = t.providers.find((p: { name: string }) => p.name === 'tw-rates');
    expect(row).toMatchObject({ kind: 'telephony', ratesInForce: true, ratesConfirmed: true });
    expect(row.calls24h.total).toBeGreaterThanOrEqual(1);
    expect(t.funding.find((f: { provider: string }) => f.provider === 'tw-rates')).toMatchObject({ currency: 'USD', entries: 2 });
  });

  it('count each call\'s cost once, including after it is reconciled', async () => {
    const tenant = (await env.pool.query(`SELECT id FROM tenants WHERE name = 'CT Co'`)).rows[0].id;
    const prov = (await env.pool.query(`SELECT id FROM providers WHERE name = 'tw-rates'`)).rows[0].id;
    const call = randomUUID();
    await env.pool.query(
      `INSERT INTO calls (id, tenant_id, provider_id, provider_call_id, direction, status, started_at, ended_at, duration_seconds, cost_status)
       VALUES ($1,$2,$3,'CA_ct','outbound','completed', now() - interval '5 minutes', now() - interval '3 minutes', 61, 'recorded')`, [call, tenant, prov]);
    await must(env.call(st(), 'POST', `/internal/calls/${call}/cost`, {
      tenantId: tenant, direction: 'outbound', occurredAt: new Date(Date.now() - 300_000).toISOString(), usage: [{ providerId: prov, usage: { seconds: 61 } }] }));
    const before = (await tower()).money.last24h;
    expect(before.calls).toBe(1);
    expect(before.cost_usd).toBe('0.02800000');
    await must(env.call(st(), 'POST', `/internal/calls/${call}/reconcile`, { source: 'manual', reportedCost: '0.028' }));
    const after = (await tower()).money.last24h;
    expect(after).toMatchObject({ calls: 1, cost_usd: '0.02800000' });
    expect((await tower()).money.last7d.calls).toBe(1);
  });

  it('are for staff only, and never carry a secret', async () => {
    const user = (await must(env.call(st(), 'POST', `/internal/tenants/${(await env.pool.query(`SELECT id FROM tenants WHERE name = 'CT Co'`)).rows[0].id}/users`, { email: 'c@ct.test', role: 'tenant_admin' }))).json();
    expect((await env.call(user.token, 'GET', '/internal/control-tower')).statusCode).toBe(403);
    expect((await env.call(user.token, 'GET', '/internal/progress')).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: '/internal/control-tower' })).statusCode).toBe(401);
    const body = (await env.call(st(), 'GET', '/internal/control-tower')).body;
    expect(body).not.toContain('tok');
    expect(body).not.toContain('secret_params');
  });

  it('serves the progress data', async () => {
    const p = (await env.call(st(), 'GET', '/internal/progress')).json();
    expect(p.phases).toHaveLength(PHASES.length);
    expect(p.decisions).toEqual(DECISIONS);
  });
});

// ---- findings from the independent review, each reproduced here before it was fixed
describe('calls that never connected', () => {
  it('are not a pricing problem', async () => {
    const e = await (await import('./helpers.js')).setupDb();
    try {
      const st2 = e.staffToken;
      const t = (await e.call(st2, 'POST', '/internal/tenants', { name: 'NC' })).json().id;
      const p = (await e.call(st2, 'POST', '/internal/providers', { adapterKey: 'twilio', name: 'tw-nc', params: { accountSid: 'AC1', authToken: 'x', twimlAppVoiceUrl: 'https://x.example/v' } })).json().id;
      await e.call(st2, 'POST', '/internal/numbers', { providerId: p, e164: '+60311119999', tenantId: t, country: 'MY' });
      await e.call(st2, 'POST', '/internal/dnc/registries', { country: 'MY', requirement: 'registry', source: 'test' });
      e.provider.state.respond = () => new Response('{}', { status: 500 });
      const res = await e.call(st2, 'POST', '/internal/calls/outbound', { tenantId: t, providerId: p, from: '+60311119999', to: '+60187654000', country: 'MY' });
      expect(res.statusCode).toBe(502);
      const codes2 = (await e.call(st2, 'GET', '/internal/control-tower')).json().alerts.map((a: { code: string }) => a.code);
      expect(codes2).not.toContain('cost_failed');
    } finally { await e.teardown(); }
  });
});

describe('an unreadable secret', () => {
  it('is reported as an alert and does not take the whole Control Tower down', async () => {
    const p = await twilio('tw-corrupt');
    await env.pool.query(`UPDATE providers SET secret_params = '\\x0001020304' WHERE id = $1`, [p.id]);
    const res = await env.call(st(), 'GET', '/internal/control-tower');
    expect(res.statusCode).toBe(200);
    const a = res.json().alerts.filter((x: { message: string }) => x.message.includes('tw-corrupt'));
    expect(a.map((x: { code: string }) => x.code)).toContain('secrets_unreadable');
    expect(a.find((x: { code: string }) => x.code === 'secrets_unreadable').severity).toBe('high');
    expect(res.json().providers.length).toBeGreaterThan(3); // the other panels are still there
    await env.pool.query(`UPDATE providers SET status = 'disabled' WHERE id = $1`, [p.id]);
  });
});

describe('calls that are stuck', () => {
  const tenantId = async () => (await env.pool.query(`SELECT id FROM tenants WHERE name = 'CT Co'`)).rows[0].id as string;
  const insert = async (provider: string, status: string, ago: string, extra = '') => env.pool.query(
    `INSERT INTO calls (id, tenant_id, provider_id, direction, status, started_at${extra ? ', ended_at, cost_status' : ''})
     VALUES ($1,$2,$3,'outbound',$4, now() - $5::interval${extra ? ', now() - interval \'20 minutes\', \'pending\'' : ''})`,
    [randomUUID(), await tenantId(), provider, status, ago]);
  const provId = async (name: string) => (await env.pool.query('SELECT id FROM providers WHERE name = $1', [name])).rows[0].id as string;

  it('raise an alert once they have waited too long, and not before', async () => {
    const prov = await provId('tw-rates');
    await env.pool.query(`DELETE FROM calls WHERE status IN ('dialing', 'ringing', 'in_progress')`);
    await insert(prov, 'dialing', '5 minutes');
    await insert(prov, 'in_progress', '2 hours');
    expect(await codes()).not.toContain('calls_stuck');
    await insert(prov, 'dialing', '30 minutes');
    await insert(prov, 'in_progress', '7 hours');
    const a = (await alerts()).find((x: { code: string }) => x.code === 'calls_stuck');
    expect(a.severity).toBe('high');
    expect(a.message).toContain('2 calls');
    expect(a.message).toMatch(/webhook/i);
  });

  it('do not dilute a provider\'s failure rate', async () => {
    const prov = await provId('tx-nokey');
    await env.pool.query('DELETE FROM calls WHERE provider_id = $1', [prov]);
    for (let i = 0; i < 5; i++) await insert(prov, 'failed', '1 hour');
    for (let i = 0; i < 6; i++) await insert(prov, 'dialing', '1 hour');
    expect(await codes('tx-nokey')).toContain('provider_failing'); // 5 of 5 finished calls failed; unfinished ones say nothing
  });

  it('raise an alert when an ended call was never priced', async () => {
    const prov = await provId('tw-rates');
    await insert(prov, 'completed', '1 hour', 'ended');
    expect(await codes()).toContain('cost_pending');
    await env.pool.query(`UPDATE calls SET cost_status = 'recorded' WHERE cost_status = 'pending'`);
    expect(await codes()).not.toContain('cost_pending');
  });

  it('are counted in full even when the list shows only the newest', async () => {
    const prov = await provId('tw-rates');
    await env.pool.query(`DELETE FROM calls WHERE status IN ('dialing', 'ringing', 'in_progress')`);
    for (let i = 0; i < 25; i++) await insert(prov, 'in_progress', '1 minute');
    const t = await tower();
    expect(t.activeCalls).toHaveLength(20);
    expect(t.activeTotal).toBe(25);
    await env.pool.query(`DELETE FROM calls WHERE status IN ('dialing', 'ringing', 'in_progress')`);
  });
});

describe('funding alerts', () => {
  it('ignore a provider that has been disabled', async () => {
    const prov = (await env.pool.query(`SELECT id FROM providers WHERE name = 'tw-rates'`)).rows[0].id;
    expect(await codes('tw-rates')).toContain('funding_empty');
    await env.pool.query(`UPDATE providers SET status = 'disabled' WHERE id = $1`, [prov]);
    expect(await codes('tw-rates')).not.toContain('funding_empty');
    await env.pool.query(`UPDATE providers SET status = 'active' WHERE id = $1`, [prov]);
  });
});

describe('the progress data cannot drift unnoticed', () => {
  it('matches the plan\'s Control Tower criteria exactly', () => {
    const sec = plan.split('### Control Tower Exit Criteria (Overall)')[1]!.split(/^(?:---|## )/m)[0]!;
    const top = sec.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim());
    expect(PHASES.find((p) => p.id === 'CT')!.criteria.map((c) => c.text)).toEqual(top);
  });
  it('includes the criterion that applies to every phase', async () => {
    const { CROSS_CUTTING } = await import('../src/progress.js');
    const m = /\*\*Exit criteria \(every phase\):\*\* ([^\n]+)/.exec(plan)!;
    expect(CROSS_CUTTING.map((c) => c.text)).toEqual([m[1]!.trim()]);
  });
  it('lets nothing be called proven live without saying what the evidence was', () => {
    for (const p of PHASES) for (const c of p.criteria) {
      if (c.proof === 'live') expect(c.note ?? '', `${p.id}: "${c.text}"`).toContain('Live evidence:');
    }
  });
});
