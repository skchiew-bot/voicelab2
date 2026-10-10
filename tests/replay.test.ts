import { describe, expect, it } from 'vitest';
import { buildReplay, checkAdherence, type ReplayStep } from '../src/journey/replay.js';
import { DEFAULT_JOURNEY } from '../src/journey/tracker.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';
import { reply, start, type Deps, type StepRecord } from '../src/workflows/engine.js';

const def: WorkflowDefinition = {
  start: 'greet', variables: ['name'],
  intentRoutes: [{ when: { kind: 'complaint' }, to: 'listen' }],
  nodes: {
    greet: { type: 'speak', speech: 'hybrid', text: 'Hello {{name}}, can you pay this week?', listen: { captureAs: 'a', intents: { yes: ['yes'], no: ['no'] } },
      transitions: [{ when: { var: 'a_intent', op: 'eq', value: 'yes' }, to: 'thanks' }, { to: 'greet' }] },
    listen: { type: 'speak', speech: 'fixed', text: 'I am sorry to hear that.', listen: { captureAs: 'c' }, transitions: [{ to: 'greet' }] },
    thanks: { type: 'speak', speech: 'fixed', text: 'Thank you.', transitions: [{ to: 'done' }] },
    done: { type: 'end', outcome: 'paid_promise' },
  },
};

let clock = Date.parse('2026-06-01T10:00:00Z');
const at = (ms: number) => { clock += ms; return new Date(clock); };
const run = async (replies: string[], gaps: number[]) => {
  clock = Date.parse('2026-06-01T10:00:00Z');
  let gap = 0;
  const deps: Deps = { load: () => def, journey: DEFAULT_JOURNEY, now: () => at(gap) };
  const records: StepRecord[] = [];
  let r = await start('collections', { name: 'Aisha' }, deps);
  records.push(...r.records);
  for (const [i, text] of replies.entries()) {
    gap = gaps[i] ?? 1000;
    r = await reply(r.state, text, deps);
    records.push(...r.records);
  }
  const steps: ReplayStep[] = records.map((x, k) => ({ seq: k + 1, type: x.type, workflow: x.workflow, node: x.node ?? null, payload: x.payload, created_at: x.at!, occurred_at: x.at }));
  return { state: r.state, steps };
};
const runInfo = (state: { status: string; outcome?: string; error?: string }) => ({ id: 'r1', workflow: 'collections', status: state.status, outcome: state.outcome ?? null, error: state.error ?? null, environment: 'production', kind: 'live', versions: { collections: '2.0' } });

describe('a call put back together', () => {
  it('lays out every step in order with its reason, the transcript, and how long each step took', async () => {
    const { state, steps } = await run(['yes of course thanks'], [3000]);
    const rp = buildReplay({ run: runInfo(state), steps, definitions: { collections: def } });
    expect(rp.timeline.map((t) => t.type)).toEqual(['start', 'say', 'heard', 'route', 'say', 'route', 'reached_end', 'end']);
    expect(rp.transcript.map((t) => [t.speaker, t.text])).toEqual([['assistant', 'Hello Aisha, can you pay this week?'], ['caller', 'yes of course thanks'], ['assistant', 'Thank you.']]);
    const heard = rp.timeline.find((t) => t.type === 'heard')!;
    expect(heard.reasoning).toMatchObject({ intent: 'yes', matchedWords: ['yes: yes'] });
    expect(rp.timeline.find((t) => t.type === 'route')!.reasoning).toMatchObject({ rule: 'transition 1 (condition held)', to: 'thanks' });
    expect(rp.timeline.find((t) => t.type === 'say')!.policy).toBe('hybrid line: Hello {{name}}, can you pay this week?');   // the script, never the filled-in values
    expect(heard.latencyMs).toBe(3000);                                         // the caller took three seconds to answer
    expect(rp.summary).toMatchObject({ outcome: 'paid_promise', turns: 1, escalated: false });
  });

  it('keeps a sentiment line whose every point leads to the transcript line and the node', async () => {
    const { state, steps } = await run(['great thank you but no', 'no, that is bad'], [1000, 1000]);
    const rp = buildReplay({ run: runInfo(state), steps, definitions: { collections: def } });
    expect(rp.sentiment).toHaveLength(2);
    expect(rp.sentiment[0]!.sentiment).toBeGreaterThan(0);
    for (const point of rp.sentiment) {
      const line = rp.transcript[point.transcriptIndex]!;
      expect(line.speaker).toBe('caller');
      expect(line.sentiment).toBe(point.sentiment);
      expect(rp.timeline[point.timelineIndex]!.node).toBe(point.node);              // click a point: the line, and the node it was said at
      expect(rp.timeline[line.timelineIndex]!.type).toBe('heard');
    }
  });

  it('shows an escalation with the reason, and how the call kept to its workflow', async () => {
    const { state, steps } = await run(['hmm', 'uh'], [500, 500]);
    const rp = buildReplay({ run: runInfo(state), steps, definitions: { collections: def } });
    expect(state.outcome).toBe('handoff_human');
    expect(rp.summary.escalated).toBe(true);
    expect(rp.timeline.find((t) => t.type === 'escalate')!.summary).toContain('turns in a row were not understood');
    expect(rp.adherence).toMatchObject({ score: 100, deviations: [] });
  });

  it('records a re-route as the reason the call left the node\'s own path, and counts it as allowed', async () => {
    const s2 = await run(['great thank you but no', 'this is unacceptable I want to complain'], [500, 500]);
    const rp = buildReplay({ run: runInfo(s2.state), steps: s2.steps, definitions: { collections: def } });
    expect(rp.timeline.find((t) => t.type === 'reroute')!.summary).toContain('intent changed (complaint');
    expect(rp.adherence.deviations).toEqual([]);
  });

  it('catches a call that did not keep to its workflow', async () => {
    const { steps } = await run(['yes thanks'], [1000]);
    const tampered = steps.map((s) => (s.type === 'route' && s.payload.to === 'thanks' ? { ...s, payload: { ...s.payload, to: 'done' } } : s));   // a move the definition does not allow
    const a = checkAdherence(tampered, { collections: def }, 'collections');
    expect(a.score).toBeLessThan(100);
    expect(a.deviations.map((d) => d.reason).join(' ')).toContain('is not a transition of greet');
    expect(a.deviations.map((d) => d.reason).join(' ')).toContain('but the last move was to done');
    const rp = buildReplay({ run: runInfo({ status: 'ended', outcome: 'paid_promise' }), steps: tampered, definitions: { collections: def } });
    expect(rp.timeline.filter((t) => t.adherence === 'deviation').length).toBeGreaterThan(0);
  });

  it('weaves in the call\'s own events and any failover, in time order', async () => {
    const { state, steps } = await run(['yes thanks'], [1000]);
    const mid = steps[2]!.occurred_at as string;
    const rp = buildReplay({
      run: runInfo(state), steps, definitions: { collections: def },
      events: [{ id: 1, type: 'call.answered', payload: {}, occurred_at: steps[0]!.occurred_at as string }, { id: 2, type: 'call.ended', payload: { reason: 'completed' }, occurred_at: steps[steps.length - 1]!.occurred_at as string }],
      failovers: [{ id: 1, scope: 'voice', trigger: 'hard_errors', from_name: 'voice-a', to_name: 'voice-b', detail: {}, at: mid }],
      call: { id: 'c1', status: 'completed', direction: 'inbound', ended_by: 'system', ended_node: 'done', fault: false, fault_reason: null, started_at: steps[0]!.occurred_at as string, ended_at: steps[steps.length - 1]!.occurred_at as string },
    });
    const times = rp.timeline.map((t) => Date.parse(t.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(rp.timeline.some((t) => t.source === 'failover' && t.summary.includes('voice-a to voice-b'))).toBe(true);
    expect(rp.timeline[0]!.type).toBe('start');
    expect(rp.summary).toMatchObject({ endedBy: 'system', endedAtNode: 'done', fault: false });
    expect(rp.summary.durationMs).toBeGreaterThan(0);
  });

  it('shows nothing of a sensitive answer', async () => {
    const sens: WorkflowDefinition = { start: 'a', nodes: { a: { type: 'speak', speech: 'fixed', text: 'Last four digits?', listen: { captureAs: 'ic', sensitive: true }, transitions: [{ to: 'z' }] }, z: { type: 'end', outcome: 'ok' } } };
    const deps: Deps = { load: () => sens, journey: DEFAULT_JOURNEY };
    const s = await start('w', {}, deps);
    const r = await reply(s.state, 'it is 5678', deps);
    const steps: ReplayStep[] = [...s.records, ...r.records].map((x, k) => ({ seq: k + 1, type: x.type, workflow: x.workflow, node: x.node ?? null, payload: x.payload, created_at: x.at! }));
    const rp = buildReplay({ run: runInfo(r.state), steps, definitions: { w: sens } });
    expect(JSON.stringify(rp)).not.toContain('5678');
    expect(rp.transcript.find((t) => t.speaker === 'caller')!.text).toBe('[hidden]');
    expect(rp.sentiment).toEqual([]);
  });
});
