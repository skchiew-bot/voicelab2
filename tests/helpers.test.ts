import { describe, expect, it } from 'vitest';
import { dropDatabase } from './helpers.js';

describe('test teardown', () => {
  // A stand-in server: every connection is closed, and DROP behaves as `drop` says.
  const server = (drop: () => void) => ({ async query(sql: string) { if (sql.startsWith('DROP')) drop(); else return { rows: [{ n: 0 }] }; } });

  it('drops a test database even when the server\'s own worker is still in it, and stops on any other error', async () => {
    let calls = 0;
    const busy = server(() => { if (++calls < 3) throw new Error('permission denied to terminate process'); });
    expect(await dropDatabase(busy, 'x', 1)).toBe(3);
    const broken = server(() => { throw new Error('database "x" does not exist'); });
    await expect(dropDatabase(broken, 'x', 1)).rejects.toThrow('does not exist');
    const stuck = server(() => { throw new Error('permission denied to terminate process'); });
    await expect(dropDatabase(stuck, 'x', 1, 3)).rejects.toThrow('permission denied');
  });

  it('waits for the database\'s own connections to finish closing before force-dropping it, so none is killed mid-close', async () => {
    const seen: string[] = [];
    const open = [2, 1, 0]; // connections still closing at each look
    const closing = { async query(sql: string) { seen.push(sql.startsWith('DROP') ? 'drop' : 'look'); if (!sql.startsWith('DROP')) return { rows: [{ n: open.shift() ?? 0 }] }; } };
    expect(await dropDatabase(closing, 'voicelab_test_abc', 1)).toBe(1);
    expect(seen).toEqual(['look', 'look', 'look', 'drop']);
    await expect(dropDatabase(closing, 'x; DROP DATABASE postgres', 1)).rejects.toThrow('Not a test database name');
  });
});
