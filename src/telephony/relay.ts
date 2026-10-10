/**
 * The live call voice link over Twilio's speech relay (ConversationRelay). Twilio turns the caller's speech into text
 * and speaks our lines; this file holds the pure parts: the TwiML that hands an answered call to the relay, the
 * messages Twilio sends us, and the messages that say a line (recordings by link, everything else as text).
 *
 * The message shapes come from Twilio's own published packages (`twilio` 6.1.2 for the TwiML attributes, and Twilio's
 * `twilio-agent-connect` 2.4.0 for the WebSocket messages), kept in `tests/fixtures/twilio-relay.json`. They have not
 * yet been checked against a live call (lesson L-016).
 */
import { z } from 'zod';
import type { Segment } from '../workflows/stitch.js';

/** How the relay listens and speaks, from the Twilio provider's settings. All optional except the language. */
export interface RelaySettings { language: string; ttsProvider?: string; voice?: string; transcriptionProvider?: string }

const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const NAME = /^[A-Za-z0-9 ._:-]{1,80}$/;
/** The relay settings from a Twilio provider's plain settings. A value in an unexpected form is left out, never passed on. */
export function relaySettings(params: Record<string, unknown>): RelaySettings {
  const pick = (k: string, re: RegExp) => (typeof params[k] === 'string' && re.test(params[k] as string) ? (params[k] as string) : undefined);
  return { language: pick('relayLanguage', LANGUAGE) ?? 'en-US', ttsProvider: pick('relayTtsProvider', NAME), voice: pick('relayVoice', NAME), transcriptionProvider: pick('relayTranscriptionProvider', NAME) };
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * Hand an answered call to the relay. The call is named by a parameter, not in the address, so the address Twilio signs
 * is the bare WebSocket URL. Nothing is said until the workflow says it: there is no welcome greeting.
 */
export function twimlRelay(wsUrl: string, callId: string, s: RelaySettings): string {
  const attrs: [string, string | undefined][] = [
    ['url', wsUrl], ['language', s.language], ['ttsProvider', s.ttsProvider], ['voice', s.voice],
    ['transcriptionProvider', s.transcriptionProvider], ['interruptible', 'speech'], ['dtmfDetection', 'false'],
  ];
  const a = attrs.filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}="${xml(v!)}"`).join(' ');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><ConversationRelay ${a}><Parameter name="callId" value="${xml(callId)}"/></ConversationRelay></Connect></Response>`;
}

/** What Twilio sends. Anything else (or anything malformed) is ignored, never trusted. */
export const relayInbound = z.discriminatedUnion('type', [
  z.object({ type: z.literal('setup'), sessionId: z.string(), callSid: z.string(), accountSid: z.string(), customParameters: z.record(z.string(), z.unknown()).optional() }),
  z.object({ type: z.literal('prompt'), voicePrompt: z.string(), lang: z.string().optional(), last: z.boolean().optional() }),
  z.object({ type: z.literal('interrupt'), utteranceUntilInterrupt: z.string().optional(), durationUntilInterruptMs: z.number().optional() }),
  z.object({ type: z.literal('dtmf'), digit: z.string() }),
  z.object({ type: z.literal('error'), description: z.string().optional() }),
]);
export type RelayInbound = z.infer<typeof relayInbound>;

export function parseRelay(raw: string): RelayInbound | null {
  if (raw.length > 64 * 1024) return null;
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return null; }
  const r = relayInbound.safeParse(v);
  return r.success ? r.data : null;
}

/** What we send. */
export type RelayOutbound =
  | { type: 'text'; token: string; last: boolean; lang?: string }
  | { type: 'play'; source: string }
  | { type: 'end'; handoffData?: string };

/**
 * Say lines, in order: a piece with a recording plays it from a short-lived link; the rest is spoken by the relay. A
 * recording with no link (it could not be signed) is spoken instead, so the caller still hears the words.
 */
export function sayMessages(lines: { lang: string; segments: Segment[] }[], linkFor: (recordingId: string) => string | null): RelayOutbound[] {
  const out: RelayOutbound[] = [];
  for (const line of lines) {
    for (const s of line.segments) {
      const link = s.kind === 'recorded' ? linkFor(s.recordingId) : null;
      if (link) out.push({ type: 'play', source: link });
      else if (s.text.trim() !== '') out.push({ type: 'text', token: s.text.trim(), last: true });
    }
  }
  return out;
}
