const KEY = 'voicelab.token';

// sessionStorage can be unavailable (private windows, blocked storage); the app still works for the visit.
let memoryToken: string | null = null;
export const getToken = (): string | null => {
  try { return sessionStorage.getItem(KEY) ?? memoryToken; } catch { return memoryToken; }
};
export const setToken = (t: string | null): void => {
  memoryToken = t;
  try { if (t) sessionStorage.setItem(KEY, t); else sessionStorage.removeItem(KEY); } catch { /* ignore */ }
};

export class ApiError extends Error {
  constructor(public status: number, message: string, public details: string[] = []) {
    super(message);
  }
}

export async function api<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${getToken() ?? ''}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const raw = data?.details;
    const details = Array.isArray(raw)
      ? raw.map((d: unknown) => (typeof d === 'string' ? d : (d as { message?: string }).message ?? JSON.stringify(d)))
      : [];
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status}).`, details);
  }
  return data as T;
}

export interface ParamDef { key: string; label: string; type: 'string' | 'secret' | 'url' | 'number' | 'boolean'; required: boolean; help?: string }
export interface Adapter {
  key: string; kind: 'telephony' | 'voice'; displayName: string; docsUrl: string;
  params: ParamDef[]; defaultCapabilities: Record<string, string>;
}
export interface Capability { capability: string; support: 'native' | 'composable' | 'unsupported'; notes: string | null }
export interface Provider {
  id: string; adapter_key: string; kind: string; name: string; params: Record<string, unknown>;
  status: string; secrets_stored: boolean; credentials_checked_at: string | null; capabilities: Capability[];
}
export interface Component { component: string; unit: string; rate: string; currency: string; billing_line: string; direction: string }
export interface ChargingVersion {
  id: string; version: number; effective_from: string; billing_increment_seconds: number;
  minimum_charge_seconds: number; rounding: string; concurrency_limit: number | null;
  burst_premium_multiplier: string | null; notes: string | null; confirmed: boolean;
  source_url: string | null; components: Component[];
}
export interface Tenant { id: string; name: string; created_at: string }
export interface Project { id: string; name: string }
export interface CreditSummary { balance: string; recent: { id: number; kind: string; credits: string; ref: string | null; created_at: string }[] }

export interface FxRate { id: number; currency: string; per_usd: string; effective_from: string }
export interface RateCard { id: number; effective_from: string; inbound_credits_per_minute: string; outbound_credits_per_minute: string; credit_value_usd: string }
export interface PhoneNumber { id: string; provider_id: string; e164: string; tenant_id: string; project_id: string | null; country: string; label: string | null }
export interface DncRegistry { country: string; requirement: 'registry' | 'none_required'; source: string; national_entries: number }
export interface CallRow {
  id: string; tenant_id: string; provider_id: string; direction: string; status: string; country: string | null;
  started_at: string; ended_at: string | null; duration_seconds: string | null; end_reason: string | null; cost_status: string; cost_error?: string | null;
}
export interface CostLine { component: string; billing_line: string; unit: string; quantity: string; billed_seconds: number | null; rate: string; currency: string; amount: string; amount_usd: string }
export interface CallCost { status: string; total_usd: string; total_myr: string; credits_drawn: string; margin_usd: string; lines: CostLine[] }
export interface Reconciliation { id: number; source: string; outcome: string; our_cost_usd: string; reported_cost_usd: string | null; detail: string; created_at: string }
export interface CampaignCost { project_id: string | null; project: string | null; calls: number; total_usd: string; total_myr: string; credits_drawn: string; margin_usd: string }
export interface CallEvent { id: number; type: string; occurred_at: string }
export interface ReferenceRate { adapterKey: string; summary: string }

export interface Alert { severity: 'high' | 'medium' | 'low'; code: string; message: string; link?: string }
export interface ProviderHealth {
  id: string; name: string; adapter: string; kind: string; status: string; credentialsCheckedAt: string | null;
  ratesInForce: boolean; ratesConfirmed: boolean; calls24h: { total: number; completed: number; unanswered: number; failed: number }; lastCall: string | null;
}
export interface MoneyWindow { calls: number; cost_usd: string; cost_myr: string; credits_drawn: string; margin_usd: string }
export interface Tower {
  generatedAt: string; alerts: Alert[]; blocked24h: number; providers: ProviderHealth[];
  activeCalls: { id: string; direction: string; status: string; started_at: string; provider_id: string }[];
  funding: { provider_id: string; provider: string; currency: string; balance: string; entries: number }[];
  money: { last24h: MoneyWindow; last7d: MoneyWindow };
}
export interface PhaseProgress {
  id: string; name: string; status: 'done' | 'in_progress' | 'not_started'; summary: string; open: string[];
  criteria: { text: string; state: 'met' | 'partly' | 'not_met'; proof: 'tests' | 'fakes' | 'live' | 'none'; note?: string }[];
}
export interface Progress { generatedAt: string; phases: PhaseProgress[]; decisions: string[] }
