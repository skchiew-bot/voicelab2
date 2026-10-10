/**
 * The change log: every change anyone made to the platform, with who made it and why, read from the audit log. The
 * reason is read from the record the change made (a change request's reason, an approval's note, a policy's summary),
 * not copied into the audit log, so nothing typed by a person is stored twice. Day-to-day activity (calls placed,
 * workflows run, events that could not be matched) is not a change and is left out unless asked for.
 */
import type pg from 'pg';
import { z } from 'zod';
import { redactNumbers } from '../telephony/types.js';

export const CATEGORIES = ['workflows', 'money', 'providers', 'compliance', 'policy', 'learning', 'journey', 'modules', 'people', 'activity'] as const;
export type Category = (typeof CATEGORIES)[number];

// Things that happen in the normal course of calls and customers, or that a scheduled job does on its own. They are
// audited, but they are not changes to the platform, and one busy day of them must not bury the changes.
const ACTIVITY = new Set(['call.outbound', 'workflow.run', 'workflow.runs_abandoned', 'webhook.unknown_call', 'inbound.unrouted', 'queue.expired',
  'call_cost.record', 'call_cost.reconcile', 'outbound.outcome', 'case.step_failed', 'case.open', 'qa.score_batch', 'ticket.open', 'ticket.event',
  'did.lock', 'channels.charge', 'learning.distil', 'appointment.book', 'appointment.cancel', 'appointment.reschedule', 'appointment.no_show', 'appointment.complete']);

const PREFIX: [string, Category][] = [
  ['workflow.', 'workflows'], ['change.', 'workflows'], ['approval.', 'workflows'], ['integration.', 'workflows'],
  ['charging.', 'money'], ['rate_card.', 'money'], ['fx.', 'money'], ['credits.', 'money'], ['channels.', 'money'], ['funding.', 'money'], ['call_cost.', 'money'],
  ['provider.', 'providers'], ['control.', 'providers'], ['number.', 'providers'], ['did.', 'providers'], ['routes.', 'providers'], ['fallback.', 'providers'], ['resilience.', 'providers'], ['entitlement.', 'providers'], ['model.', 'providers'],
  ['dnc.', 'compliance'],
  ['policy.', 'policy'], ['knowledge.', 'policy'],
  ['learning.', 'learning'], ['recording.', 'learning'],
  ['qa.', 'journey'], ['ticket.', 'journey'], ['fault.', 'journey'], ['journey.', 'journey'],
  ['case.', 'modules'], ['cases.', 'modules'], ['appointment.', 'modules'], ['appointments.', 'modules'], ['diary.', 'modules'], ['location.', 'modules'],
  ['tenant.', 'people'], ['user.', 'people'], ['project.', 'people'],
];

/** A change's kind. Anything not known to be a change (activity, or an action this list has not heard of) is activity. */
export function categoryOf(action: string): Category {
  if (ACTIVITY.has(action)) return 'activity';
  return PREFIX.find(([p]) => action.startsWith(p))?.[1] ?? 'activity';
}
const like = (prefixes: string[]) => prefixes.map((p) => `${p.replace(/[\\%_]/g, '\\$&')}%`);

/** Where in the console the thing that changed can be seen, and, for a workflow, rolled back through an approved change. */
export function linkFor(entity: string, entityId: string | null): string | null {
  if (!entityId) return null;
  switch (entity) {
    case 'workflow': return `#/workflows/${entityId}`;
    case 'change': return '#/changes';
    case 'provider': return `#/providers/${entityId}`;
    case 'policy': case 'article': return '#/knowledge';
    case 'promotion': return '#/learning';
    case 'case': return '#/cases';
    case 'appointment': case 'diary': return '#/appointments';
    case 'call': return '#/calls';
    case 'ticket': return '#/tickets';
    default: return null;
  }
}

export const changeLogQuery = z.object({
  category: z.enum(CATEGORIES).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
}).strict();

// The reason a change was made, read from the record it made. A note was cleaned of numbers when it was typed; it is
// scrubbed again here because some older notes predate that check.
// Each branch compares against the record's own key type, so its index is used; a branch runs only for its action.
const WHY = `CASE
  WHEN a.action = 'change.request' THEN (SELECT reason FROM change_requests WHERE id = (a.detail->>'change')::uuid)
  WHEN a.action = 'change.decide' THEN (SELECT note FROM change_approvals WHERE change_id = a.entity_id::uuid AND decided_by = a.actor_id ORDER BY id DESC LIMIT 1)
  WHEN a.action = 'change.apply' THEN (SELECT reason FROM change_requests WHERE id = a.entity_id::uuid)
  WHEN a.action IN ('policy.propose', 'policy.activate') THEN (SELECT summary FROM policy_versions WHERE id = a.entity_id::uuid)
  WHEN a.action = 'policy.decide' THEN (SELECT note FROM policy_approvals WHERE version_id = a.entity_id::uuid AND decided_by = a.actor_id ORDER BY id DESC LIMIT 1)
  WHEN a.action = 'policy.withdraw' THEN (SELECT withdrawn_note FROM policy_versions WHERE id = a.entity_id::uuid)
  WHEN a.action IN ('knowledge.publish', 'knowledge.reject') THEN (SELECT review_note FROM knowledge_versions WHERE article_id = a.entity_id::uuid AND version::text = a.detail->>'version')
  WHEN a.entity = 'promotion' THEN (SELECT reason FROM promotion_events e WHERE e.promotion_id = a.entity_id::uuid AND e.created_at <= a.created_at ORDER BY e.id DESC LIMIT 1)
  WHEN a.action = 'fault.ack' THEN (SELECT note FROM fault_acks WHERE call_id = a.entity_id::uuid)
  WHEN a.action = 'case.decide' THEN (SELECT e.detail->>'note' FROM case_events e WHERE e.case_id = a.entity_id::uuid AND e.kind = 'decision' AND e.actor_id IS NOT DISTINCT FROM a.actor_id AND e.at <= a.created_at ORDER BY e.id DESC LIMIT 1)
  ELSE coalesce(a.detail->>'reason', a.detail->>'note')
END`;

/** Every text value scrubbed of anything shaped like a phone number, as the reason is. */
function scrub(v: unknown): unknown {
  if (typeof v === 'string') return redactNumbers(v);
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x)]));
  return v;
}

export interface ChangeEntry {
  id: number; at: Date; action: string; category: Category; entity: string; entityId: string | null;
  who: string; why: string | null; detail: Record<string, unknown>; link: string | null;
}

/** The newest changes first, a page at a time (pass the last id as `before` for the next page). */
export async function changeLog(c: pg.PoolClient, q: z.infer<typeof changeLogQuery>): Promise<{ entries: ChangeEntry[]; next: number | null }> {
  // Which actions to show is decided in SQL, by the same rule as categoryOf, so a page of changes is never emptied by a
  // burst of calls, and activity is exactly what is not a known change.
  const activity = [...ACTIVITY];
  const changes = like(q.category && q.category !== 'activity' ? PREFIX.filter(([, cat]) => cat === q.category).map(([p]) => p) : PREFIX.map(([p]) => p));
  const isChange = `(a.action LIKE ANY($2::text[]) AND NOT (a.action = ANY($3::text[])))`;
  const rows = (await c.query(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.detail, a.created_at, a.actor_id, u.email, ${WHY} AS why
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE ($1::bigint IS NULL OR a.id < $1) AND ${q.category === 'activity' ? `NOT ${isChange}` : isChange}
      ORDER BY a.id DESC LIMIT $4`, [q.before ?? null, changes, activity, q.limit + 1])).rows;
  const page = rows.slice(0, q.limit);
  return {
    entries: page.map((r) => ({
      id: Number(r.id), at: r.created_at, action: r.action, category: categoryOf(r.action), entity: r.entity, entityId: r.entity_id,
      who: r.email ?? (r.actor_id ? 'a user who no longer exists' : 'the system'),
      why: typeof r.why === 'string' && r.why.trim() !== '' ? redactNumbers(r.why).slice(0, 500) : null,
      detail: scrub(r.detail ?? {}) as Record<string, unknown>, link: linkFor(r.entity, r.entity_id),
    })),
    next: rows.length > q.limit ? Number(page.at(-1)!.id) : null,
  };
}
