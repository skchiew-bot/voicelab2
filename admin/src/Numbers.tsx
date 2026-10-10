import { useState } from 'react';
import { useClient } from './client';
import { api, type PoolNumber, type Provider, type Tenant } from './api';
import { Errors, Field, useAction, useLoad } from './ui';

export function Numbers() {
  const [client] = useClient();
  const numbers = useLoad(() => api<PoolNumber[]>('GET', '/internal/dids'));
  const providers = useLoad(() => api<Provider[]>('GET', '/internal/providers'));
  const tenants = useLoad(() => api<Tenant[]>('GET', '/internal/tenants'));
  const [providerId, setProviderId] = useState('');
  const [e164, setE164] = useState('');
  const [tenantId, setTenantId] = useState(client);
  const [country, setCountry] = useState('MY');
  const [label, setLabel] = useState('');
  const { pending, error, run } = useAction();
  const telephony = providers.data?.filter((p) => p.kind === 'telephony') ?? [];
  const pname = (id: string) => providers.data?.find((p) => p.id === id)?.name ?? id.slice(0, 8);
  const tname = (id: string) => tenants.data?.find((t) => t.id === id)?.name ?? id.slice(0, 8);

  return (
    <>
      <h1>Numbers</h1>
      <p className="muted">Numbers we own at a provider: the pool outbound calls are dialled from. An inbound call goes to the client that owns the number dialled. For an outbound call the pool picks the caller ID: never one that has failed for that contact before, then the cheapest provider's, then the one used least recently. Customers' numbers are never stored.</p>
      <Errors error={numbers.error ?? providers.error ?? tenants.error} />
      {numbers.data && (numbers.data.length === 0 ? <p className="muted">No numbers yet.</p> : (
        <table>
          <thead><tr><th>Number</th><th>Provider</th><th>Client</th><th>Country</th><th>Label</th><th>Used</th><th>Last used</th><th>Failures</th><th>Contacts locked out</th></tr></thead>
          <tbody>{numbers.data.map((n) => <tr key={n.id}><td>{n.e164}</td><td>{pname(n.provider_id)}</td><td>{tname(n.tenant_id)}</td><td>{n.country}</td><td>{n.label}</td><td>{n.use_count}</td><td>{n.last_used_at ? new Date(n.last_used_at).toLocaleString() : '—'}</td><td>{n.failures}</td><td>{n.contacts_locked}</td></tr>)}</tbody>
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
