import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withActor, type Actor } from '../db.js';
import { createIntegration, listIntegrations } from '../store/integrations.js';
import { abandonStaleRuns, getRun, listRuns, replyRun, simulate, startRun, type RunDeps } from '../store/runs.js';
import * as wf from '../store/workflows.js';
import { instantiate, templateFor, TEMPLATES } from '../workflows/templates.js';
import { validateDefinition } from '../workflows/validate.js';
import { CONTACT_OUTCOMES } from '../workflows/definition.js';
import { AppError } from '../errors.js';

interface Ctx {
  pool: pg.Pool; key: Buffer; runDeps: RunDeps;
  internal(req: FastifyRequest): Promise<{ userId: string; actor: Actor }>;
}

const id = z.string().uuid();
const environment = z.enum(['staging', 'production']);
const json = z.unknown();

export const scenario = z.object({
  name: z.string().min(1).max(200),
  variables: z.record(z.string(), json).default({}),
  replies: z.array(z.string().max(2000)).optional(),
  integrations: z.record(z.string(), json).optional(),
  expect: z.object({
    outcome: z.string().optional(), says: z.array(z.string()).optional(),
    doesNotSay: z.array(z.string()).optional(), handoff: z.string().optional(), contact: z.enum([...CONTACT_OUTCOMES, 'none']).optional(),
    callback: z.union([z.object({ day: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23), timeZone: z.string().max(60).optional() }).strict(), z.enum(['none', 'unread'])]).optional(),
  }).optional(),
});

export function registerWorkflowRoutes(app: FastifyInstance, ctx: Ctx): void {
  const run = async <T>(req: FastifyRequest, fn: (c: pg.PoolClient, userId: string) => Promise<T>) => {
    const s = await ctx.internal(req);
    return withActor(ctx.pool, s.actor, (c) => fn(c, s.userId));
  };

  app.post('/internal/tenants/:tenantId/workflows', async (req, reply) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    const body = z.object({ name: z.string(), definition: json, note: z.string().max(500).optional() }).parse(req.body);
    return reply.status(201).send(await run(req, (c, u) => wf.createWorkflow(c, u, { tenantId, ...body })));
  });
  app.get('/internal/workflows', async (req) => {
    const { tenantId } = z.object({ tenantId: id.optional() }).parse(req.query);
    return run(req, (c) => wf.listWorkflows(c, tenantId));
  });
  // A draft check: nothing is saved.
  app.post('/internal/workflows/validate', async (req) => {
    await ctx.internal(req);
    return validateDefinition(z.object({ definition: json }).parse(req.body).definition);
  });
  app.get('/internal/workflows/:workflowId', async (req) => {
    const { workflowId } = z.object({ workflowId: id }).parse(req.params);
    return run(req, async (c) => ({ ...(await wf.getWorkflow(c, workflowId)), ...(await wf.deployments(c, workflowId)), versions: await wf.listVersions(c, workflowId) }));
  });
  app.post('/internal/workflows/:workflowId/versions', async (req, reply) => {
    const { workflowId } = z.object({ workflowId: id }).parse(req.params);
    const body = z.object({ definition: json, note: z.string().max(500).optional() }).parse(req.body);
    return reply.status(201).send(await run(req, (c, u) => wf.saveVersion(c, u, workflowId, body)));
  });
  app.get('/internal/workflows/:workflowId/versions', async (req) => {
    const { workflowId } = z.object({ workflowId: id }).parse(req.params);
    return run(req, (c) => wf.listVersions(c, workflowId));
  });
  app.get('/internal/workflow-versions/:versionId', async (req) => {
    const { versionId } = z.object({ versionId: id }).parse(req.params);
    return run(req, (c) => wf.getVersion(c, versionId));
  });

  app.post('/internal/workflows/:workflowId/deploy', async (req, reply) => {
    const { workflowId } = z.object({ workflowId: id }).parse(req.params);
    const body = z.object({ versionId: id, environment }).parse(req.body);
    return reply.status(201).send(await run(req, (c, u) => wf.deploy(c, u, workflowId, body)));
  });
  app.post('/internal/workflows/:workflowId/rollback', async (req, reply) => {
    const { workflowId } = z.object({ workflowId: id }).parse(req.params);
    const body = z.object({ environment }).parse(req.body);
    return reply.status(201).send(await run(req, (c, u) => wf.rollback(c, u, workflowId, body.environment)));
  });
  app.get('/internal/workflows/:workflowId/deployments', async (req) => {
    const { workflowId } = z.object({ workflowId: id }).parse(req.params);
    return run(req, (c) => wf.deployments(c, workflowId));
  });

  app.post('/internal/workflows/:workflowId/simulate', async (req) => {
    const s = await ctx.internal(req);
    const { workflowId } = z.object({ workflowId: id }).parse(req.params);
    const body = z.object({ versionId: id.optional(), scenarios: z.array(scenario).min(1).max(500) }).parse(req.body);
    return simulate(ctx.runDeps, s.userId, { workflowId, versionId: body.versionId, scenarios: body.scenarios as never });
  });
  app.post('/internal/workflow-runs/sweep', async (req) => {
    const s = await ctx.internal(req);
    const body = z.object({ olderThanMinutes: z.number().int().min(5).max(60 * 24 * 30).default(60) }).parse(req.body ?? {});
    return abandonStaleRuns(ctx.runDeps, s.userId, body);
  });
  app.get('/internal/workflows/:workflowId/simulations', async (req) => {
    const { workflowId } = z.object({ workflowId: id }).parse(req.params);
    return run(req, async (c) => (await c.query(
      `SELECT b.id, b.total, b.passed, b.failed, b.gate_ok, b.created_at, v.major || '.' || v.minor AS version
         FROM simulation_batches b JOIN workflow_versions v ON v.id = b.version_id WHERE b.workflow_id = $1 ORDER BY b.created_at DESC LIMIT 50`, [workflowId])).rows);
  });
  app.get('/internal/simulations/:batchId', async (req) => {
    const { batchId } = z.object({ batchId: id }).parse(req.params);
    return run(req, async (c) => (await c.query('SELECT id, workflow_id, version_id, total, passed, failed, results, created_at FROM simulation_batches WHERE id = $1', [batchId])).rows[0] ?? null);
  });

  app.post('/internal/workflows/:workflowId/runs', async (req, reply) => {
    const s = await ctx.internal(req);
    const { workflowId } = z.object({ workflowId: id }).parse(req.params);
    const body = z.object({ environment, kind: z.enum(['test', 'live']).default('test'), variables: z.record(z.string(), json).default({}), callId: id.optional() }).parse(req.body);
    return reply.status(201).send(await startRun(ctx.runDeps, s.userId, { workflowId, ...body, variables: body.variables as never }));
  });
  app.get('/internal/workflows/:workflowId/runs', async (req) => {
    const { workflowId } = z.object({ workflowId: id }).parse(req.params);
    return run(req, (c) => listRuns(c, workflowId));
  });
  app.post('/internal/workflow-runs/:runId/reply', async (req) => {
    await ctx.internal(req);
    const { runId } = z.object({ runId: id }).parse(req.params);
    const body = z.object({ text: z.string().max(2000), expectedVersion: z.number().int().min(0).optional() }).parse(req.body);
    return replyRun(ctx.runDeps, runId, body.text, body.expectedVersion);
  });
  app.get('/internal/workflow-runs/:runId', async (req) => {
    const { runId } = z.object({ runId: id }).parse(req.params);
    return run(req, (c) => getRun(c, runId));
  });

  app.get('/internal/workflow-templates', async (req) => {
    await ctx.internal(req);
    return TEMPLATES.map((t) => ({ key: t.key, title: t.title, description: t.description, entry: t.entry, workflows: t.workflows.map((w) => ({ key: w.key, description: w.description })) }));
  });
  // Creates every workflow in the template for a client, all or nothing. Each is saved as version 1.0, not yet deployed.
  app.post('/internal/tenants/:tenantId/workflows/from-template', async (req, reply) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    const body = z.object({ template: z.string(), prefix: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,20}$/).optional() }).parse(req.body);
    const t = templateFor(body.template);
    if (!t) throw new AppError(404, `There is no template called "${body.template}".`);
    return reply.status(201).send(await run(req, async (c, u) => {
      const made = [];
      for (const w of instantiate(t, body.prefix)) made.push(await wf.createWorkflow(c, u, { tenantId, name: w.name, definition: w.definition, note: `From the "${t.title}" template` }));
      return { entry: `${body.prefix ?? ''}${t.entry}`, workflows: made.map((m) => ({ id: m.workflow.id, name: m.workflow.name, versionId: m.version.id, version: m.version.version, valid: m.version.valid })) };
    }));
  });

  app.post('/internal/tenants/:tenantId/integrations', async (req, reply) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    const body = z.object({
      name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), baseUrl: z.string().max(500),
      authHeader: z.string().max(64).optional(), authSecret: z.string().min(1).max(2000).optional(),
    }).parse(req.body);
    return reply.status(201).send(await run(req, (c, u) => createIntegration(c, ctx.key, u, { tenantId, ...body })));
  });
  app.get('/internal/tenants/:tenantId/integrations', async (req) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    return run(req, (c) => listIntegrations(c, tenantId));
  });
}
