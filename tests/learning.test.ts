import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db.js';
import { parseKey } from '../src/secrets.js';
import { replyRun, startRun, type RunDeps } from '../src/store/runs.js';
import { sweepAudio, type Council, type Recorder } from '../src/store/learning.js';
import { CLUSTER_CACHE } from '../src/store/panels.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';
import type { SpeakerResult } from '../src/workflows/engine.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let wfId: string; let voiceId: string; let runDeps: RunDeps;
let modelCalls = 0; let otherAdmin: string; let projectId: string; let twilioId: string; let numberId: string;
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
    if (node.prompt === 'Ask for money this week') return `Dear ${vars.name}, kindly note ${vars.amount} is outstanding on your account.`;
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
  const r = await startRun(runDeps, null, { workflowId: wfId, environment: 'production', kind: 'live', variables: { name, amount }, callId: await newCall(wfId) });
  await replyRun(runDeps, r.id, answer);
  return r.id;
}
/** A call as the dial path leaves it, for a live run to belong to: only live calls are evidence. */
async function newCall(workflowId: string) {
  const id = randomUUID();
  await env.pool.query(
    `INSERT INTO calls (id, tenant_id, project_id, provider_id, provider_call_id, direction, status, country, from_number_id, workflow_id, cost_status)
     VALUES ($1,$2,$3,$4,$5,'outbound','in_progress','MY',$6,$7,'pending')`, [id, tenantId, projectId, twilioId, `CA_learn_${id.slice(0, 8)}`, numberId, workflowId]);
  return id;
}
/** Put a version live as the gates require: in staging, rehearsed there, then in production. Only live calls are evidence. */
async function goLive(workflowId: string, versionId: string) {
  await must(post(`/internal/workflows/${workflowId}/deploy`, { versionId, environment: 'staging' }));
  const sim = (await must(post(`/internal/workflows/${workflowId}/simulate`, { versionId, scenarios: [{ name: 's', variables: { name: 'Aisha', amount: '350' }, replies: ['yes'], expect: { outcome: 'ok' } }] }))).json();
  if (!sim.results.every((r: { passed: boolean }) => r.passed)) throw new Error(`rehearsal failed: ${JSON.stringify(sim.results)}`);
  await must(post(`/internal/workflows/${workflowId}/deploy`, { versionId, environment: 'production' }));
}
const steps = async (runId: string) => (await env.pool.query(`SELECT type, node, payload FROM workflow_run_steps WHERE run_id = $1 ORDER BY seq`, [runId])).rows;
const near = async () => (await must(get('/internal/control-tower/panels'))).json().nearThreshold;
const promotions = async (status?: string) => (await get(`/internal/tenants/${tenantId}/learning/promotions${status ? `?status=${status}` : ''}`)).json() as { id: string; status: string; node: string; script: string }[];

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb({ learning: { recorder, councils: councils as never } });
  CLUSTER_CACHE.minAgeMs = 0;                                                    // every change shows at once in these tests
  runDeps = { pool: env.pool, key: parseKey(env.config.VOICELAB_SECRET_KEY), speaker };
  tenantId = (await must(post('/internal/tenants', { name: 'Learning Co' }))).json().id;
  projectId = (await must(post(`/internal/tenants/${tenantId}/projects`, { name: 'Collections' }))).json().id;
  twilioId = (await must(post('/internal/providers', { adapterKey: 'twilio', name: 'tw-learning', params: { accountSid: 'AC1', authToken: 'tw-learning-token', twimlAppVoiceUrl: 'https://voicelab.test/v' } }))).json().id;
  numberId = (await must(post('/internal/numbers', { providerId: twilioId, e164: '+60300000777', tenantId, projectId, country: 'MY' }))).json().id;
  const { createUser } = await import('../src/store/tenants.js');
  otherAdmin = (await withActor(env.pool, { kind: 'internal' }, (c) => createUser(c, null, { tenantId: null, email: 'reviewer@daythree.test', role: 'internal_admin' }))).token;
  voiceId = (await must(post('/internal/providers', { adapterKey: 'elevenlabs', name: 'el', params: { apiKey: 'k' } }))).json().id;
  await must(post(`/internal/providers/${voiceId}/charging`, { reason: 'Set up for this test.', effectiveFrom: '2026-01-01T00:00:00Z', billingIncrementSeconds: 1, components: [{ component: 'tts', unit: 'per_1k_characters', rate: '0.30', currency: 'USD' }] }));
  const c = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'learn_flow', definition: flow }))).json();
  wfId = c.workflow.id;
  await goLive(wfId, c.version.id);
  await must(put(`/internal/tenants/${tenantId}/learning/config`, { reason: 'Set up for this test.', minSupport: 5, driftMinSamples: 5, voiceProviderId: voiceId }));
  await must(put('/internal/model-config/council_quality', { reason: 'Set up for this test.', tier: 'opus', modelId: 'q-opus', escalateTo: null }));
  await must(put('/internal/model-config/council_cx', { reason: 'Set up for this test.', tier: 'opus', modelId: 'cx-opus', escalateTo: null }));
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
    expect(report.clusters[0]).toMatchObject({ node: 'ask', support: 3, ready: false, percentOfThreshold: 60, next: true });
    // The Control Tower shows it as close: three of the five turns needed, from the same report (lesson L-033).
    expect(await near()).toEqual({ asOf: expect.any(String), closeAtPercent: 50, close: 1, readyToDistil: 0, stuck: { alreadyProposed: 0, failsRules: 0 }, unavailable: [], clusters: [
      { tenantId, tenant: 'Learning Co', workflow: 'learn_flow', node: 'ask', language: 'en', context: 'start', script: report.clusters[0].script, support: 3, threshold: 5, percentOfThreshold: 60 },
    ] });
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
    expect(await near()).toMatchObject({ close: 0, readyToDistil: 1, clusters: [] });                  // past the threshold, not drawn up yet
    const out = (await must(post(`/internal/tenants/${tenantId}/learning/scan`, {}))).json();
    expect(out.created).toHaveLength(1);
    expect(await near()).toMatchObject({ close: 0, readyToDistil: 0, clusters: [] });                  // a script is in review: nothing waits
    expect((await get(`/internal/tenants/${tenantId}/learning`)).json().clusters[0]).toMatchObject({ node: 'ask', ready: true, next: false });
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
    // The Control Tower does not call it waiting: it is past the threshold, but its wording was already tried there.
    expect(await near()).toMatchObject({ readyToDistil: 0, stuck: { alreadyProposed: 1, failsRules: 0 } });
    expect((await get(`/internal/tenants/${tenantId}/learning`)).json().clusters[0]).toMatchObject({ node: 'ask', ready: true, next: true, stuck: 'already_proposed' });
  });
});

describe('the Control Tower\'s clusters near the threshold', () => {
  /** Turns written as if spoken, for a client of the test's own, with a threshold the test sets. */
  const client = async (name: string, minSupport?: number) => {
    const id = (await must(post('/internal/tenants', { name }))).json().id as string;
    if (minSupport) await must(put(`/internal/tenants/${id}/learning/config`, { reason: 'Set up for this test.', minSupport }));
    return id;
  };
  /** A live run on a call of the client's own: only live calls are evidence. */
  const liveRun = async (tenant: string) => {
    const wf = (await must(post(`/internal/tenants/${tenant}/workflows`, { name: `synthetic_${randomUUID().slice(0, 6)}`, definition: { start: 'a', nodes: { a: { type: 'end', outcome: 'x' } } } }))).json();
    const callId = randomUUID(); const run = randomUUID();
    await env.pool.query(`INSERT INTO calls (id, tenant_id, provider_id, provider_call_id, direction, status, country, from_number_id, workflow_id, cost_status)
                          VALUES ($1,$2,$3,$4,'outbound','completed','MY',$5,$6,'pending')`, [callId, tenant, twilioId, `CA_syn_${callId.slice(0, 8)}`, numberId, wf.workflow.id]);
    await env.pool.query(`INSERT INTO workflow_runs (id, tenant_id, workflow_id, version_id, environment, kind, pins, state, status, call_id)
                          VALUES ($1,$2,$3,$4,'production','live','{}','{}','ended',$5)`, [run, tenant, wf.workflow.id, wf.version.id, callId]);
    return run;
  };
  const turns = async (tenant: string, node: string, text: string, n: number) => {
    const run = await liveRun(tenant);
    for (let i = 0; i < n; i++) {
      await env.pool.query(`INSERT INTO learning_turns (tenant_id, run_id, workflow, node, language, context_kind, text, synth_chars, slot_chars) VALUES ($1,$2,'synthetic',$3,'en','start',$4,40,0)`, [tenant, run, node, text]);
    }
  };
  const mine = (n: { clusters: { tenantId: string; node: string; support: number; percentOfThreshold: number }[] }, t: string) => n.clusters.filter((k) => k.tenantId === t).map((k) => [k.node, k.support, k.percentOfThreshold]);

  it('counts from half the threshold, only the cluster distilling would act on, and a stuck one apart', async () => {
    const before = await near();
    const t = await client('Near Co', 4);
    await turns(t, 'a', 'Thank you for holding, your account is being checked now.', 3);         // 3 of 4: close
    await turns(t, 'b', 'We can set up a payment plan that suits your budget.', 2);              // 2 of 4: exactly half, close
    await turns(t, 'c', 'Could you confirm the reference printed on your letter?', 1);           // 1 of 4: too far
    await turns(t, 'd', 'Your next instalment falls due at the end of this month.', 3);          // the top wording of d: close
    await turns(t, 'd', 'Lovely weather today, isn\'t it, zebra quartz.', 2);                    // a second wording of d: never next
    await turns(t, 'e', '{{ghost}} {{name}}', 4);                                                // past it, but fails the rule checks
    await turns(t, 'f', 'Thanks for calling, an officer will call you back today.', 4);          // past it, waiting to be drawn up
    const after = await near();
    expect(mine(after, t).sort()).toEqual([['a', 3, 75], ['b', 2, 50], ['d', 3, 75]]);
    expect(after.close - before.close).toBe(3);
    expect(after.readyToDistil - before.readyToDistil).toBe(1);
    expect(after.stuck.failsRules - before.stuck.failsRules).toBe(1);
    expect(after.unavailable).toEqual([]);
  });

  it('uses each client\'s own threshold, the default for a client with no settings, and sorts across clients by how close', async () => {
    const t = await client('Default Co');                                                         // no settings: a threshold of 20
    await turns(t, 'g', 'We have received your payment, thank you very much indeed.', 18);
    const n = await near();
    expect(mine(n, t)).toEqual([['g', 18, 90]]);
    const shares = n.clusters.map((k: { support: number; threshold: number }) => k.support / k.threshold);
    expect(shares).toEqual([...shares].sort((x: number, y: number) => y - x));                  // the closest first, whatever the client
    expect(n.clusters[0]).toMatchObject({ tenantId: t, threshold: 20, percentOfThreshold: 90 });
  });

  it('lists at most ten but counts them all, and rounds down short of the threshold', async () => {
    const before = await near();
    const t = await client('Many Co', 200);
    for (let i = 0; i < 12; i++) await turns(t, `n${i}`, `Message number ${['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'][i]} about your account balance`, 199 - i);
    const after = await near();
    expect(after.close - before.close).toBe(12);
    expect(after.clusters).toHaveLength(10);
    expect(after.clusters[0]).toMatchObject({ tenantId: t, support: 199, threshold: 200, percentOfThreshold: 99 });   // never "100%" short of it
  });

  it('works clusters out again only when something changed, and at most once a minute, saying when they are from', async () => {
    const t = await client('Cache Co', 2);
    await turns(t, 'h', 'Your callback has been booked for tomorrow morning.', 1);
    const first = await near();                                                                   // counted: one of two
    expect((await near()).asOf).toBe(first.asOf);                                                 // nothing changed: nothing worked out again
    CLUSTER_CACHE.minAgeMs = 3_600_000;
    try {
      await turns(t, 'i', 'Please keep your reference number close at hand.', 1);
      const held = await near();
      expect(held.close).toBe(first.close);                                                      // within the minute: the last count, as of then
      expect(Date.parse(held.asOf)).toBeLessThanOrEqual(Date.parse(first.asOf));
    } finally { CLUSTER_CACHE.minAgeMs = 0; }
    expect((await near()).close).toBe(first.close + 1);
  });
});

describe('when the councils do not simply pass it', () => {
  it('turns a script down when a council clearly fails it, and does not offer it again', async () => {
    const wf2 = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'learn_two', definition: { ...flow, nodes: { ...flow.nodes, ask: { ...flow.nodes.ask!, prompt: 'Ask nicely for payment' } } } }))).json();
    await goLive(wf2.workflow.id, wf2.version.id);
    for (let i = 0; i < 6; i++) {
      const r = await startRun(runDeps, null, { workflowId: wf2.workflow.id, environment: 'production', kind: 'live', variables: { name: NAMES[i]!, amount: String(200 + i) }, callId: await newCall(wf2.workflow.id) });
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
    await goLive(wf3.workflow.id, wf3.version.id);
    for (let i = 0; i < 6; i++) {
      const r = await startRun(runDeps, null, { workflowId: wf3.workflow.id, environment: 'production', kind: 'live', variables: { name: NAMES[i]!, amount: String(300 + i) }, callId: await newCall(wf3.workflow.id) });
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
    // The person who ran the scan drew this script up, so they cannot decide it; someone else does.
    const own = await post(`/internal/promotions/${id}/decision`, { decision: 'approved', note: 'Mine, and fine.' });
    expect([own.statusCode, own.json().error]).toEqual([403, 'You drew this script up, so someone else must approve it. You can still turn it down.']);
    const again = await post(`/internal/promotions/${id}/review`);
    expect([again.statusCode, again.json().error]).toEqual([409, 'The councils have already reviewed this script, so a person decides it now.']);   // not asked again until one happens to pass
    expect((await get(`/internal/promotions/${id}`)).json().status).toBe('in_review');
    const failed = await env.call(otherAdmin, 'POST', `/internal/promotions/${id}/decision`, { decision: 'approved', note: 'Sounds right.' });
    (recorder as { record: Recorder['record'] }).record = realRecord;
    expect(failed.statusCode).toBe(200);                                                          // the approval stands...
    expect(failed.json()).toMatchObject({ status: 'approved', audioError: expect.stringContaining('no voice provider') });   // ...and the audio failure is reported
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
    await goLive(wf, v2.id);
    const r = await startRun(runDeps, null, { workflowId: wf, environment: 'production', kind: 'live', variables: { name: 'Aisha', amount: '350' }, callId: await newCall(wf) });
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
    await goLive(wf4.workflow.id, wf4.version.id);
    for (let i = 0; i < 6; i++) {
      const r = await startRun(runDeps, null, { workflowId: wf4.workflow.id, environment: 'production', kind: 'live', variables: { name: NAMES[i]!, amount: String(400 + i) }, callId: await newCall(wf4.workflow.id) });
      await replyRun(runDeps, r.id, 'yes thanks');
    }
    await must(put('/internal/model-config/distill_script', { reason: 'Set up for this test.', tier: 'sonnet', modelId: 'sonnet-model', escalateTo: 'opus' }));
    const asked: string[] = [];
    const mk = (tier: 'sonnet' | 'opus', confidence: number, script: string) => ({ tier, model: `${tier}-model`, distill: async () => { asked.push(tier); return { script, confidence, inputTokens: 500, outputTokens: 50 }; } });
    const { distil } = await import('../src/store/learning.js');
    // sonnet is unsure; opus writes a script that uses a variable the workflow does not have, so the rules turn it down and the callers' own wording is used
    const out = await distil({ pool: env.pool, distillers: { sonnet: mk('sonnet', 0.4, 'Hello {{name}}, please pay.'), opus: mk('opus', 0.95, 'Hello {{who}}, you owe {{debt}} so please pay this week.') } }, null, { tenantId, workflow: 'learn_four' });
    expect(asked).toEqual(['sonnet', 'opus']);
    expect(out.created).toHaveLength(1);
    const p = (await get(`/internal/promotions/${out.created[0]}`)).json();
    expect(p).toMatchObject({ script: 'Dear {{name}}, kindly note {{amount}} is outstanding on your account.', distilled_by: 'rules' });
    const decisions = (await get(`/internal/ai-decisions?subjectType=promotion&subjectId=${out.created[0]}`)).json();
    expect(decisions.map((d: { tier: string; escalated_from: string | null; input_tokens: number }) => [d.tier, d.escalated_from, d.input_tokens]).sort()).toEqual([['opus', 'sonnet', 500], ['sonnet', null, 500]]);
  });
});

describe('what keeps a script from being spoken where it should not be', () => {
  it('does not ask a model to write a script for a node that already has one in review, and refuses to approve a script that fails the rules', async () => {
    const asked: string[] = [];
    const spy = { tier: 'sonnet' as const, model: 'sonnet-model', distill: async () => { asked.push('x'); return { script: 'never used', confidence: 1, inputTokens: 1, outputTokens: 1 }; } };
    const { distil } = await import('../src/store/learning.js');
    const out = await distil({ pool: env.pool, distillers: { sonnet: spy } }, null, { tenantId, workflow: 'learn_four' });   // learn_four's script is in review
    expect(out.created).toEqual([]);
    expect(asked).toEqual([]);
    const bad = (await env.pool.query(
      `INSERT INTO promotions (tenant_id, workflow, node, language, context_kind, script, slots, support, variants, avg_synth_chars, avg_slot_chars, node_hash, distilled_by)
       VALUES ($1,'learn_flow','ask','en','complaint','Hello {{who}}, please pay this week without delay.','{who}',9,1,40,5,'h','rules') RETURNING id`, [tenantId])).rows[0].id as string;
    await env.pool.query(`INSERT INTO promotion_events (promotion_id, kind, reason) VALUES ($1,'distilled','test')`, [bad]);
    const r = await post(`/internal/promotions/${bad}/decision`, { decision: 'approved' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain('{{who}} is not a variable');
  });

  it('records the audio once when two finishes arrive together', async () => {
    const id = (await env.pool.query(`SELECT id FROM promotions WHERE workflow = 'learn_four'`)).rows[0]?.id as string;
    expect(id).toBeTruthy();
    made.length = 0;
    const real = recorder.record;
    // approved while the voice provider is down: approved, no audio yet
    (recorder as { record: Recorder['record'] }).record = async () => { throw new Error('no voice provider'); };
    expect((await post(`/internal/promotions/${id}/decision`, { decision: 'approved' })).json()).toMatchObject({ status: 'approved', audioError: expect.any(String) });
    // then two finishes arrive together, with a slow voice provider
    (recorder as { record: Recorder['record'] }).record = async (l, t) => { await new Promise((r) => setTimeout(r, 150)); return real(l, t); };
    try {
      const [a, b] = await Promise.all([post(`/internal/promotions/${id}/audio`), post(`/internal/promotions/${id}/audio`)]);
      expect(a.statusCode).toBe(200); expect(b.statusCode).toBe(200);
    } finally { (recorder as { record: Recorder['record'] }).record = real; }
    expect([...made].sort()).toEqual([', kindly note', 'Dear', 'is outstanding on your account.']);   // each phrase recorded once, not twice
    expect((await get(`/internal/promotions/${id}`)).json().status).toBe('promoted');
  });

  it('is not demoted by simulating a draft, but stops being spoken the moment a deploy changes its node', async () => {
    const wf = (await env.pool.query(`SELECT id FROM workflows WHERE name = 'learn_four'`)).rows[0].id as string;
    const pid = (await env.pool.query(`SELECT id FROM promotions WHERE workflow = 'learn_four'`)).rows[0].id as string;
    expect((await get(`/internal/promotions/${pid}`)).json().status).toBe('promoted');
    const edited = { ...flow, nodes: { ...flow.nodes, ask: { ...flow.nodes.ask!, prompt: 'Confirm the address instead', text: 'Hello {{name}}, is your address still correct?' } } };
    const draft = (await must(post(`/internal/workflows/${wf}/versions`, { definition: edited }))).json();
    await must(post(`/internal/workflows/${wf}/simulate`, { versionId: draft.id, scenarios: [{ name: 's', variables: { name: 'Aisha', amount: '350' }, replies: ['yes'], expect: { outcome: 'ok' } }] }));
    expect((await must(post(`/internal/promotions/${pid}/drift-check`))).json().promotion.status).toBe('promoted');   // a rehearsal of a draft proves nothing about the live node
    const before = modelCalls;
    await goLive(wf, draft.id);
    const r = await startRun(runDeps, null, { workflowId: wf, environment: 'production', kind: 'live', variables: { name: 'Aisha', amount: '350' }, callId: await newCall(wf) });
    const say = (await steps(r.id)).find((x) => x.type === 'say' && x.node === 'ask')!.payload;
    expect(say.promotion).toBeUndefined();                                                        // not the old script, even before any screen has run
    expect(modelCalls).toBe(before + 1);
  });

  it('speaks a script only in the journey context it was learned in', async () => {
    const [p] = (await promotions('promoted'));
    expect(p).toBeTruthy();
    const { activePromotions } = await import('../src/store/learning.js');
    const lookup = await withActor(env.pool, { kind: 'internal' }, (c) => activePromotions(c, tenantId));
    const node = flow.nodes.ask as { prompt?: string; text?: unknown };
    const row = (await env.pool.query('SELECT workflow, node, language, context_kind, context_topic FROM promotions WHERE id = $1', [p!.id])).rows[0];
    void node;
    const real = lookup(row.workflow, await nodeOf(row.workflow, row.node), row.node, row.language, { kind: row.context_kind, topic: row.context_topic });
    expect(real?.id).toBe(p!.id);
    expect(lookup(row.workflow, await nodeOf(row.workflow, row.node), row.node, row.language, { kind: 'complaint', topic: '' })).toBeUndefined();
  });

  it('does not stop the sweep when one script\'s audio fails, and names what it could not judge', async () => {
    const { sweepAudio, sweepDrift } = await import('../src/store/learning.js');
    const broken: Recorder = { record: async () => { throw new Error('no voice provider'); } };
    await expect(sweepAudio({ pool: env.pool, recorder: broken }, null)).resolves.toMatchObject({ promoted: expect.any(Array), audioFailed: expect.any(Array) });
    const drift = await sweepDrift({ pool: env.pool }, null);
    expect(drift).toMatchObject({ unjudged: expect.any(Array), driftFailed: expect.any(Array) });
  });
});

async function nodeOf(workflow: string, node: string) {
  const def = (await env.pool.query(
    `SELECT v.definition FROM workflow_versions v JOIN workflows w ON w.id = v.workflow_id WHERE w.name = $1 AND w.tenant_id = $2 ORDER BY v.created_at ASC LIMIT 1`, [workflow, tenantId])).rows[0].definition as WorkflowDefinition;
  return def.nodes[node] as { prompt?: string; text?: unknown };
}

describe('evidence', () => {
  it('comes only from live calls: staging test calls are neither turns to learn from nor reactions to judge drift by', async () => {
    const wf5 = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'learn_five', definition: { ...flow, nodes: { ...flow.nodes, ask: { ...flow.nodes.ask!, prompt: 'Ask about paying by Friday' } } } }))).json();
    await goLive(wf5.workflow.id, wf5.version.id);
    const turns = async () => (await env.pool.query(`SELECT count(*)::int AS n FROM learning_turns WHERE workflow = 'learn_five'`)).rows[0].n as number;
    const tryOut = async (answer: string) => {
      for (let i = 0; i < 6; i++) {
        const r = await startRun(runDeps, null, { workflowId: wf5.workflow.id, environment: 'staging', kind: 'test', variables: { name: NAMES[i]!, amount: String(500 + i) } });
        await replyRun(runDeps, r.id, answer);
      }
    };
    await tryOut('yes thanks');
    expect(await turns()).toBe(0);
    expect((await must(post(`/internal/tenants/${tenantId}/learning/scan`, { workflow: 'learn_five' }))).json().created).toEqual([]);
    for (let i = 0; i < 6; i++) {
      const r = await startRun(runDeps, null, { workflowId: wf5.workflow.id, environment: 'production', kind: 'live', variables: { name: NAMES[i]!, amount: String(600 + i) }, callId: await newCall(wf5.workflow.id) });
      await replyRun(runDeps, r.id, 'yes thanks');
    }
    expect(await turns()).toBe(6);
    const [id] = (await must(post(`/internal/tenants/${tenantId}/learning/scan`, { workflow: 'learn_five' }))).json().created as string[];
    expect((await must(post(`/internal/promotions/${id}/review`))).json().status).toBe('promoted');
    // Testers being rude to the script in staging say nothing about how real callers take it.
    await tryOut('no, this is harassment, stop calling me you idiots');
    const v = (await must(post(`/internal/promotions/${id}/drift-check`))).json();
    expect([v.verdict.promoted.n, v.verdict.baseline.n, v.verdict.judged, v.promotion.status]).toEqual([0, 6, false, 'promoted']);
    // A changed node tried out in staging is not the node live callers hear: it does not demote the live script.
    const changed = (await must(post(`/internal/workflows/${wf5.workflow.id}/versions`, { definition: { ...flow, nodes: { ...flow.nodes, ask: { ...flow.nodes.ask!, prompt: 'Ask about paying by Friday', text: 'Hi {{name}}, could you pay by Friday?' } } } }))).json();
    await must(post(`/internal/workflows/${wf5.workflow.id}/deploy`, { versionId: changed.id, environment: 'staging' }));
    await tryOut('yes');
    expect((await must(post(`/internal/promotions/${id}/drift-check`))).json().promotion.status).toBe('promoted');
    // What the script saved is counted on live calls only: the testers heard it twelve times.
    expect((await must(get(`/internal/promotions/${id}/financial`))).json().usesWhilePromoted).toBe(0);
    // When it is taken down, the calls offered for listening back are live calls, never the testers'.
    const liveRun = await startRun(runDeps, null, { workflowId: wf5.workflow.id, environment: 'production', kind: 'live', variables: { name: 'Aisha', amount: '700' }, callId: await newCall(wf5.workflow.id) });
    await replyRun(runDeps, liveRun.id, 'no, I am not happy about this');
    await must(post(`/internal/promotions/${id}/demote`, { reason: 'Taken down to try a new wording.' }));
    const demoted = (await get(`/internal/promotions/${id}`)).json().events.find((e: { kind: string }) => e.kind === 'demoted');
    expect(demoted.detail.replays.map((r: { runId: string }) => r.runId)).toEqual([liveRun.id]);
  });

  it('is not supplied by hand: a run started as live with no call, or turns logged from test runs before this rule, count for nothing', async () => {
    const wf6 = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'learn_six', definition: { ...flow, nodes: { ...flow.nodes, ask: { ...flow.nodes.ask!, prompt: 'Ask about paying by Monday' } } } }))).json();
    await goLive(wf6.workflow.id, wf6.version.id);
    const runs: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await startRun(runDeps, null, { workflowId: wf6.workflow.id, environment: 'production', kind: 'live', variables: { name: NAMES[i]!, amount: String(700 + i) } });   // no call
      await replyRun(runDeps, r.id, 'yes thanks'); runs.push(r.id);
    }
    expect((await env.pool.query(`SELECT count(*)::int AS n FROM learning_turns WHERE workflow = 'learn_six'`)).rows[0].n).toBe(0);
    // Turns a test run logged before the rule existed are still in the log, which is append-only: they are not read as evidence.
    for (const runId of runs) {
      await env.pool.query(
        `INSERT INTO learning_turns (tenant_id, run_id, workflow, node, language, context_kind, context_topic, text, synth_chars, slot_chars)
         VALUES ($1,$2,'learn_six','ask','en','neutral','','Hello {{name}}, you owe {{amount}}. Can you pay this week?',50,10)`, [tenantId, runId]);
    }
    const report = (await must(get(`/internal/tenants/${tenantId}/learning`))).json();
    expect(report.clusters.filter((k: { workflow: string }) => k.workflow === 'learn_six')).toEqual([]);   // not even close to the threshold
    expect((await must(post(`/internal/tenants/${tenantId}/learning/scan`, { workflow: 'learn_six' }))).json()).toMatchObject({ created: [], skipped: [] });
  });

  it('reads the node, its variables and the examples it shows the councils from live calls, even when a test run logged the latest turn', async () => {
    const wf8 = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'learn_eight', definition: { ...flow, nodes: { ...flow.nodes, ask: { ...flow.nodes.ask!, prompt: 'Ask about paying by Wednesday' } } } }))).json();
    await goLive(wf8.workflow.id, wf8.version.id);
    for (let i = 0; i < 6; i++) {
      const r = await startRun(runDeps, null, { workflowId: wf8.workflow.id, environment: 'production', kind: 'live', variables: { name: NAMES[i]!, amount: String(900 + i) }, callId: await newCall(wf8.workflow.id) });
      await replyRun(runDeps, r.id, 'yes thanks');
    }
    // A draft without "amount" is tried out in staging, and a turn from that test is in the log from before the rule: the latest turn.
    const draft = (await must(post(`/internal/workflows/${wf8.workflow.id}/versions`, { definition: { ...flow, variables: ['name'], nodes: { ...flow.nodes, ask: { ...flow.nodes.ask!, prompt: 'Ask about paying soon', text: 'Hello {{name}}, can you pay soon?' } } } }))).json();
    await must(post(`/internal/workflows/${wf8.workflow.id}/deploy`, { versionId: draft.id, environment: 'staging' }));
    const test = await startRun(runDeps, null, { workflowId: wf8.workflow.id, environment: 'staging', kind: 'test', variables: { name: 'Aisha' } });
    await env.pool.query(
      `INSERT INTO learning_turns (tenant_id, run_id, workflow, node, language, context_kind, context_topic, text, synth_chars, slot_chars)
       VALUES ($1,$2,'learn_eight','ask','en','neutral','','A TESTER LINE for {{name}}',30,5)`, [tenantId, test.id]);
    const seen: string[][] = [];
    const realReview = quality.review; quality = { ...quality, review: async (i) => { seen.push(i.examples); return realReview(i); } };
    const out = (await must(post(`/internal/tenants/${tenantId}/learning/scan`, { workflow: 'learn_eight' }))).json();
    expect(out.created).toHaveLength(1);                                         // the script's {{amount}} is checked against the live flow, which has it
    const reviewed = (await must(post(`/internal/promotions/${out.created[0]}/review`))).json();
    quality = council('opus', 'q-opus', true, 0.95);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.some((x) => x.includes('TESTER'))).toBe(false);             // the councils are shown what live callers heard
    expect(reviewed.status).toBe('promoted');
    const r = await startRun(runDeps, null, { workflowId: wf8.workflow.id, environment: 'production', kind: 'live', variables: { name: 'Bobby', amount: '950' }, callId: await newCall(wf8.workflow.id) });
    expect((await steps(r.id)).find((x) => x.type === 'say' && x.node === 'ask')!.payload.promotion).toBe(out.created[0]);   // written for the live node, so it is spoken there
  });

  it('lets the person who drew a script up turn it down, so a lone admin is never left with a script nobody can decide', async () => {
    const wf7 = (await must(post(`/internal/tenants/${tenantId}/workflows`, { name: 'learn_seven', definition: { ...flow, nodes: { ...flow.nodes, ask: { ...flow.nodes.ask!, prompt: 'Ask about paying by Tuesday' } } } }))).json();
    await goLive(wf7.workflow.id, wf7.version.id);
    for (let i = 0; i < 6; i++) {
      const r = await startRun(runDeps, null, { workflowId: wf7.workflow.id, environment: 'production', kind: 'live', variables: { name: NAMES[i]!, amount: String(800 + i) }, callId: await newCall(wf7.workflow.id) });
      await replyRun(runDeps, r.id, 'yes thanks');
    }
    const [id] = (await must(post(`/internal/tenants/${tenantId}/learning/scan`, { workflow: 'learn_seven' }))).json().created as string[];
    cx = council('opus', 'cx-opus', true, 0.6);
    expect((await must(post(`/internal/promotions/${id}/review`))).json().status).toBe('in_review');
    cx = council('opus', 'cx-opus', true, 0.93);
    const listed = async (token: string) => ((await env.call(token, 'GET', `/internal/tenants/${tenantId}/learning/promotions`)).json() as { id: string; mine: boolean; reviewed: boolean }[]).find((x) => x.id === id);
    expect(await listed(st())).toMatchObject({ mine: true, reviewed: true });         // the console offers its author no Approve and nobody a second review
    expect(await listed(otherAdmin)).toMatchObject({ mine: false, reviewed: true });
    const out = await post(`/internal/promotions/${id}/decision`, { decision: 'rejected', note: 'Not the wording we want.' });
    expect([out.statusCode, out.json().status]).toEqual([200, 'rejected']);
  });
});
