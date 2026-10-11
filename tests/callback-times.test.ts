import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKey } from '../src/secrets.js';
import { replyRunSpoken, startRunSpoken } from '../src/store/runs.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';
import { reply, start, type Deps } from '../src/workflows/engine.js';
import { evaluateScenario } from '../src/workflows/simulate.js';
import { validateDefinition } from '../src/workflows/validate.js';
import { checkReferences } from '../src/workflows/refs.js';

// A workflow can record the callback time a person asks for, read from what the call captured, never guessed.
const callback = {
  day: { var: 'day_intent', map: { mon: 1, tue: 2, sat: 6 } },
  hour: { var: 'time_intent', map: { morning: 10, afternoon: 15 } },
  timeZone: 'Asia/Kuala_Lumpur',
};
const flow: WorkflowDefinition = {
  start: 'day', variables: [],
  nodes: {
    day: { type: 'speak', speech: 'fixed', text: 'Which day suits you for a call back?',
      listen: { captureAs: 'day', intents: { mon: ['monday', 'isnin'], tue: ['tuesday', 'selasa'], sat: ['saturday', 'sabtu'] } }, transitions: [{ to: 'time' }] },
    time: { type: 'speak', speech: 'fixed', text: 'Morning or afternoon?',
      listen: { captureAs: 'time', intents: { morning: ['morning', 'pagi'], afternoon: ['afternoon', 'petang'] } }, transitions: [{ to: 'later' }] },
    later: { type: 'end', outcome: 'call_back', contact: 'contacted', callback },
  },
};
const deps: Deps = { load: () => flow };
async function play(...answers: string[]) {
  let s = await start('flow', {}, deps); const records = [...s.records];
  for (const a of answers) { s = await reply(s.state, a, deps); records.push(...s.records); }
  return { state: s.state, records, unusedReplies: 0 };
}
const endOf = (r: { records: { type: string; payload: Record<string, unknown> }[] }) => r.records.find((x) => x.type === 'end')?.payload;
const errs = (def: unknown) => validateDefinition(def as WorkflowDefinition).errors.map((e) => [e.code, e.nodeId ?? null]);
const withEnd = (end: object) => ({ ...flow, nodes: { ...flow.nodes, later: { type: 'end', outcome: 'call_back', ...end } } });

describe('a callback time read from the call', () => {
  it('is checked when the workflow is saved', () => {
    expect(errs(flow)).toEqual([]);
    expect(errs(withEnd({ callback }))).toEqual([['bad_callback', 'later']]);                                   // no call outcome on the end
    expect(errs(withEnd({ contact: 'wrong_number', callback }))).toEqual([['bad_callback', 'later']]);           // a wrong number has no callback
    expect(errs(withEnd({ contact: 'contacted', callback: { ...callback, timeZone: 'Mars/Olympus' } }))).toEqual([['bad_callback', 'later']]);
    expect(errs(withEnd({ contact: 'contacted', callback: { ...callback, hour: { var: 'time_intent', map: { late: 24 } } } }))).toEqual([['bad_callback', 'later']]);
    expect(errs(withEnd({ contact: 'contacted', callback: { ...callback, day: { var: 'day_intent', map: { mon: 1.5 } } } }))).toEqual([['bad_callback', 'later']]);
    expect(errs(withEnd({ contact: 'contacted', callback: { ...callback, day: { var: 'nowhere', map: { mon: 1 } } } }))).toEqual([['unknown_variable', 'later']]);
    // A sensitive answer, or its intent, is forgotten after routing and is never recorded.
    const secret = { ...flow, nodes: { ...flow.nodes, time: { ...flow.nodes.time, listen: { ...(flow.nodes.time as { listen: object }).listen, sensitive: true } } } };
    expect(errs(secret)).toEqual([['sensitive_in_record', 'later']]);
    // An answer nobody understood is not a time, and an empty map or key says nothing.
    expect(errs(withEnd({ contact: 'contacted', callback: { ...callback, hour: { var: 'time_intent', map: { morning: 10, unknown: 12 } } } }))).toEqual([['bad_callback', 'later']]);
    expect(errs(withEnd({ contact: 'contacted', callback: { ...callback, day: { var: 'day_intent', map: { ambiguous: 1 } } } }))).toEqual([['bad_callback', 'later']]);
    expect(errs(withEnd({ contact: 'contacted', callback: { ...callback, day: { var: 'day_intent', map: {} } } }))).toEqual([['bad_callback', 'later']]);
    expect(errs(withEnd({ contact: 'contacted', callback: { ...callback, day: { var: 'day_intent', map: { '': 1 } } } }))).toEqual([['bad_callback', 'later']]);
    // A key the answer's intents can never produce is flagged, not silently never matched.
    const typo = validateDefinition(withEnd({ contact: 'contacted', callback: { ...callback, day: { var: 'day_intent', map: { tues: 2, mon: 1 } } } }) as WorkflowDefinition);
    expect(typo.errors).toEqual([]);
    expect(typo.warnings.map((w) => [w.code, w.nodeId])).toEqual([['callback_never_matches', 'later']]);
  });

  it('is never read from a value another workflow of the call marks sensitive, at publish time or when the call runs', async () => {
    const parent: WorkflowDefinition = { start: 'go', variables: ['dob', 'h'], sensitiveVariables: ['dob'], nodes: { go: { type: 'handoff', target: { workflow: 'child' } } } };
    const child: WorkflowDefinition = { start: 'x', variables: ['dob', 'h'], nodes: { x: { type: 'end', outcome: 'asked', contact: 'contacted',
      callback: { day: { var: 'dob', map: { mon: 1 } }, hour: { var: 'h', map: { am: 9 } }, timeZone: 'UTC' } } } };
    expect(validateDefinition(child).errors).toEqual([]);                         // alone, the child cannot know dob is sensitive
    const issues = checkReferences('parent', parent, (n) => (n === 'child' ? child : 'absent'));
    expect(issues.map((i) => i.code)).toEqual(['sensitive_across_workflows']);
    // An answer marked sensitive in one workflow is caught through its intent in another, too.
    const viaIntent: WorkflowDefinition = { ...child, variables: ['dob_intent', 'h'], nodes: { x: { ...child.nodes.x, callback: { day: { var: 'dob_intent', map: { mon: 1 } }, hour: { var: 'h', map: { am: 9 } }, timeZone: 'UTC' } } as never } };
    const carries = { ...parent, variables: ['dob', 'dob_intent', 'h'] };
    expect(checkReferences('parent', carries, (n) => (n === 'child' ? viaIntent : 'absent')).map((i) => i.code)).toEqual(['sensitive_across_workflows']);
    // And should it run anyway, the call records no time from it.
    const r = await start('parent', { dob: 'mon', h: 'am' }, { load: (n) => ({ parent, child } as Record<string, WorkflowDefinition>)[n] });
    expect(endOf(r)).toEqual({ outcome: 'asked', contact: 'contacted' });
  });

  it('looks a value up in the map as the map\'s own entry only, and stores a time zone in its one standard spelling', async () => {
    const inherited = Object.create({ mon: 1 }) as Record<string, number>;
    const def = { start: 'x', variables: ['d', 'h'], nodes: { x: { type: 'end', outcome: 'asked', contact: 'contacted',
      callback: { day: { var: 'd', map: inherited }, hour: { var: 'h', map: { am: 9 } }, timeZone: 'UTC' } } } } as WorkflowDefinition;
    expect(endOf(await start('x', { d: 'mon', h: 'am' }, { load: () => def }))).toEqual({ outcome: 'asked', contact: 'contacted' });
    const lower = { ...def, nodes: { x: { type: 'end', outcome: 'asked', contact: 'contacted', callback: { day: { var: 'd', map: { mon: 1 } }, hour: { var: 'h', map: { am: 9 } }, timeZone: 'asia/kuala_lumpur' } } } } as WorkflowDefinition;
    expect(endOf(await start('x', { d: 'mon', h: 'am' }, { load: () => lower }))).toMatchObject({ callback: { day: 1, hour: 9, timeZone: 'Asia/Kuala_Lumpur' } });
  });

  it('records the day and hour the person asked for, mapped from what they said, in their time zone', async () => {
    expect(endOf(await play('tuesday', 'petang'))).toEqual({ outcome: 'call_back', contact: 'contacted', callback: { day: 2, hour: 15, timeZone: 'Asia/Kuala_Lumpur' } });
    expect(endOf(await play('sabtu', 'morning'))).toEqual({ outcome: 'call_back', contact: 'contacted', callback: { day: 6, hour: 10, timeZone: 'Asia/Kuala_Lumpur' } });
  });

  it('records no time, but still the outcome, when either part was not understood', async () => {
    expect(endOf(await play('next week sometime', 'morning'))).toEqual({ outcome: 'call_back', contact: 'contacted' });
    expect(endOf(await play('monday', 'whenever'))).toEqual({ outcome: 'call_back', contact: 'contacted' });
  });

  it('counts only at the end the call finishes at, and a value named like an inherited property is never a key', async () => {
    const child: WorkflowDefinition = { start: 'x', variables: [], nodes: { x: { type: 'end', outcome: 'asked', contact: 'contacted', callback: { day: { var: 'd', map: { mon: 1 } }, hour: { var: 'h', map: { am: 9 } }, timeZone: 'UTC' } } } };
    const parent: WorkflowDefinition = { start: 's', variables: ['d', 'h'], nodes: { s: { type: 'subflow', workflow: 'child', transitions: [{ to: 'done' }] }, done: { type: 'end', outcome: 'finished' } } };
    const two: Deps = { load: (n) => ({ parent, child } as Record<string, WorkflowDefinition>)[n] };
    expect(endOf(await start('parent', { d: 'mon', h: 'am' }, two))).toEqual({ outcome: 'finished' });
    expect(endOf(await start('child', { d: 'mon', h: 'am' }, two))).toEqual({ outcome: 'asked', contact: 'contacted', callback: { day: 1, hour: 9, timeZone: 'UTC' } });
    expect(endOf(await start('child', { d: 'constructor', h: 'am' }, two))).toEqual({ outcome: 'asked', contact: 'contacted' });
  });

  it('can be expected by a rehearsal, as a time or as none', async () => {
    const ok = await play('monday', 'morning');
    expect(evaluateScenario({ name: 'a', variables: {}, expect: { callback: { day: 1, hour: 10 } } }, ok).passed).toBe(true);
    expect(evaluateScenario({ name: 'b', variables: {}, expect: { callback: { day: 1, hour: 15 } } }, ok).failures).toEqual(['Expected a callback time of day 1 at 15:00 but got day 1 at 10:00.']);
    expect(evaluateScenario({ name: 'c', variables: {}, expect: { callback: 'none' } }, await play('monday', 'whenever')).passed).toBe(true);
  });
});

// ------------------------------------------------------------------ live outbound calls, against fakes
type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let twilioId: string; let numberId: string; let wfId: string;
const post = (u: string, b?: unknown) => env.call(env.staffToken, 'POST', u, b);
const get = (u: string) => env.call(env.staffToken, 'GET', u);
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}
beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  tenantId = (await must(post('/internal/tenants', { name: 'Callback Co' }))).json().id;
  twilioId = (await must(post('/internal/providers', { adapterKey: 'twilio', name: 'tw-cb', params: { accountSid: 'AC1', authToken: 't', twimlAppVoiceUrl: 'https://x.example/v' } }))).json().id;
  numberId = (await must(post('/internal/numbers', { providerId: twilioId, e164: '+60300000999', tenantId, country: 'MY' }))).json().id;
  const c = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'callback_flow', definition: flow }))).json();
  await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'staging' }));
  const sim = (await must(post(`/internal/workflows/${c.workflow.id}/simulate`, { scenarios: [
    { name: 'tuesday afternoon', variables: {}, replies: ['tuesday', 'afternoon'], expect: { outcome: 'call_back', contact: 'contacted', callback: { day: 2, hour: 15 } } },
    { name: 'not understood', variables: {}, replies: ['soon', 'morning'], expect: { outcome: 'call_back', callback: 'none' } },
  ] }))).json();
  expect(sim.results.map((r: { passed: boolean }) => r.passed)).toEqual([true, true]);
  await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'production' }));
  wfId = c.workflow.id;
});
afterAll(async () => { await env?.teardown(); });

const runs = () => ({ pool: env.pool, key: parseKey(env.config.VOICELAB_SECRET_KEY) });
async function liveCall() {
  const id = randomUUID();
  await env.pool.query(
    `INSERT INTO calls (id, tenant_id, provider_id, provider_call_id, direction, status, country, from_number_id, workflow_id, cost_status)
     VALUES ($1,$2,$3,$4,'outbound','in_progress','MY',$5,$6,'pending')`, [id, tenantId, twilioId, `CA_cb_${id.slice(0, 8)}`, numberId, wfId]);
  return id;
}
async function talk(callId: string, ...answers: string[]) {
  let r = await startRunSpoken(runs(), null, { workflowId: wfId, environment: 'production', kind: 'live', variables: {}, callId });
  for (const a of answers) r = await replyRunSpoken(runs(), r.view.id, a, r.view.version);
}
const outcomeOf = async (callId: string) => (await env.pool.query(`SELECT outcome, callback_day, callback_hour, callback_tz FROM outbound_outcomes WHERE call_id = $1`, [callId])).rows;

describe('a live outbound call that ends with a callback time', () => {
  it('records it with the outcome, and counts it among the best callback times once the call has completed', async () => {
    const call = await liveCall();
    await talk(call, 'selasa', 'afternoon');
    expect(await outcomeOf(call)).toEqual([{ outcome: 'contacted', callback_day: 2, callback_hour: 15, callback_tz: 'Asia/Kuala_Lumpur' }]);
    const a = (await env.pool.query(`SELECT detail FROM audit_log WHERE action = 'outbound.outcome' AND entity_id = $1`, [call])).rows[0].detail;
    expect(a).toMatchObject({ outcome: 'contacted', callback: true, source: 'workflow' });
    const best = async () => (await must(get(`/internal/analytics/outbound?tenantId=${tenantId}`))).json().bestCallbackTimes;
    expect(await best()).toEqual([]);                                                  // still on the line: not counted yet
    await env.pool.query(`UPDATE calls SET status = 'completed', ended_at = now() WHERE id = $1`, [call]);
    expect(await best()).toEqual([{ day: 2, hour: 15, time_zone: 'Asia/Kuala_Lumpur', requests: 1 }]);
  });

  it('records the outcome with no time when the time was not understood', async () => {
    const call = await liveCall();
    await talk(call, 'one day', 'morning');
    expect(await outcomeOf(call)).toEqual([{ outcome: 'contacted', callback_day: null, callback_hour: null, callback_tz: null }]);
  });

  it('stores a time zone given through the API in its one standard spelling too', async () => {
    const call = await liveCall();
    await env.pool.query(`UPDATE calls SET status = 'completed', ended_at = now() WHERE id = $1`, [call]);
    await must(post(`/internal/calls/${call}/outcome`, { outcome: 'contacted', callback: { day: 3, hour: 11, timeZone: 'asia/kuala_lumpur' } }));
    expect(await outcomeOf(call)).toEqual([{ outcome: 'contacted', callback_day: 3, callback_hour: 11, callback_tz: 'Asia/Kuala_Lumpur' }]);
  });

  it('refuses a rehearsal expecting an impossible time', async () => {
    const r = await post(`/internal/workflows/${wfId}/simulate`, { scenarios: [{ name: 'x', variables: {}, replies: ['monday', 'morning'], expect: { outcome: 'call_back', callback: { day: 1, hour: 24 } } }] });
    expect(r.statusCode).toBe(400);
  });
});
