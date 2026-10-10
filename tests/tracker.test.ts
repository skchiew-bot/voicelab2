import { describe, expect, it } from 'vitest';
import { analyseTurn, DEFAULT_JOURNEY, intentChanged, mergeLexicon, observeTurn, type JourneyState } from '../src/journey/tracker.js';

describe('reading a turn', () => {
  it('tells an inquiry, a complaint and a request apart, with a topic', () => {
    expect(analyseTurn('How much do I still owe?')).toMatchObject({ kind: 'inquiry', topic: 'payment' });
    expect(analyseTurn('This is unacceptable, I want to complain.')).toMatchObject({ kind: 'complaint' });
    expect(analyseTurn('Please send me the statement.')).toMatchObject({ kind: 'request' });
    expect(analyseTurn('Berapa baki saya?')).toMatchObject({ kind: 'inquiry', topic: 'payment' });
    expect(analyseTurn('Tolong hantar ansuran plan')).toMatchObject({ kind: 'request', topic: 'plan' });
    expect(analyseTurn('mm hm')).toMatchObject({ kind: 'other', topic: null });
  });
  it('scores how they feel, turns "not happy" round, and does not count a word inside a longer phrase twice', () => {
    expect(analyseTurn('Thank you, that is great').sentiment).toBeGreaterThan(0.5);
    expect(analyseTurn('I am not happy').sentiment).toBeLessThan(0);
    expect(analyseTurn('saya tidak puas hati, tidak boleh').sentiment).toBeLessThan(0);
    const a = analyseTurn('tidak boleh');
    expect(a.signals).toEqual(['negative: tidak boleh']);                     // "boleh" alone is a good word, but not here
    expect(analyseTurn('okay').sentiment).toBeGreaterThan(0);
  });
  it('flags severe sentiment, from a word that says it or from the score', () => {
    expect(analyseTurn('I will call my lawyer')).toMatchObject({ severe: true, kind: 'complaint' });
    expect(analyseTurn('Stop harassing me, this is terrible')).toMatchObject({ severe: true });
    expect(analyseTurn('Thanks, bye').severe).toBe(false);
  });
  it('lets a client add words, not remove the defaults', () => {
    const lex = mergeLexicon({ topics: { rebate: ['rebate', 'diskaun'] }, severe: ['ombudsman'] });
    expect(analyseTurn('Can I get a rebate?', lex).topic).toBe('rebate');
    expect(analyseTurn('I will go to the ombudsman', lex).severe).toBe(true);
    expect(analyseTurn('I will call my lawyer', lex).severe).toBe(true);
    expect(analyseTurn('How much?', lex).topic).toBeNull();
  });
});

describe('when a call escalates', () => {
  const fresh = (): JourneyState => ({ turns: [], recoveries: 0 });
  const calm = analyseTurn('okay thanks');
  const upset = analyseTurn('I am annoyed, this is a waste');
  const turn = (s: JourneyState, a = calm, understood = true) => observeTurn(s, { node: 'n', analysis: a, understood }, DEFAULT_JOURNEY);

  it('does not escalate a calm, understood call', () => {
    const s = fresh();
    for (let i = 0; i < 6; i++) expect(turn(s).escalate).toBe(false);
  });
  it('escalates at once on severe sentiment', () => {
    expect(turn(fresh(), analyseTurn('I will sue you'))).toMatchObject({ escalate: true, trigger: 'severe_sentiment' });
  });
  it('escalates after about two failed recoveries in a row, not one', () => {
    const s = fresh();
    expect(turn(s, calm, false).escalate).toBe(false);                    // not understood: one
    expect(turn(s, calm, false)).toMatchObject({ escalate: true, trigger: 'failed_recoveries' });   // not understood again: two
  });
  it('counts an upset caller as a failed recovery too, and a good turn clears the count', () => {
    const s = fresh();
    expect(turn(s, upset).escalate).toBe(false);
    expect(turn(s).escalate).toBe(false);                                 // understood and fine: recovered
    expect(s.recoveries).toBe(0);
    expect(turn(s, upset).escalate).toBe(false);
    expect(turn(s, calm, false)).toMatchObject({ escalate: true, trigger: 'failed_recoveries' });
  });
  it('whichever comes first: severe on the first turn beats the count', () => {
    const s = fresh();
    expect(turn(s, calm, false).escalate).toBe(false);
    expect(turn(s, analyseTurn('my lawyer will hear of this'))).toMatchObject({ trigger: 'severe_sentiment' });
  });
  it('notices when the caller\'s intent changes', () => {
    const s = fresh();
    turn(s, analyseTurn('How much do I owe?'));
    expect(intentChanged(s)).toBe(false);
    turn(s, analyseTurn('How much is the balance?'));
    expect(intentChanged(s)).toBe(false);
    turn(s, analyseTurn('This is unacceptable, I want to complain'));
    expect(intentChanged(s)).toBe(true);
  });
});

describe('ordinary answers are not trouble', () => {
  it('reads a plain "no" or "no, thank you" as neutral or kind, and two declined questions do not hand the call to a person', () => {
    expect(analyseTurn('No').sentiment).toBe(0);
    expect(analyseTurn('No, thank you').sentiment).toBeGreaterThanOrEqual(0);
    expect(analyseTurn('I paid it already, please check again').sentiment).toBe(0);
    const state: JourneyState = { turns: [], recoveries: 0 };
    const t = (text: string) => observeTurn(state, { node: 'ask', analysis: analyseTurn(text), understood: true }, DEFAULT_JOURNEY);
    expect(t('No')).toEqual({ escalate: false });
    expect(t('No, thank you')).toEqual({ escalate: false });
  });
  it('lets a client name a topic like an inherited property without breaking the reading', () => {
    const lex = mergeLexicon({ topics: { toString: ['cheque'], constructor: ['cheque'] } });
    expect(analyseTurn('I sent a cheque', lex).topic).toBe('toString');
  });
});
