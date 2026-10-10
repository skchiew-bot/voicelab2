import { describe, expect, it } from 'vitest';
import { checkScript, clusterTurns, fixedChars, similarity, slotify, slotsIn } from '../src/learning/cluster.js';

describe('putting the values of known variables back as slots', () => {
  it('makes two callers\' lines the same line', () => {
    const a = slotify('Hello Aisha, you owe 350. Can you pay this week?', { name: 'Aisha', amount: 350 }, []);
    const b = slotify('Hello Bobby, you owe 120. Can you pay this week?', { name: 'Bobby', amount: 120 }, []);
    expect(a.text).toBe('Hello {{name}}, you owe {{amount}}. Can you pay this week?');
    expect(b.text).toBe(a.text);
    expect([...a.slots].sort()).toEqual(['amount', 'name']);
    expect(a.slotChars).toBe(8);
  });
  it('never turns a sensitive variable into a slot, and only replaces whole words', () => {
    const r = slotify('Hello Anna, the code is 4321 and Annabel agrees.', { name: 'Anna', pin: '4321' }, ['pin']);
    expect(r.text).toBe('Hello {{name}}, the code is 4321 and Annabel agrees.');
    expect(r.slots).toEqual(['name']);
  });
});

describe('values that happen to appear in a line', () => {
  it('does not turn a short coincidence into a slot', () => {
    const r = slotify('You have 14 days to settle, Aisha.', { amount: 14, name: 'Aisha' }, []);
    expect(r.text).toBe('You have 14 days to settle, {{name}}.');
  });
});

describe('grouping lines that say the same thing', () => {
  it('scores word overlap, with slots as words named for the slot', () => {
    expect(similarity('Can you pay this week?', 'Can you pay this week')).toBe(1);
    expect(similarity('Hello {{name}}', 'Hello {{other}}')).toBeLessThan(1);
    expect(similarity('Can you pay this week?', 'The weather is lovely today')).toBe(0);
  });
  it('groups alike wordings, counts how often each was said, and picks the one closest to the rest', () => {
    const clusters = clusterTurns([
      { text: 'Hello {{name}}, can you pay this week?', count: 6 },
      { text: 'Hello {{name}}, could you pay this week?', count: 3 },
      { text: 'Hello {{name}} can you pay this week', count: 2 },
      { text: 'We are sorry to hear that. Let us note your complaint.', count: 4 },
    ], 0.6);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]).toMatchObject({ canonical: 'Hello {{name}}, can you pay this week?', support: 11, variants: 3 });
    expect(clusters[1]).toMatchObject({ support: 4, variants: 1 });
  });
  it('keeps wordings apart when the threshold is high', () => {
    const c = clusterTurns([{ text: 'can you pay this week', count: 5 }, { text: 'could you pay this week', count: 5 }], 0.95);
    expect(c).toHaveLength(2);
  });
});

describe('checking a script before anyone is asked about it', () => {
  const o = { variables: ['name', 'amount'], sensitive: ['pin'] };
  it('accepts fixed words with known slots', () => {
    expect(checkScript('Hello {{name}}, you owe {{amount}}. Can you pay this week?', o)).toEqual({ ok: true, problems: [] });
  });
  it('refuses an unknown slot, a sensitive slot, a phone number, and a script that is nearly all slot', () => {
    expect(checkScript('Hello {{who}}, how are you today friend?', o).problems.join(' ')).toContain('{{who}} is not a variable');
    expect(checkScript('Your code is {{pin}}, please keep it safe.', { variables: ['pin'], sensitive: ['pin'] }).problems.join(' ')).toContain('sensitive');
    expect(checkScript('Call us on 012-345 6789 if you want to talk.', o).ok).toBe(false);
    expect(checkScript('{{name}} {{amount}}', o).problems.join(' ')).toContain('fixed words');
  });
  it('counts the fixed words and finds the slots', () => {
    expect(slotsIn('Hi {{name}}, {{name}} owes {{amount}}')).toEqual(['name', 'amount']);
    expect(fixedChars('Hello {{name}}, you owe {{amount}}. Can you pay this week?')).toBe(38);
  });
});
