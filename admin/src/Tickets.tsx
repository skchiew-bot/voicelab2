import { useState } from 'react';
import { api, type FaultRow, type TicketFull, type TicketRow } from './api';
import { Errors, Field, fmtDate, useAction, useLoad } from './ui';

const STATUS: Record<TicketRow['status'], string> = { open: 'Open', in_review: 'In review', resolved: 'Resolved' };

function Detail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const t = useLoad(() => api<TicketFull>('GET', `/internal/tickets/${id}`), [id]);
  const [note, setNote] = useState('');
  const [kind, setKind] = useState<'note' | 'council'>('note');
  const act = useAction();
  const d = t.data;
  if (!d) return <Errors error={t.error} />;
  const send = async (body: object) => { if (await act.run(() => api('POST', `/internal/tickets/${id}/events`, body))) { setNote(''); t.reload(); onChanged(); } };
  return (
    <section className="card" aria-label="Ticket">
      <h2>{d.kind === 'fault' ? 'System fault' : 'Escalation'} <span className={`badge ${d.status === 'resolved' ? 'ok' : 'bad'}`}>{STATUS[d.status]}</span></h2>
      <p><strong>Why:</strong> {d.reason}</p>
      <p><strong>The customer's view:</strong> {d.customer_view}</p>
      <h3>Automatic review</h3>
      {d.ai_reviews.map((r, i) => (
        <div key={i}>
          <p>{r.verdict}</p>
          <ul>{r.findings.map((f) => <li key={f.check}><strong>{f.check.replace(/_/g, ' ')}:</strong> {f.result}</li>)}</ul>
        </div>
      ))}
      <h3>Council notes</h3>
      {d.council_notes.notes.length === 0 ? <p className="muted">{d.council_notes.note ?? 'No council review yet.'}</p> : <ul>{d.council_notes.notes.map((n, i) => <li key={i}>{n.note} <span className="muted">{fmtDate(n.at)}</span></li>)}</ul>}
      <h3>Impact</h3>
      <p>{String(d.impact.note ?? '')}</p>
      <p className="muted">{String(d.impact.sameNodeLast30d)} at this step and {String(d.impact.allLast30d)} in all, of {String(d.impact.callsLast30d)} calls in the last 30 days.</p>
      <p>
        {d.call_id && <a href={`#/replay/call/${d.call_id}`}>Replay the call</a>}
        {!d.call_id && d.run_id && <a href={`#/replay/run/${d.run_id}`}>Replay the run</a>}
      </p>
      <h3>History</h3>
      {d.events.length === 0 ? <p className="muted">Nothing has happened to this ticket yet.</p> : <ul>{d.events.map((e) => <li key={e.id}>{fmtDate(e.at)}: {e.kind === 'status' ? `marked ${STATUS[e.status as TicketRow['status']].toLowerCase()}` : `${e.kind === 'council' ? 'council note' : 'note'}: ${e.note}`}</li>)}</ul>}
      <Errors error={act.error} />
      <div className="row">
        {(['open', 'in_review', 'resolved'] as const).filter((s) => s !== d.status).map((s) => <button key={s} className="secondary" disabled={act.pending} onClick={() => send({ kind: 'status', status: s })}>Mark {STATUS[s].toLowerCase()}</button>)}
      </div>
      <Field label="Add a note"><textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <div className="row">
        <select aria-label="Kind of note" value={kind} onChange={(e) => setKind(e.target.value as 'note' | 'council')}><option value="note">Note</option><option value="council">Council note</option></select>
        <button disabled={act.pending || !note.trim()} onClick={() => send({ kind, note })}>Add</button>
      </div>
    </section>
  );
}

export function Tickets() {
  const [status, setStatus] = useState('');
  const tickets = useLoad(() => api<TicketRow[]>('GET', `/internal/tickets${status ? `?status=${status}` : ''}`), [status]);
  const faults = useLoad(() => api<FaultRow[]>('GET', '/internal/faults?acknowledged=false'));
  const [open, setOpen] = useState<string | null>(null);
  const ack = useAction();

  return (
    <>
      <h1>Tickets</h1>
      <p className="muted">A ticket is opened for every call passed to a person, and for every call the system dropped, with the reason, the customer's side, what the automatic review found, and the impact.</p>
      <Errors error={tickets.error ?? faults.error} />
      <section className="card" aria-label="Dropped calls">
        <h2>Calls the system dropped</h2>
        {faults.data && (faults.data.length === 0 ? <p className="muted">No dropped calls waiting to be looked at.</p> : (
          <table>
            <thead><tr><th>When</th><th>Where</th><th>Why</th><th /></tr></thead>
            <tbody>{faults.data.map((f) => (
              <tr key={f.id}>
                <td>{fmtDate(f.fault_at)}</td><td>{f.ended_node ?? '—'}</td><td>{f.fault_reason}</td>
                <td><a href={`#/replay/call/${f.id}`}>Replay</a>{' '}
                  <button className="link" disabled={ack.pending} onClick={async () => { if (await ack.run(() => api('POST', `/internal/calls/${f.id}/fault-ack`, {}))) { faults.reload(); } }}>I've seen it</button></td>
              </tr>
            ))}</tbody>
          </table>
        ))}
        <Errors error={ack.error} />
      </section>

      <Field label="Show">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All tickets</option><option value="open">Open</option><option value="in_review">In review</option><option value="resolved">Resolved</option>
        </select>
      </Field>
      {tickets.data && (tickets.data.length === 0 ? <p className="muted">No tickets.</p> : (
        <table>
          <thead><tr><th>Opened</th><th>Kind</th><th>Where</th><th>Why</th><th>Status</th><th /></tr></thead>
          <tbody>{tickets.data.map((t) => (
            <tr key={t.id}>
              <td>{fmtDate(t.created_at)}</td><td>{t.kind === 'fault' ? 'System fault' : 'Escalation'}</td><td>{t.node ?? '—'}</td><td>{t.reason}</td>
              <td><span className={`badge ${t.status === 'resolved' ? 'ok' : 'bad'}`}>{STATUS[t.status]}</span></td>
              <td><button className="link" onClick={() => setOpen(open === t.id ? null : t.id)}>{open === t.id ? 'Close' : 'Open'}</button></td>
            </tr>
          ))}</tbody>
        </table>
      ))}
      {open && <Detail id={open} onChanged={tickets.reload} />}
    </>
  );
}
