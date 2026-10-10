import { type Panels } from './api';
import { fmtDate, fmtDecimal } from './ui';

const pct = (p: string | null) => (p === null ? '—' : `${p}%`);
const Unavailable = ({ what }: { what: string }) => <p className="muted" role="status">The {what} figures could not be worked out just now; the other panels are unaffected.</p>;

/** The panels beyond the first screen. Each one can be missing on its own without hiding the others. */
export function TowerPanels({ p }: { p: Panels }) {
  return (
    <>
      <section className="card" aria-label="Runway">
        <h2>Days of funding left</h2>
        {p.funding === null ? <Unavailable what="funding" /> : p.funding.length === 0 ? <p className="muted">No funding recorded yet.</p> : (
          <table>
            <thead><tr><th>Provider</th><th>Recorded balance</th><th>Spent, last 7 days</th><th>A day</th><th>Days left</th></tr></thead>
            <tbody>{p.funding.map((f) => (
              <tr key={`${f.providerId}-${f.currency}`}>
                <td><a href={`#/providers/${f.providerId}`}>{f.provider}</a></td>
                <td>{fmtDecimal(f.balance)} {f.currency} <span className="muted">as of {fmtDate(f.recordedAt)}</span></td>
                <td>{fmtDecimal(f.spent7d)} {f.currency}</td><td>{fmtDecimal(f.perDay)} {f.currency}</td>
                <td>{f.runwayDays === null ? <span className="muted">no spend to measure</span> : f.runwayDays}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
        <p className="muted">Days left are the recorded balance divided by the last 7 days' average spend at our rates. Calls are not taken off the recorded balance, so record each top-up and statement to keep it true.</p>
      </section>

      <section className="card" aria-label="Concurrency">
        <h2>Concurrency</h2>
        {p.concurrency === null ? <Unavailable what="concurrency" /> : (
          <>
            {p.concurrency.providers.length === 0 ? <p className="muted">No active telephony providers.</p> : (
              <table>
                <thead><tr><th>Provider</th><th>Live channels</th><th>Ceiling</th><th>Used</th><th>Burst calls, 24h</th></tr></thead>
                <tbody>{p.concurrency.providers.map((x) => (
                  <tr key={x.providerId}><td>{x.provider}</td><td>{x.active}</td><td>{x.ceiling ?? 'none set'}</td><td>{pct(x.usedPercent)}</td><td>{x.burst24h}</td></tr>
                ))}</tbody>
              </table>
            )}
            {p.concurrency.tenants.length > 0 && (
              <table>
                <thead><tr><th>Client</th><th>Inbound in use</th><th>Channels</th><th>Waiting</th></tr></thead>
                <tbody>{p.concurrency.tenants.map((x) => <tr key={x.tenantId}><td>{x.tenant}</td><td>{x.active}</td><td>{x.channels}</td><td>{x.queued}</td></tr>)}</tbody>
              </table>
            )}
            <p className="muted">{p.concurrency.deferred24h} outbound dial{p.concurrency.deferred24h === 1 ? ' was' : 's were'} held back in the last 24 hours because every provider was full. <a href="#/resilience">Ceilings and entitlements</a></p>
          </>
        )}
      </section>

      <section className="card" aria-label="Stitching">
        <h2>Stitching</h2>
        {p.stitching === null ? <Unavailable what="stitching" /> : (
          <>
            <p>Last 7 days: <strong>{pct(p.stitching.recordedPercent)}</strong> of speech played from recordings ({p.stitching.recordedChars} characters), {p.stitching.synthChars} characters synthesised.</p>
            {p.stitching.workflows.length > 0 && (
              <table>
                <thead><tr><th>Workflow</th><th>Client</th><th>Recorded</th><th>Synthesised</th><th>From recordings</th></tr></thead>
                <tbody>{p.stitching.workflows.map((w) => <tr key={w.workflowId}><td><a href={`#/workflows/${w.workflowId}`}>{w.workflow}</a></td><td>{w.tenant}</td><td>{w.recordedChars}</td><td>{w.synthChars}</td><td>{pct(w.recordedPercent)}</td></tr>)}</tbody>
              </table>
            )}
            <p className="muted">Real and test calls only, not rehearsals. Each recorded character is one the voice provider did not have to synthesise. <a href="#/recordings">Recordings</a></p>
          </>
        )}
      </section>

      <section className="card" aria-label="Deliverability">
        <h2>Deliverability</h2>
        {p.deliverability === null ? <Unavailable what="deliverability" /> : (
          <>
            <p>Last 7 days: {p.deliverability.dialled} dials went out, {p.deliverability.answered} answered ({pct(p.deliverability.answerPercent)}), contact rate {pct(p.deliverability.contactPercent)}.</p>
            <p>Caller IDs: {p.deliverability.pool.active} in use, {p.deliverability.pool.retired} retired.
              {p.deliverability.failures.length > 0 && <> Locked away from a contact this week: {p.deliverability.failures.map((f) => `${f.n} for ${f.reason.replace(/_/g, ' ')}`).join(', ')}.</>}</p>
            <p className="muted"><a href="#/outbound">Outcomes by pool</a> · <a href="#/numbers">Retire a caller ID</a></p>
          </>
        )}
      </section>

      <section className="card" aria-label="Journey and QA">
        <h2>Journey and QA</h2>
        {p.journeyQa === null ? <Unavailable what="journey and QA" /> : (
          <>
            <p>QA, last 7 days: {p.journeyQa.qa.scored === 0 ? 'nothing scored yet.' : <>{p.journeyQa.qa.scored} calls scored, average {p.journeyQa.qa.average}. {p.journeyQa.qa.distribution.map((d) => `${d.band}: ${d.n}`).join(' · ')}</>}</p>
            <p>{p.journeyQa.unacknowledgedFaults > 0 ? <a href="#/faults">{p.journeyQa.unacknowledgedFaults} system drop{p.journeyQa.unacknowledgedFaults === 1 ? '' : 's'} not yet looked at</a> : 'No system drops waiting.'}
              {' '}Escalations this week: {p.journeyQa.escalations.length === 0 ? 'none' : p.journeyQa.escalations.map((e) => `${e.n} ${e.trigger.replace(/_/g, ' ')}`).join(', ')}.</p>
            {p.journeyQa.sentiment.length > 0 && (
              <table>
                <thead><tr><th>Day (UTC)</th><th>Turns read</th><th>Average sentiment</th><th>Severe</th></tr></thead>
                <tbody>{p.journeyQa.sentiment.map((s) => <tr key={s.day}><td>{s.day}</td><td>{s.turns}</td><td>{s.average}</td><td>{s.severe}</td></tr>)}</tbody>
              </table>
            )}
            <p className="muted"><a href="#/tickets">Tickets</a> · <a href="#/qa">Quality</a></p>
          </>
        )}
      </section>

      <section className="card" aria-label="Learning loop">
        <h2>Learning loop</h2>
        {p.learning === null ? <Unavailable what="learning loop" /> : (
          <p>{p.learning.inReview} waiting for review, {p.learning.approved} approved and waiting for audio, {p.learning.promoted} speaking from recordings, {p.learning.demoted} demoted
            ({p.learning.driftDemotions7d} for drift and {p.learning.forcedDemotions7d} by hand this week). <a href="#/learning">Review and decide</a></p>
        )}
      </section>

      <section className="card" aria-label="Modules">
        <h2>Modules</h2>
        {p.modules === null ? <Unavailable what="modules" /> : (
          <>
            <p><a href="#/cases">Cases</a>: {p.modules.cases.open} open, {p.modules.cases.decisionRequired} waiting for a decision, {p.modules.cases.brokenPromises7d} promise{p.modules.cases.brokenPromises7d === 1 ? '' : 's'} broken and {p.modules.cases.missedOrUnknown} call{p.modules.cases.missedOrUnknown === 1 ? '' : 's'} missed or unknown this week.</p>
            <p><a href="#/appointments">Appointments</a>: {p.modules.appointments.upcoming} upcoming, {p.modules.appointments.needsReschedule} needing a new time, {p.modules.appointments.movedByDelays7d} moved by delays this week, {p.modules.appointments.unsentOverAnHour} message{p.modules.appointments.unsentOverAnHour === 1 ? '' : 's'} waiting over an hour.</p>
          </>
        )}
      </section>
    </>
  );
}
