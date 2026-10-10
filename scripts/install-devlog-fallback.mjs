#!/usr/bin/env node
// Installs the dev Control Tower's fallback hook (.claude/hooks/devlog-fallback.mjs), so a session
// Claude Code opens outside this repository is still logged (lesson L-020). The cloud
// environment's setup script runs it before Claude Code starts:
//
//   node /home/user/voicelab2/scripts/install-devlog-fallback.mjs || true
//
// It copies the fallback beside the user settings (~/.claude/hooks/), so it runs whichever branch
// is checked out, and registers it in the user settings on every event the repository's own
// settings run the devlog hook on, with the same time limits. Everything else in the settings
// file is kept. Run again, it changes nothing; run on a newer branch, it brings both up to date.
// A settings file it cannot read is reported and left alone, never overwritten.
//
//   node scripts/install-devlog-fallback.mjs [--settings <file>]
//   node scripts/install-devlog-fallback.mjs --check [--settings <file>]
//     prints installed, missing, outdated or unreadable, and changes nothing
//   (default settings file: $CLAUDE_CONFIG_DIR/settings.json, else ~/.claude/settings.json)
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runsDevlog } from '../.claude/hooks/devlog-fallback.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export class InstallError extends Error {}

/** One POSIX shell word, whatever the path holds (lesson L-018). */
export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Where the fallback is copied: a hooks folder beside the user settings. */
export const fallbackCopy = (settingsFile) => path.join(path.dirname(settingsFile), 'hooks', 'devlog-fallback.mjs');

/** The command Claude Code runs: the copy, given the checkout to log to; nothing if the copy is gone. */
export const fallbackCommand = (copy, dir = repo) => `f=${shellQuote(copy)}; [ ! -f "$f" ] || node "$f" ${shellQuote(dir)}`;

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

/** The fallback handlers in a settings object, one line each, in a fixed order, to compare what is installed with what should be. */
const fallbacksOf = (settings) => Object.entries(isObject(settings?.hooks) ? settings.hooks : {})
  .flatMap(([event, entries]) => (Array.isArray(entries) ? entries : [])
    .flatMap((e) => (Array.isArray(e?.hooks) ? e.hooks : []).filter(isFallback).map((h) => JSON.stringify([event, e.matcher ?? null, h.type, h.command, h.timeout ?? 0]))))
  .sort().join('\n');

export function defaultSettingsFile(env = process.env) {
  return env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, 'settings.json') : path.join(homedir(), '.claude', 'settings.json');
}

/**
 * What the fallback needs in the user's settings and beside them, and how that compares with what
 * is there. A checkout it cannot install from throws; a settings file it cannot read is reported
 * as `unreadable`, never treated as empty.
 */
function plan({ settingsFile, dir }) {
  const projectFile = path.join(dir, '.claude', 'settings.json');
  let project;
  try { project = JSON.parse(readFileSync(projectFile, 'utf8')); } catch { throw new InstallError(`Cannot read ${projectFile}; nothing was installed.`); }
  const events = devlogEvents(project);
  if (Object.keys(events).length === 0) throw new InstallError(`${projectFile} runs the devlog hook on no event; nothing was installed.`);
  const source = readFileSync(path.join(dir, '.claude', 'hooks', 'devlog-fallback.mjs'), 'utf8');
  const copy = fallbackCopy(settingsFile);
  const target = existsSync(settingsFile) ? realpathSync(settingsFile) : settingsFile;
  let user = {};
  if (existsSync(target)) {
    const text = readFileSync(target, 'utf8');
    try { user = text.trim() === '' ? {} : JSON.parse(text); } catch { return { unreadable: `${settingsFile} is not valid JSON. It was left as it is: fix it, then run this again.` }; }
  }
  let next;
  try { next = withFallback(user, events, fallbackCommand(copy, dir)); } catch (err) {
    if (err instanceof InstallError) return { unreadable: `${settingsFile} was left as it is: ${err.message}.` };
    throw err;
  }
  let copied = null;
  try { copied = readFileSync(copy, 'utf8'); } catch { /* not copied yet */ }
  return {
    events: Object.keys(events), source, copy, target, next,
    registered: fallbacksOf(user) !== '', settingsCurrent: fallbacksOf(user) === fallbacksOf(next),
    copied: copied !== null, copyCurrent: copied === source,
  };
}

/** installed, missing, outdated or unreadable. Changes nothing. */
export function check({ settingsFile = defaultSettingsFile(), dir = repo } = {}) {
  const p = plan({ settingsFile, dir });
  if (p.unreadable) return 'unreadable';
  if (!p.registered || !p.copied) return 'missing';
  return p.settingsCurrent && p.copyCurrent ? 'installed' : 'outdated';
}

/** Write a file whole: a session starting meanwhile reads the old file or the new one, never half of one. */
function writeWhole(file, text, mode) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  renameSync(tmp, file);
}

/** Copy the fallback and register it. Returns whether anything changed and the events covered. */
export function install({ settingsFile = defaultSettingsFile(), dir = repo } = {}) {
  const p = plan({ settingsFile, dir });
  if (p.unreadable) throw new InstallError(p.unreadable);
  let changed = false;
  // The copy first: the command it is registered with does nothing while the copy is missing.
  if (!p.copyCurrent) { writeWhole(p.copy, p.source, 0o644); changed = true; }
  if (!p.settingsCurrent) {
    writeWhole(p.target, JSON.stringify(p.next, null, 2) + '\n', existsSync(p.target) ? statSync(p.target).mode & 0o777 : 0o600);
    changed = true;
  }
  return { changed, events: p.events };
}

function main(argv) {
  let settingsFile; let checkOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--check') checkOnly = true;
    else if (argv[i] === '--settings' && argv[i + 1] && !argv[i + 1].startsWith('--')) settingsFile = path.resolve(argv[++i]);
    else throw new InstallError(`Unknown argument ${argv[i]}. Usage: node scripts/install-devlog-fallback.mjs [--check] [--settings <file>]`);
  }
  settingsFile ??= defaultSettingsFile();
  if (checkOnly) { console.log(check({ settingsFile })); return; }
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
