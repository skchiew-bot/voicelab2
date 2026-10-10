import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withActor, type Actor } from '../db.js';
import { ackFault, listFaults, sweepFaults } from '../store/call-end.js';
import { dropLatencySeconds, getJourneyConfig, setDropLatency, setJourneyConfig } from '../store/journey.js';
import { applyChange, decide, getApprovalPolicy, getChange, listChanges, requestChange, setApprovalPolicy, showcase } from '../store/changes.js';
import type { RunDeps } from '../store/runs.js';
import { scenario } from './workflows.js';
import { listDecisions, listModels, setModel, tokenUsage } from '../store/ai-decisions.js';
import { addCriteriaSet, listCriteriaSets, listScores, qaSummary, scoreBatch, type QaDeps } from '../store/qa.js';
import { replayCall, replayRun } from '../store/replay.js';
import { addTicketEvent, getTicket, listTickets } from '../store/tickets.js';

interface Ctx { pool: pg.Pool; runDeps: RunDeps; judges?: QaDeps['judges']; internal(req: FastifyRequest): Promise<{ userId: string; actor: Actor }> }
const id = z.string().uuid();

/** Phase 5: replaying calls, tickets, system-drop faults, and how a client's calls are read. All staff-only. */
export function registerJourneyRoutes(app: FastifyInstance, ctx: Ctx): void {
  const run = async <T>(req: FastifyRequest, fn: (c: pg.PoolClient, userId: string) => Promise<T>) => {
    const s = await ctx.internal(req);
    return withActor(ctx.pool, s.actor, (c) => fn(c, s.userId));
  };

  app.get('/internal/workflow-runs/:runId/replay', async (req) => {
    const { runId } = z.object({ runId: id }).parse(req.params);
    return run(req, (c) => replayRun(c, runId));
  });
  app.get('/internal/calls/:callId/replay', async (req) => {
    const { callId } = z.object({ callId: id }).parse(req.params);
    return run(req, (c) => replayCall(c, callId));
  });

  app.get('/internal/tenants/:tenantId/journey-config', async (req) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    return run(req, async (c) => { const j = await getJourneyConfig(c, tenantId); return { ...j, lexicon: undefined, lexiconSize: Object.values(j.lexicon).flat().length }; });
  });
  app.put('/internal/tenants/:tenantId/journey-config', async (req) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    const b = z.object({
      maxRecoveries: z.number().int().min(1).max(10).optional(), negativeBelow: z.number().min(-1).max(0).optional(),
      severeBelow: z.number().min(-1).max(0).optional(), lexicon: z.unknown().optional(),
    }).parse(req.body);
    return run(req, async (c, u) => { const j = await setJourneyConfig(c, u, tenantId, b); return { ...j, lexicon: undefined }; });
  });

  app.get('/internal/tickets', async (req) => {
    const q = z.object({ tenantId: id.optional(), status: z.enum(['open', 'in_review', 'resolved']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return run(req, (c) => listTickets(c, q));
  });
  app.get('/internal/tickets/:ticketId', async (req) => {
    const { ticketId } = z.object({ ticketId: id }).parse(req.params);
    return run(req, (c) => getTicket(c, ticketId));
  });
  app.post('/internal/tickets/:ticketId/events', async (req, reply) => {
    const { ticketId } = z.object({ ticketId: id }).parse(req.params);
    const b = z.object({ kind: z.enum(['status', 'note', 'council']), status: z.enum(['open', 'in_review', 'resolved']).optional(), note: z.string().max(4000).optional() }).parse(req.body);
    return reply.status(201).send(await run(req, (c, u) => addTicketEvent(c, u, ticketId, b)));
  });

  app.get('/internal/faults', async (req) => {
    const q = z.object({ tenantId: id.optional(), acknowledged: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return run(req, (c) => listFaults(c, { tenantId: q.tenantId, acknowledged: q.acknowledged === undefined ? undefined : q.acknowledged === 'true', limit: q.limit }));
  });
  app.post('/internal/calls/:callId/fault-ack', async (req) => {
    const { callId } = z.object({ callId: id }).parse(req.params);
    const b = z.object({ note: z.string().max(1000).optional() }).parse(req.body ?? {});
    return run(req, (c, u) => ackFault(c, u, callId, b.note));
  });
  // The watchdog: run it on a schedule, at least as often as the latency you are willing to accept.
  app.post('/internal/faults/sweep', async (req) => run(req, (c) => sweepFaults(c)));
  app.get('/internal/journey/drop-latency', async (req) => run(req, async (c) => ({ seconds: await dropLatencySeconds(c) })));
  app.put('/internal/journey/drop-latency', async (req) => {
    const b = z.object({ seconds: z.number().int().min(1).max(3600) }).parse(req.body);
    return run(req, async (c, u) => ({ seconds: await setDropLatency(c, u, b.seconds) }));
  });

  // ---- QA scorecard
  app.post('/internal/tenants/:tenantId/qa-criteria', async (req, reply) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    const b = z.object({ useCase: z.string().min(1).max(100), criteria: z.unknown() }).parse(req.body);
    return reply.status(201).send(await run(req, (c, u) => addCriteriaSet(c, u, tenantId, b.useCase, b.criteria)));
  });
  app.get('/internal/tenants/:tenantId/qa-criteria', async (req) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    return run(req, (c) => listCriteriaSets(c, tenantId));
  });
  app.post('/internal/tenants/:tenantId/qa/score', async (req) => {
    const s = await ctx.internal(req);
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    const b = z.object({ limit: z.number().int().min(1).max(500).optional() }).parse(req.body ?? {});
    return scoreBatch({ pool: ctx.pool, judges: ctx.judges }, s.userId, { tenantId, limit: b.limit });
  });
  app.get('/internal/qa/scores', async (req) => {
    const q = z.object({ tenantId: id.optional(), runId: id.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return run(req, (c) => listScores(c, q));
  });
  app.get('/internal/tenants/:tenantId/qa/summary', async (req) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    return run(req, (c) => qaSummary(c, tenantId));
  });

  // ---- the AI decision audit, and which model does which task
  app.get('/internal/ai-decisions', async (req) => {
    const q = z.object({ tenantId: id.optional(), callId: id.optional(), subjectType: z.string().max(40).optional(), subjectId: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return run(req, (c) => listDecisions(c, q));
  });
  app.get('/internal/ai-usage', async (req) => {
    const q = z.object({ tenantId: id.optional() }).parse(req.query);
    return run(req, (c) => tokenUsage(c, q));
  });
  app.get('/internal/model-config', async (req) => run(req, (c) => listModels(c)));
  app.put('/internal/model-config/:taskKey', async (req) => {
    const { taskKey } = z.object({ taskKey: z.string().regex(/^[a-z][a-z0-9_]{0,60}$/) }).parse(req.params);
    const tier = z.enum(['haiku', 'sonnet', 'opus']);
    const b = z.object({ tier, modelId: z.string().min(1).max(100), escalateTo: tier.nullable().default(null) }).parse(req.body);
    return run(req, (c, u) => setModel(c, u, { taskKey, ...b }));
  });

  // ---- proposed changes: a diff, a financial assessment, and levels of approval
  app.put('/internal/tenants/:tenantId/approval-policy', async (req) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    const b = z.object({ levels: z.array(z.string().min(1).max(80)).min(1).max(5) }).parse(req.body);
    return run(req, (c, u) => setApprovalPolicy(c, u, tenantId, b.levels));
  });
  app.get('/internal/tenants/:tenantId/approval-policy', async (req) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    return run(req, (c) => getApprovalPolicy(c, tenantId));
  });
  app.post('/internal/workflows/:workflowId/changes', async (req, reply) => {
    const s = await ctx.internal(req);
    const { workflowId } = z.object({ workflowId: id }).parse(req.params);
    const b = z.object({
      toVersionId: id, environment: z.enum(['staging', 'production']), reason: z.string().min(1).max(2000),
      scenarios: z.array(scenario).min(1).max(500), voiceProviderId: id.optional(),
    }).parse(req.body);
    return reply.status(201).send(await requestChange(ctx.runDeps, s.userId, { workflowId, ...b, scenarios: b.scenarios as never }));
  });
  app.get('/internal/changes', async (req) => {
    const q = z.object({ tenantId: id.optional(), workflowId: id.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    return run(req, (c) => listChanges(c, q));
  });
  app.get('/internal/changes/:changeId', async (req) => {
    const { changeId } = z.object({ changeId: id }).parse(req.params);
    return run(req, (c) => getChange(c, changeId));
  });
  app.post('/internal/changes/:changeId/decision', async (req) => {
    const { changeId } = z.object({ changeId: id }).parse(req.params);
    const b = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(2000).optional() }).parse(req.body);
    return run(req, (c, u) => decide(c, u, changeId, b));
  });
  app.post('/internal/changes/:changeId/apply', async (req) => {
    const { changeId } = z.object({ changeId: id }).parse(req.params);
    return run(req, (c, u) => applyChange(c, u, changeId));
  });
  app.get('/internal/changes/:changeId/showcase', async (req) => {
    const { changeId } = z.object({ changeId: id }).parse(req.params);
    return run(req, (c) => showcase(c, changeId));
  });
}
