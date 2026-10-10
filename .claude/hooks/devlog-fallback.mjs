#!/usr/bin/env node
// Dev Control Tower fallback (lesson L-020). The repository's hooks load only when Claude Code's
// project folder is the repository, so a session opened anywhere else (after a restart Claude Code
// once reopened one in /home/user) was not logged at all. This hook is registered in the user's
// settings (~/.claude/settings.json) by scripts/install-devlog-fallback.mjs, which the cloud
// environment's setup script runs, so it runs in every session whatever its folder.
//
// It defers to the project hook: when the session's project folder already runs the devlog hook,
// it does nothing, so nothing is logged twice. Otherwise it hands the event to this repository's
// devlog hook as if the session had been opened here. Like that hook it never blocks the session:
// it exits 0, or 2 to pass on a stop-loss.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Whether a hook command runs a project's devlog hook (and not this fallback). */
export const runsDevlog = (command) => /\.claude\/hooks\/devlog\.mjs(?![\w.-])/.test(String(command ?? ''));

/**
 * Whether Claude Code is already logging a session with this project folder: the folder's project
 * settings register the devlog hook, and the hook is there to run. Any event counts: an event the
 * project chose not to log is not the fallback's to log either.
 */
export function projectLogs(projectDir) {
  if (!projectDir || !existsSync(path.join(projectDir, '.claude', 'hooks', 'devlog.mjs'))) return false;
  for (const name of ['settings.json', 'settings.local.json']) {
    let settings;
    try { settings = JSON.parse(readFileSync(path.join(projectDir, '.claude', name), 'utf8')); } catch { continue; }
    const events = settings?.hooks && typeof settings.hooks === 'object' ? Object.values(settings.hooks) : [];
    for (const entries of events) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        for (const h of Array.isArray(entry?.hooks) ? entry.hooks : []) if (runsDevlog(h?.command)) return true;
      }
    }
  }
  return false;
}

function main() {
  let input;
  try { input = readFileSync(0, 'utf8'); } catch { return 0; }
  let ev;
  try { ev = JSON.parse(input || '{}'); } catch { return 0; }
  // Claude Code sets CLAUDE_PROJECT_DIR for every hook; the event's cwd is only a stand-in.
  const projectDir = process.env.CLAUDE_PROJECT_DIR || (typeof ev?.cwd === 'string' ? ev.cwd : '');
  if (projectLogs(projectDir)) return 0;
  const hook = path.join(repo, '.claude', 'hooks', 'devlog.mjs');
  if (!existsSync(hook)) return 0;
  const r = spawnSync(process.execPath, [hook], {
    input, encoding: 'utf8', cwd: repo,
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, DEVLOG_VIA: 'fallback' },
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status === 2 ? 2 : 0;
}

// Run as a script (not when imported), comparing real paths as URLs as the devlog hook does.
const invoked = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? '')).href; } catch { return ''; } })();
if (invoked && invoked === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href) {
  let code = 0;
  try { code = main(); } catch { /* never block the session */ }
  process.exit(code === 2 ? 2 : 0);
}
