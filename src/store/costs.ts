import type pg from 'pg';
import { billedSeconds, lineAmount, quantityFor, type Unit, type Usage } from '../billing.js';
import { AppError } from '../errors.js';
import { fromScaled, mulDiv, SCALE, toScaled } from '../money.js';
import { audit } from './audit.js';
import { drawFundingForCall } from './ledgers.js';

// ----------------------------------------------------------------- FX
export async function addFxRate(
  c: pg.PoolClient, actorId: string | null, e: { currency: string; perUsd: string; effectiveFrom: Date },
) {
  const { rows } = await c.query(
    `INSERT INTO fx_rates (currency, per_usd, effective_from) VALUES ($1,$2,$3)
     RETURNING id, currency, per_usd, effective_from`,
    [e.currency, e.perUsd, e.effectiveFrom],
  );
  await audit(c, actorId, 'fx.add', 'fx_rate', String(rows[0].id), { currency: e.currency, perUsd: e.perUsd });
  return rows[0];
}

export const listFxRates = async (c: pg.PoolClient) =>
  (await c.query('SELECT id, currency, per_usd, effective_from FROM fx_rates ORDER BY currency, effective_from DESC')).rows;

/** Units of `currency` per 1 USD in force at `at`, as a scaled integer. USD is 1. */
export async function perUsd(c: pg.PoolClient, currency: string, at: Date): Promise<bigint> {
  if (currency === 'USD') return SCALE;
  const { rows } = await c.query(
    `SELECT per_usd FROM fx_rates WHERE currency = $1 AND effective_from <= $2
      ORDER BY effective_from DESC LIMIT 1`,
    [currency, at],
  );
  if (!rows[0]) throw new AppError(409, `No FX rate for ${currency} in force at ${at.toISOString()}. Add one before costing calls.`);
  return toScaled(rows[0].per_usd);
}

// ---------------------------------------------------------- rate card
export async function addRateCard(
  c: pg.PoolClient, actorId: string | null,
  e: { effectiveFrom: Date; inboundCreditsPerMinute: string; outboundCreditsPerMinute: string; creditValueUsd: string },
) {
  const { rows } = await c.query(
    `INSERT INTO rate_cards (effective_from, inbound_credits_per_minute, outbound_credits_per_minute, credit_value_usd)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [e.effectiveFrom, e.inboundCreditsPerMinute, e.outboundCreditsPerMinute, e.creditValueUsd],
  );
  await audit(c, actorId, 'rate_card.add', 'rate_card', String(rows[0].id), {});
  return rows[0];
}

export const listRateCards = async (c: pg.PoolClient) =>
  (await c.query('SELECT * FROM rate_cards ORDER BY effective_from DESC')).rows;

// ------------------------------------------------------- per-call cost
export interface CallCostInput {
  callId: string;
  tenantId: string;
  projectId?: string;
  direction: 'inbound' | 'outbound';
  occurredAt: Date;
  /** What the client's credits are multiplied by (an overburst premium the client agreed to), if any. */
  creditMultiplier?: string;
  /** False for a call that was never served (a caller who gave up in the queue): provider cost is recorded, credits are not drawn. */
  drawCredits?: boolean;
  /** Seconds at the start of the call that are not billed to the client (time spent waiting in the queue). */
  creditSkipSeconds?: number;
  /** One entry per provider that served part of the call. */
  usage: { providerId: string; usage: Usage; relay?: boolean }[];
}

interface Line {
  providerId: string; chargingVersionId: string; component: string; billingLine: string; unit: string;
  quantity: string; billedSeconds: number | null; rate: string; currency: string;
  burstMultiplier: string | null; amount: bigint; perUsd: bigint; amountUsd: bigint;
}

/**
 * Price a call from the rates in force when it happened and store the record.
 * Re-sending the same call returns the stored record and draws no credits twice.
 */
export async function recordCallCost(c: pg.PoolClient, actorId: string | null, input: CallCostInput) {
  // Serialise retries of the same call so a double delivery cannot draw credits twice.
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [input.callId]);
  const existing = await c.query(`SELECT id FROM call_costs WHERE call_id = $1 AND status = 'estimated'`, [input.callId]);
  if (existing.rows[0]) return getCallCost(c, input.callId);
  if (input.usage.length === 0) throw new AppError(400, 'A call cost needs at least one provider usage.');

  const lines: Line[] = [];
  let creditSeconds: number | null = null;

  for (const item of input.usage) {
    const provider = (await c.query('SELECT id, kind FROM providers WHERE id = $1', [item.providerId])).rows[0];
    if (!provider) throw new AppError(400, `Unknown provider ${item.providerId}.`);

    const version = (await c.query(
      `SELECT * FROM charging_versions WHERE provider_id = $1 AND effective_from <= $2
        ORDER BY effective_from DESC LIMIT 1`,
      [item.providerId, input.occurredAt],
    )).rows[0];
    if (!version) {
      throw new AppError(409, `Provider ${item.providerId} has no charging version in force at ${input.occurredAt.toISOString()}. Capture its rates first.`);
    }

    const billed = item.usage.seconds === undefined ? null : billedSeconds(item.usage.seconds, {
      billingIncrementSeconds: version.billing_increment_seconds,
      minimumChargeSeconds: version.minimum_charge_seconds,
      rounding: version.rounding,
    });
    if (provider.kind === 'telephony' && !item.relay && billed !== null && creditSeconds === null) creditSeconds = input.drawCredits === false ? null : Math.max(0, billed - Math.ceil(input.creditSkipSeconds ?? 0));

    const burst = item.usage.burst && version.burst_premium_multiplier ? version.burst_premium_multiplier : null;
    const comps = (await c.query(
      `SELECT component, unit, rate, currency, billing_line FROM charging_components
        WHERE charging_version_id = $1 AND direction IN ('any', $2) AND (billing_line = 'relay') = $3 ORDER BY id`,
      [version.id, input.direction, item.relay === true],
    )).rows;

    // Every part of the usage must meet a rate: a part no rate covers would be costed as nothing, which is a guess.
    const covered = new Set<string>();
    for (const comp of comps) {
      const q = quantityFor(comp.unit as Unit, comp.billing_line, item.usage, billed);
      if (!q) continue;
      for (const part of partsOf(comp.unit as Unit, comp.billing_line)) covered.add(part);
      let amount = lineAmount(comp.rate, q);
      if (burst) amount = mulDiv(amount, toScaled(burst), SCALE);
      const fx = await perUsd(c, comp.currency, input.occurredAt);
      lines.push({
        providerId: item.providerId, chargingVersionId: version.id, component: comp.component,
        billingLine: comp.billing_line, unit: comp.unit, quantity: q.display, billedSeconds: q.billedSeconds,
        rate: comp.rate, currency: comp.currency, burstMultiplier: burst, amount, perUsd: fx,
        amountUsd: mulDiv(amount, SCALE, fx), // currency -> USD
      });
    }
    const used: [string, number | undefined][] = [['seconds', item.usage.seconds], ['characters', item.usage.characters], ['input tokens', item.usage.inputTokens], ['output tokens', item.usage.outputTokens]];
    const missing = used.filter(([part, n]) => (n ?? 0) > 0 && !covered.has(part)).map(([part]) => part);
    if (missing.length) {
      throw new AppError(400, `Provider ${item.providerId} has no ${item.relay ? 'speech relay ' : ''}rate for the ${missing.join(' and ')} this call used${item.relay ? ' (a "relay" billing line on its charging version)' : ''}. Add one, then cost the call again.`);
    }
  }
  if (lines.length === 0) throw new AppError(400, 'The usage given does not match any billable component of those providers.');

  const totalUsd = lines.reduce((s, l) => s + l.amountUsd, 0n);
  const myrPerUsd = await perUsd(c, 'MYR', input.occurredAt);
  const totalMyr = mulDiv(totalUsd, myrPerUsd, SCALE);

  // Credits: zero until a rate card exists. Uses the telephony provider's billed seconds.
  const card = (await c.query(
    'SELECT * FROM rate_cards WHERE effective_from <= $1 ORDER BY effective_from DESC LIMIT 1', [input.occurredAt],
  )).rows[0];
  let credits = 0n;
  let creditValueUsd = 0n;
  if (card && creditSeconds !== null) {
    const perMinute = toScaled(input.direction === 'inbound' ? card.inbound_credits_per_minute : card.outbound_credits_per_minute);
    // Credits are kept to 4 decimal places (rounded half up), and margin uses the rounded figure.
    const base = mulDiv(perMinute, BigInt(creditSeconds), 60n);
    credits = mulDiv(input.creditMultiplier ? mulDiv(base, toScaled(input.creditMultiplier), SCALE) : base, 1n, 10_000n) * 10_000n;
    creditValueUsd = toScaled(card.credit_value_usd);
  }
  const marginUsd = mulDiv(credits, creditValueUsd, SCALE) - totalUsd;

  const head = (await c.query(
    `INSERT INTO call_costs (call_id, tenant_id, project_id, direction, occurred_at, total_usd, myr_per_usd,
                             total_myr, credits_drawn, credit_value_usd, margin_usd)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [input.callId, input.tenantId, input.projectId ?? null, input.direction, input.occurredAt,
      fromScaled(totalUsd), fromScaled(myrPerUsd), fromScaled(totalMyr),
      fromScaled(credits).slice(0, -4), fromScaled(creditValueUsd), fromScaled(marginUsd)],
  )).rows[0];

  for (const l of lines) {
    await c.query(
      `INSERT INTO call_cost_lines (call_cost_id, provider_id, charging_version_id, component, billing_line, unit,
         quantity, billed_seconds, rate, currency, burst_multiplier, amount, per_usd, amount_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [head.id, l.providerId, l.chargingVersionId, l.component, l.billingLine, l.unit, l.quantity, l.billedSeconds,
        l.rate, l.currency, l.burstMultiplier, fromScaled(l.amount), fromScaled(l.perUsd), fromScaled(l.amountUsd)],
    );
  }

  // The providers' own funding goes down by what the call cost them. Once, here: a reconciled record copies these lines.
  await drawFundingForCall(c, input.callId, lines.map((l) => ({ providerId: l.providerId, currency: l.currency, amount: l.amount })));

  if (credits > 0n) {
    await c.query(
      `INSERT INTO credit_entries (tenant_id, project_id, kind, credits, ref) VALUES ($1,$2,'usage',$3,$4)`,
      [input.tenantId, input.projectId ?? null, '-' + fromScaled(credits).slice(0, -4), `call:${input.callId}`],
    );
  }
  await audit(c, actorId, 'call_cost.record', 'call', input.callId, { totalUsd: fromScaled(totalUsd) });
  return getCallCost(c, input.callId);
}

export async function getCallCost(c: pg.PoolClient, callId: string) {
  const head = (await c.query(
    `SELECT * FROM call_costs WHERE call_id = $1 ORDER BY CASE status WHEN 'reconciled' THEN 0 ELSE 1 END LIMIT 1`,
    [callId],
  )).rows[0];
  if (!head) throw new AppError(404, 'No cost record for that call.');
  const lines = (await c.query('SELECT * FROM call_cost_lines WHERE call_cost_id = $1 ORDER BY id', [head.id])).rows;
  return { ...head, lines };
}

/** Roll costs up per campaign (project), so cost maps onto client billing. */
export async function campaignCosts(c: pg.PoolClient, tenantId?: string) {
  const { rows } = await c.query(
    // A call can have an estimated and a reconciled record; count each call once, preferring reconciled.
    `WITH latest AS (
       SELECT DISTINCT ON (call_id) * FROM call_costs
        ORDER BY call_id, CASE status WHEN 'reconciled' THEN 0 ELSE 1 END
     )
     SELECT pc.tenant_id, pc.project_id, p.name AS project, count(*)::int AS calls,
            sum(pc.total_usd) AS total_usd, sum(pc.total_myr) AS total_myr,
            sum(pc.credits_drawn) AS credits_drawn, sum(pc.margin_usd) AS margin_usd
       FROM latest pc LEFT JOIN projects p ON p.id = pc.project_id
      WHERE ($1::uuid IS NULL OR pc.tenant_id = $1)
      GROUP BY pc.tenant_id, pc.project_id, p.name ORDER BY p.name NULLS LAST`,
    [tenantId ?? null],
  );
  return rows;
}

/** Which part of the usage a rate prices. */
function partsOf(unit: Unit, billingLine: string): string[] {
  switch (unit) {
    case 'per_minute': case 'per_second': return ['seconds'];
    case 'per_character': case 'per_1k_characters': return ['characters'];
    case 'per_token': case 'per_1k_tokens': case 'per_1m_tokens':
      return billingLine === 'input' ? ['input tokens'] : billingLine === 'output' ? ['output tokens'] : ['input tokens', 'output tokens'];
    default: return [];
  }
}
