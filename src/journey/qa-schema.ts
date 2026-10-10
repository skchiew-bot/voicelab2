import { z } from 'zod';
import type { Criterion } from './qa.js';

const base = { id: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), label: z.string().min(1).max(200), weight: z.number().int().min(1).max(10) };
const phrases = z.array(z.string().min(1).max(100)).min(1).max(30);

export const criterionSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('adherence_min'), min: z.number().min(0).max(100) }),
  z.object({ ...base, type: z.literal('outcome_in'), outcomes: z.array(z.string().min(1).max(100)).min(1).max(30) }),
  z.object({ ...base, type: z.literal('no_escalation') }),
  z.object({ ...base, type: z.literal('no_fault') }),
  z.object({ ...base, type: z.literal('must_say'), phrases }),
  z.object({ ...base, type: z.literal('must_not_say'), phrases }),
  z.object({ ...base, type: z.literal('max_latency_ms'), ms: z.number().int().min(1).max(600_000) }),
  z.object({ ...base, type: z.literal('sentiment_not_worse'), tolerance: z.number().min(0).max(2).optional() }),
  z.object({ ...base, type: z.literal('max_misunderstood'), max: z.number().int().min(0).max(100) }),
  z.object({ ...base, type: z.literal('judge'), question: z.string().min(5).max(500) }),
]);

export const criteriaSchema = z.array(criterionSchema).min(1).max(50).superRefine((list, ctx) => {
  const seen = new Set<string>();
  for (const c of list) { if (seen.has(c.id)) ctx.addIssue({ code: 'custom', message: `Two criteria are called "${c.id}".` }); seen.add(c.id); }
});

export const parseCriteria = (input: unknown): Criterion[] => criteriaSchema.parse(input) as Criterion[];
