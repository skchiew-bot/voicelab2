import { useState } from 'react';
import { api } from './api';
import { Errors, Field, fmtDate, useAction, useLoad } from './ui';

interface JobRun { id: number; started_at: string; finished_at: string; outcome: 'ok' | 'partly' | 'failed'; summary: Record<string, number> }
interface JobRow {
  name: string; every_seconds: number; enabled: boolean; next_run_at: string; last_started_at: string | null; last_finished_at: string | null;
  last_outcome: 'ok' | 'partly' | 'failed' | null; consecutive_failures: number; unfinished: boolean; recent: JobRun[];
}

const WHAT: Record<string, string> = {
  'alerts-email': 'Emails each new Control Tower alert to the people subscribed',
  'cases-dispatch': 'Places case callbacks that are due',
  'queue-expire': 'Gives up callers who have waited too long in the inbound queue',
  'faults-sweep': 'Flags calls the system dropped',
  'workflow-runs-sweep': 'Abandons workflow runs that stopped moving an hour ago',
  'reconcile': "Checks call costs against the providers' own figures",
  'learning-sweep': 'Finishes approved scripts and screens promoted ones for drift',
  'payment-checks': "Asks each client's payment system what has been paid",
  'case-ageing': 'Stops calling aged cases until a person decides',
  'appointment-reminders': 'Queues appointment reminders',
};

const every = (s: number) => (s % 86400 === 0 ? `${s / 86400} day${s === 86400 ? '' : 's'}` : s % 3600 === 0 ? `${s / 3600} hour${s === 3600 ? '' : 's'}` : `${s / 60} minute${s === 60 ? '' : 's'}`);
const counts = (s: Record<string, number>) => Object.entries(s).map(([k, v]) => `${k} ${v}`).join(', ') || '—';
const badge = (o: JobRow['last_outcome']) => (o === 'ok' ? 'ok' : o === 'partly' ? 'warn' : o === 'failed' ? 'bad' : '');

function JobControls({ job, onDone }: { job: JobRow; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(String(job.every_seconds / 60));
  const act = useAction();
  const go = async (path: string, method: 'PUT' | 'POST', body: object) => { if (await act.run(() => api(method, path, { ...body, reason }))) { setReason(''); onDone(); } };
  // Read strictly: anything but whole minutes is refused here, never turned into a default (lesson L-034).
  const parsed = /^\d{1,5}$/.test(minutes.trim()) ? Number(minutes.trim()) : null;
  return (
    <div className="grid" aria-label={`Change ${job.name}`}>
      <Field label="Why" help="Required. Shown in the change log."><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <Field label="Every (minutes)"><input inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} /></Field>
      <div>
        <button disabled={act.pending || !reason.trim() || parsed === null || parsed * 60 === job.every_seconds}
          onClick={() => go(`/internal/scheduler/${job.name}`, 'PUT', { everySeconds: (parsed ?? 0) * 60 })}>Save interval</button>{' '}
        <button className="secondary" disabled={act.pending || !reason.trim()}
          onClick={() => go(`/internal/scheduler/${job.name}`, 'PUT', { enabled: !job.enabled })}>{job.enabled ? 'Turn off' : 'Turn on'}</button>{' '}
        <button className="secondary" disabled={act.pending || !reason.trim() || !job.enabled}
          onClick={() => go(`/internal/scheduler/${job.name}/run`, 'POST', {})}>Run now</button>
      </div>
      {parsed === null && <p className="muted" role="alert">Every: whole minutes, digits only.</p>}
      <Errors error={act.error} />
    </div>
  );
}

/** The jobs the app runs by itself, when each last ran and how it went. */
export function Jobs() {
  const jobs = useLoad(() => api<JobRow[]>('GET', '/internal/scheduler'));
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <h1>Scheduled jobs</h1>
      <p className="muted">Voice Lab runs these itself, on every server where the scheduler is on. Each job runs on one server at a time. A run that started and never finished (a restart, a crash) is shown as unknown, and the job runs again at its next time.</p>
      <Errors error={jobs.error} />
      {jobs.data && (
        <table aria-label="Scheduled jobs">
          <thead><tr><th>Job</th><th>Every</th><th>Last run</th><th>Next run</th><th>Last counts</th><th /></tr></thead>
          <tbody>{jobs.data.map((j) => (
            <tr key={j.name}>
              <td><strong>{j.name}</strong><span className="sub">{WHAT[j.name] ?? ''}</span></td>
              <td>{every(j.every_seconds)}</td>
              <td>
                {!j.last_started_at ? 'Never' : j.unfinished ? <span className="badge warn">Started {fmtDate(j.last_started_at)}, not finished: unknown</span>
                  : <><span className={`badge ${badge(j.last_outcome)}`}>{j.last_outcome}</span> {fmtDate(j.last_finished_at!)}</>}
                {j.consecutive_failures > 0 && <span className="sub">{j.consecutive_failures} not fully successful in a row</span>}
              </td>
              <td>{j.enabled ? fmtDate(j.next_run_at) : <span className="badge warn">Off</span>}</td>
              <td>{j.recent[0] ? counts(j.recent[0].summary) : '—'}</td>
              <td><button className="link" aria-expanded={open === j.name} onClick={() => setOpen(open === j.name ? null : j.name)}>Change</button></td>
            </tr>
          ))}</tbody>
        </table>
      )}
      {open && jobs.data?.find((j) => j.name === open) && (
        <section className="card"><h2>{open}</h2><JobControls key={open} job={jobs.data.find((j) => j.name === open)!} onDone={jobs.reload} /></section>
      )}
    </>
  );
}
