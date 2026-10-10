import type pg from 'pg';
import { hashToken, newToken } from '../secrets.js';
import { AppError } from '../errors.js';
import { audit } from './audit.js';

export type Role = 'internal_admin' | 'internal_viewer' | 'tenant_admin' | 'tenant_user';
export const STAFF_ROLES = ['internal_admin', 'internal_viewer'] as const;

export async function createTenant(c: pg.PoolClient, actorId: string | null, name: string) {
  const { rows } = await c.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id, name, created_at', [name]);
  await audit(c, actorId, 'tenant.create', 'tenant', rows[0].id, { name });
  return rows[0];
}

export const listTenants = async (c: pg.PoolClient) =>
  (await c.query('SELECT id, name, created_at FROM tenants ORDER BY name')).rows;

export async function createProject(c: pg.PoolClient, actorId: string | null, tenantId: string, name: string) {
  const { rows } = await c.query(
    'INSERT INTO projects (tenant_id, name) VALUES ($1,$2) RETURNING id, tenant_id, name, created_at',
    [tenantId, name],
  );
  await audit(c, actorId, 'project.create', 'project', rows[0].id, { tenantId, name });
  return rows[0];
}

export const listProjects = async (c: pg.PoolClient) =>
  (await c.query('SELECT id, tenant_id, name, created_at FROM projects ORDER BY name')).rows;

/** Returns the API token once; only its hash is stored. */
export async function createUser(
  c: pg.PoolClient,
  actorId: string | null,
  input: { tenantId: string | null; email: string; role: Role },
) {
  const token = newToken();
  const { rows } = await c.query(
    `INSERT INTO users (tenant_id, email, role, token_hash) VALUES ($1,$2,$3,$4)
     RETURNING id, tenant_id, email, role`,
    [input.tenantId, input.email, input.role, hashToken(token)],
  );
  await audit(c, actorId, 'user.create', 'user', rows[0].id, { email: input.email, role: input.role });
  return { ...rows[0], token };
}

/** Every user, staff first. Never the token or its hash. */
export const listUsers = async (c: pg.PoolClient) => (await c.query(
  `SELECT u.id, u.email, u.role, u.tenant_id, t.name AS tenant, u.created_at, u.disabled_at
     FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
    ORDER BY u.tenant_id IS NOT NULL, t.name, u.email`)).rows;

/**
 * Switch a user off: their token stops working at once, and it cannot be undone (add a new user instead).
 * Nobody disables themselves, so the admin acting always remains. Decided under one lock, re-checking inside it
 * that the person acting is still an active admin, so two admins disabling each other at the same moment cannot
 * leave nobody able to run the platform.
 */
export async function disableUser(c: pg.PoolClient, actorId: string, userId: string) {
  if (actorId === userId) throw new AppError(409, 'You cannot disable yourself. Ask another admin.');
  await c.query("SELECT pg_advisory_xact_lock(hashtext('users:disable'))");
  const actor = (await c.query('SELECT role, disabled_at FROM users WHERE id = $1', [actorId])).rows[0];
  if (!actor || actor.disabled_at || actor.role !== 'internal_admin') throw new AppError(403, 'Only an active admin can disable a user.');
  const target = (await c.query('SELECT id, email, role, tenant_id, disabled_at FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
  if (!target) throw new AppError(404, 'No such user.');
  if (target.disabled_at) throw new AppError(409, 'This user is already disabled.');
  const { rows } = await c.query(
    'UPDATE users SET disabled_at = now(), disabled_by = $2 WHERE id = $1 RETURNING id, email, role, tenant_id, disabled_at',
    [userId, actorId]);
  await audit(c, actorId, 'user.disable', 'user', userId, { role: target.role });
  return rows[0];
}

/**
 * The first admin, made by the installer. Running the installer again (to upgrade) finds the admin already there
 * and changes nothing: their token is not shown again, since only its hash is kept.
 */
export async function bootstrapAdmin(c: pg.PoolClient, email: string) {
  const found = (await c.query('SELECT id, email, role, disabled_at FROM users WHERE email = $1', [email])).rows[0];
  if (found) return { created: false as const, email: found.email as string, role: found.role as Role, disabled: Boolean(found.disabled_at) };
  return { created: true as const, ...(await createUser(c, null, { tenantId: null, email, role: 'internal_admin' })) };
}
