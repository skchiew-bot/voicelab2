#!/usr/bin/env node
// Moves new activity lines from the hook's spool (devlog/.spool/, ignored by git) into a new file
// under devlog/activity/, ready to commit with the session's work. Run it just before a commit.
//
// Each run writes new files only (one per session), so two branches never edit the same file and
// a merge never conflicts over the log. Every line is rebuilt from an allowlist of fields and
// scrubbed again, so nothing the hook should not have kept reaches git.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { failureKind, scrub } from '../.claude/hooks/devlog.mjs';

const EVENTS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure']);

/** Rebuild a logged line from known fields only. Returns null for anything unrecognised. */
export function clean(raw) {
  if (!raw || typeof raw !== 'object' || !EVENTS.has(raw.event) || typeof raw.ts !== 'string') return null;
  const ts = new Date(raw.ts);
  if (Number.isNaN(ts.getTime())) return null;
  const id = (v) => (typeof v === 'string' && /^[\w-]{1,80}$/.test(v) ? v : undefined);
  const out = { ts: ts.toISOString(), session: id(raw.session) ?? 'unknown', event: raw.event };
  if (id(raw.local_session)) out.local_session = raw.local_session;
  if (raw.event === 'SessionStart') {
    if (id(raw.source)) out.source = raw.source;
    if (typeof raw.branch === 'string') out.branch = scrub(raw.branch, 100);
    if (/^[0-9a-f]{4,40}$/.test(raw.head ?? '')) out.head = raw.head;
    if (Number.isInteger(raw.behind_main)) out.behind_main = raw.behind_main;
  }
  if (raw.event === 'PostToolUse' || raw.event === 'PostToolUseFailure') {
    out.tool = scrub(raw.tool, 80);
    out.target = raw.target === '(outside project)' ? raw.target : scrub(raw.target, 160);
    out.ok = raw.event === 'PostToolUse';
    if (typeof raw.ms === 'number') out.ms = raw.ms;
    if (!out.ok) {
      // Older lines kept error text; keep only its category.
      const known = /^(exit \d+|interrupted|denied|not found|timeout|invalid input|rate limited|other)$/;
      out.failure = known.test(raw.failure ?? '') ? raw.failure
        : raw.exit !== undefined ? `exit ${Number(raw.exit)}` : failureKind(raw.tool, raw.error, raw.interrupted);
    }
  }
  if (raw.event === 'SessionEnd' && id(raw.reason)) out.reason = raw.reason;
  return out;
}

export function flush(root) {
  const spool = path.join(root, 'devlog', '.spool');
  const dest = path.join(root, 'devlog', 'activity');
  if (!existsSync(spool)) return [];
  const cursorFile = path.join(spool, '.cursor.json');
  let cursor = {};
  try { cursor = JSON.parse(readFileSync(cursorFile, 'utf8')); } catch { /* first run */ }

  const written = [];
  for (const f of readdirSync(spool).filter((n) => n.endsWith('.jsonl')).sort()) {
    const lines = readFileSync(path.join(spool, f), 'utf8').split('\n');
    const complete = lines.slice(0, -1); // the last element is '' or a line still being written
    const from = Number(cursor[f] ?? 0);
    const fresh = complete.slice(from).flatMap((l) => { try { const c = clean(JSON.parse(l)); return c ? [c] : []; } catch { return []; } });
    cursor[f] = complete.length;
    if (fresh.length === 0) continue;
    mkdirSync(dest, { recursive: true });
    const first = fresh[0];
    const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 18); // 20261010T001500123
    let name = `${first.ts.slice(0, 10)}-${first.session.slice(-12)}-${stamp}.jsonl`;
    for (let n = 2; existsSync(path.join(dest, name)); n++) name = name.replace(/(-\d+)?\.jsonl$/, `-${n}.jsonl`);
    writeFileSync(path.join(dest, name), fresh.map((l) => JSON.stringify(l)).join('\n') + '\n', { flag: 'wx' });
    written.push(path.join('devlog', 'activity', name));
  }
  writeFileSync(cursorFile, JSON.stringify(cursor));
  return written;
}

const invoked = (() => { try { return pathToFileURL(realpathSync(process.argv[1] ?? '')).href; } catch { return ''; } })();
if (invoked && invoked === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const written = flush(root);
  console.log(written.length ? `Flushed to:\n${written.join('\n')}` : 'Nothing new to flush.');
}
