import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
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
import { addNumbers, declareRegistry, dncKeyFrom, gateOutbound, listRegistries, preDialCheck, removeNumber } from './store/dnc.js';
import { addNumber, callKnown, costCall, getCall, listCalls, listNumbers, loadProvider, credentials, placeOutboundCall, processWebhook, type CallDeps } from './store/calls.js';
import { controlTower } from './store/control-tower.js';
import { CROSS_CUTTING, DECISIONS, PHASES } from './progress.js';
import { listReconciliations, reconcileCall, reconcileSweep } from './store/reconcile.js';
import { REFERENCE_NOTE, REFERENCE_RATES, referenceRateFor } from './reference-rates.js';
import { parseTelnyx, verifyTelnyxSignature, type TelnyxCreds } from './telephony/telnyx.js';
import { parseTwilio, twimlReject, twimlTestCall, verifyTwilioSignature, type TwilioCreds } from './telephony/twilio.js';
import { createProvider, getProvider, listProviders, preflight, recheckProvider, setCapability } from './store/providers.js';
import { createProject, createTenant, createUser, listProjects, listTenants } from './store/tenants.js';

interface Session { userId: string; email: string; actor: Actor }

const adminDist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'admin', 'dist');

// At most what the database columns hold (10 digits before the point, 8 after), so a huge value is a clear 400, not a crash.
const money = z.string().regex(/^-?\d{1,10}(\.\d{1,8})?$/, 'Use a decimal number as text, e.g. "12.50" (up to 10 digits before the point and 8 after).');
const currency = z.string().length(3).transform((s) => s.toUpperCase());

export interface Deps {
  /** Outbound HTTP for provider credential checks. Replaced in tests. */
  fetch?: Fetch;
}

export function buildApp(pool: pg.Pool, config: Config, deps: Deps = {}): FastifyInstance {
  const http: Fetch = deps.fetch ?? fetch;
  const app = Fastify({ logger: false });
  const key = parseKey(config.VOICELAB_SECRET_KEY);
  const dncKey = dncKeyFrom(key);

  async function authenticate(req: FastifyRequest): Promise<Session> {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw new AppError(401, 'Missing bearer token.');
    const { rows } = await pool.query('SELECT id, email, tenant_id, role FROM users WHERE token_hash = $1', [hashToken(token)]);
    const u = rows[0];
    if (!u) throw new AppError(401, 'Invalid token.');
    return {
      userId: u.id,
      email: u.email,
      actor: u.role === 'internal_admin' ? { kind: 'internal' } : { kind: 'client', tenantId: u.tenant_id },
    };
  }

  async function internal(req: FastifyRequest): Promise<Session> {
    const s = await authenticate(req);
    if (s.actor.kind !== 'internal') throw new AppError(403, 'Internal access only.');
    return s;
  }

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
    return { email: s.email, role: s.actor.kind === 'internal' ? 'internal_admin' : 'client' };
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
    return withActor(pool, s.actor, (c) => preDialCheck(c, dncKey, body));
  });
  app.post('/internal/dial/gate', async (req) => {
    const s = await internal(req);
    const body = z.object({
      tenantId: z.string().uuid(), projectId: z.string().uuid().optional(), callId: z.string().uuid(), country, to: z.string(),
    }).parse(req.body);
    return withActor(pool, s.actor, (c) => gateOutbound(c, dncKey, body));
  });

  // ------------------------------------------------- control tower
  app.get('/internal/control-tower', async (req) => {
    const s = await internal(req);
    return withActor(pool, s.actor, (c) => controlTower(c, key, { publicBaseUrlSet: Boolean(callDeps.baseUrl) }));
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
  app.post('/internal/calls/outbound', async (req, reply) => {
    const s = await internal(req);
    const body = z.object({
      tenantId: z.string().uuid(), projectId: z.string().uuid().optional(), providerId: z.string().uuid(),
      from: z.string(), to: z.string(), country,
    }).parse(req.body);
    const result = await placeOutboundCall(callDeps, s.userId, body);
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
    return reply.type('text/xml').send(known ? twimlTestCall() : twimlReject());
  };
  app.post('/webhooks/twilio/:providerId/status', twilioHook(false));
  app.post('/webhooks/twilio/:providerId/voice', twilioHook(true));

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

  // ------------------------------------------------------- admin UI
  // Built with `npm run build:admin`. Served from the same process so there is one thing to deploy.
  if (existsSync(adminDist)) {
    app.register(fastifyStatic, { root: adminDist, prefix: '/admin/' });
    app.get('/admin', (_req, reply) => reply.redirect('/admin/'));
  }

  return app;
}
