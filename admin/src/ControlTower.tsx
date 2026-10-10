import { useEffect } from 'react';
import { api, type PhaseProgress, type Progress, type Tower } from './api';
import { Errors, fmtDate, fmtDecimal, useLoad } from './ui';

const SEVERITY = { high: 'badge bad', medium: 'badge warn', low: 'badge' } as const;
const STATUS = { done: ['Done', 'badge ok'], in_progress: ['In progress', 'badge warn'], not_started: ['Not started', 'badge'] } as const;
const STATE = { met: ['Met', 'badge ok'], partly: ['Partly', 'badge warn'], not_met: ['Not met', 'badge bad'] } as const;
const PROOF = { tests: 'tested', fakes: 'tested against fakes, not the real provider', live: 'proven live', none: '' } as const;

function Phase({ p }: { p: PhaseProgress }) {
  const met = p.criteria.filter((c) => c.state === 'met').length;
  const partly = p.criteria.filter((c) => c.state === 'partly').length;
  const [label, cls] = STATUS[p.status];
  return (
    <article className="phase" aria-label={`${p.id === 'CT' ? '' : 'Phase '}${p.id === 'CT' ? 'Control Tower' : p.id}`}>
      <header>
        <h3>{p.id === 'CT' ? 'Control Tower' : `Phase ${p.id}: ${p.name}`}</h3>
        <span className={cls}>{label}</span>
      </header>
      <p className="muted">{p.summary}</p>
      {p.criteria.length > 0 && (
        <p>
          <progress max={p.criteria.length} value={met} aria-label="Exit criteria met" />{' '}
          <span>{met} of {p.criteria.length} exit criteria met{partly > 0 ? `, ${partly} partly` : ''}</span>
        </p>
      )}
      {(p.criteria.length > 0 || p.open.length > 0) && (
        <details>
          <summary>Details</summary>
          <ul className="criteria">
            {p.criteria.map((c) => (
              <li key={c.text}>
                <span className={STATE[c.state][1]}>{STATE[c.state][0]}</span> {c.text}
                {c.proof !== 'none' && <span className="muted"> ({PROOF[c.proof]})</span>}
                {c.note && <div className="muted">{c.note}</div>}
              </li>
            ))}
          </ul>
          {p.open.length > 0 && <><strong>Still open</strong><ul>{p.open.map((o) => <li key={o}>{o}</li>)}</ul></>}
        </details>
      )}
    </article>
  );
}

export function ControlTower() {
  const tower = useLoad(() => api<Tower>('GET', '/internal/control-tower'));
  const progress = useLoad(() => api<Progress>('GET', '/internal/progress'));
  // Live panels refresh by themselves; the progress view changes only when the code does.
  useEffect(() => { const t = setInterval(tower.reload, 15_000); return () => clearInterval(t); }, [tower.reload]);

  const phases = progress.data?.phases ?? [];
  const count = (s: string) => phases.filter((p) => p.status === s).length;
  // Worked out from the data, so it cannot go stale when something is finally proven against a real provider.
  const liveProven = phases.flatMap((p) => p.criteria).filter((c) => c.proof === 'live').length;
  const t = tower.data;
  const pname = (id: string) => t?.providers.find((p) => p.id === id)?.name ?? id.slice(0, 8);

  return (
    <>
      <h1>Control Tower</h1>
      <p className="muted">
        {t ? `Updated ${new Date(t.generatedAt).toLocaleTimeString()}. ` : ''}
        <button className="link" onClick={() => { tower.reload(); progress.reload(); }}>Refresh now</button>
      </p>
      {(tower.error || progress.error) && (t || progress.data) && (
        <div className="errors" role="alert">The latest refresh failed, so what you see below may be out of date{t ? ` (as of ${new Date(t.generatedAt).toLocaleTimeString()})` : ''}.</div>
      )}
      {(tower.error || progress.error) && !t && !progress.data && <Errors error={tower.error ?? progress.error} />}

      <section className="card" aria-label="Needs attention">
        <h2>Needs attention</h2>
        {t && (t.alerts.length === 0
          ? <div className="notice ok" role="status">Nothing needs attention.</div>
          : <ul className="alerts">{t.alerts.map((a, i) => (
              <li key={`${a.code}-${i}`}><span className={SEVERITY[a.severity]}>{a.severity}</span> {a.link ? <a href={a.link}>{a.message}</a> : a.message}</li>
            ))}</ul>)}
        <p className="muted">Alerts appear in this console only for now.</p>
      </section>

      <section className="card" aria-label="Project progress">
        <h2>Project progress</h2>
        {progress.data && (
          <p>
            <strong>{count('done')}</strong> of {phases.length} done · <strong>{count('in_progress')}</strong> in progress · <strong>{count('not_started')}</strong> not started.
            {' '}<span className="muted">{liveProven === 0
              ? 'Nothing has yet been proven against the real Twilio, Telnyx, OpenAI or ElevenLabs.'
              : `${liveProven} exit criteri${liveProven === 1 ? 'on has' : 'a have'} been proven against a real provider.`}</span>
          </p>
        )}
        <div className="phases">{phases.map((p) => <Phase key={p.id} p={p} />)}</div>
        {progress.data && progress.data.crossCutting.length > 0 && (
          <div className="phase" aria-label="Applies to every phase">
            <h3>Applies to every phase</h3>
            <ul className="criteria">{progress.data.crossCutting.map((c) => (
              <li key={c.text}><span className={STATE[c.state][1]}>{STATE[c.state][0]}</span> Each phase's exit also requires that {c.text}
                {c.note && <div className="muted">{c.note}</div>}</li>
            ))}</ul>
          </div>
        )}
        {progress.data && (
          <details>
            <summary>{progress.data.decisions.length} open decisions</summary>
            <ul>{progress.data.decisions.map((d) => <li key={d}>{d}</li>)}</ul>
          </details>
        )}
      </section>

      {t && (
        <>
          <section className="card" aria-label="Live calls">
            <h2>Live calls</h2>
            {t.activeCalls.length === 0 ? <p className="muted">No calls in progress.</p> : (
              <table>
                <thead><tr><th>Started</th><th>Direction</th><th>Status</th><th>Provider</th></tr></thead>
                <tbody>{t.activeCalls.map((c) => <tr key={c.id}><td>{fmtDate(c.started_at)}</td><td>{c.direction}</td><td>{c.status.replace('_', ' ')}</td><td>{pname(c.provider_id)}</td></tr>)}</tbody>
              </table>
            )}
            {t.activeTotal > t.activeCalls.length && <p className="muted">Showing the newest {t.activeCalls.length} of {t.activeTotal} calls in progress.</p>}
            <p className="muted">{t.blocked24h} outbound call{t.blocked24h === 1 ? '' : 's'} blocked by the do-not-call gate in the last 24 hours.</p>
          </section>

          <section className="card" aria-label="Provider health">
            <h2>Provider health</h2>
            {t.providers.length === 0 ? <p className="muted">No providers yet.</p> : (
              <table>
                <thead><tr><th>Provider</th><th>Credentials</th><th>Rates</th><th>Calls, 24h</th><th>Failed</th></tr></thead>
                <tbody>{t.providers.map((p) => (
                  <tr key={p.id}>
                    <td><a href={`#/providers/${p.id}`}>{p.name}</a> <span className="muted">{p.adapter}</span></td>
                    <td>{p.credentialsCheckedAt ? <span className="badge ok">checked</span> : <span className="badge warn">not checked</span>}</td>
                    <td>{!p.ratesInForce ? <span className="badge bad">none</span> : p.ratesConfirmed ? <span className="badge ok">confirmed</span> : <span className="badge warn">unconfirmed</span>}</td>
                    <td>{p.kind === 'telephony' ? p.calls24h.total : '—'}</td>
                    <td>{p.kind === 'telephony' ? p.calls24h.failed : '—'}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </section>

          <section className="card" aria-label="Funding">
            <h2>Funding</h2>
            {t.funding.length === 0 ? <p className="muted">No funding recorded yet.</p> : (
              <table>
                <thead><tr><th>Provider</th><th>Recorded balance</th></tr></thead>
                <tbody>{t.funding.map((f) => <tr key={`${f.provider_id}-${f.currency}`}><td>{f.provider}</td><td>{fmtDecimal(f.balance)} {f.currency}</td></tr>)}</tbody>
              </table>
            )}
            <p className="muted">Balances are what staff recorded. Call costs are not deducted from them automatically yet, so there is no runway figure.</p>
          </section>

          <section className="card" aria-label="Cost and margin">
            <h2>Cost and margin</h2>
            <table>
              <thead><tr><th /><th>Calls</th><th>Cost (USD)</th><th>Cost (MYR)</th><th>Credits drawn</th><th>Margin (USD)</th></tr></thead>
              <tbody>
                {([['Last 24 hours', t.money.last24h], ['Last 7 days', t.money.last7d]] as const).map(([label, m]) => (
                  <tr key={label}><td>{label}</td><td>{m.calls}</td><td>{fmtDecimal(m.cost_usd)}</td><td>{fmtDecimal(m.cost_myr)}</td><td>{fmtDecimal(m.credits_drawn)}</td><td>{fmtDecimal(m.margin_usd)}</td></tr>
                ))}
              </tbody>
            </table>
            <p className="muted"><a href="#/calls">Cost by campaign and per call</a></p>
          </section>
        </>
      )}
    </>
  );
}
