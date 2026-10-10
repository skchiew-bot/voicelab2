import { describe, expect, it } from 'vitest';
import { dropDatabase } from './helpers.js';

describe('test teardown', () => {
  it('drops a test database even when the server\'s own worker is still in it, and stops on any other error', async () => {
    let calls = 0;
    const busy = { async query() { if (++calls < 3) throw new Error('permission denied to terminate process'); } };
    expect(await dropDatabase(busy, 'x', 1)).toBe(3);
    const broken = { async query() { throw new Error('database "x" does not exist'); } };
    await expect(dropDatabase(broken, 'x', 1)).rejects.toThrow('does not exist');
    const stuck = { async query() { throw new Error('permission denied to terminate process'); } };
    await expect(dropDatabase(stuck, 'x', 1, 3)).rejects.toThrow('permission denied');
  });
});
