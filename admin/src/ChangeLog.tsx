import { useEffect, useRef, useState } from 'react';
import { api, type ChangeEntry, type ChangeLogPage } from './api';
import { Errors, fmtDate } from './ui';

const CATEGORIES: [string, string][] = [
  ['', 'Every change'], ['workflows', 'Workflows'], ['money', 'Money and rates'], ['providers', 'Providers and capacity'], ['compliance', 'Do not call'],
  ['policy', 'Policy and knowledge'], ['learning', 'Learning loop'], ['journey', 'Journey and QA'], ['modules', 'Cases and appointments'], ['people', 'Clients and people'], ['platform', 'Platform and scheduled jobs'],
  ['activity', 'Day-to-day activity (not changes)'],
];

/** Every change made to the platform: what, who and why, newest first. A workflow change is rolled back from its own screen, through an approved change. */
export function ChangeLog() {
  const [category, setCategory] = useState('');
  // The first page and every older page belong to one filter. Each answer carries the filter it was asked for, and is
  // used only if that is still the filter on screen, so a slow answer for an old filter can never mix into a new one.
  const [view, setView] = useState<{ category: string; entries: ChangeEntry[]; next: number | null } | null>(null);
  const shown = useRef(category); shown.current = category;
  const asked = useRef(0);
  const [error, setError] = useState<unknown>(null);
  const [pending, setPending] = useState(false);
  const fetchPage = async (cat: string, before: number | null) =>
    api<ChangeLogPage>('GET', `/internal/change-log?limit=50${before ? `&before=${before}` : ''}${cat ? `&category=${cat}` : ''}`);
  useEffect(() => {
    const mine = ++asked.current; setView(null); setError(null);
    fetchPage(category, null).then((p) => { if (mine === asked.current) setView({ category, entries: p.entries, next: p.next }); }, (e) => { if (mine === asked.current) setError(e); });
  }, [category]);
  const loadMore = async () => {
    if (!view || view.next === null || view.category !== shown.current) return;
    const mine = asked.current; setPending(true);
    try {
      const p = await fetchPage(view.category, view.next);
      if (mine === asked.current) setView((v) => (v && v.category === view.category ? { ...v, entries: [...v.entries, ...p.entries], next: p.next } : v));
    } catch (e) { if (mine === asked.current) setError(e); }
    finally { setPending(false); }
  };
  const entries = view?.entries ?? [];

  return (
    <>
      <h1>Change log</h1>
      <p className="muted">Every change made to the platform, who made it and why. The reason is the one given when the change was made; a change that was given none says so.</p>
      <label>Show <select aria-label="Show" value={category} onChange={(e) => setCategory(e.target.value)}>
        {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select></label>
      <Errors error={error} />
      {view && (entries.length === 0 ? <p className="muted">Nothing yet.</p> : (
        <table aria-label="Changes">
          <thead><tr><th>When</th><th>What</th><th>Who</th><th>Why</th></tr></thead>
          <tbody>{entries.map((e) => (
            <tr key={e.id}>
              <td>{fmtDate(e.at)}</td>
              <td>{e.link ? <a href={e.link}>{e.action}</a> : e.action}{Object.keys(e.detail).length > 0 && <div className="muted">{JSON.stringify(e.detail)}</div>}</td>
              <td>{e.who}</td>
              <td>{e.why ?? <span className="muted">No reason recorded</span>}</td>
            </tr>
          ))}</tbody>
        </table>
      ))}
      {view && view.next !== null && <button disabled={pending} onClick={loadMore}>Show older changes</button>}
    </>
  );
}
