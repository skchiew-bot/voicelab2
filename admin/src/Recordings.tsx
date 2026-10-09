import { useEffect, useRef, useState } from 'react';
import { api, apiObjectUrl, type Recording, type Tenant } from './api';
import { Errors, Field, useAction, useLoad } from './ui';

const TYPES: Record<string, string> = { 'audio/wav': 'audio/wav', 'audio/mpeg': 'audio/mpeg', 'audio/ogg': 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg' };
const toBase64 = (buf: ArrayBuffer) => {
  let s = ''; const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

function Play({ id }: { id: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const act = useAction();
  const audio = useRef<HTMLAudioElement>(null);
  useEffect(() => () => { if (url) URL.revokeObjectURL(url); }, [url]);
  useEffect(() => { void audio.current?.play().catch(() => undefined); }, [url]);
  return (
    <>
      {url ? <audio ref={audio} controls src={url} aria-label="Recording" /> : <button type="button" className="secondary" disabled={act.pending} onClick={async () => { const u = await act.run(() => apiObjectUrl(`/internal/recordings/${id}/audio`)); if (u) setUrl(u); }}>Play</button>}
      <Errors error={act.error} />
    </>
  );
}

export function Recordings() {
  const tenants = useLoad(() => api<Tenant[]>('GET', '/internal/tenants'));
  const [tenantId, setTenantId] = useState('');
  const list = useLoad(() => (tenantId ? api<Recording[]>('GET', `/internal/tenants/${tenantId}/recordings`) : Promise.resolve([])), [tenantId]);
  const [language, setLanguage] = useState('en');
  const [text, setText] = useState('');
  const [label, setLabel] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [seconds, setSeconds] = useState('');
  const { pending, error, run } = useAction();

  const pick = (f: File | null) => {
    setFile(f); setSeconds('');
    if (!f) return;
    // The browser can read how long the audio is; if it cannot, the operator types it.
    const url = URL.createObjectURL(f); const a = new Audio(url);
    a.onloadedmetadata = () => { if (Number.isFinite(a.duration)) setSeconds(a.duration.toFixed(2)); URL.revokeObjectURL(url); };
    a.onerror = () => URL.revokeObjectURL(url);
  };

  return (
    <>
      <h1>Recordings</h1>
      <p className="muted">Pre-recorded audio for the fixed words of a workflow. A recording is for exact words in one language, so what is played is always what the workflow says. A call plays it instead of synthesising those words, which costs nothing; names and amounts are still spoken live. Record the words around a slot ("Hello", ", this is Voice Lab"), not the slot. A new take of the same words becomes the new version; the old one is kept.</p>
      <Errors error={tenants.error ?? list.error} />
      <Field label="Client">
        <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
          <option value="">Choose…</option>{tenants.data?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </Field>
      {tenantId && list.data && (list.data.length === 0 ? <p className="muted">No recordings for this client yet.</p> : (
        <table>
          <thead><tr><th>Words</th><th>Language</th><th>Version</th><th>Length</th><th>Play</th></tr></thead>
          <tbody>{list.data.map((r) => (
            <tr key={r.id}><td>{r.text}</td><td>{r.language}</td><td>{r.version}</td><td>{(r.duration_ms / 1000).toFixed(1)} s</td><td><Play id={r.id} /></td></tr>
          ))}</tbody>
        </table>
      ))}
      {tenantId && (
        <form className="card" aria-label="Add recording" onSubmit={async (e) => {
          e.preventDefault();
          if (!file) return;
          const contentType = TYPES[file.type] ?? TYPES[file.name.split('.').pop()?.toLowerCase() ?? ''];
          const ok = await run(async () => {
            if (!contentType) throw new Error('Use a WAV, MP3 or OGG file.');
            const durationMs = Math.round(Number(seconds) * 1000);
            if (!Number.isFinite(durationMs) || durationMs <= 0) throw new Error('Say how long the recording is, in seconds.');
            return api('POST', `/internal/tenants/${tenantId}/recordings`, { language, text, label: label || undefined, contentType, audioBase64: toBase64(await file.arrayBuffer()), durationMs });
          });
          if (ok) { setText(''); setLabel(''); setFile(null); setSeconds(''); list.reload(); }
        }}>
          <h2>Add a recording</h2>
          <div className="grid">
            <Field label="Words spoken" help="Exactly what the recording says. No {{slots}}."><textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} required /></Field>
            <Field label="Language" help="e.g. en, ms."><input value={language} onChange={(e) => setLanguage(e.target.value.toLowerCase())} required /></Field>
            <Field label="Audio file" help="WAV, MP3 or OGG, up to 5 MB."><input type="file" accept=".wav,.mp3,.ogg,audio/*" onChange={(e) => pick(e.target.files?.[0] ?? null)} required /></Field>
            <Field label="Length (seconds)" help="Filled in from the file when the browser can read it."><input value={seconds} onChange={(e) => setSeconds(e.target.value)} inputMode="decimal" required /></Field>
            <Field label="Label (optional)"><input value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
          </div>
          <Errors error={error} />
          <div><button type="submit" disabled={pending}>Save recording</button></div>
        </form>
      )}
    </>
  );
}
