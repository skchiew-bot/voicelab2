import type { Replay } from './replay.js';

/**
 * The QA scorecard for a call: a client's criteria, each worth some weight, checked against the call's replay. Criteria
 * that can be decided by rules are (free and the same every time). Only a criterion that asks a question of judgement
 * goes to a model, the smallest that will do, and a doubtful answer goes up one tier. Scoring runs in batches after the
 * call, never during it.
 */
interface Base { id: string; label: string; weight: number }
export type Criterion = Base & (
  | { type: 'adherence_min'; min: number }
  | { type: 'outcome_in'; outcomes: string[] }
  | { type: 'no_escalation' }
  | { type: 'no_fault' }
  | { type: 'must_say'; phrases: string[] }
  | { type: 'must_not_say'; phrases: string[] }
  | { type: 'max_latency_ms'; ms: number }
  | { type: 'sentiment_not_worse'; tolerance?: number }
  | { type: 'max_misunderstood'; max: number }
  | { type: 'judge'; question: string }
);

export interface CriterionResult { id: string; label: string; weight: number; passed: boolean | null; detail: string; scorer: 'rules' | 'model' | 'skipped'; model?: string; confidence?: number }

export interface Judge {
  tier: 'haiku' | 'sonnet' | 'opus'; model: string;
  judge(q: { question: string; transcript: { speaker: string; text: string }[] }): Promise<{ passed: boolean; confidence: number; reason: string; inputTokens: number; outputTokens: number }>;
}

export interface ScoreUsage { criterion: string; model: string; tier: string; inputTokens: number; outputTokens: number; confidence: number; escalatedFrom: string | null; passed: boolean; reason: string }
export interface Scorecard { score: number | null; complete: boolean; results: CriterionResult[]; usage: ScoreUsage[] }

const said = (rp: Replay, who: 'assistant' | 'caller') => rp.transcript.filter((t) => t.speaker === who).map((t) => t.text.toLowerCase());
const containsPhrase = (lines: string[], phrase: string) => lines.some((l) => l.includes(phrase.toLowerCase()));

/** Decide one criterion by rules. A judgement question returns null, to be put to a model. */
export function checkByRules(c: Criterion, rp: Replay): { passed: boolean; detail: string } | null {
  switch (c.type) {
    case 'adherence_min': {
      const s = rp.adherence.score;
      return s === null ? { passed: false, detail: 'Adherence could not be checked.' } : { passed: s >= c.min, detail: `${s}% of moves kept to the workflow (needed ${c.min}%).` };
    }
    case 'outcome_in': { const o = rp.summary.outcome; return { passed: o !== null && c.outcomes.includes(o), detail: `The call ended ${o ?? 'with no outcome'}.` }; }
    case 'no_escalation': return { passed: !rp.summary.escalated, detail: rp.summary.escalated ? 'The call was escalated to a person.' : 'The call was not escalated.' };
    case 'no_fault': return { passed: !rp.summary.fault, detail: rp.summary.fault ? 'The system dropped the call.' : 'The system did not drop the call.' };
    case 'must_say': {
      const a = said(rp, 'assistant'); const missing = c.phrases.filter((p) => !containsPhrase(a, p));
      return { passed: missing.length === 0, detail: missing.length ? `The call never said: ${missing.map((m) => `"${m}"`).join(', ')}.` : 'Everything required was said.' };
    }
    case 'must_not_say': {
      const a = said(rp, 'assistant'); const hit = c.phrases.filter((p) => containsPhrase(a, p));
      return { passed: hit.length === 0, detail: hit.length ? `The call said: ${hit.map((m) => `"${m}"`).join(', ')}.` : 'Nothing forbidden was said.' };
    }
    case 'max_latency_ms': {
      const worst = Math.max(0, ...rp.transcript.filter((t) => t.speaker === 'assistant').map((t) => t.latencyMs ?? 0));
      return { passed: worst <= c.ms, detail: `The slowest reply took ${worst} ms (allowed ${c.ms} ms).` };
    }
    case 'sentiment_not_worse': {
      const pts = rp.sentiment;
      if (pts.length < 2) return { passed: true, detail: 'Too few turns to see a change in mood.' };
      const tol = c.tolerance ?? 0.3; const first = pts[0]!.sentiment; const last = pts[pts.length - 1]!.sentiment;
      return { passed: last >= first - tol, detail: `Mood went from ${first.toFixed(2)} to ${last.toFixed(2)}.` };
    }
    case 'max_misunderstood': {
      const n = rp.timeline.filter((t) => t.type === 'heard' && (t.reasoning?.reading as { understood?: boolean } | null)?.understood === false).length;
      return { passed: n <= c.max, detail: `${n} turn${n === 1 ? ' was' : 's were'} not understood (allowed ${c.max}).` };
    }
    case 'judge': return null;
  }
}

/**
 * Score a call. `primary` is the model that judges first; if it is not confident enough, `escalate` (a stronger tier) is
 * asked instead, and the escalation is recorded. With no model available a judgement criterion is left out of the score and
 * the scorecard says it is incomplete, rather than guessing.
 */
export async function scoreCall(
  criteria: Criterion[], rp: Replay, judges: { primary?: Judge; escalate?: Judge } = {}, minConfidence = 0.7,
): Promise<Scorecard> {
  const results: CriterionResult[] = []; const usage: ScoreUsage[] = [];
  const transcript = rp.transcript.map((t) => ({ speaker: t.speaker, text: t.text }));
  for (const c of criteria) {
    const base = { id: c.id, label: c.label, weight: c.weight };
    const rule = checkByRules(c, rp);
    if (rule) { results.push({ ...base, passed: rule.passed, detail: rule.detail, scorer: 'rules' }); continue; }
    if (c.type !== 'judge' || !judges.primary) { results.push({ ...base, passed: null, detail: 'No model is set up to judge this, so it is not in the score.', scorer: 'skipped' }); continue; }
    let judge = judges.primary; let escalatedFrom: string | null = null;
    let a = await judge.judge({ question: c.question, transcript });
    usage.push({ criterion: c.id, model: judge.model, tier: judge.tier, inputTokens: a.inputTokens, outputTokens: a.outputTokens, confidence: a.confidence, escalatedFrom: null, passed: a.passed, reason: a.reason });
    if (a.confidence < minConfidence && judges.escalate) {
      escalatedFrom = judge.tier; judge = judges.escalate;
      a = await judge.judge({ question: c.question, transcript });
      usage.push({ criterion: c.id, model: judge.model, tier: judge.tier, inputTokens: a.inputTokens, outputTokens: a.outputTokens, confidence: a.confidence, escalatedFrom, passed: a.passed, reason: a.reason });
    }
    results.push({ ...base, passed: a.passed, detail: a.reason, scorer: 'model', model: judge.model, confidence: a.confidence });
  }
  const scored = results.filter((r) => r.passed !== null);
  const total = scored.reduce((s, r) => s + r.weight, 0);
  const got = scored.filter((r) => r.passed).reduce((s, r) => s + r.weight, 0);
  return { score: total === 0 ? null : Math.round((got / total) * 10000) / 100, complete: scored.length === results.length, results, usage };
}
