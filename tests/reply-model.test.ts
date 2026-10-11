import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKey } from '../src/secrets.js';
import { replyRun, startRun } from '../src/store/runs.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';
import { DEFAULT_JOURNEY } from '../src/journey/tracker.js';
import { INTERPRET_MIN_CONFIDENCE, reply, start, type Deps, type InterpretRequest, type InterpretResult, type Interpreter, type ReplyReader } from '../src/workflows/engine.js';

// A reply the phrase rules cannot read goes to a model: the smallest tier first, a tier up when its answer is not good
// enough to take, every attempt recorded with its tokens. Rules first, and a sensitive answer never reaches a model.

const def: WorkflowDefinition = {
  start: 'ask', variables: [],
  nodes: {
    ask: { type: 'speak', speech: 'fixed', text: 'Can you pay this week?', listen: { captureAs: 'a', intents: { yes: ['yes', 'boleh'], no: ['no', 'tidak boleh'], later: ['next week'] } },
      transitions: [{ when: { var: 'a_intent', op: 'eq', value: 'yes' }, to: 'thanks' }, { when: { var: 'a_intent', op: 'eq', value: 'no' }, to: 'sorry' }, { to: 'again' }] },
    again: { type: 'speak', speech: 'fixed', text: 'Sorry, could you say that again?', listen: { captureAs: 'b', intents: { yes: ['yes'], no: ['no'] } }, transitions: [{ to: 'done' }] },
    thanks: { type: 'speak', speech: 'fixed', text: 'Thank you.', transitions: [{ to: 'done' }] },
    sorry: { type: 'speak', speech: 'fixed', text: 'We understand.', transitions: [{ to: 'done' }] },
    done: { type: 'end', outcome: 'ok' },
  },
};

/** A stand-in model: answers from a script, and remembers what it was asked. */
function model(tier: Interpreter['tier'], answer: Partial<InterpretResult> | (() => Promise<InterpretResult>)) {
  const asked: InterpretRequest[] = [];
  const m: Interpreter = {
    tier, model: `${tier}-model`,
    interpret: async (q) => { asked.push(q); return typeof answer === 'function' ? answer() : { intent: null, confidence: 0.9, inputTokens: 120, outputTokens: 8, ...answer }; },
  };
  return { m, asked };
}
const reader = (primary: Interpreter, escalate?: Interpreter): ReplyReader => ({ primary, escalate, minConfidence: INTERPRET_MIN_CONFIDENCE });
const deps = (interpreter?: ReplyReader, extra: Partial<Deps> = {}): Deps => ({ load: () => def, interpreter, ...extra });
const heardOf = (records: { type: string; payload: Record<string, unknown> }[]) => records.find((r) => r.type === 'heard')!.payload;

describe('a reply the phrase rules cannot read', () => {
  it('is read by the configured model, and the call goes where that reading leads, with the attempt recorded', async () => {
    const haiku = model('haiku', { intent: 'yes', confidence: 0.92, reason: 'The caller agrees to pay.' });
    const s = await start('w', {}, deps(reader(haiku.m)));
    const r = await reply(s.state, 'sure thing, I will sort it out on Friday', deps(reader(haiku.m)));
    expect(r.state.vars.a_intent).toBe('yes');
    expect(r.records.find((x) => x.type === 'route')!.payload).toMatchObject({ to: 'thanks' });
    expect(heardOf(r.records)).toMatchObject({ intent: 'yes', rules: 'unknown' });
    expect(heardOf(r.records).interpreted).toEqual([{ model: 'haiku-model', tier: 'haiku', inputTokens: 120, outputTokens: 8, confidence: 0.92, why: 'The caller agrees to pay.', intent: 'yes', decision: 'proceeded', reason: 'The model read the reply as "yes".' }]);
    // it was offered every intent of the node, with the phrases as examples
    expect(haiku.asked).toEqual([{ reply: 'sure thing, I will sort it out on Friday', intents: { yes: ['yes', 'boleh'], no: ['no', 'tidak boleh'], later: ['next week'] } }]);
  });

  it('never asks a model when the rules read the reply, or when no model is configured', async () => {
    const haiku = model('haiku', { intent: 'no', confidence: 1 });
    const s = await start('w', {}, deps(reader(haiku.m)));
    const r = await reply(s.state, 'yes', deps(reader(haiku.m)));
    expect(r.state.vars.a_intent).toBe('yes');
    expect(haiku.asked).toEqual([]);
    expect(heardOf(r.records)).not.toHaveProperty('interpreted');
    const none = await reply(s.state, 'sure thing', deps());
    expect(none.state.vars.a_intent).toBe('unknown');
    expect(heardOf(none.records)).not.toHaveProperty('interpreted');
  });

  it('offers only the intents the rules found when the reply was ambiguous', async () => {
    const haiku = model('haiku', { intent: 'no', confidence: 0.85 });
    const s = await start('w', {}, deps(reader(haiku.m)));
    const r = await reply(s.state, 'yes I would, but no, not this week', deps(reader(haiku.m)));
    expect(haiku.asked[0]!.intents).toEqual({ yes: ['yes', 'boleh'], no: ['no', 'tidak boleh'] });
    expect(heardOf(r.records)).toMatchObject({ rules: 'ambiguous', intent: 'no' });
  });

  it('asks a tier up when the first answer is not confident enough, and records both with the escalation', async () => {
    const haiku = model('haiku', { intent: 'yes', confidence: 0.4, inputTokens: 100, outputTokens: 5 });
    const sonnet = model('sonnet', { intent: 'no', confidence: 0.9, inputTokens: 100, outputTokens: 12 });
    const s = await start('w', {}, deps());
    const r = await reply(s.state, 'I suppose, though honestly money is tight', deps(reader(haiku.m, sonnet.m)));
    expect(r.state.vars.a_intent).toBe('no');
    expect(heardOf(r.records).interpreted).toEqual([
      expect.objectContaining({ tier: 'haiku', decision: 'rejected', reason: `The model's confidence (0.4) was below ${INTERPRET_MIN_CONFIDENCE}.`, inputTokens: 100, outputTokens: 5 }),
      expect.objectContaining({ tier: 'sonnet', escalatedFrom: 'haiku', decision: 'proceeded', intent: 'no', inputTokens: 100, outputTokens: 12 }),
    ]);
  });

  it('keeps the rules\' answer when no answer is good enough: too unsure, not one of the intents offered, or no confidence', async () => {
    const s = await start('w', {}, deps());
    for (const [answer, reason] of [
      [{ intent: 'yes', confidence: 0.5 }, 'below'],
      [{ intent: 'constructor', confidence: 0.99 }, 'not offered'],             // a name every object inherits is still not an intent here (L-003)
      [{ intent: 'maybe', confidence: 0.99 }, 'not offered'],
      [{ intent: 'yes', confidence: 7 }, 'no usable confidence'],
      [{ intent: 'yes', confidence: Number.NaN }, 'no usable confidence'],
    ] as const) {
      const r = await reply(s.state, 'hmm well', deps(reader(model('haiku', answer).m)));
      expect(r.state.vars.a_intent).toBe('unknown');
      expect(r.records.find((x) => x.type === 'route')!.payload).toMatchObject({ to: 'again' });
      expect((heardOf(r.records).interpreted as { decision: string; reason: string }[])[0]).toMatchObject({ decision: 'rejected', reason: expect.stringContaining(reason) });
    }
  });

  it('takes a confident "cannot tell" as it is: the reply stays unknown and no tier up is asked', async () => {
    const haiku = model('haiku', { intent: null, confidence: 0.95 });
    const sonnet = model('sonnet', { intent: 'yes', confidence: 0.99 });
    const s = await start('w', {}, deps());
    const r = await reply(s.state, 'what was the question', deps(reader(haiku.m, sonnet.m)));
    expect(r.state.vars.a_intent).toBe('unknown');
    expect(sonnet.asked).toEqual([]);
    expect((heardOf(r.records).interpreted as unknown[])[0]).toMatchObject({ decision: 'proceeded', reason: expect.stringContaining('could not tell') });
  });

  it('carries on by the rules when the model fails, asking a tier up first, and records that the model gave no answer', async () => {
    const broken = model('haiku', async () => { throw new Error('upstream 529'); });
    const sonnet = model('sonnet', async () => { throw new Error('timeout'); });
    const s = await start('w', {}, deps());
    const r = await reply(s.state, 'hmm well', deps(reader(broken.m, sonnet.m)));
    expect(r.state.vars.a_intent).toBe('unknown');
    expect(r.records.find((x) => x.type === 'route')!.payload).toMatchObject({ to: 'again' });
    expect(heardOf(r.records).interpreted).toEqual([
      { model: 'haiku-model', tier: 'haiku', inputTokens: 0, outputTokens: 0, decision: 'rejected', reason: 'The model gave no answer (it failed), so its tokens are not known.' },
      { model: 'sonnet-model', tier: 'sonnet', escalatedFrom: 'haiku', inputTokens: 0, outputTokens: 0, decision: 'rejected', reason: 'The model gave no answer (it failed), so its tokens are not known.' },
    ]);
    expect(JSON.stringify(r.records)).not.toContain('529');                  // another system's error text is not kept
  });

  it('never gives a model a sensitive answer, or a phone number in what was said, or a variable of the call', async () => {
    const haiku = model('haiku', { intent: 'right', confidence: 0.99 });
    const secret: WorkflowDefinition = { start: 'a', variables: ['account'], nodes: { a: { type: 'speak', speech: 'fixed', text: 'Last four digits?', listen: { captureAs: 'ic', sensitive: true, intents: { right: ['5678'] } }, transitions: [{ to: 'z' }] }, z: { type: 'end', outcome: 'ok' } } };
    const s = await start('w', { account: 'ACC-77' }, { load: () => secret });
    const r = await reply(s.state, 'it is five six seven eight', { load: () => secret, interpreter: reader(haiku.m) });
    expect(haiku.asked).toEqual([]);
    expect(heardOf(r.records)).not.toHaveProperty('interpreted');
    const s2 = await start('w', { account: 'ACC-77' }, deps());
    await reply(s2.state, 'call me back on 012-345 6789 tomorrow', deps(reader(haiku.m)));
    expect(haiku.asked).toHaveLength(1);
    expect(haiku.asked[0]!.reply).toBe('call me back on [number] tomorrow');
    expect(JSON.stringify(haiku.asked)).not.toContain('ACC-77');
  });

  it('counts a reply the model read as understood, so two of them do not pass the call to a person', async () => {
    const loop: WorkflowDefinition = { start: 'q', nodes: { q: { type: 'speak', speech: 'fixed', text: 'Can you pay?', listen: { captureAs: 'a', intents: { yes: ['yes'], no: ['no'] } }, transitions: [{ when: { var: 'a_intent', op: 'eq', value: 'yes' }, to: 'z' }, { to: 'q' }] }, z: { type: 'end', outcome: 'ok' } } };
    const haiku = model('haiku', { intent: 'no', confidence: 0.9 });
    const d: Deps = { load: () => loop, journey: DEFAULT_JOURNEY, interpreter: reader(haiku.m) };
    let st = (await start('w', {}, d)).state;
    for (const t of ['money is a bit short right now', 'still short this month']) st = (await reply(st, t, d)).state;
    expect(st.status).toBe('awaiting_reply');
    expect(st.escalation).toBeUndefined();
    // without the model the same two replies are not understood, and the call goes to a person
    let plain = (await start('w', {}, { ...d, interpreter: undefined })).state;
    for (const t of ['money is a bit short right now', 'still short this month']) plain = (await reply(plain, t, { ...d, interpreter: undefined })).state;
    expect(plain.escalation).toMatchObject({ trigger: 'failed_recoveries' });
  });
});

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env;
let workflowId: string;
const st = () => env.staffToken;
const post = (u: string, b?: unknown) => env.call(st(), 'POST', u, b);
const put = (u: string, b?: unknown) => env.call(st(), 'PUT', u, b);
const get = (u: string) => env.call(st(), 'GET', u);
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}
const appHaiku = model('haiku', { intent: 'yes', confidence: 0.4, inputTokens: 90, outputTokens: 4 });
const appSonnet = model('sonnet', { intent: 'yes', confidence: 0.95, inputTokens: 90, outputTokens: 9 });

describe('reading replies with a model, through the database', () => {
  beforeAll(async () => {
    env = await (await import('./helpers.js')).setupDb({ interpreters: { haiku: appHaiku.m, sonnet: appSonnet.m } });
    const tenantId = (await must(post('/internal/tenants', { name: 'Reply Reading Co' }))).json().id;
    const c = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'reply_flow', definition: def }))).json();
    await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'staging' }));
    workflowId = c.workflow.id;
  });
  afterAll(async () => { await env?.teardown(); });

  const run = async () => (await must(post(`/internal/workflows/${workflowId}/runs`, { environment: 'staging', kind: 'test', variables: {} }))).json().id as string;
  const decisions = async (runId: string) => (await get(`/internal/ai-decisions?subjectType=run_step&subjectId=${runId}:ask`)).json() as Record<string, unknown>[];

  it('reads by rules only until the task is configured, then by the configured tier, escalating as configured, every attempt in the audit trail', async () => {
    const before = await run();
    const r0 = (await must(post(`/internal/workflow-runs/${before}/reply`, { text: 'sure thing' }))).json();
    expect(r0.variables.a_intent).toBe('unknown');
    expect(appHaiku.asked).toEqual([]);
    expect(await decisions(before)).toEqual([]);

    await must(put('/internal/model-config/interpret_reply', { reason: 'Set up for this test.', tier: 'haiku', modelId: 'haiku-model', escalateTo: 'sonnet' }));
    const runId = await run();
    const r1 = (await must(post(`/internal/workflow-runs/${runId}/reply`, { text: 'sure thing' }))).json();
    expect(r1.variables.a_intent).toBe('yes');
    const ds = (await decisions(runId)).sort((a, b) => Number(a.id) - Number(b.id));
    expect(ds).toEqual([
      expect.objectContaining({ task: 'interpret_reply', decision: 'rejected', model: 'haiku-model', tier: 'haiku', input_tokens: 90, output_tokens: 4, confidence: '0.400', escalated_from: null }),
      expect.objectContaining({ task: 'interpret_reply', decision: 'proceeded', model: 'sonnet-model', tier: 'sonnet', input_tokens: 90, output_tokens: 9, confidence: '0.950', escalated_from: 'haiku' }),
    ]);
    const usage = (await get('/internal/ai-usage')).json().filter((u: { task: string }) => u.task === 'interpret_reply');
    expect(usage.map((u: { tier: string; escalations: number; rejected: number }) => [u.tier, u.escalations, u.rejected]).sort()).toEqual([['haiku', 0, 1], ['sonnet', 1, 0]]);

    // configured at a tier with no model connected: rules only, nothing recorded
    await must(put('/internal/model-config/interpret_reply', { reason: 'Set up for this test.', tier: 'opus', modelId: 'opus-model', escalateTo: null }));
    const none = await run();
    expect((await must(post(`/internal/workflow-runs/${none}/reply`, { text: 'sure thing' }))).json().variables.a_intent).toBe('unknown');
    expect(await decisions(none)).toEqual([]);
    await must(put('/internal/model-config/interpret_reply', { reason: 'Set up for this test.', tier: 'haiku', modelId: 'haiku-model', escalateTo: 'sonnet' }));
  });

  it('reads replies by rules only in a simulation, so the production gate gives the same answer every time and spends nothing unrecorded', async () => {
    const asked = appHaiku.asked.length + appSonnet.asked.length;
    const sim = (await must(post(`/internal/workflows/${workflowId}/simulate`, { scenarios: [{ name: 'unclear', variables: {}, replies: ['sure thing', 'yes'], expect: { outcome: 'ok' } }] }))).json();
    expect(sim.results[0]).toMatchObject({ passed: true });
    expect(appHaiku.asked.length + appSonnet.asked.length).toBe(asked);
  });

  it('asks the model with the turn claimed and no database connection held, so a second reply meanwhile is refused and the pool stays free', async () => {
    const key = parseKey(env.config.VOICELAB_SECRET_KEY);
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    let entered!: () => void; const asking = new Promise<void>((r) => { entered = r; });
    const slow = model('haiku', async () => { entered(); await gate; return { intent: 'no', confidence: 0.9, inputTokens: 10, outputTokens: 1 }; });
    const d = { pool: env.pool, key, interpreters: { haiku: slow.m } };
    const started = await startRun(d, null, { workflowId, environment: 'staging', kind: 'test', variables: {} });
    const first = replyRun(d, started.id, 'money is tight');
    await asking;
    expect(env.pool.totalCount - env.pool.idleCount).toBe(0);               // nothing checked out while the model thinks (L-040)
    await expect(replyRun(d, started.id, 'yes')).rejects.toMatchObject({ status: 409 });   // the turn is claimed (L-001)
    release();
    expect((await first).variables.a_intent).toBe('no');
  });
});
