import { describe, expect, it } from 'vitest';
import type { Json, WorkflowDefinition } from '../src/workflows/definition.js';
import { PhoneInVariable, reply, start, type Deps, type IntegrationCall, type RunState } from '../src/workflows/engine.js';
import { validateDefinition } from '../src/workflows/validate.js';

type Defs = Record<string, WorkflowDefinition>;
const depsFor = (defs: Defs, extra: Partial<Deps> = {}): Deps => ({ load: (n) => defs[n], ...extra });
const said = (records: { type: string; payload: Record<string, Json> }[]) => records.filter((r) => r.type === 'say').map((r) => r.payload.text);

/** Run a script of caller replies to the end, returning everything said and the final state. */
async function drive(defs: Defs, entry: string, vars: Record<string, Json>, replies: string[], extra: Partial<Deps> = {}) {
  const deps = depsFor(defs, extra);
  let { state, records } = await start(entry, vars, deps);
  const all = [...records];
  for (const text of replies) {
    if (state.status !== 'awaiting_reply') break;
    state = JSON.parse(JSON.stringify(state)) as RunState; // a call can be stored and resumed between turns
    const r = await reply(state, text, deps);
    state = r.state; all.push(...r.records);
  }
  return { state, records: all };
}

const greet: WorkflowDefinition = {
  start: 'ask', variables: ['name'], languages: ['en', 'ms'],
  nodes: {
    ask: { type: 'speak', speech: 'hybrid', text: { en: 'Hello {{name}}, can you talk?', ms: 'Helo {{name}}, boleh bercakap?' },
      listen: { captureAs: 'answer', intents: { yes: ['yes', 'ya'], no: ['no', 'tidak'] } },
      transitions: [{ when: { var: 'answer_intent', op: 'eq', value: 'yes' }, to: 'great' }, { when: { var: 'answer_intent', op: 'eq', value: 'no' }, to: 'sorry' }] },
    great: { type: 'speak', speech: 'fixed', text: 'Great.', transitions: [{ to: 'fin' }] },
    sorry: { type: 'speak', speech: 'fixed', text: 'Sorry to trouble you.' },
    fin: { type: 'end', outcome: 'talked' },
  },
};

describe('routing', () => {
  it('speaks, waits for the caller, and follows the first condition that holds', async () => {
    const { state, records } = await drive({ greet }, 'greet', { name: 'Aisha' }, ['Yes please']);
    expect(said(records)).toEqual(['Hello Aisha, can you talk?', 'Great.']);
    expect(state).toMatchObject({ status: 'ended', outcome: 'talked' });
    expect(state.vars).toMatchObject({ answer: 'Yes please', answer_intent: 'yes' });
  });

  it('speaks the caller\'s language, falling back to English', async () => {
    expect(said((await drive({ greet }, 'greet', { name: 'Aisha', lang: 'ms' }, [])).records)).toEqual(['Helo Aisha, boleh bercakap?']);
    expect(said((await drive({ greet }, 'greet', { name: 'Aisha', lang: 'ta' }, [])).records)).toEqual(['Hello Aisha, can you talk?']);
  });

  it('ends the call cleanly when no condition matches, instead of hanging or guessing', async () => {
    const { state, records } = await drive({ greet }, 'greet', { name: 'Aisha' }, ['mmm what']);
    expect(state).toMatchObject({ status: 'ended', outcome: 'completed' });
    expect(state.error).toBeUndefined();
    expect(records.at(-1)).toMatchObject({ type: 'end', payload: { outcome: 'completed' } });
  });

  it('ends cleanly at a node with no transitions', async () => {
    const { state } = await drive({ greet }, 'greet', { name: 'Aisha' }, ['no thanks']);
    expect(state).toMatchObject({ status: 'ended', outcome: 'completed' });
  });

  it('is plain data throughout: the state survives JSON, so a call can wait between turns', async () => {
    const deps = depsFor({ greet });
    const first = await start('greet', { name: 'Aisha' }, deps);
    expect(first.state.status).toBe('awaiting_reply');
    const stored = JSON.parse(JSON.stringify(first.state)) as RunState;
    expect((await reply(stored, 'ya', deps)).state.outcome).toBe('talked');
    expect(stored.status).toBe('awaiting_reply'); // resuming does not change what was stored
  });

  it('refuses a reply when the call is not waiting for one', async () => {
    const deps = depsFor({ greet });
    const { state } = await drive({ greet }, 'greet', { name: 'A' }, ['ya']);
    await expect(reply(state, 'hello', deps)).rejects.toThrow(/not waiting/);
  });
});

describe('failing closed', () => {
  it('stops without saying anything when a variable is missing', async () => {
    const { state, records } = await drive({ greet }, 'greet', {}, []);
    expect(state).toMatchObject({ status: 'ended', outcome: 'error' });
    expect(state.error).toContain('"name"');
    expect(said(records)).toEqual([]);
  });

  it('stops a loop with no way out', async () => {
    const loop: WorkflowDefinition = { start: 'a', nodes: { a: { type: 'speak', speech: 'fixed', text: 'again', transitions: [{ to: 'a' }] } } };
    const { state } = await drive({ loop }, 'loop', {}, [], { maxSteps: 25 });
    expect(state).toMatchObject({ status: 'ended', outcome: 'error' });
    expect(state.error).toContain('25 steps');
  });

  it('reports a workflow that is not available', async () => {
    expect((await start('ghost', {}, depsFor({}))).state).toMatchObject({ status: 'ended', outcome: 'error' });
  });

  it('keeps phone numbers out of the call\'s variables', async () => {
    await expect(start('greet', { name: 'A', phone: '+60 12-345 6789' }, depsFor({ greet }))).rejects.toThrow(PhoneInVariable);
    await expect(start('greet', { name: 'A', phone: '+60123456789' }, depsFor({ greet }))).rejects.toThrow(/never kept/);
    await expect(start('greet', { name: 'A', balance: '1250.50', ref: 'INV-20260101' }, depsFor({ greet }))).resolves.toBeDefined();
  });

  it('keeps a number the caller speaks out of what it stores', async () => {
    const { state, records } = await drive({ greet }, 'greet', { name: 'A' }, ['yes call me on +60 12-345 6789']);
    expect(String(state.vars.answer)).not.toContain('345');
    expect(JSON.stringify(records)).not.toContain('6789');
    expect(state.vars.answer_intent).toBe('yes');
  });
});

describe('dynamic speech', () => {
  const dyn: WorkflowDefinition = { start: 'd', variables: ['name'], nodes: {
    d: { type: 'speak', speech: 'dynamic', prompt: 'Greet {{name}} warmly.', text: 'Hello {{name}}.' } } };
  const noFallback: WorkflowDefinition = { start: 'd', nodes: { d: { type: 'speak', speech: 'dynamic', prompt: 'Say hi.' } } };

  it('uses a connected model when there is one', async () => {
    const speaker = { generate: async (_n: unknown, vars: Record<string, Json>) => `Warm hello, ${vars.name}!` };
    expect(said((await drive({ dyn }, 'dyn', { name: 'Wei' }, [], { speaker: speaker as never })).records)).toEqual(['Warm hello, Wei!']);
  });
  it('speaks the fallback line when none is connected', async () => {
    expect(said((await drive({ dyn }, 'dyn', { name: 'Wei' }, [])).records)).toEqual(['Hello Wei.']);
  });
  it('fails instead of staying silent when there is neither', async () => {
    const { state } = await drive({ noFallback }, 'noFallback', {}, []);
    expect(state).toMatchObject({ outcome: 'error' });
    expect(state.error).toContain('no model is connected');
  });
});

describe('subflows', () => {
  const verify: WorkflowDefinition = {
    start: 'ask', variables: ['expected'], nodes: {
      ask: { type: 'speak', speech: 'fixed', text: 'Last four digits?', listen: { captureAs: 'given' },
        transitions: [{ when: { var: 'given', op: 'eq', valueVar: 'expected' }, to: 'ok' }, { to: 'no' }] },
      ok: { type: 'end', outcome: 'verified' }, no: { type: 'end', outcome: 'failed' },
    },
  };
  const main: WorkflowDefinition = {
    start: 'check', variables: ['expected'], nodes: {
      check: { type: 'subflow', workflow: 'verify', exports: ['given'],
        transitions: [{ when: { var: 'check_outcome', op: 'eq', value: 'verified' }, to: 'ok' }, { to: 'refuse' }] },
      ok: { type: 'speak', speech: 'hybrid', text: 'Thank you, you gave {{given}}.', transitions: [{ to: 'fin' }] },
      refuse: { type: 'speak', speech: 'fixed', text: 'I cannot continue.', transitions: [{ to: 'bye' }] },
      fin: { type: 'end', outcome: 'done' }, bye: { type: 'end', outcome: 'refused' },
    },
  };
  const defs = { main, verify };

  it('runs another workflow inside this one, shares variables, and comes back with its outcome', async () => {
    const good = await drive(defs, 'main', { expected: '4521' }, ['4521']);
    expect(good.state).toMatchObject({ outcome: 'done' });
    expect(said(good.records)).toEqual(['Last four digits?', 'Thank you, you gave 4521.']);
    expect(good.state.vars.check_outcome).toBe('verified');
    expect(good.records.map((r) => r.type)).toEqual(expect.arrayContaining(['subflow_enter', 'subflow_exit']));

    const bad = await drive(defs, 'main', { expected: '4521' }, ['9999']);
    expect(bad.state).toMatchObject({ outcome: 'refused' });
    expect(bad.state.vars.check_outcome).toBe('failed');
  });

  it('can pause for the caller inside a subflow and resume there', async () => {
    const deps = depsFor(defs);
    const first = await start('main', { expected: '1' }, deps);
    expect(first.state).toMatchObject({ status: 'awaiting_reply', workflow: 'verify' });
    expect(first.state.stack).toEqual([{ workflow: 'main', node: 'check' }]);
  });

  it('treats a subflow that ends cleanly as finished, and returns to the parent', async () => {
    const quiet: WorkflowDefinition = { start: 'q', nodes: { q: { type: 'speak', speech: 'fixed', text: 'Just a note.' } } };
    const parent: WorkflowDefinition = { start: 's', nodes: {
      s: { type: 'subflow', workflow: 'quiet', transitions: [{ when: { var: 's_outcome', op: 'eq', value: 'completed' }, to: 'after' }] },
      after: { type: 'speak', speech: 'fixed', text: 'Back in the parent.', transitions: [{ to: 'e' }] }, e: { type: 'end', outcome: 'ok' } } };
    const r = await drive({ quiet, parent }, 'parent', {}, []);
    expect(said(r.records)).toEqual(['Just a note.', 'Back in the parent.']);
    expect(r.state.outcome).toBe('ok');
  });

  it('stops runaway recursion and reports a missing subflow', async () => {
    const a: WorkflowDefinition = { start: 's', nodes: { s: { type: 'subflow', workflow: 'a' } } };
    expect((await drive({ a }, 'a', {}, [])).state.error).toContain('nested too deeply');
    const lost: WorkflowDefinition = { start: 's', nodes: { s: { type: 'subflow', workflow: 'nope' } } };
    expect((await drive({ lost }, 'lost', {}, [])).state.error).toContain('"nope"');
  });
});

describe('handoff', () => {
  const second: WorkflowDefinition = { start: 'x', variables: ['name', 'balance'], nodes: {
    x: { type: 'speak', speech: 'hybrid', text: '{{name}}, about RM {{balance}}: how much can you pay?', listen: { captureAs: 'amount' }, transitions: [{ to: 'ok' }] },
    ok: { type: 'end', outcome: 'partial_agreed' } } };
  const first: WorkflowDefinition = { start: 'h', variables: ['name', 'balance'], nodes: { h: { type: 'handoff', target: { workflow: 'second' } } } };

  it('passes the call and every variable to another workflow, which finishes it', async () => {
    const r = await drive({ first, second }, 'first', { name: 'Aisha', balance: '900.00', note: 'kept' }, ['200']);
    expect(said(r.records)).toEqual(['Aisha, about RM 900.00: how much can you pay?']);
    expect(r.state).toMatchObject({ outcome: 'partial_agreed', workflow: 'second' });
    expect(r.state.vars).toMatchObject({ note: 'kept', amount: '200' });
    expect(r.records.find((x) => x.type === 'handoff')!.payload).toMatchObject({ to: 'second', carried: ['balance', 'name', 'note'] });
  });

  it('does not come back, even from inside a subflow', async () => {
    const wrapper: WorkflowDefinition = { start: 's', variables: ['name', 'balance'], nodes: {
      s: { type: 'subflow', workflow: 'first', transitions: [{ to: 'never' }] }, never: { type: 'speak', speech: 'fixed', text: 'Should not be said.' } } };
    const r = await drive({ wrapper, first, second }, 'wrapper', { name: 'A', balance: '1' }, ['5']);
    expect(said(r.records)).not.toContain('Should not be said.');
    expect(r.state.stack).toEqual([]);
    expect(r.state.outcome).toBe('partial_agreed');
  });

  it('hands over to a person with the reason, and ends the automated call', async () => {
    const human: WorkflowDefinition = { start: 'h', nodes: { h: { type: 'handoff', target: { human: { reason: 'customer disputes the debt' } } } } };
    const r = await drive({ human }, 'human', {}, []);
    expect(r.state).toMatchObject({ status: 'ended', outcome: 'handoff_human' });
    expect(r.records.find((x) => x.type === 'handoff_human')!.payload).toEqual({ reason: 'customer disputes the debt' });
  });

  it('reports a missing target', async () => {
    expect((await drive({ first }, 'first', { name: 'A', balance: '1' }, [])).state.error).toContain('"second"');
  });
});

describe('api nodes', () => {
  const look: WorkflowDefinition = { start: 'a', variables: ['account'], nodes: {
    a: { type: 'api', integration: 'status', path: '/accounts/{{account}}/status', store: { paid: 'data.paid', owing: 'data.owing', missing: 'data.nothing' }, onError: 'oops',
      transitions: [{ when: { var: 'paid', op: 'eq', value: true }, to: 'paid' }, { to: 'owes' }] },
    paid: { type: 'end', outcome: 'already_paid' },
    owes: { type: 'speak', speech: 'hybrid', text: 'You owe RM {{owing}}.', transitions: [{ to: 'fin' }] },
    fin: { type: 'end', outcome: 'told' },
    oops: { type: 'speak', speech: 'fixed', text: 'I cannot look that up right now.', transitions: [{ to: 'end2' }] },
    end2: { type: 'end', outcome: 'lookup_failed' },
  } };
  const integrations = (handler: (name: string, req: IntegrationCall) => Json | Promise<Json>) => ({ call: async (n: string, r: IntegrationCall) => handler(n, r) });

  it('calls the integration, keeps the parts it asked for, and routes on them', async () => {
    const calls: IntegrationCall[] = [];
    const ints = integrations((_n, r) => { calls.push(r); return { data: { paid: false, owing: '350.00' } }; });
    const r = await drive({ look }, 'look', { account: 'A-1' }, [], { integrations: ints });
    expect(said(r.records)).toEqual(['You owe RM 350.00.']);
    expect(calls).toEqual([{ method: 'GET', path: '/accounts/A-1/status' }]);
    expect(r.state.vars).toMatchObject({ paid: false, owing: '350.00' });
    expect('missing' in r.state.vars).toBe(false); // a field the reply lacked stays unset
    expect(r.records.find((x) => x.type === 'api')!.payload).toEqual({ integration: 'status', stored: ['paid', 'owing'] });

    const paid = await drive({ look }, 'look', { account: 'A-1' }, [], { integrations: integrations(() => ({ data: { paid: true } })) });
    expect(paid.state.outcome).toBe('already_paid');
  });

  it('puts values into the path encoded, so a caller\'s words cannot reach another endpoint', async () => {
    const calls: IntegrationCall[] = [];
    await drive({ look }, 'look', { account: '../../admin?x=1#' }, [], { integrations: integrations((_n, r) => { calls.push(r); return { data: {} }; }) });
    expect(calls[0]!.path).toBe('/accounts/..%2F..%2Fadmin%3Fx%3D1%23/status');
  });

  it('follows onError when the integration fails, and ends cleanly with no onError', async () => {
    const boom = integrations(() => { throw new Error('connection refused'); });
    const r = await drive({ look }, 'look', { account: 'A-1' }, [], { integrations: boom });
    expect(said(r.records)).toEqual(['I cannot look that up right now.']);
    expect(r.state.outcome).toBe('lookup_failed');
    expect(r.records.map((x) => x.type)).toContain('api_error');

    const noHandler: WorkflowDefinition = { start: 'a', nodes: { a: { type: 'api', integration: 'status', path: '/x' } } };
    const r2 = await drive({ noHandler }, 'noHandler', {}, [], { integrations: boom });
    expect(r2.state).toMatchObject({ status: 'ended', outcome: 'integration_failed' });
  });

  it('never keeps a phone number the integration returns, and scrubs one from an error', async () => {
    const leaky = integrations(() => ({ data: { owing: '+60123456789' } }));
    const r = await drive({ look }, 'look', { account: 'A-1' }, [], { integrations: leaky });
    expect(JSON.stringify(r.state)).not.toContain('123456789');
    expect(r.records.find((x) => x.type === 'api_error')!.payload.reason).toContain('never kept');
    const noisy = integrations(() => { throw new Error('No account for +60 12-345 6789'); });
    const r2 = await drive({ look }, 'look', { account: 'A-1' }, [], { integrations: noisy });
    expect(JSON.stringify(r2.records)).not.toContain('345 6789');
  });

  it('fails when no integrations are connected', async () => {
    expect((await drive({ look }, 'look', { account: 'A-1' }, [])).state.error).toContain('none are connected');
  });
});

describe('every workflow in these tests is itself valid', () => {
  it('passes the validator', () => {
    for (const d of [greet]) expect(validateDefinition(d).errors).toEqual([]);
  });
});

// ---------------------------------------------------------------- sensitive data and the template
import { instantiate, templateFor, TEMPLATES } from '../src/workflows/templates.js';

describe('sensitive answers', () => {
  const secret: WorkflowDefinition = {
    start: 'ask', variables: ['expected'], sensitiveVariables: ['expected'], nodes: {
      ask: { type: 'speak', speech: 'fixed', text: 'Last four digits?', listen: { captureAs: 'given', sensitive: true },
        transitions: [{ when: { var: 'given', op: 'eq', valueVar: 'expected' }, to: 'ok' }, { to: 'no' }] },
      ok: { type: 'speak', speech: 'fixed', text: 'Thanks.', transitions: [{ to: 'fin' }] }, no: { type: 'end', outcome: 'failed' }, fin: { type: 'end', outcome: 'verified' },
    },
  };
  it('is used to route the call and then forgotten, and never recorded', async () => {
    const r = await drive({ secret }, 'secret', { expected: '4521' }, ['4521']);
    expect(r.state.outcome).toBe('verified');
    expect(JSON.stringify(r.records)).not.toContain('4521');
    expect(r.records.find((x) => x.type === 'heard')!.payload.text).toBe('[hidden]');
    expect('given' in r.state.vars).toBe(false);   // gone as soon as the route was chosen
    expect('expected' in r.state.vars).toBe(false); // gone when the call ended
    expect(JSON.stringify(r.state)).not.toContain('4521');
  });
  it('is still wiped when the call fails or hands over, and while waiting it is held only in the call\'s own state', async () => {
    const waiting = await start('secret', { expected: '4521' }, depsFor({ secret }));
    expect(waiting.state.vars.expected).toBe('4521'); // needed to resume
    const wrong = await drive({ secret }, 'secret', { expected: '4521' }, ['9999']);
    expect(wrong.state.outcome).toBe('failed');
    expect('expected' in wrong.state.vars).toBe(false);
    expect(JSON.stringify(wrong.records)).not.toContain('9999');
    // With no record to check against, nobody is verified: whatever is said, the check fails.
    const noRecord = await drive({ secret }, 'secret', {}, ['4521']);
    expect(noRecord.state.outcome).toBe('failed');
  });
  it('cannot be spoken or sent to an integration, as the validator enforces', () => {
    const speak = { ...secret, nodes: { ...secret.nodes, ok: { type: 'speak', speech: 'hybrid', text: 'You said {{given}}.', transitions: [{ to: 'fin' }] } } };
    expect(validateDefinition(speak).errors.map((e) => e.code)).toContain('sensitive_in_speech');
    const sent = { ...secret, nodes: { ...secret.nodes, ok: { type: 'api', integration: 'x', path: '/check/{{expected}}', transitions: [{ to: 'fin' }] } } };
    expect(validateDefinition(sent).errors.map((e) => e.code)).toContain('sensitive_in_request');
    const unknown = { ...secret, sensitiveVariables: ['expected', 'ghost'] };
    expect(validateDefinition(unknown).errors.map((e) => e.code)).toContain('unknown_variable');
    expect(validateDefinition(secret).errors).toEqual([]);
  });
  it('carries into workflows the call moves to', async () => {
    const inner: WorkflowDefinition = { start: 'a', variables: ['pin'], sensitiveVariables: ['pin'], nodes: { a: { type: 'end', outcome: 'x' } } };
    const outer: WorkflowDefinition = { start: 's', variables: ['pin'], nodes: { s: { type: 'subflow', workflow: 'inner', transitions: [{ to: 'f' }] }, f: { type: 'end', outcome: 'done' } } };
    const r = await drive({ inner, outer }, 'outer', { pin: '1234' }, []);
    expect(r.state.outcome).toBe('done');
    expect('pin' in r.state.vars).toBe(false);
  });
});

describe('the debt-collection template (Malaysia)', () => {
  const t = templateFor('debt_collection_my')!;
  const defs: Defs = Object.fromEntries(instantiate(t).map((w) => [w.name, w.definition]));
  const contact = { customer_name: 'Aisha binti Ahmad', company: 'Acme Finance', balance: '1250.50', account_name: 'Personal Loan', due_date: '1 September 2026',
    payment_channel: 'online banking', expected_nric_last4: '4521' };
  const go = (replies: string[], vars: Record<string, Json> = {}) => drive(defs, 'collections', { ...contact, ...vars }, replies);

  it('is made of valid workflows, all of them reachable from the entry', () => {
    for (const w of instantiate(t)) expect(validateDefinition(w.definition).errors, w.name).toEqual([]);
    expect(Object.keys(defs).sort()).toEqual(['collections', 'human_transfer', 'partial_payment', 'verify_identity']);
    expect(TEMPLATES.map((x) => x.key)).toContain('debt_collection_my');
  });
  it('takes a promise to pay from a verified customer, never speaking the identity digits', async () => {
    const r = await go(['Yes, speaking', '4521', 'Yes I can pay today']);
    expect(r.state.outcome).toBe('promise_to_pay');
    const lines = said(r.records).join(' | ');
    expect(lines).toContain('Am I speaking with Aisha binti Ahmad?');
    expect(lines).toContain('outstanding balance of RM 1250.50 on your Personal Loan account, which was due on 1 September 2026');
    expect(lines).toContain('pay through online banking');
    expect(JSON.stringify(r.records)).not.toContain('4521');
    expect(JSON.stringify(r.state)).not.toContain('4521');
  });
  it('speaks Bahasa Malaysia to a customer who prefers it, and understands the replies', async () => {
    const r = await go(['Ya betul', '4521', 'boleh'], { lang: 'ms' });
    expect(r.state.outcome).toBe('promise_to_pay');
    expect(said(r.records)[0]).toBe('Helo, ini Acme Finance menghubungi Aisha binti Ahmad. Adakah saya bercakap dengan Aisha binti Ahmad?');
    expect(said(r.records).join(' ')).toContain('baki tertunggak sebanyak RM 1250.50');
  });
  it('ends politely on the wrong person, before any identity check or mention of a debt', async () => {
    const r = await go(['No, wrong number']);
    expect(r.state.outcome).toBe('wrong_person');
    expect(said(r.records).join(' ')).not.toMatch(/balance|RM|identity/i);
  });
  it('asks once more when the answer is unclear, then gives up politely', async () => {
    const r = await go(['mmm', 'what']);
    expect(r.state.outcome).toBe('no_clear_answer');
    expect(said(r.records).join(' ')).not.toContain('balance');
  });
  it('gives two tries at the identity check, then stops without disclosing anything', async () => {
    const r = await go(['yes', '1111', '2222']);
    expect(r.state.outcome).toBe('verification_failed');
    expect(said(r.records).join(' ')).not.toMatch(/balance|RM 1250/);
    const second = await go(['yes', '1111', '4521', 'yes']);
    expect(second.state.outcome).toBe('promise_to_pay');
  });
  it('hands a customer who can pay only part to the payment-plan workflow, carrying everything', async () => {
    const r = await go(['yes', '4521', 'I can only pay some of it', '200']);
    expect(r.state).toMatchObject({ outcome: 'partial_agreed', workflow: 'partial_payment' });
    expect(said(r.records).at(-1)).toContain('about RM 200 each month');
    expect(r.records.find((x) => x.type === 'handoff')!.payload.to).toBe('partial_payment');
    const cannot = await go(['yes', '4521', "I can't pay now", '150']);
    expect(cannot.state.outcome).toBe('partial_agreed');
  });
  it('passes to a person when the customer disputes the balance, or the amount is not understood', async () => {
    const dispute = await go(['yes', '4521', 'That is wrong, I dispute it']);
    expect(dispute.state.outcome).toBe('handoff_human');
    expect(dispute.records.find((x) => x.type === 'handoff')!.payload.to).toBe('human_transfer');
    expect(said(dispute.records).at(-1)).toContain('pass you to a colleague');
    const vague = await go(['yes', '4521', 'I can only pay some of it', 'whatever I can']);
    expect(vague.state.outcome).toBe('handoff_human');
  });
  it('tells a Bahasa Malaysia caller "cannot" apart from "can"', async () => {
    const r = await go(['ya', '4521', 'tidak boleh', '100'], { lang: 'ms' });
    expect(r.state.outcome).toBe('partial_agreed'); // "tidak boleh" is read as cannot, not as the "boleh" inside it
  });
  it('can be named with a prefix, and its references follow', () => {
    const named = instantiate(t, 'acme_');
    expect(named.map((w) => w.name).sort()).toEqual(['acme_collections', 'acme_human_transfer', 'acme_partial_payment', 'acme_verify_identity']);
    const main = named.find((w) => w.name === 'acme_collections')!.definition;
    expect((main.nodes.verify as { workflow: string }).workflow).toBe('acme_verify_identity');
    expect((main.nodes.to_partial as { target: { workflow: string } }).target.workflow).toBe('acme_partial_payment');
    expect(t.workflows[0]!.definition.nodes.verify).toMatchObject({ workflow: 'verify_identity' }); // the template itself is untouched
  });
});
