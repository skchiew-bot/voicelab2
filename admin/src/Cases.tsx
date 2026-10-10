import { useState } from 'react';
import { api, type CaseRow, type CasesSummary, type CaseView, type Tenant } from './api';
import { Errors, Field, fmtDate, fmtDecimal, useAction, useLoad } from './ui';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const STATUS = { open: 'Open', decision_required: 'Needs a decision', closed: 'Closed' } as const;

function Detail({ id, onChange }: { id: string; onChange: () => void }) {
  const v = useLoad(() => api<CaseView>('GET', `/internal/cases/${id}`), [id]);
  const act = useAction();
  const [at, setAt] = useState(''); const [amount, setAmount] = useState(''); const [dueOn, setDueOn] = useState(''); const [note, setNote] = useState('');
  const run = async (fn: () => Promise<unknown>) => { if (await act.run(fn) !== undefined) { v.reload(); onChange(); } };
  const c = v.data;
  if (!c) return <Errors error={v.error} />;
  return (
    <section className="card" aria-label="Case">
      <h2>{c.caseRef} · {STATUS[c.status]}{c.needsHuman && <> <span className="badge warn">needs a person</span></>}</h2>
      <p>Balance <strong>{fmtDecimal(c.balance)} {c.currency}</strong> of {fmtDecimal(c.openingBalance)} · paid {fmtDecimal(c.paidTotal)} · treatment <strong>{c.treatment.name}</strong> · {c.timeZone}</p>
      <p className="muted">What would be read back: {c.readBack}</p>
      {c.bestTimes.length > 0 && <p>Easiest to reach: {c.bestTimes.map((b) => `${DAYS[b.dow]} ${String(b.hour).padStart(2, '0')}:00 (${b.answered} of ${b.tried})`).join(', ')}</p>}
      <Errors error={act.error} />
      {c.status === 'decision_required' && (
        <div role="group" aria-label="Decision">
          <h3>This case cannot go on without a decision</h3>
          <Field label="Why" help="A reason is needed. Every decision is kept."><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          {(['continue', 'escalate', 'close'] as const).map((d) => (
            <button key={d} disabled={act.pending || !note.trim()} onClick={() => run(() => api('POST', `/internal/cases/${id}/decision`, { decision: d, note }))}>{d === 'continue' ? 'Carry on' : d === 'escalate' ? 'Pass to a person' : 'Close the case'}</button>
          ))}
        </div>
      )}
      {c.status === 'open' && (
        <>
          <h3>Promises</h3>
          {c.promises.length === 0 ? <p className="muted">No promise to pay yet.</p> : <ul>{c.promises.map((p) => <li key={p.id}>{fmtDecimal(p.amount)} {c.currency} by {p.due_on} · {p.status}</li>)}</ul>}
          <Field label="Promise amount"><input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></Field>
          <Field label="Due on" help="A date, YYYY-MM-DD."><input value={dueOn} onChange={(e) => setDueOn(e.target.value)} placeholder="2026-10-31" /></Field>
          <div><button disabled={act.pending} onClick={() => run(() => api('POST', `/internal/cases/${id}/promises`, { amount, dueOn }))}>Record promise</button></div>
          <Field label="Callback at" help="Locked to this time. It is placed within a few minutes of it, or not at all. Not inside the contact's quiet hours."><input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>
          <div>
            <button disabled={act.pending || !at} onClick={() => run(() => api('POST', `/internal/cases/${id}/callbacks`, { at: new Date(at).toISOString() }))}>Lock callback</button>{' '}
            <button className="link" disabled={act.pending} onClick={() => { const r = window.prompt('Why is this case being closed?'); if (r?.trim()) run(() => api('POST', `/internal/cases/${id}/close`, { reason: r })); }}>Close case</button>
          </div>
        </>
      )}
      <h3>Scheduled</h3>
      {c.actions.length === 0 ? <p className="muted">Nothing scheduled.</p> : (
        <table>
          <thead><tr><th>When</th><th>What</th><th>Channel</th><th>Status</th><th /></tr></thead>
          <tbody>{c.actions.map((a) => (
            <tr key={a.id}><td>{fmtDate(a.scheduled_for)}</td><td>{a.kind}{a.attempt > 1 ? ` (try ${a.attempt})` : ''}</td><td>{a.channel}</td><td>{a.status}{a.note && <span className="muted"> · {a.note}</span>}</td>
              <td>{a.status === 'pending' && (a.channel !== 'voice' || a.kind === 'handoff') && <button className="link" disabled={act.pending} onClick={() => run(() => api('POST', `/internal/case-actions/${a.id}/complete`, {}))}>Mark done</button>}</td></tr>
          ))}</tbody>
        </table>
      )}
      <h3>History</h3>
      <ol>{c.events.map((e) => <li key={e.id}><strong>{e.kind.replace(/[._]/g, ' ')}</strong> · {fmtDate(e.at)}</li>)}</ol>
    </section>
  );
}

export function Cases() {
  const tenants = useLoad(() => api<Tenant[]>('GET', '/internal/tenants'));
  const [tenantId, setTenantId] = useState(''); const [open, setOpen] = useState<string | null>(null);
  const cases = useLoad(() => (tenantId ? api<CaseRow[]>('GET', `/internal/tenants/${tenantId}/cases`) : Promise.resolve([])), [tenantId]);
  const summary = useLoad(() => (tenantId ? api<CasesSummary>('GET', `/internal/tenants/${tenantId}/cases-summary`) : Promise.resolve(null)), [tenantId]);
  const act = useAction();
  const [form, setForm] = useState({ caseRef: '', contactRef: '', phone: '', country: 'MY', currency: 'MYR', openingBalance: '', timeZone: 'Asia/Kuala_Lumpur' });
  const reload = () => { cases.reload(); summary.reload(); };
  const job = async (path: string) => { if (await act.run(() => api('POST', path, {}))) reload(); };

  return (
    <>
      <h1>Cases</h1>
      <p className="muted">A case follows one person's balance through callbacks, promises to pay, reminders and treatments until it is settled. A person is known by the client's own reference; the number is used to recognise them and is not kept.</p>
      <Errors error={tenants.error ?? cases.error ?? summary.error} />
      <Field label="Client">
        <select value={tenantId} onChange={(e) => { setTenantId(e.target.value); setOpen(null); }}>
          <option value="">Choose…</option>{tenants.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Field>
      {tenantId && (
        <>
          <section className="card" aria-label="Case status">
            <h2>Where things stand</h2>
            {summary.data && <p>{summary.data.open} open · {summary.data.decisionRequired} waiting for a decision · {summary.data.needsHuman} need a person · {summary.data.missedOrUnknown} missed or unknown in the last 7 days.</p>}
            <Errors error={act.error} />
            <div>
              <button disabled={act.pending} onClick={() => job('/internal/cases/dispatch')}>Place due calls now</button>{' '}
              <button disabled={act.pending} onClick={() => job(`/internal/tenants/${tenantId}/cases/check-payments`)}>Check payments</button>{' '}
              <button disabled={act.pending} onClick={() => job(`/internal/tenants/${tenantId}/cases/sweep-ageing`)}>Check case ages</button>
            </div>
          </section>
          <section className="card" aria-label="Cases list">
            <h2>Cases</h2>
            {cases.data && (cases.data.length === 0 ? <p className="muted">No cases yet.</p> : (
              <table>
                <thead><tr><th>Reference</th><th>Status</th><th>Balance</th><th>Treatment</th><th /></tr></thead>
                <tbody>{cases.data.map((r) => (
                  <tr key={r.id}><td>{r.case_ref}</td><td>{STATUS[r.status]}{r.needs_human && <> <span className="badge warn">person</span></>}</td>
                    <td>{fmtDecimal(r.opening_balance)} − {fmtDecimal(r.paid_total)} {r.currency}</td><td>{r.treatment}</td>
                    <td><button className="link" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide' : 'Open'}</button></td></tr>
                ))}</tbody>
              </table>
            ))}
          </section>
          {open && <Detail id={open} onChange={reload} />}
          <section className="card" aria-label="Open a case">
            <h2>Open a case</h2>
            {(['caseRef', 'contactRef', 'phone', 'country', 'currency', 'openingBalance', 'timeZone'] as const).map((k) => (
              <Field key={k} label={{ caseRef: 'Case reference', contactRef: 'Contact reference', phone: 'Phone number', country: 'Country', currency: 'Currency', openingBalance: 'Opening balance', timeZone: 'Time zone' }[k]}
                help={k === 'phone' ? 'International format. Used once to recognise the person; only a keyed hash is kept.' : k === 'caseRef' || k === 'contactRef' ? "The client's own reference, never a phone number." : undefined}>
                <input value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
              </Field>
            ))}
            <div><button disabled={act.pending} onClick={async () => { if (await act.run(() => api('POST', `/internal/tenants/${tenantId}/cases`, { ...form, contactRef: form.contactRef || undefined }))) { setForm({ ...form, caseRef: '', contactRef: '', phone: '', openingBalance: '' }); reload(); } }}>Open case</button></div>
          </section>
        </>
      )}
    </>
  );
}
