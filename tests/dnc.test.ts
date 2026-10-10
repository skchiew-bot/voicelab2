import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeE164 } from '../src/store/dnc.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantA: string; let tenantB: string;

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  const mk = async (name: string) => (await env.call(env.staffToken, 'POST', '/internal/tenants', { name })).json().id;
  tenantA = await mk('DNC A'); tenantB = await mk('DNC B');
});
afterAll(async () => { await env?.teardown(); });

const st = () => env.staffToken;
const declare = (country: string, requirement: 'registry' | 'none_required', source = 'test') =>
  env.call(st(), 'POST', '/internal/dnc/registries', { country, requirement, source });
const load = (body: object) => env.call(st(), 'POST', '/internal/dnc/numbers', body);
const check = async (tenantId: string, country: string, to: string) =>
  (await env.call(st(), 'POST', '/internal/dial/check', { tenantId, country, to })).json();

describe('number format', () => {
  it('accepts international numbers however they are punctuated, and nothing else', () => {
    expect(normalizeE164('+60 12-345 6789')).toBe('+60123456789');
    expect(normalizeE164('+1 (415) 555-0100')).toBe('+14155550100');
    for (const bad of ['0123456789', '60123456789', '+0123456789', '+6012', 'abc', '', '+60123456789012345']) {
      expect(normalizeE164(bad), bad).toBeNull();
    }
  });
});

describe('the pre-dial gate fails closed', () => {
  it('blocks a country nobody has declared a position on', async () => {
    expect(await check(tenantA, 'MY', '+60123456789')).toEqual({ allowed: false, reason: 'no_registry_declared' });
  });

  it('blocks a number it cannot parse, even where dialling is otherwise allowed', async () => {
    await declare('SG', 'none_required', 'No national registry; acknowledged by ops');
    expect(await check(tenantA, 'SG', '65 1234 5678')).toEqual({ allowed: false, reason: 'invalid_number' });
    expect(await check(tenantA, 'SG', '+6591234567')).toEqual({ allowed: true });
  });
});

describe('national registry', () => {
  beforeAll(async () => { expect((await declare('MY', 'registry', 'Registry file 2026-10')).statusCode).toBe(201); });

  it('blocks a registered number in any format and lets others through', async () => {
    const res = await load({ country: 'my', numbers: ['+60 12-345 6789', '+60 19 888 7777'], source: 'file' });
    expect(res.json()).toEqual({ added: 2, duplicates: 0, invalid: [] });

    for (const to of ['+60123456789', '+60 12 345 6789', '+60-12-3456789']) {
      expect(await check(tenantA, 'MY', to), to).toEqual({ allowed: false, reason: 'on_national_registry' });
    }
    expect(await check(tenantB, 'MY', '+60198887777')).toEqual({ allowed: false, reason: 'on_national_registry' });
    expect(await check(tenantA, 'MY', '+60111111111')).toEqual({ allowed: true });
  });

  it('is country-specific: the same digits in another country are not blocked by it', async () => {
    await declare('ID', 'registry', 'x');
    expect(await check(tenantA, 'ID', '+60123456789')).toEqual({ allowed: true });
  });

  it('reports duplicates and unparseable numbers instead of silently skipping them', async () => {
    const res = await load({ country: 'MY', numbers: ['+60123456789', 'nope', '+60177776666'] });
    expect(res.json()).toEqual({ added: 1, duplicates: 1, invalid: ['nope'] });
  });

  it('lets a number come off the list, which takes effect straight away', async () => {
    await load({ country: 'MY', numbers: ['+60155550000'] });
    expect((await check(tenantA, 'MY', '+60155550000')).allowed).toBe(false);
    const gone = await env.call(st(), 'POST', '/internal/dnc/numbers/remove', { country: 'MY', number: '+60 15 555 0000' });
    expect(gone.json()).toEqual({ removed: 1 });
    expect((await check(tenantA, 'MY', '+60155550000')).allowed).toBe(true);
  });
});

describe("a client's own opt-out list", () => {
  it('blocks that client only', async () => {
    await declare('PH', 'none_required', 'no registry');
    await load({ country: 'PH', tenantId: tenantA, numbers: ['+639171234567'] });
    expect(await check(tenantA, 'PH', '+639171234567')).toEqual({ allowed: false, reason: 'on_client_list' });
    expect(await check(tenantB, 'PH', '+639171234567')).toEqual({ allowed: true });
  });

  it('cannot load national numbers for a country declared as having no registry', async () => {
    const res = await load({ country: 'PH', numbers: ['+639170000000'] });
    expect(res.statusCode).toBe(400);
  });

  it('cannot load numbers for an undeclared country', async () => {
    expect((await load({ country: 'ZZ', numbers: ['+60123456789'] })).statusCode).toBe(400);
  });
});

describe('every real dial goes through the gate and leaves a trace without the number', () => {
  it('records dial.blocked with the reason, and dial.allowed otherwise', async () => {
    const blocked = randomUUID(); const allowed = randomUUID();
    const gate = (callId: string, to: string) =>
      env.call(st(), 'POST', '/internal/dial/gate', { tenantId: tenantA, callId, country: 'MY', to });
    expect((await gate(blocked, '+60123456789')).json()).toEqual({ allowed: false, reason: 'on_national_registry' });
    expect((await gate(allowed, '+60122223333')).json()).toEqual({ allowed: true });

    const ev = async (id: string) => (await env.call(st(), 'GET', `/internal/calls/${id}/events`)).json();
    const b = await ev(blocked); const a = await ev(allowed);
    expect(b.map((e: { type: string }) => e.type)).toEqual(['dial.blocked']);
    expect(b[0].payload).toEqual({ country: 'MY', reason: 'on_national_registry' });
    expect(a.map((e: { type: string }) => e.type)).toEqual(['dial.allowed']);
    // The numbers themselves, in any form; not a fragment like "6012", which a timestamp's microseconds can contain.
    expect(JSON.stringify([...a, ...b])).not.toMatch(/60123456789|60122223333|0123456789|0122223333|123456789|122223333/);
  });

  it('never stores a phone number in clear', async () => {
    const dump = await env.pool.query(`SELECT row_to_json(d)::text AS t FROM dnc_entries d`);
    expect(dump.rowCount).toBeGreaterThan(3);
    const all = dump.rows.map((r) => r.t).join('\n');
    expect(all).not.toMatch(/60123456789|123456789|0123456/);
    const audit = JSON.stringify((await env.pool.query('SELECT detail FROM audit_log')).rows);
    expect(audit).not.toMatch(/60123456789|639171234567/);
  });
});

describe('access', () => {
  it('is for staff only', async () => {
    const user = (await env.call(st(), 'POST', `/internal/tenants/${tenantA}/users`, { email: 'x@a.test', role: 'tenant_admin' })).json();
    const body = { tenantId: tenantA, country: 'MY', to: '+60123456789' };
    for (const url of ['/internal/dial/check', '/internal/dial/gate', '/internal/dnc/numbers']) {
      expect((await env.call(user.token, 'POST', url, body)).statusCode, url).toBe(403);
    }
  });
});
