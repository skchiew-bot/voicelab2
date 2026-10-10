import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withActor, type Actor } from '../db.js';
import { ackFault, listFaults, sweepFaults } from '../store/call-end.js';
import { dropLatencySeconds, getJourneyConfig, setDropLatency, setJourneyConfig } from '../store/journey.js';
import { replayCall, replayRun } from '../store/replay.js';
import { addTicketEvent, getTicket, listTickets } from '../store/tickets.js';

interface Ctx { pool: pg.Pool; internal(req: FastifyRequest): Promise<{ userId: string; actor: Actor }> }
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
}
