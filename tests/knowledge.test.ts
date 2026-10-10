import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withActor } from '../src/db.js';
import { parseKey } from '../src/secrets.js';
import { createUser } from '../src/store/tenants.js';
import { startRun, type RunDeps } from '../src/store/runs.js';
import { phraseViolation, type Rule } from '../src/policy/rules.js';
import { start, type Deps, type SpeakContext } from '../src/workflows/engine.js';
import type { WorkflowDefinition } from '../src/workflows/definition.js';

type Env = Awaited<ReturnType<typeof import('./helpers.js').setupDb>>;
let env: Env; let tenantId: string; let otherTenantId: string; let tokenB: string; let tokenC: string; let tokenD: string;
const as = (token: string) => ({
  get: (u: string) => env.call(token, 'GET', u), post: (u: string, b?: unknown) => env.call(token, 'POST', u, b), put: (u: string, b?: unknown) => env.call(token, 'PUT', u, b),
});
let A: ReturnType<typeof as>;
async function must<T extends { statusCode: number; body: string }>(p: Promise<T>): Promise<T> {
  const r = await p;
  if (r.statusCode >= 300) throw new Error(`setup failed (${r.statusCode}): ${r.body}`);
  return r;
}

beforeAll(async () => {
  env = await (await import('./helpers.js')).setupDb();
  A = as(env.staffToken);
  const mk = async (email: string) => (await withActor(env.pool, { kind: 'internal' }, (c) => createUser(c, null, { tenantId: null, email, role: 'internal_admin' }))).token;
  tokenB = await mk('kb-b@daythree.test'); tokenC = await mk('kb-c@daythree.test'); tokenD = await mk('kb-d@daythree.test');
  tenantId = (await must(A.post('/internal/tenants', { name: 'Know Co' }))).json().id;
  otherTenantId = (await must(A.post('/internal/tenants', { name: 'Other Know Co' }))).json().id;
});
afterAll(async () => { await env?.teardown(); });

const article = (b: object = {}) => A.post(`/internal/tenants/${tenantId}/knowledge`, { slug: 'late-fees', title: 'Late payment fees', body: 'A late fee of five ringgit applies after seven days. You can ask for it to be waived once a year. See https://example.test/fees for details.', tags: ['fee'], ...b });
const search = async (q: string, o = 'channel=text', t = tenantId) => (await A.get(`/internal/tenants/${t}/knowledge/search?q=${encodeURIComponent(q)}&${o}`)).json() as { slug: string; text: string; derived: boolean }[];

describe('knowledge', () => {
  it('is not used until a different person publishes it, then answers questions in the form for the channel', async () => {
    const made = (await must(article())).json();
    expect(made.versions).toMatchObject([{ version: 1, status: 'draft' }]);
    expect(await search('late fee')).toEqual([]);                                                          // a draft informs nobody
    const v1 = made.versions[0].id as string;
    expect((await A.post(`/internal/knowledge-versions/${v1}/publish`)).statusCode).toBe(403);             // its author cannot publish it
    expect((await must(as(tokenB).post(`/internal/knowledge-versions/${v1}/publish`, { note: 'Checked against the terms.' }))).json().versions[0]).toMatchObject({ status: 'published', review_note: 'Checked against the terms.' });
    const text = await search('is there a late fee');
    expect(text[0]).toMatchObject({ slug: 'late-fees' }); expect(text[0]!.text).toContain('https://example.test/fees');
    const voice = await search('is there a late fee', 'channel=voice');
    expect(voice[0]).toMatchObject({ derived: true }); expect(voice[0]!.text).not.toContain('http');
  });

  it('keeps every version, publishes a new one over the old, and allows one draft at a time', async () => {
    const id = (await get('late-fees')).id as string;
    const draft = (await must(A.post(`/internal/knowledge/${id}/versions`, { title: 'Late payment fees', body: 'A late fee of ten ringgit applies after seven days.', voiceText: 'The late fee is ten ringgit after seven days.', tags: ['fee'] }))).json();
    expect(draft.versions.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([[1, 'published'], [2, 'draft']]);
    expect((await A.post(`/internal/knowledge/${id}/versions`, { title: 'x', body: 'y' })).statusCode).toBe(409);        // already a draft
    const v2 = draft.versions[1].id as string;
    const out = (await must(as(tokenC).post(`/internal/knowledge-versions/${v2}/publish`))).json();
    expect(out.versions.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([[1, 'retired'], [2, 'published']]);
    expect((await search('late fee', 'channel=voice'))[0]).toMatchObject({ text: 'The late fee is ten ringgit after seven days.', derived: false });
    expect((await search('late fee'))[0]!.text).toContain('ten ringgit');
    await expect(env.pool.query(`UPDATE knowledge_versions SET body = 'changed' WHERE id = $1`, [v2])).rejects.toThrow(/append-only/);       // what it said never changes
    await expect(env.pool.query('DELETE FROM knowledge_versions')).rejects.toThrow(/append-only/);
  });

  it('turns a draft down only with a reason, and takes a retired article out of use', async () => {
    const id = (await get('late-fees')).id as string;
    const d = (await must(A.post(`/internal/knowledge/${id}/versions`, { title: 'Late payment fees', body: 'Fees are waived for everyone.' }))).json().versions.at(-1).id as string;
    expect((await as(tokenB).post(`/internal/knowledge-versions/${d}/reject`, { note: '' })).statusCode).toBe(400);
    expect((await must(as(tokenB).post(`/internal/knowledge-versions/${d}/reject`, { note: 'That is not our policy.' }))).json().versions.at(-1)).toMatchObject({ status: 'rejected' });
    expect((await search('late fee')).length).toBe(1);                                                            // the published one still stands
    expect((await must(A.post(`/internal/knowledge/${id}/retire`))).json().retiredAt).toBeTruthy();
    expect(await search('late fee')).toEqual([]);
    expect((await A.post(`/internal/knowledge/${id}/versions`, { title: 'x', body: 'y' })).statusCode).toBe(409);
  });

  it('is a client\'s own: another client never sees it, and a language falls back to English', async () => {
    await must(article({ slug: 'instalments', title: 'Paying in instalments', body: 'You may split a balance into six monthly instalments.' }));
    const id = (await get('instalments')).id as string;
    await must(as(tokenB).post(`/internal/knowledge-versions/${(await A.get(`/internal/knowledge/${id}`)).json().versions[0].id}/publish`));
    expect((await search('instalments', 'channel=text&language=ms')).map((s) => s.slug)).toEqual(['instalments']);       // nothing in Malay: English is given
    expect(await search('instalments', 'channel=text', otherTenantId)).toEqual([]);
  });

  it('keeps a number out of what the bot may say, and a bad article out of the list', async () => {
    expect((await article({ slug: 'helpline', body: 'Call us on 012-345 6789.' })).statusCode).toBe(400);
    expect((await article({ slug: 'helpline2', title: 'Ring +60123456789' })).statusCode).toBe(400);
    expect((await article({ slug: 'Bad Slug' })).statusCode).toBe(400);
    expect((await article({ slug: 'instalments' })).statusCode).toBe(409);
  });
});
const get = async (slug: string) => ((await A.get(`/internal/tenants/${tenantId}/knowledge`)).json() as { id: string; slug: string }[]).find((a) => a.slug === slug)!;

const rules = (extra: object[] = [], phrase = 'legal action') => [
  { id: 'extend', kind: 'action', action: 'offer_extension', effect: 'allow', when: { var: 'days_overdue', op: 'lt', value: 60 } },
  { id: 'discount', kind: 'action', action: 'offer_discount', effect: 'allow', limit: { variable: 'discount_percent', max: '10' } },
  { id: 'no_waiver', kind: 'action', action: 'waive_fee', effect: 'deny', message: 'Only a person may waive a fee.' },
  { id: 'wording', kind: 'must_not_say', phrases: [phrase, 'we will sue'], message: 'Never threaten.' },
  ...extra,
];

describe('policy', () => {
  it('needs at least two approval levels before anything can be proposed, and a usable set of rules', async () => {
    expect((await A.put(`/internal/tenants/${tenantId}/policy/levels`, { levels: ['Owner'] })).statusCode).toBe(400);
    expect((await A.post(`/internal/tenants/${tenantId}/policy/proposals`, { rules: rules(), summary: 'First policy.' })).statusCode).toBe(409);
    await must(A.put(`/internal/tenants/${tenantId}/policy/levels`, { levels: ['Policy owner', 'Compliance'] }));
    const bad = await A.post(`/internal/tenants/${tenantId}/policy/proposals`, { rules: [{ id: 'x', kind: 'action', action: 'a', effect: 'allow', when: { var: 'v', op: 'telepathy' } }], summary: 's' });
    expect(bad.statusCode).toBe(400); expect(bad.json().error).toContain('not a known operator');
  });

  it('goes live only after every level, each a different person who is not the proposer, and then another person puts it live', async () => {
    const p = (await must(A.post(`/internal/tenants/${tenantId}/policy/proposals`, { rules: rules(), summary: 'The first policy.' }))).json();
    expect(p).toMatchObject({ version: '1.0', status: 'pending', nextLevel: 0 });
    expect(p.diff).toEqual(expect.arrayContaining(['Added rule "no_waiver": deny "waive_fee".']));
    expect((await A.post(`/internal/tenants/${tenantId}/policy/proposals`, { rules: rules([{ id: 'more', kind: 'action', action: 'x', effect: 'allow' }]), summary: 'Another.' })).statusCode).toBe(409);   // one proposal at a time
    const B = as(tokenB); const C = as(tokenC); const D = as(tokenD);
    expect((await A.post(`/internal/policy-versions/${p.id}/decision`, { decision: 'approved' })).statusCode).toBe(403);       // not your own
    expect((await B.post(`/internal/policy-versions/${p.id}/activate`)).statusCode).toBe(409);                                  // not approved yet
    expect((await must(B.post(`/internal/policy-versions/${p.id}/decision`, { decision: 'approved', note: 'Reads right.' }))).json()).toMatchObject({ status: 'pending', nextLevel: 1 });
    expect((await B.post(`/internal/policy-versions/${p.id}/decision`, { decision: 'approved' })).statusCode).toBe(403);       // one person, one level
    expect((await must(C.post(`/internal/policy-versions/${p.id}/decision`, { decision: 'approved' }))).json().status).toBe('approved');
    expect((await A.post(`/internal/policy-versions/${p.id}/activate`)).statusCode).toBe(403);                                  // the proposer cannot put it live
    const live = (await must(D.post(`/internal/policy-versions/${p.id}/activate`))).json();
    expect(live).toMatchObject({ version: '1.0', status: 'live' });
    expect((await D.post(`/internal/policy-versions/${p.id}/activate`)).statusCode).toBe(409);
    const overview = (await A.get(`/internal/tenants/${tenantId}/policy`)).json();
    expect(overview.live.version).toBe('1.0'); expect(overview.levels).toEqual(['Policy owner', 'Compliance']);
  });

  it('answers what the bot may do, refuses by default, and keeps each answer without the call\'s variables', async () => {
    const check = (action: string, variables: object = {}) => A.post(`/internal/tenants/${tenantId}/policy/check`, { action, variables });
    expect((await check('offer_extension', { days_overdue: 30 })).json()).toMatchObject({ allowed: true, ruleId: 'extend', version: '1.0' });
    expect((await check('offer_extension', { days_overdue: 90 })).json().allowed).toBe(false);
    expect((await check('offer_discount', { discount_percent: '10' })).json().allowed).toBe(true);
    expect((await check('offer_discount', { discount_percent: '10.5' })).json()).toMatchObject({ allowed: false, reason: expect.stringContaining('over the limit') });
    expect((await check('waive_fee')).json()).toMatchObject({ allowed: false, ruleId: 'no_waiver', reason: 'Only a person may waive a fee.' });
    expect((await check('close_account')).json()).toMatchObject({ allowed: false, ruleId: null });
    const decisions = (await A.get(`/internal/tenants/${tenantId}/policy/decisions`)).json() as { action: string; allowed: boolean; version: string }[];
    expect(decisions.length).toBeGreaterThanOrEqual(6); expect(decisions[0]).toMatchObject({ action: 'close_account', allowed: false, version: '1.0' });
    expect(JSON.stringify((await env.pool.query('SELECT * FROM policy_decisions')).rows)).not.toContain('days_overdue');
    expect((await A.post(`/internal/tenants/${otherTenantId}/policy/check`, { action: 'offer_extension', variables: { days_overdue: 1 } })).json()).toMatchObject({ allowed: false, version: null });   // another client has no policy: refused
  });

  it('versions a change by what it does: wording is minor, what is allowed or forbidden is major; a refusal needs a reason', async () => {
    const B = as(tokenB); const C = as(tokenC); const D = as(tokenD);
    const reword = rules(); (reword[3] as { message: string }).message = 'Never threaten anyone.';
    const minor = (await must(A.post(`/internal/tenants/${tenantId}/policy/proposals`, { rules: reword, summary: 'Clearer wording.' }))).json();
    expect(minor.version).toBe('1.1'); expect(minor.diff).toEqual(['Reworded the message of rule "wording".']);
    expect((await B.post(`/internal/policy-versions/${minor.id}/decision`, { decision: 'rejected' })).statusCode).toBe(400);
    expect((await must(B.post(`/internal/policy-versions/${minor.id}/decision`, { decision: 'rejected', note: 'Not needed.' }))).json().status).toBe('rejected');
    expect((await C.post(`/internal/policy-versions/${minor.id}/decision`, { decision: 'approved' })).statusCode).toBe(409);       // a refusal ends it
    expect((await A.post(`/internal/tenants/${tenantId}/policy/proposals`, { rules: rules(), summary: 'Same.' })).statusCode).toBe(400);   // no change
    const major = (await must(A.post(`/internal/tenants/${tenantId}/policy/proposals`, { rules: rules([], 'court'), summary: 'Different phrase.' }))).json();
    expect(major.version).toBe('2.0');
    await must(B.post(`/internal/policy-versions/${major.id}/decision`, { decision: 'approved' })); await must(C.post(`/internal/policy-versions/${major.id}/decision`, { decision: 'approved' }));
    await must(D.post(`/internal/policy-versions/${major.id}/activate`));
    const overview = (await A.get(`/internal/tenants/${tenantId}/policy`)).json();
    expect(overview.live.version).toBe('2.0');
    expect(overview.history.map((v: { version: string; status: string }) => [v.version, v.status])).toEqual([['2.0', 'live'], ['1.1', 'rejected'], ['1.0', 'retired']]);
  });

  it('goes back to an older policy only as a new proposal through the same approvals', async () => {
    const overview = (await A.get(`/internal/tenants/${tenantId}/policy`)).json();
    const old = overview.history.find((v: { version: string }) => v.version === '1.0');
    const back = (await must(A.post(`/internal/tenants/${tenantId}/policy/proposals`, { rules: old.rules, summary: 'Go back to 1.0.', rollbackOf: old.id }))).json();
    expect(back).toMatchObject({ version: '3.0', status: 'pending', rollbackOf: old.id });
    expect((await as(tokenB).post(`/internal/policy-versions/${back.id}/activate`)).statusCode).toBe(409);
    await must(as(tokenB).post(`/internal/policy-versions/${back.id}/decision`, { decision: 'rejected', note: 'Not now.' }));
  });

  it('never rewrites a policy, an approval or an answer', async () => {
    await expect(env.pool.query(`UPDATE policy_versions SET rules = '[]'`)).rejects.toThrow(/append-only/);
    await expect(env.pool.query(`UPDATE policy_versions SET summary = 'x'`)).rejects.toThrow(/append-only/);
    await expect(env.pool.query('DELETE FROM policy_versions')).rejects.toThrow(/append-only/);
    await expect(env.pool.query(`UPDATE policy_approvals SET note = 'x'`)).rejects.toThrow(/append-only/);
    await expect(env.pool.query(`UPDATE policy_decisions SET allowed = true`)).rejects.toThrow(/append-only/);
  });
});

describe('what the bot says', () => {
  const flow: WorkflowDefinition = { start: 'ask', variables: ['name'], nodes: {
    ask: { type: 'speak', speech: 'dynamic', prompt: 'Explain the late payment fee', text: 'There may be a late fee.', listen: { captureAs: 'a' }, transitions: [{ to: 'done' }] },
    done: { type: 'end', outcome: 'ok' } } };

  it('holds a line a model writes to the policy in force, falls back to the written text, and records why', async () => {
    const wf = (await must(A.post(`/internal/tenants/${tenantId}/workflows`, { name: 'policy_flow', definition: flow }))).json();
    await must(A.post(`/internal/workflows/${wf.workflow.id}/deploy`, { versionId: wf.version.id, environment: 'staging' }));
    let said = 'Pay now, or we will sue you.'; let seen: SpeakContext | undefined;
    const d: RunDeps = { pool: env.pool, key: parseKey(env.config.VOICELAB_SECRET_KEY), speaker: { generate: async (_n, _v, _l, ctx) => { seen = ctx; return said; } } };
    // policy 2.0 forbids "court" and "we will sue": the model's line is turned down
    const r = await startRun(d, null, { workflowId: wf.workflow.id, environment: 'staging', kind: 'test', variables: { name: 'Aisha' } });
    expect(r.said).toEqual(['There may be a late fee.']);
    const step = (await env.pool.query(`SELECT payload FROM workflow_run_steps WHERE run_id = $1 AND type = 'say'`, [r.id])).rows[0].payload;
    expect(step.ai).toMatchObject({ decision: 'rejected' }); expect(step.ai.decisionReason).toContain('rule "wording"');
    expect(seen?.policy).toMatchObject({ version: '2.0', mustNotSay: expect.arrayContaining(['court', 'we will sue']), denied: ['waive_fee'] });        // the model is told, too
    expect(seen?.knowledge).toEqual([]);                                                                       // nothing published is about a late payment fee yet
    said = 'A late fee of ten ringgit applies after seven days.';
    expect((await startRun(d, null, { workflowId: wf.workflow.id, environment: 'staging', kind: 'test', variables: { name: 'Aisha' } })).said).toEqual([said]);
  });

  it('gives a model the knowledge that matches what the node is about, in the short form for a call', async () => {
    const a = await must(article({ slug: 'waiver', title: 'Waiving a late fee', body: 'A late fee can be waived once a year. Ask a colleague to arrange it.', voiceText: 'You can ask for one waiver a year.' }));
    await must(as(tokenB).post(`/internal/knowledge-versions/${a.json().versions[0].id}/publish`));
    const wf = (await env.pool.query(`SELECT w.id FROM workflows w WHERE w.name = 'policy_flow' AND w.tenant_id = $1`, [tenantId])).rows[0].id as string;
    let seen: SpeakContext | undefined;
    const d: RunDeps = { pool: env.pool, key: parseKey(env.config.VOICELAB_SECRET_KEY), speaker: { generate: async (_n, _v, _l, ctx) => { seen = ctx; return 'A late fee applies after seven days.'; } } };
    await startRun(d, null, { workflowId: wf, environment: 'staging', kind: 'test', variables: { name: 'Aisha' } });
    expect(seen?.knowledge[0]).toMatchObject({ slug: 'waiver', text: 'You can ask for one waiver a year.' });
  });

  it('will not speak a promoted script the policy now forbids: the model, held to the policy, writes the line', async () => {
    const guard = { version: '9.9', violation: (l: string) => phraseViolation([{ id: 'r', kind: 'must_not_say', phrases: ['legal action'] }] as Rule[], l), mustNotSay: ['legal action'], denied: [] };
    const def: WorkflowDefinition = { start: 'ask', nodes: { ask: { type: 'speak', speech: 'dynamic', prompt: 'x', text: 'Fallback line here.', transitions: [{ to: 'done' }] }, done: { type: 'end', outcome: 'ok' } } };
    let asked = 0;
    const deps: Deps = { load: () => def, promoted: () => ({ id: 'p1', script: 'We may take legal action soon.' }), policy: guard, speaker: { generate: async () => { asked++; return 'We will be in touch soon.'; } } };
    const out = await start('w', {}, deps);
    expect(asked).toBe(1);
    expect(out.records.find((r) => r.type === 'say')!.payload.text).toBe('We will be in touch soon.');
    expect(out.records.find((r) => r.type === 'say')!.payload.promotion).toBeUndefined();
    expect((out.records.find((r) => r.type === 'say')!.payload.ai as { scriptBlocked: string }).scriptBlocked).toContain('rule "r"');     // the block is on the step, not silent
  });
});

describe('what a review found', () => {
  const pol = (t = tenantId) => `/internal/tenants/${t}/policy`;
  const propose = (rs: object[], summary: string, extra: object = {}) => A.post(`${pol()}/proposals`, { rules: rs, summary, ...extra });

  it('lets a wrong proposal be withdrawn, with a reason, so it never blocks every later change; and a refused number is free again', async () => {
    const B = as(tokenB);
    const p = (await must(propose(rules([{ id: 'x', kind: 'action', action: 'x', effect: 'allow' }], 'court'), 'Wrong.'))).json();
    expect(p.version).toBe('3.0');                                                                      // the refused and withdrawn numbers are not held
    await must(B.post(`/internal/policy-versions/${p.id}/decision`, { decision: 'approved' }));
    expect((await A.put(`${pol()}/levels`, { levels: ['One', 'Two', 'Three'] })).statusCode).toBe(409);   // the levels cannot move under a waiting proposal
    expect((await B.post(`/internal/policy-versions/${p.id}/withdraw`, { note: '' })).statusCode).toBe(400);
    expect((await must(B.post(`/internal/policy-versions/${p.id}/withdraw`, { note: 'Found a mistake.' }))).json().status).toBe('withdrawn');
    expect((await B.post(`/internal/policy-versions/${p.id}/withdraw`, { note: 'again' })).statusCode).toBe(409);
    expect((await B.post(`/internal/policy-versions/${p.id}/decision`, { decision: 'approved' })).statusCode).toBe(409);
  });

  it('keeps the levels a proposal was made under, even when they are changed after it is settled', async () => {
    await must(A.put(`${pol()}/levels`, { levels: ['One', 'Two', 'Three'] }));
    const p = (await must(propose(rules([{ id: 'y', kind: 'action', action: 'y', effect: 'allow' }], 'court'), 'Three levels.'))).json();
    expect(p.progress.map((l: { name: string }) => l.name)).toEqual(['One', 'Two', 'Three']);
    await must(as(tokenB).post(`/internal/policy-versions/${p.id}/decision`, { decision: 'approved' })); await must(as(tokenC).post(`/internal/policy-versions/${p.id}/decision`, { decision: 'approved' }));
    expect((await as(tokenD).post(`/internal/policy-versions/${p.id}/activate`)).statusCode).toBe(409);   // two of three is not enough
    await must(as(tokenB).post(`/internal/policy-versions/${p.id}/withdraw`, { note: 'Done with this.' }));
    await must(A.put(`${pol()}/levels`, { levels: ['Policy owner', 'Compliance'] }));
    expect((await A.get(`/internal/policy-versions/${p.id}`)).json().progress).toHaveLength(3);
  });

  it('accepts a rollback only to a replaced policy, with exactly its rules', async () => {
    const hist = (await A.get(pol())).json().history as { id: string; version: string; rules: object[] }[];
    const old = hist.find((v) => v.version === '1.0')!; const live = hist.find((v) => v.version === '2.0')!;
    const changed = old.rules.map((r) => ({ ...r })); (changed[0] as { id: string }).id = 'renamed';
    expect((await propose(changed, 'Not really a rollback.', { rollbackOf: old.id })).statusCode).toBe(400);
    expect((await propose(old.rules, 'Back to the live one.', { rollbackOf: live.id })).statusCode).toBe(400);
  });

  it('does not store a number or a stranger\'s call in a policy answer, and takes only an action name', async () => {
    expect((await A.post(`${pol()}/check`, { action: '60123456789', variables: {} })).statusCode).toBe(400);
    expect((await A.post(`${pol()}/check`, { action: 'waive_fee', callId: '00000000-0000-4000-8000-000000000000' })).statusCode).toBe(404);
    const r = await A.post(`${pol()}/check`, { action: 'offer_discount', variables: { discount_percent: '60123456789' } });
    expect(r.json()).toMatchObject({ allowed: false });
    expect(JSON.stringify((await env.pool.query('SELECT reason FROM policy_decisions')).rows)).not.toContain('60123456789');
    expect((await createArticleRaw({ slug: 'a60123456789' })).statusCode).toBe(400);
  });

  it('does not let who reviewed or who put live be rewritten, or a version go backwards', async () => {
    await expect(env.pool.query(`UPDATE knowledge_versions SET reviewed_by = NULL WHERE status = 'published'`)).rejects.toThrow(/kept for good/);
    await expect(env.pool.query(`UPDATE knowledge_versions SET status = 'draft' WHERE status = 'published'`)).rejects.toThrow(/cannot go from/);
    await expect(env.pool.query(`UPDATE knowledge_articles SET slug = 'other'`)).rejects.toThrow(/keeps its identity/);
    await expect(env.pool.query(`UPDATE knowledge_articles SET retired_at = NULL WHERE retired_at IS NOT NULL`)).rejects.toThrow(/stays retired|keeps its identity/);
    await expect(env.pool.query(`UPDATE policy_versions SET activated_by = NULL WHERE status = 'live'`)).rejects.toThrow(/kept for good/);
    await expect(env.pool.query(`UPDATE policy_versions SET status = 'pending' WHERE status = 'live'`)).rejects.toThrow(/cannot go from/);
    await expect(env.pool.query(`UPDATE policy_versions SET status = 'live' WHERE status = 'rejected'`)).rejects.toThrow(/cannot go from/);
  });

  it('gives a run for another client none of this client\'s policy or articles', async () => {
    const wf = (await must(A.post(`/internal/tenants/${otherTenantId}/workflows`, { name: 'other_flow', definition: { start: 'ask', nodes: { ask: { type: 'speak', speech: 'dynamic', prompt: 'Explain the late payment fee', text: 'Hello.', listen: { captureAs: 'a' }, transitions: [{ to: 'done' }] }, done: { type: 'end', outcome: 'ok' } } } }))).json();
    await must(A.post(`/internal/workflows/${wf.workflow.id}/deploy`, { versionId: wf.version.id, environment: 'staging' }));
    let seen: SpeakContext | undefined;
    const d: RunDeps = { pool: env.pool, key: parseKey(env.config.VOICELAB_SECRET_KEY), speaker: { generate: async (_n, _v, _l, ctx) => { seen = ctx; return 'Hello there.'; } } };
    await startRun(d, null, { workflowId: wf.workflow.id, environment: 'staging', kind: 'test', variables: {} });
    expect(seen).toEqual({ knowledge: [], policy: null });
  });
});

const createArticleRaw = (b: object) => A.post(`/internal/tenants/${tenantId}/knowledge`, { title: 'T', body: 'Body text.', ...b });

describe('requests that arrive together', () => {
  it('approves each level once and in order when three people approve at the same moment, and publishes a draft once', async () => {
    const mk = async (email: string) => (await withActor(env.pool, { kind: 'internal' }, (c) => createUser(c, null, { tenantId: null, email, role: 'internal_admin' }))).token;
    const [p1, p2, p3] = [await mk('race-1@daythree.test'), await mk('race-2@daythree.test'), await mk('race-3@daythree.test')];
    const t = (await must(A.post('/internal/tenants', { name: 'Race Co' }))).json().id as string;
    await must(A.put(`/internal/tenants/${t}/policy/levels`, { levels: ['One', 'Two'] }));
    const prop = (await must(A.post(`/internal/tenants/${t}/policy/proposals`, { rules: [{ id: 'r', kind: 'must_not_say', phrases: ['we will sue'] }], summary: 'Race test.' }))).json();
    const res = await Promise.all([p1, p2, p3].map((tok) => as(tok).post(`/internal/policy-versions/${prop.id}/decision`, { decision: 'approved' })));
    expect(res.map((r) => r.statusCode).sort()).toEqual([200, 200, 409]);                       // two levels, two approvals; the third finds it settled
    const v = (await A.get(`/internal/policy-versions/${prop.id}`)).json();
    expect(v.status).toBe('approved');
    expect(v.progress.map((l: { level: number; decision: string }) => [l.level, l.decision])).toEqual([[0, 'approved'], [1, 'approved']]);
    expect(new Set(v.progress.map((l: { decided_by: string }) => l.decided_by)).size).toBe(2);   // two different people

    const art = (await must(A.post(`/internal/tenants/${t}/knowledge`, { slug: 'race', title: 'Race', body: 'Only one publish wins.' }))).json();
    const draft = art.versions[0].id as string;
    const pub = await Promise.all([p1, p2].map((tok) => as(tok).post(`/internal/knowledge-versions/${draft}/publish`, {})));
    expect(pub.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await env.pool.query(`SELECT count(*)::int AS n FROM knowledge_versions WHERE article_id = $1 AND status = 'published'`, [art.id])).rows[0].n).toBe(1);
  });
});
