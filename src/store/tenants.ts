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

/** A user who may act now: not disabled and, for an admin added by another admin, approved by a third person. */
export const ACTIVE = 'disabled_at IS NULL AND (role <> \'internal_admin\' OR created_by IS NULL OR approved_at IS NOT NULL)';

/**
 * Returns the API token once; only its hash is stored. An admin added by another admin (actorId set) cannot act
 * until a different admin approves them (`approveAdmin`).
 */
export async function createUser(
  c: pg.PoolClient,
  actorId: string | null,
  input: { tenantId: string | null; email: string; role: Role },
) {
  const token = newToken();
  const email = input.email.trim().toLowerCase();
  const { rows } = await c.query(
    `INSERT INTO users (tenant_id, email, role, token_hash, created_by) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, tenant_id, email, role`,
    [input.tenantId, email, input.role, hashToken(token), actorId],
  );
  await audit(c, actorId, 'user.create', 'user', rows[0].id, { email, role: input.role });
  const pending = input.role === 'internal_admin' && actorId !== null;
  return { ...rows[0], token, pendingApproval: pending };
}

/** Every user, staff first. Never the token or its hash. */
export const listUsers = async (c: pg.PoolClient) => (await c.query(
  `SELECT u.id, u.email, u.role, u.tenant_id, t.name AS tenant, u.created_at, u.created_by, u.disabled_at,
          (u.role = 'internal_admin' AND u.created_by IS NOT NULL AND u.approved_at IS NULL) AS pending_approval
     FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
    ORDER BY u.tenant_id IS NOT NULL, t.name, u.email`)).rows;

/** Every change to who can act is decided under this one lock, with the person acting re-checked inside it. */
async function lockAsActiveAdmin(c: pg.PoolClient, actorId: string, what: string) {
  await c.query("SELECT pg_advisory_xact_lock(hashtext('users:manage'))");
  const actor = (await c.query(`SELECT role FROM users WHERE id = $1 AND ${ACTIVE}`, [actorId])).rows[0];
  if (!actor || actor.role !== 'internal_admin') throw new AppError(403, `Only an active admin can ${what}.`);
}

/**
 * Switch a user off: their token stops working at once, and it cannot be undone (add a new user instead).
 * Nobody disables themselves, so the admin acting always remains. Decided under one lock, re-checking inside it
 * that the person acting is still an active admin, so two admins disabling each other at the same moment cannot
 * leave nobody able to run the platform.
 */
export async function disableUser(c: pg.PoolClient, actorId: string, userId: string) {
  if (actorId === userId) throw new AppError(409, 'You cannot disable yourself. Ask another admin.');
  await lockAsActiveAdmin(c, actorId, 'disable a user');
  // A client's user is also managed by the client's own admins (migration 021), under one lock per client: take it too,
  // before the user's row, in the order the client's own path takes them (lesson L-030).
  const tenantId = (await c.query('SELECT tenant_id FROM users WHERE id = $1', [userId])).rows[0]?.tenant_id as string | null | undefined;
  if (tenantId) await c.query("SELECT pg_advisory_xact_lock(hashtext('client-users:' || $1))", [tenantId]);
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
 * Let a new admin act. The approver must be an active admin other than the new admin and other than whoever added
 * them, so no one admin can create an identity that passes a "different person" rule on their behalf.
 */
export async function approveAdmin(c: pg.PoolClient, actorId: string, userId: string) {
  await lockAsActiveAdmin(c, actorId, 'approve an admin');
  const target = (await c.query('SELECT id, role, created_by, approved_at, disabled_at FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
  if (!target) throw new AppError(404, 'No such user.');
  if (target.role !== 'internal_admin' || target.created_by === null || target.approved_at) throw new AppError(409, 'This user is not waiting for approval.');
  if (target.disabled_at) throw new AppError(409, 'This user is disabled.');
  if (target.created_by === actorId || userId === actorId) throw new AppError(403, 'You added this admin, so another admin has to approve them.');
  const { rows } = await c.query(
    'UPDATE users SET approved_at = now(), approved_by = $2 WHERE id = $1 RETURNING id, email, role, approved_at',
    [userId, actorId]);
  await audit(c, actorId, 'user.approve', 'user', userId, { role: target.role });
  return rows[0];
}

/**
 * The first admin, made by the installer. Running the installer again (to upgrade) finds the admin already there
 * and changes nothing: their token is not shown again, since only its hash is kept.
 */
export async function bootstrapAdmin(c: pg.PoolClient, email: string) {
  const address = email.trim().toLowerCase();
  // Two installers at once: the second waits here and then finds the first one's admin.
  await c.query("SELECT pg_advisory_xact_lock(hashtext('users:manage'))");
  const found = (await c.query('SELECT id, email, role, disabled_at FROM users WHERE tenant_id IS NULL AND lower(email) = $1', [address])).rows[0];
  if (found) return { created: false as const, email: found.email as string, role: found.role as Role, disabled: Boolean(found.disabled_at) };
  return { created: true as const, ...(await createUser(c, null, { tenantId: null, email: address, role: 'internal_admin' })) };
}
