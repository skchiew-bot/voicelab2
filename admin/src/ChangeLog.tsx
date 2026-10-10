import { useRef, useState } from 'react';
import { api, type ChangeEntry, type ChangeLogPage } from './api';
import { Errors, fmtDate, useLoad } from './ui';

const CATEGORIES: [string, string][] = [
  ['', 'Every change'], ['workflows', 'Workflows'], ['money', 'Money and rates'], ['providers', 'Providers and capacity'], ['compliance', 'Do not call'],
  ['policy', 'Policy and knowledge'], ['learning', 'Learning loop'], ['journey', 'Journey and QA'], ['modules', 'Cases and appointments'], ['people', 'Clients and people'],
  ['activity', 'Day-to-day activity (not changes)'],
];

/** Every change made to the platform: what, who and why, newest first. A workflow change is rolled back from its own screen, through an approved change. */
export function ChangeLog() {
  const [category, setCategory] = useState('');
  const shown = useRef(category); shown.current = category;   // an older page that arrives after the filter changed is dropped
  const [pages, setPages] = useState<ChangeEntry[][]>([]);
  const [next, setNext] = useState<number | null>(null);
  const first = useLoad(async () => {
    const p = await api<ChangeLogPage>('GET', `/internal/change-log?limit=50${category ? `&category=${category}` : ''}`);
    setPages([]); setNext(p.next); return p;
  }, [category]);
  const [more, setMore] = useState<{ pending: boolean; error: unknown }>({ pending: false, error: null });
  const loadMore = async () => {
    if (next === null) return;
    const asked = category;
    setMore({ pending: true, error: null });
    try {
      const p = await api<ChangeLogPage>('GET', `/internal/change-log?limit=50&before=${next}${category ? `&category=${category}` : ''}`);
      if (shown.current !== asked) return;
      setPages((x) => [...x, p.entries]); setNext(p.next); setMore({ pending: false, error: null });
    } catch (e) { if (shown.current === asked) setMore({ pending: false, error: e }); }
  };
  const entries = [...(first.data?.entries ?? []), ...pages.flat()];

  return (
    <>
      <h1>Change log</h1>
      <p className="muted">Every change made to the platform, who made it and why. The reason is the one given when the change was made; a change that was given none says so.</p>
      <label>Show <select aria-label="Show" value={category} onChange={(e) => setCategory(e.target.value)}>
        {CATEGORIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select></label>
      <Errors error={first.error} />
      {first.data && (entries.length === 0 ? <p className="muted">Nothing yet.</p> : (
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
      <Errors error={more.error} />
      {next !== null && <button disabled={more.pending} onClick={loadMore}>Show older changes</button>}
    </>
  );
}
