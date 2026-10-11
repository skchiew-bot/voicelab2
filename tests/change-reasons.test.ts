import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REASON_ROUTES, routesOf } from '../src/change-reason.js';
import { withActor } from '../src/db.js';
import { createUser } from '../src/store/tenants.js';

// Every settings change made outside the Control Tower says why: refused without a reason, and the reason is in the change log.
type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env;
const BASE = 'https://voicelab.test';
const st = () => env.staffToken;
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}
const post = (u: string, b?: unknown) => env.call(st(), 'POST', u, b);
/**
 * Every other change route, and why it takes no settings reason: it asks for its own reason or note, it is a step in an
 * approval that records its own, it adds a record (a client, a user, a rate, a booking), it is people management, or it
 * does work (a run, a sweep, a check) rather than change a setting. A new change route fails the inventory test until it
 * is listed here or in REASON_ROUTES.
 */
const EXEMPT: Record<string, 'asks its own' | 'approval' | 'people' | 'record' | 'work'> = {
  // asks its own
  'POST /internal/appointments/:appointmentId/delay': 'record',
  'POST /internal/appointments/:appointmentId/cancel': 'asks its own',
  'POST /internal/knowledge-versions/:versionId/publish': 'approval',
  'POST /internal/knowledge-versions/:versionId/reject': 'asks its own',
  'POST /internal/tenants/:tenantId/policy/proposals': 'asks its own',
  'POST /internal/policy-versions/:versionId/decision': 'approval',
  'POST /internal/policy-versions/:versionId/withdraw': 'asks its own',
  'POST /internal/cases/:caseId/decision': 'asks its own',
  'POST /internal/cases/:caseId/close': 'asks its own',
  'POST /internal/promotions/:promotionId/decision': 'approval',
  'POST /internal/promotions/:promotionId/demote': 'asks its own',
  'POST /internal/calls/:callId/fault-ack': 'record',
  'POST /internal/workflows/:workflowId/changes': 'asks its own',
  'POST /internal/changes/:changeId/decision': 'approval',
  'POST /internal/changes/:changeId/apply': 'approval',
  'POST /internal/calls/:callId/did-failure': 'asks its own',
  'PUT /internal/scheduler/:name': 'asks its own',
  'POST /internal/scheduler/:name/run': 'asks its own',
  'POST /internal/control-tower/actions': 'asks its own',
  // approval
  'POST /internal/workflows/:workflowId/deploy': 'approval',
  'POST /internal/workflows/:workflowId/rollback': 'approval',
  'POST /internal/policy-versions/:versionId/activate': 'approval',
  // people
  'POST /internal/staff': 'people',
  'POST /internal/users/:id/approve': 'people',
  'POST /internal/users/:id/disable': 'people',                        // no reason asked: the owner's decision, 2026-10-11
  'POST /internal/tenants/:tenantId/users': 'people',
  // record
  'POST /internal/tenants': 'record',
  'POST /internal/tenants/:tenantId/projects': 'record',
  'POST /internal/tenants/:tenantId/credits': 'record',
  'POST /internal/providers': 'record',
  'POST /internal/charging/:versionId/confirm': 'record',
  'POST /internal/providers/:id/funding': 'record',
  'POST /internal/fx': 'record',
  'POST /internal/rate-card': 'record',
  'POST /internal/calls/:callId/cost': 'record',
  'POST /internal/dnc/registries': 'record',
  'POST /internal/dnc/numbers': 'record',
  'POST /internal/tenants/:tenantId/workflows': 'record',
  'POST /internal/workflows/:workflowId/versions': 'record',
  'POST /internal/tenants/:tenantId/workflows/from-template': 'record',
  'POST /internal/tenants/:tenantId/integrations': 'record',
  'POST /internal/tenants/:tenantId/locations': 'record',
  'POST /internal/tenants/:tenantId/diaries': 'record',
  'POST /internal/diaries/:diaryId/blocks': 'record',
  'POST /internal/tenants/:tenantId/appointments': 'record',
  'POST /internal/appointments/:appointmentId/reschedule': 'record',
  'POST /internal/appointments/:appointmentId/no-show': 'record',
  'POST /internal/appointments/:appointmentId/complete': 'record',
  'POST /internal/tenants/:tenantId/knowledge': 'record',
  'POST /internal/knowledge/:articleId/versions': 'record',
  'POST /internal/knowledge/:articleId/retire': 'record',
  'POST /internal/tenants/:tenantId/cases': 'record',
  'POST /internal/cases/:caseId/callbacks': 'record',
  'POST /internal/cases/:caseId/promises': 'record',
  'POST /internal/case-actions/:actionId/complete': 'record',
  'POST /internal/tickets/:ticketId/events': 'record',
  'POST /internal/tenants/:tenantId/recordings': 'record',
  'POST /internal/calls/:callId/outcome': 'record',
  'POST /internal/numbers': 'record',
  'POST /internal/calls/:callId/reconcile': 'record',
  // work
  'POST /internal/providers/:id/check': 'work',
  'POST /internal/dial/check': 'work',
  'POST /internal/dial/gate': 'work',
  'POST /internal/workflows/validate': 'work',
  'POST /internal/workflows/:workflowId/simulate': 'work',
  'POST /internal/workflow-runs/sweep': 'work',
  'POST /internal/workflows/:workflowId/runs': 'work',
  'POST /internal/workflow-runs/:runId/reply': 'work',
  'POST /internal/notifications/:notificationId/mark': 'work',
  'POST /internal/tenants/:tenantId/appointments/sweep-reminders': 'work',
  'POST /internal/tenants/:tenantId/policy/check': 'work',
  'POST /internal/cases/dispatch': 'work',
  'POST /internal/tenants/:tenantId/cases/check-payments': 'work',
  'POST /internal/tenants/:tenantId/cases/sweep-ageing': 'work',
  'POST /internal/tenants/:tenantId/learning/scan': 'work',
  'POST /internal/learning/sweep': 'work',
  'POST /internal/promotions/:promotionId/review': 'work',
  'POST /internal/promotions/:promotionId/audio': 'work',
  'POST /internal/promotions/:promotionId/drift-check': 'work',
  'POST /internal/faults/sweep': 'work',
  'POST /internal/tenants/:tenantId/qa/score': 'work',
  'POST /internal/providers/:providerId/samples': 'work',
  'POST /internal/tenants/:tenantId/channel-charges': 'work',
  'POST /internal/queue/expire': 'work',
  'POST /internal/workflows/:workflowId/stitching-report': 'work',
  'POST /internal/alerts/sweep': 'work',
  'POST /internal/alerts/subscriptions/:userId/test': 'work',
  'POST /internal/calls/outbound': 'work',
  'POST /internal/reconcile/run': 'work',
  'POST /internal/calls/:callId/cost/retry': 'work',
  'POST /internal/calls/cost/retry-failed': 'work',
};
const auditCount = async () => (await env.pool.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n as number;

let staffId: string; let tenantId: string; let twilioId: string; let voiceId: string; let numberId: string; let diaryId: string; let viewer: string;

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  staffId = (await env.pool.query(`SELECT id FROM users WHERE email = 'staff@daythree.test'`)).rows[0].id;
  tenantId = (await must(post('/internal/tenants', { name: 'Reasons Co' }))).json().id;
  twilioId = (await must(post('/internal/providers', { adapterKey: 'twilio', name: 'tw', params: { accountSid: 'AC1', authToken: 'tok', twimlAppVoiceUrl: `${BASE}/v` } }))).json().id;
  voiceId = (await must(post('/internal/providers', { adapterKey: 'elevenlabs', name: 'el', params: { apiKey: 'k' } }))).json().id;
  numberId = (await must(post('/internal/numbers', { providerId: twilioId, e164: '+60300000901', tenantId, country: 'MY' }))).json().id;
  diaryId = (await must(post(`/internal/tenants/${tenantId}/diaries`, { name: 'Desk', kind: 'individual', officerRef: 'officer-1', timeZone: 'Asia/Kuala_Lumpur' }))).json().id;
  await must(post('/internal/dnc/registries', { country: 'MY', requirement: 'registry', source: 'test' }));
  await must(post('/internal/dnc/numbers', { country: 'MY', numbers: ['+60198765432'] }));
  viewer = (await withActor(env.pool, { kind: 'internal' }, (c) => createUser(c, null, { tenantId: null, email: 'reasons-viewer@daythree.test', role: 'internal_viewer' }))).token;
});
afterAll(async () => { await env?.teardown(); });

/** A real change for each route: its path, a body that changes something, and the action it writes to the audit log. */
function changes(): { method: string; route: string; path: string; body: Record<string, unknown>; action: string }[] {
  const hours = [0, 1, 2, 3, 4, 5, 6].map((dow) => ({ dow, starts: '09:00', ends: '17:00' }));
  const t = `/internal/tenants/${tenantId}`;
  const list: [string, string, string, Record<string, unknown>, string][] = [
    ['PUT', '/internal/resilience/policy', '/internal/resilience/policy', { recoveryOkSamples: 2 }, 'resilience.policy'],
    ['PUT', '/internal/tenants/:tenantId/routes/voice', `${t}/routes/voice`, { providerIds: [voiceId] }, 'routes.set'],
    ['PUT', '/internal/tenants/:tenantId/fallback', `${t}/fallback`, { holdingMessage: 'Please hold.', offerCallback: true, humanTransfer: false, voicemail: false }, 'fallback.set'],
    ['PUT', '/internal/tenants/:tenantId/transfer', `${t}/transfer`, { agentNumber: '+60312345678' }, 'transfer.set'],
    ['DELETE', '/internal/tenants/:tenantId/transfer', `${t}/transfer`, {}, 'transfer.clear'],
    ['PUT', '/internal/tenants/:tenantId/entitlement', `${t}/entitlement`, { inboundChannels: 2 }, 'entitlement.set'],
    ['PUT', '/internal/providers/:providerId/funding-thresholds', `/internal/providers/${twilioId}/funding-thresholds`, { currency: 'USD', warnBelow: '50', criticalBelow: '10' }, 'funding.thresholds'],
    ['POST', '/internal/providers/:id/charging', `/internal/providers/${twilioId}/charging`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1, components: [{ component: 'telephony_leg', unit: 'per_minute', rate: '0.0120', currency: 'USD' }] }, 'charging.add_version'],
    ['POST', '/internal/providers/:id/charging/reference', `/internal/providers/${twilioId}/charging/reference`, { effectiveFrom: '2026-02-01T00:00:00Z', billingIncrementSeconds: 6 }, 'charging.add_version'],
    ['PUT', '/internal/providers/:id/capabilities/:capability', `/internal/providers/${voiceId}/capabilities/stt`, { support: 'composable' }, 'provider.capability'],
    ['PUT', '/internal/numbers/:numberId/workflow', `/internal/numbers/${numberId}/workflow`, { workflowId: null }, 'number.workflow'],
    ['POST', '/internal/dnc/numbers/remove', '/internal/dnc/numbers/remove', { country: 'MY', number: '+60198765432' }, 'dnc.remove'],
    ['PUT', '/internal/tenants/:tenantId/journey-config', `${t}/journey-config`, { maxRecoveries: 3 }, 'journey.config'],
    ['PUT', '/internal/journey/drop-latency', '/internal/journey/drop-latency', { seconds: 90 }, 'journey.drop_latency'],
    ['POST', '/internal/tenants/:tenantId/qa-criteria', `${t}/qa-criteria`, { useCase: '*', criteria: [{ id: 'calm', label: 'No escalation', type: 'no_escalation', weight: 1 }] }, 'qa.criteria'],
    ['PUT', '/internal/model-config/:taskKey', '/internal/model-config/qa_judge', { tier: 'haiku', modelId: 'haiku-model', escalateTo: 'sonnet' }, 'model.set'],
    ['PUT', '/internal/tenants/:tenantId/approval-policy', `${t}/approval-policy`, { levels: ['Approver'] }, 'approval.policy'],
    ['PUT', '/internal/tenants/:tenantId/learning/config', `${t}/learning/config`, { minSupport: 5 }, 'learning.config'],
    ['PUT', '/internal/tenants/:tenantId/case-settings', `${t}/case-settings`, { retryMax: 2 }, 'cases.settings'],
    ['PUT', '/internal/tenants/:tenantId/contact-policy', `${t}/contact-policy`, { timeZone: 'Asia/Kuala_Lumpur', quietStart: '21:00', quietEnd: '08:00', maxPerDay: 3, maxPerWeek: 10, minGapMinutes: 0 }, 'cases.contact_policy'],
    ['PUT', '/internal/tenants/:tenantId/cancellation-policy', `${t}/cancellation-policy`, { freeUntilHours: 24 }, 'appointments.policy'],
    ['PUT', '/internal/diaries/:diaryId/hours', `/internal/diaries/${diaryId}/hours`, { hours }, 'diary.hours'],
    ['PUT', '/internal/tenants/:tenantId/policy/levels', `${t}/policy/levels`, { levels: ['Owner', 'Compliance'] }, 'policy.levels'],
    ['PUT', '/internal/alerts/subscriptions', '/internal/alerts/subscriptions', { userId: staffId, minSeverity: 'high' }, 'alerts.subscribe'],
    ['POST', '/internal/alerts/subscriptions/:userId/end', `/internal/alerts/subscriptions/${staffId}/end`, {}, 'alerts.unsubscribe'],
  ];
  return list.map(([method, route, path, body, action]) => ({ method, route, path, body, action }));
}

describe('a settings change made outside the Control Tower', () => {
  it('holds every route that changes something to a decision: a reason, or exempt for a stated cause', () => {
    const listed = new Set(REASON_ROUTES.map(([m, u]) => `${m} ${u}`));
    const changing = routesOf(env.app).filter((r) => !/^(GET|HEAD) /.test(r) && r.includes(' /internal/'));
    expect(changing.filter((r) => !listed.has(r) && !(r in EXEMPT))).toEqual([]);          // a new route must be decided
    expect(Object.keys(EXEMPT).filter((r) => !changing.includes(r))).toEqual([]);          // and the list names only real routes
    expect([...listed].filter((r) => !changing.includes(r) || r in EXEMPT)).toEqual([]);
  });

  it('covers every settings route this test sends, and no other', () => {
    expect(changes().map((c) => `${c.method} ${c.route}`).sort()).toEqual(REASON_ROUTES.map(([m, u]) => `${m} ${u}`).sort());
  });

  it('is refused without a usable reason, before anything changes, on every route', async () => {
    for (const ch of changes()) {
      const before = await auditCount();
      for (const reason of [undefined, '', '  ', 'ok', 42, 'x'.repeat(501)]) {
        const r = await env.call(st(), ch.method as 'PUT', ch.path, reason === undefined ? ch.body : { ...ch.body, reason });
        expect([ch.route, r.statusCode], String(reason)).toEqual([ch.route, 400]);
        expect(r.json().error, ch.route).toMatch(/^(Say why, in a few words\.|Keep the reason under 500 characters\.)$/);
      }
      const r = await env.call(st(), ch.method as 'PUT', ch.path, { ...ch.body, reason: 'asked by +60 12-345 6789' });
      expect([ch.route, r.statusCode]).toEqual([ch.route, 400]);                                             // the audit log keeps it for good
      expect(r.json().error, ch.route).toContain('looks like it contains a phone number');
      expect(await auditCount(), ch.route).toBe(before);
    }
  });

  it('asks for the reason before the route reads its body, and refuses a body that is not an object or is missing', async () => {
    const say = 'Say why, in a few words.';
    const bad = await env.call(st(), 'PUT', `/internal/tenants/${tenantId}/entitlement`, { inboundChannels: 'many' });   // wrong for the route too
    expect([bad.statusCode, bad.json().error]).toEqual([400, say]);
    for (const payload of [[{ reason: 'In an array.' }], null]) {
      const r = await env.call(st(), 'PUT', `/internal/tenants/${tenantId}/entitlement`, payload);
      expect([r.statusCode, r.json().error]).toEqual([400, say]);
    }
    const text = await env.app.inject({ method: 'PUT', url: `/internal/tenants/${tenantId}/entitlement`, payload: 'reason=because', headers: { authorization: `Bearer ${st()}`, 'content-type': 'text/plain' } });
    expect(text.statusCode).toBeGreaterThanOrEqual(400); expect(text.statusCode).toBeLessThan(500);
    const del = await env.app.inject({ method: 'DELETE', url: `/internal/tenants/${tenantId}/transfer`, headers: { authorization: `Bearer ${st()}` } });
    expect([del.statusCode, del.json().error]).toEqual([400, say]);
  });

  it('checks who is asking first: no token is a 401 and read-only staff a 403, with or without a reason', async () => {
    for (const ch of changes()) {
      for (const body of [ch.body, { ...ch.body, reason: 'A good reason.' }]) {
        expect([ch.route, (await env.call('', ch.method as 'PUT', ch.path, body)).statusCode]).toEqual([ch.route, 401]);
        expect([ch.route, (await env.call(viewer, ch.method as 'PUT', ch.path, body)).statusCode]).toEqual([ch.route, 403]);
      }
    }
  });

  it('keeps the reason with the change, on every route, and the change log shows it', async () => {
    for (const ch of changes()) {
      // Letters only: a run of random digits could read as a phone number and be refused (lesson L-037).
      const why = `Why ${ch.action}: ${randomUUID().replace(/[^a-f]/g, '').slice(0, 6)} changed.`;
      await must(env.call(st(), ch.method as 'PUT', ch.path, { ...ch.body, reason: why }));
      const row = (await env.pool.query(`SELECT action, detail FROM audit_log ORDER BY id DESC LIMIT 1`)).rows[0];
      expect([ch.route, row.action, row.detail.reason]).toEqual([ch.route, ch.action, why]);
      const entries = (await must(env.call(st(), 'GET', '/internal/change-log?limit=5'))).json().entries as { action: string; why: string | null }[];
      expect(entries[0], ch.route).toMatchObject({ action: ch.action, why });
    }
  });

  it('does not give a change outside the list a reason it was never given', async () => {
    await must(post('/internal/fx', { currency: 'SGD', perUsd: '1.35', effectiveFrom: '2026-01-01T00:00:00Z' }));
    const row = (await env.pool.query(`SELECT action, detail FROM audit_log ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(row.action).toBe('fx.add');
    expect(row.detail).not.toHaveProperty('reason');
  });
});
