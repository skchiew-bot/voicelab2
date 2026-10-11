import { redactNumbers } from '../telephony/types.js';
import { evalCondition, type Vars } from './conditions.js';
import { canonicalZone, readDay, readHour } from './callback.js';
import { CONTACT_OUTCOMES, own, RESERVED_NAMES, SLOT_RE, type ApiNode, type CallbackFrom, type Json, type SpeakNode, type WorkflowDefinition, type WorkflowNode } from './definition.js';
import { interpretDetail } from './interpret.js';
import { analyseTurn, intentChanged, observeTurn, type JourneyConfig, type JourneyState } from '../journey/tracker.js';
import { planSpeech, synthOnly, type RecordingIndex, type Segment, type SpeechPlan } from './stitch.js';
import { MissingVariable, pickText, renderText, SensitiveVariable } from './render.js';

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
  /** Steps taken over the whole call, and integration calls made: both capped so a loop cannot run up cost. */
  steps: number;
  apiCalls?: number;
  /** Turn-by-turn reading of the caller (kind, topic, sentiment), kept so the call can re-route and escalate. */
  journey?: JourneyState;
  /** Why the call was passed to a person, when it was escalated rather than handed over by the flow. */
  escalation?: { trigger: string; detail: string; node: string };
}

export interface StepRecord {
  type: string; workflow: string; node?: string; payload: Record<string, Json>;
  /** When it happened (ISO time), stamped as the record is made, so a replay can show how long each step took. */
  at?: string;
  /** A said line's pieces with their words, in order, for whatever plays the call. Held in memory only, never stored. */
  speech?: { lang: string; segments: Segment[] };
}

/** A list of records that stamps each one with the time it was made. */
function stampedRecords(deps: { now?: () => Date }): StepRecord[] {
  const records: StepRecord[] = [];
  const push = records.push.bind(records);
  records.push = (...items: StepRecord[]) => { for (const r of items) r.at ??= (deps.now ? deps.now() : new Date()).toISOString(); return push(...items); };
  return records;
}

/** What a model that writes a line can report about it, for the audit trail. A plain string is also accepted. */
export interface KnowledgeSnippet { slug: string; title: string; text: string }
export interface PolicyGuard {
  version: string;
  /** The first banned phrase a line says, or null. */
  violation(line: string): { ruleId: string; phrase: string; message: string | null } | null;
  /** What the model is told it must never say, and which actions it may not take. */
  mustNotSay: string[]; denied: string[];
}
export interface SpeakContext { knowledge: KnowledgeSnippet[]; policy: { version: string; mustNotSay: string[]; denied: string[] } | null }
export interface SpeakerResult {
  text: string; model?: string; reasoning?: string; policy?: string; inputTokens?: number; outputTokens?: number; confidence?: number;
}

export interface IntegrationCall { method: 'GET' | 'POST'; path: string; body?: Json }
export interface Deps {
  /** The workflow definitions this call is pinned to, by name. */
  load(workflow: string): WorkflowDefinition | undefined;
  integrations?: { call(name: string, req: IntegrationCall): Promise<Json> };
  /** Pre-recorded audio to play where the words match. Without one every line is spoken live (the unstitched baseline). */
  recordings?: RecordingIndex;
  /** Writes a dynamic node's line. Without one, a dynamic node speaks its fallback text. */
  speaker?: { generate(node: SpeakNode, vars: Vars, lang: string | undefined, context?: SpeakContext): Promise<string | SpeakerResult> };
  /** What the client's bot may know, ranked against a question for a voice call. Given to the model that writes a line. */
  knowledge?: (query: string, language: string | undefined) => KnowledgeSnippet[];
  /** The client's policy in force: words the bot may never say, checked on every line a model writes or a promoted script speaks. */
  policy?: PolicyGuard;
  /** Steps allowed in one request (one start or one reply). */
  maxSteps?: number;
  /** Steps allowed over the whole call. */
  maxTotalSteps?: number;
  maxApiCalls?: number;
  maxDepth?: number;
  /** The clock, so records can be stamped with a time a test controls. */
  now?: () => Date;
  /** Read each caller turn; re-route on a change of intent and escalate to a person on failed recoveries or severe sentiment. */
  journey?: JourneyConfig;
  /** A dynamic node whose line has been promoted to a reviewed, pre-recorded script: its script is spoken instead of asking a model. */
  promoted?: (workflow: string, node: SpeakNode, id: string, language: string, context: { kind: string; topic: string }) => { id: string; script: string } | undefined;
}

export const DEFAULT_MAX_STEPS = 200;
export const DEFAULT_MAX_TOTAL_STEPS = 2000;
export const DEFAULT_MAX_API_CALLS = 20;
export const DEFAULT_MAX_DEPTH = 8;

const E164 = /^\+[1-9]\d{7,14}$/;
const LOCAL_NUMBER = /^0\d{8,10}$/; // e.g. 012-345 6789: the Malaysian local form
export class PhoneInVariable extends Error {
  constructor(public variable: string) { super(`"${variable}" looks like a phone number. Phone numbers are never kept in a call's variables.`); }
}

/** A string that is only a phone number, in international or local form, with the usual separators. */
export function looksLikePhone(s: string): boolean {
  const t = s.trim().replace(/[\s().-]/g, '');
  return E164.test(t) || LOCAL_NUMBER.test(t);
}

/** True if the value is, or holds anywhere inside it, a phone number. */
export function holdsPhone(v: Json, depth = 0): boolean {
  if (typeof v === 'string') return looksLikePhone(v);
  if (depth > 20) return true; // too deep to inspect: refuse rather than guess
  if (Array.isArray(v)) return v.some((x) => holdsPhone(x, depth + 1));
  if (v !== null && typeof v === 'object') return Object.values(v).some((x) => holdsPhone(x, depth + 1));
  return false;
}

/** Reject a variable value that is a phone number: customers' numbers are not stored anywhere. */
export function checkVars(vars: Vars): void {
  for (const [k, v] of Object.entries(vars)) if (holdsPhone(v)) throw new PhoneInVariable(k);
}

/**
 * The callback time an end asks for, read from the call's variables by fixed rules: `{ day, hour, timeZone }`, or
 * 'unread' when either part is missing, sensitive or not something the rules can read (it is never guessed).
 */
function callbackAt(state: RunState, from: CallbackFrom): Json {
  const value = (name: unknown) => (typeof name === 'string' && own(state.vars, name) && !state.sensitive.includes(name) ? state.vars[name] : undefined);
  const day = readDay(value(from.day)); const hour = readHour(value(from.hour));
  const timeZone = canonicalZone(from.timeZone);
  if (day === null || hour === null || timeZone === null) return 'unread';
  return { day, hour, timeZone };
}

/** Variables are set by name from outside (callers, integrations): names every object inherits are skipped. */
function setVar(state: RunState, name: string, value: Json): void { if (!RESERVED_NAMES.has(name)) state.vars[name] = value; }

/** A finished call keeps none of its sensitive variables. */
function scrub(state: RunState): void { for (const name of state.sensitive) delete state.vars[name]; }

const addSensitive = (state: RunState, names: string[] | undefined) => { for (const n of names ?? []) if (!state.sensitive.includes(n)) state.sensitive.push(n); };

function fail(state: RunState, out: StepRecord[], message: string, node?: string): void {
  state.status = 'ended'; state.outcome = 'error'; state.error = message; state.node = null; state.awaiting = undefined; scrub(state);
  out.push({ type: 'error', workflow: state.workflow, node, payload: { message } });
}

/**
 * What a model wrote is not trusted as it stands. It is turned down if it is empty, still has an unfilled {{slot}},
 * runs on beyond a spoken line, or contains something that looks like a phone number (a model could invent or repeat
 * one, and those are never spoken). Stray whitespace is tidied, and the line is marked as reworked.
 */
export function checkModelLine(raw: string): { decision: 'proceeded' | 'rejected' | 'reworked'; line?: string; reason: string } {
  const tidy = raw.replace(/\s+/g, ' ').trim();
  if (tidy === '') return { decision: 'rejected', reason: 'The model wrote nothing.' };
  if (/\{\{|\}\}/.test(tidy)) return { decision: 'rejected', reason: 'The line still had an unfilled placeholder.' };
  if (tidy.length > 600) return { decision: 'rejected', reason: 'The line was too long to be spoken in one go.' };
  if (redactNumbers(tidy) !== tidy) return { decision: 'rejected', reason: 'The line contained something that looks like a phone number.' };
  return tidy === raw ? { decision: 'proceeded', line: tidy, reason: 'The line passed the checks.' } : { decision: 'reworked', line: tidy, reason: 'Extra spaces and line breaks were tidied.' };
}

/** What is kept of a model's account of its own line. Numbers in free text are scrubbed like any other. */
function aiInfo(g: SpeakerResult): Record<string, Json> {
  const out: Record<string, Json> = {};
  if (g.model) out.model = g.model;
  if (g.reasoning) out.reasoning = redactNumbers(g.reasoning).slice(0, 1000);
  if (g.policy) out.policy = redactNumbers(g.policy).slice(0, 500);
  if (g.inputTokens !== undefined) out.inputTokens = g.inputTokens;
  if (g.outputTokens !== undefined) out.outputTokens = g.outputTokens;
  if (g.confidence !== undefined) out.confidence = g.confidence;
  return out;
}

/** The call goes to a person: the flow's own handoff, or an escalation. Control does not come back. */
function endWithHuman(state: RunState, out: StepRecord[], node: string, reason: string): void {
  const wf = state.workflow;
  out.push({ type: 'handoff_human', workflow: wf, node, payload: { reason } });
  state.status = 'ended'; state.outcome = 'handoff_human'; state.node = null; state.stack = []; state.awaiting = undefined; scrub(state);
  out.push({ type: 'end', workflow: wf, payload: { outcome: 'handoff_human', reason } });
}

function withoutSensitive(state: RunState): Vars {
  return Object.fromEntries(Object.entries(state.vars).filter(([k]) => !state.sensitive.includes(k)));
}

function route(node: WorkflowNode, vars: Vars): string | null {
  return routeWhy(node, vars).to;
}

/** Where the call goes next, and which rule sent it there: the first transition whose condition holds. */
function routeWhy(node: WorkflowNode, vars: Vars): { to: string | null; via: string } {
  const ts = (node as { transitions?: { when?: Parameters<typeof evalCondition>[0]; to: string }[] }).transitions ?? [];
  for (const [i, t] of ts.entries()) if (t.when === undefined || evalCondition(t.when, vars)) return { to: t.to, via: t.when === undefined ? `transition ${i + 1} (always)` : `transition ${i + 1} (condition held)` };
  return { to: null, via: ts.length === 0 ? 'no transitions' : 'no transition matched' }; // nothing matched: the call ends cleanly
}

/** Move on from a node, and leave a record of why that way. */
function goFrom(state: RunState, node: WorkflowNode, nodeId: string, out: StepRecord[]): string | null {
  const r = routeWhy(node, state.vars);
  out.push({ type: 'route', workflow: state.workflow, node: nodeId, payload: { to: r.to, via: r.via } });
  return r.to;
}

function dig(v: Json, path: string): Json | undefined {
  let cur: Json | undefined = v;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || Array.isArray(cur) || !own(cur, part)) return undefined;
    cur = (cur as Record<string, Json>)[part];
  }
  return cur;
}

const renderJson = (v: Json, vars: Vars, forbidden: readonly string[]): Json =>
  typeof v === 'string' ? renderText(v, vars, forbidden)
  : Array.isArray(v) ? v.map((x) => renderJson(x, vars, forbidden))
  : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, renderJson(x, vars, forbidden)])) : v;

/** Start a call at a workflow's first node and run until it needs the caller or finishes. */
export async function start(workflow: string, vars: Vars, deps: Deps): Promise<{ state: RunState; records: StepRecord[] }> {
  checkVars(vars);
  const def = deps.load(workflow);
  const state: RunState = { workflow, node: null, vars: { ...vars }, stack: [], status: 'running', steps: 0, sensitive: [...(def?.sensitiveVariables ?? [])] };
  const records = stampedRecords(deps);
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
  const records = stampedRecords(deps);
  const { node, captureAs, intents, sensitive } = next.awaiting!;
  // What was said can contain a number; it is kept without it. A sensitive answer is not recorded at all.
  const heard = sensitive ? text : redactNumbers(text);
  setVar(next, captureAs, heard);
  if (sensitive) addSensitive(next, [captureAs]);
  const payload: Record<string, Json> = { text: sensitive ? '[hidden]' : heard };
  if (intents) {
    const d = interpretDetail(text, intents);
    setVar(next, `${captureAs}_intent`, d.intent); payload.intent = d.intent;
    // The words that decided it, unless the answer is sensitive (then nothing of it is recorded).
    if (!sensitive) payload.matched = d.matched.map((m) => `${m.intent}: ${m.phrase}`);
  }
  // Read the turn (kind, topic, sentiment) unless the answer is sensitive, in which case nothing of it is looked at or kept.
  let decision: ReturnType<typeof observeTurn> = { escalate: false };
  let analysis: ReturnType<typeof analyseTurn> | undefined;
  if (deps.journey && !sensitive) {
    analysis = analyseTurn(text, deps.journey.lexicon, deps.journey.severeBelow);
    next.journey ??= { turns: [], recoveries: 0 };
    const understood = !intents || (payload.intent !== 'unknown' && payload.intent !== 'ambiguous');
    decision = observeTurn(next.journey, { node, analysis, understood }, deps.journey);
    payload.analysis = { kind: analysis.kind, topic: analysis.topic, sentiment: analysis.sentiment, severe: analysis.severe, understood };
  }
  records.push({ type: 'heard', workflow: next.workflow, node, payload });
  next.awaiting = undefined; next.status = 'running';
  if (decision.escalate) {
    next.escalation = { trigger: decision.trigger, detail: decision.detail, node };
    records.push({ type: 'escalate', workflow: next.workflow, node, payload: { trigger: decision.trigger, detail: decision.detail, recoveries: next.journey!.recoveries, sentiment: analysis!.sentiment } });
    if (sensitive) { delete next.vars[captureAs]; delete next.vars[`${captureAs}_intent`]; }
    endWithHuman(next, records, node, `Escalated: ${decision.detail}`);
    return { state: next, records };
  }
  const def = deps.load(next.workflow);
  const n = def && own(def.nodes, node) ? def.nodes[node] : undefined;
  if (!n) { fail(next, records, `The node "${node}" is no longer available.`, node); return { state: next, records }; }
  // A change of intent can send the call somewhere else before the node's own transitions are looked at.
  const rerouted = analysis && next.journey && intentChanged(next.journey) ? def!.intentRoutes?.find((r) => (r.when.kind === undefined || r.when.kind === analysis!.kind) && (r.when.topic === undefined || r.when.topic === analysis!.topic)) : undefined;
  if (rerouted) records.push({ type: 'reroute', workflow: next.workflow, node, payload: { to: rerouted.to, kind: analysis!.kind, topic: analysis!.topic } });
  next.node = rerouted ? rerouted.to : goFrom(next, n, node, records);
  // A sensitive answer has done its job once the route is chosen: it is forgotten now, not at the end of the call.
  if (sensitive) { delete next.vars[captureAs]; delete next.vars[`${captureAs}_intent`]; }
  if (next.node === null) leave(next, records, 'completed', deps);
  await advance(next, deps, records);
  return { state: next, records };
}

/** The current workflow ended cleanly (or by an end node): finish the call, or return to the parent of a subflow. */
function leave(state: RunState, out: StepRecord[], outcome: string, deps: Deps, said: Record<string, Json> = {}): void {
  const frame = state.stack.pop();
  if (!frame) { state.status = 'ended'; state.outcome = outcome; state.node = null; scrub(state); out.push({ type: 'end', workflow: state.workflow, payload: { outcome, ...said } }); return; }
  out.push({ type: 'subflow_exit', workflow: state.workflow, node: frame.node, payload: { outcome } });
  state.vars[`${frame.node}_outcome`] = outcome;
  state.workflow = frame.workflow;
  const pdef = deps.load(frame.workflow);
  const parent = pdef && own(pdef.nodes, frame.node) ? pdef.nodes[frame.node] : undefined;
  state.node = parent ? goFrom(state, parent, frame.node, out) : null;
  if (state.node === null) leave(state, out, 'completed', deps);
}

async function advance(state: RunState, deps: Deps, out: StepRecord[]): Promise<void> {
  const maxSteps = deps.maxSteps ?? DEFAULT_MAX_STEPS;
  const maxTotal = deps.maxTotalSteps ?? DEFAULT_MAX_TOTAL_STEPS;
  let thisRequest = 0; // a long honest conversation is many requests; only a loop piles steps into one
  while (state.status === 'running' && state.node !== null) {
    state.steps++;
    if (++thisRequest > maxSteps) { fail(state, out, `The call went through more than ${maxSteps} steps in one go, so it was stopped (a loop with no way out?).`, state.node); return; }
    if (state.steps > maxTotal) { fail(state, out, `The call went through more than ${maxTotal} steps in all, so it was stopped.`, state.node); return; }
    const def = deps.load(state.workflow);
    const id = state.node;
    const node = def && own(def.nodes, id) ? def.nodes[id] : undefined;
    if (!def || !node) { fail(state, out, `The node "${id}" in "${state.workflow}" is not available.`, id); return; }
    const wf = state.workflow;

    switch (node.type) {
      case 'speak': {
        const lang = typeof state.vars.lang === 'string' ? state.vars.lang : undefined;
        let line: string | undefined;
        let plan: SpeechPlan | undefined;
        let ai: Record<string, Json> | undefined;
        let promotedId: string | undefined;
        let scriptBlocked: string | undefined;
        try {
          const lastTurn = state.journey?.turns.at(-1);
          const promo = node.speech === 'dynamic' ? deps.promoted?.(wf, node, id, lang ?? 'en', { kind: lastTurn?.kind ?? 'start', topic: lastTurn?.topic ?? '' }) : undefined;
          if (promo) {
            // Same stitching as any frame: the fixed words play from their recordings, slots are spoken live. A slot with no value falls back to the model.
            try {
              const spoken = renderText(promo.script, state.vars, state.sensitive);
              const forbidden = deps.policy?.violation(spoken);
              if (forbidden) { scriptBlocked = `The promoted script was not spoken: it breaks the policy (rule "${forbidden.ruleId}").`; throw new MissingVariable('policy'); }    // a script the policy now forbids is not spoken: the model (also held to the policy) writes the line
              line = spoken; plan = planSpeech(promo.script, state.vars, state.sensitive, lang ?? 'en', deps.recordings); promotedId = promo.id;
            }
            catch (e) { if (!(e instanceof MissingVariable || e instanceof SensitiveVariable)) throw e; line = undefined; plan = undefined; }
          }
          if (promotedId !== undefined) { /* spoken from the promoted script */ }
          else if (node.speech === 'dynamic') {
            const fallback = node.text !== undefined ? pickText(node.text, lang) : undefined;
            if (deps.speaker) {
              const context: SpeakContext = {
                knowledge: deps.knowledge?.(node.prompt ?? '', lang) ?? [],
                policy: deps.policy ? { version: deps.policy.version, mustNotSay: deps.policy.mustNotSay, denied: deps.policy.denied } : null,
              };
              const g = await deps.speaker.generate(node, withoutSensitive(state), lang, context);
              if (typeof g !== 'string') ai = aiInfo(g);
              // A line a model wrote is checked before anyone hears it: used as it is, tidied, or turned down for the fallback.
              let checked = checkModelLine(typeof g === 'string' ? g : g.text);
              // The client's policy has the last word on what the bot may say.
              const banned = checked.line !== undefined ? deps.policy?.violation(checked.line) : null;
              if (banned) checked = { decision: 'rejected', reason: `The line broke the policy (rule "${banned.ruleId}"): it said “${banned.phrase}”.${banned.message ? ` ${banned.message}` : ''}` };
              if (checked.decision !== 'proceeded') ai = { ...(ai ?? {}), decision: checked.decision, decisionReason: checked.reason };
              else ai = { ...(ai ?? {}), decision: 'proceeded', decisionReason: 'The line passed the checks and was used.' };
              if (scriptBlocked) ai = { ...(ai ?? {}), scriptBlocked };
              if (checked.line !== undefined) line = checked.line;
              else if (fallback !== undefined) line = renderText(fallback, state.vars, state.sensitive);
              else { fail(state, out, `The line written for "${id}" was turned down (${checked.reason}), and there is no fallback text.`, id); return; }
            }
            else if (fallback !== undefined) line = renderText(fallback, state.vars, state.sensitive);
            else { fail(state, out, `"${id}" is dynamic and has no fallback text, and no model is connected to write its line.`, id); return; }
          } else {
            const raw = node.text ?? '';
            const template = pickText(raw, lang) ?? '';
            line = renderText(template, state.vars, state.sensitive);
            // A plain string is English; a language map says which language the chosen text is in.
            const used = typeof raw === 'string' ? 'en' : lang !== undefined && own(raw, lang) ? lang : 'en';
            plan = planSpeech(template, state.vars, state.sensitive, used, deps.recordings);
          }
        } catch (e) {
          if (e instanceof SensitiveVariable) { fail(state, out, `"${id}" would use the sensitive variable "${e.variable}". Nothing was said.`, id); return; }
          if (e instanceof MissingVariable) { fail(state, out, `"${id}" needs the variable "${e.variable}", which is not set. Nothing was said.`, id); return; }
          fail(state, out, `Could not write the line for "${id}": ${redactNumbers((e as Error).message)}`, id); return;
        }
        plan ??= synthOnly(line!); // a line a model wrote is always spoken live
        out.push({ type: 'say', workflow: wf, node: id, payload: {
          strategy: node.speech, text: line!, ...(lang ? { lang } : {}),
          synthChars: plan.synthCharacters, recordedChars: plan.recordedCharacters,
          ...(ai ? { ai } : {}),
          ...(promotedId !== undefined ? { promotion: promotedId } : {}),
          segments: plan.segments.map((s): Json => (s.kind === 'recorded' ? { kind: 'recorded', chars: s.characters, recordingId: s.recordingId } : { kind: 'synth', chars: s.characters })),
        }, speech: { lang: lang ?? 'en', segments: plan.segments } });
        if (node.listen) {
          state.status = 'awaiting_reply';
          state.awaiting = { node: id, captureAs: node.listen.captureAs, intents: node.listen.intents, sensitive: node.listen.sensitive };
          return;
        }
        state.node = goFrom(state, node, id, out);
        if (state.node === null) leave(state, out, 'completed', deps);
        break;
      }
      case 'api': {
        if (!deps.integrations) { fail(state, out, `"${id}" calls an integration, but none are connected.`, id); return; }
        const maxCalls = deps.maxApiCalls ?? DEFAULT_MAX_API_CALLS;
        state.apiCalls = (state.apiCalls ?? 0) + 1;
        if (state.apiCalls > maxCalls) { fail(state, out, `The call made more than ${maxCalls} integration calls, so it was stopped.`, id); return; }
        const outcome = await runApi(node, state, deps);
        if (!outcome.ok && outcome.fatal) { fail(state, out, outcome.reason, id); return; }
        if (outcome.ok) {
          out.push({ type: 'api', workflow: wf, node: id, payload: { integration: node.integration, stored: outcome.stored } });
          state.node = goFrom(state, node, id, out);
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
        if ('human' in node.target) { endWithHuman(state, out, id, node.target.human.reason); return; }
        const target = deps.load(node.target.workflow);
        if (!target) { fail(state, out, `The workflow "${node.target.workflow}" (handoff "${id}") is not available.`, id); return; }
        // Control does not come back: the call, with all its variables, continues in the other workflow.
        out.push({ type: 'handoff', workflow: wf, node: id, payload: { to: node.target.workflow, carried: Object.keys(state.vars).sort() } });
        state.stack = []; addSensitive(state, target.sensitiveVariables); state.workflow = node.target.workflow; state.node = target.start;
        break;
      }
      case 'end': {
        // Only a known call outcome is carried (a version saved before outcomes were checked may hold anything there).
        const contact = (CONTACT_OUTCOMES as readonly unknown[]).includes(node.contact) ? node.contact : undefined;
        // Read before the end forgets the call's sensitive values; only the day and hour themselves are kept.
        // A version saved before callbacks were checked may hold anything there: only an object is read.
        const from = node.callback as unknown;
        const callback = contact && contact !== 'wrong_number' && typeof from === 'object' && from !== null && !Array.isArray(from) ? callbackAt(state, from as CallbackFrom) : undefined;
        const said: Record<string, Json> = { ...(contact ? { contact } : {}), ...(callback !== undefined ? { callback } : {}) };
        out.push({ type: 'reached_end', workflow: wf, node: id, payload: { outcome: node.outcome, ...said } });
        leave(state, out, node.outcome, deps, said);
        break;
      }
    }
  }
}

async function runApi(node: ApiNode, state: RunState, deps: Deps): Promise<{ ok: true; stored: string[] } | { ok: false; reason: string; fatal?: boolean }> {
  let req: IntegrationCall;
  try {
    // Values go into the path URL-encoded, so a caller's words cannot change which endpoint is called.
    const path = node.path.replace(new RegExp(SLOT_RE.source, 'g'), (_m, name: string) => {
      if (state.sensitive.includes(name)) throw new SensitiveVariable(name);
      const v = own(state.vars, name) ? state.vars[name] : undefined;
      if (v === undefined || v === null || v === '') throw new MissingVariable(name);
      return encodeURIComponent(String(v));
    });
    req = { method: node.method ?? 'GET', path, body: node.body === undefined ? undefined : renderJson(node.body as Json, state.vars, state.sensitive) };
  } catch (e) {
    if (e instanceof SensitiveVariable) return { ok: false, fatal: true, reason: `"${node.integration}" would be sent the sensitive variable "${e.variable}". Nothing was sent.` };
    return { ok: false, reason: e instanceof MissingVariable ? `needs the variable "${e.variable}", which is not set` : 'could not build the request' };
  }
  let result: Json;
  try { result = await deps.integrations!.call(node.integration, req); }
  catch (e) { return { ok: false, reason: redactNumbers((e as Error).message).slice(0, 300) }; }
  const found: [string, Json][] = [];
  for (const [name, path] of Object.entries(node.store ?? {})) {
    const v = dig(result, path);
    if (v === undefined) continue; // left unset: anything that needs it fails closed later
    if (holdsPhone(v)) return { ok: false, reason: `the reply put a phone number in "${name}", which is never kept` };
    found.push([name, v]);
  }
  for (const [name, v] of found) setVar(state, name, v);
  return { ok: true, stored: found.map(([n]) => n) };
}
