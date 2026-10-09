import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withActor, type Actor } from '../db.js';
import { DID_FAILURE_REASONS, listPool, recordDidFailure } from '../store/dids.js';
import { OUTCOMES, outboundAnalytics, recordOutcome } from '../store/outbound.js';
import { addRecording, CONTENT_TYPES, listRecordings, recordingAudio, recordingGaps, recordingIndex } from '../store/recordings.js';
import { measureStitching, type RunDeps } from '../store/runs.js';
import { getVersion, getWorkflow, listVersions } from '../store/workflows.js';
import { AppError } from '../errors.js';
import { scenario } from './workflows.js';

interface Ctx { pool: pg.Pool; runDeps: RunDeps; internal(req: FastifyRequest): Promise<{ userId: string; actor: Actor }> }
const id = z.string().uuid();

/** Phase 3: pre-recorded audio and stitching, the DID pool, and outbound outcomes. All staff-only. */
export function registerStitchingRoutes(app: FastifyInstance, ctx: Ctx): void {
  const run = async <T>(req: FastifyRequest, fn: (c: pg.PoolClient, userId: string) => Promise<T>) => {
    const s = await ctx.internal(req);
    return withActor(ctx.pool, s.actor, (c) => fn(c, s.userId));
  };

  // Audio travels as base64 in JSON, so these routes allow a larger body than the rest (5 MB of audio is about 7 MB of text).
  app.post('/internal/tenants/:tenantId/recordings', { bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    const body = z.object({
      language: z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/), text: z.string().min(1).max(2000), label: z.string().max(200).optional(),
      contentType: z.enum(CONTENT_TYPES), audioBase64: z.string().min(4).max(7_500_000), durationMs: z.number().int().min(1).max(600_000),
    }).parse(req.body);
    return reply.status(201).send(await run(req, (c, u) => addRecording(c, u, { tenantId, ...body })));
  });
  app.get('/internal/tenants/:tenantId/recordings', async (req) => {
    const { tenantId } = z.object({ tenantId: id }).parse(req.params);
    return run(req, (c) => listRecordings(c, tenantId));
  });
  app.get('/internal/recordings/:recordingId/audio', async (req, reply) => {
    const { recordingId } = z.object({ recordingId: id }).parse(req.params);
    const r = await run(req, (c) => recordingAudio(c, recordingId));
    return reply.header('content-type', r.content_type).header('x-content-sha256', r.sha256).header('x-content-type-options', 'nosniff').send(r.audio);
  });
  app.get('/internal/workflows/:workflowId/recording-gaps', async (req) => {
    const { workflowId } = z.object({ workflowId: id }).parse(req.params);
    const { versionId } = z.object({ versionId: id.optional() }).parse(req.query);
    return run(req, async (c) => {
      const w = await getWorkflow(c, workflowId);
      const v = versionId ? await getVersion(c, versionId) : (await listVersions(c, workflowId))[0];
      if (!v) throw new AppError(404, 'This workflow has no versions.');
      return recordingGaps(v.definition, await recordingIndex(c, w.tenant_id));
    });
  });
  app.post('/internal/workflows/:workflowId/stitching-report', async (req) => {
    await ctx.internal(req);
    const { workflowId } = z.object({ workflowId: id }).parse(req.params);
    const body = z.object({ versionId: id.optional(), voiceProviderId: id, scenarios: z.array(scenario).min(1).max(500) }).parse(req.body);
    return measureStitching(ctx.runDeps, { workflowId, ...body, scenarios: body.scenarios as never });
  });

  app.get('/internal/dids', async (req) => {
    const { tenantId } = z.object({ tenantId: id.optional() }).parse(req.query);
    return run(req, (c) => listPool(c, tenantId));
  });
  app.post('/internal/calls/:callId/did-failure', async (req, reply) => {
    const { callId } = z.object({ callId: id }).parse(req.params);
    const body = z.object({ reason: z.enum(DID_FAILURE_REASONS) }).parse(req.body);
    return reply.status(201).send(await run(req, (c, u) => recordDidFailure(c, u, callId, body.reason)));
  });

  app.post('/internal/calls/:callId/outcome', async (req, reply) => {
    const { callId } = z.object({ callId: id }).parse(req.params);
    const body = z.object({
      outcome: z.enum(OUTCOMES),
      callback: z.object({ day: z.number().int().min(0).max(6), hour: z.number().int().min(0).max(23), timeZone: z.string().min(1).max(64) }).optional(),
    }).parse(req.body);
    return reply.status(201).send(await run(req, (c, u) => recordOutcome(c, u, callId, body)));
  });
  app.get('/internal/analytics/outbound', async (req) => {
    const q = z.object({ tenantId: id.optional(), projectId: id.optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }).parse(req.query);
    const to = q.to ?? new Date(); const from = q.from ?? new Date(to.getTime() - 7 * 24 * 3600 * 1000);
    if (from >= to) throw new AppError(400, 'The start of the period must be before its end.');
    return run(req, (c) => outboundAnalytics(c, { tenantId: q.tenantId, projectId: q.projectId, from, to }));
  });
}
