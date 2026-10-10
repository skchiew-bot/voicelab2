import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = { DATABASE_URL: 'postgres://x@db/voicelab', VOICELAB_SECRET_KEY: 'k' };

describe('settings', () => {
  it('starts with a setting left empty by the install file, as if it were not set', () => {
    // docker-compose.yml passes PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-}: empty on a fresh install with no public address yet.
    const c = loadConfig({ ...base, PUBLIC_BASE_URL: '', PORT: '', RECONCILE_TOLERANCE_PCT: '' });
    expect(c.PUBLIC_BASE_URL).toBeUndefined();
    expect(c.PORT).toBe(3000);
    expect(c.RECONCILE_TOLERANCE_PCT).toBe(2);
  });

  it('still refuses a required setting that is empty, and a malformed one', () => {
    expect(() => loadConfig({ ...base, VOICELAB_SECRET_KEY: '' })).toThrow(/VOICELAB_SECRET_KEY/);
    expect(() => loadConfig({ ...base, PUBLIC_BASE_URL: 'not a url' })).toThrow(/PUBLIC_BASE_URL/);
  });
});
