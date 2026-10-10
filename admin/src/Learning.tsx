import { useState } from 'react';
import { api, type LearningOverview, type Promotion, type PromotionEvent, type PromotionFinancial, type Tenant } from './api';
import { Errors, Field, fmtDate, fmtDecimal, useAction, useLoad } from './ui';

const STATUS: Record<Promotion['status'], string> = { in_review: 'Waiting for review', approved: 'Approved, waiting for audio', promoted: 'Promoted (pre-recorded)', demoted: 'Demoted (live again)', rejected: 'Turned down' };

function Money({ v }: { v: string | null }) { return <>{v === null ? 'not priced' : `USD ${fmtDecimal(v)}`}</>; }

function History({ id }: { id: string }) {
  const p = useLoad(() => api<Promotion & { events: PromotionEvent[] }>('GET', `/internal/promotions/${id}`), [id]);
  const f = useLoad(() => api<PromotionFinancial>('GET', `/internal/promotions/${id}/financial`).catch(() => null), [id]);
  return (
    <div>
      <Errors error={p.error} />
      {f.data && (
        <>
          <h3>Cost change</h3>
          <p>Each time this node is used, live speech falls from {f.data.perUse.liveBefore.chars} to {f.data.perUse.afterPromotion.chars} characters: a saving of <strong><Money v={f.data.perUse.saved.costUsd} /></strong> a use.
            Recording the fixed words costs <Money v={f.data.oneTime.costUsd} /> once{f.data.breakEvenUses !== null && <>, paid back after {f.data.breakEvenUses} use{f.data.breakEvenUses === 1 ? '' : 's'}</>}.
            It has been used {f.data.usesWhilePromoted} time{f.data.usesWhilePromoted === 1 ? '' : 's'} as a script, saving <Money v={f.data.realisedSavingUsd} />.</p>
          <p className="muted">{f.data.note}{f.data.ratesConfirmed === false ? ' The voice provider\'s rates are not confirmed yet.' : ''}</p>
        </>
      )}
      <h3>What happened</h3>
      <ol>{p.data?.events.map((e) => (
        <li key={e.id}>
          <strong>{e.kind.replace('_', ' ')}</strong> · {fmtDate(e.created_at)} · {e.reason}
          {Array.isArray(e.detail.replays) && (e.detail.replays as { runId: string; sentiment: number }[]).length > 0 && (
            <> · Listen: {(e.detail.replays as { runId: string; sentiment: number }[]).map((r, i) => <a key={r.runId} href={`#/replay/run/${r.runId}`}>{i ? ', ' : ''}call {i + 1} (mood {r.sentiment})</a>)}</>
          )}
        </li>
      ))}</ol>
    </div>
  );
}

export function Learning() {
  const tenants = useLoad(() => api<Tenant[]>('GET', '/internal/tenants'));
  const [tenantId, setTenantId] = useState('');
  const overview = useLoad(() => (tenantId ? api<LearningOverview>('GET', `/internal/tenants/${tenantId}/learning`) : Promise.resolve(null)), [tenantId]);
  const promos = useLoad(() => (tenantId ? api<Promotion[]>('GET', `/internal/tenants/${tenantId}/learning/promotions`) : Promise.resolve([])), [tenantId]);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const act = useAction();
  const reload = () => { overview.reload(); promos.reload(); };
  const call = async (path: string, body?: unknown) => { if (await act.run(() => api('POST', path, body ?? {}))) reload(); };

  return (
    <>
      <h1>Learning loop</h1>
      <p className="muted">A line the model writes again and again, in the same part of a call, is drawn up as one script, reviewed, recorded and played instead. If callers start reacting worse, the node goes back to live speech.</p>
      <Errors error={tenants.error ?? overview.error ?? promos.error} />
      <Field label="Client">
        <select value={tenantId} onChange={(e) => { setTenantId(e.target.value); setOpen(null); }}>
          <option value="">Choose…</option>{tenants.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Field>
      {tenantId && overview.data && (
        <>
          <section className="card" aria-label="Loop status">
            <h2>Where things stand</h2>
            <p>{overview.data.summary.promoted} promoted · {overview.data.summary.inReview} waiting for review · {overview.data.summary.approved} waiting for audio · {overview.data.summary.demoted} demoted · {overview.data.summary.rejected} turned down.</p>
            <Errors error={act.error} />
            <div>
              <button disabled={act.pending} onClick={() => call(`/internal/tenants/${tenantId}/learning/scan`, { review: true })}>Draw up scripts and send them to the councils</button>{' '}
              <button disabled={act.pending} onClick={() => call('/internal/learning/sweep')}>Check audio and drift now</button>
            </div>
          </section>

          <section className="card" aria-label="Clusters">
            <h2>Recurring lines</h2>
            <p className="muted">Each needs {overview.data.threshold} similar turns in one journey context before a script is drawn up.</p>
            {overview.data.clusters.length === 0 ? <p className="muted">No model-written lines logged yet.</p> : (
              <table>
                <thead><tr><th>Node</th><th>Context</th><th>Most common wording</th><th>Turns</th><th>Of threshold</th></tr></thead>
                <tbody>{overview.data.clusters.map((k, i) => (
                  <tr key={i}><td>{k.workflow} / {k.node}</td><td>{k.context}</td><td>{k.script}</td><td>{k.support} ({k.variants} wording{k.variants === 1 ? '' : 's'})</td><td>{k.percentOfThreshold}%{k.ready && <> <span className="badge ok">ready</span></>}</td></tr>
                ))}</tbody>
              </table>
            )}
          </section>

          <section className="card" aria-label="Scripts">
            <h2>Scripts</h2>
            {promos.data && (promos.data.length === 0 ? <p className="muted">No script has been drawn up yet.</p> : promos.data.map((p) => (
              <div key={p.id} className="card" aria-label={`Script for ${p.node}`}>
                <p><strong>{p.workflow} / {p.node}</strong> · {STATUS[p.status]} · {p.support} turns · written by {p.distilled_by}</p>
                <blockquote>{p.script}</blockquote>
                <div>
                  <button className="link" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? 'Hide history' : 'History and cost'}</button>
                  {p.status === 'in_review' && <>
                    {' '}<button disabled={act.pending} onClick={() => call(`/internal/promotions/${p.id}/review`)}>Ask the councils</button>
                    {' '}<button disabled={act.pending} onClick={() => call(`/internal/promotions/${p.id}/decision`, { decision: 'approved', note: note || undefined })}>Approve</button>
                    {' '}<button disabled={act.pending || !note.trim()} onClick={() => call(`/internal/promotions/${p.id}/decision`, { decision: 'rejected', note })}>Turn down</button>
                  </>}
                  {p.status === 'approved' && <>{' '}<button disabled={act.pending} onClick={() => call(`/internal/promotions/${p.id}/audio`)}>Check audio</button></>}
                  {p.status === 'promoted' && <>
                    {' '}<button disabled={act.pending} onClick={() => call(`/internal/promotions/${p.id}/drift-check`)}>Check for drift</button>
                    {' '}<button disabled={act.pending || !note.trim()} onClick={() => call(`/internal/promotions/${p.id}/demote`, { reason: note })}>Demote</button>
                  </>}
                </div>
                {open === p.id && <History id={p.id} />}
              </div>
            )))}
            <Field label="Note" help="A reason is needed to turn a script down or to demote one."><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          </section>
        </>
      )}
    </>
  );
}
