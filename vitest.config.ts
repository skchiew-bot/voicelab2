import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Creates the cluster-wide database roles once, before test files migrate in parallel (lesson L-001).
    globalSetup: ['tests/global-setup.ts'],
  },
});
