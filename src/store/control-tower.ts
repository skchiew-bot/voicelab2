import type pg from 'pg';
import { decryptSecrets } from '../secrets.js';

export type Severity = 'high' | 'medium' | 'low';
export interface Alert { severity: Severity; code: string; message: string; link?: string }

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
const FAILING_MIN_CALLS = 5;     // too few calls say nothing about a provider
const FAILING_RATIO = 0.5;

interface ProviderRow {
  id: string; name: string; adapter_key: string; kind: string; status: string; params: Record<string, unknown>;
  secret_params: Buffer; credentials_checked_at: Date | null; version_id: string | null; confirmed: boolean;
  has_numbers: boolean; total: number; failed: number; unanswered: number; completed: number; last_call: Date | null;
}

/** Everything the Control Tower shows, in one read. Alerts are derived from this state, not stored. */
export async function controlTower(c: pg.PoolClient, key: Buffer, ctx: { publicBaseUrlSet: boolean }) {
  const providers: ProviderRow[] = (await c.query(
    `SELECT p.id, p.name, p.adapter_key, p.kind, p.status, p.params, p.secret_params, p.credentials_checked_at,
            v.id AS version_id, (cc.charging_version_id IS NOT NULL) AS confirmed,
            EXISTS (SELECT 1 FROM phone_numbers n WHERE n.provider_id = p.id) AS has_numbers,
            coalesce(k.total, 0)::int AS total, coalesce(k.failed, 0)::int AS failed,
            coalesce(k.unanswered, 0)::int AS unanswered, coalesce(k.completed, 0)::int AS completed, k.last_call
       FROM providers p
       LEFT JOIN LATERAL (SELECT id FROM charging_versions WHERE provider_id = p.id AND effective_from <= now()
                           ORDER BY effective_from DESC LIMIT 1) v ON true
       LEFT JOIN charging_confirmations cc ON cc.charging_version_id = v.id
       LEFT JOIN LATERAL (SELECT count(*) AS total,
                                 count(*) FILTER (WHERE status = 'failed') AS failed,
                                 count(*) FILTER (WHERE status = 'unanswered') AS unanswered,
                                 count(*) FILTER (WHERE status = 'completed') AS completed,
                                 max(started_at) AS last_call
                            -- Finished calls only: calls still in flight (or stuck) say nothing about success or failure.
                            FROM calls WHERE provider_id = p.id AND status IN ('completed', 'unanswered', 'failed')
                             AND started_at > now() - interval '24 hours') k ON true
      ORDER BY p.name`)).rows;

  const activeCalls = (await c.query(
    `SELECT id, direction, status, started_at, provider_id, tenant_id FROM calls
      WHERE status IN ('dialing', 'ringing', 'in_progress') ORDER BY started_at DESC LIMIT 20`)).rows;
  const activeTotal = (await c.query(`SELECT count(*)::int AS n FROM calls WHERE status IN ('dialing', 'ringing', 'in_progress')`)).rows[0].n as number;
  const stuck = (await c.query(
    // Dialling or ringing for a quarter of an hour, or on a call for six hours, means events are not arriving.
    `SELECT count(*)::int AS n FROM calls
      WHERE (status IN ('dialing', 'ringing') AND started_at < now() - interval '15 minutes')
         OR (status = 'in_progress' AND started_at < now() - interval '6 hours')`)).rows[0].n as number;
  const unpriced = (await c.query(
    `SELECT count(*)::int AS n FROM calls WHERE ended_at IS NOT NULL AND cost_status = 'pending' AND ended_at < now() - interval '15 minutes'`)).rows[0].n as number;
  const blocked24h = (await c.query(`SELECT count(*)::int AS n FROM calls WHERE status = 'blocked' AND started_at > now() - interval '24 hours'`)).rows[0].n as number;

  const funding = (await c.query(
    `SELECT f.provider_id, p.name AS provider, p.status, f.currency, sum(f.amount) AS balance, count(*)::int AS entries
       FROM provider_funding_entries f JOIN providers p ON p.id = f.provider_id
      GROUP BY f.provider_id, p.name, p.status, f.currency ORDER BY p.name, f.currency`)).rows;

  const money = async (interval: string) => (await c.query(
    // Each call counts once, preferring its reconciled record. A reconciled record copies its estimate's
    // occurred_at, so filtering by time first keeps the pair together and lets the index do the work.
    `WITH latest AS (SELECT DISTINCT ON (call_id) * FROM call_costs WHERE occurred_at > now() - $1::interval
                      ORDER BY call_id, CASE status WHEN 'reconciled' THEN 0 ELSE 1 END)
     SELECT count(*)::int AS calls, coalesce(sum(total_usd), 0) AS cost_usd, coalesce(sum(total_myr), 0) AS cost_myr,
            coalesce(sum(credits_drawn), 0) AS credits_drawn, coalesce(sum(margin_usd), 0) AS margin_usd
       FROM latest`, [interval])).rows[0];
  const [last24h, last7d] = [await money('24 hours'), await money('7 days')];

  const problems = (await c.query(
    `SELECT count(*) FILTER (WHERE cost_status = 'failed')::int AS failed, count(*) FILTER (WHERE cost_status = 'variance')::int AS variance FROM calls`)).rows[0];
  const hasMyr = (await c.query(`SELECT 1 FROM fx_rates WHERE currency = 'MYR' AND effective_from <= now() LIMIT 1`)).rowCount === 1;
  const hasRateCard = (await c.query(`SELECT 1 FROM rate_cards WHERE effective_from <= now() LIMIT 1`)).rowCount === 1;
  const registries = (await c.query('SELECT count(*)::int AS n FROM dnc_registries')).rows[0].n as number;

  // ---- derived alerts
  const alerts: Alert[] = [];
  const add = (severity: Severity, code: string, message: string, link?: string) => alerts.push({ severity, code, message, link });
  const telephony = providers.filter((p) => p.kind === 'telephony' && p.status === 'active');

  if (!hasMyr) add('high', 'no_fx_myr', 'No MYR exchange rate is in force, so calls cannot be costed.', '#/rates');
  if (!hasRateCard) add('medium', 'no_rate_card', 'There is no client rate card, so every call draws zero credits.', '#/rates');
  if (telephony.length > 0 && !ctx.publicBaseUrlSet) add('high', 'no_public_url', 'PUBLIC_BASE_URL is not set, so telephony providers cannot reach this server for calls.');
  if (telephony.length > 0 && registries === 0) add('medium', 'no_dnc', 'No do-not-call position is declared for any country, so outbound calls are blocked everywhere.', '#/compliance');
  if (stuck > 0) add('high', 'calls_stuck', `${stuck} call${stuck === 1 ? '' : 's'} ${stuck === 1 ? 'has' : 'have'} not moved for a long time. Provider events are probably not arriving: check the public address and the webhook settings.`, '#/calls');
  if (unpriced > 0) add('medium', 'cost_pending', `${unpriced} finished call${unpriced === 1 ? ' has' : 's have'} not been priced.`, '#/calls');
  if (problems.failed > 0) add('high', 'cost_failed', `${problems.failed} call${problems.failed === 1 ? '' : 's'} could not be priced.`, '#/calls');
  if (problems.variance > 0) add('medium', 'cost_variance', `${problems.variance} call${problems.variance === 1 ? '' : 's'} differ${problems.variance === 1 ? 's' : ''} from the provider's own figures.`, '#/calls');

  const providerViews = providers.map((p) => {
    const link = `#/providers/${p.id}`;
    if (p.status === 'active') {
      if (!p.credentials_checked_at) add('medium', 'credentials_unchecked', `${p.name}: credentials have not been checked with the provider.`, link);
      if (!p.version_id && (p.has_numbers || p.total > 0)) add('high', 'no_rates', `${p.name} has no rates in force, so its calls cannot be priced.`, link);
      else if (p.version_id && !p.confirmed) add('medium', 'rates_unconfirmed', `${p.name}: the rates in force have not been confirmed against the provider's pricing page.`, link);
      if (p.kind === 'telephony') {
        // One unreadable blob (a changed key, corruption) must not take the whole Control Tower down.
        let secrets: Record<string, string> | null = null;
        try { secrets = decryptSecrets(p.secret_params, key, p.id); }
        catch { add('high', 'secrets_unreadable', `${p.name}: its saved credentials cannot be read. Was VOICELAB_SECRET_KEY changed?`, link); }
        const verifiable = secrets === null ? true // already reported above
          : p.adapter_key === 'twilio' ? Boolean(secrets.authToken) : p.adapter_key === 'telnyx' ? Boolean(p.params.webhookPublicKey) : true;
        if (!verifiable) add('high', 'webhook_unverifiable', `${p.name}: ${p.adapter_key === 'twilio' ? 'no Auth Token is saved' : 'no webhook signing public key is saved'}, so its call events are refused.`, link);
        if (p.total >= FAILING_MIN_CALLS && p.failed / p.total >= FAILING_RATIO) {
          add('high', 'provider_failing', `${p.name}: ${p.failed} of ${p.total} calls failed in the last 24 hours.`, link);
        }
      }
    }
    return {
      id: p.id, name: p.name, adapter: p.adapter_key, kind: p.kind, status: p.status, credentialsCheckedAt: p.credentials_checked_at,
      ratesInForce: p.version_id !== null, ratesConfirmed: p.confirmed,
      calls24h: { total: p.total, completed: p.completed, unanswered: p.unanswered, failed: p.failed }, lastCall: p.last_call,
    };
  });

  for (const f of funding) {
    // Funding is recorded by hand today (calls do not deduct from it), so this flags a recorded balance that has run out.
    // A disabled provider is no longer in use, so an empty balance there is not news.
    if (f.status === 'active' && Number(f.balance) <= 0) add('high', 'funding_empty', `${f.provider}: the recorded funding balance is ${Number(f.balance)} ${f.currency}.`, `#/providers/${f.provider_id}`);
  }

  alerts.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  return {
    generatedAt: new Date().toISOString(), alerts, activeCalls, activeTotal, blocked24h, providers: providerViews, funding,
    money: { last24h, last7d }, setup: { publicBaseUrlSet: ctx.publicBaseUrlSet },
  };
}
