#!/usr/bin/env node
// Installs the dev Control Tower's fallback hook (.claude/hooks/devlog-fallback.mjs) in the user's
// Claude Code settings, so a session opened outside this repository is still logged (lesson L-020).
// The cloud environment's setup script runs it before Claude Code starts:
//
//   node /home/user/voicelab2/scripts/install-devlog-fallback.mjs || true
//
// It registers the fallback on every event the repository's own settings run the devlog hook on,
// with the same time limits, and keeps everything else in the settings file. Run again, it changes
// nothing. A settings file it cannot read is reported and left alone, never overwritten.
//
//   node scripts/install-devlog-fallback.mjs [--settings <file>]
//   (default: $CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json)
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runsDevlog } from '../.claude/hooks/devlog-fallback.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class InstallError extends Error {}

/** One POSIX shell word, whatever the path holds (lesson L-018). */
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * The command Claude Code runs: the checkout's fallback hook, or nothing at all when the branch
 * checked out there has none, so no session is shown a hook error.
 */
export const fallbackCommand = (dir = repo) =>
  `f=${shellQuote(path.join(dir, '.claude', 'hooks', 'devlog-fallback.mjs'))}; [ ! -f "$f" ] || node "$f"`;

const isFallback = (h) => typeof h?.command === 'string' && h.command.includes('devlog-fallback.mjs');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The events, with their time limits in seconds (0 for none), on which the project runs the devlog hook. */
export function devlogEvents(projectSettings) {
  const out = {};
  for (const [event, entries] of Object.entries(isObject(projectSettings?.hooks) ? projectSettings.hooks : {})) {
    for (const entry of Array.isArray(entries) ? entries : []) {
      for (const h of Array.isArray(entry?.hooks) ? entry.hooks : []) {
        if (runsDevlog(h?.command)) out[event] = Math.max(out[event] ?? 0, Number.isInteger(h.timeout) && h.timeout > 0 ? h.timeout : 0);
      }
    }
  }
  return out;
}

/**
 * The user settings with the fallback registered once on each event. A fallback from an earlier
 * install (perhaps of a checkout somewhere else) is replaced; everything else is kept as it was.
 */
export function withFallback(user, events, command) {
  if (!isObject(user)) throw new InstallError('the settings file does not hold a JSON object');
  if (user.hooks !== undefined && !isObject(user.hooks)) throw new InstallError('its "hooks" is not an object');
  const hooks = structuredClone(user.hooks ?? {});
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) throw new InstallError(`its hooks for ${event} are not a list`);
    const kept = [];
    for (const entry of entries) {
      const handlers = Array.isArray(entry?.hooks) ? entry.hooks : null;
      if (!handlers?.some(isFallback)) { kept.push(entry); continue; }
      const rest = handlers.filter((h) => !isFallback(h));
      if (rest.length) kept.push({ ...entry, hooks: rest });
    }
    if (kept.length === 0 && entries.length > 0) delete hooks[event]; else hooks[event] = kept;
  }
  for (const [event, timeout] of Object.entries(events)) {
    (hooks[event] ??= []).push({ hooks: [{ type: 'command', command, ...(timeout ? { timeout } : {}) }] });
  }
  return { ...user, hooks };
}

export function defaultSettingsFile(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, 'settings.json') : path.join(homedir(), '.claude', 'settings.json');
}

/** Register the fallback in `settingsFile`. Returns whether the file changed and the events covered. */
export function install({ settingsFile = defaultSettingsFile(), dir = repo } = {}) {
  const projectFile = path.join(dir, '.claude', 'settings.json');
  let project;
  try { project = JSON.parse(readFileSync(projectFile, 'utf8')); } catch { throw new InstallError(`Cannot read ${projectFile}; nothing was installed.`); }
  const events = devlogEvents(project);
  if (Object.keys(events).length === 0) throw new InstallError(`${projectFile} runs the devlog hook on no event; nothing was installed.`);
  if (!existsSync(path.join(dir, '.claude', 'hooks', 'devlog-fallback.mjs'))) throw new InstallError('This checkout has no .claude/hooks/devlog-fallback.mjs; nothing was installed.');

  const target = existsSync(settingsFile) ? realpathSync(settingsFile) : settingsFile;
  let user = {};
  if (existsSync(target)) {
    const text = readFileSync(target, 'utf8');
    try { user = text.trim() === '' ? {} : JSON.parse(text); } catch { throw new InstallError(`${settingsFile} is not valid JSON. It was left as it is: fix it, then run this again.`); }
  }
  let next;
  try { next = withFallback(user, events, fallbackCommand(dir)); } catch (err) {
    if (err instanceof InstallError) throw new InstallError(`${settingsFile} was left as it is: ${err.message}.`);
    throw err;
  }
  if (JSON.stringify(next) === JSON.stringify(user)) return { changed: false, events: Object.keys(events) };
  mkdirSync(path.dirname(target), { recursive: true });
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode });
  renameSync(tmp, target); // a session starting meanwhile reads the old file or the new one, never half of one
  return { changed: true, events: Object.keys(events) };
}

function main(argv) {
  let settingsFile;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--settings' && argv[i + 1] && !argv[i + 1].startsWith('--')) settingsFile = path.resolve(argv[++i]);
    else throw new InstallError(`Unknown argument ${argv[i]}. Usage: node scripts/install-devlog-fallback.mjs [--settings <file>]`);
  }
  settingsFile ??= defaultSettingsFile();
  const { changed, events } = install({ settingsFile });
  console.log(changed
    ? `Installed the dev Control Tower fallback hook in ${settingsFile} for ${events.length} events (${events.join(', ')}).`
    : `The dev Control Tower fallback hook is already installed in ${settingsFile}; nothing changed.`);
}

const invoked = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? '')).href; } catch { return ''; } })();
if (invoked && invoked === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href) {
  try { main(process.argv.slice(2)); } catch (err) {
    console.error(err instanceof InstallError ? err.message : `Could not install the fallback hook: ${err?.message ?? err}`);
    process.exit(1);
  }
}
