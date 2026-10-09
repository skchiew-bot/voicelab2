import { createHmac, timingSafeEqual } from 'node:crypto';
import { redactNumbers, HOLD_MESSAGE, TEST_CALL_MESSAGE, type Fetch, type NormalizedEvent } from './types.js';

const basic = (user: string, pass: string) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

export interface TwilioCreds { accountSid: string; authToken?: string; apiKeySid?: string; apiKeySecret?: string }

export function twilioAuth(c: TwilioCreds): string {
  return c.authToken ? basic(c.accountSid, c.authToken) : basic(String(c.apiKeySid), String(c.apiKeySecret));
}

/** Start an outbound call. Twilio fetches TwiML from `answerUrl` when the callee picks up. */
export async function twilioPlaceCall(
  c: TwilioCreds, http: Fetch,
  e: { to: string; from: string; answerUrl: string; statusUrl: string },
): Promise<{ providerCallId: string }> {
  const form = new URLSearchParams({ To: e.to, From: e.from, Url: e.answerUrl, StatusCallback: e.statusUrl, StatusCallbackMethod: 'POST' });
  for (const ev of ['initiated', 'ringing', 'answered', 'completed']) form.append('StatusCallbackEvent', ev);
  let res: Response;
  try {
    res = await http(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}/Calls.json`, {
      method: 'POST',
      headers: { authorization: twilioAuth(c), 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`Could not reach Twilio: ${redactNumbers((err as Error).message)}`);
  }
  const body = (await res.json().catch(() => null)) as { sid?: string; message?: string } | null;
  if (!res.ok || !body?.sid) {
    throw new Error(`Twilio refused the call (HTTP ${res.status})${body?.message ? `: ${redactNumbers(body.message)}` : ''}`);
  }
  return { providerCallId: body.sid };
}

/**
 * Twilio signs the full URL plus every POST parameter (sorted by name, name then value
 * concatenated) with HMAC-SHA1, keyed by the account's Auth Token, then base64.
 * An API key secret cannot verify signatures, so this needs the Auth Token.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', authToken).update(data).digest('base64');
}

export function verifyTwilioSignature(authToken: string, url: string, params: Record<string, string>, header: string | undefined): boolean {
  if (!header) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

const REASONS: Record<string, NormalizedEvent['endReason']> = {
  completed: 'completed', busy: 'busy', 'no-answer': 'no_answer', canceled: 'canceled', failed: 'failed',
};

/** Turn a Twilio status callback or voice request into a Voice Lab event, or null if it carries nothing we track. */
export function parseTwilio(params: Record<string, string>, callIdHint?: string, isVoiceRequest = false, now = new Date()): NormalizedEvent | null {
  const sid = params.CallSid;
  if (!sid) return null;
  const status = params.CallStatus ?? 'initiated';
  const direction = params.Direction === 'inbound' ? 'inbound' : 'outbound';
  const base = { providerCallId: sid, direction, occurredAt: now, callIdHint, transient: { from: params.From, to: params.To } } as const;
  // A new inbound call first arrives as a request for instructions (status "ringing"): that is its start.
  if (isVoiceRequest && direction === 'inbound') return { ...base, key: `${sid}:voice`, kind: 'initiated' };
  const key = `${sid}:${status}`;
  if (status === 'initiated' || status === 'queued') return { ...base, key, kind: 'initiated' };
  if (status === 'ringing') return { ...base, key, kind: 'ringing' };
  if (status === 'in-progress') return { ...base, key, kind: 'answered' };
  const endReason = REASONS[status];
  if (!endReason) return null;
  const duration = Number(params.CallDuration);
  return { ...base, key, kind: 'ended', endReason, durationSeconds: Number.isFinite(duration) ? duration : 0 };
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const twimlTestCall = () =>
  `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xml(TEST_CALL_MESSAGE)}</Say><Hangup/></Response>`;
export const twimlHold = () =>
  `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${xml(HOLD_MESSAGE)}</Say><Pause length="60"/></Response>`;
export const twimlReject = () => `<?xml version="1.0" encoding="UTF-8"?><Response><Reject/></Response>`;

export type CallUsage = { state: 'pending' } | { state: 'ready'; seconds: number; cost: string; currency: string };

/**
 * What Twilio itself says a call lasted and cost. The price appears some time after the call ends, so
 * "pending" means ask again later. Twilio reports charges as negative numbers; this returns the amount.
 */
export async function twilioFetchCallUsage(c: TwilioCreds, http: Fetch, callSid: string): Promise<CallUsage> {
  let res: Response;
  try {
    res = await http(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}/Calls/${encodeURIComponent(callSid)}.json`, {
      method: 'GET', headers: { authorization: twilioAuth(c) }, signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new Error(`Could not reach Twilio: ${redactNumbers((err as Error).message)}`);
  }
  if (!res.ok) throw new Error(`Twilio would not return that call (HTTP ${res.status}).`);
  const b = (await res.json().catch(() => null)) as { duration?: string | null; price?: string | null; price_unit?: string | null } | null;
  if (!b || b.price === null || b.price === undefined || b.price === '' || b.duration === null || b.duration === undefined) return { state: 'pending' };
  const cost = String(b.price).replace(/^-/, '');
  if (!/^\d+(\.\d+)?$/.test(cost) || !/^\d+$/.test(String(b.duration))) throw new Error('Twilio returned a call record in a format Voice Lab does not recognise.');
  return { state: 'ready', seconds: Number(b.duration), cost, currency: (b.price_unit ?? 'USD').toUpperCase() };
}
