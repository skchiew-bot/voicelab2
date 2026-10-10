import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db.js';
import { categoryOf } from '../src/store/change-log.js';
import { createUser } from '../src/store/tenants.js';
import { percent, runwayDays } from '../src/store/panels.js';

describe('the sums behind the panels', () => {
  it('gives a share in exact hundredths, and no share of nothing', () => {
    expect(percent(1, 3)).toBe('33.33');
    expect(percent(2, 3)).toBe('66.67');
    expect(percent(5, 5)).toBe('100.00');
    expect(percent(0, 0)).toBeNull();
  });
  it('works out days of funding left exactly, rounded down, and says nothing when there was no spend', () => {
    expect(runwayDays('10', '0.028', 7)).toBe('2500.0');                 // 10 ÷ (0.028 ÷ 7) = 2500
    expect(runwayDays('1', '3', 7)).toBe('2.3');                         // 7 ÷ 3 = 2.33…, rounded down
    expect(runwayDays('0', '1', 7)).toBe('0.0');
    expect(runwayDays('-5', '1', 7)).toBe('0.0');
    expect(runwayDays('10', '0', 7)).toBeNull();                         // unknown, not "forever" and not zero
  });
  it('sorts actions into kinds, and keeps the day-to-day out of the changes', () => {
    expect(categoryOf('workflow.deploy')).toBe('workflows');
    expect(categoryOf('policy.activate')).toBe('policy');
    expect(categoryOf('funding.add')).toBe('money');
    expect(categoryOf('call.outbound')).toBe('activity');
    expect(categoryOf('workflow.run')).toBe('activity');                 // not "workflows": running one changes nothing
    expect(categoryOf('something.new')).toBe('activity');
  });
});

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let providerId: string;
const st = () => env.staffToken;
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}
const log = async (q = '') => (await must(env.call(st(), 'GET', `/internal/change-log${q}`))).json() as { entries: { id: number; action: string; who: string; why: string | null; category: string; link: string | null }[]; next: number | null };
const panels = async () => (await must(env.call(st(), 'GET', '/internal/control-tower/panels'))).json();

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  tenantId = (await must(env.call(st(), 'POST', '/internal/tenants', { name: 'Panel Co' }))).json().id;
  providerId = (await must(env.call(st(), 'POST', '/internal/providers', { adapterKey: 'twilio', name: 'tw-panel',
    params: { accountSid: 'AC1', authToken: 'tok', twimlAppVoiceUrl: 'https://x.example/v' } }))).json().id;
  const v = (await must(env.call(st(), 'POST', `/internal/providers/${providerId}/charging/reference`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 60 }))).json();
  await must(env.call(st(), 'POST', `/internal/charging/${v.id}/confirm`, { sourceUrl: 'https://example.com/pricing' }));
  await must(env.call(st(), 'POST', '/internal/fx', { currency: 'MYR', perUsd: '4.5', effectiveFrom: '2026-01-01T00:00:00Z' }));
});
afterAll(async () => { await env?.teardown(); });

describe('the change log', () => {
  it('shows who made each change, newest first, and the day-to-day only when asked for', async () => {
    await env.pool.query(`INSERT INTO audit_log (actor_id, action, entity, entity_id, detail) VALUES (NULL, 'call.outbound', 'call', $1, '{}')`, [randomUUID()]);
    const all = await log();
    expect(all.entries.slice(-1)).toEqual([expect.objectContaining({ action: 'user.create', who: 'the system' })]);     // the staff account, made at install
    expect(all.entries.find((e) => e.action === 'tenant.create')).toMatchObject({ who: 'staff@daythree.test', category: 'people' });
    expect(all.entries.map((e) => e.action)).not.toContain('call.outbound');
    const ids = all.entries.map((e) => e.id); expect(ids).toEqual([...ids].sort((a, b) => b - a));
    const activity = await log('?category=activity');
    expect(activity.entries).toEqual([expect.objectContaining({ action: 'call.outbound', who: 'the system', category: 'activity' })]);
    expect((await log('?category=money')).entries.map((e) => e.action).sort()).toEqual(['charging.add_version', 'charging.confirm', 'fx.add']);
  });

  it('says why, from the record the change made, and scrubs any number from it', async () => {
    const mk = async (email: string) => (await withActor(env.pool, { kind: 'internal' }, (c) => createUser(c, null, { tenantId: null, email, role: 'internal_admin' }))).token;
    const b = await mk('cl-b@daythree.test'); const c = await mk('cl-c@daythree.test'); const d = await mk('cl-d@daythree.test');
    await must(env.call(st(), 'PUT', `/internal/tenants/${tenantId}/policy/levels`, { levels: ['Owner', 'Compliance'] }));
    const p = (await must(env.call(st(), 'POST', `/internal/tenants/${tenantId}/policy/proposals`, { rules: [{ id: 'r', kind: 'must_not_say', phrases: ['we will sue'] }], summary: 'Stop threats on calls.' }))).json();
    await must(env.call(b, 'POST', `/internal/policy-versions/${p.id}/decision`, { decision: 'approved', note: 'Reads right.' }));
    await must(env.call(c, 'POST', `/internal/policy-versions/${p.id}/decision`, { decision: 'approved', note: 'Second look done.' }));
    await must(env.call(d, 'POST', `/internal/policy-versions/${p.id}/withdraw`, { note: 'Waiting for legal.' }));
    const pol = (await log('?category=policy')).entries;
    expect(pol.map((e) => [e.action, e.who, e.why])).toEqual([
      ['policy.withdraw', 'cl-d@daythree.test', 'Waiting for legal.'],
      ['policy.decide', 'cl-c@daythree.test', 'Second look done.'],                  // each approver's own note, not the other's
      ['policy.decide', 'cl-b@daythree.test', 'Reads right.'],
      ['policy.propose', 'staff@daythree.test', 'Stop threats on calls.'],
      ['policy.levels', 'staff@daythree.test', null],                                  // no reason was given, and none is made up
    ]);
    expect(pol[0]!.link).toBe('#/knowledge');
    await env.pool.query(`INSERT INTO audit_log (actor_id, action, entity, entity_id, detail) VALUES (NULL, 'dnc.add', 'dnc', NULL, $1)`, [{ reason: 'asked by +60 12-345 6789 to stop' }]);
    expect((await log('?category=compliance')).entries[0]!.why).toBe('asked by [number] to stop');
  });

  it('pages back through older changes without repeating or skipping any', async () => {
    const whole = (await log('?limit=200')).entries.map((e) => e.id);
    const seen: number[] = []; let before: number | null = null;
    do { const page = await log(`?limit=2${before ? `&before=${before}` : ''}`); seen.push(...page.entries.map((e) => e.id)); before = page.next; } while (before !== null);
    expect(seen).toEqual(whole);
  });

  it('is for staff only, and refuses a filter it does not know', async () => {
    const user = (await must(env.call(st(), 'POST', `/internal/tenants/${tenantId}/users`, { email: 'client@panel.test', role: 'tenant_admin' }))).json();
    expect((await env.call(user.token, 'GET', '/internal/change-log')).statusCode).toBe(403);
    expect((await env.call(user.token, 'GET', '/internal/control-tower/panels')).statusCode).toBe(403);
    expect((await env.call(st(), 'GET', '/internal/change-log?category=nonsense')).statusCode).toBe(400);
    expect((await env.call(st(), 'GET', '/internal/change-log?limit=100000')).statusCode).toBe(400);
  });
});

describe('the panels', () => {
  it('give funding runway from the recorded balance and the last week\'s spend, exactly, counting a reconciled call once', async () => {
    await must(env.call(st(), 'POST', `/internal/providers/${providerId}/funding`, { kind: 'topup', amount: '10', currency: 'USD' }));
    expect((await panels()).funding).toEqual([expect.objectContaining({ provider: 'tw-panel', currency: 'USD', balance: '10.00000000', spent7d: '0', runwayDays: null })]);
    const call = randomUUID();
    await env.pool.query(
      `INSERT INTO calls (id, tenant_id, provider_id, provider_call_id, direction, status, started_at, ended_at, duration_seconds, cost_status)
       VALUES ($1,$2,$3,'CA_panel','outbound','completed', now() - interval '5 minutes', now() - interval '3 minutes', 61, 'recorded')`, [call, tenantId, providerId]);
    await must(env.call(st(), 'POST', `/internal/calls/${call}/cost`, { tenantId, direction: 'outbound', occurredAt: new Date(Date.now() - 300_000).toISOString(), usage: [{ providerId, usage: { seconds: 61 } }] }));
    await must(env.call(st(), 'POST', `/internal/calls/${call}/reconcile`, { source: 'manual', reportedCost: '0.028' }));
    // 61 seconds billed as two minutes at 0.014 = 0.028; 0.028 over 7 days is 0.004 a day; 10 ÷ 0.004 = 2500 days.
    expect((await panels()).funding[0]).toMatchObject({ spent7d: '0.02800000', perDay: '0.00400000', runwayDays: '2500.0' });
  });

  it('show how much speech came from recordings, from real and test calls only', async () => {
    const wf = (await must(env.call(st(), 'POST', `/internal/tenants/${tenantId}/workflows`, { name: 'panel_flow', definition: { start: 'a', nodes: { a: { type: 'end', outcome: 'ok' } } } }))).json();
    const run = async (kind: string, synth: number, recorded: number, sentiment?: number) => {
      const id = randomUUID();
      await env.pool.query(`INSERT INTO workflow_runs (id, tenant_id, workflow_id, version_id, environment, kind, pins, state, status) VALUES ($1,$2,$3,$4,'staging',$5,'{}','{}','ended')`, [id, tenantId, wf.workflow.id, wf.version.id, kind]);
      await env.pool.query(`INSERT INTO workflow_run_steps (run_id, seq, type, workflow, node, payload) VALUES ($1,1,'say','panel_flow','a',$2)`, [id, { synthChars: synth, recordedChars: recorded }]);
      if (sentiment !== undefined) await env.pool.query(`INSERT INTO workflow_run_steps (run_id, seq, type, workflow, node, payload) VALUES ($1,2,'heard','panel_flow','a',$2)`, [id, { text: 'x', analysis: { kind: 'answer', topic: null, sentiment, severe: sentiment <= -0.6, understood: true } }]);
    };
    await run('live', 100, 300, 0.5); await run('test', 100, 0, -0.7); await run('simulation', 0, 9999);
    const p = await panels();
    expect(p.stitching).toMatchObject({ synthChars: 200, recordedChars: 300, recordedPercent: '60.00' });
    expect(p.stitching.workflows).toEqual([expect.objectContaining({ workflow: 'panel_flow', tenant: 'Panel Co', recordedPercent: '60.00' })]);
    const today = new Date().toISOString().slice(0, 10);
    expect(p.journeyQa.sentiment).toEqual([{ day: today, turns: 2, average: '-0.10', severe: 1 }]);
    expect(p.journeyQa.qa).toMatchObject({ scored: 0, average: null });                // nothing scored is not a score of 0
  });

  it('count only dials that really went out, and show each provider against its ceiling', async () => {
    const ins = (status: string, extra = '') => env.pool.query(`INSERT INTO calls (id, tenant_id, provider_id, direction, status${extra ? ', answered_at' : ''}) VALUES ($1,$2,$3,'outbound',$4${extra ? ', now()' : ''})`, [randomUUID(), tenantId, providerId, status]);
    await ins('blocked'); await ins('completed', 'answered'); await ins('unanswered'); await ins('in_progress', 'answered');
    const p = await panels();
    expect(p.deliverability).toMatchObject({ dialled: 4, answered: 2, answerPercent: '50.00', contactPercent: '0.00' });   // the earlier priced call is one of the four; the blocked one is not
    expect(p.concurrency.providers).toEqual([expect.objectContaining({ provider: 'tw-panel', active: 1 })]);
    expect(p.modules.cases).toMatchObject({ open: 0, brokenPromises7d: 0 });
    expect(p.unavailable).toEqual([]);
  });

  it('names a funding balance in an alert to the last decimal place, never through a floating-point number', async () => {
    const id = (await must(env.call(st(), 'POST', '/internal/providers', { adapterKey: 'twilio', name: 'tw-exact', params: { accountSid: 'AC3', authToken: 'tok', twimlAppVoiceUrl: 'https://x.example/v' } }))).json().id;
    for (let i = 0; i < 2; i++) await must(env.call(st(), 'POST', `/internal/providers/${id}/funding`, { kind: 'usage', amount: '-9999999999.999999', currency: 'USD' }));
    const alert = (await must(env.call(st(), 'GET', '/internal/control-tower'))).json().alerts.find((a: { code: string; message: string }) => a.code === 'funding_empty' && a.message.includes('tw-exact'));
    expect(alert.message).toContain('-19999999999.99999800 USD');          // as a JavaScript number this would read -19999999999.999996
  });

  it('show every other panel when one cannot be worked out', async () => {
    await env.pool.query('ALTER TABLE outbound_outcomes RENAME TO outbound_outcomes_away');
    try {
      const p = await panels();
      expect(p.unavailable).toEqual(['deliverability']); expect(p.deliverability).toBeNull();
      expect(p.funding.find((f: { provider: string }) => f.provider === 'tw-panel')).toMatchObject({ runwayDays: '2500.0' }); expect(p.stitching.recordedPercent).toBe('60.00');
    } finally { await env.pool.query('ALTER TABLE outbound_outcomes_away RENAME TO outbound_outcomes'); }
  });
});
