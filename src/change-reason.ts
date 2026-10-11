/**
 * A reason for every settings change. The Control Tower's own actions have always asked why; these are the settings
 * changed on other screens, which took none. Each one now needs a reason, checked after the request is known to come
 * from staff who may change things and before the route reads anything else, and it reaches the change log through the
 * audit row the change writes (the transaction carries it, so no store has to pass it on). A route added to this list
 * is covered by `tests/change-reasons.test.ts`, which sends every one of them.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from './errors.js';
import { cleanNote } from './store/cases.js';

/** Settings changes made outside the Control Tower, by method and route. */
export const REASON_ROUTES = [
  ['PUT', '/internal/resilience/policy'],
  ['PUT', '/internal/tenants/:tenantId/routes/voice'],
  ['PUT', '/internal/tenants/:tenantId/fallback'],
  ['PUT', '/internal/tenants/:tenantId/transfer'],
  ['DELETE', '/internal/tenants/:tenantId/transfer'],
  ['PUT', '/internal/tenants/:tenantId/entitlement'],
  ['PUT', '/internal/providers/:providerId/funding-thresholds'],
  ['POST', '/internal/providers/:id/charging'],
  ['POST', '/internal/providers/:id/charging/reference'],
  ['PUT', '/internal/providers/:id/capabilities/:capability'],
  ['PUT', '/internal/numbers/:numberId/workflow'],
  ['POST', '/internal/dnc/numbers/remove'],
  ['PUT', '/internal/tenants/:tenantId/journey-config'],
  ['PUT', '/internal/journey/drop-latency'],
  ['POST', '/internal/tenants/:tenantId/qa-criteria'],
  ['PUT', '/internal/model-config/:taskKey'],
  ['PUT', '/internal/tenants/:tenantId/approval-policy'],
  ['PUT', '/internal/tenants/:tenantId/learning/config'],
  ['PUT', '/internal/tenants/:tenantId/case-settings'],
  ['PUT', '/internal/tenants/:tenantId/contact-policy'],
  ['PUT', '/internal/tenants/:tenantId/cancellation-policy'],
  ['PUT', '/internal/diaries/:diaryId/hours'],
  ['PUT', '/internal/tenants/:tenantId/policy/levels'],
  ['PUT', '/internal/alerts/subscriptions'],
  ['POST', '/internal/alerts/subscriptions/:userId/end'],
] as const;

const routes = new Set(REASON_ROUTES.map(([m, u]) => `${m} ${u}`));

const registered = new WeakMap<FastifyInstance, string[]>();
/** Keeps every route the app registers, so a test can hold each change route to a decision: a reason, or exempt on purpose. */
export function recordRoutes(app: FastifyInstance): void {
  const list: string[] = [];
  registered.set(app, list);
  app.addHook('onRoute', (r) => { for (const m of [r.method].flat()) list.push(`${m} ${r.url}`); });
}
export const routesOf = (app: FastifyInstance): string[] => [...(registered.get(app) ?? [])];

/** True when the request is a settings change that needs a reason. */
export function needsReason(req: FastifyRequest): boolean {
  return routes.has(`${req.method} ${req.routeOptions.url ?? ''}`);
}

const reasonSchema = z.string({ error: 'Say why, in a few words.' }).trim().min(3, 'Say why, in a few words.').max(500, 'Keep the reason under 500 characters.');
const reasons = new WeakMap<FastifyRequest, string>();

/**
 * Take the reason off the request body, so a route's own strict check never sees it, and keep it for the request.
 * A missing or unusable reason, or one holding a phone number (it goes into the append-only audit log), is a 400.
 */
export function takeReason(req: FastifyRequest): string {
  const body = req.body;
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>).reason : undefined;
  const parsed = reasonSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(400, parsed.error.issues[0]?.message ?? 'Say why, in a few words.');
  const why = cleanNote(parsed.data, 'reason')!;
  if (body && typeof body === 'object') delete (body as Record<string, unknown>).reason;
  reasons.set(req, why);
  return why;
}

/** The reason this request gave, if it is a settings change that has been checked. */
export function reasonOf(req: FastifyRequest): string | undefined {
  return reasons.get(req);
}
