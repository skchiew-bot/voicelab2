/**
 * Putting a live caller through to a person, over Twilio. These are the pure parts: the TwiML that dials the client's
 * agent, the whisper the agent hears before being connected, and how the end of the dial is read.
 *
 * The TwiML attributes (`<Connect action>`, `<Dial action timeout callerId>`, `<Number url>`) come from Twilio's own
 * published package (`twilio` 6.1.2, lib/twiml/VoiceResponse.d.ts); the end-of-session request and its fields from
 * Twilio's `twilio-agent-connect` 2.4.0 (ConversationRelayCallbackPayloadSchema). The values `DialCallStatus` takes are
 * not in either package: they are taken to match the call statuses in that schema. Kept in
 * `tests/fixtures/twilio-transfer.json`; not yet checked against a live call (lesson L-016). `<Gather action numDigits
 * timeout>` is from the same TwiML package.
 */

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const E164 = /^\+[1-9][0-9]{7,14}$/;
const DOC = '<?xml version="1.0" encoding="UTF-8"?>';

/**
 * Where an agent phone may be. For now only Malaysian numbers (+60), so a changed setting cannot send the agent's leg,
 * which we pay for, to an expensive destination abroad (toll fraud). Every +60 number is allowed, including the 1-300,
 * 1-700, 1-800 and 1-900 ranges (owner's decision, 2026-10-11). Checked when the number is set and again at dial time.
 * It can be widened per client later.
 */
const AGENT_NUMBER = /^\+60[1-9][0-9]{7,9}$/;
export const agentNumberAllowed = (e164: string) => AGENT_NUMBER.test(e164);

export interface DialPlan { agent: string; callerId: string; ringSeconds: number; actionUrl: string; whisperUrl: string | null }

/**
 * Ring the agent. The agent sees `callerId`, one of our own numbers: Twilio would otherwise show the caller's number.
 * Both numbers are checked again here, so a value in any other form never reaches the TwiML.
 */
export function twimlDialAgent(p: DialPlan): string {
  if (!E164.test(p.agent) || !E164.test(p.callerId)) throw new Error('A transfer needs an agent number and one of our own numbers.');
  if (!agentNumberAllowed(p.agent)) throw new Error('An agent number must be Malaysian (+60).');
  const ring = Math.min(60, Math.max(5, Math.trunc(p.ringSeconds)));
  const number = p.whisperUrl ? `<Number url="${xml(p.whisperUrl)}" method="POST">${p.agent}</Number>` : `<Number>${p.agent}</Number>`;
  return `${DOC}<Response><Dial action="${xml(p.actionUrl)}" method="POST" timeout="${ring}" callerId="${p.callerId}">${number}</Dial></Response>`;
}

/** The holding message, then the end of the call. Used when no one could be reached; the callback is recorded first. */
export const twimlHoldingThenHangup = (message: string) => `${DOC}<Response><Say>${xml(message)}</Say><Hangup/></Response>`;
export const twimlHangup = () => `${DOC}<Response><Hangup/></Response>`;
/** Nothing to say: the agent is connected straight away. */
export const twimlEmpty = () => `${DOC}<Response/>`;

/** Why the call was passed on, in words fit to say to an agent. Fixed phrases only: nothing the caller said. */
const REASONS: Record<string, string> = {
  workflow_handoff: 'the caller asked for a person',
  severe_sentiment: 'the caller sounded upset',
  failed_recoveries: 'the assistant could not understand the caller',
};

/**
 * What the agent hears before being connected: why the call came to them and a short ticket reference, spelt out. No
 * number, no name, nothing the caller said.
 */
export function whisperText(w: { trigger: string | null; ticketId: string | null }): string {
  const why = (w.trigger && Object.prototype.hasOwnProperty.call(REASONS, w.trigger)) ? REASONS[w.trigger] : 'the call was passed to a person';
  const ref = w.ticketId && /^[0-9a-f]{8}/.test(w.ticketId) ? ` Ticket reference ${w.ticketId.slice(0, 8).toUpperCase().split('').join(' ')}.` : '';
  return `A Voice Lab caller is being put through to you, because ${why}.${ref}`;
}
/**
 * The whisper, and the screen: the agent must press 1 to take the call. Anything else, or nothing (a voicemail picking
 * up), ends the agent's leg, so the caller is never put through to a machine.
 */
export const twimlWhisper = (text: string, acceptUrl: string) =>
  `${DOC}<Response><Gather action="${xml(acceptUrl)}" method="POST" numDigits="1" timeout="8"><Say>${xml(text)} Press 1 to take the call.</Say></Gather><Hangup/></Response>`;

/**
 * How the dial to the agent ended. Only a dial that was answered put the caller through to a person; anything else,
 * including a value we have never seen, means no one was reached.
 */
/** How long the agent's leg lasted, from `DialCallDuration`: whole seconds, or null when it is missing or unreadable. */
export function dialSeconds(v: string | undefined): number | null {
  return v !== undefined && /^[0-9]{1,7}$/.test(v) ? Number(v) : null;
}

export function dialOutcome(dialCallStatus: string | undefined): 'answered' | 'unanswered' | 'failed' {
  if (dialCallStatus === 'completed' || dialCallStatus === 'answered') return 'answered';
  if (dialCallStatus === 'busy' || dialCallStatus === 'no-answer' || dialCallStatus === 'canceled') return 'unanswered';
  return 'failed';
}
