import type { Adapter, Fetch, ValidationResult } from './types.js';

/** One read-only GET. Hosts are fixed per adapter: nothing a user types decides where we connect. */
async function probe(
  label: string, http: Fetch, url: string, headers: Record<string, string>,
  read?: (body: unknown) => ValidationResult,
): Promise<ValidationResult> {
  try {
    const res = await http(url, { method: 'GET', headers, signal: AbortSignal.timeout(10_000) });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, kind: 'rejected', reason: `${label} rejected these credentials (HTTP ${res.status}).` };
    }
    if (!res.ok) {
      return { ok: false, kind: 'unavailable', reason: `${label} answered HTTP ${res.status}, so the credentials could not be confirmed.` };
    }
    return read ? read(await res.json().catch(() => null)) : { ok: true };
  } catch (err) {
    return { ok: false, kind: 'unreachable', reason: `Could not reach ${label}: ${(err as Error).message}` };
  }
}

const basic = (user: string, pass: string) => 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');

// Telephony providers carry no speech capabilities themselves; those route to a
// voice provider. Capability defaults here are a starting point to be verified
// against each provider's docs when the live adapters are built (Phase 1).

const telephonyOnly = { stt: 'unsupported', llm: 'unsupported', tts: 'unsupported', realtime_conversation: 'unsupported' } as const;

export const twilio: Adapter = {
  key: 'twilio',
  kind: 'telephony',
  displayName: 'Twilio',
  docsUrl: 'https://www.twilio.com/docs/voice/api',
  params: [
    { key: 'accountSid', label: 'Account SID', type: 'string', required: true },
    { key: 'authToken', label: 'Auth Token', type: 'secret', required: false,
      help: 'Provide this, or an API key SID and secret below. Call events can only be verified with the Auth Token.' },
    { key: 'apiKeySid', label: 'API key SID', type: 'string', required: false },
    { key: 'apiKeySecret', label: 'API key secret', type: 'secret', required: false },
    { key: 'twimlAppVoiceUrl', label: 'TwiML App Voice URL', type: 'url', required: true,
      help: 'Twilio calls this URL for call control; it points back at the voicebot.' },
    { key: 'relayLanguage', label: 'Live call language', type: 'string', required: false,
      help: 'The language Twilio listens for and speaks on a live call, e.g. en-US or ms-MY. Default en-US.' },
    { key: 'relayTtsProvider', label: 'Live call voice service', type: 'string', required: false,
      help: "Which of Twilio's voice services speaks the lines, e.g. ElevenLabs or Google. Twilio's default if empty." },
    { key: 'relayVoice', label: 'Live call voice', type: 'string', required: false,
      help: "The voice to speak with, as that service names it. Twilio's default if empty." },
    { key: 'relayTranscriptionProvider', label: 'Live call speech recognition', type: 'string', required: false,
      help: "Which of Twilio's speech services hears the caller, e.g. Deepgram or Google. Twilio's default if empty." },
  ],
  defaultCapabilities: {
    inbound_calls: 'native', outbound_calls: 'native', call_transfer: 'native', call_recording: 'native',
    ...telephonyOnly,
  },
  crossValidate(v) {
    const hasToken = Boolean(v.authToken);
    const hasKeyPair = Boolean(v.apiKeySid) && Boolean(v.apiKeySecret);
    return hasToken || hasKeyPair ? null : 'Provide either an Auth Token, or both an API key SID and API key secret.';
  },
  validate(v, http) {
    const sid = String(v.accountSid);
    const auth = v.authToken ? basic(sid, String(v.authToken)) : basic(String(v.apiKeySid), String(v.apiKeySecret));
    return probe('Twilio', http, `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}.json`,
      { authorization: auth }, (body) => {
        const status = (body as { status?: string } | null)?.status;
        return status && status !== 'active'
          ? { ok: false, kind: 'rejected', reason: `The Twilio account is ${status}, not active.` }
          : { ok: true, info: status ? { accountStatus: status } : undefined };
      });
  },
};

export const telnyx: Adapter = {
  key: 'telnyx',
  kind: 'telephony',
  displayName: 'Telnyx',
  docsUrl: 'https://developers.telnyx.com/docs/voice/programmable-voice/get-started',
  params: [
    { key: 'apiKey', label: 'API key', type: 'secret', required: true,
      help: 'From the Mission Control Portal.' },
    { key: 'webhookUrl', label: 'Webhook URL', type: 'url', required: true },
    { key: 'failoverWebhookUrl', label: 'Failover webhook URL', type: 'url', required: false },
    { key: 'connectionId', label: 'Voice API Application ID', type: 'string', required: false,
      help: 'Needed to place outbound calls.' },
    { key: 'webhookPublicKey', label: 'Webhook signing public key', type: 'string', required: false,
      help: 'From the Mission Control Portal. Without it, incoming call events are refused.' },
  ],
  defaultCapabilities: {
    inbound_calls: 'native', outbound_calls: 'native', call_transfer: 'native', call_recording: 'native',
    ...telephonyOnly,
  },
  // The read-only balance endpoint doubles as the credential check.
  validate: (v, http) => probe('Telnyx', http, 'https://api.telnyx.com/v2/balance',
    { authorization: `Bearer ${String(v.apiKey)}` }, (body) => {
      const d = (body as { data?: { balance?: string; currency?: string } } | null)?.data;
      return { ok: true, info: d?.balance ? { balance: `${d.balance} ${d.currency ?? ''}`.trim() } : undefined };
    }),
};

export const openai: Adapter = {
  key: 'openai',
  kind: 'voice',
  displayName: 'OpenAI (realtime)',
  docsUrl: 'https://platform.openai.com/docs',
  params: [
    { key: 'apiKey', label: 'API key', type: 'secret', required: true },
    { key: 'project', label: 'Project ID', type: 'string', required: false },
  ],
  validate: (v, http) => probe('OpenAI', http, 'https://api.openai.com/v1/models', { authorization: `Bearer ${String(v.apiKey)}` }),
  defaultCapabilities: {
    inbound_calls: 'unsupported', outbound_calls: 'unsupported', call_transfer: 'composable', call_recording: 'composable',
    stt: 'native', llm: 'native', tts: 'native', realtime_conversation: 'native',
  },
};

export const elevenlabs: Adapter = {
  key: 'elevenlabs',
  kind: 'voice',
  displayName: 'ElevenLabs (conversational)',
  docsUrl: 'https://elevenlabs.io/docs',
  params: [
    { key: 'apiKey', label: 'API key', type: 'secret', required: true },
    { key: 'agentId', label: 'Agent ID', type: 'string', required: false },
  ],
  validate: (v, http) => probe('ElevenLabs', http, 'https://api.elevenlabs.io/v1/user', { 'xi-api-key': String(v.apiKey) }),
  defaultCapabilities: {
    inbound_calls: 'unsupported', outbound_calls: 'unsupported', call_transfer: 'composable', call_recording: 'composable',
    stt: 'native', llm: 'composable', tts: 'native', realtime_conversation: 'native',
  },
};

/**
 * An AI model the platform calls, priced by its own dated rates (input and output tokens). One provider per model: the
 * model id is the one the platform's model settings name, so each decision a call logs is priced by the model it used.
 */
export const anthropic: Adapter = {
  key: 'anthropic',
  kind: 'model',
  displayName: 'Anthropic model',
  docsUrl: 'https://docs.anthropic.com',
  params: [
    { key: 'model', label: 'Model id', type: 'string', required: true,
      help: 'Exactly as the model settings name it, e.g. claude-haiku-5-5. Every decision logged with this model is priced by this provider\'s rates.' },
    { key: 'apiKey', label: 'API key', type: 'secret', required: false },
  ],
  defaultCapabilities: {
    inbound_calls: 'unsupported', outbound_calls: 'unsupported', call_transfer: 'unsupported', call_recording: 'unsupported',
    stt: 'unsupported', llm: 'native', tts: 'unsupported', realtime_conversation: 'unsupported',
  },
};
