import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Fetch } from '../adapters/types.js';
import { withActor } from '../db.js';
import { AppError } from '../errors.js';
import { decryptSecrets } from '../secrets.js';
import { telnyxCommand, telnyxNextActions, telnyxPlaceCall, type TelnyxCreds } from '../telephony/telnyx.js';
import { twilioHangup, twilioPlaceCall, type TwilioCreds } from '../telephony/twilio.js';
import { ProviderRefused, redactNumbers, type Action, type NormalizedEvent } from '../telephony/types.js';
import { audit } from './audit.js';
import { recordCallCost } from './costs.js';
import { getEntitlement, inboundAdmission, isFull, promoteQueued, providerLoad } from './concurrency.js';
import { chooseDid, didLockedFor } from './dids.js';
import { contactHash, contactKeyFrom, gateOutbound, normalizeE164 } from './dnc.js';
import { recordCallEnd } from './call-end.js';
import { caseCallEnded, recogniseInbound, safely } from './cases.js';
import { settleTransferOnEnd } from './transfer.js';
import { recordEvent } from './events.js';
import { healthMap, logFailover, recordSample } from './resilience.js';
import { dialPace, drainedSet, routingHealth } from './control-actions.js';

export interface CallDeps { pool: pg.Pool; key: Buffer; dncKey: Buffer; http: Fetch; baseUrl?: string; tolerancePct?: number }

export interface ProviderRow {
  id: string; adapter_key: string; kind: string; status: string; params: Record<string, unknown>; secret_params: Buffer;
}

const asInternal = <T>(d: CallDeps, fn: (c: pg.PoolClient) => Promise<T>) => withActor(d.pool, { kind: 'internal' }, fn);

export async function loadProvider(c: pg.PoolClient, id: string): Promise<ProviderRow | null> {
  return (await c.query('SELECT id, adapter_key, kind, status, params, secret_params FROM providers WHERE id = $1', [id])).rows[0] ?? null;
}

/** Plain settings merged with decrypted secrets. Held in memory for the length of one request. */
export const credentials = <T>(p: ProviderRow, key: Buffer): T =>
  ({ ...p.params, ...decryptSecrets(p.secret_params, key, p.id) }) as T;

// ---------------------------------------------------------------- numbers
export async function addNumber(
  c: pg.PoolClient, actorId: string | null,
  e: { providerId: string; e164: string; tenantId: string; projectId?: string; country: string; label?: string },
) {
  const n = normalizeE164(e.e164);
  if (!n) throw new AppError(400, 'Number must be in international format, e.g. +60312345678.');
  const { rows } = await c.query(
    `INSERT INTO phone_numbers (provider_id, e164, tenant_id, project_id, country, label)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, provider_id, e164, tenant_id, project_id, country, label`,
    [e.providerId, n, e.tenantId, e.projectId ?? null, e.country, e.label ?? null],
  );
  await audit(c, actorId, 'number.add', 'provider', e.providerId, { country: e.country });
  return rows[0];
}

export const listNumbers = async (c: pg.PoolClient) =>
  (await c.query('SELECT id, provider_id, e164, tenant_id, project_id, country, label, inbound_workflow_id FROM phone_numbers ORDER BY e164')).rows;

/** A workflow a call may run must be the same client's. */
async function workflowOfTenant(c: pg.PoolClient, workflowId: string, tenantId: string) {
  const w = (await c.query('SELECT tenant_id FROM workflows WHERE id = $1', [workflowId])).rows[0];
  if (!w || w.tenant_id !== tenantId) throw new AppError(400, 'That workflow does not belong to this client.');
}

/** Which workflow answers calls to one of our numbers (null: none, so a call hears the test message). */
export async function setNumberWorkflow(c: pg.PoolClient, actorId: string | null, numberId: string, workflowId: string | null) {
  const n = (await c.query('SELECT id, tenant_id, provider_id FROM phone_numbers WHERE id = $1 FOR UPDATE', [numberId])).rows[0];
  if (!n) throw new AppError(404, 'Number not found.');
  if (workflowId) await workflowOfTenant(c, workflowId, n.tenant_id);
  await c.query('UPDATE phone_numbers SET inbound_workflow_id = $2 WHERE id = $1', [numberId, workflowId]);
  await audit(c, actorId, 'number.workflow', 'provider', n.provider_id, { number: numberId, workflow: workflowId });
  return (await c.query('SELECT id, provider_id, e164, tenant_id, project_id, country, label, inbound_workflow_id FROM phone_numbers WHERE id = $1', [numberId])).rows[0];
}

// --------------------------------------------------------------- outbound
export interface PlaceInput {
  tenantId: string; projectId?: string; providerId?: string; from?: string; to: string; country: string;
  /** The contact's own time zone, for quiet hours; else the client's. */ timeZone?: string; now?: Date;
  /** The workflow the call runs once answered (one of this client's). Without one, the answered call hears a test message. */
  workflowId?: string;
}

/** How long a held-back dial is told to wait before trying again. */
export const RETRY_AFTER_SECONDS = 10;
const MAX_DIAL_TRIES = 2;

/**
 * Place an outbound call. The do-not-call gate runs first and the provider is never contacted for a blocked number.
 * Then the DID check picks the caller ID (or checks the one named): a DID that has ever failed for this contact is
 * never used for them again, and a provider that is failed, out of funding or at its concurrency ceiling is passed
 * over for one that can take the call. If every provider is full, the dial is held back (the caller retries) unless the
 * client has agreed to pay a premium for overburst. If the chosen provider fails to place the call, the next one is
 * tried. The customer's number is passed to the provider and not kept; only a keyed hash of it is.
 */
export async function placeOutboundCall(d: CallDeps, actorId: string | null, input: PlaceInput) {
  if (!d.baseUrl) throw new AppError(503, 'PUBLIC_BASE_URL is not set, so providers cannot reach this server. Set it to place calls.');
  const callId = randomUUID();
  const named = input.from === undefined ? null : normalizeE164(input.from);
  if (input.from !== undefined && !named) throw new AppError(400, '"from" must be in international format.');
  const toNumber = normalizeE164(input.to);
  const chash = toNumber ? contactHash(toNumber, contactKeyFrom(d.key)) : null;

  type Setup =
    | { kind: 'blocked'; reason: string }
    | { kind: 'refused'; reason: string; message: string; status: number }
    | { kind: 'deferred' }
    | { kind: 'go'; provider: ProviderRow; from: string; pooled: boolean };

  const setup: Setup = await asInternal(d, async (c): Promise<Setup> => {
    if (input.workflowId) await workflowOfTenant(c, input.workflowId, input.tenantId);
    if (input.providerId) {
      const requested = await loadProvider(c, input.providerId);
      if (!requested) throw new AppError(404, 'Provider not found.');
      if (requested.kind !== 'telephony' || requested.status !== 'active') throw new AppError(400, 'That provider cannot place calls.');
    }
    let own: { id: string; e164: string; provider_id: string } | undefined;
    if (named) {
      const rows = (await c.query(
        `SELECT id, e164, provider_id FROM phone_numbers WHERE tenant_id = $1 AND e164 = $2 AND status = 'active' AND ($3::uuid IS NULL OR provider_id = $3)`,
        [input.tenantId, named, input.providerId ?? null])).rows;
      if (rows.length === 0) throw new AppError(400, 'The caller ID is not an active number registered to this client on that provider.');
      if (rows.length > 1) throw new AppError(400, 'That number is registered with more than one provider. Say which provider to dial from.');
      own = rows[0];
    }
    const decision = await gateOutbound(c, d.dncKey, { tenantId: input.tenantId, projectId: input.projectId, callId, country: input.country, to: input.to, contactHash: chash ?? undefined, timeZone: input.timeZone, now: input.now });
    const anyTelephony = async () => (await c.query(`SELECT id FROM providers WHERE kind = 'telephony' ORDER BY created_at LIMIT 1`)).rows[0]?.id as string | undefined;
    const insertCall = (providerId: string, status: string, fromId: string | null, o: { reason?: string; burst?: boolean; creditMultiplier?: string | null } = {}) => c.query(
      // Started when it is decided (the clock now, not when the transaction began), so the dialling pace counts real minutes.
      `INSERT INTO calls (id, tenant_id, project_id, provider_id, direction, status, country, cost_status, from_number_id, contact_hash, end_reason, ended_at, burst, credit_multiplier, started_at, workflow_id)
       VALUES ($1,$2,$3,$4,'outbound',$5,$6,$7,$8,$9,$10, CASE WHEN $5 = 'dialing' THEN NULL ELSE now() END,$11,$12, clock_timestamp(), $13)`,
      // A call that never connects (blocked, no usable caller ID) has nothing to price.
      [callId, input.tenantId, input.projectId ?? null, providerId, status, input.country, status === 'dialing' ? 'pending' : 'not_applicable', fromId, chash, o.reason ?? null, o.burst ?? false, o.creditMultiplier ?? null, input.workflowId ?? null]);

    if (!decision.allowed) {
      const providerId = own?.provider_id ?? input.providerId ?? await anyTelephony();
      if (!providerId) throw new AppError(400, 'No telephony provider is set up.');
      await insertCall(providerId, 'blocked', own?.id ?? null);
      await audit(c, actorId, 'call.outbound', 'call', callId, { allowed: false, country: input.country });
      return { kind: 'blocked', reason: decision.reason };
    }
    if (!chash) throw new AppError(400, 'The number to dial is not valid.'); // unreachable: the gate blocks an invalid number

    // One dial at a time decides capacity, so two dials cannot both take the last free channel.
    await c.query(`SELECT pg_advisory_xact_lock(hashtext('capacity'))`);
    // The operator's dialling pace: no more than this many dials may start in any minute. Over it, the dial waits like
    // one held back for capacity. A dial that never went out (blocked, no usable caller ID) does not count.
    const pace = await dialPace(c);
    if (pace !== null) {
      const started = (await c.query(
        `SELECT count(*)::int AS n FROM calls WHERE direction = 'outbound' AND started_at > clock_timestamp() - interval '1 minute' AND status <> 'blocked'
            AND coalesce(end_reason, '') NOT IN ('did_locked', 'all_locked_for_contact', 'no_numbers', 'providers_unhealthy')`)).rows[0].n as number;
      if (started >= pace) return await defer(c, 'pace');
    }
    const telephony = (await c.query(`SELECT id FROM providers WHERE kind = 'telephony' AND status = 'active' AND ($1::uuid IS NULL OR id = $1)`, [input.providerId ?? null])).rows.map((r) => r.id as string);
    const health = await routingHealth(c, telephony);
    const unhealthy = new Set(telephony.filter((id) => (health.get(id) ?? 'healthy') !== 'healthy'));
    // Drained, not failed: a provider an operator is resting. A dial it blocks waits rather than failing, so a planned
    // drain never spends anyone's retries.
    const drained = await drainedSet(c);
    const real = await healthMap(c, telephony);
    const reallyUnhealthy = new Set(telephony.filter((id) => (real.get(id) ?? 'healthy') !== 'healthy'));
    // A caller ID named for this dial is checked again under the lock: it may have been retired since it was looked up.
    if (own && !(await c.query(`SELECT 1 FROM phone_numbers WHERE id = $1 AND status = 'active'`, [own.id])).rowCount) {
      throw new AppError(409, 'That caller ID was retired a moment ago. Choose another, or let the pool choose.');
    }
    const load = await providerLoad(c, telephony);
    const full = new Set(telephony.filter((id) => isFull(load.get(id)!)));

    let fromId = own?.id ?? null; let from = own?.e164 ?? ''; let providerId = own?.provider_id ?? null;
    let burst = false; let creditMultiplier: string | null = null;
    let refusal: { reason: string; message: string; status: number } | null = null;

    if (own) {
      if (await didLockedFor(c, input.tenantId, own.id, chash)) refusal = { reason: 'did_locked', message: 'That caller ID has failed for this contact before and is locked away from them. Choose another, or let the pool choose.', status: 409 };
      else if (unhealthy.has(own.provider_id) && !reallyUnhealthy.has(own.provider_id)) return await defer(c, 'drained');
      else if (unhealthy.has(own.provider_id)) refusal = { reason: 'providers_unhealthy', message: 'That caller ID belongs to a provider that is currently failed or out of funding. Let the pool choose, so another provider can take the call.', status: 503 };
      else if (full.has(own.provider_id)) {
        const ent = await getEntitlement(c, input.tenantId);
        if (ent?.overburst_multiplier) { burst = true; creditMultiplier = ent.overburst_multiplier; } else return await defer(c, 'at_capacity');
      }
    } else {
      const base = { tenantId: input.tenantId, projectId: input.projectId, callId, country: input.country, contactHash: chash, providerId: input.providerId, unhealthy };
      let choice = await chooseDid(c, { ...base, full });
      if (!choice.ok && choice.reason === 'at_capacity') {
        const ent = await getEntitlement(c, input.tenantId);
        if (!ent?.overburst_multiplier) return await defer(c, 'at_capacity');
        choice = await chooseDid(c, base);                 // the client has agreed to the premium: use capacity beyond the ceiling
        burst = true; creditMultiplier = ent.overburst_multiplier;
      }
      // Every provider that could take it is drained (none actually failed): wait for one to be restored.
      if (!choice.ok && choice.reason === 'providers_unhealthy') {
        const candidates = (await c.query(
          `SELECT DISTINCT n.provider_id FROM phone_numbers n JOIN providers p ON p.id = n.provider_id
            WHERE n.tenant_id = $1 AND n.country = $2 AND n.status = 'active' AND p.kind = 'telephony' AND p.status = 'active' AND ($3::uuid IS NULL OR n.provider_id = $3)`,
          [input.tenantId, input.country, input.providerId ?? null])).rows.map((r) => r.provider_id as string);
        if (candidates.some((pid) => drained.has(pid) && !reallyUnhealthy.has(pid))) return await defer(c, 'drained');
      }
      if (choice.ok) { from = choice.e164; fromId = choice.phoneNumberId; providerId = choice.providerId; }
      else refusal = {
        reason: choice.reason, status: choice.reason === 'providers_unhealthy' ? 503 : 409,
        message: choice.reason === 'all_locked_for_contact' ? 'Every number in the pool has failed for this contact before, so none can be used for them.'
          : choice.reason === 'providers_unhealthy' ? 'Every provider with a number for this client is failed or out of funding, so the call cannot be placed.'
          : 'There is no active number in this country for that client to dial from.',
      };
    }
    if (refusal) {
      const fallback = providerId ?? await anyTelephony();
      if (!fallback) throw new AppError(400, 'No telephony provider is set up.');
      await insertCall(fallback, 'failed', fromId, { reason: refusal.reason });
      await recordEvent(c, { tenantId: input.tenantId, projectId: input.projectId, callId, type: 'call.failed', payload: { reason: refusal.reason } });
      await audit(c, actorId, 'call.outbound', 'call', callId, { allowed: true, refused: refusal.reason, country: input.country });
      return { kind: 'refused', ...refusal };
    }
    const provider = await loadProvider(c, providerId!);
    if (!provider) throw new AppError(404, 'Provider not found.');
    if (provider.kind !== 'telephony' || provider.status !== 'active') throw new AppError(400, 'That provider cannot place calls.');
    if (!['twilio', 'telnyx'].includes(provider.adapter_key)) throw new AppError(400, 'That provider has no call control.');
    await insertCall(provider.id, 'dialing', fromId, { burst, creditMultiplier });
    if (burst) await recordEvent(c, { tenantId: input.tenantId, projectId: input.projectId, callId, type: 'call.burst', payload: { providerId: provider.id, creditMultiplier } });
    await audit(c, actorId, 'call.outbound', 'call', callId, { allowed: true, country: input.country, pooled: !own, burst });
    return { kind: 'go', provider, from, pooled: !own };

    async function defer(cc: pg.PoolClient, reason: string): Promise<Setup> {
      // Nothing is placed and no call is recorded: the dialler keeps its list and tries again.
      await logFailover(cc, { scope: 'telephony', tenantId: input.tenantId, callId, trigger: 'capacity', detail: { reason, retryAfterSeconds: RETRY_AFTER_SECONDS } });
      await recordEvent(cc, { tenantId: input.tenantId, projectId: input.projectId, callId, type: 'dial.deferred', payload: { reason } });
      return { kind: 'deferred' };
    }
  });

  if (setup.kind === 'refused') throw new AppError(setup.status, setup.message, [setup.reason]);
  if (setup.kind === 'blocked') return { callId, allowed: false as const, reason: setup.reason, status: 'blocked' };
  if (setup.kind === 'deferred') return { callId, allowed: true as const, deferred: true as const, status: 'deferred', retryAfterSeconds: RETRY_AFTER_SECONDS };

  // Outside any transaction: the provider can be slow and must not hold a database connection.
  const base = d.baseUrl;
  let { provider: p, from } = setup;
  const tried = new Set<string>();
  for (let attempt = 1; ; attempt++) {
    const started = Date.now();
    try {
      const creds = credentials<TwilioCreds & TelnyxCreds>(p, d.key);
      const placed = p.adapter_key === 'twilio'
        ? await twilioPlaceCall(creds, d.http, {
            to: input.to, from,
            answerUrl: `${base}/webhooks/twilio/${p.id}/voice?callId=${callId}`,
            statusUrl: `${base}/webhooks/twilio/${p.id}/status?callId=${callId}`,
          })
        : await telnyxPlaceCall(creds, d.http, { to: input.to, from, webhookUrl: `${base}/webhooks/telnyx/${p.id}`, callId });
      await asInternal(d, async (c) => {
        await c.query('UPDATE calls SET provider_call_id = $2 WHERE id = $1', [callId, placed.providerCallId]);
        await recordEvent(c, { tenantId: input.tenantId, projectId: input.projectId, callId, type: 'call.dialing', payload: { country: input.country } });
        await recordSample(c, { providerId: p.id, kind: 'ok', latencyMs: Date.now() - started, callId, tenantId: input.tenantId });
      });
      return { callId, allowed: true as const, status: 'dialing' };
    } catch (err) {
      const reason = redactNumbers((err as Error).message);
      tried.add(p.id);
      // The provider failed to place the call. Count it against the provider, and try another if the pool chose this one.
      const next = await asInternal(d, async (c) => {
        await recordSample(c, { providerId: p.id, kind: 'error', callId, tenantId: input.tenantId });
        // Only a definite "no" from the provider is tried elsewhere. A timeout or a reply we could not read may mean the
        // call was placed, and a second call to the same person from another number would be worse than a failed one.
        if (!(err instanceof ProviderRefused) || !setup.pooled || attempt >= MAX_DIAL_TRIES) return null;
        await c.query(`SELECT pg_advisory_xact_lock(hashtext('capacity'))`);
        const ids = (await c.query(`SELECT id FROM providers WHERE kind = 'telephony' AND status = 'active'`)).rows.map((r) => r.id as string);
        const health = await routingHealth(c, ids);
        const unhealthy = new Set(ids.filter((id) => (health.get(id) ?? 'healthy') !== 'healthy' || tried.has(id)));
        const load = await providerLoad(c, ids);
        const full = new Set(ids.filter((id) => isFull(load.get(id)!)));
        const choice = await chooseDid(c, { tenantId: input.tenantId, projectId: input.projectId, callId, country: input.country, contactHash: chash!, providerId: input.providerId, unhealthy, full });
        if (!choice.ok) return null;
        const provider = await loadProvider(c, choice.providerId);
        if (!provider || !['twilio', 'telnyx'].includes(provider.adapter_key)) return null;
        // The new provider has room (full ones were passed over), so any premium decided for the first one no longer applies.
        await c.query('UPDATE calls SET provider_id = $2, from_number_id = $3, burst = false, credit_multiplier = NULL WHERE id = $1', [callId, choice.providerId, choice.phoneNumberId]);
        await logFailover(c, { scope: 'telephony', tenantId: input.tenantId, callId, from: p.id, to: choice.providerId, trigger: 'provider_error', detail: { reason } });
        await recordEvent(c, { tenantId: input.tenantId, projectId: input.projectId, callId, type: 'failover.telephony', payload: { from: p.id, to: choice.providerId } });
        return { provider, from: choice.e164 };
      });
      if (next) { p = next.provider; from = next.from; continue; }
      await asInternal(d, async (c) => {
        await c.query(`UPDATE calls SET status = 'failed', ended_at = now(), end_reason = 'provider_error', cost_status = 'not_applicable' WHERE id = $1`, [callId]);
        await recordEvent(c, { tenantId: input.tenantId, projectId: input.projectId, callId, type: 'call.failed', payload: { reason } });
      });
      throw new AppError(502, reason);
    }
  }
}

// ---------------------------------------------------------------- webhooks
const RANK: Record<string, number> = { queued: 0, dialing: 0, ringing: 1, in_progress: 2, completed: 3, unanswered: 3, failed: 3, blocked: 3 };

interface CallRow {
  id: string; tenant_id: string; project_id: string | null; provider_id: string; direction: 'inbound' | 'outbound';
  status: string; started_at: Date; answered_at: Date | null; ended_at: Date | null; provider_call_id: string | null;
  end_reason: string | null; cost_status: string;
}

async function findCall(c: pg.PoolClient, providerId: string, ev: NormalizedEvent, hint?: string): Promise<CallRow | null> {
  const byId = hint ?? ev.callIdHint;
  if (byId && /^[0-9a-f-]{36}$/.test(byId)) {
    // FOR UPDATE: two events for one call take turns, so a call cannot be finished or priced twice.
    const r = (await c.query('SELECT * FROM calls WHERE id = $1 AND provider_id = $2 FOR UPDATE', [byId, providerId])).rows[0];
    if (r) return r;
  }
  return (await c.query('SELECT * FROM calls WHERE provider_id = $1 AND provider_call_id = $2 FOR UPDATE', [providerId, ev.providerCallId])).rows[0] ?? null;
}

async function createInbound(c: pg.PoolClient, providerId: string, ev: NormalizedEvent): Promise<CallRow | null> {
  const to = ev.transient?.to ? normalizeE164(ev.transient.to) : null;
  const n = to ? (await c.query('SELECT tenant_id, project_id, country, inbound_workflow_id FROM phone_numbers WHERE provider_id = $1 AND e164 = $2', [providerId, to])).rows[0] : null;
  if (!n) {
    // No client owns this number. Nothing identifying is recorded.
    await audit(c, null, 'inbound.unrouted', 'provider', providerId, {});
    return null;
  }
  const id = randomUUID();
  // A client has a number of simultaneous inbound channels. Beyond them a call waits, or is taken at the premium the client agreed to.
  await c.query(`SELECT pg_advisory_xact_lock(hashtext('capacity'))`);   // the same lock outbound dials use, so the two cannot both take the last channel
  const adm = await inboundAdmission(c, n.tenant_id);
  // Separately, the provider charges a premium for calls above its own concurrency limit; the call is marked so its cost says so.
  const load = (await providerLoad(c, [providerId])).get(providerId)!;
  const burst = isFull(load);
  const call = (await c.query(
    `INSERT INTO calls (id, tenant_id, project_id, provider_id, provider_call_id, direction, status, country, started_at, queued_at, burst, credit_multiplier, workflow_id)
     VALUES ($1,$2,$3,$4,$5,'inbound',$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [id, n.tenant_id, n.project_id, providerId, ev.providerCallId, adm.admit === 'queue' ? 'queued' : 'ringing', n.country, ev.occurredAt,
      adm.admit === 'queue' ? ev.occurredAt : null, burst, adm.admit === 'premium' ? adm.creditMultiplier : null, n.inbound_workflow_id],
  )).rows[0];
  await recordEvent(c, { tenantId: n.tenant_id, projectId: n.project_id ?? undefined, callId: id, type: 'call.initiated', payload: { direction: 'inbound', country: n.country }, occurredAt: ev.occurredAt });
  if (adm.admit === 'queue') await recordEvent(c, { tenantId: n.tenant_id, projectId: n.project_id ?? undefined, callId: id, type: 'call.queued', payload: { active: adm.active, channels: adm.channels }, occurredAt: ev.occurredAt });
  if (adm.admit === 'premium') await recordEvent(c, { tenantId: n.tenant_id, projectId: n.project_id ?? undefined, callId: id, type: 'call.overburst', payload: { creditMultiplier: adm.creditMultiplier }, occurredAt: ev.occurredAt });
  return call;
}

/** Price a finished call and store the result. Failing to price never loses the call or fails the webhook. */
export async function costCall(c: pg.PoolClient, actorId: string | null, callId: string): Promise<'recorded' | 'failed' | 'reconciled' | 'variance' | 'not_applicable'> {
  const call = (await c.query('SELECT * FROM calls WHERE id = $1 FOR UPDATE', [callId])).rows[0];
  if (!call) throw new AppError(404, 'Call not found.');
  if (!call.ended_at) throw new AppError(409, 'The call has not ended yet.');
  // Already priced and possibly checked: pricing again must not wipe a reconciled or variance flag.
  // A call that never connected has nothing to price, and re-pricing must not invent a cost for it.
  if (['recorded', 'reconciled', 'variance', 'not_applicable'].includes(call.cost_status)) return call.cost_status;
  try {
    await recordCallCost(c, actorId, {
      callId, tenantId: call.tenant_id, projectId: call.project_id ?? undefined, direction: call.direction,
      occurredAt: call.started_at, creditMultiplier: call.credit_multiplier ?? undefined,
      // A caller who gave up in the queue was never served: the provider time is costed, no credits are drawn. A caller who
      // waited and was then served pays credits only from the moment they were.
      drawCredits: !call.no_credit,
      creditSkipSeconds: call.credit_from && call.answered_at ? Math.max(0, (new Date(call.credit_from).getTime() - new Date(call.answered_at).getTime()) / 1000) : 0,
      usage: [{ providerId: call.provider_id, usage: { seconds: Number(call.duration_seconds ?? 0), burst: call.burst } }],
    });
    await c.query(`UPDATE calls SET cost_status = 'recorded', cost_error = NULL WHERE id = $1`, [callId]);
    return 'recorded';
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    await c.query(`UPDATE calls SET cost_status = 'failed', cost_error = $2 WHERE id = $1`, [callId, err.message]);
    await recordEvent(c, { tenantId: call.tenant_id, projectId: call.project_id ?? undefined, callId, type: 'call.cost_failed', payload: { reason: err.message } });
    return 'failed';
  }
}

async function applyEvent(c: pg.PoolClient, provider: ProviderRow, ev: NormalizedEvent, hint?: string, contactKey?: Buffer):
  Promise<{ duplicate: boolean; actions: Action[] }> {
  const fresh = await c.query('INSERT INTO webhook_events (provider_id, event_key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [provider.id, ev.key]);
  if (!fresh.rowCount) return { duplicate: true, actions: [] };

  let call = await findCall(c, provider.id, ev, hint);
  let routed = true;
  if (!call && ev.kind === 'initiated' && ev.direction === 'inbound') {
    call = await createInbound(c, provider.id, ev);
    routed = call !== null;
    // A caller with an open case is recognised by the keyed hash of their number, so the call can carry on where the case left off.
    const from = ev.transient?.from ? normalizeE164(ev.transient.from) : null;
    if (call && from && contactKey) { const inbound = call; await safely(c, 'recognise_inbound', () => recogniseInbound(c, inbound, contactHash(from, contactKey))); }
  }
  const isTelnyx = provider.adapter_key === 'telnyx';
  if (!call) {
    if (ev.kind !== 'initiated') await audit(c, null, 'webhook.unknown_call', 'provider', provider.id, { kind: ev.kind });
    return { duplicate: false, actions: isTelnyx ? telnyxNextActions(ev, routed) : routed ? [] : [{ type: 'reject' }] };
  }
  if (!call.provider_call_id) await c.query('UPDATE calls SET provider_call_id = $2 WHERE id = $1', [call.id, ev.providerCallId]);

  const log = (type: string, payload: Record<string, unknown> = {}) =>
    recordEvent(c, { tenantId: call!.tenant_id, projectId: call!.project_id ?? undefined, callId: call!.id, type, payload, occurredAt: ev.occurredAt });
  const moveTo = async (status: string) => {
    if (call!.status === 'queued') return; // a caller waiting for a channel stays queued until a channel frees
    if ((RANK[status] ?? 0) > (RANK[call!.status] ?? 0)) {
      await c.query('UPDATE calls SET status = $2 WHERE id = $1', [call!.id, status]);
      call!.status = status;
    }
  };

  switch (ev.kind) {
    case 'ringing': await moveTo('ringing'); await log('call.ringing'); break;
    case 'answered':
      await c.query('UPDATE calls SET answered_at = coalesce(answered_at, $2) WHERE id = $1', [call.id, ev.occurredAt]);
      call.answered_at = call.answered_at ?? ev.occurredAt;
      await moveTo('in_progress'); await log('call.answered'); break;
    case 'ended': {
      if (call.ended_at) {
        // A caller who was timed out of the queue is hung up on afterwards: when the provider reports the end, the time
        // they spent on the line is costed (provider side only; they were never served, so no credits).
        if (call.end_reason === 'queue_timeout' && call.cost_status === 'pending') {
          const held = ev.durationSeconds ?? (call.answered_at ? Math.max(0, (ev.occurredAt.getTime() - call.answered_at.getTime()) / 1000) : 0);
          await c.query('UPDATE calls SET duration_seconds = $2 WHERE id = $1', [call.id, held]);
          await log('call.ended', { status: call.status, reason: 'queue_timeout', durationSeconds: held });
          await costCall(c, null, call.id);
        }
        break; // otherwise already finished; a late duplicate must not reopen or re-price it
      }
      const wasQueued = call.status === 'queued';   // hung up while waiting: never served, whatever the hold message cost
      const answered = call.answered_at !== null || (ev.durationSeconds ?? 0) > 0;
      const seconds = ev.durationSeconds
        ?? (call.answered_at ? Math.max(0, (ev.occurredAt.getTime() - call.answered_at.getTime()) / 1000) : 0);
      const status = wasQueued ? 'unanswered' : answered ? 'completed' : ev.endReason === 'failed' ? 'failed' : 'unanswered';
      await c.query(
        `UPDATE calls SET status = $2, ended_at = $3, duration_seconds = $4, end_reason = $5, no_credit = $6 WHERE id = $1`,
        [call.id, status, ev.occurredAt, seconds, wasQueued ? 'abandoned_in_queue' : ev.endReason ?? 'completed', wasQueued],
      );
      call.status = status;
      await log('call.ended', { status, reason: ev.endReason ?? 'completed', durationSeconds: seconds });
      await recordCallEnd(c, call, { endReason: ev.endReason, occurredAt: ev.occurredAt, answered });
      await settleTransferOnEnd(c, call.id);
      const ended = call;
      await safely(c, 'case_call_ended', () => caseCallEnded(c, { id: ended.id, started_at: ended.started_at, answered_at: ended.answered_at, duration_seconds: seconds }, ev.endReason));
      await costCall(c, null, call.id);
      // A channel has freed: whoever has waited longest moves up.
      if (call.direction === 'inbound') await promoteQueued(c, call.tenant_id);
      break;
    }
    case 'speak_ended': await log('call.speak_ended'); break;
    case 'initiated': break; // inbound calls were logged when the row was created
  }
  const actions = isTelnyx ? telnyxNextActions(ev, routed, call.status === 'queued') : [];
  return { duplicate: false, actions };
}

/** Process a verified webhook. Provider commands run after the database work has committed. */
export async function processWebhook(d: CallDeps, provider: ProviderRow, ev: NormalizedEvent, hint?: string) {
  const out = await asInternal(d, (c) => applyEvent(c, provider, ev, hint, contactKeyFrom(d.key)));
  if (out.actions.length && provider.adapter_key === 'telnyx') {
    const creds = credentials<TelnyxCreds>(provider, d.key);
    for (const a of out.actions) {
      if (a.type !== 'telnyx') continue;
      try { await telnyxCommand(creds, d.http, a); }
      catch (err) {
        // The event is already stored and acknowledged; the failed command is recorded, not retried blindly.
        await asInternal(d, async (c) => {
          const call = await findCall(c, provider.id, ev, hint);
          if (call) await recordEvent(c, { tenantId: call.tenant_id, projectId: call.project_id ?? undefined, callId: call.id, type: 'call.command_failed', payload: { action: a.action, reason: redactNumbers((err as Error).message) } });
        });
      }
    }
  }
  return out;
}

export const getCall = async (c: pg.PoolClient, callId: string) => {
  const r = (await c.query(
    `SELECT id, tenant_id, project_id, provider_id, direction, status, country, started_at, answered_at, ended_at,
            duration_seconds, end_reason, cost_status, cost_error FROM calls WHERE id = $1`, [callId])).rows[0];
  if (!r) throw new AppError(404, 'Call not found.');
  return r;
};

/** Whether Voice Lab knows this provider call, used to decide between answering and rejecting a Twilio voice request. */
/** Whether an inbound call is waiting for a free channel, so it should hear a hold message rather than be served. */
export const callQueued = (d: CallDeps, providerId: string, providerCallId: string) =>
  asInternal(d, async (c) =>
    (await c.query(`SELECT 1 FROM calls WHERE provider_id = $1 AND provider_call_id = $2 AND status = 'queued'`, [providerId, providerCallId])).rowCount === 1);

/** The call to hand to the speech relay: one we know, still open, with a workflow to run. Null otherwise. */
export const relayTarget = (d: CallDeps, providerId: string, providerCallId: string) =>
  asInternal(d, async (c) =>
    ((await c.query(`SELECT id FROM calls WHERE provider_id = $1 AND provider_call_id = $2 AND workflow_id IS NOT NULL AND status IN ('ringing', 'in_progress', 'dialing')`,
      [providerId, providerCallId])).rows[0]?.id as string | undefined) ?? null);

export const callKnown = (d: CallDeps, providerId: string, providerCallId: string) =>
  asInternal(d, async (c) =>
    (await c.query('SELECT 1 FROM calls WHERE provider_id = $1 AND provider_call_id = $2', [providerId, providerCallId])).rowCount === 1);

export const listCalls = async (c: pg.PoolClient, o: { limit: number; status?: string; tenantId?: string }) =>
  (await c.query(
    `SELECT id, tenant_id, project_id, provider_id, direction, status, country, started_at, answered_at, ended_at,
            duration_seconds, end_reason, cost_status FROM calls
      WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR tenant_id = $2)
      ORDER BY started_at DESC LIMIT $3`, [o.status ?? null, o.tenantId ?? null, o.limit])).rows;

/** Hang up calls that are still on the line (callers timed out of the queue). A failure is recorded, not fatal. */
export async function hangUpCalls(d: CallDeps, calls: { providerId: string; providerCallId: string; callId: string; tenantId: string }[]) {
  let hungUp = 0;
  for (const k of calls) {
    try {
      const p = await asInternal(d, (c) => loadProvider(c, k.providerId));
      if (!p) continue;
      if (p.adapter_key === 'telnyx') await telnyxCommand(credentials<TelnyxCreds>(p, d.key), d.http, { type: 'telnyx', action: 'hangup', callControlId: k.providerCallId });
      else if (p.adapter_key === 'twilio') await twilioHangup(credentials<TwilioCreds>(p, d.key), d.http, k.providerCallId);
      else continue;
      hungUp++;
    } catch (err) {
      await asInternal(d, (c) => recordEvent(c, { tenantId: k.tenantId, callId: k.callId, type: 'call.command_failed', payload: { action: 'hangup', reason: redactNumbers((err as Error).message) } }));
    }
  }
  return hungUp;
}
