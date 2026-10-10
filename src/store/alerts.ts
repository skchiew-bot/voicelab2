/**
 * Control Tower alerts by email. A scheduled sweep works out the alerts showing now, notes which are new since the last
 * sweep (or have come back after clearing), and emails each subscribed member of staff once, listing what is new for
 * them. An email whose outcome is unknown (a timeout, an unreadable reply) is never sent again (lesson L-002); one the
 * mail service refused is recorded as failed. With no mail service connected nothing is sent or claimed, the Control
 * Tower says so, and every open alert is sent once a mail service is connected (never recorded as sent before; L-005).
 * An alert must be gone for a while before it counts as cleared, so one that flickers is not emailed each time (L-012).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { withActor } from '../db.js';
import { AppError } from '../errors.js';
import { controlTower, type Alert, type Severity } from './control-tower.js';
import { audit } from './audit.js';
import { ACTIVE } from './tenants.js';

/** Whatever sends email for us. A refusal the service is sure of throws `MailRefused`; anything else is an unknown outcome. */
export interface Mailer { send(m: { to: string; subject: string; text: string }): Promise<void> }
export class MailRefused extends Error {}

export interface AlertDeps { pool: pg.Pool; key: Buffer; publicBaseUrl?: string; mailer?: Mailer }

const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
/** An alert must be gone this long before it counts as cleared, so one that flickers is not emailed again each time it returns. */
export const CLEAR_AFTER_MS = 30 * 60_000;
/** A send that has been "sending" this long (a crash, a restart) is settled as unknown, never sent again. */
const STALE_SENDING_MS = 15 * 60_000;
/** How long one email may take before its outcome counts as unknown. */
const SEND_TIMEOUT_MS = 30_000;

/** What an alert is about, so a changing count in its message does not make it a new alert. */
export const alertKey = (a: Pick<Alert, 'code' | 'link' | 'scope'>) => `${a.code}|${a.link ?? ''}|${a.scope ?? ''}`;

/** Does this subscription want this alert? */
export const wants = (s: { min_severity: Severity; codes: string[] | null }, a: Pick<Alert, 'code' | 'severity'>) =>
  RANK[a.severity] <= RANK[s.min_severity] && (s.codes === null || s.codes.includes(a.code));

/** One email per person, listing what is new for them, most severe first, each with a link into the console. */
export function composeEmail(alerts: Pick<Alert, 'severity' | 'message' | 'link'>[], publicBaseUrl?: string) {
  const sorted = [...alerts].sort((a, b) => RANK[a.severity] - RANK[b.severity]);
  const high = sorted.filter((a) => a.severity === 'high').length;
  const subject = `[Voice Lab] ${sorted.length} new alert${sorted.length === 1 ? '' : 's'}${high ? ` (${high} high)` : ''}`;
  const base = publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, '')}/admin/` : null;
  const lines = sorted.map((a) => `${a.severity.toUpperCase()}: ${a.message}${a.link && base ? `\n  ${base}${a.link}` : ''}`);
  const text = [...lines, '', `See every alert on the Control Tower${base ? `: ${base}#/tower` : '.'}`, 'You get this because you are subscribed to Voice Lab alerts.'].join('\n');
  return { subject, text };
}

/** Active staff only: a disabled person, an admin still waiting for approval, or anyone not on staff gets nothing. */
const STAFF = `JOIN LATERAL (SELECT email, role FROM users WHERE id = s.user_id AND ${ACTIVE}) u ON u.role IN ('internal_admin', 'internal_viewer')`;

async function sendWithin(mailer: Mailer, m: { to: string; subject: string; text: string }): Promise<'sent' | 'failed' | 'unknown'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([mailer.send(m), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), SEND_TIMEOUT_MS); })]);
    return 'sent';
  } catch (e) { return e instanceof MailRefused ? 'failed' : 'unknown'; }
  finally { if (timer) clearTimeout(timer); }
}

interface Job { ids: number[]; email: string; subject: string; text: string }

/**
 * Run one sweep. Every open alert a subscriber wants is emailed to them once per time it is open: a person who
 * subscribes, or widens what they want, while an alert is open hears about it at the next sweep, and so does everyone
 * once a mail service is connected. Two sweeps at once take turns, and nothing is sent twice.
 */
export async function sweepAlerts(d: AlertDeps, now = new Date()) {
  const { jobs, opened, cleared, notSent } = await withActor(d.pool, { kind: 'internal' }, async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('alerts'))`);
    // A send left half-done by a crash or restart is settled as unknown: it may have gone, so it is never sent again.
    await c.query(`UPDATE alert_deliveries SET status = 'unknown', detail = 'the sweep sending it stopped before it finished; not sent again', settled_at = now()
                    WHERE status = 'sending' AND created_at < $1`, [new Date(now.getTime() - STALE_SENDING_MS)]);
    const t = await controlTower(c, d.key, { publicBaseUrlSet: Boolean(d.publicBaseUrl), mailConnected: Boolean(d.mailer) });
    const showing = new Map<string, Alert>();
    for (const a of t.alerts) if (!showing.has(alertKey(a))) showing.set(alertKey(a), a);

    // Open or reopen what is showing. Clear what has been gone for a while, not the moment it flickers out.
    const state = new Map((await c.query('SELECT key, cleared_at, last_seen, episode FROM alert_state')).rows.map((r) => [r.key as string, r as { cleared_at: Date | null; last_seen: Date; episode: number }]));
    let opened = 0;
    for (const [key, a] of showing) {
      const s = state.get(key);
      if (!s) { await c.query('INSERT INTO alert_state (key, code, severity, message, first_seen, last_seen) VALUES ($1,$2,$3,$4,$5,$5)', [key, a.code, a.severity, a.message, now]); opened++; }
      else if (s.cleared_at) { await c.query('UPDATE alert_state SET cleared_at = NULL, episode = episode + 1, first_seen = $2, last_seen = $2, severity = $3, message = $4 WHERE key = $1', [key, now, a.severity, a.message]); opened++; }
      else await c.query('UPDATE alert_state SET last_seen = $2, severity = $3, message = $4 WHERE key = $1', [key, now, a.severity, a.message]);
    }
    let cleared = 0;
    for (const [key, s] of state) {
      if (!showing.has(key) && !s.cleared_at && new Date(s.last_seen).getTime() <= now.getTime() - CLEAR_AFTER_MS) { await c.query('UPDATE alert_state SET cleared_at = $2 WHERE key = $1', [key, now]); cleared++; }
    }

    // Every open alert (showing now) that a subscriber wants and has not been sent in this episode.
    const open = (await c.query(`SELECT key, episode FROM alert_state WHERE cleared_at IS NULL`)).rows.filter((r) => showing.has(r.key)) as { key: string; episode: number }[];
    const subs = (await c.query(`SELECT s.user_id, s.min_severity, s.codes, u.email FROM alert_subscriptions s ${STAFF} WHERE s.ended_at IS NULL`)).rows as { user_id: string; min_severity: Severity; codes: string[] | null; email: string }[];
    const jobs: Job[] = []; let notSent = 0;
    for (const s of subs) {
      const mine = open.filter((o) => wants(s, showing.get(o.key)!));
      if (mine.length === 0) continue;
      if (!d.mailer) {
        // Nothing is claimed without a mail service, so these are all sent once one is connected.
        const unsent = (await c.query(`SELECT count(*)::int AS n FROM unnest($1::text[], $2::int[]) AS o(key, episode)
            WHERE NOT EXISTS (SELECT 1 FROM alert_deliveries d WHERE d.alert_key = o.key AND d.episode = o.episode AND d.user_id = $3 AND d.kind = 'alert')`,
          [mine.map((o) => o.key), mine.map((o) => o.episode), s.user_id])).rows[0].n as number;
        notSent += unsent; continue;
      }
      const ids: number[] = []; const alerts: Alert[] = [];
      for (const o of mine) {
        const r = (await c.query(`INSERT INTO alert_deliveries (alert_key, episode, user_id, kind, status) VALUES ($1,$2,$3,'alert','sending') ON CONFLICT DO NOTHING RETURNING id`, [o.key, o.episode, s.user_id])).rows[0];
        if (r) { ids.push(Number(r.id)); alerts.push(showing.get(o.key)!); }
      }
      if (ids.length > 0) jobs.push({ ids, email: s.email, ...composeEmail(alerts, d.publicBaseUrl) });
    }
    return { jobs, opened, cleared, notSent };
  });

  // Sent outside any transaction: a slow mail service must not hold the lock or a database connection. One email that
  // cannot be settled does not stop the others; its rows stay "sending" and the next sweep settles them as unknown.
  let sent = 0; let failed = 0; let unknown = 0;
  for (const j of jobs) {
    const status = await sendWithin(d.mailer!, { to: j.email, subject: j.subject, text: j.text });
    if (status === 'sent') sent++; else if (status === 'failed') failed++; else unknown++;
    const detail = status === 'failed' ? 'refused by the mail service' : status === 'unknown' ? 'no clear answer from the mail service; not sent again' : null;
    try { await withActor(d.pool, { kind: 'internal' }, (c) => c.query(`UPDATE alert_deliveries SET status = $2, detail = $3, settled_at = now() WHERE id = ANY($1) AND status = 'sending'`, [j.ids, status, detail])); }
    catch { /* settled as unknown by the next sweep */ }
  }
  return { opened, cleared, sent, failed, unknown, notSent, mailConnected: Boolean(d.mailer) };
}

// ------------------------------------------------------------------------------------------------ subscriptions
export const subscriptionSchema = z.object({
  userId: z.string().uuid(), minSeverity: z.enum(['high', 'medium', 'low']),
  codes: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,60}$/)).min(1).max(50).nullable().default(null),
}).strict();

/** Subscribe a member of staff, or change what they get. Clients can never be subscribed: alerts name providers, costs and funding. */
export async function subscribe(c: pg.PoolClient, actorId: string, e: z.infer<typeof subscriptionSchema>) {
  const u = (await c.query(`SELECT id, role FROM users WHERE id = $1 AND ${ACTIVE}`, [e.userId])).rows[0] as { id: string; role: string } | undefined;
  if (!u) throw new AppError(404, 'No active user with that id.');
  if (u.role !== 'internal_admin' && u.role !== 'internal_viewer') throw new AppError(400, 'Only Daythree staff can get alerts: they name providers, costs and funding, which clients never see.');
  await c.query(
    `INSERT INTO alert_subscriptions (user_id, min_severity, codes, created_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO UPDATE SET min_severity = $2, codes = $3, ended_at = NULL`, [e.userId, e.minSeverity, e.codes, actorId]);
  await audit(c, actorId, 'alerts.subscribe', 'user', e.userId, { minSeverity: e.minSeverity, codes: e.codes?.length ?? null });
  return listSubscriptions(c);
}

export async function unsubscribe(c: pg.PoolClient, actorId: string, userId: string) {
  const r = await c.query('UPDATE alert_subscriptions SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL', [userId]);
  if (!r.rowCount) throw new AppError(404, 'That person is not subscribed.');
  await audit(c, actorId, 'alerts.unsubscribe', 'user', userId, {});
  return listSubscriptions(c);
}

export const listSubscriptions = async (c: pg.PoolClient) =>
  (await c.query(
    `SELECT s.user_id AS "userId", u.email, s.min_severity AS "minSeverity", s.codes, s.created_at AS "createdAt"
       FROM alert_subscriptions s ${STAFF} WHERE s.ended_at IS NULL ORDER BY u.email`)).rows;

export const listDeliveries = async (c: pg.PoolClient, limit = 100) =>
  (await c.query(
    `SELECT d.id, d.alert_key AS "alertKey", d.episode, u.email, d.kind, d.status, d.detail, d.created_at AS "createdAt", d.settled_at AS "settledAt"
       FROM alert_deliveries d JOIN users u ON u.id = d.user_id ORDER BY d.id DESC LIMIT $1`, [Math.min(limit, 500)])).rows;

/** Send one test email to a subscriber, so the address and the mail service are proven before a real alert needs them. */
export async function sendTest(d: AlertDeps, actorId: string, userId: string) {
  const claim = await withActor(d.pool, { kind: 'internal' }, async (c) => {
    const s = (await c.query(`SELECT u.email FROM alert_subscriptions s ${STAFF} WHERE s.user_id = $1 AND s.ended_at IS NULL`, [userId])).rows[0];
    if (!s) throw new AppError(404, 'That person is not subscribed, or can no longer sign in.');
    const key = `test|${randomUUID()}`;
    const id = (await c.query(
      `INSERT INTO alert_deliveries (alert_key, episode, user_id, kind, status, detail, settled_at) VALUES ($1, 1, $2, 'test', $3, $4, $5) RETURNING id`,
      [key, userId, d.mailer ? 'sending' : 'no_mail_service', d.mailer ? null : 'no mail service is connected', d.mailer ? null : new Date()])).rows[0].id;
    await audit(c, actorId, 'alerts.test', 'user', userId, {});
    return { id: Number(id), email: s.email as string };
  });
  if (!d.mailer) return { status: 'no_mail_service' as const };
  const status = await sendWithin(d.mailer, { to: claim.email, subject: '[Voice Lab] Test alert', text: 'This is a test from Voice Lab. Alerts from the Control Tower will arrive like this.' });
  await withActor(d.pool, { kind: 'internal' }, (c) => c.query(`UPDATE alert_deliveries SET status = $2, settled_at = now() WHERE id = $1 AND status = 'sending'`, [claim.id, status]));
  return { status };
}
