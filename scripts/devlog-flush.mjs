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

const EVENTS = new Set(['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure',
  'Usage', 'Alert', 'SubagentStart', 'SubagentStop', 'Task', 'Incident']);
const KINDS = new Set(['test', 'typecheck', 'build', 'push', 'commit', 'integrate', 'install', 'other']);
const TASK_STATUSES = new Set(['planned', 'in_progress', 'testing', 'review', 'blocked', 'done', 'abandoned']);
const INCIDENT_TYPES = new Set(['agent_regression', 'test_failure', 'review_finding', 'process', 'scope', 'security', 'stop_loss', 'other']);

const id = (v) => (typeof v === 'string' && /^[\w-]{1,80}$/.test(v) ? v : undefined);
const taskId = (v) => (typeof v === 'string' && /^[A-Za-z][\w.-]{0,39}$/.test(v) ? v : undefined);
const decimal = (v) => (typeof v === 'string' && /^\d{1,12}\.\d{1,8}$/.test(v) ? v : undefined);
const nat = (v, max = Number.MAX_SAFE_INTEGER) => (Number.isInteger(v) && v >= 0 && v <= max ? v : undefined);
const text = (v, max) => (typeof v === 'string' ? scrub(v, max) : undefined);
const model = (k) => /^[\w.:-]{1,80}$/.test(k);

function tokensOf(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const out = {};
  for (const [k, t] of Object.entries(raw)) {
    if (!model(k) || !t || typeof t !== 'object') continue;
    out[k] = Object.fromEntries(Object.entries({
      messages: nat(t.messages), input: nat(t.input), output: nat(t.output), cacheRead: nat(t.cacheRead),
      cacheWrite5m: nat(t.cacheWrite5m), cacheWrite1h: nat(t.cacheWrite1h), costUSD: decimal(t.costUSD),
    }).filter(([, v]) => v !== undefined));
  }
  return out;
}

function checkpointOf(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const models = {};
  for (const [k, m] of Object.entries(raw.models ?? {})) {
    if (!model(k) || !m || typeof m !== 'object') continue;
    models[k] = Object.fromEntries(Object.entries({
      input: nat(m.input), output: nat(m.output), thinking: nat(m.thinking), cacheRead: nat(m.cacheRead),
      cacheWrite: nat(m.cacheWrite), costUSD: typeof m.costUSD === 'string' && /^\d{1,12}\.\d{1,8}$/.test(m.costUSD) ? m.costUSD : undefined,
    }).filter(([, v]) => v !== undefined));
  }
  return Object.fromEntries(Object.entries({
    costUSD: decimal(raw.costUSD), models, durationMs: nat(raw.durationMs), apiMs: nat(raw.apiMs),
    linesAdded: nat(raw.linesAdded), linesRemoved: nat(raw.linesRemoved),
  }).filter(([, v]) => v !== undefined));
}

/** Rebuild a logged line from known fields only. Returns null for anything unrecognised. */
export function clean(raw) {
  if (!raw || typeof raw !== 'object' || !EVENTS.has(raw.event) || typeof raw.ts !== 'string') return null;
  const ts = new Date(raw.ts);
  if (Number.isNaN(ts.getTime())) return null;
  const out = { ts: ts.toISOString(), session: id(raw.session) ?? 'unknown', event: raw.event };
  if (id(raw.local_session)) out.local_session = raw.local_session;
  const set = (k, v) => { if (v !== undefined) out[k] = v; };

  if (raw.event === 'SessionStart') {
    set('source', id(raw.source));
    // This project's own branch names look like tokens to the scrubber, so keep those as they are;
    // any other branch name is scrubbed (it could hold a number or a token).
    if (typeof raw.branch === 'string') out.branch = /^(main|claude\/[a-z0-9.-]{1,80})$/.test(raw.branch) && !/\d{7,}/.test(raw.branch) ? raw.branch : scrub(raw.branch, 100);
    if (/^[0-9a-f]{4,40}$/.test(raw.head ?? '')) out.head = raw.head;
    set('behind_main', nat(raw.behind_main));
    // Lesson L-020: opened outside the repository, and whether the fallback hook was in place.
    if (raw.via === 'fallback') out.via = 'fallback';
    if (['installed', 'missing', 'outdated', 'unreadable'].includes(raw.fallback)) out.fallback = raw.fallback;
  }
  if (raw.event === 'PostToolUse' || raw.event === 'PostToolUseFailure') {
    out.tool = scrub(raw.tool, 80);
    out.target = raw.target === '(outside project)' ? raw.target : scrub(raw.target, 160);
    out.ok = raw.event === 'PostToolUse';
    if (KINDS.has(raw.kind)) out.kind = raw.kind;
    if (raw.expectRed === true) out.expectRed = true;
    set('ms', nat(raw.ms, 86_400_000));
    if (!out.ok) {
      // Older lines kept error text; keep only its category.
      const known = /^(exit \d+|interrupted|denied|not found|timeout|invalid input|rate limited|other)$/;
      out.failure = known.test(raw.failure ?? '') ? raw.failure
        : raw.exit !== undefined ? `exit ${Number(raw.exit)}` : failureKind(raw.tool, raw.error, raw.interrupted);
    }
  }
  if (raw.event === 'SessionEnd') set('reason', id(raw.reason));
  if (raw.event === 'Usage') {
    set('at', raw.at === 'Stop' || raw.at === 'SessionEnd' ? raw.at : undefined);
    set('transcript', /^[0-9a-f]{12}$/.test(raw.transcript ?? '') ? raw.transcript : undefined);
    set('tokens', tokensOf(raw.tokens));
    set('costUSD', decimal(raw.costUSD));
    set('costBasis', raw.costBasis === 'checkpoint+since' || raw.costBasis === 'transcript-only' ? raw.costBasis : undefined);
    set('checkpoint', checkpointOf(raw.checkpoint));
    set('runs', nat(raw.runs, 10_000));
    if (typeof raw.checkpointAt === 'string' && !Number.isNaN(new Date(raw.checkpointAt).getTime())) out.checkpointAt = new Date(raw.checkpointAt).toISOString();
    if (Array.isArray(raw.unpriced)) out.unpriced = raw.unpriced.filter((m) => typeof m === 'string' && model(m)).slice(0, 10);
  }
  if (raw.event === 'Alert') {
    if (raw.kind !== 'stop-loss' && raw.kind !== 'waste') return null;
    out.kind = raw.kind;
    set('rule', id(raw.rule));
    // A key that is a timestamp stays readable; anything else is scrubbed.
    out.key = typeof raw.key === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(raw.key) ? raw.key : scrub(raw.key, 160);
  }
  if (raw.event === 'SubagentStart' || raw.event === 'SubagentStop') {
    set('agentType', text(raw.agentType, 60));
    set('agentId', id(raw.agentId));
  }
  if (raw.event === 'Task') {
    if (!taskId(raw.id) || !['start', 'update', 'done'].includes(raw.action)) return null;
    out.id = raw.id; out.action = raw.action;
    for (const [k, max] of [['title', 120], ['epic', 80], ['workstream', 80], ['phase', 60], ['owner', 60], ['blocker', 160], ['next', 160]]) set(k, text(raw[k], max));
    if (TASK_STATUSES.has(raw.status)) out.status = raw.status;
    set('progress', nat(raw.progress, 100));
    set('attempt', nat(raw.attempt, 99));
    if (typeof raw.tests === 'string' && /^\d{1,6}\/\d{1,6}$/.test(raw.tests)) out.tests = raw.tests;
    set('pr', nat(raw.pr));
    // A branch linked to a task: this project's branch names as they are, anything else scrubbed.
    if (typeof raw.branch === 'string') out.branch = /^(main|claude\/[a-z0-9.-]{1,80})$/.test(raw.branch) && !/\d{7,}/.test(raw.branch) ? raw.branch : scrub(raw.branch, 100);
  }
  if (raw.event === 'Incident') {
    if (typeof raw.id !== 'string' || !/^INC-\d{8}-[0-9a-f]{4}$/.test(raw.id)) return null;
    out.id = raw.id;
    out.type = INCIDENT_TYPES.has(raw.type) ? raw.type : 'other';
    out.severity = ['high', 'medium', 'low'].includes(raw.severity) ? raw.severity : 'medium';
    for (const [k, max] of [['title', 160], ['impact', 160], ['detectedBy', 80], ['action', 160]]) set(k, text(raw[k], max));
    if (typeof raw.lesson === 'string' && /^L-\d{3}$/.test(raw.lesson)) out.lesson = raw.lesson;
    if (typeof raw.policyUpdated === 'boolean') out.policyUpdated = raw.policyUpdated;
    set('task', taskId(raw.task));
  }
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
