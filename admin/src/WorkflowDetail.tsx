import { useEffect, useState } from 'react';
import { api, type RunView, type SimResult, type WfIssue, type WfVersion, type WorkflowDef, type WorkflowDetailData } from './api';
import { Errors, Field, fmtDate, useAction, useLoad } from './ui';

const preview = (t: string | Record<string, string> | undefined) => (t === undefined ? '' : typeof t === 'string' ? t : t.en ?? Object.values(t)[0] ?? '');

function Outline({ def }: { def: WorkflowDef }) {
  return (
    <ul className="outline">
      {Object.entries(def.nodes).map(([id, n]) => (
        <li key={id}>
          <strong>{id}</strong>{id === def.start && <span className="badge ok"> start</span>}{' '}
          <span className="muted">{n.type === 'speak' ? `${n.speech} speech` : n.type}{n.type === 'end' ? `: ${n.outcome}` : ''}{n.type === 'subflow' ? `: runs ${n.workflow}` : ''}{n.type === 'handoff' ? `: ${(n.target as { workflow?: string }).workflow ? `to ${(n.target as { workflow: string }).workflow}` : 'to a person'}` : ''}</span>
          {n.type === 'speak' && <div className="line">“{preview(n.text)}”</div>}
          {n.transitions && n.transitions.length > 0 && <div className="muted">→ {n.transitions.map((t) => t.to + (t.when ? ' (if…)' : '')).join(', ')}</div>}
          {(!n.transitions || n.transitions.length === 0) && n.type !== 'end' && n.type !== 'handoff' && <div className="muted">→ ends the call</div>}
        </li>
      ))}
    </ul>
  );
}

function Issues({ errors, warnings }: { errors: WfIssue[]; warnings: WfIssue[] }) {
  if (errors.length === 0 && warnings.length === 0) return <div className="notice ok" role="status">No problems found.</div>;
  return (
    <div>
      {errors.length > 0 && <div className="errors" role="alert"><strong>{errors.length} problem{errors.length === 1 ? '' : 's'} to fix before this can be published</strong>
        <ul>{errors.map((e, i) => <li key={i}>{e.nodeId ? <code>{e.nodeId}</code> : null} {e.message}</li>)}</ul></div>}
      {warnings.length > 0 && <div className="notice" role="status"><strong>{warnings.length} to look at</strong>
        <ul>{warnings.map((e, i) => <li key={i}>{e.nodeId ? <code>{e.nodeId}</code> : null} {e.message}</li>)}</ul></div>}
    </div>
  );
}

export function WorkflowDetail({ id }: { id: string }) {
  const wf = useLoad(() => api<WorkflowDetailData>('GET', `/internal/workflows/${id}`), [id]);
  const latest = wf.data?.versions[0];
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const [checked, setChecked] = useState<{ errors: WfIssue[]; warnings: WfIssue[] } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const edit = useAction();
  const deployAction = useAction();
  const [deployed, setDeployed] = useState<string | null>(null);

  useEffect(() => { if (latest) setDraft(JSON.stringify(latest.definition, null, 2)); }, [latest?.id]);

  async function check() {
    let definition: unknown;
    try { definition = JSON.parse(draft); } catch { edit.run(async () => { throw new Error('That is not valid JSON.'); }); return; }
    const r = await edit.run(() => api<{ errors: WfIssue[]; warnings: WfIssue[] }>('POST', '/internal/workflows/validate', { definition }));
    if (r) { setChecked(r); setSaved(null); }
  }
  async function save() {
    let definition: unknown;
    try { definition = JSON.parse(draft); } catch { edit.run(async () => { throw new Error('That is not valid JSON.'); }); return; }
    const r = await edit.run(() => api<WfVersion>('POST', `/internal/workflows/${id}/versions`, { definition, note: note || undefined }));
    if (r) { setSaved(`Saved as version ${r.version} (${r.change} change).${r.valid ? '' : ' It has problems and cannot be published yet.'}`); setChecked(r.issues); setNote(''); wf.reload(); }
  }
  async function deploy(v: WfVersion, environment: 'staging' | 'production') {
    setDeployed(null);
    const r = await deployAction.run(() => api('POST', `/internal/workflows/${id}/deploy`, { versionId: v.id, environment }));
    if (r) { setDeployed(`Version ${v.version} is now live in ${environment}.`); wf.reload(); }
  }
  async function rollback(environment: 'staging' | 'production') {
    setDeployed(null);
    const r = await deployAction.run(() => api<{ version: string }>('POST', `/internal/workflows/${id}/rollback`, { environment }));
    if (r) { setDeployed(`${environment[0]!.toUpperCase()}${environment.slice(1)} is back on version ${r.version}.`); wf.reload(); }
  }

  const d = wf.data;
  return (
    <>
      <p><a href="#/workflows">← All workflows</a></p>
      <Errors error={wf.error} />
      {d && (
        <>
          <h1>{d.name}</h1>
          <p className="muted">Live in staging: <strong>{d.live.staging ?? 'not live'}</strong> · Live in production: <strong>{d.live.production ?? 'not live'}</strong></p>

          <section className="card" aria-label="Versions">
            <h2>Versions</h2>
            <p className="muted">A change inside a node is a minor version (1.0 → 1.1). A change to where the call can go is a major one (1.1 → 2.0). A version with problems can be saved but not published.</p>
            <Errors error={deployAction.error} />
            {deployed && <div className="notice ok" role="status">{deployed}</div>}
            <table>
              <thead><tr><th>Version</th><th>Change</th><th>Status</th><th>Saved</th><th>Note</th><th /></tr></thead>
              <tbody>{d.versions.map((v) => (
                <tr key={v.id}>
                  <td><strong>{v.version}</strong></td><td>{v.change}</td>
                  <td>{v.valid ? <span className="badge ok">ready</span> : <span className="badge bad">{v.issues.errors.length} problem{v.issues.errors.length === 1 ? '' : 's'}</span>}</td>
                  <td>{fmtDate(v.created_at)}</td><td>{v.note}</td>
                  <td className="actions">
                    <button className="secondary" disabled={deployAction.pending} onClick={() => deploy(v, 'staging')} aria-label={`Put ${v.version} in staging`}>Staging</button>{' '}
                    <button className="secondary" disabled={deployAction.pending} onClick={() => deploy(v, 'production')} aria-label={`Put ${v.version} in production`}>Production</button>
                  </td>
                </tr>
              ))}</tbody>
            </table>
            <div className="inline">
              {(['staging', 'production'] as const).map((env) => (
                <button key={env} className="link" disabled={deployAction.pending || !d.previous[env]} onClick={() => rollback(env)}>
                  {d.previous[env] ? `Roll ${env} back to ${d.previous[env]}` : `Nothing to roll ${env} back to`}
                </button>
              ))}
            </div>
            <p className="muted">Calls already under way keep the version they started on when you roll back.</p>
          </section>

          <section className="card" aria-label="Edit">
            <h2>Edit</h2>
            <Field label="Definition (JSON)"><textarea rows={16} spellCheck={false} className="code" value={draft} onChange={(e) => { setDraft(e.target.value); setChecked(null); setSaved(null); }} /></Field>
            <Field label="Note (optional)"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
            <Errors error={edit.error} />
            {checked && <Issues errors={checked.errors} warnings={checked.warnings} />}
            {saved && <div className="notice ok" role="status">{saved}</div>}
            <div className="inline">
              <button className="secondary" disabled={edit.pending} onClick={check}>Check for problems</button>
              <button disabled={edit.pending} onClick={save}>Save as a new version</button>
            </div>
          </section>

          {latest && <section className="card" aria-label="Outline"><h2>Outline of version {latest.version}</h2><Outline def={latest.definition} />
            <p className="muted">A visual canvas is not built yet; this is the same flow as a list.</p></section>}

          <Simulate workflowId={id} detail={d} />
          <TestCall workflowId={id} detail={d} />
        </>
      )}
    </>
  );
}

function Simulate({ workflowId, detail }: { workflowId: string; detail: WorkflowDetailData }) {
  const latest = detail.versions[0]!;
  const [versionId, setVersionId] = useState('');
  const [text, setText] = useState('');
  const [result, setResult] = useState<SimResult | null>(null);
  const act = useAction();
  useEffect(() => {
    const vars = Object.fromEntries((latest.definition.variables ?? []).map((v) => [v, `example ${v}`]));
    setText(JSON.stringify([{ name: 'Example caller', variables: vars, replies: [], expect: {} }], null, 2));
  }, [latest.id]);

  return (
    <section className="card" aria-label="Simulation">
      <h2>Simulate</h2>
      <p className="muted">Run a list of scripted callers through a version, with nothing real touched. Production needs a simulation of the exact version in which every caller states its expected <code>outcome</code> and does what you expected. Each has a name, the variables it starts with, what the caller says in order, and what you expect (<code>outcome</code>, <code>says</code>, <code>doesNotSay</code>, <code>handoff</code>).</p>
      <Field label="Version to simulate">
        <select value={versionId} onChange={(e) => setVersionId(e.target.value)}>
          <option value="">The version live in staging</option>
          {detail.versions.filter((v) => v.valid).map((v) => <option key={v.id} value={v.id}>{v.version}</option>)}
        </select>
      </Field>
      <Field label="Scenarios (JSON)"><textarea rows={10} spellCheck={false} className="code" value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <Errors error={act.error} />
      <div><button disabled={act.pending} onClick={async () => {
        let scenarios: unknown;
        try { scenarios = JSON.parse(text); } catch { act.run(async () => { throw new Error('The scenarios are not valid JSON.'); }); return; }
        const r = await act.run(() => api<SimResult>('POST', `/internal/workflows/${workflowId}/simulate`, { versionId: versionId || undefined, scenarios }));
        if (r) setResult(r);
      }}>Run simulation</button></div>
      {result && (
        <>
          <div className={result.clean ? 'notice ok' : 'errors'} role={result.clean ? 'status' : 'alert'}>
            {result.passed} of {result.total} passed. {result.clean ? 'This version can now go to production.' : 'Fix the failures before this version can go to production.'}
            {result.gateProblems && result.gateProblems.length > 0 && ` ${result.gateProblems.join(' ')}`}
          </div>
          <table>
            <thead><tr><th>Caller</th><th>Result</th><th>Outcome</th><th>What went wrong</th></tr></thead>
            <tbody>{result.results.map((r) => (
              <tr key={r.name}><td>{r.name}</td><td>{r.passed ? <span className="badge ok">passed</span> : <span className="badge bad">failed</span>}</td><td>{r.outcome ?? '—'}</td><td>{r.failures.join(' ')}</td></tr>
            ))}</tbody>
          </table>
        </>
      )}
    </section>
  );
}

function TestCall({ workflowId, detail }: { workflowId: string; detail: WorkflowDetailData }) {
  const [environment, setEnvironment] = useState<'staging' | 'production'>('staging');
  const [vars, setVars] = useState('{}');
  const [run, setRun] = useState<RunView | null>(null);
  const [lines, setLines] = useState<{ who: 'workflow' | 'caller' | 'note'; text: string }[]>([]);
  const [reply, setReply] = useState('');
  const act = useAction();
  const live = detail.live[environment];

  const take = (r: RunView, caller?: string) => {
    setRun(r);
    setLines((l) => [...l, ...(caller ? [{ who: 'caller' as const, text: caller }] : []), ...r.said.map((text) => ({ who: 'workflow' as const, text })),
      ...(r.status === 'ended' ? [{ who: 'note' as const, text: `The call ended: ${r.outcome}${r.error ? ` (${r.error})` : ''}` }] : [])]);
  };

  return (
    <section className="card" aria-label="Test call">
      <h2>Test call</h2>
      <p className="muted">Talk to the version that is live. Staging reads from integrations but never writes. Production runs the real thing, writes included.</p>
      <div className="grid">
        <Field label="Where">
          <select value={environment} onChange={(e) => setEnvironment(e.target.value as 'staging' | 'production')}>
            <option value="staging">Staging {detail.live.staging ? `(${detail.live.staging})` : '(not live)'}</option>
            <option value="production">Production {detail.live.production ? `(${detail.live.production})` : '(not live)'}</option>
          </select>
        </Field>
      </div>
      <Field label="The caller's record (JSON variables)"><textarea rows={4} spellCheck={false} className="code" value={vars} onChange={(e) => setVars(e.target.value)} /></Field>
      <Errors error={act.error} />
      <div><button disabled={act.pending || !live} onClick={async () => {
        let variables: unknown;
        try { variables = JSON.parse(vars); } catch { act.run(async () => { throw new Error('The variables are not valid JSON.'); }); return; }
        setLines([]); setRun(null);
        const r = await act.run(() => api<RunView>('POST', `/internal/workflows/${workflowId}/runs`, { environment, kind: environment === 'production' ? 'live' : 'test', variables }));
        if (r) take(r);
      }}>{live ? 'Start the call' : `Not live in ${environment}`}</button></div>
      {lines.length > 0 && <ol className="transcript" aria-label="Transcript">{lines.map((l, i) => <li key={i} className={l.who}><strong>{l.who === 'workflow' ? 'Voice Lab' : l.who === 'caller' ? 'Caller' : ''}</strong> {l.text}</li>)}</ol>}
      {run && run.status === 'awaiting_reply' && (
        <form className="inline" aria-label="Reply" onSubmit={async (e) => {
          e.preventDefault();
          const text = reply; setReply('');
          const r = await act.run(() => api<RunView>('POST', `/internal/workflow-runs/${run.id}/reply`, { text, expectedVersion: run.version }));
          if (r) take(r, text);
        }}>
          <Field label="What the caller says"><input value={reply} onChange={(e) => setReply(e.target.value)} required /></Field>
          <button type="submit" disabled={act.pending}>Send</button>
        </form>
      )}
    </section>
  );
}
