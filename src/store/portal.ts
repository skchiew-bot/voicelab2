import type pg from 'pg';
import { AppError } from '../errors.js';
import { hashToken, newToken } from '../secrets.js';
import { creditSummary } from './ledgers.js';

/**
 * The client portal, read and written as the voicelab_client role (withActor with a client actor). Calls and users are
 * read through views limited to the session's own client, and user changes go through two database functions that
 * check the person acting (migration 021). Nothing here can reach provider cost, margin or another client.
 */

const LIMIT_MAX = 200;

/** The client's own calls, newest first, a page at a time. `before` is the last call of the previous page. */
export async function clientCalls(c: pg.PoolClient, o: { limit?: number; before?: string; projectId?: string } = {}) {
  const limit = Math.min(Math.max(o.limit ?? 50, 1), LIMIT_MAX);
  const { rows } = await c.query(
    `SELECT id, project_id, project, direction, status, started_at, answered_at, ended_at, duration_seconds, outcome, credits_drawn
       FROM client_calls
      WHERE ($1::uuid IS NULL OR project_id = $1)
        AND ($2::uuid IS NULL OR (started_at, id) < (SELECT started_at, id FROM client_calls WHERE id = $2))
      ORDER BY started_at DESC, id DESC LIMIT $3`, [o.projectId ?? null, o.before ?? null, limit + 1]);
  return { calls: rows.slice(0, limit), next: rows.length > limit ? rows[limit - 1].id as string : null };
}

/** The client's balance, and the last 30 days per project: calls, calls answered, and credits drawn. */
export async function clientSummary(c: pg.PoolClient) {
  const { balance } = await creditSummary(c);
  const { rows } = await c.query(
    `SELECT project_id, project, count(*)::int AS calls, count(answered_at)::int AS answered,
            coalesce(sum(credits_drawn), 0)::numeric(18,4) AS credits_drawn
       FROM client_calls WHERE started_at > now() - interval '30 days'
      GROUP BY project_id, project ORDER BY project NULLS LAST`);
  return { balance, last30Days: rows };
}

export const clientUsers = async (c: pg.PoolClient) =>
  (await c.query('SELECT id, email, role, created_at, disabled_at FROM client_users ORDER BY email')).rows;

/** The database refuses with a code; say what it means. */
function refusal(e: unknown): never {
  const code = (e as { code?: string }).code;
  if (code === '42501') throw new AppError(403, 'Only an active client admin can manage users.');
  if (code === '22023') throw new AppError(400, 'A client user is an admin or a user.');
  if (code === 'P0002') throw new AppError(409, 'You cannot disable yourself. Ask another admin.');
  if (code === 'P0003') throw new AppError(404, 'No such user.');
  if (code === 'P0004') throw new AppError(409, 'This user is already disabled.');
  throw e;
}

/** Add a user to the client's own account. The token is shown once; only its hash is kept. */
export async function clientAddUser(c: pg.PoolClient, actorId: string, email: string, role: 'tenant_admin' | 'tenant_user') {
  const token = newToken();
  const row = await c.query('SELECT * FROM client_add_user($1, $2, $3, $4)', [actorId, email, role, hashToken(token)]).then((r) => r.rows[0], refusal);
  return { ...row, token };
}

/** Switch off a user of the client's own account, for good. */
export async function clientDisableUser(c: pg.PoolClient, actorId: string, userId: string) {
  return c.query('SELECT * FROM client_disable_user($1, $2)', [actorId, userId]).then((r) => r.rows[0], refusal);
}
