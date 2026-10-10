import { useState } from 'react';
import { api, type DncRegistry, type Tenant } from './api';
import { Errors, Field, useAction, useLoad } from './ui';

export function Compliance() {
  const regs = useLoad(() => api<DncRegistry[]>('GET', '/internal/dnc/registries'));
  const tenants = useLoad(() => api<Tenant[]>('GET', '/internal/tenants'));

  const [country, setCountry] = useState('');
  const [requirement, setRequirement] = useState('registry');
  const [source, setSource] = useState('');
  const declare = useAction();

  const [lCountry, setLCountry] = useState('');
  const [lTenant, setLTenant] = useState('');
  const [lNumbers, setLNumbers] = useState('');
  const [lSource, setLSource] = useState('');
  const [loaded, setLoaded] = useState<{ added: number; duplicates: number; invalid: string[] } | null>(null);
  const load = useAction();

  const [cTenant, setCTenant] = useState('');
  const [cCountry, setCCountry] = useState('');
  const [cNumber, setCNumber] = useState('');
  const [decision, setDecision] = useState<{ allowed: boolean; reason?: string } | null>(null);
  const check = useAction();

  return (
    <>
      <h1>Do not call</h1>
      <p className="muted">No call is placed to a country until its position is declared here, and no call is placed to a number on a list. Numbers are stored as keyed hashes, never in clear.</p>
      <Errors error={regs.error ?? tenants.error} />

      <section className="card">
        <h2>Countries</h2>
        {regs.data && (regs.data.length === 0 ? <div className="notice" role="status">No country declared: outbound calls are blocked everywhere.</div> : (
          <table>
            <thead><tr><th>Country</th><th>Position</th><th>Source</th><th>Registry numbers</th></tr></thead>
            <tbody>{regs.data.map((r) => (
              <tr key={r.country}><td>{r.country}</td><td>{r.requirement === 'registry' ? 'Registry in force' : 'No registry required'}</td><td>{r.source}</td><td>{r.national_entries}</td></tr>
            ))}</tbody>
          </table>
        ))}
        <form className="grid" aria-label="Declare country" onSubmit={async (e) => {
          e.preventDefault();
          if (await declare.run(() => api('POST', '/internal/dnc/registries', { country, requirement, source }))) { setCountry(''); setSource(''); regs.reload(); }
        }}>
          <Field label="Country (2 letters)"><input maxLength={2} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} required /></Field>
          <Field label="Position">
            <select value={requirement} onChange={(e) => setRequirement(e.target.value)}>
              <option value="registry">A registry is in force</option><option value="none_required">No registry required (I confirm)</option>
            </select>
          </Field>
          <Field label="Source or note" help="Where the registry comes from, or why none is required."><input value={source} onChange={(e) => setSource(e.target.value)} required /></Field>
          <div><button type="submit" disabled={declare.pending}>Declare</button></div>
        </form>
        <Errors error={declare.error} />
      </section>

      <section className="card">
        <h2>Load numbers</h2>
        <form className="card-inner" aria-label="Load numbers" onSubmit={async (e) => {
          e.preventDefault();
          const r = await load.run(() => api<{ added: number; duplicates: number; invalid: string[] }>('POST', '/internal/dnc/numbers', {
            country: lCountry, tenantId: lTenant || undefined, source: lSource || undefined,
            numbers: lNumbers.split(/[\n,]+/).map((n) => n.trim()).filter(Boolean),
          }));
          if (r) { setLoaded(r); setLNumbers(''); regs.reload(); }
        }}>
          <div className="grid">
            <Field label="Country (2 letters)"><input maxLength={2} value={lCountry} onChange={(e) => setLCountry(e.target.value.toUpperCase())} required /></Field>
            <Field label="List" help="Leave as the national registry, or choose a client's own opt-out list.">
              <select value={lTenant} onChange={(e) => setLTenant(e.target.value)}>
                <option value="">National registry</option>{tenants.data?.map((t) => <option key={t.id} value={t.id}>{t.name}'s opt-outs</option>)}
              </select>
            </Field>
            <Field label="Source (optional)"><input value={lSource} onChange={(e) => setLSource(e.target.value)} /></Field>
          </div>
          <Field label="Numbers" help="One per line, in international format, e.g. +60123456789.">
            <textarea rows={5} value={lNumbers} onChange={(e) => setLNumbers(e.target.value)} required />
          </Field>
          <Errors error={load.error} />
          <div><button type="submit" disabled={load.pending}>Load numbers</button></div>
        </form>
        {loaded && (
          <div className="notice" role="status">
            Added {loaded.added}; already listed {loaded.duplicates}; not valid {loaded.invalid.length}.
            {loaded.invalid.length > 0 && <> Not valid: {loaded.invalid.join(', ')}</>}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Check a number</h2>
        <p className="muted">A dry run of the gate every real call goes through. Nothing is recorded.</p>
        <form className="grid" aria-label="Check number" onSubmit={async (e) => {
          e.preventDefault();
          const d = await check.run(() => api<{ allowed: boolean; reason?: string }>('POST', '/internal/dial/check', { tenantId: cTenant, country: cCountry, to: cNumber }));
          if (d) setDecision(d);
        }}>
          <Field label="Client">
            <select value={cTenant} onChange={(e) => setCTenant(e.target.value)} required>
              <option value="">Choose…</option>{tenants.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Country (2 letters)"><input maxLength={2} value={cCountry} onChange={(e) => setCCountry(e.target.value.toUpperCase())} required /></Field>
          <Field label="Number"><input value={cNumber} onChange={(e) => setCNumber(e.target.value)} required /></Field>
          <div><button type="submit" className="secondary" disabled={check.pending}>Check</button></div>
        </form>
        <Errors error={check.error} />
        {decision && (decision.allowed
          ? <div className="notice ok" role="status">Allowed: this number can be called.</div>
          : <div className="errors" role="alert">Blocked: {REASONS[decision.reason ?? ''] ?? decision.reason}</div>)}
      </section>
    </>
  );
}

const REASONS: Record<string, string> = {
  invalid_number: 'not a valid international number.',
  no_registry_declared: 'no do-not-call position has been declared for this country.',
  on_national_registry: 'the number is on the national registry.',
  on_client_list: "the number is on this client's opt-out list.",
};
