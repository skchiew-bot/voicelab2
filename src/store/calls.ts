import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Fetch } from '../adapters/types.js';
import { withActor } from '../db.js';
import { AppError } from '../errors.js';
import { decryptSecrets } from '../secrets.js';
import { telnyxCommand, telnyxNextActions, telnyxPlaceCall, type TelnyxCreds } from '../telephony/telnyx.js';
import { twilioPlaceCall, type TwilioCreds } from '../telephony/twilio.js';
import { redactNumbers, type Action, type NormalizedEvent } from '../telephony/types.js';
import { audit } from './audit.js';
import { recordCallCost } from './costs.js';
import { chooseDid, didLockedFor } from './dids.js';
import { contactHash, contactKeyFrom, gateOutbound, normalizeE164 } from './dnc.js';
import { recordEvent } from './events.js';

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
  (await c.query('SELECT id, provider_id, e164, tenant_id, project_id, country, label FROM phone_numbers ORDER BY e164')).rows;

// --------------------------------------------------------------- outbound
export interface PlaceInput { tenantId: string; projectId?: string; providerId?: string; from?: string; to: string; country: string }

/**
 * Place an outbound call. The do-not-call gate runs first and the provider is never contacted for
 * a blocked number. Then the DID check picks the caller ID (or checks the one named): a DID that has ever failed for
 * this contact is never used for them again. The customer's number is passed to the provider and not kept; only a
 * keyed hash of it is, so the pool can remember which DIDs failed for whom.
 */
export async function placeOutboundCall(d: CallDeps, actorId: string, input: PlaceInput) {
  if (!d.baseUrl) throw new AppError(503, 'PUBLIC_BASE_URL is not set, so providers cannot reach this server. Set it to place calls.');
  const callId = randomUUID();
  const named = input.from === undefined ? null : normalizeE164(input.from);
  if (input.from !== undefined && !named) throw new AppError(400, '"from" must be in international format.');
  const toNumber = normalizeE164(input.to);
  const chash = toNumber ? contactHash(toNumber, contactKeyFrom(d.key)) : null;

  const setup = await asInternal(d, async (c) => {
    if (input.providerId) {
      const named = await loadProvider(c, input.providerId);
      if (!named) throw new AppError(404, 'Provider not found.');
      if (named.kind !== 'telephony' || named.status !== 'active') throw new AppError(400, 'That provider cannot place calls.');
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
    const decision = await gateOutbound(c, d.dncKey, { tenantId: input.tenantId, projectId: input.projectId, callId, country: input.country, to: input.to });
    const insertCall = (providerId: string, status: string, fromId: string | null, reason?: string) => c.query(
      `INSERT INTO calls (id, tenant_id, project_id, provider_id, direction, status, country, cost_status, from_number_id, contact_hash, end_reason, ended_at)
       VALUES ($1,$2,$3,$4,'outbound',$5,$6,$7,$8,$9,$10, CASE WHEN $5 = 'dialing' THEN NULL ELSE now() END)`,
      // A call that never connects (blocked, no usable caller ID) has nothing to price.
      [callId, input.tenantId, input.projectId ?? null, providerId, status, input.country, status === 'dialing' ? 'pending' : 'not_applicable', fromId, chash, reason ?? null]);

    if (!decision.allowed) {
      const providerId = own?.provider_id ?? input.providerId ?? (await c.query(`SELECT id FROM providers WHERE kind = 'telephony' ORDER BY created_at LIMIT 1`)).rows[0]?.id;
      if (!providerId) throw new AppError(400, 'No telephony provider is set up.');
      await insertCall(providerId, 'blocked', own?.id ?? null);
      await audit(c, actorId, 'call.outbound', 'call', callId, { allowed: false, country: input.country });
      return { decision, refused: null, provider: null, from: '' };
    }

    // The DID check: after the do-not-call gate, before the provider is contacted.
    let from = own?.e164 ?? '';
    let fromId = own?.id ?? null; let providerId = own?.provider_id ?? input.providerId ?? null;
    let refusal: { reason: string; message: string } | null = null;
    if (!chash) throw new AppError(400, 'The number to dial is not valid.'); // unreachable: the gate blocks an invalid number
    if (own) {
      if (await didLockedFor(c, input.tenantId, own.id, chash)) refusal = { reason: 'did_locked', message: 'That caller ID has failed for this contact before and is locked away from them. Choose another, or let the pool choose.' };
    } else {
      const choice = await chooseDid(c, { tenantId: input.tenantId, projectId: input.projectId, callId, country: input.country, contactHash: chash, providerId: input.providerId });
      if (choice.ok) { from = choice.e164; fromId = choice.phoneNumberId; providerId = choice.providerId; }
      else refusal = { reason: choice.reason, message: choice.reason === 'all_locked_for_contact' ? 'Every number in the pool has failed for this contact before, so none can be used for them.' : 'There is no active number in this country for that client to dial from.' };
    }
    if (refusal) {
      const fallback = providerId ?? (await c.query(`SELECT id FROM providers WHERE kind = 'telephony' ORDER BY created_at LIMIT 1`)).rows[0]?.id;
      if (!fallback) throw new AppError(400, 'No telephony provider is set up.');
      await insertCall(fallback, 'failed', fromId, refusal.reason);
      await recordEvent(c, { tenantId: input.tenantId, projectId: input.projectId, callId, type: 'call.failed', payload: { reason: refusal.reason } });
      await audit(c, actorId, 'call.outbound', 'call', callId, { allowed: true, refused: refusal.reason, country: input.country });
      return { decision, refused: refusal, provider: null, from: '' };
    }
    const provider = await loadProvider(c, providerId!);
    if (!provider) throw new AppError(404, 'Provider not found.');
    if (provider.kind !== 'telephony' || provider.status !== 'active') throw new AppError(400, 'That provider cannot place calls.');
    if (!['twilio', 'telnyx'].includes(provider.adapter_key)) throw new AppError(400, 'That provider has no call control.');
    await insertCall(provider.id, 'dialing', fromId);
    await audit(c, actorId, 'call.outbound', 'call', callId, { allowed: true, country: input.country, pooled: !own });
    return { decision, refused: null, provider, from };
  });

  if (setup.refused) throw new AppError(409, setup.refused.message, [setup.refused.reason]);
  if (!setup.decision.allowed) return { callId, allowed: false as const, reason: setup.decision.reason, status: 'blocked' };

  // Outside any transaction: the provider can be slow and must not hold a database connection.
  const base = d.baseUrl;
  try {
    const p = setup.provider!;
    const from = setup.from;
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
    });
    return { callId, allowed: true as const, status: 'dialing' };
  } catch (err) {
    const reason = redactNumbers((err as Error).message);
    await asInternal(d, async (c) => {
      await c.query(`UPDATE calls SET status = 'failed', ended_at = now(), end_reason = 'provider_error', cost_status = 'not_applicable' WHERE id = $1`, [callId]);
      await recordEvent(c, { tenantId: input.tenantId, projectId: input.projectId, callId, type: 'call.failed', payload: { reason } });
    });
    throw new AppError(502, reason);
  }
}

// ---------------------------------------------------------------- webhooks
const RANK: Record<string, number> = { dialing: 0, ringing: 1, in_progress: 2, completed: 3, unanswered: 3, failed: 3, blocked: 3 };

interface CallRow {
  id: string; tenant_id: string; project_id: string | null; provider_id: string; direction: 'inbound' | 'outbound';
  status: string; started_at: Date; answered_at: Date | null; ended_at: Date | null; provider_call_id: string | null;
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
  const n = to ? (await c.query('SELECT tenant_id, project_id, country FROM phone_numbers WHERE provider_id = $1 AND e164 = $2', [providerId, to])).rows[0] : null;
  if (!n) {
    // No client owns this number. Nothing identifying is recorded.
    await audit(c, null, 'inbound.unrouted', 'provider', providerId, {});
    return null;
  }
  const id = randomUUID();
  const call = (await c.query(
    `INSERT INTO calls (id, tenant_id, project_id, provider_id, provider_call_id, direction, status, country, started_at)
     VALUES ($1,$2,$3,$4,$5,'inbound','ringing',$6,$7) RETURNING *`,
    [id, n.tenant_id, n.project_id, providerId, ev.providerCallId, n.country, ev.occurredAt],
  )).rows[0];
  await recordEvent(c, { tenantId: n.tenant_id, projectId: n.project_id ?? undefined, callId: id, type: 'call.initiated', payload: { direction: 'inbound', country: n.country }, occurredAt: ev.occurredAt });
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
      occurredAt: call.started_at, usage: [{ providerId: call.provider_id, usage: { seconds: Number(call.duration_seconds ?? 0) } }],
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

async function applyEvent(c: pg.PoolClient, provider: ProviderRow, ev: NormalizedEvent, hint?: string):
  Promise<{ duplicate: boolean; actions: Action[] }> {
  const fresh = await c.query('INSERT INTO webhook_events (provider_id, event_key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [provider.id, ev.key]);
  if (!fresh.rowCount) return { duplicate: true, actions: [] };

  let call = await findCall(c, provider.id, ev, hint);
  let routed = true;
  if (!call && ev.kind === 'initiated' && ev.direction === 'inbound') {
    call = await createInbound(c, provider.id, ev);
    routed = call !== null;
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
      if (call.ended_at) break; // already finished; a late duplicate must not reopen or re-price it
      const answered = call.answered_at !== null || (ev.durationSeconds ?? 0) > 0;
      const seconds = ev.durationSeconds
        ?? (call.answered_at ? Math.max(0, (ev.occurredAt.getTime() - call.answered_at.getTime()) / 1000) : 0);
      const status = answered ? 'completed' : ev.endReason === 'failed' ? 'failed' : 'unanswered';
      await c.query(
        `UPDATE calls SET status = $2, ended_at = $3, duration_seconds = $4, end_reason = $5 WHERE id = $1`,
        [call.id, status, ev.occurredAt, seconds, ev.endReason ?? 'completed'],
      );
      call.status = status;
      await log('call.ended', { status, reason: ev.endReason ?? 'completed', durationSeconds: seconds });
      await costCall(c, null, call.id);
      break;
    }
    case 'speak_ended': await log('call.speak_ended'); break;
    case 'initiated': break; // inbound calls were logged when the row was created
  }
  const actions = isTelnyx ? telnyxNextActions(ev, routed) : [];
  return { duplicate: false, actions };
}

/** Process a verified webhook. Provider commands run after the database work has committed. */
export async function processWebhook(d: CallDeps, provider: ProviderRow, ev: NormalizedEvent, hint?: string) {
  const out = await asInternal(d, (c) => applyEvent(c, provider, ev, hint));
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
export const callKnown = (d: CallDeps, providerId: string, providerCallId: string) =>
  asInternal(d, async (c) =>
    (await c.query('SELECT 1 FROM calls WHERE provider_id = $1 AND provider_call_id = $2', [providerId, providerCallId])).rowCount === 1);

export const listCalls = async (c: pg.PoolClient, o: { limit: number; status?: string; tenantId?: string }) =>
  (await c.query(
    `SELECT id, tenant_id, project_id, provider_id, direction, status, country, started_at, answered_at, ended_at,
            duration_seconds, end_reason, cost_status FROM calls
      WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR tenant_id = $2)
      ORDER BY started_at DESC LIMIT $3`, [o.status ?? null, o.tenantId ?? null, o.limit])).rows;
