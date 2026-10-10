import { useEffect, useState } from 'react';
import { api, getToken, setToken } from './api';
import { Errors, Field, useAction } from './ui';
import { ProviderDetail } from './ProviderDetail';
import { Calls } from './Calls';
import { ControlTower } from './ControlTower';
import { Compliance } from './Compliance';
import { Numbers } from './Numbers';
import { Appointments } from './Appointments';
import { Cases } from './Cases';
import { Changes } from './Changes';
import { Outbound } from './Outbound';
import { Knowledge } from './Knowledge';
import { ChangeLog } from './ChangeLog';
import { Learning } from './Learning';
import { Qa } from './Qa';
import { Replay } from './Replay';
import { Tickets } from './Tickets';
import { Recordings } from './Recordings';
import { Resilience } from './Resilience';
import { Providers } from './Providers';
import { WorkflowDetail } from './WorkflowDetail';
import { Workflows } from './Workflows';
import { Rates } from './Rates';
import { Tenants } from './Tenants';
import { Users } from './Users';
import { ClientProvider, ClientSwitcher, useClient } from './client';

interface Me { email: string; role: string; readOnly: boolean }
const STAFF = ['internal_admin', 'internal_viewer'];

function useHash() {
  const [hash, setHash] = useState(location.hash || '#/tower');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/tower');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function Login({ onDone }: { onDone: (me: Me) => void }) {
  const [token, setLocal] = useState('');
  const { pending, error, run } = useAction();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setToken(token.trim());
    const me = await run(() => api<Me>('GET', '/me'));
    if (!me) { setToken(null); return; }
    if (!STAFF.includes(me.role)) {
      setToken(null);
      alert('This console is for Daythree staff. Use the client portal instead.');
      return;
    }
    onDone(me);
  }
  return (
    <main className="login">
      <h1>Voice Lab</h1>
      <p className="muted">Sign in with your admin API token.</p>
      <form onSubmit={submit}>
        <Field label="API token">
          <input type="password" autoComplete="off" value={token} onChange={(e) => setLocal(e.target.value)} required />
        </Field>
        <Errors error={error} />
        <button type="submit" disabled={pending || !token.trim()}>Sign in</button>
      </form>
    </main>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checking, setChecking] = useState(Boolean(getToken()));
  const hash = useHash();

  useEffect(() => {
    if (!getToken()) return;
    api<Me>('GET', '/me')
      .then((m) => setMe(STAFF.includes(m.role) ? m : null))
      .catch(() => setToken(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <main className="login"><p className="muted">Loading…</p></main>;
  if (!me) return <Login onDone={setMe} />;
  return <ClientProvider><Shell me={me} hash={hash} onSignOut={() => { setToken(null); setMe(null); }} /></ClientProvider>;
}

function Shell({ me, hash, onSignOut }: { me: Me; hash: string; onSignOut: () => void }) {
  // Changing client starts the screen afresh, so nothing chosen for the last client (a case, a diary) is carried over.
  const [client] = useClient();

  const providerId = /^#\/providers\/([\w-]+)$/.exec(hash)?.[1];
  const workflowId = /^#\/workflows\/([\w-]+)$/.exec(hash)?.[1];
  const replay = /^#\/replay\/(call|run)\/([\w-]+)$/.exec(hash);
  const section = (['tenants', 'rates', 'numbers', 'compliance', 'calls', 'providers', 'workflows', 'recordings', 'outbound', 'resilience', 'tickets', 'faults', 'qa', 'changes', 'learning', 'cases', 'appointments', 'knowledge', 'change-log', 'replay', 'users'] as const).find((k) => hash.startsWith(`#/${k}`)) ?? 'tower';

  return (
    <div className="shell">
      <nav>
        <strong>Voice Lab</strong>
        <a href="#/tower" aria-current={section === 'tower' ? 'page' : undefined}>Control Tower</a>
        <a href="#/workflows" aria-current={section === 'workflows' ? 'page' : undefined}>Workflows</a>
        <a href="#/recordings" aria-current={section === 'recordings' ? 'page' : undefined}>Recordings</a>
        <a href="#/providers" aria-current={section === 'providers' ? 'page' : undefined}>Providers</a>
        <a href="#/tenants" aria-current={section === 'tenants' ? 'page' : undefined}>Clients</a>
        <a href="#/rates" aria-current={section === 'rates' ? 'page' : undefined}>Rates</a>
        <a href="#/numbers" aria-current={section === 'numbers' ? 'page' : undefined}>Numbers</a>
        <a href="#/compliance" aria-current={section === 'compliance' ? 'page' : undefined}>Do not call</a>
        <a href="#/calls" aria-current={section === 'calls' ? 'page' : undefined}>Calls</a>
        <a href="#/outbound" aria-current={section === 'outbound' ? 'page' : undefined}>Outbound</a>
        <a href="#/resilience" aria-current={section === 'resilience' ? 'page' : undefined}>Resilience</a>
        <a href="#/tickets" aria-current={section === 'tickets' || section === 'faults' ? 'page' : undefined}>Tickets</a>
        <a href="#/qa" aria-current={section === 'qa' ? 'page' : undefined}>Quality</a>
        <a href="#/changes" aria-current={section === 'changes' ? 'page' : undefined}>Changes</a>
        <a href="#/learning" aria-current={section === 'learning' ? 'page' : undefined}>Learning</a>
        <a href="#/cases" aria-current={section === 'cases' ? 'page' : undefined}>Cases</a>
        <a href="#/appointments" aria-current={section === 'appointments' ? 'page' : undefined}>Appointments</a>
        <a href="#/knowledge" aria-current={section === 'knowledge' ? 'page' : undefined}>Knowledge</a>
        <a href="#/change-log" aria-current={section === 'change-log' ? 'page' : undefined}>Change log</a>
        <a href="#/users" aria-current={section === 'users' ? 'page' : undefined}>Users</a>
        <span className="spacer" />
        <ClientSwitcher />
        {me.readOnly && <span className="badge warn" title="You can open every screen but not change anything.">Read only</span>}
        <button className="link" onClick={onSignOut}>Sign out</button>
      </nav>
      <main key={client}>
        {section === 'tenants' ? <Tenants />
          : section === 'users' ? <Users />
          : section === 'rates' ? <Rates />
          : section === 'numbers' ? <Numbers />
          : section === 'recordings' ? <Recordings />
          : section === 'outbound' ? <Outbound />
          : section === 'resilience' ? <Resilience />
          : section === 'tickets' || section === 'faults' ? <Tickets />
          : section === 'qa' ? <Qa />
          : section === 'changes' ? <Changes />
          : section === 'learning' ? <Learning />
          : section === 'cases' ? <Cases />
          : section === 'appointments' ? <Appointments />
          : section === 'knowledge' ? <Knowledge />
          : section === 'change-log' ? <ChangeLog />
          : section === 'replay' ? (replay ? <Replay kind={replay[1] as 'call' | 'run'} id={replay[2]!} /> : <Calls />)
          : section === 'compliance' ? <Compliance />
          : section === 'calls' ? <Calls />
          : section === 'workflows' ? (workflowId ? <WorkflowDetail id={workflowId} /> : <Workflows />)
          : section === 'providers' ? (providerId ? <ProviderDetail id={providerId} /> : <Providers />)
          : <ControlTower />}
      </main>
    </div>
  );
}
