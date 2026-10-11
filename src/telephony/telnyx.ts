import { createPublicKey, verify } from 'node:crypto';
import { fromScaled, toScaled } from '../money.js';
import { ProviderRefused, redactNumbers, sipCode, HOLD_MESSAGE, TEST_CALL_MESSAGE, type Action, type Fetch, type NormalizedEvent } from './types.js';

const API = 'https://api.telnyx.com/v2';

export interface TelnyxCreds { apiKey: string; connectionId?: string; webhookPublicKey?: string }

async function post(c: TelnyxCreds, http: Fetch, path: string, body: unknown): Promise<{ ok: boolean; status: number; json: any }> {
  let res: Response;
  try {
    res = await http(`${API}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${c.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`Could not reach Telnyx: ${redactNumbers((err as Error).message)}`);
  }
  return { ok: res.ok, status: res.status, json: await res.json().catch(() => null) };
}

/** Start an outbound call. Our call id rides along as client_state and comes back on every event. */
export async function telnyxPlaceCall(
  c: TelnyxCreds, http: Fetch,
  e: { to: string; from: string; webhookUrl: string; callId: string },
): Promise<{ providerCallId: string }> {
  if (!c.connectionId) throw new Error('This Telnyx provider has no Voice API Application (connection) ID set.');
  const r = await post(c, http, '/calls', {
    connection_id: c.connectionId, to: e.to, from: e.from, webhook_url: e.webhookUrl,
    client_state: Buffer.from(e.callId).toString('base64'),
  });
  const id = r.json?.data?.call_control_id;
  if (!r.ok) {
    const detail = r.json?.errors?.[0]?.detail;
    throw new ProviderRefused(`Telnyx refused the call (HTTP ${r.status})${detail ? `: ${redactNumbers(String(detail))}` : ''}`);
  }
  if (!id) throw new Error(`Telnyx answered (HTTP ${r.status}) without a call id`);
  return { providerCallId: id };
}

/** Run a call-control command (answer, speak, hangup, reject) on a live call. */
export async function telnyxCommand(c: TelnyxCreds, http: Fetch, a: Extract<Action, { type: 'telnyx' }>): Promise<void> {
  const r = await post(c, http, `/calls/${encodeURIComponent(a.callControlId)}/actions/${a.action}`, a.body ?? {});
  if (!r.ok) throw new Error(`Telnyx ${a.action} failed (HTTP ${r.status})`);
}

// DER prefix that wraps a raw 32-byte Ed25519 public key as SubjectPublicKeyInfo.
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Telnyx signs `<timestamp>|<raw body>` with Ed25519 and sends the signature and timestamp in
 * the `telnyx-signature-ed25519` and `telnyx-timestamp` headers. The timestamp must be recent,
 * so a captured request cannot be replayed later.
 */
export function verifyTelnyxSignature(e: {
  publicKeyBase64: string; signatureBase64: string | undefined; timestamp: string | undefined;
  rawBody: string; nowMs?: number; toleranceSeconds?: number;
}): boolean {
  if (!e.signatureBase64 || !e.timestamp) return false;
  const raw = Buffer.from(e.publicKeyBase64, 'base64');
  if (raw.length !== 32) return false;
  const ts = Number(e.timestamp);
  if (!Number.isFinite(ts) || Math.abs((e.nowMs ?? Date.now()) / 1000 - ts) > (e.toleranceSeconds ?? 300)) return false;
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(`${e.timestamp}|${e.rawBody}`), key, Buffer.from(e.signatureBase64, 'base64'));
  } catch { return false; }
}

const HANGUP: Record<string, NormalizedEvent['endReason']> = {
  normal_clearing: 'completed', user_busy: 'busy', no_answer: 'no_answer', originator_cancel: 'canceled',
  call_rejected: 'rejected', timeout: 'no_answer',
};

/** Turn a Telnyx webhook body into a Voice Lab event, or null for event types we do not track. */
export function parseTelnyx(body: any): NormalizedEvent | null {
  const d = body?.data;
  const p = d?.payload;
  if (!d?.event_type || !p?.call_control_id || !d.id) return null;
  const hint = (() => {
    try { return p.client_state ? Buffer.from(p.client_state, 'base64').toString('utf8') : undefined; } catch { return undefined; }
  })();
  const base = {
    key: String(d.id), providerCallId: String(p.call_control_id),
    occurredAt: new Date(d.occurred_at ?? p.end_time ?? p.start_time ?? Date.now()),
    callIdHint: hint, transient: { from: p.from, to: p.to },
  };
  switch (d.event_type) {
    case 'call.initiated': return { ...base, kind: 'initiated', direction: p.direction === 'incoming' ? 'inbound' : 'outbound' };
    case 'call.answered': return { ...base, kind: 'answered' };
    case 'call.speak.ended': return { ...base, kind: 'speak_ended' };
    // sip_hangup_cause is in Telnyx's published API description (CallHangup); "unspecified" when there was none.
    case 'call.hangup': return { ...base, kind: 'ended', endReason: HANGUP[String(p.hangup_cause)] ?? 'failed', sipCode: sipCode(p.sip_hangup_cause) };
    default: return null;
  }
}

/** What to do next on a Telnyx call. Telnyx is driven by commands, not by a TwiML reply. */
export function telnyxNextActions(ev: NormalizedEvent, inboundRouted: boolean, queued = false, servedFromQueue = false): Action[] {
  const id = ev.providerCallId;
  if (ev.kind === 'initiated' && ev.direction === 'inbound') {
    return [inboundRouted ? { type: 'telnyx', action: 'answer', callControlId: id } : { type: 'telnyx', action: 'reject', callControlId: id, body: { cause: 'CALL_REJECTED' } }];
  }
  if (ev.kind === 'answered') {
    return [{ type: 'telnyx', action: 'speak', callControlId: id, body: { payload: queued ? HOLD_MESSAGE : TEST_CALL_MESSAGE, voice: 'female', language: 'en-US' } }];
  }
  // A caller waiting for a channel is not hung up on: the hold message is said again.
  if (ev.kind === 'speak_ended' && queued) return [{ type: 'telnyx', action: 'speak', callControlId: id, body: { payload: HOLD_MESSAGE, voice: 'female', language: 'en-US' } }];
  // A caller whose turn has just come is served, not hung up on when the hold message they were hearing ends.
  if (ev.kind === 'speak_ended' && servedFromQueue) return [{ type: 'telnyx', action: 'speak', callControlId: id, body: { payload: TEST_CALL_MESSAGE, voice: 'female', language: 'en-US' } }];
  if (ev.kind === 'speak_ended') return [{ type: 'telnyx', action: 'hangup', callControlId: id }];
  return [];
}

/** What Telnyx says it charged for one call leg, from its signed `call.cost` webhook. */
export type TelnyxCostReport = {
  key: string; providerCallId: string; callIdHint?: string; occurredAt: Date | null;
} & ({ status: 'ready'; billedSeconds: number | null; amounts: { cost: string; currency: string }[] } | { status: 'error' });

const DECIMAL = /^[0-9]{1,12}(\.[0-9]{1,8})?$/;
const CURRENCY = /^[A-Z]{3}$/;

/**
 * Read a `call.cost` webhook, or null for any other event. The shape is Telnyx's own published API description
 * (team-telnyx/openapi, spec3.json: the `callCost` webhook, schemas CallCost and CallCostPart), kept as
 * `tests/fixtures/telnyx-call-cost.json`; not yet checked against a live call (lesson L-016).
 *
 * The cost is taken from its parts, each in its own currency, so nothing is assumed about the currency of the total; a
 * report whose parts do not add up to its total, or that is in a form we do not recognise, is refused, never guessed.
 */
export function parseTelnyxCost(body: any): TelnyxCostReport | null {
  const d = body?.data;
  if (d?.event_type !== 'call.cost') return null;
  const p = d.payload;
  if (!d.id || !p?.call_control_id) throw new Error('Telnyx sent a call cost with no event or call id.');
  const hint = (() => {
    try { return p.client_state ? Buffer.from(String(p.client_state), 'base64').toString('utf8') : undefined; } catch { return undefined; }
  })();
  const at = new Date(d.occurred_at ?? p.occurred_at ?? NaN);
  const base = { key: String(d.id), providerCallId: String(p.call_control_id), callIdHint: hint, occurredAt: Number.isNaN(at.getTime()) ? null : at };
  if (p.status === 'error') return { ...base, status: 'error' };
  if (p.status !== 'success') throw new Error('Telnyx sent a call cost with a status Voice Lab does not recognise.');
  const parts: unknown[] = Array.isArray(p.cost_parts) ? p.cost_parts : [];
  const sums = new Map<string, bigint>();
  for (const part of parts) {
    const { cost, currency } = (part ?? {}) as { cost?: unknown; currency?: unknown };
    const cur = typeof currency === 'string' ? currency.toUpperCase() : '';
    if (typeof cost !== 'string' || !DECIMAL.test(cost) || !CURRENCY.test(cur)) throw new Error('Telnyx sent a cost part in a form Voice Lab does not recognise.');
    sums.set(cur, (sums.get(cur) ?? 0n) + toScaled(cost));
  }
  const total = p.total_cost === null || p.total_cost === undefined ? null : String(p.total_cost);
  if (total !== null && !DECIMAL.test(total)) throw new Error('Telnyx sent a call total in a form Voice Lab does not recognise.');
  // With every part in one currency, the parts must add up to the total; a report that does not agree with itself is not used.
  if (total !== null && sums.size === 1 && [...sums.values()][0] !== toScaled(total)) throw new Error('Telnyx sent a call cost whose parts do not add up to its total.');
  // A total with no parts says nothing about its currency: only a total of nothing can be read without one.
  if (sums.size === 0 && total !== null && toScaled(total) !== 0n) throw new Error('Telnyx sent a call total with no parts, so its currency is unknown.');
  const secs = p.billed_duration_secs;
  if (secs !== null && secs !== undefined && !(Number.isInteger(secs) && secs >= 0 && secs < 10_000_000)) throw new Error('Telnyx sent a billed duration Voice Lab does not recognise.');
  return { ...base, status: 'ready', billedSeconds: secs ?? null, amounts: [...sums].map(([currency, v]) => ({ cost: fromScaled(v), currency })) };
}
