import { createContext, useContext, useState, type ReactNode } from 'react';
import { api, type Tenant } from './api';
import { useLoad } from './ui';

/**
 * The tenant switcher: one client chosen in the menu bar, followed by every screen that works on one client,
 * and remembered in this browser. A remembered client that no longer exists is never treated as chosen.
 */
const KEY = 'voicelab.client';
const remembered = () => { try { return localStorage.getItem(KEY) ?? ''; } catch { return ''; } };
const remember = (id: string) => { try { if (id) localStorage.setItem(KEY, id); else localStorage.removeItem(KEY); } catch { /* private window: not remembered */ } };

interface ClientChoice { tenantId: string; choose: (id: string) => void; tenants: Tenant[] | null; error: unknown; reload: () => void }
const Ctx = createContext<ClientChoice>({ tenantId: '', choose: () => {}, tenants: null, error: null, reload: () => {} });

export function ClientProvider({ children }: { children: ReactNode }) {
  const list = useLoad(() => api<Tenant[]>('GET', '/internal/tenants'));
  const [chosen, setChosen] = useState(remembered);
  // Until the list arrives, and if the remembered client is gone, nothing is chosen: no screen loads a stale client.
  const tenantId = list.data?.some((t) => t.id === chosen) ? chosen : '';
  const choose = (id: string) => { setChosen(id); remember(id); };
  return <Ctx.Provider value={{ tenantId, choose, tenants: list.data, error: list.error, reload: list.reload }}>{children}</Ctx.Provider>;
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
