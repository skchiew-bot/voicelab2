import { ApiError } from '../../admin/src/api';

// The portal keeps its own sign-in, apart from the staff console's, so the two never mix in one browser.
const KEY = 'voicelab.portal.token';
let memoryToken: string | null = null;
export const getToken = (): string | null => { try { return sessionStorage.getItem(KEY) ?? memoryToken; } catch { return memoryToken; } };
export const setToken = (t: string | null): void => {
  memoryToken = t;
  try { if (t) sessionStorage.setItem(KEY, t); else sessionStorage.removeItem(KEY); } catch { /* storage blocked: kept for this visit */ }
};

export async function api<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { authorization: `Bearer ${getToken() ?? ''}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  // A token that stopped working (the user was disabled) signs the portal out, rather than leaving every screen failing.
  if (res.status === 401 && getToken()) { setToken(null); window.dispatchEvent(new Event('portal:signed-out')); }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status}).`);
  return data as T;
}

export interface Me { email: string; role: 'tenant_admin' | 'tenant_user'; client: string }
export interface CallRow { id: string; project: string | null; direction: string; status: string; started_at: string; answered_at: string | null; duration_seconds: string | null; outcome: string | null; credits_drawn: string }
export interface Summary { balance: string; last30Days: { project_id: string | null; project: string | null; calls: number; answered: number; credits_drawn: string }[] }
export interface UserRow { id: string; email: string; role: string; created_at: string; disabled_at: string | null }
