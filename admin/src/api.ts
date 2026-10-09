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
  status: string; secrets_stored: boolean; capabilities: Capability[];
}
export interface Component { component: string; unit: string; rate: string; currency: string; billing_line: string }
export interface ChargingVersion {
  id: string; version: number; effective_from: string; billing_increment_seconds: number;
  minimum_charge_seconds: number; rounding: string; concurrency_limit: number | null;
  burst_premium_multiplier: string | null; notes: string | null; confirmed: boolean;
  source_url: string | null; components: Component[];
}
export interface Tenant { id: string; name: string; created_at: string }
export interface Project { id: string; name: string }
export interface CreditSummary { balance: string; recent: { id: number; kind: string; credits: string; ref: string | null; created_at: string }[] }
