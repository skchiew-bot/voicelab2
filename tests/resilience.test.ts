import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db.js';
import { FundingExhausted, speakLines, type SessionDeps, type TelephonyRuntime, type VoiceRuntime } from '../src/resilience/session.js';
import { handoverPacket, startRun } from '../src/store/runs.js';
import { parseKey } from '../src/secrets.js';
import { recordSample } from '../src/store/resilience.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env;
let tenantId: string; let A: string; let B: string; let C: string;
const st = () => env.staffToken;
const get = (u: string) => env.call(st(), 'GET', u);
const post = (u: string, b?: unknown) => env.call(st(), 'POST', u, b);
const put = (u: string, b?: unknown) => env.call(st(), 'PUT', u, b);
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}

/** A voice provider that can be killed, slowed or run out of credit, and remembers everything it was asked to say. */
class FakeVoice implements VoiceRuntime {
  mode: 'ok' | 'dead' | 'slow' | 'dead_air' | 'no_credit' = 'ok';
  said: string[] = []; attempts = 0; resumed: unknown[] = []; failBridge = false;
  constructor(public bridge = 'One moment please.') {}
  async speak(text: string) {
    this.attempts++;
    if (this.mode === 'dead') throw new Error('connection reset');
    if (this.mode === 'no_credit') throw new FundingExhausted();
    if (this.failBridge && text === this.bridge) throw new Error('bridge failed');
    if (this.mode === 'dead_air') return { latencyMs: 9000 };      // the line never really played
    this.said.push(text);
    return { latencyMs: this.mode === 'slow' ? 3000 : 250 };
  }
  async resume(packet: unknown) { this.resumed.push(packet); }
}
class FakeTelephony implements TelephonyRuntime {
  log: string[] = []; broken = false;
  private do = async (what: string) => { if (this.broken) throw new Error('telephony down'); this.log.push(what); };
  playHolding = (t: string) => this.do(`holding:${t}`);
  transferToHuman = () => this.do('transfer');
  offerCallback = () => this.do('offer_callback');
  voicemail = () => this.do('voicemail');
}

let clock = Date.parse('2026-06-01T10:00:00Z');
const tick = (s: number) => { clock += s * 1000; };
const voices: Record<string, FakeVoice> = {};
let telephony = new FakeTelephony();
const session = (extra: Partial<SessionDeps> = {}): SessionDeps => ({
  pool: env.pool, runtime: (id) => voices[id], telephony, now: () => { tick(1); return new Date(clock); }, ...extra,
});
const callId = () => crypto.randomUUID();
const healthOf = async (id: string) => (await env.pool.query('SELECT state, reason FROM provider_health WHERE provider_id = $1', [id])).rows[0] as { state: string; reason: string } | undefined;
const reset = async () => {
  for (const id of [A, B, C]) { voices[id] = new FakeVoice(); await env.pool.query('DELETE FROM provider_health WHERE provider_id = $1', [id]); }
  telephony = new FakeTelephony();
  tick(1000);
};

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  tenantId = (await must(post('/internal/tenants', { name: 'Chaos Co' }))).json().id;
  const mk = async (adapterKey: string, name: string) => (await must(post('/internal/providers', { adapterKey, name, params: { apiKey: 'k' } }))).json().id as string;
  A = await mk('elevenlabs', 'voice-a'); B = await mk('openai', 'voice-b'); C = await mk('elevenlabs', 'voice-c');
  await must(put(`/internal/tenants/${tenantId}/routes/voice`, { providerIds: [A, B, C] }));
});
afterAll(async () => { await env?.teardown(); });

const LINES = ['Hello Aisha, this is Voice Lab.', 'Your balance is RM 350.00.', 'Can you pay this week?'];

describe('killing the provider', () => {
  it('fails over after N errors, plays the bridge, replays the interrupted line in full, and carries on', async () => {
    await reset();
    voices[A]!.mode = 'dead';
    const id = callId();
    const r = await speakLines(session(), { tenantId, callId: id, lines: LINES });
    expect(r.outcome).toBe('completed');
    expect(voices[A]!.attempts).toBe(3);                                         // three errors, then it is judged failed: not one retry more
    expect(voices[B]!.said).toEqual(['One moment please.', ...LINES]);           // bridge, then the interrupted line in full (slot values and all), then the rest
    expect(r.played.map((p) => [p.line, p.replay])).toEqual([[LINES[0], true], [LINES[1], false], [LINES[2], false]]);
    expect(r.switches).toEqual([{ from: A, to: B, trigger: 'hard_errors' }]);
    expect(await healthOf(A)).toMatchObject({ state: 'failed' });
    const log = (await env.pool.query(`SELECT scope, trigger, from_provider, to_provider FROM failover_events WHERE call_id = $1 ORDER BY id`, [id])).rows;
    expect(log.map((l) => l.scope)).toEqual(['provider_health', 'voice']);
    expect((await get(`/internal/calls/${id}/events`)).json().map((e: { type: string }) => e.type)).toContain('failover.voice');
  });

  it('does not fail over on a single error: it tries that provider again', async () => {
    await reset();
    let n = 0; const a = voices[A]!; const orig = a.speak.bind(a);
    a.speak = async (t: string) => { if (++n === 1) { a.attempts++; throw new Error('blip'); } return orig(t); };
    const r = await speakLines(session(), { tenantId, callId: callId(), lines: LINES });
    expect(r.switches).toEqual([]);
    expect(voices[A]!.said).toEqual(LINES);
    expect(voices[B]!.attempts).toBe(0);
  });

  it('cascades when the bridge itself fails, and when the next provider is dead too', async () => {
    await reset();
    voices[A]!.mode = 'dead'; voices[B]!.mode = 'dead';
    const r = await speakLines(session(), { tenantId, callId: callId(), lines: LINES });
    expect(r.outcome).toBe('completed');
    expect(voices[C]!.said).toEqual(['One moment please.', ...LINES]);
    expect(r.switches.map((s) => s.to)).toEqual([B, C]);
  });

  it('hands over what the call has said and collected, and never a sensitive value', async () => {
    await reset();
    const created = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'handover', definition: {
      start: 'a', variables: ['name', 'ic'], sensitiveVariables: ['ic'],
      nodes: { a: { type: 'speak', speech: 'hybrid', text: 'Hello {{name}}, please say yes.', listen: { captureAs: 'answer' }, transitions: [{ to: 'e' }] }, e: { type: 'end', outcome: 'ok' } } } }))).json();
    await must(post(`/internal/workflows/${created.workflow.id}/deploy`, { versionId: created.version.id, environment: 'staging' }));
    const run = (await must(post(`/internal/workflows/${created.workflow.id}/runs`, { environment: 'staging', variables: { name: 'Aisha', ic: '900101145678' } }))).json();
    const deps = session({ handover: () => withActor(env.pool, { kind: 'internal' }, (c) => handoverPacket(c, run.id)) });
    voices[A]!.mode = 'dead';
    await speakLines(deps, { tenantId, callId: callId(), runId: run.id, lines: run.said });
    const packet = voices[B]!.resumed[0] as Awaited<ReturnType<typeof handoverPacket>>;
    expect(packet).toMatchObject({ workflow: 'handover', node: 'a', status: 'awaiting_reply', lastLine: 'Hello Aisha, please say yes.' });
    expect(packet.variables).toEqual({ name: 'Aisha' });
    expect(packet.transcript).toEqual([{ role: 'assistant', text: 'Hello Aisha, please say yes.' }]);
    expect(JSON.stringify(packet)).not.toContain('900101145678');
    void startRun; void parseKey; void recordSample;
  });
});

describe('injecting latency', () => {
  it('ignores one slow reply, but fails over once latency is sustained, without replaying a line that did play', async () => {
    await reset();
    const a = voices[A]!; const orig = a.speak.bind(a);
    let n = 0; a.speak = async (t: string) => { const r = await orig(t); return ++n === 1 ? { latencyMs: 3500 } : r; };
    const one = await speakLines(session(), { tenantId, callId: callId(), lines: LINES });
    expect(one.switches).toEqual([]);                                             // a single slow reply is not a failure

    await reset();
    voices[A]!.mode = 'slow';
    const many = await speakLines(session(), { tenantId, callId: callId(), lines: ['one', 'two', 'three', 'four', 'five', 'six', 'seven'] });
    expect(many.switches).toEqual([{ from: A, to: B, trigger: 'latency' }]);
    expect(voices[A]!.said).toEqual(['one', 'two', 'three', 'four', 'five']);      // the slow lines did play: they are not said twice
    expect(voices[B]!.said).toEqual(['One moment please.', 'six', 'seven']);
    expect(many.played.every((p) => !p.replay)).toBe(true);
    expect(await healthOf(A)).toMatchObject({ state: 'failed', reason: 'Sustained high latency.' });
  });

  it('treats a long silence as the line not having played, and says it again on the next provider', async () => {
    await reset();
    voices[A]!.mode = 'dead_air';
    const r = await speakLines(session(), { tenantId, callId: callId(), lines: LINES });
    expect(r.switches[0]).toMatchObject({ from: A, to: B, trigger: 'dead_air' });
    expect(voices[B]!.said).toEqual(['One moment please.', ...LINES]);
    expect(voices[A]!.said).toEqual([]);
  });
});

describe('running the balance to zero', () => {
  it('fails over at once when our ledger shows the balance has run out, so the call never starts on that provider', async () => {
    await reset();
    await must(post(`/internal/providers/${A}/funding`, { kind: 'topup', amount: '10.00', currency: 'USD' }));
    expect(await healthOf(A)).toBeUndefined();                                   // funded: nothing changes
    await must(post(`/internal/providers/${A}/funding`, { kind: 'usage', amount: '-10.00', currency: 'USD' }));
    expect(await healthOf(A)).toMatchObject({ state: 'unfunded' });
    const r = await speakLines(session(), { tenantId, callId: callId(), lines: LINES });
    expect(voices[A]!.attempts).toBe(0);
    expect(voices[B]!.said).toEqual(LINES);
    expect(r.outcome).toBe('completed');
    await must(post(`/internal/providers/${A}/funding`, { kind: 'topup', amount: '100.00', currency: 'USD' }));   // topped up again for the tests that follow
  });

  it('fails over immediately when the provider itself says it has no credit, without retrying it', async () => {
    await reset();
    await env.pool.query(`DELETE FROM provider_funding_entries WHERE provider_id = $1`, [A]).catch(() => undefined);
    voices[A]!.mode = 'no_credit';
    const r = await speakLines(session(), { tenantId, callId: callId(), lines: LINES });
    expect(voices[A]!.attempts).toBe(1);                                         // exactly one try: no retry
    expect(r.switches).toEqual([{ from: A, to: B, trigger: 'funding' }]);
    expect(voices[B]!.said).toEqual(['One moment please.', ...LINES]);
    expect(await healthOf(A)).toMatchObject({ state: 'unfunded' });
  });

  it('puts a topped-up provider on probation instead of sending traffic straight back', async () => {
    await reset();
    await must(post(`/internal/providers/${C}/funding`, { kind: 'topup', amount: '5.00', currency: 'USD' }));
    await must(post(`/internal/providers/${C}/funding`, { kind: 'usage', amount: '-5.00', currency: 'USD' }));
    expect(await healthOf(C)).toMatchObject({ state: 'unfunded' });
    await must(post(`/internal/providers/${C}/funding`, { kind: 'topup', amount: '50.00', currency: 'USD' }));
    expect(await healthOf(C)).toMatchObject({ state: 'failed' });                // on probation, not healthy
  });
});

describe('hysteresis', () => {
  const probe = (id: string, kind: 'ok' | 'error') => withActor(env.pool, { kind: 'internal' }, (c) => recordSample(c, { providerId: id, kind, latencyMs: 200, probe: true, tenantId, at: new Date(clock) }));

  it('does not return to a recovered provider on the first good sign, nor part-way through a call', async () => {
    await reset();
    voices[A]!.mode = 'dead';
    await speakLines(session(), { tenantId, callId: callId(), lines: LINES });
    expect((await healthOf(A))!.state).toBe('failed');

    voices[A]!.mode = 'ok';
    tick(5); await probe(A, 'ok');
    expect((await healthOf(A))!.state).toBe('failed');                           // one good probe: not yet
    for (let i = 0; i < 4; i++) { tick(2); await probe(A, 'ok'); }
    expect((await healthOf(A))!.state).toBe('failed');                           // five good probes, but a moment apart
    tick(500); for (let i = 0; i < 5; i++) { tick(1); await probe(A, 'ok'); }
    expect((await healthOf(A))!.state).toBe('failed');                           // still not: long after failing, but the run itself is only seconds long
    tick(500); for (let i = 0; i < 5; i++) { tick(40); await probe(A, 'ok'); }
    expect((await healthOf(A))!.state).toBe('healthy');                          // a run of good attempts spanning the minimum time

    const after = voices[A]!.said.length;
    voices[B]!.said.length = 0;
    await speakLines(session(), { tenantId, callId: callId(), lines: ['fresh call'] });
    expect(voices[A]!.said.length).toBe(after + 1);                              // a new call uses the recovered provider again
  });

  it('keeps a call already moved to the secondary there, even once the primary has recovered', async () => {
    await reset();
    voices[A]!.mode = 'dead';
    const events: string[] = [];
    const b = voices[B]!; const orig = b.speak.bind(b);
    b.speak = async (t: string) => { if (t === 'two') { voices[A]!.mode = 'ok'; tick(500); } events.push(t); return orig(t); };
    await speakLines(session(), { tenantId, callId: callId(), lines: ['one', 'two', 'three'] });
    expect(voices[B]!.said).toEqual(['One moment please.', 'one', 'two', 'three']);   // never bounced back mid-call
  });
});

describe('total failure: the call is never dropped dead', () => {
  it('says the holding message, offers a callback and records it, even when nothing else works', async () => {
    await reset();
    for (const id of [A, B, C]) voices[id]!.mode = 'dead';
    const id = callId();
    const r = await speakLines(session(), { tenantId, callId: id, lines: LINES, contactRef: 'crm-1234' });
    expect(r.outcome).toBe('fallback');
    expect(r.played).toEqual([]);
    expect(telephony.log[0]).toContain('holding:We are sorry');
    expect(telephony.log).toContain('offer_callback');
    const cb = (await env.pool.query('SELECT contact_ref, reason FROM callback_requests WHERE call_id = $1', [id])).rows;
    expect(cb).toEqual([{ contact_ref: 'crm-1234', reason: 'every voice provider failed' }]);
    expect((await get(`/internal/calls/${id}/events`)).json().map((e: { type: string }) => e.type)).toContain('failover.fallback');
  });

  it('transfers to a person when the client has one available', async () => {
    await reset();
    for (const id of [A, B, C]) voices[id]!.mode = 'dead';
    await must(put(`/internal/tenants/${tenantId}/fallback`, { holdingMessage: 'Please hold for a colleague.', offerCallback: true, humanTransfer: true, voicemail: false }));
    const r = await speakLines(session({ humanAvailable: async () => true }), { tenantId, callId: callId(), lines: LINES });
    expect(telephony.log).toEqual(['holding:Please hold for a colleague.', 'transfer']);
    expect(r.fallback!.done).toContain('transfer_human');
    const none = await speakLines(session({ humanAvailable: async () => false }), { tenantId, callId: callId(), lines: LINES });
    expect(none.fallback!.steps.map((s) => s.kind)).toEqual(['holding_message', 'offer_callback', 'record_callback_request']);
  });

  it('still records the callback request when the telephony leg fails too, and does not throw', async () => {
    await reset();
    for (const id of [A, B, C]) voices[id]!.mode = 'dead';
    telephony.broken = true;
    const id = callId();
    const r = await speakLines(session(), { tenantId, callId: id, lines: LINES });
    expect(r.outcome).toBe('fallback');
    expect(r.fallback!.failed).toEqual(expect.arrayContaining(['holding_message', 'offer_callback']));
    expect((await env.pool.query('SELECT count(*)::int AS n FROM callback_requests WHERE call_id = $1', [id])).rows[0].n).toBe(1);
  });

  it('applies when there is no route configured at all', async () => {
    await reset();
    const t = (await must(post('/internal/tenants', { name: 'No Route Co' }))).json().id;
    const r = await speakLines(session(), { tenantId: t, callId: callId(), lines: LINES });
    expect(r.outcome).toBe('fallback');
    expect(telephony.log.some((l) => l.startsWith('holding:'))).toBe(true);
  });
});

describe('found in review', () => {
  it('tries the bridge again on a provider that is still trusted, instead of giving the call up after one blip', async () => {
    await reset();
    voices[A]!.mode = 'dead';
    const b = voices[B]!; const orig = b.speak.bind(b);
    let bridgeCalls = 0;
    b.speak = async (t: string) => { if (t === b.bridge && ++bridgeCalls === 1) { b.attempts++; throw new Error('blip'); } return orig(t); };
    const r = await speakLines(session(), { tenantId, callId: callId(), lines: LINES });
    expect(r.outcome).toBe('completed');                                       // B is fine; one error on the bridge does not condemn it
    expect(b.said).toEqual(['One moment please.', ...LINES]);
    expect(voices[C]!.attempts).toBe(0);
  });

  it('keeps a provider that said it has no credit out of use until it is topped up, whatever samples arrive', async () => {
    await reset();
    await must(post(`/internal/providers/${C}/funding`, { kind: 'topup', amount: '20', currency: 'USD' }));   // our ledger shows money
    voices[C]!.mode = 'no_credit';
    await must(put(`/internal/tenants/${tenantId}/routes/voice`, { providerIds: [C, B] }));
    await speakLines(session(), { tenantId, callId: callId(), lines: ['hi'] });
    expect(await healthOf(C)).toMatchObject({ state: 'unfunded' });
    for (let i = 0; i < 6; i++) { tick(60); await must(post(`/internal/providers/${C}/samples`, { kind: 'ok', latencyMs: 100 })); }
    expect(await healthOf(C)).toMatchObject({ state: 'unfunded' });             // good probes do not lift it: the provider said it has no credit
    await must(post(`/internal/providers/${C}/funding`, { kind: 'adjustment', amount: '1', currency: 'USD' }));
    expect(await healthOf(C)).toMatchObject({ state: 'unfunded' });             // nor does an entry that is not a top-up
    await must(post(`/internal/providers/${C}/funding`, { kind: 'topup', amount: '50', currency: 'USD' }));
    expect(await healthOf(C)).toMatchObject({ state: 'failed' });               // a top-up puts it on probation
    await must(put(`/internal/tenants/${tenantId}/routes/voice`, { providerIds: [A, B, C] }));
  });

  it('lets a failed provider earn its way back by probing, and does not probe one that is out of funding', async () => {
    await reset();
    voices[A]!.mode = 'dead';
    await speakLines(session(), { tenantId, callId: callId(), lines: LINES });
    expect((await healthOf(A))!.state).toBe('failed');
    const { probeProviders } = await import('../src/resilience/session.js');
    voices[A]!.mode = 'ok';
    (voices[A] as VoiceRuntime & { ping?: () => Promise<{ latencyMs: number }> }).ping = async () => ({ latencyMs: 150 });
    for (let i = 0; i < 4; i++) { tick(5); await probeProviders(session()); }
    expect((await healthOf(A))!.state).toBe('failed');                          // good, but a few seconds apart
    for (let i = 0; i < 6; i++) { tick(30); await probeProviders(session()); }
    expect((await healthOf(A))!.state).toBe('healthy');                         // good over the minimum time
    // one that is out of funding is left alone
    await env.pool.query(`INSERT INTO provider_health (provider_id, state, reason) VALUES ($1, 'unfunded', 'x') ON CONFLICT (provider_id) DO UPDATE SET state = 'unfunded'`, [B]);
    (voices[B] as VoiceRuntime & { ping?: () => Promise<{ latencyMs: number }> }).ping = async () => { throw new Error('should not be probed'); };
    expect((await probeProviders(session())).map((p) => p.providerId)).not.toContain(B);
  });
});

describe('a voice provider an operator drained', () => {
  it('is skipped for new calls while its real health stays healthy, and is used again once restored', async () => {
    await reset();
    await must(post('/internal/control-tower/actions', { action: 'drain', providerId: A, reason: 'Voice A maintenance.' }));
    try {
      const r = await speakLines(session(), { tenantId, callId: callId(), lines: LINES });
      expect(r.outcome).toBe('completed');
      expect(voices[A]!.attempts).toBe(0);                                       // never asked
      expect(voices[B]!.said).toEqual(LINES);
      expect(await healthOf(A)).toBeUndefined();                                 // draining is not a failure
    } finally { await must(post('/internal/control-tower/actions', { action: 'restore', providerId: A, reason: 'Maintenance over.' })); }
    await reset();
    await speakLines(session(), { tenantId, callId: callId(), lines: LINES });
    expect(voices[A]!.said).toEqual(LINES);
  });
});
