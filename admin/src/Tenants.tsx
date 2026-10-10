import { useState } from 'react';
import { api, type CreditSummary, type Project, type Tenant } from './api';
import { useClient, useClientList } from './client';
import { Errors, Field, fmtDecimal, useAction, useLoad } from './ui';

function TenantPanel({ tenant }: { tenant: Tenant }) {
  const projects = useLoad(() => api<Project[]>('GET', `/internal/tenants/${tenant.id}/projects`), [tenant.id]);
  const credits = useLoad(() => api<CreditSummary>('GET', `/internal/tenants/${tenant.id}/credits`), [tenant.id]);
  const [project, setProject] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('tenant_admin');
  const [issued, setIssued] = useState<{ email: string; token: string } | null>(null);
  const [kind, setKind] = useState('grant');
  const [amount, setAmount] = useState('');
  const projectAction = useAction();
  const userAction = useAction();
  const creditAction = useAction();

  return (
    <section className="card">
      <h2>{tenant.name}</h2>

      <h3>Credits</h3>
      <Errors error={credits.error} />
      {credits.data && <p><strong>{fmtDecimal(credits.data.balance)}</strong> credits</p>}
      <form className="grid" aria-label={`Credits for ${tenant.name}`} onSubmit={async (e) => {
        e.preventDefault();
        if (await creditAction.run(() => api('POST', `/internal/tenants/${tenant.id}/credits`, { kind, credits: amount }))) { setAmount(''); credits.reload(); }
      }}>
        <Field label="Type">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="grant">grant</option><option value="adjustment">adjustment</option><option value="usage">usage (negative)</option>
          </select>
        </Field>
        <Field label="Credits" help="Use a minus sign to deduct."><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required /></Field>
        <div><button type="submit" disabled={creditAction.pending}>Record</button></div>
      </form>
      <Errors error={creditAction.error} />

      <h3>Projects</h3>
      <Errors error={projects.error} />
      {projects.data && (projects.data.length === 0 ? <p className="muted">No projects yet.</p> : <ul>{projects.data.map((p) => <li key={p.id}>{p.name}</li>)}</ul>)}
      <form className="inline" aria-label={`Add project to ${tenant.name}`} onSubmit={async (e) => {
        e.preventDefault();
        if (await projectAction.run(() => api('POST', `/internal/tenants/${tenant.id}/projects`, { name: project }))) { setProject(''); projects.reload(); }
      }}>
        <Field label="New project or campaign"><input value={project} onChange={(e) => setProject(e.target.value)} required /></Field>
        <button type="submit" className="secondary" disabled={projectAction.pending}>Add</button>
      </form>
      <Errors error={projectAction.error} />

      <h3>Invite a user</h3>
      <form className="inline" aria-label={`Add user to ${tenant.name}`} onSubmit={async (e) => {
        e.preventDefault();
        const u = await userAction.run(() => api<{ email: string; token: string }>('POST', `/internal/tenants/${tenant.id}/users`, { email, role }));
        if (u) { setIssued({ email: u.email, token: u.token }); setEmail(''); }
      }}>
        <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label="Role">
          <select value={role} onChange={(e) => setRole(e.target.value)}><option value="tenant_admin">admin</option><option value="tenant_user">user</option></select>
        </Field>
        <button type="submit" className="secondary" disabled={userAction.pending}>Create user</button>
      </form>
      <Errors error={userAction.error} />
      {issued && (
        <div className="notice" role="status">
          API token for {issued.email}. Copy it now: it is shown once and cannot be recovered.
          <code>{issued.token}</code>
        </div>
      )}
    </section>
  );
}

export function Tenants() {
  const tenants = useLoad(() => api<Tenant[]>('GET', '/internal/tenants'));
  const [name, setName] = useState('');
  const [selected, setSelected] = useClient();
  const shared = useClientList();
  const { pending, error, run } = useAction();
  const current = tenants.data?.find((t) => t.id === selected);

  return (
    <>
      <h1>Clients</h1>
      <Errors error={tenants.error} />
      {tenants.data && (tenants.data.length === 0
        ? <p className="muted">No clients yet.</p>
        : <ul className="plain">{tenants.data.map((t) => (
            <li key={t.id}><button className="link" aria-pressed={t.id === selected} onClick={() => setSelected(t.id)}>{t.name}</button></li>
          ))}</ul>)}
      <form className="inline" aria-label="Add client" onSubmit={async (e) => {
        e.preventDefault();
        const t = await run(() => api<Tenant>('POST', '/internal/tenants', { name }));
        if (t) { setName(''); tenants.reload(); await shared.reload(); setSelected(t.id); }
      }}>
        <Field label="New client"><input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        <button type="submit" disabled={pending}>Add client</button>
      </form>
      <Errors error={error} />
      {current && <TenantPanel key={current.id} tenant={current} />}
    </>
  );
}
