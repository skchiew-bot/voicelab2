import { describe, expect, it } from 'vitest';
import { chromiumOrSkip } from './browser.js';

describe('browser tests', () => {
  it('fails instead of skipping the browser tests in CI when Chromium is missing', () => {
    const missing = () => false;
    const present = () => true;
    // Outside CI a missing Chromium means skip; the path is the setting, or the default.
    expect(chromiumOrSkip({}, missing)).toEqual({ path: '/opt/pw-browsers/chromium', run: false });
    expect(chromiumOrSkip({ CHROMIUM_PATH: '/x/chrome' }, missing)).toEqual({ path: '/x/chrome', run: false });
    expect(chromiumOrSkip({ CHROMIUM_PATH: '/x/chrome' }, present)).toEqual({ path: '/x/chrome', run: true });
    // In CI a missing Chromium is an error naming where it looked, never a skip.
    expect(() => chromiumOrSkip({ CI: 'true', CHROMIUM_PATH: '/x/chrome' }, missing))
      .toThrow('Chromium not found at /x/chrome: in CI the browser tests must run, not skip');
    expect(() => chromiumOrSkip({ CI: 'true' }, missing)).toThrow(/in CI the browser tests must run/);
    // In CI with Chromium there, they run.
    expect(chromiumOrSkip({ CI: 'true', CHROMIUM_PATH: '/x/chrome' }, present)).toEqual({ path: '/x/chrome', run: true });
  });
});
