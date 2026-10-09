import { conditionVars } from './conditions.js';
import {
  ID_RE, isName, LIMITS, OPERATORS, own, SLOT_RE, type Condition, type Json, type LocalText, type WorkflowDefinition, type WorkflowNode,
} from './definition.js';
import { isWorkflowName } from './refs.js';
import { slotsIn } from './render.js';

export interface Issue { code: string; nodeId?: string; message: string }
export interface ValidationResult { errors: Issue[]; warnings: Issue[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const BUILT_IN = new Set(['lang']);

function checkCondition(c: unknown, nodeId: string, add: (code: string, msg: string) => void, depth = 0): boolean {
  if (depth > 10) { add('bad_condition', 'A condition is nested too deeply.'); return false; }
  if (!isObj(c)) { add('bad_condition', 'A condition must be an object.'); return false; }
  const keys = ['all', 'any', 'not', 'var'].filter((k) => k in c);
  if (keys.length !== 1) { add('bad_condition', 'A condition must have exactly one of all, any, not or var.'); return false; }
  if ('all' in c || 'any' in c) {
    const list = (c.all ?? c.any) as unknown;
    if (!Array.isArray(list) || list.length === 0) { add('bad_condition', 'all and any need a non-empty list of conditions.'); return false; }
    return list.every((x) => checkCondition(x, nodeId, add, depth + 1));
  }
  if ('not' in c) return checkCondition(c.not, nodeId, add, depth + 1);
  if (!isName(c.var)) { add('bad_condition', 'A condition\'s var must be a variable name.'); return false; }
  if (!OPERATORS.includes(c.op as never)) { add('bad_condition', `"${String(c.op)}" is not a known operator (${OPERATORS.join(', ')}).`); return false; }
  if (c.op !== 'exists' && c.value === undefined && c.valueVar === undefined) { add('bad_condition', `The "${c.op}" operator needs a value or a valueVar.`); return false; }
  if (c.op === 'in' && c.valueVar === undefined && !Array.isArray(c.value)) { add('bad_condition', 'The "in" operator needs a list as its value.'); return false; }
  if (c.valueVar !== undefined && !isName(c.valueVar)) { add('bad_condition', 'valueVar must be a variable name.'); return false; }
  return true;
}

function stringsIn(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => stringsIn(x, out));
  else if (isObj(v)) Object.values(v).forEach((x) => stringsIn(x, out));
  return out;
}

const textsOf = (t: LocalText | undefined): string[] => (typeof t === 'string' ? [t] : isObj(t) ? (Object.values(t) as string[]) : []);

/**
 * Everything that can be decided from the definition alone. A definition with any error cannot be published.
 * Cross-workflow checks (does the target exist, does it get the variables it needs) happen at deploy time.
 */
export function validateDefinition(input: unknown): ValidationResult {
  const errors: Issue[] = []; const warnings: Issue[] = [];
  const err = (code: string, message: string, nodeId?: string) => errors.push({ code, message, nodeId });
  const warn = (code: string, message: string, nodeId?: string) => warnings.push({ code, message, nodeId });

  let size = 0;
  try { size = JSON.stringify(input)?.length ?? 0; } catch { err('not_json', 'The definition is not valid JSON data.'); return { errors, warnings }; }
  if (size > LIMITS.definitionBytes) { err('too_big', `The definition is larger than ${LIMITS.definitionBytes / 1024} KB.`); return { errors, warnings }; }
  if (!isObj(input)) { err('not_object', 'A workflow definition must be an object.'); return { errors, warnings }; }

  const def = input as Partial<WorkflowDefinition> & Record<string, unknown>;
  if (!isObj(def.nodes)) { err('no_nodes', 'A workflow needs a "nodes" object.'); return { errors, warnings }; }
  const ids = Object.keys(def.nodes);
  if (ids.length === 0) { err('no_nodes', 'A workflow needs at least one node.'); return { errors, warnings }; }
  if (ids.length > LIMITS.nodes) err('too_many_nodes', `A workflow can have at most ${LIMITS.nodes} nodes.`);
  const nodesProto = Object.getPrototypeOf(def.nodes);
  if (nodesProto !== Object.prototype && nodesProto !== null) err('bad_node_id', 'A node named __proto__ is not allowed.');
  if (typeof def.start !== 'string' || !own(def.nodes, def.start)) err('bad_start', 'The start must name a node that exists.');

  const declared = new Set<string>();
  if (def.variables !== undefined) {
    if (!Array.isArray(def.variables) || !def.variables.every((v) => isName(v))) err('bad_variables', '"variables" must be a list of variable names.');
    else def.variables.forEach((v) => declared.add(v));
  }
  const languages = Array.isArray(def.languages) ? def.languages.filter((l): l is string => typeof l === 'string') : [];

  const assigned = new Set<string>([...BUILT_IN, ...declared]);
  const used: { name: string; nodeId: string }[] = [];
  const spoken: { name: string; nodeId: string }[] = [];   // read out loud or fed to a model
  const sent: { name: string; nodeId: string }[] = [];     // sent to an integration
  const sensitive = new Set<string>();
  if (def.sensitiveVariables !== undefined) {
    if (!Array.isArray(def.sensitiveVariables) || !def.sensitiveVariables.every((v) => isName(v))) err('bad_sensitive', '"sensitiveVariables" must be a list of variable names.');
    else def.sensitiveVariables.forEach((v) => sensitive.add(v));
  }
  const edges = new Map<string, string[]>();

  for (const id of ids) {
    const raw = (def.nodes as Record<string, unknown>)[id];
    if (!isName(id)) err('bad_node_id', `"${id}" is not a valid node name (letters, digits and underscores, not starting with a digit).`, id);
    if (!isObj(raw) || typeof raw.type !== 'string') { err('bad_node', 'A node must be an object with a type.', id); continue; }
    const n = raw as unknown as WorkflowNode & Record<string, unknown>;
    const targets: string[] = [];
    const addUse = (name: string) => used.push({ name, nodeId: id });
    const addSpoken = (name: string) => { addUse(name); spoken.push({ name, nodeId: id }); };
    const addSent = (name: string) => { addUse(name); sent.push({ name, nodeId: id }); };
    const nodeErr = (code: string, msg: string) => err(code, msg, id);

    const terminal = n.type === 'end' || n.type === 'handoff';
    if (terminal && n.transitions !== undefined) nodeErr('terminal_has_transitions', `A ${n.type} node finishes the call or hands it over, so it cannot have transitions.`);
    if (!terminal && n.transitions !== undefined) {
      if (!Array.isArray(n.transitions)) nodeErr('bad_transitions', '"transitions" must be a list.');
      else {
        if (n.transitions.length > LIMITS.transitionsPerNode) nodeErr('too_many_transitions', `At most ${LIMITS.transitionsPerNode} transitions per node.`);
        n.transitions.forEach((t, i) => {
          if (!isObj(t) || typeof t.to !== 'string') { nodeErr('bad_transition', `Transition ${i + 1} needs a "to".`); return; }
          targets.push(t.to);
          if (t.when !== undefined) {
            if (checkCondition(t.when, id, (c, m) => nodeErr(c, m))) conditionVars(t.when as Condition).forEach(addUse);
          } else if (i < (n.transitions as unknown[]).length - 1) {
            warn('transition_never_reached', `Transition ${i + 1} has no condition, so the ones after it can never be taken.`, id);
          }
        });
      }
    }

    switch (n.type) {
      case 'speak': {
        if (!['fixed', 'hybrid', 'dynamic'].includes(n.speech as string)) { nodeErr('bad_speech', 'speech must be fixed, hybrid or dynamic.'); break; }
        const texts = textsOf(n.text as LocalText | undefined);
        if (isObj(n.text) && !('en' in n.text)) nodeErr('text_needs_english', 'Text in several languages must include "en", which is the fallback.');
        if (n.text !== undefined && (typeof n.text !== 'string' && !isObj(n.text) || texts.some((t) => typeof t !== 'string'))) nodeErr('bad_text', 'Text must be a string, or a string per language.');
        if (texts.some((t) => typeof t === 'string' && t.length > LIMITS.textChars)) nodeErr('text_too_long', `Text is limited to ${LIMITS.textChars} characters.`);
        if (n.speech === 'dynamic') {
          if (typeof n.prompt !== 'string' || !n.prompt.trim()) nodeErr('dynamic_needs_prompt', 'A dynamic node needs a prompt telling the model what to say.');
          else slotsIn(n.prompt).forEach(addSpoken);
          if (texts.length === 0) warn('dynamic_no_fallback', 'A dynamic node has no fallback text, so it cannot speak until a model is connected.', id);
        } else {
          if (texts.length === 0) nodeErr('missing_text', `A ${n.speech} node needs text.`);
          const withSlots = texts.filter((t) => typeof t === 'string' && slotsIn(t).length > 0).length;
          if (n.speech === 'fixed' && withSlots > 0) nodeErr('fixed_has_slots', 'A fixed node is pure text and cannot have {{slots}}. Make it hybrid.');
          if (n.speech === 'hybrid' && texts.length > 0 && withSlots === 0) nodeErr('hybrid_no_slots', 'A hybrid node needs at least one {{slot}}. Make it fixed.');
        }
        texts.forEach((t) => { if (typeof t === 'string') slotsIn(t).forEach(addSpoken); });
        if (languages.length > 0 && isObj(n.text)) {
          for (const l of languages) if (!(l in (n.text as object))) warn('missing_translation', `No ${l} text; callers in ${l} will hear English.`, id);
        }
        if (n.listen !== undefined) {
          const l = n.listen as unknown;
          if (!isObj(l) || !isName(l.captureAs)) nodeErr('bad_listen', 'listen.captureAs must be a variable name.');
          else {
            assigned.add(l.captureAs);
            if (l.sensitive !== undefined && typeof l.sensitive !== 'boolean') nodeErr('bad_listen', 'listen.sensitive must be true or false.');
            if (l.sensitive === true) sensitive.add(l.captureAs);
            if (l.intents !== undefined) {
              if (!isObj(l.intents) || !Object.entries(l.intents).every(([k, v]) => isName(k) && Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === 'string' && p.trim() !== ''))) {
                nodeErr('bad_intents', 'intents must map each intent name to a non-empty list of phrases.');
              } else assigned.add(`${l.captureAs}_intent`);
            }
          }
        }
        break;
      }
      case 'api': {
        if (typeof n.integration !== 'string' || !ID_RE.test(n.integration)) nodeErr('bad_integration', 'integration must be the name of a saved integration.');
        if (typeof n.path !== 'string' || !n.path.startsWith('/') || n.path.includes('//') || n.path.includes('..')) nodeErr('bad_path', 'path must start with "/" and must not contain ".." or "//".');
        else slotsIn(n.path).forEach(addSent);
        if (n.method !== undefined && n.method !== 'GET' && n.method !== 'POST') nodeErr('bad_method', 'method must be GET or POST.');
        if (n.body !== undefined) stringsIn(n.body).forEach((s) => slotsIn(s).forEach(addSent));
        if (n.store !== undefined) {
          if (!isObj(n.store) || !Object.entries(n.store).every(([k, p]) => isName(k) && typeof p === 'string' && /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(p))) nodeErr('bad_store', 'store must map a variable name to a dotted path such as data.balance.');
          else Object.keys(n.store).forEach((k) => assigned.add(k));
        }
        if (n.onError !== undefined) { if (typeof n.onError !== 'string') nodeErr('bad_on_error', 'onError must name a node.'); else targets.push(n.onError); }
        break;
      }
      case 'subflow': {
        if (typeof n.workflow !== 'string' || !isWorkflowName(n.workflow)) nodeErr('bad_workflow', 'A subflow must name the workflow it runs (letters, digits, - and _).');
        assigned.add(`${id}_outcome`);
        if (n.exports !== undefined) {
          if (!Array.isArray(n.exports) || !n.exports.every((v) => isName(v))) nodeErr('bad_exports', 'exports must be a list of variable names.');
          else n.exports.forEach((v) => assigned.add(v));
        }
        break;
      }
      case 'handoff': {
        const t = n.target as unknown;
        const toWorkflow = isObj(t) && typeof t.workflow === 'string' && isWorkflowName(t.workflow);
        const toHuman = isObj(t) && isObj(t.human) && typeof t.human.reason === 'string' && t.human.reason.trim() !== '';
        if (!toWorkflow && !toHuman) nodeErr('bad_handoff', 'A handoff needs a target: { workflow } or { human: { reason } }.');
        break;
      }
      case 'end':
        if (typeof n.outcome !== 'string' || !n.outcome.trim()) nodeErr('missing_outcome', 'An end node needs an outcome, such as "paid" or "wrong_person".');
        break;
      default: nodeErr('unknown_node_type', `"${String((n as { type: unknown }).type)}" is not a node type (speak, api, subflow, handoff, end).`);
    }
    edges.set(id, targets);
  }

  // Dangling paths: an edge to a node that does not exist, and nodes nothing can reach.
  for (const [id, targets] of edges) {
    for (const t of targets) if (!own(def.nodes as object, t)) err('unknown_target', `Goes to "${t}", which does not exist.`, id);
  }
  if (typeof def.start === 'string' && own(def.nodes as object, def.start)) {
    const seen = new Set<string>([def.start]); const queue = [def.start];
    while (queue.length) for (const t of edges.get(queue.shift()!) ?? []) if (own(def.nodes as object, t) && !seen.has(t)) { seen.add(t); queue.push(t); }
    for (const id of ids) if (!seen.has(id)) err('unreachable_node', `Nothing leads to "${id}", so it can never run.`, id);
  }

  for (const u of spoken) if (sensitive.has(u.name)) err('sensitive_in_speech', `"${u.name}" is sensitive, so it cannot be spoken or given to a model.`, u.nodeId);
  for (const u of sent) if (sensitive.has(u.name)) err('sensitive_in_request', `"${u.name}" is sensitive, so it cannot be sent to an integration.`, u.nodeId);
  for (const name of sensitive) if (!assigned.has(name)) err('unknown_variable', `"${name}" is marked sensitive but is never set.`);
  for (const u of used) {
    if (!assigned.has(u.name)) err('unknown_variable', `"${u.name}" is used but never set: declare it in "variables" or capture it earlier.`, u.nodeId);
  }
  return { errors, warnings };
}

export const isPublishable = (r: ValidationResult) => r.errors.length === 0;
export type { Json };
