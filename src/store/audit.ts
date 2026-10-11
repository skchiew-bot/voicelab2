import type pg from 'pg';

export async function audit(
  c: pg.PoolClient,
  actorId: string | null,
  action: string,
  entity: string,
  entityId: string | null,
  detail: Record<string, unknown> = {},
): Promise<void> {
  // A settings change's reason, carried by the transaction (`withActor`), is kept with the change unless it gave its own.
  await c.query(
    `INSERT INTO audit_log (actor_id, action, entity, entity_id, detail)
     VALUES ($1,$2,$3,$4, CASE WHEN coalesce(current_setting('voicelab.change_reason', true), '') <> '' AND NOT ($5::jsonb ? 'reason')
                               THEN $5::jsonb || jsonb_build_object('reason', current_setting('voicelab.change_reason', true)) ELSE $5::jsonb END)`,
    [actorId, action, entity, entityId, detail],
  );
}
