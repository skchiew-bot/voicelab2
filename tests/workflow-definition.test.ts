import { describe, expect, it } from 'vitest';
import { conditionVars, evalCondition } from '../src/workflows/conditions.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';
import { interpretReply } from '../src/workflows/interpret.js';
import { MissingVariable, pickText, renderText } from '../src/workflows/render.js';
import { validateDefinition } from '../src/workflows/validate.js';
import { canonical, classifyChange, nextVersion, versionLabel } from '../src/workflows/versioning.js';

/** A small valid workflow to break in specific ways. */
const base = (): WorkflowDefinition => ({
  start: 'hello',
  variables: ['name'],
  nodes: {
    hello: { type: 'speak', speech: 'hybrid', text: 'Hello {{name}}. Can you talk?', listen: { captureAs: 'answer', intents: { yes: ['yes'], no: ['no'] } },
      transitions: [{ when: { var: 'answer_intent', op: 'eq', value: 'yes' }, to: 'thanks' }, { to: 'bye' }] },
    thanks: { type: 'speak', speech: 'fixed', text: 'Thank you.', transitions: [{ to: 'done' }] },
    bye: { type: 'speak', speech: 'fixed', text: 'Goodbye.' },
    done: { type: 'end', outcome: 'completed' },
  },
});
const codes = (d: unknown) => validateDefinition(d).errors.map((e) => e.code);
const mutate = (f: (d: any) => void) => { const d = base() as any; f(d); return d; };

describe('the validator: dangling paths cannot be published', () => {
  it('accepts a sound workflow', () => {
    expect(validateDefinition(base())).toEqual({ errors: [], warnings: [] });
  });

  it('rejects a transition to a node that does not exist, and says which node and where it goes', () => {
    const r = validateDefinition(mutate((d) => { d.nodes.hello.transitions[1].to = 'nowhere'; }));
    expect(r.errors).toContainEqual(expect.objectContaining({ code: 'unknown_target', nodeId: 'hello', message: expect.stringContaining('nowhere') }));
  });

  it('rejects a node nothing leads to', () => {
    const r = validateDefinition(mutate((d) => { d.nodes.island = { type: 'end', outcome: 'x' }; }));
    expect(r.errors).toContainEqual(expect.objectContaining({ code: 'unreachable_node', nodeId: 'island' }));
  });

  it('rejects a missing or unknown start', () => {
    expect(codes(mutate((d) => { delete d.start; }))).toContain('bad_start');
    expect(codes(mutate((d) => { d.start = 'ghost'; }))).toContain('bad_start');
  });

  it('treats an api onError route as a path too', () => {
    const d = mutate((x) => { x.nodes.look = { type: 'api', integration: 'status', path: '/s', onError: 'missing' }; x.nodes.hello.transitions.push({ to: 'look' }); });
    expect(codes(d)).toContain('unknown_target');
  });

  it('allows a loop (a retry) and a node with no transitions, which ends the call cleanly', () => {
    // "thanks" can loop back to "hello" (a retry) as long as there is still a way out.
    const d = mutate((x) => { x.nodes.thanks.transitions = [{ when: { var: 'name', op: 'eq', value: 'stop' }, to: 'done' }, { to: 'hello' }]; });
    expect(validateDefinition(d).errors).toEqual([]);
    // Without a way out, the end node becomes unreachable, and that is reported.
    expect(codes(mutate((x) => { x.nodes.thanks.transitions = [{ to: 'hello' }]; }))).toContain('unreachable_node');
  });
});

describe('the validator: speech', () => {
  it('keeps fixed, hybrid and dynamic honest', () => {
    expect(codes(mutate((d) => { d.nodes.thanks.text = 'Thanks {{name}}'; }))).toContain('fixed_has_slots');
    expect(codes(mutate((d) => { d.nodes.hello.text = 'Hello there'; }))).toContain('hybrid_no_slots');
    expect(codes(mutate((d) => { d.nodes.thanks = { type: 'speak', speech: 'dynamic', transitions: [{ to: 'done' }] }; }))).toContain('dynamic_needs_prompt');
    expect(codes(mutate((d) => { delete d.nodes.thanks.text; }))).toContain('missing_text');
    const dyn = validateDefinition(mutate((d) => { d.nodes.thanks = { type: 'speak', speech: 'dynamic', prompt: 'Thank them.', transitions: [{ to: 'done' }] }; }));
    expect(dyn.errors).toEqual([]);
    expect(dyn.warnings.map((w) => w.code)).toContain('dynamic_no_fallback');
  });

  it('needs English as the fallback in a language map, and warns about missing translations', () => {
    expect(codes(mutate((d) => { d.nodes.thanks.text = { ms: 'Terima kasih.' }; }))).toContain('text_needs_english');
    const r = validateDefinition(mutate((d) => { d.languages = ['en', 'ms']; d.nodes.thanks.text = { en: 'Thank you.' }; }));
    expect(r.errors).toEqual([]);
    expect(r.warnings).toContainEqual(expect.objectContaining({ code: 'missing_translation', nodeId: 'thanks' }));
  });

  it('refuses a variable that is used but never set', () => {
    const r = validateDefinition(mutate((d) => { d.nodes.thanks = { type: 'speak', speech: 'hybrid', text: 'Your balance is {{balance}}.', transitions: [{ to: 'done' }] }; }));
    expect(r.errors).toContainEqual(expect.objectContaining({ code: 'unknown_variable', nodeId: 'thanks', message: expect.stringContaining('balance') }));
  });

  it('accepts variables captured earlier, stored from an api, exported by a subflow, or built in', () => {
    const d = mutate((x) => {
      x.nodes.look = { type: 'api', integration: 'status', path: '/s/{{name}}', store: { balance: 'data.balance' }, transitions: [{ to: 'sub' }] };
      x.nodes.sub = { type: 'subflow', workflow: 'verify', exports: ['verified_name'], transitions: [{ when: { var: 'sub_outcome', op: 'eq', value: 'ok' }, to: 'tell' }] };
      x.nodes.tell = { type: 'speak', speech: 'hybrid', text: 'RM {{balance}} for {{verified_name}} ({{lang}})', transitions: [{ to: 'done' }] };
      x.nodes.thanks.transitions = [{ to: 'look' }];
    });
    expect(validateDefinition(d).errors).toEqual([]);
  });
});

describe('the validator: conditions and other nodes', () => {
  it('rejects malformed conditions', () => {
    const bad = (when: unknown) => codes(mutate((d) => { d.nodes.hello.transitions[0].when = when; }));
    expect(bad({ var: 'answer_intent', op: 'matches', value: 'x' })).toContain('bad_condition');
    expect(bad({ var: 'answer_intent', op: 'eq' })).toContain('bad_condition');
    expect(bad({ all: [] })).toContain('bad_condition');
    expect(bad({ var: 'answer_intent', op: 'in', value: 'yes' })).toContain('bad_condition');
    expect(bad({ all: [{ var: 'answer_intent', op: 'eq', value: 'a' }], any: [] })).toContain('bad_condition');
    expect(bad('yes')).toContain('bad_condition');
  });

  it('checks api, subflow, handoff and end nodes', () => {
    expect(codes(mutate((d) => { d.nodes.look = { type: 'api', integration: 'status', path: 'no-slash' }; d.nodes.hello.transitions.push({ to: 'look' }); }))).toContain('bad_path');
    expect(codes(mutate((d) => { d.nodes.look = { type: 'api', integration: 'status', path: '/a/../b' }; d.nodes.hello.transitions.push({ to: 'look' }); }))).toContain('bad_path');
    expect(codes(mutate((d) => { d.nodes.sub = { type: 'subflow', workflow: '' }; d.nodes.hello.transitions.push({ to: 'sub' }); }))).toContain('bad_workflow');
    expect(codes(mutate((d) => { d.nodes.h = { type: 'handoff', target: {} }; d.nodes.hello.transitions.push({ to: 'h' }); }))).toContain('bad_handoff');
    expect(codes(mutate((d) => { d.nodes.done.outcome = ''; }))).toContain('missing_outcome');
    expect(codes(mutate((d) => { d.nodes.done.transitions = [{ to: 'hello' }]; }))).toContain('terminal_has_transitions');
    expect(codes(mutate((d) => { d.nodes.hello.type = 'dial'; }))).toContain('unknown_node_type');
  });

  it('warns about a transition that can never be taken', () => {
    const r = validateDefinition(mutate((d) => { d.nodes.hello.transitions = [{ to: 'bye' }, { to: 'thanks' }]; }));
    expect(r.warnings.map((w) => w.code)).toContain('transition_never_reached');
  });

  it('refuses nonsense input without throwing', () => {
    for (const bad of [null, 42, 'x', [], {}, { nodes: {} }, { start: 'a', nodes: [] }]) expect(() => validateDefinition(bad)).not.toThrow();
    expect(codes(null)).toContain('not_object');
    expect(codes({ nodes: {} })).toContain('no_nodes');
  });

  it('enforces size limits', () => {
    const many: any = { start: 'n0', nodes: {} };
    for (let i = 0; i < 501; i++) many.nodes[`n${i}`] = { type: 'end', outcome: 'x' };
    expect(codes(many)).toContain('too_many_nodes');
    expect(codes(mutate((d) => { d.nodes.thanks.text = 'x'.repeat(2001); }))).toContain('text_too_long');
    expect(codes(mutate((d) => { d.nodes.thanks.text = 'x'.repeat(300_000); }))).toContain('too_big');
  });
});

describe('conditions', () => {
  const v = { balance: '1250.50', name: 'Aisha', tags: ['a', 'b'], a: 5, empty: '' };
  it('compares numbers and text sensibly', () => {
    expect(evalCondition({ var: 'balance', op: 'gt', value: 1000 }, v)).toBe(true);
    expect(evalCondition({ var: 'balance', op: 'lte', value: 1250.5 }, v)).toBe(true);
    expect(evalCondition({ var: 'a', op: 'eq', value: '5' }, v)).toBe(true);
    expect(evalCondition({ var: 'name', op: 'eq', value: 'Aisha' }, v)).toBe(true);
    expect(evalCondition({ var: 'name', op: 'ne', value: 'Aisha' }, v)).toBe(false);
    expect(evalCondition({ var: 'name', op: 'contains', value: 'ISH' }, v)).toBe(true);
    expect(evalCondition({ var: 'tags', op: 'contains', value: 'b' }, v)).toBe(true);
    expect(evalCondition({ var: 'name', op: 'in', value: ['Aisha', 'Wei'] }, v)).toBe(true);
    expect(evalCondition({ var: 'name', op: 'eq', valueVar: 'name' }, v)).toBe(true);
  });
  it('treats a variable that is not set as "false", never as an error or a match', () => {
    for (const op of ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in'] as const) expect(evalCondition({ var: 'ghost', op, value: 1 }, v), op).toBe(false);
    expect(evalCondition({ var: 'ghost', op: 'exists' }, v)).toBe(false);
    expect(evalCondition({ var: 'empty', op: 'exists' }, v)).toBe(false);
    expect(evalCondition({ var: 'name', op: 'gt', value: 3 }, v)).toBe(false); // text is not a number
  });
  it('combines with all, any and not, and reports the variables it reads', () => {
    const c = { all: [{ var: 'a', op: 'gt', value: 1 }, { not: { var: 'name', op: 'eq', value: 'Wei' } }, { any: [{ var: 'ghost', op: 'exists' }, { var: 'balance', op: 'exists' }] }] } as const;
    expect(evalCondition(c as never, v)).toBe(true);
    expect([...conditionVars(c as never)].sort()).toEqual(['a', 'balance', 'ghost', 'name']);
  });
});

describe('text', () => {
  it('fills slots and picks a language, falling back to English', () => {
    expect(renderText('Hi {{ name }}, RM {{balance}}', { name: 'Aisha', balance: '10.00' })).toBe('Hi Aisha, RM 10.00');
    expect(pickText({ en: 'Hello', ms: 'Helo' }, 'ms')).toBe('Helo');
    expect(pickText({ en: 'Hello', ms: 'Helo' }, 'ta')).toBe('Hello');
    expect(pickText('Plain', 'ms')).toBe('Plain');
  });
  it('refuses to speak a missing variable instead of saying a gap', () => {
    expect(() => renderText('Hi {{name}}', {})).toThrow(MissingVariable);
    expect(() => renderText('Hi {{name}}', { name: '' })).toThrow(MissingVariable);
  });
});

describe('what a caller meant', () => {
  const intents = { yes: ['yes', 'ya', 'betul'], no: ['no', 'tidak'] };
  it('matches whole phrases only, in any case', () => {
    expect(interpretReply('Yes, that is me', intents)).toBe('yes');
    expect(interpretReply('BETUL', intents)).toBe('yes');
    expect(interpretReply('I know him', intents)).toBe('unknown'); // "no" is not inside "know"
    expect(interpretReply('yaya', intents)).toBe('unknown');
    expect(interpretReply('Tidak, salah orang', intents)).toBe('no');
  });
  it('does not read a negated phrase as the plain one inside it', () => {
    const pay = { yes: ['yes', 'boleh', 'can'], cannot: ['tidak boleh', "can't", 'cannot'] };
    expect(interpretReply('Tidak boleh', pay)).toBe('cannot');   // not also "boleh"
    expect(interpretReply("I can't pay", pay)).toBe('cannot');   // not also "can"
    expect(interpretReply('boleh, saya boleh bayar', pay)).toBe('yes');
    expect(interpretReply('yes I can', pay)).toBe('yes');
    expect(interpretReply('boleh tetapi tidak boleh hari ini', pay)).toBe('ambiguous'); // both really are said
  });
  it('says so when it cannot tell, rather than guessing', () => {
    expect(interpretReply('yes and no', intents)).toBe('ambiguous');
    expect(interpretReply('mmm', intents)).toBe('unknown');
    expect(interpretReply('', intents)).toBe('unknown');
  });
});

describe('versions: an edit inside a node is minor, a change of shape is major', () => {
  const edit = (f: (d: any) => void) => { const d = structuredClone(base()) as any; f(d); return d as WorkflowDefinition; };
  it('treats identical definitions as no change, whatever the key order', () => {
    const reordered = JSON.parse(JSON.stringify({ nodes: base().nodes, variables: base().variables, start: base().start }));
    expect(classifyChange(base(), reordered)).toBe('none');
    expect(canonical({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonical({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });
  it('calls a wording, prompt, phrase or outcome change minor', () => {
    expect(classifyChange(base(), edit((d) => { d.nodes.thanks.text = 'Thanks a lot.'; }))).toBe('minor');
    expect(classifyChange(base(), edit((d) => { d.nodes.hello.listen.intents.yes.push('okay'); }))).toBe('minor');
    expect(classifyChange(base(), edit((d) => { d.nodes.done.outcome = 'finished'; }))).toBe('minor');
    expect(classifyChange(base(), edit((d) => { d.nodes.hello.label = 'Greeting'; }))).toBe('minor');
  });
  it('calls a change to where the call can go major', () => {
    expect(classifyChange(base(), edit((d) => { d.nodes.hello.transitions[1].to = 'thanks'; }))).toBe('major');
    expect(classifyChange(base(), edit((d) => { d.nodes.hello.transitions[0].when.value = 'no'; }))).toBe('major'); // a routing condition is shape
    expect(classifyChange(base(), edit((d) => { d.nodes.extra = { type: 'end', outcome: 'x' }; }))).toBe('major');
    expect(classifyChange(base(), edit((d) => { delete d.nodes.bye; d.nodes.hello.transitions.pop(); }))).toBe('major');
    expect(classifyChange(base(), edit((d) => { d.nodes.bye = { type: 'end', outcome: 'x' }; }))).toBe('major'); // a node changes kind
    expect(classifyChange(base(), edit((d) => { d.start = 'thanks'; }))).toBe('major');
  });
  it('numbers versions 1.0, 1.1, 2.0', () => {
    let v = nextVersion(null, 'minor');
    expect(versionLabel(v)).toBe('1.0');
    v = nextVersion(v, 'minor'); expect(versionLabel(v)).toBe('1.1');
    v = nextVersion(v, 'minor'); expect(versionLabel(v)).toBe('1.2');
    v = nextVersion(v, 'major'); expect(versionLabel(v)).toBe('2.0');
    v = nextVersion(v, 'minor'); expect(versionLabel(v)).toBe('2.1');
  });
});
