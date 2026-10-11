import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, localParts } from '../src/cases/policy.js';
import { parseKey } from '../src/secrets.js';
import { replyRunSpoken, startRunSpoken } from '../src/store/runs.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';
import { checkReferences } from '../src/workflows/refs.js';
import { reply, start, type Deps } from '../src/workflows/engine.js';
import { validateDefinition } from '../src/workflows/validate.js';

// A workflow can record the promise to pay a person makes on a call, on the call's case, never guessed.
const KL = 'Asia/Kuala_Lumpur';
const promise = { amount: { var: 'case_balance' }, due: { var: 'when_intent', map: { monday: 1, friday: 5 }, as: 'weekday' as const } };
const flow: WorkflowDefinition = {
  start: 'when', variables: ['case_balance'],
  nodes: {
    when: { type: 'speak', speech: 'fixed', text: 'Can you pay the balance on Monday, or on Friday?',
      listen: { captureAs: 'when', intents: { monday: ['monday', 'isnin'], friday: ['friday', 'jumaat'] } }, transitions: [{ to: 'done' }] },
    done: { type: 'end', outcome: 'promised', contact: 'contacted', promise },
  },
};
const play = async (vars: Record<string, string>, answer: string, def = flow) => {
  const deps: Deps = { load: () => def };
  const s = await start('flow', vars, deps); const r = await reply(s.state, answer, deps);
  return [...s.records, ...r.records].find((x) => x.type === 'end')?.payload;
};
const errs = (def: unknown) => validateDefinition(def as WorkflowDefinition).errors.map((e) => [e.code, e.nodeId ?? null]);
const withPromise = (p: unknown) => ({ ...flow, nodes: { ...flow.nodes, done: { type: 'end', outcome: 'promised', contact: 'contacted', promise: p } } });

describe('a promise to pay read from the call', () => {
  it('is checked when the workflow is saved', () => {
    expect(errs(flow)).toEqual([]);
    expect(errs(withPromise({ amount: { var: 'case_balance' }, due: { days: 0 } }))).toEqual([]);
    expect(errs(withPromise({ amount: { var: 'case_balance' } }))).toEqual([['bad_promise', 'done']]);
    expect(errs(withPromise({ amount: { var: 'case_balance' }, due: { days: 61 } }))).toEqual([['bad_promise', 'done']]);
    expect(errs(withPromise({ amount: { var: 'case_balance' }, due: { days: 1.5 } }))).toEqual([['bad_promise', 'done']]);
    expect(errs(withPromise({ amount: { var: 'case_balance' }, due: { days: 0, var: 'when_intent', map: { monday: 1 }, as: 'weekday' } }))).toEqual([['bad_promise', 'done']]);
    expect(errs(withPromise({ amount: { var: 'case_balance' }, due: { var: 'when_intent', map: { unknown: 0 }, as: 'weekday' } }))).toEqual([['bad_promise', 'done']]);
    // A map must say what its numbers are: days from today, or a weekday (which a fixed number of days cannot stand for).
    expect(errs(withPromise({ amount: { var: 'case_balance' }, due: { var: 'when_intent', map: { friday: 5 } } }))).toEqual([['bad_promise', 'done']]);
    expect(errs(withPromise({ amount: { var: 'case_balance' }, due: { var: 'when_intent', map: { friday: 7 }, as: 'weekday' } }))).toEqual([['bad_promise', 'done']]);
    // A bad callback on the same end does not stop the promise being checked.
    expect(errs({ ...withPromise({ amount: { var: 'case_balance' } }), nodes: { ...flow.nodes, done: { type: 'end', outcome: 'promised', contact: 'contacted', callback: 'soon', promise: { amount: { var: 'case_balance' } } } } }))
      .toEqual([['bad_callback', 'done'], ['bad_promise', 'done']]);
    expect(errs(withPromise({ amount: { var: 'nowhere' }, due: { days: 0 } }))).toEqual([['unknown_variable', 'done']]);
    // A sensitive value is never recorded with the call, in this workflow or across workflows.
    expect(errs({ ...flow, sensitiveVariables: ['case_balance'] })).toEqual([['sensitive_in_record', 'done']]);
    const parent: WorkflowDefinition = { start: 'go', variables: ['case_balance'], sensitiveVariables: ['case_balance'], nodes: { go: { type: 'handoff', target: { workflow: 'child' } } } };
    const child: WorkflowDefinition = { start: 'x', variables: ['case_balance'], nodes: { x: { type: 'end', outcome: 'promised', promise: { amount: { var: 'case_balance' }, due: { days: 0 } } } } };
    expect(checkReferences('parent', parent, (n) => (n === 'child' ? child : 'absent')).map((i) => i.code)).toEqual(['sensitive_across_workflows']);
  });

  it('records an exact amount, due on the weekday the answer names, or as many days ahead as a relative answer maps to', async () => {
    expect(await play({ case_balance: '500.00' }, 'jumaat')).toEqual({ outcome: 'promised', contact: 'contacted', promise: { amount: '500.00', weekday: 5 } });
    const relative = withPromise({ amount: { var: 'case_balance' }, due: { var: 'when_intent', map: { monday: 0, friday: 1 }, as: 'days' } }) as WorkflowDefinition;
    expect(await play({ case_balance: '120' }, 'friday please', relative)).toEqual({ outcome: 'promised', contact: 'contacted', promise: { amount: '120', days: 1 } });
  });

  it('records no promise, never a guess, when the amount is not exact or the day was not understood', async () => {
    for (const amount of ['about 200', '1,500.00', '200 ringgit', '']) expect((await play({ case_balance: amount }, 'friday'))?.promise, amount).toBeUndefined();
    expect((await play({ case_balance: '500.00' }, 'next month maybe'))?.promise).toBeUndefined();
    // A map whose inherited entry would give a day is not read: only the map's own entries count.
    const inherited = withPromise({ amount: { var: 'case_balance' }, due: { var: 'when_intent', map: Object.create({ friday: 5 }), as: 'weekday' } }) as WorkflowDefinition;
    expect((await play({ case_balance: '500.00' }, 'friday', inherited))?.promise).toBeUndefined();
    // A version saved before promises were checked cannot reach past the furthest a promise may fall due.
    const far = withPromise({ amount: { var: 'case_balance' }, due: { days: 61 } }) as WorkflowDefinition;
    expect((await play({ case_balance: '500.00' }, 'friday', far))?.promise).toBeUndefined();
  });
});

// ------------------------------------------------------------------ live calls on a case, against fakes
type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let twilioId: string; let numberId: string; let wfId: string;
const post = (u: string, b?: unknown) => env.call(env.staffToken, 'POST', u, b);
const get = (u: string) => env.call(env.staffToken, 'GET', u);
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}
let seq = 0;
beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  tenantId = (await must(post('/internal/tenants', { name: 'Promise Co' }))).json().id;
  twilioId = (await must(post('/internal/providers', { adapterKey: 'twilio', name: 'tw-pr', params: { accountSid: 'AC1', authToken: 't', twimlAppVoiceUrl: 'https://x.example/v' } }))).json().id;
  numberId = (await must(post('/internal/numbers', { providerId: twilioId, e164: '+60300000555', tenantId, country: 'MY' }))).json().id;
  const c = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'promise_flow', definition: flow }))).json();
  await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'staging' }));
  const sim = (await must(post(`/internal/workflows/${c.workflow.id}/simulate`, { scenarios: [
    { name: 'friday', variables: { case_balance: '500.00' }, replies: ['friday'], expect: { outcome: 'promised' } },
  ] }))).json();
  expect(sim.results.map((r: { passed: boolean }) => r.passed)).toEqual([true]);
  await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'production' }));
  wfId = c.workflow.id;
});
afterAll(async () => { await env?.teardown(); });

const runs = () => ({ pool: env.pool, key: parseKey(env.config.VOICELAB_SECRET_KEY) });
async function caseWith(balance: string, timeZone = KL) {
  const ref = `PR-${++seq}`;
  return (await must(post(`/internal/tenants/${tenantId}/cases`, { caseRef: ref, contactRef: `client-${ref}`, phone: `+6012345${String(7000 + seq)}`, country: 'MY', currency: 'MYR', openingBalance: balance, timeZone }))).json().id as string;
}
async function liveCall(caseId: string | null) {
  const id = randomUUID();
  await env.pool.query(
    `INSERT INTO calls (id, tenant_id, provider_id, provider_call_id, direction, status, country, from_number_id, workflow_id, case_id, cost_status)
     VALUES ($1,$2,$3,$4,'outbound','in_progress','MY',$5,$6,$7,'pending')`, [id, tenantId, twilioId, `CA_pr_${id.slice(0, 8)}`, numberId, wfId, caseId]);
  return id;
}
async function talk(callId: string, answer: string, o: { environment?: string; kind?: string } = {}) {
  const r = await startRunSpoken(runs(), null, { workflowId: wfId, environment: (o.environment ?? 'production') as never, kind: (o.kind ?? 'live') as never, variables: {}, callId });
  const done = await replyRunSpoken(runs(), r.view.id, answer, r.view.version);
  return done.view;
}
const promisesOf = async (caseId: string) => (await env.pool.query(`SELECT amount::text, due_on::text, status, created_by FROM promises WHERE case_id = $1 ORDER BY created_at`, [caseId])).rows;
const caseEvents = async (caseId: string) => ((await must(get(`/internal/cases/${caseId}`))).json().events as { kind: string; detail: Record<string, unknown> }[]);
/** The next such weekday (today included) in a zone, read before and after the call, so a run across midnight still agrees. */
const nextWeekday = (dow: number, tz = KL) => { const l = localParts(new Date(), tz); return addDays(l.date, (dow - l.dow + 7) % 7); };

describe('a live call on a case whose workflow ends with a promise', () => {
  it('records the promise on the case, for the case\'s balance, due on the day the person chose in the case\'s time zone', async () => {
    const cs = await caseWith('500');
    const before = nextWeekday(5);
    const view = await talk(await liveCall(cs), 'friday');
    expect(view).toMatchObject({ status: 'ended', outcome: 'promised' });
    const [p] = await promisesOf(cs);
    expect(p).toMatchObject({ amount: '500.00000000', status: 'open', created_by: null });
    expect([before, nextWeekday(5)]).toContain(p.due_on);                                       // the coming Friday, whatever today is
    expect((await caseEvents(cs)).map((e) => e.kind)).toContain('promise.recorded');
  });

  it('counts the days from today in the case\'s own time zone, whatever the hour of the run', async () => {
    // At any moment one of these two zones is on a different date from UTC, so a count from the server's day shows.
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      const cs = await caseWith('500', tz);
      const before = nextWeekday(5, tz);
      await talk(await liveCall(cs), 'friday');
      expect([before, nextWeekday(5, tz)], tz).toContain((await promisesOf(cs))[0].due_on);
    }
  });

  it('records a promise the case refuses as refused, with the reason, and the call still ends as it should', async () => {
    const cs = await caseWith('500');
    await talk(await liveCall(cs), 'monday');                                                     // the first promise is open
    const second = await talk(await liveCall(cs), 'friday');
    expect(second).toMatchObject({ status: 'ended', outcome: 'promised' });
    expect(await promisesOf(cs)).toHaveLength(1);
    const refused = (await caseEvents(cs)).filter((e) => e.kind === 'promise.not_recorded');
    expect(refused.map((e) => e.detail)).toEqual([expect.objectContaining({ source: 'workflow', reason: 'There is already an open promise on this case. Let it settle first.' })]);
  });

  it('refuses, with a clear reason, a promise of nothing or of more than the balance, and the call still ends as it should', async () => {
    const { recordPromiseFromCall } = await import('../src/store/cases.js');
    for (const [amount, reason] of [['0', 'A promise is for an amount above nothing.'], ['900.00', 'A promise cannot be for more than the balance.']] as [string, string][]) {
      const cs = await caseWith('500');
      const callId = await liveCall(cs);
      const client = await env.pool.connect();
      try {
        await client.query('BEGIN');
        expect(await recordPromiseFromCall(client, { callId, runId: randomUUID(), amount, days: 0 })).toBeNull();
        await client.query('COMMIT');
      } finally { client.release(); }
      expect(await promisesOf(cs)).toEqual([]);
      expect((await caseEvents(cs)).filter((e) => e.kind === 'promise.not_recorded').map((e) => e.detail.reason)).toEqual([reason]);
    }
  });

  it('works the due date out from the moment the call ends, in the case\'s own time zone: the next such weekday, today included, or a number of days on, across a month\'s end', async () => {
    const { recordPromiseFromCall } = await import('../src/store/cases.js');
    const due = async (tz: string, at: string, when: { days: number } | { weekday: number }) => {
      const cs = await caseWith('500', tz);
      const client = await env.pool.connect();
      try {
        await client.query('BEGIN');
        expect(await recordPromiseFromCall(client, { callId: await liveCall(cs), runId: randomUUID(), amount: '100', ...when }, new Date(at))).not.toBeNull();
        await client.query('COMMIT');
      } finally { client.release(); }
      return (await promisesOf(cs))[0].due_on;
    };
    // 2026-10-09T23:30Z is Friday 9 October in UTC and in Pago Pago, but already Saturday 10 October in Kiritimati.
    const at = '2026-10-09T23:30:00Z';
    expect(await due('Pacific/Kiritimati', at, { weekday: 5 })).toBe('2026-10-16');             // Saturday there: the Friday after
    expect(await due('Pacific/Pago_Pago', at, { weekday: 5 })).toBe('2026-10-09');              // Friday there: today
    expect(await due('Pacific/Kiritimati', at, { weekday: 1 })).toBe('2026-10-12');
    expect(await due('Pacific/Pago_Pago', at, { weekday: 1 })).toBe('2026-10-12');
    expect(await due('Pacific/Kiritimati', at, { days: 2 })).toBe('2026-10-12');
    expect(await due('Pacific/Pago_Pago', at, { days: 2 })).toBe('2026-10-11');
    expect(await due(KL, '2026-10-31T12:00:00Z', { days: 3 })).toBe('2026-11-03');               // 20:00 on the 31st in Kuala Lumpur
    expect(await due('Pacific/Kiritimati', '2026-10-31T12:00:00Z', { days: 3 })).toBe('2026-11-04');
  });

  it('keeps the call\'s step going when the database itself refuses the promise: the refusal is rolled back to its savepoint and recorded', async () => {
    const { recordPromiseFromCall } = await import('../src/store/cases.js');
    // A trigger made only for this test refuses one amount, so a real SQL error happens inside the savepoint.
    await env.pool.query(`CREATE FUNCTION test_refuse_promise() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$`);
    await env.pool.query(`CREATE TRIGGER test_refuse_promise BEFORE INSERT ON promises FOR EACH ROW WHEN (NEW.amount = 123.45) EXECUTE FUNCTION test_refuse_promise()`);
    try {
      const cs = await caseWith('500');
      const callId = await liveCall(cs);
      const client = await env.pool.connect();
      try {
        await client.query('BEGIN');
        expect(await recordPromiseFromCall(client, { callId, runId: randomUUID(), amount: '123.45', days: 0 })).toBeNull();
        await client.query(`UPDATE calls SET status = 'completed' WHERE id = $1`, [callId]);    // the step carries on in the same transaction
        await client.query('COMMIT');
      } finally { client.release(); }
      expect((await env.pool.query('SELECT status FROM calls WHERE id = $1', [callId])).rows[0].status).toBe('completed');
      expect(await promisesOf(cs)).toEqual([]);
      expect((await caseEvents(cs)).filter((e) => e.kind === 'promise.not_recorded').map((e) => e.detail.reason)).toEqual(['The promise could not be recorded.']);
    } finally {
      await env.pool.query('DROP TRIGGER test_refuse_promise ON promises; DROP FUNCTION test_refuse_promise()');
    }
  });

  it('records a promise on a call whose workflow reaches its end without a reply', async () => {
    const direct: WorkflowDefinition = { start: 'done', variables: ['case_balance'], nodes: { done: { type: 'end', outcome: 'promised', promise: { amount: { var: 'case_balance' }, due: { days: 2 } } } } };
    const c = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'direct_promise', definition: direct }))).json();
    await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'staging' }));
    await must(post(`/internal/workflows/${c.workflow.id}/simulate`, { scenarios: [{ name: 'x', variables: { case_balance: '10' }, expect: { outcome: 'promised' } }] }));
    await must(post(`/internal/workflows/${c.workflow.id}/deploy`, { versionId: c.version.id, environment: 'production' }));
    const cs = await caseWith('500');
    const callId = await liveCall(cs);
    const before = addDays(localParts(new Date(), KL).date, 2);
    await startRunSpoken(runs(), null, { workflowId: c.workflow.id, environment: 'production', kind: 'live', variables: {}, callId });
    expect([before, addDays(localParts(new Date(), KL).date, 2)]).toContain((await promisesOf(cs))[0]?.due_on);
  });

  it('records nothing for a call without a case, or a staging test on a case', async () => {
    const before = (await env.pool.query('SELECT count(*)::int AS n FROM promises')).rows[0].n;
    await talk(await liveCall(null), 'friday');
    const cs = await caseWith('500');
    await talk(await liveCall(cs), 'friday', { environment: 'staging', kind: 'test' });
    expect((await env.pool.query('SELECT count(*)::int AS n FROM promises')).rows[0].n).toBe(before);
  });
});
