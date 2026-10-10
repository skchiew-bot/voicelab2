import type pg from 'pg';
import { AppError } from '../errors.js';
import { checkAdherence } from '../journey/replay.js';
import { draftTicket, type TicketDraft } from '../journey/ticket.js';
import type { Json, WorkflowDefinition } from '../workflows/definition.js';
import type { RunState } from '../workflows/engine.js';
import { audit } from './audit.js';
import { recordEvent } from './events.js';

async function gather(c: pg.PoolClient, runId: string) {
  const run = (await c.query(
    `SELECT r.id, r.tenant_id, r.call_id, r.workflow_id, r.version_id, r.pins, r.state, r.kind, v.major || '.' || v.minor AS version
       FROM workflow_runs r JOIN workflow_versions v ON v.id = r.version_id WHERE r.id = $1`, [runId])).rows[0];
  if (!run) throw new AppError(404, 'Run not found.');
  const steps = (await c.query('SELECT seq, type, workflow, node, payload, created_at, occurred_at FROM workflow_run_steps WHERE run_id = $1 ORDER BY seq', [runId])).rows;
  const defRows = (await c.query('SELECT id, definition FROM workflow_versions WHERE id = ANY($1::uuid[])', [Object.values(run.pins as Record<string, string>)])).rows;
  const byId = new Map(defRows.map((r) => [r.id as string, r.definition as WorkflowDefinition]));
  const defs = Object.fromEntries(Object.entries(run.pins as Record<string, string>).map(([name, id]) => [name, byId.get(id)!]));
  return { run, steps, defs, state: run.state as RunState };
}

async function similar(c: pg.PoolClient, tenantId: string, node: string | null) {
  const q = async (extra: string, args: unknown[]) => (await c.query(
    `SELECT count(*)::int AS n FROM workflow_runs WHERE tenant_id = $1 AND kind IN ('live', 'test') AND started_at > now() - interval '30 days' AND state->>'workflow' IS NOT NULL ${extra}`, [tenantId, ...args])).rows[0].n as number;
  return {
    atNodeLast30d: node ? await q(`AND state->'escalation'->>'node' = $2`, [node]) : 0,
    allLast30d: await q(`AND state ? 'escalation'`, []),
    callsLast30d: await q('', []),
  };
}

const toRow = (t: TicketDraft) => [t.kind, t.trigger, t.reason, t.node, t.customerView, JSON.stringify(t.aiReviews), JSON.stringify(t.councilNotes), JSON.stringify(t.impact)];

/**
 * Open the ticket for a call a workflow escalated to a person. Every required field is filled from what was stored. A
 * second request for the same run changes nothing. Simulations do not raise tickets: they are rehearsals.
 */
export async function ticketForEscalation(c: pg.PoolClient, actorId: string | null, runId: string) {
  const g = await gather(c, runId);
  if (g.run.kind === 'simulation') return null;
  const esc = g.state.escalation;
  if (!esc) return null;
  const adherence = checkAdherence(g.steps, g.defs, g.state.workflow ?? Object.keys(g.defs)[0]!);
  const draft = draftTicket({
    kind: 'escalation', workflow: g.state.workflow, version: g.run.version, node: esc.node, trigger: esc.trigger, detail: esc.detail,
    steps: g.steps.map((s) => ({ type: s.type, node: s.node, payload: s.payload as Record<string, Json> })),
    adherence, similar: await similar(c, g.run.tenant_id, esc.node),
  });
  return insertTicket(c, actorId, g.run.tenant_id, g.run.call_id, runId, draft);
}

/** The ticket for a call the system dropped: made from the same pieces, and just as complete. */
export async function ticketForFault(c: pg.PoolClient, actorId: string | null, callId: string, detail: string) {
  const call = (await c.query('SELECT id, tenant_id, ended_node FROM calls WHERE id = $1', [callId])).rows[0];
  if (!call) throw new AppError(404, 'Call not found.');
  const runId = (await c.query('SELECT id FROM workflow_runs WHERE call_id = $1 ORDER BY started_at DESC LIMIT 1', [callId])).rows[0]?.id as string | undefined;
  const g = runId ? await gather(c, runId) : null;
  const draft = draftTicket({
    kind: 'fault', workflow: g?.state.workflow ?? 'none', version: g?.run.version ?? null, node: call.ended_node ?? null, trigger: 'system_drop', detail,
    steps: (g?.steps ?? []).map((s) => ({ type: s.type, node: s.node, payload: s.payload as Record<string, Json> })),
    adherence: g ? checkAdherence(g.steps, g.defs, g.state.workflow) : { score: null, followed: 0, checked: 0, deviations: [] },
    similar: g ? await similar(c, call.tenant_id, call.ended_node ?? null) : { atNodeLast30d: 0, allLast30d: 0, callsLast30d: 0 },
  });
  return insertTicket(c, actorId, call.tenant_id, callId, runId ?? null, draft);
}

async function insertTicket(c: pg.PoolClient, actorId: string | null, tenantId: string, callId: string | null, runId: string | null, d: TicketDraft) {
  const conflict = runId ? '(run_id, kind) WHERE run_id IS NOT NULL' : '(call_id, kind) WHERE run_id IS NULL';
  const row = (await c.query(
    `INSERT INTO tickets (tenant_id, call_id, run_id, kind, trigger, reason, node, customer_view, ai_reviews, council_notes, impact)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT ${conflict} DO NOTHING RETURNING id`,
    [tenantId, callId, runId, ...toRow(d)])).rows[0];
  if (!row) return null;           // already raised: reporting it again changes nothing
  if (callId) await recordEvent(c, { tenantId, callId, type: 'ticket.opened', payload: { ticketId: row.id, kind: d.kind, trigger: d.trigger } });
  await audit(c, actorId, 'ticket.open', 'ticket', row.id, { kind: d.kind, trigger: d.trigger });
  return getTicket(c, row.id as string);
}

const VIEW = `
  SELECT t.id, t.tenant_id, t.call_id, t.run_id, t.kind, t.trigger, t.reason, t.node, t.customer_view, t.ai_reviews, t.council_notes, t.impact, t.created_at,
         coalesce((SELECT e.status FROM ticket_events e WHERE e.ticket_id = t.id AND e.kind = 'status' ORDER BY e.id DESC LIMIT 1), 'open') AS status
    FROM tickets t`;

export async function getTicket(c: pg.PoolClient, id: string) {
  const t = (await c.query(`${VIEW} WHERE t.id = $1`, [id])).rows[0];
  if (!t) throw new AppError(404, 'Ticket not found.');
  const events = (await c.query('SELECT id, kind, status, note, actor_id, at FROM ticket_events WHERE ticket_id = $1 ORDER BY id', [id])).rows;
  // Council notes added since the ticket was opened sit with the ones it began with.
  const council = events.filter((e) => e.kind === 'council').map((e) => ({ note: e.note, at: e.at }));
  return { ...t, council_notes: { ...t.council_notes, status: council.length ? 'reviewed' : t.council_notes.status, notes: [...(t.council_notes.notes ?? []), ...council] }, events };
}

export const listTickets = async (c: pg.PoolClient, o: { tenantId?: string; status?: string; limit?: number }) =>
  (await c.query(
    `SELECT * FROM (${VIEW} WHERE ($1::uuid IS NULL OR t.tenant_id = $1)) x WHERE ($2::text IS NULL OR x.status = $2) ORDER BY x.created_at DESC LIMIT $3`,
    [o.tenantId ?? null, o.status ?? null, o.limit ?? 50])).rows.map(({ ai_reviews, council_notes, impact, ...rest }) => rest);

export async function addTicketEvent(
  c: pg.PoolClient, actorId: string | null, ticketId: string,
  e: { kind: 'status' | 'note' | 'council'; status?: 'open' | 'in_review' | 'resolved'; note?: string },
) {
  const t = (await c.query('SELECT id, tenant_id, call_id FROM tickets WHERE id = $1', [ticketId])).rows[0];
  if (!t) throw new AppError(404, 'Ticket not found.');
  if (e.kind === 'status' && !e.status) throw new AppError(400, 'Say which status.');
  if (e.kind !== 'status' && !e.note?.trim()) throw new AppError(400, 'A note needs some words.');
  await c.query('INSERT INTO ticket_events (ticket_id, kind, status, note, actor_id) VALUES ($1,$2,$3,$4,$5)', [ticketId, e.kind, e.kind === 'status' ? e.status : null, e.note ?? null, actorId]);
  await audit(c, actorId, 'ticket.event', 'ticket', ticketId, { kind: e.kind, status: e.status ?? null });
  return getTicket(c, ticketId);
}
