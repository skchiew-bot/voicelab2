import { useState } from 'react';
import { api, type FxRate, type ModelRate, type RateCard } from './api';
import { Errors, Field, fmtDate, fmtDecimal, useAction, useLoad } from './ui';

function Fx() {
  const rates = useLoad(() => api<FxRate[]>('GET', '/internal/fx'));
  const [currency, setCurrency] = useState('MYR');
  const [perUsd, setPerUsd] = useState('');
  const [from, setFrom] = useState('');
  const { pending, error, run } = useAction();
  const hasMyr = rates.data?.some((r) => r.currency === 'MYR');
  return (
    <section className="card">
      <h2>FX rates</h2>
      <p className="muted">Units of a currency per 1 USD, so MYR 4.5 means 1 USD = 4.5 MYR. A new rate never changes a past call. <strong>MYR is needed to cost any call.</strong></p>
      <Errors error={rates.error} />
      {rates.data && !hasMyr && <div className="notice" role="status">No MYR rate yet: calls cannot be costed until one is added.</div>}
      {rates.data && rates.data.length > 0 && (
        <table>
          <thead><tr><th>Currency</th><th>Per 1 USD</th><th>Effective from</th></tr></thead>
          <tbody>{rates.data.map((r) => <tr key={r.id}><td>{r.currency}</td><td>{fmtDecimal(r.per_usd)}</td><td>{fmtDate(r.effective_from)}</td></tr>)}</tbody>
        </table>
      )}
      <form className="grid" aria-label="Add FX rate" onSubmit={async (e) => {
        e.preventDefault();
        if (await run(() => api('POST', '/internal/fx', { currency, perUsd, effectiveFrom: new Date(from).toISOString() }))) { setPerUsd(''); rates.reload(); }
      }}>
        <Field label="Currency"><input maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} required /></Field>
        <Field label="Per 1 USD"><input inputMode="decimal" value={perUsd} onChange={(e) => setPerUsd(e.target.value)} required /></Field>
        <Field label="Effective from (your local time)"><input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} required /></Field>
        <div><button type="submit" disabled={pending}>Add rate</button></div>
      </form>
      <Errors error={error} />
    </section>
  );
}

function Card() {
  const cards = useLoad(() => api<RateCard[]>('GET', '/internal/rate-card'));
  const [inbound, setInbound] = useState('');
  const [outbound, setOutbound] = useState('');
  const [value, setValue] = useState('');
  const [from, setFrom] = useState('');
  const { pending, error, run } = useAction();
  return (
    <section className="card">
      <h2>Client rate card</h2>
      <p className="muted">Credits a client is charged per billed minute. The meter uses the provider's billing increment, so short calls cannot leak margin. <strong>Credits stay at zero until a rate card exists.</strong></p>
      <Errors error={cards.error} />
      {cards.data && cards.data.length === 0 && <div className="notice" role="status">No rate card yet: every call draws zero credits.</div>}
      {cards.data && cards.data.length > 0 && (
        <table>
          <thead><tr><th>Effective from</th><th>Inbound / min</th><th>Outbound / min</th><th>Credit value (USD)</th></tr></thead>
          <tbody>{cards.data.map((r) => (
            <tr key={r.id}><td>{fmtDate(r.effective_from)}</td><td>{fmtDecimal(r.inbound_credits_per_minute)}</td><td>{fmtDecimal(r.outbound_credits_per_minute)}</td><td>{fmtDecimal(r.credit_value_usd)}</td></tr>
          ))}</tbody>
        </table>
      )}
      <form className="grid" aria-label="Add rate card" onSubmit={async (e) => {
        e.preventDefault();
        const ok = await run(() => api('POST', '/internal/rate-card', {
          effectiveFrom: new Date(from).toISOString(), inboundCreditsPerMinute: inbound, outboundCreditsPerMinute: outbound, creditValueUsd: value,
        }));
        if (ok) { setInbound(''); setOutbound(''); setValue(''); cards.reload(); }
      }}>
        <Field label="Inbound credits per minute"><input inputMode="decimal" value={inbound} onChange={(e) => setInbound(e.target.value)} required /></Field>
        <Field label="Outbound credits per minute"><input inputMode="decimal" value={outbound} onChange={(e) => setOutbound(e.target.value)} required /></Field>
        <Field label="Value of one credit (USD)" help="Used for margin."><input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} required /></Field>
        <Field label="Effective from (your local time)"><input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} required /></Field>
        <div><button type="submit" disabled={pending}>Add rate card</button></div>
      </form>
      <Errors error={error} />
    </section>
  );
}

function Models() {
  const rates = useLoad(() => api<ModelRate[]>('GET', '/internal/model-rates'));
  const [model, setModel] = useState('');
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [from, setFrom] = useState('');
  const { pending, error, run } = useAction();
  return (
    <section className="card" aria-label="Model rates">
      <h2>Model rates</h2>
      <p className="muted">What each model costs per million tokens, as its provider names it. A call's model decisions are priced at the rate in force when the call started; a new rate never changes a past call. <strong>A call whose model has no rate cannot be costed.</strong></p>
      <Errors error={rates.error} />
      {rates.data && rates.data.length === 0 && <div className="notice" role="status">No model rates yet: a call that used a model cannot be costed until its rate is added.</div>}
      {rates.data && rates.data.length > 0 && (
        <table>
          <thead><tr><th>Model</th><th>Input / 1M tokens</th><th>Output / 1M tokens</th><th>Effective from</th></tr></thead>
          <tbody>{rates.data.map((r) => (
            <tr key={r.id}><td>{r.model}</td><td>{fmtDecimal(r.input_per_1m)} {r.currency}</td><td>{fmtDecimal(r.output_per_1m)} {r.currency}</td><td>{fmtDate(r.effective_from)}</td></tr>
          ))}</tbody>
        </table>
      )}
      <form className="grid" aria-label="Add model rate" onSubmit={async (e) => {
        e.preventDefault();
        const ok = await run(() => api('POST', '/internal/model-rates', { model: model.trim(), inputPer1m: input.trim(), outputPer1m: output.trim(), currency, effectiveFrom: new Date(from).toISOString() }));
        if (ok) { setInput(''); setOutput(''); rates.reload(); }
      }}>
        <Field label="Model" help="As the provider names it, the same name the model decisions log."><input value={model} onChange={(e) => setModel(e.target.value)} required /></Field>
        <Field label="Input per 1M tokens"><input inputMode="decimal" value={input} onChange={(e) => setInput(e.target.value)} required /></Field>
        <Field label="Output per 1M tokens"><input inputMode="decimal" value={output} onChange={(e) => setOutput(e.target.value)} required /></Field>
        <Field label="Currency"><input maxLength={3} value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase())} required /></Field>
        <Field label="Effective from (your local time)"><input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} required /></Field>
        <div><button type="submit" disabled={pending}>Add model rate</button></div>
      </form>
      <Errors error={error} />
    </section>
  );
}

export function Rates() {
  return <><h1>Rates</h1><Fx /><Card /><Models /></>;
}
