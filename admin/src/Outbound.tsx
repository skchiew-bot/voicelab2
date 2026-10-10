import { useState } from 'react';
import { useClient } from './client';
import { api, type OutboundReport, type Tenant } from './api';
import { Errors, Field, useLoad } from './ui';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pct = (v: number | null) => (v === null ? 'no attempts yet' : `${v}%`);

export function Outbound() {
  const tenants = useLoad(() => api<Tenant[]>('GET', '/internal/tenants'));
  const [tenantId, setTenantId] = useClient();
  const [days, setDays] = useState('7');
  const report = useLoad(() => {
    const to = new Date(); const from = new Date(to.getTime() - Number(days) * 24 * 3600 * 1000);
    const q = new URLSearchParams({ from: from.toISOString(), to: to.toISOString(), ...(tenantId ? { tenantId } : {}) });
    return api<OutboundReport>('GET', `/internal/analytics/outbound?${q}`);
  }, [tenantId, days]);
  const r = report.data;

  return (
    <>
      <h1>Outbound results</h1>
      <p className="muted">How outbound calls turned out. An attempt is a call that was dialled and has finished; calls blocked by do-not-call, refused for want of a usable caller ID, or still in progress are not attempts. Contact rate is people actually reached out of attempts. Answered calls nobody has classified yet are shown as such, not guessed.</p>
      <div className="grid">
        <Field label="Client">
          <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
            <option value="">All clients</option>{tenants.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <Field label="Period">
          <select value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option>
          </select>
        </Field>
      </div>
      <Errors error={tenants.error ?? report.error} />
      {r && (
        <>
          <section className="card" aria-label="Rates">
            <h2>Rates</h2>
            <p><strong>Contact rate:</strong> {pct(r.rates.contactPercent)} · <strong>Answer rate:</strong> {pct(r.rates.answerPercent)} · <strong>Attempts:</strong> {r.attempts}</p>
          </section>
          <section className="card" aria-label="Outcomes">
            <h2>Outcomes</h2>
            <table>
              <tbody>
                <tr><td>Reached the right person</td><td>{r.outcomes.contacted}</td></tr>
                <tr><td>Rejected</td><td>{r.outcomes.rejected}</td></tr>
                <tr><td>Wrong number</td><td>{r.outcomes.wrongNumber}</td></tr>
                <tr><td>Third party answered</td><td>{r.outcomes.thirdParty}</td></tr>
                <tr><td>Answered, not yet classified</td><td>{r.outcomes.unclassified}</td></tr>
                <tr><td>No answer</td><td>{r.outcomes.noAnswer}</td></tr>
                <tr><td>Unreachable (call failed)</td><td>{r.outcomes.unreachable}</td></tr>
              </tbody>
            </table>
            <p className="muted">Not attempts: {r.notDialled.blocked} blocked by do-not-call, {r.notDialled.noCallerId} refused for want of a usable caller ID, {r.inFlight} still in progress.</p>
          </section>
          <section className="card" aria-label="Best times to call back">
            <h2>Best times to call back</h2>
            {r.bestCallbackTimes.length === 0 ? <p className="muted">No callback times captured in this period.</p> : (
              <table>
                <thead><tr><th>When</th><th>Time zone</th><th>Asked for</th></tr></thead>
                <tbody>{r.bestCallbackTimes.map((s) => <tr key={`${s.day}-${s.hour}-${s.time_zone}`}><td>{DAYS[s.day]} at {String(s.hour).padStart(2, '0')}:00</td><td>{s.time_zone}</td><td>{s.requests}</td></tr>)}</tbody>
              </table>
            )}
          </section>
        </>
      )}
    </>
  );
}
