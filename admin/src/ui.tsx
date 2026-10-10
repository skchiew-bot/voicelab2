import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from './api';

export function Errors({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error instanceof ApiError ? error : new ApiError(0, error instanceof Error ? error.message : String(error));
  return (
    <div className="errors" role="alert">
      <strong>{e.message}</strong>
      {e.details.length > 0 && <ul>{e.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
    </div>
  );
}

export function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      {children}
      {help && <span className="help">{help}</span>}
    </label>
  );
}

/** Load data on mount and whenever `reload` is called. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const latest = useRef(0);
  const reload = useCallback(() => {
    // Only the newest request may update the screen, so a slow older answer cannot overwrite a newer one.
    const mine = ++latest.current;
    load().then((d) => { if (mine === latest.current) { setData(d); setError(null); } }, (e) => { if (mine === latest.current) setError(e); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(reload, [reload]);
  return { data, error, reload };
}

/** Run an action with pending and error state, for form submits. */
export function useAction() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setPending(true); setError(null);
    try { return await fn(); } catch (e) { setError(e); return undefined; } finally { setPending(false); }
  }
  return { pending, error, run };
}

export { fmtDecimal } from './format';

export const fmtDate = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
