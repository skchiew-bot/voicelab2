import type pg from 'pg';

export interface CallEventInput {
  tenantId: string;
  projectId?: string;
  callId: string;
  type: string;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}

/** Every later component writes here; the Control Tower and replay read from it. */
export async function recordEvent(c: pg.PoolClient, e: CallEventInput) {
  const { rows } = await c.query(
    `INSERT INTO call_events (tenant_id, project_id, call_id, type, payload, occurred_at)
     VALUES ($1,$2,$3,$4,$5, coalesce($6, now())) RETURNING id, occurred_at`,
    [e.tenantId, e.projectId ?? null, e.callId, e.type, e.payload ?? {}, e.occurredAt ?? null],
  );
  return rows[0];
}

export const eventsForCall = async (c: pg.PoolClient, callId: string) =>
  (await c.query(
    `SELECT id, tenant_id, project_id, call_id, type, payload, occurred_at
       FROM call_events WHERE call_id = $1 ORDER BY occurred_at, id`,
    [callId],
  )).rows;
