import { useState } from 'react';
import { api, type PhoneNumber, type Provider, type Tenant } from './api';
import { Errors, Field, useAction, useLoad } from './ui';

export function Numbers() {
  const numbers = useLoad(() => api<PhoneNumber[]>('GET', '/internal/numbers'));
  const providers = useLoad(() => api<Provider[]>('GET', '/internal/providers'));
  const tenants = useLoad(() => api<Tenant[]>('GET', '/internal/tenants'));
  const [providerId, setProviderId] = useState('');
  const [e164, setE164] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [country, setCountry] = useState('MY');
  const [label, setLabel] = useState('');
  const { pending, error, run } = useAction();
  const telephony = providers.data?.filter((p) => p.kind === 'telephony') ?? [];
  const pname = (id: string) => providers.data?.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const tname = (id: string) => tenants.data?.find((t) => t.id === id)?.name ?? id.slice(0, 8);

  return (
    <>
      <h1>Numbers</h1>
      <p className="muted">Numbers we own at a provider. An inbound call goes to the client that owns the number dialled, and an outbound call must use one of the client's own numbers as caller ID. Customers' numbers are never stored.</p>
      <Errors error={numbers.error ?? providers.error ?? tenants.error} />
      {numbers.data && (numbers.data.length === 0 ? <p className="muted">No numbers yet.</p> : (
        <table>
          <thead><tr><th>Number</th><th>Provider</th><th>Client</th><th>Country</th><th>Label</th></tr></thead>
          <tbody>{numbers.data.map((n) => <tr key={n.id}><td>{n.e164}</td><td>{pname(n.provider_id)}</td><td>{tname(n.tenant_id)}</td><td>{n.country}</td><td>{n.label}</td></tr>)}</tbody>
        </table>
      ))}
      <form className="card" aria-label="Add number" onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => api('POST', '/internal/numbers', { providerId, e164, tenantId, country, label: label || undefined }))) { setE164(''); setLabel(''); numbers.reload(); }
      }}>
        <h2>Register a number</h2>
        <div className="grid">
          <Field label="Provider">
            <select value={providerId} onChange={(e) => setProviderId(e.target.value)} required>
              <option value="">Choose…</option>{telephony.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
          <Field label="Number" help="International format, e.g. +60312345678."><input value={e164} onChange={(e) => setE164(e.target.value)} required /></Field>
          <Field label="Client">
            <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} required>
              <option value="">Choose…</option>{tenants.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Country (2 letters)"><input maxLength={2} value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} required /></Field>
          <Field label="Label (optional)"><input value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
        </div>
        <Errors error={error} />
        <div><button type="submit" disabled={pending}>Register number</button></div>
      </form>
    </>
  );
}
