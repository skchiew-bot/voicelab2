import type { Json } from '../workflows/definition.js';
import type { Adherence } from './replay.js';

/**
 * A ticket for a call that went to a person (or that the system dropped), with everything a reviewer needs on one page:
 * why, what the caller was going through, what automatic reviews found, what the council thinks (not yet asked), and what
 * the impact is. Built from what was stored, by rules, so it is the same every time and costs nothing to make.
 */
export interface TicketStep { type: string; node: string | null; payload: Record<string, Json> }
export interface TicketInput {
  kind: 'escalation' | 'fault';
  workflow: string; version: string | null; node: string | null;
  trigger: string; detail: string;
  steps: TicketStep[];
  adherence: Adherence;
  similar: { atNodeLast30d: number; allLast30d: number; callsLast30d: number };
}
export interface TicketDraft {
  kind: 'escalation' | 'fault'; trigger: string; reason: string; node: string | null;
  customerView: string; aiReviews: Record<string, Json>[]; councilNotes: Record<string, Json>; impact: Record<string, Json>;
}

const pct = (n: number, d: number) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
const quote = (t: string) => `“${t.length > 140 ? `${t.slice(0, 137)}…` : t}”`;

export function draftTicket(i: TicketInput): TicketDraft {
  const heard = i.steps.filter((s) => s.type === 'heard');
  const readings = heard.map((s) => s.payload.analysis as { sentiment: number; kind: string; topic: string | null; understood: boolean } | undefined).filter((x): x is NonNullable<typeof x> => Boolean(x));
  const lines = heard.slice(-3).map((s) => quote(String(s.payload.text ?? '')));
  const misunderstood = readings.filter((r) => !r.understood).length;
  const topics = [...new Set(readings.map((r) => r.topic).filter((t): t is string => Boolean(t)))];
  const kinds = [...new Set(readings.map((r) => r.kind))];

  const mood = readings.length >= 2
    ? `Their mood went from ${readings[0]!.sentiment.toFixed(2)} to ${readings[readings.length - 1]!.sentiment.toFixed(2)} over ${readings.length} turns.`
    : readings.length === 1 ? `Their mood was ${readings[0]!.sentiment.toFixed(2)}.` : '';
  const customerView = i.kind === 'fault'
    ? `The call was cut off by the system. ${lines.length ? `Their last words were ${lines.join(', ')}. ` : 'They had not yet said anything. '}They did not choose to end it.`
    : [
        lines.length ? `The caller said ${lines.join(', ')}.` : 'The caller had said nothing before the call was passed on.',
        mood,
        topics.length ? `They were asking about ${topics.join(' and ')}${kinds.length ? ` (${kinds.join(', ')})` : ''}.` : '',
        misunderstood ? `The system did not understand ${misunderstood} of their ${readings.length} turns.` : '',
      ].filter(Boolean).join(' ');

  const findings: Record<string, Json>[] = [
    { check: 'trigger', result: i.detail },
    { check: 'understanding', result: readings.length ? `${misunderstood} of ${readings.length} turns were not understood${i.node ? ` (last at ${i.node})` : ''}.` : 'No reading of the caller\'s turns was recorded.' },
    { check: 'workflow_adherence', result: i.adherence.score === null ? 'Not checked: the definitions were not available.' : `${i.adherence.score}% of moves kept to the workflow${i.adherence.deviations.length ? `; ${i.adherence.deviations.length} did not.` : '.'}` },
    { check: 'integrations', result: `${i.steps.filter((s) => s.type === 'api_error').length} integration call${i.steps.filter((s) => s.type === 'api_error').length === 1 ? '' : 's'} failed.` },
  ];
  const justified = i.kind === 'fault' ? false : i.trigger === 'severe_sentiment' || i.trigger === 'failed_recoveries' || i.trigger === 'workflow_handoff';
  const aiReviews: Record<string, Json>[] = [{
    reviewer: 'rules', model: null, kind: i.kind,
    verdict: i.kind === 'fault' ? 'A system fault: the caller should be contacted and the cause fixed.' : i.trigger === 'workflow_handoff' ? 'The workflow passed the call to a person, as it was written to.' : justified ? 'The escalation followed the policy (about two failed recoveries, or severe sentiment).' : 'The escalation was not triggered by the standard policy; check the flow.',
    findings,
  }];

  return {
    kind: i.kind, trigger: i.trigger, node: i.node,
    reason: i.kind === 'fault' ? `System fault: ${i.detail}` : `Escalated to a person: ${i.detail}`,
    customerView,
    aiReviews,
    // The council reviews hard cases in a later phase. The field is here, and says so, rather than being left out.
    councilNotes: { status: 'not_requested', notes: [], note: 'No council review has been asked for yet.' },
    impact: {
      workflow: i.workflow, version: i.version, node: i.node,
      sameNodeLast30d: i.similar.atNodeLast30d, allLast30d: i.similar.allLast30d, callsLast30d: i.similar.callsLast30d,
      shareOfCallsLast30dPercent: pct(i.similar.allLast30d, i.similar.callsLast30d),
      note: i.similar.atNodeLast30d > 1 ? `This is not the only one: ${i.similar.atNodeLast30d} calls escalated at ${i.node} in the last 30 days.` : 'The first at this point in the last 30 days.',
    },
  };
}
