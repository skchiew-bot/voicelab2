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
  });
});

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let alice: { id: string; token: string }; let bob: { id: string; token: string }; let twilioId: string;
const sent: { to: string; subject: string; text: string }[] = [];
let mode: 'ok' | 'refuse' | 'timeout' = 'ok';
const mailer: Mailer = { async send(m) { if (mode === 'refuse') throw new MailRefused('550'); if (mode === 'timeout') throw new Error('timed out'); sent.push(m); } };
const st = () => env.staffToken;
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}
const sweep = async () => (await must(env.call(st(), 'POST', '/internal/alerts/sweep'))).json();
const act = (b: object) => must(env.call(st(), 'POST', '/internal/control-tower/actions', b));
const deliveries = async () => (await must(env.call(st(), 'GET', '/internal/alerts/deliveries'))).json() as { email: string; kind: string; status: string; alertKey: string; episode: number }[];
const staff = async (email: string) => withActor(env.pool, { kind: 'internal' }, (c) => createUser(c, null, { tenantId: null, email, role: 'internal_admin' }));

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
    expect((await env.call(client.token, 'PUT', '/internal/alerts/subscriptions', { userId: client.id, minSeverity: 'low' })).statusCode).toBe(403);
    await must(env.call(st(), 'PUT', '/internal/alerts/subscriptions', { userId: alice.id, minSeverity: 'medium' }));
    await must(env.call(st(), 'PUT', '/internal/alerts/subscriptions', { userId: bob.id, minSeverity: 'high' }));
  });

  it('emails each person once about what is new for them, and nothing again while it stays open', async () => {
    const first = await sweep();
    expect(first).toMatchObject({ sent: 2, failed: 0, unknown: 0, mailConnected: true });
    const toAlice = sent.find((m) => m.to === 'alice@daythree.test')!; const toBob = sent.find((m) => m.to === 'bob@daythree.test')!;
    expect(toAlice.text).toContain('No MYR exchange rate'); expect(toAlice.text).toContain('no client rate card');      // high and medium
    expect(toBob.text).toContain('No MYR exchange rate'); expect(toBob.text).not.toContain('no client rate card');     // high only
    sent.length = 0;
    expect(await sweep()).toMatchObject({ opened: 0, sent: 0 });
    expect(sent).toEqual([]);
  });

  it('sends again when an alert clears and comes back, as a new episode', async () => {
    sent.length = 0;
    await act({ action: 'drain', providerId: twilioId, reason: 'Testing alerts.' });
    expect((await sweep()).sent).toBe(1);                                                           // medium: Alice only
    expect(sent.map((m) => m.to)).toEqual(['alice@daythree.test']); expect(sent[0]!.text).toContain('tw is drained');
    await act({ action: 'restore', providerId: twilioId, reason: 'Done testing.' });
    expect((await sweep()).cleared).toBe(1);
    await act({ action: 'drain', providerId: twilioId, reason: 'Testing again.' });
    expect((await sweep()).sent).toBe(1);
    const drains = (await deliveries()).filter((d) => d.alertKey.startsWith('provider_drained'));
    expect(drains.map((d) => d.episode).sort()).toEqual([1, 2]);
    await act({ action: 'restore', providerId: twilioId, reason: 'Done.' }); await sweep();
  });

  it('sends once when two sweeps run at the same moment', async () => {
    sent.length = 0;
    await act({ action: 'drain', providerId: twilioId, reason: 'Race test.' });
    const [a, b] = await Promise.all([sweep(), sweep()]);
    expect(a.sent + b.sent).toBe(1); expect(sent).toHaveLength(1);
    await act({ action: 'restore', providerId: twilioId, reason: 'Done.' }); await sweep();
  });

  it('records a refusal as failed, and never sends again an email whose outcome is unknown', async () => {
    sent.length = 0;
    mode = 'timeout';
    await act({ action: 'drain', providerId: twilioId, reason: 'Unknown outcome test.' });
    expect((await sweep()).unknown).toBe(1);
    mode = 'ok';
    expect((await sweep()).sent).toBe(0); expect(sent).toEqual([]);                                  // not repeated
    expect((await deliveries())[0]).toMatchObject({ status: 'unknown', email: 'alice@daythree.test' });
    await act({ action: 'restore', providerId: twilioId, reason: 'Done.' }); await sweep();
    mode = 'refuse';
    await act({ action: 'drain', providerId: twilioId, reason: 'Refusal test.' });
    expect((await sweep()).failed).toBe(1);
    expect((await deliveries())[0]).toMatchObject({ status: 'failed' });
    mode = 'ok'; await act({ action: 'restore', providerId: twilioId, reason: 'Done.' }); await sweep();
  });

  it('sends nothing to someone disabled or unsubscribed', async () => {
    sent.length = 0;
    await must(env.call(st(), 'POST', `/internal/alerts/subscriptions/${alice.id}/end`));
    await act({ action: 'drain', providerId: twilioId, reason: 'Nobody listens.' });
    expect((await sweep()).sent).toBe(0);
    await act({ action: 'restore', providerId: twilioId, reason: 'Done.' }); await sweep();
    await must(env.call(st(), 'PUT', '/internal/alerts/subscriptions', { userId: alice.id, minSeverity: 'medium' }));
  });

  it('sends a test email to a subscriber on request', async () => {
    sent.length = 0;
    expect((await must(env.call(st(), 'POST', `/internal/alerts/subscriptions/${alice.id}/test`))).json()).toEqual({ status: 'sent' });
    expect(sent).toEqual([expect.objectContaining({ to: 'alice@daythree.test', subject: '[Voice Lab] Test alert' })]);
  });

  it('with no mail service, records every would-be email as not sent and says so on the Control Tower', async () => {
    const key = parseKey(env.config.VOICELAB_SECRET_KEY);
    await act({ action: 'drain', providerId: twilioId, reason: 'No mail service.' });
    const r = await sweepAlerts({ pool: env.pool, key, publicBaseUrl: env.config.PUBLIC_BASE_URL });
    expect(r).toMatchObject({ sent: 0, notSent: 1, mailConnected: false });
    expect((await deliveries())[0]).toMatchObject({ status: 'no_mail_service' });
    const t = await withActor(env.pool, { kind: 'internal' }, (c) => controlTower(c, key, { publicBaseUrlSet: false, mailConnected: false }));
    expect(t.alerts.find((a) => a.code === 'email_not_connected')?.message).toBe('2 people are subscribed to alerts by email, but no mail service is connected, so no email is being sent.');
    await act({ action: 'restore', providerId: twilioId, reason: 'Done.' });
  });

  it('never rewrites a delivery once it is settled', async () => {
    await expect(env.pool.query(`UPDATE alert_deliveries SET status = 'sent' WHERE status = 'unknown'`)).rejects.toThrow(/settled once/);
    await expect(env.pool.query('DELETE FROM alert_deliveries')).rejects.toThrow(/append-only/);
  });
});
