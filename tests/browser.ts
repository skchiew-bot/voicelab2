import { existsSync } from 'node:fs';

/**
 * The Chromium the browser tests drive. Where none is installed they skip, except in CI (GitHub sets CI=true),
 * where a missing browser is an error: a check that quietly skips there lets CI pass without running (L-020).
 */
export function chromiumOrSkip(
  env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = existsSync,
): { path: string; run: boolean } {
  const chromiumPath = env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';
  const run = exists(chromiumPath);
  if (!run && env.CI) throw new Error(`Chromium not found at ${chromiumPath}: in CI the browser tests must run, not skip`);
  return { path: chromiumPath, run };
}
