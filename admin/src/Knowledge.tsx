import { useState } from 'react';
import { api, type KnowledgeArticle, type KnowledgeRow, type PolicyOverview, type PolicyVersion, type Tenant } from './api';
import { Errors, Field, useAction, useLoad } from './ui';

const STARTER = JSON.stringify([
  { id: 'no_waiver', kind: 'action', action: 'waive_fee', effect: 'deny', message: 'Only a person may waive a fee.' },
  { id: 'discount', kind: 'action', action: 'offer_discount', effect: 'allow', limit: { variable: 'discount_percent', max: '10' } },
  { id: 'wording', kind: 'must_not_say', phrases: ['legal action'], message: 'Never threaten.' },
], null, 2);

function ArticleDetail({ id, onChange }: { id: string; onChange: () => void }) {
  const a = useLoad(() => api<KnowledgeArticle>('GET', `/internal/knowledge/${id}`), [id]);
  const act = useAction();
  const [title, setTitle] = useState(''); const [body, setBody] = useState(''); const [note, setNote] = useState('');
  const go = async (fn: () => Promise<unknown>) => { if (await act.run(fn) !== undefined) { a.reload(); onChange(); } };
  if (!a.data) return <Errors error={a.error} />;
  return (
    <section className="card" aria-label="Article">
      <h2>{a.data.slug} ({a.data.language}){a.data.retiredAt && <> <span className="badge warn">retired</span></>}</h2>
      <Errors error={act.error} />
      <ol>{a.data.versions.map((v) => (
        <li key={v.id}><strong>Version {v.version}</strong> · {v.status}{v.review_note && ` · ${v.review_note}`}<br /><span className="muted">{v.title}: {v.body}</span>
          {v.status === 'draft' && <><br /><button className="link" disabled={act.pending} onClick={() => go(() => api('POST', `/internal/knowledge-versions/${v.id}/publish`, {}))}>Publish</button>{' '}
            <button className="link" disabled={act.pending || !note.trim()} onClick={() => go(() => api('POST', `/internal/knowledge-versions/${v.id}/reject`, { note }))}>Turn down</button></>}
        </li>
      ))}</ol>
      {!a.data.retiredAt && <>
        <Field label="Reason for turning down" help="Needed to turn a draft down."><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <Field label="New version title"><input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
        <Field label="New version text"><textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
        <div><button disabled={act.pending || !title || !body} onClick={() => go(() => api('POST', `/internal/knowledge/${id}/versions`, { title, body }))}>Write a new version</button>{' '}
          <button className="link" disabled={act.pending} onClick={() => go(() => api('POST', `/internal/knowledge/${id}/retire`, {}))}>Retire article</button></div>
      </>}
    </section>
  );
}

function PolicyCard({ v, onChange }: { v: PolicyVersion; onChange: () => void }) {
  const act = useAction(); const [note, setNote] = useState('');
  const go = async (path: string, body?: unknown) => { if (await act.run(() => api('POST', path, body ?? {}))) onChange(); };
  return (
    <div className="card" aria-label={`Policy ${v.version}`}>
      <p><strong>Version {v.version}</strong> · {v.status} · {v.summary}</p>
      <ul>{v.diff.map((d, i) => <li key={i}>{d}</li>)}</ul>
      <p>{v.progress.map((p) => `${p.name}: ${p.decision ?? 'waiting'}`).join(' · ')}</p>
      <Errors error={act.error} />
      {v.status === 'pending' && <>
        <Field label="Note" help="A reason is needed to turn a change down."><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <button disabled={act.pending} onClick={() => go(`/internal/policy-versions/${v.id}/decision`, { decision: 'approved', note: note || undefined })}>Approve this level</button>{' '}
        <button disabled={act.pending || !note.trim()} onClick={() => go(`/internal/policy-versions/${v.id}/decision`, { decision: 'rejected', note })}>Turn down</button>
      </>}
      {v.status === 'approved' && <button disabled={act.pending} onClick={() => go(`/internal/policy-versions/${v.id}/activate`)}>Put live</button>}
      {(v.status === 'pending' || v.status === 'approved') && <>{' '}<button disabled={act.pending || !note.trim()} onClick={() => go(`/internal/policy-versions/${v.id}/withdraw`, { note })}>Withdraw</button></>}
    </div>
  );
}

export function Knowledge() {
  const tenants = useLoad(() => api<Tenant[]>('GET', '/internal/tenants'));
  const [tenantId, setTenantId] = useState(''); const [open, setOpen] = useState<string | null>(null);
  const articles = useLoad(() => (tenantId ? api<KnowledgeRow[]>('GET', `/internal/tenants/${tenantId}/knowledge`) : Promise.resolve([])), [tenantId]);
  const policy = useLoad(() => (tenantId ? api<PolicyOverview>('GET', `/internal/tenants/${tenantId}/policy`) : Promise.resolve(null)), [tenantId]);
  const act = useAction(); const pol = useAction();
  const [slug, setSlug] = useState(''); const [title, setTitle] = useState(''); const [body, setBody] = useState('');
  const [levels, setLevels] = useState('Policy owner, Compliance'); const [rules, setRules] = useState(STARTER); const [summary, setSummary] = useState('');
  const [q, setQ] = useState(''); const [found, setFound] = useState<{ slug: string; text: string }[] | null>(null);
  const [action, setAction] = useState('waive_fee'); const [verdict, setVerdict] = useState<{ allowed: boolean; reason: string } | null>(null);
  const reload = () => { articles.reload(); policy.reload(); };

  return (
    <>
      <h1>Knowledge and policy</h1>
      <p className="muted">Knowledge informs the bot; policy governs what it may do and say. A knowledge change needs one reviewer. A policy change needs every approval level, each from a different person, and someone other than its proposer puts it live.</p>
      <Errors error={tenants.error ?? articles.error ?? policy.error} />
      <Field label="Client">
        <select value={tenantId} onChange={(e) => { setTenantId(e.target.value); setOpen(null); setFound(null); setVerdict(null); }}>
          <option value="">Choose…</option>{tenants.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Field>
      {tenantId && (
        <>
          <section className="card" aria-label="Articles">
            <h2>Knowledge</h2>
            {articles.data && (articles.data.length === 0 ? <p className="muted">No article yet.</p> : (
              <table>
                <thead><tr><th>Article</th><th>Published</th><th>Drafts</th><th /></tr></thead>
                <tbody>{articles.data.map((a) => (
                  <tr key={a.id}><td>{a.slug} ({a.language}){a.retired_at && ' · retired'}<br /><span className="muted">{a.title}</span></td><td>{a.published_version ? `version ${a.published_version}` : 'none'}</td><td>{a.drafts}</td>
                    <td><button className="link" onClick={() => setOpen(open === a.id ? null : a.id)}>{open === a.id ? 'Hide' : 'Open'}</button></td></tr>
                ))}</tbody>
              </table>
            ))}
            <Errors error={act.error} />
            <Field label="Article name" help="Lower case, e.g. late-fees."><input value={slug} onChange={(e) => setSlug(e.target.value)} /></Field>
            <Field label="Title"><input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
            <Field label="Text" help="Never a phone number."><textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
            <div><button disabled={act.pending || !slug || !title || !body} onClick={async () => { if (await act.run(() => api('POST', `/internal/tenants/${tenantId}/knowledge`, { slug, title, body }))) { setSlug(''); setTitle(''); setBody(''); reload(); } }}>Write article</button></div>
            <Field label="Ask the knowledge base"><input value={q} onChange={(e) => setQ(e.target.value)} /></Field>
            <div><button disabled={!q.trim()} onClick={async () => setFound(await api<{ slug: string; text: string }[]>('GET', `/internal/tenants/${tenantId}/knowledge/search?q=${encodeURIComponent(q)}&channel=voice`))}>Search as a call would hear it</button></div>
            {found && <ul aria-label="Search results">{found.length === 0 ? <li className="muted">Nothing published matches.</li> : found.map((f) => <li key={f.slug}><strong>{f.slug}</strong>: {f.text}</li>)}</ul>}
          </section>
          {open && <ArticleDetail id={open} onChange={reload} />}

          <section className="card" aria-label="Policy">
            <h2>Policy</h2>
            {policy.data && <>
              <p>Approval levels: {policy.data.levels.length ? policy.data.levels.join(' → ') : 'not set up'}</p>
              {policy.data.live ? <PolicyCard v={policy.data.live} onChange={reload} /> : <p className="muted">No policy is in force, so the bot is not allowed to do anything that depends on one.</p>}
              {policy.data.pending && <PolicyCard v={policy.data.pending} onChange={reload} />}
            </>}
            <Errors error={pol.error} />
            <Field label="Approval levels" help="At least two, in order, separated by commas."><input value={levels} onChange={(e) => setLevels(e.target.value)} /></Field>
            <div><button disabled={pol.pending} onClick={async () => { if (await pol.run(() => api('PUT', `/internal/tenants/${tenantId}/policy/levels`, { levels: levels.split(',').map((l) => l.trim()).filter(Boolean) }))) reload(); }}>Save levels</button></div>
            <Field label="Rules (JSON)" help="Action rules allow or deny what the bot may do (with a condition or a limit); must_not_say rules list words it may never say."><textarea rows={10} spellCheck={false} className="code" value={rules} onChange={(e) => setRules(e.target.value)} /></Field>
            <Field label="Why"><input value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
            <div><button disabled={pol.pending || !summary.trim()} onClick={async () => {
              let parsed: unknown;
              try { parsed = JSON.parse(rules); } catch { pol.run(async () => { throw new Error('The rules are not valid JSON.'); }); return; }
              if (await pol.run(() => api('POST', `/internal/tenants/${tenantId}/policy/proposals`, { rules: parsed, summary }))) { setSummary(''); reload(); }
            }}>Propose this policy</button></div>
            <Field label="Ask the policy: may the bot…"><input value={action} onChange={(e) => setAction(e.target.value)} /></Field>
            <div><button disabled={!action.trim()} onClick={async () => setVerdict(await api<{ allowed: boolean; reason: string }>('POST', `/internal/tenants/${tenantId}/policy/check`, { action }))}>Check</button></div>
            {verdict && <div role="status" className={`notice ${verdict.allowed ? 'ok' : ''}`}>{verdict.allowed ? 'Allowed' : 'Not allowed'}: {verdict.reason}</div>}
          </section>
        </>
      )}
    </>
  );
}
