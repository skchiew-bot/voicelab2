import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseKey } from '../src/secrets.js';
import { replyRunSpoken, startRunSpoken } from '../src/store/runs.js';
import { readDay, readHour } from '../src/workflows/callback.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';
import { reply, start, type Deps } from '../src/workflows/engine.js';
import { checkReferences } from '../src/workflows/refs.js';
import { evaluateScenario } from '../src/workflows/simulate.js';
import { validateDefinition } from '../src/workflows/validate.js';

// A workflow that asks when to call back: the day and the time are each matched by phrases, as an author would write it.
const flow: WorkflowDefinition = {
  start: 'ask', variables: [],
  nodes: {
    ask: { type: 'speak', speech: 'fixed', text: 'Is now a good time?', listen: { captureAs: 'a', intents: { yes: ['yes'], later: ['later', 'nanti'] } },
      transitions: [{ when: { var: 'a_intent', op: 'eq', value: 'yes' }, to: 'ok' }, { to: 'which_day' }] },
    which_day: { type: 'speak', speech: 'fixed', text: 'Which day suits you?', listen: { captureAs: 'd', intents: { tuesday: ['tuesday', 'selasa'], friday: ['friday', 'jumaat'] } },
      transitions: [{ to: 'which_time' }] },
    which_time: { type: 'speak', speech: 'fixed', text: 'And what time?', listen: { captureAs: 't' }, transitions: [{ to: 'later' }] },
    ok: { type: 'end', outcome: 'talked', contact: 'contacted' },
    later: { type: 'end', outcome: 'call_back', contact: 'contacted', callback: { day: 'd_intent', hour: 't', timeZone: 'Asia/Kuala_Lumpur' } },
  },
};

describe('reading a callback time by fixed rules', () => {
  it('reads a day of the week in English or Malay, 0 = Sunday, and nothing else', () => {
    const days = ['Sunday', 'ahad', 'Monday', 'isnin', 'tue', 'Selasa', ' hari Rabu ', 'thurs', 'Khamis', 'fri', 'jumaat', 'Saturday', 'sabtu', 3, '6'];
    expect(days.map(readDay)).toEqual([0, 0, 1, 1, 2, 2, 3, 4, 4, 5, 5, 6, 6, 3, 6]);
    for (const v of ['tomorrow', 'esok', 'next week', '7', 7, -1, 2.5, '', null, undefined, true, 'constructor', 'toString', ['tuesday'], { day: 2 }]) {
      expect(readDay(v as never), String(v)).toBeNull();
    }
  });

  it('reads an hour when it can only mean one thing, and drops the minutes', () => {
    const hours: [string | number, number][] = [
      ['3pm', 15], ['3 PM', 15], ['3 p.m.', 15], ['12pm', 12], ['12am', 0], ['9am', 9], ['9:30 am', 9], ['11.45pm', 23],
      ['15', 15], ['15:00', 15], ['09', 9], ['09:30', 9], ['00:15', 0], ['0', 0], ['23', 23],
      ['pukul 3 petang', 15], ['10 pagi', 10], ['jam 8 malam', 20], ['12 malam', 0], ['1 tengah hari', 13], ['12 tengahari', 12], ['7 petang', 19],
      ['noon', 12], ['midnight', 0], ['tengah hari', 12], ['at 4pm', 16],
      [9, 9], [0, 0], [23, 23],
    ];
    expect(hours.map(([v]) => readHour(v))).toEqual(hours.map(([, h]) => h));
  });

  it('does not read an hour that could be morning or evening, or anything that is not an hour', () => {
    for (const v of ['3', '10', '12', '10:30', '3.15', '13pm', '0am', '24', '25:00', '15:60', '8 petang', '5 malam', '4 tengah hari', 'afternoon', 'petang',
      '0123456789', '+60123456789', '3pm please call 0123456789', 'after 3pm', '', 24, -1, 9.5, null, undefined, false, ['3pm']]) {
      expect(readHour(v as never), String(v)).toBeNull();
    }
  });
});

describe('an end that records a callback time', () => {
  it('is checked when the workflow is saved', () => {
    expect(validateDefinition(flow).errors).toEqual([]);
    const withEnd = (later: unknown) => ({ ...flow, nodes: { ...flow.nodes, later } } as unknown as WorkflowDefinition);
    const codes = (later: unknown) => validateDefinition(withEnd(later)).errors.map((e) => [e.code, e.nodeId]);
    expect(codes({ type: 'end', outcome: 'x', callback: { day: 'd_intent', hour: 't', timeZone: 'Asia/Kuala_Lumpur' } })).toEqual([['callback_without_contact', 'later']]);
    expect(codes({ type: 'end', outcome: 'x', contact: 'wrong_number', callback: { day: 'd_intent', hour: 't', timeZone: 'Asia/Kuala_Lumpur' } })).toEqual([['callback_without_contact', 'later']]);
    expect(codes({ type: 'end', outcome: 'x', contact: 'contacted', callback: { day: 'd_intent', hour: 't', timeZone: 'Mars/Olympus' } })).toEqual([['bad_callback', 'later']]);
    expect(codes({ type: 'end', outcome: 'x', contact: 'contacted', callback: { day: 'd_intent', timeZone: 'Asia/Kuala_Lumpur' } })).toEqual([['bad_callback', 'later']]);
    expect(codes({ type: 'end', outcome: 'x', contact: 'contacted', callback: { day: 'constructor', hour: 't', timeZone: 'Asia/Kuala_Lumpur' } })).toEqual([['bad_callback', 'later']]);
    expect(codes({ type: 'end', outcome: 'x', contact: 'contacted', callback: { day: 'never_set', hour: 't', timeZone: 'Asia/Kuala_Lumpur' } })).toEqual([['unknown_variable', 'later']]);
  });

  it('refuses a sensitive variable as a callback time, in this workflow or in the one it hands over to', () => {
    const marked = { ...flow, sensitiveVariables: ['t'] };
    expect(validateDefinition(marked).errors.map((e) => [e.code, e.nodeId])).toEqual([['sensitive_in_record', 'later']]);
    // A parent marks the time sensitive; the workflow it hands the call to records it.
    const parent: WorkflowDefinition = { start: 'p', variables: [], sensitiveVariables: ['when'], nodes: {
      p: { type: 'speak', speech: 'fixed', text: 'When?', listen: { captureAs: 'when' }, transitions: [{ to: 'h' }] },
      h: { type: 'handoff', target: { workflow: 'child' } } } };
    const child: WorkflowDefinition = { start: 'e', variables: ['when'], nodes: {
      e: { type: 'end', outcome: 'later', contact: 'contacted', callback: { day: 'when', hour: 'when', timeZone: 'Asia/Kuala_Lumpur' } } } };
    expect(checkReferences('parent', parent, () => child).map((i) => i.code)).toEqual(['sensitive_across_workflows']);
  });

  const deps: Deps = { load: () => flow };
  async function talk(...replies: string[]) {
    let r = await start('flow', {}, deps); const records = [...r.records];
    for (const text of replies) { r = await reply(r.state, text, deps); records.push(...r.records); }
    return { state: r.state, records, unusedReplies: 0 };
  }
  const endOf = async (...replies: string[]) => (await talk(...replies)).records.find((x) => x.type === 'end')?.payload;

  it('records the day and hour the caller gave, and only those two numbers', async () => {
    expect(await endOf('later', 'selasa', 'pukul 3 petang')).toEqual({ outcome: 'call_back', contact: 'contacted', callback: { day: 2, hour: 15, timeZone: 'Asia/Kuala_Lumpur' } });
    expect(await endOf('yes')).toEqual({ outcome: 'talked', contact: 'contacted' });
  });

  it('records the time as unread, never guessed, when the caller\'s answer cannot be read, and keeps no number they said', async () => {
    expect(await endOf('later', 'friday', 'around 3')).toEqual({ outcome: 'call_back', contact: 'contacted', callback: 'unread' });
    expect(await endOf('later', 'whenever', '3pm')).toEqual({ outcome: 'call_back', contact: 'contacted', callback: 'unread' });
    const r = await talk('later', 'friday', 'call me on 0123456789');
    expect(r.records.find((x) => x.type === 'end')?.payload).toEqual({ outcome: 'call_back', contact: 'contacted', callback: 'unread' });
    expect(JSON.stringify(r.records.filter((x) => x.type === 'end' || x.type === 'reached_end'))).not.toContain('0123456789');
  });

  it('does not read a variable that became sensitive during the call, even from an old version saved before the check', async () => {
    const old = { ...flow, sensitiveVariables: ['t'] } as WorkflowDefinition;   // saved before sensitive callback times were refused
    let r = await start('old', {}, { load: () => old });
    for (const text of ['later', 'tuesday', '3pm']) r = await reply(r.state, text, { load: () => old });
    expect(r.records.find((x) => x.type === 'end')?.payload).toEqual({ outcome: 'call_back', contact: 'contacted', callback: 'unread' });
  });

  it('can be expected by a rehearsal: a time, unread, or none', async () => {
    const ok = evaluateScenario({ name: 'tue', variables: {}, expect: { outcome: 'call_back', callback: { day: 2, hour: 15 } } }, await talk('later', 'tuesday', '3pm'));
    expect(ok.failures).toEqual([]);
    expect(evaluateScenario({ name: 'u', variables: {}, expect: { callback: 'unread' } }, await talk('later', 'tuesday', 'soon')).failures).toEqual([]);
    expect(evaluateScenario({ name: 'n', variables: {}, expect: { callback: 'none' } }, await talk('yes')).failures).toEqual([]);
    const wrong = evaluateScenario({ name: 'w', variables: {}, expect: { callback: { day: 5, hour: 15 } } }, await talk('later', 'tuesday', '3pm'));
    expect(wrong.failures).toEqual(['Expected a callback time of day 5 at 15:00 but it was day 2 at 15:00.']);
    const waiting = await talk('later');
    expect(evaluateScenario({ name: 's', variables: {}, expect: { callback: 'none' } }, waiting).failures)
      .toEqual(['The call was still waiting for the caller after the last scripted reply.', 'Expected a callback time of none but the call had not ended.']);
  });
});

// ------------------------------------------------------------------ live calls, against fakes
type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let projectId: string; let twilioId: string; let numberId: string; let wfId: string;
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
  projectId = (await must(post(`/internal/tenants/${tenantId}/projects`, { name: 'Collections' }))).json().id;
  twilioId = (await must(post('/internal/providers', { adapterKey: 'twilio', name: 'tw-callback', params: { accountSid: 'AC1', authToken: 'tw-callback-token', twimlAppVoiceUrl: 'https://voicelab.test/v' } }))).json().id;
  numberId = (await must(post('/internal/numbers', { providerId: twilioId, e164: '+60300000889', tenantId, projectId, country: 'MY' }))).json().id;
  const c = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'callback_flow', definition: flow }))).json();
  await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'staging' }));
  const sim = (await must(post(`/internal/workflows/${c.workflow.id}/simulate`, { scenarios: [
    { name: 'later', variables: {}, replies: ['later', 'jumaat', '10 pagi'], expect: { outcome: 'call_back', callback: { day: 5, hour: 10 } } },
    { name: 'unclear', variables: {}, replies: ['later', 'jumaat', 'sometime'], expect: { outcome: 'call_back', callback: 'unread' } },
    { name: 'now', variables: {}, replies: ['yes'], expect: { outcome: 'talked', callback: 'none' } },
  ] }))).json();
  expect(sim.results.map((r: { passed: boolean }) => r.passed)).toEqual([true, true, true]);
  await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'production' }));
  wfId = c.workflow.id;
});
afterAll(async () => { await env?.teardown(); });

const runs = () => ({ pool: env.pool, key: parseKey(env.config.VOICELAB_SECRET_KEY) });
async function liveCall() {
  const id = randomUUID();
  await env.pool.query(
    `INSERT INTO calls (id, tenant_id, project_id, provider_id, provider_call_id, direction, status, country, from_number_id, workflow_id, cost_status)
     VALUES ($1,$2,$3,$4,$5,'outbound','in_progress','MY',$6,$7,'pending')`, [id, tenantId, projectId, twilioId, `CA_cb_${id.slice(0, 8)}`, numberId, wfId]);
  return id;
}
async function liveTalk(callId: string, ...replies: string[]) {
  const r = await startRunSpoken(runs(), null, { workflowId: wfId, environment: 'production', kind: 'live', variables: {}, callId });
  let version = r.view.version;
  for (const text of replies) version = (await replyRunSpoken(runs(), r.view.id, text, version))!.view.version;
  return r.view.id;
}
const outcomesOf = async (callId: string) => (await env.pool.query(
  'SELECT outcome, callback_day, callback_hour, callback_tz, recorded_by FROM outbound_outcomes WHERE call_id = $1 ORDER BY id', [callId])).rows;
const auditOf = async (callId: string) => (await env.pool.query(
  `SELECT detail FROM audit_log WHERE action = 'outbound.outcome' AND entity_id = $1 ORDER BY id`, [callId])).rows.map((r) => r.detail);

describe('a live outbound call that ends asking to be called back', () => {
  it('records the callback time with the call\'s outcome, and the analytics count it in the caller\'s zone', async () => {
    const slots = async () => (await must(get(`/internal/analytics/outbound?tenantId=${tenantId}`))).json().bestCallbackTimes;
    expect(await slots()).toEqual([]);
    const callId = await liveCall();
    const runId = await liveTalk(callId, 'nanti', 'Jumaat', 'pukul 10 pagi');
    expect(await outcomesOf(callId)).toEqual([{ outcome: 'contacted', callback_day: 5, callback_hour: 10, callback_tz: 'Asia/Kuala_Lumpur', recorded_by: null }]);
    expect(await auditOf(callId)).toEqual([{ outcome: 'contacted', callback: true, source: 'workflow', run: runId }]);
    expect(await slots()).toEqual([{ day: 5, hour: 10, time_zone: 'Asia/Kuala_Lumpur', requests: 1 }]);
  });

  it('records the outcome with no callback time when the answer could not be read, and says so in the audit', async () => {
    const callId = await liveCall();
    const runId = await liveTalk(callId, 'later', 'tuesday', 'after lunch');
    expect(await outcomesOf(callId)).toEqual([{ outcome: 'contacted', callback_day: null, callback_hour: null, callback_tz: null, recorded_by: null }]);
    expect(await auditOf(callId)).toEqual([{ outcome: 'contacted', callback: 'unread', source: 'workflow', run: runId }]);
    const steps = (await env.pool.query('SELECT payload FROM workflow_run_steps WHERE run_id = $1 AND type = $2', [runId, 'end'])).rows;
    expect(steps).toEqual([{ payload: { outcome: 'call_back', contact: 'contacted', callback: 'unread' } }]);
  });

  it('refuses a rehearsal expecting an impossible callback time', async () => {
    for (const callback of [{ day: 7, hour: 10 }, { day: 1, hour: 24 }, { day: 1, hour: 10, minute: 5 }, 'later']) {
      const r = await post(`/internal/workflows/${wfId}/simulate`, { scenarios: [{ name: 'x', variables: {}, replies: ['yes'], expect: { outcome: 'talked', callback } }] });
      expect(r.statusCode, JSON.stringify(callback)).toBe(400);
    }
  });
});
