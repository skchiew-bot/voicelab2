import { useState } from 'react';
import { api, type TransferSettingRow } from './api';
import { useClientList } from './client';
import { Errors, Field, fmtDate, useAction, useLoad } from './ui';

/**
 * Where each client's callers go when a workflow passes them to a person: the client's agent phone, how long it rings,
 * and whether the agent hears why first (and must press 1). Admins change it; read-only staff see it.
 */
export function AgentPhones({ readOnly }: { readOnly: boolean }) {
  const list = useLoad(() => api<TransferSettingRow[]>('GET', '/internal/transfer-settings'));
  const { tenants } = useClientList();
  // The client is chosen here every time, never taken from the menu's client (lesson L-036).
  const [tenantId, setTenantId] = useState('');
  const [agent, setAgent] = useState('');
  const [ring, setRing] = useState('25');
  const [whisper, setWhisper] = useState(true);
  const [local, setLocal] = useState<string | null>(null);
  const { pending, error, run } = useAction();
  const edit = (r: TransferSettingRow) => { setTenantId(r.tenantId); setAgent(r.agentNumber); setRing(String(r.ringSeconds)); setWhisper(r.whisper); setLocal(null); };

  return (
    <section className="card" aria-label="Agent phones">
      <h2>Agent phones</h2>
      <p className="muted">When a workflow passes a caller to a person, the call rings the client's agent phone, showing one of our numbers. If no one takes it, the caller is told they will be called back and a callback is recorded.</p>
      <Errors error={list.error} />
      {list.data && (list.data.length === 0 ? <p className="muted">No client has an agent phone yet, so callers who ask for a person get a callback.</p> : (
        <table>
          <thead><tr><th>Client</th><th>Agent phone</th><th>Rings for</th><th>Whisper</th><th>Updated</th>{!readOnly && <th />}</tr></thead>
          <tbody>{list.data.map((r) => (
            <tr key={r.tenantId}>
              <td>{r.tenant}</td><td>{r.agentNumber}</td><td>{r.ringSeconds} s</td><td>{r.whisper ? 'On, press 1 to take' : 'Off'}</td><td>{fmtDate(r.updatedAt)}</td>
              {!readOnly && <td>
                <button type="button" className="link" onClick={() => edit(r)}>Edit</button>{' '}
                <button type="button" className="link" disabled={pending} onClick={async () => {
                  if (!confirm(`Remove ${r.tenant}'s agent phone? Callers who ask for a person will get a callback instead.`)) return;
                  if (await run(() => api('DELETE', `/internal/tenants/${r.tenantId}/transfer`))) list.reload();
                }}>Remove</button>
              </td>}
            </tr>
          ))}</tbody>
        </table>
      ))}
      {readOnly ? <p className="muted">You have read-only access, so you can see these settings but not change them.</p> : (
        <form aria-label="Set an agent phone" onSubmit={async (e) => {
          e.preventDefault();
          // Read strictly: a ring time that is not a whole number is refused here, never sent as something else (L-034).
          if (!/^[0-9]{1,2}$/.test(ring.trim())) { setLocal('Ring time must be a whole number of seconds, from 5 to 60.'); return; }
          setLocal(null);
          if (await run(() => api('PUT', `/internal/tenants/${tenantId}/transfer`, { agentNumber: agent, ringSeconds: Number(ring.trim()), whisper }))) {
            setTenantId(''); setAgent(''); setRing('25'); setWhisper(true); list.reload();
          }
        }}>
          <div className="grid">
            <Field label="Client">
              <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} required>
                <option value="">Choose…</option>{tenants?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Agent phone" help="The client's own staff line. For now, a Malaysian number (+60), and not a 1-300, 1-600, 1-700, 1-800, 1-900 or 600 number.">
              <input inputMode="tel" value={agent} onChange={(e) => setAgent(e.target.value)} required />
            </Field>
            <Field label="Ring for (seconds)" help="From 5 to 60.">
              <input inputMode="numeric" value={ring} onChange={(e) => setRing(e.target.value)} required />
            </Field>
            <Field label="Whisper" help="The agent hears why the call came to them and must press 1 to take it, so a voicemail is never taken for a person.">
              <input type="checkbox" checked={whisper} onChange={(e) => setWhisper(e.target.checked)} />
            </Field>
          </div>
          {local ? <div className="errors" role="alert"><strong>{local}</strong></div> : <Errors error={error} />}
          <div><button type="submit" disabled={pending}>Save agent phone</button></div>
        </form>
      )}
    </section>
  );
}
