import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withActor, type Actor } from '../db.js';
import { hangUpCalls, promoteWaiting, type CallDeps } from '../store/calls.js';
import { chargeExtraChannels, expireQueued, getEntitlement, providerLoad, setEntitlement } from '../store/concurrency.js';
import { fundingStatus, setThresholds } from '../store/funding-monitor.js';
import { clearTransferSettings, getTransferSettings, setTransferSettings } from '../store/transfer.js';
import { getFallbackPlan, getPolicy, getRoutes, listFailovers, providerHealthViews, recordSample, setFallbackPlan, setPolicy, setRoutes } from '../store/resilience.js';

interface Ctx { pool: pg.Pool; callDeps: CallDeps; internal(req: FastifyRequest): Promise<{ userId: string; actor: Actor }> }
const id = z.string().uuid();

/** Phase 4 settings and views. All staff-only. */
export function registerResilienceRoutes(app: FastifyInstance, ctx: Ctx): void {
  const run = async <T>(req: FastifyRequest, fn: (c: pg.PoolClient, userId: string) => Promise<T>) => {
    const s = await ctx.internal(req);
    return withActor(ctx.pool, s.actor, (c) => fn(c, s.userId));
  };

  app.get('/internal/resilience/policy', async (req) => run(req, (c) => getPolicy(c)));
  app.put('/internal/resilience/policy', async (req) => {
    const p = z.object({
      errorThreshold: z.number().int().min(1).max(100), errorWindowMs: z.number().int().min(1000).max(3_600_000),
      latencyThresholdMs: z.number().int().min(1).max(600_000), latencyWindowMs: z.number().int().min(1000).max(3_600_000),
      latencyMinSamples: z.number().int().min(1).max(1000), deadAirMs: z.number().int().min(1).max(600_000),
      recoveryOkSamples: z.number().int().min(1).max(1000), recoveryDwellMs: z.number().int().min(0).max(86_400_000),
    }).partial().strict().parse(req.body);
    return run(req, (c, u) => setPolicy(c, u, p));
  });
  app.get('/internal/resilience/health', async (req) => run(req, (c) => providerHealthViews(c)));
  app.get('/internal/resilience/failovers', async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    return run(req, (c) => listFailovers(c, limit));
  });
  // A health check an operator or a probe job reports: it counts like any other attempt.
  app.post('/internal/providers/:providerId/samples', async (req, reply) => {
    const { providerId } = z.object({ providerId: id }).parse(req.params);
    const b = z.object({ kind: z.enum(['ok', 'error', 'dead_air']), latencyMs: z.number().int().min(0).max(600_000).optional() }).parse(req.body);
    return reply.status(201).send(await run(req, (c) => recordSample(c, { providerId, probe: true, ...b })));
  });

  app.put('/internal/tenants/:tenantId/routes/voice', async (req) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    const b = z.object({ providerIds: z.array(id).max(10) }).parse(req.body);
    return run(req, (c, u) => setRoutes(c, u, tenantId, 'voice', b.providerIds));
  });
  app.get('/internal/tenants/:tenantId/routes/voice', async (req) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    return run(req, (c) => getRoutes(c, tenantId, 'voice'));
  });
  app.put('/internal/tenants/:tenantId/fallback', async (req) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    const b = z.object({ holdingMessage: z.string().min(1).max(500), offerCallback: z.boolean(), humanTransfer: z.boolean(), voicemail: z.boolean() }).parse(req.body);
    return run(req, (c, u) => setFallbackPlan(c, u, tenantId, b));
  });
  app.get('/internal/tenants/:tenantId/fallback', async (req) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    return run(req, (c) => getFallbackPlan(c, tenantId));
  });

  // Where a client's calls go when a workflow passes the caller to a person: the client's agent phone.
  app.put('/internal/tenants/:tenantId/transfer', async (req) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    const b = z.object({ agentNumber: z.string().min(1).max(40), ringSeconds: z.number().int().min(5).max(60).default(25), whisper: z.boolean().default(true) }).strict().parse(req.body);
    return run(req, (c, u) => setTransferSettings(c, u, tenantId, b));
  });
  app.get('/internal/tenants/:tenantId/transfer', async (req) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    return run(req, (c) => getTransferSettings(c, tenantId));
  });
  app.delete('/internal/tenants/:tenantId/transfer', async (req) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    return run(req, (c, u) => clearTransferSettings(c, u, tenantId));
  });

  // ---- concurrency
  app.get('/internal/capacity', async (req) => run(req, async (c) => {
    const ps = (await c.query(`SELECT id, name FROM providers WHERE kind = 'telephony' AND status = 'active' ORDER BY name`)).rows;
    const load = await providerLoad(c, ps.map((p) => p.id as string));
    return ps.map((p) => ({ providerId: p.id, name: p.name, active: load.get(p.id)!.active, ceiling: load.get(p.id)!.ceiling }));
  }));
  app.put('/internal/tenants/:tenantId/entitlement', async (req) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    const b = z.object({
      inboundChannels: z.number().int().min(0).max(100_000), extraChannels: z.number().int().min(0).max(100_000).optional(),
      extraChannelCredits: z.string().regex(/^\d{1,10}(\.\d{1,4})?$/).optional(), overburstMultiplier: z.string().regex(/^\d{1,3}(\.\d{1,3})?$/).refine((v) => Number(v) >= 1, 'At least 1.').nullable().optional(),
    }).parse(req.body);
    const out = await run(req, (c, u) => setEntitlement(c, u, tenantId, b));
    // More channels: callers already waiting are served now, not when the next call ends.
    await promoteWaiting(ctx.callDeps, [tenantId]);
    return out;
  });
  app.get('/internal/tenants/:tenantId/entitlement', async (req) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    return run(req, (c) => getEntitlement(c, tenantId));
  });
  app.post('/internal/tenants/:tenantId/channel-charges', async (req) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    const b = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).parse(req.body);
    return run(req, (c, u) => chargeExtraChannels(c, u, tenantId, b.month));
  });
  app.post('/internal/queue/expire', async (req) => {
    await ctx.internal(req);                                      // who is asking is checked before anything changes
    const b = z.object({ maxWaitSeconds: z.number().int().min(1).max(86_400).default(300) }).parse(req.body ?? {});
    await promoteWaiting(ctx.callDeps);                          // a free channel goes to a waiting caller before anyone is timed out
    const out = await run(req, (c, u) => expireQueued(c, u, b.maxWaitSeconds));
    // Their lines are ended outside the transaction; the provider's report of the end then costs the time they were held.
    const hungUp = await hangUpCalls(ctx.callDeps, out.hangups);
    return { expired: out.expired, hungUp };
  });

  // ---- funding monitor
  app.put('/internal/providers/:providerId/funding-thresholds', async (req) => {
    const { providerId } = z.object({ providerId: id }).parse(req.params);
    const num = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/);
    const b = z.object({ currency: z.string().length(3).transform((v) => v.toUpperCase()), warnBelow: num, criticalBelow: num }).parse(req.body);
    await run(req, (c, u) => setThresholds(c, u, providerId, b));
    return { ok: true };
  });
  app.get('/internal/funding/status', async (req) => run(req, (c) => fundingStatus(c)));
}
