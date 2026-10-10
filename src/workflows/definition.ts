/**
 * A workflow is a graph of nodes. Everything in it is plain data (JSON), so it can be stored, versioned,
 * diffed and simulated. Nothing in a definition is ever executed as code: conditions are a small fixed
 * language and text slots are plain substitution.
 */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | { var: string; op: Operator; value?: Json; valueVar?: string };

export const OPERATORS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'in', 'exists'] as const;
export type Operator = (typeof OPERATORS)[number];

/** The first transition whose condition holds is taken. No `when` means "always". If none holds, the call ends cleanly. */
export interface Transition { when?: Condition; to: string }

/** Text, or text per language. A language map must include "en", which is the fallback. */
export type LocalText = string | Record<string, string>;

/**
 * Wait for the caller to speak, store what they said as `captureAs`, and, if intents are listed, store the
 * intent as `<captureAs>_intent`. An intent is matched by phrases (rules first; a model can be added later).
 */
export interface Listen {
  captureAs: string; intents?: Record<string, string[]>;
  /** The answer is used to route the call and then forgotten: it is not recorded, and not kept after this step. */
  sensitive?: boolean;
}

interface Common { label?: string }

/**
 * fixed: pure text, no slots. hybrid: a frame with {{slots}} filled from variables.
 * dynamic: written at the moment by a model from `prompt`; `text` is the fallback line.
 */
export interface SpeakNode extends Common {
  type: 'speak'; speech: 'fixed' | 'hybrid' | 'dynamic'; text?: LocalText; prompt?: string; listen?: Listen; transitions?: Transition[];
}
/** Call an integration mid-call and keep parts of its answer: `store` maps a variable to a dotted path in the JSON reply. */
export interface ApiNode extends Common {
  type: 'api'; integration: string; method?: 'GET' | 'POST'; path: string; body?: Record<string, Json>;
  store?: Record<string, string>; onError?: string; transitions?: Transition[];
}
/** Run another workflow inside this one. It shares the same variables; `exports` lists those it sets that this one may use. */
export interface SubflowNode extends Common { type: 'subflow'; workflow: string; exports?: string[]; transitions?: Transition[] }
/** Hand the call, with every variable, to another workflow or to a person. Control does not come back. */
export interface HandoffNode extends Common { type: 'handoff'; target: { workflow: string } | { human: { reason: string } } }
export interface EndNode extends Common { type: 'end'; outcome: string }

export type WorkflowNode = SpeakNode | ApiNode | SubflowNode | HandoffNode | EndNode;

/** When the caller's kind of moment or topic changes to this, the call goes to this node instead of following the node's own transitions. */
export interface IntentRoute { when: { kind?: 'inquiry' | 'complaint' | 'request' | 'other'; topic?: string }; to: string }

export interface WorkflowDefinition {
  start: string;
  /** Re-routing on a change of intent, checked after each caller turn. The first that matches is taken. */
  intentRoutes?: IntentRoute[];
  /** Variables the caller of this workflow must supply (contact details, balances, and so on). */
  variables?: string[];
  /** Variables that must never be spoken, sent to an integration or recorded in steps, and are wiped when the call ends. */
  sensitiveVariables?: string[];
  /** Languages this workflow is written in. "en" is always the fallback. */
  languages?: string[];
  nodes: Record<string, WorkflowNode>;
}

export const LIMITS = { nodes: 500, textChars: 2000, definitionBytes: 256 * 1024, transitionsPerNode: 20 } as const;
export const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Names every object inherits. They are never nodes, variables or stored values: `vars["constructor"]` must not "exist". */
export const RESERVED_NAMES: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);
export const isName = (s: unknown): s is string => typeof s === 'string' && ID_RE.test(s) && !RESERVED_NAMES.has(s);
export const own = (o: object, k: string): boolean => Object.hasOwn(o, k);
export const SLOT_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
