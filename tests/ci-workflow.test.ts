import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const ci = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');

describe('CI workflow', () => {
  it('runs the typecheck and the whole suite on every pull request to main, with database and browser, actions pinned', () => {
    // Triggers: a pull request to main and a push to main, nothing else.
    expect(ci).toMatch(/^on:\n {2}pull_request:\n {4}branches: \[main\]\n {2}push:\n {4}branches: \[main\]\n/m);
    expect(ci).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(ci).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");

    // Every action is pinned to a full commit, never a tag a maintainer can move.
    const uses = [...ci.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const u of uses) expect(u, u).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);

    // The checks themselves.
    expect(ci).toMatch(/run: npm run typecheck\n/);
    expect(ci).toMatch(/run: npm test\n/);

    // The database: the role the tests log in as, and a step that fails the job when it cannot (global-setup only warns).
    expect(ci).toContain('image: postgres:16');
    expect(ci).toContain("CREATE ROLE voicelab LOGIN CREATEDB CREATEROLE PASSWORD 'voicelab'");
    expect(ci).toMatch(/psql -X -h localhost -U voicelab -d postgres -tAc 'SELECT 1' \| grep -qx 1/);
    expect(ci).not.toContain('TEST_ADMIN_DATABASE_URL');

    // The browser: installed, checked, and handed to the browser tests, so they run instead of skipping.
    expect(ci).toContain('npx playwright install --with-deps chromium');
    expect(ci).toContain('test -x "$path"');
    expect(ci).toContain('echo "CHROMIUM_PATH=$path" >> "$GITHUB_ENV"');
  });
});
