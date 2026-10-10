import { useEffect, useRef, useState } from 'react';
import { api, type ReplayView } from './api';
import { Errors, useLoad } from './ui';

const W = 560; const H = 120; const PAD = 16;

/** The caller's mood over the call. Each point is a button: pick one and the transcript line and the step it belongs to light up. */
function Spline({ points, onPick, picked }: { points: ReplayView['sentiment']; onPick: (i: number) => void; picked: number | null }) {
  if (points.length === 0) return <p className="muted">No turns were read for mood on this call.</p>;
  const x = (i: number) => (points.length === 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (points.length - 1));
  const y = (s: number) => PAD + ((1 - s) / 2) * (H - 2 * PAD);
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.sentiment).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Mood over the call" style={{ width: '100%', maxWidth: W }}>
      <line x1={PAD} x2={W - PAD} y1={y(0)} y2={y(0)} stroke="currentColor" opacity=".25" strokeDasharray="4 4" />
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" />
      {points.map((p, i) => (
        <g key={p.turn} tabIndex={0} role="button" aria-label={`Turn ${p.turn}: mood ${p.sentiment.toFixed(2)}${p.severe ? ', severe' : ''}, at ${p.node ?? 'the call'}`} aria-pressed={picked === i}
          onClick={() => onPick(i)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(i); } }} style={{ cursor: 'pointer' }}>
          <circle cx={x(i)} cy={y(p.sentiment)} r={picked === i ? 7 : 5} fill={p.severe ? 'var(--danger)' : p.sentiment < -0.3 ? 'var(--warn)' : 'var(--ok)'} stroke="var(--surface)" strokeWidth="2" />
        </g>
      ))}
    </svg>
  );
}

export function Replay({ kind, id }: { kind: 'call' | 'run'; id: string }) {
  const rp = useLoad(() => api<ReplayView>('GET', kind === 'call' ? `/internal/calls/${id}/replay` : `/internal/workflow-runs/${id}/replay`), [kind, id]);
  const [picked, setPicked] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const lineRefs = useRef<Map<number, HTMLElement>>(new Map());
  const d = rp.data;
  useEffect(() => { setPicked(null); setOpen(null); }, [id]);

  const pick = (i: number) => {
    setPicked(i);
    if (!d) return;
    const p = d.sentiment[i]!;
    setOpen(p.timelineIndex);
    lineRefs.current.get(p.transcriptIndex)?.scrollIntoView?.({ block: 'center' });
  };
  const pickedPoint = picked === null || !d ? null : d.sentiment[picked]!;

  return (
    <>
      <h1>Replay</h1>
      <p className="muted"><a href="#/calls">← Calls</a></p>
      <Errors error={rp.error} />
      {d && (
        <>
          <section className="card" aria-label="Summary">
            <h2>{d.run ? `${d.run.workflow} ${Object.values(d.run.versions)[0] ? `(version ${d.run.versions[d.run.workflow]})` : ''}` : 'A call with no workflow'}</h2>
            <p>
              {d.run && <>Ended <strong>{d.summary.outcome ?? d.run.status}</strong>. </>}
              {d.summary.turns} caller turn{d.summary.turns === 1 ? '' : 's'}.{' '}
              {d.summary.endedBy === 'customer' && <>The <strong>customer</strong> ended the call{d.summary.endedAtNode ? ` at ${d.summary.endedAtNode}` : ''}. </>}
              {d.summary.endedBy === 'system' && !d.summary.fault && <>The <strong>system</strong> ended the call{d.summary.endedAtNode ? ` at ${d.summary.endedAtNode}` : ''}, as the workflow intended. </>}
              {d.summary.escalated && <span className="badge bad">Passed to a person</span>}
            </p>
            {d.summary.fault && <div className="errors" role="alert"><strong>The system dropped this call.</strong> {d.call?.fault_reason}</div>}
            <p>
              Kept to the workflow: <strong>{d.adherence.score === null ? 'not checked' : `${d.adherence.score}%`}</strong>
              {d.adherence.deviations.length > 0 && <> ({d.adherence.deviations.length} move{d.adherence.deviations.length === 1 ? '' : 's'} did not)</>}
            </p>
            {d.adherence.deviations.length > 0 && <ul>{d.adherence.deviations.map((v) => <li key={v.seq}>{v.reason}</li>)}</ul>}
          </section>

          <section className="card" aria-label="Mood">
            <h2>Mood</h2>
            <p className="muted">Each point is one of the caller's turns, from upset (low) to pleased (high). Pick a point to jump to what was said and the step it was said at.</p>
            <Spline points={d.sentiment} onPick={pick} picked={picked} />
            {pickedPoint && <p role="status">Turn {pickedPoint.turn}: mood {pickedPoint.sentiment.toFixed(2)}, {pickedPoint.kind}{pickedPoint.topic ? ` about ${pickedPoint.topic}` : ''}, at <strong>{pickedPoint.node}</strong>.</p>}
          </section>

          <section className="card" aria-label="Transcript">
            <h2>Transcript</h2>
            {d.transcript.length === 0 ? <p className="muted">Nothing was said in a workflow on this call.</p> : (
              <ol className="outline">
                {d.transcript.map((t) => (
                  <li key={t.index} ref={(el) => { if (el) lineRefs.current.set(t.index, el); }} aria-current={pickedPoint?.transcriptIndex === t.index ? 'true' : undefined}
                    style={pickedPoint?.transcriptIndex === t.index ? { outline: '2px solid var(--accent, currentColor)', borderRadius: 4 } : undefined}>
                    <strong>{t.speaker === 'assistant' ? 'Voice Lab' : 'Caller'}:</strong> {t.text}{' '}
                    <span className="muted">{t.node}{t.latencyMs !== undefined ? ` · ${t.latencyMs} ms` : ''}{t.sentiment !== undefined ? ` · mood ${t.sentiment.toFixed(2)}` : ''}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="card" aria-label="Every step">
            <h2>Every step</h2>
            <table>
              <thead><tr><th>When</th><th>Step</th><th>What happened</th><th>Took</th></tr></thead>
              <tbody>
                {d.timeline.map((t) => (
                  <tr key={t.index} aria-current={pickedPoint?.timelineIndex === t.index ? 'true' : undefined}>
                    <td>{t.at.slice(11, 19)}</td>
                    <td>{t.type}{t.node ? ` · ${t.node}` : ''}{t.adherence === 'deviation' && <> <span className="badge bad">off the workflow</span></>}</td>
                    <td>
                      {t.summary}
                      {(t.reasoning || t.policy) && (
                        <> <button className="link" aria-expanded={open === t.index} onClick={() => setOpen(open === t.index ? null : t.index)}>{open === t.index ? 'Hide why' : 'Why'}</button></>
                      )}
                      {open === t.index && (
                        <div className="muted">
                          {t.policy && <p>Followed: {t.policy}</p>}
                          {t.reasoning && <pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(t.reasoning, null, 2)}</pre>}
                        </div>
                      )}
                    </td>
                    <td>{t.latencyMs !== undefined ? `${t.latencyMs} ms` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </>
  );
}
