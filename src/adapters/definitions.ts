import type { Adapter } from './types.js';

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
      help: 'Provide this, or an API key SID and secret below.' },
    { key: 'apiKeySid', label: 'API key SID', type: 'string', required: false },
    { key: 'apiKeySecret', label: 'API key secret', type: 'secret', required: false },
    { key: 'twimlAppVoiceUrl', label: 'TwiML App Voice URL', type: 'url', required: true,
      help: 'Twilio calls this URL for call control; it points back at the voicebot.' },
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
  ],
  defaultCapabilities: {
    inbound_calls: 'native', outbound_calls: 'native', call_transfer: 'native', call_recording: 'native',
    ...telephonyOnly,
  },
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
  defaultCapabilities: {
    inbound_calls: 'unsupported', outbound_calls: 'unsupported', call_transfer: 'composable', call_recording: 'composable',
    stt: 'native', llm: 'composable', tts: 'native', realtime_conversation: 'native',
  },
};
