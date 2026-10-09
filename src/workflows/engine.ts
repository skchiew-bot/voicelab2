import { redactNumbers } from '../telephony/types.js';
import { evalCondition, type Vars } from './conditions.js';
import type { ApiNode, Json, SpeakNode, WorkflowDefinition, WorkflowNode } from './definition.js';
import { interpretReply } from './interpret.js';
import { MissingVariable, pickText, renderText } from './render.js';

/**
 * The state of one call through a workflow. It is plain data (it survives JSON), so a call can wait for the
 * caller's reply and be resumed later, or be run against a script with no telephone at all.
 */
export interface RunState {
  workflow: string;
  node: string | null;
  vars: Vars;
  /** Where to come back to when a subflow finishes: the subflow node in the parent. */
  stack: { workflow: string; node: string }[];
  status: 'running' | 'awaiting_reply' | 'ended';
  outcome?: string;
  error?: string;
  awaiting?: { node: string; captureAs: string; intents?: Record<string, string[]>; sensitive?: boolean };
  /** Variables to wipe when the call ends: never recorded, never kept longer than the call. */
  sensitive: string[];
  steps: number;
}

export interface StepRecord { type: string; workflow: string; node?: string; payload: Record<string, Json> }

export interface IntegrationCall { method: 'GET' | 'POST'; path: string; body?: Json }
export interface Deps {
  /** The workflow definitions this call is pinned to, by name. */
  load(workflow: string): WorkflowDefinition | undefined;
  integrations?: { call(name: string, req: IntegrationCall): Promise<Json> };
  /** Writes a dynamic node's line. Without one, a dynamic node speaks its fallback text. */
  speaker?: { generate(node: SpeakNode, vars: Vars, lang: string | undefined): Promise<string> };
  maxSteps?: number;
  maxDepth?: number;
}

export const DEFAULT_MAX_STEPS = 200;
export const DEFAULT_MAX_DEPTH = 8;

const E164 = /^\+[1-9]\d{7,14}$/;
export class PhoneInVariable extends Error {
  constructor(public variable: string) { super(`"${variable}" looks like a phone number. Phone numbers are never kept in a call's variables.`); }
}

/** Reject a variable value that is a phone number: customers' numbers are not stored anywhere. */
export function checkVars(vars: Vars): void {
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === 'string' && E164.test(v.replace(/[\s().-]/g, ''))) throw new PhoneInVariable(k);
  }
}

/** A finished call keeps none of its sensitive variables. */
function scrub(state: RunState): void { for (const name of state.sensitive) delete state.vars[name]; }

const addSensitive = (state: RunState, names: string[] | undefined) => { for (const n of names ?? []) if (!state.sensitive.includes(n)) state.sensitive.push(n); };

function fail(state: RunState, out: StepRecord[], message: string, node?: string): void {
  state.status = 'ended'; state.outcome = 'error'; state.error = message; state.node = null; state.awaiting = undefined; scrub(state);
  out.push({ type: 'error', workflow: state.workflow, node, payload: { message } });
}

function route(node: WorkflowNode, vars: Vars): string | null {
  const ts = (node as { transitions?: { when?: Parameters<typeof evalCondition>[0]; to: string }[] }).transitions ?? [];
  for (const t of ts) if (t.when === undefined || evalCondition(t.when, vars)) return t.to;
  return null; // nothing matched: the call ends cleanly
}

function dig(v: Json, path: string): Json | undefined {
  let cur: Json | undefined = v;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !(part in cur)) return undefined;
    cur = (cur as Record<string, Json>)[part];
  }
  return cur;
}

const renderJson = (v: Json, vars: Vars): Json =>
  typeof v === 'string' ? renderText(v, vars)
  : Array.isArray(v) ? v.map((x) => renderJson(x, vars))
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderJson(x, vars)])) : v;

/** Start a call at a workflow's first node and run until it needs the caller or finishes. */
export async function start(workflow: string, vars: Vars, deps: Deps): Promise<{ state: RunState; records: StepRecord[] }> {
  checkVars(vars);
  const def = deps.load(workflow);
  const state: RunState = { workflow, node: null, vars: { ...vars }, stack: [], status: 'running', steps: 0, sensitive: [...(def?.sensitiveVariables ?? [])] };
  const records: StepRecord[] = [];
  if (!def) { fail(state, records, `The workflow "${workflow}" is not available.`); return { state, records }; }
  state.node = def.start;
  records.push({ type: 'start', workflow, payload: {} });
  await advance(state, deps, records);
  return { state, records };
}

/** The caller said something: keep it, work out what they meant, and carry on. */
export async function reply(state: RunState, text: string, deps: Deps): Promise<{ state: RunState; records: StepRecord[] }> {
  if (state.status !== 'awaiting_reply' || !state.awaiting) throw new Error('This call is not waiting for a reply.');
  const next: RunState = structuredClone(state);
  const records: StepRecord[] = [];
  const { node, captureAs, intents, sensitive } = next.awaiting!;
  // What was said can contain a number; it is kept without it. A sensitive answer is not recorded at all.
  const heard = sensitive ? text : redactNumbers(text);
  next.vars[captureAs] = heard;
  if (sensitive) addSensitive(next, [captureAs]);
  const payload: Record<string, Json> = { text: sensitive ? '[hidden]' : heard };
  if (intents) { const intent = interpretReply(text, intents); next.vars[`${captureAs}_intent`] = intent; payload.intent = intent; }
  records.push({ type: 'heard', workflow: next.workflow, node, payload });
  next.awaiting = undefined; next.status = 'running';
  const def = deps.load(next.workflow);
  const n = def?.nodes[node];
  if (!n) { fail(next, records, `The node "${node}" is no longer available.`, node); return { state: next, records }; }
  next.node = route(n, next.vars);
  // A sensitive answer has done its job once the route is chosen: it is forgotten now, not at the end of the call.
  if (sensitive) { delete next.vars[captureAs]; delete next.vars[`${captureAs}_intent`]; }
  if (next.node === null) leave(next, records, 'completed', deps);
  await advance(next, deps, records);
  return { state: next, records };
}

/** The current workflow ended cleanly (or by an end node): finish the call, or return to the parent of a subflow. */
function leave(state: RunState, out: StepRecord[], outcome: string, deps: Deps): void {
  const frame = state.stack.pop();
  if (!frame) { state.status = 'ended'; state.outcome = outcome; state.node = null; scrub(state); out.push({ type: 'end', workflow: state.workflow, payload: { outcome } }); return; }
  out.push({ type: 'subflow_exit', workflow: state.workflow, node: frame.node, payload: { outcome } });
  state.vars[`${frame.node}_outcome`] = outcome;
  state.workflow = frame.workflow;
  const parent = deps.load(frame.workflow)?.nodes[frame.node];
  state.node = parent ? route(parent, state.vars) : null;
  if (state.node === null) leave(state, out, 'completed', deps);
}

async function advance(state: RunState, deps: Deps, out: StepRecord[]): Promise<void> {
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  while (state.status === 'running' && state.node !== null) {
    if (++state.steps > maxSteps) { fail(state, out, `The call went through more than ${maxSteps} steps, so it was stopped (a loop with no way out?).`, state.node); return; }
    const def = deps.load(state.workflow);
    const id = state.node;
    const node = def?.nodes[id];
    if (!def || !node) { fail(state, out, `The node "${id}" in "${state.workflow}" is not available.`, id); return; }
    const wf = state.workflow;

    switch (node.type) {
      case 'speak': {
        const lang = typeof state.vars.lang === 'string' ? state.vars.lang : undefined;
        let line: string | undefined;
        try {
          if (node.speech === 'dynamic') {
            const fallback = node.text !== undefined ? pickText(node.text, lang) : undefined;
            if (deps.speaker) line = await deps.speaker.generate(node, state.vars, lang);
            else if (fallback !== undefined) line = renderText(fallback, state.vars);
            else { fail(state, out, `"${id}" is dynamic and has no fallback text, and no model is connected to write its line.`, id); return; }
          } else line = renderText(pickText(node.text ?? '', lang) ?? '', state.vars);
        } catch (e) {
          if (e instanceof MissingVariable) { fail(state, out, `"${id}" needs the variable "${e.variable}", which is not set. Nothing was said.`, id); return; }
          fail(state, out, `Could not write the line for "${id}": ${redactNumbers((e as Error).message)}`, id); return;
        }
        out.push({ type: 'say', workflow: wf, node: id, payload: { strategy: node.speech, text: line!, ...(lang ? { lang } : {}) } });
        if (node.listen) {
          state.status = 'awaiting_reply';
          state.awaiting = { node: id, captureAs: node.listen.captureAs, intents: node.listen.intents, sensitive: node.listen.sensitive };
          return;
        }
        state.node = route(node, state.vars);
        if (state.node === null) leave(state, out, 'completed', deps);
        break;
      }
      case 'api': {
        if (!deps.integrations) { fail(state, out, `"${id}" calls an integration, but none are connected.`, id); return; }
        const outcome = await runApi(node, state, deps);
        if (outcome.ok) {
          out.push({ type: 'api', workflow: wf, node: id, payload: { integration: node.integration, stored: outcome.stored } });
          state.node = route(node, state.vars);
          if (state.node === null) leave(state, out, 'completed', deps);
        } else {
          out.push({ type: 'api_error', workflow: wf, node: id, payload: { integration: node.integration, reason: outcome.reason } });
          if (node.onError) state.node = node.onError;
          else { state.status = 'ended'; state.outcome = 'integration_failed'; state.error = outcome.reason; state.node = null; scrub(state); out.push({ type: 'end', workflow: wf, payload: { outcome: 'integration_failed' } }); }
        }
        break;
      }
      case 'subflow': {
        const child = deps.load(node.workflow);
        if (!child) { fail(state, out, `The workflow "${node.workflow}" (subflow "${id}") is not available.`, id); return; }
        if (state.stack.length >= (deps.maxDepth ?? DEFAULT_MAX_DEPTH)) { fail(state, out, 'Subflows are nested too deeply.', id); return; }
        out.push({ type: 'subflow_enter', workflow: wf, node: id, payload: { workflow: node.workflow } });
        state.stack.push({ workflow: wf, node: id });
        addSensitive(state, child.sensitiveVariables);
        state.workflow = node.workflow; state.node = child.start;
        break;
      }
      case 'handoff': {
        if ('human' in node.target) {
          out.push({ type: 'handoff_human', workflow: wf, node: id, payload: { reason: node.target.human.reason } });
          state.status = 'ended'; state.outcome = 'handoff_human'; state.node = null; state.stack = []; scrub(state);
          out.push({ type: 'end', workflow: wf, payload: { outcome: 'handoff_human', reason: node.target.human.reason } });
          return;
        }
        const target = deps.load(node.target.workflow);
        if (!target) { fail(state, out, `The workflow "${node.target.workflow}" (handoff "${id}") is not available.`, id); return; }
        // Control does not come back: the call, with all its variables, continues in the other workflow.
        out.push({ type: 'handoff', workflow: wf, node: id, payload: { to: node.target.workflow, carried: Object.keys(state.vars).sort() } });
        state.stack = []; addSensitive(state, target.sensitiveVariables); state.workflow = node.target.workflow; state.node = target.start;
        break;
      }
      case 'end':
        out.push({ type: 'reached_end', workflow: wf, node: id, payload: { outcome: node.outcome } });
        leave(state, out, node.outcome, deps);
        break;
    }
  }
}

async function runApi(node: ApiNode, state: RunState, deps: Deps): Promise<{ ok: true; stored: string[] } | { ok: false; reason: string }> {
  let req: IntegrationCall;
  try {
    // Values go into the path URL-encoded, so a caller's words cannot change which endpoint is called.
    const path = node.path.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_m, name: string) => {
      const v = state.vars[name];
      if (v === undefined || v === null || v === '') throw new MissingVariable(name);
      return encodeURIComponent(String(v));
    });
    req = { method: node.method ?? 'GET', path, body: node.body === undefined ? undefined : renderJson(node.body as Json, state.vars) };
  } catch (e) {
    return { ok: false, reason: e instanceof MissingVariable ? `needs the variable "${e.variable}", which is not set` : 'could not build the request' };
  }
  let result: Json;
  try { result = await deps.integrations!.call(node.integration, req); }
  catch (e) { return { ok: false, reason: redactNumbers((e as Error).message).slice(0, 300) }; }
  const stored: string[] = [];
  for (const [name, path] of Object.entries(node.store ?? {})) {
    const v = dig(result, path);
    if (v === undefined) continue; // left unset: anything that needs it fails closed later
    if (typeof v === 'string' && E164.test(v.replace(/[\s().-]/g, ''))) return { ok: false, reason: `the reply put a phone number in "${name}", which is never kept` };
    state.vars[name] = v; stored.push(name);
  }
  return { ok: true, stored };
}
