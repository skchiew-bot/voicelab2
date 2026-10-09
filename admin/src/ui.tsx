import { useCallback, useEffect, useState, type ReactNode } from 'react';
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
  const reload = useCallback(() => {
    load().then((d) => { setData(d); setError(null); }, setError);
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

export const fmtDate = (iso: string) => new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
