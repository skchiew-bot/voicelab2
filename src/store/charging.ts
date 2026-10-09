import type pg from 'pg';
import { AppError } from '../errors.js';
import { audit } from './audit.js';

export interface ChargingInput {
  effectiveFrom: Date;
  billingIncrementSeconds: number;
  minimumChargeSeconds?: number;
  rounding?: 'up' | 'nearest' | 'down';
  concurrencyLimit?: number | null;
  burstPremiumMultiplier?: number | null;
  notes?: string;
  components: {
    component: string; unit: string; rate: string; currency: string; billingLine?: string; direction?: 'any' | 'inbound' | 'outbound';
  }[];
}

/** A rate change is a new version. Existing versions are never edited. */
export async function addChargingVersion(
  c: pg.PoolClient,
  actorId: string | null,
  providerId: string,
  input: ChargingInput,
) {
  // A line that applies to any call, or is listed twice for one direction, would charge a call twice.
  const seen = new Map<string, Set<string>>();
  for (const comp of input.components) {
    const key = `${comp.component}|${comp.billingLine ?? 'main'}`;
    const dirs = seen.get(key) ?? new Set<string>();
    const dir = comp.direction ?? 'any';
    if (dirs.has(dir) || (dirs.size > 0 && (dir === 'any' || dirs.has('any')))) {
      throw new AppError(400, `"${comp.component}" on line "${comp.billingLine ?? 'main'}" would charge a call twice: a line may apply to any call, or have one rate per direction, not both.`);
    }
    dirs.add(dir); seen.set(key, dirs);
  }

  // Lock the provider row so two concurrent changes cannot pick the same version number.
  const lock = await c.query('SELECT id FROM providers WHERE id = $1 FOR UPDATE', [providerId]);
  if (!lock.rows[0]) throw new AppError(404, 'Provider not found.');

  const last = await c.query(
    'SELECT version, effective_from FROM charging_versions WHERE provider_id = $1 ORDER BY version DESC LIMIT 1',
    [providerId],
  );
  if (last.rows[0] && input.effectiveFrom <= last.rows[0].effective_from) {
    throw new AppError(409, 'Effective date must be later than the current version\'s effective date.');
  }
  const version = (last.rows[0]?.version ?? 0) + 1;

  const v = await c.query(
    `INSERT INTO charging_versions
       (provider_id, version, effective_from, billing_increment_seconds, minimum_charge_seconds,
        rounding, concurrency_limit, burst_premium_multiplier, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [providerId, version, input.effectiveFrom, input.billingIncrementSeconds, input.minimumChargeSeconds ?? 0,
      input.rounding ?? 'up', input.concurrencyLimit ?? null, input.burstPremiumMultiplier ?? null, input.notes ?? null],
  );
  for (const comp of input.components) {
    await c.query(
      `INSERT INTO charging_components (charging_version_id, component, unit, rate, currency, billing_line, direction)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [v.rows[0].id, comp.component, comp.unit, comp.rate, comp.currency, comp.billingLine ?? 'main', comp.direction ?? 'any'],
    );
  }
  await audit(c, actorId, 'charging.add_version', 'provider', providerId, { version });
  return getVersion(c, v.rows[0].id);
}

async function getVersion(c: pg.PoolClient, versionId: string) {
  const { rows } = await c.query(
    `SELECT v.*, (cc.charging_version_id IS NOT NULL) AS confirmed, cc.source_url, cc.confirmed_at
       FROM charging_versions v
       LEFT JOIN charging_confirmations cc ON cc.charging_version_id = v.id
      WHERE v.id = $1`,
    [versionId],
  );
  if (!rows[0]) throw new AppError(404, 'Charging version not found.');
  const comps = await c.query(
    `SELECT component, unit, rate, currency, billing_line, direction FROM charging_components
      WHERE charging_version_id = $1 ORDER BY billing_line, component`,
    [versionId],
  );
  return { ...rows[0], components: comps.rows };
}

/** The version in force at a point in time, or null if the provider has none yet. */
export async function chargingAt(c: pg.PoolClient, providerId: string, at: Date) {
  const { rows } = await c.query(
    `SELECT id FROM charging_versions WHERE provider_id = $1 AND effective_from <= $2
      ORDER BY effective_from DESC LIMIT 1`,
    [providerId, at],
  );
  return rows[0] ? getVersion(c, rows[0].id) : null;
}

export async function listChargingVersions(c: pg.PoolClient, providerId: string) {
  const { rows } = await c.query('SELECT id FROM charging_versions WHERE provider_id = $1 ORDER BY version', [providerId]);
  const out = [];
  for (const r of rows) out.push(await getVersion(c, r.id)); // one client: queries must run in sequence
  return out;
}

export async function confirmVersion(c: pg.PoolClient, actorId: string, versionId: string, sourceUrl: string) {
  const exists = await c.query('SELECT 1 FROM charging_versions WHERE id = $1', [versionId]);
  if (!exists.rows[0]) throw new AppError(404, 'Charging version not found.');
  await c.query(
    'INSERT INTO charging_confirmations (charging_version_id, confirmed_by, source_url) VALUES ($1,$2,$3)',
    [versionId, actorId, sourceUrl],
  );
  await audit(c, actorId, 'charging.confirm', 'charging_version', versionId, { sourceUrl });
  return getVersion(c, versionId);
}
