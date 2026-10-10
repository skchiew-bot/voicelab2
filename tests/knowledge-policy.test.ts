import { describe, expect, it } from 'vitest';
import { rank, score, speakable, type Article } from '../src/knowledge/search.js';
import { classifyPolicyChange, diffPolicy, evaluate, phraseViolation, ruleProblems, type Rule } from '../src/policy/rules.js';

const art = (slug: string, title: string, body: string, o: Partial<Article> = {}): Article => ({ slug, language: 'en', title, body, voiceText: null, tags: [], ...o });
const A = [
  art('late-fees', 'Late payment fees', 'A late fee of five ringgit applies after seven days. You can ask for the fee to be waived once a year. See https://example.test/fees for details.', { tags: ['fee', 'penalty'] }),
  art('instalments', 'Paying in instalments', 'You may split a balance into up to six monthly instalments. Ask us to set one up.', { voiceText: 'You can pay in up to six monthly instalments.' }),
  art('hours', 'Opening hours', 'We are open from nine to five on weekdays.'),
  art('bm-bayaran', 'Bayaran ansuran', 'Anda boleh membayar secara ansuran sehingga enam bulan.', { language: 'ms', tags: ['ansuran'] }),
];

describe('finding what the bot should know', () => {
  it('ranks by title, then tags, then body, and leaves out what does not match', () => {
    expect(rank(A, 'is there a late fee', { channel: 'text' }).map((s) => s.slug)).toEqual(['late-fees']);
    expect(rank(A, 'can I pay in instalments', { channel: 'text' }).map((s) => s.slug)[0]).toBe('instalments');
    expect(rank(A, 'weather forecast', { channel: 'text' })).toEqual([]);
    expect(score(A[0]!, 'penalty')).toBeGreaterThan(score(A[2]!, 'penalty'));
  });
  it('gives the language asked for, and English when there is nothing in it', () => {
    expect(rank(A, 'ansuran', { channel: 'text', language: 'ms' }).map((s) => s.slug)).toEqual(['bm-bayaran']);
    expect(rank(A, 'late fee', { channel: 'text', language: 'ms' })).toEqual([]);                       // the language asked for has nothing on it: no English fallback when there are articles in it
    expect(rank([A[0]!], 'late fee', { channel: 'text', language: 'fr' }).map((s) => s.slug)).toEqual(['late-fees']);
  });
  it('speaks a short form on a call and the full text in a message', () => {
    const voice = rank(A, 'late fee', { channel: 'voice' })[0]!;
    expect(voice).toMatchObject({ derived: true });
    expect(voice.text).not.toContain('http'); expect(voice.text).toContain('A late fee of five ringgit applies after seven days.');
    expect(rank(A, 'instalments', { channel: 'voice' })[0]).toMatchObject({ text: 'You can pay in up to six monthly instalments.', derived: false });
    expect(rank(A, 'late fee', { channel: 'text' })[0]!.text).toContain('https://example.test/fees');
    expect(speakable('One. Two. Three.', 8)).toBe('One.');
  });
});

const rules: Rule[] = [
  { id: 'extend', kind: 'action', action: 'offer_extension', effect: 'allow', when: { var: 'days_overdue', op: 'lt', value: 60 } },
  { id: 'discount', kind: 'action', action: 'offer_discount', effect: 'allow', limit: { variable: 'discount_percent', max: '10' } },
  { id: 'no_waiver', kind: 'action', action: 'waive_fee', effect: 'deny', message: 'Only a person may waive a fee.' },
  { id: 'wording', kind: 'must_not_say', phrases: ['legal action', 'we will sue'], message: 'Never threaten.' },
] as Rule[];

describe('what the bot may do', () => {
  it('refuses an action no rule allows, and lets deny beat allow', () => {
    expect(evaluate(rules, 'close_account', {})).toMatchObject({ allowed: false, ruleId: null });
    expect(evaluate(rules, 'waive_fee', {})).toEqual({ allowed: false, ruleId: 'no_waiver', reason: 'Only a person may waive a fee.' });
    expect(evaluate([...rules, { id: 'also', kind: 'action', action: 'waive_fee', effect: 'allow' } as Rule], 'waive_fee', {}).allowed).toBe(false);
  });
  it('allows under a condition, and only while the condition holds', () => {
    expect(evaluate(rules, 'offer_extension', { days_overdue: 30 })).toMatchObject({ allowed: true, ruleId: 'extend' });
    expect(evaluate(rules, 'offer_extension', { days_overdue: 90 }).allowed).toBe(false);
    expect(evaluate(rules, 'offer_extension', {}).allowed).toBe(false);                                    // a variable not set makes the condition false
  });
  it('holds a limit in exact decimals, and refuses when the amount is missing or not a plain amount', () => {
    expect(evaluate(rules, 'offer_discount', { discount_percent: '10' }).allowed).toBe(true);
    expect(evaluate(rules, 'offer_discount', { discount_percent: '10.00000001' })).toMatchObject({ allowed: false, reason: expect.stringContaining('over the limit of 10') });
    expect(evaluate(rules, 'offer_discount', { discount_percent: 7.5 }).allowed).toBe(true);
    expect(evaluate(rules, 'offer_discount', {}).allowed).toBe(false);
    expect(evaluate(rules, 'offer_discount', { discount_percent: '10%' }).allowed).toBe(false);
    expect(evaluate(rules, 'offer_discount', { constructor: '1' }).allowed).toBe(false);                  // inherited names never count
  });
  it('finds a banned phrase as whole words in any case, and says which rule', () => {
    expect(phraseViolation(rules, 'We may take LEGAL ACTION next week.')).toMatchObject({ ruleId: 'wording', phrase: 'legal action', message: 'Never threaten.' });
    expect(phraseViolation(rules, 'Your legal-action file is closed.')).not.toBeNull();                  // punctuation does not hide it
    expect(phraseViolation(rules, 'We will not pursue anything.')).toBeNull();
    expect(phraseViolation(rules, 'We will suede it.')).toBeNull();                                      // not a whole word
  });
});

describe('what a policy may contain', () => {
  it('rejects what cannot work, with the reason', () => {
    expect(ruleProblems(rules)).toEqual([]);
    expect(ruleProblems([])).not.toEqual([]);
    expect(ruleProblems([...rules, rules[0]!]).join(' ')).toContain('appears twice');
    expect(ruleProblems([{ id: 'a', kind: 'action', action: 'x', effect: 'allow', when: { var: 'v', op: 'telepathy' } }]).join(' ')).toContain('not a known operator');
    expect(ruleProblems([{ id: 'a', kind: 'action', action: 'x', effect: 'deny', limit: { variable: 'v', max: '1' } }]).join(' ')).toContain('allow rule');
    expect(ruleProblems([{ id: 'constructor', kind: 'must_not_say', phrases: ['x y'] }]).join(' ')).toContain('reserved');
    expect(ruleProblems([{ id: 'a', kind: 'action', action: 'x', effect: 'allow', limit: { variable: 'v', max: '1e3' } }]).length).toBeGreaterThan(0);
  });
});

describe('how a change is versioned and described', () => {
  it('is minor when only a message changes, major when what is allowed or forbidden does', () => {
    const reworded = rules.map((r) => (r.id === 'wording' ? { ...r, message: 'Never threaten anyone.' } : r)) as Rule[];
    expect(classifyPolicyChange(rules, rules)).toBe('none');
    expect(classifyPolicyChange(rules, reworded)).toBe('minor');
    expect(classifyPolicyChange(rules, rules.map((r) => (r.id === 'discount' ? { ...r, limit: { variable: 'discount_percent', max: '20' } } : r)) as Rule[])).toBe('major');
    expect(classifyPolicyChange(rules, rules.slice(0, 3))).toBe('major');
    expect(classifyPolicyChange(null, rules)).toBe('major');
  });
  it('says in words what changed', () => {
    const next = [...rules.slice(1).map((r) => (r.id === 'discount' ? { ...r, limit: { variable: 'discount_percent', max: '20' } } : r)), { id: 'verify', kind: 'action', action: 'disclose_balance', effect: 'allow' }] as Rule[];
    const out = diffPolicy(rules, next);
    expect(out).toEqual(expect.arrayContaining([
      'Removed rule "extend": allow "offer_extension" under a condition.',
      'Changed rule "discount": was allow "offer_discount" up to 10 of discount_percent; now allow "offer_discount" up to 20 of discount_percent.',
      'Added rule "verify": allow "disclose_balance".',
    ]));
    expect(diffPolicy(rules, rules.map((r) => (r.id === 'wording' ? { ...r, message: 'Be kind.' } : r)) as Rule[])).toEqual(['Reworded the message of rule "wording".']);
  });
});
