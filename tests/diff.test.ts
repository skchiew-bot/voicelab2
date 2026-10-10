import { describe, expect, it } from 'vitest';
import { diffDefinitions } from '../src/journey/diff.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';

const v1: WorkflowDefinition = {
  start: 'ask', variables: ['name'],
  nodes: {
    ask: { type: 'speak', speech: 'hybrid', text: 'Hello {{name}}, can you pay this week?', listen: { captureAs: 'a', intents: { yes: ['yes'] } }, transitions: [{ to: 'thanks' }] },
    thanks: { type: 'speak', speech: 'fixed', text: 'Thank you.', transitions: [{ to: 'done' }] },
    done: { type: 'end', outcome: 'ok' },
  },
};

describe('what changed between two versions', () => {
  it('says nothing changed for the same definition', () => {
    const d = diffDefinitions(v1, structuredClone(v1));
    expect(d).toMatchObject({ shape: 'none', nodes: [], summary: [], lines: [], start: null, intentRoutes: null });
  });
  it('reports a change of wording alone as a minor change, with the old and new words', () => {
    const v2 = structuredClone(v1); (v2.nodes.ask as { text: string }).text = 'Hello {{name}}, could you pay by Friday?';
    const d = diffDefinitions(v1, v2);
    expect(d.shape).toBe('minor');
    expect(d.nodes).toEqual([{ id: 'ask', kind: 'changed', type: 'speak', fields: [{ field: 'text', before: 'Hello {{name}}, can you pay this week?', after: 'Hello {{name}}, could you pay by Friday?' }] }]);
    expect(d.summary).toEqual(['Changed the wording at "ask": “Hello {{name}}, can you pay this week?” is now “Hello {{name}}, could you pay by Friday?”.']);
    expect(d.lines).toEqual([{ op: '~', node: 'ask', text: 'wording: Hello {{name}}, can you pay this week? → Hello {{name}}, could you pay by Friday?' }]);
  });
  it('reports added and removed steps, and where the call now goes, as a change of shape', () => {
    const v2: WorkflowDefinition = { ...structuredClone(v1), nodes: { ...structuredClone(v1).nodes, offer: { type: 'speak', speech: 'fixed', text: 'We can offer a plan.', transitions: [{ to: 'done' }] } } };
    (v2.nodes.ask as { transitions: { to: string }[] }).transitions = [{ to: 'offer' }];
    delete (v2.nodes as Record<string, unknown>).thanks;
    const d = diffDefinitions(v1, v2);
    expect(d.shape).toBe('major');
    expect(d.nodes.map((n) => `${n.kind}:${n.id}`).sort()).toEqual(['added:offer', 'changed:ask', 'removed:thanks']);
    expect(d.summary).toContain('Added the speak step "offer": “We can offer a plan.”.');
    expect(d.summary).toContain('Removed the speak step "thanks".');
    expect(d.summary).toContain('"ask" used to go to thanks; it now goes to offer.');
    expect(d.lines.map((l) => l.op).sort()).toEqual(['+', '-', '~']);
  });
  it('reports a new start, new needs, and changed intent routes', () => {
    const v2: WorkflowDefinition = { ...structuredClone(v1), start: 'thanks', variables: ['name', 'balance'], intentRoutes: [{ when: { kind: 'complaint' }, to: 'done' }] };
    const d = diffDefinitions(v1, v2);
    expect(d.start).toEqual({ before: 'ask', after: 'thanks' });
    expect(d.variables).toEqual({ added: ['balance'], removed: [] });
    expect(d.intentRoutes).not.toBeNull();
    expect(d.summary[0]).toBe('The call now starts at "thanks" instead of "ask".');
  });
  it('treats a first version as all new', () => {
    const d = diffDefinitions(null, v1);
    expect(d.shape).toBe('major');
    expect(d.nodes.every((n) => n.kind === 'added')).toBe(true);
  });
  it('does not mistake an inherited name for a node', () => {
    const v2 = structuredClone(v1); (v2.nodes as Record<string, unknown>).toString2 = { type: 'end', outcome: 'x' };
    expect(diffDefinitions(v1, v2).nodes.map((n) => n.id)).toEqual(['toString2']);
  });
});
