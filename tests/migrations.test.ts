import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The migrations on the trunk, as the trunk has them. Where there is no git or no origin/main (a bare copy), there is
// nothing to compare against and the check is skipped.
function onMain(): Map<string, string> | null {
  try {
    const names = execFileSync('git', ['ls-tree', '--name-only', 'origin/main', 'migrations/'], { encoding: 'utf8' }).split('\n').filter((n) => n.endsWith('.sql'));
    return new Map(names.map((n) => [n, execFileSync('git', ['show', `origin/main:${n}`], { encoding: 'utf8' })]));
  } catch { return null; }
}
const trunk = onMain();

describe('migrations', () => {
  it('never edits a migration already on main: a follow-up change goes in a new file', (ctx) => {
    if (trunk === null) return ctx.skip();
    for (const [name, text] of trunk) {
      let here: string | null = null;
      try { here = readFileSync(name, 'utf8'); } catch { /* removed */ }
      expect(here, `${name} was removed or changed after it reached main`).toBe(text);
    }
  });
});
