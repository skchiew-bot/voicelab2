import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { withActor, type Actor } from '../db.js';
import {
  addBlock, agenda, appointmentSummary, availableSlots, blockSchema, book, bookSchema, cancelAppointment, cancelSchema, completeAppointment, createDiary, createLocation, delaySchema, diarySchema,
  getAppointment, getDiary, getPolicy, hoursSchema, listDiaries, listLocations, listNotifications, locationSchema, markNoShow, markNotification, policySchema, reportDelay, reschedule,
  rescheduleSchema, setHours, setPolicy, sweepReminders,
} from '../store/appointments.js';

interface Ctx { pool: pg.Pool; internal(req: FastifyRequest): Promise<{ userId: string; actor: Actor }> }
const id = z.string().uuid();

/** Phase 7, appointments. Staff only for now: a diary holds where customers will be and when. */
export function registerAppointmentRoutes(app: FastifyInstance, ctx: Ctx): void {
  const run = async <T>(req: FastifyRequest, fn: (c: pg.PoolClient, userId: string) => Promise<T>) => {
    const s = await ctx.internal(req);
    return withActor(ctx.pool, s.actor, (c) => fn(c, s.userId));
  };
  const tenant = z.object({ tenantId: id });

  app.get('/internal/tenants/:tenantId/locations', async (req) => { const { tenantId } = tenant.parse(req.params); return run(req, (c) => listLocations(c, tenantId)); });
  app.post('/internal/tenants/:tenantId/locations', async (req, reply) => { const { tenantId } = tenant.parse(req.params); const b = locationSchema.parse(req.body); return reply.code(201).send(await run(req, (c, u) => createLocation(c, u, tenantId, b))); });
  app.get('/internal/tenants/:tenantId/diaries', async (req) => { const { tenantId } = tenant.parse(req.params); return run(req, (c) => listDiaries(c, tenantId)); });
  app.post('/internal/tenants/:tenantId/diaries', async (req, reply) => { const { tenantId } = tenant.parse(req.params); const b = diarySchema.parse(req.body); return reply.code(201).send(await run(req, (c, u) => createDiary(c, u, tenantId, b))); });
  app.get('/internal/diaries/:diaryId', async (req) => { const { diaryId } = z.object({ diaryId: id }).parse(req.params); return run(req, (c) => getDiary(c, diaryId)); });
  app.put('/internal/diaries/:diaryId/hours', async (req) => { const { diaryId } = z.object({ diaryId: id }).parse(req.params); const b = hoursSchema.parse(req.body); return run(req, (c, u) => setHours(c, u, diaryId, b)); });
  app.post('/internal/diaries/:diaryId/blocks', async (req, reply) => { const { diaryId } = z.object({ diaryId: id }).parse(req.params); const b = blockSchema.parse(req.body); return reply.code(201).send(await run(req, (c, u) => addBlock(c, u, diaryId, b))); });
  app.get('/internal/diaries/:diaryId/slots', async (req) => {
    const { diaryId } = z.object({ diaryId: id }).parse(req.params);
    const q = z.object({ date: z.string(), durationMinutes: z.coerce.number().int(), travelMinutes: z.coerce.number().int().min(0).max(600).optional() }).parse(req.query);
    return run(req, (c) => availableSlots(c, diaryId, q));
  });
  app.get('/internal/diaries/:diaryId/agenda', async (req) => { const { diaryId } = z.object({ diaryId: id }).parse(req.params); const q = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query); return run(req, (c) => agenda(c, diaryId, q.date)); });
  app.get('/internal/tenants/:tenantId/cancellation-policy', async (req) => { const { tenantId } = tenant.parse(req.params); return run(req, (c) => getPolicy(c, tenantId)); });
  app.put('/internal/tenants/:tenantId/cancellation-policy', async (req) => { const { tenantId } = tenant.parse(req.params); const b = policySchema.parse(req.body ?? {}); return run(req, (c, u) => setPolicy(c, u, tenantId, b)); });

  app.post('/internal/tenants/:tenantId/appointments', async (req, reply) => { const { tenantId } = tenant.parse(req.params); const b = bookSchema.parse(req.body); return reply.code(201).send(await run(req, (c, u) => book(c, u, tenantId, b))); });
  app.get('/internal/appointments/:appointmentId', async (req) => { const { appointmentId } = z.object({ appointmentId: id }).parse(req.params); return run(req, (c) => getAppointment(c, appointmentId)); });
  app.post('/internal/appointments/:appointmentId/delay', async (req) => { const { appointmentId } = z.object({ appointmentId: id }).parse(req.params); const b = delaySchema.parse(req.body); return run(req, (c, u) => reportDelay(c, u, appointmentId, b)); });
  app.post('/internal/appointments/:appointmentId/cancel', async (req) => { const { appointmentId } = z.object({ appointmentId: id }).parse(req.params); const b = cancelSchema.parse(req.body); return run(req, (c, u) => cancelAppointment(c, u, appointmentId, b)); });
  app.post('/internal/appointments/:appointmentId/reschedule', async (req) => { const { appointmentId } = z.object({ appointmentId: id }).parse(req.params); const b = rescheduleSchema.parse(req.body); return run(req, (c, u) => reschedule(c, u, appointmentId, b)); });
  app.post('/internal/appointments/:appointmentId/no-show', async (req) => { const { appointmentId } = z.object({ appointmentId: id }).parse(req.params); return run(req, (c, u) => markNoShow(c, u, appointmentId)); });
  app.post('/internal/appointments/:appointmentId/complete', async (req) => { const { appointmentId } = z.object({ appointmentId: id }).parse(req.params); return run(req, (c, u) => completeAppointment(c, u, appointmentId)); });

  // Messages the client's own sender delivers, and the scheduled job that writes reminders.
  app.get('/internal/tenants/:tenantId/notifications', async (req) => { const { tenantId } = tenant.parse(req.params); const q = z.object({ status: z.enum(['pending', 'sent', 'failed']).optional() }).parse(req.query); return run(req, (c) => listNotifications(c, tenantId, q.status)); });
  app.post('/internal/notifications/:notificationId/mark', async (req) => { const { notificationId } = z.object({ notificationId: id }).parse(req.params); const b = z.object({ status: z.enum(['sent', 'failed']) }).parse(req.body); return run(req, (c, u) => markNotification(c, u, notificationId, b.status)); });
  app.post('/internal/tenants/:tenantId/appointments/sweep-reminders', async (req) => { const { tenantId } = tenant.parse(req.params); return run(req, (c) => sweepReminders(c, tenantId)); });
  app.get('/internal/tenants/:tenantId/appointments-summary', async (req) => { const { tenantId } = tenant.parse(req.params); return run(req, (c) => appointmentSummary(c, tenantId)); });
}
