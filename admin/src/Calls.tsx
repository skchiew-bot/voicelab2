import { useState } from 'react';
import { api, type CallCost, type CallEvent, type CallRow, type CampaignCost, type Reconciliation } from './api';
import { Errors, Field, fmtDate, useAction, useLoad, fmtDecimal } from './ui';

const COST_STATE: Record<string, { text: string; cls: string }> = {
  pending: { text: 'Not priced', cls: 'badge warn' }, recorded: { text: 'Estimated', cls: 'badge warn' },
  not_applicable: { text: 'Nothing to price', cls: 'badge' }, reconciled: { text: 'Reconciled', cls: 'badge ok' }, variance: { text: 'Differs from provider', cls: 'badge bad' }, failed: { text: 'Could not price', cls: 'badge bad' },
};

function CallDetail({ call, onChanged }: { call: CallRow; onChanged: () => void }) {
  const events = useLoad(() => api<CallEvent[]>('GET', `/internal/calls/${call.id}/events`), [call.id, call.cost_status]);
  const cost = useLoad(async () => {
    try { return await api<CallCost>('GET', `/internal/calls/${call.id}/cost`); } catch { return null; }
  }, [call.id, call.cost_status]);
  const recs = useLoad(() => api<Reconciliation[]>('GET', `/internal/calls/${call.id}/reconciliations`), [call.id, call.cost_status]);
  const [result, setResult] = useState<string | null>(null);
  const [seconds, setSeconds] = useState('');
  const [reported, setReported] = useState('');
  const [currency, setCurrency] = useState('USD');
  const act = useAction();
  const ended = call.ended_at !== null;

  async function reconcile(body: object) {
    const r = await act.run(() => api<{ outcome: string; detail: string }>('POST', `/internal/calls/${call.id}/reconcile`, body));
    if (r) { setResult(`${r.outcome}: ${r.detail}`); onChanged(); }
  }

  return (
    <section className="card" aria-label="Call detail">
      <h2>Call {call.id.slice(0, 8)}</h2>
      <p className="muted">{call.direction} · {call.status}{call.end_reason ? ` (${call.end_reason})` : ''} · {call.country ?? '—'} · started {fmtDate(call.started_at)}{call.duration_seconds ? ` · ${fmtDecimal(call.duration_seconds)}s` : ''}</p>

      <h3>Timeline</h3>
      <Errors error={events.error} />
      <ol className="timeline">{events.data?.map((e) => <li key={e.id}><code>{e.type}</code> <span className="muted">{fmtDate(e.occurred_at)}</span></li>)}</ol>

      <h3>Cost</h3>
      {call.cost_status === 'failed' && <div className="errors" role="alert">This call could not be priced: {call.cost_error ?? 'see the timeline'}. Fix the cause (usually a missing rate or FX rate), then re-price.</div>}
      {cost.data ? (
        <>
          <p><span className={COST_STATE[cost.data.status === 'reconciled' ? 'reconciled' : call.cost_status]?.cls ?? 'badge'}>{cost.data.status === 'reconciled' ? 'Reconciled' : COST_STATE[call.cost_status]?.text ?? call.cost_status}</span>{' '}
            <strong>{fmtDecimal(cost.data.total_usd)} USD</strong> · {fmtDecimal(cost.data.total_myr)} MYR · credits drawn {fmtDecimal(cost.data.credits_drawn)} · margin {fmtDecimal(cost.data.margin_usd)} USD</p>
          <table>
            <thead><tr><th>Component</th><th>Line</th><th>Quantity</th><th>Rate</th><th>Amount</th></tr></thead>
            <tbody>{cost.data.lines.map((l, i) => (
              <tr key={i}><td>{l.component}</td><td>{l.billing_line}</td><td>{l.quantity}</td><td>{fmtDecimal(l.rate)} {l.currency} {l.unit.replace('_', ' ')}</td><td>{fmtDecimal(l.amount_usd)} USD</td></tr>
            ))}</tbody>
          </table>
        </>
      ) : <p className="muted">No cost record.</p>}

      {recs.data && recs.data.length > 0 && (
        <>
          <h3>Checked against the provider</h3>
          <ul>{recs.data.map((r) => <li key={r.id}><span className={r.outcome === 'matched' ? 'badge ok' : 'badge bad'}>{r.outcome}</span> {r.detail} <span className="muted">({r.source.replace('_', ' ')})</span></li>)}</ul>
        </>
      )}

      {ended && (
        <>
          <Errors error={act.error} />
          {result && <div className="notice" role="status">{result}</div>}
          <div className="inline">
            {call.cost_status === 'failed' && (
              <button disabled={act.pending} onClick={async () => { if (await act.run(() => api('POST', `/internal/calls/${call.id}/cost/retry`))) onChanged(); }}>Re-price</button>
            )}
            {cost.data && call.cost_status !== 'reconciled' && (
              <button className="secondary" disabled={act.pending} onClick={() => reconcile({ source: 'provider_api' })}>Check against the provider (Twilio)</button>
            )}
          </div>
          {cost.data && call.cost_status !== 'reconciled' && (
            <form className="grid" aria-label="Enter the provider's figures" onSubmit={(e) => {
              e.preventDefault();
              reconcile({ source: 'manual', reportedSeconds: seconds ? Number(seconds) : undefined, reportedCost: reported, currency });
            }}>
              <Field label="Provider's duration (seconds)"><input inputMode="decimal" value={seconds} onChange={(e) => setSeconds(e.target.value)} /></Field>
              <Field label="Provider's cost" help="Required: a duration alone cannot show the rate was right."><input inputMode="decimal" value={reported} onChange={(e) => setReported(e.target.value)} required /></Field>
              <Field label="Currency"><input maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} /></Field>
              <div><button type="submit" className="secondary" disabled={act.pending || !reported}>Compare my figures</button></div>
            </form>
          )}
        </>
      )}
    </section>
  );
}

export function Calls() {
  const calls = useLoad(() => api<CallRow[]>('GET', '/internal/calls?limit=50'));
  const campaigns = useLoad(() => api<CampaignCost[]>('GET', '/internal/costs/campaigns'));
  const [open, setOpen] = useState<string | null>(null);
  const current = calls.data?.find((c) => c.id === open);

  return (
    <>
      <h1>Calls and costs</h1>
      <Errors error={calls.error ?? campaigns.error} />

      <section className="card">
        <h2>Cost by campaign</h2>
        {campaigns.data && (campaigns.data.length === 0 ? <p className="muted">No priced calls yet.</p> : (
          <table>
            <thead><tr><th>Campaign</th><th>Calls</th><th>Cost (USD)</th><th>Cost (MYR)</th><th>Credits drawn</th><th>Margin (USD)</th></tr></thead>
            <tbody>{campaigns.data.map((c) => (
              <tr key={c.project_id ?? 'none'}><td>{c.project ?? 'No campaign'}</td><td>{c.calls}</td><td>{fmtDecimal(c.total_usd)}</td><td>{fmtDecimal(c.total_myr)}</td><td>{fmtDecimal(c.credits_drawn)}</td><td>{fmtDecimal(c.margin_usd)}</td></tr>
            ))}</tbody>
          </table>
        ))}
      </section>

      <h2>Recent calls</h2>
      {calls.data && (calls.data.length === 0 ? <p className="muted">No calls yet.</p> : (
        <table>
          <thead><tr><th>Started</th><th>Direction</th><th>Status</th><th>Duration</th><th>Cost</th><th /></tr></thead>
          <tbody>{calls.data.map((c) => (
            <tr key={c.id}>
              <td>{fmtDate(c.started_at)}</td><td>{c.direction}</td><td>{c.status}</td>
              <td>{c.duration_seconds ? `${fmtDecimal(c.duration_seconds)}s` : '—'}</td>
              <td><span className={COST_STATE[c.cost_status]?.cls ?? 'badge'}>{COST_STATE[c.cost_status]?.text ?? c.cost_status}</span></td>
              <td><button className="link" onClick={() => setOpen(c.id)}>Details</button> <a href={`#/replay/call/${c.id}`}>Replay</a></td>
            </tr>
          ))}</tbody>
        </table>
      ))}
      {current && <CallDetail key={current.id} call={current} onChanged={() => { calls.reload(); campaigns.reload(); }} />}
    </>
  );
}
