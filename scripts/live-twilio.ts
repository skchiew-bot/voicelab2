/**
 * Live check against the real Twilio API, run by hand, never by the test suite (tests never call real providers).
 * It uses Voice Lab's own adapter code, so it proves our request formats against the real service (lesson L-016).
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/live-twilio.ts check
 *     Confirms the credentials with the same request the console uses when a provider is added.
 *
 *   NODE_USE_ENV_PROXY=1 npx tsx scripts/live-twilio.ts call
 *     Places one real call from LIVE_TWILIO_FROM (a Twilio number) to LIVE_TEST_TO (a phone the owner holds), with
 *     Twilio's public demo TwiML (no server of ours is needed), then waits for Twilio to price it and checks the call
 *     record has the shape `twilioFetchCallUsage` expects.
 *
 * Reads TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN from the environment. Prints no number, SID or token: only what
 * happened. Writes the call record's shape (field names and value types, no values) to devlog/live/ as evidence.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { twilio as adapter } from '../src/adapters/definitions.js';
import { twilioFetchCallUsage, twilioPlaceCall, twilioAuth } from '../src/telephony/twilio.js';
import { redactNumbers } from '../src/telephony/types.js';

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) { console.error(`Missing ${name} in the environment.`); process.exit(2); }
  return v;
};
const creds = () => ({ accountSid: need('TWILIO_ACCOUNT_SID'), authToken: need('TWILIO_AUTH_TOKEN') });
const say = (s: string) => console.log(redactNumbers(s));

/** Field names and value types only, so the evidence can be committed without a single value. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as Record<string, unknown>)[k])]));
  return v === null ? 'null' : typeof v;
}

async function check() {
  const c = creds();
  const r = await adapter.validate!({ accountSid: c.accountSid, authToken: c.authToken } as never, fetch);
  say(r.ok ? 'Credentials accepted by Twilio.' : `Not accepted (${r.kind}): ${r.reason}`);
  if (!r.ok) process.exit(1);
  // Trial or full account, so the owner knows whether calls only reach verified numbers.
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}.json`, { headers: { authorization: twilioAuth(c) } });
  const b = (await res.json().catch(() => null)) as { type?: string; status?: string } | null;
  say(`Account type: ${b?.type ?? 'unknown'}, status: ${b?.status ?? 'unknown'}.`);
}

async function call() {
  const c = creds();
  const from = need('LIVE_TWILIO_FROM'); const to = need('LIVE_TEST_TO');
  // Twilio's own public demo TwiML: it speaks a short message. Status events go to the same Twilio-owned address, so
  // call details are never sent to anyone but Twilio. Our webhook path is proven later, on a server that can be reached.
  const demo = process.env.LIVE_ANSWER_URL ?? 'https://demo.twilio.com/docs/voice.xml';
  const { providerCallId } = await twilioPlaceCall(c, fetch, { to, from, answerUrl: demo, statusUrl: demo });
  say('Call placed. Answer the phone; it plays Twilio\'s demo message. Waiting for Twilio to price the call (up to 10 minutes)…');
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 15_000));
    const u = await twilioFetchCallUsage(c, fetch, providerCallId);
    if (u.state === 'ready') {
      say(`Priced: ${u.seconds} seconds, cost reported in ${u.currency}. The call record has the shape Voice Lab expects.`);
      const raw = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(c.accountSid)}/Calls/${encodeURIComponent(providerCallId)}.json`, { headers: { authorization: twilioAuth(c) } });
      mkdirSync('devlog/live', { recursive: true });
      writeFileSync('devlog/live/twilio-call-record-shape.json', `${JSON.stringify({ capturedAt: new Date().toISOString(), shape: shape(await raw.json()) }, null, 2)}\n`);
      say('Saved the call record\'s shape (no values) to devlog/live/twilio-call-record-shape.json.');
      return;
    }
  }
  say('Twilio had not priced the call after 10 minutes. Run `call` again later or check the call in the Twilio console.');
  process.exit(1);
}

const step = process.argv[2];
(step === 'check' ? check() : step === 'call' ? call() : Promise.reject(new Error('Use: check | call')))
  .catch((e) => { say(`Failed: ${(e as Error).message}`); process.exit(1); });
