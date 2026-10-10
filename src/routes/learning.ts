import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withActor, type Actor } from '../db.js';
import {
  checkDrift, clusterReport, decidePromotion, demote, distil, finishPromotion, getLearningConfig, getPromotion, learningConfigSchema, learningSummary, listPromotions,
  promotionFinancial, reviewPromotion, setLearningConfig, sweepAudio, sweepDrift, type LearnDeps, type PromotionStatus,
} from '../store/learning.js';

interface Ctx { learn: LearnDeps; internal(req: FastifyRequest): Promise<{ userId: string; actor: Actor }> }
const id = z.string().uuid();

/** Phase 6: the self-learning promotion loop. Staff only: it shows cost, and promotes and demotes what callers hear. */
export function registerLearningRoutes(app: FastifyInstance, ctx: Ctx): void {
  const pool: pg.Pool = ctx.learn.pool;
  const run = async <T>(req: FastifyRequest, fn: (c: pg.PoolClient, userId: string) => Promise<T>) => {
    const s = await ctx.internal(req);
    return withActor(pool, s.actor, (c) => fn(c, s.userId));
  };
  const tenant = z.object({ tenantId: id });

  app.get('/internal/tenants/:tenantId/learning', async (req) => {
    const { tenantId } = tenant.parse(req.params);
    return run(req, async (c) => ({ config: await getLearningConfig(c, tenantId), summary: await learningSummary(c, tenantId), ...(await clusterReport(c, tenantId)) }));
  });
  app.put('/internal/tenants/:tenantId/learning/config', async (req) => {
    const { tenantId } = tenant.parse(req.params);
    const b = learningConfigSchema.parse(req.body ?? {});
    return run(req, (c, u) => setLearningConfig(c, u, tenantId, b));
  });
  app.get('/internal/tenants/:tenantId/learning/promotions', async (req) => {
    const { tenantId } = tenant.parse(req.params);
    const q = z.object({ status: z.enum(['in_review', 'approved', 'promoted', 'demoted', 'rejected']).optional() }).parse(req.query);
    return run(req, (c) => listPromotions(c, tenantId, q.status as PromotionStatus | undefined));
  });
  // Draw up scripts for every cluster past the threshold; optionally put them straight to the councils.
  app.post('/internal/tenants/:tenantId/learning/scan', async (req) => {
    const { tenantId } = tenant.parse(req.params);
    const b = z.object({ workflow: z.string().max(100).optional(), node: z.string().max(100).optional(), review: z.boolean().optional() }).parse(req.body ?? {});
    const s = await ctx.internal(req);
    const out = await distil(ctx.learn, s.userId, { tenantId, workflow: b.workflow, node: b.node });
    const reviewed = [];
    if (b.review) for (const pid of out.created) { try { reviewed.push(await reviewPromotion(ctx.learn, s.userId, pid)); } catch { /* the rest still go to the councils */ } }
    return { ...out, reviewed: reviewed.map((p) => ({ id: p.id, status: p.status })) };
  });
  // The scheduled job: finish approved scripts whose audio has arrived, then screen every promoted node for drift.
  app.post('/internal/learning/sweep', async (req) => {
    const s = await ctx.internal(req);
    const audio = await sweepAudio(ctx.learn, s.userId);
    const drift = await sweepDrift(ctx.learn, s.userId);
    return { ...audio, ...drift };
  });
  app.get('/internal/promotions/:promotionId', async (req) => {
    const { promotionId } = z.object({ promotionId: id }).parse(req.params);
    return run(req, (c) => getPromotion(c, promotionId));
  });
  app.get('/internal/promotions/:promotionId/financial', async (req) => {
    const { promotionId } = z.object({ promotionId: id }).parse(req.params);
    return run(req, (c) => promotionFinancial(c, promotionId));
  });
  app.post('/internal/promotions/:promotionId/review', async (req) => {
    const { promotionId } = z.object({ promotionId: id }).parse(req.params);
    const s = await ctx.internal(req);
    return reviewPromotion(ctx.learn, s.userId, promotionId);
  });
  app.post('/internal/promotions/:promotionId/decision', async (req) => {
    const { promotionId } = z.object({ promotionId: id }).parse(req.params);
    const b = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(1000).optional() }).parse(req.body);
    const s = await ctx.internal(req);
    return decidePromotion(ctx.learn, s.userId, promotionId, b);
  });
  app.post('/internal/promotions/:promotionId/audio', async (req) => {
    const { promotionId } = z.object({ promotionId: id }).parse(req.params);
    const s = await ctx.internal(req);
    return finishPromotion(ctx.learn, s.userId, promotionId);
  });
  app.post('/internal/promotions/:promotionId/drift-check', async (req) => {
    const { promotionId } = z.object({ promotionId: id }).parse(req.params);
    const s = await ctx.internal(req);
    return checkDrift(ctx.learn, s.userId, promotionId);
  });
  app.post('/internal/promotions/:promotionId/demote', async (req) => {
    const { promotionId } = z.object({ promotionId: id }).parse(req.params);
    const b = z.object({ reason: z.string().min(1).max(1000) }).parse(req.body);
    return run(req, (c, u) => demote(c, u, promotionId, { reason: b.reason }));
  });
}
