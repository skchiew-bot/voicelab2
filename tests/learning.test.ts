import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db.js';
import { parseKey } from '../src/secrets.js';
import { replyRun, startRun, type RunDeps } from '../src/store/runs.js';
import { sweepAudio, type Council, type Recorder } from '../src/store/learning.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';
import type { SpeakerResult } from '../src/workflows/engine.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let wfId: string; let voiceId: string; let runDeps: RunDeps;
let modelCalls = 0;
const st = () => env.staffToken;
const get = (u: string) => env.call(st(), 'GET', u);
const post = (u: string, b?: unknown) => env.call(st(), 'POST', u, b);
const put = (u: string, b?: unknown) => env.call(st(), 'PUT', u, b);
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}

const flow: WorkflowDefinition = {
  start: 'ask', variables: ['name', 'amount'],
  nodes: {
    ask: { type: 'speak', speech: 'dynamic', prompt: 'Ask the caller to pay this week', text: 'Hello {{name}}, can you pay this week?', listen: { captureAs: 'a', intents: { yes: ['yes'], no: ['no'] } },
      transitions: [{ when: { var: 'a_intent', op: 'eq', value: 'yes' }, to: 'thanks' }, { to: 'done' }] },
    thanks: { type: 'speak', speech: 'fixed', text: 'Thank you very much.', transitions: [{ to: 'done' }] },
    done: { type: 'end', outcome: 'ok' },
  },
};

// A model that words the line a little differently now and then. Names and amounts are fixed-width so the arithmetic below is exact.
const speaker: RunDeps['speaker'] = {
  generate: async (node, vars): Promise<string | SpeakerResult> => {
    modelCalls++;
    if (node.prompt === 'Ask for payment this week') return `Good day ${vars.name}, your balance is ${vars.amount}. Kindly settle it this week.`;
    return `Hello ${vars.name}, you owe ${vars.amount}. Can you pay this week?`;
  },
};
const wav = () => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(16)]).toString('base64');
const made: string[] = [];
const recorder: Recorder = { record: async (_lang, text) => { made.push(text); return { contentType: 'audio/wav', audioBase64: wav(), durationMs: 800 }; } };
const council = (tier: 'opus', model: string, pass: boolean, confidence: number): Council => ({ tier, model, review: async () => ({ pass, confidence, concerns: pass ? [] : ['It reads as a threat.'], inputTokens: 300, outputTokens: 30 }) });
let quality = council('opus', 'q-opus', true, 0.95); let cx = council('opus', 'cx-opus', true, 0.93);
const councils = { council_quality: { opus: { tier: 'opus', model: 'q-opus', review: (i: Parameters<Council['review']>[0]) => quality.review(i) } as Council }, council_cx: { opus: { tier: 'opus', model: 'cx-opus', review: (i: Parameters<Council['review']>[0]) => cx.review(i) } as Council } };

const NAMES = ['Aisha', 'Bobby', 'Chong', 'Devan', 'Emily', 'Farid'];
let seq = 0;
/** One call through the node: the model words it, the caller answers. */
async function call(answer: string) {
  const name = NAMES[seq % NAMES.length]!; const amount = String(100 + ((seq * 37) % 800)); seq++;
  const r = await startRun(runDeps, null, { workflowId: wfId, environment: 'staging', kind: 'test', variables: { name, amount } });
  await replyRun(runDeps, r.id, answer);
  return r.id;
}
const steps = async (runId: string) => (await env.pool.query(`SELECT type, node, payload FROM workflow_run_steps WHERE run_id = $1 ORDER BY seq`, [runId])).rows;
const promotions = async (status?: string) => (await get(`/internal/tenants/${tenantId}/learning/promotions${status ? `?status=${status}` : ''}`)).json() as { id: string; status: string; node: string; script: string }[];

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb({ learning: { recorder, councils: councils as never } });
  runDeps = { pool: env.pool, key: parseKey(env.config.VOICELAB_SECRET_KEY), speaker };
  tenantId = (await must(post('/internal/tenants', { name: 'Learning Co' }))).json().id;
  voiceId = (await must(post('/internal/providers', { adapterKey: 'elevenlabs', name: 'el', params: { apiKey: 'k' } }))).json().id;
  await must(post(`/internal/providers/${voiceId}/charging`, { effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1, components: [{ component: 'tts', unit: 'per_1k_characters', rate: '0.30', currency: 'USD' }] }));
  const c = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'learn_flow', definition: flow }))).json();
  wfId = c.workflow.id;
  await must(post(`/internal/workflows/${wfId}/deploy`, { versionId: c.version.id, environment: 'staging' }));
  await must(put(`/internal/tenants/${tenantId}/learning/config`, { minSupport: 5, driftMinSamples: 5, voiceProviderId: voiceId }));
  await must(put('/internal/model-config/council_quality', { tier: 'opus', modelId: 'q-opus', escalateTo: null }));
  await must(put('/internal/model-config/council_cx', { tier: 'opus', modelId: 'cx-opus', escalateTo: null }));
});
afterAll(async () => { await env?.teardown(); });

describe('logging, clustering and distilling', () => {
  it('logs every dynamic line with its context and the values put back as slots, and shows clusters short of the threshold', async () => {
    for (let i = 0; i < 3; i++) await call('yes thanks');
    const rows = (await env.pool.query(`SELECT text, context_kind, synth_chars, slot_chars FROM learning_turns WHERE tenant_id = $1`, [tenantId])).rows;
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ text: 'Hello {{name}}, you owe {{amount}}. Can you pay this week?', context_kind: 'start', synth_chars: 48, slot_chars: 8 });
    const report = (await get(`/internal/tenants/${tenantId}/learning`)).json();
    expect(report.threshold).toBe(5);
    expect(report.clusters[0]).toMatchObject({ node: 'ask', support: 3, ready: false, percentOfThreshold: 60 });
    expect((await post(`/internal/tenants/${tenantId}/learning/scan`, {})).json().created).toEqual([]);          // not enough evidence yet
    await expect(env.pool.query('UPDATE learning_turns SET text = $1', ['x'])).rejects.toThrow(/append-only/);
  });

  it('keeps simulations out of the evidence', async () => {
    const before = (await env.pool.query('SELECT count(*)::int AS n FROM learning_turns')).rows[0].n;
    await must(post(`/internal/workflows/${wfId}/simulate`, { scenarios: [{ name: 's', variables: { name: 'Aisha', amount: '350' }, replies: ['yes'], expect: { outcome: 'ok' } }] }));
    expect((await env.pool.query('SELECT count(*)::int AS n FROM learning_turns')).rows[0].n).toBe(before);
  });
});

describe('promotion', () => {
  it('draws up one script once a cluster passes the threshold, and does not draw up a second while one is open', async () => {
    for (let i = 0; i < 3; i++) await call('yes thanks');
    const out = (await must(post(`/internal/tenants/${tenantId}/learning/scan`, {}))).json();
    expect(out.created).toHaveLength(1);
    const [p] = await promotions();
    expect(p).toMatchObject({ status: 'in_review', node: 'ask', script: 'Hello {{name}}, you owe {{amount}}. Can you pay this week?' });
    const full = (await get(`/internal/promotions/${p!.id}`)).json();
    expect(full).toMatchObject({ support: 6, variants: 1, slots: expect.arrayContaining(['name', 'amount']), distilled_by: 'rules' });
    expect(full.events.map((e: { kind: string }) => e.kind)).toEqual(['distilled']);
    expect((await post(`/internal/tenants/${tenantId}/learning/scan`, {})).json().created).toEqual([]);
  });

  it('promotes automatically when both councils pass with high confidence, records the audio, and leaves an audit trail', async () => {
    const [p] = await promotions('in_review');
    const out = (await must(post(`/internal/promotions/${p!.id}/review`))).json();
    expect(out.status).toBe('promoted');
    expect(out.events.map((e: { kind: string }) => e.kind)).toEqual(['distilled', 'reviewed', 'reviewed', 'approved', 'recorded', 'promoted']);
    expect(out.events.find((e: { kind: string }) => e.kind === 'approved').detail).toMatchObject({ automatic: true });
    expect([...made].sort()).toEqual([', you owe', '. Can you pay this week?', 'Hello']);                                       // only the fixed words are recorded
    const decisions = (await get(`/internal/ai-decisions?subjectType=promotion&subjectId=${p!.id}`)).json();
    expect(decisions.map((d: { task: string; model: string; tier: string; input_tokens: number }) => [d.task, d.model, d.tier, d.input_tokens]).sort())
      .toEqual([['council_cx', 'cx-opus', 'opus', 300], ['council_quality', 'q-opus', 'opus', 300]]);
    const audit = await env.pool.query(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id`, [p!.id]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['learning.distil', 'learning.review', 'learning.promote']));
    await expect(env.pool.query('DELETE FROM promotion_events')).rejects.toThrow(/append-only/);
    await expect(env.pool.query(`UPDATE promotions SET script = 'x'`)).rejects.toThrow(/append-only/);
  });

  it('plays the script from then on: the model is not asked, recordings play, and only the slots are synthesised', async () => {
    const before = modelCalls;
    const runId = await call('yes thanks');
    expect(modelCalls).toBe(before);
    const say = (await steps(runId)).find((s) => s.type === 'say' && s.node === 'ask')!.payload;
    expect(say.promotion).toBeTruthy();
    expect(say).toMatchObject({ synthChars: 8, recordedChars: 38 });
    expect(say.text).toMatch(/^Hello \w+, you owe \d+\. Can you pay this week\?$/);
    const kinds = say.segments.map((s: { kind: string }) => s.kind);
    expect(kinds.filter((k: string) => k === 'recorded')).toHaveLength(3);
    expect((await env.pool.query(`SELECT count(*)::int AS n FROM learning_turns WHERE tenant_id = $1`, [tenantId])).rows[0].n).toBe(6);   // a promoted line is not new evidence
  });

  it('shows the cost change, worked out exactly', async () => {
    const [p] = await promotions('promoted');
    const f = (await get(`/internal/promotions/${p!.id}/financial`)).json();
    expect(f.perUse).toEqual({ liveBefore: { chars: 48, costUsd: '0.01440000' }, afterPromotion: { chars: 8, costUsd: '0.00240000' }, saved: { chars: 40, costUsd: '0.01200000' } });
    expect(f.oneTime).toMatchObject({ chars: 38, costUsd: '0.01140000' });
    expect(f.breakEvenUses).toBe(1);
    expect(f.usesWhilePromoted).toBe(1);
    expect(f.realisedSavingUsd).toBe('0.01200000');
    const promoted = (await get(`/internal/promotions/${p!.id}`)).json().events.find((e: { kind: string }) => e.kind === 'promoted');
    expect(promoted.detail.financial.perUse.saved.costUsd).toBe('0.01200000');           // recorded at the time of promotion too
  });
});

describe('drift', () => {
  it('leaves a script alone while callers react as well as before', async () => {
    const [p] = await promotions('promoted');
    for (let i = 0; i < 5; i++) await call('yes thanks');
    const r = (await must(post(`/internal/promotions/${p!.id}/drift-check`))).json();
    expect(r.verdict).toMatchObject({ drifted: false, judged: true });
    expect(r.promotion.status).toBe('promoted');
  });

  it('demotes a script whose callers turn unhappy, assembles a replay, and shows the cost change the other way', async () => {
    const [p] = await promotions('promoted');
    const bad: string[] = [];
    for (let i = 0; i < 12; i++) bad.push(await call('no, that is bad'));
    const r = (await must(post(`/internal/promotions/${p!.id}/drift-check`))).json();
    expect(r.verdict.drifted).toBe(true);
    expect(r.verdict.reasons.join(' ')).toContain('mood fell');
    expect(r.promotion.status).toBe('demoted');
    const events = r.promotion.events as { kind: string; reason: string; detail: Record<string, unknown> }[];
    expect(events.slice(-3).map((e) => e.kind)).toEqual(['drift_detected', 'demoted', 'regenerated']);
    const demoted = events.find((e) => e.kind === 'demoted')!;
    const replays = demoted.detail.replays as { runId: string; sentiment: number }[];
    expect(replays.length).toBeGreaterThan(0);
    expect(replays.length).toBeLessThanOrEqual(5);
    expect(replays.every((x) => bad.includes(x.runId) && x.sentiment < 0)).toBe(true);        // the worst calls, ready to open as replays
    const fin = demoted.detail.financial as { direction: string; perUse: { saved: { costUsd: string } }; usesWhilePromoted: number; realisedSavingUsd: string };
    expect(fin).toMatchObject({ direction: 'demote', usesWhilePromoted: 18, realisedSavingUsd: '0.21600000' });   // 18 uses at 0.012
    expect(fin.perUse.saved.costUsd).toBe('0.01200000');
    const audit = await env.pool.query(`SELECT action FROM audit_log WHERE entity_id = $1`, [p!.id]);
    expect(audit.rows.map((x) => x.action)).toContain('learning.demote_drift');
    const alerts = (await get('/internal/control-tower')).json().alerts as { code: string }[];
    expect(alerts.map((a) => a.code)).toContain('learning_drift');
  });

  it('asks the model again once demoted, and waits for fresh evidence before drawing up another script', async () => {
    const before = modelCalls;
    await call('yes thanks');
    expect(modelCalls).toBe(before + 1);
    expect((await post(`/internal/tenants/${tenantId}/learning/scan`, {})).json().created).toEqual([]);   // one fresh turn is not enough
    for (let i = 0; i < 5; i++) await call('yes thanks');
    const again = (await post(`/internal/tenants/${tenantId}/learning/scan`, {})).json();
    expect(again.created).toHaveLength(0);                                                              // the same script is not offered twice
    expect(again.skipped[0].reason).toContain('already proposed');
  });
});

describe('when the councils do not simply pass it', () => {
  it('turns a script down when a council clearly fails it, and does not offer it again', async () => {
    const wf2 = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'learn_two', definition: { ...flow, nodes: { ...flow.nodes, ask: { ...flow.nodes.ask!, prompt: 'Ask nicely for payment' } } } }))).json();
    await must(post(`/internal/workflows/${wf2.workflow.id}/deploy`, { versionId: wf2.version.id, environment: 'staging' }));
    for (let i = 0; i < 6; i++) {
      const r = await startRun(runDeps, null, { workflowId: wf2.workflow.id, environment: 'staging', kind: 'test', variables: { name: NAMES[i]!, amount: String(200 + i) } });
      await replyRun(runDeps, r.id, 'yes thanks');
    }
    const out = (await must(post(`/internal/tenants/${tenantId}/learning/scan`, { workflow: 'learn_two' }))).json();
    expect(out.created).toHaveLength(1);
    quality = council('opus', 'q-opus', false, 0.97);
    const r = (await must(post(`/internal/promotions/${out.created[0]}/review`))).json();
    expect(r.status).toBe('rejected');
    expect(r.events.at(-1).reason).toContain('It reads as a threat.');
    quality = council('opus', 'q-opus', true, 0.95);
    expect((await post(`/internal/tenants/${tenantId}/learning/scan`, { workflow: 'learn_two' })).json().created).toEqual([]);
  });

  it('leaves a low-confidence pass for a person, who can approve it; it stays approved, still live, until its audio exists', async () => {
    const wf3 = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'learn_three', definition: { ...flow, nodes: { ...flow.nodes, ask: { ...flow.nodes.ask!, prompt: 'Ask for payment this week' } } } }))).json();
    await must(post(`/internal/workflows/${wf3.workflow.id}/deploy`, { versionId: wf3.version.id, environment: 'staging' }));
    for (let i = 0; i < 6; i++) {
      const r = await startRun(runDeps, null, { workflowId: wf3.workflow.id, environment: 'staging', kind: 'test', variables: { name: NAMES[i]!, amount: String(300 + i) } });
      await replyRun(runDeps, r.id, 'yes thanks');
    }
    const id = (await post(`/internal/tenants/${tenantId}/learning/scan`, { workflow: 'learn_three' })).json().created[0] as string;
    cx = council('opus', 'cx-opus', true, 0.6);
    const waiting = (await must(post(`/internal/promotions/${id}/review`))).json();
    expect(waiting.status).toBe('in_review');                                                    // not confident enough to go on its own
    cx = council('opus', 'cx-opus', true, 0.93);
    expect((await post(`/internal/promotions/${id}/decision`, { decision: 'rejected' })).statusCode).toBe(400);   // a refusal needs a reason
    // No recorder: the audio is added by hand. Take the recorder away for this one.
    const realRecord = recorder.record; (recorder as { record: Recorder['record'] }).record = async () => { throw new Error('no voice provider'); };
    const failed = await post(`/internal/promotions/${id}/decision`, { decision: 'approved', note: 'Sounds right.' });
    (recorder as { record: Recorder['record'] }).record = realRecord;
    expect(failed.statusCode).toBeGreaterThanOrEqual(400);
    expect((await get(`/internal/promotions/${id}`)).json().status).toBe('approved');           // approved, not promoted
    const done = (await must(post('/internal/learning/sweep'))).json();
    expect(done.promoted).toContain(id);                                                            // the sweep made the missing audio and promoted it
    expect((await get(`/internal/promotions/${id}`)).json().status).toBe('promoted');
    void sweepAudio; void withActor;
  });
});

describe('a node changed after its script was written', () => {
  it('is demoted at once: the script was written for words that are no longer there', async () => {
    const [p] = (await promotions('promoted')).filter((x) => x.script.startsWith('Good day'));
    const wf = (await env.pool.query(`SELECT id FROM workflows WHERE name = 'learn_three'`)).rows[0].id as string;
    const v2 = (await must(post(`/internal/workflows/${wf}/versions`, { definition: { ...flow, nodes: { ...flow.nodes, ask: { ...flow.nodes.ask!, prompt: 'Ask for payment this week', text: 'Hello {{name}}, may we have your payment this week?' } } } }))).json();
    await must(post(`/internal/workflows/${wf}/deploy`, { versionId: v2.id, environment: 'staging' }));
    const r = await startRun(runDeps, null, { workflowId: wf, environment: 'staging', kind: 'test', variables: { name: 'Aisha', amount: '350' } });
    await replyRun(runDeps, r.id, 'yes thanks');
    const out = (await must(post(`/internal/promotions/${p!.id}/drift-check`))).json();
    expect(out.verdict).toMatchObject({ drifted: true, judged: false });                        // not enough calls to judge by mood, but the node itself changed
    expect(out.verdict.reasons[0]).toContain('node was changed');
    expect(out.promotion.status).toBe('demoted');
  });
});

describe('a model that writes the script', () => {
  it('is asked first at the small tier, a stronger one when it is unsure, both are recorded, and a script that fails the rules gives way to the callers\' own wording', async () => {
    const wf4 = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'learn_four', definition: { ...flow, nodes: { ...flow.nodes, ask: { ...flow.nodes.ask!, prompt: 'Ask for money this week' } } } }))).json();
    await must(post(`/internal/workflows/${wf4.workflow.id}/deploy`, { versionId: wf4.version.id, environment: 'staging' }));
    for (let i = 0; i < 6; i++) {
      const r = await startRun(runDeps, null, { workflowId: wf4.workflow.id, environment: 'staging', kind: 'test', variables: { name: NAMES[i]!, amount: String(400 + i) } });
      await replyRun(runDeps, r.id, 'yes thanks');
    }
    await must(put('/internal/model-config/distill_script', { tier: 'sonnet', modelId: 'sonnet-model', escalateTo: 'opus' }));
    const asked: string[] = [];
    const mk = (tier: 'sonnet' | 'opus', confidence: number, script: string) => ({ tier, model: `${tier}-model`, distill: async () => { asked.push(tier); return { script, confidence, inputTokens: 500, outputTokens: 50 }; } });
    const { distil } = await import('../src/store/learning.js');
    // sonnet is unsure; opus writes a script that uses a variable the workflow does not have, so the rules turn it down and the callers' own wording is used
    const out = await distil({ pool: env.pool, distillers: { sonnet: mk('sonnet', 0.4, 'Hello {{name}}, please pay.'), opus: mk('opus', 0.95, 'Hello {{who}}, you owe {{debt}} so please pay this week.') } }, null, { tenantId, workflow: 'learn_four' });
    expect(asked).toEqual(['sonnet', 'opus']);
    expect(out.created).toHaveLength(1);
    const p = (await get(`/internal/promotions/${out.created[0]}`)).json();
    expect(p).toMatchObject({ script: 'Hello {{name}}, you owe {{amount}}. Can you pay this week?', distilled_by: 'rules' });
    const decisions = (await get(`/internal/ai-decisions?subjectType=promotion&subjectId=${out.created[0]}`)).json();
    expect(decisions.map((d: { tier: string; escalated_from: string | null; input_tokens: number }) => [d.tier, d.escalated_from, d.input_tokens]).sort()).toEqual([['opus', 'sonnet', 500], ['sonnet', null, 500]]);
  });
});
