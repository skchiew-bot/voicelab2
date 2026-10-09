import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let n = 0;
const st = () => env.staffToken;

async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}
const get = (url: string) => env.call(st(), 'GET', url);
const post = (url: string, body?: unknown) => env.call(st(), 'POST', url, body);

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  tenantId = (await must(post('/internal/tenants', { name: 'Flow Co' }))).json().id;
});
afterAll(async () => { await env?.teardown(); });

/** A tiny two-step workflow. `greeting` is wording (a minor edit); `extra` adds a node (a major one). */
const tiny = (greeting = 'Hello {{name}}.', extra = false): WorkflowDefinition => ({
  start: 'hi', variables: ['name'],
  nodes: {
    hi: { type: 'speak', speech: 'hybrid', text: greeting, transitions: extra ? [{ to: 'more' }] : [{ to: 'done' }] },
    ...(extra ? { more: { type: 'speak', speech: 'fixed', text: 'One more thing.', transitions: [{ to: 'done' }] } } : {}),
    done: { type: 'end', outcome: 'finished' },
  },
});
const create = async (name: string, def: unknown = tiny()) => (await must(post(`/internal/tenants/${tenantId}/workflows`, { name, definition: def }))).json() as
  { workflow: { id: string; name: string }; version: { id: string; version: string; valid: boolean } };
const save = (wfId: string, def: unknown) => post(`/internal/workflows/${wfId}/versions`, { definition: def });
const deploy = (wfId: string, versionId: string, environment: string) => post(`/internal/workflows/${wfId}/deploy`, { versionId, environment });
const pass = (name: string) => ({ name, variables: { name: 'Aisha' }, expect: { outcome: 'finished' } });
const simulate = (wfId: string, versionId: string | undefined, scenarios: unknown[]) => post(`/internal/workflows/${wfId}/simulate`, { versionId, scenarios });

describe('versions: an edit inside a node is minor, a change of shape is major', () => {
  it('numbers 1.0, 1.1, 2.0, refuses a save that changes nothing, and lists newest first', async () => {
    const { workflow, version } = await create('versions');
    expect(version.version).toBe('1.0');
    const minor = await save(workflow.id, tiny('Hi there, {{name}}.'));
    expect(minor.statusCode).toBe(201);
    expect(minor.json()).toMatchObject({ version: '1.1', change: 'minor' });
    const major = await save(workflow.id, tiny('Hi there, {{name}}.', true));
    expect(major.json()).toMatchObject({ version: '2.0', change: 'major' });
    const again = await save(workflow.id, tiny('Hi there, {{name}}.', true));
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toContain('same as version 2.0');
    expect((await get(`/internal/workflows/${workflow.id}/versions`)).json().map((v: { version: string }) => v.version)).toEqual(['2.0', '1.1', '1.0']);
  });

  it('never changes a saved version', async () => {
    const { workflow } = await create('immutable');
    await expect(env.pool.query('UPDATE workflow_versions SET definition = $1 WHERE workflow_id = $2', ['{}', workflow.id])).rejects.toThrow(/append-only/);
    await expect(env.pool.query('DELETE FROM workflow_versions WHERE workflow_id = $1', [workflow.id])).rejects.toThrow(/append-only/);
  });

  it('numbers two saves made at once differently', async () => {
    const { workflow } = await create('race');
    const rs = await Promise.all([save(workflow.id, tiny('A {{name}}')), save(workflow.id, tiny('B {{name}}')), save(workflow.id, tiny('C {{name}}'))]);
    expect(rs.map((r) => r.statusCode)).toEqual([201, 201, 201]);
    expect(rs.map((r) => r.json().version).sort()).toEqual(['1.1', '1.2', '1.3']);
  });

  it('checks a draft without saving it, and saves a draft that is not ready, flagged', async () => {
    const draft = { start: 'hi', nodes: { hi: { type: 'speak', speech: 'fixed', text: 'Hi', transitions: [{ to: 'gone' }] } } };
    const check = (await post('/internal/workflows/validate', { definition: draft })).json();
    expect(check.errors[0]).toMatchObject({ code: 'unknown_target', nodeId: 'hi' });
    const made = await create('draft', draft);
    expect(made.version.valid).toBe(false);
  });

  it('refuses a bad name and a duplicate name', async () => {
    expect((await post(`/internal/tenants/${tenantId}/workflows`, { name: '9bad name', definition: tiny() })).statusCode).toBe(400);
    await create('dupe');
    expect((await post(`/internal/tenants/${tenantId}/workflows`, { name: 'dupe', definition: tiny() })).statusCode).toBe(409);
  });
});

describe('exit criterion: a workflow with a dangling path cannot be published', () => {
  it('refuses to put it in staging, naming each problem, and nothing goes live', async () => {
    const dangling = { start: 'hi', nodes: { hi: { type: 'speak', speech: 'fixed', text: 'Hi', transitions: [{ to: 'nowhere' }] }, orphan: { type: 'end', outcome: 'x' } } };
    const { workflow, version } = await create('dangling', dangling);
    const res = await deploy(workflow.id, version.id, 'staging');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('cannot be published');
    const details = (res.json().details as string[]).join(' ');
    expect(details).toContain('nowhere');
    expect(details).toContain('Nothing leads to "orphan"');
    expect((await get(`/internal/workflows/${workflow.id}/deployments`)).json().live).toEqual({ staging: null, production: null });
  });

  it('lets the same workflow through once the path is fixed', async () => {
    const { workflow } = await create('fixable', { start: 'hi', nodes: { hi: { type: 'speak', speech: 'fixed', text: 'Hi', transitions: [{ to: 'nowhere' }] } } });
    const fixed = (await save(workflow.id, tiny('Hello {{name}}.'))).json();
    expect((await deploy(workflow.id, fixed.id, 'staging')).statusCode).toBe(201);
  });

  it('cannot be run either, simulated or tested', async () => {
    const { workflow, version } = await create('norun', { start: 'x', nodes: {} });
    expect((await simulate(workflow.id, version.id, [pass('s')])).statusCode).toBe(400);
    expect((await post(`/internal/workflows/${workflow.id}/runs`, { environment: 'staging' })).statusCode).toBe(409);
  });
});

describe('promotion: staging, a clean simulation, then production', () => {
  it('takes a version through every gate in order', async () => {
    const { workflow, version } = await create('gates');
    // production straight away: not in staging
    let r = await deploy(workflow.id, version.id, 'production');
    expect(r.statusCode).toBe(409); expect(r.json().error).toContain('not live in staging');
    expect((await deploy(workflow.id, version.id, 'staging')).statusCode).toBe(201);
    // in staging but never simulated
    r = await deploy(workflow.id, version.id, 'production');
    expect(r.statusCode).toBe(409); expect(r.json().error).toContain('no clean simulation');
    // a simulation with a failing scenario does not count
    const bad = (await simulate(workflow.id, undefined, [pass('good'), { name: 'wrong expectation', variables: { name: 'A' }, expect: { outcome: 'something_else' } }])).json();
    expect(bad).toMatchObject({ total: 2, passed: 1, failed: 1, clean: false });
    expect((await deploy(workflow.id, version.id, 'production')).statusCode).toBe(409);
    // a clean one does
    expect((await simulate(workflow.id, undefined, [pass('a'), pass('b')])).json().clean).toBe(true);
    const live = await deploy(workflow.id, version.id, 'production');
    expect(live.statusCode).toBe(201);
    expect((await get(`/internal/workflows/${workflow.id}/deployments`)).json().live).toEqual({ staging: '1.0', production: '1.0' });
    // already live
    expect((await deploy(workflow.id, version.id, 'production')).statusCode).toBe(409);
  });

  it('needs the new version simulated: a clean run of an older one does not carry over', async () => {
    const { workflow, version } = await create('carry');
    await must(deploy(workflow.id, version.id, 'staging'));
    await must(simulate(workflow.id, undefined, [pass('a')]));
    await must(deploy(workflow.id, version.id, 'production'));
    const v2 = (await save(workflow.id, tiny('Different wording, {{name}}.'))).json();
    await must(deploy(workflow.id, v2.id, 'staging'));
    const r = await deploy(workflow.id, v2.id, 'production');
    expect(r.statusCode).toBe(409); expect(r.json().error).toContain('no clean simulation');
  });

  it('refuses a version that belongs to a different workflow', async () => {
    const a = await create('mine'); const b = await create('theirs');
    expect((await deploy(a.workflow.id, b.version.id, 'staging')).statusCode).toBe(404);
  });
});

describe('simulations', () => {
  it('judge each scripted caller, and say what went wrong', async () => {
    const { workflow, version } = await create('judging', {
      start: 'ask', variables: ['name'], nodes: {
        ask: { type: 'speak', speech: 'hybrid', text: 'Hi {{name}}, ok?', listen: { captureAs: 'a', intents: { yes: ['yes'] } },
          transitions: [{ when: { var: 'a_intent', op: 'eq', value: 'yes' }, to: 'good' }, { to: 'bad' }] },
        good: { type: 'end', outcome: 'agreed' }, bad: { type: 'end', outcome: 'refused' },
      } });
    await must(deploy(workflow.id, version.id, 'staging'));
    const out = (await simulate(workflow.id, undefined, [
      { name: 'agrees', variables: { name: 'A' }, replies: ['yes'], expect: { outcome: 'agreed', says: ['Hi A'], doesNotSay: ['Goodbye'] } },
      { name: 'wrong outcome', variables: { name: 'A' }, replies: ['no'], expect: { outcome: 'agreed' } },
      { name: 'no script', variables: { name: 'A' } },
      { name: 'too many replies', variables: { name: 'A' }, replies: ['yes', 'extra'] },
      { name: 'missing variable', variables: {}, replies: ['yes'] },
      { name: 'phone number', variables: { name: '+60123456789' }, replies: ['yes'] },
      { name: 'says the wrong thing', variables: { name: 'A' }, replies: ['yes'], expect: { says: ['Never said'] } },
    ])).json();
    const by = Object.fromEntries(out.results.map((r: { name: string }) => [r.name, r]));
    expect(by.agrees.passed).toBe(true);
    expect(by['wrong outcome'].failures[0]).toContain('Expected the outcome "agreed" but got "refused"');
    expect(by['no script'].failures[0]).toContain('still waiting');
    expect(by['too many replies'].failures[0]).toContain('1 scripted reply unused');
    expect(by['missing variable'].failures.join(' ')).toContain('"name"');
    expect(by['phone number'].failures[0]).toContain('never kept');
    expect(by['says the wrong thing'].failures[0]).toContain('Never said');
    expect(out).toMatchObject({ total: 7, passed: 1, failed: 6, clean: false });
    // Each scenario is stored as a run, with its steps, for replay.
    const run = (await get(`/internal/workflow-runs/${by.agrees.runId}`)).json();
    expect(run).toMatchObject({ kind: 'simulation', environment: 'staging', outcome: 'agreed' });
    expect(run.steps.map((s: { type: string }) => s.type)).toEqual(['start', 'say', 'heard', 'reached_end', 'end']);
    const batch = (await get(`/internal/simulations/${out.batchId}`)).json();
    expect(batch.results).toHaveLength(7);
    expect(batch.results[0].runId).toBe(by.agrees.runId);
    await expect(env.pool.query('UPDATE simulation_batches SET failed = 0')).rejects.toThrow(/append-only/);
  });

  it('can simulate a version that is not live yet, so it can be tried before going to staging', async () => {
    const { workflow, version } = await create('trial');
    expect((await simulate(workflow.id, version.id, [pass('a')])).json().clean).toBe(true);
  });

  it('never calls a real integration: only the scenario\'s canned answers', async () => {
    const { workflow } = await create('canned', {
      start: 'look', variables: ['account'], nodes: {
        look: { type: 'api', integration: 'billing', path: '/a/{{account}}', store: { owing: 'data.owing' }, onError: 'oops', transitions: [{ to: 'say' }] },
        say: { type: 'speak', speech: 'hybrid', text: 'You owe {{owing}}.', transitions: [{ to: 'fin' }] },
        fin: { type: 'end', outcome: 'told' }, oops: { type: 'end', outcome: 'lookup_failed' },
      } });
    await must(deploy(workflow.id, (await get(`/internal/workflows/${workflow.id}/versions`)).json()[0].id, 'staging'));
    const out = (await simulate(workflow.id, undefined, [
      { name: 'canned', variables: { account: 'A' }, integrations: { billing: { data: { owing: '10.00' } } }, expect: { outcome: 'told', says: ['You owe 10.00'] } },
      { name: 'none given', variables: { account: 'A' }, expect: { outcome: 'lookup_failed' } },
    ])).json();
    expect(out.clean).toBe(true);
  });

  it('limits the size of a batch', async () => {
    const { workflow } = await create('limits');
    expect((await simulate(workflow.id, undefined, [])).statusCode).toBe(400);
    expect((await simulate(workflow.id, undefined, Array.from({ length: 501 }, (_, i) => pass(`s${i}`)))).statusCode).toBe(400);
    expect((await simulate(workflow.id, undefined, [{ ...pass('long'), replies: Array.from({ length: 51 }, () => 'x') }])).statusCode).toBe(400);
  });
});

describe('workflows that hand over to, or run, other workflows', () => {
  const callerOf = (target: string, kind: 'handoff' | 'subflow' = 'handoff', variables: string[] = ['name']): WorkflowDefinition => ({
    start: 'go', variables, nodes: {
      go: kind === 'handoff' ? { type: 'handoff', target: { workflow: target } } : { type: 'subflow', workflow: target, transitions: [{ to: 'end' }] },
      ...(kind === 'subflow' ? { end: { type: 'end', outcome: 'back' } } : {}),
    },
  });

  it('must have every target live in the same environment first', async () => {
    const target = await create('target_a', tiny());
    const caller = await create('caller_a', callerOf('target_a'));
    let r = await deploy(caller.workflow.id, caller.version.id, 'staging');
    expect(r.statusCode).toBe(400);
    expect((r.json().details as string[]).join(' ')).toContain('"target_a", which is not deployed there yet');
    await must(deploy(target.workflow.id, target.version.id, 'staging'));
    expect((await deploy(caller.workflow.id, caller.version.id, 'staging')).statusCode).toBe(201);
    // production: the target must be in production first, and the caller needs its own clean simulation
    await must(simulate(caller.workflow.id, undefined, [{ name: 's', variables: { name: 'A' }, expect: { outcome: 'finished' } }]));
    r = await deploy(caller.workflow.id, caller.version.id, 'production');
    expect(r.statusCode).toBe(400);
    expect((r.json().details as string[]).join(' ')).toContain('not deployed there yet');
  });

  it('refuses a target that does not exist, and a target the caller cannot give what it needs', async () => {
    const lost = await create('caller_b', callerOf('no_such_workflow'));
    const r1 = await deploy(lost.workflow.id, lost.version.id, 'staging');
    expect((r1.json().details as string[]).join(' ')).toContain('does not exist');

    const needs = await create('needs_more', { start: 'a', variables: ['name', 'balance'], nodes: { a: { type: 'speak', speech: 'hybrid', text: '{{name}} {{balance}}', transitions: [{ to: 'e' }] }, e: { type: 'end', outcome: 'x' } } });
    await must(deploy(needs.workflow.id, needs.version.id, 'staging'));
    const caller = await create('caller_c', callerOf('needs_more', 'handoff', ['name']));
    const r2 = await deploy(caller.workflow.id, caller.version.id, 'staging');
    expect(r2.statusCode).toBe(400);
    expect((r2.json().details as string[]).join(' ')).toContain('needs "balance"');
  });

  it('refuses subflows that loop into each other, naming the loop', async () => {
    const a = await create('loop_a', tiny());
    await must(deploy(a.workflow.id, a.version.id, 'staging'));
    const b = await create('loop_b', callerOf('loop_a', 'subflow'));
    await must(deploy(b.workflow.id, b.version.id, 'staging'));
    // loop_a now wants to run loop_b, which runs loop_a
    const looping = (await save(a.workflow.id, callerOf('loop_b', 'subflow'))).json();
    const r = await deploy(a.workflow.id, looping.id, 'staging');
    expect(r.statusCode).toBe(400);
    expect((r.json().details as string[]).join(' ')).toContain('Subflows loop: loop_a → loop_b → loop_a');
    expect((await get(`/internal/workflows/${a.workflow.id}/deployments`)).json().live.staging).toBe('1.0'); // the loop never went live
  });
});

describe('exit criterion: rolling back to the previous version works on a live workflow', () => {
  /** The same workflow with its greeting changed, so which version answered can be heard. */
  const v = (word: string, extra = false) => tiny(`${word}, {{name}}.`, extra);
  const goLive = async (wfId: string, versionId: string, scenarios: unknown[] = [pass('s')]) => {
    await must(deploy(wfId, versionId, 'staging'));
    await must(simulate(wfId, undefined, scenarios));
    await must(deploy(wfId, versionId, 'production'));
  };
  const startCall = async (wfId: string) => (await must(post(`/internal/workflows/${wfId}/runs`, { environment: 'production', kind: 'live', variables: { name: 'Aisha' } }))).json();

  it('puts the earlier version back for new calls, while calls already under way carry on with theirs', async () => {
    const one = await create('rollback_me', v('Hello'));
    const wfId = one.workflow.id;
    await goLive(wfId, one.version.id);
    const two = (await save(wfId, { ...v('Good day'), nodes: { ...v('Good day').nodes, hi: { type: 'speak', speech: 'hybrid', text: 'Good day, {{name}}.', listen: { captureAs: 'x' }, transitions: [{ to: 'done' }] } } })).json();
    await goLive(wfId, two.id, [{ ...pass('s'), replies: ['ok'] }]); // this version waits for the caller
    expect((await get(`/internal/workflows/${wfId}/deployments`)).json().live.production).toBe('1.1');

    // a call starts on 1.1 and is waiting for the caller when the rollback happens
    const inFlight = await startCall(wfId);
    expect(inFlight).toMatchObject({ status: 'awaiting_reply', said: ['Good day, Aisha.'] });

    const rb = await post(`/internal/workflows/${wfId}/rollback`, { environment: 'production' });
    expect(rb.statusCode).toBe(201);
    expect(rb.json()).toMatchObject({ kind: 'rollback', version: '1.0' });
    expect((await get(`/internal/workflows/${wfId}/deployments`)).json().live.production).toBe('1.0');

    // new calls get the version rolled back to
    const fresh = await startCall(wfId);
    expect(fresh).toMatchObject({ status: 'ended', outcome: 'finished', said: ['Hello, Aisha.'] });
    // the call already under way finishes on the version it started with
    const finished = (await must(post(`/internal/workflow-runs/${inFlight.id}/reply`, { text: 'ok' }))).json();
    expect(finished).toMatchObject({ status: 'ended', outcome: 'finished' });
    const detail = (await get(`/internal/workflow-runs/${inFlight.id}`)).json();
    expect(detail.version_id).toBe(two.id);
  });

  it('goes back one version at a time, however many times it is used, and says when there is nothing earlier', async () => {
    const a = await create('rollback_many', v('One'));
    const wfId = a.workflow.id;
    const ids = [a.version.id];
    await goLive(wfId, a.version.id);
    for (const word of ['Two', 'Three']) {
      const next = (await save(wfId, v(word))).json(); ids.push(next.id);
      await goLive(wfId, next.id);
    }
    const live = async () => (await get(`/internal/workflows/${wfId}/deployments`)).json().live.production;
    expect(await live()).toBe('1.2');
    expect((await post(`/internal/workflows/${wfId}/rollback`, { environment: 'production' })).json().version).toBe('1.1');
    expect((await post(`/internal/workflows/${wfId}/rollback`, { environment: 'production' })).json().version).toBe('1.0');
    expect(await live()).toBe('1.0');
    const none = await post(`/internal/workflows/${wfId}/rollback`, { environment: 'production' });
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toContain('no earlier version');
    expect(await live()).toBe('1.0');
    // history keeps every step
    const hist = (await get(`/internal/workflows/${wfId}/deployments`)).json().history.filter((h: { environment: string }) => h.environment === 'production');
    expect(hist.map((h: { kind: string; version: string }) => `${h.kind}:${h.version}`)).toEqual(['rollback:1.0', 'rollback:1.1', 'deploy:1.2', 'deploy:1.1', 'deploy:1.0']);
  });

  it('deploying forward again after a rollback works, and a rollback is also an audited, append-only record', async () => {
    const a = await create('rollback_fwd', v('One'));
    await goLive(a.workflow.id, a.version.id);
    const two = (await save(a.workflow.id, v('Two'))).json();
    await goLive(a.workflow.id, two.id);
    await must(post(`/internal/workflows/${a.workflow.id}/rollback`, { environment: 'production' }));
    expect((await deploy(a.workflow.id, two.id, 'production')).statusCode).toBe(201); // already simulated and in staging: allowed again
    expect((await get(`/internal/workflows/${a.workflow.id}/deployments`)).json().live.production).toBe('1.1');
    const audit = await env.pool.query(`SELECT action FROM audit_log WHERE entity_id = $1 AND action LIKE 'workflow.%' ORDER BY id`, [a.workflow.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['workflow.deploy', 'workflow.rollback']));
    await expect(env.pool.query('DELETE FROM workflow_deployments')).rejects.toThrow(/append-only/);
  });

  it('can roll staging back too', async () => {
    const a = await create('rollback_staging', v('One'));
    await must(deploy(a.workflow.id, a.version.id, 'staging'));
    const two = (await save(a.workflow.id, v('Two'))).json();
    await must(deploy(a.workflow.id, two.id, 'staging'));
    expect((await post(`/internal/workflows/${a.workflow.id}/rollback`, { environment: 'staging' })).json().version).toBe('1.0');
  });
});
