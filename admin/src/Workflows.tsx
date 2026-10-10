import { useState } from 'react';
import { useClient } from './client';
import { api, type TemplateInfo, type Tenant, type WorkflowSummary } from './api';
import { Errors, Field, useAction, useLoad } from './ui';

const STARTER = JSON.stringify({
  start: 'hello', variables: ['name'],
  nodes: {
    hello: { type: 'speak', speech: 'hybrid', text: 'Hello {{name}}.', transitions: [{ to: 'done' }] },
    done: { type: 'end', outcome: 'finished' },
  },
}, null, 2);

export function Workflows() {
  const [client] = useClient();
  const list = useLoad(() => api<WorkflowSummary[]>('GET', '/internal/workflows'));
  const tenants = useLoad(() => api<Tenant[]>('GET', '/internal/tenants'));
  const templates = useLoad(() => api<TemplateInfo[]>('GET', '/internal/workflow-templates'));
  const tname = (id: string) => tenants.data?.find((t) => t.id === id)?.name ?? id.slice(0, 8);

  const [tplTenant, setTplTenant] = useState(client);
  const [tpl, setTpl] = useState('');
  const [prefix, setPrefix] = useState('');
  const fromTpl = useAction();
  const [created, setCreated] = useState<string | null>(null);

  const [tenant, setTenant] = useState(client);
  const [name, setName] = useState('');
  const [def, setDef] = useState(STARTER);
  const blank = useAction();
  const template = templates.data?.find((t) => t.key === tpl);

  return (
    <>
      <h1>Workflows</h1>
      <p className="muted">A workflow is the script of a call: what is said, what is listened for, and where the call goes next. Each saved version is kept; a version goes to staging, is simulated there, and only then goes to production.</p>
      <Errors error={list.error ?? tenants.error ?? templates.error} />
      {list.data && (list.data.length === 0 ? <p className="muted">No workflows yet.</p> : (
        <table>
          <thead><tr><th>Name</th><th>Client</th><th>Latest</th><th>Staging</th><th>Production</th></tr></thead>
          <tbody>{list.data.map((w) => (
            <tr key={w.id}>
              <td><a href={`#/workflows/${w.id}`}>{w.name}</a></td><td>{tname(w.tenant_id)}</td><td>{w.latest_version}</td>
              <td>{w.staging_version ?? <span className="muted">not live</span>}</td><td>{w.production_version ?? <span className="muted">not live</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      ))}

      <form className="card" aria-label="Start from a template" onSubmit={async (e) => {
        e.preventDefault();
        const r = await fromTpl.run(() => api<{ workflows: { name: string }[] }>('POST', `/internal/tenants/${tplTenant}/workflows/from-template`, { template: tpl, prefix: prefix || undefined }));
        if (r) { setCreated(`Created ${r.workflows.map((w) => w.name).join(', ')}.`); list.reload(); }
      }}>
        <h2>Start from a template</h2>
        <div className="grid">
          <Field label="Client">
            <select value={tplTenant} onChange={(e) => setTplTenant(e.target.value)} required>
              <option value="">Choose…</option>{tenants.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Template">
            <select value={tpl} onChange={(e) => setTpl(e.target.value)} required>
              <option value="">Choose…</option>{templates.data?.map((t) => <option key={t.key} value={t.key}>{t.title}</option>)}
            </select>
          </Field>
          <Field label="Name prefix (optional)" help="Put in front of each workflow's name."><input value={prefix} onChange={(e) => setPrefix(e.target.value)} /></Field>
        </div>
        {template && <p className="muted">{template.description} Creates: {template.workflows.map((w) => w.key).join(', ')}.</p>}
        <Errors error={fromTpl.error} />
        {created && <div className="notice ok" role="status">{created} Each is version 1.0 and not yet live.</div>}
        <div><button type="submit" disabled={fromTpl.pending}>Create from template</button></div>
      </form>

      <form className="card" aria-label="New workflow" onSubmit={async (e) => {
        e.preventDefault();
        let definition: unknown;
        try { definition = JSON.parse(def); } catch { blank.run(async () => { throw new Error('The definition is not valid JSON.'); }); return; }
        const r = await blank.run(() => api<{ workflow: { id: string } }>('POST', `/internal/tenants/${tenant}/workflows`, { name, definition }));
        if (r) location.hash = `#/workflows/${r.workflow.id}`;
      }}>
        <h2>New workflow from scratch</h2>
        <div className="grid">
          <Field label="Client">
            <select value={tenant} onChange={(e) => setTenant(e.target.value)} required>
              <option value="">Choose…</option>{tenants.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Name" help="Letters, digits, - and _."><input value={name} onChange={(e) => setName(e.target.value)} required /></Field>
        </div>
        <Field label="Definition (JSON)"><textarea rows={10} spellCheck={false} className="code" value={def} onChange={(e) => setDef(e.target.value)} /></Field>
        <Errors error={blank.error} />
        <div><button type="submit" className="secondary" disabled={blank.pending}>Create workflow</button></div>
      </form>
    </>
  );
}
