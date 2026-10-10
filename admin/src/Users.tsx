import { useState } from 'react';
import { api } from './api';
import { Errors, Field, fmtDate, useAction, useLoad } from './ui';

interface UserRow { id: string; email: string; role: string; tenant_id: string | null; tenant: string | null; created_at: string; disabled_at: string | null; pending_approval: boolean }

const ROLE: Record<string, string> = {
  internal_admin: 'Staff admin', internal_viewer: 'Staff, read only', tenant_admin: 'Client admin', tenant_user: 'Client user',
};

/** Who can sign in. Client users are invited from the Clients screen; staff are added here. */
export function Users() {
  const users = useLoad(() => api<UserRow[]>('GET', '/internal/users'));
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('internal_viewer');
  const [issued, setIssued] = useState<{ email: string; token: string; pendingApproval: boolean } | null>(null);
  const add = useAction();
  const off = useAction();
  const approve = useAction();

  return (
    <>
      <h1>Users</h1>
      <p className="muted">Staff admins can change anything. A new admin can sign in only after a different admin approves them, so nobody can make a second identity to approve their own changes. Read-only staff can open every screen but change nothing. A disabled user's token stops working at once, for good: to let them back in, add them again.</p>
      <Errors error={users.error ?? off.error ?? approve.error} />
      {users.data && (
        <table>
          <thead><tr><th>Email</th><th>Role</th><th>Client</th><th>Added</th><th>Status</th><th /></tr></thead>
          <tbody>{users.data.map((u) => (
            <tr key={u.id}>
              <td>{u.email}</td><td>{ROLE[u.role] ?? u.role}</td><td>{u.tenant ?? '—'}</td><td>{fmtDate(u.created_at)}</td>
              <td>{u.disabled_at ? `Disabled ${fmtDate(u.disabled_at)}` : u.pending_approval ? 'Waiting for another admin to approve' : 'Active'}</td>
              <td>{!u.disabled_at && u.pending_approval && (
                <button disabled={approve.pending} onClick={async () => { if (await approve.run(() => api('POST', `/internal/users/${u.id}/approve`))) users.reload(); }}>Approve</button>
              )}{' '}{!u.disabled_at && (
                <button className="secondary" disabled={off.pending} onClick={async () => {
                  if (!confirm(`Disable ${u.email}? Their token stops working at once, and this cannot be undone.`)) return;
                  if (await off.run(() => api('POST', `/internal/users/${u.id}/disable`))) users.reload();
                }}>Disable</button>
              )}</td>
            </tr>
          ))}</tbody>
        </table>
      )}

      <h2>Add staff</h2>
      <form className="inline" aria-label="Add staff" onSubmit={async (e) => {
        e.preventDefault();
        const u = await add.run(() => api<{ email: string; token: string; pendingApproval: boolean }>('POST', '/internal/staff', { email, role }));
        if (u) { setIssued({ email: u.email, token: u.token, pendingApproval: u.pendingApproval }); setEmail(''); users.reload(); }
      }}>
        <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="internal_viewer">{ROLE.internal_viewer}</option><option value="internal_admin">{ROLE.internal_admin}</option>
          </select>
        </Field>
        <button type="submit" disabled={add.pending}>Add</button>
      </form>
      <Errors error={add.error} />
      {issued && (
        <div className="notice" role="status">
          API token for {issued.email}. Copy it now: it is shown once and cannot be recovered.
          {issued.pendingApproval && ' It works once another admin (not you) approves this admin on this screen.'}
          <code>{issued.token}</code>
        </div>
      )}
    </>
  );
}
