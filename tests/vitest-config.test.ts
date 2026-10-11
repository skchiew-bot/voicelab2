import { describe, expect, it } from 'vitest';
import config from '../vitest.config.js';

describe('the test run', () => {
  it('leaves out the copies of the repository that helper agents work in, so their tests never run as tests of this checkout', () => {
    expect(config.test?.exclude).toContain('.claude/**');
    expect(config.test?.exclude).toContain('**/node_modules/**');
  });
});
