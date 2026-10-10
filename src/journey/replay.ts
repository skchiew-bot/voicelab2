import type { Json, WorkflowDefinition } from '../workflows/definition.js';

/**
 * Putting a finished call back together: every step of the workflow and every event on the call, in order, with the
 * reason behind each, the transcript with how long each reply took, whether the call kept to its workflow, and how the
 * caller's mood moved. A pure function over what was stored, so it can be checked against what actually happened.
 */
export interface ReplayStep { seq: number; type: string; workflow: string; node: string | null; payload: Record<string, Json>; created_at: string | Date; occurred_at?: string | Date | null }
export interface ReplayEvent { id: number | string; type: string; payload: Record<string, unknown>; occurred_at: string | Date }
export interface ReplayFailover { id: number | string; scope: string; trigger: string; from_name?: string | null; to_name?: string | null; detail: Record<string, unknown>; at: string | Date }

export interface ReplayInput {
  /** Null for a call no workflow ran on: its events are still replayed. */
  run: { id: string; workflow: string; status: string; outcome: string | null; error: string | null; environment: string; kind: string; versions: Record<string, string> } | null;
  steps: ReplayStep[];
  events?: ReplayEvent[];
  failovers?: ReplayFailover[];
  /** The definitions the call was pinned to, by workflow name: what it should have followed. */
  definitions?: Record<string, WorkflowDefinition>;
  call?: { id: string; status: string; direction: string; ended_by: string | null; ended_node: string | null; fault: boolean; fault_reason: string | null; started_at: string | Date; ended_at: string | Date | null } | null;
}

export interface TimelineEntry {
  index: number; at: string; source: 'workflow' | 'call' | 'failover'; type: string; workflow?: string; node?: string | null;
  speaker: 'assistant' | 'caller' | 'system';
  summary: string;
  text?: string;
  /** How long this step took after the one before it. */
  latencyMs?: number;
  reasoning?: Record<string, Json>;
  /** The line of the node's script this step followed, when the definition is known. */
  policy?: string;
  adherence?: 'on_path' | 'deviation';
}
export interface TranscriptLine { index: number; speaker: 'assistant' | 'caller'; text: string; at: string; node: string | null; timelineIndex: number; latencyMs?: number; sentiment?: number }
export interface SentimentPoint { turn: number; at: string; sentiment: number; severe: boolean; kind: string; topic: string | null; node: string | null; transcriptIndex: number; timelineIndex: number }
export interface Deviation { seq: number; node: string | null; reason: string }
export interface Adherence { score: number | null; followed: number; checked: number; deviations: Deviation[] }

export interface Replay {
  run: ReplayInput['run'];
  call: ReplayInput['call'];
  summary: { startedAt: string | null; endedAt: string | null; durationMs: number | null; turns: number; outcome: string | null; endedBy: string | null; endedAtNode: string | null; fault: boolean; escalated: boolean };
  timeline: TimelineEntry[];
  transcript: TranscriptLine[];
  sentiment: SentimentPoint[];
  adherence: Adherence;
}

const iso = (d: string | Date | null | undefined): string => (d instanceof Date ? d : new Date(d ?? 0)).toISOString();
const ms = (d: string | Date | null | undefined) => new Date(d ?? 0).getTime();
const str = (v: Json | undefined) => (v === undefined || v === null ? '' : String(v));

/** The script a node follows, for showing as the policy behind a step. Only the definition's own wording, never a variable's value. */
function policyOf(defs: Record<string, WorkflowDefinition> | undefined, workflow: string, node: string | null): string | undefined {
  const n = node && defs?.[workflow]?.nodes && Object.hasOwn(defs[workflow]!.nodes, node) ? defs[workflow]!.nodes[node] : undefined;
  if (!n) return undefined;
  if (n.type === 'speak') {
    const t = n.speech === 'dynamic' ? n.prompt : typeof n.text === 'string' ? n.text : n.text?.en;
    return `${n.speech} line${t ? `: ${t}` : ''}`;
  }
  if (n.type === 'api') return `call ${n.integration} ${n.method ?? 'GET'} ${n.path}`;
  if (n.type === 'subflow') return `run the workflow ${n.workflow}`;
  if (n.type === 'handoff') return 'hand the call over';
  return `end the call: ${n.outcome}`;
}

function describe(s: ReplayStep): { summary: string; text?: string; speaker: TimelineEntry['speaker']; reasoning?: Record<string, Json> } {
  const p = s.payload;
  switch (s.type) {
    case 'start': return { summary: `The call started in ${s.workflow}.`, speaker: 'system' };
    case 'say': return {
      summary: `Said a ${str(p.strategy)} line at ${s.node}.`, text: str(p.text), speaker: 'assistant',
      reasoning: { strategy: p.strategy ?? null, spokenLive: p.synthChars ?? null, playedFromRecording: p.recordedChars ?? null, ...(p.ai ? { ai: p.ai } : {}) },
    };
    case 'heard': return {
      summary: `The caller replied at ${s.node}${p.intent ? `; understood as "${str(p.intent)}"` : ''}.`, text: str(p.text), speaker: 'caller',
      reasoning: { intent: p.intent ?? null, matchedWords: p.matched ?? null, reading: p.analysis ?? null },
    };
    case 'route': return { summary: p.to ? `Went from ${s.node} to ${str(p.to)} (${str(p.via)}).` : `Nothing matched at ${s.node}, so the call ended cleanly (${str(p.via)}).`, speaker: 'system', reasoning: { rule: p.via ?? null, to: p.to ?? null } };
    case 'reroute': return { summary: `The caller's intent changed (${str(p.kind)}${p.topic ? `, ${str(p.topic)}` : ''}), so the call went to ${str(p.to)}.`, speaker: 'system', reasoning: { kind: p.kind ?? null, topic: p.topic ?? null, to: p.to ?? null } };
    case 'escalate': return { summary: `Escalated to a person: ${str(p.detail)}`, speaker: 'system', reasoning: { trigger: p.trigger ?? null, recoveries: p.recoveries ?? null, sentiment: p.sentiment ?? null } };
    case 'api': return { summary: `Called ${str(p.integration)}.`, speaker: 'system', reasoning: { stored: p.stored ?? null } };
    case 'api_error': return { summary: `The call to ${str(p.integration)} failed: ${str(p.reason)}`, speaker: 'system' };
    case 'subflow_enter': return { summary: `Entered the workflow ${str(p.workflow)}.`, speaker: 'system' };
    case 'subflow_exit': return { summary: `Returned from a subflow (${str(p.outcome)}).`, speaker: 'system' };
    case 'handoff': return { summary: `Handed the call to ${str(p.to)}.`, speaker: 'system' };
    case 'handoff_human': return { summary: `Handed the call to a person: ${str(p.reason)}`, speaker: 'system' };
    case 'reached_end': return { summary: `Reached the end (${str(p.outcome)}).`, speaker: 'system' };
    case 'end': return { summary: `The call ended: ${str(p.outcome)}.`, speaker: 'system' };
    case 'error': return { summary: `An error stopped the call: ${str(p.message)}`, speaker: 'system' };
    default: return { summary: s.type, speaker: 'system' };
  }
}

/** Did the call keep to its workflow: each move is one the definition allows, and each step happens where the last move said. */
export function checkAdherence(steps: ReplayStep[], defs: Record<string, WorkflowDefinition> | undefined, startWorkflow: string): Adherence {
  const deviations: Deviation[] = [];
  let checked = 0; let followed = 0;
  let workflow = startWorkflow;
  let expect: string | null | undefined = defs?.[workflow]?.start;
  const stack: string[] = [];
  const ok = () => { checked++; followed++; };
  const bad = (s: ReplayStep, reason: string) => { checked++; deviations.push({ seq: s.seq, node: s.node, reason }); };
  const transitionsOf = (wf: string, node: string | null) => {
    const n = node && defs?.[wf]?.nodes && Object.hasOwn(defs[wf]!.nodes, node) ? defs[wf]!.nodes[node] : undefined;
    const o = n as unknown as { transitions?: { to: string }[]; onError?: string } | undefined;
    return { known: Boolean(n), to: new Set([...(o?.transitions ?? []).map((t) => t.to), ...(o?.onError ? [o.onError] : [])]) };
  };
  if (!defs) return { score: null, followed: 0, checked: 0, deviations: [] };

  for (const s of steps) {
    workflow = s.workflow || workflow;
    switch (s.type) {
      case 'say': case 'api': case 'api_error': case 'reached_end':
        if (expect !== undefined && expect !== null && s.node !== expect) bad(s, `The step happened at ${s.node}, but the last move was to ${expect}.`); else ok();
        break;
      case 'route': {
        const t = transitionsOf(s.workflow, s.node);
        const to = (s.payload.to as string | null) ?? null;
        if (to === null) { ok(); expect = undefined; break; }
        if (!t.known) bad(s, `${s.node} is not a node of ${s.workflow}.`);
        else if (!t.to.has(to)) bad(s, `${to} is not a transition of ${s.node}.`);
        else ok();
        expect = to;
        break;
      }
      case 'reroute': {
        const routes = defs[s.workflow]?.intentRoutes ?? [];
        if (!routes.some((r) => r.to === s.payload.to)) bad(s, `No intent route leads to ${str(s.payload.to)}.`); else ok();
        expect = s.payload.to as string;
        break;
      }
      case 'subflow_enter': stack.push(s.workflow); expect = defs[str(s.payload.workflow)]?.start; ok(); break;
      case 'subflow_exit': stack.pop(); expect = undefined; ok(); break;
      case 'handoff': expect = defs[str(s.payload.to)]?.start; ok(); break;
      default: break;
    }
  }
  return { score: checked === 0 ? null : Math.round((followed / checked) * 100), followed, checked, deviations };
}

export function buildReplay(i: ReplayInput): Replay {
  type Raw = { at: number; order: number; entry: Omit<TimelineEntry, 'index' | 'at'>; atIso: string; sentiment?: { analysis: Record<string, Json> } };
  const raw: Raw[] = [];
  for (const s of i.steps) {
    const at = ms(s.occurred_at ?? s.created_at);
    const d = describe(s);
    const entry: Omit<TimelineEntry, 'index' | 'at'> = {
      source: 'workflow', type: s.type, workflow: s.workflow, node: s.node, speaker: d.speaker, summary: d.summary, text: d.text, reasoning: d.reasoning,
      policy: s.type === 'say' || s.type === 'api' || s.type === 'heard' ? policyOf(i.definitions, s.workflow, s.node) : undefined,
    };
    raw.push({ at, order: s.seq, entry, atIso: iso(s.occurred_at ?? s.created_at), sentiment: s.type === 'heard' && s.payload.analysis ? { analysis: s.payload.analysis as Record<string, Json> } : undefined });
  }
  for (const e of i.events ?? []) raw.push({ at: ms(e.occurred_at), order: 1_000_000 + Number(e.id), atIso: iso(e.occurred_at), entry: { source: 'call', type: e.type, speaker: 'system', summary: `Call event: ${e.type.replace(/\./g, ' ')}.`, reasoning: e.payload as Record<string, Json> } });
  for (const f of i.failovers ?? []) raw.push({ at: ms(f.at), order: 2_000_000 + Number(f.id), atIso: iso(f.at), entry: { source: 'failover', type: `failover.${f.scope}`, speaker: 'system', summary: `Failover (${f.scope}): ${f.from_name ?? '—'} to ${f.to_name ?? '—'}, because of ${f.trigger.replace(/_/g, ' ')}.`, reasoning: f.detail as Record<string, Json> } });
  raw.sort((a, b) => a.at - b.at || a.order - b.order);

  const adherence = i.run ? checkAdherence(i.steps, i.definitions, i.run.workflow) : { score: null, followed: 0, checked: 0, deviations: [] };
  const bySeq = new Map(adherence.deviations.map((d) => [d.seq, d.reason]));

  const timeline: TimelineEntry[] = []; const transcript: TranscriptLine[] = []; const sentiment: SentimentPoint[] = [];
  let lastWorkflowAt: number | null = null; let turn = 0;
  raw.forEach((r, index) => {
    const isWorkflow = r.entry.source === 'workflow';
    const latencyMs = isWorkflow && lastWorkflowAt !== null ? Math.max(0, r.at - lastWorkflowAt) : undefined;
    const seq = isWorkflow ? r.order : undefined;
    const e: TimelineEntry = { ...r.entry, index, at: r.atIso, latencyMs, adherence: isWorkflow && ['say', 'api', 'route', 'reroute', 'reached_end'].includes(r.entry.type) ? (seq !== undefined && bySeq.has(seq) ? 'deviation' : 'on_path') : undefined };
    if (seq !== undefined && bySeq.has(seq)) e.reasoning = { ...(e.reasoning ?? {}), deviation: bySeq.get(seq)! };
    timeline.push(e);
    if (isWorkflow) lastWorkflowAt = r.at;
    if (r.entry.speaker === 'assistant' || r.entry.speaker === 'caller') {
      const line: TranscriptLine = { index: transcript.length, speaker: r.entry.speaker, text: r.entry.text ?? '', at: r.atIso, node: r.entry.node ?? null, timelineIndex: index, latencyMs };
      if (r.sentiment) {
        const a = r.sentiment.analysis;
        line.sentiment = Number(a.sentiment);
        sentiment.push({ turn: ++turn, at: r.atIso, sentiment: Number(a.sentiment), severe: Boolean(a.severe), kind: str(a.kind), topic: (a.topic as string | null) ?? null, node: r.entry.node ?? null, transcriptIndex: line.index, timelineIndex: index });
      }
      transcript.push(line);
    }
  });

  const first = timeline[0]; const last = timeline[timeline.length - 1];
  const callStart = i.call?.started_at ? iso(i.call.started_at) : first?.at ?? null;
  const callEnd = i.call?.ended_at ? iso(i.call.ended_at) : last?.at ?? null;
  return {
    run: i.run, call: i.call ?? null,
    summary: {
      startedAt: callStart, endedAt: callEnd, durationMs: callStart && callEnd ? Math.max(0, ms(callEnd) - ms(callStart)) : null,
      turns: transcript.filter((t) => t.speaker === 'caller').length, outcome: i.run?.outcome ?? null,
      endedBy: i.call?.ended_by ?? null, endedAtNode: i.call?.ended_node ?? null, fault: i.call?.fault ?? false,
      escalated: i.steps.some((s) => s.type === 'escalate'),
    },
    timeline, transcript, sentiment, adherence,
  };
}
