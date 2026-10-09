import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z, ZodError } from 'zod';
import { listAdapters } from './adapters/registry.js';
import { CAPABILITIES } from './adapters/types.js';
import type { Config } from './config.js';
import { withActor, type Actor } from './db.js';
import { AppError } from './errors.js';
import { hashToken, parseKey } from './secrets.js';
import { chargingAt, addChargingVersion, confirmVersion, listChargingVersions } from './store/charging.js';
import { eventsForCall } from './store/events.js';
import { addCreditEntry, addFundingEntry, creditSummary, fundingBalances } from './store/ledgers.js';
import { createProvider, getProvider, listProviders, setCapability } from './store/providers.js';
import { createProject, createTenant, createUser, listProjects, listTenants } from './store/tenants.js';

interface Session { userId: string; actor: Actor }

const money = z.string().regex(/^-?\d+(\.\d+)?$/, 'Use a decimal number as text, e.g. "12.50".');
const currency = z.string().length(3).transform((s) => s.toUpperCase());

export function buildApp(pool: pg.Pool, config: Config): FastifyInstance {
  const app = Fastify({ logger: false });
  const key = parseKey(config.VOICELAB_SECRET_KEY);

  async function authenticate(req: FastifyRequest): Promise<Session> {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw new AppError(401, 'Missing bearer token.');
    const { rows } = await pool.query('SELECT id, tenant_id, role FROM users WHERE token_hash = $1', [hashToken(token)]);
    const u = rows[0];
    if (!u) throw new AppError(401, 'Invalid token.');
    return {
      userId: u.id,
      actor: u.role === 'internal_admin' ? { kind: 'internal' } : { kind: 'client', tenantId: u.tenant_id },
    };
  }

  async function internal(req: FastifyRequest): Promise<Session> {
    const s = await authenticate(req);
    if (s.actor.kind !== 'internal') throw new AppError(403, 'Internal access only.');
    return s;
  }

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.message, details: err.details });
    if (err instanceof ZodError) return reply.status(400).send({ error: 'Invalid request.', details: err.issues });
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') return reply.status(409).send({ error: 'Already exists.' });
    if (pgCode === '23503') return reply.status(400).send({ error: 'Refers to something that does not exist.' });
    if (pgCode === '23514') return reply.status(400).send({ error: 'A value is out of range.' });
    if ((err as { statusCode?: number }).statusCode === 400) return reply.status(400).send({ error: 'Invalid request.' });
    console.error(err);
    return reply.status(500).send({ error: 'Internal error.' });
  });

  // ------------------------------------------------------------ health
  app.get('/health', async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS migrations FROM schema_migrations');
    return { ok: true, migrations: rows[0].migrations };
  });

  // --------------------------------------------------------- adapters
  // The admin UI builds its provider form from this; nothing is hardcoded there.
  app.get('/internal/adapters', async (req) => {
    await internal(req);
    return listAdapters().map(({ key, kind, displayName, docsUrl, params, defaultCapabilities }) =>
      ({ key, kind, displayName, docsUrl, params, defaultCapabilities }));
  });

  // ---------------------------------------------------------- tenants
  app.post('/internal/tenants', async (req, reply) => {
    const s = await internal(req);
    const body = z.object({ name: z.string().min(1) }).parse(req.body);
    return reply.status(201).send(await withActor(pool, s.actor, (c) => createTenant(c, s.userId, body.name)));
  });
  app.get('/internal/tenants', async (req) => {
    const s = await internal(req);
    return withActor(pool, s.actor, listTenants);
  });
  app.post('/internal/tenants/:tenantId/projects', async (req, reply) => {
    const s = await internal(req);
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(req.params);
    const body = z.object({ name: z.string().min(1) }).parse(req.body);
    return reply.status(201).send(await withActor(pool, s.actor, (c) => createProject(c, s.userId, tenantId, body.name)));
  });
  app.post('/internal/tenants/:tenantId/users', async (req, reply) => {
    const s = await internal(req);
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(req.params);
    const body = z.object({ email: z.string().email(), role: z.enum(['tenant_admin', 'tenant_user']) }).parse(req.body);
    return reply.status(201).send(await withActor(pool, s.actor, (c) => createUser(c, s.userId, { tenantId, ...body })));
  });
  app.post('/internal/tenants/:tenantId/credits', async (req, reply) => {
    const s = await internal(req);
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(req.params);
    const body = z.object({
      kind: z.enum(['grant', 'usage', 'adjustment']), credits: money,
      projectId: z.string().uuid().optional(), ref: z.string().optional(),
    }).parse(req.body);
    return reply.status(201).send(await withActor(pool, s.actor, (c) => addCreditEntry(c, s.userId, { tenantId, ...body })));
  });

  // -------------------------------------------------------- providers
  app.post('/internal/providers', async (req, reply) => {
    const s = await internal(req);
    const body = z.object({
      adapterKey: z.string(), name: z.string().min(1),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    }).parse(req.body);
    return reply.status(201).send(await withActor(pool, s.actor, (c) => createProvider(c, key, s.userId, body)));
  });
  app.get('/internal/providers', async (req) => {
    const s = await internal(req);
    return withActor(pool, s.actor, listProviders);
  });
  app.get('/internal/providers/:id', async (req) => {
    const s = await internal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return withActor(pool, s.actor, (c) => getProvider(c, id));
  });
  app.put('/internal/providers/:id/capabilities/:capability', async (req) => {
    const s = await internal(req);
    const { id, capability } = z.object({ id: z.string().uuid(), capability: z.enum(CAPABILITIES) }).parse(req.params);
    const body = z.object({ support: z.enum(['native', 'composable', 'unsupported']), notes: z.string().optional() }).parse(req.body);
    await withActor(pool, s.actor, (c) => setCapability(c, s.userId, id, capability, body.support, body.notes));
    return { ok: true };
  });

  // --------------------------------------------------------- charging
  app.post('/internal/providers/:id/charging', async (req, reply) => {
    const s = await internal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      effectiveFrom: z.coerce.date(),
      billingIncrementSeconds: z.number().int().positive(),
      minimumChargeSeconds: z.number().int().min(0).optional(),
      rounding: z.enum(['up', 'nearest', 'down']).optional(),
      concurrencyLimit: z.number().int().positive().nullable().optional(),
      burstPremiumMultiplier: z.number().min(1).nullable().optional(),
      notes: z.string().optional(),
      components: z.array(z.object({
        component: z.enum(['telephony_leg', 'stt', 'llm', 'tts', 'platform', 'concurrency', 'other']),
        unit: z.enum(['per_minute', 'per_second', 'per_character', 'per_token', 'per_credit', 'flat']),
        rate: money, currency, billingLine: z.string().optional(),
      })).min(1),
    }).parse(req.body);
    return reply.status(201).send(await withActor(pool, s.actor, (c) => addChargingVersion(c, s.userId, id, body)));
  });
  app.get('/internal/providers/:id/charging', async (req) => {
    const s = await internal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { at } = z.object({ at: z.coerce.date().optional() }).parse(req.query);
    return withActor(pool, s.actor, async (c) => (at ? chargingAt(c, id, at) : listChargingVersions(c, id)));
  });
  app.post('/internal/charging/:versionId/confirm', async (req) => {
    const s = await internal(req);
    const { versionId } = z.object({ versionId: z.string().uuid() }).parse(req.params);
    const body = z.object({ sourceUrl: z.string().url() }).parse(req.body);
    return withActor(pool, s.actor, (c) => confirmVersion(c, s.userId, versionId, body.sourceUrl));
  });

  // ---------------------------------------------------- funding ledger
  app.post('/internal/providers/:id/funding', async (req, reply) => {
    const s = await internal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      kind: z.enum(['topup', 'usage', 'adjustment']), amount: money, currency, ref: z.string().optional(),
    }).parse(req.body);
    return reply.status(201).send(await withActor(pool, s.actor, (c) => addFundingEntry(c, s.userId, { providerId: id, ...body })));
  });
  app.get('/internal/providers/:id/funding', async (req) => {
    const s = await internal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return withActor(pool, s.actor, (c) => fundingBalances(c, id));
  });

  // ------------------------------------------------------- event log
  app.get('/internal/calls/:callId/events', async (req) => {
    const s = await internal(req);
    const { callId } = z.object({ callId: z.string().uuid() }).parse(req.params);
    return withActor(pool, s.actor, (c) => eventsForCall(c, callId));
  });

  // --------------------------------------------------- client portal
  app.get('/client/credits', async (req) => {
    const s = await authenticate(req);
    if (s.actor.kind !== 'client') throw new AppError(403, 'Client access only.');
    return withActor(pool, s.actor, (c) => creditSummary(c));
  });
  app.get('/client/projects', async (req) => {
    const s = await authenticate(req);
    if (s.actor.kind !== 'client') throw new AppError(403, 'Client access only.');
    return withActor(pool, s.actor, listProjects);
  });

  return app;
}
