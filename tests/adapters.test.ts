import { describe, expect, it } from 'vitest';
import { checkParams, getAdapter, listAdapters } from '../src/adapters/registry.js';
import { CAPABILITIES } from '../src/adapters/types.js';

describe('adapter framework', () => {
  it('every adapter classifies every capability', () => {
    for (const a of listAdapters()) {
      for (const cap of CAPABILITIES) expect(a.defaultCapabilities[cap], `${a.key}.${cap}`).toBeDefined();
    }
  });

  it('twilio accepts an auth token or an API key pair, but not neither', () => {
    const twilio = getAdapter('twilio')!;
    const base = { accountSid: 'AC123', twimlAppVoiceUrl: 'https://example.com/voice' };
    expect(checkParams(twilio, { ...base, authToken: 't' }).ok).toBe(true);
    expect(checkParams(twilio, { ...base, apiKeySid: 'SK1', apiKeySecret: 's' }).ok).toBe(true);
    expect(checkParams(twilio, { ...base, apiKeySid: 'SK1' }).ok).toBe(false);
    expect(checkParams(twilio, base).ok).toBe(false);
  });

  it('splits secrets from plain values and rejects unknown or bad values', () => {
    const telnyx = getAdapter('telnyx')!;
    const ok = checkParams(telnyx, { apiKey: 'KEY', webhookUrl: 'https://example.com/hook' });
    expect(ok.ok && ok.split).toEqual({ plain: { webhookUrl: 'https://example.com/hook' }, secret: { apiKey: 'KEY' } });
    expect(checkParams(telnyx, { apiKey: 'K', webhookUrl: 'not a url' }).ok).toBe(false);
    expect(checkParams(telnyx, { apiKey: 'K', webhookUrl: 'ftp://x.example' }).ok).toBe(false);
    expect(checkParams(telnyx, { apiKey: 'K', webhookUrl: 'https://x.example', bogus: 'y' }).ok).toBe(false);
    expect(checkParams(telnyx, { webhookUrl: 'https://x.example' }).ok).toBe(false);
  });
});
