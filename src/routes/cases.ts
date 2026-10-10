import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { bestTimesToCall } from '../cases/policy.js';
import { withActor, type Actor } from '../db.js';
import {
  caseSummary, cancelCase, checkPayments, completeAction, decideCase, decisionSchema, dispatchDue, getCase, getSettings, listCases, listOutbox, openCase, openCaseSchema,
  policySchema, promiseSchema, recordPromise, refreshPayment, scheduleCallback, setContactPolicy, setSettings, settingsSchema, sweepAgeing, type CaseDeps,
} from '../store/cases.js';
import { getContactPolicy } from '../store/dnc.js';

interface Ctx { cases: CaseDeps; internal(req: FastifyRequest): Promise<{ userId: string; actor: Actor }> }
const id = z.string().uuid();

/** Phase 7, case management. Staff only: a case holds a person's balance and how they were treated. */
export function registerCaseRoutes(app: FastifyInstance, ctx: Ctx): void {
  const pool: pg.Pool = ctx.cases.calls.pool;
  const run = async <T>(req: FastifyRequest, fn: (c: pg.PoolClient, userId: string) => Promise<T>) => {
    const s = await ctx.internal(req);
    return withActor(pool, s.actor, (c) => fn(c, s.userId));
  };
  const tenant = z.object({ tenantId: id });

  app.get('/internal/tenants/:tenantId/case-settings', async (req) => { const { tenantId } = tenant.parse(req.params); return run(req, async (c) => ({ settings: await getSettings(c, tenantId), contactPolicy: await getContactPolicy(c, tenantId) })); });
  app.put('/internal/tenants/:tenantId/case-settings', async (req) => { const { tenantId } = tenant.parse(req.params); const b = settingsSchema.parse(req.body ?? {}); return run(req, (c, u) => setSettings(c, u, tenantId, b)); });
  app.put('/internal/tenants/:tenantId/contact-policy', async (req) => { const { tenantId } = tenant.parse(req.params); const b = policySchema.parse(req.body ?? {}); return run(req, (c, u) => setContactPolicy(c, u, tenantId, b)); });

  app.post('/internal/tenants/:tenantId/cases', async (req, reply) => {
    const { tenantId } = tenant.parse(req.params);
    const b = openCaseSchema.parse(req.body);
    const out = await run(req, (c, u) => openCase(c, ctx.cases.calls.key, u, tenantId, b));
    return reply.code(201).send(out);
  });
  app.get('/internal/tenants/:tenantId/cases', async (req) => {
    const { tenantId } = tenant.parse(req.params);
    const q = z.object({ status: z.enum(['open', 'decision_required', 'closed']).optional() }).parse(req.query);
    return run(req, (c) => listCases(c, tenantId, q.status));
  });
  app.get('/internal/tenants/:tenantId/cases-summary', async (req) => { const { tenantId } = tenant.parse(req.params); return run(req, (c) => caseSummary(c, tenantId)); });
  app.get('/internal/cases/:caseId', async (req) => { const { caseId } = z.object({ caseId: id }).parse(req.params); return run(req, (c) => getCase(c, caseId)); });
  app.get('/internal/cases/:caseId/best-times', async (req) => {
    const { caseId } = z.object({ caseId: id }).parse(req.params);
    return run(req, async (c) => bestTimesToCall((await c.query('SELECT local_dow AS dow, local_hour AS hour, outcome FROM case_attempts WHERE case_id = $1', [caseId])).rows));
  });
  app.post('/internal/cases/:caseId/callbacks', async (req, reply) => {
    const { caseId } = z.object({ caseId: id }).parse(req.params);
    const b = z.object({ at: z.string().datetime({ offset: true }), note: z.string().max(300).optional() }).parse(req.body);
    const out = await run(req, (c, u) => scheduleCallback(c, u, caseId, { at: new Date(b.at), note: b.note }));
    return reply.code(201).send(out);
  });
  app.post('/internal/cases/:caseId/promises', async (req, reply) => {
    const { caseId } = z.object({ caseId: id }).parse(req.params);
    const b = promiseSchema.parse(req.body);
    await ctx.internal(req);
    await refreshPayment(ctx.cases, caseId).catch(() => null);          // a promise counts only what is paid after it is made
    const out = await run(req, (c, u) => recordPromise(c, u, caseId, b));
    return reply.code(201).send(out);
  });
  app.post('/internal/cases/:caseId/decision', async (req) => {
    const { caseId } = z.object({ caseId: id }).parse(req.params);
    const b = decisionSchema.parse(req.body);
    return run(req, (c, u) => decideCase(c, u, caseId, b));
  });
  app.post('/internal/cases/:caseId/close', async (req) => {
    const { caseId } = z.object({ caseId: id }).parse(req.params);
    const b = z.object({ reason: z.string().min(1).max(200) }).parse(req.body);
    return run(req, (c, u) => cancelCase(c, u, caseId, b.reason));
  });
  app.get('/internal/tenants/:tenantId/case-outbox', async (req) => { const { tenantId } = tenant.parse(req.params); return run(req, (c) => listOutbox(c, tenantId)); });
  app.post('/internal/case-actions/:actionId/complete', async (req) => {
    const { actionId } = z.object({ actionId: id }).parse(req.params);
    const b = z.object({ note: z.string().max(300).optional() }).parse(req.body ?? {});
    return run(req, (c, u) => completeAction(c, u, actionId, b.note));
  });

  // The scheduled jobs. Run the dispatcher every minute (it places a callback within minutes of exactly its time); payments and ageing less often.
  app.post('/internal/cases/dispatch', async (req) => { await ctx.internal(req); return dispatchDue(ctx.cases); });
  app.post('/internal/tenants/:tenantId/cases/check-payments', async (req) => { const { tenantId } = tenant.parse(req.params); await ctx.internal(req); return checkPayments(ctx.cases, tenantId); });
  app.post('/internal/tenants/:tenantId/cases/sweep-ageing', async (req) => { const { tenantId } = tenant.parse(req.params); return run(req, (c) => sweepAgeing(c, tenantId)); });
}
