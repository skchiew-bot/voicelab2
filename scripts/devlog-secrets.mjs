// Real providers' key formats (lesson L-015). One definition, used by the guard test and by the dev Control Tower's
// secret-scan health check, so the two can never disagree (lesson L-033). The patterns are built from parts at run time,
// so this file never holds a string in a real key format itself.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const fake = (...parts) => parts.join('');

export function secretFormats() {
  return [
    new RegExp(fake('sk', '_(?:live|test)_', '[A-Za-z0-9]{10,}')),
    new RegExp(fake('xox', '[abprs]-', '[0-9]{6,}-')),
    new RegExp(fake('\\bA', 'C', '[0-9a-f]{32}\\b')),
    new RegExp(fake('gh', 'p_', '[A-Za-z0-9]{30,}')),
    new RegExp(fake('AK', 'IA', '[0-9A-Z]{16}')),
  ];
}

/** Every tracked or new (not ignored) file holding a real key format, as "file: pattern". Null when git cannot list the files. */
export function secretHits(dir) {
  let listed;
  try {
    listed = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return null; }
  const formats = secretFormats();
  const files = listed.split('\n').filter((f) => f && !f.startsWith('node_modules/') && existsSync(path.join(dir, f)) && !/\.(png|jpe?g|gif|wav|mp3|ico)$/i.test(f));
  return files.flatMap((f) => {
    let body;
    try { body = readFileSync(path.join(dir, f), 'utf8'); } catch { return []; }
    return formats.filter((re) => re.test(body)).map((re) => `${f}: ${re.source}`);
  });
}
