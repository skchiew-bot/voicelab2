import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env;
let tenantId: string; let projectId: string; let otherTenantId: string;
let twilioId: string; let telnyxId: string; let voiceId: string;
const BASE = 'https://voicelab.test';
const TX1 = '+60387650001'; const TX2 = '+60387650002'; const TW1 = '+60312340001'; const OTHER = '+60399990001';
const CONTACT_A = '+60123450001'; const CONTACT_B = '+60123450002';
const st = () => env.staffToken;
const get = (u: string) => env.call(st(), 'GET', u);
const post = (u: string, b?: unknown) => env.call(st(), 'POST', u, b);

async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}

let sid = 0;
const answerDials = () => {
  env.provider.state.respond = (url) => {
    if (url.includes('/Calls.json')) return new Response(JSON.stringify({ sid: `CA_p3_${++sid}` }), { status: 201 });
    if (url.endsWith('/v2/calls')) return new Response(JSON.stringify({ data: { call_control_id: `cc_p3_${++sid}` } }));
    return new Response('{}');
  };
};
const dialsMade = () => env.provider.calls.filter((c) => c.url.includes('/Calls.json') || c.url.endsWith('/v2/calls'));
/** The caller ID a dial actually used, as the provider received it. */
const fromOf = (c: { url: string; body: string }) => c.url.includes('/Calls.json') ? new URLSearchParams(c.body).get('From') : JSON.parse(c.body).from;
const dial = (body: object) => post('/internal/calls/outbound', { tenantId, projectId, country: 'MY', ...body });
const hashOf = async (id: string) => (await env.pool.query('SELECT contact_hash FROM calls WHERE id = $1', [id])).rows[0].contact_hash as string;

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  tenantId = (await must(post('/internal/tenants', { name: 'Stitch Co' }))).json().id;
  otherTenantId = (await must(post('/internal/tenants', { name: 'Other Co' }))).json().id;
  projectId = (await must(post(`/internal/tenants/${tenantId}/projects`, { name: 'Collections' }))).json().id;
  twilioId = (await must(post('/internal/providers', { adapterKey: 'twilio', name: 'tw', params: { accountSid: 'AC1', authToken: 'tok', twimlAppVoiceUrl: `${BASE}/v` } }))).json().id;
  telnyxId = (await must(post('/internal/providers', { adapterKey: 'telnyx', name: 'tx', params: { apiKey: 'KEY', webhookUrl: `${BASE}/h`, connectionId: 'c1', webhookPublicKey: 'AAAA' } }))).json().id;
  voiceId = (await must(post('/internal/providers', { adapterKey: 'elevenlabs', name: 'el', params: { apiKey: 'k' } }))).json().id;
  for (const [id, rate] of [[twilioId, '0.0140'], [telnyxId, '0.0070']] as const) {
    await must(post(`/internal/providers/${id}/charging`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 6, components: [{ component: 'telephony_leg', unit: 'per_minute', rate, currency: 'USD' }] }));
  }
  await must(post(`/internal/providers/${voiceId}/charging`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1, components: [{ component: 'tts', unit: 'per_1k_characters', rate: '0.30', currency: 'USD' }] }));
  await must(post('/internal/fx', { currency: 'MYR', perUsd: '4.5', effectiveFrom: '2026-01-01T00:00:00Z' }));
  for (const [providerId, e164] of [[telnyxId, TX1], [telnyxId, TX2], [twilioId, TW1]] as const) {
    await must(post('/internal/numbers', { providerId, e164, tenantId, projectId, country: 'MY' }));
  }
  await must(post('/internal/numbers', { providerId: telnyxId, e164: OTHER, tenantId: otherTenantId, country: 'MY' }));
  await must(post('/internal/dnc/registries', { country: 'MY', requirement: 'registry', source: 'test' }));
  await must(post('/internal/dnc/numbers', { country: 'MY', numbers: ['+60198765432'] }));
  answerDials();
});
afterAll(async () => { await env?.teardown(); });

describe('the DID pool: the check before every dial', () => {
  it('picks from the cheapest provider and rotates through its numbers, so the pool wears evenly', async () => {
    const used: string[] = [];
    for (let i = 0; i < 4; i++) {
      env.provider.calls.length = 0;
      const placed = await must(dial({ to: `+6011100000${i}` }));
      expect(placed.json()).toMatchObject({ allowed: true, status: 'dialing' });
      used.push(fromOf(dialsMade()[0]!)!);
    }
    expect(new Set(used)).toEqual(new Set([TX1, TX2]));            // only the cheaper provider (Telnyx), never Twilio
    expect(used[0]).not.toBe(used[1]); expect(used[2]).not.toBe(used[3]);
    expect(used[0]).toBe(used[2]);                                   // and round again
    const pool = (await get(`/internal/dids?tenantId=${tenantId}`)).json();
    expect(pool.find((n: { e164: string }) => n.e164 === TX1).use_count).toBe(2);
    expect(pool.find((n: { e164: string }) => n.e164 === TW1).use_count).toBe(0);
  });

  it('never offers a client another client\'s number', async () => {
    const used = new Set<string>();
    for (let i = 0; i < 6; i++) { env.provider.calls.length = 0; await must(dial({ to: `+6011200000${i}` })); used.add(fromOf(dialsMade()[0]!)!); }
    expect(used.has(OTHER)).toBe(false);
  });

  it('locks a DID away from a contact for good once it has failed for them, and only for them', async () => {
    env.provider.calls.length = 0;
    const first = (await must(dial({ to: CONTACT_A }))).json();
    const lockedDid = fromOf(dialsMade()[0]!)!;
    const hash = await hashOf(first.callId);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify((await get(`/internal/calls/${first.callId}`)).json())).not.toContain(hash); // the hash is not served either

    expect((await post(`/internal/calls/${first.callId}/did-failure`, { reason: 'spam_flagged' })).statusCode).toBe(201);
    for (let i = 0; i < 6; i++) {
      env.provider.calls.length = 0;
      await must(dial({ to: CONTACT_A }));
      expect(fromOf(dialsMade()[0]!)).not.toBe(lockedDid);
    }
    // another contact can still be called from it
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) { env.provider.calls.length = 0; await must(dial({ to: CONTACT_B })); seen.add(fromOf(dialsMade()[0]!)!); }
    expect(seen.has(lockedDid)).toBe(true);
  });

  it('moves on to the next provider when the cheap one is locked out, and refuses when nothing is left, without contacting a provider', async () => {
    const contact = '+60123450099';
    const lockAllOf = async (providerCandidates: string[]) => {
      for (const e164 of providerCandidates) {
        const n = (await get(`/internal/dids?tenantId=${tenantId}`)).json().find((x: { e164: string }) => x.e164 === e164);
        const callId = randomUUID();
        // a call from that DID to this contact, as the dial path would have recorded it
        const hash = await hashOf((await must(dial({ to: contact, from: e164, providerId: n.provider_id }))).json().callId);
        await env.pool.query(`INSERT INTO calls (id, tenant_id, provider_id, direction, status, country, from_number_id, contact_hash, cost_status) VALUES ($1,$2,$3,'outbound','completed','MY',$4,$5,'not_applicable')`, [callId, tenantId, n.provider_id, n.id, hash]);
        expect((await post(`/internal/calls/${callId}/did-failure`, { reason: 'carrier_blocked' })).statusCode).toBe(201);
      }
    };
    await lockAllOf([TX1, TX2]);
    env.provider.calls.length = 0;
    await must(dial({ to: contact }));
    expect(fromOf(dialsMade()[0]!)).toBe(TW1);                       // Telnyx exhausted for this contact: Twilio is next

    await lockAllOf([TW1]);
    env.provider.calls.length = 0;
    const refused = await dial({ to: contact });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toContain('Every number in the pool has failed');
    expect(dialsMade()).toHaveLength(0);                             // the provider was never contacted
    const failed = (await env.pool.query(`SELECT status, end_reason, cost_status FROM calls WHERE end_reason = 'all_locked_for_contact'`)).rows;
    expect(failed).toEqual([{ status: 'failed', end_reason: 'all_locked_for_contact', cost_status: 'not_applicable' }]);
  });

  it('applies the same lock when an operator names the caller ID', async () => {
    const contact = '+60123450077';
    env.provider.calls.length = 0;
    const first = (await must(dial({ to: contact, from: TX1, providerId: telnyxId }))).json();
    await must(post(`/internal/calls/${first.callId}/did-failure`, { reason: 'rejected_on_sight' }));
    env.provider.calls.length = 0;
    const again = await dial({ to: contact, from: TX1, providerId: telnyxId });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain('locked away');
    expect(dialsMade()).toHaveLength(0);
    env.provider.calls.length = 0;
    expect((await dial({ to: contact, from: TX2, providerId: telnyxId })).statusCode).toBe(201);   // a different DID is fine
  });

  it('keeps the lock forever: failure rows cannot be changed or removed, and recording one twice adds nothing', async () => {
    await expect(env.pool.query('DELETE FROM did_failures')).rejects.toThrow(/append-only/);
    await expect(env.pool.query(`UPDATE did_failures SET reason = 'rejected_on_sight'`)).rejects.toThrow(/append-only/);
    const callId = (await env.pool.query(`SELECT call_id FROM did_failures LIMIT 1`)).rows[0].call_id;
    const before = (await env.pool.query('SELECT count(*)::int AS n FROM did_failures')).rows[0].n;
    const again = await post(`/internal/calls/${callId}/did-failure`, { reason: 'spam_flagged' });
    expect(again.json().alreadyLocked).toBe(true);
    expect((await env.pool.query('SELECT count(*)::int AS n FROM did_failures')).rows[0].n).toBe(before);
  });

  it('does not use up a number on a dial that the do-not-call gate blocks, and logs nothing about the number', async () => {
    const before = (await get(`/internal/dids?tenantId=${tenantId}`)).json().reduce((s: number, n: { use_count: number }) => s + n.use_count, 0);
    env.provider.calls.length = 0;
    const res = await dial({ to: '+60198765432' });
    expect(res.json()).toMatchObject({ allowed: false, status: 'blocked' });
    expect(dialsMade()).toHaveLength(0);
    const after = (await get(`/internal/dids?tenantId=${tenantId}`)).json().reduce((s: number, n: { use_count: number }) => s + n.use_count, 0);
    expect(after).toBe(before);
    const events = (await get(`/internal/calls/${res.json().callId}/events`)).json().map((e: { type: string }) => e.type);
    expect(events).toEqual(['dial.blocked']);
  });

  it('does not count a refused dial as the provider failing', async () => {
    const tower = (await get('/internal/control-tower')).json();
    expect(JSON.stringify(tower.alerts)).not.toContain('provider_failing');
    for (const p of tower.providers ?? []) expect(p.calls24h?.failed ?? 0).toBe(0);
  });

  it('keeps no customer number anywhere: not in failures, calls, events or the audit log', async () => {
    const dump = JSON.stringify([
      (await env.pool.query('SELECT * FROM did_failures')).rows, (await env.pool.query('SELECT * FROM calls')).rows,
      (await env.pool.query('SELECT payload FROM call_events')).rows, (await env.pool.query('SELECT detail FROM audit_log')).rows,
    ]);
    for (const digits of ['23450001', '23450002', '23450099', '23450077', '1110000', '1120000']) expect(dump).not.toContain(digits);
  });

  it('has the pool shown to the console with what it knows, and nothing to a client', async () => {
    const pool = (await get(`/internal/dids?tenantId=${tenantId}`)).json();
    expect(pool.length).toBe(3);
    expect(pool.find((n: { e164: string }) => n.e164 === TX1)).toMatchObject({ status: 'active', failures: expect.any(Number), contacts_locked: expect.any(Number) });
    await expect(withActor(env.pool, { kind: 'client', tenantId }, (c) => c.query('SELECT * FROM did_failures'))).rejects.toThrow(/permission denied/);
    await expect(withActor(env.pool, { kind: 'client', tenantId }, (c) => c.query('SELECT * FROM recordings'))).rejects.toThrow(/permission denied/);
  });
});

// ---------------------------------------------------------------------------------------------- recordings
const wav = (extra = 64) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(extra, 1)]);
const upload = (text: string, o: { language?: string; audio?: Buffer; contentType?: string; tenant?: string } = {}) =>
  post(`/internal/tenants/${o.tenant ?? tenantId}/recordings`, { language: o.language ?? 'en', text, contentType: o.contentType ?? 'audio/wav', audioBase64: (o.audio ?? wav()).toString('base64'), durationMs: 1800 });

const frameWorkflow = (): WorkflowDefinition => ({
  start: 'hi', variables: ['name'],
  nodes: {
    hi: { type: 'speak', speech: 'hybrid', text: 'Hello {{name}}, welcome.', transitions: [{ to: 'bye' }] },
    bye: { type: 'speak', speech: 'fixed', text: 'Goodbye.', transitions: [{ to: 'done' }] },
    done: { type: 'end', outcome: 'ok' },
  },
});

describe('recordings', () => {
  it('stores audio of exact words, refuses what is not audio or not fixed words, and versions a new take', async () => {
    const one = await must(upload('Goodbye.'));
    expect(one.json()).toMatchObject({ language: 'en', text: 'Goodbye.', version: 1, content_type: 'audio/wav' });
    expect(one.body).not.toContain('audio"'); // the audio itself is not in the listing response
    expect((await upload('  Goodbye.  ')).json().version).toBe(2); // the same words, however spaced, are a new take of the same recording
    expect((await upload('Goodbye.', { language: 'ms' })).json().version).toBe(1);

    expect((await upload('Hi', { audio: Buffer.from('#!/bin/sh\necho hi\n') })).statusCode).toBe(400);         // a script is not a WAV file
    expect((await upload('Hi', { contentType: 'audio/mpeg', audio: wav() })).statusCode).toBe(400);            // and a WAV is not an MP3
    expect((await upload('Hello {{name}}')).statusCode).toBe(400);                                               // slots are never recorded
    expect((await upload('   ')).statusCode).toBe(400);
    expect((await upload('Big', { audio: Buffer.concat([wav(), Buffer.alloc(5 * 1024 * 1024)]) })).statusCode).toBe(400);
    expect((await post(`/internal/tenants/${tenantId}/recordings`, { language: 'en', text: 'x', contentType: 'audio/wav', audioBase64: 'not base64!!', durationMs: 10 })).statusCode).toBe(400);
  });

  it('lists the newest take of each recording, serves the audio back unchanged, and never edits one', async () => {
    const list = (await get(`/internal/tenants/${tenantId}/recordings`)).json();
    const en = list.find((r: { language: string; text: string }) => r.language === 'en' && r.text === 'Goodbye.');
    expect(en.version).toBe(2);
    const audio = await get(`/internal/recordings/${en.id}/audio`);
    expect(audio.headers['content-type']).toBe('audio/wav');
    expect(audio.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(audio.rawPayload, wav())).toBe(0);
    await expect(env.pool.query(`UPDATE recordings SET text = 'x'`)).rejects.toThrow(/append-only/);
    await expect(env.pool.query('DELETE FROM recordings')).rejects.toThrow(/append-only/);
  });

  it('does not let one client\'s recordings be played for another', async () => {
    await must(upload('Only for other', { tenant: otherTenantId }));
    const list = (await get(`/internal/tenants/${tenantId}/recordings`)).json();
    expect(list.some((r: { text: string }) => r.text === 'Only for other')).toBe(false);
  });
});

describe('stitching in a real run, and its measured saving', () => {
  let workflowId: string;
  beforeAll(async () => {
    const created = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'stitch_demo', definition: frameWorkflow() }))).json();
    workflowId = created.workflow.id;
    await must(post(`/internal/workflows/${workflowId}/deploy`, { versionId: created.version.id, environment: 'staging' }));
  });

  it('says what is still worth recording, by the words around the slots', async () => {
    const gaps = (await get(`/internal/workflows/${workflowId}/recording-gaps`)).json();
    expect(gaps.missing.map((m: { text: string }) => m.text).sort()).toEqual([', welcome.', 'Hello']);
    expect(gaps).toMatchObject({ covered: 1, missingCharacters: 'Hello'.length + ', welcome.'.length });
  });

  it('speaks everything live before the frame is recorded, then only the slot after', async () => {
    const before = (await must(post(`/internal/workflows/${workflowId}/runs`, { environment: 'staging', variables: { name: 'Aisha' } }))).json();
    expect(before.speech).toEqual({ synthChars: 'Hello Aisha, welcome.'.length, recordedChars: 'Goodbye.'.length }); // Goodbye. is already recorded above
    await must(upload('Hello')); await must(upload(', welcome.'));
    const after = (await must(post(`/internal/workflows/${workflowId}/runs`, { environment: 'staging', variables: { name: 'Aisha' } }))).json();
    expect(after.speech).toEqual({ synthChars: 'Aisha'.length, recordedChars: 'Hello, welcome.Goodbye.'.length });
    const stored = (await get(`/internal/workflow-runs/${after.id}`)).json();
    expect(stored.speech).toEqual(after.speech);
    const say = stored.steps.find((s: { type: string }) => s.type === 'say');
    expect(say.payload.segments.map((x: { kind: string }) => x.kind)).toEqual(['recorded', 'synth', 'recorded']);
    expect(JSON.stringify(say.payload.segments)).not.toContain('Aisha'); // segments say how much, never what
  });

  it('measures the saving of stitching exactly, at the voice provider\'s rate', async () => {
    const scenarios = [{ name: 'one caller', variables: { name: 'Aisha' }, expect: { outcome: 'ok' } }];
    const r = await must(post(`/internal/workflows/${workflowId}/stitching-report`, { voiceProviderId: voiceId, scenarios }));
    const report = r.json();
    // unstitched: "Hello Aisha, welcome." (21) + "Goodbye." (8) = 29 live characters. Stitched: "Aisha" = 5.
    expect(report.unstitched).toEqual({ synthChars: 29, costUsd: '0.00870000' });          // 29 / 1000 * 0.30
    expect(report.stitched).toMatchObject({ synthChars: 5, recordedChars: 23, costUsd: '0.00150000' });
    expect(report.saved).toEqual({ chars: 24, costUsd: '0.00720000', percent: '82.76' });
    expect(report.ratesConfirmed).toBe(false);                                                // the rate is still the unconfirmed one: said, not hidden
    expect(report.note).toContain('says nothing about how the call sounds');
    // measuring stores nothing
    expect((await env.pool.query(`SELECT count(*)::int AS n FROM workflow_runs WHERE kind = 'simulation'`)).rows[0].n).toBe(0);
  });

  it('refuses to price the saving without a voice provider that has a per-character speech rate', async () => {
    const scenarios = [{ name: 's', variables: { name: 'A' } }];
    expect((await post(`/internal/workflows/${workflowId}/stitching-report`, { voiceProviderId: telnyxId, scenarios })).statusCode).toBe(400);
    const bare = (await must(post('/internal/providers', { adapterKey: 'openai', name: 'oa', params: { apiKey: 'k' } }))).json().id;
    expect((await post(`/internal/workflows/${workflowId}/stitching-report`, { voiceProviderId: bare, scenarios })).statusCode).toBe(409);
  });
});

// ---------------------------------------------------------------------------------------------- analytics
describe('outbound analytics', () => {
  let analyticsTenant: string; let provider: string;
  const mkCall = async (status: string, o: { end_reason?: string } = {}) => {
    const id = randomUUID();
    await env.pool.query(
      `INSERT INTO calls (id, tenant_id, provider_id, direction, status, country, cost_status, end_reason) VALUES ($1,$2,$3,'outbound',$4,'MY','not_applicable',$5)`,
      [id, analyticsTenant, provider, status, o.end_reason ?? null]);
    return id;
  };
  const report = async () => (await get(`/internal/analytics/outbound?tenantId=${analyticsTenant}&from=2020-01-01T00:00:00Z&to=2100-01-01T00:00:00Z`)).json();

  beforeAll(async () => {
    analyticsTenant = (await must(post('/internal/tenants', { name: 'Analytics Co' }))).json().id;
    provider = telnyxId;
  });

  it('counts attempts and outcomes, and shows answered calls nobody has classified instead of guessing', async () => {
    const answered = [await mkCall('completed'), await mkCall('completed'), await mkCall('completed'), await mkCall('completed'), await mkCall('completed')];
    await mkCall('unanswered'); await mkCall('unanswered'); await mkCall('failed', { end_reason: 'provider_error' });
    await mkCall('blocked'); await mkCall('failed', { end_reason: 'all_locked_for_contact' }); await mkCall('dialing');
    const o = (callId: string, body: object) => post(`/internal/calls/${callId}/outcome`, body);
    expect((await o(answered[0]!, { outcome: 'contacted' })).statusCode).toBe(201);
    expect((await o(answered[1]!, { outcome: 'rejected' })).statusCode).toBe(201);
    expect((await o(answered[2]!, { outcome: 'wrong_number' })).statusCode).toBe(201);
    expect((await o(answered[3]!, { outcome: 'third_party' })).statusCode).toBe(201);
    const r = await report();
    expect(r.attempts).toBe(8);                                   // 5 answered + 2 unanswered + 1 failed: not the blocked, refused or still ringing ones
    expect(r.notDialled).toEqual({ blocked: 1, noCallerId: 1 });
    expect(r.inFlight).toBe(1);
    expect(r.outcomes).toEqual({ contacted: 1, rejected: 1, wrongNumber: 1, thirdParty: 1, unclassified: 1, noAnswer: 2, unreachable: 1 });
    expect(r.rates).toEqual({ contactPercent: 12.5, answerPercent: 62.5 });
  });

  it('uses the latest statement for a call and keeps the earlier ones', async () => {
    const c = await mkCall('completed');
    await must(post(`/internal/calls/${c}/outcome`, { outcome: 'third_party' }));
    const before = (await report()).outcomes;
    await must(post(`/internal/calls/${c}/outcome`, { outcome: 'contacted' }));
    const after = (await report()).outcomes;
    expect(after.contacted - before.contacted).toBe(1); expect(before.thirdParty - after.thirdParty).toBe(1);
    expect((await env.pool.query('SELECT count(*)::int AS n FROM outbound_outcomes WHERE call_id = $1', [c])).rows[0].n).toBe(2);
    await expect(env.pool.query('DELETE FROM outbound_outcomes')).rejects.toThrow(/append-only/);
  });

  it('captures the best time to call back, in the person\'s own time zone, most requested first', async () => {
    const slot = async (day: number, hour: number, timeZone = 'Asia/Kuala_Lumpur') => {
      const c = await mkCall('completed');
      return must(post(`/internal/calls/${c}/outcome`, { outcome: 'contacted', callback: { day, hour, timeZone } }));
    };
    await slot(2, 19); await slot(2, 19); await slot(2, 19); await slot(5, 10); await slot(5, 10, 'Asia/Singapore');
    const slots = (await report()).bestCallbackTimes;
    expect(slots[0]).toEqual({ day: 2, hour: 19, time_zone: 'Asia/Kuala_Lumpur', requests: 3 });
    expect(slots).toContainEqual({ day: 5, hour: 10, time_zone: 'Asia/Singapore', requests: 1 });
  });

  it('refuses outcomes that cannot be true', async () => {
    const unanswered = await mkCall('unanswered');
    expect((await post(`/internal/calls/${unanswered}/outcome`, { outcome: 'contacted' })).statusCode).toBe(409);
    const done = await mkCall('completed');
    expect((await post(`/internal/calls/${done}/outcome`, { outcome: 'contacted', callback: { day: 2, hour: 9, timeZone: 'Mars/Olympus' } })).statusCode).toBe(400);
    expect((await post(`/internal/calls/${done}/outcome`, { outcome: 'wrong_number', callback: { day: 2, hour: 9, timeZone: 'Asia/Kuala_Lumpur' } })).statusCode).toBe(400);
    expect((await post(`/internal/calls/${done}/outcome`, { outcome: 'contacted', callback: { day: 9, hour: 9, timeZone: 'Asia/Kuala_Lumpur' } })).statusCode).toBe(400);
    expect((await get('/internal/analytics/outbound?from=2026-02-01&to=2026-01-01')).statusCode).toBe(400);
  });
});
