import type { Json } from './definition.js';
import type { RunState, StepRecord } from './engine.js';

export interface Scenario {
  name: string;
  /** What this caller's record says: the variables the workflow starts with. */
  variables: Record<string, Json>;
  /** What this caller says, in order, each time the workflow waits for them. */
  replies?: string[];
  /** Canned answers for the integrations the workflow calls: simulations never touch a real system. */
  integrations?: Record<string, Json>;
  /**
   * `contact`: the call outcome the end it finishes at records (`none` for an end that records none). `callback`: the
   * callback time it records (day 0 = Sunday, hour 0 to 23), `unread` when it asks for one the rules cannot read, or `none`.
   */
  expect?: { outcome?: string; says?: string[]; doesNotSay?: string[]; handoff?: string; contact?: string; callback?: { day: number; hour: number; timeZone?: string } | 'none' | 'unread' };
}

export interface ScenarioResult { name: string; passed: boolean; outcome: string | null; failures: string[]; runId?: string }

/**
 * A batch counts towards production only if each scenario says what it expects (an outcome) and none of them
 * expects the call to fail: passing a scenario that asserts nothing proves nothing.
 */
export function gateProblems(scenarios: Scenario[]): string[] {
  const out: string[] = [];
  for (const s of scenarios) {
    if (s.expect?.outcome === undefined) out.push(`"${s.name}" does not say what outcome it expects.`);
    else if (s.expect.outcome === 'error') out.push(`"${s.name}" expects the call to fail, so it cannot count towards production.`);
  }
  return out;
}

export const MAX_SCENARIOS = 500;
export const MAX_REPLIES = 50;

/** Judge one scripted call. A scenario passes only if the call finished, used its script, and did what was expected. */
export function evaluateScenario(s: Scenario, result: { state: RunState; records: StepRecord[]; unusedReplies: number }): ScenarioResult {
  const failures: string[] = [];
  const { state, records } = result;
  const said = records.filter((r) => r.type === 'say').map((r) => String(r.payload.text));
  const expectedOutcome = s.expect?.outcome;

  if (state.status === 'awaiting_reply') failures.push('The call was still waiting for the caller after the last scripted reply.');
  if (result.unusedReplies > 0) failures.push(`The call ended with ${result.unusedReplies} scripted ${result.unusedReplies === 1 ? 'reply' : 'replies'} unused.`);
  if (state.outcome === 'error' && expectedOutcome !== 'error') failures.push(`The call failed: ${state.error ?? 'unknown error'}`);
  if (expectedOutcome !== undefined && state.outcome !== expectedOutcome) failures.push(`Expected the outcome "${expectedOutcome}" but got "${state.outcome ?? 'none'}".`);
  for (const phrase of s.expect?.says ?? []) if (!said.some((t) => t.includes(phrase))) failures.push(`Expected the call to say "${phrase}", and it did not.`);
  for (const phrase of s.expect?.doesNotSay ?? []) if (said.some((t) => t.includes(phrase))) failures.push(`The call said "${phrase}", which it should not have.`);
  if (s.expect?.handoff !== undefined && !records.some((r) => r.type === 'handoff' && r.payload.to === s.expect!.handoff)) {
    failures.push(`Expected a handoff to "${s.expect.handoff}", and there was none.`);
  }
  const end = records.find((r) => r.type === 'end');
  const contact = end?.payload.contact ?? 'none';
  if (s.expect?.contact !== undefined && (!end || contact !== s.expect.contact)) {
    failures.push(end ? `Expected the call to end as "${s.expect.contact}" but it ended as "${String(contact)}".` : `Expected the call to end as "${s.expect.contact}" but it had not ended.`);
  }
  if (s.expect?.callback !== undefined) {
    const got = end?.payload.callback;
    const zoned = typeof s.expect.callback === 'object' && s.expect.callback.timeZone !== undefined; // the zone is checked only when asked for
    const said = got === undefined ? 'none' : got === 'unread' ? 'unread' : typeof got === 'object' && got !== null && !Array.isArray(got)
      ? `day ${String(got.day)} at ${String(got.hour)}:00${zoned ? ` ${String(got.timeZone)}` : ''}` : 'none';
    const want = typeof s.expect.callback === 'string' ? s.expect.callback : `day ${s.expect.callback.day} at ${s.expect.callback.hour}:00${zoned ? ` ${s.expect.callback.timeZone}` : ''}`;
    if (!end) failures.push(`Expected a callback time of ${want} but the call had not ended.`);
    else if (said !== want) failures.push(`Expected a callback time of ${want} but it was ${said}.`);
  }
  return { name: s.name, passed: failures.length === 0, outcome: state.outcome ?? null, failures };
}
