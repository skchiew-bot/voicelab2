import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z, ZodError } from 'zod';
import { listAdapters } from './adapters/registry.js';
import { CAPABILITIES, type Fetch } from './adapters/types.js';
import type { Config } from './config.js';
import { withActor, type Actor } from './db.js';
import { AppError } from './errors.js';
import { hashToken, parseKey } from './secrets.js';
import { chargingAt, addChargingVersion, confirmVersion, listChargingVersions } from './store/charging.js';
import { eventsForCall } from './store/events.js';
import { addCreditEntry, addFundingEntry, creditSummary, fundingBalances } from './store/ledgers.js';
import { addFxRate, addRateCard, campaignCosts, getCallCost, listFxRates, listRateCards, recordCallCost } from './store/costs.js';
import { addNumbers, contactHash, contactKeyFrom, declareRegistry, dncKeyFrom, gateOutbound, normalizeE164, listRegistries, preDialCheck, removeNumber } from './store/dnc.js';
import { addNumber, callKnown, callQueued, costCall, getCall, hangUpCalls, listCalls, listNumbers, loadProvider, credentials, placeOutboundCall, processWebhook, relayTarget, setNumberWorkflow, type CallDeps } from './store/calls.js';
import { closeRelay, failed as relayFailed, mediaLinkValid, onRelayMessage, openRelay, relayCallToken, standbyCheck, STANDBY_POLL_MS, type RelayDeps, type RelaySession } from './store/relay.js';
import { recordingAudio } from './store/recordings.js';
import { parseRelay, relaySettings, twimlRelay, type RelayOutbound } from './telephony/relay.js';
import { DEFAULT_FALLBACK } from './resilience/fallback.js';
import { registerJourneyRoutes } from './routes/journey.js';
import { registerAppointmentRoutes } from './routes/appointments.js';
import { registerCaseRoutes } from './routes/cases.js';
import { registerKnowledgeRoutes } from './routes/knowledge.js';
import { registerLearningRoutes } from './routes/learning.js';
import { registerResilienceRoutes } from './routes/resilience.js';
import { registerStitchingRoutes } from './routes/stitching.js';
import { registerWorkflowRoutes } from './routes/workflows.js';
import type { HttpDeps } from './workflows/integrations.js';
import { controlTower } from './store/control-tower.js';
import { changeLog, changeLogQuery } from './store/change-log.js';
import { controlTowerPanels } from './store/panels.js';
import { listDeliveries, listSubscriptions, sendTest, subscribe, subscriptionSchema, sweepAlerts, unsubscribe } from './store/alerts.js';
import { actionSchema, controlState, runAction } from './store/control-actions.js';
import { CROSS_CUTTING, DECISIONS, PHASES } from './progress.js';
import { clientAddUser, clientCalls, clientDisableUser, clientSummary, clientUsers } from './store/portal.js';
import { listReconciliations, reconcileCall, reconcileSweep } from './store/reconcile.js';
import { countsOf, createScheduler, drain, listJobs, runJobNow, updateJob, type Job } from './scheduler.js';
import { sweepFaults } from './store/call-end.js';
import { expireQueued } from './store/concurrency.js';
import { abandonStaleRuns } from './store/runs.js';
import { checkPayments, cleanNote, dispatchDue, sweepAgeing } from './store/cases.js';
import { sweepAudio, sweepDrift } from './store/learning.js';
import { sweepReminders } from './store/appointments.js';
import { REFERENCE_NOTE, REFERENCE_RATES, referenceRateFor } from './reference-rates.js';
import { parseTelnyx, verifyTelnyxSignature, type TelnyxCreds } from './telephony/telnyx.js';
import { parseTwilio, twimlHold, twimlReject, twimlTestCall, verifyTwilioSignature, type TwilioCreds } from './telephony/twilio.js';
import { createProvider, getProvider, listProviders, preflight, recheckProvider, setCapability } from './store/providers.js';
import { ACTIVE, approveAdmin, createProject, createTenant, createUser, disableUser, listProjects, listTenants, listUsers, STAFF_ROLES, type Role } from './store/tenants.js';

interface Session { userId: string; email: string; role: Role; actor: Actor }

const adminDist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'admin', 'dist');
const portalDist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'portal', 'dist');

// At most what the database columns hold (10 digits before the point, 8 after), so a huge value is a clear 400, not a crash.
const money = z.string().regex(/^-?\d{1,10}(\.\d{1,8})?$/, 'Use a decimal number as text, e.g. "12.50" (up to 10 digits before the point and 8 after).');
const currency = z.string().length(3).transform((s) => s.toUpperCase());

export interface Deps {
  /** Outbound HTTP for provider credential checks. Replaced in tests. */
  fetch?: Fetch;
  /** How workflow integrations connect. Only tests change this; production always uses the guarded default. */
  integrationHttp?: HttpDeps;
  /** Models that judge QA criteria, by tier. None by default: only the rules are applied. */
  judges?: import('./store/qa.js').QaDeps['judges'];
  /** The models and recorder behind the learning loop. None is connected to a live provider yet. */
  learning?: Omit<import('./store/learning.js').LearnDeps, 'pool'>;
  /** Where to find a number to dial at the moment of a case call, and how to reach a client's payment system. Neither is connected to a live system yet. */
  cases?: Omit<import('./store/cases.js').CaseDeps, 'calls'>;
  /** Sends Control Tower alerts by email. None is connected until the owner picks a mail service. */
  mailer?: import('./store/alerts.js').Mailer;
}

export function buildApp(pool: pg.Pool, config: Config, deps: Deps = {}): FastifyInstance {
  const http: Fetch = deps.fetch ?? fetch;
  const app = Fastify({ logger: false });
  const key = parseKey(config.VOICELAB_SECRET_KEY);
  const dncKey = dncKeyFrom(key);
  /** The gate judges quiet hours and contact limits by the keyed hash of the number; derive it for callers who only send the number. */
  const withContact = <T extends { to: string }>(b: T): T & { contactHash?: string } => { const n = normalizeE164(b.to); return n ? { ...b, contactHash: contactHash(n, contactKeyFrom(key)) } : b; };

  async function authenticate(req: FastifyRequest): Promise<Session> {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw new AppError(401, 'Missing bearer token.');
    const { rows } = await pool.query(`SELECT id, email, tenant_id, role, disabled_at, (${ACTIVE}) AS active FROM users WHERE token_hash = $1`, [hashToken(token)]);
    const u = rows[0];
    if (!u || u.disabled_at) throw new AppError(401, 'Invalid token.');
    if (!u.active) throw new AppError(401, 'This admin is waiting for another admin to approve them.');
    const actor: Actor = u.role === 'internal_admin' ? { kind: 'internal' }
      : u.role === 'internal_viewer' ? { kind: 'internal', readOnly: true }
      : { kind: 'client', tenantId: u.tenant_id };
    return { userId: u.id, email: u.email, role: u.role, actor };
  }

  /**
   * Staff only. A read-only staff member may only read: anything else is refused here, before the route runs,
   * so every route (including ones that only look, like a simulation, which a viewer cannot run) fails closed.
   */
  async function internal(req: FastifyRequest): Promise<Session> {
    const s = await authenticate(req);
    if (s.actor.kind !== 'internal') throw new AppError(403, 'Internal access only.');
    if (s.actor.readOnly && req.method !== 'GET' && req.method !== 'HEAD') throw new AppError(403, 'Read-only access: this user can look but not change anything.');
    return s;
  }

  /** Managing who can sign in is for admins only. */
  async function admin(req: FastifyRequest): Promise<Session> {
    const s = await internal(req);
    if (s.role !== 'internal_admin') throw new AppError(403, 'Admins only.');
    return s;
  }

  // Read-only staff are refused any change before a route runs, whatever the route parses first or forgets to check.
  app.addHook('onRequest', async (req) => {
    if (req.method === 'GET' || req.method === 'HEAD' || !req.url.startsWith('/internal/')) return;
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) return; // the route's own check refuses it
    const { rows } = await pool.query('SELECT role FROM users WHERE token_hash = $1', [hashToken(token)]);
    if (rows[0]?.role === 'internal_viewer') throw new AppError(403, 'Read-only access: this user can look but not change anything.');
  });

  // Webhooks are signed over the exact bytes sent, so keep the raw JSON body alongside the parsed one.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    try { done(null, body ? JSON.parse(body as string) : undefined); }
    catch (e) { done(Object.assign(e as Error, { statusCode: 400 }), undefined); }
  });
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });

  const callDeps: CallDeps = { pool, key, dncKey, http, baseUrl: config.PUBLIC_BASE_URL?.replace(/\/$/, ''), tolerancePct: config.RECONCILE_TOLERANCE_PCT };

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.message, details: err.details });
    if (err instanceof ZodError) return reply.status(400).send({ error: 'Invalid request.', details: err.issues });
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') return reply.status(409).send({ error: 'Already exists.' });
    if (pgCode === '23503') return reply.status(400).send({ error: 'Refers to something that does not exist.' });
    if (pgCode === '23514' || pgCode === '22003') return reply.status(400).send({ error: 'A value is out of range.' });
    if ((err as { statusCode?: number }).statusCode === 400) return reply.status(400).send({ error: 'Invalid request.' });
    console.error(err);
    return reply.status(500).send({ error: 'Internal error.' });
  });

  // ------------------------------------------------------------ health
  app.get('/health', async () => {
    const { rows } = await pool.query('SELECT count(*)::int AS migrations FROM schema_migrations');
    return { ok: true, migrations: rows[0].migrations };
  });

  // Who am I: the admin UI uses this to validate a pasted token and pick its menus.
  app.get('/me', async (req) => {
    const s = await authenticate(req);
    return { email: s.email, role: s.role, readOnly: s.actor.kind === 'internal' && Boolean(s.actor.readOnly) };
  });

  // ------------------------------------------------------------ users
  // Who can sign in. Tokens are shown once, when the user is added; only their hash is kept.
  app.get('/internal/users', async (req) => {
    const s = await admin(req); // every client user's email: admins only
    return withActor(pool, s.actor, listUsers);
  });
  app.post('/internal/staff', async (req, reply) => {
    const s = await admin(req);
    const body = z.object({ email: z.string().email(), role: z.enum(STAFF_ROLES) }).parse(req.body);
    return reply.status(201).send(await withActor(pool, s.actor, (c) => createUser(c, s.userId, { tenantId: null, ...body })));
  });
  app.post('/internal/users/:id/approve', async (req) => {
    const s = await admin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return withActor(pool, s.actor, (c) => approveAdmin(c, s.userId, id));
  });
  app.post('/internal/users/:id/disable', async (req) => {
    const s = await admin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return withActor(pool, s.actor, (c) => disableUser(c, s.userId, id));
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
  app.get('/internal/tenants/:tenantId/projects', async (req) => {
    const s = await internal(req);
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(req.params);
    return withActor(pool, s.actor, async (c) => (await listProjects(c)).filter((p) => p.tenant_id === tenantId));
  });
  app.get('/internal/tenants/:tenantId/credits', async (req) => {
    const s = await internal(req);
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(req.params);
    return withActor(pool, s.actor, (c) => creditSummary(c, tenantId));
  });
  app.post('/internal/tenants/:tenantId/projects', async (req, reply) => {
    const s = await internal(req);
    const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(req.params);
    const body = z.object({ name: z.string().min(1) }).parse(req.body);
    return reply.status(201).send(await withActor(pool, s.actor, (c) => createProject(c, s.userId, tenantId, body.name)));
  });
  app.post('/internal/tenants/:tenantId/users', async (req, reply) => {
    const s = await admin(req);
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
      skipValidation: z.boolean().optional(),
    }).parse(req.body);
    const checkedAt = await preflight(body, http); // talks to the provider before any transaction opens
    return reply.status(201).send(await withActor(pool, s.actor, (c) => createProvider(c, key, s.userId, body, checkedAt)));
  });
  app.post('/internal/providers/:id/check', async (req) => {
    const s = await internal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return recheckProvider(pool, key, http, s.userId, id, (fn) => withActor(pool, s.actor, fn));
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
        unit: z.enum(['per_minute', 'per_second', 'per_character', 'per_1k_characters', 'per_token', 'per_1k_tokens', 'per_1m_tokens', 'per_credit', 'flat']),
        rate: money, currency, billingLine: z.string().optional(), direction: z.enum(['any', 'inbound', 'outbound']).optional(),
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
  // Starting rates from the blueprint, saved unconfirmed. The caller chooses the billing increment: the blueprint gives none.
  app.get('/internal/reference-rates', async (req) => {
    await internal(req);
    return REFERENCE_RATES;
  });
  app.post('/internal/providers/:id/charging/reference', async (req, reply) => {
    const s = await internal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      effectiveFrom: z.coerce.date(), billingIncrementSeconds: z.number().int().positive(),
      minimumChargeSeconds: z.number().int().min(0).optional(), rounding: z.enum(['up', 'nearest', 'down']).optional(),
    }).parse(req.body);
    return reply.status(201).send(await withActor(pool, s.actor, async (c) => {
      const p = await getProvider(c, id);
      const ref = referenceRateFor(p.adapter_key);
      if (!ref) throw new AppError(400, `There is no reference rate for ${p.adapter_key}.`);
      return addChargingVersion(c, s.userId, id, {
        ...body, burstPremiumMultiplier: ref.burstPremiumMultiplier, notes: REFERENCE_NOTE, components: ref.components,
      });
    }));
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

  // ------------------------------------------------ FX and rate card
  app.post('/internal/fx', async (req, reply) => {
    const s = await internal(req);
    const body = z.object({ currency: currency.refine((c) => c !== 'USD', 'USD is the base currency.'), perUsd: money, effectiveFrom: z.coerce.date() }).parse(req.body);
    return reply.status(201).send(await withActor(pool, s.actor, (c) => addFxRate(c, s.userId, body)));
  });
  app.get('/internal/fx', async (req) => {
    const s = await internal(req);
    return withActor(pool, s.actor, listFxRates);
  });
  app.post('/internal/rate-card', async (req, reply) => {
    const s = await internal(req);
    const body = z.object({
      effectiveFrom: z.coerce.date(), inboundCreditsPerMinute: money, outboundCreditsPerMinute: money, creditValueUsd: money,
    }).parse(req.body);
    return reply.status(201).send(await withActor(pool, s.actor, (c) => addRateCard(c, s.userId, body)));
  });
  app.get('/internal/rate-card', async (req) => {
    const s = await internal(req);
    return withActor(pool, s.actor, listRateCards);
  });

  // ------------------------------------------------------ call costs
  app.post('/internal/calls/:callId/cost', async (req, reply) => {
    const s = await internal(req);
    const { callId } = z.object({ callId: z.string().uuid() }).parse(req.params);
    const body = z.object({
      tenantId: z.string().uuid(), projectId: z.string().uuid().optional(),
      direction: z.enum(['inbound', 'outbound']), occurredAt: z.coerce.date(),
      usage: z.array(z.object({
        providerId: z.string().uuid(),
        usage: z.object({
          seconds: z.number().min(0).optional(), characters: z.number().int().min(0).optional(),
          inputTokens: z.number().int().min(0).optional(), outputTokens: z.number().int().min(0).optional(),
          burst: z.boolean().optional(),
        }),
      })).min(1),
    }).parse(req.body);
    return reply.status(201).send(await withActor(pool, s.actor, (c) => recordCallCost(c, s.userId, { callId, ...body })));
  });
  app.get('/internal/calls/:callId/cost', async (req) => {
    const s = await internal(req);
    const { callId } = z.object({ callId: z.string().uuid() }).parse(req.params);
    return withActor(pool, s.actor, (c) => getCallCost(c, callId));
  });
  app.get('/internal/costs/campaigns', async (req) => {
    const s = await internal(req);
    const { tenantId } = z.object({ tenantId: z.string().uuid().optional() }).parse(req.query);
    return withActor(pool, s.actor, (c) => campaignCosts(c, tenantId));
  });

  // ---------------------------------------------- do-not-call gate
  const country = z.string().length(2).transform((v) => v.toUpperCase());
  app.post('/internal/dnc/registries', async (req, reply) => {
    const s = await internal(req);
    const body = z.object({ country, requirement: z.enum(['registry', 'none_required']), source: z.string().min(1) }).parse(req.body);
    return reply.status(201).send(await withActor(pool, s.actor, (c) => declareRegistry(c, s.userId, body)));
  });
  app.get('/internal/dnc/registries', async (req) => {
    const s = await internal(req);
    return withActor(pool, s.actor, listRegistries);
  });
  app.post('/internal/dnc/numbers', async (req) => {
    const s = await internal(req);
    const body = z.object({
      country, tenantId: z.string().uuid().optional(), numbers: z.array(z.string()).min(1).max(10_000), source: z.string().optional(),
    }).parse(req.body);
    return withActor(pool, s.actor, (c) => addNumbers(c, dncKey, s.userId, body));
  });
  app.post('/internal/dnc/numbers/remove', async (req) => {
    const s = await internal(req);
    const body = z.object({ country, tenantId: z.string().uuid().optional(), number: z.string() }).parse(req.body);
    return withActor(pool, s.actor, (c) => removeNumber(c, dncKey, s.userId, body));
  });
  // Dry run: answers without writing to the call log. Real dials use gateOutbound.
  app.post('/internal/dial/check', async (req) => {
    const s = await internal(req);
    const body = z.object({ tenantId: z.string().uuid(), country, to: z.string() }).parse(req.body);
    return withActor(pool, s.actor, (c) => preDialCheck(c, dncKey, withContact(body)));
  });
  app.post('/internal/dial/gate', async (req) => {
    const s = await internal(req);
    const body = z.object({
      tenantId: z.string().uuid(), projectId: z.string().uuid().optional(), callId: z.string().uuid(), country, to: z.string(),
    }).parse(req.body);
    return withActor(pool, s.actor, (c) => gateOutbound(c, dncKey, withContact(body)));
  });

  registerWorkflowRoutes(app, { pool, key, internal, runDeps: { pool, key, integrationHttp: deps.integrationHttp } });
  registerAppointmentRoutes(app, { pool, internal });
  registerKnowledgeRoutes(app, { pool, internal });
  registerCaseRoutes(app, { internal, cases: { calls: callDeps, ...deps.cases } });
  registerLearningRoutes(app, { internal, learn: { pool, ...deps.learning } });
  registerJourneyRoutes(app, { pool, internal, judges: deps.judges, runDeps: { pool, key, integrationHttp: deps.integrationHttp } });
  registerResilienceRoutes(app, { pool, internal, callDeps });
  registerStitchingRoutes(app, { pool, internal, runDeps: { pool, key, integrationHttp: deps.integrationHttp } });

  // ------------------------------------------------- control tower
  app.get('/internal/control-tower', async (req) => {
    const s = await internal(req);
    return withActor(pool, s.actor, (c) => controlTower(c, key, { publicBaseUrlSet: Boolean(callDeps.baseUrl), mailConnected: Boolean(deps.mailer), jobs: scheduler.names }));
  });
  app.get('/internal/control-tower/panels', async (req) => {
    const s = await internal(req);
    return withActor(pool, s.actor, (c) => controlTowerPanels(c, (panel, err) => req.log.warn({ panel, err: err instanceof Error ? err.name : 'error' }, 'a Control Tower panel could not be worked out')));
  });
  // ------------------------------------------------- alerts by email
  const alertDeps = { pool, key, publicBaseUrl: callDeps.baseUrl || undefined, mailer: deps.mailer };

  // ------------------------------------------------- scheduled jobs
  // The same work the sweep endpoints do, with their default settings, run by the app itself (src/scheduler.ts).
  const runDeps = { pool, key, integrationHttp: deps.integrationHttp };
  const caseDeps = { calls: callDeps, ...deps.cases };
  const learnDeps = { pool, ...deps.learning };
  const sys = <T>(fn: (c: pg.PoolClient) => Promise<T>) => withActor(pool, { kind: 'internal' }, fn);
  const jobs: Job[] = [
    { name: 'alerts-email', everySeconds: 60, run: () => sweepAlerts(alertDeps) },
    // A backlog (many callbacks locked to one time) is worked through in batches within the run, so callbacks are not
    // missed only because one batch is small. Bounded, and a batch smaller than its limit means nothing more is due.
    { name: 'cases-dispatch', everySeconds: 60, run: () => drain(() => dispatchDue(caseDeps, () => new Date(), 20), 20, 10) },
    { name: 'queue-expire', everySeconds: 60, run: async () => {
      const out = await sys((c) => expireQueued(c, null, 300));
      return { expired: out.expired, hungUp: await hangUpCalls(callDeps, out.hangups) };
    } },
    { name: 'faults-sweep', everySeconds: 300, run: () => sys((c) => sweepFaults(c)) },
    { name: 'workflow-runs-sweep', everySeconds: 900, run: () => abandonStaleRuns(runDeps, null, { olderThanMinutes: 60 }) },
    { name: 'reconcile', everySeconds: 3600, run: () => reconcileSweep(callDeps, null, { olderThanMinutes: 60, limit: 50 }) },
    { name: 'learning-sweep', everySeconds: 3600, run: async () => ({ ...countsOf(await sweepAudio(learnDeps, null)), ...countsOf(await sweepDrift(learnDeps, null)) }) },
    { name: 'payment-checks', everySeconds: 3600, perTenant: true, run: (t) => checkPayments(caseDeps, t!) },
    { name: 'case-ageing', everySeconds: 86400, perTenant: true, run: (t) => sys((c) => sweepAgeing(c, t!)) },
    { name: 'appointment-reminders', everySeconds: 900, perTenant: true, run: (t) => sys((c) => sweepReminders(c, t!)) },
    // Extra channel charges are not run automatically: they bill a month at today's entitlement, which has no history,
    // so a client added or upgraded mid-month would be charged for the whole month. An operator runs them by hand.
  ];
  const scheduler = createScheduler(pool, jobs, { log: (m) => app.log.error(m) });
  app.decorate('scheduler', scheduler);
  app.addHook('onClose', async () => { await scheduler.stop(); });
  const reason = z.string().trim().min(3, 'Say why.').max(500).transform((t) => cleanNote(t, 'reason')!);
  app.get('/internal/scheduler', async (req) => { const s = await internal(req); return withActor(pool, s.actor, listJobs); });
  app.put('/internal/scheduler/:name', async (req) => {
    const s = await admin(req);
    const { name } = z.object({ name: z.string().max(60) }).parse(req.params);
    const b = z.object({ enabled: z.boolean().optional(), everySeconds: z.number().int().min(60).max(2_678_400).optional(), reason })
      .refine((x) => x.enabled !== undefined || x.everySeconds !== undefined, 'Change something: turn it on or off, or set how often it runs.').parse(req.body);
    return withActor(pool, s.actor, (c) => updateJob(c, s.userId, name, b));
  });
  app.post('/internal/scheduler/:name/run', async (req) => {
    const s = await admin(req);
    const { name } = z.object({ name: z.string().max(60) }).parse(req.params);
    const b = z.object({ reason }).parse(req.body);
    return withActor(pool, s.actor, (c) => runJobNow(c, s.userId, name, b.reason));
  });
  app.post('/internal/alerts/sweep', async (req) => { await internal(req); return sweepAlerts(alertDeps); });
  app.get('/internal/alerts/subscriptions', async (req) => { const s = await internal(req); return withActor(pool, s.actor, (c) => listSubscriptions(c)); });
  app.put('/internal/alerts/subscriptions', async (req) => { const s = await admin(req); const b = subscriptionSchema.parse(req.body); return withActor(pool, s.actor, (c) => subscribe(c, s.userId, b)); });
  app.post('/internal/alerts/subscriptions/:userId/end', async (req) => {
    const s = await admin(req); const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    return withActor(pool, s.actor, (c) => unsubscribe(c, s.userId, userId));
  });
  app.post('/internal/alerts/subscriptions/:userId/test', async (req) => {
    const s = await admin(req); const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    return sendTest(alertDeps, s.userId, userId);
  });
  app.get('/internal/alerts/deliveries', async (req) => { const s = await internal(req); return withActor(pool, s.actor, (c) => listDeliveries(c)); });

  app.get('/internal/control-tower/controls', async (req) => {
    const s = await internal(req);
    return withActor(pool, s.actor, (c) => controlState(c));
  });
  app.post('/internal/control-tower/actions', async (req) => {
    const s = await internal(req);
    const b = actionSchema.parse(req.body);
    return withActor(pool, s.actor, (c) => runAction(c, s.userId, b));
  });
  app.get('/internal/change-log', async (req) => {
    const s = await internal(req);
    const q = changeLogQuery.parse(req.query);
    return withActor(pool, s.actor, (c) => changeLog(c, q));
  });
  app.get('/internal/progress', async (req) => {
    await internal(req);
    return { generatedAt: new Date().toISOString(), phases: PHASES, crossCutting: CROSS_CUTTING, decisions: DECISIONS };
  });

  // ------------------------------------------------ numbers and calls
  app.post('/internal/numbers', async (req, reply) => {
    const s = await internal(req);
    const body = z.object({
      providerId: z.string().uuid(), e164: z.string(), tenantId: z.string().uuid(),
      projectId: z.string().uuid().optional(), country, label: z.string().optional(),
    }).parse(req.body);
    return reply.status(201).send(await withActor(pool, s.actor, (c) => addNumber(c, s.userId, body)));
  });
  app.get('/internal/numbers', async (req) => {
    const s = await internal(req);
    return withActor(pool, s.actor, listNumbers);
  });
  // Which workflow answers calls to one of our numbers; null for none.
  app.put('/internal/numbers/:numberId/workflow', async (req) => {
    const s = await admin(req);
    const { numberId } = z.object({ numberId: z.string().uuid() }).parse(req.params);
    const body = z.object({ workflowId: z.string().uuid().nullable() }).strict().parse(req.body);
    return withActor(pool, s.actor, (c) => setNumberWorkflow(c, s.userId, numberId, body.workflowId));
  });
  app.post('/internal/calls/outbound', async (req, reply) => {
    const s = await internal(req);
    const body = z.object({
      tenantId: z.string().uuid(), projectId: z.string().uuid().optional(), providerId: z.string().uuid().optional(),
      from: z.string().optional(), to: z.string(), country, workflowId: z.string().uuid().optional(),
    }).parse(req.body);
    const result = await placeOutboundCall(callDeps, s.userId, body);
    // A dial held back for want of capacity is not an error to fix but a request to retry shortly.
    if ('deferred' in result) return reply.status(429).header('retry-after', String(result.retryAfterSeconds)).send(result);
    return reply.status(result.allowed ? 201 : 200).send(result);
  });
  app.get('/internal/calls', async (req) => {
    const s = await internal(req);
    const q = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50), tenantId: z.string().uuid().optional(),
      status: z.enum(['dialing', 'ringing', 'in_progress', 'completed', 'unanswered', 'failed', 'blocked']).optional(),
    }).parse(req.query);
    return withActor(pool, s.actor, (c) => listCalls(c, q));
  });
  app.post('/internal/calls/:callId/reconcile', async (req) => {
    const s = await internal(req);
    const { callId } = z.object({ callId: z.string().uuid() }).parse(req.params);
    const body = z.discriminatedUnion('source', [
      z.object({ source: z.literal('provider_api') }),
      z.object({ source: z.literal('manual'), reportedSeconds: z.number().min(0).max(1_000_000).optional(), reportedCost: money, currency: currency.optional() }),
    ]).parse(req.body);
    return reconcileCall(callDeps, s.userId, callId, body);
  });
  app.get('/internal/calls/:callId/reconciliations', async (req) => {
    const s = await internal(req);
    const { callId } = z.object({ callId: z.string().uuid() }).parse(req.params);
    return withActor(pool, s.actor, (c) => listReconciliations(c, callId));
  });
  app.post('/internal/reconcile/run', async (req) => {
    const s = await internal(req);
    const body = z.object({ olderThanMinutes: z.number().int().min(0).default(60), limit: z.number().int().min(1).max(500).default(50) }).parse(req.body ?? {});
    return reconcileSweep(callDeps, s.userId, body);
  });
  app.get('/internal/calls/:callId', async (req) => {
    const s = await internal(req);
    const { callId } = z.object({ callId: z.string().uuid() }).parse(req.params);
    return withActor(pool, s.actor, (c) => getCall(c, callId));
  });
  // Re-price a call whose cost could not be recorded, e.g. after adding the missing FX rate.
  app.post('/internal/calls/:callId/cost/retry', async (req) => {
    const s = await internal(req);
    const { callId } = z.object({ callId: z.string().uuid() }).parse(req.params);
    const outcome = await withActor(pool, s.actor, (c) => costCall(c, s.userId, callId));
    return { cost_status: outcome };
  });

  // ------------------------------------------------------- webhooks
  // No bearer token here: providers cannot send one. Every request is verified by signature,
  // and anything that cannot be verified is refused.
  const webhookProvider = async (providerId: string, adapter: string) => {
    const p = await withActor(pool, { kind: 'internal' }, (c) => loadProvider(c, providerId));
    if (!p || p.adapter_key !== adapter) throw new AppError(404, 'Unknown provider.');
    if (!callDeps.baseUrl) throw new AppError(503, 'PUBLIC_BASE_URL is not set.');
    return p;
  };
  const twilioHook = (voice: boolean) => async (req: FastifyRequest, reply: import('fastify').FastifyReply) => {
    const { providerId } = z.object({ providerId: z.string().uuid() }).parse(req.params);
    const { callId } = z.object({ callId: z.string().uuid().optional() }).parse(req.query);
    const provider = await webhookProvider(providerId, 'twilio');
    const creds = credentials<TwilioCreds>(provider, key);
    if (!creds.authToken) throw new AppError(503, 'This Twilio provider has no Auth Token, so call events cannot be verified.');
    const params = (req.body ?? {}) as Record<string, string>;
    if (!verifyTwilioSignature(creds.authToken, callDeps.baseUrl + req.url, params, req.headers['x-twilio-signature'] as string | undefined)) {
      throw new AppError(403, 'Bad signature.');
    }
    const ev = parseTwilio(params, callId, voice);
    if (ev) await processWebhook(callDeps, provider, ev, callId);
    if (!voice) return reply.status(204).send();
    const known = ev ? await callKnown(callDeps, provider.id, ev.providerCallId) : false;
    const queued = known && ev ? await callQueued(callDeps, provider.id, ev.providerCallId) : false;
    // A call with a workflow to run is handed to the speech relay; one without hears the test message.
    const relayed = known && !queued && ev ? await relayTarget(callDeps, provider.id, ev.providerCallId) : null;
    if (relayed) return reply.type('text/xml').send(twimlRelay(relayUrl(provider.id), relayed, relayCallToken(key, relayed), relaySettings(provider.params)));
    return reply.type('text/xml').send(known ? (queued ? twimlHold(`${callDeps.baseUrl}/webhooks/twilio/${provider.id}/voice${callId ? `?callId=${callId}` : ''}`) : twimlTestCall()) : twimlReject());
  };
  app.post('/webhooks/twilio/:providerId/status', twilioHook(false));
  app.post('/webhooks/twilio/:providerId/voice', twilioHook(true));

  // ------------------------------------------------- live call voice link
  // Twilio's speech relay connects here once a call with a workflow is answered. The connection is refused before it
  // opens unless Twilio's signature on it checks out; then only the call it names, on this provider, is served.
  const relayUrl = (providerId: string) => `${(callDeps.baseUrl ?? '').replace(/^http/, 'ws')}/relay/twilio/${providerId}`;
  const relayDeps: RelayDeps = { runs: { pool, key, integrationHttp: deps.integrationHttp }, baseUrl: callDeps.baseUrl ?? '' };
  app.register(fastifyWebsocket, { options: { maxPayload: 64 * 1024 } });
  app.register(async (f) => {
    f.get('/relay/twilio/:providerId', {
      websocket: true,
      preValidation: async (req) => {
        const { providerId } = z.object({ providerId: z.string().uuid() }).parse(req.params);
        const provider = await webhookProvider(providerId, 'twilio');
        const creds = credentials<TwilioCreds>(provider, key);
        if (!creds.authToken) throw new AppError(503, 'This Twilio provider has no Auth Token, so the live call link cannot be verified.');
        // The address Twilio signs is the one it was given. Which scheme it signs it under is not yet checked against a live
        // call, so the wss:// form and the https:// form are both accepted; either way only Twilio holds the key.
        const header = req.headers['x-twilio-signature'] as string | undefined;
        const base = callDeps.baseUrl ?? '';
        const ok = [base.replace(/^http/, 'ws'), base].some((b) => verifyTwilioSignature(creds.authToken!, b + req.url, {}, header));
        if (!ok) throw new AppError(403, 'Bad signature.');
      },
    }, (socket, req) => {
      const providerId = (req.params as { providerId: string }).providerId;
      let session: RelaySession | null = null;
      let closed = false;
      let queue: Promise<void> = Promise.resolve();
      const send = (out: RelayOutbound[]) => { for (const m of out) if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(m)); };
      // The relay must say which call it is for straight away; a connection that does not is closed.
      const setupTimer = setTimeout(() => { if (!session) socket.close(1008, 'No setup'); }, 10_000);
      // Something below failed outright (the database, say): the callback is still attempted and the caller still hears a
      // holding line, never silence; then the line is closed.
      const fallBack = async () => {
        const out = session ? await relayFailed(relayDeps, session).then((r) => r.send).catch(() => null) : null;
        send(out ?? [{ type: 'text', token: DEFAULT_FALLBACK.holdingMessage, last: true }, { type: 'end' }]);
        socket.close();
      };
      // A connection standing by while another starts the call, or carrying on a call whose reply is still being applied,
      // looks again every few seconds, so it is never left silent for long. A closed connection stops looking, and never
      // takes the call over.
      let standbyTimer: NodeJS.Timeout | undefined;
      const armStandby = () => {
        if (closed) return;
        standbyTimer = setTimeout(() => {
          queue = queue.then(async () => {
            if (!session || closed) return;
            const r = await standbyCheck(relayDeps, session);
            send(r.send);
            if (r.again) armStandby();
          }).catch(fallBack);
        }, STANDBY_POLL_MS);
      };
      socket.on('message', (data: Buffer) => {
        const m = parseRelay(data.toString('utf8'));
        if (!m) return;
        // The question the call was on when these words arrived; null if this connection was not yet serving the call.
        const askedAt = session?.runId ? session.version : null;
        // One message at a time, in order: a turn finishes before the next is looked at.
        queue = queue.then(async () => {
          if (m.type === 'setup') {
            if (session) return;
            clearTimeout(setupTimer);
            const r = await openRelay(relayDeps, providerId, m);
            session = r.session;
            if (session && closed) session.closed = true;
            send(r.send);
            if (!session) socket.close(1008, 'Unknown call');
            // Standing by, or carried on from a call another connection was serving: look again until there is something to say.
            else if (!session.ended && r.send.length === 0) armStandby();
            return;
          }
          if (session) send(await onRelayMessage(relayDeps, session, m, askedAt));
        }).catch(fallBack);
      });
      socket.on('close', () => {
        closed = true;
        if (session) session.closed = true;
        clearTimeout(setupTimer); clearTimeout(standbyTimer);
        queue = queue.then(() => (session ? closeRelay(relayDeps, session) : undefined)).catch(() => undefined);
      });
    });
  });
  // A recording, for the relay to play on a call. Only through a link we signed for that recording, and only while it is in date.
  app.get('/media/recordings/:recordingId', async (req, reply) => {
    const { recordingId } = z.object({ recordingId: z.string() }).parse(req.params);
    const q = req.query as { exp?: string; sig?: string };
    if (!mediaLinkValid(key, recordingId, q.exp, q.sig, new Date())) throw new AppError(403, 'This link is not valid.');
    const r = await withActor(pool, { kind: 'internal' }, (c) => recordingAudio(c, recordingId));
    return reply.type(r.content_type).header('cache-control', 'private, max-age=600').send(r.audio);
  });

  app.post('/webhooks/telnyx/:providerId', async (req, reply) => {
    const { providerId } = z.object({ providerId: z.string().uuid() }).parse(req.params);
    const provider = await webhookProvider(providerId, 'telnyx');
    const creds = credentials<TelnyxCreds>(provider, key);
    if (!creds.webhookPublicKey) throw new AppError(503, 'This Telnyx provider has no webhook signing public key, so call events cannot be verified.');
    const ok = verifyTelnyxSignature({
      publicKeyBase64: creds.webhookPublicKey,
      signatureBase64: req.headers['telnyx-signature-ed25519'] as string | undefined,
      timestamp: req.headers['telnyx-timestamp'] as string | undefined,
      rawBody: (req as FastifyRequest & { rawBody?: string }).rawBody ?? '',
    });
    if (!ok) throw new AppError(403, 'Bad signature.');
    const ev = parseTelnyx(req.body);
    if (ev) await processWebhook(callDeps, provider, ev);
    return reply.status(200).send({ ok: true });
  });

  // --------------------------------------------------- client portal
  // Everything here runs as the voicelab_client role, scoped to the signed-in user's own client (see store/portal.ts).
  async function clientSession(req: FastifyRequest) {
    const s = await authenticate(req);
    if (s.actor.kind !== 'client') throw new AppError(403, 'Client access only.');
    return s as Session & { actor: { kind: 'client'; tenantId: string } };
  }
  async function clientAdmin(req: FastifyRequest) {
    const s = await clientSession(req);
    if (s.role !== 'tenant_admin') throw new AppError(403, "Only your organisation's admins can manage users.");
    return s;
  }
  app.get('/client/me', async (req) => {
    const s = await clientSession(req);
    const tenant = (await pool.query('SELECT name FROM tenants WHERE id = $1', [s.actor.tenantId])).rows[0]?.name as string;
    return { email: s.email, role: s.role, client: tenant };
  });
  app.get('/client/credits', async (req) => {
    const s = await clientSession(req);
    return withActor(pool, s.actor, (c) => creditSummary(c));
  });
  app.get('/client/projects', async (req) => {
    const s = await clientSession(req);
    return withActor(pool, s.actor, listProjects);
  });
  app.get('/client/summary', async (req) => {
    const s = await clientSession(req);
    return withActor(pool, s.actor, clientSummary);
  });
  app.get('/client/calls', async (req) => {
    const s = await clientSession(req);
    const q = z.object({ limit: z.coerce.number().int().min(1).max(200).optional(), before: z.string().uuid().optional(), projectId: z.string().uuid().optional() }).parse(req.query);
    return withActor(pool, s.actor, (c) => clientCalls(c, q));
  });
  app.get('/client/users', async (req) => {
    const s = await clientAdmin(req);
    return withActor(pool, s.actor, clientUsers);
  });
  app.post('/client/users', async (req, reply) => {
    const s = await clientAdmin(req);
    const b = z.object({ email: z.string().trim().email(), role: z.enum(['tenant_admin', 'tenant_user']) }).parse(req.body);
    return reply.status(201).send(await withActor(pool, s.actor, (c) => clientAddUser(c, s.userId, b.email, b.role)));
  });
  app.post('/client/users/:id/disable', async (req) => {
    const s = await clientAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return withActor(pool, s.actor, (c) => clientDisableUser(c, s.userId, id));
  });

  // ------------------------------------------------------- admin UI
  // Built with `npm run build:admin`. Served from the same process so there is one thing to deploy.
  if (existsSync(adminDist)) {
    app.register(fastifyStatic, { root: adminDist, prefix: '/admin/' });
    app.get('/admin', (_req, reply) => reply.redirect('/admin/'));
  }
  // The client portal: a separate app with its own sign-in, built with `npm run build:portal`.
  if (existsSync(portalDist)) {
    app.register(fastifyStatic, { root: portalDist, prefix: '/portal/', decorateReply: false });
    app.get('/portal', (_req, reply) => reply.redirect('/portal/'));
  }

  return app;
}

declare module 'fastify' {
  interface FastifyInstance { scheduler: ReturnType<typeof createScheduler> }
}
