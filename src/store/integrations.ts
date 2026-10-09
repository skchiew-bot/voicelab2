import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { AppError } from '../errors.js';
import { encryptSecrets } from '../secrets.js';
import { baseUrlProblem } from '../workflows/integrations.js';
import { audit } from './audit.js';

/** Save an integration a workflow can call. The key is encrypted and never returned. */
export async function createIntegration(
  c: pg.PoolClient, key: Buffer, actorId: string | null,
  e: { tenantId: string; name: string; baseUrl: string; authHeader?: string; authSecret?: string },
) {
  const problem = baseUrlProblem(e.baseUrl);
  if (problem) throw new AppError(400, `That address cannot be used: ${problem}`);
  if ((e.authHeader === undefined) !== (e.authSecret === undefined)) throw new AppError(400, 'Give both the key\'s header name and the key, or neither.');
  if (e.authHeader !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(e.authHeader)) throw new AppError(400, 'The header name may only use letters, digits and "-".');
  if (e.authSecret !== undefined && (/[\r\n\0]/.test(e.authSecret) || e.authSecret.length > 4096 || e.authSecret.trim() === '')) throw new AppError(400, 'The key must be a single line of at most 4096 characters.');
  if (e.authHeader !== undefined && ['host', 'content-length', 'content-type', 'transfer-encoding', 'connection'].includes(e.authHeader.toLowerCase())) {
    throw new AppError(400, `"${e.authHeader}" cannot be used for the key.`);
  }
  const id = randomUUID();
  const secret = e.authSecret === undefined ? null : encryptSecrets({ value: e.authSecret }, key, id);
  const row = (await c.query(
    `INSERT INTO integrations (id, tenant_id, name, base_url, auth_header, auth_secret) VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, tenant_id, name, base_url, auth_header, created_at`,
    [id, e.tenantId, e.name, e.baseUrl, e.authHeader ?? null, secret])).rows[0];
  await audit(c, actorId, 'integration.create', 'integration', id, { name: e.name, host: new URL(e.baseUrl).hostname, keyStored: secret !== null });
  return { ...row, key_stored: secret !== null };
}

export const listIntegrations = async (c: pg.PoolClient, tenantId: string) =>
  (await c.query(
    `SELECT id, name, base_url, auth_header, (auth_secret IS NOT NULL) AS key_stored, created_at FROM integrations WHERE tenant_id = $1 ORDER BY name`, [tenantId])).rows;
