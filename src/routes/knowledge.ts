import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withActor, type Actor } from '../db.js';
import { addVersion, articleSchema, createArticle, getArticle, listArticles, publish, reject, retireArticle, searchKnowledge, versionSchema } from '../store/knowledge.js';
import { activate, check, checkSchema, decide, decisionSchema, getLevels, getVersion, levelsSchema, listDecisions, policyOverview, propose, proposeSchema, setLevels } from '../store/policy.js';

interface Ctx { pool: pg.Pool; internal(req: FastifyRequest): Promise<{ userId: string; actor: Actor }> }
const id = z.string().uuid();

/** Phase 7, the knowledge base and policy. Staff only for now. */
export function registerKnowledgeRoutes(app: FastifyInstance, ctx: Ctx): void {
  const run = async <T>(req: FastifyRequest, fn: (c: pg.PoolClient, userId: string) => Promise<T>) => {
    const s = await ctx.internal(req);
    return withActor(ctx.pool, s.actor, (c) => fn(c, s.userId));
  };
  const tenant = z.object({ tenantId: id });

  // ---- knowledge
  app.get('/internal/tenants/:tenantId/knowledge', async (req) => { const { tenantId } = tenant.parse(req.params); return run(req, (c) => listArticles(c, tenantId)); });
  app.post('/internal/tenants/:tenantId/knowledge', async (req, reply) => { const { tenantId } = tenant.parse(req.params); const b = articleSchema.parse(req.body); return reply.code(201).send(await run(req, (c, u) => createArticle(c, u, tenantId, b))); });
  app.get('/internal/tenants/:tenantId/knowledge/search', async (req) => {
    const { tenantId } = tenant.parse(req.params);
    const q = z.object({ q: z.string().min(1).max(300), language: z.string().regex(/^[a-z]{2,3}$/).optional(), channel: z.enum(['voice', 'text']).default('text'), limit: z.coerce.number().int().min(1).max(10).optional() }).parse(req.query);
    return run(req, (c) => searchKnowledge(c, tenantId, q));
  });
  app.get('/internal/knowledge/:articleId', async (req) => { const { articleId } = z.object({ articleId: id }).parse(req.params); return run(req, (c) => getArticle(c, articleId)); });
  app.post('/internal/knowledge/:articleId/versions', async (req, reply) => { const { articleId } = z.object({ articleId: id }).parse(req.params); const b = versionSchema.parse(req.body); return reply.code(201).send(await run(req, (c, u) => addVersion(c, u, articleId, b))); });
  app.post('/internal/knowledge/:articleId/retire', async (req) => { const { articleId } = z.object({ articleId: id }).parse(req.params); return run(req, (c, u) => retireArticle(c, u, articleId)); });
  app.post('/internal/knowledge-versions/:versionId/publish', async (req) => { const { versionId } = z.object({ versionId: id }).parse(req.params); const b = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {}); return run(req, (c, u) => publish(c, u, versionId, b.note)); });
  app.post('/internal/knowledge-versions/:versionId/reject', async (req) => { const { versionId } = z.object({ versionId: id }).parse(req.params); const b = z.object({ note: z.string().min(1).max(500) }).parse(req.body); return run(req, (c, u) => reject(c, u, versionId, b.note)); });

  // ---- policy
  app.get('/internal/tenants/:tenantId/policy', async (req) => { const { tenantId } = tenant.parse(req.params); return run(req, (c) => policyOverview(c, tenantId)); });
  app.put('/internal/tenants/:tenantId/policy/levels', async (req) => { const { tenantId } = tenant.parse(req.params); const b = levelsSchema.parse(req.body); return run(req, (c, u) => setLevels(c, u, tenantId, b)); });
  app.get('/internal/tenants/:tenantId/policy/levels', async (req) => { const { tenantId } = tenant.parse(req.params); return run(req, async (c) => ({ levels: await getLevels(c, tenantId) })); });
  app.post('/internal/tenants/:tenantId/policy/proposals', async (req, reply) => { const { tenantId } = tenant.parse(req.params); const b = proposeSchema.parse(req.body); return reply.code(201).send(await run(req, (c, u) => propose(c, u, tenantId, b))); });
  app.get('/internal/policy-versions/:versionId', async (req) => { const { versionId } = z.object({ versionId: id }).parse(req.params); return run(req, (c) => getVersion(c, versionId)); });
  app.post('/internal/policy-versions/:versionId/decision', async (req) => { const { versionId } = z.object({ versionId: id }).parse(req.params); const b = decisionSchema.parse(req.body); return run(req, (c, u) => decide(c, u, versionId, b)); });
  app.post('/internal/policy-versions/:versionId/activate', async (req) => { const { versionId } = z.object({ versionId: id }).parse(req.params); return run(req, (c, u) => activate(c, u, versionId)); });
  app.post('/internal/tenants/:tenantId/policy/check', async (req) => { const { tenantId } = tenant.parse(req.params); const b = checkSchema.parse(req.body); return run(req, (c) => check(c, tenantId, b)); });
  app.get('/internal/tenants/:tenantId/policy/decisions', async (req) => { const { tenantId } = tenant.parse(req.params); return run(req, (c) => listDecisions(c, tenantId)); });
}
