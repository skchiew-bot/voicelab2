import { useEffect, useState } from 'react';
import { api, getToken, setToken } from './api';
import { Errors, Field, useAction } from './ui';
import { ProviderDetail } from './ProviderDetail';
import { Providers } from './Providers';
import { Tenants } from './Tenants';

function useHash() {
  const [hash, setHash] = useState(location.hash || '#/providers');
  useEffect(() => {
    const on = () => setHash(location.hash || '#/providers');
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return hash;
}

function Login({ onDone }: { onDone: () => void }) {
  const [token, setLocal] = useState('');
  const { pending, error, run } = useAction();
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setToken(token.trim());
    const me = await run(() => api<{ role: string }>('GET', '/me'));
    if (!me) { setToken(null); return; }
    if (me.role !== 'internal_admin') {
      setToken(null);
      alert('This console is for Daythree staff. Use the client portal instead.');
      return;
    }
    onDone();
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
  const [signedIn, setSignedIn] = useState(false);
  const [checking, setChecking] = useState(Boolean(getToken()));
  const hash = useHash();

  useEffect(() => {
    if (!getToken()) return;
    api<{ role: string }>('GET', '/me')
      .then((me) => setSignedIn(me.role === 'internal_admin'))
      .catch(() => setToken(null))
      .finally(() => setChecking(false));
  }, []);

  if (checking) return <main className="login"><p className="muted">Loading…</p></main>;
  if (!signedIn) return <Login onDone={() => setSignedIn(true)} />;

  const providerId = /^#\/providers\/([\w-]+)$/.exec(hash)?.[1];
  const section = hash.startsWith('#/tenants') ? 'tenants' : 'providers';

  return (
    <div className="shell">
      <nav>
        <strong>Voice Lab</strong>
        <a href="#/providers" aria-current={section === 'providers' ? 'page' : undefined}>Providers</a>
        <a href="#/tenants" aria-current={section === 'tenants' ? 'page' : undefined}>Clients</a>
        <span className="spacer" />
        <button className="link" onClick={() => { setToken(null); setSignedIn(false); }}>Sign out</button>
      </nav>
      <main>
        {section === 'tenants' ? <Tenants /> : providerId ? <ProviderDetail id={providerId} /> : <Providers />}
      </main>
    </div>
  );
}
