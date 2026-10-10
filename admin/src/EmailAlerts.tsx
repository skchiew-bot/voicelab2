import { useState } from 'react';
import { api } from './api';
import { Errors, Field, fmtDate, useAction, useLoad } from './ui';

interface Sub { userId: string; email: string; minSeverity: 'high' | 'medium' | 'low'; codes: string[] | null }
interface Delivery { id: number; email: string; kind: string; status: string; detail: string | null; alertKey: string; createdAt: string }
interface User { id: string; email: string; role: string; disabled_at: string | null; pending_approval: boolean }
const TEST_RESULT: Record<string, string> = {
  sent: 'The test email was accepted by the mail service.', failed: 'The mail service refused the test email.',
  unknown: 'The mail service gave no clear answer; the test email may not have arrived.', no_mail_service: 'Not sent: no mail service is connected yet.',
};
const STATUS: Record<string, [string, string]> = {
  sent: ['sent', 'badge ok'], failed: ['refused', 'badge bad'], unknown: ['outcome unknown', 'badge warn'],
  no_mail_service: ['not sent: no mail service', 'badge warn'], sending: ['sending', 'badge'],
};

/** Who gets Control Tower alerts by email, and every email sent. Admins change the list; anyone on staff can see it. */
export function EmailAlerts() {
  const subs = useLoad(() => api<Sub[]>('GET', '/internal/alerts/subscriptions'));
  const sent = useLoad(() => api<Delivery[]>('GET', '/internal/alerts/deliveries'));
  const users = useLoad(() => api<User[]>('GET', '/internal/users').catch(() => [] as User[]));   // admins only; others just see the list
  const act = useAction();
  const [userId, setUserId] = useState('');
  const [minSeverity, setMin] = useState<'high' | 'medium' | 'low'>('high');
  const [note, setNote] = useState<string | null>(null);
  const isAdmin = (users.data ?? []).length > 0;          // the user list answers admins only
  const staff = (users.data ?? []).filter((u) => (u.role === 'internal_admin' || u.role === 'internal_viewer') && !u.disabled_at && !u.pending_approval);
  const reload = () => { subs.reload(); sent.reload(); };
  const run = async (fn: () => Promise<unknown>, done: string) => { setNote(null); if (await act.run(fn)) { setNote(done); reload(); } };

  return (
    <section className="card" aria-label="Email alerts">
      <h2>Email alerts</h2>
      <p className="muted">Each person gets one email when an alert first appears (or comes back after clearing), not a reminder every sweep. Only staff can be added: alerts name providers, costs and funding.</p>
      {subs.data && (subs.data.length === 0 ? <p className="muted">Nobody gets alerts by email yet.</p> : (
        <table aria-label="Subscribers">
          <thead><tr><th>Who</th><th>Alerts</th><th /></tr></thead>
          <tbody>{subs.data.map((s) => (
            <tr key={s.userId}>
              <td>{s.email}</td>
              <td>{s.minSeverity === 'low' ? 'all' : s.minSeverity === 'medium' ? 'medium and high' : 'high only'}{s.codes ? ` (${s.codes.join(', ')})` : ''}</td>
              <td>{isAdmin && <>
                <button className="link" disabled={act.pending} onClick={async () => {
                  setNote(null);
                  const r = await act.run(() => api<{ status: string }>('POST', `/internal/alerts/subscriptions/${s.userId}/test`));
                  if (r) { setNote(TEST_RESULT[r.status] ?? r.status); reload(); }
                }}>Send a test</button>{' '}
                <button className="link" disabled={act.pending} onClick={() => run(() => api('POST', `/internal/alerts/subscriptions/${s.userId}/end`), `${s.email} no longer gets alerts.`)}>Stop</button>
              </>}</td>
            </tr>
          ))}</tbody>
        </table>
      ))}
      {staff.length > 0 && (
        <>
          <Field label="Person"><select aria-label="Person" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Choose…</option>{staff.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
          </select></Field>
          <Field label="Which alerts"><select aria-label="Which alerts" value={minSeverity} onChange={(e) => setMin(e.target.value as 'high' | 'medium' | 'low')}>
            <option value="high">High only</option><option value="medium">Medium and high</option><option value="low">All</option>
          </select></Field>
          <button disabled={act.pending || !userId} onClick={() => run(() => api('PUT', '/internal/alerts/subscriptions', { userId, minSeverity }), 'Saved.')}>Get alerts by email</button>
        </>
      )}
      <Errors error={act.error ?? subs.error ?? sent.error} />
      {note && <div className="notice ok" role="status">{note}</div>}
      {sent.data && sent.data.length > 0 && (
        <details>
          <summary>Recent emails</summary>
          <table aria-label="Recent emails">
            <thead><tr><th>When</th><th>To</th><th>What</th><th>Result</th></tr></thead>
            <tbody>{sent.data.slice(0, 30).map((d) => (
              <tr key={d.id}><td>{fmtDate(d.createdAt)}</td><td>{d.email}</td><td>{d.kind === 'test' ? 'test' : d.alertKey.split('|')[0]!.replace(/_/g, ' ')}</td>
                <td><span className={(STATUS[d.status] ?? [d.status, 'badge'])[1]}>{(STATUS[d.status] ?? [d.status])[0]}</span></td></tr>
            ))}</tbody>
          </table>
        </details>
      )}
    </section>
  );
}
