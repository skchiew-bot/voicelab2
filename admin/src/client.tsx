import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type Tenant } from './api';

/**
 * The tenant switcher: one client chosen in the menu bar, followed by every screen that works on one client,
 * and remembered in this browser. A remembered client that no longer exists is never treated as chosen.
 */
const KEY = 'voicelab.client';
const remembered = () => { try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; } };
const remember = (id: string) => { try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* private window: not remembered */ } };

interface ClientChoice { tenantId: string; choose: (id: string) => void; tenants: Tenant[] | null; error: unknown; reload: () => Promise<void> }
const Ctx = createContext<ClientChoice>({ tenantId: '', choose: () => {}, tenants: null, error: null, reload: async () => {} });

export function ClientProvider({ children }: { children: ReactNode }) {
  const [tenants, setTenants] = useState<Tenant[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const latest = useRef(0);
  // Only the newest answer counts; a reload can be awaited, so a client just added can be chosen once it is listed.
  const reload = useCallback(async () => {
    const mine = ++latest.current;
    try { const t = await api<Tenant[]>('GET', '/internal/tenants'); if (mine === latest.current) { setTenants(t); setError(null); } }
    catch (e) { if (mine === latest.current) setError(e); }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const [chosen, setChosen] = useState(remembered);
  // If the remembered client is gone, nothing is chosen: no screen loads a stale client.
  const tenantId = tenants?.some((t) => t.id === chosen) ? chosen : '';
  const choose = (id: string) => { setChosen(id); remember(id); };
  // Screens wait for the list, so they open once, already on the chosen client, instead of loading twice.
  const ready = tenants !== null || error !== null;
  return <Ctx.Provider value={{ tenantId, choose, tenants, error, reload }}>{ready ? children : <p className="muted">Loading…</p>}</Ctx.Provider>;
}

/** The chosen client, and a setter that changes it everywhere. */
export function useClient(): [string, (id: string) => void] {
  const c = useContext(Ctx);
  return [c.tenantId, c.choose];
}

export const useClientList = () => useContext(Ctx);

export function ClientSwitcher() {
  const { tenantId, choose, tenants, error } = useContext(Ctx);
  return (
    <label className="switcher">
      <span>Working on</span>
      <select aria-label="Working on" value={tenantId} onChange={(e) => choose(e.target.value)} disabled={!tenants}>
        <option value="">{error ? 'Could not load clients' : 'All clients'}</option>
        {tenants?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    </label>
  );
}
