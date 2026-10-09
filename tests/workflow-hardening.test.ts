import { describe, expect, it } from 'vitest';
import type { Json, WorkflowDefinition } from '../src/workflows/definition.js';
import { checkVars, PhoneInVariable, reply, start, type Deps, type IntegrationCall } from '../src/workflows/engine.js';
import { isPublicAddress } from '../src/workflows/integrations.js';
import { checkReferences } from '../src/workflows/refs.js';
import { validateDefinition } from '../src/workflows/validate.js';

// Findings from the independent review of Phase 2, each reproduced here before it was fixed.
const depsFor = (defs: Record<string, WorkflowDefinition>, extra: Partial<Deps> = {}): Deps => ({ load: (n) => defs[n], ...extra });
const said = (r: { type: string; payload: Record<string, Json> }[]) => r.filter((x) => x.type === 'say').map((x) => x.payload.text);
const codes = (d: unknown) => validateDefinition(d).errors.map((e) => e.code);

describe('sensitivity holds across workflows', () => {
  const parent: WorkflowDefinition = { start: 's', variables: ['ic'], sensitiveVariables: ['ic'], nodes: { s: { type: 'subflow', workflow: 'child', transitions: [{ to: 'e' }] }, e: { type: 'end', outcome: 'ok' } } };
  const child: WorkflowDefinition = { start: 'a', variables: ['ic'], nodes: { a: { type: 'speak', speech: 'hybrid', text: 'Your IC is {{ic}}.', transitions: [{ to: 'e' }] }, e: { type: 'end', outcome: 'x' } } };

  it('is reported before publishing: a parent\'s sensitive variable cannot be spoken by the workflow it hands over to', () => {
    const issues = checkReferences('parent', parent, (n) => (n === 'child' ? child : 'absent'));
    expect(issues.map((i) => i.code)).toContain('sensitive_across_workflows');
    expect(issues.find((i) => i.code === 'sensitive_across_workflows')!.message).toContain('"ic"');
  });
  it('is reported the other way round too: what a child marks sensitive cannot be spoken by the parent', () => {
    const p2: WorkflowDefinition = { start: 's', variables: ['ic'], nodes: { s: { type: 'subflow', workflow: 'c2', transitions: [{ to: 't' }] }, t: { type: 'speak', speech: 'hybrid', text: 'IC {{ic}}', transitions: [{ to: 'e' }] }, e: { type: 'end', outcome: 'ok' } } };
    const c2: WorkflowDefinition = { start: 'a', variables: ['ic'], sensitiveVariables: ['ic'], nodes: { a: { type: 'end', outcome: 'x' } } };
    expect(checkReferences('p2', p2, (n) => (n === 'c2' ? c2 : 'absent')).map((i) => i.code)).toContain('sensitive_across_workflows');
  });
  it('is enforced while the call runs, whatever the definitions say: it is never spoken', async () => {
    const { state, records } = await start('parent', { ic: '900101145678' }, depsFor({ parent, child }));
    expect(said(records)).toEqual([]);
    expect(JSON.stringify(records)).not.toContain('900101145678');
    expect(state).toMatchObject({ status: 'ended', outcome: 'error' });
    expect(state.error).toContain('sensitive');
  });
  it('is never given to a model that writes a line, and never sent to an integration', async () => {
    const seen: string[][] = [];
    const speaker = { generate: async (_n: unknown, vars: Record<string, Json>) => { seen.push(Object.keys(vars)); return 'ok'; } };
    const dyn: WorkflowDefinition = { start: 'd', variables: ['name', 'pin'], sensitiveVariables: ['pin'], nodes: { d: { type: 'speak', speech: 'dynamic', prompt: 'Greet {{name}}', text: 'Hi' } } };
    await start('dyn', { name: 'A', pin: '1234' }, depsFor({ dyn }, { speaker: speaker as never }));
    expect(seen[0]).toEqual(['name']);
    const calls: IntegrationCall[] = [];
    const api: WorkflowDefinition = { start: 'a', variables: ['pin'], sensitiveVariables: ['pin'], nodes: { a: { type: 'api', integration: 'x', path: '/p/{{pin}}' } } };
    const r = await start('api', { pin: '1234' }, depsFor({ api }, { integrations: { call: async (_n, q) => { calls.push(q); return {}; } } }));
    expect(calls).toEqual([]);
    expect(r.state.outcome).toBe('error');
  });
});

describe('names every object inherits are not nodes, variables or targets', () => {
  const base = (): any => ({ start: 'a', variables: ['name'], nodes: { a: { type: 'speak', speech: 'fixed', text: 'Hi', transitions: [{ to: 'z' }] }, z: { type: 'end', outcome: 'x' } } });
  it.each(['toString', 'constructor', 'valueOf', 'hasOwnProperty', '__proto__'])('a transition to "%s" is a dangling path', (name) => {
    const d = base(); d.nodes.a.transitions = [{ to: 'z' }, { to: name }];
    expect(codes(d)).toContain('unknown_target');
  });
  it('a start or an onError route that names one is rejected', () => {
    expect(codes({ ...base(), start: 'valueOf' })).toContain('bad_start');
    const d = base(); d.nodes.api = { type: 'api', integration: 'x', path: '/p', onError: 'constructor' }; d.nodes.a.transitions.push({ to: 'api' });
    expect(codes(d)).toContain('unknown_target');
  });
  it('reserved names cannot be used for nodes, variables, captures or stored values', () => {
    for (const bad of ['__proto__', 'constructor', 'prototype']) {
      const d = base(); d.variables = [bad]; expect(codes(d), `variable ${bad}`).toContain('bad_variables');
      const e = base(); e.nodes.a.listen = { captureAs: bad }; expect(codes(e), `capture ${bad}`).toContain('bad_listen');
      const f = base(); f.nodes.api = { type: 'api', integration: 'x', path: '/p', store: { [bad]: 'a.b' } }; f.nodes.a.transitions.push({ to: 'api' }); expect(codes(f), `store ${bad}`).toContain('bad_store');
      const g = base(); g.nodes[bad] = { type: 'end', outcome: 'x' }; expect(codes(g), `node ${bad}`).toContain('bad_node_id');
    }
  });
  it('a missing variable named like an inherited property is still missing', async () => {
    const d: WorkflowDefinition = { start: 'a', variables: ['constructor'] as never, nodes: { a: { type: 'speak', speech: 'hybrid', text: 'Balance {{constructor}}' } } };
    const r = await start('d', {}, depsFor({ d }));
    expect(said(r.records)).toEqual([]);
    expect(r.state.outcome).toBe('error');
    const ex: WorkflowDefinition = { start: 'a', nodes: { a: { type: 'speak', speech: 'fixed', text: 'x', transitions: [{ when: { var: 'constructor', op: 'exists' } as never, to: 'b' }] }, b: { type: 'end', outcome: 'wrongly_set' } } };
    expect((await start('ex', {}, depsFor({ ex }))).state.outcome).toBe('completed');
  });
  it('a path into an integration reply does not reach inherited properties, and a reply cannot change the call\'s variables\' prototype', async () => {
    const d: WorkflowDefinition = { start: 'a', nodes: { a: { type: 'api', integration: 'x', path: '/p', store: { got: 'constructor', other: 'data.__proto__' }, transitions: [{ to: 'e' }] }, e: { type: 'end', outcome: 'ok' } } };
    const r = await start('d', {}, depsFor({ d }, { integrations: { call: async () => JSON.parse('{"data":{"__proto__":{"polluted":"yes"}}}') as Json } }));
    expect('got' in r.state.vars).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(r.state.vars)).toBe(Object.prototype);
  });
});

describe('phone numbers nested in values', () => {
  it('are refused in the starting record, however deep, and in the local form', () => {
    expect(() => checkVars({ a: { b: ['x', { phone: '+60123456789' }] } })).toThrow(PhoneInVariable);
    expect(() => checkVars({ contact: '0123456789' })).toThrow(PhoneInVariable);
    expect(() => checkVars({ contact: '012-345 6789' })).toThrow(PhoneInVariable);
    expect(() => checkVars({ balance: '1250.50', ref: 'INV-20260101', year: 2026, amount: '12,500.00', code: '12345' })).not.toThrow();
  });
  it('are refused in what an integration returns, nested or not', async () => {
    const d: WorkflowDefinition = { start: 'a', nodes: { a: { type: 'api', integration: 'x', path: '/p', store: { cust: 'data' }, transitions: [{ to: 'e' }] }, e: { type: 'end', outcome: 'ok' } } };
    for (const reply of [{ data: { phone: '+60123456789' } }, { data: ['0123456789'] }, { data: { a: { b: '+60 12-345 6789' } } }]) {
      const r = await start('d', {}, depsFor({ d }, { integrations: { call: async () => reply as Json } }));
      expect(JSON.stringify(r.state)).not.toMatch(/123456789|345 6789/);
      expect(r.state.outcome).toBe('integration_failed');
    }
  });
});

describe('limits', () => {
  it('stop an integration loop after a handful of calls, not hundreds', async () => {
    const d: WorkflowDefinition = { start: 'a', nodes: { a: { type: 'api', integration: 'x', path: '/p', onError: 'a' } } };
    let calls = 0;
    const r = await start('d', {}, depsFor({ d }, { integrations: { call: async () => { calls++; throw new Error('down'); } } }));
    expect(calls).toBeLessThanOrEqual(20);
    expect(r.state.outcome).toBe('error');
  });
  it('count steps per request, so a long honest conversation is not cut off', async () => {
    const lines: Record<string, any> = {}; for (let i = 0; i < 150; i++) lines[`n${i}`] = { type: 'speak', speech: 'fixed', text: `line ${i}`, listen: { captureAs: `r${i}` }, transitions: [{ to: i === 149 ? 'end' : `n${i + 1}` }] };
    const d = { start: 'n0', nodes: { ...lines, end: { type: 'end', outcome: 'long' } } } as WorkflowDefinition;
    const deps = depsFor({ d }, { maxSteps: 40 });
    let { state } = await start('d', {}, deps);
    for (let i = 0; i < 150 && state.status === 'awaiting_reply'; i++) state = (await reply(state, 'ok', deps)).state;
    expect(state.outcome).toBe('long'); // 150 turns, though no single request did more than a couple of steps
  });
});

describe('smaller gaps', () => {
  it('text must be a string or a string per language, not a list', () => {
    const d = (text: unknown) => ({ start: 'a', nodes: { a: { type: 'speak', speech: 'fixed', text } } });
    expect(codes(d(['Hello']))).toContain('bad_text');
    expect(codes(d({ en: 'Hi', ms: 5 }))).toContain('bad_text');
    expect(codes(d(null))).toContain('bad_text');
    expect(codes(d('Hello'))).toEqual([]);
  });
  it('refuses the old site-local IPv6 range and IPv4-compatible addresses', () => {
    for (const ip of ['fec0::1', '::7f00:1', '::10.0.0.1']) expect(isPublicAddress(ip), ip).toBe(false);
  });
});
