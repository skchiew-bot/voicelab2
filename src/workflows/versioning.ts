import type { Json, WorkflowDefinition } from './definition.js';

/** JSON with keys in a fixed order, so equal definitions always produce equal text. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/**
 * The shape of a workflow: where it starts, which nodes there are, what kind each is, where each can go and under
 * which conditions, and which other workflows it reaches. Wording, prompts, phrases and API details are not shape.
 */
export function structureOf(def: WorkflowDefinition): Json {
  const nodes: Record<string, Json> = {};
  for (const [id, n] of Object.entries(def.nodes ?? {})) {
    const o = n as unknown as Record<string, unknown>;
    nodes[id] = {
      type: n.type,
      transitions: (o.transitions as Json) ?? [],
      onError: (o.onError as Json) ?? null,
      workflow: n.type === 'subflow' ? n.workflow : null,
      target: n.type === 'handoff' ? (n.target as unknown as Json) : null,
    };
  }
  return { start: def.start, nodes };
}

export type Change = 'none' | 'minor' | 'major';

/** No change, an edit inside nodes (minor), or a change to the shape (major). */
export function classifyChange(prev: WorkflowDefinition, next: WorkflowDefinition): Change {
  if (canonical(prev) === canonical(next)) return 'none';
  return canonical(structureOf(prev)) === canonical(structureOf(next)) ? 'minor' : 'major';
}

export interface VersionNumber { major: number; minor: number }
export function nextVersion(current: VersionNumber | null, change: Change): VersionNumber {
  if (!current) return { major: 1, minor: 0 };
  if (change === 'major') return { major: current.major + 1, minor: 0 };
  return { major: current.major, minor: current.minor + 1 };
}
export const versionLabel = (v: VersionNumber) => `${v.major}.${v.minor}`;
