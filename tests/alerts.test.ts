import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db.js';
import { parseKey } from '../src/secrets.js';
import { alertKey, composeEmail, MailRefused, sweepAlerts, wants, type Mailer } from '../src/store/alerts.js';
import { controlTower } from '../src/store/control-tower.js';
import { createUser } from '../src/store/tenants.js';

describe('choosing and writing alert emails', () => {
  it('keys an alert by what it is about, not its changing count', () => {
    expect(alertKey({ code: 'calls_stuck', link: '#/calls' })).toBe(alertKey({ code: 'calls_stuck', link: '#/calls' }));
    expect(alertKey({ code: 'provider_failing', link: '#/providers/a' })).not.toBe(alertKey({ code: 'provider_failing', link: '#/providers/b' }));
    expect(alertKey({ code: 'funding_low', link: '#/providers/a', scope: 'USD' })).not.toBe(alertKey({ code: 'funding_low', link: '#/providers/a', scope: 'MYR' }));
  });
  it('sends a subscriber what is at least as severe as they asked for, and only the kinds they chose', () => {
    expect(wants({ min_severity: 'medium', codes: null }, { code: 'x', severity: 'high' })).toBe(true);
    expect(wants({ min_severity: 'medium', codes: null }, { code: 'x', severity: 'low' })).toBe(false);
    expect(wants({ min_severity: 'low', codes: ['system_drop'] }, { code: 'calls_stuck', severity: 'high' })).toBe(false);
  });
  it('writes one email, most severe first, with links into the console', () => {
    const m = composeEmail([{ severity: 'medium', message: 'B', link: '#/rates' }, { severity: 'high', message: 'A', link: '#/calls' }], 'https://voice.example.my/');
    expect(m.subject).toBe('[Voice Lab] 2 new alerts (1 high)');
    expect(m.text.split('\n').slice(0, 4)).toEqual(['HIGH: A', '  https://voice.example.my/admin/#/calls', 'MEDIUM: B', '  https://voice.example.my/admin/#/rates']);
    expect(composeEmail([{ severity: 'low', message: 'C' }]).text.split('\n')).toEqual(['LOW: C', '', 'See every alert on the Control Tower.', 'You get this because you are subscribed to Voice Lab alerts.']);
  });
});

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let alice: { id: string; token: string }; let bob: { id: string; token: string }; let twilioId: string;
const sent: { to: string; subject: string; text: string }[] = [];
let mode: 'ok' | 'refuse' | 'timeout' = 'ok'; let slow = 0;
// Failures are aimed at the drain alert the tests toggle, so other alerts still open from earlier steps go through.
const mailer: Mailer = { async send(m) { if (slow) await new Promise((r) => setTimeout(r, slow)); const aimed = m.text.includes('is drained') || m.subject.includes('Test'); if (aimed && mode === 'refuse') throw new MailRefused('550'); if (aimed && mode === 'timeout') throw new Error('timed out'); sent.push(m); } };
const drained = () => sent.filter((m) => m.text.includes('is drained'));
const st = () => env.staffToken;
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}
// The sweep on a clock the test moves, so "gone for a while" is exact.
let clock = Date.now();
const later = (minutes: number) => { clock += minutes * 60_000; };
const deps = (withMail = true) => ({ pool: env.pool, key: parseKey(env.config.VOICELAB_SECRET_KEY), publicBaseUrl: env.config.PUBLIC_BASE_URL, mailer: withMail ? mailer : undefined });
const sweep = (withMail = true) => sweepAlerts(deps(withMail), new Date(clock));
const act = (b: object) => must(env.call(st(), 'POST', '/internal/control-tower/actions', b));
const deliveries = async () => (await must(env.call(st(), 'GET', '/internal/alerts/deliveries'))).json() as { email: string; kind: string; status: string; alertKey: string; episode: number }[];
const staff = async (email: string) => withActor(env.pool, { kind: 'internal' }, (c) => createUser(c, null, { tenantId: null, email, role: 'internal_admin' }));
const subscribe = (userId: string, minSeverity: string) => must(env.call(st(), 'PUT', '/internal/alerts/subscriptions', { userId, minSeverity }));
const drain = () => act({ action: 'drain', providerId: twilioId, reason: 'Testing alerts.' });
const restore = () => act({ action: 'restore', providerId: twilioId, reason: 'Done testing.' });
const settle = async () => { await restore(); later(31); await sweep(); };

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb({ mailer });
  alice = await staff('alice@daythree.test'); bob = await staff('bob@daythree.test');
  twilioId = (await must(env.call(st(), 'POST', '/internal/providers', { adapterKey: 'twilio', name: 'tw', params: { accountSid: 'AC1', authToken: 'tok', twimlAppVoiceUrl: 'https://x.example/v' } }))).json().id;
});
afterAll(async () => { await env?.teardown(); });

describe('alerts by email', () => {
  it('only staff can be subscribed, and only an admin can subscribe them', async () => {
    const t = (await must(env.call(st(), 'POST', '/internal/tenants', { name: 'Mail Co' }))).json().id;
    const client = (await must(env.call(st(), 'POST', `/internal/tenants/${t}/users`, { email: 'client@mail.test', role: 'tenant_admin' }))).json();
    const r = await env.call(st(), 'PUT', '/internal/alerts/subscriptions', { userId: client.id, minSeverity: 'low' });
    expect(r.statusCode).toBe(400); expect(r.json().error).toContain('Only Daythree staff');
    for (const [m, u] of [['PUT', '/internal/alerts/subscriptions'], ['GET', '/internal/alerts/subscriptions'], ['GET', '/internal/alerts/deliveries'], ['POST', '/internal/alerts/sweep']] as const) {
      expect((await env.call(client.token, m, u, m === 'PUT' ? { userId: client.id, minSeverity: 'low' } : undefined)).statusCode).toBe(403);
    }
  });

  it('with no mail service, sends and claims nothing, then sends every open alert once one is connected', async () => {
    await subscribe(alice.id, 'medium'); await subscribe(bob.id, 'high');
    const off = await sweep(false);
    const open = (await withActor(env.pool, { kind: 'internal' }, (c) => controlTower(c, parseKey(env.config.VOICELAB_SECRET_KEY), { publicBaseUrlSet: true, mailConnected: false }))).alerts
      .filter((a) => a.code !== 'email_not_connected');
    const high = open.filter((a) => a.severity === 'high').length; const medium = open.filter((a) => a.severity === 'medium').length;
    expect(high).toBeGreaterThan(0); expect(medium).toBeGreaterThan(0);
    // Alice wants high and medium, Bob high only: every one of those is waiting, none was claimed.
    expect(off).toMatchObject({ sent: 0, notSent: (high + medium + 1) + high, mailConnected: false });   // + 1: "no mail service" is itself a medium alert
    expect(await deliveries()).toEqual([]);
    const t = await withActor(env.pool, { kind: 'internal' }, (c) => controlTower(c, parseKey(env.config.VOICELAB_SECRET_KEY), { publicBaseUrlSet: true, mailConnected: false }));
    expect(t.alerts.find((a) => a.code === 'email_not_connected')?.message).toBe('2 people are subscribed to alerts by email, but no mail service is connected, so no email is being sent.');
    later(1);
    expect(await sweep()).toMatchObject({ sent: 2, failed: 0, unknown: 0, notSent: 0, mailConnected: true });
    const toAlice = sent.find((m) => m.to === 'alice@daythree.test')!; const toBob = sent.find((m) => m.to === 'bob@daythree.test')!;
    expect(toAlice.text).toContain('No MYR exchange rate'); expect(toAlice.text).toContain('no client rate card');
    expect(toBob.text).toContain('No MYR exchange rate'); expect(toBob.text).not.toContain('no client rate card');
    sent.length = 0; later(1);
    expect(await sweep()).toMatchObject({ sent: 0 }); expect(sent).toEqual([]);                 // nothing again while it stays open
  });

  it('tells someone who subscribes, or asks for more, about what is already open', async () => {
    sent.length = 0;
    const carol = await staff('carol@daythree.test');
    await subscribe(carol.id, 'high'); later(1); await sweep();
    expect(sent.map((m) => m.to)).toEqual(['carol@daythree.test']); expect(sent[0]!.text).toContain('No MYR exchange rate');
    sent.length = 0;
    await subscribe(carol.id, 'medium'); later(1); await sweep();
    expect(sent.map((m) => m.to)).toEqual(['carol@daythree.test']); expect(sent[0]!.text).toContain('no client rate card'); expect(sent[0]!.text).not.toContain('No MYR');
    await must(env.call(st(), 'POST', `/internal/alerts/subscriptions/${carol.id}/end`));
  });

  it('does not email again an alert that flickers, and does once it has been gone a while and comes back', async () => {
    sent.length = 0;
    await drain(); later(1); expect((await sweep()).sent).toBe(1);                               // medium: Alice only
    expect(sent[0]!.text).toContain('tw is drained');
    const drainCleared = async () => (await env.pool.query(`SELECT cleared_at FROM alert_state WHERE code = 'provider_drained'`)).rows[0].cleared_at !== null;
    await restore(); later(5); await sweep(); expect(await drainCleared()).toBe(false);          // gone 5 minutes: still open
    await drain(); later(1); expect((await sweep()).sent).toBe(0);                               // back: not news
    await restore(); later(5); await sweep(); later(31); await sweep(); expect(await drainCleared()).toBe(true);
    await drain(); later(1); expect((await sweep()).sent).toBe(1);                               // a new episode
    const drains = (await deliveries()).filter((d) => d.alertKey.startsWith('provider_drained'));
    expect(drains.map((d) => d.episode).sort()).toEqual([1, 2]);
    await settle();
  });

  it('keeps a provider\'s funding in each currency apart', async () => {
    sent.length = 0;
    for (const currency of ['USD', 'MYR']) await must(env.call(st(), 'POST', `/internal/providers/${twilioId}/funding`, { kind: 'usage', amount: '-1', currency }));
    later(1); await sweep();
    const funding = sent.find((m) => m.to === 'bob@daythree.test')!.text.split('\n').filter((l) => l.includes('recorded funding balance'));
    expect(funding).toHaveLength(2);
    for (const currency of ['USD', 'MYR']) await must(env.call(st(), 'POST', `/internal/providers/${twilioId}/funding`, { kind: 'topup', amount: '1', currency }));
    later(31); await sweep();
  });

  it('sends once when two sweeps run at the same moment, and the second does not take a send still under way for a crash', async () => {
    sent.length = 0;
    await drain(); later(1);
    slow = 200;                                                                                    // the first is still sending when the second starts
    try { await Promise.all([sweep(), sweep()]); } finally { slow = 0; }
    expect(drained()).toHaveLength(1);
    expect((await deliveries()).filter((d) => d.alertKey.startsWith('provider_drained')).map((d) => d.status)[0]).toBe('sent');
    await settle();
  });

  it('records a refusal as failed, never sends again one whose outcome is unknown, and says so on the Control Tower', async () => {
    sent.length = 0; mode = 'timeout';
    await drain(); later(1); await sweep();
    mode = 'ok'; later(1); await sweep();
    expect(drained()).toEqual([]);                                                                 // not repeated
    const statusOf = async () => (await deliveries()).filter((d) => d.alertKey.startsWith('provider_drained')).map((d) => d.status);
    expect((await statusOf())[0]).toBe('unknown');
    await settle();
    mode = 'refuse'; await drain(); later(1); await sweep();
    expect((await statusOf())[0]).toBe('failed');
    mode = 'ok';
    const t = (await must(env.call(st(), 'GET', '/internal/control-tower'))).json();
    expect(t.alerts.find((a: { code: string }) => a.code === 'alert_email_problem')?.message).toBe('2 alert emails were refused or may not have arrived in the last 24 hours; check that the people concerned saw the alert.');
    await settle();
  });

  it('settles a send left half-done by a crash as unknown, and never sends it again', async () => {
    sent.length = 0;
    await drain(); later(1);
    // A sweep that claimed the email for the episode about to open, and then died: the row is "sending", from an hour ago.
    const st8 = (await env.pool.query(`SELECT key, episode, cleared_at FROM alert_state WHERE code = 'provider_drained'`)).rows[0];
    await env.pool.query(`INSERT INTO alert_deliveries (alert_key, episode, user_id, kind, status, created_at) VALUES ($1, $2, $3, 'alert', 'sending', now() - interval '1 hour')`,
      [st8.key, st8.cleared_at ? st8.episode + 1 : st8.episode, alice.id]);
    await sweep();
    expect(drained()).toEqual([]);
    expect((await env.pool.query(`SELECT status FROM alert_deliveries WHERE user_id = $1 AND alert_key LIKE 'provider_drained%' ORDER BY id DESC LIMIT 1`, [alice.id])).rows[0].status).toBe('unknown');
    await settle();
  });

  it('sends nothing to someone disabled or unsubscribed, and does not list them', async () => {
    sent.length = 0;
    await must(env.call(st(), 'POST', `/internal/users/${bob.id}/disable`));
    await must(env.call(st(), 'POST', `/internal/alerts/subscriptions/${alice.id}/end`));
    await drain(); later(1); await sweep(); expect(sent).toEqual([]);
    expect((await must(env.call(st(), 'GET', '/internal/alerts/subscriptions'))).json()).toEqual([]);
    expect((await env.call(st(), 'POST', `/internal/alerts/subscriptions/${bob.id}/test`)).statusCode).toBe(404);   // no test email to a disabled person
    await settle();
    await subscribe(alice.id, 'medium');
  });

  it('sends a test email to a subscriber on request, and says what happened', async () => {
    sent.length = 0;
    expect((await must(env.call(st(), 'POST', `/internal/alerts/subscriptions/${alice.id}/test`))).json()).toEqual({ status: 'sent' });
    expect(sent).toEqual([expect.objectContaining({ to: 'alice@daythree.test', subject: '[Voice Lab] Test alert' })]);
    mode = 'refuse';
    expect((await must(env.call(st(), 'POST', `/internal/alerts/subscriptions/${alice.id}/test`))).json()).toEqual({ status: 'failed' });
    mode = 'ok';
  });

  it('never rewrites a delivery once it is settled', async () => {
    await expect(env.pool.query(`UPDATE alert_deliveries SET status = 'sent' WHERE status = 'unknown'`)).rejects.toThrow(/settled once/);
    await expect(env.pool.query(`UPDATE alert_deliveries SET detail = 'x' WHERE status = 'failed'`)).rejects.toThrow(/settled once/);
    await expect(env.pool.query('DELETE FROM alert_deliveries')).rejects.toThrow(/append-only/);
  });
});
