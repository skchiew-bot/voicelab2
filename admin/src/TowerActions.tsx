import { useState } from 'react';
import { api, type ControlState } from './api';
import { Errors, Field, fmtDate, useAction, useLoad } from './ui';

type Action = 'drain' | 'restore' | 'force_failover' | 'set_preferred' | 'clear_preferred' | 'set_pace' | 'retire_number' | 'reactivate_number';
const LABELS: Record<Action, string> = {
  drain: 'Drain a provider (no new calls; calls under way finish)', restore: 'Restore a drained provider',
  force_failover: 'Force a failover (it comes back after a run of good attempts)',
  set_preferred: 'Prefer a telephony provider when the pool picks a number', clear_preferred: 'Stop preferring a telephony provider',
  set_pace: 'Set the dialling pace', retire_number: 'Retire a caller ID', reactivate_number: 'Bring a caller ID back into use',
};
interface PoolNumber { id: string; e164: string; country: string; status: string; label: string | null }

/** Actions an operator takes from the Control Tower. Each needs a reason, and each appears in the change log with it. */
export function TowerActions({ onDone }: { onDone: () => void }) {
  const state = useLoad(() => api<ControlState>('GET', '/internal/control-tower/controls'));
  const numbers = useLoad(() => api<PoolNumber[]>('GET', '/internal/dids'));
  const act = useAction();
  const [action, setAction] = useState<Action>('drain');
  const [target, setTarget] = useState('');
  const [pace, setPace] = useState('');
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const s = state.data;
  const isProvider = !['set_pace', 'retire_number', 'reactivate_number'].includes(action);
  const isNumber = action === 'retire_number' || action === 'reactivate_number';
  const providers = (s?.providers ?? []).filter((p) => p.status === 'active' && (action === 'set_preferred' || action === 'clear_preferred' ? p.kind === 'telephony' : true));
  const nums = (numbers.data ?? []).filter((n) => (action === 'retire_number' ? n.status === 'active' : n.status === 'retired'));

  const submit = async () => {
    const body: Record<string, unknown> = { action, reason };
    if (isProvider) body.providerId = target;
    if (isNumber) body.phoneNumberId = target;
    if (action === 'set_pace') body.perMinute = pace.trim() === '' ? null : Number(pace);
    const r = await act.run(() => api<ControlState>('POST', '/internal/control-tower/actions', body));
    if (r) { setDone(`Done: ${LABELS[action].split(' (')[0]!.toLowerCase()}.`); setReason(''); setTarget(''); state.reload(); numbers.reload(); onDone(); }
  };

  return (
    <section className="card" aria-label="Take action">
      <h2>Take action</h2>
      {s && (
        <ul>
          {s.providers.filter((p) => p.drained || p.preferred || p.health !== 'healthy').map((p) => (
            <li key={p.id}>
              <a href={`#/providers/${p.id}`}>{p.name}</a>
              {p.drained && <> — <span className="badge warn">drained</span> by {p.drained.by} on {fmtDate(p.drained.at)}: {p.drained.reason}</>}
              {p.health !== 'healthy' && <> — <span className="badge bad">{p.health === 'unfunded' ? 'out of funding' : 'failed over'}</span> {p.healthReason}</>}
              {p.preferred && <> — <span className="badge ok">preferred</span></>}
            </li>
          ))}
          <li>Dialling pace: {s.pacePerMinute === null ? 'no limit' : `${s.pacePerMinute} dials a minute`}</li>
        </ul>
      )}
      <Field label="Action"><select aria-label="Action" value={action} onChange={(e) => { setAction(e.target.value as Action); setTarget(''); setDone(null); }}>
        {(Object.keys(LABELS) as Action[]).map((a) => <option key={a} value={a}>{LABELS[a]}</option>)}
      </select></Field>
      {isProvider && <Field label="Provider"><select aria-label="Provider" value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">Choose…</option>{providers.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.kind})</option>)}
      </select></Field>}
      {isNumber && <Field label="Caller ID"><select aria-label="Caller ID" value={target} onChange={(e) => setTarget(e.target.value)}>
        <option value="">Choose…</option>{nums.map((n) => <option key={n.id} value={n.id}>{n.e164} ({n.country}){n.label ? ` ${n.label}` : ''}</option>)}
      </select></Field>}
      {action === 'set_pace' && <Field label="Dials a minute" help="Leave empty for no limit."><input inputMode="numeric" value={pace} onChange={(e) => setPace(e.target.value)} /></Field>}
      <Field label="Why" help="Required. It is kept in the change log with your name."><input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <Errors error={act.error ?? state.error} />
      {done && <div className="notice ok" role="status">{done}</div>}
      <button disabled={act.pending || reason.trim().length < 3 || ((isProvider || isNumber) && !target)} onClick={submit}>Do it</button>
    </section>
  );
}
