import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { checkParams, getAdapter } from '../adapters/registry.js';
import { CAPABILITIES, type ParamValues, type Support } from '../adapters/types.js';
import { AppError } from '../errors.js';
import { encryptSecrets } from '../secrets.js';
import { audit } from './audit.js';

/** Public shape of a provider: secrets are reported only as "which keys are set". */
const publicCols = `p.id, p.adapter_key, p.kind, p.name, p.params, p.status, p.created_at,
  octet_length(p.secret_params) > 0 AS secrets_stored`;

export async function createProvider(
  c: pg.PoolClient,
  key: Buffer,
  actorId: string | null,
  input: { adapterKey: string; name: string; params: ParamValues },
) {
  const adapter = getAdapter(input.adapterKey);
  if (!adapter) throw new AppError(400, `Unknown adapter "${input.adapterKey}".`);
  const checked = checkParams(adapter, input.params);
  if (!checked.ok) throw new AppError(400, 'Provider settings are not valid.', checked.errors);

  const id = randomUUID();
  const blob = encryptSecrets(checked.split.secret, key, id);
  await c.query(
    `INSERT INTO providers (id, adapter_key, kind, name, params, secret_params)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, adapter.key, adapter.kind, input.name, checked.split.plain, blob],
  );
  for (const capability of CAPABILITIES) {
    await c.query(
      'INSERT INTO provider_capabilities (provider_id, capability, support) VALUES ($1,$2,$3)',
      [id, capability, adapter.defaultCapabilities[capability]],
    );
  }
  await audit(c, actorId, 'provider.create', 'provider', id, {
    adapter: adapter.key, name: input.name, secretKeys: Object.keys(checked.split.secret),
  });
  return getProvider(c, id);
}

export async function getProvider(c: pg.PoolClient, id: string) {
  const { rows } = await c.query(`SELECT ${publicCols} FROM providers p WHERE p.id = $1`, [id]);
  if (!rows[0]) throw new AppError(404, 'Provider not found.');
  return withDetail(c, rows[0]);
}

export async function listProviders(c: pg.PoolClient) {
  const { rows } = await c.query(`SELECT ${publicCols} FROM providers p ORDER BY p.name`);
  const out = [];
  for (const r of rows) out.push(await withDetail(c, r)); // one client: queries must run in sequence
  return out;
}

async function withDetail(c: pg.PoolClient, row: Record<string, unknown>) {
  const id = row.id as string;
  const caps = await c.query(
    'SELECT capability, support, notes FROM provider_capabilities WHERE provider_id = $1 ORDER BY capability',
    [id],
  );
  // Secrets are reported only as present or not, never their values or length.
  return { ...row, capabilities: caps.rows };
}

export async function setCapability(
  c: pg.PoolClient,
  actorId: string | null,
  providerId: string,
  capability: string,
  support: Support,
  notes?: string,
) {
  if (!(CAPABILITIES as readonly string[]).includes(capability)) throw new AppError(400, `Unknown capability "${capability}".`);
  const res = await c.query(
    `UPDATE provider_capabilities SET support = $3, notes = $4 WHERE provider_id = $1 AND capability = $2`,
    [providerId, capability, support, notes ?? null],
  );
  if (res.rowCount === 0) throw new AppError(404, 'Provider not found.');
  await audit(c, actorId, 'provider.capability', 'provider', providerId, { capability, support });
}
