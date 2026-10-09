import { useState } from 'react';
import { api, type Provider, type RecordingGaps, type StitchReport } from './api';
import { Errors, Field, useAction, useLoad } from './ui';

/** What to record for a workflow, and what recording it saves. */
export function Stitching({ workflowId, scenariosText }: { workflowId: string; scenariosText: string }) {
  const gaps = useLoad(() => api<RecordingGaps>('GET', `/internal/workflows/${workflowId}/recording-gaps`), [workflowId]);
  const providers = useLoad(() => api<Provider[]>('GET', '/internal/providers'));
  const [voiceId, setVoiceId] = useState('');
  const [report, setReport] = useState<StitchReport | null>(null);
  const act = useAction();
  const voices = providers.data?.filter((p) => p.kind === 'voice') ?? [];

  return (
    <section className="card" aria-label="Stitching">
      <h2>Stitching</h2>
      <p className="muted">Fixed words can be played from a recording instead of synthesised. Names, amounts and model-written lines are always spoken live.</p>
      <Errors error={gaps.error ?? providers.error} />
      {gaps.data && (
        gaps.data.missing.length === 0 ? <p>Every fixed phrase has a recording.</p> : (
          <>
            <p>{gaps.data.covered} recorded, {gaps.data.missing.length} still to record ({gaps.data.missingCharacters} characters that are synthesised on every call).</p>
            <table>
              <thead><tr><th>Words to record</th><th>Language</th><th>Step</th></tr></thead>
              <tbody>{gaps.data.missing.map((m, i) => <tr key={i}><td>{m.text}</td><td>{m.language}</td><td>{m.node}</td></tr>)}</tbody>
            </table>
          </>
        )
      )}
      <h3>Measure the saving</h3>
      <p className="muted">Plays the scripted callers from the Simulate box twice, once with the recordings and once without, and prices the difference at the voice provider's character rate. It measures cost only; whether it sounds as good needs people listening.</p>
      <Field label="Voice provider">
        <select value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
          <option value="">Choose…</option>{voices.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </Field>
      <Errors error={act.error} />
      <div><button disabled={act.pending || !voiceId} onClick={async () => {
        let scenarios: unknown;
        try { scenarios = JSON.parse(scenariosText); } catch { act.run(async () => { throw new Error('The scenarios in the Simulate box are not valid JSON.'); }); return; }
        const r = await act.run(() => api<StitchReport>('POST', `/internal/workflows/${workflowId}/stitching-report`, { voiceProviderId: voiceId, scenarios }));
        if (r) setReport(r);
      }}>Measure saving</button></div>
      {report && (
        <div role="status" className="notice ok">
          <p>Without recordings: {report.unstitched.synthChars} characters synthesised, ${report.unstitched.costUsd}. With them: {report.stitched.synthChars} characters, ${report.stitched.costUsd}.</p>
          <p><strong>Saves {report.saved.percent}% (${report.saved.costUsd})</strong> on these {report.scenarios} callers.{report.ratesConfirmed ? '' : ' The voice provider\'s rate is not confirmed yet, so treat this as an estimate.'}</p>
          <p className="muted">{report.note}</p>
        </div>
      )}
    </section>
  );
}
