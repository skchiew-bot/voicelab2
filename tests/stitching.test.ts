import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '../src/workflows/definition.js';
import { start, type Deps } from '../src/workflows/engine.js';
import { framesOf, normalizeSpoken, planSpeech, synthOnly, textHash, type RecordingIndex } from '../src/workflows/stitch.js';

const indexOf = (entries: [string, string][]): RecordingIndex => {
  const m = new Map(entries.map(([lang, text], i) => [textHash(lang, text), { id: `rec-${i + 1}`, durationMs: 1000 }]));
  return { find: (lang, text) => m.get(textHash(lang, text)) };
};

describe('planning a line: what is played and what is spoken live', () => {
  it('plays a fixed line from its recording at no synthesis', () => {
    const p = planSpeech('Good morning.', {}, [], 'en', indexOf([['en', 'Good morning.']]));
    expect(p).toMatchObject({ synthCharacters: 0, recordedCharacters: 13, seams: 0 });
    expect(p.segments).toEqual([{ kind: 'recorded', characters: 13, recordingId: 'rec-1', durationMs: 1000 }]);
  });
  it('speaks a fixed line live when nothing is recorded for exactly those words', () => {
    expect(planSpeech('Good morning.', {}, [], 'en', indexOf([['en', 'Good morning']]))).toMatchObject({ synthCharacters: 13, recordedCharacters: 0 });
    expect(planSpeech('Good morning.', {}, [], 'ms', indexOf([['en', 'Good morning.']]))).toMatchObject({ synthCharacters: 13 }); // another language's recording is not used
    expect(planSpeech('Good morning.', {}, [], 'en', undefined)).toMatchObject({ synthCharacters: 13 });
  });
  it('plays the frame of a hybrid line and speaks only the slot', () => {
    const idx = indexOf([['en', 'Hello'], ['en', ', this is Voice Lab calling about your account.']]);
    const p = planSpeech('Hello {{name}}, this is Voice Lab calling about your account.', { name: 'Aisha' }, [], 'en', idx);
    expect(p.segments.map((s) => s.kind)).toEqual(['recorded', 'synth', 'recorded']);
    expect(p).toMatchObject({ synthCharacters: 5, seams: 2 });
  });
  it('joins live parts into one request, so a missing frame piece is read together with its slot', () => {
    const idx = indexOf([['en', ', this is Voice Lab.']]);
    const p = planSpeech('Hello {{name}}, this is Voice Lab.', { name: 'Aisha' }, [], 'en', idx);
    expect(p.segments.map((s) => s.kind)).toEqual(['synth', 'recorded']);
    expect(p.segments[0]).toMatchObject({ characters: 'Hello Aisha'.length });
  });
  it('counts what a person would call a character, not what the encoding calls one', () => {
    expect(synthOnly('Selamat pagi 😊').synthCharacters).toBe(14);
    expect(normalizeSpoken('  a   b \n c ')).toBe('a b c');
  });
  it('treats extra spaces and line breaks in the words as the same words', () => {
    expect(planSpeech('Good  morning.\n', {}, [], 'en', indexOf([['en', 'Good morning.']]))).toMatchObject({ synthCharacters: 0 });
  });
  it('never speaks a sensitive value, whatever is recorded', () => {
    expect(() => planSpeech('Your IC is {{ic}}.', { ic: '9001' }, ['ic'], 'en', undefined)).toThrow(/sensitive/);
  });
});

describe('the engine reports it for every line', () => {
  const def: WorkflowDefinition = {
    start: 'a', variables: ['name'],
    nodes: {
      a: { type: 'speak', speech: 'hybrid', text: { en: 'Hello {{name}}, welcome.', ms: 'Helo {{name}}, selamat datang.' }, transitions: [{ to: 'b' }] },
      b: { type: 'speak', speech: 'dynamic', prompt: 'Say thanks', text: 'Thanks for waiting.', transitions: [{ to: 'c' }] },
      c: { type: 'speak', speech: 'fixed', text: 'Goodbye.', transitions: [{ to: 'e' }] },
      e: { type: 'end', outcome: 'ok' },
    },
  };
  const run = (recordings?: RecordingIndex, lang?: string) => start('w', { name: 'Aisha', ...(lang ? { lang } : {}) }, { load: () => def, recordings } as Deps);
  const says = (r: Awaited<ReturnType<typeof run>>) => r.records.filter((x) => x.type === 'say').map((x) => x.payload);

  it('without recordings every character is spoken live: this is the unstitched baseline', async () => {
    const s = says(await run());
    expect(s.map((x) => x.recordedChars)).toEqual([0, 0, 0]);
    expect(s.map((x) => x.synthChars)).toEqual(['Hello Aisha, welcome.'.length, 'Thanks for waiting.'.length, 'Goodbye.'.length]);
  });
  it('with recordings, a fixed line and a frame cost nothing to synthesise; a model-written line is always live', async () => {
    const s = says(await run(indexOf([['en', ', welcome.'], ['en', 'Goodbye.'], ['en', 'Thanks for waiting.']])));
    expect(s.map((x) => x.synthChars)).toEqual(['Hello Aisha'.length, 'Thanks for waiting.'.length, 0]);
    expect(s.map((x) => x.recordedChars)).toEqual([', welcome.'.length, 0, 'Goodbye.'.length]);
  });
  it('looks for the recording in the language the caller hears', async () => {
    const idx = indexOf([['ms', ', selamat datang.'], ['en', ', welcome.']]);
    expect(says(await run(idx, 'ms'))[0]).toMatchObject({ recordedChars: ', selamat datang.'.length, lang: 'ms' });
    expect(says(await run(idx))[0]).toMatchObject({ recordedChars: ', welcome.'.length });
  });
  it('lists the fixed words still worth recording, by language, never the slots', () => {
    const f = framesOf(def);
    expect(f.filter((x) => x.node === 'a').map((x) => `${x.language}:${x.text}`).sort()).toEqual(['en:, welcome.', 'en:Hello', 'ms:, selamat datang.', 'ms:Helo']);
    expect(f.some((x) => x.node === 'b')).toBe(false); // dynamic lines cannot be recorded
    expect(JSON.stringify(f)).not.toContain('name');
  });
});
