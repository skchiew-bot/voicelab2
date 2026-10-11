import type pg from 'pg';
import { fromScaled } from '../money.js';
import { audit } from './audit.js';
import { syncFunding } from './resilience.js';

// Ledger 1: provider funding (internal only).
export async function addFundingEntry(
  c: pg.PoolClient,
  actorId: string | null,
  e: { providerId: string; kind: 'topup' | 'usage' | 'adjustment'; amount: string; currency: string; ref?: string },
) {
  const { rows } = await c.query(
    `INSERT INTO provider_funding_entries (provider_id, kind, amount, currency, ref)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, provider_id, kind, amount, currency, ref, created_at`,
    [e.providerId, e.kind, e.amount, e.currency, e.ref ?? null],
  );
  await audit(c, actorId, 'funding.add', 'provider', e.providerId, { kind: e.kind, amount: e.amount, currency: e.currency });
  // An empty balance fails the provider over at once; a top-up puts it on probation.
  await syncFunding(c, e.providerId, { topUp: e.kind === 'topup' });
  return rows[0];
}

/**
 * A costed call draws its providers' funding down by exactly what it cost each of them, in the currency each charged in.
 * Only a balance someone keeps is drawn down: a provider, or a currency, with no funding recorded stays unknown rather
 * than looking empty and failing over (the Control Tower lists that spend as spend with no balance). A call is drawn down
 * once, and a balance it empties fails its provider over at once.
 */
export async function drawFundingForCall(c: pg.PoolClient, callId: string, lines: { providerId: string; currency: string; amount: bigint }[]) {
  const totals = new Map<string, { providerId: string; currency: string; amount: bigint }>();
  for (const l of lines) {
    const key = `${l.providerId}:${l.currency}`;
    const t = totals.get(key) ?? { providerId: l.providerId, currency: l.currency, amount: 0n };
    t.amount += l.amount;
    totals.set(key, t);
  }
  const drawn = new Set<string>();
  for (const key of [...totals.keys()].sort()) {
    const t = totals.get(key)!;
    if (t.amount <= 0n) continue;                                       // nothing to draw: a free call writes no entry
    const kept = await c.query('SELECT 1 FROM provider_funding_entries WHERE provider_id = $1 AND currency = $2 LIMIT 1', [t.providerId, t.currency]);
    if (!kept.rowCount) continue;
    const r = await c.query(
      `INSERT INTO provider_funding_entries (provider_id, kind, amount, currency, ref, call_id) VALUES ($1,'usage',$2,$3,$4,$5)
       ON CONFLICT (call_id, provider_id, currency) WHERE call_id IS NOT NULL DO NOTHING RETURNING id`,
      [t.providerId, fromScaled(-t.amount), t.currency, `call:${callId}`, callId]);
    if (r.rowCount) drawn.add(t.providerId);
  }
  // In a fixed order, so two calls costed at once take the providers' health locks the same way round (L-030).
  for (const providerId of [...drawn].sort()) await syncFunding(c, providerId);
}

export const fundingBalances = async (c: pg.PoolClient, providerId: string) =>
  (await c.query(
    `SELECT currency, sum(amount) AS balance FROM provider_funding_entries
      WHERE provider_id = $1 GROUP BY currency ORDER BY currency`,
    [providerId],
  )).rows;

// Ledger 2: client credits.
export async function addCreditEntry(
  c: pg.PoolClient,
  actorId: string | null,
  e: { tenantId: string; projectId?: string; kind: 'grant' | 'usage' | 'adjustment'; credits: string; ref?: string },
) {
  const { rows } = await c.query(
    `INSERT INTO credit_entries (tenant_id, project_id, kind, credits, ref)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, tenant_id, project_id, kind, credits, ref, created_at`,
    [e.tenantId, e.projectId ?? null, e.kind, e.credits, e.ref ?? null],
  );
  await audit(c, actorId, 'credits.add', 'tenant', e.tenantId, { kind: e.kind, credits: e.credits });
  return rows[0];
}

/** Row-level security scopes this to the caller's tenant when run as a client. */
export async function creditSummary(c: pg.PoolClient, tenantId?: string) {
  const where = tenantId ? 'WHERE tenant_id = $1' : '';
  const args = tenantId ? [tenantId] : [];
  const balance = await c.query(`SELECT coalesce(sum(credits), 0) AS balance FROM credit_entries ${where}`, args);
  const recent = await c.query(
    `SELECT id, project_id, kind, credits, ref, created_at FROM credit_entries ${where}
      ORDER BY id DESC LIMIT 50`,
    args,
  );
  return { balance: balance.rows[0].balance as string, recent: recent.rows };
}
