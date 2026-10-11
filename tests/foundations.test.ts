import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db.js';
import { recordEvent } from '../src/store/events.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env;

beforeAll(async () => {
  const { setupDb } = await import('./helpers.js');
  env = await setupDb();
});
afterAll(async () => { await env?.teardown(); });

const twilioParams = {
  accountSid: 'AC123', authToken: 'super-secret-token', twimlAppVoiceUrl: 'https://example.com/voice',
};

async function makeProvider(name: string) {
  const res = await env.call(env.staffToken, 'POST', '/internal/providers', {
    adapterKey: 'twilio', name, params: twilioParams,
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

const charging = (effectiveFrom: string, rate: string) => ({
  effectiveFrom,
  billingIncrementSeconds: 6,
  components: [{ component: 'telephony_leg', unit: 'per_minute', rate, currency: 'USD' }],
});

describe('exit criterion 1: add a provider through the API without a code change', () => {
  it('lists adapters with their parameter declarations for the form', async () => {
    const res = await env.call(env.staffToken, 'GET', '/internal/adapters');
    const adapters = res.json();
    expect(adapters.map((a: { key: string }) => a.key).sort()).toEqual(['elevenlabs', 'openai', 'telnyx', 'twilio']);
    expect(adapters.find((a: { key: string }) => a.key === 'telnyx').params.length).toBeGreaterThan(0);
  });

  it('stores the provider, seeds capabilities, and never returns or stores secrets in clear', async () => {
    const p = await makeProvider('twilio-main');
    expect(p.secrets_stored).toBe(true);
    expect(JSON.stringify(p)).not.toContain('super-secret-token');
    expect(p.capabilities).toHaveLength(8);

    const raw = await env.pool.query('SELECT params, secret_params FROM providers WHERE id = $1', [p.id]);
    expect(JSON.stringify(raw.rows[0].params)).not.toContain('super-secret-token');
    expect(raw.rows[0].secret_params.includes(Buffer.from('super-secret-token'))).toBe(false);
  });

  it('rejects invalid provider settings with readable errors', async () => {
    const res = await env.call(env.staffToken, 'POST', '/internal/providers', {
      adapterKey: 'twilio', name: 'bad', params: { accountSid: 'AC1', twimlAppVoiceUrl: 'https://x.example' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().details)).toContain('Auth Token');
  });

  it('lets an operator reclassify a capability', async () => {
    const p = await makeProvider('twilio-cap');
    const res = await env.call(env.staffToken, 'PUT', `/internal/providers/${p.id}/capabilities/stt`, {
      support: 'composable', notes: 'built from recording + voice provider',
    });
    expect(res.statusCode).toBe(200);
    const after = (await env.call(env.staffToken, 'GET', `/internal/providers/${p.id}`)).json();
    expect(after.capabilities.find((c: { capability: string }) => c.capability === 'stt').support).toBe('composable');
  });
});

describe('exit criterion 2: a rate change creates a new version and old records keep their rate', () => {
  it('adds versions, resolves the rate by date, and refuses edits', async () => {
    const p = await makeProvider('twilio-rates');
    const v1 = await env.call(env.staffToken, 'POST', `/internal/providers/${p.id}/charging`, charging('2026-01-01T00:00:00Z', '0.0140'));
    const v2 = await env.call(env.staffToken, 'POST', `/internal/providers/${p.id}/charging`, charging('2026-07-01T00:00:00Z', '0.0120'));
    expect(v1.json().version).toBe(1);
    expect(v2.json().version).toBe(2);

    const at = async (d: string) =>
      (await env.call(env.staffToken, 'GET', `/internal/providers/${p.id}/charging?at=${d}`)).json();
    expect((await at('2026-03-01T00:00:00Z')).components[0].rate).toBe('0.01400000');
    expect((await at('2026-08-01T00:00:00Z')).components[0].rate).toBe('0.01200000');
    expect(await at('2025-01-01T00:00:00Z')).toBeNull();

    await expect(env.pool.query('UPDATE charging_components SET rate = 1 WHERE charging_version_id = $1', [v1.json().id]))
      .rejects.toThrow(/append-only/);
    await expect(env.pool.query('DELETE FROM charging_versions WHERE id = $1', [v1.json().id]))
      .rejects.toThrow(/append-only/);
  });

  it('refuses a version that is not later than the current one', async () => {
    const p = await makeProvider('twilio-order');
    await env.call(env.staffToken, 'POST', `/internal/providers/${p.id}/charging`, charging('2026-05-01T00:00:00Z', '0.01'));
    const res = await env.call(env.staffToken, 'POST', `/internal/providers/${p.id}/charging`, charging('2026-04-01T00:00:00Z', '0.02'));
    expect(res.statusCode).toBe(409);
  });

  it('starts unconfirmed and records a confirmation without editing the rate', async () => {
    const p = await makeProvider('twilio-confirm');
    const v = (await env.call(env.staffToken, 'POST', `/internal/providers/${p.id}/charging`, charging('2026-01-01T00:00:00Z', '0.01'))).json();
    expect(v.confirmed).toBe(false);
    const done = (await env.call(env.staffToken, 'POST', `/internal/charging/${v.id}/confirm`, { sourceUrl: 'https://www.twilio.com/en-us/voice/pricing' })).json();
    expect(done.confirmed).toBe(true);
    expect(done.components[0].rate).toBe(v.components[0].rate);
  });

  it('handles concurrent rate changes without duplicating a version number', async () => {
    const p = await makeProvider('twilio-race');
    await env.call(env.staffToken, 'POST', `/internal/providers/${p.id}/charging`, charging('2026-01-01T00:00:00Z', '0.01'));
    const results = await Promise.all([
      env.call(env.staffToken, 'POST', `/internal/providers/${p.id}/charging`, charging('2026-02-01T00:00:00Z', '0.02')),
      env.call(env.staffToken, 'POST', `/internal/providers/${p.id}/charging`, charging('2026-03-01T00:00:00Z', '0.03')),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 201]);
    const versions = (await env.call(env.staffToken, 'GET', `/internal/providers/${p.id}/charging`)).json();
    expect(versions.map((v: { version: number }) => v.version)).toEqual([1, 2, 3]);
  });
});

describe('exit criterion 3: a client cannot read internal-ledger data', () => {
  let tenantA: string; let tenantB: string;
  let tokenA: string; let tokenB: string;
  let providerId: string;

  beforeAll(async () => {
    const mk = async (name: string) => (await env.call(env.staffToken, 'POST', '/internal/tenants', { name })).json();
    const a = await mk('Tenant A'); const b = await mk('Tenant B');
    tenantA = a.id; tenantB = b.id;
    const user = async (t: string, email: string) =>
      (await env.call(env.staffToken, 'POST', `/internal/tenants/${t}/users`, { email, role: 'tenant_admin' })).json();
    tokenA = (await user(tenantA, 'a@a.test')).token;
    tokenB = (await user(tenantB, 'b@b.test')).token;

    providerId = (await makeProvider('twilio-ledger')).id;
    await env.call(env.staffToken, 'POST', `/internal/providers/${providerId}/funding`, { kind: 'topup', amount: '500.00', currency: 'usd' });
    await env.call(env.staffToken, 'POST', `/internal/tenants/${tenantA}/credits`, { kind: 'grant', credits: '1000' });
    await env.call(env.staffToken, 'POST', `/internal/tenants/${tenantB}/credits`, { kind: 'grant', credits: '25' });
  });

  it('shows each client only its own credits', async () => {
    expect((await env.call(tokenA, 'GET', '/client/credits')).json().balance).toBe('1000.0000');
    expect((await env.call(tokenB, 'GET', '/client/credits')).json().balance).toBe('25.0000');
  });

  it('keeps provider funding, charging and secrets unreachable from the database role clients run as', async () => {
    const asClient = (sql: string) => withActor(env.pool, { kind: 'client', tenantId: tenantA }, (c) => c.query(sql));
    for (const table of ['provider_funding_entries', 'providers', 'charging_versions', 'charging_components',
      'provider_capabilities', 'call_events', 'users', 'audit_log', 'model_config', 'ai_decisions', 'change_requests', 'tickets', 'qa_scores', 'journey_config', 'fault_acks', 'learning_turns', 'promotions', 'promotion_events', 'learning_config', 'cases', 'case_events', 'case_actions', 'promises', 'case_attempts', 'case_settings', 'contact_policy', 'appointments', 'appointment_events', 'diaries', 'diary_members', 'diary_hours', 'diary_blocks', 'locations', 'notifications', 'cancellation_policy', 'knowledge_articles', 'knowledge_versions', 'policy_levels', 'policy_versions', 'policy_approvals', 'policy_decisions', 'provider_controls', 'dial_pace', 'alert_subscriptions', 'alert_state', 'alert_deliveries', 'scheduled_jobs', 'job_runs']) {
      await expect(asClient(`SELECT * FROM ${table}`), table).rejects.toThrow(/permission denied/);
    }
    await expect(asClient(`INSERT INTO credit_entries (tenant_id, kind, credits) VALUES ('${tenantA}', 'grant', 1)`))
      .rejects.toThrow(/permission denied/);
  });

  it('scopes client reads by tenant even when the query asks for everything', async () => {
    const rows = await withActor(env.pool, { kind: 'client', tenantId: tenantA }, (c) =>
      c.query('SELECT tenant_id FROM credit_entries'));
    expect(rows.rows.every((r) => r.tenant_id === tenantA)).toBe(true);
    expect(rows.rows.length).toBeGreaterThan(0);
  });

  it('returns no rows for a client with no tenant context', async () => {
    const rows = await withActor(env.pool, { kind: 'client', tenantId: '' }, (c) => c.query('SELECT * FROM credit_entries'));
    expect(rows.rows).toHaveLength(0);
  });

  it('refuses client tokens on internal endpoints and no token at all', async () => {
    for (const url of ['/internal/providers', '/internal/tenants', `/internal/providers/${providerId}/funding`]) {
      expect((await env.call(tokenA, 'GET', url)).statusCode, url).toBe(403);
    }
    const res = await env.app.inject({ method: 'GET', url: '/internal/providers' });
    expect(res.statusCode).toBe(401);
    expect((await env.call('nonsense', 'GET', '/client/credits')).statusCode).toBe(401);
  });

  it('keeps the funding ledger readable for staff', async () => {
    const res = await env.call(env.staffToken, 'GET', `/internal/providers/${providerId}/funding`);
    expect(res.json()).toEqual([{ currency: 'USD', balance: '500.00000000' }]);   // kept to the cost record's eight places
  });

  it('keeps both ledgers append-only', async () => {
    await expect(env.pool.query('UPDATE credit_entries SET credits = 9999')).rejects.toThrow(/append-only/);
    await expect(env.pool.query('DELETE FROM provider_funding_entries')).rejects.toThrow(/append-only/);
  });
});

describe('event log and audit', () => {
  it('records and replays events for a call, in order, and is append-only', async () => {
    const tenant = (await env.call(env.staffToken, 'POST', '/internal/tenants', { name: 'Events Co' })).json();
    const project = (await env.call(env.staffToken, 'POST', `/internal/tenants/${tenant.id}/projects`, { name: 'Collections' })).json();
    const callId = randomUUID();
    await withActor(env.pool, { kind: 'internal' }, async (c) => {
      await recordEvent(c, { tenantId: tenant.id, projectId: project.id, callId, type: 'call.started', occurredAt: new Date('2026-10-01T10:00:00Z') });
      await recordEvent(c, { tenantId: tenant.id, projectId: project.id, callId, type: 'call.ended', payload: { by: 'customer' }, occurredAt: new Date('2026-10-01T10:02:00Z') });
      // far-future month falls into the default partition rather than failing
      await recordEvent(c, { tenantId: tenant.id, callId: randomUUID(), type: 'call.started', occurredAt: new Date('2031-01-01T00:00:00Z') });
    });
    const events = (await env.call(env.staffToken, 'GET', `/internal/calls/${callId}/events`)).json();
    expect(events.map((e: { type: string }) => e.type)).toEqual(['call.started', 'call.ended']);
    await expect(env.pool.query('UPDATE call_events SET type = $1', ['x'])).rejects.toThrow(/append-only/);
  });

  it('audits provider creation without logging secret values', async () => {
    await makeProvider('twilio-audit');
    const rows = await env.pool.query(`SELECT detail FROM audit_log WHERE action = 'provider.create'`);
    expect(rows.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows.rows)).not.toContain('super-secret-token');
  });

  it('reports health with the migration count', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ ok: true, migrations: readdirSync('migrations').filter((f) => f.endsWith('.sql')).length });
  });
});
