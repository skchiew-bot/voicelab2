import { useState } from 'react';
import { api, type CapacityRow, type FailoverRow, type FundingRow, type HealthRow, type PolicyView, type Provider } from './api';
import { Errors, Field, fmtDate, useAction, useLoad, fmtDecimal } from './ui';

const STATE_TEXT: Record<HealthRow['state'], string> = { healthy: 'Healthy', failed: 'Failed over', unfunded: 'Out of funding' };
const LEVEL_TEXT: Record<FundingRow['level'], string> = { ok: 'OK', warn: 'Running low', critical: 'Critical', empty: 'Empty' };

function Thresholds({ providers, onSaved }: { providers: Provider[]; onSaved: () => void }) {
  const [providerId, setProviderId] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [warn, setWarn] = useState('');
  const [critical, setCritical] = useState('');
  const { pending, error, run } = useAction();
  return (
    <form className="card" aria-label="Funding alert levels" onSubmit={async (e) => {
      e.preventDefault();
      if (await run(() => api('PUT', `/internal/providers/${providerId}/funding-thresholds`, { currency, warnBelow: warn, criticalBelow: critical }))) { setWarn(''); setCritical(''); onSaved(); }
    }}>
      <h2>Funding alert levels</h2>
      <p className="muted">Get a warning while there is still money left. Below the first level the provider shows as running low; below the second, as critical.</p>
      <div className="grid">
        <Field label="Provider">
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)} required>
            <option value="">Choose…</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <Field label="Currency"><input maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} required /></Field>
        <Field label="Warn below"><input inputMode="decimal" value={warn} onChange={(e) => setWarn(e.target.value)} required /></Field>
        <Field label="Critical below"><input inputMode="decimal" value={critical} onChange={(e) => setCritical(e.target.value)} required /></Field>
      </div>
      <Errors error={error} />
      <div><button type="submit" disabled={pending}>Save levels</button></div>
    </form>
  );
}

function Policy() {
  const policy = useLoad(() => api<PolicyView>('GET', '/internal/resilience/policy'));
  const [draft, setDraft] = useState<Record<string, string>>({});
  const { pending, error, run } = useAction();
  const p = policy.data;
  const fields: [keyof PolicyView, string, string][] = [
    ['errorThreshold', 'Errors before failing over', 'How many errors inside the window.'],
    ['errorWindowMs', 'Error window (ms)', ''],
    ['latencyThresholdMs', 'Slow above (ms)', 'The typical reply must be slower than this.'],
    ['latencyWindowMs', 'Latency window (ms)', ''],
    ['latencyMinSamples', 'Replies needed to judge latency', 'Fewer than this is not enough to say.'],
    ['deadAirMs', 'Dead air at (ms)', 'A silence this long counts as the line not playing.'],
    ['recoveryOkSamples', 'Good attempts before trusting again', 'In a row.'],
    ['recoveryDwellMs', 'Minimum time before trusting again (ms)', 'Stops it switching back on the first sign of recovery.'],
  ];
  return (
    <form className="card" aria-label="Failover rules" onSubmit={async (e) => {
      e.preventDefault();
      const patch = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)]));
      if (await run(() => api('PUT', '/internal/resilience/policy', patch))) { setDraft({}); policy.reload(); }
    }}>
      <h2>When to fail over</h2>
      <p className="muted">A provider is failed over after repeated errors or dead air, or when its typical reply is slow for a while. One bad reply never does it. Running out of funding does it at once.</p>
      <Errors error={policy.error} />
      {p && <div className="grid">{fields.map(([k, label, help]) => (
        <Field key={k} label={label} help={help || undefined}>
          <input inputMode="numeric" placeholder={String(p[k])} value={draft[k] ?? ''} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
        </Field>
      ))}</div>}
      <Errors error={error} />
      <div><button type="submit" disabled={pending || Object.values(draft).every((v) => v === '')}>Save rules</button></div>
    </form>
  );
}

export function Resilience() {
  const health = useLoad(() => api<HealthRow[]>('GET', '/internal/resilience/health'));
  const capacity = useLoad(() => api<CapacityRow[]>('GET', '/internal/capacity'));
  const funding = useLoad(() => api<FundingRow[]>('GET', '/internal/funding/status'));
  const failovers = useLoad(() => api<FailoverRow[]>('GET', '/internal/resilience/failovers?limit=30'));
  const providers = useLoad(() => api<Provider[]>('GET', '/internal/providers'));
  const reloadAll = () => { health.reload(); funding.reload(); };

  return (
    <>
      <h1>Resilience</h1>
      <p className="muted">How calls stay alive when a provider fails, runs out of money or is full. A failed provider is trusted again only after a run of good attempts over a minimum time.</p>
      <Errors error={health.error ?? capacity.error ?? funding.error ?? failovers.error ?? providers.error} />

      <section className="card" aria-label="Provider health">
        <h2>Provider health</h2>
        {health.data && (
          <table>
            <thead><tr><th>Provider</th><th>State</th><th>Why</th><th>Since</th></tr></thead>
            <tbody>{health.data.filter((h) => h.status === 'active').map((h) => (
              <tr key={h.provider_id}>
                <td>{h.name}</td>
                <td><span className={`badge ${h.state === 'healthy' ? 'ok' : 'bad'}`}>{STATE_TEXT[h.state]}</span></td>
                <td>{h.state === 'healthy' ? '' : `${h.reason ?? ''}${h.state === 'failed' ? ` (${h.ok_streak} good attempts so far)` : ''}`}</td>
                <td>{h.since ? fmtDate(h.since) : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>

      <section className="card" aria-label="Capacity">
        <h2>Capacity</h2>
        <p className="muted">Calls in progress against each provider's concurrency limit. Past the limit a provider charges a premium, so further calls go to a provider with room, wait, or (for a client that agreed to it) pay the premium.</p>
        {capacity.data && (
          <table>
            <thead><tr><th>Provider</th><th>In progress</th><th>Limit</th></tr></thead>
            <tbody>{capacity.data.map((c) => <tr key={c.providerId}><td>{c.name}</td><td>{c.active}</td><td>{c.ceiling ?? 'none set'}</td></tr>)}</tbody>
          </table>
        )}
      </section>

      <section className="card" aria-label="Funding">
        <h2>Funding</h2>
        {funding.data && (funding.data.length === 0 ? <p className="muted">No funding recorded yet.</p> : (
          <table>
            <thead><tr><th>Provider</th><th>Balance</th><th>Level</th><th>Warns below</th><th>Critical below</th></tr></thead>
            <tbody>{funding.data.map((f) => (
              <tr key={`${f.providerId}-${f.currency}`}>
                <td>{f.provider}</td><td>{fmtDecimal(f.balance)} {f.currency}</td>
                <td><span className={`badge ${f.level === 'ok' ? 'ok' : 'bad'}`}>{LEVEL_TEXT[f.level]}</span></td>
                <td>{f.warnBelow === null ? 'not set' : fmtDecimal(f.warnBelow)}</td><td>{f.criticalBelow === null ? 'not set' : fmtDecimal(f.criticalBelow)}</td>
              </tr>
            ))}</tbody>
          </table>
        ))}
      </section>
      {providers.data && <Thresholds providers={providers.data} onSaved={reloadAll} />}
      <Policy />

      <section className="card" aria-label="Recent failovers">
        <h2>Recent failovers</h2>
        {failovers.data && (failovers.data.length === 0 ? <p className="muted">Nothing has failed over.</p> : (
          <table>
            <thead><tr><th>When</th><th>Kind</th><th>From</th><th>To</th><th>Why</th></tr></thead>
            <tbody>{failovers.data.map((f) => (
              <tr key={f.id}><td>{fmtDate(f.at)}</td><td>{f.scope.replace('_', ' ')}</td><td>{f.from_name ?? '—'}</td><td>{f.to_name ?? '—'}</td><td>{f.trigger.replace(/_/g, ' ')}</td></tr>
            ))}</tbody>
          </table>
        ))}
      </section>
    </>
  );
}
