import { useEffect, useState } from 'react';
import { Errors, Field, fmtDate, fmtDecimal, useAction, useLoad } from '../../admin/src/ui';
import { api, getToken, setToken, type CallRow, type Me, type Summary, type UserRow } from './api';

/** The client portal: a client's own credits and calls, and, for its admins, its own users. */

function SignIn({ onDone }: { onDone: (me: Me) => void }) {
  const [token, setLocal] = useState('');
  const act = useAction();
  return (
    <main className="login">
      <h1>Voice Lab</h1>
      <p className="muted">Sign in with the API token your organisation gave you.</p>
      <form onSubmit={async (e) => {
        e.preventDefault();
        setToken(token.trim());
        const me = await act.run(() => api<Me>('GET', '/client/me'));
        if (me) onDone(me); else setToken(null);
      }}>
        <Field label="API token"><input type="password" autoComplete="off" value={token} onChange={(e) => setLocal(e.target.value)} required /></Field>
        <Errors error={act.error} />
        <button type="submit" disabled={act.pending || !token.trim()}>Sign in</button>
      </form>
    </main>
  );
}

/** When the data on screen was fetched (lesson L-011). */
const asOf = (at: Date) => <p className="muted">As of {fmtDate(at.toISOString())}</p>;

function Overview() {
  const [at, setAt] = useState<Date | null>(null);
  const s = useLoad(() => api<Summary>('GET', '/client/summary').then((d) => { setAt(new Date()); return d; }));
  return (
    <>
      <h1>Overview</h1>
      <Errors error={s.error} />
      {s.data && !s.error && (
        <>
          {at && asOf(at)}
          <p aria-label="Balance"><strong>{fmtDecimal(s.data.balance)}</strong> credits</p>
          <h2>Last 30 days</h2>
          {s.data.last30Days.length === 0 ? <p className="muted">No calls in the last 30 days.</p> : (
            <table aria-label="Last 30 days">
              <thead><tr><th>Project</th><th className="num">Calls</th><th className="num">Answered</th><th className="num">Credits drawn</th></tr></thead>
              <tbody>{s.data.last30Days.map((r) => (
                <tr key={r.project_id ?? 'none'}><td>{r.project ?? 'No project'}</td><td className="num">{r.calls}</td><td className="num">{r.answered}</td><td className="num">{fmtDecimal(r.credits_drawn)}</td></tr>
              ))}</tbody>
            </table>
          )}
        </>
      )}
    </>
  );
}

function Calls() {
  const [pages, setPages] = useState<CallRow[][]>([]);
  const [next, setNext] = useState<string | null>(null);
  // Set once the first page has arrived: before that (loading, or failed) nothing is said about whether there are calls.
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  const act = useAction();
  const load = async (before: string | null) => {
    const r = await act.run(() => api<{ calls: CallRow[]; next: string | null }>('GET', `/client/calls?limit=50${before ? `&before=${before}` : ''}`));
    if (r) { setPages((p) => (before ? [...p, r.calls] : [r.calls])); setNext(r.next); if (!before) setLoadedAt(new Date()); }
  };
  useEffect(() => { void load(null); }, []);
  const rows = pages.flat();
  return (
    <>
      <h1>Calls</h1>
      <Errors error={act.error} />
      {loadedAt && asOf(loadedAt)}
      {!loadedAt ? null : rows.length === 0 ? <p className="muted">No calls yet.</p> : (
        <table aria-label="Calls">
          <thead><tr><th>Started</th><th>Project</th><th>Direction</th><th>Status</th><th>Outcome</th><th className="num">Seconds</th><th className="num">Credits</th></tr></thead>
          <tbody>{rows.map((c) => (
            <tr key={c.id}>
              <td>{fmtDate(c.started_at)}</td><td>{c.project ?? '—'}</td><td>{c.direction}</td><td>{c.status}</td><td>{c.outcome ?? '—'}</td>
              <td className="num">{c.duration_seconds ?? '—'}</td><td className="num">{fmtDecimal(c.credits_drawn)}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {next && <button className="secondary" disabled={act.pending} onClick={() => load(next)}>Show older</button>}
    </>
  );
}

function Users({ me }: { me: Me }) {
  const users = useLoad(() => api<UserRow[]>('GET', '/client/users'));
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('tenant_user');
  const [issued, setIssued] = useState<{ email: string; token: string } | null>(null);
  const add = useAction(); const off = useAction();
  return (
    <>
      <h1>Users</h1>
      <p className="muted">Admins can add and disable your organisation's users. A disabled user's token stops working at once, for good.</p>
      <Errors error={users.error ?? off.error} />
      {users.data && (
        <table aria-label="Users">
          <thead><tr><th>Email</th><th>Role</th><th>Status</th><th /></tr></thead>
          <tbody>{users.data.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td><td>{u.role === 'tenant_admin' ? 'Admin' : 'User'}</td>
              <td>{u.disabled_at ? `Disabled ${fmtDate(u.disabled_at)}` : 'Active'}</td>
              <td>{!u.disabled_at && u.email !== me.email && (
                <button className="secondary" disabled={off.pending} onClick={async () => {
                  if (!confirm(`Disable ${u.email}? Their token stops working at once, and this cannot be undone.`)) return;
                  if (await off.run(() => api('POST', `/client/users/${u.id}/disable`))) users.reload();
                }}>Disable</button>
              )}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <h2>Add a user</h2>
      <form className="inline" aria-label="Add a user" onSubmit={async (e) => {
        e.preventDefault();
        const u = await add.run(() => api<{ email: string; token: string }>('POST', '/client/users', { email, role }));
        if (u) { setIssued(u); setEmail(''); users.reload(); }
      }}>
        <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value)}><option value="tenant_user">User</option><option value="tenant_admin">Admin</option></select>
        </Field>
        <button type="submit" disabled={add.pending}>Add</button>
      </form>
      <Errors error={add.error} />
      {issued && <div className="notice" role="status">API token for {issued.email}. Copy it now: it is shown once and cannot be recovered.<code>{issued.token}</code></div>}
    </>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(Boolean(getToken()));
  const [tab, setTab] = useState<'overview' | 'calls' | 'users'>('overview');
  useEffect(() => {
    const out = () => setMe(null);
    addEventListener('portal:signed-out', out);
    return () => removeEventListener('portal:signed-out', out);
  }, []);
  useEffect(() => {
    if (!getToken()) return;
    api<Me>('GET', '/client/me').then(setMe, () => setToken(null)).finally(() => setChecking(false));
  }, []);
  if (checking) return <main className="login"><p className="muted">Loading…</p></main>;
  if (!me) return <SignIn onDone={setMe} />;
  const isAdmin = me.role === 'tenant_admin';
  return (
    <div className="shell">
      <nav>
        <strong>{me.client}</strong>
        <a href="#" aria-current={tab === 'overview' ? 'page' : undefined} onClick={(e) => { e.preventDefault(); setTab('overview'); }}>Overview</a>
        <a href="#" aria-current={tab === 'calls' ? 'page' : undefined} onClick={(e) => { e.preventDefault(); setTab('calls'); }}>Calls</a>
        {isAdmin && <a href="#" aria-current={tab === 'users' ? 'page' : undefined} onClick={(e) => { e.preventDefault(); setTab('users'); }}>Users</a>}
        <span className="spacer" />
        <span className="muted">{me.email} · {isAdmin ? 'Admin' : 'User'}</span>
        <button className="link" onClick={() => { setToken(null); setMe(null); }}>Sign out</button>
      </nav>
      <main>{tab === 'calls' ? <Calls /> : tab === 'users' && isAdmin ? <Users me={me} /> : <Overview />}</main>
    </div>
  );
}
