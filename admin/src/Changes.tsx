import { useState } from 'react';
import { api, apiObjectUrl, type ChangeFull, type ChangeRow, type Provider, type Showcase, type WorkflowSummary, type WfVersion } from './api';
import { Errors, Field, fmtDate, useAction, useLoad } from './ui';

const STATUS: Record<ChangeRow['status'], { text: string; cls: string }> = {
  pending: { text: 'Waiting for approval', cls: 'badge warn' }, approved: { text: 'Approved', cls: 'badge ok' }, rejected: { text: 'Turned down', cls: 'badge bad' }, applied: { text: 'Live', cls: 'badge ok' },
};
const OP_COLOR = { '+': 'var(--ok)', '-': 'var(--danger)', '~': 'var(--warn)' } as const;

function Diff({ lines }: { lines: ChangeFull['diff']['lines'] }) {
  if (lines.length === 0) return <p className="muted">Nothing differs.</p>;
  return (
    <ul className="outline" aria-label="Changes">
      {lines.map((l, i) => (
        <li key={i} style={{ borderLeft: `4px solid ${OP_COLOR[l.op]}`, paddingLeft: '.6rem' }}>
          <strong aria-label={l.op === '+' ? 'added' : l.op === '-' ? 'removed' : 'changed'}>{l.op}</strong> {l.node && <strong>{l.node}: </strong>}{l.text}
        </li>
      ))}
    </ul>
  );
}

function Story({ id }: { id: string }) {
  const s = useLoad(() => api<Showcase>('GET', `/internal/changes/${id}/showcase`), [id]);
  const [src, setSrc] = useState<string | null>(null);
  const act = useAction();
  const d = s.data;
  if (!d) return <Errors error={s.error} />;
  const det = d.detected;
  return (
    <section className="card" aria-label="Showcase">
      <h2>What is changing, and why</h2>
      <p><strong>Why:</strong> {d.why}</p>
      <h3>What we saw in the flow today (version {d.before.version ?? 'none'})</h3>
      {det.calls === 0 ? <p className="muted">No calls on the current version in the last {det.periodDays} days.</p> : (
        <ul>
          <li>{det.calls} call{det.calls === 1 ? '' : 's'} in the last {det.periodDays} days; {det.escalated} passed to a person{det.escalationPercent !== null ? ` (${det.escalationPercent}%)` : ''}.</li>
          <li>{det.turns} caller turns; {det.turnsNotUnderstood} not understood{det.averageSentiment !== null ? `; average mood ${det.averageSentiment.toFixed(2)}` : ''}.</li>
          {det.whereCallsEscalate.map((w) => <li key={w.node}>{w.escalations} escalation{w.escalations === 1 ? '' : 's'} at <strong>{w.node}</strong>.</li>)}
        </ul>
      )}
      <div className="grid">
        <div><h3>Before ({d.before.version ?? 'none'})</h3><ol className="outline">{d.before.steps.map((x) => <li key={x.id}><strong>{x.id}</strong> <span className="muted">{x.type}{x.start ? ', start' : ''}</span> {x.text}</li>)}</ol></div>
        <div><h3>After ({d.after.version})</h3><ol className="outline">{d.after.steps.map((x) => <li key={x.id}><strong>{x.id}</strong> <span className="muted">{x.type}{x.start ? ', start' : ''}</span> {x.text}</li>)}</ol></div>
      </div>
      <h3>The difference</h3>
      <ul>{d.changes.summary.map((x, i) => <li key={i}>{x}</li>)}</ul>
      <h3>Listen</h3>
      <p className="muted">{d.audioNote}</p>
      <Errors error={act.error} />
      <ul>{d.audio.map((a, i) => (
        <li key={i}>{a.node} ({a.language}): {a.text}{' '}
          {a.recordingId ? <button className="link" onClick={async () => { const u = await act.run(() => apiObjectUrl(`/internal/recordings/${a.recordingId}/audio`)); if (u) setSrc(u); }}>Play</button> : <span className="muted">spoken live</span>}</li>
      ))}</ul>
      {src && <audio controls autoPlay src={src} aria-label="Recorded phrase" />}
    </section>
  );
}

function Detail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const ch = useLoad(() => api<ChangeFull>('GET', `/internal/changes/${id}`), [id]);
  const [note, setNote] = useState('');
  const [story, setStory] = useState(false);
  const act = useAction();
  const d = ch.data;
  if (!d) return <Errors error={ch.error} />;
  const go = async (path: string, body?: object) => { if (await act.run(() => api('POST', `/internal/changes/${id}/${path}`, body ?? {}))) { setNote(''); ch.reload(); onChanged(); } };
  const f = d.financial;
  return (
    <section className="card" aria-label="Change">
      <h2>{d.workflow}: {d.from_version ?? 'nothing'} → {d.to_version} in {d.environment} <span className={STATUS[d.status].cls}>{STATUS[d.status].text}</span></h2>
      <p><strong>Why:</strong> {d.reason}</p>
      <h3>What changes ({d.diff.shape === 'major' ? 'the shape of the flow' : d.diff.shape === 'minor' ? 'wording and details' : 'nothing'})</h3>
      <Diff lines={d.diff.lines} />
      <h3>What it would cost</h3>
      <p>Speech spoken live: {f.before?.synthChars ?? 0} → {f.after.synthChars} characters ({f.delta.synthChars >= 0 ? '+' : ''}{f.delta.synthChars}){f.delta.costUsd !== null ? `, ${f.delta.costUsd.startsWith('-') ? '' : '+'}${f.delta.costUsd} USD` : ''}. {f.delta.escalations !== 0 && `Escalations in the rehearsal: ${f.delta.escalations > 0 ? '+' : ''}${f.delta.escalations}. `}</p>
      <p className="muted">{f.note}{f.ratesConfirmed === false ? ' The voice provider\'s rate is not confirmed yet.' : ''}</p>
      <h3>Approval</h3>
      <ol>{d.progress.map((p) => <li key={p.level}>{p.name}: {p.decision === 'approved' ? 'approved' : p.decision === 'rejected' ? 'turned down' : p.level === d.nextLevel ? 'waiting' : 'not yet'}{p.note ? ` — ${p.note}` : ''}{p.at ? <span className="muted"> ({fmtDate(p.at)})</span> : null}</li>)}</ol>
      <Errors error={act.error} />
      {d.status === 'pending' && (
        <>
          <Field label="Note (needed to turn it down)"><input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="row">
            <button disabled={act.pending} onClick={() => go('decision', { decision: 'approved', note: note || undefined })}>Approve this level</button>
            <button className="secondary" disabled={act.pending} onClick={() => go('decision', { decision: 'rejected', note })}>Turn it down</button>
          </div>
        </>
      )}
      <div className="row">
        {d.status === 'approved' && <button disabled={act.pending} onClick={() => go('apply')}>Put it live</button>}
        <button className="secondary" onClick={() => setStory(!story)}>{story ? 'Hide the showcase' : 'Show the client'}</button>
      </div>
      {story && <Story id={id} />}
    </section>
  );
}

function Propose({ onDone }: { onDone: (id: string) => void }) {
  const workflows = useLoad(() => api<WorkflowSummary[]>('GET', '/internal/workflows'));
  const providers = useLoad(() => api<Provider[]>('GET', '/internal/providers'));
  const [workflowId, setWorkflowId] = useState('');
  const versions = useLoad(() => (workflowId ? api<WfVersion[]>('GET', `/internal/workflows/${workflowId}/versions`) : Promise.resolve([])), [workflowId]);
  const [versionId, setVersionId] = useState('');
  const [environment, setEnvironment] = useState<'staging' | 'production'>('staging');
  const [reason, setReason] = useState('');
  const [voiceId, setVoiceId] = useState('');
  const [text, setText] = useState('[{ "name": "Example caller", "variables": {}, "replies": [], "expect": {} }]');
  const act = useAction();
  return (
    <form className="card" aria-label="Propose a change" onSubmit={async (e) => {
      e.preventDefault();
      let scenarios: unknown;
      try { scenarios = JSON.parse(text); } catch { act.run(async () => { throw new Error('The scenarios are not valid JSON.'); }); return; }
      const r = await act.run(() => api<{ id: string }>('POST', `/internal/workflows/${workflowId}/changes`, { toVersionId: versionId, environment, reason, scenarios, voiceProviderId: voiceId || undefined }));
      if (r) { setReason(''); onDone(r.id); }
    }}>
      <h2>Propose a change</h2>
      <p className="muted">Pick the version you want live. The scripted callers below are played through it and through the version live now, to work out what it would cost.</p>
      <div className="grid">
        <Field label="Workflow"><select value={workflowId} onChange={(e) => { setWorkflowId(e.target.value); setVersionId(''); }} required><option value="">Choose…</option>{workflows.data?.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>
        <Field label="Version"><select value={versionId} onChange={(e) => setVersionId(e.target.value)} required><option value="">Choose…</option>{versions.data?.filter((v) => v.valid).map((v) => <option key={v.id} value={v.id}>{v.version}</option>)}</select></Field>
        <Field label="Where"><select value={environment} onChange={(e) => setEnvironment(e.target.value as 'staging' | 'production')}><option value="staging">Staging</option><option value="production">Production</option></select></Field>
        <Field label="Voice provider (to price speech)"><select value={voiceId} onChange={(e) => setVoiceId(e.target.value)}><option value="">Not priced</option>{providers.data?.filter((p) => p.kind === 'voice').map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
      </div>
      <Field label="Why is this wanted?"><textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} required /></Field>
      <Field label="Scripted callers (JSON)"><textarea rows={5} spellCheck={false} className="code" value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <Errors error={act.error ?? workflows.error ?? versions.error} />
      <div><button type="submit" disabled={act.pending}>Propose this change</button></div>
    </form>
  );
}

export function Changes() {
  const list = useLoad(() => api<ChangeRow[]>('GET', '/internal/changes'));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <h1>Changes</h1>
      <p className="muted">A change to a live flow is proposed with a reason and a cost, shown as what differs, approved level by level by different people, and only then put live through the usual gates.</p>
      <Errors error={list.error} />
      {list.data && (list.data.length === 0 ? <p className="muted">No changes proposed yet.</p> : (
        <table>
          <thead><tr><th>Proposed</th><th>Workflow</th><th>Change</th><th>Where</th><th>Status</th><th>Approvals</th><th /></tr></thead>
          <tbody>{list.data.map((c) => (
            <tr key={c.id}>
              <td>{fmtDate(c.created_at)}</td><td>{c.workflow}</td><td>{c.from_version ?? 'nothing'} → {c.to_version} ({c.changes} difference{c.changes === 1 ? '' : 's'})</td><td>{c.environment}</td>
              <td><span className={STATUS[c.status].cls}>{STATUS[c.status].text}</span></td><td>{c.levelsDone} of {c.levelsTotal}</td>
              <td><button className="link" onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? 'Close' : 'Open'}</button></td>
            </tr>
          ))}</tbody>
        </table>
      ))}
      {open && <Detail id={open} onChanged={list.reload} />}
      <Propose onDone={(id) => { list.reload(); setOpen(id); }} />
    </>
  );
}
