import { useState } from 'react';
import { api, type Adapter, type ParamDef, type Provider } from './api';
import { Errors, Field, useAction, useLoad } from './ui';

function ParamInput({ def, value, onChange }: { def: ParamDef; value: string | boolean; onChange: (v: string | boolean) => void }) {
  const common = { id: `p-${def.key}`, required: def.required };
  const input =
    def.type === 'boolean' ? (
      <input type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
    ) : (
      <input
        {...common}
        type={def.type === 'secret' ? 'password' : def.type === 'url' ? 'url' : def.type === 'number' ? 'number' : 'text'}
        autoComplete="off"
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  return <Field label={def.label + (def.required ? '' : ' (optional)')} help={def.help}>{input}</Field>;
}

export function AddProvider({ adapters, onAdded }: { adapters: Adapter[]; onAdded: (p: Provider) => void }) {
  const [adapterKey, setAdapterKey] = useState('');
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string | boolean>>({});
  const { pending, error, run } = useAction();
  const adapter = adapters.find((a) => a.key === adapterKey);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!adapter) return;
    const params: Record<string, string | number | boolean> = {};
    for (const def of adapter.params) {
      const v = values[def.key];
      if (v === undefined || v === '' || v === false) continue;
      params[def.key] = def.type === 'number' ? Number(v) : v;
    }
    const created = await run(() => api<Provider>('POST', '/internal/providers', { adapterKey, name, params }));
    if (created) { setName(''); setValues({}); setAdapterKey(''); onAdded(created); }
  }

  return (
    <form className="card" onSubmit={submit} aria-label="Add provider">
      <h2>Add a provider</h2>
      <Field label="Provider type">
        <select value={adapterKey} onChange={(e) => { setAdapterKey(e.target.value); setValues({}); }} required>
          <option value="">Choose…</option>
          {adapters.map((a) => <option key={a.key} value={a.key}>{a.displayName}</option>)}
        </select>
      </Field>
      {adapter && (
        <>
          <p className="muted">Settings for {adapter.displayName}. <a href={adapter.docsUrl} target="_blank" rel="noreferrer">Provider docs</a></p>
          <Field label="Name" help="A label for this account, e.g. “Twilio – main”.">
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
          {adapter.params.map((def) => (
            <ParamInput key={def.key} def={def} value={values[def.key] ?? (def.type === 'boolean' ? false : '')}
              onChange={(v) => setValues((s) => ({ ...s, [def.key]: v }))} />
          ))}
          <p className="muted">Secrets are encrypted when saved and are not shown again.</p>
        </>
      )}
      <Errors error={error} />
      <button type="submit" disabled={pending || !adapter}>Add provider</button>
    </form>
  );
}

export function Providers() {
  const providers = useLoad(() => api<Provider[]>('GET', '/internal/providers'));
  const adapters = useLoad(() => api<Adapter[]>('GET', '/internal/adapters'));

  return (
    <>
      <h1>Providers</h1>
      <Errors error={providers.error ?? adapters.error} />
      {providers.data && (
        providers.data.length === 0 ? (
          <p className="muted">No providers yet. Add the first one below.</p>
        ) : (
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Kind</th><th>Status</th></tr></thead>
            <tbody>
              {providers.data.map((p) => (
                <tr key={p.id}>
                  <td><a href={`#/providers/${p.id}`}>{p.name}</a></td>
                  <td>{adapters.data?.find((a) => a.key === p.adapter_key)?.displayName ?? p.adapter_key}</td>
                  <td>{p.kind}</td>
                  <td>{p.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
      {adapters.data && <AddProvider adapters={adapters.data} onAdded={(p) => { providers.reload(); location.hash = `#/providers/${p.id}`; }} />}
    </>
  );
}
