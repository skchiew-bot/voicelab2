import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env;
beforeAll(async () => { env = await (await import('./helpers.js')).setupDb(); });
afterAll(async () => { await env?.teardown(); });

const reset = () => { env.provider.calls.length = 0; env.provider.state.respond = () => new Response(JSON.stringify({ status: 'active', data: { balance: '12.34', currency: 'USD' } }), { status: 200 }); };
const add = (adapterKey: string, name: string, params: Record<string, string>, extra: object = {}) =>
  env.call(env.staffToken, 'POST', '/internal/providers', { adapterKey, name, params, ...extra });

const twilio = { accountSid: 'AC123', authToken: 'tok', twimlAppVoiceUrl: 'https://example.com/voice' };
const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');

describe('credential check on save', () => {
  it('Twilio: checks the account with the auth token over basic auth, and records when', async () => {
    reset();
    const res = await add('twilio', 'tw-ok', twilio);
    expect(res.statusCode).toBe(201);
    expect(res.json().credentials_checked_at).toBeTruthy();
    expect(env.provider.calls).toHaveLength(1);
    expect(env.provider.calls[0]!.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123.json');
    expect(env.provider.calls[0]!.headers.authorization).toBe(basic('AC123', 'tok'));
  });

  it('Twilio: an API key pair authenticates as the key, against the same account', async () => {
    reset();
    const res = await add('twilio', 'tw-key', { accountSid: 'AC9', apiKeySid: 'SK1', apiKeySecret: 'sec', twimlAppVoiceUrl: 'https://example.com/v' });
    expect(res.statusCode).toBe(201);
    expect(env.provider.calls[0]!.url).toContain('/Accounts/AC9.json');
    expect(env.provider.calls[0]!.headers.authorization).toBe(basic('SK1', 'sec'));
  });

  it('Twilio: refuses a suspended account', async () => {
    reset();
    env.provider.state.respond = () => new Response(JSON.stringify({ status: 'suspended' }), { status: 200 });
    const res = await add('twilio', 'tw-susp', twilio);
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json().details)).toContain('suspended');
  });

  it('Telnyx: uses the read-only balance endpoint with a bearer key', async () => {
    reset();
    const res = await add('telnyx', 'tx-ok', { apiKey: 'KEY1', webhookUrl: 'https://example.com/hook' });
    expect(res.statusCode).toBe(201);
    expect(env.provider.calls[0]!.url).toBe('https://api.telnyx.com/v2/balance');
    expect(env.provider.calls[0]!.headers.authorization).toBe('Bearer KEY1');
  });

  it('OpenAI and ElevenLabs are checked too', async () => {
    reset();
    expect((await add('openai', 'oa', { apiKey: 'sk-1' })).statusCode).toBe(201);
    expect((await add('elevenlabs', 'el', { apiKey: 'xi-1' })).statusCode).toBe(201);
    expect(env.provider.calls.map((c) => c.url)).toEqual(['https://api.openai.com/v1/models', 'https://api.elevenlabs.io/v1/user']);
    expect(env.provider.calls[1]!.headers['xi-api-key']).toBe('xi-1');
  });

  it('a rejected key is refused, nothing is stored, and the key is not echoed back', async () => {
    reset();
    env.provider.state.respond = () => new Response('{}', { status: 401 });
    const res = await add('telnyx', 'tx-bad', { apiKey: 'WRONG-KEY', webhookUrl: 'https://example.com/hook' });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(res.json())).toContain('rejected');
    expect(JSON.stringify(res.json())).not.toContain('WRONG-KEY');
    expect((await env.pool.query(`SELECT 1 FROM providers WHERE name = 'tx-bad'`)).rowCount).toBe(0);
  });

  it('an outage is a different error from a rejection, and offers a way forward', async () => {
    reset();
    env.provider.state.respond = () => { throw new Error('getaddrinfo ENOTFOUND api.telnyx.com'); };
    const res = await add('telnyx', 'tx-down', { apiKey: 'K', webhookUrl: 'https://example.com/hook' });
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.json().details)).toContain('Could not reach Telnyx');
    expect(JSON.stringify(res.json().details)).toContain('save without checking');

    env.provider.state.respond = () => new Response('', { status: 503 });
    expect((await add('telnyx', 'tx-503', { apiKey: 'K', webhookUrl: 'https://example.com/hook' })).statusCode).toBe(502);
  });

  it('can be saved without checking, which is recorded, then checked later', async () => {
    reset();
    env.provider.state.respond = () => { throw new Error('offline'); };
    const saved = await add('telnyx', 'tx-skip', { apiKey: 'K', webhookUrl: 'https://example.com/hook' }, { skipValidation: true });
    expect(saved.statusCode).toBe(201);
    expect(saved.json().credentials_checked_at).toBeNull();
    const audit = await env.pool.query(`SELECT detail FROM audit_log WHERE action = 'provider.create' AND detail->>'name' = 'tx-skip'`);
    expect(audit.rows[0].detail.credentialsChecked).toBe(false);

    const id = saved.json().id;
    const still = await env.call(env.staffToken, 'POST', `/internal/providers/${id}/check`);
    expect(still.json()).toMatchObject({ ok: false, kind: 'unreachable' });
    expect((await env.call(env.staffToken, 'GET', `/internal/providers/${id}`)).json().credentials_checked_at).toBeNull();

    reset();
    const ok = await env.call(env.staffToken, 'POST', `/internal/providers/${id}/check`);
    expect(ok.json()).toMatchObject({ ok: true, info: { balance: '12.34 USD' } });
    expect(env.provider.calls[0]!.headers.authorization).toBe('Bearer K'); // the stored secret, decrypted for the call
    expect((await env.call(env.staffToken, 'GET', `/internal/providers/${id}`)).json().credentials_checked_at).toBeTruthy();
  });

  it('invalid settings are refused before the provider is contacted', async () => {
    reset();
    const res = await add('twilio', 'tw-bad', { accountSid: 'AC1', twimlAppVoiceUrl: 'https://x.example' });
    expect(res.statusCode).toBe(400);
    expect(env.provider.calls).toHaveLength(0);
  });
});
