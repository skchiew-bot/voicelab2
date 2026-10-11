import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Creates the cluster-wide database roles once, before test files migrate in parallel (lesson L-001).
    globalSetup: ['tests/global-setup.ts'],
    // A helper agent's worktree (.claude/worktrees/…) holds a whole copy of the repository: its tests are not this
    // checkout's, and running them here would test other code and double the load (lesson L-045).
    exclude: [...configDefaults.exclude, '.claude/**'],
  },
});
