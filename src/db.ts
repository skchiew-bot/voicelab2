import pg from 'pg';

// numeric -> string stays as is (money must not pass through floats); bigint ids -> number.
pg.types.setTypeParser(20, (v) => Number(v));

/** readOnly: staff who may look but not change anything; their transactions are read-only in the database too. */
export type Actor = { kind: 'internal'; readOnly?: boolean } | { kind: 'client'; tenantId: string };

export function createPool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString });
}

/**
 * Run fn in a transaction as the given actor. The role switch is what makes
 * isolation real: a client actor physically cannot read internal tables.
 */
export async function withActor<T>(
  pool: pg.Pool,
  actor: Actor,
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query(actor.kind === 'internal' && actor.readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    if (actor.kind === 'internal') {
      await c.query('SET LOCAL ROLE voicelab_internal');
    } else {
      await c.query('SET LOCAL ROLE voicelab_client');
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [actor.tenantId]);
    }
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}
