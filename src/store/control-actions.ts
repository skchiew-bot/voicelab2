/**
 * Actions an operator takes from the Control Tower: drain a provider and restore it, force a failover, prefer a
 * telephony provider, set the dialling pace, retire a caller ID or bring it back. Every action needs a reason, goes
 * in the audit log (so the change log shows who did it and why), and changes only what the call path reads next: a
 * call already under way is never touched.
 */
import type pg from 'pg';
import { z } from 'zod';
import { AppError } from '../errors.js';
import type { State } from '../resilience/failover.js';
import { audit } from './audit.js';
import { cleanNote } from './cases.js';
import { outboundPerMinuteUsd } from './dids.js';
import { healthMap, logFailover } from './resilience.js';

const id = z.string().uuid();
const reason = z.string().trim().min(3, 'Say why, in a few words.').max(500);
export const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('drain'), providerId: id, reason }).strict(),
  z.object({ action: z.literal('restore'), providerId: id, reason }).strict(),
  z.object({ action: z.literal('force_failover'), providerId: id, reason }).strict(),
  z.object({ action: z.literal('end_failover'), providerId: id, reason }).strict(),
  z.object({ action: z.literal('set_preferred'), providerId: id, reason }).strict(),
  z.object({ action: z.literal('clear_preferred'), providerId: id, reason }).strict(),
  z.object({ action: z.literal('set_pace'), perMinute: z.number().int().min(1).max(100_000).nullable(), reason }).strict(),
  z.object({ action: z.literal('retire_number'), phoneNumberId: id, reason }).strict(),
  z.object({ action: z.literal('reactivate_number'), phoneNumberId: id, reason }).strict(),
]);
export type ControlAction = z.infer<typeof actionSchema>;

const lock = (c: pg.PoolClient, key: string) => c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);

async function provider(c: pg.PoolClient, providerId: string) {
  const p = (await c.query('SELECT id, name, kind, status FROM providers WHERE id = $1', [providerId])).rows[0] as { id: string; name: string; kind: string; status: string } | undefined;
  if (!p) throw new AppError(404, 'Provider not found.');
  return p;
}

/** Take one action. Everything the dial path reads is changed under its own lock, so a dial deciding at the same moment sees the state before or after, never half of it. */
export async function runAction(c: pg.PoolClient, actorId: string, e: ControlAction) {
  const why = cleanNote(e.reason, 'reason')!;
  switch (e.action) {
    case 'drain': case 'restore': case 'set_preferred': case 'clear_preferred': {
      const p = await provider(c, e.providerId);
      await lock(c, 'capacity');                       // the lock every outbound dial decision takes
      const cur = (await c.query('SELECT drained_at, preferred FROM provider_controls WHERE provider_id = $1', [p.id])).rows[0] as { drained_at: Date | null; preferred: boolean } | undefined;
      if (e.action === 'drain') {
        if (p.status !== 'active') throw new AppError(409, `${p.name} is not in use, so there is nothing to drain.`);
        if (cur?.drained_at) throw new AppError(409, `${p.name} is already drained.`);
        // A voice provider is routed per client. Draining the last usable one a client has would send every new call
        // of theirs down the fallback ladder, so it is refused: route them to another provider first.
        if (p.kind !== 'telephony') {
          const stranded = (await c.query(
            `SELECT count(DISTINCT r.tenant_id)::int AS n FROM provider_routes r WHERE r.provider_id = $1 AND r.role = 'voice'
                AND NOT EXISTS (SELECT 1 FROM provider_routes o JOIN providers op ON op.id = o.provider_id
                                 WHERE o.tenant_id = r.tenant_id AND o.role = 'voice' AND o.provider_id <> $1 AND op.status = 'active'
                                   AND NOT EXISTS (SELECT 1 FROM provider_controls k WHERE k.provider_id = o.provider_id AND k.drained_at IS NOT NULL))`, [p.id])).rows[0].n as number;
          if (stranded > 0) throw new AppError(409, `${p.name} is the only usable voice provider for ${stranded} client${stranded === 1 ? '' : 's'}. Add another provider to their routes on the Resilience screen before draining it.`);
        }
        await c.query(`INSERT INTO provider_controls (provider_id, drained_at, drained_by, drained_reason) VALUES ($1, now(), $2, $3)
                       ON CONFLICT (provider_id) DO UPDATE SET drained_at = now(), drained_by = $2, drained_reason = $3, updated_at = now()`, [p.id, actorId, why]);
      } else if (e.action === 'restore') {
        if (!cur?.drained_at) throw new AppError(409, `${p.name} is not drained.`);
        await c.query('UPDATE provider_controls SET drained_at = NULL, drained_by = NULL, drained_reason = NULL, updated_at = now() WHERE provider_id = $1', [p.id]);
      } else {
        if (p.kind !== 'telephony') throw new AppError(400, 'Only a telephony provider can be preferred here. A client\'s voice providers are put in order on the Resilience screen.');
        const want = e.action === 'set_preferred';
        if (want && (await outboundPerMinuteUsd(c, p.id, new Date())) === null) throw new AppError(409, `${p.name} has no outbound rate in force, so its calls could not be priced. Add its rates before preferring it.`);
        if ((cur?.preferred ?? false) === want) throw new AppError(409, `${p.name} is ${want ? 'already' : 'not'} preferred.`);
        await c.query(`INSERT INTO provider_controls (provider_id, preferred) VALUES ($1, $2) ON CONFLICT (provider_id) DO UPDATE SET preferred = $2, updated_at = now()`, [p.id, want]);
      }
      await audit(c, actorId, `control.${e.action}`, 'provider', p.id, { reason: why });
      break;
    }
    case 'force_failover': case 'end_failover': {
      const p = await provider(c, e.providerId);
      if (p.status !== 'active') throw new AppError(409, `${p.name} is not in use.`);
      await lock(c, `health:${p.id}`);                  // the lock health changes take
      const state = (await healthMap(c, [p.id])).get(p.id) ?? 'healthy';
      // The application's clock, as for every health change, so samples after this moment are compared on one clock.
      const now = new Date();
      if (e.action === 'force_failover') {
        if (state !== 'healthy') throw new AppError(409, `${p.name} is already ${state === 'unfunded' ? 'out of funding' : 'failed over'}.`);
        // Failed like any other failover: a voice provider earns its way back through probes and the recovery rules.
        // A telephony provider has no probe yet, so an operator ends the failover by hand (end_failover).
        await c.query(`INSERT INTO provider_health (provider_id, state, reason, ok_streak, since, updated_at) VALUES ($1, 'failed', $2, 0, $3, now())
                       ON CONFLICT (provider_id) DO UPDATE SET state = 'failed', reason = $2, ok_streak = 0, since = $3, updated_at = now()`, [p.id, 'Failed over by an operator.', now]);
        await logFailover(c, { scope: 'provider_health', from: p.id, trigger: 'operator', detail: { from: 'healthy', to: 'failed' } });
      } else {
        // The way back from any failover a person judges over. Running out of funding is not ended here: a top-up does that.
        if (state !== 'failed') throw new AppError(409, state === 'unfunded' ? `${p.name} is out of funding; record a top-up to bring it back.` : `${p.name} is not failed over.`);
        await c.query(`UPDATE provider_health SET state = 'healthy', reason = NULL, ok_streak = 0, since = $2, updated_at = now() WHERE provider_id = $1`, [p.id, now]);
        await logFailover(c, { scope: 'provider_health', from: p.id, trigger: 'operator', detail: { from: 'failed', to: 'healthy' } });
      }
      await audit(c, actorId, `control.${e.action}`, 'provider', p.id, { reason: why });
      break;
    }
    case 'set_pace': {
      await lock(c, 'capacity');
      await c.query(`INSERT INTO dial_pace (id, per_minute, updated_by) VALUES (true, $1, $2) ON CONFLICT (id) DO UPDATE SET per_minute = $1, updated_by = $2, updated_at = now()`, [e.perMinute, actorId]);
      await audit(c, actorId, 'control.set_pace', 'pace', null, { perMinute: e.perMinute, reason: why });
      break;
    }
    case 'retire_number': case 'reactivate_number': {
      const want = e.action === 'retire_number' ? 'retired' : 'active';
      const n = (await c.query('SELECT id, tenant_id, country, status FROM phone_numbers WHERE id = $1', [e.phoneNumberId])).rows[0] as { id: string; tenant_id: string; country: string; status: string } | undefined;
      if (!n) throw new AppError(404, 'Number not found.');
      await lock(c, `did:${n.tenant_id}:${n.country}`);   // the lock the caller-ID pool takes when it chooses
      const r = await c.query('UPDATE phone_numbers SET status = $2 WHERE id = $1 AND status <> $2', [n.id, want]);
      if (!r.rowCount) throw new AppError(409, `That number is already ${want}.`);
      await audit(c, actorId, `control.${e.action}`, 'number', n.id, { reason: why });
      break;
    }
  }
  return controlState(c);
}

/**
 * Health as routing sees it: a drained provider counts as failed for new calls, without touching its real health
 * (which recovery and probes still track).
 */
export async function routingHealth(c: pg.PoolClient, providerIds?: string[]): Promise<Map<string, State>> {
  const health = await healthMap(c, providerIds);
  const drained = (await c.query('SELECT provider_id FROM provider_controls WHERE drained_at IS NOT NULL AND ($1::uuid[] IS NULL OR provider_id = ANY($1))', [providerIds ?? null])).rows;
  for (const d of drained) health.set(d.provider_id, 'failed');
  return health;
}

/** Providers an operator has drained. */
export const drainedSet = async (c: pg.PoolClient): Promise<Set<string>> =>
  new Set((await c.query('SELECT provider_id FROM provider_controls WHERE drained_at IS NOT NULL')).rows.map((r) => r.provider_id as string));

/** The current pace, or null for no limit. */
export const dialPace = async (c: pg.PoolClient): Promise<number | null> => (await c.query('SELECT per_minute FROM dial_pace')).rows[0]?.per_minute ?? null;

/** What the operator controls are set to now. */
export async function controlState(c: pg.PoolClient) {
  const providers = (await c.query(
    `SELECT p.id, p.name, p.kind, p.status, coalesce(h.state, 'healthy') AS health, h.reason AS health_reason,
            k.drained_at, k.drained_reason, u.email AS drained_by, coalesce(k.preferred, false) AS preferred
       FROM providers p LEFT JOIN provider_health h ON h.provider_id = p.id LEFT JOIN provider_controls k ON k.provider_id = p.id LEFT JOIN users u ON u.id = k.drained_by
      ORDER BY p.name`)).rows.map((r) => ({
      id: r.id as string, name: r.name as string, kind: r.kind as string, status: r.status as string, health: r.health as State, healthReason: r.health_reason as string | null,
      drained: r.drained_at ? { at: r.drained_at as Date, by: (r.drained_by as string | null) ?? 'a user who no longer exists', reason: r.drained_reason as string } : null,
      preferred: r.preferred as boolean,
    }));
  return { providers, pacePerMinute: await dialPace(c) };
}
