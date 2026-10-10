import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '../src/workflows/definition.js';
import { reply, start, type Deps } from '../src/workflows/engine.js';

const def: WorkflowDefinition = {
  start: 'ask', variables: ['name'],
  nodes: {
    ask: { type: 'speak', speech: 'hybrid', text: 'Hello {{name}}, can you pay this week?', listen: { captureAs: 'answer', intents: { yes: ['yes', 'boleh'], no: ['no', 'tidak boleh'] } },
      transitions: [{ when: { var: 'answer_intent', op: 'eq', value: 'yes' }, to: 'thanks' }, { when: { var: 'answer_intent', op: 'eq', value: 'no' }, to: 'sorry' }] },
    thanks: { type: 'speak', speech: 'fixed', text: 'Thank you.', transitions: [{ to: 'done' }] },
    sorry: { type: 'speak', speech: 'fixed', text: 'We understand.', transitions: [{ to: 'done' }] },
    done: { type: 'end', outcome: 'ok' },
  },
};
const deps = (extra: Partial<Deps> = {}): Deps => ({ load: () => def, ...extra });

describe('every decision leaves its reason', () => {
  it('records which rule sent the call where, and the words that decided what the caller meant', async () => {
    const s = await start('w', { name: 'Aisha' }, deps());
    const r = await reply(s.state, 'tidak boleh sorry', deps());
    const types = r.records.map((x) => x.type);
    expect(types).toEqual(['heard', 'route', 'say', 'route', 'reached_end', 'end']);
    expect(r.records[0]!.payload).toMatchObject({ intent: 'no', matched: ['no: tidak boleh'] });      // not also "boleh"
    expect(r.records[1]!.payload).toEqual({ to: 'sorry', via: 'transition 2 (condition held)' });
    expect(r.records[3]!.payload).toEqual({ to: 'done', via: 'transition 1 (always)' });
  });
  it('says plainly when nothing matched and the call ended cleanly', async () => {
    const s = await start('w', { name: 'Aisha' }, deps());
    const r = await reply(s.state, 'hmm', deps());
    expect(r.records.find((x) => x.type === 'route')!.payload).toEqual({ to: null, via: 'no transition matched' });
  });
  it('records nothing of a sensitive answer, not even the words that matched', async () => {
    const d: WorkflowDefinition = { start: 'a', nodes: { a: { type: 'speak', speech: 'fixed', text: 'Last four digits?', listen: { captureAs: 'ic', sensitive: true, intents: { right: ['5678'] } }, transitions: [{ to: 'z' }] }, z: { type: 'end', outcome: 'ok' } } };
    const s = await start('w', {}, { load: () => d });
    const r = await reply(s.state, 'it is 5678', { load: () => d });
    const heard = r.records.find((x) => x.type === 'heard')!.payload;
    expect(heard).toMatchObject({ text: '[hidden]', intent: 'right' });
    expect(JSON.stringify(r.records)).not.toContain('5678');
  });
  it('records what a model said about the line it wrote, with numbers scrubbed, and accepts a plain string too', async () => {
    const dyn: WorkflowDefinition = { start: 'd', nodes: { d: { type: 'speak', speech: 'dynamic', prompt: 'Greet', text: 'Hi', transitions: [{ to: 'e' }] }, e: { type: 'end', outcome: 'ok' } } };
    const rich = { generate: async () => ({ text: 'Good day.', model: 'small', reasoning: 'Caller at +60123456789 prefers short greetings.', policy: 'greeting-v2', inputTokens: 40, outputTokens: 5, confidence: 0.9 }) };
    const r = await start('w', {}, { load: () => dyn, speaker: rich });
    const say = r.records.find((x) => x.type === 'say')!.payload;
    expect(say.text).toBe('Good day.');
    expect(say.ai).toEqual({ model: 'small', reasoning: 'Caller at [number] prefers short greetings.', policy: 'greeting-v2', inputTokens: 40, outputTokens: 5, confidence: 0.9, decision: 'proceeded', decisionReason: 'The line passed the checks and was used.' });
    const plain = await start('w', {}, { load: () => dyn, speaker: { generate: async () => 'Hello.' } });
    // Even a plain string from a model is a model decision: it is recorded as used, without a model name.
    expect(plain.records.find((x) => x.type === 'say')!.payload.ai).toEqual({ decision: 'proceeded', decisionReason: 'The line passed the checks and was used.' });
  });
});

import { DEFAULT_JOURNEY } from '../src/journey/tracker.js';
import { classifyChange } from '../src/workflows/versioning.js';
import { validateDefinition } from '../src/workflows/validate.js';

describe('reading each turn: re-routing and escalation', () => {
  const flow: WorkflowDefinition = {
    start: 'ask', intentRoutes: [{ when: { kind: 'complaint' }, to: 'listen' }, { when: { topic: 'schedule' }, to: 'callback' }],
    nodes: {
      ask: { type: 'speak', speech: 'fixed', text: 'Can you pay this week?', listen: { captureAs: 'a', intents: { yes: ['yes'], no: ['no'] } }, transitions: [{ when: { var: 'a_intent', op: 'eq', value: 'yes' }, to: 'ask' }, { when: { var: 'a_intent', op: 'eq', value: 'no' }, to: 'ask' }, { to: 'ask' }] },
      listen: { type: 'speak', speech: 'fixed', text: 'I am sorry to hear that. Tell me more.', listen: { captureAs: 'c' }, transitions: [{ to: 'ask' }] },
      callback: { type: 'speak', speech: 'fixed', text: 'When is a good time?', listen: { captureAs: 't' }, transitions: [{ to: 'done' }] },
      done: { type: 'end', outcome: 'ok' },
    },
  };
  const d = (): Deps => ({ load: () => flow, journey: DEFAULT_JOURNEY });
  const kinds = (r: { records: { type: string }[] }) => r.records.map((x) => x.type);

  it('records what each turn was: kind, topic, sentiment', async () => {
    const s = await start('w', {}, d());
    const r = await reply(s.state, 'yes okay thanks', d());
    expect(r.records.find((x) => x.type === 'heard')!.payload.analysis).toMatchObject({ kind: 'other', understood: true });
    expect((r.records.find((x) => x.type === 'heard')!.payload.analysis as { sentiment: number }).sentiment).toBeGreaterThan(0);
  });
  it('sends the call somewhere else when the caller\'s intent changes, and says so', async () => {
    let s = await start('w', {}, d());
    s = await reply(s.state, 'yes', d());                                            // a calm answer first
    const r = await reply(s.state, 'this is unacceptable, I want to complain', d());
    expect(kinds(r)).toContain('reroute');
    expect(r.state.awaiting?.node).toBe('listen');
    expect(r.records.find((x) => x.type === 'reroute')!.payload).toMatchObject({ to: 'listen', kind: 'complaint' });
  });
  it('does not re-route when the intent has not changed', async () => {
    let s = await start('w', {}, d());
    s = await reply(s.state, 'yes', d());
    const r = await reply(s.state, 'yes', d());
    expect(kinds(r)).not.toContain('reroute');
  });
  it('escalates to a person after two turns it could not understand, and records why', async () => {
    let s = await start('w', {}, d());
    s = await reply(s.state, 'hmm what', d());                                       // unknown: one
    expect(s.state.status).toBe('awaiting_reply');
    const r = await reply(s.state, 'uh', d());                                       // unknown again: two
    expect(r.state).toMatchObject({ status: 'ended', outcome: 'handoff_human', escalation: { trigger: 'failed_recoveries', node: 'ask' } });
    expect(kinds(r)).toEqual(['heard', 'escalate', 'handoff_human', 'end']);
    expect(r.records.find((x) => x.type === 'escalate')!.payload).toMatchObject({ trigger: 'failed_recoveries', recoveries: 2 });
  });
  it('escalates at once on severe sentiment', async () => {
    const s = await start('w', {}, d());
    const r = await reply(s.state, 'I will call my lawyer', d());
    expect(r.state).toMatchObject({ status: 'ended', outcome: 'handoff_human', escalation: { trigger: 'severe_sentiment' } });
  });
  it('reads nothing of a sensitive answer, so it can neither re-route nor escalate', async () => {
    const sens: WorkflowDefinition = { start: 'a', nodes: { a: { type: 'speak', speech: 'fixed', text: 'PIN?', listen: { captureAs: 'p', sensitive: true }, transitions: [{ to: 'z' }] }, z: { type: 'end', outcome: 'ok' } } };
    const s = await start('w', {}, { load: () => sens, journey: DEFAULT_JOURNEY });
    const r = await reply(s.state, 'my lawyer sue police', { load: () => sens, journey: DEFAULT_JOURNEY });
    expect(r.state.outcome).toBe('ok');
    expect(r.records.find((x) => x.type === 'heard')!.payload).not.toHaveProperty('analysis');
  });
  it('does nothing different when no journey reading is switched on', async () => {
    const s = await start('w', {}, { load: () => flow });
    const r = await reply(s.state, 'I will call my lawyer, this is unacceptable', { load: () => flow });
    expect(r.state.status).toBe('awaiting_reply');
    expect(kinds(r)).not.toContain('escalate');
  });
  it('checks intent routes when publishing: they must go somewhere that exists and say what they match', () => {
    const base = (routes: unknown) => ({ ...flow, intentRoutes: routes } as unknown);
    expect(validateDefinition(flow).errors).toEqual([]);
    expect(validateDefinition(base([{ when: { kind: 'complaint' }, to: 'nowhere' }])).errors.map((e) => e.code)).toContain('unknown_target');
    expect(validateDefinition(base([{ when: {}, to: 'listen' }])).errors.map((e) => e.code)).toContain('bad_intent_routes');
    expect(validateDefinition(base([{ when: { kind: 'shouting' }, to: 'listen' }])).errors.map((e) => e.code)).toContain('bad_intent_routes');
    expect(validateDefinition(base('x')).errors.map((e) => e.code)).toContain('bad_intent_routes');
  });
  it('counts a node that only an intent route reaches as reachable, and a change to the routes as a change of shape', () => {
    const only: WorkflowDefinition = { start: 'a', intentRoutes: [{ when: { kind: 'complaint' }, to: 'b' }], nodes: { a: { type: 'speak', speech: 'fixed', text: 'Hi', listen: { captureAs: 'x' }, transitions: [{ to: 'z' }] }, b: { type: 'end', outcome: 'escalated' }, z: { type: 'end', outcome: 'ok' } } };
    expect(validateDefinition(only).errors).toEqual([]);
    expect(classifyChange(only, { ...only, intentRoutes: [] })).toBe('major');
  });
});

describe('a line a model wrote is checked before it is spoken', () => {
  const dyn: WorkflowDefinition = { start: 'd', nodes: { d: { type: 'speak', speech: 'dynamic', prompt: 'Greet', text: 'Good day.', transitions: [{ to: 'e' }] }, e: { type: 'end', outcome: 'ok' } } };
  const say = async (g: string | { text: string }) => (await start('w', {}, { load: () => dyn, speaker: { generate: async () => g } })).records.find((x) => x.type === 'say')?.payload;

  it.each([
    ['empty', '   ', 'wrote nothing'],
    ['an unfilled slot', 'Hello {{name}}, how are you?', 'unfilled placeholder'],
    ['a phone number', 'Please call 012-345 6789 to pay.', 'phone number'],
    ['too long', 'word '.repeat(200), 'too long'],
  ])('turns down a line that is %s, speaks the fallback instead, and says why', async (_n, line, why) => {
    const p = await say(line);
    expect(p!.text).toBe('Good day.');
    expect(p!.ai).toMatchObject({ decision: 'rejected', decisionReason: expect.stringContaining(why) });
  });
  it('tidies stray spaces and line breaks, and says it did', async () => {
    const p = await say('  Good   morning,\n  how are you?  ');
    expect(p).toMatchObject({ text: 'Good morning, how are you?', ai: { decision: 'reworked' } });
  });
  it('uses a clean line as it is, and records that it was used', async () => {
    const p = await say('Good morning.');
    expect(p!.text).toBe('Good morning.');
    expect(p!.ai).toMatchObject({ decision: 'proceeded' });
  });
  it('stops the call rather than say something unchecked when there is no fallback', async () => {
    const nofb: WorkflowDefinition = { start: 'd', nodes: { d: { type: 'speak', speech: 'dynamic', prompt: 'Greet', transitions: [{ to: 'e' }] }, e: { type: 'end', outcome: 'ok' } } };
    const r = await start('w', {}, { load: () => nofb, speaker: { generate: async () => 'Call 012-345 6789' } });
    expect(r.state).toMatchObject({ status: 'ended', outcome: 'error' });
    expect(r.records.some((x) => x.type === 'say')).toBe(false);
  });
});
