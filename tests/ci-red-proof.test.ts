import { expect, test } from 'vitest';

// Deliberately failing: proves CI goes red when a test fails. This branch is thrown away.
test('fails on purpose to prove CI goes red', () => {
  expect(1 + 1).toBe(3);
});
