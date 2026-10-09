import { useState } from 'react';
import { api, type ChargingVersion, type Provider } from './api';
import { Errors, Field, fmtDate, useAction, useLoad } from './ui';

const COMPONENTS = ['telephony_leg', 'stt', 'llm', 'tts', 'platform', 'concurrency', 'other'];
const UNITS = ['per_minute', 'per_second', 'per_character', 'per_1k_characters', 'per_token', 'per_1k_tokens', 'per_1m_tokens', 'per_credit', 'flat'];

interface Row { component: string; unit: string; rate: string; currency: string; billingLine: string; direction: string }
const blankRow = (): Row => ({ component: 'telephony_leg', unit: 'per_minute', rate: '', currency: 'USD', billingLine: 'main', direction: 'any' });

function CredentialCheck({ provider, onChecked }: { provider: Provider; onChecked: () => void }) {
  const [result, setResult] = useState<{ ok: boolean; reason?: string; info?: Record<string, string> } | null>(null);
  const { pending, error, run } = useAction();
  return (
    <div className="creds">
      <p>
        <span className={provider.credentials_checked_at ? 'badge ok' : 'badge warn'}>
          {provider.credentials_checked_at ? 'Credentials checked' : 'Credentials not checked'}
        </span>{' '}
        {provider.credentials_checked_at && <span className="muted">{fmtDate(provider.credentials_checked_at)}</span>}{' '}
        <button className="secondary" disabled={pending} onClick={async () => {
          const r = await run(() => api<{ ok: boolean; reason?: string; info?: Record<string, string> }>('POST', `/internal/providers/${provider.id}/check`));
          if (r) { setResult(r); onChecked(); }
        }}>Check credentials now</button>
      </p>
      <Errors error={error} />
      {result && (result.ok
        ? <div className="notice ok" role="status">Credentials accepted by the provider.{result.info && Object.keys(result.info).length > 0 && ` ${Object.entries(result.info).map(([k, v]) => `${k}: ${v}`).join(', ')}`}</div>
        : <div className="errors" role="alert">{result.reason}</div>)}
    </div>
  );
}

function CredentialCheck({ provider, onChecked }: { provider: Provider; onChecked: () => void }) {
  const [result, setResult] = useState<{ ok: boolean; reason?: string; info?: Record<string, string> } | null>(null);
  const { pending, error, run } = useAction();
  return (
    <div className="creds">
      <p>
        <span className={provider.credentials_checked_at ? 'badge ok' : 'badge warn'}>
          {provider.credentials_checked_at ? 'Credentials checked' : 'Credentials not checked'}
        </span>{' '}
        {provider.credentials_checked_at && <span className="muted">{fmtDate(provider.credentials_checked_at)}</span>}{' '}
        <button className="secondary" disabled={pending} onClick={async () => {
          const r = await run(() => api<{ ok: boolean; reason?: string; info?: Record<string, string> }>('POST', `/internal/providers/${provider.id}/check`));
          if (r) { setResult(r); onChecked(); }
        }}>Check credentials now</button>
      </p>
      <Errors error={error} />
      {result && (result.ok
        ? <div className="notice ok" role="status">Credentials accepted by the provider.{result.info && Object.keys(result.info).length > 0 && ` ${Object.entries(result.info).map(([k, v]) => `${k}: ${v}`).join(', ')}`}</div>
        : <div className="errors" role="alert">{result.reason}</div>)}
    </div>
  );
}

function Capabilities({ provider, onChanged }: { provider: Provider; onChanged: () => void }) {
  const { error, run } = useAction();
  return (
    <section className="card">
      <h2>Capabilities</h2>
      <p className="muted">
        Native passes through to the provider. Composable is built from its primitives. Unsupported routes to a provider that has it.
        These are starting values: check them against the provider’s docs.
      </p>
      <Errors error={error} />
      <table>
        <tbody>
          {provider.capabilities.map((c) => (
            <tr key={c.capability}>
              <td>{c.capability.replace(/_/g, ' ')}</td>
              <td>
                <select aria-label={`${c.capability} support`} value={c.support}
                  onChange={(e) => run(async () => {
                    await api('PUT', `/internal/providers/${provider.id}/capabilities/${c.capability}`, { support: e.target.value });
                    onChanged();
                  })}>
                  <option value="native">native</option>
                  <option value="composable">composable</option>
                  <option value="unsupported">unsupported</option>
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function ReferenceRates({ provider, onAdded }: { provider: Provider; onAdded: () => void }) {
  const refs = useLoad(() => api<{ adapterKey: string; summary: string }[]>('GET', '/internal/reference-rates'));
  const [from, setFrom] = useState('');
  const [increment, setIncrement] = useState('');
  const { pending, error, run } = useAction();
  const ref = refs.data?.find((r) => r.adapterKey === provider.adapter_key);
  if (!ref) return null;
  return (
    <form className="card" aria-label="Use reference rates" onSubmit={async (e) => {
      e.preventDefault();
      if (await run(() => api('POST', `/internal/providers/${provider.id}/charging/reference`, { effectiveFrom: new Date(from).toISOString(), billingIncrementSeconds: Number(increment) }))) { setFrom(''); setIncrement(''); onAdded(); }
    }}>
      <h2>Start from reference rates</h2>
      <p className="muted">{ref.summary} These come from the blueprint's research, are approximate, and are saved as <strong>unconfirmed</strong>: check them against the provider's pricing page. You choose the billing increment, because the research gives none.</p>
      <div className="grid">
        <Field label="Billing increment (seconds)" help="e.g. 1, 6, 30 or 60."><input type="number" min="1" value={increment} onChange={(e) => setIncrement(e.target.value)} required /></Field>
        <Field label="Effective from (your local time)"><input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} required /></Field>
      </div>
      <Errors error={error} />
      <div><button type="submit" className="secondary" disabled={pending}>Add reference rates</button></div>
    </form>
  );
}

function AddVersion({ providerId, onAdded }: { providerId: string; onAdded: () => void }) {
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [increment, setIncrement] = useState('6');
  const [minimum, setMinimum] = useState('0');
  const [rounding, setRounding] = useState('up');
  const [concurrency, setConcurrency] = useState('');
  const [burst, setBurst] = useState('');
  const [notes, setNotes] = useState('');
  const [rows, setRows] = useState<Row[]>([blankRow()]);
  const { pending, error, run } = useAction();

  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run(() => api('POST', `/internal/providers/${providerId}/charging`, {
      effectiveFrom: new Date(effectiveFrom).toISOString(),
      billingIncrementSeconds: Number(increment),
      minimumChargeSeconds: Number(minimum),
      rounding,
      concurrencyLimit: concurrency ? Number(concurrency) : null,
      burstPremiumMultiplier: burst ? Number(burst) : null,
      notes: notes || undefined,
      components: rows,
    }));
    if (ok) { setRows([blankRow()]); setEffectiveFrom(''); setNotes(''); onAdded(); }
  }

  return (
    <form className="card" onSubmit={submit} aria-label="Add charging version">
      <h2>Add a charging version</h2>
      <p className="muted">A rate change adds a new version. Earlier versions are never edited, so past calls keep the rate they were billed at.</p>
      <div className="grid">
        <Field label="Effective from (your local time)"><input type="datetime-local" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} required /></Field>
        <Field label="Billing increment (seconds)" help="e.g. 1, 6, 30 or 60."><input type="number" min="1" value={increment} onChange={(e) => setIncrement(e.target.value)} required /></Field>
        <Field label="Minimum charge (seconds)"><input type="number" min="0" value={minimum} onChange={(e) => setMinimum(e.target.value)} /></Field>
        <Field label="Rounding">
          <select value={rounding} onChange={(e) => setRounding(e.target.value)}>
            <option value="up">up</option><option value="nearest">nearest</option><option value="down">down</option>
          </select>
        </Field>
        <Field label="Concurrency limit (optional)"><input type="number" min="1" value={concurrency} onChange={(e) => setConcurrency(e.target.value)} /></Field>
        <Field label="Burst premium multiplier (optional)" help="2 means the rate doubles on overburst."><input type="number" min="1" step="0.001" value={burst} onChange={(e) => setBurst(e.target.value)} /></Field>
      </div>
      <Field label="Notes (optional)"><input value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>

      <h3>Billable components</h3>
      {rows.map((r, i) => (
        <div className="grid component" key={i}>
          <Field label="Component">
            <select value={r.component} onChange={(e) => setRow(i, { component: e.target.value })}>{COMPONENTS.map((c) => <option key={c}>{c}</option>)}</select>
          </Field>
          <Field label="Unit">
            <select value={r.unit} onChange={(e) => setRow(i, { unit: e.target.value })}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select>
          </Field>
          <Field label="Rate"><input inputMode="decimal" pattern="\d+(\.\d+)?" placeholder="0.0140" value={r.rate} onChange={(e) => setRow(i, { rate: e.target.value })} required /></Field>
          <Field label="Currency"><input maxLength={3} value={r.currency} onChange={(e) => setRow(i, { currency: e.target.value.toUpperCase() })} required /></Field>
          <Field label="Billing line" help="Separate lines, e.g. call vs SIP trunk."><input value={r.billingLine} onChange={(e) => setRow(i, { billingLine: e.target.value })} required /></Field>
          <Field label="Applies to" help="Some providers charge inbound and outbound differently.">
            <select value={r.direction} onChange={(e) => setRow(i, { direction: e.target.value })}><option value="any">any call</option><option value="inbound">inbound only</option><option value="outbound">outbound only</option></select>
          </Field>
          {rows.length > 1 && <button type="button" className="link" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>Remove</button>}
        </div>
      ))}
      <button type="button" className="secondary" onClick={() => setRows((rs) => [...rs, blankRow()])}>Add component</button>
      <Errors error={error} />
      <div><button type="submit" disabled={pending}>Save new version</button></div>
    </form>
  );
}

function Versions({ versions, onChanged }: { versions: ChargingVersion[]; onChanged: () => void }) {
  const [url, setUrl] = useState<Record<string, string>>({});
  const { error, run } = useAction();
  if (versions.length === 0) return <p className="muted">No charging versions yet. Rates must be captured before this provider carries traffic.</p>;
  return (
    <>
      <Errors error={error} />
      {[...versions].reverse().map((v) => (
        <div className="version" key={v.id}>
          <h3>
            Version {v.version} <span className={v.confirmed ? 'badge ok' : 'badge warn'}>{v.confirmed ? 'Confirmed' : 'Unconfirmed'}</span>
          </h3>
          <p className="muted">
            Effective {fmtDate(v.effective_from)} · billed in {v.billing_increment_seconds}s blocks, minimum {v.minimum_charge_seconds}s, rounded {v.rounding}
            {v.concurrency_limit ? ` · ${v.concurrency_limit} concurrent` : ''}
            {v.burst_premium_multiplier ? ` · burst ×${Number(v.burst_premium_multiplier)}` : ''}
          </p>
          <table>
            <thead><tr><th>Component</th><th>Rate</th><th>Unit</th><th>Line</th><th>Applies to</th></tr></thead>
            <tbody>{v.components.map((c, i) => (
              <tr key={i}><td>{c.component}</td><td>{Number(c.rate)} {c.currency}</td><td>{c.unit}</td><td>{c.billing_line}</td><td>{c.direction === 'any' ? 'any call' : `${c.direction} only`}</td></tr>
            ))}</tbody>
          </table>
          {v.confirmed ? (
            <p className="muted">Checked against <a href={v.source_url ?? '#'} target="_blank" rel="noreferrer">{v.source_url}</a></p>
          ) : (
            <form className="inline" onSubmit={(e) => { e.preventDefault(); run(async () => { await api('POST', `/internal/charging/${v.id}/confirm`, { sourceUrl: url[v.id] }); onChanged(); }); }}>
              <Field label="Mark as checked against the provider’s pricing page">
                <input type="url" placeholder="https://…" value={url[v.id] ?? ''} onChange={(e) => setUrl((s) => ({ ...s, [v.id]: e.target.value }))} required />
              </Field>
              <button type="submit" className="secondary">Confirm</button>
            </form>
          )}
        </div>
      ))}
    </>
  );
}

function Funding({ providerId }: { providerId: string }) {
  const balances = useLoad(() => api<{ currency: string; balance: string }[]>('GET', `/internal/providers/${providerId}/funding`), [providerId]);
  const [kind, setKind] = useState('topup');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [ref, setRef] = useState('');
  const { pending, error, run } = useAction();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const ok = await run(() => api('POST', `/internal/providers/${providerId}/funding`, { kind, amount, currency, ref: ref || undefined }));
    if (ok) { setAmount(''); setRef(''); balances.reload(); }
  }
  return (
    <section className="card">
      <h2>Funding</h2>
      <p className="muted">Voice Lab’s own balance with this provider. Internal only; clients never see it.</p>
      <Errors error={balances.error} />
      {balances.data && (balances.data.length === 0
        ? <p className="muted">No entries yet.</p>
        : <ul>{balances.data.map((b) => <li key={b.currency}><strong>{Number(b.balance).toLocaleString()}</strong> {b.currency}</li>)}</ul>)}
      <form className="grid" onSubmit={submit} aria-label="Add funding entry">
        <Field label="Type">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="topup">top-up</option><option value="usage">usage (negative)</option><option value="adjustment">adjustment</option>
          </select>
        </Field>
        <Field label="Amount" help="Use a minus sign for usage or a deduction."><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field>
        <Field label="Currency"><input maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} required /></Field>
        <Field label="Reference (optional)"><input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        <div><button type="submit" disabled={pending}>Record</button></div>
      </form>
      <Errors error={error} />
    </section>
  );
}

export function ProviderDetail({ id }: { id: string }) {
  const provider = useLoad(() => api<Provider>('GET', `/internal/providers/${id}`), [id]);
  const versions = useLoad(() => api<ChargingVersion[]>('GET', `/internal/providers/${id}/charging`), [id]);

  return (
    <>
      <p><a href="#/providers">← All providers</a></p>
      <Errors error={provider.error ?? versions.error} />
      {provider.data && (
        <>
          <h1>{provider.data.name}</h1>
          <p className="muted">
            {provider.data.adapter_key} · {provider.data.kind} · {provider.data.status} ·
            {' '}{provider.data.secrets_stored ? 'credentials stored (encrypted)' : 'no credentials stored'}
          </p>
          <CredentialCheck provider={provider.data} onChecked={provider.reload} />
          <section className="card">
            <h2>Settings</h2>
            {Object.keys(provider.data.params).length === 0
              ? <p className="muted">No non-secret settings.</p>
              : <table><tbody>{Object.entries(provider.data.params).map(([k, v]) => <tr key={k}><td>{k}</td><td>{String(v)}</td></tr>)}</tbody></table>}
          </section>
          <Capabilities provider={provider.data} onChanged={provider.reload} />
        </>
      )}
      <section className="card">
        <h2>Charging</h2>
        {versions.data && <Versions versions={versions.data} onChanged={versions.reload} />}
      </section>
      {provider.data && <ReferenceRates provider={provider.data} onAdded={versions.reload} />}
      <AddVersion providerId={id} onAdded={versions.reload} />
      <Funding providerId={id} />
    </>
  );
}
