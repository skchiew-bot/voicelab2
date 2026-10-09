import type pg from 'pg';
import { hashToken, newToken } from '../secrets.js';
import { audit } from './audit.js';

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
  input: { tenantId: string | null; email: string; role: 'internal_admin' | 'tenant_admin' | 'tenant_user' },
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
