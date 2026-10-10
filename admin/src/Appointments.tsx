import { useState } from 'react';
import { useClient } from './client';
import { api, type AgendaRow, type DiaryRow, type NotificationRow, type Tenant, type AppointmentSummary } from './api';
import { Errors, Field, fmtDate, fmtDecimal, useAction, useLoad } from './ui';

const STATUS: Record<string, string> = { booked: 'Booked', completed: 'Done', cancelled: 'Cancelled', no_show: 'Did not come', rescheduled: 'Moved', needs_reschedule: 'Needs a new time' };
const today = () => new Date().toISOString().slice(0, 10);

export function Appointments() {
  const tenants = useLoad(() => api<Tenant[]>('GET', '/internal/tenants'));
  const [tenantId, setTenantId] = useClient(); const [diaryId, setDiaryId] = useState(''); const [date, setDate] = useState(today());
  const diaries = useLoad(() => (tenantId ? api<DiaryRow[]>('GET', `/internal/tenants/${tenantId}/diaries`) : Promise.resolve([])), [tenantId]);
  const agenda = useLoad(() => (diaryId ? api<AgendaRow[]>('GET', `/internal/diaries/${diaryId}/agenda?date=${date}`) : Promise.resolve([])), [diaryId, date]);
  const outbox = useLoad(() => (tenantId ? api<NotificationRow[]>('GET', `/internal/tenants/${tenantId}/notifications`) : Promise.resolve([])), [tenantId]);
  const summary = useLoad(() => (tenantId ? api<AppointmentSummary>('GET', `/internal/tenants/${tenantId}/appointments-summary`) : Promise.resolve(null)), [tenantId]);
  const act = useAction();
  const [delay, setDelay] = useState('15'); const [reason, setReason] = useState('');
  const [name, setName] = useState(''); const [officerRef, setOfficerRef] = useState('');
  const reload = () => { agenda.reload(); outbox.reload(); summary.reload(); diaries.reload(); };
  const go = async (path: string, body?: unknown) => { if (await act.run(() => api('POST', path, body ?? {}))) reload(); };

  return (
    <>
      <h1>Appointments</h1>
      <p className="muted">Diaries for an officer or a group. A delay moves every later visit that day and tells each customer. Messages are written here and delivered by the client's own sender.</p>
      <Errors error={tenants.error ?? diaries.error ?? agenda.error ?? outbox.error} />
      <Field label="Client">
        <select value={tenantId} onChange={(e) => { setTenantId(e.target.value); setDiaryId(''); }}>
          <option value="">Choose…</option>{tenants.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Field>
      {tenantId && (
        <>
          {summary.data && <section className="card" aria-label="Appointment status"><p>{summary.data.upcoming} coming up · {summary.data.needsReschedule} need a new time · {summary.data.unsentOverAnHour} messages waiting over an hour.</p></section>}
          <section className="card" aria-label="Diaries">
            <h2>Diaries</h2>
            {diaries.data && (diaries.data.length === 0 ? <p className="muted">No diary yet.</p> : (
              <ul>{diaries.data.map((d) => <li key={d.id}><button className="link" onClick={() => setDiaryId(d.id)} aria-current={diaryId === d.id}>{d.name}</button> · {d.kind === 'group' ? `group of ${d.members}` : d.officer_ref} · {d.time_zone}</li>)}</ul>
            ))}
            <Field label="New officer diary"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" /></Field>
            <Field label="Officer reference" help="The client's own reference, never a phone number."><input value={officerRef} onChange={(e) => setOfficerRef(e.target.value)} /></Field>
            <Errors error={act.error} />
            <div><button disabled={act.pending || !name || !officerRef} onClick={async () => { if (await act.run(() => api('POST', `/internal/tenants/${tenantId}/diaries`, { name, kind: 'individual', officerRef, timeZone: 'Asia/Kuala_Lumpur' }))) { setName(''); setOfficerRef(''); reload(); } }}>Create diary</button></div>
          </section>
          {diaryId && (
            <section className="card" aria-label="Agenda">
              <h2>Agenda</h2>
              <Field label="Day"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
              {agenda.data && (agenda.data.length === 0 ? <p className="muted">Nothing booked.</p> : (
                <table>
                  <thead><tr><th>When</th><th>Customer</th><th>Where</th><th>Status</th><th /></tr></thead>
                  <tbody>{agenda.data.map((a) => (
                    <tr key={a.id}>
                      <td>{fmtDate(a.starts_at)}</td><td>{a.contact_ref}</td>
                      <td>{a.kind === 'at_location' ? a.location : `Visit: ${a.visit_address} (${a.travel_minutes} min travel)`}</td>
                      <td>{STATUS[a.status] ?? a.status}{Number(a.fee) > 0 && <> · fee {fmtDecimal(a.fee)}</>}</td>
                      <td>{a.status === 'booked' && <>
                        <button className="link" disabled={act.pending} onClick={() => go(`/internal/appointments/${a.id}/delay`, { minutes: Number(delay) })}>Running late</button>{' '}
                        <button className="link" disabled={act.pending || !reason.trim()} onClick={() => go(`/internal/appointments/${a.id}/cancel`, { by: 'client', reason })}>Cancel</button>
                      </>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              ))}
              <Field label="Delay in minutes"><input value={delay} onChange={(e) => setDelay(e.target.value)} inputMode="numeric" /></Field>
              <Field label="Reason for cancelling" help="Needed to cancel. Never a phone number."><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            </section>
          )}
          <section className="card" aria-label="Messages to deliver">
            <h2>Messages to deliver</h2>
            {outbox.data && (outbox.data.length === 0 ? <p className="muted">Nothing waiting.</p> : (
              <table>
                <thead><tr><th>To</th><th>By</th><th>Message</th><th /></tr></thead>
                <tbody>{outbox.data.map((n) => (
                  <tr key={n.id}><td>{n.recipient_kind} {n.recipient_ref}</td><td>{n.channel}</td><td>{n.body}</td>
                    <td><button className="link" disabled={act.pending} onClick={() => go(`/internal/notifications/${n.id}/mark`, { status: 'sent' })}>Mark sent</button></td></tr>
                ))}</tbody>
              </table>
            ))}
          </section>
        </>
      )}
    </>
  );
}
