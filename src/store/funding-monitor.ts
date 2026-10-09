import type pg from 'pg';
import { AppError } from '../errors.js';
import { toScaled } from '../money.js';
import { audit } from './audit.js';

export type FundingLevel = 'ok' | 'warn' | 'critical' | 'empty';

export async function setThresholds(c: pg.PoolClient, actorId: string | null, providerId: string, e: { currency: string; warnBelow: string; criticalBelow: string }) {
  if (toScaled(e.criticalBelow) > toScaled(e.warnBelow)) throw new AppError(400, 'The critical level must not be above the warning level.');
  await c.query(
    `INSERT INTO funding_thresholds (provider_id, currency, warn_below, critical_below) VALUES ($1,$2,$3,$4)
     ON CONFLICT (provider_id, currency) DO UPDATE SET warn_below = $3, critical_below = $4`,
    [providerId, e.currency, e.warnBelow, e.criticalBelow]);
  await audit(c, actorId, 'funding.thresholds', 'provider', providerId, e as unknown as Record<string, unknown>);
}

export interface FundingStatus { providerId: string; provider: string; providerStatus: string; currency: string; balance: string; level: FundingLevel; warnBelow: string | null; criticalBelow: string | null }

/**
 * Each provider's recorded balance against its alert levels. "Empty" needs no levels; warn and critical only exist
 * where someone has set them, so a provider is never reported as running low against a level nobody chose.
 */
export async function fundingStatus(c: pg.PoolClient): Promise<FundingStatus[]> {
  const rows = (await c.query(
    `SELECT f.provider_id, p.name, p.status, f.currency, sum(f.amount) AS balance, t.warn_below, t.critical_below
       FROM provider_funding_entries f JOIN providers p ON p.id = f.provider_id
       LEFT JOIN funding_thresholds t ON t.provider_id = f.provider_id AND t.currency = f.currency
      GROUP BY f.provider_id, p.name, p.status, f.currency, t.warn_below, t.critical_below ORDER BY p.name, f.currency`)).rows;
  return rows.map((r) => {
    const b = toScaled(String(r.balance));        // exact decimals, never floating point
    const level: FundingLevel = b <= 0n ? 'empty' : r.critical_below !== null && b < toScaled(String(r.critical_below)) ? 'critical' : r.warn_below !== null && b < toScaled(String(r.warn_below)) ? 'warn' : 'ok';
    return { providerId: r.provider_id, provider: r.name, providerStatus: r.status, currency: r.currency.trim(), balance: r.balance, level, warnBelow: r.warn_below, criticalBelow: r.critical_below };
  });
}
