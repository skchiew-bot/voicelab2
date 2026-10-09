import type pg from 'pg';

export async function audit(
  c: pg.PoolClient,
  actorId: string | null,
  action: string,
  entity: string,
  entityId: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  await c.query(
    'INSERT INTO audit_log (actor_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5)',
    [actorId, action, entity, entityId, detail],
  );
}
