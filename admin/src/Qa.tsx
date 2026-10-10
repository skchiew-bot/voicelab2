import { useState } from 'react';
import { api, type AiUsage, type QaScore, type QaSet, type QaSummary, type Tenant } from './api';
import { Errors, Field, fmtDate, useAction, useLoad } from './ui';

const STARTER = JSON.stringify([
  { id: 'intro', label: 'Introduced Voice Lab', type: 'must_say', phrases: ['voice lab'], weight: 2 },
  { id: 'outcome', label: 'Reached a promise to pay', type: 'outcome_in', outcomes: ['paid_promise'], weight: 5 },
  { id: 'calm', label: 'Was not passed to a person', type: 'no_escalation', weight: 3 },
], null, 2);

export function Qa() {
  const tenants = useLoad(() => api<Tenant[]>('GET', '/internal/tenants'));
  const [tenantId, setTenantId] = useState('');
  const sets = useLoad(() => (tenantId ? api<QaSet[]>('GET', `/internal/tenants/${tenantId}/qa-criteria`) : Promise.resolve([])), [tenantId]);
  const scores = useLoad(() => (tenantId ? api<QaScore[]>('GET', `/internal/qa/scores?tenantId=${tenantId}`) : Promise.resolve([])), [tenantId]);
  const summary = useLoad(() => (tenantId ? api<QaSummary>('GET', `/internal/tenants/${tenantId}/qa/summary`) : Promise.resolve(null)), [tenantId]);
  const usage = useLoad(() => api<AiUsage[]>('GET', `/internal/ai-usage${tenantId ? `?tenantId=${tenantId}` : ''}`), [tenantId]);
  const [useCase, setUseCase] = useState('*');
  const [text, setText] = useState(STARTER);
  const [result, setResult] = useState<{ scored: number; skipped: number; usedModel: boolean } | null>(null);
  const save = useAction(); const score = useAction();
  const reloadAll = () => { sets.reload(); scores.reload(); summary.reload(); usage.reload(); };

  return (
    <>
      <h1>Call quality</h1>
      <p className="muted">Every finished call is scored against the client's criteria, in batches after the call. Rules decide what they can (free, and the same every time). Only a question of judgement goes to a model, the smallest that will do, and a doubtful answer goes up one tier.</p>
      <Errors error={tenants.error ?? sets.error ?? scores.error ?? summary.error} />
      <Field label="Client">
        <select value={tenantId} onChange={(e) => { setTenantId(e.target.value); setResult(null); }}>
          <option value="">Choose…</option>{tenants.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Field>
      {tenantId && (
        <>
          <section className="card" aria-label="Scoring">
            <h2>Scoring</h2>
            {summary.data && <p>{summary.data.unscored} finished call{summary.data.unscored === 1 ? '' : 's'} not scored yet.</p>}
            <Errors error={score.error} />
            <div><button disabled={score.pending} onClick={async () => { const r = await score.run(() => api<{ scored: number; skipped: number; usedModel: boolean }>('POST', `/internal/tenants/${tenantId}/qa/score`, {})); if (r) { setResult(r); reloadAll(); } }}>Score finished calls</button></div>
            {result && <div role="status" className="notice ok">Scored {result.scored}{result.skipped ? `, left ${result.skipped} that have no criteria` : ''}. {result.usedModel ? 'A model judged the questions of judgement.' : 'No model is set up, so only the rules were applied.'}</div>}
          </section>

          {summary.data && summary.data.byWorkflow.length > 0 && (
            <section className="card" aria-label="Scores by workflow">
              <h2>By workflow</h2>
              <table>
                <thead><tr><th>Workflow</th><th>Calls scored</th><th>Average</th><th>Lowest</th></tr></thead>
                <tbody>{summary.data.byWorkflow.map((w) => <tr key={w.workflow}><td>{w.workflow}</td><td>{w.scored}</td><td>{w.average}</td><td>{w.lowest}</td></tr>)}</tbody>
              </table>
              {summary.data.mostFailed.length > 0 && <><h3>What fails most</h3><ul>{summary.data.mostFailed.map((m) => <li key={m.criterion}>{m.label}: failed on {m.failed} call{m.failed === 1 ? '' : 's'}</li>)}</ul></>}
            </section>
          )}

          <section className="card" aria-label="Recent scores">
            <h2>Recent scores</h2>
            {scores.data && (scores.data.length === 0 ? <p className="muted">Nothing scored yet.</p> : (
              <table>
                <thead><tr><th>When</th><th>Workflow</th><th>Score</th><th>Criteria</th><th>Scored by</th><th /></tr></thead>
                <tbody>{scores.data.map((s) => (
                  <tr key={s.id}>
                    <td>{fmtDate(s.created_at)}</td><td>{s.workflow}</td>
                    <td><strong>{Number(s.score)}</strong>{!s.results.complete && <> <span className="badge warn">incomplete</span></>}</td>
                    <td>{s.use_case} v{s.criteria_version}<ul>{s.results.results.filter((r) => r.passed === false).map((r) => <li key={r.id}>{r.label}: {r.detail}</li>)}</ul></td>
                    <td>{s.model ? `${s.model}${s.escalated_from ? ` (after ${s.escalated_from})` : ''}` : 'rules'}</td>
                    <td><a href={`#/replay/run/${s.run_id}`}>Replay</a></td>
                  </tr>
                ))}</tbody>
              </table>
            ))}
          </section>

          <section className="card" aria-label="Criteria">
            <h2>Criteria</h2>
            {sets.data && sets.data.map((s) => (
              <p key={s.id}><strong>{s.use_case === '*' ? 'Every workflow' : s.use_case}</strong> · version {s.version} · {s.criteria.map((c) => `${c.label} (${c.weight})`).join(', ')}</p>
            ))}
            <Field label="Use case" help="A workflow's name, or * for every workflow without a set of its own."><input value={useCase} onChange={(e) => setUseCase(e.target.value)} /></Field>
            <Field label="Criteria (JSON)" help="Types: adherence_min, outcome_in, no_escalation, no_fault, must_say, must_not_say, max_latency_ms, sentiment_not_worse, max_misunderstood, judge. Saving makes a new version; older scores keep the version they used.">
              <textarea rows={10} spellCheck={false} className="code" value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
            <Errors error={save.error} />
            <div><button disabled={save.pending} onClick={async () => {
              let criteria: unknown;
              try { criteria = JSON.parse(text); } catch { save.run(async () => { throw new Error('The criteria are not valid JSON.'); }); return; }
              if (await save.run(() => api('POST', `/internal/tenants/${tenantId}/qa-criteria`, { useCase, criteria }))) reloadAll();
            }}>Save criteria</button></div>
          </section>
        </>
      )}

      <section className="card" aria-label="AI usage">
        <h2>What the AI steps used</h2>
        {usage.data && (usage.data.length === 0 ? <p className="muted">No AI step has run yet.</p> : (
          <table>
            <thead><tr><th>Task</th><th>Model</th><th>Tier</th><th>Decisions</th><th>Tokens in / out</th><th>Turned down</th><th>Tidied</th><th>Stepped up</th></tr></thead>
            <tbody>{usage.data.map((u, i) => <tr key={i}><td>{u.task}</td><td>{u.model}</td><td>{u.tier}</td><td>{u.decisions}</td><td>{u.input_tokens} / {u.output_tokens}</td><td>{u.rejected}</td><td>{u.reworked}</td><td>{u.escalations}</td></tr>)}</tbody>
          </table>
        ))}
      </section>
    </>
  );
}
